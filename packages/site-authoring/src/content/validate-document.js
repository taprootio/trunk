import { validateComponentBlock } from "./components.js";
import {
  FREE_FORM_SECTION_REGISTRY,
  normalizeFreeFormSectionBackground,
  normalizeFreeFormSectionDecoration,
} from "./free-form-sections.js";
import { normalizeInlineFactsItems } from "./inline-facts.js";
import {
  CONTENT_ERROR_CODES as CODES,
  CONTENT_LIMITS,
  contentError,
  documentIsPresent,
  identifier,
  IMAGE_ALIGNMENTS,
  IMAGE_MAX_HEIGHT_OPTIONS,
  IMAGE_PLACEMENTS,
  IMAGE_PRESENTATION_PLACEMENTS,
  isPlainObject,
  isSafeUrl,
  isUuid,
  MARK_TYPE_SET,
  NODE_TYPE_SET,
  normalizeCssLengthOverride,
  pointerSegment,
  TEXT_ALIGNMENTS,
  TIPTAP_SITE_DEFAULT,
} from "./vocabulary.js";

/**
 * The ProseMirror document validator.
 *
 * Every rule here answers one question: *would the canonical renderer, or the
 * editor's own schema, quietly discard this?* The renderer's `default` switch
 * arms drop unknown nodes and marks, `renderHeading` clamps a level of 9 to 4,
 * `wrapMark` drops an unsafe link, `textBlockAttrs` drops an unparseable
 * font size, and `PageImageDeliveryRewriter` leaves an image blank when the
 * `src`/`urls` keys are absent. None of that fails a push. All of it fails a
 * page, after publication, silently — so it fails here instead.
 */

// ---------------------------------------------------------------------------
// Attribute rules
// ---------------------------------------------------------------------------

// A spec's `check` returns null when the value is acceptable, or the tail of
// the sentence "'<attr>' must be …" when it is not.
const spec = (check, options = {}) => Object.freeze({ check, ...options });

const isAbsent = (value) => value === undefined || value === null;

/** Optional string attributes accept null: it is every extension's default. */
const optionalString = () => spec((value) => (isAbsent(value) || typeof value === "string" ? null : "a string"));

const optionalEnum = (values, extra = []) =>
  spec((value) => {
    if (isAbsent(value)) return null;
    if (typeof value === "string" && (values.includes(value) || extra.includes(value))) return null;
    return `one of ${[...values, ...extra].map((entry) => `"${entry}"`).join(", ")}`;
  });

const optionalPositiveInteger = () =>
  spec((value) => {
    if (isAbsent(value)) return null;
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? null : "a positive integer";
  });

/**
 * A per-block or per-image CSS override. The renderer runs every one of these
 * through `normalizeCssLengthOverride` and drops whatever fails, so the
 * validator accepts exactly what that function accepts, plus the explicit
 * `"site-default"` sentinel it maps to "no override". An empty string is *not*
 * a sentinel — it is a silent drop — and is refused.
 */
const optionalCssLength = (options) =>
  spec((value) => {
    if (isAbsent(value) || value === TIPTAP_SITE_DEFAULT) return null;
    if (typeof value === "string" && normalizeCssLengthOverride(value, options) !== null) return null;
    return "a CSS length, a var()/calc() expression"
      + (options?.allowNone ? ", \"none\"" : "")
      + ", or \"site-default\"";
  });

/** `textAlign` — the four values `textBlockAttrs` emits a `text-align` for. */
const TEXT_ALIGN_SPEC = optionalEnum(TEXT_ALIGNMENTS);

/** `fontSize` — the advanced text setting, validated as published inline CSS. */
const FONT_SIZE_SPEC = spec((value) => {
  if (isAbsent(value)) return null;
  if (typeof value === "string" && normalizeCssLengthOverride(value) !== null) return null;
  return "a CSS length, a var() reference, or a calc() expression";
});

const TEXT_BLOCK_ATTRS = Object.freeze({
  textAlign: TEXT_ALIGN_SPEC,
  fontSize: FONT_SIZE_SPEC,
});

const RESPONSIVE_URL_KEYS = Object.freeze(["minWidth", "url", "type"]);

/**
 * `urls` — the responsive delivery hints. The renderer's
 * `validResponsiveImageUrls` skips any entry without a truthy `minWidth` and
 * `url`, so a malformed entry disappears from the published `<esp-image>`
 * without a trace. `type` is optional and is emitted when present.
 */
const URLS_SPEC = spec((value) => {
  if (!Array.isArray(value)) return "an array of { minWidth, url } objects";
  for (const entry of value) {
    if (!isPlainObject(entry)) return "an array of { minWidth, url } objects";
    if (Object.keys(entry).some((key) => !RESPONSIVE_URL_KEYS.includes(key))) {
      return "an array of objects with only minWidth, url, and type keys";
    }
    if (typeof entry.minWidth !== "number" || !Number.isFinite(entry.minWidth) || entry.minWidth <= 0) {
      return "an array whose entries each carry a positive numeric minWidth";
    }
    if (typeof entry.url !== "string" || entry.url === "") {
      return "an array whose entries each carry a non-empty url string";
    }
    if (entry.type !== undefined && typeof entry.type !== "string") {
      return "an array whose entries carry a string type when present";
    }
  }
  return null;
}, {
  required: true,
  missingCode: CODES.imageKeys,
  missingMessage: "'urls' must be present, even as []: PageImageDeliveryRewriter only replaces delivery URLs on "
    + "keys that already exist, so an image node without a 'urls' key renders with no responsive sources.",
});

const CROP_KEYS = Object.freeze(["x", "y", "width", "height"]);

/** `crop` — a `CropRegion` in source fractions, serialised into `data-crop`. */
const CROP_SPEC = spec((value) => {
  if (isAbsent(value)) return null;
  if (!isPlainObject(value)) return "a { x, y, width, height } object of 0-1 fractions";
  const keys = Object.keys(value);
  if (keys.length !== CROP_KEYS.length || CROP_KEYS.some((key) => !keys.includes(key))) {
    return "an object with exactly the keys x, y, width, and height";
  }
  for (const key of CROP_KEYS) {
    const entry = value[key];
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0 || entry > 1) {
      return "a { x, y, width, height } object of 0-1 fractions";
    }
  }
  return null;
});

/**
 * `taprootImage`. The attribute set is the editor extension's
 * (`extensions/taproot-image.ts`) minus the four the editor strips on save
 * (`TRANSIENT_TAPROOT_IMAGE_ATTRS` in `taproot-tiptap.ts`: `localImage`,
 * `resolvedMaxHeightVh`, `tempId`, `uploading`). Those four are
 * editor-session state — an upload in flight, a blob URL, a placeholder id, a
 * resolved display value — and serialising them publishes a document that
 * references a browser session that no longer exists.
 *
 * `presentationPlacement` is also `rendered: false` in the extension but is
 * kept here, because the editor keeps it too: `renderHTML` skips it while the
 * renderer's `resolvePlacement` reads it, so it is stored state, not session
 * state.
 */
const IMAGE_ATTRS = Object.freeze({
  imageId: spec(
    (value) => (isUuid(value) ? null : "a canonical lowercase UUID"),
    { required: true },
  ),
  src: spec(
    (value) => (typeof value === "string" ? null : "a string (\"\" is correct for authored content)"),
    {
      required: true,
      missingCode: CODES.imageKeys,
      missingMessage: "'src' must be present, even as \"\": PageImageDeliveryRewriter only replaces delivery URLs "
        + "on keys that already exist, so an image node without a 'src' key renders blank.",
    },
  ),
  urls: URLS_SPEC,
  alt: optionalString(),
  width: optionalPositiveInteger(),
  height: optionalPositiveInteger(),
  crop: CROP_SPEC,
  maxHeightVh: spec((value) => {
    if (isAbsent(value) || value === TIPTAP_SITE_DEFAULT) return null;
    return IMAGE_MAX_HEIGHT_OPTIONS.includes(value)
      ? null
      : `one of ${IMAGE_MAX_HEIGHT_OPTIONS.join(", ")} or "site-default"`;
  }),
  maxHeight: optionalCssLength({ allowNone: true }),
  borderWidth: optionalCssLength(),
  presentationPlacement: optionalEnum(IMAGE_PRESENTATION_PLACEMENTS, [TIPTAP_SITE_DEFAULT]),
  imageAlign: optionalEnum(IMAGE_ALIGNMENTS),
  imagePlacement: optionalEnum(IMAGE_PLACEMENTS),
  // TextAlign is configured for taprootImage as well as paragraph and heading.
  textAlign: TEXT_ALIGN_SPEC,
});

/** The four the editor strips on save — never valid on the wire. */
const IMAGE_TRANSIENT_ATTRS = Object.freeze(["uploading", "localImage", "tempId", "resolvedMaxHeightVh"]);

const COMPONENT_ATTRS = Object.freeze({
  // Both values are checked by `validateComponentBlock`, which owns the
  // registry lookup and the data-shape tables; these specs only establish that
  // the attributes are present at all.
  componentType: spec(() => null, {
    required: true,
    missingCode: CODES.componentUnknown,
    missingMessage: "'componentType' is required and must name one of the eight registry components.",
  }),
  componentData: spec(() => null, {
    required: true,
    missingCode: CODES.componentData,
    missingMessage: "'componentData' is required and must be a JSON string.",
  }),
});

const SECTION_CONTEXT = FREE_FORM_SECTION_REGISTRY.section.attrs.context;
const SECTION_CONTEXT_PATTERN = new RegExp(SECTION_CONTEXT.pattern, "u");
const SECTION_ATTRS = Object.freeze({
  context: spec((value) => {
    if (isAbsent(value)) return null;
    return typeof value === "string"
        && [...value].length <= SECTION_CONTEXT.maximumLength
        && SECTION_CONTEXT_PATTERN.test(value)
      ? null
      : `an identifier matching ${SECTION_CONTEXT.pattern} with at most ${SECTION_CONTEXT.maximumLength} characters`;
  }),
  contentPadding: optionalEnum(FREE_FORM_SECTION_REGISTRY.section.attrs.contentPadding.values),
  surface: optionalEnum(FREE_FORM_SECTION_REGISTRY.section.attrs.surface.values),
  // Nested field diagnostics are owned by
  // `normalizeFreeFormSectionBackground` below.
  background: spec(() => null),
  // Nested field diagnostics are owned by
  // `normalizeFreeFormSectionDecoration` below, so this outer spec deliberately
  // does not collapse them into one error at `/attrs/decoration`.
  decoration: spec(() => null),
});

const TABLE_CONTRACT = FREE_FORM_SECTION_REGISTRY.table;
const TABLE_NODE_TYPES = TABLE_CONTRACT.nodeTypes;
const TABLE_CAPTION = TABLE_CONTRACT.attrs.caption;
const INLINE_FACTS_CONTRACT = FREE_FORM_SECTION_REGISTRY.inlineFacts;

function scalarLength(value, stopAfter = Number.POSITIVE_INFINITY) {
  let length = 0;
  for (const _character of value) {
    length += 1;
    if (length > stopAfter) break;
  }
  return length;
}

const TABLE_ATTRS = Object.freeze({
  caption: spec((value) => {
    if (isAbsent(value)) return null;
    if (typeof value !== "string" || value.trim() === "") {
      return "non-empty plain text when present";
    }
    return scalarLength(value, TABLE_CAPTION.maxScalars) <= TABLE_CAPTION.maxScalars
      ? null
      : `at most ${TABLE_CAPTION.maxScalars} Unicode scalar values`;
  }, { code: CODES.tableBounds }),
});

// ---------------------------------------------------------------------------
// Node rules
// ---------------------------------------------------------------------------

const INLINE = Object.freeze(["text", "hardBreak"]);
const BLOCKS = Object.freeze([
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "taprootImage",
  "componentBlock",
  "rawHtml",
]);
const SECTION_BLOCKS = Object.freeze([
  ...BLOCKS,
  TABLE_NODE_TYPES.table,
  INLINE_FACTS_CONTRACT.nodeType,
]);
const ROOT_BLOCKS = Object.freeze([...SECTION_BLOCKS, FREE_FORM_SECTION_REGISTRY.section.nodeType]);
const NONE = Object.freeze([]);

const rule = (options) => Object.freeze({ attrs: Object.freeze({}), children: NONE, minChildren: 0, ...options });

/**
 * The content model, taken from the editor's schema rather than from what the
 * renderer happens to tolerate. The renderer will happily emit `<p><ul>…</ul>`
 * — the browser then hoists the list out of the paragraph — and ProseMirror
 * itself silently repairs a document that violates a node's content
 * expression, which is how a pushed body comes back from a pull with content
 * missing.
 *
 * **Which nodes may carry marks.** In prosemirror-model a mark lands on a node
 * when the node's *parent* type allows that mark: `AddMarkStep.apply` marks
 * every `node.isAtom` in the range where `parent.type.allowsMarkType(...)`, and
 * `ParseContext.insertNode` applies the active mark set under the same test.
 * `markSet` is `null` — every mark allowed — for a type with inline content and
 * no explicit `marks` spec, which here means exactly `paragraph` and `heading`.
 * So the nodes that can arrive carrying marks are the inline atoms that live in
 * those two: `text` and `hardBreak`. Every other node in this vocabulary is a
 * block whose parents (`doc`, `listItem`, `blockquote`) have `markSet == []`
 * and so can never mark a child — `horizontalRule`, `taprootImage`, and
 * `componentBlock` included, since all three are `group: "block"` atoms — and
 * `codeBlock` declares `marks: ""`, which is why its text is refused marks
 * below. If a future extension makes one of them inline, this list changes with
 * it; the criterion, not the list, is the rule.
 */
const NODE_RULES = Object.freeze({
  doc: rule({ children: ROOT_BLOCKS }),
  paragraph: rule({ attrs: TEXT_BLOCK_ATTRS, children: INLINE }),
  heading: rule({
    attrs: Object.freeze({
      // 1-4 exactly: `renderHeading` clamps anything else into range, so a
      // level of 5 publishes as an `<h4>` and a level of 0 as an `<h1>`.
      level: spec(
        (value) => (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 4
          ? null
          : "an integer from 1 to 4"),
        { required: true, code: CODES.headingLevel, missingCode: CODES.headingLevel },
      ),
      ...TEXT_BLOCK_ATTRS,
    }),
    children: INLINE,
  }),
  text: rule({ marks: true }),
  // A hard break carries marks for the most ordinary reason there is: select
  // two lines of a paragraph, press Bold, and `AddMarkStep` marks every atom
  // in the range — the `<br>` between them included. Pasting
  // `<strong>a<br>b</strong>` does the same through the DOM parser. The
  // renderer emits `<br>` and ignores the mark, which is a visual no-op rather
  // than a silent mangle (a `<br>` inside `<strong>` looks like a `<br>`), so
  // refusing the shape would hard-block an ordinary pull/push for nothing.
  hardBreak: rule({ marks: true }),
  bulletList: rule({ children: Object.freeze(["listItem"]), minChildren: 1 }),
  orderedList: rule({
    // Tiptap's OrderedList declares `start` (default 1) and `type` (default
    // null), and prosemirror-model's `Node.toJSON` emits a node's attrs
    // whenever its type declares any — so *every* stored ordered list carries
    // `{ "start": 1, "type": null }` and refusing the pair would refuse an
    // ordinary pull/push round trip. Only the defaults are accepted: the
    // renderer publishes a bare `<ol>` and reads neither attribute, so any
    // other value is silently discarded at publish time.
    attrs: Object.freeze({
      start: spec((value) => (isAbsent(value) || value === 1
        ? null
        : "1, null, or absent: the renderer publishes a bare <ol>, so a list starting anywhere else "
          + "would silently publish starting at 1")
      ),
      type: spec((value) => (isAbsent(value)
        ? null
        : "null or absent: the renderer publishes a bare <ol> and carries no list-style type, so any "
          + "other value would silently publish as a decimal list")
      ),
    }),
    children: Object.freeze(["listItem"]),
    minChildren: 1,
  }),
  // ListItem's content expression is `paragraph block*`.
  listItem: rule({ children: BLOCKS, minChildren: 1, firstChild: "paragraph" }),
  blockquote: rule({ children: BLOCKS, minChildren: 1 }),
  codeBlock: rule({
    attrs: Object.freeze({
      language: spec((value) => {
        if (isAbsent(value)) return null;
        return typeof value === "string" && value !== ""
          ? null
          : "a non-empty string (omit it, or use null, for no language)";
      }),
    }),
    // `renderCodeBlock` concatenates `child.text` and ignores everything else,
    // so a nested node inside a code block vanishes and marks are stripped.
    children: Object.freeze(["text"]),
    childMarks: false,
  }),
  horizontalRule: rule({}),
  taprootImage: rule({ attrs: IMAGE_ATTRS, rejectedAttrs: IMAGE_TRANSIENT_ATTRS, imageDelivery: true }),
  componentBlock: rule({ attrs: COMPONENT_ATTRS, component: true }),
  section: rule({
    attrs: SECTION_ATTRS,
    children: SECTION_BLOCKS,
    minChildren: FREE_FORM_SECTION_REGISTRY.section.minimumChildren,
    sectionBackground: true,
    sectionDecoration: true,
  }),
  [INLINE_FACTS_CONTRACT.nodeType]: rule({
    attrs: Object.freeze({
      items: spec(() => null, {
        required: true,
        missingMessage: "'items' is required on an 'inlineFacts' node and must contain 1 through 6 facts.",
      }),
    }),
    inlineFacts: true,
  }),
  rawHtml: rule({
    attrs: Object.freeze({
      html: spec((value) => (typeof value === "string" ? null : "a string"), { required: true }),
    }),
    rawHtml: true,
  }),
  [TABLE_NODE_TYPES.table]: rule({
    attrs: TABLE_ATTRS,
    children: Object.freeze([TABLE_NODE_TYPES.row]),
    table: true,
  }),
  [TABLE_NODE_TYPES.row]: rule({
    children: Object.freeze([TABLE_NODE_TYPES.header, TABLE_NODE_TYPES.cell]),
    tableRow: true,
  }),
  [TABLE_NODE_TYPES.header]: rule({
    children: Object.freeze(["paragraph"]),
    tableCell: "header",
    rejectedTableSpans: TABLE_CONTRACT.cells.spanAttrs,
  }),
  [TABLE_NODE_TYPES.cell]: rule({
    children: Object.freeze(["paragraph"]),
    tableCell: "data",
    rejectedTableSpans: TABLE_CONTRACT.cells.spanAttrs,
  }),
});

// ---------------------------------------------------------------------------
// Mark rules
// ---------------------------------------------------------------------------

const MARK_RULES = Object.freeze({
  bold: Object.freeze({}),
  italic: Object.freeze({}),
  underline: Object.freeze({}),
  strike: Object.freeze({}),
  code: Object.freeze({}),
  link: Object.freeze({
    href: spec(
      (value) => {
        if (typeof value !== "string" || value === "") return "a URL";
        // `wrapMark` drops the whole anchor when this fails, keeping the text:
        // the link disappears from the published page without an error.
        return isSafeUrl(value)
          ? null
          : "a safe HTTP(S), mailto, tel, non-protocol-relative root, fragment, query, or relative URL without backslashes or ASCII controls";
      },
      { required: true, code: CODES.linkHref, missingCode: CODES.linkHref },
    ),
    // `@tiptap/extension-link` declares these four alongside `href`, and
    // `Mark.toJSON` emits every declared attribute — so every link the editor
    // has ever written carries all five, and refusing any of them would refuse
    // an ordinary pull/push round trip. The renderer ignores them and writes
    // its own `rel`.
    target: optionalString(),
    rel: optionalString(),
    class: optionalString(),
    title: optionalString(),
  }),
});

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

function report(state, path, code, message) {
  if (state.errors.length >= CONTENT_LIMITS.documentErrors) {
    state.truncated = true;
    return;
  }
  state.errors.push(contentError(path, code, message));
}

/**
 * The complete set of keys prosemirror-model serialises, read off the source:
 * `Node.toJSON` writes `type`, then `attrs` when the node's type declares any,
 * `content` when the node has children, and `marks` when it carries any;
 * `TextNode.toJSON` adds `text`; `Mark.toJSON` writes `type` and `attrs`.
 * There is no fifth node key and no third mark key, which is what makes
 * refusing everything else safe for round-tripping.
 */
const SERIALIZED_NODE_KEYS = Object.freeze(["type", "attrs", "content", "marks", "text"]);
const SERIALIZED_MARK_KEYS = Object.freeze(["type", "attrs"]);

/**
 * Refuses a key the renderer will never read.
 *
 * This is the quietest failure in the whole format: `{"type": "paragraph",
 * "text": "..."}` — an agent putting text where content belongs — and
 * `"contents"` for `"content"` are *structurally valid* ProseMirror. The
 * document keeps its presence (other blocks carry real content), the server
 * stores it, and the renderer walks `node.content`, finds nothing, and
 * publishes an empty paragraph. The words are simply gone.
 *
 * `attrs` and `marks` stay allowed as keys wherever they might appear, because
 * `checkAttrs` and `checkMarks` already diagnose their *contents* far more
 * precisely than "unexpected key" ever could.
 */
function checkNodeKeys(node, path, nodeRule, isText, state) {
  for (const key of Object.keys(node)) {
    const known = SERIALIZED_NODE_KEYS.includes(key)
      && (key !== "text" || isText)
      && (key !== "content" || nodeRule.children.length > 0);
    if (known) continue;
    report(
      state,
      `${path}/${pointerSegment(key)}`,
      CODES.nodeKey,
      `'${identifier(key)}' is not part of a '${identifier(node.type)}' node. ProseMirror serialises only type, `
        + "attrs, content, marks, and — on a text node — text; anything else is content the renderer never reads "
        + "and the page publishes without.",
    );
  }
}

function checkMarkKeys(mark, markPath, state) {
  for (const key of Object.keys(mark)) {
    if (SERIALIZED_MARK_KEYS.includes(key)) continue;
    report(
      state,
      `${markPath}/${pointerSegment(key)}`,
      CODES.markKey,
      `'${identifier(key)}' is not part of a '${identifier(mark.type)}' mark. A serialised mark carries only type `
        + "and attrs; a value anywhere else is dropped.",
    );
  }
}

function checkAttrs(node, path, nodeRule, state) {
  const attrsPath = `${path}/attrs`;
  const attrs = node.attrs;
  const present = isPlainObject(attrs);

  if (!isAbsent(attrs) && !present) {
    report(state, attrsPath, CODES.attrsInvalid, "'attrs' must be an object when present.");
    return;
  }

  if (present) {
    for (const key of Object.keys(attrs)) {
      if (nodeRule.rejectedTableSpans?.includes(key)) {
        report(
          state,
          `${attrsPath}/${pointerSegment(key)}`,
          CODES.tableSpan,
          `Table cell attribute '${
            identifier(key)
          }' is unsupported. Remove colspan, rowspan, and colwidth; every row must use the same explicit columns.`,
        );
        continue;
      }
      if (nodeRule.rejectedAttrs?.includes(key)) {
        report(
          state,
          `${attrsPath}/${pointerSegment(key)}`,
          CODES.imageTransient,
          `'${identifier(key)}' is editor-session state the extension marks rendered: false. It must never be `
            + "serialised into a published document.",
        );
        continue;
      }
      // Through `Object.hasOwn`, never a bare index: an attribute named
      // `constructor` or `toString` would otherwise resolve to something off
      // `Object.prototype`, and calling `.check` on it would throw out of a
      // function documented never to throw.
      const attrSpec = Object.hasOwn(nodeRule.attrs, key) ? nodeRule.attrs[key] : undefined;
      if (!attrSpec) {
        report(
          state,
          `${attrsPath}/${pointerSegment(key)}`,
          CODES.attrUnknown,
          `'${identifier(key)}' is not an attribute of a '${node.type}' node.`,
        );
        continue;
      }
      const detail = attrSpec.check(attrs[key]);
      if (detail) {
        report(
          state,
          `${attrsPath}/${pointerSegment(key)}`,
          attrSpec.code ?? CODES.attrInvalid,
          `'${key}' must be ${detail}.`,
        );
      }
    }
  }

  for (const [key, attrSpec] of Object.entries(nodeRule.attrs)) {
    if (!attrSpec.required || (present && Object.hasOwn(attrs, key))) continue;
    report(
      state,
      `${attrsPath}/${key}`,
      attrSpec.missingCode ?? attrSpec.code ?? CODES.attrInvalid,
      attrSpec.missingMessage ?? `'${key}' is required on a '${node.type}' node.`,
    );
  }

  // A crop can only ride an image whose `src` is the signed crop URL the
  // editor stored. `PageImageDeliveryRewriter` sends any node carrying `crop`
  // down its persisted-crop branch, which looks for a crop token inside
  // `src`/`urls`; authored content sends those keys empty, so no token is
  // found, `NormalizePersistedCropUrls` prunes an already-empty array, and the
  // node is published with no delivery URL at all — a blank image.
  if (nodeRule.imageDelivery && present && !isAbsent(attrs.crop) && attrs.src === "") {
    report(
      state,
      `${attrsPath}/crop`,
      CODES.imageKeys,
      "'crop' can only travel on an image whose 'src' is the signed crop URL the editor stored. Authored content "
        + "must omit it: with an empty 'src' the server finds no crop token, writes no delivery URL, and the image "
        + "publishes blank.",
    );
  }

  if (nodeRule.sectionDecoration && present && Object.hasOwn(attrs, "decoration")) {
    const result = normalizeFreeFormSectionDecoration(attrs.decoration, `${attrsPath}/decoration`);
    for (const error of result.errors) report(state, error.path, error.code, error.message);
  }

  if (nodeRule.sectionBackground && present && Object.hasOwn(attrs, "background")) {
    const result = normalizeFreeFormSectionBackground(attrs.background, `${attrsPath}/background`);
    for (const error of result.errors) report(state, error.path, error.code, error.message);
  }

  if (nodeRule.inlineFacts && present && Object.hasOwn(attrs, "items")) {
    const result = normalizeInlineFactsItems(attrs.items, `${attrsPath}/items`);
    for (const error of result.errors) report(state, error.path, error.code, error.message);
  }

  // The registry lookup and the eight data tables live in components.js. A
  // missing attribute is already reported above, so the data check runs only
  // once a `componentType` exists to validate against; an absent
  // `componentData` stands in as "{}" so the type is still checked without a
  // second report of the same missing attribute.
  if (nodeRule.component && present && Object.hasOwn(attrs, "componentType")) {
    const data = Object.hasOwn(attrs, "componentData") ? attrs.componentData : "{}";
    for (const error of validateComponentBlock(attrs.componentType, data, attrsPath)) {
      report(state, error.path, error.code, error.message);
    }
  }
}

function checkMarks(node, path, nodeRule, marksAllowed, state) {
  const marks = node.marks;
  if (!nodeRule.marks && Object.hasOwn(node, "marks")) {
    report(
      state,
      `${path}/marks`,
      CODES.markMisplaced,
      `Marks ride text and hard breaks; ProseMirror never puts one on a '${node.type}' node, because a block `
        + "node's parent allows no marks.",
    );
    return;
  }
  if (isAbsent(marks)) return;
  if (!Array.isArray(marks)) {
    report(state, `${path}/marks`, CODES.marksInvalid, "'marks' must be an array when present.");
    return;
  }
  if (marks.length === 0) return;
  if (!marksAllowed) {
    report(
      state,
      `${path}/marks`,
      CODES.markMisplaced,
      "Text inside a code block cannot carry marks; the renderer concatenates the raw text and drops them.",
    );
    return;
  }

  const seen = new Set();
  marks.forEach((mark, index) => {
    const markPath = `${path}/marks/${index}`;
    if (!isPlainObject(mark) || typeof mark.type !== "string") {
      report(state, markPath, CODES.marksInvalid, "A mark must be an object with a string 'type'.");
      return;
    }
    if (!MARK_TYPE_SET.has(mark.type)) {
      report(
        state,
        markPath,
        CODES.unknownMark,
        `Unknown mark '${identifier(mark.type)}'. The renderer drops it and publishes the text unmarked.`,
      );
      return;
    }
    if (seen.has(mark.type)) {
      report(state, markPath, CODES.marksInvalid, `A text node carries more than one '${mark.type}' mark.`);
      return;
    }
    seen.add(mark.type);
    checkMarkKeys(mark, markPath, state);
    checkMarkAttrs(mark, markPath, state);
  });
}

function checkMarkAttrs(mark, markPath, state) {
  const rules = MARK_RULES[mark.type];
  const attrsPath = `${markPath}/attrs`;
  const attrs = mark.attrs;
  const present = isPlainObject(attrs);
  if (!isAbsent(attrs) && !present) {
    report(state, attrsPath, CODES.attrsInvalid, "'attrs' must be an object when present.");
    return;
  }
  if (present) {
    for (const key of Object.keys(attrs)) {
      // `Object.hasOwn` for the same reason as in `checkAttrs`: a mark
      // attribute named `constructor` must report, not throw.
      const attrSpec = Object.hasOwn(rules, key) ? rules[key] : undefined;
      if (!attrSpec) {
        report(
          state,
          `${attrsPath}/${pointerSegment(key)}`,
          CODES.attrUnknown,
          `'${identifier(key)}' is not an attribute of a '${mark.type}' mark.`,
        );
        continue;
      }
      const detail = attrSpec.check(attrs[key]);
      if (detail) {
        report(
          state,
          `${attrsPath}/${pointerSegment(key)}`,
          attrSpec.code ?? CODES.attrInvalid,
          `'${key}' must be ${detail}.`,
        );
      }
    }
  }
  for (const [key, attrSpec] of Object.entries(rules)) {
    if (!attrSpec.required || (present && Object.hasOwn(attrs, key))) continue;
    report(
      state,
      `${attrsPath}/${key}`,
      attrSpec.missingCode ?? attrSpec.code ?? CODES.attrInvalid,
      attrSpec.missingMessage ?? `'${key}' is required on a '${mark.type}' mark.`,
    );
  }
}

function textDescendantFacts(node, stopAfter) {
  let scalars = 0;
  let hasNonWhitespace = false;
  const stack = [{ node, depth: 0 }];
  while (stack.length > 0 && scalars <= stopAfter) {
    const entry = stack.pop();
    const current = entry.node;
    if (!isPlainObject(current) || entry.depth > CONTENT_LIMITS.documentDepth) continue;
    if (current.type === "text" && typeof current.text === "string") {
      if (current.text.trim() !== "") hasNonWhitespace = true;
      scalars += scalarLength(current.text, stopAfter - scalars);
      continue;
    }
    if (Array.isArray(current.content)) {
      for (let index = current.content.length - 1; index >= 0; index -= 1) {
        stack.push({ node: current.content[index], depth: entry.depth + 1 });
      }
    }
  }
  return { scalars, hasNonWhitespace };
}

function checkTable(node, path, state) {
  const rows = node.content;
  if (!Array.isArray(rows)) {
    report(
      state,
      `${path}/content`,
      CODES.tableHeader,
      "A table must begin with exactly one tableRow whose cells are all tableHeader nodes.",
    );
    return;
  }

  const dataRows = Math.max(0, rows.length - TABLE_CONTRACT.rows.header);
  if (rows.length === 0) {
    report(
      state,
      `${path}/content`,
      CODES.tableHeader,
      "A table is missing its header row.",
    );
  }
  if (dataRows < TABLE_CONTRACT.rows.minData || dataRows > TABLE_CONTRACT.rows.maxData) {
    report(
      state,
      `${path}/content`,
      CODES.tableBounds,
      `A table must contain exactly one header row followed by ${TABLE_CONTRACT.rows.minData} through ${TABLE_CONTRACT.rows.maxData} data rows.`,
    );
  }

  let headerColumns;
  rows.forEach((row, rowIndex) => {
    const rowPath = `${path}/content/${rowIndex}`;
    if (!isPlainObject(row) || row.type !== TABLE_NODE_TYPES.row) {
      report(
        state,
        rowPath,
        rowIndex === 0 ? CODES.tableHeader : CODES.tableShape,
        rowIndex === 0
          ? "The first table child must be the one header tableRow."
          : "Every table child after the header must be a data tableRow.",
      );
      return;
    }
    if (!Array.isArray(row.content)) {
      report(
        state,
        `${rowPath}/content`,
        rowIndex === 0 ? CODES.tableHeader : CODES.tableShape,
        "A tableRow must carry a content array of explicit cells.",
      );
      return;
    }

    const columns = row.content.length;
    if (columns < TABLE_CONTRACT.columns.min || columns > TABLE_CONTRACT.columns.max) {
      report(
        state,
        `${rowPath}/content`,
        CODES.tableBounds,
        `Every table row must contain ${TABLE_CONTRACT.columns.min} through ${TABLE_CONTRACT.columns.max} cells.`,
      );
    }
    if (rowIndex === 0) {
      headerColumns = columns;
      if (row.content.some((cell) => !isPlainObject(cell) || cell.type !== TABLE_NODE_TYPES.header)) {
        report(
          state,
          `${rowPath}/content`,
          CODES.tableHeader,
          `The first row must contain only '${TABLE_NODE_TYPES.header}' nodes.`,
        );
      }
      return;
    }

    if (row.content.some((cell) => !isPlainObject(cell) || cell.type !== TABLE_NODE_TYPES.cell)) {
      report(
        state,
        `${rowPath}/content`,
        CODES.tableShape,
        `Data rows must contain only '${TABLE_NODE_TYPES.cell}' nodes; a table has exactly one header row.`,
      );
    }
    if (headerColumns !== undefined && columns !== headerColumns) {
      report(
        state,
        `${rowPath}/content`,
        CODES.tableRagged,
        `This row has ${columns} cells; every data row must match the header's ${headerColumns} columns.`,
      );
    }
  });
}

function checkTableCell(node, path, nodeRule, state) {
  const content = node.content;
  if (
    !Array.isArray(content)
    || content.length !== TABLE_CONTRACT.cells.paragraphs
    || !isPlainObject(content[0])
    || content[0].type !== "paragraph"
  ) {
    report(
      state,
      `${path}/content`,
      CODES.tableCellContent,
      `A '${node.type}' must contain exactly one paragraph and no other block content.`,
    );
  }

  const paragraph = Array.isArray(content) && isPlainObject(content[0]) && content[0].type === "paragraph"
    ? content[0]
    : undefined;
  if (
    paragraph
    && !TABLE_CONTRACT.cells.paragraphAttrs
    && !isAbsent(paragraph.attrs)
    && (!isPlainObject(paragraph.attrs) || Object.keys(paragraph.attrs).length > 0)
  ) {
    report(
      state,
      `${path}/content/0/attrs`,
      CODES.tableCellContent,
      "A table cell paragraph has no appearance attributes; remove its attrs object.",
    );
  }

  const facts = textDescendantFacts(node, TABLE_CONTRACT.cells.maxTextScalars);
  if (facts.scalars > TABLE_CONTRACT.cells.maxTextScalars) {
    report(
      state,
      `${path}/content`,
      CODES.tableBounds,
      `A table cell may contain at most ${TABLE_CONTRACT.cells.maxTextScalars} Unicode scalar values of text.`,
    );
  }
  if (nodeRule.tableCell === "header" && TABLE_CONTRACT.cells.headerNonWhitespace && !facts.hasNonWhitespace) {
    report(
      state,
      `${path}/content`,
      CODES.tableHeader,
      "Every header cell must contain non-whitespace text.",
    );
  }
}

function checkChildren(node, path, nodeRule, state, depth) {
  // A leaf takes no children at all, and `checkNodeKeys` has already refused a
  // stray `content` on one — reporting it again per child would say the same
  // thing several times over.
  if (nodeRule.children.length === 0) return;

  const content = node.content;
  if (isAbsent(content)) {
    if (nodeRule.minChildren > 0) {
      report(
        state,
        `${path}/content`,
        CODES.childRequired,
        `A '${node.type}' node must contain at least ${nodeRule.minChildren} child node.`,
      );
    }
    return;
  }
  if (!Array.isArray(content)) {
    report(state, `${path}/content`, CODES.nodeInvalid, "'content' must be an array when present.");
    return;
  }
  if (content.length < nodeRule.minChildren) {
    report(
      state,
      `${path}/content`,
      CODES.childRequired,
      `A '${node.type}' node must contain at least ${nodeRule.minChildren} child node.`,
    );
  }
  content.forEach((child, index) => {
    validateNode(child, `${path}/content/${index}`, nodeRule, index, state, depth + 1);
  });
}

function validateNode(node, path, parentRule, index, state, depth) {
  if (state.errors.length >= CONTENT_LIMITS.documentErrors) {
    state.truncated = true;
    return;
  }
  if (depth > CONTENT_LIMITS.documentDepth) {
    report(state, path, CODES.depthLimit, `Documents may not nest deeper than ${CONTENT_LIMITS.documentDepth} levels.`);
    return;
  }
  if (!isPlainObject(node) || typeof node.type !== "string") {
    report(state, path, CODES.nodeInvalid, "A node must be an object with a string 'type'.");
    return;
  }
  if (!NODE_TYPE_SET.has(node.type)) {
    report(
      state,
      path,
      CODES.unknownNode,
      `Unknown node '${identifier(node.type)}'. The renderer drops it and publishes only its children.`,
    );
    return;
  }
  if (!parentRule.children.includes(node.type)) {
    report(
      state,
      path,
      CODES.childNotAllowed,
      `A '${node.type}' node is not valid inside this node.`,
    );
    return;
  }
  if (parentRule.firstChild && index === 0 && node.type !== parentRule.firstChild) {
    report(
      state,
      path,
      CODES.childNotAllowed,
      `A list item must begin with a '${parentRule.firstChild}' node.`,
    );
  }

  const nodeRule = NODE_RULES[node.type];
  if (nodeRule.rawHtml && !state.allowRawHtml) {
    report(
      state,
      path,
      CODES.rawHtmlForbidden,
      "A 'rawHtml' node is published verbatim and unsanitised. Pass allowRawHtml to accept one deliberately.",
    );
  }
  if (node.type === "text") {
    if (typeof node.text !== "string") {
      report(state, path, CODES.textInvalid, "A text node must carry a string 'text'.");
    } else if (node.text === "") {
      report(state, path, CODES.textInvalid, "A text node cannot be empty; ProseMirror cannot represent one.");
    }
  }

  checkNodeKeys(node, path, nodeRule, node.type === "text", state);
  checkAttrs(node, path, nodeRule, state);
  checkMarks(node, path, nodeRule, parentRule.childMarks !== false, state);
  if (nodeRule.table) checkTable(node, path, state);
  if (nodeRule.tableCell) checkTableCell(node, path, nodeRule, state);
  checkChildren(node, path, nodeRule, state, depth);
}

/**
 * Validates a ProseMirror page body against the vocabulary the published-site
 * renderer actually understands.
 *
 * Returns `{ errors }`; an empty `errors` array means the document is safe to
 * send. `path` is a JSON pointer into the document (`""` is the document
 * itself, `/content/3/content/0` its fourth block's first child, and a
 * component finding continues *through* the `componentData` JSON string into
 * the parsed data). `code` is one of `CONTENT_ERROR_CODES`.
 *
 * `allowRawHtml` opts a caller into `rawHtml` nodes, which are published
 * unsanitised. It is off by default precisely because an agent should not be
 * able to emit one by accident.
 */
export function validateDocument(document, options = {}) {
  const state = {
    errors: [],
    truncated: false,
    allowRawHtml: options?.allowRawHtml === true,
  };

  if (!isPlainObject(document) || document.type !== "doc") {
    report(state, "", CODES.docType, "A page body must be an object with type \"doc\".");
    return finish(state);
  }
  if (!Array.isArray(document.content)) {
    report(state, "/content", CODES.docContent, "A page body must carry a 'content' array.");
    return finish(state);
  }

  checkNodeKeys(document, "", NODE_RULES.doc, false, state);
  checkAttrs(document, "", NODE_RULES.doc, state);
  checkMarks(document, "", NODE_RULES.doc, true, state);
  document.content.forEach((node, index) => {
    validateNode(node, `/content/${index}`, NODE_RULES.doc, index, state, 1);
  });

  // The server's own gate, named locally. `RichTextBody.IsPresent` refuses a
  // document with no text, no image, and no component block with a bare "Body
  // is required" that says nothing about which page or why.
  if (!documentIsPresent(document)) {
    report(
      state,
      "",
      CODES.emptyDocument,
      "A page body must contain text, an image, a component block, or inline facts; the server refuses an empty document.",
    );
  }

  return finish(state);
}

function finish(state) {
  if (state.truncated) {
    state.errors.push(contentError(
      "",
      CODES.errorLimit,
      `Validation stopped after ${CONTENT_LIMITS.documentErrors} findings; fix these and run it again.`,
    ));
  }
  return Object.freeze({ errors: Object.freeze(state.errors) });
}

/**
 * Exposed so the renderer-parity test can assert the rules table covers
 * exactly the vocabulary the copied renderer switches on — a node added
 * upstream must fail here rather than pass through unvalidated.
 */
export { NODE_RULES };
