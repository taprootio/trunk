import { open } from "node:fs/promises";

import { ALL_FORMATS, BufferTarget, Conversion, FilePathSource, Input, Mp4OutputFormat, Output } from "mediabunny";

/**
 * Prepares a video for `media upload` the way the Videos page does: read the container
 * and codecs, rewrite an H.264 and AAC file that is not an MP4 with its index first as
 * one (copying the tracks, never re-encoding), and declare the real codec strings so
 * the server decides what is accepted. Anything that is not H.264 and AAC is left
 * alone and declared as it is, so the server's refusal names what the file actually is.
 */

/** The most any licence's upload cap allows; a larger file is described, not remuxed. */
export const DEFAULT_MAX_REMUX_BYTES = 250 * 1024 * 1024;

const MAX_TOP_LEVEL_BOXES = 64;

export function isH264(codec) {
  return /^avc[13]/iu.test(codec);
}

/** No audio track (an empty string) is allowed. */
export function isAac(codec) {
  return codec === "" || /^mp4a\.(40\.(1|2|3|4|5|29)|6[678])$/iu.test(codec);
}

export function mp4Name(name) {
  return /\.mp4$/iu.test(name) ? name : `${name.replace(/\.[^./\\]+$/u, "")}.mp4`;
}

/** Whether `moov` precedes `mdat` among a file's top-level boxes, read with a few small reads. */
export async function indexComesFirst(filePath) {
  const handle = await open(filePath, "r");
  try {
    const { size: fileSize } = await handle.stat();
    const header = Buffer.alloc(16);
    let offset = 0;
    for (let boxes = 0; boxes < MAX_TOP_LEVEL_BOXES && offset < fileSize; boxes += 1) {
      const { bytesRead } = await handle.read(header, 0, 16, offset);
      if (bytesRead < 8) return false;
      const type = header.toString("latin1", 4, 8);
      if (type === "moov") return true;
      if (type === "mdat") return false;
      let size = header.readUInt32BE(0);
      if (size === 1 && bytesRead >= 16) size = Number(header.readBigUInt64BE(8));
      else if (size === 0) return false;
      if (!Number.isFinite(size) || size < 8) return false;
      offset += size;
    }
    return false;
  } finally {
    await handle.close();
  }
}

/**
 * @param {{ filePath: string, byteLength: number, maxRemuxBytes?: number }} file
 * @returns {Promise<{ videoCodec: string, audioCodec: string, remuxed: Buffer | null }>}
 *   `remuxed` is the rewritten MP4 when one was needed and possible, else null (upload the file as it is).
 */
export async function prepareVideoFile({ filePath, byteLength, maxRemuxBytes = DEFAULT_MAX_REMUX_BYTES }) {
  const input = new Input({ source: new FilePathSource(filePath), formats: ALL_FORMATS });
  try {
    const format = await input.getFormat();
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    // The server refuses a file if any track is not H.264 or AAC, so the first track that is
    // not is the one declared and named. A track whose codec mediabunny cannot name is
    // "unknown", not absent: an absent audio track is fine, a silent copy of one that exists is not.
    const videoCodec = await declaredCodec(await input.getVideoTracks(), isH264);
    const audioCodec = await declaredCodec(await input.getAudioTracks(), isAac);
    const described = { videoCodec, audioCodec, remuxed: null };

    // A remux keeps only the primary tracks, so they are what must be accepted for it to help.
    const primaryVideo = video ? await codecOf(video) : "";
    const primaryAudio = audio ? await codecOf(audio) : "";
    if (!isH264(primaryVideo) || !isAac(primaryAudio)) return described;

    const everyTrackAccepted = isH264(videoCodec) && isAac(audioCodec);
    if (everyTrackAccepted && format.mimeType === "video/mp4" && await indexComesFirst(filePath)) return described;
    if (byteLength > maxRemuxBytes) return described;

    try {
      const remuxed = await remux(input, { video: video?.id, audio: audio?.id });
      // The rewrite holds only the primaries, so those are the codecs the server will see.
      return remuxed ? { videoCodec: primaryVideo, audioCodec: primaryAudio, remuxed } : described;
    } catch {
      // A remux that fails leaves the real codecs on the original, so the server's
      // structure refusal names the real problem.
      return described;
    }
  } catch {
    // An unreadable file is declared with no codecs; the server answers in its own words.
    return { videoCodec: "", audioCodec: "", remuxed: null };
  } finally {
    input.dispose();
  }
}

async function codecOf(track) {
  return (await track.getCodecParameterString()) ?? "unknown";
}

/** The first codec that is not accepted, else the first track's, else none. */
async function declaredCodec(tracks, accepts) {
  let first = "";
  for (const track of tracks) {
    const codec = await codecOf(track);
    if (!accepts(codec)) return codec;
    first ||= codec;
  }
  return first;
}

async function remux(input, primary) {
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  // Copy only: a track that cannot be copied is dropped, never re-encoded.
  const conversion = await Conversion.init({
    input,
    output,
    copy: { mode: "forced", shiftTolerance: Number.POSITIVE_INFINITY },
    // Only the primary picture and sound go in; an extra track is dropped, not copied.
    video: (track) => (track.id === primary.video ? {} : { discard: true }),
    audio: (track) => (track.id === primary.audio ? {} : { discard: true }),
  });
  const kept = conversion.utilizedTracks;
  if (
    !conversion.isValid
    || !kept.some((track) => track.isVideoTrack())
    || (primary.audio !== undefined && !kept.some((track) => track.isAudioTrack()))
  ) return null;

  await conversion.execute();
  return target.buffer ? Buffer.from(target.buffer) : null;
}
