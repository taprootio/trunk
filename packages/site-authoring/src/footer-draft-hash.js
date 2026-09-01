import { createHash } from "node:crypto";

import { SiteAuthoringError } from "./errors.js";
import { FOOTER_COLOR_TOKENS } from "./theme-validation.js";

// The ten scheme colors theme push owns — light/dark times the color-token
// registry — so a new footer color changes one executable registry, not a
// hand-copied list. Every other footer field is footer-push content.
const THEME_OWNED_SCHEME_COLORS = Object.freeze(Object.keys(FOOTER_COLOR_TOKENS));

// Matches the package's document-depth convention (CONTENT_LIMITS.documentDepth):
// the baseline hashes raw hand-editable JSON, and unbounded nesting would
// otherwise exhaust the stack into an undiagnosable generic failure.
const MAXIMUM_CONTENT_DEPTH = 64;

/**
 * The pull baseline over everything `footer push` owns: a stable, type- and
 * shape-preserving JSON hash of the raw footer document with exactly the ten
 * scheme colors `theme push` overlays removed. The draft hash's canonical
 * form deliberately normalizes types and shapes the way the server does, so
 * it cannot see a hand-edit such as `enabled: "true"` or `bottomLinks: {}`;
 * this baseline must, because `theme push` would otherwise silently discard
 * that edit. Formatting-only differences — whitespace, key order — still
 * hash identically. This hash is CLI-local workspace bookkeeping, not a
 * server concurrency token.
 */
export function computeFooterContentHash(settings = {}) {
  requireBoundedDepth(settings);
  let content = settings;
  if (isContentObject(settings)) {
    content = structuredClone(settings);
    for (const scheme of ["light", "dark"]) {
      if (isContentObject(content[scheme])) {
        for (const color of THEME_OWNED_SCHEME_COLORS) delete content[scheme][color];
      }
    }
  }
  return createHash("sha256").update(`footer-content-v2${stableJson(content)}`, "utf8").digest("hex");
}

function isContentObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Iterative breadth-first walk: bounds both the structuredClone and the
// stableJson recursion below without itself being recursive.
function requireBoundedDepth(value) {
  let frontier = [value];
  for (let depth = 0; frontier.length > 0; depth += 1) {
    if (depth > MAXIMUM_CONTENT_DEPTH) {
      throw new SiteAuthoringError(
        "footer.document_too_deep",
        `settings/site-publishing-preferences.json nests JSON deeper than ${MAXIMUM_CONTENT_DEPTH} levels. `
          + "Flatten the footer document before pushing.",
        { field: "settings/site-publishing-preferences.json" },
      );
    }
    const next = [];
    for (const entry of frontier) {
      if (entry === null || typeof entry !== "object") continue;
      const children = Array.isArray(entry) ? entry : Object.values(entry);
      for (const child of children) next.push(child);
    }
    frontier = next;
  }
}

/** Deterministic JSON: sorted object keys, JSON.stringify value semantics. */
function stableJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry === undefined ? null : entry)).join(",")}]`;
  }
  return `{${
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")
  }}`;
}

// Byte-for-byte port of FooterDraftConcurrency.ComputeHash. The token protects
// the whole footer document while theme push overlays only its ten scheme color
// fields onto a fresh read. Response-only image URLs deliberately do not enter
// the canonical form.
export function computeFooterDraftHash(settings = {}) {
  const canonical = [];
  append(canonical, "footer-draft-v3");
  append(canonical, settings.enabled === true);
  append(canonical, settings.showBrand ?? true);
  append(canonical, settings.showBrandText ?? true);

  const columns = Array.isArray(settings.linkColumns) ? settings.linkColumns : [];
  append(canonical, columns.length);
  for (const column of columns) {
    append(canonical, normalizeId(column?.id));
    const groups = Array.isArray(column?.groups) ? column.groups : [];
    append(canonical, groups.length);
    for (const group of groups) {
      append(canonical, normalizeId(group?.id));
      append(canonical, group?.heading ?? "");
      appendLinks(canonical, group?.links);
    }
  }

  appendRichText(canonical, settings.asideHeadingContent);
  appendRichText(canonical, settings.asideBodyContent);
  const hasAsideCta = settings.asideCta !== undefined && settings.asideCta !== null;
  append(canonical, hasAsideCta);
  if (hasAsideCta) appendLink(canonical, settings.asideCta);
  appendRichText(canonical, settings.bottomContent);
  appendLinks(canonical, settings.bottomLinks);
  appendScheme(canonical, settings.light);
  appendScheme(canonical, settings.dark);

  const hasFeatureImage = settings.featureImage !== undefined && settings.featureImage !== null;
  append(canonical, hasFeatureImage);
  if (hasFeatureImage) {
    append(canonical, normalizeId(settings.featureImage.imageId));
    append(canonical, settings.featureImage.alt ?? "");
  }

  return createHash("sha256").update(canonical.join(""), "utf8").digest("hex");
}

function appendLinks(canonical, rawLinks) {
  const links = Array.isArray(rawLinks) ? rawLinks : [];
  append(canonical, links.length);
  for (const link of links) appendLink(canonical, link);
}

// Coalesce rather than default so the canonical form stays total even for a
// null entry: a parameter default covers only undefined.
function appendLink(canonical, rawLink) {
  const link = rawLink ?? {};
  append(canonical, normalizeId(link.id));
  append(canonical, link.label ?? "");
  appendTarget(canonical, link);
}

function appendTarget(canonical, link = {}) {
  const external = Object.hasOwn(link, "externalUrl");
  append(canonical, external ? 2 : 1);
  append(canonical, external ? "" : normalizeId(link.pageResourceId));
  append(canonical, external ? link.externalUrl ?? "" : "");
}

function appendRichText(canonical, richText) {
  const paragraphs = Array.isArray(richText?.paragraphs) ? richText.paragraphs : [];
  append(canonical, paragraphs.length);
  for (const paragraph of paragraphs) {
    const runs = Array.isArray(paragraph?.runs) ? paragraph.runs : [];
    append(canonical, runs.length);
    for (const run of runs) {
      append(canonical, run?.text ?? "");
      append(canonical, run?.bold === true);
      append(canonical, run?.italic === true);
      append(canonical, run?.underline === true);
      const hasLink = run?.link !== undefined && run.link !== null;
      append(canonical, hasLink);
      if (hasLink) appendTarget(canonical, run.link);
    }
  }
}

function appendScheme(canonical, rawScheme) {
  const scheme = rawScheme ?? {};
  append(canonical, scheme.backgroundColor ?? "");
  append(canonical, scheme.textColor ?? "");
  append(canonical, scheme.headingColor ?? "");
  append(canonical, scheme.linkColor ?? "");
  append(canonical, scheme.linkHoverColor ?? "");
  append(canonical, normalizeId(scheme.backgroundImageId));
  append(canonical, doubleBits(scheme.backgroundImageOpacity ?? 1));
  append(canonical, presentationValue(scheme.backgroundPresentation));
  append(canonical, scheme.backgroundFade === "FOOTER_FADE_MODE_BOTTOM" ? 1 : 0);
  append(canonical, scheme.backgroundRepeatHeightPx || 160);
  append(canonical, doubleBits(scheme.additionalTopPaddingRem ?? 0));
}

function presentationValue(value) {
  if (value === "FOOTER_BACKGROUND_PRESENTATION_REPEAT_X") return 1;
  if (value === "FOOTER_BACKGROUND_PRESENTATION_COVER") return 2;
  return 0;
}

function doubleBits(value) {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value === 0 ? 0 : value, false);
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeId(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function append(canonical, value) {
  const token = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
  canonical.push(`${token.length}:${token}`);
}
