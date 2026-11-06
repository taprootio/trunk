import { normalizeImageDescriptionRevision } from "./content/image-description-validation.js";
import { LIMITS } from "./constants.js";
import { hasControlCharacter, SiteAuthoringError } from "./errors.js";

export const IMAGE_LIST_DEFAULT_PAGE_SIZE = 25;
export const IMAGE_LIST_MAXIMUM_PAGE_SIZE = 100;
const IMAGE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

export function isImageId(value) {
  return typeof value === "string" && IMAGE_ID.test(value) && value !== "00000000-0000-0000-0000-000000000000";
}

export function requireImageId(value) {
  if (!isImageId(value)) {
    throw new SiteAuthoringError("media.image_id_invalid", "Name exactly one canonical lowercase image UUID.", {
      field: "imageId", exitCode: 2,
    });
  }
  return value;
}

export { normalizeImageDescriptionRevision as imageDescriptionRevision } from "./content/image-description-validation.js";

export function imageListOptions(invocation = {}) {
  const pageSize = invocation.pageSize === undefined ? IMAGE_LIST_DEFAULT_PAGE_SIZE : Number(invocation.pageSize);
  if ((invocation.pageSize !== undefined && !["number", "string"].includes(typeof invocation.pageSize))
    || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > IMAGE_LIST_MAXIMUM_PAGE_SIZE
    || (typeof invocation.pageSize === "string" && !/^[1-9][0-9]*$/u.test(invocation.pageSize))) {
    throw new SiteAuthoringError("media.image_page_size_invalid", "--page-size must be a whole number from 1 to 100.", {
      field: "pageSize", exitCode: 2,
    });
  }
  const pageToken = invocation.pageToken ?? "";
  if (typeof pageToken !== "string" || !pageToken.isWellFormed()
    || Buffer.byteLength(pageToken, "utf8") > LIMITS.configPathBytes) {
    throw new SiteAuthoringError("media.image_page_token_invalid", "--page-token must be the cursor from the previous result.", {
      field: "pageToken", exitCode: 2,
    });
  }
  return { pageSize, pageToken, missingDescription: invocation.missingDescription === true };
}

export function imageDescriptionOptions(invocation = {}) {
  const hasDescription = invocation.imageDescription !== undefined;
  const clear = invocation.clearDescription === true;
  if (hasDescription === clear) {
    throw new SiteAuthoringError("media.image_description_choice", "Supply exactly one of --description or --clear.", {
      field: "description", exitCode: 2,
    });
  }
  const description = clear ? "" : invocation.imageDescription;
  if (typeof description !== "string" || !description.isWellFormed()
    || Buffer.byteLength(description, "utf8") > LIMITS.configBytes) {
    throw new SiteAuthoringError("media.image_description_invalid", "--description needs bounded, valid Unicode text.", {
      field: "description", exitCode: 2,
    });
  }
  const expectedRevision = normalizeImageDescriptionRevision(invocation.expectedRevision);
  if (expectedRevision === undefined) {
    throw new SiteAuthoringError("media.image_revision_required",
      "Supply --expected-revision from the image's list/get result, as a nonnegative int64 decimal integer.", {
        field: "expectedRevision", exitCode: 2,
      });
  }
  const onlyIfMissing = invocation.onlyIfMissing === true;
  if (onlyIfMissing && description.trim() === "") {
    throw new SiteAuthoringError("media.image_condition_clear", "--if-missing cannot clear a description.", {
      field: "onlyIfMissing", exitCode: 2,
    });
  }
  return { defaultDescription: description, expectedRevision, onlyIfMissing };
}

export function safeImagePreviewUrl(value) {
  if (typeof value !== "string" || !value.isWellFormed() || value.length > LIMITS.configPathBytes
    || hasControlCharacter(value) || /[\s\\]/u.test(value)) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === ""
        && url.search === "" && url.hash === "" ? url.href : "";
  } catch {
    return "";
  }
}
