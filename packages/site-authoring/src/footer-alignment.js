// Generated from shared/footer-alignment.ts by scripts/sync-field-validation.mjs. Do not edit.
export const FOOTER_ALIGNMENT_LAYOUTS = Object.freeze(["wide", "wrapped", "stacked"]);
export const FOOTER_POSITION_VALUES = Object.freeze(["start", "center", "end"]);
export const FOOTER_TEXT_ALIGN_VALUES = Object.freeze(["auto", "start", "center", "end", "justify"]);
const ALIGNMENT_AXES = Object.freeze([
    { key: "horizontal", attribute: "inline-align", values: FOOTER_POSITION_VALUES },
    { key: "vertical", attribute: "block-align", values: FOOTER_POSITION_VALUES },
    { key: "textAlign", attribute: "text-align", values: FOOTER_TEXT_ALIGN_VALUES },
]);
const PROFILE_PREFIXES = Object.freeze([
    { key: "alignment", prefix: "", inlineOnly: false },
    { key: "brandAlignment", prefix: "brand-", inlineOnly: false },
    { key: "asideAlignment", prefix: "aside-", inlineOnly: false },
    { key: "bottomAlignment", prefix: "bottom-", inlineOnly: true },
]);
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function axes(inlineOnly) {
    return ALIGNMENT_AXES.filter(axis => !inlineOnly || axis.key !== "vertical");
}
function attributeName(prefix, attribute, layout) {
    return `${prefix}${attribute}${layout === "wide" ? "" : `-${layout}`}`;
}
/** The mapper and adapters share ownership of exactly these input attributes. */
export const FOOTER_ALIGNMENT_ATTRIBUTE_NAMES = Object.freeze([
    ...PROFILE_PREFIXES.flatMap(profile => FOOTER_ALIGNMENT_LAYOUTS.flatMap(layout => axes(profile.inlineOnly).map(axis => attributeName(profile.prefix, axis.attribute, layout)))),
    "brand-logo-sizing",
]);
function normalizeProfile(value, inlineOnly) {
    const input = record(value);
    const profile = {};
    for (const layout of FOOTER_ALIGNMENT_LAYOUTS) {
        const inputAlignment = record(input[layout]);
        const alignment = {};
        for (const axis of axes(inlineOnly)) {
            const choice = inputAlignment[axis.key];
            if (typeof choice === "string" && axis.values.includes(choice)) {
                Object.assign(alignment, { [axis.key]: choice });
            }
        }
        if (Object.keys(alignment).length > 0)
            profile[layout] = alignment;
    }
    return Object.keys(profile).length > 0 ? profile : undefined;
}
/** Invalid stored choices disappear; saved intent is never expanded through inheritance. */
export function normalizeFooterResponsiveAlignment(value) {
    return normalizeProfile(value, false);
}
export function normalizeFooterResponsiveInlineAlignment(value) {
    return normalizeProfile(value, true);
}
export function normalizeFooterLogoBox(value) {
    return value === "natural" ? "natural" : "fixed";
}
/** The draft hash encodes empty axes as empty strings, in layout then axis order. */
export function footerAlignmentProfileValues(value, inlineOnly = false) {
    const profile = normalizeProfile(value, inlineOnly);
    return FOOTER_ALIGNMENT_LAYOUTS.flatMap(layout => axes(inlineOnly).map(axis => profile?.[layout]?.[axis.key] ?? ""));
}
function profileAttributes(value, prefix, inlineOnly) {
    const profile = normalizeProfile(value, inlineOnly);
    const attributes = {};
    for (const layout of FOOTER_ALIGNMENT_LAYOUTS) {
        for (const axis of axes(inlineOnly)) {
            const choice = profile?.[layout]?.[axis.key];
            if (choice !== undefined)
                attributes[attributeName(prefix, axis.attribute, layout)] = choice;
        }
    }
    return attributes;
}
export function footerAlignmentAttributes(value) {
    const settings = record(value);
    const attributes = {};
    for (const profile of PROFILE_PREFIXES) {
        Object.assign(attributes, profileAttributes(settings[profile.key], profile.prefix, profile.inlineOnly));
    }
    if (normalizeFooterLogoBox(settings.logoBox) === "natural")
        attributes["brand-logo-sizing"] = "natural";
    return attributes;
}
export function footerColumnAlignmentAttributes(value) {
    return profileAttributes(record(value).alignment, "", false);
}
/** Caller-content alignment CSS is needed only when a profile carries authored intent. */
export function hasFooterAlignment(value) {
    const settings = record(value);
    if (PROFILE_PREFIXES.some(profile => normalizeProfile(settings[profile.key], profile.inlineOnly) !== undefined)) {
        return true;
    }
    return Array.isArray(settings.linkColumns)
        && settings.linkColumns.some(column => normalizeFooterResponsiveAlignment(record(column).alignment) !== undefined);
}
