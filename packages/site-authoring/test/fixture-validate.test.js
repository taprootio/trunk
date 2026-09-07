import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/cli.js";
import { shippedFixtureDirectory } from "../src/fixture-contract.js";
import { MONOREPO_ONLY, monorepoPath } from "./monorepo.js";

// The complete example fixture the package ships (TR00647). It is the default
// source for every case below, so the whole family runs in the public Trunk
// tree instead of skipping there.
const SHIPPED_FIXTURE = shippedFixtureDirectory();
// The Taproot-www fixture is private, unapproved copy that does not ship with
// the package (TR00635); the two cases that replay it are monorepo-only, and
// they are additions to the shipped-fixture coverage rather than the only
// coverage.
const TAPROOT_FIXTURE = monorepoPath("business", "playbooks", "www-launch", "fixtures", "taproot-www");
// The package's copy of the representative section composition, pinned
// byte-for-byte to the canonical shared fixture by renderer-parity.test.js.
const SHY_COMPOSITION = fileURLToPath(new URL(
  "./fixtures/free-form-section-composition.fixture.json",
  import.meta.url,
));
// The package's copy of the seeded default theme, pinned byte-for-byte to the
// canonical shared artifact by renderer-parity.test.js. The shipped fixture's
// theme pair is that artifact plus four authored groups.
const DEFAULT_SITE_THEME = fileURLToPath(new URL("./fixtures/default-site-theme.json", import.meta.url));
const AUTHORED_THEME_GROUPS = new Set(["anchors", "roles", "contexts", "intents"]);
const SHY_PAGE_ID = "00000000-0000-4000-8000-000000000791";
const SHY_RESOURCE_ID = "00000000-0000-4000-8000-000000000792";
const SHY_IMAGE_ID = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";

function sink() {
  let value = "";
  return {
    write(chunk) {
      value += chunk;
    },
    read() {
      return value;
    },
  };
}

function credentialUnreadableEnvironment(values = {}) {
  return new Proxy({ ...values }, {
    get(target, property, receiver) {
      if (property === "TAPROOT_SITE_KEY") assert.fail("offline validation read the credential environment variable");
      return Reflect.get(target, property, receiver);
    },
  });
}

async function treeDigest(root) {
  const hash = createHash("sha256");
  async function visit(relative = "") {
    const directory = path.join(root, relative);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = path.posix.join(relative.split(path.sep).join(path.posix.sep), entry.name);
      hash.update(child);
      hash.update("\0");
      if (entry.isDirectory()) {
        await visit(path.join(relative, entry.name));
      } else {
        assert.equal(entry.isFile(), true, `fixture entry '${child}' must be a regular file`);
        hash.update(await readFile(path.join(root, relative, entry.name)));
      }
      hash.update("\0");
    }
  }
  await visit();
  return hash.digest("hex");
}

async function copiedFixture(context, label = "fixture with spaces", source = SHIPPED_FIXTURE) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "taproot-site-fixture-validate-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const fixture = path.join(temporary, label);
  await cp(source, fixture, { recursive: true });
  return { temporary, fixture };
}

async function runValidation(fixture, { quiet = true, environment = {}, arguments_ } = {}) {
  const stdout = sink();
  const stderr = sink();
  let requests = 0;
  const exitCode = await runCli({
    arguments_: arguments_ ?? ["validate", fixture, ...(quiet ? ["--quiet"] : [])],
    environment: credentialUnreadableEnvironment(environment),
    cwd: path.dirname(fixture),
    stdout,
    stderr,
    fetch() {
      requests += 1;
      throw new Error("offline validation must not make a network request");
    },
  });
  return { exitCode, stdout: stdout.read(), stderr: stderr.read(), requests };
}

test("the shipped example fixture validates without credentials, network, or writes", async () => {
  const before = await treeDigest(SHIPPED_FIXTURE);
  const result = await runValidation(SHIPPED_FIXTURE, { quiet: false });

  assert.equal(result.exitCode, 0);
  assert.equal(result.requests, 0);
  // The README tells a reader to validate the installed copy in place, so the
  // verb must leave the package's own files exactly as it found them.
  assert.equal(await treeDigest(SHIPPED_FIXTURE), before);
  const json = JSON.parse(result.stdout);
  assert.deepEqual(
    {
      schemaVersion: json.schemaVersion,
      ok: json.ok,
      verb: json.verb,
      offline: json.offline,
      contractVersion: json.fixture.contractVersion,
      manifest: json.fixture.manifest,
      imageIds: json.fixture.imageIds,
      deliveryOrigins: json.fixture.deliveryOrigins,
      pages: json.validated.pages.total,
      navigationItems: json.validated.navigation.items,
      themes: json.validated.themes,
      appearanceSettings: json.validated.appearanceSettings,
      footer: json.validated.footer,
    },
    {
      schemaVersion: 1,
      ok: true,
      verb: "validate",
      offline: true,
      contractVersion: 1,
      manifest: "manifest.fixture.json",
      imageIds: 3,
      deliveryOrigins: 1,
      pages: 2,
      navigationItems: 3,
      themes: 2,
      appearanceSettings: 23,
      footer: true,
    },
  );
  assert.deepEqual(json.validated.pages.items, [
    { file: "pages/index.md", path: "" },
    { file: "pages/visit.md", path: "visit" },
  ]);
  // The README promises exit 0 with nothing to read afterwards, so the shipped
  // fixture must be clean rather than merely valid.
  assert.deepEqual(json.warnings, { items: [], count: 0 });
  assert.deepEqual(json.hints, []);
  assert.match(result.stderr, /^Reading manifest\.fixture\.json\./u);
  assert.match(result.stderr, /Validated 2 page\(s\), 3 navigation item\(s\)/u);
});

test("the shipped fixture's theme pair is the seeded default plus its authored semantics", async () => {
  const defaultTheme = JSON.parse(await readFile(DEFAULT_SITE_THEME, "utf8"));
  const styles = JSON.parse(
    await readFile(path.join(SHIPPED_FIXTURE, "settings", "taproot-styles.json"), "utf8"),
  );

  for (const [scheme, key] of [["light", "lightTheme"], ["dark", "darkTheme"]]) {
    const seeded = defaultTheme[scheme].theme;
    const fixture = styles.settings[key];
    assert.deepEqual(Object.keys(fixture).sort(), Object.keys(seeded).sort(), `${scheme}: property set`);
    for (const property of Object.keys(seeded)) {
      if (AUTHORED_THEME_GROUPS.has(property)) {
        // Authored on purpose: the seeded theme leaves these empty, and a
        // fixture with no anchors, roles, or contexts could not demonstrate a
        // named section context.
        assert.notDeepEqual(fixture[property], seeded[property], `${scheme}.${property} is still the seeded value`);
        continue;
      }
      // Everything else is the seeded value, so a theme-contract change is a
      // re-copy of the generated artifact rather than a re-authoring.
      assert.deepEqual(fixture[property], seeded[property], `${scheme}.${property} drifted from the seeded theme`);
    }
  }
});

test("the shipped fixture keeps every example value inside the reserved example ranges", async () => {
  const files = [];
  async function visit(relative) {
    for (const entry of await readdir(path.join(SHIPPED_FIXTURE, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(child);
      else files.push(child);
    }
  }
  await visit("");
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = await readFile(path.join(SHIPPED_FIXTURE, file), "utf8");
    // Every hostname the fixture names is reserved for examples, and every
    // telephone number is from the reserved 555-01xx range. A fixture ships
    // and is copied, so a live host or a real number in one would travel.
    for (const match of text.matchAll(/https?:\/\/([^/"\s)]+)/gu)) {
      const hostname = new URL(match[0]).hostname;
      assert.ok(
        hostname === "example.test" || hostname.endsWith(".example.test"),
        `${file} references non-reserved host '${hostname}'`,
      );
    }
    // Area code 555 with the 555-01xx local range: the only block reserved for
    // fiction. UUIDs carry long digit runs, so this matches the two written
    // forms exactly rather than any ten digits.
    for (const match of text.matchAll(/\(\d{3}\)\s*\d{3}-\d{4}/gu)) {
      assert.equal(match[0], "(555) 555-0147", `${file} writes a non-reserved telephone number`);
    }
    for (const match of text.matchAll(/tel:[+\d\-().\s]+/gu)) {
      assert.equal(match[0], "tel:+15555550147", `${file} links a non-reserved telephone number`);
    }
    // A mailbox domain travels the same way a host does.
    for (const match of text.matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/gu)) {
      assert.ok(
        match[1] === "example.test" || match[1].endsWith(".example.test"),
        `${file} writes a non-reserved email domain '${match[1]}'`,
      );
    }
  }
});

test("the public CLI validates the complete TR00621 Taproot-www fixture without credentials, network, or writes", { skip: MONOREPO_ONLY }, async () => {
  const before = await treeDigest(TAPROOT_FIXTURE);
  const result = await runValidation(TAPROOT_FIXTURE, { quiet: false });

  assert.equal(result.exitCode, 0);
  assert.equal(result.requests, 0);
  assert.equal(await treeDigest(TAPROOT_FIXTURE), before);
  const json = JSON.parse(result.stdout);
  assert.deepEqual(
    {
      schemaVersion: json.schemaVersion,
      ok: json.ok,
      verb: json.verb,
      offline: json.offline,
      contractVersion: json.fixture.contractVersion,
      pages: json.validated.pages.total,
      navigationItems: json.validated.navigation.items,
      themes: json.validated.themes,
      appearanceSettings: json.validated.appearanceSettings,
      footer: json.validated.footer,
    },
    {
      schemaVersion: 1,
      ok: true,
      verb: "validate",
      offline: true,
      contractVersion: 1,
      pages: 8,
      navigationItems: 10,
      themes: 2,
      appearanceSettings: 23,
      footer: true,
    },
  );
  assert.deepEqual(json.warnings, { items: [], count: 0 });
  assert.ok(json.doesNotProve.includes("credential authorization or live site ownership"));
  assert.ok(json.doesNotProve.includes("preview or published rendering"));
  // The www fixture keeps the contained header beside a full-bleed image
  // banner, so validate advises the wide header without failing (TR00697).
  assert.deepEqual(json.hints.map((hint) => hint.code), ["header.width_contained_with_root_band"]);
  assert.deepEqual(json.hints[0].suggested, { headerWidth: "wide", headerLayout: "centered-menu" });
  assert.deepEqual(json.hints[0].pages, ["pages/publishing.md"]);
  assert.match(result.stderr, /Hint: 1 page\(s\) use a full-bleed root-band component/u);
  assert.match(result.stderr, /^Reading manifest\.fixture\.json\./u);
  assert.match(result.stderr, /without credentials or mutation\.\n$/u);
});

test("validate drops the header-width hint once the workspace opts into the wide header", { skip: MONOREPO_ONLY }, async (context) => {
  // The www fixture owns this case: the hint needs a full-bleed root-band
  // component on a page, and the shipped fixture deliberately has none so its
  // README-promised run is clean.
  const { fixture } = await copiedFixture(context, "wide header fixture", TAPROOT_FIXTURE);
  const headerPath = path.join(fixture, "settings", "site-header.json");
  const header = JSON.parse(await readFile(headerPath, "utf8"));
  header.settings.headerWidth = "wide";
  header.settings.headerLayout = "centered-menu";
  await writeFile(headerPath, `${JSON.stringify(header, null, 2)}\n`);

  const result = await runValidation(fixture, { quiet: false });

  assert.equal(result.exitCode, 0);
  const json = JSON.parse(result.stdout);
  assert.deepEqual(json.hints, []);
  assert.doesNotMatch(result.stderr, /Hint:/u);
  assert.equal(json.validated.appearanceSettings, 23);
});

test("validate refuses a redirect source that a fixture page occupies under any spelling, naming the authored entry", async (context) => {
  // The site compares paths case-insensitively (citext), so the offline check
  // must too; and the refusal names the entry where the author wrote it, not
  // its position in the path-sorted map the validator returns.
  const { fixture } = await copiedFixture(context);
  const redirectsPath = path.join(fixture, "redirects.json");
  const redirects = JSON.parse(await readFile(redirectsPath, "utf8"));
  // Nothing may target the page, or the new source would be refused as a
  // chain before occupancy is ever considered.
  for (const entry of redirects.entries) {
    if (entry.target === "/visit") entry.target = "https://booking.example.test/classes";
  }
  redirects.entries.push({
    path: "/Visit",
    kind: "redirect",
    target: "https://booking.example.test/moved",
    status: 301,
  });
  await writeFile(redirectsPath, `${JSON.stringify(redirects, null, 2)}\n`);
  const manifestPath = path.join(fixture, "manifest.fixture.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.redirects.entries = redirects.entries.length;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const result = await runValidation(fixture);

  assert.equal(result.exitCode, 1, result.stderr);
  const { error } = JSON.parse(result.stdout);
  assert.equal(error.code, "fixture.redirect_path_occupied");
  assert.equal(error.field, `entries[${redirects.entries.length - 1}].path`);
});

test("validate ignores GITHUB_OUTPUT on both success and usage failure", async (context) => {
  const { fixture } = await copiedFixture(context, "fixture with actions output");
  const outputPath = path.join(fixture, "github-output.txt");
  const initialOutput = "caller-owned-output\n";
  await writeFile(outputPath, initialOutput);

  const success = await runValidation(fixture, { environment: { GITHUB_OUTPUT: outputPath } });
  assert.equal(success.exitCode, 0);
  assert.equal(await readFile(outputPath, "utf8"), initialOutput);

  const failure = await runValidation(fixture, {
    arguments_: ["validate"],
    environment: { GITHUB_OUTPUT: outputPath },
  });
  assert.equal(failure.exitCode, 2);
  assert.deepEqual(JSON.parse(failure.stdout).error, {
    code: "validate.fixture_path_invalid",
    field: "fixturePath",
  });
  assert.equal(await readFile(outputPath, "utf8"), initialOutput);
});

test("fixture path inspection failures keep the stable fixturePath contract", async () => {
  const tooLongFixtureName = path.join(os.tmpdir(), "x".repeat(300));
  const result = await runValidation(tooLongFixtureName);

  assert.equal(result.exitCode, 1);
  assert.equal(result.requests, 0);
  assert.deepEqual(JSON.parse(result.stdout).error, {
    code: "fixture.path_invalid",
    field: "fixturePath",
  });
  assert.match(result.stderr, /^taproot-site failed \[fixture\.path_invalid\]/u);
});

test("the canonical SHY composition document executes through the same quiet offline page validator", async (context) => {
  const { temporary, fixture } = await copiedFixture(context, "canonical SHY composition fixture");
  const manifestPath = path.join(fixture, "manifest.fixture.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  // This case owns the SHY document, so it asserts against the fixture's own
  // baseline rather than a literal total an unrelated fixture edit would break.
  const basePageCount = manifest.pages.length;
  manifest.fixture.imageIds.push(SHY_IMAGE_ID);
  manifest.pages.push({
    pageId: SHY_PAGE_ID,
    resourceId: SHY_RESOURCE_ID,
    path: "shy-composition",
    title: "SHY composition proof",
    status: "PAGE_STATUS_DRAFT",
    templateType: "TEMPLATE_TYPE_FREE_FORM",
    hasDraft: true,
    isGenerated: false,
    workspaceMode: "editable",
    file: "pages/shy-composition.pm.json",
    sourceFormat: "prosemirror",
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
  await writeFile(path.join(fixture, "pages/shy-composition.pm.json"), await readFile(SHY_COMPOSITION));

  const relativeFixture = path.relative(temporary, fixture);
  const result = await runValidation(path.join(temporary, relativeFixture));

  assert.equal(result.exitCode, 0);
  assert.equal(result.requests, 0);
  assert.equal(result.stderr, "");
  const json = JSON.parse(result.stdout);
  assert.equal(json.validated.pages.total, basePageCount + 1);
  assert.ok(json.validated.pages.items.some((entry) => entry.path === "shy-composition"));
});

test("offline failures retain the push validators' stable code and field", async (context) => {
  const cases = [
    {
      label: "page raw HTML",
      mutate: async (fixture) => {
        const manifestPath = path.join(fixture, "manifest.fixture.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        const page = manifest.pages.find((entry) => entry.path === "visit");
        await unlink(path.join(fixture, page.file));
        page.file = "pages/visit.pm.json";
        page.sourceFormat = "prosemirror";
        await writeFile(
          path.join(fixture, page.file),
          `${JSON.stringify({
            type: "doc",
            content: [{ type: "rawHtml", attrs: { html: "<aside>unsafe fixture markup</aside>" } }],
          }, undefined, 2)}\n`,
        );
        await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
      },
      code: "content.raw_html_forbidden",
      field: "pages/visit.pm.json:/content/0",
    },
    {
      label: "fixture settings entity binding",
      mutate: async (fixture) => {
        const file = path.join(fixture, "settings/brand.json");
        const document_ = JSON.parse(await readFile(file, "utf8"));
        document_.entityId = "99999999-9999-4999-8999-999999999999";
        await writeFile(file, `${JSON.stringify(document_, undefined, 2)}\n`);
      },
      code: "theme.settings_site_mismatch",
      field: "settings/brand.json",
      // The fixture binds settings to their own entity ids, so the refusal
      // names that entity rather than the site and offers no 'Run pull'.
      humanIncludes: ["fixture entity a0000000-0000-4000-8000-000000000021"],
      humanExcludes: ["site a0000000-0000-4000-8000-000000000001", "Run pull"],
    },
    {
      label: "appearance scalar",
      mutate: async (fixture) => {
        const file = path.join(fixture, "settings/taproot-styles.json");
        const document_ = JSON.parse(await readFile(file, "utf8"));
        document_.settings.defaultScheme = "sepia";
        await writeFile(file, `${JSON.stringify(document_, undefined, 2)}\n`);
      },
      code: "theme.setting_invalid",
      field: "taproot-styles.defaultScheme",
    },
    {
      // TR00728: a fixture (or a workspace) authored before the change can
      // still carry a retired scalar font at the top level of the styles
      // document. There is no compatibility read path, so validate must
      // refuse it with the same stable code and field push does.
      label: "retired top-level scalar font",
      mutate: async (fixture) => {
        const file = path.join(fixture, "settings/taproot-styles.json");
        const document_ = JSON.parse(await readFile(file, "utf8"));
        document_.settings.fontMenu = "Georgia, serif";
        await writeFile(file, `${JSON.stringify(document_, undefined, 2)}\n`);
      },
      code: "appearance.retired_scalar",
      field: "taproot-styles.fontMenu",
    },
    {
      label: "navigation page reference",
      mutate: async (fixture) => {
        const file = path.join(fixture, "nav.json");
        const document_ = JSON.parse(await readFile(file, "utf8"));
        // Point the first PAGE item at a page the fixture does not contain.
        // Group headers carry no target, so mutating one would exercise
        // nav.target_unexpected instead of the unknown-reference path.
        const index = document_.navItems.findIndex((item) => item.kind === "NAV_ITEM_KIND_PAGE");
        document_.navItems[index].resourceId = "99999999-9999-4999-8999-999999999999";
        await writeFile(file, `${JSON.stringify(document_, undefined, 2)}\n`);
        return { field: `navItems[${index}]` };
      },
      code: "nav.resource_unknown",
    },
    {
      label: "footer image reference",
      mutate: async (fixture) => {
        const file = path.join(fixture, "settings/site-publishing-preferences.json");
        const document_ = JSON.parse(await readFile(file, "utf8"));
        // The canonical fixture deliberately keeps the feature-image slot
        // cleared, so this case authors the whole object rather than
        // mutating an assumed existing reference.
        document_.settings.footerSettings.featureImage = {
          imageId: "99999999-9999-4999-8999-999999999999",
          alt: "Unknown image reference",
        };
        await writeFile(file, `${JSON.stringify(document_, undefined, 2)}\n`);
      },
      code: "footer.image_reference_unknown",
      field: "footerSettings.featureImage.imageId",
    },
  ];

  for (const scenario of cases) {
    await context.test(scenario.label, async (caseContext) => {
      const { fixture } = await copiedFixture(caseContext, scenario.label);
      // A mutation may report the field it produced, for a case whose field
      // depends on where in the fixture the mutation landed.
      const produced = await scenario.mutate(fixture);
      const field = scenario.field ?? produced.field;
      const before = await treeDigest(fixture);

      const result = await runValidation(fixture);

      assert.equal(result.exitCode, 1);
      assert.equal(result.requests, 0);
      assert.equal(await treeDigest(fixture), before);
      assert.deepEqual(JSON.parse(result.stdout).error, { code: scenario.code, field });
      assert.match(result.stderr, new RegExp(`^taproot-site failed \\[${scenario.code.replaceAll(".", "\\.")}\\]`, "u"));
      for (const text of scenario.humanIncludes ?? []) assert.ok(result.stderr.includes(text), `missing '${text}'`);
      for (const text of scenario.humanExcludes ?? []) assert.ok(!result.stderr.includes(text), `unexpected '${text}'`);
    });
  }
});
