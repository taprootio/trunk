import { createHash } from "node:crypto";

import { SiteAuthoringError } from "./errors.js";

/**
 * Content hashing and pixel-dimension sniffing for `media upload`.
 *
 * `RequestImageUpload` wants the SHA-256 (for the dedup short-circuit) and the
 * width and height before a single byte is uploaded, and the repo's zero
 * runtime dependency rule means the client reads them out of the container
 * header itself. The sniffer is deliberately a *header* reader: it inspects a
 * fixed, bounded prefix of each container and never walks pixel data, so a
 * hostile file cannot turn dimension discovery into a decode.
 *
 * Only the four raster containers the image service accepts are recognized.
 * Everything else — SVG above all, which is a script-execution surface, not a
 * raster — is refused with a stable code rather than uploaded and discovered
 * server-side.
 */

export const IMAGE_CONTENT_TYPES = Object.freeze({
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
});

// One JPEG can carry a long run of metadata segments before its frame header.
// The scan is bounded so a crafted file cannot spin here.
const MAXIMUM_JPEG_SEGMENTS = 256;
const MAXIMUM_DIMENSION = 65_535;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SOI = Buffer.from([0xff, 0xd8]);

function unsupportedFormat(fileName) {
  return new SiteAuthoringError(
    "media.unsupported_format",
    `'${fileName}' is not a PNG, JPEG, GIF, or WebP image. Taproot accepts raster uploads only.`,
    { field: fileName },
  );
}

function unreadableDimensions(fileName) {
  return new SiteAuthoringError(
    "media.dimensions_unreadable",
    `The image header in '${fileName}' is truncated or malformed, so its dimensions cannot be read.`,
    { field: fileName },
  );
}

function startsWithAscii(bytes, text, offset = 0) {
  if (bytes.byteLength < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function pngDimensions(bytes, fileName) {
  // Length (4) + "IHDR" (4) + width (4) + height (4) after the 8-byte signature.
  if (bytes.byteLength < 24 || !startsWithAscii(bytes, "IHDR", 12)) throw unreadableDimensions(fileName);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function gifDimensions(bytes, fileName) {
  if (bytes.byteLength < 10) throw unreadableDimensions(fileName);
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

function isJpegFrameMarker(marker) {
  // SOF0-SOF15 minus DHT (0xC4), JPG (0xC8), and DAC (0xCC), none of which
  // carry frame dimensions.
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegDimensions(bytes, fileName) {
  let offset = 2;
  for (let segment = 0; segment < MAXIMUM_JPEG_SEGMENTS; segment += 1) {
    // Segments may be padded with any number of 0xFF fill bytes.
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) throw unreadableDimensions(fileName);
    const marker = bytes[offset];
    offset += 1;
    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (offset + 2 > bytes.byteLength) throw unreadableDimensions(fileName);
    const length = bytes.readUInt16BE(offset);
    if (length < 2) throw unreadableDimensions(fileName);
    if (isJpegFrameMarker(marker)) {
      // length (2) + sample precision (1) + height (2) + width (2).
      if (offset + 7 > bytes.byteLength) throw unreadableDimensions(fileName);
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
    // A 0xDA (start of scan) hands off to entropy-coded data, which this
    // reader must never walk.
    if (marker === 0xda) break;
  }
  throw unreadableDimensions(fileName);
}

function webpDimensions(bytes, fileName) {
  // RIFF (4) + file size (4) + WEBP (4), then one chunk header of fourcc (4)
  // and size (4), so chunk payloads begin at 20.
  if (bytes.byteLength < 30) throw unreadableDimensions(fileName);
  if (startsWithAscii(bytes, "VP8X", 12)) {
    // Flags (1) + reserved (3), then two 24-bit little-endian "minus one" values.
    const width = (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1;
    const height = (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1;
    return { width, height };
  }
  if (startsWithAscii(bytes, "VP8L", 12)) {
    if (bytes[20] !== 0x2f) throw unreadableDimensions(fileName);
    const packed = bytes.readUInt32LE(21);
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
  }
  if (startsWithAscii(bytes, "VP8 ", 12)) {
    // Frame tag (3), sync code 0x9D 0x01 0x2A (3), then two 14-bit dimensions.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) throw unreadableDimensions(fileName);
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  throw unreadableDimensions(fileName);
}

/** The SHA-256 the dedup short-circuit is keyed on. */
export function contentHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Reads the container type and pixel dimensions out of an image's header.
 * Returns `{ contentType, width, height }`; throws `media.unsupported_format`
 * for a container Taproot does not accept and `media.dimensions_unreadable`
 * for a recognized container whose header does not hold usable dimensions.
 */
export function inspectImageBytes(bytes, fileName = "image") {
  if (!Buffer.isBuffer(bytes)) {
    throw new SiteAuthoringError("media.unreadable", "The image bytes could not be inspected.", { field: fileName });
  }
  let contentType;
  let dimensions;
  if (bytes.byteLength >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    contentType = IMAGE_CONTENT_TYPES.png;
    dimensions = pngDimensions(bytes, fileName);
  } else if (bytes.byteLength >= 2 && bytes.subarray(0, 2).equals(JPEG_SOI)) {
    contentType = IMAGE_CONTENT_TYPES.jpeg;
    dimensions = jpegDimensions(bytes, fileName);
  } else if (startsWithAscii(bytes, "GIF87a") || startsWithAscii(bytes, "GIF89a")) {
    contentType = IMAGE_CONTENT_TYPES.gif;
    dimensions = gifDimensions(bytes, fileName);
  } else if (startsWithAscii(bytes, "RIFF") && startsWithAscii(bytes, "WEBP", 8)) {
    contentType = IMAGE_CONTENT_TYPES.webp;
    dimensions = webpDimensions(bytes, fileName);
  } else {
    throw unsupportedFormat(fileName);
  }
  if (
    !Number.isSafeInteger(dimensions.width)
    || !Number.isSafeInteger(dimensions.height)
    || dimensions.width <= 0
    || dimensions.height <= 0
    || dimensions.width > MAXIMUM_DIMENSION
    || dimensions.height > MAXIMUM_DIMENSION
  ) {
    throw unreadableDimensions(fileName);
  }
  return { contentType, width: dimensions.width, height: dimensions.height };
}
