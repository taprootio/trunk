import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { NAVIGATION_MAXIMUM_DEPTH, TEMPLATE_TYPE_FREE_FORM } from "../api.js";
import { freeFormRootPresentation, sharedThemeContextNames } from "../content/free-form-sections.js";
import { VERB_VALIDATE } from "../constants.js";
import { isCanonicalUuid, SiteAuthoringError } from "../errors.js";
import {
  FIXTURE_CONTRACT_VERSION,
  FIXTURE_DELIVERY_ORIGIN_DOMAIN,
  FIXTURE_MANIFEST_FILE_NAME,
  FIXTURE_MAXIMUM_DELIVERY_ORIGINS,
  FIXTURE_METADATA_FIELDS,
  FIXTURE_ROOT_FIELDS,
} from "../fixture-contract.js";
import { FOOTER_SETTINGS_FILE } from "../footer-workspace.js";
import { boundedList, successResult } from "../session.js";
import { SETTINGS_GROUPS, SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES } from "../settings-catalog.js";
import { validateFooterWorkspaceDocument } from "./footer-push.js";
import { validateNavigationWorkspaceDocument } from "./nav-push.js";
import { validateWorkspacePageDocument, validateWorkspacePageSource } from "./pages-push.js";
import { validateThemeWorkspace } from "./theme-push.js";
import {
  MANIFEST_VERSION,
  NAVIGATION_FILE_NAME,
  normalizePagePath,
  PAGE_SOURCE_EXTENSIONS,
  PAGE_WORKSPACE_MODE_EDITABLE,
  pageSourceFormat,
  PAGES_DIRECTORY,
  readWorkspaceJson,
  SETTINGS_DIRECTORY,
  walkWorkspaceFiles,
  WORKSPACE_LIMITS,
} from "../workspace.js";

const MAXIMUM_REPORTED = 200;
const FIXTURE_ROOT_KEYS = new Set(FIXTURE_ROOT_FIELDS);
const FIXTURE_METADATA_KEYS = new Set(FIXTURE_METADATA_FIELDS);

function fail(code, message, field, exitCode) {
  throw new SiteAuthoringError(code, message, { field, exitCode });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function resolveFixtureRoot(cwd, fixturePath) {
  if (typeof fixturePath !== "string" || fixturePath.length === 0) {
    fail("validate.fixture_path_invalid", "validate requires exactly one fixture directory.", "fixturePath", 2);
  }
  const candidate = path.resolve(cwd, fixturePath);
  let stat;
  try {
    stat = await lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      fail("fixture.not_found", "The selected authoring fixture directory does not exist.", "fixturePath");
    }
    fail(
      "fixture.path_invalid",
      "The selected authoring fixture directory could not be inspected.",
      "fixturePath",
    );
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail("fixture.path_invalid", "The selected authoring fixture must be a real directory, not a link or file.", "fixturePath");
  }
  try {
    return await realpath(candidate);
  } catch {
    fail(
      "fixture.path_invalid",
      "The selected authoring fixture directory could not be inspected.",
      "fixturePath",
    );
  }
}

function validateFixtureManifest(manifest) {
  if (!isPlainObject(manifest)) {
    fail("fixture.manifest_invalid", `${FIXTURE_MANIFEST_FILE_NAME} must contain one JSON object.`, FIXTURE_MANIFEST_FILE_NAME);
  }
  const unknownRoot = Object.keys(manifest).filter((key) => !FIXTURE_ROOT_KEYS.has(key)).sort();
  if (unknownRoot.length > 0) {
    fail(
      "fixture.manifest_unknown_field",
      `${FIXTURE_MANIFEST_FILE_NAME} declares unsupported field '${unknownRoot[0]}'.`,
      unknownRoot[0],
    );
  }
  if (manifest.manifestVersion !== MANIFEST_VERSION) {
    fail(
      "fixture.manifest_version",
      `${FIXTURE_MANIFEST_FILE_NAME} must use page manifest version ${MANIFEST_VERSION}.`,
      "manifestVersion",
    );
  }
  if (!isCanonicalUuid(manifest.siteId)) {
    fail("fixture.site_id_invalid", "The fixture siteId must be a deterministic canonical UUID.", "siteId");
  }
  if (!Array.isArray(manifest.pages) || manifest.pages.length === 0 || manifest.pages.length > WORKSPACE_LIMITS.files) {
    fail("fixture.pages_invalid", "The fixture manifest must bind one or more bounded editable pages.", "pages");
  }
  if (manifest.pagesTruncated !== false) {
    fail("fixture.pages_invalid", "A complete offline fixture cannot use a truncated page manifest.", "pagesTruncated");
  }
  if (
    !isPlainObject(manifest.navigation)
    || manifest.navigation.file !== NAVIGATION_FILE_NAME
    || !Number.isSafeInteger(manifest.navigation.items)
    || manifest.navigation.items < 0
  ) {
    fail(
      "fixture.navigation_invalid",
      `The fixture manifest must bind '${NAVIGATION_FILE_NAME}' and its non-negative item count.`,
      "navigation",
    );
  }
  if (!Array.isArray(manifest.settingsSkipped) || manifest.settingsSkipped.length !== 0) {
    fail(
      "fixture.settings_invalid",
      "A complete offline fixture cannot omit an authorable settings group.",
      "settingsSkipped",
    );
  }
  if (!isPlainObject(manifest.fixture)) {
    fail("fixture.metadata_invalid", "The fixture manifest must declare versioned offline metadata.", "fixture");
  }
  const unknownMetadata = Object.keys(manifest.fixture).filter((key) => !FIXTURE_METADATA_KEYS.has(key)).sort();
  if (unknownMetadata.length > 0) {
    fail(
      "fixture.metadata_unknown_field",
      `fixture declares unsupported field '${unknownMetadata[0]}'.`,
      `fixture.${unknownMetadata[0]}`,
    );
  }
  if (manifest.fixture.contractVersion !== FIXTURE_CONTRACT_VERSION) {
    fail(
      "fixture.contract_version",
      `fixture.contractVersion must be ${FIXTURE_CONTRACT_VERSION}.`,
      "fixture.contractVersion",
    );
  }
  if (
    !Array.isArray(manifest.fixture.imageIds)
    || manifest.fixture.imageIds.length > WORKSPACE_LIMITS.files
    || manifest.fixture.imageIds.some((value) => !isCanonicalUuid(value))
  ) {
    fail(
      "fixture.image_ids_invalid",
      "fixture.imageIds must be a bounded list of deterministic canonical UUIDs.",
      "fixture.imageIds",
    );
  }
  const imageIds = new Set(manifest.fixture.imageIds);
  if (imageIds.size !== manifest.fixture.imageIds.length) {
    fail("fixture.image_ids_invalid", "fixture.imageIds must not contain duplicates.", "fixture.imageIds");
  }
  if (
    !Array.isArray(manifest.fixture.deliveryOrigins)
    || manifest.fixture.deliveryOrigins.length > FIXTURE_MAXIMUM_DELIVERY_ORIGINS
  ) {
    fail(
      "fixture.delivery_origins_invalid",
      "fixture.deliveryOrigins must be a bounded list of reserved HTTPS example origins.",
      "fixture.deliveryOrigins",
    );
  }
  const deliveryOrigins = new Set();
  for (const [index, value] of manifest.fixture.deliveryOrigins.entries()) {
    let url;
    try {
      url = new URL(value);
    } catch {
      url = undefined;
    }
    if (
      url === undefined
      || url.protocol !== "https:"
      || url.username !== ""
      || url.password !== ""
      || url.pathname !== "/"
      || url.search !== ""
      || url.hash !== ""
      || !(
        url.hostname === FIXTURE_DELIVERY_ORIGIN_DOMAIN
        || url.hostname.endsWith(`.${FIXTURE_DELIVERY_ORIGIN_DOMAIN}`)
      )
    ) {
      fail(
        "fixture.delivery_origins_invalid",
        `Every fixture delivery origin must be an origin-only HTTPS URL under the reserved ${FIXTURE_DELIVERY_ORIGIN_DOMAIN} domain.`,
        `fixture.deliveryOrigins[${index}]`,
      );
    }
    deliveryOrigins.add(url.origin);
  }
  if (deliveryOrigins.size !== manifest.fixture.deliveryOrigins.length) {
    fail(
      "fixture.delivery_origins_invalid",
      "fixture.deliveryOrigins must not contain duplicate origins.",
      "fixture.deliveryOrigins",
    );
  }

  if (!Array.isArray(manifest.settings) || manifest.settings.length !== SETTINGS_GROUPS.length) {
    fail(
      "fixture.settings_invalid",
      `The fixture manifest must bind exactly ${SETTINGS_GROUPS.length} authorable settings documents.`,
      "settings",
    );
  }
  const settingsEntityIds = new Map();
  for (const group of SETTINGS_GROUPS) {
    const expectedFile = `${SETTINGS_DIRECTORY}/${group.file}`;
    const entry = manifest.settings.find((candidate) => candidate?.settingsType === group.settingsType);
    if (
      !isPlainObject(entry)
      || entry.file !== expectedFile
      || !isCanonicalUuid(entry.entityId)
    ) {
      fail(
        "fixture.settings_invalid",
        `The fixture manifest must bind ${group.settingsType} to '${expectedFile}' and one deterministic entityId.`,
        "settings",
      );
    }
    settingsEntityIds.set(group.settingsType, entry.entityId);
  }

  const pageIds = new Set();
  const resourceIds = new Set();
  const files = new Set();
  const paths = new Set();
  for (const [index, entry] of manifest.pages.entries()) {
    const field = `pages[${index}]`;
    const pagePath = normalizePagePath(entry?.path);
    const extension = typeof entry?.file === "string"
      ? PAGE_SOURCE_EXTENSIONS.find((candidate) => entry.file.toLowerCase().endsWith(candidate))
      : undefined;
    if (
      !isPlainObject(entry)
      || !isCanonicalUuid(entry.pageId)
      || !isCanonicalUuid(entry.resourceId)
      || entry.templateType !== TEMPLATE_TYPE_FREE_FORM
      || entry.workspaceMode !== PAGE_WORKSPACE_MODE_EDITABLE
      || typeof entry.file !== "string"
      || !entry.file.startsWith(`${PAGES_DIRECTORY}/`)
      || extension === undefined
      || pagePath === undefined
    ) {
      fail(
        "fixture.page_invalid",
        `${field} must bind one editable free-form source to deterministic page/resource identities and a usable path.`,
        field,
      );
    }
    // A fixture is an example of what pull writes, so it declares the source
    // registry the same way. The file's extension decides the format; a
    // recorded one that disagrees is describing a file that is not there.
    if (entry.sourceFormat !== pageSourceFormat(entry.file)) {
      fail(
        "fixture.page_invalid",
        `${field} must record sourceFormat '${pageSourceFormat(entry.file)}' for '${entry.file}'.`,
        `${field}.sourceFormat`,
      );
    }
    if (pageIds.has(entry.pageId) || resourceIds.has(entry.resourceId) || files.has(entry.file) || paths.has(pagePath)) {
      fail(
        "fixture.page_duplicate",
        `${field} duplicates a pageId, resourceId, source file, or page path.`,
        field,
      );
    }
    pageIds.add(entry.pageId);
    resourceIds.add(entry.resourceId);
    files.add(entry.file);
    paths.add(pagePath);
  }
  return { manifest, imageIds, deliveryOrigins, pageIds, resourceIds, files, settingsEntityIds };
}

function validateDeliveryUrl(value, field, deliveryOrigins) {
  if (typeof value !== "string" || value === "" || value.startsWith("/") || value.startsWith("./")) return;
  let url;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (!deliveryOrigins.has(url.origin)) {
    fail(
      "fixture.delivery_origin_unknown",
      `Fixture image delivery URL '${url.origin}' is not declared in fixture.deliveryOrigins.`,
      field,
    );
  }
}

function validatePageImageReferences(value, field, knownImageIds, deliveryOrigins) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      validatePageImageReferences(entry, `${field}/${index}`, knownImageIds, deliveryOrigins)
    );
    return;
  }
  if (!isPlainObject(value)) return;

  if (typeof value.imageId === "string" && (Object.hasOwn(value, "src") || Object.hasOwn(value, "urls"))) {
    if (!knownImageIds.has(value.imageId)) {
      fail(
        "fixture.image_reference_unknown",
        `Fixture image '${value.imageId}' is not declared in fixture.imageIds.`,
        `${field}/imageId`,
      );
    }
    validateDeliveryUrl(value.src, `${field}/src`, deliveryOrigins);
    if (Array.isArray(value.urls)) {
      for (const [index, candidate] of value.urls.entries()) {
        validateDeliveryUrl(candidate?.url, `${field}/urls/${index}/url`, deliveryOrigins);
      }
    }
  }

  if (value.type === "componentBlock" && typeof value.attrs?.componentData === "string") {
    // The shared document validator already proved this is valid JSON with the
    // component's closed shape. Parsing it here only binds its image identities
    // to the offline fixture metadata.
    validatePageImageReferences(
      JSON.parse(value.attrs.componentData),
      `${field}/attrs/componentData`,
      knownImageIds,
      deliveryOrigins,
    );
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "componentData") continue;
    validatePageImageReferences(child, `${field}/${key}`, knownImageIds, deliveryOrigins);
  }
}

/** Whether a validated page document places a root-band component at its root. */
function pageUsesRootBand(document) {
  return Array.isArray(document?.content)
    && document.content.some((node) => freeFormRootPresentation(node)?.rootPlacement === "root-band");
}

/**
 * Advisory only: a root-band component spans the viewport, so a header whose
 * brand and buttons stop at the content edges usually reads as misaligned
 * beside it. The wide header with the centered menu is the recommended pair,
 * never a requirement, so this is a hint in the result and on stderr, not a
 * failure (TR00697).
 */
function headerWidthHints(headerWidth, rootBandPages) {
  if (rootBandPages.length === 0 || headerWidth === "wide") return [];
  const pages = boundedList(rootBandPages, MAXIMUM_REPORTED);
  return [{
    code: "header.width_contained_with_root_band",
    message: `${rootBandPages.length} page(s) use a full-bleed root-band component while site-header.headerWidth is `
      + `'${headerWidth}'. Full-bleed designs usually read better with headerWidth 'wide' (brand and buttons at the `
      + "viewport edges) paired with headerLayout 'centered-menu'.",
    setting: "site-header.headerWidth",
    suggested: { headerWidth: "wide", headerLayout: "centered-menu" },
    pages: pages.items,
    ...(pages.truncated ? { pagesTruncated: true } : {}),
  }];
}

export async function validateFixture(invocation = {}) {
  const onProgress = typeof invocation.onProgress === "function" ? invocation.onProgress : () => {};
  const fixtureRoot = await resolveFixtureRoot(invocation.cwd ?? process.cwd(), invocation.fixturePath);
  onProgress(`Reading ${FIXTURE_MANIFEST_FILE_NAME}.`);
  const contract = validateFixtureManifest(
    await readWorkspaceJson(fixtureRoot, FIXTURE_MANIFEST_FILE_NAME, WORKSPACE_LIMITS.manifestBytes),
  );
  const {
    manifest,
    imageIds,
    deliveryOrigins,
    pageIds,
    resourceIds,
    files: declaredFiles,
    settingsEntityIds,
  } = contract;

  onProgress("Validating the complete light/dark theme, appearance, header, brand, and footer colors.");
  const presentation = await validateThemeWorkspace(fixtureRoot, manifest.siteId, imageIds, settingsEntityIds);
  for (const warning of presentation.themes.warnings) onProgress(`Espalier warning: ${warning}`);
  const sharedContexts = sharedThemeContextNames(
    presentation.style.lightTheme,
    presentation.style.darkTheme,
  );

  const pageFiles = await walkWorkspaceFiles(fixtureRoot, PAGES_DIRECTORY, PAGE_SOURCE_EXTENSIONS);
  const manifestByFile = new Map(manifest.pages.map((entry) => [entry.file, entry]));
  for (const file of declaredFiles) {
    if (!pageFiles.includes(file)) {
      fail("fixture.page_missing", `The fixture manifest binds missing page source '${file}'.`, file);
    }
  }
  const untracked = pageFiles.find((file) => !declaredFiles.has(file));
  if (untracked !== undefined) {
    fail("fixture.page_untracked", `Page source '${untracked}' is not bound by ${FIXTURE_MANIFEST_FILE_NAME}.`, untracked);
  }
  const validatedPages = [];
  const rootBandPages = [];
  for (const file of pageFiles) {
    onProgress(`Validating '${file}'.`);
    const entry = manifestByFile.get(file);
    const page = await validateWorkspacePageSource({
      workspaceDir: fixtureRoot,
      file,
      manifestEntry: entry,
      mediaManifest: { media: {} },
      content: invocation.content,
    });
    await validateWorkspacePageDocument({
      workspaceDir: fixtureRoot,
      siteId: manifest.siteId,
      file,
      document: page.document,
      content: invocation.content,
      getSharedThemeContexts: async () => sharedContexts,
    });
    if (page.pagePath !== normalizePagePath(entry.path)) {
      fail(
        "fixture.page_path_mismatch",
        `'${file}' declares path '${page.pagePath}' but its fixture manifest entry binds '${entry.path}'.`,
        file,
      );
    }
    validatePageImageReferences(page.document, file, imageIds, deliveryOrigins);
    validatedPages.push({ file, path: page.pagePath });
    if (pageUsesRootBand(page.document)) rootBandPages.push(file);
  }
  const hints = headerWidthHints(presentation.header.headerWidth, rootBandPages);
  for (const hint of hints) onProgress(`Hint: ${hint.message}`);

  onProgress("Validating navigation shape and local PAGE targets.");
  const navigation = validateNavigationWorkspaceDocument(
    await readWorkspaceJson(fixtureRoot, NAVIGATION_FILE_NAME, WORKSPACE_LIMITS.navigationBytes),
    manifest.siteId,
    { pageIds, resourceIds },
  );
  if (navigation.items !== manifest.navigation.items) {
    fail(
      "fixture.navigation_count_mismatch",
      `${NAVIGATION_FILE_NAME} contains ${navigation.items} item(s), but the fixture manifest records ${manifest.navigation.items}.`,
      "navigation.items",
    );
  }

  onProgress("Validating the closed footer document and local page/image targets.");
  validateFooterWorkspaceDocument(
    await readWorkspaceJson(fixtureRoot, FOOTER_SETTINGS_FILE, WORKSPACE_LIMITS.settingsBytes),
    manifest.siteId,
    {
      expectedEntityId: settingsEntityIds.get(SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES),
      knownPageResourceIds: resourceIds,
      knownImageIds: imageIds,
    },
  );

  const reportedPages = boundedList(validatedPages, MAXIMUM_REPORTED);
  onProgress(
    `Validated ${validatedPages.length} page(s), ${navigation.items} navigation item(s), two themes, appearance, and footer without credentials or mutation.`,
  );
  return successResult(VERB_VALIDATE, manifest.siteId, {
    offline: true,
    fixture: {
      contractVersion: FIXTURE_CONTRACT_VERSION,
      manifest: FIXTURE_MANIFEST_FILE_NAME,
      imageIds: imageIds.size,
      deliveryOrigins: deliveryOrigins.size,
    },
    validated: {
      pages: {
        total: validatedPages.length,
        items: reportedPages.items,
        ...(reportedPages.truncated ? { itemsTruncated: true } : {}),
      },
      navigation: { items: navigation.items, maximumDepth: NAVIGATION_MAXIMUM_DEPTH },
      themes: 2,
      appearanceSettings: presentation.scalarOperations.length,
      footer: true,
    },
    warnings: {
      items: presentation.themes.warnings,
      count: presentation.themes.warningCount,
      ...(presentation.themes.warningsTruncated ? { truncated: true } : {}),
    },
    hints,
    proves: [
      "fixture structure and bounded files",
      "page content and named theme contexts",
      "navigation shape and local page-resource references",
      "complete theme, appearance, header, brand, and footer semantics",
      "fixture-local image identities and reserved delivery origins",
    ],
    doesNotProve: [
      "credential authorization or live site ownership",
      "remote concurrency or current revisions",
      "server normalization and pull round trips",
      "preview or published rendering",
    ],
    nextStep: "Run a real pull and authorized preview before approval or deployment.",
  });
}
