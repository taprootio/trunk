import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { encodeTheme, parseTheme } from "@taprootio/espalier/shared/theme";

import { APPEARANCE_FOOTER_COLOR_FIELDS } from "../src/appearance-contract.js";
import { projectFooterSettingsForWorkspace } from "../src/footer-contract.js";
import { computeFooterContentHash, computeFooterDraftHash } from "../src/footer-draft-hash.js";
import {
  isSupportedAppearanceColor,
  MAXIMUM_THEME_OPEN_MAP_ENTRIES,
  MAXIMUM_THEME_OPEN_MAP_KEY_SCALARS,
  MAXIMUM_THEME_WARNING_SCALARS,
  REQUIRED_THEME_PROPERTIES,
  REQUIRED_THEME_PATHS,
  fitLintWarnings,
  inertMappingWarnings,
  validateAndEncodeThemePair,
  validateAndLintThemePair,
} from "../src/theme-validation.js";
import { MONOREPO_ONLY, monorepoPath } from "./monorepo.js";

// The package's copy of the seeded default theme, pinned byte-for-byte to the
// canonical shared artifact by renderer-parity.test.js.
const DEFAULT_THEME_URL = new URL("./fixtures/default-site-theme.json", import.meta.url);
const DEFAULT_THEME_SOURCE_PATH = monorepoPath("api", "src", "Taproot.Domain", "Styling", "DefaultSiteTheme.cs");

function csharpStringArray(source, name) {
  const block = new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`, "u").exec(source)?.[1];
  assert.ok(block, `DefaultSiteTheme.${name} must remain discoverable`);
  return [...block.matchAll(/"([A-Za-z][A-Za-z0-9.]*)"/gu)].map((match) => match[1]);
}

test("the CLI and server require the same complete stored-theme structure", { skip: MONOREPO_ONLY }, async () => {
  const source = await readFile(DEFAULT_THEME_SOURCE_PATH, "utf8");
  assert.deepEqual(REQUIRED_THEME_PROPERTIES, csharpStringArray(source, "RequiredProperties"));
  assert.deepEqual(REQUIRED_THEME_PATHS, csharpStringArray(source, "RequiredPaths"));
});

test("the canonical default theme remains a valid complete pair", async () => {
  const defaults = JSON.parse(await readFile(DEFAULT_THEME_URL, "utf8"));
  const result = validateAndEncodeThemePair(defaults.light.theme, defaults.dark.theme);
  assert.equal(typeof result.light, "string");
  assert.equal(typeof result.dark, "string");
  assert.deepEqual(result.warnings, []);
});

test("Espalier validation failures name the rejected theme field", async () => {
  const defaults = JSON.parse(await readFile(DEFAULT_THEME_URL, "utf8"));
  defaults.light.theme.roles = { action: "anchor:missing" };
  defaults.dark.theme.roles = { action: "anchor:missing" };

  assert.throws(
    () => validateAndEncodeThemePair(defaults.light.theme, defaults.dark.theme),
    (error) => error?.code === "theme.validation_failed" && error?.field === "roles.action",
  );
});

test("pair-level context mismatches name the contexts field", async () => {
  const defaults = JSON.parse(await readFile(DEFAULT_THEME_URL, "utf8"));
  defaults.light.theme.contexts = { feature: { canvas: "primary" } };
  defaults.dark.theme.contexts = {};

  assert.throws(
    () => validateAndEncodeThemePair(defaults.light.theme, defaults.dark.theme),
    (error) => error?.code === "theme.validation_failed" && error?.field === "contexts",
  );
});

test("completeness rejects missing defaulted scalars and fixed nested leaves", async () => {
  const defaults = JSON.parse(await readFile(DEFAULT_THEME_URL, "utf8"));
  for (const [field, remove] of [
    ["lightTheme.borderRadius", (theme) => delete theme.borderRadius],
    ["lightTheme.angles.triadic", (theme) => delete theme.angles.triadic],
  ]) {
    const light = structuredClone(defaults.light.theme);
    remove(light);
    assert.throws(
      () => validateAndEncodeThemePair(light, defaults.dark.theme),
      (error) => error?.code === "theme.incomplete" && error?.field === field,
    );
  }
});

test("complete themes reject array-shaped open maps in both schemes", async () => {
  const defaults = JSON.parse(await readFile(DEFAULT_THEME_URL, "utf8"));
  for (const [scheme, property] of [
    ["light", "semanticMappings"],
    ["dark", "variantChroma"],
    ["light", "tones"],
  ]) {
    const light = structuredClone(defaults.light.theme);
    const dark = structuredClone(defaults.dark.theme);
    const theme = scheme === "light" ? light : dark;
    theme[property] = [];
    assert.throws(
      () => validateAndEncodeThemePair(light, dark),
      (error) =>
        error?.code === "theme.document_invalid"
        && error?.field === `${scheme}Theme.${property}`,
    );
  }
});

test("collection-entry validation failures name the collection field", async () => {
  const defaults = JSON.parse(await readFile(DEFAULT_THEME_URL, "utf8"));
  defaults.light.theme.stylesheets = [42];

  assert.throws(
    () => validateAndEncodeThemePair(defaults.light.theme, defaults.dark.theme),
    (error) => error?.code === "theme.validation_failed" && error?.field === "stylesheets",
  );
});

test("agent-authored themes refuse external stylesheets before persistence", async () => {
  const defaults = JSON.parse(await readFile(DEFAULT_THEME_URL, "utf8"));
  for (const scheme of ["light", "dark"]) {
    const light = structuredClone(defaults.light.theme);
    const dark = structuredClone(defaults.dark.theme);
    const theme = scheme === "light" ? light : dark;
    theme.stylesheets = ["https://styles.example/agent-theme.css"];

    assert.throws(
      () => validateAndEncodeThemePair(light, dark),
      (error) =>
        error?.code === "theme.stylesheets_unsupported"
        && error?.field === `${scheme}Theme.stylesheets`,
    );
  }
});

test("invalid stylesheet shapes take precedence over the agent stylesheet restriction", async () => {
  const defaults = JSON.parse(await readFile(DEFAULT_THEME_URL, "utf8"));
  for (const [validScheme, invalidScheme] of [
    ["light", "dark"],
    ["dark", "light"],
  ]) {
    const light = structuredClone(defaults.light.theme);
    const dark = structuredClone(defaults.dark.theme);
    const themes = { light, dark };
    themes[validScheme].stylesheets = ["https://styles.example/agent-theme.css"];
    themes[invalidScheme].stylesheets = [42];

    assert.throws(
      () => validateAndEncodeThemePair(light, dark),
      (error) => error?.code === "theme.validation_failed" && error?.field === "stylesheets",
    );
  }
});

test("open theme maps are bounded before Espalier can amplify diagnostics", async () => {
  const defaults = JSON.parse(await readFile(DEFAULT_THEME_URL, "utf8"));
  defaults.light.theme.anchors = Object.fromEntries(
    Array.from(
      { length: MAXIMUM_THEME_OPEN_MAP_ENTRIES + 1 },
      (_, index) => [`brand-${index}`, "#b83280"],
    ),
  );

  assert.throws(
    () => validateAndEncodeThemePair(defaults.light.theme, defaults.dark.theme),
    (error) =>
      error?.code === "theme.collection_too_large"
      && error?.field === "lightTheme.anchors",
  );
});

test("anchor slot maps are bounded before Espalier can amplify diagnostics", async () => {
  const defaults = JSON.parse(await readFile(DEFAULT_THEME_URL, "utf8"));
  defaults.light.theme.anchors = {
    brand: {
      color: "#b83280",
      ...Object.fromEntries(
        Array.from(
          { length: MAXIMUM_THEME_OPEN_MAP_ENTRIES + 1 },
          (_, index) => [`slot-${index}`, "#b83280"],
        ),
      ),
    },
  };

  assert.throws(
    () => validateAndEncodeThemePair(defaults.light.theme, defaults.dark.theme),
    (error) =>
      error?.code === "theme.collection_too_large"
      && error?.field === "lightTheme.anchors",
  );
});

test("anchor and slot names are bounded before Espalier can amplify diagnostics", async () => {
  const defaults = JSON.parse(await readFile(DEFAULT_THEME_URL, "utf8"));
  const overlongName = "😀".repeat(MAXIMUM_THEME_OPEN_MAP_KEY_SCALARS + 1);
  for (const mutate of [
    (theme) => {
      theme.anchors = { [overlongName]: "#b83280" };
    },
    (theme) => {
      theme.anchors = { brand: { color: "#b83280", [overlongName]: "#b83280" } };
    },
  ]) {
    const light = structuredClone(defaults.light.theme);
    mutate(light);
    assert.throws(
      () => validateAndEncodeThemePair(light, defaults.dark.theme),
      (error) =>
        error?.code === "theme.collection_key_too_long"
        && error?.field === "lightTheme.anchors",
    );
  }
});

test("root and context tone maps are bounded before Espalier can amplify diagnostics", async () => {
  const defaults = JSON.parse(await readFile(DEFAULT_THEME_URL, "utf8"));
  const oversizedTones = () =>
    Object.fromEntries(
      Array.from(
        { length: MAXIMUM_THEME_OPEN_MAP_ENTRIES + 1 },
        (_, index) => [`tone-${index}`, 0.5],
      ),
    );
  const overlongName = "😀".repeat(MAXIMUM_THEME_OPEN_MAP_KEY_SCALARS + 1);
  for (const { code, field, mutate } of [
    {
      code: "theme.collection_too_large",
      field: "lightTheme.tones",
      mutate: (theme) => {
        theme.tones = oversizedTones();
      },
    },
    {
      code: "theme.collection_too_large",
      field: "lightTheme.contexts.feature.tones",
      mutate: (theme) => {
        theme.contexts = { feature: { tones: oversizedTones() } };
      },
    },
    {
      code: "theme.collection_key_too_long",
      field: "lightTheme.tones",
      mutate: (theme) => {
        theme.tones = { [overlongName]: 0.5 };
      },
    },
    {
      code: "theme.collection_key_too_long",
      field: "lightTheme.contexts.feature.tones",
      mutate: (theme) => {
        theme.contexts = { feature: { tones: { [overlongName]: 0.5 } } };
      },
    },
  ]) {
    const light = structuredClone(defaults.light.theme);
    mutate(light);
    assert.throws(
      () => validateAndEncodeThemePair(light, defaults.dark.theme),
      (error) => error?.code === code && error?.field === field,
    );
  }
});

test("theme encoding round-trips text outside Espalier's raw btoa range", async () => {
  const defaults = JSON.parse(await readFile(DEFAULT_THEME_URL, "utf8"));
  defaults.light.theme.fontBrand = "\"日本語 😀\", serif";
  defaults.dark.theme.fontBrand = "\"日本語 😀\", serif";

  const result = validateAndEncodeThemePair(defaults.light.theme, defaults.dark.theme);

  assert.equal(parseTheme(result.light)?.fontBrand, "\"日本語 😀\", serif");
  assert.equal(parseTheme(result.dark)?.fontBrand, "\"日本語 😀\", serif");
});

test("Espalier warnings are terminal-safe and bounded before callers receive them", async () => {
  const defaults = JSON.parse(await readFile(DEFAULT_THEME_URL, "utf8"));
  const hostileWeight = `\u001b[31m${"x".repeat(MAXIMUM_THEME_WARNING_SCALARS * 4)}`;
  defaults.light.theme.fontWeightBody = hostileWeight;
  defaults.dark.theme.fontWeightBody = hostileWeight;

  const result = validateAndEncodeThemePair(defaults.light.theme, defaults.dark.theme);

  assert.equal(result.warningCount, 2);
  assert.equal(result.warningsTruncated, false);
  assert.equal(result.warnings.length, 2);
  for (const warning of result.warnings) {
    assert.equal(warning.includes("\u001b"), false);
    assert.ok([...warning].length <= MAXIMUM_THEME_WARNING_SCALARS);
  }
});

test("the footer draft hash stays byte-compatible with the server default", () => {
  assert.equal(
    computeFooterDraftHash({}),
    "998f0ceea24d03efe6455c2333a4fea6a325e145bec3bf20c59f4556efc829c0",
  );
});

test("the footer content baseline ignores exactly the ten theme-owned colors", () => {
  assert.equal(
    computeFooterContentHash({}),
    "ac515b72a6b7e06fea28e0c2656713c7110c5790193c2dac9436e029658a337b",
  );

  const content = {
    enabled: true,
    bottomLinks: [{ id: "aaaa1111-bbbb-4111-8111-cccc11111111", label: "Privacy", externalUrl: "https://e.test/p" }],
    light: { backgroundColor: "#111111", backgroundImageOpacity: 0.4 },
    dark: { textColor: "#eeeeee", additionalTopPaddingRem: 2 },
  };
  const recolored = structuredClone(content);
  for (const field of APPEARANCE_FOOTER_COLOR_FIELDS) {
    recolored[field.scheme] = { ...recolored[field.scheme], [field.name]: "#b83280" };
  }
  assert.equal(computeFooterContentHash(recolored), computeFooterContentHash(content));
  assert.notEqual(computeFooterDraftHash(recolored), computeFooterDraftHash(content));

  const layoutEdit = structuredClone(content);
  layoutEdit.light.backgroundImageOpacity = 0.7;
  assert.notEqual(computeFooterContentHash(layoutEdit), computeFooterContentHash(content));

  const contentEdit = structuredClone(content);
  contentEdit.bottomLinks[0].label = "Imprint";
  assert.notEqual(computeFooterContentHash(contentEdit), computeFooterContentHash(content));

  // The baseline hashes the raw workspace document, so hand-edited null link
  // entries must hash (as empty links), not throw.
  const nullLinks = {
    bottomLinks: [null],
    linkColumns: [{ id: "aaaa1111-bbbb-4111-8111-cccc11111111", groups: [{ id: "aaaa1111-bbbb-4111-8111-cccc11111112", links: [null] }] }],
    light: null,
  };
  assert.match(computeFooterContentHash(nullLinks), /^[0-9a-f]{64}$/u);
  assert.match(computeFooterDraftHash(nullLinks), /^[0-9a-f]{64}$/u);
});

test("the footer content baseline preserves types and shapes the canonical form normalizes away", () => {
  const pulled = projectFooterSettingsForWorkspace({});
  for (
    const edit of [
      { enabled: "true" },
      { showBrand: 1 },
      { bottomLinks: {} },
      { bottomContent: "keep me" },
    ]
  ) {
    const edited = { ...structuredClone(pulled), ...edit };
    assert.notEqual(
      computeFooterContentHash(edited),
      computeFooterContentHash(pulled),
      `a hand-edit of ${JSON.stringify(edit)} must change the content baseline`,
    );
    // The canonical draft form deliberately normalizes these shapes away —
    // which is exactly why it cannot be the unpushed-edit baseline.
    assert.equal(computeFooterDraftHash(edited), computeFooterDraftHash(pulled));
  }

  // Formatting-only differences never refuse: key order is irrelevant.
  assert.equal(
    computeFooterContentHash({ enabled: true, showBrand: false }),
    computeFooterContentHash({ showBrand: false, enabled: true }),
  );
});

test("the footer content baseline refuses pathological nesting with a stable code, not a stack error", () => {
  let nested = { label: "bottom" };
  for (let index = 0; index < 6000; index += 1) nested = { child: nested };
  assert.throws(
    () => computeFooterContentHash({ bottomLinks: [nested] }),
    (error) =>
      error?.code === "footer.document_too_deep"
      && error?.field === "settings/site-publishing-preferences.json",
  );

  // A workspace at any realistic depth still hashes.
  let deep = { label: "leaf" };
  for (let index = 0; index < 40; index += 1) deep = { child: deep };
  assert.match(computeFooterContentHash({ bottomLinks: [deep] }), /^[0-9a-f]{64}$/u);
});

test("appearance colors admit only bounded colors and field-approved tokens", () => {
  const tokens = new Set(["--esp-color-link"]);
  assert.equal(isSupportedAppearanceColor("", tokens), true);
  assert.equal(isSupportedAppearanceColor("#b83280", tokens), true);
  assert.equal(isSupportedAppearanceColor("oklch(0.8 0.1 330)", tokens), true);
  assert.equal(isSupportedAppearanceColor("--esp-color-link", tokens), true);
  assert.equal(isSupportedAppearanceColor("--esp-color-text", tokens), false);
  assert.equal(isSupportedAppearanceColor("oklch(1.1 0.1 330)", tokens), false);
  assert.equal(isSupportedAppearanceColor("oklch(0.8 0.5 330)", tokens), false);
});

test("a mapping the marker does not name is reported as inert, whatever put it there", async () => {
  const defaults = JSON.parse(await readFile(DEFAULT_THEME_URL, "utf8"));
  const withRoles = (theme) => ({
    ...theme,
    anchors: { ...theme.anchors, teal: { color: "#0f766e" } },
    roles: { accent: "anchor:teal", action: "anchor:teal" },
  });
  // The seeded shape: every default mapping cached, none of them claimed.
  // Only the tokens these roles move away from their cached value are
  // discarded, so only those are reported.
  const cached = withRoles(defaults.light.theme);
  const warnings = inertMappingWarnings(cached, "light");
  const tokens = warnings.map((warning) => /semanticMappings\.([a-zA-Z0-9]+)/u.exec(warning)[1]);
  assert.ok(tokens.includes("link") && tokens.includes("actionBackground"), tokens.join(","));
  assert.ok(!tokens.includes("border") && !tokens.includes("shadow"), tokens.join(","));
  assert.ok(tokens.length < Object.keys(cached.semanticMappings).length);
  assert.match(warnings[0], /is not named in explicitMappingTokens/u);
  // The warning names what the token actually renders as, so an author can
  // tell an accepted role from a silently dropped value.
  assert.match(warnings.find((warning) => /\.link /u.test(warning)), /renders as anchor:teal\/accent/u);
  // A pin the marker names is deliberate and never reported.
  const deliberate = { ...cached, explicitMappingTokens: ["link"] };
  assert.ok(!inertMappingWarnings(deliberate, "light").some((warning) => /\.link /u.test(warning)));
  // Pins only: an authored pin that differs from the default is intentional.
  const pinsOnly = withRoles({
    ...defaults.light.theme,
    semanticMappings: { headings: { source: "anchor:teal", lightness: "ink" } },
    explicitMappingTokens: ["headings"],
  });
  assert.deepEqual(inertMappingWarnings(pinsOnly, "light"), []);
  // Cached values the resolver reproduces exactly stay invisible: the seeded
  // theme on its own must not produce a wall of warnings.
  assert.deepEqual(inertMappingWarnings(defaults.light.theme, "light"), []);
  // A mapping edited by hand without adding its token to the marker is the
  // case a default-comparison missed: the value is neither the default nor
  // applied, and it used to disappear with nothing said.
  const handEdited = {
    ...defaults.light.theme,
    semanticMappings: { ...defaults.light.theme.semanticMappings, typeLabel: { source: "danger", lightness: "ink" } },
  };
  assert.match(
    inertMappingWarnings(handEdited, "light").find((warning) => /\.typeLabel /u.test(warning)),
    /is not named in explicitMappingTokens/u,
  );
  // A document with no marker at all predates the contract: every mapping in
  // it is still a pin, so there is nothing inert to report.
  const { explicitMappingTokens: _marker, ...unmarked } = handEdited;
  assert.deepEqual(inertMappingWarnings(unmarked, "light"), []);
  // A marker Espalier would reject reads the same way it does there — the
  // whole marker is ignored and every mapping stays a pin — so reporting any
  // of them as inert would be describing a rendering that never happens.
  // (A name with no mapping entry is the third way a marker is rejected; this
  // seeded document carries all twenty-three, so that case lives in the
  // projection tests, where the document is sparse.)
  for (const marker of [["link", "link"], ["link", "notAToken"]]) {
    assert.deepEqual(inertMappingWarnings({ ...cached, explicitMappingTokens: marker }, "light"), []);
  }
  // The warning reaches the push/validate result beside Espalier's own, for both schemes.
  const result = validateAndEncodeThemePair(cached, withRoles(defaults.dark.theme));
  assert.ok(result.warnings.some((warning) => /^light: semanticMappings\.link is not named/u.test(warning)));
  assert.ok(result.warnings.some((warning) => /^dark: semanticMappings\.link is not named/u.test(warning)));
  assert.equal(result.warningCount >= result.warnings.length, true);
});

test("validate and theme push report Espalier's fit lints on every surface, in both schemes", async () => {
  const defaults = JSON.parse(await readFile(DEFAULT_THEME_URL, "utf8"));
  // A dark band whose filled action names a paper swatch. The theme is valid;
  // what is wrong is the compiled result — the engine seats the action at a
  // mid-band stop, so the paper renders grey carrying a pale label, the wrong
  // way round. Only the fit report sees that, and only on the context.
  const withBand = (theme, band = {}) => ({
    ...theme,
    anchors: { ...theme.anchors, paper: "#fffaf4", midnight: "#21172b" },
    contexts: {
      band: {
        canvas: "anchor:midnight",
        ink: { color: "anchor:paper", heading: "anchor:paper" },
        action: { color: "anchor:paper", ink: "anchor:midnight" },
        lightness: { surface: 0.16, raised1: 0.2, raised2: 0.25, raised3: 0.3, raised4: 0.36, text: 0.96, ink: 0.99 },
        ...band,
      },
    },
  });
  const inverted = await validateAndLintThemePair(withBand(defaults.light.theme), withBand(defaults.dark.theme));
  assert.deepEqual(
    inverted.warnings.map((warning) => /^(?:light|dark): contexts\.band fit lint [a-z-]+/u.exec(warning)?.[0]),
    ["light: contexts.band fit lint action-anchor-inversion", "dark: contexts.band fit lint action-anchor-inversion"],
  );
  assert.equal(inverted.warningCount, 2);
  // The remedy is the last sentence of a long message, so the whole lint has
  // to survive the per-warning bound or the warning names a problem and not
  // its fix.
  for (const warning of inverted.warnings) {
    assert.match(warning, /Retune by pinning semanticMappings\.actionBackground/u);
    assert.match(warning, /cannot hold a label at its own lightness\.$/u);
  }
  // The remedy the lint names clears it: pin the band's action past the band.
  const pin = {
    tones: { "paper-band": 0.88 },
    semanticMappings: { actionBackground: { source: "anchor:paper", lightness: "tone:paper-band" } },
  };
  const pinned = await validateAndLintThemePair(withBand(defaults.light.theme, pin), withBand(defaults.dark.theme, pin));
  assert.deepEqual(pinned.warnings, []);

  // A root-surface lint carries no context path. It shares one count and cap
  // with the other warnings and sits between Espalier's validation warnings
  // and the inert mappings: the seeded shape alone yields an inert warning
  // per cached token and scheme, enough to fill the cap, and the lint is the
  // finding that must not be the one cut off.
  const gold = (theme) => ({
    ...theme,
    anchors: { ...theme.anchors, gold: "oklch(0.81 0.15 85)", umber: "#1d1a14" },
    roles: { ...theme.roles, action: { color: "anchor:gold", ink: "anchor:umber" } },
  });
  const root = await validateAndLintThemePair(gold(defaults.light.theme), gold(defaults.dark.theme));
  const kind = (warning) =>
    / fit lint /u.test(warning) ? "lint" : /is not named in explicitMappingTokens/u.test(warning) ? "inert" : "validation";
  const lints = root.warnings.filter((warning) => kind(warning) === "lint");
  assert.deepEqual(
    lints.map((warning) => /^(?:light|dark): fit lint [a-z-]+/u.exec(warning)?.[0]),
    ["light: fit lint action-anchor-inversion", "dark: fit lint action-anchor-inversion"],
  );
  const kinds = root.warnings.map(kind);
  assert.ok(kinds.includes("validation") && kinds.includes("inert"), kinds.join(","));
  assert.deepEqual(kinds, [...kinds].sort((left, right) =>
    ["validation", "lint", "inert"].indexOf(left) - ["validation", "lint", "inert"].indexOf(right)
  ));
  assert.equal(root.warningCount, root.warnings.length);

  // Data-palette collisions are Espalier validation's warning already; the
  // suite's copy of the same finding is not repeated.
  const collided = (theme) => ({ ...theme, dataPalette: { ...theme.dataPalette, series2: theme.dataPalette.series1 } });
  const palette = await validateAndLintThemePair(collided(defaults.light.theme), collided(defaults.dark.theme));
  assert.ok(palette.warnings.length > 0);
  assert.ok(palette.warnings.every((warning) => !/ fit lint /u.test(warning)), palette.warnings.join("\n"));

  // Lints are not a validation phase an unparseable pair could skip quietly:
  // a report Espalier cannot build says the lints were not checked.
  const unchecked = await fitLintWarnings(encodeTheme({ seedColor: "not-a-colour" }), encodeTheme({}));
  assert.equal(unchecked.length, 1);
  assert.match(unchecked[0], /^Espalier could not build the fit report, so no fit lints were checked: /u);

  // None of that loaded Espalier's component modules: they register custom
  // elements on import, which a process holding another Espalier copy cannot
  // survive (generator/src/site-authoring-content-isolation.test.ts).
  assert.equal(globalThis.customElements, undefined);
});
