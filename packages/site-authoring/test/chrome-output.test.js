import assert from "node:assert/strict";
import test from "node:test";

import { resolveBrandColors, resolveBrandColorToken, resolveFooterBrandColors } from "../src/brand-color.js";
import { chromeFeatures, standaloneFooterActionEntries } from "../src/chrome-features.js";
import { decodeChromePair, displayChromeContext, indexChromePaint } from "../src/chrome-output.js";
import taprootCatalog from "../src/chrome-paint-catalog-taproot.json" with { type: "json" };
import { loadEspalierShared } from "../src/espalier-shared.js";
import { CHROME_BYTE_BUDGET } from "../src/verbs/theme-resolve.js";

const SCHEMES = ["light", "dark"];

test("indexes only selected paint identities and retains order, requirements and the raw AA outcome", () => {
  const text = { element: "brand-text", foreground: "headings", background: "layer2", state: "rest", kind: "text" };
  const ring = { element: "brand-link", foreground: "link", background: "layer2", state: "focus", kind: "ring" };
  const entries = { dark: [{ role: "footer", context: null, pairs: [
    { ...text, ratio: 4.5 - 1e-12, required: 4.5 },
    { ...ring, ratio: 3 - 1e-12, required: 3 },
    { ...text, ratio: 4.5, required: 4.5 },
    { ...ring, ratio: 3.019, required: 3 },
  ] }] };

  const { chrome, chromeCatalog } = JSON.parse(JSON.stringify(indexChromePaint(entries)));
  assert.deepEqual(chromeCatalog, {
    elements: ["brand-link", "brand-text"],
    colors: ["headings", "layer2", "link"],
    states: ["focus", "rest"],
    kinds: ["ring", "text"],
    pairs: [[0, 2, 1, 0, 0], [1, 0, 1, 1, 1]],
  });
  assert.deepEqual(chrome, { dark: [{ role: "footer", context: null, pairs: [
    [1, 4.49, 4.5], [0, 2.99, 3], [1, 4.5, 4.5], [0, 3.01, 3],
  ] }] });
  assert.deepEqual(chrome.dark[0].pairs.map((row) => decodeChromePair(chromeCatalog, row)), [
    { ...text, ratio: 4.49, required: 4.5 },
    { ...ring, ratio: 2.99, required: 3 },
    { ...text, ratio: 4.5, required: 4.5 },
    { ...ring, ratio: 3.01, required: 3 },
  ]);
  assert.deepEqual(indexChromePaint({ light: [] }), {
    chrome: { light: [] },
    chromeCatalog: { elements: [], colors: [], states: [], kinds: [], pairs: [] },
  });
});

test("labels a truncated context without changing root or names that fit", () => {
  const name = "x".repeat(128);
  assert.deepEqual(displayChromeContext(null), { context: null });
  assert.deepEqual(displayChromeContext(name), { context: name });
  assert.deepEqual(displayChromeContext(`${name}-a`), { context: name, contextTruncated: true, contextLength: 130 });
});

function maximalNavigation() {
  let nextId = 0;
  const id = () => `a885f264-5717-4562-b3fc-${String(++nextId).padStart(12, "0")}`;
  const group = (children) => ({ id: id(), kind: "NAV_ITEM_KIND_GROUP_HEADER", children });
  const page = (path, appearance) => ({ id: id(), resourceId: id(), kind: "NAV_ITEM_KIND_PAGE", url: path, appearance });
  const external = (path, appearance) => ({
    id: id(), kind: "NAV_ITEM_KIND_EXTERNAL_URL", url: `https://example.test/${path}`, externalUrl: `https://example.test/${path}`, appearance,
  });
  const button = "NAV_ITEM_APPEARANCE_BUTTON";
  const leaves = (depth) => [page(`/published-${depth}`), page(""), external(`external-${depth}`),
    page(`/page-button-${depth}`, button), external(`external-button-${depth}`, button)];
  return [...leaves("top"), group([...leaves("nested"), group([page("/deep")])])];
}

const MAXIMAL_FOOTER = {
  enabled: true,
  asideBodyContent: { paragraphs: [{ runs: [{ text: "Footer copy" }] }] },
  linkColumns: [{ groups: [{ heading: "Read more", links: [{ label: "Guide", externalUrl: "https://example.test/guide" }] }] }],
  socialLinks: [{ platform: "instagram", url: "https://www.instagram.com/taprootwitness" }],
};

function optionalBrandSettings() {
  // The three slots may be authored independently. Values change the measured ratio, while
  // their presence chooses between the catalog's brand-color identifier and headings fallback.
  return [false, true].flatMap((useLight) => [false, true].flatMap((useDark) => [false, true].map((useGeneric) => ({
    lightBrandColor: useLight ? "#123456" : "",
    darkBrandColor: useDark ? "--esp-color-text" : "",
    brandColor: useGeneric ? "--esp-color-primary" : "",
  }))));
}

test("bounds every reachable selection of the released and Taproot paint catalogs", async () => {
  const [
    { PAINT_CATALOG, enabledPaintEntries }, { resolveConfiguredBrandColor }, { firstPaintByIdentity }, { paintRequiredRatio },
  ] = await Promise.all(["paint-catalog.js", "configured-brand-color.js", "paint-identity.js", "paint-color.js"].map(loadEspalierShared));
  const extras = { footer: [...taprootCatalog.footer, ...standaloneFooterActionEntries(PAINT_CATALOG.footer)] };
  const maximalFacts = { header: [], footer: [] };
  const contextName = "budget-".repeat(30);
  const navItems = maximalNavigation();
  let maxBytes = 0;
  for (const navDrawerStyle of ["full-screen", "panel"]) {
    for (const footer of ["embedded", "standalone", "off"]) {
      for (const headerColors of optionalBrandSettings()) {
        const headerBrand = resolveBrandColors(headerColors, resolveBrandColorToken);
        const footerBrand = resolveFooterBrandColors(headerBrand);
        const colors = { header: headerBrand, footer: footerBrand };
        const hasConfiguredBrand = Object.values(headerColors).some(Boolean);
        for (const brand of ["text", "light-only", "dark-only"]) {
          const features = chromeFeatures({
            headerSettings: {
              navDrawerStyle, navMenuDisplay: "auto", headerLayout: "standard", headerPosition: "fixed",
              headerHeightMultiplier: "3.0", headerMinHeightMultiplier: "1.0", brandText: "Budget witness", showThemeToggle: true,
            },
            footerSettings: footer === "embedded" ? { ...MAXIMAL_FOOTER, showBrandText: brand === "text" } : { enabled: false },
            navItems,
            logoPairs: { footer: {
              light: { url: brand === "light-only" ? "https://example.test/light.png" : "" },
              dark: { url: brand === "dark-only" ? "https://example.test/dark.png" : "" },
            } },
            searchEnabled: true, hasIconSprite: true, nameReportEnabled: footer !== "off",
          });
          if (!hasConfiguredBrand && brand === "text") {
            for (const [role, facts] of Object.entries(features)) maximalFacts[role].push(facts.light);
          }
          const entries = Object.fromEntries(SCHEMES.map((scheme) => [scheme, Object.entries(features).map(([role, facts]) => {
            const brandColor = resolveConfiguredBrandColor(colors[role][scheme], colors[role].generic);
            assert.equal(Boolean(brandColor), hasConfiguredBrand, "header and footer use the same configured-brand fallback");
            const builtIn = enabledPaintEntries(role, facts[scheme], PAINT_CATALOG, { brandColor });
            const extension = enabledPaintEntries(role, facts[scheme], extras, { brandColor });
            // Ratios are within 1..21 and floored to two decimal places. 20.99 fills all five bytes.
            const pairs = [...firstPaintByIdentity([...builtIn, ...extension]).values()]
              .map((pair) => ({ ...pair, ratio: 20.99, required: paintRequiredRatio(pair.kind) }));
            if (role === "footer" && footer === "embedded") {
              assert.equal(pairs.some(({ element }) => element === "brand-link"), brand === "text" || brand === `${scheme}-only`);
            }
            return { role, context: role === "footer" && footer === "standalone" ? null : contextName, pairs };
          })]));
          const payload = indexChromePaint(entries);
          for (const cards of Object.values(payload.chrome)) {
            for (const card of cards) {
              // Accepted names have ASCII prefixes. Use the largest safe-integer width for their original length.
              if (card.contextTruncated) card.contextLength = Number.MAX_SAFE_INTEGER;
            }
          }
          maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(payload)));
        }
      }
    }
  }

  // Gates only add pairs. Check every catalog row against the maximal settings, with the three
  // explicit render exclusions. Drawer-only, missing navigation or roles, disabled controls,
  // other brand visibility and filtered schemes/contexts all remove rows from these cases.
  for (const catalog of [PAINT_CATALOG, extras]) {
    for (const [role, entries] of Object.entries(catalog)) {
      for (const entry of entries) {
        const unreachable = entry.navigation?.icon === true
          || (entry.navigation?.kind === "group" && entry.navigation.canBeCurrent === true)
          || entry.flags.includes("footerActionIcon");
        const covered = maximalFacts[role].some((facts) => enabledPaintEntries(role, facts, { [role]: [entry] }).length > 0);
        assert.equal(covered, !unreachable, `${entry.element}/${entry.state} gates: ${entry.flags.join(", ")}`);
      }
    }
  }
  // Deleting rows can only remove dictionary strings and identities. Since each dictionary is
  // sorted, surviving indexes can only decrease in value and digit count, even after reordering.
  // This covers both the card indexes and the individual field indexes in catalog pair tuples.
  const reserve = Math.ceil((maxBytes + 1) * 1.25 / 1024) * 1024;
  assert.equal(reserve, CHROME_BYTE_BUDGET, `${maxBytes} chrome bytes before margin and the outer JSON separator`);
});
