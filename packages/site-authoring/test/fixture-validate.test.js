import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/cli.js";
import { MONOREPO_ONLY, monorepoPath } from "./monorepo.js";

// The Taproot-www fixture is private, unapproved copy that does not ship with
// the package (TR00635); every test that replays it skips outside the monorepo.
const TAPROOT_FIXTURE = monorepoPath("business", "playbooks", "www-launch", "fixtures", "taproot-www");
// The package's copy of the representative section composition, pinned
// byte-for-byte to the canonical shared fixture by renderer-parity.test.js.
const SHY_COMPOSITION = fileURLToPath(new URL(
  "./fixtures/free-form-section-composition.fixture.json",
  import.meta.url,
));
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

async function copiedFixture(context, label = "fixture with spaces") {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "taproot-site-fixture-validate-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const fixture = path.join(temporary, label);
  await cp(TAPROOT_FIXTURE, fixture, { recursive: true });
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
      navigationItems: 9,
      themes: 2,
      appearanceSettings: 27,
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
  const { fixture } = await copiedFixture(context, "wide header fixture");
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
  assert.equal(json.validated.appearanceSettings, 27);
});

test("validate ignores GITHUB_OUTPUT on both success and usage failure", { skip: MONOREPO_ONLY }, async (context) => {
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

test("the canonical SHY composition document executes through the same quiet offline page validator", { skip: MONOREPO_ONLY }, async (context) => {
  const { temporary, fixture } = await copiedFixture(context, "canonical SHY composition fixture");
  const manifestPath = path.join(fixture, "manifest.fixture.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  // The Taproot-www fixture grows as its owner review adds pages; this case
  // owns the SHY document, so it asserts against that baseline rather than a
  // literal total that an unrelated fixture edit would break.
  const taprootPageCount = manifest.pages.length;
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
  assert.equal(json.validated.pages.total, taprootPageCount + 1);
  assert.ok(json.validated.pages.items.some((entry) => entry.path === "shy-composition"));
});

test("offline failures retain the push validators' stable code and field", { skip: MONOREPO_ONLY }, async (context) => {
  const cases = [
    {
      label: "page raw HTML",
      mutate: async (fixture) => {
        const manifestPath = path.join(fixture, "manifest.fixture.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        const page = manifest.pages.find((entry) => entry.path === "about");
        await unlink(path.join(fixture, page.file));
        page.file = "pages/about.pm.json";
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
      field: "pages/about.pm.json:/content/0",
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
      humanIncludes: ["fixture entity 00000000-0000-4000-8000-000000000672"],
      humanExcludes: ["site 00000000-0000-4000-8000-000000000621", "Run pull"],
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
      label: "navigation page reference",
      mutate: async (fixture) => {
        const file = path.join(fixture, "nav.json");
        const document_ = JSON.parse(await readFile(file, "utf8"));
        // Point the first PAGE item at a page the fixture does not contain.
        // Group headers carry no target, so mutating one would exercise
        // nav.target_unexpected instead of the unknown-reference path.
        const target = document_.navItems.find((item) => item.kind === "NAV_ITEM_KIND_PAGE");
        target.resourceId = "99999999-9999-4999-8999-999999999999";
        await writeFile(file, `${JSON.stringify(document_, undefined, 2)}\n`);
      },
      code: "nav.resource_unknown",
      field: "navItems[1]",
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
      await scenario.mutate(fixture);
      const before = await treeDigest(fixture);

      const result = await runValidation(fixture);

      assert.equal(result.exitCode, 1);
      assert.equal(result.requests, 0);
      assert.equal(await treeDigest(fixture), before);
      assert.deepEqual(JSON.parse(result.stdout).error, { code: scenario.code, field: scenario.field });
      assert.match(result.stderr, new RegExp(`^taproot-site failed \\[${scenario.code.replaceAll(".", "\\.")}\\]`, "u"));
      for (const text of scenario.humanIncludes ?? []) assert.ok(result.stderr.includes(text), `missing '${text}'`);
      for (const text of scenario.humanExcludes ?? []) assert.ok(!result.stderr.includes(text), `unexpected '${text}'`);
    });
  }
});
