import assert from "node:assert/strict";
import test from "node:test";

import { projectSettingsGroup, SETTINGS_GROUPS } from "../src/settings-catalog.js";

/**
 * The lightbox comments preference survives a pull (TR00868).
 *
 * `projectSettingsGroup` copies only catalogued fields, so a preference added
 * to the proto and to every server-side contract is still dropped from the
 * workspace snapshot until it is named here. That is how this one was missed:
 * a site with the setting stored and a site without it produced byte-identical
 * snapshots, so a pull could not represent what the site was actually doing
 * and a later push would read as "show comments" regardless.
 */
const PUBLISHING_PREFERENCES = SETTINGS_GROUPS.find(
  (group) => group.file === "site-publishing-preferences.json",
);

function project(sitePublishingPreferences) {
  return projectSettingsGroup(PUBLISHING_PREFERENCES, { sitePublishingPreferences });
}

test("the publishing-preferences group catalogues the lightbox comments preference", () => {
  assert.ok(
    PUBLISHING_PREFERENCES.fields.some((field) =>
      field.name === "hideLightboxComments" && field.wireType === "boolean"
    ),
    "hideLightboxComments must be catalogued, or a pull silently drops it",
  );
});

test("a stored preference survives the projection", () => {
  assert.equal(project({ hideLightboxComments: true }).hideLightboxComments, true);
  assert.equal(project({ hideLightboxComments: false }).hideLightboxComments, false);
});

test("an omitted preference reads as comments shown", () => {
  // The wire spelling is the negative precisely so the zero value and the
  // behaviour of an untouched site agree: false means the lightbox shows
  // comments, which is what a site that never set it does.
  assert.equal(project({}).hideLightboxComments, false);
  assert.equal(project(undefined).hideLightboxComments, false);
});

test("two sites that differ only in this preference project differently", () => {
  assert.notDeepEqual(project({ hideLightboxComments: true }), project({ hideLightboxComments: false }));
});
