import assert from "node:assert/strict";
import test from "node:test";
import { validateArtifact } from "../src/artifact-validator.js";
import { loadConformanceCases } from "../src/conformance.js";

test("published conformance cases produce their exact stable error codes", async (testContext) => {
  for (const fixture of await loadConformanceCases()) {
    await testContext.test(fixture.name, async () => {
      const result = await validateArtifact(fixture.manifest, fixture.files);
      const codes = result.ok ? [] : [...new Set(result.errors.map((error) => error.code))].sort();
      assert.equal(result.ok, fixture.valid);
      assert.deepEqual(codes, [...fixture.expectedCodes].sort());
    });
  }
});
