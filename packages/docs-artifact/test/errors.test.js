import assert from "node:assert/strict";
import test from "node:test";
import { LIMITS } from "../src/constants.js";
import { DocsArtifactValidationError } from "../src/errors.js";

test("thrown diagnostics are normalized, escaped, and bounded", () => {
  const error = new DocsArtifactValidationError([{
    code: "test.hostile",
    path: `$["hostile\n\u202e${"😀".repeat(LIMITS.diagnosticPathScalars * 2)}"]`,
    message: `alarm\u0007\u0085\u2066${"😀".repeat(LIMITS.diagnosticMessageScalars * 2)}`,
  }]);
  const unsafe = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

  assert.ok(!unsafe.test(error.message));
  assert.ok(!unsafe.test(error.errors[0].path));
  assert.ok(!unsafe.test(error.errors[0].message));
  assert.ok([...error.errors[0].path].length <= LIMITS.diagnosticPathScalars);
  assert.ok(new TextEncoder().encode(error.errors[0].path).byteLength <= LIMITS.diagnosticPathBytes);
  assert.ok([...error.errors[0].message].length <= LIMITS.diagnosticMessageScalars);
  assert.ok(new TextEncoder().encode(error.errors[0].message).byteLength <= LIMITS.diagnosticMessageBytes);
  assert.ok([...error.message].length <= LIMITS.diagnosticAggregateScalars);
  assert.ok(new TextEncoder().encode(error.message).byteLength <= LIMITS.diagnosticAggregateBytes);
  assert.match(error.message, /\\u0007/);
  assert.match(error.message, /\\u202e/);
});
