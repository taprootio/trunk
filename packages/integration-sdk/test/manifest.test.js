import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateFragment, validateManifest } from "../src/index.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SCHEMA_BYTES = 64 * 1024;
const error = (field, code) => ({ ok: false, errors: [{ field, code }] });

async function validManifest() {
  return JSON.parse(await readFile(new URL("../fixtures/manifest.valid.json", import.meta.url), "utf8"));
}

function manifestWithSchema(configSchema) {
  return {
    slug: "schema-boundary",
    displayName: "Schema Boundary",
    webhookEndpointUrl: "https://receiver.example.test/webhooks",
    settingsUrl: "https://receiver.example.test/settings",
    requestedCapabilities: [],
    offeredComponents: [{ id: "component", name: "Component", configSchema }],
    externalScriptOrigins: [],
    defaultPublishPolicy: "stage",
    recommendedUninstallDisposition: "freeze",
    contractVersion: "1",
    pricingOptions: [{ id: "free", version: "1", quantityMin: 1, quantityMax: null, cadence: "free", catalogueItemKey: null }],
  };
}

function schemaAtUtf8Size(size) {
  const schema = {
    type: "object",
    properties: Object.fromEntries(Array.from({ length: 4 }, (_, property) => [
      `field${property}`,
      { type: "string", enum: Array.from({ length: 64 }, () => "x".repeat(256)) },
    ])),
  };
  let surplus = new TextEncoder().encode(JSON.stringify(schema)).length - size;
  for (const property of Object.values(schema.properties)) {
    for (let index = 0; index < property.enum.length && surplus > 0; index++) {
      const trim = Math.min(surplus, property.enum[index].length - 1);
      property.enum[index] = property.enum[index].slice(0, -trim);
      surplus -= trim;
    }
  }
  assert.equal(surplus, 0);
  assert.equal(new TextEncoder().encode(JSON.stringify(schema)).length, size);
  return schema;
}

test("published valid manifest conforms to the public bounded validator", async () => {
  const manifest = await validManifest();
  const result = validateManifest(manifest);
  assert.deepEqual(result, { ok: true, value: manifest });
});

test("manifest rejects a capability outside the shipped installation scope", async () => {
  const manifest = await validManifest();
  manifest.requestedCapabilities.push("sites.delete_any");
  const result = validateManifest(manifest);
  assert.deepEqual(result, { ok: false, errors: [{ field: "requestedCapabilities", code: "unavailable_capability" }] });
});

test("manifest byte limits apply to raw JSON and object inputs", async () => {
  const raw = " ".repeat(MAX_MANIFEST_BYTES + 1);
  const object = await validManifest();
  object.description = "x".repeat(MAX_MANIFEST_BYTES);

  assert.deepEqual(validateManifest(raw), error("$", "size_exceeded"));
  assert.deepEqual(validateManifest(object), error("$", "size_exceeded"));
});

test("manifest returns bounded schema failures for malformed object inputs", () => {
  const cyclic = { type: "object" };
  cyclic.properties = { self: cyclic };

  for (const configSchema of [undefined, { type: "string", enum: [1n] }, cyclic]) {
    assert.deepEqual(validateManifest(manifestWithSchema(configSchema)), error("offeredComponents[0]", "invalid_schema"));
  }
});

test("manifest schema bounds use UTF-8 bytes and keep the exact accepted boundary", () => {
  const accepted = manifestWithSchema(schemaAtUtf8Size(MAX_SCHEMA_BYTES));
  const rejected = manifestWithSchema(schemaAtUtf8Size(MAX_SCHEMA_BYTES + 1));
  const unicodeOversized = {
    type: "object",
    properties: Object.fromEntries(["first", "second"].map((name) => [
      name,
      { type: "string", enum: Array.from({ length: 64 }, () => "😀".repeat(128)) },
    ])),
  };

  assert.equal(new TextEncoder().encode(JSON.stringify(unicodeOversized)).length > MAX_SCHEMA_BYTES, true);
  assert.equal(JSON.stringify(unicodeOversized).length < MAX_SCHEMA_BYTES, true);
  assert.equal(validateManifest(accepted).ok, true);
  assert.deepEqual(validateManifest(rejected), error("offeredComponents[0]", "invalid_schema"));
  assert.deepEqual(validateManifest(manifestWithSchema(unicodeOversized)), error("offeredComponents[0]", "invalid_schema"));
});

test("raw JSON duplicate keys are rejected at root, component, and schema object boundaries", async () => {
  const manifest = await validManifest();
  const raw = JSON.stringify(manifest);
  const component = `[{"id":"first","id":"second","name":"Component","configSchema":{"type":"string"}}]`;
  const schema = `[{"id":"component","name":"Component","configSchema":{"type":"string","type":"string"}}]`;

  assert.deepEqual(validateManifest(raw.replace('"slug":"fixture-fitness"', '"slug":"duplicate","slug":"fixture-fitness"')), error("$", "unknown_property"));
  assert.deepEqual(validateManifest(raw.replace('"offeredComponents":[]', `"offeredComponents":${component}`)), error("offeredComponents[0]", "unknown_property"));
  assert.deepEqual(validateManifest(raw.replace('"offeredComponents":[]', `"offeredComponents":${schema}`)), error("offeredComponents[0]", "unknown_property"));
});

test("priced catalogue item keys retain the server's 128-character bound", async () => {
  const atLimit = await validManifest();
  const overLimit = await validManifest();
  const key = "a".repeat(128);
  const pricingOption = { id: "paid", version: "1", quantityMin: 1, quantityMax: null, cadence: "monthly", catalogueItemKey: key };

  atLimit.pricingOptions = [pricingOption];
  overLimit.pricingOptions = [{ ...pricingOption, catalogueItemKey: `${key}a` }];

  assert.equal(validateManifest(atLimit).ok, true);
  assert.deepEqual(validateManifest(overLimit), error("pricingOptions[0]", "invalid_value"));
});

test("fragment preflight reports obvious unsafe markup without claiming sanitizer equivalence", () => {
  const result = validateFragment("<script>alert(1)</script>");
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "element_not_allowed"), true);
});
