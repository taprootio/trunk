import assert from "node:assert/strict";
import test from "node:test";
import { stripImageDescriptionHydration } from "../../src/content/image-description-document.js";
import { canonicalDocumentHash } from "../../src/workspace.js";

const image = (mode, text) => ({
  imageId: "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607", src: "", urls: [], width: 1200, height: 800,
  alt: text, ...(mode === undefined ? {} : { descriptionMode: mode }),
  defaultDescription: "Shared default", descriptionRevision: "3",
});

test("storage projection removes delivery descriptions while retaining authored modes, text and captions", () => {
  const original = { images: [
    { ...image("inherit", "Shared default"), altText: "Shared default", caption: "Visible caption" },
    image("custom", "Contextual text"), image("decorative", ""), image(undefined, "Legacy text"),
    { ...image(null, "Null-mode legacy"), descriptionRevision: 0 },
  ] };
  const before = structuredClone(original);
  const result = stripImageDescriptionHydration(original);
  assert.deepEqual(original, before);
  assert.deepEqual(result.images.map(entry => [entry.descriptionMode, entry.alt]), [
    ["inherit", undefined], ["custom", "Contextual text"], ["decorative", ""], [undefined, "Legacy text"], [null, "Null-mode legacy"],
  ]);
  assert.equal(result.images[0].caption, "Visible caption");
  assert.equal(Object.hasOwn(result.images[0], "altText"), false);
  for (const entry of result.images) {
    assert.equal(Object.hasOwn(entry, "defaultDescription"), false);
    assert.equal(Object.hasOwn(entry, "descriptionRevision"), false);
    assert.equal(entry.width, 1200);
    assert.equal(entry.height, 800);
  }
});

test("storage projection handles serialized banners and keeps unrelated component bytes unchanged", () => {
  const unchanged = ' { "height" : "large" } ';
  const malformed = "{bad";
  const data = {
    image: image("inherit", "Shared default"), altText: "Shared default", descriptionMode: "inherit",
    defaultDescription: "Shared default", descriptionRevision: 3, overlayText: "Visible headline",
    nested: { componentData: JSON.stringify({ image: image("custom", "Keep this context") }) },
  };
  const original = { content: [
    { attrs: { componentData: JSON.stringify(data) } },
    { attrs: { componentData: unchanged } }, { attrs: { componentData: malformed } },
  ] };
  const projected = stripImageDescriptionHydration(original);
  const banner = JSON.parse(projected.content[0].attrs.componentData);
  assert.equal(banner.descriptionMode, "inherit");
  assert.equal(Object.hasOwn(banner, "altText"), false);
  assert.equal(Object.hasOwn(banner.image, "alt"), false);
  assert.equal(banner.overlayText, "Visible headline");
  const nested = JSON.parse(banner.nested.componentData).image;
  assert.equal(nested.alt, "Keep this context");
  assert.equal(Object.hasOwn(nested, "defaultDescription"), false);
  assert.equal(projected.content[1].attrs.componentData, unchanged);
  assert.equal(projected.content[2].attrs.componentData, malformed);
});

test("changing only API default hydration leaves the authored hash unchanged", () => {
  const first = { type: "doc", content: [{ type: "taprootImage", attrs: image("inherit", "Shared default") }] };
  const second = structuredClone(first);
  Object.assign(second.content[0].attrs, { defaultDescription: "A newer default", alt: "A newer default", descriptionRevision: "4" });
  assert.equal(canonicalDocumentHash(stripImageDescriptionHydration(first)), canonicalDocumentHash(stripImageDescriptionHydration(second)));
  second.content[0].attrs.descriptionMode = "custom";
  assert.notEqual(canonicalDocumentHash(stripImageDescriptionHydration(first)), canonicalDocumentHash(stripImageDescriptionHydration(second)));
});
