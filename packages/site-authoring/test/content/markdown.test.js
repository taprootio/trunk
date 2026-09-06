import assert from "node:assert/strict";
import test from "node:test";
import representativeSectionDocument from "../fixtures/free-form-section-composition.fixture.json" with {
  type: "json",
};

import { assertConvertedDocument, markdownToProseMirror } from "../../src/content/markdown.js";
import { validateDocument } from "../../src/content/validate-document.js";

// The converter's contract is exactness in both directions: a construct in the
// subset produces one specific document, and a construct outside it produces a
// named error. Silent narrowing — a malformed table flattened into paragraphs,
// an <h5> clamped to an <h4> — is the failure this package exists to prevent.

const IMAGE_ID = "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607";

const resolveImage = async (reference) => ({
  imageId: IMAGE_ID,
  // Delivery hints the emitter deliberately discards: the server rewrites
  // src/urls from the image id at read time.
  src: "https://cdn.example.test/low.webp",
  urls: [{ minWidth: 640, url: "https://cdn.example.test/640.webp" }],
  width: 1600,
  height: 900,
  alt: `resolved ${reference}`,
});

const convert = (markdown, options = {}) => markdownToProseMirror(markdown, { resolveImage, ...options });
const text = (value, marks) => (marks ? { type: "text", text: value, marks } : { type: "text", text: value });
const paragraph = (...content) => ({ type: "paragraph", content });
const item = (...content) => ({ type: "listItem", content });
const tableCell = (type, ...content) => ({
  type,
  content: [{ type: "paragraph", ...(content.length > 0 ? { content } : {}) }],
});
const bold = [{ type: "bold" }];
const DECORATION_IMAGE = {
  imageId: IMAGE_ID,
  src: "/img/starburst-640.webp",
  urls: [{ minWidth: 640, url: "/img/starburst-640.webp", type: "image/webp" }],
  width: 1200,
  height: 1200,
  alt: "",
};
const BACKGROUND_IMAGE = {
  imageId: IMAGE_ID,
  src: "/img/class-640.webp",
  urls: [{ minWidth: 640, url: "/img/class-640.webp", type: "image/webp" }],
  width: 1920,
  height: 1080,
  alt: "A hot yoga class",
};
const PORTRAIT_BACKGROUND_IMAGE = {
  ...BACKGROUND_IMAGE,
  imageId: "9a8b7c6d-5e4f-4321-a098-76543210fedc",
  src: "/img/class-640.webp",
};
const INLINE_FACT_ITEMS = [
  { value: "4.9 ★", label: "Community rating" },
  { value: "(555) 013-7788", label: "Call the studio", url: "tel:+15550137788" },
];

const GOLDENS = [
  {
    name: "a paragraph",
    markdown: "Just a line of prose.",
    doc: { type: "doc", content: [paragraph(text("Just a line of prose."))] },
  },
  {
    name: "a soft break, which the editor stores as a space",
    markdown: "one\ntwo",
    doc: { type: "doc", content: [paragraph(text("one two"))] },
  },
  {
    name: "a hard break from two trailing spaces",
    markdown: "one  \ntwo",
    doc: { type: "doc", content: [paragraph(text("one"), { type: "hardBreak" }, text("two"))] },
  },
  {
    name: "a hard break from a trailing backslash",
    markdown: "one\\\ntwo",
    doc: { type: "doc", content: [paragraph(text("one"), { type: "hardBreak" }, text("two"))] },
  },
  {
    name: "headings one through four",
    markdown: "# One\n\n## Two\n\n### Three\n\n#### Four",
    doc: {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [text("One")] },
        { type: "heading", attrs: { level: 2 }, content: [text("Two")] },
        { type: "heading", attrs: { level: 3 }, content: [text("Three")] },
        { type: "heading", attrs: { level: 4 }, content: [text("Four")] },
      ],
    },
  },
  {
    name: "a heading with a closing hash sequence",
    markdown: "## Two ##",
    doc: { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [text("Two")] }] },
  },
  {
    name: "every inline mark",
    markdown: "**b** *i* _i2_ ~~s~~ `c`",
    doc: {
      type: "doc",
      content: [paragraph(
        text("b", [{ type: "bold" }]),
        text(" "),
        text("i", [{ type: "italic" }]),
        text(" "),
        text("i2", [{ type: "italic" }]),
        text(" "),
        text("s", [{ type: "strike" }]),
        text(" "),
        text("c", [{ type: "code" }]),
      )],
    },
  },
  {
    name: "combined marks, ordered canonically rather than by nesting",
    markdown: "***both*** and **bold with `code`**",
    doc: {
      type: "doc",
      content: [paragraph(
        text("both", [{ type: "bold" }, { type: "italic" }]),
        text(" and "),
        text("bold with ", bold),
        text("code", [{ type: "bold" }, { type: "code" }]),
      )],
    },
  },
  {
    name: "underscore triple emphasis",
    markdown: "___also___",
    doc: { type: "doc", content: [paragraph(text("also", [{ type: "bold" }, { type: "italic" }]))] },
  },
  {
    name: "a mark that opens on one line and closes on the next",
    markdown: "**bold\nspanning**",
    doc: { type: "doc", content: [paragraph(text("bold spanning", bold))] },
  },
  {
    name: "a link",
    markdown: "[docs](https://example.test/a?b=1#c)",
    doc: {
      type: "doc",
      content: [paragraph(text("docs", [{ type: "link", attrs: { href: "https://example.test/a?b=1#c" } }]))],
    },
  },
  {
    name: "root-relative and fragment links",
    markdown: "[home](/) and [frag](#x)",
    doc: {
      type: "doc",
      content: [paragraph(
        text("home", [{ type: "link", attrs: { href: "/" } }]),
        text(" and "),
        text("frag", [{ type: "link", attrs: { href: "#x" } }]),
      )],
    },
  },
  {
    name: "telephone and email links",
    markdown: "[Call](tel:+12535550123) or [email](mailto:studio@example.test)",
    doc: {
      type: "doc",
      content: [paragraph(
        text("Call", [{ type: "link", attrs: { href: "tel:+12535550123" } }]),
        text(" or "),
        text("email", [{ type: "link", attrs: { href: "mailto:studio@example.test" } }]),
      )],
    },
  },
  {
    name: "a link carrying another mark",
    markdown: "[**bold link**](/a)",
    doc: {
      type: "doc",
      content: [paragraph(text("bold link", [{ type: "bold" }, { type: "link", attrs: { href: "/a" } }]))],
    },
  },
  {
    name: "a dash bullet list",
    markdown: "- one\n- two",
    doc: {
      type: "doc",
      content: [{ type: "bulletList", content: [item(paragraph(text("one"))), item(paragraph(text("two")))] }],
    },
  },
  {
    name: "a star bullet list",
    markdown: "* one\n* two",
    doc: {
      type: "doc",
      content: [{ type: "bulletList", content: [item(paragraph(text("one"))), item(paragraph(text("two")))] }],
    },
  },
  {
    name: "an ordered list",
    markdown: "1. one\n2. two",
    doc: {
      type: "doc",
      content: [{ type: "orderedList", content: [item(paragraph(text("one"))), item(paragraph(text("two")))] }],
    },
  },
  {
    name: "a nested list, by indentation",
    markdown: "- one\n  - deep\n- two",
    doc: {
      type: "doc",
      content: [{
        type: "bulletList",
        content: [
          item(paragraph(text("one")), { type: "bulletList", content: [item(paragraph(text("deep")))] }),
          item(paragraph(text("two"))),
        ],
      }],
    },
  },
  {
    name: "a list item with a second paragraph",
    markdown: "- one\n\n  second para",
    doc: {
      type: "doc",
      content: [{ type: "bulletList", content: [item(paragraph(text("one")), paragraph(text("second para")))] }],
    },
  },
  {
    name: "an empty list item, which still needs its paragraph",
    markdown: "- \n- two",
    doc: {
      type: "doc",
      content: [{ type: "bulletList", content: [item({ type: "paragraph" }), item(paragraph(text("two")))] }],
    },
  },
  {
    name: "a blockquote",
    markdown: "> quoted\n> more",
    doc: { type: "doc", content: [{ type: "blockquote", content: [paragraph(text("quoted more"))] }] },
  },
  {
    name: "a list inside a blockquote",
    markdown: "> - a\n> - b",
    doc: {
      type: "doc",
      content: [{
        type: "blockquote",
        content: [{ type: "bulletList", content: [item(paragraph(text("a"))), item(paragraph(text("b")))] }],
      }],
    },
  },
  {
    name: "a lazily continued blockquote",
    markdown: "> quoted\nlazy",
    doc: { type: "doc", content: [{ type: "blockquote", content: [paragraph(text("quoted lazy"))] }] },
  },
  {
    name: "a fenced code block with no language",
    markdown: "```\nplain\n```",
    doc: { type: "doc", content: [{ type: "codeBlock", content: [text("plain")] }] },
  },
  {
    name: "a fenced code block with a language",
    markdown: "```ts\nconst a: number = 1;\n```",
    doc: {
      type: "doc",
      content: [{ type: "codeBlock", attrs: { language: "ts" }, content: [text("const a: number = 1;")] }],
    },
  },
  {
    name: "an empty fenced code block",
    markdown: "```\n```\n\ntext",
    doc: { type: "doc", content: [{ type: "codeBlock" }, paragraph(text("text"))] },
  },
  {
    name: "a thematic break",
    markdown: "a\n\n---\n\nb",
    doc: { type: "doc", content: [paragraph(text("a")), { type: "horizontalRule" }, paragraph(text("b"))] },
  },
  {
    name: "a captioned rate table with outer pipes, marks, a safe link, and an escaped pipe",
    markdown: "Table: Drop-in rates\n"
      + "| Plan | Rate | Details |\n"
      + "| --- | --- | --- |\n"
      + "| Single class | **$24** | [Book now](/classes) |\n"
      + "| Five-pack | $100 | Save $20 \\| valid for 90 days |",
    doc: {
      type: "doc",
      content: [{
        type: "table",
        attrs: { caption: "Drop-in rates" },
        content: [
          {
            type: "tableRow",
            content: [
              tableCell("tableHeader", text("Plan")),
              tableCell("tableHeader", text("Rate")),
              tableCell("tableHeader", text("Details")),
            ],
          },
          {
            type: "tableRow",
            content: [
              tableCell("tableCell", text("Single class")),
              tableCell("tableCell", text("$24", bold)),
              tableCell("tableCell", text("Book now", [{ type: "link", attrs: { href: "/classes" } }])),
            ],
          },
          {
            type: "tableRow",
            content: [
              tableCell("tableCell", text("Five-pack")),
              tableCell("tableCell", text("$100")),
              tableCell("tableCell", text("Save $20 | valid for 90 days")),
            ],
          },
        ],
      }],
    },
  },
  {
    name: "a comparison table without outer pipes and with an empty data cell",
    markdown: "Feature | Starter | Studio\n"
      + "--- | --- | ---\n"
      + "Classes | 4 / month | **Unlimited**\n"
      + "Phone support | | Included",
    doc: {
      type: "doc",
      content: [{
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              tableCell("tableHeader", text("Feature")),
              tableCell("tableHeader", text("Starter")),
              tableCell("tableHeader", text("Studio")),
            ],
          },
          {
            type: "tableRow",
            content: [
              tableCell("tableCell", text("Classes")),
              tableCell("tableCell", text("4 / month")),
              tableCell("tableCell", text("Unlimited", bold)),
            ],
          },
          {
            type: "tableRow",
            content: [
              tableCell("tableCell", text("Phone support")),
              tableCell("tableCell"),
              tableCell("tableCell", text("Included")),
            ],
          },
        ],
      }],
    },
  },
  {
    name: "escaped pipes inside table code spans and link destinations",
    markdown: "Kind | Detail\n"
      + "--- | ---\n"
      + "Code | `a\\|b`\n"
      + "Link | [open](/a\\|b)",
    doc: {
      type: "doc",
      content: [{
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              tableCell("tableHeader", text("Kind")),
              tableCell("tableHeader", text("Detail")),
            ],
          },
          {
            type: "tableRow",
            content: [
              tableCell("tableCell", text("Code")),
              tableCell("tableCell", text("a|b", [{ type: "code" }])),
            ],
          },
          {
            type: "tableRow",
            content: [
              tableCell("tableCell", text("Link")),
              tableCell("tableCell", text("open", [{ type: "link", attrs: { href: "/a|b" } }])),
            ],
          },
        ],
      }],
    },
  },
  {
    name: "a table directly inside a section",
    markdown: ":::section {}\n"
      + "Plan | Rate\n"
      + "--- | ---\n"
      + "Single | $24\n"
      + ":::",
    doc: {
      type: "doc",
      content: [{
        type: "section",
        attrs: { contentPadding: "standard", surface: "none" },
        content: [{
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [tableCell("tableHeader", text("Plan")), tableCell("tableHeader", text("Rate"))],
            },
            {
              type: "tableRow",
              content: [tableCell("tableCell", text("Single")), tableCell("tableCell", text("$24"))],
            },
          ],
        }],
      }],
    },
  },
  {
    name: "an image, whose delivery keys are present and empty",
    markdown: "![A caption](hero.png)",
    doc: {
      type: "doc",
      content: [{
        type: "taprootImage",
        attrs: { imageId: IMAGE_ID, src: "", urls: [], alt: "A caption", width: 1600, height: 900 },
      }],
    },
  },
  {
    name: "an image with no alt text, which falls back to the resolver's",
    markdown: "![](hero.png)",
    doc: {
      type: "doc",
      content: [{
        type: "taprootImage",
        attrs: { imageId: IMAGE_ID, src: "", urls: [], alt: "resolved hero.png", width: 1600, height: 900 },
      }],
    },
  },
  {
    name: "a component fence, re-serialised in the interface's field order",
    markdown: "```component:latest-posts\n{\"count\": 3, \"showDate\": false, \"columns\": 2}\n```",
    doc: {
      type: "doc",
      content: [{
        type: "componentBlock",
        attrs: { componentType: "latest-posts", componentData: "{\"count\":3,\"columns\":2,\"showDate\":false}" },
      }],
    },
  },
  {
    name: "a component fence carrying an image",
    markdown: "```component:image-banner\n"
      + `{"overlayText":"Hi","image":{"imageId":"${IMAGE_ID}","src":"","urls":[],"width":10,"height":5,"alt":"x"}}\n`
      + "```",
    doc: {
      type: "doc",
      content: [{
        type: "componentBlock",
        attrs: {
          componentType: "image-banner",
          componentData: `{"image":{"imageId":"${IMAGE_ID}","src":"","urls":[],"width":10,"height":5,"alt":"x"},`
            + "\"overlayText\":\"Hi\"}",
        },
      }],
    },
  },
  {
    name: "root flow and explicit sections preserve their structured children",
    markdown: "Root prose.\n\n"
      + ":::section {\"surface\":\"raised\"}\n"
      + "```component:hero-section\n"
      + "{\"overline\":\"Riverbend Hot Yoga · Elm Harbor\",\"title\":\"Come as you are. Leave feeling stronger.\",\"titleSize\":\"display\",\"lead\":\"Hot yoga, barre, and wellness practices for every body.\",\"primaryAction\":{\"label\":\"View class schedule\",\"url\":\"/classes\"},\"secondaryAction\":{\"label\":\"Call the studio\",\"url\":\"tel:+12535550123\"},\"alignment\":\"start\",\"media\":{\"imageId\":\"77777777-8888-4999-8aaa-bbbbbbbbbbbb\",\"src\":\"/hero-media.webp\",\"urls\":[{\"minWidth\":640,\"url\":\"/hero-media.webp\"}],\"width\":1200,\"height\":800,\"alt\":\"A welcoming hot yoga class\"},\"mediaArrangement\":\"split\",\"mediaPosition\":\"after\",\"mediaWidth\":\"wide\"}\n"
      + "```\n\n"
      + "A neutral section.\n"
      + ":::\n\n"
      + ":::section {\"context\":\"inverted\",\"surface\":\"elevated\"}\n"
      + "## Inverted band\n\n"
      + "A paragraph inside the band.\n\n"
      + "```inline-facts\n"
      + "[{\"value\":\"4.8 ★ from 109 Google reviews\",\"label\":\"Rating\"},{\"value\":\"112 Main St\",\"label\":\"Address\",\"url\":\"/visit\"},{\"value\":\"(555) 123-4567\",\"label\":\"Phone\",\"url\":\"tel:+15551234567\"},{\"value\":\"6am–8pm\",\"label\":\"Today\"},{\"value\":\"Free parking\"}]\n"
      + "```\n\n"
      + "```inline-facts\n"
      + "[{\"value\":\"(555) 555-0148\",\"url\":\"tel:+15555550148\"},{\"value\":\"Walk-ins welcome\"}]\n"
      + "```\n\n"
      + "```component:feature-grid\n"
      + "{\"items\":[{\"icon\":null,\"title\":\"Start where you are\",\"description\":\"A grounded first step for every body.\",\"url\":\"/classes\"},{\"icon\":null,\"title\":\"Build steady strength\",\"description\":\"A repeatable practice with room to progress.\",\"url\":\"/classes\"}],\"columns\":2,\"iconSize\":\"medium\",\"borderWidth\":1}\n"
      + "```\n\n"
      + "```component:card-grid\n"
      + "{\"cards\":[{\"image\":null,\"title\":\"Wide card\",\"description\":\"Uses the full site well.\",\"linkUrl\":\"\"}],\"columns\":2,\"borderWidth\":0}\n"
      + "```\n\n"
      + "```component:testimonial\n"
      + "{\"items\":[{\"quote\":\"The 6am class is the reason I finally kept a morning routine.\",\"authorName\":\"Priya Raman\",\"authorTitle\":\"Member since 2023\",\"authorImage\":null},{\"quote\":\"I came in nervous and left already planning my next visit.\",\"authorName\":\"Dana Whitfield\",\"authorTitle\":\"First-time student\",\"authorImage\":null}],\"columns\":2,\"borderWidth\":1}\n"
      + "```\n\n"
      + "```component:testimonial\n"
      + "{\"items\":[{\"quote\":\"Two months in, I can hold poses I could not attempt in January.\",\"authorName\":\"Marcus Ellery\",\"authorTitle\":\"Barre regular\",\"authorImage\":null}],\"carousel\":true,\"borderWidth\":1}\n"
      + "```\n"
      + ":::",
    doc: representativeSectionDocument,
  },
  {
    name: "section decoration JSON round-trips as the complete normalized object",
    markdown: `:::section ${
      JSON.stringify({
        decoration: {
          image: DECORATION_IMAGE,
          anchor: "top-end",
          inlineOffsetPercent: 18,
          blockOffsetPercent: -12,
        },
      })
    }\n## Decorated band\n:::`,
    doc: {
      type: "doc",
      content: [{
        type: "section",
        attrs: {
          contentPadding: "standard",
          surface: "none",
          decoration: {
            image: DECORATION_IMAGE,
            anchor: "top-end",
            inlineOffsetPercent: 18,
            blockOffsetPercent: -12,
            inlineSizePercent: 40,
            opacity: 0.12,
            tint: "heading",
          },
        },
        content: [{ type: "heading", attrs: { level: 2 }, content: [text("Decorated band")] }],
      }],
    },
  },
  {
    name: "section background JSON round-trips both processed images and normalized focal defaults",
    markdown: `:::section ${
      JSON.stringify({
        background: {
          portraitFocus: { y: 0.3 },
          portraitImage: PORTRAIT_BACKGROUND_IMAGE,
          image: BACKGROUND_IMAGE,
          focus: { x: 0.6 },
        },
      })
    }\n## Photo band\n:::`,
    doc: {
      type: "doc",
      content: [{
        type: "section",
        attrs: {
          contentPadding: "standard",
          surface: "none",
          background: {
            image: BACKGROUND_IMAGE,
            portraitImage: PORTRAIT_BACKGROUND_IMAGE,
            focus: { x: 0.6, y: 0.5 },
            portraitFocus: { x: 0.5, y: 0.3 },
            scrimStrength: "medium",
          },
        },
        content: [{ type: "heading", attrs: { level: 2 }, content: [text("Photo band")] }],
      }],
    },
  },
  {
    name: "an inline-facts JSON-array fence at the root",
    markdown: `\`\`\`inline-facts\n${JSON.stringify([
      { label: "Community rating", value: "4.9 ★" },
      { url: "tel:+15550137788", label: "Call the studio", value: "(555) 013-7788" },
    ])}\n\`\`\``,
    doc: {
      type: "doc",
      content: [{ type: "inlineFacts", attrs: { items: INLINE_FACT_ITEMS } }],
    },
  },
  {
    // The SHY row from the standalone-fact decision: the label is dropped and
    // a null label canonicalizes the same way, so a self-describing fact keeps
    // its own copy instead of inventing a second line.
    name: "an inline-facts fence whose facts name themselves",
    markdown: `\`\`\`inline-facts\n${JSON.stringify([
      { value: "4.8 ★ from 111 Google reviews" },
      { value: "(555) 555-0123", url: "tel:+15555550123", label: null },
    ])}\n\`\`\``,
    doc: {
      type: "doc",
      content: [{
        type: "inlineFacts",
        attrs: {
          items: [
            { value: "4.8 ★ from 111 Google reviews" },
            { value: "(555) 555-0123", url: "tel:+15555550123" },
          ],
        },
      }],
    },
  },
  {
    name: "an inline-facts fence directly inside a section",
    markdown: `:::section {}\n\`\`\`inline-facts\n${JSON.stringify(INLINE_FACT_ITEMS)}\n\`\`\`\n:::`,
    doc: {
      type: "doc",
      content: [{
        type: "section",
        attrs: { contentPadding: "standard", surface: "none" },
        content: [{ type: "inlineFacts", attrs: { items: INLINE_FACT_ITEMS } }],
      }],
    },
  },
  {
    name: "backslash escapes",
    markdown: "\\*literal\\* and \\[brackets\\]",
    doc: { type: "doc", content: [paragraph(text("*literal* and [brackets]"))] },
  },
  {
    name: "intraword underscores, which never become emphasis",
    markdown: "snake_case_name stays literal",
    doc: { type: "doc", content: [paragraph(text("snake_case_name stays literal"))] },
  },
  {
    name: "a code span containing a backtick",
    markdown: "`` ` ``",
    doc: { type: "doc", content: [paragraph(text("`", [{ type: "code" }]))] },
  },
  {
    name: "a bracketed word with no destination, which stays literal",
    markdown: "a [TODO] item",
    doc: { type: "doc", content: [paragraph(text("a [TODO] item"))] },
  },
  {
    name: "a whole page",
    markdown: "# Title\n\nIntro **para**.\n\n- a\n- b\n\n> quote\n\n```js\nx\n```\n\n![alt](ref.png)",
    doc: {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [text("Title")] },
        paragraph(text("Intro "), text("para", bold), text(".")),
        { type: "bulletList", content: [item(paragraph(text("a"))), item(paragraph(text("b")))] },
        { type: "blockquote", content: [paragraph(text("quote"))] },
        { type: "codeBlock", attrs: { language: "js" }, content: [text("x")] },
        {
          type: "taprootImage",
          attrs: { imageId: IMAGE_ID, src: "", urls: [], alt: "alt", width: 1600, height: 900 },
        },
      ],
    },
  },
];

test("converts every construct in the subset to exactly one document", async (testContext) => {
  for (const golden of GOLDENS) {
    await testContext.test(golden.name, async () => {
      const { doc } = await convert(golden.markdown);
      assert.deepEqual(doc, golden.doc);
      // The round-trip property: nothing this converter emits may fail the
      // validator, or the CLI would push a body it refuses to accept back.
      assert.deepEqual(validateDocument(doc).errors, []);
    });
  }
});

test("caption recognition and table limits stay bounded and actionable", async (testContext) => {
  await testContext.test("Table: remains ordinary prose unless a header and delimiter immediately follow", async () => {
    const { doc } = await convert("Table: This is ordinary prose.\nIt has a continuation.");
    assert.deepEqual(doc, {
      type: "doc",
      content: [paragraph(text("Table: This is ordinary prose. It has a continuation."))],
    });
  });

  await testContext.test("the caption form is exact once the following lines prove a table", async () => {
    await assert.rejects(
      convert("Table:Caption\nA | B\n--- | ---\n1 | 2"),
      (error) => error.code === "content.markdown_table" && error.field === "table caption",
    );
  });

  await testContext.test("caption and cell limits count Unicode scalars and rendered text, not Markdown syntax", async () => {
    const caption = "😀".repeat(160);
    const cell = "😀".repeat(1000);
    const accepted = await convert(`Table: ${caption}\nA | B\n--- | ---\n**${cell}** | ok`);
    assert.equal(accepted.doc.content[0].attrs.caption, caption);
    assert.equal(accepted.doc.content[0].content[1].content[0].content[0].content[0].text, cell);

    await assert.rejects(
      convert(`Table: ${caption}x\nA | B\n--- | ---\n1 | 2`),
      (error) => error.code === "content.table_bounds" && error.field === "table caption",
    );
    await assert.rejects(
      convert(`A | B\n--- | ---\n**${cell}x** | ok`),
      (error) => error.code === "content.table_bounds" && error.field === "table cell",
    );
  });

  await testContext.test("100 data rows are accepted and the 101st is refused", async () => {
    const rows = Array.from({ length: 100 }, (_, index) => `${index} | value`).join("\n");
    const accepted = await convert(`Number | Value\n--- | ---\n${rows}`);
    assert.equal(accepted.doc.content[0].content.length, 101);

    await assert.rejects(
      convert(`Number | Value\n--- | ---\n${rows}\nextra | value`),
      (error) => error.code === "content.table_bounds" && error.field === "table rows",
    );

    await assert.rejects(
      convert(`Number | Value\n--- | ---\n${rows}\nThis paragraph needs a blank line.`),
      (error) => error.code === "content.markdown_table" && error.field === "table row",
    );
  });

  await testContext.test("block constructs cannot be stolen as table headers", async () => {
    for (
      const markdown of [
        "# Name | Value\n--- | ---\n1 | 2",
        "Table: Comparison\n# Name | Value\n--- | ---\n1 | 2",
        "```text | Notes\n--- | ---\n1 | 2",
        ":::section {} | Notes\n--- | ---\n1 | 2",
        "[docs]: /a|b\n--- | ---\n1 | 2",
        "[^note]: text|more\n--- | ---\n1 | 2",
      ]
    ) {
      await assert.rejects(
        convert(markdown),
        (error) => error.code.startsWith("content.markdown_"),
      );
    }
  });

  await testContext.test("block constructs cannot be stolen as table delimiters", async () => {
    for (
      const [markdown, code, field] of [
        ["Name | Value\n[docs]: /a|---\n1 | 2", "content.markdown_reference_link", "reference link definition"],
        ["Name | Value\n[^note]: text|---\n1 | 2", "content.markdown_footnote", "footnote"],
      ]
    ) {
      await assert.rejects(
        convert(markdown),
        (error) => error.code === code && error.field === field,
      );
    }
  });

  await testContext.test("block constructs cannot be swallowed as table data rows", async () => {
    for (
      const [line, code, field] of [
        ["# Heading | Value", "content.markdown_table", "table row"],
        ["- item | value", "content.markdown_table", "table row"],
        ["[docs]: /url | value", "content.markdown_reference_link", "reference link definition"],
        ["[^note]: text | value", "content.markdown_footnote", "footnote"],
      ]
    ) {
      await assert.rejects(
        convert(`Name | Value\n--- | ---\n1 | 2\n${line}`),
        (error) => error.code === code && error.field === field,
      );
    }
  });

  await testContext.test("12 columns are accepted and a 13th is refused", async () => {
    const row = Array.from({ length: 12 }, (_, index) => `C${index + 1}`).join(" | ");
    const delimiter = Array.from({ length: 12 }, () => "---").join(" | ");
    const data = Array.from({ length: 12 }, () => "x").join(" | ");
    const accepted = await convert(`${row}\n${delimiter}\n${data}`);
    assert.equal(accepted.doc.content[0].content[0].content.length, 12);

    await assert.rejects(
      convert(`${row} | C13\n${delimiter} | ---\n${data} | x`),
      (error) => error.code === "content.table_bounds" && error.field === "table columns",
    );
  });
});

test("refuses every construct outside the subset by name", async (testContext) => {
  const cases = [
    [
      "table alignment colons",
      "| a | b |\n| :--- | ---: |\n| 1 | 2 |",
      "content.markdown_table_alignment",
      "table alignment",
    ],
    [
      "a malformed delimiter",
      "| a | b |\n| --- | words |\n| 1 | 2 |",
      "content.markdown_table",
      "table delimiter",
    ],
    [
      "a malformed delimiter whose arbitrary text contains a colon",
      "| a | b |\n| --- | not:alignment |\n| 1 | 2 |",
      "content.markdown_table",
      "table delimiter",
    ],
    [
      "a ragged delimiter",
      "| a | b | c |\n| --- | --- |\n| 1 | 2 | 3 |",
      "content.table_ragged",
      "table delimiter",
    ],
    [
      "a ragged data row",
      "| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |",
      "content.table_ragged",
      "table row",
    ],
    [
      "an empty header cell",
      "| a | |\n| --- | --- |\n| 1 | 2 |",
      "content.table_header",
      "table header",
    ],
    [
      "a table without a data row",
      "| a | b |\n| --- | --- |",
      "content.table_bounds",
      "table rows",
    ],
    [
      "a one-column table",
      "| only |\n| --- |\n| value |",
      "content.table_bounds",
      "table columns",
    ],
    [
      "a table not terminated by a blank line",
      "| a | b |\n| --- | --- |\n| 1 | 2 |\nNext paragraph",
      "content.markdown_table",
      "table row",
    ],
    [
      "a table nested in a blockquote",
      "> | a | b |\n> | --- | --- |\n> | 1 | 2 |",
      "content.table_shape",
      "table",
    ],
    [
      "raw HTML in a table cell",
      "| a | b |\n| --- | --- |\n| <b>1</b> | 2 |",
      "content.markdown_html",
      "inline HTML",
    ],
    ["a footnote reference", "Text with a note[^1].", "content.markdown_footnote", "footnote"],
    ["a footnote definition", "[^1]: the note", "content.markdown_footnote", "footnote"],
    ["an HTML block", "<div>hi</div>", "content.markdown_html", "inline HTML"],
    ["inline HTML", "Some <b>bold</b> text", "content.markdown_html", "inline HTML"],
    ["a setext h1", "Title\n=====", "content.markdown_setext", "setext heading"],
    ["a setext h2", "Title\n-----", "content.markdown_setext", "setext heading"],
    ["a reference link", "See [the docs][docs].", "content.markdown_reference_link", "reference link"],
    [
      "a reference definition",
      "[docs]: https://x.test",
      "content.markdown_reference_link",
      "reference link definition",
    ],
    ["an autolink", "Visit <https://x.test>.", "content.markdown_autolink", "autolink"],
    ["an HTML entity", "AT&amp;T", "content.markdown_entity", "HTML entity"],
    ["a fifth-level heading", "##### too deep", "content.heading_depth", "heading"],
    ["front matter", "---\ntitle: x\n---\n\nBody", "content.markdown_front_matter", "front matter"],
    ["an indented code block", "para\n\n    code here", "content.markdown_indented_code", "indented code block"],
    ["a plus bullet", "+ item", "content.markdown_list_marker", "list marker"],
    ["a parenthesised ordered marker", "1) item", "content.markdown_list_marker", "list marker"],
    ["an ordered list that does not start at one", "3. item", "content.markdown_list_start", "ordered list start"],
    ["an inline image", "text ![a](b) more", "content.markdown_image", "inline image"],
    ["an unsafe link destination", "[x](javascript:alert(1))", "content.markdown_link", "link"],
    ["a link title", "[x](https://a.test \"t\")", "content.markdown_link", "link"],
    ["a pointy-bracket destination", "[x](<https://a.test>)", "content.markdown_link", "link"],
    ["nested links", "[a [b](https://x.test) c](https://y.test)", "content.markdown_link", "link"],
    ["an unclosed fence", "```js\ncode", "content.markdown_unclosed_fence", "fenced block"],
    [
      "a malformed section header",
      ":::section {\"surface\":}\ntext\n:::",
      "content.markdown_section_header",
      "section header",
    ],
    [
      "a section header without its JSON object",
      ":::section\ntext\n:::",
      "content.markdown_section_header",
      "section header",
    ],
    [
      "an indented section header",
      " :::section {}\ntext\n:::",
      "content.markdown_section_header",
      "section header",
    ],
    [
      "an unclosed section container",
      ":::section {}\ntext",
      "content.markdown_section_unclosed",
      "section container",
    ],
    [
      "a directly nested section container",
      ":::section {}\n:::section {}\ntext\n:::\n:::",
      "content.markdown_section_nested",
      "section container",
    ],
    [
      "a section container nested in a blockquote",
      "> :::section {}\n> text\n> :::",
      "content.markdown_section_nested",
      "section container",
    ],
    [
      "a section container nested in a list",
      "- :::section {}\n  text\n  :::",
      "content.markdown_section_nested",
      "section container",
    ],
    [
      "an unknown section attribute",
      ":::section {\"scheme\":\"dark\"}\ntext\n:::",
      "content.attr_unknown",
      "section header",
    ],
    [
      "an invalid section surface",
      ":::section {\"surface\":\"floating\"}\ntext\n:::",
      "content.attr_invalid",
      "section header",
    ],
    [
      "an unsafe decoration delivery URL",
      `:::section ${
        JSON.stringify({ decoration: { image: { ...DECORATION_IMAGE, src: "javascript:alert(1)" } } })
      }\ntext\n:::`,
      "content.attr_invalid",
      "/attrs/decoration/image/src",
    ],
    [
      "a fence info string with attributes",
      "```js title=x\ncode\n```",
      "content.markdown_code_language",
      "code fence info string",
    ],
    ["an unknown component type", "```component:nope\n{}\n```", "content.component_unknown", "component block"],
    [
      "invalid component data",
      "```component:spacer\n{\"height\":\"huge\"}\n```",
      "content.component_data",
      "component block",
    ],
    [
      "invalid inline-facts JSON",
      "```inline-facts\n{\"value\":\"no array\"}\n```",
      "content.attr_invalid",
      "/attrs/items",
    ],
    [
      "unsafe inline-facts action",
      "```inline-facts\n[{\"value\":\"Call\",\"label\":\"Studio\",\"url\":\"javascript:bad\"}]\n```",
      "content.attr_invalid",
      "/attrs/items/0/url",
    ],
    [
      "inline facts nested in a list",
      "- ```inline-facts\n  [{\"value\":\"v\",\"label\":\"l\"}]\n  ```",
      "content.markdown_inline_facts",
      "inline facts",
    ],
    ["a document with nothing in it", "\n\n", "content.markdown_empty", "document"],
    ["a document that is only a thematic break", "---", "content.markdown_empty", "document"],
    ["a control character", "a\u0001b", "content.markdown_control", "control character"],
  ];

  for (const [name, markdown, code, field] of cases) {
    await testContext.test(name, async () => {
      await assert.rejects(convert(markdown), (error) => {
        assert.equal(error.name, "SiteAuthoringError");
        assert.equal(error.code, code);
        assert.equal(error.field, field);
        return true;
      });
    });
  }
});

test("section scanning does not treat a code fence's ::: line as a container marker", async () => {
  const { doc } = await convert(":::section {}\n```text\n:::\n```\n:::");
  assert.deepEqual(doc, {
    type: "doc",
    content: [{
      type: "section",
      attrs: { contentPadding: "standard", surface: "none" },
      content: [{ type: "codeBlock", attrs: { language: "text" }, content: [text(":::")] }],
    }],
  });
});

test("section syntax requires a complete keyword at the root and inside a section", async () => {
  for (
    const prose of [":::sectional is ordinary prose", ":::section! is ordinary prose", ":::sectioné is ordinary prose"]
  ) {
    const root = await convert(prose);
    assert.deepEqual(root.doc, {
      type: "doc",
      content: [paragraph(text(prose))],
    });

    const nested = await convert(`:::section {}\n${prose}\n:::`);
    assert.deepEqual(nested.doc, {
      type: "doc",
      content: [{
        type: "section",
        attrs: { contentPadding: "standard", surface: "none" },
        content: [paragraph(text(prose))],
      }],
    });
  }
});

test("names the line an out-of-subset construct appeared on", async () => {
  await assert.rejects(
    convert("# Fine\n\nAlso fine.\n\n| a | b |\n| --- | --- |"),
    (error) => error.code === "content.table_bounds" && error.message.includes("(line 6)"),
  );
});

test("refuses input the converter will not read", async (testContext) => {
  await testContext.test("a missing resolver", async () => {
    await assert.rejects(
      markdownToProseMirror("# Title", {}),
      (error) => error.code === "content.markdown_resolve_image",
    );
  });
  await testContext.test("a non-string source", async () => {
    for (const markdown of [undefined, null, 12, { text: "x" }, ["x"]]) {
      await assert.rejects(convert(markdown), (error) => error.code === "content.markdown_input");
    }
  });
  await testContext.test("an oversized source", async () => {
    await assert.rejects(convert("x".repeat(1024 * 1024 + 1)), (error) => error.code === "content.markdown_input");
  });
  await testContext.test("nesting past the bound", async () => {
    await assert.rejects(convert(`${"> ".repeat(24)}deep`), (error) => error.code === "content.markdown_nesting");
  });

  await testContext.test("inline scanning past the bound", async () => {
    // Finding a closing delimiter is a linear scan and an unclosed one scans
    // to the end of its block, so a block of openers that never close is
    // quadratic: before the budget, 96 KB of this took 7.8 seconds of
    // uninterruptible CPU and the 1 MB input ceiling allowed minutes of it.
    // The assertion is on the refusal, not on timing — the point is that the
    // scanner stops rather than that it stops in some number of milliseconds.
    for (const pathological of [" _a".repeat(32_000), " [a".repeat(32_000), "[a](".repeat(24_000)]) {
      await assert.rejects(convert(pathological), (error) => {
        assert.equal(error.code, "content.markdown_input");
        assert.equal(error.field, "inline scanning");
        return true;
      });
    }
  });

  await testContext.test("a large well-formed document stays far inside the bound", async () => {
    // The other half of the contract: the budget exists to stop a pathology,
    // not to cap real writing. Every delimiter here closes within a few
    // characters, which is what ordinary prose does — 500 paragraphs of it
    // spend a low five-figure number of the five million steps.
    const body = "Some **bold** copy, a *little* emphasis, `inline code`, ~~a retraction~~, and "
      + "[a link](https://example.test/a) to finish.\n\n";
    const { doc } = await convert(body.repeat(500));
    assert.equal(doc.content.length, 500);
    assert.deepEqual(validateDocument(doc).errors, []);

    // And the worst legitimate shape: one very long paragraph with no block
    // boundary in it, every mark properly closed.
    const single = await convert(`${"**a** *b* `c` [d](/e) ".repeat(4_000)}end`);
    assert.equal(single.doc.content.length, 1);
    assert.deepEqual(validateDocument(single.doc).errors, []);
  });
});

test("normalises CRLF and a trailing newline like every other Markdown tool", async () => {
  const { doc } = await convert("# Title\r\n\r\nBody text.\r\n");
  assert.deepEqual(doc, {
    type: "doc",
    content: [{ type: "heading", attrs: { level: 1 }, content: [text("Title")] }, paragraph(text("Body text."))],
  });
});

test("passes the raw reference to the resolver and reports its failures by name", async (testContext) => {
  await testContext.test("the reference is passed through verbatim", async () => {
    const seen = [];
    await markdownToProseMirror("![a](images/hero%20shot.png)", {
      resolveImage: async (reference) => {
        seen.push(reference);
        return { imageId: IMAGE_ID, width: 10, height: 5, alt: "" };
      },
    });
    assert.deepEqual(seen, ["images/hero%20shot.png"]);
  });

  await testContext.test("a throwing resolver", async () => {
    const failure = new Error("no such image: secret-token-in-message");
    await assert.rejects(
      markdownToProseMirror("![a](missing.png)", {
        resolveImage: async () => {
          throw failure;
        },
      }),
      (error) => {
        assert.equal(error.code, "content.markdown_image");
        // The resolver talks to the API, so its message never reaches the
        // diagnostic; it travels as `cause`.
        assert.ok(!error.message.includes("secret-token-in-message"));
        assert.equal(error.cause, failure);
        return true;
      },
    );
  });

  await testContext.test("a resolver that returns no image id", async () => {
    for (const resolved of [undefined, null, {}, { imageId: "image-1" }, "an-id"]) {
      await assert.rejects(
        markdownToProseMirror("![a](x.png)", { resolveImage: async () => resolved }),
        (error) => error.code === "content.markdown_image",
      );
    }
  });

  await testContext.test("dimensions are omitted rather than invented", async () => {
    const { doc } = await markdownToProseMirror("![a](x.png)", {
      resolveImage: async () => ({ imageId: IMAGE_ID, width: 0, height: null, alt: "from the resolver" }),
    });
    assert.deepEqual(doc.content[0].attrs, { imageId: IMAGE_ID, src: "", urls: [], alt: "a" });
  });

  await testContext.test("the delivery hints are discarded, keys and all", async () => {
    const { doc } = await markdownToProseMirror("![a](x.png)", {
      resolveImage: async () => ({
        imageId: IMAGE_ID,
        src: "https://cdn.example.test/should-not-be-used.webp",
        urls: [{ minWidth: 640, url: "https://cdn.example.test/should-not-be-used.webp" }],
      }),
    });
    // PageImageDeliveryRewriter only rewrites keys that are already present,
    // and it fills them from the site's signed URLs — so the keys must exist
    // and must not carry a URL this CLI invented.
    assert.equal(doc.content[0].attrs.src, "");
    assert.deepEqual(doc.content[0].attrs.urls, []);
  });
});

test("gates its own output on the validator", () => {
  // The gate every conversion runs through. It is unreachable from a valid
  // conversion by construction, so it is exercised directly.
  assert.throws(
    () => assertConvertedDocument({ type: "doc", content: [{ type: "marquee" }] }),
    (error) => {
      assert.equal(error.code, "content.markdown_invariant");
      assert.equal(error.field, "content.unknown_node");
      return true;
    },
  );
  assert.doesNotThrow(() =>
    assertConvertedDocument({ type: "doc", content: [{ type: "paragraph", content: [text("x")] }] })
  );
});
