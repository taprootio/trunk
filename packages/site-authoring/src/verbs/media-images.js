import { getSiteImageDescription, listSiteImageDescriptions, updateSiteImageDescription, withRefusalGuidance } from "../api.js";
import { VERB_MEDIA_IMAGES_DESCRIBE, VERB_MEDIA_IMAGES_GET, VERB_MEDIA_IMAGES_LIST } from "../constants.js";
import { SiteAuthoringError } from "../errors.js";
import { imageDescriptionOptions, imageListOptions, requireImageId } from "../image-description-contract.js";
import { serializeResult } from "../output.js";
import { openSession, successResult, warnIfExternalWritesPaused } from "../session.js";
import { ApiError } from "../transport.js";

export async function mediaImagesList(invocation) {
  const options = imageListOptions(invocation);
  const { client, siteId, onProgress } = await openSession(invocation);
  const images = await withRefusalGuidance(onProgress, VERB_MEDIA_IMAGES_LIST, () =>
    listSiteImageDescriptions(client, siteId, options));
  const result = successResult(VERB_MEDIA_IMAGES_LIST, siteId, {
    images: { ...images, count: images.items.length, missingDescription: options.missingDescription },
  });
  try {
    serializeResult(result);
  } catch (error) {
    if (!(error instanceof SiteAuthoringError) || error.code !== "output.too_large") throw error;
    throw new SiteAuthoringError("media.image_page_too_large",
      "This page exceeds the output bound. Repeat the same cursor with a smaller --page-size; no items were omitted.",
      { field: "pageSize" });
  }
  onProgress(`${images.items.length} image(s) returned${images.nextPageToken ? "; use images.nextPageToken for the next page" : ""}.`);
  return result;
}

export async function mediaImagesGet(invocation) {
  const imageId = requireImageId(invocation.imageId);
  const { client, siteId, onProgress } = await openSession(invocation);
  const image = await withRefusalGuidance(onProgress, VERB_MEDIA_IMAGES_GET, () =>
    getSiteImageDescription(client, siteId, imageId));
  onProgress(`Read image ${image.imageId}, description revision ${image.descriptionRevision}.`);
  return successResult(VERB_MEDIA_IMAGES_GET, siteId, { image });
}

/**
 * What a refused description write means to its caller (TR01372 shares it with `pages push
 * --describe-missing-images`): a moved revision, an existing default under the condition, or text the server
 * refused, each as its own code. Any other failure is returned as it is.
 */
export function translateImageDescriptionRefusal(error) {
  if (error instanceof ApiError && error.hasField("ExpectedRevision")) {
    return new SiteAuthoringError("media.image_description_conflict",
      "The description changed. Read it with 'media images get', reconcile the text, and supply that revision.",
      { field: "expectedRevision", status: error.status });
  }
  if (error instanceof ApiError && error.hasField("OnlyIfMissing")) {
    return new SiteAuthoringError("media.image_description_exists", "This image already has a default description; nothing changed.",
      { field: "onlyIfMissing", status: error.status });
  }
  if (error instanceof ApiError && error.hasField("DefaultDescription")) {
    return new SiteAuthoringError("media.image_description_invalid",
      error.descriptionFor("DefaultDescription") ?? "Taproot refused the default description.",
      { field: "defaultDescription", status: error.status });
  }
  return error;
}

export async function mediaImagesDescribe(invocation) {
  const imageId = requireImageId(invocation.imageId);
  const body = imageDescriptionOptions(invocation);
  const session = await openSession(invocation);
  warnIfExternalWritesPaused(session, VERB_MEDIA_IMAGES_DESCRIBE);
  const { client, siteId, onProgress } = session;
  const image = await withRefusalGuidance(onProgress, VERB_MEDIA_IMAGES_DESCRIBE, async () => {
    try {
      return await updateSiteImageDescription(client, siteId, imageId, body);
    } catch (error) {
      throw translateImageDescriptionRefusal(error);
    }
  });
  onProgress(`Saved image ${image.imageId}, description revision ${image.descriptionRevision}. Deploy to update published usages.`);
  return successResult(VERB_MEDIA_IMAGES_DESCRIBE, siteId, { image });
}
