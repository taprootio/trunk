import assert from "node:assert/strict";
import test from "node:test";
import { LIMITS } from "../src/constants.js";
import { ValidationContext } from "../src/errors.js";
import { compareFragmentHeadings, validateHtmlFragment } from "../src/markup.js";

test("physical heading collection is bounded while drift retains the exact count", () => {
  const physicalHeadingCount = LIMITS.headingsPerVariant * 4;
  const markup = Array.from(
    { length: physicalHeadingCount },
    (_, index) => `<h2 id="section-${index}">Section ${index}</h2>`,
  ).join("");
  const context = new ValidationContext();
  const maximumCollectedHeadings = LIMITS.headingsPerVariant + 1;

  const actual = validateHtmlFragment(
    markup,
    context,
    "$fragment",
    {
      resources: new Map(),
      assets: new Map(),
      locale: "en-US",
      localHeadingIds: new Set(),
    },
    maximumCollectedHeadings,
  );
  compareFragmentHeadings(actual.headings, [], context, "resource:/bounded/", actual.headingCount);

  assert.equal(actual.headingCount, physicalHeadingCount);
  assert.equal(actual.headings.length, maximumCollectedHeadings);
  assert.deepEqual(context.finish().errors, [
    {
      code: "markup.heading_drift",
      path: "resource:/bounded/",
      message: `Fragment contains ${physicalHeadingCount} headings but the manifest declares 0.`,
    },
  ]);
});

function validateMarkup(markup) {
  const context = new ValidationContext();
  validateHtmlFragment(
    markup,
    context,
    "$fragment",
    {
      resources: new Map(),
      assets: new Map(),
      locale: "en-US",
      localHeadingIds: new Set(),
    },
  );
  return context.finish();
}

test("raw whitespace before a tag name is not normalized into valid markup", () => {
  const result = validateMarkup("< h2 id=\"intro\">Intro</h2>");

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "markup.invalid_tag"));
});

test("content that browsers would reparent is rejected", () => {
  const result = validateMarkup("<p>Before<div>reparented</div></p>");

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "markup.content_model"));
});

test("non-ASCII whitespace is rejected in tag and attribute syntax", () => {
  const cases = [
    { markup: "<\u00a0p>text</p>", code: "markup.invalid_tag" },
    { markup: "<p\u00a0title=\"text\">text</p>", code: "markup.invalid_attribute" },
  ];

  for (const fixture of cases) {
    const result = validateMarkup(fixture.markup);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === fixture.code));
  }
});

test("non-ASCII whitespace remains content in element-only table structure", () => {
  const result = validateMarkup("<table>\u00a0<tbody><tr><td>Cell</td></tr></tbody></table>");

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "markup.content_model"));
});

test("heading normalization collapses only HTML ASCII whitespace after entity decoding", () => {
  const context = new ValidationContext();
  const actual = validateHtmlFragment(
    "<h2 id=\"space\">A&#160;B\t C</h2>",
    context,
    "$fragment",
    {
      resources: new Map(),
      assets: new Map(),
      locale: "en-US",
      localHeadingIds: new Set(["space"]),
    },
  );

  assert.equal(context.finish().ok, true);
  assert.equal(actual.headings[0].text, "A\u00a0B C");
});

test("entity parsing matches browser reparsing for the explicitly supported subset", () => {
  for (const markup of [
    "<p>raw & text</p>",
    "<p>&amp text</p>",
    "<p>&unknown;</p>",
    "<p>&#0;</p>",
    "<p>&#13;</p>",
    "<p>&#128;</p>",
  ]) {
    const result = validateMarkup(markup);
    assert.equal(result.ok, false, markup);
    assert.ok(result.errors.some((error) => error.code === "markup.unsupported_entity"), markup);
  }

  assert.equal(validateMarkup("<p>&amp; &#160; &colon;</p>").ok, true);
});

test("literal null characters are rejected in fragment text", () => {
  const result = validateMarkup("<p>a\u0000b</p>");

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), ["markup.invalid_null"]);
});

test("attribute values reject C1 and bidirectional formatting controls", () => {
  const cases = [
    ["\u0085", "markup.invalid_attribute"],
    ["\u061c", "markup.invalid_attribute"],
    ["\u202e", "markup.invalid_attribute"],
    ["\u2067", "markup.invalid_attribute"],
    ["&#x85;", "markup.unsupported_entity"],
    ["&#x202e;", "markup.invalid_attribute"],
  ];
  for (const [value, expectedCode] of cases) {
    const result = validateMarkup(`<p title="unsafe${value}value">Text</p>`);

    assert.equal(result.ok, false, value);
    assert.deepEqual(result.errors.map(({ code, path }) => ({ code, path })), [{
      code: expectedCode,
      path: "$fragment",
    }]);
  }
});

test("lang attributes use the same pinned locale subset as manifests", () => {
  for (const [locale, valid] of [
    ["en-US", true],
    ["fr-FR", true],
    ["abc-Latn-419", true],
    ["en-us", false],
    ["de-1901", false],
  ]) {
    const result = validateMarkup(`<p lang="${locale}">Text</p>`);

    assert.equal(result.ok, valid, locale);
    if (!valid) {
      assert.deepEqual(result.errors.map(({ code, path }) => ({ code, path })), [{
        code: "markup.attribute_value",
        path: "$fragment",
      }]);
    }
  }
});

test("hostile href forms produce stable scheme, control, entity, credential, and relative diagnostics", () => {
  const cases = [
    ["non-HTTPS scheme", "http://example.com/docs", ["markup.unsafe_url"]],
    ["executable scheme", "javascript:alert(1)", ["markup.unsafe_url"]],
    ["C1 control", "https://example.com/\u0085", ["markup.invalid_attribute"]],
    ["entity-obfuscated scheme", "javascript&colon;alert(1)", ["markup.unsafe_url"]],
    ["credentials", "https://user:secret@example.com/docs", ["markup.unsafe_url"]],
    ["protocol-relative", "//example.com/docs", ["markup.invalid_url"]],
  ];

  for (const [name, href, expectedCodes] of cases) {
    const result = validateMarkup(`<a href="${href}">External</a>`);

    assert.equal(result.ok, false, name);
    assert.deepEqual(
      result.errors.map(({ code, path }) => ({ code, path })),
      expectedCodes.map((code) => ({ code, path: "$fragment" })),
      name,
    );
  }
});

test("markup element and nesting ceilings stop adversarial fragments immediately", () => {
  const tooManyElements = validateMarkup("<br>".repeat(LIMITS.markupElements + 1));
  assert.deepEqual(tooManyElements.errors.map((error) => error.code), ["limit.markup_elements"]);

  const tooDeep = validateMarkup(`${"<div>".repeat(LIMITS.markupDepth + 1)}${"</div>".repeat(LIMITS.markupDepth + 1)}`);
  assert.deepEqual(tooDeep.errors.map((error) => error.code), ["limit.markup_depth"]);
});
