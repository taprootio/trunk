import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { encodeTheme, SEMANTIC_COLOR_NAMES, TOKEN_PAIRINGS } from "@taprootio/espalier/shared/theme";

import { CAPABILITY_CONTENT, CAPABILITY_DESIGN } from "../src/capabilities.js";
import { decodeChromePair } from "../src/chrome-output.js";
import { runCli, VERB_CAPABILITIES, VERB_SURFACES } from "../src/cli.js";
import { LIMITS, SURFACE_DOCS_PRESENTATION, SURFACE_STANDARD } from "../src/constants.js";
import { footerImageIds } from "../src/footer-contract.js";
import { withinByteBudget } from "../src/problems.js";
import { formatThemeResolve, loadThemeEngines, resolveThemePair } from "../src/theme-resolve.js";
import { themeResolve } from "../src/verbs/theme-resolve.js";

const EXAMPLE = new URL("../examples/riverbend-wellness/", import.meta.url);
const EXAMPLE_STYLES = new URL("settings/taproot-styles.json", EXAMPLE);
const TOKEN = "tr_live_site_key_that_must_never_be_logged";
const HEX = /^#[0-9a-f]{6}$/u;

function sink() {
  let text = "";
  return { write: (chunk) => void (text += chunk), read: () => text };
}

/** The shipped example's styles document, as a pulled workspace holds it, with the theme edited by `edit`. */
async function workspace(testContext, edit = () => {}) {
  const document = JSON.parse(await readFile(EXAMPLE_STYLES, "utf8"));
  edit(document.settings);
  const root = await mkdtemp(path.join(os.tmpdir(), "taproot-site-theme-resolve-"));
  testContext.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "site", "settings"), { recursive: true });
  await writeFile(path.join(root, "site", "settings", "taproot-styles.json"), `${JSON.stringify(document)}\n`);
  await writeFile(
    path.join(root, "taproot-site.json"),
    `${JSON.stringify({ configVersion: 1, siteId: document.entityId, workspaceDir: "site" })}\n`,
  );
  return { root, siteId: document.entityId, settings: document.settings };
}

/** Runs the real CLI with no credential and a network that fails the test if it is touched. */
async function run(site, arguments_, { environment = {}, fetch, handlers } = {}) {
  const stdout = sink();
  const stderr = sink();
  const calls = [];
  const exitCode = await runCli({
    arguments_,
    cwd: site.root,
    environment: { HOME: site.root, XDG_CONFIG_HOME: path.join(site.root, "config"), ...environment },
    stdout,
    stderr,
    ...(handlers === undefined ? {} : { handlers }),
    fetch: async (url, init) => {
      calls.push(String(url));
      if (fetch === undefined) throw new Error(`unexpected network request to ${url}`);
      return await fetch(url, init);
    },
  });
  return { exitCode, stdout: stdout.read(), stderr: stderr.read(), calls };
}

async function resolveJson(site, extra = [], options) {
  const result = await run(site, ["theme", "resolve", "--json", ...extra], options);
  return { ...result, json: JSON.parse(result.stdout) };
}

async function chromeWorkspace(site, { header = {}, publishing = {}, footer = {} } = {}) {
  const [headerDocument, publishingDocument, manifest, media, navigation] = await Promise.all([
    "settings/site-header.json",
    "settings/site-publishing-preferences.json",
    "manifest.fixture.json",
    ".taproot-site-media.json",
    "nav.json",
  ].map(async (file) => JSON.parse(await readFile(new URL(file, EXAMPLE), "utf8"))));
  headerDocument.entityId = site.siteId;
  publishingDocument.entityId = site.siteId;
  for (const artifact of [manifest, media, navigation]) artifact.siteId = site.siteId;
  Object.assign(headerDocument.settings, header);
  Object.assign(publishingDocument.settings, publishing);
  Object.assign(publishingDocument.settings.footerSettings, footer);
  manifest.footer = { imageIds: [...footerImageIds(publishingDocument.settings.footerSettings)] };
  manifest.pages = manifest.pages.map((page) => ({ ...page, status: "PAGE_STATUS_PUBLISHED" }));
  for (const [file, document] of [
    ["settings/site-header.json", headerDocument],
    ["settings/site-publishing-preferences.json", publishingDocument],
    [".taproot-site-manifest.json", manifest],
    [".taproot-site-media.json", media],
    ["nav.json", navigation],
  ]) {
    await writeFile(path.join(site.root, "site", file), JSON.stringify(document));
  }
  return {
    headerSettings: headerDocument.settings,
    sitePublishingPreferences: publishingDocument.settings,
    navItems: navigation.navItems,
  };
}

function chromePairs(result, scheme, role) {
  return result.chrome[scheme]?.find((surface) => surface.role === role)?.pairs.map((row) =>
    decodeChromePair(result.chromeCatalog, row)) ?? [];
}

function surfaceFor(json, scheme, context = null) {
  return json.schemes.find((entry) => entry.scheme === scheme).surfaces.find((surface) => surface.context === context);
}

test("resolves the shipped example theme in both schemes without a credential or the network", async (context) => {
  const site = await workspace(context);
  const { exitCode, json, calls } = await resolveJson(site);
  assert.equal(exitCode, 0);
  assert.equal(json.ok, true);
  assert.equal(json.verb, "theme resolve");
  assert.equal(json.source, "workspace");
  assert.deepEqual(calls, []);
  assert.deepEqual(json.schemes.map((entry) => entry.scheme), ["light", "dark"]);

  for (const { scheme, surfaces } of json.schemes) {
    const declared = Object.keys(site.settings[`${scheme}Theme`].contexts).sort();
    assert.deepEqual(surfaces.map((surface) => surface.context).filter((name) => name !== null).sort(), declared);
    assert.equal(surfaces[0].context, null, "the root page comes first");
    for (const surface of surfaces) {
      assert.deepEqual([...surface.tokens.map((token) => token.token)].sort(), [...SEMANTIC_COLOR_NAMES].sort());
      for (const token of surface.tokens) {
        assert.match(token.value, /^oklch\(/u);
        assert.match(token.hex, HEX);
        assert.ok(["compiled", "pinned", "inherited_pin"].includes(token.origin), token.origin);
      }
      assert.deepEqual(surface.pairs.map((pair) => pair.token), Object.keys(TOKEN_PAIRINGS));
      for (const pair of surface.pairs) {
        assert.ok(pair.ratio >= 1 && pair.ratio <= 21, `${pair.token} ratio ${pair.ratio}`);
        assert.ok([3, 4.5].includes(pair.required));
        assert.equal(typeof pair.aa, "boolean");
        assert.equal(typeof pair.apcaMet, "boolean");
      }
    }
  }
  assert.deepEqual(json.flags, { items: [], count: 0 });
  assert.equal(json.contrast.belowAa, 0);

  // The example pins actionBackground to its ember-deep tone in both schemes; the rest compiles from roles.
  const root = surfaceFor(json, "light");
  const action = root.tokens.find((token) => token.token === "actionBackground");
  assert.equal(action.origin, "pinned");
  assert.equal(action.source, "anchor:ember");
  assert.equal(action.hex, "#905200");
  assert.deepEqual(root.pinned, ["actionBackground"]);
  assert.equal(root.tokens.find((token) => token.token === "text").origin, "compiled");
  // A context carries the root's pin and says so.
  const inverted = surfaceFor(json, "light", "inverted");
  assert.equal(inverted.tokens.find((token) => token.token === "actionBackground").origin, "inherited_pin");
  // Black on white is 21:1; a body text pair on the example's paper canvas is far above AA.
  assert.ok(root.pairs.find((pair) => pair.token === "text").ratio > 7);
});

test("prints a readable table by default and the JSON contract with --json", async (context) => {
  const site = await workspace(context);
  const table = await run(site, ["theme", "resolve", "--scheme", "dark", "--context", "inverted"]);
  assert.equal(table.exitCode, 0);
  assert.match(table.stdout, /^Compiled colors from the workspace theme\./u);
  assert.match(table.stdout, /dark · context inverted/u);
  assert.match(table.stdout, /actionBackground\s+oklch\(.+#[0-9a-f]{6}\s+inherited pin: anchor:ember @ tone:ember-light/u);
  assert.match(table.stdout, /All 13 pairs meet WCAG AA\./u);
  assert.throws(() => JSON.parse(table.stdout));

  const { json } = await resolveJson(site, ["--scheme", "dark", "--context", "inverted"]);
  assert.deepEqual(json.schemes.map((entry) => [entry.scheme, entry.surfaces.map((surface) => surface.context)]), [
    ["dark", ["inverted"]],
  ]);
});

test("flags pairs under WCAG AA with stable codes and the field to edit, and still exits 0", async (context) => {
  // Pinning the canvas to a mid-tone leaves the enforcer one direction to walk, which ends at black on 4.48:1.
  const site = await workspace(context, ({ lightTheme }) => {
    lightTheme.tones = { ...lightTheme.tones, "mid-band": 0.55 };
    lightTheme.semanticMappings.background = { source: "primary", lightness: "tone:mid-band" };
    lightTheme.explicitMappingTokens = [...lightTheme.explicitMappingTokens, "background"];
  });
  const { exitCode, json } = await resolveJson(site, ["--scheme", "light"]);
  assert.equal(exitCode, 0);
  assert.equal(json.ok, true);
  assert.ok(json.contrast.belowAa > 0);
  assert.equal(json.flags.count, json.contrast.belowAa);

  const rootFlags = json.flags.items.filter((flag) => flag.context === null);
  assert.ok(rootFlags.length > 0);
  for (const flag of json.flags.items) {
    assert.equal(flag.code, "theme.contrast_text_below_aa");
    assert.equal(flag.area, "presentation");
    assert.equal(flag.file, "settings/taproot-styles.json");
    assert.equal(flag.required, 4.5);
    assert.ok(flag.ratio < 4.5);
    assert.equal(flag.field, flag.context === null ? "lightTheme" : `lightTheme.contexts.${flag.context}`);
  }
  assert.ok(rootFlags.some((flag) => flag.token === "text" && flag.background === "background" && flag.ratio === 4.48));
  // Headings are large text: 4.48:1 clears their 3:1, so they are not flagged.
  const root = surfaceFor(json, "light");
  assert.equal(root.pairs.find((pair) => pair.token === "headings").aa, true);
  assert.equal(root.pairs.find((pair) => pair.token === "text").aa, false);

  const table = await run(site, ["theme", "resolve", "--scheme", "light", "--context", "raised"]);
  assert.match(table.stdout, /text\s+background\s+4\.48:1\s+4\.5:1\s+Lc [\d.]+\/75\s+BELOW AA/u);
  assert.match(table.stdout, /pairs are below WCAG AA \(flags: theme\.contrast_text_below_aa\)/u);
});

test("legacy WCAG ratios preserve clamping, display precision, and AA decisions for gamut-edge colors", async (context) => {
  const site = await workspace(context, ({ lightTheme }) => {
    lightTheme.anchors.saturated = "oklch(0.5 0.25 35)";
    lightTheme.tones.edge = 0.5;
    lightTheme.semanticMappings.background = { source: "anchor:saturated", lightness: "tone:edge" };
    lightTheme.explicitMappingTokens = [...lightTheme.explicitMappingTokens, "background"];
  });
  const { exitCode, json } = await resolveJson(site, ["--scheme", "light"]);
  assert.equal(exitCode, 0);
  const { color } = await loadThemeEngines();
  const surface = surfaceFor(json, "light");
  let gamutEdge = false;
  const luminance = new Map(surface.tokens.map(({ token, value }) => {
    const { r, g, b } = color.oklchToSRGB(color.gamutMapToSRGB(color.parseCssColor(value)));
    gamutEdge ||= [r, g, b].some((channel) => channel < 0 || channel > 1);
    const linear = (channel) => color.gammaToLinear(Math.max(0, Math.min(1, channel)));
    return [token, 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)];
  }));
  assert.equal(gamutEdge, true, "the fixture must exercise the legacy clamp");
  for (const { token, background, required, ratio, aa } of surface.pairs) {
    const [lighter, darker] = [luminance.get(token), luminance.get(background)].sort((a, b) => b - a);
    const raw = (lighter + 0.05) / (darker + 0.05);
    assert.equal(ratio, Math.floor(raw * 100 + 1e-9) / 100, token);
    assert.equal(aa, raw >= required, token);
  }
});

test("narrowing never skips validation of the whole pair", async (context) => {
  const site = await workspace(context, ({ darkTheme }) => {
    delete darkTheme.roles;
  });
  const { exitCode, json } = await resolveJson(site, ["--scheme", "light"]);
  assert.equal(exitCode, 1);
  assert.equal(json.ok, false);
  // The code and the full path list theme push and validate give a stale workspace.
  assert.equal(json.error.code, "theme.settings_missing");
  assert.equal(json.error.field, "darkTheme.roles");
  assert.deepEqual(json.error.details.map((detail) => detail.field), ["darkTheme.roles"]);
});

test("an unknown context lists the declared ones; a bad scheme is a usage fault", async (context) => {
  const site = await workspace(context);
  const unknown = await resolveJson(site, ["--context", "nope"]);
  assert.equal(unknown.exitCode, 1);
  assert.equal(unknown.json.error.code, "theme.context_unknown");
  assert.deepEqual(unknown.json.error.alternatives, ["inverted", "raised", "subtle"]);

  const scheme = await run(site, ["theme", "resolve", "--scheme", "sepia"]);
  assert.equal(scheme.exitCode, 2);
  assert.equal(JSON.parse(scheme.stdout).error.code, "theme.scheme_invalid");
  const twice = await run(site, ["theme", "resolve", "--scheme", "dark", "--scheme", "light"]);
  assert.equal(JSON.parse(twice.stdout).error.code, "cli.duplicate_option");
});

test("a workspace that was never pulled is refused, and the network stays untouched", async (context) => {
  const site = await workspace(context);
  await rm(path.join(site.root, "site", "settings"), { recursive: true });
  const { exitCode, json, calls } = await resolveJson(site);
  assert.equal(exitCode, 1);
  assert.equal(json.error.code, "theme.settings_missing");
  assert.deepEqual(calls, []);
});

test("names the surfaces a large theme left out so the result stays inside its bound", async (context) => {
  const site = await workspace(context, ({ lightTheme, darkTheme }) => {
    for (const theme of [lightTheme, darkTheme]) {
      for (let index = 0; index < 40; index += 1) {
        theme.contexts[`zone-${String(index).padStart(2, "0")}`] = structuredClone(theme.contexts.subtle);
      }
    }
  });
  const { exitCode, stdout, json } = await resolveJson(site);
  assert.equal(exitCode, 0);
  assert.ok(Buffer.byteLength(stdout, "utf8") < LIMITS.githubOutputBytes);
  assert.ok(json.omittedSurfaces.count > 0);
  const shown = json.schemes.flatMap((entry) => entry.surfaces.map((surface) => `${entry.scheme}/${surface.context}`));
  assert.equal(json.omittedSurfaces.count + shown.length, 2 * 44);
  for (const omitted of json.omittedSurfaces.items) assert.ok(!shown.includes(`${omitted.scheme}/${omitted.context}`));
  assert.equal(json.contexts.count, 43);
  // Narrowing to one context gets the surface back.
  const narrowed = await resolveJson(site, ["--scheme", "dark", "--context", "zone-39"]);
  assert.equal(narrowed.json.omittedSurfaces, undefined);
  assert.equal(narrowed.json.schemes[0].surfaces[0].context, "zone-39");
});

test("a theme at the context limit with long names and many flags still fits the output bound", async (context) => {
  const site = await workspace(context, ({ lightTheme, darkTheme }) => {
    lightTheme.tones = { ...lightTheme.tones, "mid-band": 0.55 };
    lightTheme.semanticMappings.background = { source: "primary", lightness: "tone:mid-band" };
    lightTheme.explicitMappingTokens = [...lightTheme.explicitMappingTokens, "background"];
    for (const theme of [lightTheme, darkTheme]) {
      theme.contexts = {};
      for (let index = 0; index < 128; index += 1) {
        theme.contexts[`z${String(index).padStart(3, "0")}-${"x".repeat(55)}`] = { canvas: "primary" };
      }
    }
  });
  for (const extra of [["--json"], []]) {
    const { exitCode, stdout } = await run(site, ["theme", "resolve", ...extra]);
    assert.equal(exitCode, 0, stdout.slice(0, 300));
    assert.ok(Buffer.byteLength(stdout, "utf8") < LIMITS.githubOutputBytes);
  }
  const { json } = await resolveJson(site);
  assert.equal(json.contexts.count, 128);
  assert.equal(json.contexts.truncated, true);
  assert.equal(json.flags.truncated, true);
  assert.ok(json.flags.count > json.flags.items.length);
});

test("--context refuses a value that is empty, too long, or another option", async (context) => {
  const site = await workspace(context);
  for (const value of [["--context", ""], ["--context", "x".repeat(65)], ["--context", "--json"]]) {
    const { exitCode, stdout } = await run(site, ["theme", "resolve", ...value]);
    assert.equal(exitCode, 2);
    assert.equal(JSON.parse(stdout).error.code, "theme.context_invalid");
  }
});

test("the table goes to stdout and the JSON result to GITHUB_OUTPUT", async (context) => {
  const site = await workspace(context);
  const outputFile = path.join(site.root, "github-output");
  await writeFile(outputFile, "");
  const { exitCode, stdout } = await run(site, ["theme", "resolve", "--scheme", "light", "--context", "raised"], {
    environment: { GITHUB_OUTPUT: outputFile },
  });
  assert.equal(exitCode, 0);
  assert.match(stdout, /^Compiled colors/u);
  assert.match(await readFile(outputFile, "utf8"), /"verb":"theme resolve"/u);
});

test("--site reads the site's presentation with a credential and compiles the same colors", async (context) => {
  const site = await workspace(context);
  const presentation = {
    siteId: site.siteId,
    revision: "c".repeat(64),
    styleSettings: {
      lightTheme: encodeTheme(site.settings.lightTheme),
      darkTheme: encodeTheme(site.settings.darkTheme),
    },
  };
  const served = await resolveJson(site, ["--site"], {
    environment: { TAPROOT_SITE_KEY: TOKEN },
    fetch: async () => new Response(JSON.stringify(presentation), { headers: { "content-type": "application/json" } }),
  });
  assert.equal(served.exitCode, 0, served.stderr);
  assert.equal(served.json.source, "site");
  assert.equal(served.json.siteId, site.siteId);
  assert.equal(served.calls.length, 1);
  assert.match(served.calls[0], new RegExp(`/v1/sites/${site.siteId}/presentation$`, "u"));
  assert.doesNotMatch(`${served.stdout}${served.stderr}`, new RegExp(TOKEN, "u"));

  const offline = await resolveJson(site);
  assert.deepEqual(served.json.schemes, offline.json.schemes);
  assert.deepEqual(served.json.flags, offline.json.flags);

  const unsigned = await resolveJson(site, ["--site"]);
  assert.equal(unsigned.exitCode, 1);
  assert.equal(unsigned.json.ok, false);
  assert.deepEqual(unsigned.calls, []);
});

test("indexed chrome shares identities across schemes, preserves provenance and decodes the text report", async (context) => {
  const site = await workspace(context, ({ lightTheme, darkTheme }) => {
    for (const theme of [lightTheme, darkTheme]) {
      theme.contexts.charcoal = {};
      theme.contexts.header = {};
    }
  });
  await chromeWorkspace(site, {
    header: { context: "charcoal", lightBrandColor: "#0000" },
    footer: { context: "charcoal" },
    publishing: { allowSearch: true },
  });
  const { json, exitCode, calls } = await resolveJson(site);
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, []);
  assert.equal(json.chromeNavigationUnavailable, undefined);
  assert.ok(json.contexts.items.includes("header"));
  assert.deepEqual(json.chrome.light.map(({ role, context }) => [role, context]), [
    ["header", "charcoal"], ["footer", "charcoal"],
  ]);
  assert.ok(json.schemes.every((scheme) => !Object.hasOwn(scheme, "chrome")));
  const brand = chromePairs(json, "light", "header").find(({ element, state }) => element === "brand-text" && state === "rest");
  assert.equal(brand.foreground, "brand-color");
  assert.equal(brand.ratio, 1);
  assert.equal(brand.required, 4.5);
  assert.ok(chromePairs(json, "light", "header").some(({ element }) => element === "search-button"));
  const brandRow = json.chrome.light[0].pairs.find((row) => decodeChromePair(json.chromeCatalog, row).element === "brand-text");
  assert.ok(json.chrome.dark[0].pairs.some(([identity]) => identity === brandRow[0]));
  assert.ok(json.flags.items.some((flag) =>
    flag.field === "site-header.lightBrandColor" && flag.element === "brand-text" && flag.ratio === 1));

  const selected = await resolveJson(site, ["--scheme", "light", "--context", "charcoal"]);
  assert.deepEqual(Object.keys(selected.json.chrome), ["light"]);
  assert.equal(selected.json.contrast.pairs, Object.keys(TOKEN_PAIRINGS).length
    + selected.json.chrome.light.reduce((count, card) => count + card.pairs.length, 0));
  assert.equal(selected.json.flags.count, selected.json.contrast.belowAa);
  assert.ok(selected.json.flags.items.every(({ context, scheme }) => scheme === "light" && context === "charcoal"));
  const noChrome = await resolveJson(site, ["--context", "header"]);
  assert.deepEqual(noChrome.json.chrome, { light: [], dark: [] });
  assert.equal(noChrome.json.contrast.pairs, 2 * Object.keys(TOKEN_PAIRINGS).length);
  assert.deepEqual(noChrome.json.chromeCatalog.pairs, []);

  const human = await run(site, ["theme", "resolve", "--scheme", "light", "--context", "charcoal"]);
  assert.match(human.stdout, /light · header · context charcoal/u);
  assert.match(human.stdout, /brand-text\/rest\s+brand-color\s+layer2\s+1\.00:1\s+4\.50:1\s+BELOW AA/u);
  assert.match(formatThemeResolve({ ...selected.json, schemes: [] }), /brand-text\/rest.+BELOW AA/u);
});

test("huge selected names keep every indexed pair and the 24 KiB allowance inside the Actions bound", async (context) => {
  const longName = "z".repeat(20_000);
  const site = await workspace(context, ({ lightTheme, darkTheme }) => {
    lightTheme.tones = { ...lightTheme.tones, "mid-band": 0.55 };
    lightTheme.semanticMappings.background = { source: "primary", lightness: "tone:mid-band" };
    lightTheme.explicitMappingTokens = [...lightTheme.explicitMappingTokens, "background"];
    for (const theme of [lightTheme, darkTheme]) {
      theme.contexts = { [longName]: {} };
      for (let index = 0; index < 127; index += 1) {
        theme.contexts[`z${String(index).padStart(3, "0")}-${"x".repeat(95)}`] = { canvas: "primary" };
      }
    }
  });
  await chromeWorkspace(site, {
    header: { context: longName, lightBrandColor: "#0000", headerPosition: "fixed", headerHeightMultiplier: "3.0" },
    footer: { context: longName },
    publishing: { allowSearch: true },
  });
  const output = path.join(site.root, "outputs");
  await writeFile(output, "");
  const { exitCode, stdout, json } = await resolveJson(site, [], { environment: { GITHUB_OUTPUT: output } });
  assert.equal(exitCode, 0);
  assert.ok(Buffer.byteLength(stdout.trim(), "utf8") <= LIMITS.githubOutputBytes);
  assert.ok((await readFile(output, "utf8")).includes(stdout.trim()));
  assert.deepEqual(Object.keys(json.chrome), ["light", "dark"]);
  for (const entries of Object.values(json.chrome)) {
    assert.deepEqual(entries.map(({ role }) => role), ["header", "footer"]);
    for (const entry of entries) {
      assert.deepEqual(
        [entry.context, entry.contextTruncated, entry.contextLength],
        [longName.slice(0, 128), true, longName.length],
      );
      assert.ok(entry.pairs.length > 0);
      assert.ok(entry.pairs.every((row) => decodeChromePair(json.chromeCatalog, row).element.length > 0));
    }
  }
  const legacy = await resolveThemePair(site.settings.lightTheme, site.settings.darkTheme);
  const allSurfaces = legacy.schemes.flatMap(({ scheme, surfaces }) => surfaces.map((surface) => ({ scheme, surface })));
  const legacyFloor = withinByteBudget(allSurfaces, 24 * 1024);
  const shown = json.schemes.flatMap(({ scheme, surfaces }) => surfaces.map((surface) => ({ scheme, surface })));
  assert.ok(legacyFloor.length > 1);
  assert.deepEqual(shown.slice(0, legacyFloor.length), legacyFloor);
  const chromeCount = Object.values(json.chrome).flat().reduce((total, entry) => total + entry.pairs.length, 0);
  const retainedFlags = Object.entries(json.chrome).flatMap(([scheme, surfaces]) => surfaces.flatMap(({ role }) =>
    chromePairs(json, scheme, role))).filter(({ ratio, required }) => ratio < required);
  assert.equal(json.contrast.pairs, legacy.contrast.pairs + chromeCount);
  assert.equal(json.contrast.belowAa, legacy.contrast.belowAa + retainedFlags.length);
  assert.equal(json.contexts.truncated, true);
  assert.equal(json.flags.truncated, true);
  assert.equal(json.omittedSurfaces.truncated, true);
});

test("resolves the released disclosure, hover bar, and context-specific button shadow", async (context) => {
  const site = await workspace(context, ({ lightTheme, darkTheme }) => {
    lightTheme.contexts["shadow-test"] = {};
    darkTheme.contexts["shadow-test"] = { lightness: { raised2: 0.28, shadow: 0.76 } };
  });
  const { navItems } = await chromeWorkspace(site, {
    header: { context: "shadow-test", showThemeToggle: false },
    publishing: { allowSearch: false },
  });
  const draft = navItems[0];
  const button = navItems.find(({ appearance }) => appearance === "NAV_ITEM_APPEARANCE_BUTTON");
  const manifestPath = path.join(site.root, "site", ".taproot-site-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.pages.find(({ resourceId }) => resourceId === draft.resourceId).status = "PAGE_STATUS_DRAFT";
  const group = {
    id: "a0000000-0000-4000-8000-0000000000e0", kind: "NAV_ITEM_KIND_GROUP_HEADER", title: "More",
    children: [{
      id: "a0000000-0000-4000-8000-0000000000e1", kind: "NAV_ITEM_KIND_EXTERNAL_URL",
      title: "Guide", externalUrl: "https://example.test/guide",
    }],
  };
  await Promise.all([
    writeFile(manifestPath, JSON.stringify(manifest)),
    writeFile(path.join(site.root, "site", "nav.json"), JSON.stringify({ siteId: site.siteId, navItems: [draft, button, group] })),
  ]);

  const themed = await resolveJson(site, ["--scheme", "dark", "--context", "shadow-test"]);
  assert.equal(themed.exitCode, 0, themed.stderr);
  const painted = chromePairs(themed.json, "dark", "header");
  const restDisclosure = painted.find(({ element, state }) => element === "nav-group-disclosure" && state === "rest");
  assert.deepEqual([restDisclosure.foreground, restDisclosure.background, restDisclosure.required], ["text", "layer2", 3]);
  assert.ok(restDisclosure.ratio > 3);
  const hoverBar = painted.find(({ element }) => element === "nav-hover-indicator");
  assert.deepEqual(hoverBar, {
    element: "nav-hover-indicator", foreground: "headingsHover", background: "layer2", state: "hover", kind: "graphic",
    ratio: 12.45, required: 3,
  });
  assert.ok(painted.some(({ element }) => element.startsWith("burger")));
  assert.ok(painted.every(({ element }) => !element.startsWith("search") && !element.startsWith("theme-toggle")));
  const shadow = (pairs) => pairs.find(({ element, kind, state }) => element === "nav-button" && kind === "ring" && state === "focus");
  assert.deepEqual(shadow(painted), {
    element: "nav-button", foreground: "button-focus-shadow", background: "layer2", state: "focus", kind: "ring",
    ratio: 2.44, required: 3,
  });
  const headerPath = path.join(site.root, "site", "settings", "site-header.json");
  const header = JSON.parse(await readFile(headerPath, "utf8"));
  header.settings.context = "";
  await writeFile(headerPath, JSON.stringify(header));

  const root = await resolveJson(site, ["--scheme", "dark"]);
  assert.equal(root.exitCode, 0, root.stderr);
  assert.equal(shadow(chromePairs(root.json, "dark", "header")).ratio, 3.39);
});

test("measures root chrome and applies the text threshold to visible footer group headings", async (context) => {
  const site = await workspace(context, ({ lightTheme }) => {
    lightTheme.tones["group-heading"] = 0.552;
    lightTheme.semanticMappings.headings = { source: "anchor:root", lightness: "tone:group-heading" };
    lightTheme.explicitMappingTokens.push("headings");
  });
  await chromeWorkspace(site, { footer: { asideHeadingContent: { paragraphs: [] } } });
  const enabled = await resolveJson(site);
  assert.equal(enabled.exitCode, 0, enabled.stderr);
  for (const cards of Object.values(enabled.json.chrome)) {
    assert.deepEqual(cards.map(({ role, context: name }) => [role, name]), [["header", null], ["footer", null]]);
  }
  const heading = chromePairs(enabled.json, "light", "footer").find(({ element }) => element === "footer-heading");
  assert.deepEqual(heading, {
    element: "footer-heading", foreground: "headings", background: "layer2", state: "rest", kind: "text", ratio: 3.5,
    required: 4.5,
  });
  assert.ok(enabled.json.flags.items.some(({ element, role, scheme, required }) =>
    element === heading.element && role === "footer" && scheme === "light" && required === 4.5));

  await chromeWorkspace(site, { header: { showBrandText: false }, footer: { enabled: false, context: "raised" } });
  const disabled = await resolveJson(site);
  assert.equal(disabled.exitCode, 0, disabled.stderr);
  for (const scheme of ["light", "dark"]) {
    assert.deepEqual(disabled.json.chrome[scheme].map(({ role }) => role), ["header"]);
    assert.ok(chromePairs(disabled.json, scheme, "header").every(({ element }) => element !== "brand-text"));
  }
});

test("resolve keeps the base report when optional appearance or the chrome fit is unavailable", async (context) => {
  const site = await workspace(context);
  await chromeWorkspace(site, { header: { showBrandText: "invalid" }, publishing: { allowSearch: true } });
  const optional = await resolveJson(site);
  assert.equal(optional.exitCode, 0);
  assert.deepEqual(optional.json.chrome.light.map(({ role }) => role), ["footer"]);
  const handlers = {
    "theme resolve": (invocation) => themeResolve(invocation, { loadFit: async () => { throw new Error("unavailable"); } }),
  };
  const unavailable = await resolveJson(site, ["--scheme", "dark"], { handlers });
  assert.equal(unavailable.exitCode, 0);
  assert.equal(unavailable.json.chromeUnavailable, true);
  assert.deepEqual(unavailable.json.chrome, { dark: [] });
  assert.match(formatThemeResolve(unavailable.json), /theme report was unavailable/u);
  assert.match(formatThemeResolve(unavailable.json), /measured pairs/u);
});

const LIVE_NAVIGATION_REVISION = "e".repeat(64);
const liveCases = [
  { name: "current content capability", surface: SURFACE_STANDARD, capabilities: [CAPABILITY_CONTENT], get: true, nav: true },
  { name: "design-only capability", surface: SURFACE_STANDARD, capabilities: [CAPABILITY_DESIGN] },
  { name: "Docs surface", surface: SURFACE_DOCS_PRESENTATION, capabilities: [CAPABILITY_CONTENT] },
  { name: "unknown direct-key grant", surface: SURFACE_STANDARD },
  { name: "failed optional read", surface: SURFACE_STANDARD, capabilities: [CAPABILITY_CONTENT], get: true, failure: true },
  { name: "malformed list", surface: SURFACE_STANDARD, capabilities: [CAPABILITY_CONTENT], get: true, answer: { navItems: {} } },
  { name: "missing revision", surface: SURFACE_STANDARD, capabilities: [CAPABILITY_CONTENT], get: true, answer: { revision: "" } },
  { name: "empty ProtoJSON tree", surface: SURFACE_STANDARD, capabilities: [CAPABILITY_CONTENT], get: true, empty: true },
];
for (const scenario of liveCases) {
  test(`site chrome navigation uses ${scenario.name} without widening the grant`, async (context) => {
    const site = await workspace(context, ({ lightTheme }) => {
      lightTheme.tones["ember-deep"] = 0.6;
    });
    const { headerSettings, sitePublishingPreferences, navItems } = await chromeWorkspace(site);
    await rm(path.join(site.root, "site"), { recursive: true });
    await rm(path.join(site.root, "taproot-site.json"));
    const presentation = {
      siteId: site.siteId,
      revision: "c".repeat(64),
      styleSettings: {
        ...site.settings,
        lightTheme: encodeTheme(site.settings.lightTheme),
        darkTheme: encodeTheme(site.settings.darkTheme),
      },
      headerSettings,
      sitePublishingPreferences,
    };
    const reads = [];
    const resolvedSession = {
      siteId: site.siteId,
      surface: scenario.surface,
      ...(scenario.capabilities === undefined ? {} : { exchanged: { capabilities: scenario.capabilities } }),
      onProgress: () => {},
      client: {
        async request(resource) {
          reads.push(resource);
          if (resource.endsWith("/presentation")) return presentation;
          if (scenario.failure) throw new Error("optional read failed");
          return {
            revision: LIVE_NAVIGATION_REVISION,
            ...(scenario.empty ? {} : { navItems }),
            ...scenario.answer,
          };
        },
      },
    };
    const handlers = { "theme resolve": (invocation) => {
      assert.deepEqual(invocation.capabilities, [CAPABILITY_DESIGN]);
      return themeResolve({ ...invocation, resolvedSession });
    } };
    const result = await resolveJson(site, ["--site"], { handlers });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.json.source, "site");
    assert.deepEqual(reads, [
      `v1/sites/${site.siteId}/presentation`,
      ...(scenario.get ? [`v1/sites/${site.siteId}/navigation?environment=SITE_ENVIRONMENT_DRAFT`] : []),
    ]);
    assert.equal(result.json.chromeNavigationUnavailable, scenario.nav || scenario.empty ? undefined : true);
    const button = chromePairs(result.json, "light", "header").filter(({ element }) => element === "nav-button");
    assert.equal(button.length > 0, scenario.nav === true);
    if (scenario.nav) {
      const rest = button.find(({ state }) => state === "rest");
      const hover = button.find(({ state }) => state === "hover");
      assert.ok(rest.ratio >= rest.required);
      assert.ok(hover.ratio < hover.required);
      assert.ok(result.json.flags.items.some(({ element, state, scheme }) =>
        element === "nav-button" && state === "hover" && scheme === "light"));
    }
    if (!scenario.nav && !scenario.empty) assert.match(formatThemeResolve(result.json), /Navigation contrast was not checked/u);
  });
}

test("the verb asks for what theme push reads and nothing else, and is listed in the help", async () => {
  assert.deepEqual(VERB_CAPABILITIES["theme resolve"], VERB_CAPABILITIES["theme push"]);
  assert.equal(VERB_SURFACES["theme resolve"], VERB_SURFACES["theme push"]);

  const overview = sink();
  assert.equal(await runCli({ arguments_: ["--help"], stdout: overview, stderr: sink() }), 0);
  assert.match(overview.read(), /^ {2}theme resolve +Print the colors Espalier compiles/mu);

  const verbHelp = sink();
  assert.equal(await runCli({ arguments_: ["theme", "resolve", "--help"], stdout: verbHelp, stderr: sink() }), 0);
  for (const expected of [
    "--scheme <light|dark>",
    "--context <name>",
    "--site",
    "--json",
    "theme.contrast_text_below_aa",
    "omittedSurfaces",
  ]) {
    assert.ok(verbHelp.read().includes(expected), expected);
  }

  const reference = sink();
  assert.equal(await runCli({ arguments_: ["help", "theme", "--json"], stdout: reference, stderr: sink() }), 0);
  assert.ok(
    JSON.parse(reference.read()).reference.workflow.some((step) => step.includes("taproot-site theme resolve")),
  );
  const walkthrough = sink();
  assert.equal(await runCli({ arguments_: ["help", "walkthrough", "--json"], stdout: walkthrough, stderr: sink() }), 0);
  assert.ok(walkthrough.read().includes("theme resolve"));
});
