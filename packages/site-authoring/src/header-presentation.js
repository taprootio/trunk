// Generated from shared/header-presentation.ts by scripts/sync-field-validation.mjs. Do not edit.
export const HEADER_HEIGHT_MULTIPLIER_LIMITS = Object.freeze({ minimum: 1, maximum: 5, step: 0.1 });
const STANDARD_HEIGHT = Object.freeze({ tenths: 10, scale: 1, canonical: "" });
const HEIGHT_MULTIPLIER = /^(?:[1-4](?:\.[0-9])?|5(?:\.0)?)$/u;
/** Parse the authored string without floating-point remainder or whitespace normalization. */
export function parseHeaderHeightMultiplier(value) {
    if (value === undefined || value === "")
        return STANDARD_HEIGHT;
    if (typeof value !== "string")
        return null;
    // JavaScript's end anchor also matches before a final newline; require the entire value.
    if (HEIGHT_MULTIPLIER.exec(value)?.[0] !== value)
        return null;
    const whole = value.charCodeAt(0) - 48;
    const fraction = value.length === 3 ? value.charCodeAt(2) - 48 : 0;
    const tenths = whole * 10 + fraction;
    return tenths === 10
        ? STANDARD_HEIGHT
        : Object.freeze({ tenths, scale: tenths / 10, canonical: `${whole}.${fraction}` });
}
/** Read old or omitted settings as standard height; writes use the strict parser. */
export function resolveHeaderHeightMultiplier(value) {
    return parseHeaderHeightMultiplier(value) ?? STANDARD_HEIGHT;
}
/** Stored compact assets are delivered only when an expanded brand already exists. */
export function canUseCompactHeaderLogo(position, multiplier, hasRegularLogo) {
    const height = parseHeaderHeightMultiplier(multiplier);
    return position === "fixed" && hasRegularLogo && height !== null && height.tenths > 10;
}
/** Keep each scheme's selected source and reserved ratio together through fallback. */
export function resolveHeaderLogoPairs(input) {
    const pair = (url = "", aspectRatio = "") => ({ url, aspectRatio: url ? aspectRatio : "" });
    const light = pair(input.lightLogoUrl, input.lightLogoAspectRatio);
    const dark = pair(input.darkLogoUrl, input.darkLogoAspectRatio);
    const profile = pair(input.profileLogoFallbackUrl, input.profileLogoAspectRatio);
    const compactLight = pair(input.lightCompactLogoUrl, input.lightCompactLogoAspectRatio);
    const compactDark = pair(input.darkCompactLogoUrl, input.darkCompactLogoAspectRatio);
    const first = (...pairs) => pairs.find(candidate => candidate.url !== "") ?? pairs[0];
    const resolvedLight = first(light, profile, dark);
    const resolvedDark = first(dark, light, profile);
    return {
        light: resolvedLight,
        dark: resolvedDark,
        lightCompact: first(compactLight, compactDark, resolvedLight),
        darkCompact: first(compactDark, compactLight, resolvedDark),
    };
}
