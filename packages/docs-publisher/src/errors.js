import { LIMITS } from "./constants.js";

const UNSAFE_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

export function sanitizeDiagnostic(value, fallback = "The operation failed.") {
  if (typeof value !== "string") return fallback;
  const clean = value.normalize("NFC").replace(UNSAFE_CONTROLS, "").trim();
  return [...clean].slice(0, LIMITS.diagnosticScalars).join("") || fallback;
}

export class PublisherError extends Error {
  constructor(code, message, options = {}) {
    super(sanitizeDiagnostic(message), options.cause ? { cause: options.cause } : undefined);
    this.name = "PublisherError";
    this.code = typeof code === "string" && /^[a-z0-9_.-]+$/u.test(code)
      ? code
      : "publisher.failed";
    this.field = typeof options.field === "string" ? sanitizeDiagnostic(options.field, "") : undefined;
    this.status = typeof options.status === "string" ? sanitizeDiagnostic(options.status, "") : undefined;
    this.exitCode = Number.isSafeInteger(options.exitCode) && options.exitCode >= 1 && options.exitCode <= 255
      ? options.exitCode
      : 1;
  }
}

export function asPublisherError(error) {
  return error instanceof PublisherError
    ? error
    : new PublisherError("publisher.failed", "The Docs publish operation failed.");
}

export function validationFailure(prefix, errors) {
  const first = Array.isArray(errors) ? errors[0] : undefined;
  const code = typeof first?.code === "string" ? first.code : "invalid";
  const path = typeof first?.path === "string" ? first.path : "$artifact";
  return new PublisherError(
    `${prefix}.${code.replace(/[^a-z0-9_.-]/giu, "_").toLowerCase()}`,
    `Artifact validation failed at ${sanitizeDiagnostic(path, "$artifact")}.`,
    { field: path },
  );
}
