import assert from "node:assert/strict";
import test from "node:test";

import {
  cliOutdatedError,
  compareCliVersions,
  isBehindLatest,
  normalizeLatestCliVersion,
  parseCliVersion,
} from "../src/cli-release.js";
import {
  CLI_NAME,
  CLI_UPGRADE_COMMAND,
  CLI_UPGRADE_REFUSAL_FIELD,
  CLI_VERSION,
  REFUSAL_CLI_OUTDATED,
} from "../src/constants.js";

/**
 * The comparison the latest-only gate rests on (TR00703).
 *
 * It is deliberately not string order, and the difference is not academic: the
 * first release after `0.9.0` sorts below it as text, so a string comparison
 * would tell every upgraded CLI it was behind and refuse it.
 */

test("orders versions by semantic precedence rather than as text", async (testContext) => {
  const cases = [
    // The case string order gets wrong.
    { left: "0.10.0", right: "0.9.0", expected: 1 },
    { left: "1.0.0", right: "0.99.99", expected: 1 },
    { left: "0.4.0", right: "0.4.0", expected: 0 },
    { left: "0.4.0", right: "0.4.1", expected: -1 },
    { left: "0.4.1", right: "0.4.0", expected: 1 },
    { left: "0.3.9", right: "0.4.0", expected: -1 },
    // A prerelease is below the release it leads to, so a release candidate of
    // the current version counts as behind.
    { left: "0.4.0-rc.1", right: "0.4.0", expected: -1 },
    { left: "0.4.0", right: "0.4.0-rc.1", expected: 1 },
    { left: "0.4.0-rc.1", right: "0.4.0-rc.2", expected: -1 },
    { left: "0.4.0-rc.2", right: "0.4.0-rc.10", expected: -1 },
    { left: "0.4.0-alpha", right: "0.4.0-beta", expected: -1 },
    { left: "0.4.0-rc", right: "0.4.0-rc.1", expected: -1 },
    { left: "0.4.0-rc.1", right: "0.4.0-rc.1", expected: 0 },
    // A prerelease of a *later* version is still ahead of the current release.
    { left: "0.5.0-rc.1", right: "0.4.0", expected: 1 },
    // Numeric identifiers compare at any magnitude, past what a double can
    // hold exactly, the same way the API compares them.
    { left: "0.4.0-rc.12345678901234567890", right: "0.4.0-rc.12345678901234567891", expected: -1 },
    { left: "0.4.0-rc.99999999999999999999", right: "0.4.0-rc.1", expected: 1 },
  ];
  for (const scenario of cases) {
    await testContext.test(`${scenario.left} vs ${scenario.right}`, () => {
      assert.equal(compareCliVersions(scenario.left, scenario.right), scenario.expected);
    });
  }
});

test("refuses to compare anything that is not a version this project could publish", async (testContext) => {
  const rejected = [
    undefined,
    null,
    42,
    "",
    "1",
    "1.2",
    "1.2.3.4",
    "v1.2.3",
    "1.2.3 ",
    " 1.2.3",
    "01.2.3",
    "1.02.3",
    "1.2.3-",
    "1.2.3-rc..1",
    "1.2.3-rc.01",
    // Build metadata is not accepted, matching the release guard that admits a
    // version to npm: a version this parser took but that guard would refuse
    // could never have been published.
    "1.2.3+build.5",
    "latest",
    `1.2.3-${"a".repeat(200)}`,
  ];
  for (const value of rejected) {
    await testContext.test(JSON.stringify(value) ?? String(value), () => {
      assert.equal(parseCliVersion(value), undefined);
      assert.equal(normalizeLatestCliVersion(value), undefined);
      // An unparseable value on either side yields no comparison at all, which
      // is what keeps it from being read as "behind" or as "current".
      assert.equal(compareCliVersions(value, "1.0.0"), undefined);
      assert.equal(compareCliVersions("1.0.0", value), undefined);
      assert.equal(isBehindLatest(value), false);
    });
  }
});

test("keeps a latest version this side can compare, and drops the rest", () => {
  assert.equal(normalizeLatestCliVersion("9.9.9"), "9.9.9");
  assert.equal(normalizeLatestCliVersion("9.9.9-rc.1"), "9.9.9-rc.1");
  assert.equal(normalizeLatestCliVersion("not a version"), undefined);
});

test("only a strictly newer latest counts as behind", () => {
  assert.equal(isBehindLatest("999.0.0"), true);
  assert.equal(isBehindLatest(CLI_VERSION), false);
  // Ahead proceeds: an API deploy that lands before its npm publish must not
  // lock out the install that publish is about to produce.
  assert.equal(isBehindLatest("0.0.1"), false);
  assert.equal(isBehindLatest(undefined), false);
});

test("the offline refusal classifies and instructs exactly as the wire refusal does", () => {
  const error = cliOutdatedError("9.9.9");

  // Same `refusal` and same `field` as the server's, because the remedy is the
  // same and an automation should not have to know which side answered.
  assert.equal(error.refusalKind(), REFUSAL_CLI_OUTDATED);
  assert.equal(error.field, CLI_UPGRADE_REFUSAL_FIELD);
  // The code is what says it was raised locally.
  assert.equal(error.code, "cli.outdated");
  assert.equal(error.exitCode, 1);
  assert.ok(error.message.includes(CLI_UPGRADE_COMMAND));
  assert.ok(error.message.includes(CLI_NAME));
  assert.ok(error.message.includes(CLI_VERSION));
  assert.ok(error.message.includes("9.9.9"));
});
