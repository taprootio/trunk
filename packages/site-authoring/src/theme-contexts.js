// Generated from shared/theme-contexts.ts by scripts/sync-field-validation.mjs. Do not edit.
/** Keep the decoded-name contract aligned with DefaultSiteTheme and the shared vectors. */
export const MAX_ENCODED_THEME_LENGTH = 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const CONTEXT_NAME = /^[a-z][a-z0-9-]*$/u;
const UNSAFE_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;
function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Only declarations Espalier retains can be selected by a published surface. */
export function declaredThemeContextNames(theme) {
    if (!isObject(theme) || !Object.prototype.hasOwnProperty.call(theme, "contexts") || !isObject(theme.contexts)) {
        return [];
    }
    const contexts = theme.contexts;
    return Object.keys(contexts)
        .filter(name => CONTEXT_NAME.test(name) && !UNSAFE_NAMES.has(name) && isObject(contexts[name]))
        .sort();
}
/** Count source nesting so even an overwritten duplicate property keeps the API's limit. */
function withinJsonDepth(json) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (const character of json) {
        if (inString) {
            if (escaped)
                escaped = false;
            else if (character === "\\")
                escaped = true;
            else if (character === "\"")
                inString = false;
        }
        else if (character === "\"")
            inString = true;
        else if (character === "{" || character === "[") {
            if (++depth > MAX_JSON_DEPTH)
                return false;
        }
        else if (character === "}" || character === "]")
            depth -= 1;
    }
    return true;
}
/** The API's strict wire decoder wins over Espalier's lenient legacy decoder for declarations. */
function decodeContextTheme(encoded) {
    if (typeof encoded !== "string" || encoded.length > MAX_ENCODED_THEME_LENGTH)
        return undefined;
    const compact = encoded.replace(/[ \t\r\n]/gu, "");
    if (compact.length % 4 !== 0 || !BASE64.test(compact))
        return undefined;
    try {
        const binary = atob(compact);
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        const marked = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
        const payload = marked ? bytes.subarray(3) : bytes;
        const hasNonAscii = payload.some(value => value > 0x7f);
        if (marked !== hasNonAscii)
            return undefined;
        const json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(payload);
        return withinJsonDepth(json) ? JSON.parse(json) : undefined;
    }
    catch {
        return undefined;
    }
}
export function declaredEncodedThemeContextNames(encoded) {
    return declaredThemeContextNames(decodeContextTheme(encoded));
}
function intersection(light, dark) {
    const other = new Set(dark);
    return light.filter(name => other.has(name));
}
/** Workspace themes are JSON objects until the canonical encoder sends them. */
export function sharedDeclaredThemeContextNames(light, dark) {
    return intersection(declaredThemeContextNames(light), declaredThemeContextNames(dark));
}
/** Stored themes share the API's decoder and declaration rules in previews and publishing. */
export function sharedEncodedThemeContextNames(light, dark) {
    return intersection(declaredEncodedThemeContextNames(light), declaredEncodedThemeContextNames(dark));
}
