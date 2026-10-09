import { Readable } from "node:stream";

import {
  confirmImageUpload,
  confirmVideoUpload,
  IMAGE_OWNERSHIP_SCOPE_SITE,
  IMAGE_PROCESSING_STATE_COMPLETE,
  IMAGE_PROCESSING_STATE_FAILED,
  listSiteImages,
  listVideos,
  normalizeImage,
  poll,
  requestImageUpload,
  requestVideoUpload,
  withRefusalGuidance,
} from "../api.js";
import { LIMITS, VERB_MEDIA_UPLOAD } from "../constants.js";
import { SiteAuthoringError, sanitizeDiagnostic } from "../errors.js";
import { contentHash, inspectImageBytes } from "../image-metadata.js";
import { CHECK_AREA, collectProblems, problemsOf } from "../problems.js";
import { ApiError } from "../transport.js";
import { sniffVideoContentType, VIDEO_EXTENSIONS, videoTooLarge } from "../video-metadata.js";
import { mp4Name, prepareVideoFile, videoAcceptance } from "../video-prepare.js";
import { boundedByBytes, openSession, successResult, warnIfExternalWritesPaused } from "../session.js";
import {
  ensureWorkspaceRoot,
  inspectWorkspaceEntry,
  MEDIA_DIRECTORY,
  MEDIA_MANIFEST_FILE_NAME,
  MEDIA_MANIFEST_VERSION,
  openWorkspaceFileStream,
  readMediaManifest,
  readWorkspaceFile,
  recordedAlt,
  resolveWorkspacePath,
  SAFE_MEDIA_SEGMENT,
  walkWorkspaceFiles,
  WORKSPACE_LIMITS,
  writeMediaManifest,
} from "../workspace.js";

/**
 * `media upload` — hash, request, PUT, confirm, then wait for processing.
 *
 * A file whose container is MP4, MOV or WebM takes the video path instead. Taproot does
 * not encode, so the file is read with mediabunny first: an H.264 and AAC file that is not
 * an MP4 with its index first is rewritten as one (copying the tracks, never re-encoding),
 * and the real codec strings are declared. `RequestVideoUpload`, a presigned PUT, and
 * `ConfirmVideoUpload` follow; the video is ready when confirm returns, with nothing to
 * wait for. The server decides what is accepted and its one-line refusal is printed as it
 * came. The container is read from the file's bytes, not its extension.
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

// Each list's share of the result's 64 KiB; the counts are always complete.
const ITEMS_BYTES = 24 * 1024;
const MAXIMUM_FILES = 500;
const MEDIA_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ...VIDEO_EXTENSIONS];
const MEDIA_WALK_OPTIONS = Object.freeze({
  segmentPattern: SAFE_MEDIA_SEGMENT,
  segmentDescription: "letters, digits, '.', '_', '-', and '@'",
});

/**
 * The files under `media/` an upload would still send (TR00823): an image
 * whose bytes the media manifest does not record, and a video with no
 * confirmed upload. Each is classified and checked against the limits the
 * upload applies, so a plan does not call ready a file the upload would
 * refuse, and carries an identity of its content, so a plan made before the
 * file was replaced does not describe it. A recorded upload is done only when
 * the site still holds it: an image processed (one still processing, or gone,
 * is sent again; the upload deduplicates and waits; one that failed is a
 * problem), a video in its library. `site` answers both:
 * `imageStates` maps the recorded image ids to what the site holds, and
 * `videos` is the video library as `listVideos` reads it. Read only.
 */
export async function pendingMediaFiles(workspaceDir, mediaManifest, site) {
  const files = await walkWorkspaceFiles(workspaceDir, MEDIA_DIRECTORY, MEDIA_EXTENSIONS, MEDIA_WALK_OPTIONS);
  const pending = [];
  const problems = [];
  const listedVideoIds = new Set(site.videos.videos.map((candidate) => candidate.videoId));
  for (const file of files) {
    const video = mediaManifest.videos?.[file];
    const image = mediaManifest.media?.[file];
    const entry = await collectProblems(problems, { area: CHECK_AREA.media, file }, async () => {
      if (typeof image?.imageId === "string") {
        const bytes = await readWorkspaceFile(workspaceDir, file, WORKSPACE_LIMITS.mediaBytes);
        if (image.contentHash === contentHash(bytes)) {
          const held = site.imageStates.get(image.imageId);
          if (held === IMAGE_PROCESSING_STATE_FAILED) {
            throw new SiteAuthoringError(
              "media.processing_failed",
              `Taproot failed to process '${file}' (image ${image.imageId}), so it cannot be published. Replace the `
                + "file with one that processes, or remove it and the references to it.",
              { field: file, status: IMAGE_PROCESSING_STATE_FAILED },
            );
          }
          if (held === IMAGE_PROCESSING_STATE_COMPLETE) return undefined;
        }
      }
      const { source, identity, bytes } = await mediaFileIdentity(workspaceDir, file);
      // One that still matches its confirmed video upload is done.
      if (
        typeof video?.videoId === "string"
        && video.pendingConfirm !== true
        && video.byteLength === source.byteLength
        && video.modifiedMilliseconds === source.modifiedMilliseconds
      ) {
        if (listedVideoIds.has(video.videoId)) return undefined;
        // The same refusal the upload gives: a listing cut short cannot say the video is gone.
        if (site.videos.truncated) throw videoLibraryUnverifiable(file, video.videoId, site.videos.videos.length);
      }
      if (sniffVideoContentType(source.header) !== undefined) {
        if (source.byteLength > WORKSPACE_LIMITS.videoBytes) throw videoTooLarge(file, WORKSPACE_LIMITS.videoBytes);
        const acceptance = await videoAcceptance({
          filePath: resolveWorkspacePath(workspaceDir, file),
          byteLength: source.byteLength,
        });
        if (!acceptance.accepted) {
          throw new SiteAuthoringError(
            "media.video_unsupported",
            acceptance.videoCodec === "" && acceptance.audioCodec === ""
              ? `'${file}' could not be read as a video, so the upload would be refused.`
              : `'${file}' is ${acceptance.videoCodec ? `${acceptance.videoCodec} video` : "no video"} with `
                + `${acceptance.audioCodec ? `${acceptance.audioCodec} audio` : "no audio"}. `
                + "Taproot accepts H.264 video with AAC audio or none: export it that way and upload it again.",
            { field: file },
          );
        }
        return { file, kind: "video", identity };
      }
      const { width, height } = inspectImageBytes(bytes, file);
      return { file, kind: "image", identity, width, height };
    });
    if (entry !== undefined) pending.push(entry);
  }
  if (pending.length > MAXIMUM_FILES) {
    problems.push(...problemsOf(tooManyFiles(pending.length), { area: CHECK_AREA.media }));
  }
  return { files: pending, problems };
}

/**
 * What a media file is, for telling a plan's file from a replaced one: a
 * video by its size and modification time, as the upload records it; anything
 * else by its bytes, which are returned too.
 */
async function mediaFileIdentity(workspaceDir, file) {
  const source = await openWorkspaceFileStream(workspaceDir, file, Number.MAX_SAFE_INTEGER);
  await source.close();
  if (sniffVideoContentType(source.header) !== undefined) {
    return { source, identity: `${source.byteLength}:${source.modifiedMilliseconds}` };
  }
  const bytes = await readWorkspaceFile(workspaceDir, file, WORKSPACE_LIMITS.mediaBytes);
  return { source, identity: contentHash(bytes), bytes };
}

function videoLibraryUnverifiable(file, videoId, listed) {
  return new SiteAuthoringError(
    "media.video_library_unverifiable",
    `'${file}' was uploaded as video ${videoId}, which is not among the first ${listed} videos of this `
      + "site's library, and the library is larger than one run can check. Remove the file's entry from "
      + `${MEDIA_MANIFEST_FILE_NAME} to upload it again, or leave it.`,
    { field: file },
  );
}

function tooManyFiles(count) {
  return new SiteAuthoringError(
    "media.too_many_files",
    `This run would upload ${count} files, more than the bounded maximum of ${MAXIMUM_FILES}.`,
    { field: MEDIA_DIRECTORY },
  );
}

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

function videoComponent(videoId) {
  const componentData = JSON.stringify({ videoId });
  return {
    markdown: `\`\`\`component:video\n${componentData}\n\`\`\``,
    block: { type: "componentBlock", attrs: { componentType: "video", componentData } },
  };
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

/**
 * Waits until every uploaded item has reached a terminal state in its library
 * listing, and returns what was last observed for each. One wait serves images
 * and videos: only what is read, how an entry is identified and which states
 * end the wait differ.
 */
async function waitForTerminalStates(client, ids, {
  read,
  idOf,
  stateOf,
  terminalStates,
  timeoutMilliseconds,
  timeoutCode,
  waitingMessage,
  onProgress,
  now,
}) {
  const pending = new Set(ids);
  if (pending.size === 0) return new Map();
  const observed = new Map();
  try {
    return await poll({
      client,
      now,
      onProgress,
      timeoutMilliseconds,
      // The poller's `{ deadline, now }` travels into every page of the listing,
      // so the bound holds *within* one read of a large library and not only
      // between reads.
      read,
      evaluate: (entries) => {
        for (const entry of entries) {
          if (pending.has(idOf(entry))) observed.set(idOf(entry), entry);
        }
        const waiting = [...pending].filter((id) => !terminalStates.includes(stateOf(observed.get(id))));
        if (waiting.length === 0) return { done: true, value: observed };
        return { done: false, progress: waitingMessage(waiting.length) };
      },
      timeoutCode,
    });
  } catch (error) {
    // What was observed before the deadline travels with the refusal, so a
    // caller can still record the items that did reach a terminal state.
    if (error instanceof SiteAuthoringError) error.observed = observed;
    throw error;
  }
}

/**
 * `byId` reads the named images directly instead of paging the library, for an image
 * the library never lists (a copied embed poster).
 */
export function waitForProcessing(client, siteId, imageIds, { onProgress, now, byId = false }) {
  return waitForTerminalStates(client, imageIds, {
    read: async (requestOptions) =>
      (await listSiteImages(client, siteId, requestOptions, byId ? { imageIds } : {})).images,
    idOf: (image) => image.imageId,
    stateOf: (image) => image?.processingState,
    terminalStates: [IMAGE_PROCESSING_STATE_COMPLETE, IMAGE_PROCESSING_STATE_FAILED],
    timeoutMilliseconds: LIMITS.uploadMilliseconds,
    timeoutCode: "media.processing_timeout",
    waitingMessage: (count) => `Waiting for ${count} image(s) to finish processing.`,
    onProgress,
    now,
  });
}

/** Where the server words a refusal of a video upload; the line is printed as it came. */
const VIDEO_REFUSAL_FIELDS = Object.freeze([
  "VideoCodec",
  "AudioCodec",
  "FileName",
  "SiteId",
  "UploadId",
  "ContentType",
  "SizeBytes",
  "Video",
  "UpgradePrompt",
  "VideoNotIncluded",
]);

/**
 * The server is the single authority for refusing a video, so its one-line message is shown
 * rather than the generic "rejected the request field" the transport would give. Anything
 * that is not such a refusal is rethrown unchanged.
 */
function surfaceVideoRefusal(error, file) {
  if (error instanceof ApiError) {
    for (const field of VIDEO_REFUSAL_FIELDS) {
      const description = error.descriptionFor?.(field);
      if (typeof description === "string" && description !== "") {
        return new SiteAuthoringError(
          "media.video_refused",
          `'${file}': ${sanitizeDiagnostic(description, "Taproot refused this video.")}`,
          { field: file },
        );
      }
    }
  }
  return error;
}

/**
 * Uploads one video: prepare it, request, a PUT, confirm. Returns null when the file is not a
 * video container, so the caller takes the image path. The file is opened once for the size
 * and the prefix and held open across the PUT's retries, each of which streams it again from
 * the start; a file that had to be remuxed is sent from memory (it is at most the largest
 * licence cap).
 *
 * Unlike an image, a video has no content hash to short-circuit on, and a re-run would upload
 * every file again, each a new library entry and a new quota reservation. So an unchanged file
 * this workspace already uploaded (the recorded size and modification time match) is reused when
 * the site's library still holds that video.
 *
 * The upload id is recorded before the bytes are sent, and confirming an upload id twice returns
 * the same video. So a PUT or a confirm whose answer was lost is resumed by the next run (the
 * confirm says whether the object arrived; if it did not, the file is sent again), not repeated
 * as a second reservation. A 412 on a retried create-only PUT means it had already landed.
 */
async function uploadVideoFile({
  client,
  config,
  siteId,
  file,
  fileName,
  recorded,
  readLibrary,
  recordPending,
  onProgress,
}) {
  // Opened with no size bound of its own: the video limit is checked below, once
  // the container says this is a video, so an oversized video is named as one and
  // not as a generic file that is too large.
  const source = await openWorkspaceFileStream(config.workspaceDir, file, Number.MAX_SAFE_INTEGER);
  try {
    if (sniffVideoContentType(source.header) === undefined) return null;
    if (source.byteLength > WORKSPACE_LIMITS.videoBytes) {
      throw videoTooLarge(file, WORKSPACE_LIMITS.videoBytes);
    }
    const contentType = "video/mp4";
    const base = {
      contentType,
      byteLength: source.byteLength,
      modifiedMilliseconds: source.modifiedMilliseconds,
    };
    if (
      recorded?.byteLength === source.byteLength
      && recorded?.modifiedMilliseconds === source.modifiedMilliseconds
      && typeof recorded?.videoId === "string"
    ) {
      if (recorded.pendingConfirm === true) {
        // The recorded id is an upload that may never have become a video, so
        // the library cannot be asked about it: confirming is the only check.
        try {
          const video = await confirmVideoUpload(client, siteId, recorded.videoId);
          onProgress(`Confirmed the earlier upload of '${file}'; the video is ready.`);
          return { video, deduplicated: false, ...base };
        } catch (error) {
          // A client-side refusal (the reservation expired, say) means that upload
          // cannot be confirmed any more, so the file is sent again; a server
          // error, a throttle or a lost connection is transient or ambiguous and
          // is left for the next run.
          const refused = error instanceof ApiError
            && error.httpStatus >= 400
            && error.httpStatus < 500
            && ![408, 425, 429].includes(error.httpStatus);
          if (!refused) throw error;
        }
      } else {
        const { byId, truncated } = await readLibrary();
        const existing = byId.get(recorded.videoId);
        if (existing !== undefined) {
          onProgress(`'${file}' is unchanged since it was uploaded as video ${existing.videoId}; skipping the upload.`);
          return { video: existing, deduplicated: true, ...base };
        }
        // A listing cut short cannot say the video is gone, and uploading again
        // would spend storage on a video that may well be there.
        if (truncated) {
          throw videoLibraryUnverifiable(file, recorded.videoId, byId.size);
        }
      }
    }
    onProgress(`Checking '${file}' (${source.byteLength} bytes).`);
    const prepared = await prepareVideoFile({
      filePath: resolveWorkspacePath(config.workspaceDir, file),
      byteLength: source.byteLength,
    });
    // The prepare step reopened the file by path, so prove it is still the file that was opened
    // before anything is requested or sent.
    await source.verifyUnchanged();
    const sent = prepared.remuxed === null
      ? { byteLength: source.byteLength, stream: source.stream }
      : { byteLength: prepared.remuxed.byteLength, stream: () => Readable.from([prepared.remuxed]) };
    if (prepared.remuxed !== null) {
      onProgress(`Rewrote '${file}' as an MP4 with its index first, without re-encoding (${sent.byteLength} bytes).`);
    }
    let response;
    try {
      response = await requestVideoUpload(client, siteId, {
        fileName: mp4Name(fileName),
        contentType,
        sizeBytes: sent.byteLength,
        videoCodec: prepared.videoCodec,
        audioCodec: prepared.audioCodec,
      });
    } catch (error) {
      throw surfaceVideoRefusal(error, file);
    }
    const capability = requireUploadCapability(response, file);
    // Recorded before the bytes are sent: a PUT can land while its answer is lost, and the
    // next run must find this upload id and confirm it, not reserve and send the file again.
    await recordPending(response.uploadId, base);
    try {
      await client.upload(capability, {
        byteLength: sent.byteLength,
        stream: sent.stream,
        timeoutMilliseconds: LIMITS.videoUploadMilliseconds,
      });
    } catch (error) {
      // The upload is create-only, so a retry after a PUT that landed is refused with 412: the
      // object is in place, and confirm checks it.
      if (!(error instanceof SiteAuthoringError && error.code === "upload.rejected" && error.status === "http:412")) {
        throw error;
      }
      onProgress(`The upload of '${file}' had already landed; confirming it.`);
    }
    // The PUT streamed the opened length. If the file grew or was rewritten
    // meanwhile, what Taproot holds is not the file on disk, so it is not confirmed.
    await source.verifyUnchanged();
    let video;
    try {
      video = await confirmVideoUpload(client, siteId, response.uploadId);
    } catch (error) {
      throw surfaceVideoRefusal(error, file);
    }
    onProgress(`Uploaded and confirmed '${file}'; the video is ready.`);
    return { video, deduplicated: false, ...base };
  } finally {
    await source.close();
  }
}

export async function mediaUpload(invocation) {
  const session = await openSession(invocation);
  const { client, config, siteId, now, onProgress } = session;
  // One advisory line before this verb does any work, and only when the
  // exchange said the platform is paused. It changes nothing else: the write
  // still runs and its refusal still classifies as platform_paused (TR00692).
  warnIfExternalWritesPaused(session, VERB_MEDIA_UPLOAD);
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
        ? `No PNG, JPEG, GIF, WebP, MP4, MOV, or WebM files were found under ${
          selected.map((value) => `'${value}'`).join(", ")
        }.`
        : `No PNG, JPEG, GIF, WebP, MP4, MOV, or WebM files were found under '${MEDIA_DIRECTORY}/' in the workspace.`,
      { field: selected.length > 0 ? normalizePositional(selected[0]) : MEDIA_DIRECTORY },
    );
  }
  if (files.length > MAXIMUM_FILES) throw tooManyFiles(files.length);

  const uploaded = [];
  const uploadedVideos = [];
  mediaManifest.videos ??= {};
  // One read of the site's videos serves every unchanged file in the run, and
  // only when there is a recorded upload to check.
  let library;
  const readLibrary = async () => {
    if (library === undefined) {
      const listing = await listVideos(client, siteId);
      library = {
        byId: new Map(listing.videos.map((video) => [video.videoId, video])),
        truncated: listing.truncated,
      };
    }
    return library;
  };

  return await withRefusalGuidance(onProgress, "upload", async () => {
    try {
      for (const file of files) {
        const fileName = fileNameOf(file);
        const videoUpload = await uploadVideoFile({
          client,
          config,
          siteId,
          file,
          fileName,
          recorded: mediaManifest.videos[file],
          readLibrary,
          recordPending: async (videoId, base) => {
            mediaManifest.videos[file] = { videoId, ...base, pendingConfirm: true };
            mediaManifest.mediaManifestVersion = MEDIA_MANIFEST_VERSION;
            mediaManifest.siteId = siteId;
            await writeMediaManifest(config.workspaceDir, mediaManifest);
          },
          onProgress,
        });
        if (videoUpload !== null) {
          const { video, contentType, byteLength, modifiedMilliseconds, deduplicated } = videoUpload;
          mediaManifest.videos[file] = {
            videoId: video.videoId,
            contentType,
            byteLength,
            modifiedMilliseconds,
          };
          uploadedVideos.push({
            file,
            videoId: video.videoId,
            title: video.title,
            caption: video.caption,
            fileName: video.fileName,
            contentType,
            byteLength,
            deduplicated,
            durationMilliseconds: video.durationMilliseconds,
          });
          // Recorded as soon as it is confirmed: a later original can take an
          // hour to send, and an interrupt then must not forget this id, which a
          // re-run would answer by uploading the video again.
          mediaManifest.mediaManifestVersion = MEDIA_MANIFEST_VERSION;
          mediaManifest.siteId = siteId;
          await writeMediaManifest(config.workspaceDir, mediaManifest);
          continue;
        }
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
          alt: recordedAlt(mediaManifest.media[file]),
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
      if (uploaded.length > 0 || uploadedVideos.length > 0) {
        await writeMediaManifest(config.workspaceDir, mediaManifest);
      }
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
    // The delivery URLs stay in the media manifest: a signed URL list per
    // file is what pushed a bulk upload past the result's 64 KiB (TR01001).
    const reported = boundedByBytes(
      uploaded.map((entry) => ({
        file: entry.file,
        imageId: entry.imageId,
        deduplicated: entry.deduplicated,
        width: entry.width,
        height: entry.height,
        processingState: observed.get(entry.imageId)?.processingState ?? IMAGE_PROCESSING_STATE_COMPLETE,
      })),
      ITEMS_BYTES,
    );
    const reportedVideos = boundedByBytes(
      uploadedVideos.map((entry) => ({
        file: entry.file,
        videoId: entry.videoId,
        // Set on the Videos page; the placement shows them wherever the video goes.
        title: entry.title,
        caption: entry.caption,
        fileName: entry.fileName,
        contentType: entry.contentType,
        byteLength: entry.byteLength,
        deduplicated: entry.deduplicated,
        durationMilliseconds: entry.durationMilliseconds,
        // Both forms that place it on a page, each accepted as written: a
        // `component:video` fence for Markdown sources, and the ProseMirror
        // block for `.pm.json` sources.
        component: videoComponent(entry.videoId),
      })),
      ITEMS_BYTES,
    );
    return successResult(VERB_MEDIA_UPLOAD, siteId, {
      mediaManifestFile: MEDIA_MANIFEST_FILE_NAME,
      media: {
        total: uploaded.length,
        deduplicated: uploaded.filter((entry) => entry.deduplicated).length,
        items: reported.items,
        ...(reported.truncated ? { itemsTruncated: true } : {}),
      },
      videos: {
        total: uploadedVideos.length,
        items: reportedVideos.items,
        ...(reportedVideos.truncated ? { itemsTruncated: true } : {}),
      },
    });
  });
}
