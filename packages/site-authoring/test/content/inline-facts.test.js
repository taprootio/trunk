import assert from "node:assert/strict";
import test from "node:test";

import { normalizeInlineFactsItems } from "../../src/content/inline-facts.js";
import { validateDocument } from "../../src/content/validate-document.js";

const SHY_ITEMS = [
  { label: "Community rating", value: "4.9 ★" },
  { url: "tel:+15550137788", value: "(555) 013-7788", label: "Call the studio" },
  { value: "Open today until 8:30 PM", label: "Today's hours", url: "/classes" },
];

test("canonicalizes inline fact fields in value, label, url order", () => {
  const result = normalizeInlineFactsItems(SHY_ITEMS);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.items, [
    { value: "4.9 ★", label: "Community rating" },
    { value: "(555) 013-7788", label: "Call the studio", url: "tel:+15550137788" },
    { value: "Open today until 8:30 PM", label: "Today's hours", url: "/classes" },
  ]);
  assert.deepEqual(Object.keys(result.items[1]), ["value", "label", "url"]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.items));
  assert.ok(result.items.every(Object.isFrozen));
});

test("enforces the closed item shape, 1-6 bounds, and 120-Unicode-scalar text limit", async (context) => {
  const cases = [
    ["not an array", {}, "/attrs/items"],
    ["empty", [], "/attrs/items"],
    ["too many", Array.from({ length: 7 }, () => ({ value: "v", label: "l" })), "/attrs/items"],
    ["scalar item", ["fact"], "/attrs/items/0"],
    ["unknown field", [{ value: "v", label: "l", icon: "star" }], "/attrs/items/0/icon"],
    ["missing value", [{ label: "l" }], "/attrs/items/0/value"],
    ["blank label", [{ value: "v", label: " \t" }], "/attrs/items/0/label"],
    ["value scalar bound", [{ value: "😀".repeat(121), label: "l" }], "/attrs/items/0/value"],
    ["label scalar bound", [{ value: "v", label: "é".repeat(121) }], "/attrs/items/0/label"],
  ];

  for (const [name, items, path] of cases) {
    await context.test(name, () => {
      const result = normalizeInlineFactsItems(items);
      assert.equal(result.items, undefined);
      assert.ok(result.errors.some((error) => error.path === path), JSON.stringify(result.errors));
    });
  }
  assert.deepEqual(
    normalizeInlineFactsItems([{ value: "😀".repeat(120), label: "é".repeat(120) }]).errors,
    [],
  );
});

test("allows safe native actions and refuses executable or ambiguous URLs", async (context) => {
  for (const url of [
    "tel:+15550137788",
    "mailto:hello@example.test",
    "https://example.test/classes",
    "/classes",
    "classes/today",
    "#hours",
    "?day=today",
  ]) {
    await context.test(`accepts ${url}`, () => {
      assert.deepEqual(normalizeInlineFactsItems([{ value: "v", label: "l", url }]).errors, []);
    });
  }
  for (const url of [
    "",
    "   ",
    "javascript:alert(1)",
    "data:text/html,bad",
    "//evil.example/path",
    "/\\evil.example/path",
    "/bad\u0001path",
  ]) {
    await context.test(`refuses ${JSON.stringify(url)}`, () => {
      const result = normalizeInlineFactsItems([{ value: "v", label: "l", url }]);
      assert.ok(result.errors.some((error) => error.path === "/attrs/items/0/url"));
    });
  }
});

test("inlineFacts is portable at the document root and directly inside a section", () => {
  const node = { type: "inlineFacts", attrs: { items: SHY_ITEMS } };
  assert.deepEqual(validateDocument({ type: "doc", content: [node] }).errors, []);
  assert.deepEqual(validateDocument({
    type: "doc",
    content: [{ type: "section", content: [node] }],
  }).errors, []);

  const nested = validateDocument({
    type: "doc",
    content: [{ type: "blockquote", content: [node] }],
  });
  assert.ok(nested.errors.some((error) =>
    error.code === "content.child_not_allowed" && error.path === "/content/0/content/0"
  ));

  const unlistedAttribute = validateDocument({
    type: "doc",
    content: [{ type: "inlineFacts", attrs: { items: SHY_ITEMS, layout: "row" } }],
  });
  assert.ok(unlistedAttribute.errors.some((error) =>
    error.code === "content.attr_unknown" && error.path === "/content/0/attrs/layout"
  ));
});
