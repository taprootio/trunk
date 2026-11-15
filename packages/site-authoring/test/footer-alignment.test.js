import assert from "node:assert/strict";
import test from "node:test";

import {
  FOOTER_ALIGNMENT_ATTRIBUTE_NAMES,
  footerAlignmentAttributes,
  footerAlignmentProfileValues,
  footerColumnAlignmentAttributes,
  hasFooterAlignment,
  normalizeFooterLogoBox,
  normalizeFooterResponsiveAlignment,
  normalizeFooterResponsiveInlineAlignment,
} from "../src/footer-alignment.js";

test("alignment normalization retains sparse intent and discards invalid stored axes", () => {
  for (const value of [undefined, null, {}, [], "", { wide: null, wrapped: {}, stacked: { horizontal: "" } }]) {
    assert.equal(normalizeFooterResponsiveAlignment(value), undefined);
    assert.equal(normalizeFooterResponsiveInlineAlignment(value), undefined);
  }
  const source = {
    wide: { horizontal: "start", vertical: "center", textAlign: "justify" },
    wrapped: { horizontal: "end", vertical: "auto", textAlign: "auto" },
    stacked: { horizontal: " center", vertical: false, textAlign: "" },
    extra: { horizontal: "end" },
  };
  assert.deepEqual(normalizeFooterResponsiveAlignment(source), {
    wide: { horizontal: "start", vertical: "center", textAlign: "justify" },
    wrapped: { horizontal: "end", textAlign: "auto" },
  });
  assert.deepEqual(normalizeFooterResponsiveInlineAlignment(source), {
    wide: { horizontal: "start", textAlign: "justify" },
    wrapped: { horizontal: "end", textAlign: "auto" },
  });
  assert.equal(source.wrapped.vertical, "auto");
  for (const value of [undefined, null, "", "fixed", "Natural", " natural", 1, {}]) {
    assert.equal(normalizeFooterLogoBox(value), "fixed");
  }
  assert.equal(normalizeFooterLogoBox("natural"), "natural");
});

test("profile hash values keep every axis in canonical order without inheritance", () => {
  const profile = {
    wide: { horizontal: "start", vertical: "center", textAlign: "justify" },
    wrapped: { horizontal: "end", vertical: "start", textAlign: "auto" },
    stacked: { horizontal: "center", vertical: "end", textAlign: "start" },
  };
  assert.deepEqual(footerAlignmentProfileValues(profile), ["start", "center", "justify", "end", "start", "auto", "center", "end", "start"]);
  assert.deepEqual(footerAlignmentProfileValues(profile, true), ["start", "justify", "end", "auto", "center", "start"]);
  assert.deepEqual(footerAlignmentProfileValues({ stacked: { textAlign: "auto" } }), ["", "", "", "", "", "", "", "", "auto"]);
  assert.deepEqual(footerAlignmentProfileValues(undefined, true), ["", "", "", "", "", ""]);
});

test("attribute mapping emits authored region and layout choices and natural logo space only", () => {
  assert.deepEqual(footerAlignmentAttributes({ logoBox: "fixed", alignment: { wide: {} } }), {});
  assert.deepEqual(footerColumnAlignmentAttributes({}), {});
  const attributes = footerAlignmentAttributes({
    logoBox: "natural",
    alignment: { wide: { horizontal: "start", vertical: "center", textAlign: "justify" }, stacked: { horizontal: "center" } },
    brandAlignment: { wrapped: { horizontal: "end", vertical: "start", textAlign: "auto" } },
    asideAlignment: { stacked: { vertical: "end", textAlign: "center" } },
    bottomAlignment: { wide: { horizontal: "end", vertical: "center", textAlign: "start" }, stacked: { textAlign: "auto" } },
  });
  assert.deepEqual(attributes, {
    "inline-align": "start", "block-align": "center", "text-align": "justify", "inline-align-stacked": "center",
    "brand-inline-align-wrapped": "end", "brand-block-align-wrapped": "start", "brand-text-align-wrapped": "auto",
    "aside-block-align-stacked": "end", "aside-text-align-stacked": "center",
    "bottom-inline-align": "end", "bottom-text-align": "start", "bottom-text-align-stacked": "auto",
    "brand-logo-sizing": "natural",
  });
  assert.deepEqual(footerColumnAlignmentAttributes({ alignment: { stacked: { horizontal: "start", vertical: "end", textAlign: "auto" } } }), {
    "inline-align-stacked": "start", "block-align-stacked": "end", "text-align-stacked": "auto",
  });
  assert.equal(new Set(FOOTER_ALIGNMENT_ATTRIBUTE_NAMES).size, FOOTER_ALIGNMENT_ATTRIBUTE_NAMES.length);
  for (const name of Object.keys(attributes)) assert.ok(FOOTER_ALIGNMENT_ATTRIBUTE_NAMES.includes(name), name);
  assert.ok(FOOTER_ALIGNMENT_ATTRIBUTE_NAMES.includes("aside-inline-align-wrapped"));
  assert.ok(FOOTER_ALIGNMENT_ATTRIBUTE_NAMES.includes("brand-block-align"));
  assert.equal(FOOTER_ALIGNMENT_ATTRIBUTE_NAMES.includes("bottom-block-align"), false);
});

test("caller alignment CSS is conditional on authored profiles anywhere in the footer", () => {
  assert.equal(hasFooterAlignment({ logoBox: "natural", brandAlignment: { wide: { vertical: "invalid" } } }), false);
  for (const key of ["alignment", "brandAlignment", "asideAlignment", "bottomAlignment"]) {
    assert.equal(hasFooterAlignment({ [key]: { stacked: { textAlign: "auto" } } }), true, key);
  }
  assert.equal(hasFooterAlignment({ linkColumns: [{ alignment: { wide: { horizontal: "start" } } }] }), true);
  assert.equal(hasFooterAlignment({ linkColumns: [null, { alignment: {} }] }), false);
  assert.equal(hasFooterAlignment({ bottomAlignment: { wide: { vertical: "start" } } }), false);
});
