import assert from "node:assert/strict";
import test from "node:test";

import { PublisherError } from "../src/errors.js";
import { createGitHubMainHeadGuard } from "../src/github-main-head.js";

const GITHUB_TOKEN = "ghs_docs_publisher_test_token";
const DOCS_TOKEN = "tr_live_docs_publisher_test_key";
const REVISION = "0123456789abcdef0123456789abcdef01234567";
const CURRENT_MAIN_REVISION = "89abcdef0123456789abcdef0123456789abcdef";
const SOURCE = Object.freeze({
  provider: "github",
  repositoryId: "1234567",
  repository: "taprootio/wtfm",
  repositoryUrl: "https://github.com/taprootio/wtfm",
  revision: REVISION,
  ref: "refs/heads/main",
});

function environment(overrides = {}) {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_REPOSITORY_ID: SOURCE.repositoryId,
    GITHUB_REPOSITORY: SOURCE.repository,
    GITHUB_SHA: SOURCE.revision,
    GITHUB_TOKEN,
    TAPROOT_DOCS_PUBLISH_KEY: DOCS_TOKEN,
    ...overrides,
  };
}

function mainRefResponse(revision = REVISION) {
  return new Response(JSON.stringify({
    ref: "refs/heads/main",
    object: { type: "commit", sha: revision },
  }), { status: 200 });
}

function responseFromChunks(chunks) {
  return {
    status: 200,
    redirected: false,
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  };
}

async function capture(promise) {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}

function assertPublisherError(result, code, secrets = []) {
  assert.ok(result.error instanceof PublisherError);
  assert.equal(result.error.code, code);
  for (const secret of secrets) assert.equal(result.error.message.includes(secret), false);
}

test("rejects untrusted workflow context and provenance synchronously without a GitHub read", async (testContext) => {
  for (
    const [scenario, environmentOverrides, sourceOverrides, code] of [
      ["non-push event", { GITHUB_EVENT_NAME: "pull_request" }, {}, "github_main_head.context_invalid"],
      ["non-main ref", { GITHUB_REF: "refs/heads/release" }, {}, "github_main_head.context_invalid"],
      ["noncanonical server", { GITHUB_SERVER_URL: "https://github.example" }, {}, "github_main_head.context_invalid"],
      ["missing GitHub API origin", { GITHUB_API_URL: undefined }, {}, "github_main_head.context_invalid"],
      ["repository id mismatch", { GITHUB_REPOSITORY_ID: "7654321" }, {}, "github_main_head.provenance_invalid"],
      ["event revision mismatch", { GITHUB_SHA: CURRENT_MAIN_REVISION }, {}, "github_main_head.provenance_invalid"],
      ["unsafe source locator", {}, { repository: "taprootio/wtfm/extra" }, "github_main_head.provenance_invalid"],
      ["noncanonical source URL", {}, { repositoryUrl: "https://github.com/taprootio/wtfm/" }, "github_main_head.provenance_invalid"],
      ["uppercase source revision", {}, { revision: REVISION.toUpperCase() }, "github_main_head.provenance_invalid"],
    ]
  ) {
    await testContext.test(scenario, () => {
      let calls = 0;
      const result = (() => {
        try {
          createGitHubMainHeadGuard({
            environment: environment(environmentOverrides),
            source: { ...SOURCE, ...sourceOverrides },
            fetch: async () => {
              calls += 1;
              return mainRefResponse();
            },
          });
          return {};
        } catch (error) {
          return { error };
        }
      })();
      assertPublisherError(result, code);
      assert.equal(calls, 0);
    });
  }
});

test("rejects an absent, malformed, or oversized GitHub token without using the Docs key", async (testContext) => {
  for (const token of [undefined, "", "token\nwith-newline", "x".repeat(4_097)]) {
    await testContext.test("invalid workflow token", () => {
      let calls = 0;
      const result = (() => {
        try {
          createGitHubMainHeadGuard({
            environment: environment({ GITHUB_TOKEN: token }),
            source: SOURCE,
            fetch: async () => {
              calls += 1;
              return mainRefResponse();
            },
          });
          return {};
        } catch (error) {
          return { error };
        }
      })();
      assertPublisherError(result, "github_main_head.token_invalid");
      assert.equal(calls, 0);
    });
  }
});

test("defers the fixed GitHub read and sends only the GitHub workflow credential", async () => {
  const calls = [];
  const guard = createGitHubMainHeadGuard({
    environment: environment(),
    source: SOURCE,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return mainRefResponse();
    },
  });

  assert.equal(calls.length, 0);
  const result = await guard();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/repositories/1234567/git/ref/heads/main");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.credentials, "omit");
  assert.deepEqual([...calls[0].init.headers.keys()].sort(), [
    "accept",
    "authorization",
    "x-github-api-version",
  ]);
  assert.ok(calls[0].init.headers.get("authorization") === `Bearer ${GITHUB_TOKEN}`);
  assert.ok(calls[0].init.headers.get("authorization") !== `Bearer ${DOCS_TOKEN}`);
  assert.equal(calls[0].init.headers.get("accept"), "application/vnd.github+json");
  assert.equal(calls[0].init.headers.get("x-github-api-version"), "2022-11-28");
  assert.equal(result.currentRevision, REVISION);
  assert.equal(result.superseded, false);
  assert.equal(Object.isFrozen(result), true);
});

test("reports matching and advanced main heads without issuing Docs requests", async (testContext) => {
  for (const [scenario, revision, superseded] of [
    ["matching head", REVISION, false],
    ["advanced head", CURRENT_MAIN_REVISION, true],
  ]) {
    await testContext.test(scenario, async () => {
      const result = await createGitHubMainHeadGuard({
        environment: environment(),
        source: SOURCE,
        fetch: async () => mainRefResponse(revision),
      })();
      assert.equal(result.currentRevision, revision);
      assert.equal(result.superseded, superseded);
    });
  }
});

test("captures validated source provenance before returning the guard", async () => {
  const source = { ...SOURCE };
  const guard = createGitHubMainHeadGuard({
    environment: environment(),
    source,
    fetch: async () => mainRefResponse(),
  });
  source.revision = CURRENT_MAIN_REVISION;

  const result = await guard();
  assert.equal(result.currentRevision, REVISION);
  assert.equal(result.superseded, false);
});

test("rejects redirect, failed-status, oversized, and malformed GitHub responses without exposing response bytes", async (testContext) => {
  const responseSecret = "github-response-secret";
  const scenarios = [
    [
      "redirected response",
      async () => ({ ...responseFromChunks([Buffer.from("{}")]), redirected: true }),
      "github_main_head.redirect_rejected",
    ],
    [
      "failed status",
      async () => new Response(JSON.stringify({ message: responseSecret }), { status: 403 }),
      "github_main_head.response_status",
    ],
    [
      "oversized streamed body",
      async () => responseFromChunks([Buffer.from(responseSecret.repeat(1_000))]),
      "github_main_head.response_too_large",
    ],
    [
      "malformed JSON",
      async () => responseFromChunks([Buffer.from(`{\"message\":\"${responseSecret}\"`)]),
      "github_main_head.response_invalid",
    ],
    [
      "invalid reference payload",
      async () => responseFromChunks([Buffer.from(JSON.stringify({ ref: "refs/heads/other", object: {} }))]),
      "github_main_head.response_invalid",
    ],
  ];
  for (const [scenario, fetch, code] of scenarios) {
    await testContext.test(scenario, async () => {
      const result = await capture(createGitHubMainHeadGuard({ environment: environment(), source: SOURCE, fetch })());
      assertPublisherError(result, code, [GITHUB_TOKEN, DOCS_TOKEN, responseSecret]);
    });
  }
});

test("maps an elapsed GitHub timeout to a safe failure", async (testContext) => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
  const timeoutController = new AbortController();
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    value: () => timeoutController.signal,
  });
  testContext.after(() => Object.defineProperty(AbortSignal, "timeout", descriptor));

  let requestSignal;
  const guard = createGitHubMainHeadGuard({
    environment: environment(),
    source: SOURCE,
    fetch: async (_url, init) => await new Promise(() => {
      requestSignal = init.signal;
    }),
  });
  const check = guard();
  await Promise.resolve();
  timeoutController.abort();
  const result = await capture(check);
  assertPublisherError(result, "github_main_head.timeout", [GITHUB_TOKEN, DOCS_TOKEN]);
  assert.equal(requestSignal.aborted, true);
});

test("does not wait for a non-settling reader cleanup after rejecting an oversized body", async () => {
  let cancelCalls = 0;
  const guard = createGitHubMainHeadGuard({
    environment: environment(),
    source: SOURCE,
    fetch: async () => ({
      status: 200,
      redirected: false,
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: Buffer.alloc(16 * 1024 + 1) }),
          cancel: () => {
            cancelCalls += 1;
            return new Promise(() => {});
          },
        }),
      },
    }),
  });
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), 100);
  });
  const result = await Promise.race([capture(guard()), deadline]);
  clearTimeout(timer);

  assert.equal(result.timedOut, undefined);
  assertPublisherError(result, "github_main_head.response_too_large", [GITHUB_TOKEN, DOCS_TOKEN]);
  assert.equal(cancelCalls > 0, true);
});

test("propagates the caller cancellation signal without exposing credentials", async () => {
  const controller = new AbortController();
  let requestSignal;
  const guard = createGitHubMainHeadGuard({
    environment: environment(),
    source: SOURCE,
    signal: controller.signal,
    fetch: async (_url, init) => await new Promise((_resolve, reject) => {
      requestSignal = init.signal;
      init.signal.addEventListener("abort", () => reject(new Error("request interrupted")), { once: true });
    }),
  });
  const check = guard();
  await Promise.resolve();
  controller.abort();
  const result = await capture(check);
  assertPublisherError(result, "publisher.cancelled", [GITHUB_TOKEN, DOCS_TOKEN]);
  assert.equal(requestSignal.aborted, true);
});
