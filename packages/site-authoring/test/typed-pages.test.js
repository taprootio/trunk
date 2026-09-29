import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { markdownToProseMirror, validateDocument } from "../src/content/index.js";
import { getPageTypeReference } from "../src/reference-help.js";
import {
  contentDocuments,
  documentImageIds,
  documentTemplate,
  frontMatterKeysFor,
  typedDocumentFromJson,
  typedDocumentFromMarkdown,
  unsupportedRestrictedNode,
  unusedCoverImageId,
  wirePageFields,
  wireTemplate,
  workspaceDocumentFromPage,
} from "../src/typed-pages.js";
import { validateWorkspacePageDocument, validateWorkspacePageSource } from "../src/verbs/pages-push.js";

const CONTENT = Object.freeze({ markdownToProseMirror, validateDocument });
const PLACE_ID = "0198a3f2-7c4e-7a10-9b2d-3f6e5d4c3b2a";
const COVER_ID = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const IMAGE_ONE = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const IMAGE_TWO = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";

const MEDIA = {
  media: {
    "media/cover.jpg": { imageId: COVER_ID, width: 1600, height: 900, alt: "Cover" },
    "media/one.jpg": { imageId: IMAGE_ONE, width: 1200, height: 800, alt: "One" },
    "media/two.jpg": { imageId: IMAGE_TWO, width: 800, height: 1200, alt: "Two" },
  },
};

const RECIPE = `---
title: Lemon bars
path: lemon-bars
template: recipe
displayDate: 2021-06-14
coverImage: media/cover.jpg
prepTimeMinutes: 15
cookTimeMinutes: 35
servings: 16
recipeCategory: Dessert
---

Bright and **tart**.

![Cover](media/cover.jpg)

## Ingredients

### Crust

- 2 cups flour
- 1/2 cup sugar

### Filling

- 4 eggs

## Instructions

1. Mix the crust.
2. Bake for 20 minutes.

   Cool completely.

### Finish

1. Dust with sugar.
`;

async function workspaceWith(context, files) {
  const base = await mkdtemp(path.join(os.tmpdir(), "taproot-typed-pages-"));
  context.after(() => rm(base, { recursive: true, force: true }));
  const workspaceDir = await realpath(base);
  await mkdir(path.join(workspaceDir, "pages"), { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(workspaceDir, "pages", name), text);
  return workspaceDir;
}

async function readSource(context, name, text) {
  const workspaceDir = await workspaceWith(context, { [name]: text });
  return await validateWorkspacePageSource({
    workspaceDir,
    file: `pages/${name}`,
    mediaManifest: MEDIA,
    content: CONTENT,
  });
}

/** What the API's JSON keeps: proto3 drops every default value. */
function omitDefaults(value) {
  if (Array.isArray(value)) return value.map(omitDefaults);
  // A ProseMirror document rides in a Struct, whose members are all kept.
  if (value === null || typeof value !== "object" || value.type === "doc") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== "" && child !== 0 && child !== false)
      .map(([key, child]) => [key, omitDefaults(child)]),
  );
}

/** A `GetPageById` response for a document, the way the site would echo it back. */
function pageEcho(document_) {
  const template = wireTemplate(document_);
  return {
    displayDate: document_.displayDate,
    coverImageId: document_.coverImageId,
    template: Object.fromEntries(
      Object.entries(template).map(([key, value]) => [key, key.endsWith("Data") ? omitDefaults(value) : value]),
    ),
  };
}

test("a recipe source becomes structured ingredients, grouped steps, and page fields", async (context) => {
  const page = await readSource(context, "lemon-bars.md", RECIPE);
  const document_ = page.document;

  assert.equal(documentTemplate(document_), "recipe");
  assert.equal(document_.displayDate, "2021-06-14");
  assert.equal(document_.coverImageId, COVER_ID);
  assert.deepEqual(Object.keys(document_), ["template", "displayDate", "coverImageId", "data"]);
  const { data } = document_;
  assert.equal(data.prepTimeMinutes, 15);
  assert.equal(data.servings, 16);
  assert.equal(data.recipeCategory, "Dessert");
  assert.equal(data.recipeCuisine, "");
  assert.deepEqual(
    data.ingredientGroups.map((group) => [group.name, group.ingredients.map((entry) => entry.rawText)]),
    [["Crust", ["2 cups flour", "1/2 cup sugar"]], ["Filling", ["4 eggs"]]],
  );
  assert.deepEqual(data.ingredientGroups[0].ingredients[0], {
    rawText: "2 cups flour",
    quantity: "",
    unit: "",
    name: "",
    parsed: false,
  });
  assert.deepEqual(data.instructionSections.map((section) => [section.name, section.stepBodies.length]), [
    ["", 2],
    ["Finish", 1],
  ]);
  // A step keeps its continuation paragraph rather than dropping it.
  assert.equal(data.instructionSections[0].stepBodies[1].content.length, 2);
  assert.equal(data.introductionBody.type, "doc");

  const wire = wireTemplate(document_);
  assert.equal(wire.templateType, "TEMPLATE_TYPE_RECIPE");
  assert.equal(wire.templateVersion, "1.0");
  assert.deepEqual(wire.recipeData, data);
  assert.deepEqual(wirePageFields(document_), { displayDate: "2021-06-14", coverImageId: COVER_ID });
  assert.equal(contentDocuments(document_).length, 4);
  await validateWorkspacePageDocument({
    workspaceDir: "/unused",
    siteId: "unused",
    file: "pages/lemon-bars.md",
    document: document_,
    content: CONTENT,
    getSharedThemeContexts: async () => new Set(),
  });
});

test("an article and a place review keep their body, and a review maps its rating to the wire enum", async (context) => {
  const article = (await readSource(
    context,
    "story.md",
    "---\ntitle: Story\npath: story\ntemplate: article\ndisplayDate: 2019-02-03\n---\n\nOnce upon a time.\n",
  )).document;
  assert.deepEqual(Object.keys(article), ["template", "displayDate", "data"]);
  assert.equal(wireTemplate(article).articleData.body.type, "doc");
  assert.deepEqual(wirePageFields(article), { displayDate: "2019-02-03" });

  const review = (await readSource(
    context,
    "cafe.md",
    `---\ntitle: Cafe\npath: cafe\ntemplate: place-review\nplaceId: ${PLACE_ID}\nrating: will-return\n---\n\nGreat.\n`,
  )).document;
  const wire = wireTemplate(review);
  assert.equal(wire.templateType, "TEMPLATE_TYPE_PLACE_REVIEW");
  assert.equal(wire.placeReviewData.rating, "PLACE_REVIEW_RATING_WILL_RETURN");
  assert.equal(wire.placeReviewData.placeId, PLACE_ID);
  // The document itself keeps the author's word, so a pull-edit-push cycle
  // does not rewrite it.
  assert.equal(review.data.rating, "will-return");
  assert.deepEqual(wirePageFields(review), {});
});

test("an album lists its images under the Images heading and resolves them through the media manifest", async (context) => {
  const album = (await readSource(
    context,
    "trip.md",
    "---\ntitle: Trip\npath: trip\ntemplate: album\nseamless: true\nborderWidth: 4\n---\n\nA weekend away.\n\n"
      + "## Images\n\n![Sunrise](media/one.jpg)\n![Dusk](./media/two.jpg)\n",
  )).document;
  assert.deepEqual(album.data.images, [
    { imageId: IMAGE_ONE, caption: "Sunrise", width: 1200, height: 800 },
    { imageId: IMAGE_TWO, caption: "Dusk", width: 800, height: 1200 },
  ]);
  assert.equal(album.data.seamless, true);
  assert.equal(album.data.borderWidth, 4);
  assert.deepEqual(documentImageIds(album), [IMAGE_ONE, IMAGE_TWO]);
  assert.equal(wireTemplate(album).albumData.images.length, 2);
});

test("the document a page read projects to is the one its source produced, byte for byte", async (context) => {
  const sources = {
    "lemon-bars.md": RECIPE,
    "trip.md": "---\ntitle: Trip\npath: trip\ntemplate: album\ncoverImage: media/one.jpg\n---\n\n## Images\n\n"
      + "![Sunrise](media/one.jpg)\n",
    "story.md": "---\ntitle: Story\npath: story\ntemplate: article\n---\n\nOnce.\n",
    "cafe.md":
      `---\ntitle: Cafe\npath: cafe\ntemplate: place-review\nplaceId: ${PLACE_ID}\nrating: might-return\n---\n\nFine.\n`,
  };
  for (const [name, text] of Object.entries(sources)) {
    const document_ = (await readSource(context, name, text)).document;
    const pulled = workspaceDocumentFromPage(pageEcho(document_));
    assert.equal(JSON.stringify(pulled, undefined, 2), JSON.stringify(document_, undefined, 2), name);
    // Pulling what a push sent, then pushing that, changes nothing.
    assert.deepEqual(wireTemplate(pulled), wireTemplate(document_), name);
    assert.deepEqual(typedDocumentFromJson(pulled, name), pulled, name);
  }
});

test("pull keeps only what the site reports, and a page it cannot read yields nothing", () => {
  assert.equal(workspaceDocumentFromPage({ template: { templateType: "TEMPLATE_TYPE_ARTICLE" } }), undefined);
  assert.equal(
    workspaceDocumentFromPage({ template: { templateType: "TEMPLATE_TYPE_LEGAL", legalDocumentData: {} } }),
    undefined,
  );
  assert.equal(
    workspaceDocumentFromPage({
      template: {
        templateType: "TEMPLATE_TYPE_PLACE_REVIEW",
        placeReviewData: { placeId: PLACE_ID, body: { type: "doc", content: [] } },
      },
    }),
    undefined,
    "a review with no rating is not a document this package can round-trip",
  );
  // The API's JSON omits defaults; the projection writes them back so two
  // reads of one page cannot differ in which keys exist.
  const recipe = workspaceDocumentFromPage({
    template: {
      templateType: "TEMPLATE_TYPE_RECIPE",
      recipeData: {
        ingredientGroups: [{ ingredients: [{ rawText: "1 egg" }] }],
        instructionSections: [{ stepBodies: [{ type: "doc", content: [] }] }],
      },
    },
  });
  assert.deepEqual(recipe.data.ingredientGroups, [{
    name: "",
    ingredients: [{ rawText: "1 egg", quantity: "", unit: "", name: "", parsed: false }],
  }]);
  assert.equal(recipe.data.servings, 0);
});

test("a source is refused before anything is sent when its shape cannot be sent", async (context) => {
  const cases = [
    ["unknown template", "---\ntitle: T\npath: t\ntemplate: poem\n---\n\nx\n", "pages.template_unknown"],
    [
      "a field of another template",
      "---\ntitle: T\npath: t\ntemplate: article\nservings: 4\n---\n\nx\n",
      "pages.front_matter_unknown",
    ],
    [
      "typed fields on a free-form page",
      "---\ntitle: T\npath: t\ndisplayDate: 2020-01-01\n---\n\nx\n",
      "pages.front_matter_unknown",
    ],
    [
      "an impossible date",
      "---\ntitle: T\npath: t\ntemplate: article\ndisplayDate: 2021-02-30\n---\n\nx\n",
      "pages.display_date_invalid",
    ],
    [
      "an unresolved cover",
      "---\ntitle: T\npath: t\ntemplate: article\ncoverImage: media/nope.jpg\n---\n\nx\n",
      "media.unresolved_reference",
    ],
    [
      "a review without a place",
      "---\ntitle: T\npath: t\ntemplate: place-review\nrating: will-return\n---\n\nx\n",
      "pages.place_review_invalid",
    ],
    [
      "a review with a made-up rating",
      `---\ntitle: T\npath: t\ntemplate: place-review\nplaceId: ${PLACE_ID}\nrating: great\n---\n\nx\n`,
      "pages.document_shape",
    ],
    ["an empty article", "---\ntitle: T\npath: t\ntemplate: article\n---\n\n\n", "content.markdown_empty"],
    [
      "a non-numeric count",
      "---\ntitle: T\npath: t\ntemplate: recipe\nservings: many\n---\n\n## Ingredients\n\n- egg\n\n## Instructions\n\n1. Cook.\n",
      "pages.front_matter_value_invalid",
    ],
    [
      "an album with no Images section",
      "---\ntitle: T\npath: t\ntemplate: album\n---\n\nx\n",
      "pages.album_sections_invalid",
    ],
    [
      "an album with a stray line",
      "---\ntitle: T\npath: t\ntemplate: album\n---\n\n## Images\n\nnot an image\n",
      "pages.album_section_invalid",
    ],
    [
      "an album with no images",
      "---\ntitle: T\npath: t\ntemplate: album\n---\n\n## Images\n\n",
      "pages.album_images_missing",
    ],
    [
      "a recipe with an extra section",
      "---\ntitle: T\npath: t\ntemplate: recipe\n---\n\n## Ingredients\n\n- egg\n\n## Instructions\n\n1. Cook.\n\n## Notes\n\nKeep cold.\n",
      "pages.recipe_sections_invalid",
    ],
    [
      "a recipe with prose among the ingredients",
      "---\ntitle: T\npath: t\ntemplate: recipe\n---\n\n## Ingredients\n\nsome egg\n\n## Instructions\n\n1. Cook.\n",
      "pages.recipe_section_invalid",
    ],
    [
      "a recipe with no steps",
      "---\ntitle: T\npath: t\ntemplate: recipe\n---\n\n## Ingredients\n\n- egg\n\n## Instructions\n\n",
      "pages.recipe_incomplete",
    ],
  ];
  for (const [label, text, code] of cases) {
    await assert.rejects(readSource(context, "page.md", text), { code }, label);
  }
});

test("a .pm.json source is held to the same shape, and unknown fields are refused rather than dropped", () => {
  const good = {
    template: "article",
    displayDate: "2020-05-05",
    coverImageId: COVER_ID,
    data: { body: { type: "doc", content: [{ type: "paragraph" }] } },
  };
  assert.deepEqual(typedDocumentFromJson(good, "pages/a.pm.json"), good);
  for (
    const [label, bad] of [
      ["an unknown top-level field", { ...good, extra: 1 }],
      ["an unknown data field", { ...good, data: { ...good.data, place: { placeId: PLACE_ID } } }],
      ["the free-form template as a wrapper", { ...good, template: "free-form" }],
      ["a body that is not a document", { ...good, data: { body: "text" } }],
      ["a body with no content", { ...good, data: { body: { type: "doc", content: [] } } }],
      ["a cover that is not an id", { ...good, coverImageId: "nope" }],
      ["an unknown template", { ...good, template: "poem" }],
    ]
  ) {
    assert.throws(() => typedDocumentFromJson(bad, "pages/a.pm.json"), Error, label);
  }
  assert.equal(typedDocumentFromJson({ ...good, coverImageId: "" }, "pages/a.pm.json").coverImageId, "");
});

test("every worked example in the page-type reference is a valid source, and its two forms agree", async (context) => {
  for (const type of ["article", "recipe", "album", "place-review"]) {
    const reference = getPageTypeReference(type);
    assert.equal(reference.type, type);
    const workspaceDir = await workspaceWith(context, { [`${type}.md`]: reference.markdown.example });
    const fromMarkdown = await validateWorkspacePageSource({
      workspaceDir,
      file: `pages/${type}.md`,
      mediaManifest: {
        media: {
          "media/trailhead.jpg": { imageId: COVER_ID, width: 1600, height: 900 },
          "media/dock.jpg": { imageId: IMAGE_ONE, width: 1600, height: 900 },
          "media/canoes.jpg": { imageId: IMAGE_TWO, width: 1600, height: 900 },
        },
      },
      content: CONTENT,
    });
    assert.equal(documentTemplate(fromMarkdown.document), type);
    // The worked example must also pass the checks a push runs, cover-image rule included.
    await validateWorkspacePageDocument({
      workspaceDir,
      siteId: "unused",
      file: `pages/${type}.md`,
      document: fromMarkdown.document,
      content: CONTENT,
      getSharedThemeContexts: async () => new Set(),
    });
    // The .pm.json example is the same page in its pulled form.
    const json = typedDocumentFromJson(reference.document.example, `${type}.pm.json`);
    assert.equal(documentTemplate(json), type);
    for (const { doc } of contentDocuments(json)) assert.deepEqual(CONTENT.validateDocument(doc).errors, []);
    // Every front-matter field the reference lists is one the parser accepts.
    const listed = reference.workspace.formats[0].metadata.map((field) => field.name);
    assert.deepEqual(listed, frontMatterKeysFor(type));
  }
});

test("an introduction the site returns empty is not a document, and a blank one still validates", async () => {
  const listed = (introductionBody) =>
    workspaceDocumentFromPage({
      template: {
        templateType: "TEMPLATE_TYPE_ALBUM",
        albumData: { introductionBody, images: [{ imageId: IMAGE_ONE }] },
      },
    });
  assert.equal("introductionBody" in listed({ type: "doc", content: [] }).data, false);
  const blank = listed({ type: "doc", content: [{ type: "paragraph" }] });
  assert.equal(blank.data.introductionBody.content.length, 1);
  // The editor saves that blank paragraph for every album with no introduction,
  // so pushing a pulled album back must not trip the empty-document rule.
  await validateWorkspacePageDocument({
    workspaceDir: "/unused",
    siteId: "unused",
    file: "pages/album.pm.json",
    document: blank,
    content: CONTENT,
    getSharedThemeContexts: async () => new Set(),
  });
});

test("an introduction or step is refused for a node the API would reject, before anything is sent", async () => {
  const paragraph = { type: "paragraph", content: [{ type: "text", text: "x" }] };
  const section = { type: "section", attrs: {}, content: [paragraph] };
  const inlineFacts = { type: "inlineFacts", attrs: { items: [{ value: "1", label: "x" }] } };
  const image = { imageId: IMAGE_ONE, caption: "", width: 1, height: 1 };
  const validate = (document_) =>
    validateWorkspacePageDocument({
      workspaceDir: "/unused",
      siteId: "unused",
      file: "pages/page.pm.json",
      document: document_,
      content: CONTENT,
      getSharedThemeContexts: async () => new Set(),
    });
  const refusal = { code: "pages.node_unsupported_for_template" };

  await assert.rejects(
    validate({ template: "album", data: { introductionBody: { type: "doc", content: [section] }, images: [image] } }),
    refusal,
  );
  await assert.rejects(
    validate({
      template: "recipe",
      data: {
        ingredientGroups: [{ name: "", ingredients: [{ rawText: "egg" }] }],
        instructionSections: [{ name: "", stepBodies: [{ type: "doc", content: [inlineFacts] }] }],
      },
    }),
    refusal,
  );
  // A table is fine at the root of an introduction and refused inside a list.
  const table = (rows) => ({ type: "table", content: rows });
  assert.equal(unsupportedRestrictedNode({ type: "doc", content: [table([])] }), undefined);
  assert.equal(
    unsupportedRestrictedNode({
      type: "doc",
      content: [{ type: "bulletList", content: [{ type: "listItem", content: [table([])] }] }],
    }),
    "table",
  );
  // An article body has no such limit: the API accepts what a free-form page does.
  await validate({ template: "article", data: { body: { type: "doc", content: [section] } } });
});

test("a display date must be a real date the API can parse", async (context) => {
  for (const bad of ["2024-13-01", "2023-02-29", "0000-01-01", "2024-00-10", "2024-04-31", "24-01-01"]) {
    await assert.rejects(
      readSource(context, "page.md", `---\ntitle: T\npath: t\ntemplate: article\ndisplayDate: ${bad}\n---\n\nx\n`),
      { code: "pages.display_date_invalid" },
      bad,
    );
  }
  for (const good of ["2024-02-29", "0001-01-01", "9999-12-31", "2000-02-29"]) {
    const page = await readSource(
      context,
      "page.md",
      `---\ntitle: T\npath: t\ntemplate: article\ndisplayDate: ${good}\n---\n\nx\n`,
    );
    assert.equal(page.document.displayDate, good);
  }
});

test("a recipe step keeps the nesting and code it was written with", async (context) => {
  const converted = [];
  const page = await typedDocumentFromMarkdown({
    template: "recipe",
    fields: new Map(),
    markdown: [
      "## Ingredients",
      "",
      "- egg",
      "",
      "## Instructions",
      "",
      "1. Mix:",
      "   - sub one",
      "     - sub two",
      "",
      "   ```",
      "   - not a step",
      "   heat 3 min",
      "   ```",
      "",
      "   Then rest.",
      "10. Serve.",
      "",
    ].join("\n"),
    file: "pages/r.md",
    convert: async (markdown) => {
      converted.push(markdown);
      return paragraphDoc(markdown);
    },
    resolveImage: async () => ({}),
  });
  assert.equal(page.data.instructionSections[0].stepBodies.length, 2);
  assert.equal(
    converted[0],
    "Mix:\n- sub one\n  - sub two\n\n```\n- not a step\nheat 3 min\n```\n\nThen rest.",
  );
  assert.equal(converted[1], "Serve.");
});

function paragraphDoc(text) {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

test("a cover image the page's own content does not use is refused before anything is sent", async (context) => {
  const validate = async (source) => {
    const page = await readSource(context, "page.md", source);
    return await validateWorkspacePageDocument({
      workspaceDir: "/unused",
      siteId: "unused",
      file: "pages/page.md",
      document: page.document,
      content: CONTENT,
      getSharedThemeContexts: async () => new Set(),
    });
  };
  const head = (template) => `---\ntitle: T\npath: t\ntemplate: ${template}\ncoverImage: media/cover.jpg\n---\n\n`;
  const refused = { code: "pages.cover_image_unused", message: /The selected cover image must be used by this page\./u };

  // The rule is the API's, for every typed template: the cover is one of the page's own images.
  await assert.rejects(validate(`${head("article")}No picture here.\n`), refused);
  await assert.rejects(validate(`${head("article")}![Other](media/one.jpg)\n`), refused);
  await validate(`${head("article")}![Cover](media/cover.jpg)\n\nText.\n`);
  await assert.rejects(
    validate(`${head("album")}## Images\n\n![One](media/one.jpg)\n`),
    refused,
  );
  await validate(`${head("album")}## Images\n\n![Cover](media/cover.jpg)\n![One](media/one.jpg)\n`);
  await assert.rejects(
    validate(`${head("recipe")}## Ingredients\n\n- egg\n\n## Instructions\n\n1. Cook.\n`),
    refused,
  );
  await validate(`${head("recipe")}## Ingredients\n\n- egg\n\n## Instructions\n\n1. Cook.\n\n   ![Cover](media/cover.jpg)\n`);
  await assert.rejects(
    validate(`${head("place-review")}Placeholder.\n`.replace("---\n\n", `placeId: ${PLACE_ID}\nrating: will-return\n---\n\n`)),
    refused,
  );
});

test("the cover rule counts every place the API counts an image, and ignores an empty or upper-case cover", async () => {
  const cover = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
  const article = (extra, coverImageId = cover) => ({
    template: "article",
    coverImageId,
    data: { body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }, ...extra] } },
  });
  const inComponent = (data) => ({ type: "componentBlock", attrs: { componentType: "hero-section", componentData: data } });
  assert.notEqual(unusedCoverImageId(article([])), undefined);
  // Component data, plain or entity-encoded the way the server reads it.
  assert.equal(unusedCoverImageId(article([inComponent(JSON.stringify({ image: { imageId: cover } }))])), undefined);
  assert.equal(
    unusedCoverImageId(article([inComponent(JSON.stringify({ image: { imageId: cover } }).replace(/"/gu, "&quot;"))])),
    undefined,
  );
  assert.equal(unusedCoverImageId(article([{ type: "integrationFragment", attrs: { imageIds: [cover] } }])), undefined);
  assert.equal(
    unusedCoverImageId(article([{ type: "section", attrs: { background: { image: { imageId: cover } } }, content: [] }])),
    undefined,
  );
  // Case does not matter, and an empty cover (clear it) is never refused.
  assert.equal(unusedCoverImageId(article([{ type: "taprootImage", attrs: { imageId: cover.toUpperCase() } }])), undefined);
  assert.equal(unusedCoverImageId(article([], "")), undefined);
});
