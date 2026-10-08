import { createHash } from "node:crypto";

import { appearanceImageIds } from "../appearance-contract.js";
import { footerImageIds } from "../footer-contract.js";
import { SETTINGS_TYPE_BRAND, SETTINGS_TYPE_SITE_HEADER, SETTINGS_TYPE_TAPROOT_STYLES } from "../settings-catalog.js";
import {
  getNavigation,
  IMAGE_PROCESSING_STATE_COMPLETE,
  listSiteImages,
  listSitePages,
  listVideos,
  PAGE_STATUS_DELETED,
  withRefusalGuidance,
} from "../api.js";
import {
  LIMITS,
  PLAN_HASH,
  VERB_APPLY,
  VERB_FOOTER_PUSH,
  VERB_MEDIA_UPLOAD,
  VERB_NAV_PUSH,
  VERB_PAGES_PUSH,
  VERB_PLAN,
  VERB_THEME_PUSH,
} from "../constants.js";
import { sharedThemeContextNames } from "../content/free-form-sections.js";
import { SiteAuthoringError } from "../errors.js";
import { computeFooterContentHash, computeFooterDraftHash, stableJson } from "../footer-draft-hash.js";
import { FOOTER_SETTINGS_FILE } from "../footer-workspace.js";
import { CHECK_AREA, collectProblems, problemsError, problemsOf, problemsWithinBudget, withinByteBudget } from "../problems.js";
import { openSession, successResult, warnIfExternalWritesPaused } from "../session.js";
import { IMAGE_IDENTIFIER, usedImageIds } from "../typed-pages.js";
import { checkWorkspace } from "../workspace-check.js";
import { enforceWorkspaceReads, ledgerDigest, recordWorkspaceReads } from "../workspace-ledger.js";
import {
  PAGE_SOURCE_EXTENSIONS,
  PAGES_DIRECTORY,
  readManifest,
  readMediaManifest,
  walkWorkspaceFiles,
} from "../workspace.js";
import { footerPush } from "./footer-push.js";
import { mediaUpload, pendingMediaFiles } from "./media-upload.js";
import { navPush, validateNavigationWorkspaceDocument } from "./nav-push.js";
import {
  liveAuthorsRefresher,
  pagesPush,
  placedVideoProblems,
  planPages,
  plannedPageItem,
  staleGeneratedSourcesField,
} from "./pages-push.js";
import { comparePresentation, presentationMovedRefusal, presentationPullRequired, themePush } from "./theme-push.js";

/**
 * `plan` and `apply` — the whole workspace at once (TR00823).
 *
 * `plan` checks everything a push would check, offline and then against the
 * live site, and orders what is left to send: media the pages reference, then
 * pages, then the footer (theme push refuses while footer content is unsaved),
 * then the theme, then navigation. It writes nothing. `apply --plan <hash>`
 * runs that plan's steps through the ordinary verbs, refusing when the
 * workspace or the site moved since the plan was made.
 *
 * The workspace side of that is the read ledger: everything the plan read is
 * recorded and hashed into the plan, and while the steps run, any workspace
 * read that differs from the plan's, or that the plan never made, stops the
 * step before it writes. What lives on the site and has no server-side fence
 * (page revisions, the navigation tree) is checked against the plan by the
 * steps themselves; the theme and footer saves are fenced by the server.
 *
 * Nothing here is atomic across steps. Each verb keeps its own guards and its
 * own recovery — a page's manifest entry is written as soon as it is sent, a
 * theme save whose answer was lost is replayed — so after a failure the next
 * `plan` shows what is left and finished steps read as nothing to do. Approval,
 * staging, and production stay separate commands.
 */

export const PLAN_STEP = Object.freeze({
  media: VERB_MEDIA_UPLOAD,
  pages: VERB_PAGES_PUSH,
  footer: VERB_FOOTER_PUSH,
  theme: VERB_THEME_PUSH,
  navigation: VERB_NAV_PUSH,
});
const STEP_AREAS = Object.freeze({
  [PLAN_STEP.media]: CHECK_AREA.media,
  [PLAN_STEP.pages]: CHECK_AREA.pages,
  [PLAN_STEP.footer]: CHECK_AREA.footer,
  [PLAN_STEP.theme]: CHECK_AREA.presentation,
  [PLAN_STEP.navigation]: CHECK_AREA.navigation,
});
const STEP_REASONS = Object.freeze({
  [PLAN_STEP.media]: "Pages resolve their media references against the uploads this step records.",
  [PLAN_STEP.pages]: "Navigation and the footer can point only at pages the site already holds.",
  [PLAN_STEP.footer]: "theme push refuses while the footer document carries unsaved content.",
  [PLAN_STEP.theme]: "The theme saves the footer's scheme colors with the rest of the presentation.",
  [PLAN_STEP.navigation]: "Navigation replaces the whole tree, so it goes last, once its targets exist.",
});
const READY = "ready";
const BLOCKED = "blocked";
const NOTHING_TO_DO = "nothing to do";
const PLANNED_AREAS = new Set([CHECK_AREA.presentation, CHECK_AREA.footer, CHECK_AREA.navigation]);
// Stands in for an image `media upload` has not sent yet, so a page that
// references it is still checked in full. One id per file, so checks that
// compare images (a cover the page must use) still tell two pending files
// apart. Never sent: apply uploads first, and pages push resolves against the
// real record.
function pendingImageId(file) {
  const hex = createHash("sha256").update(`pending image:${file}`, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
// What each list in the report may take of the result's 64 KiB, so a plan of
// any size serializes; counts are always complete and the hash covers the
// whole plan. The problems get what is left.
const PAGE_ITEMS_BYTES = 16 * 1024;
// The most image ids one library read accepts.
const IMAGE_IDS_PER_READ = 100;
const MEDIA_ITEMS_BYTES = 8 * 1024;
const DIFFERENCES_BYTES = 8 * 1024;
// Room for the envelope successResult adds and the problem-count fields.
const RESULT_ENVELOPE_BYTES = 4 * 1024;

/** What the site holds of each image, read by id in the batches one read accepts. */
async function readImageStates(client, siteId, ids) {
  const unique = [...new Set(ids)];
  const states = new Map();
  for (let start = 0; start < unique.length; start += IMAGE_IDS_PER_READ) {
    const imageIds = unique.slice(start, start + IMAGE_IDS_PER_READ);
    for (const image of (await listSiteImages(client, siteId, {}, { imageIds })).images) {
      states.set(image.imageId, image.processingState);
    }
  }
  return states;
}

function settingsImageMissing(imageId, where) {
  return new SiteAuthoringError(
    "plan.image_missing",
    `${where} name image ${imageId}, which the site does not hold processed (it was deleted, failed, or belongs `
      + "elsewhere), so the save would be refused. Upload the image again with media upload and use the new id.",
    { field: imageId },
  );
}

function reportedWithin(values, budget) {
  const items = withinByteBudget(values, budget);
  return { items, truncated: items.length < values.length };
}

function differencesWithin(differences) {
  const shown = reportedWithin(differences, DIFFERENCES_BYTES);
  return { differences: shown.items, ...(shown.truncated ? { differencesTruncated: true } : {}) };
}

function step(name, status, detail = {}) {
  return { step: name, status, reason: STEP_REASONS[name], ...detail };
}

function stepStatus(problems, name, changed) {
  if (problems.some((problem) => problem.area === STEP_AREAS[name])) return BLOCKED;
  return changed ? READY : NOTHING_TO_DO;
}

/**
 * Everything `plan` decides, read-only. The hash covers what each step would
 * send and the live state it would be sent against, so `apply` can tell a
 * plan that still describes the workspace and the site from one that does not.
 */
async function preflight(session, invocation) {
  const { client, config, siteId, onProgress } = session;
  const workspaceDir = config.workspaceDir;
  const manifest = await readManifest(workspaceDir, siteId);
  if (manifest.authoringSurface !== undefined) {
    throw new SiteAuthoringError(
      "plan.surface_unsupported",
      "plan covers a standard site's pages, media, footer, theme, and navigation. A Docs site's workspace holds "
        + "its settings only: run 'taproot-site theme push --dry-run' and 'footer push' instead.",
      { field: "authoringSurface", exitCode: 2 },
    );
  }
  const mediaManifest = await readMediaManifest(workspaceDir, siteId);
  const problems = [];

  return await withRefusalGuidance(onProgress, "plan", async () => {
    onProgress("Listing the site's pages.");
    const { pages: livePages, truncated } = await listSitePages(client, siteId, { onProgress });
    if (truncated) {
      throw new SiteAuthoringError(
        "pages.live_list_truncated",
        "The site has more pages than this CLI can enumerate, so an update cannot be told from a create.",
        { field: "pages" },
      );
    }
    const live = livePages.filter((summary) => summary.status !== PAGE_STATUS_DELETED);
    const liveResourceIds = new Set(live.map((summary) => summary.resourceId).filter(Boolean));

    // The shared checks for the presentation, footer, and navigation; pages
    // are checked against the site below, and redirects and forms are left to
    // their own pushes. Navigation targets are judged against the site's
    // pages, as nav push judges them; the footer against the pull's, as
    // footer push does, less any the site has deleted since.
    onProgress("Checking the workspace.");
    const offline = await checkWorkspace({
      workspaceDir,
      siteId,
      manifest,
      mediaManifest,
      binding: {
        resourceIds: new Set(
          manifest.pages.map((entry) => entry?.resourceId).filter((value) => liveResourceIds.has(value)),
        ),
        navigationPages: {
          pageIds: new Set(live.map((summary) => summary.pageId)),
          resourceIds: liveResourceIds,
        },
      },
      content: invocation.content,
      areas: PLANNED_AREAS,
      onProgress,
    });
    problems.push(...offline.problems);

    // What the site holds of every image this plan depends on, read by id so a
    // large library cannot hide one: the recorded uploads, and the images the
    // appearance and footer settings name.
    onProgress("Reading the images this workspace uses, and finding media that has not been uploaded.");
    const presentation = offline.presentation;
    const appearanceImages = presentation === undefined ? [] : appearanceImageIds({
      [SETTINGS_TYPE_TAPROOT_STYLES]: presentation.style,
      [SETTINGS_TYPE_BRAND]: presentation.brand,
      [SETTINGS_TYPE_SITE_HEADER]: presentation.header,
    });
    const footerImages = offline.footer === undefined ? [] : footerImageIds(offline.footer.footerSettings);
    const imageStates = await readImageStates(client, siteId, [
      // The read refuses an id that is not one; such an entry reads as not held.
      ...Object.values(mediaManifest.media).map((entry) => entry?.imageId)
        .filter((value) => typeof value === "string" && IMAGE_IDENTIFIER.test(value)),
      ...appearanceImages,
      ...footerImages,
    ]);
    const videos = Object.values(mediaManifest.videos ?? {})
        .some((entry) => typeof entry?.videoId === "string" && entry.pendingConfirm !== true)
      ? await listVideos(client, siteId)
      : { videos: [], truncated: false };
    const media = await collectProblems(problems, { area: CHECK_AREA.media }, async () =>
      await pendingMediaFiles(workspaceDir, mediaManifest, { imageStates, videos }));
    problems.push(...(media?.problems ?? []));
    const pendingMedia = media?.files ?? [];
    const plannedMedia = {
      ...mediaManifest,
      media: {
        ...mediaManifest.media,
        // Only an image can be a page's image reference; a video stays unresolved.
        ...Object.fromEntries(pendingMedia.filter(({ kind }) => kind === "image").map(({ file, width, height }) => [file, {
          imageId: pendingImageId(file),
          src: "",
          urls: [],
          width,
          height,
          alt: mediaManifest.media[file]?.alt ?? "",
        }])),
      },
    };

    const pages = await planPages({
      workspaceDir,
      siteId,
      manifest,
      mediaManifest: plannedMedia,
      content: invocation.content,
      files: await walkWorkspaceFiles(workspaceDir, PAGES_DIRECTORY, PAGE_SOURCE_EXTENSIONS),
      livePages,
      online: true,
      // Asked of the site but never written down: `plan` leaves the workspace as it found it.
      refreshAuthors: liveAuthorsRefresher({ client, workspaceDir, siteId, write: false, onProgress }),
      // From the theme validated above, so a broken styles file is one problem, not one per page.
      getSharedThemeContexts: async () =>
        offline.presentation === undefined
          ? undefined
          : sharedThemeContextNames(offline.presentation.style.lightTheme, offline.presentation.style.darkTheme),
      onProgress,
    });
    problems.push(...pages.problems);
    problems.push(...await placedVideoProblems(client, siteId, pages.planned));
    const sending = pages.planned.filter((page) => !page.unchanged);

    // An image a page names must be one the site holds; an image this plan
    // uploads is the media step's to supply.
    const pendingImageIds = new Set(pendingMedia.filter(({ kind }) => kind === "image").map(({ file }) => pendingImageId(file)));
    const pageImages = sending.flatMap((page) =>
      [...usedImageIds(page.document)]
        .filter((imageId) => !pendingImageIds.has(imageId) && IMAGE_IDENTIFIER.test(imageId))
        .map((imageId) => ({ file: page.file, imageId }))
    );
    const unread = pageImages.map(({ imageId }) => imageId).filter((imageId) => !imageStates.has(imageId));
    const pageImageStates = unread.length === 0
      ? imageStates
      : new Map([...imageStates, ...await readImageStates(client, siteId, unread)]);
    for (const { file, imageId } of pageImages) {
      if (pageImageStates.has(imageId)) continue;
      problems.push(...problemsOf(new SiteAuthoringError(
        "plan.page_image_missing",
        `'${file}' names image ${imageId}, which this site does not hold (it was deleted, or belongs to another `
          + "site). Upload the file with media upload and refer to it by its media path.",
        { field: imageId },
      ), { area: CHECK_AREA.pages, file }));
    }

    onProgress("Reading the site's presentation.");
    let theme;
    if (offline.presentation !== undefined) {
      theme = await comparePresentation(client, siteId, offline.presentation, manifest);
      // Only a theme step that would run can be refused.
      if (theme.changed && theme.baseline === undefined) {
        problems.push(...problemsOf(presentationPullRequired(), { area: CHECK_AREA.presentation }));
      } else if (theme.changed && theme.stale && !theme.replaying) {
        problems.push(...problemsOf(presentationMovedRefusal(theme), { area: CHECK_AREA.presentation }));
      }
    }

    // Compared as written, the way theme push's own guard compares it.
    const workspaceFooter = offline.presentation?.publishing.footerSettings;
    const footerChanged = workspaceFooter !== undefined
      && computeFooterContentHash(workspaceFooter) !== manifest.footer?.expectedContentHash;
    const liveFooterDraftHash = theme === undefined
      ? undefined
      : computeFooterDraftHash(theme.current.sitePublishingPreferences?.footerSettings ?? {});
    if (footerChanged && liveFooterDraftHash !== undefined && liveFooterDraftHash !== manifest.footer?.expectedDraftHash) {
      problems.push(...problemsOf(new SiteAuthoringError(
        "footer.concurrent_modification",
        "The footer changed on the site after this workspace was pulled, so footer push would be refused. Pull, "
          + "reconcile the footer document, and plan again.",
        { field: "expectedFooterDraftHash" },
      ), { area: CHECK_AREA.footer, file: FOOTER_SETTINGS_FILE }));
    }

    // A settings save refuses an image the site no longer holds processed.
    const unheld = (imageIds) => imageIds.filter((imageId) => imageStates.get(imageId) !== IMAGE_PROCESSING_STATE_COMPLETE);
    if (theme?.changed === true) {
      for (const imageId of unheld(appearanceImages)) {
        problems.push(...problemsOf(settingsImageMissing(imageId, "the appearance settings"), { area: CHECK_AREA.presentation }));
      }
    }
    if (footerChanged) {
      for (const imageId of unheld(footerImages)) {
        problems.push(...problemsOf(settingsImageMissing(imageId, "the footer"), {
          area: CHECK_AREA.footer,
          file: FOOTER_SETTINGS_FILE,
        }));
      }
    }

    onProgress("Reading the site's navigation.");
    let liveNavigation;
    let navigationChanged = false;
    if (offline.navigation !== undefined) {
      liveNavigation = await getNavigation(client, siteId);
      let liveItems;
      try {
        liveItems = validateNavigationWorkspaceDocument({ siteId, navItems: liveNavigation }, siteId).navItems;
      } catch (error) {
        // A live tree this CLI would not write is different from any tree it would.
        if (!(error instanceof SiteAuthoringError)) throw error;
        liveItems = liveNavigation;
      }
      navigationChanged = stableJson(liveItems) !== stableJson(offline.navigation.navItems);
    }

    const pagesItems = reportedWithin(pages.planned.map(plannedPageItem), PAGE_ITEMS_BYTES);
    const mediaItems = reportedWithin(pendingMedia.map(({ file }) => file), MEDIA_ITEMS_BYTES);
    const steps = [
      step(PLAN_STEP.media, stepStatus(problems, PLAN_STEP.media, pendingMedia.length > 0), {
        files: pendingMedia.length,
        items: mediaItems.items,
        ...(mediaItems.truncated ? { itemsTruncated: true } : {}),
      }),
      step(PLAN_STEP.pages, stepStatus(problems, PLAN_STEP.pages, sending.length > 0), {
        create: sending.filter((page) => page.action === "created").length,
        update: sending.filter((page) => page.action === "updated").length,
        unchanged: pages.planned.length - sending.length,
        ...staleGeneratedSourcesField(pages.staleGenerated),
        items: pagesItems.items,
        ...(pagesItems.truncated ? { itemsTruncated: true } : {}),
      }),
      step(PLAN_STEP.footer, stepStatus(problems, PLAN_STEP.footer, footerChanged)),
      // A save whose answer was lost and that committed leaves nothing to
      // change, but its record is settled only by running theme push again.
      step(PLAN_STEP.theme, stepStatus(problems, PLAN_STEP.theme, theme?.changed === true || theme?.replaying === true), {
        ...(theme === undefined ? {} : {
          ...differencesWithin(theme.differences.filter((entry) => entry.paths.length > 0 || entry.truncated === true)),
          ...(theme.replaying ? { replaysLostSave: true } : {}),
        }),
      }),
      step(PLAN_STEP.navigation, stepStatus(problems, PLAN_STEP.navigation, navigationChanged)),
    ];
    const planHash = `sha256:${createHash("sha256").update(stableJson({
      version: 1,
      siteId,
      media: pendingMedia.map((entry) => [entry.file, entry.identity]),
      pages: pages.planned.map((page) => [page.file, page.action, page.unchanged, page.contentKey, page.pageId ?? "", page.revision ?? ""]),
      footer: [footerChanged, workspaceFooter === undefined ? "" : computeFooterContentHash(workspaceFooter), liveFooterDraftHash ?? ""],
      theme: theme === undefined ? [] : [theme.changeSetHash, theme.current.revision],
      navigation: [stableJson(offline.navigation?.navItems ?? null), stableJson(liveNavigation ?? null)],
      problems: problems.map((problem) => [problem.area ?? "", problem.file ?? "", problem.code, problem.field ?? ""]),
    }), "utf8").digest("hex")}`;
    return {
      steps,
      problems,
      pendingMedia,
      planHash,
      // The live state each step must still find, where the server has no fence.
      plannedPages: new Map(sending.map((page) => [page.file, stableJson([page.pageId ?? "", page.revision ?? "", page.action])])),
      plannedLiveNavigation: stableJson(liveNavigation ?? null),
    };
  });
}

/**
 * The plan, with every workspace read it made recorded. The plan hash covers
 * that record, so a workspace edited between plan and apply changes it.
 */
async function recordedPlan(session, invocation) {
  const { result: planned, ledger } = await recordWorkspaceReads(() => preflight(session, invocation));
  const planHash = `sha256:${createHash("sha256").update(stableJson([planned.planHash, ledgerDigest(ledger)]), "utf8").digest("hex")}`;
  return { ...planned, planHash, ledger };
}

function planReport(planned) {
  const { steps, problems, planHash } = planned;
  const report = {
    planHash,
    ready: problems.length === 0,
    steps,
    checked: [
      "every page source, against the live site's pages, revisions, and video library",
      "media under media/ that pages reference and media upload has not sent",
      "the theme, appearance, and footer colors, against the site's presentation revision",
      "the footer document, against the site's footer draft and the pages it still holds",
      "every image the theme and footer name, and every recorded upload, against the site's images",
      "navigation shape and page targets, against the live page list and navigation",
    ],
    notChecked: [
      "redirects and forms: run 'redirects push' and 'forms push' on their own",
      "rendering: preview pages before approving them",
      "approval, staging, and production, which stay separate commands",
    ],
  };
  // The problems get whatever the rest of the report leaves of the result's
  // bound, so a long plan still serializes.
  const rest = Buffer.byteLength(JSON.stringify(report), "utf8");
  const shown = problemsWithinBudget(problems, LIMITS.githubOutputBytes - RESULT_ENVELOPE_BYTES - rest);
  return {
    ...report,
    problems: shown,
    problemCount: problems.length,
    ...(shown.length < problems.length ? { problemsTruncated: true } : {}),
  };
}

export async function plan(invocation) {
  const session = await openSession(invocation);
  const planned = await recordedPlan(session, invocation);
  const report = planReport(planned);
  for (const entry of report.steps) onStepProgress(session.onProgress, entry);
  session.onProgress(
    report.ready
      ? `Ready: run 'taproot-site apply --plan ${report.planHash}' to send it. Nothing was written.`
      : `${planned.problems.length} problem(s) block the plan; fix them and plan again. Nothing was written.`,
  );
  return successResult(VERB_PLAN, session.siteId, report);
}

function onStepProgress(onProgress, entry) {
  onProgress(`${entry.step}: ${entry.status}.`);
}

/**
 * The verb each step runs, with the arguments that make it send exactly what
 * the plan listed. The session's client is shared so one credential exchange
 * serves every step.
 */
const STEP_RUNNERS = Object.freeze({
  [PLAN_STEP.media]: (invocation, planned) =>
    mediaUpload({ ...invocation, verb: PLAN_STEP.media, paths: planned.pendingMedia.map(({ file }) => file) }),
  [PLAN_STEP.pages]: (invocation, planned) => pagesPush({
    ...invocation,
    verb: PLAN_STEP.pages,
    pagePaths: undefined,
    dryRun: false,
    plannedPages: planned.plannedPages,
  }),
  [PLAN_STEP.footer]: (invocation) => footerPush({ ...invocation, verb: PLAN_STEP.footer }),
  [PLAN_STEP.theme]: (invocation) => themePush({ ...invocation, verb: PLAN_STEP.theme, dryRun: false }),
  [PLAN_STEP.navigation]: (invocation, planned) =>
    navPush({ ...invocation, verb: PLAN_STEP.navigation, plannedLiveNavigation: planned.plannedLiveNavigation }),
});

export async function apply(invocation) {
  if (typeof invocation.planHash !== "string" || !PLAN_HASH.test(invocation.planHash)) {
    throw new SiteAuthoringError(
      "apply.plan_required",
      "apply requires --plan with the planHash that 'taproot-site plan' reported.",
      { field: "planHash", exitCode: 2 },
    );
  }
  const session = await openSession(invocation);
  warnIfExternalWritesPaused(session, VERB_APPLY);
  const { siteId, onProgress } = session;
  onProgress("Re-planning to confirm the workspace and the site still match the plan.");
  const planned = await recordedPlan(session, invocation);
  if (planned.planHash !== invocation.planHash) {
    throw new SiteAuthoringError(
      "apply.plan_stale",
      "The workspace or the site changed since that plan was made, so nothing was applied. Run 'taproot-site plan' "
        + "again, read it, and apply the new planHash.",
      { field: "planHash", alternatives: [planned.planHash] },
    );
  }
  if (planned.problems.length > 0) throw problemsError(planned.problems, "apply sent nothing; the plan has problems");

  const ready = planned.steps.filter((entry) => entry.status === READY);
  const completed = [];
  const stepInvocation = { ...invocation, client: session.client, resolvedConfig: session.config };
  await enforceWorkspaceReads(planned.ledger, () => runSteps(ready, completed, stepInvocation, planned, onProgress));
  onProgress(
    completed.length === 0
      ? "Nothing to apply: every step was already current."
      : "Applied. Pages are drafts until 'taproot-site approve'; nothing was deployed.",
  );
  return successResult(VERB_APPLY, siteId, {
    planHash: planned.planHash,
    applied: completed,
    skipped: planned.steps.filter((entry) => entry.status !== READY).map((entry) => entry.step),
    ...(completed.some((done) => done.step === PLAN_STEP.pages) ? { nextStep: "approve" } : {}),
  });
}

/**
 * The plan's ready steps, in order, inside the read ledger's enforcement. A
 * failure names what completed, what failed and what did not run; an
 * unexpected error is reported the same way, since earlier steps may already
 * have written.
 */
async function runSteps(ready, completed, stepInvocation, planned, onProgress) {
  for (const [index, entry] of ready.entries()) {
    onProgress(`Applying step ${index + 1} of ${ready.length}: ${entry.step}.`);
    try {
      const result = await STEP_RUNNERS[entry.step](stepInvocation, planned);
      completed.push({ step: entry.step, result: stepSummary(entry.step, result) });
    } catch (thrown) {
      const error = thrown instanceof SiteAuthoringError
        ? thrown
        : new SiteAuthoringError("apply.step_failed", `${entry.step} failed unexpectedly${unexpectedName(thrown)}.`, {
          cause: thrown,
        });
      const remaining = ready.slice(index + 1).map((next) => next.step);
      onProgress(
        `${entry.step} failed; ${completed.length} step(s) completed before it`
          + `${remaining.length === 0 ? "" : ` and ${remaining.join(", ")} did not run`}. Run 'taproot-site plan' `
          + "again: finished work reads as nothing to do, and a step that may have committed is reconciled by its "
          + "own verb rather than repeated blindly.",
      );
      // Step labels first: the list is bounded, and a step's own detail can be long.
      throw error.withCompletedWrites([
        ...completed.map((done) => `${done.step}: completed`),
        `${entry.step}: failed`,
        ...remaining.map((name) => `${name}: not run`),
        ...(error.completedWrites ?? []),
      ]);
    }
  }
}

/** The error's class name or code, never its message, which can carry a path or a credential. */
function unexpectedName(error) {
  const name = typeof error?.code === "string" ? error.code : error?.name;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name) ? ` (${name})` : "";
}

/** The few counts worth repeating from each verb's own result. */
function stepSummary(name, result) {
  switch (name) {
    case PLAN_STEP.media:
      return { images: result.media?.total, videos: result.videos?.total };
    case PLAN_STEP.pages:
      return { created: result.pages?.created, updated: result.pages?.updated, unchanged: result.pages?.unchanged };
    case PLAN_STEP.theme:
      return { applied: result.applied, revision: result.revision };
    case PLAN_STEP.navigation:
      return { items: result.navigation?.items };
    default:
      return {};
  }
}
