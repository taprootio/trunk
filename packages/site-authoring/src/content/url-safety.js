// Generated from shared/url-safety.ts by scripts/sync-field-validation.mjs. Do not edit.
/**
 * The renderer's safe-link rule. The generator, editor and CLI copies are
 * written by scripts/sync-field-validation.mjs; edit this source only.
 */
/**
 * Check whether a URL string is safe for use in an `href` attribute.
 * Allows `http:`, `https:`, `mailto:`, `tel:`, and site-relative paths
 * (starting with `/` or `./`). Rejects `javascript:`, `data:`, `vbscript:`,
 * and every other executable or unknown scheme.
 *
 * ASCII controls, backslashes, and protocol-relative paths are rejected
 * before scheme validation because browsers normalize them inconsistently.
 *
 * Returns `false` for empty/whitespace-only strings.
 */
export function isSafeUrl(url) {
    if (/[\x00-\x1f\x7f\\]/u.test(url))
        return false;
    const cleaned = url.trim();
    if (!cleaned)
        return false;
    if (cleaned.startsWith("//"))
        return false;
    if (cleaned.startsWith("/") || cleaned.startsWith("./"))
        return true;
    // Fragment-only and query-only links are safe.
    if (cleaned.startsWith("#") || cleaned.startsWith("?"))
        return true;
    // Try parsing as an absolute URL. If it parses, validate the protocol.
    try {
        const parsed = new URL(cleaned);
        return ["http:", "https:", "mailto:", "tel:"].includes(parsed.protocol);
    }
    catch {
        // Not a valid absolute URL — treat as a relative path (safe).
        return true;
    }
}
