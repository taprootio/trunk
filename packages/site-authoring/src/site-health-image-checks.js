// Generated from shared/site-health-image-checks.ts by scripts/sync-field-validation.mjs. Do not edit.
/**
 * Site Health's `a11y.image_default_missing` rule (TR01364): an image the site owns, that some page places, and
 * whose default description is undefined.
 *
 * The generator runs this over a frozen deployment and the site-authoring CLI runs it over what a workspace
 * places, so the rule has one owner. Both sides pass pages with an opaque `key` (the generator uses the page id,
 * the CLI the workspace file) and the image records they hold. This file is dependency-free, so
 * `node scripts/sync-field-validation.mjs` writes the generator copy and the CLI's compiled copy; edit only this
 * file and re-run it. Findings carry values, never wording: each surface writes its own words.
 */
/**
 * Every undescribed image the pages place, one finding per image, in the order of `images`, with no cap (the
 * caller applies its own). Each finding lists its pages in the order of `pages`, once per page even when that page
 * places the image repeatedly. `siteId` is compared only with records that carry one. Image ids match by exact
 * string, so callers pass the lowercase ids the API returns.
 */
export function evaluateImageDefaultMissing(input) {
    const usedBy = new Map();
    for (const page of input.pages) {
        const reference = { key: page.key, path: page.path, title: page.title };
        for (const imageId of new Set(page.imageIds)) {
            const usages = usedBy.get(imageId);
            if (usages === undefined)
                usedBy.set(imageId, [reference]);
            else
                usages.push(reference);
        }
    }
    const findings = [];
    for (const image of input.images) {
        if (image.isMissing)
            continue;
        if (image.siteId !== undefined && image.siteId !== input.siteId)
            continue;
        if (image.defaultDescription !== undefined)
            continue;
        const affectedPages = usedBy.get(image.imageId);
        if (affectedPages === undefined)
            continue;
        findings.push({
            imageId: image.imageId,
            name: image.name,
            ...(image.previewUrl === undefined ? {} : { previewUrl: image.previewUrl }),
            affectedPages: [...affectedPages],
        });
    }
    return findings;
}
