import { listSiteForms } from "./forms-api.js";
import { contentDocuments, parseComponentData } from "./typed-pages.js";

/**
 * Where the workspace and the site spell a placed form differently (TR01216).
 *
 * A workspace names a form by its key, as `forms/<key>.json` and the Markdown
 * `form` fence do, so the same workspace can be pushed to a fresh site whose
 * ids all differ. A page stored on the site names the form by its id. `pages
 * push` turns keys into ids on the way out and `pages pull` turns ids back
 * into keys, the way a form's `page_path` and `page_resource_id` already
 * translate. The translation is block-scoped: a `formKey` anywhere but a `form`
 * component block is author prose.
 */

const FORM_COMPONENT = "form";

/** Each `form` component block in the document's content documents, with its parsed data. */
function formBlocks(document_) {
  const found = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value !== null && typeof value === "object") {
      if (value.type === "componentBlock" && value.attrs?.componentType === FORM_COMPONENT) {
        const data = typeof value.attrs.componentData === "string"
          ? parseComponentData(value.attrs.componentData)
          : undefined;
        if (data !== null && typeof data === "object" && !Array.isArray(data)) found.push({ attrs: value.attrs, data });
        return;
      }
      Object.values(value).forEach(visit);
    }
  };
  for (const { doc } of contentDocuments(document_)) visit(doc);
  return found;
}

/** The distinct form keys a workspace document places, in document order. */
export function placedFormKeys(document_) {
  const keys = [];
  for (const { data } of formBlocks(document_)) {
    if (typeof data.formKey === "string" && data.formKey !== "" && !keys.includes(data.formKey)) keys.push(data.formKey);
  }
  return keys;
}

/** Whether a document read from the site places any form by id. */
export function placesFormIds(document_) {
  return formBlocks(document_).some(({ data }) => typeof data.formId === "string");
}

/**
 * A copy of the document with every placed form named by id, for the wire. A key
 * the index does not know is left as it is: `placedFormProblems` has already
 * refused the push for it, so nothing sends it.
 */
export function withFormIds(document_, idByKey) {
  return translate(document_, (data) => {
    const id = typeof data.formKey === "string" ? idByKey.get(data.formKey) : undefined;
    if (id === undefined) return undefined;
    const rest = { ...data };
    delete rest.formKey;
    return { ...rest, formId: id };
  });
}

/**
 * A copy of a document read from the site with every placed form named by key,
 * for the workspace. An id the site no longer has stays an id: pull must not hide
 * what the site holds, and a push of that file is refused until the author picks a form.
 */
export function withFormKeys(document_, keyById) {
  return translate(document_, (data) => {
    const key = typeof data.formId === "string" ? keyById.get(data.formId) : undefined;
    if (key === undefined) return undefined;
    const rest = { ...data };
    delete rest.formId;
    return { ...rest, formKey: key };
  });
}

function translate(document_, convert) {
  const copy = structuredClone(document_);
  for (const { attrs, data } of formBlocks(copy)) {
    const converted = convert(data);
    if (converted !== undefined) attrs.componentData = JSON.stringify(converted);
  }
  return copy;
}

/** The site's forms by key and by id, archived ones marked. One request serves a whole push or pull. */
export async function readFormIndex(client, siteId) {
  const idByKey = new Map();
  const keyById = new Map();
  const archivedKeys = new Set();
  for (const form of await listSiteForms(client, siteId)) {
    keyById.set(form.id, form.key);
    if (form.archived) archivedKeys.add(form.key);
    else idByKey.set(form.key, form.id);
  }
  return { idByKey, keyById, archivedKeys };
}
