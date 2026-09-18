import {
  buildTaprootDarkTheme,
  buildTaprootLightTheme,
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  encodeTheme,
  layerThemes,
  mergePartials,
  mergeTheme,
  parseTheme,
} from "@taprootio/espalier/shared/theme";

import { SiteAuthoringError } from "./errors.js";
import { missingThemeFields } from "./theme-validation.js";

/**
 * Project one stored scheme theme to the complete theme a consumer actually
 * renders (TR00775).
 *
 * Taproot stores what was written. A site whose theme was seeded or written
 * before a key existed keeps a sparse document, and every consumer — the
 * app's preview, the generator, the published runtime — resolves it by
 * layering the same defaults underneath: Espalier's scheme defaults plus,
 * for a theme Taproot still manages, the Taproot house theme with an empty
 * page background. A theme the CLI manages (`*ThemeManagedExternally`) is
 * rendered as stored over Espalier's defaults alone. `pull` writes exactly
 * that effective theme, so a fresh workspace validates and a designer edits
 * every group with its authoritative value instead of reconstructing it.
 *
 * Semantic mappings are the one group that is *not* filled from defaults.
 * Espalier compiles them from `roles` at merge time; a mapping stored in
 * `semanticMappings` pins that token and shadows whatever the roles would
 * have produced. Copying the defaults' twenty-three mappings into the
 * document would therefore freeze them and make later role changes inert
 * — the failure a complete seeded theme already exhibits. The projection
 * keeps only the mappings that are authored pins: those the stored marker
 * names, plus any mapping whose value differs from the effective default
 * (a pin added by hand without updating the marker). It writes the marker
 * for exactly that set, so `theme push` stores pins only and roles compile
 * for everything else.
 *
 * Layering alone is not rendering parity: `mergeTheme` also lets an
 * unpinned type-role ink inherit a customized `text` mapping, and lets a
 * `chroma.text` override flow into the type-role chroma bands the document
 * did not set. Filling those groups from the defaults, or dropping a
 * cached mapping that was holding a token at its default, would change
 * what the site renders. So the projection is reconciled against Espalier
 * itself: the stored theme is resolved exactly the way its consumers resolve
 * it, the projected document is resolved the same way, and every difference
 * is written back as the rendered value (a mapping pin, a chroma band). The
 * result validates, keeps the author's pins, and renders what the site
 * rendered before the pull.
 */

const SCHEME_DEFAULTS = Object.freeze({
  light: { defaults: DEFAULT_LIGHT_THEME, house: buildTaprootLightTheme },
  dark: { defaults: DEFAULT_DARK_THEME, house: buildTaprootDarkTheme },
});

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameMapping(left, right) {
  return isPlainObject(left) && isPlainObject(right)
    && left.source === right.source && left.lightness === right.lightness
    && Object.keys(left).length === Object.keys(right).length;
}

/**
 * The complete theme a consumer layers a stored theme onto: Espalier's
 * scheme defaults, and — unless the theme is managed externally — the
 * Taproot house theme with the empty page background both the BFF and the
 * generator clear before rendering.
 */
export function effectiveThemeBase(scheme, { managedExternally = false } = {}) {
  const { defaults, house } = SCHEME_DEFAULTS[scheme];
  const houseTheme = parseTheme(house("")) ?? {};
  if (managedExternally) {
    // Espalier's defaults carry no page background at all; the stored
    // contract requires both keys. No image is the rendered truth, and the
    // opacity of an absent image is neutral, so the house value fills it.
    return {
      ...defaults,
      pageBackgroundImage: "",
      pageBackgroundImageOpacity: houseTheme.pageBackgroundImageOpacity,
    };
  }
  return { ...mergePartials(defaults, houseTheme), pageBackgroundImage: "" };
}

export function projectPulledTheme(stored, scheme, { managedExternally = false } = {}) {
  const source = isPlainObject(stored) ? stored : {};
  const base = effectiveThemeBase(scheme, { managedExternally });
  const { semanticMappings: _baseMappings, ...layerable } = base;
  // The marker is set on the base so mergePartials treats every stored
  // mapping as authored; the pin filter below then decides which survive.
  const merged = mergePartials({ ...layerable, semanticMappings: {}, explicitMappingTokens: [] }, source);

  const marker = Array.isArray(source.explicitMappingTokens)
    ? new Set(source.explicitMappingTokens.filter((token) => typeof token === "string"))
    : undefined;
  const pins = {};
  if (isPlainObject(source.semanticMappings)) {
    for (const [token, mapping] of Object.entries(source.semanticMappings)) {
      const cachedDefault = sameMapping(mapping, base.semanticMappings?.[token]);
      if (marker?.has(token) || !cachedDefault) pins[token] = mapping;
    }
  }
  const projected = reconcileWithRendering(
    { ...merged, semanticMappings: pins, explicitMappingTokens: Object.keys(pins) },
    source,
    scheme,
    managedExternally,
  );

  requireProjectedThemeComplete(projected, scheme);
  return projected;
}

/** What a consumer renders for a stored theme: the partial it layers, resolved over Espalier's defaults. */
function renderedTheme(stored, scheme, managedExternally) {
  const { defaults, house } = SCHEME_DEFAULTS[scheme];
  const layered = managedExternally
    ? layerThemes(encodeTheme(stored))
    : layerThemes(house(""), encodeTheme({ pageBackgroundImage: "" }), encodeTheme(stored));
  return mergeTheme(defaults, parseTheme(layered) ?? {});
}

function canonicalJson(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((entry) => JSON.parse(canonicalJson(entry))));
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, JSON.parse(canonicalJson(value[key]))])));
}

/**
 * Bring the projected document to rendering parity with the stored theme.
 * Two passes suffice: a mapping pin can change what a companion token
 * inherits, so the comparison runs again after the first corrections.
 *
 * One deliberate exception: a cached default mapping on a token the stored
 * theme's own roles would move is the shadowing pin TR00801 documents and
 * warns about. Restoring it would keep the roles inert, so it stays dropped
 * and the role-compiled value is accepted as the rendering the author asked
 * for. Every other difference is written back.
 */
function reconcileWithRendering(projected, stored, scheme, managedExternally) {
  const { defaults } = SCHEME_DEFAULTS[scheme];
  let rendered;
  let roleCompiled;
  try {
    rendered = renderedTheme(stored, scheme, managedExternally);
    const declaresRoles = isPlainObject(stored.roles) && Object.keys(stored.roles).length > 0;
    roleCompiled = declaresRoles
      ? mergeTheme(defaults, { ...stored, semanticMappings: {}, explicitMappingTokens: [] }).semanticMappings
      : undefined;
  } catch {
    // An invalid stored theme cannot be rendered for comparison; validation
    // reports it, and the layered projection is the best available document.
    return projected;
  }
  let current = projected;
  for (let pass = 0; pass < 2; pass += 1) {
    let candidate;
    try {
      candidate = mergeTheme(defaults, current);
    } catch {
      return current;
    }
    let changed = false;
    for (const key of Object.keys(rendered)) {
      if (key === "explicitMappingTokens") continue;
      if (canonicalJson(rendered[key]) === canonicalJson(candidate[key])) continue;
      changed = true;
      if (key === "semanticMappings") {
        const pins = { ...current.semanticMappings };
        for (const [token, mapping] of Object.entries(rendered.semanticMappings)) {
          if (canonicalJson(mapping) === canonicalJson(candidate.semanticMappings[token])) continue;
          const storedMapping = isPlainObject(stored.semanticMappings) ? stored.semanticMappings[token] : undefined;
          const cachedDefaultTheRolesMove = roleCompiled !== undefined
            && sameMapping(storedMapping, defaults.semanticMappings[token])
            && canonicalJson(candidate.semanticMappings[token]) === canonicalJson(roleCompiled[token]);
          if (cachedDefaultTheRolesMove) continue;
          pins[token] = structuredClone(mapping);
        }
        current = { ...current, semanticMappings: pins, explicitMappingTokens: Object.keys(pins) };
      } else {
        current = { ...current, [key]: structuredClone(rendered[key]) };
      }
    }
    if (!changed) break;
  }
  return current;
}

/**
 * The refusal for a projection that still lacks required fields. Reachable
 * only when Espalier's defaults and the server response together omit a key
 * this CLI requires — a contract drift between releases, never a stale
 * workspace — so the remedy is a report, not another pull. Exported so the
 * refusal itself is testable without an incomplete default to hand.
 */
export function requireProjectedThemeComplete(projected, scheme) {
  const missing = missingThemeFields(projected, scheme);
  if (missing.length === 0) return;
  throw new SiteAuthoringError(
    "theme.projection_incomplete",
    "Taproot's settings response and the Espalier defaults this CLI ships still omit required theme fields. "
      + "This is a contract problem between the server projection and this CLI release, not a stale workspace: "
      + "repeating taproot-site pull cannot supply them. Report the listed paths with the CLI and server versions.",
    { field: missing[0], alternatives: missing },
  );
}
