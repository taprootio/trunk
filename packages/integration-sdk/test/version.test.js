import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { INTEGRATION_SDK_VERSION } from "../src/constants.js";

// taproot-allow-source-read: The declaration and install command are public release-version contracts.

// The constant ships inside the tarball, so a bump that misses it publishes a
// package that reports the previous version (TR00953 found exactly that).
test("the SDK runtime, declaration and install help agree with its package version", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(INTEGRATION_SDK_VERSION, manifest.version);
  assert.ok(readFileSync(join(root, "index.d.ts"), "utf8").includes(
    `export const INTEGRATION_SDK_VERSION: "${manifest.version}";`,
  ));
  assert.ok(readFileSync(join(root, "README.md"), "utf8").includes(
    `npm install @taprootio/integration-sdk@${manifest.version}`,
  ));
});
