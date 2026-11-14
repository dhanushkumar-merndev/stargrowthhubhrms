// node --test deploy/cloudflare-worker/test
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import relay from "../src/index.js";

const env = { APP_ORIGIN: "https://api.example.test", DEVICE_RELAY_SECRET: "s".repeat(40) };
const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

function capture(response = new Response("OK", { status: 200, headers: { "content-type": "text/plain" } })) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return typeof response === "function" ? response() : response;
  };
  return calls;
}

const req = (path, init = {}) =>
  new Request(`http://relay.test${path}`, { ...init, headers: { "cf-connecting-ip": "203.0.113.5", ...(init.headers ?? {}) } });

test("forwards iclock traffic with the relay secret and device IP", async () => {
  const calls = capture();
  const res = await relay.fetch(req("/iclock/cdata?SN=ABC&table=ATTLOG", { method: "POST", body: "7\t2026-11-11 10:00:00" }), env);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "OK");
  assert.equal(res.headers.get("content-length"), "2");
  assert.equal(calls[0].url, "https://api.example.test/iclock/cdata?SN=ABC&table=ATTLOG");
  assert.equal(calls[0].init.headers.get("x-relay-secret"), env.DEVICE_RELAY_SECRET);
  assert.equal(calls[0].init.headers.get("x-device-ip"), "203.0.113.5");
  assert.equal(calls[0].init.redirect, "manual");
});

test("never forwards client-supplied trust headers or cookies", async () => {
  const calls = capture();
  await relay.fetch(
    req("/api/iclock/getrequest?SN=ABC", { headers: { "x-relay-secret": "forged", "x-device-ip": "1.1.1.1", cookie: "a=b", "x-forwarded-for": "9.9.9.9" } }),
    env,
  );
  const h = calls[0].init.headers;
  assert.equal(h.get("x-relay-secret"), env.DEVICE_RELAY_SECRET);
  assert.equal(h.get("x-device-ip"), "203.0.113.5");
  assert.equal(h.get("cookie"), null);
  assert.equal(h.get("x-forwarded-for"), null);
});

test("only iclock paths and GET/POST are relayed", async () => {
  const calls = capture();
  for (const path of ["/", "/v1/auth/login", "/healthz", "/iclockx/cdata"]) {
    assert.equal((await relay.fetch(req(path), env)).status, 404, path);
  }
  assert.equal((await relay.fetch(req("/iclock/cdata?SN=A", { method: "PUT", body: "x" }), env)).status, 404);
  assert.equal(calls.length, 0);
});

test("refuses when unconfigured, oversize, or the API is unreachable", async () => {
  capture();
  assert.equal((await relay.fetch(req("/iclock/cdata"), {})).status, 503);
  const big = new Uint8Array(4 * 1024 * 1024 + 1);
  assert.equal((await relay.fetch(req("/iclock/cdata?SN=A", { method: "POST", body: big }), env)).status, 413);
  globalThis.fetch = async () => {
    throw new Error("down");
  };
  assert.equal((await relay.fetch(req("/iclock/cdata?SN=A"), env)).status, 503);
});

test("passes upstream status through without following redirects", async () => {
  capture(() => new Response("Not Found", { status: 404 }));
  const res = await relay.fetch(req("/iclock/cdata?SN=NOPE"), env);
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type"), /^text\/plain/i);
});
