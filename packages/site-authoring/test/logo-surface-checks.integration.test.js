import assert from "node:assert/strict";
import test from "node:test";
import { evaluateLogoSurfaceChecks } from "../src/logo-surface-checks.js";
import { THEME_EXAMPLE } from "../src/presentation-reference.js";
import { loadThemeEngines } from "../src/theme-resolve.js";

const styles = () => ({
  ...structuredClone(THEME_EXAMPLE),
  lightLogoId: "11111111-1111-4111-8111-111111111111",
  darkLogoId: "22222222-2222-4222-8222-222222222222",
});

test("real fit reports and color engine evaluate each surface's compiled layer2", async () => {
  const result = await evaluateLogoSurfaceChecks({ styles: styles(), header: { context: "inverted" }, footer: { enabled: true, context: "inverted", logoVariant: "light" } });
  assert.deepEqual(result.findings.items.map(item => [item.subject, item.detail]), [["header", "light:light"], ["footer", "light:light"], ["footer", "dark:light"]]);
  assert.equal(result.siteChecks.skipped, undefined);
});

test("real color parsing handles percent oklch, hex and rgb report values at the brightness boundary", async context => {
  const engines = await loadThemeEngines();
  for (const [css, mismatch] of [["oklch(49% 0 0)", true], ["oklch(50% 0 0)", false], ["#000000", true], ["rgb(255 255 255)", false]]) {
    await context.test(css, async () => {
      const loadEngines = async () => ({ ...engines, fit: { ...engines.fit, themeFitReportSuite: (...args) => {
        const suite = engines.fit.themeFitReportSuite(...args);
        return Object.fromEntries(["light", "dark"].map(scheme => [scheme, suite[scheme].map(report => ({ ...report, tokens: report.tokens.map(token => token.token === "layer2" ? { ...token, resolved: css } : token) }))]));
      } } });
      const result = await evaluateLogoSurfaceChecks({ styles: styles(), header: { logoVariant: "light" } }, { loadEngines });
      assert.equal(result.findings.total, mismatch ? 2 : 0);
    });
  }
});
