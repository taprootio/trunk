import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import {
  CLI_BINARY_NAME,
  CONFIG_FILE_NAME,
  CONFIG_VERSION,
  ENVIRONMENT_LOCAL,
  ENVIRONMENT_PRODUCTION,
  LIMITS,
  VERB_ENV,
} from "./constants.js";
import { hasAsciiControl, isCanonicalUuid, SiteAuthoringError } from "./errors.js";
import { parseJsonWithDuplicateGuard } from "./json-guard.js";

const CONFIG_KEYS = new Set([
  "configVersion",
  "siteId",
  "workspaceDir",
]);
const WINDOWS_DEVICE_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
// The duplicate-key guard lives in json-guard.js now, shared with the machine
// settings. It is still needed here for the reason it was written: a
// configuration that says `siteId` twice is ambiguous about which site the
// next command will write to, and the only safe reading of an ambiguous target
// is to refuse it.
function parseConfigJson(text) {
  return parseJsonWithDuplicateGuard(text, {
    onDuplicate: (key) =>
      new SiteAuthoringError(
        "config.duplicate_key",
        `Configuration field '${key}' appears more than once.`,
        { field: key },
      ),
    onInvalid: () =>
      new SiteAuthoringError("config.invalid_json", "The site authoring configuration is not valid JSON."),
  });
}

export async function readInspectedConfigFile(
  filePath,
  stats,
  maximumBytes = LIMITS.configBytes,
  errorField,
) {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new SiteAuthoringError(
      "config.not_regular",
      "The site authoring configuration must be a regular file, not a link or directory.",
      { field: errorField },
    );
  }
  if (stats.size > BigInt(maximumBytes)) {
    throw new SiteAuthoringError(
      "config.too_large",
      `The site authoring configuration exceeds ${maximumBytes} bytes.`,
      { field: errorField },
    );
  }

  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    );
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile()
      || before.dev !== stats.dev
      || before.ino !== stats.ino
      || before.size !== stats.size
      || before.mtimeNs !== stats.mtimeNs
      || before.ctimeNs !== stats.ctimeNs
      || before.size > BigInt(maximumBytes)
    ) {
      throw new SiteAuthoringError("config.changed", "The configuration changed while it was being opened.", {
        field: errorField,
      });
    }
    const buffer = Buffer.allocUnsafe(maximumBytes + 1);
    let total = 0;
    while (total <= maximumBytes) {
      const { bytesRead } = await handle.read(buffer, total, buffer.byteLength - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
      || total > maximumBytes
      || total !== Number(after.size)
    ) {
      throw new SiteAuthoringError("config.changed", "The configuration changed while it was being read.", {
        field: errorField,
      });
    }
    return buffer.subarray(0, total);
  } catch (error) {
    if (error instanceof SiteAuthoringError) throw error;
    throw new SiteAuthoringError("config.unreadable", "Could not read the site authoring configuration.", {
      field: errorField,
    });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readRegularFile(filePath, maximumBytes, missingCode, errorField) {
  let stats;
  try {
    stats = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new SiteAuthoringError(missingCode, `Configuration file '${filePath}' does not exist.`, {
        field: errorField,
      });
    }
    throw new SiteAuthoringError("config.unreadable", `Could not inspect configuration file '${filePath}'.`, {
      field: errorField,
    });
  }
  return await readInspectedConfigFile(filePath, stats, maximumBytes, errorField);
}

async function discoverConfig(cwd) {
  let current;
  try {
    current = await realpath(cwd);
  } catch {
    throw new SiteAuthoringError("config.cwd_invalid", "The working directory does not exist or cannot be resolved.");
  }
  const matches = [];
  for (let depth = 0; depth < LIMITS.configDiscoveryParents; depth += 1) {
    const candidate = path.join(current, CONFIG_FILE_NAME);
    try {
      await lstat(candidate);
      matches.push(candidate);
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") {
        throw new SiteAuthoringError(
          "config.discovery_failed",
          "Could not inspect a site authoring configuration candidate.",
        );
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      if (matches.length === 0) {
        throw new SiteAuthoringError(
          "config.not_found",
          `No ${CONFIG_FILE_NAME} was found. Pass --config or add the file to the repository.`,
        );
      }
      if (matches.length > 1) {
        throw new SiteAuthoringError(
          "config.ambiguous",
          `More than one ${CONFIG_FILE_NAME} was found in the parent chain. Pass --config explicitly.`,
        );
      }
      return matches[0];
    }
    current = parent;
  }
  throw new SiteAuthoringError(
    "config.discovery_limit",
    `Configuration discovery exceeded ${LIMITS.configDiscoveryParents} parent directories. Pass --config explicitly.`,
  );
}

async function resolveExplicitConfigPath(cwd, configPath) {
  const lexicalCwd = path.resolve(cwd);
  let canonicalCwd;
  try {
    canonicalCwd = await realpath(lexicalCwd);
  } catch {
    throw new SiteAuthoringError("config.cwd_invalid", "The working directory does not exist or cannot be resolved.");
  }

  if (!path.isAbsolute(configPath)) return path.resolve(canonicalCwd, configPath);

  const lexicalSelectedPath = path.resolve(configPath);
  const relativePath = path.relative(lexicalCwd, lexicalSelectedPath);
  const isWithinCwd = relativePath === ""
    || (
      relativePath !== ".."
      && !relativePath.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativePath)
    );
  return isWithinCwd
    ? path.resolve(canonicalCwd, relativePath)
    : lexicalSelectedPath;
}

/**
 * The reviewed-origin allowlist. It runs before any client exists and
 * therefore before any Authorization header can be constructed, which is the
 * whole point: the credential is site-scoped and long-lived, and the one
 * failure that cannot be walked back is sending it to a host we do not
 * control. Loopback keeps the local Tilt stack usable without widening the
 * reviewed set.
 */
export function validateApiBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SiteAuthoringError("config.api_base_url", "apiBaseUrl must be an absolute Taproot API URL.", {
      field: "apiBaseUrl",
    });
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const reviewedHost = url.hostname === "app.taproot.io" || url.hostname === "app.taproot.test";
  if (
    (!reviewedHost && !loopback)
    || (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
    || (reviewedHost && url.port !== "")
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || url.pathname.replace(/\/+$/u, "") !== "/api"
  ) {
    throw new SiteAuthoringError(
      "config.api_base_url",
      "apiBaseUrl must be the /api endpoint on app.taproot.io, app.taproot.test, or an explicit loopback origin.",
      { field: "apiBaseUrl" },
    );
  }
  return url.toString().replace(/\/+$/u, "");
}

function validateWorkspaceDirectoryText(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > LIMITS.workspacePathBytes
    || hasAsciiControl(value)
    || path.isAbsolute(value)
    || value.includes("\\")
    || value.split("/").some((segment) => {
      const base = segment.split(".")[0]?.replace(/[ .]+$/u, "") ?? "";
      return segment === "" || segment === "." || segment === ".." || WINDOWS_DEVICE_BASENAME.test(base);
    })
  ) {
    throw new SiteAuthoringError(
      "config.workspace_dir",
      "workspaceDir must be a bounded relative POSIX path beneath the configuration directory.",
      { field: "workspaceDir" },
    );
  }
  return value;
}

/**
 * Resolves the local workspace `pull` writes into. Unlike a publish artifact,
 * the workspace legitimately does not exist yet on a fresh clone — so a
 * missing leaf is allowed, while every segment that *does* exist must be a
 * real directory. A symlink anywhere in the chain is refused rather than
 * followed: the workspace is a write target, and following a link is how a
 * checked-in configuration turns `pull` into an arbitrary-file writer.
 */
async function resolveWorkspaceDirectory(configDirectory, relativeDirectory) {
  let current = configDirectory;
  let exists = true;
  for (const segment of relativeDirectory.split("/")) {
    current = path.join(current, segment);
    if (!exists) continue;
    let stats;
    try {
      stats = await lstat(current, { bigint: true });
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        exists = false;
        continue;
      }
      throw new SiteAuthoringError("config.workspace_unreadable", "Could not inspect the configured workspace.", {
        field: "workspaceDir",
      });
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new SiteAuthoringError(
        "config.workspace_invalid",
        "The workspace and each of its ancestors must be real directories, not links or files.",
        { field: "workspaceDir" },
      );
    }
  }

  if (exists) {
    let canonical;
    try {
      canonical = await realpath(current);
    } catch {
      throw new SiteAuthoringError("config.workspace_unreadable", "Could not resolve the configured workspace.", {
        field: "workspaceDir",
      });
    }
    if (canonical !== current) {
      throw new SiteAuthoringError(
        "config.workspace_invalid",
        "The workspace and each of its ancestors must be real directories, not links or files.",
        { field: "workspaceDir" },
      );
    }
  }
  if (!current.startsWith(`${configDirectory}${path.sep}`)) {
    throw new SiteAuthoringError(
      "config.workspace_escape",
      "The configured workspace must resolve beneath the configuration directory.",
      { field: "workspaceDir" },
    );
  }
  return { workspaceDir: current, workspaceExists: exists };
}

export async function loadSiteConfig({ cwd = process.cwd(), configPath } = {}) {
  if (
    configPath !== undefined
    && (
      typeof configPath !== "string"
      || configPath.length === 0
      || Buffer.byteLength(configPath, "utf8") > LIMITS.configPathBytes
      || hasAsciiControl(configPath)
    )
  ) {
    throw new SiteAuthoringError("config.path_invalid", "The explicit configuration path is invalid.", {
      field: "configPath",
    });
  }
  const explicit = configPath !== undefined;
  const selectedPath = configPath
    ? await resolveExplicitConfigPath(cwd, configPath)
    : await discoverConfig(cwd);
  let canonicalConfigPath;
  try {
    canonicalConfigPath = await realpath(selectedPath);
  } catch {
    throw new SiteAuthoringError("config.not_found", `Configuration file '${selectedPath}' does not exist.`, {
      field: explicit ? "configPath" : undefined,
    });
  }
  if (canonicalConfigPath !== selectedPath) {
    throw new SiteAuthoringError(
      "config.not_regular",
      "The configuration and each of its parent directories must be real paths, not links.",
      { field: explicit ? "configPath" : undefined },
    );
  }
  const bytes = await readRegularFile(
    selectedPath,
    LIMITS.configBytes,
    "config.not_found",
    explicit ? "configPath" : undefined,
  );
  if (await realpath(selectedPath).catch(() => undefined) !== canonicalConfigPath) {
    throw new SiteAuthoringError("config.changed", "The configuration path changed while it was being read.", {
      field: explicit ? "configPath" : undefined,
    });
  }
  const parsed = parseConfigJson(bytes.toString("utf8"));
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new SiteAuthoringError("config.shape", "The site authoring configuration must be a JSON object.");
  }
  // Named ahead of the general unknown-field refusal because this one field
  // used to be valid here and its replacement is a command, not a spelling.
  // "Unknown configuration field 'apiBaseUrl'" would be true and useless.
  if (Object.hasOwn(parsed, "apiBaseUrl")) {
    throw new SiteAuthoringError(
      "config.api_base_url_moved",
      "apiBaseUrl is no longer a configuration field: which Taproot the CLI talks to is a property of this "
        + `machine, not of this project. Remove the line and run '${CLI_BINARY_NAME} ${VERB_ENV} `
        + `${ENVIRONMENT_LOCAL}' (or '${ENVIRONMENT_PRODUCTION}').`,
      { field: "apiBaseUrl" },
    );
  }
  const unknown = Object.keys(parsed).filter((key) => !CONFIG_KEYS.has(key)).sort();
  if (unknown.length > 0) {
    throw new SiteAuthoringError("config.unknown_field", `Unknown configuration field '${unknown[0]}'.`, {
      field: unknown[0],
    });
  }
  if (parsed.configVersion !== CONFIG_VERSION) {
    throw new SiteAuthoringError(
      "config.unsupported_version",
      `configVersion must be ${CONFIG_VERSION}.`,
      { field: "configVersion" },
    );
  }
  // Optional since TR00645: `use` writes it, and `login`, `sites`, and `whoami`
  // all run before any site has been chosen. Present-but-malformed is still a
  // refusal — an ambiguous site is not a missing one.
  if (parsed.siteId !== undefined && !isCanonicalUuid(parsed.siteId)) {
    throw new SiteAuthoringError("config.site_id", "siteId must be a canonical lowercase UUID.", { field: "siteId" });
  }
  const workspaceDirectoryText = validateWorkspaceDirectoryText(parsed.workspaceDir);
  const configDirectory = path.dirname(canonicalConfigPath);
  const { workspaceDir, workspaceExists } = await resolveWorkspaceDirectory(configDirectory, workspaceDirectoryText);
  return Object.freeze({
    configVersion: CONFIG_VERSION,
    configPath: canonicalConfigPath,
    configDirectory,
    siteId: parsed.siteId,
    workspaceDir,
    workspaceExists,
  });
}
