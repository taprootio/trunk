import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { encodeTheme, SEMANTIC_COLOR_NAMES, TOKEN_PAIRINGS } from "@taprootio/espalier/shared/theme";

import { runCli, VERB_CAPABILITIES, VERB_SURFACES } from "../src/cli.js";
import { LIMITS } from "../src/constants.js";

const EXAMPLE_STYLES = new URL("../examples/riverbend-wellness/settings/taproot-styles.json", import.meta.url);
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
async function run(site, arguments_, { environment = {}, fetch } = {}) {
  const stdout = sink();
  const stderr = sink();
  const calls = [];
  const exitCode = await runCli({
    arguments_,
    cwd: site.root,
    environment: { HOME: site.root, XDG_CONFIG_HOME: path.join(site.root, "config"), ...environment },
    stdout,
    stderr,
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
