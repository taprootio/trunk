// Generated from shared/testimonial-google-reviews.ts by scripts/sync-field-validation.mjs. Do not edit.
/**
 * The one owner of the Testimonial component's Google reviews fields (TR01339): the
 * names, the allowed values and bounds, the function that normalizes stored data, and
 * the one function that chooses which frozen reviews a component shows. The renderer
 * (`generator/src/component-renderer.ts`), the editor and its preview, and the
 * site-authoring CLI all read this file, so a later story adds its fields here and
 * decides nothing again elsewhere. `shared/testimonial-google-reviews-corpus.json` is
 * read by this module's tests and by the C# extractor's tests, so the two never
 * disagree about what uses the Google source.
 *
 * It is pure and dependency-free. The generator, the editor and the CLI cannot import
 * this file across project roots, so `node scripts/sync-field-validation.mjs` writes
 * their copies; edit only this file and run it again.
 */
/** `manual` is the hand-written quotations; `google-reviews` is the site's selected Google reviews. */
export const TESTIMONIAL_SOURCES = ["manual", "google-reviews"];
export const MANUAL_SOURCE = "manual";
export const GOOGLE_REVIEWS_SOURCE = "google-reviews";
/** How many reviews a Google-source component shows, as stored: a whole number from 1 to 12. */
export const TESTIMONIAL_MAX_ITEMS = Object.freeze({ minimum: 1, maximum: 12, default: 6 });
/** What a creator reads on a published page. Each is one sentence, so a change is made here only. */
export const GOOGLE_REVIEWS_ATTRIBUTION = "Selected reviews from Google";
export const GOOGLE_REVIEWS_LINK_TEXT = "Read all reviews on Google";
export const GOOGLE_REVIEW_LABEL = "Google review";
/** The reviewer shown when Google sent no name (the freeze stores an empty name, never these words). */
export const GOOGLE_USER_NAME = "Google user";
/** An unknown or mistyped source is the hand-written one, so older and foreign data renders as it always did. */
export function normalizeTestimonialSource(value) {
    return value === GOOGLE_REVIEWS_SOURCE ? GOOGLE_REVIEWS_SOURCE : MANUAL_SOURCE;
}
/** A whole number clamped to 1 to 12; anything else is the default. */
export function normalizeTestimonialMaxItems(value) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return TESTIMONIAL_MAX_ITEMS.default;
    return Math.min(TESTIMONIAL_MAX_ITEMS.maximum, Math.max(TESTIMONIAL_MAX_ITEMS.minimum, Math.trunc(value)));
}
/** The two fields of component data that is not an object (or has neither) are the defaults. */
export function normalizeTestimonialGoogleFields(data) {
    const record = data !== null && typeof data === "object" && !Array.isArray(data)
        ? data
        : {};
    return {
        source: normalizeTestimonialSource(record.source),
        maxItems: normalizeTestimonialMaxItems(record.maxItems),
    };
}
/**
 * The month and year of a review in US English, in the given IANA time zone and in UTC when none is given or
 * the zone is not one the runtime knows. Empty when the date is not a date.
 */
export function formatReviewMonthYear(value, timeZone) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime()))
        return "";
    const options = { month: "long", year: "numeric" };
    try {
        return new Intl.DateTimeFormat("en-US", { ...options, timeZone: timeZone || "UTC" }).format(date);
    }
    catch {
        return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(date);
    }
}
/**
 * Which reviews a Testimonial component shows. With the Google source it is the first `maxItems` of the reviews
 * in the order given (a release freezes them newest first), each with its reviewer and its second line; with the
 * manual source, with no reviews, or without an https profile address it is null, and the component renders as an
 * empty or hand-written one does. The renderer and the editor preview both call this, and later stories extend it.
 */
export function chooseGoogleReviews(data, input, timeZone) {
    const fields = normalizeTestimonialGoogleFields(data);
    if (fields.source !== GOOGLE_REVIEWS_SOURCE || !input || input.reviews.length === 0)
        return null;
    // The profile link is the attribution every review needs, so an address that cannot be one shows no review.
    if (!/^https:\/\//iu.test(input.mapsUri))
        return null;
    const items = input.reviews.slice(0, fields.maxItems).map((review) => {
        const month = formatReviewMonthYear(review.createTime, timeZone);
        return {
            reviewId: review.reviewId,
            text: review.text,
            name: review.reviewerName.trim() === "" ? GOOGLE_USER_NAME : review.reviewerName,
            byline: month ? `${GOOGLE_REVIEW_LABEL}, ${month}` : GOOGLE_REVIEW_LABEL,
        };
    });
    return { mapsUri: input.mapsUri, items };
}
