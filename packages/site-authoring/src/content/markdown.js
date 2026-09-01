import { SiteAuthoringError } from "../errors.js";
import { canonicalizeComponentData, isComponentType, validateComponentBlock } from "./components.js";
import {
  FREE_FORM_SECTION_REGISTRY,
  normalizeFreeFormSectionBackground,
  normalizeFreeFormSectionDecoration,
} from "./free-form-sections.js";
import { normalizeInlineFactsItems } from "./inline-facts.js";
import { validateDocument } from "./validate-document.js";
import {
  CONTENT_ERROR_CODES as CODES,
  CONTENT_LIMITS,
  documentIsPresent,
  identifier,
  isPlainObject,
  isSafeUrl,
  isUuid,
  MARK_TYPES,
} from "./vocabulary.js";

/**
 * Markdown → ProseMirror, as a bounded CommonMark subset with zero
 * dependencies.
 *
 * The subset is exactly the renderer's vocabulary: paragraphs, ATX headings
 * 1-4, hard breaks, bullet and ordered lists, blockquotes, fenced code with a
 * language, thematic breaks, images, bounded GFM pipe tables,
 * `component:<type>` fences, and `inline-facts` JSON-array fences; and the
 * bold, italic, strike, code, and link marks. **Anything outside it is a hard
 * error naming the construct and the line it appeared on.** That is the whole
 * design rule: a converter that
 * quietly flattened a malformed table into paragraphs, or an `<h5>` into an
 * `<h4>`, would hand an agent a page that looks converted and publishes wrong
 * — the same silent narrowing the renderer already does and this package
 * exists to prevent.
 *
 * Front matter is **not** this module's concern. `pages push` (TR00604 S2)
 * owns the page envelope — path, title, template type, description — and
 * strips the front-matter block before calling here. A document that still
 * starts with one is refused by name rather than parsed as a thematic break
 * followed by prose.
 */

const HARD_BREAK = "\n";
const MAX_LIST_ITEMS = 500;
const LANGUAGE_RE = /^[A-Za-z0-9_+#.-]{1,32}$/u;
const ATX_RE = /^ {0,3}(#{1,9})(?: +(.*?))? *$/u;
const THEMATIC_RE = /^ {0,3}(?:(?:\* *){3,}|(?:- *){3,}|(?:_ *){3,})$/u;
const SETEXT_RE = /^ {0,3}(?:=+|-+) *$/u;
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/u;
const SECTION_HEADER_RE = /^:::section (\{.*\})$/u;
const SECTION_HEADER_LIKE_RE = /^ *:::section(?=\s|\{|$)/u;
const SECTION_CLOSE_RE = /^:::$/u;
const BULLET_RE = /^( *)([-*+])( +|$)(.*)$/u;
const ORDERED_RE = /^( *)(\d{1,9})([.)])( +|$)(.*)$/u;
const BLOCKQUOTE_RE = /^ {0,3}>/u;
const FOOTNOTE_DEFINITION_RE = /^ {0,3}\[\^[^\]]{1,64}\]:/u;
const REFERENCE_DEFINITION_RE = /^ {0,3}\[[^\]]{1,256}\]: *\S/u;
const STANDALONE_IMAGE_RE = /^!\[([^\]]*)\]\(([^()\s]+)\)$/u;
const ENTITY_RE = /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/u;
const AUTOLINK_RE = /^<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*|[^\s<>@]+@[^\s<>]+)>/u;
const HTML_TAG_RE = /^<(?:\/?[A-Za-z][A-Za-z0-9-]*(?:[\s/>])|!--|!|\?)/u;
const PUNCTUATION_RE = /[!-/:-@[-`{-~]/u;
const TABLE_CONTRACT = FREE_FORM_SECTION_REGISTRY.table;
const TABLE_NODE_TYPES = TABLE_CONTRACT.nodeTypes;
const TABLE_CAPTION_STEM = TABLE_CONTRACT.markdown.captionPrefix.trimEnd();
const INLINE_FACTS_CONTRACT = FREE_FORM_SECTION_REGISTRY.inlineFacts;
const TABLE_DELIMITER_TOKEN_RE = new RegExp(
  `^:?-{${TABLE_CONTRACT.markdown.delimiterMinHyphens},}:?$`,
  "u",
);
const TABLE_DELIMITERISH_TOKEN_RE = /^:?-*:?$/u;

function fail(code, construct, message, line, cause) {
  return new SiteAuthoringError(
    code,
    line === undefined ? message : `${message} (line ${line})`,
    { field: construct, cause },
  );
}

// ---------------------------------------------------------------------------
// Line handling
// ---------------------------------------------------------------------------

function expandLeadingTabs(text) {
  let column = 0;
  let index = 0;
  while (index < text.length && (text[index] === " " || text[index] === "\t")) {
    column += text[index] === "\t" ? 4 - (column % 4) : 1;
    index += 1;
  }
  return " ".repeat(column) + text.slice(index);
}

function indentOf(text) {
  let indent = 0;
  while (indent < text.length && text[indent] === " ") indent += 1;
  return indent;
}

function isBlank(text) {
  return text.trim() === "";
}

/**
 * Splits the source into numbered lines, normalising line endings and refusing
 * control characters. The line numbers travel with the text so every error can
 * name the line the author has to look at, including inside a blockquote or a
 * list item where the text has been re-indented.
 */
function toLines(markdown) {
  const normalized = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  for (const character of normalized) {
    const codePoint = character.codePointAt(0);
    if ((codePoint <= 0x1f && character !== "\n" && character !== "\t") || codePoint === 0x7f) {
      throw fail(CODES.markdownControl, "control character", "The Markdown source contains a control character.");
    }
  }
  return normalized.split("\n").map((text, index) => ({ text, number: index + 1 }));
}

/**
 * Front matter belongs to the caller. Recognising it here turns a confusing
 * "setext heading" error into a sentence that names the real problem.
 */
function rejectFrontMatter(lines) {
  if (lines.length === 0 || lines[0].text.trim() !== "---") return;
  for (let index = 1; index < lines.length; index += 1) {
    const text = lines[index].text.trim();
    if (text === "---" || text === "...") {
      throw fail(
        CODES.markdownFrontMatter,
        "front matter",
        "The Markdown source still carries a front-matter block. Strip it before converting: the page envelope "
          + "belongs to 'pages push', not to the body.",
        1,
      );
    }
    if (text !== "" && !/^[A-Za-z_][A-Za-z0-9_-]*:/u.test(text)) return;
  }
}

function scalarLength(value, stopAfter = Number.POSITIVE_INFINITY) {
  let length = 0;
  for (const _character of value) {
    length += 1;
    if (length > stopAfter) break;
  }
  return length;
}

/**
 * Split one physical pipe row without interpreting its inline Markdown.
 * An escaped pipe is consumed here, after cell boundaries are known, so code
 * spans and link destinations receive the same literal pipe as ordinary inline
 * text. Other backslash escapes travel intact into `parseInline`. Unescaped
 * pipes are separators even inside code/link syntax: the bounded subset has
 * one unambiguous literal-pipe spelling.
 */
function tableRowCells(text) {
  const expanded = expandLeadingTabs(text);
  const indent = indentOf(expanded);
  if (indent > 3) return undefined;
  const source = expanded.slice(indent).trim();
  if (source === "") return undefined;

  const cells = [];
  let cell = "";
  let separators = 0;
  let endedWithSeparator = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\" && index + 1 < source.length) {
      const escaped = source[index + 1];
      cell += escaped === "|" ? escaped : character + escaped;
      index += 1;
      endedWithSeparator = false;
      continue;
    }
    if (character === "|") {
      cells.push(cell.trim());
      cell = "";
      separators += 1;
      endedWithSeparator = index === source.length - 1;
      continue;
    }
    cell += character;
    endedWithSeparator = false;
  }
  cells.push(cell.trim());
  if (separators === 0) return undefined;
  if (source.startsWith("|") && cells[0] === "") cells.shift();
  if (endedWithSeparator && cells.at(-1) === "") cells.pop();
  return { cells, separators };
}

function tableDelimiter(text) {
  if (isBlockStart(text)) return undefined;
  const row = tableRowCells(text);
  if (!row || row.cells.length === 0) return undefined;
  const delimiterish = row.cells.every((cell) => TABLE_DELIMITERISH_TOKEN_RE.test(cell));
  const hasValidToken = row.cells.some((cell) => TABLE_DELIMITER_TOKEN_RE.test(cell));
  if (!delimiterish && !hasValidToken) return undefined;
  return {
    ...row,
    hasAlignment: row.cells.some((cell) => TABLE_DELIMITERISH_TOKEN_RE.test(cell) && cell.includes(":")),
    valid: row.cells.every((cell) => TABLE_DELIMITER_TOKEN_RE.test(cell)),
  };
}

/** A caption candidate is consumed only after the next two lines prove a table. */
function tablePrelude(lines, start) {
  const candidate = lines[start];
  if (!candidate) return undefined;

  if (candidate.text.startsWith(TABLE_CAPTION_STEM) && start + 2 < lines.length) {
    const headerText = lines[start + 1].text;
    const header = isBlockStart(headerText) ? undefined : tableRowCells(headerText);
    const delimiter = tableDelimiter(lines[start + 2].text);
    if (header && header.cells.length > 0 && delimiter) {
      return { captionLine: candidate, header, headerIndex: start + 1, delimiter, delimiterIndex: start + 2 };
    }
  }

  if (start + 1 >= lines.length) return undefined;
  const header = isBlockStart(candidate.text) ? undefined : tableRowCells(candidate.text);
  const delimiter = tableDelimiter(lines[start + 1].text);
  return header && header.cells.length > 0 && delimiter
    ? { header, headerIndex: start, delimiter, delimiterIndex: start + 1 }
    : undefined;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

function isBlockStart(text) {
  return ATX_RE.test(text)
    || THEMATIC_RE.test(text)
    || FENCE_RE.test(text)
    || BLOCKQUOTE_RE.test(text)
    || BULLET_RE.test(text)
    || ORDERED_RE.test(text)
    || FOOTNOTE_DEFINITION_RE.test(text)
    || REFERENCE_DEFINITION_RE.test(text)
    || SECTION_HEADER_LIKE_RE.test(text)
    || SECTION_CLOSE_RE.test(text);
}

function guardBlockConstructs(text, line, nextText) {
  if (FOOTNOTE_DEFINITION_RE.test(text)) {
    throw fail(CODES.markdownFootnote, "footnote", "Footnotes are outside the supported Markdown subset.", line.number);
  }
  if (REFERENCE_DEFINITION_RE.test(text)) {
    throw fail(
      CODES.markdownReferenceLink,
      "reference link definition",
      "Reference-style link definitions are outside the supported Markdown subset; write the URL inline.",
      line.number,
    );
  }
  const row = tableRowCells(text);
  const delimiter = tableDelimiter(text);
  const nextDelimiter = nextText === undefined ? undefined : tableDelimiter(nextText);
  if (delimiter || (row && text.trimStart().startsWith("|")) || (row && nextDelimiter)) {
    throw fail(
      CODES.markdownTable,
      "table",
      "This looks like a malformed pipe table. Use a header row, a matching hyphen delimiter row, at least one data row, and a blank line after the table.",
      line.number,
    );
  }
}

async function parseBlocks(lines, context, depth) {
  if (depth > CONTENT_LIMITS.markdownNesting) {
    throw fail(
      CODES.markdownNesting,
      "nesting",
      `Markdown may not nest more than ${CONTENT_LIMITS.markdownNesting} levels deep.`,
      lines[0]?.number,
    );
  }

  const nodes = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const text = expandLeadingTabs(line.text);

    if (isBlank(text)) {
      index += 1;
      continue;
    }

    // Four columns of indentation is an indented code block in CommonMark,
    // ahead of every other block type. It cannot interrupt a paragraph, so
    // this only ever fires on a line that starts a block.
    if (indentOf(text) >= 4) {
      throw fail(
        CODES.markdownIndentedCode,
        "indented code block",
        "Indented code blocks are outside the supported subset; use a fenced block so the language is explicit.",
        line.number,
      );
    }

    const table = tablePrelude(lines, index);
    if (table) {
      if (context.blockPlacement !== "root" && context.blockPlacement !== "section") {
        throw fail(
          CODES.tableShape,
          "table",
          "A table is valid only at the document root or directly inside a top-level section; move it out of the list or blockquote.",
          line.number,
        );
      }
      const consumed = consumeTable(lines, table, context);
      nodes.push(consumed.node);
      index = consumed.next;
      continue;
    }

    if (SECTION_HEADER_LIKE_RE.test(text) || SECTION_CLOSE_RE.test(text)) {
      if (depth !== 0) {
        throw fail(
          CODES.markdownSectionNested,
          "section container",
          "A section container is valid only at the document root; it cannot be nested in a section, list, or blockquote.",
          line.number,
        );
      }
      if (SECTION_CLOSE_RE.test(text)) {
        throw fail(
          CODES.markdownSectionHeader,
          "section container",
          "A section closing marker appeared without a matching top-level section header.",
          line.number,
        );
      }
      const consumed = await consumeSection(lines, index, text, context, depth);
      nodes.push(consumed.node);
      index = consumed.next;
      continue;
    }

    const fence = FENCE_RE.exec(text);
    if (fence) {
      const consumed = await consumeFence(lines, index, fence, context);
      nodes.push(consumed.node);
      index = consumed.next;
      continue;
    }

    if (THEMATIC_RE.test(text)) {
      nodes.push({ type: "horizontalRule" });
      index += 1;
      continue;
    }

    const heading = ATX_RE.exec(text);
    if (heading) {
      const level = heading[1].length;
      if (level > 4) {
        throw fail(
          CODES.headingDepth,
          "heading",
          `Headings deeper than four levels are outside the supported subset; the renderer clamps '${
            "#".repeat(level)
          }' to an <h4>.`,
          line.number,
        );
      }
      const title = stripClosingHashes(heading[2] ?? "");
      const content = parseInline(title, context.scan, line.number, []);
      nodes.push(
        content.length > 0
          ? { type: "heading", attrs: { level }, content }
          : { type: "heading", attrs: { level } },
      );
      index += 1;
      continue;
    }

    if (BLOCKQUOTE_RE.test(text)) {
      const consumed = await consumeBlockquote(lines, index, context, depth);
      nodes.push(consumed.node);
      index = consumed.next;
      continue;
    }

    const marker = matchListMarker(text, line);
    if (marker) {
      const consumed = await consumeList(lines, index, marker, context, depth);
      nodes.push(consumed.node);
      index = consumed.next;
      continue;
    }

    const consumed = await consumeParagraph(lines, index, context);
    if (consumed.node) nodes.push(consumed.node);
    index = consumed.next;
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// GFM pipe tables
// ---------------------------------------------------------------------------

function inlineTextFacts(nodes, stopAfter) {
  let scalars = 0;
  let hasNonWhitespace = false;
  for (const node of nodes) {
    if (node.type !== "text" || typeof node.text !== "string") continue;
    if (node.text.trim() !== "") hasNonWhitespace = true;
    scalars += scalarLength(node.text, stopAfter - scalars);
    if (scalars > stopAfter) break;
  }
  return { scalars, hasNonWhitespace };
}

function markdownTableCell(source, type, context, line) {
  const inline = parseInline(source, context.scan, line.number, []);
  const facts = inlineTextFacts(inline, TABLE_CONTRACT.cells.maxTextScalars);
  if (facts.scalars > TABLE_CONTRACT.cells.maxTextScalars) {
    throw fail(
      CODES.tableBounds,
      "table cell",
      `A table cell may contain at most ${TABLE_CONTRACT.cells.maxTextScalars} Unicode scalar values of text. Shorten this cell.`,
      line.number,
    );
  }
  if (type === TABLE_NODE_TYPES.header && TABLE_CONTRACT.cells.headerNonWhitespace && !facts.hasNonWhitespace) {
    throw fail(
      CODES.tableHeader,
      "table header",
      "Every table header cell must contain non-whitespace text.",
      line.number,
    );
  }

  const paragraph = inline.length > 0 ? { type: "paragraph", content: inline } : { type: "paragraph" };
  return { type, content: [paragraph] };
}

function consumeTable(lines, prelude, context) {
  const headerLine = lines[prelude.headerIndex];
  const delimiterLine = lines[prelude.delimiterIndex];
  let caption;
  if (prelude.captionLine) {
    if (!prelude.captionLine.text.startsWith(TABLE_CONTRACT.markdown.captionPrefix)) {
      throw fail(
        CODES.markdownTable,
        "table caption",
        `A table caption must use the exact '${TABLE_CONTRACT.markdown.captionPrefix}Caption text' form.`,
        prelude.captionLine.number,
      );
    }
    caption = prelude.captionLine.text.slice(TABLE_CONTRACT.markdown.captionPrefix.length);
    if (
      caption.trim() === ""
      || scalarLength(caption, TABLE_CONTRACT.attrs.caption.maxScalars) > TABLE_CONTRACT.attrs.caption.maxScalars
    ) {
      throw fail(
        CODES.tableBounds,
        "table caption",
        `A table caption must be non-empty and no longer than ${TABLE_CONTRACT.attrs.caption.maxScalars} Unicode scalar values.`,
        prelude.captionLine.number,
      );
    }
  }

  if (prelude.delimiter.hasAlignment) {
    throw fail(
      CODES.markdownTableAlignment,
      "table alignment",
      "Table-column alignment is unsupported. Remove the ':' characters from the delimiter row and use hyphens only.",
      delimiterLine.number,
    );
  }
  if (!prelude.delimiter.valid) {
    throw fail(
      CODES.markdownTable,
      "table delimiter",
      `Every delimiter cell must contain at least ${TABLE_CONTRACT.markdown.delimiterMinHyphens} hyphen and no other text.`,
      delimiterLine.number,
    );
  }
  if (prelude.delimiter.cells.length !== prelude.header.cells.length) {
    throw fail(
      CODES.tableRagged,
      "table delimiter",
      `The delimiter has ${prelude.delimiter.cells.length} cells but the header has ${prelude.header.cells.length}. Make every row the same width.`,
      delimiterLine.number,
    );
  }
  if (
    prelude.header.cells.length < TABLE_CONTRACT.columns.min
    || prelude.header.cells.length > TABLE_CONTRACT.columns.max
  ) {
    throw fail(
      CODES.tableBounds,
      "table columns",
      `A table must contain ${TABLE_CONTRACT.columns.min} through ${TABLE_CONTRACT.columns.max} columns.`,
      headerLine.number,
    );
  }

  const header = {
    type: TABLE_NODE_TYPES.row,
    content: prelude.header.cells.map((cell) => markdownTableCell(cell, TABLE_NODE_TYPES.header, context, headerLine)),
  };
  const data = [];
  let index = prelude.delimiterIndex + 1;
  while (index < lines.length && !isBlank(expandLeadingTabs(lines[index].text))) {
    const line = lines[index];
    const expanded = expandLeadingTabs(line.text);
    if (isBlockStart(expanded)) {
      guardBlockConstructs(expanded, line, lines[index + 1]?.text);
      throw fail(
        CODES.markdownTable,
        "table row",
        "A blank line must end a table. Before that blank line, every non-blank line must be a pipe-delimited data row.",
        line.number,
      );
    }
    const row = tableRowCells(line.text);
    if (!row) {
      throw fail(
        CODES.markdownTable,
        "table row",
        "A blank line must end a table. Before that blank line, every non-blank line must be a pipe-delimited data row.",
        line.number,
      );
    }
    if (data.length >= TABLE_CONTRACT.rows.maxData) {
      throw fail(
        CODES.tableBounds,
        "table rows",
        `A table may contain at most ${TABLE_CONTRACT.rows.maxData} data rows. Split this table or remove rows.`,
        line.number,
      );
    }
    if (row.cells.length < TABLE_CONTRACT.columns.min || row.cells.length > TABLE_CONTRACT.columns.max) {
      throw fail(
        CODES.tableBounds,
        "table columns",
        `Every table row must contain ${TABLE_CONTRACT.columns.min} through ${TABLE_CONTRACT.columns.max} cells.`,
        line.number,
      );
    }
    if (row.cells.length !== prelude.header.cells.length) {
      throw fail(
        CODES.tableRagged,
        "table row",
        `This row has ${row.cells.length} cells but the header has ${prelude.header.cells.length}. Make every row the same width.`,
        line.number,
      );
    }
    data.push({
      type: TABLE_NODE_TYPES.row,
      content: row.cells.map((cell) => markdownTableCell(cell, TABLE_NODE_TYPES.cell, context, line)),
    });
    index += 1;
  }

  if (data.length < TABLE_CONTRACT.rows.minData) {
    throw fail(
      CODES.tableBounds,
      "table rows",
      `A table must contain at least ${TABLE_CONTRACT.rows.minData} data row after its header and delimiter.`,
      delimiterLine.number,
    );
  }

  return {
    node: {
      type: TABLE_NODE_TYPES.table,
      ...(caption === undefined ? {} : { attrs: { caption } }),
      content: [header, ...data],
    },
    next: index,
  };
}

// ---------------------------------------------------------------------------
// Top-level section containers
// ---------------------------------------------------------------------------

function sectionHeaderAttrs(text, line) {
  const match = SECTION_HEADER_RE.exec(text);
  if (!match) {
    throw fail(
      CODES.markdownSectionHeader,
      "section header",
      "A section header must be exactly ':::section {JSON object}' with no indentation or trailing text.",
      line.number,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch (error) {
    throw fail(
      CODES.markdownSectionHeader,
      "section header",
      "A section header must contain a valid JSON object.",
      line.number,
      error,
    );
  }
  if (!isPlainObject(parsed)) {
    throw fail(
      CODES.markdownSectionHeader,
      "section header",
      "A section header must contain a JSON object, not an array or scalar.",
      line.number,
    );
  }

  const definitions = FREE_FORM_SECTION_REGISTRY.section.attrs;
  for (const key of Object.keys(parsed)) {
    if (!Object.hasOwn(definitions, key)) {
      throw fail(
        CODES.attrUnknown,
        "section header",
        `Section attribute '${identifier(key)}' is not supported. Expected only ${
          Object.keys(definitions).join(", ")
        }.`,
        line.number,
      );
    }
  }

  const context = parsed.context;
  const contextDefinition = definitions.context;
  const contextPattern = new RegExp(contextDefinition.pattern, "u");
  if (
    context !== undefined
    && context !== null
    && (
      typeof context !== "string"
      || [...context].length > contextDefinition.maximumLength
      || !contextPattern.test(context)
    )
  ) {
    throw fail(
      CODES.attrInvalid,
      "section header",
      `Section context must match ${contextDefinition.pattern} and contain at most ${contextDefinition.maximumLength} characters.`,
      line.number,
    );
  }

  for (const name of ["contentPadding", "surface"]) {
    const definition = definitions[name];
    const value = parsed[name];
    if (value !== undefined && (typeof value !== "string" || !definition.values.includes(value))) {
      throw fail(
        CODES.attrInvalid,
        "section header",
        `Section ${name} must be one of ${definition.values.map((entry) => JSON.stringify(entry)).join(", ")}.`,
        line.number,
      );
    }
  }

  const normalizedDecoration = normalizeFreeFormSectionDecoration(
    parsed.decoration,
    "/attrs/decoration",
  );
  if (normalizedDecoration.errors.length > 0) {
    const [first] = normalizedDecoration.errors;
    throw fail(first.code, first.path, first.message, line.number);
  }

  const normalizedBackground = normalizeFreeFormSectionBackground(
    parsed.background,
    "/attrs/background",
  );
  if (normalizedBackground.errors.length > 0) {
    const [first] = normalizedBackground.errors;
    throw fail(first.code, first.path, first.message, line.number);
  }

  return {
    ...(typeof context === "string" ? { context } : {}),
    contentPadding: parsed.contentPadding ?? definitions.contentPadding.default,
    surface: parsed.surface ?? definitions.surface.default,
    ...(normalizedBackground.background ? { background: normalizedBackground.background } : {}),
    ...(normalizedDecoration.decoration ? { decoration: normalizedDecoration.decoration } : {}),
  };
}

function fenceClosing(delimiter) {
  return new RegExp(`^ {0,3}${delimiter[0] === "\`" ? "`" : "~"}{${delimiter.length},} *$`, "u");
}

async function consumeSection(lines, start, headerText, context, depth) {
  const line = lines[start];
  const attrs = sectionHeaderAttrs(headerText, line);
  const body = [];
  let index = start + 1;
  let activeFence;

  while (index < lines.length) {
    const bodyLine = lines[index];
    const text = expandLeadingTabs(bodyLine.text);
    if (activeFence) {
      body.push(bodyLine);
      if (activeFence.test(text)) activeFence = undefined;
      index += 1;
      continue;
    }
    const fence = FENCE_RE.exec(text);
    if (fence) {
      activeFence = fenceClosing(fence[2]);
      body.push(bodyLine);
      index += 1;
      continue;
    }
    if (SECTION_CLOSE_RE.test(text)) {
      const content = await parseBlocks(body, { ...context, blockPlacement: "section" }, depth + 1);
      if (content.length === 0) {
        throw fail(
          CODES.markdownEmpty,
          "section container",
          "A section container must contain at least one ordinary block.",
          line.number,
        );
      }
      return { node: { type: FREE_FORM_SECTION_REGISTRY.section.nodeType, attrs, content }, next: index + 1 };
    }
    if (SECTION_HEADER_LIKE_RE.test(text)) {
      throw fail(
        CODES.markdownSectionNested,
        "section container",
        "A section container cannot contain another section container.",
        bodyLine.number,
      );
    }
    body.push(bodyLine);
    index += 1;
  }

  throw fail(
    CODES.markdownSectionUnclosed,
    "section container",
    "A section container was opened but never closed with ':::'.",
    line.number,
  );
}

function stripClosingHashes(title) {
  const trimmed = title.trimEnd();
  const closing = /^(.*?)\s+#+$/u.exec(trimmed);
  if (closing) return closing[1].trimEnd();
  return /^#+$/u.test(trimmed) ? "" : trimmed;
}

// ---------------------------------------------------------------------------
// Fenced blocks: code, components, and inline facts
// ---------------------------------------------------------------------------

function consumeFence(lines, start, fence, context) {
  const [, indent, delimiter, rawInfo] = fence;
  const info = rawInfo.trim();
  const line = lines[start];
  const closing = fenceClosing(delimiter);
  const body = [];
  let index = start + 1;
  let closed = false;
  while (index < lines.length) {
    const text = lines[index].text;
    if (closing.test(expandLeadingTabs(text))) {
      closed = true;
      index += 1;
      break;
    }
    body.push(stripIndent(text, indent.length));
    index += 1;
  }
  if (!closed) {
    throw fail(
      CODES.markdownUnclosedFence,
      "fenced block",
      "A fenced block was opened but never closed.",
      line.number,
    );
  }

  if (info.startsWith("component:")) {
    return { node: componentNode(info.slice("component:".length).trim(), body.join("\n"), line), next: index };
  }
  if (info === INLINE_FACTS_CONTRACT.markdown.fence) {
    if (context.blockPlacement !== "root" && context.blockPlacement !== "section") {
      throw fail(
        CODES.markdownInlineFacts,
        "inline facts",
        "An inline-facts block is valid only at the document root or directly inside a top-level section.",
        line.number,
      );
    }
    return { node: inlineFactsNode(body.join("\n"), line), next: index };
  }
  if (info !== "" && !LANGUAGE_RE.test(info)) {
    throw fail(
      CODES.markdownCodeLanguage,
      "code fence info string",
      "A code fence takes a single language token; attributes and titles are outside the supported subset.",
      line.number,
    );
  }

  const attrs = info === "" ? undefined : { language: info };
  const text = body.join("\n");
  const node = { type: "codeBlock" };
  if (attrs) node.attrs = attrs;
  if (text !== "") node.content = [{ type: "text", text }];
  return { node, next: index };
}

function inlineFactsNode(body, line) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw fail(
      CODES.markdownInlineFacts,
      "inline facts",
      "An inline-facts fence body must be a valid JSON array.",
      line.number,
      error,
    );
  }
  const normalized = normalizeInlineFactsItems(parsed);
  if (normalized.errors.length > 0) {
    const [first] = normalized.errors;
    throw fail(first.code, first.path, first.message, line.number);
  }
  return {
    type: INLINE_FACTS_CONTRACT.nodeType,
    attrs: { items: normalized.items },
  };
}

function stripIndent(text, columns) {
  let removed = 0;
  let index = 0;
  while (index < text.length && removed < columns && text[index] === " ") {
    removed += 1;
    index += 1;
  }
  return text.slice(index);
}

function componentNode(componentType, body, line) {
  if (!isComponentType(componentType)) {
    throw fail(
      CODES.componentUnknown,
      "component block",
      `Unknown component type '${identifier(componentType)}' in a component fence.`,
      line.number,
    );
  }
  const source = body.trim() === "" ? "{}" : body;
  const errors = validateComponentBlock(componentType, source, "");
  if (errors.length > 0) {
    throw fail(errors[0].code, "component block", errors[0].message, line.number);
  }
  return {
    type: "componentBlock",
    attrs: {
      componentType,
      componentData: canonicalizeComponentData(componentType, JSON.parse(source)),
    },
  };
}

// ---------------------------------------------------------------------------
// Blockquotes
// ---------------------------------------------------------------------------

async function consumeBlockquote(lines, start, context, depth) {
  const inner = [];
  let index = start;
  while (index < lines.length) {
    const text = expandLeadingTabs(lines[index].text);
    if (BLOCKQUOTE_RE.test(text)) {
      inner.push({ text: text.replace(/^ {0,3}> ?/u, ""), number: lines[index].number });
      index += 1;
      continue;
    }
    // A lazy continuation line carries on the quoted paragraph; a blank line
    // or a new block ends the quote.
    if (isBlank(text) || isBlockStart(text) || inner.length === 0 || isBlank(inner[inner.length - 1].text)) break;
    inner.push({ text, number: lines[index].number });
    index += 1;
  }

  const content = await parseBlocks(inner, { ...context, blockPlacement: "nested" }, depth + 1);
  if (content.length === 0) {
    throw fail(
      CODES.markdownEmpty,
      "blockquote",
      "A blockquote must contain content.",
      lines[start].number,
    );
  }
  return { node: { type: "blockquote", content }, next: index };
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

function matchListMarker(text, line) {
  const bullet = BULLET_RE.exec(text);
  if (bullet) {
    const [, indent, marker, spacing, rest] = bullet;
    if (marker === "+") {
      throw fail(
        CODES.markdownListMarker,
        "list marker",
        "'+' bullets are outside the supported subset; use '-' or '*'.",
        line.number,
      );
    }
    return {
      ordered: false,
      indent: indent.length,
      contentIndent: indent.length + 1 + Math.max(spacing.length, 1),
      rest,
    };
  }

  const ordered = ORDERED_RE.exec(text);
  if (!ordered) return undefined;
  const [, indent, number, delimiter, spacing, rest] = ordered;
  if (delimiter === ")") {
    throw fail(
      CODES.markdownListMarker,
      "list marker",
      "')' ordered-list delimiters are outside the supported subset; use '1.'.",
      line.number,
    );
  }
  return {
    ordered: true,
    number: Number(number),
    indent: indent.length,
    contentIndent: indent.length + number.length + 1 + Math.max(spacing.length, 1),
    rest,
  };
}

async function consumeList(lines, start, first, context, depth) {
  if (first.ordered && first.number !== 1) {
    throw fail(
      CODES.markdownListStart,
      "ordered list start",
      `An ordered list must start at 1; the document model carries no start attribute, so '${first.number}.' `
        + "would publish as '1.'.",
      lines[start].number,
    );
  }

  const items = [];
  let index = start;
  let marker = first;
  while (index < lines.length) {
    if (items.length >= MAX_LIST_ITEMS) {
      throw fail(
        CODES.markdownNesting,
        "list",
        `A list may not exceed ${MAX_LIST_ITEMS} items.`,
        lines[index].number,
      );
    }
    const itemLine = lines[index];
    const itemLines = [{ text: marker.rest, number: itemLine.number }];
    index += 1;

    while (index < lines.length) {
      const text = expandLeadingTabs(lines[index].text);
      if (isBlank(text)) {
        itemLines.push({ text: "", number: lines[index].number });
        index += 1;
        continue;
      }
      if (indentOf(text) >= marker.contentIndent) {
        itemLines.push({ text: text.slice(marker.contentIndent), number: lines[index].number });
        index += 1;
        continue;
      }
      // A lazy continuation keeps a paragraph going; anything else ends the item.
      const previous = itemLines[itemLines.length - 1];
      if (!isBlockStart(text) && previous && !isBlank(previous.text)) {
        itemLines.push({ text, number: lines[index].number });
        index += 1;
        continue;
      }
      break;
    }

    while (itemLines.length > 0 && isBlank(itemLines[itemLines.length - 1].text)) itemLines.pop();
    items.push(await listItem(itemLines, itemLine, context, depth));

    // The next item has to be a marker of the same kind at the same indent.
    let lookahead = index;
    while (lookahead < lines.length && isBlank(expandLeadingTabs(lines[lookahead].text))) lookahead += 1;
    if (lookahead >= lines.length) break;
    const nextText = expandLeadingTabs(lines[lookahead].text);
    const nextMarker = matchListMarker(nextText, lines[lookahead]);
    if (!nextMarker || nextMarker.ordered !== first.ordered || nextMarker.indent !== first.indent) break;
    marker = nextMarker;
    index = lookahead;
  }

  return {
    node: { type: first.ordered ? "orderedList" : "bulletList", content: items },
    next: index,
  };
}

async function listItem(itemLines, itemLine, context, depth) {
  const content = await parseBlocks(itemLines, { ...context, blockPlacement: "nested" }, depth + 1);
  if (content.length === 0) return { type: "listItem", content: [{ type: "paragraph" }] };
  if (content[0].type !== "paragraph") {
    throw fail(
      CODES.markdownListItem,
      "list item",
      "A list item must begin with text; the editor's schema requires a paragraph first.",
      itemLine.number,
    );
  }
  return { type: "listItem", content };
}

// ---------------------------------------------------------------------------
// Paragraphs
// ---------------------------------------------------------------------------

async function consumeParagraph(lines, start, context) {
  const collected = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    const text = expandLeadingTabs(line.text);
    if (isBlank(text)) break;
    if (collected.length > 0) {
      if (SETEXT_RE.test(text)) {
        throw fail(
          CODES.markdownSetext,
          "setext heading",
          "Setext headings are outside the supported subset; use '#' or '##'.",
          line.number,
        );
      }
      if (tablePrelude(lines, index)) break;
      if (isBlockStart(text)) break;
    }
    guardBlockConstructs(text, line, index + 1 < lines.length ? expandLeadingTabs(lines[index + 1].text) : undefined);
    collected.push({ text: text.trim(), number: line.number, raw: text });
    index += 1;
  }

  const line = lines[start];
  const joined = joinParagraphLines(collected);
  const standalone = STANDALONE_IMAGE_RE.exec(joined);
  if (standalone) {
    return { node: await imageNode(standalone[1], standalone[2], context, line), next: index };
  }

  const content = parseInline(joined, context.scan, line.number, []);
  return { node: content.length > 0 ? { type: "paragraph", content } : undefined, next: index };
}

/**
 * Joins a paragraph's lines into one inline string. A line ending in two or
 * more spaces, or in a single backslash, is a hard break and becomes the
 * sentinel newline the inline scanner turns into a `hardBreak` node; any other
 * line ending is a soft break and becomes a space, exactly as the editor
 * stores continued text. Joining before the inline pass — rather than parsing
 * each line separately — is what lets `**bold` on one line close on the next.
 */
function joinParagraphLines(collected) {
  let joined = "";
  collected.forEach((entry, position) => {
    const last = position === collected.length - 1;
    const hardBySpaces = /[ ]{2,}$/u.test(entry.raw);
    const hardByBackslash = /(^|[^\\])\\$/u.test(entry.text);
    const text = hardByBackslash ? entry.text.slice(0, -1) : entry.text;
    joined += text;
    if (last) return;
    joined += hardBySpaces || hardByBackslash ? HARD_BREAK : " ";
  });
  return joined;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

const MARK_ORDER = new Map(MARK_TYPES.map((type, position) => [type, position]));

function sortMarks(marks) {
  return [...marks].sort((left, right) => MARK_ORDER.get(left.type) - MARK_ORDER.get(right.type));
}

function textNode(text, marks) {
  const node = { type: "text", text };
  if (marks.length > 0) node.marks = sortMarks(marks);
  return node;
}

function sameMarks(left, right) {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Merges adjacent text nodes carrying identical marks, as ProseMirror does. */
function mergeText(nodes) {
  const merged = [];
  for (const node of nodes) {
    const previous = merged[merged.length - 1];
    if (node.type === "text" && previous?.type === "text" && sameMarks(previous.marks, node.marks)) {
      previous.text += node.text;
      continue;
    }
    merged.push(node);
  }
  return merged;
}

/**
 * CommonMark's left-flanking rule, simplified: a delimiter opens emphasis only
 * when it is followed by non-whitespace and preceded by the start of the text,
 * whitespace, or punctuation. Without it, `a * b * c` becomes italics.
 */
function isFlanking(text, index, length) {
  const before = index === 0 ? "" : text[index - 1];
  const after = text[index + length] ?? "";
  if (after === "" || after.trim() === "") return false;
  return before === "" || before.trim() === "" || PUNCTUATION_RE.test(before);
}

/** The mirror image: a delimiter closes only when it follows non-whitespace. */
function isClosing(text, index, length) {
  const before = text[index - 1] ?? "";
  const after = text[index + length] ?? "";
  if (before === "" || before.trim() === "") return false;
  return after === "" || after.trim() === "" || PUNCTUATION_RE.test(after);
}

/**
 * The inline scanner's work budget, carried per conversion.
 *
 * Every delimiter search below is linear, and an *unclosed* delimiter searches
 * to the end of its block before giving up — so a block of nothing but openers
 * costs a scan per opener and the whole thing is quadratic. `markdownBytes`
 * bounds the input, not the work: at the 1 MB ceiling that is minutes of
 * synchronous CPU no caller could interrupt. Each scanning step is charged
 * against this counter, and exhausting it is a refusal rather than a hang.
 */
function createScanBudget() {
  return { remaining: CONTENT_LIMITS.inlineScanBudget };
}

function scanExhausted(lineNumber) {
  return fail(
    CODES.markdownInput,
    "inline scanning",
    "This document needs more inline scanning than one conversion will do. Shorten the block, or close the "
      + "unmatched '*', '_', '~', '`', '[', or '(' that is making the scanner search to the end of it.",
    lineNumber,
  );
}

/**
 * Finds the closing run of `delimiter`, skipping escapes and code spans so
 * `` `a * b` `` never closes an emphasis opened outside it.
 */
function findClosing(text, from, delimiter, underscore, scan, lineNumber) {
  let index = from;
  while (index < text.length) {
    if ((scan.remaining -= 1) < 0) throw scanExhausted(lineNumber);
    const character = text[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "`") {
      const span = matchCodeSpan(text, index, scan, lineNumber);
      index = span ? span.end : index + 1;
      continue;
    }
    if (text.startsWith(delimiter, index) && (!underscore || isClosing(text, index, delimiter.length))) {
      return index;
    }
    index += 1;
  }
  return -1;
}

function matchCodeSpan(text, start, scan, lineNumber) {
  let length = 0;
  while (text[start + length] === "`") length += 1;
  let index = start + length;
  while (index < text.length) {
    if ((scan.remaining -= 1) < 0) throw scanExhausted(lineNumber);
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
    let run = 0;
    while (text[index + run] === "`") run += 1;
    if (run === length) {
      return { start: start + length, end: index + length, content: text.slice(start + length, index) };
    }
    index += run;
  }
  return undefined;
}

function findLinkTextEnd(text, start, scan, lineNumber) {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    if ((scan.remaining -= 1) < 0) throw scanExhausted(lineNumber);
    const character = text[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "`") {
      const span = matchCodeSpan(text, index, scan, lineNumber);
      index = span ? span.end : index + 1;
      continue;
    }
    if (character === "[") depth += 1;
    if (character === "]") {
      if (depth === 0) return index;
      depth -= 1;
    }
    index += 1;
  }
  return -1;
}

function parseInline(text, scan, lineNumber, marks) {
  const nodes = [];
  let buffer = "";
  const flush = () => {
    if (buffer !== "") {
      nodes.push(textNode(buffer, marks));
      buffer = "";
    }
  };

  let index = 0;
  while (index < text.length) {
    const character = text[index];

    if (character === "\\") {
      const next = text[index + 1];
      if (next !== undefined && PUNCTUATION_RE.test(next)) {
        buffer += next;
        index += 2;
        continue;
      }
      buffer += character;
      index += 1;
      continue;
    }

    if (character === HARD_BREAK) {
      flush();
      nodes.push({ type: "hardBreak" });
      index += 1;
      continue;
    }

    if (character === "&" && ENTITY_RE.test(text.slice(index))) {
      throw fail(
        CODES.markdownEntity,
        "HTML entity",
        "HTML entities are outside the supported subset; write the character itself.",
        lineNumber,
      );
    }

    if (character === "<") {
      const rest = text.slice(index);
      if (AUTOLINK_RE.test(rest)) {
        throw fail(
          CODES.markdownAutolink,
          "autolink",
          "Autolinks are outside the supported subset; write [text](url).",
          lineNumber,
        );
      }
      if (HTML_TAG_RE.test(rest)) {
        throw fail(
          CODES.markdownHtml,
          "inline HTML",
          "Inline HTML is outside the supported subset; it would publish verbatim and unsanitised.",
          lineNumber,
        );
      }
      buffer += character;
      index += 1;
      continue;
    }

    if (character === "`") {
      const span = matchCodeSpan(text, index, scan, lineNumber);
      if (span) {
        flush();
        nodes.push(textNode(normalizeCodeSpan(span.content), [...marks, { type: "code" }]));
        index = span.end;
        continue;
      }
      buffer += character;
      index += 1;
      continue;
    }

    if (character === "!" && text[index + 1] === "[") {
      throw fail(
        CODES.markdownImage,
        "inline image",
        "An image must stand alone in its own block; the document model has no inline image.",
        lineNumber,
      );
    }

    if (character === "[") {
      if (text[index + 1] === "^") {
        throw fail(
          CODES.markdownFootnote,
          "footnote",
          "Footnotes are outside the supported Markdown subset.",
          lineNumber,
        );
      }
      const link = parseLink(text, index, scan, lineNumber, marks);
      if (link) {
        flush();
        nodes.push(...link.nodes);
        index = link.end;
        continue;
      }
      buffer += character;
      index += 1;
      continue;
    }

    const emphasis = parseEmphasis(text, index, scan, lineNumber, marks);
    if (emphasis) {
      flush();
      nodes.push(...emphasis.nodes);
      index = emphasis.end;
      continue;
    }

    buffer += character;
    index += 1;
  }

  flush();
  return mergeText(nodes);
}

/** CommonMark strips one space from each end of a code span that has both. */
function normalizeCodeSpan(content) {
  if (content.length > 2 && content.startsWith(" ") && content.endsWith(" ") && content.trim() !== "") {
    return content.slice(1, -1);
  }
  return content;
}

// Longest delimiter first: `***strong emphasis***` has to be recognised
// before the `**` and `*` runs inside it, or its asterisks end up as literal
// text either side of a half-marked run.
const EMPHASIS_DELIMITERS = Object.freeze([
  { delimiter: "***", types: Object.freeze(["bold", "italic"]), underscore: false },
  { delimiter: "___", types: Object.freeze(["bold", "italic"]), underscore: true },
  { delimiter: "~~", types: Object.freeze(["strike"]), underscore: false },
  { delimiter: "**", types: Object.freeze(["bold"]), underscore: false },
  { delimiter: "__", types: Object.freeze(["bold"]), underscore: true },
  { delimiter: "*", types: Object.freeze(["italic"]), underscore: false },
  { delimiter: "_", types: Object.freeze(["italic"]), underscore: true },
]);

function parseEmphasis(text, index, scan, lineNumber, marks) {
  for (const candidate of EMPHASIS_DELIMITERS) {
    if (!text.startsWith(candidate.delimiter, index)) continue;
    if (!isFlanking(text, index, candidate.delimiter.length)) continue;
    // `_` never opens emphasis inside a word, so snake_case_identifiers stay
    // literal instead of turning into silent italics.
    if (candidate.underscore && index > 0 && !/[\s\p{P}]/u.test(text[index - 1])) continue;
    if (candidate.types.some((type) => marks.some((mark) => mark.type === type))) continue;
    const from = index + candidate.delimiter.length;
    const close = findClosing(text, from, candidate.delimiter, candidate.underscore, scan, lineNumber);
    if (close < 0) continue;
    const inner = text.slice(from, close);
    if (inner.trim() === "") continue;
    return {
      nodes: parseInline(inner, scan, lineNumber, [...marks, ...candidate.types.map((type) => ({ type }))]),
      end: close + candidate.delimiter.length,
    };
  }
  return undefined;
}

function parseLink(text, index, scan, lineNumber, marks) {
  const textEnd = findLinkTextEnd(text, index + 1, scan, lineNumber);
  if (textEnd < 0) return undefined;
  const after = text[textEnd + 1];
  if (after === "[") {
    throw fail(
      CODES.markdownReferenceLink,
      "reference link",
      "Reference-style links are outside the supported subset; write the URL inline.",
      lineNumber,
    );
  }
  if (after !== "(") return undefined;

  const destinationEnd = findDestinationEnd(text, textEnd + 2, scan, lineNumber);
  if (destinationEnd < 0) return undefined;
  const destination = text.slice(textEnd + 2, destinationEnd).trim();
  if (marks.some((mark) => mark.type === "link")) {
    throw fail(CODES.markdownLink, "link", "Links cannot be nested.", lineNumber);
  }
  if (destination.startsWith("<")) {
    throw fail(
      CODES.markdownLink,
      "link",
      "Pointy-bracket link destinations are outside the supported subset; write the URL directly.",
      lineNumber,
    );
  }
  if (/\s/u.test(destination)) {
    throw fail(
      CODES.markdownLink,
      "link",
      "Link titles are outside the supported subset; the document model has nowhere to put one.",
      lineNumber,
    );
  }
  if (destination === "" || !isSafeUrl(destination)) {
    throw fail(
      CODES.markdownLink,
      "link",
      "A link destination must be a safe HTTP(S), mailto, tel, non-protocol-relative root, fragment, query, or relative URL without backslashes or ASCII controls; the renderer drops an unsafe link and publishes only its text.",
      lineNumber,
    );
  }

  const inner = text.slice(index + 1, textEnd);
  const nodes = parseInline(inner, scan, lineNumber, [...marks, { type: "link", attrs: { href: destination } }]);
  if (nodes.length === 0) {
    throw fail(CODES.markdownLink, "link", "A link must have text.", lineNumber);
  }
  return { nodes, end: destinationEnd + 1 };
}

// The same unbounded scan as `findLinkTextEnd`, and quadratic for the same
// reason: an unbalanced opening parenthesis searches to the end of the block.
function findDestinationEnd(text, from, scan, lineNumber) {
  let depth = 0;
  let index = from;
  while (index < text.length) {
    if ((scan.remaining -= 1) < 0) throw scanExhausted(lineNumber);
    const character = text[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") {
      if (depth === 0) return index;
      depth -= 1;
    }
    index += 1;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

function unescapePunctuation(text) {
  return text.replace(/\\([!-/:-@[-`{-~])/gu, "$1");
}

/**
 * Builds a `taprootImage` node from `![alt](reference)`.
 *
 * The node **always** carries `"src": ""` and `"urls": []`, whatever the
 * resolver reported for delivery URLs.
 * `PageImageDeliveryRewriter.ReplaceUrlFields` rewrites `src`/`url`/`urls`
 * only where the key already exists, filling them from the site's signed
 * delivery URLs at read time — so the key must be there and its value must not
 * be a URL this CLI invented. An image node missing the keys is rewritten into
 * nothing and renders blank; one carrying a hand-built URL renders a link the
 * site cannot sign.
 */
async function imageNode(alt, reference, context, line) {
  const source = unescapePunctuation(reference);
  if (source.length > CONTENT_LIMITS.imageReferenceLength) {
    throw fail(CODES.markdownImage, "image", "The image reference is too long.", line.number);
  }

  let resolved;
  try {
    resolved = await context.resolveImage(source);
  } catch (error) {
    // The resolver talks to the API, so its message can carry a presigned URL
    // or the credential. It travels as `cause` and never into the diagnostic.
    throw fail(
      CODES.markdownImage,
      "image",
      `The image '${identifier(source)}' could not be resolved. Upload it with 'media upload' first.`,
      line.number,
      error,
    );
  }
  if (!isPlainObject(resolved) || !isUuid(resolved.imageId)) {
    throw fail(
      CODES.markdownImage,
      "image",
      `Resolving the image '${identifier(source)}' produced no image id.`,
      line.number,
    );
  }

  const attrs = {
    imageId: resolved.imageId,
    src: "",
    urls: [],
    alt: unescapePunctuation(alt) || (typeof resolved.alt === "string" ? resolved.alt : ""),
  };
  if (Number.isInteger(resolved.width) && resolved.width > 0) attrs.width = resolved.width;
  if (Number.isInteger(resolved.height) && resolved.height > 0) attrs.height = resolved.height;
  return { type: "taprootImage", attrs };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * The converter's own gate. Every document this module returns has been
 * through `validateDocument`, so a converter bug surfaces here — named, with
 * the offending path — rather than as a page that publishes and renders wrong.
 * Exported for the tests that prove the gate is wired, not for callers.
 */
export function assertConvertedDocument(document) {
  const { errors } = validateDocument(document);
  if (errors.length === 0) return;
  const [first] = errors;
  throw new SiteAuthoringError(
    CODES.markdownInvariant,
    `The converted document failed validation at '${first.path}' with ${first.code}. `
      + "That is a bug in the Markdown converter, not in the source document.",
    { field: first.code },
  );
}

/**
 * Converts a Markdown document into a ProseMirror page body.
 *
 * `resolveImage(reference)` is called once per image with the raw reference
 * from `![alt](reference)` and must resolve to `{ imageId, src, urls, width,
 * height, alt }` — an already-uploaded image, resolved by `media upload` — or
 * throw. Only `imageId`, `width`, `height`, and `alt` are read: see
 * `imageNode` for why the delivery hints are deliberately discarded.
 */
export async function markdownToProseMirror(markdown, options = {}) {
  const resolveImage = options?.resolveImage;
  if (typeof resolveImage !== "function") {
    throw fail(
      CODES.markdownResolveImage,
      "resolveImage",
      "markdownToProseMirror requires a resolveImage(reference) callback.",
    );
  }
  if (typeof markdown !== "string") {
    throw fail(CODES.markdownInput, "markdown", "The Markdown source must be a string.");
  }
  if (Buffer.byteLength(markdown, "utf8") > CONTENT_LIMITS.markdownBytes) {
    throw fail(
      CODES.markdownInput,
      "markdown",
      `The Markdown source exceeds ${CONTENT_LIMITS.markdownBytes} bytes.`,
    );
  }

  const lines = toLines(markdown);
  rejectFrontMatter(lines);
  const content = await parseBlocks(
    lines,
    { resolveImage, scan: createScanBudget(), blockPlacement: "root" },
    0,
  );
  const document = { type: "doc", content };
  if (!documentIsPresent(document)) {
    throw fail(
      CODES.markdownEmpty,
      "document",
      "The Markdown source produced an empty page body. A page needs text, an image, a component block, or inline facts.",
    );
  }
  assertConvertedDocument(document);
  return { doc: document };
}
