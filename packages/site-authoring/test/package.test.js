import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  assert.deepEqual(packageJson.files, ["bin/", "src/", "LICENSE", "README.md"]);
  assert.deepEqual(packageJson.scripts, { test: "node --test", prepack: "npm test" });
  // Exact, not a range: the CLI validates against one Espalier theme contract,
  // and the release manifest's identity gate refuses anything else.
  assert.deepEqual(packageJson.dependencies, { "@taprootio/espalier": "4.4.0" });
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
    "src/cli.js",
    "src/config.js",
    "src/constants.js",
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
    "src/footer-contract.js",
    "src/footer-draft-hash.js",
    "src/footer-workspace.js",
    "src/image-metadata.js",
    "src/index.js",
    "src/json-guard.js",
    "src/output.js",
    "src/presentation-reference.js",
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
    "src/verbs/sites.js",
    "src/verbs/status.js",
    "src/verbs/theme-push.js",
    "src/verbs/use.js",
    "src/verbs/validate.js",
    "src/verbs/whoami.js",
    "src/workspace.js",
  ]);
});
