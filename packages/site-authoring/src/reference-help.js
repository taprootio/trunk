import { readFileSync } from "node:fs";

import { TEMPLATE_TYPE_FREE_FORM } from "./api.js";
import { CLI_BINARY_NAME } from "./constants.js";
import {
  FIXTURE_CONTRACT_VERSION,
  FIXTURE_DELIVERY_ORIGIN_DOMAIN,
  FIXTURE_MANIFEST_FILE_NAME,
  FIXTURE_MAXIMUM_DELIVERY_ORIGINS,
  FIXTURE_METADATA_FIELDS,
  FIXTURE_OPTIONAL_ROOT_FIELDS,
  FIXTURE_REQUIRED_ROOT_FIELDS,
  SHIPPED_FIXTURE_NAME,
  shippedFixtureDirectory,
} from "./fixture-contract.js";
import {
  DEFAULT_REDIRECT_STATUS,
  GONE_STATUS,
  REDIRECT_LIMITS,
  REDIRECT_STATUSES,
  REDIRECTS_FILE_NAME,
} from "./redirects-contract.js";
import { SETTINGS_GROUPS } from "./settings-catalog.js";
import {
  canonicalizeComponentData,
  COMPONENT_TYPES,
  getComponentDefinition,
  getComponentPropertyReference,
} from "./content/components.js";
import { FREE_FORM_SECTION_REGISTRY } from "./content/free-form-sections.js";
import {
  CONTENT_ERROR_CODES,
  CONTENT_LIMITS,
  MARK_TYPES,
  NODE_TYPES,
} from "./content/vocabulary.js";
import {
  formatPresentationReference,
  getAppearanceReference,
  getFooterReference,
  getThemeReference,
} from "./presentation-reference.js";
import {
  INTERNAL_PAGE_BASELINE_DIRECTORY,
  MANIFEST_VERSION,
  NAVIGATION_FILE_NAME,
  PAGE_READ_ONLY_REASON_SYSTEM_404,
  PAGE_SOURCE_EXTENSIONS,
  PAGE_WORKSPACE_MODE_EDITABLE,
  PAGE_WORKSPACE_MODE_READ_ONLY,
  pageSourceFormat,
  PAGES_DIRECTORY,
  SETTINGS_DIRECTORY,
  SYSTEM_PAGE_NOT_FOUND_PATH,
} from "./workspace.js";

export { getAppearanceReference, getFooterReference, getThemeReference };

export const REFERENCE_VERSION = 18;
export const PAGE_TYPES = Object.freeze(["free-form"]);
export const REFERENCE_TOPICS = Object.freeze([
  Object.freeze({ name: "pages", usage: `${CLI_BINARY_NAME} help pages`, summary: "List authorable page types." }),
  Object.freeze({
    name: "page",
    usage: `${CLI_BINARY_NAME} help page <page-type>`,
    summary: "Describe one page type.",
  }),
  Object.freeze({
    name: "components",
    usage: `${CLI_BINARY_NAME} help components`,
    summary: "List free-form components.",
  }),
  Object.freeze({
    name: "component",
    usage: `${CLI_BINARY_NAME} help component <component-type>`,
    summary: "Describe one component schema and show a valid example.",
  }),
  Object.freeze({ name: "nav", usage: `${CLI_BINARY_NAME} help nav`, summary: "Describe nav.json item shapes." }),
  Object.freeze({
    name: "redirects",
    usage: `${CLI_BINARY_NAME} help redirects`,
    summary: "Author redirects.json: entry shape, normalization, and the refusals.",
  }),
  Object.freeze({
    name: "media",
    usage: `${CLI_BINARY_NAME} help media`,
    summary: "Describe media selection, naming, and component-ready output.",
  }),
  Object.freeze({
    name: "preview",
    usage: `${CLI_BINARY_NAME} help preview`,
    summary: "Describe authoring preview creation, waiting, and recovery.",
  }),
  Object.freeze({
    name: "theme",
    usage: `${CLI_BINARY_NAME} help theme`,
    summary: "Design and validate a complete Espalier light/dark theme pair.",
  }),
  Object.freeze({
    name: "appearance",
    usage: `${CLI_BINARY_NAME} help appearance`,
    summary: "Map site presentation decisions to theme-push workspace fields.",
  }),
  Object.freeze({
    name: "footer",
    usage: `${CLI_BINARY_NAME} help footer`,
    summary: "Author and concurrency-safely push the complete footer document.",
  }),
  Object.freeze({
    name: "fixture",
    usage: `${CLI_BINARY_NAME} help fixture`,
    summary: "State the offline fixture manifest contract and locate the shipped example.",
  }),
]);

const WORKFLOW_REFERENCES = Object.freeze({
  nav: Object.freeze({
    title: "Navigation workspace contract",
    summary: "nav push replaces the complete tree in nav.json; item IDs are author-minted canonical lowercase UUIDs.",
    usage: `${CLI_BINARY_NAME} nav push`,
    details: Object.freeze([
      "nav.json is { siteId, navItems }, not a bare array.",
      "kind is NAV_ITEM_KIND_PAGE, NAV_ITEM_KIND_EXTERNAL_URL, or NAV_ITEM_KIND_GROUP_HEADER.",
      "PAGE uses resourceId from .taproot-site-manifest.json, never pageId or path.",
      "EXTERNAL_URL uses externalUrl; GROUP_HEADER has no target; every kind may carry children.",
      "externalUrl is an absolute credential-free http/https URL, or a mailto:/tel: contact URL such as "
      + "tel:+15555550123, published exactly as authored.",
    ]),
    example: Object.freeze({
      siteId: "<site-uuid>",
      navItems: Object.freeze([Object.freeze({
        id: "<author-minted-lowercase-uuid>",
        kind: "NAV_ITEM_KIND_PAGE",
        title: "Classes",
        resourceId: "<resourceId-from-manifest>",
        children: Object.freeze([]),
      })]),
    }),
  }),
  redirects: Object.freeze({
    title: "Redirect map workspace contract",
    summary:
      `${REDIRECTS_FILE_NAME} is the site's whole redirect map. 'redirects push' replaces it, fenced by the `
      + "revision 'redirects pull' recorded, so a stale write is refused rather than deleting an entry a page "
      + "rename added.",
    usage: `${CLI_BINARY_NAME} redirects pull | ${CLI_BINARY_NAME} redirects push`,
    details: Object.freeze([
      `${REDIRECTS_FILE_NAME} is { siteId, revision, entries }, not a bare array. 'redirects pull' writes it and `
      + "records the revision in .taproot-site-manifest.json; 'pull' writes it too.",
      "An entry is { path, kind, target, status }. kind is 'redirect' (the default) or 'gone'; a gone entry "
      + `carries no target and serves ${GONE_STATUS}.`,
      `status defaults to ${DEFAULT_REDIRECT_STATUS} and accepts ${REDIRECT_STATUSES.join(", ")}. A migration `
      + `wants ${DEFAULT_REDIRECT_STATUS}: it is what tells search engines the old URL has moved for good.`,
      "path is normalized exactly as the published-site edge normalizes a request: a leading slash is added, "
      + "trailing slashes are stripped, and nothing else changes — so a legacy source keeps its suffix and "
      + "'/faqs.html' is a real, representable path. It carries no query string, fragment, or host.",
      "Write a path — and the path part of a site-relative target — in the percent-encoded spelling a browser "
      + "sends ('/caf%C3%A9', '/old%20page'), never the raw one: the edge keys on the encoded pathname, so a raw "
      + "space or non-ASCII character is stored under a key no request matches, and a raw target beside an "
      + "encoded source is the self-loop loop detection cannot see.",
      "target is a site-relative path such as '/classes', or an absolute credential-free http(s) URL. A "
      + "site-relative target keeps its trailing slash: it is a Location a browser follows, not a route key.",
      "A path, or the path part of a site-relative target, is refused when any segment is '.' or '..', when two "
      + "slashes run together, or when a dot or slash is percent-encoded ('%2e', '%2f'); a target's query string "
      + "may carry any of those. The edge and the generator resolve "
      + "those away, so '/x/../visit' would be checked as itself and served as '/visit' — past the occupancy, "
      + "chain, and loop rules that were asked about a different path. Write the resolved path instead.",
      "origin is reported by the site and ignored on push: 'authored' is what you declared, 'path_history' is "
      + "what a page or tag rename recorded. Pull the map, edit it, push the whole thing back — an entry you "
      + "did not change keeps its origin.",
      "Refused, offline and again at the site, each naming the entry index: a chain (a target that is itself a "
      + "source in the same map); a loop (an entry targeting itself); a duplicate path; a gone entry carrying a "
      + "target; and a status outside the allowed set. A chain or loop is judged on the target's path alone, so "
      + "'/b?x=1' and '/b' are the same destination to it.",
      "Refused by the site, which alone knows what it serves: a path a live page, Docs resource, or generated "
      + "resource already occupies. '/' is such a path while the site's home page is served there — and a "
      + "usable source once the home page has moved, which is the entry a home-page rename records.",
      `Bounded: at most ${REDIRECT_LIMITS.entries} entries, ${REDIRECT_LIMITS.pathBytes} bytes of path, and `
      + `${REDIRECT_LIMITS.targetBytes} bytes of target, matching the edge's own key and value limits.`,
      `The ${REDIRECT_LIMITS.pathBytes}-byte path bound governs what you declare, not what the site already `
      + "holds. A page may sit at a longer path, and renaming it records a path_history entry there that "
      + "'redirects pull' returns; such an entry passes 'validate' and pushes back unchanged. The site is the "
      + "authority on that — it alone knows whether a push introduces the path or carries it back — so a push "
      + "that lengthens or changes one is still refused there.",
      `The ${REDIRECT_LIMITS.entries}-entry bound is scoped the same way: a pulled map already holding more `
      + "than that validates and pushes back unchanged, and only a document holding more entries than both the "
      + "bound and the count the last pull recorded is refused — so accumulated path history never has to be "
      + "deleted to make a push land.",
      "A push whose recorded revision predates a page rename is refused as redirects.concurrent_modification. "
      + `Run 'redirects pull', reconcile ${REDIRECTS_FILE_NAME}, and retry; nothing was written.`,
      "Converting an engagement's CSV into this file is the agent's job. The CLI's contract is JSON, on "
      + "purpose: a real migration list needs judgement about which old URLs still deserve a destination and "
      + "which are simply gone.",
      "Entries take effect on the next deploy, staging first. They are written to the edge's key-value store "
      + "when the deploy syncs routing, and that store is eventually consistent, so a spot-check run "
      + "immediately afterwards can briefly still see the previous map. Re-check before concluding an entry "
      + "did not land.",
    ]),
    example: Object.freeze({
      siteId: "<site-uuid>",
      revision: "<revision-recorded-by-redirects-pull>",
      entries: Object.freeze([
        Object.freeze({ path: "/faqs.html", kind: "redirect", target: "/faq", status: 301 }),
        Object.freeze({ path: "/old-blog", kind: "redirect", target: "/journal", status: 301 }),
        Object.freeze({
          path: "/book",
          kind: "redirect",
          target: "https://booking.example.test/riverbend",
          status: 302,
        }),
        Object.freeze({ path: "/summer-2019-retreat.html", kind: "gone" }),
      ]),
    }),
  }),
  media: Object.freeze({
    title: "Media upload contract",
    summary: "Upload workspace-root-relative raster files and receive component-ready media objects.",
    usage: `${CLI_BINARY_NAME} media upload [path...]`,
    details: Object.freeze([
      "Paths are relative to the configured workspace root, not the shell's current directory.",
      "PNG, JPEG, GIF, and WebP are accepted; retina names such as logo@2x.png and logo@3x.png are supported.",
      "Each result item includes media: { imageId, src, urls, width, height, alt }.",
      "The same src/urls delivery fields are saved in .taproot-site-media.json for page and component authoring.",
    ]),
    example: Object.freeze({
      command: `${CLI_BINARY_NAME} media upload media/logo@2x.png`,
      componentMedia: Object.freeze({
        imageId: "<image-uuid>",
        src: "<preferred-delivery-url>",
        urls: Object.freeze([Object.freeze({ minWidth: 640, url: "<responsive-delivery-url>" })]),
        width: 1200,
        height: 800,
        alt: "",
      }),
    }),
  }),
  preview: Object.freeze({
    title: "Authoring preview workflow",
    summary: "Render one persisted draft behind the normal staging gate.",
    usage: `${CLI_BINARY_NAME} preview page <page-path-or-id>`,
    details: Object.freeze([
      "A page path resolves through .taproot-site-manifest.json; a canonical page UUID works directly.",
      "The homepage's manifest path is empty; address it as '/', which resolves to that empty root path.",
      "Preview before approving: approve consumes the draft, so an approved page has no draft left to render and answers preview.no_draft. Review it on staging after a deploy instead.",
      "Creation prints pageId, snapshotId, and expiresAt before the bounded render wait starts.",
      "The default stored-preview cap is 10 per authoring key and site; operators can tune it.",
      "Success returns READY with url, snapshotId, expiresAt, storedPreviewCap, storedPreviewCount, and evictedPreviews.",
      "The url is a single-use handoff that expires two minutes after it is minted: opening it consumes it, and a reused, shared, or bookmarked URL answers Not found. Run preview page again for another.",
      "At the configured cap, creation revokes the oldest snapshot for the same page first, then the oldest snapshot held by the same key.",
      `A stalled preview can be released with ${CLI_BINARY_NAME} preview revoke <page-id> <snapshot-id>.`,
    ]),
    example: Object.freeze({ command: `${CLI_BINARY_NAME} preview page classes` }),
  }),
  fixture: Object.freeze({
    title: "Offline fixture manifest contract",
    summary:
      `${FIXTURE_MANIFEST_FILE_NAME} binds a directory laid out like a pulled workspace to deterministic identities, `
      + "so validate can prove it with no credential, no network, and no write.",
    usage: `${CLI_BINARY_NAME} validate <fixture-directory>`,
    details: Object.freeze([
      `Required root fields: ${FIXTURE_REQUIRED_ROOT_FIELDS.join(", ")}.`,
      `Accepted and not read: ${FIXTURE_OPTIONAL_ROOT_FIELDS.join(", ")} — pull writes them, and neither the snapshot `
      + "time nor a recorded deployment can be checked offline. Any other root field is refused.",
      `manifestVersion must be ${MANIFEST_VERSION}; fixture.contractVersion must be ${FIXTURE_CONTRACT_VERSION}.`,
      "siteId, every pageId and resourceId, every settings entityId, and every fixture.imageIds entry is a canonical "
      + "lowercase UUID. They are deterministic fixture identities, not identities from a live site.",
      `Each pages[] entry binds one editable free-form source: pageId, resourceId, path, title, templateType `
      + `${TEMPLATE_TYPE_FREE_FORM}, file, sourceFormat, and workspaceMode ${PAGE_WORKSPACE_MODE_EDITABLE}. `
      + "status, hasDraft, isGenerated, and description are recorded by pull and not read: the page key set "
      + "stays open so a fixture from a newer pull is not refused. The homepage's path is the empty string.",
      `file lives under '${PAGES_DIRECTORY}/' and ends in ${PAGE_SOURCE_EXTENSIONS.join(" or ")}; sourceFormat must be `
      + `the format that extension implies (${
        PAGE_SOURCE_EXTENSIONS.map((extension) => `${extension} is '${pageSourceFormat(`page${extension}`)}'`).join(
          ", ",
        )
      }).`,
      "No two page entries share a pageId, resourceId, file, or path; every declared source must exist; every "
      + `source under '${PAGES_DIRECTORY}/' must be declared; and each entry's path must equal the path its source `
      + "declares — a Markdown source's front-matter 'path:' wins, and the entry's value applies only when the "
      + "front matter omits it.",
      "pages must declare at least one entry, pagesTruncated must be false, and settingsSkipped must be empty: a "
      + "partial snapshot is not a fixture.",
      `navigation binds { file: "${NAVIGATION_FILE_NAME}", items }, and items must equal the tree's own item count.`,
      `redirects binds { file: "${REDIRECTS_FILE_NAME}", revision, entries }, and entries must equal the map's own `
      + "entry count. The revision is a deterministic 64-character lowercase hex placeholder, like every other "
      + "identity in a fixture: it proves the shape, never a live read. No redirect source may be a page in the "
      + `same fixture. See '${CLI_BINARY_NAME} help redirects' for the entry contract.`,
      `settings binds all ${SETTINGS_GROUPS.length} authorable groups, each with settingsType, file, and entityId: ${
        SETTINGS_GROUPS.map((group) => `${group.settingsType} to '${SETTINGS_DIRECTORY}/${group.file}'`).join("; ")
      }.`,
      `The fixture block carries ${FIXTURE_METADATA_FIELDS.join(", ")}. Every image a page references by imageId must `
      + "be listed in fixture.imageIds, and every absolute delivery URL a page uses must sit on a declared origin.",
      `Each deliveryOrigins entry is an origin-only HTTPS URL (no path, query, fragment, or credentials) on `
      + `${FIXTURE_DELIVERY_ORIGIN_DOMAIN} or a subdomain of it, at most ${FIXTURE_MAXIMUM_DELIVERY_ORIGINS} of them, `
      + "with no duplicates. Fixtures are copied and shipped, so a real delivery host in one would be a live "
      + "reference in every copy.",
      "validate reads the fixture and writes nothing to it. Copy the directory somewhere writable before editing it.",
    ]),
  }),
});

// The box, rather than the value, is the cache: an absent fixture memoizes
// `undefined` instead of being re-read on every call.
let shippedFixtureManifestCache;

/**
 * The shipped fixture's own manifest, read on demand and memoized, or
 * `undefined` when this copy of the package has no readable `examples/`.
 *
 * The read is lazy because `examples/` ships but is not load-bearing. This
 * module sits on the path of every verb (`bin/taproot-site.js` imports
 * `src/cli.js`, which imports this) and of every library consumer through
 * `src/index.js`, while `examples/` is exactly what a `node_modules` pruner or
 * an image-slimming step drops. A static import would turn such a pruned
 * install into an `ERR_MODULE_NOT_FOUND` at module load for `login`, `pull`,
 * `push`, and every other verb; reading here degrades `help fixture` alone.
 */
function shippedFixtureManifest() {
  shippedFixtureManifestCache ??= { value: readShippedFixtureManifest() };
  return shippedFixtureManifestCache.value;
}

function readShippedFixtureManifest() {
  try {
    return JSON.parse(readFileSync(
      new URL(`../examples/${SHIPPED_FIXTURE_NAME}/${FIXTURE_MANIFEST_FILE_NAME}`, import.meta.url),
      "utf8",
    ));
  } catch {
    // Missing, unreadable, or not JSON. The contract the topic states is
    // derived from constants and stays complete without an example, so
    // `help fixture` answers rather than fails.
    return undefined;
  }
}

export function getWorkflowReference(topic) {
  const reference = WORKFLOW_REFERENCES[topic];
  if (topic !== "fixture") return reference;
  const example = shippedFixtureManifest();
  // The directory is resolved from this package rather than from the caller's
  // directory, so the path is right for a global install as well as a
  // checkout. Both it and the example are reported only when the fixture is
  // actually present: a pruned install has nothing to locate or to validate.
  return example === undefined
    ? reference
    : Object.freeze({ ...reference, fixtureDirectory: shippedFixtureDirectory(), example });
}

function componentSummary(type) {
  const definition = getComponentDefinition(type);
  return {
    type,
    displayName: definition.displayName,
    summary: definition.summary,
    helpCommand: `${CLI_BINARY_NAME} help component ${type}`,
  };
}

export function listComponentTypeReferences() {
  return COMPONENT_TYPES.map(componentSummary);
}

export function getComponentReference(type) {
  const definition = getComponentDefinition(type);
  if (!definition) return undefined;
  const example = definition.example;
  const markdownExample = `\`\`\`component:${type}\n${JSON.stringify(example, null, 2)}\n\`\`\``;
  return {
    type,
    displayName: definition.displayName,
    summary: definition.summary,
    dataEncoding:
      "componentData is a JSON string containing an object; do not place an object directly in the attribute.",
    componentDataMaxUtf8Bytes: CONTENT_LIMITS.componentDataBytes,
    additionalProperties: false,
    properties: getComponentPropertyReference(type),
    editorInitialData: definition.defaultData,
    accessibility: definition.accessibility,
    example,
    markdownExample,
    componentBlockExample: {
      type: "componentBlock",
      attrs: {
        componentType: type,
        componentData: canonicalizeComponentData(type, example),
      },
    },
  };
}

function registryFieldReference(name, definition) {
  return Object.freeze({
    name,
    type: definition.type,
    required: definition.required,
    ...(Object.hasOwn(definition, "default") ? { default: definition.default } : {}),
    ...(definition.nullable === true ? { nullable: true } : {}),
    ...(definition.values ? { values: [...definition.values] } : {}),
    ...(definition.pattern ? { pattern: definition.pattern } : {}),
    ...(definition.maximumLength ? { maximumLength: definition.maximumLength } : {}),
    ...(definition.minimum !== undefined ? { minimum: definition.minimum } : {}),
    ...(definition.maximum !== undefined ? { maximum: definition.maximum } : {}),
    ...(definition.minItems !== undefined ? { minItems: definition.minItems } : {}),
    ...(definition.maxItems !== undefined ? { maxItems: definition.maxItems } : {}),
    ...(definition.minScalars !== undefined ? { minScalars: definition.minScalars } : {}),
    ...(definition.maxScalars !== undefined ? { maxScalars: definition.maxScalars } : {}),
    ...(definition.nonWhitespace === true ? { nonWhitespace: true } : {}),
    ...(definition.schemes ? { schemes: [...definition.schemes] } : {}),
    ...(definition.closed === true ? { additionalProperties: false } : {}),
    ...(definition.closedItems === true ? { itemAdditionalProperties: false } : {}),
    ...(definition.opacityByValue ? { opacityByValue: { ...definition.opacityByValue } } : {}),
    ...(definition.urls
      ? {
        responsiveUrls: Object.freeze({
          minItems: definition.urls.minItems,
          maxItems: definition.urls.maxItems,
          itemAdditionalProperties: !definition.urls.closedItems,
          fields: Object.freeze(Object.entries(definition.urls.fields).map(([fieldName, field]) =>
            registryFieldReference(fieldName, field)
          )),
        }),
      }
      : {}),
    ...(definition.srcMustMatchUrls === true ? { srcMustMatchUrls: true } : {}),
    ...(definition.fields
      ? {
        fields: Object.freeze(Object.entries(definition.fields).map(([fieldName, field]) => Object.freeze({
          ...registryFieldReference(fieldName, field),
          ...(field.requiredKeys ? { requiredKeys: [...field.requiredKeys] } : {}),
          ...(field.optionalKeys ? { optionalKeys: [...field.optionalKeys] } : {}),
          ...(field.tokenByValue ? { tokenByValue: { ...field.tokenByValue } } : {}),
        }))),
      }
      : {}),
  });
}

function sectionAttributeReference() {
  return Object.entries(FREE_FORM_SECTION_REGISTRY.section.attrs).map(([name, definition]) => Object.freeze({
    ...registryFieldReference(name, definition),
    label: definition.label,
    help: definition.help,
  }));
}

const SECTION_IMAGE_EXAMPLE = Object.freeze({
  imageId: "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607",
  src: "https://static.example.test/site/img/riverbend-class-1280.webp",
  urls: Object.freeze([
    Object.freeze({ minWidth: 640, url: "https://static.example.test/site/img/riverbend-class-640.webp" }),
    Object.freeze({ minWidth: 1280, url: "https://static.example.test/site/img/riverbend-class-1280.webp" }),
  ]),
  width: 1920,
  height: 1080,
  alt: "A welcoming hot yoga class at Riverbend Wellness",
});
const SECTION_PORTRAIT_IMAGE_EXAMPLE = Object.freeze({
  imageId: "9a8b7c6d-5e4f-4321-a098-76543210fedc",
  src: "https://static.example.test/site/img/riverbend-class-portrait-480.webp",
  urls: Object.freeze([
    Object.freeze({ minWidth: 480, url: "https://static.example.test/site/img/riverbend-class-portrait-480.webp" }),
  ]),
  width: 900,
  height: 1200,
  alt: "A welcoming hot yoga class at Riverbend Wellness",
});
const BACKGROUND_DEFINITION = FREE_FORM_SECTION_REGISTRY.section.attrs.background;
const BACKGROUND_EXAMPLE = Object.freeze({
  image: SECTION_IMAGE_EXAMPLE,
  portraitImage: SECTION_PORTRAIT_IMAGE_EXAMPLE,
  focus: Object.freeze({ x: 0.56, y: 0.42 }),
  portraitFocus: Object.freeze({ x: 0.5, y: 0.32 }),
  scrimStrength: "medium",
});

function backgroundReference() {
  return Object.freeze({
    additionalProperties: false,
    fields: sectionAttributeReference().find((attr) => attr.name === "background").fields,
    defaults: Object.freeze({
      portraitImage: BACKGROUND_DEFINITION.fields.portraitImage.default,
      focus: Object.freeze({ ...BACKGROUND_DEFINITION.fields.focus.default }),
      portraitFocus: BACKGROUND_DEFINITION.fields.portraitFocus.default,
      scrimStrength: BACKGROUND_DEFINITION.fields.scrimStrength.default,
    }),
    scrimOpacityByValue: Object.freeze({ ...BACKGROUND_DEFINITION.fields.scrimStrength.opacityByValue }),
    deliveryUrlPolicy:
      "Use complete site-owned processed-image results for image and portraitImage. src and every urls[].url must be HTTPS or non-protocol-relative root-relative delivery URLs; credentials, whitespace, controls, and backslashes are rejected.",
    compactBehavior:
      "At the shared compact breakpoint, portraitImage and portraitFocus replace the landscape image and focus when supplied.",
    example: BACKGROUND_EXAMPLE,
    markdownExample: `:::section ${JSON.stringify({ background: BACKGROUND_EXAMPLE })}\n## Practice with us\n\nFind your next class.\n:::`,
  });
}

const DECORATION_DEFINITION = FREE_FORM_SECTION_REGISTRY.section.attrs.decoration;
const DECORATION_EXAMPLE = Object.freeze({
  image: Object.freeze({
    imageId: "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607",
    src: "https://static.example.test/site/img/starburst-640.webp",
    urls: Object.freeze([
      Object.freeze({ minWidth: 640, url: "https://static.example.test/site/img/starburst-640.webp" }),
    ]),
    width: 1200,
    height: 1200,
    alt: "",
  }),
  anchor: "top-end",
  inlineOffsetPercent: 18,
  blockOffsetPercent: -12,
  inlineSizePercent: 62,
  opacity: 0.09,
  tint: "heading",
});

function decorationReference() {
  return Object.freeze({
    additionalProperties: false,
    fields: sectionAttributeReference().find((attr) => attr.name === "decoration").fields,
    deliveryUrlPolicy:
      "Use the complete site-owned processed-image result from media upload. src and every urls[].url must be HTTPS or non-protocol-relative root-relative delivery URLs; credentials, whitespace, controls, and backslashes are rejected.",
    tintTokens: Object.freeze({ ...DECORATION_DEFINITION.fields.tint.tokenByValue }),
    example: DECORATION_EXAMPLE,
    markdownExample: `:::section ${JSON.stringify({ decoration: DECORATION_EXAMPLE })}\n## Rooted in warmth\n\nMove with confidence.\n:::`,
    maskGuidance:
      "Use a transparent PNG or WebP whose alpha channel contains only the mark. The active section context supplies the tint in both schemes.",
    opaqueWarning:
      "An opaque rectangle uses its whole alpha channel and will render as a tinted rectangle, not as a cut-out mark.",
  });
}

const INLINE_FACTS_DEFINITION = FREE_FORM_SECTION_REGISTRY.inlineFacts;
// The third fact carries no label on purpose: a phone number names itself, and
// the row is allowed to mix labelled and standalone facts.
const INLINE_FACT_ITEMS_EXAMPLE = Object.freeze([
  Object.freeze({ value: "4.9 ★", label: "Community rating" }),
  Object.freeze({
    value: "100 Riverside Way, Suite A",
    label: "Elm Harbor",
    url: "https://maps.example.test/?q=100%20Riverside%20Way%20Elm%20Harbor",
  }),
  Object.freeze({ value: "(555) 013-7788", url: "tel:+15550137788" }),
  Object.freeze({ value: "Open today until 8:30 PM", label: "Today's hours", url: "/classes" }),
]);

function inlineFactsReference() {
  const items = INLINE_FACTS_DEFINITION.attrs.items;
  const proseMirror = Object.freeze({
    type: INLINE_FACTS_DEFINITION.nodeType,
    attrs: Object.freeze({ items: INLINE_FACT_ITEMS_EXAMPLE }),
  });
  return Object.freeze({
    nodeType: INLINE_FACTS_DEFINITION.nodeType,
    label: INLINE_FACTS_DEFINITION.label,
    help: INLINE_FACTS_DEFINITION.help,
    additionalProperties: false,
    attrs: Object.freeze({
      items: Object.freeze({
        ...registryFieldReference("items", items),
        itemFieldOrder: Object.freeze(Object.keys(items.fields)),
      }),
    }),
    placement: Object.freeze({ ...INLINE_FACTS_DEFINITION.placement }),
    valuePolicy:
      `Required non-whitespace plain text; maximum ${items.fields.value.maxScalars} Unicode scalar values.`,
    labelPolicy:
      `Optional non-whitespace plain text; maximum ${items.fields.label.maxScalars} Unicode scalar values. `
      + "Omit it when the value already names itself, such as a rating, an address, or a phone number; a row may "
      + "mix labelled and standalone facts. An empty string is rejected, so omitting a label stays explicit.",
    urlPolicy:
      "Optional safe HTTP(S), mailto, tel, non-protocol-relative root, fragment, query, or relative URL. Empty/whitespace-only values, other schemes, backslashes, and ASCII controls are rejected; tel: remains a native link.",
    markdown: Object.freeze({
      fence: INLINE_FACTS_DEFINITION.markdown.fence,
      body: INLINE_FACTS_DEFINITION.markdown.body,
      example: `\`\`\`${INLINE_FACTS_DEFINITION.markdown.fence}\n${JSON.stringify(INLINE_FACT_ITEMS_EXAMPLE, null, 2)}\n\`\`\``,
    }),
    examples: Object.freeze({ items: INLINE_FACT_ITEMS_EXAMPLE, proseMirror }),
  });
}

function placementMatrix() {
  const nodes = Object.entries(FREE_FORM_SECTION_REGISTRY.rootNodes).map(([type, definition]) => {
    const explicit = definition.placement === "explicit-band";
    return Object.freeze({
      kind: "node",
      type,
      label: definition.label,
      rootPlacement: definition.placement,
      fullBleed: explicit,
      contentPadding: explicit ? "standard by default; section may choose none" : "implicit section: standard",
      well: explicit ? "shared site well by default; none removes the cap" : "shared site well",
      measure: type === FREE_FORM_SECTION_REGISTRY.section.nodeType ? "child-defined" : definition.measure,
    });
  });
  const components = Object.entries(FREE_FORM_SECTION_REGISTRY.components).map(([type, definition]) => {
    const rootBand = definition.rootPlacement === "root-band";
    return Object.freeze({
      kind: "component",
      type,
      label: definition.label,
      rootPlacement: definition.rootPlacement,
      fullBleed: rootBand,
      contentPadding: rootBand ? "component-owned" : "implicit section: standard",
      well: rootBand ? "none at root" : "shared site well",
      measure: definition.measure,
    });
  });
  return Object.freeze([...nodes, ...components]);
}

const TABLE_DEFINITION = FREE_FORM_SECTION_REGISTRY.table;
const RATE_TABLE_EXAMPLE = "Table: Drop-in rates\n"
  + "| Plan | Rate | Details |\n"
  + "| --- | --- | --- |\n"
  + "| Single class | **$24** | [Book now](/classes) |\n"
  + "| Five-pack | $100 | Save $20 \\| valid for 90 days |";
const COMPARISON_TABLE_EXAMPLE = "Feature | Starter | Studio\n"
  + "--- | --- | ---\n"
  + "Classes | 4 / month | **Unlimited**\n"
  + "Support | [Email](/support) | Email \\| phone";
const ALIGNMENT_TABLE_EXAMPLE = "| Feature | Price |\n| :--- | ---: |\n| Class | $24 |";
const TABLE_JSON_EXAMPLE = Object.freeze({
  type: TABLE_DEFINITION.nodeTypes.table,
  attrs: Object.freeze({ caption: "Drop-in rates" }),
  content: Object.freeze([
    Object.freeze({
      type: TABLE_DEFINITION.nodeTypes.row,
      content: Object.freeze([
        Object.freeze({
          type: TABLE_DEFINITION.nodeTypes.header,
          content: Object.freeze([Object.freeze({
            type: "paragraph",
            content: Object.freeze([Object.freeze({ type: "text", text: "Plan" })]),
          })]),
        }),
        Object.freeze({
          type: TABLE_DEFINITION.nodeTypes.header,
          content: Object.freeze([Object.freeze({
            type: "paragraph",
            content: Object.freeze([Object.freeze({ type: "text", text: "Rate" })]),
          })]),
        }),
      ]),
    }),
    Object.freeze({
      type: TABLE_DEFINITION.nodeTypes.row,
      content: Object.freeze([
        Object.freeze({
          type: TABLE_DEFINITION.nodeTypes.cell,
          content: Object.freeze([Object.freeze({
            type: "paragraph",
            content: Object.freeze([Object.freeze({ type: "text", text: "Single class" })]),
          })]),
        }),
        Object.freeze({
          type: TABLE_DEFINITION.nodeTypes.cell,
          content: Object.freeze([Object.freeze({
            type: "paragraph",
            content: Object.freeze([Object.freeze({ type: "text", text: "$24" })]),
          })]),
        }),
      ]),
    }),
  ]),
});

function tableReference() {
  return Object.freeze({
    nodeTypes: Object.freeze({ ...TABLE_DEFINITION.nodeTypes }),
    attrs: Object.freeze({
      caption: Object.freeze({ ...TABLE_DEFINITION.attrs.caption }),
    }),
    structure: Object.freeze({
      headerRows: TABLE_DEFINITION.rows.header,
      headerCellType: TABLE_DEFINITION.nodeTypes.header,
      dataCellType: TABLE_DEFINITION.nodeTypes.cell,
      paragraphChildrenPerCell: TABLE_DEFINITION.cells.paragraphs,
      paragraphAttrsSupported: TABLE_DEFINITION.cells.paragraphAttrs,
      inlineNodes: Object.freeze([...TABLE_DEFINITION.cells.inlineNodes]),
      marks: Object.freeze([...TABLE_DEFINITION.cells.marks]),
      headerMustContainNonWhitespace: TABLE_DEFINITION.cells.headerNonWhitespace,
      spansSupported: TABLE_DEFINITION.cells.spans,
      unsupportedSpanAttrs: Object.freeze([...TABLE_DEFINITION.cells.spanAttrs]),
    }),
    limits: Object.freeze({
      captionScalars: Object.freeze({
        min: TABLE_DEFINITION.attrs.caption.minScalars,
        max: TABLE_DEFINITION.attrs.caption.maxScalars,
        unit: "Unicode scalar values",
        nonWhitespace: true,
      }),
      dataRows: Object.freeze({ min: TABLE_DEFINITION.rows.minData, max: TABLE_DEFINITION.rows.maxData }),
      columns: Object.freeze({
        min: TABLE_DEFINITION.columns.min,
        max: TABLE_DEFINITION.columns.max,
        everyRowMatchesHeader: !TABLE_DEFINITION.columns.ragged,
      }),
      cellTextScalars: Object.freeze({
        max: TABLE_DEFINITION.cells.maxTextScalars,
        unit: "Unicode scalar values across text descendants; marks and hard breaks add zero",
      }),
    }),
    placement: Object.freeze({ ...TABLE_DEFINITION.placement }),
    captionGuidance:
      "Use a caption when surrounding prose does not already name the table; omit it when an immediately preceding heading already names the table.",
    markdown: Object.freeze({
      captionSyntax: `${TABLE_DEFINITION.markdown.captionPrefix}Caption text`,
      captionMustImmediatelyPrecedeHeader: TABLE_DEFINITION.markdown.captionImmediate,
      outerPipes: TABLE_DEFINITION.markdown.outerPipes,
      literalPipeEscape: TABLE_DEFINITION.markdown.literalPipeEscape,
      delimiter: `one or more hyphens per column (minimum ${TABLE_DEFINITION.markdown.delimiterMinHyphens}); no other text`,
      alignment: TABLE_DEFINITION.markdown.alignment,
      blankLineTerminates: TABLE_DEFINITION.markdown.blankLineTerminates,
    }),
    examples: Object.freeze({
      rateTable: RATE_TABLE_EXAMPLE,
      comparisonTable: COMPARISON_TABLE_EXAMPLE,
      rejectedAlignment: ALIGNMENT_TABLE_EXAMPLE,
      proseMirror: TABLE_JSON_EXAMPLE,
    }),
    corrections: Object.freeze([
      Object.freeze({
        code: CONTENT_ERROR_CODES.childNotAllowed,
        correction: "Move a table to the document root or directly into a top-level section; cells contain a paragraph, never another block.",
      }),
      Object.freeze({
        code: CONTENT_ERROR_CODES.attrUnknown,
        correction: "Keep only the optional caption attribute on table; tableRow, tableHeader, and tableCell have no attributes or appearance controls.",
      }),
      Object.freeze({
        code: CONTENT_ERROR_CODES.tableHeader,
        correction: "Put exactly one tableRow first, use only tableHeader cells in it, and give every header non-whitespace text.",
      }),
      Object.freeze({
        code: CONTENT_ERROR_CODES.tableShape,
        correction: "Use tableRow children, tableHeader only in the first row, tableCell after it, and keep tables at root or directly in a section.",
      }),
      Object.freeze({
        code: CONTENT_ERROR_CODES.tableRagged,
        correction: "Add or remove cells so the delimiter and every data row have exactly the header row's column count.",
      }),
      Object.freeze({
        code: CONTENT_ERROR_CODES.tableBounds,
        correction: `Use ${TABLE_DEFINITION.rows.minData}-${TABLE_DEFINITION.rows.maxData} data rows, ${TABLE_DEFINITION.columns.min}-${TABLE_DEFINITION.columns.max} columns, captions up to ${TABLE_DEFINITION.attrs.caption.maxScalars} scalars, and cells up to ${TABLE_DEFINITION.cells.maxTextScalars} text scalars.`,
      }),
      Object.freeze({
        code: CONTENT_ERROR_CODES.tableCellContent,
        correction: "Give every tableHeader and tableCell exactly one paragraph containing only text, hardBreak, and the supported marks/links.",
      }),
      Object.freeze({
        code: CONTENT_ERROR_CODES.tableSpan,
        correction: "Remove colspan, rowspan, and colwidth; express every column with one explicit cell in every row.",
      }),
      Object.freeze({
        code: CONTENT_ERROR_CODES.markdownTable,
        correction: "Use a pipe header, a matching hyphen-only delimiter, at least one data row, and a blank line before the next block.",
      }),
      Object.freeze({
        code: CONTENT_ERROR_CODES.markdownTableAlignment,
        correction: "Remove alignment colons from delimiter cells; alignment is not part of this contract.",
      }),
    ]),
  });
}

const TABLE_REFERENCE = tableReference();
const INLINE_FACTS_REFERENCE = inlineFactsReference();
const BACKGROUND_REFERENCE = backgroundReference();

const FREE_FORM_REFERENCE = Object.freeze({
  type: "free-form",
  displayName: "Free-form page",
  summary: "A page whose body is authored as validated ProseMirror, directly or through the supported Markdown subset.",
  workspace: Object.freeze({
    directory: "pages/",
    sourceRule: Object.freeze({
      rule:
        "One page path has exactly one authoritative editable source. The manifest records its file and sourceFormat.",
      manifestFields: Object.freeze(["file", "sourceFormat", "baseline"]),
      pull:
        "pull keeps a tracked source that is still on disk and never writes a second editable file for the same page.",
      internalState:
        `${INTERNAL_PAGE_BASELINE_DIRECTORY}/<pageId>.pm.json holds the site's document for a page tracked as Markdown, `
        + "and <pageId>.revision.json beside it records the revision a refused pull already showed you — which is what "
        + "lets the refusal's own recovery push proceed. Both are internal state: never discovered as a page source "
        + "and never pushed, and a pull that reconciles the page rewrites or removes them, so they are safe to ignore "
        + "in version control.",
      formatChange:
        "Remove the tracked source, then author the other format beside it. Two editable sources for one path is a "
        + "refusal, not a guess.",
      formatChangeError: "pages.path_conflict",
      renamedSource:
        "A tracked source renamed onto the workspace file another page falls back to leaves that page nowhere to be "
        + "written. Rename or remove it, then pull again.",
      renamedSourceError: "pages.source_conflict",
      conflict:
        "Markdown is one-way, so a page edited on the site since the last pull cannot be rewritten as Markdown. pull "
        + "refuses before changing anything under pages/ and preserves the site's version as internal state. A "
        + "locally edited .pm.json is kept rather than overwritten, and only collides when the site changed too.",
      conflictError: "pages.pull_conflict",
      conflictDetail:
        "A reported conflict names the JSON paths at which the site's document differs from the copy this workspace "
        + "last reconciled with, in error.differences, which carries three states. Absent: the two documents were "
        + "never compared, because this workspace kept no copy of the site's previous version. Empty: they were "
        + "compared and the body is identical, so the change was to the page's title, path, or description. "
        + "Non-empty: the JSON paths at which the body differs.",
      pushConflict:
        "pages push fails closed on a concurrent remote edit: the site reports each page's stored-state revision, the "
        + "workspace records the revision of what it last wrote or pulled, and a push whose target now carries a "
        + "different revision is refused before any page is sent. The refusal carries both revisions in "
        + "error.alternatives, recorded first and live second. The guard is armed once both are known — a page this "
        + "workspace has never reconciled with, or a Taproot that predates the revision contract, leaves it unarmed "
        + "rather than refusing every push. A pull that refuses records the revision it showed you, so the pull "
        + "conflict's own recovery push still goes through; a page that moved again since is refused again.",
      pushConflictError: "pages.push_conflict",
      revisionSource:
        "baseline.revision in the manifest, from bodyRevision on the page read, the page listing, and the create and "
        + "update responses. It is opaque: compare it, never derive or parse it.",
      conflictRecovery:
        "Either push the local source to make the site match it, or delete the local source and pull again to adopt "
        + "the site's document as that page's source.",
      pushSelection:
        "pages push <path> validates the selected page exactly as a whole push would, including every cross-page "
        + "guard that can affect it. It does not convert or validate pages it is not sending; pages push with no "
        + "path is the command that reports every authored page.",
    }),
    formats: Object.freeze([
      Object.freeze({
        extension: ".md",
        purpose: "Author a page as Markdown with YAML-style front matter.",
        metadata: Object.freeze([
          Object.freeze({
            name: "title",
            type: "string",
            requiredForNew: true,
            inheritedForTracked: true,
          }),
          Object.freeze({
            name: "path",
            type: "string",
            requiredForNew: true,
            inheritedForTracked: true,
            description: "Use an empty value for the home page.",
          }),
          Object.freeze({
            name: "description",
            type: "string",
            requiredForNew: false,
            inheritedForTracked: true,
            defaultForNew: "",
          }),
        ]),
      }),
      Object.freeze({
        extension: ".pm.json",
        purpose:
          "Edit a pulled page as a raw ProseMirror document. The page must already have a manifest entry for metadata.",
        metadata: Object.freeze([]),
        metadataSource:
          "Read from .taproot-site-manifest.json at the workspace root; the document file contains only the ProseMirror root.",
      }),
    ]),
    systemPages: Object.freeze([
      Object.freeze({
        path: SYSTEM_PAGE_NOT_FOUND_PATH,
        mode: PAGE_WORKSPACE_MODE_READ_ONLY,
        reason: PAGE_READ_ONLY_REASON_SYSTEM_404,
        projection:
          "pull writes the exact stored ProseMirror body and records its SHA-256 in .taproot-site-manifest.json",
        unchangedPush: "A whole-workspace pages push verifies the hash and skips this file without updating the page.",
        approval:
          "An unscoped approve excludes this projection even when the live system page carries a draft; naming it explicitly is refused.",
        modifiedError: "pages.read_only_modified",
        missingError: "pages.read_only_missing",
        replacementError: "pages.system_page_read_only",
        scopedPushError: "pages.page_read_only",
        scopedApprovalError: "approve.page_read_only",
        guidance:
          "Do not delete, replace, or edit this file. Run pull to restore it; author the system 404 through an owner-controlled surface.",
      }),
    ]),
    systemHome: "The pulled home page remains an ordinary editable page.",
  }),
  document: Object.freeze({
    root: Object.freeze({ type: "doc", content: "array of supported block nodes" }),
    nodes: NODE_TYPES,
    marks: MARK_TYPES,
    componentNode: Object.freeze({
      type: "componentBlock",
      attrs: Object.freeze({
        componentType: "one of the listed component identifiers",
        componentData: "JSON string containing that component's data object",
      }),
    }),
    sectionNode: Object.freeze({
      type: FREE_FORM_SECTION_REGISTRY.section.nodeType,
      label: FREE_FORM_SECTION_REGISTRY.section.label,
      help: FREE_FORM_SECTION_REGISTRY.section.help,
      minimumChildren: FREE_FORM_SECTION_REGISTRY.section.minimumChildren,
      additionalProperties: false,
      attrs: Object.freeze(sectionAttributeReference()),
      content: "one or more ordinary non-section block nodes; sections may not nest",
    }),
    tableNode: TABLE_REFERENCE,
    inlineFactsNode: INLINE_FACTS_REFERENCE,
    rawHtml: Object.freeze({
      default: "rejected",
      trackedProseMirror: Object.freeze({
        format: ".pm.json",
        optIn: `${CLI_BINARY_NAME} pages push --allow-raw-html`,
        behavior: "The flag permits explicit rawHtml nodes only in a tracked ProseMirror document.",
      }),
      markdown: Object.freeze({
        format: ".md",
        supported: false,
        behavior: "Inline HTML remains unsupported and is rejected even when --allow-raw-html is present.",
      }),
      warning: "rawHtml renders verbatim and unsanitized; use it only for trusted hand-written markup.",
    }),
  }),
  sections: Object.freeze({
    markdownSyntax: ":::section {JSON object}\nordinary structured Markdown\n:::",
    example:
      ":::section {\"context\":\"inverted\",\"contentPadding\":\"standard\",\"surface\":\"none\"}\n## A real band\n\nOrdinary structured Markdown remains editable here.\n:::",
    topLevelOnly: true,
    defaults: Object.freeze(Object.fromEntries(
      Object.entries(FREE_FORM_SECTION_REGISTRY.section.attrs).map(([name, definition]) => [name, definition.default]),
    )),
    background: BACKGROUND_REFERENCE,
    decoration: decorationReference(),
    placementMatrix: placementMatrix(),
  }),
  tables: TABLE_REFERENCE,
  inlineFacts: INLINE_FACTS_REFERENCE,
  workflow: Object.freeze([
    Object.freeze({ command: `${CLI_BINARY_NAME} pages push`, result: "Create or update an unapproved draft." }),
    Object.freeze({
      command: `${CLI_BINARY_NAME} approve [page-path...]`,
      result: "Approve drafts and build the staged site.",
    }),
    Object.freeze({
      command: `${CLI_BINARY_NAME} deploy --staging`,
      result: "Deploy the staged build to the staging site.",
    }),
    Object.freeze({
      command: `${CLI_BINARY_NAME} deploy --production`,
      result: "Promote the completed staging deployment to production.",
    }),
  ]),
});

export function listPageTypeReferences() {
  return PAGE_TYPES.map((type) => ({
    type,
    displayName: FREE_FORM_REFERENCE.displayName,
    summary: FREE_FORM_REFERENCE.summary,
    helpCommand: `${CLI_BINARY_NAME} help page ${type}`,
  }));
}

export function getPageTypeReference(type) {
  if (type !== "free-form") return undefined;
  return { ...FREE_FORM_REFERENCE, components: listComponentTypeReferences() };
}

function schemaLabel(schema) {
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (schema.type === "array") return `array<${schemaLabel(schema.items)}>`;
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  if (schema.format) return `${schema.type} (${schema.format})`;
  return schema.type;
}

function schemaConstraints(schema) {
  const constraints = [];
  if (schema.minimum !== undefined) constraints.push(`minimum ${schema.minimum}`);
  if (schema.maximum !== undefined) constraints.push(`maximum ${schema.maximum}`);
  if (schema.maxItems !== undefined) constraints.push(`maximum ${schema.maxItems} items`);
  if (schema.minLength !== undefined) constraints.push(`minimum length ${schema.minLength}`);
  if (schema.maxLength !== undefined) constraints.push(`maximum length ${schema.maxLength}`);
  if (schema.pattern !== undefined) constraints.push(`pattern ${JSON.stringify(schema.pattern)}`);
  if (schema.allowedUnits !== undefined) constraints.push(`allowed units ${schema.allowedUnits.join(", ")}`);
  if (schema.builtInValues !== undefined) constraints.push(`built-ins ${schema.builtInValues.join(", ")}`);
  if (schema.applicationRegistered?.accepted === true) {
    constraints.push(`application-registered names accepted; ${schema.applicationRegistered.requirement}`);
  }
  if (schema.description) constraints.push(schema.description);
  return constraints;
}

function formatSchemaLine(name, schema, required, indent) {
  const constraints = schemaConstraints(schema);
  return `${indent}${name.padEnd(Math.max(1, 28 - indent.length))} ${schemaLabel(schema)}; ${
    required ? "required" : "optional"
  }${constraints.length > 0 ? `; ${constraints.join("; ")}` : ""}`;
}

function nestedSchemaLines(schema, path, indent = "    ") {
  const valueSchema = schema.type === "array" ? schema.items : schema;
  const valuePath = schema.type === "array" ? `${path}[]` : path;
  if (!valueSchema?.properties) return [];

  const lines = [];
  for (const property of valueSchema.properties) {
    const propertyPath = `${valuePath}.${property.name}`;
    lines.push(formatSchemaLine(propertyPath, property.schema, property.required, indent));
    lines.push(...nestedSchemaLines(property.schema, propertyPath, `${indent}  `));
  }
  return lines;
}

function formatComponentProperty(property) {
  const firstLine = `${formatSchemaLine(property.name, property.schema, property.required, "  ")}; ${
    formatOmission(property)
  }`;
  return [firstLine, ...nestedSchemaLines(property.schema, property.name)].join("\n");
}

function formatOmission(property) {
  const initial = property.editorInitial.kind === "value"
    ? `editor initial ${JSON.stringify(property.editorInitial.value)}`
    : "editor initial omitted";
  const omitted = property.whenOmitted.kind === "value"
    ? `when omitted ${JSON.stringify(property.whenOmitted.value)}`
    : property.whenOmitted.kind === "invalid"
    ? "when omitted invalid"
    : property.whenOmitted.kind === "conditional"
    ? `when omitted ${property.whenOmitted.then} if ${property.whenOmitted.condition}, otherwise ${property.whenOmitted.otherwise}`
    : "when omitted unspecified";
  return `${initial}; ${omitted}`;
}

function formatMetadata(field) {
  const requirement = field.requiredForNew
    ? "required for a new page; inherited for a tracked page"
    : `optional; default for a new page ${JSON.stringify(field.defaultForNew)}; inherited for a tracked page`;
  return `  ${field.name.padEnd(20)} ${field.type}; ${requirement}${field.description ? `; ${field.description}` : ""}`;
}

function formatSectionAttr(attr) {
  const type = attr.values ? attr.values.map((value) => JSON.stringify(value)).join(" | ") : attr.type;
  return `  ${attr.name.padEnd(20)} ${type}; default ${JSON.stringify(attr.default)}; ${attr.help}`;
}

function formatRegistryField(field, indent = "  ") {
  if (field.type === "processed-image") {
    return `${indent}${field.name.padEnd(Math.max(1, 20 - indent.length))} processed-image${field.nullable ? " | null" : ""}; ${
      field.required ? "required" : `default ${JSON.stringify(field.default)}`
    }; required keys ${field.requiredKeys.join(", ")}; optional keys ${
      field.optionalKeys.join(", ")
    }; responsive candidates ${field.responsiveUrls.minItems} through ${field.responsiveUrls.maxItems}; minWidth positive integer; optional type ${
      field.responsiveUrls.fields.find((item) => item.name === "type").values.map((value) => JSON.stringify(value)).join(" | ")
    }; src must match one candidate; unlisted keys rejected`;
  }
  const type = field.values ? field.values.map((value) => JSON.stringify(value)).join(" | ") : field.type;
  const bounds = field.minimum === undefined ? "" : `; bounds ${field.minimum} through ${field.maximum}`;
  const itemBounds = field.minItems === undefined ? "" : `; items ${field.minItems} through ${field.maxItems}`;
  const scalarBounds = field.maxScalars === undefined
    ? ""
    : `; ${field.minScalars} through ${field.maxScalars} Unicode scalar values${field.nonWhitespace ? "; non-whitespace" : ""}`;
  const line = `${indent}${field.name.padEnd(Math.max(1, 20 - indent.length))} ${type}${field.nullable ? " | null" : ""}; ${
    field.required ? "required" : `default ${JSON.stringify(field.default)}`
  }${bounds}${itemBounds}${scalarBounds}`;
  return [line, ...(field.fields ?? []).map((child) => formatRegistryField(child, `${indent}  `))].join("\n");
}

function formatPlacement(row) {
  const name = `${row.kind}:${row.type}`;
  return `  ${name.padEnd(29)} ${row.rootPlacement.padEnd(13)} full bleed ${
    row.fullBleed ? "yes" : "no"
  }; ${row.contentPadding}; ${row.well}; measure ${row.measure}`;
}

export function formatReferenceResult(result) {
  switch (result.topic) {
    case "topics":
      return `Usage: ${CLI_BINARY_NAME} help <topic> [name] [--json]\n\nReference topics:\n${
        result.topics.map((topic) => `  ${topic.usage.padEnd(48)} ${topic.summary}`).join("\n")
      }\n\nAdd --json for stable machine-readable output.\n`;
    case "page-types":
      return `Authorable page types:\n${
        result.pageTypes.map((page) =>
          `  ${page.type.padEnd(16)} ${page.summary}\n${" ".repeat(19)}Help: ${page.helpCommand}`
        ).join("\n")
      }\n`;
    case "component-types":
      return `Free-form components:\n${
        result.components.map((component) =>
          `  ${component.type.padEnd(16)} ${component.summary}\n${" ".repeat(19)}Help: ${component.helpCommand}`
        ).join("\n")
      }\n`;
    case "page": {
      const page = result.page;
      const markdownFormat = page.workspace.formats.find((format) => format.extension === ".md");
      const sourceRule = page.workspace.sourceRule;
      return `${page.displayName} (${page.type})\n${page.summary}\n\nWorkspace:\n${
        page.workspace.formats.map((format) => `  ${format.extension.padEnd(9)} ${format.purpose}`).join("\n")
      }\n\nOne source per page:\n  rule                  ${sourceRule.rule}\n  manifest fields       ${
        sourceRule.manifestFields.join(", ")
      }\n  pull                  ${sourceRule.pull}\n  internal state        ${
        sourceRule.internalState
      }\n  format change         ${sourceRule.formatChange} (${sourceRule.formatChangeError})\n  renamed source        ${
        sourceRule.renamedSource
      } (${sourceRule.renamedSourceError})\n  conflicts             ${
        sourceRule.conflict
      } (${sourceRule.conflictError})\n  conflict detail       ${
        sourceRule.conflictDetail
      }\n  push conflicts        ${
        sourceRule.pushConflict
      } (${sourceRule.pushConflictError})\n  revision              ${
        sourceRule.revisionSource
      }\n  recovery              ${
        sourceRule.conflictRecovery
      }\n  push selection        ${sourceRule.pushSelection}\n\nSystem page projections:\n${
        page.workspace.systemPages.map((systemPage) =>
          `  ${systemPage.path.padEnd(9)} ${systemPage.mode}; ${systemPage.projection}.\n${" ".repeat(12)}${systemPage.unchangedPush} ${systemPage.approval}\n${" ".repeat(12)}${systemPage.guidance}`
        ).join("\n")
      }\n  home      editable; ${page.workspace.systemHome}\n\nMarkdown front matter:\n${
        markdownFormat.metadata.map(formatMetadata).join("\n")
      }\n\nDocument root: { "type": "doc", "content": [...] }\nSupported nodes: ${
        page.document.nodes.join(", ")
      }\nSupported marks: ${
        page.document.marks.join(", ")
      }\n\nTop-level section container:\n${page.sections.example}\n\nSection attributes:\n${
        page.document.sectionNode.attrs.map(formatSectionAttr).join("\n")
      }\n\nSection photo background (closed object):\n${
        page.sections.background.fields.map((field) => formatRegistryField(field)).join("\n")
      }\n  delivery URLs         ${page.sections.background.deliveryUrlPolicy}\n  compact behavior      ${page.sections.background.compactBehavior}\n\nScrim opacity mapping:\n${
        Object.entries(page.sections.background.scrimOpacityByValue).map(([name, opacity]) => `  ${name.padEnd(20)} ${opacity}`).join("\n")
      }\n\nResponsive background example:\n${page.sections.background.markdownExample}\n\nSection decoration (closed object):\n${
        page.sections.decoration.fields.map((field) => formatRegistryField(field)).join("\n")
      }\n  delivery URLs         ${page.sections.decoration.deliveryUrlPolicy}\n\nTint mapping:\n${
        Object.entries(page.sections.decoration.tintTokens).map(([name, token]) => `  ${name.padEnd(20)} ${token}`).join("\n")
      }\n\nTransparent-mask example:\n${page.sections.decoration.markdownExample}\n\nMask guidance: ${
      page.sections.decoration.maskGuidance
      }\nWarning: ${page.sections.decoration.opaqueWarning}\n\nRoot defaults and placement:\n${
        page.sections.placementMatrix.map(formatPlacement).join("\n")
      }\n\nSemantic tables:\n  placement             document root or directly inside a top-level section; wide/full-well measure\n  rows                  exactly ${page.tables.structure.headerRows} header row, then ${page.tables.limits.dataRows.min} through ${page.tables.limits.dataRows.max} data rows\n  columns               ${page.tables.limits.columns.min} through ${page.tables.limits.columns.max}; delimiter and every row must match the header width\n  caption               optional non-empty plain text; maximum ${page.tables.limits.captionScalars.max} Unicode scalar values; syntax ${page.tables.markdown.captionSyntax}\n  caption guidance      ${page.tables.captionGuidance}\n  cells                 exactly ${page.tables.structure.paragraphChildrenPerCell} paragraph; headers need non-whitespace text; data cells may be empty; maximum ${page.tables.limits.cellTextScalars.max} text scalars\n  inline                ${page.tables.structure.inlineNodes.join(", ")}; marks ${page.tables.structure.marks.join(", ")}\n  pipes                 outer pipes ${page.tables.markdown.outerPipes}; write a literal pipe as ${page.tables.markdown.literalPipeEscape}\n  spans                 unsupported: ${page.tables.structure.unsupportedSpanAttrs.join(", ")}\n  alignment             ${page.tables.markdown.alignment}; delimiter cells contain hyphens only\n  termination           a blank line ends the table before another block\n\nRate table example:\n${page.tables.examples.rateTable}\n\nComparison table example:\n${page.tables.examples.comparisonTable}\n\nRejected alignment example (${CONTENT_ERROR_CODES.markdownTableAlignment}):\n${page.tables.examples.rejectedAlignment}\nRemove the ':' characters from the delimiter row.\n\nDirect ProseMirror table example:\n${JSON.stringify(page.tables.examples.proseMirror, null, 2)}\n\nTable error corrections:\n${
        page.tables.corrections.map((entry) => `  ${entry.code.padEnd(34)} ${entry.correction}`).join("\n")
      }\n\nInline facts:\n  placement             document root or directly inside a top-level section; ${page.inlineFacts.placement.measure} measure\n  items                 ${page.inlineFacts.attrs.items.minItems} through ${page.inlineFacts.attrs.items.maxItems}; closed objects in ${page.inlineFacts.attrs.items.itemFieldOrder.join(", ")} order\n  value                 ${page.inlineFacts.valuePolicy}\n  label                 ${page.inlineFacts.labelPolicy}\n  url                   ${page.inlineFacts.urlPolicy}\n  Markdown              fenced ${page.inlineFacts.markdown.fence} block whose body is a JSON array\n\nInline-facts Markdown example:\n${page.inlineFacts.markdown.example}\n\nDirect ProseMirror inlineFacts example:\n${JSON.stringify(page.inlineFacts.examples.proseMirror, null, 2)}\n\nRaw HTML: ${page.document.rawHtml.default} by default. For a tracked ${page.document.rawHtml.trackedProseMirror.format} document only: ${page.document.rawHtml.trackedProseMirror.behavior} Opt in with ${page.document.rawHtml.trackedProseMirror.optIn}. For ${page.document.rawHtml.markdown.format}, ${page.document.rawHtml.markdown.behavior} ${page.document.rawHtml.warning}\n\nComponents:\n${
        page.components.map((component) => `  ${component.type.padEnd(16)} ${component.summary}`).join("\n")
      }\n\nWorkflow:\n${
        page.workflow.map((step) => `  ${step.command}: ${step.result}`).join("\n")
      }\n\nUse --json for exact metadata and component-node shapes.\n`;
    }
    case "component": {
      const component = result.component;
      return `${component.displayName} (${component.type})\n${component.summary}\n\nProperties:\n${
        component.properties.map(formatComponentProperty).join("\n")
      }\n\nUnlisted properties are rejected at every object level.\ncomponentData maximum: ${component.componentDataMaxUtf8Bytes} UTF-8 bytes.\n\nAccessibility:\n${
        component.accessibility.map((note) => `  - ${note}`).join("\n")
      }\n\nValid componentData object:\n${
        JSON.stringify(component.example, null, 2)
      }\n\nMarkdown component fence:\n${component.markdownExample}\n\nRemember: componentData stores JSON.stringify(the object), not the object itself. Use --json for the exact nested schema and a complete componentBlock example.\n`;
    }
    case "workflow": {
      const reference = result.reference;
      // Only the fixture reference carries a shipped directory; every other
      // workflow topic renders exactly as it did.
      const shipped = reference.fixtureDirectory === undefined
        ? ""
        : `\nShipped example: ${reference.fixtureDirectory}\nValidate it: ${CLI_BINARY_NAME} validate "${reference.fixtureDirectory}"\n`;
      // Every other topic's example is a literal in this module and is always
      // present; the fixture topic's is a shipped file, so it is omitted the
      // same way the shipped-directory lines are when the file is not there.
      const example = reference.example === undefined
        ? ""
        : `\n\nExample:\n${JSON.stringify(reference.example, null, 2)}`;
      return `${reference.title}\n${reference.summary}\n\nUsage: ${reference.usage}\n${shipped}\n${
        reference.details.map((detail) => `  - ${detail}`).join("\n")
      }${example}\n`;
    }
    case "presentation":
      return formatPresentationReference(result.reference);
    default:
      throw new TypeError(`Unknown reference topic '${result.topic}'.`);
  }
}
