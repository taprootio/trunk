// Generated from shared/media-presentation.ts by scripts/sync-field-validation.mjs. Do not edit.
/**
 * The one owner of how an image, a video and a video embed are sized and
 * bordered: the site-default option lists and normalizers, the per-block
 * override grammar, and the CSS values built from them.
 *
 * Images, the Video block and the Video embed block read the same two site
 * settings (max height, border width) and take the same two optional per-block
 * overrides, so they share these functions and the custom properties they set.
 *
 * It is pure and dependency-free. The generator, the editor and the
 * site-authoring CLI cannot all import this file, so
 * `node scripts/sync-field-validation.mjs` writes their copies; edit only this
 * file and re-run it. The API mirrors the site-setting ranges in
 * `SiteSettings.cs`.
 */
/** The "no explicit choice" sentinel stored in place of an override. */
export const TIPTAP_SITE_DEFAULT = "site-default";
export const DEFAULT_TIPTAP_IMAGE_MAX_HEIGHT_VH = 60;
export const TIPTAP_IMAGE_MAX_HEIGHT_OPTIONS = [45, 60, 75, 90];
// Mirrors TiptapImageBorder in the API's SiteSettings.cs. 2px matches
// esp-image's built-in border so untouched sites keep their current look.
export const TIPTAP_IMAGE_BORDER_WIDTH_MIN = 0;
export const TIPTAP_IMAGE_BORDER_WIDTH_MAX = 20;
export const DEFAULT_TIPTAP_IMAGE_BORDER_WIDTH_PX = 2;
/** The custom property every sized media block reads its max height from. */
export const MEDIA_MAX_HEIGHT_PROPERTY = "--taproot-article-image-max-height";
/** The custom property every bordered media block reads its border from. */
export const MEDIA_BORDER_PROPERTY = "--esp-image-border";
/** A number, or text read as one (a cleared field reads as 0); anything else is not a number. */
function optionNumber(value) {
    if (typeof value === "number")
        return value;
    return typeof value === "string" ? Number(value) : Number.NaN;
}
function isMaxHeightOption(value) {
    return TIPTAP_IMAGE_MAX_HEIGHT_OPTIONS.includes(optionNumber(value));
}
/** The site max height (in vh) for any stored value; anything outside the options is the default. */
export function normalizeImageMaxHeight(value) {
    return isMaxHeightOption(value)
        ? optionNumber(value)
        : DEFAULT_TIPTAP_IMAGE_MAX_HEIGHT_VH;
}
/** An explicit per-image max height choice, or null for the site default, the sentinel or an invalid value. */
export function explicitImageMaxHeight(value) {
    if (value === TIPTAP_SITE_DEFAULT || value === undefined || value === null)
        return null;
    return isMaxHeightOption(value) ? optionNumber(value) : null;
}
/** The site border width in pixels for any stored value; anything outside the range is the default. */
export function normalizeImageBorderWidthPx(value) {
    const parsed = optionNumber(value);
    if (!Number.isFinite(parsed))
        return DEFAULT_TIPTAP_IMAGE_BORDER_WIDTH_PX;
    const width = Math.trunc(parsed);
    return width >= TIPTAP_IMAGE_BORDER_WIDTH_MIN && width <= TIPTAP_IMAGE_BORDER_WIDTH_MAX
        ? width
        : DEFAULT_TIPTAP_IMAGE_BORDER_WIDTH_PX;
}
const CSS_LENGTH_UNITS = "px|em|rem|ch|ex|vw|vh|svh|lvh|dvh|svw|lvw|dvw|vmin|vmax|%";
const CSS_LENGTH_RE = new RegExp(`^\\d+(?:\\.\\d+)?(?:${CSS_LENGTH_UNITS})$`, "i");
const CSS_VAR_RE = /^var\(--[a-z0-9-]+\)$/i;
const CSS_CALC_TERM = `(?:\\d+(?:\\.\\d+)?(?:${CSS_LENGTH_UNITS})|\\d+(?:\\.\\d+)?|var\\(--[a-z0-9-]+\\))`;
const CSS_CALC_RE = new RegExp(`^calc\\(\\s*${CSS_CALC_TERM}(?:\\s*[+\\-*/]\\s*${CSS_CALC_TERM})*\\s*\\)$`, "i");
/**
 * Validate a user-supplied CSS length for per-block presentation overrides
 * (max height, border width). These values are emitted into inline styles on
 * published pages, so anything outside this strict grammar is rejected:
 * unitless `0`, a non-negative length, `var(--token)`, `calc(...)` of those
 * terms, and — when `allowNone` is set — the `none` keyword (max-height).
 * Returns the trimmed value, or null when invalid or set to the site default.
 */
export function normalizeCssLengthOverride(value, options) {
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed === TIPTAP_SITE_DEFAULT)
        return null;
    if (trimmed === "0")
        return trimmed;
    if (options?.allowNone && trimmed.toLowerCase() === "none")
        return "none";
    if (CSS_LENGTH_RE.test(trimmed))
        return trimmed;
    if (CSS_VAR_RE.test(trimmed))
        return trimmed;
    if (CSS_CALC_RE.test(trimmed))
        return trimmed;
    return null;
}
/** The validated max height override of a block (a CSS length or "none"), or null for the site default. */
export function normalizeMaxHeightOverride(value) {
    return normalizeCssLengthOverride(value, { allowNone: true });
}
/** The validated border width override of a block (a CSS length), or null for the site default. */
export function normalizeBorderWidthOverride(value) {
    return normalizeCssLengthOverride(value);
}
/** CSS value for the border hook given a width; zero collapses to none. */
export function imageBorderValue(width) {
    return /^0(?:\.0+)?(?:[a-z%]+)?$/i.test(width) ? "none" : `${width} solid var(--esp-color-border)`;
}
/** The site-default border as CSS, from the stored pixel width. */
export function siteDefaultBorderValue(widthPx) {
    return imageBorderValue(`${normalizeImageBorderWidthPx(widthPx)}px`);
}
/**
 * The inline custom-property declarations that carry a block's overrides.
 * Only an explicit, valid override is emitted, so an absent one keeps
 * following the site default.
 */
export function mediaOverrideStyleParts(overrides) {
    const parts = [];
    const maxHeight = normalizeMaxHeightOverride(overrides.maxHeight);
    const borderWidth = normalizeBorderWidthOverride(overrides.borderWidth);
    // A unitless zero would make the video frame's width calc invalid; 0px means the same to an image.
    if (maxHeight)
        parts.push(`${MEDIA_MAX_HEIGHT_PROPERTY}: ${maxHeight === "0" ? "0px" : maxHeight}`);
    if (borderWidth)
        parts.push(`${MEDIA_BORDER_PROPERTY}: ${imageBorderValue(borderWidth)}`);
    return parts;
}
