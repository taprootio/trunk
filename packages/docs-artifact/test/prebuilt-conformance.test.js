import assert from "node:assert/strict";
import test from "node:test";
import { loadPrebuiltConformanceCases, validatePrebuiltConformanceCase } from "../src/prebuilt-conformance.js";

test("published prebuilt conformance cases produce their exact stable error codes", async (testContext) => {
  for (const fixture of await loadPrebuiltConformanceCases()) {
    await testContext.test(fixture.name, async () => {
      const result = await validatePrebuiltConformanceCase(fixture);
      const codes = result.ok ? [] : [...new Set(result.errors.map((error) => error.code))].sort();
      assert.equal(result.ok, fixture.valid);
      assert.deepEqual(codes, [...fixture.expectedCodes].sort());
    });
  }
});
