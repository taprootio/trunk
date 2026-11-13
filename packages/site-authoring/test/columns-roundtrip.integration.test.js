import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { LIMITS } from "../src/constants.js";
import { canonicalDocumentHash, internalPageBaselineFile, MEDIA_MANIFEST_VERSION } from "../src/workspace.js";

const SITE_ID = "aaaa1111-bbbb-4111-8111-cccc11111111";
const PAGE_ID = "bbbb2222-cccc-4222-8222-dddd22222222";
const IMAGE_ID = "cccc3333-dddd-4333-8333-eeee33333333";
const FORM_ID = "dddd4444-eeee-4444-8444-ffff44444444";
const CREATED_PAGE_ID = "eeee5555-ffff-4555-8555-aaaa55555555";
const KEY = "tr_fixture_columns_roundtrip";
const MANIFEST_FILE = ".taproot-site-manifest.json";
const CROP = { x: 0.1, y: 0.2, width: 0.6, height: 0.5 };
const CROP_URL = "https://cdn.example.test/persisted-crop.webp";
const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] });
const document = (...content) => ({ type: "doc", content });
const TEMPLATES = {
  "free-form": { wire: "TEMPLATE_TYPE_FREE_FORM", member: "freeFormData" },
  article: { wire: "TEMPLATE_TYPE_ARTICLE", member: "articleData" },
  recipe: { wire: "TEMPLATE_TYPE_RECIPE", member: "recipeData" },
};

function columnsBody(count = 2, { formReference = "formId" } = {}) {
  const content = [
    { type: "column", content: [paragraph("Before editing"), {
      type: "taprootImage",
      attrs: {
        imageId: IMAGE_ID, src: CROP_URL, urls: [{ minWidth: 640, url: CROP_URL }],
        width: 1200, height: 800, crop: { ...CROP }, descriptionMode: "custom", alt: "Garden detail",
      },
    }] },
    { type: "column", content: [{
      type: "componentBlock",
      attrs: { componentType: "form", componentData: JSON.stringify({ [formReference]: formReference === "formId" ? FORM_ID : "contact" }) },
    }] },
  ];
  if (count === 3) content.push({ type: "column", content: [paragraph("Third region")] });
  return document({ type: "section", content: [{ type: "columns", attrs: { count, ratio: "equal" }, content }] });
}

function record({ id = PAGE_ID, pagePath = "story", title = "Story", template = "free-form", data } = {}) {
  return { id, path: pagePath, title, template, data: data ?? { body: columnsBody() }, revision: "a" };
}

function summary(page) {
  return {
    pageId: page.id, resourceId: page.id, path: page.path, title: page.title,
    templateType: TEMPLATES[page.template].wire, status: "PAGE_STATUS_DRAFT", hasDraft: true,
    bodyRevision: `sha256:${page.revision.repeat(64)}`,
  };
}

function pageDetail(page) {
  const { wire, member } = TEMPLATES[page.template];
  return { ...summary(page), template: { templateType: wire, [member]: page.data } };
}

async function fixture(context, pages = [record()]) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "taproot-columns-roundtrip-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const workspaceDir = path.join(project, "site");
  const configHome = path.join(root, "config-home");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(path.join(configHome, "taproot-site"), { recursive: true });
  await writeFile(path.join(project, "taproot-site.json"), JSON.stringify({
    configVersion: 1, siteId: SITE_ID, authoringSurface: "standard", workspaceDir: "site",
  }));
  await writeFile(path.join(configHome, "taproot-site", "settings.json"), JSON.stringify({
    schemaVersion: 1, apiBaseUrl: "https://app.taproot.test/api",
  }));
  const state = { pages, writes: [], calls: [] };
  const reply = (value, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { "content-type": "application/json" },
  });
  const fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    const method = options.method ?? "GET";
    assert.equal(new Headers(options.headers).get("authorization"), `Bearer ${KEY}`);
    state.calls.push({ method, pathname });
    if (method === "GET" && pathname === `/api/v1/pages/by_site/${SITE_ID}`) {
      return reply({ pages: state.pages.map(summary) });
    }
    const page = state.pages.find(candidate => pathname === `/api/v1/pages/${candidate.id}`);
    if (method === "GET" && page !== undefined) return reply(pageDetail(page));
    if (method === "PATCH" && page !== undefined) {
      const body = JSON.parse(options.body);
      state.writes.push({ method, pathname, body });
      page.data = structuredClone(body.template[TEMPLATES[page.template].member]);
      page.title = body.title;
      page.revision = "b";
      return reply(summary(page));
    }
    if (method === "POST" && pathname === "/api/v1/pages") {
      const body = JSON.parse(options.body);
      state.writes.push({ method, pathname, body });
      assert.equal(body.siteId, SITE_ID);
      const created = record({ id: CREATED_PAGE_ID, pagePath: body.path, title: body.title, data: structuredClone(body.template.freeFormData) });
      state.pages.push(created);
      return reply(summary(created));
    }
    if (method === "GET" && pathname === `/api/v1/sites/${SITE_ID}/forms`) {
      return reply({ forms: [{ id: FORM_ID, key: "contact", name: "Contact", status: "SITE_FORM_STATUS_ACTIVE", currentVersion: 1 }] });
    }
    if (method === "GET" && pathname === `/api/v1/sites/${SITE_ID}/navigation`) return reply({ navItems: [], revision: "e".repeat(64) });
    if (method === "GET" && pathname === `/api/v1/sites/${SITE_ID}/authors`) return reply({ authors: [], members: [] });
    if (method === "GET" && pathname === `/api/v1/sites/${SITE_ID}/redirects`) return reply({ code: 5 }, 404);
    if (method === "GET" && (pathname === `/api/v1/sites/${SITE_ID}/presentation` || pathname.startsWith("/api/v1/settings/"))) {
      return reply({ code: 7 }, 403);
    }
    throw new Error(`Unexpected columns roundtrip request: ${method} ${pathname}`);
  };
  const run = async arguments_ => {
    let stdout = "";
    let stderr = "";
    const exit = await runCli({
      arguments_, cwd: project, fetch,
      environment: { XDG_CONFIG_HOME: configHome, HOME: configHome, TAPROOT_SITE_KEY: KEY },
      stdout: { write: chunk => stdout += chunk }, stderr: { write: chunk => stderr += chunk },
    });
    return { exit, result: JSON.parse(stdout), stderr };
  };
  const readJson = async file => JSON.parse(await readFile(path.join(workspaceDir, file), "utf8"));
  return { state, run, workspaceDir, readJson };
}

const rowOf = body => body.content[0].content[0];
const regionBlocks = body => rowOf(body).content.flatMap(region => region.content);
const placedForm = body => JSON.parse(regionBlocks(body).find(node => node.attrs?.componentType === "form").attrs.componentData);
const placedImage = body => regionBlocks(body).find(node => node.type === "taprootImage").attrs;
const assertSuccess = result => assert.equal(result.exit, 0, JSON.stringify(result));

for (const count of [2, 3]) {
  test(`${count}-region image/form columns pull to JSON, edit and push without losing identities or defaults`, async context => {
    const { state, run, workspaceDir, readJson } = await fixture(context, [record({ data: { body: columnsBody(count) } })]);
    assertSuccess(await run(["pull"]));
    const manifest = await readJson(MANIFEST_FILE);
    const sourceFile = manifest.pages[0].file;
    assert.match(sourceFile, /\.pm\.json$/u);
    const authored = await readJson(sourceFile);
    assert.deepEqual(placedForm(authored), { formKey: "contact" });
    assert.equal(placedImage(authored).imageId, IMAGE_ID);
    assert.deepEqual(placedImage(authored).crop, CROP);
    const imageBefore = structuredClone(placedImage(authored));
    const row = rowOf(authored);
    row.attrs = { count, ratio: "equal" };
    row.content[0].content[0].content[0].text = "Edited in the workspace";
    const movedImage = row.content[0].content.pop();
    assert.equal(movedImage.type, "taprootImage");
    row.content.at(-1).content.push(movedImage);
    await writeFile(path.join(workspaceDir, sourceFile), `${JSON.stringify(authored, null, 2)}\n`);

    assertSuccess(await run(["pages", "push", "story"]));

    const write = assertOneWrite(state, "PATCH");
    assert.equal(write.pathname, `/api/v1/pages/${PAGE_ID}`);
    const sent = write.body.template.freeFormData.body;
    assert.equal(rowOf(sent).content.length, count);
    assert.deepEqual(rowOf(sent).attrs, count === 2 ? undefined : { count: 3 });
    assert.deepEqual(placedForm(sent), { formId: FORM_ID });
    assert.deepEqual(placedImage(sent), imageBefore);
    assert.equal(rowOf(sent).content[0].content[0].content[0].text, "Edited in the workspace");
    assert.equal(rowOf(sent).content.at(-1).content.at(-1).attrs.imageId, IMAGE_ID);

    assertSuccess(await run(["pull"]));
    const pulledAgain = await readJson(sourceFile);
    assert.deepEqual(placedForm(pulledAgain), { formKey: "contact" });
    assert.deepEqual(placedImage(pulledAgain), imageBefore);
    assert.equal((await readJson(MANIFEST_FILE)).pages[0].pageId, PAGE_ID);
    assert.equal(state.writes.length, 1);
  });
}

function assertOneWrite(state, method) {
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0].method, method);
  return state.writes[0];
}

test("new Markdown columns create an image/form page and keep their Markdown source on pull", async context => {
  const { state, run, workspaceDir, readJson } = await fixture(context);
  assertSuccess(await run(["pull"]));
  await writeFile(path.join(workspaceDir, ".taproot-site-media.json"), JSON.stringify({
    mediaManifestVersion: MEDIA_MANIFEST_VERSION, siteId: SITE_ID,
    media: { "media/garden.webp": { imageId: IMAGE_ID, width: 1200, height: 800, alt: "Garden" } }, videos: {},
  }));
  const sourceFile = "pages/new-columns.md";
  const markdown = [
    "---", "title: New columns", "path: new-columns", "---", "",
    ":::section {}", ':::columns {"count":2,"ratio":"equal"}', ":::column {}",
    "A newly authored page.", "", "![Garden](media/garden.webp)", ":::endcolumn",
    ":::column {}", "```component:form", '{"formKey":"contact"}', "```", ":::endcolumn", ":::endcolumns", ":::", "",
  ].join("\n");
  await writeFile(path.join(workspaceDir, sourceFile), markdown);

  assertSuccess(await run(["pages", "push", "new-columns"]));

  const write = assertOneWrite(state, "POST");
  assert.equal(write.body.path, "new-columns");
  const sent = write.body.template.freeFormData.body;
  assert.equal(rowOf(sent).attrs, undefined);
  assert.deepEqual(placedForm(sent), { formId: FORM_ID });
  assert.equal(placedImage(sent).imageId, IMAGE_ID);
  const created = (await readJson(MANIFEST_FILE)).pages.find(page => page.path === "new-columns");
  assert.equal(created.pageId, CREATED_PAGE_ID);
  assert.equal(created.file, sourceFile);
  assertSuccess(await run(["pull"]));
  assert.equal(await readFile(path.join(workspaceDir, sourceFile), "utf8"), markdown);
  assert.equal((await readdir(path.join(workspaceDir, "pages"))).includes("new-columns.pm.json"), false);
  assert.equal(state.writes.length, 1);
});

for (const template of ["article", "recipe"]) {
  test(`${template} columns refuse before any page mutation`, async context => {
    const plain = document(paragraph("Typed content"));
    const data = template === "article" ? { body: plain } : {
      introductionBody: document(),
      ingredientGroups: [{ name: "", ingredients: [{ rawText: "1 cup rice", quantity: "", unit: "", name: "", parsed: false }] }],
      instructionSections: [{ name: "First", stepBodies: [plain] }],
      prepTimeMinutes: 0, cookTimeMinutes: 0, servings: 1, recipeCategory: "", recipeCuisine: "", cookingMethod: "",
    };
    const { state, run, workspaceDir, readJson } = await fixture(context, [record({ template, data })]);
    assertSuccess(await run(["pull"]));
    const sourceFile = (await readJson(MANIFEST_FILE)).pages[0].file;
    const authored = await readJson(sourceFile);
    const forbidden = columnsBody(2, { formReference: "formKey" });
    if (template === "article") authored.data.body = forbidden;
    else authored.data.instructionSections[0].stepBodies[0] = forbidden;
    const bytes = `${JSON.stringify(authored, null, 2)}\n`;
    await writeFile(path.join(workspaceDir, sourceFile), bytes);

    const refused = await run(["pages", "push", "story"]);

    assert.notEqual(refused.exit, 0);
    assert.equal(refused.result.error.code, "pages.document_invalid");
    assert(refused.result.error.problems.some(problem => problem.code === "columns.not_allowed"));
    assert.equal(state.writes.length, 0);
    assert.equal(await readFile(path.join(workspaceDir, sourceFile), "utf8"), bytes);
  });
}

test("ordinary and columns oversized responses use the unchanged reader and write no partial workspace", async context => {
  assert.equal(LIMITS.apiResponseBytes, 1_048_576);
  const oversizedText = "x".repeat(LIMITS.apiResponseBytes);
  for (const withColumns of [false, true]) {
    await context.test(withColumns ? "columns" : "ordinary", async child => {
      const body = withColumns
        ? document({ type: "section", content: [{ type: "columns", content: [
          { type: "column", content: [paragraph(oversizedText)] },
          { type: "column", content: [paragraph("Second region")] },
        ] }] })
        : document(paragraph(oversizedText));
      const { state, run, workspaceDir } = await fixture(child, [
        record({ pagePath: "oversized", data: { body } }),
      ]);
      const sentinel = "Unrelated workspace content\n";
      await writeFile(path.join(workspaceDir, "keep.txt"), sentinel);

      const refused = await run(["pull"]);

      assert.notEqual(refused.exit, 0);
      assert.equal(refused.result.error.code, "transport.response_too_large");
      assert(state.calls.some(call => call.method === "GET" && call.pathname === `/api/v1/pages/${PAGE_ID}`));
      assert.deepEqual((await readdir(workspaceDir, { recursive: true })).sort(), ["keep.txt"]);
      assert.equal(await readFile(path.join(workspaceDir, "keep.txt"), "utf8"), sentinel);
      assert.equal(state.writes.length, 0);
    });
  }
});

const QUOTE_METADATA = { attribution: "Aldous Huxley", sourceTitle: "Brave New World", cite: "https://www.huxley.net/bnw/four.html" };
const quoteBody = () => document({ type: "blockquote", attrs: { ...QUOTE_METADATA }, content: [paragraph("Words can be like X-rays.")] });

test("a fresh attributed quote pulls to normal JSON and an unchanged push makes no write", async context => {
  const body = quoteBody();
  const { state, run, workspaceDir, readJson } = await fixture(context, [record({ data: { body } })]);
  assertSuccess(await run(["pull"]));
  const firstManifest = await readJson(MANIFEST_FILE);
  const entry = firstManifest.pages[0];
  assert.match(entry.file, /\.pm\.json$/u);
  assert.deepEqual(await readJson(entry.file), body);
  assert.equal(entry.baseline.remoteHash, canonicalDocumentHash(body));
  assert.equal(entry.baseline.revision, `sha256:${"a".repeat(64)}`);
  const bytes = await readFile(path.join(workspaceDir, entry.file), "utf8");

  assertSuccess(await run(["pages", "push", "story"]));
  assert.equal(state.writes.length, 0);
  assert.deepEqual(state.pages[0].data.body, body);
  assert.equal(await readFile(path.join(workspaceDir, entry.file), "utf8"), bytes);
  assertSuccess(await run(["pull"]));
  assert.equal(await readFile(path.join(workspaceDir, entry.file), "utf8"), bytes);
  assert.deepEqual((await readJson(MANIFEST_FILE)).pages[0].baseline, entry.baseline);
});

test("tracked Markdown retains quote metadata in remote JSON and baseline without changing its bytes", async context => {
  const { state, run, workspaceDir, readJson } = await fixture(context);
  assertSuccess(await run(["pull"]));
  const sourceFile = "pages/new-quote.md";
  const markdown = [
    "---", "title: A quotation", "path: new-quote", "---", "",
    `:::blockquote ${JSON.stringify(QUOTE_METADATA)}`, "Words can be like X-rays.", ":::endblockquote", "",
  ].join("\n");
  await writeFile(path.join(workspaceDir, sourceFile), markdown);
  assertSuccess(await run(["pages", "push", "new-quote"]));
  const write = assertOneWrite(state, "POST");
  assert.deepEqual(write.body.template.freeFormData.body, quoteBody());
  const entry = (await readJson(MANIFEST_FILE)).pages.find(page => page.path === "new-quote");
  assert.equal(entry.file, sourceFile);
  assert.match(entry.baseline.contentKey, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(await readFile(path.join(workspaceDir, sourceFile), "utf8"), markdown);

  assertSuccess(await run(["pull"]));
  assertSuccess(await run(["pages", "push", "new-quote"]));
  assert.equal(state.writes.length, 1);
  assert.equal(await readFile(path.join(workspaceDir, sourceFile), "utf8"), markdown);
  assert.deepEqual(await readJson(internalPageBaselineFile(entry.pageId)), quoteBody());
  assert.equal((await readdir(path.join(workspaceDir, "pages"))).includes("new-quote.pm.json"), false);

  const remote = state.pages.find(page => page.id === entry.pageId);
  remote.data.body.content[0].attrs.sourceTitle = "Changed in the browser";
  remote.revision = "c";
  const stale = await run(["pages", "push", "new-quote"]);
  assert.notEqual(stale.exit, 0);
  assert.equal(stale.result.error.code, "pages.push_conflict");
  assert.equal(state.writes.length, 1);
  const conflicted = await run(["pull"]);
  assert.notEqual(conflicted.exit, 0);
  assert.equal(conflicted.result.error.code, "pages.pull_conflict");
  assert.equal(await readFile(path.join(workspaceDir, sourceFile), "utf8"), markdown);
  assert.deepEqual(await readJson(internalPageBaselineFile(entry.pageId)), remote.data.body);
  assert.deepEqual(remote.data.body.content[0].content, quoteBody().content[0].content);
  assert.equal((await readJson(MANIFEST_FILE)).pages.find(page => page.pageId === entry.pageId).baseline.revision, entry.baseline.revision);
  assert.equal(state.writes.length, 1);
});

for (const template of ["article", "recipe"]) {
  test(`${template} accepts attributed quotes in its owned body and retains them on edits`, async context => {
    const body = quoteBody();
    const data = template === "article" ? { body } : {
      introductionBody: body,
      ingredientGroups: [{ name: "", ingredients: [{ rawText: "1 cup rice", quantity: "", unit: "", name: "", parsed: false }] }],
      instructionSections: [{ name: "First", stepBodies: [document(paragraph("Cook the rice."))] }],
      prepTimeMinutes: 0, cookTimeMinutes: 0, servings: 1, recipeCategory: "", recipeCuisine: "", cookingMethod: "",
    };
    const { state, run, workspaceDir, readJson } = await fixture(context, [record({ template, data })]);
    assertSuccess(await run(["pull"]));
    const sourceFile = (await readJson(MANIFEST_FILE)).pages[0].file;
    const authored = await readJson(sourceFile);
    const authoredBody = template === "article" ? authored.data.body : authored.data.introductionBody;
    authoredBody.content[0].content[0].content[0].text = "Edited quotation.";
    await writeFile(path.join(workspaceDir, sourceFile), `${JSON.stringify(authored, null, 2)}\n`);
    assertSuccess(await run(["pages", "push", "story"]));
    const sentData = assertOneWrite(state, "PATCH").body.template[TEMPLATES[template].member];
    const sentBody = template === "article" ? sentData.body : sentData.introductionBody;
    assert.deepEqual(sentBody.content[0].attrs, QUOTE_METADATA);
    assert.equal(sentBody.content[0].content[0].content[0].text, "Edited quotation.");
  });
}
