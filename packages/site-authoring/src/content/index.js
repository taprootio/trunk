/**
 * Content validation and Markdown conversion — the part of this CLI that is
 * not a wrapper over the API.
 *
 * TR00604's defining constraint: the server checks a page body for
 * `RichTextBody.IsPresent` and nothing else. Everything past that gate is
 * accepted, stored, and silently mangled at render time. So the verbs in
 * `../verbs/` push nothing they have not run through `validateDocument` first,
 * and agents author in Markdown through `markdownToProseMirror` rather than
 * hand-assembling document JSON.
 *
 * The module is pure: no network, no filesystem, no clock, no dependencies.
 */

export { validateDocument } from "./validate-document.js";
export { markdownToProseMirror } from "./markdown.js";
export {
  FREE_FORM_SECTION_REGISTRY,
  freeFormRootPresentation,
  hasNamedFreeFormSectionContext,
  normalizeFreeFormSectionBackground,
  normalizeFreeFormSectionDecoration,
  sharedThemeContextNames,
  validateFreeFormSectionContexts,
} from "./free-form-sections.js";
export { normalizeInlineFactsItems } from "./inline-facts.js";
// The stable codes both of the above report through, so a caller branches on
// an identity instead of matching message text.
export { CONTENT_ERROR_CODES } from "./vocabulary.js";
