import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { PublisherError } from "../src/errors.js";

function sink() {
  let value = "";
  return { write: (chunk) => { value += chunk; }, read: () => value };
}

function successResult() {
  return {
    schemaVersion: 1,
    ok: true,
    publisher: { name: "@taprootio/docs-publisher", version: "1.1.0" },
    compatibility: {
      configVersion: 1,
      artifactPackageVersion: "1.1.0",
      artifactSchemaVersion: 1,
      archiveFormat: "taproot-docs-prebuilt-tar-gzip-v1",
    },
    siteId: "11111111-1111-4111-8111-111111111111",
    mode: "prebuilt",
    artifact: { contentHash: `sha256:${"a".repeat(64)}`, byteLength: 10, uploaded: true, reused: false },
    release: {
      id: "22222222-2222-4222-8222-222222222222",
      status: "DOCS_RELEASE_STATUS_VALIDATED",
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
    },
    staging: {
      deploymentId: "33333333-3333-4333-8333-333333333333",
      outputReleaseId: "55555555-5555-4555-8555-555555555555",
      pointerVersion: 1,
      status: "DEPLOYMENT_STATUS_COMPLETED",
    },
    production: {
      deploymentId: "44444444-4444-4444-8444-444444444444",
      outputReleaseId: "55555555-5555-4555-8555-555555555555",
      pointerVersion: 2,
      status: "DEPLOYMENT_STATUS_COMPLETED",
    },
  };
}

test("emits one JSON result and collision-safe GitHub Actions outputs", async (testContext) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "taproot-docs-publisher-output-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const outputPath = path.join(temporaryDirectory, "github-output");
  await writeFile(outputPath, "");
  const stdout = sink();
  const stderr = sink();
  const result = successResult();
  const exitCode = await runCli({
    arguments_: ["docs", "publish", "--quiet"],
    environment: { GITHUB_OUTPUT: outputPath, TAPROOT_DOCS_PUBLISH_KEY: "never-emitted" },
    stdout,
    stderr,
    publish: async () => result,
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(stdout.read()), result);
  assert.equal(stderr.read(), "");
  const githubOutput = await readFile(outputPath, "utf8");
  assert.match(githubOutput, /^taproot_docs_result<<taproot_docs_[0-9a-f]{32}\n/u);
  assert.match(githubOutput, /taproot_docs_publication_mode=prebuilt\n/u);
  assert.match(githubOutput, /taproot_docs_release_id=22222222-2222-4222-8222-222222222222/u);
  assert.match(githubOutput, /taproot_docs_production_pointer_version=2/u);
  assert.doesNotMatch(`${stdout.read()}${githubOutput}`, /never-emitted/u);
});

test("unexpected failures redact tokens, capability URLs, artifact contents, and environment values", async () => {
  const secrets = [
    "tr_live_repository_secret",
    "https://objects.example/upload?signature=secret",
    "private artifact contents",
    "unrelated-environment-secret",
  ];
  const stdout = sink();
  const stderr = sink();
  const exitCode = await runCli({
    arguments_: ["docs", "publish"],
    environment: {
      TAPROOT_DOCS_PUBLISH_KEY: secrets[0],
      UNRELATED_SECRET: secrets[3],
    },
    stdout,
    stderr,
    publish: async () => {
      throw new Error(secrets.join(" "));
    },
  });
  assert.equal(exitCode, 1);
  assert.equal(JSON.parse(stdout.read()).error.code, "publisher.failed");
  for (const secret of secrets) assert.doesNotMatch(`${stdout.read()}${stderr.read()}`, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("does not accept a credential command-line option", async () => {
  const stdout = sink();
  const stderr = sink();
  const exitCode = await runCli({
    arguments_: ["docs", "publish", "--token", "secret-on-command-line"],
    environment: {},
    stdout,
    stderr,
    publish: async () => successResult(),
  });
  assert.equal(exitCode, 2);
  assert.equal(JSON.parse(stdout.read()).error.code, "cli.unknown_option");
  assert.doesNotMatch(`${stdout.read()}${stderr.read()}`, /secret-on-command-line/u);
});

test("exposes help and version at the binary and product-command levels", async () => {
  for (const arguments_ of [["--help"], ["docs", "publish", "--help"]]) {
    const stdout = sink();
    assert.equal(await runCli({ arguments_, stdout, stderr: sink() }), 0);
    assert.match(stdout.read(), /^Usage: taproot docs publish/u);
  }
  for (const arguments_ of [["--version"], ["docs", "publish", "--version"]]) {
    const stdout = sink();
    assert.equal(await runCli({ arguments_, stdout, stderr: sink() }), 0);
    assert.equal(stdout.read(), "1.1.0\n");
  }
});

test("strips terminal controls from stable fields and human diagnostics", async () => {
  const stdout = sink();
  const stderr = sink();
  const exitCode = await runCli({
    arguments_: ["docs", "publish"],
    environment: {},
    stdout,
    stderr,
    publish: async () => {
      throw new PublisherError("artifact.invalid", "invalid\nsecond-line", { field: "path\rspoof" });
    },
  });
  assert.equal(exitCode, 1);
  assert.deepEqual(JSON.parse(stdout.read()).error, { code: "artifact.invalid", field: "pathspoof" });
  assert.equal(
    stderr.read(),
    "taproot docs publish failed [artifact.invalid] field=pathspoof: invalidsecond-line\n",
  );
  assert.doesNotMatch(stderr.read().slice(0, -1), /[\r\n]/u);
});
