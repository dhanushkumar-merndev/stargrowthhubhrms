// Cloudflare Worker: lets an HTTP-only eSSL/ZKTeco machine reach the app on
// Render (which only serves HTTPS).
//
//   machine --HTTP--> hrms-device.<account>.workers.dev (this Worker) --HTTPS--> Rust API on Render
//
// * Only /iclock/* (and /api/iclock/*) is forwarded; everything else is 404.
// * Redirects are never followed, so the machine sees exactly what the app says.
// * The machine's real IP is passed in x-device-ip together with the shared
//   DEVICE_RELAY_SECRET; the app trusts x-device-ip only with that secret.
// * The response is sent with a Content-Length (no chunking): some firmware
//   cannot read chunked replies.
//
// * Keep-awake: Render's free plan stops the API after 15 minutes without a
//   request, and the next visitor (or the machine) then waits for it to start
//   again; on 2026-11-18 it stayed down from 20:04 to 14:25 IST. A cron
//   trigger (wrangler.toml) calls /healthz every 5 minutes so it never sleeps.
//
// Config: API_ORIGIN (wrangler.toml [vars]) and the DEVICE_RELAY_SECRET secret
// (`npx wrangler secret put DEVICE_RELAY_SECRET`, same value as on Render).

const FORWARD_HEADERS = ["content-type", "content-encoding", "user-agent", "accept"];
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const relay = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!/^\/(api\/)?iclock\//i.test(url.pathname)) {
      return text("Not Found", 404);
    }
    if (!env.API_ORIGIN || !env.DEVICE_RELAY_SECRET) {
      return text("Relay not configured", 503);
    }
    if (request.method !== "GET" && request.method !== "POST") {
      return text("Not Found", 404);
    }

    const headers = new Headers();
    for (const name of FORWARD_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("x-relay-secret", env.DEVICE_RELAY_SECRET);
    headers.set("x-device-ip", request.headers.get("cf-connecting-ip") ?? "");

    let body;
    if (request.method === "POST") {
      body = await request.arrayBuffer();
      if (body.byteLength > MAX_BODY_BYTES) return text("Payload Too Large", 413);
    }

    let upstream;
    try {
      upstream = await fetch(new URL(url.pathname + url.search, env.API_ORIGIN), {
        method: request.method,
        headers,
        body,
        redirect: "manual",
      });
    } catch {
      // The machine keeps its data and retries on a 5xx.
      return text("Service Unavailable", 503);
    }

    const bytes = await upstream.arrayBuffer();
    return new Response(bytes, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "text/plain; charset=utf-8",
        "content-length": String(bytes.byteLength),
        "cache-control": "no-store",
        // The machine sets its clock from Date; the API sends local time there.
        ...(upstream.headers.get("date") ? { date: upstream.headers.get("date") } : {}),
      },
    });
  },

  // Cron trigger: keep the API awake (see the header).
  async scheduled(_event, env, ctx) {
    if (!env.API_ORIGIN) return;
    ctx.waitUntil(
      fetch(new URL("/healthz", env.API_ORIGIN), { headers: { "user-agent": "hrms-relay-keepalive" } })
        .then((r) => r.arrayBuffer())
        .catch(() => undefined),
    );
  },
};

export default relay;

function text(body, status) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
