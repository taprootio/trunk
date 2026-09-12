import { listAuthorableSites, withRefusalGuidance } from "../api.js";
import { CLI_BINARY_NAME, SURFACE_STANDARD, VERB_SITES, VERB_USE } from "../constants.js";
import { sanitizeDiagnostic } from "../errors.js";
import { boundedList, openAccountSession, successResult } from "../session.js";
import { describeSiteKind, describeSurface } from "../surface.js";

/**
 * `taproot-site sites` — this account's sites and what each accepts.
 *
 * The answer that used to require reading a site id out of the browser's URL
 * bar and pasting it into a hand-written configuration file (TR00645). It runs
 * on the sign-in credential, which is the only thing that can enumerate an
 * account's sites, and it is one of exactly two things that credential can do.
 *
 * Every standard and Docs site is listed with its authoring surface (TR00790).
 * A Docs site that accepts no verb is shown rather than hidden: an operator who
 * cannot see a site they own cannot learn why the CLI refuses it.
 */

/**
 * More than a terminal can usefully read at once, and well inside the result
 * size bound. A studio account with more sites than this gets a reported
 * truncation rather than a failed command.
 */
const MAXIMUM_SITES = 200;

export async function sites(invocation) {
  const { client, signIn, onProgress } = await openAccountSession(invocation);

  return await withRefusalGuidance(onProgress, "site list", async () => {
    const authorable = await listAuthorableSites(client);
    const reported = boundedList(authorable, MAXIMUM_SITES);

    if (authorable.length === 0) {
      onProgress("This account has no standard or Docs sites.");
    } else {
      for (const site of reported.items) {
        // Sanitized on the way to the terminal, raw in the JSON result. Site
        // names are authored by people and can carry terminal controls or bidi
        // overrides; a listing is exactly where that would be used to make one
        // site read as another the operator then selects. The domain gets the
        // same treatment; the kind and surface are this CLI's own words.
        const name = sanitizeDiagnostic(site.name, site.siteId);
        const domain = site.primaryDomain ? `  ${sanitizeDiagnostic(site.primaryDomain, "")}` : "";
        onProgress(`${site.siteId}  ${name}  [${describeSiteKind(site)}]${domain}`);
        if (site.authoringSurface !== SURFACE_STANDARD) {
          onProgress(`    ${site.authoringSurface ?? "surface unknown"}: ${describeSurface(site.authoringSurface)}.`);
        }
      }
      onProgress(`Select one with '${CLI_BINARY_NAME} ${VERB_USE} <name or id>'.`);
    }

    return successResult(VERB_SITES, undefined, {
      accountId: signIn.accountId,
      sites: {
        total: authorable.length,
        items: reported.items,
        ...(reported.truncated ? { itemsTruncated: true } : {}),
      },
    });
  });
}
