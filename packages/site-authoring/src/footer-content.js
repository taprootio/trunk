// Generated from shared/footer-content.ts by scripts/sync-field-validation.mjs. Do not edit.
/** These fields belong to presentation; footer content saves and dirty checks leave them alone. */
export const FOOTER_PRESENTATION_FIELDS = ["context", "logoVariant"];
/** Preserve raw content values; callers decide whether their document needs normalization. */
export function projectFooterContent(settings) {
    const content = { ...settings };
    for (const field of FOOTER_PRESENTATION_FIELDS)
        delete content[field];
    return content;
}
