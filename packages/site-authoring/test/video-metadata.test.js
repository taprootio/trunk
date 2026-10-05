import assert from "node:assert/strict";
import test from "node:test";

import { sniffVideoContentType, VIDEO_CONTENT_TYPES, VIDEO_EXTENSIONS } from "../src/video-metadata.js";

function box(brand, size = 64) {
  const bytes = Buffer.alloc(size);
  bytes.writeUInt32BE(24, 0);
  bytes.write("ftyp", 4, "ascii");
  bytes.write(brand, 8, "ascii");
  return bytes;
}

function ebml(docType) {
  const bytes = Buffer.alloc(128, 0x11);
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(bytes, 0);
  bytes.write(docType, 24, "ascii");
  return bytes;
}

test("MP4 brands read as video/mp4 and the QuickTime brand as video/quicktime", () => {
  for (const brand of ["isom", "mp42", "avc1", "M4V "]) {
    assert.equal(sniffVideoContentType(box(brand)), VIDEO_CONTENT_TYPES.mp4, brand);
  }
  assert.equal(sniffVideoContentType(box("qt  ")), VIDEO_CONTENT_TYPES.quicktime);
});

test("other ISO base media files are not videos this upload accepts", () => {
  for (const brand of ["heic", "heix", "mif1", "avif", "M4A ", "3gp4", "crx "]) {
    assert.equal(sniffVideoContentType(box(brand)), undefined, brand);
  }
});

test("a WebM is recognized by its EBML DocType and a Matroska file is not", () => {
  assert.equal(sniffVideoContentType(ebml("webm")), VIDEO_CONTENT_TYPES.webm);
  assert.equal(sniffVideoContentType(ebml("matroska")), undefined);
});

test("only the declared prefix decides: other containers and short inputs are not claimed", () => {
  assert.equal(sniffVideoContentType(Buffer.from("RIFF....AVI LIST")), undefined);
  assert.equal(sniffVideoContentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), undefined);
  assert.equal(sniffVideoContentType(Buffer.alloc(0)), undefined);
  assert.equal(sniffVideoContentType(Buffer.from("ftyp")), undefined);
  assert.equal(sniffVideoContentType(Buffer.from([0x1a, 0x45, 0xdf])), undefined);
});

test("the directory walk offers the three video extensions", () => {
  assert.deepEqual([...VIDEO_EXTENSIONS], [".mp4", ".mov", ".webm"]);
});
