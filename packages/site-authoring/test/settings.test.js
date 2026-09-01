import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_API_BASE_URL, LOCAL_API_BASE_URL } from "../src/constants.js";
import {
  readStoredApiBaseUrl,
  resolveEnvironmentSelector,
  settingsPath,
  writeStoredApiBaseUrl,
} from "../src/settings.js";
import { saveCredential } from "../src/credentials.js";
import { openSession } from "../src/session.js";
import { env } from "../src/verbs/env.js";

/**
 * Which Taproot the CLI talks to (TR00645).
 *
 * The origin allowlist used to be enforced when a `taproot-site.json` named an
 * `apiBaseUrl`, and its table lived in the configuration tests. The field is
 * gone and the door moved, so the table moved with it — losing it would have
 * retired a security control as a side effect of an ergonomics change.
 */
async function fixture(testContext) {
  const base = await mkdtemp(path.join(os.tmpdir(), "taproot-site-settings-"));
  testContext.after(() => rm(base, { recursive: true, force: true }));
  const root = await realpath(base);
  const configHome = path.join(root, "config-home");
  await mkdir(configHome, { recursive: true });
  return {
    root,
    configHome,
    environment: { XDG_CONFIG_HOME: configHome },
    path: path.join(configHome, "taproot-site", "settings.json"),
  };
}

async function writeSettings(site, contents) {
  await mkdir(path.dirname(site.path), { recursive: true });
  await writeFile(site.path, contents);
}

test("resolves the two named environments and nothing outside the reviewed origins", async (testContext) => {
  await testContext.test("production and local are named, not typed", () => {
    assert.equal(resolveEnvironmentSelector("production"), DEFAULT_API_BASE_URL);
    assert.equal(resolveEnvironmentSelector("local"), LOCAL_API_BASE_URL);
  });

  const accepted = [
    "https://app.taproot.io/api",
    "https://app.taproot.io/api/",
    "https://app.taproot.test/api",
    "http://localhost:5000/api",
    "http://127.0.0.1:5000/api",
  ];
  for (const apiBaseUrl of accepted) {
    await testContext.test(`accepts ${apiBaseUrl}`, () => {
      assert.equal(resolveEnvironmentSelector(apiBaseUrl), apiBaseUrl.replace(/\/+$/u, ""));
    });
  }

  // Unchanged from the table this replaces: a credential is sent to whatever
  // this returns, so the bar `env` clears is the bar the configuration had to.
  const rejected = [
    "https://attacker.example/api",
    "https://app.taproot.io.attacker.example/api",
    "http://app.taproot.io/api",
    "https://app.taproot.io:8443/api",
    "https://operator:secret@app.taproot.io/api",
    "https://app.taproot.io/api?site=other",
    "https://app.taproot.io/api#fragment",
    "https://app.taproot.io/v1",
    "https://app.taproot.io/",
    "app.taproot.io/api",
    "",
    "https://127.0.0.1/api/../admin",
  ];
  for (const apiBaseUrl of rejected) {
    await testContext.test(`rejects ${JSON.stringify(apiBaseUrl)}`, () => {
      assert.throws(() => resolveEnvironmentSelector(apiBaseUrl), (error) => error?.code === "config.api_base_url");
    });
  }
});

test("no settings file means production, which is the state a fresh machine is in", async (testContext) => {
  const site = await fixture(testContext);
  assert.equal(await readStoredApiBaseUrl(site.environment), undefined);
});

test("switching to production clears the file rather than writing the default into it", async (testContext) => {
  const site = await fixture(testContext);
  await writeStoredApiBaseUrl(site.environment, LOCAL_API_BASE_URL);
  assert.equal(await readStoredApiBaseUrl(site.environment), LOCAL_API_BASE_URL);

  await writeStoredApiBaseUrl(site.environment, DEFAULT_API_BASE_URL);
  // One representation of "production", so a fresh machine and a switched-back
  // one cannot disagree about what they mean.
  assert.equal(await readStoredApiBaseUrl(site.environment), undefined);
  await assert.rejects(readFile(site.path, "utf8"), (error) => error?.code === "ENOENT");
});

test("a hand-edited settings file is re-validated, not trusted", async (testContext) => {
  const site = await fixture(testContext);
  await writeSettings(site, `${JSON.stringify({ schemaVersion: 1, apiBaseUrl: "https://attacker.example/api" })}\n`);

  await assert.rejects(
    readStoredApiBaseUrl(site.environment),
    (error) => error?.code === "config.api_base_url",
  );
});

test("a malformed settings file refuses rather than falling back to production", async (testContext) => {
  const site = await fixture(testContext);

  for (const [contents, code] of [
    ["not json at all", "settings.malformed"],
    [JSON.stringify([1, 2, 3]), "settings.malformed"],
    [JSON.stringify({ schemaVersion: 99, apiBaseUrl: LOCAL_API_BASE_URL }), "settings.unsupported_version"],
    [JSON.stringify({ schemaVersion: 1 }), "settings.malformed"],
  ]) {
    await writeSettings(site, `${contents}\n`);
    // Silently defaulting here would point someone who set this to local at the
    // live Taproot, which is the one wrong answer that looks like success.
    await assert.rejects(readStoredApiBaseUrl(site.environment), (error) => error?.code === code);
  }
});

test("env reports without an argument and switches with one", async (testContext) => {
  const site = await fixture(testContext);
  const progress = [];
  const invocation = { environment: site.environment, onProgress: (line) => progress.push(line) };

  const before = await env(invocation);
  assert.equal(before.environment, "production");
  assert.equal(before.changed, false);
  assert.equal(before.signedIn, false);

  const switched = await env({ ...invocation, environmentSelector: "local" });
  assert.equal(switched.environment, "local");
  assert.equal(switched.apiOrigin, "https://app.taproot.test");
  assert.equal(switched.changed, true);
  assert.equal(switched.settingsPath, settingsPath(site.environment));

  // Reported, because "am I signed in where I just switched to" is the question
  // behind running this at all.
  assert.ok(progress.some((line) => line.includes("Not signed in there yet")));

  const again = await env({ ...invocation, environmentSelector: "local" });
  assert.equal(again.changed, false);
  assert.equal(again.environment, "local");
});

test("env refuses a Taproot this CLI does not talk to, as a usage fault", async (testContext) => {
  const site = await fixture(testContext);

  await assert.rejects(
    env({ environment: site.environment, environmentSelector: "staging" }),
    (error) => error?.code === "env.unknown" && error?.exitCode === 2,
  );
  // And it did not write the refusal through to the file.
  assert.equal(await readStoredApiBaseUrl(site.environment), undefined);
});

test("a settings file that is a link is refused, not followed", async (testContext) => {
  const site = await fixture(testContext);
  await mkdir(path.dirname(site.path), { recursive: true });
  // A link to a FIFO would block a plain readFile forever, and a link to a
  // device would read until memory ran out — both before any size check on
  // the result could run. Refusing at lstat is what stops either.
  await symlink(path.join(site.root, "elsewhere.json"), site.path);

  await assert.rejects(readStoredApiBaseUrl(site.environment), (error) => error?.code === "settings.not_regular");
});

test("env refuses to switch when the credential store is unusable, and leaves the endpoint alone", async (testContext) => {
  const site = await fixture(testContext);
  const storePath = path.join(site.configHome, "taproot-site", "credentials.json");
  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, "{ this is not json");

  // The refusal must land before the write. Afterwards would mean a non-zero
  // exit that had already repointed every later command somewhere else.
  await assert.rejects(env({ environment: site.environment, environmentSelector: "local" }));
  await assert.rejects(stat(site.path), (error) => error?.code === "ENOENT");
});

/**
 * "No credential anywhere" is answered before any other file is read. That
 * ordering is a promise the session helper makes about the credential store
 * versus the configuration, and the machine settings are one more file it
 * has to hold for: an empty store plus a malformed settings file must still
 * say "not signed in", not "settings malformed".
 */
test("an empty credential store is reported before a malformed settings file is read", async (testContext) => {
  const site = await fixture(testContext);
  await writeSettings(site, "{ not json");
  const projectWithoutConfig = path.join(site.root, "nowhere");
  await mkdir(projectWithoutConfig);

  await assert.rejects(
    openSession({ environment: site.environment, cwd: projectWithoutConfig }),
    (error) => error?.code === "auth.key_missing",
  );
});

test("a stored sign-in still surfaces a malformed settings file, since it needs the endpoint", async (testContext) => {
  const site = await fixture(testContext);
  await writeSettings(site, "{ not json");
  await saveCredential(site.environment, {
    apiOrigin: "https://app.taproot.test",
    accountId: "eeee5555-ffff-4555-8555-aaaa55555555",
    key: "tr_live_zz99yy88_stored_secret_that_must_never_be_logged",
    keyId: "dddd4444-eeee-4444-8444-ffff44444444",
    keyPrefix: "tr_live_ab12cd34...",
  }, { now: () => 1_700_000_000_000 });
  const projectWithoutConfig = path.join(site.root, "nowhere");
  await mkdir(projectWithoutConfig);

  // Not swallowed: with a credential in hand the endpoint decides which record
  // applies, and a broken settings file cannot be quietly read as production.
  await assert.rejects(
    openSession({ environment: site.environment, cwd: projectWithoutConfig }),
    (error) => error?.code === "settings.malformed",
  );
});

test("a settings file that names the endpoint twice is refused, not read last-wins", async (testContext) => {
  const site = await fixture(testContext);
  // What the file visibly says first and what JSON.parse would hand back are
  // two different Taproots. A TAPROOT_SITE_KEY minted for one would be sent to
  // the other. Refusing is the only reading that is not a guess.
  await writeSettings(
    site,
    `{"schemaVersion":1,"apiBaseUrl":"${DEFAULT_API_BASE_URL}","apiBaseUrl":"${LOCAL_API_BASE_URL}"}\n`,
  );

  await assert.rejects(readStoredApiBaseUrl(site.environment), (error) =>
    error?.code === "settings.duplicate_key" && /apiBaseUrl/u.test(error.message));
});
