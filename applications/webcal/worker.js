
import dataHandler from "./api/data.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

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
      try {
        const settings = await request.json();
        const data = await dataHandler({ query: settings });
        return withCors(Response.json(data));
      } catch (error) {
        return withCors(
          Response.json(
            { error: error.message || "Calendar request failed" },
            { status: 500 }
          )
        );
      }
    }

    if (url.pathname === "/" || url.pathname === "/webcal") {
      return withCors(
        Response.redirect(new URL("/render.html", request.url), 302)
      );
    }

    return withCors(await env.ASSETS.fetch(request));
  },
};
