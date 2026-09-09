import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import test from "node:test";

import { createDeterministicArchive, createReleaseArchive } from "../src/archive.js";

function tarPaths(tar) {
  const paths = [];
  let offset = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const stringField = (start, end) => {
      const field = header.subarray(start, end);
      const nullOffset = field.indexOf(0);
      return field.subarray(0, nullOffset < 0 ? field.length : nullOffset).toString("ascii");
    };
    const name = stringField(0, 100);
    const prefix = stringField(345, 500);
    assert.equal(header.subarray(257, 263).toString("ascii"), "ustar\0");
    assert.equal(header.subarray(263, 265).toString("ascii"), "00");
    assert.equal(header[156], 0x30);
    assert.equal(Number.parseInt(stringField(100, 108), 8), 0o644);
    assert.equal(Number.parseInt(stringField(108, 116), 8), 0);
    assert.equal(Number.parseInt(stringField(116, 124), 8), 0);
    assert.equal(Number.parseInt(stringField(136, 148), 8), 0);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const checksum = checksumHeader.reduce((total, byte) => total + byte, 0);
    assert.equal(Number.parseInt(stringField(148, 156), 8), checksum);
    paths.push(prefix ? `${prefix}/${name}` : name);
    const size = Number.parseInt(stringField(124, 136).trim(), 8);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(tar.subarray(offset, offset + 1024).every((byte) => byte === 0));
  assert.equal(offset + 1024, tar.byteLength);
  return paths;
}

test("creates byte-identical closed archives with canonical file ordering", () => {
  const snapshot = {
    entries: [
      { path: "taproot-docs-manifest.json", content: Buffer.from("{}\n") },
      { path: "taproot-docs/fragments/z.html", content: Buffer.from("z") },
      { path: "taproot-docs/fragments/a.html", content: Buffer.from("a") },
    ],
  };
  const first = createDeterministicArchive(snapshot);
  const second = createDeterministicArchive(snapshot);

  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.bytes[3], 0);
  assert.deepEqual([...first.bytes.subarray(4, 8)], [0, 0, 0, 0]);
  assert.equal(first.bytes[9], 0xff);
  assert.deepEqual(tarPaths(gunzipSync(first.bytes)), [
    "taproot-docs-manifest.json",
    "taproot-docs/fragments/a.html",
    "taproot-docs/fragments/z.html",
  ]);
});

test("uses POSIX USTAR prefix fields and rejects paths outside that closed envelope", () => {
  const representable = `taproot-docs/${"a".repeat(120)}/${"b".repeat(90)}.html`;
  const archive = createDeterministicArchive({
    entries: [
      { path: "taproot-docs-manifest.json", content: Buffer.from("{}\n") },
      { path: representable, content: Buffer.from("ok") },
    ],
  });
  assert.deepEqual(tarPaths(gunzipSync(archive.bytes)), ["taproot-docs-manifest.json", representable]);

  const unrepresentable = `taproot-docs/${"a".repeat(156)}/${"b".repeat(101)}`;
  assert.throws(
    () => createDeterministicArchive({
      entries: [
        { path: "taproot-docs-manifest.json", content: Buffer.from("{}\n") },
        { path: unrepresentable, content: Buffer.from("no") },
      ],
    }),
    (error) => error?.code === "archive.path_unrepresentable" && error?.field === unrepresentable,
  );
});

test("rejects duplicate snapshot paths instead of creating an ambiguous tar", () => {
  assert.throws(
    () => createDeterministicArchive({
      entries: [
        { path: "taproot-docs-manifest.json", content: Buffer.from("{}\n") },
        { path: "taproot-docs-manifest.json", content: Buffer.from("other") },
      ],
    }),
    (error) => error?.code === "archive.inventory",
  );
});

test("rejects non-ASCII paths and inventory outside the closed Docs namespace", () => {
  for (const entryPath of ["taproot-docs/fragments/café.html", "outside.txt"]) {
    assert.throws(
      () => createDeterministicArchive({
        entries: [
          { path: "taproot-docs-manifest.json", content: Buffer.from("{}\n") },
          { path: entryPath, content: Buffer.from("no") },
        ],
      }),
      (error) => error?.code === (entryPath.startsWith("taproot-docs/") ? "archive.path_unrepresentable" : "archive.inventory"),
    );
  }
});

const PREBUILT_FILES = [
  { path: "404.html", mediaType: "text/html; charset=utf-8", content: "<!doctype html><title>Missing</title>\n" },
  { path: "index.html", mediaType: "text/html; charset=utf-8", content: "<!doctype html><title>Home</title>\n" },
];

function prebuiltSnapshot(files = PREBUILT_FILES) {
  return {
    mode: "prebuilt",
    manifest: {
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
      redirects: [],
      resources: [{ file: "index.html", key: "home", title: "Espalier controls" }],
      schemaVersion: 1,
      source: {
        provider: "github",
        ref: "refs/heads/main",
        repository: "taprootio/taproot-controls",
        repositoryId: "934883082",
        repositoryUrl: "https://github.com/taprootio/taproot-controls",
        revision: "0123456789abcdef0123456789abcdef01234567",
      },
    },
    files: files.map((file) => ({ path: file.path, content: Buffer.from(file.content, "utf8") })),
  };
}

test("packs prebuilt output into its own deterministic container", () => {
  const snapshot = prebuiltSnapshot();
  const first = createReleaseArchive(snapshot);
  const second = createReleaseArchive(snapshot);

  assert.equal(first.mode, "prebuilt");
  assert.equal(first.format, "taproot-docs-prebuilt-tar-gzip-v1");
  assert.equal(first.byteLength, first.bytes.byteLength);
  assert.match(first.contentHash, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.contentHash, second.contentHash);
  // The prebuilt container carries its own canonical manifest name and the
  // declared payload paths at the archive root, with no `taproot-docs/` prefix.
  assert.deepEqual(tarPaths(gunzipSync(first.bytes)), [
    "taproot-docs-prebuilt-manifest.json",
    "404.html",
    "index.html",
  ]);
});

test("packs managed output into the managed container with the same result shape", () => {
  const managed = createReleaseArchive({
    mode: "managed",
    entries: [
      { path: "taproot-docs-manifest.json", content: Buffer.from("{}\n") },
      { path: "taproot-docs/fragments/a.html", content: Buffer.from("a") },
    ],
  });
  const untagged = createReleaseArchive({
    entries: [
      { path: "taproot-docs-manifest.json", content: Buffer.from("{}\n") },
      { path: "taproot-docs/fragments/a.html", content: Buffer.from("a") },
    ],
  });

  assert.equal(managed.mode, "managed");
  assert.equal(managed.format, "taproot-docs-tar-gzip-v1");
  // An absent mode is the managed default and produces byte-identical output.
  assert.equal(untagged.contentHash, managed.contentHash);
  assert.deepEqual(untagged.bytes, managed.bytes);
});

test("surfaces prebuilt packing faults with stable archive codes", () => {
  const driftedSize = prebuiltSnapshot();
  driftedSize.files[1] = { path: "index.html", content: Buffer.from("shorter\n", "utf8") };
  assert.throws(
    () => createReleaseArchive(driftedSize),
    (error) => error?.code === "archive.size_drift" && error?.field === "index.html",
  );

  const driftedBytes = prebuiltSnapshot();
  driftedBytes.files[1] = {
    path: "index.html",
    content: Buffer.from("<!doctype html><title>Away</title>\n", "utf8"),
  };
  assert.throws(
    () => createReleaseArchive(driftedBytes),
    (error) => error?.code === "archive.hash_drift" && error?.field === "index.html",
  );

  const undeclared = prebuiltSnapshot();
  undeclared.files.push({ path: "extra.html", content: Buffer.from("extra\n", "utf8") });
  assert.throws(
    () => createReleaseArchive(undeclared),
    (error) => error?.code === "archive.inventory",
  );
});

test("refuses an oversized prebuilt artifact from its declared inventory alone", () => {
  const oversized = prebuiltSnapshot();
  // The declared byte length alone exceeds the upload bound, so the container is
  // never materialized and no payload of that size is ever allocated.
  oversized.manifest.files[1] = { ...oversized.manifest.files[1], bytes: 256 * 1024 * 1024 };
  assert.throws(
    () => createReleaseArchive(oversized),
    (error) => error?.code === "archive.compressed_too_large",
  );

  // A declared inventory inside the bound still reaches the packer, where the
  // exact container length remains authoritative.
  assert.equal(createReleaseArchive(prebuiltSnapshot()).mode, "prebuilt");
});

test("refuses to pack a snapshot outside the closed publication modes", () => {
  assert.throws(
    () => createReleaseArchive({ mode: "static", entries: [] }),
    (error) => error?.code === "archive.mode_unsupported" && error?.field === "mode",
  );
});
