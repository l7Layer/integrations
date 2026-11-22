
import dataHandler from "./api/data.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const MAX_SETTINGS_BYTES = 16 * 1024;

async function readSettings(request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SETTINGS_BYTES) {
    return { error: "Settings request exceeds the 16 KB limit.", status: 413 };
  }
  if (!request.body) return { error: "A JSON settings object is required.", status: 400 };

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_SETTINGS_BYTES) {
      await reader.cancel();
      return { error: "Settings request exceeds the 16 KB limit.", status: 413 };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { error: "JSON settings must be an object.", status: 400 };
    }
    return { value };
  } catch {
    return { error: "Invalid JSON settings.", status: 400 };
  }
}

function withCors(response) {
  const headers = new Headers(response.headers);

  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    if (url.pathname === "/api/data" && request.method === "POST") {
      if (!env.CALENDAR_RATE_LIMITER) {
        return withCors(Response.json(
          { error: "Calendar service rate limiting is not configured." },
          { status: 503, headers: { "Cache-Control": "no-store" } }
        ));
      }
      const clientKey = request.headers.get("cf-connecting-ip") || "unknown";
      const rate = await env.CALENDAR_RATE_LIMITER.limit({ key: clientKey });
      if (!rate.success) {
        return withCors(Response.json(
          { error: "Too many calendar requests. Try again in a minute." },
          { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "60" } }
        ));
      }
      const parsed = await readSettings(request);
      if (parsed.error) {
        return withCors(Response.json(
          { error: parsed.error },
          { status: parsed.status, headers: { "Cache-Control": "no-store" } }
        ));
      }
      try {
        const data = await dataHandler({ query: parsed.value });
        return withCors(Response.json(data, { headers: { "Cache-Control": "no-store" } }));
      } catch (error) {
        return withCors(Response.json(
          { error: error.message || "Calendar request failed" },
          { status: 502, headers: { "Cache-Control": "no-store" } }
        ));
      }
    }

    if (url.pathname === "/" || url.pathname === "/webcal") {
      return withCors(
        Response.redirect(new URL("/render.html", request.url), 302)
      );
    }

    const response = await env.ASSETS.fetch(request);
    return withCors(response);
  },
};
