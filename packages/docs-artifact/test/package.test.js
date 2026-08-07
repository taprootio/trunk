import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageDirectory = new URL("../", import.meta.url);
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const EXPECTED_PACKAGE_FILES = [
  "LICENSE",
  "README.md",
  "bin/taproot-docs-conformance.js",
  "bin/taproot-docs-validate.js",
  "conformance.d.ts",
  "fixtures/README.md",
  "fixtures/conformance.json",
  "fixtures/invalid/duplicate-json-key.json",
  "fixtures/invalid/hash-drift/taproot-docs/fragments/welcome.html",
  "fixtures/invalid/size-drift/taproot-docs/fragments/welcome.html",
  "fixtures/invalid/unsafe-markup/taproot-docs/fragments/welcome.html",
  "fixtures/valid/complete/taproot-docs-manifest.json",
  "fixtures/valid/complete/taproot-docs/assets/pixel.png.base64",
  "fixtures/valid/complete/taproot-docs/fragments/button.en-us.html",
  "fixtures/valid/complete/taproot-docs/fragments/button.fr-fr.html",
  "fixtures/valid/complete/taproot-docs/fragments/getting-started.en-us.html",
  "fixtures/valid/complete/taproot-docs/fragments/getting-started.fr-fr.html",
  "fixtures/valid/minimal/taproot-docs-manifest.json",
  "fixtures/valid/minimal/taproot-docs/fragments/welcome.html",
  "index.d.ts",
  "node.d.ts",
  "package.json",
  "schema/taproot-docs-manifest.schema.json",
  "src/artifact-validator.js",
  "src/binary.js",
  "src/conformance.js",
  "src/constants.js",
  "src/errors.js",
  "src/index.js",
  "src/json.js",
  "src/manifest-validator.js",
  "src/markup.js",
  "src/node-internal.js",
  "src/node.js",
  "src/path.js",
  "src/text.js",
].sort();

test("npm package contains exactly the reviewed public contract files", async (testContext) => {
  const npmCache = await mkdtemp(path.join(os.tmpdir(), "taproot-docs-npm-cache-"));
  testContext.after(() => rm(npmCache, { recursive: true, force: true }));
  const { stdout } = await execFileAsync(
    npmExecutable,
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: packageDirectory,
      env: { ...process.env, npm_config_cache: npmCache },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const packResult = JSON.parse(stdout);
  // Keep this npm 11/12 shape handling aligned with npmPackIntegrity in the
  // release repository's scripts/npm-release-guard.mjs.
  let packs = [];
  if (Array.isArray(packResult)) {
    packs = packResult;
  } else if (packResult !== null && typeof packResult === "object") {
    packs = Object.values(packResult);
  }

  assert.equal(packs.length, 1);
  assert.deepEqual(
    packs[0].files.map((file) => file.path).sort(),
    EXPECTED_PACKAGE_FILES,
  );
});
