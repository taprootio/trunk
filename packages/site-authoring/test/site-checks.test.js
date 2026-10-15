import assert from "node:assert/strict";
import test from "node:test";

import corpus from "./fixtures/site-check-corpus.json" with { type: "json" };
import { checkRedirectSource, extractPageLinks, missingPageLinkFindings, normalizedPathSet } from "../src/site-checks.js";
import {
  describeSiteFinding,
  evaluateOfflineSiteChecks,
  SITE_CHECK_RULES,
} from "../src/site-check-findings.js";
import rules from "../src/site-check-rules.json" with { type: "json" };

// The same cases the API's C# evaluator passes (shared/site-check-corpus.json), so the two
// implementations cannot drift on link extraction or redirect source rules.

for (const testCase of corpus.links) {
  test(`link extraction: ${testCase.name}`, () => {
    assert.deepEqual(extractPageLinks(testCase.templateData, testCase.currentPath), testCase.expected);
  });
}

for (const testCase of corpus.redirectSources) {
  test(`redirect source ${JSON.stringify(testCase.submitted)} is ${testCase.rule ?? "accepted"}`, () => {
    const check = checkRedirectSource(testCase.submitted);
    assert.equal(check.path ?? null, testCase.normalized);
    assert.equal(check.finding?.ruleId ?? null, testCase.rule);
  });
}

for (const testCase of corpus.pageLinks) {
  test(`page links: ${testCase.name}`, () => {
    const findings = missingPageLinkFindings(testCase.templateData, testCase.currentPath, normalizedPathSet(testCase.sitePagePaths));
    assert.deepEqual(findings.map((finding) => finding.subject), testCase.expected);
    assert.ok(findings.every((finding) => finding.ruleId === "link.page_missing" && finding.severity === "warning"));
  });
}

test("every catalogued rule has this surface's own words, and an unknown rule never shows only its id", () => {
  for (const rule of rules.rules) {
    const sentence = describeSiteFinding({ ruleId: rule.id, subject: "/x", detail: "Name" });
    assert.ok(!sentence.includes("site check '"), `${rule.id} has no CLI wording`);
  }
  assert.match(describeSiteFinding({ ruleId: "seo.future_rule", subject: "", detail: "" }), /flagged by the site check/u);
});

test("validate offers the catalogue's offline rules, and names the rest as checked by the site", () => {
  const { siteChecks } = evaluateOfflineSiteChecks({ planned: [], pagePaths: [] });
  assert.deepEqual(
    siteChecks.ranOffline,
    SITE_CHECK_RULES.filter((rule) => rule.runsAt.includes("validate")).map((rule) => rule.id),
  );
  assert.deepEqual(
    [...siteChecks.ranOffline, ...siteChecks.checkedBySite, ...siteChecks.checkedAtDeploy].sort(),
    SITE_CHECK_RULES.map((rule) => rule.id).sort(),
  );
});

test("a truncated page manifest skips the link check rather than calling a link broken", () => {
  const planned = [{ file: "pages/a.md", pagePath: "a", document: { href: "/elsewhere" } }];
  const complete = evaluateOfflineSiteChecks({ planned, pagePaths: ["a"], pagesComplete: true });
  const truncated = evaluateOfflineSiteChecks({ planned, pagePaths: ["a"], pagesComplete: false });
  assert.equal(complete.findings.total, 1);
  assert.equal(truncated.findings.total, 0);
  assert.deepEqual(truncated.siteChecks.skipped, ["link.page_missing"]);
});
