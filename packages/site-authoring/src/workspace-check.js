import { sharedThemeContextNames } from "./content/free-form-sections.js";
import { readAppearanceWorkspaceContext, FOOTER_SETTINGS_FILE } from "./footer-workspace.js";
import { readWorkspaceForms } from "./forms-workspace.js";
import { CHECK_AREA, collectProblems, problemsOf } from "./problems.js";
import { normalizeRedirectPath, REDIRECTS_FILE_NAME, validateRedirectsDocument } from "./redirects-contract.js";
import { SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES } from "./settings-catalog.js";
import { validateFooterWorkspaceDocument } from "./verbs/footer-push.js";
import { validateNavigationWorkspaceDocument } from "./verbs/nav-push.js";
import { planPages } from "./verbs/pages-push.js";
import { validateThemeWorkspace } from "./verbs/theme-push.js";
import {
  NAVIGATION_FILE_NAME,
  normalizePagePath,
  PAGE_SOURCE_EXTENSIONS,
  PAGES_DIRECTORY,
  readWorkspaceJson,
  walkWorkspaceFiles,
  WORKSPACE_LIMITS,
  workspaceFileExists,
} from "./workspace.js";
import { SiteAuthoringError } from "./errors.js";

const ALL_AREAS = new Set(Object.values(CHECK_AREA));

/**
 * The one validator for a whole authoring workspace (TR01002, TR00823).
 *
 * `validate` runs it over a pulled workspace or an offline fixture, and `plan`
 * runs it before reading the site. Each area is checked by the function its
 * push uses — `planPages` for pages, `validateThemeWorkspace` for the theme —
 * so a workspace that passes here is not refused for its shape by a push.
 *
 * Every area is checked, and every page, whatever an earlier one found: the
 * result lists all the problems, and no area's refusal hides another's.
 *
 * `binding` says what the workspace's references may point at. A pulled
 * workspace binds the images and pages its manifests record (or, for `plan`,
 * the site's live pages); a fixture binds the identities its own manifest
 * declares.
 */
export async function checkWorkspace({
  workspaceDir,
  siteId,
  manifest,
  mediaManifest,
  binding = {},
  content,
  areas = ALL_AREAS,
  onProgress = () => {},
}) {
  const problems = [];
  // A managed Docs site's workspace holds its settings only (TR00790).
  const settingsOnly = manifest.authoringSurface !== undefined;
  const pageIds = binding.pageIds
    ?? new Set(manifest.pages.map((entry) => entry?.pageId).filter((value) => typeof value === "string"));
  const resourceIds = binding.resourceIds
    ?? new Set(manifest.pages.map((entry) => entry?.resourceId).filter((value) => typeof value === "string"));
  // Navigation may be judged against other pages than the footer: `plan`
  // checks it against the site's live pages, which is what nav push does,
  // while footer push resolves its targets from the pull manifest.
  const navigationPages = binding.navigationPages ?? { pageIds, resourceIds };
  const knownImageIds = binding.knownImageIds
    ?? await collectProblems(problems, { area: CHECK_AREA.presentation }, async () =>
      (await readAppearanceWorkspaceContext(workspaceDir, siteId)).knownImageIds);

  onProgress("Validating the complete light/dark theme, appearance, header, brand, and footer colors.");
  const presentation = knownImageIds === undefined
    ? undefined
    : await collectProblems(problems, { area: CHECK_AREA.presentation }, async () =>
      await validateThemeWorkspace(workspaceDir, siteId, knownImageIds, binding.settingsEntityIds));

  onProgress("Validating the closed footer document and its page and image targets.");
  const footer = knownImageIds === undefined
    ? undefined
    : await collectProblems(problems, { area: CHECK_AREA.footer, file: FOOTER_SETTINGS_FILE }, async () =>
      validateFooterWorkspaceDocument(
        await readWorkspaceJson(workspaceDir, FOOTER_SETTINGS_FILE, WORKSPACE_LIMITS.settingsBytes),
        siteId,
        {
          expectedEntityId: binding.settingsEntityIds?.get(SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES),
          knownPageResourceIds: resourceIds,
          knownImageIds,
        },
      ));

  if (settingsOnly) return { problems, settingsOnly, presentation, footer };

  onProgress("Validating navigation shape and its page targets.");
  const navigation = await collectProblems(problems, { area: CHECK_AREA.navigation, file: NAVIGATION_FILE_NAME }, async () =>
    validateNavigationWorkspaceDocument(
      await readWorkspaceJson(workspaceDir, NAVIGATION_FILE_NAME, WORKSPACE_LIMITS.navigationBytes),
      siteId,
      navigationPages,
    ));

  // `plan` checks pages against the live site instead (TR00823).
  const checkPages = areas.has(CHECK_AREA.pages);
  if (checkPages) onProgress("Validating every page source.");
  const pages = !checkPages ? undefined : await collectProblems(problems, { area: CHECK_AREA.pages }, async () =>
    await planPages({
      workspaceDir,
      siteId,
      manifest,
      mediaManifest,
      content,
      files: await walkWorkspaceFiles(workspaceDir, PAGES_DIRECTORY, PAGE_SOURCE_EXTENSIONS),
      // The pages the manifest records are what the site held when it was
      // pulled, which is what an offline check can know.
      livePages: manifest.pages.filter((entry) => typeof entry?.pageId === "string"),
      online: false,
      // The theme was validated above, so its contexts come from it; reading
      // the styles file again would re-check a binding a fixture spells
      // differently, and repeat a theme problem once per page.
      getSharedThemeContexts: async () =>
        presentation === undefined
          ? undefined
          : sharedThemeContextNames(presentation.style.lightTheme, presentation.style.darkTheme),
      onProgress,
    }));
  if (pages !== undefined) problems.push(...pages.problems);

  // `plan` leaves redirects and forms to their own pushes.
  if (areas.has(CHECK_AREA.redirects)) {
    onProgress("Validating the redirect map: paths, targets, statuses, chains, loops, and page paths.");
  }
  const redirects = !areas.has(CHECK_AREA.redirects)
    ? undefined
    : await collectProblems(problems, { area: CHECK_AREA.redirects, file: REDIRECTS_FILE_NAME }, async () =>
      await checkRedirects(workspaceDir, siteId, manifest, pages?.sources));

  const forms = !areas.has(CHECK_AREA.forms)
    ? undefined
    : await collectProblems(problems, { area: CHECK_AREA.forms }, async () => await readWorkspaceForms(workspaceDir));
  if (forms?.length > 0) {
    onProgress(`Validated ${forms.length} form file${forms.length === 1 ? "" : "s"} against the shared field schema.`);
  }

  return { problems, settingsOnly, presentation, footer, navigation, pages, redirects, forms };
}

/**
 * The redirect map's own rules, and the one rule the workspace can check
 * against itself: a source a workspace page occupies is refused by the site.
 * Paths compare case-insensitively, as the site's citext path column does,
 * and a refusal names the entry where the author wrote it: the validated map
 * is sorted by path, so its index is not the document's.
 */
async function checkRedirects(workspaceDir, siteId, manifest, sources) {
  if (!await workspaceFileExists(workspaceDir, REDIRECTS_FILE_NAME)) {
    // A workspace pulled before redirects existed holds no map, and nothing in
    // it asks for one.
    if (manifest.redirects === undefined) return undefined;
    throw new SiteAuthoringError(
      "redirects.file_missing",
      `No ${REDIRECTS_FILE_NAME} was found, but the pull manifest records a redirect baseline. Run 'taproot-site `
        + "redirects pull' again.",
      { field: REDIRECTS_FILE_NAME },
    );
  }
  const document_ = await readWorkspaceJson(workspaceDir, REDIRECTS_FILE_NAME, WORKSPACE_LIMITS.redirectsBytes);
  const redirects = validateRedirectsDocument(document_, siteId);
  // The pages the next push leaves on the site: each workspace source at the
  // path it declares, and every recorded page no source here claims. A page a
  // source renames frees its old path for a redirect.
  const claimed = new Set((sources ?? []).map((source) => source.file));
  const occupied = [
    ...(sources ?? []).map((source) => source.pagePath),
    ...manifest.pages
      .filter((entry) => typeof entry?.path === "string" && !claimed.has(entry.file))
      .map((entry) => normalizePagePath(entry.path)),
  ];
  const pagePaths = new Set(
    occupied.filter((pagePath) => pagePath !== undefined)
      .map((pagePath) => (`/${pagePath}`.replace(/\/+$/u, "") || "/").toLowerCase()),
  );
  const authoredIndexByPath = new Map();
  for (const [index, entry] of document_.entries.entries()) {
    const path = normalizeRedirectPath(entry?.path);
    if (path !== undefined && !authoredIndexByPath.has(path.toLowerCase())) {
      authoredIndexByPath.set(path.toLowerCase(), index);
    }
  }
  const problems = [];
  for (const entry of redirects.entries) {
    const key = entry.path.toLowerCase();
    if (!pagePaths.has(key)) continue;
    problems.push(...problemsOf(new SiteAuthoringError(
      "redirects.path_occupied",
      `Redirect source '${entry.path}' is a page in this workspace, so it cannot also be a redirect source.`,
      { field: `entries[${authoredIndexByPath.get(key) ?? 0}].path` },
    ), { area: CHECK_AREA.redirects, file: REDIRECTS_FILE_NAME }));
  }
  if (problems.length > 0) {
    const [first] = problems;
    const error = new SiteAuthoringError(first.code, first.message, { field: first.field });
    throw problems.length === 1 ? error : error.withProblems(problems);
  }
  return redirects;
}
