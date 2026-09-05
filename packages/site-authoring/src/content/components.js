// Espalier 4.2 exposes this registry value only through its root component,
// whose import also registers `esp-root`. Replace this with the side-effect-free
// shared registry export when Espalier publishes that package subpath.
import { BUILT_IN_IMAGE_TEXTURES } from "@taprootio/espalier/root";
import { hasAsciiControl } from "../errors.js";
import {
  CONTENT_ERROR_CODES as CODES,
  CONTENT_LIMITS,
  contentError,
  identifier,
  isPlainObject,
  isSafeUrl,
  isUuid,
  pointerSegment,
} from "./vocabulary.js";

/**
 * The eight canonical `componentBlock` data shapes. Seven remain mirrored
 * field for field from the browser component templates; `hero-section` is the
 * pre-adoption replacement owned here and by the published renderer.
 *
 * `componentBlock.attrs.componentData` is a JSON **string**, not an object.
 * Nothing on the server looks inside it: the renderer copies it verbatim into a
 * `data-component-data` attribute and the generator's component renderer reads
 * whatever fields it finds, defaulting anything missing and ignoring anything
 * unknown. A typo'd enum value therefore publishes as a component silently
 * rendered with the wrong layout, and a typo'd field name publishes as a
 * component silently rendered with none of the author's content — which is why
 * these tables exist and why unknown fields are refused.
 *
 * Two deliberate asymmetries:
 *
 * - **Absent optional fields are accepted.** The component registry supplies
 *   their initial/default values. Fields explicitly marked required (the hero
 *   title and primary action, plus required nested image/action keys) fail when
 *   absent.
 * - **A present field is checked strictly**, including nested objects and array
 *   items, because a present-but-wrong value is exactly what renders wrong.
 *
 * Field order in each table is the interface's declaration order, and it is
 * the order `canonicalizeComponentData` serialises in.
 */

const MAX_ITEMS = 100;
const LATEST_POST_PAGE_TYPES = Object.freeze([
  "TEMPLATE_TYPE_ARTICLE",
  "TEMPLATE_TYPE_ALBUM",
  "TEMPLATE_TYPE_RECIPE",
  "TEMPLATE_TYPE_PLACE_REVIEW",
  "TEMPLATE_TYPE_FREE_FORM",
]);
const REGISTERED_TEXTURE_NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

const str = (options = {}) => Object.freeze({ kind: "string", ...options });
const bool = () => Object.freeze({ kind: "boolean" });
const num = (options = {}) => Object.freeze({ kind: "number", ...options });
const enumOf = (...values) => Object.freeze({ kind: "enum", values: Object.freeze(values) });
const list = (item) => Object.freeze({ kind: "array", item });
const shape = (fields, options = {}) => Object.freeze({ kind: "object", fields: Object.freeze(fields), ...options });
const image = () => Object.freeze({ kind: "image" });
const safeUrl = (options = {}) => Object.freeze({ kind: "safe-url", ...options });
const actionUrl = () => Object.freeze({ kind: "action-url" });
const textureName = () => Object.freeze({ kind: "texture-name", maximumLength: 64 });
const withOmission = (spec, whenOmitted) => Object.freeze({ ...spec, whenOmitted: Object.freeze(whenOmitted) });

/**
 * `ComponentImageData`. `src` and `urls` are the only required-by-key fields
 * anywhere in these tables: `PageImageDeliveryRewriter.ReplaceUrlFields` walks
 * the parsed component data and rewrites `src`/`url`/`urls` **only where the
 * key already exists**, so an image object without them keeps whatever the
 * author wrote — or, far more often, renders blank. `imageId` is required for
 * the same reason: `TryResolveImageId` needs it to find the delivery source at
 * all.
 */
const COMPONENT_IMAGE_FIELDS = Object.freeze({
  imageId: Object.freeze({ kind: "uuid", required: true }),
  src: Object.freeze({ kind: "string", required: true, missingCode: CODES.imageKeys }),
  urls: Object.freeze({
    kind: "array",
    required: true,
    missingCode: CODES.imageKeys,
    item: shape({
      minWidth: num({ integer: true, minimum: 1 }),
      url: str(),
    }),
  }),
  // Zero is allowed here, unlike on a `taprootImage` node: the editor's
  // `uploadComponentImage` falls back to `width: 0` when the processed image
  // has not reported its dimensions yet, and refusing that would refuse a
  // pulled document on its way back.
  width: num({ integer: true, minimum: 0 }),
  height: num({ integer: true, minimum: 0 }),
  alt: str(),
});

/**
 * `CropState` — persisted so the crop dialog can reopen across sessions. The
 * four crop-region fields are optional in the interface (absent when the user
 * uploaded but cancelled the crop), and the whole object is nullable.
 */
const CROP_STATE = shape({
  originalSrc: str(),
  originalWidth: num({ integer: true, minimum: 0 }),
  originalHeight: num({ integer: true, minimum: 0 }),
  cropX: num({ minimum: 0, maximum: 1 }),
  cropY: num({ minimum: 0, maximum: 1 }),
  cropWidth: num({ minimum: 0, maximum: 1 }),
  cropHeight: num({ minimum: 0, maximum: 1 }),
}, { nullable: true });

const HERO_ACTION = shape({
  label: str({ required: true, nonWhitespace: true }),
  url: safeUrl({ required: true, allowEmpty: false }),
});

/** The pre-adoption `HeroSectionData` replacement. */
const HERO_SECTION = Object.freeze({
  overline: str(),
  title: str({ required: true, nonWhitespace: true }),
  titleSize: enumOf("normal", "display"),
  lead: str(),
  primaryAction: Object.freeze({ ...HERO_ACTION, required: true }),
  secondaryAction: Object.freeze({ ...HERO_ACTION, nullable: true }),
  alignment: enumOf("start", "center"),
  media: image(),
  mediaArrangement: enumOf("split", "stacked"),
  mediaPosition: enumOf("before", "after"),
  mediaWidth: enumOf("narrow", "equal", "wide"),
});

/**
 * `CtaData`.
 *
 * `variant` narrowed from five values to `primary|danger` at the Espalier 3
 * cutover, which retired the token re-seeding the three geometric values
 * (`analogous-left`, `analogous-right`, `complementary`) depended on. Pages
 * authored earlier may still store one: the generator's component renderer
 * misses it in its own allowlist and emits no attribute at all, so the
 * section publishes as the plain default rather than failing.
 *
 * Authoring one is refused here, and deliberately so. Pulling a pre-cutover
 * page and pushing it back unchanged fails loudly on this field instead of
 * silently rewriting a value the author never touched; the fix is to set a
 * current value, which is also what the editor does on its next save.
 */
const CTA = Object.freeze({
  heading: str(),
  description: str(),
  buttonText: str(),
  buttonUrl: actionUrl(),
  variant: enumOf("primary", "danger"),
  borderWidth: num({
    integer: true,
    minimum: 0,
    description: "Pixel border around the call-to-action panel; 0 leaves it unbordered.",
  }),
  imagePosition: enumOf("top", "left", "right"),
  mediaImage: image(),
});

/** `FeatureGridData`. */
const FEATURE_GRID = Object.freeze({
  items: withOmission(
    list(shape({
      icon: image(),
      title: str(),
      description: str(),
      url: safeUrl(),
    })),
    { kind: "value", value: Object.freeze([]) },
  ),
  columns: num({ values: Object.freeze([2, 3, 4]) }),
  iconSize: enumOf("small", "medium", "large", "xlarge"),
  borderWidth: num({
    integer: true,
    minimum: 0,
    description: "Pixel border around each item, as on a card grid; the grid itself is never framed. 0 boxes nothing.",
  }),
});

/** `TestimonialData` and its `TestimonialItem`. */
const TESTIMONIAL = Object.freeze({
  items: withOmission(
    list(shape({
      quote: str(),
      authorName: str(),
      authorTitle: str(),
      authorImage: image(),
    })),
    { kind: "value", value: Object.freeze([]) },
  ),
  columns: num({ values: Object.freeze([1, 2, 3]) }),
  carousel: bool(),
  interval: num({ integer: true, minimum: 2000 }),
  borderWidth: num({
    integer: true,
    minimum: 0,
    description: "Pixel border around the whole set of quotations — the grid or the carousel; 0 leaves it unbordered.",
  }),
});

/** `LatestPostsData` — resolved at generation time. */
const LATEST_POSTS = Object.freeze({
  count: num({ values: Object.freeze([3, 6, 9, 12]) }),
  columns: num({ values: Object.freeze([2, 3, 4]) }),
  pageTypes: list(enumOf(...LATEST_POST_PAGE_TYPES)),
  showPinned: bool(),
  highlightFirst: bool(),
  showDescription: bool(),
  showDate: bool(),
  showAuthor: bool(),
});

/** `CardGridData`. `cropState` is the one genuinely optional field in types.ts. */
const CARD_GRID = Object.freeze({
  cards: withOmission(
    list(shape({
      image: image(),
      title: str(),
      description: str(),
      linkUrl: safeUrl(),
      cropState: CROP_STATE,
    })),
    { kind: "value", value: Object.freeze([]) },
  ),
  columns: num({ values: Object.freeze([2, 3]) }),
  borderWidth: num({
    integer: true,
    minimum: 0,
    description: "Pixel border around each card; the grid itself is never framed. 0 boxes nothing.",
  }),
});

/** `ImageBannerData`. */
const IMAGE_BANNER = Object.freeze({
  image: image(),
  altText: str(),
  overlayText: str(),
  fontSize: enumOf("large", "standard", "small"),
  focus: shape({
    x: num({ minimum: 0, maximum: 1 }),
    y: num({ minimum: 0, maximum: 1 }),
  }),
  ratio: enumOf("4/1", "3/1", "2/1"),
  compactRatio: enumOf("", "2/1", "3/2", "1/1"),
  // `ratio` keeps the wide/compact shape, capped at the viewport space below
  // the site header; `viewport` fills exactly that space (TR00413).
  heightMode: enumOf("ratio", "viewport"),
  contentPosition: enumOf("bottom-start", "bottom", "bottom-end", "center", "top-start", "top", "top-end"),
  scrim: enumOf("auto", "none", "flat", "top", "bottom", "left", "right", "radial"),
  scrimStrength: enumOf("soft", "medium", "strong"),
  bannerScheme: enumOf("auto", "light", "dark"),
  // A built-in or application-registered Espalier texture name.
  texture: textureName(),
  textureScale: enumOf("fine", "medium", "coarse"),
});

const SPACER = Object.freeze({
  height: enumOf("small", "medium", "large"),
  showDivider: bool(),
  dividerStyle: enumOf("solid", "dashed", "dotted"),
  dividerWidth: num({ integer: true, minimum: 1 }),
});

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function component(fields, displayName, summary, defaultData, accessibility, example) {
  return deepFreeze({ fields, displayName, summary, defaultData, accessibility, example });
}

/**
 * The executable component registry. Validation, canonicalization, and
 * reference help all consume these same records. A component cannot acquire a
 * schema without also declaring its defaults, accessibility guidance, and a
 * validator-backed example.
 */
const COMPONENT_DEFINITIONS = Object.freeze({
  "hero-section": component(
    HERO_SECTION,
    "Hero Section",
    "Content-first introduction with a display-capable title, two actions, and optional content media.",
    {
      overline: "",
      title: "Welcome",
      titleSize: "normal",
      lead: "",
      primaryAction: { label: "Learn more", url: "/" },
      secondaryAction: null,
      alignment: "start",
      media: null,
      mediaArrangement: "split",
      mediaPosition: "after",
      mediaWidth: "equal",
    },
    [
      "Use a descriptive alt value on every meaningful image; use an empty alt value only for decorative imagery.",
      "Action labels should describe their destination or action instead of using generic text such as 'Click here'.",
      "The hero title is the page's h1; do not add a second h1 around it.",
    ],
    {
      overline: "Riverbend Hot Yoga · Elm Harbor",
      title: "Come as you are. Leave feeling stronger.",
      titleSize: "display",
      lead: "Hot yoga, barre, and wellness practices for every body.",
      primaryAction: { label: "View class schedule", url: "/classes" },
      secondaryAction: { label: "Meet the studio", url: "/about" },
      alignment: "start",
      media: {
        imageId: "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607",
        src: "https://static.example.test/site/img/riverbend-studio.webp",
        urls: [{ minWidth: 640, url: "https://static.example.test/site/img/riverbend-studio-640.webp" }],
        width: 1600,
        height: 1067,
        alt: "A welcoming hot yoga class at Riverbend Wellness",
      },
      mediaArrangement: "split",
      mediaPosition: "after",
      mediaWidth: "wide",
    },
  ),
  "cta": component(
    CTA,
    "Call to Action",
    "Focused prompt with supporting copy, a button, and optional media.",
    {
      heading: "",
      description: "",
      buttonText: "",
      buttonUrl: "",
      variant: "primary",
      borderWidth: 0,
      imagePosition: "top",
      mediaImage: null,
    },
    [
      "Button text must describe its action or destination.",
      "Give meaningful media a descriptive alt value and decorative media an empty alt value.",
    ],
    {
      heading: "Ready to begin?",
      description: "Reserve a place in this week's introductory class.",
      buttonText: "Reserve a class",
      buttonUrl: "/classes/intro",
      variant: "primary",
    },
  ),
  "testimonial": component(
    TESTIMONIAL,
    "Testimonials",
    "Attributed quotations displayed in a grid or timed carousel.",
    {
      items: [{ quote: "", authorName: "", authorTitle: "", authorImage: null }],
      columns: 1,
      carousel: false,
      interval: 5000,
      borderWidth: 0,
    },
    [
      "Identify the speaker with authorName; use authorTitle when it gives useful context.",
      "Author images need descriptive alt text unless they are purely decorative.",
      "Keep carousel intervals long enough for the full quotation to be read.",
    ],
    {
      items: [{
        quote: "The coaches made the first session feel welcoming.",
        authorName: "Alex Rivera",
        authorTitle: "Member",
        authorImage: null,
      }],
      columns: 1,
      carousel: false,
    },
  ),
  "feature-grid": component(
    FEATURE_GRID,
    "Feature Grid",
    "Two-to-four-column collection of features with optional icons and links.",
    {
      items: [{ icon: null, title: "", description: "", url: "" }],
      columns: 3,
      iconSize: "medium",
      borderWidth: 0,
    },
    [
      "Each linked item needs a title that remains meaningful as link text.",
      "Icon images need descriptive alt text when they convey information; otherwise use an empty alt value.",
      "Item title and description are plain text: an item's url makes the whole item the link, and no link can be placed inside the text. Put linked prose in a paragraph beside the grid.",
    ],
    {
      items: [
        { icon: null, title: "Personal coaching", description: "A plan shaped around your goals.", url: "/coaching" },
        { icon: null, title: "Flexible classes", description: "Morning and evening sessions.", url: "/classes" },
      ],
      columns: 2,
      iconSize: "medium",
    },
  ),
  "spacer": component(
    SPACER,
    "Spacer",
    "Intentional vertical separation with an optional decorative divider.",
    { height: "medium", showDivider: false, dividerStyle: "solid", dividerWidth: 1 },
    ["Do not use spacing alone to communicate document structure; keep headings and landmarks semantic."],
    { height: "large", showDivider: true, dividerStyle: "solid", dividerWidth: 1 },
  ),
  "latest-posts": component(
    LATEST_POSTS,
    "Latest Posts",
    "Generation-time list of recent published pages, optionally filtered by page type.",
    {
      count: 6,
      columns: 3,
      pageTypes: [],
      showPinned: true,
      highlightFirst: false,
      showDescription: true,
      showDate: true,
      showAuthor: false,
    },
    ["Keep descriptions enabled when titles alone do not make each destination clear."],
    {
      count: 6,
      columns: 3,
      pageTypes: ["TEMPLATE_TYPE_ARTICLE", "TEMPLATE_TYPE_FREE_FORM"],
      showPinned: true,
      highlightFirst: true,
      showDescription: true,
      showDate: true,
      showAuthor: false,
    },
  ),
  "card-grid": component(
    CARD_GRID,
    "Card Grid",
    "Two- or three-column collection of linked cards with optional images.",
    {
      cards: [{ image: null, title: "", description: "", linkUrl: "" }],
      columns: 3,
      borderWidth: 0,
    },
    [
      "Every linked card needs a title that describes its destination.",
      "Card images need descriptive alt text unless they are decorative.",
      "Card title and description are plain text: a card's linkUrl makes the whole card the link, and no link can be placed inside the text. Put linked prose in a paragraph beside the grid.",
    ],
    {
      cards: [
        {
          image: null,
          title: "Beginner program",
          description: "Build a sustainable foundation.",
          linkUrl: "/programs/beginner",
        },
        {
          image: null,
          title: "Strength program",
          description: "Progressive coaching for experienced members.",
          linkUrl: "/programs/strength",
        },
      ],
      columns: 2,
      borderWidth: 1,
    },
  ),
  "image-banner": component(
    IMAGE_BANNER,
    "Image Banner",
    "Wide responsive image with focal point, optional overlay text, scrim, and texture.",
    {
      image: null,
      altText: "",
      overlayText: "",
      fontSize: "large",
      focus: { x: 0.5, y: 0.5 },
      ratio: "3/1",
      compactRatio: "3/2",
      heightMode: "ratio",
      contentPosition: "center",
      scrim: "auto",
      scrimStrength: "medium",
      bannerScheme: "auto",
      texture: "none",
      textureScale: "medium",
    },
    [
      "Set altText to describe meaningful banner imagery; leave it empty only when the image is decorative.",
      "Choose a scrim and scheme that keep overlay text readable across the image.",
    ],
    {
      image: null,
      altText: "",
      overlayText: "Train together",
      focus: { x: 0.5, y: 0.35 },
      heightMode: "ratio",
      contentPosition: "bottom-start",
      scrim: "bottom",
      scrimStrength: "medium",
      texture: "paper",
    },
  ),
});

export const COMPONENT_TYPES = Object.freeze(Object.keys(COMPONENT_DEFINITIONS));

/** Kept for validation/canonicalization consumers; derived from the registry. */
export const COMPONENT_SHAPES = Object.freeze(Object.fromEntries(
  Object.entries(COMPONENT_DEFINITIONS).map(([type, definition]) => [type, definition.fields]),
));

export function getComponentDefinition(componentType) {
  return typeof componentType === "string" && Object.hasOwn(COMPONENT_DEFINITIONS, componentType)
    ? COMPONENT_DEFINITIONS[componentType]
    : undefined;
}

function referenceSchema(spec) {
  switch (spec.kind) {
    case "string":
      return {
        type: "string",
        ...(spec.nonWhitespace ? { minLength: 1, description: "Must contain non-whitespace text." } : {}),
      };
    case "safe-url":
      return {
        type: "string",
        format: spec.allowEmpty === false ? "safe-url" : "safe-url-or-empty",
        description:
          `${spec.allowEmpty === false ? "An" : "Empty, or an"} explicit HTTP(S), mailto, or tel URL; a root-relative path that does not begin with //; a fragment; a query; or a relative URL. Backslashes and ASCII control characters are rejected.`,
      };
    case "action-url":
      return {
        type: "string",
        format: "action-url-or-empty",
        description:
          "Empty, an explicit HTTP(S) URL, or a root-relative path that does not begin with //. Backslashes and ASCII control characters are rejected.",
      };
    case "texture-name":
      return {
        type: "string",
        pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
        maxLength: spec.maximumLength,
        builtInValues: [...BUILT_IN_IMAGE_TEXTURES],
        applicationRegistered: {
          accepted: true,
          requirement: "Register the texture with Espalier before rendering the page.",
        },
        description:
          "Names outside the built-in list render with no texture until the application registers them with Espalier.",
      };
    case "boolean":
      return { type: "boolean" };
    case "uuid":
      return { type: "string", format: "lowercase-uuid" };
    case "enum":
      return { type: "string", enum: [...spec.values] };
    case "number": {
      const schema = { type: spec.integer ? "integer" : "number" };
      if (spec.values) schema.enum = [...spec.values];
      if (spec.minimum !== undefined) schema.minimum = spec.minimum;
      if (spec.maximum !== undefined) schema.maximum = spec.maximum;
      // A numeric field whose units say nothing about what the number does —
      // `borderWidth` is the case — carries its meaning here so `help
      // component` prints it beside the constraints.
      if (spec.description) schema.description = spec.description;
      return schema;
    }
    case "array":
      return { type: "array", maxItems: MAX_ITEMS, items: referenceSchema(spec.item) };
    case "object":
      return {
        type: spec.nullable ? ["object", "null"] : "object",
        additionalProperties: false,
        properties: referenceProperties(spec.fields),
      };
    case "image":
      return {
        type: ["object", "null"],
        description:
          "null, or a media-upload result. Keep imageId, src, and urls keys so the server can rewrite delivery URLs.",
        additionalProperties: false,
        properties: referenceProperties(COMPONENT_IMAGE_FIELDS),
      };
    default:
      throw new TypeError(`Unknown component schema kind '${spec.kind}'.`);
  }
}

function referenceProperties(fields, defaults) {
  return Object.entries(fields).map(([name, spec]) => ({
    name,
    required: spec.required === true,
    ...(defaults === undefined
      ? {}
      : {
        editorInitial: Object.hasOwn(defaults, name)
          ? { kind: "value", value: defaults[name] }
          : { kind: "omitted" },
        whenOmitted: spec.whenOmitted ?? (spec.required
          ? { kind: "invalid" }
          : Object.hasOwn(defaults, name)
          ? { kind: "value", value: defaults[name] }
          : { kind: "unspecified" }),
      }),
    schema: referenceSchema(spec),
  }));
}

/** Exact, JSON-serializable property schema derived from the validator table. */
export function getComponentPropertyReference(componentType) {
  const definition = getComponentDefinition(componentType);
  return definition ? referenceProperties(definition.fields, definition.defaultData) : undefined;
}

export function isComponentType(value) {
  return typeof value === "string" && Object.hasOwn(COMPONENT_SHAPES, value);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function describe(spec) {
  switch (spec.kind) {
    case "enum":
      return `one of ${spec.values.map((value) => `"${value}"`).join(", ")}`;
    case "number":
      if (spec.values) return `one of ${spec.values.join(", ")}`;
      return spec.integer ? "an integer" : "a number";
    case "array":
      return "an array";
    case "object":
      return "an object";
    case "image":
      return "an image object or null";
    case "uuid":
      return "a canonical lowercase UUID";
    case "safe-url":
      return `${spec.allowEmpty === false ? "a" : "an empty string or a"} safe HTTP(S), mailto, tel, non-protocol-relative root path, fragment, query, or relative URL; backslashes and ASCII control characters are rejected`;
    case "action-url":
      return "an empty string, explicit HTTP(S) URL, or non-protocol-relative root path; backslashes and ASCII control characters are rejected";
    case "texture-name":
      return "a lowercase hyphenated texture identifier of at most 64 characters";
    default:
      return `a ${spec.kind}`;
  }
}

function validateValue(spec, value, path, errors) {
  const fail = (detail) => {
    errors.push(contentError(path, CODES.componentData, `Component data at '${path}' must be ${detail}.`));
  };

  // A nullable field's null is the interface's own "not set" value, never a
  // shape violation.
  if (spec.nullable && value === null) return;

  switch (spec.kind) {
    case "string":
      if (typeof value !== "string") fail("a string");
      else if (spec.nonWhitespace && value.trim() === "") fail("a string containing non-whitespace text");
      return;
    case "safe-url":
      if (
        typeof value !== "string"
        || (value === "" && spec.allowEmpty === false)
        || (value !== ""
          && (value.includes("\\")
            || hasAsciiControl(value)
            || value.trim().startsWith("//")
            || !isSafeUrl(value)))
      ) {
        fail(describe(spec));
      }
      return;
    case "action-url": {
      if (typeof value !== "string") {
        fail(describe(spec));
        return;
      }
      const trimmed = value.trim();
      const lower = trimmed.toLowerCase();
      if (
        value !== ""
        && (trimmed === ""
          || value.includes("\\")
          || hasAsciiControl(value)
          || trimmed.startsWith("//")
          || (!trimmed.startsWith("/") && !lower.startsWith("http://") && !lower.startsWith("https://")))
      ) {
        fail(describe(spec));
      }
      return;
    }
    case "texture-name":
      if (
        typeof value !== "string"
        || value.length > spec.maximumLength
        || !REGISTERED_TEXTURE_NAME_RE.test(value)
      ) {
        fail(describe(spec));
      }
      return;
    case "boolean":
      if (typeof value !== "boolean") fail("a boolean");
      return;
    case "uuid":
      if (!isUuid(value)) fail(describe(spec));
      return;
    case "enum":
      if (typeof value !== "string" || !spec.values.includes(value)) fail(describe(spec));
      return;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail(describe(spec));
        return;
      }
      if (spec.values && !spec.values.includes(value)) {
        fail(describe(spec));
        return;
      }
      if (spec.integer && !Number.isInteger(value)) {
        fail("an integer");
        return;
      }
      if (spec.minimum !== undefined && value < spec.minimum) {
        fail(`at least ${spec.minimum}`);
        return;
      }
      if (spec.maximum !== undefined && value > spec.maximum) fail(`at most ${spec.maximum}`);
      return;
    }
    case "array": {
      if (!Array.isArray(value)) {
        fail("an array");
        return;
      }
      if (value.length > MAX_ITEMS) {
        fail(`at most ${MAX_ITEMS} entries`);
        return;
      }
      value.forEach((entry, index) => validateValue(spec.item, entry, `${path}/${index}`, errors));
      return;
    }
    case "object": {
      if (!isPlainObject(value)) {
        fail("an object");
        return;
      }
      validateFields(spec.fields, value, path, errors);
      return;
    }
    case "image": {
      // `ComponentImageData | null` — null is the documented "no image" value.
      if (value === null) return;
      if (!isPlainObject(value)) {
        fail("an image object or null");
        return;
      }
      validateFields(COMPONENT_IMAGE_FIELDS, value, path, errors);
      return;
    }
    default:
      fail("a supported value");
  }
}

function validateFields(fields, value, path, errors) {
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) {
      errors.push(contentError(
        `${path}/${pointerSegment(key)}`,
        CODES.componentData,
        `Component data field '${identifier(key)}' is not part of this component's shape.`,
      ));
    }
  }
  for (const [key, spec] of Object.entries(fields)) {
    if (!Object.hasOwn(value, key)) {
      if (spec.required) {
        const code = spec.missingCode ?? CODES.componentData;
        const message = code === CODES.imageKeys
          ? `Component image at '${path}' must include a '${key}' key; the server only rewrites delivery `
            + "URLs onto keys that are already present, so an image without it renders blank."
          : `Component data field '${key}' is required.`;
        errors.push(contentError(
          `${path}/${key}`,
          code,
          message,
        ));
      }
      continue;
    }
    validateValue(spec, value[key], `${path}/${key}`, errors);
  }
}

/**
 * Validates a `componentBlock`'s `componentType` and `componentData` pair.
 *
 * `basePath` is the JSON pointer of the owning node's `attrs`; findings inside
 * the parsed data are reported at `<basePath>/componentData/<field>/...`, which
 * points *through* the JSON string into the data an agent has to fix.
 */
export function validateComponentBlock(componentType, componentData, basePath) {
  const errors = [];
  const dataPath = `${basePath}/componentData`;
  if (!isComponentType(componentType)) {
    errors.push(contentError(
      `${basePath}/componentType`,
      CODES.componentUnknown,
      `Unknown component type '${identifier(componentType)}'. Expected one of ${COMPONENT_TYPES.join(", ")}.`,
    ));
  }
  if (typeof componentData !== "string") {
    errors.push(contentError(
      dataPath,
      CODES.componentData,
      "componentData must be a JSON string, not an object — the editor and the renderer both store it as a string.",
    ));
    return errors;
  }
  if (Buffer.byteLength(componentData, "utf8") > CONTENT_LIMITS.componentDataBytes) {
    errors.push(contentError(
      dataPath,
      CODES.componentData,
      `componentData exceeds ${CONTENT_LIMITS.componentDataBytes} bytes.`,
    ));
    return errors;
  }

  let parsed;
  try {
    parsed = JSON.parse(componentData);
  } catch {
    errors.push(contentError(dataPath, CODES.componentData, "componentData is not valid JSON."));
    return errors;
  }
  if (!isPlainObject(parsed)) {
    errors.push(contentError(dataPath, CODES.componentData, "componentData must be a JSON object."));
    return errors;
  }
  // Through `isComponentType`, never a bare index: a caller-built document can
  // carry an object as `componentType`, and indexing would coerce it through a
  // `toString` this module does not control.
  const fields = isComponentType(componentType) ? COMPONENT_SHAPES[componentType] : undefined;
  if (!fields) return errors;
  validateFields(fields, parsed, dataPath, errors);
  return errors;
}

/**
 * Serialises component data in its interface's declaration order.
 *
 * Canonical order matters because `componentData` is a string: two documents
 * whose data differs only by key order are different strings, which means a
 * needless page update, a needless publish, and a diff no reviewer can read.
 * Unknown keys are refused by validation, so ordering by the table loses
 * nothing — but the caller must validate first, and this throws if it did not.
 */
export function canonicalizeComponentData(componentType, data) {
  const fields = isComponentType(componentType) ? COMPONENT_SHAPES[componentType] : undefined;
  if (!fields) throw new TypeError("canonicalizeComponentData requires a known component type.");
  if (!isPlainObject(data)) throw new TypeError("canonicalizeComponentData requires an object.");
  const ordered = {};
  for (const key of Object.keys(fields)) {
    if (Object.hasOwn(data, key)) ordered[key] = orderValue(fields[key], data[key]);
  }
  for (const key of Object.keys(data)) {
    if (!Object.hasOwn(fields, key)) throw new TypeError("canonicalizeComponentData requires validated data.");
  }
  return JSON.stringify(ordered);
}

function orderValue(spec, value) {
  if (spec.kind === "array" && Array.isArray(value)) {
    return value.map((entry) => orderValue(spec.item, entry));
  }
  if (spec.kind === "object" && isPlainObject(value)) {
    return orderFields(spec.fields, value);
  }
  if (spec.kind === "image" && isPlainObject(value)) {
    return orderFields(COMPONENT_IMAGE_FIELDS, value);
  }
  return value;
}

function orderFields(fields, value) {
  const ordered = {};
  for (const key of Object.keys(fields)) {
    if (Object.hasOwn(value, key)) ordered[key] = orderValue(fields[key], value[key]);
  }
  return ordered;
}
