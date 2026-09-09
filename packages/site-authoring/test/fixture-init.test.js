import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { shippedFixtureDirectory } from "../src/fixture-contract.js";
import { validateFixture } from "../src/verbs/validate.js";

async function sourceWorkspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "fixture-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await cp(shippedFixtureDirectory(), source, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(source, "manifest.fixture.json"), "utf8"));
  delete manifest.fixture;
  manifest.deployments = {
    staging: { id: "11111111-1111-4111-8111-111111111111", url: "https://live.test/?secret=token" },
  };
  for (const entry of manifest.settings) {
    const file = path.join(source, entry.file);
    const doc = JSON.parse(await readFile(file, "utf8"));
    doc.entityId = manifest.siteId;
    doc.credential = "never-copy-this-token";
    doc.settings.credential = "never-copy-this-token";
    entry.entityId = manifest.siteId;
    await writeFile(file, JSON.stringify(doc));
  }
  await writeFile(path.join(source, ".taproot-site-manifest.json"), JSON.stringify(manifest));
  await writeFile(
    path.join(source, "taproot-site.json"),
    JSON.stringify({ configVersion: 1, siteId: manifest.siteId, workspaceDir: "." }),
  );
  await writeFile(path.join(source, "credentials.json"), "never-copy-this-token");
  const page = path.join(source, "pages/index.md");
  await writeFile(
    page,
    (await readFile(page, "utf8"))
      .replaceAll("https://static.example.test", "https://delivery.live.invalid")
      .replaceAll("riverbend-studio-1280.webp", "riverbend-studio-1280.webp?signature=never-copy-this-token#private"),
  );
  return { root, source, manifest };
}

async function invoke(cwd, args) {
  let stdout = "";
  let stderr = "";
  const exit = await runCli({
    cwd,
    arguments_: args,
    environment: {},
    stdout: {
      write: (value) => {
        stdout += value;
      },
    },
    stderr: {
      write: (value) => {
        stderr += value;
      },
    },
    fetch: () => assert.fail("fixture initialization must remain offline"),
  });
  return { exit, result: JSON.parse(stdout), stderr };
}

test("init exports a self-contained version-6 fixture, remaps identities and origins, and preserves its source", async (t) => {
  const { source, manifest } = await sourceWorkspace(t);
  const before = await readFile(path.join(source, ".taproot-site-manifest.json"), "utf8");
  const initialized = await invoke(source, ["validate", "--init", "../output"]);
  assert.equal(initialized.exit, 0, initialized.stderr);
  const output = initialized.result.initialized.directory;
  const result = await invoke(source, ["validate", output]);
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.result.validated.pages.total, 2);
  const fixture = JSON.parse(await readFile(path.join(output, "manifest.fixture.json"), "utf8"));
  assert.equal(fixture.manifestVersion, 6);
  assert.ok(fixture.appearance && fixture.footer);
  assert.notEqual(fixture.siteId, manifest.siteId);
  assert.ok(fixture.fixture.deliveryOrigins.every((origin) => new URL(origin).hostname.endsWith(".example.test")));
  const names = await readdir(output, { recursive: true });
  assert.ok(
    !names.some((name) => name.includes("credentials") || name.includes(".taproot") || name === "taproot-site.json"),
  );
  for (const name of names.filter((name) => name.endsWith(".json"))) {
    const contents = await readFile(path.join(output, name), "utf8");
    assert.ok(!contents.includes(manifest.siteId));
    assert.ok(
      !contents.includes("delivery.live.invalid") && !contents.includes("a0000000-")
        && !contents.includes("never-copy-this-token") && !contents.includes("?secret="),
    );
  }
  assert.equal(await readFile(path.join(source, ".taproot-site-manifest.json"), "utf8"), before);
});

test("init redacts unparseable URL-shaped prose without aborting the export", async (t) => {
  const { source } = await sourceWorkspace(t);
  const page = path.join(source, "pages/index.md");
  const before = await readFile(page, "utf8");
  const authored = `${before}\n\nExamples: https://example.com:port/ and https://[\n`;
  await writeFile(page, authored);
  const initialized = await invoke(source, ["validate", "--init", "../output"]);
  assert.equal(initialized.exit, 0, initialized.stderr);
  const output = initialized.result.initialized.directory;
  const contents = await Promise.all(
    (await readdir(path.join(output, "pages"))).map((name) => readFile(path.join(output, "pages", name), "utf8")),
  );
  assert.ok(
    contents.some((content) =>
      content.includes("Examples: https://origin.example.test/ and https://origin.example.test/")
    ),
  );
  assert.equal((await invoke(source, ["validate", output])).exit, 0);
  assert.equal(await readFile(page, "utf8"), authored);
});

test("init refuses existing destinations and linked source files without overwriting or leaving a partial fixture", async (t) => {
  const { root, source } = await sourceWorkspace(t);
  await mkdir(path.join(root, "existing"));
  await writeFile(path.join(root, "existing", "sentinel"), "keep");
  const nested = await invoke(source, ["validate", "--init", "fixture"]);
  assert.equal(nested.result.error.code, "fixture.init_invalid");
  const collision = await invoke(source, ["validate", "--init", "../existing"]);
  assert.equal(collision.result.error.code, "fixture.init_invalid");
  assert.equal(await readFile(path.join(root, "existing", "sentinel"), "utf8"), "keep");
  const page = path.join(source, "pages", "index.md");
  await rm(page);
  await symlink(path.join(source, "pages", "visit.md"), page);
  const linked = await invoke(source, ["validate", "--init", "../output"]);
  assert.equal(linked.exit, 1);
  assert.ok(!(await readdir(root)).includes("output"));
});

test("init removes its incomplete destination when exported content fails fixture validation", async (t) => {
  const { root, source } = await sourceWorkspace(t);
  const nav = path.join(source, "nav.json");
  const doc = JSON.parse(await readFile(nav, "utf8"));
  doc.navItems[0].pageResourceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await writeFile(nav, JSON.stringify(doc));
  await assert.rejects(validateFixture({ cwd: source, fixturePath: "../output", init: true }));
  assert.ok(!(await readdir(root)).includes("output"));
});

test("init reports all missing settings through JSON and the human channel before creating output", async (t) => {
  const { root, source } = await sourceWorkspace(t);
  const styleFile = path.join(source, "settings/taproot-styles.json");
  const style = JSON.parse(await readFile(styleFile, "utf8"));
  delete style.settings.lightTheme.fontMenu;
  delete style.settings.darkTheme.fontMenu;
  await writeFile(styleFile, JSON.stringify(style));
  const headerFile = path.join(source, "settings/site-header.json");
  const header = JSON.parse(await readFile(headerFile, "utf8"));
  delete header.settings.headerWidth;
  await writeFile(headerFile, JSON.stringify(header));
  const result = await invoke(source, ["validate", "--init", "../output"]);
  assert.equal(result.exit, 1);
  assert.equal(result.result.error.code, "theme.settings_missing");
  assert.deepEqual(result.result.error.details.map((item) => item.field), [
    "lightTheme.fontMenu",
    "darkTheme.fontMenu",
    "site-header.headerWidth",
  ]);
  for (const detail of result.result.error.details) assert.ok(result.stderr.includes(`${detail.field}: is missing`));
  assert.ok(!(await readdir(root)).includes("output"));
});

test("init discovers an explicit source configuration without reading credentials", async (t) => {
  const { root, manifest } = await sourceWorkspace(t);
  await writeFile(
    path.join(root, "selected.json"),
    JSON.stringify({ configVersion: 1, siteId: manifest.siteId, workspaceDir: "source" }),
  );
  const result = await invoke(root, ["--config", "selected.json", "validate", "--init", "output"]);
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.result.initialized.pages, 2);
});
