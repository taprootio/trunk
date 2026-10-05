import assert from "node:assert/strict";
import test from "node:test";

import corpus from "../fixtures/video-embed-url-corpus.json" with { type: "json" };
import { isVideoEmbedId, parseVideoEmbedUrl, videoEmbedPlayerUrl } from "../../src/content/video-embed-url.js";

// The same corpus runs through the generator's and the editor's copies of
// shared/video-embed-url.ts, so a drift in any rule fails there or here.
for (const { input, provider, videoId } of corpus.accepted) {
  test(`reduces ${JSON.stringify(input)} to ${provider} ${videoId}`, () => {
    assert.deepEqual(parseVideoEmbedUrl(input), { provider, videoId });
  });
}

for (const input of corpus.refused) {
  test(`refuses ${JSON.stringify(input)}`, () => {
    assert.equal(parseVideoEmbedUrl(input), null);
  });
}

test("refuses values that are not text", () => {
  for (const value of [undefined, null, 5, {}, ["https://youtu.be/dQw4w9WgXcQ"]]) {
    assert.equal(parseVideoEmbedUrl(value), null);
  }
});

test("builds a player URL only from a validated provider and id", () => {
  assert.equal(
    videoEmbedPlayerUrl("youtube", "dQw4w9WgXcQ"),
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1",
  );
  assert.equal(videoEmbedPlayerUrl("vimeo", "76979871"), "https://player.vimeo.com/video/76979871?dnt=1&autoplay=1");
  assert.equal(videoEmbedPlayerUrl("youtube", "dQw4w9WgXcQ/../x"), "");
  assert.equal(isVideoEmbedId("vimeo", "abc"), false);
});
