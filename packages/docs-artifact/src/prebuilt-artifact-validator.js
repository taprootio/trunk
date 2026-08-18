import { snapshotBinaryInput } from "./binary.js";
import { DocsArtifactValidationError, ValidationContext } from "./errors.js";
import { PREBUILT_LIMITS, PREBUILT_TEXT_MEDIA_TYPES } from "./prebuilt-constants.js";
import { validatePrebuiltManifest } from "./prebuilt-manifest-validator.js";
import { normalizePrebuiltArtifactPath } from "./prebuilt-path.js";

function inspectStringContent(content, maximumBytes) {
  let byteLength = 0;
  for (let offset = 0; offset < content.length;) {
    const first = content.charCodeAt(offset);
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = content.charCodeAt(offset + 1);
      if (second < 0xdc00 || second > 0xdfff) return { error: "file.invalid_unicode" };
      byteLength += 4;
      offset += 2;
    } else {
      if (first >= 0xdc00 && first <= 0xdfff) return { error: "file.invalid_unicode" };
      byteLength += first <= 0x7f ? 1 : first <= 0x7ff ? 2 : 3;
      offset += 1;
    }
    if (byteLength > maximumBytes) return { kind: "string", byteLength };
  }
  return { kind: "string", byteLength, content };
}

function inspectContent(content, remainingArtifactBytes, trustBinarySnapshot) {
  const maximumBytes = Math.min(PREBUILT_LIMITS.fileBytes, remainingArtifactBytes);
  if (typeof content === "string") return inspectStringContent(content, maximumBytes);
  if (trustBinarySnapshot) {
    if (!(content instanceof Uint8Array)) return undefined;
    const byteLength = content.byteLength;
    return byteLength > maximumBytes
      ? { kind: "too_large", byteLength }
      : { kind: "bytes", byteLength, bytes: content };
  }
  const snapshot = snapshotBinaryInput(content, maximumBytes);
  if (snapshot.kind === "bytes" || snapshot.kind === "too_large") return snapshot;
  return undefined;
}

function materializeContent(content) {
  if (content.kind === "string") return new TextEncoder().encode(content.content);
  return content.bytes;
}

async function sha256(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function isUtf8(bytes) {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
      decoder.decode(bytes.subarray(offset, Math.min(bytes.byteLength, offset + (64 * 1024))), { stream: true });
    }
    decoder.decode();
    return true;
  } catch {
    return false;
  }
}

async function validatePrebuiltArtifactContents(manifest, fileEntries, trustBinarySnapshots) {
  const context = new ValidationContext();
  const expected = new Map(manifest.files.map((descriptor, index) => [
    descriptor.path,
    { descriptor, descriptorPath: `$.files[${index}]` },
  ]));
  const seen = new Set();
  const seenCaseFolded = new Map();
  const snapshots = new Map();
  let totalBytes = 0;
  let entryCount = 0;
  let stoppedForTotal = false;

  try {
    if (typeof fileEntries === "string" || fileEntries === null || fileEntries === undefined) {
      throw new TypeError("File entries must be an object iterable.");
    }
    for (const entry of fileEntries) {
      entryCount += 1;
      if (entryCount > PREBUILT_LIMITS.files) {
        context.add(
          "limit.files",
          "$files",
          `Prebuilt artifacts may not contain more than ${PREBUILT_LIMITS.files} payload files.`,
        );
        break;
      }
      const entryPath = `$files[${entryCount - 1}]`;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        context.add("file.invalid_entry", entryPath, "File entries must be objects with path and content.");
        continue;
      }
      const normalized = normalizePrebuiltArtifactPath(entry.path);
      if (!normalized.ok) {
        context.add(normalized.code, `${entryPath}.path`, normalized.message);
        continue;
      }
      const folded = normalized.value.toLowerCase();
      if (seen.has(normalized.value)) {
        context.add("duplicate.file_entry", `${entryPath}.path`, `File '${normalized.value}' appears more than once.`);
        continue;
      }
      if (seenCaseFolded.has(folded)) {
        context.add(
          "duplicate.file_entry_casefold",
          `${entryPath}.path`,
          `File '${normalized.value}' collides with '${seenCaseFolded.get(folded)}' after ASCII case-folding.`,
        );
        continue;
      }
      seen.add(normalized.value);
      seenCaseFolded.set(folded, normalized.value);

      const expectedFile = expected.get(normalized.value);
      if (!expectedFile) {
        context.add(
          "file.unexpected",
          `${entryPath}.path`,
          `File '${normalized.value}' is not declared by the prebuilt manifest.`,
        );
      }
      const content = inspectContent(
        entry.content,
        Math.max(0, PREBUILT_LIMITS.artifactBytes - totalBytes),
        trustBinarySnapshots,
      );
      if (!content) {
        context.add(
          "file.invalid_content",
          `${entryPath}.content`,
          "File content must be a string, Uint8Array, or ArrayBuffer.",
        );
        continue;
      }
      if (content.error) {
        context.add(
          content.error,
          `${entryPath}.content`,
          "String file content must contain only well-formed Unicode scalar values.",
        );
        continue;
      }
      if (content.byteLength > PREBUILT_LIMITS.artifactBytes - totalBytes) {
        context.add(
          "limit.artifact_bytes",
          "$files",
          `Prebuilt payload bytes may not exceed ${PREBUILT_LIMITS.artifactBytes}.`,
        );
        stoppedForTotal = true;
        break;
      }
      totalBytes += content.byteLength;
      if (content.byteLength > PREBUILT_LIMITS.fileBytes) {
        context.add(
          "file.too_large",
          `${entryPath}.content`,
          `File '${normalized.value}' exceeds ${PREBUILT_LIMITS.fileBytes} bytes.`,
        );
        continue;
      }
      if (content.kind === "too_large") {
        context.add(
          "file.too_large",
          `${entryPath}.content`,
          `File '${normalized.value}' exceeds its bounded read allocation.`,
        );
        continue;
      }
      if (expectedFile && content.byteLength !== expectedFile.descriptor.bytes) {
        context.add(
          "file.size_drift",
          `${expectedFile.descriptorPath}.bytes`,
          `File '${normalized.value}' has ${content.byteLength} bytes; manifest declares ${expectedFile.descriptor.bytes}.`,
        );
      }
      const bytes = materializeContent(content);
      snapshots.set(normalized.value, bytes);
    }
  } catch {
    context.add("file.invalid_iterable", "$files", "Could not enumerate prebuilt files safely.");
  }

  if (!stoppedForTotal) {
    for (const [filePath, expectedFile] of expected) {
      const bytes = snapshots.get(filePath);
      if (!bytes) {
        if (!seen.has(filePath)) {
          context.add("file.missing", `${expectedFile.descriptorPath}.path`, `Declared file '${filePath}' is missing.`);
        }
        continue;
      }
      if (bytes.byteLength !== expectedFile.descriptor.bytes) continue;
      const actualHash = await sha256(bytes);
      if (actualHash !== expectedFile.descriptor.sha256) {
        context.add(
          "file.hash_drift",
          `${expectedFile.descriptorPath}.sha256`,
          `File '${filePath}' does not match its declared SHA-256.`,
        );
      }
      if (PREBUILT_TEXT_MEDIA_TYPES.includes(expectedFile.descriptor.mediaType) && !isUtf8(bytes)) {
        context.add(
          "file.invalid_utf8",
          `${expectedFile.descriptorPath}.mediaType`,
          `File '${filePath}' must be valid UTF-8 for media type '${expectedFile.descriptor.mediaType}'.`,
        );
      }
    }
  }

  const files = manifest.files
    .filter((descriptor) => snapshots.has(descriptor.path))
    .map((descriptor) => ({ path: descriptor.path, content: snapshots.get(descriptor.path) }));
  return context.finish({ manifest, files, fileCount: snapshots.size, totalBytes });
}

export async function validatePrebuiltArtifact(manifestInput, fileEntries, options = {}) {
  const manifestResult = validatePrebuiltManifest(manifestInput, options);
  if (!manifestResult.ok) return manifestResult;
  return validatePrebuiltArtifactContents(manifestResult.value, fileEntries, false);
}

// Internal Node boundary: the manifest and buffers were already snapshotted from
// stable file handles and are not reachable by the public caller.
export async function validatePrebuiltArtifactFromTrustedSnapshots(validatedManifest, fileEntries) {
  return validatePrebuiltArtifactContents(validatedManifest, fileEntries, true);
}

export async function assertValidPrebuiltArtifact(manifestInput, fileEntries, options = {}) {
  const result = await validatePrebuiltArtifact(manifestInput, fileEntries, options);
  if (!result.ok) throw new DocsArtifactValidationError(result.errors);
  return result.value;
}
