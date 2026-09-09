import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConformanceCases } from "@taprootio/docs-artifact/conformance";

import { snapshotDocsArtifact } from "../src/artifact.js";

const PREBUILT_MANIFEST_NAME = "taproot-docs-prebuilt-manifest.json";

async function writeCase(testContext) {
  const cases = await loadConformanceCases();
  const fixture = cases.find((candidate) => candidate.name === "valid-minimal");
  assert.ok(fixture);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "taproot-docs-publisher-artifact-"));
  const root = await realpath(temporaryRoot);
  testContext.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "taproot-docs-manifest.json"), fixture.manifest);
  for (const file of fixture.files) {
    await mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
    await writeFile(path.join(root, file.path), file.content);
  }
  return { root, fixture };
}

// The prebuilt fixture is constructed here with plain fs so these tests exercise
// the exact package contract rather than a committed snapshot of it.
function prebuiltFiles() {
  return [
    { path: "404.html", mediaType: "text/html; charset=utf-8", content: "<!doctype html><title>Missing</title>\n" },
    { path: "assets/site.js", mediaType: "text/javascript; charset=utf-8", content: "export const ready = true;\n" },
    { path: "guides/index.html", mediaType: "text/html; charset=utf-8", content: "<!doctype html><title>Guide</title>\n" },
    { path: "index.html", mediaType: "text/html; charset=utf-8", content: "<!doctype html><title>Home</title>\n" },
  ];
}

function prebuiltManifest(files) {
  return {
    build: {
      configurationSha256: `sha256:${"1".repeat(64)}`,
      producer: "@taprootio/espalier-docs",
      producerVersion: "1.0.0",
      sourceDateEpoch: 1_786_838_400,
    },
    capabilities: { optional: [], required: ["taproot.docs.prebuilt.files.v1"] },
    files: files.map((file) => ({
      bytes: Buffer.byteLength(file.content, "utf8"),
      mediaType: file.mediaType,
      path: file.path,
      sha256: `sha256:${createHash("sha256").update(file.content, "utf8").digest("hex")}`,
    })),
    mode: "prebuilt",
    notFoundFile: "404.html",
    redirects: [{ from: "/getting-started/", status: 308, toResourceKey: "guide:getting-started" }],
    resources: [
      { file: "guides/index.html", key: "guide:getting-started", title: "Getting started" },
      { file: "index.html", key: "home", title: "Espalier controls" },
    ],
    schemaVersion: 1,
    source: {
      provider: "github",
      ref: "refs/heads/main",
      repository: "taprootio/taproot-controls",
      repositoryId: "934883082",
      repositoryUrl: "https://github.com/taprootio/taproot-controls",
      revision: "0123456789abcdef0123456789abcdef01234567",
    },
  };
}

async function writePrebuiltCase(testContext) {
  const files = prebuiltFiles();
  const manifest = prebuiltManifest(files);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "taproot-docs-publisher-prebuilt-"));
  const root = await realpath(temporaryRoot);
  testContext.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, PREBUILT_MANIFEST_NAME), `${JSON.stringify(manifest, undefined, 2)}\n`);
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
    await writeFile(path.join(root, file.path), file.content);
  }
  return { root, files, manifest };
}

test("snapshots the exact package-validated manifest and declared managed bytes", async (testContext) => {
  const { root, fixture } = await writeCase(testContext);
  const snapshot = await snapshotDocsArtifact(root);
  assert.equal(snapshot.mode, "managed");
  assert.equal(snapshot.manifest.schemaVersion, 1);
  assert.deepEqual(snapshot.entries.map((entry) => entry.path), [
    "taproot-docs-manifest.json",
    ...fixture.files.map((file) => file.path),
  ]);
  assert.equal(snapshot.entries[0].content.at(-1), 0x0a);
  assert.equal(snapshot.entries[1].content.toString("utf8"), Buffer.from(fixture.files[0].content).toString("utf8"));
});

test("fails before packaging an undeclared managed file or symlink", async (testContext) => {
  const extra = await writeCase(testContext);
  await writeFile(path.join(extra.root, "taproot-docs", "fragments", "undeclared.html"), "private");
  await assert.rejects(
    snapshotDocsArtifact(extra.root),
    (error) => error?.code === "artifact.file.unexpected" && error?.field === "taproot-docs/fragments/undeclared.html",
  );

  const linked = await writeCase(testContext);
  const declaredPath = path.join(linked.root, linked.fixture.files[0].path);
  await rm(declaredPath);
  await symlink(path.join(linked.root, "taproot-docs-manifest.json"), declaredPath);
  await assert.rejects(
    snapshotDocsArtifact(linked.root),
    (error) => error?.code === "artifact.file.symlink" && error?.field === linked.fixture.files[0].path,
  );
});

test("snapshots the prebuilt inventory without a prepended manifest entry", async (testContext) => {
  const { root, files, manifest } = await writePrebuiltCase(testContext);
  const snapshot = await snapshotDocsArtifact(root, "prebuilt");

  assert.equal(snapshot.mode, "prebuilt");
  assert.equal(snapshot.manifest.schemaVersion, 1);
  assert.equal(snapshot.manifest.mode, "prebuilt");
  assert.deepEqual(snapshot.files.map((file) => file.path), files.map((file) => file.path));
  assert.equal(snapshot.fileCount, files.length);
  assert.equal(snapshot.semanticBytes, manifest.files.reduce((total, file) => total + file.bytes, 0));
  for (const [index, file] of files.entries()) {
    assert.equal(Buffer.from(snapshot.files[index].content).toString("utf8"), file.content);
  }
  // The pack step receives an isolated inventory, never the validator's own.
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.files));
  assert.ok(snapshot.files.every((file) => Object.isFrozen(file)));
});

test("rejects prebuilt trees the package refuses to accept", async (testContext) => {
  await testContext.test("undeclared file", async (caseContext) => {
    const { root } = await writePrebuiltCase(caseContext);
    await writeFile(path.join(root, "leaked.txt"), "private");
    await assert.rejects(
      snapshotDocsArtifact(root, "prebuilt"),
      (error) => error?.code === "artifact.file.unexpected" && error?.field === "leaked.txt",
    );
  });

  await testContext.test("declared symlink", async (caseContext) => {
    const { root } = await writePrebuiltCase(caseContext);
    const declared = path.join(root, "assets", "site.js");
    await rm(declared);
    await symlink(path.join(root, PREBUILT_MANIFEST_NAME), declared);
    await assert.rejects(
      snapshotDocsArtifact(root, "prebuilt"),
      (error) => error?.code === "artifact.file.not_regular" && error?.field === "assets/site.js",
    );
  });

  await testContext.test("same-length content drift", async (caseContext) => {
    const { root, files } = await writePrebuiltCase(caseContext);
    const drifted = files.find((file) => file.path === "index.html");
    await writeFile(path.join(root, drifted.path), drifted.content.replace("Home", "Away"));
    await assert.rejects(
      snapshotDocsArtifact(root, "prebuilt"),
      (error) => error?.code === "artifact.file.hash_drift",
    );
  });
});

test("neither mode accepts the other mode's artifact directory", async (testContext) => {
  const managed = await writeCase(testContext);
  await assert.rejects(
    snapshotDocsArtifact(managed.root, "prebuilt"),
    (error) => error?.code === "artifact.file.missing" && error?.field === PREBUILT_MANIFEST_NAME,
  );

  const prebuilt = await writePrebuiltCase(testContext);
  await assert.rejects(
    snapshotDocsArtifact(prebuilt.root, "managed"),
    (error) => error?.code === "artifact.file.missing" && error?.field === "taproot-docs-manifest.json",
  );
});

test("refuses a publication mode with no artifact contract", async (testContext) => {
  const { root } = await writePrebuiltCase(testContext);
  await assert.rejects(
    snapshotDocsArtifact(root, "static"),
    (error) => error?.code === "artifact.mode_unsupported" && error?.field === "mode",
  );
});
