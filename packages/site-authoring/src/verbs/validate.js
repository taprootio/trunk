import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { NAVIGATION_MAXIMUM_DEPTH } from "../api.js";
import { loadSiteConfig } from "../config.js";
import { VERB_VALIDATE } from "../constants.js";
import { freeFormRootPresentation } from "../content/free-form-sections.js";
import { isCanonicalUuid, SiteAuthoringError } from "../errors.js";
import {
  FIXTURE_CONTRACT_VERSION,
  FIXTURE_DELIVERY_ORIGIN_DOMAIN,
  FIXTURE_MANIFEST_FILE_NAME,
  FIXTURE_MAXIMUM_DELIVERY_ORIGINS,
  FIXTURE_METADATA_FIELDS,
  FIXTURE_ROOT_FIELDS,
} from "../fixture-contract.js";
import { initializeFixture } from "../fixture-init.js";
import { appearanceManifestEntry, footerManifestEntry } from "../footer-workspace.js";
import { FORMS_DIRECTORY } from "../forms-contract.js";
import { CHECK_AREA, collectProblems, refuseProblems } from "../problems.js";
import { isRedirectMapRevision, REDIRECT_KIND_GONE, REDIRECTS_FILE_NAME } from "../redirects-contract.js";
import { boundedList, successResult } from "../session.js";
import { SETTINGS_GROUPS } from "../settings-catalog.js";
import { checkWorkspace } from "../workspace-check.js";
import {
  MANIFEST_FILE_NAME,
  MANIFEST_VERSION,
  MEDIA_MANIFEST_FILE_NAME,
  NAVIGATION_FILE_NAME,
  normalizePagePath,
  PAGE_SOURCE_EXTENSIONS,
  PAGE_WORKSPACE_MODE_EDITABLE,
  PAGES_DIRECTORY,
  pageSourceFormat,
  readManifest,
  readMediaManifest,
  readWorkspaceJson,
  SETTINGS_DIRECTORY,
  walkWorkspaceFiles,
  WORKSPACE_LIMITS,
  workspaceFileExists,
} from "../workspace.js";
import { documentImageIds, isAuthorableTemplateType, placedVideoIds } from "../typed-pages.js";

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
    fail(
      "fixture.path_invalid",
      "The selected authoring fixture must be a real directory, not a link or file.",
      "fixturePath",
    );
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
    fail(
      "fixture.manifest_invalid",
      `${FIXTURE_MANIFEST_FILE_NAME} must contain one JSON object.`,
      FIXTURE_MANIFEST_FILE_NAME,
    );
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
  // The redirect baseline is bound the way navigation is, with the revision a
  // push is fenced by. A fixture's revision is a deterministic placeholder like
  // every other identity in one — it proves the shape, never a live read.
  if (
    !isPlainObject(manifest.redirects)
    || manifest.redirects.file !== REDIRECTS_FILE_NAME
    || !isRedirectMapRevision(manifest.redirects.revision)
    || !Number.isSafeInteger(manifest.redirects.entries)
    || manifest.redirects.entries < 0
  ) {
    fail(
      "fixture.redirects_invalid",
      `The fixture manifest must bind '${REDIRECTS_FILE_NAME}', a 64-character lowercase hex revision, and its `
        + "non-negative entry count.",
      "redirects",
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
  // Optional: a fixture that places no video omits the list. Whatever is listed
  // is a `ready` video a page may place, the offline stand-in for the library
  // read a live push makes.
  const declaredVideoIds = manifest.fixture.videoIds ?? [];
  if (
    !Array.isArray(declaredVideoIds)
    || declaredVideoIds.length > WORKSPACE_LIMITS.files
    || declaredVideoIds.some((value) => !isCanonicalUuid(value))
  ) {
    fail(
      "fixture.video_ids_invalid",
      "fixture.videoIds must be a bounded list of deterministic canonical UUIDs.",
      "fixture.videoIds",
    );
  }
  const videoIds = new Set(declaredVideoIds);
  if (videoIds.size !== declaredVideoIds.length) {
    fail("fixture.video_ids_invalid", "fixture.videoIds must not contain duplicates.", "fixture.videoIds");
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
      || !isAuthorableTemplateType(entry.templateType)
      || entry.workspaceMode !== PAGE_WORKSPACE_MODE_EDITABLE
      || typeof entry.file !== "string"
      || !entry.file.startsWith(`${PAGES_DIRECTORY}/`)
      || extension === undefined
      || pagePath === undefined
    ) {
      fail(
        "fixture.page_invalid",
        `${field} must bind one editable page source to deterministic page/resource identities and a usable path.`,
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
    if (
      pageIds.has(entry.pageId) || resourceIds.has(entry.resourceId) || files.has(entry.file) || paths.has(pagePath)
    ) {
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
  return { manifest, imageIds, videoIds, deliveryOrigins, pageIds, resourceIds, files, settingsEntityIds };
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

/**
 * The fixture's forms, when it carries any. The manifest binding and the files
 * must name the same keys: a form file the manifest does not mention would be
 * validated by no one, and a key with no file would be a baseline for nothing.
 */
function requireFixtureFormsBound(bound, files) {
  if (bound === undefined) {
    if (files.length > 0) {
      fail(
        "fixture.forms_unbound",
        "The fixture carries form files but its manifest does not bind them in 'forms'.",
        "forms",
      );
    }
    return;
  }
  const items = isPlainObject(bound) && isPlainObject(bound.items) ? bound.items : undefined;
  const keys = items === undefined ? [] : Object.keys(items).sort();
  if (
    items === undefined
    || Object.keys(bound).length !== 1
    || keys.length === 0
    || keys.some((key) =>
      !isPlainObject(items[key])
      || Object.keys(items[key]).sort().join() !== "id,version"
      || !isCanonicalUuid(items[key].id)
      || !Number.isSafeInteger(items[key].version)
      || items[key].version < 1
    )
  ) {
    fail(
      "fixture.forms_invalid",
      "The fixture manifest's 'forms' must be { items: { <key>: { id, version } } } with at least one form, "
        + "a canonical UUID id, and a positive version.",
      "forms",
    );
  }
  const fileKeys = files.map((form) => form.key);
  if (fileKeys.join() !== keys.join()) {
    fail(
      "fixture.forms_mismatch",
      `The fixture manifest binds forms [${keys.join(", ")}] but ${FORMS_DIRECTORY}/ holds [${fileKeys.join(", ")}].`,
      "forms",
    );
  }
}

/** Every editable page source on disk, each one bound by the fixture manifest. */
async function fixturePageFileProblems(fixtureRoot, declaredFiles) {
  const problems = [];
  const pageFiles = await walkWorkspaceFiles(fixtureRoot, PAGES_DIRECTORY, PAGE_SOURCE_EXTENSIONS);
  for (const file of declaredFiles) {
    if (pageFiles.includes(file)) continue;
    await collectProblems(problems, { area: CHECK_AREA.pages, file }, () =>
      fail("fixture.page_missing", `The fixture manifest binds missing page source '${file}'.`, file));
  }
  for (const file of pageFiles.filter((candidate) => !declaredFiles.has(candidate))) {
    await collectProblems(problems, { area: CHECK_AREA.pages, file }, () =>
      fail("fixture.page_untracked", `Page source '${file}' is not bound by ${FIXTURE_MANIFEST_FILE_NAME}.`, file));
  }
  return problems;
}

/**
 * What only a fixture promises about a page that passed the shared checks:
 * its source declares the path its manifest entry binds, and every image and
 * video it places is one the fixture declares.
 */
function requireFixturePageBound(page, entry, { imageIds, videoIds, deliveryOrigins }) {
  const { file, document: document_ } = page;
  if (page.pagePath !== normalizePagePath(entry.path)) {
    fail(
      "fixture.page_path_mismatch",
      `'${file}' declares path '${page.pagePath}' but its fixture manifest entry binds '${entry.path}'.`,
      file,
    );
  }
  validatePageImageReferences(document_, file, imageIds, deliveryOrigins);
  // Album images and the cover image are bare ids with no delivery URL, so
  // the walk above cannot see them.
  const unknownImage = documentImageIds(document_).find((imageId) => !imageIds.has(imageId));
  if (unknownImage !== undefined) {
    fail(
      "fixture.image_reference_unknown",
      `Fixture image '${unknownImage}' is not declared in fixture.imageIds.`,
      file,
    );
  }
  const unknownVideo = [...placedVideoIds(document_)].find((videoId) => !videoIds.has(videoId));
  if (unknownVideo !== undefined) {
    fail(
      "fixture.video_reference_unknown",
      `Fixture video '${unknownVideo}' is not declared in fixture.videoIds, so it is not a ready video of this site.`,
      file,
    );
  }
}

/** The fixture manifest's own records of the presentation, navigation, and redirects it binds. */
function requireFixtureRecordsMatch(manifest, checked) {
  const { presentation, navigation, redirects } = checked;
  if (presentation !== undefined) {
    const expectedAppearance = appearanceManifestEntry({
      SETTING_TYPE_TAPROOT_STYLES: presentation.style,
      SETTING_TYPE_BRAND: presentation.brand,
      SETTING_TYPE_SITE_HEADER: presentation.header,
    });
    if (manifest.appearance !== undefined && JSON.stringify(manifest.appearance) !== JSON.stringify(expectedAppearance)) {
      fail(
        "fixture.appearance_invalid",
        "The fixture appearance metadata must match its settings image identities.",
        "appearance",
      );
    }
    if (manifest.footer !== undefined) {
      const expectedFooter = footerManifestEntry(presentation.publishing.footerSettings);
      if (
        !isPlainObject(manifest.footer) || Object.keys(manifest.footer).length !== Object.keys(expectedFooter).length
        || Object.entries(expectedFooter).some(([key, value]) =>
          JSON.stringify(manifest.footer[key]) !== JSON.stringify(value)
        )
      ) {
        fail("fixture.footer_invalid", "The fixture footer metadata must match its footer document.", "footer");
      }
    }
  }
  if (navigation !== undefined && navigation.items !== manifest.navigation.items) {
    fail(
      "fixture.navigation_count_mismatch",
      `${NAVIGATION_FILE_NAME} contains ${navigation.items} item(s), but the fixture manifest records ${manifest.navigation.items}.`,
      "navigation.items",
    );
  }
  if (redirects !== undefined && redirects.entries.length !== manifest.redirects.entries) {
    fail(
      "fixture.redirects_count_mismatch",
      `${REDIRECTS_FILE_NAME} contains ${redirects.entries.length} entr${
        redirects.entries.length === 1 ? "y" : "ies"
      }, but the fixture manifest records ${manifest.redirects.entries}.`,
      "redirects.entries",
    );
  }
}

function reportThemeWarnings(presentation, onProgress) {
  if (presentation === undefined) return;
  for (const warning of presentation.themes.warnings) onProgress(`Espalier warning: ${warning}`);
  if (presentation.themes.warningsTruncated) {
    const hidden = presentation.themes.warningCount - presentation.themes.warnings.length;
    onProgress(`${hidden} more Espalier warning(s) not shown; resolve the ones above and run validate again to see them.`);
  }
}

/** The part of a success result both kinds of workspace share. */
function validatedSummary(checked, pages) {
  const { presentation, navigation, redirects, forms } = checked;
  const reportedPages = boundedList(pages, MAXIMUM_REPORTED);
  return {
    validated: {
      ...(checked.settingsOnly ? {} : {
        pages: {
          total: pages.length,
          items: reportedPages.items,
          ...(reportedPages.truncated ? { itemsTruncated: true } : {}),
        },
        navigation: { items: navigation.items, maximumDepth: NAVIGATION_MAXIMUM_DEPTH },
        ...(redirects === undefined ? {} : {
          redirects: {
            entries: redirects.entries.length,
            gone: redirects.entries.filter((entry) => entry.kind === REDIRECT_KIND_GONE).length,
          },
        }),
        ...(forms === undefined || forms.length === 0 ? {} : { forms: { count: forms.length } }),
      }),
      themes: 2,
      appearanceSettings: presentation.scalarOperations.length,
      footer: true,
    },
    warnings: {
      items: presentation.themes.warnings,
      count: presentation.themes.warningCount,
      ...(presentation.themes.warningsTruncated ? { truncated: true } : {}),
    },
  };
}

function pageHints(checked, onProgress) {
  if (checked.settingsOnly || checked.presentation === undefined) return [];
  const rootBandPages = checked.pages.planned.filter((page) => pageUsesRootBand(page.document)).map((page) => page.file);
  const hints = headerWidthHints(checked.presentation.header.headerWidth, rootBandPages);
  for (const hint of hints) onProgress(`Hint: ${hint.message}`);
  return hints;
}

export async function validateFixture(invocation = {}) {
  if (invocation.init) return await initializeFixture(invocation, validateFixture);
  const onProgress = typeof invocation.onProgress === "function" ? invocation.onProgress : () => {};
  const cwd = invocation.cwd ?? process.cwd();
  if (invocation.fixturePath === undefined) {
    const config = await loadSiteConfig({ cwd, configPath: invocation.configPath });
    if (!isCanonicalUuid(config.siteId)) {
      fail(
        "config.site_missing",
        "No site is selected, so the workspace's identity is unknown. Run 'taproot-site use <site>' first.",
        "siteId",
      );
    }
    return await validatePulledWorkspace(config.workspaceDir, config.siteId, invocation, onProgress);
  }
  const fixtureRoot = await resolveFixtureRoot(cwd, invocation.fixturePath);
  if (
    !await workspaceFileExists(fixtureRoot, FIXTURE_MANIFEST_FILE_NAME)
    && await workspaceFileExists(fixtureRoot, MANIFEST_FILE_NAME)
  ) {
    const { siteId } = await readWorkspaceJson(fixtureRoot, MANIFEST_FILE_NAME, WORKSPACE_LIMITS.manifestBytes);
    if (!isCanonicalUuid(siteId)) {
      fail("workspace.manifest_invalid", `${MANIFEST_FILE_NAME} does not record a canonical site id.`, "siteId");
    }
    return await validatePulledWorkspace(fixtureRoot, siteId, invocation, onProgress);
  }

  onProgress(`Reading ${FIXTURE_MANIFEST_FILE_NAME}.`);
  const contract = validateFixtureManifest(
    await readWorkspaceJson(fixtureRoot, FIXTURE_MANIFEST_FILE_NAME, WORKSPACE_LIMITS.manifestBytes),
  );
  const { manifest, imageIds, videoIds, deliveryOrigins, pageIds, resourceIds, files: declaredFiles } = contract;

  const problems = await fixturePageFileProblems(fixtureRoot, declaredFiles);
  // The fixture's own media manifest, as in a real workspace, so Markdown media
  // paths resolve; none means no media. One that cannot be read is a fixture
  // problem, and its pages then resolve no media paths.
  const mediaManifest = await collectProblems(
    problems,
    { area: "fixture", file: MEDIA_MANIFEST_FILE_NAME },
    async () => {
      try {
        return await readMediaManifest(fixtureRoot, manifest.siteId);
      } catch (error) {
        if (error?.code !== "workspace.manifest_site_mismatch") throw error;
        throw new SiteAuthoringError(
          "fixture.media_manifest_site",
          `The fixture's ${MEDIA_MANIFEST_FILE_NAME} must record the fixture's siteId, ${manifest.siteId}.`,
          { field: "siteId" },
        );
      }
    },
  ) ?? { media: {} };
  const checked = await checkWorkspace({
    workspaceDir: fixtureRoot,
    siteId: manifest.siteId,
    manifest,
    mediaManifest,
    binding: { knownImageIds: imageIds, settingsEntityIds: contract.settingsEntityIds, pageIds, resourceIds },
    content: invocation.content,
    onProgress,
  });
  problems.push(...checked.problems);
  reportThemeWarnings(checked.presentation, onProgress);

  const manifestByFile = new Map(manifest.pages.map((entry) => [entry.file, entry]));
  const validatedPages = [];
  for (const page of checked.pages?.planned ?? []) {
    // A source the manifest does not bind is already reported as untracked.
    if (!manifestByFile.has(page.file)) continue;
    const bound = await collectProblems(problems, { area: CHECK_AREA.pages, file: page.file }, () => {
      requireFixturePageBound(page, manifestByFile.get(page.file), { imageIds, videoIds, deliveryOrigins });
      return true;
    });
    if (bound) validatedPages.push({ file: page.file, path: page.pagePath });
  }
  await collectProblems(problems, { area: "fixture", file: FIXTURE_MANIFEST_FILE_NAME }, () => {
    requireFixtureRecordsMatch(manifest, checked);
    // A forms folder that failed to read is already its own problem.
    if (checked.forms !== undefined) requireFixtureFormsBound(manifest.forms, checked.forms);
  });
  refuseProblems(problems, "validate found problems in the fixture");

  const hints = pageHints(checked, onProgress);
  onProgress(
    `Validated ${validatedPages.length} page(s), ${checked.navigation.items} navigation item(s), two themes, appearance, and footer without credentials or mutation.`,
  );
  return successResult(VERB_VALIDATE, manifest.siteId, {
    offline: true,
    fixture: {
      contractVersion: FIXTURE_CONTRACT_VERSION,
      manifest: FIXTURE_MANIFEST_FILE_NAME,
      imageIds: imageIds.size,
      videoIds: videoIds.size,
      deliveryOrigins: deliveryOrigins.size,
    },
    ...validatedSummary(checked, validatedPages),
    hints,
    proves: [
      "fixture structure and bounded files",
      "page content and named theme contexts",
      "navigation shape and local page-resource references",
      "redirect-map shape, normalization, chains, loops, and fixture-local path occupancy",
      "complete theme, appearance, header, brand, and footer semantics",
      "form files, when the manifest binds any, against the shared field schema",
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

/**
 * `validate` over a workspace `pull` wrote (TR01002). The same checks a push
 * runs before it sends anything, for every page and setting at once, against
 * what the manifests recorded at the pull — no credential and no request.
 */
async function validatePulledWorkspace(workspaceDir, siteId, invocation, onProgress) {
  onProgress(`Reading ${MANIFEST_FILE_NAME}.`);
  const manifest = await readManifest(workspaceDir, siteId);
  const mediaManifest = await readMediaManifest(workspaceDir, siteId);
  const checked = await checkWorkspace({
    workspaceDir,
    siteId,
    manifest,
    mediaManifest,
    content: invocation.content,
    onProgress,
  });
  reportThemeWarnings(checked.presentation, onProgress);
  refuseProblems(checked.problems, "validate found problems in the workspace");

  const pages = checked.settingsOnly
    ? []
    : checked.pages.planned.map((page) => ({ file: page.file, path: page.pagePath }));
  const hints = pageHints(checked, onProgress);
  onProgress(
    checked.settingsOnly
      ? "Validated the workspace's two themes, appearance, and footer without credentials or mutation."
      : `Validated ${pages.length} page(s), ${checked.navigation.items} navigation item(s), two themes, appearance, and `
        + "footer without credentials or mutation.",
  );
  return successResult(VERB_VALIDATE, siteId, {
    offline: true,
    workspace: { manifest: MANIFEST_FILE_NAME, settingsOnly: checked.settingsOnly },
    ...validatedSummary(checked, pages),
    hints,
    proves: [
      "every page source: metadata, Markdown conversion, media references, content vocabulary, and section contexts",
      "page paths, templates, and system pages against the pages the pull recorded",
      "navigation shape and page references the pull recorded",
      "redirect-map shape, normalization, chains, loops, and workspace page paths",
      "complete theme, appearance, header, brand, and footer semantics",
      "form files against the shared field schema",
    ],
    doesNotProve: [
      "credential authorization or live site ownership",
      "pages, revisions, or videos that changed on the site since the pull",
      "server normalization and pull round trips",
      "preview or published rendering",
    ],
    nextStep: "Run 'taproot-site plan' to check the workspace against the live site and see the ordered apply.",
  });
}
