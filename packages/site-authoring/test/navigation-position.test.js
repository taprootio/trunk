import assert from "node:assert/strict";
import test from "node:test";
import { projectNavigationForWorkspace, validateNavigationWorkspaceDocument } from "../src/verbs/nav-push.js";

const siteId = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000002";
const childId = "00000000-0000-4000-8000-000000000003";
const link = { id, kind: "NAV_ITEM_KIND_EXTERNAL_URL", title: "Sign in", externalUrl: "https://app.example.com/sign-in" };
const headerEnd = "NAV_ITEM_POSITION_HEADER_END";

function validate(navItems) {
  return validateNavigationWorkspaceDocument({ siteId, navItems }, siteId).navItems;
}

test("navigation Menu aliases normalize to the same request and omitted workspace position", (context) => {
  for (const position of [undefined, "NAV_ITEM_POSITION_UNSPECIFIED", "NAV_ITEM_POSITION_MENU"]) {
    const item = { ...link, ...(position === undefined ? {} : { position }) };
    assert.deepEqual(validate([item]), validate([link]));
    assert.deepEqual(projectNavigationForWorkspace([item]), [link]);
  }
});

test("navigation preserves Header end on top-level page and external leaves", () => {
  for (const item of [link, { id, kind: "NAV_ITEM_KIND_PAGE", title: "Account", resourceId: childId }]) {
    const [validated] = validate([{ ...item, position: headerEnd }]);
    assert.equal(validated.position, headerEnd);
    assert.deepEqual(projectNavigationForWorkspace([validated]), [{ ...item, position: headerEnd }]);
  }
});

test("navigation position errors identify the exact field before writing", async (context) => {
  const heading = { id, kind: "NAV_ITEM_KIND_GROUP_HEADER", title: "Account" };
  const cases = [
    ...[null, 0, 2, "header-end", "NAV_ITEM_POSITION_UNKNOWN"].map((position) => ({
      name: `invalid ${String(position)}`, items: [{ ...link, position }], code: "nav.position_invalid", field: "navItems[0].position",
    })),
    { name: "dropdown", items: [{ ...heading, position: headerEnd }], code: "nav.position_unavailable", field: "navItems[0].position" },
    { name: "nested link", items: [{ ...heading, children: [{ ...link, id: childId, position: headerEnd }] }], code: "nav.position_unavailable", field: "navItems[0].children[0].position" },
  ];
  for (const scenario of cases) {
    await context.test(scenario.name, () => {
      assert.throws(() => validate(scenario.items), { code: scenario.code, field: scenario.field });
    });
  }
});
