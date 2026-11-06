import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";

const SITE_ID = "aaaa1111-bbbb-4111-8111-cccc11111111";
const FOREIGN_SITE_ID = "eeee5555-ffff-4555-8555-aaaa55555555";
const FIRST_ID = "bbbb2222-cccc-4222-8222-dddd22222222";
const EXISTING_ID = "cccc3333-dddd-4333-8333-eeee33333333";
const SECOND_ID = "dddd4444-eeee-4444-8444-ffff44444444";
const FOREIGN_ID = "ffff6666-aaaa-4666-8666-bbbb66666666";
const KEY = "tr_http_image_description_site_one";
const FOREIGN_KEY = "tr_http_image_description_site_two";
const DENIED_KEY = "tr_http_image_description_without_media";

function record(imageId, siteId = SITE_ID, description = null, revision = "0") {
  return { imageId, siteId, description, revision };
}

function entry(image) {
  return { image: { imageId: image.imageId, siteId: image.siteId,
    ownershipScope: "IMAGE_OWNERSHIP_SCOPE_SITE", uploadedName: "Bird.webp", width: 1600, height: 1200,
    defaultDescription: image.description ?? "", descriptionRevision: image.revision,
    processingState: "IMAGE_PROCESSING_STATE_COMPLETE",
    url: `https://static.test/platform/${image.imageId}/preview.webp`,
    responsiveUrls: [{ minWidth: 640, url: `https://static.test/platform/${image.imageId}/640.webp` }],
  } };
}

async function fixture(context) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "taproot-image-description-http-"));
  const root = await realpath(temporary);
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const configHome = path.join(root, "config-home");
  await mkdir(path.join(project, "site"), { recursive: true });
  await mkdir(path.join(configHome, "taproot-site"), { recursive: true });
  await writeFile(path.join(project, "taproot-site.json"), JSON.stringify({
    configVersion: 1, siteId: SITE_ID, authoringSurface: "standard", workspaceDir: "site",
  }));
  const state = {
    images: new Map([
      [FIRST_ID, record(FIRST_ID)], [EXISTING_ID, record(EXISTING_ID, SITE_ID, "Existing description", "4")],
      [SECOND_ID, record(SECOND_ID)], [FOREIGN_ID, record(FOREIGN_ID, FOREIGN_SITE_ID)],
    ]),
    calls: [], beforePatch: undefined, dropNextPatch: false,
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    let body;
    if (request.method === "PATCH") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    state.calls.push({ method: request.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams),
      authorization: request.headers.authorization, body });
    const reply = (status, value) => {
      response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
    };
    const refused = (field) => reply(400, { code: 3, details: [{ fieldViolations: [{ field, description: "Refused" }] }] });
    if (request.headers.authorization === `Bearer ${DENIED_KEY}`) return reply(403, { code: 7 });
    if (request.headers.authorization !== `Bearer ${KEY}`) return reply(401, { code: 16 });
    const base = `/api/v1/sites/${SITE_ID}/images`;
    if (request.method === "GET" && url.pathname === base) {
      const images = [...state.images.values()].filter((image) => image.siteId === SITE_ID
        && (url.searchParams.get("missingDescription") !== "true" || image.description === null));
      const token = url.searchParams.get("pageToken") ?? "";
      const offset = token ? Number(token.split("\n")[1]) : 0;
      const size = Number(url.searchParams.get("pageSize"));
      const end = Math.min(images.length, offset + size);
      return reply(200, { images: images.slice(offset, end).map(entry), totalImages: images.length,
        nextPageToken: end < images.length ? `cursor\n${end}` : "" });
    }
    const match = url.pathname.match(new RegExp(`^${base}/([0-9a-f-]+)(/description)?$`, "u"));
    const image = match ? state.images.get(match[1]) : undefined;
    if (!image || image.siteId !== SITE_ID) return reply(404, { code: 5 });
    if (request.method === "GET" && !match[2]) return reply(200, entry(image));
    if (request.method === "PATCH" && match[2]) {
      if (state.dropNextPatch) { state.dropNextPatch = false; request.socket.destroy(); return; }
      if (state.beforePatch) { const before = state.beforePatch; state.beforePatch = undefined; before(image, body); }
      if (body.expectedRevision !== image.revision) return refused("ExpectedRevision");
      if (body.onlyIfMissing && image.description !== null) return refused("OnlyIfMissing");
      const description = body.defaultDescription.trim() || null;
      if (description !== null && [...description].length > 1000) return refused("DefaultDescription");
      if (description !== image.description) {
        image.description = description; image.revision = String(BigInt(image.revision) + 1n);
      }
      return reply(200, entry(image));
    }
    return reply(405, { code: 12 });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  await writeFile(path.join(configHome, "taproot-site", "settings.json"), JSON.stringify({
    schemaVersion: 1, apiBaseUrl: `http://127.0.0.1:${server.address().port}/api`,
  }));
  const run = async (arguments_, extraEnvironment = {}) => {
    let stdout = "";
    let stderr = "";
    const exit = await runCli({ arguments_, cwd: project,
      environment: { XDG_CONFIG_HOME: configHome, HOME: configHome, TAPROOT_SITE_KEY: KEY, ...extraEnvironment },
      stdout: { write: (chunk) => { stdout += chunk; } }, stderr: { write: (chunk) => { stderr += chunk; } },
    });
    return { exit, result: JSON.parse(stdout), stdout, stderr };
  };
  return { state, run, root, project };
}

const list = (...args) => ["media", "images", "list", ...args];
const get = (id) => ["media", "images", "get", id];
const describe = (id, text, revision, ...args) => ["media", "images", "describe", id, "--description", text,
  "--expected-revision", revision, ...args];

test("real HTTP fixture pages missing defaults, conditionally saves one, and preserves other scopes", async (context) => {
  const { state, run } = await fixture(context);
  const first = await run(list("--missing-description", "--page-size", "1", "--json"));
  assert.equal(first.exit, 0, first.stderr);
  assert.equal(first.result.images.items[0].imageId, FIRST_ID);
  assert.equal(first.result.images.items[0].defaultDescription, null);
  assert.equal(first.result.images.items[0].descriptionRevision, "0");
  assert.equal(first.result.images.totalImages, 2);
  const second = await run(list("--missing-description", "--page-size", "1", "--page-token", first.result.images.nextPageToken));
  assert.equal(second.exit, 0, second.stderr);
  assert.equal(second.result.images.items[0].imageId, SECOND_ID);
  assert.equal(second.result.images.nextPageToken, "");
  assert.equal(state.calls.length, 2);
  assert.ok(state.calls.every((call) => call.query.missingDescription === "true"));

  const text = "Café 😀\nA bird on a branch.";
  const saved = await run(describe(FIRST_ID, `  ${text}  `, "0", "--if-missing"));
  assert.equal(saved.exit, 0, saved.stderr);
  assert.equal(saved.result.image.defaultDescription, text);
  assert.equal(saved.result.image.descriptionRevision, "1");
  const read = await run(get(FIRST_ID));
  assert.equal(read.exit, 0, read.stderr);
  assert.equal(read.result.image.defaultDescription, text);
  assert.equal(read.result.image.width, 1600);
  assert.equal((await run(list("--missing-description"))).result.images.items[0].imageId, SECOND_ID);

  const populated = await run(describe(EXISTING_ID, "Do not replace", "4", "--if-missing"));
  assert.equal(populated.exit, 1);
  assert.equal(populated.result.error.code, "media.image_description_exists");
  const foreign = await run(get(FOREIGN_ID));
  const foreignWrite = await run(describe(FOREIGN_ID, "Do not replace", "0"));
  assert.equal(foreign.exit, 1);
  assert.equal(foreignWrite.exit, 1);
  assert.equal(state.images.get(EXISTING_ID).description, "Existing description");
  assert.equal(state.images.get(FOREIGN_ID).description, null);
  assert.equal(state.images.get(FOREIGN_ID).revision, "0");
  assert.ok(state.calls.every((call) => call.authorization === `Bearer ${KEY}`));
  assert.ok(!saved.stdout.includes(KEY));
  assert.ok(!saved.stderr.includes(KEY));
});

test("real HTTP conditional race preserves a manual edit and never performs a client preflight", async (context) => {
  const { state, run } = await fixture(context);
  state.beforePatch = (image) => { image.description = "Manual edit"; image.revision = "1"; };
  const racing = await run(describe(FIRST_ID, "Generated proposal", "0", "--if-missing"));
  assert.equal(racing.exit, 1);
  assert.equal(racing.result.error.code, "media.image_description_conflict");
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].method, "PATCH");
  assert.equal(state.images.get(FIRST_ID).description, "Manual edit");
  const conditional = await run(describe(FIRST_ID, "Do not replace", "1", "--if-missing"));
  assert.equal(conditional.result.error.code, "media.image_description_exists");
  const stale = await run(describe(FIRST_ID, "Do not replace", "0"));
  assert.equal(stale.result.error.code, "media.image_description_conflict");
  assert.equal(state.images.get(FIRST_ID).description, "Manual edit");
  assert.equal(state.images.get(FIRST_ID).revision, "1");
});

test("real HTTP keeps the server's Unicode bound, clear normalization, and empty-list semantics", async (context) => {
  const { state, run } = await fixture(context);
  const maximum = "😀".repeat(1000);
  assert.equal((await run(describe(FIRST_ID, maximum, "0"))).exit, 0);
  const oversized = await run(describe(FIRST_ID, maximum + "😀", "1"));
  assert.equal(oversized.exit, 1);
  assert.equal(oversized.result.error.code, "media.image_description_invalid");
  assert.equal(state.images.get(FIRST_ID).description, maximum);
  assert.equal(state.calls.at(-1).body.defaultDescription, maximum + "😀");
  const cleared = await run(["media", "images", "describe", FIRST_ID, "--clear", "--expected-revision", "1"]);
  assert.equal(cleared.exit, 0, cleared.stderr);
  assert.equal(cleared.result.image.defaultDescription, null);
  assert.equal(cleared.result.image.descriptionRevision, "2");
  const blank = await run(describe(FIRST_ID, " \n\t ", "2"));
  assert.equal(blank.exit, 0, blank.stderr);
  assert.equal(blank.result.image.defaultDescription, null);
  for (const image of state.images.values()) if (image.siteId === SITE_ID) image.description = "Present";
  const empty = await run(list("--missing-description"));
  assert.equal(empty.exit, 0, empty.stderr);
  assert.deepEqual(empty.result.images.items, []);
  assert.equal(empty.result.images.count, 0);
  assert.equal(empty.result.images.nextPageToken, "");
});

test("real HTTP retains permission and credential refusals, with no fallback or mutation replay", async (context) => {
  const { state, run } = await fixture(context);
  const denied = await run(describe(FIRST_ID, "Do not write", "0"), { TAPROOT_SITE_KEY: DENIED_KEY });
  assert.equal(denied.exit, 1);
  assert.equal(denied.result.error.code, "api.request_rejected");
  const foreignCredential = await run(get(FIRST_ID), { TAPROOT_SITE_KEY: FOREIGN_KEY });
  assert.equal(foreignCredential.exit, 1);
  assert.equal(foreignCredential.result.error.refusal, "credential_rejected");
  assert.equal(state.calls.length, 2);
  assert.equal(state.images.get(FIRST_ID).description, null);
  state.dropNextPatch = true;
  const ambiguous = await run(describe(FIRST_ID, "Uncertain", "0"));
  assert.equal(ambiguous.exit, 1);
  assert.equal(ambiguous.result.error.code, "transport.mutation_ambiguous");
  assert.equal(state.calls.length, 3);
  assert.equal(state.images.get(FIRST_ID).description, null);
});

test("preview URLs appear only on stdout, while GitHub output retains image metadata", async (context) => {
  const { run, root } = await fixture(context);
  const outputPath = path.join(root, "github-output");
  await writeFile(outputPath, "");
  const result = await run(get(FIRST_ID), { GITHUB_OUTPUT: outputPath });
  assert.equal(result.exit, 0, result.stderr);
  assert.ok(result.result.image.previewUrl.startsWith("https://static.test/"));
  const workflow = await readFile(outputPath, "utf8");
  assert.ok(!workflow.includes(result.result.image.previewUrl));
  assert.ok(!workflow.includes("previewUrl"));
  assert.ok(!workflow.includes("responsivePreviewUrls"));
  assert.ok(workflow.includes(FIRST_ID));
  assert.ok(workflow.includes("descriptionRevision"));
});
