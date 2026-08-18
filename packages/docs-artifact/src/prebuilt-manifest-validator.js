import { compareCanonicalStrings, DocsArtifactValidationError, ValidationContext } from "./errors.js";
import {
  canonicalJson,
  canonicalJsonByteLength,
  classifyManifestInput,
  parseManifestJson,
  preflightManifestObject,
} from "./json.js";
import {
  PREBUILT_FILES_CAPABILITY,
  PREBUILT_LIMITS,
  PREBUILT_MEDIA_TYPES,
  PREBUILT_MODE,
  PREBUILT_NOT_FOUND_FILE,
  PREBUILT_SCHEMA_VERSION,
  PREBUILT_SUPPORTED_CAPABILITIES,
} from "./prebuilt-constants.js";
import { normalizePrebuiltArtifactPath, normalizePrebuiltRedirectRoute, prebuiltFileRoute } from "./prebuilt-path.js";
import { hasDisallowedStringCharacters } from "./text.js";

const RESOURCE_KEY = /^[a-z0-9]+(?:[._:/-][a-z0-9]+)*$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const SEMVER_IDENTIFIER = String.raw`(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER = new RegExp(
  String
    .raw`^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-${SEMVER_IDENTIFIER}(?:\.${SEMVER_IDENTIFIER})*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`,
);
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF = /^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkObject(context, value, path, required, allowed) {
  if (!isRecord(value)) {
    context.add("type.object", path, "Expected an object.");
    return false;
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      context.add("property.required", `${path}.${key}`, `Required property '${key}' is missing.`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      context.add(
        "property.unsupported",
        `${path}.${key}`,
        `Property '${key}' is not supported by prebuilt schema v${PREBUILT_SCHEMA_VERSION}.`,
      );
    }
  }
  return true;
}

function stringValue(context, value, path, { min = 1, max = 2_000, pattern, values } = {}) {
  if (typeof value !== "string") {
    context.add("type.string", path, "Expected a string.");
    return undefined;
  }
  if (!value.isWellFormed()) {
    context.add("string.invalid_unicode", path, "Strings must contain only well-formed Unicode scalar values.");
    return undefined;
  }
  if (value.length > max * 2) {
    context.add("string.length", path, `String length must be between ${min} and ${max} characters.`);
    return undefined;
  }
  const scalarLength = [...value].length;
  if (scalarLength < min || scalarLength > max) {
    context.add("string.length", path, `String length must be between ${min} and ${max} characters.`);
  }
  if (value !== value.normalize("NFC")) {
    context.add("string.not_normalized", path, "Strings must use Unicode NFC normalization.");
  }
  if (hasDisallowedStringCharacters(value)) {
    context.add(
      "string.control",
      path,
      "Strings may not contain C0, C1, or bidirectional formatting and override controls.",
    );
  }
  if (pattern && !pattern.test(value)) {
    context.add("string.pattern", path, "String does not match the required canonical form.");
  }
  if (values && !values.includes(value)) context.add("value.unsupported", path, `Unsupported value '${value}'.`);
  return value;
}

function integerValue(context, value, path, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value)) {
    context.add("type.integer", path, "Expected a safe integer.");
    return undefined;
  }
  if (value < min || value > max) context.add("number.range", path, `Integer must be between ${min} and ${max}.`);
  return value;
}

function arrayValue(context, value, path, { min = 0, max }) {
  if (!Array.isArray(value)) {
    context.add("type.array", path, "Expected an array.");
    return undefined;
  }
  if (value.length < min || value.length > max) {
    context.add("array.length", path, `Array length must be between ${min} and ${max}.`);
  }
  return value;
}

function validateHash(context, value, path) {
  stringValue(context, value, path, { min: 71, max: 71, pattern: HASH });
}

function validateHttpsUrl(context, value, path) {
  const candidate = stringValue(context, value, path, { max: 2_000 });
  if (candidate === undefined) return;
  try {
    const url = new URL(candidate);
    if (!candidate.startsWith("https://") || url.protocol !== "https:" || url.username !== "" || url.password !== "") {
      context.add("url.unsafe", path, "URLs must start with canonical 'https://' and may not contain credentials.");
    }
  } catch {
    context.add("url.invalid", path, "Expected an absolute HTTPS URL.");
  }
}

function validateSortedCapabilities(context, value, path) {
  const values = arrayValue(context, value, path, { max: PREBUILT_LIMITS.supportedCapabilities });
  if (!values) return [];
  const result = [];
  const seen = new Set();
  for (let index = 0; index < Math.min(values.length, PREBUILT_LIMITS.supportedCapabilities); index += 1) {
    const capability = stringValue(context, values[index], `${path}[${index}]`, {
      max: PREBUILT_LIMITS.resourceKey,
      pattern: RESOURCE_KEY,
    });
    if (capability === undefined) continue;
    if (seen.has(capability)) context.add("duplicate.value", `${path}[${index}]`, `Duplicate value '${capability}'.`);
    seen.add(capability);
    result.push(capability);
  }
  if (result.some((item, index) => index > 0 && compareCanonicalStrings(result[index - 1], item) >= 0)) {
    context.add("array.not_sorted", path, "Array values must be unique and sorted lexicographically.");
  }
  return result;
}

function expectedMediaType(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".html")) return "text/html; charset=utf-8";
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".webmanifest")) return "application/manifest+json; charset=utf-8";
  if (lower.endsWith(".xml")) return "application/xml; charset=utf-8";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".wasm")) return "application/wasm";
  if (lower.endsWith(".avif")) return "image/avif";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".ico")) return "image/vnd.microsoft.icon";
  if (lower.endsWith(".otf")) return "font/otf";
  if (lower.endsWith(".ttf")) return "font/ttf";
  if (lower.endsWith(".woff")) return "font/woff";
  if (lower.endsWith(".woff2")) return "font/woff2";
  if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function invalidSupportedCapabilities(code, message) {
  return { ok: false, errors: [{ code, path: "$options.supportedCapabilities", message }] };
}

export function snapshotPrebuiltSupportedCapabilities(options) {
  let iterable;
  try {
    iterable = options?.supportedCapabilities;
  } catch {
    return invalidSupportedCapabilities(
      "capability.invalid_iterable",
      "Could not enumerate supported capabilities safely.",
    );
  }
  if (iterable === undefined) return { ok: true, value: Object.freeze([]) };
  if (typeof iterable === "string") {
    return invalidSupportedCapabilities(
      "capability.invalid_iterable",
      "Could not enumerate supported capabilities safely.",
    );
  }
  const values = [];
  try {
    for (const value of iterable) {
      if (values.length >= PREBUILT_LIMITS.supportedCapabilities) {
        return invalidSupportedCapabilities(
          "limit.supported_capabilities",
          `Supported capabilities may not contain more than ${PREBUILT_LIMITS.supportedCapabilities} entries.`,
        );
      }
      if (
        typeof value !== "string" || value.length > PREBUILT_LIMITS.resourceKey || !RESOURCE_KEY.test(value)
        || value !== value.normalize("NFC") || hasDisallowedStringCharacters(value)
      ) {
        return invalidSupportedCapabilities(
          "capability.invalid_value",
          `Supported capabilities must be canonical strings of at most ${PREBUILT_LIMITS.resourceKey} characters.`,
        );
      }
      values.push(value);
    }
  } catch {
    return invalidSupportedCapabilities(
      "capability.invalid_iterable",
      "Could not enumerate supported capabilities safely.",
    );
  }
  return { ok: true, value: Object.freeze(values) };
}

function validateRoot(value, supportedCapabilities) {
  const context = new ValidationContext();
  const rootFields = [
    "schemaVersion",
    "mode",
    "source",
    "build",
    "capabilities",
    "notFoundFile",
    "files",
    "resources",
    "redirects",
  ];
  if (!checkObject(context, value, "$", rootFields, rootFields)) return context.finish(value);

  const schemaVersion = integerValue(context, value.schemaVersion, "$.schemaVersion", { min: 1, max: 1 });
  if (schemaVersion !== undefined && schemaVersion !== PREBUILT_SCHEMA_VERSION) {
    context.add(
      "schema.unsupported",
      "$.schemaVersion",
      `Only prebuilt schemaVersion ${PREBUILT_SCHEMA_VERSION} is supported.`,
    );
  }
  stringValue(context, value.mode, "$.mode", { values: [PREBUILT_MODE] });

  if (
    checkObject(context, value.source, "$.source", [
      "provider",
      "repositoryId",
      "repository",
      "repositoryUrl",
      "revision",
      "ref",
    ], ["provider", "repositoryId", "repository", "repositoryUrl", "revision", "ref"])
  ) {
    stringValue(context, value.source.provider, "$.source.provider", { values: ["github"] });
    stringValue(context, value.source.repositoryId, "$.source.repositoryId", {
      max: 200,
      pattern: /^[A-Za-z0-9_.:-]+$/,
    });
    const repository = stringValue(context, value.source.repository, "$.source.repository", {
      max: 300,
      pattern: REPOSITORY,
    });
    validateHttpsUrl(context, value.source.repositoryUrl, "$.source.repositoryUrl");
    if (repository !== undefined && value.source.repositoryUrl !== `https://github.com/${repository}`) {
      context.add(
        "source.repository_url",
        "$.source.repositoryUrl",
        "GitHub repositoryUrl must be the canonical URL for source.repository.",
      );
    }
    stringValue(context, value.source.revision, "$.source.revision", { min: 40, max: 64, pattern: REVISION });
    stringValue(context, value.source.ref, "$.source.ref", { max: 500, pattern: REF });
  }

  if (
    checkObject(context, value.build, "$.build", [
      "producer",
      "producerVersion",
      "configurationSha256",
      "sourceDateEpoch",
    ], ["producer", "producerVersion", "configurationSha256", "sourceDateEpoch"])
  ) {
    stringValue(context, value.build.producer, "$.build.producer", {
      max: 200,
      pattern: /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/,
    });
    stringValue(context, value.build.producerVersion, "$.build.producerVersion", { max: 100, pattern: SEMVER });
    validateHash(context, value.build.configurationSha256, "$.build.configurationSha256");
    integerValue(context, value.build.sourceDateEpoch, "$.build.sourceDateEpoch", { min: 0, max: 253_402_300_799 });
  }

  if (checkObject(context, value.capabilities, "$.capabilities", ["required", "optional"], ["required", "optional"])) {
    const required = validateSortedCapabilities(context, value.capabilities.required, "$.capabilities.required");
    const optional = validateSortedCapabilities(context, value.capabilities.optional, "$.capabilities.optional");
    if (!required.includes(PREBUILT_FILES_CAPABILITY)) {
      context.add(
        "capability.missing",
        "$.capabilities.required",
        `Prebuilt schema v${PREBUILT_SCHEMA_VERSION} requires '${PREBUILT_FILES_CAPABILITY}'.`,
      );
    }
    for (let index = 0; index < required.length; index += 1) {
      if (!supportedCapabilities.has(required[index])) {
        context.add(
          "capability.unsupported",
          `$.capabilities.required[${index}]`,
          `Required capability '${required[index]}' is not supported.`,
        );
      }
    }
    for (const capability of optional) {
      if (required.includes(capability)) {
        context.add(
          "duplicate.capability",
          "$.capabilities",
          `Capability '${capability}' cannot be both required and optional.`,
        );
      }
    }
  }

  const notFoundFile = stringValue(context, value.notFoundFile, "$.notFoundFile", {
    max: PREBUILT_LIMITS.artifactPathBytes,
  });
  if (notFoundFile !== undefined && notFoundFile !== PREBUILT_NOT_FOUND_FILE) {
    context.add(
      "not_found.not_canonical",
      "$.notFoundFile",
      `Prebuilt schema v1 requires the canonical '${PREBUILT_NOT_FOUND_FILE}' file.`,
    );
  }

  const fileValues = arrayValue(context, value.files, "$.files", { min: 1, max: PREBUILT_LIMITS.files });
  const files = new Map();
  const fileRoutes = new Map();
  const fileOrder = [];
  const caseFoldedPaths = new Map();
  const caseFoldedDirectoryPrefixes = new Map();
  let declaredBytes = 0;
  if (fileValues) {
    for (let index = 0; index < Math.min(fileValues.length, PREBUILT_LIMITS.files); index += 1) {
      const descriptorPath = `$.files[${index}]`;
      const descriptor = fileValues[index];
      if (
        !checkObject(context, descriptor, descriptorPath, ["path", "mediaType", "bytes", "sha256"], [
          "path",
          "mediaType",
          "bytes",
          "sha256",
        ])
      ) continue;
      const candidate = stringValue(context, descriptor.path, `${descriptorPath}.path`, {
        max: PREBUILT_LIMITS.artifactPathBytes,
      });
      if (candidate !== undefined) {
        const normalized = normalizePrebuiltArtifactPath(candidate);
        if (!normalized.ok) {
          context.add(normalized.code, `${descriptorPath}.path`, normalized.message);
        } else {
          const folded = normalized.value.toLowerCase();
          if (files.has(normalized.value)) {
            context.add(
              "duplicate.file_path",
              `${descriptorPath}.path`,
              `File path '${normalized.value}' is duplicated.`,
            );
          } else if (caseFoldedPaths.has(folded)) {
            context.add(
              "duplicate.file_path_casefold",
              `${descriptorPath}.path`,
              `File path '${normalized.value}' collides with '${
                caseFoldedPaths.get(folded)
              }' after ASCII case-folding.`,
            );
          } else {
            const segments = normalized.value.split("/");
            const directoryPrefixes = [];
            for (let segmentIndex = 1; segmentIndex < segments.length; segmentIndex += 1) {
              const prefix = segments.slice(0, segmentIndex).join("/");
              directoryPrefixes.push({ folded: prefix.toLowerCase(), value: prefix });
            }
            const conflictingPrefix = directoryPrefixes.find((prefix) => caseFoldedPaths.has(prefix.folded));
            const aliasedPrefix = directoryPrefixes.find((prefix) => {
              const existing = caseFoldedDirectoryPrefixes.get(prefix.folded);
              return existing !== undefined && existing.value !== prefix.value;
            });
            if (caseFoldedDirectoryPrefixes.has(folded)) {
              context.add(
                "file.path_collision",
                `${descriptorPath}.path`,
                `File path '${normalized.value}' is already required as a directory by '${
                  caseFoldedDirectoryPrefixes.get(folded).file
                }'.`,
              );
            } else if (conflictingPrefix !== undefined) {
              context.add(
                "file.path_collision",
                `${descriptorPath}.path`,
                `File path '${
                  caseFoldedPaths.get(conflictingPrefix.folded)
                }' cannot also be a parent directory of '${normalized.value}'.`,
              );
            } else if (aliasedPrefix !== undefined) {
              const existing = caseFoldedDirectoryPrefixes.get(aliasedPrefix.folded);
              context.add(
                "duplicate.directory_path_casefold",
                `${descriptorPath}.path`,
                `Parent directory '${aliasedPrefix.value}' collides with '${existing.value}' after ASCII case-folding.`,
              );
            }
            files.set(normalized.value, descriptor);
            caseFoldedPaths.set(folded, normalized.value);
            for (const prefix of directoryPrefixes) {
              if (!caseFoldedDirectoryPrefixes.has(prefix.folded)) {
                caseFoldedDirectoryPrefixes.set(prefix.folded, { file: normalized.value, value: prefix.value });
              }
            }
            const route = prebuiltFileRoute(normalized.value);
            if (!route.ok) context.add(route.code, `${descriptorPath}.path`, route.message);
            else fileRoutes.set(route.value.toLowerCase(), normalized.value);
          }
          fileOrder.push(normalized.value);
        }
      }
      const mediaType = stringValue(context, descriptor.mediaType, `${descriptorPath}.mediaType`, {
        values: PREBUILT_MEDIA_TYPES,
      });
      if (candidate !== undefined && mediaType !== undefined && mediaType !== expectedMediaType(candidate)) {
        context.add(
          "file.media_type",
          `${descriptorPath}.mediaType`,
          `File '${candidate}' must use media type '${expectedMediaType(candidate)}'.`,
        );
      }
      const bytes = integerValue(context, descriptor.bytes, `${descriptorPath}.bytes`, {
        min: 0,
        max: PREBUILT_LIMITS.fileBytes,
      });
      if (bytes !== undefined) declaredBytes += bytes;
      validateHash(context, descriptor.sha256, `${descriptorPath}.sha256`);
    }
    if (fileOrder.some((item, index) => index > 0 && compareCanonicalStrings(fileOrder[index - 1], item) >= 0)) {
      context.add("array.not_sorted", "$.files", "Files must have unique paths sorted lexicographically.");
    }
  }
  if (declaredBytes > PREBUILT_LIMITS.artifactBytes) {
    context.add(
      "limit.artifact_bytes",
      "$.files",
      `Declared prebuilt bytes may not exceed ${PREBUILT_LIMITS.artifactBytes}.`,
    );
  }
  if (!files.has(PREBUILT_NOT_FOUND_FILE)) {
    context.add(
      "not_found.missing",
      "$.notFoundFile",
      `Canonical 404 file '${PREBUILT_NOT_FOUND_FILE}' must be declared.`,
    );
  } else if (files.get(PREBUILT_NOT_FOUND_FILE).mediaType !== "text/html; charset=utf-8") {
    context.add("not_found.media_type", "$.notFoundFile", "The canonical 404 file must be declared as UTF-8 HTML.");
  }

  const resourceValues = arrayValue(context, value.resources, "$.resources", { max: PREBUILT_LIMITS.resources });
  const resources = new Map();
  const resourceFiles = new Map();
  const resourceOrder = [];
  if (resourceValues) {
    for (let index = 0; index < Math.min(resourceValues.length, PREBUILT_LIMITS.resources); index += 1) {
      const resourcePath = `$.resources[${index}]`;
      const resource = resourceValues[index];
      if (!checkObject(context, resource, resourcePath, ["key", "file", "title"], ["key", "file", "title"])) continue;
      const key = stringValue(context, resource.key, `${resourcePath}.key`, {
        max: PREBUILT_LIMITS.resourceKey,
        pattern: RESOURCE_KEY,
      });
      if (key !== undefined) {
        if (resources.has(key)) {
          context.add("duplicate.resource_key", `${resourcePath}.key`, `Resource key '${key}' is duplicated.`);
        } else resources.set(key, resource);
        resourceOrder.push(key);
      }
      const file = stringValue(context, resource.file, `${resourcePath}.file`, {
        max: PREBUILT_LIMITS.artifactPathBytes,
      });
      if (file !== undefined) {
        const normalized = normalizePrebuiltArtifactPath(file);
        if (!normalized.ok) context.add(normalized.code, `${resourcePath}.file`, normalized.message);
        else {
          const descriptor = files.get(normalized.value);
          if (!descriptor) {
            context.add(
              "resource.unknown_file",
              `${resourcePath}.file`,
              `Resource references undeclared file '${normalized.value}'.`,
            );
          } else if (descriptor.mediaType !== "text/html; charset=utf-8") {
            context.add(
              "resource.not_html",
              `${resourcePath}.file`,
              "Stable resources must reference declared UTF-8 HTML files.",
            );
          }
          if (normalized.value === PREBUILT_NOT_FOUND_FILE) {
            context.add(
              "resource.not_found",
              `${resourcePath}.file`,
              "The canonical 404 file may not be assigned a successful-response resource identity.",
            );
          }
          if (resourceFiles.has(normalized.value)) {
            context.add(
              "duplicate.resource_file",
              `${resourcePath}.file`,
              `HTML file '${normalized.value}' is already mapped to resource '${resourceFiles.get(normalized.value)}'.`,
            );
          } else resourceFiles.set(normalized.value, key);
        }
      }
      stringValue(context, resource.title, `${resourcePath}.title`, { max: PREBUILT_LIMITS.title });
    }
    if (
      resourceOrder.some((item, index) => index > 0 && compareCanonicalStrings(resourceOrder[index - 1], item) >= 0)
    ) {
      context.add("array.not_sorted", "$.resources", "Resources must have unique keys sorted lexicographically.");
    }
  }

  const redirectValues = arrayValue(context, value.redirects, "$.redirects", { max: PREBUILT_LIMITS.redirects });
  const redirectSources = new Map();
  const redirectOrder = [];
  if (redirectValues) {
    for (let index = 0; index < Math.min(redirectValues.length, PREBUILT_LIMITS.redirects); index += 1) {
      const redirectPath = `$.redirects[${index}]`;
      const redirect = redirectValues[index];
      if (
        !checkObject(context, redirect, redirectPath, ["from", "toResourceKey", "status"], [
          "from",
          "toResourceKey",
          "status",
        ])
      ) continue;
      const from = stringValue(context, redirect.from, `${redirectPath}.from`, { max: PREBUILT_LIMITS.routeBytes });
      if (from !== undefined) {
        const normalized = normalizePrebuiltRedirectRoute(from);
        if (!normalized.ok) context.add(normalized.code, `${redirectPath}.from`, normalized.message);
        else {
          const folded = normalized.value.toLowerCase();
          if (redirectSources.has(folded)) {
            context.add(
              "duplicate.redirect",
              `${redirectPath}.from`,
              `Redirect source '${normalized.value}' collides with '${redirectSources.get(folded)}'.`,
            );
          }
          if (fileRoutes.has(folded)) {
            context.add(
              "redirect.route_collision",
              `${redirectPath}.from`,
              `Redirect source '${normalized.value}' collides with file route for '${fileRoutes.get(folded)}'.`,
            );
          }
          redirectSources.set(folded, normalized.value);
          redirectOrder.push(normalized.value);
        }
      }
      const target = stringValue(context, redirect.toResourceKey, `${redirectPath}.toResourceKey`, {
        max: PREBUILT_LIMITS.resourceKey,
        pattern: RESOURCE_KEY,
      });
      if (target !== undefined && !resources.has(target)) {
        context.add(
          "redirect.unknown_resource",
          `${redirectPath}.toResourceKey`,
          `Redirect targets unknown resource '${target}'.`,
        );
      }
      integerValue(context, redirect.status, `${redirectPath}.status`, { min: 301, max: 308 });
      if (redirect.status !== 301 && redirect.status !== 308) {
        context.add("redirect.status", `${redirectPath}.status`, "Redirect status must be 301 or 308.");
      }
    }
    if (
      redirectOrder.some((item, index) => index > 0 && compareCanonicalStrings(redirectOrder[index - 1], item) >= 0)
    ) {
      context.add(
        "array.not_sorted",
        "$.redirects",
        "Redirects must have unique source routes sorted lexicographically.",
      );
    }
  }
  return context.finish(value);
}

export function validatePrebuiltManifest(input, options = {}) {
  let manifest = input;
  let objectPreflight;
  const classification = classifyManifestInput(input);
  if (["string", "uint8array", "arraybuffer", "unsupported_binary", "invalid"].includes(classification.kind)) {
    const parsed = parseManifestJson(
      input,
      classification,
      PREBUILT_LIMITS.manifestBytes,
      PREBUILT_LIMITS.manifestObjectDepth,
    );
    if (!parsed.ok) return parsed;
    manifest = parsed.value;
  } else if (classification.kind === "object") {
    objectPreflight = preflightManifestObject(input, { ...PREBUILT_LIMITS, stopAtByteLimit: true });
    if (!objectPreflight.ok) return objectPreflight;
    if (objectPreflight.exceedsByteLimit) {
      return {
        ok: false,
        errors: [{
          code: "manifest.too_large",
          path: "$",
          message: `Canonical prebuilt manifest bytes may not exceed ${PREBUILT_LIMITS.manifestBytes}.`,
        }],
      };
    }
    manifest = objectPreflight.value;
  }
  const supportedResult = snapshotPrebuiltSupportedCapabilities(options);
  if (!supportedResult.ok) return supportedResult;
  const supported = new Set([...PREBUILT_SUPPORTED_CAPABILITIES, ...supportedResult.value]);
  const result = validateRoot(manifest, supported);
  if (!result.ok) return result;
  if (canonicalJsonByteLength(result.value, PREBUILT_LIMITS.manifestBytes) > PREBUILT_LIMITS.manifestBytes) {
    return {
      ok: false,
      errors: [{
        code: "manifest.too_large",
        path: "$",
        message: `Canonical prebuilt manifest bytes may not exceed ${PREBUILT_LIMITS.manifestBytes}.`,
      }],
    };
  }
  return result;
}

export function assertValidPrebuiltManifest(input, options = {}) {
  const result = validatePrebuiltManifest(input, options);
  if (!result.ok) throw new DocsArtifactValidationError(result.errors);
  return result.value;
}

export function serializePrebuiltManifest(input, options = {}) {
  return canonicalJson(assertValidPrebuiltManifest(input, options));
}
