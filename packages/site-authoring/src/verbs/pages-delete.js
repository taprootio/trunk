import {
  deletePage,
  getNavigation,
  getSiteRedirectMap,
  isGonePage,
  listSitePages,
  NAV_ITEM_KIND_PAGE,
  PAGE_STATUS_PUBLISHED,
  withRefusalGuidance,
} from "../api.js";
import { VERB_PAGES_DELETE } from "../constants.js";
import { SiteAuthoringError } from "../errors.js";
import { FOOTER_SETTINGS_FILE } from "../footer-workspace.js";
import { afterSubmitPage, FORM_FILE_EXTENSION, FORMS_DIRECTORY, normalizePagePath as normalizeFormPagePath } from "../forms-contract.js";
import { normalizeRedirectPath } from "../site-checks.js";
import { boundedList, openSession, successResult, warnIfExternalWritesPaused } from "../session.js";
import { isAuthorableTemplateType, isGeneratedTemplateType, isLegalTemplateType } from "../typed-pages.js";
import {
  deleteWorkspaceFile,
  displayPagePath,
  isDiscoverablePageSource,
  internalPageBaselineFile,
  internalPageObservedRevisionFile,
  normalizePagePath,
  pageSourceFormat,
  pageSourceRegistry,
  readManifest,
  readObservedPageRecord,
  readWorkspaceJson,
  requireManifestSourceRegistry,
  SYSTEM_PAGE_NOT_FOUND_PATH,
  walkWorkspaceFiles,
  WORKSPACE_LIMITS,
  workspaceFileExists,
  writeManifest,
} from "../workspace.js";
import { outcomeUnknown, requireReconciledRevision } from "./pages-push.js";

/**
 * `pages delete` — remove one page this workspace tracks (TR01226).
 *
 * Deleting goes through the page delete the app uses, so the rules are the
 * site's: a page that was never published is removed outright and its path is
 * free again. A page the live site serves is not taken off it by the delete: the
 * site stages the removal and the page stays live until a deployment promotes it
 * (TR01278), so the CLI reports `removalStaged` and the staging loop finishes
 * the job.
 *
 * The same fence as `pages push` runs first: a page edited on the site since
 * this workspace last reconciled with it is refused with `pages.push_conflict`.
 * Then the references a delete would leave dangling are checked: a navigation
 * item, a footer link or a form's after-submit page refuses the delete (the
 * site would drop the navigation item silently, which would also move the
 * revision `nav push` is fenced by), while a redirect that lands on the path
 * is only reported, because a redirect to a missing page is a broken link
 * rather than a broken site.
 *
 * `--dry-run` runs every check and sends nothing. A page the site already
 * deleted, or already staged for removal, is the retry of an interrupted run:
 * only the workspace is cleaned.
 */

const MAXIMUM_REPORTED = 50;

function refusal(code, message, field, alternatives) {
  return new SiteAuthoringError(code, message, { field, ...(alternatives === undefined ? {} : { alternatives }) });
}

/** Every `pageResourceId` in a footer settings document that names the page. */
function footerLinksTo(value, resourceId, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) footerLinksTo(item, resourceId, found);
  } else if (value !== null && typeof value === "object") {
    if (value.pageResourceId === resourceId) found.push(value.label ?? value.id ?? "a footer link");
    for (const item of Object.values(value)) footerLinksTo(item, resourceId, found);
  }
  return found;
}

function navigationItemsTo(items, resourceId, trail = "navItems", found = []) {
  items.forEach((item, index) => {
    const at = `${trail}[${index}]`;
    if (item?.kind === NAV_ITEM_KIND_PAGE && item.resourceId === resourceId) {
      found.push({ at, title: typeof item.title === "string" ? item.title : "" });
    }
    if (Array.isArray(item?.children)) navigationItemsTo(item.children, resourceId, `${at}.children`, found);
  });
  return found;
}

/**
 * Reads workspace files that may name the page, failing closed: a file that cannot be read could be the one that
 * does, so its error refuses the delete rather than letting it pass unchecked.
 */
async function readReferenceSource(read, what, shown) {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof SiteAuthoringError)) throw error;
    throw refusal(
      "pages.delete_references_unreadable",
      `Could not read ${what} to check whether it uses '${shown}': ${error.message} Nothing was deleted. Fix or `
        + "remove it, then try again.",
      error.field ?? shown,
    );
  }
}

/** The workspace's form files whose after-submit page is this path or resource. */
async function formsSendingTo(workspaceDir, pagePath, resourceId) {
  const shown = displayPagePath(pagePath);
  const files = await readReferenceSource(
    async () => await walkWorkspaceFiles(workspaceDir, FORMS_DIRECTORY, [FORM_FILE_EXTENSION]),
    `the ${FORMS_DIRECTORY}/ folder`,
    shown,
  );
  const found = [];
  for (const file of files) {
    const document_ = await readReferenceSource(
      async () => await readWorkspaceJson(workspaceDir, file, WORKSPACE_LIMITS.documentBytes),
      file,
      shown,
    );
    const after = afterSubmitPage(document_?.definition);
    if (after === undefined) continue;
    // A form names its page by path, or by resource id when the page was not in the path index at pull.
    const byPath = typeof after.page_path === "string"
      && normalizeFormPagePath(after.page_path) === normalizeFormPagePath(`/${pagePath}`);
    if (byPath || after.page_resource_id === resourceId) found.push(file);
  }
  return found;
}

async function footerLinks(workspaceDir, resourceId, shown) {
  if (!await workspaceFileExists(workspaceDir, FOOTER_SETTINGS_FILE)) return [];
  return footerLinksTo(
    await readReferenceSource(
      async () => await readWorkspaceJson(workspaceDir, FOOTER_SETTINGS_FILE, WORKSPACE_LIMITS.documentBytes),
      FOOTER_SETTINGS_FILE,
      shown,
    ),
    resourceId,
  );
}

function redirectsLandingOn(entries, pagePath) {
  const target = normalizeRedirectPath(`/${pagePath}`);
  return entries
    .filter((entry) => typeof entry.target === "string" && normalizeRedirectPath(entry.target) === target)
    .map((entry) => entry.path);
}

/** The live site serves this page, so the site stages its removal instead of deleting it. */
function servedLive(summary) {
  return summary !== undefined && (summary.status === PAGE_STATUS_PUBLISHED || summary.datePublished !== "");
}

function trackedEntry(manifest, pagePath) {
  return manifest.pages.find((entry) => entry !== null && normalizePagePath(entry.path) === pagePath);
}

function requireDeletable(manifest, entry, pagePath) {
  const shown = displayPagePath(pagePath);
  if (entry === undefined) {
    throw refusal(
      "pages.delete_page_unknown",
      `No page this workspace tracks is at '${shown}'. Run 'taproot-site pull' if it was created elsewhere.`,
      shown,
    );
  }
  // The entry names a file this verb unlinks and a page it deletes, so a hand-edited manifest is refused first.
  requireManifestSourceRegistry(pageSourceRegistry(manifest));
  if (typeof entry.pageId !== "string" || entry.pageId === "") {
    throw refusal(
      "pages.delete_manifest_invalid",
      `The manifest entry for '${shown}' records no page id. Run 'taproot-site pull' to rebuild it.`,
      shown,
    );
  }
  if (entry.file !== undefined && (typeof entry.file !== "string" || !isDiscoverablePageSource(entry.file) || pageSourceFormat(entry.file) === undefined)) {
    throw refusal(
      "pages.delete_manifest_invalid",
      `The manifest entry for '${shown}' names a file that is not a page source. Run 'taproot-site pull' to rebuild it.`,
      shown,
    );
  }
  if (pagePath === "" || pagePath.toLowerCase() === SYSTEM_PAGE_NOT_FOUND_PATH) {
    throw refusal("pages.delete_system", `'${shown}' is a system page; the site cannot be without it.`, shown);
  }
  if (isGeneratedTemplateType(entry.templateType) || entry.isGenerated === true) {
    throw refusal(
      "pages.delete_generated",
      `'${shown}' is a page Taproot generates from the site's content; remove the content that produces it.`,
      shown,
    );
  }
  if (isLegalTemplateType(entry.templateType) || !isAuthorableTemplateType(entry.templateType)) {
    throw refusal(
      "pages.delete_not_authorable",
      `'${shown}' is a ${entry.templateType ?? "system-managed"} page, which this CLI cannot delete; delete it in the app.`,
      shown,
    );
  }
}

export async function pagesDelete(invocation) {
  const session = await openSession(invocation);
  const { client, config, siteId, onProgress } = session;
  const dryRun = invocation.dryRun === true;
  if (!dryRun) warnIfExternalWritesPaused(session, VERB_PAGES_DELETE);
  const pagePath = normalizePagePath(invocation.deletePagePath);
  if (pagePath === undefined) {
    throw new SiteAuthoringError("pages.delete_path_invalid", "The page path is not usable.", {
      field: "pagePath",
      exitCode: 2,
    });
  }
  const shown = displayPagePath(pagePath);
  const manifest = await readManifest(config.workspaceDir, siteId);
  const entry = trackedEntry(manifest, pagePath);
  requireDeletable(manifest, entry, pagePath);
  // A link or directory where a workspace file should be would fail the cleanup after the site delete, and
  // every retry would meet it again, so it is refused before anything is sent.
  const cleanupFiles = [
    ...(typeof entry.file === "string" ? [entry.file] : []),
    ...[internalPageBaselineFile(entry.pageId), internalPageObservedRevisionFile(entry.pageId)].filter(
      (internal) => internal !== undefined,
    ),
  ];
  for (const file of cleanupFiles) await workspaceFileExists(config.workspaceDir, file);

  return await withRefusalGuidance(onProgress, "page delete", async () => {
    onProgress(`Reading the site's pages to check '${shown}'.`);
    const { pages, truncated } = await listSitePages(client, siteId, { onProgress });
    const live = pages.find((summary) => summary.pageId === entry.pageId);
    if (truncated && live === undefined) {
      throw refusal(
        "pages.delete_list_incomplete",
        `The site has more pages than this CLI could list, so it cannot tell whether '${shown}' still exists. `
          + "Nothing was deleted.",
        shown,
      );
    }
    if (live !== undefined && isLegalTemplateType(live.templateType)) {
      throw refusal("pages.delete_not_authorable", `'${shown}' is a legal page; delete it in the app.`, shown);
    }
    const alreadyGone = live === undefined || isGonePage(live);
    if (!alreadyGone) {
      // The fence `pages push` uses, against the revision this workspace last reconciled with.
      requireReconciledRevision({
        file: entry.file ?? shown,
        pagePath,
        target: live,
        entry,
        observedRevision: (await readObservedPageRecord(config.workspaceDir, live.pageId))?.revision,
        deleting: true,
      });
    }

    const references = { navigation: [], footer: [], forms: [] };
    let redirects = [];
    if (!alreadyGone) {
      onProgress("Checking what refers to the page.");
      references.navigation = navigationItemsTo((await getNavigation(client, siteId)).navItems, live.resourceId);
      references.footer = await footerLinks(config.workspaceDir, live.resourceId, shown);
      references.forms = await formsSendingTo(config.workspaceDir, pagePath, live.resourceId);
      if (references.navigation.length + references.footer.length + references.forms.length > 0) {
        throw refusal(
          "pages.delete_referenced",
          `'${shown}' is still used by ${
            [
              references.navigation.length > 0 && `${references.navigation.length} navigation item(s)`,
              references.footer.length > 0 && `${references.footer.length} footer link(s)`,
              references.forms.length > 0 && `${references.forms.length} form(s)`,
            ].filter(Boolean).join(", ")
          }. Remove those first (edit nav.json and run 'nav push'; edit the footer and run 'footer push'; point `
            + "the form's after_submit elsewhere and run 'forms push'), then delete the page. Nothing was deleted.",
          shown,
          [
            ...references.navigation.map(({ at, title }) => `${at}${title === "" ? "" : ` (${title})`}`),
            ...references.footer.map((label) => `footer: ${label}`),
            ...references.forms,
          ],
        );
      }
      redirects = redirectsLandingOn((await getSiteRedirectMap(client, siteId)).entries, pagePath);
    }

    const report = {
      page: {
        path: shown,
        ...(entry.file === undefined ? {} : { file: entry.file }),
        pageId: entry.pageId,
        title: entry.title,
      },
      // A page the live site serves stays live until a deployment removes it; the dry run predicts that from
      // the status, and a real delete reads it from the site's answer.
      // A page published and being edited looks the same as a restored draft that is not live, so only a
      // PUBLISHED status predicts the staged removal; the ambiguous case names no effect until the site answers.
      ...(alreadyGone
        ? { effect: live?.removalStaged === true ? "alreadyRemovalStaged" : "alreadyDeleted" }
        : live.status === PAGE_STATUS_PUBLISHED
        ? { effect: "removalStaged" }
        : servedLive(live)
        ? {}
        : { effect: "removed" }),
      ...(live?.removalStaged === true ? { removalStaged: true } : {}),
      ...(redirects.length === 0
        ? {}
        : {
          redirectsToPage: boundedList(redirects, MAXIMUM_REPORTED).items,
          redirectsToPageCount: redirects.length,
        }),
    };
    if (redirects.length > 0) {
      onProgress(
        `${redirects.length} redirect(s) land on '${shown}' and will point at a missing page. `
          + "Edit them with 'redirects pull' and 'redirects push', or leave them.",
      );
    }
    if (dryRun) {
      onProgress(
        alreadyGone
          ? `Dry run: '${shown}' is already ${
            live?.removalStaged === true ? "staged for removal" : "gone from the site"
          }; a delete would only clean the workspace.`
          : live.status === PAGE_STATUS_PUBLISHED
          ? `Dry run: '${shown}' is live, so deleting it stages its removal and it stays live until you deploy. `
            + "Nothing was sent."
          : servedLive(live)
          ? `Dry run: '${shown}' has been published. If the site serves it, the delete stages its removal and it `
            + "stays live until you deploy; otherwise it is deleted at once. Nothing was sent."
          : `Dry run: '${shown}' would be deleted. Nothing was sent.`,
      );
      return successResult(VERB_PAGES_DELETE, siteId, { dryRun: true, ...report });
    }

    let removalStaged = false;
    if (!alreadyGone) {
      onProgress(`Deleting '${shown}'.`);
      try {
        removalStaged = (await deletePage(client, entry.pageId)).removalStaged;
      } catch (error) {
        // A reply that never arrived may still have deleted the page; the retry meets it already gone.
        // A reply that arrived but cannot be read (api.page_contract) follows a delete the site may have run.
        if (error instanceof SiteAuthoringError && (outcomeUnknown(error) || error.code === "api.page_contract")) {
          throw error.withCompletedWrites([`page ${shown}: unknown`]);
        }
        throw error;
      }
    }

    // The source goes with the page: left behind, a whole-workspace push would create it again.
    try {
      for (const file of cleanupFiles) await deleteWorkspaceFile(config.workspaceDir, file);
      manifest.pages = manifest.pages.filter((candidate) => candidate !== entry);
      await writeManifest(config.workspaceDir, manifest);
    } catch (error) {
      if (error instanceof SiteAuthoringError) {
        throw error.withCompletedWrites([`page ${shown}: ${removalStaged ? "removal staged" : "deleted"}`]);
      }
      throw error;
    }
    onProgress(
      removalStaged
        ? `Removal staged for '${shown}': it stays live until you deploy. It is removed from the workspace.`
        : `Deleted '${shown}' and removed it from the workspace.`,
    );
    return successResult(VERB_PAGES_DELETE, siteId, {
      ...report,
      // The effect the site reported, which a dry run could only predict.
      ...(alreadyGone ? {} : { effect: removalStaged ? "removalStaged" : "removed" }),
      // True only when the page is gone from the site now; a staged removal is still live, so read `effect`.
      deleted: !alreadyGone && !removalStaged,
      ...(removalStaged ? { removalStaged: true } : {}),
      // Site writes only: a retry that finds the page already gone sends nothing.
      ...(alreadyGone ? {} : { written: { items: [`page ${shown}`], count: 1 } }),
      // A staged removal reaches the live site only through a deployment; a page deleted at once may have
      // been in the staging candidate, which a new staging deploy refreshes.
      nextStep: "deploy --staging",
    });
  });
}
