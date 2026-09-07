import { BUILT_IN_IMAGE_TEXTURES } from "@taprootio/espalier/shared/image-texture-registry";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  COMPONENT_SHAPES,
  COMPONENT_TYPES,
  getComponentDefinition,
  getComponentPropertyReference,
} from "../../src/content/components.js";
import { markdownToProseMirror } from "../../src/content/markdown.js";
import { validateDocument } from "../../src/content/validate-document.js";
import {
  CONTENT_ERROR_CODES,
  CONTENT_LIMITS,
  MARK_TYPES,
  NODE_TYPES,
} from "../../src/content/vocabulary.js";
import {
  formatReferenceResult,
  getComponentReference,
  getPageTypeReference,
  getWorkflowReference,
  listComponentTypeReferences,
  listPageTypeReferences,
  PAGE_TYPES,
  REFERENCE_VERSION,
} from "../../src/reference-help.js";
import {
  FIXTURE_CONTRACT_VERSION,
  FIXTURE_MANIFEST_FILE_NAME,
  FIXTURE_REQUIRED_ROOT_FIELDS,
  shippedFixtureDirectory,
} from "../../src/fixture-contract.js";
import { SETTINGS_GROUPS } from "../../src/settings-catalog.js";
import { MANIFEST_VERSION } from "../../src/workspace.js";
import { FREE_FORM_SECTION_REGISTRY } from "../../src/content/free-form-sections.js";

function componentDocument(componentType, data) {
  return {
    type: "doc",
    content: [{
      type: "componentBlock",
      attrs: { componentType, componentData: JSON.stringify(data) },
    }],
  };
}

test("the free-form and component indexes are derived from the executable registries", () => {
  assert.equal(REFERENCE_VERSION, 19);
  assert.deepEqual(PAGE_TYPES, ["free-form"]);
  assert.deepEqual(listPageTypeReferences().map((page) => page.type), PAGE_TYPES);

  const componentTypes = listComponentTypeReferences().map((component) => component.type);
  assert.deepEqual(componentTypes, COMPONENT_TYPES);
  assert.deepEqual(getPageTypeReference("free-form").components.map((component) => component.type), COMPONENT_TYPES);
  assert.equal(getPageTypeReference("article"), undefined);
  assert.equal(getComponentReference("hero"), undefined);
});

test("every component reference exposes its validator schema and validates its editor initial data and examples", async (context) => {
  for (const componentType of COMPONENT_TYPES) {
    await context.test(componentType, async () => {
      const definition = getComponentDefinition(componentType);
      const reference = getComponentReference(componentType);
      const properties = getComponentPropertyReference(componentType);

      assert.deepEqual(reference.properties, properties);
      assert.equal(reference.additionalProperties, false);
      assert.deepEqual(properties.map((property) => property.name), Object.keys(COMPONENT_SHAPES[componentType]));
      assert.equal(reference.componentDataMaxUtf8Bytes, CONTENT_LIMITS.componentDataBytes);
      assert.deepEqual(reference.editorInitialData, definition.defaultData);
      assert.deepEqual(reference.example, definition.example);
      assert.ok(reference.accessibility.length > 0);

      assert.deepEqual(validateDocument(componentDocument(componentType, reference.editorInitialData)).errors, []);
      assert.deepEqual(validateDocument(componentDocument(componentType, reference.example)).errors, []);
      assert.deepEqual(
        validateDocument({ type: "doc", content: [reference.componentBlockExample] }).errors,
        [],
      );
      const converted = await markdownToProseMirror(reference.markdownExample, {
        resolveImage: async () => {
          throw new Error("component examples must not resolve image references");
        },
      });
      assert.deepEqual(converted.doc.content, [reference.componentBlockExample]);
    });
  }
});

test("the free-form reference exposes the production document vocabulary and authoring workflow", () => {
  const page = getPageTypeReference("free-form");
  assert.deepEqual(page.document.nodes, NODE_TYPES);
  assert.deepEqual(page.document.marks, MARK_TYPES);
  assert.deepEqual(page.workspace.formats.map((format) => format.extension), [".md", ".pm.json"]);
  assert.ok(page.workspace.formats.every((format) => Array.isArray(format.metadata)));
  const markdownFormat = page.workspace.formats.find((format) => format.extension === ".md");
  const proseMirrorFormat = page.workspace.formats.find((format) => format.extension === ".pm.json");
  assert.deepEqual(
    markdownFormat.metadata.map((field) => field.name),
    ["title", "path", "description"],
  );
  assert.deepEqual(proseMirrorFormat.metadata, []);
  assert.equal(
    proseMirrorFormat.metadataSource,
    "Read from .taproot-site-manifest.json at the workspace root; the document file contains only the ProseMirror root.",
  );
  const metadata = Object.fromEntries(markdownFormat.metadata.map((field) => [field.name, field]));
  assert.deepEqual(metadata.description, {
    name: "description",
    type: "string",
    requiredForNew: false,
    inheritedForTracked: true,
    defaultForNew: "",
  });
  assert.equal(page.layout, undefined);
  assert.equal(page.sections.topLevelOnly, true);
  assert.deepEqual(page.sections.defaults, {
    context: null,
    contentPadding: "standard",
    surface: "none",
    background: null,
    decoration: null,
  });
  assert.deepEqual(
    page.document.sectionNode.attrs.map((attr) => attr.name),
    Object.keys(FREE_FORM_SECTION_REGISTRY.section.attrs),
  );
  assert.deepEqual(
    page.sections.placementMatrix.map((row) => [row.kind, row.type]),
    [
      ...Object.keys(FREE_FORM_SECTION_REGISTRY.rootNodes).map((type) => ["node", type]),
      ...Object.keys(FREE_FORM_SECTION_REGISTRY.components).map((type) => ["component", type]),
    ],
  );
  assert.equal(
    page.sections.placementMatrix.find((row) => row.type === "hero-section").rootPlacement,
    "flow",
  );
  assert.equal(page.sections.placementMatrix.find((row) => row.type === "paragraph").measure, "prose");
  assert.equal(page.sections.placementMatrix.find((row) => row.type === "table").measure, "wide");
  assert.equal(page.sections.placementMatrix.find((row) => row.type === "inlineFacts").measure, "wide");
  assert.equal(page.sections.background.additionalProperties, false);
  assert.deepEqual(
    page.sections.background.fields.map((field) => field.name),
    Object.keys(FREE_FORM_SECTION_REGISTRY.section.attrs.background.fields),
  );
  assert.deepEqual(page.sections.background.defaults, {
    portraitImage: null,
    focus: { x: 0.5, y: 0.5 },
    portraitFocus: null,
    scrimStrength: "medium",
  });
  assert.deepEqual(page.sections.background.scrimOpacityByValue, {
    none: 0,
    soft: 0.28,
    medium: 0.48,
    strong: 0.68,
  });
  assert.equal(page.sections.decoration.additionalProperties, false);
  assert.deepEqual(
    page.sections.decoration.fields.map((field) => field.name),
    Object.keys(FREE_FORM_SECTION_REGISTRY.section.attrs.decoration.fields),
  );
  assert.deepEqual(page.sections.decoration.tintTokens, {
    accent: "--esp-color-link",
    heading: "--esp-color-headings",
    text: "--esp-color-text",
    action: "--esp-color-action-background",
    border: "--esp-color-border",
  });
  const decorationImage = page.sections.decoration.fields.find((field) => field.name === "image");
  assert.deepEqual(decorationImage.requiredKeys, ["imageId", "src", "urls"]);
  assert.deepEqual(decorationImage.optionalKeys, ["width", "height", "alt"]);
  assert.deepEqual(decorationImage.responsiveUrls, {
    minItems: 1,
    maxItems: 5,
    itemAdditionalProperties: false,
    fields: [
      { name: "minWidth", type: "integer", required: true, minimum: 1 },
      { name: "url", type: "safe-delivery-url", required: true },
      { name: "type", type: "enum", required: false, values: ["image/webp"] },
    ],
  });
  assert.equal(decorationImage.srcMustMatchUrls, true);
  assert.deepEqual(
    Object.fromEntries(page.sections.decoration.fields.filter((field) => field.minimum !== undefined).map(
      (field) => [field.name, [field.minimum, field.maximum, field.default]],
    )),
    {
      inlineOffsetPercent: [-50, 50, 0],
      blockOffsetPercent: [-50, 50, 0],
      inlineSizePercent: [10, 100, 40],
      opacity: [0, 1, 0.12],
    },
  );
  assert.match(page.sections.decoration.maskGuidance, /transparent PNG or WebP/u);
  assert.match(page.sections.decoration.opaqueWarning, /opaque rectangle/u);
  assert.match(page.sections.decoration.markdownExample, /"anchor":"top-end"/u);
  assert.deepEqual(page.document.rawHtml, {
    default: "rejected",
    trackedProseMirror: {
      format: ".pm.json",
      optIn: "taproot-site pages push --allow-raw-html",
      behavior: "The flag permits explicit rawHtml nodes only in a tracked ProseMirror document.",
    },
    markdown: {
      format: ".md",
      supported: false,
      behavior: "Inline HTML remains unsupported and is rejected even when --allow-raw-html is present.",
    },
    warning: "rawHtml renders verbatim and unsanitized; use it only for trusted hand-written markup.",
  });
  assert.deepEqual(page.workspace.systemPages, [{
    path: "404",
    mode: "read-only",
    reason: "system-404",
    projection:
      "pull writes the exact stored ProseMirror body and records its SHA-256 in .taproot-site-manifest.json",
    unchangedPush: "A whole-workspace pages push verifies the hash and skips this file without updating the page.",
    approval:
      "An unscoped approve excludes this projection even when the live system page carries a draft; naming it explicitly is refused.",
    modifiedError: "pages.read_only_modified",
    missingError: "pages.read_only_missing",
    replacementError: "pages.system_page_read_only",
    scopedPushError: "pages.page_read_only",
    scopedApprovalError: "approve.page_read_only",
    guidance:
      "Do not delete, replace, or edit this file. Run pull to restore it; author the system 404 through an owner-controlled surface.",
  }]);
  assert.equal(page.workspace.systemHome, "The pulled home page remains an ordinary editable page.");
  // TR00622: the one-source rule is a contract an agent authors against, so
  // its error codes and recovery are reference data rather than prose.
  const sourceRule = page.workspace.sourceRule;
  assert.deepEqual(sourceRule.manifestFields, ["file", "sourceFormat", "baseline"]);
  assert.equal(sourceRule.formatChangeError, "pages.path_conflict");
  assert.equal(sourceRule.conflictError, "pages.pull_conflict");
  assert.equal(sourceRule.renamedSourceError, "pages.source_conflict");
  assert.match(sourceRule.internalState, /^\.taproot-site-state\/pages\/<pageId>\.pm\.json/u);
  assert.match(sourceRule.rule, /exactly one authoritative editable source/u);
  assert.match(sourceRule.conflictRecovery, /push the local source|delete the local source/u);
  assert.match(sourceRule.pushSelection, /pages push with no\s+path is the command that reports every authored page/u);

  assert.deepEqual(
    page.workflow.map((step) => step.command),
    [
      "taproot-site pages push",
      "taproot-site approve [page-path...]",
      "taproot-site deploy --staging",
      "taproot-site deploy --production",
    ],
  );
});

test("section substrate help exposes registry delivery readiness and executable examples", async () => {
  const page = getPageTypeReference("free-form");
  const backgroundImages = page.sections.background.fields.filter((field) => field.type === "processed-image");
  assert.deepEqual(backgroundImages.map((field) => field.name), ["image", "portraitImage"]);

  for (const field of backgroundImages) {
    assert.equal(field.responsiveUrls.minItems, 1);
    assert.equal(field.responsiveUrls.maxItems, 5);
    assert.equal(field.responsiveUrls.itemAdditionalProperties, false);
    assert.deepEqual(field.responsiveUrls.fields, [
      { name: "minWidth", type: "integer", required: true, minimum: 1 },
      { name: "url", type: "safe-delivery-url", required: true },
      { name: "type", type: "enum", required: false, values: ["image/webp"] },
    ]);
    assert.equal(field.srcMustMatchUrls, true);
  }

  for (const markdown of [page.sections.background.markdownExample, page.sections.decoration.markdownExample]) {
    const converted = await markdownToProseMirror(markdown, {
      resolveImage: async () => {
        throw new Error("section header examples carry complete processed images");
      },
    });
    assert.deepEqual(validateDocument(converted.doc).errors, []);
  }
});

test("table reference help is executable and documents every bound and correction", async () => {
  const page = getPageTypeReference("free-form");
  const tables = page.tables;
  assert.equal(page.document.tableNode, tables);
  assert.deepEqual(tables.nodeTypes, FREE_FORM_SECTION_REGISTRY.table.nodeTypes);
  assert.deepEqual(tables.placement, { root: true, section: true, measure: "wide" });
  assert.deepEqual(tables.limits, {
    captionScalars: { min: 1, max: 160, unit: "Unicode scalar values", nonWhitespace: true },
    dataRows: { min: 1, max: 100 },
    columns: { min: 2, max: 12, everyRowMatchesHeader: true },
    cellTextScalars: {
      max: 1000,
      unit: "Unicode scalar values across text descendants; marks and hard breaks add zero",
    },
  });
  assert.deepEqual(tables.structure, {
    headerRows: 1,
    headerCellType: "tableHeader",
    dataCellType: "tableCell",
    paragraphChildrenPerCell: 1,
    paragraphAttrsSupported: false,
    inlineNodes: ["text", "hardBreak"],
    marks: MARK_TYPES,
    headerMustContainNonWhitespace: true,
    spansSupported: false,
    unsupportedSpanAttrs: ["colspan", "rowspan", "colwidth"],
  });
  assert.equal(tables.markdown.captionSyntax, "Table: Caption text");
  assert.equal(
    tables.captionGuidance,
    "Use a caption when surrounding prose does not already name the table; omit it when an immediately preceding heading already names the table.",
  );
  assert.equal(tables.markdown.outerPipes, "optional");
  assert.equal(tables.markdown.literalPipeEscape, "\\|");
  assert.equal(tables.markdown.alignment, "rejected");
  assert.equal(tables.markdown.blankLineTerminates, true);
  assert.deepEqual(validateDocument({ type: "doc", content: [tables.examples.proseMirror] }).errors, []);

  for (const example of [tables.examples.rateTable, tables.examples.comparisonTable]) {
    const converted = await markdownToProseMirror(example, {
      resolveImage: async () => {
        throw new Error("table examples must not resolve image references");
      },
    });
    assert.equal(converted.doc.content[0].type, "table");
    assert.deepEqual(validateDocument(converted.doc).errors, []);
  }
  await assert.rejects(
    markdownToProseMirror(tables.examples.rejectedAlignment, {
      resolveImage: async () => {
        throw new Error("table examples must not resolve image references");
      },
    }),
    (error) => error.code === CONTENT_ERROR_CODES.markdownTableAlignment,
  );

  assert.deepEqual(
    tables.corrections.map((entry) => entry.code),
    [
      CONTENT_ERROR_CODES.childNotAllowed,
      CONTENT_ERROR_CODES.attrUnknown,
      CONTENT_ERROR_CODES.tableHeader,
      CONTENT_ERROR_CODES.tableShape,
      CONTENT_ERROR_CODES.tableRagged,
      CONTENT_ERROR_CODES.tableBounds,
      CONTENT_ERROR_CODES.tableCellContent,
      CONTENT_ERROR_CODES.tableSpan,
      CONTENT_ERROR_CODES.markdownTable,
      CONTENT_ERROR_CODES.markdownTableAlignment,
    ],
  );
  assert.ok(tables.corrections.every((entry) => entry.correction.length > 0));
});

test("inline-facts reference is executable and documents the canonical SHY row", async () => {
  const page = getPageTypeReference("free-form");
  const facts = page.inlineFacts;
  assert.equal(page.document.inlineFactsNode, facts);
  assert.equal(facts.nodeType, "inlineFacts");
  assert.deepEqual(facts.placement, { root: true, section: true, measure: "wide" });
  assert.equal(facts.attrs.items.minItems, 1);
  assert.equal(facts.attrs.items.maxItems, 6);
  assert.equal(facts.attrs.items.itemAdditionalProperties, false);
  assert.deepEqual(facts.attrs.items.itemFieldOrder, ["value", "label", "url"]);
  assert.match(facts.urlPolicy, /non-protocol-relative/u);
  assert.match(facts.urlPolicy, /backslashes, and ASCII controls are rejected/u);
  assert.deepEqual(
    facts.attrs.items.fields.slice(0, 2).map((field) => ({
      name: field.name,
      required: field.required,
      default: field.default,
      minScalars: field.minScalars,
      maxScalars: field.maxScalars,
      nonWhitespace: field.nonWhitespace,
    })),
    [
      { name: "value", required: true, default: undefined, minScalars: 1, maxScalars: 120, nonWhitespace: true },
      { name: "label", required: false, default: null, minScalars: 1, maxScalars: 120, nonWhitespace: true },
    ],
  );
  assert.match(facts.labelPolicy, /^Optional non-whitespace plain text/u);
  assert.match(facts.labelPolicy, /Omit it when the value already names itself/u);
  assert.match(facts.labelPolicy, /An empty string is rejected/u);
  assert.deepEqual(validateDocument({ type: "doc", content: [facts.examples.proseMirror] }).errors, []);
  assert.ok(facts.examples.items.some((item) => item.url?.startsWith("tel:")));
  // The published example must itself demonstrate the standalone fact.
  assert.ok(facts.examples.items.some((item) => item.label === undefined));

  const converted = await markdownToProseMirror(facts.markdown.example, {
    resolveImage: async () => {
      throw new Error("inline-facts examples must not resolve image references");
    },
  });
  assert.deepEqual(converted.doc.content, [facts.examples.proseMirror]);

  const output = formatReferenceResult({ topic: "page", page });
  assert.match(output, /Inline facts:/u);
  assert.match(output, /1 through 6/u);
  assert.match(output, /maximum 120 Unicode scalar values/u);
  assert.match(output, /value +Required non-whitespace plain text/u);
  assert.match(output, /label +Optional non-whitespace plain text/u);
  assert.match(output, /tel: remains a native link/u);
  assert.match(output, /other schemes, backslashes, and ASCII controls are rejected/u);
  assert.match(output, /```inline-facts/u);
  assert.match(output, /\(555\) 013-7788/u);
});

test("plain-text page help reports full-bleed placement for every supported node and component", () => {
  const page = getPageTypeReference("free-form");
  const output = formatReferenceResult({ topic: "page", page });
  const placementLines = output.split("\n").filter((line) =>
    page.sections.placementMatrix.some((row) => line.trimStart().startsWith(`${row.kind}:${row.type}`))
  );

  assert.equal(placementLines.length, page.sections.placementMatrix.length);
  assert.ok(placementLines.every((line) => /full bleed (?:yes|no)/u.test(line)));
  assert.match(placementLines.find((line) => line.includes("component:hero-section")), /full bleed no/u);
  assert.match(placementLines.find((line) => line.includes("node:paragraph")), /full bleed no/u);
});

test("plain-text free-form help explains the integrity-checked read-only 404 projection", () => {
  const output = formatReferenceResult({ topic: "page", page: getPageTypeReference("free-form") });

  assert.match(output, /System page projections:/u);
  assert.match(output, /404\s+read-only/u);
  assert.match(output, /records its SHA-256/u);
  assert.match(output, /whole-workspace pages push verifies the hash and skips this file/u);
  assert.match(output, /approve excludes this projection/u);
  assert.match(output, /Do not delete, replace, or edit this file/u);
  assert.match(output, /One source per page:/u);
  assert.match(output, /pages\.pull_conflict/u);
  assert.match(output, /pages\.source_conflict/u);
  assert.match(output, /never discovered as a page source/u);
  assert.match(output, /home\s+editable/u);
});

test("plain-text free-form help prints background defaults, focal bounds, scrim mapping, and both image paths", () => {
  const output = formatReferenceResult({ topic: "page", page: getPageTypeReference("free-form") });

  assert.match(output, /Section photo background \(closed object\):/u);
  assert.match(output, /image\s+processed-image; required/u);
  assert.match(output, /portraitImage\s+processed-image \| null; default null/u);
  assert.match(output, /responsive candidates 1 through 5/u);
  assert.match(output, /minWidth positive integer/u);
  assert.match(output, /optional type "image\/webp"/u);
  assert.match(output, /src must match one candidate/u);
  assert.match(output, /focus[\s\S]+x[^\n]+bounds 0 through 1/u);
  assert.match(output, /portraitFocus[\s\S]+y[^\n]+bounds 0 through 1/u);
  assert.match(output, /scrimStrength[^\n]+"none" \| "soft" \| "medium" \| "strong"; default "medium"/u);
  assert.match(output, /none\s+0\n\s+soft\s+0\.28\n\s+medium\s+0\.48\n\s+strong\s+0\.68/u);
  assert.match(output, /Responsive background example:/u);
  assert.match(output, /"portraitImage"/u);
  assert.match(output, /"portraitFocus"/u);
});

test("plain-text free-form help prints decoration bounds, tint mapping, and alpha-mask guidance", () => {
  const output = formatReferenceResult({ topic: "page", page: getPageTypeReference("free-form") });

  assert.match(output, /Section decoration \(closed object\):/u);
  assert.match(output, /inlineOffsetPercent[^\n]+bounds -50 through 50/u);
  assert.match(output, /inlineSizePercent[^\n]+bounds 10 through 100/u);
  assert.match(output, /opacity[^\n]+bounds 0 through 1/u);
  for (const [tint, token] of Object.entries(FREE_FORM_SECTION_REGISTRY.section.attrs.decoration.fields.tint.tokenByValue)) {
    assert.match(output, new RegExp(`${tint}\\s+${token}`, "u"));
  }
  assert.match(output, /Transparent-mask example:/u);
  assert.match(output, /Use a transparent PNG or WebP/u);
  assert.match(output, /opaque rectangle[^\n]+tinted rectangle/u);
});

test("plain-text free-form help is sufficient to author and repair tables", () => {
  const page = getPageTypeReference("free-form");
  const output = formatReferenceResult({ topic: "page", page });

  assert.match(output, /Semantic tables:/u);
  assert.match(output, /exactly 1 header row, then 1 through 100 data rows/u);
  assert.match(output, /columns\s+2 through 12/u);
  assert.match(output, /maximum 160 Unicode scalar values/u);
  assert.match(output, /caption guidance\s+Use a caption when surrounding prose does not already name the table/u);
  assert.match(output, /omit it when an immediately preceding heading already names the table/u);
  assert.match(output, /maximum 1000 text scalars/u);
  assert.match(output, /outer pipes optional/u);
  assert.match(output, /literal pipe as \\\|/u);
  assert.match(output, /colspan, rowspan, colwidth/u);
  assert.match(output, /alignment\s+rejected/u);
  assert.match(output, /blank line ends the table/u);
  assert.match(output, /Rate table example:\nTable: Drop-in rates/u);
  assert.match(output, /\[Book now\]\(\/classes\)/u);
  assert.match(output, /Save \$20 \\\| valid for 90 days/u);
  assert.match(output, /Comparison table example:/u);
  assert.match(output, /Rejected alignment example \(content\.markdown_table_alignment\):/u);
  assert.match(output, /Direct ProseMirror table example:/u);
  for (const correction of page.tables.corrections) {
    assert.ok(output.includes(correction.code));
    assert.ok(output.includes(correction.correction));
  }
});

test("the hero reference is the closed refined content contract with exact defaults", () => {
  const hero = getComponentReference("hero-section");
  assert.deepEqual(hero.properties.map((property) => property.name), [
    "overline",
    "title",
    "titleSize",
    "lead",
    "primaryAction",
    "secondaryAction",
    "alignment",
    "media",
    "mediaArrangement",
    "mediaPosition",
    "mediaWidth",
  ]);
  assert.deepEqual(
    hero.properties.filter((property) => property.required).map((property) => property.name),
    ["title", "primaryAction"],
  );
  assert.deepEqual(hero.properties.find((property) => property.name === "secondaryAction").schema.type, [
    "object",
    "null",
  ]);
  assert.deepEqual(
    Object.fromEntries(hero.properties.map((property) => [property.name, property.whenOmitted])),
    {
      overline: { kind: "value", value: "" },
      title: { kind: "invalid" },
      titleSize: { kind: "value", value: "normal" },
      lead: { kind: "value", value: "" },
      primaryAction: { kind: "invalid" },
      secondaryAction: { kind: "value", value: null },
      alignment: { kind: "value", value: "start" },
      media: { kind: "value", value: null },
      mediaArrangement: { kind: "value", value: "split" },
      mediaPosition: { kind: "value", value: "after" },
      mediaWidth: { kind: "value", value: "equal" },
    },
  );
  const output = formatReferenceResult({ topic: "component", component: hero });
  assert.match(output, /title\s+string; required/u);
  assert.match(output, /primaryAction\.url\s+string \(safe-url\); required/u);
  for (const legacy of ["backgroundImage", "overlayOpacity", "layout", "paddingTop"]) {
    assert.equal(output.includes(legacy), false);
  }
});

test("URL references name protocol-relative, native-action, backslash, and ASCII-control behavior", () => {
  const heroCta = getComponentReference("hero-section").properties
    .find((property) => property.name === "primaryAction").schema.properties
    .find((property) => property.name === "url");
  const featureUrl = getComponentReference("feature-grid").properties
    .find((property) => property.name === "items").schema.items.properties
    .find((property) => property.name === "url");
  for (const property of [heroCta, featureUrl]) {
    assert.match(property.schema.description, /does not begin with \/\//u);
    assert.match(property.schema.description, /Backslashes and ASCII control characters are rejected/u);
  }
  assert.match(heroCta.schema.description, /mailto, or tel/u);
});

test("every borderWidth says what it boxes, and the grids say their item text is plain", () => {
  // TR00706: a shared field name is a promise the field behaves the same way,
  // so each borderWidth names its own subject and the two grids agree.
  const boxed = {
    "feature-grid": /border around each item, as on a card grid; the grid itself is never framed/u,
    "card-grid": /border around each card; the grid itself is never framed/u,
    "cta": /border around the call-to-action panel/u,
    // TR00719: the testimonial was the rule's last exception; a carousel now
    // shows the visible slide's own box rather than a frame around the strip.
    "testimonial": /border around each quotation, as on a card grid; a carousel shows the visible slide's own box and is never framed/u,
  };
  for (const [componentType, expected] of Object.entries(boxed)) {
    const component = getComponentReference(componentType);
    const borderWidth = component.properties.find((property) => property.name === "borderWidth");
    assert.match(borderWidth.schema.description, expected);
    // The description reaches the printed help, not only the JSON schema.
    assert.match(formatReferenceResult({ topic: "component", component }), expected);
  }

  for (const [componentType, linkField] of [["feature-grid", "url"], ["card-grid", "linkUrl"]]) {
    const component = getComponentReference(componentType);
    const plainText = component.accessibility.find((note) => note.includes("plain text"));
    assert.ok(plainText, `${componentType} guidance must state that item text is plain text.`);
    assert.match(plainText, new RegExp(`${linkField} makes the whole (item|card) the link`, "u"));
    assert.match(plainText, /Put linked prose in a paragraph beside the grid/u);
    assert.match(formatReferenceResult({ topic: "component", component }), /Put linked prose in a paragraph/u);
  }
});

test("collection references distinguish editor seed rows from renderer omission behavior", () => {
  for (const [componentType, propertyName] of [
    ["feature-grid", "items"],
    ["testimonial", "items"],
    ["card-grid", "cards"],
  ]) {
    const property = getComponentReference(componentType).properties.find((item) => item.name === propertyName);
    assert.equal(property.editorInitial.kind, "value");
    assert.equal(property.editorInitial.value.length, 1);
    assert.deepEqual(property.whenOmitted, { kind: "value", value: [] });
  }
});

test("nested schema output retains required image keys, array bounds, and nullable objects", () => {
  const banner = getComponentReference("image-banner");
  const image = banner.properties.find((property) => property.name === "image").schema;
  assert.deepEqual(image.type, ["object", "null"]);
  assert.equal(image.additionalProperties, false);
  assert.deepEqual(
    image.properties.filter((property) => property.required).map((property) => property.name),
    ["imageId", "src", "urls"],
  );
  assert.equal(
    image.properties.find((property) => property.name === "urls").schema.maxItems,
    100,
  );
  const texture = banner.properties.find((property) => property.name === "texture").schema;
  assert.deepEqual(texture.builtInValues, [
    "none",
    "dots",
    "halftone",
    "paper",
    "grain",
    "grunge",
    "scanlines",
    "duotone",
  ]);
  // The literal above is the vocabulary agents see; this is what keeps it
  // Espalier's rather than ours (TR00630). A copied list would satisfy the
  // literal forever while drifting from the renderer that has to honour it.
  assert.deepEqual(texture.builtInValues, [...BUILT_IN_IMAGE_TEXTURES]);
  assert.deepEqual(texture.applicationRegistered, {
    accepted: true,
    requirement: "Register the texture with Espalier before rendering the page.",
  });
  assert.match(texture.description, /render with no texture until the application registers them/u);
  assert.equal(banner.example.texture, "paper");

  const output = formatReferenceResult({ topic: "component", component: banner });
  assert.match(output, /built-ins none, dots, halftone, paper, grain, grunge, scanlines, duotone/u);
  assert.match(output, /application-registered names accepted/u);

  const cropState = getComponentReference("card-grid").properties
    .find((property) => property.name === "cards").schema.items.properties
    .find((property) => property.name === "cropState");
  assert.deepEqual(cropState.schema.type, ["object", "null"]);
  assert.equal(cropState.schema.additionalProperties, false);
  assert.deepEqual(cropState.editorInitial, undefined);
});

test("every nested object schema explicitly rejects unlisted properties", () => {
  const assertClosed = (schema) => {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (types.includes("object")) assert.equal(schema.additionalProperties, false);
    if (schema.items) assertClosed(schema.items);
    for (const property of schema.properties ?? []) assertClosed(property.schema);
  };

  for (const componentType of COMPONENT_TYPES) {
    const reference = getComponentReference(componentType);
    assert.equal(reference.additionalProperties, false);
    for (const property of reference.properties) assertClosed(property.schema);
  }
});

test("the fixture reference is the shipped fixture's own manifest, not a restatement of it", async () => {
  const reference = getWorkflowReference("fixture");
  const directory = shippedFixtureDirectory();

  assert.equal(reference.fixtureDirectory, directory);
  // The example is the file `validate` reads, so a fixture edit cannot leave
  // `help fixture` describing the previous one.
  assert.deepEqual(
    reference.example,
    JSON.parse(await readFile(path.join(directory, FIXTURE_MANIFEST_FILE_NAME), "utf8")),
  );

  // Every derived claim is read from the constants the verb enforces.
  const details = reference.details.join("\n");
  assert.ok(details.includes(`manifestVersion must be ${MANIFEST_VERSION}`));
  assert.ok(details.includes(`fixture.contractVersion must be ${FIXTURE_CONTRACT_VERSION}`));
  assert.ok(details.includes(`settings binds all ${SETTINGS_GROUPS.length} authorable groups`));
  for (const group of SETTINGS_GROUPS) {
    assert.ok(details.includes(`${group.settingsType} to 'settings/${group.file}'`), group.settingsType);
  }
  for (const field of FIXTURE_REQUIRED_ROOT_FIELDS) {
    assert.ok(reference.example[field] !== undefined, `the example omits required field '${field}'`);
  }

  const human = formatReferenceResult({ topic: "workflow", reference });
  assert.ok(human.includes(`Shipped example: ${directory}`));
  assert.ok(human.includes(`Validate it: taproot-site validate "${directory}"`));
  assert.ok(human.includes(`\n\nExample:\n${JSON.stringify(reference.example, null, 2)}\n`));
});

test("a workflow reference without a shipped fixture renders exactly as it did", () => {
  const human = formatReferenceResult({ topic: "workflow", reference: getWorkflowReference("nav") });
  assert.ok(!human.includes("Shipped example:"));
  assert.match(human, /^Navigation workspace contract\n/u);
  assert.ok(human.includes("\n\nExample:\n"));
});

test("a fixture reference whose shipped file is unavailable still states the whole contract", () => {
  // What a `node_modules` pruner or an image-slimming step leaves behind: the
  // contract is complete without the example, so the topic drops the example
  // and the path it could not offer rather than failing. The pruned-install
  // test in package.test.js exercises the same degradation end to end.
  const { example, fixtureDirectory, ...pruned } = getWorkflowReference("fixture");
  assert.notEqual(example, undefined);
  assert.notEqual(fixtureDirectory, undefined);

  const human = formatReferenceResult({ topic: "workflow", reference: pruned });
  assert.match(human, /^Offline fixture manifest contract\n/u);
  assert.ok(!human.includes("Example:"));
  assert.ok(!human.includes("Shipped example:"));
  for (const detail of pruned.details) assert.ok(human.includes(`  - ${detail}`), detail);
});
