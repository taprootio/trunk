// Generated from shared/block-flow.ts by scripts/sync-field-validation.mjs. Do not edit.
/**
 * The one owner of how page blocks space themselves (TR01328): the three
 * site-wide spacing choices and the stylesheet that turns them into margins.
 *
 * Text used to get its space from a browser default and components got none.
 * Now every direct child of a flow container takes one gap, a token that
 * follows the site's text size and the chosen spacing. The published page
 * shell inlines `BLOCK_FLOW_CSS` in its core section and the editor's page
 * preview, which has no shell, applies the same string, so both agree.
 *
 * The generator and the site-authoring CLI cannot import a repo-root file, so
 * `node scripts/sync-field-validation.mjs` writes their copies; edit only this
 * file and re-run it. The editor imports it by relative path.
 */
/** The scale each choice puts on the gap and on a heading's top margin. */
export const BLOCK_SPACINGS = {
    compact: 0.75,
    standard: 1,
    roomy: 1.5,
};
/** What a site that never chose gets; it is also the value the page leaves unwritten. */
export const DEFAULT_BLOCK_SPACING = "standard";
// A flow container holds a page's blocks as direct children. This is the
// shell's older list with `.taproot-free-form` swapped for the section
// content: the free-form element's own children are sections and root bands,
// which must not gain a margin.
const FLOW_CONTAINERS = [
    "[data-section-content]",
    "[slot=\"body\"]",
    "[slot=\"introduction\"]",
    ".recipe-story",
    ".taproot-legal__body",
].join(", ");
// The end room needs only the text elements whose bottom margin is 0; the
// unpadded edge leaves text, lists and rules alone, as they are today.
const TEXT_AND_LISTS = "p, h1, h2, h3, h4, h5, h6, figure, blockquote, dl, ul, ol, pre, hr";
const TEXT_WITHOUT_END_MARGIN = "p, h1, h2, h3, h4, h5, h6, figure, blockquote, dl";
const SCALE_MAPPING = Object.entries(BLOCK_SPACINGS)
    .map(([name, scale]) => `[data-block-spacing="${name}"] {\n  --taproot-block-scale: ${scale};\n}`)
    .join("\n");
/**
 * The block flow rules, compact enough to inline in every page. No CSS comments
 * ship, so each rule's reason is here:
 *
 * - The gap is a token, not em, so a heading and a paragraph resolve the same
 *   length and it stays fluid on phones. The 1em fallback holds the browser's
 *   text margin when the runtime never ran and set `--esp-type-normal`.
 * - The block rule and its text reset have zero specificity (`:where()`), so any
 *   rule a component, a banner or an author writes for its own margin wins with
 *   no ordering fight. The reset repeats `esp-reset.css` because the page preview
 *   has no reset.
 * - Components load lazily and an undefined element is inline, where a vertical
 *   margin does nothing, so the listed hosts match their `:host` from first paint.
 *   Add every new lazily loaded component host to that list.
 * - A heading's top margin scales with the setting. At (0,1,0) it beats Espalier's
 *   root heading rule and loses to the banner resets, in any section order.
 * - A spacer adds its height to the gap instead of a second margin.
 * - The last text block of a padded section gets room, so a section closes as it
 *   opens. The descendant combinator reaches past a surface's `esp-box`.
 * - An unpadded section's first and last component stay flush. Text, lists, rules
 *   and anything with a margin rule of its own keep what they have.
 * - Banners stay flush with their neighbors. Those rules live here, not in the
 *   banner section, because the page preview has no shell.
 */
export const BLOCK_FLOW_CSS = `
:where(${FLOW_CONTAINERS}) {
  --taproot-block-gap: calc(var(--esp-type-normal, 1em) * var(--taproot-block-scale, 1));
}
${SCALE_MAPPING}
:where(${FLOW_CONTAINERS}) > * {
  margin-block: var(--taproot-block-gap);
}
:where(${FLOW_CONTAINERS}) > :where(p, h1, h2, h3, h4, figure, blockquote, dl) {
  margin-block-end: 0;
}
taproot-hero,
taproot-cta,
taproot-testimonial,
taproot-feature-grid,
taproot-latest-posts,
taproot-card-grid,
taproot-product-grid {
  display: block;
}
:is(${FLOW_CONTAINERS}) > :where(h1, h2, h3, h4, h5) {
  margin-block-start: calc(var(--esp-size-small-to-normal, 0.83em) * var(--taproot-block-scale, 1));
}
:where(${FLOW_CONTAINERS}) > taproot-spacer {
  margin-block: 0;
}
esp-section[data-content-padding="standard"] [data-section-content] > :is(${TEXT_WITHOUT_END_MARGIN}):last-child {
  margin-block-end: var(--taproot-block-gap);
}
:where(esp-section[data-content-padding="none"] [data-section-content]) > :where(:first-child:not(${TEXT_AND_LISTS})) {
  margin-block-start: 0;
}
:where(esp-section[data-content-padding="none"] [data-section-content]) > :where(:last-child:not(${TEXT_AND_LISTS})) {
  margin-block-end: 0;
}
:is(${FLOW_CONTAINERS}) taproot-image-banner {
  margin: 0;
}
:is(${FLOW_CONTAINERS}) esp-image[banner] {
  margin: 0;
}
:is(${FLOW_CONTAINERS}) *:has(+ taproot-image-banner) {
  margin-block-end: 0;
}
:is(${FLOW_CONTAINERS}) taproot-image-banner + * {
  margin-block-start: 0;
}
[data-taproot-section][data-following-spacing="compact"] > [data-section-content] > :first-child,
[data-taproot-section][data-following-spacing="compact"] > esp-box > [data-section-content] > :first-child {
  margin-block-start: 0;
}
`.trim();
