import { sanitizeDiagnostic } from "./errors.js";
import { boundedByBytes } from "./session.js";
import rules from "./site-check-rules.json" with { type: "json" };
import { isFormKey } from "./forms-contract.js";
import { DESCRIPTION_MINIMUM_LENGTH, DESCRIPTION_WARN_LENGTH, localAuthoringMetadata, METADATA_RULE_IDS, pageStructureFindings, RULE_IMAGE_DEFAULT_MISSING, TITLE_MINIMUM_LENGTH, TITLE_WARN_LENGTH } from "./page-structure-checks.js";
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

/** Why `validate` did not run the image description rule, which needs the site's image records (TR01371). */
export const IMAGE_CHECK_NOT_REQUESTED = "not_requested";
export const IMAGE_CHECK_DIRECTORY_ARGUMENT = "directory_argument";
export const IMAGE_CHECK_DOCS_SITE = "docs_site";
export const IMAGE_CHECK_READ_FAILED = "read_failed";
export const IMAGE_CHECK_READ_PARTLY_FAILED = "read_partly_failed";

/** The reason an image check was skipped, with the message the codes that have a remedy carry. */
export function imageCheckSkipped(code) {
  const messages = {
    [IMAGE_CHECK_NOT_REQUESTED]:
      "Image descriptions need the site's image records. Run 'taproot-site validate --site' or 'taproot-site pages push --dry-run' to check them.",
    [IMAGE_CHECK_DIRECTORY_ARGUMENT]:
      "Image descriptions need the site's image records. Run 'taproot-site validate --site' from the workspace, or 'taproot-site pages push --dry-run'.",
    [IMAGE_CHECK_DOCS_SITE]: "This is a managed Docs site, so the rule does not apply.",
  };
  return { ran: false, code, ...(messages[code] === undefined ? {} : { message: messages[code] }) };
}

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
  "a11y.image_default_missing": () => "has no default image description; set one with media images describe, then deploy",
  "a11y.link_text_empty": (finding) => `has a link to ${finding.subject} with no text`,
  "seo.title_missing": () => "has no title; add one that identifies the page",
  "seo.title_short": (finding) => `has a title of ${finding.detail} characters; consider a more specific title (guidance: ${TITLE_MINIMUM_LENGTH}–${TITLE_WARN_LENGTH})`,
  "seo.title_long": (finding) => `has a title of ${finding.detail} characters; consider shortening it (guidance: ${TITLE_MINIMUM_LENGTH}–${TITLE_WARN_LENGTH})`,
  "seo.description_missing": () => "has no description; add a short account of what the page offers",
  "seo.description_short": (finding) => `has a description of ${finding.detail} characters; consider adding useful detail (guidance: ${DESCRIPTION_MINIMUM_LENGTH}–${DESCRIPTION_WARN_LENGTH})`,
  "seo.description_long": (finding) => `has a description of ${finding.detail} characters; consider shortening it (guidance: ${DESCRIPTION_MINIMUM_LENGTH}–${DESCRIPTION_WARN_LENGTH})`,
  "seo.description_matches_title": () => "has a description that repeats its title; explain what readers will find",
  "seo.social_image_fallback": (finding) =>
    finding.detail === "first_image"
      ? "has no cover image; link previews use the page's first image only when it is public and at least 1200 pixels wide"
      : "has no cover image and no images, so link previews show no picture",
});

/**
 * What to do about each rule the stored Site Health report can raise (TR01363). The report belongs to a release,
 * so a page fix reaches it only after the page is pushed, approved and staged again.
 */
export const AFTER_PAGE_FIX =
  "then, for a page edit, run taproot-site pages push and taproot-site approve, and run taproot-site deploy --staging to refresh the report";
export const SITE_CHECK_REMEDIES = Object.freeze({
  "link.page_missing": `Change the link to a page this site has, or create that page, ${AFTER_PAGE_FIX}.`,
  "image.missing": `Remove the image from the page or replace it with one from the site's library, ${AFTER_PAGE_FIX}.`,
  // Built for each image, because the command carries the image's own revision and text.
  "a11y.image_default_missing": "Use the fix on the image finding, which names the exact command for that image.",
  "form.none_chosen": `Choose a form in the Form block, or remove the block, ${AFTER_PAGE_FIX}.`,
  "form.unreadable": `Place the form by its key (forms pull lists the site's forms), ${AFTER_PAGE_FIX}.`,
  "form.missing": `Place a form the site has: run forms push if its file is new, or correct the key, ${AFTER_PAGE_FIX}.`,
  "form.archived": `Place a form that is not archived, or restore this one in the app, ${AFTER_PAGE_FIX}.`,
  "form.not_supported_on_site_type": `Remove the Form block, because forms are available on standard sites only, ${AFTER_PAGE_FIX}.`,
  "seo.title_missing": `Give the page a title (front matter title:, or pages meta set), ${AFTER_PAGE_FIX}.`,
  "seo.title_short": `Write a more specific title of ${TITLE_MINIMUM_LENGTH}–${TITLE_WARN_LENGTH} characters, ${AFTER_PAGE_FIX}.`,
  "seo.title_long": `Shorten the title to ${TITLE_MINIMUM_LENGTH}–${TITLE_WARN_LENGTH} characters, ${AFTER_PAGE_FIX}.`,
  "seo.description_missing": `Add a short description of what the page offers, ${AFTER_PAGE_FIX}.`,
  "seo.description_short": `Add useful detail so the description runs ${DESCRIPTION_MINIMUM_LENGTH}–${DESCRIPTION_WARN_LENGTH} characters, ${AFTER_PAGE_FIX}.`,
  "seo.description_long": `Shorten the description to ${DESCRIPTION_MINIMUM_LENGTH}–${DESCRIPTION_WARN_LENGTH} characters, ${AFTER_PAGE_FIX}.`,
  "seo.description_matches_title": `Rewrite the description to say what readers will find, not repeat the title, ${AFTER_PAGE_FIX}.`,
});

/** An unknown rule id, cleaned and cut so every sentence that names it stays well inside the printed limit. */
const displayRuleId = (ruleId) => [...sanitizeDiagnostic(ruleId, "unknown")].slice(0, 200).join("");

/** The remedy for a rule, or one sentence naming the rule when this release has none for it. */
export function remedyForRule(ruleId) {
  return Object.hasOwn(SITE_CHECK_REMEDIES, ruleId)
    ? SITE_CHECK_REMEDIES[ruleId]
    : `The report flagged the rule '${displayRuleId(ruleId)}', which this release has no remedy for; read its detail on the app's Site Health page.`;
}

/** What a finding's `detail` names as the element that already claims the page's h1. */
const H1_CLAIMANT = Object.freeze({
  heading: "the first level 1 heading",
  banner: "the banner at the top",
  hero: "the hero title",
});

/** The sentence for a finding, falling back to the rule id for a rule this release has no words for. */
export function describeSiteFinding(finding) {
  const words = Object.hasOwn(SITE_CHECK_WORDING, finding.ruleId) ? SITE_CHECK_WORDING[finding.ruleId] : undefined;
  return words === undefined ? `was flagged by the site check '${displayRuleId(finding.ruleId)}'` : words(finding);
}

// Progress names this many; the JSON list is bounded by bytes instead.
export const MAXIMUM_PROGRESS_LINES = 20;

const rulesRunningAt = (point) => SITE_CHECK_RULES.filter((rule) => rule.runsAt.includes(point)).map((rule) => rule.id);

// The document rules `validate` runs offline, as the set the shared evaluator filters by.
const OFFLINE_DOCUMENT_RULES = new Set(
  SITE_CHECK_RULES.filter((rule) => rule.scope === "document" && rule.runsAt.includes("validate")).map((rule) => rule.id),
);

/** The page-structure findings for one planned page, or none for a document the rules cannot read. */
function structureFindingsFor(page) {
  if (page.document === null || typeof page.document !== "object") return [];
  const template = documentTemplate(page.document);
  const freeForm = template === TEMPLATE_FREE_FORM;
  return pageStructureFindings(
    {
      freeForm,
      body: freeForm ? page.document : undefined,
      ...localAuthoringMetadata({
        title: page.title,
        description: page.metadataDescriptionKnown === false ? undefined : page.declaredDescription ?? page.description,
        homePage: page.pagePath === "" || page.pagePath === "/",
        generated: template === TEMPLATE_GENERATED ? page.document.data ?? {} : undefined,
      }),
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
  // Whether `validate --site` ran the image description rule (TR01371), or why it did not.
  imageCheck = imageCheckSkipped(IMAGE_CHECK_NOT_REQUESTED),
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
      // Local values are checked above; only a deployment knows every effective fallback.
      deferredToDeployment: [...METADATA_RULE_IDS],
      // Rules that need the site's own records; `taproot-site status` shows what the site finds.
      checkedBySite: SITE_CHECK_RULES.filter((rule) => !rule.runsAt.includes("validate") && rule.runsAt.includes("health"))
        .map((rule) => rule.id),
      // Rules the deploy itself applies; the deploy refusal names them, and no read reports them beforehand.
      checkedAtDeploy: SITE_CHECK_RULES.filter((rule) =>
        !rule.runsAt.includes("validate") && !rule.runsAt.includes("health") && rule.runsAt.includes("deploy")
      ).map((rule) => rule.id),
      // Rules only the page editor evaluates, such as its selected cover.
      checkedInEditor: SITE_CHECK_RULES.filter((rule) =>
        !rule.runsAt.includes("validate") && !rule.runsAt.includes("health") && !rule.runsAt.includes("deploy")
        && rule.runsAt.includes("edit")
      ).map((rule) => rule.id),
      // A rule that had nothing to read: a truncated page manifest, no site read for the images, or a workspace
      // with no form files. In catalogue order.
      ...(pagesComplete && formKeysChecked && imageCheck.ran
        ? {}
        : {
          skipped: [
            ...(pagesComplete ? [] : ["link.page_missing"]),
            ...(imageCheck.ran ? [] : [RULE_IMAGE_DEFAULT_MISSING]),
            ...(formKeysChecked ? [] : ["form.key_unknown"]),
          ],
        }),
      ...(imageCheck.ran
        ? {}
        : { imageCheckReason: { code: imageCheck.code, ...(imageCheck.message === undefined ? {} : { message: imageCheck.message }) } }),
    },
  };
}
