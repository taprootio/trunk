import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import { SiteAuthoringError } from "./errors.js";
import { planStale } from "./problems.js";

/**
 * What `plan` read from the workspace, so `apply` can send nothing else
 * (TR00823).
 *
 * Every workspace read goes through `workspace.js`, which reports it here.
 * While `plan` (or `apply`'s re-plan) runs, each read is recorded: a file's
 * digest, a stream's size and modification time, whether a path exists, what a
 * directory walk listed. While `apply`'s steps run, each read is compared with
 * that record. A read the plan never made, or one whose answer changed, stops
 * the step before it writes, because whatever it was about to send was never
 * reviewed. A file that `apply` itself writes, such as the media manifest the
 * upload step records, replaces its own entry, so the next step reads it as
 * expected.
 *
 * The ledger guards the workspace only. What lives on the site (page
 * revisions, the navigation tree) is checked by the steps against the plan.
 */

const scope = new AsyncLocalStorage();

const MISSING = "missing";

export function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Runs `action` while recording every workspace read; returns its result and the ledger. */
export async function recordWorkspaceReads(action) {
  const ledger = { mode: "record", entries: new Map() };
  const result = await scope.run(ledger, action);
  return { result, ledger: Object.freeze({ entries: ledger.entries }) };
}

/** Runs `action` refusing any workspace read the ledger does not hold. */
export async function enforceWorkspaceReads(recorded, action) {
  const ledger = { mode: "enforce", entries: new Map(recorded.entries), written: new Set(), deleted: new Set() };
  return await scope.run(ledger, action);
}

/** A stable digest of everything the ledger recorded, for the plan hash. */
export function ledgerDigest(recorded) {
  const entries = [...recorded.entries.entries()].sort(([left], [right]) => (left < right ? -1 : 1));
  return digest(JSON.stringify(entries));
}

function stale(path, mode) {
  // While planning, the plan itself is what moved; while applying, the step.
  return mode === "record"
    ? new SiteAuthoringError(
      "plan.workspace_changed",
      `'${path}' changed while the plan was reading the workspace. Wait for whatever is writing it to finish, then `
        + "run 'taproot-site plan' again.",
      { field: path },
    )
    : planStale(`'${path}'`, path);
}

function key(kind, path) {
  return `${kind}:${path}`;
}

/**
 * One read's answer. While recording, the first answer for a key is kept; a
 * different later answer means the workspace moved while it was being planned.
 * While enforcing, the answer must match what was recorded.
 */
function noteRead(kind, path, value) {
  const ledger = scope.getStore();
  if (ledger === undefined) return;
  const entry = key(kind, path);
  const recorded = ledger.entries.get(entry);
  if (ledger.mode === "record") {
    if (recorded === undefined) ledger.entries.set(entry, value);
    else if (recorded !== value) throw stale(path, "record");
    return;
  }
  if (recorded === value) return;
  if (recorded === undefined && impliedByRecordedRead(ledger, kind, path, value)) return;
  throw stale(path, "enforce");
}

/**
 * Whether the plan already answered this question another way. A file the plan
 * read was a regular file, and one it found missing did not exist; a step that
 * asks only whether it exists, or what kind of entry it is, learns nothing the
 * plan did not see. The bytes themselves are still compared when the step reads
 * them.
 */
function impliedByRecordedRead(ledger, kind, path, value) {
  if (kind !== "exists" && kind !== "entry") return false;
  const read = ledger.entries.get(key("file", path)) ?? ledger.entries.get(key("stream", path));
  if (read === undefined) return false;
  const present = read !== MISSING;
  return kind === "exists" ? value === present : value === (present ? "file" : MISSING);
}

// The digests are computed only inside a ledger: every other verb reads
// without paying for them.
export function noteFileRead(path, bytes) {
  if (scope.getStore() !== undefined) noteRead("file", path, digest(bytes));
}

export function noteFileMissing(path) {
  noteRead("file", path, MISSING);
}

export function noteStreamOpened(path, byteLength, modifiedMilliseconds, header) {
  if (scope.getStore() !== undefined) noteRead("stream", path, `${byteLength}:${modifiedMilliseconds}:${digest(header)}`);
}

export function noteStreamMissing(path) {
  noteRead("stream", path, MISSING);
}

export function noteExists(path, exists) {
  noteRead("exists", path, exists);
}

export function noteEntry(path, kind) {
  noteRead("entry", path, kind);
}

/**
 * A directory walk. While enforcing, the listing must be the recorded one,
 * plus the files this apply wrote under that root and minus those it removed.
 */
export function noteWalk(root, filter, files) {
  const ledger = scope.getStore();
  if (ledger === undefined) return;
  const entry = key("walk", `${root}|${filter}`);
  if (ledger.mode === "record") {
    noteRead("walk", `${root}|${filter}`, JSON.stringify(files));
    return;
  }
  const recorded = ledger.entries.get(entry);
  if (recorded === undefined) throw stale(root, "enforce");
  const expected = new Set(JSON.parse(recorded));
  const prefix = `${root}/`;
  for (const path of ledger.written) if (path.startsWith(prefix) && files.includes(path)) expected.add(path);
  for (const path of ledger.deleted) if (path.startsWith(prefix)) expected.delete(path);
  const listed = new Set(files);
  // Name the first file that appeared or went missing, not just the directory.
  const changed = files.find((path) => !expected.has(path)) ?? [...expected].sort().find((path) => !listed.has(path));
  if (changed !== undefined) throw stale(changed, "enforce");
}

/** A file this apply wrote: later reads of it must find exactly these bytes. */
export function noteFileWritten(path, contents) {
  const ledger = scope.getStore();
  if (ledger === undefined || ledger.mode !== "enforce") return;
  ledger.entries.set(key("file", path), digest(contents));
  ledger.entries.set(key("exists", path), true);
  ledger.entries.set(key("entry", path), "file");
  ledger.written.add(path);
  ledger.deleted.delete(path);
}

/** A file this apply removed. */
export function noteFileDeleted(path) {
  const ledger = scope.getStore();
  if (ledger === undefined || ledger.mode !== "enforce") return;
  ledger.entries.set(key("file", path), MISSING);
  ledger.entries.set(key("exists", path), false);
  ledger.entries.set(key("entry", path), MISSING);
  ledger.deleted.add(path);
  ledger.written.delete(path);
}
