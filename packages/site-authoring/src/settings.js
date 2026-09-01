import { lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

import { atomicWriteFile } from "./atomic-file.js";
import { readBoundedFile } from "./bounded-file.js";
import { parseJsonWithDuplicateGuard } from "./json-guard.js";
import { credentialStoreDirectory } from "./credentials.js";
import {
  CREDENTIAL_DIRECTORY_MODE,
  DEFAULT_API_BASE_URL,
  ENVIRONMENT_LOCAL,
  ENVIRONMENT_PRODUCTION,
  LIMITS,
  LOCAL_API_BASE_URL,
  SETTINGS_FILE_MODE,
  SETTINGS_FILE_NAME,
  SETTINGS_VERSION,
} from "./constants.js";
import { SiteAuthoringError } from "./errors.js";
import { validateApiBaseUrl } from "./config.js";

/**
 * Which Taproot this machine talks to (TR00645).
 *
 * Deliberately not the credential store, though it sits beside it. The store
 * holds secrets at 0600 and is keyed by origin; this holds one non-secret
 * choice *of* an origin, and conflating them would either widen the store's
 * shape or narrow this file's permissions for no reason. Absent means
 * production, so the file existing at all is the exception.
 */
export function settingsPath(environment = {}) {
  return path.join(credentialStoreDirectory(environment), SETTINGS_FILE_NAME);
}

/** The named environment an origin corresponds to, for reporting. */
export function environmentNameFor(apiBaseUrl) {
  if (apiBaseUrl === DEFAULT_API_BASE_URL) return ENVIRONMENT_PRODUCTION;
  if (apiBaseUrl === LOCAL_API_BASE_URL) return ENVIRONMENT_LOCAL;
  return "custom";
}

/**
 * Resolves `local` / `production` / an explicit URL to a validated base URL.
 * The explicit form exists for a loopback port during development; it clears
 * exactly the bar a configuration's own origin had to clear, so `env` cannot
 * reach somewhere `taproot-site.json` could not.
 */
export function resolveEnvironmentSelector(selector) {
  if (selector === ENVIRONMENT_PRODUCTION) return DEFAULT_API_BASE_URL;
  if (selector === ENVIRONMENT_LOCAL) return LOCAL_API_BASE_URL;
  return validateApiBaseUrl(selector);
}

/**
 * The stored endpoint, or undefined when none is set.
 *
 * A malformed settings file refuses rather than falling back to production:
 * an operator who set this to local and then reads a corrupt file back should
 * be told, not silently pointed at the live Taproot.
 */
export async function readStoredApiBaseUrl(environment = {}) {
  const filePath = settingsPath(environment);
  // The same bounded, no-follow read the credential store uses, for the same
  // reason: this path is under the operator's home and editable by anything
  // running as them. A plain readFile would follow a symlink to a FIFO and
  // block, or to a device and read until memory ran out — both before any
  // size check on the result could run.
  const bytes = await readBoundedFile(filePath, {
    maximumBytes: LIMITS.settingsBytes,
    failures: {
      isOwn: (error) => error instanceof SiteAuthoringError,
      inspect: () => new SiteAuthoringError("settings.unreadable", `Could not inspect '${filePath}'.`),
      notRegular: () =>
        new SiteAuthoringError("settings.not_regular", `'${filePath}' must be a regular file, not a link or directory.`),
      tooLarge: () =>
        new SiteAuthoringError("settings.too_large", `'${filePath}' is larger than ${LIMITS.settingsBytes} bytes.`),
      changed: () => new SiteAuthoringError("settings.changed", `'${filePath}' changed while it was being read.`),
      read: () => new SiteAuthoringError("settings.unreadable", `Could not read '${filePath}'.`),
    },
  });
  if (bytes === undefined) return undefined;
  const contents = bytes.toString("utf8");

  // Duplicate-guarded, not JSON.parse: this file is hand-editable, and a
  // second `apiBaseUrl` would make what it visibly says and where it routes a
  // credential two different Taproots.
  const parsed = parseJsonWithDuplicateGuard(contents, {
    onDuplicate: (key) =>
      new SiteAuthoringError("settings.duplicate_key", `'${filePath}' declares '${key}' more than once.`),
    onInvalid: () => new SiteAuthoringError("settings.malformed", `'${filePath}' is not valid JSON.`),
  });
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SiteAuthoringError("settings.malformed", `'${filePath}' must be a JSON object.`);
  }
  if (parsed.schemaVersion !== SETTINGS_VERSION) {
    throw new SiteAuthoringError("settings.unsupported_version", `'${filePath}' must declare schemaVersion ${SETTINGS_VERSION}.`);
  }
  if (typeof parsed.apiBaseUrl !== "string") {
    throw new SiteAuthoringError("settings.malformed", `'${filePath}' has no apiBaseUrl.`);
  }
  // Re-validated on the way out, not just on the way in: the file is editable
  // by hand, and this is the last point before the value becomes the origin a
  // credential is sent to.
  return validateApiBaseUrl(parsed.apiBaseUrl);
}

async function ensureSettingsDirectory(directory) {
  try {
    await mkdir(directory, { recursive: true, mode: CREDENTIAL_DIRECTORY_MODE });
  } catch {
    throw new SiteAuthoringError("settings.unwritable", "Could not create the configuration directory.");
  }
  let stats;
  try {
    stats = await lstat(directory);
  } catch {
    throw new SiteAuthoringError("settings.unwritable", "Could not inspect the configuration directory.");
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new SiteAuthoringError(
      "settings.directory_invalid",
      "The configuration directory must be a real directory, not a link or file.",
    );
  }
}

/**
 * Records the endpoint. Production clears the file rather than writing the
 * default into it, so "no file" and "production" stay the same state and there
 * is only one thing a fresh machine can mean.
 */
export async function writeStoredApiBaseUrl(environment, apiBaseUrl) {
  const filePath = settingsPath(environment);
  if (apiBaseUrl === DEFAULT_API_BASE_URL) {
    try {
      await unlink(filePath);
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") {
        throw new SiteAuthoringError("settings.unwritable", `Could not clear '${filePath}'.`);
      }
    }
    return filePath;
  }

  await ensureSettingsDirectory(path.dirname(filePath));
  const contents = `${JSON.stringify({ schemaVersion: SETTINGS_VERSION, apiBaseUrl }, undefined, 2)}\n`;
  await atomicWriteFile(filePath, contents, {
    mode: SETTINGS_FILE_MODE,
    openDirectory: open,
    failures: {
      inspect: () => new SiteAuthoringError("settings.unwritable", `Could not inspect '${filePath}'.`),
      notRegular: () => new SiteAuthoringError("settings.not_regular", `'${filePath}' is not a regular file.`),
      write: () => new SiteAuthoringError("settings.unwritable", `Could not write '${filePath}'.`),
    },
  });
  return filePath;
}
