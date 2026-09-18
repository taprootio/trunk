import { isCanonicalUuid, SiteAuthoringError } from "./errors.js";
import { appearanceImageIds } from "./appearance-contract.js";
import { footerImageIds } from "./footer-contract.js";
import { createHash } from "node:crypto";
import { computeFooterContentHash, computeFooterDraftHash, stableJson } from "./footer-draft-hash.js";
import { readManifest, readMediaManifest, writeManifest } from "./workspace.js";

export const FOOTER_SETTINGS_FILE = "settings/site-publishing-preferences.json";
const SHA256 = /^[0-9a-f]{64}$/u;

function invalid(message, field) {
  throw new SiteAuthoringError("footer.pull_required", message, { field });
}

function requireFooterMetadata(manifest) {
  const footer = manifest.footer;
  if (footer === null || typeof footer !== "object" || Array.isArray(footer)) {
    invalid("The pull manifest does not record a footer baseline. Run 'taproot-site pull' again.", "footer");
  }
  if (footer.file !== FOOTER_SETTINGS_FILE || !SHA256.test(footer.expectedDraftHash ?? "")) {
    invalid(
      "The pull manifest has an invalid footer concurrency baseline. Run 'taproot-site pull' again.",
      "footer.expectedDraftHash",
    );
  }
  if (!Array.isArray(footer.imageIds) || footer.imageIds.some((id) => !isCanonicalUuid(id))) {
    invalid("The pull manifest has invalid footer image identities. Run 'taproot-site pull' again.", "footer.imageIds");
  }
  return footer;
}

function requireAppearanceMetadata(manifest, { required = true, code = "theme.pull_required" } = {}) {
  const appearance = manifest.appearance;
  if (appearance === undefined && !required) return undefined;
  if (appearance === null || typeof appearance !== "object" || Array.isArray(appearance)) {
    throw new SiteAuthoringError(
      code,
      "The pull manifest does not record an appearance image baseline. Run 'taproot-site pull' again.",
      { field: "appearance" },
    );
  }
  if (!Array.isArray(appearance.imageIds) || appearance.imageIds.some((id) => !isCanonicalUuid(id))) {
    throw new SiteAuthoringError(
      code,
      "The pull manifest has invalid appearance image identities. Run 'taproot-site pull' again.",
      { field: "appearance.imageIds" },
    );
  }
  return appearance;
}

export async function readFooterWorkspaceContext(workspaceDir, siteId) {
  const manifest = await readManifest(workspaceDir, siteId);
  const footer = requireFooterMetadata(manifest);
  const mediaManifest = await readMediaManifest(workspaceDir, siteId);
  const knownPageResourceIds = new Set(
    manifest.pages.map((page) => page?.resourceId).filter((id) => isCanonicalUuid(id)),
  );
  const appearance = requireAppearanceMetadata(manifest, { required: false, code: "footer.pull_required" });
  const knownImageIds = new Set([...footer.imageIds, ...(appearance?.imageIds ?? [])]);
  for (const value of Object.values(mediaManifest.media)) {
    if (isCanonicalUuid(value?.imageId)) knownImageIds.add(value.imageId);
  }
  return { manifest, footer, knownPageResourceIds, knownImageIds };
}

export async function readAppearanceWorkspaceContext(workspaceDir, siteId) {
  const context = await readFooterWorkspaceContext(workspaceDir, siteId);
  const appearance = requireAppearanceMetadata(context.manifest);
  return {
    ...context,
    appearance,
    knownImageIds: new Set([...context.knownImageIds, ...appearance.imageIds]),
  };
}

export async function advanceFooterManifest(
  workspaceDir,
  siteId,
  footerSettings,
  expectedDraftHash,
  { presentationRevision } = {},
) {
  const manifest = await readManifest(workspaceDir, siteId);
  const prior = requireFooterMetadata(manifest);
  const hash = expectedDraftHash ?? computeFooterDraftHash(footerSettings);
  if (!SHA256.test(hash)) {
    throw new SiteAuthoringError(
      "api.footer_settings_contract",
      "Taproot returned a footer document whose draft hash could not be recorded.",
      { field: "footerDraftHash" },
    );
  }
  manifest.footer = {
    file: FOOTER_SETTINGS_FILE,
    expectedDraftHash: hash,
    expectedContentHash: computeFooterContentHash(footerSettings),
    imageIds: [...new Set([...prior.imageIds, ...footerImageIds(footerSettings)])].sort(),
  };
  // The ten scheme colours are part of the presentation change set, so a
  // footer save that moved one moved the revision too; the server reports the
  // new one from the same transaction and it becomes the baseline the next
  // theme push must carry (TR00807). One manifest write for both baselines.
  if (presentationRevision !== undefined) {
    manifest.presentation = presentationManifestEntry(presentationRevision);
  }
  await writeManifest(workspaceDir, manifest);
  return hash;
}

/**
 * The manifest's record of the presentation revision this workspace was
 * pulled at (TR00807): what `theme push` sends as its baseline, and what a
 * dry run compares the site's current revision against.
 */
export function presentationManifestEntry(revision) {
  if (!SHA256.test(revision ?? "")) {
    throw new SiteAuthoringError(
      "api.presentation_contract",
      "Taproot returned a presentation revision that could not be recorded.",
      { field: "revision" },
    );
  }
  return { revision };
}

/**
 * The recorded presentation baseline, or `undefined` when the manifest holds
 * none — a workspace pulled before the atomic save existed, or against a
 * Taproot that does not serve it. Absent is a fact `theme push` refuses on,
 * not a value to guess.
 */
export function readPresentationBaseline(manifest) {
  const presentation = manifest.presentation;
  if (presentation === null || typeof presentation !== "object" || Array.isArray(presentation)) return undefined;
  return SHA256.test(presentation.revision ?? "") ? { revision: presentation.revision } : undefined;
}

/**
 * The content identity of one presentation change set — what `theme push`
 * sends — so a later run can tell whether a save recorded as pending was for
 * exactly the change set it is about to send again.
 */
export function computePresentationChangeSetHash(changeSet) {
  return createHash("sha256").update(`presentation-change-set-v1${stableJson(changeSet)}`, "utf8").digest("hex");
}

/**
 * The record of a presentation save whose outcome this workspace does not yet
 * know (TR00807): the baseline it was sent under and the change set it
 * carried, written before the request and replaced by the manifest write
 * that follows an authoritative answer. A save that committed while its
 * response was lost leaves the site one revision ahead of the workspace; the
 * next push of the same change set replays it under this baseline, and the
 * site answers already-current instead of the stale refusal the workspace's
 * own comparison would give. `undefined` when nothing is pending.
 */
export function readPendingPresentationSave(manifest) {
  const pending = manifest.presentation?.pending;
  if (pending === null || typeof pending !== "object" || Array.isArray(pending)) return undefined;
  if (!SHA256.test(pending.expectedRevision ?? "") || !SHA256.test(pending.changeSetHash ?? "")) return undefined;
  return {
    expectedRevision: pending.expectedRevision,
    changeSetHash: pending.changeSetHash,
    startedAt: typeof pending.startedAt === "string" ? pending.startedAt : undefined,
  };
}

export async function recordPendingPresentationSave(workspaceDir, siteId, { expectedRevision, changeSetHash, startedAt }) {
  const manifest = await readManifest(workspaceDir, siteId);
  const baseline = readPresentationBaseline(manifest);
  if (baseline === undefined) {
    throw new SiteAuthoringError(
      "theme.pull_required",
      "The pull manifest records no presentation baseline. Run 'taproot-site pull' again.",
      { field: "presentation.revision" },
    );
  }
  manifest.presentation = { revision: baseline.revision, pending: { expectedRevision, changeSetHash, startedAt } };
  await writeManifest(workspaceDir, manifest);
}

/** Drops the pending record after an authoritative refusal; the baseline stays. */
export async function clearPendingPresentationSave(workspaceDir, siteId) {
  const manifest = await readManifest(workspaceDir, siteId);
  const baseline = readPresentationBaseline(manifest);
  if (baseline === undefined || readPendingPresentationSave(manifest) === undefined) return;
  manifest.presentation = presentationManifestEntry(baseline.revision);
  await writeManifest(workspaceDir, manifest);
}

export function footerManifestEntry(footerSettings) {
  return {
    file: FOOTER_SETTINGS_FILE,
    expectedDraftHash: computeFooterDraftHash(footerSettings),
    expectedContentHash: computeFooterContentHash(footerSettings),
    imageIds: footerImageIds(footerSettings),
  };
}

/**
 * `theme push` begins with a fresh server read that replaces the workspace
 * footer document, so an unpushed footer-content edit would be silently lost.
 * Refuse while the workspace footer's content hash differs from the recorded
 * pull baseline. The ten scheme colors `theme push` overlays are excluded
 * from the comparison, so a colour-only edit passes. A manifest that predates
 * the baseline cannot prove the workspace is clean and refuses toward pull:
 * assuming "unchanged" is exactly the data loss this guard exists to stop.
 */
export function requireFooterContentPushed(footer, workspaceFooterSettings) {
  if (!SHA256.test(footer.expectedContentHash ?? "")) {
    throw new SiteAuthoringError(
      "theme.pull_required",
      "The pull manifest predates the footer-content baseline. Run 'taproot-site footer push' to save the local "
        + "footer and record it, or 'taproot-site pull' to discard local edits and re-record it, then retry 'theme push'.",
      { field: "footer.expectedContentHash" },
    );
  }
  if (computeFooterContentHash(workspaceFooterSettings) !== footer.expectedContentHash) {
    throw new SiteAuthoringError(
      "theme.unpushed_footer_content",
      `${FOOTER_SETTINGS_FILE} carries footer-content edits that 'theme push' would overwrite with the server's copy. `
        + "Run 'taproot-site footer push' to save them first, or 'taproot-site pull' to discard them.",
      { field: FOOTER_SETTINGS_FILE },
    );
  }
}

export function appearanceManifestEntry(documents) {
  return { imageIds: appearanceImageIds(documents) };
}
