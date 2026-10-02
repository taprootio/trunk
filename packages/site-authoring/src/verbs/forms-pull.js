import { withRefusalGuidance } from "../api.js";
import { VERB_FORMS_PULL } from "../constants.js";
import { getPageIndex, getSiteForm, listSiteForms } from "../forms-api.js";
import { afterSubmitPage, formFileName, projectFormForWorkspace } from "../forms-contract.js";
import { formsManifestEntry, siteSettingsBaseline } from "../forms-workspace.js";
import { boundedList, openSession, successResult } from "../session.js";
import { readManifest, writeManifest, writeWorkspaceJson } from "../workspace.js";

const MAXIMUM_REPORTED = 200;

/**
 * `forms pull` — write one file per live form and record the versions read.
 *
 * It overwrites a form's file with the site's state, so a local edit that was
 * never pushed is replaced; that is what pull means everywhere else in this
 * CLI. An archived form is reported and not written, because `forms push`
 * refuses an archived form and a file that can never be pushed is noise.
 */
export async function formsPull(invocation) {
  const { client, config, siteId, onProgress } = await openSession(invocation);
  // The manifest is the pulled workspace this baseline belongs to, the same
  // precondition every push has.
  const manifest = await readManifest(config.workspaceDir, siteId);

  const listed = await withRefusalGuidance(onProgress, "forms pull", async () => await listSiteForms(client, siteId));
  const live = listed.filter((form) => !form.archived);
  const archived = listed.filter((form) => form.archived).map((form) => form.key).sort();

  const baselines = [];
  const written = [];
  // A form that sends visitors to a page is written with the page's path, which needs the page list once.
  let pages;
  for (const summary of live) {
    const { form, version } = await withRefusalGuidance(
      onProgress,
      "forms pull",
      async () => await getSiteForm(client, siteId, summary.id),
    );
    if (pages === undefined && afterSubmitPage(version.definition)) {
      pages = await withRefusalGuidance(onProgress, "forms pull", async () => await getPageIndex(client, siteId, { onProgress }));
    }
    const document_ = projectFormForWorkspace({
      key: form.key,
      name: form.name,
      sink: form.sink,
      retention_days: form.retentionDays,
      definition: version.definition,
    }, pages?.pathById);
    await writeWorkspaceJson(config.workspaceDir, formFileName(form.key), document_);
    baselines.push([form.key, { id: form.id, version: version.version, settings: siteSettingsBaseline(form) }]);
    written.push(form.key);
  }

  manifest.forms = formsManifestEntry(baselines);
  await writeManifest(config.workspaceDir, manifest);
  onProgress(`Wrote ${written.length} form file${written.length === 1 ? "" : "s"} and recorded their versions.`);

  const reported = boundedList(written.sort(), MAXIMUM_REPORTED);
  return successResult(VERB_FORMS_PULL, siteId, {
    forms: {
      total: written.length,
      items: reported.items.map((key) => ({ key, file: formFileName(key) })),
      ...(reported.truncated ? { itemsTruncated: true } : {}),
      ...(archived.length > 0 ? { archived } : {}),
    },
  });
}
