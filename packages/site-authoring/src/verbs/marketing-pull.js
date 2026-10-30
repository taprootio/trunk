import { withRefusalGuidance } from "../api.js";
import { VERB_MARKETING_PULL } from "../constants.js";
import { listMarketingRecords } from "../marketing-api.js";
import {
  MARKETING_KIND_NAMES,
  MARKETING_KINDS,
  projectMarketingDocument,
} from "../marketing-contract.js";
import { baselineEntry, withRecordedMarketing } from "../marketing-workspace.js";
import { boundedList, openSession, successResult } from "../session.js";
import { readManifest, writeManifest, writeWorkspaceJson } from "../workspace.js";

const MAXIMUM_REPORTED = 200;

/** The archived keys, bounded like the live ones so a site with thousands of them still fits the result. */
function archivedSummary(keys) {
  const reported = boundedList(keys, MAXIMUM_REPORTED);
  return {
    archived: reported.items,
    archivedTotal: keys.length,
    ...(reported.truncated ? { archivedTruncated: true } : {}),
  };
}

/**
 * `marketing pull` — write the site's live campaigns and placements and record what was read.
 *
 * It replaces each file with the site's state, so a local edit that was never pushed is replaced; that is what
 * pull means everywhere else in this CLI. Archived records are listed and not written: a record the site has
 * archived keeps its key for ever, and a file that names the key asks for it to be restored. The baseline it
 * records is what `marketing push` fences against.
 */
export async function marketingPull(invocation) {
  const { client, config, siteId, onProgress } = await openSession(invocation);
  // The manifest is the pulled workspace this baseline belongs to, the same precondition every push has.
  let manifest = await readManifest(config.workspaceDir, siteId);

  // Both kinds are read before either file is written, so a refusal on the second never leaves a first file
  // without its baseline.
  const listings = new Map();
  for (const kind of MARKETING_KIND_NAMES) {
    listings.set(
      kind,
      await withRefusalGuidance(
        onProgress,
        "marketing pull",
        async () => await listMarketingRecords(client, siteId, kind),
      ),
    );
  }

  const summary = {};
  for (const [kind, listing] of listings) {
    const { file, noun } = MARKETING_KINDS[kind];
    const live = listing.records.filter((record) => !record.archived);
    const archived = listing.records.filter((record) => record.archived).map((record) => record.key).sort();
    await writeWorkspaceJson(config.workspaceDir, file, projectMarketingDocument(kind, live));
    manifest = withRecordedMarketing(
      manifest,
      kind,
      listing.records.map((record) => [record.key, baselineEntry(kind, record)]),
    );
    const reported = boundedList(
      live.map((record) => ({ key: record.key, state: record.state })).sort((left, right) => left.key < right.key ? -1 : 1),
      MAXIMUM_REPORTED,
    );
    summary[kind] = {
      file,
      total: live.length,
      items: reported.items,
      ...(reported.truncated ? { itemsTruncated: true } : {}),
      ...(archived.length > 0 ? archivedSummary(archived) : {}),
      canManage: listing.canManage,
      ...(listing.maxActive === undefined ? {} : { maxActive: listing.maxActive }),
    };
    onProgress(`Wrote ${file} with ${live.length} ${noun}${live.length === 1 ? "" : "s"}.`);
  }
  await writeManifest(config.workspaceDir, manifest);
  return successResult(VERB_MARKETING_PULL, siteId, { marketing: summary });
}
