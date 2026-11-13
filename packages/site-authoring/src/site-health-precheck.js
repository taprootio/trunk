import { listSiteImagesByIds, updateSiteImageDescription } from "./api.js";
import {
  LIMITS,
  REFUSAL_CAPABILITY_MISSING,
  REFUSAL_CLI_OUTDATED,
  REFUSAL_CREDENTIAL_REJECTED,
  REFUSAL_PLATFORM_PAUSED,
  REFUSAL_THROTTLED,
} from "./constants.js";
import { outcomeUnknown, SiteAuthoringError } from "./errors.js";
import { placedImageIds } from "./placed-image-ids.js";
import { boundedByBytes } from "./session.js";
import {
  IMAGE_CHECK_READ_FAILED,
  IMAGE_CHECK_READ_PARTLY_FAILED,
  MAXIMUM_PROGRESS_LINES,
  SITE_CHECK_RULES,
} from "./site-check-findings.js";
import { evaluateImageDefaultMissing } from "./site-health-image-checks.js";
import { altsFromDocument, buildImageFinding, imageFindingLine, mergeAlts, usableDescription } from "./site-health-findings.js";
import { documentTemplate, PAGE_TEMPLATES, wireTemplate } from "./typed-pages.js";
import { translateImageDescriptionRefusal } from "./verbs/media-images.js";
import { displayPagePath } from "./workspace.js";

/**
 * Site Health's image description rule, run before staging from what the workspace places (TR01371). `validate
 * --site` and `pages push` share it. It reads the site's own image records once, evaluates the shared rule over the
 * pages the command selected, and reports each undescribed image with the exact fix, as the stored report does
 * after staging. A warning is reported and never refuses.
 */

const RULE = SITE_CHECK_RULES.find((rule) => rule.id === "a11y.image_default_missing").id;
/** The most the findings and the not-in-library ids take of a result, before the result itself is fitted. */
export const PRECHECK_BUDGETS = Object.freeze({ imageFindings: 12 * 1024, notInSiteLibrary: 2 * 1024 });

const STATUS_CHECKED = "checked";
const STATUS_PARTIAL = "partial";
const STATUS_NOT_CHECKED = "not_checked";

const REASONS = Object.freeze({
  [IMAGE_CHECK_READ_FAILED]: "The site's image records could not be read, so image descriptions were not checked.",
  [IMAGE_CHECK_READ_PARTLY_FAILED]:
    "Some of the site's image records could not be read, so only the images that were read were checked.",
});

/**
 * The pages a command selected, as the evaluator takes them: keyed by workspace file (a new page has no id yet),
 * with each page's placed image ids and its converted document, which the alt text is read from later. A page whose
 * wire form cannot be built contributes no ids, because the conversion already accepted it.
 */
export function placedImageIdsForPages(pages) {
  return pages.map((page) => {
    let imageIds = [];
    try {
      const template = documentTemplate(page.document);
      imageIds = [...placedImageIds(template, wireTemplate(page.document)[PAGE_TEMPLATES[template].dataKey])];
      // The cover is a field beside the body, so the walk does not see it; the freezer adds it the same way.
      const cover = page.document.coverImageId;
      if (typeof cover === "string" && cover !== "") imageIds.push(cover.toLowerCase());
    } catch {
      imageIds = [];
    }
    return { key: page.file, path: displayPagePath(page.pagePath), title: page.title, imageIds, document: page.document };
  });
}

/**
 * Reads the site's records for every image the pages place, once, in batches of 100. A failed or denied batch never
 * throws: its ids are in `failedIds`, and `status` says whether every batch was read, some, or none. With no
 * placed image it makes no request. `records` is a Map keyed by image id that a later step may update in place.
 */
export async function readImageRecords(client, siteId, imageIds) {
  const ids = [...new Set(imageIds)].sort();
  if (ids.length === 0) return { siteId, ids, records: new Map(), failedIds: [], status: STATUS_CHECKED };
  const read = await listSiteImagesByIds(client, siteId, ids);
  const status = read.failedIds.length === 0
    ? STATUS_CHECKED
    : read.failedIds.length === ids.length
    ? STATUS_NOT_CHECKED
    : STATUS_PARTIAL;
  const code = status === STATUS_NOT_CHECKED
    ? IMAGE_CHECK_READ_FAILED
    : status === STATUS_PARTIAL
    ? IMAGE_CHECK_READ_PARTLY_FAILED
    : undefined;
  return {
    siteId,
    ids,
    records: new Map(read.images.map((image) => [image.imageId, image])),
    failedIds: read.failedIds,
    status,
    ...(code === undefined ? {} : { reason: { code, message: REASONS[code] } }),
    ...(read.refusalError === undefined ? {} : { refusalError: read.refusalError }),
  };
}

const listOf = (items, budget) => {
  const kept = boundedByBytes(items, budget);
  return { total: items.length, items: kept.items, ...(kept.truncated ? { truncated: true } : {}) };
};

/**
 * Turns the kept state and the selected pages into the block a result reports, and prints its progress lines: one
 * for each finding (at most 20, then a count) and one saying how many images could not be read. It reads nothing,
 * so it runs when the result is built and reports whatever the records then hold.
 *
 * Findings are ordered by image id, so a bounded list keeps the same findings on every run. An id the site did not
 * return (deleted, or owned by another site, a profile or an integration) is `notInSiteLibrary` and no finding; an
 * id in a failed batch is in neither list.
 */
export function evaluateImagePrecheck(state, pages, onProgress = () => {}) {
  const found = evaluateImageDefaultMissing({
    pages,
    images: [...state.records.values()]
      .sort((left, right) => (left.imageId < right.imageId ? -1 : left.imageId > right.imageId ? 1 : 0))
      .map((image) => ({
        imageId: image.imageId,
        name: image.name,
        ...(image.defaultDescription === undefined ? {} : { defaultDescription: image.defaultDescription }),
      })),
    siteId: state.siteId,
  });
  // Alt text is only needed to suggest a fix, and each page is its own failure: a page that cannot be walked
  // contributes nothing.
  const alts = new Map();
  if (found.length > 0) {
    for (const page of pages) {
      try {
        mergeAlts(alts, altsFromDocument(page.document));
      } catch {
        continue;
      }
    }
  }
  const findings = found.map((finding) =>
    buildImageFinding({
      imageId: finding.imageId,
      name: finding.name,
      descriptionRevision: state.records.get(finding.imageId).descriptionRevision,
      hasDefault: false,
      available: true,
      alts: alts.get(finding.imageId) ?? [],
      affectedPages: finding.affectedPages.map((page) => ({ path: page.path, title: page.title, file: page.key })),
    })
  );
  const failed = new Set(state.failedIds);
  const notInSiteLibrary = state.ids.filter((id) => !state.records.has(id) && !failed.has(id));

  if (state.failedIds.length > 0) {
    onProgress(
      `Warning: ${state.failedIds.length} image(s) could not be read from the site, so their descriptions were not checked.`,
    );
  }
  for (const finding of findings.slice(0, MAXIMUM_PROGRESS_LINES)) onProgress(imageFindingLine(finding));
  if (findings.length > MAXIMUM_PROGRESS_LINES) {
    onProgress(`Warning: ${findings.length - MAXIMUM_PROGRESS_LINES} more undescribed image(s); see imageFindings.`);
  }
  return {
    status: state.status,
    checkedPages: pages.length,
    imageFindings: listOf(findings, PRECHECK_BUDGETS.imageFindings),
    notInSiteLibrary: listOf(notInSiteLibrary, PRECHECK_BUDGETS.notInSiteLibrary),
    skipped: state.status === STATUS_CHECKED ? [] : [RULE],
    ...(state.reason === undefined ? {} : { reason: state.reason }),
  };
}

const listAt = (value, path) => path.split(".").reduce((node, key) => node?.[key], value);

/**
 * Shrinks the new blocks so the result still fits the output bound. `base` is the result without them, `blocks` are
 * the top-level keys to add, and `order` names the `{ total, items, truncated? }` lists to shrink, first to last,
 * each down to empty if needed, as dotted paths into `blocks`. A list that is absent is skipped, so a block a
 * later story adds needs no change here. Every `total` is kept, and a shrunk list is marked `truncated`. It never
 * throws: a base that already fills the bound is returned with empty lists and fails where the result is
 * serialized, as it does today.
 */
export function fitPrecheckToBudget(base, blocks, order, budget = LIMITS.githubOutputBytes) {
  const fitted = structuredClone(blocks);
  const size = () => Buffer.byteLength(JSON.stringify({ ...base, ...fitted }), "utf8");
  for (const path of order) {
    const list = listAt(fitted, path);
    if (list === undefined || !Array.isArray(list.items)) continue;
    while (size() > budget && list.items.length > 0) {
      list.items.pop();
      list.truncated = true;
    }
  }
  return fitted;
}

// ---------------------------------------------------------------------------
// --describe-missing-images (TR01372)
// ---------------------------------------------------------------------------

/** What the report of a flagged push carries about the images it set or skipped; `set` and `skipped` are bounded. */
export const DESCRIBED_IMAGES_BUDGETS = Object.freeze({ set: 3 * 1024, skipped: 1 * 1024 });

/**
 * Which placed images the flag would set, and why it leaves the others: ascending by image id, from the kept read
 * state and the selected pages. An image is a candidate when its kept record has no default (so one already
 * described at read time is not listed) or when its id is in a failed read batch, which cannot be set (`not_read`).
 * The text is the one distinct alt the selected placements agree on; none is `no_alt`, two or more `alts_disagree`,
 * and one that cannot be put in a describe command `unusable_alt`. Pure: it reads nothing.
 */
export function planImageDescriptions(state, pages) {
  const failed = new Set(state.failedIds);
  const candidates = [
    ...[...state.records.values()].filter((record) => record.defaultDescription === undefined).map((record) => record.imageId),
    ...state.failedIds,
  ];
  const alts = new Map();
  if (candidates.length > 0) {
    for (const page of pages) {
      try {
        mergeAlts(alts, altsFromDocument(page.document));
      } catch {
        continue;
      }
    }
  }
  return [...new Set(candidates)].sort().map((imageId) => {
    if (failed.has(imageId)) return { imageId, reason: "not_read" };
    const texts = alts.get(imageId) ?? [];
    if (texts.length === 0) return { imageId, reason: "no_alt" };
    if (texts.length > 1) return { imageId, reason: "alts_disagree" };
    const description = usableDescription(texts[0]);
    return description === undefined
      ? { imageId, reason: "unusable_alt" }
      : { imageId, description, expectedRevision: state.records.get(imageId).descriptionRevision };
  });
}

/** What the command does after a refused or failed description write, by the story's table, in its order. */
export function classifyDescriptionFailure(error) {
  if (!(error instanceof SiteAuthoringError)) return { action: "fail" };
  if (error.code === "site.cancelled") return { action: "fail" };
  const kind = typeof error.refusalKind === "function" ? error.refusalKind() : undefined;
  if ([REFUSAL_CLI_OUTDATED, REFUSAL_PLATFORM_PAUSED, REFUSAL_CREDENTIAL_REJECTED].includes(kind)) return { action: "fail" };
  if (kind === REFUSAL_THROTTLED) return { action: "stop", reason: "write_failed" };
  if (kind === REFUSAL_CAPABILITY_MISSING || error.httpStatus === 403) return { action: "stop", reason: "write_denied" };
  // The PATCH may have committed when it ended this way, so the image is never reported as failed.
  if (
    outcomeUnknown(error)
    || ["api.image_description_contract", "api.image_contract", "api.image_state"].includes(error.code)
  ) {
    return { action: "unknown", reason: "write_unknown" };
  }
  const refusal = translateImageDescriptionRefusal(error);
  const reason = {
    "media.image_description_conflict": "revision_moved",
    "media.image_description_exists": "already_described",
    "media.image_description_invalid": "invalid_description",
  }[refusal.code];
  return { action: "skip", reason: reason ?? "write_failed" };
}

/** Brings a kept record up to what a successful write returned, so the precheck no longer reports it. */
function recordWritten(record, written) {
  record.descriptionRevision = written.descriptionRevision;
  if (typeof written.defaultDescription === "string" && written.defaultDescription !== "") {
    record.defaultDescription = written.defaultDescription;
  } else {
    delete record.defaultDescription;
  }
}

/**
 * Writes the planned descriptions one at a time, in ascending image id order, each with the revision the read
 * returned and `onlyIfMissing`, so nothing is ever overwritten and a conflict is reported, not retried. A success
 * updates the kept record in place. A cancelled run, an outdated CLI, a paused platform or a rejected credential
 * stops the run and throws with `describeOutcome` (what was set, and which writes may have committed) attached;
 * throttling and a denied write stop further writes and mark the rest skipped; an unknown outcome leaves the record
 * as it was and goes on. Returns the images set and the ones skipped, in order.
 */
export async function describeMissingImages({ client, siteId, state, plan }) {
  const set = [];
  const skipped = [];
  const unknown = [];
  let stoppedFor;
  for (const item of plan) {
    if (item.description === undefined) {
      skipped.push({ imageId: item.imageId, reason: item.reason });
      continue;
    }
    if (stoppedFor !== undefined) {
      skipped.push({ imageId: item.imageId, reason: stoppedFor });
      continue;
    }
    try {
      const written = await updateSiteImageDescription(client, siteId, item.imageId, {
        defaultDescription: item.description,
        expectedRevision: item.expectedRevision,
        onlyIfMissing: true,
      });
      recordWritten(state.records.get(item.imageId), written);
      set.push({ imageId: item.imageId, description: item.description });
    } catch (error) {
      const outcome = classifyDescriptionFailure(error);
      if (outcome.action === "fail") {
        error.describeOutcome = {
          set: set.map((entry) => entry.imageId),
          unknown: [...unknown],
          failing: error instanceof SiteAuthoringError && outcomeUnknown(error) ? item.imageId : undefined,
        };
        throw error;
      }
      if (outcome.action === "stop") stoppedFor = outcome.reason;
      if (outcome.action === "unknown") unknown.push(item.imageId);
      skipped.push({ imageId: item.imageId, reason: outcome.reason });
    }
  }
  return { set, skipped };
}

/** The report a flagged push adds as `describedImages`, bounded; `reason` is the read's, when it did not complete. */
export function describedImagesBlock({ set, skipped }, state) {
  return {
    set: listOf(set, DESCRIBED_IMAGES_BUDGETS.set),
    skipped: listOf(skipped, DESCRIBED_IMAGES_BUDGETS.skipped),
    ...(state.reason === undefined ? {} : { reason: state.reason }),
  };
}

/**
 * The operations that committed before an image write failed the command, in the order the 100-entry cap should keep
 * them: the failing image when its outcome is unknown, three count lines, each image set, each earlier unknown
 * image, then each saved page (`savedPages` are labels such as `page about: created`).
 */
export function completedWritesForDescribe({ outcome, savedPages }) {
  const unknown = [...(outcome.failing === undefined ? [] : [outcome.failing]), ...outcome.unknown];
  return [
    ...(outcome.failing === undefined ? [] : [`image ${outcome.failing}: unknown`]),
    `${outcome.set.length} image(s): set`,
    `${unknown.length} image(s): unknown`,
    `${savedPages.length} page(s): saved`,
    ...outcome.set.map((imageId) => `image ${imageId}: set`),
    ...outcome.unknown.map((imageId) => `image ${imageId}: unknown`),
    ...savedPages,
  ];
}
