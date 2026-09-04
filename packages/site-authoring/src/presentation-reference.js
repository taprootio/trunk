import { readFileSync } from "node:fs";

import {
  DATA_SERIES_KEYS,
  DEFAULT_DATA_RAMP_STEPS,
  MAX_DATA_RAMP_STEPS,
  MIN_DATA_RAMP_STEPS,
} from "@taprootio/espalier/shared/data-colors";
import {
  COLOR_SOURCES,
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  LIGHTNESS_KEYS,
  NESTED_THEME_KEYS,
  ROLE_NAMES,
  SEMANTIC_COLOR_NAMES,
  STATUS_COLOR_SOURCES,
  VARIANT_COLOR_SOURCES,
} from "@taprootio/espalier/shared/theme";

import {
  APPEARANCE_FILES,
  APPEARANCE_FOOTER_COLOR_FIELDS,
  APPEARANCE_READ_ONLY_FIELDS,
  APPEARANCE_SCALAR_FIELDS,
} from "./appearance-contract.js";
import { CLI_BINARY_NAME } from "./constants.js";
import {
  FOOTER_BACKGROUND_PRESENTATIONS,
  FOOTER_EXAMPLE,
  FOOTER_FADE_MODES,
  FOOTER_FIELD_INVENTORY,
  FOOTER_LIMITS,
  FOOTER_READ_ONLY_FIELDS,
  validateFooterDocument,
} from "./footer-contract.js";
import {
  APPEARANCE_COLOR_CONSTRAINT,
  MAXIMUM_THEME_OPEN_MAP_ENTRIES,
  MAXIMUM_THEME_OPEN_MAP_KEY_SCALARS,
  REQUIRED_THEME_PROPERTIES,
  validateAndEncodeThemePair,
} from "./theme-validation.js";
import {
  SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES,
  SETTINGS_TYPE_TAPROOT_STYLES,
} from "./settings-catalog.js";

let espalierVersion;

function getEspalierVersion() {
  espalierVersion ??= JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).dependencies["@taprootio/espalier"];
  return espalierVersion;
}

const OPTIONAL_THEME_FIELDS = Object.freeze([
  "explicitMappingTokens",
  "boxBackgroundImage",
  "boxBackgroundImageOpacity",
  "vellumOpacity",
  "vellumBackgroundImage",
  "vellumBackgroundImageOpacity",
]);

export const THEME_FIELD_NAMES = Object.freeze([
  ...REQUIRED_THEME_PROPERTIES,
  ...OPTIONAL_THEME_FIELDS,
]);

const THEME_FIELD_TYPES = Object.freeze({
  explicitMappingTokens: "semantic-token[]",
  stylesheets: "string[]",
  pageBackgroundImage: "string",
  pageBackgroundImageOpacity: "number",
  boxBackgroundImage: "string",
  boxBackgroundImageOpacity: "number",
  vellumOpacity: "number",
  vellumBackgroundImage: "string",
  vellumBackgroundImageOpacity: "number",
});

function exampleTheme(defaults, scheme) {
  return {
    ...structuredClone(defaults),
    seedColor: scheme === "light" ? "oklch(0.58 0.14 305)" : "oklch(0.72 0.11 305)",
    pageBackgroundImage: "",
    pageBackgroundImageOpacity: 0,
    anchors: {
      plum: { color: "#6f2a78", text: "#4b1553", hover: "#8a3d92" },
      paper: "#fffaf4",
      midnight: "#21172b",
    },
    roles: {
      canvas: "primary",
      ink: { color: "primary", heading: "anchor:midnight" },
      accent: { color: "anchor:plum", text: "anchor:plum.text", hover: "anchor:plum.hover" },
      action: { color: "anchor:plum", ink: "anchor:paper" },
      structure: "primary",
    },
    contexts: {
      inverted: {
        canvas: "anchor:midnight",
        ink: { color: "anchor:paper", heading: "anchor:paper" },
        accent: { color: "anchor:plum", text: "anchor:paper", hover: "anchor:plum.hover" },
        action: { color: "anchor:paper", ink: "anchor:midnight" },
        structure: "anchor:paper",
        lightness: scheme === "light"
          ? { surface: 0.16, raised1: 0.2, raised2: 0.25, raised3: 0.3, raised4: 0.36, text: 0.96, ink: 0.99 }
          : { surface: 0.12, raised1: 0.16, raised2: 0.21, raised3: 0.27, raised4: 0.34, text: 0.96, ink: 0.99 },
      },
    },
    intents: { info: "#1467a8", danger: "#9c2433" },
  };
}

export const THEME_EXAMPLE = Object.freeze({
  lightTheme: Object.freeze(exampleTheme(DEFAULT_LIGHT_THEME, "light")),
  darkTheme: Object.freeze(exampleTheme(DEFAULT_DARK_THEME, "dark")),
});

function themeField(name, description, constraints = {}) {
  const defaultValue = Object.hasOwn(DEFAULT_LIGHT_THEME, name)
    ? structuredClone(DEFAULT_LIGHT_THEME[name])
    : undefined;
  return Object.freeze({
    name,
    type: THEME_FIELD_TYPES[name]
      ?? (Array.isArray(defaultValue) ? "array" : typeof defaultValue === "object" ? "object" : typeof defaultValue),
    description,
    ...(defaultValue === undefined ? { inheritedWhenOmitted: true } : { default: defaultValue }),
    ...constraints,
  });
}

const THEME_GROUPS = Object.freeze([
  Object.freeze({
    name: "brand-color-model",
    summary: "Declare brand anchors, assign designer-facing roles, and retune fixed-meaning status families.",
    fields: Object.freeze([
      themeField("seedColor", "Base CSS color for geometric sources; accepts hex, rgb(), hsl(), and oklch()."),
      themeField("anchors", "Open map of named absolute colors and optional named slots.", {
        additionalProperties: true,
        maximumEntries: MAXIMUM_THEME_OPEN_MAP_ENTRIES,
        namePattern: "lowercase slug beginning with a letter",
        maximumNameScalars: MAXIMUM_THEME_OPEN_MAP_KEY_SCALARS,
      }),
      themeField("roles", "Closed map of designer-facing functional color roles.", { keys: ROLE_NAMES }),
      themeField("contexts", "Open map of named zone-level role, lightness, tone, and mapping rebindings.", {
        additionalProperties: true,
        maximumEntries: MAXIMUM_THEME_OPEN_MAP_ENTRIES,
      }),
      themeField("angles", "Closed geometric hue-angle map; finite values outside 0–360 produce warnings.", {
        keys: ["analogous", "complementary", "splitComplementary", "triadic"],
      }),
      themeField("semanticHues", "Closed hue-angle map for danger, success, warning, and info.", {
        keys: STATUS_COLOR_SOURCES,
      }),
      themeField("intents", "Closed optional color overrides for the four fixed-meaning status families.", {
        keys: STATUS_COLOR_SOURCES,
      }),
    ]),
  }),
  Object.freeze({
    name: "semantic-engine",
    summary: "Use roles first; pin individual semantic mappings only when roles cannot express the intent.",
    fields: Object.freeze([
      themeField("lightness", "Closed 0–1 lightness ramp.", { keys: LIGHTNESS_KEYS, minimum: 0, maximum: 1 }),
      themeField("tones", "Open map of named 0–1 lightness values for explicit mappings.", {
        additionalProperties: true,
        maximumEntries: MAXIMUM_THEME_OPEN_MAP_ENTRIES,
        maximumNameScalars: MAXIMUM_THEME_OPEN_MAP_KEY_SCALARS,
        minimum: 0,
        maximum: 1,
      }),
      themeField("chroma", "Closed semantic-token map of { min, max }; min ≥ 0, max ≤ 0.4, min ≤ max.", {
        keys: SEMANTIC_COLOR_NAMES,
        minimum: 0,
        maximum: 0.4,
      }),
      themeField("semanticMappings", "Closed semantic-token map of { source, lightness }.", {
        keys: SEMANTIC_COLOR_NAMES,
        sourceValues: COLOR_SOURCES,
        lightnessValues: LIGHTNESS_KEYS,
      }),
      themeField("explicitMappingTokens", "Espalier-maintained list of mappings intentionally pinned.", {
        values: SEMANTIC_COLOR_NAMES,
      }),
      themeField("variantChroma", "Closed optional 0–0.4 base-chroma overrides for non-primary sources.", {
        keys: VARIANT_COLOR_SOURCES,
        minimum: 0,
        maximum: 0.4,
      }),
    ]),
  }),
  Object.freeze({
    name: "typography-and-scale",
    summary: "Choose families and weights, then tune type, spacing, radius, and fluid viewport scales together.",
    fields: Object.freeze([
      ...["fontBody", "fontHeadings", "fontBrand", "fontMonospace"].map((name) =>
        themeField(name, "CSS font-family; empty inherits the consuming surface's fallback.")
      ),
      ...["fontWeightBody", "fontWeightHeadings", "fontWeightBrand", "fontWeightMonospace"].map((name) =>
        themeField(name, "CSS font-weight: 1–1000, normal/bold/lighter/bolder, or a CSS-wide keyword.")
      ),
      themeField("rootFontSize", "Root font size in px.", { minimum: 1, warningMaximum: 100 }),
      themeField("typeRatio", "Modular type-scale ratio.", { exclusiveMinimum: 1, warningMaximum: 1.3 }),
      themeField("spaceRatio", "Modular spacing-scale ratio.", { exclusiveMinimum: 1, warningMaximum: 2 }),
      themeField("borderRadius", "Global border radius in rem.", { minimum: 0, warningMaximum: 10 }),
      themeField("viewportMin", "Minimum fluid-interpolation viewport in px.", { minimum: 100 }),
      themeField("viewportMax", "Maximum viewport in px; must exceed viewportMin.", { minimum: 200 }),
    ]),
  }),
  Object.freeze({
    name: "data-color",
    summary: "Keep categorical series distinguishable and use named ramps for ordered or diverging data.",
    fields: Object.freeze([
      themeField("dataPalette", "Closed eight-series map of CSS colors or anchor references.", {
        keys: DATA_SERIES_KEYS,
      }),
      themeField("dataRamps", "Open map of sequential or diverging ramp declarations.", {
        additionalProperties: true,
        maximumEntries: MAXIMUM_THEME_OPEN_MAP_ENTRIES,
        stepMinimum: MIN_DATA_RAMP_STEPS,
        stepMaximum: MAX_DATA_RAMP_STEPS,
        stepDefault: DEFAULT_DATA_RAMP_STEPS,
      }),
    ]),
  }),
  Object.freeze({
    name: "surface-assets",
    summary: "Preserve pulled asset fields; use appearance image ids for site-owned canvas art.",
    fields: Object.freeze([
      themeField("stylesheets", "Agent-authored site themes must keep this exact array empty.", { exact: [] }),
      themeField(
        "pageBackgroundImage",
        "CSS background-image; the complete Taproot workspace includes an empty value.",
      ),
      themeField("pageBackgroundImageOpacity", "Page background opacity.", { minimum: 0, maximum: 1 }),
      themeField("boxBackgroundImage", "Optional inherited box-surface background image."),
      themeField("boxBackgroundImageOpacity", "Optional box background opacity.", { minimum: 0, maximum: 1 }),
      themeField("vellumOpacity", "Optional modal-vellum opacity.", { minimum: 0, maximum: 1 }),
      themeField("vellumBackgroundImage", "Optional inherited vellum background image."),
      themeField("vellumBackgroundImageOpacity", "Optional vellum image opacity.", { minimum: 0, maximum: 1 }),
    ]),
  }),
]);

export function getThemeReference() {
  const version = getEspalierVersion();
  return {
    title: "Espalier " + version + " complete site-theme contract",
    referenceKind: "theme",
    espalierVersion: version,
    workspaceFile: APPEARANCE_FILES[SETTINGS_TYPE_TAPROOT_STYLES],
    themePaths: ["settings.lightTheme", "settings.darkTheme"],
    completeBaselineRequired: true,
    nestedMergeGroups: NESTED_THEME_KEYS,
    groups: THEME_GROUPS,
    vocabulary: {
      roles: ROLE_NAMES,
      colorSources: COLOR_SOURCES,
      statusFamilies: STATUS_COLOR_SOURCES,
      lightnessStops: LIGHTNESS_KEYS,
      semanticColors: SEMANTIC_COLOR_NAMES,
      dataSeries: DATA_SERIES_KEYS,
    },
    workflow: [
      "Run taproot-site pull and edit the complete light/dark pair it writes; never build a sparse theme from memory.",
      "Define brand anchors first, then assign canvas, ink, accent, action, and structure roles in both schemes.",
      "Add named contexts for whole zones, including inverted zones, and rebind lightness when the zone changes brightness.",
      "Tune typography, type/space ratios, radii, and viewport interpolation as one layout system.",
      "Typography is per scheme on purpose: light and dark set their own moods, so a heading, body, or brand face that differs between them is a design choice, and theme push never warns about it.",
      "Retune danger/success/warning/info through intents without changing their meanings; design data palettes separately.",
      "Use semanticMappings only for meanings roles and contexts cannot express; scattered pins shadow the coherent model.",
      "Run theme push, inspect warnings, then verify text, actions, focus states, and both schemes in authoring previews.",
    ],
    example: THEME_EXAMPLE,
  };
}

function appearanceColorReference(definition) {
  return definition.type === "appearance-color"
    ? {
      allowedTokens: [...definition.allowedTokens],
      customForms: APPEARANCE_COLOR_CONSTRAINT.customForms,
      maximumLength: APPEARANCE_COLOR_CONSTRAINT.maximumLength,
    }
    : {};
}

export function getAppearanceReference() {
  const scalarFields = APPEARANCE_SCALAR_FIELDS.map((field) => ({
    file: APPEARANCE_FILES[field.settingsType],
    path: "settings." + field.name,
    type: field.type,
    ...(field.values ? { values: field.values } : {}),
    ...(field.minimum !== undefined ? { minimum: field.minimum, maximum: field.maximum } : {}),
    ...(field.maximumLength !== undefined ? { maximumLength: field.maximumLength } : {}),
    ...appearanceColorReference(field),
    default: field.default,
  }));
  return {
    title: "Site appearance workspace and theme-push contract",
    referenceKind: "appearance",
    usage: CLI_BINARY_NAME + " theme push",
    fields: [
      {
        file: APPEARANCE_FILES[SETTINGS_TYPE_TAPROOT_STYLES],
        path: "settings.lightTheme",
        type: "complete-espalier-theme",
      },
      {
        file: APPEARANCE_FILES[SETTINGS_TYPE_TAPROOT_STYLES],
        path: "settings.darkTheme",
        type: "complete-espalier-theme",
      },
      ...scalarFields,
      ...APPEARANCE_FOOTER_COLOR_FIELDS.map((field) => ({
        file: field.file,
        path: field.path,
        type: field.type,
        ...appearanceColorReference(field),
        default: field.default,
      })),
    ],
    readOnlyProjections: APPEARANCE_READ_ONLY_FIELDS,
    imageReferences:
      "Use site-owned image ids retained from pull or returned by media upload. URLs are server projections, never authored inputs.",
    logoContract:
      "lightLogoId and darkLogoId are the current scheme-specific logo fields; there is no separate compact-logo setting.",
    mutationOrder: [
      "fresh footer read plus concurrency-protected ten-color overlay",
      "default scheme, brand fonts and assets, favicon, and header scalars",
      "complete light theme, then complete dark theme",
    ],
    nonAtomic: true,
    recovery:
      "A failure reports completedWrites. Pull, compare the remote result with the intended workspace, reconcile, and retry.",
    footerBoundary:
      "theme push changes only five colors per footer scheme. Use footer push for prose, links, layout, and imagery.",
    footerContentGuard:
      "theme push refuses while settings.footerSettings carries unpushed content edits: "
      + "theme.unpushed_footer_content names " + CLI_BINARY_NAME + " footer push to save them "
      + "(" + CLI_BINARY_NAME + " pull discards them). A workspace pulled before this baseline "
      + "fails theme.pull_required; footer push records it non-destructively, while pull "
      + "discards local edits and re-records it.",
  };
}

const FOOTER_FIELD_DETAILS = Object.freeze({
  "FooterSettings.enabled": { type: "boolean", default: false },
  "FooterSettings.showBrand": { type: "boolean", default: true },
  "FooterSettings.showBrandText": { type: "boolean", default: true },
  "FooterSettings.linkColumns": { type: "FooterLinkColumn[]", default: [], maximumItems: FOOTER_LIMITS.linkColumns },
  "FooterSettings.asideHeadingContent": {
    type: "FooterRichText",
    default: { paragraphs: [] },
    maximumCharacters: FOOTER_LIMITS.asideHeadingLength,
    maximumParagraphs: 1,
  },
  "FooterSettings.asideBodyContent": {
    type: "FooterRichText",
    default: { paragraphs: [] },
    maximumCharacters: FOOTER_LIMITS.asideBodyLength,
    maximumParagraphs: FOOTER_LIMITS.richTextParagraphs,
  },
  "FooterSettings.asideCta": { type: "FooterLink|null", default: null },
  "FooterSettings.bottomContent": {
    type: "FooterRichText",
    default: { paragraphs: [] },
    maximumCharacters: FOOTER_LIMITS.bottomTextLength,
    maximumParagraphs: FOOTER_LIMITS.richTextParagraphs,
  },
  "FooterSettings.bottomLinks": { type: "FooterLink[]", default: [], maximumItems: FOOTER_LIMITS.bottomLinks },
  "FooterSettings.light": { type: "FooterSchemeSettings", default: "scheme defaults" },
  "FooterSettings.dark": { type: "FooterSchemeSettings", default: "scheme defaults" },
  "FooterSettings.featureImage": { type: "FooterFeatureImageSettings|null", default: null },
  "FooterLinkColumn.id": { type: "canonical-lowercase-uuid", required: true },
  "FooterLinkColumn.groups": { type: "FooterLinkGroup[]", default: [], maximumItems: FOOTER_LIMITS.groupsPerColumn },
  "FooterLinkGroup.id": { type: "canonical-lowercase-uuid", required: true },
  "FooterLinkGroup.heading": {
    type: "plain-text",
    requiredWhen: "links is nonempty",
    maximumLength: FOOTER_LIMITS.groupHeadingLength,
  },
  "FooterLinkGroup.links": { type: "FooterLink[]", default: [], maximumItems: FOOTER_LIMITS.linksPerGroup },
  "FooterLink.id": { type: "canonical-lowercase-uuid", required: true },
  "FooterLink.label": { type: "plain-text", required: true, maximumLength: FOOTER_LIMITS.linkLabelLength },
  "FooterLink.pageResourceId": { type: "tracked-page-resource-uuid", exclusiveWith: "externalUrl" },
  "FooterLink.externalUrl": {
    type: "absolute-http-or-https-url",
    exclusiveWith: "pageResourceId",
    maximumLength: FOOTER_LIMITS.externalUrlLength,
  },
  "FooterRichText.paragraphs": { type: "FooterRichTextParagraph[]", default: [] },
  "FooterRichTextParagraph.runs": { type: "FooterRichTextRun[]", default: [] },
  "FooterRichTextRun.text": { type: "string", required: true },
  "FooterRichTextRun.bold": { type: "boolean", default: false },
  "FooterRichTextRun.italic": { type: "boolean", default: false },
  "FooterRichTextRun.underline": { type: "boolean", default: false },
  "FooterRichTextRun.link": { type: "FooterInlineLink|null", default: null },
  "FooterInlineLink.pageResourceId": { type: "tracked-page-resource-uuid", exclusiveWith: "externalUrl" },
  "FooterInlineLink.externalUrl": {
    type: "absolute-http-or-https-url",
    exclusiveWith: "pageResourceId",
    maximumLength: FOOTER_LIMITS.externalUrlLength,
  },
  "FooterSchemeSettings.backgroundColor": {
    type: "appearance-color",
    ...appearanceColorReference(APPEARANCE_FOOTER_COLOR_FIELDS.find((field) => field.name === "backgroundColor")),
    default: "",
  },
  "FooterSchemeSettings.textColor": {
    type: "appearance-color",
    ...appearanceColorReference(APPEARANCE_FOOTER_COLOR_FIELDS.find((field) => field.name === "textColor")),
    default: "",
  },
  "FooterSchemeSettings.headingColor": {
    type: "appearance-color",
    ...appearanceColorReference(APPEARANCE_FOOTER_COLOR_FIELDS.find((field) => field.name === "headingColor")),
    default: "",
  },
  "FooterSchemeSettings.linkColor": {
    type: "appearance-color",
    ...appearanceColorReference(APPEARANCE_FOOTER_COLOR_FIELDS.find((field) => field.name === "linkColor")),
    default: "",
  },
  "FooterSchemeSettings.linkHoverColor": {
    type: "appearance-color",
    ...appearanceColorReference(APPEARANCE_FOOTER_COLOR_FIELDS.find((field) => field.name === "linkHoverColor")),
    default: "",
  },
  "FooterSchemeSettings.backgroundImageId": { type: "site-owned-image-uuid", default: "" },
  "FooterSchemeSettings.backgroundImageUrl": { type: "url", readOnly: true },
  "FooterSchemeSettings.backgroundImageOpacity": { type: "number", default: 1, minimum: 0, maximum: 1 },
  "FooterSchemeSettings.backgroundPresentation": {
    type: "enum",
    default: FOOTER_BACKGROUND_PRESENTATIONS[0],
    values: FOOTER_BACKGROUND_PRESENTATIONS,
  },
  "FooterSchemeSettings.backgroundFade": { type: "enum", default: FOOTER_FADE_MODES[0], values: FOOTER_FADE_MODES },
  "FooterSchemeSettings.backgroundRepeatHeightPx": {
    type: "integer",
    default: FOOTER_LIMITS.backgroundRepeatHeightDefault,
    minimum: FOOTER_LIMITS.backgroundRepeatHeightMinimum,
    maximum: FOOTER_LIMITS.backgroundRepeatHeightMaximum,
    step: FOOTER_LIMITS.backgroundRepeatHeightStep,
  },
  "FooterSchemeSettings.additionalTopPaddingRem": {
    type: "number",
    default: 0,
    minimum: 0,
    maximum: FOOTER_LIMITS.additionalTopPaddingRemMaximum,
  },
  "FooterFeatureImageSettings.imageId": { type: "site-owned-image-uuid", requiredWith: "alt" },
  "FooterFeatureImageSettings.imageUrl": { type: "url", readOnly: true },
  "FooterFeatureImageSettings.alt": {
    type: "plain-text",
    requiredWith: "imageId",
    maximumLength: FOOTER_LIMITS.featureImageAltLength,
  },
  "FooterFeatureImageSettings.responsiveUrls": { type: "FooterFeatureResponsiveImageUrl[]", readOnly: true },
  "FooterFeatureResponsiveImageUrl.minWidth": { type: "integer", readOnly: true },
  "FooterFeatureResponsiveImageUrl.url": { type: "url", readOnly: true },
});

function footerMessages() {
  return Object.entries(FOOTER_FIELD_INVENTORY).map(([name, fields]) => ({
    name,
    additionalProperties: false,
    fields: fields.map((field) => ({ name: field, ...FOOTER_FIELD_DETAILS[name + "." + field] })),
  }));
}

export function getFooterReference() {
  return {
    title: "Complete footer workspace and save contract",
    referenceKind: "footer",
    usage: CLI_BINARY_NAME + " footer push",
    workspaceFile: APPEARANCE_FILES[SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES],
    workspacePath: "settings.footerSettings",
    messages: footerMessages(),
    totalGroupMaximum: FOOTER_LIMITS.linkGroups,
    totalRichTextRunsMaximum: FOOTER_LIMITS.richTextRuns,
    targetRule:
      "Each link has exactly one target: a tracked pageResourceId, or an absolute credential-free http/https externalUrl.",
    imageRule:
      "Image ids come from pull or media upload. Feature images require alt text; background art is decorative.",
    readOnlyProjections: FOOTER_READ_ONLY_FIELDS,
    concurrency:
      "pull records expectedDraftHash. A conflict returns footer.concurrent_modification; pull, reconcile, and retry.",
    themeInteraction:
      "theme push rewrites this file from a fresh server read before its ten-color overlay. It refuses while "
      + "unpushed footer-content edits exist (theme.unpushed_footer_content); run " + CLI_BINARY_NAME
      + " footer push first, or " + CLI_BINARY_NAME + " pull to discard the local edit.",
    workflow: [
      CLI_BINARY_NAME + " pull",
      "edit settings/site-publishing-preferences.json at settings.footerSettings",
      CLI_BINARY_NAME + " footer push",
      CLI_BINARY_NAME + " pull to verify the semantic round trip",
    ],
    example: FOOTER_EXAMPLE,
  };
}

export function assertPresentationExamples() {
  validateAndEncodeThemePair(THEME_EXAMPLE.lightTheme, THEME_EXAMPLE.darkTheme);
  validateFooterDocument(FOOTER_EXAMPLE);
}

function fieldConstraint(field) {
  const details = [];
  if (field.readOnly) details.push("read-only");
  if (field.required) details.push("required");
  if (field.requiredWhen) details.push(`required when ${field.requiredWhen}`);
  if (field.requiredWith) details.push(`required with ${field.requiredWith}`);
  if (field.exclusiveWith) details.push(`exclusive with ${field.exclusiveWith}`);
  if (Object.hasOwn(field, "default")) details.push(`default ${JSON.stringify(field.default)}`);
  if (field.inheritedWhenOmitted) details.push("inherits when omitted");
  if (field.additionalProperties === true) details.push("open named map");
  if (field.additionalProperties === false) details.push("unlisted keys rejected");
  if (field.values) details.push(`values ${field.values.join(", ")}`);
  if (field.allowedTokens) details.push(`tokens ${field.allowedTokens.join(", ")}`);
  if (field.customForms) {
    details.push(
      "custom colors " + field.customForms.map((form) =>
        form.lightness
          ? `${form.syntax} with lightness ${form.lightness.minimum}..${form.lightness.maximum}, `
            + `chroma ${form.chroma.minimum}..${form.chroma.maximum}, hue ${form.hue.minimum}..${form.hue.maximum}`
          : form.syntax
      ).join(" or "),
    );
  }
  if (field.keys) details.push(`keys ${field.keys.join(", ")}`);
  if (field.minimum !== undefined) details.push(`minimum ${field.minimum}`);
  if (field.exclusiveMinimum !== undefined) details.push(`greater than ${field.exclusiveMinimum}`);
  if (field.maximum !== undefined) details.push(`maximum ${field.maximum}`);
  if (field.warningMaximum !== undefined) details.push(`warning above ${field.warningMaximum}`);
  if (field.maximumItems !== undefined) details.push(`maximum ${field.maximumItems} items`);
  if (field.maximumEntries !== undefined) details.push(`maximum ${field.maximumEntries} entries`);
  if (field.maximumLength !== undefined) details.push(`maximum ${field.maximumLength} characters`);
  if (field.maximumCharacters !== undefined) details.push(`maximum ${field.maximumCharacters} characters total`);
  if (field.maximumParagraphs !== undefined) details.push(`maximum ${field.maximumParagraphs} paragraphs`);
  if (field.maximumNameScalars !== undefined) details.push(`maximum ${field.maximumNameScalars} name characters`);
  if (field.namePattern) details.push(`names are ${field.namePattern}`);
  if (field.sourceValues) details.push(`sources ${field.sourceValues.join(", ")}`);
  if (field.lightnessValues) details.push(`lightness ${field.lightnessValues.join(", ")}`);
  if (field.step !== undefined) details.push(`step ${field.step}`);
  if (field.stepMinimum !== undefined) {
    details.push(`steps ${field.stepMinimum}..${field.stepMaximum}; default ${field.stepDefault}`);
  }
  if (field.exact !== undefined) details.push(`exactly ${JSON.stringify(field.exact)}`);
  return (field.type ?? "object") + (details.length > 0 ? `; ${details.join("; ")}` : "");
}

export function formatPresentationReference(reference) {
  if (reference.referenceKind === "theme") {
    const groups = reference.groups.map((group) =>
      "\n" + group.name + ": " + group.summary + "\n"
      + group.fields.map((field) => "  " + field.name.padEnd(30) + field.description + " " + fieldConstraint(field))
        .join("\n")
    ).join("\n");
    return reference.title + "\nWorkspace: " + reference.workspaceFile + " ("
      + reference.themePaths.join(", ") + ")\nComplete pulled baseline required: yes\nNested merge groups: "
      + reference.nestedMergeGroups.join(", ") + "\n\nDesign workflow:\n"
      + reference.workflow.map((step, index) => "  " + (index + 1) + ". " + step).join("\n")
      + "\n\nTheme groups:\n" + groups + "\n\nValid complete pair:\n"
      + JSON.stringify(reference.example, null, 2) + "\n";
  }
  if (reference.referenceKind === "appearance") {
    return reference.title + "\nUsage: " + reference.usage + "\n\nWritable fields:\n"
      + reference.fields.map((field) => "  " + field.file + " :: " + field.path + " — " + fieldConstraint(field)).join(
        "\n",
      )
      + "\n\nRead-only server projections:\n"
      + reference.readOnlyProjections.map((field) => "  " + field.file + " :: " + field.path).join("\n")
      + "\n\nImages: " + reference.imageReferences + "\nLogos: " + reference.logoContract
      + "\nFooter: " + reference.footerBoundary
      + "\nFooter content guard: " + reference.footerContentGuard + "\n\nMutation order (non-atomic):\n"
      + reference.mutationOrder.map((step, index) => "  " + (index + 1) + ". " + step).join("\n")
      + "\nRecovery: " + reference.recovery + "\n";
  }
  if (reference.referenceKind === "footer") {
    const messages = reference.messages.map((message) =>
      message.name + " (unlisted fields rejected)\n"
      + message.fields.map((field) => "  " + field.name.padEnd(30) + fieldConstraint(field)).join("\n")
    ).join("\n\n");
    return reference.title + "\nUsage: " + reference.usage + "\nWorkspace: "
      + reference.workspaceFile + " :: " + reference.workspacePath + "\n\nClosed schema:\n"
      + messages + "\n\nTargets: " + reference.targetRule + "\nImages: " + reference.imageRule
      + "\nConcurrency: " + reference.concurrency
      + "\nTheme interaction: " + reference.themeInteraction + "\nRead-only projections: "
      + reference.readOnlyProjections.join(", ") + "\n\nWorkflow:\n"
      + reference.workflow.map((step, index) => "  " + (index + 1) + ". " + step).join("\n")
      + "\n\nValid marketing-site example:\n"
      + JSON.stringify(reference.example, null, 2) + "\n";
  }
  throw new TypeError("Unknown presentation reference kind '" + reference.referenceKind + "'.");
}
