import {
  ASSET_MEDIA_TYPES,
  AUDIENCES,
  FRAGMENT_MEDIA_TYPE,
  FRAGMENT_ROLES,
  HTML_FRAGMENT_CAPABILITY,
  LIMITS,
  RESOURCE_KINDS,
  SCHEMA_VERSION,
  SUPPORTED_CAPABILITIES,
} from "./constants.js";
import { compareCanonicalStrings, DocsArtifactValidationError, ValidationContext } from "./errors.js";
import { canonicalJson, canonicalJsonByteLength, classifyManifestInput, parseManifestJson, preflightManifestObject } from "./json.js";
import { normalizeArtifactPath, normalizeRoute, normalizeSourcePath } from "./path.js";
import {
  classifySupportedLocale,
  hasDisallowedStringCharacters,
  SUPPORTED_LOCALE_MAX_LENGTH,
} from "./text.js";

const RESOURCE_KEY = /^[a-z0-9]+(?:[._:/-][a-z0-9]+)*$/;
const TOKEN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const SEMVER_IDENTIFIER = String.raw`(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER = new RegExp(
  String.raw`^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-${SEMVER_IDENTIFIER}(?:\.${SEMVER_IDENTIFIER})*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`,
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
    if (!Object.hasOwn(value, key)) context.add("property.required", `${path}.${key}`, `Required property '${key}' is missing.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) context.add("property.unsupported", `${path}.${key}`, `Property '${key}' is not supported by schema v${SCHEMA_VERSION}.`);
  }
  return true;
}

function stringValue(context, value, path, { min = 1, max = LIMITS.string, pattern, values } = {}) {
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
  if (value !== value.normalize("NFC")) context.add("string.not_normalized", path, "Strings must use Unicode NFC normalization.");
  if (hasDisallowedStringCharacters(value)) {
    context.add(
      "string.control",
      path,
      "Strings may not contain C0, C1, or bidirectional formatting and override controls.",
    );
  }
  if (pattern && !pattern.test(value)) context.add("string.pattern", path, "String does not match the required canonical form.");
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
  if (value.length < min || value.length > max) context.add("array.length", path, `Array length must be between ${min} and ${max}.`);
  return value;
}

function validateSortedUniqueStrings(context, value, path, options) {
  const values = arrayValue(context, value, path, options);
  if (!values) return [];
  const seen = new Set();
  const parsed = [];
  for (let index = 0; index < Math.min(values.length, options.max); index += 1) {
    const itemPath = `${path}[${index}]`;
    const item = stringValue(context, values[index], itemPath, options.item ?? {});
    if (item === undefined) continue;
    if (seen.has(item)) context.add("duplicate.value", itemPath, `Duplicate value '${item}'.`);
    seen.add(item);
    parsed.push(item);
  }
  if (parsed.some((item, index) => index > 0 && compareCanonicalStrings(parsed[index - 1], item) >= 0)) {
    context.add("array.not_sorted", path, "Array values must be unique and sorted lexicographically.");
  }
  return parsed;
}

function validateHttpsUrl(context, value, path) {
  const candidate = stringValue(context, value, path, { max: LIMITS.url });
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

function validateHash(context, value, path) {
  stringValue(context, value, path, { min: 71, max: 71, pattern: HASH });
}

function validateLocale(context, value, path) {
  const candidate = stringValue(context, value, path, { max: SUPPORTED_LOCALE_MAX_LENGTH });
  if (candidate === undefined) return undefined;
  const classification = classifySupportedLocale(candidate);
  if (classification === "not_canonical") {
    context.add("locale.not_canonical", path, "Locale tags must use the canonical casing of the supported Docs v1 BCP 47 subset.");
  } else if (classification === "unsupported") {
    context.add("locale.invalid", path, "Expected a locale in the supported Docs v1 BCP 47 subset.");
  }
  return candidate;
}

function validateSourceLocation(context, value, path) {
  if (!checkObject(context, value, path, ["path", "url"], ["path", "url", "startLine", "endLine"])) return;
  const sourcePath = stringValue(context, value.path, `${path}.path`, { max: LIMITS.sourcePath });
  if (sourcePath !== undefined) {
    const result = normalizeSourcePath(sourcePath);
    if (!result.ok) context.add(result.code, `${path}.path`, result.message);
  }
  validateHttpsUrl(context, value.url, `${path}.url`);
  const startLine = value.startLine === undefined
    ? undefined
    : integerValue(context, value.startLine, `${path}.startLine`, { min: 1, max: 10_000_000 });
  const endLine = value.endLine === undefined
    ? undefined
    : integerValue(context, value.endLine, `${path}.endLine`, { min: 1, max: 10_000_000 });
  if ((startLine === undefined) !== (endLine === undefined)) {
    context.add("source.line_pair", path, "startLine and endLine must be supplied together.");
  } else if (startLine !== undefined && endLine < startLine) {
    context.add("source.line_order", `${path}.endLine`, "endLine may not precede startLine.");
  }
}

function validateSemanticMetadata(context, value, path) {
  if (!checkObject(context, value, path, ["kind", "audiences", "tags"], ["kind", "audiences", "tags"])) return;
  stringValue(context, value.kind, `${path}.kind`, { values: RESOURCE_KINDS });
  validateSortedUniqueStrings(context, value.audiences, `${path}.audiences`, {
    min: 1,
    max: AUDIENCES.length,
    item: { values: AUDIENCES },
  });
  validateSortedUniqueStrings(context, value.tags, `${path}.tags`, {
    min: 0,
    max: 100,
    item: { max: 100, pattern: TOKEN },
  });
}

function validateFragment(context, value, path, state) {
  if (!checkObject(
    context,
    value,
    path,
    ["key", "role", "path", "mediaType", "bytes", "sha256"],
    ["key", "role", "path", "mediaType", "bytes", "sha256"],
  )) return;
  stringValue(context, value.key, `${path}.key`, { max: 100, pattern: TOKEN });
  stringValue(context, value.role, `${path}.role`, { values: FRAGMENT_ROLES });
  const artifactPath = stringValue(context, value.path, `${path}.path`, { max: LIMITS.artifactPath });
  if (artifactPath !== undefined) {
    const result = normalizeArtifactPath(artifactPath);
    if (!result.ok) context.add(result.code, `${path}.path`, result.message);
    else if (!result.value.startsWith("taproot-docs/fragments/")) {
      context.add("path.fragment_root", `${path}.path`, "Fragment files must live below 'taproot-docs/fragments/'.");
    } else if (state.filePaths.has(result.value)) {
      context.add("duplicate.file_path", `${path}.path`, `Artifact file path '${result.value}' is already declared.`);
    } else {
      state.filePaths.set(result.value, path);
    }
  }
  stringValue(context, value.mediaType, `${path}.mediaType`, { values: [FRAGMENT_MEDIA_TYPE] });
  const bytes = integerValue(context, value.bytes, `${path}.bytes`, { min: 1, max: LIMITS.fragmentBytes });
  if (bytes !== undefined) state.declaredBytes += bytes;
  validateHash(context, value.sha256, `${path}.sha256`);
}

function validateVariant(context, value, path, state, variantLocales) {
  if (!checkObject(
    context,
    value,
    path,
    ["locale", "route", "title", "description", "headings", "source", "fragments"],
    ["locale", "route", "title", "description", "headings", "source", "fragments"],
  )) return;
  const locale = validateLocale(context, value.locale, `${path}.locale`);
  if (locale !== undefined) {
    variantLocales.add(locale);
    if (!state.localeTags.has(locale)) {
      context.add("resource.unknown_locale", `${path}.locale`, `Resource locale '${locale}' is not declared.`);
    }
  }
  const route = stringValue(context, value.route, `${path}.route`, { max: LIMITS.route });
  if (route !== undefined) {
    const result = normalizeRoute(route);
    if (!result.ok) context.add(result.code, `${path}.route`, result.message);
    else if (state.routes.has(result.value)) context.add("duplicate.route", `${path}.route`, `Route '${result.value}' is already assigned.`);
    else state.routes.set(result.value, path);
  }
  stringValue(context, value.title, `${path}.title`, { max: LIMITS.title });
  stringValue(context, value.description, `${path}.description`, { min: 0, max: LIMITS.description });

  const headings = arrayValue(context, value.headings, `${path}.headings`, { min: 0, max: LIMITS.headingsPerVariant });
  const headingIds = new Set();
  if (headings) {
    for (let index = 0; index < Math.min(headings.length, LIMITS.headingsPerVariant); index += 1) {
      const headingPath = `${path}.headings[${index}]`;
      const heading = headings[index];
      if (!checkObject(context, heading, headingPath, ["id", "text", "level"], ["id", "text", "level"])) continue;
      const id = stringValue(context, heading.id, `${headingPath}.id`, { max: 200, pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ });
      if (id !== undefined) {
        if (headingIds.has(id)) context.add("duplicate.heading_id", `${headingPath}.id`, `Heading id '${id}' is duplicated.`);
        headingIds.add(id);
      }
      stringValue(context, heading.text, `${headingPath}.text`, { max: LIMITS.title });
      integerValue(context, heading.level, `${headingPath}.level`, { min: 2, max: 6 });
    }
  }

  validateSourceLocation(context, value.source, `${path}.source`);
  const fragments = arrayValue(context, value.fragments, `${path}.fragments`, { min: 1, max: LIMITS.fragments });
  const fragmentKeys = new Set();
  let bodyCount = 0;
  if (fragments) {
    state.fragmentCount += fragments.length;
    for (let index = 0; index < Math.min(fragments.length, LIMITS.fragments); index += 1) {
      const fragmentPath = `${path}.fragments[${index}]`;
      const fragment = fragments[index];
      validateFragment(context, fragment, fragmentPath, state);
      if (isRecord(fragment) && typeof fragment.key === "string") {
        if (fragmentKeys.has(fragment.key)) context.add("duplicate.fragment_key", `${fragmentPath}.key`, `Fragment key '${fragment.key}' is duplicated in this variant.`);
        fragmentKeys.add(fragment.key);
      }
      if (isRecord(fragment) && fragment.role === "body") bodyCount += 1;
    }
  }
  if (bodyCount !== 1) context.add("fragment.body_count", `${path}.fragments`, "Each resource variant must declare exactly one body fragment.");
}

function validateResource(context, value, path, state) {
  if (!checkObject(context, value, path, ["key", "semantic", "variants"], ["key", "semantic", "variants"])) return;
  const key = stringValue(context, value.key, `${path}.key`, { max: LIMITS.resourceKey, pattern: RESOURCE_KEY });
  if (key !== undefined) {
    if (state.resources.has(key)) context.add("duplicate.resource_key", `${path}.key`, `Resource key '${key}' is duplicated.`);
    else state.resources.set(key, value);
  }
  validateSemanticMetadata(context, value.semantic, `${path}.semantic`);
  const variants = arrayValue(context, value.variants, `${path}.variants`, { min: 1, max: LIMITS.variants });
  const variantLocales = new Set();
  if (variants) {
    state.variantCount += variants.length;
    for (let index = 0; index < Math.min(variants.length, LIMITS.variants); index += 1) {
      validateVariant(context, variants[index], `${path}.variants[${index}]`, state, variantLocales);
    }
    const validLocales = variants.filter(isRecord).map((variant) => variant.locale).filter((locale) => typeof locale === "string");
    if (validLocales.some((locale, index) => index > 0 && compareCanonicalStrings(validLocales[index - 1], locale) >= 0)) {
      context.add("array.not_sorted", `${path}.variants`, "Resource variants must have unique locale tags sorted lexicographically.");
    }
  }
  if (state.defaultLocale !== undefined && !variantLocales.has(state.defaultLocale)) {
    context.add("resource.default_locale", `${path}.variants`, `Resource must include the default locale '${state.defaultLocale}'.`);
  }
}

function validateNavigationItems(context, items, path, state, locale, navigationResources, depth) {
  if (state.navigationLimitExceeded) return;
  if (depth > LIMITS.navigationDepth) {
    context.add("navigation.too_deep", path, `Navigation may not exceed ${LIMITS.navigationDepth} levels.`);
    return;
  }
  for (let index = 0; index < items.length; index += 1) {
    if (state.navigationLimitExceeded) return;
    if (state.navigationNodeCount >= LIMITS.navigationNodes) {
      context.add("limit.navigation_nodes", "$.navigation", `Artifact may not declare more than ${LIMITS.navigationNodes} navigation nodes.`);
      state.navigationLimitExceeded = true;
      return;
    }
    state.navigationNodeCount += 1;
    const nodePath = `${path}[${index}]`;
    const node = items[index];
    if (!checkObject(context, node, nodePath, ["label"], ["label", "resourceKey", "children"])) continue;
    stringValue(context, node.label, `${nodePath}.label`, { max: LIMITS.title });
    let hasResource = false;
    if (node.resourceKey !== undefined) {
      const resourceKey = stringValue(context, node.resourceKey, `${nodePath}.resourceKey`, { max: LIMITS.resourceKey, pattern: RESOURCE_KEY });
      hasResource = resourceKey !== undefined;
      if (resourceKey !== undefined) {
        const resource = state.resources.get(resourceKey);
        if (!resource) context.add("navigation.unknown_resource", `${nodePath}.resourceKey`, `Navigation references unknown resource '${resourceKey}'.`);
        else if (!Array.isArray(resource.variants) || !resource.variants.some((variant) => variant?.locale === locale)) {
          context.add("navigation.missing_locale", `${nodePath}.resourceKey`, `Resource '${resourceKey}' has no '${locale}' variant.`);
        }
        if (navigationResources.has(resourceKey)) context.add("navigation.duplicate_resource", `${nodePath}.resourceKey`, `Resource '${resourceKey}' appears more than once in '${locale}' navigation.`);
        navigationResources.add(resourceKey);
      }
    }
    let children = [];
    if (node.children !== undefined) {
      children = arrayValue(context, node.children, `${nodePath}.children`, { min: 1, max: LIMITS.navigationNodes }) ?? [];
    }
    if (!hasResource && children.length === 0) context.add("navigation.empty_node", nodePath, "A navigation node must reference a resource or contain child nodes.");
    if (children.length > 0) {
      validateNavigationItems(context, children, `${nodePath}.children`, state, locale, navigationResources, depth + 1);
    }
  }
}

function validateRoot(value, supportedCapabilities) {
  const context = new ValidationContext();
  if (!checkObject(
    context,
    value,
    "$",
    ["schemaVersion", "defaultLocale", "source", "build", "capabilities", "locales", "resources", "navigation", "redirects", "assets"],
    ["schemaVersion", "defaultLocale", "source", "build", "capabilities", "locales", "resources", "navigation", "redirects", "assets"],
  )) return context.finish(value);

  const schemaVersion = integerValue(context, value.schemaVersion, "$.schemaVersion", { min: SCHEMA_VERSION, max: SCHEMA_VERSION });
  if (schemaVersion !== undefined && schemaVersion !== SCHEMA_VERSION) {
    context.add("schema.unsupported", "$.schemaVersion", `Only schemaVersion ${SCHEMA_VERSION} is supported.`);
  }
  const defaultLocale = validateLocale(context, value.defaultLocale, "$.defaultLocale");

  if (checkObject(context, value.source, "$.source", ["provider", "repositoryId", "repository", "repositoryUrl", "revision", "ref"], ["provider", "repositoryId", "repository", "repositoryUrl", "revision", "ref"])) {
    stringValue(context, value.source.provider, "$.source.provider", { values: ["github"] });
    stringValue(context, value.source.repositoryId, "$.source.repositoryId", { max: 200, pattern: /^[A-Za-z0-9_.:-]+$/ });
    stringValue(context, value.source.repository, "$.source.repository", { max: 300, pattern: REPOSITORY });
    validateHttpsUrl(context, value.source.repositoryUrl, "$.source.repositoryUrl");
    stringValue(context, value.source.revision, "$.source.revision", { min: 40, max: 64, pattern: REVISION });
    stringValue(context, value.source.ref, "$.source.ref", { max: 500, pattern: REF });
  }

  if (checkObject(context, value.build, "$.build", ["producer", "producerVersion", "configurationSha256", "sourceDateEpoch"], ["producer", "producerVersion", "configurationSha256", "sourceDateEpoch"])) {
    stringValue(context, value.build.producer, "$.build.producer", { max: 200, pattern: /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/ });
    stringValue(context, value.build.producerVersion, "$.build.producerVersion", { max: 100, pattern: SEMVER });
    validateHash(context, value.build.configurationSha256, "$.build.configurationSha256");
    integerValue(context, value.build.sourceDateEpoch, "$.build.sourceDateEpoch", { min: 0, max: 253_402_300_799 });
  }

  if (checkObject(context, value.capabilities, "$.capabilities", ["required", "optional"], ["required", "optional"])) {
    const required = validateSortedUniqueStrings(context, value.capabilities.required, "$.capabilities.required", {
      min: 1,
      max: 100,
      item: { max: 200, pattern: RESOURCE_KEY },
    });
    const optional = validateSortedUniqueStrings(context, value.capabilities.optional, "$.capabilities.optional", {
      min: 0,
      max: 100,
      item: { max: 200, pattern: RESOURCE_KEY },
    });
    if (!required.includes(HTML_FRAGMENT_CAPABILITY)) {
      context.add("capability.missing", "$.capabilities.required", `Schema v${SCHEMA_VERSION} requires '${HTML_FRAGMENT_CAPABILITY}'.`);
    }
    for (let index = 0; index < required.length; index += 1) {
      if (!supportedCapabilities.has(required[index])) {
        context.add("capability.unsupported", `$.capabilities.required[${index}]`, `Required capability '${required[index]}' is not supported.`);
      }
    }
    for (const capability of optional) {
      if (required.includes(capability)) context.add("duplicate.capability", "$.capabilities", `Capability '${capability}' cannot be both required and optional.`);
    }
  }

  const locales = arrayValue(context, value.locales, "$.locales", { min: 1, max: 100 });
  const localeTags = new Set();
  if (locales) {
    const order = [];
    for (let index = 0; index < Math.min(locales.length, 100); index += 1) {
      const localePath = `$.locales[${index}]`;
      const locale = locales[index];
      if (!checkObject(context, locale, localePath, ["tag", "label"], ["tag", "label"])) continue;
      const tag = validateLocale(context, locale.tag, `${localePath}.tag`);
      if (tag !== undefined) {
        if (localeTags.has(tag)) context.add("duplicate.locale", `${localePath}.tag`, `Locale '${tag}' is duplicated.`);
        localeTags.add(tag);
        order.push(tag);
      }
      stringValue(context, locale.label, `${localePath}.label`, { max: 100 });
    }
    if (order.some((item, index) => index > 0 && compareCanonicalStrings(order[index - 1], item) >= 0)) {
      context.add("array.not_sorted", "$.locales", "Locales must be unique and sorted by tag.");
    }
  }
  if (defaultLocale !== undefined && !localeTags.has(defaultLocale)) {
    context.add("locale.default_missing", "$.defaultLocale", `Default locale '${defaultLocale}' is not declared in locales.`);
  }

  const state = {
    defaultLocale,
    localeTags,
    resources: new Map(),
    routes: new Map(),
    filePaths: new Map(),
    variantCount: 0,
    fragmentCount: 0,
    declaredBytes: 0,
    navigationNodeCount: 0,
    navigationLimitExceeded: false,
  };
  const resources = arrayValue(context, value.resources, "$.resources", { min: 1, max: LIMITS.resources });
  const resourceOrder = [];
  if (resources) {
    for (let index = 0; index < Math.min(resources.length, LIMITS.resources); index += 1) {
      validateResource(context, resources[index], `$.resources[${index}]`, state);
      if (isRecord(resources[index]) && typeof resources[index].key === "string") resourceOrder.push(resources[index].key);
    }
    if (resourceOrder.some((item, index) => index > 0 && compareCanonicalStrings(resourceOrder[index - 1], item) >= 0)) {
      context.add("array.not_sorted", "$.resources", "Resources must have unique keys sorted lexicographically.");
    }
  }
  if (state.variantCount > LIMITS.variants) context.add("limit.variants", "$.resources", `Artifact may not declare more than ${LIMITS.variants} resource variants.`);
  if (state.fragmentCount > LIMITS.fragments) context.add("limit.fragments", "$.resources", `Artifact may not declare more than ${LIMITS.fragments} fragments.`);

  const assets = arrayValue(context, value.assets, "$.assets", { min: 0, max: LIMITS.assets });
  const assetKeys = new Set();
  const assetOrder = [];
  if (assets) {
    for (let index = 0; index < Math.min(assets.length, LIMITS.assets); index += 1) {
      const assetPath = `$.assets[${index}]`;
      const asset = assets[index];
      if (!checkObject(context, asset, assetPath, ["key", "path", "mediaType", "bytes", "sha256", "width", "height"], ["key", "path", "mediaType", "bytes", "sha256", "width", "height"])) continue;
      const key = stringValue(context, asset.key, `${assetPath}.key`, { max: LIMITS.resourceKey, pattern: RESOURCE_KEY });
      if (key !== undefined) {
        if (assetKeys.has(key)) context.add("duplicate.asset_key", `${assetPath}.key`, `Asset key '${key}' is duplicated.`);
        assetKeys.add(key);
        assetOrder.push(key);
      }
      const path = stringValue(context, asset.path, `${assetPath}.path`, { max: LIMITS.artifactPath });
      if (path !== undefined) {
        const result = normalizeArtifactPath(path);
        if (!result.ok) context.add(result.code, `${assetPath}.path`, result.message);
        else if (!result.value.startsWith("taproot-docs/assets/")) context.add("path.asset_root", `${assetPath}.path`, "Asset files must live below 'taproot-docs/assets/'.");
        else if (state.filePaths.has(result.value)) context.add("duplicate.file_path", `${assetPath}.path`, `Artifact file path '${result.value}' is already declared.`);
        else state.filePaths.set(result.value, assetPath);
      }
      stringValue(context, asset.mediaType, `${assetPath}.mediaType`, { values: ASSET_MEDIA_TYPES });
      const bytes = integerValue(context, asset.bytes, `${assetPath}.bytes`, { min: 1, max: LIMITS.assetBytes });
      if (bytes !== undefined) state.declaredBytes += bytes;
      validateHash(context, asset.sha256, `${assetPath}.sha256`);
      const width = integerValue(context, asset.width, `${assetPath}.width`, { min: 1, max: 32_768 });
      const height = integerValue(context, asset.height, `${assetPath}.height`, { min: 1, max: 32_768 });
      if (width !== undefined && height !== undefined && width * height > LIMITS.decodedPixels) {
        context.add("asset.decoded_pixels", assetPath, `Asset dimensions may not exceed ${LIMITS.decodedPixels} decoded pixels.`);
      }
    }
    if (assetOrder.some((item, index) => index > 0 && compareCanonicalStrings(assetOrder[index - 1], item) >= 0)) {
      context.add("array.not_sorted", "$.assets", "Assets must have unique keys sorted lexicographically.");
    }
  }
  if (state.filePaths.size > LIMITS.files) context.add("limit.files", "$", `Artifact may not declare more than ${LIMITS.files} files.`);
  if (state.declaredBytes > LIMITS.artifactBytes) context.add("limit.artifact_bytes", "$", `Declared artifact bytes may not exceed ${LIMITS.artifactBytes}.`);

  const navigation = arrayValue(context, value.navigation, "$.navigation", { min: 1, max: 100 });
  const navigationLocales = new Set();
  const navigationOrder = [];
  if (navigation) {
    for (let index = 0; index < Math.min(navigation.length, 100); index += 1) {
      const navigationPath = `$.navigation[${index}]`;
      const localeNavigation = navigation[index];
      if (!checkObject(context, localeNavigation, navigationPath, ["locale", "items"], ["locale", "items"])) continue;
      const locale = validateLocale(context, localeNavigation.locale, `${navigationPath}.locale`);
      if (locale !== undefined) {
        if (!localeTags.has(locale)) context.add("navigation.unknown_locale", `${navigationPath}.locale`, `Navigation locale '${locale}' is not declared.`);
        if (navigationLocales.has(locale)) context.add("duplicate.navigation_locale", `${navigationPath}.locale`, `Navigation for '${locale}' is duplicated.`);
        navigationLocales.add(locale);
        navigationOrder.push(locale);
      }
      const items = arrayValue(context, localeNavigation.items, `${navigationPath}.items`, { min: 1, max: LIMITS.navigationNodes }) ?? [];
      validateNavigationItems(context, items, `${navigationPath}.items`, state, locale, new Set(), 1);
    }
    if (navigationOrder.some((item, index) => index > 0 && compareCanonicalStrings(navigationOrder[index - 1], item) >= 0)) {
      context.add("array.not_sorted", "$.navigation", "Navigation sets must have unique locale tags sorted lexicographically.");
    }
  }
  for (const locale of localeTags) {
    if (!navigationLocales.has(locale)) context.add("navigation.locale_missing", "$.navigation", `Locale '${locale}' must have a navigation tree.`);
  }
  const redirects = arrayValue(context, value.redirects, "$.redirects", { min: 0, max: LIMITS.redirects });
  const redirectSources = new Set();
  const redirectOrder = [];
  if (redirects) {
    for (let index = 0; index < Math.min(redirects.length, LIMITS.redirects); index += 1) {
      const redirectPath = `$.redirects[${index}]`;
      const redirect = redirects[index];
      if (!checkObject(context, redirect, redirectPath, ["from", "toResourceKey", "locale", "status"], ["from", "toResourceKey", "locale", "status"])) continue;
      const from = stringValue(context, redirect.from, `${redirectPath}.from`, { max: LIMITS.route });
      if (from !== undefined) {
        const result = normalizeRoute(from);
        if (!result.ok) context.add(result.code, `${redirectPath}.from`, result.message);
        else {
          if (redirectSources.has(result.value)) context.add("duplicate.redirect", `${redirectPath}.from`, `Redirect source '${result.value}' is duplicated.`);
          if (state.routes.has(result.value)) context.add("redirect.route_collision", `${redirectPath}.from`, `Redirect source '${result.value}' collides with a resource route.`);
          redirectSources.add(result.value);
          redirectOrder.push(result.value);
        }
      }
      const targetKey = stringValue(context, redirect.toResourceKey, `${redirectPath}.toResourceKey`, { max: LIMITS.resourceKey, pattern: RESOURCE_KEY });
      const locale = validateLocale(context, redirect.locale, `${redirectPath}.locale`);
      const target = targetKey === undefined ? undefined : state.resources.get(targetKey);
      if (targetKey !== undefined && !target) context.add("redirect.unknown_resource", `${redirectPath}.toResourceKey`, `Redirect targets unknown resource '${targetKey}'.`);
      if (locale !== undefined && !localeTags.has(locale)) context.add("redirect.unknown_locale", `${redirectPath}.locale`, `Redirect locale '${locale}' is not declared.`);
      if (target && locale !== undefined && (!Array.isArray(target.variants) || !target.variants.some((variant) => variant?.locale === locale))) {
        context.add("redirect.missing_locale", `${redirectPath}.locale`, `Redirect target '${targetKey}' has no '${locale}' variant.`);
      }
      integerValue(context, redirect.status, `${redirectPath}.status`, { min: 301, max: 308 });
      if (redirect.status !== 301 && redirect.status !== 308) context.add("redirect.status", `${redirectPath}.status`, "Redirect status must be 301 or 308.");
    }
    if (redirectOrder.some((item, index) => index > 0 && compareCanonicalStrings(redirectOrder[index - 1], item) >= 0)) {
      context.add("array.not_sorted", "$.redirects", "Redirects must have unique source routes sorted lexicographically.");
    }
  }

  return context.finish(value);
}

function invalidSupportedCapabilityResult() {
  return {
    ok: false,
    errors: [{
      code: "capability.invalid_value",
      path: "$options.supportedCapabilities",
      message: `Supported capabilities must be canonical strings of at most ${LIMITS.resourceKey} characters.`,
    }],
  };
}

function invalidSupportedCapabilitiesIterableResult() {
  return {
    ok: false,
    errors: [{
      code: "capability.invalid_iterable",
      path: "$options.supportedCapabilities",
      message: "Could not enumerate supported capabilities safely.",
    }],
  };
}

export function snapshotSupportedCapabilities(options) {
  let iterable;
  try {
    iterable = options?.supportedCapabilities;
  } catch {
    return invalidSupportedCapabilitiesIterableResult();
  }
  if (iterable === undefined) return { ok: true, value: Object.freeze([]) };
  if (typeof iterable === "string") return invalidSupportedCapabilitiesIterableResult();
  const supported = [];
  try {
    for (const capability of iterable) {
      if (supported.length >= LIMITS.supportedCapabilities) {
        return {
          ok: false,
          errors: [{
            code: "limit.supported_capabilities",
            path: "$options.supportedCapabilities",
            message: `Supported capabilities may not contain more than ${LIMITS.supportedCapabilities} entries.`,
          }],
        };
      }
      if (typeof capability !== "string") {
        return invalidSupportedCapabilityResult();
      }
      if (capability.length > LIMITS.resourceKey * 2) {
        return invalidSupportedCapabilityResult();
      }
      const validation = new ValidationContext();
      stringValue(validation, capability, "$capability", { max: LIMITS.resourceKey, pattern: RESOURCE_KEY });
      if (validation.errors.length > 0) {
        return invalidSupportedCapabilityResult();
      }
      supported.push(capability);
    }
  } catch {
    return invalidSupportedCapabilitiesIterableResult();
  }
  return { ok: true, value: Object.freeze(supported) };
}

export function validateManifest(input, options = {}) {
  let manifest = input;
  let objectPreflight;
  const classification = classifyManifestInput(input);
  if (["string", "uint8array", "arraybuffer", "unsupported_binary", "invalid"].includes(classification.kind)) {
    const parsed = parseManifestJson(input, classification);
    if (!parsed.ok) return parsed;
    manifest = parsed.value;
  } else if (classification.kind === "object") {
    objectPreflight = preflightManifestObject(input);
    if (!objectPreflight.ok) return objectPreflight;
    manifest = objectPreflight.value;
  }
  const supportedResult = snapshotSupportedCapabilities(options);
  if (!supportedResult.ok) return supportedResult;
  const supported = new Set([...SUPPORTED_CAPABILITIES, ...supportedResult.value]);
  const result = validateRoot(manifest, supported);
  if (!result.ok) return result;
  if (objectPreflight?.exceedsByteLimit || canonicalJsonByteLength(result.value, LIMITS.manifestBytes) > LIMITS.manifestBytes) {
    return {
      ok: false,
      errors: [{
        code: "manifest.too_large",
        path: "$",
        message: `Canonical manifest bytes may not exceed ${LIMITS.manifestBytes}.`,
      }],
    };
  }
  return result;
}

export function assertValidManifest(input, options = {}) {
  const result = validateManifest(input, options);
  if (!result.ok) throw new DocsArtifactValidationError(result.errors);
  return result.value;
}

export function serializeManifest(input, options = {}) {
  return canonicalJson(assertValidManifest(input, options));
}
