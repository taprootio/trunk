import assert from "node:assert/strict";
import test from "node:test";
import { evaluateLogoSurfaceChecks, LOGO_ON_SURFACE_RULE } from "../src/logo-surface-checks.js";

const LIGHT = "11111111-1111-4111-8111-111111111111";
const DARK = "22222222-2222-4222-8222-222222222222";
const LIGHT_COMPACT = "33333333-3333-4333-8333-333333333333";
const DARK_COMPACT = "44444444-4444-4444-8444-444444444444";

const styles = overrides => ({ lightTheme: {}, darkTheme: {}, lightLogoId: LIGHT, darkLogoId: DARK, ...overrides });
const engines = async () => ({
  fit: { ROOT_SURFACE: ":root", themeFitReportSuite: () => Object.fromEntries(["light", "dark"].map(scheme => [scheme, [
    { surface: ":root", tokens: [{ token: "layer2", resolved: "0.2" }] },
    { surface: "pale", tokens: [{ token: "layer2", resolved: "0.8" }] },
    { surface: "boundary", tokens: [{ token: "layer2", resolved: "0.5" }] },
  ]])) },
  color: { parseCssColor: value => ({ l: Number(value) }) },
});
const check = (input, loader = engines) => evaluateLogoSurfaceChecks(input, { loadEngines: loader });

test("logo warnings measure the chosen surface and classify the resolved artwork", async context => {
  for (const [variant, surface, expected] of [
    ["", "", ["light:light"]], ["light", "", ["light:light", "dark:light"]],
    ["dark", "", []], ["dark", "pale", ["light:dark", "dark:dark"]],
    ["light", "boundary", []], ["dark", "boundary", ["light:dark", "dark:dark"]],
    ["unknown-stored", "", ["light:light"]],
  ]) {
    await context.test(`${variant || "match"}/${surface || "root"}`, async () => {
      const result = await check({ styles: styles(), header: { logoVariant: variant, context: surface } });
      assert.deepEqual(result.findings.items.map(item => item.detail), expected);
      assert.equal(result.findings.total, expected.length);
      for (const item of result.findings.items) {
        assert.equal(item.rule, LOGO_ON_SURFACE_RULE);
        assert.equal(item.file, "settings/site-header.json");
        assert.equal(item.subject, "header");
        assert.equal("path" in item, false);
      }
    });
  }
});

test("compact fixability is per slot, with eligibility applied before the resolver", async context => {
  for (const [position, height, minimum, warns] of [
    ["fixed", "3.8", "1.9", true], ["normal", "3.8", "1.9", false],
    ["fixed", "1.0", "", false], ["fixed", "3.8", "3.8", false],
  ]) {
    await context.test(`${position}/${height}/${minimum}`, async () => {
      const result = await check({ styles: styles({ lightCompactLogoId: LIGHT_COMPACT }), header: {
        headerPosition: position, headerHeightMultiplier: height, headerMinHeightMultiplier: minimum,
      } });
      assert.equal(result.findings.items.some(item => item.detail === "dark:compact:light"), warns);
    });
  }
  const identicalRegular = await check({ styles: styles({ darkLogoId: LIGHT, lightCompactLogoId: LIGHT_COMPACT, darkCompactLogoId: DARK_COMPACT }), header: { headerPosition: "fixed", headerHeightMultiplier: "3.8" } });
  assert.deepEqual(identicalRegular.findings.items.map(item => item.detail), ["light:compact:light"]);
});

test("a forced variant does not skip its differing alternate or mislabel a fallback image", async () => {
  const forced = await check({ styles: styles({ lightCompactLogoId: LIGHT_COMPACT }), header: { logoVariant: "light", headerPosition: "fixed", headerHeightMultiplier: "3.8" } });
  assert.ok(forced.findings.items.some(item => item.detail === "dark:compact:light"));
  const fallback = await check({ styles: styles({ darkLogoId: "", darkCompactLogoId: DARK_COMPACT }), header: { logoVariant: "dark", headerPosition: "fixed", headerHeightMultiplier: "3.8" } });
  assert.equal(fallback.findings.items.some(item => !item.detail.includes("compact")), false);
  assert.equal(fallback.findings.items.some(item => item.detail.endsWith(":light")), false);
});

test("footer forcing chooses its own overrides and ignores the header choice", async () => {
  const footer = { enabled: true, logoVariant: "light", context: "", light: { logoId: LIGHT_COMPACT }, dark: { logoId: DARK_COMPACT } };
  const result = await check({ styles: styles(), header: { logoVariant: "dark" }, footer });
  assert.deepEqual(result.findings.items.map(item => [item.subject, item.detail]), [["footer", "light:light"], ["footer", "dark:light"]]);
});

test("a visible footer logo is checked when another variant resolves to no artwork", async () => {
  const input = { styles: styles({ lightLogoId: "", darkLogoId: "" }), footer: { enabled: true, light: { logoId: LIGHT } } };
  const visible = await check(input);
  assert.deepEqual(visible.findings.items.map(item => [item.subject, item.detail]), [["footer", "light:light"]]);
  const absent = await check({ ...input, footer: { ...input.footer, logoVariant: "dark" } }, async () => assert.fail("an empty selected slot should not load engines"));
  assert.equal(absent.findings.total, 0);
  assert.deepEqual(absent.siteChecks.skipped, [LOGO_ON_SURFACE_RULE]);
});

test("one-image, hidden, absent and ambiguous-artwork slots remain unchecked", async context => {
  for (const [name, input] of [
    ["one site logo", { styles: styles({ darkLogoId: "" }) }],
    ["disabled footer", { styles: styles({ lightLogoId: "", darkLogoId: "" }), footer: { enabled: false, light: { logoId: LIGHT }, dark: { logoId: DARK } } }],
    ["hidden brand", { styles: styles({ lightLogoId: "", darkLogoId: "" }), footer: { enabled: true, showBrand: false, light: { logoId: LIGHT }, dark: { logoId: DARK } } }],
    ["no artwork", { styles: styles({ lightLogoId: "", darkLogoId: "" }) }],
    ["same artwork both schemes", { styles: styles({ darkLogoId: LIGHT }) }],
    ["explicit profile only", { styles: styles({ lightLogoId: "", darkLogoId: "" }), profileLogoFallbackUrl: "profile" }],
  ]) {
    await context.test(name, async () => {
      const result = await check(input, async () => assert.fail("an unfixable slot should not load engines"));
      assert.equal(result.findings.total, 0);
      assert.deepEqual(result.siteChecks.skipped, [LOGO_ON_SURFACE_RULE]);
    });
  }
});

test("explicit profile fallback is resolved without treating it as light-scheme uploaded artwork", async () => {
  const input = { styles: styles({ lightLogoId: "" }), profileLogoFallbackUrl: "profile", header: { context: "pale", logoVariant: "dark" } };
  const result = await check(input);
  assert.deepEqual(result.findings.items.map(item => item.detail), ["light:dark", "dark:dark"]);
  const profile = await check({ ...input, header: { ...input.header, logoVariant: "light" } });
  assert.equal(profile.findings.total, 0);
});

test("the step names unavailable engines and absent themes as skipped", async () => {
  let calls = 0;
  const unavailable = async () => { calls += 1; throw new Error("engine unavailable"); };
  const noTheme = await check({ styles: { lightLogoId: LIGHT, darkLogoId: DARK } }, unavailable);
  assert.equal(calls, 0);
  const failed = await check({ styles: styles() }, unavailable);
  assert.equal(calls, 1);
  for (const result of [noTheme, failed]) {
    assert.equal(result.findings.total, 0);
    assert.deepEqual(result.siteChecks, { ranOffline: [LOGO_ON_SURFACE_RULE], skipped: [LOGO_ON_SURFACE_RULE] });
  }
});
