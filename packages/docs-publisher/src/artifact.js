import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import {
  LIMITS as ARTIFACT_LIMITS,
  MANIFEST_FILE_NAME,
  serializeManifest,
  validateArtifact,
} from "@taprootio/docs-artifact";
import { validateArtifactDirectory } from "@taprootio/docs-artifact/node";
import { validatePrebuiltArtifactDirectory } from "@taprootio/docs-artifact/prebuilt/node";

import { ARTIFACT_SCHEMA_VERSION, MODE_MANAGED, MODE_PREBUILT } from "./constants.js";
import { PublisherError, validationFailure } from "./errors.js";

const READ_CHUNK_BYTES = 64 * 1024;

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function isWithinRoot(root, candidate) {
  return candidate.startsWith(`${root}${path.sep}`);
}

async function assertRealAncestors(root, relativePath) {
  let current = root;
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stats;
    try {
      stats = await lstat(current, { bigint: true });
    } catch {
      throw new PublisherError("artifact.file_missing", `Required artifact file '${relativePath}' is missing.`, { field: relativePath });
    }
    if (stats.isSymbolicLink() || (index < segments.length - 1 ? !stats.isDirectory() : !stats.isFile())) {
      throw new PublisherError(
        "artifact.file_not_regular",
        `Artifact path '${relativePath}' must contain only real directories and a regular file.`,
        { field: relativePath },
      );
    }
  }
}

async function readBoundedSnapshot(rootBoundary, relativePath, maximumBytes, expectedBytes) {
  await assertRealAncestors(rootBoundary.path, relativePath);
  const absolutePath = path.resolve(rootBoundary.path, ...relativePath.split("/"));
  if (!isWithinRoot(rootBoundary.path, absolutePath)) {
    throw new PublisherError("artifact.path_escape", `Artifact path '${relativePath}' escapes the artifact root.`, { field: relativePath });
  }
  let handle;
  try {
    handle = await open(
      absolutePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new PublisherError("artifact.file_not_regular", `Artifact path '${relativePath}' is not a regular file.`, { field: relativePath });
    }
    if (before.size > BigInt(maximumBytes)) {
      throw new PublisherError("artifact.file_too_large", `Artifact file '${relativePath}' exceeds its byte limit.`, { field: relativePath });
    }
    if (expectedBytes !== undefined && before.size !== BigInt(expectedBytes)) {
      throw new PublisherError("artifact.file_size_drift", `Artifact file '${relativePath}' does not match its declared byte length.`, { field: relativePath });
    }

    const chunks = [];
    let total = 0;
    while (total <= maximumBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maximumBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, total);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (total > maximumBytes || BigInt(total) !== after.size || !sameSnapshot(before, after)) {
      throw new PublisherError("artifact.file_changed", `Artifact file '${relativePath}' changed while it was being read.`, { field: relativePath });
    }

    const rootAfter = await lstat(rootBoundary.path, { bigint: true });
    const resolvedAfter = await realpath(absolutePath);
    const resolvedStats = await lstat(resolvedAfter, { bigint: true });
    if (
      !sameIdentity(rootBoundary.stats, rootAfter)
      || rootAfter.isSymbolicLink()
      || !isWithinRoot(rootBoundary.realPath, resolvedAfter)
      || resolvedStats.isSymbolicLink()
      || !resolvedStats.isFile()
      || !sameIdentity(before, resolvedStats)
    ) {
      throw new PublisherError("artifact.file_changed", `Artifact path '${relativePath}' changed while it was being read.`, { field: relativePath });
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof PublisherError) throw error;
    throw new PublisherError("artifact.file_unreadable", `Could not safely read artifact file '${relativePath}'.`, { field: relativePath });
  } finally {
    await handle?.close().catch(() => {});
  }
}

function declaredFiles(manifest) {
  const result = [];
  for (const resource of manifest.resources) {
    for (const variant of resource.variants) {
      for (const fragment of variant.fragments) {
        result.push({ path: fragment.path, bytes: fragment.bytes, maximumBytes: ARTIFACT_LIMITS.fragmentBytes });
      }
    }
  }
  for (const asset of manifest.assets) {
    result.push({ path: asset.path, bytes: asset.bytes, maximumBytes: ARTIFACT_LIMITS.assetBytes });
  }
  return result.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

async function snapshotManagedArtifact(rootDirectory) {
  const directoryResult = await validateArtifactDirectory(rootDirectory);
  if (!directoryResult.ok) throw validationFailure("artifact", directoryResult.errors);
  const manifest = directoryResult.value.manifest;
  if (manifest.schemaVersion !== ARTIFACT_SCHEMA_VERSION) {
    throw new PublisherError(
      "artifact.unsupported_schema",
      `Artifact schemaVersion must be ${ARTIFACT_SCHEMA_VERSION}.`,
      { field: "$.schemaVersion" },
    );
  }

  const rootPath = path.resolve(rootDirectory);
  const rootStats = await lstat(rootPath, { bigint: true });
  const rootRealPath = await realpath(rootPath);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory() || rootPath !== rootRealPath) {
    throw new PublisherError("artifact.directory_changed", "The artifact root must remain one real directory while it is packaged.");
  }
  const boundary = { path: rootPath, realPath: rootRealPath, stats: rootStats };

  // Use canonical manifest bytes in the upload so equivalent producer JSON
  // formatting cannot change the release hash.
  const canonicalManifest = Buffer.from(serializeManifest(manifest), "utf8");
  if (canonicalManifest.byteLength > ARTIFACT_LIMITS.manifestBytes) {
    throw new PublisherError("artifact.manifest_too_large", "The canonical artifact manifest exceeds its byte limit.");
  }

  const files = [];
  for (const declaration of declaredFiles(manifest)) {
    const content = await readBoundedSnapshot(
      boundary,
      declaration.path,
      declaration.maximumBytes,
      declaration.bytes,
    );
    files.push({ path: declaration.path, content });
  }
  const exactResult = await validateArtifact(manifest, files);
  if (!exactResult.ok) throw validationFailure("artifact", exactResult.errors);

  const rootAfter = await lstat(rootPath, { bigint: true });
  if (!sameIdentity(rootStats, rootAfter) || rootAfter.isSymbolicLink() || !rootAfter.isDirectory()) {
    throw new PublisherError("artifact.directory_changed", "The artifact root changed while it was packaged.");
  }

  return Object.freeze({
    mode: MODE_MANAGED,
    manifest,
    entries: Object.freeze([
      Object.freeze({ path: MANIFEST_FILE_NAME, content: canonicalManifest }),
      ...files.map((entry) => Object.freeze(entry)),
    ]),
    fileCount: exactResult.value.fileCount,
    semanticBytes: exactResult.value.totalBytes,
  });
}

async function snapshotPrebuiltArtifact(rootDirectory) {
  // The package owns the hardened prebuilt directory walk: it enumerates,
  // reads, and re-verifies the declared tree through stable descriptors and
  // never executes payload content. The publisher adds nothing to that read.
  const directoryResult = await validatePrebuiltArtifactDirectory(rootDirectory);
  if (!directoryResult.ok) throw validationFailure("artifact", directoryResult.errors);
  const validated = directoryResult.value;
  if (validated.manifest.schemaVersion !== ARTIFACT_SCHEMA_VERSION) {
    throw new PublisherError(
      "artifact.unsupported_schema",
      `Artifact schemaVersion must be ${ARTIFACT_SCHEMA_VERSION}.`,
      { field: "$.schemaVersion" },
    );
  }

  // The prebuilt inventory carries only declared payload files in manifest path
  // order; the archive writer serializes the canonical manifest entry itself.
  // Copy that inventory into an isolated snapshot instead of mutating the
  // validator's result.
  return Object.freeze({
    mode: MODE_PREBUILT,
    manifest: validated.manifest,
    files: Object.freeze(
      validated.files.map((file) => Object.freeze({ path: file.path, content: file.content })),
    ),
    fileCount: validated.fileCount,
    semanticBytes: validated.totalBytes,
  });
}

export async function snapshotDocsArtifact(rootDirectory, mode = MODE_MANAGED) {
  if (mode === MODE_PREBUILT) return await snapshotPrebuiltArtifact(rootDirectory);
  if (mode !== MODE_MANAGED) {
    throw new PublisherError(
      "artifact.mode_unsupported",
      "The selected publication mode has no Docs artifact contract.",
      { field: "mode" },
    );
  }
  return await snapshotManagedArtifact(rootDirectory);
}
