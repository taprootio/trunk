import { APPEARANCE_FILES } from "./appearance-contract.js";
import { resolveFooterLogoPairs } from "./footer-branding.js";
import { footerLogoAspectRatio } from "./footer-fit.js";
import { logoInputsFromSettings } from "./logo-inputs.js";
import { SETTINGS_TYPE_SITE_HEADER, SETTINGS_TYPE_TAPROOT_STYLES } from "./settings-catalog.js";
import { MEDIA_MANIFEST_FILE_NAME, readWorkspaceJson, WORKSPACE_LIMITS } from "./workspace.js";

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
  const [header, styles, media] = await Promise.all([
    optionalSettings(workspaceDir, SETTINGS_TYPE_SITE_HEADER),
    optionalSettings(workspaceDir, SETTINGS_TYPE_TAPROOT_STYLES),
    readWorkspaceJson(workspaceDir, MEDIA_MANIFEST_FILE_NAME, WORKSPACE_LIMITS.manifestBytes).then(value => value?.media ?? {}).catch(() => ({})),
  ]);
  return footerBrandInputsFromSettings(header, styles, media, footerSettings);
}

export function footerBrandInputsFromSettings(header, styles, media, footerSettings) {
  const pair = resolveFooterLogoPairs({ ...logoInputsFromSettings(styles, footerSettings, media), logoVariant: footerSettings?.logoVariant });
  const visible = [pair.light, pair.dark].filter(value => value.url !== "");
  const ratios = visible.map(value => Number(value.aspectRatio));
  const knownRatios = visible.length > 0 && ratios.every(value => Number.isFinite(value) && value > 0);
  return {
    brandText: typeof header?.brandText === "string" ? header.brandText : "",
    hasLogo: visible.length > 0,
    ...(knownRatios ? { logoAspectRatio: footerLogoAspectRatio(ratios) } : {}),
  };
}
