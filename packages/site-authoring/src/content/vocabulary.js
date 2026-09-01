import { sanitizeDiagnostic } from "../errors.js";
import freeFormSectionRegistry from "./free-form-section-registry.json" with { type: "json" };

/**
 * The primitives the content module shares: the accepted ProseMirror
 * vocabulary, the stable error codes, and faithful reimplementations of the
 * canonical renderer's own predicates.
 *
 * Everything in this file exists because the server does not validate page
 * bodies. `RichTextBody.IsPresent` checks that a document is a `doc` with at
 * least one meaningful node and nothing else; the renderer
 * (`shared/tiptap-prosemirror.ts`, copied verbatim next door as
 * `tiptap-prosemirror.ts`) then *silently drops* anything it does not
 * recognise — an unknown node renders its children, an unknown mark renders
 * bare text, an unsafe link loses its anchor, an out-of-range heading level
 * is clamped, an invalid CSS override disappears. Every one of those is a
 * page that publishes successfully and renders wrong, so this package rejects
 * them before they are sent.
 *
 * The rule for the reimplementations below: match the renderer exactly,
 * including the parts that look like bugs. A "safer" copy would reject
 * documents the renderer accepts, or accept documents it silently mangles,
 * and either way the CLI would stop being the schema.
 */

// ---------------------------------------------------------------------------
// The accepted vocabulary
// ---------------------------------------------------------------------------

// Every `case` label in the renderer's `renderNode` switch, minus the
// `default` arm that silently renders an unknown node's children. The
// renderer-parity test extracts those labels from the copied source and
// compares them with this list, so a node added upstream turns this package
// red instead of passing through unvalidated.
export const NODE_TYPES = Object.freeze([
  "doc",
  "paragraph",
  "text",
  "hardBreak",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "taprootImage",
  "componentBlock",
  "section",
  freeFormSectionRegistry.inlineFacts.nodeType,
  "rawHtml",
  freeFormSectionRegistry.table.nodeTypes.table,
  freeFormSectionRegistry.table.nodeTypes.row,
  freeFormSectionRegistry.table.nodeTypes.header,
  freeFormSectionRegistry.table.nodeTypes.cell,
]);

// Every `case` label in the renderer's `wrapMark` switch, minus the `default`
// arm that returns the text unwrapped. Cross-checked by the same parity test.
export const MARK_TYPES = Object.freeze([
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
  "link",
]);

export const NODE_TYPE_SET = Object.freeze(new Set(NODE_TYPES));
export const MARK_TYPE_SET = Object.freeze(new Set(MARK_TYPES));

/**
 * Every code this module emits. They are wire identities an agent branches on,
 * so they are appended to, never reworded or renumbered.
 */
export const CONTENT_ERROR_CODES = Object.freeze({
  // Document shape
  docType: "content.doc_type",
  docContent: "content.doc_content",
  emptyDocument: "content.empty_document",
  depthLimit: "content.depth_limit",
  errorLimit: "content.error_limit",
  // Nodes
  nodeInvalid: "content.node_invalid",
  nodeKey: "content.node_key",
  unknownNode: "content.unknown_node",
  childNotAllowed: "content.child_not_allowed",
  childRequired: "content.child_required",
  textInvalid: "content.text_invalid",
  // Marks
  marksInvalid: "content.marks_invalid",
  markKey: "content.mark_key",
  markMisplaced: "content.mark_misplaced",
  unknownMark: "content.unknown_mark",
  linkHref: "content.link_href",
  // Attributes
  attrsInvalid: "content.attrs_invalid",
  attrUnknown: "content.attr_unknown",
  attrInvalid: "content.attr_invalid",
  headingLevel: "content.heading_level",
  // Images
  imageKeys: "content.image_keys",
  imageTransient: "content.image_transient",
  // Components
  componentUnknown: "content.component_unknown",
  componentData: "content.component_data",
  sectionContextUnknown: "content.section_context_unknown",
  // Raw HTML
  rawHtmlForbidden: "content.raw_html_forbidden",
  // Tables
  tableHeader: "content.table_header",
  tableShape: "content.table_shape",
  tableRagged: "content.table_ragged",
  tableBounds: "content.table_bounds",
  tableCellContent: "content.table_cell_content",
  tableSpan: "content.table_span",
  // Markdown conversion
  markdownInput: "content.markdown_input",
  markdownControl: "content.markdown_control",
  markdownFrontMatter: "content.markdown_front_matter",
  markdownEmpty: "content.markdown_empty",
  headingDepth: "content.heading_depth",
  markdownSetext: "content.markdown_setext",
  markdownTable: "content.markdown_table",
  markdownTableAlignment: "content.markdown_table_alignment",
  markdownFootnote: "content.markdown_footnote",
  markdownHtml: "content.markdown_html",
  markdownAutolink: "content.markdown_autolink",
  markdownEntity: "content.markdown_entity",
  markdownReferenceLink: "content.markdown_reference_link",
  markdownIndentedCode: "content.markdown_indented_code",
  markdownUnclosedFence: "content.markdown_unclosed_fence",
  markdownCodeLanguage: "content.markdown_code_language",
  markdownSectionHeader: "content.markdown_section_header",
  markdownSectionUnclosed: "content.markdown_section_unclosed",
  markdownSectionNested: "content.markdown_section_nested",
  markdownInlineFacts: "content.markdown_inline_facts",
  markdownListMarker: "content.markdown_list_marker",
  markdownListStart: "content.markdown_list_start",
  markdownListItem: "content.markdown_list_item",
  markdownImage: "content.markdown_image",
  markdownLink: "content.markdown_link",
  markdownNesting: "content.markdown_nesting",
  markdownResolveImage: "content.markdown_resolve_image",
  markdownInvariant: "content.markdown_invariant",
});

export const CONTENT_LIMITS = Object.freeze({
  // A document deeper than this is either machine-generated nonsense or a
  // cycle a caller hand-built; either way the traversal stops rather than
  // exhausting the stack.
  documentDepth: 64,
  // Enough to describe a genuinely broken document without letting a hostile
  // one turn one call into megabytes of diagnostics.
  documentErrors: 200,
  identifierScalars: 64,
  markdownBytes: 1024 * 1024,
  markdownNesting: 16,
  // Character steps the inline scanner may take across one whole conversion.
  // Finding a closing delimiter is a linear scan, and an *unclosed* one scans
  // to the end of the block — so a document of nothing but openers costs
  // O(n^2) and `markdownBytes` alone would allow minutes of uninterruptible
  // CPU. Real prose closes its delimiters within a few characters and spends
  // a tiny fraction of this: a 37 KB document of well-formed bold, italic,
  // code, and link runs measures in the low tens of thousands of steps.
  inlineScanBudget: 5_000_000,
  imageReferenceLength: 1024,
  componentDataBytes: 256 * 1024,
  tableCaptionScalars: freeFormSectionRegistry.table.attrs.caption.maxScalars,
  tableDataRows: freeFormSectionRegistry.table.rows.maxData,
  tableColumns: freeFormSectionRegistry.table.columns.max,
  tableCellTextScalars: freeFormSectionRegistry.table.cells.maxTextScalars,
});

// ---------------------------------------------------------------------------
// Renderer-mirrored constants and predicates
// ---------------------------------------------------------------------------

/** `TIPTAP_SITE_DEFAULT` — the "no explicit choice" sentinel. */
export const TIPTAP_SITE_DEFAULT = "site-default";

/** `TIPTAP_IMAGE_MAX_HEIGHT_OPTIONS` — anything else normalises to 60 (silent). */
export const IMAGE_MAX_HEIGHT_OPTIONS = Object.freeze([45, 60, 75, 90]);

/** The canonical `TiptapImagePresentationPlacement` union. */
export const IMAGE_PRESENTATION_PLACEMENTS = Object.freeze([
  "left",
  "left-text-right",
  "center",
  "right",
  "right-text-left",
]);

/** `ArticleImageAlign` from the editor's image extension. */
export const IMAGE_ALIGNMENTS = Object.freeze(["start", "center", "end"]);

/** `ArticleImagePlacement` from the editor's image extension. */
export const IMAGE_PLACEMENTS = Object.freeze(["inline", "float-start", "float-end"]);

/** The four values the renderer's `textBlockAttrs` emits a `text-align` for. */
export const TEXT_ALIGNMENTS = Object.freeze(["left", "center", "right", "justify"]);

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Mirrors the renderer's `isSafeUrl`, including the behavior a from-scratch
 * implementation would get wrong:
 *
 * A value `new URL()` cannot parse is treated as a relative reference and
 * accepted — the renderer's deliberate escape hatch for `foo/bar`. Protocol-
 * relative references, backslashes, and ASCII controls are rejected before
 * that fallback so a native URL cannot acquire an ambiguous authority or
 * browser-dependent interpretation.
 *
 * A link the renderer refuses is not dropped loudly: `wrapMark` returns the
 * bare text and the anchor vanishes, so the CLI must refuse it here.
 */
export function isSafeUrl(url) {
  if (/[\u0000-\u001f\u007f]/u.test(url) || url.includes("\\")) return false;
  const cleaned = url.trim();
  if (!cleaned) return false;
  if (cleaned.startsWith("//")) return false;
  if (cleaned.startsWith("/") || cleaned.startsWith("./")) return true;
  if (cleaned.startsWith("#") || cleaned.startsWith("?")) return true;

  try {
    const parsed = new URL(cleaned);
    return ["http:", "https:", "mailto:", "tel:"].includes(parsed.protocol);
  } catch {
    return true;
  }
}

// The renderer's CSS grammar, character for character. These values are
// emitted into inline styles on published pages, which is why the grammar is
// this narrow — and why a value outside it is dropped rather than escaped.
const CSS_LENGTH_UNITS = "px|em|rem|ch|ex|vw|vh|svh|lvh|dvh|svw|lvw|dvw|vmin|vmax|%";
const CSS_LENGTH_RE = new RegExp(`^\\d+(?:\\.\\d+)?(?:${CSS_LENGTH_UNITS})$`, "i");
const CSS_VAR_RE = /^var\(--[a-z0-9-]+\)$/i;
const CSS_CALC_TERM = `(?:\\d+(?:\\.\\d+)?(?:${CSS_LENGTH_UNITS})|\\d+(?:\\.\\d+)?|var\\(--[a-z0-9-]+\\))`;
const CSS_CALC_RE = new RegExp(
  `^calc\\(\\s*${CSS_CALC_TERM}(?:\\s*[+\\-*/]\\s*${CSS_CALC_TERM})*\\s*\\)$`,
  "i",
);

/**
 * Mirrors the renderer's `normalizeCssLengthOverride`: returns the trimmed
 * value, or null when the value is invalid *or* is the site-default sentinel.
 * Callers that need to tell those two apart check the sentinel themselves.
 */
export function normalizeCssLengthOverride(value, options) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === TIPTAP_SITE_DEFAULT) return null;
  if (trimmed === "0") return trimmed;
  if (options?.allowNone && trimmed.toLowerCase() === "none") return "none";
  if (CSS_LENGTH_RE.test(trimmed)) return trimmed;
  if (CSS_VAR_RE.test(trimmed)) return trimmed;
  if (CSS_CALC_RE.test(trimmed)) return trimmed;
  return null;
}

/**
 * The lowercase canonical UUID the API round-trips. Deliberately looser than
 * `config.js`'s site-id pattern on the version nibble: image ids are server
 * minted and the platform is free to move from v4 to v7 without this package
 * refusing every image on the site.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

// ---------------------------------------------------------------------------
// Server-parity: RichTextBody.IsPresent
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = Object.freeze({
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: "\"",
});

/**
 * A bounded stand-in for `WebUtility.HtmlDecode`, used only to answer "does
 * this raw HTML contain visible text?". The named set covers the entities that
 * can hide a `<` or a space; an unknown named entity stays literal, which
 * makes the answer *more* likely to be "yes, there is text" — the safe
 * direction, because a false "empty" would refuse a page the server accepts.
 */
function decodeHtmlEntities(html) {
  return html.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body) => {
    if (body[0] === "#") {
      const codePoint = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/** Mirrors `RichTextBody.HasMeaningfulHtml`: text outside tags, after decoding. */
function hasMeaningfulHtml(html) {
  if (typeof html !== "string" || html.trim() === "") return false;
  const decoded = decodeHtmlEntities(html).replaceAll("\u00a0", " ");
  let insideTag = false;
  for (const character of decoded) {
    if (character === "<") {
      insideTag = true;
      continue;
    }
    if (character === ">") {
      insideTag = false;
      continue;
    }
    if (!insideTag && character.trim() !== "") return true;
  }
  return false;
}

/**
 * Mirrors `RichTextBody.HasMeaningfulContent` in
 * `api/src/Taproot.Domain/Entities/PageModel/RichTextBody.cs`. Text counts when
 * it is non-whitespace, raw HTML when it has visible text, and images and
 * component blocks always count; every other node counts only through its
 * children. A body that fails this is refused by the server with "Body is
 * required", which is why this package names it locally instead.
 */
function hasMeaningfulContent(node, depth = 0) {
  if (!isPlainObject(node) || depth > CONTENT_LIMITS.documentDepth) return false;
  if (node.type === "text") {
    return typeof node.text === "string" && node.text.trim() !== "";
  }
  if (node.type === "rawHtml") {
    return isPlainObject(node.attrs) && hasMeaningfulHtml(node.attrs.html);
  }
  if (
    node.type === "taprootImage"
    || node.type === "componentBlock"
    || node.type === freeFormSectionRegistry.inlineFacts.nodeType
  ) return true;
  if (!Array.isArray(node.content)) return false;
  return node.content.some((child) => hasMeaningfulContent(child, depth + 1));
}

/** Mirrors `RichTextBody.IsPresent` for a whole document. */
export function documentIsPresent(document) {
  if (!isPlainObject(document) || document.type !== "doc" || !Array.isArray(document.content)) return false;
  return document.content.some((node) => hasMeaningfulContent(node, 1));
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Bounds an author-supplied identifier before it reaches a message or a path.
 * Node types, attribute keys, and component types all come from the document
 * under validation, and the result of this module is printed to a terminal and
 * written to `GITHUB_OUTPUT` — so the same de-fanging `errors.js` applies to
 * API diagnostics applies here, with a much tighter length bound.
 */
export function identifier(value) {
  let source = "";
  try {
    // `validateDocument` promises never to throw, and a caller-built document
    // can carry an object whose own `toString` throws.
    source = typeof value === "string" ? value : String(value);
  } catch {
    source = "";
  }
  const clean = sanitizeDiagnostic(source, "");
  const bounded = [...clean].slice(0, CONTENT_LIMITS.identifierScalars).join("");
  return bounded || "(unnamed)";
}

/** JSON-pointer escaping (RFC 6901) for a single path segment. */
export function pointerSegment(value) {
  return identifier(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

/** One validation finding. Frozen so a caller cannot mutate a shared result. */
export function contentError(path, code, message) {
  return Object.freeze({ path, code, message });
}
