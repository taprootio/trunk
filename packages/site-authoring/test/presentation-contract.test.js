import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  APPEARANCE_FILES,
  APPEARANCE_FOOTER_COLOR_FIELDS,
  APPEARANCE_READ_ONLY_FIELDS,
  APPEARANCE_SCALAR_FIELDS,
} from "../src/appearance-contract.js";
import {
  FOOTER_EXAMPLE,
  FOOTER_FIELD_INVENTORY,
  FOOTER_LIMITS,
  FOOTER_READ_ONLY_FIELDS,
  projectFooterSettingsForWorkspace,
  validateFooterDocument,
} from "../src/footer-contract.js";
import { computeFooterDraftHash } from "../src/footer-draft-hash.js";
import {
  assertPresentationExamples,
  getAppearanceReference,
  getFooterReference,
  getThemeReference,
  THEME_FIELD_NAMES,
} from "../src/presentation-reference.js";
import { APPEARANCE_COLOR_CONSTRAINT } from "../src/theme-validation.js";
import {
  SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES,
  SETTINGS_TYPE_TAPROOT_STYLES,
} from "../src/settings-catalog.js";
import { MONOREPO_ONLY, monorepoPath } from "./monorepo.js";

// Server-side sources this package's help must stay aligned with. They exist
// only in the monorepo, so the tests that read them are monorepo-only.
const PROTO_PATH = monorepoPath("protos", "Settings.proto");
const HANDLER_PATH = monorepoPath(
  "api",
  "src",
  "Taproot.Data",
  "Settings",
  "SaveSiteFooterSettingsPipelineHandler.cs",
);
const SITE_SETTINGS_PATH = monorepoPath("api", "src", "Taproot.Domain", "Entities", "SiteSettings.cs");
const IMAGE_PROCESSING_PATH = monorepoPath("shared", "image-processing.json");
// Resolved through Espalier's export map beside the module it declares, not
// through a fixed node_modules path: a workspace install hoists the package
// above this directory, and this comparison is valid wherever the package is
// installed.
const THEME_DECLARATION_PATH = new URL("./theme.d.ts", import.meta.resolve("@taprootio/espalier/shared/theme"));

function declarationFields(source, interfaceName) {
  const start = source.indexOf(`export interface ${interfaceName} {`);
  assert.notEqual(start, -1, `${interfaceName} declaration exists`);
  const end = source.indexOf("\n}", start);
  return [...source.slice(start, end).matchAll(/^ {4}([A-Za-z][A-Za-z0-9]*)\??:/gmu)]
    .map((match) => match[1]);
}

function messageBody(source, messageName) {
  const marker = `message ${messageName} {`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${messageName} exists in Settings.proto`);
  let depth = 0;
  for (let index = start + marker.length - 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start + marker.length, index);
  }
  assert.fail(`${messageName} has a closing brace`);
}

function camelCase(value) {
  return value.replace(/_([a-z])/gu, (_, letter) => letter.toUpperCase());
}

function protoFields(source, messageName) {
  return [
    ...messageBody(source, messageName).matchAll(
      /^\s*(?:(?:optional|repeated)\s+)?[A-Za-z][A-Za-z0-9_.<>]*\s+([a-z][a-z0-9_]*)\s*=\s*\d+;/gmu,
    ),
  ].map((match) => camelCase(match[1]));
}

function csharpIntegerConstant(source, name) {
  const match = source.match(new RegExp(`public const int ${name} = ([0-9_]+);`, "u"));
  assert.ok(match, `${name} remains a public integer contract constant`);
  return Number(match[1].replaceAll("_", ""));
}

test("the presentation references expose examples accepted by their executable validators", () => {
  assert.doesNotThrow(() => assertPresentationExamples());
  assert.equal(getThemeReference().espalierVersion, "4.7.0");
  const normalizedFooter = validateFooterDocument(FOOTER_EXAMPLE);
  assert.equal(normalizedFooter.featureImage.alt, FOOTER_EXAMPLE.featureImage.alt);
  assert.equal(normalizedFooter.light.backgroundPresentation, "FOOTER_BACKGROUND_PRESENTATION_COVER");
});

test("theme help covers every installed EspalierTheme field exactly once with current vocabulary", () => {
  const declared = declarationFields(readFileSync(THEME_DECLARATION_PATH, "utf8"), "EspalierTheme");
  assert.deepEqual(new Set(THEME_FIELD_NAMES), new Set(declared));

  const reference = getThemeReference();
  const documented = reference.groups.flatMap((group) => group.fields.map((field) => field.name));
  assert.deepEqual(new Set(documented), new Set(declared));
  assert.equal(documented.length, new Set(documented).size);
  assert.deepEqual(reference.vocabulary.roles, ["canvas", "ink", "accent", "action", "structure"]);
  assert.deepEqual(reference.vocabulary.dataSeries, [
    "series1",
    "series2",
    "series3",
    "series4",
    "series5",
    "series6",
    "series7",
    "series8",
  ]);
  assert.doesNotMatch(JSON.stringify(reference), /surfaceRole|foregroundRole|Espalier 3/iu);
});

test("appearance help is derived from the same ordered registries theme push executes", () => {
  const reference = getAppearanceReference();
  const expected = [
    {
      file: APPEARANCE_FILES[SETTINGS_TYPE_TAPROOT_STYLES],
      path: "settings.lightTheme",
      type: "complete-espalier-theme",
    },
    {
      file: APPEARANCE_FILES[SETTINGS_TYPE_TAPROOT_STYLES],
      path: "settings.darkTheme",
      type: "complete-espalier-theme",
    },
    ...APPEARANCE_SCALAR_FIELDS.map((field) => ({
      file: APPEARANCE_FILES[field.settingsType],
      path: `settings.${field.name}`,
      type: field.type,
      ...(field.values ? { values: field.values } : {}),
      ...(field.minimum !== undefined ? { minimum: field.minimum, maximum: field.maximum } : {}),
      ...(field.maximumLength !== undefined ? { maximumLength: field.maximumLength } : {}),
      ...(field.allowedTokens
        ? {
          allowedTokens: [...field.allowedTokens],
          customForms: APPEARANCE_COLOR_CONSTRAINT.customForms,
          maximumLength: APPEARANCE_COLOR_CONSTRAINT.maximumLength,
        }
        : {}),
      default: field.default,
    })),
    ...APPEARANCE_FOOTER_COLOR_FIELDS.map((field) => ({
      file: field.file,
      path: field.path,
      type: field.type,
      allowedTokens: [...field.allowedTokens],
      customForms: APPEARANCE_COLOR_CONSTRAINT.customForms,
      maximumLength: APPEARANCE_COLOR_CONSTRAINT.maximumLength,
      default: field.default,
    })),
  ];
  assert.deepEqual(reference.fields, expected);
  assert.deepEqual(reference.readOnlyProjections, APPEARANCE_READ_ONLY_FIELDS);
  assert.match(reference.logoContract, /no separate compact-logo setting/u);
  assert.match(reference.headerWidthContract, /'wide' moves them to the viewport edges/u);
  assert.match(reference.headerWidthContract, /headerLayout 'centered-menu'/u);
  assert.equal(reference.nonAtomic, true);
  assert.match(reference.recovery, /completedWrites/u);
  for (const field of reference.fields.filter((item) => item.type === "appearance-color")) {
    assert.ok(field.allowedTokens.length > 0, field.path);
    assert.deepEqual(field.customForms, APPEARANCE_COLOR_CONSTRAINT.customForms, field.path);
    assert.equal(field.maximumLength, 128, field.path);
  }
});

test("appearance help defaults stay aligned with the domain settings defaults", { skip: MONOREPO_ONLY }, () => {
  const defaults = Object.fromEntries(
    getAppearanceReference().fields
      .filter((field) => Object.hasOwn(field, "default"))
      .map((field) => [field.path, field.default]),
  );
  assert.deepEqual(
    {
      defaultScheme: defaults["settings.defaultScheme"],
      lightCanvasImageOpacity: defaults["settings.lightCanvasImageOpacity"],
      darkCanvasImageOpacity: defaults["settings.darkCanvasImageOpacity"],
      headerLayout: defaults["settings.headerLayout"],
      headerWidth: defaults["settings.headerWidth"],
      navDrawerStyle: defaults["settings.navDrawerStyle"],
      navDrawerTransition: defaults["settings.navDrawerTransition"],
      fontMenu: defaults["settings.fontMenu"],
      fontWeightMenu: defaults["settings.fontWeightMenu"],
      navMenuDisplay: defaults["settings.navMenuDisplay"],
      headerPosition: defaults["settings.headerPosition"],
      showThemeToggle: defaults["settings.showThemeToggle"],
      showBrandText: defaults["settings.showBrandText"],
      brandLogoSize: defaults["settings.brandLogoSize"],
      brandHoverGrow: defaults["settings.brandHoverGrow"],
    },
    {
      defaultScheme: "light",
      lightCanvasImageOpacity: 1,
      darkCanvasImageOpacity: 1,
      headerLayout: "standard",
      headerWidth: "contained",
      navDrawerStyle: "full-screen",
      navDrawerTransition: "fade",
      fontMenu: "",
      fontWeightMenu: "",
      navMenuDisplay: "auto",
      headerPosition: "normal",
      showThemeToggle: false,
      showBrandText: true,
      brandLogoSize: "standard",
      brandHoverGrow: false,
    },
  );

  const domain = readFileSync(SITE_SETTINGS_PATH, "utf8");
  for (const declaration of [
    "string HeaderLayout = Taproot.Domain.Entities.HeaderLayout.Standard",
    "string HeaderWidth = Taproot.Domain.Entities.HeaderWidth.Contained",
    "string NavDrawerStyle = HeaderNavDrawerStyle.FullScreen",
    "string NavDrawerTransition = HeaderNavDrawerTransition.Fade",
    "string FontMenu = \"\"",
    "string FontWeightMenu = \"\"",
    "string NavMenuDisplay = HeaderNavigationDisplay.Auto",
    "bool ShowThemeToggle = false",
    "string HeaderPosition = Taproot.Domain.Entities.HeaderPosition.Normal",
    "string BrandLogoSize = HeaderBrandLogoSize.Standard",
    "bool BrandHoverGrow = false",
    "public static HeaderSettings Defaults => new(ShowBrandText: true)",
    "string DefaultScheme = DefaultColorScheme.Light",
    "double LightCanvasImageOpacity = 1",
    "double DarkCanvasImageOpacity = 1",
  ]) {
    assert.ok(domain.includes(declaration), declaration);
  }
});

test("footer help field inventory stays mechanically aligned with Settings.proto", { skip: MONOREPO_ONLY }, () => {
  const proto = readFileSync(PROTO_PATH, "utf8");
  for (const [messageName, fields] of Object.entries(FOOTER_FIELD_INVENTORY)) {
    assert.deepEqual(protoFields(proto, messageName), fields, messageName);
  }

  const reference = getFooterReference();
  assert.equal(
    reference.workspaceFile,
    APPEARANCE_FILES[SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES],
  );
  assert.deepEqual(
    Object.fromEntries(reference.messages.map((message) => [message.name, message.fields.map((field) => field.name)])),
    FOOTER_FIELD_INVENTORY,
  );
  assert.deepEqual(reference.readOnlyProjections, FOOTER_READ_ONLY_FIELDS);
  for (
    const field of reference.messages.find((message) => message.name === "FooterSchemeSettings").fields
      .filter((item) => item.type === "appearance-color")
  ) {
    assert.ok(field.allowedTokens.length > 0, field.name);
    assert.deepEqual(field.customForms, APPEARANCE_COLOR_CONSTRAINT.customForms, field.name);
    assert.equal(field.maximumLength, 128, field.name);
  }
  for (const path of FOOTER_READ_ONLY_FIELDS) {
    const [container, field] = path.split(".");
    const messageName = container === "featureImage" ? "FooterFeatureImageSettings" : "FooterSchemeSettings";
    assert.equal(
      reference.messages.find((message) => message.name === messageName).fields
        .find((item) => item.name === field).readOnly,
      true,
      path,
    );
  }
});

test("footer limits stay aligned with the server and shared image-processing source of truth", { skip: MONOREPO_ONLY }, () => {
  const handler = readFileSync(HANDLER_PATH, "utf8");
  const constants = {
    linkColumns: "MaxLinkColumns",
    linkGroups: "MaxLinkGroups",
    groupsPerColumn: "MaxGroupsPerColumn",
    linksPerGroup: "MaxLinksPerGroup",
    bottomLinks: "MaxBottomLinks",
    richTextParagraphs: "MaxRichTextParagraphs",
    richTextRuns: "MaxRichTextRuns",
    groupHeadingLength: "GroupHeadingMaxLength",
    asideHeadingLength: "AsideHeadingMaxLength",
    asideBodyLength: "AsideBodyMaxLength",
    linkLabelLength: "LinkLabelMaxLength",
    bottomTextLength: "BottomTextMaxLength",
    featureImageAltLength: "FeatureImageAltMaxLength",
    externalUrlLength: "ExternalUrlMaxLength",
  };
  for (const [localName, serverName] of Object.entries(constants)) {
    assert.equal(FOOTER_LIMITS[localName], csharpIntegerConstant(handler, serverName), localName);
  }

  const repeat = JSON.parse(readFileSync(IMAGE_PROCESSING_PATH, "utf8")).onDemandDelivery.footerRepeatHeight;
  assert.deepEqual(
    {
      min: FOOTER_LIMITS.backgroundRepeatHeightMinimum,
      max: FOOTER_LIMITS.backgroundRepeatHeightMaximum,
      step: FOOTER_LIMITS.backgroundRepeatHeightStep,
      default: FOOTER_LIMITS.backgroundRepeatHeightDefault,
    },
    repeat,
  );
  assert.match(
    readFileSync(SITE_SETTINGS_PATH, "utf8"),
    new RegExp(`MaxAdditionalTopPaddingRem = ${FOOTER_LIMITS.additionalTopPaddingRemMaximum};`, "u"),
  );
});

test("footer validation rejects closed-shape, target, identity, media, text, and bound failures by field", async (context) => {
  const cases = [
    {
      name: "server projection",
      mutate: (footer) => {
        footer.light.backgroundImageUrl = "https://cdn.example/footer.webp";
      },
      code: "footer.field_read_only",
      field: "footerSettings.light.backgroundImageUrl",
    },
    {
      name: "unknown field",
      mutate: (footer) => {
        footer.unknown = true;
      },
      code: "footer.field_unknown",
      field: "footerSettings.unknown",
    },
    {
      name: "both link targets",
      mutate: (footer) => {
        footer.linkColumns[0].groups[0].links[0].externalUrl = "https://example.com";
      },
      code: "footer.target_invalid",
      field: "footerSettings.linkColumns[0].groups[0].links[0]",
    },
    {
      name: "unsafe URL",
      mutate: (footer) => {
        footer.bottomLinks[0].externalUrl = "javascript:alert(1)";
      },
      code: "footer.url_invalid",
      field: "footerSettings.bottomLinks[0].externalUrl",
    },
    {
      name: "backslash-normalized footer URL",
      mutate: (footer) => {
        footer.bottomLinks[0].externalUrl = "https:\\evil.example/path";
      },
      code: "footer.url_invalid",
      field: "footerSettings.bottomLinks[0].externalUrl",
    },
    {
      name: "backslash-normalized inline URL",
      mutate: (footer) => {
        footer.asideBodyContent.paragraphs[0].runs[0].link = { externalUrl: "https:\\evil.example/path" };
      },
      code: "footer.url_invalid",
      field: "footerSettings.asideBodyContent.paragraphs[0].runs[0].link.externalUrl",
    },
    {
      name: "noncanonical stable id",
      mutate: (footer) => {
        footer.bottomLinks[0].id = footer.bottomLinks[0].id.toUpperCase();
      },
      code: "footer.id_invalid",
      field: "footerSettings.bottomLinks[0].id",
    },
    {
      name: "unknown pulled page",
      mutate: () => {},
      options: { knownPageResourceIds: new Set() },
      code: "footer.page_reference_unknown",
      field: "footerSettings.linkColumns[0].groups[0].links[0].pageResourceId",
    },
    {
      name: "unknown site image",
      mutate: () => {},
      options: { knownImageIds: new Set([FOOTER_EXAMPLE.featureImage.imageId]) },
      code: "footer.image_reference_unknown",
      field: "footerSettings.light.backgroundImageId",
    },
    {
      name: "missing feature alt",
      mutate: (footer) => {
        footer.featureImage.alt = "";
      },
      code: "footer.alt_required",
      field: "footerSettings.featureImage.alt",
    },
    {
      name: "rich text too long",
      mutate: (footer) => {
        footer.asideBodyContent.paragraphs[0].runs[0].text = "x".repeat(1_001);
      },
      code: "footer.text_too_long",
      field: "footerSettings.asideBodyContent",
    },
    {
      name: "repeat height step",
      mutate: (footer) => {
        footer.light.backgroundRepeatHeightPx = 65;
      },
      code: "footer.field_invalid",
      field: "footerSettings.light.backgroundRepeatHeightPx",
    },
  ];

  for (const scenario of cases) {
    await context.test(scenario.name, () => {
      const footer = structuredClone(FOOTER_EXAMPLE);
      scenario.mutate(footer);
      assert.throws(
        () => validateFooterDocument(footer, scenario.options),
        (error) => error?.code === scenario.code && error?.field === scenario.field,
      );
    });
  }
});

test("footer external targets accept contact schemes and refuse everything else", async (context) => {
  // The value a studio types is the value that publishes: a number keeps its
  // punctuation and an address keeps its plus-tag, so no round trip through
  // URL.toString() may re-encode either.
  const accepted = [
    "tel:+15555550123",
    "tel:+1 (555) 555-0123",
    "mailto:hello@example.com",
    "mailto:desk+bookings@example.com?subject=Class%20booking",
    "mailto:desk@example.test,bookings@example.test",
    "https://example.com/contact",
  ];
  for (const externalUrl of accepted) {
    await context.test(`accepts ${externalUrl}`, () => {
      const footer = structuredClone(FOOTER_EXAMPLE);
      footer.asideCta.externalUrl = externalUrl;
      footer.bottomLinks[0].externalUrl = externalUrl;
      footer.asideBodyContent.paragraphs[0].runs[0].link = { externalUrl };
      const normalized = validateFooterDocument(footer);
      assert.equal(normalized.asideCta.externalUrl, externalUrl);
      assert.equal(normalized.bottomLinks[0].externalUrl, externalUrl);
      assert.equal(normalized.asideBodyContent.paragraphs[0].runs[0].link.externalUrl, externalUrl);
    });
  }

  const refused = [
    "javascript:alert(1)",
    "ftp://example.com/brochure.pdf",
    // A raw line break in a mailto is the header-injection vector.
    "mailto:hello@example.com\nBcc:victim@example.com",
    "tel:+155555501	23",
    // A scheme with nothing to reach is a dead anchor, not a link.
    "tel:",
    "mailto:",
    // A contact URL has no authority; "//" forms are refused everywhere.
    "tel://example.test/+15555550123",
    "tel://example.test:invalid/+15555550123",
    "https://user:secret@example.com/contact",
    "/relative/contact",
    "tel:" + "9".repeat(FOOTER_LIMITS.externalUrlLength),
  ];
  for (const externalUrl of refused) {
    await context.test(`refuses ${JSON.stringify(externalUrl).slice(0, 48)}`, () => {
      const footer = structuredClone(FOOTER_EXAMPLE);
      footer.asideCta.externalUrl = externalUrl;
      assert.throws(
        () => validateFooterDocument(footer),
        (error) =>
          error?.code === "footer.url_invalid" && error?.field === "footerSettings.asideCta.externalUrl",
      );
    });
  }
});

test("workspace projection strips server delivery URLs and preserves stable image identities", () => {
  const response = structuredClone(FOOTER_EXAMPLE);
  response.light.backgroundImageUrl = "https://cdn.example/light.webp";
  response.featureImage.imageUrl = "https://cdn.example/feature.webp";
  response.featureImage.responsiveUrls = [{ minWidth: 640, url: "https://cdn.example/feature-640.webp" }];
  const projected = projectFooterSettingsForWorkspace(response);
  assert.equal(projected.light.backgroundImageId, FOOTER_EXAMPLE.light.backgroundImageId);
  assert.equal(projected.featureImage.imageId, FOOTER_EXAMPLE.featureImage.imageId);
  assert.equal("backgroundImageUrl" in projected.light, false);
  assert.equal("imageUrl" in projected.featureImage, false);
  assert.equal("responsiveUrls" in projected.featureImage, false);
});

test("server-read projection preserves values stricter than authoring without changing the draft hash", () => {
  const response = structuredClone(FOOTER_EXAMPLE);
  response.bottomLinks[0].externalUrl = "https://good.example/a\\b";
  response.asideBodyContent.paragraphs[0].runs[0].text = "Stored\u0001text";

  const projected = projectFooterSettingsForWorkspace(response);
  assert.equal(projected.bottomLinks[0].externalUrl, response.bottomLinks[0].externalUrl);
  assert.equal(
    projected.asideBodyContent.paragraphs[0].runs[0].text,
    response.asideBodyContent.paragraphs[0].runs[0].text,
  );
  assert.equal(computeFooterDraftHash(projected), computeFooterDraftHash(response));

  assert.throws(
    () => validateFooterDocument(projected),
    (error) => error?.code === "footer.url_invalid"
      && error?.field === "footerSettings.bottomLinks[0].externalUrl",
  );
  projected.bottomLinks[0].externalUrl = "https://good.example/ab";
  assert.throws(
    () => validateFooterDocument(projected),
    (error) => error?.code === "footer.text_invalid"
      && error?.field === "footerSettings.asideBodyContent.paragraphs[0].runs[0].text",
  );
});

test("single-line normalization uses the server's Unicode whitespace set", () => {
  const unicodeFooter = structuredClone(FOOTER_EXAMPLE);
  unicodeFooter.bottomLinks[0].label = "\u0085Docs\uFEFF";
  const normalizedUnicode = validateFooterDocument(unicodeFooter);
  assert.equal(normalizedUnicode.bottomLinks[0].label, "Docs\uFEFF");
  assert.equal(
    computeFooterDraftHash(normalizedUnicode),
    computeFooterDraftHash(projectFooterSettingsForWorkspace(normalizedUnicode)),
  );

  const asciiFooter = structuredClone(FOOTER_EXAMPLE);
  asciiFooter.bottomLinks[0].label = "  Talk  with   us  ";
  asciiFooter.bottomLinks[0].externalUrl = "  https://example.com/contact  ";
  const normalizedAscii = validateFooterDocument(asciiFooter);
  assert.equal(normalizedAscii.bottomLinks[0].label, "Talk with us");
  assert.equal(normalizedAscii.bottomLinks[0].externalUrl, "https://example.com/contact");

  const whitespaceOnlyFooter = structuredClone(FOOTER_EXAMPLE);
  whitespaceOnlyFooter.bottomLinks[0].label = "   ";
  assert.throws(
    () => validateFooterDocument(whitespaceOnlyFooter),
    (error) => error?.code === "footer.text_required"
      && error?.field === "footerSettings.bottomLinks[0].label",
  );
});
