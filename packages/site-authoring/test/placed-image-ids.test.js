import assert from "node:assert/strict";
import test from "node:test";

import corpus from "./fixtures/image-reference-corpus.json" with { type: "json" };
import { placedImageIds } from "../src/placed-image-ids.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const image = (imageId) => ({ type: "taprootImage", attrs: { imageId } });
const doc = (...content) => ({ type: "doc", content });

// The cases the API's extractor also passes (shared/image-reference-corpus.json, ImageReferenceCorpusTests), run over
// each case's wire twin, so the two readers cannot drift.
for (const testCase of corpus) {
  test(`corpus: ${testCase.name}`, () => {
    assert.deepEqual(placedImageIds(testCase.templateType, testCase.wire), testCase.ids);
  });
}

test("an unknown template type, or an integration-managed page, places nothing", () => {
  for (const templateType of ["integration-managed", "profile-home", "unknown", "", undefined, null, 7]) {
    assert.deepEqual(placedImageIds(templateType, { body: doc(image(A)) }), []);
  }
});

test("missing or malformed data returns what is readable without throwing", () => {
  assert.deepEqual(placedImageIds("article", undefined), []);
  assert.deepEqual(placedImageIds("article", null), []);
  assert.deepEqual(placedImageIds("article", "body"), []);
  assert.deepEqual(placedImageIds("article", [doc(image(A))]), []);
  assert.deepEqual(placedImageIds("article", { body: "not a document" }), []);
  assert.deepEqual(placedImageIds("album", { introductionBody: doc(image(A)), images: "none" }), [A]);
  assert.deepEqual(placedImageIds("album", { images: [{ imageId: 7 }, null, "x", { imageId: B }] }), [B]);
  assert.deepEqual(placedImageIds("recipe", { introductionBody: doc(image(A)), instructionSections: "none" }), [A]);
  assert.deepEqual(
    placedImageIds("recipe", { instructionSections: [null, { stepBodies: "none" }, { stepBodies: [doc(image(B))] }] }),
    [B],
  );
});

test("a non-string image id places nothing", () => {
  assert.deepEqual(placedImageIds("article", { body: doc({ type: "taprootImage", attrs: { imageId: { id: A } } }) }), []);
  assert.deepEqual(placedImageIds("article", { body: doc({ type: "taprootImage", attrs: { imageId: [A] } }) }), []);
});

test("ids come back sorted and unique", () => {
  assert.deepEqual(placedImageIds("free-form", { body: doc(image(B), image(A.toUpperCase()), image(B), image(A)) }), [A, B]);
});

test("a body nested beyond the bound returns what was found and never throws", () => {
  const deep = (levels, leaf) => {
    let node = leaf;
    for (let index = 0; index < levels; index += 1) node = { type: "blockquote", content: [node] };
    return node;
  };
  assert.deepEqual(placedImageIds("free-form", { body: doc(image(A), deep(300, image(B))) }), [A]);
  assert.deepEqual(placedImageIds("free-form", { body: doc(image(A), deep(100, image(B))) }), [A, B]);
  assert.deepEqual(placedImageIds("free-form", { body: doc(image(A), deep(100000, image(B))) }), [A]);
  // Deeply nested component data is bounded the same way, and a string that nests too deep to parse reads as none.
  let nested = { imageId: B };
  for (let index = 0; index < 300; index += 1) nested = { next: nested };
  const component = (componentData) => ({ type: "componentBlock", attrs: { componentData } });
  assert.deepEqual(placedImageIds("free-form", { body: doc(component(JSON.stringify(nested))) }), []);
  assert.deepEqual(placedImageIds("free-form", { body: doc(component("[".repeat(200000))) }), []);
});

test("numeric entities that are invalid never throw and stay text", () => {
  const component = (text) => ({ body: doc({ type: "componentBlock", attrs: { componentData: JSON.stringify({ imageId: A, note: text }) } }) });
  for (const entity of ["&#99999999999999999999;", "&#xFFFFFFFFFFFFFFFF;", "&#1114112;", "&#xD800;", "&#xDFFF;", "&#;", "&#x;"]) {
    assert.deepEqual(placedImageIds("free-form", component(entity)), [A], entity);
  }
});

test("hostile property names are read as data", () => {
  const body = JSON.parse(`{"type":"doc","content":[{"__proto__":{"type":"taprootImage"},"type":"taprootImage","attrs":{"imageId":"${A}"}}]}`);
  assert.deepEqual(placedImageIds("article", { body }), [A]);
  assert.equal(Object.prototype.imageId, undefined);
});
