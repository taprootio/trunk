// Generated from shared/brand-color.ts by scripts/sync-field-validation.mjs. Do not edit.
/** Brand-color rules shared by the renderer and the site-authoring CLI. */
const COLOR_MAX_LENGTH = 128;
const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const OKLCH_COLOR_PATTERN = /^oklch\(\s*((?:0|[1-9]\d*)(?:\.\d+)?)\s+((?:0|[1-9]\d*)(?:\.\d+)?)\s+((?:0|[1-9]\d*)(?:\.\d+)?)\s*\)$/i;
const HEADER_BRAND_SEMANTIC_COLOR_TOKENS = new Set([
    "--esp-color-headings",
    "--esp-color-link",
    "--esp-color-primary",
    "--esp-color-text",
]);
/** A valid semantic token keeps its name; a supported custom color keeps its value. */
export function resolveBrandColorToken(value) {
    const color = value?.trim() ?? "";
    if (HEADER_BRAND_SEMANTIC_COLOR_TOKENS.has(color))
        return color;
    return color.length <= COLOR_MAX_LENGTH && isSupportedCustomColor(color) ? color : "";
}
export function resolveHeaderBrandColor(value) {
    const color = resolveBrandColorToken(value);
    return HEADER_BRAND_SEMANTIC_COLOR_TOKENS.has(color) ? `var(${color})` : color;
}
export function resolveBrandColors(input, resolve = resolveHeaderBrandColor) {
    const configured = resolve(input?.brandColor);
    const light = resolve(input?.lightBrandColor) || configured;
    const dark = resolve(input?.darkBrandColor) || configured || light;
    return { light, dark, generic: configured || light || dark };
}
/** The footer preserves the caller's colors without header validation. */
export function resolveFooterBrandColors({ light, dark }) {
    return { light, dark, generic: light || dark };
}
function isSupportedCustomColor(color) {
    if (HEX_COLOR_PATTERN.test(color))
        return true;
    const match = color.match(OKLCH_COLOR_PATTERN);
    if (!match)
        return false;
    return isBoundedColorComponent(match[1], 0, 1)
        && isBoundedColorComponent(match[2], 0, 0.25)
        && isBoundedColorComponent(match[3], 0, 360);
}
function isBoundedColorComponent(value, minimum, maximum) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum;
}
