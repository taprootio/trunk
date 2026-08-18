import { constants as fsConstants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { LIMITS } from "./constants.js";
import { compareCanonicalStrings, ValidationContext } from "./errors.js";
import { DIRECTORY_LIMITS_OVERRIDE, FILE_OPEN_RACE_HOOK, FILE_READ_RACE_HOOK } from "./node-internal.js";
import { validatePrebuiltArtifactFromTrustedSnapshots } from "./prebuilt-artifact-validator.js";
import { PREBUILT_LIMITS, PREBUILT_MANIFEST_FILE_NAME } from "./prebuilt-constants.js";
import { snapshotPrebuiltSupportedCapabilities, validatePrebuiltManifest } from "./prebuilt-manifest-validator.js";
import { normalizePrebuiltArtifactPath } from "./prebuilt-path.js";

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const NON_BLOCKING = fsConstants.O_NONBLOCK ?? 0;
const READ_CHUNK_BYTES = 64 * 1024;

function errorCode(error) {
  return error && typeof error === "object" && typeof error.code === "string" ? error.code : undefined;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function snapshotTreeEntry(type, stats) {
  return { type, dev: stats.dev, ino: stats.ino };
}

function isWithinRoot(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function openNoFollow(filePath) {
  const flags = fsConstants.O_RDONLY | NON_BLOCKING;
  if (NO_FOLLOW === 0) return { handle: await open(filePath, flags), verifyPathIdentity: true };
  try {
    return { handle: await open(filePath, flags | NO_FOLLOW), verifyPathIdentity: false };
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(errorCode(error))) throw error;
    return { handle: await open(filePath, flags), verifyPathIdentity: true };
  }
}

async function readBounded(handle, maximumBytes) {
  const chunks = [];
  let totalBytes = 0;
  while (totalBytes <= maximumBytes) {
    const remaining = maximumBytes + 1 - totalBytes;
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, totalBytes);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function verifyPathSnapshot(absolutePath, snapshot, boundary) {
  try {
    const rootAfter = await lstat(boundary.rootPath, { bigint: true });
    if (rootAfter.isSymbolicLink() || !rootAfter.isDirectory() || !sameIdentity(boundary.rootStats, rootAfter)) {
      return false;
    }
    const relative = path.relative(boundary.rootPath, absolutePath);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return false;
    }
    let current = boundary.rootPath;
    const segments = relative.split(path.sep);
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]);
      const stats = await lstat(current, { bigint: true });
      if (stats.isSymbolicLink()) return false;
      const firstWalkEntry = boundary.firstWalk?.get(segments.slice(0, index + 1).join("/"));
      if (boundary.firstWalk && (!firstWalkEntry || !sameIdentity(firstWalkEntry, stats))) return false;
      if (index < segments.length - 1) {
        if (!stats.isDirectory() || (boundary.firstWalk && firstWalkEntry.type !== "directory")) return false;
      } else if (
        !stats.isFile()
        || (boundary.firstWalk && firstWalkEntry.type !== "regular")
        || !sameSnapshot(snapshot, stats)
      ) return false;
    }
    const resolved = await realpath(absolutePath);
    if (!isWithinRoot(boundary.rootRealPath, resolved)) return false;
    const resolvedStats = await lstat(resolved, { bigint: true });
    return !resolvedStats.isSymbolicLink() && resolvedStats.isFile() && sameSnapshot(snapshot, resolvedStats);
  } catch {
    return false;
  }
}

async function readStableFile(
  absolutePath,
  displayPath,
  maximumBytes,
  expectedBytes,
  expectedBytesPath,
  budget,
  boundary,
  context,
) {
  let opened;
  try {
    opened = await openNoFollow(absolutePath);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      context.add("file.missing", displayPath, `Required file '${displayPath}' is missing.`);
    } else if (code === "ELOOP") {
      context.add("file.symlink", displayPath, `Symbolic links are not allowed for '${displayPath}'.`);
    } else context.add("file.unreadable", displayPath, `Could not open '${displayPath}'.`);
    return undefined;
  }
  const { handle, verifyPathIdentity } = opened;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      context.add("file.not_regular", displayPath, `'${displayPath}' must be a regular file.`);
      return undefined;
    }
    if (verifyPathIdentity) {
      let pathStats;
      try {
        pathStats = await lstat(absolutePath, { bigint: true });
      } catch {
        context.add("file.changed", displayPath, `'${displayPath}' changed while it was being opened.`);
        return undefined;
      }
      if (pathStats.isSymbolicLink()) {
        context.add("file.symlink", displayPath, `Symbolic links are not allowed for '${displayPath}'.`);
        return undefined;
      }
      if (!sameIdentity(before, pathStats)) {
        context.add("file.changed", displayPath, `'${displayPath}' changed while it was being opened.`);
        return undefined;
      }
    }
    if (before.size > BigInt(maximumBytes)) {
      context.add("file.too_large", displayPath, `'${displayPath}' exceeds the ${maximumBytes}-byte read bound.`);
      return undefined;
    }
    if (expectedBytes !== undefined && before.size !== BigInt(expectedBytes)) {
      context.add(
        "file.size_drift",
        expectedBytesPath,
        `File '${displayPath}' has ${before.size} bytes; manifest declares ${expectedBytes}.`,
      );
      return undefined;
    }
    if (budget && before.size > BigInt(budget.remainingBytes)) {
      context.add(
        "limit.artifact_bytes",
        "$files",
        `Prebuilt payload bytes may not exceed ${PREBUILT_LIMITS.artifactBytes}.`,
      );
      budget.stopped = true;
      return undefined;
    }
    if (budget) budget.remainingBytes -= Number(before.size);
    const readMaximum = expectedBytes ?? maximumBytes;
    const bytes = await readBounded(handle, readMaximum);
    const after = await handle.stat({ bigint: true });
    if (bytes.byteLength > readMaximum || !sameSnapshot(before, after) || BigInt(bytes.byteLength) !== after.size) {
      context.add("file.changed", displayPath, `'${displayPath}' changed while it was being read.`);
      return undefined;
    }
    if (typeof boundary.afterRead === "function") await boundary.afterRead(displayPath);
    if (!await verifyPathSnapshot(absolutePath, before, boundary)) {
      context.add(
        "file.changed",
        displayPath,
        `'${displayPath}' or one of its parent directories changed while it was being read.`,
      );
      return undefined;
    }
    return { bytes, snapshot: before, absolutePath };
  } catch {
    context.add("file.unreadable", displayPath, `Could not read '${displayPath}'.`);
    return undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}

function prefixDirectories(filePaths) {
  const directories = new Set();
  for (const filePath of filePaths) {
    const segments = filePath.split("/");
    for (let index = 1; index < segments.length; index += 1) directories.add(segments.slice(0, index).join("/"));
  }
  return directories;
}

function createTraversalState(limits) {
  return { entries: 0, files: 0, stopped: false, limitDiagnostic: undefined, diagnostics: [], limits };
}

function recordDiagnostic(state, code, path, message) {
  if (state.diagnostics.length < LIMITS.validationErrors) state.diagnostics.push({ code, path, message });
}

function stopTraversal(state, code, diagnosticPath, message) {
  state.stopped = true;
  state.limitDiagnostic = { code, path: diagnosticPath, message };
}

function sameTree(left, right) {
  if (left.size !== right.size) return false;
  for (const [entryPath, entry] of left) {
    const finalEntry = right.get(entryPath);
    if (!finalEntry || finalEntry.type !== entry.type || !sameIdentity(entry, finalEntry)) return false;
  }
  return true;
}

async function enumerateTree(root, relativeDirectory, expectedFiles, expectedDirectories, encountered, state, depth) {
  if (state.stopped) return;
  const absoluteDirectory = relativeDirectory === "" ? root : path.join(root, ...relativeDirectory.split("/"));
  let directory;
  try {
    directory = await opendir(absoluteDirectory);
  } catch {
    recordDiagnostic(
      state,
      "directory.unreadable",
      relativeDirectory || "$directory",
      `Could not enumerate '${relativeDirectory || "artifact root"}'.`,
    );
    return;
  }
  const entries = [];
  const remaining = state.limits.entries - state.entries;
  try {
    for await (const entry of directory) {
      entries.push(entry.name);
      if (entries.length > remaining) {
        stopTraversal(
          state,
          "limit.directory_entries",
          "$directory",
          `Prebuilt artifact tree may not contain more than ${state.limits.entries} filesystem entries.`,
        );
        break;
      }
    }
  } catch {
    if (!state.stopped) {
      recordDiagnostic(
        state,
        "directory.unreadable",
        relativeDirectory || "$directory",
        `Could not completely enumerate '${relativeDirectory || "artifact root"}'.`,
      );
    }
    return;
  }
  if (state.stopped) return;
  entries.sort(compareCanonicalStrings);
  state.entries += entries.length;

  for (const name of entries) {
    if (state.stopped) break;
    const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
    if (relativePath.length > state.limits.pathLength) {
      stopTraversal(
        state,
        "path.too_long",
        relativePath,
        `Prebuilt artifact paths may not exceed ${state.limits.pathLength} bytes.`,
      );
      break;
    }
    const absolutePath = path.join(absoluteDirectory, name);
    let stats;
    try {
      stats = await lstat(absolutePath, { bigint: true });
    } catch {
      recordDiagnostic(state, "file.changed", relativePath, `'${relativePath}' changed during directory enumeration.`);
      continue;
    }
    if (stats.isSymbolicLink()) {
      encountered.set(relativePath, snapshotTreeEntry("symlink", stats));
      recordDiagnostic(state, "file.symlink", relativePath, `Symbolic links are not allowed for '${relativePath}'.`);
      continue;
    }
    if (stats.isDirectory()) {
      encountered.set(relativePath, snapshotTreeEntry("directory", stats));
      const probe = normalizePrebuiltArtifactPath(`${relativePath}/x`);
      if (!probe.ok) recordDiagnostic(state, probe.code, relativePath, probe.message);
      if (depth >= state.limits.depth) {
        stopTraversal(
          state,
          "limit.directory_depth",
          relativePath,
          `Prebuilt artifact directories may not exceed ${state.limits.depth} levels.`,
        );
        break;
      }
      if (!expectedDirectories.has(relativePath)) {
        recordDiagnostic(
          state,
          "directory.unexpected",
          relativePath,
          `Directory '${relativePath}' is not required by any declared file.`,
        );
      }
      await enumerateTree(root, relativePath, expectedFiles, expectedDirectories, encountered, state, depth + 1);
      continue;
    }
    if (stats.isFile()) {
      state.files += 1;
      if (state.files > state.limits.files + 1) {
        stopTraversal(
          state,
          "limit.files",
          "$directory",
          `Prebuilt artifact tree may not contain more than ${state.limits.files} payload files plus its manifest.`,
        );
        break;
      }
      encountered.set(relativePath, snapshotTreeEntry("regular", stats));
      if (stats.nlink > 1n) {
        recordDiagnostic(
          state,
          "file.hard_link",
          relativePath,
          `Hard-linked files are not allowed for '${relativePath}'.`,
        );
      }
      if (relativePath !== PREBUILT_MANIFEST_FILE_NAME) {
        const normalized = normalizePrebuiltArtifactPath(relativePath);
        if (!normalized.ok) recordDiagnostic(state, normalized.code, relativePath, normalized.message);
      }
      if (!expectedFiles.has(relativePath)) {
        recordDiagnostic(
          state,
          "file.unexpected",
          relativePath,
          `File '${relativePath}' is not declared by the prebuilt manifest.`,
        );
      }
      continue;
    }
    encountered.set(relativePath, snapshotTreeEntry("unsupported", stats));
    recordDiagnostic(
      state,
      "file.not_regular",
      relativePath,
      `'${relativePath}' has an unsupported filesystem entry type.`,
    );
  }
}

export async function validatePrebuiltArtifactDirectory(rootDirectory, options = {}) {
  const context = new ValidationContext();
  const supportedResult = snapshotPrebuiltSupportedCapabilities(options);
  if (!supportedResult.ok) return supportedResult;
  const validationOptions = Object.freeze({ supportedCapabilities: supportedResult.value });
  let root;
  try {
    root = path.resolve(rootDirectory);
  } catch {
    context.add("directory.invalid", "$directory", "Artifact root must be a filesystem path.");
    return context.finish(undefined);
  }
  let rootStats;
  try {
    rootStats = await lstat(root, { bigint: true });
  } catch (error) {
    context.add(
      errorCode(error) === "ENOENT" ? "directory.missing" : "directory.unreadable",
      "$directory",
      "Could not inspect the prebuilt artifact directory.",
    );
    return context.finish(undefined);
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    context.add(
      "directory.invalid",
      "$directory",
      "Artifact root must be a real directory, not a file or symbolic link.",
    );
    return context.finish(undefined);
  }
  let rootRealPath;
  try {
    rootRealPath = await realpath(root);
    const realStats = await lstat(rootRealPath, { bigint: true });
    if (!realStats.isDirectory() || !sameIdentity(rootStats, realStats)) throw new Error("Root changed.");
  } catch {
    context.add("directory.changed", "$directory", "Artifact root changed while it was being inspected.");
    return context.finish(undefined);
  }
  const boundary = {
    rootPath: root,
    rootRealPath,
    rootStats,
    firstWalk: undefined,
    beforeOpen: options[FILE_OPEN_RACE_HOOK],
    afterRead: options[FILE_READ_RACE_HOOK],
  };

  const manifestPath = path.join(root, PREBUILT_MANIFEST_FILE_NAME);
  if (typeof boundary.beforeOpen === "function") await boundary.beforeOpen(PREBUILT_MANIFEST_FILE_NAME, manifestPath);
  const manifestRead = await readStableFile(
    manifestPath,
    PREBUILT_MANIFEST_FILE_NAME,
    PREBUILT_LIMITS.manifestBytes,
    undefined,
    undefined,
    undefined,
    boundary,
    context,
  );
  if (!manifestRead) return context.finish(undefined);
  const manifestResult = validatePrebuiltManifest(manifestRead.bytes, validationOptions);
  if (!manifestResult.ok) return manifestResult;
  const manifest = manifestResult.value;

  const expectedFiles = new Set([PREBUILT_MANIFEST_FILE_NAME, ...manifest.files.map((file) => file.path)]);
  const expectedDirectories = prefixDirectories(manifest.files.map((file) => file.path));
  const internalLimit = (value, authoritative) =>
    Number.isSafeInteger(value) && value > 0 ? Math.min(value, authoritative) : authoritative;
  const override = options[DIRECTORY_LIMITS_OVERRIDE];
  const limits = {
    entries: internalLimit(override?.entries, PREBUILT_LIMITS.directoryEntries),
    files: internalLimit(override?.files, PREBUILT_LIMITS.files),
    depth: internalLimit(override?.depth, PREBUILT_LIMITS.directoryDepth),
    pathLength: internalLimit(override?.pathLength, PREBUILT_LIMITS.artifactPathBytes),
  };
  const encountered = new Map();
  const firstWalk = createTraversalState(limits);
  await enumerateTree(root, "", expectedFiles, expectedDirectories, encountered, firstWalk, 0);
  if (firstWalk.stopped) {
    context.add(firstWalk.limitDiagnostic.code, firstWalk.limitDiagnostic.path, firstWalk.limitDiagnostic.message);
    return context.finish(undefined);
  }
  for (const diagnostic of firstWalk.diagnostics) context.add(diagnostic.code, diagnostic.path, diagnostic.message);
  for (const expectedPath of expectedFiles) {
    if (!encountered.has(expectedPath)) {
      context.add("file.missing", expectedPath, `Required file '${expectedPath}' is missing.`);
    } else if (encountered.get(expectedPath).type !== "regular") {
      context.add("file.not_regular", expectedPath, `'${expectedPath}' must be a regular file.`);
    }
  }
  if (context.errors.length > 0) return context.finish(undefined);
  boundary.firstWalk = encountered;

  const snapshots = new Map([[PREBUILT_MANIFEST_FILE_NAME, manifestRead]]);
  const fileEntries = [];
  const budget = { remainingBytes: PREBUILT_LIMITS.artifactBytes, stopped: false };
  for (let index = 0; index < manifest.files.length; index += 1) {
    if (budget.stopped) break;
    const descriptor = manifest.files[index];
    const absolutePath = path.join(root, ...descriptor.path.split("/"));
    if (!isWithinRoot(root, absolutePath)) {
      context.add("path.unsafe", descriptor.path, "Resolved prebuilt path escapes the artifact directory.");
      continue;
    }
    if (typeof boundary.beforeOpen === "function") await boundary.beforeOpen(descriptor.path, absolutePath);
    const read = await readStableFile(
      absolutePath,
      descriptor.path,
      PREBUILT_LIMITS.fileBytes,
      descriptor.bytes,
      `$.files[${index}].bytes`,
      budget,
      boundary,
      context,
    );
    if (read) {
      snapshots.set(descriptor.path, read);
      fileEntries.push({ path: descriptor.path, content: read.bytes });
    }
  }
  if (context.errors.length > 0) return context.finish(undefined);

  const finalEncountered = new Map();
  const finalWalk = createTraversalState(limits);
  await enumerateTree(root, "", expectedFiles, expectedDirectories, finalEncountered, finalWalk, 0);
  if (finalWalk.stopped) {
    context.add(finalWalk.limitDiagnostic.code, finalWalk.limitDiagnostic.path, finalWalk.limitDiagnostic.message);
    return context.finish(undefined);
  }
  if (!sameTree(encountered, finalEncountered)) {
    context.add(
      "directory.changed",
      "$directory",
      "Prebuilt artifact paths or entry types changed while the artifact was being inspected.",
    );
    return context.finish(undefined);
  }
  for (const diagnostic of finalWalk.diagnostics) context.add(diagnostic.code, diagnostic.path, diagnostic.message);
  for (const [displayPath, snapshot] of snapshots) {
    if (!await verifyPathSnapshot(snapshot.absolutePath, snapshot.snapshot, boundary)) {
      context.add(
        "file.changed",
        displayPath,
        `'${displayPath}' or one of its parent directories changed after it was read.`,
      );
    }
  }
  if (context.errors.length > 0) return context.finish(undefined);
  return validatePrebuiltArtifactFromTrustedSnapshots(manifest, fileEntries);
}
