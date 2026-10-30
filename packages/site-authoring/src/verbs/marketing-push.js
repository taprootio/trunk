import { randomUUID } from "node:crypto";

import { withRefusalGuidance } from "../api.js";
import { VERB_MARKETING_PULL, VERB_MARKETING_PUSH } from "../constants.js";
import { SiteAuthoringError } from "../errors.js";
import {
  createMarketingRecord,
  listMarketingRecords,
  setMarketingRecordArchived,
  updateMarketingRecord,
  withSiteWording,
} from "../marketing-api.js";
import { MARKETING_KINDS, projectMarketingDocument } from "../marketing-contract.js";
import {
  baselineEntry,
  readWorkspaceMarketing,
  recordedMarketing,
  sameLabels,
  withRecordedMarketing,
} from "../marketing-workspace.js";
import { openSession, successResult, warnIfExternalWritesPaused } from "../session.js";
import { readManifest, writeManifest, writeWorkspaceJson } from "../workspace.js";

const MAXIMUM_REPORTED = 50;

function pullRequired(kind, key, reason) {
  const { file } = MARKETING_KINDS[kind];
  return new SiteAuthoringError(
    "marketing.pull_required",
    `${file}: ${reason} Run '${VERB_MARKETING_PULL}', reconcile '${key}', and retry. Nothing was written.`,
    { field: `${file}:${key}` },
  );
}

/**
 * Whether a recorded baseline already says what the site's record says, including its state: a release that
 * finished since the last write moves a key from publishing to live, and the file is rewritten with that, so the
 * baseline `link build` reads must follow it.
 */
function currentBaseline(recorded, remote, kind) {
  return recorded !== undefined && recorded.id === remote.id && recorded.archived === remote.archived
    && recorded.state === remote.state && sameLabels(kind, recorded, remote);
}

function changedOnTheSite(kind, key) {
  const { file, noun } = MARKETING_KINDS[kind];
  return new SiteAuthoringError(
    "marketing.concurrent_modification",
    `${file}: the ${noun} '${key}' changed on the site after this workspace read it. Run '${VERB_MARKETING_PULL}', `
      + "reconcile the file, and retry. Nothing was written.",
    { field: `${file}:${key}` },
  );
}

/**
 * Decides what one kind needs, from the file, the site's records and the baseline the last pull recorded.
 * Throws before anything is written.
 *
 * A key is public URL text and never changes or returns to use, so a changed key in the file is a new record
 * (a create) and the old one is only archived when the push says so. A record the file leaves out is archived
 * only under --archive, and only when this workspace pulled it: a record the workspace never saw is reported,
 * never touched.
 */
function planKind(kind, fileRecords, remoteRecords, baseline, archive) {
  const remoteByKey = new Map(remoteRecords.map((record) => [record.key, record]));
  const actions = [];
  const named = new Set();
  for (const desired of fileRecords) {
    named.add(desired.key);
    const remote = remoteByKey.get(desired.key);
    const recorded = baseline.get(desired.key);
    if (remote === undefined) {
      if (recorded !== undefined) {
        throw pullRequired(kind, desired.key, "This workspace recorded it, but the site no longer has it.");
      }
      actions.push({ type: "create", key: desired.key, desired });
      continue;
    }
    // A write whose answer was lost leaves the site holding what the file asks for while the baseline is stale
    // (or missing, for a create). Nothing needs writing then, so the site's record is adopted as the baseline
    // rather than sending the author to a pull that would discard the file's other edits.
    if (!remote.archived && sameLabels(kind, desired, remote)) {
      actions.push({ type: "unchanged", key: desired.key, desired, remote, adopt: true });
      continue;
    }
    if (recorded === undefined) {
      throw pullRequired(kind, desired.key, "The site already has one with this key that this workspace never pulled.");
    }
    // An archived record whose labels already equal the file's had its update land before a restore whose answer
    // was lost; the restore is all that is left, so the drift from the baseline is this push's own.
    const ownUpdate = remote.archived && sameLabels(kind, desired, remote);
    if (recorded.id !== remote.id || recorded.archived !== remote.archived || (!ownUpdate && !sameLabels(kind, recorded, remote))) {
      throw changedOnTheSite(kind, desired.key);
    }
    const labelsChanged = !sameLabels(kind, desired, remote);
    if (remote.archived) {
      actions.push({ type: "restore", key: desired.key, desired, remote, labelsChanged });
    } else {
      actions.push({ type: labelsChanged ? "update" : "unchanged", key: desired.key, desired, remote });
    }
  }

  const unlisted = [];
  const unpulled = [];
  for (const remote of remoteRecords) {
    if (named.has(remote.key) || remote.archived) continue;
    const recorded = baseline.get(remote.key);
    if (recorded === undefined) {
      unpulled.push(remote.key);
      continue;
    }
    if (!archive) {
      unlisted.push(remote.key);
      continue;
    }
    if (recorded.id !== remote.id || recorded.archived !== remote.archived || !sameLabels(kind, recorded, remote)) {
      throw changedOnTheSite(kind, remote.key);
    }
    actions.push({ type: "archive", key: remote.key, remote });
  }
  return { actions, unlisted: unlisted.sort(), unpulled: unpulled.sort() };
}

/**
 * `marketing push` — make the site's campaigns and placements match the workspace's files.
 *
 * Every file is validated and every record compared with the site before the first write, so a conflict on the
 * third record refuses the whole push rather than landing two. Archives run first, so a push that swaps a key
 * for a new one stays inside the site's quota. Each write advances the baseline straight away, so a failure
 * partway leaves a workspace the next push can resume from. Creating or restoring a key queues the silent
 * release that starts counting it; this verb waits for nothing.
 *
 * There is no plan/apply step. Like the forms push it models, it reads the site, refuses a stale baseline, and
 * writes; there is no remote state to freeze that the baseline does not already fence.
 */
export async function marketingPush(invocation) {
  const session = await openSession(invocation);
  const { client, config, siteId, onProgress } = session;
  warnIfExternalWritesPaused(session, VERB_MARKETING_PUSH);
  const archive = invocation.archive === true;

  const files = await readWorkspaceMarketing(config.workspaceDir);
  if (files.size === 0) {
    throw new SiteAuthoringError(
      "marketing.file_missing",
      "The workspace has no marketing/campaigns.json or marketing/placements.json. "
        + `Run '${VERB_MARKETING_PULL}' to write them.`,
      { field: "marketing" },
    );
  }
  onProgress(`Validated ${[...files.keys()].map((kind) => MARKETING_KINDS[kind].file).join(" and ")}.`);
  let manifest = await readManifest(config.workspaceDir, siteId);

  const plans = new Map();
  for (const [kind, records] of files) {
    const listing = await withRefusalGuidance(
      onProgress,
      "marketing push",
      async () => await listMarketingRecords(client, siteId, kind),
    );
    plans.set(kind, { ...planKind(kind, records, listing.records, recordedMarketing(manifest, kind), archive), remote: listing.records });
  }

  const results = {};
  let changedCount = 0;
  const completedWrites = [];
  for (const [kind, plan] of plans) {
    const { noun } = MARKETING_KINDS[kind];
    const baseline = recordedMarketing(manifest, kind);
    // What the site holds for each key after the writes, so the file and the baseline are written from it.
    const view = new Map(plan.remote.map((record) => [record.key, record]));
    const applied = { created: [], updated: [], restored: [], archived: [], unchanged: [] };

    const write = async (action, verb, work) => {
      let label;
      try {
        label = await withRefusalGuidance(onProgress, "marketing push", work);
      } catch (caught) {
        const error = withSiteWording(caught, kind, action.key);
        if (error instanceof SiteAuthoringError && completedWrites.length > 0) {
          throw error.withCompletedWrites(completedWrites);
        }
        throw error;
      }
      completedWrites.push(`${kind}:${action.key}:${verb}`);
      view.set(action.key, label);
      baseline.set(action.key, baselineEntry(kind, label));
      manifest = withRecordedMarketing(manifest, kind, baseline);
      await writeManifest(config.workspaceDir, manifest);
      onProgress(`${action.key}: ${verb} the ${noun}.`);
    };

    for (const action of plan.actions.filter((candidate) => candidate.adopt && !currentBaseline(baseline.get(candidate.key), candidate.remote, kind))) {
      baseline.set(action.key, baselineEntry(kind, action.remote));
      manifest = withRecordedMarketing(manifest, kind, baseline);
      await writeManifest(config.workspaceDir, manifest);
    }

    // Archives first, so swapping a key for a new one stays inside the quota; creates last.
    for (const action of plan.actions.filter((candidate) => candidate.type === "archive")) {
      await write(action, "archived", () => setMarketingRecordArchived(client, siteId, kind, action.remote.id, true));
      applied.archived.push(action.key);
    }
    for (const action of plan.actions.filter((candidate) => candidate.type === "update" || candidate.labelsChanged)) {
      await write(action, "updated", () => updateMarketingRecord(client, siteId, kind, action.remote.id, action.desired));
      // A restore that also changes labels is reported as a restore.
      if (action.type === "update") applied.updated.push(action.key);
    }
    for (const action of plan.actions.filter((candidate) => candidate.type === "restore")) {
      await write(action, "restored", () => setMarketingRecordArchived(client, siteId, kind, action.remote.id, false));
      applied.restored.push(action.key);
    }
    for (const action of plan.actions.filter((candidate) => candidate.type === "create")) {
      await write(action, "created", () => createMarketingRecord(client, siteId, kind, randomUUID(), action.desired));
      applied.created.push(action.key);
    }
    applied.unchanged = plan.actions.filter((action) => action.type === "unchanged").map((action) => action.key);

    // The file is rewritten from what the site now holds, in canonical form, so the workspace and the site
    // agree byte for byte and the read-only state and counted_from are current.
    const kept = plan.actions.filter((action) => action.type !== "archive").map((action) => view.get(action.key));
    await writeWorkspaceJson(config.workspaceDir, MARKETING_KINDS[kind].file, projectMarketingDocument(kind, kept));
    // Every list is bounded so a site with thousands of records still fits the result; `counts` says how many.
    const lists = { ...applied, unlisted: plan.unlisted, unpulled: plan.unpulled };
    const capped = Object.entries(lists).filter(([, keys]) => keys.length > MAXIMUM_REPORTED).map(([name]) => name);
    results[kind] = {
      ...Object.fromEntries(Object.entries(lists).map(([name, keys]) => [name, keys.slice(0, MAXIMUM_REPORTED)])),
      counts: Object.fromEntries(Object.entries(lists).map(([name, keys]) => [name, keys.length])),
      ...(capped.length > 0 ? { truncated: capped } : {}),
    };
    changedCount += applied.created.length + applied.updated.length + applied.restored.length + applied.archived.length;
  }

  const changed = Object.entries(results).flatMap(([kind, value]) =>
    ["created", "updated", "restored", "archived"].flatMap((name) => value[name].map((key) => `${kind}:${key}`))
  );
  for (const [kind, value] of Object.entries(results)) {
    if (value.counts.unlisted > 0) {
      onProgress(
        `${MARKETING_KINDS[kind].file}: left ${value.unlisted.slice(0, 20).join(", ")}`
          + `${value.counts.unlisted > 20 ? ` and ${value.counts.unlisted - 20} more` : ""} on the site because the file `
          + "omits it. Push with --archive to archive a record the file leaves out.",
      );
    }
  }
  return successResult(VERB_MARKETING_PUSH, siteId, {
    marketing: results,
    written: { items: changed, count: changedCount, ...(changed.length < changedCount ? { itemsTruncated: true } : {}) },
  });
}
