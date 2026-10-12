import { withRefusalGuidance } from "../api.js";
import { VERB_FORMS_PULL, VERB_FORMS_PUSH } from "../constants.js";
import { SiteAuthoringError } from "../errors.js";
import {
  createSiteForm,
  getPageIndex,
  getSiteFormByKey,
  listSiteForms,
  saveSiteFormVersion,
  updateSiteFormSettings,
} from "../forms-api.js";
import { afterSubmitPage, formFileName, projectFormForWorkspace, storedDefinition, validateNewsletterDefinition } from "../forms-contract.js";
import { comparableFormName, readWorkspaceForms, recordedForm, siteSettingsBaseline, withRecordedForm } from "../forms-workspace.js";
import { openSession, successResult, warnIfExternalWritesPaused } from "../session.js";
import { ApiError } from "../transport.js";
import { readManifest, writeManifest, writeWorkspaceJson } from "../workspace.js";

function changedOnTheSite(key, cause, applied) {
  const outcome = applied.settings && applied.definition
    ? "Its settings and definition were applied."
    : applied.settings
    ? "Its settings were applied; its definition was not."
    : applied.definition
    ? "Its definition was applied; its settings were not."
    : "This form was not changed.";
  return new SiteAuthoringError(
    "forms.concurrent_modification",
    `${formFileName(key)}: the form changed on the site while it was being pushed. Run '${VERB_FORMS_PULL}', `
      + `reconcile the file, and retry. ${outcome}`,
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
    notify_owner: form.document.notify_owner ?? remote?.form.notifyOwner,
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
    // Operational settings change without a new version, so they are
    // fenced separately; a stale file would otherwise revert them.
    || JSON.stringify(baseline.settings) !== JSON.stringify(siteSettings)
  ) {
    throw new SiteAuthoringError(
      "forms.concurrent_modification",
      `${formFileName(form.key)}: the form changed on the site after this workspace read it (recorded version `
        + `${baseline.version}, site has ${remote.version.version}; its settings may also have changed). Run '${VERB_FORMS_PULL}', reconcile the file, `
        + "and retry. Nothing was written.",
      { field: formFileName(form.key) },
    );
  }
  const current = projectFormForWorkspace({
    key: remote.form.key,
    ...siteSettings,
    definition: remote.version.definition,
  }, pages?.pathById);
  const settingsChanged = current.name !== desired.name
    || current.sink !== desired.sink
    || current.retention_days !== desired.retention_days
    || current.notify_owner !== desired.notify_owner;
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
  const forms = await readWorkspaceForms(config.workspaceDir, invocation.formKeys, { deferNewsletterSemantics: true });
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
    // Legacy newsletter definitions may stay only after the baseline matches.
    // New capture or a changed definition must satisfy today's admission rules.
    if (
      plan.desired.sink === "newsletter"
      && (plan.action === "create" || plan.remote.form.sink !== "newsletter" || plan.versionChanged)
    ) {
      validateNewsletterDefinition(form.file, plan.desired.definition);
    }
    // A page_path the site does not have is refused here, with the rest of the checks, not partway
    // through the writes. Only a definition that is going to be sent is resolved: a settings-only
    // update of a form whose page was deleted never sends it.
    plans.push(
      plan.action === "create" || plan.versionChanged
        ? { ...plan, wireDefinition: storedDefinition(form.file, (plan.request ?? plan.desired).definition, pages) }
        : plan,
    );
  }

  // A form name is unique on the site, ignoring case, so a name another form holds is refused here with
  // the rest of the checks, not by the first write that reaches it.
  const naming = plans.filter((plan) => plan.action === "create" || plan.settingsChanged);
  if (naming.length > 0) {
    const siteForms = await withRefusalGuidance(onProgress, "forms push", async () => await listSiteForms(client, siteId));
    for (const plan of naming) {
      const name = comparableFormName(plan.desired.name);
      const holder = siteForms.find((siteForm) => siteForm.key !== plan.form.key && comparableFormName(siteForm.name) === name);
      if (holder !== undefined) {
        throw new SiteAuthoringError(
          "forms.name_taken",
          `${formFileName(plan.form.key)}: the site's form '${holder.key}'${holder.archived ? " (archived)" : ""} already `
            + `has the name '${plan.desired.name}'. A form name is unique on a site, ignoring case; rename one of them. `
            + "Nothing was written.",
          { field: `${formFileName(plan.form.key)}:name` },
        );
      }
    }
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
    const applied = { settings: false, definition: false };
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
          ...settings,
        }, pages?.pathById);
      } else if (plan.action === "update") {
        // Enabling newsletter capture checks the stored definition, so its new
        // email and consent fields must land first. Disabling must do the reverse.
        const definitionFirst = plan.settingsChanged && plan.versionChanged
          && settings.sink === "none" && desired.sink === "newsletter";
        for (const mutation of definitionFirst ? ["definition", "settings"] : ["settings", "definition"]) {
          if (mutation === "settings") {
            if (!plan.settingsChanged) continue;
            settings = siteSettingsBaseline(
              await withRefusalGuidance(
                onProgress,
                "forms push",
                async () => await updateSiteFormSettings(client, siteId, formId, desired, plan.baseline.settings),
              ),
            );
            desired = projectFormForWorkspace({ ...desired, ...settings }, pages?.pathById);
          } else {
            if (!plan.versionChanged) continue;
            version = (await withRefusalGuidance(
              onProgress,
              "forms push",
              async () => await saveSiteFormVersion(client, siteId, formId, { ...desired, definition: plan.wireDefinition }, plan.baseline.version),
            )).version;
          }
          applied[mutation] = true;
          // A retry must recognize either write as its own, even if the next
          // mutation fails. Keep the other half of the baseline until it lands.
          manifest = withRecordedForm(manifest, form.key, { id: formId, version, settings });
          await writeManifest(config.workspaceDir, manifest);
        }
      }
    } catch (caught) {
      // The site checks the recorded version and settings under its own lock,
      // which is what closes the gap between the comparison above and the write.
      const error = caught instanceof ApiError && (caught.hasField("ExpectedVersion") || caught.hasField("ExpectedSettings"))
        ? changedOnTheSite(form.key, caught, applied)
        : caught;
      if (error instanceof SiteAuthoringError) {
        const completed = results.filter((item) => item.action !== "unchanged").map((item) => item.key);
        if (applied.settings || applied.definition) completed.push(form.key);
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
    ...(plans.some((plan) => plan.action === "create" || plan.versionChanged) ? { nextStep: "deploy --staging" } : {}),
  });
}
