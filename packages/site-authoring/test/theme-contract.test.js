import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseTheme } from "@taprootio/espalier/shared/theme";

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
  validateAndEncodeThemePair,
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
