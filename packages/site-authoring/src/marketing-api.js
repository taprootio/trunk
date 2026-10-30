import { sitePath } from "./api.js";
import { REFUSAL_UNCLASSIFIED } from "./constants.js";
import { isCanonicalUuid, SiteAuthoringError } from "./errors.js";
import {
  isCalendarDate,
  isMarketingKey,
  MARKETING_KINDS,
  MARKETING_STATE_ARCHIVED,
  marketingStateFromWire,
} from "./marketing-contract.js";
import { ApiError } from "./transport.js";

/**
 * The owner-side campaign and placement routes `marketing pull` and `marketing push` call (TR01301).
 *
 * The wire spells a state as a proto enum name and a day as midnight UTC; the workspace file uses a lowercase
 * word and a plain day. The translation lives here so neither side learns the other's vocabulary. A placement
 * is stored as a link label, so its routes and wire names say so.
 */

// A site holds at most a few hundred records of a kind, archived ones included; this bounds the reply size.
const MARKETING_RESPONSE_BYTES = 2 * 1024 * 1024;
// gRPC FailedPrecondition, which the transcoder carries as the `code` of the error body.
const GRPC_FAILED_PRECONDITION = 9;
const MIDNIGHT_UTC = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?Z$/u;

function contract(message, field) {
  return new SiteAuthoringError("api.marketing_contract", message, { field });
}

/** A wire timestamp that is midnight UTC as the day it names, or undefined when it is absent. */
function dayFromWire(value, field) {
  if (value === undefined || value === null || value === "") return undefined;
  const match = typeof value === "string" ? MIDNIGHT_UTC.exec(value) : null;
  if (match === null || !isCalendarDate(match[1])) {
    throw contract("Taproot returned a day this workspace cannot store.", field);
  }
  return match[1];
}

/** The UTC day an instant falls on: when a key first went live, page views under it are counted from that day. */
function dayOfInstant(value, field) {
  if (value === undefined || value === null || value === "") return undefined;
  const day = typeof value === "string" ? /^(\d{4}-\d{2}-\d{2})T/u.exec(value)?.[1] : undefined;
  if (day === undefined || !isCalendarDate(day)) throw contract("Taproot returned a time this workspace cannot store.", field);
  return day;
}

function dayToWire(day) {
  return day === undefined ? undefined : `${day}T00:00:00Z`;
}

function normalizeRecord(kind, value) {
  const { noun } = MARKETING_KINDS[kind];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw contract(`Taproot returned a ${noun} that is not an object.`, noun);
  }
  if (!isCanonicalUuid(value.id) || !isMarketingKey(value.key)) {
    throw contract(`Taproot returned a ${noun} with no usable id or a key this workspace cannot store.`, noun);
  }
  const state = marketingStateFromWire(kind, value.state);
  if (state === undefined) throw contract(`Taproot returned a ${noun} with a state this CLI does not know.`, "state");
  const record = {
    id: value.id,
    key: value.key,
    name: typeof value.name === "string" ? value.name : "",
    state,
    archived: state === MARKETING_STATE_ARCHIVED || (value.archivedAt !== undefined && value.archivedAt !== null),
  };
  const countedFrom = dayOfInstant(value.releasedAt, "releasedAt");
  if (countedFrom !== undefined) record.counted_from = countedFrom;
  if (MARKETING_KINDS[kind].withLabels) {
    if (typeof value.note === "string" && value.note !== "") record.note = value.note;
    const startsOn = dayFromWire(value.startsOn, "startsOn");
    const endsOn = dayFromWire(value.endsOn, "endsOn");
    if (startsOn !== undefined) record.starts_on = startsOn;
    if (endsOn !== undefined) record.ends_on = endsOn;
  }
  return record;
}

/** The fields an author decides, as the body of a create or an update. */
function writableBody(kind, record) {
  return {
    name: record.name,
    ...(MARKETING_KINDS[kind].withLabels
      ? { note: record.note ?? "", startsOn: dayToWire(record.starts_on), endsOn: dayToWire(record.ends_on) }
      : {}),
  };
}

/** Every record of this kind on the site, archived ones included, and whether the caller may change them. */
export async function listMarketingRecords(client, siteId, kind) {
  const { route, wireList, noun } = MARKETING_KINDS[kind];
  let response;
  try {
    response = await client.request(sitePath(siteId, route), { maximumResponseBytes: MARKETING_RESPONSE_BYTES });
  } catch (error) {
    // The site refuses with a precondition when it is not a Standard site or its licence leaves analytics out. The
    // transport keeps only its own words for a refusal that names no field, so this says what both cases mean.
    if (error instanceof ApiError && error.grpcCode === GRPC_FAILED_PRECONDITION && error.fields.length === 0) {
      throw new SiteAuthoringError(
        "marketing.unavailable",
        `This site cannot list ${noun}s: they need a Standard site on a licence that includes analytics.`,
        { status: error.status },
      );
    }
    throw error;
  }
  const list = response?.[wireList];
  if (list !== undefined && !Array.isArray(list)) {
    throw contract(`Taproot returned a ${MARKETING_KINDS[kind].noun} list that is not an array.`, wireList);
  }
  return {
    records: (list ?? []).map((value) => normalizeRecord(kind, value)),
    canManage: response?.canManage === true,
    maxActive: Number.isSafeInteger(response?.maxActive) ? response.maxActive : undefined,
  };
}

/**
 * Makes a record. `id` is chosen by the caller, which the site uses to return the record a repeated request made.
 * The CLI sends a create once; a lost answer is settled by the next push finding the record already as the file
 * asks.
 */
export async function createMarketingRecord(client, siteId, kind, id, record) {
  const { route, wireId } = MARKETING_KINDS[kind];
  return normalizeRecord(
    kind,
    await client.request(sitePath(siteId, route), {
      method: "POST",
      body: { [wireId]: id, key: record.key, ...writableBody(kind, record) },
      maximumResponseBytes: MARKETING_RESPONSE_BYTES,
    }),
  );
}

/** Changes a record's private labels. The key never changes. */
export async function updateMarketingRecord(client, siteId, kind, id, record) {
  const { route } = MARKETING_KINDS[kind];
  return normalizeRecord(
    kind,
    await client.request(sitePath(siteId, `${route}/${encodeURIComponent(id)}`), {
      method: "PUT",
      body: writableBody(kind, record),
      maximumResponseBytes: MARKETING_RESPONSE_BYTES,
    }),
  );
}

/** Archives or restores a record. Both are idempotent on the site. */
export async function setMarketingRecordArchived(client, siteId, kind, id, archived) {
  const { route } = MARKETING_KINDS[kind];
  return normalizeRecord(
    kind,
    await client.request(sitePath(siteId, `${route}/${encodeURIComponent(id)}/${archived ? "archive" : "restore"}`), {
      method: "POST",
      body: {},
      maximumResponseBytes: MARKETING_RESPONSE_BYTES,
    }),
  );
}

/**
 * Carries the site's own words for a refused record. A key outside the grammar, a key an archived record still
 * holds, and a quota all arrive as a violated field with a description that names the remedy ("Archive one to
 * make room"); the default message would say only which field. A refusal that means something else (a missing
 * capability, a paused platform, a rejected credential) keeps its own classification.
 */
export function withSiteWording(error, kind, key) {
  if (!(error instanceof ApiError) || error.refusalKind() !== REFUSAL_UNCLASSIFIED) return error;
  const [, description] = [...error.violationDescriptions][0] ?? [];
  if (description === undefined) return error;
  const { file } = MARKETING_KINDS[kind];
  return new SiteAuthoringError("marketing.refused", `${file}: '${key}': ${description}`, {
    field: `${file}:${key}`,
    status: error.status,
  });
}
