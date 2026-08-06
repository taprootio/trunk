import { LIMITS } from "./constants.js";
import { isDisallowedStringCodePoint } from "./text.js";

function utf8Bytes(codePoint) {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function escapedCodePoint(codePoint) {
  return `\\u${codePoint.toString(16).padStart(4, "0")}`;
}

function safeDiagnosticPrefix(value, maximumScalars) {
  const source = String(value);
  const result = [];
  let scalarCount = 0;
  let truncated = false;
  for (let offset = 0; offset < source.length;) {
    if (scalarCount >= maximumScalars) {
      truncated = true;
      break;
    }
    const first = source.charCodeAt(offset);
    let scalar;
    let width = 1;
    if (first >= 0xd800 && first <= 0xdbff && offset + 1 < source.length) {
      const second = source.charCodeAt(offset + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        scalar = source.slice(offset, offset + 2);
        width = 2;
      }
    }
    if (scalar === undefined) {
      scalar = first >= 0xd800 && first <= 0xdfff
        ? escapedCodePoint(first)
        : source[offset];
    }
    const codePoint = scalar.codePointAt(0);
    if (isDisallowedStringCodePoint(codePoint)) {
      scalar = escapedCodePoint(codePoint);
    }
    result.push(scalar);
    scalarCount += 1;
    offset += width;
  }
  return { value: result.join("").normalize("NFC"), truncated };
}

export function sanitizeDiagnostic(value, maximumScalars, maximumBytes) {
  const prefix = safeDiagnosticPrefix(value, maximumScalars);
  const suffix = "…";
  const suffixBytes = utf8Bytes(suffix.codePointAt(0));
  const result = [];
  let scalarCount = 0;
  let byteCount = 0;
  let truncated = prefix.truncated;
  for (const scalar of prefix.value) {
    const scalarBytes = utf8Bytes(scalar.codePointAt(0));
    if (scalarCount >= maximumScalars || byteCount + scalarBytes > maximumBytes) {
      truncated = true;
      break;
    }
    result.push(scalar);
    scalarCount += 1;
    byteCount += scalarBytes;
  }
  if (truncated && maximumScalars > 0 && maximumBytes >= suffixBytes) {
    while (result.length > 0 && (scalarCount >= maximumScalars || byteCount + suffixBytes > maximumBytes)) {
      const removed = result.pop();
      scalarCount -= 1;
      byteCount -= utf8Bytes(removed.codePointAt(0));
    }
    if (scalarCount < maximumScalars && byteCount + suffixBytes <= maximumBytes) result.push(suffix);
  }
  return result.join("");
}

export function sanitizeValidationError(error) {
  return {
    code: typeof error.code === "string" ? error.code : "validation.invalid_error",
    path: sanitizeDiagnostic(error.path, LIMITS.diagnosticPathScalars, LIMITS.diagnosticPathBytes),
    message: sanitizeDiagnostic(error.message, LIMITS.diagnosticMessageScalars, LIMITS.diagnosticMessageBytes),
  };
}

export function sortValidationErrors(errors) {
  return [...errors].sort((left, right) => (
    compareCanonicalStrings(left.path, right.path)
    || compareCanonicalStrings(left.code, right.code)
    || compareCanonicalStrings(left.message, right.message)
  ));
}

export function compareCanonicalStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export class ValidationContext {
  constructor() {
    this.errors = [];
    this.truncated = false;
  }

  add(code, path, message) {
    if (this.errors.length < LIMITS.validationErrors) {
      this.errors.push(sanitizeValidationError({ code, path, message }));
      return;
    }
    if (!this.truncated) {
      this.errors.push({
        code: "validation.too_many_errors",
        path: "$",
        message: `Validation stopped after ${LIMITS.validationErrors} errors.`,
      });
      this.truncated = true;
    }
  }

  finish(value) {
    if (this.errors.length > 0) return { ok: false, errors: sortValidationErrors(this.errors) };
    return { ok: true, value };
  }
}

export class DocsArtifactValidationError extends Error {
  constructor(errors) {
    const sanitizedErrors = errors.map(sanitizeValidationError);
    super(sanitizeDiagnostic(
      sanitizedErrors.map((error) => `${error.code} ${error.path}: ${error.message}`).join("\n"),
      LIMITS.diagnosticAggregateScalars,
      LIMITS.diagnosticAggregateBytes,
    ));
    this.name = "DocsArtifactValidationError";
    this.errors = sanitizedErrors;
  }
}
