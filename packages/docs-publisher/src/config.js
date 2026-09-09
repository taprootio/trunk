import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import {
  CONFIG_FILE_NAME,
  CONFIG_VERSION,
  DEFAULT_API_BASE_URL,
  DEFAULT_PUBLICATION_MODE,
  isPublicationMode,
  LIMITS,
  MODE_MANAGED,
  MODE_PREBUILT,
} from "./constants.js";
import { PublisherError } from "./errors.js";

const CONFIG_KEYS = new Set([
  "apiBaseUrl",
  "artifactDirectory",
  "configVersion",
  "mode",
  "siteId",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const WINDOWS_DEVICE_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

function parseJsonWithDuplicateGuard(text) {
  let offset = 0;
  const whitespace = () => {
    while (/[\t\n\r ]/u.test(text[offset] ?? "")) offset += 1;
  };
  const string = () => {
    if (text[offset] !== "\"") throw new Error("Expected a JSON string.");
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      const character = text[offset];
      if (character === "\"") {
        offset += 1;
        return JSON.parse(text.slice(start, offset));
      }
      if (character === "\\") {
        offset += 1;
        if (text[offset] === "u") offset += 4;
      }
      offset += 1;
    }
    throw new Error("Unterminated JSON string.");
  };
  const value = (depth = 0) => {
    if (depth > 16) throw new Error("JSON nesting is too deep.");
    whitespace();
    if (text[offset] === "\"") return string();
    if (text[offset] === "{") {
      offset += 1;
      whitespace();
      const result = Object.create(null);
      const keys = new Set();
      if (text[offset] === "}") {
        offset += 1;
        return result;
      }
      while (offset < text.length) {
        whitespace();
        const key = string();
        if (keys.has(key)) {
          throw new PublisherError(
            "config.duplicate_key",
            `Configuration field '${key}' appears more than once.`,
            { field: key },
          );
        }
        keys.add(key);
        whitespace();
        if (text[offset] !== ":") throw new Error("Expected ':' after a JSON key.");
        offset += 1;
        result[key] = value(depth + 1);
        whitespace();
        if (text[offset] === "}") {
          offset += 1;
          return result;
        }
        if (text[offset] !== ",") throw new Error("Expected ',' between JSON fields.");
        offset += 1;
      }
      throw new Error("Unterminated JSON object.");
    }
    if (text[offset] === "[") {
      offset += 1;
      whitespace();
      const result = [];
      if (text[offset] === "]") {
        offset += 1;
        return result;
      }
      while (offset < text.length) {
        result.push(value(depth + 1));
        whitespace();
        if (text[offset] === "]") {
          offset += 1;
          return result;
        }
        if (text[offset] !== ",") throw new Error("Expected ',' between JSON values.");
        offset += 1;
      }
      throw new Error("Unterminated JSON array.");
    }
    const remaining = text.slice(offset);
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(remaining)?.[0];
    if (!token) throw new Error("Invalid JSON value.");
    offset += token.length;
    return JSON.parse(token);
  };

  try {
    const parsed = value();
    whitespace();
    if (offset !== text.length) throw new Error("Unexpected data after the JSON value.");
    return parsed;
  } catch (error) {
    if (error instanceof PublisherError) throw error;
    throw new PublisherError("config.invalid_json", "The publisher configuration is not valid JSON.");
  }
}

export async function readInspectedConfigFile(filePath, stats, maximumBytes = LIMITS.configBytes) {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new PublisherError(
      "config.not_regular",
      "The publisher configuration must be a regular file, not a link or directory.",
    );
  }
  if (stats.size > BigInt(maximumBytes)) {
    throw new PublisherError("config.too_large", `The publisher configuration exceeds ${maximumBytes} bytes.`);
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
      throw new PublisherError("config.changed", "The publisher configuration changed while it was being opened.");
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
      throw new PublisherError("config.changed", "The publisher configuration changed while it was being read.");
    }
    return buffer.subarray(0, total);
  } catch (error) {
    if (error instanceof PublisherError) throw error;
    throw new PublisherError("config.unreadable", "Could not read the publisher configuration.");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readRegularFile(filePath, maximumBytes, missingCode) {
  let stats;
  try {
    stats = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new PublisherError(missingCode, `Configuration file '${filePath}' does not exist.`);
    }
    throw new PublisherError("config.unreadable", `Could not inspect configuration file '${filePath}'.`);
  }
  return await readInspectedConfigFile(filePath, stats, maximumBytes);
}

async function discoverConfig(cwd) {
  let current;
  try {
    current = await realpath(cwd);
  } catch {
    throw new PublisherError("config.cwd_invalid", "The working directory does not exist or cannot be resolved.");
  }
  const matches = [];
  for (let depth = 0; depth < LIMITS.configDiscoveryParents; depth += 1) {
    const candidate = path.join(current, CONFIG_FILE_NAME);
    try {
      await lstat(candidate);
      matches.push(candidate);
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") {
        throw new PublisherError("config.discovery_failed", "Could not inspect a publisher configuration candidate.");
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      if (matches.length === 0) {
        throw new PublisherError(
          "config.not_found",
          `No ${CONFIG_FILE_NAME} was found. Pass --config or add the file to the repository.`,
        );
      }
      if (matches.length > 1) {
        throw new PublisherError(
          "config.ambiguous",
          `More than one ${CONFIG_FILE_NAME} was found in the parent chain. Pass --config explicitly.`,
        );
      }
      return matches[0];
    }
    current = parent;
  }
  throw new PublisherError(
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
    throw new PublisherError("config.cwd_invalid", "The working directory does not exist or cannot be resolved.");
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

function validateApiBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PublisherError("config.api_base_url", "apiBaseUrl must be an absolute Taproot API URL.", {
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
    throw new PublisherError(
      "config.api_base_url",
      "apiBaseUrl must be the /api endpoint on app.taproot.io, app.taproot.test, or an explicit loopback origin.",
      { field: "apiBaseUrl" },
    );
  }
  return url.toString().replace(/\/+$/u, "");
}

function validateArtifactDirectoryText(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > LIMITS.artifactDirectoryPathBytes
    || /[\u0000-\u001f\u007f]/u.test(value)
    || path.isAbsolute(value)
    || value.includes("\\")
    || value.split("/").some((segment) => {
      const base = segment.split(".")[0]?.replace(/[ .]+$/u, "") ?? "";
      return segment === "" || segment === "." || segment === ".." || WINDOWS_DEVICE_BASENAME.test(base);
    })
  ) {
    throw new PublisherError(
      "config.artifact_directory",
      "artifactDirectory must be a bounded relative POSIX path beneath the configuration directory.",
      { field: "artifactDirectory" },
    );
  }
  return value;
}

async function requireRealArtifactDirectory(configDirectory, relativeDirectory) {
  let current = configDirectory;
  for (const segment of relativeDirectory.split("/")) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await lstat(current, { bigint: true });
    } catch {
      throw new PublisherError("artifact.directory_missing", "The configured artifact directory does not exist.", {
        field: "artifactDirectory",
      });
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new PublisherError(
        "artifact.directory_invalid",
        "The artifact root and each of its ancestors must be real directories, not links or files.",
        { field: "artifactDirectory" },
      );
    }
  }
  return current;
}

export async function loadPublisherConfig({ cwd = process.cwd(), configPath } = {}) {
  if (
    configPath !== undefined
    && (
      typeof configPath !== "string"
      || configPath.length === 0
      || Buffer.byteLength(configPath, "utf8") > LIMITS.configPathBytes
      || /[\u0000-\u001f\u007f]/u.test(configPath)
    )
  ) {
    throw new PublisherError("config.path_invalid", "The explicit publisher configuration path is invalid.");
  }
  const selectedPath = configPath
    ? await resolveExplicitConfigPath(cwd, configPath)
    : await discoverConfig(cwd);
  let canonicalConfigPath;
  try {
    canonicalConfigPath = await realpath(selectedPath);
  } catch {
    throw new PublisherError("config.not_found", `Configuration file '${selectedPath}' does not exist.`);
  }
  if (canonicalConfigPath !== selectedPath) {
    throw new PublisherError(
      "config.not_regular",
      "The publisher configuration and each of its parent directories must be real paths, not links.",
    );
  }
  const bytes = await readRegularFile(selectedPath, LIMITS.configBytes, "config.not_found");
  if (await realpath(selectedPath).catch(() => undefined) !== canonicalConfigPath) {
    throw new PublisherError("config.changed", "The publisher configuration path changed while it was being read.");
  }
  const parsed = parseJsonWithDuplicateGuard(bytes.toString("utf8"));
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new PublisherError("config.shape", "The publisher configuration must be a JSON object.");
  }
  const unknown = Object.keys(parsed).filter((key) => !CONFIG_KEYS.has(key)).sort();
  if (unknown.length > 0) {
    throw new PublisherError("config.unknown_field", `Unknown publisher configuration field '${unknown[0]}'.`, {
      field: unknown[0],
    });
  }
  if (parsed.configVersion !== CONFIG_VERSION) {
    throw new PublisherError(
      "config.unsupported_version",
      `configVersion must be ${CONFIG_VERSION}.`,
      { field: "configVersion" },
    );
  }
  if (typeof parsed.siteId !== "string" || !UUID.test(parsed.siteId)) {
    throw new PublisherError("config.site_id", "siteId must be a canonical lowercase UUID.", { field: "siteId" });
  }
  // The publication mode is an explicit, closed selection. An absent mode is
  // the managed default; anything else fails before the key reaches a request.
  if (parsed.mode !== undefined && !isPublicationMode(parsed.mode)) {
    throw new PublisherError(
      "config.mode_invalid",
      `mode must be exactly '${MODE_MANAGED}' or '${MODE_PREBUILT}'.`,
      { field: "mode" },
    );
  }
  const artifactDirectoryText = validateArtifactDirectoryText(parsed.artifactDirectory);
  if (parsed.apiBaseUrl !== undefined && typeof parsed.apiBaseUrl !== "string") {
    throw new PublisherError("config.api_base_url", "apiBaseUrl must be a string.", { field: "apiBaseUrl" });
  }

  const configDirectory = path.dirname(canonicalConfigPath);
  const artifactCandidate = await requireRealArtifactDirectory(configDirectory, artifactDirectoryText);
  let artifactDirectory;
  try {
    artifactDirectory = await realpath(artifactCandidate);
  } catch {
    throw new PublisherError("artifact.directory_missing", "The configured artifact directory does not exist.", {
      field: "artifactDirectory",
    });
  }
  if (!artifactDirectory.startsWith(`${configDirectory}${path.sep}`) || artifactDirectory !== artifactCandidate) {
    throw new PublisherError(
      "artifact.directory_escape",
      "The configured artifact directory must resolve beneath the configuration directory.",
      { field: "artifactDirectory" },
    );
  }
  return Object.freeze({
    configVersion: CONFIG_VERSION,
    configPath: canonicalConfigPath,
    configDirectory,
    siteId: parsed.siteId,
    mode: parsed.mode ?? DEFAULT_PUBLICATION_MODE,
    artifactDirectory,
    apiBaseUrl: validateApiBaseUrl(parsed.apiBaseUrl ?? DEFAULT_API_BASE_URL),
  });
}
