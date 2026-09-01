/**
 * Shared ProseMirror JSON helpers for Taproot rich-text page bodies.
 *
 * This is the canonical publishing source. The generator and site-authoring
 * package keep local copies because importing across project roots changes
 * TypeScript output structure or falls outside Docker/package boundaries.
 * Keep those publishing copies in sync and covered by parity tests.
 */

import freeFormSectionRegistry from "./free-form-section-registry.json" with { type: "json" };

export const TIPTAP_SITE_DEFAULT = "site-default";
export const DEFAULT_TIPTAP_IMAGE_MAX_HEIGHT_VH = 60;
export const TIPTAP_IMAGE_MAX_HEIGHT_OPTIONS = [45, 60, 75, 90] as const;
const SECTION_CONTEXT_PATTERN = new RegExp(
  freeFormSectionRegistry.section.attrs.context.pattern,
  "u",
);

export type TiptapSiteDefault = typeof TIPTAP_SITE_DEFAULT;
export type TiptapImageMaxHeightVh = typeof TIPTAP_IMAGE_MAX_HEIGHT_OPTIONS[number];
export type TiptapImagePresentationPlacement =
  | "left"
  | "left-text-right"
  | "center"
  | "right"
  | "right-text-left";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ProseMirrorMark {
  type: string;
  attrs?: Record<string, JsonValue | undefined>;
}

export interface ProseMirrorNode {
  type: string;
  attrs?: Record<string, JsonValue | undefined>;
  content?: ProseMirrorNode[];
  marks?: ProseMirrorMark[];
  text?: string;
}

export interface ProseMirrorDocument extends ProseMirrorNode {
  type: "doc";
  content?: ProseMirrorNode[];
}

export interface RenderProseMirrorOptions {
  /** Normalize free-form root flow into full-bleed Espalier sections. */
  freeFormSections?: boolean;
  imageDefaults?: {
    placement?: TiptapImagePresentationPlacement | string | null;
    maxHeightVh?: TiptapImageMaxHeightVh | number | null;
  };
}

export function createEmptyProseMirrorDocument(): ProseMirrorDocument {
  return {
    type: "doc",
    content: [{ type: "paragraph" }],
  };
}

export function isProseMirrorDocument(value: unknown): value is ProseMirrorDocument {
  if (!isRecord(value)) return false;
  if (value.type !== "doc") return false;
  return value.content === undefined || Array.isArray(value.content);
}

export function renderProseMirrorDocumentToHtml(
  document: ProseMirrorDocument | null | undefined,
  options: RenderProseMirrorOptions = {},
): string {
  if (!document?.content?.length) return "";
  return options.freeFormSections
    ? renderFreeFormRootNodes(document.content, options)
    : renderNodes(document.content, options, "root");
}

export function renderRichTextBodyToHtml(
  body: unknown,
  options: RenderProseMirrorOptions = {},
): string {
  if (typeof body === "string") return body;
  if (!isProseMirrorDocument(body)) return "";
  return renderProseMirrorDocumentToHtml(body, options);
}

type RenderPlacement = "root" | "section" | "nested";

function renderNodes(
  nodes: readonly ProseMirrorNode[],
  options: RenderProseMirrorOptions,
  placement: RenderPlacement,
): string {
  return nodes.map((node) => renderNode(node, options, placement)).join("");
}

function renderFreeFormRootNodes(
  nodes: readonly ProseMirrorNode[],
  options: RenderProseMirrorOptions,
): string {
  const rendered: string[] = [];
  let flow: ProseMirrorNode[] = [];
  const flushFlow = () => {
    if (flow.length === 0) return;
    rendered.push(renderSection(flow, {}, "implicit", options, "root"));
    flow = [];
  };

  for (const node of nodes) {
    if (node.type === freeFormSectionRegistry.section.nodeType || isRootBandComponent(node)) {
      flushFlow();
      rendered.push(renderNode(node, options, "root"));
      continue;
    }
    flow.push(node);
  }
  flushFlow();
  return rendered.join("");
}

function isRootBandComponent(node: ProseMirrorNode): boolean {
  if (node.type !== "componentBlock") return false;
  const componentType = stringAttr(node.attrs?.componentType);
  if (!componentType || !Object.prototype.hasOwnProperty.call(freeFormSectionRegistry.components, componentType)) {
    return false;
  }
  return freeFormSectionRegistry.components[componentType as keyof typeof freeFormSectionRegistry.components]
    .rootPlacement === "root-band";
}

function renderNode(
  node: ProseMirrorNode,
  options: RenderProseMirrorOptions,
  placement: RenderPlacement,
): string {
  switch (node.type) {
    case "doc":
      return renderNodes(node.content ?? [], options, "nested");
    case "paragraph":
      return renderElement(
        "p",
        withProseMeasure(textBlockAttrs(node.attrs), node.type, options),
        renderNodes(node.content ?? [], options, "nested"),
      );
    case "text":
      return renderTextNode(node);
    case "hardBreak":
      return "<br>";
    case "heading":
      return renderHeading(node, options);
    case "bulletList":
      return renderElement(
        "ul",
        withProseMeasure({}, node.type, options),
        renderNodes(node.content ?? [], options, "nested"),
      );
    case "orderedList":
      return renderElement(
        "ol",
        withProseMeasure({}, node.type, options),
        renderNodes(node.content ?? [], options, "nested"),
      );
    case "listItem":
      return renderElement("li", {}, renderNodes(node.content ?? [], options, "nested"));
    case "blockquote":
      return renderElement(
        "blockquote",
        withProseMeasure({}, node.type, options),
        renderNodes(node.content ?? [], options, "nested"),
      );
    case "codeBlock":
      return renderCodeBlock(node, options);
    case "horizontalRule":
      return "<hr>";
    case "table":
      return placement === "root" || placement === "section" ? renderTable(node, options) : "";
    case "taprootImage":
      return renderTaprootImage(node, options);
    case "inlineFacts":
      return renderInlineFacts(node, options, placement);
    case "componentBlock":
      return renderComponentBlock(node);
    case "section":
      return renderSection(
        node.content ?? [],
        node.attrs ?? {},
        "explicit",
        options,
        placement === "root" ? "section" : "nested",
      );
    case "rawHtml":
      return stringAttr(node.attrs?.html) ?? "";
    default:
      return renderNodes(node.content ?? [], options, "nested");
  }
}

function renderTextNode(node: ProseMirrorNode): string {
  let rendered = escapeHtml(node.text ?? "");
  for (const mark of node.marks ?? []) {
    rendered = wrapMark(rendered, mark);
  }
  return rendered;
}

function wrapMark(html: string, mark: ProseMirrorMark): string {
  switch (mark.type) {
    case "bold":
      return `<strong>${html}</strong>`;
    case "italic":
      return `<em>${html}</em>`;
    case "underline":
      return `<u>${html}</u>`;
    case "strike":
      return `<s>${html}</s>`;
    case "code":
      return `<code>${html}</code>`;
    case "link": {
      const href = stringAttr(mark.attrs?.href);
      if (!href || !isSafeUrl(href)) return html;
      return renderElement(
        "a",
        {
          href,
          rel: "noopener noreferrer nofollow",
        },
        html,
      );
    }
    default:
      return html;
  }
}

function renderHeading(node: ProseMirrorNode, options: RenderProseMirrorOptions): string {
  const rawLevel = numberAttr(node.attrs?.level) ?? 1;
  const level = Math.min(4, Math.max(1, Math.trunc(rawLevel)));
  return renderElement(
    `h${level}`,
    withProseMeasure(textBlockAttrs(node.attrs), node.type, options),
    renderNodes(node.content ?? [], options, "nested"),
  );
}

function renderCodeBlock(node: ProseMirrorNode, options: RenderProseMirrorOptions): string {
  const language = stringAttr(node.attrs?.language);
  const attrs = language ? { class: `language-${language}` } : {};
  const text = (node.content ?? [])
    .map((child) => child.text ?? "")
    .join("");
  return `<pre${serializeAttributes(withProseMeasure({}, node.type, options))}><code${serializeAttributes(attrs)}>${
    escapeHtml(text)
  }</code></pre>`;
}

type NormalizedTable = {
  caption?: string;
  headerCells: string[];
  dataRows: string[][];
};

/**
 * Render the closed table contract only after re-checking its complete shape.
 * Publish readiness provides detailed diagnostics; display-only callers can
 * also receive stored JSON directly, so the renderer's safe failure is to
 * omit one malformed table rather than reinterpret arbitrary blocks as cells.
 */
function renderTable(node: ProseMirrorNode, options: RenderProseMirrorOptions): string {
  const table = normalizeTable(node);
  if (!table) return "";

  const header = renderElement(
    "thead",
    {},
    renderElement(
      "tr",
      {},
      table.headerCells.map((cell) => renderElement("th", { scope: "col" }, cell)).join(""),
    ),
  );
  const body = renderElement(
    "tbody",
    {},
    table.dataRows.map((row) =>
      renderElement(
        "tr",
        {},
        row.map((cell) => renderElement("td", {}, cell)).join(""),
      )
    ).join(""),
  );
  const caption = table.caption === undefined
    ? ""
    : renderElement("caption", {}, escapeHtml(table.caption));
  const accessibleLabel = table.caption === undefined
    ? "Scrollable table"
    : `Scrollable table: ${table.caption}`;

  return renderElement(
    "div",
    withProseMeasure(
      {
        class: "taproot-table-scroll",
        role: "region",
        tabindex: "0",
        "aria-label": accessibleLabel,
      },
      node.type,
      options,
    ),
    renderElement("table", {}, `${caption}${header}${body}`),
  );
}

function normalizeTable(node: ProseMirrorNode): NormalizedTable | undefined {
  const definition = freeFormSectionRegistry.table;
  if (!hasOnlySerializedKeys(node, ["type", "attrs", "content"])) return undefined;
  const attrs = node.attrs;
  if (attrs !== undefined && attrs !== null && (!isRecord(attrs) || !hasOnlyKeys(attrs, ["caption"]))) {
    return undefined;
  }

  const captionValue = attrs && hasOwn(attrs, "caption") ? attrs.caption : undefined;
  if (
    captionValue !== undefined
    && captionValue !== null
    && (
      typeof captionValue !== "string"
      || captionValue.trim() === ""
      || countUnicodeScalars(captionValue) < definition.attrs.caption.minScalars
      || countUnicodeScalars(captionValue) > definition.attrs.caption.maxScalars
    )
  ) return undefined;

  if (!Array.isArray(node.content)) return undefined;
  const minimumRows = definition.rows.header + definition.rows.minData;
  const maximumRows = definition.rows.header + definition.rows.maxData;
  if (node.content.length < minimumRows || node.content.length > maximumRows) return undefined;

  const [headerRow, ...dataRows] = node.content;
  if (
    !isRecord(headerRow)
    || !hasOnlySerializedKeys(headerRow, ["type", "attrs", "content"])
    || headerRow.type !== definition.nodeTypes.row
    || !hasNoAttrs(headerRow)
  ) {
    return undefined;
  }
  if (!Array.isArray(headerRow.content)) return undefined;
  const columnCount = headerRow.content.length;
  if (columnCount < definition.columns.min || columnCount > definition.columns.max) {
    return undefined;
  }

  const headerCells = normalizeTableRow(headerRow, definition.nodeTypes.header, true);
  if (!headerCells) return undefined;
  const normalizedDataRows: string[][] = [];
  for (const row of dataRows) {
    if (
      !isRecord(row)
      || !hasOnlySerializedKeys(row, ["type", "attrs", "content"])
      || row.type !== definition.nodeTypes.row
      || !hasNoAttrs(row)
      || !Array.isArray(row.content)
      || row.content.length !== columnCount
    ) return undefined;
    const normalized = normalizeTableRow(row, definition.nodeTypes.cell, false);
    if (!normalized) return undefined;
    normalizedDataRows.push(normalized);
  }

  return {
    ...(typeof captionValue === "string" ? { caption: captionValue } : {}),
    headerCells,
    dataRows: normalizedDataRows,
  };
}

function normalizeTableRow(
  row: ProseMirrorNode,
  expectedCellType: string,
  header: boolean,
): string[] | undefined {
  if (!Array.isArray(row.content)) return undefined;
  const cells: string[] = [];
  for (const cell of row.content) {
    if (
      !isRecord(cell)
      || !hasOnlySerializedKeys(cell, ["type", "attrs", "content"])
      || cell.type !== expectedCellType
      || !hasNoAttrs(cell)
    ) return undefined;
    const normalized = normalizeTableCell(cell);
    if (!normalized) return undefined;
    if (header && freeFormSectionRegistry.table.cells.headerNonWhitespace && normalized.text.trim() === "") {
      return undefined;
    }
    cells.push(normalized.html);
  }
  return cells;
}

function normalizeTableCell(cell: ProseMirrorNode): { html: string; text: string } | undefined {
  const paragraphs = cell.content;
  const paragraph = paragraphs?.[0];
  if (
    !Array.isArray(paragraphs)
    || paragraphs.length !== freeFormSectionRegistry.table.cells.paragraphs
    || !isRecord(paragraph)
    || !hasOnlySerializedKeys(paragraph, ["type", "attrs", "content"])
    || paragraph.type !== "paragraph"
    || (!freeFormSectionRegistry.table.cells.paragraphAttrs && !hasNoAttrs(paragraph))
  ) return undefined;

  const inlineContent = paragraph.content;
  if (inlineContent !== undefined && inlineContent !== null && !Array.isArray(inlineContent)) return undefined;
  const inlineNodes = inlineContent ?? [];
  const allowedInlineNodes = freeFormSectionRegistry.table.cells.inlineNodes as readonly string[];
  const allowedMarks = freeFormSectionRegistry.table.cells.marks as readonly string[];
  let text = "";
  const html: string[] = [];
  for (const inlineNode of inlineNodes) {
    if (!isRecord(inlineNode) || !allowedInlineNodes.includes(inlineNode.type)) return undefined;
    if (!validTableMarks(inlineNode.marks, allowedMarks)) return undefined;
    if (inlineNode.type === "text") {
      if (
        !hasOnlySerializedKeys(inlineNode, ["type", "attrs", "marks", "text"])
        || !hasNoAttrs(inlineNode)
        || typeof inlineNode.text !== "string"
        || inlineNode.text === ""
      ) return undefined;
      text += inlineNode.text;
      html.push(renderTextNode(inlineNode));
    } else if (inlineNode.type === "hardBreak") {
      if (
        !hasOnlySerializedKeys(inlineNode, ["type", "attrs", "marks"])
        || !hasNoAttrs(inlineNode)
      ) return undefined;
      html.push("<br>");
    }
  }
  if (countUnicodeScalars(text) > freeFormSectionRegistry.table.cells.maxTextScalars) {
    return undefined;
  }
  return { html: html.join(""), text };
}

const TABLE_LINK_ATTRS = ["href", "target", "rel", "class", "title"] as const;

function validTableMarks(marks: unknown, allowedMarks: readonly string[]): boolean {
  if (marks === undefined || marks === null) return true;
  if (!Array.isArray(marks)) return false;
  const seen = new Set<string>();
  for (const mark of marks) {
    const markType = isRecord(mark) ? stringAttr(mark.type) : undefined;
    if (
      !isRecord(mark)
      || !hasOnlySerializedKeys(mark, ["type", "attrs"])
      || !markType
      || !allowedMarks.includes(markType)
      || seen.has(markType)
    ) return false;
    seen.add(markType);
    const attrs = mark.attrs;
    if (markType !== "link") {
      if (attrs !== undefined && attrs !== null && (!isRecord(attrs) || Object.keys(attrs).length > 0)) return false;
      continue;
    }
    if (!isRecord(attrs) || typeof attrs.href !== "string" || attrs.href === "") return false;
    if (!hasOnlyKeys(attrs, TABLE_LINK_ATTRS)) return false;
    if (
      TABLE_LINK_ATTRS.slice(1).some((key) =>
        attrs[key] !== undefined && attrs[key] !== null && typeof attrs[key] !== "string"
      )
    ) return false;
  }
  return true;
}

function hasOnlySerializedKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function hasNoAttrs(node: ProseMirrorNode): boolean {
  return node.attrs === undefined || node.attrs === null
    || (isRecord(node.attrs) && Object.keys(node.attrs).length === 0);
}

function countUnicodeScalars(value: string): number {
  return [...value].length;
}

type NormalizedInlineFact = {
  value: string;
  label: string;
  url?: string;
};

function renderInlineFacts(
  node: ProseMirrorNode,
  options: RenderProseMirrorOptions,
  placement: RenderPlacement,
): string {
  if (placement !== "root" && placement !== "section") return "";
  const facts = normalizeInlineFacts(node);
  if (!facts) return "";
  const items = facts.map((fact) => {
    const value = fact.url
      ? renderElement("a", { href: fact.url }, escapeHtml(fact.value))
      : escapeHtml(fact.value);
    return renderElement(
      "div",
      { class: "taproot-inline-fact" },
      `${renderElement("dt", { class: "taproot-inline-fact__label" }, escapeHtml(fact.label))}${
        renderElement("dd", { class: "taproot-inline-fact__value" }, value)
      }`,
    );
  }).join("");
  return renderElement(
    "dl",
    withProseMeasure({ class: "taproot-inline-facts" }, node.type, options),
    items,
  );
}

function normalizeInlineFacts(node: ProseMirrorNode): NormalizedInlineFact[] | undefined {
  const definition = freeFormSectionRegistry.inlineFacts.attrs.items;
  if (
    !hasOnlySerializedKeys(node, ["type", "attrs"])
    || !isRecord(node.attrs)
    || !hasOnlyKeys(node.attrs, ["items"])
    || !hasOwn(node.attrs, "items")
    || !Array.isArray(node.attrs.items)
    || node.attrs.items.length < definition.minItems
    || node.attrs.items.length > definition.maxItems
  ) return undefined;

  const fieldKeys = Object.keys(definition.fields);
  const facts: NormalizedInlineFact[] = [];
  for (const value of node.attrs.items) {
    if (!isRecord(value) || !hasOnlyKeys(value, fieldKeys)) return undefined;
    const factValue = stringAttr(value.value);
    const label = stringAttr(value.label);
    if (
      !factValue
      || !label
      || factValue.trim() === ""
      || label.trim() === ""
      || countUnicodeScalars(factValue) > definition.fields.value.maxScalars
      || countUnicodeScalars(label) > definition.fields.label.maxScalars
    ) return undefined;
    const url = value.url === undefined || value.url === null ? undefined : stringAttr(value.url);
    if (value.url !== undefined && value.url !== null && (!url || !isSafeUrl(url))) return undefined;
    facts.push({ value: factValue, label, url });
  }
  return facts;
}

function renderSection(
  nodes: readonly ProseMirrorNode[],
  attrs: Record<string, JsonValue | undefined>,
  kind: "explicit" | "implicit",
  options: RenderProseMirrorOptions,
  contentPlacement: RenderPlacement,
): string {
  const definitions = freeFormSectionRegistry.section.attrs;
  const contentPadding = attrs.contentPadding === "none" ? "none" : definitions.contentPadding.default;
  const surface = attrs.surface === "raised" || attrs.surface === "elevated"
    ? attrs.surface
    : definitions.surface.default;
  const contextValue = kind === "explicit" ? stringAttr(attrs.context) : undefined;
  const context = contextValue
      && countUnicodeScalars(contextValue) <= definitions.context.maximumLength
      && SECTION_CONTEXT_PATTERN.test(contextValue)
    ? contextValue
    : undefined;
  const sectionStyleParts: string[] = [];
  if (contentPadding === "none") {
    sectionStyleParts.push(
      "--esp-section-max-width: none",
      "--esp-section-padding-inline: 0",
      "--esp-section-padding-block: 0",
    );
  }
  if (kind === "explicit") {
    const decorationStyle = normalizedSectionDecorationStyle(attrs.decoration);
    if (decorationStyle) sectionStyleParts.push(...decorationStyle);
  }
  const background = kind === "explicit" ? normalizeSectionBackground(attrs.background) : undefined;
  if (background) {
    sectionStyleParts.push(
      `--esp-section-background: color-mix(in oklab, var(--esp-color-background) ${background.scrimOpacityPercent}%, transparent)`,
    );
  }
  const sectionStyle = sectionStyleParts.length > 0 ? sectionStyleParts.join("; ") : undefined;
  const content = renderElement(
    "div",
    { "data-section-content": true },
    renderNodes(nodes, options, contentPlacement),
  );
  const surfaced = surface === "none"
    ? content
    : renderElement(
      "esp-box",
      {
        "data-surface": surface,
        style: surface === "elevated"
          ? "--esp-color-box-background: var(--esp-color-layer-2); --esp-box-shadow: var(--esp-shadow-2)"
          : undefined,
      },
      content,
    );
  const section = renderElement(
    "esp-section",
    {
      "data-taproot-section": kind,
      "data-content-padding": contentPadding,
      "data-surface": surface,
      context,
      style: sectionStyle,
    },
    surfaced,
  );
  if (!background) return section;

  return renderElement(
    "div",
    {
      "data-taproot-section-background": true,
      style:
        `--taproot-section-focus: ${background.focus}; --taproot-section-portrait-focus: ${background.portraitFocus}`,
    },
    `${renderSectionBackgroundPicture(background)}${section}`,
  );
}

type NormalizedSectionImage = {
  src: string;
  urls: Array<{ minWidth: number; url: string }>;
  width?: number;
  height?: number;
  alt?: string;
};

type NormalizedSectionBackground = {
  image: NormalizedSectionImage;
  portraitImage?: NormalizedSectionImage;
  focus: string;
  portraitFocus: string;
  scrimOpacityPercent: number;
};

type SectionImageDefinition = {
  requiredKeys: readonly string[];
  optionalKeys: readonly string[];
  urls: {
    minItems: number;
    maxItems: number;
    fields: {
      minWidth: { minimum: number };
      type: { values: readonly string[] };
    };
  };
  srcMustMatchUrls: boolean;
};

function normalizeSectionBackground(value: unknown): NormalizedSectionBackground | undefined {
  if (!isRecord(value)) return undefined;
  const definition = freeFormSectionRegistry.section.attrs.background;
  const fields = definition.fields;
  if (!hasOnlyKeys(value, Object.keys(fields))) return undefined;

  const image = normalizeSectionImage(value.image, fields.image);
  if (!image) return undefined;
  const portraitImage = value.portraitImage === undefined || value.portraitImage === null
    ? undefined
    : normalizeSectionImage(value.portraitImage, fields.portraitImage);
  if (value.portraitImage !== undefined && value.portraitImage !== null && !portraitImage) return undefined;

  const focus = normalizeSectionFocus(value.focus, fields.focus);
  if (!focus) return undefined;
  const portraitFocus = value.portraitFocus === undefined || value.portraitFocus === null
    ? focus
    : normalizeSectionFocus(value.portraitFocus, fields.portraitFocus);
  if (!portraitFocus) return undefined;

  const scrimStrength = value.scrimStrength ?? fields.scrimStrength.default;
  if (typeof scrimStrength !== "string" || !fields.scrimStrength.values.includes(scrimStrength as never)) {
    return undefined;
  }
  const opacity = fields.scrimStrength.opacityByValue[
    scrimStrength as keyof typeof fields.scrimStrength.opacityByValue
  ];
  if (typeof opacity !== "number") return undefined;

  return {
    image,
    portraitImage,
    focus,
    portraitFocus,
    scrimOpacityPercent: Number((opacity * 100).toFixed(4)),
  };
}

function normalizeSectionImage(
  value: unknown,
  definition: SectionImageDefinition,
): NormalizedSectionImage | undefined {
  if (!isRecord(value)) return undefined;
  const keys = [...definition.requiredKeys, ...definition.optionalKeys];
  if (!hasOnlyKeys(value, keys) || definition.requiredKeys.some((key) => !hasOwn(value, key))) return undefined;
  if (!isCanonicalUuid(value.imageId)) return undefined;
  const src = stringAttr(value.src);
  if (!src || !isSafeSectionImageUrl(src)) return undefined;
  if (
    !Array.isArray(value.urls)
    || value.urls.length < definition.urls.minItems
    || value.urls.length > definition.urls.maxItems
  ) return undefined;
  const urls = value.urls.map((candidate) => normalizeSectionResponsiveUrl(candidate, definition.urls));
  if (urls.some((candidate) => !candidate)) return undefined;
  const candidates = (urls as Array<{ minWidth: number; url: string }>)
    .sort((left, right) => left.minWidth - right.minWidth);
  if (definition.srcMustMatchUrls && !candidates.some((candidate) => candidate.url === src)) return undefined;
  if (
    (hasOwn(value, "width") && !isPositiveInteger(value.width))
    || (hasOwn(value, "height") && !isPositiveInteger(value.height))
    || (hasOwn(value, "alt") && typeof value.alt !== "string")
  ) return undefined;
  return {
    src,
    urls: candidates,
    width: isPositiveInteger(value.width) ? value.width : undefined,
    height: isPositiveInteger(value.height) ? value.height : undefined,
    alt: typeof value.alt === "string" ? value.alt : undefined,
  };
}

function normalizeSectionResponsiveUrl(
  value: unknown,
  definition: SectionImageDefinition["urls"],
): { minWidth: number; url: string } | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, Object.keys(definition.fields))) return undefined;
  if (
    !isPositiveInteger(value.minWidth)
    || value.minWidth < definition.fields.minWidth.minimum
    || typeof value.url !== "string"
    || !isSafeSectionImageUrl(value.url)
  ) {
    return undefined;
  }
  if (
    value.type !== undefined
    && (typeof value.type !== "string" || !definition.fields.type.values.includes(value.type))
  ) return undefined;
  return { minWidth: value.minWidth, url: value.url };
}

function normalizeSectionFocus(
  value: unknown,
  definition: {
    default: { x: number; y: number } | null;
    fields: {
      x: { default: number; minimum: number; maximum: number };
      y: { default: number; minimum: number; maximum: number };
    };
  },
): string | undefined {
  if (value === undefined || value === null) {
    if (!definition.default) return undefined;
    return `${definition.default.x * 100}% ${definition.default.y * 100}%`;
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ["x", "y"])) return undefined;
  const x = value.x ?? definition.fields.x.default;
  const y = value.y ?? definition.fields.y.default;
  if (
    !isBoundedNumber(x, definition.fields.x.minimum, definition.fields.x.maximum)
    || !isBoundedNumber(y, definition.fields.y.minimum, definition.fields.y.maximum)
  ) return undefined;
  return `${x * 100}% ${y * 100}%`;
}

function renderSectionBackgroundPicture(background: NormalizedSectionBackground): string {
  const portraitSource = background.portraitImage
    ? renderVoidElement("source", {
      media: "(max-width: 48rem)",
      srcset: sectionImageSrcset(background.portraitImage),
      sizes: "100vw",
      type: "image/webp",
    })
    : "";
  const image = renderVoidElement("img", {
    src: background.image.src,
    srcset: sectionImageSrcset(background.image),
    sizes: "100vw",
    width: background.image.width,
    height: background.image.height,
    alt: "",
    decoding: "async",
    loading: "lazy",
  });
  return renderElement(
    "picture",
    {
      "data-taproot-section-background-picture": true,
      "data-taproot-section-background-alt": background.image.alt,
      "aria-hidden": "true",
    },
    `${portraitSource}${image}`,
  );
}

function sectionImageSrcset(image: NormalizedSectionImage): string {
  return image.urls.map((candidate) => `${candidate.url} ${candidate.minWidth}w`).join(", ");
}

function isSafeSectionImageUrl(value: string): boolean {
  if (value === "" || /[\u0000-\u0020\u007f]/u.test(value) || value.includes("\\")) return false;
  if (value.startsWith("/")) return !value.startsWith("//");
  if (!/^https:\/\//iu.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.hostname !== ""
      && parsed.username === ""
      && parsed.password === "";
  } catch {
    return false;
  }
}

type NormalizedSectionDecoration = {
  imageUrl: string;
  anchor: string;
  inlineOffsetPercent: number;
  blockOffsetPercent: number;
  inlineSizePercent: number;
  opacity: number;
  tintToken: string;
};

function normalizedSectionDecorationStyle(value: unknown): string[] | undefined {
  const decoration = normalizeSectionDecoration(value);
  if (!decoration) return undefined;
  return [
    `--esp-section-decoration-image: url("${escapeCssString(decoration.imageUrl)}")`,
    `--esp-section-decoration-color: var(${decoration.tintToken})`,
    `--esp-section-decoration-position: ${sectionDecorationPosition(decoration)}`,
    `--esp-section-decoration-size: ${decoration.inlineSizePercent}% auto`,
    `--esp-section-decoration-opacity: ${decoration.opacity}`,
  ];
}

/**
 * Re-check the document boundary before emitting inline CSS. Authoring and
 * readiness validation report the actionable diagnostic; the renderer's safe
 * failure is to omit all five hooks rather than partially paint an invalid or
 * attacker-controlled decoration.
 */
function normalizeSectionDecoration(value: unknown): NormalizedSectionDecoration | undefined {
  if (!isRecord(value)) return undefined;
  const fields = freeFormSectionRegistry.section.attrs.decoration.fields;
  if (!hasOnlyKeys(value, Object.keys(fields))) return undefined;

  const image = normalizeSectionImage(value.image, fields.image);
  if (!image) return undefined;

  const anchor = value.anchor ?? fields.anchor.default;
  const inlineOffsetPercent = value.inlineOffsetPercent ?? fields.inlineOffsetPercent.default;
  const blockOffsetPercent = value.blockOffsetPercent ?? fields.blockOffsetPercent.default;
  const inlineSizePercent = value.inlineSizePercent ?? fields.inlineSizePercent.default;
  const opacity = value.opacity ?? fields.opacity.default;
  const tint = value.tint ?? fields.tint.default;
  if (typeof anchor !== "string" || !fields.anchor.values.includes(anchor as never)) return undefined;
  if (!isBoundedNumber(inlineOffsetPercent, fields.inlineOffsetPercent.minimum, fields.inlineOffsetPercent.maximum)) {
    return undefined;
  }
  if (!isBoundedNumber(blockOffsetPercent, fields.blockOffsetPercent.minimum, fields.blockOffsetPercent.maximum)) {
    return undefined;
  }
  if (
    !isBoundedNumber(inlineSizePercent, fields.inlineSizePercent.minimum, fields.inlineSizePercent.maximum)
    || !Number.isInteger(inlineSizePercent)
  ) return undefined;
  if (!isBoundedNumber(opacity, fields.opacity.minimum, fields.opacity.maximum)) return undefined;
  if (typeof tint !== "string" || !fields.tint.values.includes(tint as never)) return undefined;
  const tintToken = fields.tint.tokenByValue[tint as keyof typeof fields.tint.tokenByValue];
  if (!tintToken) return undefined;

  return {
    imageUrl: image.src,
    anchor,
    inlineOffsetPercent,
    blockOffsetPercent,
    inlineSizePercent,
    opacity,
    tintToken,
  };
}

function sectionDecorationPosition(decoration: NormalizedSectionDecoration): string {
  const [inlineBase, blockBase] = (() => {
    switch (decoration.anchor) {
      case "top-start":
        return [0, 0];
      case "top-end":
        return [100, 0];
      case "bottom-start":
        return [0, 100];
      case "bottom-end":
        return [100, 100];
      case "center":
      default:
        return [50, 50];
    }
  })();
  return `${positionAxis(inlineBase, decoration.inlineOffsetPercent)} ${
    positionAxis(blockBase, decoration.blockOffsetPercent)
  }`;
}

function positionAxis(base: number, offset: number): string {
  if (offset === 0) return `${base}%`;
  return `calc(${base}% ${offset < 0 ? "-" : "+"} ${Math.abs(offset)}%)`;
}

function escapeCssString(value: string): string {
  return value.replace(/(["\\])/gu, "\\$1").replace(
    /[\u0000-\u001f\u007f]/gu,
    (character) => `\\${character.codePointAt(0)?.toString(16)} `,
  );
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isCanonicalUuid(value: unknown): boolean {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isBoundedNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function renderComponentBlock(node: ProseMirrorNode): string {
  const componentType = stringAttr(node.attrs?.componentType) || "placeholder";
  const componentData = stringAttr(node.attrs?.componentData) || "{}";
  return renderElement(
    "div",
    {
      "data-component-block": "",
      "data-component-type": componentType,
      "data-component-data": componentData,
      class: "component-block",
    },
    `Component: ${escapeHtml(componentType)}`,
  );
}

function renderTaprootImage(node: ProseMirrorNode, options: RenderProseMirrorOptions): string {
  const attrs = node.attrs ?? {};
  const resolved = resolveImagePresentation(attrs, options.imageDefaults);
  const imageAttrs: Record<string, string | number | boolean | null | undefined> = {
    "low-res": stringAttr(attrs.src),
    "original-width": numberAttr(attrs.width),
    "original-height": numberAttr(attrs.height),
    "data-image-id": stringAttr(attrs.imageId),
    "data-crop": jsonAttr(attrs.crop),
    caption: stringAttr(attrs.alt),
    ...resolved,
  };
  const optionsHtml = validResponsiveImageUrls(attrs.urls)
    .map((url) =>
      renderVoidElement("esp-image-option", {
        width: url.minWidth,
        url: url.url,
        type: url.type,
      })
    )
    .join("");
  return renderElement("esp-image", imageAttrs, optionsHtml);
}

function resolveImagePresentation(
  attrs: Record<string, JsonValue | undefined>,
  defaults: RenderProseMirrorOptions["imageDefaults"],
): Record<string, string | number | undefined> {
  const maxHeight = resolveMaxHeight(attrs.maxHeightVh, defaults?.maxHeightVh);
  const maxHeightOverride = normalizeCssLengthOverride(attrs.maxHeight, { allowNone: true });
  const borderWidthOverride = normalizeCssLengthOverride(attrs.borderWidth);
  const placement = resolvePlacement(attrs, defaults?.placement);
  const placementAttrs = imagePresentationAttributesForPlacement(placement);
  const styleParts: string[] = [];
  if (maxHeightOverride) styleParts.push(`--taproot-article-image-max-height: ${maxHeightOverride}`);
  if (borderWidthOverride) styleParts.push(`--esp-image-border: ${imageBorderValue(borderWidthOverride)}`);
  return {
    // An explicit CSS max height supersedes the legacy vh enum entirely.
    ...(maxHeightOverride === null && maxHeight !== DEFAULT_TIPTAP_IMAGE_MAX_HEIGHT_VH
      ? { "data-image-max-height-vh": maxHeight }
      : {}),
    ...(maxHeightOverride ? { "data-image-max-height": maxHeightOverride } : {}),
    ...(borderWidthOverride ? { "data-image-border-width": borderWidthOverride } : {}),
    ...(styleParts.length > 0 ? { style: styleParts.join("; ") } : {}),
    ...(placementAttrs.imageAlign ? { "data-image-align": placementAttrs.imageAlign } : {}),
    ...(placementAttrs.imagePlacement ? { "data-image-placement": placementAttrs.imagePlacement } : {}),
  };
}

function resolveMaxHeight(value: unknown, defaultValue: unknown): TiptapImageMaxHeightVh {
  if (value === TIPTAP_SITE_DEFAULT || value === undefined || value === null) {
    return normalizeImageMaxHeight(defaultValue);
  }
  return normalizeImageMaxHeight(value);
}

function resolvePlacement(
  attrs: Record<string, JsonValue | undefined>,
  defaultValue: unknown,
): TiptapImagePresentationPlacement {
  const explicitPresentation = attrs.presentationPlacement;
  if (typeof explicitPresentation === "string" && explicitPresentation !== TIPTAP_SITE_DEFAULT) {
    return normalizeImagePresentationPlacement(explicitPresentation);
  }
  // "site-default" (or absent) means the presentation dialog made no explicit
  // choice. The node's own alignment attributes still win — mirroring the
  // editor's node view — and the site default applies only when those are
  // absent too.
  if (
    isAbsentPresentationValue(attrs.imageAlign)
    && isAbsentPresentationValue(attrs.imagePlacement)
    && isAbsentPresentationValue(attrs.textAlign)
  ) {
    return normalizeImagePresentationPlacement(defaultValue);
  }
  return imagePresentationPlacementForAttrs(attrs);
}

function isAbsentPresentationValue(value: unknown): boolean {
  return value === undefined || value === null;
}

export function normalizeImageMaxHeight(value: unknown): TiptapImageMaxHeightVh {
  const parsed = typeof value === "number" ? value : Number(value);
  return TIPTAP_IMAGE_MAX_HEIGHT_OPTIONS.includes(parsed as TiptapImageMaxHeightVh)
    ? parsed as TiptapImageMaxHeightVh
    : DEFAULT_TIPTAP_IMAGE_MAX_HEIGHT_VH;
}

const CSS_LENGTH_UNITS = "px|em|rem|ch|ex|vw|vh|svh|lvh|dvh|svw|lvw|dvw|vmin|vmax|%";
const CSS_LENGTH_RE = new RegExp(`^\\d+(?:\\.\\d+)?(?:${CSS_LENGTH_UNITS})$`, "i");
const CSS_VAR_RE = /^var\(--[a-z0-9-]+\)$/i;
const CSS_CALC_TERM = `(?:\\d+(?:\\.\\d+)?(?:${CSS_LENGTH_UNITS})|\\d+(?:\\.\\d+)?|var\\(--[a-z0-9-]+\\))`;
const CSS_CALC_RE = new RegExp(
  `^calc\\(\\s*${CSS_CALC_TERM}(?:\\s*[+\\-*/]\\s*${CSS_CALC_TERM})*\\s*\\)$`,
  "i",
);

/**
 * Validate a user-supplied CSS length for per-image presentation overrides
 * (max height, border width). These values are emitted into inline styles on
 * published pages, so anything outside this strict grammar is rejected:
 * unitless `0`, a non-negative length, `var(--token)`, `calc(...)` of those
 * terms, and — when `allowNone` is set — the `none` keyword (max-height).
 * Returns the trimmed value, or null when invalid or set to the site default.
 */
export function normalizeCssLengthOverride(
  value: unknown,
  options?: { allowNone?: boolean },
): string | null {
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

/** CSS value for the esp-image border hook given a width; zero collapses to none. */
export function imageBorderValue(width: string): string {
  return /^0(?:\.0+)?(?:[a-z%]+)?$/i.test(width) ? "none" : `${width} solid var(--esp-color-border)`;
}

export function normalizeImagePresentationPlacement(value: unknown): TiptapImagePresentationPlacement {
  switch (value) {
    case "left":
    case "LEFT":
      return "left";
    case "left-text-right":
    case "left-wrap":
    case "LEFT_TEXT_RIGHT":
      return "left-text-right";
    case "center":
    case "CENTER":
      return "center";
    case "right":
    case "RIGHT":
      return "right";
    case "right-text-left":
    case "right-wrap":
    case "RIGHT_TEXT_LEFT":
      return "right-text-left";
    default:
      return "left";
  }
}

export function imagePresentationPlacementForAttrs(attrs: {
  imageAlign?: unknown;
  imagePlacement?: unknown;
  textAlign?: unknown;
}): TiptapImagePresentationPlacement {
  if (attrs.imagePlacement === "float-start") return "left-text-right";
  if (attrs.imagePlacement === "float-end") return "right-text-left";
  if (attrs.imageAlign === "center" || attrs.textAlign === "center") return "center";
  if (attrs.imageAlign === "end" || attrs.imageAlign === "right" || attrs.textAlign === "right") return "right";
  return "left";
}

export function imagePresentationAttributesForPlacement(value: unknown): {
  textAlign: string | null;
  imageAlign: string | null;
  imagePlacement: string | null;
} {
  switch (normalizeImagePresentationPlacement(value)) {
    case "left-text-right":
      return { textAlign: null, imageAlign: null, imagePlacement: "float-start" };
    case "center":
      return { textAlign: "center", imageAlign: "center", imagePlacement: null };
    case "right":
      return { textAlign: "right", imageAlign: "end", imagePlacement: null };
    case "right-text-left":
      return { textAlign: "right", imageAlign: "end", imagePlacement: "float-end" };
    case "left":
    default:
      return { textAlign: null, imageAlign: null, imagePlacement: null };
  }
}

function validResponsiveImageUrls(value: unknown): Array<{ minWidth: number; url: string; type?: string }> {
  if (!Array.isArray(value)) return [];
  const urls: Array<{ minWidth: number; url: string; type?: string }> = [];
  for (const option of value) {
    if (!isRecord(option)) continue;
    const minWidth = numberAttr(option.minWidth);
    const url = stringAttr(option.url);
    if (!minWidth || !url) continue;
    const type = stringAttr(option.type);
    urls.push({ minWidth, url, ...(type ? { type } : {}) });
  }
  return urls;
}

function textBlockAttrs(attrs: Record<string, JsonValue | undefined> | undefined): Record<string, string> {
  const styleParts: string[] = [];
  const textAlign = stringAttr(attrs?.textAlign);
  if (["left", "center", "right", "justify"].includes(textAlign ?? "")) {
    styleParts.push(`text-align: ${textAlign}`);
  }
  // Advanced text setting: per-block font-size override. Validated because it
  // is emitted into published inline styles.
  const fontSize = normalizeCssLengthOverride(attrs?.fontSize);
  if (fontSize) styleParts.push(`font-size: ${fontSize}`);
  return styleParts.length > 0 ? { style: styleParts.join("; ") } : {};
}

function withProseMeasure(
  attrs: Record<string, string>,
  nodeType: string,
  options: RenderProseMirrorOptions,
): Record<string, string> {
  if (
    !options.freeFormSections
    || !Object.prototype.hasOwnProperty.call(freeFormSectionRegistry.rootNodes, nodeType)
  ) return attrs;
  const presentation = freeFormSectionRegistry.rootNodes[nodeType as keyof typeof freeFormSectionRegistry.rootNodes];
  if (presentation.measure !== "prose") return attrs;
  return {
    ...attrs,
    "data-content-measure": "prose",
    style: attrs.style ? `${attrs.style}; max-width: var(--esp-measure)` : "max-width: var(--esp-measure)",
  };
}

function renderElement(
  tag: string,
  attrs: Record<string, string | number | boolean | null | undefined>,
  content: string,
): string {
  return `<${tag}${serializeAttributes(attrs)}>${content}</${tag}>`;
}

function renderVoidElement(
  tag: string,
  attrs: Record<string, string | number | boolean | null | undefined>,
): string {
  return `<${tag}${serializeAttributes(attrs)}>`;
}

function serializeAttributes(attrs: Record<string, string | number | boolean | null | undefined>): string {
  const serialized = Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .map(([key, value]) => value === true ? key : `${key}="${escapeAttribute(String(value))}"`);
  return serialized.length ? ` ${serialized.join(" ")}` : "";
}

function isSafeUrl(url: string): boolean {
  if (/[\x00-\x1f\x7f\\]/u.test(url)) return false;
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

function jsonAttr(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function stringAttr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberAttr(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function isRecord(value: unknown): value is Record<string, JsonValue | undefined> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
