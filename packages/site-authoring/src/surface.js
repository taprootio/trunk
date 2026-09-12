import { CAPABILITY_CONTENT, CAPABILITY_DEPLOYMENTS, CAPABILITY_DESIGN } from "./capabilities.js";
import {
  AUTHORING_SURFACES,
  CLI_BINARY_NAME,
  SURFACE_DOCS_PRESENTATION,
  SURFACE_NONE,
  SURFACE_STANDARD,
  VERB_USE,
} from "./constants.js";
import { SiteAuthoringError } from "./errors.js";

/**
 * Which authoring verbs a site accepts (TR00790), as the CLI reads it.
 *
 * Taproot resolves the surface from a site's kind and, for a Docs site, its
 * current publication mode: a STANDARD site takes every verb, a managed Docs
 * site takes only the design and theming surface (its pages, navigation, and
 * redirects come from the artifact the Docs shell renders), and a prebuilt
 * Docs site takes nothing, because it serves its artifact's file tree
 * unchanged. The server re-resolves it on every write; what the CLI holds is a
 * recording, used to refuse a verb before a request that would be refused
 * anyway and to say why in words rather than a field name.
 */

const WIRE_SURFACES = Object.freeze({
  SITE_AUTHORING_SURFACE_STANDARD: SURFACE_STANDARD,
  SITE_AUTHORING_SURFACE_DOCS_PRESENTATION: SURFACE_DOCS_PRESENTATION,
  SITE_AUTHORING_SURFACE_NONE: SURFACE_NONE,
});

const WIRE_SITE_KINDS = Object.freeze({
  SITE_TYPE_STANDARD: "standard",
  SITE_TYPE_DOCS: "docs",
  SITE_TYPE_PROFILE: "profile",
});

const WIRE_DOCS_MODES = Object.freeze({
  DOCS_PUBLICATION_MODE_MANAGED: "managed",
  DOCS_PUBLICATION_MODE_PREBUILT: "prebuilt",
});

// Wider surfaces satisfy narrower requirements, so one comparison decides.
const SURFACE_WIDTH = Object.freeze({
  [SURFACE_NONE]: 0,
  [SURFACE_DOCS_PRESENTATION]: 1,
  [SURFACE_STANDARD]: 2,
});

/**
 * The capabilities each surface's exchange may carry. Content is absent from
 * the Docs surface because the site has no pages for it to write, and an
 * exchange that asks for it anyway is refused by name.
 */
const SURFACE_CAPABILITIES = Object.freeze({
  [SURFACE_STANDARD]: Object.freeze([CAPABILITY_CONTENT, CAPABILITY_DESIGN, CAPABILITY_DEPLOYMENTS]),
  [SURFACE_DOCS_PRESENTATION]: Object.freeze([CAPABILITY_DESIGN, CAPABILITY_DEPLOYMENTS]),
  [SURFACE_NONE]: Object.freeze([]),
});

/**
 * Reads the wire enum. Anything unrecognized — absent, unspecified, or a value
 * this CLI does not know — is `undefined`: not a surface, so nothing gates on
 * it. The CLI's gate is a courtesy ahead of the server's own refusal, and a
 * courtesy that refused on a value it could not read would refuse for the
 * wrong reason; the server still refuses what the site cannot take.
 */
export function surfaceFromWire(value) {
  return typeof value === "string" && Object.hasOwn(WIRE_SURFACES, value) ? WIRE_SURFACES[value] : undefined;
}

export function siteKindFromWire(value) {
  return typeof value === "string" && Object.hasOwn(WIRE_SITE_KINDS, value) ? WIRE_SITE_KINDS[value] : "unknown";
}

/** Absent for a STANDARD site, which has no Docs mode at all. */
export function docsPublicationModeFromWire(value) {
  return typeof value === "string" && Object.hasOwn(WIRE_DOCS_MODES, value) ? WIRE_DOCS_MODES[value] : undefined;
}

export function isKnownSurface(value) {
  return typeof value === "string" && AUTHORING_SURFACES.includes(value);
}

/**
 * Whether a site of `surface` accepts a verb that needs `required`. An
 * unknown surface on either side allows: there is nothing to gate on, and the
 * server decides.
 */
export function surfaceAllows(surface, required) {
  return SURFACE_WIDTH[surface] === undefined
    || SURFACE_WIDTH[required] === undefined
    || SURFACE_WIDTH[surface] >= SURFACE_WIDTH[required];
}

/** The verb's capability request, narrowed to what its site's surface offers. */
export function capabilitiesForSurface(surface, requested) {
  const offered = SURFACE_CAPABILITIES[surface];
  if (offered === undefined) return requested;
  return requested.filter((capability) => offered.includes(capability));
}

/** One short phrase per surface, for listings and `whoami`. */
export function describeSurface(surface) {
  switch (surface) {
    case SURFACE_STANDARD:
      return "every authoring verb";
    case SURFACE_DOCS_PRESENTATION:
      return "design and theming only; pages, navigation, and redirects come from the Docs artifact";
    case SURFACE_NONE:
      return "no authoring verb; a prebuilt Docs site serves its artifact unchanged";
    default:
      return "not reported by Taproot; each verb is decided on the server";
  }
}

/** How a listing labels a site's kind, with the Docs mode when it has one. */
export function describeSiteKind(site) {
  if (site.siteType === "docs") {
    return site.docsPublicationMode === undefined ? "docs" : `docs, ${site.docsPublicationMode}`;
  }
  return site.siteType;
}

/**
 * The refusal a verb raises when its site's surface is too narrow. Two codes,
 * one per surface, so an agent can branch on which without parsing prose; the
 * message names the verb, the surface, and the remedy when there is one.
 *
 * `source` says where the surface came from: the configuration `use` wrote,
 * or the exchange that just answered. A refusal from a recording says how to
 * refresh it; a refusal from the live answer says the site changed.
 */
export function surfaceRefusal(verb, surface, { source = "config" } = {}) {
  const remedy = source === "config"
    ? ` This is the surface recorded by '${CLI_BINARY_NAME} ${VERB_USE}'; run it again if the site has changed.`
    : ` Taproot reported this on the exchange just now; run '${CLI_BINARY_NAME} ${VERB_USE}' again to record it.`;
  if (surface === SURFACE_DOCS_PRESENTATION) {
    return new SiteAuthoringError(
      "surface.presentation_only",
      `'${verb}' does not apply to a managed Docs site: its pages, navigation, and redirects come from the Docs `
        + "artifact, and the CLI authors only its design — theme, brand, header, and footer settings, the images "
        + `they reference, and their deployment.${remedy}`,
      { field: "authoringSurface", status: surface, exitCode: 2 },
    );
  }
  return new SiteAuthoringError(
    "surface.none",
    `'${verb}' does not apply to this site: a prebuilt Docs site serves its artifact's files unchanged, so no `
      + `authoring verb applies to it.${remedy}`,
    { field: "authoringSurface", status: SURFACE_NONE, exitCode: 2 },
  );
}
