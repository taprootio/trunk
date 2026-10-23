import { parseTheme, SEMANTIC_COLOR_NAMES, TOKEN_PAIRINGS } from "@taprootio/espalier/shared/theme";

import { SiteAuthoringError } from "./errors.js";
import { loadEspalierShared } from "./espalier-shared.js";
import { validateAndEncodeThemePair } from "./theme-validation.js";

/**
 * `theme resolve` (TR01228): the colors Espalier compiles from a stored theme,
 * with the contrast of every ink-on-surface pairing it defines.
 *
 * Nothing here compiles a color. The fit report suite is the same compile
 * `theme push` lints and the page renders through (`computeThemeProperties`,
 * and `resolveContextTheme` for each context), so a resolved value cannot
 * disagree with the render. This module only reads that result and measures
 * it.
 */

export const THEME_STYLES_FILE = "settings/taproot-styles.json";

// WCAG 2.x AA. Espalier sizes its pairings by APCA target: Lc 90 and 75 are
// body and 16px+ text, Lc 60 is the 24px+ and UI tier, which is what AA calls
// large text and non-text contrast.
export const AA_TEXT_RATIO = 4.5;
export const AA_LARGE_RATIO = 3;
const LARGE_TEXT_LC = 60;

export const CONTRAST_TEXT_BELOW_AA = "theme.contrast_text_below_aa";

const THEME_SCHEMES = Object.freeze(["light", "dark"]);

let engines;

/** The fit report and color engine are Espalier modules beside the exported theme module (see espalier-shared.js). */
function loadEngines() {
  engines ??= Promise.all([
    loadEspalierShared("theme-fit-report.js"),
    loadEspalierShared("color-engine.js"),
  ]).then(([fit, color]) => ({ fit, color }));
  return engines;
}

function channelByte(color, value) {
  return Math.round(color.clampChannel(value) * 255);
}

/** The sRGB the engine gamut-maps a compiled color to, as channels in 0..1 and as #rrggbb. */
function toSrgb(color, value) {
  const parsed = color.parseCssColor(value);
  if (parsed === null) return undefined;
  const srgb = color.oklchToSRGB(color.gamutMapToSRGB(parsed));
  const hex = `#${[srgb.r, srgb.g, srgb.b].map((channel) => channelByte(color, channel).toString(16).padStart(2, "0")).join("")}`;
  return { parsed, srgb, hex };
}

function relativeLuminance(color, srgb) {
  const linear = (channel) => color.gammaToLinear(color.clampChannel(channel));
  return 0.2126 * linear(srgb.r) + 0.7152 * linear(srgb.g) + 0.0722 * linear(srgb.b);
}

/** WCAG contrast ratio of two compiled colors, unrounded. */
function wcagRatio(color, first, second) {
  const [lighter, darker] = [relativeLuminance(color, first.srgb), relativeLuminance(color, second.srgb)]
    .sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

// Shown ratios round down, so a pair 0.004 short of AA never displays as 4.50.
function floorTo(value, places) {
  const scale = 10 ** places;
  return Math.floor(value * scale + 1e-9) / scale;
}

function origin(token) {
  if (token.explicit === "declared") return "pinned";
  if (token.explicit === "inherited") return "inherited_pin";
  return "compiled";
}

function surfaceField(scheme, context) {
  return context === null ? `${scheme}Theme` : `${scheme}Theme.contexts.${context}`;
}

/**
 * The finding for one pair under AA: a stable code, and the theme field whose zone the author edits.
 *
 * There is one code. Espalier's enforcer walks an ink to the extreme that contrasts with its surface, so a
 * large-text or UI pair never lands under 3:1 in a real theme and a second code could not be reached. `required`
 * still says which minimum the pair missed.
 */
function contrastFlag(pair, scheme, context) {
  return {
    code: CONTRAST_TEXT_BELOW_AA,
    area: "presentation",
    file: THEME_STYLES_FILE,
    field: surfaceField(scheme, context),
    token: pair.token,
    background: pair.background,
    scheme,
    context,
    ratio: pair.ratio,
    required: pair.required,
    message: `${pair.token} on ${pair.background} is ${pair.ratio}:1; needs ${pair.required}:1.`,
  };
}

function describeSurface(color, report, scheme, rootSurface) {
  const context = report.surface === rootSurface ? null : report.surface;
  const resolved = new Map();
  const tokens = report.tokens.map((token) => {
    const measured = toSrgb(color, token.resolved);
    resolved.set(token.token, measured);
    return {
      token: token.token,
      value: token.resolved,
      hex: measured?.hex ?? null,
      origin: origin(token),
      source: token.source,
      lightness: token.lightness,
      // Only when APCA enforcement moved it off the requested value; absent is the usual case.
      ...(token.adjusted ? { adjusted: true } : {}),
    };
  });
  const pairs = [];
  for (const [ink, pairing] of Object.entries(TOKEN_PAIRINGS)) {
    const foreground = resolved.get(ink);
    const background = resolved.get(pairing.bg);
    if (foreground === undefined || background === undefined) continue;
    const required = pairing.targetLc <= LARGE_TEXT_LC ? AA_LARGE_RATIO : AA_TEXT_RATIO;
    const ratio = wcagRatio(color, foreground, background);
    const lc = Math.abs(color.apcaContrast(foreground.parsed, background.parsed));
    pairs.push({
      token: ink,
      background: pairing.bg,
      ratio: floorTo(ratio, 2),
      required,
      aa: ratio >= required,
      apcaLc: floorTo(lc, 1),
      apcaTarget: pairing.targetLc,
      apcaMet: lc >= pairing.targetLc,
    });
  }
  const flags = pairs.filter((pair) => !pair.aa).map((pair) => contrastFlag(pair, scheme, context));
  return {
    surface: { context, tokens, pairs, pinned: tokens.filter((token) => token.origin !== "compiled").map((token) => token.token) },
    flags,
  };
}

/**
 * The compiled colors of a stored light/dark pair. `scheme` and `context`
 * narrow what is described, never what is validated or compiled: the pair is
 * checked as a whole, as `theme push` checks it.
 *
 * Throws what `theme push` would throw for an incomplete or invalid theme, and
 * a `theme.context_unknown` refusal for a context the theme does not declare.
 */
export async function resolveThemePair(lightTheme, darkTheme, { scheme, context } = {}) {
  const { light, dark } = validateAndEncodeThemePair(lightTheme, darkTheme);
  const { fit, color } = await loadEngines();
  // The stored pair is encoded and parsed back, as theme push's fit lints do, so this is what the page resolves.
  const suite = fit.themeFitReportSuite(parseTheme(light) ?? {}, parseTheme(dark) ?? {});
  const contexts = suite.surfaces.filter((surface) => surface !== fit.ROOT_SURFACE);
  if (context !== undefined && !contexts.includes(context)) {
    throw new SiteAuthoringError(
      "theme.context_unknown",
      contexts.length === 0
        ? `The theme declares no context named '${context}'; it declares none.`
        : `The theme declares no context named '${context}'. Declared: ${contexts.join(", ")}.`,
      { field: "context", alternatives: contexts },
    );
  }

  const schemes = [];
  const flags = [];
  for (const name of THEME_SCHEMES) {
    if (scheme !== undefined && scheme !== name) continue;
    const surfaces = [];
    for (const report of suite[name]) {
      if (context !== undefined && report.surface !== context) continue;
      const described = describeSurface(color, report, name, fit.ROOT_SURFACE);
      surfaces.push(described.surface);
      flags.push(...described.flags);
    }
    schemes.push({ scheme: name, surfaces });
  }
  const pairs = schemes.flatMap((entry) => entry.surfaces).flatMap((surface) => surface.pairs);
  return {
    contexts,
    schemes,
    flags,
    contrast: {
      pairs: pairs.length,
      belowAa: pairs.filter((pair) => !pair.aa).length,
      belowApca: pairs.filter((pair) => !pair.apcaMet).length,
    },
  };
}

const TOKEN_ORDER = new Map(SEMANTIC_COLOR_NAMES.map((name, index) => [name, index]));

function pad(value, width) {
  return String(value).padEnd(width);
}

function table(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => String(row[column]).length)));
  return rows.map((row) => `  ${row.map((cell, column) => pad(cell, widths[column])).join("  ").trimEnd()}`).join("\n");
}

/**
 * The human table for a result. Tokens keep Espalier's own order, so a
 * background and its layers read together; a pinned or inherited value is
 * marked, and a pair under AA says so on its line.
 */
export function formatThemeResolve(result) {
  const lines = [`Compiled colors from the ${result.source === "site" ? "site's" : "workspace"} theme.`];
  for (const { scheme, surfaces } of result.schemes) {
    for (const surface of surfaces) {
      lines.push("", `${scheme} · ${surface.context === null ? "page (root)" : `context ${surface.context}`}`);
      const tokens = [...surface.tokens].sort((left, right) => TOKEN_ORDER.get(left.token) - TOKEN_ORDER.get(right.token));
      lines.push(table([
        ["token", "value", "hex", "from"],
        ...tokens.map((token) => [
          token.token,
          token.value,
          token.hex ?? "-",
          `${token.origin === "compiled" ? "" : `${token.origin.replace("_", " ")}: `}${token.source} @ ${token.lightness}${token.adjusted ? " (adjusted for contrast)" : ""}`,
        ]),
      ]));
      lines.push("", table([
        ["ink", "on", "ratio", "needs", "apca", ""],
        ...surface.pairs.map((pair) => [
          pair.token,
          pair.background,
          `${pair.ratio}:1`,
          `${pair.required}:1`,
          `Lc ${pair.apcaLc}/${pair.apcaTarget}`,
          pair.aa ? "ok" : "BELOW AA",
        ]),
      ]));
    }
  }
  const { belowAa, pairs } = result.contrast;
  lines.push("", belowAa === 0
    ? `All ${pairs} pairs meet WCAG AA.`
    : `${belowAa} of ${pairs} pairs are below WCAG AA (flags: ${[...new Set(result.flags.items.map((flag) => flag.code))].join(", ")}).`);
  if (result.omittedSurfaces !== undefined) {
    const names = result.omittedSurfaces.items.map((entry) => `${entry.scheme}/${entry.context ?? "root"}`);
    lines.push(`Not shown (result size): ${names.join(", ")}${result.omittedSurfaces.truncated ? ", and more" : ""}. Narrow with --scheme and --context.`);
  }
  return `${lines.join("\n")}\n`;
}
