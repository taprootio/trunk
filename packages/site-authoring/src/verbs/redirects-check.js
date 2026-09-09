import { mintStagingPreviewHandoff, withRefusalGuidance } from "../api.js";
import { VERB_REDIRECTS_CHECK } from "../constants.js";
import { openSession, successResult } from "../session.js";
import { checkStagingRedirects } from "../staging-check.js";

export async function redirectsCheck(invocation) {
  const { client, siteId, onProgress, now } = await openSession(invocation);
  return await withRefusalGuidance(onProgress, "staging redirects", async () => {
    const checks = await checkStagingRedirects(client, siteId, onProgress, now);
    if (!checks.redirects.verified) {
      onProgress(
        "Warning: staging redirects are not verified. Check the reported mismatches and retry after edge propagation.",
      );
    }
    const handoff = await mintStagingPreviewHandoff(client, siteId, { now });
    return successResult(VERB_REDIRECTS_CHECK, siteId, { stagingPreview: { ...checks, ...handoff } });
  });
}
