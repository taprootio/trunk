import { SiteAuthoringError } from "./errors.js";
import {
  FORM_DEFAULT_NOTIFY_OWNER,
  FORM_FILE_EXTENSION,
  FORM_LIMITS,
  FORMS_DIRECTORY,
  formFileName,
  isFormKey,
  projectFormSettings,
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
 * Newsletter admission is strict by default; `forms push` defers it for baseline comparison.
 */
export async function readWorkspaceForms(workspaceDir, keys, validationOptions = {}) {
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
    forms.push({ key, file, document: validateFormDocument(document_, key, validationOptions) });
  }
  requireDistinctNames(forms);
  return forms;
}

/** A form name as the site compares it: trimmed, ignoring case (TR01216). */
export function comparableFormName(name) {
  return String(name).trim().toLowerCase();
}

/** Names are unique per site, so two files in one push cannot share one. */
function requireDistinctNames(forms) {
  const seen = new Map();
  for (const form of forms) {
    const name = comparableFormName(form.document.name);
    const other = seen.get(name);
    if (other !== undefined) {
      throw new SiteAuthoringError(
        "forms.name_duplicate",
        `${form.file} and ${other} both name the form '${form.document.name}'. A form name is unique on a site, `
          + "ignoring case; rename one of them.",
        { field: `${form.file}:name` },
      );
    }
    seen.set(name, form.file);
  }
}

/**
 * The forms baseline in the pull manifest (TR01061).
 *
 * A browser edit since the last pull or push makes the next push refuse rather
 * than overwrite it. Each mutation also sends this baseline so the site can
 * refuse an edit made after the CLI compared them.
 */
export const FORMS_MANIFEST_KEY = "forms";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The settings half of a baseline, from the form exactly as the site returned
 * it. Operational settings change without appending a version, so the
 * version alone cannot say they moved.
 */
export function siteSettingsBaseline(siteForm) {
  return projectFormSettings({
    name: siteForm.name,
    sink: siteForm.sink,
    retention_days: siteForm.retentionDays,
    notify_owner: siteForm.notifyOwner,
  });
}

/** The recorded baseline for one key, or undefined when this workspace never saw that form. */
export function recordedForm(manifest, key) {
  const items = manifest[FORMS_MANIFEST_KEY]?.items;
  if (!isObject(items) || !Object.hasOwn(items, key)) return undefined;
  const entry = items[key];
  return isObject(entry) && typeof entry.id === "string" && Number.isSafeInteger(entry.version)
      && isObject(entry.settings)
    ? {
      id: entry.id,
      version: entry.version,
      // Old baselines can prove only the default opt-out, never a remote opt-in.
      settings: {
        ...entry.settings,
        notify_owner: Object.hasOwn(entry.settings, "notify_owner") ? entry.settings.notify_owner : FORM_DEFAULT_NOTIFY_OWNER,
      },
    }
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
