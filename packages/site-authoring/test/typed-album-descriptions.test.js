import assert from "node:assert/strict";
import test from "node:test";
import { typedDocumentFromJson, wireTemplate, workspaceDocumentFromPage } from "../src/typed-pages.js";

const IMAGE_ID = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const image = (extra = {}) => ({ imageId: IMAGE_ID, caption: "Visible caption", width: 1200, height: 800, ...extra });
const album = (images) => ({ template: "album", data: { images } });
const fromSite = (images) => workspaceDocumentFromPage({
  template: { templateType: "TEMPLATE_TYPE_ALBUM", albumData: { images } },
});

for (const [name, authored, hydrated] of [
  ["custom text separate from its caption", { descriptionMode: "custom", altText: "Context beyond the caption" }, {}],
  ["an intentionally decorative empty description", { descriptionMode: "decorative", altText: "" }, {}],
  ["inheritance without saving resolved default text", { descriptionMode: "inherit" }, { altText: "Current library description" }],
  ["legacy caption fallback without introducing a mode", {}, {}],
  ["legacy explicit text separate from its caption", { altText: "Legacy contextual text" }, {}],
  ["legacy explicit empty text without falling back to its caption", { altText: "" }, {}],
]) {
  test(`typed album pull-edit-push preserves ${name}`, () => {
    const source = typedDocumentFromJson(album([image(authored)]), "pages/album.pm.json");
    const sent = wireTemplate(source);
    const siteImage = {
      ...sent.albumData.images[0],
      ...hydrated,
      defaultDescription: "Current library description",
      descriptionRevision: "9007199254740993",
      urls: [{ minWidth: 1200, url: "https://images.example/preview.webp" }],
    };
    const pulled = fromSite([siteImage]);
    assert.deepEqual(pulled.data.images, [image(authored)]);
    const edited = structuredClone(pulled);
    edited.data.images[0].caption = "Edited visible caption";
    const pushed = wireTemplate(typedDocumentFromJson(edited, "pages/album.pm.json"));
    assert.deepEqual(pushed.albumData.images, [image({ ...authored, caption: "Edited visible caption" })]);
    assert.equal(siteImage.defaultDescription, "Current library description");
    if (hydrated.altText !== undefined) assert.equal(siteImage.altText, hydrated.altText);
  });
}

test("an inherited album's workspace projection is stable across live defaults and revisions", () => {
  const first = fromSite([image({ descriptionMode: "inherit", altText: "First default", defaultDescription: "First default", descriptionRevision: "1" })]);
  const later = fromSite([image({ descriptionMode: "inherit", altText: "A later default", defaultDescription: "A later default", descriptionRevision: "2" })]);
  assert.equal(JSON.stringify(first), JSON.stringify(later));
  assert.deepEqual(first.data.images, [image({ descriptionMode: "inherit" })]);
  assert.notEqual(JSON.stringify(first), JSON.stringify(fromSite([image({ descriptionMode: "decorative", altText: "" })])));
  assert.notEqual(
    JSON.stringify(fromSite([image({ descriptionMode: "custom", altText: "First authored text" })])),
    JSON.stringify(fromSite([image({ descriptionMode: "custom", altText: "Changed authored text" })])),
  );
});

test("read-only image defaults and revisions are refused in authored typed album documents", () => {
  for (const readonly of [{ defaultDescription: "Library text" }, { descriptionRevision: "7" }]) {
    assert.throws(() => typedDocumentFromJson(album([image(readonly)]), "pages/album.pm.json"), { code: "pages.document_shape" });
  }
});

for (const mode of ["", "automatic", "Custom", 1, true, {}, []]) {
  test(`typed albums reject an invalid description mode ${JSON.stringify(mode)}`, () => {
    assert.throws(
      () => typedDocumentFromJson(album([image({ descriptionMode: mode, altText: "Authored text" })]), "pages/album.pm.json"),
      { code: "pages.document_shape", field: "pages/album.pm.json:data.images[0].descriptionMode" },
    );
  });
}

test("typed albums preserve long contextual text and validate its optional string type", () => {
  const text = ` ${"🦉".repeat(1001)} `;
  const document = typedDocumentFromJson(album([image({ descriptionMode: "custom", altText: text })]), "pages/album.pm.json");
  assert.equal(wireTemplate(document).albumData.images[0].altText, text);
  assert.equal(fromSite([image({ descriptionMode: "custom", altText: text })]).data.images[0].altText, text);
  for (const altText of [1, false, {}, []]) {
    assert.throws(() => typedDocumentFromJson(album([image({ altText })]), "pages/album.pm.json"), { code: "pages.document_shape" });
  }
  assert.deepEqual(typedDocumentFromJson(album([image({ descriptionMode: null, altText: null })]), "pages/album.pm.json").data.images,
    [image({ descriptionMode: null, altText: null })]);
});

test("typed album inheritance discards a resolved description before wire projection", () => {
  const document = typedDocumentFromJson(album([image({ descriptionMode: "inherit", altText: "Stale resolved text" })]), "pages/album.pm.json");
  assert.deepEqual(wireTemplate(document).albumData.images, [image({ descriptionMode: "inherit" })]);
});

for (const [templateType, dataKey] of [["TEMPLATE_TYPE_FREE_FORM", "freeFormData"], ["TEMPLATE_TYPE_ARTICLE", "articleData"]]) {
  test(`${templateType} live workspace projections omit inherited image hydration`, () => {
    const body = { type: "doc", content: [{ type: "taprootImage", attrs: {
      imageId: IMAGE_ID, descriptionMode: "inherit", alt: "Resolved default", defaultDescription: "Resolved default", descriptionRevision: "7",
    } }] };
    const pulled = workspaceDocumentFromPage({ template: { templateType, [dataKey]: { body } } });
    const authoredBody = templateType === "TEMPLATE_TYPE_FREE_FORM" ? pulled : pulled.data.body;
    assert.deepEqual(authoredBody.content[0].attrs, { imageId: IMAGE_ID, descriptionMode: "inherit" });
    assert.equal(body.content[0].attrs.alt, "Resolved default");
  });
}
