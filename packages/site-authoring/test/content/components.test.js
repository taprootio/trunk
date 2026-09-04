import assert from "node:assert/strict";
import test from "node:test";

import { canonicalizeComponentData, isComponentType, validateComponentBlock } from "../../src/content/components.js";
import { validateDocument } from "../../src/content/validate-document.js";
import { CONTENT_LIMITS } from "../../src/content/vocabulary.js";

// `componentData` is a JSON string nothing on the server inspects. A wrong
// enum value publishes as a component silently rendered with the wrong layout;
// a wrong field name publishes as a component silently rendered with none of
// the author's content. These tables are the only thing that catches either.

const IMAGE_ID = "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607";
const IMAGE = Object.freeze({
  imageId: IMAGE_ID,
  src: "",
  urls: [{ minWidth: 640, url: "https://cdn.example.test/640.webp" }],
  width: 1600,
  height: 900,
  alt: "A photograph",
});

/** One complete instance of each of the eight registry shapes. */
const COMPLETE = {
  "hero-section": {
    overline: "Riverbend Hot Yoga · Elm Harbor",
    title: "Welcome",
    titleSize: "display",
    lead: "We open at six.",
    primaryAction: { label: "Book a class", url: "/book" },
    secondaryAction: { label: "Call", url: "tel:+15550137788" },
    alignment: "center",
    media: IMAGE,
    mediaArrangement: "split",
    mediaPosition: "after",
    mediaWidth: "wide",
  },
  "cta": {
    heading: "Ready?",
    description: "Start this week.",
    buttonText: "Get started",
    buttonUrl: "https://example.test/start",
    variant: "danger",
    borderWidth: 2,
    imagePosition: "left",
    mediaImage: null,
  },
  "testimonial": {
    items: [{ quote: "It worked.", authorName: "A. Rivera", authorTitle: "Member", authorImage: IMAGE }],
    columns: 2,
    carousel: true,
    interval: 5000,
    borderWidth: 0,
  },
  "feature-grid": {
    items: [{ icon: null, title: "Fast", description: "Very.", url: "/features" }],
    columns: 4,
    iconSize: "xlarge",
    borderWidth: 1,
  },
  "spacer": {
    height: "large",
    showDivider: true,
    dividerStyle: "dashed",
    dividerWidth: 2,
  },
  "latest-posts": {
    count: 12,
    columns: 3,
    pageTypes: ["TEMPLATE_TYPE_ARTICLE", "TEMPLATE_TYPE_FREE_FORM"],
    showPinned: true,
    highlightFirst: false,
    showDescription: true,
    showDate: true,
    showAuthor: false,
  },
  "card-grid": {
    cards: [{
      image: IMAGE,
      title: "A card",
      description: "With a description.",
      linkUrl: "/cards/a",
      cropState: {
        originalSrc: "https://cdn.example.test/original.webp",
        originalWidth: 2400,
        originalHeight: 1600,
        cropX: 0.1,
        cropY: 0.2,
        cropWidth: 0.8,
        cropHeight: 0.6,
      },
    }],
    columns: 2,
    borderWidth: 0,
  },
  "image-banner": {
    image: IMAGE,
    altText: "The studio",
    overlayText: "Open now",
    fontSize: "standard",
    focus: { x: 0.5, y: 0.25 },
    ratio: "4/1",
    compactRatio: "1/1",
    heightMode: "viewport",
    contentPosition: "bottom-end",
    scrim: "radial",
    scrimStrength: "strong",
    bannerScheme: "dark",
    texture: "linen",
    textureScale: "coarse",
  },
};

/** One violation per shape, each the kind a hand-authoring agent makes. */
const VIOLATIONS = {
  "hero-section": ["titleSize", "huge", "/attrs/componentData/titleSize"],
  "cta": ["variant", "secondary", "/attrs/componentData/variant"],
  "testimonial": ["columns", 4, "/attrs/componentData/columns"],
  "feature-grid": ["iconSize", "huge", "/attrs/componentData/iconSize"],
  "spacer": ["dividerStyle", "double", "/attrs/componentData/dividerStyle"],
  "latest-posts": ["count", 5, "/attrs/componentData/count"],
  "card-grid": ["columns", 4, "/attrs/componentData/columns"],
  "image-banner": ["ratio", "16/9", "/attrs/componentData/ratio"],
};

const validate = (componentType, data) =>
  validateComponentBlock(componentType, typeof data === "string" ? data : JSON.stringify(data), "/attrs");

test("the registry lookup covers exactly the eight built-in templates", () => {
  for (const componentType of Object.keys(COMPLETE)) assert.ok(isComponentType(componentType));
  for (const componentType of ["hero", "Spacer", "", "latest_posts", null, 7]) {
    assert.equal(isComponentType(componentType), false);
  }
});

test("accepts a complete instance of every registry shape", async (testContext) => {
  for (const [componentType, data] of Object.entries(COMPLETE)) {
    await testContext.test(componentType, () => assert.deepEqual(validate(componentType, data), []));
  }
});

test("rejects one wrong value in every registry shape", async (testContext) => {
  for (const [componentType, [field, value, path]] of Object.entries(VIOLATIONS)) {
    await testContext.test(`${componentType}.${field}`, () => {
      const errors = validate(componentType, { ...COMPLETE[componentType], [field]: value });
      assert.deepEqual(errors.map((error) => error.code), ["content.component_data"]);
      assert.deepEqual(errors.map((error) => error.path), [path]);
    });
  }
});

test("holds the CTA variant to the narrowed primary|danger vocabulary", async (testContext) => {
  // Narrowed at the Espalier 3 cutover (owner decision 2026-08-21), which
  // retired the mechanism behind the three geometric values. Pages that
  // already store one still publish — as the plain default — but authoring
  // one is refused, so pulling a pre-cutover page and pushing it back
  // unchanged fails loudly on this field rather than silently rewriting it.
  for (const variant of ["primary", "danger"]) {
    await testContext.test(`accepts ${variant}`, () => {
      assert.deepEqual(validate("cta", { ...COMPLETE["cta"], variant }), []);
    });
  }
  for (const variant of ["analogous-left", "analogous-right", "complementary"]) {
    await testContext.test(`refuses the retired ${variant}`, () => {
      const errors = validate("cta", { ...COMPLETE["cta"], variant });
      assert.deepEqual(errors.map((error) => error.code), ["content.component_data"]);
      assert.deepEqual(errors.map((error) => error.path), ["/attrs/componentData/variant"]);
    });
  }
});

test("holds the image-banner height mode to the ratio|viewport vocabulary", async (testContext) => {
  // The generator, node preview, and runtime adapter each fall back to ratio
  // for anything else, so a typo here would publish a banner silently sized
  // by its shape instead of the screen.
  for (const heightMode of ["ratio", "viewport"]) {
    await testContext.test(`accepts ${heightMode}`, () => {
      assert.deepEqual(validate("image-banner", { ...COMPLETE["image-banner"], heightMode }), []);
    });
  }
  for (const heightMode of ["fill", "100vh", "", true]) {
    await testContext.test(`refuses ${JSON.stringify(heightMode)}`, () => {
      const errors = validate("image-banner", { ...COMPLETE["image-banner"], heightMode });
      assert.deepEqual(errors.map((error) => error.code), ["content.component_data"]);
      assert.deepEqual(errors.map((error) => error.path), ["/attrs/componentData/heightMode"]);
    });
  }
});

test("accepts omitted optional fields but enforces the hero's required content", async (testContext) => {
  // Omission is part of the stored contract. The reference names editor
  // initial values separately from renderer omission behavior and marks the
  // refined hero's required fields invalid when absent.
  await testContext.test("absent", () => {
    assert.deepEqual(validate("hero-section", {
      title: "Only a title",
      primaryAction: { label: "Learn more", url: "/about" },
    }), []);
    assert.deepEqual(validate("card-grid", { cards: [{ title: "No crop state" }] }), []);
  });
  await testContext.test("required hero fields", () => {
    assert.deepEqual(
      validate("hero-section", {}).map((error) => error.path),
      ["/attrs/componentData/title", "/attrs/componentData/primaryAction"],
    );
    assert.deepEqual(
      validate("hero-section", { title: " \t", primaryAction: { label: " ", url: "" } })
        .map((error) => error.path),
      [
        "/attrs/componentData/title",
        "/attrs/componentData/primaryAction/label",
        "/attrs/componentData/primaryAction/url",
      ],
    );
  });
  await testContext.test("unknown field", () => {
    const errors = validate("spacer", { height: "small", spacing: "loose" });
    assert.deepEqual(errors.map((error) => error.code), ["content.component_data"]);
    assert.deepEqual(errors.map((error) => error.path), ["/attrs/componentData/spacing"]);
  });
  await testContext.test("unknown nested field", () => {
    const errors = validate("testimonial", { items: [{ quote: "q", author: "nope" }] });
    assert.deepEqual(errors.map((error) => error.path), ["/attrs/componentData/items/0/author"]);
  });
});

test("refuses a componentType outside the registry", () => {
  const errors = validate("hero", COMPLETE["hero-section"]);
  assert.deepEqual(errors.map((error) => error.code), ["content.component_unknown"]);
  assert.deepEqual(errors.map((error) => error.path), ["/attrs/componentType"]);
});

test("refuses componentData that is not a JSON string", async (testContext) => {
  const cases = [
    ["an object", { height: "large" }],
    ["an array", []],
    ["a number", 3],
    ["null", null],
    ["undefined", undefined],
  ];
  for (const [name, componentData] of cases) {
    await testContext.test(name, () => {
      const errors = validateComponentBlock("spacer", componentData, "/attrs");
      assert.deepEqual(errors.map((error) => error.code), ["content.component_data"]);
      assert.deepEqual(errors.map((error) => error.path), ["/attrs/componentData"]);
    });
  }
});

test("refuses componentData that does not parse into an object", async (testContext) => {
  for (const componentData of ["", "{", "not json", "[]", "\"text\"", "12"]) {
    await testContext.test(JSON.stringify(componentData), () => {
      const errors = validateComponentBlock("spacer", componentData, "/attrs");
      assert.deepEqual(errors.map((error) => error.code), ["content.component_data"]);
    });
  }
});

test("accepts componentData at the exact byte bound and refuses one byte more", () => {
  const prefix = "{\"title\":\"";
  const suffix = "\",\"primaryAction\":{\"label\":\"Go\",\"url\":\"/\"}}";
  const wrapperBytes = Buffer.byteLength(prefix + suffix, "utf8");
  const exact = `${prefix}${"x".repeat(CONTENT_LIMITS.componentDataBytes - wrapperBytes)}${suffix}`;
  const oversized = `${prefix}${"x".repeat(CONTENT_LIMITS.componentDataBytes - wrapperBytes + 1)}${suffix}`;
  assert.equal(Buffer.byteLength(exact, "utf8"), CONTENT_LIMITS.componentDataBytes);
  assert.deepEqual(validateComponentBlock("hero-section", exact, "/attrs"), []);
  assert.equal(Buffer.byteLength(oversized, "utf8"), CONTENT_LIMITS.componentDataBytes + 1);
  assert.deepEqual(
    validateComponentBlock("hero-section", oversized, "/attrs").map((error) => error.code),
    ["content.component_data"],
  );
});

test("carries the image key-presence rule into nested component images", async (testContext) => {
  const withImage = (image) => validate("image-banner", { image });

  await testContext.test("missing src", () => {
    const errors = withImage({ imageId: IMAGE_ID, urls: [] });
    assert.deepEqual(errors.map((error) => error.code), ["content.image_keys"]);
    assert.deepEqual(errors.map((error) => error.path), ["/attrs/componentData/image/src"]);
  });
  await testContext.test("missing urls", () => {
    const errors = withImage({ imageId: IMAGE_ID, src: "" });
    assert.deepEqual(errors.map((error) => error.code), ["content.image_keys"]);
    assert.deepEqual(errors.map((error) => error.path), ["/attrs/componentData/image/urls"]);
  });
  await testContext.test("missing imageId", () => {
    const errors = withImage({ src: "", urls: [] });
    assert.deepEqual(errors.map((error) => error.path), ["/attrs/componentData/image/imageId"]);
  });
  await testContext.test("imageId that is not a uuid", () => {
    assert.deepEqual(
      withImage({ imageId: "image-1", src: "", urls: [] }).map((error) => error.path),
      ["/attrs/componentData/image/imageId"],
    );
  });
  await testContext.test("a urls entry outside the ComponentImageData shape", () => {
    assert.deepEqual(
      withImage({ imageId: IMAGE_ID, src: "", urls: [{ minWidth: 640, url: "u", type: "image/webp" }] })
        .map((error) => error.path),
      ["/attrs/componentData/image/urls/0/type"],
    );
  });
  await testContext.test("null is the interface's own no-image value", () => {
    assert.deepEqual(withImage(null), []);
  });
  await testContext.test("zero dimensions survive, because the uploader writes them", () => {
    assert.deepEqual(withImage({ ...IMAGE, width: 0, height: 0 }), []);
  });
});

test("holds nested arrays and objects to their item shapes", async (testContext) => {
  const cases = [
    ["items not an array", "testimonial", { items: {} }, "/attrs/componentData/items"],
    ["an item that is not an object", "testimonial", { items: ["quote"] }, "/attrs/componentData/items/0"],
    ["a wrong item field type", "feature-grid", { items: [{ title: 7 }] }, "/attrs/componentData/items/0/title"],
    ["focus out of range", "image-banner", { focus: { x: 1.5, y: 0 } }, "/attrs/componentData/focus/x"],
    ["focus not an object", "image-banner", { focus: 0.5 }, "/attrs/componentData/focus"],
    [
      "cropState out of range",
      "card-grid",
      { cards: [{ cropState: { cropX: 2 } }] },
      "/attrs/componentData/cards/0/cropState/cropX",
    ],
    ["pageTypes entry not a string", "latest-posts", { pageTypes: [7] }, "/attrs/componentData/pageTypes/0"],
    ["a boolean given a string", "spacer", { showDivider: "true" }, "/attrs/componentData/showDivider"],
    ["a number given a string", "cta", { borderWidth: "2" }, "/attrs/componentData/borderWidth"],
    ["a non-integer where the shape is integral", "cta", { borderWidth: 1.5 }, "/attrs/componentData/borderWidth"],
  ];
  for (const [name, componentType, data, path] of cases) {
    await testContext.test(name, () => {
      const errors = validate(componentType, data);
      assert.deepEqual(errors.map((error) => error.code), ["content.component_data"]);
      assert.deepEqual(errors.map((error) => error.path), [path]);
    });
  }
  await testContext.test("cropState null is accepted", () => {
    assert.deepEqual(validate("card-grid", { cards: [{ title: "t", cropState: null }] }), []);
  });
});

test("refuses component values the renderer would silently discard", async (testContext) => {
  const cases = [
    [
      "hero action URL",
      "hero-section",
      { ...COMPLETE["hero-section"], primaryAction: { label: "Go", url: "javascript:alert(1)" } },
      "/attrs/componentData/primaryAction/url",
    ],
    [
      "whitespace-only hero action URL",
      "hero-section",
      { ...COMPLETE["hero-section"], primaryAction: { label: "Go", url: "   " } },
      "/attrs/componentData/primaryAction/url",
    ],
    [
      "slash-backslash hero action URL",
      "hero-section",
      { ...COMPLETE["hero-section"], primaryAction: { label: "Go", url: "/\\evil.example/path" } },
      "/attrs/componentData/primaryAction/url",
    ],
    [
      "protocol-relative hero action URL",
      "hero-section",
      { ...COMPLETE["hero-section"], primaryAction: { label: "Go", url: "//evil.example" } },
      "/attrs/componentData/primaryAction/url",
    ],
    ["CTA button URL", "cta", { buttonUrl: "data:text/html,bad" }, "/attrs/componentData/buttonUrl"],
    ["whitespace-only CTA button URL", "cta", { buttonUrl: "   " }, "/attrs/componentData/buttonUrl"],
    ["double-backslash CTA button URL", "cta", { buttonUrl: "\\\\evil.example/path" }, "/attrs/componentData/buttonUrl"],
    ["control-character CTA button URL", "cta", { buttonUrl: "/bad\u0001path" }, "/attrs/componentData/buttonUrl"],
    ["feature URL", "feature-grid", { items: [{ url: "javascript:bad" }] }, "/attrs/componentData/items/0/url"],
    [
      "slash-backslash feature URL",
      "feature-grid",
      { items: [{ url: "/\\evil.example/path" }] },
      "/attrs/componentData/items/0/url",
    ],
    [
      "protocol-relative feature URL",
      "feature-grid",
      { items: [{ url: "//evil.example" }] },
      "/attrs/componentData/items/0/url",
    ],
    [
      "control-character feature URL",
      "feature-grid",
      { items: [{ url: "/bad\u007fpath" }] },
      "/attrs/componentData/items/0/url",
    ],
    ["card URL", "card-grid", { cards: [{ linkUrl: "javascript:bad" }] }, "/attrs/componentData/cards/0/linkUrl"],
    [
      "double-backslash card URL",
      "card-grid",
      { cards: [{ linkUrl: "\\\\evil.example/path" }] },
      "/attrs/componentData/cards/0/linkUrl",
    ],
    [
      "protocol-relative card URL",
      "card-grid",
      { cards: [{ linkUrl: "//evil.example" }] },
      "/attrs/componentData/cards/0/linkUrl",
    ],
    ["zero spacer divider width", "spacer", { dividerWidth: 0 }, "/attrs/componentData/dividerWidth"],
    ["zero testimonial interval", "testimonial", { interval: 0 }, "/attrs/componentData/interval"],
    ["short testimonial interval", "testimonial", { interval: 1999 }, "/attrs/componentData/interval"],
    ["unsupported latest-post page type", "latest-posts", { pageTypes: ["blog"] }, "/attrs/componentData/pageTypes/0"],
    ["invalid texture identifier", "image-banner", { texture: "Fine Linen" }, "/attrs/componentData/texture"],
  ];
  for (const [name, componentType, data, path] of cases) {
    await testContext.test(name, () => {
      const errors = validate(componentType, data);
      assert.deepEqual(errors.map((error) => error.code), ["content.component_data"]);
      assert.deepEqual(errors.map((error) => error.path), [path]);
    });
  }

  await testContext.test("accepts each renderer-bound empty or safe value", () => {
    assert.deepEqual(validate("hero-section", {
      title: "Practice with us",
      primaryAction: { label: "Call", url: "tel:+15550137788" },
      secondaryAction: { label: "Email", url: "mailto:hello@example.test" },
    }), []);
    assert.deepEqual(validate("cta", { buttonUrl: "https://example.test/start" }), []);
    assert.deepEqual(validate("feature-grid", { items: [{ url: "/features" }] }), []);
    assert.deepEqual(validate("card-grid", { cards: [{ linkUrl: "#details" }] }), []);
    assert.deepEqual(validate("image-banner", { texture: "fine-linen" }), []);
    assert.deepEqual(validate("spacer", { dividerWidth: 1 }), []);
    assert.deepEqual(validate("testimonial", { interval: 2000 }), []);
  });

  await testContext.test("URL failures name every enforced character restriction", () => {
    for (const [componentType, data] of [
      ["cta", { buttonUrl: "/bad\\path" }],
      ["feature-grid", { items: [{ url: "/bad\u0001path" }] }],
    ]) {
      const [error] = validate(componentType, data);
      assert.match(error.message, /backslashes and ASCII control characters are rejected/u);
    }
  });
});

test("canonicalises component data in the interface's declaration order", () => {
  const scrambled = { showDivider: true, dividerWidth: 3, height: "small", dividerStyle: "dotted" };
  assert.equal(
    canonicalizeComponentData("spacer", scrambled),
    "{\"height\":\"small\",\"showDivider\":true,\"dividerStyle\":\"dotted\",\"dividerWidth\":3}",
  );
  // Nested objects and array items are ordered too, so two runs of the same
  // authored data produce byte-identical strings and no needless page update.
  assert.equal(
    canonicalizeComponentData("image-banner", {
      overlayText: "Hi",
      image: { alt: "a", src: "", imageId: IMAGE_ID, urls: [] },
    }),
    `{"image":{"imageId":"${IMAGE_ID}","src":"","urls":[],"alt":"a"},"overlayText":"Hi"}`,
  );
  assert.equal(
    canonicalizeComponentData("hero-section", {
      mediaPosition: "after",
      primaryAction: { url: "/classes", label: "View classes" },
      title: "Practice with us",
      overline: "Riverbend Wellness",
    }),
    "{\"overline\":\"Riverbend Wellness\",\"title\":\"Practice with us\",\"primaryAction\":{\"label\":\"View classes\",\"url\":\"/classes\"},\"mediaPosition\":\"after\"}",
  );
  assert.throws(() => canonicalizeComponentData("nope", {}), TypeError);
  assert.throws(() => canonicalizeComponentData("spacer", "{}"), TypeError);
  assert.throws(() => canonicalizeComponentData("spacer", { unknown: 1 }), TypeError);
});

test("rejects every legacy hero substrate and layout field", async (context) => {
  for (const field of [
    "subtitle",
    "backgroundImage",
    "portraitBackgroundImage",
    "mediaImage",
    "ctaText",
    "ctaUrl",
    "textAlign",
    "mobileTextAlign",
    "overlayOpacity",
    "layout",
    "splitRatio",
    "stackOrder",
    "imagePosition",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
  ]) {
    await context.test(field, () => {
      const errors = validate("hero-section", { ...COMPLETE["hero-section"], [field]: null });
      assert.ok(errors.some((error) => error.path === `/attrs/componentData/${field}`));
    });
  }
});

test("reaches the component tables through a whole document", () => {
  const document = (componentData) => ({
    type: "doc",
    content: [{ type: "componentBlock", attrs: { componentType: "spacer", componentData } }],
  });
  assert.deepEqual(validateDocument(document("{\"height\":\"large\"}")).errors, []);
  const errors = validateDocument(document("{\"height\":\"enormous\"}")).errors;
  assert.deepEqual(errors.map((error) => error.code), ["content.component_data"]);
  assert.deepEqual(errors.map((error) => error.path), ["/content/0/attrs/componentData/height"]);
});
