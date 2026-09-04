import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LIMITS } from "../src/constants.js";
import { SiteAuthoringError } from "../src/errors.js";
import { failureResult, humanFailure, serializeResult, writeGithubActionsOutput } from "../src/output.js";
import { ApiError } from "../src/transport.js";

const RESERVED_ERROR_KEYS = [
  "alternatives",
  "code",
  "completedWrites",
  "field",
  "preview",
  "refusal",
  "status",
];

async function temporaryRoot(testContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "taproot-site-output-"));
  testContext.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("the machine-readable failure carries only the reviewed keys", () => {
  const error = new SiteAuthoringError("config.site_id", "bad", {
    alternatives: ["site-a"],
    field: "siteId",
    status: "grpc:8",
  })
    .withCompletedWrites(["lightTheme"])
    .withPreviewRecovery({
      siteId: "11111111-1111-4111-8111-111111111111",
      pageId: "22222222-2222-4222-8222-222222222222",
      snapshotId: "33333333-3333-4333-8333-333333333333",
      expiresAt: "2026-08-24T20:00:00.000Z",
    });
  error.refusalKind = () => "throttled";
  const result = failureResult(error);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.ok, false);
  assert.deepEqual(result.cli, { name: "@taprootio/site-authoring", version: "0.2.0" });
  assert.deepEqual(Object.keys(result.error).sort(), RESERVED_ERROR_KEYS);
});

test("surfaces a classified refusal and stays silent about an unclassified one", () => {
  const paused = new ApiError(503, { details: [{ fieldViolations: [{ field: "SiteAuthoringRollout" }] }] });
  assert.equal(failureResult(paused).error.refusal, "platform_paused");
  assert.match(humanFailure(paused), /refusal=platform_paused/u);

  const ordinary = new ApiError(400, { code: 3, details: [{ fieldViolations: [{ field: "Path" }] }] });
  assert.equal("refusal" in failureResult(ordinary).error, false);
  assert.doesNotMatch(humanFailure(ordinary), /refusal=/u);
});

test("returns only the non-secret identity needed to recover a created preview", () => {
  const recovery = {
    siteId: "11111111-1111-4111-8111-111111111111",
    pageId: "22222222-2222-4222-8222-222222222222",
    snapshotId: "33333333-3333-4333-8333-333333333333",
    expiresAt: "2026-08-24T20:00:00.000Z",
  };
  const error = new SiteAuthoringError("preview.timeout", "timed out")
    .withPreviewRecovery({ ...recovery, handoff: "must-not-escape" });

  assert.deepEqual(failureResult(error).error.preview, recovery);
  assert.equal(serializeResult(failureResult(error)).includes("must-not-escape"), false);

  for (const expiresAt of ["not-a-timestamp", "2026-08-24T20:00:00.000Z\u202e"]) {
    const invalid = new SiteAuthoringError("preview.timeout", "timed out")
      .withPreviewRecovery({ ...recovery, expiresAt });
    assert.equal("preview" in failureResult(invalid).error, false);
  }
});

test("never carries a credential or a capability URL into the machine-readable result", () => {
  const secrets = ["tr_live_site_key", "https://objects.example/put?signature=secret"];
  const rejected = new ApiError(400, {
    code: 3,
    message: secrets.join(" "),
    details: [{ fieldViolations: [{ field: "Path", description: secrets.join(" ") }] }],
    presignedUrl: secrets[1],
  });
  const serialized = `${serializeResult(failureResult(rejected))}${humanFailure(rejected)}`;
  for (const secret of secrets) assert.equal(serialized.includes(secret), false);
});

test("refuses a result that is not a serializable object, or is too large to emit", () => {
  for (const value of [undefined, null, "result", 7, [], () => {}]) {
    assert.throws(() => serializeResult(value), (error) => error?.code === "output.result_invalid");
  }
  assert.throws(
    () => serializeResult({ ok: true, padding: "x".repeat(LIMITS.githubOutputBytes) }),
    (error) => error?.code === "output.too_large",
  );
});

test("appends a heredoc result block and only self-owned scalars", async (testContext) => {
  const root = await temporaryRoot(testContext);
  const outputPath = path.join(root, "github-output");
  await writeFile(outputPath, "existing=value\n");
  await writeGithubActionsOutput(outputPath, { schemaVersion: 1, ok: true, verb: "pages push" });
  const written = await readFile(outputPath, "utf8");
  assert.match(written, /^existing=value\n/u);
  assert.match(written, /\ntaproot_site_result<<taproot_site_[0-9a-f]{32}\n/u);
  assert.match(written, /\ntaproot_site_verb=pages push\n$/u);
  const lines = written.split("\n");
  const opener = lines.findIndex((line) => line.startsWith("taproot_site_result<<"));
  const delimiter = lines[opener].slice("taproot_site_result<<".length);
  assert.deepEqual(JSON.parse(lines[opener + 1]), { schemaVersion: 1, ok: true, verb: "pages push" });
  assert.equal(lines[opener + 2], delimiter);
});

test("emits no bare scalar for a failure or an untrusted verb value", async (testContext) => {
  const root = await temporaryRoot(testContext);
  for (
    const [name, result] of [
      ["failure", { schemaVersion: 1, ok: false, verb: "pull" }],
      ["injected newline", { schemaVersion: 1, ok: true, verb: "pull\ninjected=1" }],
      ["unexpected shape", { schemaVersion: 1, ok: true, verb: { name: "pull" } }],
    ]
  ) {
    await testContext.test(name, async () => {
      const outputPath = path.join(root, `github-output-${name.replace(/[^a-z]/gu, "")}`);
      await writeFile(outputPath, "");
      await writeGithubActionsOutput(outputPath, result);
      const written = await readFile(outputPath, "utf8");
      assert.equal(written.includes("taproot_site_verb="), false);
      assert.equal(written.split("\n").some((line) => line.startsWith("injected=")), false);
    });
  }
});

test("refuses an output destination that is not a plain existing file", async (testContext) => {
  const root = await temporaryRoot(testContext);
  const real = path.join(root, "real-output");
  await writeFile(real, "");
  await mkdir(path.join(root, "directory"));
  await symlink(real, path.join(root, "linked-output"));
  const result = { schemaVersion: 1, ok: true, verb: "pull" };
  const cases = [
    [path.join(root, "missing-output"), "output.github_missing"],
    [path.join(root, "linked-output"), "output.github_invalid"],
    [path.join(root, "directory"), "output.github_invalid"],
    ["", "output.github_path"],
    [`out${String.fromCodePoint(10)}put`, "output.github_path"],
  ];
  for (const [outputPath, code] of cases) {
    await assert.rejects(
      writeGithubActionsOutput(outputPath, result),
      (error) => error?.code === code,
    );
  }
});

test("names the failure on one bounded stderr line", () => {
  const line = humanFailure(new SiteAuthoringError("config.workspace_dir", "bad workspace", { field: "workspaceDir" }));
  assert.equal(line, "taproot-site failed [config.workspace_dir] field=workspaceDir: bad workspace");
  assert.doesNotMatch(line, /[\r\n]/u);
});
