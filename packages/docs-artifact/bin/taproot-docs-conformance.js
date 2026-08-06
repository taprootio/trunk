#!/usr/bin/env node

import { validateArtifact } from "../src/artifact-validator.js";
import { loadConformanceCases } from "../src/conformance.js";

let failed = false;
for (const fixture of await loadConformanceCases()) {
  const result = await validateArtifact(fixture.manifest, fixture.files);
  const codes = result.ok ? [] : [...new Set(result.errors.map((error) => error.code))].sort();
  const expected = [...fixture.expectedCodes].sort();
  if (result.ok !== fixture.valid || JSON.stringify(codes) !== JSON.stringify(expected)) {
    failed = true;
    process.stderr.write(`${fixture.name}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(codes)}\n`);
  }
}
if (failed) {
  process.exitCode = 1;
} else {
  process.stdout.write("Taproot Docs artifact conformance fixtures passed.\n");
}
