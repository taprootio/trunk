import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { pull } from "../src/verbs/pull.js";
import { MANIFEST_FILE_NAME, MANIFEST_VERSION, workspaceContentHash } from "../src/workspace.js";

const SITE_ID = "aaaa1111-bbbb-4111-8111-cccc11111111";
const REVISION = `v1:${"a".repeat(64)}`;
const OLD_REVISION = `v1:${"b".repeat(64)}`;
const OLD_HASH = `sha256:${"c".repeat(64)}`;
const BODY = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Remote" }] }] };
const MARKDOWN = "# Local source\n";
const DOCUMENT = `${JSON.stringify(BODY, undefined, 2)}\n`;
const NOTICE = /revision recorded for \d+ pages that had none; bodies were not compared/u;

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

// The larger verb suite's helpers are private to its test module. Keep this
// fixture limited to pull's transport boundary and a real, isolated workspace.
async function fixture(context, specifications, { manifestVersion = MANIFEST_VERSION, failNavigation = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taproot-pull-revisions-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const root = await realpath(directory);
  const workspace = path.join(root, "site");
  const configHome = path.join(root, "config-home");
  await mkdir(path.join(workspace, "pages"), { recursive: true });
  await mkdir(configHome);
  await writeFile(
    path.join(root, "taproot-site.json"),
    JSON.stringify({ configVersion: 1, siteId: SITE_ID, workspaceDir: "site" }),
  );
  const pages = specifications.map((specification, index) => {
    const pageId = `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`;
    return {
      pageId,
      resourceId: pageId,
      path: `page-${index + 1}`,
      title: `Page ${index + 1}`,
      status: "PAGE_STATUS_PUBLISHED",
      templateType: "TEMPLATE_TYPE_FREE_FORM",
      hasDraft: false,
      source: MARKDOWN,
      revision: REVISION,
      body: BODY,
      ...specification,
    };
  });
  const entries = [];
  for (const page of pages) {
    if (page.newPage) continue;
    const file = `pages/${page.path}.${page.prosemirror ? "pm.json" : "md"}`;
    if (!page.missingSource) await writeFile(path.join(workspace, file), page.source);
    entries.push({
      pageId: page.pageId,
      resourceId: page.resourceId,
      path: page.path,
      file,
      sourceFormat: page.prosemirror ? "prosemirror" : "markdown",
      workspaceMode: "editable",
      ...(page.baseline === undefined ? {} : { baseline: page.baseline }),
    });
  }
  await writeFile(
    path.join(workspace, MANIFEST_FILE_NAME),
    JSON.stringify({ manifestVersion, siteId: SITE_ID, pages: entries }),
  );
  const progress = [];
  const invocation = {
    cwd: root,
    environment: { TAPROOT_SITE_KEY: "test_site_authoring_key", XDG_CONFIG_HOME: configHome },
    onProgress: (message) => progress.push(message),
    fetch: async (url, init = {}) => {
      const target = new URL(url);
      assert.equal(init.method ?? "GET", "GET");
      if (target.pathname.includes("/pages/by_site/")) return jsonResponse({ pages });
      if (target.pathname.endsWith("/redirects")) return jsonResponse({ code: 5 }, 404);
      if (target.pathname.includes("/settings/")) return jsonResponse({ code: 7 }, 403);
      if (target.pathname.endsWith("/navigation")) {
        assert.equal(target.searchParams.get("environment"), "SITE_ENVIRONMENT_DRAFT");
        return failNavigation ? jsonResponse({ code: 7 }, 403) : jsonResponse({ navItems: [] });
      }
      const page = pages.find((entry) => target.pathname.endsWith(`/pages/${entry.pageId}`));
      assert.ok(page, `Unexpected request: ${target.pathname}`);
      assert.equal(target.searchParams.get("status"), "PAGE_STATUS_PUBLISHED");
      return jsonResponse({
        pageId: page.pageId,
        title: page.title,
        path: page.path,
        bodyRevision: page.revision,
        template: { freeFormData: { body: page.body } },
      });
    },
  };
  return {
    invocation,
    progress,
    workspace,
    readManifest: async () => JSON.parse(await readFile(path.join(workspace, MANIFEST_FILE_NAME), "utf8")),
  };
}

test("pull reports only existing sources that adopt a first revision without comparing bodies", async (context) => {
  const site = await fixture(context, [
    {},
    { prosemirror: true, source: DOCUMENT, baseline: { sourceHash: workspaceContentHash(Buffer.from(DOCUMENT)) } },
    { baseline: { revision: REVISION } },
    { prosemirror: true, source: DOCUMENT },
    { prosemirror: true, source: JSON.stringify({ type: "doc", content: [] }) },
    { revision: undefined },
    { revision: "invalid" },
    { body: null },
    { newPage: true },
    { missingSource: true },
    { prosemirror: true, source: "{ malformed document" },
  ]);

  const first = await pull(site.invocation);

  assert.equal(first.pages.revisionsRecordedWithoutBodyComparison, 3);
  assert.deepEqual(site.progress.filter((message) => NOTICE.test(message)), [
    "revision recorded for 3 pages that had none; bodies were not compared",
  ]);
  const manifest = await site.readManifest();
  for (const index of [0, 1, 2, 3, 4, 8, 9, 10]) assert.equal(manifest.pages[index].baseline.revision, REVISION);
  for (const index of [5, 6, 7]) assert.equal(manifest.pages[index].baseline?.revision, undefined);
  assert.equal(await readFile(path.join(site.workspace, "pages/page-1.md"), "utf8"), MARKDOWN);
  assert.equal(await readFile(path.join(site.workspace, "pages/page-11.pm.json"), "utf8"), "{ malformed document");
  assert.deepEqual(
    JSON.parse(await readFile(path.join(site.workspace, "pages/page-5.pm.json"), "utf8")),
    { type: "doc", content: [] },
  );

  site.progress.length = 0;
  const second = await pull(site.invocation);
  assert.equal(second.pages.revisionsRecordedWithoutBodyComparison, 0);
  assert.deepEqual(site.progress.filter((message) => NOTICE.test(message)), []);
});

test("first revision adoption reports superseded hashes in old and current manifests", async (context) => {
  for (const manifestVersion of [4, 5, MANIFEST_VERSION]) {
    await context.test(`manifest version ${manifestVersion}`, async (subtest) => {
      const site = await fixture(subtest, [{
        baseline: { remoteHash: OLD_HASH, sourceHash: workspaceContentHash(Buffer.from(MARKDOWN)) },
      }], { manifestVersion });

      const result = await pull(site.invocation);

      assert.equal(result.pages.revisionsRecordedWithoutBodyComparison, 1);
      assert.equal(site.progress.filter((message) => NOTICE.test(message)).length, 1);
      assert.equal((await site.readManifest()).pages[0].baseline.revision, REVISION);
    });
  }
});

test("a refused pull never announces planned revision adoptions", async (context) => {
  for (const failure of ["conflict", "navigation"]) {
    await context.test(failure, async (subtest) => {
      const specifications = failure === "conflict" ? [{}, { baseline: { revision: OLD_REVISION } }] : [{}];
      const site = await fixture(subtest, specifications, { failNavigation: failure === "navigation" });
      const before = await site.readManifest();

      await assert.rejects(pull(site.invocation), (error) => {
        if (failure === "conflict") assert.equal(error.code, "pages.pull_conflict");
        else assert.equal(error.httpStatus, 403);
        return true;
      });

      assert.deepEqual(site.progress.filter((message) => NOTICE.test(message)), []);
      assert.deepEqual(await site.readManifest(), before);
    });
  }
});
