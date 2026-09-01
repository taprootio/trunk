import { getSettingsGroup, saveSiteFooterSettings, setSetting, withRefusalGuidance } from "../api.js";
import {
  applyFooterColors,
  buildAppearanceScalarOperations,
  footerColorOverlay,
} from "../appearance-contract.js";
import { VERB_THEME_PUSH } from "../constants.js";
import { SiteAuthoringError } from "../errors.js";
import { computeFooterDraftHash } from "../footer-draft-hash.js";
import { projectFooterSettingsForWorkspace } from "../footer-contract.js";
import {
  advanceFooterManifest,
  readAppearanceWorkspaceContext,
  requireFooterContentPushed,
} from "../footer-workspace.js";
import { boundedList, openSession, successResult } from "../session.js";
import {
  SETTINGS_TYPE_BRAND,
  SETTINGS_TYPE_SITE_HEADER,
  SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES,
  SETTINGS_TYPE_TAPROOT_STYLES,
} from "../settings-catalog.js";
import {
  validateAndEncodeThemePair,
} from "../theme-validation.js";
import {
  readWorkspaceJson,
  SETTINGS_DIRECTORY,
  WORKSPACE_LIMITS,
  workspaceFileExists,
  writeWorkspaceJson,
} from "../workspace.js";

const SETTINGS_FILES = Object.freeze({
  [SETTINGS_TYPE_TAPROOT_STYLES]: "taproot-styles.json",
  [SETTINGS_TYPE_BRAND]: "brand.json",
  [SETTINGS_TYPE_SITE_HEADER]: "site-header.json",
  [SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES]: "site-publishing-preferences.json",
});
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code, message, field) {
  throw new SiteAuthoringError(code, message, { field });
}

async function readSettingsDocument(workspaceDir, siteId, settingsType, expectedEntityId = siteId) {
  const file = `${SETTINGS_DIRECTORY}/${SETTINGS_FILES[settingsType]}`;
  if (!await workspaceFileExists(workspaceDir, file)) {
    fail("theme.settings_missing", `Workspace file '${file}' is missing. Run 'taproot-site pull' first.`, file);
  }
  const document = await readWorkspaceJson(workspaceDir, file, WORKSPACE_LIMITS.settingsBytes);
  if (!isPlainObject(document) || !isPlainObject(document.settings)) {
    fail("theme.settings_invalid", `${file} must be the settings document written by pull.`, file);
  }
  if (document.entityId !== expectedEntityId || document.settingsType !== settingsType) {
    const binding = expectedEntityId === siteId ? "site" : "fixture entity";
    const guidance = expectedEntityId === siteId ? " Run pull into this workspace again." : "";
    fail(
      "theme.settings_site_mismatch",
      `${file} is not bound to ${binding} ${expectedEntityId} and settings group ${settingsType}.${guidance}`,
      file,
    );
  }
  return document.settings;
}

/** The complete local validation phase shared by live push and offline fixtures. */
export async function validateThemeWorkspace(workspaceDir, siteId, knownImageIds, expectedEntityIds) {
  const [style, brand, header, publishing] = await Promise.all([
    readSettingsDocument(
      workspaceDir,
      siteId,
      SETTINGS_TYPE_TAPROOT_STYLES,
      expectedEntityIds?.get(SETTINGS_TYPE_TAPROOT_STYLES),
    ),
    readSettingsDocument(
      workspaceDir,
      siteId,
      SETTINGS_TYPE_BRAND,
      expectedEntityIds?.get(SETTINGS_TYPE_BRAND),
    ),
    readSettingsDocument(
      workspaceDir,
      siteId,
      SETTINGS_TYPE_SITE_HEADER,
      expectedEntityIds?.get(SETTINGS_TYPE_SITE_HEADER),
    ),
    readSettingsDocument(
      workspaceDir,
      siteId,
      SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES,
      expectedEntityIds?.get(SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES),
    ),
  ]);
  const themes = validateAndEncodeThemePair(style.lightTheme, style.darkTheme);
  const scalarOperations = buildAppearanceScalarOperations(
    {
      [SETTINGS_TYPE_TAPROOT_STYLES]: style,
      [SETTINGS_TYPE_BRAND]: brand,
      [SETTINGS_TYPE_SITE_HEADER]: header,
    },
    knownImageIds,
  );
  const footerColors = footerColorOverlay(publishing.footerSettings);
  return { style, brand, header, publishing, themes, scalarOperations, footerColors };
}

export async function themePush(invocation) {
  const { client, config, siteId, onProgress } = await openSession(invocation);
  const appearanceContext = await readAppearanceWorkspaceContext(config.workspaceDir, siteId);
  const { publishing, themes, scalarOperations, footerColors } = await validateThemeWorkspace(
    config.workspaceDir,
    siteId,
    appearanceContext.knownImageIds,
  );
  // The fresh footer read below replaces the workspace document, so refuse
  // while it still carries footer-content edits that footer push has not
  // saved. Colour-only differences are theme push's own to write.
  requireFooterContentPushed(appearanceContext.footer, publishing.footerSettings);
  onProgress(`Validated the complete light/dark theme pair and ${scalarOperations.length} appearance settings.`);
  for (const warning of themes.warnings) onProgress(`Espalier warning: ${warning}`);

  const written = [];
  try {
    await withRefusalGuidance(onProgress, "theme push", async () => {
      // Re-read immediately before the concurrency-protected save and carry only
      // the ten workspace color values across. Footer prose, links, and images
      // always come from this fresh server document, never the pull snapshot.
      const currentPublishing = await getSettingsGroup(
        client,
        siteId,
        SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES,
      );
      const currentFooter = currentPublishing.sitePublishingPreferences?.footerSettings ?? {};
      const nextFooter = applyFooterColors(currentFooter, footerColors);
      const footerResponse = await saveSiteFooterSettings(
        client,
        siteId,
        nextFooter,
        computeFooterDraftHash(currentFooter),
      );
      written.push("footerSettings.light/dark colors");
      if (!isPlainObject(footerResponse.footerSettings)) {
        throw new SiteAuthoringError(
          "api.footer_settings_contract",
          "Taproot returned no normalized footer document after saving the color overlay.",
          { field: "footerSettings" },
        );
      }
      const savedFooter = footerResponse.footerSettings;
      const projectedFooter = projectFooterSettingsForWorkspace(savedFooter);
      await writeWorkspaceJson(
        config.workspaceDir,
        `${SETTINGS_DIRECTORY}/${SETTINGS_FILES[SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES]}`,
        {
          entityId: siteId,
          settingsType: SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES,
          settings: { ...publishing, footerSettings: projectedFooter },
        },
      );
      await advanceFooterManifest(config.workspaceDir, siteId, projectedFooter);
      onProgress("Saved the light and dark footer scheme colors over the current footer document.");

      for (const operation of scalarOperations) {
        await setSetting(client, siteId, operation.settingsType, operation.setting, operation.value);
        written.push(`${operation.settingsType}.${operation.setting}`);
        onProgress(`Saved ${operation.setting}.`);
      }

      // The pair is locally valid and complete before either mutation starts.
      // These writes are last so the first one is also the point at which the
      // server marks the theme externally managed and the visual editor adopts
      // its guarded mode.
      await setSetting(client, siteId, SETTINGS_TYPE_TAPROOT_STYLES, "lightTheme", themes.light);
      written.push(`${SETTINGS_TYPE_TAPROOT_STYLES}.lightTheme`);
      await setSetting(client, siteId, SETTINGS_TYPE_TAPROOT_STYLES, "darkTheme", themes.dark);
      written.push(`${SETTINGS_TYPE_TAPROOT_STYLES}.darkTheme`);
      onProgress("Saved both complete themes; Brand & Style now treats the color model as externally managed.");
    });
  } catch (error) {
    if (error instanceof SiteAuthoringError && written.length > 0) {
      throw error.withCompletedWrites(written);
    }
    throw error;
  }

  return successResult(VERB_THEME_PUSH, siteId, {
    written: boundedList(written, 100),
    warnings: {
      items: themes.warnings,
      count: themes.warningCount,
      ...(themes.warningsTruncated ? { truncated: true } : {}),
    },
  });
}
