// Generated from shared/image-description-validation.ts by scripts/sync-field-validation.mjs. Do not edit.
import registry from "./free-form-section-registry.json" with { type: "json" };
const definition = registry.imageDescription;
export const IMAGE_DESCRIPTION_MODES = Object.freeze([...definition.modes]);
export const IMAGE_DESCRIPTION_KEYS = Object.freeze(Object.keys(definition.fields));
const fields = Object.entries(definition.fields);
export const IMAGE_DESCRIPTION_PERSISTED_KEYS = Object.freeze(fields.filter(([, field]) => field.storage === "persisted").map(([key]) => key));
export const IMAGE_DESCRIPTION_HYDRATED_KEYS = Object.freeze(fields.filter(([, field]) => field.storage === "hydratedReadOnly").map(([key]) => key));
export function isImageDescriptionMode(value) {
    return value === undefined || value === null || IMAGE_DESCRIPTION_MODES.includes(value);
}
export function isImageDefaultDescription(value) {
    return value === undefined || value === null || typeof value === "string"
        && !/[\uD800-\uDFFF]/u.test(value) && [...value].length <= definition.maxDefaultDescriptionScalars;
}
/** Decimal strings retain int64 precision across JSON and JavaScript. */
export function normalizeImageDescriptionRevision(value) {
    if (typeof value === "number")
        return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
    if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value))
        return undefined;
    const maximum = definition.maxRevision;
    return value.length < maximum.length || value.length === maximum.length && value <= maximum ? value : undefined;
}
export function isImageDescriptionRevision(value) {
    return value === undefined || value === null || normalizeImageDescriptionRevision(value) !== undefined;
}
/** Editor controls repair unknown choices; delivery validation reports them instead. */
export function imageDescriptionMode(mode, contextual) {
    return typeof mode === "string" && IMAGE_DESCRIPTION_MODES.includes(mode)
        ? mode
        : contextual?.trim()
            ? "custom"
            : "inherit";
}
export function resolveImageDescription(mode, contextual, fallback) {
    switch (mode) {
        case "decorative":
            return "";
        case "inherit":
            return fallback;
        case "custom":
            return contextual;
        default:
            return contextual.trim() ? contextual : fallback;
    }
}
const validators = {
    mode: { accepts: isImageDescriptionMode, expected: `be ${IMAGE_DESCRIPTION_MODES.join(", ")}, or null` },
    text: {
        accepts: isImageDefaultDescription,
        expected: "be valid Unicode text within the registry's scalar limit, or null",
    },
    revision: {
        accepts: isImageDescriptionRevision,
        expected: "be a nonnegative safe integer or canonical int64 decimal string, or null",
    },
};
export function imageDescriptionIssues(value) {
    return fields.flatMap(([field, contract]) => {
        const validator = validators[contract.kind];
        return validator.accepts(value[field])
            ? []
            : [{ field, storage: contract.storage, expected: validator.expected }];
    });
}
export function pickImageDescriptionFields(value, storage) {
    return Object.fromEntries(fields.filter(([key, field]) => (!storage || field.storage === storage)
        && Object.prototype.hasOwnProperty.call(value, key)).map(([key]) => [key, value[key]]));
}
