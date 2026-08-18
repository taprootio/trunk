import { createHash } from "node:crypto";

import { PREBUILT_ARCHIVE_FORMAT, PREBUILT_LIMITS, PREBUILT_MANIFEST_FILE_NAME } from "./prebuilt-constants.js";
import { serializePrebuiltManifest } from "./prebuilt-manifest-validator.js";

const TAR_BLOCK_BYTES = 512;
const DEFLATE_STORED_BLOCK_BYTES = 65_535;
const GZIP_HEADER = Uint8Array.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]);
const GZIP_TRAILER_BYTES = 8;
const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[index] = value >>> 0;
}

const MAXIMUM_TAR_BYTES = PREBUILT_LIMITS.manifestBytes
  + PREBUILT_LIMITS.artifactBytes
  + ((PREBUILT_LIMITS.files + 1) * ((TAR_BLOCK_BYTES * 2) - 1))
  + (TAR_BLOCK_BYTES * 2);

export class PrebuiltArchiveError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = "PrebuiltArchiveError";
    this.code = code;
    if (field !== undefined) this.field = field;
  }
}

function archiveError(code, message, field) {
  throw new PrebuiltArchiveError(code, message, field);
}

function writeOctal(header, offset, length, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    archiveError("archive.numeric_overflow", "A POSIX USTAR numeric field is outside the supported integer range.");
  }
  const text = value.toString(8);
  if (text.length > length - 1) {
    archiveError("archive.numeric_overflow", "A POSIX USTAR numeric field exceeds its fixed octal envelope.");
  }
  header.fill(0x30, offset, offset + length - 1);
  header.write(text, offset + length - 1 - text.length, text.length, "ascii");
  header[offset + length - 1] = 0;
}

function splitUstarPath(entryPath) {
  if (typeof entryPath !== "string" || !/^[\x20-\x7e]+$/u.test(entryPath)) {
    archiveError("archive.path_unrepresentable", "Archive paths must be printable ASCII POSIX USTAR text.", entryPath);
  }
  if (entryPath.length <= 100) return { name: entryPath, prefix: "" };
  for (let offset = entryPath.lastIndexOf("/"); offset > 0; offset = entryPath.lastIndexOf("/", offset - 1)) {
    const prefix = entryPath.slice(0, offset);
    const name = entryPath.slice(offset + 1);
    if (prefix.length <= 155 && name.length <= 100) return { name, prefix };
  }
  archiveError(
    "archive.path_unrepresentable",
    `Archive path '${entryPath}' does not fit the POSIX USTAR name and prefix fields.`,
    entryPath,
  );
}

function ustarHeader(entryPath, byteLength) {
  const { name, prefix } = splitUstarPath(entryPath);
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  header.write(name, 0, name.length, "ascii");
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  writeOctal(header, 329, 8, 0);
  writeOctal(header, 337, 8, 0);
  if (prefix) header.write(prefix, 345, prefix.length, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumText = checksum.toString(8).padStart(6, "0");
  if (checksumText.length !== 6) {
    archiveError("archive.checksum_overflow", "A POSIX USTAR header checksum exceeds its fixed octal envelope.");
  }
  header.write(checksumText, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function roundedTarContentBytes(byteLength) {
  const remainder = byteLength % TAR_BLOCK_BYTES;
  return remainder === 0 ? byteLength : byteLength + TAR_BLOCK_BYTES - remainder;
}

function computeTarLength(entries) {
  let total = TAR_BLOCK_BYTES * 2;
  for (const entry of entries) {
    total += TAR_BLOCK_BYTES + roundedTarContentBytes(entry.content.byteLength);
    if (!Number.isSafeInteger(total) || total > MAXIMUM_TAR_BYTES) {
      archiveError("archive.too_large", "The archive exceeds the bounded prebuilt POSIX USTAR envelope.");
    }
  }
  return total;
}

function gzipLength(tarLength) {
  const blockCount = Math.ceil(tarLength / DEFLATE_STORED_BLOCK_BYTES);
  const length = GZIP_HEADER.byteLength + tarLength + (blockCount * 5) + GZIP_TRAILER_BYTES;
  if (!Number.isSafeInteger(length)) {
    archiveError("archive.too_large", "The deterministic gzip member exceeds the supported byte range.");
  }
  return { blockCount, length };
}

function storedBlockDataOffset(tarOffset) {
  const blockIndex = Math.floor(tarOffset / DEFLATE_STORED_BLOCK_BYTES);
  return GZIP_HEADER.byteLength + tarOffset + (blockIndex * 5) + 5;
}

function visitTarRange(output, start, byteLength, visitor) {
  let tarOffset = start;
  let remaining = byteLength;
  while (remaining > 0) {
    const inBlockOffset = tarOffset % DEFLATE_STORED_BLOCK_BYTES;
    const length = Math.min(remaining, DEFLATE_STORED_BLOCK_BYTES - inBlockOffset);
    const outputOffset = storedBlockDataOffset(tarOffset);
    visitor(output.subarray(outputOffset, outputOffset + length));
    tarOffset += length;
    remaining -= length;
  }
}

function writeTarRange(output, start, bytes) {
  let sourceOffset = 0;
  visitTarRange(output, start, bytes.byteLength, (target) => {
    target.set(bytes.subarray(sourceOffset, sourceOffset + target.byteLength));
    sourceOffset += target.byteLength;
  });
}

function initializeStoredBlocks(output, tarLength, blockCount) {
  output.set(GZIP_HEADER, 0);
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    const tarOffset = blockIndex * DEFLATE_STORED_BLOCK_BYTES;
    const length = Math.min(DEFLATE_STORED_BLOCK_BYTES, tarLength - tarOffset);
    const outputOffset = GZIP_HEADER.byteLength + tarOffset + (blockIndex * 5);
    output[outputOffset] = blockIndex === blockCount - 1 ? 0x01 : 0x00;
    output.writeUInt16LE(length, outputOffset + 1);
    output.writeUInt16LE((~length) & 0xffff, outputOffset + 3);
  }
}

function crc32Tar(output, tarLength) {
  let value = 0xffffffff;
  visitTarRange(output, 0, tarLength, (bytes) => {
    for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  });
  return (value ^ 0xffffffff) >>> 0;
}

function sha256TarRange(output, start, byteLength) {
  const hash = createHash("sha256");
  visitTarRange(output, start, byteLength, (bytes) => hash.update(bytes));
  return `sha256:${hash.digest("hex")}`;
}

function snapshotEntries(snapshot, options) {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    archiveError("archive.inventory", "A validated prebuilt artifact snapshot is required.");
  }
  const manifestText = serializePrebuiltManifest(snapshot.manifest, options);
  const manifestBytes = Buffer.from(manifestText, "utf8");
  const manifest = JSON.parse(manifestText);
  if (!Array.isArray(snapshot.files) || snapshot.files.length !== manifest.files.length) {
    archiveError("archive.inventory", "The prebuilt snapshot must contain every declared payload file exactly once.");
  }
  const supplied = new Map();
  for (const entry of snapshot.files) {
    if (
      entry === null
      || typeof entry !== "object"
      || typeof entry.path !== "string"
      || !(entry.content instanceof Uint8Array)
      || supplied.has(entry.path)
    ) {
      archiveError("archive.inventory", "The prebuilt snapshot contains an invalid or duplicate payload entry.");
    }
    supplied.set(entry.path, entry.content);
  }
  const entries = [{ path: PREBUILT_MANIFEST_FILE_NAME, content: manifestBytes }];
  for (const descriptor of manifest.files) {
    const content = supplied.get(descriptor.path);
    if (!content || content.byteLength !== descriptor.bytes) {
      archiveError(
        "archive.size_drift",
        `Payload '${descriptor.path}' does not match its declared byte length.`,
        descriptor.path,
      );
    }
    splitUstarPath(descriptor.path);
    entries.push({ path: descriptor.path, content, expectedHash: descriptor.sha256 });
    supplied.delete(descriptor.path);
  }
  if (supplied.size !== 0) {
    archiveError("archive.inventory", "The prebuilt snapshot contains undeclared payload files.");
  }
  return entries;
}

export function createDeterministicPrebuiltArchive(snapshot, options = {}) {
  const entries = snapshotEntries(snapshot, options);
  const tarLength = computeTarLength(entries);
  const { blockCount, length: outputLength } = gzipLength(tarLength);
  const output = Buffer.alloc(outputLength);
  initializeStoredBlocks(output, tarLength, blockCount);

  let tarOffset = 0;
  for (const entry of entries) {
    const header = ustarHeader(entry.path, entry.content.byteLength);
    writeTarRange(output, tarOffset, header);
    tarOffset += TAR_BLOCK_BYTES;
    const contentOffset = tarOffset;
    writeTarRange(output, contentOffset, entry.content);
    if (entry.expectedHash && sha256TarRange(output, contentOffset, entry.content.byteLength) !== entry.expectedHash) {
      archiveError("archive.hash_drift", `Payload '${entry.path}' does not match its declared SHA-256.`, entry.path);
    }
    tarOffset += roundedTarContentBytes(entry.content.byteLength);
  }
  if (tarOffset + (TAR_BLOCK_BYTES * 2) !== tarLength) {
    archiveError("archive.internal_length", "The deterministic tar length does not match its frozen inventory.");
  }

  const trailerOffset = outputLength - GZIP_TRAILER_BYTES;
  output.writeUInt32LE(crc32Tar(output, tarLength), trailerOffset);
  output.writeUInt32LE(tarLength >>> 0, trailerOffset + 4);
  const contentHash = `sha256:${createHash("sha256").update(output).digest("hex")}`;
  return Object.freeze({
    format: PREBUILT_ARCHIVE_FORMAT,
    bytes: output,
    byteLength: output.byteLength,
    contentHash,
  });
}
