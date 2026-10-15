import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANGELOG,
  changelogEntriesSince,
  changelogEntryFor,
  installedWhatsNew,
  UNRELEASED,
} from "../src/changelog.js";
import { cliOutdatedError, compareCliVersions, parseCliVersion } from "../src/cli-release.js";
import { changelogCommandSince, CLI_VERSION } from "../src/constants.js";
import { REFERENCE_TOPICS } from "../src/reference-help.js";
import { runCli } from "../src/cli.js";
import { failureResult } from "../src/output.js";
import { ApiError } from "../src/transport.js";

function sink() {
  let text = "";
  return { write: (chunk) => void (text += chunk), read: () => text };
}

async function run(arguments_) {
  const stdout = sink();
  const stderr = sink();
  const exitCode = await runCli({ arguments_, environment: {}, cwd: "/workspace", stdout, stderr });
  return { exitCode, result: JSON.parse(stdout.read()), stderr: stderr.read() };
}

test("the changelog record is well formed and covers the installed release", () => {
  assert.ok(CHANGELOG.length > 0);
  const topics = new Set(REFERENCE_TOPICS.map((topic) => topic.name));
  const released = CHANGELOG.filter((entry) => entry.version !== UNRELEASED);
  // At most one entry is being prepared, and it is the newest.
  assert.ok(CHANGELOG.filter((entry) => entry.version === UNRELEASED).length <= 1);
  if (CHANGELOG.some((entry) => entry.version === UNRELEASED)) assert.equal(CHANGELOG[0].version, UNRELEASED);
  for (const entry of CHANGELOG) {
    assert.equal(typeof entry.note, "string");
    assert.ok(entry.note.length > 0 && entry.note.length <= 300, `${entry.version} note length`);
    assert.ok(Array.isArray(entry.behavior) && entry.behavior.length > 0, `${entry.version} behavior`);
    assert.ok(entry.behavior.every((line) => typeof line === "string" && line.length > 0));
    assert.ok(Array.isArray(entry.help));
    for (const topic of entry.help) assert.ok(topics.has(topic), `${entry.version} names unknown help topic ${topic}`);
  }
  for (const entry of released) assert.notEqual(parseCliVersion(entry.version), undefined, entry.version);
  // Newest first, with no repeat.
  for (let index = 1; index < released.length; index += 1) {
    assert.equal(compareCliVersions(released[index - 1].version, released[index].version), 1);
  }
  // A release that was bumped without a note fails here: the unreleased entry is stamped with the new version.
  assert.ok(changelogEntryFor(CLI_VERSION), `changelog.json has no entry for ${CLI_VERSION}`);
});

test("entries since a version are the released ones after it, up to the installed release", () => {
  const entries = changelogEntriesSince("0.18.0");
  assert.ok(entries.length > 0);
  assert.ok(entries.every((entry) => entry.version !== UNRELEASED));
  assert.ok(entries.every((entry) => compareCliVersions(entry.version, "0.18.0") > 0));
  assert.ok(entries.every((entry) => compareCliVersions(entry.version, CLI_VERSION) <= 0));
  assert.equal(changelogEntriesSince(CLI_VERSION).length, 0);
  assert.deepEqual(installedWhatsNew()?.version, CLI_VERSION);
});

test("changelog prints the installed release by default, offline, and stays out of the outdated gate", async () => {
  const { exitCode, result, stderr } = await run(["changelog"]);
  assert.equal(exitCode, 0);
  assert.equal(result.ok, true);
  assert.equal(result.verb, "changelog");
  assert.equal(result.installedVersion, CLI_VERSION);
  assert.deepEqual(result.entries.map((entry) => entry.version), [CLI_VERSION]);
  assert.ok(result.entries[0].behavior.length > 0);
  assert.equal(result.complete, true);
  assert.ok(stderr === "" || stderr.includes(CLI_VERSION));
});

test("changelog --since lists every release after it, newest first, and says when the record starts later", async () => {
  const since = await run(["changelog", "--since", "0.18.0"]);
  assert.equal(since.exitCode, 0);
  assert.deepEqual(
    since.result.entries.map((entry) => entry.version),
    changelogEntriesSince("0.18.0").map((entry) => entry.version),
  );
  assert.ok(since.result.entries.some((entry) => entry.version === "0.19.0"));
  assert.equal(since.result.since, "0.18.0");
  assert.equal(since.result.complete, true);

  const early = await run(["changelog", "--since", "0.1.0"]);
  assert.equal(early.result.complete, false);
  assert.match(early.result.notes.join(" "), /record starts at/u);

  const current = await run(["changelog", "--since", CLI_VERSION]);
  assert.deepEqual(current.result.entries, []);
  assert.match(current.result.notes.join(" "), /not newer than/u);
});

test("changelog refuses a --since that is not a version", async () => {
  for (const arguments_ of [["changelog", "--since"], ["changelog", "--since", "latest"], ["changelog", "--since", "1.2"]]) {
    const { exitCode, result } = await run(arguments_);
    assert.equal(exitCode, 2);
    assert.equal(result.error.code, "changelog.since_invalid");
  }
  const repeated = await run(["changelog", "--since", "0.18.0", "--since", "0.19.0"]);
  assert.equal(repeated.result.error.code, "cli.duplicate_option");
  const unknown = await run(["status", "--since", "0.18.0"]);
  assert.equal(unknown.result.error.code, "cli.unknown_option");
});

test("an outdated-CLI refusal carries latestVersion and the changelog command, from either side", () => {
  const command = changelogCommandSince(CLI_VERSION);

  const offline = cliOutdatedError("9.9.9");
  assert.ok(offline.message.includes(command));
  const offlineResult = failureResult(offline);
  assert.equal(offlineResult.error.refusal, "cli_outdated");
  assert.equal(offlineResult.error.latestVersion, "9.9.9");
  assert.equal(offlineResult.error.changelogCommand, command);

  const message = "This @taprootio/site-authoring CLI reports version 0.1.0; Taproot accepts only the latest published "
    + "release, 9.9.9. Upgrade with: npm install -g @taprootio/site-authoring@latest. Nothing is wrong.";
  const wire = new ApiError(400, {
    code: 3,
    message,
    details: [{ fieldViolations: [{ field: "CliUpgradeRequired", description: message }] }],
  });
  assert.equal(wire.latestCliVersion(), "9.9.9");
  const wireResult = failureResult(wire);
  assert.equal(wireResult.error.latestVersion, "9.9.9");
  assert.equal(wireResult.error.changelogCommand, command);

  // A refusal that does not name a parseable version still carries the command, and no latestVersion.
  const unnamed = failureResult(new ApiError(400, { details: [{ fieldViolations: [{ field: "CliUpgradeRequired" }] }] }));
  assert.equal(unnamed.error.latestVersion, undefined);
  assert.equal(unnamed.error.changelogCommand, command);

  // Other refusals carry neither.
  const other = failureResult(new ApiError(503, { code: 14, details: [{ fieldViolations: [{ field: "SiteAuthoringRollout" }] }] }));
  assert.equal(other.error.latestVersion, undefined);
  assert.equal(other.error.changelogCommand, undefined);
});
