import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ARTIFACT_PACKAGE_VERSION, PUBLISHER_VERSION } from "../src/constants.js";

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

test("accepts one npm 11 array or npm 12 keyed-object pack result", () => {
  const pack = { files: [{ path: "second" }, { path: "first" }] };
  assert.deepEqual(packedFiles(JSON.stringify([pack])), ["first", "second"]);
  assert.deepEqual(packedFiles(JSON.stringify({ "package.tgz": pack })), ["first", "second"]);
  assert.throws(() => packedFiles(JSON.stringify({ first: pack, second: pack })));
});

test("package metadata preserves independent identity, exact artifact pin, and public provenance", () => {
  const packageJson = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
  assert.equal(packageJson.name, "@taprootio/docs-publisher");
  assert.equal(packageJson.version, "1.2.0");
  assert.equal(packageJson.dependencies["@taprootio/docs-artifact"], "1.1.0");
  assert.equal(PUBLISHER_VERSION, packageJson.version);
  assert.equal(ARTIFACT_PACKAGE_VERSION, packageJson.dependencies["@taprootio/docs-artifact"]);
  assert.deepEqual(packageJson.bin, { taproot: "./bin/taproot.js" });
  assert.deepEqual(packageJson.repository, {
    type: "git",
    url: "https://github.com/taprootio/trunk.git",
    directory: "packages/docs-publisher",
  });
  assert.deepEqual(packageJson.publishConfig, { access: "public", provenance: true });
});

test("npm package contains only the reviewed runtime and declaration surface", (testContext) => {
  const npmCache = mkdtempSync(path.join(os.tmpdir(), "taproot-docs-publisher-npm-cache-"));
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
    "LICENSE",
    "README.md",
    "bin/taproot.js",
    "index.d.ts",
    "package.json",
    "src/abort.js",
    "src/archive.js",
    "src/artifact.js",
    "src/cli.js",
    "src/config.js",
    "src/constants.js",
    "src/errors.js",
    "src/github-main-head.js",
    "src/index.js",
    "src/output.js",
    "src/publish.js",
    "src/transport.js",
  ]);
});
