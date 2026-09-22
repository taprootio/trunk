import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildTaprootDarkTheme,
  buildTaprootLightTheme,
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  encodeTheme,
  layerThemes,
  mergeTheme,
  parseTheme,
} from "@taprootio/espalier/shared/theme";

import { effectiveThemeBase, projectPulledTheme, requireProjectedThemeComplete } from "../src/theme-projection.js";
import { missingThemeFields, validateAndEncodeThemePair } from "../src/theme-validation.js";

const DEFAULT_SITE_THEME = JSON.parse(
  await readFile(new URL("./fixtures/default-site-theme.json", import.meta.url), "utf8"),
);

/** Key order is not part of the rendering contract; compare canonical shapes. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

/** What the generator and BFF render for a Taproot-managed stored theme. */
function renderedTaprootManaged(stored) {
  return mergeTheme(
    DEFAULT_LIGHT_THEME,
    parseTheme(layerThemes(buildTaprootLightTheme(""), encodeTheme({ pageBackgroundImage: "" }), encodeTheme(stored))),
  );
}

function withoutMarker(theme) {
  const { explicitMappingTokens: _marker, ...rest } = theme;
  return rest;
}

/** A pre-menu-font stored theme: the SHY Wellness shape from the handoff. */
function legacyStoredTheme() {
  const stored = structuredClone(DEFAULT_SITE_THEME.light.theme);
  delete stored.fontMenu;
  delete stored.fontWeightMenu;
  stored.seedColor = "#3b5b3b";
  stored.fontBody = "\"Inter\", sans-serif";
  return stored;
}

test("the effective base is complete for both schemes and both provenance modes", () => {
  for (const scheme of ["light", "dark"]) {
    for (const managedExternally of [false, true]) {
      const base = effectiveThemeBase(scheme, { managedExternally });
      assert.deepEqual(missingThemeFields(base, scheme), []);
      assert.equal(base.pageBackgroundImage, "");
    }
  }
  // Taproot's house look layers only onto a theme Taproot still manages.
  const house = parseTheme(buildTaprootLightTheme(""));
  assert.equal(effectiveThemeBase("light").seedColor, house.seedColor);
  assert.equal(effectiveThemeBase("light", { managedExternally: true }).seedColor, DEFAULT_LIGHT_THEME.seedColor);
});

test("a legacy stored theme gains the missing per-scheme fonts from the authoritative defaults and validates", () => {
  const stored = legacyStoredTheme();
  const projected = projectPulledTheme(stored, "light");
  assert.deepEqual(missingThemeFields(projected, "light"), []);
  assert.equal(projected.fontMenu, DEFAULT_LIGHT_THEME.fontMenu);
  assert.equal(projected.fontWeightMenu, DEFAULT_LIGHT_THEME.fontWeightMenu);
  // Authored values win over every default.
  assert.equal(projected.seedColor, "#3b5b3b");
  assert.equal(projected.fontBody, "\"Inter\", sans-serif");
  const dark = projectPulledTheme(structuredClone(DEFAULT_SITE_THEME.dark.theme), "dark");
  const result = validateAndEncodeThemePair(projected, dark);
  assert.equal(typeof result.light, "string");
});

test("only the mappings the marker claims survive projection, and rendering is unchanged", () => {
  const stored = structuredClone(DEFAULT_SITE_THEME.light.theme);
  assert.equal(Object.keys(stored.semanticMappings).length, 23);
  assert.deepEqual(stored.explicitMappingTokens, []);
  stored.anchors = { ...stored.anchors, teal: { color: "#0f766e" } };
  stored.roles = { accent: "anchor:teal", action: "anchor:teal" };
  // One pin named by the marker, one added by hand without updating it.
  stored.semanticMappings.headings = { source: "anchor:teal", lightness: "ink" };
  stored.explicitMappingTokens = ["headings"];
  stored.semanticMappings.typeLabel = { source: "anchor:teal", lightness: "muted" };

  // Since Espalier 4.18.0 the cached defaults no longer shadow the roles in
  // the stored document itself: the marker leaves them recompilable, so the
  // roles already reach link and the action tokens before any projection.
  const before = mergeTheme(DEFAULT_LIGHT_THEME, stored).semanticMappings;
  assert.equal(before.link.source, "anchor:teal");
  assert.equal(before.actionBackground.source, "anchor:teal");

  const projected = projectPulledTheme(stored, "light", { managedExternally: true });
  // Projection keeps the claimed pin and nothing else. The twenty-one cached
  // defaults and the hand-added mapping the marker never claimed are both
  // dropped — writing either back would pin a role-derived token and make the
  // roles inert for it, which is the defect 4.18.0 fixed. theme push reports
  // the unclaimed hand edit so it does not vanish silently.
  assert.deepEqual(canonical(projected.semanticMappings), canonical({
    headings: { source: "anchor:teal", lightness: "ink" },
  }));
  assert.deepEqual(projected.explicitMappingTokens, ["headings"]);

  // Dropping them changes nothing about the rendering, which is the contract
  // a pins-only document has to hold.
  const after = mergeTheme(DEFAULT_LIGHT_THEME, projected).semanticMappings;
  assert.equal(after.link.source, "anchor:teal");
  assert.equal(after.actionBackground.source, "anchor:teal");
  assert.deepEqual(canonical(after.headings), canonical({ source: "anchor:teal", lightness: "ink" }));
  assert.deepEqual(canonical(after.typeLabel), canonical(before.typeLabel));
});

test("a round trip of a theme without roles renders identically and projection is idempotent", () => {
  const stored = legacyStoredTheme();
  const projected = projectPulledTheme(stored, "light");
  assert.deepEqual(
    canonical(withoutMarker(mergeTheme(DEFAULT_LIGHT_THEME, projected))),
    canonical(withoutMarker(renderedTaprootManaged(stored))),
  );
  // What push stores is what the next pull projects: a managed-externally
  // read of the pushed theme reproduces it exactly.
  assert.deepEqual(
    canonical(projectPulledTheme(projected, "light", { managedExternally: true })),
    canonical(projected),
  );
});

test("an unset stored theme projects to the complete effective base with no pins", () => {
  for (const stored of [{}, undefined, null]) {
    const projected = projectPulledTheme(stored, "dark");
    assert.deepEqual(missingThemeFields(projected, "dark"), []);
    assert.deepEqual(projected.semanticMappings, {});
    assert.deepEqual(projected.explicitMappingTokens, []);
    assert.equal(projected.seedColor, effectiveThemeBase("dark").seedColor);
    assert.equal(projected.fontMenu, DEFAULT_DARK_THEME.fontMenu);
  }
});

test("present invalid values are preserved for validation rather than replaced by defaults", () => {
  const stored = legacyStoredTheme();
  stored.angles = null;
  stored.semanticMappings = { link: "not-a-mapping" };
  stored.explicitMappingTokens = ["link"];
  const projected = projectPulledTheme(stored, "light");
  assert.equal(projected.angles, null);
  // A pin the marker claims reaches validation as written, junk and all.
  // Replacing it with a default here would hide the fault the author has to
  // fix and silently push a colour they never chose.
  assert.deepEqual(projected.semanticMappings, { link: "not-a-mapping" });

  // An unclaimed mapping is cached data, not an authored value, so a corrupt
  // one is dropped with the rest rather than pinned into the pulled document.
  const unclaimed = legacyStoredTheme();
  unclaimed.angles = null;
  unclaimed.semanticMappings = { link: "not-a-mapping" };
  const withoutPin = projectPulledTheme(unclaimed, "light");
  assert.equal(withoutPin.angles, null);
  assert.deepEqual(withoutPin.semanticMappings, {});
  assert.deepEqual(withoutPin.explicitMappingTokens, []);
});

test("a marker Espalier would reject leaves every stored mapping a pin", () => {
  // Espalier reads the marker all-or-nothing: a duplicate, an unknown token
  // name, or a name with no mapping entry and it ignores the whole marker and
  // renders every stored mapping as a pin. Reading it leniently here would
  // project a document that renders differently from the one it came from.
  for (const marker of [["link", "link"], ["link", "notAToken"], ["headings"]]) {
    const stored = legacyStoredTheme();
    stored.semanticMappings = { link: { source: "danger", lightness: "accent" } };
    stored.explicitMappingTokens = marker;
    const projected = projectPulledTheme(stored, "light");
    assert.deepEqual(canonical(projected.semanticMappings), canonical(stored.semanticMappings));
    // Rendering parity is the contract that matters, and it holds either way.
    assert.deepEqual(
      canonical(withoutMarker(mergeTheme(DEFAULT_LIGHT_THEME, projected))),
      canonical(withoutMarker(mergeTheme(DEFAULT_LIGHT_THEME, stored))),
    );
  }
});

test("a projection that still lacks required fields refuses with the paths and no pull remedy", () => {
  const projected = projectPulledTheme(legacyStoredTheme(), "light");
  delete projected.fontMenu;
  delete projected.angles.triadic;
  assert.throws(() => requireProjectedThemeComplete(projected, "light"), (error) => {
    assert.equal(error.code, "theme.projection_incomplete");
    assert.equal(error.field, "lightTheme.fontMenu");
    assert.deepEqual(error.alternatives, ["lightTheme.fontMenu", "lightTheme.angles.triadic"]);
    assert.doesNotMatch(error.message, /run taproot-site pull/u);
    assert.match(error.message, /cannot supply them/u);
    return true;
  });
  // The complete projection passes the same check, which is what pull calls.
  requireProjectedThemeComplete(projectPulledTheme(legacyStoredTheme(), "light"), "light");
});

/** What every consumer renders for a Taproot-managed or externally managed stored theme. */
function rendered(stored, scheme, managedExternally) {
  const defaults = scheme === "light" ? DEFAULT_LIGHT_THEME : DEFAULT_DARK_THEME;
  const house = scheme === "light" ? buildTaprootLightTheme : buildTaprootDarkTheme;
  const layered = managedExternally
    ? layerThemes(encodeTheme(stored))
    : layerThemes(house(""), encodeTheme({ pageBackgroundImage: "" }), encodeTheme(stored));
  return mergeTheme(defaults, parseTheme(layered));
}

test("projection renders exactly what the stored theme rendered: inherited type-role chroma and text companions, both schemes", () => {
  for (const scheme of ["light", "dark"]) {
    const defaults = scheme === "light" ? DEFAULT_LIGHT_THEME : DEFAULT_DARK_THEME;
    const cases = [
      // A sparse legacy theme whose chroma.text override flows into the type-role bands it did not set.
      { name: "chroma.text inheritance", stored: { seedColor: "#123456", chroma: { text: { min: 0.01, max: 0.02 } } }, managed: false },
      // The seeded complete shape with a customized text mapping: the cached
      // type-role mappings were holding those tokens at their defaults.
      {
        name: "customized text mapping",
        stored: {
          ...structuredClone(DEFAULT_SITE_THEME[scheme].theme),
          semanticMappings: { ...DEFAULT_SITE_THEME[scheme].theme.semanticMappings, text: { source: "complementary", lightness: "ink" } },
        },
        managed: false,
      },
      { name: "customized text mapping, externally managed", stored: {
          ...structuredClone(DEFAULT_SITE_THEME[scheme].theme),
          semanticMappings: { ...DEFAULT_SITE_THEME[scheme].theme.semanticMappings, text: { source: "complementary", lightness: "ink" } },
        }, managed: true },
    ];
    for (const { name, stored, managed } of cases) {
      const projected = projectPulledTheme(stored, scheme, { managedExternally: managed });
      assert.deepEqual(missingThemeFields(projected, scheme), [], `${scheme} ${name}`);
      assert.deepEqual(
        canonical(withoutMarker(mergeTheme(defaults, projected))),
        canonical(withoutMarker(rendered(stored, scheme, managed))),
        `${scheme} ${name}`,
      );
      // And the document push stores re-projects to itself.
      assert.deepEqual(
        canonical(projectPulledTheme(projected, scheme, { managedExternally: true })),
        canonical(projected),
        `${scheme} ${name} idempotence`,
      );
    }
  }
});
