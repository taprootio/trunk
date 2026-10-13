import assert from "node:assert/strict";
import test from "node:test";

import { createBootstrapHttpServer, createReferenceHttpServer } from "../src/http.js";

const manifest = Object.freeze({ slug: "taproot-reference", webhookEndpointUrl: "https://receiver.example.test/webhooks" });

async function withServer(server, action) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    return await action(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("active manifest remains public and handoff entry removes the JWT before confirmation", async () => {
  let prepared;
  let confirms = 0;
  const server = createReferenceHttpServer({
    manifest,
    database: { ping: async () => {} },
    webhook: {},
    processor: { wake: () => {} },
    settings: {
      prepare: async (token) => { prepared = token; return { state: "80000000-0000-4000-8000-000000000001" }; },
      confirm: async (state) => {
        confirms += 1;
        assert.equal(state, "80000000-0000-4000-8000-000000000001");
        return { token: "a".repeat(43), maxAgeSeconds: 60 };
      },
      read: async () => undefined,
    },
  });
  await withServer(server, async (origin) => {
    const publishedManifest = await fetch(`${origin}/manifest.json`);
    assert.deepEqual(await publishedManifest.json(), manifest);

    const token = "signed-token-that-must-not-survive-the-first-redirect";
    const entered = await fetch(`${origin}/settings?handoff=${encodeURIComponent(token)}`, { redirect: "manual" });
    assert.equal(entered.status, 303);
    assert.equal(prepared, token);
    assert.equal(confirms, 0, "remote confirmation waits for the token-free confirmation route");
    assert.equal(entered.headers.get("location"), "/settings/confirm?state=80000000-0000-4000-8000-000000000001");
    assert.doesNotMatch(entered.headers.get("location"), /signed-token/u);
    assert.equal(entered.headers.get("referrer-policy"), "no-referrer");
    assert.equal(entered.headers.get("cache-control"), "no-store");

    const confirmed = await fetch(`${origin}/settings/confirm`, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "state=80000000-0000-4000-8000-000000000001",
    });
    assert.equal(confirmed.status, 303);
    assert.equal(confirms, 1);
    assert.match(confirmed.headers.get("set-cookie"), /^__Host-taproot-reference-session=/u);

    const injected = await fetch(`${origin}/settings?error=${encodeURIComponent("<script>window.pwned=1</script>")}`);
    assert.doesNotMatch(await injected.text(), /window\.pwned/u);
  });
});

test("bootstrap serves the registration manifest while explicitly withholding active readiness", async () => {
  await withServer(createBootstrapHttpServer(manifest), async (origin) => {
    assert.deepEqual(await (await fetch(`${origin}/manifest.json`)).json(), manifest);
    assert.equal((await fetch(`${origin}/healthz`)).status, 200);
    assert.equal((await fetch(`${origin}/readyz`)).status, 503);
  });
});

test("a full durable admission cap returns retriable 503 before acknowledging a new webhook", async () => {
  const server = createReferenceHttpServer({
    manifest,
    database: { ping: async () => {} },
    processor: { wake: () => assert.fail("capacity rejection must not wake the worker") },
    settings: { prepare: async () => {}, confirm: async () => {}, read: async () => undefined },
    webhook: {
      verify: () => ({ event: { id: "40000000-0000-4000-8000-000000000001" } }),
      accept: async () => {
        const error = new Error("webhook_capacity_exhausted");
        error.code = "webhook_capacity_exhausted";
        throw error;
      },
    },
  });
  await withServer(server, async (origin) => {
    const response = await fetch(`${origin}/webhooks`, { method: "POST", body: "{}" });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "60");
    assert.deepEqual(await response.json(), { code: "webhook_capacity_exhausted" });
  });
});

test("database failures return a safe retriable response without driver codes", async () => {
  const databaseError = new Error("connection refused for postgresql://user:secret@db.example.test/reference");
  databaseError.code = "ECONNREFUSED";
  const webhookError = new Error("PostgreSQL SQLSTATE 57P01");
  webhookError.code = "57P01";
  const server = createReferenceHttpServer({
    manifest,
    database: { ping: async () => { throw databaseError; } },
    processor: { wake: () => assert.fail("a failed durable write must not wake the worker") },
    settings: { prepare: async () => {}, confirm: async () => {}, read: async () => undefined },
    webhook: {
      verify: () => ({ event: { id: "40000000-0000-4000-8000-000000000001" } }),
      accept: async () => { throw webhookError; },
    },
  });
  await withServer(server, async (origin) => {
    const readiness = await fetch(`${origin}/readyz`);
    assert.equal(readiness.status, 503);
    assert.deepEqual(await readiness.json(), { code: "internal_error" });

    const webhook = await fetch(`${origin}/webhooks`, { method: "POST", body: "{}" });
    assert.equal(webhook.status, 503);
    assert.deepEqual(await webhook.json(), { code: "internal_error" });
  });
});
