import assert from "node:assert/strict";
import test from "node:test";

import { LIMITS } from "../src/constants.js";
import { DocsApiClient } from "../src/transport.js";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function unreadableJsonResponse() {
  return new Response(
    new ReadableStream({
      pull(controller) {
        controller.error(new Error("response failed after headers"));
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

test("retries a lost idempotent response with byte-identical method, body, and authorization", async () => {
  const calls = [];
  const token = "tr_live_test-secret-that-must-not-be-logged";
  const client = new DocsApiClient({
    apiBaseUrl: "https://app.taproot.test/api",
    token,
    sleep: async () => {},
    fetch: async (url, init) => {
      calls.push({
        url: url.toString(),
        method: init.method,
        body: init.body,
        authorization: init.headers.authorization,
      });
      if (calls.length === 1) throw new Error(`lost ${token}`);
      return jsonResponse({ ok: true });
    },
  });
  assert.deepEqual(await client.request("v1/test", { method: "POST", body: { idempotencyKey: "same" } }), { ok: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].authorization, `Bearer ${token}`);
});

test("retries post-header mutation response failures with byte-identical requests", async (testContext) => {
  for (
    const [operation, path] of [
      ["create", "v1/sites/site/docs/releases"],
      ["stage", "v1/sites/site/docs/deployments:stage"],
      ["promote", "v1/sites/site/docs/deployments:promote"],
    ]
  ) {
    await testContext.test(operation, async () => {
      const calls = [];
      const client = new DocsApiClient({
        apiBaseUrl: "https://app.taproot.test/api",
        token: "tr_live_post_header_retry",
        sleep: async () => {},
        fetch: async (url, init) => {
          calls.push({
            url: url.toString(),
            method: init.method,
            body: init.body,
            authorization: init.headers.authorization,
          });
          return calls.length === 1 ? unreadableJsonResponse() : jsonResponse({ ok: true });
        },
      });
      assert.deepEqual(
        await client.request(path, { method: "POST", body: { idempotencyKey: "immutable" } }),
        { ok: true },
      );
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0], calls[1]);
    });
  }
});

test("retries invalid successful JSON but not cancellation or oversized bodies", async (testContext) => {
  await testContext.test("invalid JSON", async () => {
    let calls = 0;
    const client = new DocsApiClient({
      apiBaseUrl: "https://app.taproot.test/api",
      token: "tr_live_invalid_json_retry",
      sleep: async () => {},
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? new Response("{", { status: 200 })
          : jsonResponse({ ok: true });
      },
    });
    assert.deepEqual(await client.request("v1/test"), { ok: true });
    assert.equal(calls, 2);
  });

  await testContext.test("cancellation", async () => {
    let calls = 0;
    const controller = new AbortController();
    const client = new DocsApiClient({
      apiBaseUrl: "https://app.taproot.test/api",
      token: "tr_live_cancelled_response",
      signal: controller.signal,
      sleep: async () => {},
      fetch: async () => {
        calls += 1;
        controller.abort();
        return unreadableJsonResponse();
      },
    });
    await assert.rejects(client.request("v1/test"), (error) => error?.code === "publisher.cancelled");
    assert.equal(calls, 1);
  });
});

test("caps a hanging request and its retries to the remaining poll deadline", async () => {
  let clock = 99;
  let fetchCalls = 0;
  let sleeps = 0;
  const timeoutDurations = [];
  const client = new DocsApiClient({
    apiBaseUrl: "https://app.taproot.test/api",
    token: "tr_live_poll_deadline",
    now: () => clock,
    timeoutSignal: (milliseconds) => {
      timeoutDurations.push(milliseconds);
      const controller = new AbortController();
      queueMicrotask(() => {
        clock += milliseconds;
        controller.abort();
      });
      return controller.signal;
    },
    sleep: async () => {
      sleeps += 1;
    },
    fetch: async () => {
      fetchCalls += 1;
      return await new Promise(() => {});
    },
  });

  await assert.rejects(
    client.request("v1/test", { deadline: 100 }),
    (error) => error?.code === "transport.deadline",
  );
  assert.deepEqual(timeoutDurations, [1]);
  assert.equal(clock, 100);
  assert.equal(fetchCalls, 1);
  assert.equal(sleeps, 0);

  clock = 90;
  let retryableCalls = 0;
  const retryDelays = [];
  const retryable = new DocsApiClient({
    apiBaseUrl: "https://app.taproot.test/api",
    token: "tr_live_poll_backoff",
    now: () => clock,
    timeoutSignal: () => new AbortController().signal,
    sleep: async (milliseconds) => {
      retryDelays.push(milliseconds);
      clock += milliseconds;
    },
    fetch: async () => {
      retryableCalls += 1;
      return jsonResponse({ unavailable: true }, 503);
    },
  });
  await assert.rejects(
    retryable.request("v1/test", { deadline: 100 }),
    (error) => error?.code === "transport.deadline",
  );
  assert.equal(retryableCalls, 1);
  assert.deepEqual(retryDelays, [10]);

  const ordinaryTimeouts = [];
  const ordinary = new DocsApiClient({
    apiBaseUrl: "https://app.taproot.test/api",
    token: "tr_live_ordinary_timeout",
    timeoutSignal: (milliseconds) => {
      ordinaryTimeouts.push(milliseconds);
      return new AbortController().signal;
    },
    fetch: async () => jsonResponse({ ok: true }),
  });
  assert.deepEqual(await ordinary.request("v1/test"), { ok: true });
  assert.deepEqual(ordinaryTimeouts, [LIMITS.requestMilliseconds]);
});

test("rejects oversized API responses without incorporating response bytes in its error", async () => {
  const secret = "artifact-secret-content";
  let calls = 0;
  const client = new DocsApiClient({
    apiBaseUrl: "https://app.taproot.test/api",
    token: "tr_live_safe",
    fetch: async () => {
      calls += 1;
      return new Response(secret.repeat(100_000), { status: 200 });
    },
  });
  await assert.rejects(
    client.request("v1/test"),
    (error) => error?.code === "transport.response_too_large" && !error.message.includes(secret),
  );
  assert.equal(calls, 1);
});

test("uploads exact bytes with only signed headers and never forwards the bearer token", async () => {
  const calls = [];
  const bytes = Buffer.from("archive");
  const client = new DocsApiClient({
    apiBaseUrl: "https://app.taproot.test/api",
    token: "tr_live_bearer",
    fetch: async (url, init) => {
      calls.push({ url: url.toString(), init });
      return new Response(null, { status: 200 });
    },
  });
  await client.upload({
    method: "PUT",
    url: "https://objects.example/presigned?signature=secret",
    requiredHeaders: [
      { name: "content-type", value: "application/gzip" },
      { name: "content-length", value: String(bytes.byteLength) },
    ],
    contentLength: bytes.byteLength,
  }, bytes);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.get("authorization"), null);
  assert.equal(calls[0].init.headers.get("content-length"), String(bytes.byteLength));
  assert.equal(calls[0].init.body, bytes);
});

test("rejects a signed content length that disagrees with the immutable upload", async () => {
  const bytes = Buffer.from("archive");
  const client = new DocsApiClient({
    apiBaseUrl: "https://app.taproot.test/api",
    token: "tr_live_bearer",
    fetch: async () => {
      throw new Error("fetch must not be reached");
    },
  });
  await assert.rejects(
    client.upload({
      method: "PUT",
      url: "https://objects.example/presigned?signature=secret",
      requiredHeaders: [
        { name: "content-type", value: "application/gzip" },
        { name: "content-length", value: "6" },
      ],
      contentLength: bytes.byteLength,
    }, bytes),
    (error) => error?.code === "upload.content_length_invalid",
  );
});

test("allows plaintext upload capabilities only on explicit loopback origins", async () => {
  const client = new DocsApiClient({
    apiBaseUrl: "https://app.taproot.test/api",
    token: "tr_live_bearer",
    fetch: async () => {
      throw new Error("fetch must not be reached");
    },
  });
  await assert.rejects(
    client.upload({
      method: "PUT",
      url: "http://objects.example/presigned?signature=secret",
      requiredHeaders: [
        { name: "content-type", value: "application/gzip" },
        { name: "content-length", value: "7" },
      ],
      contentLength: 7,
    }, Buffer.from("archive")),
    (error) => error?.code === "upload.contract_invalid",
  );
});
