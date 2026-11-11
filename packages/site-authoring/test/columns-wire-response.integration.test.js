import assert from "node:assert/strict";
import test from "node:test";
import { COLUMNS_WIRE_PROOF_PAGE_ID, readColumnsWireResponse } from "../scripts/columns-wire-reader-proof.mjs";
import { LIMITS } from "../src/constants.js";

// TR01339 exercises existing transport boundaries. This body size is a test
// candidate, not a new authored-body quota; the reader limit remains unchanged.
const BODY_CANDIDATE_BYTES = 512 * 1024;
const EXISTING_READER_BYTES = 1024 * 1024;
const BODY_CORPORA = [
  { name: "ASCII", unit: "x" },
  { name: "astral", unit: "🌱" },
  { name: "BMP and escapes", unit: "é<>&\\\"\n" },
];
const fixtureId = (index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

function boundaryBody(unit) {
  const text = { type: "text", text: "Byte boundary: " };
  const body = {
    type: "doc",
    content: [{
      type: "section",
      content: [{
        type: "columns",
        content: [
          { type: "column", content: [{ type: "paragraph", content: [text] }] },
          { type: "column", content: [{ type: "paragraph", content: [] }] },
        ],
      }],
    }],
  };
  const initial = Buffer.byteLength(JSON.stringify(body));
  const padding = BODY_CANDIDATE_BYTES - initial;
  // Match the proposed compact JSON.stringify UTF-8 measurement, including
  // mandatory quote, backslash and control escapes, without escaping Unicode.
  const unitBytes = Buffer.byteLength(JSON.stringify(unit)) - 2;
  text.text += unit.repeat(Math.floor(padding / unitBytes)) + "x".repeat(padding % unitBytes);
  assert.equal(Buffer.byteLength(JSON.stringify(body)), BODY_CANDIDATE_BYTES);
  return body;
}

function pinnedPage(unit = "x") {
  return {
    pageId: COLUMNS_WIRE_PROOF_PAGE_ID,
    status: "PAGE_STATUS_DRAFT",
    title: "T".repeat(200),
    shortDescription: "é".repeat(1000),
    path: "p".repeat(512),
    authorName: "A".repeat(100),
    authorUrl: "https://example.test/author",
    authorImageUrl: "https://example.test/author.webp",
    authorImageId: fixtureId(1002),
    authorUserId: fixtureId(1003),
    resourceId: fixtureId(1004),
    bodyRevision: "a".repeat(64),
    datePublished: "2026-11-09T00:00:00Z",
    dateUpdated: "2026-11-09T00:00:00Z",
    canonicalUrl: "https://example.test/" + "p".repeat(512),
    tagIds: Array.from({ length: 100 }, (_, i) => fixtureId(i + 1)),
    imageThumbHashes: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [fixtureId(i + 101), "A".repeat(64)])),
    coverImageId: fixtureId(1001),
    coverImage: {
      imageId: fixtureId(1001),
      width: 1920,
      height: 1080,
      alt: "A".repeat(200),
      urls: Array.from({ length: 5 }, (_, i) => ({
        minWidth: (i + 1) * 320,
        url: `https://example.test/cover-${i}-${"x".repeat(220)}.webp`,
      })),
    },
    template: { templateType: "TEMPLATE_TYPE_FREE_FORM", freeFormData: { body: boundaryBody(unit) } },
  };
}

function bytesAtResponseBoundary(targetBytes, unit) {
  const page = pinnedPage(unit);
  page.authorName = "";
  const initial = Buffer.byteLength(JSON.stringify(page));
  // This oversized metadata is a reader-byte fixture, not an admitted page
  // or a proposed author-name quota. Keep its actual body unchanged.
  page.authorName = "A".repeat(targetBytes - initial);
  const bytes = Buffer.from(JSON.stringify(page));
  assert.equal(bytes.byteLength, targetBytes);
  assert.equal(Buffer.byteLength(JSON.stringify(page.template.freeFormData.body)), BODY_CANDIDATE_BYTES);
  return { page, bytes };
}

for (const { name, unit } of BODY_CORPORA) {
  test(`the real page reader admits an exact 512 KiB ${name} body plus pinned response metadata`, async () => {
    assert.equal(LIMITS.apiResponseBytes, EXISTING_READER_BYTES);
    const expected = pinnedPage(unit);
    const bytes = Buffer.from(JSON.stringify(expected));
    assert(bytes.byteLength < EXISTING_READER_BYTES);
    const { page, metrics } = await readColumnsWireResponse(bytes);
    assert.deepEqual(page, expected);
    assert.deepEqual(metrics, {
      responseBytes: bytes.byteLength,
      readerLimitBytes: EXISTING_READER_BYTES,
      requests: 1,
      reencodedBodyBytes: BODY_CANDIDATE_BYTES,
      bodyNodeDepth: 5,
      bodyContainerDepth: 11,
    });
  });

  test(`the real page reader admits the existing exact 1 MiB response boundary with a ${name} body`, async () => {
    const { page: expected, bytes } = bytesAtResponseBoundary(EXISTING_READER_BYTES, unit);
    const { page, metrics } = await readColumnsWireResponse(bytes);
    assert.deepEqual(page, expected);
    assert.equal(metrics.responseBytes, EXISTING_READER_BYTES);
    assert.equal(metrics.reencodedBodyBytes, BODY_CANDIDATE_BYTES);
    assert.equal(metrics.requests, 1);
  });

  test(`one byte over the existing response limit refuses despite a 512 KiB ${name} body`, async () => {
    const { bytes } = bytesAtResponseBoundary(EXISTING_READER_BYTES + 1, unit);
    await assert.rejects(readColumnsWireResponse(bytes), (error) => error.code === "transport.response_too_large");
  });

  if (unit === "x") continue;
  test(`JSON escaping refuses the same decoded 512 KiB ${name} body at the existing wire limit`, async () => {
    const expected = pinnedPage(unit);
    // This is an explicitly escaped JSON fixture, not a substitute for captured
    // hosted responses. Replay those separately to measure the real serializer.
    const escaped = JSON.stringify(expected).replace(
      /[<>&\u0080-\uffff]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    const bytes = Buffer.from(escaped);
    assert.deepEqual(JSON.parse(escaped), expected);
    assert.equal(Buffer.byteLength(JSON.stringify(expected.template.freeFormData.body)), BODY_CANDIDATE_BYTES);
    assert(bytes.byteLength > EXISTING_READER_BYTES);
    await assert.rejects(readColumnsWireResponse(bytes), (error) => error.code === "transport.response_too_large");
  });
}

test("caller cancellation closes the real streamed page read", async () => {
  const { bytes } = bytesAtResponseBoundary(EXISTING_READER_BYTES);
  const cancellation = new AbortController();
  let firstChunkSent = false;
  await assert.rejects(
    readColumnsWireResponse(bytes, {
      signal: cancellation.signal,
      onFirstChunk() {
        firstChunkSent = true;
        cancellation.abort();
      },
    }),
    (error) => error.code === "site.cancelled",
  );
  assert.equal(firstChunkSent, true);
});
