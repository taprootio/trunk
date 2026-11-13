import { visitImageDescriptionObjects, imageDescriptionImageId } from "./content/image-description-document.js";
import { CLI_BINARY_NAME } from "./constants.js";
import { sanitizeDiagnostic } from "./errors.js";
import { AFTER_PAGE_FIX, describeSiteFinding, MAXIMUM_PROGRESS_LINES, remedyForRule } from "./site-check-findings.js";
import { displayPagePath } from "./workspace.js";

/**
 * The finding shapes the CLI reports from the stored Site Health report, and the pieces `health`, `deploy
 * --staging` and the pre-staging check share (TR01363). Page findings and image findings are separate lists, as
 * in the report. Each carries a `fix` an agent can act on.
 */

/** An image finding lists this many affected pages; `affectedPageCount` gives the total. */
export const MAXIMUM_AFFECTED_PAGES = 10;
// The server refuses a default description longer than this (`isImageDefaultDescription`).
const MAXIMUM_DESCRIPTION_SCALARS = 1000;
const IMAGE_RULE = "a11y.image_default_missing";

/** POSIX single-quotes text, so the shell hands the CLI exactly these characters. */
export function shellQuote(text) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

// The printed command passes through `sanitizeDiagnostic` (2000 scalars), and the command around the text takes
// about 150 more, so the quoted text must leave room. An apostrophe becomes four scalars once quoted.
const MAXIMUM_QUOTED_SCALARS = 1800;

/**
 * The trimmed, NFC-normalized text when it is safe to put in a describe command, else undefined. The server
 * refuses over 1000 Unicode scalars and a lone surrogate; the rest is a CLI-side rule that keeps the printed shell
 * command on one line, safe to run, and identical to the one in the JSON: control and line-separator characters,
 * anything `sanitizeDiagnostic` would strip from the printed copy (bidi overrides and isolates), and text whose
 * quoted form is too long to print whole.
 */
export function usableDescription(value) {
  if (typeof value !== "string") return undefined;
  const text = value.trim().normalize("NFC");
  if (text === "" || !text.isWellFormed() || [...text].length > MAXIMUM_DESCRIPTION_SCALARS) return undefined;
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(text)) return undefined;
  const quoted = shellQuote(text);
  return [...quoted].length > MAXIMUM_QUOTED_SCALARS || sanitizeDiagnostic(quoted, "") !== quoted ? undefined : text;
}

function describeCommand(imageId, text, revision) {
  return `${CLI_BINARY_NAME} media images describe ${imageId} --description=${shellQuote(text)}`
    + ` --expected-revision ${revision} --if-missing`;
}

/** Production's report changes only when the owner promotes a release, so a fix for it says so. */
const promotionNote = (environment) =>
  environment === "production" ? "; production's report updates once the owner promotes that release" : "";

const withoutPreview = (value) => [...sanitizeDiagnostic(value, "")].slice(0, 300).join("");

/**
 * One image finding. Pure: every fact it needs is passed in.
 *
 * `descriptionRevision` and `hasDefault` come from the batched image read; `available` is false when that read
 * succeeded without returning the image. `alts` are the distinct alt texts the workspace places for it, in
 * manifest order. `affectedPages` are already resolved with their `file`. `environment` says which report the
 * finding came from, and is absent before staging.
 */
export function buildImageFinding({ imageId, name, descriptionRevision, hasDefault, available, alts = [], affectedPages, environment }) {
  const suggestion = alts.map(usableDescription).find((text) => text !== undefined);
  const base = {
    rule: IMAGE_RULE,
    imageId,
    name: withoutPreview(name),
    affectedPages: affectedPages.slice(0, MAXIMUM_AFFECTED_PAGES),
    affectedPageCount: affectedPages.length,
  };
  if (available === false) {
    return {
      ...base,
      imageAvailable: false,
      fix: "This image is no longer in the site's library, so it cannot be described. Remove it from the pages that "
        + `place it, or replace it with an image from the library, ${AFTER_PAGE_FIX}${promotionNote(environment)}.`,
    };
  }
  const needs = suggestion === undefined ? { needsDescription: true } : { suggestedDescription: suggestion };
  if (descriptionRevision === undefined) {
    return {
      ...base,
      ...needs,
      fix: `This image's state could not be read. Run ${CLI_BINARY_NAME} media images get ${imageId} for its description `
        + "revision, then save the description with media images describe, passing --expected-revision and --if-missing, "
        + `and run ${CLI_BINARY_NAME} deploy --staging to refresh the report${promotionNote(environment)}.`,
    };
  }
  const common = { ...base, descriptionRevision, imageAvailable: true };
  if (hasDefault === true) {
    return {
      ...common,
      currentlyDescribed: true,
      fix: "This image already has a default description, so the report is out of date. "
        + `Run ${CLI_BINARY_NAME} deploy --staging to refresh the report${promotionNote(environment)}.`,
    };
  }
  if (suggestion === undefined) {
    return {
      ...common,
      currentlyDescribed: false,
      needsDescription: true,
      fix: "This image has no description and its placements carry no usable alt text. Write one, then save it with "
        + `${CLI_BINARY_NAME} media images describe ${imageId}, passing --description, --expected-revision ${descriptionRevision} `
        + `and --if-missing, then run ${CLI_BINARY_NAME} deploy --staging to refresh the report${promotionNote(environment)}.`,
    };
  }
  return {
    ...common,
    currentlyDescribed: false,
    suggestedDescription: suggestion,
    fix: describeCommand(imageId, suggestion, descriptionRevision),
  };
}

/**
 * The comparison keys of a production report, or undefined when it cannot be compared against. A page finding is
 * the same finding when its rule, page and full subject match; `findingKeys` holds those, built from the wire values
 * before the subject is cut for display.
 */
export function productionKeys(production) {
  if (production?.status !== "complete" || production.truncated === true || !production.deploymentId) return undefined;
  return {
    pages: new Set(production.findingKeys),
    images: new Set(production.images.map((image) => image.imageId)),
  };
}

/** The stored page findings as the CLI reports them. `keys` is `productionKeys`, or undefined for "not compared". */
export function buildPageFindings(report, { fileByPageId, keys, environment }) {
  return report.findings.map((finding, index) => {
    const file = finding.pageId === undefined ? undefined : fileByPageId.get(finding.pageId);
    return {
      rule: finding.ruleId,
      severity: finding.severity,
      ...(finding.pageId === undefined ? {} : { path: displayPagePath(finding.pagePath), title: withoutPreview(finding.pageTitle) }),
      ...(file === undefined ? {} : { file }),
      subject: withoutPreview(finding.subject),
      ...(finding.detail === "" ? {} : { detail: withoutPreview(finding.detail) }),
      fix: `${remedyForRule(finding.ruleId).replace(/\.$/u, "")}${promotionNote(environment)}.`,
      ...(keys === undefined ? {} : { newSinceProduction: !keys.pages.has(report.findingKeys[index]) }),
    };
  });
}

/** The pages an image finding names, resolved to workspace files where the manifest has them. */
export function resolveAffectedPages(pages, fileByPageId) {
  return pages.map((page) => {
    const file = fileByPageId.get(page.pageId);
    return { path: displayPagePath(page.path), title: withoutPreview(page.title), ...(file === undefined ? {} : { file }) };
  });
}

/** Page id to workspace source file, from a pulled workspace's manifest (empty without one). */
export function filesByPageId(manifest) {
  const files = new Map();
  for (const entry of manifest?.pages ?? []) {
    if (typeof entry?.pageId === "string" && typeof entry.file === "string") files.set(entry.pageId, entry.file);
  }
  return files;
}

/**
 * The alt text one converted page places for each image (TR01363, TR01371), as a fresh Map from lowercase image id
 * to its distinct trimmed non-empty alts, in document order.
 *
 * Only a `custom` or unset placement counts: an `inherit` placement's stored alt is the hydrated default and may be
 * stale, and a `decorative` one has no description. A banner's own image is described by the banner's `altText` and
 * mode, never by its stored alt. The walk is recursive, so a very deep document throws a `RangeError`: callers keep
 * a page's alts only when this returns, as `mergeAlts` is called after it.
 */
export function altsFromDocument(document) {
  const found = new Map();
  const add = (imageId, alt) => {
    const text = typeof alt === "string" ? alt.trim() : "";
    if (typeof imageId !== "string" || text === "") return;
    const key = imageId.toLowerCase();
    const known = found.get(key) ?? [];
    if (!known.includes(text)) found.set(key, [...known, text]);
  };
  const counts = (mode) => mode === undefined || mode === null || mode === "" || mode === "custom";
  // The parent is visited before its nested image, so a banner can claim it first.
  const bannerImages = new WeakSet();
  visitImageDescriptionObjects(document, (image) => {
    const imageId = imageDescriptionImageId(image);
    if (imageId !== undefined && !bannerImages.has(image)) {
      const album = "caption" in image && "urls" in image;
      const field = "altText" in image || album ? "altText" : "alt";
      if (counts(image.descriptionMode)) add(imageId, image[field]);
    }
    const nested = image.image;
    if (
      ("altText" in image || "descriptionMode" in image || "overlayText" in image)
      && nested !== null && typeof nested === "object" && !Array.isArray(nested)
    ) {
      const bannerId = imageDescriptionImageId(nested);
      if (bannerId !== undefined) {
        bannerImages.add(nested);
        if (counts(image.descriptionMode ?? nested.descriptionMode)) add(bannerId, image.altText);
      }
    }
  });
  return found;
}

/** Adds one page's alts to the running Map, keeping each image's distinct texts in the order pages were merged. */
export function mergeAlts(alts, found) {
  for (const [imageId, texts] of found) {
    const known = alts.get(imageId) ?? [];
    alts.set(imageId, [...known, ...texts.filter((text) => !known.includes(text))]);
  }
}

/** One progress line for an undescribed image, cleaned for the terminal; the JSON keeps the original values. */
export function imageFindingLine(item) {
  const safe = (value) => sanitizeDiagnostic(value, "");
  return `Warning: image ${safe(item.name) || safe(item.imageId)} (${safe(item.imageId)}) has no default image description; `
    + `placed on ${item.affectedPageCount} page(s). Fix: ${safe(item.fix)}`;
}

/**
 * One summary line and a line for each warning that is new since production (each warning when production was not
 * compared), at most `MAXIMUM_PROGRESS_LINES`, each naming its fix.
 */
export function reportHealthProgress(onProgress, { environment, checkedAt, status, findings, imageFindings, compared }) {
  const incomplete = status === "incomplete"
    ? " Coverage is incomplete, so this report is not a pass."
    : "";
  const total = findings.length + imageFindings.length;
  // Every value here ends up on a terminal, and some come from the manifest or the server unchecked, so each is
  // cleaned for display. The JSON result keeps the original values.
  const safe = (value, fallback = "") => sanitizeDiagnostic(value, fallback);
  const worth = [
    ...findings.filter((item) => item.newSinceProduction !== false).map((item) =>
      `Warning: ${safe(item.file ?? item.path, "site")} ${
        describeSiteFinding({ ruleId: safe(item.rule), subject: safe(item.subject), detail: safe(item.detail) })
      }. Fix: ${safe(item.fix)}`
    ),
    ...imageFindings.filter((item) => item.newSinceProduction !== false).map(imageFindingLine),
  ];
  const scope = environment === "staging" && compared === false
    ? "not compared with production, so every warning is listed"
    : environment === "staging"
    ? `${worth.length} new since production`
    : "production";
  onProgress(`Site health (${environment}, checked ${checkedAt}): ${total} finding(s), ${scope}.${incomplete}`);
  for (const line of worth.slice(0, MAXIMUM_PROGRESS_LINES)) onProgress(line);
  if (worth.length > MAXIMUM_PROGRESS_LINES) {
    onProgress(`Warning: ${worth.length - MAXIMUM_PROGRESS_LINES} more Site Health finding(s); see findings and imageFindings.`);
  }
}
