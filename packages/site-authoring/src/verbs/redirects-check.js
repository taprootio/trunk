import { withRefusalGuidance } from "../api.js";
import { VERB_REDIRECTS_CHECK } from "../constants.js";
import { openSession, successResult } from "../session.js";
import { inspectStagingPreview } from "../staging-check.js";

export async function redirectsCheck(invocation) {
  const { client, siteId, onProgress, now } = await openSession(invocation);
  return await withRefusalGuidance(onProgress, "staging redirects", async () => {
    const { routeCheck, redirects, stagingPreview } = await inspectStagingPreview(client, siteId, onProgress, now);
    return successResult(VERB_REDIRECTS_CHECK, siteId, { routeCheck, redirects, stagingPreview });
  });
}
