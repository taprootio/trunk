import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validatePrebuiltArtifactFromTrustedSnapshots } from "../src/prebuilt-artifact-validator.js";
import { loadPrebuiltConformanceCases } from "../src/prebuilt-conformance.js";
import { PREBUILT_LIMITS, validatePrebuiltArtifact, validatePrebuiltManifest } from "../src/prebuilt.js";

test("prebuilt artifact validation returns exact private snapshots in manifest order", async () => {
  const [fixture] = await loadPrebuiltConformanceCases();
  const callerBytes = fixture.files.map((file) => ({ path: file.path, content: new Uint8Array(file.content) }));

  const result = await validatePrebuiltArtifact(fixture.manifest, callerBytes);

  assert.equal(result.ok, true);
  assert.equal(result.value.fileCount, 14);
  assert.equal(result.value.totalBytes, 2247);
  assert.deepEqual(result.value.files.map((file) => file.path), result.value.manifest.files.map((file) => file.path));
  assert.notStrictEqual(result.value.files[0].content, callerBytes[0].content);
  const preserved = result.value.files[0].content[0];
  callerBytes[0].content[0] ^= 0xff;
  assert.equal(result.value.files[0].content[0], preserved);
});

test("trusted Node snapshots are validated without a second full buffer copy", async () => {
  const [fixture] = await loadPrebuiltConformanceCases();
  const manifestResult = validatePrebuiltManifest(fixture.manifest);
  assert.equal(manifestResult.ok, true);
  const trustedFiles = fixture.files.map((file) => ({ path: file.path, content: new Uint8Array(file.content) }));

  const result = await validatePrebuiltArtifactFromTrustedSnapshots(manifestResult.value, trustedFiles);

  assert.equal(result.ok, true);
  for (const [index, file] of result.value.files.entries()) {
    assert.strictEqual(file.content, trustedFiles[index].content);
  }
});

test("prebuilt artifact validation checks exact bytes without executing site JavaScript", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../fixtures/prebuilt/valid/espalier/taproot-docs-prebuilt-manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const files = manifest.files.map((descriptor) => ({ path: descriptor.path, content: new Uint8Array() }));

  const result = await validatePrebuiltArtifact(manifest, files);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "file.size_drift"));
  assert.ok(result.errors.every((error) => !error.code.startsWith("markup.")));
});

test("prebuilt textual media must contain exact valid UTF-8 bytes", async () => {
  const [fixture] = await loadPrebuiltConformanceCases();
  const files = fixture.files.map((file) => ({ path: file.path, content: new Uint8Array(file.content) }));
  const css = files.find((file) => file.path === "assets/site.css");
  css.content[0] = 0xff;

  const result = await validatePrebuiltArtifact(fixture.manifest, files);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "file.hash_drift"));
  assert.ok(result.errors.some((error) => error.code === "file.invalid_utf8"));
});

test("prebuilt WebVTT captions are textual media and must be valid UTF-8", async () => {
  const [fixture] = await loadPrebuiltConformanceCases();
  const files = fixture.files.map((file) => ({ path: file.path, content: new Uint8Array(file.content) }));
  const content = new Uint8Array([0x57, 0x45, 0x42, 0x56, 0x54, 0x54, 0x0a, 0xff, 0x0a]);
  const sha256 = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const manifest = JSON.parse(Buffer.from(fixture.manifest).toString("utf8"));
  manifest.files = [
    ...manifest.files,
    { bytes: content.byteLength, mediaType: "text/vtt; charset=utf-8", path: "assets/captions.vtt", sha256 },
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  files.push({ path: "assets/captions.vtt", content });

  const result = await validatePrebuiltArtifact(manifest, files);

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.filter((error) => error.path?.includes("captions.vtt") || error.code === "file.invalid_utf8")
      .map((error) => error.code),
    ["file.invalid_utf8"],
  );
});

test("prebuilt string content scanning stops at the smaller per-file bound", async () => {
  const [fixture] = await loadPrebuiltConformanceCases();
  const files = fixture.files.map((file) => ({ path: file.path, content: new Uint8Array(file.content) }));
  const css = files.find((file) => file.path === "assets/site.css");
  css.content = `${"a".repeat(PREBUILT_LIMITS.fileBytes + 1)}\ud800`;

  const result = await validatePrebuiltArtifact(fixture.manifest, files);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "file.too_large"));
  assert.ok(result.errors.every((error) => error.code !== "file.invalid_unicode"));
});
