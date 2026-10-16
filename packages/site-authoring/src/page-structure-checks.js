// Generated from shared/page-structure-checks.ts by scripts/sync-field-validation.mjs. Do not edit.
/**
 * The page-structure site checks (TR00947): the SEO and accessibility oddities
 * a creator can fix in the editor or the CLI before publishing.
 *
 * `shared/site-check-rules.json` is the catalogue; these are the `document`
 * scope rules in it. They read one document and the page's own metadata, never
 * the site's records, so the editor evaluates the open document in the browser
 * and the CLI evaluates a workspace file offline, from copies of this one
 * source. The API carries no second implementation: the rules are advice, and
 * nothing on the server needs them to decide a save or a deploy.
 *
 * The heading rules replay the generator's own outline machine
 * (`heading-outline.ts`) over the document, so what they say matches what is
 * published. `generator/src/page-structure-parity.test.ts` renders every
 * heading case in `site-check-corpus.json` and compares it with what these
 * rules predicted.
 *
 * It is dependency-free so the editor and the published site-authoring package
 * can carry copies. `node scripts/sync-field-validation.mjs` writes them; edit
 * only this file and re-run it.
 */
import { bannerOpensPage, componentFixedHeadingLevel, createHeadingOutlineState, nextHeadingLevel, recordFixedHeading, } from "./heading-outline.js";
export const RULE_H1_MISSING = "seo.h1_missing";
export const RULE_H1_DEMOTED = "seo.h1_demoted";
export const RULE_H1_MULTIPLE = "seo.h1_multiple";
export const RULE_HEADING_RENUMBERED = "seo.heading_renumbered";
export const RULE_HEADING_BEFORE_TITLE = "seo.heading_before_title";
export const RULE_IMAGE_ALT_MISSING = "a11y.image_alt_missing";
export const RULE_LINK_TEXT_EMPTY = "a11y.link_text_empty";
export const RULE_TITLE_LONG = "seo.title_long";
export const RULE_DESCRIPTION_MISSING = "seo.description_missing";
export const RULE_DESCRIPTION_LONG = "seo.description_long";
export const RULE_SOCIAL_IMAGE_FALLBACK = "seo.social_image_fallback";
const RULE_ORDER = [
    RULE_H1_MISSING,
    RULE_H1_DEMOTED,
    RULE_H1_MULTIPLE,
    RULE_HEADING_RENUMBERED,
    RULE_HEADING_BEFORE_TITLE,
    RULE_IMAGE_ALT_MISSING,
    RULE_LINK_TEXT_EMPTY,
    RULE_TITLE_LONG,
    RULE_DESCRIPTION_MISSING,
    RULE_DESCRIPTION_LONG,
    RULE_SOCIAL_IMAGE_FALLBACK,
];
/** Search results cut a title off after about this many characters. */
export const TITLE_WARN_LENGTH = 60;
/** Search results cut a description off after about this many characters. */
export const DESCRIPTION_WARN_LENGTH = 160;
const MAXIMUM_DEPTH = 256;
const MAXIMUM_SUBJECT_LENGTH = 80;
const characters = (value) => [...value].length;
function isNode(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function children(node) {
    return Array.isArray(node.content) ? node.content.filter(isNode) : [];
}
function clip(value) {
    const text = value.replace(/\s+/gu, " ").trim();
    const letters = [...text];
    return letters.length > MAXIMUM_SUBJECT_LENGTH ? `${letters.slice(0, MAXIMUM_SUBJECT_LENGTH - 1).join("")}…` : text;
}
function textOf(node) {
    if (node.type === "text")
        return typeof node.text === "string" ? node.text : "";
    return children(node).map(textOf).join(node.type === "hardBreak" ? " " : "");
}
function componentData(node) {
    const raw = node.attrs?.componentData;
    if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw);
            return isNode(parsed) ? parsed : {};
        }
        catch {
            return {};
        }
    }
    // The publisher reads only a JSON string here; anything else renders as an empty component.
    return {};
}
function nonBlank(value) {
    return typeof value === "string" && value.trim() !== "";
}
function imageSource(value) {
    return isNode(value) && nonBlank(value.src);
}
function clampLevel(value) {
    const level = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 1;
    return Math.min(4, Math.max(1, level));
}
/**
 * The headings, images and links of a free-form body, as the publisher meets them.
 * Every component block counts as content before a banner, though the publisher drops
 * one that renders only a comment (a Latest posts block with no posts, an unknown type), and
 * an integration placement renders nothing or a status paragraph depending on the site;
 * whether it does can depend on the site, so a banner after such a block is the one case
 * where this walk and the publisher can differ.
 */
function walkBody(body) {
    const findings = [];
    // Findings about headings wait for the whole walk: whether the page has an h1 is known only at the end.
    const headings = [];
    const extraTitles = [];
    const outline = createHeadingOutlineState({ titleOpen: true });
    let claimant;
    let imageCount = 0;
    let hasContent = false;
    // Adopted integration markup is opaque here; it may hold the page's own h1.
    let opaqueH1 = false;
    const seeContent = () => {
        hasContent = true;
        outline.titleOpen = false;
    };
    const visitLinks = (node, path) => {
        // A link split by formatting is several adjacent text nodes; the link is empty only when all of them are.
        let run;
        const close = () => {
            if (run && run.text.trim() === "") {
                findings.push({ ruleId: RULE_LINK_TEXT_EMPTY, severity: "warning", subject: clip(run.href), detail: "", path });
            }
            run = undefined;
        };
        for (const child of children(node)) {
            const href = child.type === "text" && Array.isArray(child.marks)
                ? child.marks.find((mark) => isNode(mark) && mark.type === "link")?.attrs?.href
                : undefined;
            if (typeof href !== "string") {
                close();
                continue;
            }
            if (run && run.href !== href)
                close();
            run = { href, text: `${run?.text ?? ""}${typeof child.text === "string" ? child.text : ""}` };
        }
        close();
    };
    const visit = (node, path, depth) => {
        if (depth > MAXIMUM_DEPTH)
            return;
        switch (node.type) {
            case "heading": {
                const authored = clampLevel(node.attrs?.level);
                const titleWasOpen = !outline.titleClaimed;
                const level = nextHeadingLevel(outline, authored);
                const text = clip(textOf(node));
                const claimsTitle = authored === 1 && titleWasOpen;
                if (claimsTitle)
                    claimant = { kind: "heading", text };
                headings.push({
                    path,
                    text,
                    authored,
                    level,
                    role: claimsTitle ? "title" : titleWasOpen ? "before_title" : authored === 1 ? "demoted" : "numbered",
                });
                break;
            }
            case "taprootImage": {
                imageCount++;
                seeContent();
                if (!nonBlank(node.attrs?.alt)) {
                    const id = node.attrs?.imageId;
                    findings.push({
                        ruleId: RULE_IMAGE_ALT_MISSING,
                        severity: "warning",
                        subject: typeof id === "string" ? id : "",
                        detail: "",
                        path,
                    });
                }
                return;
            }
            case "componentBlock": {
                const type = typeof node.attrs?.componentType === "string" ? node.attrs.componentType : "";
                const data = componentData(node);
                // The banner decides whether it is the title before the page counts it as content.
                const opensPage = type === "image-banner" && bannerOpensPage(outline, data);
                const fixedLevel = componentFixedHeadingLevel(type, data);
                if (type === "image-banner" && imageSource(data.image)) {
                    imageCount++;
                    if (!nonBlank(data.altText)) {
                        findings.push({ ruleId: RULE_IMAGE_ALT_MISSING, severity: "warning", subject: "", detail: "", path });
                    }
                }
                // The social preview also draws on a hero's picture.
                if (type === "hero-section" && imageSource(data.media)) {
                    imageCount++;
                    if (!nonBlank(data.media.alt)) {
                        findings.push({ ruleId: RULE_IMAGE_ALT_MISSING, severity: "warning", subject: "", detail: "", path });
                    }
                }
                if (type === "cta" && imageSource(data.mediaImage) && !nonBlank(data.mediaImage.alt)) {
                    findings.push({ ruleId: RULE_IMAGE_ALT_MISSING, severity: "warning", subject: "", detail: "", path });
                }
                if (opensPage) {
                    recordFixedHeading(outline, 1);
                    claimant = { kind: "banner", text: clip(String(data.overlayText)) };
                }
                else if (fixedLevel === 1) {
                    const text = clip(String(data.title));
                    if (outline.titleClaimed)
                        extraTitles.push({ path, text });
                    else
                        claimant = { kind: "hero", text };
                    recordFixedHeading(outline, 1);
                }
                else if (fixedLevel !== undefined) {
                    recordFixedHeading(outline, fixedLevel);
                }
                seeContent();
                return;
            }
            case "section": {
                // A section's photo background is an image too; its children are still walked below.
                const background = node.attrs?.background;
                if (isNode(background) && imageSource(background.image))
                    imageCount++;
                break;
            }
            case "text":
                if (nonBlank(node.text))
                    seeContent();
                return;
            case "integrationFragment": {
                // The publisher treats an adopted fragment with markup as content before a banner, and its bytes may
                // carry the page's own `<h1>`, which this walk cannot see.
                const html = node.attrs?.html;
                if (nonBlank(html)) {
                    seeContent();
                    if (/<h1[\s>]/iu.test(html))
                        opaqueH1 = true;
                }
                return;
            }
            case "inlineFacts":
                // A fact list is visible content; one with no items renders nothing.
                if (Array.isArray(node.attrs?.items) && node.attrs.items.length > 0)
                    seeContent();
                return;
            default:
                break;
        }
        visitLinks(node, path);
        children(node).forEach((child, index) => visit(child, [...path, index], depth + 1));
    };
    if (isNode(body))
        children(body).forEach((child, index) => visit(child, [index], 1));
    if (claimant === undefined) {
        // A page with nothing on it has nothing to title yet.
        if (hasContent && !opaqueH1) {
            findings.unshift({ ruleId: RULE_H1_MISSING, severity: "warning", subject: "", detail: "" });
        }
    }
    else {
        const kind = claimant.kind;
        // A Heading 1 with no text still claims the title, so the page publishes an empty `<h1>`.
        if (claimant.kind === "heading" && claimant.text === "" && hasContent) {
            findings.unshift({ ruleId: RULE_H1_MISSING, severity: "warning", subject: "", detail: "" });
        }
        for (const heading of headings) {
            if (heading.role === "demoted") {
                findings.push({
                    ruleId: RULE_H1_DEMOTED,
                    severity: "warning",
                    subject: heading.text,
                    detail: kind,
                    path: heading.path,
                });
            }
            else if (heading.role === "before_title") {
                findings.push({
                    ruleId: RULE_HEADING_BEFORE_TITLE,
                    severity: "warning",
                    subject: heading.text,
                    detail: String(heading.level),
                    path: heading.path,
                });
            }
            else if (heading.role === "numbered" && heading.level !== heading.authored) {
                findings.push({
                    ruleId: RULE_HEADING_RENUMBERED,
                    severity: "warning",
                    subject: heading.text,
                    detail: `${heading.authored}>${heading.level}`,
                    path: heading.path,
                });
            }
        }
        for (const title of extraTitles) {
            findings.push({
                ruleId: RULE_H1_MULTIPLE,
                severity: "warning",
                subject: title.text,
                detail: kind,
                path: title.path,
            });
        }
    }
    return { findings, imageCount, hasContent };
}
/**
 * The warnings for one page. Headings, images and links are checked on a
 * free-form body only; the title, description and social preview checks run
 * for any page whose surface supplies those fields. `rules` limits the result
 * to the rule ids a surface runs: the catalogue's `runsAt` says which.
 */
export function pageStructureFindings(page, rules) {
    // Catalogue order, so a surface that shows only the first few keeps the heading rules.
    return collectFindings(page)
        .filter((finding) => rules === undefined || rules.has(finding.ruleId))
        .sort((left, right) => RULE_ORDER.indexOf(left.ruleId) - RULE_ORDER.indexOf(right.ruleId));
}
function collectFindings(page) {
    const findings = [];
    let imageCount = 0;
    if (page.freeForm) {
        const walked = walkBody(page.body);
        findings.push(...walked.findings);
        imageCount = walked.imageCount;
    }
    if (typeof page.title === "string" && characters(page.title.trim()) > TITLE_WARN_LENGTH) {
        findings.push({
            ruleId: RULE_TITLE_LONG,
            severity: "warning",
            subject: "",
            detail: String(characters(page.title.trim())),
        });
    }
    if (typeof page.description === "string") {
        const description = page.description.trim();
        if (description === "") {
            findings.push({ ruleId: RULE_DESCRIPTION_MISSING, severity: "warning", subject: "", detail: "" });
        }
        else if (characters(description) > DESCRIPTION_WARN_LENGTH) {
            findings.push({
                ruleId: RULE_DESCRIPTION_LONG,
                severity: "warning",
                subject: "",
                detail: String(characters(description)),
            });
        }
    }
    if (page.freeForm && page.hasCover === false) {
        findings.push({
            ruleId: RULE_SOCIAL_IMAGE_FALLBACK,
            severity: "warning",
            subject: "",
            detail: imageCount > 0 ? "first_image" : "none",
        });
    }
    return findings;
}
