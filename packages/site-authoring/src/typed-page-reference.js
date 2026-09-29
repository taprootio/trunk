import { CLI_BINARY_NAME } from "./constants.js";
import {
  frontMatterKeysFor,
  PLACE_REVIEW_RATINGS,
  TEMPLATE_ALBUM,
  TEMPLATE_ARTICLE,
  TEMPLATE_PLACE_REVIEW,
  TEMPLATE_RECIPE,
} from "./typed-pages.js";
import { PAGES_DIRECTORY } from "./workspace.js";

/**
 * `help page <type>` for the four templates beyond free-form (TR00893).
 *
 * The front-matter fields are read from `typed-pages.js`, the module that
 * enforces them, so the reference cannot list a field the parser refuses. The
 * worked examples are checked against that same parser by the test suite.
 */

const FIELD_HELP = Object.freeze({
  title: { type: "string", required: true, description: "The page title." },
  path: {
    type: "string",
    required: true,
    description:
      "URL path, e.g. journal/first-post. Each segment starts with a letter or digit and uses only letters, digits, '.', '_' and '-'.",
  },
  description: {
    type: "string",
    required: false,
    description: "Short description used in listings and search results.",
  },
  template: {
    type: "string",
    required: true,
    description: "Selects the template. A page's template never changes after it is created.",
  },
  displayDate: {
    type: "YYYY-MM-DD",
    required: false,
    description:
      "The date the page is about or was originally published. Set it to preserve an imported date; omit it to use the "
      + "first publication date. An empty value clears it.",
  },
  coverImage: {
    type: "media reference",
    required: false,
    description:
      "A file recorded by 'media upload', e.g. media/cover.jpg. The site requires the cover to be one of the page's own "
      + "images, so the same file must also appear in the body, introduction, steps or album images "
      + "(pages.cover_image_unused). Omit it for automatic selection; an empty value clears it.",
  },
  prepTimeMinutes: { type: "whole number", required: false, description: "Preparation time in minutes." },
  cookTimeMinutes: { type: "whole number", required: false, description: "Cooking time in minutes." },
  servings: { type: "whole number", required: false, description: "Number of servings." },
  recipeCategory: { type: "string", required: false, description: "For example Dessert." },
  recipeCuisine: { type: "string", required: false, description: "For example American." },
  cookingMethod: { type: "string", required: false, description: "For example Baking." },
  seamless: { type: "true | false", required: false, description: "Overrides the site's seamless-album setting." },
  borderWidth: {
    type: "whole number 0-20",
    required: false,
    description: "Overrides the site's album border width in pixels.",
  },
  placeId: {
    type: "UUID",
    required: true,
    description:
      "The Taproot place being reviewed. The site fills in its name, address and coordinates from this record; this "
      + "CLI does not search for places.",
  },
  rating: {
    type: Object.keys(PLACE_REVIEW_RATINGS).join(" | "),
    required: true,
    description: "The reviewer's verdict.",
  },
});

const ARTICLE_EXAMPLE = `---
title: How we found the trailhead
path: journal/how-we-found-the-trailhead
description: A short note about the first hike.
template: article
displayDate: 2023-06-18
coverImage: media/trailhead.jpg
---

We parked at the end of the gravel road and walked the last mile.

![The trailhead at dawn](media/trailhead.jpg)
`;

const RECIPE_EXAMPLE = `---
title: Lemon bars
path: recipes/lemon-bars
template: recipe
displayDate: 2022-11-04
prepTimeMinutes: 15
cookTimeMinutes: 35
servings: 16
recipeCategory: Dessert
recipeCuisine: American
cookingMethod: Baking
---

Tart, sweet, and easy to double.

## Ingredients

### Crust

- 2 cups flour
- 1/2 cup powdered sugar

### Filling

- 4 eggs
- 1 1/2 cups sugar

## Instructions

1. Press the crust into a pan and bake for 20 minutes.
2. Whisk the filling and pour it over the warm crust.

   Bake until set.
`;

const ALBUM_EXAMPLE = `---
title: Weekend at the lake
path: albums/lake-weekend
template: album
displayDate: 2023-07-01
seamless: true
---

Three days, one cabin.

## Images

![Sunrise over the dock](media/dock.jpg)
![Canoes on the shore](media/canoes.jpg)
`;

const PLACE_REVIEW_EXAMPLE = `---
title: Corner Cafe
path: reviews/corner-cafe
template: place-review
placeId: 0198a3f2-7c4e-4a10-9b2d-3f6e5d4c3b2a
rating: will-return
---

The espresso is excellent and the pastries sell out by ten.
`;

// The id `media upload` records for a file, shown here as a stand-in.
const EXAMPLE_IMAGE_ID = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";

const PARAGRAPH = (text) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

function documentExample(template, extra, data) {
  return { template, ...extra, data };
}

const TYPE_DETAILS = Object.freeze({
  [TEMPLATE_ARTICLE]: {
    displayName: "Article",
    summary: "A dated post: a title, an optional cover image, and a rich-text body. The template for blog posts.",
    body: "Everything after the front matter is the article body, in the same Markdown subset as a free-form page.",
    markdownExample: ARTICLE_EXAMPLE,
    documentExample: documentExample(
      TEMPLATE_ARTICLE,
      { displayDate: "2023-06-18", coverImageId: EXAMPLE_IMAGE_ID },
      { body: PARAGRAPH("We parked at the end of the gravel road and walked the last mile.") },
    ),
    dataFields: ["body: ProseMirror document (required, not empty)"],
  },
  [TEMPLATE_RECIPE]: {
    displayName: "Recipe",
    summary: "Structured ingredients and steps with times, servings and category, published with recipe markup.",
    body:
      "Text before '## Ingredients' is the introduction (optional). '## Ingredients' holds '- ' bullets, optionally split "
      + "by '### Group name' headings. '## Instructions' holds numbered or bulleted steps, optionally split by "
      + "'### Section name' headings; indent a step's later paragraphs by two spaces. Those two headings are the only "
      + "level-2 headings allowed, and both are required: text that does not fit is refused, never dropped. The "
      + "introduction and each step take paragraphs, headings, lists, quotes, code, images, tables and components, but "
      + "not sections or inline facts, which the site rejects there (pages.node_unsupported_for_template).",
    markdownExample: RECIPE_EXAMPLE,
    documentExample: documentExample(
      TEMPLATE_RECIPE,
      { displayDate: "2022-11-04" },
      {
        introductionBody: PARAGRAPH("Tart, sweet, and easy to double."),
        ingredientGroups: [{
          name: "Crust",
          ingredients: [{ rawText: "2 cups flour", quantity: "", unit: "", name: "", parsed: false }],
        }],
        instructionSections: [{ name: "", stepBodies: [PARAGRAPH("Press the crust into a pan and bake.")] }],
        prepTimeMinutes: 15,
        cookTimeMinutes: 35,
        servings: 16,
        recipeCategory: "Dessert",
        recipeCuisine: "American",
        cookingMethod: "Baking",
      },
    ),
    dataFields: [
      "introductionBody: ProseMirror document (optional)",
      "ingredientGroups: [{ name, ingredients: [{ rawText, quantity, unit, name, parsed }] }]; at least one ingredient",
      "instructionSections: [{ name, stepBodies: [ProseMirror document] }]; at least one step",
      "prepTimeMinutes, cookTimeMinutes, servings: whole numbers; recipeCategory, recipeCuisine, cookingMethod: strings",
    ],
    note:
      "A Markdown source supplies each ingredient as text only, so it publishes as written. A .pm.json source may also "
      + "carry quantity, unit and name with parsed: true.",
  },
  [TEMPLATE_ALBUM]: {
    displayName: "Album",
    summary: "A gallery of images with an optional introduction and per-album layout overrides.",
    body:
      "Text before '## Images' is the introduction (optional). '## Images' holds one '![caption](media/file.jpg)' line "
      + "per image, in display order, each recorded by 'media upload'. It is the only level-2 heading allowed. The "
      + "introduction takes paragraphs, headings, lists, quotes, code, images, tables and components, but not sections "
      + "or inline facts (pages.node_unsupported_for_template).",
    markdownExample: ALBUM_EXAMPLE,
    documentExample: documentExample(
      TEMPLATE_ALBUM,
      { displayDate: "2023-07-01" },
      {
        introductionBody: PARAGRAPH("Three days, one cabin."),
        images: [{
          imageId: EXAMPLE_IMAGE_ID,
          caption: "Sunrise over the dock",
          width: 1600,
          height: 900,
        }],
        seamless: true,
      },
    ),
    dataFields: [
      "introductionBody: ProseMirror document (optional)",
      "images: [{ imageId, caption, width, height }]; at least one",
      "seamless: true | false and borderWidth: 0-20 (optional; omitted inherits the site default)",
    ],
  },
  [TEMPLATE_PLACE_REVIEW]: {
    displayName: "Place review",
    summary: "A review of a place with a three-step rating, listed on the site's places archive.",
    body: "Everything after the front matter is the review body.",
    markdownExample: PLACE_REVIEW_EXAMPLE,
    documentExample: documentExample(
      TEMPLATE_PLACE_REVIEW,
      {},
      {
        placeId: "0198a3f2-7c4e-4a10-9b2d-3f6e5d4c3b2a",
        rating: "will-return",
        body: PARAGRAPH("The espresso is excellent and the pastries sell out by ten."),
      },
    ),
    dataFields: [
      "placeId: UUID of an existing Taproot place",
      `rating: ${Object.keys(PLACE_REVIEW_RATINGS).join(" | ")}`,
      "body: ProseMirror document (required, not empty)",
    ],
  },
});

export const TYPED_PAGE_TYPES = Object.freeze(Object.keys(TYPE_DETAILS));

function typedReference(type) {
  const details = TYPE_DETAILS[type];
  return Object.freeze({
    type,
    displayName: details.displayName,
    summary: details.summary,
    workspace: Object.freeze({
      directory: `${PAGES_DIRECTORY}/`,
      sourceRule:
        `One source file per page, exactly as for a free-form page: see '${CLI_BINARY_NAME} help page free-form'. `
        + "The template is declared in the source (front matter 'template', or the .pm.json 'template' field) and is "
        + "immutable after creation: pages push refuses a source whose template differs from the live page's "
        + "(pages.template_immutable).",
      pull:
        "pull writes each page of this template as a .pm.json document, byte-stable across pulls. A page you authored as "
        + "Markdown keeps its Markdown source, and a change made on the site since the last pull is reported as a conflict.",
      formats: Object.freeze([
        Object.freeze({
          extension: ".md",
          purpose: "Author the page as Markdown with front matter.",
          metadata: Object.freeze(
            frontMatterKeysFor(type).map((name) => Object.freeze({ name, ...FIELD_HELP[name] })),
          ),
        }),
        Object.freeze({
          extension: ".pm.json",
          purpose:
            "The pulled form: { template, displayDate?, coverImageId?, data }. Title, path and description come from the manifest.",
          dataFields: Object.freeze(details.dataFields),
        }),
      ]),
    }),
    markdown: Object.freeze({ body: details.body, example: details.markdownExample }),
    document: Object.freeze({ example: details.documentExample, ...(details.note ? { note: details.note } : {}) }),
    workflow: Object.freeze([
      Object.freeze({ command: `${CLI_BINARY_NAME} media upload`, result: "Upload cover and album images first." }),
      Object.freeze({ command: `${CLI_BINARY_NAME} validate`, result: "Check the workspace before sending anything." }),
      Object.freeze({ command: `${CLI_BINARY_NAME} pages push`, result: "Create or update an unapproved draft." }),
      Object.freeze({
        command: `${CLI_BINARY_NAME} approve, deploy --staging, deploy --production`,
        result: "Stage, review and promote, as for any page.",
      }),
    ]),
  });
}

const REFERENCES = Object.freeze(Object.fromEntries(TYPED_PAGE_TYPES.map((type) => [type, typedReference(type)])));

/** The reference for one non-free-form template, or `undefined`. */
export function getTypedPageReference(type) {
  return Object.hasOwn(REFERENCES, type) ? REFERENCES[type] : undefined;
}

function formatField(field) {
  return `  ${field.name.padEnd(18)} ${field.type}; ${field.required ? "required" : "optional"}; ${field.description}`;
}

/** The plain-text `help page <type>` rendering. */
export function formatTypedPageReference(page) {
  const markdown = page.workspace.formats.find((format) => format.extension === ".md");
  const json = page.workspace.formats.find((format) => format.extension === ".pm.json");
  return `${page.displayName} (${page.type})\n${page.summary}\n\nWorkspace (${page.workspace.directory}):\n  source rule           ${page.workspace.sourceRule}\n  pull                  ${page.workspace.pull}\n\nMarkdown front matter:\n${
    markdown.metadata.map(formatField).join("\n")
  }\n\nMarkdown body: ${page.markdown.body}\n\nMarkdown example:\n${page.markdown.example}\n.pm.json (${json.purpose})\n  data:\n${
    json.dataFields.map((field) => `    ${field}`).join("\n")
  }\n${page.document.note === undefined ? "" : `  ${page.document.note}\n`}\n.pm.json example:\n${
    JSON.stringify(page.document.example, null, 2)
  }\n\nWorkflow:\n${
    page.workflow.map((step) => `  ${step.command}: ${step.result}`).join("\n")
  }\n\nUse --json for the exact structure.\n`;
}
