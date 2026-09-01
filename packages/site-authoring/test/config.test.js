import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadSiteConfig, readInspectedConfigFile } from "../src/config.js";

// Contains alphabetic hex digits on purpose: the canonical-lowercase rule is
// exercised via toUpperCase(), which would be a no-op on an all-digit id.
const SITE_ID = "aaaa1111-bbbb-4111-8111-cccc11111111";

async function fixture(testContext, config = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "taproot-site-config-"));
  testContext.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "project", "nested"), { recursive: true });
  await mkdir(path.join(root, "project", "site"));
  await writeFile(
    path.join(root, "project", "taproot-site.json"),
    `${JSON.stringify({
      configVersion: 1,
      siteId: SITE_ID,
      workspaceDir: "site",
      ...config,
    })}\n`,
  );
  return root;
}

test("discovers one parent config and resolves the workspace beneath the real config directory", async (testContext) => {
  const root = await fixture(testContext);
  const result = await loadSiteConfig({ cwd: path.join(root, "project", "nested") });
  assert.equal(result.configVersion, 1);
  assert.equal(result.siteId, SITE_ID);
  assert.equal(result.workspaceDir, await realpath(path.join(root, "project", "site")));
  assert.equal(result.workspaceExists, true);
});

test("accepts a workspace that pull has not created yet", async (testContext) => {
  for (const workspaceDir of ["fresh", "site/pages"]) {
    await testContext.test(workspaceDir, async (caseContext) => {
      const root = await fixture(caseContext, { workspaceDir });
      const result = await loadSiteConfig({ cwd: path.join(root, "project") });
      assert.equal(result.workspaceExists, false);
      assert.equal(
        result.workspaceDir,
        path.join(await realpath(path.join(root, "project")), ...workspaceDir.split("/")),
      );
    });
  }
});

test("rejects ambiguous parent configs", async (testContext) => {
  const root = await fixture(testContext);
  await writeFile(
    path.join(root, "taproot-site.json"),
    `${JSON.stringify({ configVersion: 1, siteId: SITE_ID, workspaceDir: "project/site" })}\n`,
  );
  await assert.rejects(
    loadSiteConfig({ cwd: path.join(root, "project", "nested") }),
    (error) => error?.code === "config.ambiguous",
  );
});

test("rejects a missing configuration rather than guessing a site", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taproot-site-config-empty-"));
  testContext.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    loadSiteConfig({ cwd: root }),
    (error) => error?.code === "config.not_found",
  );
});

test("explicit path failures carry the stable configPath field", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taproot-site-explicit-config-"));
  testContext.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    { configPath: "missing.json", code: "config.not_found" },
    { configPath: "x".repeat(4 * 1024 + 1), code: "config.path_invalid" },
    { configPath: "control\u0007.json", code: "config.path_invalid" },
  ];
  for (const scenario of cases) {
    await testContext.test(scenario.code, async () => {
      await assert.rejects(
        loadSiteConfig({ cwd: root, configPath: scenario.configPath }),
        (error) => error?.code === scenario.code && error?.field === "configPath",
      );
    });
  }
});

test("an explicit config changed during inspection keeps the configPath field", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taproot-site-changing-config-"));
  testContext.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "taproot-site.json");
  await writeFile(configPath, "{}\n");
  const inspected = await lstat(configPath, { bigint: true });
  await writeFile(configPath, "{\"changed\":true}\n");

  await assert.rejects(
    readInspectedConfigFile(configPath, inspected, undefined, "configPath"),
    (error) => error?.code === "config.changed" && error?.field === "configPath",
  );
});

test("rejects duplicate and unknown config fields with stable field identities", async (testContext) => {
  const root = await fixture(testContext);
  const configPath = path.join(root, "project", "taproot-site.json");
  await writeFile(
    configPath,
    `{"configVersion":1,"siteId":"${SITE_ID}","siteId":"${SITE_ID}","workspaceDir":"site"}\n`,
  );
  await assert.rejects(
    loadSiteConfig({ cwd: root, configPath }),
    (error) => error?.code === "config.duplicate_key" && error?.field === "siteId",
  );

  await writeFile(
    configPath,
    `${JSON.stringify({ configVersion: 1, siteId: SITE_ID, workspaceDir: "site", token: "do-not-accept" })}\n`,
  );
  await assert.rejects(
    loadSiteConfig({ cwd: root, configPath }),
    (error) => error?.code === "config.unknown_field" && error?.field === "token",
  );
});

test("rejects unsupported versions and malformed site identities", async (testContext) => {
  const cases = [
    { config: { configVersion: 2 }, code: "config.unsupported_version", field: "configVersion" },
    { config: { configVersion: "1" }, code: "config.unsupported_version", field: "configVersion" },
    { config: { siteId: "not-a-uuid" }, code: "config.site_id", field: "siteId" },
    { config: { siteId: SITE_ID.toUpperCase() }, code: "config.site_id", field: "siteId" },
    { config: { siteId: 7 }, code: "config.site_id", field: "siteId" },
  ];
  for (const scenario of cases) {
    await testContext.test(JSON.stringify(scenario.config), async (caseContext) => {
      const root = await fixture(caseContext, scenario.config);
      await assert.rejects(
        loadSiteConfig({ cwd: path.join(root, "project") }),
        (error) => error?.code === scenario.code && error?.field === scenario.field,
      );
    });
  }
});

test("rejects a workspace that escapes, is absolute, or is not a real directory", async (testContext) => {
  for (const workspaceDir of ["../outside", "/etc", "site/../../outside", "", "site\\pages", "."]) {
    await testContext.test(JSON.stringify(workspaceDir), async (caseContext) => {
      const root = await fixture(caseContext, { workspaceDir });
      await assert.rejects(
        loadSiteConfig({ cwd: path.join(root, "project") }),
        (error) => error?.code === "config.workspace_dir" && error?.field === "workspaceDir",
      );
    });
  }

  await testContext.test("linked workspace", async (caseContext) => {
    const root = await fixture(caseContext);
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await rm(path.join(root, "project", "site"), { recursive: true });
    await symlink(outside, path.join(root, "project", "site"));
    await assert.rejects(
      loadSiteConfig({ cwd: path.join(root, "project") }),
      (error) => error?.code === "config.workspace_invalid" && error?.field === "workspaceDir",
    );
  });

  await testContext.test("file where a workspace directory belongs", async (caseContext) => {
    const root = await fixture(caseContext);
    await rm(path.join(root, "project", "site"), { recursive: true });
    await writeFile(path.join(root, "project", "site"), "not a directory\n");
    await assert.rejects(
      loadSiteConfig({ cwd: path.join(root, "project") }),
      (error) => error?.code === "config.workspace_invalid",
    );
  });
});

test("the configuration refuses apiBaseUrl by name, pointing at the command that replaced it", async (testContext) => {
  const root = await fixture(testContext, { apiBaseUrl: "https://app.taproot.test/api" });

  // Not "unknown field": this one was valid here until TR00645, and the fix is
  // a command rather than a spelling correction. The message has to say so or
  // the reader deletes the line and still ends up on production.
  await assert.rejects(
    loadSiteConfig({ cwd: path.join(root, "project") }),
    (error) =>
      error?.code === "config.api_base_url_moved"
      && error?.field === "apiBaseUrl"
      && /taproot-site env local/u.test(error.message),
  );
});

test("rejects an explicit configuration path reached through a linked parent", async (testContext) => {
  const root = await fixture(testContext);
  await symlink(path.join(root, "project"), path.join(root, "linked-project"));
  await assert.rejects(
    loadSiteConfig({
      cwd: root,
      configPath: path.join("linked-project", "taproot-site.json"),
    }),
    (error) => error?.code === "config.not_regular" && error?.field === "configPath",
  );
});

test("rejects an oversized configuration before parsing it", async (testContext) => {
  const root = await fixture(testContext);
  const configPath = path.join(root, "project", "taproot-site.json");
  await writeFile(
    configPath,
    `${JSON.stringify({
      configVersion: 1,
      siteId: SITE_ID,
      workspaceDir: `site${"/padding".repeat(4_000)}`,
    })}\n`,
  );
  await assert.rejects(
    loadSiteConfig({ cwd: root, configPath }),
    (error) => error?.code === "config.too_large",
  );
});

test("rejects a configuration that is not a JSON object", async (testContext) => {
  const root = await fixture(testContext);
  const configPath = path.join(root, "project", "taproot-site.json");
  for (const [text, code] of [["[]", "config.shape"], ["{", "config.invalid_json"], ["null", "config.shape"]]) {
    await writeFile(configPath, `${text}\n`);
    await assert.rejects(
      loadSiteConfig({ cwd: root, configPath }),
      (error) => error?.code === code,
    );
  }
});
