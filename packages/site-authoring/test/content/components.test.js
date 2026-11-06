import assert from "node:assert/strict";
import test from "node:test";

import registry from "../../src/content/free-form-section-registry.json" with { type: "json" };
import {
  canonicalizeComponentData,
  getComponentDefinition,
  isComponentType,
  validateComponentBlock,
} from "../../src/content/components.js";
import { validateDocument } from "../../src/content/validate-document.js";
import { CONTENT_LIMITS } from "../../src/content/vocabulary.js";

test("all page action fields share the contact URL authoring policy", () => {
  const blocks = (url) => [
    ["cta", { buttonUrl: url }],
    ["hero-section", { title: "Hello", primaryAction: { label: "Contact", url } }],
    ["feature-grid", { items: [{ title: "Contact", url }] }],
    ["card-grid", { cards: [{ title: "Contact", linkUrl: url }] }],
  ];
  for (
    const [url, accepted] of [
      ["tel:+15551234567", true],
      ["mailto:hello@example.test", true],
      ["#contact", true],
      ["?contact=true", true],
      ["contact", true],
      ["tel://+15551234567", false],
      ["mailto://hello@example.test", false],
      ["TEL://+15551234567", false],
      ["tel:", false],
      ["mailto:", false],
      ["tel:+1555\u0085", false],
    ]
  ) {
    for (const [type, data] of blocks(url)) {
      const result = validateDocument({
        type: "doc",
        content: [{
          type: "componentBlock",
          attrs: { componentType: type, componentData: JSON.stringify(data) },
        }],
      });
      assert.equal(result.errors.length === 0, accepted, JSON.stringify({ type, url, errors: result.errors }));
    }
  }
});

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
    borderWidth: 2,
    bannerScheme: "light",
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
    presentation: "featured",
    imageAspect: "square",
    interaction: "caption-reveal",
    borderWidth: 0,
  },
  "image-banner": {
    image: IMAGE,
    altText: "The studio",
    overlayText: "Open now",
    supportingText: "Classes every morning.",
    action: { label: "See the schedule", url: "/classes" },
    compactPlacement: "below",
    fontSize: "standard",
    focus: { x: 0.5, y: 0.25 },
    ratio: "4/1",
    compactRatio: "1/1",
    heightMode: "viewport",
    contentPosition: "middle-end",
    scrim: "radial",
    scrimStrength: "strong",
    bannerScheme: "dark",
    textShadow: "strong",
    texture: "linen",
    textureScale: "coarse",
    imageMotion: "drift-end",
  },
  "image-row": {
    items: [{ image: IMAGE, url: "/classes" }, { image: IMAGE, url: "" }],
    height: "large",
    align: "center",
  },
  "product-grid": {
    items: [{
      image: IMAGE,
      title: "Monthly unlimited",
      price: "$145",
      priceNote: "per month",
      badge: "Most popular",
      description: "Every class on the schedule.",
      features: ["Unlimited classes", "Sauna included"],
      buttonText: "Join now",
      buttonUrl: "https://pay.example.test/monthly",
      highlighted: true,
      cropState: null,
    }],
    columns: 3,
    density: "compact",
    borderWidth: 1,
  },
};

/** One violation per shape, each the kind a hand-authoring agent makes. */
const VIOLATIONS = {
  "hero-section": ["titleSize", "huge", "/attrs/componentData/titleSize"],
  "cta": ["variant", "secondary", "/attrs/componentData/variant"],
  "testimonial": ["columns", 4, "/attrs/componentData/columns"],
  "feature-grid": ["iconSize", "huge", "/attrs/componentData/iconSize"],
  "spacer": ["dividerStyle", "double", "/attrs/componentData/dividerStyle"],
  "latest-posts": ["count", 13, "/attrs/componentData/count"],
  "card-grid": ["columns", 4, "/attrs/componentData/columns"],
  "image-banner": ["ratio", "16/9", "/attrs/componentData/ratio"],
  "image-row": ["height", "huge", "/attrs/componentData/height"],
  "product-grid": ["density", "loose", "/attrs/componentData/density"],
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

test("accepts every image banner text shadow strength and rejects an unknown one", () => {
  for (const textShadow of ["none", "light", "medium", "strong"]) {
    assert.deepEqual(validate("image-banner", { ...COMPLETE["image-banner"], textShadow }), []);
  }
  const errors = validate("image-banner", { ...COMPLETE["image-banner"], textShadow: "extreme" });
  assert.deepEqual(errors.map((error) => error.code), ["content.component_data"]);
  assert.deepEqual(errors.map((error) => error.path), ["/attrs/componentData/textShadow"]);
});

test("defaults the image banner text shadow to none", () => {
  assert.equal(getComponentDefinition("image-banner").defaultData.textShadow, "none");
  assert.deepEqual(validate("image-banner", { image: COMPLETE["image-banner"].image }), []);
});

test("holds the image banner copy stack to what the renderer publishes (TR00819)", async (testContext) => {
  for (const contentPosition of ["middle-start", "middle-end"]) {
    assert.deepEqual(validate("image-banner", { ...COMPLETE["image-banner"], contentPosition }), []);
  }
  assert.deepEqual(validate("image-banner", { ...COMPLETE["image-banner"], action: null, supportingText: "" }), []);
  assert.deepEqual(validate("image-banner", { supportingText: "x".repeat(280) }), []);
  // UTF-16 units, as generator readiness and the editor count them.
  assert.deepEqual(validate("image-banner", { supportingText: "😀".repeat(140) }), []);
  assert.equal(validate("image-banner", { supportingText: "😀".repeat(141) }).length, 1);
  const refusals = [
    ["an unknown compact placement", { compactPlacement: "beside" }, "/attrs/componentData/compactPlacement"],
    ["supporting text over 280 characters", { supportingText: "x".repeat(281) }, "/attrs/componentData/supportingText"],
    ["an action without a label", { action: { url: "/classes" } }, "/attrs/componentData/action/label"],
    ["an unsafe action URL", { action: { label: "Go", url: "javascript:alert(1)" } }, "/attrs/componentData/action/url"],
  ];
  for (const [name, data, pointer] of refusals) {
    await testContext.test(name, () => {
      const errors = validate("image-banner", data);
      assert.ok(errors.some((error) => error.path === pointer), JSON.stringify(errors));
    });
  }
  assert.equal(getComponentDefinition("image-banner").defaultData.compactPlacement, "overlay");
  assert.equal(getComponentDefinition("image-banner").defaultData.action, null);
});

test("holds creative component options to their published vocabularies", async (testContext) => {
  const cases = [
    ["image-banner", "imageMotion", ["none", "slow-zoom", "drift-start", "drift-end", "parallax-subtle", "parallax"], "orbit"],
    ["card-grid", "presentation", ["cards", "editorial", "featured", "poster"], "gallery"],
    ["card-grid", "imageAspect", ["auto", "landscape", "square", "portrait"], "cinematic"],
    ["card-grid", "interaction", ["none", "lift", "zoom", "caption-reveal"], "tilt"],
  ];

  for (const [componentType, field, accepted, rejected] of cases) {
    await testContext.test(`${componentType}.${field}`, () => {
      for (const value of accepted) {
        assert.deepEqual(validate(componentType, { ...COMPLETE[componentType], [field]: value }), []);
      }
      const errors = validate(componentType, { ...COMPLETE[componentType], [field]: rejected });
      assert.deepEqual(errors.map((error) => error.path), [`/attrs/componentData/${field}`]);
    });
  }
});

test("defaults creative component options", () => {
  const cardGrid = getComponentDefinition("card-grid").defaultData;
  assert.equal(cardGrid.presentation, "cards");
  assert.equal(cardGrid.imageAspect, "landscape");
  assert.equal(cardGrid.interaction, "lift");
  assert.equal(getComponentDefinition("image-banner").defaultData.imageMotion, "none");
});

test("requires a visible title when a card is linked", () => {
  for (const title of ["", " \t", undefined]) {
    const card = { description: "Image-led card", linkUrl: "/work" };
    if (title !== undefined) card.title = title;
    const errors = validate("card-grid", { cards: [card] });
    assert.deepEqual(errors.map((error) => error.code), ["content.component_data"]);
    assert.deepEqual(errors.map((error) => error.path), ["/attrs/componentData/cards/0/title"]);
  }
  assert.deepEqual(validate("card-grid", { cards: [{ description: "Static image", linkUrl: "" }] }), []);
  assert.deepEqual(validate("card-grid", { cards: [{ title: "Field notes", linkUrl: "/notes" }] }), []);
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
    assert.deepEqual(validate("card-grid", { cards: [{ title: "Details", linkUrl: "#details" }] }), []);
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

test("a video embed block is validated against its provider's id rules and closed shape", () => {
  const issues = (data) => validateComponentBlock("video-embed", JSON.stringify(data), "/attrs").map((e) => e.path);
  const base = { provider: "youtube", videoId: "dQw4w9WgXcQ", title: "Studio tour" };

  assert.deepEqual(issues({ ...base, aspectRatio: "16:9" }), []);
  assert.deepEqual(issues({ provider: "vimeo", videoId: "76979871", title: "t" }), []);
  assert.deepEqual(issues({ ...base, url: "https://youtu.be/dQw4w9WgXcQ" }), ["/attrs/componentData/url"]);
  assert.deepEqual(issues({ ...base, provider: "dailymotion" }), ["/attrs/componentData/provider"]);
  assert.deepEqual(issues({ ...base, videoId: "../x" }), ["/attrs/componentData/videoId"]);
  assert.deepEqual(issues({ ...base, provider: "vimeo" }), ["/attrs/componentData/videoId"]);
  assert.deepEqual(issues({ provider: "youtube", videoId: "dQw4w9WgXcQ" }), ["/attrs/componentData/title"]);
  assert.deepEqual(issues({ ...base, title: "x".repeat(201) }), ["/attrs/componentData/title"]);
  assert.deepEqual(issues({ ...base, aspectRatio: "wide" }), ["/attrs/componentData/aspectRatio"]);
});

test("a video block names the video and refuses the poster, caption and ratio, which are the video's own", () => {
  const issues = (data) => validateComponentBlock("video", JSON.stringify(data), "/attrs").map((e) => e.path);
  const base = { videoId: "7c5e2b1a-9d3f-4a68-b0c4-1e2f3a4b5c6d" };

  assert.deepEqual(issues(getComponentDefinition("video").example), []);
  assert.deepEqual(issues({ ...base, caption: "Tour" }), ["/attrs/componentData/caption"]);
  assert.deepEqual(issues({ ...base, aspectRatio: "16:9" }), ["/attrs/componentData/aspectRatio"]);
  assert.deepEqual(issues({ ...base, poster: null }), ["/attrs/componentData/poster"]);
});

test("the video embed example validates and canonicalizes in declaration order", () => {
  const { example } = getComponentDefinition("video-embed");
  assert.deepEqual(validateComponentBlock("video-embed", JSON.stringify(example), "/attrs"), []);
  assert.deepEqual(Object.keys(JSON.parse(canonicalizeComponentData("video-embed", { ...example, aspectRatio: "4:3" }))), [
    "provider",
    "videoId",
    "title",
    "aspectRatio",
  ]);
});

test("video and video embed blocks take the same optional max height and border width as images", () => {
  const video = { videoId: "7c5e2b1a-9d3f-4a68-b0c4-1e2f3a4b5c6d" };
  const embed = { provider: "youtube", videoId: "dQw4w9WgXcQ", title: "Studio tour" };
  const issues = (type, data) => validateComponentBlock(type, JSON.stringify(data), "/attrs").map((e) => e.path);

  for (const [type, base] of [["video", video], ["video-embed", embed]]) {
    assert.deepEqual(issues(type, base), []);
    assert.deepEqual(issues(type, { ...base, maxHeight: "50vh", borderWidth: "4px" }), []);
    assert.deepEqual(issues(type, { ...base, maxHeight: "none", borderWidth: "0" }), []);
    assert.deepEqual(issues(type, { ...base, maxHeight: "calc(100vh - 4rem)" }), []);
    assert.deepEqual(issues(type, { ...base, maxHeight: "tall" }), ["/attrs/componentData/maxHeight"]);
    assert.deepEqual(issues(type, { ...base, maxHeight: 50 }), ["/attrs/componentData/maxHeight"]);
    assert.deepEqual(issues(type, { ...base, borderWidth: "none" }), ["/attrs/componentData/borderWidth"]);
    assert.deepEqual(issues(type, { ...base, borderWidth: "2px; color: red" }), ["/attrs/componentData/borderWidth"]);
    assert.deepEqual(issues(type, { ...base, maxHeight: "site-default" }), ["/attrs/componentData/maxHeight"]);
  }
});

test("the video blocks describe the two fields and keep them last in declaration order", () => {
  for (const type of ["video", "video-embed"]) {
    const definition = getComponentDefinition(type);
    assert.deepEqual(Object.keys(definition.fields).slice(-2), ["maxHeight", "borderWidth"]);
    assert.ok(definition.authoring.notes.some((line) => line.includes("maxHeight") && line.includes("borderWidth")));
  }
  const { example } = getComponentDefinition("video");
  assert.deepEqual(
    Object.keys(JSON.parse(canonicalizeComponentData("video", { ...example, borderWidth: "2px", maxHeight: "50vh" }))).slice(-2),
    ["maxHeight", "borderWidth"],
  );
});

test("a product grid bounds every text, pairs the button fields and needs a price under a note (TR01323)", async (testContext) => {
  const limits = registry.components["product-grid"].limits;
  const grid = (items, rest = {}) => ({ items, columns: 3, density: "standard", borderWidth: 0, ...rest });
  const product = (overrides = {}) => ({ image: null, title: "Intro offer", ...overrides });
  const paths = (data) => validate("product-grid", data).map((error) => [error.code, error.path]);
  const text = (length) => "x".repeat(length);
  const bounded = [
    ["title", (value) => product({ title: value }), limits.title],
    ["price", (value) => product({ price: value }), limits.price],
    ["priceNote", (value) => product({ price: "$1", priceNote: value }), limits.priceNote],
    ["badge", (value) => product({ badge: value }), limits.badge],
    ["description", (value) => product({ description: value }), limits.description],
    ["buttonText", (value) => product({ buttonText: value, buttonUrl: "/go" }), limits.buttonText],
  ];
  for (const [field, build, limit] of bounded) {
    await testContext.test(`${field} accepts ${limit} characters and refuses ${limit + 1}`, () => {
      assert.deepEqual(paths(grid([build(text(limit))])), []);
      assert.deepEqual(paths(grid([build(text(limit + 1))])), [["content.component_data", `/attrs/componentData/items/0/${field}`]]);
    });
  }
  await testContext.test(`a feature line accepts ${limits.feature} characters and refuses ${limits.feature + 1}`, () => {
    assert.deepEqual(paths(grid([product({ features: [text(limits.feature)] })])), []);
    assert.deepEqual(paths(grid([product({ features: [text(limits.feature + 1)] })])), [["content.component_data", "/attrs/componentData/items/0/features/0"]]);
  });
  await testContext.test(`${limits.features} features are accepted and ${limits.features + 1} refused`, () => {
    assert.deepEqual(paths(grid([product({ features: Array.from({ length: limits.features }, (_, i) => `Feature ${i}`) })])), []);
    assert.deepEqual(paths(grid([product({ features: Array.from({ length: limits.features + 1 }, (_, i) => `Feature ${i}`) })])), [["content.component_data", "/attrs/componentData/items/0/features"]]);
  });
  await testContext.test("one hundred items are accepted and a hundred and one refused", () => {
    const maxItems = registry.components["product-grid"].maxItems;
    assert.deepEqual(paths(grid(Array.from({ length: maxItems }, () => product()))), []);
    assert.deepEqual(paths(grid(Array.from({ length: maxItems + 1 }, () => product()))), [["content.component_data", "/attrs/componentData/items"]]);
  });
  const refusals = [
    ["a blank title", grid([product({ title: "  " })]), "/attrs/componentData/items/0/title"],
    ["a blank feature bullet", grid([product({ features: ["Towels", " "] })]), "/attrs/componentData/items/0/features/1"],
    ["a feature with a line break", grid([product({ features: ["Towels", "Studio access\nincluding weekends"] })]), "/attrs/componentData/items/0/features/1"],
    ["button text without an address", grid([product({ buttonText: "Buy now" })]), "/attrs/componentData/items/0/buttonUrl"],
    ["an address without button text", grid([product({ buttonUrl: "/go" })]), "/attrs/componentData/items/0/buttonText"],
    ["a whitespace-only address", grid([product({ buttonText: "Buy", buttonUrl: " " })]), "/attrs/componentData/items/0/buttonUrl"],
    ["a price note without a price", grid([product({ priceNote: "per month" })]), "/attrs/componentData/items/0/price"],
    ["an unsafe address", grid([product({ buttonText: "Buy", buttonUrl: "javascript:alert(1)" })]), "/attrs/componentData/items/0/buttonUrl"],
    ["zero items", grid([]), "/attrs/componentData/items"],
    ["five columns", grid([product()], { columns: 5 }), "/attrs/componentData/columns"],
    ["one column", grid([product()], { columns: 1 }), "/attrs/componentData/columns"],
    ["an unknown density", grid([product()], { density: "loose" }), "/attrs/componentData/density"],
    ["a negative border", grid([product()], { borderWidth: -1 }), "/attrs/componentData/borderWidth"],
    ["a non-boolean highlighted", grid([product({ highlighted: "yes" })]), "/attrs/componentData/items/0/highlighted"],
    ["a non-string address beside button text", grid([product({ buttonText: "Buy", buttonUrl: 5 })]), "/attrs/componentData/items/0/buttonUrl"],
    ["a non-string button text beside an address", grid([product({ buttonText: 5, buttonUrl: "/go" })]), "/attrs/componentData/items/0/buttonText"],
    ["a non-string price beside a note", grid([product({ price: 145, priceNote: "per month" })]), "/attrs/componentData/items/0/price"],
    ["an unknown item field", grid([product({ sku: "A1" })]), "/attrs/componentData/items/0/sku"],
    ["an unknown field", grid([product()], { gap: "wide" }), "/attrs/componentData/gap"],
  ];
  for (const [label, data, path] of refusals) {
    await testContext.test(`refuses ${label}`, () => {
      assert.deepEqual(paths(data), [["content.component_data", path]]);
    });
  }
  await testContext.test("still reports a note without a price beside a non-string address", () => {
    assert.deepEqual(paths(grid([product({ buttonText: "Buy", buttonUrl: 5, priceNote: "per month" })])), [
      ["content.component_data", "/attrs/componentData/items/0/buttonUrl"],
      ["content.component_data", "/attrs/componentData/items/0/price"],
    ]);
  });
  await testContext.test("treats whitespace-only button text with an empty address as absent", () => {
    assert.deepEqual(paths(grid([product({ buttonText: "  ", buttonUrl: "" })])), []);
  });
  await testContext.test("accepts an item with only a title, a null image and an omitted image", () => {
    assert.deepEqual(paths(grid([product(), { title: "Drop-in" }])), []);
  });
  await testContext.test("canonicalizes in declaration order", () => {
    assert.equal(
      canonicalizeComponentData("product-grid", { borderWidth: 1, items: [{ buttonUrl: "/a", title: "T", buttonText: "Go", image: null }], density: "compact", columns: 2 }),
      JSON.stringify({ items: [{ image: null, title: "T", buttonText: "Go", buttonUrl: "/a" }], columns: 2, density: "compact", borderWidth: 1 }),
    );
  });
});

test("an image row needs one to twelve measured images with alt text and safe links (TR01322)", async (testContext) => {
  const row = (items, rest = {}) => ({ items, height: "medium", align: "start", ...rest });
  const paths = (data) => validate("image-row", data).map((error) => [error.code, error.path]);
  const item = (overrides = {}) => ({ image: { ...IMAGE, ...overrides }, url: "" });
  const cases = [
    ["a blank alt", row([item({ alt: "  " })]), "/attrs/componentData/items/0/image/alt"],
    ["a missing alt", row([{ image: Object.fromEntries(Object.entries(IMAGE).filter(([key]) => key !== "alt")), url: "" }]),
      "/attrs/componentData/items/0/image/alt"],
    ["a zero width", row([item({ width: 0 })]), "/attrs/componentData/items/0/image/width"],
    ["a missing height", row([{ image: Object.fromEntries(Object.entries(IMAGE).filter(([key]) => key !== "height")), url: "" }]),
      "/attrs/componentData/items/0/image/height"],
    ["a null image", row([{ image: null, url: "" }]), "/attrs/componentData/items/0/image"],
    ["zero items", row([]), "/attrs/componentData/items"],
    ["a thirteenth item", row(Array.from({ length: 13 }, () => item())), "/attrs/componentData/items"],
    ["an unknown item field", row([{ ...item(), caption: "x" }]), "/attrs/componentData/items/0/caption"],
    ["an unsafe link", row([{ ...item(), url: "javascript:alert(1)" }]), "/attrs/componentData/items/0/url"],
    ["an unknown field", row([item()], { gap: "wide" }), "/attrs/componentData/gap"],
  ];
  for (const [label, data, path] of cases) {
    await testContext.test(`refuses ${label}`, () => {
      assert.deepEqual(paths(data), [["content.component_data", path]]);
    });
  }
  await testContext.test("names the media manifest in the blank-alt message", () => {
    const [error] = validate("image-row", row([item({ alt: " " })]));
    assert.match(error.message, /media manifest entry the image path names/u);
  });
  await testContext.test("refuses omitted items as required", () => {
    assert.deepEqual(paths({ height: "small" }), [["content.component_data", "/attrs/componentData/items"]]);
  });
  await testContext.test("accepts twelve linked and unlinked items", () => {
    assert.deepEqual(validate("image-row", row(Array.from({ length: 12 }, (_, index) => ({ ...item(), url: index % 2 ? "/go" : "" })))), []);
  });
  await testContext.test("canonicalizes in declaration order", () => {
    assert.equal(
      canonicalizeComponentData("image-row", { align: "end", items: [{ url: "/a", image: IMAGE }], height: "small" }),
      JSON.stringify({ items: [{ image: IMAGE, url: "/a" }], height: "small", align: "end" }),
    );
  });
});

test("a social-links row needs a known platform and an https address per link, a label for a Website link, and holds 1 to 12 links (TR01324)", async (testContext) => {
  const entry = registry.components["social-links"];
  const row = (items, rest = {}) => ({ items, size: "medium", align: "start", showLabels: false, ...rest });
  const link = (overrides = {}) => ({ platform: "instagram", url: "https://www.instagram.com/shy", ...overrides });
  const paths = (data) => validate("social-links", data).map((error) => [error.code, error.path]);
  await testContext.test("accepts a valid list, an omitted and an empty label on a known platform, and canonicalizes in declaration order", () => {
    assert.deepEqual(
      paths(row([link(), link({ platform: "other", url: "https://shy.example/book", label: "Book online" }), link({ label: "" })])),
      [],
    );
    assert.deepEqual(paths(row(Array.from({ length: entry.maxItems }, () => link()))), []);
    assert.equal(
      canonicalizeComponentData("social-links", {
        showLabels: true,
        align: "end",
        items: [{ url: "https://x.com/shy", label: "On X", platform: "x" }],
        size: "large",
      }),
      JSON.stringify({ items: [{ platform: "x", url: "https://x.com/shy", label: "On X" }], size: "large", align: "end", showLabels: true }),
    );
  });
  const refusals = [
    ["an unknown platform", row([link({ platform: "myspace" })]), "/attrs/componentData/items/0/platform"],
    ["a missing platform", row([{ url: "https://x.com/shy" }]), "/attrs/componentData/items/0/platform"],
    ["a missing url", row([{ platform: "x" }]), "/attrs/componentData/items/0/url"],
    ["an empty url", row([link({ url: "" })]), "/attrs/componentData/items/0/url"],
    ["an http url", row([link({ url: "http://www.instagram.com/shy" })]), "/attrs/componentData/items/0/url"],
    ["a url with credentials", row([link({ url: "https://user:pass@www.instagram.com/shy" })]), "/attrs/componentData/items/0/url"],
    ["a padded url, judged as written", row([link({ url: "https://www.instagram.com/shy " })]), "/attrs/componentData/items/0/url"],
    [
      "a 2049-character url",
      row([link({ url: `https://example.com/${"a".repeat(2049 - "https://example.com/".length)}` })]),
      "/attrs/componentData/items/0/url",
    ],
    ["zero items", row([]), "/attrs/componentData/items"],
    ["items that is not an array", row("x"), "/attrs/componentData/items"],
    ["an item that is not an object", row(["x"]), "/attrs/componentData/items/0"],
    ["a 13th item", row(Array.from({ length: entry.maxItems + 1 }, () => link())), "/attrs/componentData/items"],
    ["a Website link without a label", row([link({ platform: "other", url: "https://shy.example" })]), "/attrs/componentData/items/0/label"],
    ["a Website link with a blank label", row([link({ platform: "other", url: "https://shy.example", label: " " })]), "/attrs/componentData/items/0/label"],
    ["a whitespace-only label on a known platform", row([link({ label: "  " })]), "/attrs/componentData/items/0/label"],
    ["a label of only U+0085 on a known platform", row([link({ label: "\u0085" })]), "/attrs/componentData/items/0/label"],
    ["a Website link labelled only U+FEFF", row([link({ platform: "other", label: "\ufeff" })]), "/attrs/componentData/items/0/label"],
    ["a 121-character label", row([link({ label: "x".repeat(entry.limits.label + 1) })]), "/attrs/componentData/items/0/label"],
    ["a non-boolean showLabels", row([link()], { showLabels: "yes" }), "/attrs/componentData/showLabels"],
    ["an unknown size", row([link()], { size: "huge" }), "/attrs/componentData/size"],
    ["an unknown align", row([link()], { align: "middle" }), "/attrs/componentData/align"],
    ["an unknown field", row([link()], { gap: "wide" }), "/attrs/componentData/gap"],
    ["an unknown item field", row([link({ icon: "x" })]), "/attrs/componentData/items/0/icon"],
  ];
  for (const [label, data, path] of refusals) {
    await testContext.test(`refuses ${label}`, () => {
      assert.deepEqual(paths(data), [["content.component_data", path]]);
    });
  }
  await testContext.test("an optional safeUrl field elsewhere still accepts an omitted and an empty value", () => {
    const grid = (items) => ({ items, columns: 3, density: "standard", borderWidth: 0 });
    assert.deepEqual(validate("product-grid", grid([{ title: "T" }])).map((error) => error.path), []);
    assert.deepEqual(validate("product-grid", grid([{ title: "T", buttonText: "", buttonUrl: "" }])).map((error) => error.path), []);
  });
});
