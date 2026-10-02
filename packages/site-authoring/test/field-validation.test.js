import assert from "node:assert/strict";
import test from "node:test";
import schema from "../src/field-schema.json" with { type: "json" };
import { validateDefinition, validateSubmission } from "../src/field-validation.js";

test("the packaged field validation loads and validates", () => {
  const definition = { fields: [{ id: "email", type: "email", label: "Email", required: true }], contact_field: "email" };
  assert.deepEqual(validateDefinition(definition), []);
  assert.deepEqual(validateSubmission(definition, {}, { today: "2026-06-15" }), [{ field: "email", code: "required" }]);
  assert.equal(schema.properties.fields.maxItems, 30);
});
