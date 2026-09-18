import { mintStagingPreviewHandoff, withRefusalGuidance } from "../api.js";
import { VERB_STAGING_REVIEW } from "../constants.js";
import { openSession, successResult } from "../session.js";

export const STAGING_REVIEW_GUIDANCE = "Open the URL once in a browser, then switch the site's theme toggle between "
  + "light and dark to review both schemes; no page draft is needed to review a presentation change.";

/**
 * `staging review` — mint a fresh single-use review handoff for the site's
 * acknowledged staging host, and nothing else (TR00800 follow-up).
 *
 * It is the recovery `deploy --staging` names when it could not mint one,
 * and the only such path a managed Docs site can take: `redirects check`
 * inspects a redirect map the Docs shell does not have and needs the
 * Standard surface. Minting is read-only for the site: the handoff is a
 * short-lived capability bound to the current host, reported only in the
 * final JSON and never in progress or GITHUB_OUTPUT.
 */
export async function stagingReview(invocation) {
  const { client, siteId, now, onProgress } = await openSession(invocation);
  return await withRefusalGuidance(onProgress, "staging review", async () => {
    onProgress("Minting a fresh single-use staging review handoff.");
    const handoff = await mintStagingPreviewHandoff(client, siteId, { now });
    onProgress(`Staging review handoff minted for ${handoff.stagingUrl}. ${STAGING_REVIEW_GUIDANCE}`);
    return successResult(VERB_STAGING_REVIEW, siteId, {
      stagingPreview: { ...handoff, review: STAGING_REVIEW_GUIDANCE },
    });
  });
}
