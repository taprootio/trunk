import assert from "node:assert/strict";
import test from "node:test";

import { runCli, verbCapabilitiesForSurface } from "../src/cli.js";
import { CLI_VERSION, LIMITS } from "../src/constants.js";
import { imageDescriptionOptions, imageDescriptionRevision, imageListOptions, safeImagePreviewUrl } from "../src/image-description-contract.js";
import { SiteAuthoringError } from "../src/errors.js";
import { ApiError } from "../src/transport.js";
import { mediaImagesDescribe, mediaImagesGet, mediaImagesList } from "../src/verbs/media-images.js";

const SITE_ID = "aaaa1111-bbbb-4111-8111-cccc11111111";
const IMAGE_ID = "bbbb2222-cccc-4222-8222-dddd22222222";
const MAXIMUM_REVISION = "9223372036854775807";

async function run(arguments_, handlers) {
  let stdout = "";
  let stderr = "";
  const exit = await runCli({ arguments_, handlers, environment: {},
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
  });
  return { exit, result: stdout ? JSON.parse(stdout) : undefined, stderr, stdout };
}

function wire(overrides = {}) {
  return { image: { imageId: IMAGE_ID, siteId: SITE_ID, ownershipScope: "IMAGE_OWNERSHIP_SCOPE_SITE",
    uploadedName: "bird.webp", width: 1600, height: 1200, defaultDescription: "A bird", descriptionRevision: "3",
    url: "https://static.test/platform/image.webp", responsiveUrls: [{ minWidth: 640, url: "https://static.test/platform/image-640.webp" }],
    processingState: "IMAGE_PROCESSING_STATE_COMPLETE", ...overrides } };
}

function invocation(client, extra = {}) {
  return { resolvedSession: { client, siteId: SITE_ID, onProgress: () => {} }, ...extra };
}

test("media image options preserve exact int64 revisions and full Unicode input", () => {
  assert.equal(imageDescriptionRevision(MAXIMUM_REVISION), MAXIMUM_REVISION);
  for (const value of ["9223372036854775808", "-1", "01", "1.0", "1e3", 9007199254740992, undefined])
    assert.equal(imageDescriptionRevision(value), undefined);
  for (const pageSize of [true, [], {}, 0, 101, "1.5"])
    assert.throws(() => imageListOptions({ pageSize }), (error) => error.code === "media.image_page_size_invalid");
  const text = " " + "😀".repeat(1000) + "\n A bird. ";
  assert.deepEqual(imageDescriptionOptions({ imageDescription: text, expectedRevision: MAXIMUM_REVISION, onlyIfMissing: true }),
    { defaultDescription: text, expectedRevision: MAXIMUM_REVISION, onlyIfMissing: true });
  assert.deepEqual(imageDescriptionOptions({ clearDescription: true, expectedRevision: "0" }),
    { defaultDescription: "", expectedRevision: "0", onlyIfMissing: false });
  assert.deepEqual(imageListOptions({ pageSize: "100", pageToken: "opaque\ncursor", missingDescription: true }),
    { pageSize: 100, pageToken: "opaque\ncursor", missingDescription: true });
});

test("media image CLI parses every new option and exposes narrow surface capabilities", async () => {
  let received;
  const capture = (verb) => ({ [verb]: async (value) => { received = value; return { ok: true, verb }; } });
  assert.equal((await run(["media", "images", "list", "--missing-description", "--page-size=2", "--page-token", "opaque\ncursor", "--json"],
    capture("media images list"))).exit, 0);
  assert.equal(received.pageSize, "2");
  assert.equal(received.pageToken, "opaque\ncursor");
  assert.equal(received.missingDescription, true);
  assert.equal((await run(["media", "images", "describe", IMAGE_ID, "--description=--A bird", "--expected-revision", MAXIMUM_REVISION, "--if-missing"],
    capture("media images describe"))).exit, 0);
  assert.equal(received.imageId, IMAGE_ID);
  assert.equal(received.imageDescription, "--A bird");
  assert.equal(received.expectedRevision, MAXIMUM_REVISION);
  assert.equal(received.onlyIfMissing, true);
  for (const verb of ["media images list", "media images get", "media images describe"]) {
    assert.deepEqual(verbCapabilitiesForSurface(verb, "standard"), ["delegation.content"]);
    assert.deepEqual(verbCapabilitiesForSurface(verb, "docs-presentation"), ["delegation.design"]);
  }
});

test("invalid media image invocations fail before any handler or network call", async (context) => {
  const describe = ["media", "images", "describe", IMAGE_ID];
  const cases = [
    [describe, "media.image_description_choice"],
    [[...describe, "--clear"], "media.image_revision_required"],
    [[...describe, "--description", "Text", "--clear", "--expected-revision", "0"], "media.image_description_choice"],
    [[...describe, "--clear", "--if-missing", "--expected-revision", "0"], "media.image_condition_clear"],
    [[...describe, "--description", " \n", "--if-missing", "--expected-revision", "0"], "media.image_condition_clear"],
    [[...describe, "--description", "\ud800", "--expected-revision", "0"], "media.image_description_invalid"],
    [[...describe, "--description", "Text", "--expected-revision", "9223372036854775808"], "media.image_revision_required"],
    [[...describe, "--description", "Text", "--expected-revision", "0", "--expected-revision", "1"], "cli.duplicate_option"],
    [["media", "images", "list", "--page-size", "0"], "media.image_page_size_invalid"],
    [["media", "images", "list", "--page-size", "101"], "media.image_page_size_invalid"],
    [["media", "images", "list", "--page-size", "--json"], "cli.option_value"],
    [["media", "images", "get", IMAGE_ID.toUpperCase()], "media.image_id_invalid"],
    [["media", "images", "get"], "media.image_id_invalid"],
    [["media", "images", "list", "--clear"], "cli.unknown_option"],
  ];
  for (const [args, code] of cases) {
    await context.test(code + ": " + args.join(" "), async () => {
      let called = false;
      const handlers = Object.fromEntries(["media images list", "media images get", "media images describe"].map((verb) =>
        [verb, async () => { called = true; }]));
      const result = await run(args, handlers);
      assert.equal(result.exit, 2);
      assert.equal(result.result.error.code, code);
      assert.equal(called, false);
    });
  }
});

test("list sends one server-filtered cursor request and reports exact metadata", async () => {
  const calls = [];
  const client = { request: async (route, options) => {
    calls.push({ route, options });
    return { images: [wire({ descriptionRevision: MAXIMUM_REVISION })], nextPageToken: "next\ncursor", totalImages: 9 };
  } };
  const result = await mediaImagesList(invocation(client, { pageSize: 1, pageToken: "old\ncursor", missingDescription: true }));
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].route, "https://app.test/");
  assert.equal(url.searchParams.get("missingDescription"), "true");
  assert.equal(url.searchParams.get("pageToken"), "old\ncursor");
  assert.equal(url.searchParams.get("pageSize"), "1");
  assert.equal(result.images.items[0].descriptionRevision, MAXIMUM_REVISION);
  assert.equal(result.images.items[0].defaultDescription, "A bird");
  assert.equal(result.images.nextPageToken, "next\ncursor");
  assert.equal(result.images.totalImages, 9);
  assert.equal(result.images.count, 1);
  assert.equal(result.cli.version, CLI_VERSION);
});

test("get omits unsafe previews, retains Unicode, and rejects foreign or malformed metadata", async () => {
  for (const value of ["javascript:alert(1)", "https://user:secret@static.test/photo", "https://static.test/photo?token=secret", "https://static.test/photo#secret", "https://static.test/a\nb"])
    assert.equal(safeImagePreviewUrl(value), "");
  const text = "e\u0301 and 😀\nOn a branch";
  const image = (await mediaImagesGet(invocation({ request: async () => wire({ defaultDescription: text,
    url: "https://static.test/photo?token=secret", responsiveUrls: [{ minWidth: 100, url: "https://static.test/safe.webp" }] }) }, { imageId: IMAGE_ID }))).image;
  assert.equal(image.defaultDescription, text);
  assert.equal(image.previewUrl, "");
  assert.deepEqual(image.responsivePreviewUrls, [{ minWidth: 100, url: "https://static.test/safe.webp" }]);
  for (const value of [wire({ siteId: "foreign" }), wire({ ownershipScope: "IMAGE_OWNERSHIP_SCOPE_PROFILE" }),
    wire({ descriptionRevision: 9007199254740992 }), wire({ defaultDescription: 12 })]) {
    await assert.rejects(mediaImagesGet(invocation({ request: async () => value }, { imageId: IMAGE_ID })),
      (error) => error.code === "api.image_description_contract");
  }
});

test("describe sends one conditional PATCH without a preliminary read and translates stable refusal fields", async () => {
  const calls = [];
  const client = { request: async (route, options) => { calls.push({ route, options }); return wire({ descriptionRevision: "4" }); } };
  await mediaImagesDescribe(invocation(client, { imageId: IMAGE_ID, imageDescription: "A bird", expectedRevision: "3", onlyIfMissing: true }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "PATCH");
  assert.deepEqual(calls[0].options.body, { defaultDescription: "A bird", expectedRevision: "3", onlyIfMissing: true });
  for (const [field, code] of [["ExpectedRevision", "media.image_description_conflict"], ["OnlyIfMissing", "media.image_description_exists"],
    ["DefaultDescription", "media.image_description_invalid"]]) {
    const error = new ApiError(400, { code: 3, details: [{ fieldViolations: [{ field, description: "Refused" }] }] });
    await assert.rejects(mediaImagesDescribe(invocation({ request: async () => { throw error; } },
      { imageId: IMAGE_ID, imageDescription: "New", expectedRevision: "3" })), (failure) => failure.code === code && failure.exitCode === 1);
  }
  const permission = new ApiError(403, { code: 7 });
  await assert.rejects(mediaImagesDescribe(invocation({ request: async () => { throw permission; } },
    { imageId: IMAGE_ID, clearDescription: true, expectedRevision: "3" })), (error) => error === permission);
});

test("a list too large for its output bound refuses explicitly without losing a cursor", async () => {
  const long = "😀".repeat(1000);
  const items = Array.from({ length: 25 }, () => wire({ defaultDescription: long }));
  assert.ok(Buffer.byteLength(JSON.stringify(items)) > LIMITS.githubOutputBytes);
  await assert.rejects(mediaImagesList(invocation({ request: async () => ({ images: items, nextPageToken: "later" }) })),
    (error) => error instanceof SiteAuthoringError && error.code === "media.image_page_too_large");
});
