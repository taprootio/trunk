import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import {
  CLI_BINARY_NAME,
  CLI_NAME,
  CLI_VERSION,
  GITHUB_OUTPUT_KEY_PREFIX,
  GITHUB_OUTPUT_RESULT_KEY,
  LIMITS,
  REFUSAL_UNCLASSIFIED,
  RESULT_SCHEMA_VERSION,
} from "./constants.js";
import {
  hasAsciiControl,
  normalizePreviewRecovery,
  sanitizeDiagnostic,
  SiteAuthoringError,
} from "./errors.js";

const SAFE_SCALAR = /^[a-z][a-z0-9]*(?: [a-z][a-z0-9]*)?$/u;
const MAXIMUM_OUTPUT_PATH_LENGTH = 4_096;

/**
 * The machine-readable failure. `refusal` is present only when the API
 * classified the rejection, because "unclassified" tells a caller nothing it
 * could not read from `status`.
 */
export function failureResult(error) {
  const result = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    ok: false,
    cli: { name: CLI_NAME, version: CLI_VERSION },
    error: { code: error.code },
  };
  if (error.field) result.error.field = error.field;
  if (error.status) result.error.status = error.status;
  if (Array.isArray(error.alternatives) && error.alternatives.length > 0) {
    result.error.alternatives = error.alternatives;
  }
  if (Array.isArray(error.completedWrites) && error.completedWrites.length > 0) {
    result.error.completedWrites = error.completedWrites;
  }
  const previewRecovery = normalizePreviewRecovery(error.previewRecovery);
  if (previewRecovery) result.error.preview = previewRecovery;
  const refusal = typeof error.refusalKind === "function" ? error.refusalKind() : undefined;
  if (typeof refusal === "string" && refusal !== REFUSAL_UNCLASSIFIED) result.error.refusal = refusal;
  return result;
}

function requireBoundedJson(result) {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new SiteAuthoringError("output.result_invalid", "A verb returned something other than a result object.");
  }
  const json = JSON.stringify(result);
  if (typeof json !== "string") {
    throw new SiteAuthoringError("output.result_invalid", "A verb returned a result that cannot be serialized.");
  }
  if (Buffer.byteLength(json, "utf8") > LIMITS.githubOutputBytes) {
    throw new SiteAuthoringError("output.too_large", "The machine-readable result exceeded its output bound.");
  }
  return json;
}

function githubDelimiter(json) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const delimiter = `${GITHUB_OUTPUT_KEY_PREFIX}_${randomBytes(16).toString("hex")}`;
    if (!json.includes(delimiter)) return delimiter;
  }
  throw new SiteAuthoringError(
    "output.delimiter",
    "Could not construct a collision-resistant GitHub Actions output delimiter.",
  );
}

export async function appendInspectedGithubOutput(outputPath, stats, contents) {
  let handle;
  try {
    handle = await open(
      outputPath,
      fsConstants.O_WRONLY
        | fsConstants.O_APPEND
        | (fsConstants.O_NOFOLLOW ?? 0)
        | (fsConstants.O_NONBLOCK ?? 0),
    );
    const openedStats = await handle.stat({ bigint: true });
    if (
      !openedStats.isFile()
      || openedStats.dev !== stats.dev
      || openedStats.ino !== stats.ino
    ) {
      throw new SiteAuthoringError("output.github_changed", "GITHUB_OUTPUT changed while it was being opened.");
    }
    await handle.appendFile(contents, { encoding: "utf8" });
  } catch (error) {
    if (error instanceof SiteAuthoringError) throw error;
    throw new SiteAuthoringError("output.github_write", "Could not append the machine-readable GitHub Actions output.");
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function writeGithubActionsOutput(outputPath, result) {
  if (
    typeof outputPath !== "string"
    || outputPath.length === 0
    || outputPath.length > MAXIMUM_OUTPUT_PATH_LENGTH
    || hasAsciiControl(outputPath)
  ) {
    throw new SiteAuthoringError("output.github_path", "GITHUB_OUTPUT is not a valid output-file path.");
  }
  let stats;
  try {
    stats = await lstat(outputPath, { bigint: true });
  } catch {
    throw new SiteAuthoringError(
      "output.github_missing",
      "GITHUB_OUTPUT does not name an existing Actions output file.",
    );
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new SiteAuthoringError(
      "output.github_invalid",
      "GITHUB_OUTPUT must be a regular file, not a link or directory.",
    );
  }
  const json = requireBoundedJson(result);
  const delimiter = githubDelimiter(json);
  const lines = [
    `${GITHUB_OUTPUT_RESULT_KEY}<<${delimiter}`,
    json,
    delimiter,
  ];
  // Convenience scalars stay deliberately thin. The verbs own the shape of a
  // success payload, and a scalar whose value came from a response body could
  // inject a line into the workflow's output file, so only values this package
  // controls and re-validates are ever emitted as bare key=value pairs.
  if (result.ok === true && typeof result.verb === "string" && SAFE_SCALAR.test(result.verb)) {
    lines.push(`${GITHUB_OUTPUT_KEY_PREFIX}_verb=${result.verb}`);
  }
  await appendInspectedGithubOutput(outputPath, stats, `${lines.join("\n")}\n`);
}

export function humanFailure(error) {
  const field = error.field ? ` field=${sanitizeDiagnostic(error.field, "unknown")}` : "";
  const status = error.status ? ` status=${sanitizeDiagnostic(error.status, "unknown")}` : "";
  const kind = typeof error.refusalKind === "function" ? error.refusalKind() : undefined;
  const refusal = typeof kind === "string" && kind !== REFUSAL_UNCLASSIFIED
    ? ` refusal=${sanitizeDiagnostic(kind, "unknown")}`
    : "";
  return `${CLI_BINARY_NAME} failed [${error.code}]${field}${status}${refusal}: ${sanitizeDiagnostic(error.message)}`;
}

export function serializeResult(result) {
  return requireBoundedJson(result);
}
