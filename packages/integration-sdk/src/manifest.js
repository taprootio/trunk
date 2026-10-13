import { INTEGRATION_CAPABILITIES } from "./constants.js";
import { IntegrationSdkError } from "./errors.js";
import { asBytes, isPlainObject } from "./bytes.js";
import { DuplicateJsonKeyError, parseJsonWithoutDuplicateKeys } from "./json.js";

const ROOT_FIELDS = new Set([
  "slug", "displayName", "webhookEndpointUrl", "settingsUrl", "requestedCapabilities",
  "offeredComponents", "externalScriptOrigins", "defaultPublishPolicy", "recommendedUninstallDisposition",
  "contractVersion", "pricingOptions", "description", "externalScriptOriginReasons",
  "externalConnectOrigins", "externalConnectOriginReasons",
]);
const REQUIRED_ROOT_FIELDS = [
  "slug", "displayName", "webhookEndpointUrl", "settingsUrl", "requestedCapabilities",
  "offeredComponents", "externalScriptOrigins", "defaultPublishPolicy", "recommendedUninstallDisposition",
  "contractVersion", "pricingOptions",
];
const IDENTIFIER = /^[A-Za-z0-9_.-]+$/;
const VERSION = /^[A-Za-z0-9.-]+$/;
const SLUG = /^[a-z][a-z0-9-]*$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SCHEMA_DEPTH = 12;
const MAX_SCHEMA_NODES = 256;
const MAX_SCHEMA_PROPERTIES = 32;
const MAX_SCHEMA_ENUM_VALUES = 64;
const MAX_QUANTITY = 100_000;
const MAX_SCHEMA_BYTES = 64 * 1024;
const TEXT_ENCODER = new TextEncoder();

function failure(field, code) {
  throw new IntegrationSdkError(code, `Manifest validation failed for ${field}.`, { details: { field, code } });
}

function object(value, field, allowed, required) {
  if (!isPlainObject(value)) failure(field, "invalid_object");
  for (const key of Object.keys(value)) if (!allowed.has(key)) failure(field, "unknown_property");
  for (const key of required) if (!Object.hasOwn(value, key)) failure(field, "missing_property");
}

function text(value, field, maximum) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    failure(field, "invalid_value");
  }
  return value;
}

function array(value, field, maximum, itemMaximum) {
  if (!Array.isArray(value) || value.length > maximum) failure(field, "invalid_value");
  const seen = new Set();
  for (const item of value) {
    text(item, field, itemMaximum);
    if (seen.has(item)) failure(field, "invalid_value");
    seen.add(item);
  }
  return value;
}

function endpoint(value, field, originOnly = false) {
  text(value, field, 2048);
  let parsed;
  try { parsed = new URL(value); } catch { failure(field, "invalid_url"); }
  if (parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash ||
      !parsed.hostname || /^\d/.test(parsed.hostname) || parsed.hostname.includes(":")) {
    failure(field, "invalid_url");
  }
  if (originOnly && parsed.pathname !== "/") failure(field, "invalid_origin");
  return originOnly ? `https://${parsed.hostname.toLowerCase()}` : parsed.toString();
}

function positiveInteger(value, field, nullable = false) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_QUANTITY) failure(field, "invalid_value");
  return value;
}

function validateSchema(schema, field, depth, state) {
  if (depth > MAX_SCHEMA_DEPTH || ++state.nodes > MAX_SCHEMA_NODES || !isPlainObject(schema)) failure(field, "invalid_schema");
  const allowed = new Set(["type", "properties", "required", "items", "enum", "additionalProperties", "minLength", "maxLength", "minimum", "maximum"]);
  object(schema, field, allowed, ["type"]);
  if (!["object", "array", "string", "number", "integer", "boolean"].includes(schema.type)) failure(field, "invalid_schema");
  let declared;
  if (Object.hasOwn(schema, "properties")) {
    if (schema.type !== "object" || !isPlainObject(schema.properties) || Object.keys(schema.properties).length > MAX_SCHEMA_PROPERTIES) failure(field, "invalid_schema");
    declared = new Set();
    for (const [name, child] of Object.entries(schema.properties)) {
      text(name, field, 64);
      if (declared.has(name)) failure(field, "invalid_schema");
      declared.add(name);
      validateSchema(child, field, depth + 1, state);
    }
  }
  if (Object.hasOwn(schema, "required")) {
    if (schema.type !== "object" || !declared || !Array.isArray(schema.required) || schema.required.length > MAX_SCHEMA_PROPERTIES) failure(field, "invalid_schema");
    const required = new Set();
    for (const name of schema.required) {
      if (typeof name !== "string" || !declared.has(name) || required.has(name)) failure(field, "invalid_schema");
      required.add(name);
    }
  }
  if (schema.type === "array" && !Object.hasOwn(schema, "items")) failure(field, "invalid_schema");
  if (Object.hasOwn(schema, "items")) {
    if (schema.type !== "array") failure(field, "invalid_schema");
    validateSchema(schema.items, field, depth + 1, state);
  }
  if (Object.hasOwn(schema, "enum")) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.length > MAX_SCHEMA_ENUM_VALUES ||
        schema.enum.some((item) => !["string", "number", "boolean"].includes(typeof item) ||
          (typeof item === "string" && (item.length > 256 || /[\u0000-\u001f\u007f]/.test(item))) ||
          (typeof item === "number" && !Number.isFinite(item)))) failure(field, "invalid_schema");
  }
  if (Object.hasOwn(schema, "additionalProperties") && (schema.type !== "object" || schema.additionalProperties !== false)) failure(field, "invalid_schema");
  for (const key of ["minLength", "maxLength"]) {
    if (Object.hasOwn(schema, key) && (schema.type !== "string" || !Number.isSafeInteger(schema[key]) || schema[key] < 0 || schema[key] > MAX_QUANTITY)) failure(field, "invalid_schema");
  }
  if (Object.hasOwn(schema, "minLength") && Object.hasOwn(schema, "maxLength") && schema.minLength > schema.maxLength) failure(field, "invalid_schema");
  for (const key of ["minimum", "maximum"]) {
    if (Object.hasOwn(schema, key) && (!["number", "integer"].includes(schema.type) || typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) failure(field, "invalid_schema");
  }
  if (Object.hasOwn(schema, "minimum") && Object.hasOwn(schema, "maximum") && schema.minimum > schema.maximum) failure(field, "invalid_schema");
}

function origins(manifest, name) {
  if (!Object.hasOwn(manifest, name)) return [];
  if (!Array.isArray(manifest[name]) || manifest[name].length > 16) failure(name, "invalid_value");
  const values = manifest[name].map((value) => endpoint(value, name, true));
  if (new Set(values).size !== values.length) failure(name, "duplicate_value");
  return values;
}

function originReasons(manifest, name, values) {
  if (!Object.hasOwn(manifest, name)) return;
  if (!isPlainObject(manifest[name]) || Object.keys(manifest[name]).length !== values.length) failure(name, "invalid_value");
  for (const [origin, reason] of Object.entries(manifest[name])) {
    if (!values.includes(origin)) failure(name, "invalid_value");
    text(reason, name, 500);
  }
}

function jsonByteLength(value, field, code) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { failure(field, code); }
  if (typeof serialized !== "string") failure(field, code);
  return TEXT_ENCODER.encode(serialized).length;
}

function serializedJsonBytes(value) {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? TEXT_ENCODER.encode(serialized) : undefined;
  } catch {
    return undefined;
  }
}

function duplicateKeyFailure(error) {
  const path = error.path;
  if (path.length === 0) failure("$", "unknown_property");

  if (path[0] === "offeredComponents" && Number.isSafeInteger(path[1])) {
    const field = `offeredComponents[${path[1]}]`;
    if (path[2] === "configSchema" && path.at(-1) === "properties") failure(field, "invalid_schema");
    failure(field, "unknown_property");
  }

  if (path[0] === "pricingOptions" && Number.isSafeInteger(path[1])) {
    failure(`pricingOptions[${path[1]}]`, "unknown_property");
  }

  if (path.length === 1 && (path[0] === "externalScriptOriginReasons" || path[0] === "externalConnectOriginReasons")) {
    failure(path[0], "invalid_value");
  }

  failure("$", "invalid_json");
}

function parseManifestJson(bytes) {
  let source;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { failure("$", "invalid_json"); }
  try { return parseJsonWithoutDuplicateKeys(source); } catch (error) {
    if (error instanceof DuplicateJsonKeyError) duplicateKeyFailure(error);
    failure("$", "invalid_json");
  }
}

function normalizeManifestInput(input) {
  if (typeof input === "string" || input instanceof Uint8Array || input instanceof ArrayBuffer) {
    const bytes = asBytes(input, "invalid_json");
    if (bytes.length > MAX_MANIFEST_BYTES) failure("$", "size_exceeded");
    return { value: parseManifestJson(bytes), serializationFailed: false };
  }

  let plainObject;
  try { plainObject = isPlainObject(input); } catch { failure("$", "invalid_object"); }
  if (!plainObject) return { value: input, serializationFailed: false };

  const bytes = serializedJsonBytes(input);
  if (bytes && bytes.length > MAX_MANIFEST_BYTES) failure("$", "size_exceeded");
  return { value: input, serializationFailed: !bytes };
}

function validateManifestOrThrow(input) {
  const normalized = normalizeManifestInput(input);
  const value = normalized.value;
  object(value, "$", ROOT_FIELDS, REQUIRED_ROOT_FIELDS);
  if (!SLUG.test(text(value.slug, "slug", 64))) failure("slug", "invalid_value");
  text(value.displayName, "displayName", 100);
  endpoint(value.webhookEndpointUrl, "webhookEndpointUrl");
  endpoint(value.settingsUrl, "settingsUrl");
  const capabilities = array(value.requestedCapabilities, "requestedCapabilities", 32, 128);
  if (capabilities.some((capability) => !INTEGRATION_CAPABILITIES.includes(capability))) failure("requestedCapabilities", "unavailable_capability");
  if (!Array.isArray(value.offeredComponents) || value.offeredComponents.length > 32) failure("offeredComponents", "invalid_value");
  const componentIds = new Set();
  for (let index = 0; index < value.offeredComponents.length; index++) {
    const component = value.offeredComponents[index];
    const field = `offeredComponents[${index}]`;
    object(component, field, new Set(["id", "name", "configSchema"]), ["id", "name", "configSchema"]);
    if (!IDENTIFIER.test(text(component.id, field, 64)) || componentIds.has(component.id)) failure(field, "invalid_identifier");
    componentIds.add(component.id);
    text(component.name, field, 100);
    if (jsonByteLength(component.configSchema, field, "invalid_schema") > MAX_SCHEMA_BYTES) failure(field, "invalid_schema");
    validateSchema(component.configSchema, field, 0, { nodes: 0 });
  }
  const scriptOrigins = origins(value, "externalScriptOrigins");
  const connectOrigins = origins(value, "externalConnectOrigins");
  originReasons(value, "externalScriptOriginReasons", scriptOrigins);
  originReasons(value, "externalConnectOriginReasons", connectOrigins);
  if (!["auto", "stage"].includes(value.defaultPublishPolicy)) failure("defaultPublishPolicy", "invalid_value");
  if (!["freeze", "remove"].includes(value.recommendedUninstallDisposition)) failure("recommendedUninstallDisposition", "invalid_value");
  if (!VERSION.test(text(value.contractVersion, "contractVersion", 64))) failure("contractVersion", "invalid_value");
  if (!Array.isArray(value.pricingOptions) || value.pricingOptions.length > 16) failure("pricingOptions", "invalid_value");
  const optionIds = new Set();
  value.pricingOptions.forEach((option, index) => {
    const field = `pricingOptions[${index}]`;
    object(option, field, new Set(["id", "version", "quantityMin", "quantityMax", "cadence", "catalogueItemKey"]),
      ["id", "version", "quantityMin", "quantityMax", "cadence", "catalogueItemKey"]);
    if (!IDENTIFIER.test(text(option.id, field, 64)) || optionIds.has(option.id) || !VERSION.test(text(option.version, field, 64))) failure(field, "invalid_value");
    optionIds.add(option.id);
    const minimum = positiveInteger(option.quantityMin, field);
    const maximum = positiveInteger(option.quantityMax, field, true);
    if (maximum !== null && maximum < minimum) failure(field, "invalid_value");
    if (option.cadence === "free" ? option.catalogueItemKey !== null :
      (!["monthly", "annual"].includes(option.cadence) || !IDENTIFIER.test(text(option.catalogueItemKey, field, 128)))) failure(field, "invalid_value");
  });
  if (Object.hasOwn(value, "description")) text(value.description, "description", 2000);
  if (normalized.serializationFailed) failure("$", "invalid_json");
  return value;
}

/**
 * Checks the bounded public manifest grammar before registration. DNS resolution, public-route
 * validation, and all authorization decisions remain server-authoritative.
 */
export function validateManifest(input) {
  try { return { ok: true, value: validateManifestOrThrow(input) }; }
  catch (error) {
    if (error instanceof IntegrationSdkError) {
      return { ok: false, errors: [{ field: error.details?.field ?? "$", code: error.code }] };
    }
    throw error;
  }
}

export function assertValidManifest(input) {
  const result = validateManifest(input);
  if (!result.ok) {
    const first = result.errors[0];
    throw new IntegrationSdkError(first.code, `Manifest validation failed for ${first.field}.`, { details: first });
  }
  return result.value;
}

/**
 * Advisory preflight only. It catches a few common server rejections but intentionally does not
 * implement a second HTML sanitizer. Taproot validates the final fragment on every write.
 */
export function validateFragment(html) {
  const errors = [];
  if (typeof html !== "string" || html.length === 0) errors.push({ code: "invalid_html", message: "A non-empty HTML fragment is required." });
  if (typeof html === "string" && new TextEncoder().encode(html).length > 64 * 1024) errors.push({ code: "size_exceeded", message: "Fragment exceeds the public preflight size limit." });
  if (typeof html === "string" && /<\/?(?:script|iframe|object|embed|form|input|svg|math)\b/i.test(html)) errors.push({ code: "element_not_allowed", message: "The fragment contains an element the server normally rejects." });
  if (typeof html === "string" && /\son[a-z]+\s*=/i.test(html)) errors.push({ code: "attribute_not_allowed", message: "Event-handler attributes are not accepted." });
  if (typeof html === "string" && /(?:href|src)\s*=\s*['"]?\s*(?:javascript:|data:|\/\\|\\\\)/i.test(html)) errors.push({ code: "invalid_url", message: "The fragment contains an unsafe URL form." });
  if (typeof html === "string" && /<(?!template\b[^>]*\bshadowrootmode\s*=)[^>]*\bstyle\b/i.test(html)) errors.push({ code: "element_not_allowed", message: "Styles are only supported inside an allowed declarative shadow root." });
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
