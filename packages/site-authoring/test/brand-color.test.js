import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveBrandColorToken,
  resolveBrandColors,
  resolveBrandColorSourceFields,
  resolveFooterBrandColors,
  resolveHeaderBrandColor,
} from "../src/brand-color.js";

for (const [value, token, rendered] of [
  [" --esp-color-link ", "--esp-color-link", "var(--esp-color-link)"],
  ["#aBcD", "#aBcD", "#aBcD"],
  ["oklch(0.5 0.1 220)", "oklch(0.5 0.1 220)", "oklch(0.5 0.1 220)"],
  [undefined, "", ""],
  ["", "", ""],
  ["--esp-color-layer-2", "", ""],
  ["rgb(1 2 3)", "", ""],
  ["oklch(1.1 0.1 220)", "", ""],
  ["oklch(0.5 0.26 220)", "", ""],
  ["oklch(0.5 0.1 361)", "", ""],
  ["#fff; color: red", "", ""],
]) {
  test(`resolves ${JSON.stringify(value)} to the same raw and rendered color`, () => {
    assert.equal(resolveBrandColorToken(value), token);
    assert.equal(resolveHeaderBrandColor(value), rendered);
  });
}

test("uses the same fallback chain for raw semantic names and rendered colors", () => {
  const input = { brandColor: "--esp-color-link", lightBrandColor: "invalid", darkBrandColor: "#fff" };
  assert.deepEqual(resolveBrandColors(input, resolveBrandColorToken), {
    light: "--esp-color-link", dark: "#fff", generic: "--esp-color-link",
  });
  assert.deepEqual(resolveBrandColors(input), {
    light: "var(--esp-color-link)", dark: "#fff", generic: "var(--esp-color-link)",
  });
  assert.deepEqual(resolveBrandColors(undefined), { light: "", dark: "", generic: "" });
});

test("preserves the footer's raw dark-only value without copying it to light", () => {
  assert.deepEqual(resolveFooterBrandColors({ light: "", dark: "--esp-color-link" }), {
    light: "", dark: "--esp-color-link", generic: "--esp-color-link",
  });
});

for (const [name, input, expected] of [
  ["equal valid overrides", { brandColor: "#abc", lightBrandColor: "#abc", darkBrandColor: "#abc" },
    { light: "lightBrandColor", dark: "darkBrandColor" }],
  ["valid generic with invalid light override", { brandColor: "--esp-color-link", lightBrandColor: "invalid", darkBrandColor: "#abcd" },
    { light: "brandColor", dark: "darkBrandColor" }],
  ["dark-only override", { darkBrandColor: "#abcd" },
    { light: "darkBrandColor", dark: "darkBrandColor" }],
  ["light-only override", { lightBrandColor: " --esp-color-text " },
    { light: "lightBrandColor", dark: "lightBrandColor" }],
  ["invalid or absent colors", { brandColor: "rgb(1 2 3)" },
    { light: undefined, dark: undefined }],
]) {
  test(`reports the actual brand-color source for ${name}`, () => {
    const sources = resolveBrandColorSourceFields(input);
    assert.deepEqual(sources, expected);
    const resolved = resolveBrandColors(input, resolveBrandColorToken);
    for (const scheme of ["light", "dark"]) {
      assert.equal(resolved[scheme] || resolved.generic, resolveBrandColorToken(input[sources[scheme]]));
    }
  });
}
