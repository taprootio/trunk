import { getSitePresentation, withRefusalGuidance } from "../api.js";
import { LIMITS, VERB_THEME_RESOLVE } from "../constants.js";
import { SiteAuthoringError } from "../errors.js";
import { CHECK_AREA, collectProblems, refuseProblems, withinByteBudget } from "../problems.js";
import { boundedByBytes, openAnonymousSession, openSession, successResult } from "../session.js";
import { projectSettingsGroup, SETTINGS_GROUPS, SETTINGS_TYPE_TAPROOT_STYLES } from "../settings-catalog.js";
import { AA_LARGE_RATIO, AA_TEXT_RATIO, resolveThemePair, THEME_STYLES_FILE } from "../theme-resolve.js";
import { missingThemeSettings, readSettingsDocument, requireNoMissingSettings } from "./theme-push.js";

// A result must fit LIMITS.githubOutputBytes (64 KiB), and a theme may declare 128 contexts a scheme. The lists that
// grow with the theme are bounded first, each by its own share; surfaces then take what is left, and the ones past
// it are named in omittedSurfaces to be fetched with --scheme and --context.
const RESULT_ENVELOPE_BYTES = 4 * 1024;
const FLAG_BYTE_BUDGET = 10 * 1024;
const NAME_LIST_BYTE_BUDGET = 6 * 1024;

const STYLES_GROUP = SETTINGS_GROUPS.find((group) => group.settingsType === SETTINGS_TYPE_TAPROOT_STYLES);

/** The workspace's pair, read the way theme push reads it; or the site's, projected the way pull writes it. */
async function readThemes(invocation) {
  if (invocation.fromSite === true) {
    const session = await openSession(invocation);
    const presentation = await withRefusalGuidance(session.onProgress, "theme resolve", async () =>
      await getSitePresentation(session.client, session.siteId));
    const projected = projectSettingsGroup(STYLES_GROUP, presentation);
    return { siteId: session.siteId, source: "site", themes: [projected.lightTheme, projected.darkTheme] };
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
  return { siteId: config.siteId, source: "workspace", themes: [style.lightTheme, style.darkTheme] };
}

/**
 * `theme resolve` — what Espalier compiles from the stored light and dark
 * themes: every semantic color per scheme and context, and the contrast of
 * each ink-on-surface pairing. Offline from the pulled workspace by default;
 * `--site` reads the site's own theme instead (and needs a credential).
 */
export async function themeResolve(invocation) {
  const { siteId, source, themes: [lightTheme, darkTheme] } = await readThemes(invocation);
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

  const flags = { ...boundedByBytes(resolution.flags, FLAG_BYTE_BUDGET), count: resolution.flags.length };
  const contexts = { ...boundedByBytes(resolution.contexts, NAME_LIST_BYTE_BUDGET), count: resolution.contexts.length };
  const surfaceBudget = LIMITS.githubOutputBytes - RESULT_ENVELOPE_BYTES - NAME_LIST_BYTE_BUDGET
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
    contrast: resolution.contrast,
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
