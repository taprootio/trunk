// Generated from shared/field-validation.ts by scripts/sync-field-validation.mjs. Do not edit.
/**
 * Field definitions and submission validation for Taproot forms (TR01084).
 *
 * The definition is the one owner of the rules. This file is the browser
 * interpretation; the API carries a second interpretation in C#, and both must
 * pass `shared/field-validation-corpus.json`. It returns stable error codes and
 * never wording: the browser owns the words shown to a visitor or an author.
 *
 * It is pure and dependency-free. It uses no regular expressions, because
 * JavaScript and .NET disagree at the edges of their engines, and it measures
 * lengths in UTF-16 code units so `string.length` here and `string.Length` in
 * .NET agree. Keep `shared/field-schema.json` in step with the constants below;
 * a test compares them.
 *
 * The generator's client and the published site-authoring package cannot import
 * this file, so `node scripts/sync-field-validation.mjs` writes their copies;
 * edit only this file and re-run it.
 */
export const FIELD_TYPES = [
    "text",
    "long_text",
    "email",
    "tel",
    "url",
    "number",
    "date",
    "single_choice",
    "multi_choice",
    "checkbox",
    "consent",
];
export const CONSTRAINT_NAMES = [
    "required",
    "min_length",
    "max_length",
    "min",
    "max",
    "choices",
    "format",
];
/** The constraints each type accepts. Anything else is `unknown_constraint`. */
export const CONSTRAINTS_BY_TYPE = {
    text: ["required", "min_length", "max_length", "format"],
    long_text: ["required", "min_length", "max_length"],
    email: ["required", "max_length"],
    tel: ["required", "max_length"],
    url: ["required", "max_length"],
    number: ["required", "min", "max", "format"],
    date: ["required", "min", "max"],
    single_choice: ["required", "choices"],
    multi_choice: ["required", "choices", "min", "max"],
    checkbox: ["required"],
    // Consent is always required to be true; it takes no constraints.
    consent: [],
};
/** The closed list of `format` values, by the type that accepts them. */
export const FORMATS_BY_TYPE = {
    text: ["digits", "alphanumeric"],
    number: ["integer"],
};
export const MAX_FIELDS = 30;
export const MAX_SUBMISSION_BYTES = 16 * 1024;
export const MAX_LABEL_LENGTH = 200;
/** A consent field's label is the agreement the visitor accepts, so it may run to a short paragraph. */
export const MAX_CONSENT_LABEL_LENGTH = 1000;
/** Helper text under a field; two short sentences, the same ceiling as a label. */
export const MAX_HINT_LENGTH = 200;
/** The text on the submit button; one short line, so it fits a button on a phone. */
export const MAX_SUBMIT_LABEL_LENGTH = 40;
/** The confirmation shown in place of the form: a short paragraph, longer than a hint and shorter than a consent. */
export const MAX_AFTER_SUBMIT_MESSAGE_LENGTH = 500;
export const MAX_ID_LENGTH = 40;
export const MAX_CHOICES = 50;
export const MAX_CHOICE_LENGTH = 100;
/** The longest any single-line field may be; `max_length` can only lower it. */
export const MAX_SHORT_TEXT_LENGTH = 500;
export const MAX_LONG_TEXT_LENGTH = 5000;
/** The dates a relative date bound can start from, in the site's time zone. A closed list: no expressions. */
export const DATE_ANCHORS = [
    "today",
    "start_of_month",
    "end_of_month",
    "start_of_next_month",
    "end_of_next_month",
];
/** A year either side of the anchor, a leap year included; anything further out is a fixed date. */
export const MAX_DATE_OFFSET_DAYS = 366;
/**
 * How far back a relative minimum reaches when a submission arrives, so a
 * visitor who loaded the page before midnight and submits after it is not
 * refused for a date the page offered. The maximum is never loosened.
 */
export const RELATIVE_BOUND_GRACE_DAYS = 1;
/**
 * The id of the field whose value is the visitor's contact address: the named
 * `contact_field`, or the form's only email field, or none. The one rule every
 * reader of a definition uses; a validated definition is expected.
 */
export function contactFieldId(definition) {
    if (definition.contact_field !== undefined)
        return definition.contact_field;
    const emails = definition.fields.filter((field) => field.type === "email");
    return emails.length === 1 ? emails[0].id : undefined;
}
const DEFINITION_KEYS = ["fields", "contact_field", "submit_label", "after_submit"];
const BASE_FIELD_KEYS = ["id", "type", "label", "hint"];
const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isInteger = (value) => typeof value === "number" && Number.isInteger(value);
/** Exactly `from` and, optionally, a whole `offset_days` within a year either way. */
export function isRelativeDateBound(value) {
    if (!isPlainObject(value))
        return false;
    if (Object.keys(value).some((key) => key !== "from" && key !== "offset_days"))
        return false;
    if (typeof value.from !== "string" || !DATE_ANCHORS.includes(value.from))
        return false;
    return !("offset_days" in value)
        || (isInteger(value.offset_days) && Math.abs(value.offset_days) <= MAX_DATE_OFFSET_DAYS);
}
const isDigit = (c) => c >= "0" && c <= "9";
const isLowerAscii = (c) => c >= "a" && c <= "z";
const isAlnumAscii = (c) => isDigit(c) || isLowerAscii(c) || (c >= "A" && c <= "Z");
const allChars = (value, test) => {
    for (let i = 0; i < value.length; i++) {
        if (!test(value[i]))
            return false;
    }
    return value.length > 0;
};
/** Keys by UTF-16 code unit, so error order does not depend on the JSON engine's key order. */
const sortedKeys = (value) => Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const encoder = new TextEncoder();
const utf8Length = (value) => encoder.encode(value).length;
/** Only these four characters are ignored when deciding a value is empty. */
function isBlank(value) {
    for (let i = 0; i < value.length; i++) {
        const c = value[i];
        if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r")
            return false;
    }
    return true;
}
function isValidId(id) {
    if (id.length === 0 || id.length > MAX_ID_LENGTH || !isLowerAscii(id[0]))
        return false;
    return allChars(id, (c) => isLowerAscii(c) || isDigit(c) || c === "_");
}
/** A lowercase `8-4-4-4-12` hexadecimal id, the one spelling a stored resource id has. */
export function isResourceId(value) {
    if (value.length !== 36)
        return false;
    for (let i = 0; i < 36; i++) {
        const c = value[i];
        if (i === 8 || i === 13 || i === 18 || i === 23) {
            if (c !== "-")
                return false;
        }
        else if (!isDigit(c) && !(c >= "a" && c <= "f"))
            return false;
    }
    return true;
}
/** A real calendar date written `YYYY-MM-DD`, years 0001 to 9999. */
export function isIsoDate(value) {
    if (value.length !== 10 || value[4] !== "-" || value[7] !== "-")
        return false;
    const digits = value.slice(0, 4) + value.slice(5, 7) + value.slice(8);
    if (!allChars(digits, isDigit))
        return false;
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8));
    if (year < 1 || month < 1 || month > 12 || day < 1)
        return false;
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    return day <= days;
}
const daysInMonth = (year, month) => [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
/** Days since 1970-01-01 of a proleptic Gregorian date, by Howard Hinnant's civil-days algorithm. */
function daysFromCivil(year, month, day) {
    const y = month <= 2 ? year - 1 : year;
    const era = Math.floor(y / 400);
    const yoe = y - era * 400;
    const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
}
function civilFromDays(days) {
    const z = days + 719468;
    const era = Math.floor(z / 146097);
    const doe = z - era * 146097;
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const month = mp < 10 ? mp + 3 : mp - 9;
    return [yoe + era * 400 + (month <= 2 ? 1 : 0), month, day];
}
const FIRST_DAY = daysFromCivil(1, 1, 1);
const LAST_DAY = daysFromCivil(9999, 12, 31);
const pad = (value, width) => String(value).padStart(width, "0");
/** The calendar date written `YYYY-MM-DD`; a day outside years 0001 to 9999 stops at the nearer end. */
function isoFromDays(days) {
    const [year, month, day] = civilFromDays(Math.min(Math.max(days, FIRST_DAY), LAST_DAY));
    return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}
/**
 * The fixed date a bound stands for on a given calendar date. A fixed bound is
 * itself. A relative bound is measured from `today`, which the caller resolves
 * in the site's time zone and passes in, so no validator reads a clock.
 * `graceDays` moves a relative bound's starting date back, and a fixed bound
 * ignores it. `today` must be an ISO date.
 */
export function resolveDateBound(bound, today, graceDays = 0) {
    if (typeof bound === "string")
        return bound;
    if (!isIsoDate(today))
        throw new Error("today must be an ISO date");
    const start = daysFromCivil(Number(today.slice(0, 4)), Number(today.slice(5, 7)), Number(today.slice(8))) - graceDays;
    const [year, month, day] = civilFromDays(Math.min(Math.max(start, FIRST_DAY), LAST_DAY));
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    let anchor;
    switch (bound.from) {
        case "today":
            anchor = daysFromCivil(year, month, day);
            break;
        case "start_of_month":
            anchor = daysFromCivil(year, month, 1);
            break;
        case "end_of_month":
            anchor = daysFromCivil(year, month, daysInMonth(year, month));
            break;
        case "start_of_next_month":
            anchor = nextYear > 9999 ? LAST_DAY : daysFromCivil(nextYear, nextMonth, 1);
            break;
        default:
            anchor = nextYear > 9999 ? LAST_DAY : daysFromCivil(nextYear, nextMonth, daysInMonth(nextYear, nextMonth));
    }
    return isoFromDays(anchor + (bound.offset_days ?? 0));
}
/**
 * The calendar date at an instant in an IANA time zone. It is the one place a
 * zone becomes a date, for the page and the tests; the server does the same
 * with .NET's zone database. An id the browser does not know falls back to UTC,
 * the setting's default, and the server stays authoritative.
 */
export function todayInZone(timeZone, now = new Date()) {
    const read = (zone) => {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: zone,
            year: "numeric",
            month: "numeric",
            day: "numeric",
        })
            .formatToParts(now);
        const part = (type) => Number(parts.find((candidate) => candidate.type === type)?.value);
        return `${pad(part("year"), 4)}-${pad(part("month"), 2)}-${pad(part("day"), 2)}`;
    };
    try {
        return read(timeZone);
    }
    catch {
        return read("UTC");
    }
}
/** ASCII DNS labels; internationalized hosts must arrive as punycode. */
function isValidHost(host) {
    if (host.length === 0 || host.length > 253)
        return false;
    const labels = host.split(".");
    if (labels.length < 2)
        return false;
    return labels.every((label) => label.length >= 1 && label.length <= 63 && label[0] !== "-" && label[label.length - 1] !== "-"
        && allChars(label, (c) => isAlnumAscii(c) || c === "-"));
}
/** The shortest value each format check accepts: `a@b.c`, seven digits and `http://a.b`. */
const SHORTEST_VALID_LENGTH = { email: 5, tel: 7, url: 10 };
const EMAIL_LOCAL_CHARS = "!#$%&'*+/=?^_`{|}~-";
export function isValidEmail(value) {
    if (value.length > 254)
        return false;
    const at = value.indexOf("@");
    if (at < 1 || at !== value.lastIndexOf("@"))
        return false;
    const local = value.slice(0, at);
    const domain = value.slice(at + 1);
    if (local.length > 64 || local[0] === "." || local[local.length - 1] === "." || local.includes("..")) {
        return false;
    }
    if (!allChars(local, (c) => isAlnumAscii(c) || c === "." || EMAIL_LOCAL_CHARS.includes(c)))
        return false;
    return isValidHost(domain);
}
/** Digits with optional separators; a `+` may only lead. 7 to 15 digits. */
export function isValidTel(value) {
    let digits = 0;
    for (let i = 0; i < value.length; i++) {
        const c = value[i];
        if (isDigit(c))
            digits++;
        else if (c === "+") {
            if (i !== 0)
                return false;
        }
        else if (c !== " " && c !== "-" && c !== "." && c !== "(" && c !== ")")
            return false;
    }
    return digits >= 7 && digits <= 15;
}
/** `http` or `https` with a dotted ASCII host, an optional port, no userinfo. */
export function isValidUrl(value) {
    const lower = value.toLowerCase();
    let rest;
    if (lower.startsWith("https://"))
        rest = value.slice(8);
    else if (lower.startsWith("http://"))
        rest = value.slice(7);
    else
        return false;
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code <= 0x20 || code === 0x7f)
            return false;
    }
    let end = rest.length;
    for (const stop of ["/", "?", "#"]) {
        const index = rest.indexOf(stop);
        if (index !== -1 && index < end)
            end = index;
    }
    const authority = rest.slice(0, end);
    if (authority.includes("@"))
        return false;
    const colon = authority.indexOf(":");
    const host = colon === -1 ? authority : authority.slice(0, colon);
    if (colon !== -1) {
        const port = authority.slice(colon + 1);
        if (!allChars(port, isDigit) || port.length > 5 || Number(port) < 1 || Number(port) > 65535)
            return false;
    }
    return isValidHost(host);
}
/**
 * Checks a field definition list and returns stable codes with JSON-path-like
 * locations. A constraint written as JSON `null` counts as present and wrong.
 * A number is an integer when it has no fractional part, however it is written.
 */
export function validateDefinition(definition) {
    const errors = [];
    if (!isPlainObject(definition))
        return [{ path: "", code: "invalid_definition" }];
    for (const key of sortedKeys(definition)) {
        if (!DEFINITION_KEYS.includes(key))
            errors.push({ path: key, code: "unknown_property" });
    }
    const fields = definition.fields;
    if (!Array.isArray(fields) || fields.length === 0) {
        errors.push({ path: "fields", code: "invalid_fields" });
        return errors;
    }
    if (fields.length > MAX_FIELDS) {
        errors.push({ path: "fields", code: "too_many_fields" });
        return errors;
    }
    const seen = new Set();
    const types = new Map();
    fields.forEach((field, index) => {
        const at = `fields[${index}]`;
        if (!isPlainObject(field)) {
            errors.push({ path: at, code: "invalid_field" });
            return;
        }
        const id = field.id;
        if (typeof id !== "string" || !isValidId(id))
            errors.push({ path: `${at}.id`, code: "invalid_id" });
        else if (seen.has(id))
            errors.push({ path: `${at}.id`, code: "duplicate_id" });
        else {
            seen.add(id);
            types.set(id, field.type);
        }
        const type = field.type;
        if (typeof type !== "string" || !FIELD_TYPES.includes(type)) {
            errors.push({ path: `${at}.type`, code: "unknown_type" });
            return;
        }
        const label = field.label;
        const maxLabelLength = type === "consent" ? MAX_CONSENT_LABEL_LENGTH : MAX_LABEL_LENGTH;
        if (typeof label !== "string" || isBlank(label) || label.length > maxLabelLength) {
            errors.push({ path: `${at}.label`, code: "invalid_label" });
        }
        const hint = field.hint;
        if (hint !== undefined && (typeof hint !== "string" || isBlank(hint) || hint.length > MAX_HINT_LENGTH)) {
            errors.push({ path: `${at}.hint`, code: "invalid_hint" });
        }
        const allowed = CONSTRAINTS_BY_TYPE[type];
        for (const key of sortedKeys(field)) {
            if (BASE_FIELD_KEYS.includes(key))
                continue;
            if (!CONSTRAINT_NAMES.includes(key)) {
                errors.push({ path: `${at}.${key}`, code: "unknown_property" });
            }
            else if (!allowed.includes(key)) {
                errors.push({ path: `${at}.${key}`, code: "unknown_constraint" });
            }
        }
        validateConstraints(field, type, at, errors);
    });
    const contact = definition.contact_field;
    if (contact !== undefined && (typeof contact !== "string" || types.get(contact) !== "email")) {
        errors.push({ path: "contact_field", code: "invalid_contact_field" });
    }
    else if (contact === undefined && [...types.values()].filter((type) => type === "email").length > 1) {
        errors.push({ path: "contact_field", code: "contact_field_required" });
    }
    validateFormSettings(definition, errors);
    if (errors.length === 0 && minimumContentBytes(fields) > MAX_SUBMISSION_BYTES) {
        errors.push({ path: "fields", code: "unsatisfiable_constraint" });
    }
    return errors;
}
/** The button text and the after-submit choice, which sit beside the fields in a definition. */
function validateFormSettings(definition, errors) {
    const label = definition.submit_label;
    if (label !== undefined && (typeof label !== "string" || isBlank(label) || label.length > MAX_SUBMIT_LABEL_LENGTH)) {
        errors.push({ path: "submit_label", code: "invalid_submit_label" });
    }
    const after = definition.after_submit;
    if (after === undefined)
        return;
    if (!isPlainObject(after) || (after.show !== "message" && after.show !== "page")) {
        errors.push({ path: "after_submit", code: "invalid_after_submit" });
        return;
    }
    const allowed = after.show === "message" ? ["show", "message"] : ["show", "page_resource_id"];
    for (const key of sortedKeys(after)) {
        if (!allowed.includes(key))
            errors.push({ path: `after_submit.${key}`, code: "unknown_property" });
    }
    if (after.show === "message") {
        const message = after.message;
        if (message !== undefined
            && (typeof message !== "string" || isBlank(message) || message.length > MAX_AFTER_SUBMIT_MESSAGE_LENGTH)) {
            errors.push({ path: "after_submit.message", code: "invalid_after_submit_message" });
        }
    }
    else if (typeof after.page_resource_id !== "string" || !isResourceId(after.page_resource_id)) {
        errors.push({ path: "after_submit.page_resource_id", code: "invalid_after_submit_page" });
    }
}
/** The fewest content bytes any valid submission carries: required keys plus their shortest values. */
function minimumContentBytes(fields) {
    let total = 0;
    for (const field of fields) {
        if (field.type !== "consent" && field.required !== true)
            continue;
        total += utf8Length(field.id);
        switch (field.type) {
            case "text":
            case "long_text":
                total += Math.max(field.min_length ?? 0, 1);
                break;
            case "email":
            case "tel":
            case "url":
                total += SHORTEST_VALID_LENGTH[field.type] ?? 0;
                break;
            case "date":
                total += 10;
                break;
            case "single_choice":
                total += Math.min(...(field.choices ?? []).map(utf8Length));
                break;
            case "multi_choice": {
                const sizes = (field.choices ?? []).map(utf8Length).sort((a, b) => a - b);
                const count = Math.max(typeof field.min === "number" ? field.min : 0, 1);
                total += sizes.slice(0, count).reduce((sum, size) => sum + size, 0);
                break;
            }
            default:
                break;
        }
    }
    return total;
}
function validateConstraints(field, type, at, errors) {
    const allowed = CONSTRAINTS_BY_TYPE[type];
    const bad = (name) => errors.push({ path: `${at}.${name}`, code: "invalid_constraint" });
    const has = (name) => allowed.includes(name) && field[name] !== undefined;
    if (has("required") && typeof field.required !== "boolean")
        bad("required");
    const ceiling = type === "long_text" ? MAX_LONG_TEXT_LENGTH : MAX_SHORT_TEXT_LENGTH;
    for (const name of ["min_length", "max_length"]) {
        if (has(name)) {
            const value = field[name];
            if (!isInteger(value) || value < (name === "min_length" ? 0 : 1) || value > ceiling)
                bad(name);
        }
    }
    if (has("min_length") && has("max_length") && isInteger(field.min_length) && isInteger(field.max_length)
        && field.min_length > field.max_length) {
        errors.push({ path: `${at}.min_length`, code: "min_exceeds_max" });
    }
    const shortest = SHORTEST_VALID_LENGTH[type];
    if (shortest !== undefined && has("max_length") && isInteger(field.max_length) && field.max_length >= 1
        && field.max_length < shortest) {
        errors.push({ path: `${at}.max_length`, code: "unsatisfiable_constraint" });
    }
    if (type === "number" || type === "date" || type === "multi_choice") {
        let bothValid = has("min") && has("max");
        for (const name of ["min", "max"]) {
            if (!has(name))
                continue;
            const value = field[name];
            const ok = type === "number"
                ? typeof value === "number" && Number.isFinite(value)
                : type === "date"
                    ? (typeof value === "string" && isIsoDate(value)) || isRelativeDateBound(value)
                    : isInteger(value) && value >= 0 && value <= MAX_CHOICES;
            if (!ok) {
                bad(name);
                bothValid = false;
            }
        }
        const { min, max } = field;
        if (bothValid
            && ((typeof min === "number" && typeof max === "number" && min > max)
                || (typeof min === "string" && typeof max === "string" && min > max)
                || (isRelativeDateBound(min) && isRelativeDateBound(max) && min.from === max.from
                    && (min.offset_days ?? 0) > (max.offset_days ?? 0)))) {
            errors.push({ path: `${at}.min`, code: "min_exceeds_max" });
        }
        else if (bothValid && type === "number" && field.format === "integer" && typeof min === "number" && typeof max === "number"
            && Math.ceil(min) > Math.floor(max)) {
            errors.push({ path: `${at}.min`, code: "unsatisfiable_constraint" });
        }
    }
    if (type === "single_choice" || type === "multi_choice") {
        const choices = field.choices;
        if (choices === undefined)
            errors.push({ path: `${at}.choices`, code: "choices_required" });
        else if (!Array.isArray(choices) || choices.length < 1 || choices.length > MAX_CHOICES
            || !choices.every((c) => typeof c === "string" && c.length >= 1 && c.length <= MAX_CHOICE_LENGTH && !isBlank(c))
            || new Set(choices).size !== choices.length)
            bad("choices");
        else if (type === "multi_choice") {
            // A bound no submission can meet would make the form unsubmittable.
            const { min, max } = field;
            if (isInteger(min) && min >= 0 && min <= MAX_CHOICES && min > choices.length) {
                errors.push({ path: `${at}.min`, code: "unsatisfiable_constraint" });
            }
            if (field.required === true && max === 0) {
                errors.push({ path: `${at}.max`, code: "unsatisfiable_constraint" });
            }
        }
    }
    if (has("format")) {
        const formats = FORMATS_BY_TYPE[type] ?? [];
        if (typeof field.format !== "string" || !formats.includes(field.format)) {
            errors.push({ path: `${at}.format`, code: "unknown_format" });
        }
    }
}
/**
 * A blank value counts as absent, so the API must store it as null rather than
 * as submitted. Content size is the UTF-8 bytes of every key plus every string value and
 * string array item; numbers, booleans and other array items count as zero.
 * Validates one submission against a definition that already passed
 * `validateDefinition`. At most one error per field. Order: whole-submission
 * errors (field ""), then definition order, then unknown keys sorted by code unit.
 * `context.today` is required even for a definition without relative date bounds,
 * so a caller can never forget to resolve it.
 */
export function validateSubmission(definition, data, context) {
    if (!isIsoDate(context.today))
        throw new Error("today must be an ISO date");
    if (!isPlainObject(data))
        return [{ field: "", code: "invalid_submission" }];
    const errors = [];
    const known = new Set(definition.fields.map((f) => f.id));
    const perField = [];
    let size = 0;
    for (const [key, value] of Object.entries(data)) {
        size += utf8Length(key);
        if (typeof value === "string")
            size += utf8Length(value);
        else if (Array.isArray(value)) {
            for (const item of value)
                if (typeof item === "string")
                    size += utf8Length(item);
        }
    }
    if (size > MAX_SUBMISSION_BYTES)
        errors.push({ field: "", code: "submission_too_large" });
    for (const field of definition.fields) {
        const code = validateValue(field, Object.prototype.hasOwnProperty.call(data, field.id) ? data[field.id] : undefined, context);
        if (code)
            perField.push({ field: field.id, code });
    }
    const extras = sortedKeys(data).filter((key) => !known.has(key));
    return [...errors, ...perField, ...extras.map((field) => ({ field, code: "unknown_field" }))];
}
function isEmpty(value, type) {
    return value === undefined || value === null || (typeof value === "string" && isBlank(value))
        || (type === "multi_choice" && Array.isArray(value) && value.length === 0);
}
function validateValue(field, value, context) {
    if (field.type === "consent") {
        return value === true
            ? null
            : isEmpty(value, field.type) || value === false
                ? "required"
                : "invalid_type";
    }
    if (field.type === "checkbox") {
        if (value === true)
            return null;
        if (isEmpty(value, field.type) || value === false)
            return field.required ? "required" : null;
        return "invalid_type";
    }
    if (isEmpty(value, field.type)) {
        if (field.required)
            return "required";
        // A blank value is skipped by every other check but still counts toward the
        // length ceiling, because it is stored as submitted.
        return typeof value === "string" && isTextType(field.type) && value.length > maxLengthOf(field) ? "too_long" : null;
    }
    switch (field.type) {
        case "text":
        case "long_text":
        case "email":
        case "tel":
        case "url":
            return typeof value === "string" ? validateString(field, value) : "invalid_type";
        case "number":
            return validateNumber(field, value);
        case "date":
            return validateDate(field, value, context);
        case "single_choice":
            if (typeof value !== "string")
                return "invalid_type";
            return field.choices?.includes(value) ? null : "not_an_option";
        case "multi_choice":
            return validateMulti(field, value);
        default:
            return "invalid_type";
    }
}
const isTextType = (type) => type === "text" || type === "long_text" || type === "email" || type === "tel" || type === "url";
function maxLengthOf(field) {
    const ceiling = field.type === "long_text" ? MAX_LONG_TEXT_LENGTH : MAX_SHORT_TEXT_LENGTH;
    return Math.min(field.max_length ?? ceiling, ceiling);
}
function validateString(field, value) {
    if (field.min_length !== undefined && value.length < field.min_length)
        return "too_short";
    if (value.length > maxLengthOf(field))
        return "too_long";
    if (field.type === "email" && !isValidEmail(value))
        return "not_an_email";
    if (field.type === "tel" && !isValidTel(value))
        return "not_a_phone";
    if (field.type === "url" && !isValidUrl(value))
        return "not_a_url";
    if (field.type === "text" && field.format) {
        const ok = field.format === "digits" ? allChars(value, isDigit) : allChars(value, isAlnumAscii);
        if (!ok)
            return "invalid_format";
    }
    return null;
}
function validateNumber(field, value) {
    if (typeof value !== "number")
        return "invalid_type";
    if (!Number.isFinite(value))
        return "not_a_number";
    if (field.format === "integer" && !Number.isInteger(value))
        return "invalid_format";
    if (typeof field.min === "number" && value < field.min)
        return "too_small";
    if (typeof field.max === "number" && value > field.max)
        return "too_large";
    return null;
}
function validateDate(field, value, context) {
    if (typeof value !== "string")
        return "invalid_type";
    if (!isIsoDate(value))
        return "not_a_date";
    const { today, graceDays = 0 } = context;
    if (typeof field.min !== "number" && field.min !== undefined && value < resolveDateBound(field.min, today, graceDays)) {
        return "too_small";
    }
    if (typeof field.max !== "number" && field.max !== undefined && value > resolveDateBound(field.max, today)) {
        return "too_large";
    }
    return null;
}
function validateMulti(field, value) {
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
        return "invalid_type";
    if (new Set(value).size !== value.length)
        return "duplicate_choice";
    if (!value.every((v) => field.choices?.includes(v)))
        return "not_an_option";
    if (typeof field.min === "number" && value.length < field.min)
        return "too_few";
    if (typeof field.max === "number" && value.length > field.max)
        return "too_many";
    return null;
}
