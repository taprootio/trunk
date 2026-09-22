import {
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  encodeTheme,
  LIGHTNESS_KEYS,
  mergeTheme,
  parseTheme,
  SEMANTIC_COLOR_NAMES,
  validateThemePair,
} from "@taprootio/espalier/shared/theme";

import { hasControlCharacter, sanitizeDiagnostic, SiteAuthoringError } from "./errors.js";

export const MAXIMUM_THEME_WARNINGS = 32;
// Large enough for a whole fit lint: apca-target-unmet lists every pair that
// missed its floor before the remedy, and a surface that fails across the
// board runs past 900 scalars. Truncating it would cut the remedy off.
export const MAXIMUM_THEME_WARNING_SCALARS = 2048;
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
  "fontMenu",
  "fontWeightBody",
  "fontWeightHeadings",
  "fontWeightBrand",
  "fontWeightMonospace",
  "fontWeightMenu",
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

/** Collect absent contract keys without treating present invalid values as omissions. */
export function missingThemeFields(theme, scheme) {
  if (!isPlainObject(theme)) return [];
  const fields = REQUIRED_THEME_PROPERTIES
    .filter((property) => !Object.hasOwn(theme, property))
    .map((property) => `${scheme}Theme.${property}`);
  for (const path of REQUIRED_THEME_PATHS) {
    const segments = path.split(".");
    // A missing root property is already listed. A present null, array, or
    // scalar remains a value-validation fault, not a request for a newer key.
    if (!Object.hasOwn(theme, segments[0])) continue;
    let current = theme;
    for (const segment of segments) {
      if (!isPlainObject(current)) break;
      if (!Object.hasOwn(current, segment)) {
        fields.push(`${scheme}Theme.${path}`);
        break;
      }
      current = current[segment];
    }
  }
  return fields;
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
          && Object.keys(anchor).some((key) => key !== "color" && [...key].length > MAXIMUM_THEME_OPEN_MAP_KEY_SCALARS)
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

const SCHEME_DEFAULTS = Object.freeze({ light: DEFAULT_LIGHT_THEME, dark: DEFAULT_DARK_THEME });

function sameMapping(left, right) {
  return isPlainObject(left) && isPlainObject(right)
    && left.source === right.source && left.lightness === right.lightness;
}

/**
 * The tokens a stored theme's `explicitMappingTokens` marker claims, or
 * undefined when the document has no usable marker at all.
 *
 * Espalier accepts a marker all-or-nothing: one entry that is not a semantic
 * token name, one duplicate, or one name with no matching `semanticMappings`
 * entry and it ignores the whole marker, falling back to treating every stored
 * mapping as a pin. Reading a malformed marker leniently here — keeping the
 * entries that happen to parse — would make this CLI describe and project a
 * theme that renders differently from what Espalier actually resolves, which
 * is the one thing the projection must never do.
 */
export function serializedMarkerTokens(theme) {
  const tokens = theme?.explicitMappingTokens;
  if (!Array.isArray(tokens)) return undefined;
  if (tokens.some((token) => typeof token !== "string" || !SEMANTIC_COLOR_NAMES.includes(token))) return undefined;
  const unique = new Set(tokens);
  if (unique.size !== tokens.length) return undefined;
  if (unique.size > 0) {
    if (!isPlainObject(theme.semanticMappings)) return undefined;
    for (const token of unique) {
      if (!Object.hasOwn(theme.semanticMappings, token)) return undefined;
    }
  }
  return unique;
}

/**
 * Which of a stored theme's `semanticMappings` its author actually pinned: the
 * marker's tokens, or — for a document that carries no usable marker — all of
 * them, since a marker-less document predates the contract and every mapping
 * in it is still a pin.
 */
export function authoredMappingTokens(theme) {
  if (!isPlainObject(theme) || !isPlainObject(theme.semanticMappings)) return new Set();
  return serializedMarkerTokens(theme) ?? new Set(Object.keys(theme.semanticMappings));
}

/**
 * A mapping the document carries but never claims is inert. Since Espalier
 * 4.18.0 the serialized marker decides which `semanticMappings` entries are
 * pins: the resolver recompiles every other token from the roles and the
 * stored value is not applied. A cached entry that already matches what the
 * resolver produces is invisible — that is the seeded shape every site has —
 * so only a value the resolver will actually discard is reported. That covers
 * both the pin that merely repeats Espalier's default on a token the roles
 * move (the accepted-but-gray link WTFM saw, TR00801) and a mapping edited by
 * hand without adding its token to the marker, which would otherwise vanish
 * with no sign it was ignored. A document with no marker at all predates the
 * contract and keeps every mapping as a pin, so it has nothing to report. It
 * is a warning rather than a refusal because the theme still renders a valid,
 * coherent result; Espalier validation owns the invalid cases.
 */
export function inertMappingWarnings(theme, scheme) {
  if (!isPlainObject(theme) || !isPlainObject(theme.semanticMappings)) return [];
  // No usable marker means Espalier keeps every mapping as a pin, so nothing
  // the document carries is inert and there is nothing to report.
  const deliberate = serializedMarkerTokens(theme);
  if (deliberate === undefined) return [];
  const defaults = SCHEME_DEFAULTS[scheme];
  let resolved;
  try {
    resolved = mergeTheme(defaults, theme).semanticMappings;
  } catch {
    // An invalid theme is Espalier validation's finding, not this one's.
    return [];
  }
  const warnings = [];
  for (const [token, mapping] of Object.entries(theme.semanticMappings)) {
    if (deliberate.has(token)) continue;
    if (sameMapping(mapping, resolved[token])) continue;
    const applied = isPlainObject(resolved[token])
      ? `${resolved[token].source}/${resolved[token].lightness}`
      : "the compiled value";
    warnings.push(
      `${scheme}: semanticMappings.${token} is not named in explicitMappingTokens, so the resolver recompiles the `
        + `token and this value is never applied — ${token} renders as ${applied}; list ${token} in `
        + `explicitMappingTokens to pin the value, or remove the mapping to author the intent through the roles.`,
    );
  }
  return warnings;
}

let fitReport;

/**
 * Espalier exports its fit report only from the package root, and the root
 * re-exports every component module, which registers custom elements as it
 * loads. This package must never do that: a process that already holds
 * another Espalier copy — the generator's browser harness loads this package
 * beside its own — throws on a second esp-root
 * (generator/src/site-authoring-content-isolation.test.ts). The report itself
 * is side-effect free and sits beside the exported theme module, so it is
 * loaded from there, sharing that module's instance, and only when a theme is
 * actually checked. The exact Espalier pin and this package's tests catch a
 * release that moves it.
 */
function loadFitReport() {
  fitReport ??= import(new URL("./theme-fit-report.js", import.meta.resolve("@taprootio/espalier/shared/theme")).href);
  return fitReport;
}

/**
 * Validation says whether Espalier accepts a theme; the fit report says how
 * the accepted theme renders. Its lints are the findings no validator can
 * make, because each is about the compiled result: a filled action that came
 * out the opposite way round from its swatches (action-anchor-inversion), a
 * text pair enforcement could not rescue (apca-target-unmet), an action lost
 * in its canvas, or a hover weaker than its resting link. Every surface is
 * checked — the root and each context, in both schemes — because a context
 * declares its own action and fails on its own; a root-only check misses it.
 * The suite's data-palette lints are left out: validateThemePair already warns
 * about the same collisions, in the same words.
 *
 * The pair passed in is the encoded one that is stored, parsed back, so the
 * report describes exactly what the published page resolves. Lints are
 * warnings rather than refusals, matching how Espalier classifies them.
 */
export async function fitLintWarnings(light, dark) {
  const { ROOT_SURFACE, themeFitReportSuite } = await loadFitReport();
  let suite;
  try {
    suite = themeFitReportSuite(parseTheme(light) ?? {}, parseTheme(dark) ?? {});
  } catch (error) {
    // A pair that passed validation resolves, so this should not happen; if
    // it does, say the lints were not checked rather than implying none fired.
    return [`Espalier could not build the fit report, so no fit lints were checked: ${error?.message ?? error}`];
  }
  const warnings = [];
  for (const scheme of ["light", "dark"]) {
    for (const report of suite[scheme]) {
      const surface = report.surface === ROOT_SURFACE ? "" : `contexts.${report.surface} `;
      for (const lint of report.lints) {
        warnings.push(`${scheme}: ${surface}fit lint ${lint.id} — ${lint.message}`);
      }
    }
  }
  return warnings;
}

function boundedThemeWarnings(allWarnings) {
  const warnings = allWarnings
    .slice(0, MAXIMUM_THEME_WARNINGS)
    .map((warning) =>
      [...sanitizeDiagnostic(warning, "Theme validation warning.")]
        .slice(0, MAXIMUM_THEME_WARNING_SCALARS)
        .join("")
    );
  return {
    warnings,
    warningCount: allWarnings.length,
    warningsTruncated: allWarnings.length > warnings.length,
  };
}

export function validateAndEncodeThemePair(lightTheme, darkTheme) {
  const { light, dark, warnings, inert } = checkThemePair(lightTheme, darkTheme);
  return { light, dark, ...boundedThemeWarnings([...warnings, ...inert]) };
}

/**
 * The validation `validate` and `theme push` run: everything
 * validateAndEncodeThemePair checks, plus the fit lints over the accepted
 * pair, bounded together so the cap and the count cover both. The lints come
 * before the inert-mapping warnings because the seeded shape alone produces
 * one of those per cached token and scheme — enough to fill the cap — and a
 * lint is the finding an author can least afford to have cut off.
 */
export async function validateAndLintThemePair(lightTheme, darkTheme) {
  const { light, dark, warnings, inert } = checkThemePair(lightTheme, darkTheme);
  const lints = await fitLintWarnings(light, dark);
  return { light, dark, ...boundedThemeWarnings([...warnings, ...lints, ...inert]) };
}

function checkThemePair(lightTheme, darkTheme) {
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
  return {
    light,
    dark,
    warnings: result.warnings,
    inert: [...inertMappingWarnings(lightTheme, "light"), ...inertMappingWarnings(darkTheme, "dark")],
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
