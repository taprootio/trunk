import assert from "node:assert/strict";
import test from "node:test";

import { describeJsonDifferences, JSON_DIFFERENCE_LIMIT, reportableDifferencePaths } from "../src/json-path-diff.js";

test("identical documents differ nowhere", () => {
  const document_ = { type: "doc", content: [{ type: "paragraph", attrs: { level: 2 } }] };

  assert.deepEqual(
    describeJsonDifferences(document_, structuredClone(document_)),
    { paths: [], truncated: false },
  );
});

test("names the exact leaf that moved, not the subtree containing it", () => {
  // The production case: two sibling delivery fields on one image, and nothing
  // else. A report naming `$.content[0]` would say the section changed, which
  // is the question the operator already had.
  const before = {
    content: [{ attrs: { decoration: { image: { src: "a.webp", urls: ["a-640.webp"], alt: "Hero" } } } }],
  };
  const after = {
    content: [{ attrs: { decoration: { image: { src: "b.webp", urls: ["b-640.webp"], alt: "Hero" } } } }],
  };

  assert.deepEqual(describeJsonDifferences(before, after).paths, [
    "$.content[0].attrs.decoration.image.src",
    "$.content[0].attrs.decoration.image.urls[0]",
  ]);
});

test("a member present on one side only is named at its own path", () => {
  assert.deepEqual(
    describeJsonDifferences({ keep: 1 }, { keep: 1, added: 2 }).paths,
    ["$.added"],
  );
  assert.deepEqual(
    describeJsonDifferences({ keep: 1, removed: 2 }, { keep: 1 }).paths,
    ["$.removed"],
  );
});

test("array length changes are named by index, not by the array", () => {
  // "One section was appended" and "every section moved" are different facts,
  // and an operator triaging a conflict needs to tell them apart.
  assert.deepEqual(
    describeJsonDifferences({ content: ["a"] }, { content: ["a", "b"] }).paths,
    ["$.content[1]"],
  );
});

test("a kind change at the root is one difference at the root", () => {
  assert.deepEqual(describeJsonDifferences({ a: 1 }, [1]).paths, ["$"]);
  assert.deepEqual(describeJsonDifferences({ a: 1 }, null).paths, ["$"]);
});

test("paths are stable whatever order the members arrived in", () => {
  // `FreeFormData.body` is a protobuf Struct, so member order is not a
  // contract; two runs over the same pair must still read the same.
  const left = { b: 1, a: 1, c: 1 };
  const right = { c: 2, a: 2, b: 2 };

  assert.deepEqual(describeJsonDifferences(left, right).paths, ["$.a", "$.b", "$.c"]);
});

test("a key that is not a plain identifier is quoted rather than dotted", () => {
  assert.deepEqual(
    describeJsonDifferences({ "data-src": "a" }, { "data-src": "b" }).paths,
    ['$["data-src"]'],
  );
});

test("more differences than the report carries are truncated, and say so", () => {
  const left = {};
  const right = {};
  for (let index = 0; index < JSON_DIFFERENCE_LIMIT + 5; index += 1) {
    left[`field${index}`] = index;
    right[`field${index}`] = index + 1;
  }

  const result = describeJsonDifferences(left, right);

  assert.equal(result.paths.length, JSON_DIFFERENCE_LIMIT);
  assert.equal(result.truncated, true);
});

test("exactly as many differences as the report carries is not truncated", () => {
  const left = {};
  const right = {};
  for (let index = 0; index < JSON_DIFFERENCE_LIMIT; index += 1) {
    left[`field${index}`] = index;
    right[`field${index}`] = index + 1;
  }

  const result = describeJsonDifferences(left, right);

  assert.equal(result.paths.length, JSON_DIFFERENCE_LIMIT);
  assert.equal(result.truncated, false);
});

function nested(depth, leaf) {
  let node = { text: leaf };
  for (let level = 0; level < depth; level += 1) node = { content: [node] };
  return node;
}

test("a nested document is compared to its leaf rather than refused", () => {
  const left = nested(10, "leaf");
  const right = nested(10, "moved");

  const result = describeJsonDifferences(left, right);

  assert.equal(result.paths.length, 1);
  assert.match(result.paths[0], /^\$(\.content\[0\]){10}\.text$/u);
  assert.equal(result.truncated, false);
});

test("a path too long to read is elided in the middle, keeping both ends", () => {
  // These strings reach a terminal and a machine-readable result, so one
  // pathological document must not produce a line nobody can use.
  const result = describeJsonDifferences(nested(30, "leaf"), nested(30, "moved"));

  const [reported] = result.paths;
  assert.ok([...reported].length <= 200);
  assert.ok(reported.startsWith("$.content[0]"));
  assert.ok(reported.endsWith(".text"));
  assert.ok(reported.includes("…"));
});

test("a document nested past the comparison bound reports a path rather than skipping it", () => {
  // Unreachable for real content — canonicalDocumentHash refuses a document
  // this deep before either side reaches here — but over-reporting a
  // diagnostic is safe and quietly not comparing is not.
  const result = describeJsonDifferences(nested(200, "leaf"), nested(200, "moved"));

  assert.equal(result.paths.length, 1);
  assert.equal(result.truncated, false);
});

test("a walk that exhausts its budget before the first difference makes no claim", () => {
  // Identical for far more nodes than the walk visits, different at the end:
  // the documents are not identical, and an empty list must not say they are.
  const left = { content: Array.from({ length: 250_000 }, (_ignored, index) => index) };
  const right = { content: [...left.content.slice(0, -1), -1] };

  const differences = describeJsonDifferences(left, right);

  assert.deepEqual(differences, { paths: [], truncated: true });
  assert.equal(reportableDifferencePaths(differences), undefined);
});

test("only a complete comparison may claim an identical body", () => {
  assert.equal(reportableDifferencePaths(undefined), undefined);
  assert.equal(reportableDifferencePaths({ paths: [], truncated: true }), undefined);
  assert.deepEqual(reportableDifferencePaths({ paths: [], truncated: false }), []);
  assert.deepEqual(reportableDifferencePaths({ paths: ["$.a"], truncated: true }), ["$.a"]);
});
