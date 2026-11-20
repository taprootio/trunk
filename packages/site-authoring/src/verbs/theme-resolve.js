import { AA_LARGE_RATIO, AA_TEXT_RATIO } from "@taprootio/espalier/shared/theme";

import { getNavigation, getSitePresentation, withRefusalGuidance } from "../api.js";
import { appearanceImageIds, footerPresentationOverlay, validateAppearanceScalarGroup } from "../appearance-contract.js";
import { CAPABILITY_CONTENT } from "../capabilities.js";
import { captureChromeResources } from "../chrome-input.js";
import { displayChromeContext, indexChromePaint } from "../chrome-output.js";
import { completeChromeReport } from "../chrome-report.js";
import { LIMITS, SURFACE_DOCS_PRESENTATION, SURFACE_STANDARD, VERB_THEME_RESOLVE } from "../constants.js";
import { SiteAuthoringError } from "../errors.js";
import { footerImageIds, validateFooterDocument } from "../footer-contract.js";
import { appearanceResourceIds } from "../footer-workspace.js";
import { CHECK_AREA, collectProblems, refuseProblems, withinByteBudget } from "../problems.js";
import { boundedByBytes, openAnonymousSession, openSession, successResult } from "../session.js";
import {
  projectSettingsGroup,
  SETTINGS_GROUPS,
  SETTINGS_TYPE_SITE_HEADER,
  SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES,
  SETTINGS_TYPE_TAPROOT_STYLES,
} from "../settings-catalog.js";
import { resolveThemePair, THEME_STYLES_FILE } from "../theme-resolve.js";
import { readManifest, readMediaManifest } from "../workspace.js";
import { validateNavigationWorkspaceDocument } from "./nav-push.js";
import { missingThemeSettings, readSettingsDocument, requireNoMissingSettings } from "./theme-push.js";

// A result must fit LIMITS.githubOutputBytes (64 KiB), and a theme may declare 128 contexts a scheme. The lists that
// grow with the theme are bounded first, each by its own share; surfaces then take what is left, and the ones past
// it are named in omittedSurfaces to be fetched with --scheme and --context.
const RESULT_ENVELOPE_BYTES = 4 * 1024;
const FLAG_BYTE_BUDGET = 10 * 1024;
const NAME_LIST_BYTE_BUDGET = 6 * 1024;
// The maximal indexed catalog and cards occupy 9,772 bytes. Adding 25% rounds up to 12 KiB.
export const CHROME_BYTE_BUDGET = 12 * 1024;

const STYLES_GROUP = SETTINGS_GROUPS.find((group) => group.settingsType === SETTINGS_TYPE_TAPROOT_STYLES);
const HEADER_GROUP = SETTINGS_GROUPS.find((group) => group.settingsType === SETTINGS_TYPE_SITE_HEADER);
const PUBLISHING_GROUP = SETTINGS_GROUPS.find((group) => group.settingsType === SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES);

/** The workspace's pair, read the way theme push reads it; or the site's, projected the way pull writes it. */
async function readThemes(invocation) {
  if (invocation.fromSite === true) {
    const session = await openSession(invocation);
    const presentation = await withRefusalGuidance(session.onProgress, "theme resolve", async () =>
      await getSitePresentation(session.client, session.siteId));
    const projected = projectSettingsGroup(STYLES_GROUP, presentation);
    return { siteId: session.siteId, source: "site", style: projected, session, presentation };
  }
  const { config } = await openAnonymousSession({ ...invocation, client: null });
  if (config === undefined) {
    throw new SiteAuthoringError(
      "config.not_found",
      "No taproot-site.json was found. theme resolve reads the pulled workspace it names; use --site to read the site instead.",
    );
  }
  if (!config.siteId) {
    throw new SiteAuthoringError(
      "config.site_missing",
      "No site is selected. Run 'taproot-site use <site>' to choose one, or set siteId in taproot-site.json.",
    );
  }
  const style = await readSettingsDocument(config.workspaceDir, config.siteId, SETTINGS_TYPE_TAPROOT_STYLES);
  // The same preflight push and validate run, so a stale workspace gets the same code and the full path list.
  requireNoMissingSettings(missingThemeSettings(style));
  return { siteId: config.siteId, source: "workspace", style, config };
}

async function optionalEvidence(read) {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

async function siteNavigation(session) {
  const capabilities = session.exchanged?.capabilities;
  if (session.surface !== SURFACE_STANDARD || !Array.isArray(capabilities) || !capabilities.includes(CAPABILITY_CONTENT)) {
    return undefined;
  }
  return await optionalEvidence(async () => {
    const { navItems } = await getNavigation(session.client, session.siteId, { requireEvidence: true });
    return validateNavigationWorkspaceDocument({ siteId: session.siteId, navItems }, session.siteId);
  });
}

async function readReportEvidence({ siteId, style, config, session, presentation }) {
  let header;
  let publishing;
  let resources;
  if (session) {
    const [navigation, projectedHeader, projectedPublishing] = await Promise.all([
      siteNavigation(session),
      optionalEvidence(() => presentation.headerSettings === undefined ? undefined : projectSettingsGroup(HEADER_GROUP, presentation)),
      optionalEvidence(() => presentation.sitePublishingPreferences === undefined
        ? undefined
        : projectSettingsGroup(PUBLISHING_GROUP, presentation)),
    ]);
    header = projectedHeader;
    publishing = projectedPublishing;
    resources = {
      source: "site",
      presentation,
      navigation,
      settingsOnly: session.surface === SURFACE_DOCS_PRESENTATION,
      knownImageIds: new Set([
        ...appearanceImageIds({ [SETTINGS_TYPE_TAPROOT_STYLES]: style }),
        ...footerImageIds(publishing?.footerSettings),
      ]),
    };
  } else {
    const { workspaceDir } = config;
    const [manifest, mediaManifest, authoredHeader, authoredPublishing] = await Promise.all([
      optionalEvidence(() => readManifest(workspaceDir, siteId, { required: false })),
      optionalEvidence(() => readMediaManifest(workspaceDir, siteId)),
      optionalEvidence(() => readSettingsDocument(workspaceDir, siteId, SETTINGS_TYPE_SITE_HEADER)),
      optionalEvidence(() => readSettingsDocument(workspaceDir, siteId, SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES)),
    ]);
    header = authoredHeader;
    publishing = authoredPublishing;
    resources = await captureChromeResources({
      workspaceDir,
      siteId,
      manifest,
      mediaManifest,
      settingsOnly: config.authoringSurface === SURFACE_DOCS_PRESENTATION,
      ...appearanceResourceIds(manifest, mediaManifest),
    });
  }

  const acceptedHeader = header === undefined ? undefined : await optionalEvidence(() =>
    validateAppearanceScalarGroup(SETTINGS_TYPE_SITE_HEADER, header, resources.knownImageIds));
  const acceptedStyle = await optionalEvidence(() =>
    validateAppearanceScalarGroup(SETTINGS_TYPE_TAPROOT_STYLES, style, resources.knownImageIds));
  const footerSettings = await optionalEvidence(() => {
    footerPresentationOverlay(publishing?.footerSettings);
    return validateFooterDocument(publishing.footerSettings, resources);
  });
  return {
    appearance: {
      style: acceptedStyle ?? { lightTheme: style.lightTheme, darkTheme: style.darkTheme },
      header: acceptedHeader,
      publishing,
    },
    resources: { ...resources, footerSettings },
  };
}

function selectChrome(report, { themeScheme, themeContext }) {
  const matchesContext = (entry) => themeContext === undefined || entry.context === themeContext;
  const entries = Object.fromEntries(Object.entries(report.entries)
    .filter(([scheme]) => themeScheme === undefined || themeScheme === scheme)
    .map(([scheme, surfaces]) => [scheme, surfaces.filter(matchesContext)]));
  const flags = report.flags.filter((flag) => Object.hasOwn(entries, flag.scheme) && matchesContext(flag));
  return {
    ...indexChromePaint(entries),
    unavailable: report.unavailable,
    navigationUnavailable: report.navigationUnavailable,
    flags: flags.map((flag) => ({ ...flag, context: displayChromeContext(flag.context).context })),
    contrast: { pairs: Object.values(entries).flat().reduce((count, entry) => count + entry.pairs.length, 0), belowAa: flags.length },
  };
}

/**
 * `theme resolve` — what Espalier compiles from the stored light and dark
 * themes: every semantic color per scheme and context, and the contrast of
 * each ink-on-surface pairing. Offline from the pulled workspace by default;
 * `--site` reads the site's own theme instead (and needs a credential).
 */
export async function themeResolve(invocation, chromeDependencies) {
  const input = await readThemes(invocation);
  const { siteId, source, style: { lightTheme, darkTheme } } = input;
  const problems = [];
  const resolution = await collectProblems(
    problems,
    { area: CHECK_AREA.presentation, file: THEME_STYLES_FILE },
    async () => await resolveThemePair(lightTheme, darkTheme, {
      scheme: invocation.themeScheme,
      context: invocation.themeContext,
    }),
  );
  refuseProblems(problems, "theme resolve");

  const evidence = await readReportEvidence(input);
  const chrome = selectChrome(await completeChromeReport({ ...evidence, themes: resolution.encoded }, chromeDependencies), invocation);
  const allFlags = [...resolution.flags, ...chrome.flags];
  const flags = { ...boundedByBytes(allFlags, FLAG_BYTE_BUDGET), count: allFlags.length };
  const contexts = { ...boundedByBytes(resolution.contexts, NAME_LIST_BYTE_BUDGET), count: resolution.contexts.length };
  const surfaceBudget = LIMITS.githubOutputBytes - RESULT_ENVELOPE_BYTES - NAME_LIST_BYTE_BUDGET - CHROME_BYTE_BUDGET
    - Buffer.byteLength(JSON.stringify({ flags, contexts }), "utf8");
  const entries = resolution.schemes.flatMap(({ scheme, surfaces }) => surfaces.map((surface) => ({ scheme, surface })));
  const shown = withinByteBudget(entries, surfaceBudget);
  const omitted = entries.slice(shown.length);
  const schemes = resolution.schemes
    .map(({ scheme }) => ({
      scheme,
      surfaces: shown.filter((entry) => entry.scheme === scheme).map((entry) => entry.surface),
    }))
    .filter((entry) => entry.surfaces.length > 0);
  return successResult(VERB_THEME_RESOLVE, siteId, {
    source,
    thresholds: { textRatio: AA_TEXT_RATIO, largeRatio: AA_LARGE_RATIO },
    contexts,
    schemes,
    chrome: chrome.chrome,
    chromeCatalog: chrome.chromeCatalog,
    ...(chrome.unavailable ? { chromeUnavailable: true } : {}),
    ...(chrome.navigationUnavailable ? { chromeNavigationUnavailable: true } : {}),
    contrast: {
      pairs: resolution.contrast.pairs + chrome.contrast.pairs,
      belowAa: resolution.contrast.belowAa + chrome.contrast.belowAa,
      belowApca: resolution.contrast.belowApca,
    },
    flags,
    ...(omitted.length === 0
      ? {}
      : {
        omittedSurfaces: {
          ...boundedByBytes(
            omitted.map((entry) => ({ scheme: entry.scheme, context: entry.surface.context })),
            NAME_LIST_BYTE_BUDGET,
          ),
          count: omitted.length,
        },
      }),
  });
}
