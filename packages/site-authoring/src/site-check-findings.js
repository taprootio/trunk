import { sanitizeDiagnostic } from "./errors.js";
import { boundedByBytes } from "./session.js";
import rules from "./site-check-rules.json" with { type: "json" };
import { isFormKey } from "./forms-contract.js";
import { DESCRIPTION_WARN_LENGTH, pageStructureFindings, TITLE_WARN_LENGTH } from "./page-structure-checks.js";
import { missingPageLinkFindings, normalizedPathSet } from "./site-checks.js";
import { documentTemplate, TEMPLATE_FREE_FORM, TEMPLATE_GENERATED } from "./typed-pages.js";
import { displayPagePath } from "./workspace.js";

/**
 * The CLI's side of the site validation pipeline (TR01085). The rules, their
 * severities and where they run are `shared/site-check-rules.json`; `validate`
 * evaluates the ones that name it offline, and lists the rest as checked by the
 * site, where `status` shows them. A finding carries a rule id and values; the
 * words below are this surface's own.
 */
export const SITE_CHECK_RULES = Object.freeze(rules.rules);

/** The CLI's sentence for each rule, keyed by rule id. A rule without an entry falls back to its id. */
export const SITE_CHECK_WORDING = Object.freeze({
  "link.page_missing": (finding) => `links to ${finding.subject}, which is not a page of this site`,
  "image.missing": () => "places an image that is no longer available",
  "form.none_chosen": () => "has a Form block with no form chosen",
  "form.unreadable": () => "places a form by an old key or an id the site cannot read",
  "form.missing": () => "places a form that does not exist",
  "form.archived": (finding) => `places the form '${finding.detail}', which is archived`,
  "form.key_unknown": (finding) =>
    isFormKey(finding.subject)
      ? `places the form '${finding.subject}', but the workspace has no forms/${finding.subject}.json (add that form file, run 'forms pull' if the site has it, or fix the key)`
      : `places the form '${finding.subject}', which is not a form key (lowercase letters, digits and single hyphens)`,
  "form.not_supported_on_site_type": () => "places a form, but forms are available on standard sites only",
  "form.after_submit_page_unpublished": (finding) =>
    `the form '${finding.detail}' sends visitors to ${finding.subject || "a page that no longer exists"}, which the release does not publish`,
  "form.after_submit_page_not_allowed": (finding) =>
    `the form '${finding.detail}' sends visitors to ${finding.subject}, which is not a page you created`,
  "redirect.source_invalid": () => "has a source that is not an absolute site path",
  "redirect.source_index_html": () => "has a source ending in index.html",
  "redirect.source_integration_data": () => "has a source under the integration data root",
  "redirect.source_runtime_mirror": () => "has a source under the published-site runtime",
  "redirect.source_generated_file": () => "has a source naming a file the site generates",
  "redirect.source_not_storable": () => "has a source the publisher cannot store",
  "seo.h1_missing": () =>
    "has no h1: no level 1 heading, banner title or hero title opens the page, so search engines find no page title",
  "seo.h1_demoted": (finding) =>
    `has the level 1 heading '${finding.subject}', which publishes as an h2 because ${H1_CLAIMANT[finding.detail] ?? "another element"} is already the page's h1`,
  "seo.h1_multiple": (finding) =>
    `has the hero title '${finding.subject}', which is a second h1 because ${H1_CLAIMANT[finding.detail] ?? "another element"} is already the page's h1`,
  "seo.heading_renumbered": (finding) => {
    const [authored, published] = finding.detail.split(">");
    return `has the heading '${finding.subject}' written as an h${authored}, which publishes as an h${published} so no level is skipped`;
  },
  "seo.heading_before_title": (finding) =>
    `has the heading '${finding.subject}' before the page's h1; it publishes as an h${finding.detail}`,
  "a11y.image_alt_missing": () => "places an image with no alt text",
  "a11y.link_text_empty": (finding) => `has a link to ${finding.subject} with no text`,
  "seo.title_long": (finding) =>
    `has a title of ${finding.detail} characters; search results show about ${TITLE_WARN_LENGTH}`,
  "seo.description_missing": () => "has no description; search results use the start of the page instead",
  "seo.description_long": (finding) =>
    `has a description of ${finding.detail} characters; search results show about ${DESCRIPTION_WARN_LENGTH}`,
  "seo.social_image_fallback": (finding) =>
    finding.detail === "first_image"
      ? "has no cover image; link previews use the page's first image only when it is public and at least 1200 pixels wide"
      : "has no cover image and no images, so link previews show no picture",
});

/** What a finding's `detail` names as the element that already claims the page's h1. */
const H1_CLAIMANT = Object.freeze({
  heading: "the first level 1 heading",
  banner: "the banner at the top",
  hero: "the hero title",
});

/** The sentence for a finding, falling back to the rule id for a rule this release has no words for. */
export function describeSiteFinding(finding) {
  const words = SITE_CHECK_WORDING[finding.ruleId];
  return words === undefined ? `was flagged by the site check '${finding.ruleId}'` : words(finding);
}

// Progress names this many; the JSON list is bounded by bytes instead.
const MAXIMUM_PROGRESS_LINES = 20;

const rulesRunningAt = (point) => SITE_CHECK_RULES.filter((rule) => rule.runsAt.includes(point)).map((rule) => rule.id);

// The document rules `validate` runs offline, as the set the shared evaluator filters by.
const OFFLINE_DOCUMENT_RULES = new Set(
  SITE_CHECK_RULES.filter((rule) => rule.scope === "document" && rule.runsAt.includes("validate")).map((rule) => rule.id),
);

/** The page-structure findings for one planned page, or none for a document the rules cannot read. */
function structureFindingsFor(page) {
  if (page.document === null || typeof page.document !== "object") return [];
  const template = documentTemplate(page.document);
  // A generated page's title and description come from the site, not from an author.
  if (template === TEMPLATE_GENERATED) return [];
  const freeForm = template === TEMPLATE_FREE_FORM;
  return pageStructureFindings(
    {
      freeForm,
      body: freeForm ? page.document : undefined,
      title: page.title,
      description: page.declaredDescription ?? page.description,
    },
    OFFLINE_DOCUMENT_RULES,
  );
}

/**
 * Evaluates the offline page rules over the planned pages. `pagePaths` is every
 * page path the workspace knows, and `pagesComplete` says whether that list is
 * the whole site: a truncated manifest cannot say a link is broken.
 */
export function evaluateOfflineSiteChecks({
  planned,
  pagePaths,
  pagesComplete = true,
  formKeysChecked = true,
  onProgress = () => {},
}) {
  const known = normalizedPathSet([...pagePaths, ...(planned ?? []).map((page) => page.pagePath)]);

  const found = [];
  for (const page of planned ?? []) {
    if (page.document === null || typeof page.document !== "object") continue;
    // The link rule needs every page path; the structure rules read only the page itself.
    const linkFindings = pagesComplete ? missingPageLinkFindings(page.document, page.pagePath ?? "", known) : [];
    for (const finding of [...linkFindings, ...structureFindingsFor(page)]) found.push({ page, finding });
  }
  // Errors first, then in catalogue order, so the bounded list and the progress lines keep the rules that
  // matter most when a large site raises a frequent one (a missing description) on every page.
  const catalogueOrder = (ruleId) => SITE_CHECK_RULES.findIndex((rule) => rule.id === ruleId);
  const severityOrder = (finding) => (finding.severity === "error" ? 0 : 1);
  found.sort((left, right) =>
    severityOrder(left.finding) - severityOrder(right.finding)
    || catalogueOrder(left.finding.ruleId) - catalogueOrder(right.finding.ruleId)
  );

  const items = [];
  for (const { page, finding } of found) {
    const subject = [...sanitizeDiagnostic(finding.subject, "")].slice(0, 300).join("");
    const item = {
      rule: finding.ruleId,
      severity: finding.severity,
      file: page.file,
      path: displayPagePath(page.pagePath),
      subject,
      ...(finding.detail === "" ? {} : { detail: finding.detail }),
    };
    if (items.length < MAXIMUM_PROGRESS_LINES) {
      onProgress(`Warning: ${item.file} ${describeSiteFinding({ ...finding, subject })}.`);
    }
    items.push(item);
  }
  if (items.length > MAXIMUM_PROGRESS_LINES) {
    onProgress(`Warning: ${items.length - MAXIMUM_PROGRESS_LINES} more site check finding(s); see findings.`);
  }
  const reported = boundedByBytes(items, 8 * 1024);
  const errors = items.filter((item) => item.severity === "error").length;
  return {
    findings: {
      total: items.length,
      errors,
      warnings: items.length - errors,
      items: reported.items,
      ...(reported.truncated ? { truncated: true } : {}),
    },
    siteChecks: {
      ranOffline: rulesRunningAt("validate"),
      // Rules that need the site's own records; `taproot-site status` shows what the site finds.
      checkedBySite: SITE_CHECK_RULES.filter((rule) => !rule.runsAt.includes("validate") && rule.runsAt.includes("health"))
        .map((rule) => rule.id),
      // Rules the deploy itself applies; the deploy refusal names them, and no read reports them beforehand.
      checkedAtDeploy: SITE_CHECK_RULES.filter((rule) =>
        !rule.runsAt.includes("validate") && !rule.runsAt.includes("health") && rule.runsAt.includes("deploy")
      ).map((rule) => rule.id),
      // Rules only the page editor evaluates: a cover, a description field, or a description's length (which the CLI reports as descriptionWarnings).
      checkedInEditor: SITE_CHECK_RULES.filter((rule) =>
        !rule.runsAt.includes("validate") && !rule.runsAt.includes("health") && !rule.runsAt.includes("deploy")
        && rule.runsAt.includes("edit")
      ).map((rule) => rule.id),
      // A rule that had nothing to read: a truncated page manifest, or a workspace with no form files.
      ...(pagesComplete && formKeysChecked
        ? {}
        : { skipped: [...(pagesComplete ? [] : ["link.page_missing"]), ...(formKeysChecked ? [] : ["form.key_unknown"])] }),
    },
  };
}
