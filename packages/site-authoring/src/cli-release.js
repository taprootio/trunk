import {
  CLI_UPGRADE_COMMAND,
  CLI_UPGRADE_REFUSAL_FIELD,
  CLI_VERSION,
  REFUSAL_CLI_OUTDATED,
} from "./constants.js";
import { SiteAuthoringError } from "./errors.js";

/**
 * Whether this CLI is still the release Taproot accepts (TR00703).
 *
 * **The server is the authority, and this is its mirror.** Taproot refuses a
 * CLI that is behind the latest published release at sign-in and at token
 * exchange, so every online verb already gets a definitive answer without any
 * of this. What this file is for is the case where there is no request to be
 * refused: `help`, `validate`, and `whoami` run entirely offline, and an agent
 * that keeps authoring against a contract that has moved will happily spend a
 * whole session validating documents the site can no longer accept.
 *
 * So the exchange returns the latest version, the CLI records it beside the
 * sign-in, and the offline verbs refuse against that recording. A recording is
 * weaker evidence than a refusal, and the rules here follow from that: nothing
 * recorded means proceed (a clean machine can still validate a fixture), an
 * unreadable or malformed recording means proceed, and only a value this side
 * can actually parse and compare is allowed to stop anything.
 */

// Exactly the shape `release/trunk/public-repo/scripts/npm-release-guard.mjs`
// admits to npm, and exactly the shape the API's `SiteAuthoringCliRelease`
// parses: three numeric components with no leading zeroes, plus optional
// dot-separated prerelease identifiers. Build metadata is deliberately absent —
// no version this project publishes carries any.
const SEMANTIC_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

// A version string is a handful of characters. Anything longer is not one, and
// bounding it before the regex keeps a hostile response from spending time here.
const MAXIMUM_VERSION_LENGTH = 64;

const NUMERIC_IDENTIFIER = /^\d+$/u;

/**
 * Parses a version into what precedence needs, or returns `undefined`. A
 * leading zero on a numeric prerelease identifier is invalid, exactly as the
 * release guard treats it.
 */
export function parseCliVersion(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAXIMUM_VERSION_LENGTH) {
    return undefined;
  }
  const match = SEMANTIC_VERSION.exec(value);
  if (!match) return undefined;
  const prerelease = match[4] === undefined ? [] : match[4].split(".");
  if (prerelease.some((part) => NUMERIC_IDENTIFIER.test(part) && part.length > 1 && part.startsWith("0"))) {
    return undefined;
  }
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease };
}

function comparePrereleaseIdentifier(left, right) {
  if (left === right) return 0;
  const leftNumeric = NUMERIC_IDENTIFIER.test(left);
  const rightNumeric = NUMERIC_IDENTIFIER.test(right);
  if (leftNumeric && rightNumeric) {
    // Digit-only with no leading zero, so length then lexicographic order is
    // numeric order at any magnitude — the same rule the API applies, where a
    // fixed-width parse would lose precision or overflow.
    if (left.length !== right.length) return left.length < right.length ? -1 : 1;
    return left < right ? -1 : 1;
  }
  // A numeric identifier always has lower precedence than an alphanumeric one.
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : 1;
}

/**
 * Semantic-version precedence, or `undefined` when either side is unparseable.
 * Not string order: `0.10.0` is above `0.9.0`, and a prerelease is below the
 * release it leads to, so `0.4.0-rc.1` is behind `0.4.0`.
 */
export function compareCliVersions(leftVersion, rightVersion) {
  const left = parseCliVersion(leftVersion);
  const right = parseCliVersion(rightVersion);
  if (left === undefined || right === undefined) return undefined;
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const shared = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < shared; index += 1) {
    const comparison = comparePrereleaseIdentifier(left.prerelease[index], right.prerelease[index]);
    if (comparison !== 0) return comparison;
  }
  if (left.prerelease.length === right.prerelease.length) return 0;
  return left.prerelease.length < right.prerelease.length ? -1 : 1;
}

/**
 * A latest-version value from the wire, kept only if this side can compare it.
 *
 * Read strictly and dropped silently on anything else. The value drives an
 * advisory local gate, so a server that predates the field, or one that sends
 * something this parser does not understand, must leave the CLI working rather
 * than refusing offline work it cannot justify.
 */
export function normalizeLatestCliVersion(value) {
  return parseCliVersion(value) === undefined ? undefined : value;
}

/**
 * Whether {@link CLI_VERSION} is strictly behind a recorded latest. Anything
 * unparseable on either side is not behind: an answer this side cannot compute
 * is not evidence.
 */
export function isBehindLatest(latestVersion, currentVersion = CLI_VERSION) {
  const comparison = compareCliVersions(currentVersion, latestVersion);
  return comparison !== undefined && comparison < 0;
}

/**
 * The offline refusal.
 *
 * It classifies as `cli_outdated` and carries the server's own field name
 * rather than CLI-local labels, because an agent branching on `refusal` or
 * `field` should not have to know whether the answer came from Taproot or from
 * the recording of Taproot's last answer — the remedy is identical. The `code`
 * is what says it was raised here: `cli.outdated` rather than
 * `api.request_rejected`.
 */
class CliOutdatedError extends SiteAuthoringError {
  refusalKind() {
    return REFUSAL_CLI_OUTDATED;
  }
}

/**
 * The offline refusal, worded to match what the server says on the wire so an
 * operator meeting it either way reads the same instruction.
 */
export function cliOutdatedError(latestVersion) {
  return new CliOutdatedError(
    "cli.outdated",
    `This CLI is version ${CLI_VERSION}, and the last Taproot sign-in exchange reported ${latestVersion} as the `
      + "latest published release. Taproot accepts only the latest, so every online verb is refused until this "
      + `package is upgraded. Upgrade with: ${CLI_UPGRADE_COMMAND}. If ${latestVersion} was published in the last `
      + "few minutes, npm may not serve it yet — wait a moment and retry the upgrade.",
    { field: CLI_UPGRADE_REFUSAL_FIELD },
  );
}
