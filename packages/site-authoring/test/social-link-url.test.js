import assert from "node:assert/strict";
import test from "node:test";

import corpus from "./fixtures/social-link-url-corpus.json" with { type: "json" };
import { isSocialLinkUrl, SOCIAL_LINK_URL_MAX_LENGTH, trimSocialLinkInput } from "../src/social-link-url.js";

// The same corpus runs through the generator's copy, the editor's import of
// shared/social-link-url.ts and the API's own port (TR01324).
for (const { value, valid } of corpus.entries) {
  test(`judges ${JSON.stringify(value)} as ${valid} exactly as written`, () => {
    assert.equal(isSocialLinkUrl(value), valid);
  });
}

for (const { value, trimmed } of corpus.entries) {
  test(`trims ${JSON.stringify(value)} to ${JSON.stringify(trimmed)}`, () => {
    assert.equal(trimSocialLinkInput(value), trimmed);
  });
}

test("refuses values that are not text and holds the length bound", () => {
  for (const value of [undefined, null, 5, {}, ["https://example.com"]]) {
    assert.equal(isSocialLinkUrl(value), false);
  }
  assert.equal(SOCIAL_LINK_URL_MAX_LENGTH, 2048);
});
