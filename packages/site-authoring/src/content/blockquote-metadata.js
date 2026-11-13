// Generated from shared/blockquote-metadata.ts by scripts/sync-field-validation.mjs. Do not edit.
import { sanitizeUrl } from "./component-urls.js";
import registry from "./free-form-section-registry.json" with { type: "json" };
export const BLOCKQUOTE_METADATA_FIELDS = registry.blockquote.attrs;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/u;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/** Citation URLs are addresses, never markup, executable schemes or fetch requests. */
export function isSafeBlockquoteSource(value) {
    if (CONTROL.test(value) || sanitizeUrl(value) !== value || value === "")
        return false;
    if (value.startsWith("/"))
        return true;
    if (!/^https?:\/\/[^/?#]+/iu.test(value))
        return false;
    try {
        const url = new URL(value);
        return (url.protocol === "https:" || url.protocol === "http:") && url.hostname !== "";
    }
    catch {
        return false;
    }
}
/** Strict write admission; null defaults mean absence and never rewrite stored text. */
export function validateBlockquoteMetadata(attrs) {
    if (attrs == null)
        return [];
    if (!object(attrs)) {
        return [{ field: "attrs", code: "blockquote.attrs", message: "Blockquote settings must be an object." }];
    }
    const issues = [];
    for (const [field, value] of Object.entries(attrs)) {
        if (!Object.prototype.hasOwnProperty.call(BLOCKQUOTE_METADATA_FIELDS, field)) {
            issues.push({
                field,
                code: "blockquote.unknown_attribute",
                message: "This blockquote setting is not supported.",
            });
            continue;
        }
        if (value == null)
            continue;
        const definition = BLOCKQUOTE_METADATA_FIELDS[field];
        if (typeof value !== "string" || !value.trim() || CONTROL.test(value) || [...value].length > definition.maxScalars) {
            issues.push({
                field,
                code: "blockquote.value",
                message: `${definition.label} must be single-line text of at most ${definition.maxScalars} characters.`,
            });
        }
        else if (field === "cite" && !isSafeBlockquoteSource(value)) {
            issues.push({
                field,
                code: "blockquote.url",
                message: "Source URL must be an HTTP or HTTPS address or a path beginning with one slash.",
            });
        }
    }
    return issues;
}
/** Invalid stored settings never become links; callers retain the quote's body. */
export function readBlockquoteMetadata(attrs) {
    if (validateBlockquoteMetadata(attrs).length > 0)
        return null;
    if (!object(attrs))
        return {};
    return Object.fromEntries(Object.entries(attrs).filter(([, value]) => value != null));
}
/** Real caption text is shared by published HTML, clipboard HTML and editing chrome. */
export function blockquoteCaptionParts(attrs) {
    const metadata = readBlockquoteMetadata(attrs);
    if (!metadata)
        return [];
    const { attribution, sourceTitle, cite } = metadata;
    const parts = [];
    if (attribution)
        parts.push({ kind: "text", text: `— ${attribution}` });
    if (attribution && (sourceTitle || cite))
        parts.push({ kind: "text", text: ", " });
    if (sourceTitle)
        parts.push({ kind: "title", text: sourceTitle, ...(cite ? { href: cite } : {}) });
    else if (cite)
        parts.push({ kind: "source", text: "Source", href: cite });
    return parts;
}
/** Check before schema parsing, which would otherwise discard unknown settings. */
export function hasUnsupportedBlockquoteMetadata(document) {
    const pending = [document];
    while (pending.length > 0) {
        const node = pending.pop();
        if (!object(node))
            continue;
        if (node.type === "blockquote" && validateBlockquoteMetadata(node.attrs).length > 0)
            return true;
        if (Array.isArray(node.content)) {
            for (const child of node.content)
                pending.push(child);
        }
    }
    return false;
}
