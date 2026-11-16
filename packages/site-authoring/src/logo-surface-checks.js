import { resolveFooterLogoPairs } from "./footer-branding.js";
import { canUseCompactHeaderLogo, LOGO_VARIANTS, resolveHeaderLogoPairs, resolveLogoVariant } from "./header-presentation.js";
import { logoArtworkScheme, logoInputsFromSettings } from "./logo-inputs.js";
import { boundedByBytes } from "./session.js";
import { describeSiteFinding, SITE_FINDINGS_MAX_BYTES } from "./site-check-findings.js";
import { loadThemeEngines } from "./theme-resolve.js";

export const LOGO_ON_SURFACE_RULE = "brand.logo_on_surface";
const FILES = Object.freeze({ header: "settings/site-header.json", footer: "settings/site-publishing-preferences.json" });

function result(items, skipped = false) {
  const reported = boundedByBytes(items, SITE_FINDINGS_MAX_BYTES);
  return {
    findings: { total: items.length, errors: 0, warnings: items.length, items: reported.items, ...(reported.truncated ? { truncated: true } : {}) },
    siteChecks: { ranOffline: [LOGO_ON_SURFACE_RULE], ...(skipped ? { skipped: [LOGO_ON_SURFACE_RULE] } : {}) },
  };
}

/** A brightness heuristic over the selected artifacts, not pixel analysis or background-image analysis. */
export async function evaluateLogoSurfaceChecks({ styles, header = {}, footer = {}, profileLogoFallbackUrl, onProgress = () => {} } = {}, { loadEngines = loadThemeEngines } = {}) {
  if (!styles?.lightTheme || !styles?.darkTheme) return result([], true);
  // Ordinary workspaces have no site-kind metadata. Only an explicit caller can supply the profile fallback.
  const input = { ...logoInputsFromSettings(styles, footer), profileLogoFallbackUrl };
  const regular = resolveHeaderLogoPairs(input);
  const compact = canUseCompactHeaderLogo(header.headerPosition, header.headerHeightMultiplier, Boolean(regular.light.url || regular.dark.url), header.headerMinHeightMultiplier);
  const headerInput = compact ? input : { ...input, lightCompactLogoUrl: "", darkCompactLogoUrl: "" };
  const surfaces = [
    { name: "header", context: header.context ?? "", variant: resolveLogoVariant(header.logoVariant), kinds: compact ? ["regular", "compact"] : ["regular"], resolve: logoVariant => resolveHeaderLogoPairs({ ...headerInput, logoVariant }) },
    ...(footer.enabled === true && footer.showBrand !== false ? [{ name: "footer", context: footer.context ?? "", variant: resolveLogoVariant(footer.logoVariant), kinds: ["regular"], resolve: logoVariant => resolveFooterLogoPairs({ ...input, logoVariant }) }] : []),
  ];
  const checks = [];
  for (const surface of surfaces) {
    const alternatives = new Map(LOGO_VARIANTS.map(variant => [variant, surface.resolve(variant)]));
    for (const scheme of ["light", "dark"]) {
      for (const kind of surface.kinds) {
        const key = kind === "compact" ? `${scheme}Compact` : scheme;
        const selected = alternatives.get(surface.variant)[key].url;
        if (!selected || new Set(LOGO_VARIANTS.map(variant => alternatives.get(variant)[key].url)).size <= 1) continue;
        const artwork = logoArtworkScheme(selected, input);
        if (artwork !== undefined) checks.push({ surface, scheme, kind, artwork });
      }
    }
  }
  if (checks.length === 0) return result([], true);
  let engines;
  let suite;
  try {
    engines = await loadEngines();
    suite = engines.fit.themeFitReportSuite(styles.lightTheme, styles.darkTheme);
  } catch {
    return result([], true);
  }
  const items = [];
  let skipped = false;
  for (const { surface, scheme, kind, artwork } of checks) {
    const report = suite[scheme]?.find(value => value.surface === (surface.context || engines.fit.ROOT_SURFACE));
    const token = report?.tokens.find(value => value.token === "layer2");
    const parsed = token === undefined ? null : engines.color.parseCssColor(token.resolved);
    if (parsed === null || !Number.isFinite(parsed.l)) { skipped = true; continue; }
    if ((parsed.l < 0.5 ? "dark" : "light") === artwork) continue;
    const detail = `${scheme}:${kind === "compact" ? "compact:" : ""}${artwork}`;
    const item = { rule: LOGO_ON_SURFACE_RULE, severity: "warning", file: FILES[surface.name], subject: surface.name, detail };
    items.push(item);
    onProgress(`Warning: ${item.file} ${describeSiteFinding({ ruleId: item.rule, ...item })}.`);
  }
  return result(items, skipped);
}
