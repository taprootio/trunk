import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import corpus from "./fixtures/footer-fit-corpus.json" with { type: "json" };
import { buildFooterFitInput, CALIBRATION_FIT_ASSUMPTIONS, footerFitFindings } from "../src/footer-fit.js";
import { readFooterBrandInputs } from "../src/footer-brand-inputs.js";

for (const testCase of corpus.cases) {
  test(`footer fit corpus: ${testCase.name}`, () => {
    const assumptions = testCase.assumptions === "calibration" ? CALIBRATION_FIT_ASSUMPTIONS : testCase.assumptions;
    const input = testCase.settings === undefined ? testCase.input : buildFooterFitInput(testCase.settings, testCase.brand);
    if (testCase.presence) assert.deepEqual({ brand: Boolean(input.brand), aside: Boolean(input.aside), columns: input.columns.length }, testCase.presence);
    assert.deepEqual(footerFitFindings(input, assumptions), testCase.expected);
  });
}

test("optional brand files are read independently when missing or unreadable", async context => {
  const logoId = "11111111-1111-4111-8111-111111111111";
  for (const [name, header, styles, expected] of [
    ["both", { brandText: "Studio" }, { lightLogoId: logoId }, { brandText: "Studio", hasLogo: true }],
    ["header missing", undefined, { darkLogoId: logoId }, { brandText: "", hasLogo: true }],
    ["styles missing", { brandText: "Studio" }, undefined, { brandText: "Studio", hasLogo: false }],
    ["both missing", undefined, undefined, { brandText: "", hasLogo: false }],
    ["header unreadable", "{", { lightLogoId: logoId }, { brandText: "", hasLogo: true }],
    ["styles unreadable", { brandText: "Studio" }, "{", { brandText: "Studio", hasLogo: false }],
  ]) {
    await context.test(name, async child => {
      const root = await mkdtemp(path.join(os.tmpdir(), "footer-brand-inputs-"));
      child.after(() => rm(root, { recursive: true, force: true }));
      await mkdir(path.join(root, "settings"));
      for (const [file, settings] of [["site-header.json", header], ["taproot-styles.json", styles]]) {
        if (settings !== undefined) await writeFile(path.join(root, "settings", file), typeof settings === "string" ? settings : JSON.stringify({ settings }));
      }
      assert.deepEqual(await readFooterBrandInputs(root), expected);
    });
  }
});

test("offline footer logos keep the brand present without a site logo and retain the conservative ratio", async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "footer-custom-logo-inputs-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const scheme of ["light", "dark"]) {
    const settings = { enabled: true, logoScale: "5.0", [scheme]: { logoId: "11111111-1111-4111-8111-111111111111" } };
    const brand = await readFooterBrandInputs(root, settings);
    assert.deepEqual(brand, { brandText: "", hasLogo: true });
    const input = buildFooterFitInput(settings, brand);
    assert.equal(input.brand.hasLogo, true);
    assert.equal(input.brand.logoAspectRatio, undefined);
    assert.equal(input.brand.logoScale, "5.0");
  }
  assert.equal((await readFooterBrandInputs(root, { light: { logoId: "" }, dark: { logoId: "unknown" } })).hasLogo, false);
});
