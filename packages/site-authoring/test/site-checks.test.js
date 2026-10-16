import assert from "node:assert/strict";
import test from "node:test";

import corpus from "./fixtures/site-check-corpus.json" with { type: "json" };
import { pageStructureFindings } from "../src/page-structure-checks.js";
import {
  checkRedirectSource,
  extractPageLinks,
  missingPageLinkFindings,
  normalizedPathSet,
  unknownFormKeyFindings,
} from "../src/site-checks.js";
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

for (const testCase of corpus.formKeys) {
  test(`form keys: ${testCase.name}`, () => {
    const findings = unknownFormKeyFindings(testCase.placed, new Set(testCase.known));
    assert.deepEqual(findings.map((finding) => finding.subject), testCase.expected);
    assert.ok(findings.every((finding) => finding.ruleId === "form.key_unknown" && finding.severity === "error"));
  });
}

for (const testCase of corpus.pageStructure) {
  test(`page structure: ${testCase.name}`, () => {
    const findings = pageStructureFindings(testCase.input);
    assert.deepEqual(
      findings.map(({ ruleId, subject, detail }) => ({ ruleId, subject, detail })),
      testCase.expected,
    );
    assert.ok(findings.every((finding) => finding.severity === "warning"));
  });
}

test("a free-form-only rule is never raised for a page that is not free-form", () => {
  const freeFormOnly = new Set(rules.rules.filter((rule) => rule.appliesTo?.includes("free_form")).map((rule) => rule.id));
  for (const testCase of corpus.pageStructure) {
    const findings = pageStructureFindings({ ...testCase.input, freeForm: false });
    for (const finding of findings) assert.ok(!freeFormOnly.has(finding.ruleId), `${testCase.name}: ${finding.ruleId}`);
  }
});

test("every document rule is raised by some corpus case, and each case's rules are catalogued", () => {
  const documentRules = rules.rules.filter((rule) => rule.scope === "document").map((rule) => rule.id);
  const raised = new Set(corpus.pageStructure.flatMap((testCase) => testCase.expected.map((finding) => finding.ruleId)));
  assert.deepEqual([...raised].sort(), [...documentRules].sort());
});

test("a rule filter limits which rules are raised", () => {
  const testCase = corpus.pageStructure.find((candidate) => candidate.expected.length > 1);
  const only = new Set([testCase.expected[0].ruleId]);
  assert.deepEqual(
    pageStructureFindings(testCase.input, only).map((finding) => finding.ruleId),
    [testCase.expected[0].ruleId],
  );
});

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
    [
      ...siteChecks.ranOffline,
      ...siteChecks.checkedBySite,
      ...siteChecks.checkedAtDeploy,
      ...siteChecks.checkedInEditor,
    ].sort(),
    SITE_CHECK_RULES.map((rule) => rule.id).sort(),
  );
});

test("the bounded findings keep the link warnings when a frequent rule fires on every page", () => {
  const planned = Array.from({ length: 400 }, (_, index) => ({
    file: `pages/p${index}.md`,
    pagePath: `p${index}`,
    title: "Page",
    description: "",
    document: index === 399
      ? { type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "T" }] }, { type: "paragraph", content: [{ type: "text", text: "see", marks: [{ type: "link", attrs: { href: "/gone" } }] }] }] }
      : { type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "T" }] }] },
  }));
  const lines = [];
  const { findings } = evaluateOfflineSiteChecks({ planned, pagePaths: [], onProgress: (line) => lines.push(line) });
  assert.equal(findings.total, 401);
  assert.equal(findings.truncated, true);
  assert.equal(findings.items[0].rule, "link.page_missing");
  assert.match(lines[0], /pages\/p399\.md links to \/gone/u);
});

test("a truncated page manifest skips the link check rather than calling a link broken", () => {
  const planned = [{ file: "pages/a.md", pagePath: "a", document: { href: "/elsewhere" } }];
  const complete = evaluateOfflineSiteChecks({ planned, pagePaths: ["a"], pagesComplete: true });
  const truncated = evaluateOfflineSiteChecks({ planned, pagePaths: ["a"], pagesComplete: false });
  assert.equal(complete.findings.total, 1);
  assert.equal(truncated.findings.total, 0);
  assert.deepEqual(truncated.siteChecks.skipped, ["link.page_missing"]);
});
