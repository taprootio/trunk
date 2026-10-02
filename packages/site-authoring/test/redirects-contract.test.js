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
    { path: "/2019.2020-recap", target: "/journal" },
    { path: "/a.b/c.d", target: "https://booking.example.test/riverbend" },
  ]);
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ["/2019.2020-recap", "/a.b/c.d", "/faqs.html"],
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

// TR00968: a redirect is a marker file in the release. These vectors are the
// same ones the API pins in SiteRedirectSourceRefusalTests (C#), so the offline
// check and the server refuse the same sources.
for (const path of [
  "/index.html",
  "/about/index.html",
  "/About/INDEX.HTML",
  "/404.html",
  "/sitemap.xml",
  "/Sitemap.xml/old",
  "/robots.txt",
  "/favicon.ico",
  "/.well-known/old",
  "/con",
  "/a%25b",
  "/%69ndex.html",
  "/about/%69ndex.html",
  "/%73itemap.xml",
  "/old..page",
  `/${"a".repeat(201)}`,
  "/about/index.html/legacy",
  "/404.html/old",
  "/favicon.ico/old",
  "/integrations/old",
  "/Integrations",
  "/%69ntegrations/old",
  // TR01144: the runtime mirror is answered before any redirect.
  "/taproot/5.0.62/manifest.json",
  "/taproot/5.0.62",
  "/Taproot/5.0.62/old",
  "/%74aproot/5.0.62/old",
  "/taproot/5.1.0-rc.1/old",
  "/taproot/5.1.0+build.7/old",
  "/a%3Fb",
  "/a%23b",
  "/a%C2%85b",
]) {
  test(`a source that is a generated or unstorable path is refused: ${path}`, () => {
    const error = refusal([{ path, kind: "redirect", target: "/x" }]);
    assert.equal(error.code, "redirects.path_unpublishable");
    assert.match(error.message, /entries\[0\]\.path/u);
  });
}

test("an escaped dot or slash cannot hide a generated file or an empty segment", () => {
  for (const path of ["/robots%2Etxt", "/a%2F%2Fb"]) {
    assert.throws(() => validate([{ path, kind: "redirect", target: "/x" }]), (error) => error.name === "SiteAuthoringError", path);
  }
});

for (const path of [
  "/about",
  "/faqs.html",
  "/index.htm",
  "/my-index.html.old",
  "/caf%C3%A9",
  "/old%20page",
  "/favicon.ico.bak",
  "/taproot",
  "/taproot/about",
  "/taproot/5.0",
  "/taproot/5.0.62x",
  "/taproot/5.0.62-",
  `/${"a".repeat(200)}`,
]) {
  test(`an ordinary source still passes, legacy percent spellings included: ${path}`, () => {
    assert.equal(validate([{ path, kind: "redirect", target: "/x" }]).entries[0].path, path);
  });
}

test("an encoded source that redirects to its own decoded spelling is a loop, and a chain through one is refused", () => {
  assert.equal(refusal([{ path: "/%61", kind: "redirect", target: "/a" }]).code, "redirects.loop");
  assert.equal(
    refusal([
      { path: "/b", kind: "redirect", target: "/x" },
      { path: "/y", kind: "redirect", target: "/%62" },
    ]).code,
    "redirects.chain",
  );
});

test("two sources that decode to one marker file are a duplicate", () => {
  const error = refusal([
    { path: "/a%41", kind: "redirect", target: "/x" },
    { path: "/aA", kind: "redirect", target: "/y" },
  ]);
  assert.equal(error.code, "redirects.path_duplicate");
});

test("a gone entry at a generated file is refused the same way", () => {
  assert.equal(refusal([{ path: "/robots.txt", kind: "gone" }]).code, "redirects.path_unpublishable");
});

test("a target too long to store as metadata is refused offline", () => {
  const error = refusal([{ path: "/a", kind: "redirect", target: `https://elsewhere.example.test/?q=${"é".repeat(300)}` }]);
  assert.equal(error.code, "redirects.target_too_long_to_store");
});
