/**
 * The delegation capabilities an exchanged site credential can carry (TR00645).
 *
 * These are the client's copy of `SiteAuthoringKeyEnvelope.CapabilityKeys`, and
 * the copy is deliberate: the CLI has to name them in `--capabilities` help and
 * in `whoami` before it has talked to any server, and a value it cannot print
 * without a network round trip is a value it cannot validate a typo against.
 *
 * The server remains the authority. It refuses anything outside its own
 * envelope rather than trusting this list, so the worst a stale copy here can
 * do is offer a capability the exchange then declines by name — a clear
 * refusal, never a silently wider credential.
 */
export const CAPABILITY_CONTENT = "delegation.content";
export const CAPABILITY_DESIGN = "delegation.design";
export const CAPABILITY_DEPLOYMENTS = "delegation.deployments";

export const SITE_AUTHORING_CAPABILITIES = Object.freeze([
  CAPABILITY_CONTENT,
  CAPABILITY_DESIGN,
  CAPABILITY_DEPLOYMENTS,
]);

/** What each capability lets an exchanged credential do, for help and `whoami`. */
export const SITE_AUTHORING_CAPABILITY_SUMMARIES = Object.freeze({
  "delegation.content": "write pages and media",
  "delegation.design": "set the theme, navigation, and footer",
  "delegation.deployments": "stage and deploy",
});
