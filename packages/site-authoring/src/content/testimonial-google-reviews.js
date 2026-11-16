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
/**
 * Which Google reviews a component shows (TR01341): the `newest` ones, as many as `maxItems` says, or the ones the
 * author picked by id, in the order picked. Stored `reviewIds` stay when the selection is `newest`, so switching back
 * loses nothing.
 */
export const TESTIMONIAL_REVIEW_SELECTIONS = ["newest", "chosen"];
export const NEWEST_SELECTION = "newest";
export const CHOSEN_SELECTION = "chosen";
/** The most reviews one component can choose; the C# `BusinessProfilePolicy.MaxChosenReviewsPerComponent` is the same number. */
export const TESTIMONIAL_MAX_CHOSEN_REVIEWS = 12;
/** A review id Taproot keeps: 1 to 256 letters, digits, `_` or `-`, as `BusinessProfilePolicy.IsValidReviewId` says. */
export const REVIEW_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;
/** What a creator reads on a published page. Each is one sentence, so a change is made here only. */
export const GOOGLE_REVIEWS_ATTRIBUTION = "Selected reviews from Google";
export const GOOGLE_REVIEWS_LINK_TEXT = "Read all reviews on Google";
export const GOOGLE_REVIEW_LABEL = "Google review";
/** The label above the owner's reply on a listed review, and the link to write a review (TR01342). */
export const GOOGLE_REVIEWS_REPLY_LABEL = "Reply from the owner";
export const GOOGLE_REVIEWS_WRITE_LINK_TEXT = "Write a review";
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
/** Anything but the exact word `chosen` is the newest reviews, so older and foreign data renders as it always did. */
export function normalizeReviewSelection(value) {
    return value === CHOSEN_SELECTION ? CHOSEN_SELECTION : NEWEST_SELECTION;
}
/**
 * The review ids a component stored: the strings that are valid review ids, later duplicates dropped, then the first
 * twelve. Anything that is not a list is none. The C# page extractor applies the same rule, and the corpus holds them
 * to the same answers.
 */
export function normalizeReviewIds(value) {
    if (!Array.isArray(value))
        return [];
    const valid = value.filter((id) => typeof id === "string" && REVIEW_ID_PATTERN.test(id));
    return [...new Set(valid)].slice(0, TESTIMONIAL_MAX_CHOSEN_REVIEWS);
}
/** The fields of component data that is not an object (or has none of them) are the defaults. */
export function normalizeTestimonialGoogleFields(data) {
    const record = data !== null && typeof data === "object" && !Array.isArray(data)
        ? data
        : {};
    return {
        source: normalizeTestimonialSource(record.source),
        maxItems: normalizeTestimonialMaxItems(record.maxItems),
        reviewSelection: normalizeReviewSelection(record.reviewSelection),
        reviewIds: normalizeReviewIds(record.reviewIds),
        // Only the boolean `true` turns a switch on, so a string or a number in older or foreign data is off.
        showAll: record.showAll === true,
        showProfileSummary: record.showProfileSummary === true,
    };
}
/**
 * The one answer to what a Testimonial shows (TR01342), computed once from the stored fields. The renderer, the editor
 * preview, the editor and the page preview's reference walk all call it, and the C# page extractor's answers are held to
 * it by the corpus. The editor passes its draft fields in the stored shape.
 */
export function googleReviewsDisplay(data) {
    const fields = normalizeTestimonialGoogleFields(data);
    const record = data !== null && typeof data === "object" && !Array.isArray(data)
        ? data
        : {};
    const google = fields.source === GOOGLE_REVIEWS_SOURCE;
    const listAll = google && fields.reviewSelection === NEWEST_SELECTION && fields.showAll;
    return { listAll, summary: google && fields.showProfileSummary, carousel: Boolean(record.carousel) && !listAll };
}
/**
 * The review ids a component chooses: its stored ids when the source is Google and the selection is `chosen`, and none
 * otherwise (a `newest` component ignores ids it still holds). The page preview, the editor, the chooser below and the
 * C# extractor all mean this.
 */
export function chosenGoogleReviewIds(data) {
    const fields = normalizeTestimonialGoogleFields(data);
    return fields.source === GOOGLE_REVIEWS_SOURCE && fields.reviewSelection === CHOSEN_SELECTION ? fields.reviewIds : [];
}
/** The one test of an address a page may link to: https, as the profile's Maps address and the address to write a review at both need (TR01342). */
function isHttpsAddress(value) {
    return /^https:\/\//iu.test(value);
}
/** "1 star", "5 stars": the one place the rating is worded, for the published page, the editor and the review cards. */
export function googleRatingWords(stars) {
    return stars === 1 ? "1 star" : `${stars} stars`;
}
const COUNT_FORMAT = new Intl.NumberFormat("en-US");
const AVERAGE_FORMAT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
/**
 * The sentence above a listing (TR01342): "4.8 average from 212 reviews on Google", "1 review" for one, the count with a US
 * thousands separator and the average to one decimal place. An average that is not a rating from 1 to 5 (Google's reader stores an
 * absent one as 0) leaves the count alone ("212 reviews on Google"), and a total of zero or less, which Google reports for a
 * profile it counts no reviews for, has no figures at all, so the sentence is null.
 */
export function googleSummarySentence(averageRating, totalReviewCount) {
    if (!Number.isFinite(totalReviewCount) || totalReviewCount < 1)
        return null;
    const total = Math.trunc(totalReviewCount);
    const count = `${COUNT_FORMAT.format(total)} ${total === 1 ? "review" : "reviews"} on Google`;
    return Number.isFinite(averageRating) && averageRating >= 1 && averageRating <= 5
        ? `${AVERAGE_FORMAT.format(averageRating)} average from ${count}`
        : count;
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
 * Which reviews a Testimonial component shows, and every word around them. With the Google source and the `newest`
 * selection it is the first `maxItems` of the showable reviews in the order given (a release freezes them newest first),
 * or every one of them, never an older chosen one, while `googleReviewsDisplay(data).listAll` holds (TR01342); with `chosen`
 * it is the reviews the component lists, in the listed order, each taken from the showable reviews or from the older chosen
 * ones, and a listed review that is in neither is skipped (TR01341). Each item has its reviewer and its second line (with the
 * rating written out when the list is in effect) and, for the list, the owner's reply. `summary` holds the words and links of
 * Google's rating when the component shows it and the release froze the figures, and `attribution` the line after the
 * reviews, which keeps its link to read all reviews unless the summary is returned and carries it. With the manual source,
 * with nothing to show, or without an https profile address it is null, and the component renders as an empty or
 * hand-written one does. The renderer and the editor preview both call this and only lay the result out.
 */
export function chooseGoogleReviews(data, input, timeZone) {
    const fields = normalizeTestimonialGoogleFields(data);
    if (fields.source !== GOOGLE_REVIEWS_SOURCE || !input)
        return null;
    // The profile link is the attribution every review needs, so an address that cannot be one shows no review.
    if (!isHttpsAddress(input.mapsUri))
        return null;
    const display = googleReviewsDisplay(data);
    // A list shows every showable review whatever maxItems holds, and never the older ones another page chose (TR01342).
    const selected = fields.reviewSelection === CHOSEN_SELECTION
        ? listedReviews(chosenGoogleReviewIds(data), input)
        : display.listAll
            ? [...input.reviews]
            : input.reviews.slice(0, fields.maxItems);
    if (selected.length === 0)
        return null;
    const items = selected.map((review) => {
        const month = formatReviewMonthYear(review.createTime, timeZone);
        const parts = [GOOGLE_REVIEW_LABEL, month, ...(display.listAll ? [googleRatingWords(review.starRating)] : [])];
        return {
            reviewId: review.reviewId,
            text: review.text,
            name: review.reviewerName.trim() === "" ? GOOGLE_USER_NAME : review.reviewerName,
            byline: parts.filter((part) => part !== "").join(", "),
            reply: display.listAll && typeof review.replyText === "string" && review.replyText.trim() !== ""
                ? review.replyText
                : null,
        };
    });
    const summary = display.summary && input.summary ? summaryWords(input.summary, input.mapsUri) : null;
    return {
        items,
        summary,
        // The summary carries the link to read all reviews, so the page keeps one link of each kind.
        attribution: {
            text: `${GOOGLE_REVIEWS_ATTRIBUTION}.`,
            link: summary ? null : { label: GOOGLE_REVIEWS_LINK_TEXT, href: input.mapsUri },
        },
    };
}
/** The summary's words and links. The write link needs an https address, as the profile's own link does. */
function summaryWords(summary, mapsUri) {
    return {
        sentence: googleSummarySentence(summary.averageRating, summary.totalReviewCount),
        readAll: { label: GOOGLE_REVIEWS_LINK_TEXT, href: mapsUri },
        write: isHttpsAddress(summary.newReviewUri)
            ? { label: GOOGLE_REVIEWS_WRITE_LINK_TEXT, href: summary.newReviewUri }
            : null,
    };
}
/** The listed reviews in the listed order; a showable review wins over an older copy of the same id. */
function listedReviews(ids, input) {
    const known = new Map();
    for (const review of input.olderChosenReviews ?? [])
        known.set(review.reviewId, review);
    for (const review of input.reviews)
        known.set(review.reviewId, review);
    return ids.flatMap((id) => known.get(id) ?? []);
}
