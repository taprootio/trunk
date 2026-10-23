import {
  getNavigation,
  listSitePages,
  NAV_ITEM_KIND_EXTERNAL_URL,
  NAV_ITEM_KIND_PAGE,
  NAV_ITEM_KINDS,
  NAVIGATION_MAXIMUM_DEPTH,
  saveNavigation,
  withRefusalGuidance,
} from "../api.js";
import { VERB_NAV_PUSH } from "../constants.js";
import {
  CONTACT_OR_WEB_URL_MAX_LENGTH,
  CONTACT_OR_WEB_URL_REQUIREMENT,
  isContactOrWebUrl,
} from "../contact-url.js";
import { SiteAuthoringError } from "../errors.js";
import { stableJson } from "../footer-draft-hash.js";
import {
  advanceNavigationManifest,
  navigationMovedRefusal,
  requireNavigationBaseline,
} from "../navigation-workspace.js";
import { planStale } from "../problems.js";
import { boundedList, openSession, successResult, warnIfExternalWritesPaused } from "../session.js";
import { ApiError } from "../transport.js";
import {
  NAVIGATION_FILE_NAME,
  readManifest,
  readWorkspaceJson,
  workspaceFileExists,
  WORKSPACE_LIMITS,
  writeWorkspaceJson,
} from "../workspace.js";

/**
 * `nav push` — replace the whole navigation tree.
 *
 * `SaveSiteNavigation` is a whole-tree PUT fenced by a revision (TR01231): the
 * pull records the revision the tree was read at, and the save presents it. A
 * tree edited in the app since is refused with `nav.concurrent_modification`
 * and nothing is written. Two more things follow, and the body does both:
 *
 * 1. The tree is re-read immediately before the write, so a moved tree is
 *    refused before anything is sent, and what the replace is about to remove
 *    is *named* rather than discovered afterwards.
 * 2. Local validation is exhaustive and refuses by item path. The server stores
 *    what it is given; a `PAGE` item carrying `pageId` instead of `resourceId`,
 *    or a fourth level of nesting, is accepted and then renders wrong. And the
 *    one shape it does check — `id` and `resourceId` are parsed as GUIDs — it
 *    refuses with a bare `InvalidArgument` naming no field at all, so a single
 *    `id: "home"` in a hundred-item tree would come back as an unclassified 400
 *    with nothing to grep for. A `resourceId` that is a valid UUID pointing at
 *    no page is the same story with a bare `ResourceId`, so PAGE targets are
 *    checked against the live page list too. Naming `navItems[1].children[0]`
 *    is the difference between a fixable error and a hunt.
 */

const MAXIMUM_REPORTED = 100;
const MAXIMUM_ITEMS = 1_000;
const MAXIMUM_TITLE_LENGTH = 200;
const MAXIMUM_URL_LENGTH = CONTACT_OR_WEB_URL_MAX_LENGTH;
// The item keys in the order the workspace file spells them; validation and projection share this list.
const NAVIGATION_ITEM_KEY_ORDER = Object.freeze(["id", "kind", "title", "resourceId", "externalUrl", "children"]);
const ITEM_KEYS = new Set(NAVIGATION_ITEM_KEY_ORDER);

// `SaveSiteNavigation` maps both `id` and `resourceId` through
// `RequestValidation.RequireGuid`. A value that is not a GUID comes back as a
// bare `InvalidArgument` carrying no field violation at all — an unclassified
// 400 with nothing to say which of a hundred items was wrong. This verb's whole
// contract is that a malformed tree is named locally, by item path, so the
// shape is checked here rather than discovered there.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function navError(code, message, itemPath) {
  return new SiteAuthoringError(code, `${itemPath}: ${message}`, { field: itemPath });
}

function isBoundedText(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function isUuid(value) {
  return typeof value === "string" && UUID.test(value);
}

function isEmpty(value) {
  return value === undefined || value === null || value === "";
}

function validateItem(item, itemPath, depth, seenIds, counters) {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    throw navError("nav.item_invalid", "a navigation item must be an object.", itemPath);
  }
  if (depth > NAVIGATION_MAXIMUM_DEPTH) {
    throw navError(
      "nav.depth_exceeded",
      `navigation nests deeper than ${NAVIGATION_MAXIMUM_DEPTH} levels.`,
      itemPath,
    );
  }
  counters.items += 1;
  if (counters.items > MAXIMUM_ITEMS) {
    throw navError("nav.too_many_items", `the navigation tree holds more than ${MAXIMUM_ITEMS} items.`, itemPath);
  }

  const unknown = Object.keys(item).filter((key) => !ITEM_KEYS.has(key)).sort();
  if (unknown.length > 0) {
    // `pageId` is the specific mistake this catches: the navigation contract
    // targets a page by its *site resource* id, and a `pageId` key is stored
    // and then silently ignored.
    throw navError(
      "nav.unknown_field",
      unknown.includes("pageId")
        ? "a PAGE item targets 'resourceId', never 'pageId'."
        : `unsupported navigation field '${unknown[0]}'.`,
      itemPath,
    );
  }
  if (!isUuid(item.id)) {
    throw navError(
      "nav.id_invalid",
      "every navigation item needs a stable 'id' that is a canonical lowercase UUID; Taproot parses it as one.",
      itemPath,
    );
  }
  if (seenIds.has(item.id)) {
    throw navError("nav.id_duplicate", `navigation id '${item.id}' appears more than once in the tree.`, itemPath);
  }
  seenIds.add(item.id);
  if (typeof item.kind !== "string" || !NAV_ITEM_KINDS.includes(item.kind)) {
    throw navError(
      "nav.kind_invalid",
      `'kind' must be one of ${NAV_ITEM_KINDS.join(", ")}.`,
      itemPath,
    );
  }
  if (!isBoundedText(item.title, MAXIMUM_TITLE_LENGTH)) {
    throw navError("nav.title_invalid", "every navigation item needs a non-empty 'title'.", itemPath);
  }

  if (item.kind === NAV_ITEM_KIND_PAGE) {
    if (!isUuid(item.resourceId)) {
      throw navError(
        "nav.resource_missing",
        "a PAGE item needs the target page's 'resourceId' — the canonical lowercase UUID 'pull' records in the "
          + "manifest, not the page path or pageId.",
        itemPath,
      );
    }
    if (!isEmpty(item.externalUrl)) {
      throw navError("nav.external_url_unexpected", "a PAGE item must not carry 'externalUrl'.", itemPath);
    }
    // Kept with its item path so the liveness check below can still name the
    // item; by then the tree has been rebuilt and the paths are gone.
    counters.pageReferences.push({ itemPath, resourceId: item.resourceId });
  } else if (item.kind === NAV_ITEM_KIND_EXTERNAL_URL) {
    if (!isBoundedText(item.externalUrl, MAXIMUM_URL_LENGTH)) {
      throw navError("nav.external_url_missing", "an EXTERNAL_URL item needs a non-empty 'externalUrl'.", itemPath);
    }
    // A header item may be a phone number or an email address, not just a web
    // page; the value is stored verbatim so the number stays dialable.
    if (!isContactOrWebUrl(item.externalUrl, MAXIMUM_URL_LENGTH)) {
      throw navError("nav.external_url_invalid", `'externalUrl' ${CONTACT_OR_WEB_URL_REQUIREMENT}.`, itemPath);
    }
    if (!isEmpty(item.resourceId)) {
      throw navError("nav.resource_unexpected", "an EXTERNAL_URL item must not carry 'resourceId'.", itemPath);
    }
  } else if (!isEmpty(item.resourceId) || !isEmpty(item.externalUrl)) {
    throw navError(
      "nav.target_unexpected",
      "a GROUP_HEADER item is a label and must carry neither 'resourceId' nor 'externalUrl'.",
      itemPath,
    );
  }

  const children = item.children ?? [];
  if (!Array.isArray(children)) {
    throw navError("nav.children_invalid", "'children' must be a list when it is present.", itemPath);
  }
  const validated = children.map((child, index) =>
    validateItem(child, `${itemPath}.children[${index}]`, depth + 1, seenIds, counters));
  // Rebuilt field by field so nothing outside the contract can ride along, and
  // so an absent optional crosses the wire as the zero value proto3 expects.
  return {
    id: item.id,
    kind: item.kind,
    // Trimmed as the site stores them, so a padded value still equals the stored tree when a lost push is settled.
    title: item.title.trim(),
    resourceId: item.kind === NAV_ITEM_KIND_PAGE ? item.resourceId : "",
    externalUrl: item.kind === NAV_ITEM_KIND_EXTERNAL_URL ? item.externalUrl.trim() : "",
    children: validated,
  };
}

/**
 * The one workspace spelling of a navigation tree (TR01232): the item keys in a
 * fixed order, with the fields that only carry a default left out. The API prints
 * proto3 defaults (`externalUrl: ""`, `children: []`) and `nav push` validates into
 * the same full shape, so without this a pull after a push rewrote nav.json with
 * values nobody wrote. Both `pull` and `nav push` write this form, and either form
 * is accepted on the way in.
 */
export function projectNavigationForWorkspace(items) {
  if (!Array.isArray(items)) return items;
  return items.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    const projected = {};
    const keys = [
      ...NAVIGATION_ITEM_KEY_ORDER.filter((key) => Object.hasOwn(item, key)),
      ...Object.keys(item).filter((key) => !NAVIGATION_ITEM_KEY_ORDER.includes(key)),
    ];
    for (const key of keys) {
      const value = item[key];
      if ((key === "resourceId" || key === "externalUrl") && value === "") continue;
      if (key === "children" && Array.isArray(value)) {
        if (value.length > 0) projected.children = projectNavigationForWorkspace(value);
        continue;
      }
      projected[key] = value;
    }
    return projected;
  });
}

function collectIds(items, into = new Set()) {
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    if (typeof item.id === "string") into.add(item.id);
    if (Array.isArray(item.children)) collectIds(item.children, into);
  }
  return into;
}

function requireKnownPageTargets(pageReferences, knownResourceIds, knownPageIds) {
  for (const reference of pageReferences) {
    if (knownResourceIds.has(reference.resourceId)) continue;
    throw navError(
      "nav.resource_unknown",
      knownPageIds.has(reference.resourceId)
        ? `'${reference.resourceId}' is a pageId, not a site resourceId. Navigation targets resource_id — use the `
          + "'resourceId' that 'pull' records beside 'pageId' on the same manifest entry."
        : `'${reference.resourceId}' does not name a page on this site. Use the 'resourceId' that 'pull' records `
          + "in the manifest, and re-run 'pull' if the page was created elsewhere.",
      reference.itemPath,
    );
  }
}

/**
 * Refuses a PAGE item whose `resourceId` is well-formed but points at nothing.
 *
 * The shape check upstream only proves the value is a UUID. A UUID that names
 * no page on this site is accepted by every local rule and then refused by the
 * server with a bare `ResourceId` — no index, no item path, nothing to locate
 * across a tree that may hold a thousand items. Since the ids come from the
 * manifest, where `pageId` and `resourceId` sit next to each other on the same
 * entry, the overwhelmingly likely mistake is reaching for the wrong one; when
 * the value turns out to be a live `pageId`, the message says so instead of
 * repeating "not found".
 *
 * A page list this CLI could not fully enumerate produces no refusal at all: an
 * incomplete set would reject valid trees, and a false refusal here is worse
 * than the server's vague one.
 */
async function requireLivePageTargets(client, siteId, pageReferences, onProgress) {
  if (pageReferences.length === 0) return;
  onProgress(`Checking ${pageReferences.length} PAGE target(s) against the site's pages.`);
  const { pages, truncated } = await listSitePages(client, siteId, { onProgress });
  if (truncated) {
    onProgress("The page list was bounded before the site was fully enumerated; PAGE targets are not checked.");
    return;
  }
  const liveResourceIds = new Set(pages.map((summary) => summary.resourceId).filter(Boolean));
  const livePageIds = new Set(pages.map((summary) => summary.pageId));
  requireKnownPageTargets(pageReferences, liveResourceIds, livePageIds);
}

/** The complete local validation phase shared by live push and offline fixtures. */
export function validateNavigationWorkspaceDocument(parsed, siteId, knownPages) {
  // The pulled shape, and only the pulled shape. A bare array carries no site,
  // and this verb replaces a whole navigation tree in one write, fenced by the pulled revision.
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new SiteAuthoringError(
      "nav.file_invalid",
      `${NAVIGATION_FILE_NAME} must be the object 'pull' writes — { "siteId": ..., "navItems": [...] } — `
        + "not a bare list.",
      { field: NAVIGATION_FILE_NAME },
    );
  }
  if (parsed.siteId !== siteId) {
    throw new SiteAuthoringError(
      "nav.file_site_mismatch",
      `${NAVIGATION_FILE_NAME} records ${
        typeof parsed.siteId === "string" && parsed.siteId !== "" ? `site ${parsed.siteId.slice(0, 64)}` : "no site"
      }, but this configuration targets site ${siteId}. Run 'taproot-site pull' into a workspace of its own `
        + "for this site.",
      { field: NAVIGATION_FILE_NAME },
    );
  }
  const declared = parsed.navItems;
  if (!Array.isArray(declared)) {
    throw new SiteAuthoringError(
      "nav.file_invalid",
      `${NAVIGATION_FILE_NAME} must hold a 'navItems' list.`,
      { field: "navItems" },
    );
  }

  const counters = { items: 0, pageReferences: [] };
  const seenIds = new Set();
  const navItems = declared.map((item, index) =>
    validateItem(item, `navItems[${index}]`, 1, seenIds, counters)
  );
  if (knownPages !== undefined) {
    requireKnownPageTargets(counters.pageReferences, knownPages.resourceIds, knownPages.pageIds);
  }
  return { navItems, items: counters.items, pageReferences: counters.pageReferences };
}

export async function navPush(invocation) {
  const session = await openSession(invocation);
  const { client, config, siteId, onProgress } = session;
  // One advisory line before this verb does any work, and only when the
  // exchange said the platform is paused. It changes nothing else: the write
  // still runs and its refusal still classifies as platform_paused (TR00692).
  warnIfExternalWritesPaused(session, VERB_NAV_PUSH);
  if (!await workspaceFileExists(config.workspaceDir, NAVIGATION_FILE_NAME)) {
    throw new SiteAuthoringError(
      "nav.file_missing",
      `No ${NAVIGATION_FILE_NAME} was found in the workspace. Run 'taproot-site pull' first.`,
      { field: NAVIGATION_FILE_NAME },
    );
  }
  const parsed = await readWorkspaceJson(config.workspaceDir, NAVIGATION_FILE_NAME, WORKSPACE_LIMITS.navigationBytes);
  const validated = validateNavigationWorkspaceDocument(parsed, siteId);
  const { navItems, pageReferences } = validated;
  onProgress(`Validated ${validated.items} navigation items to depth ${NAVIGATION_MAXIMUM_DEPTH}.`);
  // The manifest's baseline, never a value from the file: nav.json is hand-edited, and its revision would be a
  // claim rather than a record of a read. Refused before any request when the workspace has none.
  const expectedRevision = requireNavigationBaseline(await readManifest(config.workspaceDir, siteId));

  return await withRefusalGuidance(onProgress, "navigation push", async () => {
    await requireLivePageTargets(client, siteId, pageReferences, onProgress);

    // Re-read immediately before the replace: a tree that moved since the pull is refused here, before anything
    // is sent, and it is the only way to say what the replace removes. It happens *after* the target check so
    // the window between reading the tree and replacing it stays as small as possible; the site's own fence
    // closes what is left.
    onProgress("Re-reading the live navigation tree immediately before replacing it.");
    const live = await getNavigation(client, siteId);
    const liveItems = live.navItems;
    // Under apply, the tree replaced must be the one its plan read: a change
    // made since was never reviewed, and this write would erase it.
    if (invocation.plannedLiveNavigation !== undefined && stableJson(liveItems) !== invocation.plannedLiveNavigation) {
      throw planStale("The site's navigation", NAVIGATION_FILE_NAME);
    }
    // A moved tree that already equals the file is a push whose answer was lost after it committed (the
    // transport never replays a write): the retry settles the workspace rather than refusing a tree that is
    // exactly what the file says.
    const alreadyApplied = live.revision !== expectedRevision
      && stableJson(projectNavigationForWorkspace(liveItems)) === stableJson(projectNavigationForWorkspace(navItems));
    if (live.revision !== expectedRevision && !alreadyApplied) throw navigationMovedRefusal();
    const liveIds = collectIds(liveItems);
    const pushedIds = collectIds(navItems);
    const removed = [...liveIds].filter((id) => !pushedIds.has(id)).sort();
    const added = [...pushedIds].filter((id) => !liveIds.has(id)).sort();
    if (removed.length > 0) {
      onProgress(
        `This whole-tree replace removes ${removed.length} navigation item(s) that are live now: ${
          removed.slice(0, 10).join(", ")
        }${removed.length > 10 ? ", ..." : ""}.`,
      );
    }

    let saved;
    if (alreadyApplied) {
      onProgress("The site already holds this navigation tree (an earlier push whose answer was lost); nothing is sent.");
      saved = { navItems: liveItems, revision: live.revision };
    } else {
      try {
        saved = await saveNavigation(client, siteId, navItems, expectedRevision);
      } catch (error) {
        // The tree moved between the read above and this write.
        if (error instanceof ApiError && error.hasField("ExpectedRevision")) throw navigationMovedRefusal();
        throw error;
      }
      onProgress(`Replaced the navigation tree with ${validated.items} items.`);
    }
    try {
      // The file now holds what the site stored, in the form pull writes, so the next pull is byte-identical.
      // Always the answer's tree, even an empty one: the recorded revision describes that response, and another
      // editor may have changed the tree between this save and the site's read of it.
      const stored = saved.navItems;
      // siteId and navItems first, in pull's order; any other key the author kept follows.
      const { siteId: _siteId, navItems: _navItems, ...extras } = parsed;
      await writeWorkspaceJson(config.workspaceDir, NAVIGATION_FILE_NAME, {
        siteId,
        navItems: projectNavigationForWorkspace(stored),
        ...extras,
      });
      // After the document, as redirects push orders them: if this write fails, the old baseline refuses the
      // next push rather than letting it overwrite the tree just saved.
      await advanceNavigationManifest(config.workspaceDir, siteId, { navItems: stored, revision: saved.revision });
    } catch (error) {
      // The site already holds the new tree; only the local file is stale, so say the tree was replaced.
      if (error instanceof SiteAuthoringError) throw error.withCompletedWrites(["navigationTree"]);
      throw error;
    }

    const removedReport = boundedList(removed, MAXIMUM_REPORTED);
    const addedReport = boundedList(added, MAXIMUM_REPORTED);
    return successResult(VERB_NAV_PUSH, siteId, {
      navigation: {
        file: NAVIGATION_FILE_NAME,
        items: validated.items,
        rootItems: navItems.length,
        savedRootItems: saved.navItems.length,
        added: addedReport.items,
        removed: removedReport.items,
        ...(addedReport.truncated || removedReport.truncated ? { diffTruncated: true } : {}),
        revision: saved.revision,
        ...(alreadyApplied ? { alreadyApplied: true } : {}),
      },
    });
  });
}
