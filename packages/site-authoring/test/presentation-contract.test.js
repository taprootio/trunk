import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  APPEARANCE_FILES,
  APPEARANCE_FOOTER_FIELDS,
  APPEARANCE_READ_ONLY_FIELDS,
  APPEARANCE_SCALAR_FIELDS,
} from "../src/appearance-contract.js";
import {
  FOOTER_EXAMPLE,
  footerDefaults,
  FOOTER_FIELD_INVENTORY,
  FOOTER_LIMITS,
  FOOTER_READ_ONLY_FIELDS,
  footerImageIds,
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
  formatPresentationReference,
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

test("the presentation references expose examples accepted by their executable validators", async () => {
  await assert.doesNotReject(() => assertPresentationExamples());
  assert.equal(getThemeReference().espalierVersion, "7.1.1");
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
      ...(field.step !== undefined ? { step: field.step } : {}),
      ...(field.optional ? { optional: true } : {}),
      ...(field.allowedTokens
        ? {
          allowedTokens: [...field.allowedTokens],
          customForms: APPEARANCE_COLOR_CONSTRAINT.customForms,
          maximumLength: APPEARANCE_COLOR_CONSTRAINT.maximumLength,
        }
        : {}),
      default: field.default,
    })),
    ...APPEARANCE_FOOTER_FIELDS.map(field => ({
      file: field.file,
      path: field.path,
      type: field.type,
      ...(field.values ? { values: field.values } : {}),
      optional: field.optional,
      default: field.default,
    })),
  ];
  // The prose beside each field is covered by setting-reference.test.js.
  assert.deepEqual(
    reference.fields.map(({ appLabel: _label, description: _description, renders: _renders, ...field }) => field),
    expected,
  );
  assert.deepEqual(reference.readOnlyProjections, APPEARANCE_READ_ONLY_FIELDS);
  assert.match(reference.logoContract, /lightCompactLogoId/u);
  assert.match(reference.headerWidthContract, /'wide' moves them to the viewport edges/u);
  assert.match(reference.headerWidthContract, /headerLayout 'centered-menu'/u);
  assert.equal(reference.atomic, true);
  assert.equal(reference.changeSet.length, 3);
  assert.match(reference.revision, /theme\.concurrent_modification/u);
  assert.match(reference.dryRun, /--dry-run/u);
  assert.match(reference.retry, /applied=false/u);
  assert.match(reference.recovery, /theme\.server_unsupported/u);
  assert.doesNotMatch(JSON.stringify(reference), /completedWrites|non-atomic/u);
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
      blockSpacing: defaults["settings.blockSpacing"],
      lightCanvasImageOpacity: defaults["settings.lightCanvasImageOpacity"],
      darkCanvasImageOpacity: defaults["settings.darkCanvasImageOpacity"],
      headerLayout: defaults["settings.headerLayout"],
      headerWidth: defaults["settings.headerWidth"],
      navDrawerStyle: defaults["settings.navDrawerStyle"],
      navDrawerTransition: defaults["settings.navDrawerTransition"],
      navMenuDisplay: defaults["settings.navMenuDisplay"],
      headerPosition: defaults["settings.headerPosition"],
      showThemeToggle: defaults["settings.showThemeToggle"],
      showBrandText: defaults["settings.showBrandText"],
      brandLogoSize: defaults["settings.brandLogoSize"],
      brandHoverGrow: defaults["settings.brandHoverGrow"],
    },
    {
      defaultScheme: "light",
      blockSpacing: "standard",
      lightCanvasImageOpacity: 1,
      darkCanvasImageOpacity: 1,
      headerLayout: "standard",
      headerWidth: "contained",
      navDrawerStyle: "full-screen",
      navDrawerTransition: "fade",
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
    brandSpanMax: "MaxBrandSpan",
    asideSpanMax: "MaxAsideSpan",
    columnSpanMax: "MaxColumnSpan",
    linkGroups: "MaxLinkGroups",
    groupsPerColumn: "MaxGroupsPerColumn",
    linksPerGroup: "MaxLinksPerGroup",
    bottomLinks: "MaxBottomLinks",
    socialLinks: "MaxSocialLinks",
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

test("footer spans validate independently as integers and have no total track cap", async (context) => {
  for (const [field, maximum] of [["brandSpan", FOOTER_LIMITS.brandSpanMax], ["asideSpan", FOOTER_LIMITS.asideSpanMax], ["span", FOOTER_LIMITS.columnSpanMax]]) {
    for (const invalid of [0, maximum + 1, -1, 1.5, null, "1"]) {
      await context.test(`${field} refuses ${JSON.stringify(invalid)}`, () => {
        const footer = structuredClone(FOOTER_EXAMPLE);
        const target = field === "span" ? footer.linkColumns[0] : footer;
        target[field] = invalid;
        const path = field === "span" ? "footerSettings.linkColumns[0].span" : `footerSettings.${field}`;
        assert.throws(() => validateFooterDocument(footer), error => error?.code === "footer.field_invalid" && error?.field === path);
      });
    }
  }
  const footer = validateFooterDocument({
    enabled: true,
    brandSpan: FOOTER_LIMITS.brandSpanMax,
    asideSpan: FOOTER_LIMITS.asideSpanMax,
    brandSize: "large",
    linkColumns: Array.from({ length: FOOTER_LIMITS.linkColumns }, (_, index) => ({
      id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`, span: FOOTER_LIMITS.columnSpanMax,
    })),
  });
  assert.equal(footer.brandSpan + footer.asideSpan + footer.linkColumns.reduce((sum, column) => sum + column.span, 0), 17);
});

test("footer defaults, pull projection and closed brand sizes agree", () => {
  const defaults = footerDefaults();
  const old = validateFooterDocument({ linkColumns: [{ id: "33333333-3333-4333-8333-333333333333" }] });
  assert.equal(old.brandSpan, defaults.brandSpan);
  assert.equal(old.asideSpan, defaults.asideSpan);
  assert.equal(old.brandSize, defaults.brandSize);
  assert.equal(old.logoScale, "1.0");
  assert.equal(defaults.logoScale, "1.0");
  assert.equal(old.linkColumns[0].span, 1);
  assert.equal(validateFooterDocument({ brandSize: "" }).brandSize, "standard");
  for (const brandSize of [null, "Large", "full", 1]) {
    assert.throws(() => validateFooterDocument({ brandSize }), error => error?.field === "footerSettings.brandSize");
  }
  const footer = structuredClone(FOOTER_EXAMPLE);
  footer.brandSpan = 3;
  footer.asideSpan = 2;
  footer.linkColumns[0].span = 2;
  const projected = projectFooterSettingsForWorkspace(footer);
  assert.deepEqual([projected.brandSpan, projected.brandSize, projected.asideSpan, projected.linkColumns[0].span], [3, "large", 2, 2]);
  const reference = getFooterReference();
  assert.match(reference.fitCheck, /footer\.word_breaks/u);
  assert.match(reference.fitCheck, /standard and profile sites/u);
  assert.match(reference.fitCheck, /over-report/u);
  assert.equal(reference.example.brandSize, "large");
});

test("footer logo scale materializes legacy values and stays independent of brand text size", async context => {
  for (const [name, footer, expected] of [
    ["default", {}, "1.0"],
    ["legacy standard", { brandSize: "standard" }, "1.0"],
    ["legacy large", { brandSize: "large" }, "1.5"],
    ["legacy null large", { brandSize: "large", logoScale: null }, "1.5"],
    ["empty", { brandSize: "large", logoScale: "" }, "1.0"],
    ["whole number string", { logoScale: "1" }, "1.0"],
    ["explicit normal with large text", { brandSize: "large", logoScale: "1.0" }, "1.0"],
    ["fraction", { logoScale: "1.1" }, "1.1"],
    ["maximum", { logoScale: "5" }, "5.0"],
  ]) {
    await context.test(name, () => {
      const normalized = validateFooterDocument(footer);
      assert.equal(normalized.logoScale, expected);
      assert.equal(projectFooterSettingsForWorkspace(footer).logoScale, expected);
      assert.equal(computeFooterDraftHash(footer), computeFooterDraftHash(normalized));
      assert.equal(validateFooterDocument({ ...normalized, brandSize: "large" }).logoScale, expected);
    });
  }
  for (const logoScale of ["0", "0.9", "5.1", "1.05", "1.", ".5", " 1.0", "1.0 ", "1.0\n", "1e0", 1, 1.5, true, {}]) {
    await context.test(`refuses ${JSON.stringify(logoScale)}`, () => {
      assert.throws(
        () => validateFooterDocument({ logoScale }),
        error => error?.code === "footer.field_invalid" && error?.field === "footerSettings.logoScale",
      );
      assert.equal(projectFooterSettingsForWorkspace({ brandSize: "large", logoScale }).logoScale, "1.0");
    });
  }
});

test("footer logo ids are owned content and logo URLs are response-only metadata", async context => {
  const lightId = "11111111-1111-4111-8111-111111111111";
  const darkId = "22222222-2222-4222-8222-222222222222";
  const response = {
    logoScale: "2",
    light: { logoId: lightId, logoUrl: "https://cdn.example/light.webp" },
    dark: { logoId: darkId, logoUrl: "https://cdn.example/dark.webp" },
  };
  const projected = projectFooterSettingsForWorkspace(response);
  assert.equal(projected.logoScale, "2.0");
  assert.equal(projected.light.logoId, lightId);
  assert.equal(projected.dark.logoId, darkId);
  assert.equal("logoUrl" in projected.light, false);
  assert.equal("logoUrl" in projected.dark, false);
  assert.equal(computeFooterDraftHash(response), computeFooterDraftHash(projected));
  assert.deepEqual(footerImageIds(projected), [lightId, darkId]);
  assert.deepEqual(footerImageIds({ light: { logoId: lightId }, dark: { logoId: lightId } }), [lightId]);
  assert.equal(validateFooterDocument({ light: { logoId: "" } }).light.logoId, "");
  assert.deepEqual(validateFooterDocument(projected, { knownImageIds: new Set([lightId, darkId]) }), projected);
  for (const scheme of ["light", "dark"]) {
    await context.test(scheme, () => {
      assert.throws(
        () => validateFooterDocument({ [scheme]: response[scheme] }),
        error => error?.code === "footer.field_read_only" && error?.field === `footerSettings.${scheme}.logoUrl`,
      );
      assert.throws(
        () => validateFooterDocument({ [scheme]: { logoId: lightId } }, { knownImageIds: new Set() }),
        error => error?.code === "footer.image_reference_unknown" && error?.field === `footerSettings.${scheme}.logoId`,
      );
      assert.throws(
        () => validateFooterDocument({ [scheme]: { logoId: "unknown" } }),
        error => error?.code === "footer.id_invalid" && error?.field === `footerSettings.${scheme}.logoId`,
      );
    });
  }
  const reference = getFooterReference();
  assert.match(formatPresentationReference(reference), /Old v7 baselines are refused/u);
  const logoScale = reference.messages.find(message => message.name === "FooterSettings").fields.find(field =>
    field.name === "logoScale"
  );
  assert.deepEqual([logoScale.type, logoScale.minimum, logoScale.maximum, logoScale.step, logoScale.default], [
    "decimal-string",
    1,
    5,
    0.1,
    "1.0",
  ]);
});

test("footer profiles normalize empty layouts sparsely and retain explicit start and auto", () => {
  const footer = validateFooterDocument({
    logoBox: "natural",
    alignment: { wide: { horizontal: "start", vertical: "", textAlign: "justify" }, wrapped: null, stacked: {} },
    brandAlignment: null,
    asideAlignment: { stacked: { textAlign: "auto" } },
    bottomAlignment: { wide: { horizontal: "end" }, stacked: { textAlign: "auto" } },
    linkColumns: [{ id: "33333333-3333-4333-8333-333333333333", alignment: { wrapped: { vertical: "end" } } }],
  });
  assert.equal(footer.logoBox, "natural");
  assert.deepEqual(footer.alignment, { wide: { horizontal: "start", textAlign: "justify" } });
  assert.equal("brandAlignment" in footer, false);
  assert.deepEqual(footer.asideAlignment, { stacked: { textAlign: "auto" } });
  assert.deepEqual(footer.bottomAlignment, { wide: { horizontal: "end" }, stacked: { textAlign: "auto" } });
  assert.deepEqual(footer.linkColumns[0].alignment, { wrapped: { vertical: "end" } });
  assert.deepEqual(projectFooterSettingsForWorkspace(footer), footer);
  assert.equal(footerDefaults().logoBox, "fixed");
  for (const logoBox of [undefined, null, "", "fixed"]) assert.equal(validateFooterDocument({ logoBox }).logoBox, "fixed");
  for (const profile of [undefined, null, {}, { wide: null, wrapped: {}, stacked: { horizontal: "", textAlign: "" } }]) {
    const normalized = validateFooterDocument({ alignment: profile, bottomAlignment: profile });
    assert.equal("alignment" in normalized, false);
    assert.equal("bottomAlignment" in normalized, false);
  }
  const projected = projectFooterSettingsForWorkspace({
    logoBox: "unknown",
    alignment: { wide: { horizontal: "center", vertical: "auto", textAlign: " justify" }, stacked: null },
    brandAlignment: [],
    bottomAlignment: { stacked: { vertical: "end", textAlign: "auto" } },
  });
  assert.equal(projected.logoBox, "fixed");
  assert.deepEqual(projected.alignment, { wide: { horizontal: "center" } });
  assert.equal("brandAlignment" in projected, false);
  assert.deepEqual(projected.bottomAlignment, { stacked: { textAlign: "auto" } });
});

test("footer profile validation closes every nested object and refuses invalid choices on owning fields", async context => {
  const cases = [
    ["alignment", [], "footer.document_invalid", "footerSettings.alignment"],
    ["alignment", { compact: {} }, "footer.field_unknown", "footerSettings.alignment.compact"],
    ["brandAlignment", { wide: [] }, "footer.document_invalid", "footerSettings.brandAlignment.wide"],
    ["asideAlignment", { wrapped: { unknown: "center" } }, "footer.field_unknown", "footerSettings.asideAlignment.wrapped.unknown"],
    ["bottomAlignment", { stacked: { vertical: "start" } }, "footer.field_unknown", "footerSettings.bottomAlignment.stacked.vertical"],
  ];
  for (const [key, value, code, field] of cases) {
    await context.test(field, () => {
      assert.throws(() => validateFooterDocument({ [key]: value }), error => error?.code === code && error?.field === field);
    });
  }
  for (const axis of ["horizontal", "vertical", "textAlign"]) {
    for (const value of [" start", "end ", "unknown", 1, false, null, {}, ...(axis === "textAlign" ? [] : ["auto", "justify"])]) {
      await context.test(`${axis}: ${JSON.stringify(value)}`, () => {
        assert.throws(() => validateFooterDocument({ alignment: { stacked: { [axis]: value } } }),
          error => error?.code === "footer.field_invalid" && error?.field === `footerSettings.alignment.stacked.${axis}`);
      });
    }
  }
  for (const value of ["Fixed", " natural", "natural ", 1, true, {}]) {
    assert.throws(() => validateFooterDocument({ logoBox: value }), error => error?.field === "footerSettings.logoBox");
  }
  assert.throws(() => validateFooterDocument({ linkColumns: [{ id: "33333333-3333-4333-8333-333333333333", alignment: { wide: { horizontal: "auto" } } }] }),
    error => error?.field === "footerSettings.linkColumns[0].alignment.wide.horizontal");
  const reference = getFooterReference();
  assert.match(reference.fitCheck, /five widths.*Small phone \(320px\)/u);
  assert.match(reference.fitCheck, /custom fonts or scale may differ/u);
  assert.match(formatPresentationReference(reference), /Alignment:.*sparse/u);
  assert.match(formatPresentationReference(reference), /Logo space:.*logoBox/u);
  for (const message of reference.messages) {
    for (const field of message.fields) assert.equal(typeof field.type, "string", `${message.name}.${field.name}`);
  }
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
      name: "thirteenth social link",
      mutate: (footer) => {
        footer.socialLinks = Array.from({ length: FOOTER_LIMITS.socialLinks + 1 }, (_, index) => ({
          id: `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
          platform: "instagram",
          url: `https://www.instagram.com/profile${index}`,
        }));
      },
      code: "footer.collection_too_large",
      field: "footerSettings.socialLinks",
    },
    {
      name: "unknown social platform",
      mutate: (footer) => {
        footer.socialLinks[0].platform = "Instagram";
      },
      code: "footer.field_invalid",
      field: "footerSettings.socialLinks[0].platform",
    },
    {
      name: "missing social platform",
      mutate: (footer) => {
        delete footer.socialLinks[0].platform;
      },
      code: "footer.field_invalid",
      field: "footerSettings.socialLinks[0].platform",
    },
    {
      name: "http social address",
      mutate: (footer) => {
        footer.socialLinks[0].url = "http://www.instagram.com/examplestudio";
      },
      code: "footer.url_invalid",
      field: "footerSettings.socialLinks[0].url",
    },
    {
      name: "social address with credentials",
      mutate: (footer) => {
        footer.socialLinks[0].url = "https://user:pass@www.instagram.com/examplestudio";
      },
      code: "footer.url_invalid",
      field: "footerSettings.socialLinks[0].url",
    },
    {
      name: "missing social address",
      mutate: (footer) => {
        delete footer.socialLinks[0].url;
      },
      code: "footer.url_invalid",
      field: "footerSettings.socialLinks[0].url",
    },
    {
      name: "empty social address",
      mutate: (footer) => {
        footer.socialLinks[0].url = "";
      },
      code: "footer.url_invalid",
      field: "footerSettings.socialLinks[0].url",
    },
    {
      name: "social link id shared with a bottom link",
      mutate: (footer) => {
        footer.socialLinks[0].id = footer.bottomLinks[0].id;
      },
      code: "footer.id_duplicate",
      field: "footerSettings.socialLinks[0].id",
    },
    {
      name: "website social link without a label",
      mutate: (footer) => {
        footer.socialLinks[0].platform = "other";
        delete footer.socialLinks[0].label;
      },
      code: "footer.text_required",
      field: "footerSettings.socialLinks[0].label",
    },
    {
      name: "whitespace-only social label",
      mutate: (footer) => {
        footer.socialLinks[0].label = " \t ";
      },
      code: "footer.text_required",
      field: "footerSettings.socialLinks[0].label",
    },
    {
      name: "social label of only U+FEFF",
      mutate: (footer) => {
        footer.socialLinks[0].label = "\ufeff";
      },
      code: "footer.text_required",
      field: "footerSettings.socialLinks[0].label",
    },
    {
      name: "social label too long",
      mutate: (footer) => {
        footer.socialLinks[0].label = "x".repeat(FOOTER_LIMITS.linkLabelLength + 1);
      },
      code: "footer.text_invalid",
      field: "footerSettings.socialLinks[0].label",
    },
    {
      name: "unknown social link field",
      mutate: (footer) => {
        footer.socialLinks[0].externalUrl = "https://example.com";
      },
      code: "footer.field_unknown",
      field: "footerSettings.socialLinks[0].externalUrl",
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

test("server-read projection keeps a social link whose platform left the vocabulary, which authoring refuses", () => {
  const response = structuredClone(FOOTER_EXAMPLE);
  response.socialLinks[0].platform = "myspace";

  const projected = projectFooterSettingsForWorkspace(response);
  assert.equal(projected.socialLinks[0].platform, "myspace");
  assert.equal(computeFooterDraftHash(projected), computeFooterDraftHash(response));
  assert.throws(
    () => validateFooterDocument(projected),
    (error) => error?.code === "footer.field_invalid" && error?.field === "footerSettings.socialLinks[0].platform",
  );
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

test("theme help states the role model the resolver applies and its examples contrast in both schemes", async () => {
  const reference = getThemeReference();
  assert.deepEqual(Object.keys(reference.roleResolution.slots), [...reference.vocabulary.roles]);
  assert.deepEqual(reference.roleResolution.slots.accent, ["text", "hover"]);
  assert.deepEqual(reference.roleResolution.slots.ink, ["heading"]);
  assert.deepEqual(reference.roleResolution.slots.action, ["ink"]);
  assert.ok(reference.roleResolution.bindingForms.some((line) => /anchor:<name>\.<slot>/u.test(line)));
  assert.match(reference.roleResolution.precedence[0], /explicitMappingTokens/u);
  // The dark example must not reuse the light example's dark heading anchor.
  assert.notEqual(reference.example.darkTheme.roles.ink.heading, reference.example.lightTheme.roles.ink.heading);
  assert.equal(reference.example.darkTheme.roles.ink.heading, "anchor:paper");
  await assert.doesNotReject(() => assertPresentationExamples());
  const rendered = formatPresentationReference(reference);
  assert.match(rendered, /Role slots:/u);
  assert.match(rendered, /accent\s+color, text, hover/u);
  assert.match(rendered, /Precedence:/u);
});



test("footer context round-trips without admitting the retired five-color contract", async context => {
  assert.equal(projectFooterSettingsForWorkspace({ context: "charcoal" }).context, "charcoal");
  assert.equal(validateFooterDocument({ context: "charcoal" }).context, "charcoal");
  assert.equal("context" in projectFooterSettingsForWorkspace({ context: "" }), false);
  for (const scheme of ["light", "dark"]) {
    for (const name of ["backgroundColor", "textColor", "headingColor", "linkColor", "linkHoverColor"]) {
      await context.test(`${scheme}.${name}`, () => {
        assert.throws(
          () => validateFooterDocument({ unknown: true, [scheme]: { [name]: "" } }),
          error =>
            error?.code === "appearance.retired_footer_color" && error?.field === `footerSettings.${scheme}.${name}`
            && /help appearance/u.test(error.message),
        );
      });
    }
  }
  const appearance = getAppearanceReference();
  assert.match(appearance.footerColorMigration, /semanticMappings.layer2/u);
  assert.match(appearance.footerColorMigration, /ink.color/u);
  assert.match(appearance.footerColorMigration, /accent.hover/u);
  assert.match(formatPresentationReference(appearance), /appearance.retired_footer_color/u);
  const footer = getFooterReference();
  assert.ok(
    footer.messages.find(message => message.name === "FooterSettings").fields.some(field => field.name === "context"),
  );
});


test("footer logoVariant is strict for authoring and tolerant only for stored reads", async context => {
  for (const variant of ["", "light", "dark"]) {
    assert.equal(validateFooterDocument({ logoVariant: variant }).logoVariant, variant || undefined);
    assert.equal(projectFooterSettingsForWorkspace({ logoVariant: variant }).logoVariant, variant || undefined);
  }
  for (const variant of ["auto", "sepia", " light", "Dark", null, 1, false]) {
    await context.test(JSON.stringify(variant), () => {
      assert.throws(() => validateFooterDocument({ logoVariant: variant }), error => error?.code === "footer.field_invalid" && error?.field === "footerSettings.logoVariant");
      assert.equal("logoVariant" in projectFooterSettingsForWorkspace({ logoVariant: variant }), false);
    });
  }
  const reference = getFooterReference();
  assert.ok(reference.messages.find(message => message.name === "FooterSettings").fields.some(field => field.name === "logoVariant"));
  assert.match(formatPresentationReference(getAppearanceReference()), /Light-background logo/u);
});
