import { createHash } from "node:crypto";

import { IntegrationSdkError } from "./errors.js";

export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
export const MAX_API_RESPONSE_BYTES = 1024 * 1024;
export const MAX_API_REQUEST_BYTES = 1024 * 1024;

export function asBytes(value, code = "invalid_body") {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  throw new IntegrationSdkError(code, "Expected exact bytes, an ArrayBuffer, or a UTF-8 string.");
}

export function sha256Hex(value) {
  return createHash("sha256").update(asBytes(value)).digest("hex");
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

export function readHeader(headers, name) {
  const target = name.toLowerCase();
  if (headers instanceof Headers) return headers.get(name);
  if (headers instanceof Map) {
    for (const [key, value] of headers) if (String(key).toLowerCase() === target) return String(value);
    return undefined;
  }
  if (headers && typeof headers === "object") {
    for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === target) return String(value);
  }
  return undefined;
}

export function parseJsonBytes(bytes, code = "invalid_json") {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new IntegrationSdkError(code, "The value is not valid UTF-8 JSON.");
  }
}

export function ensureBoundedText(value, maximum, code, field) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new IntegrationSdkError(code, `Invalid ${field}.`);
  }
  return value;
}
