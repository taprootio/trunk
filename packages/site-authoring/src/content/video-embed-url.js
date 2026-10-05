// Generated from shared/video-embed-url.ts by scripts/sync-field-validation.mjs. Do not edit.
/**
 * The one owner of which video links the embed card accepts.
 *
 * A link is reduced to a provider and an id when it is authored, and only that
 * pair is stored. Every player URL is built here from the validated pair, never
 * from the text an author pasted. Anything that is not a YouTube watch, share,
 * Shorts or embed link, or a Vimeo video link, is refused.
 *
 * It is pure and dependency-free. The generator, the editor and the
 * site-authoring CLI cannot all import this file, so
 * `node scripts/sync-field-validation.mjs` writes their copies; edit only this
 * file and re-run it. `shared/video-embed-url-corpus.json` is the evidence
 * every copy agrees.
 */
export const VIDEO_EMBED_PROVIDERS = ["youtube", "vimeo"];
/** The one line shown for any link that is not accepted. */
export const VIDEO_EMBED_REFUSAL = "Use a YouTube or Vimeo video link, such as youtube.com/watch?v=… or vimeo.com/123456789.";
/** The origin each provider's player loads from; a page with an embed may frame exactly these. */
export const VIDEO_EMBED_FRAME_ORIGINS = {
    youtube: "https://www.youtube-nocookie.com",
    vimeo: "https://player.vimeo.com",
};
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/u;
/** Two 11-character path segments of `/embed/` links that are playlists and live streams, not video ids. */
const YOUTUBE_NON_VIDEO_IDS = new Set(["videoseries", "live_stream"]);
const VIMEO_ID = /^[1-9][0-9]{0,11}$/u;
const YOUTUBE_HOSTS = new Set([
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
]);
const VIMEO_HOSTS = new Set(["vimeo.com", "www.vimeo.com"]);
export function isVideoEmbedProvider(value) {
    return value === "youtube" || value === "vimeo";
}
export function isVideoEmbedId(provider, videoId) {
    if (typeof videoId !== "string")
        return false;
    if (provider === "youtube")
        return YOUTUBE_ID.test(videoId) && !YOUTUBE_NON_VIDEO_IDS.has(videoId);
    if (provider === "vimeo")
        return VIMEO_ID.test(videoId);
    return false;
}
/** The player URL for a validated provider and id, or an empty string when either is not valid. */
export function videoEmbedPlayerUrl(provider, videoId) {
    if (!isVideoEmbedProvider(provider) || !isVideoEmbedId(provider, videoId))
        return "";
    return provider === "youtube"
        ? `${VIDEO_EMBED_FRAME_ORIGINS.youtube}/embed/${videoId}?autoplay=1`
        : `${VIDEO_EMBED_FRAME_ORIGINS.vimeo}/video/${videoId}?dnt=1&autoplay=1`;
}
/** Reduces an accepted video link to its provider and id; every other value gives `null`. */
export function parseVideoEmbedUrl(input) {
    if (typeof input !== "string")
        return null;
    const text = input.trim();
    if (text === "" || text.length > 2048)
        return null;
    let url;
    try {
        url = new URL(text);
    }
    catch {
        return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
        return null;
    if (url.username !== "" || url.password !== "" || url.port !== "")
        return null;
    const host = url.hostname.toLowerCase();
    const pathname = url.pathname.length > 1 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
    if (pathname.includes("//"))
        return null;
    const segments = pathname.slice(1).split("/");
    if (host === "youtu.be") {
        return segments.length === 1 ? target("youtube", segments[0]) : null;
    }
    if (YOUTUBE_HOSTS.has(host)) {
        if (segments.length === 1 && segments[0] === "watch")
            return target("youtube", url.searchParams.get("v"));
        if (segments.length === 2 && (segments[0] === "shorts" || segments[0] === "embed")) {
            return target("youtube", segments[1]);
        }
        return null;
    }
    // An unlisted Vimeo video needs its `h` privacy hash to play; only the id is
    // stored, so a link that carries one is refused rather than saved broken.
    if (VIMEO_HOSTS.has(host)) {
        return segments.length === 1 && !url.searchParams.has("h") ? target("vimeo", segments[0]) : null;
    }
    if (host === "player.vimeo.com") {
        return segments.length === 2 && segments[0] === "video" && !url.searchParams.has("h")
            ? target("vimeo", segments[1])
            : null;
    }
    return null;
}
function target(provider, videoId) {
    return videoId !== null && videoId !== undefined && isVideoEmbedId(provider, videoId) ? { provider, videoId } : null;
}
