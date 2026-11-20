import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildChromeInput } from "../src/chrome-input.js";
import { CHROME_UNAVAILABLE_MESSAGE, completeChromeReport } from "../src/chrome-report.js";
import { projectFooterSettingsForWorkspace } from "../src/footer-contract.js";
import { validateAndEncodeThemePair } from "../src/theme-validation.js";

const EXAMPLE = new URL("../examples/riverbend-wellness/settings/taproot-styles.json", import.meta.url);
const FOOTER_LOGO_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_LOGO_ID = "22222222-2222-4222-8222-222222222222";

async function reportInputs(header = {}, footer = {}) {
  const { settings: style } = JSON.parse(await readFile(EXAMPLE, "utf8"));
  return {
    themes: validateAndEncodeThemePair(style.lightTheme, style.darkTheme),
    appearance: {
      style,
      header: { brandText: "Taproot", ...header },
      publishing: { allowSearch: false },
    },
    resources: { footerSettings: projectFooterSettingsForWorkspace(footer), navigation: { navItems: [] } },
  };
}

test("measures configured alpha, opposite-scheme provenance, and the standalone action with the released catalog", async () => {
  const inputs = await reportInputs({ darkBrandColor: "#0000", context: "inverted" }, { context: "raised" });
  const unknown = await completeChromeReport(inputs);
  assert.equal(unknown.unavailable, false);
  assert.equal(unknown.navigationUnavailable, false);
  assert.equal(unknown.entries.light.length, 1);
  assert.equal(unknown.entries.dark.length, 1);
  for (const scheme of ["light", "dark"]) {
    const entry = unknown.entries[scheme][0];
    assert.equal(entry.context, "inverted");
    const brand = entry.pairs.find(({ element, state }) => element === "brand-text" && state === "rest");
    assert.equal(brand.foreground, "brand-color");
    assert.equal(brand.ratio, 1);
    assert.equal(brand.required, 4.5);
    const flag = unknown.flags.find(({ element, state, scheme: actual }) => element === "brand-text" && state === "rest" && actual === scheme);
    assert.equal(flag.field, "site-header.darkBrandColor");
    assert.equal(flag.file, "settings/site-header.json");
  }
  assert.deepEqual(await completeChromeReport({ ...inputs, nameReportEnabled: false }), unknown);
  const eligible = await completeChromeReport({ ...inputs, nameReportEnabled: true });
  for (const scheme of ["light", "dark"]) {
    const footer = eligible.entries[scheme].find(({ role }) => role === "footer");
    assert.equal(footer.context, null);
    assert.ok(footer.pairs.some(({ element }) => element === "footer-action-button"));
    assert.ok(footer.pairs.some(({ background, kind }) => background === "background" && kind === "ring"));
  }
  const standalone = eligible.flags.find(({ role, element, state }) =>
    role === "footer" && element === "footer-action-button" && state === "focus");
  assert.deepEqual([standalone.context, standalone.field, standalone.file, standalone.ratio, standalone.required], [
    null, "lightTheme", "settings/taproot-styles.json", 2.73, 3,
  ]);
});

test("omits unknown contexts and preserves independent broken delivery evidence", async () => {
  const inputs = await reportInputs({ context: "absent", showBrandText: false }, {
    enabled: true,
    showBrandText: false,
    light: { logoId: FOOTER_LOGO_ID },
    dark: { logoId: OTHER_LOGO_ID },
  });
  inputs.resources.presentation = { sitePublishingPreferences: { footerSettings: {
    light: { logoId: FOOTER_LOGO_ID, logoUrl: "https://images.example.test/site-logo.png" },
    dark: { logoId: OTHER_LOGO_ID },
  } } };
  const input = buildChromeInput(inputs);
  assert.deepEqual(input.paintSurfaces.map(({ role }) => role), ["footer"]);
  const [footer] = input.paintSurfaces;
  assert.ok(footer.features.light.flags.includes("brandLink"));
  assert.ok(!footer.features.dark.flags.includes("brandLink"));
  assert.equal(input.navigationUnavailable, false);
});

test("uses bound published page paths for navigation and footer links", async () => {
  const inputs = await reportInputs({}, {
    enabled: true,
    linkColumns: [{ id: FOOTER_LOGO_ID, groups: [{
      id: OTHER_LOGO_ID,
      heading: "Links",
      links: [{ id: "33333333-3333-4333-8333-333333333333", label: "Guide", pageResourceId: OTHER_LOGO_ID }],
    }] }],
  });
  inputs.resources.navigation.navItems = [
    { kind: "NAV_ITEM_KIND_PAGE", resourceId: FOOTER_LOGO_ID, children: [] },
    { kind: "NAV_ITEM_KIND_PAGE", resourceId: OTHER_LOGO_ID, children: [] },
  ];
  inputs.resources.manifest = { pages: [
    { resourceId: FOOTER_LOGO_ID, path: "", status: "PAGE_STATUS_PUBLISHED" },
    { resourceId: OTHER_LOGO_ID, path: "guide", status: "PAGE_STATUS_DRAFT" },
  ] };
  const feature = (resources, role) => buildChromeInput({ ...inputs, resources })
    .paintSurfaces.find((surface) => surface.role === role).features.light;
  const header = feature(inputs.resources, "header");
  assert.deepEqual(header.navigation.map(({ anchor, canBeCurrent }) => [anchor, canBeCurrent]), [[true, true], [false, false]]);
  const footer = feature(inputs.resources, "footer");
  assert.ok(!footer.flags.includes("footerLinks"));
  assert.ok(!footer.flags.includes("footerHeadings"));
  inputs.resources.manifest.pages[1].status = "PAGE_STATUS_PUBLISHED";
  assert.ok(feature(inputs.resources, "footer").flags.includes("footerLinks"));

  const docs = { ...inputs.resources, settingsOnly: true };
  assert.deepEqual(feature(docs, "header").navigation, []);
  assert.ok(!feature(docs, "footer").flags.includes("footerLinks"));
});

test("uses the raw threshold decision and produces one structured flag and bounded warning per failing pair", async () => {
  const inputs = await reportInputs({ context: "raised" });
  const measure = {
    element: "brand-text",
    foreground: "headings",
    background: "layer2",
    state: "rest",
    kind: "text",
    required: 4.5,
  };
  const result = await completeChromeReport(inputs, { loadFit: async () => ({
    themeFitReportSuite: (_light, _dark, options) => {
      assert.equal(options.paintSurfaces[0].context, "raised");
      return { paint: { dark: [], light: [{
        role: "header",
        context: "raised",
        pairs: [{ ...measure, ratio: 1 }, { ...measure, ratio: 4.4999 }, { ...measure, ratio: 4.5 }],
      }] } };
    },
  }) });
  assert.equal(result.unavailable, false);
  assert.deepEqual(result.contrast, { pairs: 3, belowAa: 2 });
  assert.deepEqual(result.warnings, [
    "chrome: theme.contrast_text_below_aa; site-header.context; light header brand-text/rest; 1.00:1 < 4.50:1.",
    "chrome: theme.contrast_text_below_aa; site-header.context; light header brand-text/rest; 4.49:1 < 4.50:1.",
  ]);
  assert.deepEqual(result.flags[0], {
    code: "theme.contrast_text_below_aa",
    area: "presentation",
    file: "settings/site-header.json",
    field: "site-header.context",
    token: "headings",
    background: "layer2",
    scheme: "light",
    context: "raised",
    ratio: 1,
    required: 4.5,
    message: "header brand-text/rest paints headings on layer2 at 1.00:1. It needs 4.50:1.",
    role: "header",
    element: "brand-text",
    state: "rest",
    kind: "text",
  });
});

test("a bad report input gives the same advisory result as a failed measurement", async () => {
  const inputs = await reportInputs();
  const brokenInput = {
    ...inputs,
    resources: { ...inputs.resources, get mediaManifest() { throw new Error("cannot inspect media"); } },
  };
  let loadsForBrokenInput = 0;
  for (const report of [
    completeChromeReport(brokenInput, { loadFit: async () => { loadsForBrokenInput += 1; } }),
    completeChromeReport(inputs, { loadFit: async () => ({ themeFitReportSuite() { throw new Error("cannot measure"); } }) }),
  ]) {
    const result = await report;
    assert.equal(result.unavailable, true);
    assert.deepEqual(result.entries, { light: [], dark: [] });
    assert.deepEqual(result.flags, []);
    assert.deepEqual(result.contrast, { pairs: 0, belowAa: 0 });
    assert.deepEqual(result.warnings, [CHROME_UNAVAILABLE_MESSAGE]);
  }
  assert.equal(loadsForBrokenInput, 0);
});
