import dataHandler from "./api/data.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/data" && request.method === "POST") {
      try {
        const settings = await request.json();
        const data = await dataHandler({ query: settings });

        return Response.json(data);
      } catch (error) {
        return Response.json(
          { error: error.message || "Calendar request failed" },
          { status: 500 }
        );
      }
    }

    if (url.pathname === "/" || url.pathname === "/webcal") {
      return Response.redirect(new URL("/render.html", request.url), 302);
    }

    return env.ASSETS.fetch(request);
  },
};
