import assert from "node:assert/strict";
import test from "node:test";

import {
  FREE_FORM_SECTION_REGISTRY,
  freeFormRootPresentation,
  hasNamedFreeFormSectionContext,
  normalizeFreeFormSectionBackground,
  normalizeFreeFormSectionDecoration,
  sharedThemeContextNames,
  validateFreeFormSectionContexts,
} from "../../src/content/free-form-sections.js";
import { CONTENT_LIMITS } from "../../src/content/vocabulary.js";

const IMAGE_ID = "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607";
const processedImage = (overrides = {}) => {
  const src = overrides.src ?? "https://cdn.example.test/starburst.webp";
  return {
    imageId: IMAGE_ID,
    src,
    urls: [{ minWidth: 640, url: src, type: "image/webp" }],
    width: 1200,
    height: 1200,
    alt: "",
    ...overrides,
  };
};

test("the registry classifies flow and root-band components declaratively", () => {
  assert.equal(freeFormRootPresentation({ type: "paragraph" }).measure, "prose");
  assert.equal(freeFormRootPresentation({ type: "horizontalRule" }).measure, "wide");
  assert.equal(
    freeFormRootPresentation({ type: "componentBlock", attrs: { componentType: "hero-section" } }).rootPlacement,
    "flow",
  );
  assert.equal(
    freeFormRootPresentation({ type: "componentBlock", attrs: { componentType: "card-grid" } }).rootPlacement,
    "flow",
  );
  assert.equal(freeFormRootPresentation({ type: "componentBlock", attrs: { componentType: "unknown" } }), undefined);
  assert.ok(Object.isFrozen(FREE_FORM_SECTION_REGISTRY));
  assert.ok(Object.isFrozen(FREE_FORM_SECTION_REGISTRY.section.attrs));
});

test("theme context alternatives are the sorted intersection of light and dark themes", () => {
  assert.deepEqual(
    sharedThemeContextNames(
      { contexts: { zebra: {}, inverted: {}, lightOnly: {} } },
      { contexts: { inverted: {}, zebra: {}, darkOnly: {} } },
    ),
    ["inverted", "zebra"],
  );
  assert.deepEqual(sharedThemeContextNames({}, { contexts: { inverted: {} } }), []);
});

test("decoration normalization preserves the processed-image delivery shape and applies registry defaults", () => {
  const result = normalizeFreeFormSectionDecoration({ image: processedImage() });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.decoration, {
    image: processedImage(),
    anchor: "center",
    inlineOffsetPercent: 0,
    blockOffsetPercent: 0,
    inlineSizePercent: 40,
    opacity: 0.12,
    tint: "heading",
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.decoration));
  assert.ok(Object.isFrozen(result.decoration.image));
  assert.ok(Object.isFrozen(result.decoration.image.urls));
});

test("decoration normalization derives every enum, bound, and tint token from registry version 4", () => {
  const decoration = FREE_FORM_SECTION_REGISTRY.section.attrs.decoration;
  assert.equal(FREE_FORM_SECTION_REGISTRY.version, 4);
  assert.equal(decoration.closed, true);
  assert.deepEqual(decoration.fields.anchor.values, [
    "top-start",
    "top-end",
    "bottom-start",
    "bottom-end",
    "center",
  ]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(decoration.fields).filter(([, field]) => field.minimum !== undefined).map(
      ([name, field]) => [name, [field.minimum, field.maximum, field.default]],
    )),
    {
      inlineOffsetPercent: [-50, 50, 0],
      blockOffsetPercent: [-50, 50, 0],
      inlineSizePercent: [10, 100, 40],
      opacity: [0, 1, 0.12],
    },
  );
  assert.deepEqual(decoration.fields.tint.tokenByValue, {
    accent: "--esp-color-link",
    heading: "--esp-color-headings",
    text: "--esp-color-text",
    action: "--esp-color-action-background",
    border: "--esp-color-border",
  });
});

test("background normalization preserves both processed images and applies canonical defaults", () => {
  const portrait = processedImage({
    imageId: "9a8b7c6d-5e4f-4321-a098-76543210fedc",
    src: "https://cdn.example.test/portrait.webp",
  });
  const result = normalizeFreeFormSectionBackground({
    image: processedImage(),
    portraitImage: portrait,
    focus: { x: 0.6 },
    portraitFocus: { y: 0.25 },
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.background, {
    image: processedImage(),
    portraitImage: portrait,
    focus: { x: 0.6, y: 0.5 },
    portraitFocus: { x: 0.5, y: 0.25 },
    scrimStrength: "medium",
  });
  assert.ok(Object.isFrozen(result.background));
  assert.ok(Object.isFrozen(result.background.image));
  assert.ok(Object.isFrozen(result.background.portraitImage));
  assert.ok(Object.isFrozen(result.background.focus));
  assert.ok(Object.isFrozen(result.background.portraitFocus));

  assert.deepEqual(normalizeFreeFormSectionBackground({ image: processedImage() }).background, {
    image: processedImage(),
    portraitImage: null,
    focus: { x: 0.5, y: 0.5 },
    portraitFocus: null,
    scrimStrength: "medium",
  });
});

test("background validation is closed and validates both image paths, both focal points, and scrim", async (context) => {
  const cases = [
    ["background scalar", "photo", "content.attr_invalid", "/attrs/background"],
    ["unknown field", { image: processedImage(), overlay: 0.5 }, "content.attr_unknown", "/attrs/background/overlay"],
    ["missing image", {}, "content.image_keys", "/attrs/background/image"],
    [
      "landscape delivery",
      { image: processedImage({ src: "http://cdn.example.test/photo.webp" }) },
      "content.attr_invalid",
      "/attrs/background/image/src",
    ],
    [
      "portrait delivery",
      { image: processedImage(), portraitImage: processedImage({ urls: [{ minWidth: 640, url: "//bad.test" }] }) },
      "content.attr_invalid",
      "/attrs/background/portraitImage/urls/0/url",
    ],
    [
      "candidate lower bound",
      { image: processedImage({ urls: [] }) },
      "content.attr_invalid",
      "/attrs/background/image/urls",
    ],
    [
      "candidate upper bound",
      { image: processedImage({
        urls: Array.from({ length: 6 }, (_, index) => ({
          minWidth: index + 1,
          url: "https://cdn.example.test/starburst.webp",
          type: "image/webp",
        })),
      }) },
      "content.attr_invalid",
      "/attrs/background/image/urls",
    ],
    [
      "candidate width",
      { image: processedImage({ urls: [{ minWidth: 640.5, url: "https://cdn.example.test/starburst.webp" }] }) },
      "content.attr_invalid",
      "/attrs/background/image/urls/0/minWidth",
    ],
    [
      "candidate type",
      { image: processedImage({ urls: [{ minWidth: 640, url: "https://cdn.example.test/starburst.webp", type: "image/png" }] }) },
      "content.attr_invalid",
      "/attrs/background/image/urls/0/type",
    ],
    [
      "primary candidate mismatch",
      { image: processedImage({ urls: [{ minWidth: 640, url: "https://cdn.example.test/other.webp" }] }) },
      "content.attr_invalid",
      "/attrs/background/image/src",
    ],
    ["focus x", { image: processedImage(), focus: { x: -0.1 } }, "content.attr_invalid", "/attrs/background/focus/x"],
    [
      "portrait focus y",
      { image: processedImage(), portraitFocus: { y: 1.1 } },
      "content.attr_invalid",
      "/attrs/background/portraitFocus/y",
    ],
    [
      "focus field",
      { image: processedImage(), focus: { x: 0.5, y: 0.5, z: 0 } },
      "content.attr_unknown",
      "/attrs/background/focus/z",
    ],
    [
      "scrim",
      { image: processedImage(), scrimStrength: "opaque" },
      "content.attr_invalid",
      "/attrs/background/scrimStrength",
    ],
  ];

  for (const [name, value, code, path] of cases) {
    await context.test(name, () => {
      const result = normalizeFreeFormSectionBackground(value);
      assert.equal(result.background, undefined);
      assert.ok(result.errors.some((error) => error.code === code && error.path === path), JSON.stringify(result.errors));
    });
  }
});

test("the registry is the source of truth for bounded section scrim opacity", () => {
  const scrim = FREE_FORM_SECTION_REGISTRY.section.attrs.background.fields.scrimStrength;
  assert.deepEqual(scrim.values, ["none", "soft", "medium", "strong"]);
  assert.equal(scrim.default, "medium");
  assert.deepEqual(scrim.opacityByValue, { none: 0, soft: 0.28, medium: 0.48, strong: 0.68 });
});

test("decoration validation reports closed-shape, range, type, and delivery failures at stable paths", async (context) => {
  const cases = [
    ["decoration scalar", "not-an-object", "content.attr_invalid", "/attrs/decoration"],
    ["unknown decoration field", { image: processedImage(), color: "red" }, "content.attr_unknown", "/attrs/decoration/color"],
    ["missing image", {}, "content.image_keys", "/attrs/decoration/image"],
    [
      "unknown image field",
      { image: processedImage({ svg: "<svg/>" }) },
      "content.attr_unknown",
      "/attrs/decoration/image/svg",
    ],
    [
      "missing delivery key",
      { image: { imageId: IMAGE_ID, src: "https://cdn.example.test/starburst.webp" } },
      "content.image_keys",
      "/attrs/decoration/image/urls",
    ],
    ["missing primary delivery", { image: processedImage({ src: "" }) }, "content.image_keys", "/attrs/decoration/image/src"],
    [
      "insecure primary delivery",
      { image: processedImage({ src: "http://cdn.example.test/starburst.webp" }) },
      "content.attr_invalid",
      "/attrs/decoration/image/src",
    ],
    [
      "protocol-relative responsive delivery",
      { image: processedImage({ urls: [{ minWidth: 640, url: "//evil.example/starburst.webp" }] }) },
      "content.attr_invalid",
      "/attrs/decoration/image/urls/0/url",
    ],
    [
      "responsive delivery key",
      { image: processedImage({ urls: [{ minWidth: 640, url: "/starburst.webp", css: "url(x)" }] }) },
      "content.attr_unknown",
      "/attrs/decoration/image/urls/0/css",
    ],
    [
      "responsive candidate count",
      { image: processedImage({ urls: [] }) },
      "content.attr_invalid",
      "/attrs/decoration/image/urls",
    ],
    [
      "primary candidate mismatch",
      { image: processedImage({ urls: [{ minWidth: 640, url: "/other.webp", type: "image/webp" }] }) },
      "content.attr_invalid",
      "/attrs/decoration/image/src",
    ],
    ["anchor", { image: processedImage(), anchor: "top" }, "content.attr_invalid", "/attrs/decoration/anchor"],
    [
      "offset range",
      { image: processedImage(), inlineOffsetPercent: -51 },
      "content.attr_invalid",
      "/attrs/decoration/inlineOffsetPercent",
    ],
    [
      "integer size",
      { image: processedImage(), inlineSizePercent: 10.5 },
      "content.attr_invalid",
      "/attrs/decoration/inlineSizePercent",
    ],
    ["finite opacity", { image: processedImage(), opacity: Number.NaN }, "content.attr_invalid", "/attrs/decoration/opacity"],
    ["semantic tint", { image: processedImage(), tint: "--esp-color-link" }, "content.attr_invalid", "/attrs/decoration/tint"],
  ];

  for (const [name, value, code, path] of cases) {
    await context.test(name, () => {
      const result = normalizeFreeFormSectionDecoration(value);
      assert.equal(result.decoration, undefined);
      assert.ok(result.errors.some((error) => error.code === code && error.path === path), JSON.stringify(result.errors));
    });
  }
});

test("named-context detection distinguishes root flow from a staged theme dependency", () => {
  assert.equal(hasNamedFreeFormSectionContext({
    type: "doc",
    content: [{ type: "paragraph" }, { type: "section", attrs: { context: null }, content: [] }],
  }), false);
  assert.equal(hasNamedFreeFormSectionContext({
    type: "doc",
    content: [{ type: "section", attrs: { context: "inverted" }, content: [{ type: "paragraph" }] }],
  }), true);
});

test("explicit context validation reports every invalid value with sorted alternatives", () => {
  const result = validateFreeFormSectionContexts({
    type: "doc",
    content: [
      { type: "section", attrs: { context: "zebra" }, content: [{ type: "paragraph" }] },
      { type: "section", content: [{ type: "paragraph" }] },
      { type: "section", attrs: { context: "missing" }, content: [{ type: "paragraph" }] },
    ],
  }, ["zebra", "alpha"]);

  assert.deepEqual(result.errors.map((error) => [error.code, error.path]), [[
    "content.section_context_unknown",
    "/content/2/attrs/context",
  ]]);
  assert.match(result.errors[0].message, /'missing'/u);
  assert.match(result.errors[0].message, /alpha, zebra/u);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.errors));
});

test("context diagnostics stop traversing at the document error bound", () => {
  const bomb = {};
  Object.defineProperty(bomb, "type", {
    get() {
      throw new Error("validation traversed past the diagnostic bound");
    },
  });
  const sections = Array.from({ length: CONTENT_LIMITS.documentErrors }, (_, index) => ({
    type: "section",
    attrs: { context: `missing${index}` },
    content: [{ type: "paragraph" }],
  }));

  const result = validateFreeFormSectionContexts({ type: "doc", content: [...sections, bomb] }, []);

  assert.equal(result.errors.length, CONTENT_LIMITS.documentErrors);
});
