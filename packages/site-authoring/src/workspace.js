import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";

import { atomicWriteFile } from "./atomic-file.js";
import { hasAsciiControl, SiteAuthoringError } from "./errors.js";

/**
 * The local workspace: what `pull` writes, what the push verbs read back, and
 * the two manifests that carry identity between them.
 *
 * A workspace is a checked-out tree, so a symlink planted inside it is the
 * cheapest way to turn `pull` into an arbitrary-file writer or `pages push`
 * into an arbitrary-file reader. Containment therefore takes three separate
 * measures, and each covers a hole the others leave open:
 *
 * 1. `resolveWorkspacePath` rejects anything that is not a bounded relative
 *    POSIX path under the root. This is **lexical only** — it proves the string
 *    names somewhere inside, and nothing about what the filesystem does with it.
 * 2. `requireRealDirectoryChain` `lstat`s *every* directory segment on the way
 *    to a target and refuses a symlink or a non-directory. This is the measure
 *    that matters: `O_NOFOLLOW` covers only a path's final component, and
 *    `readdir` follows a linked directory without complaint, so a single
 *    `pages -> ../outside` link is enough to read out-of-tree files if the
 *    intermediate segments are never inspected.
 * 3. Opens add `O_NOFOLLOW` so the final component cannot be a link either, and
 *    directory walks skip symlink entries rather than descending them.
 *
 * What this deliberately does not claim: the checks are not atomic with the
 * opens that follow them. Defeating them requires swapping a directory for a
 * link inside the window, which is a different threat from the one a workspace
 * actually faces — a link that arrives with the checkout and sits there.
 * Closing it would need `openat`-relative traversal, which Node does not
 * expose.
 */

export const MANIFEST_FILE_NAME = ".taproot-site-manifest.json";
export const MEDIA_MANIFEST_FILE_NAME = ".taproot-site-media.json";
export const NAVIGATION_FILE_NAME = "nav.json";
export const PAGES_DIRECTORY = "pages";
/**
 * The page sources `pages push` walks. Shared so the set `pull` checks for
 * before writing into a workspace is exactly the set a later push would find:
 * a file one of them counts and the other ignores is a page that gets pushed
 * from a workspace nothing proved the ownership of.
 */
export const PAGE_SOURCE_EXTENSIONS = Object.freeze([".md", ".pm.json"]);
export const SETTINGS_DIRECTORY = "settings";
export const MEDIA_DIRECTORY = "media";

/**
 * The two authoritative source formats one page path may have, and the mapping
 * from a workspace file to the one it is.
 *
 * The extension *is* the format. Nothing else can be, because the file a push
 * reads is chosen by name: a manifest that recorded some other format would be
 * describing a file that does not exist. `sourceFormat` in the manifest is
 * therefore a recorded copy of this derivation, kept so the registry is
 * self-describing and so a hand edit that disagrees with it is visible rather
 * than silently overridden.
 */
export const PAGE_SOURCE_FORMAT_MARKDOWN = "markdown";
export const PAGE_SOURCE_FORMAT_PROSEMIRROR = "prosemirror";
const PAGE_SOURCE_FORMATS_BY_EXTENSION = Object.freeze([
  Object.freeze([".pm.json", PAGE_SOURCE_FORMAT_PROSEMIRROR]),
  Object.freeze([".md", PAGE_SOURCE_FORMAT_MARKDOWN]),
]);

/** The authoritative source format one workspace file carries, by its extension. */
export function pageSourceFormat(file) {
  if (typeof file !== "string") return undefined;
  const lowered = file.toLowerCase();
  for (const [extension, format] of PAGE_SOURCE_FORMATS_BY_EXTENSION) {
    if (lowered.endsWith(extension)) return format;
  }
  return undefined;
}

/**
 * Internal workspace state: the remote body `pull` last read for a page whose
 * workspace source does not already hold it.
 *
 * It lives outside `pages/` and under a dot-prefixed directory for one reason:
 * it must never be discoverable as an authored page. `walkWorkspaceFiles`
 * skips dot-entries and every page walk is rooted at `pages/`, so neither a
 * push nor the offline fixture validator can bind one of these files as a
 * source — which is exactly the ambiguity a `pages/<path>.pm.json` beside a
 * tracked `pages/<path>.md` created. Writes still go through the same
 * containment-checked writer as everything else.
 */
export const INTERNAL_STATE_DIRECTORY = ".taproot-site-state";
export const INTERNAL_PAGE_BASELINE_DIRECTORY = `${INTERNAL_STATE_DIRECTORY}/pages`;

/**
 * Where one page's internal baseline body lives, or `undefined` when the page
 * id cannot be carried as a file name. Page ids are server data reaching a
 * filesystem, so they pass the same grammar as every other workspace name.
 */
export function internalPageBaselineFile(pageId) {
  return typeof pageId === "string" && SAFE_SEGMENT.test(pageId)
    ? `${INTERNAL_PAGE_BASELINE_DIRECTORY}/${pageId}.pm.json`
    : undefined;
}

// Version 5 makes the page list a source registry: each entry names the one
// authoritative `file` for its path, the `sourceFormat` that file carries, and
// the `baseline` hashes pull compares against to detect a remote edit it
// cannot reconcile. Version 4 classified pulled page files as editable,
// metadata-only, or an integrity-checked read-only projection but recorded no
// registry, so a push against one cannot tell an intentional format change
// from a stale entry. The package is in-repo and unreleased, so an older
// manifest is re-pulled rather than migrated.
export const MANIFEST_VERSION = 5;
export const PAGE_WORKSPACE_MODE_EDITABLE = "editable";
export const PAGE_WORKSPACE_MODE_METADATA_ONLY = "metadata-only";
export const PAGE_WORKSPACE_MODE_READ_ONLY = "read-only";
export const PAGE_READ_ONLY_REASON_SYSTEM_404 = "system-404";
export const SYSTEM_PAGE_NOT_FOUND_PATH = "404";
export const SYSTEM_PAGE_NOT_FOUND_FILE = `${PAGES_DIRECTORY}/404.pm.json`;
export const WORKSPACE_CONTENT_HASH = /^sha256:[0-9a-f]{64}$/u;
// Bumped when the media manifest gained its `siteId` binding: a manifest
// without one cannot be proved to belong to the site being written to, and the
// package is in-repo and unreleased, so an old file is re-pulled rather than
// migrated.
export const MEDIA_MANIFEST_VERSION = 2;

export const WORKSPACE_LIMITS = Object.freeze({
  // One authored page: a Markdown source or a ProseMirror document.
  documentBytes: 2 * 1024 * 1024,
  navigationBytes: 1024 * 1024,
  settingsBytes: 256 * 1024,
  manifestBytes: 8 * 1024 * 1024,
  mediaBytes: 32 * 1024 * 1024,
  // Pull holds the bodies of the pages this workspace already tracks until it
  // knows whether any of them conflict, because a refusal has to leave `pages/`
  // untouched. Generous for any real authoring workspace, and an explicit
  // refusal rather than an unbounded buffer for one that is not.
  pulledBodyBytes: 64 * 1024 * 1024,
  files: 5_000,
  directoryDepth: 12,
  relativePathBytes: 1_024,
  pagePathBytes: 512,
});

/** Hashes the exact bounded bytes pull wrote for a read-only projection. */
export function workspaceContentHash(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

// Deep enough for any document the vocabulary accepts, shallow enough that a
// hostile one cannot exhaust the stack inside the hash.
const CANONICAL_MAXIMUM_DEPTH = 100;

function canonicalJson(value, depth) {
  if (depth > CANONICAL_MAXIMUM_DEPTH) {
    throw new SiteAuthoringError(
      "workspace.document_too_deep",
      `A page document nests deeper than ${CANONICAL_MAXIMUM_DEPTH} levels and cannot be compared.`,
    );
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${
      Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`)
        .join(",")
    }}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Hashes a page body by its *content*, not by the bytes it happened to arrive
 * in.
 *
 * `FreeFormData.body` is a `google.protobuf.Struct`, so object member order is
 * not part of the contract and two reads of an unchanged page may serialize
 * their maps differently. Hashing raw bytes would turn that into a reported
 * conflict on a page nobody touched, so the hash is taken over a deterministic
 * sorted-key rendering instead. `JSON.parse` has already collapsed numeric
 * spellings (`2.0` and `2` alike) by the time this runs.
 */
export function canonicalDocumentHash(document_) {
  return `sha256:${createHash("sha256").update(canonicalJson(document_, 0), "utf8").digest("hex")}`;
}

function normalizeBaselineHash(value) {
  return typeof value === "string" && WORKSPACE_CONTENT_HASH.test(value) ? value : undefined;
}

/**
 * Whether a manifest entry names a file `walkWorkspaceFiles` could have
 * produced: under `pages/`, bounded, and every segment in the workspace
 * grammar.
 *
 * The registry is the one place a manifest string is used to *reach* a file
 * rather than to match one the walk already found, so it re-derives the same
 * grammar rather than trusting the value. A hand-edited `../outside.md` is
 * dropped here instead of becoming a path refusal inside the verb that exists
 * to repair the manifest.
 */
function isDiscoverablePageSource(file) {
  if (typeof file !== "string" || !file.startsWith(`${PAGES_DIRECTORY}/`)) return false;
  const segments = file.split("/");
  return segments.length > 1
    && segments.length <= WORKSPACE_LIMITS.directoryDepth
    && segments.slice(1).every((segment) => SAFE_SEGMENT.test(segment));
}

/**
 * Reads the manifest's page list as a source registry keyed by page id: which
 * workspace file is a page's one authoritative source, what format that file
 * carries, and the hashes `pull` compares against.
 *
 * Nothing here throws. `pull` is the verb that repairs a workspace, so a
 * registry read that refused would leave a damaged manifest with no way out
 * except deleting it — which `pull` then refuses in turn, because page sources
 * without a manifest cannot be proved to belong to this site. The two kinds of
 * damage are therefore handled differently and deliberately:
 *
 * - An entry whose `file` is missing, unrecognized, or not a file the workspace
 *   walk could have produced is **dropped**. It names no source this package
 *   would ever read, so there is nothing to protect.
 * - A `baseline` that is not a usable pair of hashes is **discarded and
 *   reported**. Losing it costs one pull's worth of conflict detection and
 *   nothing else: the next pull re-establishes it from what it reads, and the
 *   authored source is never written over in the meantime.
 * - A `sourceFormat` that disagrees with the file's own extension is recorded
 *   as `formatMismatch` and the extension wins. `pages push` refuses on it —
 *   it is a hand-edited manifest and re-pulling is the fix — while `pull`
 *   proceeds and rewrites the entry correctly.
 * - Two entries naming the same `file`, or two entries naming the same
 *   `pageId`, are both recorded as `duplicateSource` / `duplicateIdentity`.
 * - Two entries naming the same `file` are both recorded as
 *   `duplicateSource`. One file cannot be two pages' source, and choosing
 *   between them would let one page's content be sent to the other, so
 *   neither is trusted: `pull` ignores both and assigns each page a fresh
 *   file, which rewrites the manifest without the ambiguity, and `pages push`
 *   refuses until that has happened.
 */
export function pageSourceRegistry(manifest) {
  const registry = new Map();
  const byFile = new Map();
  const byId = new Map();
  const pages = manifest === null || typeof manifest !== "object" ? undefined : manifest.pages;
  if (!Array.isArray(pages)) return registry;
  for (const entry of pages) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (typeof entry.pageId !== "string" || entry.pageId === "") continue;
    const sourceFormat = pageSourceFormat(entry.file);
    if (sourceFormat === undefined || !isDiscoverablePageSource(entry.file)) continue;
    const declared = entry.baseline;
    const remoteHash = normalizeBaselineHash(declared?.remoteHash);
    const sourceHash = normalizeBaselineHash(declared?.sourceHash);
    const baseline = remoteHash === undefined && sourceHash === undefined
      ? undefined
      : { ...(remoteHash === undefined ? {} : { remoteHash }), ...(sourceHash === undefined ? {} : { sourceHash }) };
    const record = {
      pageId: entry.pageId,
      file: entry.file,
      sourceFormat,
      baseline,
      baselineDiscarded: declared !== undefined && baseline === undefined,
      formatMismatch: entry.sourceFormat !== undefined && entry.sourceFormat !== sourceFormat,
      duplicateSource: false,
      duplicateIdentity: false,
    };
    const previous = byFile.get(entry.file);
    if (previous === undefined) {
      byFile.set(entry.file, record);
    } else {
      previous.duplicateSource = true;
      record.duplicateSource = true;
    }
    // Accumulated in place: a manifest is bounded by bytes, not by entries, so
    // one at the 8 MB ceiling can carry enough repeated page ids that copying
    // the group on every append would take quadratic time before the integrity
    // check below ever gets to reject it.
    const group = byId.get(entry.pageId);
    if (group === undefined) byId.set(entry.pageId, [record]);
    else group.push(record);
    registry.set(entry.pageId, record);
  }
  // The mirror image of two entries naming one file: two files claiming one
  // page. The registry is keyed by page id, so without this the second entry
  // simply replaces the first and the manifest reads as consistent — while
  // `pages push` keys its own lookup by file, plans both, and writes that one
  // live page twice from two different sources. Every implicated file is
  // recorded on the surviving record, because "remove the extra one" is not
  // guidance anybody can follow without knowing which files are meant.
  for (const records of byId.values()) {
    if (records.length < 2) continue;
    const sourceFiles = records.map((candidate) => candidate.file);
    for (const candidate of records) {
      candidate.duplicateIdentity = true;
      candidate.sourceFiles = sourceFiles;
    }
  }
  return registry;
}

/**
 * Refuses a manifest that no longer describes a workspace this package can act
 * on without guessing.
 *
 * Both conditions are hand-edit or corruption states rather than anything a
 * pull or a push produces, and both would otherwise be resolved silently in
 * favor of whichever entry happened to be read last:
 *
 * - A recorded `sourceFormat` the file's own extension contradicts. The
 *   extension already decided which reader runs, so the manifest is describing
 *   a file that is not there.
 * - Two entries naming one source file. `pages push` keys its manifest lookup
 *   by file, so trusting either entry would send that file's content to
 *   whichever page won the lookup — a page the author never edited.
 *
 * `pull` does not call this. It is the verb that repairs a workspace, and it
 * ignores both kinds of entry and rewrites them, so "run pull again" is a real
 * remedy rather than a loop.
 */
export function requireManifestSourceRegistry(registry) {
  for (const entry of registry.values()) {
    if (entry.formatMismatch) {
      throw new SiteAuthoringError(
        "workspace.manifest_invalid",
        `The manifest records a source format for '${entry.file}' that the file's own extension contradicts. `
          + "Run 'taproot-site pull' again.",
        { field: entry.file },
      );
    }
    if (entry.duplicateSource) {
      throw new SiteAuthoringError(
        "workspace.manifest_invalid",
        `The manifest records '${entry.file}' as the source of more than one page, so this file's content cannot be `
          + "sent without guessing which page it belongs to. Run 'taproot-site pull' again.",
        { field: entry.file },
      );
    }
    if (entry.duplicateIdentity) {
      throw new SiteAuthoringError(
        "workspace.manifest_invalid",
        `The manifest records ${entry.sourceFiles.length} sources for page ${entry.pageId} `
          + `(${entry.sourceFiles.join(", ")}), so that page would be written more than once from different files. `
          + "Run 'taproot-site pull' again.",
        { field: entry.file, alternatives: entry.sourceFiles },
      );
    }
  }
  return registry;
}

/**
 * Returns only the complete read-only projection shape that `pull` writes.
 *
 * A manifest is editable input, so a caller must not treat an arbitrary
 * `workspaceMode: read-only` as permission to omit a page from push or
 * approval. The live page identity is checked separately after listing the
 * site; this function proves only the deterministic on-disk half.
 */
export function readOnlySystem404Projections(manifest) {
  const projections = [];
  for (const [index, entry] of manifest.pages.entries()) {
    if (entry?.workspaceMode !== PAGE_WORKSPACE_MODE_READ_ONLY) continue;
    const pagePath = normalizePagePath(entry.path);
    if (
      pagePath?.toLowerCase() !== SYSTEM_PAGE_NOT_FOUND_PATH
      || entry.file !== SYSTEM_PAGE_NOT_FOUND_FILE
      || typeof entry.pageId !== "string"
      || entry.pageId.trim() === ""
      || entry.readOnlyReason !== PAGE_READ_ONLY_REASON_SYSTEM_404
      || typeof entry.workspaceContentHash !== "string"
      || !WORKSPACE_CONTENT_HASH.test(entry.workspaceContentHash)
    ) {
      throw new SiteAuthoringError(
        "workspace.manifest_invalid",
        `The read-only page projection at pages[${index}] is not the complete system-404 shape written by pull. `
          + "Run 'taproot-site pull' again.",
        { field: `pages[${index}].workspaceMode` },
      );
    }
    projections.push(entry);
  }
  if (projections.length > 1) {
    throw new SiteAuthoringError(
      "workspace.manifest_invalid",
      "The manifest records more than one read-only system 404 projection. Run 'taproot-site pull' again.",
      { field: "pages" },
    );
  }
  return projections;
}

const WINDOWS_DEVICE_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

/**
 * The one name shape this package carries, for a workspace file and for a page
 * path segment alike. It is deliberately identical to the server's
 * `Validations.PagePathSegmentPattern` (`\A[A-Za-z0-9][A-Za-z0-9._-]*\z`), so
 * `pages push` can refuse a path the server would refuse *before* it starts
 * mutating rather than halfway through.
 */
export const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
// Media names are workspace identities, not page-path segments. Retina asset
// names such as `logo@2x.png` are conventional and never cross the server's
// stricter page-path grammar.
export const SAFE_MEDIA_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/u;

function invalidRelativePath(relativePath) {
  return new SiteAuthoringError(
    "workspace.path_invalid",
    `'${relativePath}' is not a bounded relative path inside the workspace.`,
    { field: typeof relativePath === "string" ? relativePath : undefined },
  );
}

/**
 * Resolves one workspace-relative POSIX path to an absolute path that is
 * lexically inside the workspace.
 *
 * Lexical is all this is. It proves the *string* stays inside; it proves
 * nothing about the directories the string names, so every reader pairs it with
 * `requireRealDirectoryChain` before touching the filesystem.
 */
export function resolveWorkspacePath(workspaceDir, relativePath) {
  if (
    typeof relativePath !== "string"
    || relativePath.length === 0
    || Buffer.byteLength(relativePath, "utf8") > WORKSPACE_LIMITS.relativePathBytes
    || hasAsciiControl(relativePath)
    || relativePath.includes("\\")
    || path.posix.isAbsolute(relativePath)
    || path.isAbsolute(relativePath)
  ) {
    throw invalidRelativePath(relativePath);
  }
  const segments = relativePath.split("/");
  if (segments.length > WORKSPACE_LIMITS.directoryDepth) throw invalidRelativePath(relativePath);
  for (const segment of segments) {
    const base = segment.split(".")[0]?.replace(/[ .]+$/u, "") ?? "";
    if (segment === "" || segment === "." || segment === ".." || WINDOWS_DEVICE_BASENAME.test(base)) {
      throw invalidRelativePath(relativePath);
    }
  }
  const resolved = path.resolve(workspaceDir, ...segments);
  if (resolved !== workspaceDir && !resolved.startsWith(`${workspaceDir}${path.sep}`)) {
    throw invalidRelativePath(relativePath);
  }
  return resolved;
}

/**
 * Walks the directory segments leading to `relativePath` and refuses the whole
 * operation if any of them is a symlink or is not a directory.
 *
 * This is the read path's containment check, and it exists because the two
 * mechanisms that look like they cover it do not. `resolveWorkspacePath` is
 * lexical, so `pages/about.md` resolves inside the workspace whether or not
 * `pages` is a link pointing out of it. `O_NOFOLLOW` refuses a linked *final*
 * component only, so opening `pages/about.md` through a linked `pages` succeeds
 * — and `readdir` follows a linked directory without any complaint at all. One
 * checked-in `pages -> ../outside` was therefore enough to make `pages push`
 * publish out-of-tree documents and `media upload` upload out-of-tree files,
 * with no positional argument and no unusual invocation.
 *
 * Returns `false` when a segment simply does not exist yet, which is an
 * ordinary state a caller reports in its own vocabulary ("missing", "no
 * manifest", "nothing to walk") rather than a refusal.
 *
 * `includeLeaf` extends the check to the last segment, for callers whose target
 * must itself be a real directory — a walk root, for instance.
 */
async function requireRealDirectoryChain(workspaceDir, relativePath, { includeLeaf = false } = {}) {
  const segments = relativePath.split("/");
  const directories = includeLeaf ? segments : segments.slice(0, -1);
  let current = workspaceDir;
  let walked = "";
  for (const segment of directories) {
    current = path.join(current, segment);
    walked = walked === "" ? segment : `${walked}/${segment}`;
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") return false;
      throw new SiteAuthoringError(
        "workspace.unreadable",
        `Could not inspect workspace path '${relativePath}'.`,
        { field: relativePath },
      );
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new SiteAuthoringError(
        "workspace.not_directory",
        `'${relativePath}' is reached through '${walked}', which is a link or a file where the workspace `
          + "requires a real directory. Nothing outside the workspace is read.",
        { field: relativePath },
      );
    }
  }
  return true;
}

async function requireRealDirectory(directory) {
  let stats;
  try {
    stats = await lstat(directory);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw new SiteAuthoringError("workspace.unreadable", "Could not inspect a workspace directory.");
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new SiteAuthoringError(
      "workspace.not_directory",
      "A workspace directory is a link or a file where a real directory is required.",
    );
  }
  return true;
}

async function createAndVerifyDirectory(directory) {
  try {
    await mkdir(directory, { recursive: false });
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "EEXIST") {
      throw new SiteAuthoringError("workspace.unwritable", "Could not create a workspace directory.");
    }
  }
  if (!await requireRealDirectory(directory)) {
    throw new SiteAuthoringError("workspace.unwritable", "Could not create a workspace directory.");
  }
}

/**
 * Creates the workspace root, one segment at a time, from the configuration
 * directory `loadSiteConfig` canonicalized. A fresh clone legitimately has no
 * workspace yet, so this is a create — but each segment is created and then
 * re-inspected as a real directory, so a link that appears between the `mkdir`
 * and the next write is caught rather than followed out of the tree.
 */
export async function ensureWorkspaceRoot({ configDirectory, workspaceDir }) {
  const relative = path.relative(configDirectory, workspaceDir);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new SiteAuthoringError(
      "workspace.escape",
      "The configured workspace does not resolve beneath the configuration directory.",
    );
  }
  let current = configDirectory;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    await createAndVerifyDirectory(current);
  }
  return current;
}

/** Creates one relative directory beneath an existing workspace root. */
export async function ensureWorkspaceDirectory(workspaceDir, relativeDirectory = "") {
  if (relativeDirectory === "") {
    await createAndVerifyDirectory(workspaceDir);
    return workspaceDir;
  }
  resolveWorkspacePath(workspaceDir, relativeDirectory);
  let current = workspaceDir;
  for (const segment of relativeDirectory.split("/")) {
    current = path.join(current, segment);
    await createAndVerifyDirectory(current);
  }
  return current;
}

/**
 * Reads one workspace file, refusing a link anywhere on the way to it — every
 * parent directory, and the file itself — and anything past its byte bound.
 */
export async function readWorkspaceFile(workspaceDir, relativePath, maximumBytes) {
  const filePath = resolveWorkspacePath(workspaceDir, relativePath);
  if (!await requireRealDirectoryChain(workspaceDir, relativePath)) {
    throw new SiteAuthoringError(
      "workspace.file_missing",
      `Workspace file '${relativePath}' does not exist.`,
      { field: relativePath },
    );
  }
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile()) {
      throw new SiteAuthoringError(
        "workspace.not_regular",
        `Workspace file '${relativePath}' is not a regular file.`,
        { field: relativePath },
      );
    }
    if (stats.size > BigInt(maximumBytes)) {
      throw new SiteAuthoringError(
        "workspace.file_too_large",
        `Workspace file '${relativePath}' exceeds ${maximumBytes} bytes.`,
        { field: relativePath },
      );
    }
    const buffer = Buffer.allocUnsafe(Number(stats.size));
    let total = 0;
    while (total < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, total, buffer.byteLength - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return buffer.subarray(0, total);
  } catch (error) {
    if (error instanceof SiteAuthoringError) throw error;
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new SiteAuthoringError(
        "workspace.file_missing",
        `Workspace file '${relativePath}' does not exist.`,
        { field: relativePath },
      );
    }
    throw new SiteAuthoringError(
      "workspace.unreadable",
      `Could not read workspace file '${relativePath}'.`,
      { field: relativePath },
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function readWorkspaceJson(workspaceDir, relativePath, maximumBytes) {
  const bytes = await readWorkspaceFile(workspaceDir, relativePath, maximumBytes);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new SiteAuthoringError(
      "workspace.invalid_json",
      `Workspace file '${relativePath}' is not valid JSON.`,
      { field: relativePath },
    );
  }
}

/**
 * Classifies one workspace path so a caller can tell a file from a directory
 * before it tries to read it. `"file"`, `"directory"`, `"missing"`, or
 * `"other"` — a symlink is deliberately *not* resolved and reports as
 * `"other"`, because following one is how a positional argument turns into a
 * read outside the workspace.
 */
export async function inspectWorkspaceEntry(workspaceDir, relativePath) {
  const target = resolveWorkspacePath(workspaceDir, relativePath);
  // The leaf `lstat` below refuses a linked final component; this refuses a
  // linked one anywhere above it, which is how `media/link/sub` would otherwise
  // classify as a perfectly ordinary directory sitting outside the workspace.
  if (!await requireRealDirectoryChain(workspaceDir, relativePath)) return "missing";
  let stats;
  try {
    stats = await lstat(target);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return "missing";
    throw new SiteAuthoringError(
      "workspace.unreadable",
      `Could not inspect workspace path '${relativePath}'.`,
      { field: relativePath },
    );
  }
  if (stats.isSymbolicLink()) return "other";
  if (stats.isDirectory()) return "directory";
  return stats.isFile() ? "file" : "other";
}

/**
 * Whether one workspace path is a regular file.
 *
 * `false` means one thing only: nothing is there. Every other answer is a
 * refusal, because every caller of this treats `false` as "absent, carry on
 * without it" — and carrying on is wrong for anything that *does* exist but
 * cannot be read as a file.
 *
 * A symlink at the final component is the case that made this matter. The
 * chain check above covers parent segments, but the leaf used to go through
 * `isFile()`, which is false for a link — so a linked media manifest read as
 * absent, `readMediaManifest` minted an empty one, and `media upload` uploaded
 * and confirmed images against the API before the `O_NOFOLLOW` write finally
 * failed, leaving confirmed images recorded nowhere. A linked pull manifest
 * read as absent in `deploy`, which then promoted whatever staging deployment
 * it found rather than the one the workspace recorded. Neither is a state to
 * discover after the network calls.
 *
 * A bare `catch` did the same for `EACCES`, `ELOOP`, and everything else: a
 * manifest that exists but cannot be inspected is not a manifest that is
 * missing.
 */
export async function workspaceFileExists(workspaceDir, relativePath) {
  const filePath = resolveWorkspacePath(workspaceDir, relativePath);
  if (!await requireRealDirectoryChain(workspaceDir, relativePath)) return false;
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw new SiteAuthoringError(
      "workspace.unreadable",
      `Could not inspect workspace file '${relativePath}'.`,
      { field: relativePath },
    );
  }
  if (stats.isFile()) return true;
  throw new SiteAuthoringError(
    "workspace.not_regular",
    `Workspace file '${relativePath}' is not a regular file. Nothing outside the workspace is read.`,
    { field: relativePath },
  );
}

/** Atomically writes one workspace file, creating its parent chain and refusing links. */
export async function writeWorkspaceFile(workspaceDir, relativePath, contents, { openDirectory = open } = {}) {
  const filePath = resolveWorkspacePath(workspaceDir, relativePath);
  const segments = relativePath.split("/");
  await ensureWorkspaceDirectory(workspaceDir, segments.slice(0, -1).join("/"));

  // The write discipline itself lives in `atomicWriteFile`; what stays here is
  // the part that is genuinely about a workspace — the containment above, and
  // the vocabulary a workspace refusal speaks in.
  await atomicWriteFile(filePath, contents, {
    openDirectory,
    failures: {
      inspect: () =>
        new SiteAuthoringError(
          "workspace.unwritable",
          `Could not inspect workspace file '${relativePath}' before writing.`,
          { field: relativePath },
        ),
      notRegular: () =>
        new SiteAuthoringError(
          "workspace.not_regular",
          `Workspace file '${relativePath}' is not a regular file. Nothing outside the workspace is written.`,
          { field: relativePath },
        ),
      write: () =>
        new SiteAuthoringError(
          "workspace.unwritable",
          `Could not write workspace file '${relativePath}'.`,
          { field: relativePath },
        ),
    },
  });
  return relativePath;
}

export async function writeWorkspaceJson(workspaceDir, relativePath, value) {
  return await writeWorkspaceFile(workspaceDir, relativePath, `${JSON.stringify(value, undefined, 2)}\n`);
}

/**
 * Removes one internal workspace file, refusing a link anywhere on the way to
 * it exactly as a read would. Returns whether anything was there.
 *
 * Only internal state is ever removed this way. Authored sources are the
 * author's, and a verb that deleted one would be doing the thing this package
 * exists to prevent.
 */
export async function deleteWorkspaceFile(workspaceDir, relativePath) {
  if (!await workspaceFileExists(workspaceDir, relativePath)) return false;
  try {
    await unlink(resolveWorkspacePath(workspaceDir, relativePath));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw new SiteAuthoringError(
      "workspace.unwritable",
      `Could not remove workspace file '${relativePath}'.`,
      { field: relativePath },
    );
  }
  return true;
}

/**
 * Collects the workspace files a push verb should consider, in a stable sorted
 * order so two runs of the same workspace produce the same request sequence.
 *
 * What is skipped, and what is refused, is the whole contract here:
 *
 * - **Skipped silently:** dot-entries, non-conforming *directories*, and
 *   anything that is neither a regular file nor a directory. None of these is
 *   authored content a caller expects to publish.
 * - **Refused by name:** a *file* that matches the extension filter but whose
 *   name is not `[A-Za-z0-9][A-Za-z0-9._-]*`. `pages/Hero Draft.md` is a page
 *   someone wrote and expects to see published; dropping it would let the push
 *   report success with a page quietly missing, which is precisely the silent
 *   narrowing this CLI exists to prevent.
 * - **Refused on overrun:** more matching files than the bound allows.
 *
 * Symlinks are never followed, at either end of the walk. The root is checked
 * *including its last segment* — a linked `pages` is exactly the case that made
 * this a real hole, and `readdir` would have followed it silently — and inside
 * the walk a symlink entry reports neither `isDirectory()` nor `isFile()`, so
 * it is never queued and never collected.
 */
export async function walkWorkspaceFiles(
  workspaceDir,
  relativeRoot,
  extensions,
  { segmentPattern = SAFE_SEGMENT, segmentDescription = "letters, digits, '.', '_', and '-'" } = {},
) {
  const rootPath = resolveWorkspacePath(workspaceDir, relativeRoot);
  if (!await requireRealDirectoryChain(workspaceDir, relativeRoot, { includeLeaf: true })) return [];
  const collected = [];
  const queue = [{ directory: rootPath, relative: relativeRoot, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current.depth >= WORKSPACE_LIMITS.directoryDepth) continue;
    let entries;
    try {
      entries = await readdir(current.directory, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw new SiteAuthoringError("workspace.unreadable", "Could not read a workspace directory.");
    }
    for (const entry of [...entries].sort((left, right) => (left.name < right.name ? -1 : 1))) {
      if (entry.name.startsWith(".")) continue;
      const relative = `${current.relative}/${entry.name}`;
      const conforming = segmentPattern.test(entry.name);
      if (entry.isDirectory()) {
        if (!conforming) continue;
        queue.push({ directory: path.join(current.directory, entry.name), relative, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (extensions.some((extension) => entry.name.toLowerCase().endsWith(extension))) {
        // A file the caller plainly meant to publish — right directory, right
        // extension — but whose name this package cannot carry. Skipping it
        // would be exactly the silent narrowing this CLI exists to prevent: the
        // push would report success having quietly left one page behind.
        if (!conforming) {
          throw new SiteAuthoringError(
            "workspace.name_unsupported",
            `Workspace file '${relative}' has an unsupported name. Names must match `
              + `the allowed workspace grammar — start with a letter or digit, and use only ${segmentDescription}.`,
            { field: relative },
          );
        }
        if (collected.length >= WORKSPACE_LIMITS.files) {
          throw new SiteAuthoringError(
            "workspace.too_many_files",
            `The workspace holds more than ${WORKSPACE_LIMITS.files} files under '${relativeRoot}'.`,
            { field: relativeRoot },
          );
        }
        collected.push(relative);
      }
    }
  }
  return collected.sort();
}

/**
 * Normalizes a site page path the way `SystemPagePaths.Normalize` does, so the
 * CLI's idea of "the home page" and the server's are the same string. The
 * documented homepage spelling `/` normalizes to the manifest's empty root
 * path here; every path-addressed verb resolves selectors through this one
 * helper, so that spelling reaches the site root everywhere.
 */
export function normalizePagePath(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/^\/+/u, "").replace(/\/+$/u, "");
  if (
    Buffer.byteLength(trimmed, "utf8") > WORKSPACE_LIMITS.pagePathBytes
    || hasAsciiControl(trimmed)
    || trimmed.includes("\\")
    || trimmed.split("/").some((segment) => segment === "." || segment === ".." || (trimmed !== "" && segment === ""))
  ) {
    return undefined;
  }
  return trimmed;
}

/**
 * Chooses the workspace file name for a pulled page. The server's path is
 * preferred because it is what an author recognizes, but it is server data
 * reaching a filesystem, so anything that is not plainly safe falls back to the
 * page id. The manifest — not the file name — remains the authority on which
 * page a file is.
 */
export function workspaceFileNameForPage(pagePath, pageId) {
  const normalized = normalizePagePath(pagePath);
  if (normalized === "") return "index";
  const segments = normalized === undefined ? [] : normalized.split("/");
  if (
    segments.length > 0
    && segments.length < WORKSPACE_LIMITS.directoryDepth - 1
    && segments.every((segment) => SAFE_SEGMENT.test(segment))
  ) {
    return segments.join("/");
  }
  return SAFE_SEGMENT.test(pageId ?? "") ? pageId : "page";
}

function requireManifestObject(value, code, description, fileName) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new SiteAuthoringError(code, `The ${description} in '${fileName}' is malformed.`, { field: fileName });
  }
  return value;
}

/** Workspace data reaching a diagnostic: bounded before it is interpolated. */
function describeStoredSite(value) {
  if (typeof value !== "string" || value === "") return "no site";
  return `site ${value.slice(0, 64)}`;
}

/**
 * Binds a workspace file to the site the current configuration and credential
 * name.
 *
 * A workspace is a directory of files, and nothing about it says which site it
 * came from except this. Point the configuration — or the key — at a second
 * site and every page id, resource id, and image id in the manifest still reads
 * as valid: `pages push` would plan site A's content onto site B, and the stale
 * image ids would fail only once phase two was already writing. So the binding
 * is checked before any planning and before any request.
 *
 * A file with no `siteId` at all is refused the same way. It can only be a
 * workspace from before this check existed, and the package is in-repo and
 * unreleased — a re-pull costs nothing, and guessing that an unbound manifest
 * "is probably this site" is the exact assumption that makes the failure
 * silent.
 */
function requireManifestSite(parsed, expectedSiteId, fileName) {
  if (typeof expectedSiteId !== "string" || expectedSiteId === "") {
    throw new SiteAuthoringError(
      "workspace.manifest_site_unknown",
      `Reading '${fileName}' requires the site it must belong to.`,
      { field: fileName },
    );
  }
  if (parsed.siteId !== expectedSiteId) {
    throw new SiteAuthoringError(
      "workspace.manifest_site_mismatch",
      `'${fileName}' records ${describeStoredSite(parsed.siteId)}, but this configuration targets site `
        + `${expectedSiteId}. Run 'taproot-site pull' into a workspace of its own for this site.`,
      { field: fileName },
    );
  }
  return parsed;
}

/**
 * What a workspace's pull manifest says about the site it belongs to, as one of
 * four distinct states rather than a site id that may or may not be there:
 *
 * - `"absent"`    — no manifest. A workspace nobody has pulled into yet.
 * - `"unreadable"` — a manifest that is not parseable JSON, or not an object.
 * - `"unbound"`   — a manifest object that records no `siteId`.
 * - `"bound"`     — a manifest naming the site in `siteId`.
 *
 * The states matter because each carries a different obligation for the
 * caller, and collapsing them to `undefined` hid that. `"bound"` is compared
 * with the target site. `"unreadable"` and `"unbound"` cannot establish
 * ownership — a truncated write leaves the first, a pre-binding pull left the
 * second — and must be refused: proceeding rewrites the file with a new site
 * id while the previous site's page sources survive beside it, and the next
 * `pages push` then reads a manifest that agrees with itself, finds no
 * entries for those files, and creates the first site's bodies as new pages
 * on the second. `"absent"` alone is not proof of a fresh workspace either —
 * a crash between the page writes and the manifest write produces it — so
 * `pull` accepts it only after separately checking that no page sources exist
 * and that every site-bound artifact present identifies the current site.
 */
export async function inspectArtifactSiteBinding(workspaceDir, relativePath) {
  if (!await workspaceFileExists(workspaceDir, relativePath)) return { state: "absent" };
  let parsed;
  try {
    parsed = await readWorkspaceJson(workspaceDir, relativePath, WORKSPACE_LIMITS.manifestBytes);
  } catch {
    return { state: "unreadable" };
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") return { state: "unreadable" };
  return typeof parsed.siteId === "string" && parsed.siteId !== ""
    ? { state: "bound", siteId: parsed.siteId }
    : { state: "unbound" };
}

/** The pull manifest's own binding — the site a workspace was last pulled from. */
export async function inspectManifestSiteBinding(workspaceDir) {
  return await inspectArtifactSiteBinding(workspaceDir, MANIFEST_FILE_NAME);
}

/**
 * Reads the pull manifest. A push against a workspace that was never pulled is
 * refused rather than guessed at: without the manifest the CLI cannot tell a
 * new page from an edit of an existing one, and guessing wrong either
 * duplicates a page or overwrites the wrong one.
 */
export async function readManifest(workspaceDir, expectedSiteId, { required = true } = {}) {
  if (!await workspaceFileExists(workspaceDir, MANIFEST_FILE_NAME)) {
    if (!required) return undefined;
    throw new SiteAuthoringError(
      "workspace.manifest_missing",
      `No ${MANIFEST_FILE_NAME} was found in the workspace. Run 'taproot-site pull' before pushing.`,
      { field: MANIFEST_FILE_NAME },
    );
  }
  const parsed = requireManifestObject(
    await readWorkspaceJson(workspaceDir, MANIFEST_FILE_NAME, WORKSPACE_LIMITS.manifestBytes),
    "workspace.manifest_invalid",
    "manifest",
    MANIFEST_FILE_NAME,
  );
  // Before the version and the shape: a manifest for another site is the wrong
  // file entirely, and saying so is more use than complaining about its
  // contents. A mismatch refuses even when the manifest was optional.
  requireManifestSite(parsed, expectedSiteId, MANIFEST_FILE_NAME);
  if (parsed.manifestVersion !== MANIFEST_VERSION) {
    throw new SiteAuthoringError(
      "workspace.manifest_version",
      `${MANIFEST_FILE_NAME} declares an unsupported manifestVersion. Run 'taproot-site pull' again.`,
      { field: "manifestVersion" },
    );
  }
  if (!Array.isArray(parsed.pages)) {
    throw new SiteAuthoringError(
      "workspace.manifest_invalid",
      `${MANIFEST_FILE_NAME} does not record a page list. Run 'taproot-site pull' again.`,
      { field: "pages" },
    );
  }
  return parsed;
}

export async function writeManifest(workspaceDir, manifest) {
  return await writeWorkspaceJson(workspaceDir, MANIFEST_FILE_NAME, manifest);
}

/**
 * The media manifest is separate from the pull manifest on purpose: uploading
 * media is legitimate in a workspace that has never been pulled, and folding it
 * into the pull manifest would make `media upload` mint a manifest that
 * `pages push` would then read as proof of a pull that never happened.
 */
export async function readMediaManifest(workspaceDir, expectedSiteId) {
  if (!await workspaceFileExists(workspaceDir, MEDIA_MANIFEST_FILE_NAME)) {
    if (typeof expectedSiteId !== "string" || expectedSiteId === "") {
      throw new SiteAuthoringError(
        "workspace.manifest_site_unknown",
        `Reading '${MEDIA_MANIFEST_FILE_NAME}' requires the site it must belong to.`,
        { field: MEDIA_MANIFEST_FILE_NAME },
      );
    }
    return { mediaManifestVersion: MEDIA_MANIFEST_VERSION, siteId: expectedSiteId, media: {} };
  }
  const parsed = requireManifestObject(
    await readWorkspaceJson(workspaceDir, MEDIA_MANIFEST_FILE_NAME, WORKSPACE_LIMITS.manifestBytes),
    "workspace.media_manifest_invalid",
    "media manifest",
    MEDIA_MANIFEST_FILE_NAME,
  );
  // Image ids are site-scoped, so a media manifest from another site resolves
  // every reference to something this site cannot deliver — and only finds out
  // once `pages push` is already writing pages.
  requireManifestSite(parsed, expectedSiteId, MEDIA_MANIFEST_FILE_NAME);
  if (parsed.mediaManifestVersion !== MEDIA_MANIFEST_VERSION) {
    throw new SiteAuthoringError(
      "workspace.media_manifest_version",
      `${MEDIA_MANIFEST_FILE_NAME} declares an unsupported mediaManifestVersion. `
        + "Run 'taproot-site media upload' again to rewrite it.",
      { field: "mediaManifestVersion" },
    );
  }
  return {
    mediaManifestVersion: MEDIA_MANIFEST_VERSION,
    siteId: expectedSiteId,
    media: requireManifestObject(
      parsed.media ?? {},
      "workspace.media_manifest_invalid",
      "media map",
      MEDIA_MANIFEST_FILE_NAME,
    ),
  };
}

export async function writeMediaManifest(workspaceDir, mediaManifest) {
  return await writeWorkspaceJson(workspaceDir, MEDIA_MANIFEST_FILE_NAME, mediaManifest);
}
