import changelogRecord from "./changelog.json" with { type: "json" };
import { compareCliVersions, parseCliVersion } from "./cli-release.js";
import { CLI_VERSION } from "./constants.js";

/**
 * What changed in each release (TR01225), from the one record the package ships.
 *
 * `changelog.json` is the only place a release note is written: the `changelog`
 * command and `status` both read it here, so neither carries prose of its own.
 * The outdated-CLI refusal comes from a CLI that predates the release it
 * refuses for, so it can only name the command to run after upgrading. An entry is `{ version, date?, note, behavior,
 * help }`: `note` is the one-sentence summary, `behavior` the changes a script or
 * agent can observe, and `help` the reference topics (`help <topic>`) whose text
 * changed. The newest entry comes first. The version being prepared is
 * "unreleased" until the release is stamped.
 */

export const UNRELEASED = "unreleased";

export const CHANGELOG = Object.freeze(changelogRecord.entries.map((entry) => Object.freeze(entry)));

/** The entry for one released version, or undefined. */
export function changelogEntryFor(version) {
  return CHANGELOG.find((entry) => entry.version === version);
}

/**
 * The released entries newer than `since` and no newer than `through`, newest
 * first. The unreleased entry is never part of an installed release.
 */
export function changelogEntriesSince(since, through = CLI_VERSION) {
  return CHANGELOG.filter((entry) => {
    if (entry.version === UNRELEASED || parseCliVersion(entry.version) === undefined) return false;
    return compareCliVersions(entry.version, since) > 0 && compareCliVersions(entry.version, through) <= 0;
  });
}

/** The oldest released version the record covers, so a caller can say when a range starts before it. */
export function earliestRecordedVersion() {
  const released = CHANGELOG.filter((entry) => parseCliVersion(entry.version) !== undefined);
  return released.length === 0 ? undefined : released[released.length - 1].version;
}

/** The short note `status` shows for the installed version, or undefined when none is recorded. */
export function installedWhatsNew(version = CLI_VERSION) {
  const entry = changelogEntryFor(version);
  return entry === undefined ? undefined : { version: entry.version, note: entry.note, help: [...entry.help] };
}
