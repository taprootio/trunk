import assert from "node:assert/strict";
import test from "node:test";
import { describeNavigationReadiness, isNavigationReady, normalizeNavigationReadiness, reportNavigationReadiness } from "../src/navigation-readiness.js";

test("a missing or unrecognized navigation check cannot authorize a deployment", () => {
  for (const value of [undefined, {}, { state: "READY" }, { state: 1, blockers: null }]) {
    const readiness = normalizeNavigationReadiness(value);
    assert.equal(isNavigationReady(readiness), false);
    assert.match(describeNavigationReadiness(readiness), /could not be checked/u);
  }
});

test("restricted blocked navigation has no invented details or count", () => {
  const readiness = normalizeNavigationReadiness({ state: "NAVIGATION_PUBLISHING_READINESS_STATE_BLOCKED" });
  assert.equal(describeNavigationReadiness(readiness), "Navigation cannot be published with this set.");
  assert.deepEqual(reportNavigationReadiness(readiness), { state: readiness.state, blockers: [] });
});

test("large navigation output is bounded without losing its blocked state", () => {
  const readiness = normalizeNavigationReadiness({
    state: "NAVIGATION_PUBLISHING_READINESS_STATE_BLOCKED",
    blockers: Array.from({ length: 21 }, (_, index) => ({ title: `Page ${index}`, path: `page-${index}` })),
  });
  const report = reportNavigationReadiness(readiness);
  assert.equal(isNavigationReady(readiness), false);
  assert.equal(report.blockers.length, 20);
  assert.equal(report.blockersTruncated, true);
  assert.doesNotMatch(describeNavigationReadiness(readiness), /Page 20/u);
});

test("unavailable targets do not masquerade as home, while resolved home keeps its path", () => {
  const blocked = (blocker) => normalizeNavigationReadiness({
    state: "NAVIGATION_PUBLISHING_READINESS_STATE_BLOCKED", blockers: [blocker],
  });
  assert.doesNotMatch(describeNavigationReadiness(blocked({})), /\(\/\)/u);
  assert.match(describeNavigationReadiness(blocked({ pageId: "home", title: "Home", path: "" })), /Home \(\/\)/u);
});
