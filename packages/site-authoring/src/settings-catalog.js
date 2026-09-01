import { parseTheme } from "@taprootio/espalier/shared/theme";

import { SiteAuthoringError } from "./errors.js";
import { projectFooterSettingsForWorkspace } from "./footer-contract.js";

/**
 * The settings surface the authoring CLI covers.
 *
 * `GetSettings` answers with a oneof-shaped envelope: one property per group,
 * and — because proto3 omits zero values — a field the site has never set is
 * simply absent rather than present-and-default. A snapshot that inherited that
 * omission would be unreadable: an agent could not tell "unset" from "not part
 * of this group", and a later diff would churn. So the projection below
 * materializes every in-scope field at its zero value, which is exactly what
 * the server would answer with.
 *
 * Scope (TR00604's refinement):
 * - The four theme-gated groups are covered. `SETTING_TYPE_SITE_RUNTIME_PREFERENCES`
 *   is not: it is gated on `site.settings.manage` rather than theme management,
 *   promotes immediately rather than through staging, and is site administration
 *   rather than authored presentation.
 * - `lightTheme` and `darkTheme` are decoded into readable JSON objects. Theme
 *   push validates and re-encodes them only at the wire boundary.
 * - `footerSettings` is snapshotted as its structured document. Theme push
 *   overlays only its scheme colors onto a fresh server read before using the
 *   optimistic-concurrency footer endpoint.
 * - `membershipsEnabled` is excluded. It appears in the publishing-preferences
 *   message but not in the group's settable field set: it is a plan-derived
 *   flag the server computes, not site configuration a workspace owns.
 *
 * `wireType` records how a field crosses `SetSetting`, whose `value` is a bare
 * string for every type. Theme push uses it for scalar writes; complete themes
 * and footer settings take their dedicated validated paths. It also lets the
 * read projection normalize an omitted field to the right zero value.
 */

export const SETTINGS_TYPE_TAPROOT_STYLES = "SETTING_TYPE_TAPROOT_STYLES";
export const SETTINGS_TYPE_BRAND = "SETTING_TYPE_BRAND";
export const SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES = "SETTING_TYPE_SITE_PUBLISHING_PREFERENCES";
export const SETTINGS_TYPE_SITE_HEADER = "SETTING_TYPE_SITE_HEADER";

function stringFields(...names) {
  return names.map((name) => ({ name, wireType: "string" }));
}

export const SETTINGS_GROUPS = Object.freeze([
  Object.freeze({
    settingsType: SETTINGS_TYPE_TAPROOT_STYLES,
    // The property `GetSettingsResponse` carries this group's message under.
    responseProperty: "styleSettings",
    // The workspace file `pull` writes this group into.
    file: "taproot-styles.json",
    candidateSelectable: true,
    fields: Object.freeze([
      { name: "lightTheme", wireType: "theme" },
      { name: "darkTheme", wireType: "theme" },
      ...stringFields(
        "defaultScheme",
        "fontBrand",
        "fontWeightBrand",
        "lightLogoId",
        "lightLogoUrl",
        "darkLogoId",
        "darkLogoUrl",
        "lightCanvasImageId",
        "lightCanvasImageUrl",
        "darkCanvasImageId",
        "darkCanvasImageUrl",
      ),
      { name: "lightCanvasImageOpacity", wireType: "double" },
      { name: "darkCanvasImageOpacity", wireType: "double" },
    ]),
  }),
  Object.freeze({
    settingsType: SETTINGS_TYPE_BRAND,
    responseProperty: "brandSettings",
    file: "brand.json",
    candidateSelectable: true,
    fields: Object.freeze(stringFields("faviconId", "faviconUrl")),
  }),
  Object.freeze({
    settingsType: SETTINGS_TYPE_SITE_HEADER,
    responseProperty: "headerSettings",
    file: "site-header.json",
    candidateSelectable: true,
    fields: Object.freeze([
      ...stringFields(
        "headerLayout",
        "brandText",
        "brandColor",
        "logoAlt",
        "navMenuDisplay",
        "headerPosition",
        "lightBrandColor",
        "darkBrandColor",
      ),
      { name: "showThemeToggle", wireType: "boolean" },
      { name: "showBrandText", wireType: "boolean" },
      { name: "brandLogoSize", wireType: "string" },
      { name: "brandHoverGrow", wireType: "boolean" },
    ]),
  }),
  Object.freeze({
    settingsType: SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES,
    responseProperty: "sitePublishingPreferences",
    file: "site-publishing-preferences.json",
    candidateSelectable: true,
    fields: Object.freeze([
      // `commentsMode` is an enum; on the wire it is the enum's name string,
      // and an omitted value reads as the zero member — which is spelled
      // UNSPECIFIED here, not UNKNOWN as most of this contract's enums are
      // (protos/Settings.proto). A snapshot naming a member that does not
      // exist is worse than one that omits the field.
      { name: "commentsMode", wireType: "enum", zero: "SITE_COMMENTS_MODE_UNSPECIFIED" },
      ...stringFields("tiptapImagePlacement"),
      { name: "allowSearch", wireType: "boolean" },
      { name: "albumSeamless", wireType: "boolean" },
      { name: "tiptapImageMaxHeightVh", wireType: "int" },
      { name: "tiptapImageBorderWidth", wireType: "int" },
      { name: "albumBorderWidth", wireType: "int" },
      { name: "footerSettings", wireType: "document", zero: {} },
    ]),
  }),
]);

export const CANDIDATE_SELECTABLE_SETTINGS_TYPES = Object.freeze(
  SETTINGS_GROUPS.filter((group) => group.candidateSelectable).map((group) => group.settingsType),
);

function zeroValue(field) {
  if (field.wireType === "boolean") return false;
  if (field.wireType === "int" || field.wireType === "double") return 0;
  if (field.wireType === "theme" || field.wireType === "document") return field.zero ?? {};
  return field.zero ?? "";
}

function normalizeField(field, value) {
  if (value === undefined || value === null) {
    const zero = zeroValue(field);
    return field.wireType === "document" && field.name === "footerSettings"
      ? projectFooterSettingsForWorkspace(zero)
      : zero;
  }
  if (field.wireType === "theme") return decodeTheme(value, field.name);
  if (field.wireType === "document") {
    const document_ = typeof value === "object" && !Array.isArray(value) ? value : zeroValue(field);
    return field.name === "footerSettings" ? projectFooterSettingsForWorkspace(document_) : document_;
  }
  if (field.wireType === "boolean") return value === true;
  if (field.wireType === "int" || field.wireType === "double") {
    // Transcoded 64-bit and some 32-bit numerics arrive as strings.
    const numeric = typeof value === "string" ? Number(value) : value;
    return typeof numeric === "number" && Number.isFinite(numeric) ? numeric : zeroValue(field);
  }
  return typeof value === "string" ? value : zeroValue(field);
}

function decodeTheme(value, field) {
  if (value === "") return {};
  const theme = typeof value === "string" ? parseTheme(value) : undefined;
  if (!theme) {
    throw new SiteAuthoringError(
      "api.theme_contract",
      "Taproot returned a non-empty theme that could not be decoded.",
      { field },
    );
  }
  return theme;
}

/**
 * Projects one `GetSettings` response down to the fields this CLI covers,
 * materializing the zero value for every field proto3 omitted. Fields outside
 * the catalog are dropped rather than snapshotted, so the workspace never
 * records something the CLI cannot round-trip.
 */
export function projectSettingsGroup(group, response) {
  const message = response !== null && typeof response === "object" && !Array.isArray(response)
    ? response[group.responseProperty]
    : undefined;
  const source = message !== null && typeof message === "object" && !Array.isArray(message) ? message : {};
  const projected = {};
  for (const field of group.fields) {
    projected[field.name] = normalizeField(field, source[field.name]);
  }
  return projected;
}
