import { NAV_ITEM_KIND_EXTERNAL_URL, NAV_ITEM_KIND_PAGE, PAGE_STATUS_PUBLISHED } from "./api.js";
import { resolveBrandColors, resolveBrandColorSourceFields, resolveBrandColorToken, resolveFooterBrandColors } from "./brand-color.js";
import { chromeFeatures } from "./chrome-features.js";
import { isCanonicalUuid } from "./errors.js";
import { validateFooterDocument } from "./footer-contract.js";
import { resolveFooterLogoPairs } from "./footer-branding.js";
import { resolveHeaderLogoPairs } from "./header-presentation.js";
import { logoInputsFromSettings } from "./logo-inputs.js";
import { sharedDeclaredThemeContextNames } from "./theme-contexts.js";
import { validateNavigationWorkspaceDocument } from "./verbs/nav-push.js";
import { NAVIGATION_FILE_NAME, normalizePagePath, readWorkspaceJson, WORKSPACE_LIMITS } from "./workspace.js";

export const CHROME_NAVIGATION_UNAVAILABLE_MESSAGE =
  "Navigation contrast was not checked because navigation information was unavailable.";

export const CHROME_OFFLINE_PAGE_LIMITATION =
  "navigation or footer page-link contrast for destinations without a published path in the workspace inventory";

export const CHROME_REPORT_NAME_RULE = "theme.chrome_report_name";

// The workspace has no eligibility projection until TR01385.
export function selectNameReportEligibility({ saved, current, manifest }) {
  return undefined;
}

function isSettingsOnly(resources) {
  return resources.settingsOnly === true || resources.manifest?.authoringSurface !== undefined;
}

/** Take optional workspace evidence while the caller still owns its read snapshot. */
export async function captureChromeResources(resources) {
  if (resources.workspaceDir === undefined || isSettingsOnly(resources) || Object.hasOwn(resources, "navigation")) return resources;
  const { manifest, siteId, workspaceDir, knownPageResourceIds } = resources;
  try {
    const parsed = await readWorkspaceJson(workspaceDir, NAVIGATION_FILE_NAME, WORKSPACE_LIMITS.navigationBytes);
    const knownPages = manifest === undefined ? undefined : {
      pageIds: new Set(manifest.pages.map((page) => page?.pageId).filter(isCanonicalUuid)),
      resourceIds: knownPageResourceIds,
    };
    const navigation = validateNavigationWorkspaceDocument(parsed, siteId, knownPages);
    return { ...resources, navigation };
  } catch {
    return { ...resources, navigation: undefined };
  }
}

function workspacePublishedPagePaths(manifest) {
  const paths = new Map();
  for (const page of manifest?.pages ?? []) {
    if (page?.status !== PAGE_STATUS_PUBLISHED || !isCanonicalUuid(page.resourceId)) continue;
    const path = normalizePagePath(page.path);
    if (path !== undefined) paths.set(page.resourceId, `/${path}`);
  }
  return paths;
}

function resolveNavigation(items, pagePaths) {
  return items?.map((item) => ({
    ...item,
    url: item.kind === NAV_ITEM_KIND_PAGE
      ? (pagePaths === undefined ? "/" : pagePaths.get(item.resourceId) ?? "")
      : item.kind === NAV_ITEM_KIND_EXTERNAL_URL
      ? item.externalUrl
      : "",
    children: resolveNavigation(item.children, pagePaths) ?? [],
  }));
}

function resolveLogoPairs(style, header, footer, media, delivery) {
  const input = logoInputsFromSettings(style, footer, media);
  // Local art is represented by an image identity. An authoritative response
  // can also say that an assigned image has no delivery URL.
  for (const name of ["light", "dark", "lightCompact", "darkCompact"]) {
    const id = `${name}LogoId`;
    const url = `${name}LogoUrl`;
    const delivered = delivery?.styleSettings;
    if (delivered?.[id] && delivered[id] === style?.[id]) {
      input[url] = typeof delivered[url] === "string" ? delivered[url] : "";
    }
  }
  for (const scheme of ["light", "dark"]) {
    const delivered = delivery?.sitePublishingPreferences?.footerSettings?.[scheme];
    if (delivered?.logoId && delivered.logoId === footer?.[scheme]?.logoId) {
      input[`${scheme}FooterLogoUrl`] = typeof delivered.logoUrl === "string" ? delivered.logoUrl : "";
    }
  }
  return {
    header: resolveHeaderLogoPairs({ ...input, logoVariant: header?.logoVariant }),
    footer: resolveFooterLogoPairs({ ...input, logoVariant: footer?.logoVariant }),
  };
}

function checkedFooterSettings(publishing, resources) {
  if (Object.hasOwn(resources, "footerSettings")) return resources.footerSettings;
  if (publishing?.footerSettings === undefined) return undefined;
  try {
    return validateFooterDocument(publishing.footerSettings, {
      knownPageResourceIds: resources.knownPageResourceIds,
      knownImageIds: resources.knownImageIds,
    });
  } catch {
    return undefined;
  }
}

/** The report uses the appearance and resources already accepted by the caller. */
export function buildChromeInput({ appearance, resources, nameReportEnabled }) {
  const { style, header, footerPresentation } = appearance;
  const publishing = resources.presentation === undefined
    ? appearance.publishing
    : resources.presentation.sitePublishingPreferences;
  const footer = checkedFooterSettings(publishing, resources);
  const footerSettings = footer === undefined ? undefined : { ...footer, ...footerPresentation };
  const settingsOnly = isSettingsOnly(resources);
  const footerPagePaths = settingsOnly ? new Map()
    : resources.source === "site" ? undefined
    : workspacePublishedPagePaths(resources.manifest);
  const navItems = settingsOnly ? undefined : resolveNavigation(resources.navigation?.navItems, footerPagePaths);
  const logoPairs = resolveLogoPairs(style, header, footerSettings, resources.mediaManifest?.media, resources.presentation);
  const headerBrandColors = resolveBrandColors(header, resolveBrandColorToken);
  const features = chromeFeatures({
    headerSettings: header,
    footerSettings,
    navItems,
    footerPagePaths,
    logoPairs,
    searchEnabled: publishing?.allowSearch === true,
    hasIconSprite: true,
    nameReportEnabled: footerSettings === undefined ? undefined : nameReportEnabled,
  });
  const contexts = new Set(sharedDeclaredThemeContextNames(style?.lightTheme, style?.darkTheme));
  const surfaces = [
    { role: "header", context: header?.context || null, brandColors: headerBrandColors, features: features.header },
    {
      role: "footer",
      context: footerSettings?.enabled === true ? footerSettings.context || null : null,
      brandColors: resolveFooterBrandColors(headerBrandColors),
      features: features.footer,
    },
  ];
  return {
    paintSurfaces: surfaces.filter(({ context, features }) => features !== undefined && (context === null || contexts.has(context))),
    brandColorSourceFields: resolveBrandColorSourceFields(header),
    navigationUnavailable: navItems === undefined,
  };
}
