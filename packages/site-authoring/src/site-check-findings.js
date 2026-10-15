import { sanitizeDiagnostic } from "./errors.js";
import { boundedByBytes } from "./session.js";
import rules from "./site-check-rules.json" with { type: "json" };
import { missingPageLinkFindings, normalizedPathSet } from "./site-checks.js";
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
  "form.after_submit_page_unpublished": (finding) =>
    `the form '${finding.detail}' sends visitors to ${finding.subject || "a page that no longer exists"}, which the release does not publish`,
  "form.after_submit_page_not_allowed": (finding) =>
    `the form '${finding.detail}' sends visitors to ${finding.subject}, which is not a page you created`,
  "redirect.source_invalid": () => "has a source that is not an absolute site path",
  "redirect.source_index_html": () => "has a source ending in index.html",
  "redirect.source_integration_data": () => "has a source under the integration data root",
  "redirect.source_share_link": () => "has a source under the share-link root",
  "redirect.source_runtime_mirror": () => "has a source under the published-site runtime",
  "redirect.source_generated_file": () => "has a source naming a file the site generates",
  "redirect.source_not_storable": () => "has a source the publisher cannot store",
});

/** The sentence for a finding, falling back to the rule id for a rule this release has no words for. */
export function describeSiteFinding(finding) {
  const words = SITE_CHECK_WORDING[finding.ruleId];
  return words === undefined ? `was flagged by the site check '${finding.ruleId}'` : words(finding);
}

// Progress names this many; the JSON list is bounded by bytes instead.
const MAXIMUM_PROGRESS_LINES = 20;

const rulesRunningAt = (point) => SITE_CHECK_RULES.filter((rule) => rule.runsAt.includes(point)).map((rule) => rule.id);

/**
 * Evaluates the offline page rules over the planned pages. `pagePaths` is every
 * page path the workspace knows, and `pagesComplete` says whether that list is
 * the whole site: a truncated manifest cannot say a link is broken.
 */
export function evaluateOfflineSiteChecks({ planned, pagePaths, pagesComplete = true, onProgress = () => {} }) {
  const known = normalizedPathSet([...pagePaths, ...(planned ?? []).map((page) => page.pagePath)]);

  const items = [];
  if (pagesComplete) {
    for (const page of planned ?? []) {
      if (page.document === null || typeof page.document !== "object") continue;
      for (const finding of missingPageLinkFindings(page.document, page.pagePath ?? "", known)) {
        const item = {
          rule: finding.ruleId,
          severity: finding.severity,
          file: page.file,
          path: displayPagePath(page.pagePath),
          subject: [...sanitizeDiagnostic(finding.subject, "")].slice(0, 300).join(""),
        };
        if (items.length < MAXIMUM_PROGRESS_LINES) {
          onProgress(`Warning: ${item.file} ${describeSiteFinding({ ...finding, subject: item.subject })}.`);
        }
        items.push(item);
      }
    }
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
      checkedAtDeploy: SITE_CHECK_RULES.filter((rule) => !rule.runsAt.includes("validate") && !rule.runsAt.includes("health"))
        .map((rule) => rule.id),
      ...(pagesComplete ? {} : { skipped: ["link.page_missing"] }),
    },
  };
}
