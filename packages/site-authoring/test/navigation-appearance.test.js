import assert from "node:assert/strict";
import test from "node:test";
import { projectNavigationForWorkspace, validateNavigationWorkspaceDocument } from "../src/verbs/nav-push.js";

const siteId = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000002";
const childId = "00000000-0000-4000-8000-000000000003";
const grandchildId = "00000000-0000-4000-8000-000000000004";
const link = { id, kind: "NAV_ITEM_KIND_EXTERNAL_URL", title: "Sign in", externalUrl: "https://app.example.com/sign-in" };
const heading = { id, kind: "NAV_ITEM_KIND_GROUP_HEADER", title: "Account" };
const button = "NAV_ITEM_APPEARANCE_BUTTON";

function validate(navItems) {
  return validateNavigationWorkspaceDocument({ siteId, navItems }, siteId).navItems;
}

test("navigation Link aliases normalize to the same request and omitted workspace appearance", () => {
  for (const item of [link, heading]) {
    for (const appearance of [undefined, "NAV_ITEM_APPEARANCE_UNSPECIFIED", "NAV_ITEM_APPEARANCE_LINK"]) {
      const declared = { ...item, ...(appearance === undefined ? {} : { appearance }) };
      assert.deepEqual(validate([declared]), validate([item]));
      assert.deepEqual(projectNavigationForWorkspace([declared]), [item]);
    }
  }
});

test("navigation preserves Button on page and external leaves at every depth", () => {
  for (const item of [link, { id, kind: "NAV_ITEM_KIND_PAGE", title: "Account", resourceId: childId }]) {
    const styled = { ...item, appearance: button };
    const trees = [
      [styled],
      [{ ...heading, children: [{ ...styled, id: childId }] }],
      [{ ...heading, children: [{ ...heading, id: childId, children: [{ ...styled, id: grandchildId }] }] }],
    ];
    for (const tree of trees) {
      assert.deepEqual(projectNavigationForWorkspace(validate(tree)), tree);
    }

    for (const position of [undefined, "NAV_ITEM_POSITION_HEADER_END"]) {
      const placed = { ...styled, ...(position === undefined ? {} : { position }) };
      assert.deepEqual(projectNavigationForWorkspace(validate([placed])), [placed]);
    }
  }
});

test("navigation appearance errors identify the exact field", async (context) => {
  const cases = [
    ...[null, 0, 1, 2, "button", "NAV_ITEM_APPEARANCE_UNKNOWN"].map((appearance) => ({
      name: `invalid ${String(appearance)}`, items: [{ ...link, appearance }], code: "nav.appearance_invalid", field: "navItems[0].appearance",
    })),
    { name: "empty dropdown", items: [{ ...heading, appearance: button }], code: "nav.appearance_unavailable", field: "navItems[0].appearance" },
    { name: "nested dropdown", items: [{ ...heading, children: [{ ...heading, id: childId, appearance: button }] }], code: "nav.appearance_unavailable", field: "navItems[0].children[0].appearance" },
    { name: "nested invalid appearance", items: [{ ...heading, children: [{ ...link, id: childId, appearance: "Button" }] }], code: "nav.appearance_invalid", field: "navItems[0].children[0].appearance" },
  ];
  for (const scenario of cases) {
    await context.test(scenario.name, () => {
      assert.throws(() => validate(scenario.items), { code: scenario.code, field: scenario.field });
    });
  }
});
