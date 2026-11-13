import assert from "node:assert/strict";
import test from "node:test";

import { evaluateImageDefaultMissing } from "../src/site-health-image-checks.js";

// The generator runs the same cases over its copy (generator/src/site-health-image-checks.test.ts).

const siteId = "site-1";
const page = (key, imageIds, path = key) => ({ key, path, title: `Title ${key}`, imageIds });
const reference = (key, path = key) => ({ key, path, title: `Title ${key}` });
const image = (imageId, fields = {}) => ({ imageId, name: `${imageId}.jpg`, siteId, ...fields });

test("one finding for an undescribed image used by several pages", () => {
  assert.deepEqual(
    evaluateImageDefaultMissing({
      pages: [page("a", ["i1"]), page("b", ["i1"]), page("c", ["i2"])],
      images: [image("i1")],
      siteId,
    }),
    [{ imageId: "i1", name: "i1.jpg", affectedPages: [reference("a"), reference("b")] }],
  );
});

test("described, empty-string, foreign-site, missing and unused images give no finding", () => {
  assert.deepEqual(
    evaluateImageDefaultMissing({
      pages: [page("a", ["described", "empty", "foreign", "gone"])],
      images: [
        image("described", { defaultDescription: "A garden" }),
        image("empty", { defaultDescription: "" }),
        image("foreign", { siteId: "site-2" }),
        image("gone", { isMissing: true }),
        image("unused"),
      ],
      siteId,
    }),
    [],
  );
});

test("findings follow the order of the image records and of the pages", () => {
  const findings = evaluateImageDefaultMissing({
    pages: [page("b", ["i1", "i2"]), page("a", ["i2", "i1"])],
    images: [image("i2"), image("i1")],
    siteId,
  });
  assert.deepEqual(findings.map((finding) => finding.imageId), ["i2", "i1"]);
  assert.deepEqual(findings.map((finding) => finding.affectedPages.map((entry) => entry.key)), [["b", "a"], ["b", "a"]]);
});

test("pages with different keys and the same path stay separate", () => {
  const [finding] = evaluateImageDefaultMissing({
    pages: [page("a", ["i1"], "same"), page("b", ["i1"], "same")],
    images: [image("i1")],
    siteId,
  });
  assert.deepEqual(finding.affectedPages, [reference("a", "same"), reference("b", "same")]);
});

test("a page whose placed ids repeat an image is listed once", () => {
  const [finding] = evaluateImageDefaultMissing({ pages: [page("a", ["i1", "i1", "i1"])], images: [image("i1")], siteId });
  assert.deepEqual(finding.affectedPages, [reference("a")]);
});

test("records without a site id or missing flag still produce a finding", () => {
  const records = [{ imageId: "i1", name: "One" }, { imageId: "i2", name: "Two", defaultDescription: "Two" }];
  assert.deepEqual(evaluateImageDefaultMissing({ pages: [page("a", ["i1", "i2"])], images: records }), [
    { imageId: "i1", name: "One", affectedPages: [reference("a")] },
  ]);
});

test("a preview URL is copied when the record has one, including an empty one", () => {
  const findings = evaluateImageDefaultMissing({
    pages: [page("a", ["i1", "i2", "i3"])],
    images: [image("i1", { previewUrl: "https://images.example/one.webp" }), image("i2", { previewUrl: "" }), image("i3")],
    siteId,
  });
  assert.deepEqual(findings.map((finding) => finding.previewUrl), ["https://images.example/one.webp", "", undefined]);
  assert.equal("previewUrl" in findings[2], false);
});

test("findings are not capped", () => {
  const ids = Array.from({ length: 300 }, (_, index) => `i${index}`);
  assert.equal(evaluateImageDefaultMissing({ pages: [page("a", ids)], images: ids.map((id) => image(id)), siteId }).length, 300);
});
