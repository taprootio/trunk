import { randomUUID } from "node:crypto";

import { isGooglePlaceId, searchPlaces, selectPlace, withRefusalGuidance } from "../api.js";
import { VERB_PLACES_SEARCH, VERB_PLACES_SELECT } from "../constants.js";
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
