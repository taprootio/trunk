import { CLI_BINARY_NAME } from "./constants.js";
import {
  frontMatterKeysFor,
  PLACE_REVIEW_RATINGS,
  TEMPLATE_ALBUM,
  TEMPLATE_ARTICLE,
  TEMPLATE_GENERATED,
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
  author: {
    type: "string",
    required: false,
    description:
      "Credits the page to a site author by handle (jane-doe) or to a site member who can create pages by email "
      + "address. Pages are authorless unless you name one, and an author already on the page is never replaced. "
      + "'authors list' shows who can be named; 'authors add' creates a site author without an account.",
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
      "The Taproot place being reviewed. The site fills in its name, address and coordinates from this record. Find "
      + "it with 'places search <name and city>' and 'places select <googlePlaceId> <sessionToken>'. The site publishes the "
      + "place's category in the byline and files the review under /places/<category>; change it for this site with "
      + "'places category set <placeId> <category>'.",
  },
  place: {
    type: "UUID",
    required: false,
    description:
      "The Taproot place an article or album is about, found the same way as a place review's placeId. Omit it to "
      + "leave the page's place as it is; an empty value clears it.",
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
    dataFields: ["body: ProseMirror document (required, not empty)", "place: UUID of a Taproot place (optional; \"\" clears it)"],
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
      "place: UUID of a Taproot place (optional; \"\" clears it)",
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
  [TEMPLATE_GENERATED]: {
    displayName: "Generated page",
    summary:
      "A listing Taproot generates from the site's content: a tag, the tags index, a published year or month, a place "
      + "archive, or a folder. You cannot create one; you customize its title, breadcrumb, description and introduction.",
    documentExample: documentExample(
      TEMPLATE_GENERATED,
      {},
      {
        kind: "GENERATED_PAGE_KIND_TAG",
        tagId: "0198a3f2-7c4e-4a10-9b2d-3f6e5d4c3b2a",
        year: 0,
        month: 0,
        countryCode: "",
        regionCode: "",
        citySlug: "",
        categorySlug: "",
        customTitle: "Trail notes",
        breadcrumbTitle: "",
        customDescription: "Field notes from the trails I walk most often.",
        introductionBody: PARAGRAPH("Everything I have written about walking."),
      },
    ),
    dataFields: [
      "kind and the identity fields (tagId, year, month, countryCode, regionCode, citySlug, categorySlug): what the "
      + "page is, written by pull. Leave them as pulled; a push that changes them is refused (pages.generated_identity)",
      "customTitle: string; empty uses the generated title (the page's reader-facing title)",
      "breadcrumbTitle: string; empty uses the generated label (used on pages beneath this one)",
      "customDescription: string, at most 1000 characters, about 160 shown in search results; empty uses the "
      + "introduction's first paragraph, else the generated description",
      "introductionBody: ProseMirror document (optional), shown above the generated listing",
    ],
    note:
      "The manifest's title and description for a generated page are what the site reports, recorded for reference; "
      + "edit customTitle and customDescription here (or with 'pages meta set'), not the manifest. "
      + "pages push updates the page and refuses to create one (pages.generated_create), move it (pages.generated_move) "
      + "or change its identity (pages.generated_identity). The site derives the page's title and description from "
      + "customTitle, customDescription and introductionBody, so what a push sends for them is ignored. A source the site "
      + "no longer has a page for is reported and skipped by a whole-workspace push.",
  },
});

export const LEGAL_PAGE_TYPE = "legal";

export const TYPED_PAGE_TYPES = Object.freeze([...Object.keys(TYPE_DETAILS), LEGAL_PAGE_TYPE]);
/** The templates a Markdown source can declare: the authorable typed pages, not generated or legal. */
export const MARKDOWN_PAGE_TYPES = Object.freeze(
  TYPED_PAGE_TYPES.filter((type) => type !== TEMPLATE_GENERATED && type !== LEGAL_PAGE_TYPE),
);

/**
 * The default for any privacy policy or other legal text that names the
 * platform (TR01224). `help page free-form` prints it too, because a policy
 * written through the CLI is a free-form page.
 */
export const LEGAL_PLATFORM_LINK_GUIDANCE = Object.freeze({
  rule:
    "Where a privacy policy or other legal page names Taproot, link the first mention to https://www.taproot.io by "
    + "default, so readers can learn how the platform affects them. Leave it plain only if the owner asks.",
  example: "This site is published on [Taproot](https://www.taproot.io).",
});

function legalReference() {
  return Object.freeze({
    type: LEGAL_PAGE_TYPE,
    displayName: "Legal page",
    summary:
      "A versioned legal document such as a privacy policy or terms: an automatic h1, a version and effective date, and "
      + "permanent links to each version. The CLI can edit drafts with an explicit site grant; approval and publication happen in the app.",
    readOnly: false,
    workspace: Object.freeze({
      directory: `${PAGES_DIRECTORY}/`,
      templateType: "TEMPLATE_TYPE_LEGAL",
      sourceRule:
        "Pull writes a .pm.json source containing template legal and data with documentKey, documentRole, summaryOfChanges, material and body. "
        + "Edit that source to change the draft; Markdown is not supported. To create one, add a .pm.json source and a manifest pages entry with file, title and path, without a pageId. Version, effectiveDate and supersedesVersion are assigned by Taproot and must not be authored.",
    }),
    fields: Object.freeze([
      Object.freeze({ name: "title", description: "The page title. It prints as the page's h1, so the body should not open with its own title." }),
      Object.freeze({
        name: "body",
        description: "The rich-text document. A table of contents is built from its level-2 headings.",
      }),
      Object.freeze({
        name: "documentKey",
        description:
          "The document's stable identity, fixed after creation. The permanent version address exists only once the page has "
          + "a document key and a version.",
      }),
      Object.freeze({
        name: "documentRole",
        description:
          "The typed purpose of the document, such as membership_terms or privacy_notice. Fixed after creation.",
      }),
      Object.freeze({ name: "summaryOfChanges", description: "A short note on what this version changed, written by the owner." }),
      Object.freeze({
        name: "material",
        description: "Set by a person: this version's changes need readers to accept again when the site's policy asks for that.",
      }),
      Object.freeze({
        name: "version, effectiveDate, supersedesVersion",
        description:
          "Assigned by Taproot when the document is promoted to production: the version number, the promotion date, and "
          + "the version it replaces. They cannot be written, so a document that has not been promoted shows none of them.",
      }),
    ]),
    rendering: Object.freeze([
      "An automatic <h1> from the title, then an Effective, Version and Supersedes list, a download link for a PDF of "
      + "the version, the summary of changes, and a table of contents, once those exist.",
      "Two addresses once published: the current document at /<path>, and an immutable copy of each version at "
      + "/<path>/<version> (and /<path>/<version>.pdf). Later versions never change an earlier address.",
    ]),
    authoring: Object.freeze({
      cli:
        "Pull reads legal pages with ordinary Content access. Run 'taproot-site login --legal-drafts', then "
        + "'taproot-site --legal-drafts pages push' to create or edit legal drafts. Approval and deletion are refused by the CLI; use the app. A bare 'approve' skips legal drafts; naming a legal page refuses the whole selection.",
      key:
        "Only an explicit site-specific legal-drafts grant can save legal drafts. It does not grant site.legal_documents.manage, "
        + "and cannot approve, delete or deploy legal documents.",
      app:
        "A signed-in person who may manage the site's legal documents creates the page, writes its body, and publishes it "
        + "with a production deployment in the app. Taproot assigns the version and effective date at that point.",
    }),
    choosing: Object.freeze({
      legal:
        "Choose a legal page when readers must be able to see which version applied and when it took effect, such as a "
        + "privacy policy, terms of service or membership terms.",
      freeForm:
        "A free-form page is an ordinary page. It has no version history, no effective date, no permanent version "
        + "addresses and no automatic heading: open its Markdown with a '# ' line holding the title (see "
        + `'${CLI_BINARY_NAME} help page free-form'). A policy written as free-form is an ordinary page; put its last-updated date in its text and tell the owner it is not versioned.`,
    }),
    platformLink: LEGAL_PLATFORM_LINK_GUIDANCE,
    workflow: Object.freeze([
      Object.freeze({
        command: `${CLI_BINARY_NAME} pull`,
        result: "Writes the legal draft as a .pm.json source and records its identity in the manifest.",
      }),
      Object.freeze({
        command: `${CLI_BINARY_NAME} login --legal-drafts`,
        result: "Request a site-specific grant; a person approves it in the app.",
      }),
      Object.freeze({
        command: `${CLI_BINARY_NAME} --legal-drafts pages push`,
        result: "Saves changed legal drafts. A person approves and publishes them in the app.",
      }),
    ]),
  });
}

function typedReference(type) {
  const details = TYPE_DETAILS[type];
  const generated = type === TEMPLATE_GENERATED;
  return Object.freeze({
    type,
    displayName: details.displayName,
    summary: details.summary,
    workspace: Object.freeze({
      directory: `${PAGES_DIRECTORY}/`,
      sourceRule: generated
        ? `One source file per page, exactly as for a free-form page: see '${CLI_BINARY_NAME} help page free-form'. `
          + "A generated page exists only because the site's content produces it, so its source exists only after "
          + "'pull' and is never created by hand."
        : `One source file per page, exactly as for a free-form page: see '${CLI_BINARY_NAME} help page free-form'. `
          + "The template is declared in the source (front matter 'template', or the .pm.json 'template' field) and is "
          + "immutable after creation: pages push refuses a source whose template differs from the live page's "
          + "(pages.template_immutable).",
      pull: generated
        ? "pull writes each generated page as a .pm.json document, byte-stable across pulls, and keeps your edits to it "
          + "when the site's copy has not changed. A change made on the site since the last pull is reported as a conflict."
        : "pull writes each page of this template as a .pm.json document, byte-stable across pulls. A page you authored as "
          + "Markdown keeps its Markdown source, and a change made on the site since the last pull is reported as a conflict.",
      formats: Object.freeze([
        ...(generated ? [] : [Object.freeze({
          extension: ".md",
          purpose: "Author the page as Markdown with front matter.",
          metadata: Object.freeze(
            frontMatterKeysFor(type).map((name) => Object.freeze({ name, ...FIELD_HELP[name] })),
          ),
        })]),
        Object.freeze({
          extension: ".pm.json",
          purpose: generated
            ? "The pulled form, and the only one: { template, data }. Path comes from the manifest; title and description "
              + "are the custom ones in data."
            : "The pulled form: { template, displayDate?, coverImageId?, data }. Title, path and description come from the manifest.",
          dataFields: Object.freeze(details.dataFields),
        }),
      ]),
    }),
    ...(generated ? {} : { markdown: Object.freeze({ body: details.body, example: details.markdownExample }) }),
    document: Object.freeze({ example: details.documentExample, ...(details.note ? { note: details.note } : {}) }),
    workflow: Object.freeze([
      ...(generated
        ? [Object.freeze({
          command: `${CLI_BINARY_NAME} pull, then pages meta set <path> --title/--description`,
          result: "Pull the page, then set its custom title or description (or edit the .pm.json).",
        })]
        : [Object.freeze({ command: `${CLI_BINARY_NAME} media upload`, result: "Upload cover and album images first." })]),
      Object.freeze({ command: `${CLI_BINARY_NAME} validate`, result: "Check the workspace before sending anything." }),
      Object.freeze({
        command: `${CLI_BINARY_NAME} pages push`,
        result: generated ? "Update the generated page's unapproved draft." : "Create or update an unapproved draft.",
      }),
      Object.freeze({
        command: `${CLI_BINARY_NAME} approve, deploy --staging, deploy --production`,
        result: "Stage, review and promote, as for any page.",
      }),
    ]),
  });
}

const REFERENCES = Object.freeze(
  Object.fromEntries(
    TYPED_PAGE_TYPES.map((type) => [type, type === LEGAL_PAGE_TYPE ? legalReference() : typedReference(type)]),
  ),
);

/** The reference for one non-free-form template, or `undefined`. */
export function getTypedPageReference(type) {
  return Object.hasOwn(REFERENCES, type) ? REFERENCES[type] : undefined;
}

function formatField(field) {
  return `  ${field.name.padEnd(18)} ${field.type}; ${field.required ? "required" : "optional"}; ${field.description}`;
}

function formatLegalReference(page) {
  return `${page.displayName} (${page.type})\n${page.summary}\n\nWorkspace (${page.workspace.directory}):\n  source rule           ${page.workspace.sourceRule}\n\nFields:\n${
    page.fields.map((field) => `  ${field.name}: ${field.description}`).join("\n")
  }\n\nHow it renders:\n${page.rendering.map((line) => `  - ${line}`).join("\n")}\n\nWho can author it:\n  CLI                   ${page.authoring.cli}\n  site-authoring key    ${page.authoring.key}\n  app                   ${page.authoring.app}\n\nLegal page or free-form page:\n  legal                 ${page.choosing.legal}\n  free-form             ${page.choosing.freeForm}\n\nLinking Taproot: ${page.platformLink.rule}\n  example               ${page.platformLink.example}\n\nWorkflow:\n${
    page.workflow.map((step) => `  ${step.command}: ${step.result}`).join("\n")
  }\n\nUse --json for the exact structure.\n`;
}

/** The plain-text `help page <type>` rendering. */
export function formatTypedPageReference(page) {
  if (page.type === LEGAL_PAGE_TYPE) return formatLegalReference(page);
  const markdown = page.workspace.formats.find((format) => format.extension === ".md");
  const json = page.workspace.formats.find((format) => format.extension === ".pm.json");
  const markdownSection = markdown === undefined
    ? ""
    : `Markdown front matter:\n${markdown.metadata.map(formatField).join("\n")}\n\nMarkdown body: ${page.markdown.body}\n\nMarkdown example:\n${page.markdown.example}\n`;
  return `${page.displayName} (${page.type})\n${page.summary}\n\nWorkspace (${page.workspace.directory}):\n  source rule           ${page.workspace.sourceRule}\n  pull                  ${page.workspace.pull}\n\n${markdownSection}.pm.json (${json.purpose})\n  data:\n${
    json.dataFields.map((field) => `    ${field}`).join("\n")
  }\n${page.document.note === undefined ? "" : `  ${page.document.note}\n`}\n.pm.json example:\n${
    JSON.stringify(page.document.example, null, 2)
  }\n\nWorkflow:\n${
    page.workflow.map((step) => `  ${step.command}: ${step.result}`).join("\n")
  }\n\nUse --json for the exact structure.\n`;
}
