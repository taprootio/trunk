import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { validateDocument } from "../src/content/index.js";
import { validateWorkspacePageDocument } from "../src/verbs/pages-push.js";

const SITE_ID = "aaaa1111-bbbb-4111-8111-cccc11111111";
const PAGE_ID = "bbbb2222-cccc-4222-8222-dddd22222222";
const IMAGE_ID = "cccc3333-dddd-4333-8333-eeee33333333";
const KEY = "tr_fixture_image_description_roundtrip";
const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] });
const component = (componentType, data) => ({ type: "componentBlock", attrs: { componentType, componentData: JSON.stringify(data) } });

function hydratedBody(defaultText = "Shared default", revision = "3") {
  const image = (mode, text = "") => ({
    imageId: IMAGE_ID, src: "https://cdn.example.test/640.webp", urls: [{ minWidth: 640, url: "https://cdn.example.test/640.webp" }],
    width: 1200, height: 800, alt: mode === "inherit" ? defaultText : text,
    ...(mode === undefined ? {} : { descriptionMode: mode }), defaultDescription: defaultText, descriptionRevision: revision,
  });
  return { type: "doc", content: [
    paragraph("Before editing"),
    { type: "taprootImage", attrs: image("inherit") },
    { type: "taprootImage", attrs: image("custom", "Inline context") },
    { type: "taprootImage", attrs: image("decorative") },
    { type: "taprootImage", attrs: image(undefined, "Legacy inline text") },
    component("image-banner", { image: image("inherit"), altText: defaultText, descriptionMode: "inherit",
      defaultDescription: defaultText, descriptionRevision: revision, overlayText: "Visible banner heading" }),
    component("hero-section", { title: "Hero", primaryAction: { label: "Read", url: "/story" }, media: image("decorative") }),
    component("cta", { mediaImage: image("custom", "CTA context") }),
    component("feature-grid", { items: [{ title: "Feature", icon: image("inherit") }] }),
    component("testimonial", { items: [{ quote: "A review", authorName: "Reader", authorImage: image("custom", "Portrait context") }] }),
    component("card-grid", { cards: [{ title: "Card", image: image("inherit") }] }),
    { type: "section", attrs: {
      background: { image: image("inherit"), portraitImage: image("custom", "Narrow background context") },
      decoration: { image: image("decorative") },
    }, content: [paragraph("Section content")] },
  ] };
}

async function fixture(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "taproot-image-roundtrip-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const workspaceDir = path.join(project, "site");
  const configHome = path.join(root, "config-home");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(path.join(configHome, "taproot-site"), { recursive: true });
  await writeFile(path.join(project, "taproot-site.json"), JSON.stringify({ configVersion: 1, siteId: SITE_ID,
    authoringSurface: "standard", workspaceDir: "site" }));
  await writeFile(path.join(configHome, "taproot-site", "settings.json"), JSON.stringify({ schemaVersion: 1,
    apiBaseUrl: "https://app.taproot.test/api" }));
  const state = { body: hydratedBody(), writes: [], calls: [] };
  const summary = () => ({ pageId: PAGE_ID, resourceId: PAGE_ID, title: "Story", path: "story",
    templateType: "TEMPLATE_TYPE_FREE_FORM", status: "PAGE_STATUS_DRAFT", hasDraft: true,
    bodyRevision: `sha256:${"a".repeat(64)}` });
  const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    const method = options.method ?? "GET";
    assert.equal(new Headers(options.headers).get("authorization"), `Bearer ${KEY}`);
    state.calls.push({ method, pathname });
    if (method === "GET" && pathname === `/api/v1/pages/by_site/${SITE_ID}`) return reply({ pages: [summary()] });
    if (method === "GET" && pathname === `/api/v1/pages/${PAGE_ID}`) return reply({ ...summary(),
      template: { templateType: "TEMPLATE_TYPE_FREE_FORM", freeFormData: { body: state.body } } });
    if (method === "PATCH" && pathname === `/api/v1/pages/${PAGE_ID}`) {
      state.writes.push(JSON.parse(options.body));
      return reply({ ...summary(), bodyRevision: `sha256:${"b".repeat(64)}` });
    }
    if (method === "GET" && pathname === `/api/v1/sites/${SITE_ID}/navigation`) return reply({ navItems: [], revision: "e".repeat(64) });
    if (method === "GET" && pathname === `/api/v1/sites/${SITE_ID}/authors`) return reply({ authors: [], members: [] });
    if (method === "GET" && pathname === `/api/v1/sites/${SITE_ID}/redirects`) return reply({ code: 5 }, 404);
    if (method === "GET" && (pathname === `/api/v1/sites/${SITE_ID}/presentation` || pathname.startsWith("/api/v1/settings/"))) return reply({ code: 7 }, 403);
    throw new Error(`Unexpected image roundtrip request: ${method} ${pathname}`);
  };
  const run = async arguments_ => {
    let stdout = "";
    let stderr = "";
    const exit = await runCli({ arguments_, cwd: project, fetch,
      environment: { XDG_CONFIG_HOME: configHome, HOME: configHome, TAPROOT_SITE_KEY: KEY },
      stdout: { write: chunk => stdout += chunk }, stderr: { write: chunk => stderr += chunk },
    });
    return { exit, result: JSON.parse(stdout), stderr };
  };
  return { state, run, workspaceDir };
}

function assertAuthoredImages(document) {
  const inline = document.content.filter(node => node.type === "taprootImage").map(node => node.attrs);
  assert.deepEqual(inline.map(image => [image.descriptionMode, image.alt]), [
    ["inherit", undefined], ["custom", "Inline context"], ["decorative", ""], [undefined, "Legacy inline text"],
  ]);
  const blocks = Object.fromEntries(document.content.filter(node => node.type === "componentBlock")
    .map(node => [node.attrs.componentType, JSON.parse(node.attrs.componentData)]));
  assert.equal(blocks["image-banner"].overlayText, "Visible banner heading");
  assert.equal(Object.hasOwn(blocks["image-banner"], "altText"), false);
  const images = [...inline, blocks["image-banner"].image, blocks["hero-section"].media, blocks.cta.mediaImage,
    blocks["feature-grid"].items[0].icon, blocks.testimonial.items[0].authorImage, blocks["card-grid"].cards[0].image];
  assert.equal(blocks.cta.mediaImage.alt, "CTA context");
  assert.equal(blocks.testimonial.items[0].authorImage.alt, "Portrait context");
  assert.equal(blocks["hero-section"].media.alt, "");
  const section = document.content.find(node => node.type === "section");
  images.push(section.attrs.background.image, section.attrs.background.portraitImage, section.attrs.decoration.image);
  assert.equal(section.attrs.background.portraitImage.alt, "Narrow background context");
  assert.equal(section.attrs.decoration.image.alt, "");
  for (const image of images) {
    assert.equal(Object.hasOwn(image, "defaultDescription"), false);
    assert.equal(Object.hasOwn(image, "descriptionRevision"), false);
    if (image.descriptionMode === "inherit") assert.equal(Object.hasOwn(image, "alt"), false);
  }
}

test("pull, validate and push keep inline, component and section descriptions authored while defaults change", async context => {
  const { state, run, workspaceDir } = await fixture(context);
  const pulled = await run(["pull"]);
  assert.equal(pulled.exit, 0, JSON.stringify(pulled));
  const manifestFile = path.join(workspaceDir, ".taproot-site-manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const file = manifest.pages[0].file;
  const sourceFile = path.join(workspaceDir, file);
  const firstBytes = await readFile(sourceFile, "utf8");
  const document = JSON.parse(firstBytes);
  assertAuthoredImages(document);
  assert.deepEqual(validateDocument(document).errors, []);
  await validateWorkspacePageDocument({ workspaceDir, siteId: SITE_ID, file, document });

  state.body = hydratedBody("A later shared default", "4");
  const refreshed = await run(["pull"]);
  assert.equal(refreshed.exit, 0, JSON.stringify(refreshed));
  assert.equal(await readFile(sourceFile, "utf8"), firstBytes);
  const nextManifest = JSON.parse(await readFile(manifestFile, "utf8"));
  assert.equal(nextManifest.pages[0].baseline.remoteHash, manifest.pages[0].baseline.remoteHash);
  document.content[0].content[0].text = "An unrelated author edit";
  await writeFile(sourceFile, JSON.stringify(document));
  const pushed = await run(["pages", "push", "story"]);
  assert.equal(pushed.exit, 0, JSON.stringify(pushed));
  assert.equal(state.writes.length, 1);
  const sent = state.writes[0].template.freeFormData.body;
  assert.deepEqual(validateDocument(sent).errors, []);
  assertAuthoredImages(sent);
  assert.equal(sent.content[0].content[0].text, "An unrelated author edit");
});
