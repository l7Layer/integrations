export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/webcal") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/render.html",
        },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
