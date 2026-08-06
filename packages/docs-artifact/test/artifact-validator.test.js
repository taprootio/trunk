import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { deflateSync } from "node:zlib";
import { LIMITS } from "../src/constants.js";
import { validateArtifact } from "../src/artifact-validator.js";

const manifestUrl = new URL("../fixtures/valid/minimal/taproot-docs-manifest.json", import.meta.url);
const fragmentUrl = new URL("../fixtures/valid/minimal/taproot-docs/fragments/welcome.html", import.meta.url);
const pngBase64Url = new URL("../fixtures/valid/complete/taproot-docs/assets/pixel.png.base64", import.meta.url);

async function minimalManifest() {
  return JSON.parse(await readFile(manifestUrl, "utf8"));
}

function changingSchemaVersion(manifest) {
  let reads = 0;
  Object.defineProperty(manifest, "schemaVersion", {
    enumerable: true,
    get() {
      reads += 1;
      return reads;
    },
  });
  return { input: manifest, reads: () => reads };
}

function singleReadProxy(manifest) {
  const reads = new Map();
  return {
    input: new Proxy(manifest, {
      get(target, key, receiver) {
        if (typeof key === "string") {
          const count = (reads.get(key) ?? 0) + 1;
          reads.set(key, count);
          if (count > 1) throw new Error(`Property '${key}' was read more than once.`);
        }
        return Reflect.get(target, key, receiver);
      },
    }),
    reads,
  };
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const REAL_JPEG = Buffer.from([
  0xff, 0xd8,
  0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xdb, 0x00, 0x43, 0x00, ...Array(64).fill(0x01),
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03,
  0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, ...Array(15).fill(0x00), 0x00,
  0xff, 0xc4, 0x00, 0x14, 0x10, 0x01, ...Array(15).fill(0x00), 0x00,
  0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x00, 0x3f, 0x00,
  0x03, 0xff, 0xd9,
]);

function jpeg(width = 1, height = 1) {
  const bytes = Buffer.from(REAL_JPEG);
  const frameOffset = bytes.indexOf(Buffer.from([0xff, 0xc0]));
  bytes.writeUInt16BE(height, frameOffset + 5);
  bytes.writeUInt16BE(width, frameOffset + 7);
  return bytes;
}

function jpegHuffmanSegment(tableClass, counts, symbols) {
  const payload = Buffer.from([(tableClass << 4), ...counts, ...symbols]);
  const header = Buffer.from([0xff, 0xc4, 0x00, 0x00]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

function replaceJpegSegment(bytes, offset, replacement) {
  const segmentEnd = offset + 2 + bytes.readUInt16BE(offset + 2);
  return Buffer.concat([bytes.subarray(0, offset), replacement, bytes.subarray(segmentEnd)]);
}

function jpegWithEntropy(bytes, entropy, restartInterval) {
  const scanOffset = bytes.indexOf(Buffer.from([0xff, 0xda]));
  const entropyOffset = scanOffset + 2 + bytes.readUInt16BE(scanOffset + 2);
  const endOffset = bytes.lastIndexOf(Buffer.from([0xff, 0xd9]));
  const restartDefinition = restartInterval === undefined
    ? Buffer.alloc(0)
    : Buffer.from([0xff, 0xdd, 0x00, 0x04, restartInterval >>> 8, restartInterval & 0xff]);
  return Buffer.concat([
    bytes.subarray(0, scanOffset),
    restartDefinition,
    bytes.subarray(scanOffset, entropyOffset),
    Buffer.from(entropy),
    bytes.subarray(endOffset),
  ]);
}

function jpegSegment(bytes, offset) {
  const end = offset + 2 + bytes.readUInt16BE(offset + 2);
  return Buffer.from(bytes.subarray(offset, end));
}

function jpegScan({ components, selectors = [], spectralEnd = 63, restartMarkers = 0 }) {
  const length = 6 + (2 * components.length);
  const scan = Buffer.alloc(2 + length);
  scan.set([0xff, 0xda], 0);
  scan.writeUInt16BE(length, 2);
  scan[4] = components.length;
  for (let index = 0; index < components.length; index += 1) {
    scan[5 + (2 * index)] = components[index];
    scan[6 + (2 * index)] = selectors[index] ?? 0;
  }
  const spectralOffset = 5 + (2 * components.length);
  scan[spectralOffset] = 0;
  scan[spectralOffset + 1] = spectralEnd;
  scan[spectralOffset + 2] = 0;
  const entropyByte = (1 << (8 - (2 * components.length))) - 1;
  const entropy = [];
  for (let index = 0; index <= restartMarkers; index += 1) {
    entropy.push(entropyByte);
    if (index < restartMarkers) entropy.push(0xff, 0xd0 + (index & 0x07));
  }
  return Buffer.concat([scan, Buffer.from(entropy)]);
}

function sequentialJpeg(fault = "multi-scan") {
  const bytes = jpeg();
  const quantizationOffset = bytes.indexOf(Buffer.from([0xff, 0xdb]));
  const frameOffset = bytes.indexOf(Buffer.from([0xff, 0xc0]));
  const dcHuffmanOffset = bytes.indexOf(Buffer.from([0xff, 0xc4]));
  const acHuffmanOffset = bytes.indexOf(Buffer.from([0xff, 0xc4]), dcHuffmanOffset + 2);
  const scanOffset = bytes.indexOf(Buffer.from([0xff, 0xda]));
  const endOffset = bytes.lastIndexOf(Buffer.from([0xff, 0xd9]));
  bytes[frameOffset + 15] = 1;
  const restartGeometry = ["multi-scan-restarts", "multi-scan-restart-cardinality"].includes(fault);
  if (restartGeometry) {
    bytes.writeUInt16BE(17, frameOffset + 7);
    bytes[frameOffset + 11] = 0x21;
  }
  let firstScanRestartMarkers = 0;
  if (fault === "multi-scan-restarts") firstScanRestartMarkers = 2;
  else if (fault === "multi-scan-restart-cardinality") firstScanRestartMarkers = 1;
  const lateQuantization = jpegSegment(bytes, quantizationOffset);
  lateQuantization[4] = 1;
  const metadata = Buffer.concat([
    ...(fault === "multi-scan-missing-quantization" ? [] : [lateQuantization]),
    jpegSegment(bytes, dcHuffmanOffset),
    jpegSegment(bytes, acHuffmanOffset),
    Buffer.from([0xff, 0xdd, 0x00, 0x04, 0x00, 0x02]),
  ]);
  const scans = [
    jpegScan({
      components: [1],
      restartMarkers: firstScanRestartMarkers,
    }),
    metadata,
    jpegScan({
      components: [2],
      selectors: fault === "multi-scan-missing-huffman" ? [0x11] : [],
      spectralEnd: fault === "multi-scan-spectral" ? 62 : 63,
    }),
  ];
  if (fault === "multi-scan-duplicate") scans.push(jpegScan({ components: [2] }));
  if (fault !== "multi-scan-missing") scans.push(jpegScan({ components: [3] }));
  const initialRestart = restartGeometry ? Buffer.from([0xff, 0xdd, 0x00, 0x04, 0x00, 0x01]) : Buffer.alloc(0);
  return Buffer.concat([bytes.subarray(0, scanOffset), initialRestart, ...scans, bytes.subarray(endOffset)]);
}

function malformedJpeg(fault) {
  let bytes = jpeg();
  const quantizationOffset = bytes.indexOf(Buffer.from([0xff, 0xdb]));
  const frameOffset = bytes.indexOf(Buffer.from([0xff, 0xc0]));
  const dcHuffmanOffset = bytes.indexOf(Buffer.from([0xff, 0xc4]));
  const acHuffmanOffset = bytes.indexOf(Buffer.from([0xff, 0xc4]), dcHuffmanOffset + 2);
  const counts = Array(16).fill(0);
  if (fault.startsWith("multi-scan")) return sequentialJpeg(fault);
  if (fault === "dqt-after-sof") {
    const quantizationEnd = quantizationOffset + 2 + bytes.readUInt16BE(quantizationOffset + 2);
    const quantization = bytes.subarray(quantizationOffset, quantizationEnd);
    bytes = Buffer.concat([bytes.subarray(0, quantizationOffset), bytes.subarray(quantizationEnd)]);
    const relocatedFrameOffset = bytes.indexOf(Buffer.from([0xff, 0xc0]));
    const frameEnd = relocatedFrameOffset + 2 + bytes.readUInt16BE(relocatedFrameOffset + 2);
    return Buffer.concat([bytes.subarray(0, frameEnd), quantization, bytes.subarray(frameEnd)]);
  }
  if (fault === "dqt-16-bit") {
    const payload = Buffer.from([0x10, ...Array(128).fill(0x01)]);
    const header = Buffer.from([0xff, 0xdb, 0x00, 0x00]);
    header.writeUInt16BE(payload.length + 2, 2);
    return replaceJpegSegment(bytes, quantizationOffset, Buffer.concat([header, payload]));
  }
  if (fault === "dqt-zero") bytes[quantizationOffset + 5] = 0;
  if (fault === "dht-oversubscribed") {
    counts[0] = 3;
    return replaceJpegSegment(bytes, dcHuffmanOffset, jpegHuffmanSegment(0, counts, [0, 1, 2]));
  }
  if (fault === "dht-exhausted") {
    counts[0] = 2;
    return replaceJpegSegment(bytes, dcHuffmanOffset, jpegHuffmanSegment(0, counts, [0, 1]));
  }
  if (fault === "dht-all-ones") {
    counts[0] = 1;
    counts[1] = 2;
    return replaceJpegSegment(bytes, dcHuffmanOffset, jpegHuffmanSegment(0, counts, [0, 1, 2]));
  }
  if (fault === "dht-too-many") {
    counts[8] = 255;
    counts[9] = 2;
    return replaceJpegSegment(bytes, dcHuffmanOffset, jpegHuffmanSegment(0, counts, Buffer.alloc(257)));
  }
  if (fault === "dht-invalid-dc") {
    counts[0] = 1;
    return replaceJpegSegment(bytes, dcHuffmanOffset, jpegHuffmanSegment(0, counts, [12]));
  }
  if (fault === "dht-invalid-ac" || fault === "dht-zero-size-ac") {
    counts[0] = 1;
    return replaceJpegSegment(bytes, acHuffmanOffset, jpegHuffmanSegment(1, counts, [fault === "dht-invalid-ac" ? 0x0b : 0x10]));
  }
  if (fault === "rst-only") {
    bytes.writeUInt16BE(9, frameOffset + 7);
    return jpegWithEntropy(bytes, [0xff, 0xd0], 1);
  }
  if (fault === "rst-consecutive") {
    bytes.writeUInt16BE(17, frameOffset + 7);
    return jpegWithEntropy(bytes, [0x03, 0xff, 0xd0, 0xff, 0xd1, 0x03], 1);
  }
  if (fault === "rst-no-final-entropy") {
    bytes.writeUInt16BE(9, frameOffset + 7);
    return jpegWithEntropy(bytes, [0x03, 0xff, 0xd0], 1);
  }
  if (fault === "stuffing-multiple-ff") return jpegWithEntropy(bytes, [0x03, 0xff, 0xff, 0x00, 0x03]);
  if (fault === "fill-before-eoi") return jpegWithEntropy(bytes, [0x03, 0xff]);
  if (fault === "fill-before-rst") {
    bytes.writeUInt16BE(9, frameOffset + 7);
    return jpegWithEntropy(bytes, [0x03, 0xff, 0xff, 0xd0, 0x03], 1);
  }
  if (fault === "rst-missing") {
    bytes.writeUInt16BE(17, frameOffset + 7);
    return jpegWithEntropy(bytes, [0x03, 0xff, 0xd0, 0x03], 1);
  }
  if (fault === "rst-excess") {
    bytes.writeUInt16BE(9, frameOffset + 7);
    return jpegWithEntropy(bytes, [0x03, 0xff, 0xd0, 0x03, 0xff, 0xd1, 0x03], 1);
  }
  if (fault === "rst-exact") {
    bytes.writeUInt16BE(17, frameOffset + 7);
    return jpegWithEntropy(bytes, [0x03, 0xff, 0xd0, 0x03, 0xff, 0xd1, 0x03], 1);
  }
  if (fault === "rst-interval-over-mcus") return jpegWithEntropy(bytes, [0x03], 2);
  if (fault === "sampling-units") {
    bytes[frameOffset + 11] = 0x44;
    bytes[frameOffset + 14] = 0x44;
    bytes[frameOffset + 17] = 0x44;
  }
  return bytes;
}

const REAL_VP8_PAYLOAD = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEALmk0mk0iIiIiIgBoSygAAA==", "base64").subarray(20);
const REAL_VP8L_PAYLOAD = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64").subarray(20, 33);

function vp8lPayload(width = 1, height = 1, alphaUsed = false) {
  if (width === 1 && height === 1) {
    const payload = Buffer.from(REAL_VP8L_PAYLOAD);
    payload[4] = (payload[4] & 0x0f) | (alphaUsed ? 0x10 : 0);
    return payload;
  }
  const encodedWidth = width - 1;
  const encodedHeight = height - 1;
  return Buffer.from([
    0x2f,
    encodedWidth & 0xff,
    ((encodedWidth >> 8) & 0x3f) | ((encodedHeight & 0x03) << 6),
    (encodedHeight >> 2) & 0xff,
    ((encodedHeight >> 10) & 0x0f) | (alphaUsed ? 0x10 : 0),
    0x00,
  ]);
}

function vp8Payload(width = 1, height = 1) {
  if (width === 1 && height === 1) return Buffer.from(REAL_VP8_PAYLOAD);
  const payload = Buffer.alloc(12);
  payload.set([0x30, 0x00, 0x00, 0x9d, 0x01, 0x2a]);
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return payload;
}

function alphaPayload(width, height, header = 0, dataLength = width * height) {
  return Buffer.concat([Buffer.from([header]), Buffer.alloc(dataLength, 0xff)]);
}

function webpChunk(type, data, padByte = 0) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, "ascii");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, ...(data.length % 2 === 1 ? [Buffer.from([padByte])] : [])]);
}

function webpContainer(chunks) {
  const content = Buffer.concat(chunks);
  const riffHeader = Buffer.alloc(12);
  riffHeader.write("RIFF", 0, 4, "ascii");
  riffHeader.writeUInt32LE(4 + content.length, 4);
  riffHeader.write("WEBP", 8, 4, "ascii");
  return Buffer.concat([riffHeader, content]);
}

function webp(width = 1, height = 1) {
  return webpContainer([webpChunk("VP8L", vp8lPayload(width, height, width === 1 && height === 1))]);
}

function animatedWebp(frames, options = {}) {
  const {
    canvasWidth = 1,
    canvasHeight = 1,
    frameX = 0,
    frameY = 0,
    frameWidth = 1,
    frameHeight = 1,
    embeddedWidth = frameWidth,
    embeddedHeight = frameHeight,
    frameFlags = 0,
    extendedFlags = 0x02,
    embeddedAlphaUsed = false,
    nestedOrder = ["VP8 "],
    topOrder = ["VP8X", "ANIM", "ANMF"],
    nestedPadByte = 0,
    topPadByte = 0,
    alphaHeader = 0,
    alphaDataLength,
  } = options;
  const extendedHeader = Buffer.alloc(10);
  extendedHeader[0] = extendedFlags;
  extendedHeader.writeUIntLE(canvasWidth - 1, 4, 3);
  extendedHeader.writeUIntLE(canvasHeight - 1, 7, 3);
  const frameHeader = Buffer.alloc(16);
  frameHeader.writeUIntLE(frameX / 2, 0, 3);
  frameHeader.writeUIntLE(frameY / 2, 3, 3);
  frameHeader.writeUIntLE(frameWidth - 1, 6, 3);
  frameHeader.writeUIntLE(frameHeight - 1, 9, 3);
  frameHeader[15] = frameFlags;
  const nestedChunks = nestedOrder.map((type) => {
    if (type === "ALPH") return webpChunk(type, alphaPayload(frameWidth, frameHeight, alphaHeader, alphaDataLength), nestedPadByte);
    if (type === "VP8 ") return webpChunk(type, vp8Payload(embeddedWidth, embeddedHeight), nestedPadByte);
    if (type === "VP8L") return webpChunk(type, vp8lPayload(embeddedWidth, embeddedHeight, embeddedAlphaUsed), nestedPadByte);
    return webpChunk(type, Buffer.from([0]), nestedPadByte);
  });
  const framePayload = Buffer.concat([
    frameHeader,
    ...nestedChunks,
  ]);
  const chunks = topOrder.flatMap((type) => {
    if (type === "VP8X") return [webpChunk(type, extendedHeader)];
    if (type === "ANIM") return [webpChunk(type, Buffer.alloc(6))];
    if (type === "ANMF") return Array.from({ length: frames }, () => webpChunk(type, framePayload));
    if (type === "VP8 ") return [webpChunk(type, vp8Payload(canvasWidth, canvasHeight))];
    if (type === "VP8L") return [webpChunk(type, vp8lPayload(canvasWidth, canvasHeight, embeddedAlphaUsed))];
    if (type === "ALPH") return [webpChunk(type, alphaPayload(canvasWidth, canvasHeight, alphaHeader, alphaDataLength), topPadByte)];
    return [webpChunk(type, Buffer.from([0]), topPadByte)];
  });
  return webpContainer(chunks);
}

function gif(width = 1, height = 1, frames = 1, palette = "global") {
  const header = Buffer.alloc(13);
  header.write("GIF89a", 0, 6, "ascii");
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  if (palette === "global") header[10] = 0x80;
  const frame = Buffer.from([
    0x2c,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    palette === "local" ? 0x80 : 0x00,
    ...(palette === "local" ? [0x00, 0x00, 0x00, 0xff, 0xff, 0xff] : []),
    0x02, 0x01, 0x4c, 0x00,
  ]);
  frame.writeUInt16LE(width, 5);
  frame.writeUInt16LE(height, 7);
  return Buffer.concat([
    header,
    ...(palette === "global" ? [Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff, 0xff])] : []),
    ...Array.from({ length: frames }, () => frame),
    Buffer.from([0x3b]),
  ]);
}

const PNG_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  return crc >>> 0;
});

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const checksumInput = Buffer.concat([typeBytes, data]);
  let checksum = 0xffffffff;
  for (const byte of checksumInput) checksum = PNG_CRC_TABLE[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE((checksum ^ 0xffffffff) >>> 0, 8 + data.length);
  return chunk;
}

const REAL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const REAL_PNG_IDAT = REAL_PNG.subarray(41, 52);

function pngHeader(width, height, bitDepth = 8, colorType = 4) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([bitDepth, colorType, 0, 0, 0], 8);
  return pngChunk("IHDR", ihdr);
}

function pngFrameControl(sequence, width = 1, height = 1, options = {}) {
  const control = Buffer.alloc(26);
  control.writeUInt32BE(sequence, 0);
  control.writeUInt32BE(width, 4);
  control.writeUInt32BE(height, 8);
  control.writeUInt32BE(options.left ?? 0, 12);
  control.writeUInt32BE(options.top ?? 0, 16);
  control.writeUInt16BE(1, 20);
  control.writeUInt16BE(100, 22);
  control[24] = options.dispose ?? 0;
  control[25] = options.blend ?? 0;
  return pngChunk("fcTL", control);
}

function pngFrameData(sequence, content = REAL_PNG_IDAT) {
  const data = Buffer.alloc(4 + content.length);
  data.writeUInt32BE(sequence, 0);
  content.copy(data, 4);
  return pngChunk("fdAT", data);
}

function pngContainer(chunks) {
  return Buffer.concat([Buffer.from("iVBORw0KGgo=", "base64"), ...chunks]);
}

function pngImageData(width, height, bitDepth = 8, colorType = 4) {
  if (width * height > 4_096 || bitDepth !== 8) return REAL_PNG_IDAT;
  const channels = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]).get(colorType);
  const rowBytes = width * channels;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let row = 0; row < height; row += 1) raw[row * (rowBytes + 1)] = 0;
  return deflateSync(raw);
}

function png(width = 1, height = 1, frames = 1) {
  const chunks = [pngHeader(width, height)];
  const imageData = pngImageData(width, height);
  if (frames > 1) {
    const animationControl = Buffer.alloc(8);
    animationControl.writeUInt32BE(frames, 0);
    chunks.push(pngChunk("acTL", animationControl));
    let sequence = 0;
    chunks.push(pngFrameControl(sequence, width, height));
    sequence += 1;
    chunks.push(pngChunk("IDAT", imageData));
    for (let index = 1; index < frames; index += 1) {
      chunks.push(pngFrameControl(sequence, width, height));
      sequence += 1;
      chunks.push(pngFrameData(sequence, imageData));
      sequence += 1;
    }
  } else {
    chunks.push(pngChunk("IDAT", imageData));
  }
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));
  return pngContainer(chunks);
}

function apng(options = {}) {
  const width = options.width ?? 1;
  const height = options.height ?? 1;
  const frames = options.frames ?? 2;
  const imageData = pngImageData(width, height);
  const animationControl = Buffer.alloc(8);
  animationControl.writeUInt32BE(options.declaredFrames ?? frames, 0);
  const chunks = [pngHeader(width, height), pngChunk("acTL", animationControl)];
  let sequence = options.firstSequence ?? 0;
  chunks.push(pngFrameControl(sequence, width, height, { dispose: options.dispose, blend: options.blend }));
  sequence += 1;
  if (!options.omitFirstData) chunks.push(pngChunk("IDAT", imageData));
  for (let frame = 1; frame < frames; frame += 1) {
    if (options.fdatBeforeControl && frame === 1) chunks.push(pngFrameData(sequence, imageData));
    if (options.sequenceGap && frame === 1) sequence += 1;
    chunks.push(pngFrameControl(sequence, width, height));
    sequence += 1;
    if (!(options.omitSecondData && frame === 1) && !(options.fdatBeforeControl && frame === 1)) {
      chunks.push(pngFrameData(sequence, imageData));
      sequence += 1;
    }
  }
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));
  return pngContainer(chunks);
}

function palettePng(bitDepth, colorType, paletteEntries, placement = "before") {
  const imageData = pngImageData(1, 1, bitDepth, colorType);
  const palette = paletteEntries === undefined ? [] : [pngChunk("PLTE", Buffer.alloc(paletteEntries * 3))];
  const chunks = [pngHeader(1, 1, bitDepth, colorType)];
  if (placement === "before") chunks.push(...palette);
  chunks.push(pngChunk("IDAT", imageData));
  if (placement === "after") chunks.push(...palette);
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));
  return pngContainer(chunks);
}

async function imageCases() {
  return [
    {
      mediaType: "image/gif",
      extension: "gif",
      bytes: Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"),
    },
    {
      mediaType: "image/jpeg",
      extension: "jpg",
      bytes: jpeg(),
    },
    {
      mediaType: "image/png",
      extension: "png",
      bytes: Buffer.from((await readFile(pngBase64Url, "utf8")).trim(), "base64"),
    },
    {
      mediaType: "image/webp",
      extension: "webp",
      bytes: webp(),
    },
  ];
}

async function validateImage(bytes, mediaType, extension, width = 1, height = 1) {
  const manifest = await minimalManifest();
  const path = `taproot-docs/assets/pixel.${extension}`;
  manifest.assets = [{
    key: "image:pixel",
    path,
    mediaType,
    bytes: bytes.length,
    sha256: sha256(bytes),
    width,
    height,
  }];
  return validateArtifact(manifest, [
    {
      path: "taproot-docs/fragments/welcome.html",
      content: await readFile(fragmentUrl),
    },
    { path, content: bytes },
  ]);
}

test("ArtifactFileEntry string content rejects ill-formed Unicode before UTF-8 encoding", async () => {
  const manifest = await minimalManifest();
  const result = await validateArtifact(manifest, [{
    path: "taproot-docs/fragments/welcome.html",
    content: "Invalid \ud800 fragment",
  }]);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "file.invalid_unicode"));
});

test("artifact validation snapshots mutable manifests and binary content before the first await", async (testContext) => {
  for (const contentKind of ["Uint8Array", "ArrayBuffer"]) {
    await testContext.test(contentKind, async () => {
      const manifest = await minimalManifest();
      const original = new Uint8Array(await readFile(fragmentUrl));
      const content = contentKind === "ArrayBuffer" ? original.buffer : original;
      const validation = validateArtifact(manifest, [{
        path: "taproot-docs/fragments/welcome.html",
        content,
      }]);

      manifest.resources[0].variants[0].fragments[0].sha256 = `sha256:${"0".repeat(64)}`;
      manifest.resources[0].variants[0].headings.push({ id: "mutated", text: "mutated after validation started", level: 2 });
      original.fill(0xff);

      const result = await validation;
      assert.equal(result.ok, true);
      assert.deepEqual(result.value.manifest.resources[0].variants[0].headings, []);
    });
  }
});

test("binary file snapshots ignore shadowed byteLength and caller iterators", async () => {
  const manifest = await minimalManifest();
  const declaredContent = await readFile(fragmentUrl);
  const hostile = new Uint8Array([0x3c]);
  let iteratorCalls = 0;
  Object.defineProperty(hostile, "byteLength", { value: declaredContent.byteLength });
  Object.defineProperty(hostile, Symbol.iterator, {
    value: function* hostileIterator() {
      iteratorCalls += 1;
      yield* declaredContent;
    },
  });

  const result = await validateArtifact(manifest, [{
    path: "taproot-docs/fragments/welcome.html",
    content: hostile,
  }]);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "file.size_drift"));
  assert.equal(iteratorCalls, 0);
});

test("binary file snapshots accept cross-realm bytes and reject untrusted binary lookalikes", async (testContext) => {
  const content = new Uint8Array(await readFile(fragmentUrl));
  const values = [...content];
  const validCases = [
    ["cross-realm Uint8Array", runInNewContext("new Uint8Array(values)", { values })],
    ["cross-realm ArrayBuffer", runInNewContext("new Uint8Array(values).buffer", { values })],
  ];
  for (const [name, crossRealmContent] of validCases) {
    await testContext.test(name, async () => {
      const result = await validateArtifact(await minimalManifest(), [{
        path: "taproot-docs/fragments/welcome.html",
        content: crossRealmContent,
      }]);
      assert.equal(result.ok, true);
    });
  }

  const detachedBuffer = content.slice().buffer;
  const detachedView = new Uint8Array(detachedBuffer);
  structuredClone(detachedBuffer, { transfer: [detachedBuffer] });
  const invalidCases = [
    ["spoofed Uint8Array", { byteLength: content.byteLength, [Symbol.toStringTag]: "Uint8Array" }],
    ["proxied Uint8Array", new Proxy(content, {})],
    ["detached Uint8Array", detachedView],
    ["detached ArrayBuffer", detachedBuffer],
  ];
  if (typeof SharedArrayBuffer !== "undefined") {
    const shared = new SharedArrayBuffer(content.byteLength);
    invalidCases.push(["shared Uint8Array", new Uint8Array(shared)], ["SharedArrayBuffer", shared]);
  }
  for (const [name, invalidContent] of invalidCases) {
    await testContext.test(name, async () => {
      const result = await validateArtifact(await minimalManifest(), [{
        path: "taproot-docs/fragments/welcome.html",
        content: invalidContent,
      }]);
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((error) => error.code === "file.invalid_content"));
    });
  }
});

test("artifact validation reads object accessors and Proxy properties only while materializing its snapshot", async () => {
  const content = await readFile(fragmentUrl);
  const changing = changingSchemaVersion(await minimalManifest());
  const changingResult = await validateArtifact(changing.input, [{
    path: "taproot-docs/fragments/welcome.html",
    content,
  }]);
  assert.equal(changingResult.ok, true);
  assert.equal(changing.reads(), 1);
  assert.equal(changingResult.value.manifest.schemaVersion, 1);
  assert.equal(Object.getPrototypeOf(changingResult.value.manifest), null);

  const proxied = singleReadProxy(await minimalManifest());
  const proxyResult = await validateArtifact(proxied.input, [{
    path: "taproot-docs/fragments/welcome.html",
    content,
  }]);
  assert.equal(proxyResult.ok, true);
  assert.equal(proxied.reads.get("schemaVersion"), 1);
  assert.ok([...proxied.reads.values()].every((count) => count === 1));
});

test("image validation requires complete bounded containers for every supported media type", async (testContext) => {
  for (const fixture of await imageCases()) {
    await testContext.test(fixture.mediaType, async () => {
      const validResult = await validateImage(fixture.bytes, fixture.mediaType, fixture.extension);
      assert.equal(validResult.ok, true);

      const truncated = fixture.bytes.subarray(0, fixture.bytes.length - 1);
      const truncatedResult = await validateImage(truncated, fixture.mediaType, fixture.extension);
      assert.equal(truncatedResult.ok, false);
      assert.ok(truncatedResult.errors.some((error) => error.code === "asset.media_mismatch"));
    });
  }
});

test("image validation rejects decoded canvases above the pixel ceiling for every supported media type", async (testContext) => {
  const cases = [
    { mediaType: "image/gif", extension: "gif", width: 32_768, height: 32_768, bytes: gif(32_768, 32_768) },
    { mediaType: "image/jpeg", extension: "jpg", width: 32_768, height: 32_768, bytes: jpeg(32_768, 32_768) },
    { mediaType: "image/png", extension: "png", width: 32_768, height: 32_768, bytes: png(32_768, 32_768) },
    { mediaType: "image/webp", extension: "webp", width: 16_384, height: 8_192, bytes: webp(16_384, 8_192) },
  ];
  for (const fixture of cases) {
    await testContext.test(fixture.mediaType, async () => {
      const result = await validateImage(fixture.bytes, fixture.mediaType, fixture.extension);
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((error) => error.code === "asset.decoded_pixels"));
      assert.ok(!result.errors.some((error) => error.code === "asset.media_mismatch"));
    });
  }
});

test("animated GIF, APNG, and WebP validation rejects frame counts above the animation ceiling", async (testContext) => {
  const cases = [
    { mediaType: "image/gif", extension: "gif", bytes: gif(1, 1, LIMITS.animationFrames + 1) },
    { mediaType: "image/png", extension: "png", bytes: png(1, 1, LIMITS.animationFrames + 1) },
    { mediaType: "image/webp", extension: "webp", bytes: animatedWebp(LIMITS.animationFrames + 1) },
  ];
  for (const fixture of cases) {
    await testContext.test(fixture.mediaType, async () => {
      const result = await validateImage(fixture.bytes, fixture.mediaType, fixture.extension);
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((error) => error.code === "asset.animation_frames"));
    });
  }
});

test("animated GIF, APNG, and WebP validation bounds cumulative decoded frame pixels", async (testContext) => {
  const width = 8_192;
  const height = Math.floor(LIMITS.decodedAnimationPixels / (2 * width)) + 1;
  assert.ok(width * height <= LIMITS.decodedPixels);
  assert.ok(2 * width * height > LIMITS.decodedAnimationPixels);
  const cases = [
    { mediaType: "image/gif", extension: "gif", bytes: gif(width, height, 2) },
    { mediaType: "image/png", extension: "png", bytes: png(width, height, 2) },
    {
      mediaType: "image/webp",
      extension: "webp",
      bytes: animatedWebp(2, { canvasWidth: width, canvasHeight: height, frameWidth: width, frameHeight: height }),
    },
  ];
  for (const fixture of cases) {
    await testContext.test(fixture.mediaType, async () => {
      const result = await validateImage(fixture.bytes, fixture.mediaType, fixture.extension, width, height);
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((error) => error.code === "asset.decoded_animation_pixels"));
      assert.ok(!result.errors.some((error) => error.code === "asset.media_mismatch"));
    });
  }
});

test("APNG validation enforces shared sequencing, frame ownership, operations, and completed counts", async (testContext) => {
  assert.equal((await validateImage(apng(), "image/png", "png")).ok, true);
  const cases = [
    ["sequence gap", apng({ sequenceGap: true })],
    ["invalid dispose operation", apng({ dispose: 3 })],
    ["invalid blend operation", apng({ blend: 2 })],
    ["missing first-frame data", apng({ omitFirstData: true })],
    ["missing following-frame data", apng({ omitSecondData: true })],
    ["fdAT before its frame control", apng({ fdatBeforeControl: true })],
    ["declared frame-count mismatch", apng({ declaredFrames: 3 })],
  ];
  for (const [name, bytes] of cases) {
    await testContext.test(name, async () => {
      const result = await validateImage(bytes, "image/png", "png");
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((error) => error.code === "asset.media_mismatch"));
    });
  }
});

test("PNG palette validation follows IHDR color type, bit depth, and placement", async (testContext) => {
  const validCases = [
    ["grayscale without palette", palettePng(8, 0, undefined)],
    ["truecolor with optional palette", palettePng(8, 2, 2)],
    ["indexed color with bounded palette", palettePng(8, 3, 2)],
    ["truecolor alpha with optional palette", palettePng(8, 6, 2)],
  ];
  for (const [name, bytes] of validCases) {
    await testContext.test(name, async () => assert.equal((await validateImage(bytes, "image/png", "png")).ok, true));
  }
  const invalidCases = [
    ["grayscale palette", palettePng(8, 0, 2)],
    ["grayscale-alpha palette", palettePng(8, 4, 2)],
    ["indexed color missing palette", palettePng(8, 3, undefined)],
    ["indexed palette exceeds bit depth", palettePng(1, 3, 3)],
    ["palette after image data", palettePng(8, 2, 2, "after")],
  ];
  for (const [name, bytes] of invalidCases) {
    await testContext.test(name, async () => {
      const result = await validateImage(bytes, "image/png", "png");
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((error) => error.code === "asset.media_mismatch"));
    });
  }
});

test("PNG chunk types enforce the reserved bit and zero-length IDAT contiguity", async (testContext) => {
  const imageData = pngImageData(1, 1);
  const valid = pngContainer([
    pngHeader(1, 1),
    pngChunk("IDAT", Buffer.alloc(0)),
    pngChunk("IDAT", imageData),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  assert.equal((await validateImage(valid, "image/png", "png")).ok, true);
  const cases = [
    ["lowercase reserved type byte", pngContainer([
      pngHeader(1, 1),
      pngChunk("texT", Buffer.alloc(0)),
      pngChunk("IDAT", imageData),
      pngChunk("IEND", Buffer.alloc(0)),
    ])],
    ["interrupted zero-length IDAT run", pngContainer([
      pngHeader(1, 1),
      pngChunk("IDAT", Buffer.alloc(0)),
      pngChunk("tEXt", Buffer.alloc(0)),
      pngChunk("IDAT", imageData),
      pngChunk("IEND", Buffer.alloc(0)),
    ])],
  ];
  for (const [name, bytes] of cases) {
    await testContext.test(name, async () => {
      const result = await validateImage(bytes, "image/png", "png");
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((error) => error.code === "asset.media_mismatch"));
    });
  }
});

test("GIF images require either a global or per-frame local color table", async () => {
  assert.equal((await validateImage(gif(1, 1, 1, "global"), "image/gif", "gif")).ok, true);
  assert.equal((await validateImage(gif(1, 1, 1, "local"), "image/gif", "gif")).ok, true);
  const result = await validateImage(gif(1, 1, 1, "none"), "image/gif", "gif");
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "asset.media_mismatch"));
});

test("GIF extensions and image packed fields follow their label-specific grammar", async (testContext) => {
  const withExtension = (extension) => {
    const bytes = gif();
    return Buffer.concat([bytes.subarray(0, 19), extension, bytes.subarray(19)]);
  };
  const validExtensions = [
    Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]),
    Buffer.concat([Buffer.from([0x21, 0xff, 0x0b]), Buffer.from("NETSCAPE2.0", "ascii"), Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00])]),
    Buffer.concat([Buffer.from([0x21, 0x01, 0x0c]), Buffer.alloc(12), Buffer.from([0x01, 0x41, 0x00])]),
    Buffer.from([0x21, 0xfe, 0x01, 0x41, 0x00]),
  ];
  for (const extension of validExtensions) assert.equal((await validateImage(withExtension(extension), "image/gif", "gif")).ok, true);

  const reservedImage = gif();
  reservedImage[reservedImage.indexOf(0x2c) + 9] |= 0x08;
  const cases = [
    ["GCE block size", withExtension(Buffer.from([0x21, 0xf9, 0x03, 0x00, 0x00, 0x00, 0x00]))],
    ["GCE terminator", withExtension(Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x01]))],
    ["GCE reserved bits", withExtension(Buffer.from([0x21, 0xf9, 0x04, 0x20, 0x00, 0x00, 0x00, 0x00]))],
    ["unknown extension", withExtension(Buffer.from([0x21, 0x02, 0x00]))],
    ["image descriptor reserved bits", reservedImage],
  ];
  for (const [name, bytes] of cases) {
    await testContext.test(name, async () => {
      const result = await validateImage(bytes, "image/gif", "gif");
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((error) => error.code === "asset.media_mismatch"));
    });
  }
});

test("JPEG validation requires a complete baseline Huffman interchange stream", async (testContext) => {
  assert.equal((await validateImage(jpeg(), "image/jpeg", "jpg")).ok, true);
  const validFramingCases = [
    ["complete non-interleaved scans with table and restart metadata between scans", "multi-scan", 1],
    ["non-interleaved restart cardinality uses component sampling geometry", "multi-scan-restarts", 17],
    ["quantization table after SOF0 and before SOS", "dqt-after-sof", 1],
    ["fill bytes before EOI", "fill-before-eoi", 1],
    ["fill bytes before a restart marker", "fill-before-rst", 9],
    ["exact restart marker count", "rst-exact", 17],
    ["restart interval larger than the MCU count", "rst-interval-over-mcus", 1],
  ];
  for (const [name, fault, width] of validFramingCases) {
    await testContext.test(name, async () => {
      assert.equal((await validateImage(malformedJpeg(fault), "image/jpeg", "jpg", width)).ok, true);
    });
  }
  const mutate = (callback) => {
    const bytes = jpeg();
    callback(bytes, bytes.indexOf(Buffer.from([0xff, 0xc0])), bytes.indexOf(Buffer.from([0xff, 0xda])));
    return bytes;
  };
  const cases = [
    ["header-only stream", Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x00, 0xff, 0xd9])],
    ["arithmetic SOF", mutate((bytes, frameOffset) => bytes[frameOffset + 1] = 0xc9)],
    ["missing quantization table", mutate((bytes, frameOffset) => bytes[frameOffset + 12] = 3)],
    ["duplicate component across scans", malformedJpeg("multi-scan-duplicate")],
    ["missing component across scans", malformedJpeg("multi-scan-missing")],
    ["missing per-scan quantization table", malformedJpeg("multi-scan-missing-quantization")],
    ["missing per-scan Huffman table", malformedJpeg("multi-scan-missing-huffman")],
    ["invalid per-scan spectral fields", malformedJpeg("multi-scan-spectral")],
    ["invalid non-interleaved restart cardinality", malformedJpeg("multi-scan-restart-cardinality"), 17],
    ["duplicate frame component", mutate((bytes, frameOffset) => bytes[frameOffset + 13] = bytes[frameOffset + 10])],
    ["missing Huffman tables", mutate((bytes, _frameOffset, scanOffset) => bytes[scanOffset + 6] = 0x33)],
    ["16-bit baseline quantization table", malformedJpeg("dqt-16-bit")],
    ["zero quantization coefficient", malformedJpeg("dqt-zero")],
    ["oversubscribed Huffman code lengths", malformedJpeg("dht-oversubscribed")],
    ["exhausted Huffman code space", malformedJpeg("dht-exhausted")],
    ["all-ones terminal Huffman code", malformedJpeg("dht-all-ones")],
    ["more than 256 Huffman symbols", malformedJpeg("dht-too-many")],
    ["invalid baseline DC category", malformedJpeg("dht-invalid-dc")],
    ["invalid baseline AC size", malformedJpeg("dht-invalid-ac")],
    ["invalid zero-size AC symbol", malformedJpeg("dht-zero-size-ac")],
    ["restart marker without preceding entropy", malformedJpeg("rst-only"), 9],
    ["consecutive restart markers", malformedJpeg("rst-consecutive"), 17],
    ["restart marker without following entropy", malformedJpeg("rst-no-final-entropy"), 9],
    ["multiple fill bytes before a stuffed zero", malformedJpeg("stuffing-multiple-ff")],
    ["missing restart marker", malformedJpeg("rst-missing"), 17],
    ["excess restart marker", malformedJpeg("rst-excess"), 9],
    ["sampling products above the baseline ceiling", malformedJpeg("sampling-units")],
  ];
  for (const [name, bytes, width = 1] of cases) {
    await testContext.test(name, async () => {
      const result = await validateImage(bytes, "image/jpeg", "jpg", width);
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((error) => error.code === "asset.media_mismatch"));
    });
  }
});

test("WebP VP8, VP8L, and ALPH chunks require bounded stream payloads", async (testContext) => {
  const malformedVp8 = (mutate) => {
    const payload = vp8Payload();
    mutate(payload);
    return webpContainer([webpChunk("VP8 ", payload)]);
  };
  const cases = [
    ["VP8 interframe", malformedVp8((payload) => payload[0] |= 0x01)],
    ["VP8 hidden frame", malformedVp8((payload) => payload[0] &= ~0x10)],
    ["VP8 experimental version", malformedVp8((payload) => payload[0] = (payload[0] & ~0x0e) | 0x08)],
    ["VP8 empty first partition", malformedVp8((payload) => payload.set([0x10, 0x00, 0x00], 0))],
    ["VP8 partition reaches end", malformedVp8((payload) => {
      const tag = ((payload.length - 10) << 5) | 0x10;
      payload.set([tag & 0xff, (tag >>> 8) & 0xff, (tag >>> 16) & 0xff], 0);
    })],
    ["VP8L header without stream", webpContainer([webpChunk("VP8L", vp8lPayload().subarray(0, 5))])],
    ["ALPH reserved bits", animatedWebp(0, { extendedFlags: 0x10, alphaHeader: 0x40, topOrder: ["VP8X", "ALPH", "VP8 "] })],
    ["ALPH unsupported preprocessing", animatedWebp(0, { extendedFlags: 0x10, alphaHeader: 0x20, topOrder: ["VP8X", "ALPH", "VP8 "] })],
    ["ALPH unsupported compression", animatedWebp(0, { extendedFlags: 0x10, alphaHeader: 0x02, topOrder: ["VP8X", "ALPH", "VP8 "] })],
    ["ALPH raw length mismatch", animatedWebp(0, { extendedFlags: 0x10, alphaDataLength: 0, topOrder: ["VP8X", "ALPH", "VP8 "] })],
  ];
  assert.equal((await validateImage(animatedWebp(0, {
    extendedFlags: 0x10,
    alphaHeader: 0x0c,
    topOrder: ["VP8X", "ALPH", "VP8 "],
  }), "image/webp", "webp")).ok, true);
  for (const [name, bytes] of cases) {
    await testContext.test(name, async () => {
      const result = await validateImage(bytes, "image/webp", "webp");
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((error) => error.code === "asset.media_mismatch"));
    });
  }
});

test("animated WebP validation enforces bounded and internally consistent ANMF records", async (testContext) => {
  const cases = [
    {
      name: "valid animation",
      bytes: animatedWebp(1),
    },
    {
      name: "valid alpha animation",
      bytes: animatedWebp(1, { extendedFlags: 0x12, nestedOrder: ["ALPH", "VP8 "] }),
    },
    {
      name: "oversized decoded frame",
      bytes: animatedWebp(1, { frameWidth: 32_768, frameHeight: 32_768, embeddedWidth: 1, embeddedHeight: 1 }),
      code: "asset.decoded_pixels",
    },
    {
      name: "frame escaping the canvas",
      bytes: animatedWebp(1, { frameX: 2 }),
      code: "asset.media_mismatch",
    },
    {
      name: "reserved frame flags",
      bytes: animatedWebp(1, { frameFlags: 0x04 }),
      code: "asset.media_mismatch",
    },
    {
      name: "embedded image dimension mismatch",
      bytes: animatedWebp(1, { canvasWidth: 2, frameWidth: 2, embeddedWidth: 1 }),
      width: 2,
      code: "asset.media_mismatch",
    },
  ];

  for (const fixture of cases) {
    await testContext.test(fixture.name, async () => {
      const result = await validateImage(fixture.bytes, "image/webp", "webp", fixture.width, fixture.height);
      assert.equal(result.ok, fixture.code === undefined);
      if (fixture.code) assert.ok(result.errors.some((error) => error.code === fixture.code));
    });
  }
});

test("WebP validation rejects invalid top-level and ANMF chunk grammar", async (testContext) => {
  const cases = [
    ["unknown chunk in simple WebP", webpContainer([
      webpChunk("VP8L", vp8lPayload()),
      webpChunk("ODD!", Buffer.from([0])),
    ])],
    ["unknown chunk in extended still WebP", animatedWebp(0, {
      extendedFlags: 0x00,
      topOrder: ["VP8X", "ODD!", "VP8 "],
    })],
    ["unknown chunk before animated frame run", animatedWebp(1, {
      topOrder: ["VP8X", "ODD!", "ANIM", "ANMF"],
    })],
    ["unknown chunk after animated frame run", animatedWebp(1, {
      topOrder: ["VP8X", "ANIM", "ANMF", "ODD!"],
    })],
    ["nonzero top-level padding", animatedWebp(1, { topOrder: ["VP8X", "ODD", "ANIM", "ANMF"], topPadByte: 1 })],
    ["nonzero nested padding", animatedWebp(1, { nestedOrder: ["VP8L"], nestedPadByte: 1 })],
    ["VP8L before VP8X", animatedWebp(1, { topOrder: ["VP8L", "VP8X", "ANIM", "ANMF"] })],
    ["ANMF before ANIM", animatedWebp(1, { topOrder: ["VP8X", "ANMF", "ANIM"] })],
    ["duplicate ANIM", animatedWebp(1, { topOrder: ["VP8X", "ANIM", "ANIM", "ANMF"] })],
    ["top-level VP8 in animation", animatedWebp(1, { topOrder: ["VP8X", "VP8 ", "ANIM", "ANMF"] })],
    ["unsupported nested chunk", animatedWebp(1, { nestedOrder: ["EXIF"] })],
    ["duplicate nested image", animatedWebp(1, { nestedOrder: ["VP8L", "VP8L"] })],
    ["misordered nested alpha", animatedWebp(1, { nestedOrder: ["VP8 ", "ALPH"] })],
  ];

  for (const [name, bytes] of cases) {
    await testContext.test(name, async () => {
      const result = await validateImage(bytes, "image/webp", "webp");
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((error) => error.code === "asset.media_mismatch"));
    });
  }
});

test("extended WebP validation accepts canonical still and animated feature layouts", async (testContext) => {
  const cases = [
    ["still image with every still feature", animatedWebp(0, {
      extendedFlags: 0x3c,
      topOrder: ["VP8X", "ICCP", "ALPH", "VP8 ", "EXIF", "XMP "],
    })],
    ["still lossless alpha", animatedWebp(0, {
      extendedFlags: 0x10,
      embeddedAlphaUsed: true,
      topOrder: ["VP8X", "VP8L"],
    })],
    ["animation with every feature", animatedWebp(1, {
      extendedFlags: 0x3e,
      nestedOrder: ["ALPH", "VP8 "],
      topOrder: ["VP8X", "ICCP", "ANIM", "ANMF", "EXIF", "XMP "],
    })],
    ["animated lossless alpha", animatedWebp(1, {
      extendedFlags: 0x12,
      embeddedAlphaUsed: true,
      nestedOrder: ["VP8L"],
    })],
  ];

  for (const [name, bytes] of cases) {
    await testContext.test(name, async () => {
      const result = await validateImage(bytes, "image/webp", "webp");
      assert.equal(result.ok, true);
    });
  }
});

test("extended WebP validation reconciles feature flags and reconstruction order", async (testContext) => {
  const cases = [
    ["ICC flag without ICCP", { extendedFlags: 0x20, topOrder: ["VP8X", "VP8 "] }],
    ["alpha flag without alpha", { extendedFlags: 0x10, topOrder: ["VP8X", "VP8 "] }],
    ["Exif flag without EXIF", { extendedFlags: 0x08, topOrder: ["VP8X", "VP8 "] }],
    ["XMP flag without XMP", { extendedFlags: 0x04, topOrder: ["VP8X", "VP8 "] }],
    ["animation flag without animation", { extendedFlags: 0x02, topOrder: ["VP8X"] }],
    ["ICCP without flag", { extendedFlags: 0x00, topOrder: ["VP8X", "ICCP", "VP8 "] }],
    ["ALPH without flag", { extendedFlags: 0x00, topOrder: ["VP8X", "ALPH", "VP8 "] }],
    ["EXIF without flag", { extendedFlags: 0x00, topOrder: ["VP8X", "VP8 ", "EXIF"] }],
    ["XMP without flag", { extendedFlags: 0x00, topOrder: ["VP8X", "VP8 ", "XMP "] }],
    ["ANIM without flag", { extendedFlags: 0x00, topOrder: ["VP8X", "ANIM", "ANMF"] }],
    ["duplicate ICCP", { extendedFlags: 0x20, topOrder: ["VP8X", "ICCP", "ICCP", "VP8 "] }],
    ["duplicate ALPH", { extendedFlags: 0x10, topOrder: ["VP8X", "ALPH", "ALPH", "VP8 "] }],
    ["duplicate EXIF", { extendedFlags: 0x08, topOrder: ["VP8X", "VP8 ", "EXIF", "EXIF"] }],
    ["duplicate XMP", { extendedFlags: 0x04, topOrder: ["VP8X", "VP8 ", "XMP ", "XMP "] }],
    ["ICCP after image", { extendedFlags: 0x20, topOrder: ["VP8X", "VP8 ", "ICCP"] }],
    ["ALPH not immediately before VP8", { extendedFlags: 0x30, topOrder: ["VP8X", "ALPH", "ICCP", "VP8 "] }],
    ["EXIF before image", { extendedFlags: 0x08, topOrder: ["VP8X", "EXIF", "VP8 "] }],
    ["XMP before image", { extendedFlags: 0x04, topOrder: ["VP8X", "XMP ", "VP8 "] }],
    ["EXIF after XMP", { extendedFlags: 0x0c, topOrder: ["VP8X", "VP8 ", "XMP ", "EXIF"] }],
    ["ALPH with VP8L", { extendedFlags: 0x10, topOrder: ["VP8X", "ALPH", "VP8L"] }],
    ["nested ALPH without alpha flag", { extendedFlags: 0x02, nestedOrder: ["ALPH", "VP8 "] }],
    ["nested VP8L alpha without flag", { extendedFlags: 0x02, embeddedAlphaUsed: true, nestedOrder: ["VP8L"] }],
    ["ANMF after frame run ends", {
      extendedFlags: 0x0a,
      topOrder: ["VP8X", "ANIM", "ANMF", "EXIF", "ANMF"],
    }],
  ];

  for (const [name, options] of cases) {
    await testContext.test(name, async () => {
      const result = await validateImage(animatedWebp(1, options), "image/webp", "webp");
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((error) => error.code === "asset.media_mismatch"));
    });
  }
});

test("hostile iterable failures use a fixed diagnostic without inspecting the thrown value", async () => {
  const manifest = await minimalManifest();
  const hostileError = new Proxy(new Error("secret"), {
    get(target, key, receiver) {
      if (key === "message") throw new Error("message must not be read");
      return Reflect.get(target, key, receiver);
    },
    getPrototypeOf() {
      throw new Error("prototype must not be read");
    },
  });
  const files = {
    [Symbol.iterator]() {
      return {
        next() {
          throw hostileError;
        },
      };
    },
  };

  const result = await validateArtifact(manifest, files);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => (
    error.code === "file.invalid_iterable"
    && error.message === "Could not enumerate semantic files safely."
  )));
});

test("unexpected paths are rejected before their content is accessed", async () => {
  const manifest = await minimalManifest();
  const unexpected = { path: "taproot-docs/fragments/unexpected.html" };
  Object.defineProperty(unexpected, "content", {
    get() {
      throw new Error("content must not be accessed");
    },
  });

  const result = await validateArtifact(manifest, [unexpected]);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "file.unexpected"));
  assert.ok(!result.errors.some((error) => error.code === "file.invalid_iterable"));
});

test("oversized and size-drifted strings are rejected before encoding or hashing", async () => {
  const manifest = await minimalManifest();
  const path = "taproot-docs/fragments/welcome.html";
  const cases = [
    { content: "x".repeat(LIMITS.fragmentBytes + 1), code: "file.too_large" },
    { content: "x".repeat(manifest.resources[0].variants[0].fragments[0].bytes + 1), code: "file.size_drift" },
  ];

  for (const fixture of cases) {
    const result = await validateArtifact(manifest, [{ path, content: fixture.content }]);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === fixture.code));
    assert.ok(!result.errors.some((error) => error.code === "file.hash_drift"));
  }
});

test("actual inspected bytes consume the aggregate budget before size-drift exits", async () => {
  const manifest = await minimalManifest();
  manifest.assets = Array.from({ length: 12 }, (_, index) => ({
    key: `image:budget-${String(index).padStart(2, "0")}`,
    path: `taproot-docs/assets/budget-${String(index).padStart(2, "0")}.png`,
    mediaType: "image/png",
    bytes: 1,
    sha256: `sha256:${"0".repeat(64)}`,
    width: 1,
    height: 1,
  }));
  const oversized = new Uint8Array(LIMITS.assetBytes + 1);
  let laterContentReads = 0;
  const entries = manifest.assets.slice(0, 11).map((asset) => ({ path: asset.path, content: oversized }));
  const later = { path: manifest.assets[11].path };
  Object.defineProperty(later, "content", {
    get() {
      laterContentReads += 1;
      throw new Error("aggregate overflow must stop before later content");
    },
  });
  entries.push(later);

  const result = await validateArtifact(manifest, entries);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "limit.artifact_bytes"));
  assert.equal(laterContentReads, 0);
});

test("string content uses one bounded Unicode and aggregate-byte scan", async () => {
  const manifest = await minimalManifest();
  manifest.assets = Array.from({ length: 12 }, (_, index) => ({
    key: `image:string-budget-${String(index).padStart(2, "0")}`,
    path: `taproot-docs/assets/string-budget-${String(index).padStart(2, "0")}.png`,
    mediaType: "image/png",
    bytes: 1,
    sha256: `sha256:${"0".repeat(64)}`,
    width: 1,
    height: 1,
  }));
  const oversizedBinary = new Uint8Array(LIMITS.assetBytes + 1);
  const entries = manifest.assets.slice(0, 9).map((asset) => ({ path: asset.path, content: oversizedBinary }));
  entries.push({ path: manifest.assets[9].path, content: new Uint8Array(5 * 1024 * 1024) });
  entries.push({
    path: manifest.assets[10].path,
    content: `${"😀".repeat(7 * 1024 * 1024)}\ud800`,
  });
  let laterContentReads = 0;
  const later = { path: manifest.assets[11].path };
  Object.defineProperty(later, "content", {
    get() {
      laterContentReads += 1;
      throw new Error("bounded string overflow must stop before later content");
    },
  });
  entries.push(later);

  const result = await validateArtifact(manifest, entries);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "limit.artifact_bytes"));
  assert.ok(!result.errors.some((error) => error.code === "file.invalid_unicode"));
  assert.equal(laterContentReads, 0);
});
