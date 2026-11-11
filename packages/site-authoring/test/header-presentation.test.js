import assert from "node:assert/strict";
import test from "node:test";
import { appearanceImageIds } from "../src/appearance-contract.js";
import {
  projectSettingsGroup,
  SETTINGS_GROUPS,
  SETTINGS_TYPE_SITE_HEADER,
  SETTINGS_TYPE_TAPROOT_STYLES,
} from "../src/settings-catalog.js";

const group = SETTINGS_GROUPS.find(group => group.settingsType === SETTINGS_TYPE_SITE_HEADER);

test("pull omits compatible standard heights and canonicalizes nondefault strings", async t => {
  for (
    const [input, canonical] of [[undefined, undefined], ["", undefined], ["1", undefined], ["1.0", undefined], [
      "2",
      "2.0",
    ], ["1.8", "1.8"]]
  ) {
    await t.test(String(input), () => {
      const result = projectSettingsGroup(group, { headerSettings: { headerHeightMultiplier: input } });
      assert.equal(result.headerHeightMultiplier, canonical);
      assert.equal(Object.hasOwn(result, "headerHeightMultiplier"), canonical !== undefined);
    });
  }
});

test("pull refuses an invalid API height instead of changing its meaning", () => {
  assert.throws(
    () => projectSettingsGroup(group, { headerSettings: { headerHeightMultiplier: "1.15" } }),
    error => error?.code === "api.setting_contract" && error?.field === "headerHeightMultiplier",
  );
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
