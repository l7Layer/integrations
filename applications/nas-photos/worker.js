const API = "https://api.paperlesspaper.de/v1";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, authorization, x-photo-message-id" }
  });
}
function html(body) {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" } });
}
function equalSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function bearer(request) {
  const value = request.headers.get("authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}
async function readJsonLimited(request, maxBytes) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { error: "Request body exceeds the size limit.", status: 413 };
  }
  if (!request.body) return { error: "A JSON request body is required.", status: 400 };
  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return { error: "Request body exceeds the size limit.", status: 413 };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { error: "JSON request body must be an object.", status: 400 };
    }
    return { value };
  } catch { return { error: "Invalid JSON request body.", status: 400 }; }
}

async function readImageLimited(request, maxBytes) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { error: "Image must not exceed 20 MiB.", status: 413 };
  }
  if (!request.body) return { error: "Image body is empty.", status: 400 };
  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return { error: "Image must not exceed 20 MiB.", status: 413 };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (!bytes.length) return { error: "Image body is empty.", status: 400 };
  const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 &&
    bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d &&
    bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  const isWebp = bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";
  if (
    (type === "image/jpeg" && !isJpeg) ||
    (type === "image/png" && !isPng) ||
    (type === "image/webp" && !isWebp) ||
    !["image/jpeg", "image/png", "image/webp"].includes(type)
  ) return { error: "Image content does not match its JPEG, PNG or WebP content type.", status: 415 };
  return { bytes, type };
}

function base64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
async function queueRead(env) {
  return (await env.NAS_PHOTOS_KV.get("photoQueue", "json")) || [];
}
async function deliverNextPhoto(env) {
  const connection = await getConnection(env);
  if (!connection) throw new Error("NAS Photos is not connected to a Paper");
  const now = new Date();
  const berlinParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23"
  }).formatToParts(now);
  const part = key => berlinParts.find(item => item.type === key)?.value;
  const berlinDate = part("year") + "-" + part("month") + "-" + part("day");
  const berlinHour = Number(part("hour"));
  if (berlinHour !== 5) return { skipped: true, reason: "Outside delivery hour in Europe/Berlin" };
  const deliveredDate = await env.NAS_PHOTOS_KV.get("deliveredDate");
  if (deliveredDate === berlinDate) return { skipped: true, reason: "Already delivered today" };
  const queue = await queueRead(env);
  if (!queue.length) return { skipped: true, reason: "Photo cache is empty" };
  const item = queue[0];
  const object = await env.NAS_PHOTOS_R2.get(item.key);
  if (!object) {
    await env.NAS_PHOTOS_KV.put("photoQueue", JSON.stringify(queue.slice(1)));
    throw new Error("Cached photo object was missing; removed stale queue entry");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  const response = await fetch(API + "/integration-papers/connections/" + encodeURIComponent(connection.connectionId) + "/content", {
    method: "POST",
    headers: { "authorization": "Bearer " + connection.token, "content-type": "application/json" },
    body: JSON.stringify({ messageId: "nas-photos-" + item.id, imageBase64: base64(bytes) })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || result.message || "Content push failed (" + response.status + ")");
  await env.NAS_PHOTOS_R2.delete(item.key);
  await env.NAS_PHOTOS_KV.put("photoQueue", JSON.stringify(queue.slice(1)));
  await env.NAS_PHOTOS_KV.put("deliveredDate", berlinDate);
  await env.NAS_PHOTOS_KV.put("lastDelivery", JSON.stringify({
    deliveredAt: new Date().toISOString(), filename: item.filename || null,
    requestId: result.requestId || null, paperId: connection.paperId
  }));
  return { delivered: true, filename: item.filename || null, requestId: result.requestId || null, remaining: queue.length - 1 };
}

async function getConnection(env) {
  const id = await env.NAS_PHOTOS_KV.get("activeConnectionId");
  if (!id) return null;
  const value = await env.NAS_PHOTOS_KV.get("connection:" + id, "json");
  return value || null;
}

async function getConnectionStatus(env, paperId) {
  const connection = await getConnection(env);
  if (!connection || connection.paperId !== paperId) {
    return { connected: false, reconnectRequired: false };
  }
  return {
    connected: true,
    reconnectRequired: false,
    name: connection.name || "NAS Photos",
    connectedAt: connection.connectedAt || null,
    deliveries: []
  };
}
async function exchangeGrant(grant, env) {
  const response = await fetch(API + "/integration-papers/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || "PaperlessPaper rejected the connection grant (" + response.status + ")");
  return data;
}

const CONFIG = {
  name: "NAS Photos",
  version: "0.1.0",
  description: "Displays the latest photo pushed from a private NAS.",
  renderPage: "./render.html",
  settingsPage: "./settings.html",
  requiredPermissions: ["paper:content:write", "paper:delivery:read"],
  capabilities: { contentPush: { callbackPath: "/api/paper-status" } },
  language: ["en", "de"]
};

export default {
  async scheduled(controller, env, ctx) {
    const berlin = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date());
    const hour = Number(berlin.find(part => part.type === "hour").value);
    const minute = Number(berlin.find(part => part.type === "minute").value);
    if (hour !== 5 || minute > 45) return;
    ctx.waitUntil(deliverNextPhoto(env).catch(async error => {
      await env.NAS_PHOTOS_KV.put("lastDeliveryError", JSON.stringify({
        at: new Date().toISOString(),
        message: error.message || String(error)
      }));
    }));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, authorization, x-photo-message-id", "access-control-max-age": "86400" } });

    if (request.method === "GET" && path === "/health") return json({ ok: true, service: "NAS Photos" });
    if (request.method === "GET" && path === "/config.json") return json(CONFIG);
    if (request.method === "GET" && path === "/render.html") return html(RENDER_HTML);
    if (request.method === "GET" && path === "/settings.html") return html(SETTINGS_HTML);

    if (request.method === "GET" && path === "/api/connection-status") {
      const paperId = url.searchParams.get("paperId");
      if (!paperId) return json({ error: "Missing paperId" }, 400);
      try { return json(await getConnectionStatus(env, paperId)); }
      catch (error) { return json({ error: error.message || "Status check failed" }, 502); }
    }

    if (request.method === "POST" && path === "/api/connect") {
      const parsed = await readJsonLimited(request, 8 * 1024);
      if (parsed.error) return json({ error: parsed.error }, parsed.status);
      const body = parsed.value;
      if (typeof body.grant !== "string" || body.grant.length < 1 || body.grant.length > 4096) return json({ error: "Invalid connection grant" }, 400);
      try {
        const existingConnection = await getConnection(env);
        if (!existingConnection) {
          return json({ error: "The existing NAS Photos owner connection is missing. Reconnect through the service owner before changing this connection." }, 503);
        }
        const connection = await exchangeGrant(body.grant, env);
        if (!connection.connectionId || !connection.paperId || !connection.token || !connection.callbackToken) {
          return json({ error: "PaperlessPaper returned an incomplete connection response" }, 502);
        }
        if (connection.paperId !== existingConnection.paperId) {
          return json({ error: "This NAS Photos service is reserved for its existing Paper." }, 403);
        }
        const stored = {
          connectionId: connection.connectionId,
          paperId: connection.paperId,
          name: connection.name || "NAS Photos",
          token: connection.token,
          callbackToken: connection.callbackToken,
          connectedAt: new Date().toISOString()
        };
        await env.NAS_PHOTOS_KV.put("connection:" + stored.connectionId, JSON.stringify(stored));
        await env.NAS_PHOTOS_KV.put("activeConnectionId", stored.connectionId);
        return json({ connected: true, name: stored.name });
      } catch (error) {
        return json({ error: error.message || "Connection exchange failed" }, 502);
      }
    }

    if (request.method === "GET" && path === "/api/cache-status") {
      if (!equalSecret(bearer(request), env.UPLOAD_SECRET)) return json({ error: "Unauthorized" }, 401);
      const queue = await queueRead(env);
      const lastDelivery = await env.NAS_PHOTOS_KV.get("lastDelivery", "json");
      return json({ count: queue.length, capacity: 4, queued: queue.map(item => ({ filename: item.filename, queuedAt: item.queuedAt })), lastDelivery });
    }

    if (request.method === "POST" && path === "/api/cache-upload") {
      if (!equalSecret(bearer(request), env.UPLOAD_SECRET)) return json({ error: "Unauthorized" }, 401);
      const queue = await queueRead(env);
      if (queue.length >= 4) return json({ error: "Photo cache is full", count: queue.length }, 409);
      const image = await readImageLimited(request, 20 * 1024 * 1024);
      if (image.error) return json({ error: image.error }, image.status);
      const bytes = image.bytes;
      const type = image.type;
      const id = crypto.randomUUID();
      const filename = (request.headers.get("x-photo-filename") || "photo.jpg").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
      const extension = type === "image/png" ? ".png" : type === "image/webp" ? ".webp" : ".jpg";
      const key = "queue/" + id + extension;
      await env.NAS_PHOTOS_R2.put(key, bytes, { httpMetadata: { contentType: type } });
      const updated = [...queue, { id, key, filename, queuedAt: new Date().toISOString() }];
      await env.NAS_PHOTOS_KV.put("photoQueue", JSON.stringify(updated));
      return json({ queued: true, count: updated.length, capacity: 4, id, filename }, 201);
    }

    if (request.method === "POST" && path === "/api/paper-status") {
      const parsed = await readJsonLimited(request, 16 * 1024);
      if (parsed.error) return json({ error: parsed.error }, parsed.status);
      const event = parsed.value;
      if (
        typeof event.eventId !== "string" || event.eventId.length < 1 || event.eventId.length > 128 ||
        typeof event.connectionId !== "string" || event.connectionId.length > 128 ||
        typeof event.paperId !== "string" || event.paperId.length > 128
      ) return json({ error: "Invalid callback event" }, 400);
      const connection = await env.NAS_PHOTOS_KV.get("connection:" + event.connectionId, "json");
      if (!connection || connection.paperId !== event.paperId || !equalSecret(bearer(request), connection.callbackToken)) {
        return json({ error: "Unauthorized callback" }, 401);
      }
      const key = "event:" + event.eventId;
      if (!(await env.NAS_PHOTOS_KV.get(key))) {
        await env.NAS_PHOTOS_KV.put(key, JSON.stringify({
          eventId: event.eventId,
          connectionId: event.connectionId,
          paperId: event.paperId,
          requestId: typeof event.requestId === "string" ? event.requestId.slice(0, 128) : null,
          state: typeof event.state === "string" ? event.state.slice(0, 64) : "unknown",
          deviceId: typeof event.deviceId === "string" ? event.deviceId.slice(0, 128) : null,
          frameName: typeof event.frameName === "string" ? event.frameName.slice(0, 128) : null,
          error: typeof (event.error || event.message) === "string" ? (event.error || event.message).slice(0, 500) : null,
          occurredAt: typeof event.occurredAt === "string" ? event.occurredAt.slice(0, 64) : new Date().toISOString()
        }), { expirationTtl: 604800 });
      }
      return new Response(null, { status: 204 });
    }

    return new Response("Not found", { status: 404 });
  }
};

const RENDER_HTML = "<!doctype html>\n<html lang=\"en\">\n<head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"paperless:epd-optimize\" content='{\"intent\":\"natural\"}'><title>NAS Photos</title>\n<style>\n*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}\nmain{width:100vw;height:100vh;background:#111;display:grid;place-items:center;color:#fff}\nimg{width:100%;height:100%;object-fit:cover;object-position:center;display:block}\n#empty{font:600 clamp(1.2rem,3vw,2rem)/1.3 system-ui,sans-serif;text-align:center;padding:2rem;overflow-wrap:anywhere}\n</style></head>\n<body><div id=\"website-has-loading-element\"></div><main id=\"screen\"><div id=\"empty\">Waiting for the first photo from your Mac…</div></main>\n<script>\n(() => {\n const screen=document.getElementById(\"screen\"),empty=document.getElementById(\"empty\");\n let context=null,initialized=false;\n try{if(window.parent!==window&&window.name.startsWith(\"paperless-slot:\"))context=JSON.parse(window.name.slice(\"paperless-slot:\".length));}catch{}\n const embedded=!!(context&&typeof context.renderId===\"string\"&&typeof context.regionId===\"string\"&&typeof context.parentOrigin===\"string\");\n function finish(status=\"ready\",error){\n  document.getElementById(\"website-has-loading-element\")?.remove();\n  let marker=document.getElementById(\"website-has-loaded\");\n  if(!marker){marker=document.createElement(\"div\");marker.id=\"website-has-loaded\";marker.hidden=true;document.body.append(marker);}\n  document.documentElement.dataset.paperlessRenderStatus=status;\n  if(embedded)window.parent.postMessage({type:\"PAPERLESS_RENDER_STATUS\",renderId:context.renderId,regionId:context.regionId,parentOrigin:context.parentOrigin,status,error,processing:document.querySelector('meta[name=\"paperless:epd-optimize\"]')?.content},context.parentOrigin);\n }\n function payloadFromMessage(message){\n  if(message?.type===\"INIT\"&&message.data&&typeof message.data===\"object\")return message.data;\n  if(message?.type===\"INIT\"&&message.payload&&typeof message.payload===\"object\")return message.payload;\n  if(message?.cmd===\"message\"&&message.data&&typeof message.data===\"object\")return message.data;\n  return message;\n }\n function render(payload){\n  const content=payload?.integrationContent;\n  if(!content||!content.imageUrl){\n   const keys=content&&typeof content===\"object\"?Object.keys(content).join(\", \"):\"none\";\n   empty.textContent=\"OpenPaper initialized NAS Photos, but no image URL was included in integrationContent. Available content fields: \"+keys;\n   finish();return;\n  }\n  const image=new Image();image.alt=\"Photo from NAS\";\n  image.onload=()=>{screen.replaceChildren(image);finish();};\n  image.onerror=()=>{empty.textContent=\"The photo was included in the payload, but its temporary image URL could not be loaded.\";finish(\"error\",\"Image load failed\");};\n  image.src=content.imageUrl;\n }\n function accept(event){\n  if(event.source!==window.parent)return;\n  if(embedded&&(event.origin!==context.parentOrigin||event.data?.type!==\"INIT\"||event.data.renderId!==context.renderId||event.data.regionId!==context.regionId))return;\n  if(!embedded&&event.data?.type!==\"INIT\"&&event.data?.cmd!==\"message\")return;\n  initialized=true;render(payloadFromMessage(event.data));\n }\n window.addEventListener(\"message\",accept);\n if(embedded)window.parent.postMessage({type:\"PAPERLESS_RENDER_HELLO\",renderId:context.renderId,regionId:context.regionId,parentOrigin:context.parentOrigin},context.parentOrigin);\n setTimeout(()=>{if(!initialized){empty.textContent=\"No OpenPaper render initialization message was received.\";finish(\"error\",\"INIT message timeout\");}},10000);\n})();\n</script></body></html>";

const SETTINGS_HTML = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>NAS Photos connection</title>\n<style>\nbody{font:16px/1.45 system-ui,sans-serif;color:#202124;margin:0;padding:18px}\nh2{font-size:20px;margin:0 0 8px}\np{color:#60656f;margin:0 0 16px}\nbutton{border:0;border-radius:8px;background:#202124;color:white;padding:12px 18px;font:600 15px system-ui;cursor:pointer}\nbutton:disabled{opacity:.5;cursor:default}\n#status{margin-top:14px;white-space:pre-wrap}\n</style>\n</head>\n<body>\n<h2>NAS Photos</h2>\n<p>Connect this saved Paper to the NAS Photos publisher. Your Mac uploads photos to this Paper. Permanent connection credentials stay on the backend.</p>\n<button id=\"connect\" disabled>Waiting for PaperlessPaper…</button>\n<div id=\"status\" role=\"status\">Waiting for the host app to initialize this integration.</div>\n<script>\n(() => {\n const button=document.getElementById(\"connect\");\n const status=document.getElementById(\"status\");\n let hostOrigin=null,paperId=null,pendingId=null,initialized=false;\n function trusted(origin){\n  try{const u=new URL(origin);return (u.protocol===\"https:\"&&(u.hostname===\"paperlesspaper.de\"||u.hostname.endsWith(\".paperlesspaper.de\")))||(u.protocol===\"capacitor:\"&&u.hostname===\"localhost\");}\n  catch{return false;}\n }\n function height(){\n  if(hostOrigin)window.parent.postMessage({source:\"paperlesspaper-plugin\",type:\"SET_HEIGHT\",payload:{height:Math.min(document.documentElement.scrollHeight,700)}},hostOrigin);\n }\n async function refreshStatus(){\n  if(!paperId)return;\n  try{\n   const response=await fetch(\"/api/connection-status?paperId=\"+encodeURIComponent(paperId),{cache:\"no-store\"});\n   const data=await response.json();\n   if(!response.ok)throw new Error(data.error||\"Status check failed\");\n   if(data.connected){\n    button.disabled=true;button.textContent=\"Connected\";\n    const delivery=data.deliveries?.[0]?.state;\n    status.textContent=\"Connected to this Paper. \"+(delivery?\"Latest delivery status: \"+delivery+\". \":\"\")+\"Your Mac can publish photos.\";\n   }else{\n    button.disabled=false;button.textContent=\"Connect to PaperlessPaper\";\n    status.textContent=data.reconnectRequired?\"The saved connection has expired. Reconnect to PaperlessPaper.\":\"Paper identified. You can establish the secure connection.\";\n   }\n  }catch(error){\n   button.disabled=false;button.textContent=\"Check connection\";\n   status.textContent=\"Could not verify the saved connection: \"+(error.message||\"unknown error\");\n  }\n  height();\n }\n function init(payload,origin){\n  if(!trusted(origin)){status.textContent=\"Unrecognized host origin: \"+origin;return;}\n  hostOrigin=origin;initialized=true;\n  paperId=payload?.paper?.id||payload?.paperId||payload?.id||null;\n  if(paperId){button.disabled=true;button.textContent=\"Checking connection…\";status.textContent=\"Paper identified. Checking saved connection.\";refreshStatus();}\n  else{button.disabled=true;button.textContent=\"Save this Paper first\";status.textContent=\"OpenPaper initialized the integration but did not provide a saved Paper ID. Save the Paper, then reopen settings.\";}\n  height();\n }\n window.addEventListener(\"message\",event=>{\n  if(event.source!==window.parent)return;\n  const m=event.data;if(!m||typeof m!==\"object\")return;\n  if(m.source===\"paperlesspaper-app\"&&m.type===\"INIT\"){init(m.payload||m.data||{},event.origin);return;}\n  if(m.cmd===\"message\"&&m.data&&typeof m.data===\"object\"){init(m.data,event.origin);return;}\n  if(m.type===\"INIT\"&&m.data&&typeof m.data===\"object\"){init(m.data,event.origin);return;}\n  if(m.source===\"paperlesspaper-app\"&&m.type===\"CONNECTION_GRANT\"){\n   if(!initialized||event.origin!==hostOrigin||!pendingId||m.payload?.requestId!==pendingId)return;\n   pendingId=null;\n   if(!m.payload.grant){button.disabled=false;status.textContent=m.payload.error||\"Connection grant failed.\";return;}\n   button.disabled=true;status.textContent=\"Exchanging the one-time grant securely…\";\n   fetch(\"/api/connect\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({grant:m.payload.grant})})\n    .then(async response=>{const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||\"Connection failed, HTTP \"+response.status);button.textContent=\"Connected\";status.textContent=\"Connected to \"+(data.name||\"this Paper\")+\". You can now upload photos from your Mac.\";height();})\n    .catch(error=>{button.disabled=false;button.textContent=\"Retry connection\";status.textContent=error.message||\"Connection failed.\";height();});\n  }\n });\n button.addEventListener(\"click\",()=>{\n  if(!hostOrigin||!paperId||pendingId)return;\n  pendingId=crypto.randomUUID();button.disabled=true;status.textContent=\"Requesting a one-time connection grant…\";\n  window.parent.postMessage({source:\"paperlesspaper-plugin\",type:\"REQUEST_CONNECTION\",payload:{requestId:pendingId}},hostOrigin);\n });\n window.addEventListener(\"load\",height);\n setTimeout(()=>{if(!initialized)status.textContent=\"No compatible initialization message received. Close and reopen settings; if it persists, send this screen.\";},5000);\n})();\n</script>\n</body>\n</html>";
