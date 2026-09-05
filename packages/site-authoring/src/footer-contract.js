import {
  CONTACT_OR_WEB_URL_MAX_LENGTH,
  CONTACT_OR_WEB_URL_REQUIREMENT,
  isContactOrWebUrl,
} from "./contact-url.js";
import { hasControlCharacter, isCanonicalUuid, SiteAuthoringError } from "./errors.js";
import { FOOTER_COLOR_TOKENS, requireAppearanceColor } from "./theme-validation.js";

export const FOOTER_LIMITS = Object.freeze({
  linkColumns: 6,
  linkGroups: 12,
  groupsPerColumn: 6,
  linksPerGroup: 12,
  bottomLinks: 8,
  richTextParagraphs: 12,
  richTextRuns: 200,
  groupHeadingLength: 80,
  asideHeadingLength: 120,
  asideBodyLength: 1_000,
  linkLabelLength: 120,
  bottomTextLength: 500,
  featureImageAltLength: 300,
  externalUrlLength: CONTACT_OR_WEB_URL_MAX_LENGTH,
  backgroundRepeatHeightMinimum: 64,
  backgroundRepeatHeightMaximum: 512,
  backgroundRepeatHeightStep: 16,
  backgroundRepeatHeightDefault: 160,
  additionalTopPaddingRemMaximum: 20,
});

export const FOOTER_BACKGROUND_PRESENTATIONS = Object.freeze([
  "FOOTER_BACKGROUND_PRESENTATION_TILE",
  "FOOTER_BACKGROUND_PRESENTATION_REPEAT_X",
  "FOOTER_BACKGROUND_PRESENTATION_COVER",
]);
export const FOOTER_FADE_MODES = Object.freeze([
  "FOOTER_FADE_MODE_NONE",
  "FOOTER_FADE_MODE_BOTTOM",
]);

// One ordered inventory drives the local closed-object checks, the request
// mapper (validation returns this exact shape), and reference help. The three
// response-only delivery fields remain in the inventory as read-only so a
// future proto edit cannot quietly become authorable.
export const FOOTER_FIELD_INVENTORY = Object.freeze({
  FooterSettings: Object.freeze([
    "enabled",
    "showBrand",
    "asideCta",
    "bottomLinks",
    "light",
    "dark",
    "linkColumns",
    "asideHeadingContent",
    "asideBodyContent",
    "bottomContent",
    "featureImage",
    "showBrandText",
  ]),
  FooterLinkColumn: Object.freeze(["id", "groups"]),
  FooterLinkGroup: Object.freeze(["id", "heading", "links"]),
  FooterLink: Object.freeze(["id", "label", "pageResourceId", "externalUrl"]),
  FooterRichText: Object.freeze(["paragraphs"]),
  FooterRichTextParagraph: Object.freeze(["runs"]),
  FooterRichTextRun: Object.freeze(["text", "bold", "italic", "underline", "link"]),
  FooterInlineLink: Object.freeze(["pageResourceId", "externalUrl"]),
  FooterSchemeSettings: Object.freeze([
    "backgroundColor",
    "textColor",
    "headingColor",
    "linkColor",
    "linkHoverColor",
    "backgroundImageId",
    "backgroundImageUrl",
    "backgroundImageOpacity",
    "backgroundPresentation",
    "backgroundFade",
    "backgroundRepeatHeightPx",
    "additionalTopPaddingRem",
  ]),
  FooterFeatureImageSettings: Object.freeze(["imageId", "imageUrl", "alt", "responsiveUrls"]),
  FooterFeatureResponsiveImageUrl: Object.freeze(["minWidth", "url"]),
});

export const FOOTER_READ_ONLY_FIELDS = Object.freeze([
  "light.backgroundImageUrl",
  "dark.backgroundImageUrl",
  "featureImage.imageUrl",
  "featureImage.responsiveUrls",
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code, message, field) {
  throw new SiteAuthoringError(code, message, { field });
}

function object(value, path, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (!isPlainObject(value)) fail("footer.document_invalid", `${path} must be a JSON object.`, path);
  return value;
}

function closed(value, type, path) {
  const allowed = FOOTER_FIELD_INVENTORY[type];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail("footer.field_unknown", `${path}.${key} is not part of the closed footer contract.`, `${path}.${key}`);
    }
  }
}

function array(value, path, maximum) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("footer.field_invalid", `${path} must be an array.`, path);
  if (value.length > maximum) {
    fail("footer.collection_too_large", `${path} may contain at most ${maximum} items.`, path);
  }
  return value;
}

function boolean(value, defaultValue, path) {
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") fail("footer.field_invalid", `${path} must be true or false.`, path);
  return value;
}

function number(value, defaultValue, path, minimum, maximum) {
  if (value === undefined) return defaultValue;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail("footer.field_invalid", `${path} must be a finite number from ${minimum} through ${maximum}.`, path);
  }
  return value;
}

function choice(value, defaultValue, choices, path) {
  if (value === undefined) return defaultValue;
  if (typeof value !== "string" || !choices.includes(value)) {
    fail("footer.field_invalid", `${path} must be one of ${choices.join(", ")}.`, path);
  }
  return value;
}

function isDotNetWhiteSpace(character) {
  const codePoint = character.codePointAt(0);
  return (codePoint >= 0x0009 && codePoint <= 0x000d)
    || codePoint === 0x0020
    || codePoint === 0x0085
    || codePoint === 0x00a0
    || codePoint === 0x1680
    || (codePoint >= 0x2000 && codePoint <= 0x200a)
    || codePoint === 0x2028
    || codePoint === 0x2029
    || codePoint === 0x202f
    || codePoint === 0x205f
    || codePoint === 0x3000;
}

function normalizeSingleLineLikeServer(value) {
  let result = "";
  let pendingSpace = false;
  for (const character of value) {
    if (isDotNetWhiteSpace(character)) {
      pendingSpace = result.length > 0;
      continue;
    }
    if (pendingSpace) result += " ";
    pendingSpace = false;
    result += character;
  }
  return result;
}

function trimLikeServer(value) {
  let start = 0;
  let end = value.length;
  while (start < end && isDotNetWhiteSpace(value[start])) start += 1;
  while (end > start && isDotNetWhiteSpace(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

function normalizedSingleLine(value, maximum, path, { required = false, tolerateStoredValues = false } = {}) {
  if (value === undefined) value = "";
  if (typeof value !== "string" || value.length > maximum) {
    fail("footer.text_invalid", `${path} must be a bounded plain-text string of at most ${maximum} characters.`, path);
  }
  const normalized = normalizeSingleLineLikeServer(value);
  if (!tolerateStoredValues && hasControlCharacter(normalized)) {
    fail("footer.text_invalid", `${path} must be a bounded plain-text string of at most ${maximum} characters.`, path);
  }
  if (required && normalized.length === 0) fail("footer.text_required", `${path} is required.`, path);
  return normalized;
}

function stableId(value, path, seen, label) {
  if (!isCanonicalUuid(value)) {
    fail("footer.id_invalid", `${path} must be a canonical lowercase ${label} UUID.`, path);
  }
  if (seen.has(value)) fail("footer.id_duplicate", `${path} duplicates another ${label} UUID.`, path);
  seen.add(value);
  return value;
}

// A `tel:` or `mailto:` target is returned exactly as authored: the number's
// punctuation and the address's plus-tag are content, and `URL.toString()`
// re-encodes both. Only the whitespace the server would strip is removed.
function safeExternalUrl(value, path, tolerateStoredValues) {
  if (typeof value !== "string") {
    fail("footer.url_invalid", `${path} ${CONTACT_OR_WEB_URL_REQUIREMENT}.`, path);
  }
  const normalized = trimLikeServer(value);
  if (tolerateStoredValues) return normalized;
  if (!isContactOrWebUrl(normalized, FOOTER_LIMITS.externalUrlLength)) {
    fail("footer.url_invalid", `${path} ${CONTACT_OR_WEB_URL_REQUIREMENT}.`, path);
  }
  return normalized;
}

function target(value, path, knownPageResourceIds, tolerateStoredValues) {
  const hasPage = Object.hasOwn(value, "pageResourceId");
  const hasExternal = Object.hasOwn(value, "externalUrl");
  if (hasPage === hasExternal) {
    fail(
      "footer.target_invalid",
      `${path} must contain exactly one of pageResourceId or externalUrl.`,
      path,
    );
  }
  if (hasPage) {
    if (!isCanonicalUuid(value.pageResourceId)) {
      fail("footer.id_invalid", `${path}.pageResourceId must be a canonical lowercase UUID.`, `${path}.pageResourceId`);
    }
    if (knownPageResourceIds && !knownPageResourceIds.has(value.pageResourceId)) {
      fail(
        "footer.page_reference_unknown",
        `${path}.pageResourceId must identify a page tracked by the pull manifest.`,
        `${path}.pageResourceId`,
      );
    }
    return { pageResourceId: value.pageResourceId };
  }
  return { externalUrl: safeExternalUrl(value.externalUrl, `${path}.externalUrl`, tolerateStoredValues) };
}

function inlineLink(value, path, knownPageResourceIds, tolerateStoredValues) {
  if (value === undefined || value === null) return undefined;
  value = object(value, path);
  closed(value, "FooterInlineLink", path);
  return target(value, path, knownPageResourceIds, tolerateStoredValues);
}

function richText(value, path, maximumLength, maximumParagraphs, knownPageResourceIds, tolerateStoredValues) {
  if (value === undefined || value === null) return { paragraphs: [] };
  value = object(value, path);
  closed(value, "FooterRichText", path);
  const paragraphs = array(value.paragraphs, `${path}.paragraphs`, maximumParagraphs);
  let totalLength = 0;
  let totalRuns = 0;
  const normalizedParagraphs = paragraphs.map((paragraph, paragraphIndex) => {
    const paragraphPath = `${path}.paragraphs[${paragraphIndex}]`;
    paragraph = object(paragraph, paragraphPath);
    closed(paragraph, "FooterRichTextParagraph", paragraphPath);
    const runs = array(paragraph.runs, `${paragraphPath}.runs`, FOOTER_LIMITS.richTextRuns);
    const normalizedRuns = [];
    for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
      const runPath = `${paragraphPath}.runs[${runIndex}]`;
      const run = object(runs[runIndex], runPath);
      closed(run, "FooterRichTextRun", runPath);
      if (
        typeof run.text !== "string"
        || (!tolerateStoredValues && hasControlCharacter(run.text.replace(/[\n\r\t]/gu, "")))
      ) {
        fail("footer.text_invalid", `${runPath}.text must be plain text.`, `${runPath}.text`);
      }
      const text = run.text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
      if (text.length === 0) continue;
      totalLength += text.length;
      totalRuns += 1;
      normalizedRuns.push({
        text,
        bold: boolean(run.bold, false, `${runPath}.bold`),
        italic: boolean(run.italic, false, `${runPath}.italic`),
        underline: boolean(run.underline, false, `${runPath}.underline`),
        ...(run.link === undefined || run.link === null
          ? {}
          : { link: inlineLink(run.link, `${runPath}.link`, knownPageResourceIds, tolerateStoredValues) }),
      });
    }
    return { runs: normalizedRuns };
  });
  if (totalLength > maximumLength) {
    fail("footer.text_too_long", `${path} may contain at most ${maximumLength} characters.`, path);
  }
  if (totalRuns > FOOTER_LIMITS.richTextRuns) {
    fail("footer.collection_too_large", `${path} may contain at most ${FOOTER_LIMITS.richTextRuns} styled runs.`, path);
  }
  return { paragraphs: normalizedParagraphs };
}

function footerLink(value, path, seenLinkIds, knownPageResourceIds, tolerateStoredValues) {
  value = object(value, path);
  closed(value, "FooterLink", path);
  return {
    id: stableId(value.id, `${path}.id`, seenLinkIds, "link"),
    label: normalizedSingleLine(value.label, FOOTER_LIMITS.linkLabelLength, `${path}.label`, {
      required: true,
      tolerateStoredValues,
    }),
    ...target(value, path, knownPageResourceIds, tolerateStoredValues),
  };
}

function footerLinks(values, path, maximum, seenLinkIds, knownPageResourceIds, tolerateStoredValues) {
  return array(values, path, maximum).map((value, index) =>
    footerLink(value, `${path}[${index}]`, seenLinkIds, knownPageResourceIds, tolerateStoredValues)
  );
}

function imageId(value, path, knownImageIds) {
  if (value === undefined || value === "") return "";
  if (!isCanonicalUuid(value)) {
    fail("footer.id_invalid", `${path} must be empty or a canonical lowercase site-owned image UUID.`, path);
  }
  if (knownImageIds && !knownImageIds.has(value)) {
    fail(
      "footer.image_reference_unknown",
      `${path} must identify media recorded by pull or 'taproot-site media upload'.`,
      path,
    );
  }
  return value;
}

function rejectReadOnly(value, field, path) {
  if (Object.hasOwn(value, field)) {
    fail(
      "footer.field_read_only",
      `${path}.${field} is a server-resolved read-only projection; remove it and author the stable image id instead.`,
      `${path}.${field}`,
    );
  }
}

function scheme(value, path, knownImageIds) {
  value = value === undefined || value === null ? {} : object(value, path);
  closed(value, "FooterSchemeSettings", path);
  rejectReadOnly(value, "backgroundImageUrl", path);
  const repeatHeight = value.backgroundRepeatHeightPx ?? FOOTER_LIMITS.backgroundRepeatHeightDefault;
  if (
    !Number.isInteger(repeatHeight)
    || repeatHeight < FOOTER_LIMITS.backgroundRepeatHeightMinimum
    || repeatHeight > FOOTER_LIMITS.backgroundRepeatHeightMaximum
    || (repeatHeight - FOOTER_LIMITS.backgroundRepeatHeightMinimum) % FOOTER_LIMITS.backgroundRepeatHeightStep !== 0
  ) {
    fail(
      "footer.field_invalid",
      `${path}.backgroundRepeatHeightPx must be an integer from ${FOOTER_LIMITS.backgroundRepeatHeightMinimum} through ${FOOTER_LIMITS.backgroundRepeatHeightMaximum} in ${FOOTER_LIMITS.backgroundRepeatHeightStep}-pixel steps.`,
      `${path}.backgroundRepeatHeightPx`,
    );
  }
  return {
    backgroundColor: requireAppearanceColor(
      value.backgroundColor ?? "",
      FOOTER_COLOR_TOKENS.backgroundColor,
      `${path}.backgroundColor`,
    ),
    textColor: requireAppearanceColor(value.textColor ?? "", FOOTER_COLOR_TOKENS.textColor, `${path}.textColor`),
    headingColor: requireAppearanceColor(
      value.headingColor ?? "",
      FOOTER_COLOR_TOKENS.headingColor,
      `${path}.headingColor`,
    ),
    linkColor: requireAppearanceColor(value.linkColor ?? "", FOOTER_COLOR_TOKENS.linkColor, `${path}.linkColor`),
    linkHoverColor: requireAppearanceColor(
      value.linkHoverColor ?? "",
      FOOTER_COLOR_TOKENS.linkHoverColor,
      `${path}.linkHoverColor`,
    ),
    backgroundImageId: imageId(value.backgroundImageId, `${path}.backgroundImageId`, knownImageIds),
    backgroundImageOpacity: number(value.backgroundImageOpacity, 1, `${path}.backgroundImageOpacity`, 0, 1),
    backgroundPresentation: choice(
      value.backgroundPresentation,
      FOOTER_BACKGROUND_PRESENTATIONS[0],
      FOOTER_BACKGROUND_PRESENTATIONS,
      `${path}.backgroundPresentation`,
    ),
    backgroundFade: choice(
      value.backgroundFade,
      FOOTER_FADE_MODES[0],
      FOOTER_FADE_MODES,
      `${path}.backgroundFade`,
    ),
    backgroundRepeatHeightPx: repeatHeight,
    additionalTopPaddingRem: number(
      value.additionalTopPaddingRem,
      0,
      `${path}.additionalTopPaddingRem`,
      0,
      FOOTER_LIMITS.additionalTopPaddingRemMaximum,
    ),
  };
}

function featureImage(value, knownImageIds, tolerateStoredValues) {
  if (value === undefined || value === null) return undefined;
  value = object(value, "footerSettings.featureImage");
  closed(value, "FooterFeatureImageSettings", "footerSettings.featureImage");
  rejectReadOnly(value, "imageUrl", "footerSettings.featureImage");
  rejectReadOnly(value, "responsiveUrls", "footerSettings.featureImage");
  const id = imageId(value.imageId, "footerSettings.featureImage.imageId", knownImageIds);
  const alt = normalizedSingleLine(
    value.alt,
    FOOTER_LIMITS.featureImageAltLength,
    "footerSettings.featureImage.alt",
    { tolerateStoredValues },
  );
  if (id === "" && alt === "") return undefined;
  if (id === "") {
    fail(
      "footer.id_invalid",
      "footerSettings.featureImage.imageId is required.",
      "footerSettings.featureImage.imageId",
    );
  }
  if (alt === "") {
    fail(
      "footer.alt_required",
      "footerSettings.featureImage.alt is required for an accessible feature image.",
      "footerSettings.featureImage.alt",
    );
  }
  return { imageId: id, alt };
}

export function footerDefaults() {
  const defaults = () => ({
    backgroundColor: "",
    textColor: "",
    headingColor: "",
    linkColor: "",
    linkHoverColor: "",
    backgroundImageId: "",
    backgroundImageOpacity: 1,
    backgroundPresentation: FOOTER_BACKGROUND_PRESENTATIONS[0],
    backgroundFade: FOOTER_FADE_MODES[0],
    backgroundRepeatHeightPx: FOOTER_LIMITS.backgroundRepeatHeightDefault,
    additionalTopPaddingRem: 0,
  });
  return {
    enabled: false,
    showBrand: true,
    asideCta: undefined,
    bottomLinks: [],
    light: defaults(),
    dark: defaults(),
    linkColumns: [],
    asideHeadingContent: { paragraphs: [] },
    asideBodyContent: { paragraphs: [] },
    bottomContent: { paragraphs: [] },
    featureImage: undefined,
    showBrandText: true,
  };
}

function normalizeFooterDocument(
  value,
  { knownPageResourceIds, knownImageIds, tolerateStoredValues = false } = {},
) {
  value = object(value ?? {}, "footerSettings");
  closed(value, "FooterSettings", "footerSettings");
  const seenColumnIds = new Set();
  const seenGroupIds = new Set();
  const seenLinkIds = new Set();
  let groupCount = 0;
  const linkColumns = array(value.linkColumns, "footerSettings.linkColumns", FOOTER_LIMITS.linkColumns)
    .map((column, columnIndex) => {
      const columnPath = `footerSettings.linkColumns[${columnIndex}]`;
      column = object(column, columnPath);
      closed(column, "FooterLinkColumn", columnPath);
      const groups = array(column.groups, `${columnPath}.groups`, FOOTER_LIMITS.groupsPerColumn)
        .map((group, groupIndex) => {
          groupCount += 1;
          const groupPath = `${columnPath}.groups[${groupIndex}]`;
          group = object(group, groupPath);
          closed(group, "FooterLinkGroup", groupPath);
          const links = footerLinks(
            group.links,
            `${groupPath}.links`,
            FOOTER_LIMITS.linksPerGroup,
            seenLinkIds,
            knownPageResourceIds,
            tolerateStoredValues,
          );
          return {
            id: stableId(group.id, `${groupPath}.id`, seenGroupIds, "group"),
            heading: normalizedSingleLine(
              group.heading,
              FOOTER_LIMITS.groupHeadingLength,
              `${groupPath}.heading`,
              { required: links.length > 0, tolerateStoredValues },
            ),
            links,
          };
        });
      return {
        id: stableId(column.id, `${columnPath}.id`, seenColumnIds, "column"),
        groups,
      };
    });
  if (groupCount > FOOTER_LIMITS.linkGroups) {
    fail(
      "footer.collection_too_large",
      `footerSettings.linkColumns may contain at most ${FOOTER_LIMITS.linkGroups} groups in total.`,
      "footerSettings.linkColumns",
    );
  }

  const normalizedFeatureImage = featureImage(value.featureImage, knownImageIds, tolerateStoredValues);
  return {
    enabled: boolean(value.enabled, false, "footerSettings.enabled"),
    showBrand: boolean(value.showBrand, true, "footerSettings.showBrand"),
    ...(value.asideCta === undefined || value.asideCta === null
      ? {}
      : {
        asideCta: footerLink(
          value.asideCta,
          "footerSettings.asideCta",
          seenLinkIds,
          knownPageResourceIds,
          tolerateStoredValues,
        ),
      }),
    bottomLinks: footerLinks(
      value.bottomLinks,
      "footerSettings.bottomLinks",
      FOOTER_LIMITS.bottomLinks,
      seenLinkIds,
      knownPageResourceIds,
      tolerateStoredValues,
    ),
    light: scheme(value.light, "footerSettings.light", knownImageIds),
    dark: scheme(value.dark, "footerSettings.dark", knownImageIds),
    linkColumns,
    asideHeadingContent: richText(
      value.asideHeadingContent,
      "footerSettings.asideHeadingContent",
      FOOTER_LIMITS.asideHeadingLength,
      1,
      knownPageResourceIds,
      tolerateStoredValues,
    ),
    asideBodyContent: richText(
      value.asideBodyContent,
      "footerSettings.asideBodyContent",
      FOOTER_LIMITS.asideBodyLength,
      FOOTER_LIMITS.richTextParagraphs,
      knownPageResourceIds,
      tolerateStoredValues,
    ),
    bottomContent: richText(
      value.bottomContent,
      "footerSettings.bottomContent",
      FOOTER_LIMITS.bottomTextLength,
      FOOTER_LIMITS.richTextParagraphs,
      knownPageResourceIds,
      tolerateStoredValues,
    ),
    ...(normalizedFeatureImage === undefined ? {} : { featureImage: normalizedFeatureImage }),
    showBrandText: boolean(value.showBrandText, true, "footerSettings.showBrandText"),
  };
}

/** Validates and normalizes the strict authorable workspace/request shape. */
export function validateFooterDocument(value, options = {}) {
  return normalizeFooterDocument(value, options);
}

function withoutServerProjections(value) {
  const projected = structuredClone(isPlainObject(value) ? value : {});
  for (const schemeName of ["light", "dark"]) {
    if (isPlainObject(projected[schemeName])) delete projected[schemeName].backgroundImageUrl;
  }
  if (isPlainObject(projected.featureImage)) {
    delete projected.featureImage.imageUrl;
    delete projected.featureImage.responsiveUrls;
  }
  return projected;
}

/** The editable workspace/request shape, with response-only delivery URLs gone. */
export function projectFooterSettingsForWorkspace(value) {
  return normalizeFooterDocument(withoutServerProjections(value), { tolerateStoredValues: true });
}

export function footerImageIds(value) {
  const ids = new Set();
  for (
    const candidate of [value?.light?.backgroundImageId, value?.dark?.backgroundImageId, value?.featureImage?.imageId]
  ) {
    if (isCanonicalUuid(candidate)) ids.add(candidate);
  }
  return [...ids].sort();
}

export const FOOTER_EXAMPLE = Object.freeze({
  enabled: true,
  showBrand: true,
  // The aside CTA is where a local business puts the thing a visitor came for.
  // A phone number is a `tel:` target, emitted verbatim so it stays dialable.
  asideCta: Object.freeze({
    id: "103e726d-3152-49c8-bf14-c947b1bd8a14",
    label: "Call the studio",
    externalUrl: "tel:+15555550123",
  }),
  bottomLinks: Object.freeze([
    Object.freeze({
      id: "28363e08-b341-42fc-bc83-8dd73fa87904",
      label: "Privacy",
      externalUrl: "https://example.com/privacy",
    }),
    Object.freeze({
      id: "9e2d1f04-4bb0-4a2d-9d1a-6d3b0d0a4c77",
      label: "Email us",
      externalUrl: "mailto:hello@example.com",
    }),
  ]),
  light: Object.freeze({
    backgroundColor: "--esp-color-layer-1",
    textColor: "--esp-color-text",
    headingColor: "--esp-color-headings",
    linkColor: "--esp-color-link",
    linkHoverColor: "--esp-color-link-hover",
    backgroundImageId: "d461035a-74b6-4528-a4f5-e5a96fb50037",
    backgroundImageOpacity: 0.18,
    backgroundPresentation: "FOOTER_BACKGROUND_PRESENTATION_COVER",
    backgroundFade: "FOOTER_FADE_MODE_BOTTOM",
    backgroundRepeatHeightPx: 160,
    additionalTopPaddingRem: 0,
  }),
  dark: Object.freeze({
    backgroundColor: "--esp-color-background",
    textColor: "--esp-color-text",
    headingColor: "--esp-color-headings",
    linkColor: "--esp-color-link",
    linkHoverColor: "--esp-color-link-hover",
    backgroundImageId: "",
    backgroundImageOpacity: 1,
    backgroundPresentation: "FOOTER_BACKGROUND_PRESENTATION_TILE",
    backgroundFade: "FOOTER_FADE_MODE_NONE",
    backgroundRepeatHeightPx: 160,
    additionalTopPaddingRem: 0,
  }),
  linkColumns: Object.freeze([Object.freeze({
    id: "84bf7531-dfc8-453e-a78d-a5fa3348d56b",
    groups: Object.freeze([Object.freeze({
      id: "64789fae-8862-43ab-85ca-f3b41819bddb",
      heading: "Explore",
      links: Object.freeze([Object.freeze({
        id: "b84094e6-ebd3-42ce-8c32-80166d73391a",
        label: "About",
        pageResourceId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      })]),
    })]),
  })]),
  asideHeadingContent: Object.freeze({
    paragraphs: Object.freeze([Object.freeze({
      runs: Object.freeze([Object.freeze({ text: "Build a site worth returning to.", bold: true })]),
    })]),
  }),
  asideBodyContent: Object.freeze({
    paragraphs: Object.freeze([Object.freeze({
      runs: Object.freeze([Object.freeze({ text: "Own the relationship with your readers." })]),
    })]),
  }),
  bottomContent: Object.freeze({
    paragraphs: Object.freeze([Object.freeze({ runs: Object.freeze([Object.freeze({ text: "© Example Studio" })]) })]),
  }),
  featureImage: Object.freeze({
    imageId: "df51103e-6983-477d-8fc7-d59640e284df",
    alt: "A sunlit creative studio with books, artwork, and a writing desk",
  }),
  showBrandText: true,
});
