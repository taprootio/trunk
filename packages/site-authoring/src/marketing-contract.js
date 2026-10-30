import campaignRules from "./analytics-campaign.json" with { type: "json" };
import vocabulary from "./analytics-source-vocabulary.json" with { type: "json" };
import linkLabelRules from "./analytics-link-label.json" with { type: "json" };
import { SiteAuthoringError } from "./errors.js";

/**
 * The workspace contract for a site's campaigns and placements (TR01301).
 *
 * Each kind is one JSON file under `marketing/`: a closed object holding a list of records. A record
 * is what an author decides (key, name, and for a campaign a note and two label dates) plus two
 * read-only facts the site reports (`state`, `counted_from`), which a pull writes and a push ignores.
 * The key grammar and the name and note limits come from the shared rule files that the API, the
 * Worker and the app read too; their copies here are written by `scripts/sync-field-validation.mjs`.
 * Records the site has archived are not written: archiving keeps history, so a key is never reused,
 * and a file that names an archived key asks to restore it.
 */

export const MARKETING_DIRECTORY = "marketing";

export const MARKETING_STATE_LIVE = "live";
export const MARKETING_STATE_ARCHIVED = "archived";
/** The words a creator reads for each state, in the app's order. */
export const MARKETING_STATES = Object.freeze([
  MARKETING_STATE_LIVE,
  "publishing",
  "goes_live_with_first_publish",
  "not_in_current_release",
  MARKETING_STATE_ARCHIVED,
]);

const MARKETING_STATE_WIRE = Object.freeze({
  campaigns: Object.freeze({
    SITE_CAMPAIGN_STATE_LIVE: MARKETING_STATE_LIVE,
    SITE_CAMPAIGN_STATE_PUBLISHING: "publishing",
    SITE_CAMPAIGN_STATE_GOES_LIVE_WITH_FIRST_PUBLISH: "goes_live_with_first_publish",
    SITE_CAMPAIGN_STATE_NOT_IN_CURRENT_RELEASE: "not_in_current_release",
    SITE_CAMPAIGN_STATE_ARCHIVED: MARKETING_STATE_ARCHIVED,
  }),
  placements: Object.freeze({
    SITE_LINK_LABEL_STATE_LIVE: MARKETING_STATE_LIVE,
    SITE_LINK_LABEL_STATE_PUBLISHING: "publishing",
    SITE_LINK_LABEL_STATE_GOES_LIVE_WITH_FIRST_PUBLISH: "goes_live_with_first_publish",
    SITE_LINK_LABEL_STATE_NOT_IN_CURRENT_RELEASE: "not_in_current_release",
    SITE_LINK_LABEL_STATE_ARCHIVED: MARKETING_STATE_ARCHIVED,
  }),
});

/**
 * The two kinds. A placement is stored as a link label, so its routes and wire names say so; every word
 * a person reads says placement.
 */
export const MARKETING_KINDS = Object.freeze({
  campaigns: Object.freeze({
    kind: "campaigns",
    noun: "campaign",
    file: `${MARKETING_DIRECTORY}/campaigns.json`,
    listProperty: "campaigns",
    route: "campaigns",
    wireList: "campaigns",
    wireId: "campaignId",
    rules: campaignRules,
    withLabels: true,
  }),
  placements: Object.freeze({
    kind: "placements",
    noun: "placement",
    file: `${MARKETING_DIRECTORY}/placements.json`,
    listProperty: "placements",
    route: "link-labels",
    wireList: "linkLabels",
    wireId: "linkLabelId",
    rules: linkLabelRules,
    withLabels: false,
  }),
});

export const MARKETING_KIND_NAMES = Object.freeze(Object.keys(MARKETING_KINDS));

/**
 * The sources a tracked link can name: the shared vocabulary without `reader`, which the published page's own
 * share action sets. The medium is not chosen; the source decides it.
 */
export const LINK_SOURCES = Object.freeze(vocabulary.sources.filter((source) => source.key !== "reader"));

/** The longest name either kind accepts; the shared rule files give each kind's own. */
function nameMaximum(kind) {
  return MARKETING_KINDS[kind].rules.nameMaxLength;
}

// A placement shares the campaign key grammar (shared/analytics-link-label.json delegates to it).
const KEY_RULES = campaignRules;
const KEY_PATTERN = new RegExp(KEY_RULES.keyPattern, "u");
const LONG_DIGIT_RUN = new RegExp(`[0-9]{${KEY_RULES.maxDigitRun + 1},}`, "u");
const NOTE_MAXIMUM = campaignRules.noteMaxLength;
const FILE_BYTES = 512 * 1024;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

export const MARKETING_LIMITS = Object.freeze({ fileBytes: FILE_BYTES });

export const MARKETING_KEY_RULE = `${KEY_RULES.keyMinLength} to ${KEY_RULES.keyMaxLength} lowercase letters, `
  + `numbers or hyphens, with no more than ${KEY_RULES.maxDigitRun} numbers in a row`;

/** True for a public key: the one grammar campaigns and placements share. */
export function isMarketingKey(value) {
  return typeof value === "string" && KEY_PATTERN.test(value) && !LONG_DIGIT_RUN.test(value);
}

/** The most unarchived records a site can hold of this kind, from the shared rule file. */
export function maximumActive(kind) {
  return MARKETING_KINDS[kind].rules.maxActivePerSite;
}

function maximumTotal(kind) {
  return MARKETING_KINDS[kind].rules.maxTotalPerSite;
}

function invalid(file, message, field) {
  return new SiteAuthoringError("marketing.file_invalid", `${file}: ${message}`, { field: `${file}:${field}` });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A real calendar day written YYYY-MM-DD. */
export function isCalendarDate(value) {
  if (typeof value !== "string") return false;
  const match = DATE.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // Year 0 is not a protobuf timestamp (0001 is the first), so the site could never hold it.
  if (year < 1) return false;
  // setUTCFullYear, not Date.UTC, which maps years 0 to 99 to 1900 to 1999 and would refuse a typo year the site keeps.
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

// The site trims with .NET's whitespace set, which differs from JavaScript's (U+FEFF is not trimmed there, U+0085 is),
// so a name the site stored with an edge character must pass here exactly when the site would keep it.
const DOTNET_WHITESPACE = "\\t-\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const DOTNET_EDGE_WHITESPACE = new RegExp(`^[${DOTNET_WHITESPACE}]|[${DOTNET_WHITESPACE}]$`, "u");

/** NUL and lone surrogates cannot be stored by the site. */
function hasUnstorableCharacters(text) {
  return /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);
}

function checkText(file, path, value, maximum, { allowEmpty = false } = {}) {
  if (typeof value !== "string") throw invalid(file, "must be a string.", path);
  if (DOTNET_EDGE_WHITESPACE.test(value)) throw invalid(file, "must have no space at either end.", path);
  if (!allowEmpty && value.length === 0) throw invalid(file, "must not be empty.", path);
  if (value.length > maximum) throw invalid(file, `must be at most ${maximum} characters.`, path);
  // Only what the site cannot store is refused (NUL and lone surrogates): the site accepts any other text in a name
  // or note, and a pull writes it back unchanged, so refusing more would fail an untouched pulled workspace.
  if (hasUnstorableCharacters(value)) {
    throw invalid(file, "must not contain NUL or an unpaired surrogate.", path);
  }
}

const RECORD_KEYS = Object.freeze({
  campaigns: ["key", "name", "note", "starts_on", "ends_on", "state", "counted_from"],
  placements: ["key", "name", "state", "counted_from"],
});
const READ_ONLY_KEYS = new Set(["state", "counted_from"]);

/**
 * Validates one parsed marketing file and returns its records as the author decides them: key, name,
 * and for a campaign note, starts_on and ends_on (absent when unset). The read-only state and counted_from
 * are checked for shape and kept on the record, so `link build` can read the state a pull wrote; a push ignores them.
 * `archived` as a state is refused: archiving is a push that omits the
 * key under --archive, never a word in the file.
 */
export function validateMarketingDocument(kind, document_) {
  const { file, listProperty } = MARKETING_KINDS[kind];
  if (!isPlainObject(document_)) throw invalid(file, "must be a JSON object.", "$");
  for (const property of Object.keys(document_)) {
    if (property !== listProperty) {
      throw invalid(file, `'${property}' is not a property of this file; it holds only '${listProperty}'.`, property);
    }
  }
  const list = document_[listProperty];
  if (!Array.isArray(list)) throw invalid(file, `'${listProperty}' must be an array.`, listProperty);
  if (list.length > maximumTotal(kind)) {
    throw invalid(file, `lists more than the ${maximumTotal(kind)} records a site can hold.`, listProperty);
  }
  const seen = new Set();
  return list.map((record, index) => {
    const at = `${listProperty}[${index}]`;
    if (!isPlainObject(record)) throw invalid(file, "must be an object.", at);
    for (const property of Object.keys(record)) {
      if (!RECORD_KEYS[kind].includes(property)) {
        throw invalid(file, `'${property}' is not a ${MARKETING_KINDS[kind].noun} property.`, `${at}.${property}`);
      }
    }
    if (!isMarketingKey(record.key)) {
      throw invalid(file, `key must be ${MARKETING_KEY_RULE}.`, `${at}.key`);
    }
    if (seen.has(record.key)) throw invalid(file, `names the key '${record.key}' more than once.`, `${at}.key`);
    seen.add(record.key);
    checkText(file, `${at}.name`, record.name, nameMaximum(kind));
    const result = { key: record.key, name: record.name };
    if (MARKETING_KINDS[kind].withLabels) {
      if (record.note !== undefined) {
        checkText(file, `${at}.note`, record.note, NOTE_MAXIMUM, { allowEmpty: true });
        if (record.note !== "") result.note = record.note;
      }
      for (const field of ["starts_on", "ends_on"]) {
        if (record[field] === undefined) continue;
        if (!isCalendarDate(record[field])) throw invalid(file, "must be a day written YYYY-MM-DD.", `${at}.${field}`);
        result[field] = record[field];
      }
      if (result.starts_on !== undefined && result.ends_on !== undefined && result.ends_on < result.starts_on) {
        throw invalid(file, "ends_on cannot be before starts_on.", `${at}.ends_on`);
      }
    }
    for (const field of READ_ONLY_KEYS) {
      if (record[field] === undefined) continue;
      // Kept on the validated record so `link build` can read the state a pull recorded; a push ignores it.
      result[field] = record[field];
      if (field === "state" && !MARKETING_STATES.includes(record.state)) {
        throw invalid(file, `state is read-only and one of ${MARKETING_STATES.join(", ")}.`, `${at}.state`);
      }
      if (field === "state" && record.state === MARKETING_STATE_ARCHIVED) {
        throw invalid(
          file,
          "a record cannot be archived by writing its state. Remove it from the file and push with --archive.",
          `${at}.state`,
        );
      }
      if (field === "counted_from" && !isCalendarDate(record.counted_from)) {
        throw invalid(file, "counted_from is read-only and a day written YYYY-MM-DD.", `${at}.counted_from`);
      }
    }
    return result;
  });
}

/**
 * The record as a file writes it, in one canonical key order, so the same record is always the same
 * bytes: what the author decides, then what the site reports.
 */
export function projectMarketingRecord(kind, record) {
  const projected = { key: record.key, name: record.name };
  if (MARKETING_KINDS[kind].withLabels) {
    if (record.note !== undefined && record.note !== "") projected.note = record.note;
    if (record.starts_on !== undefined) projected.starts_on = record.starts_on;
    if (record.ends_on !== undefined) projected.ends_on = record.ends_on;
  }
  if (record.state !== undefined) projected.state = record.state;
  if (record.counted_from !== undefined) projected.counted_from = record.counted_from;
  return projected;
}

/** The file's whole document for a list of records, ordered by key. */
export function projectMarketingDocument(kind, records) {
  return {
    [MARKETING_KINDS[kind].listProperty]: [...records]
      .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
      .map((record) => projectMarketingRecord(kind, record)),
  };
}

/** The state word a creator reads for a wire state of this kind, or undefined for one this CLI does not know. */
export function marketingStateFromWire(kind, value) {
  if (value === undefined || value === "") return undefined;
  return MARKETING_STATE_WIRE[kind][value];
}

/** What a creator loses until a picked campaign or placement is live, in the link builder. */
export const BUILDER_NOT_LIVE_CONSEQUENCE = "Until it is live, page views count under the source only.";

/**
 * One sentence for a campaign or placement that is not live yet, or empty when it is live. The wording
 * follows the record's state, because "publishing" is only true while its release runs. The words are the
 * Marketing link builder's; a test in the app keeps them equal.
 */
export function notLiveNote(name, state) {
  switch (state) {
    case "publishing":
      return `${name} is publishing. ${BUILDER_NOT_LIVE_CONSEQUENCE}`;
    case "goes_live_with_first_publish":
      return `${name} goes live with your first publish. ${BUILDER_NOT_LIVE_CONSEQUENCE}`;
    case "not_in_current_release":
      return `${name} is not in the current release; it goes live with your next publish. ${BUILDER_NOT_LIVE_CONSEQUENCE}`;
    default:
      return "";
  }
}
