import assert from "node:assert/strict";
import test from "node:test";

import { getAppearanceReference, getThemeReference } from "../src/presentation-reference.js";
import {
  getSettingsReference,
  PAGE_BACKGROUND_IMAGE_RENDERING,
  SETTING_FIELD_REFERENCE,
} from "../src/setting-reference.js";
import { SETTINGS_GROUPS } from "../src/settings-catalog.js";

/**
 * The settings reference is the one owner of what each pulled field means and
 * where it renders (TR01222). These tests fail when a field is added to the
 * catalog without an entry, or an entry outlives its field.
 */

test("every catalogued setting has an app control and a one-sentence description", () => {
  const reference = getSettingsReference();
  assert.equal(reference.groups.length, SETTINGS_GROUPS.length);
  for (const [index, group] of SETTINGS_GROUPS.entries()) {
    assert.deepEqual(
      reference.groups[index].fields.map((field) => field.path),
      group.fields.map((field) => `settings.${field.name}`),
    );
    for (const field of reference.groups[index].fields) {
      assert.match(field.appLabel, /\S/u, `${field.path} has no app label`);
      assert.match(field.description, /\S/u, `${field.path} has no description`);
      assert.match(field.write, /\S/u, `${field.path} says nothing about how it is written`);
    }
  }
});

test("no setting reference outlives its catalog field", () => {
  for (const group of SETTINGS_GROUPS) {
    const documented = Object.keys(SETTING_FIELD_REFERENCE[group.settingsType]);
    assert.deepEqual(documented.toSorted(), group.fields.map((field) => field.name).toSorted());
  }
});

test("the canvas image and the page background image are told apart, with where each renders", () => {
  const reference = getSettingsReference();
  const { pageBackground, canvas } = reference.pageBackgroundVersusCanvas;
  assert.ok(pageBackground.includes(PAGE_BACKGROUND_IMAGE_RENDERING));
  assert.notEqual(pageBackground, canvas);
  const canvasField = reference.groups[0].fields.find((field) => field.path === "settings.lightCanvasImageId");
  assert.equal(canvasField.appLabel, "Brand & style > Page canvas > Canvas image");
  assert.match(canvasField.renders, /\S/u);
  assert.ok(reference.themeControls.some((control) => control.fields.includes("pageBackgroundImage")));
});

test("help theme describes the page background image from the same source as help settings", () => {
  const description = getThemeReference().groups
    .flatMap((group) => group.fields)
    .find((field) => field.name === "pageBackgroundImage").description;
  assert.ok(description.includes(PAGE_BACKGROUND_IMAGE_RENDERING));
});

test("every writable footer color has a readable description", () => {
  const colorFields = getAppearanceReference().fields.filter((field) => field.path.startsWith("settings.footerSettings."));
  assert.equal(colorFields.length, 10);
  for (const field of colorFields) assert.doesNotMatch(field.description, /undefined/u, field.path);
});

test("every theme-backed app control names real theme fields", () => {
  const themeFields = new Set(getThemeReference().groups.flatMap((group) => group.fields.map((field) => field.name)));
  for (const control of getSettingsReference().themeControls) {
    for (const name of control.fields) assert.ok(themeFields.has(name), `${control.appLabel}: ${name}`);
  }
});

test("a default is a typed value that matches the field's wire type", () => {
  for (const group of getSettingsReference().groups) {
    for (const field of group.fields) {
      if (field.default === undefined) continue;
      const expected = { boolean: "boolean", int: "number", double: "number" }[field.wireType];
      if (expected !== undefined) assert.equal(typeof field.default, expected, field.path);
    }
  }
});

test("help appearance carries the same description and rendering note beside each writable field", () => {
  const appearance = getAppearanceReference();
  const settings = getSettingsReference();
  const catalogued = new Map(settings.groups.flatMap((group) => group.fields.map((field) => [field.path, field])));
  for (const field of appearance.fields) {
    assert.match(field.description, /\S/u, `${field.path} has no description`);
    const source = catalogued.get(field.path);
    if (source !== undefined) assert.equal(field.description, source.description);
  }
});
