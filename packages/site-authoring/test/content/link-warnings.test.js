import assert from "node:assert/strict";
import test from "node:test";

import { autolinkedLinks, autolinkWarnings, LINK_AUTOLINKED } from "../../src/content/link-warnings.js";

const linked = (text, href) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text, marks: [{ type: "link", attrs: { href } }] }] }],
});

test("flags a link whose address is only http(s):// plus its own text (TR01198)", async (t) => {
  for (
    const [text, href] of [
      ["ASP.NET", "http://ASP.NET"],
      ["asp.net", "http://ASP.NET/"],
      ["Node.js", "https://node.js"],
      ["example.com", "http://example.com"],
    ]
  ) {
    await t.test(`${text} → ${href}`, () => assert.deepEqual(autolinkedLinks(linked(text, href)), [{ text, href }]));
  }
});

test("leaves links an author plausibly chose alone (TR01198)", async (t) => {
  for (
    const [text, href] of [
      ["ASP.NET docs", "http://ASP.NET"],
      ["ASP.NET", "https://dotnet.microsoft.com/apps/aspnet"],
      ["example.com", "https://example.com/about"],
      ["example.com", "https://example.com/?ref=1"],
      ["example.com", "https://example.com/#top"],
      ["example.com", "https://example.com:8443"],
      ["https://example.com", "https://example.com"],
      ["mail me", "mailto:me@example.com"],
      ["about", "/about"],
    ]
  ) {
    await t.test(`${text} → ${href}`, () => assert.deepEqual(autolinkedLinks(linked(text, href)), []));
  }
});

test("reports each flagged link with its page, never as a refusal (TR01198)", () => {
  const progress = [];
  const result = autolinkWarnings(
    [
      { file: "pages/index.pm.json", pagePath: "", document: linked("ASP.NET", "http://ASP.NET") },
      { file: "pages/about.pm.json", pagePath: "about", document: linked("about", "/about") },
    ],
    (line) => progress.push(line),
  );
  assert.deepEqual(result, {
    linkWarnings: {
      total: 1,
      items: [{ code: LINK_AUTOLINKED, file: "pages/index.pm.json", path: "/", text: "ASP.NET", href: "http://ASP.NET" }],
    },
  });
  assert.equal(progress.length, 1);
  assert.deepEqual(autolinkWarnings([], () => {}), {});
});

test("reads a link split across runs as one label (TR01198)", () => {
  const document = {
    type: "doc",
    content: [{
      type: "paragraph",
      content: [
        { type: "text", text: "ASP", marks: [{ type: "bold" }, { type: "link", attrs: { href: "http://ASP.NET" } }] },
        { type: "text", text: ".NET", marks: [{ type: "link", attrs: { href: "http://ASP.NET" } }] },
        { type: "text", text: " Core" },
      ],
    }],
  };
  assert.deepEqual(autolinkedLinks(document), [{ text: "ASP.NET", href: "http://ASP.NET" }]);
});

test("names a bounded number on progress and bounds the JSON list by bytes (TR01198)", () => {
  const content = Array.from({ length: 400 }, (_, index) => ({
    type: "paragraph",
    content: [{
      type: "text",
      text: `site-${index}.example`,
      marks: [{ type: "link", attrs: { href: `http://site-${index}.example` } }],
    }],
  }));
  const progress = [];
  const { linkWarnings } = autolinkWarnings(
    [{ file: "pages/many.pm.json", pagePath: "many", document: { type: "doc", content } }],
    (line) => progress.push(line),
  );
  assert.equal(linkWarnings.total, 400);
  assert.equal(linkWarnings.truncated, true);
  assert.ok(linkWarnings.items.length < 400);
  assert.ok(Buffer.byteLength(JSON.stringify(linkWarnings.items), "utf8") <= 8 * 1024);
  assert.equal(progress.length, 21);
  assert.match(progress.at(-1), /380 more autolink-shaped link/u);
});

test("scans a typed page's body, introduction and recipe steps (TR01198)", () => {
  const paragraph = (text, href) => ({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text, marks: [{ type: "link", attrs: { href } }] }] }],
  });
  const { linkWarnings } = autolinkWarnings(
    [
      { file: "pages/post.pm.json", pagePath: "post", document: { template: "article", data: { body: paragraph("ASP.NET", "http://ASP.NET") } } },
      {
        file: "pages/soup.pm.json",
        pagePath: "soup",
        document: {
          template: "recipe",
          data: {
            introductionBody: paragraph("Node.js", "http://Node.js"),
            instructionSections: [{ stepBodies: [paragraph("example.com", "https://example.com")] }],
          },
        },
      },
    ],
    () => {},
  );
  assert.deepEqual(linkWarnings.items.map((item) => [item.file, item.text]), [
    ["pages/post.pm.json", "ASP.NET"],
    ["pages/soup.pm.json", "Node.js"],
    ["pages/soup.pm.json", "example.com"],
  ]);
});
