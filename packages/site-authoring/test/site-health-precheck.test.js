import assert from "node:assert/strict";
import test from "node:test";

import { LIMITS } from "../src/constants.js";
import {
  describedImagesBlock,
  evaluateImagePrecheck,
  fitPrecheckToBudget,
  placedImageIdsForPages,
  readImageRecords,
} from "../src/site-health-precheck.js";
import { SiteApiClient } from "../src/transport.js";
import { withImagePrecheck } from "../src/verbs/pages-push.js";

const SITE_ID = "aaaa1111-bbbb-4111-8111-cccc11111111";
const KEY = "tr_precheck_test_site_key";
const uuid = (number) => `${String(number).padStart(8, "0")}-0000-4000-8000-000000000000`;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const paragraph = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
const image = (imageId, alt = "", extra = {}) => ({
  type: "taprootImage", attrs: { imageId, src: "", urls: [], alt, ...extra },
});
const freeForm = (...content) => ({ type: "doc", content: [paragraph("Hello"), ...content] });
const page = (file, document, extra = {}) => ({ file, pagePath: file.replace(/^pages\/|\.[^.]+$/gu, ""), title: file, document, ...extra });

/** A client whose reads go to `handler(url, calls)`, with every request recorded. */
function clientFor(handler) {
  const calls = [];
  const fetch = async (url) => {
    const target = new URL(url);
    calls.push({ pathname: target.pathname, ids: target.searchParams.getAll("imageIds") });
    return await handler(target, calls);
  };
  return { calls, client: new SiteApiClient({ apiBaseUrl: "https://app.taproot.test/api", token: KEY, fetch, sleep: async () => {} }) };
}

const wireImage = (imageId, overrides = {}) => ({
  image: {
    imageId, siteId: SITE_ID, ownershipScope: "IMAGE_OWNERSHIP_SCOPE_SITE", uploadedName: `${imageId.slice(0, 4)}.webp`,
    width: 10, height: 10, defaultDescription: "", descriptionRevision: "4", url: "https://static.test/a.webp",
    responsiveUrls: [], processingState: "IMAGE_PROCESSING_STATE_COMPLETE", ...overrides,
  },
});

test("the placed ids come from the data member of each template, plus the lowercased cover", async (context) => {
  await context.test("a place review's body and an uppercase cover", () => {
    const [entry] = placedImageIdsForPages([page("pages/review.md", {
      template: "place-review", data: { body: freeForm(image(uuid(1), "Plate")), rating: "RATING_FOUR" },
      coverImageId: uuid(2).toUpperCase(),
    })]);
    assert.deepEqual([...entry.imageIds].sort(), [uuid(1), uuid(2)]);
    assert.equal(entry.key, "pages/review.md");
    assert.equal(entry.path, "review");
  });

  await context.test("a free-form page's component image is reached through its data member, not the wrapper", () => {
    const banner = {
      type: "componentBlock",
      attrs: { componentType: "image-banner", componentData: JSON.stringify({ image: { imageId: uuid(3) }, altText: "Banner" }) },
    };
    const [entry] = placedImageIdsForPages([page("pages/free.pm.json", freeForm(banner))]);
    assert.deepEqual(entry.imageIds, [uuid(3)]);
  });

  await context.test("a document whose wire form cannot be built contributes no ids and does not throw", () => {
    const [entry] = placedImageIdsForPages([page("pages/odd.pm.json", { template: "place-review", data: null })]);
    assert.deepEqual(entry.imageIds, []);
  });
});

test("the image read asks for each id once, makes no request for none, and says how much was read", async (context) => {
  await context.test("duplicate ids across pages are read once, and the state keeps the records", async () => {
    const { client, calls } = clientFor((url) => json({ images: url.searchParams.getAll("imageIds").map((id) => wireImage(id)) }));
    const state = await readImageRecords(client, SITE_ID, [uuid(2), uuid(1), uuid(2)]);
    assert.deepEqual(calls.map((call) => call.ids), [[uuid(1), uuid(2)]]);
    assert.equal(state.status, "checked");
    assert.equal(Object.hasOwn(state, "reason"), false);
    assert.deepEqual([...state.records.keys()].sort(), [uuid(1), uuid(2)]);
  });

  await context.test("no placed image makes no request and counts as checked", async () => {
    const { client, calls } = clientFor(() => json({}));
    const state = await readImageRecords(client, SITE_ID, []);
    assert.equal(calls.length, 0);
    assert.equal(state.status, "checked");
  });

  await context.test("one failed batch among several is partial, and all failed is not_checked", async () => {
    const ids = Array.from({ length: 150 }, (_, index) => uuid(index + 1));
    const partial = clientFor((url, calls) =>
      calls.length === 1 ? json({ code: 7, message: "denied" }, 403) : json({ images: url.searchParams.getAll("imageIds").map((id) => wireImage(id)) }));
    const state = await readImageRecords(partial.client, SITE_ID, ids);
    assert.equal(state.status, "partial");
    assert.equal(state.reason.code, "read_partly_failed");
    assert.deepEqual(state.failedIds, ids.slice(0, 100));
    assert.equal(state.records.size, 50);

    const none = clientFor(() => json({ code: 7, message: "denied" }, 403));
    const failed = await readImageRecords(none.client, SITE_ID, [uuid(1)]);
    assert.equal(failed.status, "not_checked");
    assert.equal(failed.reason.code, "read_failed");
  });

  await context.test("a rejected credential is kept to rethrow", async () => {
    const { client } = clientFor(() => json({ code: 16, message: "no" }, 401));
    const state = await readImageRecords(client, SITE_ID, [uuid(1)]);
    assert.equal(state.refusalError.refusalKind(), "credential_rejected");
  });
});

/** A read state over records given as [imageId, overrides], without a client. */
function stateOf(records, { ids, failedIds = [], status = "checked" } = {}) {
  return {
    siteId: SITE_ID,
    ids: ids ?? records.map(([imageId]) => imageId).sort(),
    records: new Map(records.map(([imageId, overrides = {}]) => [imageId, { imageId, name: `${imageId.slice(0, 4)}.webp`, descriptionRevision: "4", ...overrides }])),
    failedIds,
    status,
  };
}

test("the evaluation reports each undescribed image once, ordered by image id, with its affected pages and fix", () => {
  const pages = placedImageIdsForPages([
    page("pages/a.md", freeForm(image(uuid(2), "Heron"), image(uuid(1), "Bird"))),
    page("pages/b.md", freeForm(image(uuid(2), "Other heron"))),
  ]);
  // The records arrive in the opposite order to the ids.
  const lines = [];
  const block = evaluateImagePrecheck(stateOf([[uuid(2)], [uuid(1)]]), pages, (line) => lines.push(line));
  assert.equal(block.status, "checked");
  assert.equal(block.checkedPages, 2);
  assert.deepEqual(block.skipped, []);
  assert.deepEqual(block.imageFindings.items.map((finding) => finding.imageId), [uuid(1), uuid(2)]);
  const heron = block.imageFindings.items[1];
  assert.deepEqual(heron.affectedPages.map((entry) => entry.file), ["pages/a.md", "pages/b.md"]);
  // The first alt in page order is the suggestion, and the fix is the exact command.
  assert.equal(heron.suggestedDescription, "Heron");
  assert.equal(heron.fix, `taproot-site media images describe ${uuid(2)} --description='Heron' --expected-revision 4 --if-missing`);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.startsWith("Warning: image ") && line.includes("Fix:")));
});

test("a described image is no finding, and a default of an empty string counts as described only through the read", () => {
  const pages = placedImageIdsForPages([page("pages/a.md", freeForm(image(uuid(1), "Bird"), image(uuid(2), "Heron")))]);
  const block = evaluateImagePrecheck(stateOf([[uuid(1), { defaultDescription: "Described" }], [uuid(2)]]), pages);
  assert.deepEqual(block.imageFindings.items.map((finding) => finding.imageId), [uuid(2)]);
  assert.equal(block.imageFindings.total, 1);
});

test("an id the site did not return is listed with no finding, and an id in a failed batch is in neither list", () => {
  const pages = placedImageIdsForPages([page("pages/a.md", freeForm(image(uuid(1)), image(uuid(2)), image(uuid(3))))]);
  const lines = [];
  const state = stateOf([[uuid(1)]], { ids: [uuid(1), uuid(2), uuid(3)], failedIds: [uuid(3)], status: "partial" });
  state.reason = { code: "read_partly_failed", message: "Some records could not be read." };
  const block = evaluateImagePrecheck(state, pages, (line) => lines.push(line));
  assert.deepEqual(block.imageFindings.items.map((finding) => finding.imageId), [uuid(1)]);
  assert.deepEqual(block.notInSiteLibrary, { total: 1, items: [uuid(2)] });
  assert.equal(block.status, "partial");
  assert.deepEqual(block.skipped, ["a11y.image_default_missing"]);
  assert.equal(block.reason.code, "read_partly_failed");
  assert.ok(lines.some((line) => /^Warning: 1 image\(s\) could not be read/u.test(line)));
});

test("nothing read gives empty lists, not_checked, and the rule skipped", () => {
  const pages = placedImageIdsForPages([page("pages/a.md", freeForm(image(uuid(1))))]);
  const state = stateOf([], { ids: [uuid(1)], failedIds: [uuid(1)], status: "not_checked" });
  state.reason = { code: "read_failed", message: "The records could not be read." };
  const block = evaluateImagePrecheck(state, pages);
  assert.deepEqual(block.imageFindings, { total: 0, items: [] });
  assert.deepEqual(block.notInSiteLibrary, { total: 0, items: [] });
  assert.equal(block.status, "not_checked");
  assert.equal(block.reason.code, "read_failed");
});

test("a page that cannot be walked contributes no alt text, and the others still do", () => {
  // Nested deeply enough to overflow a recursive walk.
  let deep = [];
  for (let level = 0; level < 20_000; level += 1) deep = [deep];
  const pages = placedImageIdsForPages([
    page("pages/deep.md", freeForm(image(uuid(1), "Deep alt", { deep }))),
    page("pages/ok.md", freeForm(image(uuid(1), "Fine alt"))),
  ]);
  const block = evaluateImagePrecheck(stateOf([[uuid(1)]]), pages);
  assert.equal(block.imageFindings.items[0].suggestedDescription, "Fine alt");
});

test("progress names at most 20 findings and counts the rest", () => {
  const ids = Array.from({ length: 25 }, (_, index) => uuid(index + 1));
  const pages = placedImageIdsForPages([page("pages/a.md", freeForm(...ids.map((id) => image(id, "Alt"))))]);
  const lines = [];
  evaluateImagePrecheck(stateOf(ids.map((id) => [id])), pages, (line) => lines.push(line));
  assert.equal(lines.length, 21);
  assert.match(lines[20], /5 more undescribed image/u);
});

test("the findings and the ids not in the library are bounded by their own byte budgets", () => {
  const ids = Array.from({ length: 200 }, (_, index) => uuid(index + 1));
  const pages = placedImageIdsForPages([page("pages/a.md", freeForm(...ids.map((id) => image(id, "A".repeat(200)))))]);
  const state = stateOf(ids.map((id) => [id, { name: "N".repeat(100) }]));
  state.ids = [...state.ids, ...Array.from({ length: 200 }, (_, index) => uuid(1000 + index))];
  const block = evaluateImagePrecheck(state, pages);
  assert.equal(block.imageFindings.total, 200);
  assert.equal(block.imageFindings.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(block.imageFindings.items), "utf8") <= 12 * 1024);
  assert.equal(block.notInSiteLibrary.total, 200);
  assert.equal(block.notInSiteLibrary.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(block.notInSiteLibrary.items), "utf8") <= 2 * 1024);
});

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

test("fitting leaves a result within the bound, shrinking in the named order and keeping every total", async (context) => {
  const listOf = (count, size) => ({ total: count, items: Array.from({ length: count }, (_, index) => `${index}`.padEnd(size, "x")) });
  // A base that leaves exactly 2 KiB under the bound.
  const padding = { padding: "p".repeat(LIMITS.githubOutputBytes - 2048 - bytes({ padding: "" })) };
  assert.equal(bytes(padding), LIMITS.githubOutputBytes - 2048);
  const blocks = () => ({
    siteHealthPrecheck: {
      status: "checked", checkedPages: 3, skipped: [],
      imageFindings: listOf(40, 100), notInSiteLibrary: listOf(10, 100),
    },
    // TR01372's shape, about 4 KiB, which TR01371 shrinks last.
    describedImages: { set: listOf(5, 100), skipped: listOf(5, 100) },
  });
  const order = [
    "siteHealthPrecheck.notInSiteLibrary", "siteHealthPrecheck.imageFindings", "describedImages.set", "describedImages.skipped",
  ];

  await context.test("full blocks that do not fit are truncated, totals intact, in order", () => {
    const fitted = fitPrecheckToBudget(padding, blocks(), order);
    assert.ok(bytes({ ...padding, ...fitted }) <= LIMITS.githubOutputBytes);
    const { notInSiteLibrary, imageFindings } = fitted.siteHealthPrecheck;
    assert.equal(notInSiteLibrary.total, 10);
    assert.equal(imageFindings.total, 40);
    assert.equal(fitted.describedImages.set.total, 5);
    // The first list gave way first, to empty, before the second was touched.
    assert.deepEqual(notInSiteLibrary.items, []);
    assert.equal(notInSiteLibrary.truncated, true);
    assert.ok(imageFindings.items.length < 40);
    assert.equal(imageFindings.truncated, true);
    // The later lists were left whole.
    assert.equal(fitted.describedImages.set.items.length, 5);
    assert.equal(Object.hasOwn(fitted.describedImages.set, "truncated"), false);
  });

  await context.test("blocks that fit are returned unchanged", () => {
    const small = { siteHealthPrecheck: { imageFindings: listOf(2, 10), notInSiteLibrary: listOf(1, 10) } };
    assert.deepEqual(fitPrecheckToBudget(padding, small, order), small);
  });

  await context.test("less headroom than the empty shell leaves the shell and does not throw", () => {
    const full = { padding: "p".repeat(LIMITS.githubOutputBytes - 10) };
    const fitted = fitPrecheckToBudget(full, blocks(), order);
    for (const path of order) {
      const [block, name] = path.split(".");
      assert.deepEqual(fitted[block][name].items, [], path);
      assert.ok(fitted[block][name].total > 0);
    }
  });

  await context.test("a block that is absent is skipped, so a later story adds its own", () => {
    const only = { siteHealthPrecheck: blocks().siteHealthPrecheck };
    const fitted = fitPrecheckToBudget(padding, only, order);
    assert.ok(bytes({ ...padding, ...fitted }) <= LIMITS.githubOutputBytes);
  });
});

test("a push result that already carries describedImages is fitted with it, so TR01372 inherits a working order", async (context) => {
  const ids = Array.from({ length: 200 }, (_, index) => uuid(index + 1));
  const pages = placedImageIdsForPages([page("pages/a.md", freeForm(...ids.map((id) => image(id, "A".repeat(100)))))]);
  const precheck = { pages, state: stateOf(ids.map((id) => [id, { name: "N".repeat(60) }])) };
  // The real report at its bounds: 3 KiB of images set and 1 KiB of images skipped, from many more than fit.
  const describedImages = () => describedImagesBlock({
    set: Array.from({ length: 200 }, (_, index) => ({ imageId: uuid(index + 1), description: "d".repeat(100) })),
    skipped: Array.from({ length: 200 }, (_, index) => ({ imageId: uuid(index + 1), reason: "alts_disagree" })),
  }, stateOf([]));
  // The result without the precheck block, padded to leave `headroom` bytes under the bound.
  const resultWith = (headroom) => {
    const shell = { schemaVersion: 1, ok: true, padding: "", describedImages: describedImages() };
    const padding = "p".repeat(LIMITS.githubOutputBytes - headroom - bytes(shell));
    return { ...shell, padding };
  };

  await context.test("with 2 KiB left, the findings shrink first and describedImages is kept whole", () => {
    const result = resultWith(2048);
    assert.equal(bytes(result), LIMITS.githubOutputBytes - 2048);
    const fitted = withImagePrecheck(result, precheck, () => {});
    assert.ok(bytes(fitted) <= LIMITS.githubOutputBytes);
    assert.equal(fitted.siteHealthPrecheck.imageFindings.total, 200);
    assert.equal(fitted.siteHealthPrecheck.imageFindings.truncated, true);
    assert.deepEqual(fitted.describedImages, describedImages());
  });

  await context.test("with almost nothing left, describedImages shrinks after the findings, totals intact", () => {
    const fitted = withImagePrecheck(resultWith(100), precheck, () => {});
    assert.ok(bytes(fitted) <= LIMITS.githubOutputBytes);
    assert.deepEqual(fitted.siteHealthPrecheck.imageFindings.items, []);
    assert.equal(fitted.siteHealthPrecheck.imageFindings.total, 200);
    assert.equal(fitted.describedImages.set.total, 200);
    assert.equal(fitted.describedImages.set.truncated, true);
    assert.ok(fitted.describedImages.set.items.length < describedImages().set.items.length);
  });
});
