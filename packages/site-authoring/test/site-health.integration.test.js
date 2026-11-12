import { assertTimeCloseTo } from "../test-support/timing.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getSiteHealth } from "../src/api.js";
import { runCli } from "../src/cli.js";
import { SiteApiClient } from "../src/transport.js";

const SITE_ID = "aaaa1111-bbbb-4111-8111-cccc11111111";
const DEPLOYMENT_ID = "bbbb2222-cccc-4222-8222-dddd22222222";
const OUTPUT_ID = "cccc3333-dddd-4333-8333-eeee33333333";
const STAGED_ID = "dddd4444-eeee-4444-8444-ffff44444444";
const IMAGE_ID = "eeee5555-ffff-4555-8555-aaaa55555555";
const FIRST_PAGE_ID = "ffff6666-aaaa-4666-8666-bbbb66666666";
const SECOND_PAGE_ID = "aaaa7777-bbbb-4777-8777-cccc77777777";
const INPUT_HASH = "a".repeat(64);
const CHECKED_AT = "2026-11-04T12:00:00.000Z";
const COVERAGE = ["metadata", "links", "deployment_form_guards", "deployment_image_guards", "image_defaults"];
const PREVIEW_URL = `https://static.example.test/site/${SITE_ID}/${IMAGE_ID}/640.webp`;
const KEY = "tr_http_stored_health_site_key";
const HEALTH_PATH = `/api/v1/sites/${SITE_ID}/health`;

function report(overrides = {}) {
  return {
    status: "complete", deploymentId: DEPLOYMENT_ID, outputReleaseId: OUTPUT_ID,
    inputHash: INPUT_HASH, checkedAt: CHECKED_AT, ruleVersion: "2", coverage: COVERAGE,
    assessedPageCount: 2, environment: "production", ...overrides,
  };
}

function imageFinding(overrides = {}) {
  return {
    imageId: IMAGE_ID, name: "Bird.webp", previewUrl: PREVIEW_URL,
    affectedPages: [
      { pageId: FIRST_PAGE_ID, title: "About", path: "about" },
      { pageId: SECOND_PAGE_ID, title: "Gallery", path: "gallery" },
    ],
    ...overrides,
  };
}

function pageFinding(index = 0) {
  return {
    ruleId: "link.page_missing", severity: "SITE_FINDING_SEVERITY_WARNING",
    pageId: FIRST_PAGE_ID, pageTitle: "About", pagePath: "about", subject: `/missing-${index}`,
  };
}

async function fixture(context, initialReport = report()) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "taproot-stored-health-http-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const configHome = path.join(root, "config-home");
  await mkdir(path.join(project, "site"), { recursive: true });
  await mkdir(path.join(configHome, "taproot-site"), { recursive: true });
  await writeFile(path.join(project, "taproot-site.json"), JSON.stringify({
    configVersion: 1, siteId: SITE_ID, authoringSurface: "standard", workspaceDir: "site",
  }));
  const state = { report: initialReport, calls: [], refusal: undefined };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    state.calls.push({ method: request.method, pathname: url.pathname, query: url.search,
      body: Buffer.concat(chunks).toString("utf8"), authorization: request.headers.authorization });
    const reply = (status, value) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== `Bearer ${KEY}`) return reply(401, { code: 16 });
    if (request.method === "GET" && url.pathname === HEALTH_PATH) {
      if (state.refusal) return reply(state.refusal.httpStatus, { code: state.refusal.code });
      return reply(200, state.report);
    }
    const base = `/api/v1/sites/${SITE_ID}`;
    if (request.method === "GET" && url.pathname === `${base}/deploy/review`) return reply(200, {});
    if (request.method === "POST" && url.pathname === `${base}/publishing/readiness`) {
      return reply(200, { state: "PAGE_PUBLISHING_READINESS_STATE_READY" });
    }
    if (request.method === "GET" && url.pathname === `${base}/deployments`) return reply(200, {});
    if (request.method === "GET" && url.pathname === `${base}/images`) return reply(200, {});
    return reply(404, { code: 5 });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const apiBaseUrl = `http://127.0.0.1:${server.address().port}/api`;
  await writeFile(path.join(configHome, "taproot-site", "settings.json"), JSON.stringify({ schemaVersion: 1, apiBaseUrl }));
  const client = new SiteApiClient({ apiBaseUrl, token: KEY });
  const run = async (extraEnvironment = {}) => {
    let stdout = "";
    let stderr = "";
    const exit = await runCli({ arguments_: ["status"], cwd: project,
      environment: { XDG_CONFIG_HOME: configHome, HOME: configHome, TAPROOT_SITE_KEY: KEY, ...extraEnvironment },
      stdout: { write: (chunk) => { stdout += chunk; } }, stderr: { write: (chunk) => { stderr += chunk; } },
    });
    return { exit, result: JSON.parse(stdout), stdout, stderr };
  };
  return { state, client, run, root };
}

function assertHealthReads(calls, count) {
  assert.equal(calls.length, count);
  for (const call of calls) {
    assert.deepEqual(call, { method: "GET", pathname: HEALTH_PATH, query: "", body: "", authorization: `Bearer ${KEY}` });
  }
}

test("repeated HTTP health reads preserve frozen production identity and one image group with two affected pages", async (context) => {
  const { state, client } = await fixture(context, report({
    findings: [pageFinding()], images: [imageFinding()], warningCount: 2, pageCount: 2,
  }));
  const first = await getSiteHealth(client, SITE_ID);
  const second = await getSiteHealth(client, SITE_ID);
  assert.deepEqual(second, first);
  assert.equal(first.status, "complete");
  assert.equal(first.assessmentKnown, true);
  assert.equal(first.deploymentId, DEPLOYMENT_ID);
  assert.equal(first.outputReleaseId, OUTPUT_ID);
  assert.equal(first.inputHash, INPUT_HASH);
  assertTimeCloseTo(Date.parse(first.checkedAt), Date.parse(CHECKED_AT));
  assert.equal(first.ruleVersion, "2");
  assert.deepEqual(first.coverage, COVERAGE);
  assert.equal(first.assessedPageCount, 2);
  assert.equal(first.environment, "production");
  assert.equal(first.images.length, 1);
  assert.deepEqual(first.images[0], imageFinding());
  assert.deepEqual(first.findings[0], { ...pageFinding(), severity: "warning", detail: "" });
  assertHealthReads(state.calls, 2);
});

test("HTTP health distinguishes missing, unsupported, incomplete and staging assessment metadata", async (context) => {
  const { state, client } = await fixture(context);
  const cases = [
    ["old response", {}, "unknown", false],
    ["future status", { status: "pending_future_check" }, "unknown", false],
    ["no report", { status: "not_checked", stagedDeploymentId: STAGED_ID }, "not_checked", true],
    ["unsupported", { status: "unsupported", coverage: ["managed_docs"] }, "unsupported", true],
    ["incomplete without identity", { status: "incomplete", coverage: ["metadata"] }, "incomplete", true],
    ["incomplete", report({ status: "incomplete", coverage: ["metadata"] }), "incomplete", true],
    ["staging", report({ environment: "staging", stagedDeploymentId: STAGED_ID }), "complete", true],
  ];
  for (const [name, value, status, assessmentKnown] of cases) {
    await context.test(name, async () => {
      state.report = value;
      const result = await getSiteHealth(client, SITE_ID);
      assert.equal(result.status, status);
      assert.equal(result.assessmentKnown, assessmentKnown);
      assert.deepEqual(result.findings, []);
      assert.deepEqual(result.images, []);
      assert.equal(result.errorCount, 0);
      assert.equal(result.warningCount, 0);
      assert.equal(result.pageCount, 0);
      assert.equal(result.environment, value.environment ?? "production");
      assert.equal(result.stagedDeploymentId, value.stagedDeploymentId);
      assert.equal(result.deploymentId, value.deploymentId);
      assert.deepEqual(result.coverage, value.coverage ?? []);
    });
  }
  assertHealthReads(state.calls, cases.length);
});

test("status reports known zero findings separately from unavailable assessments over HTTP", async (context) => {
  const { state, run } = await fixture(context);
  const cases = [
    ["known zero", report({ assessedPageCount: 0 }), "complete", true],
    ["no report", { status: "not_checked" }, "not_checked", false],
    ["old server", {}, "unknown", false],
    ["unsupported", report({ status: "unsupported" }), "unsupported", false],
    ["incomplete without identity", { status: "incomplete" }, "incomplete", false],
    ["partial coverage", report({ status: "incomplete", coverage: ["metadata"] }), "incomplete", true],
  ];
  for (const [name, value, expectedStatus, covered] of cases) {
    await context.test(name, async () => {
      state.report = value;
      const { exit, result, stderr } = await run();
      assert.equal(exit, 0, stderr);
      assert.equal(result.siteHealth.status, expectedStatus);
      assert.equal(result.siteHealth.covered, covered);
      if (covered) {
        assert.equal(result.siteHealth.deploymentId, DEPLOYMENT_ID);
        assert.equal(result.siteHealth.outputReleaseId, OUTPUT_ID);
        assert.equal(result.siteHealth.errors, 0);
        assert.equal(result.siteHealth.warnings, 0);
        assert.equal(result.siteHealth.unpublishedChangesAssessed, false);
        assert.deepEqual(result.siteHealth.coverage, value.coverage);
        assert.deepEqual(result.siteHealth.findings, []);
      } else {
        assert.equal(typeof result.siteHealth.reason, "string");
        assert.equal(Object.hasOwn(result.siteHealth, "errors"), false);
        assert.equal(Object.hasOwn(result.siteHealth, "warnings"), false);
        assert.equal(Object.hasOwn(result.siteHealth, "findings"), false);
      }
    });
  }
  const healthCalls = state.calls.filter((call) => call.pathname === HEALTH_PATH);
  assertHealthReads(healthCalls, cases.length);
  assert.ok(state.calls.every((call) => call.method === "GET"
    || call.method === "POST" && call.pathname.endsWith("/publishing/readiness")));
  assert.ok(state.calls.every((call) => !/\/pages(?:\/|$)|\/checks(?:\/|$)|\/scan(?:\/|$)/u.test(call.pathname)));
});

test("HTTP health refuses missing immutable identity, malformed groups and unsafe count contracts", async (context) => {
  const { state, client } = await fixture(context);
  const cases = [
    ...["complete", "incomplete"].flatMap((status) =>
      ["deploymentId", "outputReleaseId", "inputHash", "checkedAt", "ruleVersion", "coverage"].map((field) => [
        `${status} missing ${field}`, () => { const value = report({ status }); delete value[field]; return value; },
      ])),
    ["empty coverage", () => report({ coverage: [] })],
    ["incomplete empty coverage", () => report({ status: "incomplete", coverage: [] })],
    ["non-object report", () => null],
    ["uppercase deployment ID", () => report({ deploymentId: DEPLOYMENT_ID.toUpperCase() })],
    ["noncanonical output ID", () => report({ outputReleaseId: `{${OUTPUT_ID}}` })],
    ["noncanonical staged ID", () => report({ stagedDeploymentId: STAGED_ID.toUpperCase() })],
    ["invalid input hash", () => report({ inputHash: "a".repeat(63) })],
    ["invalid checked time", () => report({ checkedAt: "2026-11-04" })],
    ["invalid coverage list", () => report({ coverage: {} })],
    ["invalid coverage entry", () => report({ coverage: [1] })],
    ["invalid findings list", () => report({ findings: {} })],
    ["invalid finding page", () => report({ findings: [{ ...pageFinding(), pageId: "not-a-page" }] })],
    ["invalid images list", () => report({ images: {} })],
    ["missing image ID", () => report({ images: [imageFinding({ imageId: undefined })] })],
    ["uppercase image ID", () => report({ images: [imageFinding({ imageId: IMAGE_ID.toUpperCase() })] })],
    ["missing affected pages", () => report({ images: [imageFinding({ affectedPages: undefined })] })],
    ["empty affected pages", () => report({ images: [imageFinding({ affectedPages: [] })] })],
    ["invalid affected pages", () => report({ images: [imageFinding({ affectedPages: {} })] })],
    ["invalid affected page ID", () => report({ images: [imageFinding({ affectedPages: [{ pageId: "foreign-format" }] })] })],
    ...["complete", "incomplete"].flatMap((status) => [
      [`${status} omits retained warnings`, () => report({ status, findings: [pageFinding()] })],
      [`${status} omits retained image warnings`, () => report({ status, images: [imageFinding()] })],
      [`${status} omits retained errors`, () => report({ status,
        findings: [{ ...pageFinding(), severity: "SITE_FINDING_SEVERITY_ERROR" }] })],
      [`${status} overstates untruncated warnings`, () => report({ status, warningCount: 1 })],
      [`${status} overstates untruncated errors`, () => report({ status, errorCount: 1 })],
      [`${status} truncation understates warnings`, () => report({ status,
        findings: [pageFinding()], truncated: true, warningCount: 0 })],
    ]),
    ...["errorCount", "warningCount", "pageCount", "assessedPageCount"].flatMap((field) =>
      [-1, 0.5, "1", Number.MAX_SAFE_INTEGER + 1].map((value) => [`invalid ${field}: ${value}`, () => report({ [field]: value })])),
  ];
  for (const [name, value] of cases) {
    await context.test(name, async () => {
      state.report = value();
      await assert.rejects(getSiteHealth(client, SITE_ID), (error) => error.code === "api.site_health_contract");
    });
  }
  assertHealthReads(state.calls, cases.length);
});

test("HTTP image groups omit unsafe previews without dropping image and affected-page identities", async (context) => {
  const { state, client } = await fixture(context);
  for (const previewUrl of ["http://static.example.test/bird.webp", "https://static.example.test/bird.webp?signature=secret",
    "https://user:password@static.example.test/bird.webp", "javascript:alert(1)", "https://static.example.test/bird.webp#private"]) {
    state.report = report({ images: [imageFinding({ previewUrl })], warningCount: 1 });
    const result = await getSiteHealth(client, SITE_ID);
    assert.equal(result.images[0].previewUrl, "");
    assert.equal(result.images[0].imageId, IMAGE_ID);
    assert.deepEqual(result.images[0].affectedPages, imageFinding().affectedPages);
  }
  assertHealthReads(state.calls, 5);
});

test("status preserves report totals and truncation while keeping image previews out of GitHub output", async (context) => {
  const { state, run, root } = await fixture(context, report({
    findings: Array.from({ length: 101 }, (_, index) => pageFinding(index)), images: [imageFinding()],
    warningCount: 250, pageCount: 180, assessedPageCount: 200, truncated: true,
  }));
  const outputPath = path.join(root, "github-output");
  await writeFile(outputPath, "");
  const { exit, result, stderr } = await run({ GITHUB_OUTPUT: outputPath });
  assert.equal(exit, 0, stderr);
  assert.equal(result.siteHealth.warnings, 250);
  assert.equal(result.siteHealth.pages, 180);
  assert.equal(result.siteHealth.assessedPages, 200);
  assert.equal(result.siteHealth.findings.length, 100);
  assert.equal(result.siteHealth.findingsTruncated, true);
  assert.deepEqual(result.siteHealth.imageFindings, [imageFinding()]);
  const workflow = await readFile(outputPath, "utf8");
  const workflowResult = JSON.parse(workflow.split("\n")[1]);
  const expected = structuredClone(result);
  delete expected.siteHealth.imageFindings[0].previewUrl;
  assert.deepEqual(workflowResult, expected);
  assert.doesNotMatch(workflow, /previewUrl|static\.example\.test/u);
  assertHealthReads(state.calls.filter((call) => call.pathname === HEALTH_PATH), 1);
});

test("HTTP health permission and credential refusals never fall back to an editable scan or replay", async (context) => {
  const { state, client, run } = await fixture(context);
  for (const refusal of [{ httpStatus: 403, code: 7 }, { httpStatus: 401, code: 16 }]) {
    state.refusal = refusal;
    const before = state.calls.length;
    await assert.rejects(getSiteHealth(client, SITE_ID), (error) => error.code === "api.request_rejected");
    assertHealthReads(state.calls.slice(before), 1);
    const { exit, result, stdout, stderr } = await run();
    assert.equal(exit, 1);
    assert.equal(result.error.code, "api.request_rejected");
    assert.equal(Object.hasOwn(result, "siteHealth"), false);
    assert.ok(!`${stdout}${stderr}`.includes(KEY));
  }
  assertHealthReads(state.calls.filter((call) => call.pathname === HEALTH_PATH), 4);
});
