import assert from "node:assert/strict";
import test from "node:test";

import corpus from "./fixtures/site-check-corpus.json" with { type: "json" };
import { buildFooterFitInput, FOOTER_FIT_WIDTH_LABELS, FOOTER_WIDTHS, MAX_FOOTER_FIT_FINDINGS } from "../src/footer-fit.js";
import { validateFooterDocument } from "../src/footer-contract.js";
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
  assert.equal(findings.total, 801);
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
  // In catalogue order: the image description rule is skipped too, because nothing read the site's images.
  assert.deepEqual(truncated.siteChecks.skipped, ["link.page_missing", "a11y.image_default_missing"]);
  assert.equal(complete.siteChecks.imageCheckReason.code, "not_requested");
});


test("metadata advice covers every authored template without refusing valid short wording", () => {
  for (const template of ["free-form", "article", "recipe", "album", "place-review", "legal"]) {
    const document = template === "free-form" ? { type: "doc", content: [] } : { template, data: {} };
    const { findings } = evaluateOfflineSiteChecks({
      planned: [{ file: "pages/about.pm.json", pagePath: "about", title: "About", description: "About", document }],
      pagePaths: ["about"],
    });
    assert.deepEqual(findings.items.map((finding) => finding.rule), [
      "seo.title_short", "seo.description_short", "seo.description_matches_title",
    ], template);
    assert.equal(findings.errors, 0);
  }
});

test("generated custom metadata is checked while effective defaults, homepage settings and unknown fields defer", () => {
  const generated = {
    file: "pages/jelly.pm.json", pagePath: "jelly", title: "Old generated title", description: "Old generated description",
    document: { template: "generated", data: { customTitle: "Jelly", customDescription: " JELLY " } },
  };
  const custom = evaluateOfflineSiteChecks({ planned: [generated], pagePaths: ["jelly"] });
  assert.deepEqual(custom.findings.items.map((finding) => finding.rule), [
    "seo.title_short", "seo.description_short", "seo.description_matches_title",
  ]);
  for (const page of [
    { ...generated, document: { template: "generated", data: { customTitle: "", customDescription: "" } } },
    { ...generated, pagePath: "" },
    { file: "pages/unknown.pm.json", pagePath: "unknown", document: { template: "article", data: {} } },
    { ...generated, metadataDescriptionKnown: false, title: undefined, document: { template: "article", data: {} } },
  ]) {
    const result = evaluateOfflineSiteChecks({ planned: [page], pagePaths: [] });
    assert.equal(result.findings.total, 0);
    assert.ok(result.siteChecks.deferredToDeployment.includes("seo.title_missing"));
    assert.ok(result.siteChecks.deferredToDeployment.includes("seo.description_matches_title"));
  }
});

test("the image description rule runs offline in the catalogue, so validate no longer defers it to the site", () => {
  const { siteChecks } = evaluateOfflineSiteChecks({ planned: [], pagePaths: [] });
  assert.ok(siteChecks.ranOffline.includes("a11y.image_default_missing"));
  assert.ok(!siteChecks.checkedBySite.includes("a11y.image_default_missing"));
  // Run offline, but not run: it is listed as skipped with the reason, ahead of the form key rule.
  assert.deepEqual(siteChecks.skipped, ["a11y.image_default_missing"]);
  assert.equal(siteChecks.imageCheckReason.code, "not_requested");
  assert.match(siteChecks.imageCheckReason.message, /validate --site|pages push --dry-run/u);
  const ran = evaluateOfflineSiteChecks({ planned: [], pagePaths: [], imageCheck: { ran: true } }).siteChecks;
  assert.equal(Object.hasOwn(ran, "skipped"), false);
  assert.equal(Object.hasOwn(ran, "imageCheckReason"), false);
});

test("footer findings keep their file and true warning count beyond the twelve-item cap", () => {
  // Wide glyphs overflow Desktop while the whole paragraph stays within the footer body limit.
  const words = Array.from({ length: MAX_FOOTER_FIT_FINDINGS + 3 }, (_, index) => `${"W".repeat(60)}${index}`);
  const footerSettings = validateFooterDocument({ enabled: true, asideBodyContent: { paragraphs: [{ runs: [{ text: words.join(" ") }] }] } });
  const footerInput = buildFooterFitInput(footerSettings);
  const lines = [];
  const result = evaluateOfflineSiteChecks({ pagePaths: [], footerInput, footerOnly: true, onProgress: line => lines.push(line) });
  assert.equal(result.findings.total, words.length);
  assert.equal(result.findings.warnings, words.length);
  assert.equal(result.findings.errors, 0);
  assert.equal(result.findings.items.length, MAX_FOOTER_FIT_FINDINGS);
  assert.equal(result.findings.truncated, true);
  assert.deepEqual(result.findings.items.map(item => item.subject), words.slice(0, MAX_FOOTER_FIT_FINDINGS));
  assert.ok(result.findings.items.every(item => item.file === "settings/site-publishing-preferences.json" && !Object.hasOwn(item, "path")));
  assert.ok(result.findings.items.every(item => item.detail === "desktop:aside"));
  assert.deepEqual(result.siteChecks, { ranOffline: ["footer.word_breaks"] });
  assert.ok(lines.some(line => line.includes("and 3 more footer fit")));
});

test("disabled footer skips only when supplied, and settings-only checks claim no page rules", () => {
  const disabled = buildFooterFitInput({ enabled: false });
  const full = evaluateOfflineSiteChecks({ planned: [], pagePaths: [], footerInput: disabled, imageCheck: { ran: true } });
  assert.deepEqual(full.siteChecks.skipped, ["footer.word_breaks"]);
  assert.equal(full.findings.total, 0);
  const settings = evaluateOfflineSiteChecks({ planned: [{ document: { href: "/missing" } }], pagePaths: [], footerInput: disabled, footerOnly: true });
  assert.deepEqual(settings.siteChecks, { ranOffline: ["footer.word_breaks"], skipped: ["footer.word_breaks"] });
  assert.equal(settings.findings.total, 0);
  const absent = evaluateOfflineSiteChecks({ planned: [], pagePaths: [], pagesComplete: false, imageCheck: { ran: true } });
  assert.deepEqual(absent.siteChecks.skipped, ["link.page_missing"]);
});

test("footer warnings join page findings without losing their true totals", () => {
  const footerInput = buildFooterFitInput({ enabled: true, asideBodyContent: { paragraphs: [{ runs: [{ text: "x".repeat(120) }] }] } });
  const result = evaluateOfflineSiteChecks({
    planned: [{ file: "pages/a.pm.json", pagePath: "a", document: { href: "/missing" } }],
    pagePaths: [], footerInput,
  });
  assert.equal(result.findings.total, 2);
  assert.equal(result.findings.warnings, 2);
  assert.deepEqual(result.findings.items.map(item => item.rule), ["link.page_missing", "footer.word_breaks"]);
  assert.ok(result.siteChecks.ranOffline.includes("footer.word_breaks"));
});

test("footer finding copy names known widths and remedies and tolerates unknown detail", () => {
  for (const [region, advice] of [["column", "Widen its column or shorten the label"], ["brand", "Widen the brand or shorten its text"], ["aside", "Widen the aside or shorten the text"]]) {
    const sentence = describeSiteFinding({ ruleId: "footer.word_breaks", subject: "Documentation", detail: `small_desktop:${region}` });
    assert.ok(sentence.includes("at small desktop width"));
    assert.ok(sentence.includes(advice));
  }
  assert.match(describeSiteFinding({ ruleId: "footer.word_breaks", subject: "Word", detail: "future:unknown" }), /at this width.*Widen the region/u);
  for (const width of FOOTER_WIDTHS) {
    const sentence = describeSiteFinding({ ruleId: "footer.word_breaks", subject: "Documentation", detail: `${width}:column` });
    assert.ok(sentence.includes(`at ${FOOTER_FIT_WIDTH_LABELS[width].toLowerCase()} width`));
    assert.ok(!sentence.includes("small_desktop") && !sentence.includes("small_phone"));
    if (width === "small_phone") assert.match(sentence, /small phone \(320px\)/u);
  }
});
