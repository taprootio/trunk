import { withRefusalGuidance } from "../api.js";
import { VERB_FORMS_PULL, VERB_FORMS_PUSH } from "../constants.js";
import { SiteAuthoringError } from "../errors.js";
import {
  createSiteForm,
  getPageIndex,
  getSiteFormByKey,
  saveSiteFormVersion,
  updateSiteFormSettings,
} from "../forms-api.js";
import { afterSubmitPage, formFileName, projectFormForWorkspace, storedDefinition } from "../forms-contract.js";
import { readWorkspaceForms, recordedForm, siteSettingsBaseline, withRecordedForm } from "../forms-workspace.js";
import { openSession, successResult, warnIfExternalWritesPaused } from "../session.js";
import { ApiError } from "../transport.js";
import { readManifest, writeManifest, writeWorkspaceJson } from "../workspace.js";

function changedOnTheSite(key, cause, settingsApplied) {
  return new SiteAuthoringError(
    "forms.concurrent_modification",
    `${formFileName(key)}: the form changed on the site while it was being pushed. Run '${VERB_FORMS_PULL}', `
      + `reconcile the file, and retry. ${
        settingsApplied ? "Its settings were applied; its definition was not." : "This form was not changed."
      }`,
    { field: formFileName(key), status: cause.status },
  );
}

function pullRequired(key, reason) {
  return new SiteAuthoringError(
    "forms.pull_required",
    `${reason} Run '${VERB_FORMS_PULL}', reconcile ${formFileName(key)}, and retry. Nothing was written.`,
    { field: formFileName(key) },
  );
}

/**
 * Decides what one form needs, from the file, the site's copy and the
 * baseline the last pull recorded. Throws before anything is written.
 */
function planForm(form, remote, baseline, pages) {
  // An omitted retention means "the site's choice": the plan-aware default on
  // creation, and the form's current value on an update.
  const requestedRetention = form.document.retention_days;
  const desired = projectFormForWorkspace({
    ...form.document,
    retention_days: requestedRetention ?? remote?.form.retentionDays,
  }, pages?.pathById);
  if (remote === undefined) {
    if (baseline !== undefined) {
      throw pullRequired(form.key, "This workspace recorded the form, but the site no longer has it.");
    }
    return { form, desired, request: { ...desired, retention_days: requestedRetention }, action: "create" };
  }
  if (remote.form.archived) {
    throw new SiteAuthoringError(
      "forms.archived",
      `${formFileName(form.key)}: the site's form '${form.key}' is archived. Restore it on the site's Forms page, `
        + "delete the file, or name the other keys to push. Nothing was written.",
      { field: formFileName(form.key) },
    );
  }
  if (baseline === undefined) {
    throw pullRequired(form.key, "The site already has a form with this key that this workspace never pulled.");
  }
  const siteSettings = siteSettingsBaseline(remote.form);
  if (
    baseline.id !== remote.form.id
    || baseline.version !== remote.version.version
    // Name, sink and retention change without a new version, so they are
    // fenced separately; a stale file would otherwise revert them.
    || JSON.stringify(baseline.settings) !== JSON.stringify(siteSettings)
  ) {
    throw new SiteAuthoringError(
      "forms.concurrent_modification",
      `${formFileName(form.key)}: the form changed on the site after this workspace read it (recorded version `
        + `${baseline.version}, site has ${remote.version.version}; its name, sink or retention may also have changed). Run '${VERB_FORMS_PULL}', reconcile the file, `
        + "and retry. Nothing was written.",
      { field: formFileName(form.key) },
    );
  }
  const current = projectFormForWorkspace({
    key: remote.form.key,
    name: remote.form.name,
    sink: remote.form.sink,
    retention_days: remote.form.retentionDays,
    definition: remote.version.definition,
  }, pages?.pathById);
  const settingsChanged = current.name !== desired.name
    || current.sink !== desired.sink
    || current.retention_days !== desired.retention_days;
  const versionChanged = JSON.stringify(current.definition) !== JSON.stringify(desired.definition);
  return {
    form,
    desired,
    remote,
    baseline,
    action: settingsChanged || versionChanged ? "update" : "unchanged",
    settingsChanged,
    versionChanged,
  };
}

/**
 * `forms push` — create or update each form file in the workspace.
 *
 * Every file is validated and every form is compared with the site before the
 * first write, so a conflict on the third form refuses the whole push rather
 * than landing two. After that each form is written and its baseline advanced
 * immediately, so a failure partway leaves a workspace that the next push can
 * resume from. Editing a definition appends a version on the site; the
 * published pages keep the version they were built with until the next deploy.
 */
export async function formsPush(invocation) {
  const session = await openSession(invocation);
  const { client, config, siteId, onProgress } = session;
  warnIfExternalWritesPaused(session, VERB_FORMS_PUSH);
  const forms = await readWorkspaceForms(config.workspaceDir, invocation.formKeys);
  onProgress(`Validated ${forms.length} form file${forms.length === 1 ? "" : "s"}.`);
  let manifest = await readManifest(config.workspaceDir, siteId);

  // The site names the page after a response by resource id and the file by path, so the
  // page list is read once, and only when a form on either side points at a page.
  let pages;
  const plans = [];
  for (const form of forms) {
    const remote = await withRefusalGuidance(
      onProgress,
      "forms push",
      async () => await getSiteFormByKey(client, siteId, form.key),
    );
    if (pages === undefined && (afterSubmitPage(form.document.definition) || afterSubmitPage(remote?.version.definition))) {
      pages = await withRefusalGuidance(onProgress, "forms push", async () => await getPageIndex(client, siteId, { onProgress }));
    }
    const plan = planForm(form, remote, recordedForm(manifest, form.key), pages);
    // A page_path the site does not have is refused here, with the rest of the checks, not partway
    // through the writes. Only a definition that is going to be sent is resolved: a settings-only
    // update of a form whose page was deleted never sends it.
    plans.push(
      plan.action === "create" || plan.versionChanged
        ? { ...plan, wireDefinition: storedDefinition(form.file, (plan.request ?? plan.desired).definition, pages) }
        : plan,
    );
  }

  const results = [];
  for (const plan of plans) {
    let { desired } = plan;
    const { form } = plan;
    let formId = plan.remote?.form.id;
    let version = plan.remote?.version.version;
    // The baseline is what the site stored, not what the file said: the site
    // normalizes some values, and the next push is fenced against its copy.
    let settings = plan.remote === undefined ? undefined : siteSettingsBaseline(plan.remote.form);
    let settingsApplied = false;
    try {
      if (plan.action === "create") {
        const created = await withRefusalGuidance(
          onProgress,
          "forms push",
          async () => await createSiteForm(client, siteId, { ...plan.request, definition: plan.wireDefinition }),
        );
        formId = created.form.id;
        version = created.version.version;
        settings = siteSettingsBaseline(created.form);
        // The file is written from what the site stored: it chose the retention
        // and normalized the name.
        desired = projectFormForWorkspace({
          ...desired,
          name: created.form.name,
          sink: created.form.sink,
          retention_days: created.form.retentionDays,
        }, pages?.pathById);
      } else if (plan.action === "update") {
        if (plan.settingsChanged) {
          settings = siteSettingsBaseline(
            await withRefusalGuidance(
              onProgress,
              "forms push",
              async () => await updateSiteFormSettings(client, siteId, formId, desired, plan.baseline.settings),
            ),
          );
          settingsApplied = true;
          // Recorded at once: if the version save below fails, the next push
          // must not read the settings it just applied as someone else's edit.
          manifest = withRecordedForm(manifest, form.key, { id: formId, version, settings });
          await writeManifest(config.workspaceDir, manifest);
        }
        if (plan.versionChanged) {
          version = (await withRefusalGuidance(
            onProgress,
            "forms push",
            async () => await saveSiteFormVersion(client, siteId, formId, { ...desired, definition: plan.wireDefinition }, plan.baseline.version),
          )).version;
        }
      }
    } catch (caught) {
      // The site checks the recorded version and settings under its own lock,
      // which is what closes the gap between the comparison above and the write.
      const error = caught instanceof ApiError && (caught.hasField("ExpectedVersion") || caught.hasField("ExpectedSettings"))
        ? changedOnTheSite(form.key, caught, settingsApplied)
        : caught;
      if (error instanceof SiteAuthoringError) {
        const completed = results.filter((item) => item.action !== "unchanged").map((item) => item.key);
        // The settings write stands even though the version save after it failed.
        if (settingsApplied) completed.push(form.key);
        if (completed.length > 0) throw error.withCompletedWrites(completed);
      }
      throw error;
    }
    if (plan.action !== "unchanged") {
      // The file is rewritten in canonical form so the workspace and the site
      // agree byte for byte, and the baseline moves with it.
      await writeWorkspaceJson(config.workspaceDir, formFileName(form.key), desired);
      manifest = withRecordedForm(manifest, form.key, { id: formId, version, settings });
      await writeManifest(config.workspaceDir, manifest);
    }
    results.push({ key: form.key, action: plan.action, version });
    onProgress(`${form.key}: ${plan.action}${plan.action === "unchanged" ? "" : `, version ${version}`}.`);
  }

  const written = results.filter((item) => item.action !== "unchanged").map((item) => item.key);
  return successResult(VERB_FORMS_PUSH, siteId, {
    forms: { count: results.length, items: results },
    written: { items: written, count: written.length },
    ...(written.length > 0 ? { nextStep: "deploy --staging" } : {}),
  });
}
