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
  if (!request.body) {
    return { error: "A JSON settings object is required.", status: 400 };
  }

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
  headers.set("Cache-Control", "no-store");
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
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === "/api/data" && request.method === "POST") {
      const parsed = await readSettings(request);
      if (parsed.error) {
        return withCors(Response.json(
          { error: parsed.error },
          { status: parsed.status },
        ));
      }
      try {
        const data = await dataHandler({ query: parsed.value });
        return withCors(Response.json(data));
      } catch (error) {
        return withCors(
          Response.json(
            { error: error.message || "Timetable request failed" },
            { status: 400 },
          ),
        );
      }
    }

    if (url.pathname === "/") {
      return withCors(
        Response.redirect(new URL("/render.html", request.url), 302),
      );
    }

    return withCors(await env.ASSETS.fetch(request));
  },
};
