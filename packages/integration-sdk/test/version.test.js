import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { INTEGRATION_SDK_VERSION } from "../src/constants.js";

// The constant ships inside the tarball, so a bump that misses it publishes a
// package that reports the previous version (TR00953 found exactly that).
test("the exported SDK version matches package.json", () => {
  const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
  assert.equal(INTEGRATION_SDK_VERSION, manifest.version);
});
