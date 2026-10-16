// Generated from shared/heading-outline.ts by scripts/sync-field-validation.mjs. Do not edit.
/**
 * How a published page numbers its headings (TR00929, TR00946, TR00947).
 *
 * The generator renders a page with this state machine, and the page-structure
 * checks in `page-structure-checks.ts` replay the same machine over a document
 * to tell an author which element claims the page's `<h1>` and which headings
 * the publisher renumbers. One owner keeps what the warning says in step with
 * what ships. The generator's `component-renderer.ts` and the site-authoring
 * package import copies of this file; `node scripts/sync-field-validation.mjs`
 * writes them, so edit only this file.
 *
 * It is dependency-free so every consumer can carry a copy.
 */
export function createHeadingOutlineState(options = {}) {
    const titleOpen = options.titleOpen === true;
    const parentLevel = options.parentLevel ?? 1;
    return { level: parentLevel, titleOpen, titleClaimed: !titleOpen, parentLevel, open: [] };
}
// Not `Array.prototype.at`: the editor's TypeScript library predates it.
function lastOpen(state) {
    return state.open[state.open.length - 1];
}
/**
 * The level to render an author heading at (TR00946). It closes the open
 * headings at its authored level or deeper, then sits one level below the
 * heading still open, so an h3 straight after the page's h1 becomes an h2,
 * and so do the h3s after it until the author's own h2. A free-form page's
 * first author h1 is its title; any other h1 is demoted.
 */
export function nextHeadingLevel(state, authored) {
    if (!state)
        return authored;
    if (authored === 1 && !state.titleClaimed) {
        recordFixedHeading(state, 1);
        return 1;
    }
    while ((lastOpen(state)?.authored ?? 0) >= authored)
        state.open.pop();
    const level = Math.min(6, (lastOpen(state)?.level ?? state.parentLevel) + 1);
    state.open.push({ authored, level });
    state.level = level;
    return level;
}
/** A heading whose level the page fixes, such as a hero title or CTA heading. */
export function recordFixedHeading(state, level) {
    if (level === 1)
        state.titleClaimed = true;
    while ((lastOpen(state)?.level ?? 0) >= level)
        state.open.pop();
    state.open.push({ authored: level, level });
    state.level = level;
}
/**
 * Whether an Image Banner is the page's title: it opens a free-form page,
 * shows an image, and carries overlay text. Without an image the overlay is
 * not drawn, so the banner carries no heading.
 */
export function bannerOpensPage(state, data) {
    return state?.titleOpen === true
        && Boolean(data.image?.src)
        && typeof data.overlayText === "string"
        && data.overlayText.trim() !== "";
}
/**
 * The level of the heading a hero or CTA component fixes on the page, or
 * undefined when the component carries none. A hero title is always an h1;
 * a CTA heading is an h2.
 */
export function componentFixedHeadingLevel(type, data) {
    if (type === "hero-section" && data.title)
        return 1;
    if (type === "cta" && data.heading)
        return 2;
    return undefined;
}
