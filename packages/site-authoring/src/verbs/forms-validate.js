import { VERB_FORMS_VALIDATE } from "../constants.js";
import { SiteAuthoringError } from "../errors.js";
import { readWorkspaceForms } from "../forms-workspace.js";
import { openAnonymousSession, successResult } from "../session.js";

/**
 * `forms validate` — prove the workspace's form files offline.
 *
 * It runs the same file contract and the same shared field validator
 * `forms push` does, so a file that passes here is not refused for its shape
 * by the push. It cannot prove what only the site knows: whether the key is
 * already taken by a form someone else changed, or whether the caller may
 * write forms.
 */
export async function formsValidate(invocation) {
  const { config, onProgress } = await openAnonymousSession({ ...invocation, client: null });
  if (config === undefined) {
    throw new SiteAuthoringError(
      "config.not_found",
      "No taproot-site.json was found. forms validate reads the workspace it names.",
    );
  }
  const forms = await readWorkspaceForms(config.workspaceDir, invocation.formKeys);
  onProgress(`Validated ${forms.length} form file${forms.length === 1 ? "" : "s"}.`);
  return successResult(VERB_FORMS_VALIDATE, undefined, {
    forms: {
      count: forms.length,
      items: forms.map((form) => ({
        key: form.key,
        file: form.file,
        fields: form.document.definition.fields.length,
        sink: form.document.sink ?? "none",
      })),
    },
  });
}
