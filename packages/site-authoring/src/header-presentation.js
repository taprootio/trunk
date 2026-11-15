// Generated from shared/header-presentation.ts by scripts/sync-field-validation.mjs. Do not edit.
import { DISPLAY_SCALE_LIMITS, parseDisplayScale } from "./display-scale.js";
export const HEADER_HEIGHT_MULTIPLIER_LIMITS = DISPLAY_SCALE_LIMITS;
const STANDARD_HEIGHT = Object.freeze({ tenths: 10, scale: 1, canonical: "" });
/** Parse the authored string without floating-point remainder or whitespace normalization. */
export function parseHeaderHeightMultiplier(value) {
    const parsed = parseDisplayScale(value);
    return parsed?.tenths === 10 ? STANDARD_HEIGHT : parsed;
}
/** Read old or omitted settings as standard height; writes use the strict parser. */
export function resolveHeaderHeightMultiplier(value) {
    return parseHeaderHeightMultiplier(value) ?? STANDARD_HEIGHT;
}
/** Clamp only the rendered endpoint, retaining the author's saved minimum. */
export function resolveHeaderMinHeightMultiplier(minimum, expanded) {
    const height = resolveHeaderHeightMultiplier(expanded);
    const floor = resolveHeaderHeightMultiplier(minimum);
    return floor.tenths < height.tenths ? floor : height;
}
/** Stored compact assets are delivered only when an expanded brand already exists. */
export function canUseCompactHeaderLogo(position, multiplier, hasRegularLogo, minimum) {
    const height = parseHeaderHeightMultiplier(multiplier);
    return position === "fixed" && hasRegularLogo && height !== null
        && height.tenths > resolveHeaderMinHeightMultiplier(minimum, multiplier).tenths;
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
