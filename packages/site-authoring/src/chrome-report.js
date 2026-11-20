import { parseTheme } from "@taprootio/espalier/shared/theme";

import { APPEARANCE_FILES } from "./appearance-contract.js";
import { standaloneFooterActionEntries } from "./chrome-features.js";
import { buildChromeInput } from "./chrome-input.js";
import { CHROME_UNAVAILABLE_MESSAGE, displayChromeRatio } from "./chrome-output.js";
import taprootCatalog from "./chrome-paint-catalog-taproot.json" with { type: "json" };
import { loadEspalierShared } from "./espalier-shared.js";
import { SETTINGS_TYPE_SITE_HEADER, SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES } from "./settings-catalog.js";
import { CONTRAST_TEXT_BELOW_AA, THEME_STYLES_FILE } from "./theme-resolve.js";
import { loadFitReport } from "./theme-validation.js";

export { CHROME_UNAVAILABLE_MESSAGE } from "./chrome-output.js";

const SCHEMES = ["light", "dark"];

function fieldFor(role, context, scheme, pair, brandColorSourceFields) {
  const brandColorField = pair.foreground === "brand-color" ? brandColorSourceFields[scheme] : undefined;
  if (brandColorField !== undefined) {
    return { field: `site-header.${brandColorField}`, file: APPEARANCE_FILES[SETTINGS_TYPE_SITE_HEADER] };
  }
  if (context === null) return { field: `${scheme}Theme`, file: THEME_STYLES_FILE };
  return role === "header"
    ? { field: "site-header.context", file: APPEARANCE_FILES[SETTINGS_TYPE_SITE_HEADER] }
    : { field: "site-publishing-preferences.footerSettings.context", file: APPEARANCE_FILES[SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES] };
}

async function extraPaintEntries(nameReportEnabled) {
  if (nameReportEnabled !== true) return taprootCatalog;
  const { PAINT_CATALOG } = await loadEspalierShared("paint-catalog.js");
  return { ...taprootCatalog, footer: [...taprootCatalog.footer, ...standaloneFooterActionEntries(PAINT_CATALOG.footer)] };
}

/** Measure optional chrome without changing the command that accepted the appearance. */
export async function completeChromeReport(inputs, { loadFit = loadFitReport } = {}) {
  let navigationUnavailable = true;
  try {
    const { themes, appearance, resources, nameReportEnabled } = inputs;
    const input = buildChromeInput({ appearance, resources, nameReportEnabled });
    ({ navigationUnavailable } = input);
    const light = parseTheme(themes.light);
    const dark = parseTheme(themes.dark);
    if (!light || !dark) throw new Error("Missing accepted theme pair.");
    const fit = await loadFit();
    const extraEntries = await extraPaintEntries(nameReportEnabled);
    const { paint: entries } = fit.themeFitReportSuite(light, dark, { paintSurfaces: input.paintSurfaces, extraEntries });
    const flags = [];
    const warnings = [];
    let pairs = 0;
    for (const scheme of SCHEMES) {
      for (const { role, context, pairs: measured } of entries[scheme]) {
        pairs += measured.length;
        for (const pair of measured) {
          if (pair.ratio >= pair.required) continue;
          const { element, foreground, background, state, kind, required } = pair;
          const { field, file } = fieldFor(role, context, scheme, pair, input.brandColorSourceFields);
          const ratio = displayChromeRatio(pair.ratio, required);
          const shownRatio = ratio.toFixed(2);
          const shownRequirement = required.toFixed(2);
          flags.push({
            code: CONTRAST_TEXT_BELOW_AA,
            area: "presentation",
            file,
            field,
            token: foreground,
            background,
            scheme,
            context,
            ratio,
            required,
            message: `${role} ${element}/${state} paints ${foreground} on ${background} at ${shownRatio}:1. It needs ${shownRequirement}:1.`,
            role,
            element,
            state,
            kind,
          });
          warnings.push(
            `chrome: ${CONTRAST_TEXT_BELOW_AA}; ${field}; ${scheme} ${role} ${element}/${state}; ${shownRatio}:1 < ${shownRequirement}:1.`,
          );
        }
      }
    }
    return { entries, flags, warnings, contrast: { pairs, belowAa: flags.length }, navigationUnavailable, unavailable: false };
  } catch {
    return {
      entries: { light: [], dark: [] },
      flags: [],
      warnings: [CHROME_UNAVAILABLE_MESSAGE],
      contrast: { pairs: 0, belowAa: 0 },
      navigationUnavailable,
      unavailable: true,
    };
  }
}
