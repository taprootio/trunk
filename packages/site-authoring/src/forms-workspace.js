import { SiteAuthoringError } from "./errors.js";
import {
  FORM_DEFAULT_SINK,
  FORM_FILE_EXTENSION,
  FORM_RETENTION_DAYS,
  FORM_LIMITS,
  FORMS_DIRECTORY,
  formFileName,
  isFormKey,
  validateFormDocument,
} from "./forms-contract.js";
import { readWorkspaceJson, walkWorkspaceFiles } from "./workspace.js";

/**
 * Reads and validates the workspace's form files (TR01061).
 *
 * `keys` narrows the read to named forms and refuses a name with no file, so a
 * typo never reads as a successful empty push. With none, every file under
 * `forms/` is read. A file whose name is not a form key is refused rather than
 * skipped: skipping it would report success with one form left behind.
 */
export async function readWorkspaceForms(workspaceDir, keys) {
  const files = await walkWorkspaceFiles(workspaceDir, FORMS_DIRECTORY, [FORM_FILE_EXTENSION]);
  const known = new Map();
  for (const file of files) {
    const key = file.slice(FORMS_DIRECTORY.length + 1, -FORM_FILE_EXTENSION.length);
    if (key.includes("/") || !isFormKey(key)) {
      throw new SiteAuthoringError(
        "forms.file_invalid",
        `${file}: a form file is forms/<key>.json directly under forms/, with a key of lowercase letters, `
          + "digits, and single hyphens between them.",
        { field: file },
      );
    }
    known.set(key, file);
  }
  const selected = keys === undefined ? [...known.keys()].sort() : [...new Set(keys)].sort();
  const forms = [];
  for (const key of selected) {
    const file = known.get(key);
    if (file === undefined) {
      throw new SiteAuthoringError(
        "forms.file_missing",
        `There is no ${formFileName(key)} in the workspace.`,
        { field: formFileName(key) },
      );
    }
    const document_ = await readWorkspaceJson(workspaceDir, file, FORM_LIMITS.fileBytes);
    forms.push({ key, file, document: validateFormDocument(document_, key) });
  }
  return forms;
}

/**
 * The forms baseline in the pull manifest (TR01061).
 *
 * The site has no compare-and-set for a form, so `forms push` fences itself:
 * it writes a form only when the site's current version is the one the last
 * pull or push recorded here. A form edited in the browser since then makes
 * the push refuse toward pull instead of overwriting it.
 */
export const FORMS_MANIFEST_KEY = "forms";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The settings half of a baseline, from the form exactly as the site returned
 * it. Name, sink and retention change without appending a version, so the
 * version alone cannot say they moved.
 */
export function siteSettingsBaseline(siteForm) {
  return {
    name: siteForm.name,
    sink: siteForm.sink ?? FORM_DEFAULT_SINK,
    retention_days: siteForm.retentionDays ?? FORM_RETENTION_DAYS.default,
  };
}

/** The recorded baseline for one key, or undefined when this workspace never saw that form. */
export function recordedForm(manifest, key) {
  const items = manifest[FORMS_MANIFEST_KEY]?.items;
  if (!isObject(items) || !Object.hasOwn(items, key)) return undefined;
  const entry = items[key];
  return isObject(entry) && typeof entry.id === "string" && Number.isSafeInteger(entry.version)
      && isObject(entry.settings)
    ? { id: entry.id, version: entry.version, settings: entry.settings }
    : undefined;
}

export function formsManifestEntry(items) {
  return { items: Object.fromEntries([...items].sort(([left], [right]) => (left < right ? -1 : 1))) };
}

/** Sets one form's baseline and keeps every other entry, in key order. */
export function withRecordedForm(manifest, key, entry) {
  const current = isObject(manifest[FORMS_MANIFEST_KEY]?.items) ? manifest[FORMS_MANIFEST_KEY].items : {};
  return { ...manifest, [FORMS_MANIFEST_KEY]: formsManifestEntry(Object.entries({ ...current, [key]: entry })) };
}
