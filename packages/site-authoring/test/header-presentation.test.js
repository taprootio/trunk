import assert from "node:assert/strict";
import test from "node:test";
import { appearanceImageIds, buildAppearanceScalarOperations, APPEARANCE_SCALAR_FIELDS } from "../src/appearance-contract.js";
import {
  projectSettingsGroup,
  SETTINGS_GROUPS,
  SETTINGS_TYPE_SITE_HEADER,
  SETTINGS_TYPE_TAPROOT_STYLES,
} from "../src/settings-catalog.js";

const group = SETTINGS_GROUPS.find(group => group.settingsType === SETTINGS_TYPE_SITE_HEADER);

for (const field of ["headerHeightMultiplier", "headerMinHeightMultiplier"]) {
  test(`pull omits compatible standard ${field} values and canonicalizes nondefaults`, async t => {
    for (const [input, canonical] of [[undefined, undefined], ["", undefined], ["1", undefined], ["1.0", undefined], ["2", "2.0"], ["1.9", "1.9"]]) {
      await t.test(String(input), () => {
        const result = projectSettingsGroup(group, { headerSettings: { [field]: input } });
        assert.equal(result[field], canonical);
        assert.equal(Object.hasOwn(result, field), canonical !== undefined);
      });
    }
  });
  test(`pull refuses an invalid API ${field} instead of changing its meaning`, () => {
    assert.throws(() => projectSettingsGroup(group, { headerSettings: { [field]: "1.15" } }),
      error => error?.code === "api.setting_contract" && error?.field === field);
  });
}

test("pull retains a minimum above the current expanded height", () => {
  const result = projectSettingsGroup(group, { headerSettings: { headerHeightMultiplier: "1", headerMinHeightMultiplier: "1.9" } });
  assert.equal(result.headerMinHeightMultiplier, "1.9");
  assert.equal(Object.hasOwn(result, "headerHeightMultiplier"), false);
});

test("pull retains inactive compact logo identities for the existing media workflow", () => {
  const imageId = "018f615e-8086-4000-8000-000000000001";
  const styles = SETTINGS_GROUPS.find(group => group.settingsType === SETTINGS_TYPE_TAPROOT_STYLES);
  const result = projectSettingsGroup(styles, {
    styleSettings: {
      lightCompactLogoId: imageId,
      lightCompactLogoUrl: "https://images.example.test/compact.webp",
    },
  });
  assert.equal(result.lightCompactLogoId, imageId);
  assert.equal(result.lightCompactLogoUrl, "https://images.example.test/compact.webp");
  assert.equal(result.darkCompactLogoId, "");
  assert.deepEqual(appearanceImageIds({ [SETTINGS_TYPE_TAPROOT_STYLES]: result }), [imageId]);
});


const appearanceDocuments = minimum => {
  const documents = Object.fromEntries(SETTINGS_GROUPS.map(group => [group.settingsType, {}]));
  for (const field of APPEARANCE_SCALAR_FIELDS) documents[field.settingsType][field.name] = field.default;
  Object.assign(documents[SETTINGS_TYPE_SITE_HEADER], { headerHeightMultiplier: "3.8", headerMinHeightMultiplier: minimum });
  return documents;
};

test("appearance push canonicalizes the minimum and preserves a taller authored floor", () => {
  for (const [input, expected] of [[undefined, ""], ["1.0", ""], ["1.9", "1.9"], ["2", "2.0"], ["5.0", "5.0"]]) {
    const operations = buildAppearanceScalarOperations(appearanceDocuments(input), new Set());
    assert.equal(operations.find(operation => operation.setting === "headerMinHeightMultiplier").value, expected);
  }
});

test("appearance push refuses malformed minimum values at the exact field", () => {
  for (const value of [1.9, null, true, "0.9", "1.95", " 1.9", "5.1", "1e0"]) {
    assert.throws(() => buildAppearanceScalarOperations(appearanceDocuments(value), new Set()), error => error?.code === "theme.setting_invalid" && error?.field === "site-header.headerMinHeightMultiplier");
  }
});
