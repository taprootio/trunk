import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { inspectPrebuiltDiscovery } from "../src/prebuilt-discovery.js";

const ORIGIN = "https://docs.example.test";

function entry(path, mediaType, content) {
  return { path, mediaType, content: new Uint8Array(Buffer.from(content, "utf8")) };
}

function snapshot(entries, redirects = []) {
  return {
    manifest: {
      files: entries.map((file) => ({
        path: file.path,
        mediaType: file.mediaType,
        bytes: file.content.byteLength,
        sha256: `sha256:${createHash("sha256").update(file.content).digest("hex")}`,
      })),
      redirects,
    },
    files: entries,
  };
}

function codes(result) {
  return result.errors.map((error) => error.code);
}

test("accepts standard sitemap extensions and a declared icon without favicon.ico", () => {
  const result = inspectPrebuiltDiscovery(snapshot([
    entry("index.html", "text/html; charset=utf-8", [
      "<!doctype html><head>",
      `<link rel=\"canonical\" href=\"${ORIGIN}/\">`,
      "<link rel=\"icon\" href=\"/assets/icon.svg\">",
      "</head>",
    ].join("")),
    entry("guides/index.html", "text/html; charset=utf-8", "<!doctype html><title>Guide</title>"),
    entry("assets/icon.svg", "image/svg+xml", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>"),
    entry("robots.txt", "text/plain; charset=utf-8", "User-agent: *\nAllow: /\n"),
    entry("sitemap.xml", "application/xml", [
      "<?xml version=\"1.0\"?>",
      "<sm:urlset xmlns:sm=\"http://www.sitemaps.org/schemas/sitemap/0.9\" xmlns:image=\"https://www.google.com/schemas/sitemap-image/1.1\">",
      `<sm:url><sm:loc>${ORIGIN}/</sm:loc><sm:lastmod>2026-09-12</sm:lastmod><image:image/></sm:url>`,
      `<sm:url><sm:loc>${ORIGIN}/guides/</sm:loc></sm:url>`,
      "</sm:urlset>",
    ].join("")),
  ]), { productionOrigin: ORIGIN });

  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.some((warning) => warning.code === "homepage.icon_missing"), false);
});

test("accepts a declared SVG icon after standard bounded XML prologs", () => {
  const result = inspectPrebuiltDiscovery(snapshot([
    entry("index.html", "text/html; charset=utf-8", '<link rel="icon" href="/assets/icon.svg">'),
    entry("assets/icon.svg", "image/svg+xml", [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<!-- generated icon -->",
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    ].join("")),
  ]), { productionOrigin: ORIGIN });

  assert.equal(codes(result).includes("homepage.icon_local_missing"), false);
});

test("bounds SVG prologs by UTF-8 bytes and tolerates a split content sequence", () => {
  for (const [svg, accepted] of [
    [`<!--${"é".repeat(1000)}--><svg/>`, true],
    [`<!--${"é".repeat(5000)}--><svg/>`, false],
    [`<svg>${"a".repeat(8186)}é</svg>`, true],
  ]) {
    const result = inspectPrebuiltDiscovery(snapshot([
      entry("index.html", "text/html; charset=utf-8", '<link rel="icon" href="/assets/icon.svg">'),
      entry("assets/icon.svg", "image/svg+xml", svg),
    ]), { productionOrigin: ORIGIN });
    assert.equal(codes(result).includes("homepage.icon_local_missing"), !accepted);
  }
});

test("only reads standard sitemap locations inside page URL elements", () => {
  const result = inspectPrebuiltDiscovery(snapshot([
    entry("index.html", "text/html; charset=utf-8", "<title>Docs</title>"),
    entry("sitemap.xml", "application/xml", `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><loc>${ORIGIN}/missing/</loc><loc/><url><loc>${ORIGIN}/</loc></url></urlset>`),
  ]), { productionOrigin: ORIGIN });

  assert.deepEqual(result.errors, []);
});

test("normalizes an origin-only root canonical and diagnoses a missing canonical href", () => {
  const normalized = inspectPrebuiltDiscovery(snapshot([
    entry("index.html", "text/html; charset=utf-8", `<link rel="canonical" href="${ORIGIN}">`),
  ]), { productionOrigin: ORIGIN });
  assert.deepEqual(normalized.errors, []);

  const missingHref = inspectPrebuiltDiscovery(snapshot([
    entry("index.html", "text/html; charset=utf-8", '<link rel="canonical">'),
  ]), { productionOrigin: ORIGIN });
  assert.deepEqual(codes(missingHref), ["homepage.canonical_missing_href"]);

  const encoded = inspectPrebuiltDiscovery(snapshot([
    entry("index.html", "text/html; charset=utf-8", `<link rel="canonical" href="${ORIGIN}/%2e">`),
  ]), { productionOrigin: ORIGIN });
  assert.ok(codes(encoded).includes("homepage.canonical_not_root"));
});

test("rejects supplied discovery failures without fetching any declared URL", () => {
  const result = inspectPrebuiltDiscovery(snapshot([
    entry("index.html", "text/html; charset=utf-8", [
      "<meta name=\"robots\" content=\"noindex\">",
      `<link rel=\"canonical\" href=\"${ORIGIN}/wrong/\">`,
      "<link rel=\"icon\" href=\"/assets/missing.svg\">",
      "<link rel=\"icon\" href=\"https://icons.example.test/site.svg\">",
    ].join("")),
    entry("guides/index.html", "text/html; charset=utf-8", "<title>Guide</title>"),
    entry("robots.txt", "text/plain; charset=utf-8", "User-agent: *\nDisallow: /\n"),
    entry("sitemap.xml", "application/xml", [
      "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">",
      "<url><loc>https://old.example.test/</loc></url>",
      `<url><loc>${ORIGIN}/missing/</loc></url>`,
      `<url><loc>${ORIGIN}/docs/</loc></url>`,
      "</urlset>",
    ].join("")),
  ], [{ from: "/docs/" }]), { productionOrigin: ORIGIN });

  assert.deepEqual(codes(result), [
    "sitemap.origin",
    "sitemap.route_missing",
    "sitemap.redirect_route",
    "robots.crawl_blocked",
    "homepage.noindex",
    "homepage.canonical_not_root",
    "homepage.icon_local_missing",
  ]);
  assert.ok(result.warnings.some((warning) => warning.code === "homepage.icon_external"));
});

test("rejects hostile or malformed XML and encoded sitemap routes within the parser bound", () => {
  const malformed = inspectPrebuiltDiscovery(snapshot([
    entry("sitemap.xml", "application/xml", "<!DOCTYPE urlset [<!ENTITY xxe SYSTEM \"file:///secret\">]><urlset/>"),
  ]), { productionOrigin: ORIGIN });
  assert.ok(codes(malformed).includes("sitemap.unsafe_xml"));

  const encoded = inspectPrebuiltDiscovery(snapshot([
    entry("index.html", "text/html; charset=utf-8", "<link rel=\"icon\" href=\"/assets/icon.svg\">"),
    entry("assets/icon.svg", "image/svg+xml", "<svg/>"),
    entry("sitemap.xml", "application/xml", `<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\"><url><loc>${ORIGIN}/guides%2F</loc></url></urlset>`),
  ]), { productionOrigin: ORIGIN });
  assert.ok(codes(encoded).includes("sitemap.encoded_route"));

  const invalidEntity = inspectPrebuiltDiscovery(snapshot([
    entry("sitemap.xml", "application/xml", `<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\"><url><loc>${ORIGIN}/guides&bogus;</loc></url></urlset>`),
  ]), { productionOrigin: ORIGIN });
  assert.ok(codes(invalidEntity).includes("sitemap.url_invalid"));
});

test("ignores inert markup and honors a local base URL for declared icons", () => {
  const result = inspectPrebuiltDiscovery(snapshot([
    entry("index.html", "text/html; charset=utf-8", [
      "<!-- <meta name=\"robots\" content=\"noindex\"> -->",
      "<script><link rel=\"icon\" href=\"/missing.svg\"></script>",
      "<template><meta name=\"robots\" content=\"noindex\"></template>",
      "<base href=\"/assets/\">",
      `<link rel="canonical" href="${ORIGIN}/">`,
      "<link rel=\"icon\" href=\"icon.svg\">",
    ].join("")),
    entry("assets/icon.svg", "image/svg+xml", "<svg/>"),
  ]), { productionOrigin: ORIGIN });

  assert.deepEqual(result.errors, []);
});

test("rejects empty or signature-invalid declared common image assets", () => {
  const result = inspectPrebuiltDiscovery(snapshot([
    entry("index.html", "text/html; charset=utf-8", "<link rel=\"icon\" href=\"/icon.png\">"),
    entry("icon.png", "image/png", "not-a-png"),
  ]), { productionOrigin: ORIGIN });
  assert.ok(codes(result).includes("homepage.icon_local_missing"));
});

test("reports absent discovery recommendations as warnings", () => {
  const result = inspectPrebuiltDiscovery(snapshot([]), { productionOrigin: ORIGIN });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings.map((warning) => warning.code), [
    "sitemap.missing",
    "robots.missing",
    "homepage.missing",
  ]);
});

test("emits one unconfigured sitemap warning without hiding later homepage recommendations", () => {
  const routes = Array.from({ length: 101 }, (_, index) => `route-${index}`);
  const result = inspectPrebuiltDiscovery(snapshot([
    entry("index.html", "text/html; charset=utf-8", "<title>Docs</title>"),
    ...routes.map((route) => entry(`${route}/index.html`, "text/html; charset=utf-8", "<title>Route</title>")),
    entry("sitemap.xml", "application/xml", `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${routes.map((route) => `<url><loc>${ORIGIN}/${route}/</loc></url>`).join("")}</urlset>`),
  ]));

  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.filter((warning) => warning.code === "sitemap.origin_unconfigured").length, 1);
  assert.ok(result.warnings.some((warning) => warning.code === "homepage.canonical_missing"));
});

test("keeps homepage size and token limits publish-blocking only beyond their boundaries", () => {
  const atTextLimit = "x".repeat(1024 * 1024);
  const withinTextLimit = inspectPrebuiltDiscovery(snapshot([
    entry("index.html", "text/html; charset=utf-8", atTextLimit),
  ]), { productionOrigin: ORIGIN });
  assert.equal(codes(withinTextLimit).includes("text.too_large"), false);

  const overTextLimit = inspectPrebuiltDiscovery(snapshot([
    entry("index.html", "text/html; charset=utf-8", `${atTextLimit}x`),
  ]), { productionOrigin: ORIGIN });
  assert.ok(codes(overTextLimit).includes("text.too_large"));

  const atTokenLimit = inspectPrebuiltDiscovery(snapshot([
    entry("index.html", "text/html; charset=utf-8", "<i>".repeat(10_000)),
  ]), { productionOrigin: ORIGIN });
  assert.equal(codes(atTokenLimit).includes("homepage.too_many_tokens"), false);

  const overTokenLimit = inspectPrebuiltDiscovery(snapshot([
    entry("index.html", "text/html; charset=utf-8", "<i>".repeat(10_001)),
  ]), { productionOrigin: ORIGIN });
  assert.ok(codes(overTokenLimit).includes("homepage.too_many_tokens"));
});


test("rejects staging-relative canonicals, encoded dot routes, robots none, and excessive HTML tokens", () => {
  for (const [html, sitemap, code] of [
    ['<base href="/assets/"><link rel="canonical" href="../">', undefined, "homepage.canonical_invalid"],
    ['<meta name="robots" content="none">', undefined, "homepage.noindex"],
    ["<i>".repeat(10_001), undefined, "homepage.too_many_tokens"],
    ["<title>Docs</title>", `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${ORIGIN}/%2e</loc></url></urlset>`, "sitemap.encoded_route"],
  ]) {
    const files = [entry("index.html", "text/html; charset=utf-8", html)];
    if (sitemap) files.push(entry("sitemap.xml", "application/xml", sitemap));
    assert.ok(codes(inspectPrebuiltDiscovery(snapshot(files), { productionOrigin: ORIGIN })).includes(code), code);
  }
});

test("bounds namespace inheritance and scans many inert tags without losing metadata", () => {
  const nested = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Array.from({ length: 65 }, (_, i) => `<n xmlns:p${i}="urn:${i}">`).join("")}${"</n>".repeat(65)}</urlset>`;
  const namespaces = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ${Array.from({ length: 129 }, (_, i) => `xmlns:p${i}="urn:${i}"`).join(" ")}/>`;
  for (const [xml, code] of [[nested, "sitemap.too_deep"], [namespaces, "sitemap.too_many_namespaces"]]) {
    assert.ok(codes(inspectPrebuiltDiscovery(snapshot([entry("sitemap.xml", "application/xml", xml)]), { productionOrigin: ORIGIN })).includes(code));
  }
  const html = `${"İ".repeat(20)}${"<script></script>".repeat(4_000)}<meta name="robots" content="none">`;
  assert.ok(codes(inspectPrebuiltDiscovery(snapshot([entry("index.html", "text/html; charset=utf-8", html)]), { productionOrigin: ORIGIN })).includes("homepage.noindex"));
});

test("rejects a non-image descriptor for a declared icon", () => {
  const result = inspectPrebuiltDiscovery(snapshot([
    entry("index.html", "text/html; charset=utf-8", '<link rel="icon" href="/icon.bin">'),
    entry("icon.bin", "application/octet-stream", "data"),
  ]), { productionOrigin: ORIGIN });
  assert.ok(codes(result).includes("homepage.icon_local_missing"));
});


test("validates AVIF brands, complete XML syntax, and inert HTML examples", () => {
  for (const [bytes, valid] of [[Buffer.from("not-avif"), false], [Buffer.from("000000146674797061766966000000006d696631", "hex"), true]]) {
    const files = [entry("index.html", "text/html; charset=utf-8", '<link rel="icon" href="/icon.avif">'), { path: "icon.avif", mediaType: "image/avif", content: bytes }];
    assert.equal(codes(inspectPrebuiltDiscovery(snapshot(files), { productionOrigin: ORIGIN })).includes("homepage.icon_local_missing"), !valid);
  }
  const examples = '<textarea><meta name="robots" content="noindex"></textarea><template><template></template><meta name="robots" content="none"></template><script></scripture><meta name="robots" content="noindex"></script>';
  assert.deepEqual(inspectPrebuiltDiscovery(snapshot([entry("index.html", "text/html; charset=utf-8", examples)]), { productionOrigin: ORIGIN }).errors, []);
  for (const [extension, valid] of [['<lastmod>&unknown;</lastmod>', false], ['<image:caption><![CDATA[Text & more]]></image:caption>', true]]) {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="urn:image"><url><loc>${ORIGIN}/</loc>${extension}</url></urlset>`;
    const files = [entry("index.html", "text/html; charset=utf-8", "<title>Docs</title>"), entry("sitemap.xml", "application/xml", xml)];
    assert.equal(codes(inspectPrebuiltDiscovery(snapshot(files), { productionOrigin: ORIGIN })).includes("sitemap.invalid_xml"), !valid);
  }
});


test("accepts declaration literals in comments, CDATA, and processing instructions", () => {
  const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:doc="urn:docs"><!-- <!DOCTYPE <!ENTITY --><?example <!DOCTYPE <!ENTITY ?><url><loc>${ORIGIN}/</loc><doc:note><![CDATA[<!DOCTYPE <!ENTITY]]></doc:note></url></urlset>`;
  const result = inspectPrebuiltDiscovery(snapshot([entry("index.html", "text/html; charset=utf-8", "<title>Docs</title>"), entry("sitemap.xml", "application/xml", xml)]), { productionOrigin: ORIGIN });
  assert.deepEqual(result.errors, []);
});
