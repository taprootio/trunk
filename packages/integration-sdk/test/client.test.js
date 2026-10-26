import assert from "node:assert/strict";
import test from "node:test";

import { TaprootIntegrationClient } from "../src/index.js";

test("retryable content mutations retain their operation idempotency identity", async () => {
  const calls = [];
  const client = new TaprootIntegrationClient({
    baseUrl: "https://app.example/api",
    installationCredential: "installation-secret",
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return new Response(JSON.stringify({ code: "temporarily_unavailable" }), { status: 503 });
      return new Response(JSON.stringify({ syncId: "20000000-0000-4000-8000-000000000001", status: "open", baseRevision: 4, changed: false }), { status: 200 });
    },
  });

  const result = await client.createSync({
    installationId: "10000000-0000-4000-8000-000000000001", mode: "full", idempotencyKey: "retain-this-operation-key",
  });
  assert.equal(result.status, "open");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.get("authorization"), "Bearer installation-secret");
  assert.equal(calls[0].options.headers.get("idempotency-key"), "retain-this-operation-key");
  assert.equal(JSON.parse(calls[0].options.body).idempotencyKey, "retain-this-operation-key");
  assert.equal(calls[1].options.headers.get("idempotency-key"), "retain-this-operation-key");
});

test("publisher-only claim refuses to substitute installation authority", async () => {
  const client = new TaprootIntegrationClient({ baseUrl: "https://app.example/api", installationCredential: "installation-secret" });
  await assert.rejects(() => client.claimInstallation({ installationId: "10000000-0000-4000-8000-000000000001", claimCode: "claim" }), { code: "missing_publisher_credential" });
});

test("integration media request keeps the caller's upload identity across retries", async () => {
  const bodies = [];
  const client = new TaprootIntegrationClient({
    baseUrl: "https://app.example/api",
    installationCredential: "installation-secret",
    fetch: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ uploadId: "20000000-0000-4000-8000-000000000001",
        presignedUrl: "https://app.example/api/v1/images/uploads/20000000-0000-4000-8000-000000000001/content",
        requiredHeaders: {} }), { status: 200 });
    },
  });
  const request = { installationId: "10000000-0000-4000-8000-000000000001",
    fileName: "image.jpg", contentType: "image/jpeg", fileSize: 1024,
    contentHash: "a".repeat(64), width: 100, height: 100,
    operationKey: "same-logical-upload" };
  await client.requestMediaUpload(request);
  await client.requestMediaUpload(request);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].operationKey, request.operationKey);
  assert.deepEqual(bodies[0], bodies[1]);
});

test("a successful claim with an unreadable secret response is never safe to replay", async () => {
  const installationId = "10000000-0000-4000-8000-000000000001";
  const oversized = new TaprootIntegrationClient({
    baseUrl: "https://app.example/api",
    publisherCredential: "publisher-secret",
    fetch: async () => new Response(null, { status: 200, headers: { "content-length": "1048577" } }),
  });
  await assert.rejects(
    () => oversized.claimInstallation({ installationId, claimCode: "claim" }),
    { code: "claim_response_unknown", status: 200 },
  );

  const invalidJson = new TaprootIntegrationClient({
    baseUrl: "https://app.example/api",
    publisherCredential: "publisher-secret",
    fetch: async () => new Response("{", { status: 200 }),
  });
  await assert.rejects(
    () => invalidJson.claimInstallation({ installationId, claimCode: "claim" }),
    { code: "claim_response_unknown", status: 200 },
  );
});
