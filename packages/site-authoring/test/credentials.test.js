import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { LIMITS } from "../src/constants.js";
import { SiteAuthoringError } from "../src/errors.js";
import { readCredentialStore, saveCredential } from "../src/credentials.js";
import { login } from "../src/verbs/login.js";
import { logout } from "../src/verbs/logout.js";
import { status } from "../src/verbs/status.js";

// ---------------------------------------------------------------------------
// The values that must never leave this process
// ---------------------------------------------------------------------------

const SITE_ID = "aaaa1111-bbbb-4111-8111-cccc11111111";
const ACCOUNT_ID = "eeee5555-ffff-4555-8555-aaaa55555555";
const OTHER_SITE_ID = "bbbb2222-cccc-4222-8222-dddd22222222";
const API_BASE_URL = "https://app.taproot.test/api";
const API_ORIGIN = "https://app.taproot.test";
const OTHER_API_ORIGIN = "https://app.taproot.io";
const KEY_ID = "dddd4444-eeee-4444-8444-ffff44444444";
const KEY_PREFIX = "tr_live_ab12cd34...";
const KEY_EXPIRES_AT = "2026-12-31T23:59:59.000Z";
// The three values the flow must never emit: the minted secret, the device code
// that can redeem it, and a key already sitting in the store.
const RAW_KEY = "tr_live_ab12cd34MintedSecretThatMustNeverBeLogged";
const STORED_KEY = "tr_live_zz99yy88_stored_secret_that_must_never_be_logged";
const DEVICE_CODE = "D".repeat(43);
const USER_CODE = "BCDF-2345";
// The approval URL deliberately carries no code: the owner types it, which is
// the device flow's proof that the approver can see this terminal.
const VERIFICATION_URL = `${API_ORIGIN}/authorize-cli`;

const START_PATH = "/api/v1/site-authoring/cli-authorizations";
const CLAIM_PATH = "/api/v1/site-authoring/cli-authorizations/claim";
const EXCHANGE_PATH = "/api/v1/site-authoring/tokens:exchange";
const EXCHANGED_KEY = "tr_live_exchanged0000000000000000000000000000";
const EXCHANGED_KEY_ID = "cccc3333-dddd-4333-8333-eeee33333333";

/**
 * Every site-scoped verb now reaches its site credential by exchanging the
 * stored sign-in for one (TR00645), so a wire that serves a site verb has to
 * serve the exchange too.
 */
function exchangeRoute(overrides = {}) {
  return {
    method: "POST",
    pathname: EXCHANGE_PATH,
    reply: {
      rawKey: EXCHANGED_KEY,
      keyId: EXCHANGED_KEY_ID,
      keyPrefix: "tr_live_ex99ab88...",
      siteId: SITE_ID,
      expiresAt: "2026-12-31T23:59:59.000Z",
      capabilities: ["delegation.content", "delegation.deployments", "delegation.design"],
    },
    ...overrides,
  };
}
const READINESS = /\/publishing\/readiness$/u;
const DEPLOYMENTS = /\/deployments$/u;
const SITE_IMAGES = /\/sites\/[^/]+\/images$/u;

const PENDING = { status: "CLI_AUTHORIZATION_CLAIM_STATUS_PENDING" };
const ISSUED = {
  status: "CLI_AUTHORIZATION_CLAIM_STATUS_ISSUED",
  rawKey: RAW_KEY,
  keyId: KEY_ID,
  keyPrefix: KEY_PREFIX,
  keyExpiresAt: KEY_EXPIRES_AT,
  accountId: ACCOUNT_ID,
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * A project with a configuration, plus a private XDG_CONFIG_HOME. The store
 * location is resolved from the *injected* environment, never `process.env`, so
 * every test here is fully isolated from whatever the machine running it has
 * logged in to — and nothing mutates the process it runs in.
 */
async function fixture(testContext, { siteId = SITE_ID } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "taproot-site-credentials-"));
  testContext.after(() => rm(base, { recursive: true, force: true }));
  const root = await realpath(base);
  const project = path.join(root, "project");
  const configHome = path.join(root, "config-home");
  await mkdir(path.join(project, "site"), { recursive: true });
  await mkdir(configHome, { recursive: true });
  await writeFile(
    path.join(project, "taproot-site.json"),
    `${JSON.stringify({ configVersion: 1, siteId, workspaceDir: "site" })}\n`,
  );
  // The endpoint is machine state since TR00645: set the way `env local` sets
  // it, inside this fixture's own XDG_CONFIG_HOME.
  await mkdir(path.join(configHome, "taproot-site"), { recursive: true });
  await writeFile(
    path.join(configHome, "taproot-site", "settings.json"),
    `${JSON.stringify({ schemaVersion: 1, apiBaseUrl: API_BASE_URL })}\n`,
  );
  return {
    root,
    project,
    configHome,
    configPath: path.join(project, "taproot-site.json"),
    environment: { XDG_CONFIG_HOME: configHome },
    storePath: path.join(configHome, "taproot-site", "credentials.json"),
    storeDirectory: path.join(configHome, "taproot-site"),
  };
}

function jsonResponse(value, httpStatus = 200) {
  return new Response(JSON.stringify(value), {
    status: httpStatus,
    headers: { "content-type": "application/json" },
  });
}

function api(routes) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init = {}) => {
      const target = new URL(url);
      const method = init.method ?? "GET";
      const call = {
        method,
        pathname: target.pathname,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
        headers: init.headers,
      };
      calls.push(call);
      for (const route of routes) {
        if (route.method !== method) continue;
        const matches = typeof route.pathname === "string"
          ? route.pathname === target.pathname
          : route.pathname.test(target.pathname);
        if (!matches) continue;
        const value = typeof route.reply === "function" ? route.reply(call, calls) : route.reply;
        return value instanceof Response ? value : jsonResponse(value);
      }
      throw new Error(`unrouted ${method} ${target.pathname}`);
    },
  };
}

function clock(start = 1_700_000_000_000) {
  let value = start;
  return {
    now: () => value,
    sleep: async (milliseconds) => {
      value += milliseconds;
    },
  };
}

function invoke(site, wire, extra = {}) {
  const progress = [];
  const timing = clock();
  return {
    progress,
    timing,
    invocation: {
      cwd: site.project,
      configPath: site.configPath,
      environment: site.environment,
      quiet: false,
      onProgress: (message) => progress.push(message),
      fetch: wire.fetch,
      sleep: timing.sleep,
      now: timing.now,
      timeoutSignal: () => new AbortController().signal,
      ...extra,
    },
  };
}

/** The start route every login scenario shares. */
function startRoute(overrides = {}) {
  return {
    method: "POST",
    pathname: START_PATH,
    reply: {
      deviceCode: DEVICE_CODE,
      userCode: USER_CODE,
      expiresInSeconds: 900,
      pollIntervalSeconds: 5,
      ...overrides,
    },
  };
}

/** A claim route that answers with each supplied value in turn, repeating the last. */
function claimRoute(...answers) {
  let index = 0;
  return {
    method: "POST",
    pathname: CLAIM_PATH,
    reply: () => {
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      return typeof answer === "function" ? answer() : answer;
    },
  };
}

async function storeContents(site) {
  try {
    return JSON.parse(await readFile(site.storePath, "utf8"));
  } catch {
    return undefined;
  }
}

async function seedCredential(site, overrides = {}) {
  return await saveCredential(
    site.environment,
    {
      apiOrigin: API_ORIGIN,
      accountId: ACCOUNT_ID,
      key: STORED_KEY,
      keyId: KEY_ID,
      keyPrefix: KEY_PREFIX,
      ...overrides,
    },
    { now: () => 1_700_000_000_000 },
  );
}

// ---------------------------------------------------------------------------
// login: the approved path
// ---------------------------------------------------------------------------

test("login stores an approved credential and never emits the secret or the device code", async (testContext) => {
  const site = await fixture(testContext);
  const outputPath = path.join(site.root, "github-output");
  await writeFile(outputPath, "");
  const wire = api([startRoute(), claimRoute(PENDING, PENDING, ISSUED)]);

  let stdout = "";
  let stderr = "";
  const exitCode = await runCli({
    arguments_: ["--config", site.configPath, "login", "--name", "Laptop CLI"],
    environment: { ...site.environment, GITHUB_OUTPUT: outputPath },
    cwd: site.project,
    stdout: { write: (chunk) => (stdout += chunk) },
    stderr: { write: (chunk) => (stderr += chunk) },
    fetch: wire.fetch,
  });

  assert.equal(exitCode, 0, stderr);
  const result = JSON.parse(stdout);
  assert.deepEqual(result, {
    schemaVersion: 1,
    ok: true,
    cli: { name: "@taprootio/site-authoring", version: "0.1.1" },
    verb: "login",
    accountId: ACCOUNT_ID,
    keyId: KEY_ID,
    keyPrefix: KEY_PREFIX,
    keyExpiresAt: KEY_EXPIRES_AT,
    userCode: USER_CODE,
    verificationUrl: VERIFICATION_URL,
    credentialPath: site.storePath,
  });

  // The stored record carries the key; every emitted surface does not.
  const stored = await storeContents(site);
  assert.equal(stored.schemaVersion, 2);
  assert.deepEqual(stored.credentials, [{
    apiOrigin: API_ORIGIN,
    accountId: ACCOUNT_ID,
    key: RAW_KEY,
    keyId: KEY_ID,
    keyPrefix: KEY_PREFIX,
    keyExpiresAt: KEY_EXPIRES_AT,
    createdAt: stored.credentials[0].createdAt,
  }]);
  const emitted = `${stdout}${stderr}${await readFile(outputPath, "utf8")}`;
  for (const secret of [RAW_KEY, DEVICE_CODE]) {
    assert.doesNotMatch(emitted, new RegExp(secret, "u"), `emitted ${secret}`);
  }

  // The hand-off the operator actually needs, on the human channel: the code
  // first, then the bare approval URL — no embedded code, because the owner
  // must type it. runCli's stdin is not a TTY here, so this is the
  // non-interactive shape, which must print the URL rather than wait for an
  // Enter nobody is there to press.
  assert.match(stderr, new RegExp(`First, copy this code: ${USER_CODE}`, "u"));
  assert.ok(stderr.includes(`Then open this URL in a browser signed in to Taproot: ${VERIFICATION_URL}`));
  assert.doesNotMatch(stderr, /authorize-cli\?/u);
  assert.doesNotMatch(stderr, /Press Enter/u);
  assert.match(stderr, /'Laptop CLI'/u);

  // The poll ran twice before ISSUED and said nothing either time: a line per
  // tick would scroll the code out of view over fifteen minutes.
  assert.doesNotMatch(stderr, /Still waiting/u);

  // Unauthenticated on the wire, and asking for exactly what the contract says.
  const start = wire.calls.find((call) => call.pathname === START_PATH);
  assert.equal(Object.hasOwn(start.headers, "authorization"), false);
  assert.deepEqual(start.body, { keyName: "Laptop CLI" });
  for (const claim of wire.calls.filter((call) => call.pathname === CLAIM_PATH)) {
    assert.equal(Object.hasOwn(claim.headers, "authorization"), false);
    assert.deepEqual(claim.body, { deviceCode: DEVICE_CODE });
  }
});

test("login writes the store with a 0700 directory and a 0600 file", async (testContext) => {
  const site = await fixture(testContext);
  const wire = api([startRoute(), claimRoute(ISSUED)]);
  const { invocation } = invoke(site, wire, { verb: "login" });
  await login(invocation);

  if (process.platform === "win32") return; // POSIX modes are advisory here.
  assert.equal((await stat(site.storeDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(site.storePath)).mode & 0o777, 0o600);
});

test("login defaults the key name and omits an absent expiry", async (testContext) => {
  const site = await fixture(testContext);
  const { keyExpiresAt: _dropped, ...neverExpires } = ISSUED;
  const wire = api([startRoute(), claimRoute(neverExpires)]);
  const { invocation, progress } = invoke(site, wire, { verb: "login" });

  const result = await login(invocation);
  assert.equal(result.keyExpiresAt, undefined);
  assert.equal(
    wire.calls.find((call) => call.pathname === START_PATH).body.keyName,
    "Site authoring CLI",
  );
  const stored = await storeContents(site);
  assert.equal(Object.hasOwn(stored.credentials[0], "keyExpiresAt"), false);
  assert.doesNotMatch(progress.join("\n"), new RegExp(RAW_KEY, "u"));
});

test("login replaces only the sign-in for its own origin", async (testContext) => {
  const site = await fixture(testContext);
  await seedCredential(site);
  await seedCredential(site, { apiOrigin: OTHER_API_ORIGIN, key: `${STORED_KEY}-other` });
  const wire = api([startRoute(), claimRoute(ISSUED)]);
  const { invocation } = invoke(site, wire, { verb: "login" });

  await login(invocation);
  const stored = await storeContents(site);
  // One sign-in per Taproot: logging in to one leaves the other alone.
  assert.equal(stored.credentials.length, 2);
  assert.equal(stored.credentials.find((entry) => entry.apiOrigin === API_ORIGIN).key, RAW_KEY);
  assert.equal(
    stored.credentials.find((entry) => entry.apiOrigin === OTHER_API_ORIGIN).key,
    `${STORED_KEY}-other`,
  );
});

test("an approval that lands at the deadline is stored, never reported as a timeout", async (testContext) => {
  const site = await fixture(testContext);
  let advancePastDeadline = () => {};
  const wire = api([
    startRoute(),
    claimRoute(PENDING, () => {
      // The response arrives after the wall deadline passed mid-request — the
      // moment the server has already consumed the authorization and minted.
      // Discarding an ISSUED answer already in hand as a timeout would orphan
      // the key; the answer must be honored however late it landed.
      advancePastDeadline();
      return ISSUED;
    }),
  ]);
  const { invocation, timing } = invoke(site, wire, { verb: "login" });
  advancePastDeadline = () => {
    timing.sleep(20 * 60_000);
  };

  const result = await login(invocation);
  assert.equal(result.keyId, KEY_ID);
  const stored = await storeContents(site);
  assert.equal(stored.credentials.length, 1);
  assert.equal(stored.credentials[0].key, RAW_KEY);
});

// ---------------------------------------------------------------------------
// login: every way it can end without a credential
// ---------------------------------------------------------------------------

test("login maps each terminal outcome to a stable code and stores nothing", async (testContext) => {
  const outcomes = [
    { name: "denied", answer: { status: "CLI_AUTHORIZATION_CLAIM_STATUS_DENIED" }, code: "login.denied" },
    { name: "expired", answer: { status: "CLI_AUTHORIZATION_CLAIM_STATUS_EXPIRED" }, code: "login.expired" },
    {
      name: "consumed",
      answer: { status: "CLI_AUTHORIZATION_CLAIM_STATUS_CONSUMED" },
      code: "login.consumed",
      // The one outcome that leaves a live credential nobody holds. The message
      // has to say that a key exists and name where to revoke it.
      message: /credential WAS issued.*Revoke the credential.*Settings -> API keys/su,
    },
    {
      name: "unknown device code",
      answer: () => jsonResponse({ code: 5, message: "Not found." }, 404),
      code: "login.unknown",
    },
  ];
  for (const outcome of outcomes) {
    await testContext.test(outcome.name, async (subContext) => {
      const site = await fixture(subContext);
      const wire = api([startRoute(), claimRoute(outcome.answer)]);
      const { invocation } = invoke(site, wire, { verb: "login" });
      await assert.rejects(login(invocation), (error) => {
        assert.equal(error.code, outcome.code);
        if (outcome.message) assert.match(error.message, outcome.message);
        return true;
      });
      assert.equal(await storeContents(site), undefined, "nothing may be stored");
    });
  }
});

test("login gives up on its own deadline with login.timeout and stores nothing", async (testContext) => {
  const site = await fixture(testContext);
  const wire = api([startRoute(), claimRoute(PENDING)]);
  const { invocation, timing, progress } = invoke(site, wire, { verb: "login" });

  await assert.rejects(login(invocation), (error) => error?.code === "login.timeout");
  assert.equal(await storeContents(site), undefined);
  // The wait is bounded by the authorization the server issued, on the virtual
  // clock: a 900-second window at a 5-second cadence, and not one poll more.
  assert.equal(timing.now(), 1_700_000_000_000 + 900_000);
  assert.ok(wire.calls.filter((call) => call.pathname === CLAIM_PATH).length <= 181);
  // 180 silent polls: the progress lines are the hand-off and the deadline, and
  // nothing that would scroll the code away while the operator reads it.
  assert.deepEqual(progress.filter((line) => /waiting|Waiting/u.test(line)), [
    "Waiting for approval. This request expires in about 15 minutes; press Ctrl+C to stop.",
  ]);
});

test("the hand-off puts the code first and opens the page only once Enter is pressed", async (testContext) => {
  const site = await fixture(testContext);
  const wire = api([startRoute(), claimRoute(ISSUED)]);
  const opened = [];
  let enterPressedBeforeOpen;
  const { invocation, progress } = invoke(site, wire, {
    verb: "login",
    awaitEnter: async () => true,
    openUrl: async (url) => {
      // The code has to be on screen before the browser takes the foreground —
      // that ordering is the whole point of copying it first.
      enterPressedBeforeOpen = progress.some((line) => line.includes(`First, copy this code: ${USER_CODE}`));
      opened.push(url);
    },
  });

  await login(invocation);

  assert.deepEqual(opened, [VERIFICATION_URL]);
  assert.equal(enterPressedBeforeOpen, true);
  // The bare approval page: a prefilled code would reduce approval to one click
  // on a link, which is exactly what typed entry exists to prevent.
  assert.doesNotMatch(opened[0], /\?/u);
  assert.ok(progress.some((line) => line === `Opened ${VERIFICATION_URL}`));
});

test("a browser that will not open leaves the operator the URL, not just a code", async (testContext) => {
  const site = await fixture(testContext);
  const wire = api([startRoute(), claimRoute(ISSUED)]);
  const { invocation, progress } = invoke(site, wire, {
    verb: "login",
    awaitEnter: async () => true,
    openUrl: async () => {
      throw new Error("no opener on this machine");
    },
  });

  // Stranding someone with a code and nowhere to type it is the one outcome
  // this path must not have.
  await login(invocation);
  assert.ok(progress.some((line) => line.includes(`Could not open a browser. Open this URL yourself: ${VERIFICATION_URL}`)));
});

/**
 * Two claim failures that both keep the poll alive, and differ in the one
 * thing that matters at the deadline: whether a credential may exist. A
 * certificate the machine does not trust means the claim never left it, so
 * the timeout must not send the operator to Settings to revoke a credential
 * that provably was not minted. A connection reset mid-flight may have
 * carried the mint, and must.
 */
function claimThatThrows(causeCode) {
  return {
    method: "POST",
    pathname: CLAIM_PATH,
    reply: () => {
      const error = new TypeError("fetch failed");
      error.cause = Object.assign(new Error("underlying"), { code: causeCode });
      throw error;
    },
  };
}

test("a claim that never reached Taproot keeps polling and does not arm the orphan warning", async (testContext) => {
  const site = await fixture(testContext);
  const wire = api([startRoute(), claimThatThrows("UNABLE_TO_VERIFY_LEAF_SIGNATURE")]);
  const { invocation } = invoke(site, wire, { verb: "login" });

  await assert.rejects(login(invocation), (error) =>
    error?.code === "login.timeout"
    && !/MAY have been issued/u.test(error.message)
    && /Nothing was stored/u.test(error.message));
  // It kept trying for the whole window rather than aborting on the first
  // refusal: the approval may still have been coming.
  assert.ok(wire.calls.filter((call) => call.pathname === CLAIM_PATH).length > 1);
  assert.equal(await storeContents(site), undefined);
});

test("a claim that died in flight keeps polling and does arm the orphan warning", async (testContext) => {
  const site = await fixture(testContext);
  const wire = api([startRoute(), claimThatThrows("ECONNRESET")]);
  const { invocation } = invoke(site, wire, { verb: "login" });

  await assert.rejects(login(invocation), (error) =>
    error?.code === "login.timeout" && /MAY have been issued/u.test(error.message));
  assert.ok(wire.calls.filter((call) => call.pathname === CLAIM_PATH).length > 1);
  assert.equal(await storeContents(site), undefined);
});

test("a claim that reset once and then never arrived still arms the orphan warning", async (testContext) => {
  // The transport retries the claim. If its first send died after reaching
  // Taproot and its retry failed a handshake, the last error says "undelivered"
  // — but the first one may have minted. The operator must be sent to look.
  const site = await fixture(testContext);
  let attempts = 0;
  const wire = api([startRoute(), {
    method: "POST",
    pathname: CLAIM_PATH,
    reply: () => {
      attempts += 1;
      const error = new TypeError("fetch failed");
      error.cause = Object.assign(new Error("underlying"), {
        code: attempts % 2 === 1 ? "ECONNRESET" : "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      });
      throw error;
    },
  }]);
  const { invocation } = invoke(site, wire, { verb: "login" });

  await assert.rejects(login(invocation), (error) =>
    error?.code === "login.timeout" && /MAY have been issued/u.test(error.message));
  assert.equal(await storeContents(site), undefined);
});

test("a claim answered 2xx unreadably and then never delivered still arms the orphan warning", async (testContext) => {
  // The server said success — the mint committed — and the body could not be
  // read. Every retry then fails a handshake. Nothing about the last error
  // says a credential exists; the first answer already did.
  const site = await fixture(testContext);
  let attempts = 0;
  const wire = api([startRoute(), {
    method: "POST",
    pathname: CLAIM_PATH,
    reply: () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("this is not json", { status: 200, headers: { "content-type": "application/json" } });
      }
      const error = new TypeError("fetch failed");
      error.cause = Object.assign(new Error("underlying"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
      throw error;
    },
  }]);
  const { invocation } = invoke(site, wire, { verb: "login" });

  await assert.rejects(login(invocation), (error) =>
    error?.code === "login.timeout" && /MAY have been issued/u.test(error.message));
  assert.equal(await storeContents(site), undefined);
});

test("login floors a too-fast poll interval and caps a too-long expiry", async (testContext) => {
  const site = await fixture(testContext);
  // A server that asks to be polled every zero-point-something seconds for two
  // hours gets the CLI's own walls instead.
  const wire = api([
    startRoute({ expiresInSeconds: 3_600, pollIntervalSeconds: 1 }),
    claimRoute(PENDING),
  ]);
  const { invocation, timing } = invoke(site, wire, { verb: "login" });

  await assert.rejects(login(invocation), (error) => error?.code === "login.timeout");
  // Capped at the 30-minute maximum, polled no faster than every 2 seconds.
  assert.equal(timing.now(), 1_700_000_000_000 + 30 * 60_000);
  assert.ok(wire.calls.filter((call) => call.pathname === CLAIM_PATH).length <= 901);
});

test("login keeps polling through a rate limit instead of failing on it", async (testContext) => {
  const site = await fixture(testContext);
  let claims = 0;
  const wire = api([
    startRoute(),
    {
      method: "POST",
      pathname: CLAIM_PATH,
      reply: () => {
        claims += 1;
        if (claims <= 4) return jsonResponse({ code: 8, message: "slow down" }, 429);
        return jsonResponse(ISSUED);
      },
    },
  ]);
  const { invocation, progress } = invoke(site, wire, { verb: "login" });

  const result = await login(invocation);
  assert.equal(result.keyId, KEY_ID);
  assert.ok(progress.some((line) => line.includes("rate limiting the check")));
  assert.equal((await storeContents(site)).credentials[0].key, RAW_KEY);
});

test("login keeps polling through a lost claim response and surfaces the consumed answer", async (testContext) => {
  const site = await fixture(testContext);
  let claimAttempts = 0;
  const wire = api([
    startRoute(),
    {
      method: "POST",
      pathname: CLAIM_PATH,
      reply: () => {
        // The first claim's every transport attempt dies on the wire — the
        // shape of a connectivity blip whose lost response may have committed
        // the mint. The login must keep polling; the next answer is CONSUMED,
        // which carries the revoke guidance the owner needs. Aborting on the
        // network error would hide that key entirely.
        claimAttempts += 1;
        if (claimAttempts <= 4) throw new Error("connection reset");
        return { status: "CLI_AUTHORIZATION_CLAIM_STATUS_CONSUMED" };
      },
    },
  ]);
  const { invocation, progress } = invoke(site, wire, { verb: "login" });

  await assert.rejects(
    login(invocation),
    (error) => error?.code === "login.consumed" && error.message.includes("Revoke the credential"),
  );
  assert.ok(progress.some((line) => line.includes("answer was lost")));
  assert.equal(await storeContents(site), undefined);
});

test("an unusable ISSUED payload keeps polling and the consumed answer names the exact key", async (testContext) => {
  const site = await fixture(testContext);
  const wire = api([
    startRoute(),
    // The server said ISSUED — the mint committed — but the payload is
    // unusable. Aborting on it would hide the key; the next claim's CONSUMED
    // answer carries the minted key's identity, and the guidance names it by
    // id rather than by its non-unique display name.
    claimRoute(
      { ...ISSUED, rawKey: "" },
      { status: "CLI_AUTHORIZATION_CLAIM_STATUS_CONSUMED", keyId: KEY_ID, keyPrefix: KEY_PREFIX },
    ),
  ]);
  const { invocation } = invoke(site, wire, { verb: "login" });

  await assert.rejects(
    login(invocation),
    (error) =>
      error?.code === "login.consumed"
      && error.message.includes(`credential with id ${KEY_ID}`)
      && error.message.includes(KEY_PREFIX)
      && !error.message.includes(RAW_KEY),
  );
  assert.equal(await storeContents(site), undefined);
});

test("an oversized claim response keeps polling instead of aborting", async (testContext) => {
  const site = await fixture(testContext);
  const wire = api([
    startRoute(),
    claimRoute(
      () =>
        jsonResponse({
          status: "CLI_AUTHORIZATION_CLAIM_STATUS_PENDING",
          padding: "x".repeat(1024 * 1024),
        }),
      { status: "CLI_AUTHORIZATION_CLAIM_STATUS_CONSUMED" },
    ),
  ]);
  const { invocation } = invoke(site, wire, { verb: "login" });

  await assert.rejects(login(invocation), (error) => error?.code === "login.consumed");
  assert.equal(await storeContents(site), undefined);
});

test("a cancellation while a claim is in flight names the possible orphan", async (testContext) => {
  const site = await fixture(testContext);
  const controller = new AbortController();
  const wire = api([
    startRoute(),
    claimRoute(() => {
      // Ctrl+C lands while the claim is on the wire: the interrupted response
      // may have been the one carrying the mint, and the cancellation message
      // must send the owner to look rather than saying nothing.
      controller.abort();
      return PENDING;
    }),
  ]);
  const { invocation } = invoke(site, wire, { verb: "login", signal: controller.signal });

  await assert.rejects(
    login(invocation),
    (error) =>
      error?.code === "site.cancelled"
      && error.message.includes("MAY have been issued")
      && error.message.includes("Site authoring CLI")
      && error.message.includes("API keys"),
  );
  assert.equal(await storeContents(site), undefined);
});

/**
 * Ctrl+C during the transport's backoff between claim attempts. Nothing is in
 * flight at that moment, so whether a credential may exist is entirely what
 * the attempts before it did — and the two cases below differ in exactly that.
 */
function loginCancelledDuringBackoff(site, firstCause) {
  const controller = new AbortController();
  const wire = api([startRoute(), {
    method: "POST",
    pathname: CLAIM_PATH,
    reply: () => {
      const error = new TypeError("fetch failed");
      error.cause = Object.assign(new Error("underlying"), { code: firstCause });
      throw error;
    },
  }]);
  const { invocation } = invoke(site, wire, {
    verb: "login",
    signal: controller.signal,
    // The first sleep the transport asks for is the backoff after the first
    // failed claim. Ctrl+C lands there.
    sleep: async () => {
      controller.abort();
      throw new SiteAuthoringError("site.cancelled", "cancelled during backoff");
    },
  });
  return invocation;
}

test("cancelling during backoff after only undelivered claim failures does not name an orphan", async (testContext) => {
  const site = await fixture(testContext);
  const invocation = loginCancelledDuringBackoff(site, "UNABLE_TO_VERIFY_LEAF_SIGNATURE");

  // No request ever reached Taproot, so no credential can exist. Sending the
  // operator to Settings to revoke one would be a lie in the costly direction.
  await assert.rejects(login(invocation), (error) =>
    error?.code === "site.cancelled" && !/MAY have been issued/u.test(error.message));
  assert.equal(await storeContents(site), undefined);
});

test("cancelling during backoff after a reset claim still names the possible orphan", async (testContext) => {
  const site = await fixture(testContext);
  const invocation = loginCancelledDuringBackoff(site, "ECONNRESET");

  // The positive control: the reset attempt may have minted, and the same
  // backoff cancellation must say so.
  await assert.rejects(login(invocation), (error) =>
    error?.code === "site.cancelled" && /MAY have been issued/u.test(error.message));
  assert.equal(await storeContents(site), undefined);
});

test("login keeps polling through an unreadable claim body and surfaces the consumed answer", async (testContext) => {
  const site = await fixture(testContext);
  let claimAttempts = 0;
  const wire = api([
    startRoute(),
    {
      method: "POST",
      pathname: CLAIM_PATH,
      reply: () => {
        // A 2xx whose body cannot be parsed is the same shape of loss as a
        // dead connection: the server answered — possibly with the mint — and
        // this side could not read it. The poll must continue.
        claimAttempts += 1;
        if (claimAttempts <= 4) {
          return new Response("{ not json", { status: 200, headers: { "content-type": "application/json" } });
        }
        return { status: "CLI_AUTHORIZATION_CLAIM_STATUS_CONSUMED" };
      },
    },
  ]);
  const { invocation } = invoke(site, wire, { verb: "login" });

  await assert.rejects(login(invocation), (error) => error?.code === "login.consumed");
  assert.equal(await storeContents(site), undefined);
});

test("a timeout after a lost claim answer says a credential may exist and where to look", async (testContext) => {
  const site = await fixture(testContext);
  const wire = api([
    startRoute(),
    {
      method: "POST",
      pathname: CLAIM_PATH,
      reply: () => {
        throw new Error("connection reset");
      },
    },
  ]);
  const { invocation } = invoke(site, wire, { verb: "login" });

  await assert.rejects(
    login(invocation),
    (error) =>
      error?.code === "login.timeout"
      && error.message.includes("MAY have been issued")
      && error.message.includes("Site authoring CLI")
      && error.message.includes("API keys"),
  );
  assert.equal(await storeContents(site), undefined);
});

test("login refuses a malformed start contract before it can store anything", async (testContext) => {
  const cases = [
    { name: "short device code", start: { deviceCode: "too-short" } },
    { name: "malformed user code", start: { userCode: "nope" } },
    { name: "zero expiry", start: { expiresInSeconds: 0 } },
    { name: "unbounded expiry", start: { expiresInSeconds: 86_400 } },
  ];
  for (const scenario of cases) {
    await testContext.test(scenario.name, async (subContext) => {
      const site = await fixture(subContext);
      const wire = api([startRoute(scenario.start), claimRoute(ISSUED)]);
      const { invocation } = invoke(site, wire, { verb: "login" });
      await assert.rejects(login(invocation), (error) => error?.code === "login.start_contract");
      assert.equal(await storeContents(site), undefined);
    });
  }
});

test("an unreadable claim answer keeps polling as an ambiguous issuance", async (testContext) => {
  // A serializer fault or version skew — a newer server adding a status value,
  // an envelope this vocabulary cannot read, a body with no status at all
  // (proto3 omits the zero enum, so absence is never "still pending") — can
  // follow a committed mint. None of them may abort behind a generic error;
  // the next readable answer is CONSUMED, which carries the revoke guidance.
  const cases = [
    { name: "absent status", answer: {} },
    { name: "unsupported status", answer: { status: "CLI_AUTHORIZATION_CLAIM_STATUS_SOMETHING_NEW" } },
    { name: "non-object envelope", answer: () => jsonResponse([]) },
    // The transport's own retries burn out on the 5xx storm first; the final
    // attempt surfaces the ApiError, which must also read as a lost answer.
    // The call count pins that the backoff actually ran: one poll read burns
    // the whole per-request budget before the loss surfaces, and the next
    // read's first call is the CONSUMED — so the claim must stay a replayable
    // POST and 500 a retryable status for this to hold.
    {
      name: "repeated 500s",
      answer: () => jsonResponse({ code: 13, message: "boom" }, 500),
      expectedClaimCalls: LIMITS.requestAttempts + 1,
    },
  ];
  for (const scenario of cases) {
    await testContext.test(scenario.name, async (subContext) => {
      const site = await fixture(subContext);
      const wire = api([
        startRoute(),
        claimRoute(
          scenario.answer,
          scenario.answer,
          scenario.answer,
          scenario.answer,
          { status: "CLI_AUTHORIZATION_CLAIM_STATUS_CONSUMED", keyId: KEY_ID, keyPrefix: KEY_PREFIX },
        ),
      ]);
      const { invocation } = invoke(site, wire, { verb: "login" });

      await assert.rejects(
        login(invocation),
        (error) => error?.code === "login.consumed" && error.message.includes(`credential with id ${KEY_ID}`),
      );
      if (scenario.expectedClaimCalls !== undefined) {
        assert.equal(
          wire.calls.filter((call) => call.pathname === CLAIM_PATH).length,
          scenario.expectedClaimCalls,
        );
      }
      assert.equal(await storeContents(site), undefined);
    });
  }
});

test("a readable PENDING clears the lost-answer ambiguity for the timeout", async (testContext) => {
  const site = await fixture(testContext);
  // Read one loses its answer; read two gets a readable PENDING — proof the
  // lost claim minted nothing, because a consumed record can never answer
  // PENDING. The eventual timeout must speak plainly, not warn about a
  // credential that provably does not exist.
  let claimCalls = 0;
  const wire = api([
    startRoute(),
    {
      method: "POST",
      pathname: CLAIM_PATH,
      reply: () => {
        claimCalls += 1;
        if (claimCalls <= LIMITS.requestAttempts) return jsonResponse({ code: 13, message: "boom" }, 500);
        return PENDING;
      },
    },
  ]);
  const { invocation, progress } = invoke(site, wire, { verb: "login" });

  await assert.rejects(login(invocation), (error) => {
    assert.equal(error.code, "login.timeout");
    assert.doesNotMatch(error.message, /MAY have been issued/u);
    return true;
  });
  // The loss half is pinned positively: without this line the test would
  // also pass on a run that never lost anything, covering no reset at all.
  assert.ok(progress.some((line) => line.includes("answer was lost")));
  assert.equal(await storeContents(site), undefined);
});

test("a loss after the last PENDING re-arms the possible-orphan warning", async (testContext) => {
  const site = await fixture(testContext);
  // The inverse ordering the reset depends on: PENDING first (nothing to
  // clear), then every later answer is lost. The final timeout must carry
  // the MAY-have-been-issued guidance — one of those post-PENDING losses may
  // have been the mint.
  let claimCalls = 0;
  const wire = api([
    startRoute(),
    {
      method: "POST",
      pathname: CLAIM_PATH,
      reply: () => {
        claimCalls += 1;
        if (claimCalls === 1) return PENDING;
        return jsonResponse({ code: 13, message: "boom" }, 500);
      },
    },
  ]);
  const { invocation } = invoke(site, wire, { verb: "login" });

  await assert.rejects(login(invocation), (error) => {
    assert.equal(error.code, "login.timeout");
    assert.match(error.message, /MAY have been issued/u);
    return true;
  });
  assert.equal(await storeContents(site), undefined);
});

test("a readable PENDING clears the lost-answer ambiguity for a cancellation", async (testContext) => {
  const site = await fixture(testContext);
  let claimCalls = 0;
  const wire = api([
    startRoute(),
    {
      method: "POST",
      pathname: CLAIM_PATH,
      reply: () => {
        claimCalls += 1;
        if (claimCalls <= LIMITS.requestAttempts) return jsonResponse({ code: 13, message: "boom" }, 500);
        return PENDING;
      },
    },
  ]);
  let innerSleep = async () => {};
  const { invocation, timing } = invoke(site, wire, {
    verb: "login",
    sleep: async (milliseconds, signal) => innerSleep(milliseconds, signal),
  });
  // Sleeps 1-3 are the transport's backoffs inside the lost read; sleep 4 is
  // the inter-poll wait before the PENDING read; sleep 5 follows the PENDING
  // that cleared the ambiguity — the cancellation lands there and must keep
  // the generic sentence.
  let sleeps = 0;
  innerSleep = async (milliseconds) => {
    sleeps += 1;
    if (sleeps >= LIMITS.requestAttempts + 1) {
      throw new SiteAuthoringError("site.cancelled", "The Taproot site authoring command was cancelled.");
    }
    await timing.sleep(milliseconds);
  };

  await assert.rejects(login(invocation), (error) => {
    assert.equal(error.code, "site.cancelled");
    assert.doesNotMatch(error.message, /MAY have been issued/u);
    return true;
  });
  assert.equal(await storeContents(site), undefined);
});

test("a cancellation between polls after a lost answer still names the possible orphan", async (testContext) => {
  const site = await fixture(testContext);
  // Read one loses its answer to a 500 storm (three transport backoffs, then
  // the surfaced ApiError marks the loss); the cancellation then lands in
  // poll()'s own inter-poll sleep — the fourth sleep — which never passes
  // through the claim's error handling at all. The upgrade must still fire.
  const wire = api([
    startRoute(),
    claimRoute(() => jsonResponse({ code: 13, message: "boom" }, 500)),
  ]);
  let innerSleep = async () => {};
  const { invocation, timing } = invoke(site, wire, {
    verb: "login",
    sleep: async (milliseconds, signal) => innerSleep(milliseconds, signal),
  });
  let sleeps = 0;
  innerSleep = async (milliseconds) => {
    sleeps += 1;
    if (sleeps >= LIMITS.requestAttempts) {
      throw new SiteAuthoringError("site.cancelled", "The Taproot site authoring command was cancelled.");
    }
    await timing.sleep(milliseconds);
  };

  await assert.rejects(
    login(invocation),
    (error) =>
      error?.code === "site.cancelled"
      && error.message.includes("MAY have been issued")
      && error.message.includes("Site authoring CLI")
      && error.message.includes("API keys"),
  );
  assert.equal(await storeContents(site), undefined);
});

test("every unusable ISSUED field is an ambiguous issuance, not a contract abort", async (testContext) => {
  // By the time any of these fields is inspected the server has said ISSUED,
  // so the mint has committed. Aborting would hide the key; each case keeps
  // polling and the follow-up CONSUMED carries the revoke guidance.
  const cases = [
    { name: "malformed raw key", claim: { rawKey: "" } },
    { name: "malformed key id", claim: { keyId: "not-a-uuid" } },
    { name: "malformed key prefix", claim: { keyPrefix: "has spaces" } },
    { name: "malformed expiry", claim: { keyExpiresAt: "whenever" } },
  ];
  for (const scenario of cases) {
    await testContext.test(scenario.name, async (subContext) => {
      const site = await fixture(subContext);
      const wire = api([
        startRoute(),
        claimRoute(
          { ...ISSUED, ...scenario.claim },
          { status: "CLI_AUTHORIZATION_CLAIM_STATUS_CONSUMED" },
        ),
      ]);
      const { invocation } = invoke(site, wire, { verb: "login" });
      await assert.rejects(login(invocation), (error) => error?.code === "login.consumed");
      assert.equal(await storeContents(site), undefined);
    });
  }
});

test("login refuses an unusable --name as a usage fault before any request", async (testContext) => {
  for (
    const keyName of [
      "",
      "   ",
      "x".repeat(101),
      `name${String.fromCodePoint(7)}`,
      // Bidi override and isolate: text that can display other than as written.
      `name${String.fromCodePoint(0x20_2e)}`,
      `name${String.fromCodePoint(0x20_66)}`,
    ]
  ) {
    await testContext.test(JSON.stringify(keyName), async (subContext) => {
      const site = await fixture(subContext);
      const wire = api([]);
      const { invocation } = invoke(site, wire, { verb: "login", keyName });
      await assert.rejects(
        login(invocation),
        (error) => error?.code === "login.key_name_invalid" && error.exitCode === 2 && error.field === "keyName",
      );
      assert.equal(wire.calls.length, 0);
    });
  }
});

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

test("logout discards the sign-in for its own origin only", async (testContext) => {
  const site = await fixture(testContext);
  await seedCredential(site);
  await seedCredential(site, { apiOrigin: OTHER_API_ORIGIN, key: `${STORED_KEY}-other` });
  const { invocation, progress } = invoke(site, api([]), { verb: "logout" });

  const result = await logout(invocation);
  assert.equal(result.ok, true);
  assert.equal(result.verb, "logout");
  assert.equal(result.removed, true);
  assert.equal(result.credentialPath, site.storePath);
  const stored = await storeContents(site);
  assert.deepEqual(stored.credentials.map((entry) => entry.apiOrigin), [OTHER_API_ORIGIN]);
  // Local discard only; it must not imply the credential stopped working.
  assert.ok(progress.some((line) => line.includes("local discard only")));
  assert.doesNotMatch(`${JSON.stringify(result)}${progress.join("\n")}`, new RegExp(STORED_KEY, "u"));
});

test("logout with nothing stored succeeds and reports removed: false", async (testContext) => {
  const site = await fixture(testContext);
  let stdout = "";
  const exitCode = await runCli({
    arguments_: ["--config", site.configPath, "logout"],
    environment: site.environment,
    cwd: site.project,
    stdout: { write: (chunk) => (stdout += chunk) },
    stderr: { write: () => {} },
  });
  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(stdout).removed, false);
  assert.equal(await storeContents(site), undefined);
});

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

function statusRoutes() {
  return [
    exchangeRoute(),
    {
      method: "GET",
      pathname: READINESS,
      reply: { state: "PAGE_PUBLISHING_READINESS_STATE_READY", hasCandidateChanges: false, blockers: [] },
    },
    { method: "GET", pathname: DEPLOYMENTS, reply: { deployments: [], nextPageToken: "" } },
    { method: "GET", pathname: SITE_IMAGES, reply: { images: [], totalImages: 0, processingImages: 0, nextPageToken: "" } },
  ];
}

/**
 * The credential every *site* call in this run carried.
 *
 * Since TR00645 a run can legitimately carry two: the sign-in authorizes the
 * exchange, and the credential the exchange returns authorizes everything else.
 * The invariant worth asserting is still that the site calls all share one
 * credential — and, separately, that it is not the sign-in.
 */
function bearerOf(wire) {
  const siteCalls = wire.calls.filter((call) => call.pathname !== EXCHANGE_PATH);
  const authorizations = new Set(siteCalls.map((call) => call.headers.authorization));
  assert.equal(authorizations.size, 1, "one site credential per run");
  return [...authorizations][0];
}

/** The credential the exchange itself was authorized with. */
function exchangeBearerOf(wire) {
  const exchange = wire.calls.find((call) => call.pathname === EXCHANGE_PATH);
  return exchange?.headers?.authorization;
}

test("TAPROOT_SITE_KEY wins over a stored credential, byte for byte", async (testContext) => {
  const site = await fixture(testContext);
  await seedCredential(site);
  const wire = api(statusRoutes());
  const { invocation } = invoke(site, wire, {
    verb: "status",
    environment: { ...site.environment, TAPROOT_SITE_KEY: "tr_live_environment_wins" },
  });

  assert.equal((await status(invocation)).ok, true);
  assert.equal(bearerOf(wire), "Bearer tr_live_environment_wins");
});

test("the stored credential is used when the environment carries none", async (testContext) => {
  const site = await fixture(testContext);
  await seedCredential(site);
  const wire = api(statusRoutes());
  const { invocation } = invoke(site, wire, { verb: "status" });

  assert.equal((await status(invocation)).ok, true);
  // The sign-in buys a site credential; it never authors anything itself.
  assert.equal(exchangeBearerOf(wire), `Bearer ${STORED_KEY}`);
  assert.equal(bearerOf(wire), `Bearer ${EXCHANGED_KEY}`);
});

test("an empty environment key is authoritative and never falls back to the store", async (testContext) => {
  const site = await fixture(testContext);
  await seedCredential(site);
  const wire = api(statusRoutes());
  const { invocation } = invoke(site, wire, {
    verb: "status",
    environment: { ...site.environment, TAPROOT_SITE_KEY: "" },
  });

  // Presence is intent: CI that masked a missing secret into an empty string
  // meant the environment credential, and silently acting as the stored one
  // would run the command as a different identity. The value is rejected as
  // unusable instead.
  await assert.rejects(status(invocation), (error) => error?.code === "auth.key_invalid");
  assert.equal(wire.calls.length, 0);
});

test("a sign-in stored for another Taproot is never sent to this one", async (testContext) => {
  const site = await fixture(testContext);
  await seedCredential(site, { apiOrigin: OTHER_API_ORIGIN, key: `${STORED_KEY}-production` });
  const wire = api(statusRoutes());
  const { invocation } = invoke(site, wire, { verb: "status" });

  // Selection is by origin now, so the only way to be unauthenticated here is
  // to hold no sign-in for the origin the configuration names — and that must
  // be answered before any request leaves.
  await assert.rejects(status(invocation), (error) => error?.code === "auth.key_missing");
  assert.equal(wire.calls.length, 0);
});

test("with neither an environment key nor a stored one, the refusal names both remedies", async (testContext) => {
  const site = await fixture(testContext);
  const wire = api(statusRoutes());
  const { invocation } = invoke(site, wire, { verb: "status" });

  await assert.rejects(status(invocation), (error) => {
    assert.equal(error.code, "auth.key_missing");
    assert.match(error.message, /taproot-site login/u);
    assert.match(error.message, /TAPROOT_SITE_KEY/u);
    return true;
  });
  assert.equal(wire.calls.length, 0);
});

test("an expired stored credential is still sent, with the expiry said out loud", async (testContext) => {
  const site = await fixture(testContext);
  await seedCredential(site, { keyExpiresAt: "2020-01-01T00:00:00.000Z" });
  const wire = api(statusRoutes());
  const { invocation, progress } = invoke(site, wire, { verb: "status" });

  // The server is the authority on expiry — a local clock is not a reason to
  // refuse to try — but the operator is told why a refusal may follow.
  assert.equal((await status(invocation)).ok, true);
  assert.equal(exchangeBearerOf(wire), `Bearer ${STORED_KEY}`);
  assert.ok(progress.some((line) => line.includes("2020-01-01T00:00:00.000Z") && line.includes("taproot-site login")));
});

// ---------------------------------------------------------------------------
// The store itself
// ---------------------------------------------------------------------------

test("reading a store that does not exist is an empty store, not a failure", async (testContext) => {
  const site = await fixture(testContext);
  assert.deepEqual(await readCredentialStore(site.environment), { path: site.storePath, credentials: [] });
});

test("a symlinked credentials file is refused rather than followed", async (testContext) => {
  const site = await fixture(testContext);
  const elsewhere = path.join(site.root, "elsewhere.json");
  await writeFile(elsewhere, `${JSON.stringify({ schemaVersion: 1, credentials: [] })}\n`);
  await mkdir(site.storeDirectory, { recursive: true, mode: 0o700 });
  await symlink(elsewhere, site.storePath);

  await assert.rejects(
    readCredentialStore(site.environment),
    (error) => error?.code === "credentials.not_regular",
  );
  // And the refusal reaches the verbs that read it, rather than being swallowed.
  const { invocation } = invoke(site, api([]), { verb: "logout" });
  await assert.rejects(logout(invocation), (error) => error?.code === "credentials.not_regular");
});

test("a store that cannot be vouched for is refused with a stable code", async (testContext) => {
  const cases = [
    { name: "not JSON", contents: "{ not json", code: "credentials.invalid_json" },
    { name: "not an object", contents: "[]", code: "credentials.contract" },
    {
      // v1 is the pre-TR00645 per-site store. It is refused rather than
      // migrated: the CLI is unpublished, so the only v1 stores are local, and
      // a migration path would be code written for nobody.
      name: "unsupported version",
      contents: JSON.stringify({ schemaVersion: 1, credentials: [] }),
      code: "credentials.unsupported_version",
    },
    {
      name: "no credentials array",
      contents: JSON.stringify({ schemaVersion: 2 }),
      code: "credentials.contract",
    },
    {
      name: "malformed key",
      contents: JSON.stringify({
        schemaVersion: 2,
        credentials: [{
          apiOrigin: API_ORIGIN,
          accountId: ACCOUNT_ID,
          key: "",
          keyId: KEY_ID,
          keyPrefix: KEY_PREFIX,
          createdAt: "2026-08-30T00:00:00.000Z",
        }],
      }),
      code: "credentials.contract",
    },
  ];
  for (const scenario of cases) {
    await testContext.test(scenario.name, async (subContext) => {
      const site = await fixture(subContext);
      await mkdir(site.storeDirectory, { recursive: true, mode: 0o700 });
      await writeFile(site.storePath, scenario.contents);
      await assert.rejects(
        readCredentialStore(site.environment),
        // The refusal names the file it is about: login and logout fail through
        // the same store, and the path is what the operator repairs or removes.
        (error) => error?.code === scenario.code && error.message.includes(site.storePath),
      );
    });
  }
});

test("login refuses an unusable store before any request is made", async (testContext) => {
  const site = await fixture(testContext);
  await mkdir(site.storeDirectory, { recursive: true, mode: 0o700 });
  await symlink(path.join(site.root, "elsewhere.json"), site.storePath);
  const wire = api([]);
  const { invocation } = invoke(site, wire, { verb: "login" });

  // The refusal lands before start, where no credential exists to orphan.
  await assert.rejects(login(invocation), (error) => error?.code === "credentials.not_regular");
  assert.equal(wire.calls.length, 0);
});

test("login refuses a store with no room for the credential before minting one", async (testContext) => {
  const site = await fixture(testContext);

  // Fill to just under the reader's cap, directly rather than through
  // `saveCredential`, because the writer's own bound would refuse the last of
  // these and the shape under test is a store that reads back fine and simply
  // has no room left.
  const credentials = [];
  const size = () =>
    Buffer.byteLength(`${JSON.stringify({ schemaVersion: 2, credentials }, undefined, 2)}\n`, "utf8");
  for (let index = 0; size() < LIMITS.credentialsBytes - 1_400; index++) {
    credentials.push({
      apiOrigin: `https://${String(index).padStart(4, "0")}${"x".repeat(200)}.test`,
      accountId: ACCOUNT_ID,
      key: STORED_KEY,
      keyId: KEY_ID,
      keyPrefix: KEY_PREFIX,
      createdAt: "2023-11-14T22:13:20.000Z",
    });
  }
  await mkdir(site.storeDirectory, { recursive: true, mode: 0o700 });
  await writeFile(site.storePath, `${JSON.stringify({ schemaVersion: 2, credentials }, undefined, 2)}\n`, {
    mode: 0o600,
  });
  const before = await storeContents(site);

  const wire = api([startRoute(), claimRoute(ISSUED)]);
  const { invocation } = invoke(site, wire, { verb: "login" });

  await assert.rejects(login(invocation), (error) => error?.code === "credentials.too_large");
  // The whole value of projecting: nothing was minted, so there is no live
  // credential to go and revoke.
  assert.equal(wire.calls.length, 0);
  assert.deepEqual(await storeContents(site), before);
});

test("a claim that outruns the store surfaces the orphaned key with revoke guidance", async (testContext) => {
  const site = await fixture(testContext);
  // Readable but not writable: the preflight passes (nothing stored yet), the
  // claim mints, and only then does the write fail — the disk-full shape.
  // chmod rather than mkdir's mode, because the fixture already created this
  // directory for settings.json and mkdir would silently leave it writable.
  await mkdir(site.storeDirectory, { recursive: true });
  await chmod(site.storeDirectory, 0o500);
  // Restored in the body, not an `after` hook: the fixture's own recursive rm
  // is registered first and runs first, and it cannot unlink settings.json out
  // of a directory this test left read-only.
  testContext.after(() => chmod(site.storeDirectory, 0o700).catch(() => {}));
  const wire = api([startRoute(), claimRoute(ISSUED)]);
  const { invocation } = invoke(site, wire, { verb: "login" });

  await assert.rejects(
    login(invocation),
    (error) =>
      error?.code === "login.credential_unstored"
      && error.message.includes(KEY_ID)
      && error.message.includes(KEY_PREFIX)
      && error.message.includes("Revoke")
      && !error.message.includes(RAW_KEY)
      && !error.message.includes(DEVICE_CODE),
  );
  assert.equal(await storeContents(site), undefined);
  await chmod(site.storeDirectory, 0o700);
});

/**
 * The writer and the reader must agree on what is acceptable. TR00645 dropped
 * the record-count bound that used to keep the file under the reader's byte
 * cap, so the writer now checks the cap directly — the failure it prevents is
 * the worst shape available, a write that succeeds and a store that can never
 * be read again.
 *
 * Per-field bounds do most of the work: no single value can be large enough on
 * its own. What they cannot bound is how many origins accumulate, which is the
 * gap this closes.
 */
test("a store write that would exceed the read bound is refused, not written", async (testContext) => {
  const site = await fixture(testContext);
  await seedCredential(site);

  let refusal;
  for (let index = 0; index < 200 && refusal === undefined; index++) {
    try {
      await saveCredential(
        site.environment,
        {
          apiOrigin: `https://${String(index).padStart(4, "0")}${"x".repeat(1_900)}.test`,
          accountId: ACCOUNT_ID,
          key: STORED_KEY,
          keyId: KEY_ID,
          keyPrefix: KEY_PREFIX,
        },
        { now: () => 1_700_000_000_000 },
      );
    } catch (error) {
      refusal = error;
    }
  }

  assert.equal(refusal?.code, "credentials.too_large");
  // And the store the refusal protected is still readable, which is the whole
  // point: a partial write here would have bricked every later command.
  const stored = await readCredentialStore(site.environment);
  assert.ok(stored.credentials.some((entry) => entry.apiOrigin === API_ORIGIN));
});

test("the store location follows the injected environment, not the process", async (testContext) => {
  const site = await fixture(testContext);
  const home = path.join(site.root, "home");
  await mkdir(home, { recursive: true });

  // XDG_CONFIG_HOME first, then HOME/.config. Neither reads process.env.
  assert.equal(
    (await readCredentialStore({ XDG_CONFIG_HOME: site.configHome })).path,
    path.join(site.configHome, "taproot-site", "credentials.json"),
  );
  assert.equal(
    (await readCredentialStore({ HOME: home })).path,
    path.join(home, ".config", "taproot-site", "credentials.json"),
  );
  // A relative or unprintable value is not a directory; it falls through.
  assert.equal(
    (await readCredentialStore({ XDG_CONFIG_HOME: "relative/path", HOME: home })).path,
    path.join(home, ".config", "taproot-site", "credentials.json"),
  );
});
