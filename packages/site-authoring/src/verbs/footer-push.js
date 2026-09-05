import { saveSiteFooterSettings, withRefusalGuidance } from "../api.js";
import { VERB_FOOTER_PUSH } from "../constants.js";
import { SiteAuthoringError } from "../errors.js";
import { projectFooterSettingsForWorkspace, validateFooterDocument } from "../footer-contract.js";
import { computeFooterDraftHash } from "../footer-draft-hash.js";
import { advanceFooterManifest, FOOTER_SETTINGS_FILE, readFooterWorkspaceContext } from "../footer-workspace.js";
import { openSession, successResult, warnIfExternalWritesPaused } from "../session.js";
import { SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES } from "../settings-catalog.js";
import { ApiError } from "../transport.js";
import { readWorkspaceJson, WORKSPACE_LIMITS, writeWorkspaceJson } from "../workspace.js";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireSettingsDocument(document_, siteId, expectedEntityId = siteId) {
  if (!isPlainObject(document_) || !isPlainObject(document_.settings)) {
    throw new SiteAuthoringError(
      "footer.settings_invalid",
      `${FOOTER_SETTINGS_FILE} must be the settings document written by pull.`,
      { field: FOOTER_SETTINGS_FILE },
    );
  }
  if (
    document_.entityId !== expectedEntityId
    || document_.settingsType !== SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES
  ) {
    throw new SiteAuthoringError(
      "footer.settings_site_mismatch",
      `${FOOTER_SETTINGS_FILE} is not bound to this site. Run 'taproot-site pull' again.`,
      { field: FOOTER_SETTINGS_FILE },
    );
  }
  return document_;
}

/** The complete local validation phase shared by live push and offline fixtures. */
export function validateFooterWorkspaceDocument(document_, siteId, options = {}) {
  const { expectedEntityId = siteId, ...validationOptions } = options;
  const settingsDocument = requireSettingsDocument(document_, siteId, expectedEntityId);
  return {
    document: settingsDocument,
    footerSettings: validateFooterDocument(settingsDocument.settings.footerSettings, validationOptions),
  };
}

function translateConcurrency(error) {
  if (error instanceof ApiError && error.hasField("ExpectedFooterDraftHash")) {
    return new SiteAuthoringError(
      "footer.concurrent_modification",
      "The footer changed after this workspace was pulled. Run 'taproot-site pull', reconcile the footer document, and retry.",
      { field: "expectedFooterDraftHash", status: error.status },
    );
  }
  return error;
}

export async function footerPush(invocation) {
  const session = await openSession(invocation);
  const { client, config, siteId, onProgress } = session;
  // One advisory line before this verb does any work, and only when the
  // exchange said the platform is paused. It changes nothing else: the write
  // still runs and its refusal still classifies as platform_paused (TR00692).
  warnIfExternalWritesPaused(session, VERB_FOOTER_PUSH);
  const context = await readFooterWorkspaceContext(config.workspaceDir, siteId);
  const { document: document_, footerSettings } = validateFooterWorkspaceDocument(
    await readWorkspaceJson(config.workspaceDir, FOOTER_SETTINGS_FILE, WORKSPACE_LIMITS.settingsBytes),
    siteId,
    {
      knownPageResourceIds: context.knownPageResourceIds,
      knownImageIds: context.knownImageIds,
    },
  );
  onProgress("Validated the complete footer document, stable page targets, and site-owned image references locally.");

  let response;
  try {
    response = await withRefusalGuidance(onProgress, "footer push", async () =>
      await saveSiteFooterSettings(
        client,
        siteId,
        footerSettings,
        context.footer.expectedDraftHash,
      ));
  } catch (error) {
    throw translateConcurrency(error);
  }

  if (!isPlainObject(response.footerSettings)) {
    throw new SiteAuthoringError(
      "api.footer_settings_contract",
      "Taproot returned no normalized footer document after saving.",
      { field: "footerSettings" },
    ).withCompletedWrites(["footerSettings"]);
  }

  let saved;
  let footerDraftHash;
  try {
    saved = projectFooterSettingsForWorkspace(response.footerSettings);
    footerDraftHash = computeFooterDraftHash(saved);
    const nextDocument = structuredClone(document_);
    nextDocument.settings.footerSettings = saved;
    // The authorable document lands before its token. If either local write
    // fails, a stale token prevents the next push from overwriting the saved
    // remote footer and the completed-write report tells the caller to pull.
    await writeWorkspaceJson(config.workspaceDir, FOOTER_SETTINGS_FILE, nextDocument);
    await advanceFooterManifest(config.workspaceDir, siteId, saved, footerDraftHash);
  } catch (error) {
    if (error instanceof SiteAuthoringError) throw error.withCompletedWrites(["footerSettings"]);
    throw error;
  }
  onProgress("Saved the complete footer and refreshed its local draft hash.");

  return successResult(VERB_FOOTER_PUSH, siteId, {
    footerFile: FOOTER_SETTINGS_FILE,
    footerDraftHash,
    written: { items: ["footerSettings"], count: 1 },
  });
}
