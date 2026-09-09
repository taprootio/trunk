import { createHash } from "node:crypto";

import { DocsArtifactValidationError } from "@taprootio/docs-artifact";
import { createDeterministicPrebuiltArchive, PrebuiltArchiveError } from "@taprootio/docs-artifact/prebuilt/archive";

import {
  ARCHIVE_FORMAT_NAME,
  LIMITS,
  MODE_MANAGED,
  MODE_PREBUILT,
  PREBUILT_ARCHIVE_FORMAT_NAME,
} from "./constants.js";
import { PublisherError, validationFailure } from "./errors.js";

const TAR_BLOCK_BYTES = 512;
const DEFLATE_STORED_BLOCK_BYTES = 65_535;
const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[index] = value >>> 0;
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function writeOctal(header, offset, length, value) {
  const text = value.toString(8);
  if (text.length > length - 1) {
    throw new PublisherError("archive.numeric_overflow", "An artifact entry is too large for the POSIX USTAR envelope.");
  }
  header.fill(0x30, offset, offset + length - 1);
  header.write(text, offset + length - 1 - text.length, text.length, "ascii");
  header[offset + length - 1] = 0;
}

function splitUstarPath(entryPath) {
  if (!/^[\x20-\x7e]+$/u.test(entryPath)) {
    throw new PublisherError("archive.path_unrepresentable", `Artifact path '${entryPath}' is not ASCII USTAR text.`, { field: entryPath });
  }
  if (entryPath.length <= 100) return { name: entryPath, prefix: "" };
  for (let offset = entryPath.lastIndexOf("/"); offset > 0; offset = entryPath.lastIndexOf("/", offset - 1)) {
    const prefix = entryPath.slice(0, offset);
    const name = entryPath.slice(offset + 1);
    if (prefix.length <= 155 && name.length <= 100) return { name, prefix };
  }
  throw new PublisherError(
    "archive.path_unrepresentable",
    `Artifact path '${entryPath}' cannot be represented by the closed POSIX USTAR format. Shorten it before publishing.`,
    { field: entryPath },
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
    throw new PublisherError("archive.checksum_overflow", "A POSIX USTAR header checksum exceeded its envelope.");
  }
  header.write(checksumText, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function computeTarLength(entries) {
  let total = TAR_BLOCK_BYTES * 2;
  for (const entry of entries) {
    const size = entry.content.byteLength;
    total += TAR_BLOCK_BYTES + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (!Number.isSafeInteger(total)) {
      throw new PublisherError("archive.too_large", "The artifact archive exceeds the supported byte range.");
    }
  }
  return total;
}

function buildTar(entries, tarLength) {
  const tar = Buffer.alloc(tarLength);
  let offset = 0;
  for (const entry of entries) {
    const content = Buffer.from(entry.content.buffer, entry.content.byteOffset, entry.content.byteLength);
    const header = ustarHeader(entry.path, content.byteLength);
    header.copy(tar, offset);
    offset += TAR_BLOCK_BYTES;
    content.copy(tar, offset);
    offset += Math.ceil(content.byteLength / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
  }
  if (offset + TAR_BLOCK_BYTES * 2 !== tarLength) {
    throw new PublisherError("archive.internal_length", "The deterministic archive length did not match its inventory.");
  }
  return tar;
}

function deterministicGzip(tar) {
  const blockCount = Math.ceil(tar.byteLength / DEFLATE_STORED_BLOCK_BYTES);
  const outputLength = 10 + tar.byteLength + blockCount * 5 + 8;
  if (outputLength > LIMITS.compressedArchiveBytes) {
    throw new PublisherError(
      "archive.compressed_too_large",
      `The deterministic archive exceeds the ${LIMITS.compressedArchiveBytes}-byte upload limit.`,
    );
  }
  const output = Buffer.allocUnsafe(outputLength);
  output.set([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff], 0);
  let sourceOffset = 0;
  let targetOffset = 10;
  while (sourceOffset < tar.byteLength) {
    const length = Math.min(DEFLATE_STORED_BLOCK_BYTES, tar.byteLength - sourceOffset);
    const final = sourceOffset + length === tar.byteLength;
    output[targetOffset] = final ? 0x01 : 0x00;
    output.writeUInt16LE(length, targetOffset + 1);
    output.writeUInt16LE((~length) & 0xffff, targetOffset + 3);
    tar.copy(output, targetOffset + 5, sourceOffset, sourceOffset + length);
    targetOffset += 5 + length;
    sourceOffset += length;
  }
  output.writeUInt32LE(crc32(tar), targetOffset);
  output.writeUInt32LE(tar.byteLength >>> 0, targetOffset + 4);
  if (targetOffset + 8 !== outputLength) {
    throw new PublisherError("archive.internal_length", "The deterministic gzip length did not match its inventory.");
  }
  return output;
}

export function createDeterministicArchive(snapshot) {
  if (!Array.isArray(snapshot?.entries) || snapshot.entries.length === 0) {
    throw new PublisherError("archive.empty", "A validated artifact snapshot is required.");
  }
  const seen = new Set();
  const entries = [...snapshot.entries].map((entry) => {
    if (
      !entry
      || typeof entry.path !== "string"
      || !(entry.content instanceof Uint8Array)
      || seen.has(entry.path)
    ) {
      throw new PublisherError("archive.inventory", "The validated artifact inventory is invalid.");
    }
    seen.add(entry.path);
    splitUstarPath(entry.path);
    return entry;
  });
  if (
    entries[0].path !== "taproot-docs-manifest.json"
    || entries.slice(1).some((entry) => !entry.path.startsWith("taproot-docs/"))
  ) {
    throw new PublisherError("archive.inventory", "The validated artifact inventory is outside the closed Docs archive namespace.");
  }
  const manifest = entries.shift();
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  entries.unshift(manifest);
  const tarLength = computeTarLength(entries);
  const bytes = deterministicGzip(buildTar(entries, tarLength));
  return Object.freeze({
    bytes,
    byteLength: bytes.byteLength,
    contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  });
}

function requireUploadableLength(byteLength) {
  if (byteLength > LIMITS.compressedArchiveBytes) {
    throw new PublisherError(
      "archive.compressed_too_large",
      `The deterministic archive exceeds the ${LIMITS.compressedArchiveBytes}-byte upload limit.`,
    );
  }
}

// Smallest container the declared prebuilt inventory can possibly produce: one
// header block for the canonical manifest entry, a header plus block-padded
// content for every declared file, two terminator blocks, and the fixed stored
// DEFLATE framing. The manifest body is deliberately excluded because it only
// adds bytes, which keeps this a true lower bound that can never reject an
// artifact the packer would have accepted.
function declaredPrebuiltArchiveLowerBound(manifest) {
  const files = manifest?.files;
  if (!Array.isArray(files)) return 0;
  let tarBytes = TAR_BLOCK_BYTES * 3;
  for (const file of files) {
    const bytes = file?.bytes;
    if (!Number.isSafeInteger(bytes) || bytes < 0) return 0;
    tarBytes += TAR_BLOCK_BYTES + (Math.ceil(bytes / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES);
    if (!Number.isSafeInteger(tarBytes)) return Number.MAX_SAFE_INTEGER;
  }
  return 10 + tarBytes + (Math.ceil(tarBytes / DEFLATE_STORED_BLOCK_BYTES) * 5) + 8;
}

export function createDeterministicPrebuiltReleaseArchive(snapshot) {
  // The prebuilt payload envelope is larger than Taproot's compressed release
  // upload limit, so refuse an oversized artifact from its declared inventory
  // before the whole container is materialized.
  requireUploadableLength(declaredPrebuiltArchiveLowerBound(snapshot?.manifest));
  let archive;
  try {
    // The package owns the frozen prebuilt container, including its canonical
    // manifest entry, USTAR encoding, and declared-hash reverification.
    archive = createDeterministicPrebuiltArchive({ manifest: snapshot?.manifest, files: snapshot?.files });
  } catch (error) {
    if (error instanceof DocsArtifactValidationError) throw validationFailure("artifact", error.errors);
    // The package's archive codes already live in this package's `archive.*`
    // namespace; carry them through instead of collapsing them to one code.
    if (error instanceof PrebuiltArchiveError) {
      throw new PublisherError(error.code, error.message, { field: error.field });
    }
    throw error;
  }
  // The exact container is still the authority for the platform bound.
  requireUploadableLength(archive.byteLength);
  return Object.freeze({
    mode: MODE_PREBUILT,
    format: PREBUILT_ARCHIVE_FORMAT_NAME,
    bytes: archive.bytes,
    byteLength: archive.byteLength,
    contentHash: archive.contentHash,
  });
}

export function createReleaseArchive(snapshot) {
  const mode = snapshot?.mode ?? MODE_MANAGED;
  if (mode === MODE_PREBUILT) return createDeterministicPrebuiltReleaseArchive(snapshot);
  if (mode !== MODE_MANAGED) {
    throw new PublisherError(
      "archive.mode_unsupported",
      "The validated snapshot names an unsupported publication mode.",
      { field: "mode" },
    );
  }
  const archive = createDeterministicArchive(snapshot);
  return Object.freeze({
    mode: MODE_MANAGED,
    format: ARCHIVE_FORMAT_NAME,
    bytes: archive.bytes,
    byteLength: archive.byteLength,
    contentHash: archive.contentHash,
  });
}
