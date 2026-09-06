import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CLI_NAME, CLI_VERSION } from "../src/constants.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function packedFiles(output) {
  const packResult = JSON.parse(output);
  let packs = [];
  if (Array.isArray(packResult)) {
    packs = packResult;
  } else if (packResult !== null && typeof packResult === "object") {
    packs = Object.values(packResult);
  }
  assert.equal(packs.length, 1);
  assert.ok(Array.isArray(packs[0].files));
  return packs[0].files.map((file) => file.path).sort();
}

test("package metadata pins the repo Node baseline, the shared theme contract, and the public release identity", () => {
  const packageJson = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
  assert.equal(packageJson.name, CLI_NAME);
  assert.equal(packageJson.version, CLI_VERSION);
  assert.equal(packageJson.type, "module");
  // The repo baseline, deliberately not docs-publisher's `>=24 <25`: nothing
  // in the authoring verbs needs Node 24, and pinning it would put Node 24
  // back on the agent's path.
  assert.deepEqual(packageJson.engines, { node: ">=22" });
  assert.deepEqual(packageJson.bin, { "taproot-site": "./bin/taproot-site.js" });
  // examples/ ships because the README's credential-free first command points
  // at it: a global install with nothing pulled has no other fixture to
  // validate (TR00647).
  assert.deepEqual(packageJson.files, ["bin/", "examples/", "src/", "LICENSE", "README.md"]);
  assert.deepEqual(packageJson.scripts, { test: "node --test", prepack: "npm test" });
  // Exact, not a range: the CLI validates against one Espalier theme contract,
  // and the release manifest's identity gate refuses anything else.
  assert.deepEqual(packageJson.dependencies, { "@taprootio/espalier": "4.8.0" });
  assert.equal(packageJson.devDependencies, undefined);
  // The public release identity (TR00635). The Trunk stager refuses a package
  // without public access, provenance, and the public repository pointer, and
  // the pointer names the public mirror rather than the private source.
  assert.deepEqual(packageJson.repository, {
    type: "git",
    url: "https://github.com/taprootio/trunk.git",
    directory: "packages/site-authoring",
  });
  assert.deepEqual(packageJson.publishConfig, { access: "public", provenance: true });
  // An owner authorizes the CLI directly since TR00634; the description must
  // not still describe it as a key-only tool.
  assert.doesNotMatch(packageJson.description, /key-authorized/u);
});

test("the packaged surface is exactly the reviewed runtime", (testContext) => {
  const npmCache = mkdtempSync(path.join(os.tmpdir(), "taproot-site-npm-cache-"));
  testContext.after(() => rmSync(npmCache, { recursive: true, force: true }));
  const output = execFileSync(
    "npm",
    ["pack", "--json", "--dry-run", "--ignore-scripts"],
    {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: npmCache },
    },
  );
  assert.deepEqual(packedFiles(output), [
    // The npm package page and the license text the ISC declaration promises.
    "LICENSE",
    "README.md",
    "bin/taproot-site.js",
    // The complete offline fixture the README's first command validates and
    // 'help fixture' locates (TR00647). About 28 KB unpacked, 17 KB of it the
    // light and dark theme pair in taproot-styles.json.
    "examples/riverbend-wellness/manifest.fixture.json",
    "examples/riverbend-wellness/nav.json",
    "examples/riverbend-wellness/pages/index.md",
    "examples/riverbend-wellness/pages/visit.md",
    "examples/riverbend-wellness/redirects.json",
    "examples/riverbend-wellness/settings/brand.json",
    "examples/riverbend-wellness/settings/site-header.json",
    "examples/riverbend-wellness/settings/site-publishing-preferences.json",
    "examples/riverbend-wellness/settings/taproot-styles.json",
    "package.json",
    // The verb-support modules TR00604 S2 added alongside the S1 foundation:
    // wire vocabulary, the image header sniffer, session/result shaping, the
    // covered settings catalog, and the workspace and its manifests.
    "src/api.js",
    "src/appearance-contract.js",
    // The one durable single-file write (TR00645), shared by the workspace and
    // the credential store so the fsync/rename discipline exists once.
    "src/atomic-file.js",
    "src/bounded-file.js",
    "src/capabilities.js",
    // The version comparison and offline refusal the latest-only gate needs
    // (TR00703). Its own module rather than a corner of constants.js: the store
    // and three verbs all read it, and none of them owns it.
    "src/cli-release.js",
    "src/cli.js",
    "src/config.js",
    "src/constants.js",
    // The one outbound-target rule the footer and the navigation share
    // (TR00704): absolute credential-free http/https, or a mailto/tel contact.
    "src/contact-url.js",
    // The content pipeline: the validation the server does not perform, the
    // Markdown converter, and the byte-parity copy of the canonical renderer.
    "src/content/components.js",
    "src/content/free-form-section-registry.json",
    "src/content/free-form-sections.js",
    "src/content/index.js",
    "src/content/inline-facts.js",
    "src/content/markdown.js",
    "src/content/tiptap-prosemirror.ts",
    "src/content/validate-document.js",
    "src/content/vocabulary.js",
    // The browser sign-in flow TR00634 added and TR00645 made account-level:
    // the credential store that lives outside every repository, and the verbs
    // that manage it and the site selection it enables.
    "src/credentials.js",
    "src/errors.js",
    // The one home for the offline fixture contract: validate enforces it and
    // 'help fixture' states it from the same constants (TR00647).
    "src/fixture-contract.js",
    "src/footer-contract.js",
    "src/footer-draft-hash.js",
    "src/footer-workspace.js",
    "src/image-metadata.js",
    "src/index.js",
    "src/json-guard.js",
    "src/json-path-diff.js",
    "src/output.js",
    "src/presentation-reference.js",
    "src/redirects-contract.js",
    "src/redirects-workspace.js",
    "src/reference-help.js",
    "src/session.js",
    "src/settings-catalog.js",
    "src/settings.js",
    "src/theme-validation.js",
    "src/transport.js",
    "src/verbs/approve.js",
    "src/verbs/deploy.js",
    "src/verbs/env.js",
    "src/verbs/footer-push.js",
    "src/verbs/index.js",
    "src/verbs/login.js",
    "src/verbs/logout.js",
    "src/verbs/media-upload.js",
    "src/verbs/nav-push.js",
    "src/verbs/pages-push.js",
    "src/verbs/preview-page.js",
    "src/verbs/preview-revoke.js",
    "src/verbs/pull.js",
    "src/verbs/redirects-pull.js",
    "src/verbs/redirects-push.js",
    "src/verbs/sites.js",
    "src/verbs/status.js",
    "src/verbs/theme-push.js",
    "src/verbs/use.js",
    "src/verbs/validate.js",
    "src/verbs/whoami.js",
    "src/workspace.js",
  ]);
});

/**
 * An installed copy whose `examples/` directory is gone (TR00647).
 *
 * `examples/` ships, but `node_modules` pruners and image-slimming steps drop
 * example directories by default, so nothing on a verb's module-load path may
 * depend on it.
 *
 * The copy sits inside the package rather than in `os.tmpdir()` so it resolves
 * its dependencies through this checkout's own `node_modules` chain, whether
 * npm installed them beside the package (the monorepo) or hoisted them to a
 * workspace root (the public Trunk tree). `src/` is copied rather than
 * symlinked because Node resolves symlinks before it computes
 * `import.meta.url`, so a linked `src/` would still find the real `examples/`.
 */
function prunedInstall(testContext) {
  const root = mkdtempSync(path.join(PACKAGE_ROOT, ".pruned-install-"));
  testContext.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ["bin", "src", "package.json"]) {
    cpSync(path.join(PACKAGE_ROOT, entry), path.join(root, entry), { recursive: true });
  }
  return root;
}

function runPruned(root, arguments_) {
  return execFileSync(process.execPath, [path.join(root, "bin", "taproot-site.js"), ...arguments_], {
    cwd: root,
    encoding: "utf8",
  });
}

test("an installed copy pruned of examples/ still runs every verb and degrades only 'help fixture'", (testContext) => {
  const root = prunedInstall(testContext);

  // The whole CLI loads. A static import of the shipped manifest fails here
  // with ERR_MODULE_NOT_FOUND before any verb can run, which is the failure
  // this case exists to catch; execFileSync throws on a non-zero exit.
  assert.equal(runPruned(root, ["--version"]).trim(), CLI_VERSION);
  // A second workflow topic, whose example is a literal in the source, renders
  // unchanged: the degradation is scoped to the shipped file.
  assert.ok(runPruned(root, ["help", "nav"]).includes("\n\nExample:\n"));

  const fixtureHelp = runPruned(root, ["help", "fixture"]);
  assert.match(fixtureHelp, /^Offline fixture manifest contract/u);
  // The contract still arrives in full; only the example and the path to a
  // fixture that is no longer there are dropped.
  assert.ok(fixtureHelp.includes("Required root fields: "));
  assert.ok(fixtureHelp.includes("validate reads the fixture and writes nothing to it."));
  assert.ok(!fixtureHelp.includes("Example:"));
  assert.ok(!fixtureHelp.includes("Shipped example:"));

  const machineReadable = JSON.parse(runPruned(root, ["help", "fixture", "--json"]));
  assert.equal(machineReadable.reference.example, undefined);
  assert.equal(machineReadable.reference.fixtureDirectory, undefined);
  assert.ok(Array.isArray(machineReadable.reference.details));
});
