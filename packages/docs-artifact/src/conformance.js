import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { LIMITS } from "./constants.js";

const FIXTURES_ROOT = new URL("../fixtures/", import.meta.url);

function generatedGif(specification) {
  const header = Buffer.alloc(13);
  header.write("GIF89a", 0, 6, "ascii");
  header.writeUInt16LE(specification.width, 6);
  header.writeUInt16LE(specification.height, 8);
  const palette = specification.palette ?? "global";
  if (palette === "global") header[10] = 0x80;
  const frame = Buffer.from([
    0x2c,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    palette === "local" ? 0x80 : 0x00,
    ...(palette === "local" ? [0x00, 0x00, 0x00, 0xff, 0xff, 0xff] : []),
    0x02, 0x01, 0x4c, 0x00,
  ]);
  frame.writeUInt16LE(specification.frameWidth ?? specification.width, 5);
  frame.writeUInt16LE(specification.frameHeight ?? specification.height, 7);
  let extension = Buffer.alloc(0);
  if (specification.extension === "gce") extension = Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]);
  if (specification.extension === "application") {
    extension = Buffer.concat([Buffer.from([0x21, 0xff, 0x0b]), Buffer.from("NETSCAPE2.0", "ascii"), Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00])]);
  }
  if (specification.extension === "plain-text") extension = Buffer.concat([Buffer.from([0x21, 0x01, 0x0c]), Buffer.alloc(12), Buffer.from([0x01, 0x41, 0x00])]);
  if (specification.extension === "comment") extension = Buffer.from([0x21, 0xfe, 0x01, 0x41, 0x00]);
  if (specification.extensionFault === "gce-size") extension = Buffer.from([0x21, 0xf9, 0x03, 0x00, 0x00, 0x00, 0x00]);
  if (specification.extensionFault === "gce-terminator") extension = Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x01]);
  if (specification.extensionFault === "gce-reserved") extension = Buffer.from([0x21, 0xf9, 0x04, 0x20, 0x00, 0x00, 0x00, 0x00]);
  if (specification.extensionFault === "unknown") extension = Buffer.from([0x21, 0x02, 0x00]);
  if (specification.imageReserved) frame[9] |= 0x08;
  return Buffer.concat([
    header,
    ...(palette === "global" ? [Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff, 0xff])] : []),
    extension,
    ...Array.from({ length: specification.frames }, () => frame),
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
  let checksum = 0xffffffff;
  for (const byte of Buffer.concat([typeBytes, data])) checksum = PNG_CRC_TABLE[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE((checksum ^ 0xffffffff) >>> 0, 8 + data.length);
  return chunk;
}

function generatedPng(specification) {
  const width = specification.width ?? 1;
  const height = specification.height ?? 1;
  const bitDepth = specification.bitDepth ?? 8;
  const colorType = specification.colorType ?? 4;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([bitDepth, colorType, 0, 0, 0], 8);
  const chunks = [pngChunk("IHDR", ihdr)];
  if (specification.reservedChunk) chunks.push(pngChunk("texT", Buffer.alloc(0)));
  if (specification.paletteEntries !== undefined && !specification.paletteAfterData) {
    chunks.push(pngChunk("PLTE", Buffer.alloc(specification.paletteEntries * 3)));
  }
  const channels = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]).get(colorType) ?? 1;
  const raw = Buffer.alloc((width * channels) + 1);
  const imageData = deflateSync(raw);
  const frames = specification.frames ?? 1;
  if (frames > 1 || specification.animated) {
    const animationControl = Buffer.alloc(8);
    animationControl.writeUInt32BE(specification.declaredFrames ?? frames, 0);
    chunks.push(pngChunk("acTL", animationControl));
    let sequence = specification.firstSequence ?? 0;
    const frameControl = (currentSequence, options = {}) => {
      const control = Buffer.alloc(26);
      control.writeUInt32BE(currentSequence, 0);
      control.writeUInt32BE(width, 4);
      control.writeUInt32BE(height, 8);
      control.writeUInt16BE(1, 20);
      control.writeUInt16BE(100, 22);
      control[24] = options.dispose ?? 0;
      control[25] = options.blend ?? 0;
      return pngChunk("fcTL", control);
    };
    const frameData = (currentSequence) => {
      const data = Buffer.alloc(4 + imageData.length);
      data.writeUInt32BE(currentSequence, 0);
      imageData.copy(data, 4);
      return pngChunk("fdAT", data);
    };
    chunks.push(frameControl(sequence, { dispose: specification.dispose, blend: specification.blend }));
    sequence += 1;
    if (!specification.omitFirstData) chunks.push(pngChunk("IDAT", imageData));
    if (frames > 1) {
      if (specification.fdatBeforeControl) chunks.push(frameData(sequence));
      if (specification.sequenceGap) sequence += 1;
      chunks.push(frameControl(sequence));
      sequence += 1;
      if (!specification.omitSecondData && !specification.fdatBeforeControl) chunks.push(frameData(sequence));
    }
  } else {
    if (specification.leadingZeroIdat) chunks.push(pngChunk("IDAT", Buffer.alloc(0)));
    if (specification.interruptZeroIdat) chunks.push(pngChunk("tEXt", Buffer.alloc(0)));
    chunks.push(pngChunk("IDAT", imageData));
  }
  if (specification.paletteEntries !== undefined && specification.paletteAfterData) {
    chunks.push(pngChunk("PLTE", Buffer.alloc(specification.paletteEntries * 3)));
  }
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat([Buffer.from("iVBORw0KGgo=", "base64"), ...chunks]);
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

function generatedSequentialJpeg(fault) {
  const bytes = Buffer.from(REAL_JPEG);
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

function generatedJpeg(specification) {
  if (specification.fault === "header-only") {
    return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x00, 0xff, 0xd9]);
  }
  if (specification.fault?.startsWith("multi-scan")) return generatedSequentialJpeg(specification.fault);
  let bytes = Buffer.from(REAL_JPEG);
  const quantizationOffset = bytes.indexOf(Buffer.from([0xff, 0xdb]));
  const frameOffset = bytes.indexOf(Buffer.from([0xff, 0xc0]));
  const dcHuffmanOffset = bytes.indexOf(Buffer.from([0xff, 0xc4]));
  const acHuffmanOffset = bytes.indexOf(Buffer.from([0xff, 0xc4]), dcHuffmanOffset + 2);
  const scanOffset = bytes.indexOf(Buffer.from([0xff, 0xda]));
  if (specification.fault === "dqt-after-sof") {
    const quantizationEnd = quantizationOffset + 2 + bytes.readUInt16BE(quantizationOffset + 2);
    const quantization = bytes.subarray(quantizationOffset, quantizationEnd);
    bytes = Buffer.concat([bytes.subarray(0, quantizationOffset), bytes.subarray(quantizationEnd)]);
    const relocatedFrameOffset = bytes.indexOf(Buffer.from([0xff, 0xc0]));
    const frameEnd = relocatedFrameOffset + 2 + bytes.readUInt16BE(relocatedFrameOffset + 2);
    bytes = Buffer.concat([bytes.subarray(0, frameEnd), quantization, bytes.subarray(frameEnd)]);
  }
  if (specification.fault === "arithmetic") bytes[frameOffset + 1] = 0xc9;
  if (specification.fault === "missing-quantization") bytes[frameOffset + 12] = 3;
  if (specification.fault === "duplicate-component") bytes[frameOffset + 13] = bytes[frameOffset + 10];
  if (specification.fault === "missing-huffman") bytes[scanOffset + 6] = 0x33;
  if (specification.fault === "dqt-16-bit") {
    const payload = Buffer.from([0x10, ...Array(128).fill(0x01)]);
    const header = Buffer.from([0xff, 0xdb, 0x00, 0x00]);
    header.writeUInt16BE(payload.length + 2, 2);
    bytes = replaceJpegSegment(bytes, quantizationOffset, Buffer.concat([header, payload]));
  }
  if (specification.fault === "dqt-zero") bytes[quantizationOffset + 5] = 0;
  const emptyCounts = () => Array(16).fill(0);
  if (specification.fault === "dht-oversubscribed") {
    const counts = emptyCounts();
    counts[0] = 3;
    bytes = replaceJpegSegment(bytes, dcHuffmanOffset, jpegHuffmanSegment(0, counts, [0, 1, 2]));
  }
  if (specification.fault === "dht-exhausted") {
    const counts = emptyCounts();
    counts[0] = 2;
    bytes = replaceJpegSegment(bytes, dcHuffmanOffset, jpegHuffmanSegment(0, counts, [0, 1]));
  }
  if (specification.fault === "dht-all-ones") {
    const counts = emptyCounts();
    counts[0] = 1;
    counts[1] = 2;
    bytes = replaceJpegSegment(bytes, dcHuffmanOffset, jpegHuffmanSegment(0, counts, [0, 1, 2]));
  }
  if (specification.fault === "dht-too-many") {
    const counts = emptyCounts();
    counts[8] = 255;
    counts[9] = 2;
    bytes = replaceJpegSegment(bytes, dcHuffmanOffset, jpegHuffmanSegment(0, counts, Buffer.alloc(257)));
  }
  if (specification.fault === "dht-invalid-dc") {
    const counts = emptyCounts();
    counts[0] = 1;
    bytes = replaceJpegSegment(bytes, dcHuffmanOffset, jpegHuffmanSegment(0, counts, [12]));
  }
  if (specification.fault === "dht-invalid-ac" || specification.fault === "dht-zero-size-ac") {
    const counts = emptyCounts();
    counts[0] = 1;
    const symbol = specification.fault === "dht-invalid-ac" ? 0x0b : 0x10;
    bytes = replaceJpegSegment(bytes, acHuffmanOffset, jpegHuffmanSegment(1, counts, [symbol]));
  }
  if (specification.fault === "rst-only") {
    bytes.writeUInt16BE(9, frameOffset + 7);
    bytes = jpegWithEntropy(bytes, [0xff, 0xd0], 1);
  }
  if (specification.fault === "rst-consecutive") {
    bytes.writeUInt16BE(17, frameOffset + 7);
    bytes = jpegWithEntropy(bytes, [0x03, 0xff, 0xd0, 0xff, 0xd1, 0x03], 1);
  }
  if (specification.fault === "rst-no-final-entropy") {
    bytes.writeUInt16BE(9, frameOffset + 7);
    bytes = jpegWithEntropy(bytes, [0x03, 0xff, 0xd0], 1);
  }
  if (specification.fault === "stuffing-multiple-ff") bytes = jpegWithEntropy(bytes, [0x03, 0xff, 0xff, 0x00, 0x03]);
  if (specification.fault === "fill-before-eoi") bytes = jpegWithEntropy(bytes, [0x03, 0xff]);
  if (specification.fault === "fill-before-rst") {
    bytes.writeUInt16BE(9, frameOffset + 7);
    bytes = jpegWithEntropy(bytes, [0x03, 0xff, 0xff, 0xd0, 0x03], 1);
  }
  if (specification.fault === "rst-missing") {
    bytes.writeUInt16BE(17, frameOffset + 7);
    bytes = jpegWithEntropy(bytes, [0x03, 0xff, 0xd0, 0x03], 1);
  }
  if (specification.fault === "rst-excess") {
    bytes.writeUInt16BE(9, frameOffset + 7);
    bytes = jpegWithEntropy(bytes, [0x03, 0xff, 0xd0, 0x03, 0xff, 0xd1, 0x03], 1);
  }
  if (specification.fault === "rst-exact") {
    bytes.writeUInt16BE(17, frameOffset + 7);
    bytes = jpegWithEntropy(bytes, [0x03, 0xff, 0xd0, 0x03, 0xff, 0xd1, 0x03], 1);
  }
  if (specification.fault === "rst-interval-over-mcus") bytes = jpegWithEntropy(bytes, [0x03], 2);
  if (specification.fault === "sampling-units") {
    bytes[frameOffset + 11] = 0x44;
    bytes[frameOffset + 14] = 0x44;
    bytes[frameOffset + 17] = 0x44;
  }
  return bytes;
}

function webpChunk(type, data, padByte = 0) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, "ascii");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, ...(data.length % 2 === 1 ? [Buffer.from([padByte])] : [])]);
}

const REAL_VP8_PAYLOAD = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEALmk0mk0iIiIiIgBoSygAAA==", "base64").subarray(20);
const REAL_VP8L_PAYLOAD = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64").subarray(20, 33);

function vp8lPayload(width, height, alphaUsed = false) {
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

function vp8Payload(width, height) {
  if (width === 1 && height === 1) return Buffer.from(REAL_VP8_PAYLOAD);
  const payload = Buffer.alloc(12);
  payload.set([0x30, 0x00, 0x00, 0x9d, 0x01, 0x2a]);
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return payload;
}

function generatedVp8Payload(width, height, specification) {
  const payload = vp8Payload(width, height);
  if (specification.vp8Fault === "interframe") payload[0] |= 0x01;
  if (specification.vp8Fault === "hidden") payload[0] &= ~0x10;
  if (specification.vp8Fault === "experimental") payload[0] = (payload[0] & ~0x0e) | 0x08;
  if (specification.vp8Fault === "empty-partition") payload.set([0x10, 0x00, 0x00], 0);
  if (specification.vp8Fault === "partition-at-end") {
    const tag = ((payload.length - 10) << 5) | 0x10;
    payload.set([tag & 0xff, (tag >>> 8) & 0xff, (tag >>> 16) & 0xff], 0);
  }
  return payload;
}

function alphaPayload(width, height, specification) {
  const dataLength = specification.alphaDataLength ?? width * height;
  return Buffer.concat([Buffer.from([specification.alphaHeader ?? 0]), Buffer.alloc(dataLength, 0xff)]);
}

function generatedAnimatedWebp(specification) {
  const canvasWidth = specification.canvasWidth ?? 1;
  const canvasHeight = specification.canvasHeight ?? 1;
  const frameWidth = specification.frameWidth ?? 1;
  const frameHeight = specification.frameHeight ?? 1;
  const extendedHeader = Buffer.alloc(10);
  extendedHeader[0] = specification.extendedFlags ?? 0x02;
  extendedHeader.writeUIntLE(canvasWidth - 1, 4, 3);
  extendedHeader.writeUIntLE(canvasHeight - 1, 7, 3);
  const frameHeader = Buffer.alloc(16);
  frameHeader.writeUIntLE((specification.frameX ?? 0) / 2, 0, 3);
  frameHeader.writeUIntLE((specification.frameY ?? 0) / 2, 3, 3);
  frameHeader.writeUIntLE(frameWidth - 1, 6, 3);
  frameHeader.writeUIntLE(frameHeight - 1, 9, 3);
  frameHeader[15] = specification.frameFlags ?? 0;
  const nestedChunks = (specification.nestedOrder ?? ["VP8 "]).map((type) => {
    if (type === "ALPH") return webpChunk(type, alphaPayload(frameWidth, frameHeight, specification), specification.nestedPadByte);
    if (type === "VP8 ") {
      return webpChunk(type, generatedVp8Payload(
        specification.embeddedWidth ?? frameWidth,
        specification.embeddedHeight ?? frameHeight,
        specification,
      ), specification.nestedPadByte);
    }
    if (type === "VP8L") {
      const payload = vp8lPayload(
        specification.embeddedWidth ?? frameWidth,
        specification.embeddedHeight ?? frameHeight,
        specification.embeddedAlphaUsed,
      );
      return webpChunk(type, specification.vp8lHeaderOnly ? payload.subarray(0, 5) : payload, specification.nestedPadByte);
    }
    return webpChunk(type, Buffer.from([0]), specification.nestedPadByte);
  });
  const frame = Buffer.concat([
    frameHeader,
    ...nestedChunks,
  ]);
  const chunks = Buffer.concat((specification.topOrder ?? ["VP8X", "ANIM", "ANMF"]).map((type) => {
    if (type === "VP8X") return webpChunk(type, extendedHeader);
    if (type === "ANIM") return webpChunk(type, Buffer.alloc(6));
    if (type === "ANMF") return webpChunk(type, frame);
    if (type === "VP8 ") return webpChunk(type, generatedVp8Payload(canvasWidth, canvasHeight, specification));
    if (type === "VP8L") {
      const payload = vp8lPayload(canvasWidth, canvasHeight, specification.embeddedAlphaUsed);
      return webpChunk(type, specification.vp8lHeaderOnly ? payload.subarray(0, 5) : payload);
    }
    if (type === "ALPH") return webpChunk(type, alphaPayload(canvasWidth, canvasHeight, specification), specification.topPadByte);
    return webpChunk(type, Buffer.from([0]), specification.topPadByte);
  }));
  const riffHeader = Buffer.alloc(12);
  riffHeader.write("RIFF", 0, 4, "ascii");
  riffHeader.writeUInt32LE(4 + chunks.length, 4);
  riffHeader.write("WEBP", 8, 4, "ascii");
  return Buffer.concat([riffHeader, chunks]);
}

function generatedContent(specification) {
  if (specification.kind === "repeat") {
    return Buffer.from(specification.text.repeat(specification.count));
  }
  if (specification.kind === "nested") {
    return Buffer.from(
      `<${specification.tag}>`.repeat(specification.depth)
        + `</${specification.tag}>`.repeat(specification.depth),
    );
  }
  if (specification.kind === "gif") return generatedGif(specification);
  if (specification.kind === "png") return generatedPng(specification);
  if (specification.kind === "jpeg") return generatedJpeg(specification);
  if (specification.kind === "animated-webp") return generatedAnimatedWebp(specification);
  throw new Error(`Unsupported generated conformance content '${specification.kind}'.`);
}

function synchronizeDescriptor(manifest, filePath, bytes) {
  const descriptors = [
    ...manifest.resources.flatMap((resource) => resource.variants.flatMap((variant) => variant.fragments)),
    ...manifest.assets,
  ];
  const descriptor = descriptors.find((candidate) => candidate.path === filePath);
  if (!descriptor) throw new Error(`Generated conformance file '${filePath}' has no manifest descriptor.`);
  descriptor.bytes = bytes.byteLength;
  descriptor.sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function loadConformanceCases() {
  const descriptor = JSON.parse(await readFile(new URL("conformance.json", FIXTURES_ROOT), "utf8"));
  const cases = [];
  for (const fixture of descriptor.cases) {
    let manifest;
    let manifestValue;
    if (fixture.baseManifest) {
      manifestValue = JSON.parse(await readFile(new URL(fixture.baseManifest, FIXTURES_ROOT), "utf8"));
      for (const mutation of fixture.mutations ?? []) {
        let parent = manifestValue;
        for (const segment of mutation.path.slice(0, -1)) parent = parent[segment];
        const key = mutation.path.at(-1);
        if (mutation.operation === "replace") parent[key] = mutation.value;
        else if (mutation.operation === "append") parent[key].push(mutation.value);
        else throw new Error(`Unsupported conformance mutation '${mutation.operation}'.`);
      }
      if (fixture.generatedNavigationDepth !== undefined) {
        let node = { label: `Level ${fixture.generatedNavigationDepth}`, resourceKey: "guide:welcome" };
        for (let level = fixture.generatedNavigationDepth - 1; level >= 1; level -= 1) {
          node = { label: `Level ${level}`, children: [node] };
        }
        manifestValue.navigation[0].items = [node];
      }
    } else {
      manifest = await readFile(new URL(fixture.manifest, FIXTURES_ROOT));
    }
    const fileSpecifications = [...(fixture.files ?? [])];
    if (fixture.generatedAnimatedWebp) {
      if (!manifestValue) throw new Error("Generated animated WebP conformance cases require a base manifest.");
      manifestValue.assets.push({
        key: "image:animated",
        path: "taproot-docs/assets/animated.webp",
        mediaType: "image/webp",
        bytes: 1,
        sha256: `sha256:${"0".repeat(64)}`,
        width: fixture.generatedAnimatedWebp.canvasWidth ?? 1,
        height: fixture.generatedAnimatedWebp.canvasHeight ?? 1,
      });
      fileSpecifications.push(
        { path: "taproot-docs/fragments/welcome.html", source: "valid/minimal/taproot-docs/fragments/welcome.html" },
        {
          path: "taproot-docs/assets/animated.webp",
          generated: { kind: "animated-webp", ...fixture.generatedAnimatedWebp },
          synchronizeDescriptor: true,
        },
      );
    }
    if (fixture.generatedImage) {
      if (!manifestValue) throw new Error("Generated image conformance cases require a base manifest.");
      const extension = fixture.generatedImage.kind === "gif" ? "gif" : fixture.generatedImage.kind === "jpeg" ? "jpg" : "png";
      const mediaType = extension === "jpg" ? "image/jpeg" : `image/${extension}`;
      const path = `taproot-docs/assets/generated.${extension}`;
      manifestValue.assets.push({
        key: "image:generated",
        path,
        mediaType,
        bytes: 1,
        sha256: `sha256:${"0".repeat(64)}`,
        width: fixture.generatedImage.width ?? 1,
        height: fixture.generatedImage.height ?? 1,
      });
      fileSpecifications.push(
        { path: "taproot-docs/fragments/welcome.html", source: "valid/minimal/taproot-docs/fragments/welcome.html" },
        { path, generated: fixture.generatedImage, synchronizeDescriptor: true },
      );
    }
    const files = [];
    for (const file of fileSpecifications) {
      const encoded = file.base64Source
        ? (await readFile(new URL(file.base64Source, FIXTURES_ROOT), "utf8")).trim()
        : file.base64;
      const content = file.generated
        ? generatedContent(file.generated)
        : file.source
        ? await readFile(new URL(file.source, FIXTURES_ROOT))
        : Buffer.from(encoded, "base64");
      if (file.synchronizeDescriptor) {
        if (!manifestValue) manifestValue = JSON.parse(manifest.toString("utf8"));
        synchronizeDescriptor(manifestValue, file.path, content);
      }
      files.push({
        path: file.path,
        content,
      });
    }
    if (manifestValue) manifest = Buffer.from(JSON.stringify(manifestValue));
    if (fixture.manifestPaddingBytes) {
      manifest = Buffer.concat([manifest, Buffer.alloc(Math.min(fixture.manifestPaddingBytes, LIMITS.manifestBytes + 1), 0x20)]);
    }
    cases.push({
      name: fixture.name,
      valid: fixture.valid,
      expectedCodes: fixture.expectedCodes,
      manifest,
      files,
    });
  }
  return cases;
}
