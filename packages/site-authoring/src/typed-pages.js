import { FREE_FORM_TEMPLATE_VERSION, TEMPLATE_TYPE_FREE_FORM } from "./api.js";
import { isVideoEmbedId } from "./content/video-embed-url.js";
import { SiteAuthoringError } from "./errors.js";

/**
 * The authored page templates (TR00893).
 *
 * A page has one template for life, and each template has one *workspace
 * document*: the object every reader and writer in this package agrees on.
 * Free-form keeps its historical shape (the ProseMirror document itself). The
 * other templates use a small wrapper:
 *
 *     { "template": "recipe", "displayDate": "2024-05-01", "coverImageId": "…", "data": { … } }
 *
 * `pull` writes that wrapper, a Markdown source is converted into it, and
 * `pages push` turns it into the API's `PageTemplate`. Because all three meet
 * at the same object, a pull-edit-push cycle changes only what the agent
 * changed, and there is one place that knows each template's shape.
 *
 * `data` follows the API's field names (`Pages.proto`) so nothing needs a
 * translation table; the two deliberate differences are that defaults are
 * always written out (the API's JSON omits them, and a document that gained
 * and lost keys between reads would never be byte-stable) and that a place
 * review's rating uses the words an author writes.
 */

export const TEMPLATE_FREE_FORM = "free-form";
export const TEMPLATE_ARTICLE = "article";
export const TEMPLATE_RECIPE = "recipe";
export const TEMPLATE_ALBUM = "album";
export const TEMPLATE_PLACE_REVIEW = "place-review";

/** Wire identity and the `PageTemplate` member that carries each template's data. */
export const PAGE_TEMPLATES = Object.freeze({
  [TEMPLATE_FREE_FORM]: Object.freeze({ wireType: TEMPLATE_TYPE_FREE_FORM, dataKey: "freeFormData" }),
  [TEMPLATE_ARTICLE]: Object.freeze({ wireType: "TEMPLATE_TYPE_ARTICLE", dataKey: "articleData" }),
  [TEMPLATE_RECIPE]: Object.freeze({ wireType: "TEMPLATE_TYPE_RECIPE", dataKey: "recipeData" }),
  [TEMPLATE_ALBUM]: Object.freeze({ wireType: "TEMPLATE_TYPE_ALBUM", dataKey: "albumData" }),
  [TEMPLATE_PLACE_REVIEW]: Object.freeze({ wireType: "TEMPLATE_TYPE_PLACE_REVIEW", dataKey: "placeReviewData" }),
});

export const PAGE_TEMPLATE_NAMES = Object.freeze(Object.keys(PAGE_TEMPLATES));

/** Front-matter fields every template accepts. */
export const SHARED_FRONT_MATTER_KEYS = Object.freeze(["title", "path", "description", "template"]);

/**
 * The page-level fields the other templates add. A free-form page's source is
 * its bare document, which has nowhere to carry them, so it does not accept
 * them.
 */
const TYPED_PAGE_FRONT_MATTER_KEYS = Object.freeze(["displayDate", "coverImage"]);

/** Front-matter fields only one template accepts. Others are refused for it. */
const TEMPLATE_FRONT_MATTER_KEYS = Object.freeze({
  [TEMPLATE_FREE_FORM]: Object.freeze([]),
  // `place` is the Taproot place id an article or album is about (TR01003).
  [TEMPLATE_ARTICLE]: Object.freeze([...TYPED_PAGE_FRONT_MATTER_KEYS, "place"]),
  [TEMPLATE_RECIPE]: Object.freeze([
    ...TYPED_PAGE_FRONT_MATTER_KEYS,
    "prepTimeMinutes",
    "cookTimeMinutes",
    "servings",
    "recipeCategory",
    "recipeCuisine",
    "cookingMethod",
  ]),
  [TEMPLATE_ALBUM]: Object.freeze([...TYPED_PAGE_FRONT_MATTER_KEYS, "seamless", "borderWidth", "place"]),
  [TEMPLATE_PLACE_REVIEW]: Object.freeze([...TYPED_PAGE_FRONT_MATTER_KEYS, "placeId", "rating"]),
});

export const FRONT_MATTER_KEYS = Object.freeze(
  new Set([...SHARED_FRONT_MATTER_KEYS, ...Object.values(TEMPLATE_FRONT_MATTER_KEYS).flat()]),
);

/** The accepted front-matter fields for one template, for messages and help. */
export function frontMatterKeysFor(template) {
  return [...SHARED_FRONT_MATTER_KEYS, ...(TEMPLATE_FRONT_MATTER_KEYS[template] ?? [])];
}

export const PLACE_REVIEW_RATINGS = Object.freeze({
  "wont-return": "PLACE_REVIEW_RATING_WONT_RETURN",
  "might-return": "PLACE_REVIEW_RATING_MIGHT_RETURN",
  "will-return": "PLACE_REVIEW_RATING_WILL_RETURN",
});
const RATING_NAME_BY_WIRE = Object.freeze(
  Object.fromEntries(Object.entries(PLACE_REVIEW_RATINGS).map(([name, wire]) => [wire, name])),
);

// Not `isCanonicalUuid`: that accepts only RFC 4122 versions 1 to 5, and place
// and image ids are minted by the server, which is free to use any version.
const IDENTIFIER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** An id the server minted, of any UUID version. */
export const IMAGE_IDENTIFIER = IDENTIFIER;
const DISPLAY_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ALBUM_IMAGES_HEADING = "images";
const RECIPE_HEADINGS = Object.freeze(["ingredients", "instructions"]);

function fail(code, message, field) {
  return new SiteAuthoringError(code, message, { field });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ── Template identity ────────────────────────────────────────────────────────

/** The template name for a wire `templateType`, or `undefined` when it is not authorable here. */
export function templateNameForWireType(wireType) {
  return PAGE_TEMPLATE_NAMES.find((name) => PAGE_TEMPLATES[name].wireType === wireType);
}

/** Whether `pull` and `pages push` handle pages of this wire `templateType`. */
export function isAuthorableTemplateType(wireType) {
  return templateNameForWireType(wireType) !== undefined;
}

/** The template a canonical workspace document represents. */
export function documentTemplate(document_) {
  return isPlainObject(document_) && typeof document_.template === "string" && document_.type === undefined
    ? document_.template
    : TEMPLATE_FREE_FORM;
}

export function requireTemplateName(value, file) {
  if (typeof value === "string" && Object.hasOwn(PAGE_TEMPLATES, value)) return value;
  throw fail(
    "pages.template_unknown",
    `'${file}' declares template '${typeof value === "string" ? value : ""}'. Supported templates: `
      + `${PAGE_TEMPLATE_NAMES.join(", ")}.`,
    file,
  );
}

// ── Strict shape helpers (source documents) ──────────────────────────────────

function requireKeys(value, allowed, file, path) {
  if (!isPlainObject(value)) throw fail("pages.document_shape", `'${file}' ${path} must be an object.`, file);
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw fail(
      "pages.document_shape",
      `'${file}' ${path} has unsupported field '${unknown}'. Supported fields: ${allowed.join(", ")}.`,
      `${file}:${path}.${unknown}`,
    );
  }
  return value;
}

function requireString(value, file, path, { allowEmpty = true } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw fail(
      "pages.document_shape",
      `'${file}' ${path} must be ${allowEmpty ? "a string" : "a non-empty string"}.`,
      file,
    );
  }
  return value;
}

function requireCount(value, file, path, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw fail("pages.document_shape", `'${file}' ${path} must be an integer from 0 to ${maximum}.`, file);
  }
  return value;
}

function requireDocument(value, file, path, { nonEmpty = false } = {}) {
  if (!isPlainObject(value) || value.type !== "doc") {
    throw fail(
      "pages.document_shape",
      `'${file}' ${path} must be a ProseMirror document: an object with "type": "doc".`,
      file,
    );
  }
  // The server refuses an empty body only after earlier pages were sent, so the
  // same rule is applied here, before anything is.
  if (nonEmpty && (!Array.isArray(value.content) || value.content.length === 0)) {
    throw fail("pages.body_empty", `'${file}' ${path} has no content.`, file);
  }
  return value;
}

function requireArray(value, file, path) {
  if (!Array.isArray(value)) throw fail("pages.document_shape", `'${file}' ${path} must be a list.`, file);
  return value;
}

function requireIdentifier(value, file, path) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw fail("pages.document_shape", `'${file}' ${path} must be a UUID.`, file);
  }
  return value;
}

// The API parses the date as a .NET DateOnly, whose years run 0001 to 9999. The
// calendar is checked by hand because `Date` would accept year 0 and throws on
// a month of 13, which is a crash where a refusal is wanted.
function isCalendarDate(value) {
  if (typeof value !== "string" || !DISPLAY_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= daysInMonth;
}

export function requireDisplayDate(value, file) {
  if (value === "") return value;
  if (!isCalendarDate(value)) {
    throw fail(
      "pages.display_date_invalid",
      `'${file}' declares displayDate '${typeof value === "string" ? value : ""}', which is not a real calendar date. `
        + "Use YYYY-MM-DD, or leave the value empty to use the first publication date.",
      file,
    );
  }
  return value;
}

// ── Canonical data per template ──────────────────────────────────────────────

const INGREDIENT_KEYS = ["rawText", "quantity", "unit", "name", "parsed"];
const RECIPE_KEYS = [
  "introductionBody",
  "ingredientGroups",
  "instructionSections",
  "prepTimeMinutes",
  "cookTimeMinutes",
  "servings",
  "recipeCategory",
  "recipeCuisine",
  "cookingMethod",
];
const ALBUM_KEYS = ["introductionBody", "images", "seamless", "borderWidth", "place"];
const ALBUM_IMAGE_KEYS = ["imageId", "caption", "width", "height"];
const ALBUM_MAXIMUM_BORDER_WIDTH = 20;
const MAXIMUM_MINUTES = 100_000;
const MAXIMUM_SERVINGS = 10_000;

function definedEntries(entries) {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

function canonicalIngredient(value) {
  return {
    rawText: value.rawText,
    quantity: value.quantity ?? "",
    unit: value.unit ?? "",
    name: value.name ?? "",
    parsed: value.parsed === true,
  };
}

/**
 * Builds the canonical `data` object from either a source document (strict:
 * unknown fields are refused, because silently dropping an authored field is
 * how content disappears) or a page read from the site (lenient, since the
 * server's JSON omits defaults and may gain fields).
 */
const DATA_BUILDERS = Object.freeze({
  [TEMPLATE_ARTICLE]: (raw) => definedEntries([["body", raw.body], ["place", raw.place]]),
  [TEMPLATE_PLACE_REVIEW]: (raw) => ({ placeId: raw.placeId, rating: raw.rating, body: raw.body }),
  [TEMPLATE_ALBUM]: (raw) =>
    definedEntries([
      ["introductionBody", raw.introductionBody],
      [
        "images",
        raw.images.map((image) => ({
          imageId: image.imageId,
          caption: image.caption ?? "",
          width: image.width ?? 0,
          height: image.height ?? 0,
        })),
      ],
      ["seamless", raw.seamless],
      ["borderWidth", raw.borderWidth],
      ["place", raw.place],
    ]),
  [TEMPLATE_RECIPE]: (raw) =>
    definedEntries([
      ["introductionBody", raw.introductionBody],
      [
        "ingredientGroups",
        raw.ingredientGroups.map((group) => ({
          name: group.name ?? "",
          ingredients: group.ingredients.map(canonicalIngredient),
        })),
      ],
      [
        "instructionSections",
        raw.instructionSections.map((section) => ({
          name: section.name ?? "",
          stepBodies: section.stepBodies,
        })),
      ],
      ["prepTimeMinutes", raw.prepTimeMinutes ?? 0],
      ["cookTimeMinutes", raw.cookTimeMinutes ?? 0],
      ["servings", raw.servings ?? 0],
      ["recipeCategory", raw.recipeCategory ?? ""],
      ["recipeCuisine", raw.recipeCuisine ?? ""],
      ["cookingMethod", raw.cookingMethod ?? ""],
    ]),
});

const OPTIONAL_INTRODUCTION = (value, file, path) =>
  value === undefined ? undefined : requireDocument(value, file, path);

/** A Taproot place id, or "" to clear the page's place; omitted leaves it as the site holds it. */
function optionalPlace(value, file, path) {
  if (value === undefined || value === "") return value;
  requireIdentifier(value, file, path);
  return value;
}

/** Strict checks on a source document's `data`, returning it in canonical form. */
function canonicalSourceData(template, data, file) {
  const path = "data";
  if (template === TEMPLATE_ARTICLE) {
    requireKeys(data, ["body", "place"], file, path);
    return DATA_BUILDERS[template]({
      body: requireDocument(data.body, file, `${path}.body`, { nonEmpty: true }),
      place: optionalPlace(data.place, file, `${path}.place`),
    });
  }
  if (template === TEMPLATE_PLACE_REVIEW) {
    requireKeys(data, ["placeId", "rating", "body"], file, path);
    requireIdentifier(data.placeId, file, `${path}.placeId`);
    if (!Object.hasOwn(PLACE_REVIEW_RATINGS, data.rating)) {
      throw fail(
        "pages.document_shape",
        `'${file}' ${path}.rating must be one of ${Object.keys(PLACE_REVIEW_RATINGS).join(", ")}.`,
        file,
      );
    }
    return DATA_BUILDERS[template]({
      ...data,
      body: requireDocument(data.body, file, `${path}.body`, { nonEmpty: true }),
    });
  }
  if (template === TEMPLATE_ALBUM) {
    requireKeys(data, ALBUM_KEYS, file, path);
    const images = requireArray(data.images, file, `${path}.images`);
    if (images.length === 0) {
      throw fail("pages.album_images_missing", `'${file}' is an album with no images.`, file);
    }
    images.forEach((image, index) => {
      const at = `${path}.images[${index}]`;
      requireKeys(image, ALBUM_IMAGE_KEYS, file, at);
      requireIdentifier(image.imageId, file, `${at}.imageId`);
      if (image.caption !== undefined) requireString(image.caption, file, `${at}.caption`);
      if (image.width !== undefined) requireCount(image.width, file, `${at}.width`, 100_000);
      if (image.height !== undefined) requireCount(image.height, file, `${at}.height`, 100_000);
    });
    if (data.seamless !== undefined && typeof data.seamless !== "boolean") {
      throw fail("pages.document_shape", `'${file}' ${path}.seamless must be true or false.`, file);
    }
    if (data.borderWidth !== undefined) {
      requireCount(data.borderWidth, file, `${path}.borderWidth`, ALBUM_MAXIMUM_BORDER_WIDTH);
    }
    return DATA_BUILDERS[template]({
      ...data,
      introductionBody: OPTIONAL_INTRODUCTION(data.introductionBody, file, `${path}.introductionBody`),
      place: optionalPlace(data.place, file, `${path}.place`),
    });
  }
  requireKeys(data, RECIPE_KEYS, file, path);
  const ingredientGroups = requireArray(data.ingredientGroups, file, `${path}.ingredientGroups`);
  ingredientGroups.forEach((group, groupIndex) => {
    const at = `${path}.ingredientGroups[${groupIndex}]`;
    requireKeys(group, ["name", "ingredients"], file, at);
    if (group.name !== undefined) requireString(group.name, file, `${at}.name`);
    requireArray(group.ingredients, file, `${at}.ingredients`).forEach((ingredient, index) => {
      const ingredientAt = `${at}.ingredients[${index}]`;
      requireKeys(ingredient, INGREDIENT_KEYS, file, ingredientAt);
      requireString(ingredient.rawText, file, `${ingredientAt}.rawText`, { allowEmpty: false });
      for (const key of ["quantity", "unit", "name"]) {
        if (ingredient[key] !== undefined) requireString(ingredient[key], file, `${ingredientAt}.${key}`);
      }
      if (ingredient.parsed !== undefined && typeof ingredient.parsed !== "boolean") {
        throw fail("pages.document_shape", `'${file}' ${ingredientAt}.parsed must be true or false.`, file);
      }
    });
  });
  const instructionSections = requireArray(data.instructionSections, file, `${path}.instructionSections`);
  instructionSections.forEach((section, sectionIndex) => {
    const at = `${path}.instructionSections[${sectionIndex}]`;
    requireKeys(section, ["name", "stepBodies"], file, at);
    if (section.name !== undefined) requireString(section.name, file, `${at}.name`);
    requireArray(section.stepBodies, file, `${at}.stepBodies`).forEach((step, index) =>
      requireDocument(step, file, `${at}.stepBodies[${index}]`, { nonEmpty: true })
    );
  });
  const hasIngredient = ingredientGroups.some((group) => group.ingredients.length > 0);
  const hasStep = instructionSections.some((section) => section.stepBodies.length > 0);
  if (!hasIngredient || !hasStep) {
    throw fail(
      "pages.recipe_incomplete",
      `'${file}' is a recipe, which needs at least one ingredient and one instruction step.`,
      file,
    );
  }
  if (data.prepTimeMinutes !== undefined) {
    requireCount(data.prepTimeMinutes, file, `${path}.prepTimeMinutes`, MAXIMUM_MINUTES);
  }
  if (data.cookTimeMinutes !== undefined) {
    requireCount(data.cookTimeMinutes, file, `${path}.cookTimeMinutes`, MAXIMUM_MINUTES);
  }
  if (data.servings !== undefined) requireCount(data.servings, file, `${path}.servings`, MAXIMUM_SERVINGS);
  for (const key of ["recipeCategory", "recipeCuisine", "cookingMethod"]) {
    if (data[key] !== undefined) requireString(data[key], file, `${path}.${key}`);
  }
  return DATA_BUILDERS[template]({
    ...data,
    introductionBody: OPTIONAL_INTRODUCTION(data.introductionBody, file, `${path}.introductionBody`),
  });
}

/**
 * The canonical workspace document for a typed page, with keys in one fixed
 * order. The order is part of the byte-stability contract.
 */
function typedDocument(template, { displayDate, coverImageId, data }) {
  return {
    template,
    ...(displayDate === undefined ? {} : { displayDate }),
    ...(coverImageId === undefined ? {} : { coverImageId }),
    data,
  };
}

/** Validates a parsed `.pm.json` that declares a template, and returns its canonical form. */
export function typedDocumentFromJson(parsed, file) {
  requireKeys(parsed, ["template", "displayDate", "coverImageId", "data"], file, "document");
  const template = requireTemplateName(parsed.template, file);
  if (template === TEMPLATE_FREE_FORM) {
    throw fail(
      "pages.document_shape",
      `'${file}' declares the free-form template, whose source is the ProseMirror document itself, `
        + "not a wrapper.",
      file,
    );
  }
  const displayDate = parsed.displayDate === undefined ? undefined : requireDisplayDate(parsed.displayDate, file);
  let coverImageId;
  if (parsed.coverImageId !== undefined) {
    coverImageId = parsed.coverImageId === "" ? "" : requireIdentifier(parsed.coverImageId, file, "coverImageId");
  }
  return typedDocument(template, {
    displayDate,
    coverImageId,
    data: canonicalSourceData(template, parsed.data, file),
  });
}

// ── The site's page → the workspace document (pull) ──────────────────────────

const ratingName = (wire) => RATING_NAME_BY_WIRE[wire];
const presentDocument = (value) => (isPlainObject(value) && value.type === "doc" ? value : undefined);
// The site answers a missing introduction with an empty document, so an empty
// one reads as "no introduction". Keeping it would make an authored page and
// its own pulled copy differ.
const presentIntroduction = (value) => {
  const doc = presentDocument(value);
  return doc !== undefined && Array.isArray(doc.content) && doc.content.length === 0 ? undefined : doc;
};
const listOf = (value) => (Array.isArray(value) ? value : []);
// The site stores a page's place with its name and address; the workspace keeps only the id.
const pagePlaceId = (value) =>
  isPlainObject(value) && typeof value.placeId === "string" && value.placeId !== "" ? value.placeId : undefined;

/** Lenient projections of what the site returned for each template's data. */
const PAGE_PROJECTIONS = Object.freeze({
  [TEMPLATE_ARTICLE]: (raw) => {
    const body = presentDocument(raw.body);
    return body === undefined ? undefined : DATA_BUILDERS[TEMPLATE_ARTICLE]({ body, place: pagePlaceId(raw.place) });
  },
  [TEMPLATE_PLACE_REVIEW]: (raw) => {
    const body = presentDocument(raw.body);
    const rating = ratingName(raw.rating);
    if (body === undefined || rating === undefined || typeof raw.placeId !== "string") return undefined;
    return DATA_BUILDERS[TEMPLATE_PLACE_REVIEW]({ placeId: raw.placeId, rating, body });
  },
  [TEMPLATE_ALBUM]: (raw) =>
    DATA_BUILDERS[TEMPLATE_ALBUM]({
      introductionBody: presentIntroduction(raw.introductionBody),
      images: listOf(raw.images).filter((image) => isPlainObject(image) && typeof image.imageId === "string"),
      seamless: typeof raw.seamless === "boolean" ? raw.seamless : undefined,
      borderWidth: Number.isSafeInteger(raw.borderWidth) ? raw.borderWidth : undefined,
      place: pagePlaceId(raw.place),
    }),
  [TEMPLATE_RECIPE]: (raw) =>
    DATA_BUILDERS[TEMPLATE_RECIPE]({
      ...raw,
      introductionBody: presentIntroduction(raw.introductionBody),
      ingredientGroups: listOf(raw.ingredientGroups).filter(isPlainObject).map((group) => ({
        name: group.name,
        ingredients: listOf(group.ingredients).filter((item) =>
          isPlainObject(item) && typeof item.rawText === "string"
        ),
      })),
      instructionSections: listOf(raw.instructionSections).filter(isPlainObject).map((section) => ({
        name: section.name,
        stepBodies: listOf(section.stepBodies).map(presentDocument).filter((step) => step !== undefined),
      })),
    }),
});

/**
 * The workspace document for a page read from the site, or `undefined` when the
 * read carries nothing this package can represent. Free-form pages keep their
 * bare body exactly as stored: the server never validates it, and a body this
 * package would refuse to push is still the site's, so pull must not hide it.
 * The listing's template type stands in when the read does not state one.
 */
export function workspaceDocumentFromPage(page, listedTemplateType) {
  const template = page?.template;
  if (!isPlainObject(template)) return undefined;
  const name = templateNameForWireType(template.templateType ?? listedTemplateType);
  if (name === undefined) return undefined;
  const raw = template[PAGE_TEMPLATES[name].dataKey];
  if (!isPlainObject(raw)) return undefined;
  if (name === TEMPLATE_FREE_FORM) return isPlainObject(raw.body) ? raw.body : undefined;
  const data = PAGE_PROJECTIONS[name](raw);
  if (data === undefined) return undefined;
  return typedDocument(name, {
    displayDate: typeof page.displayDate === "string" && page.displayDate !== "" ? page.displayDate : undefined,
    coverImageId: typeof page.coverImageId === "string" && page.coverImageId !== "" ? page.coverImageId : undefined,
    data,
  });
}

// ── The workspace document → the wire (push) ─────────────────────────────────

/** Every ProseMirror document in a workspace document, with where it sits, for validation. */
export function contentDocuments(document_) {
  const template = documentTemplate(document_);
  if (template === TEMPLATE_FREE_FORM) return [{ doc: document_, path: "" }];
  const { data } = document_;
  const found = [];
  const add = (doc, path, options = {}) => {
    if (doc !== undefined) found.push({ doc, path, ...options });
  };
  add(data.body, "data.body");
  // The server accepts an empty introduction (the editor saves one for every
  // recipe and album that has none), so it is validated but may be blank. It,
  // and every recipe step, also accepts a narrower set of nodes than a body.
  add(data.introductionBody, "data.introductionBody", { mayBeEmpty: true, restricted: true });
  for (const [sectionIndex, section] of (data.instructionSections ?? []).entries()) {
    for (const [stepIndex, step] of section.stepBodies.entries()) {
      add(step, `data.instructionSections[${sectionIndex}].stepBodies[${stepIndex}]`, { restricted: true });
    }
  }
  return found;
}

/** Whether a push sends `displayDate` for pages of this wire template type (every template but free-form). */
export function sentDisplayDate(wireType) {
  const name = templateNameForWireType(wireType);
  return name !== undefined && name !== TEMPLATE_FREE_FORM;
}

// The nodes the API accepts in an album or recipe introduction and in a recipe
// step (`MembershipTermsDocumentRules.AllowedNodeTypes`). A page body accepts
// more, such as `section` and `inlineFacts`, so a document valid as a body can
// still be refused there, after earlier pages have been saved.
const RESTRICTED_NODE_TYPES = new Set([
  "doc",
  "paragraph",
  "text",
  "hardBreak",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "taprootImage",
  "componentBlock",
  "table",
]);

/**
 * The first node type in `doc` that a restricted document (an introduction or a
 * recipe step) cannot hold, or `undefined`. A table is allowed only directly
 * under the document root; the content validator already checks its cells.
 */
export function unsupportedRestrictedNode(doc) {
  const visit = (node, parentType) => {
    if (!isPlainObject(node)) return undefined;
    if (!RESTRICTED_NODE_TYPES.has(node.type) || (node.type === "table" && parentType !== "doc")) return node.type;
    if (node.type === "table") return undefined;
    for (const child of Array.isArray(node.content) ? node.content : []) {
      const unsupported = visit(child, node.type);
      if (unsupported !== undefined) return unsupported;
    }
    return undefined;
  };
  return visit(doc, undefined);
}

/**
 * The API's wording when a selected cover image is not one of the page's own
 * images (`CreatePagePipelineHandlerBase`, `UpdatePagePipelineHandlerBase`).
 * Kept identical so the CLI's refusal and the server's read the same.
 */
export const COVER_IMAGE_UNUSED_MESSAGE = "The selected cover image must be used by this page.";

/**
 * Every image id the page uses, the way the API's `PageImageReferenceExtractor`
 * counts them: album images, and any image node, section background or
 * decoration, integration fragment or component data inside its documents.
 * Read loosely (every `imageId` and `imageIds` value) because a cover the CLI
 * wrongly thinks unused would be refused for nothing, and the server has the
 * final say.
 */
/**
 * The parsed JSON of a `componentData` string, or `undefined` when it is not
 * JSON. The server decodes HTML entities (up to three rounds) before reading
 * component JSON, so a string that only parses once decoded is read the way the
 * server reads it.
 */
function parseComponentData(text) {
  let decoded = text;
  for (let round = 0; round < 3 && /&(?:quot|amp|#39|lt|gt);/u.test(decoded); round += 1) {
    decoded = decoded.replace(/&quot;/gu, "\"").replace(/&#39;/gu, "'").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">")
      .replace(/&amp;/gu, "&");
  }
  for (const candidate of [text, decoded]) {
    try {
      return JSON.parse(candidate);
    } catch { /* not JSON: try the decoded form, then nothing to read */ }
  }
  return undefined;
}

export function usedImageIds(document_) {
  const found = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (key === "imageId" && typeof child === "string") found.add(child.toLowerCase());
        else if (key === "imageIds" && Array.isArray(child)) {
          child.filter((id) => typeof id === "string").forEach((id) => found.add(id.toLowerCase()));
        } else if (key === "componentData" && typeof child === "string") {
          const parsed = parseComponentData(child);
          if (parsed !== undefined) visit(parsed);
        } else visit(child);
      }
    }
  };
  for (const { doc } of contentDocuments(document_)) visit(doc);
  for (const image of document_.data?.images ?? []) found.add(image.imageId.toLowerCase());
  return found;
}

/**
 * Every video id the page places: the `videoId` of each `video` component block
 * in any of its documents. Block-scoped on purpose — a `videoId` anywhere else
 * is author prose, not a reference the publisher resolves.
 */
export function placedVideoIds(document_) {
  const found = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (isPlainObject(value)) {
      if (value.type === "componentBlock" && isPlainObject(value.attrs) && value.attrs.componentType === "video") {
        const data = typeof value.attrs.componentData === "string"
          ? parseComponentData(value.attrs.componentData)
          : undefined;
        if (isPlainObject(data) && typeof data.videoId === "string") found.add(data.videoId.toLowerCase());
        return;
      }
      Object.values(value).forEach(visit);
    }
  };
  for (const { doc } of contentDocuments(document_)) visit(doc);
  return found;
}

/**
 * The `video-embed` blocks in any of the page's documents that name a video and
 * hold no poster, each with a way to set one. `pages push` copies the provider's
 * thumbnail into the site's images for these (TR01109). Block-scoped like
 * `placedVideoIds`.
 */
export function posterlessVideoEmbeds(document_) {
  const found = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (isPlainObject(value)) {
      if (value.type === "componentBlock" && isPlainObject(value.attrs) && value.attrs.componentType === "video-embed") {
        const data = typeof value.attrs.componentData === "string"
          ? parseComponentData(value.attrs.componentData)
          : undefined;
        if (isPlainObject(data) && (data.poster === undefined || data.poster === null)
          && isVideoEmbedId(data.provider, data.videoId)) {
          found.push({
            provider: data.provider,
            videoId: data.videoId,
            setPoster: (poster) => {
              value.attrs.componentData = JSON.stringify({ ...data, poster });
            },
          });
        }
        return;
      }
      Object.values(value).forEach(visit);
    }
  };
  for (const { doc } of contentDocuments(document_)) visit(doc);
  return found;
}

/** The selected cover image when the page does not use it, else `undefined`. */
export function unusedCoverImageId(document_) {
  if (documentTemplate(document_) === TEMPLATE_FREE_FORM) return undefined;
  const cover = document_.coverImageId;
  return typeof cover === "string" && cover !== "" && !usedImageIds(document_).has(cover.toLowerCase()) ? cover : undefined;
}

/** The image ids a typed document references directly: its cover and its album images. */
export function documentImageIds(document_) {
  if (documentTemplate(document_) === TEMPLATE_FREE_FORM) return [];
  return [
    ...(document_.coverImageId ? [document_.coverImageId] : []),
    ...(document_.data.images ?? []).map((image) => image.imageId),
  ];
}

/** The API `PageTemplate` for a workspace document. */
export function wireTemplate(document_) {
  const template = documentTemplate(document_);
  const { wireType, dataKey } = PAGE_TEMPLATES[template];
  const data = template === TEMPLATE_FREE_FORM
    ? { body: document_ }
    : template === TEMPLATE_PLACE_REVIEW
    ? { ...document_.data, rating: PLACE_REVIEW_RATINGS[document_.data.rating] }
    : document_.data.place === undefined
    ? document_.data
    : { ...document_.data, place: { placeId: document_.data.place } };
  return { templateType: wireType, templateVersion: FREE_FORM_TEMPLATE_VERSION, [dataKey]: data };
}

/**
 * The page-level fields beside the template. Omitted means "leave as it is" on
 * an update, and an empty string means "clear", which is what the API does.
 */
export function wirePageFields(document_) {
  if (documentTemplate(document_) === TEMPLATE_FREE_FORM) return {};
  return definedEntries([
    ["displayDate", document_.displayDate],
    ["coverImageId", document_.coverImageId],
  ]);
}

// ── Markdown sources ─────────────────────────────────────────────────────────

const FENCE = /^\s{0,3}(```|~~~)/u;
const H2 = /^##[ \t]+(.+?)[ \t]*#*[ \t]*$/u;
const H3 = /^###[ \t]+(.+?)[ \t]*#*[ \t]*$/u;
const BULLET = /^[-*+][ \t]+(.*)$/u;
const STEP = /^(?:\d{1,3}[.)]|[-*+])[ \t]+(.*)$/u;
const IMAGE_LINE = /^!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)$/u;
const CONTINUATION = /^(?: {2,}|\t)/u;

/** Splits a body at its level-2 headings, ignoring anything inside a code fence. */
function splitSections(markdown) {
  const lead = [];
  const sections = [];
  let current;
  let fence;
  for (const line of markdown.split(/\r?\n/u)) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch !== null) {
      if (fence === undefined) fence = fenceMatch[1];
      else if (fenceMatch[1] === fence) fence = undefined;
    }
    const heading = fence === undefined && fenceMatch === null ? H2.exec(line) : null;
    if (heading !== null) {
      current = { title: heading[1].trim(), lines: [] };
      sections.push(current);
    } else {
      (current?.lines ?? lead).push(line);
    }
  }
  return { lead: lead.join("\n"), sections };
}

function requireSectionTitles(sections, expected, file, template) {
  const titles = sections.map((section) => section.title.toLowerCase());
  const unknown = sections.find((section) => !expected.includes(section.title.toLowerCase()));
  if (
    unknown !== undefined || titles.length !== expected.length
    || expected.some((title, index) => titles[index] !== title)
  ) {
    const names = expected.map((title) => `'## ${title[0].toUpperCase()}${title.slice(1)}'`).join(" then ");
    throw fail(
      `pages.${template}_sections_invalid`,
      `'${file}' is ${template === TEMPLATE_ALBUM ? "an" : "a"} ${template}, whose body is an introduction followed by `
        + `${names}. ${
          unknown === undefined ? "" : `The heading '## ${unknown.title}' is not part of that shape; `
            + "move that text into the introduction so nothing is dropped. "
        }Found: ${
          sections.length === 0 ? "no ## headings" : sections.map((section) => `'## ${section.title}'`).join(", ")
        }.`,
      file,
    );
  }
}

/** Removes up to `width` leading spaces (or one tab) from a step's continuation line. */
function dedent(line, width) {
  if (line.startsWith("\t")) return line.slice(1);
  let removed = 0;
  while (removed < width && line[removed] === " ") removed += 1;
  return line.slice(removed);
}

function groupedLines(lines, file, template, itemPattern, describe) {
  const groups = [{ name: "", items: [] }];
  let step;
  // How far the open item's marker pushes its text in ("1. " is 3), which is
  // how far its continuation lines are indented. Removing exactly that much
  // keeps the relative indentation of nested lists and code inside the step.
  let markerWidth = 0;
  let blanks = 0;
  const closeStep = () => {
    if (step !== undefined) groups.at(-1).items.push(step.join("\n"));
    step = undefined;
  };
  let fence;
  for (const line of lines) {
    const insideFence = fence !== undefined;
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch !== null && fence === undefined) fence = fenceMatch[1];
    else if (fenceMatch !== null && fenceMatch[1] === fence) fence = undefined;
    if (line.trim() === "") {
      blanks += 1;
      continue;
    }
    // A fence, and everything inside it, belongs to the step that holds it: its
    // lines are code, not list items or headings, whatever they start with.
    if ((insideFence || fenceMatch !== null) && step !== undefined) {
      for (let index = 0; index < blanks; index += 1) step.push("");
      step.push(dedent(line, markerWidth));
      blanks = 0;
      continue;
    }
    const group = H3.exec(line);
    if (group !== null) {
      closeStep();
      groups.push({ name: group[1].trim(), items: [] });
      blanks = 0;
      continue;
    }
    const item = itemPattern.exec(line);
    if (item !== null) {
      closeStep();
      step = [item[1]];
      markerWidth = line.length - item[1].length;
      blanks = 0;
      continue;
    }
    const continuation = step === undefined ? null : CONTINUATION.exec(line);
    if (continuation !== null) {
      for (let index = 0; index < blanks; index += 1) step.push("");
      step.push(dedent(line, markerWidth));
      blanks = 0;
      continue;
    }
    throw fail(
      `pages.${template}_section_invalid`,
      `'${file}' has a line in ${describe} that is not a list item or a '### group' heading: `
        + `'${line.trim().slice(0, 80)}'.`,
      file,
    );
  }
  closeStep();
  return groups.filter((group) => group.items.length > 0 || group.name !== "");
}

async function parseRecipeBody(markdown, { file, convert }) {
  const { lead, sections } = splitSections(markdown);
  requireSectionTitles(sections, RECIPE_HEADINGS, file, TEMPLATE_RECIPE);
  const ingredientGroups = groupedLines(sections[0].lines, file, TEMPLATE_RECIPE, BULLET, "the Ingredients section")
    .map((group) => ({
      name: group.name,
      ingredients: group.items.map((rawText) => ({ rawText: rawText.trim() })),
    }))
    .filter((group) => group.ingredients.length > 0);
  const instructionSections = [];
  for (
    const group of groupedLines(sections[1].lines, file, TEMPLATE_RECIPE, STEP, "the Instructions section")
  ) {
    const stepBodies = [];
    for (const text of group.items) stepBodies.push(await convert(text));
    if (stepBodies.length > 0) instructionSections.push({ name: group.name, stepBodies });
  }
  return {
    introductionBody: lead.trim() === "" ? undefined : await convert(lead),
    ingredientGroups,
    instructionSections,
  };
}

async function parseAlbumBody(markdown, { file, convert, resolveImage }) {
  const { lead, sections } = splitSections(markdown);
  requireSectionTitles(sections, [ALBUM_IMAGES_HEADING], file, TEMPLATE_ALBUM);
  const images = [];
  for (const line of sections[0].lines) {
    if (line.trim() === "") continue;
    const match = IMAGE_LINE.exec(line.trim());
    if (match === null) {
      throw fail(
        "pages.album_section_invalid",
        `'${file}' has a line in the Images section that is not '![caption](media/file.jpg)': `
          + `'${line.trim().slice(0, 80)}'.`,
        file,
      );
    }
    const image = await resolveImage(match[2]);
    images.push({ imageId: image.imageId, caption: match[1], width: image.width, height: image.height });
  }
  if (images.length === 0) {
    throw fail("pages.album_images_missing", `'${file}' is an album whose Images section lists no images.`, file);
  }
  return { introductionBody: lead.trim() === "" ? undefined : await convert(lead), images };
}

function parseCount(fields, key, file, maximum) {
  if (!fields.has(key)) return undefined;
  const value = fields.get(key);
  if (!/^\d{1,6}$/u.test(value) || Number(value) > maximum) {
    throw fail(
      "pages.front_matter_value_invalid",
      `'${file}' declares ${key} '${value}', which must be a whole number from 0 to ${maximum}.`,
      key,
    );
  }
  return Number(value);
}

function parseFlag(fields, key, file) {
  if (!fields.has(key)) return undefined;
  const value = fields.get(key);
  if (value !== "true" && value !== "false") {
    throw fail(
      "pages.front_matter_value_invalid",
      `'${file}' declares ${key} '${value}', which must be true or false.`,
      key,
    );
  }
  return value === "true";
}

/**
 * Front-matter fields the declared template does not accept.
 *
 * Kept separate from the parse so the fault is recorded against the file the
 * way every other metadata fault is, and so the message can name what the
 * template *does* accept.
 */
export function templateFrontMatterFault(template, fieldNames, file) {
  const accepted = frontMatterKeysFor(template);
  const stray = fieldNames.find((name) => !accepted.includes(name));
  return stray === undefined
    ? undefined
    : fail(
      "pages.front_matter_unknown",
      `'${file}' declares '${stray}', which the ${template} template does not accept. `
        + `Supported fields: ${accepted.join(", ")}.`,
      stray,
    );
}

/**
 * Converts a Markdown source into its canonical workspace document.
 *
 * `convert` turns Markdown into a ProseMirror document and `resolveImage` maps
 * a media reference through the media manifest; both are injected so this
 * module stays pure.
 */
export async function typedDocumentFromMarkdown({ template, fields, markdown, file, convert, resolveImage }) {
  const displayDate = fields.has("displayDate") ? requireDisplayDate(fields.get("displayDate"), file) : undefined;
  let coverImageId;
  if (fields.has("coverImage")) {
    const reference = fields.get("coverImage");
    coverImageId = reference === "" ? "" : (await resolveImage(reference)).imageId;
  }
  let data;
  if (template === TEMPLATE_ARTICLE) {
    data = { body: await convert(markdown), place: fields.get("place") };
  } else if (template === TEMPLATE_PLACE_REVIEW) {
    const placeId = fields.get("placeId");
    const rating = fields.get("rating");
    if (placeId === undefined || rating === undefined) {
      throw fail(
        "pages.place_review_invalid",
        `'${file}' is a place review, so its front matter must declare placeId (the Taproot place's id) and rating `
          + `(${Object.keys(PLACE_REVIEW_RATINGS).join(", ")}).`,
        file,
      );
    }
    data = { placeId, rating, body: await convert(markdown) };
  } else if (template === TEMPLATE_ALBUM) {
    data = {
      ...(await parseAlbumBody(markdown, { file, convert, resolveImage })),
      seamless: parseFlag(fields, "seamless", file),
      borderWidth: parseCount(fields, "borderWidth", file, ALBUM_MAXIMUM_BORDER_WIDTH),
      place: fields.get("place"),
    };
  } else {
    data = {
      ...(await parseRecipeBody(markdown, { file, convert })),
      prepTimeMinutes: parseCount(fields, "prepTimeMinutes", file, MAXIMUM_MINUTES),
      cookTimeMinutes: parseCount(fields, "cookTimeMinutes", file, MAXIMUM_MINUTES),
      servings: parseCount(fields, "servings", file, MAXIMUM_SERVINGS),
      recipeCategory: fields.get("recipeCategory"),
      recipeCuisine: fields.get("recipeCuisine"),
      cookingMethod: fields.get("cookingMethod"),
    };
  }
  // The same strict pass a `.pm.json` source gets, so a Markdown source and a
  // pulled document are held to one definition of "valid".
  return typedDocumentFromJson(
    {
      template,
      ...definedEntries([["displayDate", displayDate], ["coverImageId", coverImageId]]),
      data: withoutUndefined(data),
    },
    file,
  );
}

function withoutUndefined(value) {
  return definedEntries(Object.entries(value));
}
