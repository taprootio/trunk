import {
  encodeTheme,
  LIGHTNESS_KEYS,
  SEMANTIC_COLOR_NAMES,
  validateThemePair,
} from "@taprootio/espalier/shared/theme";

import { hasControlCharacter, sanitizeDiagnostic, SiteAuthoringError } from "./errors.js";

export const MAXIMUM_THEME_WARNINGS = 32;
export const MAXIMUM_THEME_WARNING_SCALARS = 512;
export const MAXIMUM_THEME_OPEN_MAP_ENTRIES = 128;
export const MAXIMUM_THEME_OPEN_MAP_KEY_SCALARS = 64;

// Kept in the same order as DefaultSiteTheme.RequiredProperties. This is the
// storage doctrine rather than every optional Espalier property: a site theme
// may add optional surfaces, but it may not omit one of the groups whose
// absence makes the app, preview, and generator resolve differently.
export const REQUIRED_THEME_PROPERTIES = Object.freeze([
  "seedColor",
  "angles",
  "chroma",
  "lightness",
  "semanticHues",
  "semanticMappings",
  "variantChroma",
  "intents",
  "tones",
  "anchors",
  "roles",
  "contexts",
  "dataRamps",
  "dataPalette",
  "borderRadius",
  "rootFontSize",
  "typeRatio",
  "spaceRatio",
  "viewportMin",
  "viewportMax",
  "stylesheets",
  "pageBackgroundImage",
  "pageBackgroundImageOpacity",
  "fontBody",
  "fontHeadings",
  "fontBrand",
  "fontMonospace",
  "fontWeightBody",
  "fontWeightHeadings",
  "fontWeightBrand",
  "fontWeightMonospace",
]);

const REQUIRED_ANGLE_LEAVES = Object.freeze([
  "analogous",
  "complementary",
  "splitComplementary",
  "triadic",
]);
const REQUIRED_SEMANTIC_HUE_LEAVES = Object.freeze(["danger", "success", "warning", "info"]);
const REQUIRED_DATA_PALETTE_LEAVES = Object.freeze([
  "series1",
  "series2",
  "series3",
  "series4",
  "series5",
  "series6",
  "series7",
  "series8",
]);

// Fixed-shape descendants are part of completeness too. Espalier validation
// accepts these objects sparsely because it also validates page-level deltas;
// a stored agent-authored site theme has the stricter frozen-value contract.
export const REQUIRED_THEME_PATHS = Object.freeze([
  ...REQUIRED_ANGLE_LEAVES.map((leaf) => `angles.${leaf}`),
  ...SEMANTIC_COLOR_NAMES.flatMap((color) => [`chroma.${color}.min`, `chroma.${color}.max`]),
  ...LIGHTNESS_KEYS.map((leaf) => `lightness.${leaf}`),
  ...REQUIRED_SEMANTIC_HUE_LEAVES.map((leaf) => `semanticHues.${leaf}`),
  ...REQUIRED_DATA_PALETTE_LEAVES.map((leaf) => `dataPalette.${leaf}`),
]);

export const HEADER_BRAND_COLOR_TOKENS = Object.freeze(
  new Set([
    "--esp-color-headings",
    "--esp-color-link",
    "--esp-color-primary",
    "--esp-color-text",
  ]),
);

export const FOOTER_COLOR_TOKENS = Object.freeze({
  backgroundColor: new Set([
    "--esp-color-background",
    "--esp-color-layer-1",
    "--esp-color-layer-2",
    "--esp-color-layer-3",
    "--esp-color-layer-4",
  ]),
  textColor: new Set(["--esp-color-text", "--esp-color-headings"]),
  headingColor: new Set(["--esp-color-headings", "--esp-color-text"]),
  linkColor: new Set(["--esp-color-link", "--esp-color-headings"]),
  linkHoverColor: new Set(["--esp-color-link-hover", "--esp-color-link"]),
});

export const APPEARANCE_COLOR_CONSTRAINT = Object.freeze({
  maximumLength: 128,
  customForms: Object.freeze([
    Object.freeze({ syntax: "#rgb | #rgba | #rrggbb | #rrggbbaa" }),
    Object.freeze({
      syntax: "oklch(lightness chroma hue)",
      lightness: Object.freeze({ minimum: 0, maximum: 1 }),
      chroma: Object.freeze({ minimum: 0, maximum: 0.25 }),
      hue: Object.freeze({ minimum: 0, maximum: 360 }),
    }),
  ]),
});

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;
const OKLCH_COLOR =
  /^oklch\( *(?<lightness>(?:0|[1-9]\d*)(?:\.\d+)?) +(?<chroma>(?:0|[1-9]\d*)(?:\.\d+)?) +(?<hue>(?:0|[1-9]\d*)(?:\.\d+)?) *\)$/iu;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code, message, field) {
  throw new SiteAuthoringError(code, message, { field });
}

function hasThemePath(theme, path) {
  let current = theme;
  for (const segment of path.split(".")) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return false;
    current = current[segment];
  }
  return true;
}

function requireBoundedOpenMaps(theme, scheme) {
  for (const property of ["anchors", "contexts", "dataRamps"]) {
    const collection = theme[property];
    if (!isPlainObject(collection)) continue;
    if (Object.keys(collection).length > MAXIMUM_THEME_OPEN_MAP_ENTRIES) {
      fail(
        "theme.collection_too_large",
        `${scheme}Theme.${property} may contain at most ${MAXIMUM_THEME_OPEN_MAP_ENTRIES} entries.`,
        `${scheme}Theme.${property}`,
      );
    }
    if (
      property === "anchors"
      && (
        Object.keys(collection).some((key) => [...key].length > MAXIMUM_THEME_OPEN_MAP_KEY_SCALARS)
        || Object.values(collection).some((anchor) =>
          isPlainObject(anchor)
          && Object.keys(anchor).some((key) =>
            key !== "color" && [...key].length > MAXIMUM_THEME_OPEN_MAP_KEY_SCALARS
          )
        )
      )
    ) {
      fail(
        "theme.collection_key_too_long",
        `${scheme}Theme.anchors names and slot names may contain at most ${MAXIMUM_THEME_OPEN_MAP_KEY_SCALARS} characters.`,
        `${scheme}Theme.anchors`,
      );
    }
    if (
      property === "anchors"
      && Object.values(collection).some((anchor) =>
        isPlainObject(anchor)
        && Object.keys(anchor).filter((key) => key !== "color").length
          > MAXIMUM_THEME_OPEN_MAP_ENTRIES
      )
    ) {
      fail(
        "theme.collection_too_large",
        `${scheme}Theme.anchors entries may define at most ${MAXIMUM_THEME_OPEN_MAP_ENTRIES} slots besides color.`,
        `${scheme}Theme.anchors`,
      );
    }
  }
}

function requireBoundedToneMap(tones, field) {
  if (!isPlainObject(tones)) {
    fail("theme.document_invalid", `${field} must be a JSON object.`, field);
  }
  if (Object.keys(tones).length > MAXIMUM_THEME_OPEN_MAP_ENTRIES) {
    fail(
      "theme.collection_too_large",
      `${field} may contain at most ${MAXIMUM_THEME_OPEN_MAP_ENTRIES} entries.`,
      field,
    );
  }
  if (Object.keys(tones).some((key) => [...key].length > MAXIMUM_THEME_OPEN_MAP_KEY_SCALARS)) {
    fail(
      "theme.collection_key_too_long",
      `${field} names may contain at most ${MAXIMUM_THEME_OPEN_MAP_KEY_SCALARS} characters.`,
      field,
    );
  }
}

function requireBoundedToneMaps(theme, scheme) {
  requireBoundedToneMap(theme.tones, `${scheme}Theme.tones`);
  if (!isPlainObject(theme.contexts)) return;
  for (const [contextName, context] of Object.entries(theme.contexts)) {
    if (isPlainObject(context) && Object.hasOwn(context, "tones")) {
      requireBoundedToneMap(
        context.tones,
        `${scheme}Theme.contexts.${contextName}.tones`,
      );
    }
  }
}

function requireCompleteTheme(theme, scheme) {
  if (!isPlainObject(theme)) {
    fail("theme.document_invalid", `${scheme}Theme must be a JSON object.`, `${scheme}Theme`);
  }
  for (const property of REQUIRED_THEME_PROPERTIES) {
    if (!Object.hasOwn(theme, property)) {
      fail(
        "theme.incomplete",
        `${scheme}Theme is missing '${property}'. Start from the complete theme written by 'taproot-site pull'.`,
        `${scheme}Theme.${property}`,
      );
    }
  }
  for (const property of ["semanticMappings", "variantChroma", "tones"]) {
    if (!isPlainObject(theme[property])) {
      fail(
        "theme.document_invalid",
        `${scheme}Theme.${property} must be a JSON object.`,
        `${scheme}Theme.${property}`,
      );
    }
  }
  requireBoundedOpenMaps(theme, scheme);
  requireBoundedToneMaps(theme, scheme);
  for (const path of REQUIRED_THEME_PATHS) {
    if (!hasThemePath(theme, path)) {
      fail(
        "theme.incomplete",
        `${scheme}Theme is missing '${path}'. Start from the complete theme written by 'taproot-site pull'.`,
        `${scheme}Theme.${path}`,
      );
    }
  }
}

function refuseAgentStylesheets(theme, scheme) {
  // Espalier keeps this array in its complete theme document, but an external
  // stylesheet is mutable code outside the frozen authoring-preview inventory.
  // Agent themes use roles, contexts, anchors, and the font-family fields; they
  // must not add a second styling channel that the preview CSP cannot reproduce.
  if (
    Array.isArray(theme.stylesheets)
    && theme.stylesheets.length > 0
  ) {
    fail(
      "theme.stylesheets_unsupported",
      `${scheme}Theme.stylesheets must remain empty. Set it to [] in settings/taproot-styles.json; this will remove it from the published site when the theme is deployed. Use Espalier roles, contexts, anchors, and font fields instead of external CSS.`,
      `${scheme}Theme.stylesheets`,
    );
  }
}

export function validateAndEncodeThemePair(lightTheme, darkTheme) {
  requireCompleteTheme(lightTheme, "light");
  requireCompleteTheme(darkTheme, "dark");

  let light;
  let dark;
  try {
    light = encodeTheme(lightTheme);
    dark = encodeTheme(darkTheme);
  } catch (error) {
    throw new SiteAuthoringError(
      "theme.encoding_failed",
      "The theme contains text Espalier cannot encode. Use the same theme vocabulary emitted by Taproot pull.",
      { cause: error },
    );
  }

  const result = validateThemePair(light, dark);
  if (!result.valid) {
    const first = result.errors[0] ?? "The theme pair is invalid.";
    const field = /^\s*(?:light|dark):\s*Every entry in ([A-Za-z0-9_.-]+)/u.exec(first)?.[1]
      ?? /^\s*(?:light|dark):\s*([A-Za-z0-9_.-]+)/u.exec(first)?.[1]
      ?? (/^\s*contexts\b/u.test(first) ? "contexts" : undefined);
    throw new SiteAuthoringError(
      "theme.validation_failed",
      `Espalier rejected the theme: ${first}`,
      { field },
    );
  }
  refuseAgentStylesheets(lightTheme, "light");
  refuseAgentStylesheets(darkTheme, "dark");
  const warnings = result.warnings
    .slice(0, MAXIMUM_THEME_WARNINGS)
    .map((warning) => [...sanitizeDiagnostic(warning, "Theme validation warning.")]
      .slice(0, MAXIMUM_THEME_WARNING_SCALARS)
      .join(""));
  return {
    light,
    dark,
    warnings,
    warningCount: result.warnings.length,
    warningsTruncated: result.warnings.length > warnings.length,
  };
}

function supportedNumber(value, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum;
}

export function isSupportedAppearanceColor(value, allowedTokens) {
  if (
    typeof value !== "string"
    || value.length > APPEARANCE_COLOR_CONSTRAINT.maximumLength
    || hasControlCharacter(value)
  ) return false;
  if (value === "" || allowedTokens.has(value) || HEX_COLOR.test(value)) return true;
  const match = OKLCH_COLOR.exec(value);
  const oklch = APPEARANCE_COLOR_CONSTRAINT.customForms[1];
  return match !== null
    && supportedNumber(match.groups?.lightness, oklch.lightness.minimum, oklch.lightness.maximum)
    && supportedNumber(match.groups?.chroma, oklch.chroma.minimum, oklch.chroma.maximum)
    && supportedNumber(match.groups?.hue, oklch.hue.minimum, oklch.hue.maximum);
}

export function requireAppearanceColor(value, allowedTokens, field) {
  if (!isSupportedAppearanceColor(value, allowedTokens)) {
    fail(
      "theme.color_invalid",
      `${field} must be empty, an allowed Espalier semantic token, a hex color, or a bounded oklch color.`,
      field,
    );
  }
  return value;
}
