import { APPEARANCE_FOOTER_COLOR_FIELDS, APPEARANCE_SCALAR_FIELDS } from "./appearance-contract.js";
import {
  SETTINGS_GROUPS,
  SETTINGS_TYPE_BRAND,
  SETTINGS_TYPE_SITE_HEADER,
  SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES,
  SETTINGS_TYPE_TAPROOT_STYLES,
} from "./settings-catalog.js";

/**
 * What every setting the CLI pulls means, which app control it is, and where it
 * renders (TR01222).
 *
 * This is the one owner of that prose. `help settings` prints all of it, `help
 * appearance` prints the entry beside each writable field, and a test fails
 * when a field in `settings-catalog.js` has no entry here, so the help cannot
 * drift behind a new field. Descriptions state current behavior; where the
 * platform's rendering is a known limit, the entry says so plainly.
 */

const BRAND = "Brand & style > Brand";
const HEADER = "Header & navigation";
const FEATURES = "Features";

function entry(appLabel, description, renders, defaultValue) {
  return Object.freeze({
    appLabel,
    description,
    ...(renders === undefined ? {} : { renders }),
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  });
}

/** Both schemes' image fields share a sentence shape. */
const LOGO_RENDERS = "The brand slot of the header, at the height brandLogoSize sets, and the footer's brand once the "
  + "footer is enabled with its brand on. On a standard site a scheme with no logo of its own uses the other "
  + "scheme's, and a site with no logo shows its brand text alone. On a profile site an unset light logo is the "
  + "Taproot logo and an unset dark logo is the light one. Assign the highest-resolution file you have: the "
  + "platform keeps one normalized master and serves resized WebP renditions, so an @2x suffix is only a filename "
  + "and a second, smaller copy is never needed.";

/** The canvas image's rendering limits, stated once for both schemes. */
const CANVAS_RENDERS = "Only the empty side margins of a page, the left and right canvas columns of the page "
  + "shell, never behind the content. The browser's default background rules apply, so the image tiles at its natural "
  + "pixel size from the top-left of each margin; nothing resizes it to the margin, and the file delivered is the "
  + "largest rendition (a WebP up to 2000 px wide). A standard site's pages have margins 0 px wide at every "
  + "viewport, so the image does not appear on one today.";

const OPACITY_RENDERS = "Sets the opacity of the canvas image layer in the same side margins; it applies only while a "
  + "canvas image is set.";

/** The page background image's rendering, stated once for the theme reference, `help settings` and the README. */
export const PAGE_BACKGROUND_IMAGE_RENDERING = "One layer across the whole page box, behind the content. The header and "
  + "footer paint their own opaque backgrounds over it, so it shows behind the main content only.";

export const PAGE_BACKGROUND_VERSUS_CANVAS = Object.freeze({
  pageBackground:
    "Page style > Background image is the theme's pageBackgroundImage (with pageBackgroundImageOpacity) in "
    + "settings.lightTheme and settings.darkTheme. " + PAGE_BACKGROUND_IMAGE_RENDERING + " Today its value is a CSS "
    + "url(...) of a delivered image, taken from the src that .taproot-site-media.json records; there is no image-id "
    + "field for it.",
  canvas:
    "Page canvas > Canvas image is lightCanvasImageId and darkCanvasImageId in settings/taproot-styles.json, with "
    + "their opacity fields. It paints only the side margins outside the page content.",
  shared:
    "Neither sets a size, repeat or position, so both tile at the image's natural pixel size from the top-left. The "
    + "published site copies the file the URL names into its own assets; it does not resize it.",
});

const TAPROOT_STYLES_ENTRIES = {
  lightTheme: entry(
    "Brand & style (light scheme)",
    "The complete Espalier theme for the light scheme: colors, fonts, scales and the page background image.",
    "Every published page, in the light scheme. help theme lists the fields.",
  ),
  darkTheme: entry(
    "Brand & style (dark scheme)",
    "The complete Espalier theme for the dark scheme: colors, fonts, scales and the page background image.",
    "Every published page, in the dark scheme. help theme lists the fields.",
  ),
  defaultScheme: entry(
    `${BRAND} > Default scheme`,
    "The color scheme a first-time visitor sees: light, dark, or system to follow the visitor's device.",
    "The starting scheme of every published page. A visitor who uses the theme toggle keeps their own choice.",
  ),
  lightLogoId: entry(
    `${BRAND} > Logo`,
    "The site-owned image used as the brand logo in the light scheme.",
    LOGO_RENDERS,
  ),
  lightLogoUrl: entry(`${BRAND} > Logo`, "Read-only: the delivery URL of lightLogoId."),
  darkLogoId: entry(
    `${BRAND} > Logo`,
    "The site-owned image used as the brand logo in the dark scheme.",
    LOGO_RENDERS,
  ),
  darkLogoUrl: entry(`${BRAND} > Logo`, "Read-only: the delivery URL of darkLogoId."),
  lightCanvasImageId: entry(
    "Brand & style > Page canvas > Canvas image",
    "The site-owned image painted in the side margins of a page in the light scheme.",
    CANVAS_RENDERS,
  ),
  lightCanvasImageUrl: entry(
    "Brand & style > Page canvas > Canvas image",
    "Read-only: the delivery URL of lightCanvasImageId.",
  ),
  darkCanvasImageId: entry(
    "Brand & style > Page canvas > Canvas image",
    "The site-owned image painted in the side margins of a page in the dark scheme.",
    CANVAS_RENDERS,
  ),
  darkCanvasImageUrl: entry(
    "Brand & style > Page canvas > Canvas image",
    "Read-only: the delivery URL of darkCanvasImageId.",
  ),
  lightCanvasImageOpacity: entry(
    "Brand & style > Page canvas > Canvas image",
    "How strongly the light canvas image shows, from 0 (invisible) to 1 (fully opaque).",
    OPACITY_RENDERS,
  ),
  darkCanvasImageOpacity: entry(
    "Brand & style > Page canvas > Canvas image",
    "How strongly the dark canvas image shows, from 0 (invisible) to 1 (fully opaque).",
    OPACITY_RENDERS,
  ),
};

const BRAND_ENTRIES = {
  faviconId: entry(
    `${BRAND} > Favicon`,
    "The square site-owned image the platform turns into the site's icon set.",
    "Linked from the head of every published page as favicon.ico, square PNGs from 16 to 512 px and a 180 px Apple "
      + "touch icon. A site with no favicon still serves /favicon.ico: a neutral mark on a standard site, the Taproot mark on a "
      + "profile site. Use a simplified square mark, not a "
      + "full wordmark.",
  ),
  faviconUrl: entry(`${BRAND} > Favicon`, "Read-only: the delivery URL of faviconId."),
};

const HEADER_ENTRIES = {
  headerLayout: entry(
    `${HEADER} > Layout`,
    "How the brand, menu and buttons are arranged: standard (one row), centered-brand, minimal (the menu stays in "
      + "the drawer) or centered-menu (brand at the start, buttons at the end, menu centered).",
    "The header at the top of every published page.",
  ),
  headerWidth: entry(
    `${HEADER} > Width`,
    "contained keeps the brand and buttons at the page content edges; wide moves them to the viewport edges.",
    "The header bar's content. Its background spans the viewport either way.",
  ),
  navDrawerStyle: entry(
    `${HEADER} > Mobile menu`,
    "How the navigation opens when it does not fit inline: full-screen over the whole viewport (the default) or as a "
      + "side panel.",
    "The drawer opened by the header's burger button, on narrow screens and wherever the menu is drawer-only.",
  ),
  navDrawerTransition: entry(
    `${HEADER} > Menu transition`,
    "How the full-screen drawer appears: fade, slide-down, slide-up, slide-left or slide-right.",
    "Applies only while navDrawerStyle is full-screen.",
  ),
  brandText: entry(
    `${BRAND} > Brand text`,
    "The site name printed in the header brand.",
    "The header, beside or instead of the logo, when showBrandText is on, and the footer's brand once the footer is "
      + "enabled.",
  ),
  showBrandText: entry(
    `${HEADER} > Brand text`,
    "Whether brandText is printed in the header.",
    "The header brand.",
  ),
  logoAlt: entry(
    `${BRAND} > Logo alternative text`,
    "The alternative text of the header logo image, read aloud and shown if the image fails.",
    "The header logo and the footer's brand logo.",
  ),
  brandColor: entry(
    `${BRAND} > Brand color`,
    "The color of the brand text in both schemes, as a theme token or a custom color. Empty uses the header default.",
    "The header brand text and the footer's brand text. lightBrandColor or darkBrandColor overrides it for one scheme.",
  ),
  lightBrandColor: entry(
    `${BRAND} > Brand color`,
    "The brand text color in the light scheme. Empty falls back to brandColor, then to darkBrandColor.",
    "The header and footer brand text in the light scheme.",
  ),
  darkBrandColor: entry(
    `${BRAND} > Brand color`,
    "The brand text color in the dark scheme. Empty falls back to brandColor, then to the light color.",
    "The header and footer brand text in the dark scheme.",
  ),
  navMenuDisplay: entry(
    `${HEADER} > Navigation`,
    "auto shows the menu inline when it fits and falls back to the drawer; drawer always uses the burger and drawer.",
    "The header menu.",
  ),
  headerPosition: entry(
    `${HEADER} > Position`,
    "normal lets the header scroll away with the page; sticky keeps it at the top once it reaches it.",
    "The header at the top of every published page.",
  ),
  showThemeToggle: entry(
    `${HEADER} > Theme toggle`,
    "Whether visitors get a light/dark toggle in the header.",
    "The header buttons.",
  ),
  brandLogoSize: entry(
    `${HEADER} > Logo size`,
    "How tall the header logo is: standard (0.72 of the header height), large (0.85) or full (the whole header height).",
    "The header logo.",
  ),
  brandHoverGrow: entry(
    `${HEADER} > Hover emphasis`,
    "Whether the header brand grows slightly while the pointer is over it.",
    "The header brand.",
  ),
};

const PREFERENCES_ENTRIES = {
  commentsMode: entry(
    `${FEATURES} > Comments`,
    "Who may comment on articles, recipes, place reviews and albums, and whether a comment needs approval. pull records the enum member name, such as SITE_COMMENTS_MODE_AUTHENTICATED.",
    "The comments section under those pages.",
    "SITE_COMMENTS_MODE_AUTHENTICATED",
  ),
  tiptapImagePlacement: entry(
    `${FEATURES} > Image placement`,
    "The site's default placement for images in a page body: left, left-text-right, center, right or right-text-left.",
    "Images in page bodies.",
    "left",
  ),
  timeZone: entry(
    `${FEATURES} > Time zone`,
    "The site's IANA time zone, which decides what \"today\" means for relative date limits on forms.",
    "Form date pickers and the check at submit. A change applies after a deployment.",
    "UTC",
  ),
  allowSearch: entry(
    `${FEATURES} > Search`,
    "Whether the published site offers site search.",
    "The header search button. A change applies after a deployment.",
    false,
  ),
  showFollowButton: entry(
    `${FEATURES} > Follow button`,
    "Whether pages show a Follow button. Readers need a Taproot account to follow an author, so leave it off until "
      + "reader sign-up is available.",
    "The byline of article, album, recipe and place-review pages and the profile home. A change applies after a "
      + "deployment.",
    false,
  ),
  albumSeamless: entry(
    `${FEATURES} > Album layout`,
    "Whether album images sit edge to edge (seamless) by default. An album can set its own seamless value.",
    "Album pages.",
    false,
  ),
  hideLightboxComments: entry(
    `${FEATURES} > Comments in the lightbox`,
    "True hides comments inside the image lightbox; the app shows this as a switch that reads the other way round.",
    "The image lightbox.",
    false,
  ),
  tiptapImageMaxHeightVh: entry(
    `${FEATURES} > Image height`,
    "The tallest an image in a page body may be, as a percent of the screen height (45, 60, 75 or 90).",
    "Images in page bodies.",
    60,
  ),
  tiptapImageMaxImagesPerRow: entry(
    `${FEATURES} > Consecutive images per row`,
    "How many consecutive images in a page body share a row: 1, 2 or 3.",
    "Images in page bodies.",
    2,
  ),
  tiptapImageBorderWidth: entry(
    `${FEATURES} > Image border width`,
    "The border around images in a page body in pixels, from 0 (no border) to 20.",
    "Images in page bodies.",
    2,
  ),
  albumBorderWidth: entry(
    `${FEATURES} > Album border width`,
    "The default border around album images in pixels, from 0 to 20. An album can set its own borderWidth.",
    "Album pages.",
    0,
  ),
  albumMaxImagesPerRow: entry(
    `${FEATURES} > Maximum images per album row`,
    "The most images an album shows side by side in one row, from 1 to 5.",
    "Album pages.",
    2,
  ),
  albumMaxRowHeightVh: entry(
    `${FEATURES} > Album maximum row height`,
    "The tallest an album row may be, as a percent of the screen height (1 to 100). A partial last row stays no "
      + "taller than the rows before it.",
    "Album pages.",
    90,
  ),
  footerSettings: entry(
    "Footer",
    "The whole footer: link columns, aside and bottom text, brand, feature image and per-scheme colors and background.",
    "The footer of every published page, but only once footerSettings.enabled is true. help footer has the closed "
      + "schema.",
    { enabled: false },
  ),
};

export const SETTING_FIELD_REFERENCE = Object.freeze({
  [SETTINGS_TYPE_TAPROOT_STYLES]: Object.freeze(TAPROOT_STYLES_ENTRIES),
  [SETTINGS_TYPE_BRAND]: Object.freeze(BRAND_ENTRIES),
  [SETTINGS_TYPE_SITE_HEADER]: Object.freeze(HEADER_ENTRIES),
  [SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES]: Object.freeze(PREFERENCES_ENTRIES),
});

/** The description, app control and rendering note for one catalog field, for the references that list it. */
export function describeSettingField(settingsType, name) {
  const known = SETTING_FIELD_REFERENCE[settingsType]?.[name];
  if (known === undefined) throw new TypeError(`No setting reference for ${settingsType} ${name}.`);
  return known;
}

const WRITABLE_SCALARS = new Set(
  APPEARANCE_SCALAR_FIELDS.map((field) => `${field.settingsType}:${field.name}`),
);
const THEME_FOOTER_COLORS = APPEARANCE_FOOTER_COLOR_FIELDS.length;

/** How the CLI changes a field: the verb that writes it, or that it is read-only here. */
function writeVerb(group, field) {
  if (field.wireType === "theme" || WRITABLE_SCALARS.has(`${group.settingsType}:${field.name}`)) return "theme push";
  if (field.name === "footerSettings") {
    return `footer push (content); theme push (the ${THEME_FOOTER_COLORS} scheme colors)`;
  }
  if (field.name.endsWith("Url")) return "read-only projection of the matching id; never authored";
  return "read-only: pull records it, change it in the app";
}

/**
 * App controls that save into lightTheme and darkTheme rather than a field of
 * their own, so a lookup by label still finds a path. Both schemes carry each
 * field; the app edits the scheme it is showing.
 */
export const THEME_CONTROLS = Object.freeze([
  Object.freeze({
    appLabel: "Brand & style > Color harmony (and its hue and chroma controls)",
    fields: Object.freeze(["seedColor", "angles", "variantChroma"]),
  }),
  Object.freeze({
    appLabel: "Brand & style > Semantic color mappings > Color source",
    fields: Object.freeze(["semanticMappings"]),
  }),
  Object.freeze({
    appLabel: "Brand & style > Page style > Background image",
    fields: Object.freeze(["pageBackgroundImage", "pageBackgroundImageOpacity"]),
    renders: PAGE_BACKGROUND_IMAGE_RENDERING,
  }),
  Object.freeze({
    appLabel: "Brand & style > Brand > Brand font and Brand weight",
    fields: Object.freeze(["fontBrand", "fontWeightBrand"]),
  }),
  Object.freeze({
    appLabel: "Brand & style > Brand > Menu font and Menu weight",
    fields: Object.freeze(["fontMenu", "fontWeightMenu"]),
  }),
  Object.freeze({
    appLabel: "Brand & style > Typography > Headings and Headings weight",
    fields: Object.freeze(["fontHeadings", "fontWeightHeadings"]),
  }),
  Object.freeze({
    appLabel: "Brand & style > Typography > Body and Body weight",
    fields: Object.freeze(["fontBody", "fontWeightBody"]),
  }),
  Object.freeze({
    appLabel: "Brand & style > Typography > Monospace and Monospace weight",
    fields: Object.freeze(["fontMonospace", "fontWeightMonospace"]),
  }),
]);

/** The reference `help settings` prints: every catalog field with its meaning, app control and write path. */
export function getSettingsReference() {
  const scalarDefaults = new Map(
    APPEARANCE_SCALAR_FIELDS.map((field) => [`${field.settingsType}:${field.name}`, field.default]),
  );
  return {
    title: "Site settings: what each field is, which app control it is, and where it renders",
    referenceKind: "settings",
    usage: "pull | theme push | footer push",
    groups: SETTINGS_GROUPS.map((group) => ({
      file: `settings/${group.file}`,
      fields: group.fields.map((field) => {
        const known = SETTING_FIELD_REFERENCE[group.settingsType][field.name];
        const scalarKey = `${group.settingsType}:${field.name}`;
        const defaultValue = scalarDefaults.has(scalarKey) ? scalarDefaults.get(scalarKey) : known.default;
        return {
          path: `settings.${field.name}`,
          wireType: field.wireType,
          appLabel: known.appLabel,
          description: known.description,
          ...(defaultValue === undefined ? {} : { default: defaultValue }),
          ...(known.renders === undefined ? {} : { renders: known.renders }),
          write: writeVerb(group, field),
        };
      }),
    })),
    themeControls: THEME_CONTROLS.map((control) => ({
      ...control,
      file: "settings/taproot-styles.json",
      paths: ["settings.lightTheme", "settings.darkTheme"],
    })),
    pageBackgroundVersusCanvas: PAGE_BACKGROUND_VERSUS_CANVAS,
  };
}

export function formatSettingsReference(reference) {
  const groups = reference.groups.map((group) =>
    `${group.file}\n${
      group.fields.map((field) =>
        `  ${field.path}  (${field.wireType}; ${field.write}${
          field.default === undefined ? "" : `; default ${JSON.stringify(field.default)}`
        })\n    app: ${field.appLabel}\n    ${field.description}${
          field.renders === undefined ? "" : `\n    renders: ${field.renders}`
        }`
      ).join("\n")
    }`
  ).join("\n\n");
  const controls = reference.themeControls.map((control) =>
    `  ${control.appLabel}\n    ${control.file} :: ${control.paths.join(" and ")} :: ${control.fields.join(", ")}${
      control.renders === undefined ? "" : `\n    renders: ${control.renders}`
    }`
  ).join("\n");
  const contrast = reference.pageBackgroundVersusCanvas;
  return `${reference.title}\nUsage: ${reference.usage}\n\nPage background image versus canvas image:\n  - ${
    contrast.pageBackground
  }\n  - ${contrast.canvas}\n  - ${contrast.shared}\n\nApp controls stored inside the theme (help theme describes each field):\n${controls}\n\n${groups}\n`;
}
