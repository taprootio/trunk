import assert from "node:assert/strict";
import test from "node:test";

import { projectSettingsGroup, SETTINGS_GROUPS } from "../src/settings-catalog.js";

/**
 * The site time zone survives a pull (TR01091). `projectSettingsGroup` copies
 * only catalogued fields, so a setting missing here is dropped from the
 * workspace even though the server returns it.
 */
const PUBLISHING_PREFERENCES = SETTINGS_GROUPS.find(
  (group) => group.file === "site-publishing-preferences.json",
);

const project = (sitePublishingPreferences) =>
  projectSettingsGroup(PUBLISHING_PREFERENCES, { sitePublishingPreferences });

test("the publishing-preferences group catalogues the time zone as a string", () => {
  assert.ok(PUBLISHING_PREFERENCES.fields.some((field) => field.name === "timeZone" && field.wireType === "string"));
});

test("a stored zone survives the projection", () => {
  assert.equal(project({ timeZone: "America/Los_Angeles" }).timeZone, "America/Los_Angeles");
});

test("two sites that differ only in their zone project differently", () => {
  assert.notDeepEqual(project({ timeZone: "UTC" }), project({ timeZone: "Asia/Tokyo" }));
});
