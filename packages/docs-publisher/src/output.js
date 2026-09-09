import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import { LIMITS, PUBLISH_RESULT_SCHEMA_VERSION, PUBLISHER_NAME, PUBLISHER_VERSION } from "./constants.js";
import { PublisherError, sanitizeDiagnostic } from "./errors.js";

export function failureResult(error) {
  const result = {
    schemaVersion: PUBLISH_RESULT_SCHEMA_VERSION,
    ok: false,
    publisher: { name: PUBLISHER_NAME, version: PUBLISHER_VERSION },
    error: { code: error.code },
  };
  if (error.field) result.error.field = error.field;
  if (error.status) result.error.status = error.status;
  return result;
}

function requireBoundedJson(result) {
  const json = JSON.stringify(result);
  if (Buffer.byteLength(json, "utf8") > LIMITS.githubOutputBytes) {
    throw new PublisherError("output.too_large", "The machine-readable publish result exceeded its output bound.");
  }
  return json;
}

function githubDelimiter(json) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const delimiter = `taproot_docs_${randomBytes(16).toString("hex")}`;
    if (!json.includes(delimiter)) return delimiter;
  }
  throw new PublisherError(
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
      throw new PublisherError("output.github_changed", "GITHUB_OUTPUT changed while it was being opened.");
    }
    await handle.appendFile(contents, { encoding: "utf8" });
  } catch (error) {
    if (error instanceof PublisherError) throw error;
    throw new PublisherError("output.github_write", "Could not append the machine-readable GitHub Actions output.");
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function writeGithubActionsOutput(outputPath, result) {
  if (
    typeof outputPath !== "string" || outputPath.length === 0 || outputPath.length > 4_096
    || /[\u0000\r\n]/u.test(outputPath)
  ) {
    throw new PublisherError("output.github_path", "GITHUB_OUTPUT is not a valid output-file path.");
  }
  let stats;
  try {
    stats = await lstat(outputPath, { bigint: true });
  } catch {
    throw new PublisherError("output.github_missing", "GITHUB_OUTPUT does not name an existing Actions output file.");
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new PublisherError("output.github_invalid", "GITHUB_OUTPUT must be a regular file, not a link or directory.");
  }
  const json = requireBoundedJson(result);
  const delimiter = githubDelimiter(json);
  const lines = [
    `taproot_docs_result<<${delimiter}`,
    json,
    delimiter,
  ];
  if (result.ok) {
    lines.push(
      `taproot_docs_publication_mode=${result.mode}`,
      `taproot_docs_release_id=${result.release.id}`,
      `taproot_docs_staging_deployment_id=${result.staging.deploymentId}`,
      `taproot_docs_production_deployment_id=${result.production.deploymentId}`,
      `taproot_docs_output_release_id=${result.production.outputReleaseId}`,
      `taproot_docs_production_pointer_version=${result.production.pointerVersion}`,
    );
  }
  await appendInspectedGithubOutput(outputPath, stats, `${lines.join("\n")}\n`);
}

export function humanFailure(error) {
  const field = error.field ? ` field=${sanitizeDiagnostic(error.field, "unknown")}` : "";
  const status = error.status ? ` status=${sanitizeDiagnostic(error.status, "unknown")}` : "";
  return `taproot docs publish failed [${error.code}]${field}${status}: ${sanitizeDiagnostic(error.message)}`;
}

export function serializeResult(result) {
  return requireBoundedJson(result);
}
