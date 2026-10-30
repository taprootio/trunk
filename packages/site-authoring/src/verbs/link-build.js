import { listAuthorableSites, withRefusalGuidance } from "../api.js";
import { CLI_BINARY_NAME, VERB_LINK_BUILD, VERB_LOGIN } from "../constants.js";
import { sanitizeDiagnostic, SiteAuthoringError } from "../errors.js";
import { listMarketingRecords } from "../marketing-api.js";
import {
  isMarketingKey,
  LINK_SOURCES,
  MARKETING_KINDS,
  MARKETING_STATES,
  MARKETING_STATE_ARCHIVED,
  MARKETING_KEY_RULE,
  notLiveNote,
} from "../marketing-contract.js";
import { readWorkspaceMarketing, recordedMarketing } from "../marketing-workspace.js";
import {
  openAccountSession,
  openAnonymousSession,
  openSession,
  requireRecordedSurface,
  successResult,
} from "../session.js";
import { readManifest } from "../workspace.js";
import { ENGAGEMENT_HOST_PATTERN, normalizeSitePath, trackedAddress } from "../utm-link.js";

function invalidOption(code, message, field) {
  return new SiteAuthoringError(code, message, { field, exitCode: 2 });
}

/** The site's public host: the one given, or the signed-in account's record of the configured site. */
async function resolveHost(invocation, config) {
  if (invocation.linkDomain !== undefined) {
    const host = invocation.linkDomain.trim().toLowerCase();
    if (!ENGAGEMENT_HOST_PATTERN.test(host)) {
      throw invalidOption("link.domain_invalid", "--domain is the site's public host name, such as example.com, without a scheme or path.", "domain");
    }
    return host;
  }
  let sites;
  try {
    const account = await openAccountSession(invocation);
    sites = await withRefusalGuidance(account.onProgress, "site list", async () => await listAuthorableSites(account.client));
  } catch (error) {
    if (error instanceof SiteAuthoringError && error.code === "auth.key_missing") {
      throw new SiteAuthoringError(
        "link.domain_unknown",
        `A link needs the site's public host, which comes from the signed-in site. Run '${CLI_BINARY_NAME} ${VERB_LOGIN}', `
          + "or pass --domain <host>: a site credential cannot read hosting configuration.",
        { field: "domain" },
      );
    }
    throw error;
  }
  const host = sites.find((site) => site.siteId === config.siteId)?.primaryDomain ?? "";
  if (host === "") {
    throw new SiteAuthoringError(
      "link.no_public_address",
      "This site does not have a public address yet, so there is nothing to build a link to. "
        + "Set it in Settings, Licence & domain, or pass --domain <host>.",
      { field: "domain" },
    );
  }
  return host.toLowerCase();
}

/**
 * The campaign or placement a link names. The state comes from the baseline the last pull or push recorded in the
 * manifest when the workspace holds this kind's file and a known, unarchived state was recorded for the key; in every
 * other case the live site is asked. (A file's own `state` is only what the author left there, so it is never used.)
 * A key the site does not hold is not counted, so it is refused rather than printed; an archived key is no longer
 * admitted, so it is refused the same way.
 */
async function findRecord(kind, key, files, invocation, config) {
  const { noun, file } = MARKETING_KINDS[kind];
  const fromFile = files.get(kind);
  if (fromFile !== undefined) {
    const record = fromFile.find((candidate) => candidate.key === key);
    if (record === undefined) {
      throw new SiteAuthoringError(
        `link.${noun}_unknown`,
        `${file} has no ${noun} '${key}'. Run 'marketing pull' if it was made since, or add it to the file and `
          + "run 'marketing push': a key the site does not hold is not counted.",
        { field: noun },
      );
    }
    // The state a pull or push recorded for this key is the one to report. A key with no baseline entry (made or
    // restored in the app and then added to the file), an archived entry, or an entry with no known state is not
    // known to be live, so the site is asked, and it refuses a key it does not hold.
    const manifest = await readManifest(config.workspaceDir, config.siteId, { required: false });
    const recorded = manifest === undefined ? undefined : recordedMarketing(manifest, kind).get(key);
    if (
      recorded !== undefined && !recorded.archived && MARKETING_STATES.includes(recorded.state)
      && recorded.state !== MARKETING_STATE_ARCHIVED
    ) {
      return { name: record.name, state: recorded.state, fromFile: file };
    }
  }
  const session = await openSession(invocation);
  const listing = await withRefusalGuidance(
    session.onProgress,
    "link build",
    async () => await listMarketingRecords(session.client, session.siteId, kind),
  );
  const record = listing.records.find((candidate) => candidate.key === key);
  if (record === undefined || record.state === MARKETING_STATE_ARCHIVED) {
    throw new SiteAuthoringError(
      `link.${noun}_unknown`,
      `The site has no ${record === undefined ? "" : "unarchived "}${noun} '${key}'. A key the site does not hold is `
        + "not counted. Create it with 'marketing push' (or restore it by naming it in the file).",
      { field: noun },
    );
  }
  return { name: record.name, state: record.state };
}

/**
 * `link build` — print one tracked address and save nothing.
 *
 * It runs the Marketing link builder's own rules (compiled into `utm-link.js`) and its source vocabulary, so an
 * address built here counts exactly as one built in the app. A campaign or placement that is not live yet is
 * allowed, with the builder's note that page views count under the source only until it is.
 */
export async function linkBuild(invocation) {
  const { linkPath, linkSource, linkCampaign, linkPlacement } = invocation;
  if (linkPath === undefined) {
    throw invalidOption("link.path_missing", "link build needs --path, the page on this site; use / for the home page.", "path");
  }
  if (linkSource === undefined) {
    throw invalidOption("link.source_missing", `link build needs --source, one of: ${LINK_SOURCES.map((source) => source.key).join(", ")}.`, "source");
  }
  const source = LINK_SOURCES.find((candidate) => candidate.key === linkSource);
  if (source === undefined) {
    throw new SiteAuthoringError(
      "link.source_unknown",
      linkSource === "reader"
        ? "The reader source is set by a published page's own share action and cannot be built here."
        : `'${linkSource}' is not a source. Use one of: ${LINK_SOURCES.map((candidate) => candidate.key).join(", ")}.`,
      { field: "source", exitCode: 2, alternatives: LINK_SOURCES.map((candidate) => candidate.key) },
    );
  }
  for (const [field, value] of [["campaign", linkCampaign], ["placement", linkPlacement]]) {
    if (value !== undefined && !isMarketingKey(value)) {
      throw invalidOption("link.key_invalid", `--${field} is a key of ${MARKETING_KEY_RULE}.`, field);
    }
  }

  const { config, onProgress } = await openAnonymousSession({ ...invocation, client: null });
  if (config?.siteId === undefined) {
    throw new SiteAuthoringError(
      "config.site_missing",
      `No site is selected. Run '${CLI_BINARY_NAME} use <site>' to choose one, or set siteId in taproot-site.json.`,
    );
  }
  // Offline, like every other verb: a site that cannot take it is told so before any request.
  requireRecordedSurface(invocation, config);
  const host = await resolveHost(invocation, config);
  const normalized = normalizeSitePath(linkPath, host);
  if (!normalized.ok) throw invalidOption("link.path_invalid", normalized.error, "path");

  // Only the files of the kinds named are read, so a half-edited file never stops a link that does not use it.
  const files = await readWorkspaceMarketing(
    config.workspaceDir,
    [["campaigns", linkCampaign], ["placements", linkPlacement]].filter(([, key]) => key !== undefined).map(([kind]) => kind),
  );
  const notes = [];
  const named = {};
  for (const [kind, key] of [["campaigns", linkCampaign], ["placements", linkPlacement]]) {
    if (key === undefined) continue;
    const record = await findRecord(kind, key, files, invocation, config);
    named[kind] = key;
    const note = notLiveNote(sanitizeDiagnostic(record.name, key), record.state);
    // A file's state is the one written at the last pull or push, so say so rather than present it as current.
    if (note !== "") notes.push(record.fromFile === undefined ? note : `${note} (As of the last marketing pull or push; ${record.fromFile}.)`);
  }

  const address = trackedAddress(host, normalized.path, {
    source: source.key,
    medium: source.medium,
    campaign: named.campaigns,
    placement: named.placements,
  });
  onProgress(address);
  for (const note of notes) onProgress(note);
  return successResult(VERB_LINK_BUILD, config.siteId, {
    link: {
      address,
      host,
      path: normalized.path,
      source: source.key,
      medium: source.medium,
      ...(named.campaigns === undefined ? {} : { campaign: named.campaigns }),
      ...(named.placements === undefined ? {} : { placement: named.placements }),
    },
    ...(notes.length === 0 ? {} : { notes }),
  });
}
