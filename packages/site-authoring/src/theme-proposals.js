import { bestAvailableWeight } from "@taprootio/espalier/shared/font-helpers";
import { compileFontPlan } from "@taprootio/espalier/shared/font-plan";
import {
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  encodeTheme,
  mergeTheme,
  parseTheme,
  validateThemePair,
} from "@taprootio/espalier/shared/theme";
import { computeThemeProperties } from "@taprootio/espalier/shared/theme-properties";

import { loadEspalierShared } from "./espalier-shared.js";
import { SiteAuthoringError } from "./errors.js";

/**
 * Passing values for theme warnings, and the font weights a publish can load
 * (TR01189).
 *
 * A contrast or status-color warning names its cause and its place; this adds
 * the nearest value the CLI finds that passes. Each candidate is applied to a
 * copy of the theme and the same check runs again, so only a value that clears
 * the warning without raising any other is named. Proposals are extras: one
 * that cannot be computed leaves the warning as Espalier wrote it.
 *
 * The status-collision pattern and the "No ink reaches the floor" test read
 * Espalier's message text, which the exact Espalier pin holds still; a message
 * that stops matching just gets no proposal.
 */

const DEFAULTS = Object.freeze({ light: DEFAULT_LIGHT_THEME, dark: DEFAULT_DARK_THEME });

/** Re-checks one run may spend on proposals, lints first; beyond it, warnings keep their words. */
const MAXIMUM_EVALUATIONS = 60;
const MAXIMUM_CANDIDATES = 24;
const LIGHTNESS_STEP = 0.02;

function encodePair(light, dark) {
  return [encodeTheme(light), encodeTheme(dark)];
}

function withScheme(themes, scheme, theme) {
  return scheme === "light" ? [theme, themes.dark] : [themes.light, theme];
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

/** Every (scheme, surface, lint, token) a fit report suite names. */
function lintTokenKeys(suite, root) {
  const keys = new Set();
  for (const scheme of ["light", "dark"]) {
    for (const report of suite[scheme] ?? []) {
      for (const lint of report.lints) {
        for (const token of lint.tokens) keys.add(`${scheme}|${report.surface ?? root}|${lint.id}|${token}`);
      }
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Status colors
// ---------------------------------------------------------------------------

const STATUS_COLLISION =
  /^(light|dark): (?:contexts\.[^:]+: )?Status colors "([a-z]+)" and "([a-z]+)" .*retune (?:one of them|both|"([a-z]+)") via intents/u;
const HUE_SHIFTS = [8, -8, 16, -16, 24, -24, 36, -36, 48, -48, 64, -64];
const LIGHTNESS_SHIFTS = [0.04, -0.04, 0.08, -0.08, 0.12, -0.12];

/**
 * An `intents` color for one of the two families a collision names, nearest
 * first by ΔE-OK from the family's current color: hue moves before lightness,
 * since the audit re-renders status colors at the action's lightness. Values
 * already proposed for other families in this scheme are applied with it, so
 * taking every proposal together cannot recreate a collision.
 */
function proposeStatusIntent(warning, themes, baseline, accepted, engine, budget) {
  const match = STATUS_COLLISION.exec(warning);
  if (match === null) return undefined;
  const [, scheme, first, second, named] = match;
  const theme = { ...themes[scheme], intents: { ...themes[scheme].intents, ...accepted[scheme] } };
  const statusBefore = new Set(baseline.filter((entry) => entry.includes("Status colors")));
  // The values already proposed may clear this collision on their own; a
  // family that has a proposal gets no second one.
  if (Object.keys(accepted[scheme]).length > 0) {
    if (budget.remaining <= 0) return undefined;
    budget.remaining -= 1;
    const result = validateThemePair(...encodePair(...withScheme(themes, scheme, theme)));
    if (result.valid && !result.warnings.includes(warning)) return "Cleared by the intents proposed above.";
  }
  const merged = mergeTheme(DEFAULTS[scheme], theme);
  const properties = computeThemeProperties(merged, scheme);
  const candidates = [];
  const families = (named === undefined ? [second, first] : [named]).filter((family) => !(family in accepted[scheme]));
  for (const family of families) {
    const current = merged.intents?.[family] ?? properties[`--esp-color-${family}`];
    const base = typeof current === "string" ? engine.parseCssColor(current) : null;
    if (base === null || base === undefined) continue;
    const shifts = [
      ...HUE_SHIFTS.map((hue) => [0, hue]),
      ...LIGHTNESS_SHIFTS.flatMap((lightness) => [0, ...HUE_SHIFTS].map((hue) => [lightness, hue])),
    ];
    for (const [lightnessShift, hueShift] of shifts) {
      const color = engine.gamutMapToSRGB({
        l: Math.min(0.95, Math.max(0.05, base.l + lightnessShift)),
        c: base.c,
        h: (base.h + hueShift + 360) % 360,
      });
      candidates.push({ family, color, hueOnly: lightnessShift === 0, distance: engine.deltaEOK(base, color) });
    }
  }
  candidates.sort((left, right) => Number(right.hueOnly) - Number(left.hueOnly) || left.distance - right.distance);
  for (const { family, color } of candidates.slice(0, MAXIMUM_CANDIDATES)) {
    if (budget.remaining <= 0) return undefined;
    budget.remaining -= 1;
    const value = engine.serializeOklch(color);
    const patched = { ...theme, intents: { ...theme.intents, [family]: value } };
    const result = validateThemePair(...encodePair(...withScheme(themes, scheme, patched)));
    if (!result.valid || result.warnings.includes(warning)) continue;
    if (result.warnings.some((entry) => entry.includes("Status colors") && !statusBefore.has(entry))) continue;
    // Nor may it collide with a family already given a proposal, even where
    // that collision was there before.
    const proposedFamilies = Object.keys(accepted[scheme]);
    if (
      result.warnings.some((entry) =>
        entry.startsWith(`${scheme}: `) && entry.includes("Status colors") && entry.includes(`"${family}"`)
        && proposedFamilies.some((other) => entry.includes(`"${other}"`))
      )
    ) continue;
    const together = Object.keys(accepted[scheme]).length > 0 ? ", with the intents proposed above" : "";
    accepted[scheme][family] = value;
    return `Nearest passing value: ${scheme}Theme.intents.${family} = "${value}"${together}.`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Fit lints
// ---------------------------------------------------------------------------

/**
 * The token a lint's fix retunes: the one the lint names first, which is its
 * own recommendation, except that when no ink can reach the floor the ground
 * is retuned instead.
 */
function lintTarget(lint, report) {
  if (!["action-canvas-separation", "link-hover-ordering", "apca-target-unmet"].includes(lint.id)) return undefined;
  if (lint.id === "apca-target-unmet" && /No ink reaches the floor/u.test(lint.message)) {
    return report.tokens.find((entry) => entry.token === lint.tokens[0])?.apca?.against;
  }
  return lint.tokens[0];
}

function toneName(token) {
  return `${token.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}-pass`;
}

/**
 * The theme with `token` pinned to `lightness` through a tone, on the lint's
 * surface. A root without a marker already treats every mapping as a pin, so
 * none is added; one is extended, never replaced.
 */
function pinnedTheme(theme, surface, root, token, source, tone, lightness) {
  const mapping = { source, lightness: `tone:${tone}` };
  if (surface === root) {
    return {
      ...theme,
      tones: { ...theme.tones, [tone]: lightness },
      semanticMappings: { ...theme.semanticMappings, [token]: mapping },
      ...(Array.isArray(theme.explicitMappingTokens)
        ? { explicitMappingTokens: [...new Set([...theme.explicitMappingTokens, token])] }
        : {}),
    };
  }
  const context = theme.contexts?.[surface] ?? {};
  return {
    ...theme,
    contexts: {
      ...theme.contexts,
      [surface]: {
        ...context,
        tones: { ...context.tones, [tone]: lightness },
        semanticMappings: { ...context.semanticMappings, [token]: mapping },
      },
    },
  };
}

function surfaceOf(report, root) {
  return report.surface ?? root;
}

function cleared(item, target, after, root) {
  const { scheme, report, lint } = item;
  const watched = target === lint.tokens[0] ? [target] : lint.tokens;
  return !watched.some((token) => after.has(`${scheme}|${surfaceOf(report, root)}|${lint.id}|${token}`));
}

/**
 * The nearest lightness, in steps from the target token's resolved one, at
 * which the lint clears and no lint names a token anywhere in the suite that
 * it did not name before. Returns the text and every lint token the verified
 * theme cleared, so a context lint the same fix clears is not proposed again.
 */
function proposeLintFix(item, themes, fit, engine, budget, before) {
  const { scheme, report, lint } = item;
  const target = lintTarget(lint, report);
  const entry = target === undefined ? undefined : report.tokens.find((token) => token.token === target);
  const base = entry === undefined ? null : engine.parseCssColor(entry.resolved);
  if (base === null || base === undefined || typeof entry.source !== "string") return undefined;
  const root = fit.ROOT_SURFACE;
  const tone = toneName(target);
  const lightnesses = [];
  for (let step = 1; lightnesses.length < MAXIMUM_CANDIDATES && step <= 1 / LIGHTNESS_STEP; step += 1) {
    for (const lightness of [base.l + step * LIGHTNESS_STEP, base.l - step * LIGHTNESS_STEP]) {
      if (lightness > 0.02 && lightness < 0.98) lightnesses.push(round(lightness));
    }
  }
  for (const lightness of lightnesses) {
    if (budget.remaining <= 0) return undefined;
    budget.remaining -= 1;
    const patched = pinnedTheme(themes[scheme], report.surface, root, target, entry.source, tone, lightness);
    const encoded = encodePair(...withScheme(themes, scheme, patched));
    let after;
    try {
      after = lintTokenKeys(fit.themeFitReportSuite(parseTheme(encoded[0]) ?? {}, parseTheme(encoded[1]) ?? {}), root);
    } catch {
      continue;
    }
    if (!cleared(item, target, after, root) || [...after].some((key) => !before.has(key))) continue;
    // Validation costs several fit reports, so only a candidate that clears pays for it.
    if (!validateThemePair(...encoded).valid) continue;
    const place = report.surface === root ? `${scheme}Theme` : `${scheme}Theme.contexts.${report.surface}`;
    const marker = report.surface !== root
      ? " (a context's pin needs no explicitMappingTokens)"
      : Array.isArray(themes[scheme].explicitMappingTokens)
      ? ` and list ${target} in explicitMappingTokens`
      : " (this theme has no explicitMappingTokens, so every mapping in it is a pin; do not add one)";
    return {
      text: `Nearest passing value: ${target} at lightness ${lightness} — in ${place} set tones["${tone}"] to `
        + `${lightness} and semanticMappings.${target} to {"source":"${entry.source}","lightness":"tone:${tone}"}${marker}.`,
      clearedKeys: new Set([...before].filter((key) => !after.has(key))),
    };
  }
  return undefined;
}

function lintKeys(item, root) {
  return item.lint.tokens.map((token) => `${item.scheme}|${surfaceOf(item.report, root)}|${item.lint.id}|${token}`);
}

/**
 * Each theme warning with the nearest passing value appended where one is
 * found: the fit lints first, then Espalier's status-color collisions. Root
 * lints come before context lints, and a context lint the root's proposal
 * already clears is not proposed again.
 */
export async function proposePassingValues({ lightTheme, darkTheme, warnings, lints, fit }) {
  const themes = { light: lightTheme, dark: darkTheme };
  const engine = await loadEspalierShared("color-engine.js");
  const budget = { remaining: MAXIMUM_EVALUATIONS };
  const root = fit.ROOT_SURFACE;
  const before = new Set(lints.flatMap((item) => lintKeys(item, root)));
  const proposals = new Map();
  const clearedByProposals = new Set();
  const order = [...lints].sort((left, right) => Number(left.report.surface !== root) - Number(right.report.surface !== root));
  for (const item of order) {
    if (lintKeys(item, root).every((key) => clearedByProposals.has(key))) continue;
    let proposal;
    try {
      proposal = proposeLintFix(item, themes, fit, engine, budget, before);
    } catch {
      proposal = undefined;
    }
    if (proposal === undefined) continue;
    proposals.set(item, proposal.text);
    for (const key of proposal.clearedKeys) clearedByProposals.add(key);
  }
  const accepted = { light: {}, dark: {} };
  const proposedWarnings = warnings.map((warning) => {
    let proposal;
    try {
      proposal = proposeStatusIntent(warning, themes, warnings, accepted, engine, budget);
    } catch {
      proposal = undefined;
    }
    return proposal === undefined ? warning : `${warning} ${proposal}`;
  });
  return {
    warnings: proposedWarnings,
    lints: lints.map((item) => (proposals.has(item) ? `${item.text} ${proposals.get(item)}` : item.text)),
  };
}

// ---------------------------------------------------------------------------
// Font weights
// ---------------------------------------------------------------------------

const FONT_SLOTS = Object.freeze({
  body: { family: "fontBody", weight: "fontWeightBody", defaultWeight: 400 },
  headings: { family: "fontHeadings", weight: "fontWeightHeadings", defaultWeight: 700 },
  brand: { family: "fontBrand", weight: "fontWeightBrand", defaultWeight: 700 },
  menu: { family: "fontMenu", weight: "fontWeightMenu", defaultWeight: 700 },
  monospace: { family: "fontMonospace", weight: "fontWeightMonospace", defaultWeight: 400 },
});

// About half a megabyte, so it is read only when a theme is checked.
let fontCatalog;
async function loadFontCatalog() {
  fontCatalog ??= (await import("@taprootio/espalier/css/fonts/font-fallback-profiles.json", { with: { type: "json" } }))
    .default;
  return fontCatalog;
}

function uprightWeights(catalog, family) {
  return Object.keys(catalog.profiles?.[family] ?? {})
    .filter((weight) => /^\d+$/u.test(weight))
    .sort((left, right) => Number(left) - Number(right));
}

/** The font field whose stack Espalier cannot embed, found one field at a time. */
function invalidFontStack(themes, catalog) {
  for (const scheme of ["light", "dark"]) {
    for (const { family } of Object.values(FONT_SLOTS)) {
      const value = themes[scheme][family];
      if (typeof value !== "string" || value === "") continue;
      try {
        compileFontPlan({ lightTheme: { ...DEFAULT_LIGHT_THEME, fontBody: value }, darkTheme: DEFAULT_DARK_THEME, catalog });
      } catch (error) {
        return { field: `${scheme}Theme.${family}`, reason: error?.message ?? String(error) };
      }
    }
  }
  return undefined;
}

/**
 * The refusal a publish would hit, checked the way the generator checks it:
 * both themes merged over the defaults, compiled into a font plan against the
 * same catalog. A font field whose catalog family has no face at that field's
 * weight fails the plan; each such field is named with the nearest weight the
 * family has. A font stack Espalier cannot embed is refused by name too.
 */
export async function refuseUnavailableFontWeights(encodedLight, encodedDark) {
  const catalog = await loadFontCatalog();
  const themes = {
    light: mergeTheme(DEFAULT_LIGHT_THEME, parseTheme(encodedLight) ?? {}),
    dark: mergeTheme(DEFAULT_DARK_THEME, parseTheme(encodedDark) ?? {}),
  };
  let plan;
  try {
    plan = compileFontPlan({ lightTheme: themes.light, darkTheme: themes.dark, catalog });
  } catch (error) {
    const invalid = invalidFontStack(themes, catalog);
    throw new SiteAuthoringError(
      "theme.font_stack_invalid",
      `${invalid?.field ?? "A font field"} is not a font stack a published page can carry: `
        + `${invalid?.reason ?? error?.message ?? String(error)}`,
      { field: invalid?.field, cause: error },
    );
  }
  if (plan.missingProfiles.length === 0) return;
  // Espalier groups a missing face's schemes and slots independently, so each
  // scheme is compiled on its own (beside the other's defaults, which request
  // no catalog face) to know exactly which fields fail.
  const misses = ["light", "dark"].flatMap((scheme) => {
    const single = compileFontPlan({
      lightTheme: scheme === "light" ? themes.light : DEFAULT_LIGHT_THEME,
      darkTheme: scheme === "dark" ? themes.dark : DEFAULT_DARK_THEME,
      catalog,
    });
    return single.missingProfiles.flatMap((miss) =>
      miss.slots.map((slot) => ({ ...miss, scheme, slot: FONT_SLOTS[slot] }))
    );
  }).filter((miss) => miss.slot !== undefined);
  const lines = misses.map((miss) => {
    const field = `${miss.scheme}Theme.${miss.slot.weight}`;
    const available = uprightWeights(catalog, miss.family);
    const requested = miss.weight === null ? "that weight" : `weight ${miss.weight}`;
    return available.length === 0
      ? `${field}: "${miss.family}" has no upright face at all; choose another family (see 'help fonts').`
      : `${field}: "${miss.family}" has no face at ${requested}. Nearest passing value: ${miss.slot.weight} = `
        + `${bestAvailableWeight(String(miss.weight ?? miss.slot.defaultWeight), available)} (it offers `
        + `${available.join(", ")}; see 'help fonts').`;
  });
  throw new SiteAuthoringError(
    "theme.font_weight_unavailable",
    `Publishing would fail on a font weight the family does not have. ${lines.join(" ")}`,
    { field: misses[0] === undefined ? undefined : `${misses[0].scheme}Theme.${misses[0].slot.weight}` },
  );
}
