import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadPublisherConfig } from "../src/config.js";

const SITE_ID = "11111111-1111-4111-8111-111111111111";

async function fixture(testContext, config = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "taproot-docs-publisher-config-"));
  testContext.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "project", "nested"), { recursive: true });
  await mkdir(path.join(root, "project", "_site"));
  await writeFile(
    path.join(root, "project", "taproot-docs-publisher.json"),
    `${JSON.stringify({
      configVersion: 1,
      siteId: SITE_ID,
      artifactDirectory: "_site",
      apiBaseUrl: "https://app.taproot.test/api",
      ...config,
    })}\n`,
  );
  return root;
}

test("discovers one parent config and resolves its artifact beneath the real config directory", async (testContext) => {
  const root = await fixture(testContext);
  const result = await loadPublisherConfig({ cwd: path.join(root, "project", "nested") });
  assert.equal(result.siteId, SITE_ID);
  assert.equal(result.artifactDirectory, await realpath(path.join(root, "project", "_site")));
  assert.equal(result.apiBaseUrl, "https://app.taproot.test/api");
});

test("resolves the closed publication mode and defaults an absent one to managed", async (testContext) => {
  for (
    const [scenario, mode, resolved] of [
      ["absent", undefined, "managed"],
      ["managed", "managed", "managed"],
      ["prebuilt", "prebuilt", "prebuilt"],
    ]
  ) {
    await testContext.test(scenario, async (modeContext) => {
      const root = await fixture(modeContext, mode === undefined ? {} : { mode });
      const result = await loadPublisherConfig({ cwd: path.join(root, "project") });
      assert.equal(result.mode, resolved);
    });
  }
});

test("rejects every publication mode outside the closed selection", async (testContext) => {
  for (
    const mode of [
      "Managed",
      "PREBUILT",
      "prebuilt ",
      "static",
      "",
      1,
      true,
      null,
      ["prebuilt"],
      { mode: "prebuilt" },
    ]
  ) {
    await testContext.test(`mode ${JSON.stringify(mode)}`, async (modeContext) => {
      const root = await fixture(modeContext, { mode });
      await assert.rejects(
        loadPublisherConfig({ cwd: path.join(root, "project") }),
        (error) => error?.code === "config.mode_invalid" && error?.field === "mode",
      );
    });
  }
});

test("rejects ambiguous parent configs", async (testContext) => {
  const root = await fixture(testContext);
  await writeFile(
    path.join(root, "taproot-docs-publisher.json"),
    `${JSON.stringify({ configVersion: 1, siteId: SITE_ID, artifactDirectory: "project/_site" })}\n`,
  );
  await assert.rejects(
    loadPublisherConfig({ cwd: path.join(root, "project", "nested") }),
    (error) => error?.code === "config.ambiguous",
  );
});

test("rejects duplicate and unknown config fields with stable field identities", async (testContext) => {
  const root = await fixture(testContext);
  const configPath = path.join(root, "project", "taproot-docs-publisher.json");
  await writeFile(
    configPath,
    `{"configVersion":1,"siteId":"${SITE_ID}","siteId":"${SITE_ID}","artifactDirectory":"_site"}\n`,
  );
  await assert.rejects(
    loadPublisherConfig({ cwd: root, configPath }),
    (error) => error?.code === "config.duplicate_key" && error?.field === "siteId",
  );

  await writeFile(
    configPath,
    `${JSON.stringify({ configVersion: 1, siteId: SITE_ID, artifactDirectory: "_site", token: "do-not-accept" })}\n`,
  );
  await assert.rejects(
    loadPublisherConfig({ cwd: root, configPath }),
    (error) => error?.code === "config.unknown_field" && error?.field === "token",
  );
});

test("rejects artifact links and arbitrary credential destinations", async (testContext) => {
  const root = await fixture(testContext);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await rm(path.join(root, "project", "_site"), { recursive: true });
  await symlink(outside, path.join(root, "project", "_site"));
  await assert.rejects(
    loadPublisherConfig({ cwd: path.join(root, "project") }),
    (error) => error?.code === "artifact.directory_invalid",
  );

  const other = await fixture(testContext, { apiBaseUrl: "https://attacker.example/api" });
  await assert.rejects(
    loadPublisherConfig({ cwd: path.join(other, "project") }),
    (error) => error?.code === "config.api_base_url" && error?.field === "apiBaseUrl",
  );
});

test("rejects an explicit configuration path reached through a linked parent", async (testContext) => {
  const root = await fixture(testContext);
  await symlink(path.join(root, "project"), path.join(root, "linked-project"));
  await assert.rejects(
    loadPublisherConfig({
      cwd: root,
      configPath: path.join("linked-project", "taproot-docs-publisher.json"),
    }),
    (error) => error?.code === "config.not_regular",
  );
});
