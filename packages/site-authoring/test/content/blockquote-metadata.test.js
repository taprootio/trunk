import assert from "node:assert/strict";
import test from "node:test";
import {
  blockquoteCaptionParts,
  hasUnsupportedBlockquoteMetadata,
  readBlockquoteMetadata,
  validateBlockquoteMetadata,
} from "../../src/content/blockquote-metadata.js";
import corpus from "../fixtures/blockquote-metadata-corpus.json" with { type: "json" };

for (const fixture of corpus.cases) {
  test(`quote metadata: ${fixture.name}`, () => {
    const before = structuredClone(fixture.attrs);
    assert.equal(validateBlockquoteMetadata(fixture.attrs).length === 0, fixture.valid);
    assert.equal(readBlockquoteMetadata(fixture.attrs) !== null, fixture.valid);
    assert.deepEqual(fixture.attrs, before, "admission never rewrites stored settings");
  });
}

const source = "https://example.test/book";
const text = value => ({ kind: "text", text: value });
const title = href => ({ kind: "title", text: "Book", ...(href ? { href } : {}) });
const link = { kind: "source", text: "Source", href: source };
for (
  const [attrs, expected] of [
    [{}, []],
    [{ attribution: "Person" }, [text("— Person")]],
    [{ sourceTitle: "Book" }, [title()]],
    [{ cite: source }, [link]],
    [{ attribution: "Person", sourceTitle: "Book" }, [text("— Person"), text(", "), title()]],
    [{ attribution: "Person", cite: source }, [text("— Person"), text(", "), link]],
    [{ sourceTitle: "Book", cite: source }, [title(source)]],
    [{ attribution: "Person", sourceTitle: "Book", cite: source }, [text("— Person"), text(", "), title(source)]],
  ]
) {
  test(`caption parts for ${Object.keys(attrs).join(",") || "ordinary quote"}`, () => {
    assert.deepEqual(blockquoteCaptionParts(attrs), expected);
  });
}

test("null defaults disappear and invalid settings cannot become caption links", () => {
  assert.deepEqual(readBlockquoteMetadata(undefined), {});
  assert.deepEqual(readBlockquoteMetadata({ attribution: null, sourceTitle: null, cite: null }), {});
  assert.deepEqual(blockquoteCaptionParts({ attribution: "Person", cite: "javascript:alert(1)" }), []);
});

test("stored admission follows document children and ignores component configuration", () => {
  const invalid = { type: "blockquote", attrs: { cite: "javascript:alert(1)" }, content: [{ type: "paragraph" }] };
  const component = { type: "componentBlock", attrs: { componentData: { content: [invalid] } } };
  assert.equal(hasUnsupportedBlockquoteMetadata({ type: "doc", content: [component] }), false);
  assert.equal(
    hasUnsupportedBlockquoteMetadata({ type: "doc", content: [{ type: "section", content: [invalid] }] }),
    true,
  );
  assert.equal(
    hasUnsupportedBlockquoteMetadata({
      type: "doc",
      content: [{ type: "blockquote", content: [{ type: "paragraph" }] }],
    }),
    false,
  );
});
