import {
  confirmImageUpload,
  IMAGE_OWNERSHIP_SCOPE_SITE,
  IMAGE_PROCESSING_STATE_COMPLETE,
  IMAGE_PROCESSING_STATE_FAILED,
  listSiteImages,
  normalizeImage,
  poll,
  requestImageUpload,
  withRefusalGuidance,
} from "../api.js";
import { LIMITS, VERB_MEDIA_UPLOAD } from "../constants.js";
import { SiteAuthoringError } from "../errors.js";
import { contentHash, inspectImageBytes } from "../image-metadata.js";
import { boundedList, openSession, successResult } from "../session.js";
import {
  ensureWorkspaceRoot,
  inspectWorkspaceEntry,
  MEDIA_DIRECTORY,
  MEDIA_MANIFEST_FILE_NAME,
  MEDIA_MANIFEST_VERSION,
  readMediaManifest,
  readWorkspaceFile,
  SAFE_MEDIA_SEGMENT,
  walkWorkspaceFiles,
  WORKSPACE_LIMITS,
  writeMediaManifest,
} from "../workspace.js";

/**
 * `media upload` — hash, request, PUT, confirm, then wait for processing.
 *
 * The client computes the SHA-256 and the pixel dimensions before it asks for
 * anything, because `RequestImageUpload` needs all three: the hash drives the
 * dedup short-circuit, and the dimensions are recorded with the image. When the
 * response reports `isDuplicate`, the presigned PUT and the confirm are both
 * skipped and the returned image is used as-is — re-uploading identical bytes
 * would spend the site's storage budget to produce the row it already has.
 *
 * Otherwise the signed capability goes to `SiteApiClient.upload`, which echoes
 * `requiredHeaders` verbatim: those values are covered by the signature, so a
 * regenerated `Content-Type` turns into an opaque object-store 403.
 *
 * Processing is observed through `ListSiteImages`; `GetImageById` is
 * session-only under TR00602's read list.
 *
 * What gets uploaded comes from the positional arguments — files, directories,
 * or both — and from the workspace's `media/` directory when none are given.
 *
 * The workspace media manifest this writes is what `pages push` resolves image
 * references against, and it is deliberately a separate file from the pull
 * manifest: uploading media into a workspace that was never pulled is
 * legitimate, and minting a pull manifest here would let `pages push` mistake
 * it for evidence of a pull that never happened.
 */

const MAXIMUM_REPORTED = 200;
const MAXIMUM_FILES = 500;
const MEDIA_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
const MEDIA_WALK_OPTIONS = Object.freeze({
  segmentPattern: SAFE_MEDIA_SEGMENT,
  segmentDescription: "letters, digits, '.', '_', '-', and '@'",
});

function requireUploadCapability(response, fileName) {
  if (
    typeof response.presignedUrl !== "string"
    || response.presignedUrl === ""
    || typeof response.uploadId !== "string"
    || response.uploadId === ""
  ) {
    throw new SiteAuthoringError(
      "media.upload_capability_invalid",
      `Taproot did not return a usable upload capability for '${fileName}'.`,
      { field: fileName },
    );
  }
  return { url: response.presignedUrl, requiredHeaders: response.requiredHeaders };
}

function fileNameOf(relativePath) {
  return relativePath.slice(relativePath.lastIndexOf("/") + 1);
}

/**
 * Normalizes one positional into the workspace-relative form the workspace
 * helpers accept: `./media/hero.png` and `media/` and `media` all name the same
 * thing to a person typing them, and none of the three should be a different
 * outcome.
 */
function normalizePositional(value) {
  return typeof value === "string" ? value.replace(/^\.\//u, "").replace(/\/+$/u, "") : "";
}

/**
 * Expands the positional arguments into the concrete files to upload. A
 * directory is walked for media the way a bare invocation walks `media/`; a
 * regular file is taken as named, and its container is validated from its bytes
 * rather than its extension. Anything else — a missing path, a symlink, a
 * device — is refused by name rather than surfacing later as an unrelated
 * "not a regular file" from the read.
 */
async function resolveUploadTargets(workspaceDir, positionals) {
  const files = [];
  const seen = new Set();
  for (const positional of positionals) {
    const candidate = normalizePositional(positional);
    if (candidate === "") {
      throw new SiteAuthoringError(
        "media.path_invalid",
        `'${positional}' does not name a file or directory relative to the workspace root.`,
        { field: positional },
      );
    }
    const kind = await inspectWorkspaceEntry(workspaceDir, candidate);
    if (kind === "missing" || kind === "other") {
      throw new SiteAuthoringError(
        "media.path_invalid",
        `'${candidate}' is neither a media file nor a directory relative to the workspace root.`,
        { field: candidate },
      );
    }
    const expanded = kind === "directory"
      ? await walkWorkspaceFiles(workspaceDir, candidate, MEDIA_EXTENSIONS, MEDIA_WALK_OPTIONS)
      : [candidate];
    for (const file of expanded) {
      // Overlapping positionals — a directory and a file inside it — upload
      // each file once.
      if (seen.has(file)) continue;
      seen.add(file);
      files.push(file);
    }
  }
  return files;
}

async function waitForProcessing(client, siteId, imageIds, { onProgress, now }) {
  const pending = new Set(imageIds);
  if (pending.size === 0) return new Map();
  const observed = new Map();
  return await poll({
    client,
    now,
    onProgress,
    timeoutMilliseconds: LIMITS.uploadMilliseconds,
    // The poller's `{ deadline, now }` travels into every page of the listing,
    // so the bound holds *within* one read of a large library and not only
    // between reads.
    read: async (requestOptions) => (await listSiteImages(client, siteId, requestOptions)).images,
    evaluate: (images) => {
      for (const image of images) {
        if (!pending.has(image.imageId)) continue;
        observed.set(image.imageId, image);
      }
      const waiting = [...pending].filter((imageId) => {
        const state = observed.get(imageId)?.processingState;
        return state !== IMAGE_PROCESSING_STATE_COMPLETE && state !== IMAGE_PROCESSING_STATE_FAILED;
      });
      if (waiting.length === 0) return { done: true, value: observed };
      return { done: false, progress: `Waiting for ${waiting.length} image(s) to finish processing.` };
    },
    timeoutCode: "media.processing_timeout",
  });
}

export async function mediaUpload(invocation) {
  const { client, config, siteId, now, onProgress } = await openSession(invocation);
  await ensureWorkspaceRoot(config);

  // Positional arguments name the files or directories to upload — `cli.js`
  // hands them over as `paths`, and a programmatic caller can supply the same
  // key directly. With none, the workspace's own `media/` directory is walked.
  // Read before anything is selected or sent: a media manifest from another
  // site holds image ids this site cannot deliver, and appending to it would
  // mix two sites' media in one file.
  const mediaManifest = await readMediaManifest(config.workspaceDir, siteId);

  const selected = Array.isArray(invocation.paths) ? invocation.paths.filter((value) => value !== "") : [];
  const files = selected.length > 0
    ? await resolveUploadTargets(config.workspaceDir, selected)
    : await walkWorkspaceFiles(config.workspaceDir, MEDIA_DIRECTORY, MEDIA_EXTENSIONS, MEDIA_WALK_OPTIONS);
  if (files.length === 0) {
    throw new SiteAuthoringError(
      "media.none_found",
      selected.length > 0
        ? `No PNG, JPEG, GIF, or WebP files were found under ${selected.map((value) => `'${value}'`).join(", ")}.`
        : `No PNG, JPEG, GIF, or WebP files were found under '${MEDIA_DIRECTORY}/' in the workspace.`,
      { field: selected.length > 0 ? normalizePositional(selected[0]) : MEDIA_DIRECTORY },
    );
  }
  if (files.length > MAXIMUM_FILES) {
    throw new SiteAuthoringError(
      "media.too_many_files",
      `This run would upload ${files.length} files, more than the bounded maximum of ${MAXIMUM_FILES}.`,
      { field: MEDIA_DIRECTORY },
    );
  }

  const uploaded = [];

  return await withRefusalGuidance(onProgress, "upload", async () => {
    try {
      for (const file of files) {
        const fileName = fileNameOf(file);
        const bytes = await readWorkspaceFile(config.workspaceDir, file, WORKSPACE_LIMITS.mediaBytes);
        const { contentType, width, height } = inspectImageBytes(bytes, file);
        const hash = contentHash(bytes);
        onProgress(`Requesting an upload for '${file}' (${contentType}, ${width}x${height}).`);
        const response = await requestImageUpload(client, {
          fileName,
          contentType,
          fileSize: bytes.byteLength,
          contentHash: hash,
          width,
          height,
          ownershipScope: IMAGE_OWNERSHIP_SCOPE_SITE,
          siteId,
        });

        let image;
        let deduplicated = false;
        if (response.isDuplicate === true) {
          // The dedup hit *is* the existing image. There is nothing to PUT and
          // nothing to confirm.
          deduplicated = true;
          image = normalizeImage(response.image);
          onProgress(`'${file}' matched an existing image by content hash; skipping the upload.`);
        } else {
          await client.upload(requireUploadCapability(response, file), bytes);
          const confirmation = await confirmImageUpload(client, response.uploadId);
          image = normalizeImage(confirmation.image);
          onProgress(`Uploaded and confirmed '${file}'.`);
        }

        mediaManifest.media[file] = {
          imageId: image.imageId,
          contentHash: hash,
          contentType,
          width: width || image.width,
          height: height || image.height,
          byteLength: bytes.byteLength,
          // Preserve the author-owned alt text. Delivery fields start with
          // whatever confirm returned and are refreshed from the completed
          // library record below.
          alt: typeof mediaManifest.media[file]?.alt === "string" ? mediaManifest.media[file].alt : "",
          src: image.url,
          urls: image.responsiveUrls,
          deduplicated,
        };
        uploaded.push({ file, imageId: image.imageId, deduplicated, contentType, width, height });
      }
    } finally {
      // Written before processing is awaited: an image that fails to process
      // still exists, and losing its id would orphan it. The site is recorded
      // with it, because an image id means nothing without one.
      mediaManifest.mediaManifestVersion = MEDIA_MANIFEST_VERSION;
      mediaManifest.siteId = siteId;
      if (uploaded.length > 0) await writeMediaManifest(config.workspaceDir, mediaManifest);
    }

    onProgress("Waiting for image processing to finish.");
    const observed = await waitForProcessing(client, siteId, uploaded.map((entry) => entry.imageId), {
      onProgress,
      now,
    });
    const failed = uploaded
      .map((entry) => ({ ...entry, processingState: observed.get(entry.imageId)?.processingState }))
      .filter((entry) => entry.processingState === IMAGE_PROCESSING_STATE_FAILED);
    if (failed.length > 0) {
      throw new SiteAuthoringError(
        "media.processing_failed",
        `Taproot failed to process ${failed.length} uploaded image(s), starting with '${failed[0].file}'. `
          + `They are recorded in ${MEDIA_MANIFEST_FILE_NAME} but cannot be published.`,
        { field: failed[0].file, status: IMAGE_PROCESSING_STATE_FAILED },
      );
    }

    // Processing is the point at which the delivery contract is complete.
    // Persist and report the exact object shape component media fields accept,
    // so an author never has to invent empty `src`/`urls` placeholders.
    for (const entry of uploaded) {
      const image = observed.get(entry.imageId);
      const manifestEntry = mediaManifest.media[entry.file];
      if (image === undefined || manifestEntry === undefined) continue;
      manifestEntry.src = image.url;
      manifestEntry.urls = image.responsiveUrls;
    }
    await writeMediaManifest(config.workspaceDir, mediaManifest);

    const reported = boundedList(
      uploaded.map((entry) => ({
        file: entry.file,
        imageId: entry.imageId,
        deduplicated: entry.deduplicated,
        width: entry.width,
        height: entry.height,
        processingState: observed.get(entry.imageId)?.processingState ?? IMAGE_PROCESSING_STATE_COMPLETE,
        media: {
          imageId: entry.imageId,
          src: observed.get(entry.imageId)?.url ?? "",
          urls: observed.get(entry.imageId)?.responsiveUrls ?? [],
          width: entry.width,
          height: entry.height,
          alt: mediaManifest.media[entry.file]?.alt ?? "",
        },
      })),
      MAXIMUM_REPORTED,
    );
    return successResult(VERB_MEDIA_UPLOAD, siteId, {
      mediaManifestFile: MEDIA_MANIFEST_FILE_NAME,
      media: {
        total: uploaded.length,
        deduplicated: uploaded.filter((entry) => entry.deduplicated).length,
        items: reported.items,
        ...(reported.truncated ? { itemsTruncated: true } : {}),
      },
    });
  });
}
