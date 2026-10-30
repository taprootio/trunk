import {
  MARKETING_KIND_NAMES,
  MARKETING_KINDS,
  MARKETING_LIMITS,
  validateMarketingDocument,
} from "./marketing-contract.js";
import { readWorkspaceJson, workspaceFileExists } from "./workspace.js";

/**
 * Reads the workspace's marketing files and keeps their baseline in the pull manifest (TR01301).
 *
 * A kind with no file is simply not read: a workspace that never held a placement is not telling the site to
 * archive them all. Within a file, a record left out is a request to archive it, and only `marketing push
 * --archive` honors that request.
 */
export const MARKETING_MANIFEST_KEY = "marketing";

/** The records of every kind (or of the named kinds) whose file the workspace holds, validated. */
export async function readWorkspaceMarketing(workspaceDir, kinds = MARKETING_KIND_NAMES) {
  const found = new Map();
  for (const kind of kinds) {
    const { file } = MARKETING_KINDS[kind];
    if (!await workspaceFileExists(workspaceDir, file)) continue;
    const document_ = await readWorkspaceJson(workspaceDir, file, MARKETING_LIMITS.fileBytes);
    found.set(kind, validateMarketingDocument(kind, document_));
  }
  return found;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * What a baseline remembers of a record: its id, whether it was archived, the labels an author decides, and the state
 * the site reported when it was written. The state is the one `link build` trusts for its note; a file's own `state`
 * is whatever the author left there, which is wrong for a key that was renamed from a live one.
 */
export function baselineEntry(kind, record) {
  const entry = { id: record.id, archived: record.archived === true, name: record.name };
  if (record.state !== undefined) entry.state = record.state;
  if (MARKETING_KINDS[kind].withLabels) {
    if (record.note !== undefined && record.note !== "") entry.note = record.note;
    if (record.starts_on !== undefined) entry.starts_on = record.starts_on;
    if (record.ends_on !== undefined) entry.ends_on = record.ends_on;
  }
  return entry;
}

/** The recorded baseline of one kind, by key. Empty when this workspace never pulled that kind. */
export function recordedMarketing(manifest, kind) {
  const items = manifest[MARKETING_MANIFEST_KEY]?.[kind]?.items;
  const recorded = new Map();
  if (!isObject(items)) return recorded;
  for (const [key, entry] of Object.entries(items)) {
    if (isObject(entry) && typeof entry.id === "string" && typeof entry.archived === "boolean") {
      recorded.set(key, entry);
    }
  }
  return recorded;
}

/** Whether a remembered baseline and a record from the site agree on the labels an author decides. */
export function sameLabels(kind, left, right) {
  if (left.name !== right.name) return false;
  if (!MARKETING_KINDS[kind].withLabels) return true;
  return (left.note ?? "") === (right.note ?? "")
    && left.starts_on === right.starts_on
    && left.ends_on === right.ends_on;
}

/** The manifest with one kind's baseline replaced by `entries` (key to baseline entry), in key order. */
export function withRecordedMarketing(manifest, kind, entries) {
  const current = isObject(manifest[MARKETING_MANIFEST_KEY]) ? manifest[MARKETING_MANIFEST_KEY] : {};
  const items = Object.fromEntries([...entries].sort(([left], [right]) => (left < right ? -1 : 1)));
  return { ...manifest, [MARKETING_MANIFEST_KEY]: { ...current, [kind]: { items } } };
}
