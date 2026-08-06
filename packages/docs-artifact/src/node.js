import { constants as fsConstants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { LIMITS, MANIFEST_FILE_NAME } from "./constants.js";
import { validateArtifact } from "./artifact-validator.js";
import { compareCanonicalStrings, ValidationContext } from "./errors.js";
import { snapshotSupportedCapabilities, validateManifest } from "./manifest-validator.js";
import { DIRECTORY_LIMITS_OVERRIDE, FILE_OPEN_RACE_HOOK, FILE_READ_RACE_HOOK } from "./node-internal.js";

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const NON_BLOCKING = fsConstants.O_NONBLOCK ?? 0;
const READ_CHUNK_BYTES = 64 * 1024;

function collectDeclaredPaths(manifest) {
  const paths = [];
  for (let resourceIndex = 0; resourceIndex < manifest.resources.length; resourceIndex += 1) {
    const resource = manifest.resources[resourceIndex];
    for (let variantIndex = 0; variantIndex < resource.variants.length; variantIndex += 1) {
      const variant = resource.variants[variantIndex];
      for (let fragmentIndex = 0; fragmentIndex < variant.fragments.length; fragmentIndex += 1) {
        const fragment = variant.fragments[fragmentIndex];
        paths.push({
          path: fragment.path,
          maximumBytes: LIMITS.fragmentBytes,
          declaredBytes: fragment.bytes,
          bytesPath: `$.resources[${resourceIndex}].variants[${variantIndex}].fragments[${fragmentIndex}].bytes`,
        });
      }
    }
  }
  for (let assetIndex = 0; assetIndex < manifest.assets.length; assetIndex += 1) {
    const asset = manifest.assets[assetIndex];
    paths.push({
      path: asset.path,
      maximumBytes: LIMITS.assetBytes,
      declaredBytes: asset.bytes,
      bytesPath: `$.assets[${assetIndex}].bytes`,
    });
  }
  return paths.sort((left, right) => compareCanonicalStrings(left.path, right.path));
}

function errorCode(error) {
  return error && typeof error === "object" && typeof error.code === "string" ? error.code : undefined;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function openNoFollow(filePath) {
  const readFlags = fsConstants.O_RDONLY | NON_BLOCKING;
  if (NO_FOLLOW === 0) {
    return { handle: await open(filePath, readFlags), verifyPathIdentity: true };
  }
  try {
    return {
      handle: await open(filePath, readFlags | NO_FOLLOW),
      verifyPathIdentity: false,
    };
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(errorCode(error))) throw error;
    return { handle: await open(filePath, readFlags), verifyPathIdentity: true };
  }
}

async function readFromHandle(handle, maximumBytes) {
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
  return Buffer.concat(chunks, totalBytes);
}

function isWithinRoot(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function verifyFilePathAfterRead(filePath, before, boundary) {
  try {
    const relative = path.relative(boundary.rootPath, filePath);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    const rootAfter = await lstat(boundary.rootPath, { bigint: true });
    if (rootAfter.isSymbolicLink() || !rootAfter.isDirectory() || !sameFileIdentity(boundary.rootStats, rootAfter)) return false;

    let current = boundary.rootPath;
    const segments = relative.split(path.sep);
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]);
      const currentStats = await lstat(current, { bigint: true });
      if (currentStats.isSymbolicLink()) return false;
      if (index < segments.length - 1) {
        if (!currentStats.isDirectory()) return false;
      } else if (!currentStats.isFile() || !sameFileIdentity(before, currentStats)) {
        return false;
      }
    }

    const resolvedPath = await realpath(filePath);
    if (!isWithinRoot(boundary.rootRealPath, resolvedPath)) return false;
    const resolvedStats = await lstat(resolvedPath, { bigint: true });
    return !resolvedStats.isSymbolicLink() && resolvedStats.isFile() && sameFileIdentity(before, resolvedStats);
  } catch {
    return false;
  }
}

async function inspectRegularFile(
  filePath,
  displayPath,
  maximumBytes,
  context,
  expectedBytes,
  expectedBytesPath,
  readBudget,
  boundary,
) {
  let opened;
  try {
    opened = await openNoFollow(filePath);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      context.add("file.missing", displayPath, `Required file '${displayPath}' is missing.`);
    } else if (code === "ELOOP") {
      context.add("file.symlink", displayPath, `Symbolic links are not allowed for '${displayPath}'.`);
    } else {
      context.add("file.unreadable", displayPath, `Could not open '${displayPath}'.`);
    }
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
        pathStats = await lstat(filePath, { bigint: true });
      } catch {
        context.add("file.changed", displayPath, `'${displayPath}' changed while it was being opened.`);
        return undefined;
      }
      if (pathStats.isSymbolicLink()) {
        context.add("file.symlink", displayPath, `Symbolic links are not allowed for '${displayPath}'.`);
        return undefined;
      }
      if (!sameFileIdentity(before, pathStats)) {
        context.add("file.changed", displayPath, `'${displayPath}' changed while it was being opened.`);
        return undefined;
      }
    }
    if (before.size > BigInt(maximumBytes)) {
      context.add("file.too_large", displayPath, `'${displayPath}' exceeds the ${maximumBytes}-byte read bound.`);
      return undefined;
    }
    if (expectedBytes !== undefined && before.size !== BigInt(expectedBytes)) {
      context.add("file.size_drift", expectedBytesPath ?? displayPath, `File '${displayPath}' has ${before.size} bytes; manifest declares ${expectedBytes}.`);
      return undefined;
    }
    if (readBudget && before.size > BigInt(readBudget.remainingBytes)) {
      context.add("limit.artifact_bytes", "$files", `Artifact bytes may not exceed ${LIMITS.artifactBytes}.`);
      readBudget.stopped = true;
      return undefined;
    }
    if (readBudget) readBudget.remainingBytes -= Number(before.size);

    const readMaximum = expectedBytes ?? maximumBytes;
    const bytes = await readFromHandle(handle, readMaximum);
    const after = await handle.stat({ bigint: true });
    if (bytes.byteLength > readMaximum) {
      context.add("file.changed", displayPath, `'${displayPath}' grew while it was being read.`);
      return undefined;
    }
    if (!sameFileSnapshot(before, after) || BigInt(bytes.byteLength) !== after.size) {
      context.add("file.changed", displayPath, `'${displayPath}' changed while it was being read.`);
      return undefined;
    }
    if (typeof boundary.afterRead === "function") await boundary.afterRead(displayPath);
    if (!await verifyFilePathAfterRead(filePath, before, boundary)) {
      context.add("file.changed", displayPath, `'${displayPath}' or one of its parent directories changed while it was being read.`);
      return undefined;
    }
    return bytes;
  } catch {
    context.add("file.unreadable", displayPath, `Could not read '${displayPath}'.`);
    return undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function requireRegularManifest(filePath, context) {
  let stats;
  try {
    stats = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(errorCode(error))) {
      context.add("file.missing", MANIFEST_FILE_NAME, `Required file '${MANIFEST_FILE_NAME}' is missing.`);
    } else {
      context.add("file.unreadable", MANIFEST_FILE_NAME, `Could not inspect '${MANIFEST_FILE_NAME}'.`);
    }
    return false;
  }
  if (stats.isSymbolicLink()) {
    context.add("file.symlink", MANIFEST_FILE_NAME, `Symbolic links are not allowed for '${MANIFEST_FILE_NAME}'.`);
    return false;
  }
  if (!stats.isFile()) {
    context.add("file.not_regular", MANIFEST_FILE_NAME, `'${MANIFEST_FILE_NAME}' must be a regular file.`);
    return false;
  }
  return true;
}

function recordDirectoryDiagnostic(state, code, path, message) {
  if (state.diagnostics.length <= LIMITS.validationErrors) {
    state.diagnostics.push({ code, path, message });
  }
}

function stopDirectoryTraversal(state, code, path, message) {
  state.stopped = true;
  state.limitDiagnostic = { code, path, message };
}

function createDirectoryTraversalState(limits) {
  return {
    entryCount: 0,
    fileCount: 0,
    stopped: false,
    diagnostics: [],
    limitDiagnostic: undefined,
    limits,
  };
}

function sameManagedEntryTypes(left, right) {
  if (left.size !== right.size) return false;
  for (const [entryPath, entryType] of left) {
    if (right.get(entryPath) !== entryType) return false;
  }
  return true;
}

async function enumerateManagedDirectory(absoluteDirectory, relativeDirectory, expectedPaths, encountered, state, depth) {
  if (state.stopped) return;
  let directoryStats;
  try {
    directoryStats = await lstat(absoluteDirectory);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      recordDirectoryDiagnostic(state, "directory.unreadable", relativeDirectory, `Could not inspect managed directory '${relativeDirectory}'.`);
    }
    return;
  }
  if (directoryStats.isSymbolicLink()) {
    encountered.set(relativeDirectory, "symlink");
    recordDirectoryDiagnostic(state, "file.symlink", relativeDirectory, `Symbolic links are not allowed for '${relativeDirectory}'.`);
    return;
  }
  if (!directoryStats.isDirectory()) {
    encountered.set(relativeDirectory, "unsupported");
    recordDirectoryDiagnostic(state, "file.not_regular", relativeDirectory, `'${relativeDirectory}' must be a real directory.`);
    return;
  }
  encountered.set(relativeDirectory, "directory");

  let directory;
  try {
    directory = await opendir(absoluteDirectory);
  } catch {
    recordDirectoryDiagnostic(state, "directory.unreadable", relativeDirectory, `Could not enumerate managed directory '${relativeDirectory}'.`);
    return;
  }
  const entries = [];
  const remainingEntries = state.limits.entries - state.entryCount;
  try {
    for await (const entry of directory) {
      entries.push(entry);
      if (entries.length > remainingEntries) {
        stopDirectoryTraversal(
          state,
          "limit.directory_entries",
          "$directory",
          `Managed subtree may not contain more than ${state.limits.entries} filesystem entries.`,
        );
        break;
      }
    }
  } catch {
    if (!state.stopped) {
      recordDirectoryDiagnostic(state, "directory.unreadable", relativeDirectory, `Could not completely enumerate managed directory '${relativeDirectory}'.`);
    }
    return;
  }
  if (state.stopped) return;
  entries.sort((left, right) => compareCanonicalStrings(left.name, right.name));
  state.entryCount += entries.length;

  for (const entry of entries) {
    if (state.stopped) break;
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (relativePath.length > state.limits.pathLength) {
      stopDirectoryTraversal(
        state,
        "path.too_long",
        relativePath,
        `Managed subtree paths may not exceed ${state.limits.pathLength} characters.`,
      );
      break;
    }
    const absolutePath = path.join(absoluteDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      encountered.set(relativePath, "symlink");
      recordDirectoryDiagnostic(state, "file.symlink", relativePath, `Symbolic links are not allowed for '${relativePath}'.`);
    } else if (entry.isDirectory()) {
      if (depth >= state.limits.depth) {
        stopDirectoryTraversal(
          state,
          "limit.directory_depth",
          relativePath,
          `Managed subtree depth may not exceed ${state.limits.depth} levels.`,
        );
        break;
      }
      if (expectedPaths.has(relativePath)) {
        encountered.set(relativePath, "unsupported");
        recordDirectoryDiagnostic(state, "file.not_regular", relativePath, `'${relativePath}' is declared as a file but is a directory.`);
      }
      await enumerateManagedDirectory(absolutePath, relativePath, expectedPaths, encountered, state, depth + 1);
      if (state.stopped) break;
    } else if (entry.isFile()) {
      state.fileCount += 1;
      if (state.fileCount > state.limits.files) {
        stopDirectoryTraversal(
          state,
          "limit.files",
          "$directory",
          `Managed subtree may not contain more than ${state.limits.files} files.`,
        );
        break;
      }
      encountered.set(relativePath, "regular");
      if (!expectedPaths.has(relativePath)) {
        recordDirectoryDiagnostic(state, "file.unexpected", relativePath, `File '${relativePath}' is not declared by the semantic manifest.`);
      }
    } else {
      encountered.set(relativePath, "unsupported");
      recordDirectoryDiagnostic(state, "file.not_regular", relativePath, `'${relativePath}' has an unsupported filesystem entry type.`);
    }
  }
}

export async function validateArtifactDirectory(rootDirectory, options = {}) {
  const context = new ValidationContext();
  const supportedCapabilitiesResult = snapshotSupportedCapabilities(options);
  if (!supportedCapabilitiesResult.ok) return supportedCapabilitiesResult;
  const stableValidationOptions = Object.freeze({ supportedCapabilities: supportedCapabilitiesResult.value });
  const root = path.resolve(rootDirectory);
  let rootStats;
  try {
    rootStats = await lstat(root, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      context.add("directory.missing", "$directory", `Artifact directory '${root}' does not exist.`);
    } else {
      context.add("directory.unreadable", "$directory", `Could not inspect artifact directory '${root}'.`);
    }
    return context.finish(undefined);
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    context.add("directory.invalid", "$directory", "Artifact root must be a real directory, not a file or symbolic link.");
    return context.finish(undefined);
  }
  let rootRealPath;
  try {
    rootRealPath = await realpath(root);
    const realRootStats = await lstat(rootRealPath, { bigint: true });
    if (!realRootStats.isDirectory() || !sameFileIdentity(rootStats, realRootStats)) throw new Error("Artifact root changed.");
  } catch {
    context.add("directory.changed", "$directory", "Artifact root changed while it was being inspected.");
    return context.finish(undefined);
  }
  const pathBoundary = {
    rootPath: root,
    rootRealPath,
    rootStats,
    beforeOpen: options[FILE_OPEN_RACE_HOOK],
    afterRead: options[FILE_READ_RACE_HOOK],
  };

  const manifestPath = path.join(root, MANIFEST_FILE_NAME);
  if (!await requireRegularManifest(manifestPath, context)) return context.finish(undefined);
  const manifestBytes = await inspectRegularFile(
    manifestPath,
    MANIFEST_FILE_NAME,
    LIMITS.manifestBytes,
    context,
    undefined,
    undefined,
    undefined,
    pathBoundary,
  );
  if (!manifestBytes) return context.finish(undefined);
  const manifestResult = validateManifest(manifestBytes, stableValidationOptions);
  if (!manifestResult.ok) return manifestResult;

  const declaredFiles = collectDeclaredPaths(manifestResult.value);
  const expectedPaths = new Map(declaredFiles.map((entry) => [entry.path, entry]));
  const encountered = new Map();
  const limitOverride = options[DIRECTORY_LIMITS_OVERRIDE];
  const internalLimit = (value, authoritative) => (
    Number.isSafeInteger(value) && value > 0 ? Math.min(value, authoritative) : authoritative
  );
  const directoryLimits = {
    entries: internalLimit(limitOverride?.entries, LIMITS.directoryEntries),
    files: internalLimit(limitOverride?.files, LIMITS.files),
    depth: internalLimit(limitOverride?.depth, LIMITS.directoryDepth),
    pathLength: internalLimit(limitOverride?.pathLength, LIMITS.artifactPath),
  };
  const traversalState = createDirectoryTraversalState(directoryLimits);
  await enumerateManagedDirectory(
    path.join(root, "taproot-docs"),
    "taproot-docs",
    expectedPaths,
    encountered,
    traversalState,
    1,
  );
  if (traversalState.stopped) {
    const diagnostic = traversalState.limitDiagnostic;
    context.add(diagnostic.code, diagnostic.path, diagnostic.message);
    return context.finish(undefined);
  }
  for (const diagnostic of traversalState.diagnostics) {
    context.add(diagnostic.code, diagnostic.path, diagnostic.message);
  }

  const entries = [];
  const readBudget = { remainingBytes: LIMITS.artifactBytes, stopped: false };
  for (const declaredFile of declaredFiles) {
    if (readBudget.stopped) break;
    const entryType = encountered.get(declaredFile.path);
    if (entryType === undefined) {
      context.add("file.missing", declaredFile.path, `Required file '${declaredFile.path}' is missing.`);
      continue;
    }
    if (entryType !== "regular") continue;
    const absolutePath = path.resolve(root, ...declaredFile.path.split("/"));
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
      context.add("path.unsafe", declaredFile.path, "Resolved artifact path escapes the artifact directory.");
      continue;
    }
    if (typeof pathBoundary.beforeOpen === "function") {
      await pathBoundary.beforeOpen(declaredFile.path, absolutePath);
    }
    const bytes = await inspectRegularFile(
      absolutePath,
      declaredFile.path,
      declaredFile.maximumBytes,
      context,
      declaredFile.declaredBytes,
      declaredFile.bytesPath,
      readBudget,
      pathBoundary,
    );
    if (bytes) entries.push({ path: declaredFile.path, content: bytes });
  }
  if (context.errors.length > 0) return context.finish(undefined);

  const finalEncountered = new Map();
  const finalTraversalState = createDirectoryTraversalState(directoryLimits);
  await enumerateManagedDirectory(
    path.join(root, "taproot-docs"),
    "taproot-docs",
    expectedPaths,
    finalEncountered,
    finalTraversalState,
    1,
  );
  if (finalTraversalState.stopped) {
    const diagnostic = finalTraversalState.limitDiagnostic;
    context.add(diagnostic.code, diagnostic.path, diagnostic.message);
    return context.finish(undefined);
  }
  if (!sameManagedEntryTypes(encountered, finalEncountered)) {
    context.add("directory.changed", "$directory", "Managed subtree paths or entry types changed while the artifact was being inspected.");
    return context.finish(undefined);
  }
  for (const diagnostic of finalTraversalState.diagnostics) {
    context.add(diagnostic.code, diagnostic.path, diagnostic.message);
  }
  if (context.errors.length > 0) return context.finish(undefined);
  return validateArtifact(manifestResult.value, entries, stableValidationOptions);
}
