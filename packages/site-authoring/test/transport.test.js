import assert from "node:assert/strict";
import test from "node:test";

import { CAPABILITY_REFUSAL_REASON, REFUSAL_KINDS } from "../src/constants.js";
import { ApiError, capabilityRefusal, fieldViolations, SiteApiClient } from "../src/transport.js";
import { SiteAuthoringError } from "../src/errors.js";

const API_BASE_URL = "https://app.taproot.test/api";
const TOKEN = "tr_live_site_key_that_must_never_be_logged";

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
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function makeClient(fetch, overrides = {}) {
  return new SiteApiClient({
    apiBaseUrl: API_BASE_URL,
    token: TOKEN,
    sleep: async () => {},
    fetch,
    ...overrides,
  });
}

function violation(field) {
  return { details: [{ fieldViolations: [{ field }] }] };
}

/**
 * The transcoded shape `SiteAuthoringKeyDenial` produces for a key-mode
 * permission denial (TR00691): one `google.rpc.ErrorInfo` detail, no field
 * violation, because the request is well formed and the credential is narrow.
 */
function capabilityDetail(metadata) {
  return {
    code: 7,
    message: "Permission is not granted in this scope.",
    details: [{
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: CAPABILITY_REFUSAL_REASON,
      domain: "taproot-site-authoring",
      metadata,
    }],
  };
}

const DESIGN_ONLY_PAGE_LIST = capabilityDetail({
  permission: "site.pages.edit_any",
  granted: "delegation.design",
  required: "delegation.content",
});

test("refuses a non-reviewed origin before it ever holds a bearer token", () => {
  for (const apiBaseUrl of ["https://attacker.example/api", "http://app.taproot.io/api", "https://app.taproot.io/v1"]) {
    assert.throws(
      () => new SiteApiClient({ apiBaseUrl, token: TOKEN, fetch: async () => jsonResponse({}) }),
      (error) => error?.code === "config.api_base_url",
    );
  }
  // A malformed credential and a rejected origin together: the origin decides,
  // because the allowlist runs before the token is inspected or stored.
  assert.throws(
    () => new SiteApiClient({ apiBaseUrl: "https://attacker.example/api", token: "", fetch: async () => jsonResponse({}) }),
    (error) => error?.code === "config.api_base_url",
  );
});

test("refuses a missing or malformed credential", () => {
  for (const token of [undefined, "", 7, "x".repeat(513), `abc${String.fromCodePoint(10)}def`]) {
    assert.throws(
      () => new SiteApiClient({ apiBaseUrl: API_BASE_URL, token, fetch: async () => jsonResponse({}) }),
      (error) => error?.code === "auth.key_invalid",
    );
  }
});

test("pins the reviewed origin and the /api path prefix", async () => {
  const client = makeClient(async () => {
    throw new Error("fetch must not be reached");
  });
  for (
    const target of [
      "https://attacker.example/v1/pages",
      "//attacker.example/v1/pages",
      "../v1/pages",
      "../../v1/pages",
    ]
  ) {
    await assert.rejects(
      client.request(target),
      (error) => error?.code === "transport.request_contract",
    );
  }
});

test("accepts exactly the reviewed method set", async (testContext) => {
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    await testContext.test(`allows ${method}`, async () => {
      const calls = [];
      const client = makeClient(async (url, init) => {
        calls.push(init.method);
        return jsonResponse({ ok: true });
      });
      assert.deepEqual(await client.request("v1/sites/site/pages", { method }), { ok: true });
      assert.deepEqual(calls, [method]);
    });
  }
  for (const method of ["HEAD", "OPTIONS", "TRACE", "CONNECT", "get", ""]) {
    await testContext.test(`refuses ${JSON.stringify(method)}`, async () => {
      let calls = 0;
      const client = makeClient(async () => {
        calls += 1;
        return jsonResponse({ ok: true });
      });
      await assert.rejects(
        client.request("v1/sites/site/pages", { method }),
        (error) => error?.code === "transport.request_contract",
      );
      assert.equal(calls, 0);
    });
  }
});

test("sends the reviewed authorization, user agent, and redirect policy", async () => {
  const calls = [];
  const client = makeClient(async (url, init) => {
    calls.push({ url: url.toString(), init });
    return jsonResponse({ ok: true });
  });
  await client.request("v1/sites/site/pages");
  assert.equal(calls[0].url, "https://app.taproot.test/api/v1/sites/site/pages");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.headers["user-agent"], "@taprootio/site-authoring/0.5.0");
  assert.equal(calls[0].init.headers.accept, "application/json");
  assert.equal(calls[0].init.redirect, "error");
});

test("replays a lost GET byte-identically and never replays an ordinary mutation", async (testContext) => {
  await testContext.test("GET", async () => {
    const calls = [];
    const client = makeClient(async (url, init) => {
      calls.push({ url: url.toString(), method: init.method, authorization: init.headers.authorization });
      if (calls.length === 1) throw new Error(`lost ${TOKEN}`);
      return jsonResponse({ ok: true });
    });
    assert.deepEqual(await client.request("v1/sites/site/deployments"), { ok: true });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
  });

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    await testContext.test(method, async () => {
      let calls = 0;
      const client = makeClient(async () => {
        calls += 1;
        throw new Error("connection reset");
      });
      await assert.rejects(
        client.request("v1/sites/site/pages", { method, body: { path: "about" } }),
        (error) => error?.code === "transport.mutation_ambiguous",
      );
      assert.equal(calls, 1);
    });
  }
});

/**
 * A mutation that never left the machine did not happen, and saying otherwise
 * has a cost: `login` treats an ambiguous claim as a credential that may have
 * been minted, so a certificate problem or a DNS blip used to abort the whole
 * login with revoke-it-by-hand guidance for a credential that never existed.
 */
test("a mutation that provably never reached the server is not reported as ambiguous", async (testContext) => {
  const undelivered = [
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "ENOTFOUND",
    "ECONNREFUSED",
  ];
  for (const code of undelivered) {
    await testContext.test(code, async () => {
      const client = makeClient(async () => {
        // The shape Node's fetch actually produces: every one of these arrives
        // as a TypeError saying "fetch failed", with the real reason on cause.
        const error = new TypeError("fetch failed");
        error.cause = Object.assign(new Error("underlying"), { code });
        throw error;
      });
      await assert.rejects(
        client.request("v1/sites/site/pages", { method: "POST", body: { path: "about" } }),
        (error) =>
          error?.code === "transport.network"
          && error.message.includes(code),
      );
    });
  }
});

test("a mutation that may have been delivered stays ambiguous, and names why", async () => {
  const client = makeClient(async () => {
    const error = new TypeError("fetch failed");
    // A socket that died mid-flight is the genuinely ambiguous case: the
    // request may already have been written. This must not be reclassified.
    error.cause = Object.assign(new Error("underlying"), { code: "ECONNRESET" });
    throw error;
  });
  await assert.rejects(
    client.request("v1/sites/site/pages", { method: "POST", body: { path: "about" } }),
    (error) =>
      error?.code === "transport.mutation_ambiguous"
      && error.message.includes("ECONNRESET"),
  );
});

/**
 * Replaying bounds how many times a request is *sent*, not whether the last
 * send arrived. So a replayable claim that exhausts its retries is still one
 * of two things: provably undelivered, or possibly applied. `login` arms its
 * possible-orphan warning on the second and must not on the first, and until
 * this split both came out as "network".
 */
test("a replayable claim that never reached the server after every retry is not ambiguous", async () => {
  let attempts = 0;
  const client = SiteApiClient.anonymous({
    apiBaseUrl: API_BASE_URL,
    sleep: async () => {},
    fetch: async () => {
      attempts += 1;
      const error = new TypeError("fetch failed");
      error.cause = Object.assign(new Error("underlying"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
      throw error;
    },
  });
  await assert.rejects(
    client.replaceablePost("v1/site-authoring/cli-authorizations/claim", { body: { deviceCode: "a".repeat(43) } }),
    (error) => error?.code === "transport.network" && error.message.includes("UNABLE_TO_VERIFY_LEAF_SIGNATURE"),
  );
  assert.ok(attempts > 1, "the claim is replayable and must have been retried before giving up");
});

test("a replayable claim whose last retry died in flight stays ambiguous", async () => {
  const client = SiteApiClient.anonymous({
    apiBaseUrl: API_BASE_URL,
    sleep: async () => {},
    fetch: async () => {
      const error = new TypeError("fetch failed");
      error.cause = Object.assign(new Error("underlying"), { code: "ECONNRESET" });
      throw error;
    },
  });
  await assert.rejects(
    client.replaceablePost("v1/site-authoring/cli-authorizations/claim", { body: { deviceCode: "a".repeat(43) } }),
    (error) => error?.code === "transport.mutation_ambiguous" && error.message.includes("ECONNRESET"),
  );
});

test("a claim that was ambiguous on one attempt stays ambiguous however its retry fails", async () => {
  // First send: the connection resets after the request is on the wire — the
  // mint may have committed. Retry: the TLS handshake fails, which is provably
  // undelivered. Read off the last attempt alone, this is "network", and login
  // would tell the operator nothing was issued over a possible orphan.
  let attempts = 0;
  const client = SiteApiClient.anonymous({
    apiBaseUrl: API_BASE_URL,
    sleep: async () => {},
    fetch: async () => {
      attempts += 1;
      const error = new TypeError("fetch failed");
      error.cause = Object.assign(new Error("underlying"), {
        code: attempts === 1 ? "ECONNRESET" : "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      });
      throw error;
    },
  });
  await assert.rejects(
    client.replaceablePost("v1/site-authoring/cli-authorizations/claim", { body: { deviceCode: "a".repeat(43) } }),
    (error) => error?.code === "transport.mutation_ambiguous",
  );
  assert.ok(attempts > 1);
});

test("a claim answered 5xx on one attempt stays ambiguous when its retry never arrives", async () => {
  // A 502 is a proxy giving up, possibly after the handler committed. Alone it
  // exhausts as retry_exhausted, which login treats as a loss; followed by an
  // undelivered retry it must not downgrade to "never sent".
  let attempts = 0;
  const client = SiteApiClient.anonymous({
    apiBaseUrl: API_BASE_URL,
    sleep: async () => {},
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) return new Response("", { status: 502 });
      const error = new TypeError("fetch failed");
      error.cause = Object.assign(new Error("underlying"), { code: "ECONNREFUSED" });
      throw error;
    },
  });
  await assert.rejects(
    client.replaceablePost("v1/site-authoring/cli-authorizations/claim", { body: { deviceCode: "a".repeat(43) } }),
    (error) => error?.code === "transport.mutation_ambiguous",
  );
});

test("a claim that answered 2xx unreadably stays ambiguous when every retry then never arrives", async () => {
  // The strongest orphan case: the server said success — the mint committed —
  // and this side could not read the body. The transport retries that. If the
  // retries then fail a handshake, the last error alone says "never sent".
  let attempts = 0;
  const client = SiteApiClient.anonymous({
    apiBaseUrl: API_BASE_URL,
    sleep: async () => {},
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("this is not json", { status: 200, headers: { "content-type": "application/json" } });
      }
      const error = new TypeError("fetch failed");
      error.cause = Object.assign(new Error("underlying"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
      throw error;
    },
  });
  await assert.rejects(
    client.replaceablePost("v1/site-authoring/cli-authorizations/claim", { body: { deviceCode: "a".repeat(43) } }),
    (error) => error?.code === "transport.mutation_ambiguous",
  );
  assert.ok(attempts > 1, "the unreadable 2xx must have been retried before the undelivered exhaustion");
});

/**
 * Where a cancellation lands decides whether a mutation may already have run,
 * and the transport says which on the error it raises. `login` reads that tag
 * to choose between "nothing was issued" and "a credential may exist".
 */
function claimClientCancellingDuringBackoff(firstCause) {
  const controller = new AbortController();
  let attempts = 0;
  const client = SiteApiClient.anonymous({
    apiBaseUrl: API_BASE_URL,
    signal: controller.signal,
    // Backoff: Ctrl+C lands here, between attempts, with nothing in flight.
    sleep: async () => {
      controller.abort();
      throw new SiteAuthoringError("site.cancelled", "cancelled during backoff");
    },
    fetch: async () => {
      attempts += 1;
      const error = new TypeError("fetch failed");
      error.cause = Object.assign(new Error("underlying"), { code: firstCause });
      throw error;
    },
  });
  return { client, attempts: () => attempts };
}

test("a cancellation during backoff after only undelivered failures is not ambiguous", async () => {
  const { client } = claimClientCancellingDuringBackoff("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
  await assert.rejects(
    client.replaceablePost("v1/site-authoring/cli-authorizations/claim", { body: { deviceCode: "a".repeat(43) } }),
    (error) => error?.code === "site.cancelled" && error.ambiguousMutation === false,
  );
});

test("a cancellation during backoff after a reset carries the ambiguity of that reset", async () => {
  const { client } = claimClientCancellingDuringBackoff("ECONNRESET");
  await assert.rejects(
    client.replaceablePost("v1/site-authoring/cli-authorizations/claim", { body: { deviceCode: "a".repeat(43) } }),
    (error) => error?.code === "site.cancelled" && error.ambiguousMutation === true,
  );
});

test("an abort that interrupts an in-flight mutation is ambiguous on its own", async () => {
  const controller = new AbortController();
  const client = makeClient(() => {
    // The request is on the wire when Ctrl+C lands; it may have arrived. An
    // abandoned real fetch never settles — the transport's signal race is
    // what rejects — so the double must not throw afterwards, or that throw
    // becomes an orphaned rejection nothing is left to observe.
    controller.abort();
    return new Promise(() => {});
  }, { signal: controller.signal });
  await assert.rejects(
    client.request("v1/sites/site/pages", { method: "POST", body: { path: "about" } }),
    (error) => error?.code === "site.cancelled" && error.ambiguousMutation === true,
  );
});

test("an abort that interrupts an in-flight read is never ambiguous", async () => {
  const controller = new AbortController();
  const client = makeClient(() => {
    controller.abort();
    return new Promise(() => {});
  }, { signal: controller.signal });
  await assert.rejects(
    client.request("v1/sites/site/deployments"),
    (error) => error?.code === "site.cancelled" && error.ambiguousMutation === false,
  );
});

test("a read that died in flight is a network failure, never an ambiguous mutation", async () => {
  const client = makeClient(async () => {
    const error = new TypeError("fetch failed");
    error.cause = Object.assign(new Error("underlying"), { code: "ECONNRESET" });
    throw error;
  });
  // There was nothing to apply, so "may have been applied" would be nonsense.
  await assert.rejects(
    client.request("v1/sites/site/deployments"),
    (error) => error?.code === "transport.network",
  );
});

test("an unrecognizable cause is left out rather than echoed into the message", async () => {
  const client = makeClient(async () => {
    const error = new TypeError("fetch failed");
    // Codes are a fixed vocabulary and this text reaches logs, so anything
    // that is not one is dropped rather than passed through.
    error.cause = Object.assign(new Error("underlying"), {
      code: "https://attacker.example/?stolen=" + TOKEN,
    });
    throw error;
  });
  await assert.rejects(
    client.request("v1/sites/site/pages", { method: "POST", body: { path: "about" } }),
    (error) =>
      error?.code === "transport.mutation_ambiguous"
      && !error.message.includes("attacker.example")
      && !error.message.includes(TOKEN),
  );
});

test("replays only the operation-scoped replaceable POSTs", async (testContext) => {
  const siteId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const pageId = "11111111-1111-4111-8111-111111111111";
  const snapshotId = "22222222-2222-4222-8222-222222222222";
  const path = `v1/sites/${siteId}/authoring-previews/pages/${pageId}/${snapshotId}:mint-handoff`;
  const body = { siteId, pageId, snapshotId };

  for (const failure of ["network", "status"]) {
    await testContext.test(failure, async () => {
      const calls = [];
      const client = makeClient(async (url, init) => {
        calls.push({ url: url.toString(), method: init.method, body: init.body, authorization: init.headers.authorization });
        if (calls.length === 1) {
          if (failure === "network") throw new Error("connection reset after replacement commit");
          return jsonResponse({ code: 14 }, 503);
        }
        return jsonResponse({ ok: true });
      });
      assert.deepEqual(await client.replaceablePost(path, { body }), { ok: true });
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0], calls[1]);
      assert.equal(calls[0].method, "POST");
      assert.equal(calls[0].authorization, `Bearer ${TOKEN}`);
    });
  }

  // The claim is the second member of the closed set. It is replayed for the
  // opposite reason to the handoff mint: not because a replay replaces the
  // prior result, but because the guarded single-use transition answers a
  // replay with CONSUMED rather than minting a second credential — which is
  // exactly the answer `login` needs in order to report an orphaned key.
  await testContext.test("cli authorization claim after a lost response", async () => {
    const calls = [];
    const client = SiteApiClient.anonymous({
      apiBaseUrl: API_BASE_URL,
      sleep: async () => {},
      fetch: async (url, init) => {
        calls.push({ url: url.toString(), body: init.body });
        if (calls.length === 1) throw new Error("connection reset after the mint committed");
        return jsonResponse({ status: "CLI_AUTHORIZATION_CLAIM_STATUS_CONSUMED" });
      },
    });
    assert.deepEqual(
      await client.replaceablePost("v1/site-authoring/cli-authorizations/claim", { body: { deviceCode: "a".repeat(43) } }),
      { status: "CLI_AUTHORIZATION_CLAIM_STATUS_CONSUMED" },
    );
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
  });

  await testContext.test("cannot opt an ordinary POST into replay", async () => {
    const client = makeClient(async () => {
      throw new Error("fetch must not be reached");
    });
    for (
      const path of [
        `v1/sites/${siteId}/deploy`,
        // Adjacent to the allowlisted claim, and deliberately not on it.
        "v1/site-authoring/cli-authorizations",
        "v1/site-authoring/cli-authorizations/claim/extra",
      ]
    ) {
      await assert.rejects(
        client.replaceablePost(path, { body: { siteId } }),
        (error) => error?.code === "transport.request_contract",
      );
    }
  });
});

test("an anonymous client is identical except that it can never carry a bearer", async (testContext) => {
  await testContext.test("sends no authorization header", async () => {
    let seen;
    const client = SiteApiClient.anonymous({
      apiBaseUrl: API_BASE_URL,
      fetch: async (url, init) => {
        seen = init.headers;
        return jsonResponse({ ok: true });
      },
    });
    assert.deepEqual(await client.request("v1/site-authoring/cli-authorizations", { method: "POST", body: {} }), {
      ok: true,
    });
    assert.equal(Object.hasOwn(seen, "authorization"), false);
    assert.equal(seen.accept, "application/json");
    assert.equal(seen["content-type"], "application/json");
    assert.equal(client.anonymous, true);
  });

  await testContext.test("cannot be handed a token", async () => {
    let seen;
    // The factory overwrites whatever `token` it was given, so an anonymous
    // client is anonymous even when a caller tries to supply a credential.
    const client = SiteApiClient.anonymous({
      apiBaseUrl: API_BASE_URL,
      token: TOKEN,
      fetch: async (url, init) => {
        seen = init.headers;
        return jsonResponse({ ok: true });
      },
    });
    await client.request("v1/site-authoring/cli-authorizations", { method: "POST", body: {} });
    assert.equal(Object.hasOwn(seen, "authorization"), false);
    assert.doesNotMatch(JSON.stringify(Object.values(seen)), new RegExp(TOKEN, "u"));
  });

  await testContext.test("still refuses an origin outside the reviewed set", () => {
    for (const apiBaseUrl of ["https://attacker.example/api", "http://app.taproot.io/api"]) {
      assert.throws(
        () => SiteApiClient.anonymous({ apiBaseUrl, fetch: async () => jsonResponse({}) }),
        (error) => error?.code === "config.api_base_url",
      );
    }
  });

  await testContext.test("still pins the reviewed origin and path prefix on every request", async () => {
    const client = SiteApiClient.anonymous({
      apiBaseUrl: API_BASE_URL,
      fetch: async () => {
        throw new Error("fetch must not be reached");
      },
    });
    await assert.rejects(
      client.request("https://attacker.example/v1/site-authoring/cli-authorizations", { method: "POST" }),
      (error) => error?.code === "transport.request_contract",
    );
  });

  // The token-bearing path is unchanged: an invalid credential still cannot
  // reach a constructed client, and the anonymous path is not a way around it.
  await testContext.test("a token-bearing client still refuses a malformed credential", () => {
    assert.throws(
      () => new SiteApiClient({ apiBaseUrl: API_BASE_URL, token: "", fetch: async () => jsonResponse({}) }),
      (error) => error?.code === "auth.key_invalid",
    );
  });
});

test("retries a retryable status for GET but not an ordinary mutation", async (testContext) => {
  await testContext.test("GET", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({ unavailable: true }, 503) : jsonResponse({ ok: true });
    });
    assert.deepEqual(await client.request("v1/sites/site/deployments"), { ok: true });
    assert.equal(calls, 2);
  });

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    await testContext.test(method, async () => {
      let calls = 0;
      const client = makeClient(async () => {
        calls += 1;
        return jsonResponse({ code: 14 }, 503);
      });
      await assert.rejects(
        client.request("v1/sites/site/navigation", { method }),
        (error) => error?.code === "api.request_rejected" && error?.httpStatus === 503,
      );
      assert.equal(calls, 1);
    });
  }
});

test("retries an unreadable GET success body but not an unreadable mutation body", async (testContext) => {
  await testContext.test("GET", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      return calls === 1 ? unreadableJsonResponse() : jsonResponse({ ok: true });
    });
    assert.deepEqual(await client.request("v1/sites/site/images"), { ok: true });
    assert.equal(calls, 2);
  });

  await testContext.test("POST", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      return unreadableJsonResponse();
    });
    await assert.rejects(
      client.request("v1/sites/site/pages", { method: "POST", body: {} }),
      (error) => error?.code === "transport.response_read",
    );
    assert.equal(calls, 1);
  });
});

test("bounds a response body without incorporating its bytes in the error", async () => {
  const secret = "page-body-secret-content";
  let calls = 0;
  const client = makeClient(async () => {
    calls += 1;
    return new Response(secret.repeat(100_000), { status: 200 });
  });
  await assert.rejects(
    client.request("v1/sites/site/pages"),
    (error) => error?.code === "transport.response_too_large" && !error.message.includes(secret),
  );
  assert.equal(calls, 1);
});

test("collects nested field violations without unbounded or unsafe values", () => {
  assert.deepEqual(
    fieldViolations({
      code: 3,
      details: [
        { fieldViolations: [{ field: "Path" }, { field: "Body" }] },
        { nested: { deeper: { fieldViolations: [{ field: "Path" }, { field: "ExternalApiKey" }] } } },
      ],
    }),
    ["Body", "ExternalApiKey", "Path"],
  );
  assert.deepEqual(
    fieldViolations({ details: [{ field: `Path${String.fromCodePoint(13)}spoof` }, { field: "x".repeat(201) }] }),
    [],
  );
});

test("reads the key-mode capability denial out of its packed error detail", async (testContext) => {
  await testContext.test("the shipped shape", () => {
    assert.deepEqual(capabilityRefusal(DESIGN_ONLY_PAGE_LIST), {
      permission: "site.pages.edit_any",
      granted: ["delegation.design"],
      required: ["delegation.content"],
    });
  });

  await testContext.test("multiple capabilities on either side", () => {
    assert.deepEqual(
      capabilityRefusal(capabilityDetail({
        permission: "site.media.manage",
        granted: "delegation.deployments",
        required: "delegation.content,delegation.design",
      })),
      {
        permission: "site.media.manage",
        granted: ["delegation.deployments"],
        required: ["delegation.content", "delegation.design"],
      },
    );
  });

  // A permission no capability carries is a real answer, and the one an agent
  // most needs: no amount of widening the exchange will reach it.
  await testContext.test("a permission no capability carries", () => {
    assert.deepEqual(
      capabilityRefusal(capabilityDetail({
        permission: "site.settings.manage",
        granted: "delegation.content,delegation.design,delegation.deployments",
        required: "",
      })).required,
      [],
    );
  });

  await testContext.test("names the CLI cannot vouch for are dropped, never printed", () => {
    assert.deepEqual(
      capabilityRefusal(capabilityDetail({
        permission: "site.pages.edit_any",
        granted: `delegation.design,delegation.${String.fromCodePoint(13)}spoof,DELEGATION.SHOUTY,x`.concat(
          `,${"y".repeat(400)}`,
        ),
        required: "delegation.content",
      })).granted,
      ["delegation.design"],
    );
  });

  await testContext.test("a detail naming no permission is not this refusal", () => {
    for (
      const body of [
        capabilityDetail({ granted: "delegation.design", required: "delegation.content" }),
        capabilityDetail({ permission: "not a permission", required: "delegation.content" }),
        { code: 7, details: [{ reason: "SOMETHING_ELSE", metadata: { permission: "site.pages.edit_any" } }] },
        { code: 7 },
      ]
    ) {
      assert.equal(capabilityRefusal(body), undefined);
    }
  });
});

test("classifies every refusal the authoring surface speaks", async (testContext) => {
  const cases = [
    // The client itself is the problem, and no retry of this binary succeeds
    // (TR00703). Classified ahead of every other field for that reason.
    {
      name: "cli upgrade required",
      status: 400,
      body: { code: 3, ...violation("CliUpgradeRequired") },
      kind: "cli_outdated",
    },
    { name: "cli upgrade required casing", status: 400, body: violation("cliupgraderequired"), kind: "cli_outdated" },
    { name: "rollout", status: 503, body: { code: 14, ...violation("SiteAuthoringRollout") }, kind: "platform_paused" },
    { name: "rollout casing", status: 503, body: violation("siteauthoringrollout"), kind: "platform_paused" },
    // The shape the authority resolver actually emits: a bare Unauthenticated
    // with no details at all, because the public boundary must not let a caller
    // enumerate key, site, or account state. This is the single most likely
    // refusal the CLI will meet, and it carries no field to classify on.
    {
      name: "credential (bare, the boundary's real shape)",
      status: 401,
      body: { code: 16 },
      kind: "credential_rejected",
    },
    { name: "credential by grpc code alone", status: 400, body: { code: 16 }, kind: "credential_rejected" },
    { name: "credential by http status alone", status: 401, body: {}, kind: "credential_rejected" },
    // The other credential shape: the in-transaction re-validation does attach
    // the field, so the field path has to keep classifying too.
    {
      name: "credential by field",
      status: 400,
      body: { code: 3, ...violation("ExternalApiKey") },
      kind: "credential_rejected",
    },
    { name: "plan limit", status: 400, body: { code: 3, ...violation("UpgradePrompt") }, kind: "plan_limit" },
    // The credential is valid, correctly scoped, and simply narrower than the
    // request. Classified apart from `credential_rejected` because re-issuing
    // the same credential cannot help: the verb table is what is wrong.
    { name: "capability missing", status: 403, body: DESIGN_ONLY_PAGE_LIST, kind: "capability_missing" },
    { name: "grpc throttle", status: 400, body: { code: 8 }, kind: "throttled" },
    { name: "http throttle", status: 429, body: {}, kind: "throttled" },
    { name: "ordinary validation", status: 400, body: { code: 3, ...violation("Path") }, kind: "unclassified" },
    { name: "server fault", status: 500, body: {}, kind: "unclassified" },
  ];
  for (const scenario of cases) {
    await testContext.test(scenario.name, () => {
      assert.equal(new ApiError(scenario.status, scenario.body).refusalKind(), scenario.kind);
    });
  }
  // Every kind in the shared vocabulary is exercised above, so a new kind
  // cannot be added to the table without a case that proves how it is reached.
  assert.deepEqual(new Set(cases.map((scenario) => scenario.kind)), new Set(REFUSAL_KINDS));

  await testContext.test("a named refusal outranks a status mapping", async (caseContext) => {
    await caseContext.test("over the throttle", () => {
      const error = new ApiError(429, { code: 8, ...violation("SiteAuthoringRollout") });
      assert.equal(error.refusalKind(), "platform_paused");
    });
    // A paused rollout answers 503 today, but the kill switch is checked inside
    // the write transaction, behind the credential — so if one ever arrives on
    // a 401 the named refusal is still the specific statement.
    await caseContext.test("over the credential status", () => {
      const error = new ApiError(401, { code: 16, ...violation("SiteAuthoringRollout") });
      assert.equal(error.refusalKind(), "platform_paused");
    });
  });

  await testContext.test("a rejection thrown by the client carries its classification", async () => {
    const client = makeClient(async () => jsonResponse({ code: 7, ...violation("ExternalApiKey") }, 403));
    await assert.rejects(
      client.request("v1/sites/site/pages", { method: "POST", body: {} }),
      (error) =>
        error?.code === "api.request_rejected"
        && error.field === "ExternalApiKey"
        && error.status === "grpc:7"
        && error.refusalKind() === "credential_rejected",
    );
  });
});

test("uploads exact bytes with only the signed headers and never forwards the bearer", async () => {
  const calls = [];
  const bytes = Buffer.from("image-bytes");
  const client = makeClient(async (url, init) => {
    calls.push({ url: url.toString(), init });
    return new Response(null, { status: 200 });
  });
  await client.upload({
    url: "https://objects.example/presigned?signature=secret",
    requiredHeaders: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(bytes.byteLength),
      "x-amz-meta-width": "800",
    },
  }, bytes);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.get("authorization"), null);
  // Echoed verbatim: the signed content type is the server's, not a constant
  // this package chose, and no header outside the signed set is added.
  assert.equal(calls[0].init.headers.get("content-type"), "image/jpeg");
  assert.equal(calls[0].init.headers.get("content-length"), String(bytes.byteLength));
  assert.equal(calls[0].init.headers.get("x-amz-meta-width"), "800");
  assert.deepEqual(
    [...calls[0].init.headers.keys()].sort(),
    ["content-length", "content-type", "x-amz-meta-width"],
  );
  assert.equal(calls[0].init.body, bytes);
});

test("refuses a signed upload capability it cannot honor exactly", async (testContext) => {
  const bytes = Buffer.from("image-bytes");
  const signed = {
    "Content-Type": "image/jpeg",
    "Content-Length": String(bytes.byteLength),
  };
  const cases = [
    {
      name: "content length disagreement",
      capability: { url: "https://objects.example/put", requiredHeaders: { ...signed, "Content-Length": "6" } },
      code: "upload.content_length_invalid",
    },
    {
      name: "missing content type",
      capability: { url: "https://objects.example/put", requiredHeaders: { "Content-Length": "11" } },
      code: "upload.headers_invalid",
    },
    {
      name: "list instead of the signed map",
      capability: {
        url: "https://objects.example/put",
        requiredHeaders: [{ name: "Content-Type", value: "image/jpeg" }],
      },
      code: "upload.headers_invalid",
    },
    {
      name: "absent header map",
      capability: { url: "https://objects.example/put" },
      code: "upload.headers_invalid",
    },
    {
      name: "case-colliding header names",
      capability: {
        url: "https://objects.example/put",
        requiredHeaders: { ...signed, "content-type": "image/png" },
      },
      code: "upload.headers_invalid",
    },
    {
      name: "invalid header name",
      capability: { url: "https://objects.example/put", requiredHeaders: { ...signed, "bad header": "x" } },
      code: "upload.headers_invalid",
    },
    {
      name: "control character in a header value",
      capability: {
        url: "https://objects.example/put",
        requiredHeaders: { ...signed, "x-amz-meta-original-filename": `a${String.fromCodePoint(13)}b` },
      },
      code: "upload.headers_invalid",
    },
    {
      name: "empty header value",
      capability: { url: "https://objects.example/put", requiredHeaders: { ...signed, "x-amz-meta-width": "" } },
      code: "upload.headers_invalid",
    },
    {
      name: "plaintext capability outside loopback",
      capability: { url: "http://objects.example/put", requiredHeaders: signed },
      code: "upload.contract_invalid",
    },
    {
      name: "credential-bearing capability URL",
      capability: { url: "https://operator:secret@objects.example/put", requiredHeaders: signed },
      code: "upload.contract_invalid",
    },
    {
      name: "unparseable capability URL",
      capability: { url: "not-a-url", requiredHeaders: signed },
      code: "upload.contract_invalid",
    },
  ];
  for (const scenario of cases) {
    await testContext.test(scenario.name, async () => {
      const client = makeClient(async () => {
        throw new Error("fetch must not be reached");
      });
      await assert.rejects(
        client.upload(scenario.capability, bytes),
        (error) => error?.code === scenario.code,
      );
    });
  }

  await testContext.test("a body that is not bytes", async () => {
    const client = makeClient(async () => {
      throw new Error("fetch must not be reached");
    });
    await assert.rejects(
      client.upload({ url: "https://objects.example/put", requiredHeaders: signed }, "image-bytes"),
      (error) => error?.code === "upload.contract_invalid",
    );
  });
});

test("replays a presigned PUT and reports a rejection that is not ambiguous", async (testContext) => {
  const bytes = Buffer.from("image-bytes");
  const capability = {
    url: "http://127.0.0.1:9000/bucket/object",
    requiredHeaders: { "Content-Type": "image/jpeg", "Content-Length": String(bytes.byteLength) },
  };

  await testContext.test("retries a retryable status", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      return new Response(null, { status: calls === 1 ? 503 : 200 });
    });
    await client.upload(capability, bytes);
    assert.equal(calls, 2);
  });

  await testContext.test("reports a terminal rejection", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      return new Response(null, { status: 403 });
    });
    await assert.rejects(
      client.upload(capability, bytes),
      (error) => error?.code === "upload.rejected" && error?.status === "http:403",
    );
    assert.equal(calls, 1);
  });
});

test("retains violation descriptions with the same bounds the fields get", async (testContext) => {
  const build = (field, description) => new ApiError(400, {
    code: 3,
    message: "invalid",
    details: [{ fieldViolations: [{ field, description }] }],
  });

  await testContext.test("carries the server's wording, case-insensitively", () => {
    const error = build("UpgradePrompt", "This plan allows 20 published pages.");
    assert.equal(error.descriptionFor("upgradeprompt"), "This plan allows 20 published pages.");
    assert.equal(error.descriptionFor("SomethingElse"), undefined);
  });

  await testContext.test("refuses oversized or unprintable descriptions", () => {
    assert.equal(build("UpgradePrompt", "x".repeat(2_001)).descriptionFor("UpgradePrompt"), undefined);
    assert.equal(build("UpgradePrompt", "line\u0007bell").descriptionFor("UpgradePrompt"), undefined);
    assert.equal(build("UpgradePrompt", "").descriptionFor("UpgradePrompt"), undefined);
  });

  await testContext.test("keeps the first description when a field repeats", () => {
    const error = new ApiError(400, {
      code: 3,
      details: [{
        fieldViolations: [
          { field: "UpgradePrompt", description: "first" },
          { field: "UpgradePrompt", description: "second" },
        ],
      }],
    });
    assert.equal(error.descriptionFor("UpgradePrompt"), "first");
  });
});
