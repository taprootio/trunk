import { randomUUID } from "node:crypto";

import {
  clearPlaceCategory,
  isGooglePlaceId,
  listPlaceCategories,
  searchPlaces,
  selectPlace,
  setPlaceCategory,
  withRefusalGuidance,
} from "../api.js";
import {
  VERB_PLACES_CATEGORY_CLEAR,
  VERB_PLACES_CATEGORY_LIST,
  VERB_PLACES_CATEGORY_SET,
  VERB_PLACES_SEARCH,
  VERB_PLACES_SELECT,
} from "../constants.js";
import { SiteAuthoringError } from "../errors.js";
import { openSession, successResult } from "../session.js";

/**
 * `places search` and `places select` — find the Taproot place a place review
 * names (TR01003).
 *
 * A place review needs a Taproot place id, and until now only the editor's
 * place picker could produce one, so an imported review with a rating and an
 * address had to become an article. Search asks Google Places for predictions;
 * select records one as a Taproot place and returns its id for `placeId:` (or
 * `place:` on an article or album). Search mints the billing session token that
 * select must be given, so the pair is one billed autocomplete session.
 */

const MAXIMUM_QUERY_LENGTH = 200;
const MAXIMUM_CATEGORY_LENGTH = 100;
// Any UUID version: the server mints place ids from a sequential-style generator.
const PLACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SESSION_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export async function placesSearch(invocation) {
  const searchText = Array.isArray(invocation.placeQuery) ? invocation.placeQuery.join(" ").trim() : "";
  if (searchText === "" || searchText.length > MAXIMUM_QUERY_LENGTH) {
    throw new SiteAuthoringError(
      "places.query_invalid",
      `places search needs one query of at most ${MAXIMUM_QUERY_LENGTH} characters, such as the name and city.`,
      { field: "query", exitCode: 2 },
    );
  }
  const session = await openSession(invocation);
  const { client, siteId, onProgress } = session;
  const sessionToken = randomUUID();
  const predictions = await withRefusalGuidance(onProgress, "place search", async () =>
    await searchPlaces(client, siteId, { text: searchText, sessionToken }));
  onProgress(
    predictions.length === 0
      ? "No place matched; try the name with its city, or import the review as an article."
      : `Run 'taproot-site places select <googlePlaceId> ${sessionToken}' with the match to get its placeId.`,
  );
  return successResult(VERB_PLACES_SEARCH, siteId, { query: searchText, sessionToken, predictions });
}

export async function placesSelect(invocation) {
  const [googlePlaceId, sessionToken, ...extra] = Array.isArray(invocation.placeSelection) ? invocation.placeSelection : [];
  if (!isGooglePlaceId(googlePlaceId) || extra.length > 0
    || typeof sessionToken !== "string" || !SESSION_TOKEN.test(sessionToken)) {
    throw new SiteAuthoringError(
      "places.selection_invalid",
      "places select takes the googlePlaceId from places search, then the sessionToken that search reported.",
      { field: "googlePlaceId", exitCode: 2 },
    );
  }
  const session = await openSession(invocation);
  const { client, siteId, onProgress } = session;
  const place = await withRefusalGuidance(onProgress, "place select", async () =>
    await selectPlace(client, siteId, { googlePlaceId, sessionToken }));
  onProgress(`Selected ${place.name}: use placeId ${place.placeId} in the page's front matter.`);
  return successResult(VERB_PLACES_SELECT, siteId, { place });
}

/**
 * `places category set|clear|list` — this site's own category for a place
 * (TR01203).
 *
 * A place's category is shared by every site, and Google's types do not always
 * give the one an owner wants. The override is the site's alone: its place
 * reviews and `/places/<category>` pages use it from the next deployment, and
 * the platform-wide place is never changed. The server owns the closed list, so
 * the CLI sends the name as given and lets the server check it.
 */
export async function placesCategorySet(invocation) {
  const [placeId, category, ...extra] = Array.isArray(invocation.placeCategory) ? invocation.placeCategory : [];
  if (!PLACE_ID.test(placeId ?? "") || extra.length > 0 || typeof category !== "string"
    || category.trim() === "" || category.length > MAXIMUM_CATEGORY_LENGTH) {
    throw new SiteAuthoringError(
      "places.category_invalid",
      "places category set takes the placeId, then one category from 'places category list'.",
      { field: "category", exitCode: 2 },
    );
  }
  const session = await openSession(invocation);
  const { client, siteId, onProgress } = session;
  const state = await withRefusalGuidance(onProgress, "place category", async () =>
    await setPlaceCategory(client, siteId, { placeId, category: category.trim() }));
  onProgress(`This site now files ${placeId} under ${state.category}; deploy for pages to use it.`);
  return successResult(VERB_PLACES_CATEGORY_SET, siteId, { placeCategory: state });
}

export async function placesCategoryClear(invocation) {
  const [placeId, ...extra] = Array.isArray(invocation.placeId) ? invocation.placeId : [];
  if (!PLACE_ID.test(placeId ?? "") || extra.length > 0) {
    throw new SiteAuthoringError(
      "places.category_invalid",
      "places category clear takes the placeId of the place whose category this site set.",
      { field: "placeId", exitCode: 2 },
    );
  }
  const session = await openSession(invocation);
  const { client, siteId, onProgress } = session;
  const state = await withRefusalGuidance(onProgress, "place category", async () =>
    await clearPlaceCategory(client, siteId, { placeId }));
  onProgress(`This site files ${placeId} under ${state.category} again; deploy for pages to use it.`);
  return successResult(VERB_PLACES_CATEGORY_CLEAR, siteId, { placeCategory: state });
}

export async function placesCategoryList(invocation) {
  const session = await openSession(invocation);
  const { client, siteId, onProgress } = session;
  const categories = await withRefusalGuidance(onProgress, "place categories", async () =>
    await listPlaceCategories(client));
  return successResult(VERB_PLACES_CATEGORY_LIST, siteId, { categories });
}
