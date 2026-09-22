import { readFileSync } from "node:fs";

import { computeThemeProperties } from "@taprootio/espalier/shared/theme-properties";

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
  mergeTheme,
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
  validateAndLintThemePair,
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
    // The shape pull writes for a theme authored through its roles: no cached
    // mappings and a marker that claims none. The defaults' complete
    // semanticMappings would hand every agent who copies this twenty entries
    // the resolver never applies, each one a warning.
    semanticMappings: {},
    explicitMappingTokens: [],
    anchors: {
      plum: { color: "#6f2a78", text: "#4b1553", hover: "#8a3d92" },
      paper: "#fffaf4",
      midnight: "#21172b",
    },
    // Contrasting on purpose: light headings sit in the dark anchor on the
    // light canvas, dark headings in the paper anchor on the dark canvas. The
    // pair is resolved and contrast-checked by assertPresentationExamples.
    roles: scheme === "light"
      ? {
        canvas: "primary",
        ink: { color: "primary", heading: "anchor:midnight" },
        accent: { color: "anchor:plum", text: "anchor:plum.text", hover: "anchor:plum.hover" },
        action: { color: "anchor:plum", ink: "anchor:paper" },
        structure: "primary",
      }
      : {
        canvas: "primary",
        ink: { color: "primary", heading: "anchor:paper" },
        accent: { color: "anchor:plum", text: "anchor:plum.hover", hover: "anchor:paper" },
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
        // Left to the engine, the paper action compiles to a grey button with
        // a pale label — the wrong way round for a swatch that wants dark ink.
        // A context declares its own action, so it needs its own pin; 0.88
        // carries the midnight label at Lc 83 without crowding the status
        // colours, which a paler stop does.
        tones: { "paper-band": 0.88 },
        semanticMappings: { actionBackground: { source: "anchor:paper", lightness: "tone:paper-band" } },
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
        namePattern: "lowercase slug beginning with a letter",
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
      themeField(
        "fontMenu",
        "CSS font-family for navigation menu items and group labels; empty falls back to fontBody, never to headings.",
      ),
      ...["fontWeightBody", "fontWeightHeadings", "fontWeightBrand", "fontWeightMonospace", "fontWeightMenu"].map(
        (name) => themeField(name, "CSS font-weight: 1–1000, normal/bold/lighter/bolder, or a CSS-wide keyword."),
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

/**
 * How a role binding becomes a rendered token, in the order the resolver
 * applies it. Stated once here so help theme, the walkthrough and the
 * validation warnings describe the same model (TR00801, TR00806).
 */
export const ROLE_RESOLUTION = Object.freeze({
  slots: Object.freeze({
    canvas: Object.freeze([]),
    ink: Object.freeze(["heading"]),
    accent: Object.freeze(["text", "hover"]),
    action: Object.freeze(["ink"]),
    structure: Object.freeze([]),
  }),
  bindingForms: Object.freeze([
    "A role takes one mapping source, or { color, ...slots } to bind its slots separately.",
    "A geometric source (" + COLOR_SOURCES.filter((source) => !STATUS_COLOR_SOURCES.includes(source)).join(", ")
    + ") is relative: it takes the seed hue through that family's angle and the token's lightness stop, so it moves "
    + "with seedColor and the lightness ramp. A status family (" + STATUS_COLOR_SOURCES.join(", ")
    + ") keeps its fixed hue from semanticHues (or its intents override) and does not move with seedColor.",
    "anchor:<name> is absolute in hue and chroma: the anchor's declared colour supplies both, and the token's own "
    + "lightness stop (with APCA enforcement) still sets its lightness. anchor:<name>.<slot> selects one of the "
    + "anchor's declared slots (text, hover, ...) as that hue-and-chroma source and resolves the same way; neither "
    + "form renders the declared colour verbatim.",
    "Because an anchor supplies the chroma, a near-white anchor makes a near-grey ramp. A canvas anchor around "
    + "#FFFDF4 carries about 1% chroma, so background, every layer, and every border resolve at that 1% however "
    + "vivid the rest of the palette is: the page reads grey and no role, lightness stop or seedColor can add the "
    + "colour back. Give the canvas anchor the brand's own colour at full strength and let the lightness stops do "
    + "the lightening — a violet #6136C9 canvas resolves to a pale violet background and carries about 11% chroma "
    + "by the third layer, where a pale lavender picked to 'look like a light background' caps the whole ramp at "
    + "its own 6%. Choose the hue before the chroma: saturating toward whichever hue holds the most chroma near "
    + "white gives a tan page whatever the brand is, because pale yellows survive there and pale violets and blues "
    + "do not.",
    "A canvas anchor needs to be its own anchor. The light ink on a dark band is usually the same near-white the "
    + "light scheme wanted for its page, so one anchor ends up serving both, and then it cannot be saturated "
    + "without putting brand-coloured text on a brand-coloured band. Declare a second anchor for the canvas and "
    + "leave the pale one to its ink duty.",
    "Anchors resolve per scheme: the same anchor:<name> in lightTheme and darkTheme reads each scheme's own anchors "
    + "table, so a dark scheme usually declares darker or lighter anchors under the same names.",
  ]),
  precedence: Object.freeze([
    "A mapping in semanticMappings wins for its token only when explicitMappingTokens names it. The marker is what "
    + "makes a mapping a pin: the resolver recompiles every token the marker leaves out, so a mapping it does not "
    + "name is a cached value that is never applied. To pin a token, set the mapping and add the token to the "
    + "marker; to let a role reach it, drop the token from the marker or delete the mapping. A document that "
    + "carries no explicitMappingTokens at all predates the marker, and every mapping in it is still a pin.",
    "Otherwise the token is compiled from the roles, and an APCA contrast check may nudge an action or ink stop so "
    + "the pair stays readable.",
    "Otherwise the Espalier default mapping applies.",
    "A context rebinds roles, lightness, tones and pins for one zone with the same precedence inside that zone.",
  ]),
});

function themeLightness(value) {
  const match = /^oklch\(\s*([0-9.]+)/u.exec(value ?? "");
  return match ? Number(match[1]) : undefined;
}

/**
 * Each ink is checked against the surface it is actually painted on. A dark
 * example whose headings resolve to a dark anchor on a dark canvas validated
 * fine and read as a defect, so the examples must render as contrasting
 * pairs rather than merely validate. Action ink is the one that does not sit
 * on the canvas: it is painted on the action background, and pairing it with
 * the canvas asserts the wrong thing — an action ink chosen to read on a
 * dark button looked like a failure once the roles reached it.
 */
const EXAMPLE_CONTRAST_PAIRS = Object.freeze([
  ["--esp-color-text", "--esp-color-background"],
  ["--esp-color-headings", "--esp-color-background"],
  ["--esp-color-link", "--esp-color-background"],
  ["--esp-color-action-text", "--esp-color-action-background"],
]);

function assertExampleContrast(theme, scheme) {
  const properties = computeThemeProperties(
    mergeTheme(scheme === "light" ? DEFAULT_LIGHT_THEME : DEFAULT_DARK_THEME, theme),
    scheme,
  );
  for (const [token, surfaceToken] of EXAMPLE_CONTRAST_PAIRS) {
    const surface = themeLightness(properties[surfaceToken]);
    const lightness = themeLightness(properties[token]);
    if (surface === undefined || lightness === undefined || Math.abs(lightness - surface) < 0.4) {
      throw new Error(`${scheme} theme example: ${token} (${properties[token]}) does not contrast with ${surfaceToken} (${properties[surfaceToken]}).`);
    }
  }
}

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
    roleResolution: ROLE_RESOLUTION,
    workflow: [
      "Run taproot-site pull and edit the complete light/dark pair it writes; never build a sparse theme from memory. pull resolves the stored theme over the same defaults every consumer renders, so a fresh workspace validates and every group carries its effective value.",
      "Define brand anchors first, then assign canvas, ink, accent, action, and structure roles in both schemes. Give the canvas anchor as much chroma as the design's saturation calls for: it sets the chroma of the background, every layer and every border, so a near-white paper anchor produces a grey page that no other setting can rescue.",
      "Check the filled action before anything else looks finished. Its ramp stop is chosen by the engine near a mid-band target rather than named by the theme, so seating the ramp — the remedy for every other anchored token — cannot move it, and declaring an action role does not either. The only lever is pinning semanticMappings.actionBackground.",
      "A brand colour between roughly L 0.55 and L 0.83 cannot be a button surface at its own lightness: across that band no ink, not even pure black, reaches the Lc 75 APCA asks of a button label. Espalier then walks the label to the far end of the ramp and the button renders inverted — a dark surface carrying a pale label where the swatch wanted the opposite. Pin the stop just past the band instead. A gold at L 0.81 pinned to a tone at L 0.85 carries a dark label at Lc 76; the same gold left to the engine compiles to a brown one.",
      "Name a tone as a lowercase slug — gold-band, not goldBand. theme push refuses any other name, and refuses a mapping that names a tone its theme or context never declares.",
      "theme push runs Espalier's fit report over the root and every context in both schemes and lists each finding as a warning reading 'fit lint <id>'; theme push --dry-run does the same and writes nothing, and validate does it for an offline fixture. Read the lints before calling a theme done: action-anchor-inversion names a filled action that rendered the opposite way round from the swatches it declares, apca-target-unmet names a pair enforcement could not rescue, and action-canvas-separation and link-hover-ordering cover an action lost in its canvas and a hover weaker than its link. A lint is a warning, not a refusal, so a push still goes through with one — the lints are what tell an agent the design did not survive the compile.",
      "Add named contexts for whole zones, including inverted zones, and rebind lightness when the zone changes brightness. A context that declares its own action needs its own actionBackground pin: without one it compiles at the engine's mid-band stop, and where the root is pinned it carries the root's pin instead, whatever action colour the context declares.",
      "Tune typography, type/space ratios, radii, and viewport interpolation as one layout system.",
      "Typography is per scheme on purpose: light and dark set their own moods, so a heading, body, or brand face that differs between them is a design choice, and theme push never warns about it.",
      "Retune danger/success/warning/info through intents without changing their meanings; design data palettes separately.",
      "Use semanticMappings only for meanings roles and contexts cannot express; scattered pins shadow the coherent model. pull keeps only authored pins there and lists them in explicitMappingTokens; a mapping the marker does not name is never applied, so a hand-added pin needs its token added to the marker or theme push reports it as inert.",
      "Run theme push --dry-run and clear its warnings, fit lints included; then run theme push and verify text, actions, focus states, and both schemes in authoring previews.",
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
      "lightLogoId and darkLogoId are the current scheme-specific logo fields; there is no separate compact-logo setting. "
      + "Prefer transparent PNG or WebP artwork with genuine alpha so the header background shows through, including "
      + "inside letter counters. Avoid baked-in background rectangles unless the brand intentionally uses a badge. "
      + "Keep padding tight and verify the delivered image preserves transparency. Logo style and coloration are "
      + "project-specific: choose monochrome, an accent, or multiple colors to suit the brand, not a universal recipe. "
      + "Keep the lettering readable and test the visible artwork against each header scheme.",
    faviconContract:
      "Include a favicon when designing a site: upload a square, simplified brand mark and set brand.faviconId "
      + "in settings/brand.json, then run theme push; faviconUrl is a read-only projection. Do not shrink a full wordmark into a favicon. "
      + "Inspect at 16 and 32 pixels in light and dark browser tabs; a deliberate contrasting badge can help a favicon "
      + "remain recognizable independently of the header theme. Verify the published icon loads, not just the setting.",
    logoContrastContract:
      "Evaluate lightLogoId against the rendered light-scheme header and darkLogoId against the rendered dark-scheme "
      + "header at desktop and compact/mobile widths. Transparent pixels provide no contrast: inspect the visible mark, "
      + "not its canvas bounds. When one asset does not remain distinct in both schemes, supply scheme-specific logo "
      + "assets rather than relying on a shadow, outline, or header color that has not been previewed.",
    headerWidthContract:
      "headerWidth 'contained' keeps the brand and the header buttons at the page content edges; "
      + "'wide' moves them to the viewport edges. Pages with root-band components (image-banner) span the viewport, "
      + "so full-bleed designs usually pair headerWidth 'wide' with headerLayout 'centered-menu', which keeps the "
      + "brand left, the buttons right, and the navigation centered. validate prints a hint, never a failure, when a "
      + "root-band page ships with a contained header.",
    menuContract:
      "navDrawerStyle 'full-screen' (the published default) opens the mobile menu over the whole viewport with the "
      + "brand centered above large centered items and navDrawerTransition choosing how it appears (fade, slide-down, "
      + "slide-up, slide-left, or slide-right); 'panel' keeps the side panel, which exists for application-style "
      + "menus with many groups. The navigation face itself is not an appearance scalar: fontMenu and fontWeightMenu "
      + "are per-scheme theme fields set in settings.lightTheme/darkTheme the same way fontBrand is, and an empty "
      + "fontMenu falls back to the body font, never to headings.",
    changeSet: [
      "the ten footer scheme colors, overlaid onto the site's current footer document",
      "default scheme, assets, favicon, and header scalars",
      "the complete light theme and the complete dark theme",
    ],
    atomic: true,
    revision:
      "pull reads the four settings documents and the site's presentation revision — a server hash over exactly "
      + "the fields theme push writes — from one snapshot, so the recorded baseline is the revision of the "
      + "documents the workspace holds; theme push sends it back as the baseline. The whole change set commits in "
      + "one transaction or none of it does; a change to any of those fields since the pull refuses the push "
      + "(theme.concurrent_modification) and nothing is written. Footer prose, links and imagery, and the "
      + "publishing scalars are outside the revision, so an unrelated concurrent edit is preserved rather than "
      + "refused. footer push advances the baseline only when its save replaced that same revision.",
    dryRun:
      CLI_BINARY_NAME + " theme push --dry-run reads the site, lists the JSON paths at which each settings file "
      + "differs from it, and says whether the recorded baseline is still current or a pending save of the same "
      + "change set would be replayed; it writes nothing.",
    retry:
      "The save is recorded as pending in the manifest before it is sent. A save whose response was lost is "
      + "replayed by running theme push again with the same settings files: it goes under the baseline it was "
      + "first sent with, even after the site's revision moved, and the site answers applied=false when it already "
      + "holds the change set, so nothing is applied twice and no partial write is ever reported. Editing the "
      + "files before retrying makes the pending record moot and a moved revision refuses toward pull.",
    recovery:
      "On theme.concurrent_modification keep copies of the edited settings files, run " + CLI_BINARY_NAME
      + " pull to refresh the baseline, re-apply the edits, and push again. A Taproot without the atomic save "
      + "refuses with theme.server_unsupported; theme push never falls back to sequential writes.",
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
    type: "contact-or-web-url",
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
    type: "contact-or-web-url",
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
      "Each link has exactly one target: a tracked pageResourceId, or an externalUrl that is an absolute "
      + "credential-free http/https URL, or a mailto:/tel: contact URL such as tel:+15555550123. A contact URL is "
      + "published exactly as authored, so write the number the way it should be dialled.",
    imageRule:
      "Image ids come from pull or media upload. Feature images require alt text; background art is decorative.",
    readOnlyProjections: FOOTER_READ_ONLY_FIELDS,
    concurrency:
      "pull records expectedDraftHash. A conflict returns footer.concurrent_modification; pull, reconcile, and retry.",
    themeInteraction:
      "theme push overlays its ten scheme colors onto the site's current footer document inside its atomic save and "
      + "rewrites this file from the saved result. It refuses while unpushed footer-content edits exist "
      + "(theme.unpushed_footer_content); run " + CLI_BINARY_NAME + " footer push first, or " + CLI_BINARY_NAME
      + " pull to discard the local edit. A footer push that changed a scheme color advances the presentation "
      + "baseline theme push is fenced by.",
    workflow: [
      CLI_BINARY_NAME + " pull",
      "edit settings/site-publishing-preferences.json at settings.footerSettings",
      CLI_BINARY_NAME + " footer push",
      CLI_BINARY_NAME + " pull to verify the semantic round trip",
    ],
    example: FOOTER_EXAMPLE,
  };
}

export async function assertPresentationExamples() {
  const themes = await validateAndLintThemePair(THEME_EXAMPLE.lightTheme, THEME_EXAMPLE.darkTheme);
  // The example is what an agent copies, so it has to look like a finished
  // theme: nothing for validate to warn about, fit lints included.
  if (themes.warningCount > 0) {
    throw new Error(`The theme example raises ${themes.warningCount} warning(s): ${themes.warnings.join(" | ")}`);
  }
  assertExampleContrast(THEME_EXAMPLE.lightTheme, "light");
  assertExampleContrast(THEME_EXAMPLE.darkTheme, "dark");
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
      + "\n\nRole slots:\n"
      + Object.entries(reference.roleResolution.slots).map(([role, slots]) =>
        "  " + role.padEnd(10) + (slots.length === 0 ? "color only" : "color, " + slots.join(", "))
      ).join("\n")
      + "\n\nHow a binding resolves:\n"
      + reference.roleResolution.bindingForms.map((line) => "  - " + line).join("\n")
      + "\n\nPrecedence:\n"
      + reference.roleResolution.precedence.map((line, index) => "  " + (index + 1) + ". " + line).join("\n")
      + "\n\nTheme groups:\n" + groups + "\n\nValid complete pair (both schemes resolved and contrast-checked):\n"
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
      + "\nLogo contrast: " + reference.logoContrastContract
      + "\nFavicon: " + reference.faviconContract
      + "\nHeader width: " + reference.headerWidthContract
      + "\nMobile menu and menu font: " + reference.menuContract
      + "\nFooter: " + reference.footerBoundary
      + "\nFooter content guard: " + reference.footerContentGuard + "\n\nAtomic change set (one transaction):\n"
      + reference.changeSet.map((step, index) => "  " + (index + 1) + ". " + step).join("\n")
      + "\nRevision: " + reference.revision
      + "\nDry run: " + reference.dryRun
      + "\nRetry: " + reference.retry
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
