import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { claimCliAuthorization, startCliAuthorization } from "../src/api.js";
import { CAPABILITY_LEGAL_DRAFTS, SITE_AUTHORING_CAPABILITIES } from "../src/capabilities.js";
import { runCli } from "../src/cli.js";
import { SiteAuthoringError } from "../src/errors.js";
import { ApiError } from "../src/transport.js";
import { findCredential, readCredentialStore, saveCredential, updateCredentialMetadata } from "../src/credentials.js";
import { openSession } from "../src/session.js";
import { login } from "../src/verbs/login.js";
import { logout } from "../src/verbs/logout.js";

const SITE = "aaaa1111-bbbb-4111-8111-cccc11111111";
const OTHER_SITE = "bbbb2222-cccc-4222-8222-dddd22222222";
const ACCOUNT = "eeee5555-ffff-4555-8555-aaaa55555555";
const KEY_ID = "dddd4444-eeee-4444-8444-ffff44444444";
const ORIGIN = "https://app.taproot.test";
const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const SECRET = "tr_live_legal_secret_never_display_this_value";
const DEVICE = "D".repeat(43);
const CAPS = [...SITE_AUTHORING_CAPABILITIES, CAPABILITY_LEGAL_DRAFTS];
const issued = {
  status: "CLI_AUTHORIZATION_CLAIM_STATUS_ISSUED", rawKey: SECRET, keyId: KEY_ID,
  keyPrefix: "tr_live_test...", accountId: ACCOUNT, keyExpiresAt: "2026-10-29T12:00:00.000Z",
  legalDraftSiteId: SITE, capabilities: CAPS, legalDraftPlatformSite: true,
};

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "taproot-legal-login-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { XDG_CONFIG_HOME: root };
  const directory = path.join(root, "taproot-site");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "settings.json"), JSON.stringify({ schemaVersion: 1, apiBaseUrl: `${ORIGIN}/api` }));
  const config = { siteId: SITE, authoringSurface: "standard" };
  return { environment, config, store: path.join(directory, "credentials.json"), invocation: {
    environment, resolvedConfig: config, now: () => NOW, onProgress: () => {},
  } };
}

function account() {
  return { apiOrigin: ORIGIN, accountId: ACCOUNT, key: "tr_live_existing_account_secret", keyId: KEY_ID, keyPrefix: "tr_live_account...", createdAt: new Date(NOW).toISOString() };
}
function legal(siteId = SITE) {
  return { apiOrigin: ORIGIN, accountId: ACCOUNT, key: SECRET, keyId: KEY_ID, keyPrefix: "tr_live_legal...", keyExpiresAt: issued.keyExpiresAt, purpose: "legal-drafts", siteId, capabilities: CAPS, legalDraftPlatformSite: true };
}
function clientFor(response = issued) {
  const starts = [];
  return { starts, request: async (_path, options) => {
    starts.push(options.body);
    return { deviceCode: DEVICE, userCode: "BCDF-2345", expiresInSeconds: 900, pollIntervalSeconds: 5, legalDraftSiteId: SITE };
  }, replaceablePost: async () => response };
}

test("v2 account records migrate without mixing legal sites or losing CAS metadata", async (t) => {
  const f = await fixture(t);
  await writeFile(f.store, JSON.stringify({ schemaVersion: 2, credentials: [account()] }));
  await saveCredential(f.environment, legal(), { now: () => NOW });
  await saveCredential(f.environment, legal(OTHER_SITE), { now: () => NOW });
  assert.equal(JSON.parse(await readFile(f.store, "utf8")).schemaVersion, 3);
  assert.equal((await findCredential(f.environment, ORIGIN)).credential.key, account().key);
  assert.equal((await findCredential(f.environment, ORIGIN, { siteId: SITE })).credential.key, SECRET);
  assert.equal(await updateCredentialMetadata(f.environment, ORIGIN, KEY_ID, { keyExpiresAt: "2026-12-01T12:00:00.000Z" }), true);
  assert.equal((await readCredentialStore(f.environment)).credentials.length, 3);
  await logout({ ...f.invocation, legalDrafts: true });
  assert.equal((await findCredential(f.environment, ORIGIN, { siteId: SITE })).credential, undefined);
  assert.ok((await findCredential(f.environment, ORIGIN)).credential);
  assert.ok((await findCredential(f.environment, ORIGIN, { siteId: OTHER_SITE })).credential);
});

test("a selected grant is stable for the batch and never hijacks ordinary or environment sessions", async (t) => {
  const f = await fixture(t);
  await saveCredential(f.environment, account(), { now: () => NOW });
  await saveCredential(f.environment, legal(), { now: () => NOW });
  const client = {};
  const selected = await openSession({ ...f.invocation, legalDrafts: true, client });
  assert.equal(selected.legalDrafts, true);
  const ordinary = await openSession({ ...f.invocation, client, now: () => NOW + 25 * 60 * 60 * 1000 });
  assert.equal(ordinary.legalDrafts, false);
  const progress = [];
  const expired = await openSession({ ...f.invocation, legalDrafts: true, client, now: () => NOW + 25 * 60 * 60 * 1000, onProgress: (line) => progress.push(line) });
  assert.equal(expired.client, client);
  assert.equal(expired.legalDrafts, true);
  assert.match(progress.join("\n"), /expired.*If Taproot refuses it.*login --legal-drafts/u);
  await logout({ ...f.invocation, legalDrafts: true });
  assert.equal(await openSession({ ...f.invocation, resolvedSession: selected }), selected);
  await assert.rejects(openSession({ ...f.invocation, legalDrafts: true }), { code: "auth.legal_grant_missing" });
  await assert.rejects(openSession({ ...f.invocation, legalDrafts: true, environment: { ...f.environment, TAPROOT_SITE_KEY: SECRET } }), { code: "auth.legal_environment_override" });
  const environment = await openSession({ ...f.invocation, client, environment: { ...f.environment, TAPROOT_SITE_KEY: SECRET } });
  assert.equal(environment.legalDrafts, false);
});

test("account logout explains separately stored legal draft grants", async (t) => {
  const f = await fixture(t);
  await saveCredential(f.environment, account(), { now: () => NOW });
  await saveCredential(f.environment, legal(), { now: () => NOW });
  const progress = [];
  await logout({ ...f.invocation, onProgress: (line) => progress.push(line) });
  assert.equal((await findCredential(f.environment, ORIGIN)).credential, undefined);
  assert.equal((await findCredential(f.environment, ORIGIN, { siteId: SITE })).credential.key, SECRET);
  assert.ok(progress.some((line) => line.includes("remain stored") && line.includes("--legal-drafts logout")));
  assert.doesNotMatch(progress.join("\n"), new RegExp(SECRET, "u"));
});

test("login pins the site, stores the approved grant, and never displays secrets", async (t) => {
  const f = await fixture(t);
  const client = clientFor();
  const progress = [];
  const result = await login({ ...f.invocation, client, legalDrafts: true, awaitEnter: async () => false, onProgress: (line) => progress.push(line) });
  assert.equal(client.starts[0].legalDraftSiteId, SITE);
  assert.equal(result.siteId, SITE);
  assert.equal((await findCredential(f.environment, ORIGIN, { siteId: SITE })).credential.key, SECRET);
  assert.doesNotMatch(JSON.stringify([result, progress]), new RegExp(`${SECRET}|${DEVICE}`, "u"));
});

test("server-issued grants survive five minutes of client clock skew", async (t) => {
  for (const skew of [-5, 5]) {
    const f = await fixture(t);
    const client = clientFor();
    let claims = 0;
    client.replaceablePost = async () => { claims += 1; return issued; };
    const now = () => NOW + skew * 60 * 1000;
    const result = await login({ ...f.invocation, client, now, legalDrafts: true, awaitEnter: async () => false });
    assert.equal(result.siteId, SITE);
    assert.equal(claims, 1);
    const stored = (await findCredential(f.environment, ORIGIN, { siteId: SITE })).credential;
    assert.equal(stored.key, SECRET);
    assert.equal(stored.keyExpiresAt, issued.keyExpiresAt);
    assert.equal((await openSession({ ...f.invocation, now, legalDrafts: true, client })).client, client);
  }
});

test("old servers and mis-scoped or malformed claims fail closed", async () => {
  const start = clientFor();
  start.request = async () => ({ deviceCode: DEVICE, userCode: "BCDF-2345", expiresInSeconds: 900, pollIntervalSeconds: 5 });
  await assert.rejects(startCliAuthorization(start, { keyName: "CLI", legalDraftSiteId: SITE }), { code: "login.start_contract" });
  for (const change of [
    { legalDraftSiteId: OTHER_SITE }, { capabilities: SITE_AUTHORING_CAPABILITIES },
    { keyExpiresAt: undefined }, { keyExpiresAt: "not-a-timestamp" },
  ]) {
    await assert.rejects(claimCliAuthorization(clientFor({ ...issued, ...change }), DEVICE, {}, { legalDraftSiteId: SITE, now: () => NOW }), { code: "login.claim_unusable" });
  }
});

test("stored grants require a parseable expiry and exact scope", async (t) => {
  const f = await fixture(t);
  for (const change of [
    { keyExpiresAt: undefined }, { keyExpiresAt: "not-a-timestamp" },
    { keyExpiresAt: "2026-99-99T12:00:00.000Z" }, { keyExpiresAt: "2026-02-30T12:00:00.000Z" },
    { capabilities: SITE_AUTHORING_CAPABILITIES },
    { siteId: "invalid" },
  ]) {
    await assert.rejects(saveCredential(f.environment, { ...legal(), ...change }, { now: () => NOW }), { code: "credentials.contract" });
  }
  for (const keyExpiresAt of ["2026-10-27T12:00:00.000Z", "2026-12-01T12:00:00.000Z"]) {
    await saveCredential(f.environment, { ...legal(), keyExpiresAt }, { now: () => NOW });
    assert.equal((await findCredential(f.environment, ORIGIN, { siteId: SITE })).credential.keyExpiresAt, keyExpiresAt);
  }
});

test("CLI routes explicit global and login options to the same mode", async () => {
  for (const arguments_ of [["--legal-drafts", "pages", "push"], ["login", "--legal-drafts"]]) {
    let invocation;
    const output = { write: () => {} };
    const verb = arguments_.includes("login") ? "login" : "pages push";
    const exit = await runCli({ arguments_, environment: {}, stdout: output, stderr: output, handlers: { [verb]: async (value) => { invocation = value; return { ok: true }; } } });
    assert.equal(exit, 0);
    assert.equal(invocation.legalDrafts, true);
  }
});


test("login recovery preserves the requested grant and never reveals secrets", async (t) => {
  for (const legalDrafts of [false, true]) {
    for (const scenario of ["expired", "consumed", "unknown", "timeout", "lost-timeout", "cancelled", "lost-cancelled", "unstored"]) {
      const f = await fixture(t);
      let clock = NOW;
      const status = (name) => ({ status: `CLI_AUTHORIZATION_CLAIM_STATUS_${name}` });
      const client = {
        request: async () => ({ deviceCode: DEVICE, userCode: "BCDF-2345", expiresInSeconds: 1, pollIntervalSeconds: 1, ...(legalDrafts ? { legalDraftSiteId: SITE } : {}) }),
        sleep: async (milliseconds) => { clock += milliseconds; },
        replaceablePost: async () => {
          if (scenario === "expired") return status("EXPIRED");
          if (scenario === "consumed") return { ...status("CONSUMED"), keyId: KEY_ID, keyPrefix: issued.keyPrefix };
          if (scenario === "unknown") throw new ApiError(404, { code: 5 }, {});
          if (scenario === "timeout") return status("PENDING");
          if (scenario === "lost-timeout") throw new SiteAuthoringError("transport.mutation_ambiguous", "lost");
          if (scenario === "cancelled" || scenario === "lost-cancelled") {
            const error = new SiteAuthoringError("site.cancelled", "The command was cancelled.");
            if (scenario === "lost-cancelled") error.ambiguousMutation = true;
            throw error;
          }
          await mkdir(f.store);
          if (legalDrafts) return issued;
          return { status: issued.status, rawKey: issued.rawKey, keyId: issued.keyId, keyPrefix: issued.keyPrefix, accountId: issued.accountId, keyExpiresAt: issued.keyExpiresAt };
        },
      };
      const expectedCommand = `taproot-site login${legalDrafts ? " --legal-drafts" : ""}`;
      await assert.rejects(login({ ...f.invocation, now: () => clock, client, legalDrafts, awaitEnter: async () => false }), (error) => {
        if (scenario !== "cancelled" || legalDrafts) assert.ok(error.message.includes(expectedCommand), `${scenario}: ${error.message}`);
        if (!legalDrafts) assert.doesNotMatch(error.message, /--legal-drafts/u);
        if (["consumed", "lost-timeout", "lost-cancelled", "unstored"].includes(scenario)) {
          assert.match(error.message, /credential.*issued/su);
          assert.match(error.message, /API keys/u);
        }
        assert.doesNotMatch(error.message, new RegExp(`${SECRET}|${DEVICE}`, "u"));
        return true;
      });
    }
  }
});
