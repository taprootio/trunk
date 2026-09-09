import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { APPEARANCE_SCALAR_FIELDS } from "../src/appearance-contract.js";
import { SETTINGS_GROUPS } from "../src/settings-catalog.js";
import { validateThemeWorkspace } from "../src/verbs/theme-push.js";
import { writeWorkspaceJson } from "../src/workspace.js";

const SITE_ID = "11111111-2222-4333-8444-555555555555";
const DEFAULT_THEME_URL = new URL("./fixtures/default-site-theme.json", import.meta.url);

async function workspace(context, edit = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "taproot-missing-settings-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const defaults = JSON.parse(await readFile(DEFAULT_THEME_URL, "utf8"));
  const documents = Object.fromEntries(SETTINGS_GROUPS.map((group) => [group.settingsType, {}]));
  for (const field of APPEARANCE_SCALAR_FIELDS) documents[field.settingsType][field.name] = field.default;
  const byFile = Object.fromEntries(SETTINGS_GROUPS.map((group) => [group.file, documents[group.settingsType]]));
  Object.assign(byFile["taproot-styles.json"], {
    lightTheme: defaults.light.theme,
    darkTheme: defaults.dark.theme,
  });
  byFile["site-publishing-preferences.json"].footerSettings = { light: {}, dark: {} };
  edit(byFile);
  for (const group of SETTINGS_GROUPS) {
    await writeWorkspaceJson(root, `settings/${group.file}`, {
      entityId: SITE_ID,
      settingsType: group.settingsType,
      settings: documents[group.settingsType],
    });
  }
  return root;
}

test("one validation reports later font and header keys together even with an earlier invalid value", async (context) => {
  const root = await workspace(context, (documents) => {
    const style = documents["taproot-styles.json"];
    style.defaultScheme = "sepia";
    style.lightTheme.roles = { action: "anchor:missing" };
    for (const scheme of ["light", "dark"]) {
      delete style[`${scheme}Theme`].fontMenu;
      delete style[`${scheme}Theme`].fontWeightMenu;
    }
    for (const key of ["headerWidth", "navDrawerStyle", "navDrawerTransition"]) {
      delete documents["site-header.json"][key];
    }
  });

  await assert.rejects(() => validateThemeWorkspace(root, SITE_ID, new Set()), (error) => {
    assert.equal(error.code, "theme.settings_missing");
    assert.equal(error.field, "lightTheme.fontMenu");
    assert.deepEqual(error.details.map((detail) => detail.field), [
      "lightTheme.fontMenu",
      "lightTheme.fontWeightMenu",
      "darkTheme.fontMenu",
      "darkTheme.fontWeightMenu",
      "site-header.headerWidth",
      "site-header.navDrawerStyle",
      "site-header.navDrawerTransition",
    ]);
    for (const detail of error.details) {
      assert.equal(detail.code, "theme.setting_missing");
      assert.equal(detail.message, "is missing (added in a later contract; run taproot-site pull)");
    }
    return true;
  });
});

test("missing nested theme leaves, brand settings, and footer schemes share the same report", async (context) => {
  const root = await workspace(context, (documents) => {
    const style = documents["taproot-styles.json"];
    // This is invalid rather than absent, and must not invent missing leaves.
    style.lightTheme.angles = null;
    delete style.darkTheme.angles.triadic;
    delete style.darkTheme.dataPalette.series8;
    delete documents["brand.json"].faviconId;
    delete documents["site-publishing-preferences.json"].footerSettings.dark;
  });

  await assert.rejects(() => validateThemeWorkspace(root, SITE_ID, new Set()), (error) => {
    assert.equal(error.code, "theme.settings_missing");
    assert.deepEqual(error.details.map((detail) => detail.field), [
      "darkTheme.angles.triadic",
      "darkTheme.dataPalette.series8",
      "brand.faviconId",
      "footerSettings.dark",
    ]);
    return true;
  });
});

test("present invalid values retain their value errors instead of being classified as missing", async (context) => {
  for (
    const { edit, code, field } of [
      {
        edit: (documents) => documents["taproot-styles.json"].lightTheme = null,
        code: "theme.document_invalid",
        field: "lightTheme",
      },
      {
        edit: (documents) => documents["site-header.json"].headerWidth = null,
        code: "theme.setting_invalid",
        field: "site-header.headerWidth",
      },
      {
        edit: (documents) => documents["site-publishing-preferences.json"].footerSettings.dark = [],
        code: "theme.footer_invalid",
        field: "footerSettings.dark",
      },
    ]
  ) {
    const root = await workspace(context, edit);
    await assert.rejects(() => validateThemeWorkspace(root, SITE_ID, new Set()), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.field, field);
      assert.equal(error.details, undefined);
      return true;
    });
  }
});

test("optional omitted footer colors and valid empty scalar values still validate", async (context) => {
  const root = await workspace(context);
  const result = await validateThemeWorkspace(root, SITE_ID, new Set());
  assert.equal(result.scalarOperations.find((operation) => operation.setting === "faviconId").value, "");
  assert.equal(result.footerColors.light.backgroundColor, "");
  assert.equal(result.footerColors.dark.linkColor, "");
});
