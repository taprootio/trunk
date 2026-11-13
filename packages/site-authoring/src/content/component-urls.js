// Generated from shared/component-urls.ts by scripts/sync-field-validation.mjs. Do not edit.
/**
 * The one owner of which addresses the page components and the page header
 * markup turn into links (moved here from `generator/client/pages/shared/urls.ts`
 * by TR01331, so `shared/page-header.ts` can use the same rule).
 *
 * `sanitizeUrl` is the byline and page-author contract: root-relative paths and
 * explicit http(s) URLs only. `sanitizeStructuredContentUrl` is the broader
 * structured-content contract the call-to-action and hero components use.
 *
 * The generator cannot import a repo-root file, so
 * `node scripts/sync-field-validation.mjs` writes its copy; edit only this
 * file and re-run it.
 */
function cleanedUrl(url) {
    if (!url || /[\x00-\x1f\x7f\\]/u.test(url))
        return "";
    const cleaned = url.trim();
    if (!cleaned)
        return "";
    if (cleaned.startsWith("//"))
        return "";
    return cleaned;
}
/**
 * Preserve the established URL contract used by byline and page-author
 * links: root-relative paths and explicit HTTP(S) URLs only.
 */
export function sanitizeUrl(url) {
    const cleaned = cleanedUrl(url);
    if (!cleaned)
        return "";
    if (cleaned.startsWith("/"))
        return cleaned;
    const lower = cleaned.toLowerCase();
    return lower.startsWith("https://") || lower.startsWith("http://") ? cleaned : "";
}
/**
 * Sanitize URLs in the structured-content vocabulary. In addition to the
 * established component-link policy, this accepts mailto, tel, fragments,
 * queries, and path-like relative references used by agent-authored content.
 */
export function sanitizeStructuredContentUrl(url) {
    const cleaned = cleanedUrl(url);
    if (!cleaned)
        return "";
    if (cleaned.startsWith("/")
        || cleaned.startsWith("./")
        || cleaned.startsWith("#")
        || cleaned.startsWith("?"))
        return cleaned;
    try {
        const parsed = new URL(cleaned);
        return ["http:", "https:", "mailto:", "tel:"].includes(parsed.protocol) ? cleaned : "";
    }
    catch {
        return cleaned;
    }
}
