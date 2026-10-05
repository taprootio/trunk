import { SiteAuthoringError } from "./errors.js";

/**
 * Container sniffing for video uploads in `media upload`.
 *
 * Like the image sniffer this reads a fixed, bounded prefix and nothing else:
 * it names the container (MP4, MOV or WebM) so `video-prepare.js` can read the
 * file, and leaves the real validation to that read and to the API, which
 * accepts only an H.264 and AAC MP4. A file that is not one of the three is not
 * claimed here, so the caller falls through to the image path and its own
 * refusal.
 */

export const VIDEO_CONTENT_TYPES = Object.freeze({
  mp4: "video/mp4",
  quicktime: "video/quicktime",
  webm: "video/webm",
});

/** The extensions a directory walk treats as video candidates; the container decides. */
export const VIDEO_EXTENSIONS = Object.freeze([".mp4", ".mov", ".webm"]);

/**
 * The major brands of an ISO base media file that are an MP4 video. The `ftyp`
 * box is shared with HEIC, HEIF, AVIF, M4A and 3GP, none of which are videos
 * this upload accepts, so the brand decides rather than the box alone.
 */
const MP4_BRANDS = Object.freeze([
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "dash",
  "M4V ",
  "M4VH",
  "M4VP",
  "MSNV",
  "f4v ",
]);
const QUICKTIME_BRAND = "qt  ";

const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];
// The EBML header carries its DocType within the first few dozen bytes.
const EBML_DOCTYPE_WINDOW = 64;

function startsWithAscii(bytes, text, offset) {
  if (bytes.byteLength < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function containsAscii(bytes, text, limit) {
  const end = Math.min(bytes.byteLength, limit) - text.length;
  for (let offset = 0; offset <= end; offset += 1) {
    if (startsWithAscii(bytes, text, offset)) return true;
  }
  return false;
}

/**
 * The video content type for a file's leading bytes, or `undefined` when they
 * are not an MP4, MOV or WebM container (an ISO base media file with another
 * brand, such as HEIC or M4A, is not one). A Matroska file shares WebM's EBML
 * header but is not accepted, so the DocType decides.
 */
export function sniffVideoContentType(header) {
  if (header.byteLength >= 12 && startsWithAscii(header, "ftyp", 4)) {
    if (startsWithAscii(header, QUICKTIME_BRAND, 8)) return VIDEO_CONTENT_TYPES.quicktime;
    return MP4_BRANDS.some((brand) => startsWithAscii(header, brand, 8)) ? VIDEO_CONTENT_TYPES.mp4 : undefined;
  }
  if (header.byteLength >= 4 && EBML_MAGIC.every((byte, index) => header[index] === byte)) {
    return containsAscii(header, "webm", EBML_DOCTYPE_WINDOW) ? VIDEO_CONTENT_TYPES.webm : undefined;
  }
  return undefined;
}

export function videoTooLarge(fileName, maximumBytes) {
  return new SiteAuthoringError(
    "media.video_too_large",
    `'${fileName}' is larger than the ${Math.round(maximumBytes / (1024 * 1024 * 1024))} GiB a single video upload accepts.`,
    { field: fileName },
  );
}
