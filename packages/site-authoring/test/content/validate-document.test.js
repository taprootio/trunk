import assert from "node:assert/strict";
import test from "node:test";

import { validateDocument } from "../../src/content/validate-document.js";

// Every rejection below is something the published-site renderer accepts and
// then silently mangles: an unknown node rendered as its children, a clamped
// heading, a dropped link, an image with no delivery keys. The assertions are
// on the stable `code` and the JSON pointer, never on message wording.

const IMAGE_ID = "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607";

const doc = (...content) => ({ type: "doc", content });
const paragraph = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
const image = (attrs = {}) => ({
  type: "taprootImage",
  attrs: { imageId: IMAGE_ID, src: "", urls: [], ...attrs },
});
const tableCell = (type, ...content) => ({
  type,
  content: [{ type: "paragraph", ...(content.length > 0 ? { content } : {}) }],
});
const validTable = (attrs = {}) => ({
  type: "table",
  ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
  content: [
    {
      type: "tableRow",
      content: [
        tableCell("tableHeader", { type: "text", text: "Plan" }),
        tableCell("tableHeader", {
          type: "text",
          text: "Rate",
        }),
      ],
    },
    {
      type: "tableRow",
      content: [
        tableCell("tableCell", { type: "text", text: "Single" }),
        tableCell("tableCell", {
          type: "text",
          text: "$24",
        }),
      ],
    },
  ],
});
const codesOf = (result) => result.errors.map((error) => error.code);
const pathsOf = (result) => result.errors.map((error) => error.path);

function assertValid(document, options) {
  assert.deepEqual(validateDocument(document, options).errors, []);
}

function assertRejects(document, code, options) {
  const result = validateDocument(document, options);
  assert.ok(
    codesOf(result).includes(code),
    `expected ${code}, got ${JSON.stringify(result.errors)}`,
  );
  return result;
}

test("accepts a document using every node and mark the renderer understands", () => {
  assertValid({
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 1, textAlign: "center", fontSize: "1.25rem" },
        content: [{ type: "text", text: "Title" }],
      },
      {
        type: "paragraph",
        attrs: { textAlign: "justify", fontSize: "calc(2 * var(--esp-size-medium-to-big))" },
        content: [
          { type: "text", text: "bold", marks: [{ type: "bold" }] },
          { type: "text", text: "italic", marks: [{ type: "italic" }] },
          { type: "text", text: "underline", marks: [{ type: "underline" }] },
          { type: "text", text: "strike", marks: [{ type: "strike" }] },
          { type: "text", text: "code", marks: [{ type: "code" }] },
          {
            type: "text",
            text: "link",
            marks: [{
              type: "link",
              attrs: {
                href: "https://example.test/a",
                target: "_blank",
                rel: "noopener noreferrer nofollow",
                class: null,
              },
            }],
          },
          { type: "hardBreak" },
        ],
      },
      { type: "bulletList", content: [{ type: "listItem", content: [paragraph("one")] }] },
      {
        type: "orderedList",
        content: [{
          type: "listItem",
          content: [paragraph("one"), {
            type: "bulletList",
            content: [{ type: "listItem", content: [paragraph("deep")] }],
          }],
        }],
      },
      { type: "blockquote", content: [paragraph("quoted")] },
      { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const a = 1;" }] },
      { type: "codeBlock" },
      { type: "horizontalRule" },
      image({
        alt: "A caption",
        width: 1600,
        height: 900,
        // A crop may only ride a pulled image, whose src is the signed crop
        // URL the delivery rewriter stored — the authored empty-src shape
        // with a crop is refused (covered by its own test below).
        src: "https://cdn.example.test/stored/img/v1/stored/crop/k1.AA.AA/w/640.webp",
        crop: { x: 0, y: 0.25, width: 1, height: 0.5 },
        maxHeightVh: 75,
        maxHeight: "32rem",
        borderWidth: "0",
        presentationPlacement: "center",
        imageAlign: "center",
        imagePlacement: "float-start",
        textAlign: "center",
        urls: [{ minWidth: 640, url: "https://cdn.example.test/640.webp", type: "image/webp" }],
      }),
      validTable({ caption: "Rates" }),
      { type: "componentBlock", attrs: { componentType: "spacer", componentData: "{\"height\":\"large\"}" } },
      {
        type: "section",
        attrs: { context: "inverted", contentPadding: "standard", surface: "elevated" },
        content: [paragraph("inside a section")],
      },
    ],
  });
});

test("holds explicit sections to their closed attributes and non-nesting content model", async (testContext) => {
  await testContext.test("accepts omitted defaults and every explicit value", () => {
    assertValid(doc({ type: "section", content: [paragraph("defaults")] }));
    assertValid(doc({
      type: "section",
      attrs: { context: "inverted_2", contentPadding: "none", surface: "raised" },
      content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Band" }] }],
    }));
  });

  for (
    const [name, node, code, path] of [
      ["an empty section", { type: "section" }, "content.child_required", "/content/0/content"],
      [
        "a nested section",
        { type: "section", content: [{ type: "section", content: [paragraph("nested")] }] },
        "content.child_not_allowed",
        "/content/0/content/0",
      ],
      [
        "an unknown attribute",
        { type: "section", attrs: { layout: "split" }, content: [paragraph("x")] },
        "content.attr_unknown",
        "/content/0/attrs/layout",
      ],
      [
        "an invalid context identifier",
        { type: "section", attrs: { context: "not a context" }, content: [paragraph("x")] },
        "content.attr_invalid",
        "/content/0/attrs/context",
      ],
      [
        "an invalid padding",
        { type: "section", attrs: { contentPadding: "compact" }, content: [paragraph("x")] },
        "content.attr_invalid",
        "/content/0/attrs/contentPadding",
      ],
      [
        "an invalid surface",
        { type: "section", attrs: { surface: "floating" }, content: [paragraph("x")] },
        "content.attr_invalid",
        "/content/0/attrs/surface",
      ],
    ]
  ) {
    await testContext.test(name, () => {
      const result = assertRejects(doc(node), code);
      assert.ok(pathsOf(result).includes(path));
    });
  }
});

test("validates semantic tables as a closed root-or-section block contract", async (testContext) => {
  const rich = validTable({ caption: "Drop-in rates 😀" });
  rich.content[1].content[0] = tableCell(
    "tableCell",
    { type: "text", text: "Read ", marks: [{ type: "italic" }] },
    { type: "hardBreak" },
    {
      type: "text",
      text: "details",
      marks: [{ type: "link", attrs: { href: "/rates" } }],
    },
  );
  rich.content[1].content[1] = tableCell("tableCell");
  assertValid(doc(rich));
  assertValid(doc({ type: "section", content: [validTable()] }));
  assertValid(doc(validTable({ caption: null })));
  assertValid(doc(validTable({ caption: "😀".repeat(160) })));

  await testContext.test("explicit marks keys are rejected on every non-markable table block", () => {
    for (
      const [label, mutate] of [
        ["table", (table) => table.marks = null],
        ["row", (table) => table.content[0].marks = []],
        ["cell", (table) => table.content[0].content[0].marks = null],
        ["cell paragraph", (table) => table.content[0].content[0].content[0].marks = []],
      ]
    ) {
      const table = validTable();
      mutate(table);
      const result = assertRejects(doc(table), "content.mark_misplaced");
      assert.ok(
        pathsOf(result).some((path) => path.endsWith("/marks")),
        `${label} should report its explicit marks key`,
      );
    }
  });

  await testContext.test("missing, invalid, and empty headers have the header diagnostic", () => {
    for (
      const table of [
        { type: "table", content: [] },
        (() => {
          const value = validTable();
          value.content[0].content[0].type = "tableCell";
          return value;
        })(),
        (() => {
          const value = validTable();
          value.content[0].content[0] = tableCell("tableHeader", { type: "text", text: " \t " });
          return value;
        })(),
      ]
    ) {
      assertRejects(doc(table, paragraph("keep")), "content.table_header");
    }
  });

  await testContext.test("row role and container mistakes have the shape diagnostic", () => {
    const repeatedHeader = validTable();
    repeatedHeader.content[1].content[0].type = "tableHeader";
    assertRejects(doc(repeatedHeader), "content.table_shape");

    const wrongChild = validTable();
    wrongChild.content[1] = paragraph("not a row");
    assertRejects(doc(wrongChild), "content.table_shape");
  });

  await testContext.test("ragged rows are distinct from configured bounds", () => {
    const ragged = validTable();
    ragged.content[0].content.push(tableCell("tableHeader", { type: "text", text: "Details" }));
    const result = assertRejects(doc(ragged), "content.table_ragged");
    assert.ok(pathsOf(result).includes("/content/0/content/1/content"));
  });

  await testContext.test("row, column, caption, and actual cell-text ceilings share the bounds diagnostic", () => {
    const noData = validTable();
    noData.content.length = 1;
    assertRejects(doc(noData), "content.table_bounds");

    const tooManyRows = validTable();
    const dataRow = tooManyRows.content[1];
    tooManyRows.content = [tooManyRows.content[0], ...Array.from({ length: 101 }, () => structuredClone(dataRow))];
    assertRejects(doc(tooManyRows), "content.table_bounds");

    const tooManyColumns = validTable();
    tooManyColumns.content = [
      {
        type: "tableRow",
        content: Array.from(
          { length: 13 },
          (_, index) => tableCell("tableHeader", { type: "text", text: `H${index}` }),
        ),
      },
      {
        type: "tableRow",
        content: Array.from({ length: 13 }, () => tableCell("tableCell")),
      },
    ];
    assertRejects(doc(tooManyColumns), "content.table_bounds");
    assertRejects(doc(validTable({ caption: "😀".repeat(161) })), "content.table_bounds");

    const exact = validTable();
    exact.content[1].content[0] = tableCell(
      "tableCell",
      { type: "text", text: "😀".repeat(600), marks: [{ type: "bold" }] },
      { type: "text", text: "x".repeat(400) },
    );
    assertValid(doc(exact));
    exact.content[1].content[0].content[0].content[1].text += "y";
    assertRejects(doc(exact), "content.table_bounds");
  });

  await testContext.test("cells contain exactly one paragraph with inline content", () => {
    const multipleParagraphs = validTable();
    multipleParagraphs.content[1].content[0].content.push(paragraph("second"));
    assertRejects(doc(multipleParagraphs), "content.table_cell_content");

    const blockCell = validTable();
    blockCell.content[1].content[0].content = [{
      type: "bulletList",
      content: [{ type: "listItem", content: [paragraph("nested")] }],
    }];
    assertRejects(doc(blockCell), "content.table_cell_content");

    const styledCellParagraph = validTable();
    styledCellParagraph.content[1].content[0].content[0].attrs = { textAlign: "center" };
    const styledResult = assertRejects(doc(styledCellParagraph), "content.table_cell_content");
    assert.ok(pathsOf(styledResult).includes("/content/0/content/1/content/0/content/0/attrs"));
  });

  await testContext.test("span attributes receive their own correction code", () => {
    for (const attribute of ["colspan", "rowspan", "colwidth"]) {
      const table = validTable();
      table.content[1].content[0].attrs = { [attribute]: attribute === "colwidth" ? [100] : 2 };
      const result = assertRejects(doc(table), "content.table_span");
      assert.ok(pathsOf(result).includes(`/content/0/content/1/content/0/attrs/${attribute}`));
    }
  });

  await testContext.test("tables do not nest in lists, blockquotes, or cells", () => {
    assertRejects(
      doc({ type: "bulletList", content: [{ type: "listItem", content: [paragraph("first"), validTable()] }] }),
      "content.child_not_allowed",
    );
    assertRejects(doc({ type: "blockquote", content: [validTable()] }), "content.child_not_allowed");
    const nested = validTable();
    nested.content[1].content[0].content = [validTable()];
    assertRejects(doc(nested), "content.table_cell_content");
  });
});

test("validates decoration through the section's nested processed-image contract", () => {
  const valid = {
    image: {
      imageId: IMAGE_ID,
      src: "/img/starburst-640.webp",
      urls: [{ minWidth: 640, url: "/img/starburst-640.webp" }],
      width: 1200,
      height: 1200,
      alt: "",
    },
    anchor: "top-end",
    inlineOffsetPercent: 18,
    blockOffsetPercent: -12,
    inlineSizePercent: 62,
    opacity: 0.09,
    tint: "accent",
  };
  assertValid(doc({ type: "section", attrs: { decoration: valid }, content: [paragraph("Decorated")] }));

  const result = assertRejects(
    doc({
      type: "section",
      attrs: { decoration: { ...valid, image: { ...valid.image, src: "javascript:alert(1)" } } },
      content: [paragraph("Unsafe")],
    }),
    "content.attr_invalid",
  );
  assert.ok(pathsOf(result).includes("/content/0/attrs/decoration/image/src"));
});

test("validates and places the complete section background contract through a document", () => {
  const image = {
    imageId: IMAGE_ID,
    src: "/img/class-640.webp",
    urls: [{ minWidth: 640, url: "/img/class-640.webp" }],
    width: 1920,
    height: 1080,
    alt: "A hot yoga class",
  };
  assertValid(doc({
    type: "section",
    attrs: {
      background: {
        image,
        portraitImage: image,
        focus: { x: 0.55, y: 0.4 },
        portraitFocus: { x: 0.5, y: 0.25 },
        scrimStrength: "strong",
      },
    },
    content: [paragraph("Photo band")],
  }));

  const result = assertRejects(doc({
    type: "section",
    attrs: { background: { image, portraitFocus: { x: 0.5, y: 2 } } },
    content: [paragraph("Unsafe")],
  }), "content.attr_invalid");
  assert.ok(pathsOf(result).includes("/content/0/attrs/background/portraitFocus/y"));
});

test("accepts a document in the shape the editor and the API actually store", () => {
  // The regression fixture. Every node here carries what prosemirror-model
  // actually serialises for it — a node type that declares any attribute
  // serialises all of them, defaults included, and a node carrying marks
  // serialises those too — so this is what a `pull` returns and what a `pages
  // push` of unedited content sends back. Three blockers in review were
  // exactly this: an ordered list's `{start, type}`, a link mark's fifth
  // attribute, and a bold hard break.
  const deliveryUrl = `https://cdn.example.test/${IMAGE_ID}/img/v1/${IMAGE_ID}/a/k1.sig/w/1280.webp`;
  assertValid({
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 2, textAlign: null, fontSize: null },
        content: [{ type: "text", text: "Our story" }],
      },
      {
        type: "paragraph",
        attrs: { textAlign: null, fontSize: null },
        content: [
          { type: "text", text: "Read the " },
          {
            type: "text",
            text: "handbook",
            marks: [{
              type: "link",
              attrs: {
                href: "https://example.test/handbook",
                target: "_blank",
                rel: "noopener noreferrer nofollow",
                class: null,
                title: null,
              },
            }],
          },
          { type: "text", text: " first." },
        ],
      },
      {
        // Bolding across a line break marks the break itself: `AddMarkStep`
        // marks every atom in the range, and the `<br>` is one.
        type: "paragraph",
        attrs: { textAlign: null, fontSize: null },
        content: [
          { type: "text", text: "Doors at six", marks: [{ type: "bold" }] },
          { type: "hardBreak", marks: [{ type: "bold" }] },
          { type: "text", text: "class at seven", marks: [{ type: "bold" }] },
        ],
      },
      {
        type: "orderedList",
        attrs: { start: 1, type: null },
        content: [{
          type: "listItem",
          content: [{
            type: "paragraph",
            attrs: { textAlign: null, fontSize: null },
            content: [{ type: "text", text: "Sign in" }],
          }],
        }],
      },
      {
        type: "bulletList",
        content: [{
          type: "listItem",
          content: [{
            type: "paragraph",
            attrs: { textAlign: null, fontSize: null },
            content: [{ type: "text", text: "Bring a towel" }],
          }],
        }],
      },
      { type: "codeBlock", attrs: { language: null }, content: [{ type: "text", text: "npm test" }] },
      {
        type: "taprootImage",
        attrs: {
          src: deliveryUrl,
          imageId: IMAGE_ID,
          width: 1600,
          height: 900,
          alt: "The studio",
          urls: [
            { minWidth: 640, url: `https://cdn.example.test/${IMAGE_ID}/img/v1/${IMAGE_ID}/a/k1.sig/w/640.webp` },
            { minWidth: 1280, url: deliveryUrl, type: "image/webp" },
          ],
          crop: null,
          maxHeightVh: "site-default",
          maxHeight: null,
          borderWidth: null,
          presentationPlacement: "site-default",
          imageAlign: null,
          imagePlacement: null,
          textAlign: null,
        },
      },
      {
        type: "componentBlock",
        attrs: {
          componentType: "spacer",
          componentData: "{\"height\":\"medium\",\"showDivider\":false,\"dividerStyle\":\"solid\",\"dividerWidth\":1}",
        },
      },
      { type: "horizontalRule" },
      { type: "paragraph", attrs: { textAlign: null, fontSize: null } },
    ],
  });
});

test("accepts the site-default sentinel and null wherever the editor writes them", () => {
  assertValid(doc(image({
    alt: null,
    width: null,
    height: null,
    crop: null,
    maxHeightVh: "site-default",
    maxHeight: "site-default",
    borderWidth: "site-default",
    presentationPlacement: "site-default",
    imageAlign: null,
    imagePlacement: null,
    textAlign: null,
  })));
  assertValid(
    doc({ type: "paragraph", attrs: { textAlign: null, fontSize: null }, content: [{ type: "text", text: "x" }] }),
  );
  assertValid(doc({ type: "codeBlock", attrs: { language: null }, content: [{ type: "text", text: "x" }] }));
});

test("rejects nodes outside the renderer's switch", async (testContext) => {
  for (const type of ["image", "bulletlist", "hard_break", "taprootVideo", "", "paragraph "]) {
    await testContext.test(JSON.stringify(type), () => {
      assertRejects(doc({ type, content: [{ type: "text", text: "x" }] }), "content.unknown_node");
    });
  }
});

test("refuses keys ProseMirror never serialises, which is how content goes missing", async (testContext) => {
  // The quietest failure in the format. Each of these is *structurally* legal
  // ProseMirror — an empty-but-valid node — so the document keeps its presence
  // through the content that surrounds it, the server stores it, and the
  // renderer walks `node.content`, finds nothing, and publishes the block
  // empty. Every fixture below therefore carries real content elsewhere, so
  // the assertion proves the key check caught it and not the emptiness check.
  const cases = [
    ["text where content belongs", { type: "paragraph", text: "lost" }, "/content/1/text"],
    [
      "a misspelled content key",
      { type: "paragraph", contents: [{ type: "text", text: "lost" }] },
      "/content/1/contents",
    ],
    [
      "a stray key beside real content",
      { type: "heading", attrs: { level: 2 }, title: "lost", content: [{ type: "text", text: "kept" }] },
      "/content/1/title",
    ],
    [
      "content on a leaf node",
      { type: "horizontalRule", content: [{ type: "text", text: "lost" }] },
      "/content/1/content",
    ],
    [
      "content on a block atom",
      { ...image(), content: [{ type: "text", text: "lost" }] },
      "/content/1/content",
    ],
  ];
  for (const [name, node, path] of cases) {
    await testContext.test(name, () => {
      const result = assertRejects(doc(paragraph("Real content, so the body is present."), node), "content.node_key");
      assert.ok(pathsOf(result).includes(path), `expected ${path}, got ${JSON.stringify(pathsOf(result))}`);
      // The emptiness check must not be what saves us here.
      assert.ok(!codesOf(result).includes("content.empty_document"));
    });
  }

  await testContext.test("a stray key on the document root", () => {
    const result = assertRejects({ type: "doc", content: [paragraph("kept")], title: "lost" }, "content.node_key");
    assert.ok(pathsOf(result).includes("/title"));
  });

  await testContext.test("text on an inline leaf", () => {
    assertRejects(
      doc({ type: "paragraph", content: [{ type: "text", text: "a" }, { type: "hardBreak", text: "lost" }] }),
      "content.node_key",
    );
  });

  await testContext.test("a stray key on a mark", () => {
    // `href` at the top level of the mark instead of inside `attrs` is the
    // shape an agent writes from memory; `Mark.toJSON` emits only type and
    // attrs, so the value is simply dropped.
    const result = assertRejects(
      doc({ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", href: "/a" }] }] }),
      "content.mark_key",
    );
    assert.ok(pathsOf(result).includes("/content/0/content/0/marks/0/href"));

    assertRejects(
      doc({ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "bold", weight: 700 }] }] }),
      "content.mark_key",
    );
  });

  await testContext.test("the keys ProseMirror does serialise are untouched", () => {
    // `Node.toJSON` writes type/attrs/content/marks, `TextNode.toJSON` adds
    // text, `Mark.toJSON` writes type/attrs — the complete set, which is what
    // makes refusing everything else safe for a pull/push round trip.
    assertValid(doc({
      type: "paragraph",
      attrs: { textAlign: null, fontSize: null },
      content: [
        { type: "text", text: "x", marks: [{ type: "bold" }] },
        { type: "hardBreak", marks: [{ type: "bold" }] },
      ],
    }));
  });
});

test("rejects marks outside the renderer's switch", async (testContext) => {
  for (const type of ["highlight", "superscript", "textStyle", "strong", "em"]) {
    await testContext.test(type, () => {
      assertRejects(
        doc({ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type }] }] }),
        "content.unknown_mark",
      );
    });
  }
});

test("accepts marks on exactly the nodes ProseMirror can put them on", async (testContext) => {
  // A mark lands on a node when the node's *parent* allows that mark:
  // `AddMarkStep` marks every atom in range, `ParseContext.insertNode` applies
  // the active set, and both test the parent. Only `paragraph` and `heading`
  // have `markSet == null`, so only their inline atoms — text and hardBreak —
  // can arrive marked.
  const marked = (node) => doc({ type: "paragraph", content: [{ type: "text", text: "a" }, node] });

  await testContext.test("a bold hard break, as bolding two lines produces", () => {
    assertValid(marked({ type: "hardBreak", marks: [{ type: "bold" }] }));
  });
  await testContext.test("a hard break carrying every mark", () => {
    assertValid(marked({
      type: "hardBreak",
      marks: [
        { type: "bold" },
        { type: "italic" },
        { type: "underline" },
        { type: "strike" },
        { type: "code" },
        { type: "link", attrs: { href: "/a" } },
      ],
    }));
  });
  await testContext.test("a hard break's marks are still held to the vocabulary", () => {
    assertRejects(marked({ type: "hardBreak", marks: [{ type: "highlight" }] }), "content.unknown_mark");
    assertRejects(
      marked({ type: "hardBreak", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }),
      "content.link_href",
    );
  });

  // The block atoms cannot: their parents (doc, listItem, blockquote) have
  // `markSet == []`, so ProseMirror never marks them and a marked one is a
  // hand-built document, not a pulled one.
  const blockAtoms = [
    ["horizontalRule", { type: "horizontalRule", marks: [{ type: "bold" }] }],
    ["taprootImage", { ...image(), marks: [{ type: "bold" }] }],
    [
      "componentBlock",
      {
        type: "componentBlock",
        attrs: { componentType: "spacer", componentData: "{}" },
        marks: [{ type: "bold" }],
      },
    ],
  ];
  for (const [name, node] of blockAtoms) {
    await testContext.test(`rejects a marked ${name}`, () => {
      assertRejects(doc(node, paragraph("keep")), "content.mark_misplaced");
    });
  }
});

test("rejects heading levels the renderer would clamp", async (testContext) => {
  for (const level of [0, -1, 5, 6, 9, 1.5, "2", null, undefined]) {
    await testContext.test(JSON.stringify(level) ?? "undefined", () => {
      const attrs = level === undefined ? {} : { level };
      const result = assertRejects(
        doc({ type: "heading", attrs, content: [{ type: "text", text: "Title" }] }),
        "content.heading_level",
      );
      assert.ok(pathsOf(result).includes("/content/0/attrs/level"));
    });
  }
  for (const level of [1, 2, 3, 4]) {
    await testContext.test(`accepts ${level}`, () => {
      assertValid(doc({ type: "heading", attrs: { level }, content: [{ type: "text", text: "Title" }] }));
    });
  }
});

test("rejects a heading with no level at all", () => {
  assertRejects(doc({ type: "heading", content: [{ type: "text", text: "Title" }] }), "content.heading_level");
});

test("rejects text nodes ProseMirror cannot represent", async (testContext) => {
  const cases = [
    ["missing text", { type: "text" }],
    ["empty text", { type: "text", text: "" }],
    ["non-string text", { type: "text", text: 12 }],
  ];
  for (const [name, node] of cases) {
    await testContext.test(name, () => {
      assertRejects(
        doc({ type: "paragraph", content: [node, { type: "text", text: "keep" }] }),
        "content.text_invalid",
      );
    });
  }
});

test("rejects marks the renderer never applies", async (testContext) => {
  const cases = [
    [
      "on a block node",
      doc({ type: "paragraph", marks: [{ type: "bold" }], content: [{ type: "text", text: "x" }] }),
      "content.mark_misplaced",
    ],
    [
      "inside a code block",
      doc({ type: "codeBlock", content: [{ type: "text", text: "x", marks: [{ type: "bold" }] }] }),
      "content.mark_misplaced",
    ],
    [
      "duplicated on one text node",
      doc({ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "bold" }, { type: "bold" }] }] }),
      "content.marks_invalid",
    ],
    [
      "not an array",
      doc({ type: "paragraph", content: [{ type: "text", text: "x", marks: { type: "bold" } }] }),
      "content.marks_invalid",
    ],
    [
      "not an object",
      doc({ type: "paragraph", content: [{ type: "text", text: "x", marks: ["bold"] }] }),
      "content.marks_invalid",
    ],
  ];
  for (const [name, document, code] of cases) {
    await testContext.test(name, () => assertRejects(document, code));
  }
});

test("holds link hrefs to the renderer's isSafeUrl", async (testContext) => {
  const link = (attrs) =>
    doc({ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs }] }] });
  const rejected = [
    undefined,
    {},
    { href: "" },
    { href: "javascript:alert(1)" },
    { href: "java\nscript:alert(1)" },
    { href: "//evil.example/path" },
    { href: "/\\evil.example/path" },
    { href: "relative\\path" },
    { href: "data:text/html;base64,PHNjcmlwdD4=" },
    { href: "vbscript:msgbox(1)" },
    { href: 42 },
  ];
  for (const attrs of rejected) {
    await testContext.test(`rejects ${JSON.stringify(attrs)}`, () => {
      assertRejects(link(attrs), "content.link_href");
    });
  }
  const accepted = [
    "https://example.test/a?b=1#c",
    "http://example.test",
    "mailto:studio@example.test",
    "tel:+12535550123",
    "/about",
    "./sibling",
    "#anchor",
    "?q=1",
    // Unparseable by `new URL()`, so the renderer treats it as a relative
    // reference and keeps the anchor. The validator has to agree.
    "relative/path",
  ];
  for (const href of accepted) {
    await testContext.test(`accepts ${href}`, () => assertValid(link({ href })));
  }
});

test("accepts a link mark carrying every attribute the extension declares", () => {
  // `@tiptap/extension-link` declares href, target, rel, class, and title, and
  // `Mark.toJSON` emits all five — so this is the shape of every link the
  // editor has ever stored, and refusing any of it would break pull/push.
  assertValid(doc({
    type: "paragraph",
    content: [{
      type: "text",
      text: "handbook",
      marks: [{
        type: "link",
        attrs: {
          href: "https://example.test/handbook",
          target: "_blank",
          rel: "noopener noreferrer nofollow",
          class: null,
          title: null,
        },
      }],
    }],
  }));
});

test("accepts an ordered list exactly as the editor serialises it", async (testContext) => {
  const list = (attrs) => {
    const node = { type: "orderedList", content: [{ type: "listItem", content: [paragraph("one")] }] };
    if (attrs) node.attrs = attrs;
    return doc(node);
  };

  // OrderedList declares `start` (default 1) and `type` (default null), and
  // prosemirror-model emits a node's attrs whenever its type declares any, so
  // every stored ordered list carries the pair.
  await testContext.test("the editor's default attrs", () => assertValid(list({ start: 1, type: null })));
  await testContext.test("no attrs at all", () => assertValid(list()));
  await testContext.test("explicit nulls", () => assertValid(list({ start: null, type: null })));

  // The renderer publishes a bare <ol> and reads neither attribute.
  for (
    const [name, attrs] of [
      ["a start the renderer would discard", { start: 3, type: null }],
      ["a fractional start", { start: 1.5, type: null }],
      ["a list-style type the renderer would discard", { start: 1, type: "a" }],
    ]
  ) {
    await testContext.test(`rejects ${name}`, () => {
      const result = assertRejects(list(attrs), "content.attr_invalid");
      assert.ok(pathsOf(result).some((path) => path.endsWith("/start") || path.endsWith("/type")));
    });
  }
});

test("reports an attribute named after an Object.prototype member", async (testContext) => {
  // A bare index would resolve `constructor` to a function and then throw on
  // `.check`, surfacing as an opaque failure instead of a named finding.
  for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    await testContext.test(key, () => {
      // Built through JSON.parse so `__proto__` is a real own property, as it
      // is in every document that arrives over the wire.
      const attrs = JSON.parse(`{"${key}": "x"}`);
      const node = assertRejects(
        doc({ type: "paragraph", attrs, content: [{ type: "text", text: "x" }] }),
        "content.attr_unknown",
      );
      assert.ok(pathsOf(node).includes(`/content/0/attrs/${key}`));

      const markAttrs = JSON.parse(`{"href": "/a", "${key}": "x"}`);
      const mark = assertRejects(
        doc({ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: markAttrs }] }] }),
        "content.attr_unknown",
      );
      assert.ok(pathsOf(mark).includes(`/content/0/content/0/marks/0/attrs/${key}`));
    });
  }
});

test("refuses a crop on an image whose src is the empty string authored content sends", async (testContext) => {
  const crop = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
  // A pulled image's src is the signed crop URL the delivery rewriter wrote.
  const signedCropUrl = `https://cdn.example.test/${IMAGE_ID}/img/v1/${IMAGE_ID}`
    + "/a/k1.EjRWeBI0VngSNFZ4EjRWeBI0VngSNFZ4EjRWeBI0Vng/crop/k1.AAAAAAAAAAAA"
    + ".EjRWeBI0VngSNFZ4EjRWeBI0VngSNFZ4EjRWeBI0Vng/w/640.webp";

  await testContext.test("authored: a crop with an empty src is refused", () => {
    // PageImageDeliveryRewriter sends any node carrying `crop` down its
    // persisted-crop branch, finds no crop token in the empty keys, and writes
    // no delivery URL at all — the image publishes blank.
    const result = assertRejects(doc(image({ crop })), "content.image_keys");
    assert.ok(pathsOf(result).includes("/content/0/attrs/crop"));
  });

  await testContext.test("pulled: a crop with the stored signed src is accepted", () => {
    assertValid(doc(image({
      crop,
      src: signedCropUrl,
      urls: [{ minWidth: 640, url: signedCropUrl, type: "image/webp" }],
    })));
  });

  await testContext.test("a null crop is not a crop", () => assertValid(doc(image({ crop: null }))));
});

test("rejects attributes no extension declares", async (testContext) => {
  const cases = [
    [
      "unknown node attribute",
      doc({ type: "paragraph", attrs: { id: "x" }, content: [{ type: "text", text: "x" }] }),
      "content.attr_unknown",
    ],
    [
      // BulletList declares no attributes at all, so a stored bullet list has
      // no attrs key; `start` belongs to OrderedList and is refused here.
      "attribute on a bullet list",
      doc({ type: "bulletList", attrs: { start: 3 }, content: [{ type: "listItem", content: [paragraph("x")] }] }),
      "content.attr_unknown",
    ],
    [
      "attribute on a blockquote",
      doc({ type: "blockquote", attrs: { cite: "x" }, content: [paragraph("x")] }),
      "content.attr_unknown",
    ],
    [
      "unknown mark attribute",
      doc({
        type: "paragraph",
        content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "/a", download: "x" } }] }],
      }),
      "content.attr_unknown",
    ],
    [
      "attrs that are not an object",
      doc({ type: "paragraph", attrs: [], content: [{ type: "text", text: "x" }] }),
      "content.attrs_invalid",
    ],
  ];
  for (const [name, document, code] of cases) {
    await testContext.test(name, () => assertRejects(document, code));
  }
});

test("holds textAlign, fontSize, and language to what the renderer emits", async (testContext) => {
  const block = (attrs) => doc({ type: "paragraph", attrs, content: [{ type: "text", text: "x" }] });
  for (const textAlign of ["left", "center", "right", "justify"]) {
    await testContext.test(`accepts textAlign ${textAlign}`, () => assertValid(block({ textAlign })));
  }
  for (const textAlign of ["start", "end", "CENTER", "middle", 1]) {
    await testContext.test(`rejects textAlign ${JSON.stringify(textAlign)}`, () => {
      assertRejects(block({ textAlign }), "content.attr_invalid");
    });
  }
  for (
    const fontSize of ["0", "1.25rem", "18px", "50%", "var(--esp-size-big)", "calc(2 * var(--esp-size-medium-to-big))"]
  ) {
    await testContext.test(`accepts fontSize ${fontSize}`, () => assertValid(block({ fontSize })));
  }
  const rejectedSizes = [
    "",
    "site-default",
    "-4px",
    "1rem; background: url(https://evil.example)",
    "expression(alert(1))",
    "calc(100vh - )",
    16,
  ];
  for (const fontSize of rejectedSizes) {
    await testContext.test(`rejects fontSize ${JSON.stringify(fontSize)}`, () => {
      assertRejects(block({ fontSize }), "content.attr_invalid");
    });
  }
  await testContext.test("rejects an empty code-block language", () => {
    assertRejects(
      doc({ type: "codeBlock", attrs: { language: "" }, content: [{ type: "text", text: "x" }] }),
      "content.attr_invalid",
    );
  });
});

test("requires the image delivery keys the server only rewrites in place", async (testContext) => {
  await testContext.test("missing src", () => {
    const result = assertRejects(
      doc({ type: "taprootImage", attrs: { imageId: IMAGE_ID, urls: [] } }),
      "content.image_keys",
    );
    assert.ok(pathsOf(result).includes("/content/0/attrs/src"));
  });
  await testContext.test("missing urls", () => {
    const result = assertRejects(
      doc({ type: "taprootImage", attrs: { imageId: IMAGE_ID, src: "" } }),
      "content.image_keys",
    );
    assert.ok(pathsOf(result).includes("/content/0/attrs/urls"));
  });
  await testContext.test("missing both", () => {
    const result = assertRejects(doc({ type: "taprootImage", attrs: { imageId: IMAGE_ID } }), "content.image_keys");
    assert.equal(codesOf(result).filter((code) => code === "content.image_keys").length, 2);
  });
  await testContext.test("empty values are correct", () => assertValid(doc(image())));
});

test("rejects the editor-transient image attributes", async (testContext) => {
  const cases = [
    ["uploading", true],
    ["localImage", "blob:https://app.taproot.test/9f"],
    ["tempId", "temp-1"],
    ["resolvedMaxHeightVh", 60],
  ];
  for (const [attr, value] of cases) {
    await testContext.test(attr, () => {
      const result = assertRejects(doc(image({ [attr]: value })), "content.image_transient");
      assert.ok(pathsOf(result).includes(`/content/0/attrs/${attr}`));
    });
  }
});

test("holds every taprootImage attribute to the extension's declared values", async (testContext) => {
  await testContext.test("rejects a missing imageId", () => {
    assertRejects(doc({ type: "taprootImage", attrs: { src: "", urls: [] } }), "content.attr_invalid");
  });

  const rejected = [
    ["imageId not a uuid", { imageId: "image-1" }],
    ["imageId uppercase", { imageId: IMAGE_ID.toUpperCase() }],
    ["src not a string", { src: null }],
    ["urls not an array", { urls: {} }],
    ["urls entry without url", { urls: [{ minWidth: 640 }] }],
    ["urls entry with an empty url", { urls: [{ minWidth: 640, url: "" }] }],
    ["urls entry without minWidth", { urls: [{ url: "https://cdn.example.test/a.webp" }] }],
    ["urls entry with a zero minWidth", { urls: [{ minWidth: 0, url: "https://cdn.example.test/a.webp" }] }],
    ["urls entry with an unknown key", {
      urls: [{ minWidth: 640, url: "https://cdn.example.test/a.webp", srcset: "x" }],
    }],
    ["width not an integer", { width: 12.5 }],
    ["height not positive", { height: 0 }],
    ["alt not a string", { alt: 12 }],
    ["crop missing a key", { crop: { x: 0, y: 0, width: 1 } }],
    ["crop out of range", { crop: { x: 0, y: 0, width: 2, height: 1 } }],
    ["maxHeightVh outside the option set", { maxHeightVh: 50 }],
    ["maxHeightVh as a string", { maxHeightVh: "60" }],
    ["maxHeight invalid", { maxHeight: "60vh; background: url(https://evil.example)" }],
    ["maxHeight empty", { maxHeight: "" }],
    ["borderWidth none", { borderWidth: "none" }],
    ["presentationPlacement uppercase", { presentationPlacement: "LEFT" }],
    ["presentationPlacement legacy alias", { presentationPlacement: "left-wrap" }],
    ["imageAlign right", { imageAlign: "right" }],
    ["imagePlacement unknown", { imagePlacement: "float" }],
    ["textAlign unknown", { textAlign: "middle" }],
  ];
  for (const [name, attrs] of rejected) {
    await testContext.test(`rejects ${name}`, () => assertRejects(doc(image(attrs)), "content.attr_invalid"));
  }
  const accepted = [
    ["maxHeight none", { maxHeight: "none" }],
    ["maxHeight calc", { maxHeight: "calc(100vh - 4rem)" }],
    ["borderWidth zero", { borderWidth: "0" }],
    ["borderWidth var", { borderWidth: "var(--my-border-width)" }],
    ["imageAlign start", { imageAlign: "start" }],
    ["imagePlacement inline", { imagePlacement: "inline" }],
    ["urls with a type", { urls: [{ minWidth: 640, url: "https://cdn.example.test/a.webp", type: "image/webp" }] }],
  ];
  for (const [name, attrs] of accepted) {
    await testContext.test(`accepts ${name}`, () => assertValid(doc(image(attrs))));
  }
});

test("enforces the editor's content model, not merely the renderer's tolerance", async (testContext) => {
  const cases = [
    [
      "a paragraph inside a paragraph",
      doc({ type: "paragraph", content: [paragraph("x")] }),
      "content.child_not_allowed",
    ],
    ["text at the document root", doc({ type: "text", text: "x" }), "content.child_not_allowed"],
    ["a list item outside a list", doc({ type: "listItem", content: [paragraph("x")] }), "content.child_not_allowed"],
    [
      "a paragraph directly inside a list",
      doc({ type: "bulletList", content: [paragraph("x")] }),
      "content.child_not_allowed",
    ],
    [
      "a list item that does not begin with a paragraph",
      doc({
        type: "bulletList",
        content: [{ type: "listItem", content: [{ type: "horizontalRule" }, paragraph("x")] }],
      }),
      "content.child_not_allowed",
    ],
    [
      "a nested node inside a code block",
      doc({ type: "codeBlock", content: [paragraph("x")] }),
      "content.child_not_allowed",
    ],
    ["an empty list", doc({ type: "bulletList" }, paragraph("keep")), "content.child_required"],
    [
      "an empty list with an empty array",
      doc({ type: "bulletList", content: [] }, paragraph("keep")),
      "content.child_required",
    ],
    [
      "an empty list item",
      doc({ type: "bulletList", content: [{ type: "listItem" }] }, paragraph("keep")),
      "content.child_required",
    ],
    ["an empty blockquote", doc({ type: "blockquote" }, paragraph("keep")), "content.child_required"],
    ["content that is not an array", doc({ type: "paragraph", content: "x" }), "content.node_invalid"],
    ["a node that is not an object", doc("x"), "content.node_invalid"],
    ["a node without a type", doc({ content: [] }), "content.node_invalid"],
  ];
  for (const [name, document, code] of cases) {
    await testContext.test(name, () => assertRejects(document, code));
  }
});

test("gates rawHtml on the caller opting in", () => {
  const document = doc({ type: "rawHtml", attrs: { html: "<section>Hand written</section>" } });
  const result = assertRejects(document, "content.raw_html_forbidden");
  assert.deepEqual(pathsOf(result), ["/content/0"]);
  assertValid(document, { allowRawHtml: true });
  // The opt-in does not relax the attribute rules.
  assertRejects(doc({ type: "rawHtml", attrs: {} }, paragraph("keep")), "content.attr_invalid", { allowRawHtml: true });
});

test("refuses the document shapes the server's IsPresent gate refuses", async (testContext) => {
  const shapes = [
    ["null", null, "content.doc_type"],
    ["a string", "<p>hi</p>", "content.doc_type"],
    ["an array", [], "content.doc_type"],
    ["the wrong root type", { type: "paragraph", content: [] }, "content.doc_type"],
    ["no content array", { type: "doc" }, "content.doc_content"],
    ["content that is not an array", { type: "doc", content: {} }, "content.doc_content"],
  ];
  for (const [name, document, code] of shapes) {
    await testContext.test(name, () => assertRejects(document, code));
  }
});

test("names an empty body locally instead of letting the server say 'Body is required'", async (testContext) => {
  const empty = [
    ["no blocks", doc()],
    ["an empty paragraph", doc({ type: "paragraph" })],
    ["whitespace-only text", doc(paragraph("   "))],
    ["a horizontal rule alone", doc({ type: "horizontalRule" })],
    ["an empty code block", doc({ type: "codeBlock" })],
    ["a hard break alone", doc({ type: "paragraph", content: [{ type: "hardBreak" }] })],
  ];
  for (const [name, document] of empty) {
    await testContext.test(name, () => {
      const result = assertRejects(document, "content.empty_document");
      assert.ok(pathsOf(result).includes(""));
    });
  }

  const present = [
    ["an image alone", doc(image())],
    [
      "a component block alone",
      doc({ type: "componentBlock", attrs: { componentType: "spacer", componentData: "{}" } }),
    ],
    ["text nested in a list", doc({ type: "bulletList", content: [{ type: "listItem", content: [paragraph("x")] }] })],
  ];
  for (const [name, document] of present) {
    await testContext.test(`accepts ${name}`, () => assertValid(document));
  }

  await testContext.test("raw HTML counts only when it has visible text", () => {
    assertValid(doc({ type: "rawHtml", attrs: { html: "<p>Hello</p>" } }), { allowRawHtml: true });
    assertRejects(doc({ type: "rawHtml", attrs: { html: "<br>" } }), "content.empty_document", { allowRawHtml: true });
    assertRejects(doc({ type: "rawHtml", attrs: { html: "<p>&nbsp;</p>" } }), "content.empty_document", {
      allowRawHtml: true,
    });
    assertValid(doc({ type: "rawHtml", attrs: { html: "<p>&amp;</p>" } }), { allowRawHtml: true });
  });
});

test("bounds traversal depth and the number of findings", async (testContext) => {
  await testContext.test("depth", () => {
    let node = paragraph("deep");
    for (let level = 0; level < 80; level += 1) node = { type: "blockquote", content: [node] };
    assertRejects(doc(node), "content.depth_limit");
  });

  await testContext.test("findings", () => {
    const result = validateDocument(doc(...Array.from({ length: 300 }, () => ({ type: "bogus" }))));
    assert.equal(result.errors.length, 201);
    assert.equal(result.errors.at(-1).code, "content.error_limit");
  });
});

test("returns a frozen result a caller cannot mutate", () => {
  const result = validateDocument(doc(paragraph("x")));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.errors));
  const rejected = validateDocument(doc({ type: "bogus" }));
  assert.ok(Object.isFrozen(rejected.errors[0]));
  assert.deepEqual(Object.keys(rejected.errors[0]), ["path", "code", "message"]);
});

test("reports rather than throws, whatever a caller hands it", () => {
  // The verbs call this on documents they did not build. A validator that can
  // throw turns a bad page body into an unhandled crash with no path in it.
  const throwing = {
    toString() {
      throw new Error("boom");
    },
  };
  assert.deepEqual(
    codesOf(validateDocument(doc({ type: "componentBlock", attrs: { componentType: throwing, componentData: "{}" } }))),
    ["content.component_unknown"],
  );
  assert.ok(codesOf(validateDocument(doc({ type: throwing }))).includes("content.node_invalid"));
});

test("bounds a hostile identifier before it reaches a message or a path", () => {
  const result = validateDocument(doc({ type: `x\u001b[31m/${"y".repeat(200)}` }));
  assert.equal(result.errors[0].code, "content.unknown_node");
  assert.ok(!result.errors[0].message.includes("\u001b"));
  assert.ok(result.errors[0].message.length < 200);
});
