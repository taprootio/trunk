// Generated from shared/footer-content.ts by scripts/sync-field-validation.mjs. Do not edit.
import { isSafeUrl } from "./url-safety.js";
/** These fields belong to presentation; footer content saves and dirty checks leave them alone. */
export const FOOTER_PRESENTATION_FIELDS = ["context", "logoVariant"];
/** Preserve raw content values; callers decide whether their document needs normalization. */
export function projectFooterContent(settings) {
    const content = { ...settings };
    for (const field of FOOTER_PRESENTATION_FIELDS)
        delete content[field];
    return content;
}
/** Live settings without a path inventory can only assume an authored page target exists. */
export function resolveFooterTarget(target, pathsByResourceId) {
    const pageResourceId = target.pageResourceId?.trim() ?? "";
    const externalUrl = target.externalUrl?.trim() ?? "";
    if (Boolean(pageResourceId) === Boolean(externalUrl))
        return null;
    if (pageResourceId) {
        if (pathsByResourceId === undefined)
            return "/";
        const path = pathsByResourceId.get(pageResourceId);
        return path && isSafeUrl(path) ? path : null;
    }
    return normalizeExternalTargetUrl(externalUrl);
}
/** Preserve authored contact URLs. URL.toString() can re-encode phone or address punctuation. */
function normalizeExternalTargetUrl(candidate) {
    // The generic safe-link rule also allows relative paths. An external footer
    // target must be absolute, and the write paths also refuse C1 controls.
    if (!candidate || !isSafeUrl(candidate) || /[\u0080-\u009f]/u.test(candidate))
        return null;
    let parsed;
    try {
        parsed = new URL(candidate);
    }
    catch {
        return null;
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.username || parsed.password || !parsed.hostname ? null : parsed.toString();
    }
    if (parsed.protocol !== "mailto:" && parsed.protocol !== "tel:")
        return null;
    if (candidate.slice(candidate.indexOf(":") + 1).startsWith("//"))
        return null;
    return parsed.pathname.length > 0 ? candidate : null;
}
