import assert from "node:assert/strict";
import test from "node:test";

import { SiteAuthoringError } from "../src/errors.js";
import {
  classifyDescriptionFailure,
  completedWritesForDescribe,
  describedImagesBlock,
  describeMissingImages,
  DESCRIBED_IMAGES_BUDGETS,
  evaluateImagePrecheck,
  placedImageIdsForPages,
  planImageDescriptions,
} from "../src/site-health-precheck.js";
import { ApiError, SiteApiClient } from "../src/transport.js";

const SITE_ID = "aaaa1111-bbbb-4111-8111-cccc11111111";
const KEY = "tr_describe_test_site_key";
const uuid = (number) => `${String(number).padStart(8, "0")}-0000-4000-8000-000000000000`;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const paragraph = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
const image = (imageId, alt = "", extra = {}) => ({ type: "taprootImage", attrs: { imageId, src: "", urls: [], alt, ...extra } });
const doc = (...content) => ({ type: "doc", content: [paragraph("Hello"), ...content] });
const page = (file, document) => ({ file, pagePath: file.replace(/^pages\/|\.[^.]+$/gu, ""), title: file, document });
const pagesOf = (...entries) => placedImageIdsForPages(entries);

/** A read state over [imageId, overrides] records, as `readImageRecords` keeps it. */
function stateOf(records, { ids, failedIds = [], status = "checked", reason } = {}) {
  return {
    siteId: SITE_ID,
    ids: ids ?? records.map(([imageId]) => imageId).sort(),
    records: new Map(records.map(([imageId, overrides = {}]) => [imageId, { imageId, name: `${imageId.slice(0, 4)}.webp`, descriptionRevision: "4", ...overrides }])),
    failedIds,
    status,
    ...(reason === undefined ? {} : { reason }),
  };
}

const fieldBody = (name) => ({ code: 3, message: "invalid", details: [{ fieldViolations: [{ field: name, description: `${name} refused` }] }] });
const capabilityBody = {
  code: 7, message: "denied",
  details: [{
    "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SITE_AUTHORING_CAPABILITY_MISSING", domain: "taproot-site-authoring",
    metadata: { permission: "site.media.manage", granted: "site.pages.edit_any", required: "site.media.manage" },
  }],
};
const field = (name) => new ApiError(400, fieldBody(name));
const status = (httpStatus, body = { code: 2, message: "refused" }) => new ApiError(httpStatus, body);
const capabilityDenied = () => new ApiError(403, capabilityBody);
// What the server answers, for the loop tests below (the classifier tests above use the errors themselves).
const refused = (httpStatus, body = { code: 2, message: "refused" }) => json(body, httpStatus);
const cancelled = (ambiguousMutation = false) => Object.assign(new SiteAuthoringError("site.cancelled", "cancelled"), { ambiguousMutation });

test("the planner sets each missing default from the one alt its selected placements agree on", async (context) => {
  const pages = pagesOf(
    page("pages/a.md", doc(image(uuid(1), "  A bird  "), image(uuid(2), "Heron"), image(uuid(3), "One"), image(uuid(5), "x".repeat(1001)))),
    page("pages/b.md", doc(image(uuid(1), "A bird"), image(uuid(2), "Other heron"), image(uuid(3), ""), image(uuid(4), "Never"))),
  );
  const state = stateOf(
    [[uuid(1)], [uuid(2)], [uuid(3)], [uuid(4), { defaultDescription: "Described" }], [uuid(5)], [uuid(6)]],
    { ids: [uuid(1), uuid(2), uuid(3), uuid(4), uuid(5), uuid(6), uuid(7)], failedIds: [uuid(7)] },
  );
  const plan = planImageDescriptions(state, pages);
  // Ascending by id; the described image (4) is not listed; 7 was in a failed batch; 6 is placed nowhere.
  assert.deepEqual(plan, [
    // Alts differing only by outer whitespace are one text, and the record's revision is the expected one.
    { imageId: uuid(1), description: "A bird", expectedRevision: "4" },
    { imageId: uuid(2), reason: "alts_disagree" },
    // An empty alt on one placement is no alt, so the other placement's text is the only one.
    { imageId: uuid(3), description: "One", expectedRevision: "4" },
    { imageId: uuid(5), reason: "unusable_alt" },
    { imageId: uuid(6), reason: "no_alt" },
    { imageId: uuid(7), reason: "not_read" },
  ]);

  await context.test("only the selected pages' placements count", () => {
    const only = planImageDescriptions(stateOf([[uuid(4)]]), pagesOf(page("pages/b.md", doc(image(uuid(4), "")))));
    assert.deepEqual(only, [{ imageId: uuid(4), reason: "no_alt" }]);
  });

  await context.test("only a custom or unset placement counts, so a stale inherited alt never restores a cleared default", () => {
    const stale = pagesOf(page("pages/s.pm.json", doc(image(uuid(1), "Stale hydrated default", { descriptionMode: "inherit" }), image(uuid(2), "Decorative", { descriptionMode: "decorative" }))));
    assert.deepEqual(planImageDescriptions(stateOf([[uuid(1)], [uuid(2)]]), stale).map((item) => item.reason), ["no_alt", "no_alt"]);
  });

  await context.test("a page that cannot be walked contributes no alt text, and the others still do", () => {
    let deep = [];
    for (let level = 0; level < 20_000; level += 1) deep = [deep];
    const mixed = pagesOf(page("pages/deep.md", doc(image(uuid(1), "Deep", { deep }))), page("pages/ok.md", doc(image(uuid(1), "Fine"))));
    assert.equal(planImageDescriptions(stateOf([[uuid(1)]]), mixed)[0].description, "Fine");
  });
});

test("each failure is classified by the story's table, in its order", () => {
  const unknown = { action: "unknown", reason: "write_unknown" };
  const cases = [
    ["a cancelled run", cancelled(), { action: "fail" }],
    ["a cancelled write of unknown outcome", cancelled(true), { action: "fail" }],
    ["an outdated CLI", field("CliUpgradeRequired"), { action: "fail" }],
    ["a paused platform", field("SiteAuthoringRollout"), { action: "fail" }],
    ["a paused platform answered with a 503", new ApiError(503, { code: 14, details: [{ fieldViolations: [{ field: "SiteAuthoringRollout" }] }] }), { action: "fail" }],
    ["a rejected credential", status(401, { code: 16 }), { action: "fail" }],
    ["throttling", status(429, { code: 8 }), { action: "stop", reason: "write_failed" }],
    ["a missing capability", capabilityDenied(), { action: "stop", reason: "write_denied" }],
    ["a plain 403", status(403, { code: 7 }), { action: "stop", reason: "write_denied" }],
    ["a server error", status(500), unknown],
    ["a gateway error", status(502), unknown],
    ["an ambiguous mutation", new SiteAuthoringError("transport.mutation_ambiguous", "unclear"), unknown],
    ["an unreadable response", new SiteAuthoringError("transport.response_read", "unreadable"), unknown],
    ["a broken image description contract", new SiteAuthoringError("api.image_description_contract", "bad"), unknown],
    ["a broken image contract", new SiteAuthoringError("api.image_contract", "bad"), unknown],
    ["an invalid image state", new SiteAuthoringError("api.image_state", "bad"), unknown],
    ["a moved revision", field("ExpectedRevision"), { action: "skip", reason: "revision_moved" }],
    ["an existing default", field("OnlyIfMissing"), { action: "skip", reason: "already_described" }],
    ["refused text", field("DefaultDescription"), { action: "skip", reason: "invalid_description" }],
    ["an image deleted since the read", status(404, { code: 5 }), { action: "skip", reason: "write_failed" }],
    ["a network error before sending", new SiteAuthoringError("transport.network", "no route"), { action: "skip", reason: "write_failed" }],
  ];
  for (const [name, error, expected] of cases) assert.deepEqual(classifyDescriptionFailure(error), expected, name);
  // Not the CLI's own error type: nothing to classify, so it fails the command.
  assert.deepEqual(classifyDescriptionFailure(new TypeError("a bug")), { action: "fail" });
});

/** A client whose PATCH answers come from `answer(imageId, body, index)`, with every write recorded. */
function writer(answer, { signal } = {}) {
  const writes = [];
  const fetch = async (url, init = {}) => {
    const target = new URL(url);
    const imageId = target.pathname.split("/").at(-2);
    const body = JSON.parse(init.body);
    writes.push({ method: init.method, imageId, body });
    return await answer(imageId, body, writes.length - 1);
  };
  return { writes, client: new SiteApiClient({ apiBaseUrl: "https://app.taproot.test/api", token: KEY, fetch, sleep: async () => {}, signal }) };
}

const saved = (imageId, description, revision = "5") => json({
  image: {
    imageId, siteId: SITE_ID, ownershipScope: "IMAGE_OWNERSHIP_SCOPE_SITE", uploadedName: "kept.webp", width: 10, height: 10,
    defaultDescription: description, descriptionRevision: revision, url: "https://static.test/a.webp", responsiveUrls: [],
    processingState: "IMAGE_PROCESSING_STATE_COMPLETE",
  },
});

function setup(count, { alt = (index) => `Alt ${index}` } = {}) {
  const ids = Array.from({ length: count }, (_, index) => uuid(index + 1));
  const pages = pagesOf(page("pages/a.md", doc(...ids.map((id, index) => image(id, alt(index + 1))))));
  const state = stateOf(ids.map((id) => [id]));
  return { ids, pages, state, plan: planImageDescriptions(state, pages) };
}

test("the writes go in ascending order with each record's revision and onlyIfMissing, and update the kept records", async () => {
  const { ids, pages, state, plan } = setup(3);
  const { client, writes } = writer((imageId, body) => saved(imageId, body.defaultDescription, "9"));
  const result = await describeMissingImages({ client, siteId: SITE_ID, state, plan });
  assert.deepEqual(writes.map((write) => [write.method, write.imageId]), ids.map((id) => ["PATCH", id]));
  assert.deepEqual(writes[0].body, { defaultDescription: "Alt 1", expectedRevision: "4", onlyIfMissing: true });
  assert.deepEqual(result.set.map((entry) => [entry.imageId, entry.description]), ids.map((id, index) => [id, `Alt ${index + 1}`]));
  assert.deepEqual(result.skipped, []);
  // The kept records now hold what was written, and keep their name, so the precheck reports no finding for them.
  const record = state.records.get(ids[0]);
  assert.equal(record.defaultDescription, "Alt 1");
  assert.equal(record.descriptionRevision, "9");
  assert.equal(record.name, `${ids[0].slice(0, 4)}.webp`);
  assert.equal(evaluateImagePrecheck(state, pages).imageFindings.total, 0);
});

test("a response with a null default removes the key from the kept record", async () => {
  const { ids, state, plan } = setup(1);
  const { client } = writer((imageId) => saved(imageId, null, "7"));
  await describeMissingImages({ client, siteId: SITE_ID, state, plan });
  assert.equal(Object.hasOwn(state.records.get(ids[0]), "defaultDescription"), false);
  assert.equal(state.records.get(ids[0]).descriptionRevision, "7");
});

test("images that cannot be set are listed with their reason and written nothing", async () => {
  const pages = pagesOf(page("pages/a.md", doc(image(uuid(1), "Bird"), image(uuid(2), "A"), image(uuid(3), ""))));
  const state = stateOf([[uuid(1)], [uuid(2)], [uuid(3)]], { failedIds: [] });
  pages[0].document.content.push(image(uuid(2), "B"));
  const { client, writes } = writer((imageId, body) => saved(imageId, body.defaultDescription));
  const result = await describeMissingImages({ client, siteId: SITE_ID, state, plan: planImageDescriptions(state, pages) });
  assert.deepEqual(writes.map((write) => write.imageId), [uuid(1)]);
  assert.deepEqual(result.skipped, [{ imageId: uuid(2), reason: "alts_disagree" }, { imageId: uuid(3), reason: "no_alt" }]);
});

test("a revision that moved, a deleted image and refused text are skipped with their reason, and the run goes on", async () => {
  const { ids, state, plan } = setup(5);
  const answers = [refused(400, fieldBody("ExpectedRevision")), refused(404, { code: 5 }), refused(400, fieldBody("DefaultDescription")), refused(400, fieldBody("OnlyIfMissing"))];
  const { client } = writer((imageId, body, index) => (index < 4 ? answers[index] : saved(imageId, body.defaultDescription)));
  const result = await describeMissingImages({ client, siteId: SITE_ID, state, plan });
  assert.deepEqual(result.skipped, [
    { imageId: ids[0], reason: "revision_moved" }, { imageId: ids[1], reason: "write_failed" },
    { imageId: ids[2], reason: "invalid_description" }, { imageId: ids[3], reason: "already_described" },
  ]);
  assert.deepEqual(result.set.map((entry) => entry.imageId), [ids[4]]);
  // Nothing refused changed its record.
  assert.equal(Object.hasOwn(state.records.get(ids[0]), "defaultDescription"), false);
});

test("a denied write marks that image and every later one write_denied, with no further write", async (context) => {
  for (const [name, denial] of [["a stubbed 403", () => refused(403, { code: 7 })], ["a missing capability", () => refused(403, capabilityBody)]]) {
    await context.test(name, async () => {
      const { ids, state, plan } = setup(4);
      const { client, writes } = writer(() => denial());
      const result = await describeMissingImages({ client, siteId: SITE_ID, state, plan });
      assert.equal(writes.length, 1);
      assert.deepEqual(result.set, []);
      assert.deepEqual(result.skipped, ids.map((imageId) => ({ imageId, reason: "write_denied" })));
    });
  }
});

test("throttling stops further writes and skips the rest as write_failed", async () => {
  const { ids, state, plan } = setup(4);
  const { client, writes } = writer((imageId, body, index) => (index === 1 ? refused(429, { code: 8 }) : saved(imageId, body.defaultDescription)));
  const result = await describeMissingImages({ client, siteId: SITE_ID, state, plan });
  assert.equal(writes.length, 2);
  assert.deepEqual(result.set.map((entry) => entry.imageId), [ids[0]]);
  assert.deepEqual(result.skipped, ids.slice(1).map((imageId) => ({ imageId, reason: "write_failed" })));
});

test("an unknown outcome leaves the record as it was and the run goes on", async () => {
  const { ids, state, plan } = setup(3);
  const { client } = writer((imageId, body, index) => (index === 0 ? refused(502) : saved(imageId, body.defaultDescription)));
  const result = await describeMissingImages({ client, siteId: SITE_ID, state, plan });
  assert.deepEqual(result.skipped, [{ imageId: ids[0], reason: "write_unknown" }]);
  assert.equal(Object.hasOwn(state.records.get(ids[0]), "defaultDescription"), false);
  assert.equal(result.set.length, 2);
});

test("a refusal that fails the command stops the run and says what was set and what may have committed", async (context) => {
  await context.test("an unknown write, then a rejected credential: the first counts as unknown", async () => {
    const { ids, state, plan } = setup(4);
    const { client, writes } = writer((imageId, body, index) => (index === 0 ? refused(502)
      : index === 1 ? refused(401, { code: 16 }) : saved(imageId, body.defaultDescription)));
    await assert.rejects(describeMissingImages({ client, siteId: SITE_ID, state, plan }), (error) => {
      assert.equal(error.refusalKind(), "credential_rejected");
      assert.deepEqual(error.describeOutcome, { set: [], unknown: [ids[0]], failing: undefined });
      return true;
    });
    assert.equal(writes.length, 2);
  });
  await context.test("a cancelled write of unknown outcome is the failing image, listed as unknown", async () => {
    const { ids, state, plan } = setup(3);
    // The run is cancelled while the second write is in flight, so its outcome is unknown.
    const controller = new AbortController();
    const { client } = writer((imageId, body, index) => {
      if (index !== 1) return saved(imageId, body.defaultDescription);
      controller.abort();
      return new Promise(() => {});
    }, { signal: controller.signal });
    await assert.rejects(describeMissingImages({ client, siteId: SITE_ID, state, plan }), (error) => {
      assert.equal(error.code, "site.cancelled");
      assert.deepEqual(error.describeOutcome, { set: [ids[0]], unknown: [], failing: ids[1] });
      return true;
    });
  });
  await context.test("a refusal that is not an unknown outcome names no failing image", async () => {
    const { ids, state, plan } = setup(2);
    const { client } = writer((imageId, body, index) => (index === 1 ? refused(400, fieldBody("CliUpgradeRequired")) : saved(imageId, body.defaultDescription)));
    await assert.rejects(describeMissingImages({ client, siteId: SITE_ID, state, plan }), (error) => {
      assert.deepEqual(error.describeOutcome, { set: [ids[0]], unknown: [], failing: undefined });
      return true;
    });
  });
});

test("the completed writes come in the story's order and the 100-entry cap keeps the counts and the first images", () => {
  const savedPages = ["page about: created", "page home: updated"];
  const unknownFirst = completedWritesForDescribe({ outcome: { set: [uuid(1)], unknown: [uuid(2)], failing: uuid(3) }, savedPages });
  assert.deepEqual(unknownFirst, [
    `image ${uuid(3)}: unknown`,
    "1 image(s): set", "2 image(s): unknown", "2 page(s): saved",
    `image ${uuid(1)}: set`, `image ${uuid(2)}: unknown`,
    ...savedPages,
  ]);

  // 120 images set and no unknown line: the cap keeps the three count lines and the first 97 image entries.
  const ids = Array.from({ length: 120 }, (_, index) => uuid(index + 1));
  const error = new SiteAuthoringError("auth.credential_rejected", "rejected").withCompletedWrites(
    completedWritesForDescribe({ outcome: { set: ids, unknown: [], failing: undefined }, savedPages }),
  );
  assert.equal(error.completedWrites.length, 100);
  assert.deepEqual(error.completedWrites.slice(0, 3), ["120 image(s): set", "0 image(s): unknown", "2 page(s): saved"]);
  assert.deepEqual(error.completedWrites.slice(3), ids.slice(0, 97).map((id) => `image ${id}: set`));
});

test("the report bounds its lists, keeps every total, and carries the read's reason", () => {
  const set = Array.from({ length: 200 }, (_, index) => ({ imageId: uuid(index + 1), description: "d".repeat(100) }));
  const skipped = Array.from({ length: 200 }, (_, index) => ({ imageId: uuid(index + 1), reason: "alts_disagree" }));
  const block = describedImagesBlock({ set, skipped }, stateOf([], { status: "partial", reason: { code: "read_partly_failed", message: "Some records could not be read." } }));
  assert.equal(block.set.total, 200);
  assert.equal(block.set.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(block.set.items), "utf8") <= DESCRIBED_IMAGES_BUDGETS.set);
  assert.equal(block.skipped.total, 200);
  assert.equal(block.skipped.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(block.skipped.items), "utf8") <= DESCRIBED_IMAGES_BUDGETS.skipped);
  assert.deepEqual(block.reason, { code: "read_partly_failed", message: "Some records could not be read." });

  const empty = describedImagesBlock({ set: [], skipped: [] }, stateOf([]));
  assert.deepEqual(empty, { set: { total: 0, items: [] }, skipped: { total: 0, items: [] } });
});
