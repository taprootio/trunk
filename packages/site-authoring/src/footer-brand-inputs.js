import { APPEARANCE_FILES } from "./appearance-contract.js";
import { isCanonicalUuid } from "./errors.js";
import { SETTINGS_TYPE_SITE_HEADER, SETTINGS_TYPE_TAPROOT_STYLES } from "./settings-catalog.js";
import { readWorkspaceJson, WORKSPACE_LIMITS } from "./workspace.js";

async function optionalSettings(workspaceDir, settingsType) {
  try {
    const document = await readWorkspaceJson(workspaceDir, APPEARANCE_FILES[settingsType], WORKSPACE_LIMITS.settingsBytes);
    return document?.settings;
  } catch {
    return undefined;
  }
}

/** Optional files are independent: losing the header must not discard a known logo, or the reverse. */
export async function readFooterBrandInputs(workspaceDir, footerSettings) {
  const [header, styles] = await Promise.all([
    optionalSettings(workspaceDir, SETTINGS_TYPE_SITE_HEADER),
    optionalSettings(workspaceDir, SETTINGS_TYPE_TAPROOT_STYLES),
  ]);
  return {
    brandText: typeof header?.brandText === "string" ? header.brandText : "",
    hasLogo: [styles?.lightLogoId, styles?.darkLogoId, footerSettings?.light?.logoId, footerSettings?.dark?.logoId]
      .some(isCanonicalUuid),
  };
}
