import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

import { TaprootIntegrationClient } from "../src/index.js";

const installationId = "10000000-0000-4000-8000-000000000001";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
  response.end(body);
}

async function testServer(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api`,
    close: async () => { server.close(); await once(server, "close"); },
  };
}

function installationClient(baseUrl, options = {}) {
  return new TaprootIntegrationClient({
    baseUrl,
    installationCredential: "installation-secret",
    maxAttempts: 2,
    timeoutMs: 100,
    ...options,
  });
}

test("a lost sync response retries the same idempotency operation without duplicating the server mutation", async (context) => {
  let requests = 0;
  let mutations = 0;
  const receivedKeys = [];
  const receivedBodies = [];
  const api = await testServer(async (request, response) => {
    requests++;
    receivedKeys.push(request.headers["idempotency-key"]);
    receivedBodies.push(JSON.parse(await bodyOf(request)));
    if (requests === 1) {
      mutations++;
      request.socket.destroy(); // The mutation committed, but its response was lost on the wire.
      return;
    }
    sendJson(response, 200, { syncId: "20000000-0000-4000-8000-000000000001", status: "open", baseRevision: 4, changed: false });
  });
  context.after(api.close);

  const result = await installationClient(api.baseUrl).createSync({
    installationId, mode: "full", requestedSyncId: "20000000-0000-4000-8000-000000000002", idempotencyKey: "persisted-operation-key",
  });

  assert.equal(result.status, "open");
  assert.equal(requests, 2);
  assert.equal(mutations, 1);
  assert.deepEqual(receivedKeys, ["persisted-operation-key", "persisted-operation-key"]);
  assert.equal(receivedBodies[0].idempotencyKey, receivedBodies[1].idempotencyKey);
});

test("authorization and validation responses are never retried", async (context) => {
  let requests = 0;
  const api = await testServer(async (request, response) => {
    await bodyOf(request);
    requests++;
    sendJson(response, requests === 1 ? 401 : 400, { message: "untrusted response text must not become an SDK error" });
  });
  context.after(api.close);
  const client = installationClient(api.baseUrl, { maxAttempts: 3 });
  const input = { installationId, mode: "full", idempotencyKey: "one" };

  await assert.rejects(() => client.createSync(input), { code: "http_401", status: 401 });
  await assert.rejects(() => client.createSync({ ...input, idempotencyKey: "two" }), { code: "http_400", status: 400 });
  assert.equal(requests, 2);
});

test("placement conflict codes are extracted only from the allowlisted field-violation pairs", async (context) => {
  let requests = 0;
  const api = await testServer(async (request, response) => {
    await bodyOf(request);
    requests++;
    sendJson(response, 400, {
      code: 3,
      message: "Bad request",
      details: [{
      "@type": "type.googleapis.com/google.rpc.BadRequest.FieldViolation",
        field: requests === 1 ? "ConfigurationRevision" : requests === 2 ? "ExpectedFragmentRevision" : "UnexpectedField",
        description: requests === 2 ? "fragment_revision_conflict" : "configuration_revision_conflict",
      }],
    });
  });
  context.after(api.close);
  const client = installationClient(api.baseUrl, { maxAttempts: 1 });
  const input = {
    installationId,
    placementId: "20000000-0000-4000-8000-000000000001",
    configurationRevision: 1,
    html: "<p>Reference placement</p>",
  };

  await assert.rejects(
    () => client.putFragment({ ...input, idempotencyKey: "known-placement-conflict" }),
    { code: "configuration_revision_conflict", status: 400 },
  );
  await assert.rejects(
    () => client.putFragment({ ...input, idempotencyKey: "known-fragment-conflict" }),
    { code: "fragment_revision_conflict", status: 400 },
  );
  await assert.rejects(
    () => client.putFragment({ ...input, idempotencyKey: "untrusted-error-detail" }),
    { code: "http_400", status: 400 },
  );
});

test("redirects are rejected before credentials reach a redirect target and errors do not expose them", async (context) => {
  let redirectTargetRequests = 0;
  const redirectTarget = await testServer((request, response) => {
    redirectTargetRequests++;
    sendJson(response, 200, { placements: [] });
  });
  context.after(redirectTarget.close);
  const api = await testServer((request, response) => {
    request.resume();
    response.writeHead(302, { location: `${redirectTarget.baseUrl}/stolen` });
    response.end();
  });
  context.after(api.close);

  await assert.rejects(
    () => installationClient(api.baseUrl, { maxAttempts: 1 }).listPlacements({ installationId }),
    (error) => {
      assert.equal(error.code, "redirect_rejected");
      assert.doesNotMatch(`${error.stack}\n${JSON.stringify(error)}`, /installation-secret/);
      return true;
    },
  );
  assert.equal(redirectTargetRequests, 0);
});

test("oversized and stalled API responses fail within the SDK bounds", async (context) => {
  let oversizedRequests = 0;
  const oversized = await testServer((request, response) => {
    request.resume();
    oversizedRequests++;
    response.writeHead(200, { "content-type": "application/json", "content-length": String(1_048_577) });
    response.end();
  });
  context.after(oversized.close);
  await assert.rejects(() => installationClient(oversized.baseUrl, { maxAttempts: 1 }).listPlacements({ installationId }), { code: "response_too_large" });
  assert.equal(oversizedRequests, 1);

  const stalled = await testServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.write("{");
    setTimeout(() => response.end("}"), 150);
  });
  context.after(stalled.close);
  await assert.rejects(() => installationClient(stalled.baseUrl, { maxAttempts: 1 }).listPlacements({ installationId }), { code: "request_timeout" });
});

test("the client bounds active requests and fails excess queued work instead of accumulating waiters", async (context) => {
  const firstRequest = deferred();
  const releaseFirstRequest = deferred();
  let requests = 0;
  const api = await testServer(async (request, response) => {
    request.resume();
    requests++;
    if (requests === 1) {
      firstRequest.resolve();
      await releaseFirstRequest.promise;
    }
    sendJson(response, 200, { placements: [] });
  });
  context.after(api.close);
  const client = installationClient(api.baseUrl, { maxConcurrentRequests: 1, maxQueuedRequests: 1 });
  const first = client.listPlacements({ installationId });
  await firstRequest.promise;
  const second = client.listPlacements({ installationId });
  await assert.rejects(() => client.listPlacements({ installationId }), { code: "concurrency_queue_full" });
  releaseFirstRequest.resolve();
  await Promise.all([first, second]);
  assert.equal(requests, 2);
});

test("the client rejects an oversized serialized request before opening a connection", async () => {
  let requests = 0;
  const api = await testServer((request, response) => {
    requests++;
    request.resume();
    sendJson(response, 200, { syncId: "20000000-0000-4000-8000-000000000001", status: "open", baseRevision: 4, changed: false });
  });
  try {
    await assert.rejects(() => installationClient(api.baseUrl).putDataDocument({
      installationId, key: "large", json: "x".repeat(1_048_576), idempotencyKey: "large-request",
    }), { code: "request_too_large" });
    assert.equal(requests, 0);
  } finally {
    await api.close();
  }
});

test("presigned uploads retain canonical object-store headers only when Content-Length matches the exact bytes", async (context) => {
  let uploads = 0;
  let headers;
  let body;
  const objectStore = await testServer(async (request, response) => {
    uploads++;
    headers = request.headers;
    body = await bodyOf(request);
    response.writeHead(200);
    response.end();
  });
  context.after(objectStore.close);
  const client = installationClient(objectStore.baseUrl);
  const pngBytes = Uint8Array.of(137, 80, 78, 71);
  const requiredHeaders = {
    "Content-Type": "image/png",
    "Content-Length": "4",
    "x-amz-meta-mime-type": "image/png",
    "x-amz-meta-height": "8",
    "x-amz-meta-width": "8",
    "x-amz-meta-original-filename": "eight.png",
  };

  await client.uploadPresigned({ url: `${objectStore.baseUrl}/reserved-upload`, requiredHeaders, body: pngBytes });
  assert.equal(uploads, 1);
  assert.equal(body, Buffer.from(pngBytes).toString("utf8"));
  assert.equal(headers["content-type"], "image/png");
  assert.equal(headers["content-length"], "4");
  assert.equal(headers["x-amz-meta-mime-type"], "image/png");
  assert.equal(headers.authorization, undefined);

  await assert.rejects(() => client.uploadPresigned({
    url: `${objectStore.baseUrl}/reserved-upload`, requiredHeaders: { ...requiredHeaders, "Content-Length": "5" }, body: pngBytes,
  }), { code: "invalid_upload_headers" });
  await assert.rejects(() => client.uploadPresigned({
    url: `${objectStore.baseUrl}/reserved-upload`, requiredHeaders: { ...requiredHeaders, "Content-Length": "04" }, body: pngBytes,
  }), { code: "invalid_upload_headers" });
  assert.equal(uploads, 1);
});
