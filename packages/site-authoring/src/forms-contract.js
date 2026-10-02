import { SiteAuthoringError } from "./errors.js";
import { contactFieldId, validateDefinition } from "./field-validation.js";

/**
 * The workspace contract for a form (TR01061).
 *
 * A form is one JSON file, `forms/<key>.json`, holding what an author decides:
 * its key, name, sink, retention and definition. The definition holds the fields
 * and the form's own settings (`contact_field`, `submit_label`, `after_submit`),
 * exactly as the site stores it, so one validator reads one shape. The
 * definition's own rules belong to `shared/field-validation.ts` and are run
 * here through the generated copy, so this file never restates them. The one
 * translation is a page: the site names the page after a response by resource
 * id, and the file by `page_path`, which `forms push` resolves and `forms pull`
 * writes back, so an author never handles an id. Everything
 * the site decides (the version, the form id, who edited it last) stays out of
 * the file and in the pull manifest, which is what lets `forms pull` and
 * `forms push` round-trip the file byte for byte.
 */

export const FORMS_DIRECTORY = "forms";
export const FORM_FILE_EXTENSION = ".json";

// Mirrors SiteFormContract.IsValidKey on the API: the key is also a file name
// and an attribute value, so it stays lowercase and URL-safe.
export const FORM_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const FORM_KEY_MAXIMUM_LENGTH = 64;
export const FORM_SINKS = Object.freeze(["none", "newsletter"]);
export const FORM_DEFAULT_SINK = "none";
export const FORM_RETENTION_DAYS = Object.freeze({ minimum: 30, maximum: 730, default: 365 });
export const FORM_LIMITS = Object.freeze({
  nameCharacters: 120,
  // The site refuses a definition larger than this once serialized.
  definitionBytes: 64 * 1024,
  fileBytes: 256 * 1024,
});

const FORM_FILE_KEYS = ["key", "name", "sink", "retention_days", "definition"];
// The order `forms pull` writes, which `forms push` writes back after a save.
// Fixed rather than inherited from the response so the same form is always the
// same bytes.
const FIELD_KEY_ORDER = ["id", "type", "label", "hint", "required", "min_length", "max_length", "min", "max", "format", "choices"];
const AFTER_SUBMIT_KEY_ORDER = ["show", "message", "page_path", "page_resource_id"];
// A nil id stands in for a `page_path` while the shared validator checks everything else about the file.
const PLACEHOLDER_RESOURCE_ID = "00000000-0000-0000-0000-000000000000";
const MAXIMUM_REPORTED_ERRORS = 20;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(file, message, field) {
  return new SiteAuthoringError("forms.file_invalid", `${file}: ${message}`, { field: `${file}:${field}` });
}

/**
 * A site page path as the file writes it: a leading slash, no trailing one, and none of the
 * characters that would make it a query, a fragment or another origin. `/` is the home page.
 */
export function isCanonicalPagePath(path) {
  return path === "/" || /^\/[^\s\\?#/]+(?:\/[^\s\\?#/]+)*$/u.test(path);
}

/** The canonical spelling of a path a page summary reports, which may carry or lack slashes at either end. */
export function normalizePagePath(path) {
  return `/${path.replace(/^\/+|\/+$/gu, "")}`;
}

/** The `after_submit` that sends visitors to a page, or undefined for a form that shows its message. */
export function afterSubmitPage(definition) {
  const after = definition?.after_submit;
  return isPlainObject(after) && after.show === "page" ? after : undefined;
}

/** The workspace path a form key is stored at. */
export function formFileName(key) {
  return `${FORMS_DIRECTORY}/${key}${FORM_FILE_EXTENSION}`;
}

export function isFormKey(value) {
  return typeof value === "string" && value.length <= FORM_KEY_MAXIMUM_LENGTH && FORM_KEY_PATTERN.test(value);
}

/** NUL and lone surrogates cannot be stored by the site; it refuses them as invalid_characters. */
function hasUnstorableCharacters(text) {
  return /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);
}

function anyUnstorableString(value) {
  if (typeof value === "string") return hasUnstorableCharacters(value);
  if (Array.isArray(value)) return value.some(anyUnstorableString);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([key, child]) => hasUnstorableCharacters(key) || anyUnstorableString(child));
  }
  return false;
}

function describeDefinitionErrors(errors) {
  const shown = errors.slice(0, MAXIMUM_REPORTED_ERRORS).map((error) => `${error.path || "definition"}: ${error.code}`);
  const more = errors.length > shown.length ? ` (and ${errors.length - shown.length} more)` : "";
  return `${shown.join("; ")}${more}`;
}

/**
 * Validates one parsed form file and returns it unchanged in meaning.
 *
 * `expectedKey` is the key the file's name promises; a mismatch is refused
 * because a rename on disk would otherwise push a different form than the one
 * the author thinks they are editing.
 */
export function validateFormDocument(document_, expectedKey) {
  const file = formFileName(expectedKey);
  if (!isPlainObject(document_)) throw invalid(file, "the file must contain one JSON object.", "$");
  for (const name of Object.keys(document_)) {
    if (!FORM_FILE_KEYS.includes(name)) {
      throw invalid(file, `'${name}' is not a form property. Allowed: ${FORM_FILE_KEYS.join(", ")}.`, name);
    }
  }
  if (document_.key !== expectedKey) {
    throw invalid(file, `key must be '${expectedKey}', the name of the file.`, "key");
  }
  if (!isFormKey(expectedKey)) {
    throw invalid(file, `the key must be lowercase letters, digits, and single hyphens between them, at most ${FORM_KEY_MAXIMUM_LENGTH} characters.`, "key");
  }
  // The site stores the trimmed name, so a padded one could never match the baseline pull records.
  if (
    typeof document_.name !== "string"
    || document_.name.trim() === ""
    || document_.name !== document_.name.trim()
    || document_.name.length > FORM_LIMITS.nameCharacters
  ) {
    throw invalid(
      file,
      `name must be 1 to ${FORM_LIMITS.nameCharacters} characters with no space at either end.`,
      "name",
    );
  }
  if (document_.sink !== undefined && !FORM_SINKS.includes(document_.sink)) {
    throw invalid(file, `sink must be one of: ${FORM_SINKS.join(", ")}.`, "sink");
  }
  const days = document_.retention_days;
  if (
    days !== undefined
    && (!Number.isInteger(days) || days < FORM_RETENTION_DAYS.minimum || days > FORM_RETENTION_DAYS.maximum)
  ) {
    throw invalid(
      file,
      `retention_days must be a whole number from ${FORM_RETENTION_DAYS.minimum} to ${FORM_RETENTION_DAYS.maximum}.`,
      "retention_days",
    );
  }
  if (hasUnstorableCharacters(document_.name)) {
    throw invalid(file, "name cannot contain NUL or unpaired surrogate characters.", "name");
  }
  const errors = validateDefinition(shapeCheckedDefinition(file, document_.definition));
  if (errors.length > 0) {
    throw invalid(file, `the definition is invalid: ${describeDefinitionErrors(errors)}`, "definition");
  }
  if (anyUnstorableString(document_.definition)) {
    throw invalid(file, "the definition cannot contain NUL or unpaired surrogate characters.", "definition");
  }
  if (Buffer.byteLength(JSON.stringify(document_.definition), "utf8") > FORM_LIMITS.definitionBytes) {
    throw invalid(file, `the definition is larger than ${FORM_LIMITS.definitionBytes} bytes.`, "definition");
  }
  return document_;
}

/**
 * The definition the shared validator can read: a `page_path` is checked here and
 * replaced by a placeholder id, because the validator only knows the stored shape.
 */
function shapeCheckedDefinition(file, definition) {
  const after = afterSubmitPage(definition);
  if (after === undefined || !("page_path" in after)) return definition;
  if ("page_resource_id" in after) {
    throw invalid(file, "after_submit names its page twice: use page_path or page_resource_id, not both.", "definition.after_submit");
  }
  if (typeof after.page_path !== "string" || !isCanonicalPagePath(after.page_path)) {
    throw invalid(
      file,
      "after_submit.page_path must be a site path such as '/thanks': a leading slash, no trailing slash, no query or fragment.",
      "definition.after_submit.page_path",
    );
  }
  const { page_path: _path, ...rest } = after;
  return { ...definition, after_submit: { ...rest, page_resource_id: PLACEHOLDER_RESOURCE_ID } };
}

function canonicalAfterSubmit(afterSubmit, pathById) {
  const path = afterSubmit.show === "page" ? pathById?.get(afterSubmit.page_resource_id) : undefined;
  const source = path === undefined ? afterSubmit : { ...afterSubmit, page_resource_id: undefined, page_path: path };
  const ordered = {};
  for (const name of AFTER_SUBMIT_KEY_ORDER) if (source[name] !== undefined) ordered[name] = source[name];
  return ordered;
}

/**
 * The definition as the site stores it: `page_path` replaced by the page's resource id.
 * `pages` is the site's page index, which the caller loads when `afterSubmitPage` says it is needed.
 */
export function storedDefinition(file, definition, pages) {
  const after = afterSubmitPage(definition);
  if (after === undefined) return definition;
  const { page_path: path, ...rest } = after;
  if (path !== undefined) {
    const id = pages?.idByPath.get(path);
    if (id === undefined) {
      throw new SiteAuthoringError(
        "forms.page_not_found",
        pages?.truncated
          ? `${file}: the site has more pages than this CLI lists, so '${path}' could not be looked up. `
            + "Name the page by page_resource_id instead."
          : `${file}: no page on the site has the path '${path}'. Push the page first, or name a page that exists.`,
        { field: `${file}:definition.after_submit.page_path` },
      );
    }
    rejectNonTarget(file, pages, id, "page_path", path);
    return { ...definition, after_submit: { ...rest, page_resource_id: id } };
  }
  if (pages !== undefined && !pages.truncated && !pages.pathById.has(after.page_resource_id)) {
    throw new SiteAuthoringError(
      "forms.page_not_found",
      `${file}: no page on the site has the resource id '${after.page_resource_id}'. Name the page by its path instead.`,
      { field: `${file}:definition.after_submit.page_resource_id` },
    );
  }
  if (pages !== undefined) rejectNonTarget(file, pages, after.page_resource_id, "page_resource_id", pages.pathById.get(after.page_resource_id));
  return definition;
}

// A form may send visitors only to a page an author created, so this refuses before any write.
function rejectNonTarget(file, pages, id, field, name) {
  if (!pages.notTargetIds?.has(id)) return;
  throw new SiteAuthoringError(
    "forms.page_not_allowed",
    `${file}: '${name ?? id}' is a generated, system, legal, profile or integration page. A form can send visitors only to a page you created. Name another page.`,
    { field: `${file}:definition.after_submit.${field}` },
  );
}

function canonicalField(field) {
  const ordered = {};
  for (const name of FIELD_KEY_ORDER) if (field[name] !== undefined) ordered[name] = field[name];
  // Anything the site returns that this release does not know is kept after
  // the known names rather than dropped, so an older CLI cannot erase a
  // constraint a newer site added.
  for (const name of Object.keys(field).sort()) if (ordered[name] === undefined) ordered[name] = field[name];
  return ordered;
}

/**
 * The form file for a form as the site holds it. Defaults are written out so a
 * pulled file states the retention and sink it is actually running with. `pathById`
 * maps page resource ids to their paths; a page it knows is written as `page_path`,
 * so the same page is always the same bytes whichever spelling the file used.
 */
export function projectFormForWorkspace(form, pathById) {
  const definition = { fields: form.definition.fields.map(canonicalField) };
  // The named field stays only when the form's own fields would not pick it, so a form with one email field
  // is written without it and an explicit file still round-trips as unchanged.
  const { contact_field: named } = form.definition;
  if (named !== undefined && contactFieldId({ fields: definition.fields }) !== named) definition.contact_field = named;
  if (form.definition.submit_label !== undefined) definition.submit_label = form.definition.submit_label;
  if (form.definition.after_submit !== undefined) {
    definition.after_submit = canonicalAfterSubmit(form.definition.after_submit, pathById);
  }
  return {
    key: form.key,
    name: form.name,
    sink: form.sink ?? FORM_DEFAULT_SINK,
    retention_days: form.retention_days ?? FORM_RETENTION_DAYS.default,
    definition,
  };
}
