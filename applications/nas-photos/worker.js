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
function base64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
async function getConnection(env) {
  const id = await env.NAS_PHOTOS_KV.get("activeConnectionId");
  if (!id) return null;
  const value = await env.NAS_PHOTOS_KV.get("connection:" + id, "json");
  return value || null;
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
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, authorization, x-photo-message-id", "access-control-max-age": "86400" } });

    if (request.method === "GET" && path === "/health") return json({ ok: true, service: "NAS Photos" });
    if (request.method === "GET" && path === "/config.json") return json(CONFIG);
    if (request.method === "GET" && path === "/render.html") return html(RENDER_HTML);
    if (request.method === "GET" && path === "/settings.html") return html(SETTINGS_HTML);

    if (request.method === "POST" && path === "/api/connect") {
      const body = await request.json().catch(() => null);
      if (!body || typeof body.grant !== "string" || body.grant.length > 4096) return json({ error: "Invalid connection grant" }, 400);
      try {
        const connection = await exchangeGrant(body.grant, env);
        if (!connection.connectionId || !connection.paperId || !connection.token || !connection.callbackToken) {
          return json({ error: "PaperlessPaper returned an incomplete connection response" }, 502);
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

    if (request.method === "POST" && path === "/api/upload") {
      if (!equalSecret(bearer(request), env.UPLOAD_SECRET)) return json({ error: "Unauthorized" }, 401);
      const connection = await getConnection(env);
      if (!connection) return json({ error: "NAS Photos is not connected to a Paper yet" }, 409);
      const type = request.headers.get("content-type") || "";
      if (!["image/jpeg", "image/png", "image/webp"].includes(type.split(";")[0].trim().toLowerCase())) {
        return json({ error: "Upload a JPEG, PNG or WebP image" }, 415);
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (!bytes.length || bytes.length > 20 * 1024 * 1024) return json({ error: "Image must be between 1 byte and 20 MiB" }, 413);
      const messageId = request.headers.get("x-photo-message-id") || crypto.randomUUID();
      if (messageId.length > 128) return json({ error: "Message ID is too long" }, 400);
      const response = await fetch(API + "/integration-papers/connections/" + encodeURIComponent(connection.connectionId) + "/content", {
        method: "POST",
        headers: {
          "authorization": "Bearer " + connection.token,
          "content-type": "application/json"
        },
        body: JSON.stringify({ messageId, imageBase64: base64(bytes) })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return json({ error: result.error || result.message || "Content push failed", upstreamStatus: response.status }, response.status);
      return json({ accepted: true, ...result }, 202);
    }

    if (request.method === "POST" && path === "/api/paper-status") {
      const event = await request.json().catch(() => null);
      if (!event || typeof event.eventId !== "string" || typeof event.connectionId !== "string" || typeof event.paperId !== "string") {
        return json({ error: "Invalid callback event" }, 400);
      }
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
          requestId: event.requestId || null,
          state: event.state || "unknown",
          occurredAt: event.occurredAt || new Date().toISOString()
        }), { expirationTtl: 604800 });
      }
      return new Response(null, { status: 204 });
    }

    return new Response("Not found", { status: 404 });
  }
};

const RENDER_HTML = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<meta name=\"paperless:epd-optimize\" content='{\"intent\":\"natural\"}'>\n<title>NAS Photos</title>\n<style>\nhtml,body{margin:0;width:100%;height:100%;overflow:hidden}\nmain{width:100vw;height:100vh;background:#111;display:grid;place-items:center;color:#fff}\nimg{width:100%;height:100%;object-fit:contain;object-position:center;display:block}\n#empty{font:600 clamp(1.2rem,3vw,2rem)/1.3 system-ui,sans-serif;text-align:center;padding:2rem}\n</style>\n</head>\n<body>\n<div id=\"website-has-loading-element\"></div>\n<main id=\"screen\"><div id=\"empty\">Waiting for the first photo from your Mac…</div></main>\n<script src=\"/assets/paperless.iife.js\"></script>\n<script>\n(async()=>{\n  const api=window.PaperlessOpenIntegration;\n  try{\n    const payload=await api.waitForPayload({timeoutMs:5000});\n    const content=payload?.integrationContent;\n    const screen=document.getElementById(\"screen\");\n    if(content?.imageUrl){\n      const image=new Image();\n      image.alt=\"Photo from NAS\";\n      image.src=content.imageUrl;\n      image.style.cssText=\"width:100%;height:100%;object-fit:contain;object-position:center;display:block\";\n      await image.decode();\n      screen.replaceChildren(image);\n    }else{\n      document.getElementById(\"empty\").textContent=\"No photo uploaded yet. Start the NAS Photos uploader on your Mac.\";\n    }\n    api.markReady?.({revision:content?.revision||null});\n  }catch(error){\n    api.markError?.(error);\n    document.getElementById(\"empty\").textContent=\"NAS Photos could not load: \"+(error?.message||\"Unknown error\");\n  }\n})();\n</script>\n</body>\n</html>";

const SETTINGS_HTML = "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>NAS Photos connection</title>\n<style>body{font:16px/1.45 system-ui,sans-serif;color:#202124;margin:0;padding:18px}h2{font-size:20px;margin:0 0 8px}p{color:#60656f;margin:0 0 16px}button{border:0;border-radius:8px;background:#202124;color:white;padding:12px 18px;font:600 15px system-ui;cursor:pointer}button:disabled{opacity:.5;cursor:wait}#status{margin-top:14px;white-space:pre-wrap}</style></head>\n<body><h2>NAS Photos</h2><p>Connect this saved Paper to the NAS Photos publisher. Your Mac uploads photos to this Paper. Permanent connection credentials stay on the backend.</p>\n<button id=\"connect\" disabled>Waiting for PaperlessPaper…</button><div id=\"status\" role=\"status\">Waiting for the host app to initialize this integration.</div>\n<script>\n(() => {\n const button=document.getElementById(\"connect\"),status=document.getElementById(\"status\");\n let hostOrigin=null,paperId=null,pendingId=null,initialized=false;\n function trusted(origin){try{const u=new URL(origin);return u.protocol===\"https:\"&&(u.hostname===\"paperlesspaper.de\"||u.hostname.endsWith(\".paperlesspaper.de\"));}catch{return false;}}\n function height(){if(hostOrigin)window.parent.postMessage({source:\"paperlesspaper-plugin\",type:\"SET_HEIGHT\",payload:{height:Math.min(document.documentElement.scrollHeight,700)}},hostOrigin);}\n function init(payload,origin){if(!trusted(origin)){status.textContent=\"Unrecognized host origin: \"+origin;return;}hostOrigin=origin;initialized=true;paperId=payload?.paper?.id||payload?.paperId||null;if(paperId){button.disabled=false;button.textContent=\"Connect to PaperlessPaper\";status.textContent=\"Paper identified. You can establish the secure connection.\";}else{button.disabled=true;button.textContent=\"Save this Paper first\";status.textContent=\"OpenPaper initialized the integration but did not provide a saved Paper ID. Save the Paper, then reopen settings.\";}height();}\n window.addEventListener(\"message\",async event=>{\n  if(event.source!==window.parent)return;\n  const m=event.data;if(!m||typeof m!==\"object\")return;\n  if(m.source===\"paperlesspaper-app\"&&m.type===\"INIT\"){init(m.payload||{},event.origin);return;}\n  if(m.cmd===\"message\"&&m.data&&typeof m.data===\"object\"){init(m.data,event.origin);return;}\n  if(m.type===\"INIT\"&&m.data&&typeof m.data===\"object\"){init(m.data,event.origin);return;}\n  if(m.source===\"paperlesspaper-app\"&&m.type===\"CONNECTION_GRANT\"){\n   if(!initialized||event.origin!==hostOrigin||!pendingId||m.payload?.requestId!==pendingId)return;\n   pendingId=null;\n   if(!m.payload.grant){button.disabled=false;status.textContent=m.payload.error||\"Connection grant failed.\";return;}\n   button.disabled=true;status.textContent=\"Exchanging the one-time grant securely…\";\n   try{const r=await fetch(\"/api/connect\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({grant:m.payload.grant})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||\"Connection failed, HTTP \"+r.status);button.textContent=\"Connected\";status.textContent=\"Connected to \"+(d.name||\"this Paper\")+\". You can now upload photos from your Mac.\";}\n   catch(e){button.disabled=false;button.textContent=\"Retry connection\";status.textContent=e.message||\"Connection failed.\";}height();\n  }\n });\n button.addEventListener(\"click\",()=>{if(!hostOrigin||!paperId||pendingId)return;pendingId=crypto.randomUUID();button.disabled=true;status.textContent=\"Requesting a one-time connection grant…\";window.parent.postMessage({source:\"paperlesspaper-plugin\",type:\"REQUEST_CONNECTION\",payload:{requestId:pendingId}},hostOrigin);});\n window.addEventListener(\"load\",height);\n setTimeout(()=>{if(!initialized)status.textContent=\"No compatible initialization message received. The host may be using an unsupported settings protocol or origin. Close and reopen settings; if it persists, send this screen.\";},5000);\n})();\n</script></body></html>";
