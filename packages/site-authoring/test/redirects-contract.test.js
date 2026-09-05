import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeRedirectPath,
  validateRedirectsDocument,
} from "../src/redirects-contract.js";

const SITE_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function validate(entries) {
  return validateRedirectsDocument(
    { siteId: SITE_ID, entries },
    SITE_ID,
    { requireRevision: false },
  );
}

function refusal(entries) {
  try {
    validate(entries);
  } catch (error) {
    assert.equal(error.name, "SiteAuthoringError");
    return error;
  }
  return assert.fail("the document validated; it should have been refused by entry index");
}

// A path that resolves to something other than what it spells is the whole
// class: the generator resolves a source with path.resolve and the
// published-site edge resolves a target with `new URL`, so `/x/../visit` is
// `/visit` to both while every rule here — occupancy, chains, loops, one entry
// per path — compared the unresolved string. The offline pass has to refuse the
// spelling for the same reason the site does, or `validate` would bless a
// document the push is about to be refused for.
const RESOLVABLE_SPELLINGS = [
  ["a parent-directory segment", "/x/../visit"],
  ["a current-directory segment", "/x/./y"],
  ["an empty interior segment", "/a//b"],
  ["a percent-encoded parent-directory segment", "/%2e%2e/visit"],
  ["an upper-case percent-encoded dot", "/%2E%2E/visit"],
  ["a percent-encoded slash", "/a%2fb"],
  ["a bare current-directory segment", "/."],
];

for (const [name, path] of RESOLVABLE_SPELLINGS) {
  test(`a source with ${name} is refused by entry index`, () => {
    const error = refusal([{ path, target: "/faq" }]);
    assert.equal(error.code, "redirects.path_invalid");
    assert.equal(error.field, "entries[0].path");
  });

  test(`a site-relative target with ${name} is refused by entry index`, () => {
    const error = refusal([{ path: "/faqs.html", target: path }]);
    assert.equal(error.code, "redirects.target_invalid");
    assert.equal(error.field, "entries[0].target");
  });

  test(`normalizeRedirectPath resolves nothing away for ${name}`, () => {
    assert.equal(normalizeRedirectPath(path), undefined);
  });
}

// The rule is about where a request lands, and the edge keys on the pathname
// alone: a query string or fragment may carry percent-encoded slashes and even
// a whole URL, as a viewer or an outbound handoff needs.
test("a site-relative target's query string may carry what its path may not", () => {
  const { entries } = validate([
    { path: "/legacy", target: "/viewer?src=%2Fdocs%2Fold.pdf" },
    { path: "/old", target: "/go?next=https://partner.example.test/x#top" },
  ]);
  assert.deepEqual(entries.map((entry) => entry.target), [
    "/viewer?src=%2Fdocs%2Fold.pdf",
    "/go?next=https://partner.example.test/x#top",
  ]);
});

test("a site-relative target whose path part resolves away is refused even with a clean query", () => {
  const error = refusal([{ path: "/faqs.html", target: "/x/../y?ok=1" }]);
  assert.equal(error.code, "redirects.target_invalid");
  assert.equal(error.field, "entries[0].target");
});

test("case-folding code points are refused like every other non-request spelling", () => {
  // U+212A and U+017F fold to ASCII under a case-insensitive match; the site
  // refuses them, so the offline pass must too.
  for (const path of ["/2\u212A", "/\u017Fign"]) {
    const error = refusal([{ path, target: "/faq" }]);
    assert.equal(error.code, "redirects.path_invalid");
  }
});

test("the refusal names the offending entry, not the first one", () => {
  const error = refusal([
    { path: "/faqs.html", target: "/faq" },
    { path: "/x/../visit", target: "/faq" },
  ]);
  assert.equal(error.field, "entries[1].path");
});

// The rule is about segments, not about the characters they are spelled with.
// A dot inside a segment is what makes a legacy `.html` source representable,
// and refusing those would take the whole migration case with it.
test("a dot inside a segment is not a dot segment", () => {
  const { entries } = validate([
    { path: "/faqs.html", target: "/faq" },
    { path: "/2019..2020-recap", target: "/journal" },
    { path: "/a.b/c..d", target: "https://booking.example.test/riverbend" },
  ]);
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ["/2019..2020-recap", "/a.b/c..d", "/faqs.html"],
  );
});

// The edge keys on `url.pathname`, which the URL parser has already
// percent-encoded, and nothing downstream decodes it. So a raw spelling beside
// an encoded one is two strings here and one path there: '/old%20page -> /old
// page' passes loop detection and serves a permanent self-loop, and a source
// written '/café' is stored under a key no request pathname matches. Both
// spellings are refused rather than encoded, because URL escaping is not
// reproducibly canonical between the API and the edge.
test("a site-relative target written in the raw spelling of its own source is refused", () => {
  const error = refusal([{ path: "/old%20page", target: "/old page" }]);
  assert.equal(error.code, "redirects.target_invalid");
  assert.equal(error.field, "entries[0].target");
});

test("a source written with a raw non-ASCII character is refused", () => {
  const error = refusal([{ path: "/café", target: "/cafe" }]);
  assert.equal(error.code, "redirects.path_invalid");
  assert.equal(error.field, "entries[0].path");
});

// The encoded spelling is the one a browser sends, so it passes and is stored
// exactly as written — nothing here re-encodes or decodes it.
test("percent-encoded sources pass and keep the spelling they were written in", () => {
  const { entries } = validate([
    { path: "/caf%C3%A9", target: "/cafe" },
    { path: "/old%20page", target: "/new-page" },
  ]);
  assert.deepEqual(
    entries.map((entry) => [entry.path, entry.target]),
    [["/caf%C3%A9", "/cafe"], ["/old%20page", "/new-page"]],
  );
});

// The `//` in an absolute target's scheme is not an empty path segment, and the
// absolute branch is the one that judges it.
test("an absolute http(s) target still passes", () => {
  const { entries } = validate([
    { path: "/book", target: "https://booking.example.test/riverbend", status: 302 },
  ]);
  assert.equal(entries[0].target, "https://booking.example.test/riverbend");
});
