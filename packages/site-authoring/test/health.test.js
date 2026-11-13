import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getSiteHealth, listSiteImagesByIds } from "../src/api.js";
import { runCli } from "../src/cli.js";
import { SiteApiClient } from "../src/transport.js";
import { collectPlacementAlts } from "../src/verbs/health.js";
import { sanitizeDiagnostic } from "../src/errors.js";
import {
  buildImageFinding,
  MAXIMUM_AFFECTED_PAGES,
  shellQuote,
  usableDescription,
} from "../src/site-health-findings.js";
import rules from "../src/site-check-rules.json" with { type: "json" };
import { remedyForRule, SITE_CHECK_REMEDIES } from "../src/site-check-findings.js";

const IMAGE_ID = "cccc3333-dddd-4333-8333-eeee33333333";
const OTHER_IMAGE_ID = "dddd4444-eeee-4444-8444-ffff44444444";
const SITE_ID = "aaaa1111-bbbb-4111-8111-cccc11111111";

const pages = (count = 1) => Array.from({ length: count }, (_, index) => ({ path: `/p${index}`, title: `Page ${index}`, file: `pages/p${index}.md` }));
const image = (overrides = {}) => ({
  imageId: IMAGE_ID, name: "Bird.webp", descriptionRevision: "3", hasDefault: false, available: true,
  alts: [], affectedPages: pages(), ...overrides,
});

test("every rule the stored report can raise has a remedy, and an unknown rule gets one sentence", () => {
  const healthRules = rules.rules.filter((rule) => rule.runsAt.includes("health")).map((rule) => rule.id);
  assert.ok(healthRules.length > 0);
  for (const ruleId of healthRules) {
    assert.ok(Object.hasOwn(SITE_CHECK_REMEDIES, ruleId), `${ruleId} has no remedy`);
    assert.ok(SITE_CHECK_REMEDIES[ruleId].length > 0);
  }
  // A page fix reaches the release's report only through a push, an approval and another staging.
  for (const ruleId of healthRules.filter((id) => id !== "a11y.image_default_missing")) {
    assert.match(SITE_CHECK_REMEDIES[ruleId], /taproot-site pages push.*taproot-site approve.*taproot-site deploy --staging/u, ruleId);
  }
  const unknown = remedyForRule("future.rule_id");
  assert.match(unknown, /future\.rule_id/u);
  assert.match(unknown, /Site Health page/u);
});

test("a suggestion is usable only when it is safe to run and the server accepts it", () => {
  assert.equal(usableDescription("  A bird in flight  "), "A bird in flight");
  assert.equal(usableDescription("x".repeat(1000)), "x".repeat(1000));
  assert.equal(usableDescription("😀".repeat(1000)), "😀".repeat(1000));
  for (const text of ["", "   ", "x".repeat(1001), "😀".repeat(1001), "lone \ud800 surrogate", "two\nlines", "tab\tinside", "bell\u0007", "line separator", undefined, 3]) {
    assert.equal(usableDescription(text), undefined, JSON.stringify(text));
  }
});

test("a description is usable only if the printed command is whole and identical to the JSON one", async (context) => {
  await context.test("bidi overrides and isolates are refused, because the printed copy would lose them", () => {
    for (const text of ["A \u202Ebird", "\u2066bird\u2069", "bird \u202D"]) assert.equal(usableDescription(text), undefined, JSON.stringify(text));
  });
  await context.test("zero-width joiners in an emoji sequence are kept", () => {
    assert.equal(usableDescription("Family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}"), "Family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}");
  });
  await context.test("decomposed text is normalized so the printed and JSON commands match", () => {
    assert.equal(usableDescription("Cafe\u0301"), "Caf\u00e9");
  });
  await context.test("an apostrophe-heavy description is used whole when it fits and refused when it would be cut", () => {
    const fits = "it's ".repeat(60).trim();
    const finding = buildImageFinding(image({ alts: [fits] }));
    assert.equal(finding.suggestedDescription, fits);
    assert.equal(sanitizeDiagnostic(finding.fix, ""), finding.fix);
    assert.match(finding.fix, /--expected-revision 3 --if-missing$/u);
    // 1000 apostrophes are legal to the server but quote to 4000 scalars, which would be cut mid-quote.
    const refused = buildImageFinding(image({ alts: ["'".repeat(1000)] }));
    assert.equal(refused.needsDescription, true);
    assert.equal(Object.hasOwn(refused, "suggestedDescription"), false);
  });
});

test("the image builder decides in the story's order and names an exact, safe fix", async (context) => {
  await context.test("an image the read did not return is unavailable, whatever else is known", () => {
    const finding = buildImageFinding(image({ available: false, descriptionRevision: undefined, alts: ["Alt"] }));
    assert.equal(finding.imageAvailable, false);
    assert.equal(Object.hasOwn(finding, "descriptionRevision"), false);
    assert.equal(Object.hasOwn(finding, "currentlyDescribed"), false);
    assert.match(finding.fix, /Remove it from the pages|replace it/u);
    // Editing the local placement changes nothing on the site until it is pushed, approved and staged.
    assert.match(finding.fix, /taproot-site pages push.*taproot-site approve.*taproot-site deploy --staging/u);
    assert.doesNotMatch(finding.fix, /media images get/u);
  });

  await context.test("a failed read leaves the state unknown and sends the agent to media images get", () => {
    const finding = buildImageFinding(image({ descriptionRevision: undefined, hasDefault: undefined, alts: ["A bird"] }));
    for (const field of ["descriptionRevision", "imageAvailable", "currentlyDescribed"]) {
      assert.equal(Object.hasOwn(finding, field), false, field);
    }
    assert.equal(finding.suggestedDescription, "A bird");
    assert.match(finding.fix, new RegExp(`media images get ${IMAGE_ID}`, "u"));
    assert.equal(buildImageFinding(image({ descriptionRevision: undefined, alts: [] })).needsDescription, true);
  });

  await context.test("an undescribed image with a usable alt gets the runnable command with its revision", () => {
    const finding = buildImageFinding(image({ alts: ["A bird"] }));
    assert.equal(finding.imageAvailable, true);
    assert.equal(finding.currentlyDescribed, false);
    assert.equal(finding.descriptionRevision, "3");
    assert.equal(finding.suggestedDescription, "A bird");
    assert.equal(
      finding.fix,
      `taproot-site media images describe ${IMAGE_ID} --description='A bird' --expected-revision 3 --if-missing`,
    );
    assert.equal(Object.hasOwn(finding, "needsDescription"), false);
  });

  await context.test("the first usable alt is the suggestion, and unusable ones are skipped", () => {
    const finding = buildImageFinding(image({ alts: ["x".repeat(1001), "two\nlines", "Third"] }));
    assert.equal(finding.suggestedDescription, "Third");
  });

  await context.test("with no usable alt the fix is a sentence with no command and no placeholder", () => {
    for (const alts of [[], ["   "], ["x".repeat(1001)], ["two\nlines"], ["lone \ud800"]]) {
      const finding = buildImageFinding(image({ alts }));
      assert.equal(finding.needsDescription, true);
      assert.match(finding.fix, /deploy --staging/u);
      assert.equal(Object.hasOwn(finding, "suggestedDescription"), false);
      assert.doesNotMatch(finding.fix, /--description=|<|'/u);
    }
  });

  await context.test("production's fixes say the report changes once the owner promotes the release", () => {
    const promotion = /production's report updates once the owner promotes that release\.$/u;
    for (const overrides of [
      { available: false, descriptionRevision: undefined },
      { descriptionRevision: undefined, alts: ["A bird"] },
      { alts: [] },
      { hasDefault: true },
    ]) {
      assert.match(buildImageFinding(image({ ...overrides, environment: "production" })).fix, promotion, JSON.stringify(overrides));
      // Staging and the pre-staging read have no promotion to wait for.
      assert.doesNotMatch(buildImageFinding(image({ ...overrides, environment: "staging" })).fix, /promotes/u);
      assert.doesNotMatch(buildImageFinding(image(overrides)).fix, /promotes/u);
    }
  });

  await context.test("an already described image points at a deploy, with production's own wording", () => {
    const staging = buildImageFinding(image({ hasDefault: true, alts: ["A bird"], environment: "staging" }));
    assert.equal(staging.currentlyDescribed, true);
    assert.match(staging.fix, /deploy --staging/u);
    assert.equal(Object.hasOwn(staging, "suggestedDescription"), false);
    const production = buildImageFinding(image({ hasDefault: true, environment: "production" }));
    assert.equal(production.currentlyDescribed, true);
    assert.match(production.fix, /deploy --staging.*promotes/u);
  });

  await context.test("affected pages are capped at ten with the full count", () => {
    const finding = buildImageFinding(image({ affectedPages: pages(300) }));
    assert.equal(finding.affectedPages.length, MAXIMUM_AFFECTED_PAGES);
    assert.equal(finding.affectedPageCount, 300);
    assert.equal(Object.hasOwn(finding, "previewUrl"), false);
  });
});

/** Splits a printed command the way a POSIX shell does, so the test runs the text an agent would run. */
function shellWords(command) {
  const output = execFileSync("/bin/sh", ["-c", `set -- ${command}; for word in "$@"; do printf '%s\\0' "$word"; done`], { encoding: "utf8" });
  return output.split("\0").slice(0, -1);
}

test("the printed command round-trips through a shell and the CLI's own parser", async (context) => {
  for (const alt of ["It's a bird", "--looks like a flag", "a 'quoted' \"double\" $HOME `tick` \\ back", "Ünïcode 😀", "''"]) {
    await context.test(alt, async () => {
      const finding = buildImageFinding(image({ alts: [alt], descriptionRevision: "9223372036854775807" }));
      const [binary, ...words] = shellWords(finding.fix);
      assert.equal(binary, "taproot-site");
      let received;
      const exit = await runCli({
        arguments_: words, environment: {}, stdout: { write() {} }, stderr: { write() {} },
        handlers: { "media images describe": async (invocation) => { received = invocation; return { ok: true }; } },
      });
      assert.equal(exit, 0);
      assert.equal(received.imageId, IMAGE_ID);
      assert.equal(received.imageDescription, alt.trim());
      assert.equal(received.expectedRevision, "9223372036854775807");
      assert.equal(received.onlyIfMissing, true);
    });
  }
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

async function workspace(context, files) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "taproot-health-alts-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, typeof contents === "string" ? contents : JSON.stringify(contents));
  }
  return root;
}

const markdown = (title, pagePath, body) => `---\ntitle: ${title}\npath: ${pagePath}\n---\n${body}\n`;
const paragraph = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
const media = (...entries) => ({
  mediaManifestVersion: 2, siteId: SITE_ID,
  media: Object.fromEntries(entries.map(([file, imageId, alt = ""]) => [file, { imageId, src: "", urls: [], width: 10, height: 10, alt }])),
  videos: {},
});

test("the alt collector reads the workspace's placed alt text offline, in manifest order", async (context) => {
  const body = (id, mode, alt) => ({
    type: "taprootImage", attrs: { imageId: id, src: "", urls: [], alt, ...(mode === undefined ? {} : { descriptionMode: mode }) },
  });
  const root = await workspace(context, {
    "pages/a.md": markdown("A", "a", "![  A bird in flight  ](media/bird.png)\n\n![Second](media/other.png)"),
    "pages/b.md": markdown("B", "b", "![A bird in flight](media/bird.png)\n\n![](media/other.png)"),
    "pages/c.pm.json": { type: "doc", content: [
      paragraph("Hello"),
      body(IMAGE_ID, "custom", "From custom"),
      body(IMAGE_ID, "inherit", "Stale hydrated default"),
      body(IMAGE_ID, "decorative", "Ignored"),
      body(OTHER_IMAGE_ID.toUpperCase(), undefined, "Unset mode counts"),
    ] },
    "pages/broken.md": "---\ntitle: Broken\npath: broken\n---\n![x](media/missing.png)\n",
  });
  const manifest = { pages: [
    { file: "pages/a.md", pageId: "11111111-1111-4111-8111-111111111111", path: "a", title: "A" },
    { file: "pages/b.md", pageId: "22222222-2222-4222-8222-222222222222", path: "b", title: "B" },
    { file: "pages/c.pm.json", pageId: "33333333-3333-4333-8333-333333333333", path: "c", title: "C" },
    { file: "pages/broken.md", pageId: "44444444-4444-4444-8444-444444444444", path: "broken", title: "Broken" },
    { pageId: "55555555-5555-4555-8555-555555555555", path: "legal", title: "Legal", workspaceMode: "metadata-only" },
  ] };
  const mediaManifest = media(["media/bird.png", IMAGE_ID], ["media/other.png", OTHER_IMAGE_ID]);

  const alts = await collectPlacementAlts({ workspaceDir: root, manifest, mediaManifest });
  // Trimmed, distinct, in manifest order; inherit and decorative placements are skipped, and a page that fails to
  // convert contributes nothing without failing the read.
  assert.deepEqual(alts.get(IMAGE_ID), ["A bird in flight", "From custom"]);
  assert.deepEqual(alts.get(OTHER_IMAGE_ID), ["Second", "Unset mode counts"]);
  assert.equal(alts.size, 2);

  // An explicit file list limits what is read, and may name a file the manifest does not track.
  const only = await collectPlacementAlts({ workspaceDir: root, manifest: { pages: [] }, mediaManifest, files: ["pages/b.md"] });
  assert.deepEqual([...only.keys()], [IMAGE_ID]);
  assert.deepEqual(only.get(IMAGE_ID), ["A bird in flight"]);
});

test("a banner's image is described by the banner's own text and mode, never by its stored alt", async (context) => {
  const banner = (data) => ({
    type: "componentBlock",
    attrs: { componentType: "image-banner", componentData: JSON.stringify({ overlayText: "Heading", ...data }) },
  });
  const stored = (alt, extra = {}) => ({ imageId: IMAGE_ID, src: "", urls: [], alt, ...extra });
  const cases = [
    // The nested image keeps a stale hydrated alt; the parent's mode decides whether anything is placed.
    ["inherit", banner({ descriptionMode: "inherit", altText: "Stale parent", image: stored("Stale nested") }), undefined],
    ["decorative", banner({ descriptionMode: "decorative", altText: "", image: stored("Stale nested") }), undefined],
    ["custom", banner({ descriptionMode: "custom", altText: "Banner alt", image: stored("Stale nested") }), "Banner alt"],
    ["a mode only on the nested image", banner({ altText: "Banner alt", image: stored("Stale nested", { descriptionMode: "inherit" }) }), undefined],
  ];
  for (const [name, block, expected] of cases) {
    await context.test(name, async (child) => {
      const root = await workspace(child, { "pages/a.pm.json": { type: "doc", content: [paragraph("Hello"), block] } });
      const manifest = { pages: [{ file: "pages/a.pm.json", pageId: "11111111-1111-4111-8111-111111111111", path: "a", title: "A" }] };
      const alts = await collectPlacementAlts({ workspaceDir: root, manifest, mediaManifest: media() });
      assert.deepEqual(alts.get(IMAGE_ID), expected === undefined ? undefined : [expected]);
    });
  }
});

/** A ProseMirror source whose attributes nest deep enough to overflow a recursive walk, with one placed image. */
const deepSource = () => {
  const depth = 20_000;
  return `{"type":"doc","content":[{"type":"paragraph","attrs":{"deep":${"[".repeat(depth)}${"]".repeat(depth)}}},`
    + `{"type":"taprootImage","attrs":{"imageId":"${IMAGE_ID}","src":"","urls":[],"alt":"Deep alt"}}]}`;
};

test("a page that converts but cannot be walked contributes nothing, and the others still count", async (context) => {
  const root = await workspace(context, {
    "pages/deep.pm.json": deepSource(),
    "pages/ok.md": markdown("Ok", "ok", "![Fine alt](media/bird.png)"),
  });
  const manifest = { pages: [
    { file: "pages/deep.pm.json", pageId: "11111111-1111-4111-8111-111111111111", path: "deep", title: "Deep" },
    { file: "pages/ok.md", pageId: "22222222-2222-4222-8222-222222222222", path: "ok", title: "Ok" },
  ] };
  const alts = await collectPlacementAlts({ workspaceDir: root, manifest, mediaManifest: media(["media/bird.png", IMAGE_ID]) });
  assert.deepEqual(alts.get(IMAGE_ID), ["Fine alt"]);
});

test("without a media manifest record, a Markdown page contributes nothing and does not fail", async (context) => {
  const root = await workspace(context, { "pages/a.md": markdown("A", "a", "![Alt](media/bird.png)") });
  const manifest = { pages: [{ file: "pages/a.md", pageId: "11111111-1111-4111-8111-111111111111", path: "a", title: "A" }] };
  const alts = await collectPlacementAlts({ workspaceDir: root, manifest, mediaManifest: media() });
  assert.equal(alts.size, 0);
});

const KEY = "tr_health_test_site_key";
const API_BASE_URL = "https://app.taproot.test/api";
const uuid = (number) => `${String(number).padStart(8, "0")}-0000-4000-8000-000000000000`;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/** A client whose requests go to `handler(url, calls)`, with every request recorded. */
function clientFor(handler, extra = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const target = new URL(url);
    calls.push({ method: init.method ?? "GET", pathname: target.pathname, query: target.searchParams });
    return await handler(target, calls);
  };
  return { calls, client: new SiteApiClient({ apiBaseUrl: API_BASE_URL, token: KEY, fetch, sleep: async () => {}, ...extra }) };
}

const wireImage = (imageId, overrides = {}) => ({
  image: {
    imageId, siteId: SITE_ID, ownershipScope: "IMAGE_OWNERSHIP_SCOPE_SITE", uploadedName: `${imageId.slice(0, 4)}.webp`,
    width: 10, height: 10, defaultDescription: "", descriptionRevision: "4", url: "https://static.test/a.webp",
    responsiveUrls: [], processingState: "IMAGE_PROCESSING_STATE_COMPLETE", ...overrides,
  },
});

test("a staged health read sends the deployment id, and a production read sends none", async () => {
  const { client, calls } = clientFor(() => json({ status: "not_checked" }));
  await getSiteHealth(client, SITE_ID);
  await getSiteHealth(client, SITE_ID, { deploymentId: uuid(7) });
  assert.deepEqual(calls.map((call) => call.query.get("deploymentId")), [null, uuid(7)]);
  assert.ok(calls.every((call) => call.pathname === `/api/v1/sites/${SITE_ID}/health`));
});

test("the image reader sends each id once, in batches of 100, and returns what each image holds", async () => {
  const ids = Array.from({ length: 101 }, (_, index) => uuid(index + 1));
  const { client, calls } = clientFor((url) => {
    const asked = url.searchParams.getAll("imageIds");
    // An empty default arrives as "", a null one as null, and a missing image is simply not returned.
    return json({ images: asked.filter((id) => id !== uuid(3)).map((id) => wireImage(id, {
      defaultDescription: id === uuid(1) ? "Described" : id === uuid(2) ? null : "",
    })) });
  });
  const read = await listSiteImagesByIds(client, SITE_ID, [...ids, ...ids, uuid(1)]);
  assert.deepEqual(calls.map((call) => call.query.getAll("imageIds").length), [100, 1]);
  // Only library images can be described, so the read never asks for posters or other owned media.
  assert.deepEqual(calls.map((call) => call.query.get("libraryOnly")), ["true", "true"]);
  assert.deepEqual(calls.map((call) => call.query.has("pageSize") || call.query.has("pageToken")), [false, false]);
  assert.equal(read.images.length, 100);
  assert.deepEqual(read.failedIds, []);
  assert.deepEqual(read.refusalKinds, []);
  assert.equal(Object.hasOwn(read, "refusalError"), false);
  const byId = new Map(read.images.map((entry) => [entry.imageId, entry]));
  assert.equal(byId.get(uuid(1)).defaultDescription, "Described");
  assert.equal(byId.get(uuid(1)).descriptionRevision, "4");
  assert.equal(Object.hasOwn(byId.get(uuid(2)), "defaultDescription"), false);
  assert.equal(Object.hasOwn(byId.get(uuid(4)), "defaultDescription"), false);
  assert.equal(byId.has(uuid(3)), false);
  assert.equal(byId.get(uuid(4)).name, `${uuid(4).slice(0, 4)}.webp`);
});

test("an empty id list makes no request", async () => {
  const { client, calls } = clientFor(() => json({}));
  assert.deepEqual(await listSiteImagesByIds(client, SITE_ID, []), { images: [], failedIds: [], refusalKinds: [] });
  assert.equal(calls.length, 0);
});

test("a failed or denied batch is reported without stopping the next, and a rejected credential is kept to rethrow", async (context) => {
  const ids = Array.from({ length: 150 }, (_, index) => uuid(index + 1));
  const failing = (status, body) => clientFor((url, calls) =>
    calls.length === 1 ? json(body, status) : json({ images: url.searchParams.getAll("imageIds").map((id) => wireImage(id)) }));

  await context.test("a denied read adds its refusal kind and no refusal error", async () => {
    const { client } = failing(403, { code: 7, message: "denied", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SITE_AUTHORING_CAPABILITY_MISSING", domain: "taproot-site-authoring", metadata: { permission: "site.media.manage", granted: "site.pages.edit_any", required: "site.media.manage" } }] });
    const read = await listSiteImagesByIds(client, SITE_ID, ids);
    assert.deepEqual(read.failedIds, ids.slice(0, 100));
    assert.equal(read.images.length, 50);
    assert.deepEqual(read.refusalKinds, ["capability_missing"]);
    assert.equal(Object.hasOwn(read, "refusalError"), false);
  });
  await context.test("a rejected credential is returned as the error to rethrow", async () => {
    const { client } = failing(401, { code: 16, message: "no" });
    const read = await listSiteImagesByIds(client, SITE_ID, ids);
    assert.deepEqual(read.refusalKinds, ["credential_rejected"]);
    assert.equal(read.refusalError.refusalKind(), "credential_rejected");
  });
  await context.test("an outdated CLI is returned as the error to rethrow", async () => {
    const { client } = failing(400, { code: 3, message: "old", details: [{ fieldViolations: [{ field: "CliUpgradeRequired", description: "old" }] }] });
    const read = await listSiteImagesByIds(client, SITE_ID, ids);
    assert.deepEqual(read.refusalKinds, ["cli_outdated"]);
    assert.equal(read.refusalError.refusalKind(), "cli_outdated");
  });
  await context.test("a response that breaks the contract fails its batch and adds no refusal kind", async () => {
    const { client } = failing(200, { images: [{ image: { imageId: "not-an-image" } }] });
    const read = await listSiteImagesByIds(client, SITE_ID, ids);
    assert.deepEqual(read.failedIds, ids.slice(0, 100));
    assert.deepEqual(read.refusalKinds, []);
    assert.equal(read.images.length, 50);
  });
});

test("a cancelled run is rethrown, never counted as a failed batch", async () => {
  const controller = new AbortController();
  const { client } = clientFor(() => {
    controller.abort();
    return new Promise(() => {});
  }, { signal: controller.signal });
  await assert.rejects(listSiteImagesByIds(client, SITE_ID, [uuid(1)]), (error) => error.code === "site.cancelled");
});

// ---------------------------------------------------------------------------
// The verb, over a real HTTP fixture server.
// ---------------------------------------------------------------------------

const PROD_DEPLOYMENT = uuid(101);
const STAGED_DEPLOYMENT = uuid(102);
const PROD_OUTPUT = uuid(103);
const STAGED_OUTPUT = uuid(104);
const PAGE_A = uuid(201);
const PAGE_B = uuid(202);
const PAGE_C = uuid(203);
const CHECKED_AT = "2026-11-12T12:00:00.000Z";
const COVERAGE = ["metadata", "links", "image_defaults"];

function report(overrides = {}) {
  const staged = overrides.environment === "staging";
  return {
    status: "complete", deploymentId: staged ? STAGED_DEPLOYMENT : PROD_DEPLOYMENT,
    outputReleaseId: staged ? STAGED_OUTPUT : PROD_OUTPUT, inputHash: "a".repeat(64), checkedAt: CHECKED_AT,
    ruleVersion: "2", coverage: COVERAGE, assessedPageCount: 3, environment: "production", ...overrides,
  };
}
const pageFinding = (overrides = {}) => ({
  ruleId: "seo.description_missing", severity: "SITE_FINDING_SEVERITY_WARNING", pageId: PAGE_A, pageTitle: "About",
  pagePath: "about", subject: "", ...overrides,
});
const imageFinding = (imageId, pageIds = [PAGE_A], overrides = {}) => ({
  imageId, name: `${imageId.slice(0, 4)}.webp`, previewUrl: "https://static.test/preview.webp?sig=secret",
  affectedPages: pageIds.map((pageId, index) => ({ pageId, title: `Page ${index}`, path: `page-${index}` })), ...overrides,
});
/** A report with consistent totals: every non-error finding and every image finding is one warning. */
const withTotals = (value) => ({
  ...value,
  warningCount: (value.findings ?? []).length + (value.images ?? []).length,
  pageCount: new Set((value.findings ?? []).map((finding) => finding.pageId)).size,
});

const MANIFEST = {
  manifestVersion: 7, siteId: SITE_ID,
  pages: [
    { file: "pages/about.md", pageId: PAGE_A, path: "about", title: "About", workspaceMode: "editable" },
    { file: "pages/review.md", pageId: PAGE_B, path: "review", title: "Review", workspaceMode: "editable" },
    { pageId: PAGE_C, path: "terms", title: "Terms", workspaceMode: "metadata-only" },
  ],
};

async function fixture(context, { files = {}, config = {}, production = report(), staged, images = new Map() } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "taproot-health-verb-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const configHome = path.join(root, "config-home");
  await mkdir(path.join(project, "site"), { recursive: true });
  await mkdir(path.join(configHome, "taproot-site"), { recursive: true });
  await writeFile(path.join(project, "taproot-site.json"), JSON.stringify({
    configVersion: 1, siteId: SITE_ID, authoringSurface: "standard", workspaceDir: "site", ...config,
  }));
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(project, "site", ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, typeof contents === "string" ? contents : JSON.stringify(contents));
  }
  // `images` maps an image id to its stored { defaultDescription, descriptionRevision }; any id not in it is "deleted".
  const state = { production, staged, images, calls: [], healthFailure: undefined, imageFailure: undefined };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const reply = (status, value) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    state.calls.push({ method: request.method, pathname: url.pathname, query: url.searchParams });
    if (request.headers.authorization !== `Bearer ${KEY}`) return reply(401, { code: 16 });
    const base = `/api/v1/sites/${SITE_ID}`;
    if (request.method === "GET" && url.pathname === `${base}/health`) {
      const deploymentId = url.searchParams.get("deploymentId");
      const failure = state.healthFailure?.(deploymentId);
      if (failure !== undefined) return reply(failure, { code: 7, message: "denied" });
      if (deploymentId === null) return reply(200, state.production);
      return reply(200, typeof state.staged === "function" ? state.staged(deploymentId) : state.staged ?? { status: "not_checked" });
    }
    if (request.method === "GET" && url.pathname === `${base}/images`) {
      if (state.imageFailure !== undefined) return reply(state.imageFailure, { code: 7, message: "denied" });
      const asked = url.searchParams.getAll("imageIds");
      return reply(200, { images: asked.filter((id) => state.images.has(id)).map((id) => wireImage(id, state.images.get(id))) });
    }
    return reply(404, { code: 5 });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  await writeFile(path.join(configHome, "taproot-site", "settings.json"), JSON.stringify({
    schemaVersion: 1, apiBaseUrl: `http://127.0.0.1:${server.address().port}/api`,
  }));
  const run = async (arguments_, extraEnvironment = {}) => {
    let stdout = "";
    let stderr = "";
    state.calls.length = 0;
    const exit = await runCli({
      arguments_, cwd: project,
      environment: { XDG_CONFIG_HOME: configHome, HOME: configHome, TAPROOT_SITE_KEY: KEY, ...extraEnvironment },
      stdout: { write: (chunk) => { stdout += chunk; } }, stderr: { write: (chunk) => { stderr += chunk; } },
    });
    return { exit, result: JSON.parse(stdout), stdout, stderr, calls: [...state.calls] };
  };
  return { state, run, root, project };
}

const sequence = (calls) => calls.map((call) =>
  call.pathname.endsWith("/health") ? `health:${call.query.get("deploymentId") ?? "production"}` : call.pathname.split("/").pop());

const FILES = {
  ".taproot-site-manifest.json": MANIFEST,
  "pages/about.md": markdown("About", "about", "![Bird in flight](media/bird.png)"),
  "pages/review.md": markdown("Review", "review", "![Other bird](media/bird.png)\n\n![Heron](media/heron.png)"),
  ".taproot-site-media.json": media(["media/bird.png", uuid(1)], ["media/heron.png", uuid(2)]),
};

test("health --production reports the stored report, a tracked file for each finding, and exits 0 with warnings", async (context) => {
  const { run } = await fixture(context, {
    files: FILES,
    production: withTotals(report({
      findings: [pageFinding(), pageFinding({ ruleId: "link.page_missing", pageId: PAGE_C, pageTitle: "Terms", pagePath: "terms", subject: "/gone" })],
      images: [imageFinding(uuid(1), [PAGE_A, PAGE_B])],
      stagedDeploymentId: STAGED_DEPLOYMENT,
    })),
    images: new Map([[uuid(1), { defaultDescription: "", descriptionRevision: "7" }]]),
  });
  const { exit, result, calls, stderr, stdout } = await run(["health", "--production", "--json"]);
  assert.equal(exit, 0, stderr);
  assert.equal(result.ok, true);
  assert.equal(result.verb, "health");
  assert.equal(result.available, true);
  assert.equal(result.status, "complete");
  assert.equal(result.environment, "production");
  assert.equal(result.deploymentId, PROD_DEPLOYMENT);
  assert.equal(result.outputReleaseId, PROD_OUTPUT);
  assert.equal(result.ruleVersion, "2");
  assert.deepEqual(result.coverage, COVERAGE);
  assert.equal(result.assessedPageCount, 3);
  assert.equal(result.errorCount, 0);
  assert.equal(result.warningCount, 3);
  assert.equal(result.truncated, false);
  assert.equal(result.unpublishedChangesAssessed, false);
  assert.equal(result.findingsTotal, 2);
  assert.equal(result.imageFindingsTotal, 1);
  assert.equal(Object.hasOwn(result, "comparison"), false);
  // A tracked page resolves to its workspace file; a metadata-only page has none.
  assert.deepEqual(result.findings.map((finding) => [finding.rule, finding.path, finding.file]), [
    ["seo.description_missing", "about", "pages/about.md"],
    ["link.page_missing", "terms", undefined],
  ]);
  assert.ok(result.findings.every((finding) => typeof finding.fix === "string" && finding.fix.length > 0));
  assert.ok(result.findings.every((finding) => !Object.hasOwn(finding, "newSinceProduction")));
  assert.deepEqual(result.imageFindings[0].affectedPages.map((page) => page.file), ["pages/about.md", "pages/review.md"]);
  // The preview URL is a signed link: it is never copied into a finding.
  assert.doesNotMatch(stdout, /previewUrl|preview\.webp|secret/u);
  // One production read, then the batched image read, and nothing else.
  assert.deepEqual(sequence(calls), ["health:production", "images"]);
});

test("a page finding's fix says production's report changes only once promoted", async (context) => {
  const { run } = await fixture(context, {
    files: FILES,
    production: withTotals(report({ findings: [pageFinding()], stagedDeploymentId: STAGED_DEPLOYMENT })),
    staged: withTotals(report({ environment: "staging", findings: [pageFinding()] })),
  });
  const production = await run(["health", "--production"]);
  assert.match(production.result.findings[0].fix, /taproot-site deploy --staging to refresh the report; production's report updates once the owner promotes that release\.$/u);
  const staging = await run(["health", "--staging"]);
  assert.match(staging.result.findings[0].fix, /refresh the report\.$/u);
});

test("the image fix carries the revision from the batched read and the alt text the page places", async (context) => {
  const { run } = await fixture(context, {
    files: FILES,
    production: withTotals(report({ images: [imageFinding(uuid(1), [PAGE_A])], stagedDeploymentId: STAGED_DEPLOYMENT })),
    images: new Map([[uuid(1), { defaultDescription: "", descriptionRevision: "7" }]]),
  });
  const { result } = await run(["health", "--production"]);
  const [finding] = result.imageFindings;
  assert.equal(finding.imageId, uuid(1));
  assert.equal(finding.descriptionRevision, "7");
  assert.equal(finding.imageAvailable, true);
  assert.equal(finding.currentlyDescribed, false);
  // Only the affected page's alt counts: pages/review.md also places this image, with a different alt.
  assert.equal(finding.suggestedDescription, "Bird in flight");
  assert.equal(
    finding.fix,
    `taproot-site media images describe ${uuid(1)} --description='Bird in flight' --expected-revision 7 --if-missing`,
  );
  assert.deepEqual(finding.affectedPages, [{ path: "page-0", title: "Page 0", file: "pages/about.md" }]);
});

test("a very long unknown rule id is cut, so the printed fix still equals the JSON fix", async (context) => {
  const { run } = await fixture(context, {
    files: FILES,
    production: withTotals(report({ findings: [pageFinding({ ruleId: `x${"r".repeat(3000)}` })] })),
  });
  const { result, stderr } = await run(["health", "--production"]);
  const [finding] = result.findings;
  assert.ok([...finding.fix].length < 2000);
  assert.ok(stderr.includes(`Fix: ${finding.fix}`));
  assert.ok(stderr.includes(`flagged by the site check '${"x" + "r".repeat(199)}'`));
});

test("what a progress line prints as the fix is exactly the fix in the JSON", async (context) => {
  const { run } = await fixture(context, {
    files: FILES,
    production: withTotals(report({
      findings: [pageFinding(), pageFinding({ ruleId: "x\u001b[2J", subject: "s" })],
      images: [imageFinding(uuid(1), [PAGE_A])],
    })),
    images: new Map([[uuid(1), { descriptionRevision: "7" }]]),
  });
  const { result, stderr } = await run(["health", "--production"]);
  assert.doesNotMatch(stderr, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
  for (const item of [...result.findings, ...result.imageFindings]) {
    assert.ok(stderr.includes(`Fix: ${item.fix}`), item.fix);
  }
  // A rule id this release does not know is printed cleaned, and its remedy carries the cleaned id.
  assert.match(result.findings[1].fix, /rule 'x\[2J'/u);
  assert.match(stderr, /flagged by the site check 'x\[2J'/u);
});

test("health --staging reads production first, then the staged release, and marks what is new", async (context) => {
  const { run } = await fixture(context, {
    files: FILES,
    production: withTotals(report({
      findings: [pageFinding(), pageFinding({ ruleId: "link.page_missing", subject: "/old" })],
      images: [imageFinding(uuid(1), [PAGE_A])], stagedDeploymentId: STAGED_DEPLOYMENT,
    })),
    staged: withTotals(report({
      environment: "staging",
      // The first is unchanged since production; the second is a different subject; the third is another page.
      findings: [pageFinding(), pageFinding({ ruleId: "link.page_missing", subject: "/new" }), pageFinding({ pageId: PAGE_B, pageTitle: "Review", pagePath: "review" })],
      images: [imageFinding(uuid(1), [PAGE_A]), imageFinding(uuid(2), [PAGE_B])],
    })),
    images: new Map([[uuid(1), { descriptionRevision: "1" }], [uuid(2), { descriptionRevision: "2" }]]),
  });
  const { exit, result, calls, stderr } = await run(["health", "--staging"]);
  assert.equal(exit, 0, stderr);
  assert.deepEqual(sequence(calls), ["health:production", `health:${STAGED_DEPLOYMENT}`, "images"]);
  assert.equal(result.environment, "staging");
  assert.equal(result.deploymentId, STAGED_DEPLOYMENT);
  assert.equal(result.outputReleaseId, STAGED_OUTPUT);
  assert.deepEqual(result.findings.map((finding) => finding.newSinceProduction), [false, true, true]);
  assert.deepEqual(result.imageFindings.map((finding) => [finding.imageId, finding.newSinceProduction]), [[uuid(1), false], [uuid(2), true]]);
  assert.deepEqual(result.comparison, { comparedTo: "production", compared: true, newFindings: 2, newImageFindings: 1 });
  // The progress names each new warning with its fix, and not the unchanged ones.
  const lines = stderr.split("\n").filter((line) => line.startsWith("Warning:"));
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => line.includes("Fix:")));
});

test("findings are compared by their full subject, not the text cut for display", async (context) => {
  const long = (tail) => `/${"a".repeat(500)}${tail}`;
  const { run } = await fixture(context, {
    files: FILES,
    production: withTotals(report({
      findings: [pageFinding({ ruleId: "link.page_missing", subject: long("-old") })], stagedDeploymentId: STAGED_DEPLOYMENT,
    })),
    staged: withTotals(report({
      environment: "staging",
      // The same link as production, and a different one that shares its first 500 characters.
      findings: [pageFinding({ ruleId: "link.page_missing", subject: long("-old") }), pageFinding({ ruleId: "link.page_missing", subject: long("-new") })],
    })),
  });
  const { result } = await run(["health", "--staging"]);
  assert.deepEqual(result.findings.map((finding) => finding.newSinceProduction), [false, true]);
  assert.ok(result.findings.every((finding) => finding.subject.length <= 400));
  assert.deepEqual(result.comparison, { comparedTo: "production", compared: true, newFindings: 1, newImageFindings: 0 });
});

test("an image's suggestion is the first usable alt in manifest order, whichever finding names a page first", async (context) => {
  // Manifest order is about.md then review.md. The first finding affects only review.md, so a collector fed pages in
  // the order the findings name them would read review.md first and suggest its alt for the bird.
  const { run } = await fixture(context, {
    files: FILES,
    production: withTotals(report({
      images: [imageFinding(uuid(2), [PAGE_B]), imageFinding(uuid(1), [PAGE_A, PAGE_B])],
    })),
    images: new Map([[uuid(1), { descriptionRevision: "1" }], [uuid(2), { descriptionRevision: "1" }]]),
  });
  const { result } = await run(["health", "--production"]);
  const bird = result.imageFindings.find((finding) => finding.imageId === uuid(1));
  assert.equal(bird.suggestedDescription, "Bird in flight");
  assert.equal(result.imageFindings.find((finding) => finding.imageId === uuid(2)).suggestedDescription, "Heron");
});

test("a production report that cannot be compared leaves newSinceProduction out and lists every finding", async (context) => {
  const staged = withTotals(report({ environment: "staging", findings: [pageFinding()] }));
  const cases = [
    ["not checked", { status: "not_checked", stagedDeploymentId: STAGED_DEPLOYMENT }],
    ["truncated", { ...withTotals(report({ findings: [pageFinding()], stagedDeploymentId: STAGED_DEPLOYMENT })), truncated: true, warningCount: 5 }],
    ["incomplete", { ...withTotals(report({ status: "incomplete", findings: [], stagedDeploymentId: STAGED_DEPLOYMENT })) }],
  ];
  for (const [name, production] of cases) {
    await context.test(name, async (child) => {
      const { run } = await fixture(child, { files: FILES, production, staged });
      const { exit, result, stderr } = await run(["health", "--staging"]);
      assert.equal(exit, 0, stderr);
      assert.equal(result.comparison.compared, false);
      assert.equal(typeof result.comparison.reason, "string");
      assert.equal(Object.hasOwn(result.findings[0], "newSinceProduction"), false);
      assert.match(stderr, /not compared/u);
      assert.match(stderr, /Warning: pages\/about\.md/u);
    });
  }
});

test("a release with no stored report says so with a reason, and exits 0", async (context) => {
  await context.test("--staging with no staged assessment makes no second health read", async (child) => {
    const { run } = await fixture(child, { files: FILES, production: report() });
    const { exit, result, calls } = await run(["health", "--staging"]);
    assert.equal(exit, 0);
    assert.equal(result.available, false);
    assert.equal(result.status, "not_checked");
    assert.equal(result.environment, "staging");
    assert.match(result.reason, /deploy --staging/u);
    assert.equal(result.unpublishedChangesAssessed, false);
    assert.deepEqual(sequence(calls), ["health:production"]);
  });
  const unassessed = [
    ["not_checked", { status: "not_checked" }, "not_checked"],
    ["unsupported", { status: "unsupported" }, "unsupported"],
    // A corrupt stored snapshot: incomplete, with no deployment identity.
    ["incomplete without identity", { status: "incomplete" }, "incomplete"],
  ];
  for (const [name, value, status] of unassessed) {
    await context.test(`--production ${name}`, async (child) => {
      const { run } = await fixture(child, { files: FILES, production: value });
      const { exit, result } = await run(["health", "--production"]);
      assert.equal(exit, 0);
      assert.equal(result.available, false);
      assert.equal(result.status, status);
      assert.equal(result.environment, "production");
      assert.equal(Object.hasOwn(result, "findings"), false);
    });
    await context.test(`--staging ${name}`, async (child) => {
      const { run } = await fixture(child, { files: FILES, production: report({ stagedDeploymentId: STAGED_DEPLOYMENT }), staged: value });
      const { exit, result } = await run(["health", "--staging"]);
      assert.equal(exit, 0);
      assert.equal(result.available, false);
      assert.equal(result.status, status);
      assert.equal(result.environment, "staging");
    });
  }
});

test("an incomplete report lists its findings with a note that it is not a pass", async (context) => {
  const { run } = await fixture(context, {
    files: FILES,
    production: withTotals(report({ status: "incomplete", coverage: ["metadata"], findings: [pageFinding()] })),
  });
  const { exit, result, stderr } = await run(["health", "--production"]);
  assert.equal(exit, 0);
  assert.equal(result.available, true);
  assert.equal(result.status, "incomplete");
  assert.match(result.note, /not a pass/u);
  assert.equal(result.findings.length, 1);
  assert.match(stderr, /not a pass/u);
});

test("an image the report names is described, already described, or gone, and each says so", async (context) => {
  const { run } = await fixture(context, {
    files: FILES,
    production: withTotals(report({
      images: [imageFinding(uuid(1)), imageFinding(uuid(2)), imageFinding(uuid(3))], stagedDeploymentId: STAGED_DEPLOYMENT,
    })),
    staged: withTotals(report({ environment: "staging", images: [imageFinding(uuid(1)), imageFinding(uuid(2)), imageFinding(uuid(3))] })),
    // Image 2 was described since the report, and image 3 was deleted.
    images: new Map([[uuid(1), { descriptionRevision: "1" }], [uuid(2), { defaultDescription: "Now described", descriptionRevision: "5" }]]),
  });
  for (const environment of ["staging", "production"]) {
    const { result } = await run(["health", `--${environment}`]);
    const [plain, described, gone] = result.imageFindings;
    assert.equal(plain.imageAvailable, true);
    assert.equal(described.currentlyDescribed, true);
    assert.match(described.fix, environment === "staging" ? /deploy --staging/u : /promotes/u);
    assert.equal(gone.imageAvailable, false);
    assert.equal(Object.hasOwn(gone, "descriptionRevision"), false);
    assert.doesNotMatch(gone.fix, /media images get/u);
  }
});

test("a failed images batch still returns every image finding, and warns once", async (context) => {
  const { run, state } = await fixture(context, {
    files: FILES,
    production: withTotals(report({ images: [imageFinding(uuid(1)), imageFinding(uuid(2))] })),
  });
  state.imageFailure = 403;
  const { exit, result, stderr } = await run(["health", "--production"]);
  assert.equal(exit, 0, stderr);
  assert.equal(result.imageFindings.length, 2);
  for (const finding of result.imageFindings) {
    for (const field of ["descriptionRevision", "imageAvailable", "currentlyDescribed"]) {
      assert.equal(Object.hasOwn(finding, field), false, field);
    }
    assert.match(finding.fix, /media images get/u);
  }
  assert.equal(stderr.split("\n").filter((line) => /^Warning: \d+ image\(s\) could not be read/u.test(line)).length, 1);
});

test("an image placed on 300 pages lists 10 and counts 300", async (context) => {
  const pageIds = Array.from({ length: 300 }, (_, index) => uuid(1000 + index));
  const { run } = await fixture(context, {
    files: FILES,
    production: withTotals(report({ images: [imageFinding(uuid(1), pageIds)] })),
    images: new Map([[uuid(1), { descriptionRevision: "1" }]]),
  });
  const { result } = await run(["health", "--production"]);
  assert.equal(result.imageFindings[0].affectedPages.length, 10);
  assert.equal(result.imageFindings[0].affectedPageCount, 300);
});

test("a directory with no manifest reports findings without a file, and a missing media manifest keeps the file", async (context) => {
  await context.test("no workspace manifest", async (child) => {
    const { run } = await fixture(child, {
      production: withTotals(report({ findings: [pageFinding()], images: [imageFinding(uuid(1))] })),
      images: new Map([[uuid(1), { descriptionRevision: "1" }]]),
    });
    const { exit, result } = await run(["health", "--production"]);
    assert.equal(exit, 0);
    assert.equal(Object.hasOwn(result.findings[0], "file"), false);
    assert.equal(Object.hasOwn(result.imageFindings[0].affectedPages[0], "file"), false);
    assert.equal(result.imageFindings[0].needsDescription, true);
  });
  await context.test("no media manifest", async (child) => {
    const { run } = await fixture(child, {
      files: { ".taproot-site-manifest.json": MANIFEST, "pages/about.md": FILES["pages/about.md"] },
      production: withTotals(report({ findings: [pageFinding()], images: [imageFinding(uuid(1))] })),
      images: new Map([[uuid(1), { descriptionRevision: "1" }]]),
    });
    const { exit, result } = await run(["health", "--production"]);
    assert.equal(exit, 0);
    assert.equal(result.findings[0].file, "pages/about.md");
    assert.equal(Object.hasOwn(result.imageFindings[0], "suggestedDescription"), false);
    assert.equal(result.imageFindings[0].needsDescription, true);
    assert.doesNotMatch(result.imageFindings[0].fix, /--description=/u);
  });
  await context.test("an unreadable media manifest is a warning, not a failure", async (child) => {
    const { run } = await fixture(child, {
      files: { ...FILES, ".taproot-site-media.json": "{ not json" },
      production: withTotals(report({ images: [imageFinding(uuid(1))] })),
      images: new Map([[uuid(1), { descriptionRevision: "1" }]]),
    });
    const { exit, result, stderr } = await run(["health", "--production"]);
    assert.equal(exit, 0, stderr);
    assert.equal(result.imageFindings.length, 1);
    assert.match(stderr, /media manifest could not be read/u);
  });
});

test("with no image findings, no image is read and the media manifest is never opened", async (context) => {
  const { run } = await fixture(context, {
    files: { ...FILES, ".taproot-site-media.json": "{ not json" },
    production: withTotals(report({ findings: [pageFinding()] })),
  });
  const { exit, result, calls, stderr } = await run(["health", "--production"]);
  assert.equal(exit, 0, stderr);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(sequence(calls), ["health:production"]);
  assert.doesNotMatch(stderr, /media manifest/u);
});

test("a manifest with a null page entry does not fail a read that has image findings", async (context) => {
  const { run } = await fixture(context, {
    files: { ...FILES, ".taproot-site-manifest.json": { ...MANIFEST, pages: [null, ...MANIFEST.pages] } },
    production: withTotals(report({ images: [imageFinding(uuid(1), [PAGE_A])] })),
    images: new Map([[uuid(1), { descriptionRevision: "1" }]]),
  });
  const { exit, result, stderr } = await run(["health", "--production"]);
  assert.equal(exit, 0, stderr);
  assert.equal(result.imageFindings[0].suggestedDescription, "Bird in flight");
  assert.equal(result.imageFindings[0].affectedPages[0].file, "pages/about.md");
});

test("progress lines are cleaned for the terminal while the JSON keeps the original values", async (context) => {
  // The manifest's file value is not validated before it reaches a finding.
  const file = "pages/ab\u001b[2Jc\nd.md";
  const { run } = await fixture(context, {
    files: { ".taproot-site-manifest.json": { ...MANIFEST, pages: [{ ...MANIFEST.pages[0], file }] } },
    production: withTotals(report({
      findings: [pageFinding({ subject: "/gone\u001b[31m" })],
      images: [imageFinding(uuid(1), [PAGE_A], { name: "bird\u001b]0;x\u0007.webp" })],
    })),
    images: new Map([[uuid(1), { descriptionRevision: "1" }]]),
  });
  const { exit, result, stderr } = await run(["health", "--production"]);
  assert.equal(exit, 0, stderr);
  assert.equal(result.findings[0].file, file);
  assert.doesNotMatch(stderr, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
  assert.match(stderr, /Warning: pages\/ab\[2Jcd\.md /u);
});

test("a full report of 200 findings and 200 images stays under the result bound and says it was cut", async (context) => {
  const findings = Array.from({ length: 200 }, (_, index) => pageFinding({ subject: `/missing-${index}-${"x".repeat(150)}`, pageTitle: "T".repeat(150) }));
  const images = Array.from({ length: 200 }, (_, index) => imageFinding(uuid(5000 + index), Array.from({ length: 12 }, (_, page) => uuid(9000 + page)), { name: "N".repeat(150) }));
  const { run } = await fixture(context, {
    files: FILES,
    production: { ...withTotals(report({ findings, images })), truncated: true, warningCount: 500, pageCount: 1 },
    images: new Map(images.map((image) => [image.imageId, { descriptionRevision: "1" }])),
  });
  const { exit, result, stdout } = await run(["health", "--production"]);
  assert.equal(exit, 0);
  assert.ok(Buffer.byteLength(stdout, "utf8") < 64 * 1024, `result was ${Buffer.byteLength(stdout, "utf8")} bytes`);
  assert.equal(result.findingsTruncated, true);
  assert.equal(result.imageFindingsTruncated, true);
  assert.equal(result.findingsTotal, 200);
  assert.equal(result.imageFindingsTotal, 200);
  assert.equal(result.truncated, true);
  assert.equal(result.warningCount, 500);
  assert.ok(result.findings.length < 200 && result.imageFindings.length < 200);
});

test("a managed Docs site returns covered false and makes no health read", async (context) => {
  const { run } = await fixture(context, { config: { authoringSurface: "docs-presentation" }, files: FILES });
  for (const target of ["--staging", "--production"]) {
    const { exit, result, calls } = await run(["health", target]);
    assert.equal(exit, 0);
    assert.equal(result.covered, false);
    assert.equal(typeof result.reason, "string");
    assert.equal(calls.length, 0);
  }
});

test("a failed production read fails both targets, and a failed staged read fails --staging only", async (context) => {
  const { run, state } = await fixture(context, {
    files: FILES,
    production: withTotals(report({ findings: [pageFinding()], stagedDeploymentId: STAGED_DEPLOYMENT })),
    staged: withTotals(report({ environment: "staging", findings: [pageFinding()] })),
  });
  state.healthFailure = (deploymentId) => deploymentId === null ? 403 : undefined;
  for (const target of ["--staging", "--production"]) {
    const { exit, result } = await run(["health", target]);
    assert.equal(exit, 1);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "api.request_rejected");
  }
  state.healthFailure = (deploymentId) => deploymentId === null ? undefined : 403;
  const staging = await run(["health", "--staging"]);
  assert.equal(staging.exit, 1);
  assert.equal(staging.result.ok, false);
  const production = await run(["health", "--production"]);
  assert.equal(production.exit, 0);
  assert.equal(production.result.available, true);
});

test("health needs exactly one target and refuses a deploy-only option", async () => {
  for (const [arguments_, code] of [
    [["health"], "cli.deploy_target"],
    [["health", "--staging", "--production"], "cli.deploy_target"],
    [["health", "--staging", "--allow-failed-preview"], "cli.unknown_option"],
    [["health", "--staging", "--handoff"], "cli.unknown_option"],
  ]) {
    let stdout = "";
    const exit = await runCli({ arguments_, environment: {}, stdout: { write: (chunk) => { stdout += chunk; } }, stderr: { write() {} } });
    assert.equal(exit, 2, arguments_.join(" "));
    assert.equal(JSON.parse(stdout).error.code, code);
  }
});

test("a prebuilt Docs site refuses health before any request", async (context) => {
  const { run } = await fixture(context, { config: { authoringSurface: "none" } });
  const { exit, result, calls } = await run(["health", "--production"]);
  assert.equal(exit, 2);
  assert.equal(result.error.code, "surface.none");
  assert.equal(calls.length, 0);
});
