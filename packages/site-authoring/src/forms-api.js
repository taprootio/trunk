import { listSitePages, sitePath } from "./api.js";
import { HTTP_NOT_FOUND } from "./constants.js";
import { isCanonicalUuid, SiteAuthoringError } from "./errors.js";
import { FORM_DEFAULT_SINK, FORM_SINKS, isFormKey, normalizePagePath } from "./forms-contract.js";
import { ApiError } from "./transport.js";

/**
 * The owner-side forms routes `forms pull` and `forms push` call (TR01061).
 *
 * The wire spells a sink and a status as proto enum names; the workspace file
 * uses the lowercase word. The translation lives here so neither side learns
 * the other's vocabulary. A form's definition travels as JSON text and comes
 * back as canonical JSON text; it is parsed on the way in so the verbs handle
 * one shape.
 */

const SINK_WIRE = Object.freeze({ none: "SITE_FORM_SINK_NONE", newsletter: "SITE_FORM_SINK_NEWSLETTER" });
const STATUS_ARCHIVED_WIRE = "SITE_FORM_STATUS_ARCHIVED";
// The cap is the owner's own forms list, which the site bounds; this is the
// reply-size bound for the largest form a workspace file may describe.
const FORMS_RESPONSE_BYTES = 2 * 1024 * 1024;

function contract(message, field) {
  return new SiteAuthoringError("api.forms_contract", message, { field });
}

function sinkFromWire(value) {
  if (value === undefined || value === "" || value === "SITE_FORM_SINK_UNSPECIFIED") return FORM_DEFAULT_SINK;
  const sink = FORM_SINKS.find((candidate) => SINK_WIRE[candidate] === value);
  if (sink === undefined) throw contract("Taproot returned an unsupported form sink.", "sink");
  return sink;
}

function normalizeForm(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw contract("Taproot returned a form that is not an object.", "form");
  }
  if (!isCanonicalUuid(value.id) || !isFormKey(value.key)) {
    throw contract("Taproot returned a form with no usable id or a key this workspace cannot store.", "form");
  }
  return {
    id: value.id,
    key: value.key,
    name: typeof value.name === "string" ? value.name : "",
    sink: sinkFromWire(value.sink),
    retentionDays: Number.isSafeInteger(value.retentionDays) ? value.retentionDays : undefined,
    archived: value.status === STATUS_ARCHIVED_WIRE,
    currentVersion: Number.isSafeInteger(value.currentVersion) ? value.currentVersion : 0,
  };
}

function normalizeVersion(value) {
  if (value === null || typeof value !== "object" || typeof value.definition !== "string") {
    throw contract("Taproot returned a form with no current version.", "currentVersion");
  }
  let definition;
  try {
    definition = JSON.parse(value.definition);
  } catch {
    throw contract("Taproot returned a form definition that is not JSON.", "definition");
  }
  return {
    version: Number.isSafeInteger(value.version) ? value.version : 0,
    definition,
  };
}

function normalizeFormResponse(value) {
  const form = normalizeForm(value?.form);
  return { form, version: normalizeVersion(value?.currentVersion) };
}

/**
 * The site's pages by path and by resource id, for the one place a form file and the
 * site spell a page differently. `truncated` says the listing hit its bound, so a
 * path that is not here may still exist and an id that is not here is not proof.
 * `notTargetIds` holds the pages a form may not send visitors to.
 */
export async function getPageIndex(client, siteId, options) {
  const { pages, truncated } = await listSitePages(client, siteId, options);
  const idByPath = new Map();
  const pathById = new Map();
  const notTargetIds = new Set();
  for (const page of pages) {
    if (page.resourceId === "") continue;
    const path = normalizePagePath(page.path);
    idByPath.set(path, page.resourceId);
    pathById.set(page.resourceId, path);
    if (!isAfterSubmitTarget(page, path)) notTargetIds.add(page.resourceId);
  }
  return { idByPath, pathById, notTargetIds, truncated };
}

// The site's rule for where a form may send visitors: a page an author creates, the home page included.
// Generated pages, the 404 page, integration-managed pages, legal pages and a profile home are not targets.
const NOT_TARGET_TEMPLATES = new Set([
  "TEMPLATE_TYPE_GENERATED",
  "TEMPLATE_TYPE_INTEGRATION_MANAGED",
  "TEMPLATE_TYPE_LEGAL",
  "TEMPLATE_TYPE_PROFILE_HOME",
]);
function isAfterSubmitTarget(page, path) {
  return !page.isGenerated && !NOT_TARGET_TEMPLATES.has(page.templateType) && path.toLowerCase() !== "/404";
}

/** Every form on the site, archived ones included. */
export async function listSiteForms(client, siteId) {
  const response = await client.request(sitePath(siteId, "forms"), { maximumResponseBytes: FORMS_RESPONSE_BYTES });
  return (Array.isArray(response?.forms) ? response.forms : []).map(normalizeForm);
}

export async function getSiteForm(client, siteId, formId) {
  return normalizeFormResponse(
    await client.request(sitePath(siteId, `forms/${encodeURIComponent(formId)}`), {
      maximumResponseBytes: FORMS_RESPONSE_BYTES,
    }),
  );
}

/** The form with this key and its current version, or undefined when the site has none. */
export async function getSiteFormByKey(client, siteId, key) {
  try {
    return normalizeFormResponse(
      await client.request(sitePath(siteId, `form-keys/${encodeURIComponent(key)}`), {
        maximumResponseBytes: FORMS_RESPONSE_BYTES,
      }),
    );
  } catch (error) {
    if (error instanceof ApiError && error.httpStatus === HTTP_NOT_FOUND) return undefined;
    throw error;
  }
}

export async function createSiteForm(client, siteId, form) {
  return normalizeFormResponse(
    await client.request(sitePath(siteId, "forms"), {
      method: "POST",
      body: {
        key: form.key,
        name: form.name,
        sink: SINK_WIRE[form.sink],
        retentionDays: form.retention_days,
        definition: JSON.stringify(form.definition),
      },
      maximumResponseBytes: FORMS_RESPONSE_BYTES,
    }),
  );
}

/**
 * `expected` is the settings the caller last read; the site refuses the update
 * (field ExpectedSettings) when the form no longer holds them, so a change made
 * by someone else in between is not replaced.
 */
export async function updateSiteFormSettings(client, siteId, formId, form, expected) {
  return normalizeForm(
    await client.request(sitePath(siteId, `forms/${encodeURIComponent(formId)}/settings`), {
      method: "PUT",
      body: {
        name: form.name,
        sink: SINK_WIRE[form.sink],
        retentionDays: form.retention_days,
        ...(expected === undefined
          ? {}
          : {
            expectedName: expected.name,
            expectedSink: SINK_WIRE[expected.sink],
            expectedRetentionDays: expected.retention_days,
          }),
      },
      maximumResponseBytes: FORMS_RESPONSE_BYTES,
    }),
  );
}

/**
 * Appends a version; the site returns the current one when nothing changed.
 * `expectedVersion` is the version the caller last read; the site refuses the
 * save (field ExpectedVersion) when the form has moved past it.
 */
export async function saveSiteFormVersion(client, siteId, formId, form, expectedVersion) {
  return normalizeVersion(
    await client.request(sitePath(siteId, `forms/${encodeURIComponent(formId)}/versions`), {
      method: "POST",
      body: {
        definition: JSON.stringify(form.definition),
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      },
      maximumResponseBytes: FORMS_RESPONSE_BYTES,
    }),
  );
}
