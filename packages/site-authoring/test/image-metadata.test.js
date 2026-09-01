import assert from "node:assert/strict";
import test from "node:test";

import { contentHash, IMAGE_CONTENT_TYPES, inspectImageBytes } from "../src/image-metadata.js";

function png(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function jpeg(width, height, { leadingSegments = 1 } = {}) {
  const frame = Buffer.alloc(11);
  frame[0] = 0xff;
  frame[1] = 0xc0;
  frame.writeUInt16BE(9, 2);
  frame[4] = 8;
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  frame[9] = 1;
  // An APP0 segment ahead of the frame header, because real JPEGs always carry
  // metadata the reader has to step over rather than decode.
  const application = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...Array.from({ length: leadingSegments }, () => application),
    frame,
  ]);
}

function gif(width, height, signature = "GIF89a") {
  const bytes = Buffer.alloc(13);
  bytes.write(signature, 0, "ascii");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

function webpHeader(fourcc) {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write(fourcc, 12, "ascii");
  bytes.writeUInt32LE(10, 16);
  return bytes;
}

function webpLossy(width, height) {
  const bytes = webpHeader("VP8 ");
  bytes[23] = 0x9d;
  bytes[24] = 0x01;
  bytes[25] = 0x2a;
  bytes.writeUInt16LE(width, 26);
  bytes.writeUInt16LE(height, 28);
  return bytes;
}

function webpLossless(width, height) {
  const bytes = webpHeader("VP8L");
  bytes[20] = 0x2f;
  bytes.writeUInt32LE((((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)) >>> 0, 21);
  return bytes;
}

function webpExtended(width, height) {
  const bytes = webpHeader("VP8X");
  bytes[20] = 0x10;
  bytes[24] = (width - 1) & 0xff;
  bytes[25] = ((width - 1) >> 8) & 0xff;
  bytes[26] = ((width - 1) >> 16) & 0xff;
  bytes[27] = (height - 1) & 0xff;
  bytes[28] = ((height - 1) >> 8) & 0xff;
  bytes[29] = ((height - 1) >> 16) & 0xff;
  return bytes;
}

test("reads dimensions out of every container the image service accepts", async (testContext) => {
  const cases = [
    { name: "PNG", bytes: png(1200, 800), contentType: IMAGE_CONTENT_TYPES.png, width: 1200, height: 800 },
    { name: "PNG 1x1", bytes: png(1, 1), contentType: IMAGE_CONTENT_TYPES.png, width: 1, height: 1 },
    { name: "JPEG", bytes: jpeg(640, 480), contentType: IMAGE_CONTENT_TYPES.jpeg, width: 640, height: 480 },
    {
      name: "JPEG behind several metadata segments",
      bytes: jpeg(300, 200, { leadingSegments: 6 }),
      contentType: IMAGE_CONTENT_TYPES.jpeg,
      width: 300,
      height: 200,
    },
    { name: "GIF89a", bytes: gif(48, 24), contentType: IMAGE_CONTENT_TYPES.gif, width: 48, height: 24 },
    { name: "GIF87a", bytes: gif(16, 32, "GIF87a"), contentType: IMAGE_CONTENT_TYPES.gif, width: 16, height: 32 },
    { name: "WebP lossy", bytes: webpLossy(500, 250), contentType: IMAGE_CONTENT_TYPES.webp, width: 500, height: 250 },
    {
      name: "WebP lossless",
      bytes: webpLossless(1024, 768),
      contentType: IMAGE_CONTENT_TYPES.webp,
      width: 1024,
      height: 768,
    },
    {
      name: "WebP extended",
      bytes: webpExtended(2400, 1600),
      contentType: IMAGE_CONTENT_TYPES.webp,
      width: 2400,
      height: 1600,
    },
  ];
  for (const scenario of cases) {
    await testContext.test(scenario.name, () => {
      assert.deepEqual(inspectImageBytes(scenario.bytes, "fixture"), {
        contentType: scenario.contentType,
        width: scenario.width,
        height: scenario.height,
      });
    });
  }
});

test("refuses a container Taproot does not accept, naming the file", async (testContext) => {
  const cases = [
    { name: "SVG", bytes: Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><script/></svg>") },
    { name: "PDF", bytes: Buffer.from("%PDF-1.7\n%âãÏÓ\n") },
    { name: "TIFF", bytes: Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]) },
    { name: "BMP", bytes: Buffer.from([0x42, 0x4d, 0x36, 0x00, 0x00, 0x00]) },
    { name: "plain text", bytes: Buffer.from("not an image at all") },
    { name: "empty", bytes: Buffer.alloc(0) },
  ];
  for (const scenario of cases) {
    await testContext.test(scenario.name, () => {
      assert.throws(
        () => inspectImageBytes(scenario.bytes, "media/thing.bin"),
        (error) => error?.code === "media.unsupported_format" && error?.field === "media/thing.bin",
      );
    });
  }
});

function corrupt(bytes, offset, replacement) {
  if (typeof replacement === "string") bytes.write(replacement, offset, "ascii");
  else bytes[offset] = replacement;
  return bytes;
}

test("refuses a recognized container whose header cannot be read", async (testContext) => {
  const cases = [
    { name: "truncated PNG", bytes: png(10, 10).subarray(0, 18) },
    { name: "PNG without IHDR", bytes: corrupt(png(10, 10), 12, "IDAT") },
    { name: "JPEG with no frame header", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]) },
    { name: "truncated GIF", bytes: gif(10, 10).subarray(0, 7) },
    { name: "WebP with an unknown chunk", bytes: webpHeader("ANIM") },
    { name: "WebP lossless without its signature", bytes: corrupt(webpLossless(4, 4), 20, 0x00) },
    { name: "WebP lossy without its sync code", bytes: corrupt(webpLossy(4, 4), 23, 0x00) },
    { name: "zero-sized WebP", bytes: webpLossy(0, 0) },
  ];
  for (const scenario of cases) {
    await testContext.test(scenario.name, () => {
      assert.throws(
        () => inspectImageBytes(scenario.bytes, "media/broken.png"),
        (error) => error?.code === "media.dimensions_unreadable" && error?.field === "media/broken.png",
      );
    });
  }
});

test("hashes content with SHA-256 so the dedup short-circuit is keyed on the bytes", () => {
  // The known digest of the empty input pins the algorithm itself: a swap to
  // any other hash would still produce 64 hex characters.
  assert.equal(
    contentHash(Buffer.alloc(0)),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.match(contentHash(Buffer.from("taproot")), /^[0-9a-f]{64}$/u);
  assert.notEqual(contentHash(Buffer.from("taproot")), contentHash(Buffer.from("taproo")));
  assert.equal(contentHash(png(4, 4)), contentHash(png(4, 4)));
});
