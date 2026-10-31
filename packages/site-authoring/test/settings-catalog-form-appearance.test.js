import assert from "node:assert/strict";
import test from "node:test";

import { projectSettingsGroup, SETTINGS_GROUPS } from "../src/settings-catalog.js";

const publishingPreferences = SETTINGS_GROUPS.find((group) => group.file === "site-publishing-preferences.json");
const project = (sitePublishingPreferences) =>
  projectSettingsGroup(publishingPreferences, { sitePublishingPreferences });

test("sparse settings preserve default-on form background and shadow", () => {
  for (const source of [undefined, {}]) {
    const settings = project(source);
    assert.equal(settings.formBoxBackground, true);
    assert.equal(settings.formBoxBorder, false);
    assert.equal(settings.formBoxShadow, true);
  }
});

test("explicit form appearance booleans survive a settings snapshot round trip", () => {
  const settings = project({ formBoxBackground: false, formBoxBorder: true, formBoxShadow: false });
  assert.equal(settings.formBoxBackground, false);
  assert.equal(settings.formBoxBorder, true);
  assert.equal(settings.formBoxShadow, false);
  assert.deepEqual(project(JSON.parse(JSON.stringify(settings))), settings);
});
