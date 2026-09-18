import { getSitePresentation, saveSitePresentation, withRefusalGuidance } from "../api.js";
import {
  APPEARANCE_FOOTER_COLOR_FIELDS,
  APPEARANCE_SCALAR_FIELDS,
  buildAppearanceScalarOperations,
  footerColorOverlay,
} from "../appearance-contract.js";
import { REFUSAL_UNCLASSIFIED, VERB_THEME_PUSH } from "../constants.js";
import { MISSING_SETTING_MESSAGE, SiteAuthoringError } from "../errors.js";
import { projectFooterSettingsForWorkspace } from "../footer-contract.js";
import { computeFooterDraftHash } from "../footer-draft-hash.js";
import {
  advanceFooterManifest,
  clearPendingPresentationSave,
  computePresentationChangeSetHash,
  readAppearanceWorkspaceContext,
  readPendingPresentationSave,
  readPresentationBaseline,
  recordPendingPresentationSave,
  requireFooterContentPushed,
} from "../footer-workspace.js";
import { describeJsonDifferences } from "../json-path-diff.js";
import { boundedList, openSession, successResult, warnIfExternalWritesPaused } from "../session.js";
import {
  projectSettingsGroup,
  SETTINGS_GROUPS,
  SETTINGS_TYPE_BRAND,
  SETTINGS_TYPE_SITE_HEADER,
  SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES,
  SETTINGS_TYPE_TAPROOT_STYLES,
} from "../settings-catalog.js";
import { missingThemeFields, validateAndEncodeThemePair } from "../theme-validation.js";
import { ApiError } from "../transport.js";
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

/**
 * The two theme documents travel as writes beside the scalars: the same
 * `(group, setting, value)` triples `SetSetting` accepts, which is what the
 * atomic save takes (TR00807). Order is the appearance registry's, themes
 * last, so the audit row reads the way the old sequential order did.
 */
const THEME_SETTINGS = Object.freeze(["lightTheme", "darkTheme"]);

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
  const documents = {
    [SETTINGS_TYPE_TAPROOT_STYLES]: style,
    [SETTINGS_TYPE_BRAND]: brand,
    [SETTINGS_TYPE_SITE_HEADER]: header,
  };
  // Preflight the complete required-key inventory before any value validator
  // can stop at a malformed value in an earlier group. Optional footer color
  // leaves retain their existing empty-color fallback.
  const missing = [];
  for (const scheme of ["light", "dark"]) {
    const name = `${scheme}Theme`;
    if (!Object.hasOwn(style, name)) missing.push(name);
    else missing.push(...missingThemeFields(style[name], scheme));
  }
  for (const definition of APPEARANCE_SCALAR_FIELDS) {
    if (!Object.hasOwn(documents[definition.settingsType], definition.name)) {
      missing.push(definition.path);
    }
  }
  if (!Object.hasOwn(publishing, "footerSettings")) {
    missing.push("site-publishing-preferences.footerSettings");
  } else if (isPlainObject(publishing.footerSettings)) {
    for (const scheme of ["light", "dark"]) {
      if (!Object.hasOwn(publishing.footerSettings, scheme)) missing.push(`footerSettings.${scheme}`);
    }
  }
  if (missing.length > 0) {
    throw new SiteAuthoringError(
      "theme.settings_missing",
      "Required settings keys are absent from this workspace. Restore them locally, or run 'taproot-site pull' if the workspace is stale; a fresh pull that still omits them means the server projection is incomplete for the listed paths.",
      {
        field: missing[0],
        details: missing.map((field) => ({
          code: "theme.setting_missing",
          field,
          message: MISSING_SETTING_MESSAGE,
        })),
      },
    );
  }
  const themes = validateAndEncodeThemePair(style.lightTheme, style.darkTheme);
  const scalarOperations = buildAppearanceScalarOperations(
    documents,
    knownImageIds,
  );
  const footerColors = footerColorOverlay(publishing.footerSettings);
  return { style, brand, header, publishing, themes, scalarOperations, footerColors };
}

/**
 * The change set the atomic save receives: every appearance scalar in
 * registry order, then the two encoded themes, plus the ten footer colours.
 */
function buildChangeSet(validated) {
  return {
    settings: [
      ...validated.scalarOperations.map((operation) => ({
        settingsType: operation.settingsType,
        setting: operation.setting,
        value: operation.value,
      })),
      ...THEME_SETTINGS.map((setting) => ({
        settingsType: SETTINGS_TYPE_TAPROOT_STYLES,
        setting,
        value: setting === "lightTheme" ? validated.themes.light : validated.themes.dark,
      })),
    ],
    footerColors: validated.footerColors,
  };
}

/**
 * A Taproot that answers the presentation routes with 404 predates the atomic
 * save. The truthful answer is a refusal that says so: this verb no longer
 * performs the sequential writes an older server would accept, because those
 * are exactly the partial-failure shape the atomic save exists to remove.
 */
function translateServerSupport(error, action) {
  if (
    error instanceof ApiError
    && error.refusalKind() === REFUSAL_UNCLASSIFIED
    && error.httpStatus === 404
  ) {
    return new SiteAuthoringError(
      "theme.server_unsupported",
      `This Taproot does not serve the atomic presentation ${action}. 'theme push' saves the complete change set in `
        + "one transaction and does not fall back to the older sequential writes; use a Taproot that serves "
        + "/v1/sites/{siteId}/presentation, or an older CLI release against this one.",
      { field: "presentation", status: error.status },
    );
  }
  return error;
}

function translateSaveRefusal(error) {
  if (error instanceof ApiError && error.hasField("ExpectedRevision")) {
    return new SiteAuthoringError(
      "theme.concurrent_modification",
      "The site's presentation changed after this workspace was pulled, so the push was refused and nothing was "
        + "written. Keep copies of the edited settings files, run 'taproot-site pull' to refresh the baseline, "
        + "re-apply the edits, and push again; 'theme push --dry-run' shows what differs.",
      { field: "revision", status: error.status },
    );
  }
  if (error instanceof ApiError && error.hasField("ExpectedFooterDraftHash")) {
    return new SiteAuthoringError(
      "theme.footer_concurrent_modification",
      "The footer document changed between this push's read and its save, so the push was refused and nothing was "
        + "written. Run 'taproot-site theme push' again; it re-reads the footer before saving.",
      { field: "expectedFooterDraftHash", status: error.status },
    );
  }
  return translateServerSupport(error, "save");
}

/**
 * The workspace's copy of exactly the fields the save owns, per settings
 * file, and the site's copy projected the way `pull` writes it — so the paths
 * reported are paths in the files an author edits.
 */
function ownedDocuments(validated, presentation) {
  const projected = {};
  for (const group of SETTINGS_GROUPS) {
    projected[group.settingsType] = projectSettingsGroup(group, presentation);
  }
  const owned = (settingsType, local, remote, names) => ({
    file: `${SETTINGS_DIRECTORY}/${SETTINGS_FILES[settingsType]}`,
    local: Object.fromEntries(names.map((name) => [name, local[name]])),
    remote: Object.fromEntries(names.map((name) => [name, remote[name]])),
  });
  const scalarNames = (settingsType) =>
    APPEARANCE_SCALAR_FIELDS.filter((field) => field.settingsType === settingsType).map((field) => field.name);
  const footerColors = (footer) => {
    const colors = {};
    for (const definition of APPEARANCE_FOOTER_COLOR_FIELDS) {
      const scheme = isPlainObject(footer?.[definition.scheme]) ? footer[definition.scheme] : {};
      colors[definition.scheme] ??= {};
      colors[definition.scheme][definition.name] = scheme[definition.name] ?? "";
    }
    return { footerSettings: colors };
  };
  return [
    owned(
      SETTINGS_TYPE_TAPROOT_STYLES,
      validated.style,
      projected[SETTINGS_TYPE_TAPROOT_STYLES],
      [...THEME_SETTINGS, ...scalarNames(SETTINGS_TYPE_TAPROOT_STYLES)],
    ),
    owned(SETTINGS_TYPE_BRAND, validated.brand, projected[SETTINGS_TYPE_BRAND], scalarNames(SETTINGS_TYPE_BRAND)),
    owned(
      SETTINGS_TYPE_SITE_HEADER,
      validated.header,
      projected[SETTINGS_TYPE_SITE_HEADER],
      scalarNames(SETTINGS_TYPE_SITE_HEADER),
    ),
    {
      file: `${SETTINGS_DIRECTORY}/${SETTINGS_FILES[SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES]}`,
      local: footerColors(validated.publishing.footerSettings),
      remote: footerColors(projected[SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES].footerSettings),
    },
  ];
}

/** The JSON paths at which each settings file differs from the site, remote first. */
function describeDifferences(validated, presentation) {
  return ownedDocuments(validated, presentation).map((document_) => {
    const differences = describeJsonDifferences(document_.remote, document_.local);
    return {
      file: document_.file,
      paths: differences.paths,
      ...(differences.truncated ? { truncated: true } : {}),
    };
  });
}

export async function themePush(invocation) {
  const session = await openSession(invocation);
  const { client, config, siteId, onProgress } = session;
  const dryRun = invocation.dryRun === true;
  // One advisory line before this verb does any work, and only when the
  // exchange said the platform is paused. It changes nothing else: the write
  // still runs and its refusal still classifies as platform_paused (TR00692).
  if (!dryRun) warnIfExternalWritesPaused(session, VERB_THEME_PUSH);
  const appearanceContext = await readAppearanceWorkspaceContext(config.workspaceDir, siteId);
  const validated = await validateThemeWorkspace(
    config.workspaceDir,
    siteId,
    appearanceContext.knownImageIds,
  );
  const { publishing, themes, scalarOperations } = validated;
  // The save's response replaces the workspace footer document, so refuse
  // while it still carries footer-content edits that footer push has not
  // saved. Colour-only differences are theme push's own to write.
  requireFooterContentPushed(appearanceContext.footer, publishing.footerSettings);
  const baseline = readPresentationBaseline(appearanceContext.manifest);
  if (!dryRun && baseline === undefined) {
    throw new SiteAuthoringError(
      "theme.pull_required",
      "The pull manifest records no presentation baseline, so this push has no revision to be fenced by. Run "
        + "'taproot-site pull' against a Taproot that serves the atomic presentation save, then retry 'theme push'.",
      { field: "presentation.revision" },
    );
  }
  onProgress(`Validated the complete light/dark theme pair and ${scalarOperations.length} appearance settings.`);
  for (const warning of themes.warnings) onProgress(`Espalier warning: ${warning}`);
  const warnings = {
    items: themes.warnings,
    count: themes.warningCount,
    ...(themes.warningsTruncated ? { truncated: true } : {}),
  };

  // The fresh read serves both modes: the dry run compares against it, and
  // the push takes the footer document's draft token from it. Nothing before
  // this point, and nothing in a dry run after it, writes to the site.
  let current;
  try {
    current = await withRefusalGuidance(onProgress, "theme push", async () => await getSitePresentation(client, siteId));
  } catch (error) {
    throw translateServerSupport(error, "read");
  }
  const stale = baseline !== undefined && baseline.revision !== current.revision;
  // A save this workspace sent and never heard back from (TR00807). When the
  // change set about to go is the same one, a moved revision is not evidence
  // of a concurrent edit: it is what that save leaves behind when it
  // committed. Replaying it under the baseline it was sent with lets the site
  // answer already-current, or apply it if it never committed; anything else
  // it refuses itself. A pending record for a different change set proves
  // nothing about the site and takes the ordinary path.
  const changeSet = buildChangeSet(validated);
  const changeSetHash = computePresentationChangeSetHash(changeSet);
  const pending = readPendingPresentationSave(appearanceContext.manifest);
  const replayable = pending !== undefined && pending.changeSetHash === changeSetHash;
  const replaying = stale && replayable;

  if (dryRun) {
    const differences = describeDifferences(validated, current);
    const changed = differences.some((entry) => entry.paths.length > 0 || entry.truncated === true);
    for (const entry of differences) {
      if (entry.paths.length === 0 && entry.truncated !== true) continue;
      onProgress(`${entry.file} differs at: ${entry.paths.join(", ")}${entry.truncated ? ", and more" : ""}.`);
    }
    if (!changed) onProgress("The workspace's presentation matches the site; a push would change nothing.");
    if (baseline === undefined) {
      onProgress("The pull manifest records no presentation baseline; a push would refuse until the workspace is re-pulled.");
    } else if (replaying) {
      onProgress(
        `The site's presentation revision moved since this workspace was pulled (${baseline.revision} → `
          + `${current.revision}), and the manifest records a save of this same change set whose response was `
          + "lost; a push would replay it under its original baseline rather than refuse.",
      );
    } else if (stale) {
      onProgress(
        `The site's presentation revision moved since this workspace was pulled (${baseline.revision} → `
          + `${current.revision}); a push would be refused. Keep copies of the edited files, pull, and re-apply.`,
      );
    }
    onProgress("Dry run: nothing was written.");
    return successResult(VERB_THEME_PUSH, siteId, {
      dryRun: true,
      revision: {
        ...(baseline === undefined ? {} : { baseline: baseline.revision }),
        current: current.revision,
        stale: baseline === undefined ? undefined : stale,
      },
      ...(pending === undefined ? {} : {
        pendingSave: {
          ...(pending.startedAt === undefined ? {} : { startedAt: pending.startedAt }),
          sameChangeSet: replayable,
        },
      }),
      changed,
      differences,
      warnings,
    });
  }

  if (stale && !replaying) {
    // Refused here, before any request that could write, with the same
    // guidance the server's fence would give — and with the paths that
    // differ, which the server cannot know.
    if (pending !== undefined) {
      onProgress(
        "The manifest records an earlier save of a different change set whose response was lost; the site may hold "
          + "it. The pull that refreshes the baseline shows what the site holds now.",
      );
    }
    const differences = describeDifferences(validated, current);
    throw new SiteAuthoringError(
      "theme.concurrent_modification",
      `The site's presentation changed after this workspace was pulled (revision ${baseline.revision} → `
        + `${current.revision}), so nothing was written. Keep copies of the edited settings files, run `
        + "'taproot-site pull' to refresh the baseline, re-apply the edits, and push again; the paths below name "
        + "where the workspace and the site now differ.",
      { field: "revision", alternatives: differences.filter((entry) => entry.paths.length > 0).map((entry) => entry.file) },
    ).withDifferences(differences.flatMap((entry) => entry.paths.map((path) => `${entry.file}:${path}`)));
  }

  const expectedRevision = replaying ? pending.expectedRevision : baseline.revision;
  if (replaying) {
    onProgress(
      `Replaying the presentation save recorded${pending.startedAt === undefined ? "" : ` at ${pending.startedAt}`} `
        + "whose response was lost, under the baseline it was sent with: a save that committed is answered as "
        + "already current and nothing is applied twice; one that did not commit is applied.",
    );
  }
  // Recorded before the request so a lost response leaves a record the next
  // run can replay; the manifest write that follows an answer replaces it.
  if (pending?.expectedRevision !== expectedRevision || pending.changeSetHash !== changeSetHash) {
    await recordPendingPresentationSave(config.workspaceDir, siteId, {
      expectedRevision,
      changeSetHash,
      startedAt: new Date(session.now()).toISOString(),
    });
  }

  // The footer token comes from the read just made: the server overlays the
  // colours onto the document it holds now. On a replay of a committed save
  // the site is already current and the token is not consulted.
  const currentFooter = current.sitePublishingPreferences?.footerSettings ?? {};
  let saved;
  try {
    saved = await withRefusalGuidance(onProgress, "theme push", async () =>
      await saveSitePresentation(client, siteId, {
        expectedRevision,
        expectedFooterDraftHash: computeFooterDraftHash(currentFooter),
        ...changeSet,
      }));
  } catch (error) {
    if (error instanceof SiteAuthoringError && error.code === "transport.mutation_ambiguous") {
      onProgress(
        "The save ended without an authoritative response and is recorded as pending. Run 'taproot-site theme "
          + "push' again with the same settings files: a save that committed is answered as already current and "
          + "nothing is applied twice; one that did not is applied.",
      );
      throw translateSaveRefusal(error);
    }
    // Only a fence refusal proves nothing committed; it drops the pending
    // record so a later run compares against the site rather than replaying
    // under a baseline the site already judged. Any other error keeps it: the
    // server commits the presentation before it derives favicon renditions,
    // so an error answered after that commit has moved the revision, and the
    // record is what lets the next run of the same change set be answered as
    // already current instead of refused as someone else's edit.
    if (error instanceof ApiError && (error.hasField("ExpectedRevision") || error.hasField("ExpectedFooterDraftHash"))) {
      await clearPendingPresentationSave(config.workspaceDir, siteId);
    } else {
      onProgress(
        "The save was answered with an error after it may have committed; it stays recorded as pending, and running "
          + "'taproot-site theme push' again with the same settings files settles it either way.",
      );
    }
    throw translateSaveRefusal(error);
  }

  const { presentation, applied } = saved;
  const savedFooter = presentation.sitePublishingPreferences?.footerSettings;
  if (!isPlainObject(savedFooter)) {
    throw new SiteAuthoringError(
      "api.footer_settings_contract",
      "Taproot returned no footer document with the saved presentation.",
      { field: "footerSettings" },
    );
  }
  // The publishing document is rewritten from the site's copy — footer prose,
  // links and imagery always come from there — and both baselines advance
  // from the same response. Committed remotely before either local write, so
  // a failure here leaves a stale baseline that refuses the next push rather
  // than one that overwrites the save.
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
  await advanceFooterManifest(config.workspaceDir, siteId, projectedFooter, undefined, {
    presentationRevision: presentation.revision,
  });
  onProgress(
    applied
      ? "Saved the complete presentation in one transaction: footer scheme colors, appearance settings, and both "
        + "themes; Brand & Style now treats the color model as externally managed."
      : "The site already held this presentation; nothing was written and the baseline was refreshed.",
  );

  const written = [
    "footerSettings.light/dark colors",
    ...scalarOperations.map((operation) => `${operation.settingsType}.${operation.setting}`),
    ...THEME_SETTINGS.map((setting) => `${SETTINGS_TYPE_TAPROOT_STYLES}.${setting}`),
  ];
  return successResult(VERB_THEME_PUSH, siteId, {
    applied,
    revision: presentation.revision,
    written: boundedList(written, 100),
    warnings,
  });
}
