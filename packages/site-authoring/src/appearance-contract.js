import { hasControlCharacter, isCanonicalUuid, SiteAuthoringError } from "./errors.js";
import {
  SETTINGS_TYPE_BRAND,
  SETTINGS_TYPE_SITE_HEADER,
  SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES,
  SETTINGS_TYPE_TAPROOT_STYLES,
} from "./settings-catalog.js";
import { FOOTER_COLOR_TOKENS, HEADER_BRAND_COLOR_TOKENS, requireAppearanceColor } from "./theme-validation.js";

export const APPEARANCE_FILES = Object.freeze({
  [SETTINGS_TYPE_TAPROOT_STYLES]: "settings/taproot-styles.json",
  [SETTINGS_TYPE_BRAND]: "settings/brand.json",
  [SETTINGS_TYPE_SITE_HEADER]: "settings/site-header.json",
  [SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES]: "settings/site-publishing-preferences.json",
});

// Declaration order is both mutation order and help order. Adding a writable
// scalar therefore changes one executable registry instead of a validator,
// request mapper, and prose list independently.
export const APPEARANCE_SCALAR_FIELDS = Object.freeze([
  Object.freeze({
    settingsType: SETTINGS_TYPE_TAPROOT_STYLES,
    name: "defaultScheme",
    path: "taproot-styles.defaultScheme",
    type: "enum",
    values: Object.freeze(["system", "light", "dark"]),
    default: "light",
  }),
  Object.freeze({
    settingsType: SETTINGS_TYPE_TAPROOT_STYLES,
    name: "fontBrand",
    path: "taproot-styles.fontBrand",
    type: "string",
    default: "",
  }),
  Object.freeze({
    settingsType: SETTINGS_TYPE_TAPROOT_STYLES,
    name: "fontWeightBrand",
    path: "taproot-styles.fontWeightBrand",
    type: "string",
    default: "",
  }),
  Object.freeze({
    settingsType: SETTINGS_TYPE_TAPROOT_STYLES,
    name: "fontMenu",
    path: "taproot-styles.fontMenu",
    type: "string",
    default: "",
  }),
  Object.freeze({
    settingsType: SETTINGS_TYPE_TAPROOT_STYLES,
    name: "fontWeightMenu",
    path: "taproot-styles.fontWeightMenu",
    type: "string",
    default: "",
  }),
  ...["lightLogoId", "darkLogoId", "lightCanvasImageId", "darkCanvasImageId"].map((name) =>
    Object.freeze({
      settingsType: SETTINGS_TYPE_TAPROOT_STYLES,
      name,
      path: `taproot-styles.${name}`,
      type: "site-owned-image-id",
      default: "",
    })
  ),
  ...["lightCanvasImageOpacity", "darkCanvasImageOpacity"].map((name) =>
    Object.freeze({
      settingsType: SETTINGS_TYPE_TAPROOT_STYLES,
      name,
      path: `taproot-styles.${name}`,
      type: "number",
      minimum: 0,
      maximum: 1,
      default: 1,
    })
  ),
  Object.freeze({
    settingsType: SETTINGS_TYPE_BRAND,
    name: "faviconId",
    path: "brand.faviconId",
    type: "site-owned-image-id",
    default: "",
  }),
  Object.freeze({
    settingsType: SETTINGS_TYPE_SITE_HEADER,
    name: "headerLayout",
    path: "site-header.headerLayout",
    type: "enum",
    values: Object.freeze(["standard", "centered-brand", "minimal", "centered-menu"]),
    default: "standard",
  }),
  Object.freeze({
    settingsType: SETTINGS_TYPE_SITE_HEADER,
    name: "headerWidth",
    path: "site-header.headerWidth",
    type: "enum",
    values: Object.freeze(["contained", "wide"]),
    default: "contained",
  }),
  Object.freeze({
    settingsType: SETTINGS_TYPE_SITE_HEADER,
    name: "navDrawerStyle",
    path: "site-header.navDrawerStyle",
    type: "enum",
    values: Object.freeze(["panel", "full-screen"]),
    default: "full-screen",
  }),
  Object.freeze({
    settingsType: SETTINGS_TYPE_SITE_HEADER,
    name: "navDrawerTransition",
    path: "site-header.navDrawerTransition",
    type: "enum",
    values: Object.freeze(["fade", "slide-down", "slide-up", "slide-left", "slide-right"]),
    default: "fade",
  }),
  Object.freeze({
    settingsType: SETTINGS_TYPE_SITE_HEADER,
    name: "brandText",
    path: "site-header.brandText",
    type: "plain-text",
    maximumLength: 120,
    default: "",
  }),
  Object.freeze({
    settingsType: SETTINGS_TYPE_SITE_HEADER,
    name: "logoAlt",
    path: "site-header.logoAlt",
    type: "plain-text",
    maximumLength: 160,
    default: "",
  }),
  Object.freeze({
    settingsType: SETTINGS_TYPE_SITE_HEADER,
    name: "navMenuDisplay",
    path: "site-header.navMenuDisplay",
    type: "enum",
    values: Object.freeze(["auto", "drawer"]),
    default: "auto",
  }),
  Object.freeze({
    settingsType: SETTINGS_TYPE_SITE_HEADER,
    name: "headerPosition",
    path: "site-header.headerPosition",
    type: "enum",
    values: Object.freeze(["normal", "sticky"]),
    default: "normal",
  }),
  Object.freeze({
    settingsType: SETTINGS_TYPE_SITE_HEADER,
    name: "showThemeToggle",
    path: "site-header.showThemeToggle",
    type: "boolean",
    default: false,
  }),
  Object.freeze({
    settingsType: SETTINGS_TYPE_SITE_HEADER,
    name: "showBrandText",
    path: "site-header.showBrandText",
    type: "boolean",
    default: true,
  }),
  Object.freeze({
    settingsType: SETTINGS_TYPE_SITE_HEADER,
    name: "brandLogoSize",
    path: "site-header.brandLogoSize",
    type: "enum",
    values: Object.freeze(["standard", "large", "full"]),
    default: "standard",
  }),
  Object.freeze({
    settingsType: SETTINGS_TYPE_SITE_HEADER,
    name: "brandHoverGrow",
    path: "site-header.brandHoverGrow",
    type: "boolean",
    default: false,
  }),
  ...["brandColor", "lightBrandColor", "darkBrandColor"].map((name) =>
    Object.freeze({
      settingsType: SETTINGS_TYPE_SITE_HEADER,
      name,
      path: `site-header.${name}`,
      type: "appearance-color",
      allowedTokens: HEADER_BRAND_COLOR_TOKENS,
      default: "",
    })
  ),
]);

export const APPEARANCE_READ_ONLY_FIELDS = Object.freeze([
  Object.freeze({ file: APPEARANCE_FILES[SETTINGS_TYPE_TAPROOT_STYLES], path: "settings.lightLogoUrl" }),
  Object.freeze({ file: APPEARANCE_FILES[SETTINGS_TYPE_TAPROOT_STYLES], path: "settings.darkLogoUrl" }),
  Object.freeze({ file: APPEARANCE_FILES[SETTINGS_TYPE_TAPROOT_STYLES], path: "settings.lightCanvasImageUrl" }),
  Object.freeze({ file: APPEARANCE_FILES[SETTINGS_TYPE_TAPROOT_STYLES], path: "settings.darkCanvasImageUrl" }),
  Object.freeze({ file: APPEARANCE_FILES[SETTINGS_TYPE_BRAND], path: "settings.faviconUrl" }),
]);

export const APPEARANCE_FOOTER_COLOR_FIELDS = Object.freeze(
  ["light", "dark"].flatMap((scheme) =>
    Object.keys(FOOTER_COLOR_TOKENS).map((name) =>
      Object.freeze({
        file: APPEARANCE_FILES[SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES],
        path: `settings.footerSettings.${scheme}.${name}`,
        scheme,
        name,
        type: "appearance-color",
        default: "",
        allowedTokens: FOOTER_COLOR_TOKENS[name],
      })
    )
  ),
);

export const APPEARANCE_IMAGE_FIELDS = Object.freeze(
  APPEARANCE_SCALAR_FIELDS.filter((field) => field.type === "site-owned-image-id"),
);

export function appearanceImageIds(documents) {
  return [...new Set(APPEARANCE_IMAGE_FIELDS
    .map((field) => documents[field.settingsType]?.[field.name])
    .filter((value) => isCanonicalUuid(value)))].sort();
}

function fail(code, message, field) {
  throw new SiteAuthoringError(code, message, { field });
}

function requireString(value, field, maximum = 256 * 1024) {
  if (typeof value !== "string" || value.length > maximum || hasControlCharacter(value)) {
    fail("theme.setting_invalid", `${field} must be a bounded printable string.`, field);
  }
  return value;
}

function validateScalar(definition, value, knownImageIds) {
  switch (definition.type) {
    case "enum":
      if (typeof value !== "string" || !definition.values.includes(value)) {
        fail(
          "theme.setting_invalid",
          `${definition.path} must be one of ${definition.values.join(", ")}.`,
          definition.path,
        );
      }
      return value;
    case "string":
      return requireString(value, definition.path);
    case "plain-text": {
      const text = requireString(value, definition.path, definition.maximumLength);
      if ([...text].some((character) => character === "<" || character === ">" || character === "\"")) {
        fail("theme.setting_invalid", `${definition.path} cannot contain markup-breaking characters.`, definition.path);
      }
      return text;
    }
    case "site-owned-image-id":
      if (typeof value !== "string" || (value !== "" && !isCanonicalUuid(value))) {
        fail(
          "theme.image_id_invalid",
          `${definition.path} must be empty or a canonical lowercase site-owned image ID from pull or 'media upload'.`,
          definition.path,
        );
      }
      if (value !== "" && !knownImageIds.has(value)) {
        fail(
          "theme.image_reference_unknown",
          `${definition.path} must name an image retained from pull or recorded by 'media upload'.`,
          definition.path,
        );
      }
      return value;
    case "number":
      if (
        typeof value !== "number"
        || !Number.isFinite(value)
        || value < definition.minimum
        || value > definition.maximum
      ) {
        fail(
          "theme.setting_invalid",
          `${definition.path} must be a number from ${definition.minimum} through ${definition.maximum}.`,
          definition.path,
        );
      }
      return String(value);
    case "boolean":
      if (typeof value !== "boolean") {
        fail("theme.setting_invalid", `${definition.path} must be true or false.`, definition.path);
      }
      return String(value);
    case "appearance-color":
      return requireAppearanceColor(value, definition.allowedTokens, definition.path);
    default:
      throw new TypeError(`Unknown appearance field type '${definition.type}'.`);
  }
}

export function buildAppearanceScalarOperations(documents, knownImageIds) {
  if (!(knownImageIds instanceof Set)) {
    throw new TypeError("Appearance validation requires the known site-owned image identities.");
  }
  return APPEARANCE_SCALAR_FIELDS.map((definition) => ({
    settingsType: definition.settingsType,
    setting: definition.name,
    value: validateScalar(definition, documents[definition.settingsType]?.[definition.name], knownImageIds),
  }));
}

export function footerColorOverlay(workspaceFooter) {
  if (workspaceFooter === null || typeof workspaceFooter !== "object" || Array.isArray(workspaceFooter)) {
    fail(
      "theme.footer_missing",
      "site-publishing-preferences.footerSettings is missing. Run 'taproot-site pull' again.",
      "site-publishing-preferences.footerSettings",
    );
  }
  const colors = { light: {}, dark: {} };
  for (const definition of APPEARANCE_FOOTER_COLOR_FIELDS) {
    const scheme = workspaceFooter[definition.scheme];
    if (scheme === null || typeof scheme !== "object" || Array.isArray(scheme)) {
      fail(
        "theme.footer_invalid",
        `footerSettings.${definition.scheme} must be an object.`,
        `footerSettings.${definition.scheme}`,
      );
    }
    colors[definition.scheme][definition.name] = requireAppearanceColor(
      scheme[definition.name] === undefined ? "" : scheme[definition.name],
      definition.allowedTokens,
      `footerSettings.${definition.scheme}.${definition.name}`,
    );
  }
  return colors;
}

export function applyFooterColors(currentFooter, colors) {
  const next = structuredClone(
    currentFooter !== null && typeof currentFooter === "object" && !Array.isArray(currentFooter)
      ? currentFooter
      : {},
  );
  for (const scheme of ["light", "dark"]) {
    next[scheme] = {
      ...(next[scheme] !== null && typeof next[scheme] === "object" && !Array.isArray(next[scheme])
        ? next[scheme]
        : {}),
      ...colors[scheme],
    };
  }
  return next;
}
