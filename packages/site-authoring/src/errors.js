import { CANONICAL_TIMESTAMP, LIMITS } from "./constants.js";

const DELETE_CODE_POINT = 0x7f;
const C1_LAST_CODE_POINT = 0x9f;
const BIDI_OVERRIDE_FIRST = 0x202a;
const BIDI_OVERRIDE_LAST = 0x202e;
const BIDI_ISOLATE_FIRST = 0x2066;
const BIDI_ISOLATE_LAST = 0x2069;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

// The character classes are expressed as code-point predicates rather than
// regular-expression escapes so that every module rejects exactly the same
// set, and so a copy-edit cannot silently narrow one of them.

/** C0 controls and DEL — the class that must never reach a path or a filename. */
export function hasAsciiControl(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === DELETE_CODE_POINT) return true;
  }
  return false;
}

/** C0, DEL, and C1 — the class that must never reach a header value or a token. */
export function hasControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || (codePoint >= DELETE_CODE_POINT && codePoint <= C1_LAST_CODE_POINT)) return true;
  }
  return false;
}

export function isCanonicalUuid(value) {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

/** Select the bounded, non-secret fields needed to recover a created preview. */
export function normalizePreviewRecovery(preview) {
  if (
    preview === null
    || typeof preview !== "object"
    || !isCanonicalUuid(preview.siteId)
    || !isCanonicalUuid(preview.pageId)
    || !isCanonicalUuid(preview.snapshotId)
    || typeof preview.expiresAt !== "string"
    || !CANONICAL_TIMESTAMP.test(preview.expiresAt)
  ) return undefined;

  return Object.freeze({
    siteId: preview.siteId,
    pageId: preview.pageId,
    snapshotId: preview.snapshotId,
    expiresAt: preview.expiresAt,
  });
}

function isUnsafeDiagnosticCodePoint(codePoint) {
  return codePoint <= 0x1f
    || (codePoint >= DELETE_CODE_POINT && codePoint <= C1_LAST_CODE_POINT)
    || (codePoint >= BIDI_OVERRIDE_FIRST && codePoint <= BIDI_OVERRIDE_LAST)
    || (codePoint >= BIDI_ISOLATE_FIRST && codePoint <= BIDI_ISOLATE_LAST);
}

/**
 * Bounds and de-fangs any string that reaches a terminal or a machine-readable
 * result: terminal controls, C1, and bidirectional overrides are removed so a
 * hostile diagnostic cannot repaint the operator's screen or reorder the text
 * a reviewer reads.
 */
export function sanitizeDiagnostic(value, fallback = "The operation failed.") {
  if (typeof value !== "string") return fallback;
  const clean = [...value.normalize("NFC")]
    .filter((character) => !isUnsafeDiagnosticCodePoint(character.codePointAt(0)))
    .join("")
    .trim();
  return [...clean].slice(0, LIMITS.diagnosticScalars).join("") || fallback;
}

/**
 * The one error type this package throws. Every failure carries a stable
 * dotted code and an exit code: 2 for a usage fault the caller fixes by
 * changing the command line, 1 for everything else.
 */
export class SiteAuthoringError extends Error {
  constructor(code, message, options = {}) {
    super(sanitizeDiagnostic(message), options.cause ? { cause: options.cause } : undefined);
    this.name = "SiteAuthoringError";
    this.code = typeof code === "string" && /^[a-z0-9_.-]+$/u.test(code)
      ? code
      : "site.failed";
    this.field = typeof options.field === "string" ? sanitizeDiagnostic(options.field, "") : undefined;
    this.status = typeof options.status === "string" ? sanitizeDiagnostic(options.status, "") : undefined;
    this.alternatives = Array.isArray(options.alternatives)
      ? options.alternatives
        .filter((value) => typeof value === "string")
        .slice(0, 100)
        .map((value) => sanitizeDiagnostic(value, "option"))
      : undefined;
    this.exitCode = Number.isSafeInteger(options.exitCode) && options.exitCode >= 1 && options.exitCode <= 255
      ? options.exitCode
      : 1;
  }

  /** Attach the bounded operation labels that committed before this failure. */
  withCompletedWrites(values) {
    this.completedWrites = Array.isArray(values)
      ? values
        .filter((value) => typeof value === "string")
        .slice(0, 100)
        .map((value) => sanitizeDiagnostic(value, "write"))
      : [];
    return this;
  }

  /** Attach the non-secret identity needed to inspect or revoke a created preview. */
  withPreviewRecovery(preview) {
    const recovery = normalizePreviewRecovery(preview);
    if (recovery) this.previewRecovery = recovery;
    return this;
  }
}

/**
 * Collapses an unknown throw into a bounded failure. The original message is
 * deliberately discarded: an arbitrary error can carry the credential, a
 * presigned URL, or page content, and this value reaches stdout and
 * GITHUB_OUTPUT.
 */
export function asSiteAuthoringError(error) {
  return error instanceof SiteAuthoringError
    ? error
    : new SiteAuthoringError("site.failed", "The Taproot site authoring command failed.");
}
