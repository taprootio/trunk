#!/usr/bin/env node

import { validateArtifact } from "../src/artifact-validator.js";
import { loadConformanceCases } from "../src/conformance.js";
import { loadPrebuiltConformanceCases, validatePrebuiltConformanceCase } from "../src/prebuilt-conformance.js";

const arguments_ = process.argv.slice(2);
const modeIndex = arguments_.indexOf("--mode");
const mode = modeIndex === -1 ? "managed" : arguments_[modeIndex + 1];
const invalidArguments = modeIndex === -1
  ? arguments_.length !== 0
  : arguments_.length !== 2 || arguments_.filter((argument) => argument === "--mode").length !== 1;
if (!["managed", "prebuilt"].includes(mode) || invalidArguments) {
  process.stderr.write("Usage: taproot-docs-conformance [--mode managed|prebuilt]\n");
  process.exitCode = 2;
} else {
  const loadCases = mode === "prebuilt" ? loadPrebuiltConformanceCases : loadConformanceCases;
  let failed = false;
  for (const fixture of await loadCases()) {
    const result = mode === "prebuilt"
      ? await validatePrebuiltConformanceCase(fixture)
      : await validateArtifact(fixture.manifest, fixture.files);
    const codes = result.ok ? [] : [...new Set(result.errors.map((error) => error.code))].sort();
    const expected = [...fixture.expectedCodes].sort();
    if (result.ok !== fixture.valid || JSON.stringify(codes) !== JSON.stringify(expected)) {
      failed = true;
      process.stderr.write(
        `${fixture.name}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(codes)}\n`,
      );
    }
  }
  if (failed) {
    process.exitCode = 1;
  } else {
    process.stdout.write(
      mode === "prebuilt"
        ? "Taproot Docs prebuilt artifact conformance fixtures passed.\n"
        : "Taproot Docs artifact conformance fixtures passed.\n",
    );
  }
}
