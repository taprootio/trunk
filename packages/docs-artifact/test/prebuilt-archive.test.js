import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import { createDeterministicPrebuiltArchive } from "../src/prebuilt-archive.js";
import { loadPrebuiltConformanceCases } from "../src/prebuilt-conformance.js";
import { serializePrebuiltManifest, validatePrebuiltArtifact } from "../src/prebuilt.js";

const TAR_BLOCK_BYTES = 512;
const DEFLATE_STORED_BLOCK_BYTES = 65_535;

function fieldText(header, start, length) {
  const field = header.subarray(start, start + length);
  const terminator = field.indexOf(0);
  return field.subarray(0, terminator < 0 ? field.length : terminator).toString("ascii");
}

function inspectTar(tar) {
  const entries = [];
  let offset = 0;
  while (offset + TAR_BLOCK_BYTES <= tar.byteLength) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) break;
    const name = fieldText(header, 0, 100);
    const prefix = fieldText(header, 345, 155);
    const size = Number.parseInt(fieldText(header, 124, 12), 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const checksum = checksumHeader.reduce((total, byte) => total + byte, 0);

    assert.equal(header.subarray(100, 108).toString("ascii"), "0000644\0");
    assert.equal(header.subarray(108, 116).toString("ascii"), "0000000\0");
    assert.equal(header.subarray(116, 124).toString("ascii"), "0000000\0");
    assert.equal(header.subarray(136, 148).toString("ascii"), "00000000000\0");
    assert.match(header.subarray(124, 136).toString("ascii"), /^[0-7]{11}\0$/u);
    assert.match(header.subarray(148, 156).toString("ascii"), /^[0-7]{6}\0 $/u);
    assert.equal(Number.parseInt(fieldText(header, 148, 8), 8), checksum);
    assert.equal(header[156], 0x30);
    assert.equal(header.subarray(157, 257).every((byte) => byte === 0), true);
    assert.equal(header.subarray(257, 263).toString("ascii"), "ustar\0");
    assert.equal(header.subarray(263, 265).toString("ascii"), "00");
    assert.equal(header.subarray(265, 329).every((byte) => byte === 0), true);
    assert.equal(header.subarray(329, 337).toString("ascii"), "0000000\0");
    assert.equal(header.subarray(337, 345).toString("ascii"), "0000000\0");
    assert.equal(header.subarray(500, 512).every((byte) => byte === 0), true);

    const contentOffset = offset + TAR_BLOCK_BYTES;
    const paddedSize = Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    assert.equal(tar.subarray(contentOffset + size, contentOffset + paddedSize).every((byte) => byte === 0), true);
    entries.push({
      path: prefix ? `${prefix}/${name}` : name,
      name,
      prefix,
      size,
      content: tar.subarray(contentOffset, contentOffset + size),
    });
    offset = contentOffset + paddedSize;
  }
  assert.equal(tar.subarray(offset).byteLength, TAR_BLOCK_BYTES * 2);
  assert.equal(tar.subarray(offset).every((byte) => byte === 0), true);
  return entries;
}

function storedBlockLengths(gzip) {
  assert.deepEqual([...gzip.subarray(0, 10)], [0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]);
  const lengths = [];
  let offset = 10;
  while (offset < gzip.byteLength - 8) {
    const final = gzip[offset];
    assert.ok(final === 0x00 || final === 0x01);
    const length = gzip.readUInt16LE(offset + 1);
    assert.equal(gzip.readUInt16LE(offset + 3), (~length) & 0xffff);
    lengths.push(length);
    offset += 5 + length;
    if (final === 0x01) break;
  }
  assert.equal(offset, gzip.byteLength - 8);
  assert.ok(lengths.every((length, index) => index === lengths.length - 1 || length === DEFLATE_STORED_BLOCK_BYTES));
  assert.ok(lengths.at(-1) > 0 && lengths.at(-1) <= DEFLATE_STORED_BLOCK_BYTES);
  return lengths;
}

async function representativeSnapshot() {
  const fixture = (await loadPrebuiltConformanceCases()).find((candidate) => candidate.expectedArchive);
  assert.ok(fixture?.expectedArchive);
  const result = await validatePrebuiltArtifact(fixture.manifest, fixture.files);
  assert.equal(result.ok, true);
  return { fixture, snapshot: result.value };
}

test("prebuilt archive is byte-identical to the published representative golden vector", async () => {
  const { fixture, snapshot } = await representativeSnapshot();
  const archive = createDeterministicPrebuiltArchive(snapshot);

  assert.deepEqual(archive.bytes, fixture.expectedArchive.bytes);
  assert.equal(archive.byteLength, fixture.expectedArchive.byteLength);
  assert.equal(archive.contentHash, fixture.expectedArchive.sha256);
  assert.equal(archive.byteLength, archive.bytes.byteLength);
  assert.equal(archive.contentHash, `sha256:${createHash("sha256").update(archive.bytes).digest("hex")}`);
});

test("prebuilt archive freezes exact POSIX USTAR headers, order, payload, padding, and terminators", async () => {
  const { snapshot } = await representativeSnapshot();
  const archive = createDeterministicPrebuiltArchive(snapshot);
  const tar = gunzipSync(archive.bytes);
  const entries = inspectTar(tar);

  assert.deepEqual(entries.map((entry) => entry.path), [
    "taproot-docs-prebuilt-manifest.json",
    ...snapshot.manifest.files.map((file) => file.path),
  ]);
  assert.deepEqual(entries[0].content, Buffer.from(serializePrebuiltManifest(snapshot.manifest)));
  for (const [index, file] of snapshot.files.entries()) {
    assert.deepEqual(entries[index + 1].content, Buffer.from(file.content));
  }
  assert.deepEqual(storedBlockLengths(archive.bytes), [tar.byteLength]);
  assert.equal(archive.bytes.readUInt32LE(archive.byteLength - 4), tar.byteLength >>> 0);
});

test("prebuilt archive uses USTAR prefix splitting and greedy 65,535-byte stored blocks", async () => {
  const { fixture } = await representativeSnapshot();
  const manifest = JSON.parse(Buffer.from(fixture.manifest).toString("utf8"));
  const longPrefix = `${"a".repeat(70)}/${"b".repeat(70)}`;
  const longPath = `${longPrefix}/large.txt`;
  const content = Buffer.alloc((DEFLATE_STORED_BLOCK_BYTES * 2) + 17, 0x61);
  manifest.files.push({
    bytes: content.byteLength,
    mediaType: "text/plain; charset=utf-8",
    path: longPath,
    sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`,
  });
  manifest.files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const files = [...fixture.files, { path: longPath, content }];
  const result = await validatePrebuiltArtifact(manifest, files);
  assert.equal(result.ok, true);

  const archive = createDeterministicPrebuiltArchive(result.value);
  const tar = gunzipSync(archive.bytes);
  const entry = inspectTar(tar).find((candidate) => candidate.path === longPath);

  assert.equal(entry.prefix, longPrefix);
  assert.equal(entry.name, "large.txt");
  assert.ok(storedBlockLengths(archive.bytes).length >= 3);
});

test("prebuilt archive rejects a validated snapshot whose payload bytes were changed", async () => {
  const { snapshot } = await representativeSnapshot();
  snapshot.files[0].content[0] ^= 0xff;

  assert.throws(
    () => createDeterministicPrebuiltArchive(snapshot),
    (error) => error?.code === "archive.hash_drift" && error?.field === snapshot.files[0].path,
  );
});

test("prebuilt archive cannot encode a payload beneath its manifest entry", async () => {
  const { snapshot } = await representativeSnapshot();
  snapshot.manifest.files[1].path = "taproot-docs-prebuilt-manifest.json/payload.js";

  assert.throws(
    () => createDeterministicPrebuiltArchive(snapshot),
    (error) => error?.errors?.some((item) => item.code === "path.manifest"),
  );
});
