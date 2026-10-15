import {
  changelogEntriesSince,
  changelogEntryFor,
  earliestRecordedVersion,
} from "../changelog.js";
import { compareCliVersions } from "../cli-release.js";
import { CLI_UPGRADE_COMMAND, CLI_VERSION, VERB_CHANGELOG } from "../constants.js";
import { successResult } from "../session.js";

/**
 * `changelog [--since <version>]` — what changed in each release, offline.
 *
 * Only the latest CLI is accepted, so an upgrade is forced often and the agent
 * that meets it needs to know what moved without diffing every help topic
 * (TR01225). With no version it prints the installed release's entry; with
 * `--since` it prints every release after that one, up to the installed one. It
 * reads the package's own record, needs no sign-in or site, and is outside the
 * outdated-CLI gate on purpose: it is how the upgraded CLI explains itself.
 */
export async function changelog(invocation) {
  const onProgress = invocation.onProgress ?? (() => {});
  const since = invocation.since;
  const installed = changelogEntryFor(CLI_VERSION);
  const entries = since === undefined
    ? installed === undefined ? [] : [installed]
    : changelogEntriesSince(since);
  const earliest = earliestRecordedVersion();
  const startsBeforeRecord = since !== undefined && earliest !== undefined && compareCliVersions(since, earliest) < 0;

  const notes = [];
  if (since !== undefined && compareCliVersions(since, CLI_VERSION) >= 0) {
    notes.push(
      `This CLI is ${CLI_VERSION}, which is not newer than ${since}. Upgrade with: ${CLI_UPGRADE_COMMAND}, then run this again.`,
    );
  } else if (entries.length === 0) {
    notes.push(`No changelog entry is recorded for ${CLI_VERSION}.`);
  }
  if (startsBeforeRecord) {
    notes.push(`The record starts at ${earliest}; changes before it are not listed.`);
  }

  for (const entry of entries) {
    onProgress(`${entry.version}${entry.date === undefined ? "" : ` (${entry.date})`}: ${entry.note}`);
    for (const line of entry.behavior) onProgress(`  - ${line}`);
    if (entry.help.length > 0) onProgress(`  Help changed: ${entry.help.map((topic) => `help ${topic}`).join(", ")}`);
  }
  for (const note of notes) onProgress(note);

  return successResult(VERB_CHANGELOG, undefined, {
    installedVersion: CLI_VERSION,
    ...(since === undefined ? {} : { since }),
    entries: entries.map((entry) => ({
      version: entry.version,
      ...(entry.date === undefined ? {} : { date: entry.date }),
      note: entry.note,
      behavior: [...entry.behavior],
      help: [...entry.help],
    })),
    complete: !startsBeforeRecord,
    ...(notes.length === 0 ? {} : { notes }),
  });
}
