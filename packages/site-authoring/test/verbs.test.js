import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { encodeTheme, parseTheme } from "@taprootio/espalier/shared/theme";

import { INSIDE_MONOREPO, MONOREPO_ONLY } from "./monorepo.js";
import { normalizeImage } from "../src/api.js";
import {
  CAPABILITY_CONTENT,
  CAPABILITY_DEPLOYMENTS,
  CAPABILITY_DESIGN,
  SITE_AUTHORING_CAPABILITIES,
} from "../src/capabilities.js";
import { runCli, VERB_CAPABILITIES } from "../src/cli.js";
import { CAPABILITY_REFUSAL_REASON, EXTERNAL_WRITES_SETTING_KEY } from "../src/constants.js";
import { saveCredential } from "../src/credentials.js";
import { markdownToProseMirror, validateDocument } from "../src/content/index.js";
import { appearanceManifestEntry, footerManifestEntry } from "../src/footer-workspace.js";
import { FOOTER_EXAMPLE, projectFooterSettingsForWorkspace } from "../src/footer-contract.js";
import { computeFooterContentHash, computeFooterDraftHash } from "../src/footer-draft-hash.js";
import { failureResult } from "../src/output.js";
import { REDIRECT_LIMITS } from "../src/redirects-contract.js";
import { approve } from "../src/verbs/approve.js";
import { deploy } from "../src/verbs/deploy.js";
import { footerPush } from "../src/verbs/footer-push.js";
import { VERB_HANDLERS } from "../src/verbs/index.js";
import { mediaUpload } from "../src/verbs/media-upload.js";
import { navPush } from "../src/verbs/nav-push.js";
import { pagesPush } from "../src/verbs/pages-push.js";
import { previewPage } from "../src/verbs/preview-page.js";
import { previewRevoke } from "../src/verbs/preview-revoke.js";
import { pull } from "../src/verbs/pull.js";
import { redirectsPull } from "../src/verbs/redirects-pull.js";
import { redirectsPush } from "../src/verbs/redirects-push.js";
import { status } from "../src/verbs/status.js";
import { themePush } from "../src/verbs/theme-push.js";
import { readWorkspaceFile, workspaceContentHash, writeWorkspaceFile } from "../src/workspace.js";

const SITE_ID = "aaaa1111-bbbb-4111-8111-cccc11111111";
const API_BASE_URL = "https://app.taproot.test/api";
const TOKEN = "tr_live_site_key_that_must_never_be_logged";
const HOME_PAGE_ID = "11111111-1111-4111-8111-111111111111";
const ABOUT_PAGE_ID = "22222222-2222-4222-8222-222222222222";
const STORY_PAGE_ID = "33333333-3333-4333-8333-333333333333";
const NEW_PAGE_ID = "44444444-4444-4444-8444-444444444444";
const PUBLISHING_PAGE_ID = "99999999-9999-4999-8999-999999999999";
const NOT_FOUND_PAGE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IMAGE_ID = "55555555-5555-4555-8555-555555555555";
const DEPLOYMENT_ID = "66666666-6666-4666-8666-666666666666";
const STAGING_DEPLOYMENT_ID = "77777777-7777-4777-8777-777777777777";
const SNAPSHOT_ID = "88888888-8888-4888-8888-888888888888";
const PREVIEW_CAPTURED_AT = "2023-11-14T22:13:20.000Z";
const PREVIEW_EXPIRES_AT = "2023-11-14T23:13:20.000Z";
const HANDOFF_EXPIRES_AT = "2023-11-14T22:15:20.000Z";
const DRAFT_REVISION = `sha256:${"a".repeat(64)}`;
const STAGING_HOST = "authoring-preview.taproot.test";
const HANDOFF_TOKEN = "A".repeat(43);
const HANDOFF_URL = `https://${STAGING_HOST}/_taproot/preview/pages/${ABOUT_PAGE_ID}/${SNAPSHOT_ID}`
  + `?handoff=${HANDOFF_TOKEN}`;
// Three values that must never appear on stdout, on stderr, or in GITHUB_OUTPUT.
const BODY_MARKER = "private-page-body-marker";
const PRESIGNED_URL = "https://objects.example/upload?x-amz-signature=presigned-capability-secret";
// The package's copy of the seeded default theme, pinned byte-for-byte to the
// canonical shared artifact by renderer-parity.test.js.
const DEFAULT_SITE_THEME = JSON.parse(
  await readFile(new URL("./fixtures/default-site-theme.json", import.meta.url), "utf8"),
);
// The Taproot-www fixture is private, unapproved copy that does not ship with
// the package (TR00635). The one test that replays it skips outside the
// monorepo, so its sources are read only where they exist.
const TAPROOT_WWW_FIXTURE_ROOT = new URL(
  "../../../business/playbooks/www-launch/fixtures/taproot-www/",
  import.meta.url,
);
const TAPROOT_WWW_PAGE_PATHS = Object.freeze(["", "about", "pricing", "publishing"]);
const TAPROOT_WWW_PAGE_FILES = Object.freeze({
  "": "index.md",
  about: "about.md",
  pricing: "pricing.md",
  publishing: "publishing.md",
});
const TAPROOT_WWW_PAGE_SOURCES = INSIDE_MONOREPO
  ? Object.freeze(Object.fromEntries(await Promise.all(
    TAPROOT_WWW_PAGE_PATHS.map(async (pagePath) => [
      pagePath,
      await readFile(new URL(`pages/${TAPROOT_WWW_PAGE_FILES[pagePath]}`, TAPROOT_WWW_FIXTURE_ROOT), "utf8"),
    ]),
  )))
  : undefined;
const TAPROOT_WWW_STYLES = INSIDE_MONOREPO
  ? JSON.parse(await readFile(new URL("settings/taproot-styles.json", TAPROOT_WWW_FIXTURE_ROOT), "utf8"))
  : undefined;
const REAL_CONTENT = Object.freeze({ markdownToProseMirror, validateDocument });

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function png(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

async function fixture(testContext, files = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "taproot-site-verbs-"));
  testContext.after(() => rm(base, { recursive: true, force: true }));
  const root = await realpath(base);
  const project = path.join(root, "project");
  const workspaceDir = path.join(project, "site");
  const configHome = path.join(root, "config-home");
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    path.join(project, "taproot-site.json"),
    `${JSON.stringify({ configVersion: 1, siteId: SITE_ID, workspaceDir: "site" })}\n`,
  );
  // The endpoint is machine state since TR00645, so the fixture sets it the way
  // an operator does — `env local` — rather than by a config field that no
  // longer exists. Every invocation below injects this XDG_CONFIG_HOME, so no
  // test can read the endpoint or credential of whoever is running it.
  await mkdir(path.join(configHome, "taproot-site"), { recursive: true });
  await writeFile(
    path.join(configHome, "taproot-site", "settings.json"),
    `${JSON.stringify({ schemaVersion: 1, apiBaseUrl: API_BASE_URL })}\n`,
  );
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(workspaceDir, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      target,
      Buffer.isBuffer(contents)
        ? contents
        : typeof contents === "string"
        ? contents
        : `${JSON.stringify(contents, undefined, 2)}\n`,
    );
  }
  return { root, project, workspaceDir, configHome, configPath: path.join(project, "taproot-site.json") };
}

function workspacePath(site, relative) {
  return path.join(site.workspaceDir, ...relative.split("/"));
}

async function readWorkspaceJson(site, relative) {
  return JSON.parse(await readFile(workspacePath(site, relative), "utf8"));
}

/** For asserting a refusal left a damaged file untouched, JSON or not. */
async function readWorkspaceText(site, relative) {
  return await readFile(workspacePath(site, relative), "utf8");
}

async function workspaceHas(site, relative) {
  try {
    await readFile(workspacePath(site, relative));
    return true;
  } catch {
    return false;
  }
}

function jsonResponse(value, httpStatus = 200) {
  return new Response(JSON.stringify(value), {
    status: httpStatus,
    headers: { "content-type": "application/json" },
  });
}

function violation(field, description = "rejected") {
  return { code: 3, message: "invalid", details: [{ fieldViolations: [{ field, description }] }] };
}

/**
 * Query parameters the double enforces on every matching request, whatever
 * route happens to serve it.
 *
 * This exists because routing on method and pathname alone let two reads ship
 * with no `environment` at all through four review passes: every fixture
 * answered them happily, while the real server refuses
 * `SITE_ENVIRONMENT_UNKNOWN` — the proto3 zero — with an `InvalidArgument`
 * raised before it reads or authorizes anything. A per-route assertion would
 * have caught those two; a contract the double applies by pathname catches the
 * next one too.
 */
const REQUIRED_QUERY = [
  { method: "GET", pattern: /\/navigation$/u, required: { environment: "SITE_ENVIRONMENT_DRAFT" } },
  {
    method: "GET",
    pattern: /^\/api\/v1\/settings\//u,
    required: { entityId: SITE_ID, environment: "SITE_ENVIRONMENT_DRAFT" },
  },
  // The page read's `status` has no single expected value (DRAFT or PUBLISHED
  // depending on the page), but the server refuses the proto3 zero outright
  // (PagesService rejects PAGE_STATUS_UNKNOWN before reading) — so the
  // contract pins presence and forbids the zero rather than pinning a value.
  {
    method: "GET",
    pattern: /^\/api\/v1\/pages\/(?!by_site\/)[^/]+$/u,
    present: ["status"],
    forbidden: { status: "PAGE_STATUS_UNKNOWN" },
  },
];

function api(routes) {
  // `pull` reads the redirect map on every run (TR00702), so a test that is not
  // about redirects would otherwise have to declare the route just to get past
  // it. The default is what a site with no redirects answers; a test that cares
  // declares its own GET route, which wins because route matching takes the
  // first entry.
  const effectiveRoutes = routes.some((route) => route.method === "GET" && route.pattern === REDIRECT_MAP)
    ? routes
    : [...routes, { method: "GET", pattern: REDIRECT_MAP, reply: emptyRedirectMap() }];
  const calls = [];
  const queryViolations = [];
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url);
    const method = init.method ?? "GET";
    const bodyText = typeof init.body === "string" ? init.body : undefined;
    const call = {
      method,
      pathname: target.pathname,
      query: target.searchParams,
      body: bodyText === undefined ? undefined : JSON.parse(bodyText),
      bytes: ArrayBuffer.isView(init.body) ? init.body : undefined,
      headers: init.headers,
    };
    calls.push(call);

    for (const contract of REQUIRED_QUERY) {
      if (contract.method !== method || !contract.pattern.test(target.pathname)) continue;
      const violate = (name, requirement, actual) => {
        queryViolations.push(
          `${method} ${target.pathname} must send ${name} ${requirement}, got ${actual ?? "(absent)"}`,
        );
        // Answered the way the server answers it, so the verb under test sees
        // the failure it would really see rather than a fixture that quietly
        // accepted a malformed read.
        return jsonResponse({ code: 3, message: `Invalid ${name}.` }, 400);
      };
      for (const [name, expected] of Object.entries(contract.required ?? {})) {
        const actual = target.searchParams.get(name);
        if (actual !== expected) return violate(name, `=${expected}`, actual);
      }
      for (const name of contract.present ?? []) {
        if (target.searchParams.get(name) === null) return violate(name, "(present)", null);
      }
      for (const [name, zero] of Object.entries(contract.forbidden ?? {})) {
        const actual = target.searchParams.get(name);
        if (actual === zero) return violate(name, `!=${zero}`, actual);
      }
    }
    // A route may also pin its own expectations for a one-off case.
    for (const route of effectiveRoutes) {
      if (route.method !== method || !route.pattern.test(target.pathname)) continue;
      for (const [name, expected] of Object.entries(route.expectQuery ?? {})) {
        assert.equal(target.searchParams.get(name), expected, `${method} ${target.pathname} query ${name}`);
      }
      const value = typeof route.reply === "function" ? await route.reply(call, calls) : route.reply;
      return value instanceof Response ? value : jsonResponse(value);
    }
    throw new Error(`unrouted ${method} ${target.pathname}`);
  };
  return {
    fetch: fetchImpl,
    calls,
    queryViolations,
    matching: (method, pattern) => calls.filter((call) => call.method === method && pattern.test(call.pathname)),
    /** Fails with the exact missing parameter rather than an opaque API error. */
    assertQueryContracts: () => assert.deepEqual(queryViolations, []),
  };
}

function clock(start = 1_700_000_000_000) {
  let value = start;
  return {
    now: () => value,
    sleep: async (milliseconds) => {
      value += milliseconds;
    },
    // Lets a route fake burn wall-clock the way a slow response would, so a
    // deadline can be exceeded *inside* one paginated read.
    advance: (milliseconds) => {
      value += milliseconds;
    },
  };
}

function invoke(site, wire, extra = {}) {
  const progress = [];
  const timing = clock();
  return {
    progress,
    timing,
    invocation: {
      cwd: site.project,
      configPath: site.configPath,
      environment: { TAPROOT_SITE_KEY: TOKEN, XDG_CONFIG_HOME: site.configHome },
      quiet: false,
      onProgress: (message) => progress.push(message),
      // Every verb in this suite runs behind the same capability gate the
      // server applies, under exactly the set the shipped verb table declares
      // for it. See `capabilityGatedFetch`.
      fetch: capabilityGatedFetch(extra.verb, wire.fetch),
      sleep: timing.sleep,
      now: timing.now,
      // A signal that never fires: the bounded polls below take thousands of
      // attempts, and one real 60s timer per attempt is pure overhead here.
      timeoutSignal: () => new AbortController().signal,
      ...extra,
    },
  };
}

function paragraphDocument(text) {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

function contentStub({ errors = () => [], doc, onConvert } = {}) {
  const calls = { validate: [], convert: [] };
  return {
    calls,
    module: {
      validateDocument(document_, options) {
        calls.validate.push({ document: document_, options });
        return { errors: errors(document_, calls.validate.length) };
      },
      async markdownToProseMirror(markdown, options) {
        calls.convert.push({ markdown, options });
        if (onConvert) await onConvert(options, markdown);
        return { doc: doc ?? paragraphDocument(markdown.trim()) };
      },
    },
  };
}

// A page's site-resource id and a navigation item's id are both GUIDs on the
// wire, so the fixtures derive real UUID shapes instead of readable stand-ins.
function resourceIdFor(pageId) {
  return `bbbb3333-${pageId.slice(9, 13)}-4000-8000-${pageId.slice(24)}`;
}

function navId(index) {
  return `aaaa2222-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function pageSummary(overrides = {}) {
  return {
    pageId: ABOUT_PAGE_ID,
    resourceId: resourceIdFor(overrides.pageId ?? ABOUT_PAGE_ID),
    title: "About",
    path: "about",
    templateType: "TEMPLATE_TYPE_FREE_FORM",
    status: "PAGE_STATUS_PUBLISHED",
    hasDraft: false,
    ...overrides,
  };
}

function freeFormPageDetail(pageId, text) {
  return {
    pageId,
    status: "PAGE_STATUS_PUBLISHED",
    title: "About",
    shortDescription: "The about page.",
    template: {
      templateType: "TEMPLATE_TYPE_FREE_FORM",
      templateVersion: "1.0",
      freeFormData: { body: paragraphDocument(text) },
    },
  };
}

const PAGES_LIST = /^\/api\/v1\/pages\/by_site\//u;
const PAGE_BY_ID = /^\/api\/v1\/pages\/[^/]+$/u;
const PUBLISH_DRAFTS = /^\/api\/v1\/pages\/publish_drafts$/u;
const PAGES_COLLECTION = /^\/api\/v1\/pages$/u;
const NAVIGATION = /\/navigation$/u;
const REDIRECT_MAP = /\/redirects$/u;
// A deterministic stand-in for the server's map hash. It is 64 lowercase hex
// characters because that is what the CLI accepts as a revision; its value
// carries no meaning beyond being stable across a test's read and its push.
const REDIRECT_REVISION = "a".repeat(64);
const NEXT_REDIRECT_REVISION = "b".repeat(64);

function emptyRedirectMap() {
  return { siteId: SITE_ID, revision: REDIRECT_REVISION, entries: [] };
}
const SETTINGS = /^\/api\/v1\/settings\//u;
const SETTING = /^\/api\/v1\/setting$/u;
const FOOTER_SETTINGS = /\/footer-settings$/u;
const READINESS = /\/publishing\/readiness$/u;
const DEPLOY = /\/deploy$/u;
const DEPLOYMENTS = /\/deployments$/u;
const STAGING_PREVIEW_STATUS = /\/staging-preview\/status$/u;
const STAGING_PREVIEW_ROOT = /^\/$/u;
const SITE_IMAGES = /\/sites\/[^/]+\/images$/u;
const REQUEST_UPLOAD = /\/images\/request-upload$/u;
const CONFIRM_UPLOAD = /\/images\/confirm-upload$/u;
const PRESIGNED_PUT = /^\/upload$/u;
const PREVIEW_CREATE = /\/authoring-previews\/pages\/[^/]+$/u;
const PREVIEW_STATUS = /\/authoring-previews\/pages\/[^/]+\/[^/:]+$/u;
const PREVIEW_MINT = /\/authoring-previews\/pages\/[^/]+\/[^/]+:mint-handoff$/u;
// The sign-in exchange, reached with the account credential rather than a site
// one — the only response that reports the platform authoring switch (TR00692).
const TOKEN_EXCHANGE = /^\/api\/v1\/site-authoring\/tokens:exchange$/u;
const EXCHANGED_KEY = "tr_live_exchanged_site_credential_never_logged";

// ── The server's key-mode capability gate, mirrored on the fake wire ─────────
//
// The verb table claims each declared set is the smallest its verb's *requests*
// need. Nothing checked that claim, and two verbs were a capability short of
// reads they make on every run: `nav push` and `deploy` both list the site's
// pages, and that list is gated on a Content permission (TR00691). The whole
// suite therefore runs behind this gate now, so a narrowed declaration fails
// the verb's own tests rather than a production run.
//
// The mirror can drift the other way, which is what the API-side pins in
// `GetSitePagesTests` and `SiteAuthoringKeyPipelineHandlerTests` are for.

/**
 * Which delegation capabilities carry each site permission the CLI's routes are
 * gated on — the client's reading of `SiteDelegationCapabilities`. Any one of
 * them satisfies the gate: `site.media.manage` is in both Content and Design on
 * purpose (a designer who cannot upload a logo cannot set a theme), and
 * `site.staging.view` is the baseline every authoring capability carries.
 */
const PERMISSION_CAPABILITIES = Object.freeze({
  "site.pages.create": [CAPABILITY_CONTENT],
  "site.pages.edit_any": [CAPABILITY_CONTENT],
  "site.pages.publish_any": [CAPABILITY_CONTENT],
  "site.theme.manage": [CAPABILITY_DESIGN],
  "site.media.manage": [CAPABILITY_CONTENT, CAPABILITY_DESIGN],
  "site.staging.view": [CAPABILITY_CONTENT, CAPABILITY_DESIGN, CAPABILITY_DEPLOYMENTS],
  "site.deploy": [CAPABILITY_DEPLOYMENTS],
  "site.deployments.view_any": [CAPABILITY_DEPLOYMENTS],
});

/**
 * The permission each route's key-mode gate resolves, in the order the server
 * resolves it. First match wins, so the narrower pattern is listed first.
 *
 * A route resolves the permission its own gate names. `POST /deploy` resolves
 * further ones on a promotion, which `promotionPermissions` below covers.
 */
const ROUTE_PERMISSIONS = Object.freeze([
  { method: "GET", pattern: PAGES_LIST, permission: "site.pages.edit_any" },
  { method: "POST", pattern: PUBLISH_DRAFTS, permission: "site.pages.publish_any" },
  { method: "POST", pattern: PAGES_COLLECTION, permission: "site.pages.create" },
  { method: "GET", pattern: PAGE_BY_ID, permission: "site.pages.edit_any" },
  { method: "PATCH", pattern: PAGE_BY_ID, permission: "site.pages.edit_any" },
  { method: "GET", pattern: NAVIGATION, permission: "site.theme.manage" },
  { method: "PUT", pattern: NAVIGATION, permission: "site.theme.manage" },
  // A redirect is a content path, so both halves of the map resolve the
  // permission that governs page paths (TR00702).
  { method: "GET", pattern: REDIRECT_MAP, permission: "site.pages.edit_any" },
  { method: "PUT", pattern: REDIRECT_MAP, permission: "site.pages.edit_any" },
  { method: "GET", pattern: SETTINGS, permission: "site.theme.manage" },
  { method: "POST", pattern: SETTING, permission: "site.theme.manage" },
  { method: "POST", pattern: FOOTER_SETTINGS, permission: "site.theme.manage" },
  { method: "GET", pattern: READINESS, permission: "site.deploy" },
  { method: "POST", pattern: DEPLOY, permission: "site.deploy" },
  { method: "GET", pattern: DEPLOYMENTS, permission: "site.deployments.view_any" },
  { method: "GET", pattern: STAGING_PREVIEW_STATUS, permission: "site.staging.view" },
  { method: "GET", pattern: SITE_IMAGES, permission: "site.media.manage" },
  { method: "POST", pattern: REQUEST_UPLOAD, permission: "site.media.manage" },
  { method: "POST", pattern: CONFIRM_UPLOAD, permission: "site.media.manage" },
  { method: "POST", pattern: PREVIEW_MINT, permission: "site.pages.edit_any" },
  { method: "POST", pattern: PREVIEW_CREATE, permission: "site.pages.edit_any" },
  { method: "GET", pattern: PREVIEW_STATUS, permission: "site.pages.edit_any" },
  { method: "DELETE", pattern: PREVIEW_STATUS, permission: "site.pages.edit_any" },
]);

// Reached with the account sign-in rather than a site credential, so no site
// capability applies: the exchange itself, and the two things a sign-in can do.
const UNGATED_API_PATH = /^\/api\/v1\/site-authoring\//u;

/**
 * The transcoded shape `SiteAuthoringKeyDenial` produces: gRPC PermissionDenied
 * carrying one `google.rpc.ErrorInfo` detail. Written out rather than imported
 * so a server-side change to the shape shows up here as a real failure. The
 * shape is applied uniformly on purpose: the routes gated in pipeline
 * handlers still answer Unauthenticated in production, and the mirror models
 * them with the named shape because what it proves is that a declared set is
 * wide enough, not which status the refusal carries.
 */
function capabilityDenialBody(permission, granted, required) {
  return {
    code: 7,
    message: "Permission is not granted in this scope.",
    details: [{
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: CAPABILITY_REFUSAL_REASON,
      domain: "taproot-site-authoring",
      metadata: {
        permission,
        granted: granted.join(","),
        required: required.join(","),
      },
    }],
  };
}

function capabilityDenied(permission, granted, required) {
  return jsonResponse(capabilityDenialBody(permission, granted, required), 403);
}

/**
 * The further permissions a production `POST /deploy` resolves, in the server's
 * order, or an empty list.
 *
 * A promotion carries no selection of its own — the CLI refuses to send one —
 * so the pipeline resolves the promoted staging deployment's *stored* candidate
 * and re-authorizes it: each selected settings group's own permission, and
 * `site.theme.manage` when the stored manifest carries navigation
 * (`DeploySitePipelineHandler.AuthorizeProductionSelectionForKeyAsync`). All
 * four candidate-selectable settings groups name `site.theme.manage` as well,
 * so the settings and navigation halves collapse to that one permission; the
 * stored candidate's pages then add `site.pages.publish_any`, one decision per
 * site.
 *
 * A wire double holds no deployments, so the stored candidate is modelled
 * rather than looked up: `deploy --staging` sends the pulled settings groups and
 * the pulled navigation on every run against a pulled workspace, so a promotion
 * is modelled as promoting a candidate that carried them. The model is
 * deliberately the strict direction. A workspace that pulled neither would
 * stage a pages-only candidate the server would promote without Design, so this
 * can refuse where production would allow — and refusing a case the server
 * permits keeps a declared set honest, while permitting one it refuses is
 * exactly the blind spot that let this ship.
 */
function promotionPermissions(method, pathname, init) {
  if (method !== "POST" || !DEPLOY.test(pathname)) return [];
  let body;
  try {
    body = JSON.parse(typeof init.body === "string" ? init.body : "null");
  } catch {
    return [];
  }
  const promotes = body !== null
    && typeof body === "object"
    && typeof body.stagingDeploymentId === "string"
    && body.stagingDeploymentId !== "";
  return promotes ? ["site.theme.manage", "site.pages.publish_any"] : [];
}

/**
 * Wraps a wire double in the server's key-mode gate, under exactly the
 * capabilities the shipped verb table declares for `verbName`.
 *
 * A verb with no declared set never presents a site credential (help, whoami,
 * login), so it is ungated — but a request from one to a gated route is a
 * mistake worth failing loudly on rather than waving through.
 */
function capabilityGatedFetch(verbName, fetchImpl) {
  const granted = Object.hasOwn(VERB_CAPABILITIES, verbName) ? VERB_CAPABILITIES[verbName] : undefined;
  return async (url, init = {}) => {
    const target = new URL(url);
    const method = init.method ?? "GET";
    const route = ROUTE_PERMISSIONS.find(
      (candidate) => candidate.method === method && candidate.pattern.test(target.pathname),
    );
    if (route === undefined) {
      if (target.pathname.startsWith("/api/v1/") && !UNGATED_API_PATH.test(target.pathname)) {
        throw new Error(
          `No key-mode capability is mapped for ${method} ${target.pathname}. `
            + "Add it to ROUTE_PERMISSIONS with the permission its server gate resolves.",
        );
      }
      return await fetchImpl(url, init);
    }
    if (granted === undefined) {
      throw new Error(
        `The verb '${verbName}' declares no capabilities but called the gated route ${method} `
          + `${target.pathname}.`,
      );
    }
    // The route's own gate first, then anything the server resolves from state
    // the request only names — in the server's order, so the refusal a narrowed
    // credential meets is the one it would meet in production.
    for (const permission of [route.permission, ...promotionPermissions(method, target.pathname, init)]) {
      const required = PERMISSION_CAPABILITIES[permission];
      assert.ok(required !== undefined, `PERMISSION_CAPABILITIES is missing '${permission}'`);
      if (!required.some((capability) => granted.includes(capability))) {
        return capabilityDenied(permission, granted, required);
      }
    }
    return await fetchImpl(url, init);
  };
}

function manifestFixture(pages, extra = {}) {
  return {
    manifestVersion: 6,
    siteId: SITE_ID,
    pulledAt: "2026-08-20T00:00:00.000Z",
    navigation: { file: "nav.json", items: 1 },
    settings: [{ settingsType: "SETTING_TYPE_SITE_HEADER", file: "settings/site-header.json" }],
    settingsSkipped: [],
    footer: footerManifestEntry(projectFooterSettingsForWorkspace({})),
    appearance: appearanceManifestEntry({}),
    pages: pages.map((entry) => entry === null
      ? null
      : {
        workspaceMode: typeof entry?.file === "string" ? "editable" : "metadata-only",
        ...entry,
      }),
    ...extra,
  };
}

function agentTheme(source) {
  return {
    ...structuredClone(source),
    semanticMappings: {},
    anchors: { brand: "#b83280" },
    roles: {
      canvas: "primary",
      ink: { color: "primary", heading: "anchor:brand" },
      accent: { color: "anchor:brand", text: "anchor:brand" },
      action: { color: "anchor:brand", ink: "primary" },
      structure: "primary",
    },
    contexts: {
      feature: { canvas: "anchor:brand", ink: "primary", action: "anchor:brand" },
    },
  };
}

function settingsDocument(settingsType, settings) {
  return { entityId: SITE_ID, settingsType, settings };
}

function themeWorkspace(overrides = {}) {
  const footerSettings = {
    light: {
      backgroundColor: "--esp-color-layer-1",
      textColor: "#222222",
      headingColor: "oklch(0.3 0.1 330)",
      linkColor: "--esp-color-link",
      linkHoverColor: "--esp-color-link-hover",
    },
    dark: {
      backgroundColor: "--esp-color-background",
      textColor: "--esp-color-text",
      headingColor: "#ffffff",
      linkColor: "--esp-color-headings",
      linkHoverColor: "--esp-color-link",
    },
    ...overrides.footerSettings,
  };
  return {
    ".taproot-site-manifest.json": manifestFixture([], {
      footer: footerManifestEntry(footerSettings),
    }),
    "settings/taproot-styles.json": settingsDocument("SETTING_TYPE_TAPROOT_STYLES", {
      lightTheme: agentTheme(DEFAULT_SITE_THEME.light.theme),
      darkTheme: agentTheme(DEFAULT_SITE_THEME.dark.theme),
      defaultScheme: "system",
      fontBrand: "\"Inika\", serif",
      fontWeightBrand: "600",
      fontMenu: "",
      fontWeightMenu: "",
      lightLogoId: "",
      darkLogoId: "",
      lightCanvasImageId: "",
      darkCanvasImageId: "",
      lightCanvasImageOpacity: 0.5,
      darkCanvasImageOpacity: 0.5,
      ...overrides.style,
    }),
    "settings/brand.json": settingsDocument("SETTING_TYPE_BRAND", {
      faviconId: "",
      faviconUrl: "",
      ...overrides.brand,
    }),
    "settings/site-header.json": settingsDocument("SETTING_TYPE_SITE_HEADER", {
      headerLayout: "standard",
      headerWidth: "contained",
      navDrawerStyle: "full-screen",
      navDrawerTransition: "fade",
      brandText: "Taproot",
      brandColor: "--esp-color-headings",
      logoAlt: "Taproot home",
      navMenuDisplay: "auto",
      headerPosition: "normal",
      showThemeToggle: true,
      showBrandText: true,
      brandLogoSize: "standard",
      brandHoverGrow: false,
      lightBrandColor: "#b83280",
      darkBrandColor: "oklch(0.8 0.1 330)",
      ...overrides.header,
    }),
    "settings/site-publishing-preferences.json": settingsDocument(
      "SETTING_TYPE_SITE_PUBLISHING_PREFERENCES",
      {
        footerSettings,
      },
    ),
  };
}

function authorableFooter(overrides = {}) {
  const footer = structuredClone(FOOTER_EXAMPLE);
  footer.linkColumns[0].groups[0].links[0].pageResourceId = resourceIdFor(ABOUT_PAGE_ID);
  return projectFooterSettingsForWorkspace({ ...footer, ...overrides });
}

function footerWorkspace(footer = authorableFooter()) {
  return {
    ".taproot-site-manifest.json": manifestFixture([{
      pageId: ABOUT_PAGE_ID,
      resourceId: resourceIdFor(ABOUT_PAGE_ID),
      path: "about",
      title: "About",
      file: "pages/about.pm.json",
    }], { footer: footerManifestEntry(footer) }),
    "settings/site-publishing-preferences.json": settingsDocument(
      "SETTING_TYPE_SITE_PUBLISHING_PREFERENCES",
      { footerSettings: footer },
    ),
  };
}

// ---------------------------------------------------------------------------
// pull
// ---------------------------------------------------------------------------

test("pull snapshots pages, navigation, and settings with a manifest that maps identity", async (site) => {
  const workspace = await fixture(site);
  const pulledFooterResponse = authorableFooter();
  pulledFooterResponse.light.backgroundImageUrl = "https://cdn.example/light.webp";
  pulledFooterResponse.featureImage.imageUrl = "https://cdn.example/feature.webp";
  pulledFooterResponse.featureImage.responsiveUrls = [{
    minWidth: 640,
    url: "https://cdn.example/feature-640.webp",
  }];
  const wire = api([
    {
      method: "GET",
      pattern: PAGES_LIST,
      reply: (call) => (call.query.get("pageToken")
        ? {
          pages: [pageSummary({ pageId: STORY_PAGE_ID, path: "story", templateType: "TEMPLATE_TYPE_ARTICLE" })],
          nextPageToken: "",
        }
        : {
          // `path` is omitted for the home page on purpose: proto3 drops the
          // zero value, and the empty string is what "home" means.
          pages: [
            pageSummary({
              pageId: HOME_PAGE_ID,
              path: undefined,
              title: "Home",
              status: "PAGE_STATUS_APPROVED",
              hasDraft: true,
            }),
            pageSummary({ pageId: ABOUT_PAGE_ID }),
          ],
          nextPageToken: "cursor-1",
        }),
    },
    {
      method: "GET",
      pattern: PAGE_BY_ID,
      reply: (call) => freeFormPageDetail(call.pathname.split("/").pop(), BODY_MARKER),
    },
    {
      method: "GET",
      pattern: NAVIGATION,
      reply: {
        navItems: [{
          id: navId(1),
          kind: "NAV_ITEM_KIND_PAGE",
          title: "Home",
          resourceId: resourceIdFor(HOME_PAGE_ID),
        }],
      },
    },
    {
      method: "GET",
      pattern: SETTINGS,
      reply: (call) => {
        if (call.pathname.endsWith("SETTING_TYPE_SITE_HEADER")) {
          return {
            settingsType: "SETTING_TYPE_SITE_HEADER",
            headerSettings: { headerLayout: "centered-brand", showThemeToggle: true },
          };
        }
        if (call.pathname.endsWith("SETTING_TYPE_TAPROOT_STYLES")) {
          return { styleSettings: { lightLogoId: IMAGE_ID } };
        }
        if (call.pathname.endsWith("SETTING_TYPE_SITE_PUBLISHING_PREFERENCES")) {
          return { sitePublishingPreferences: { footerSettings: pulledFooterResponse } };
        }
        return {};
      },
    },
  ]);
  const { invocation, progress } = invoke(workspace, wire, { verb: "pull" });
  const result = await pull(invocation);

  assert.equal(result.ok, true);
  assert.equal(result.verb, "pull");
  assert.equal(result.siteId, SITE_ID);
  assert.equal(result.pages.total, 3);
  assert.equal(result.pages.bodies, 2);
  assert.equal(result.navigation.items, 1);
  assert.deepEqual(result.settings.skipped, []);

  // The home page reads its draft, because that is the version an author is
  // editing; the published-only page reads its published body.
  const bodyReads = wire.matching("GET", PAGE_BY_ID);
  assert.equal(bodyReads.length, 2);
  assert.equal(bodyReads[0].query.get("status"), "PAGE_STATUS_DRAFT");
  assert.equal(bodyReads[1].query.get("status"), "PAGE_STATUS_PUBLISHED");

  assert.equal(await workspaceHas(workspace, "pages/index.pm.json"), true);
  assert.equal(await workspaceHas(workspace, "pages/about.pm.json"), true);
  // The article page is snapshotted as metadata only: this CLI authors
  // free-form bodies and does not pretend to round-trip the other templates.
  assert.equal(await workspaceHas(workspace, "pages/story.pm.json"), false);
  assert.deepEqual(
    (await readWorkspaceJson(workspace, "pages/index.pm.json")).content[0].content[0].text,
    BODY_MARKER,
  );
  assert.deepEqual((await readWorkspaceJson(workspace, "nav.json")).navItems.length, 1);

  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.manifestVersion, 6);
  assert.equal(manifest.siteId, SITE_ID);
  assert.equal(manifest.pulledAt, new Date(1_700_000_000_000).toISOString());
  assert.deepEqual(manifest.pages.map((entry) => [
    entry.pageId,
    entry.path,
    entry.status,
    entry.file,
    entry.workspaceMode,
  ]), [
    [HOME_PAGE_ID, "", "PAGE_STATUS_APPROVED", "pages/index.pm.json", "editable"],
    [ABOUT_PAGE_ID, "about", "PAGE_STATUS_PUBLISHED", "pages/about.pm.json", "editable"],
    [STORY_PAGE_ID, "story", "PAGE_STATUS_PUBLISHED", undefined, "metadata-only"],
  ]);
  assert.equal(manifest.pages[0].resourceId, resourceIdFor(HOME_PAGE_ID));
  assert.deepEqual(manifest.appearance.imageIds, [IMAGE_ID]);

  // Every catalogued field is materialized, including the ones proto3 omitted,
  // so a snapshot is readable without knowing which fields were ever set.
  const header = await readWorkspaceJson(workspace, "settings/site-header.json");
  assert.equal(header.settings.headerLayout, "centered-brand");
  assert.equal(header.settings.showThemeToggle, true);
  assert.equal(header.settings.showBrandText, false);
  assert.equal(header.settings.brandText, "");
  const publishing = await readWorkspaceJson(workspace, "settings/site-publishing-preferences.json");
  // The zero member is spelled UNSPECIFIED, not UNKNOWN like most of this
  // contract's enums (protos/Settings.proto). A snapshot naming a member that
  // does not exist is worse than one that omits the field.
  assert.equal(publishing.settings.commentsMode, "SITE_COMMENTS_MODE_UNSPECIFIED");
  assert.equal(publishing.settings.albumBorderWidth, 0);
  // TR00605 owns readable theme documents and the structured footer snapshot;
  // memberships remains plan-derived state rather than authored configuration.
  const styles = await readWorkspaceJson(workspace, "settings/taproot-styles.json");
  assert.deepEqual(styles.settings.lightTheme, {});
  assert.deepEqual(styles.settings.darkTheme, {});
  assert.deepEqual(
    publishing.settings.footerSettings,
    projectFooterSettingsForWorkspace(pulledFooterResponse),
  );
  assert.equal("backgroundImageUrl" in publishing.settings.footerSettings.light, false);
  assert.equal("imageUrl" in publishing.settings.footerSettings.featureImage, false);
  assert.equal("responsiveUrls" in publishing.settings.footerSettings.featureImage, false);
  assert.equal(manifest.footer.file, "settings/site-publishing-preferences.json");
  assert.equal(
    manifest.footer.expectedDraftHash,
    footerManifestEntry(publishing.settings.footerSettings).expectedDraftHash,
  );
  assert.equal(
    manifest.footer.expectedContentHash,
    computeFooterContentHash(publishing.settings.footerSettings),
  );
  assert.deepEqual(
    manifest.footer.imageIds,
    [
      publishing.settings.footerSettings.light.backgroundImageId,
      publishing.settings.footerSettings.featureImage.imageId,
    ].sort(),
  );
  assert.equal("membershipsEnabled" in publishing.settings, false);
  assert.ok(progress.some((line) => line.includes(".taproot-site-manifest.json")));
  wire.assertQueryContracts();
});

test("pull preserves stored footer values that footer push must reject for authoring", async (site) => {
  const workspace = await fixture(site);
  const storedFooter = projectFooterSettingsForWorkspace({
    bottomLinks: [{ id: navId(21), label: "Legacy", externalUrl: "https://good.example/a\\b" }],
    asideBodyContent: { paragraphs: [{ runs: [{ text: "Stored\u0001text" }] }] },
  });
  const wire = api([
    { method: "GET", pattern: PAGES_LIST, reply: { pages: [], nextPageToken: "" } },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    {
      method: "GET",
      pattern: SETTINGS,
      reply: (call) => call.pathname.endsWith("SETTING_TYPE_SITE_PUBLISHING_PREFERENCES")
        ? { sitePublishingPreferences: { footerSettings: storedFooter } }
        : {},
    },
  ]);

  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  const publishing = await readWorkspaceJson(workspace, "settings/site-publishing-preferences.json");
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(publishing.settings.footerSettings.bottomLinks[0].externalUrl, "https://good.example/a\\b");
  assert.equal(
    publishing.settings.footerSettings.asideBodyContent.paragraphs[0].runs[0].text,
    "Stored\u0001text",
  );
  assert.equal(manifest.footer.expectedDraftHash, computeFooterDraftHash(storedFooter));

  const callsAfterPull = wire.calls.length;
  await assert.rejects(
    footerPush(invoke(workspace, wire, { verb: "footer push" }).invocation),
    (error) => error?.code === "footer.url_invalid"
      && error?.field === "footerSettings.bottomLinks[0].externalUrl",
  );
  assert.equal(wire.calls.length, callsAfterPull);

  publishing.settings.footerSettings.bottomLinks[0].externalUrl = "https://good.example/ab";
  await writeFile(
    workspacePath(workspace, "settings/site-publishing-preferences.json"),
    `${JSON.stringify(publishing, undefined, 2)}\n`,
  );
  await assert.rejects(
    footerPush(invoke(workspace, wire, { verb: "footer push" }).invocation),
    (error) => error?.code === "footer.text_invalid"
      && error?.field === "footerSettings.asideBodyContent.paragraphs[0].runs[0].text",
  );
  assert.equal(wire.calls.length, callsAfterPull);
});

test("the draft reads name their environment, which has no default", async (site) => {
  const workspace = await fixture(site);
  const wire = api([
    { method: "GET", pattern: PAGES_LIST, reply: { pages: [], nextPageToken: "" } },
    {
      method: "GET",
      pattern: NAVIGATION,
      // Pinned on the route as well as by the double's global contract, so the
      // expectation is readable at the point someone edits this fixture.
      expectQuery: { environment: "SITE_ENVIRONMENT_DRAFT" },
      reply: { navItems: [] },
    },
    {
      method: "GET",
      pattern: SETTINGS,
      expectQuery: { entityId: SITE_ID, environment: "SITE_ENVIRONMENT_DRAFT" },
      reply: {},
    },
  ]);
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  // Omitting `environment` binds SITE_ENVIRONMENT_UNKNOWN, which both handlers
  // refuse outright before they read or authorize anything — so an absent
  // parameter is a 400, not a default. Draft is also the only branch gated on
  // SiteThemeManage, which is the permission the key holds.
  const navigationRead = wire.matching("GET", NAVIGATION)[0];
  assert.equal(navigationRead.query.get("environment"), "SITE_ENVIRONMENT_DRAFT");
  const settingsReads = wire.matching("GET", SETTINGS);
  assert.equal(settingsReads.length, 4);
  for (const read of settingsReads) {
    assert.equal(read.query.get("environment"), "SITE_ENVIRONMENT_DRAFT");
    assert.equal(read.query.get("entityId"), SITE_ID);
  }
  wire.assertQueryContracts();
});

test("agent theme text outside Latin-1 round-trips through pull and push", async (site) => {
  const workspace = await fixture(site);
  const light = agentTheme(DEFAULT_SITE_THEME.light.theme);
  const dark = agentTheme(DEFAULT_SITE_THEME.dark.theme);
  light.fontBrand = "\"日本語 😀\", serif";
  dark.fontBrand = "\"日本語 😀\", serif";
  const pulledThemeWorkspace = themeWorkspace();
  const styleSettings = {
    ...pulledThemeWorkspace["settings/taproot-styles.json"].settings,
    lightTheme: encodeTheme(light),
    darkTheme: encodeTheme(dark),
    lightLogoId: IMAGE_ID,
  };
  const wire = api([
    { method: "GET", pattern: PAGES_LIST, reply: { pages: [], nextPageToken: "" } },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    {
      method: "GET",
      pattern: SETTINGS,
      reply: (call) => {
        if (call.pathname.endsWith("SETTING_TYPE_TAPROOT_STYLES")) return { styleSettings };
        if (call.pathname.endsWith("SETTING_TYPE_BRAND")) {
          return { brandSettings: pulledThemeWorkspace["settings/brand.json"].settings };
        }
        if (call.pathname.endsWith("SETTING_TYPE_SITE_HEADER")) {
          return { headerSettings: pulledThemeWorkspace["settings/site-header.json"].settings };
        }
        return {
          sitePublishingPreferences:
            pulledThemeWorkspace["settings/site-publishing-preferences.json"].settings,
        };
      },
    },
  ]);

  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  const styles = await readWorkspaceJson(workspace, "settings/taproot-styles.json");
  assert.equal(styles.settings.lightTheme.fontBrand, "\"日本語 😀\", serif");
  assert.equal(styles.settings.darkTheme.fontBrand, "\"日本語 😀\", serif");
  assert.deepEqual(
    (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).appearance.imageIds,
    [IMAGE_ID],
  );

  const pushWire = api([
    { method: "GET", pattern: SETTINGS, reply: { sitePublishingPreferences: { footerSettings: {} } } },
    { method: "POST", pattern: FOOTER_SETTINGS, reply: { footerSettings: {} } },
    { method: "POST", pattern: SETTING, reply: {} },
  ]);
  await themePush(invoke(workspace, pushWire, { verb: "theme push" }).invocation);
  const themeWrites = pushWire.matching("POST", SETTING).slice(-2);
  for (const write of themeWrites) {
    assert.equal(parseTheme(write.body.value)?.fontBrand, "\"日本語 😀\", serif");
  }
});

test("pull refuses a malformed non-empty stored theme instead of snapshotting an empty theme", async (site) => {
  const workspace = await fixture(site);
  const wire = api([
    {
      method: "GET",
      pattern: PAGES_LIST,
      reply: { pages: [pageSummary({ pageId: ABOUT_PAGE_ID, path: "about" })], nextPageToken: "" },
    },
    { method: "GET", pattern: PAGE_BY_ID, reply: freeFormPageDetail(ABOUT_PAGE_ID, "about") },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    {
      method: "GET",
      pattern: SETTINGS,
      reply: (call) => call.pathname.endsWith("SETTING_TYPE_TAPROOT_STYLES")
        ? { styleSettings: { lightTheme: "not-base64", darkTheme: "" } }
        : {},
    },
  ]);

  await assert.rejects(
    pull(invoke(workspace, wire, { verb: "pull" }).invocation),
    (error) => error?.code === "api.theme_contract" && error?.field === "lightTheme",
  );
  assert.equal(await workspaceHas(workspace, "settings/taproot-styles.json"), false);
  assert.equal(await workspaceHas(workspace, "pages/about.pm.json"), false);
  assert.equal(await workspaceHas(workspace, "nav.json"), false);
});

test("the settings catalog materializes only real enum members", async (site) => {
  const workspace = await fixture(site);
  const wire = api([
    { method: "GET", pattern: PAGES_LIST, reply: { pages: [], nextPageToken: "" } },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    { method: "GET", pattern: SETTINGS, reply: {} },
  ]);
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  // Every zero this CLI writes into a snapshot, pinned against the wire's own
  // member names. A value the server would not recognize is a snapshot that
  // cannot be read back.
  const snapshots = {
    "settings/taproot-styles.json": {
      lightTheme: {},
      darkTheme: {},
      defaultScheme: "",
      lightCanvasImageOpacity: 0,
      darkLogoId: "",
    },
    "settings/brand.json": { faviconId: "", faviconUrl: "" },
    "settings/site-header.json": {
      headerLayout: "",
      headerWidth: "",
      navDrawerStyle: "",
      navDrawerTransition: "",
      showThemeToggle: false,
      showBrandText: false,
      brandLogoSize: "",
      brandHoverGrow: false,
    },
    "settings/site-publishing-preferences.json": {
      commentsMode: "SITE_COMMENTS_MODE_UNSPECIFIED",
      allowSearch: false,
      albumSeamless: false,
      tiptapImageMaxHeightVh: 0,
      tiptapImageBorderWidth: 0,
      albumBorderWidth: 0,
      tiptapImagePlacement: "",
      footerSettings: projectFooterSettingsForWorkspace({}),
    },
  };
  for (const [file, expected] of Object.entries(snapshots)) {
    const written = await readWorkspaceJson(workspace, file);
    for (const [field, value] of Object.entries(expected)) {
      assert.deepEqual(written.settings[field], value, `${file} ${field}`);
    }
  }
});

test("pull records a settings group the credential cannot read instead of failing", async (site) => {
  const workspace = await fixture(site);
  const wire = api([
    { method: "GET", pattern: PAGES_LIST, reply: { pages: [], nextPageToken: "" } },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    {
      method: "GET",
      pattern: SETTINGS,
      // The production shape: the named capability denial the settings read
      // gate attaches (TR00691), not a bare 403.
      reply: (call) => (call.pathname.endsWith("SETTING_TYPE_TAPROOT_STYLES")
        ? capabilityDenied("site.theme.manage", [CAPABILITY_CONTENT], [CAPABILITY_DESIGN])
        : {}),
    },
  ]);
  const { invocation } = invoke(workspace, wire, { verb: "pull" });
  const result = await pull(invocation);
  assert.deepEqual(result.settings.skipped, ["SETTING_TYPE_TAPROOT_STYLES"]);
  assert.equal(result.settings.pulled.includes("SETTING_TYPE_SITE_HEADER"), true);
  assert.equal(await workspaceHas(workspace, "settings/taproot-styles.json"), false);
  assert.equal(
    (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).appearance,
    undefined,
  );
});

// ---------------------------------------------------------------------------
// theme push
// ---------------------------------------------------------------------------

test("theme push validates roles, contexts, and anchors before saving themes last", async (site) => {
  const workspace = await fixture(site, {
    ...themeWorkspace({ style: { lightLogoId: IMAGE_ID } }),
    ".taproot-site-media.json": {
      mediaManifestVersion: 2,
      siteId: SITE_ID,
      media: { "media/logo.png": { imageId: IMAGE_ID } },
    },
  });
  const currentFooter = {
    enabled: true,
    showBrand: false,
    bottomLinks: [{ id: navId(9), label: "Privacy", externalUrl: "https://example.test/privacy" }],
    light: { backgroundImageOpacity: 0.4, backgroundPresentation: "FOOTER_BACKGROUND_PRESENTATION_COVER" },
    dark: { backgroundFade: "FOOTER_FADE_MODE_BOTTOM", additionalTopPaddingRem: 2 },
  };
  const wire = api([
    {
      method: "GET",
      pattern: SETTINGS,
      reply: { sitePublishingPreferences: { footerSettings: currentFooter } },
    },
    {
      method: "POST",
      pattern: FOOTER_SETTINGS,
      reply: (call) => ({ footerSettings: call.body.footerSettings, footerDraftHash: "next" }),
    },
    { method: "POST", pattern: SETTING, reply: {} },
  ]);

  const { invocation, progress } = invoke(workspace, wire, { verb: "theme push" });
  const result = await themePush(invocation);

  assert.equal(result.ok, true);
  assert.equal(result.verb, "theme push");
  assert.equal(result.written.items.length, 30);
  const mutations = wire.calls.filter((call) => call.method === "POST");
  assert.equal(mutations[0].pathname, `/api/v1/sites/${SITE_ID}/footer-settings`);
  assert.deepEqual(mutations[0].body.footerSettings.bottomLinks, currentFooter.bottomLinks);
  assert.equal(mutations[0].body.footerSettings.light.backgroundImageOpacity, 0.4);
  assert.equal(mutations[0].body.footerSettings.light.backgroundColor, "--esp-color-layer-1");
  assert.match(mutations[0].body.expectedFooterDraftHash, /^[0-9a-f]{64}$/u);
  assert.equal(
    mutations.find((call) => call.body.setting === "lightLogoId")?.body.value,
    IMAGE_ID,
  );

  const last = mutations.slice(-2);
  assert.deepEqual(last.map((call) => call.body.setting), ["lightTheme", "darkTheme"]);
  for (const call of last) {
    const decoded = JSON.parse(Buffer.from(call.body.value, "base64").toString("utf8"));
    assert.deepEqual(decoded.roles.action, { color: "anchor:brand", ink: "primary" });
    assert.equal(decoded.contexts.feature.canvas, "anchor:brand");
    assert.equal(decoded.anchors.brand, "#b83280");
    assert.deepEqual(decoded.semanticMappings, {});
  }
  assert.ok(progress.some((line) => line.includes("externally managed")));
  wire.assertQueryContracts();
});

test("theme push refuses an incomplete pair before the first API call", async (site) => {
  const invalidLight = agentTheme(DEFAULT_SITE_THEME.light.theme);
  delete invalidLight.roles;
  const workspace = await fixture(site, themeWorkspace({ style: { lightTheme: invalidLight } }));
  const wire = api([]);

  await assert.rejects(
    themePush(invoke(workspace, wire, { verb: "theme push" }).invocation),
    (error) => error?.code === "theme.incomplete" && error?.field === "lightTheme.roles",
  );
  assert.equal(wire.calls.length, 0);
});

test("theme push refuses an image id not proven by pull or media upload before its footer write", async (site) => {
  const workspace = await fixture(site, themeWorkspace());
  const styles = await readWorkspaceJson(workspace, "settings/taproot-styles.json");
  styles.settings.lightLogoId = IMAGE_ID;
  await writeFile(
    workspacePath(workspace, "settings/taproot-styles.json"),
    `${JSON.stringify(styles, undefined, 2)}\n`,
  );
  const wire = api([]);

  await assert.rejects(
    themePush(invoke(workspace, wire, { verb: "theme push" }).invocation),
    (error) =>
      error?.code === "theme.image_reference_unknown"
      && error?.field === "taproot-styles.lightLogoId",
  );
  assert.equal(wire.calls.length, 0);
});

test("theme push refuses footer values outside their semantic allowlists before mutation", async (site) => {
  const workspace = await fixture(
    site,
    themeWorkspace({
      footerSettings: {
        light: {
          backgroundColor: "--esp-color-text",
          textColor: "",
          headingColor: "",
          linkColor: "",
          linkHoverColor: "",
        },
      },
    }),
  );
  const wire = api([]);

  await assert.rejects(
    themePush(invoke(workspace, wire, { verb: "theme push" }).invocation),
    (error) =>
      error?.code === "theme.color_invalid"
      && error?.field === "footerSettings.light.backgroundColor",
  );
  assert.equal(wire.calls.length, 0);
});

test("theme push rejects explicit null footer colors before mutation", async (site) => {
  const workspace = await fixture(
    site,
    themeWorkspace({
      footerSettings: {
        light: {
          backgroundColor: null,
          textColor: "",
          headingColor: "",
          linkColor: "",
          linkHoverColor: "",
        },
      },
    }),
  );
  const wire = api([]);

  await assert.rejects(
    themePush(invoke(workspace, wire, { verb: "theme push" }).invocation),
    (error) =>
      error?.code === "theme.color_invalid"
      && error?.field === "footerSettings.light.backgroundColor",
  );
  assert.equal(wire.calls.length, 0);
});

test("theme push reports writes completed before a later remote refusal", async (site) => {
  const workspace = await fixture(site, themeWorkspace());
  const wire = api([
    {
      method: "GET",
      pattern: SETTINGS,
      reply: { sitePublishingPreferences: { footerSettings: {} } },
    },
    { method: "POST", pattern: FOOTER_SETTINGS, reply: { footerSettings: {} } },
    {
      method: "POST",
      pattern: SETTING,
      reply: () => jsonResponse(violation("ExternalApiKey"), 401),
    },
  ]);

  let rejected;
  try {
    await themePush(invoke(workspace, wire, { verb: "theme push" }).invocation);
  } catch (error) {
    rejected = error;
  }

  assert.equal(rejected?.code, "api.request_rejected");
  assert.deepEqual(rejected?.completedWrites, ["footerSettings.light/dark colors"]);
  assert.deepEqual(failureResult(rejected).error.completedWrites, ["footerSettings.light/dark colors"]);
});

test("theme push can project stricter stored footer values after its color write", async (site) => {
  const workspace = await fixture(site, themeWorkspace());
  const currentFooter = projectFooterSettingsForWorkspace({
    bottomLinks: [{ id: navId(22), label: "Legacy", externalUrl: "https://good.example/a\\b" }],
    asideBodyContent: { paragraphs: [{ runs: [{ text: "Stored\u0001text" }] }] },
  });
  const wire = api([
    {
      method: "GET",
      pattern: SETTINGS,
      reply: { sitePublishingPreferences: { footerSettings: currentFooter } },
    },
    {
      method: "POST",
      pattern: FOOTER_SETTINGS,
      reply: (call) => ({ footerSettings: call.body.footerSettings }),
    },
    { method: "POST", pattern: SETTING, reply: {} },
  ]);

  const result = await themePush(invoke(workspace, wire, { verb: "theme push" }).invocation);

  assert.equal(result.ok, true);
  const save = wire.matching("POST", FOOTER_SETTINGS)[0];
  assert.equal(save.body.expectedFooterDraftHash, computeFooterDraftHash(currentFooter));
  const publishing = await readWorkspaceJson(workspace, "settings/site-publishing-preferences.json");
  assert.equal(publishing.settings.footerSettings.bottomLinks[0].externalUrl, "https://good.example/a\\b");
  assert.equal(
    publishing.settings.footerSettings.asideBodyContent.paragraphs[0].runs[0].text,
    "Stored\u0001text",
  );
});

test("theme push refuses an unpushed footer-content edit before any request or write", async (site) => {
  const workspace = await fixture(site, themeWorkspace());
  const document_ = await readWorkspaceJson(workspace, "settings/site-publishing-preferences.json");
  document_.settings.footerSettings.bottomLinks = [
    { id: navId(31), label: "Careers", externalUrl: "https://example.test/careers" },
  ];
  const editedDocument = `${JSON.stringify(document_, undefined, 2)}\n`;
  await writeFile(workspacePath(workspace, "settings/site-publishing-preferences.json"), editedDocument);
  const manifestBefore = await readWorkspaceText(workspace, ".taproot-site-manifest.json");
  const wire = api([]);

  await assert.rejects(
    themePush(invoke(workspace, wire, { verb: "theme push" }).invocation),
    (error) =>
      error?.code === "theme.unpushed_footer_content"
      && error?.field === "settings/site-publishing-preferences.json"
      && error?.message.includes("footer push"),
  );

  assert.equal(wire.calls.length, 0);
  assert.equal(await readWorkspaceText(workspace, "settings/site-publishing-preferences.json"), editedDocument);
  assert.equal(await readWorkspaceText(workspace, ".taproot-site-manifest.json"), manifestBefore);
});

test("theme push maps a hand-edited null link entry to the content refusal, not a generic failure", async (site) => {
  const workspace = await fixture(site, themeWorkspace());
  const document_ = await readWorkspaceJson(workspace, "settings/site-publishing-preferences.json");
  document_.settings.footerSettings.bottomLinks = [null];
  await writeFile(
    workspacePath(workspace, "settings/site-publishing-preferences.json"),
    `${JSON.stringify(document_, undefined, 2)}\n`,
  );
  const wire = api([]);

  await assert.rejects(
    themePush(invoke(workspace, wire, { verb: "theme push" }).invocation),
    (error) =>
      error?.code === "theme.unpushed_footer_content"
      && error?.field === "settings/site-publishing-preferences.json",
  );
  assert.equal(wire.calls.length, 0);
});

test("theme push refuses a type-shifted footer edit the canonical form would normalize away", async (site) => {
  const workspace = await fixture(site, themeWorkspace());
  const document_ = await readWorkspaceJson(workspace, "settings/site-publishing-preferences.json");
  document_.settings.footerSettings.enabled = "true";
  await writeFile(
    workspacePath(workspace, "settings/site-publishing-preferences.json"),
    `${JSON.stringify(document_, undefined, 2)}\n`,
  );
  const wire = api([]);

  await assert.rejects(
    themePush(invoke(workspace, wire, { verb: "theme push" }).invocation),
    (error) =>
      error?.code === "theme.unpushed_footer_content"
      && error?.field === "settings/site-publishing-preferences.json",
  );
  assert.equal(wire.calls.length, 0);
});

test("theme push proceeds when only the ten overlay colors differ from the pull baseline", async (site) => {
  const workspace = await fixture(site, themeWorkspace());
  const document_ = await readWorkspaceJson(workspace, "settings/site-publishing-preferences.json");
  document_.settings.footerSettings.light.backgroundColor = "#f6efe8";
  document_.settings.footerSettings.dark.headingColor = "oklch(0.9 0.05 330)";
  await writeFile(
    workspacePath(workspace, "settings/site-publishing-preferences.json"),
    `${JSON.stringify(document_, undefined, 2)}\n`,
  );
  const currentFooter = projectFooterSettingsForWorkspace({
    bottomLinks: [{ id: navId(32), label: "Remote", externalUrl: "https://example.test/remote" }],
  });
  const wire = api([
    {
      method: "GET",
      pattern: SETTINGS,
      reply: { sitePublishingPreferences: { footerSettings: currentFooter } },
    },
    {
      method: "POST",
      pattern: FOOTER_SETTINGS,
      reply: (call) => ({ footerSettings: call.body.footerSettings }),
    },
    { method: "POST", pattern: SETTING, reply: {} },
  ]);

  const result = await themePush(invoke(workspace, wire, { verb: "theme push" }).invocation);

  assert.equal(result.ok, true);
  const save = wire.matching("POST", FOOTER_SETTINGS)[0];
  assert.equal(save.body.footerSettings.light.backgroundColor, "#f6efe8");
  assert.equal(save.body.footerSettings.dark.headingColor, "oklch(0.9 0.05 330)");
  assert.deepEqual(save.body.footerSettings.bottomLinks, currentFooter.bottomLinks);
  const written = await readWorkspaceJson(workspace, "settings/site-publishing-preferences.json");
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(
    manifest.footer.expectedContentHash,
    computeFooterContentHash(written.settings.footerSettings),
  );
});

test("theme push refuses a workspace pulled before the footer-content baseline", async (site) => {
  const files = themeWorkspace();
  delete files[".taproot-site-manifest.json"].footer.expectedContentHash;
  const workspace = await fixture(site, files);
  const wire = api([]);

  await assert.rejects(
    themePush(invoke(workspace, wire, { verb: "theme push" }).invocation),
    (error) =>
      error?.code === "theme.pull_required"
      && error?.field === "footer.expectedContentHash"
      && error?.message.includes("footer push")
      && error?.message.includes("'taproot-site pull'"),
  );
  assert.equal(wire.calls.length, 0);
});

// ---------------------------------------------------------------------------
// footer push
// ---------------------------------------------------------------------------

test("footer push replaces the complete validated document and advances its local token", async (site) => {
  const footer = authorableFooter();
  const workspace = await fixture(site, footerWorkspace(footer));
  const wire = api([{
    method: "POST",
    pattern: FOOTER_SETTINGS,
    reply: (call) => {
      const response = structuredClone(call.body.footerSettings);
      response.light.backgroundImageUrl = "https://cdn.example/light.webp";
      response.featureImage.imageUrl = "https://cdn.example/feature.webp";
      response.featureImage.responsiveUrls = [{ minWidth: 640, url: "https://cdn.example/feature-640.webp" }];
      return { footerSettings: response };
    },
  }]);

  const result = await footerPush(invoke(workspace, wire, { verb: "footer push" }).invocation);

  assert.equal(result.ok, true);
  assert.equal(result.verb, "footer push");
  assert.match(result.footerDraftHash, /^[0-9a-f]{64}$/u);
  const save = wire.matching("POST", FOOTER_SETTINGS)[0];
  assert.equal(save.body.expectedFooterDraftHash, footerManifestEntry(footer).expectedDraftHash);
  assert.equal(save.body.footerSettings.light.backgroundImageId, footer.light.backgroundImageId);
  assert.equal("backgroundImageUrl" in save.body.footerSettings.light, false);
  assert.equal("imageUrl" in save.body.footerSettings.featureImage, false);

  const written = await readWorkspaceJson(workspace, "settings/site-publishing-preferences.json");
  assert.equal("backgroundImageUrl" in written.settings.footerSettings.light, false);
  assert.equal("imageUrl" in written.settings.footerSettings.featureImage, false);
  assert.equal("responsiveUrls" in written.settings.footerSettings.featureImage, false);
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.footer.expectedDraftHash, result.footerDraftHash);
  assert.equal(
    manifest.footer.expectedContentHash,
    computeFooterContentHash(written.settings.footerSettings),
  );
  assert.deepEqual(
    manifest.footer.imageIds,
    [
      footer.light.backgroundImageId,
      footer.featureImage.imageId,
    ].sort(),
  );
});

test("footer push heals a manifest that predates the footer-content baseline", async (site) => {
  const footer = authorableFooter();
  const files = footerWorkspace(footer);
  delete files[".taproot-site-manifest.json"].footer.expectedContentHash;
  const workspace = await fixture(site, files);
  const wire = api([{
    method: "POST",
    pattern: FOOTER_SETTINGS,
    reply: (call) => ({ footerSettings: call.body.footerSettings }),
  }]);

  const result = await footerPush(invoke(workspace, wire, { verb: "footer push" }).invocation);

  assert.equal(result.ok, true);
  const written = await readWorkspaceJson(workspace, "settings/site-publishing-preferences.json");
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(
    manifest.footer.expectedContentHash,
    computeFooterContentHash(written.settings.footerSettings),
  );
});

test("footer push maps a stale draft token to stable pull-and-reconcile guidance without local writes", async (site) => {
  const footer = authorableFooter();
  const workspace = await fixture(site, footerWorkspace(footer));
  const beforeSettings = await readWorkspaceText(workspace, "settings/site-publishing-preferences.json");
  const beforeManifest = await readWorkspaceText(workspace, ".taproot-site-manifest.json");
  const wire = api([{
    method: "POST",
    pattern: FOOTER_SETTINGS,
    reply: () => jsonResponse(violation("ExpectedFooterDraftHash", "changed after pull"), 400),
  }]);

  await assert.rejects(
    footerPush(invoke(workspace, wire, { verb: "footer push" }).invocation),
    (error) =>
      error?.code === "footer.concurrent_modification"
      && error?.field === "expectedFooterDraftHash"
      && /pull.*reconcile/iu.test(error.message),
  );
  assert.equal(wire.matching("POST", FOOTER_SETTINGS).length, 1);
  assert.equal(await readWorkspaceText(workspace, "settings/site-publishing-preferences.json"), beforeSettings);
  assert.equal(await readWorkspaceText(workspace, ".taproot-site-manifest.json"), beforeManifest);
});

test("footer push reports the committed remote write when response normalization fails", async (site) => {
  const footer = authorableFooter();
  const workspace = await fixture(site, footerWorkspace(footer));
  const wire = api([{
    method: "POST",
    pattern: FOOTER_SETTINGS,
    reply: { footerSettings: { ...footer, unknownServerField: true } },
  }]);

  await assert.rejects(
    footerPush(invoke(workspace, wire, { verb: "footer push" }).invocation),
    (error) =>
      error?.code === "footer.field_unknown"
      && error?.field === "footerSettings.unknownServerField"
      && error?.completedWrites?.[0] === "footerSettings",
  );
});

test("footer push may reuse an appearance image identity proven by pull", async (site) => {
  const pulledFooter = authorableFooter();
  pulledFooter.light.backgroundImageId = "";
  pulledFooter.featureImage = null;
  const files = footerWorkspace(pulledFooter);
  files[".taproot-site-manifest.json"].appearance = { imageIds: [IMAGE_ID] };
  const workspace = await fixture(site, files);
  const document_ = await readWorkspaceJson(workspace, "settings/site-publishing-preferences.json");
  document_.settings.footerSettings.featureImage = { imageId: IMAGE_ID, alt: "The site logo" };
  await writeFile(
    workspacePath(workspace, "settings/site-publishing-preferences.json"),
    `${JSON.stringify(document_, undefined, 2)}\n`,
  );
  const wire = api([{
    method: "POST",
    pattern: FOOTER_SETTINGS,
    reply: (call) => ({ footerSettings: call.body.footerSettings }),
  }]);

  const result = await footerPush(invoke(workspace, wire, { verb: "footer push" }).invocation);

  assert.equal(result.ok, true);
  assert.equal(wire.matching("POST", FOOTER_SETTINGS)[0].body.footerSettings.featureImage.imageId, IMAGE_ID);
});

test("an interrupted workspace rewrite leaves the prior file intact and no temporary artifact", async (site) => {
  const workspace = await fixture(site, { "settings/example.json": "original\n" });

  await assert.rejects(
    writeWorkspaceFile(workspace.workspaceDir, "settings/example.json", { invalid: "writeFile input" }),
    (error) => error?.code === "workspace.unwritable" && error?.field === "settings/example.json",
  );

  assert.equal(await readWorkspaceText(workspace, "settings/example.json"), "original\n");
  assert.deepEqual(
    (await readdir(workspacePath(workspace, "settings"))).filter((file) => file.endsWith(".tmp")),
    [],
  );
});

test("an unsupported parent-directory sync does not report the committed replacement as failed", async (site) => {
  const workspace = await fixture(site, { "settings/example.json": "original\n" });

  const written = await writeWorkspaceFile(
    workspace.workspaceDir,
    "settings/example.json",
    "replacement\n",
    {
      openDirectory: async () => {
        const error = new Error("directory handles are unsupported");
        error.code = "EISDIR";
        throw error;
      },
    },
  );

  assert.equal(written, "settings/example.json");
  assert.equal(await readWorkspaceText(workspace, "settings/example.json"), "replacement\n");
});

test("footer push validates the whole local document and references before the first request", async (site) => {
  const footer = authorableFooter();
  footer.bottomLinks[0].pageResourceId = resourceIdFor(ABOUT_PAGE_ID);
  const workspace = await fixture(site, footerWorkspace(footer));
  const wire = api([]);

  await assert.rejects(
    footerPush(invoke(workspace, wire, { verb: "footer push" }).invocation),
    (error) => error?.code === "footer.target_invalid" && error?.field === "footerSettings.bottomLinks[0]",
  );
  assert.equal(wire.calls.length, 0);
});

test("theme push followed by footer push preserves both the merged remote footer and desired colors", async (site) => {
  const remoteStart = authorableFooter();
  remoteStart.bottomContent.paragraphs[0].runs[0].text = "Remote content before theme push";
  const desired = authorableFooter();
  desired.light.backgroundColor = "#f6efe8";
  desired.dark.backgroundColor = "#231d28";
  const files = {
    ...themeWorkspace({ footerSettings: desired }),
    ...footerWorkspace(desired),
  };
  const workspace = await fixture(site, files);
  let remote = remoteStart;
  const wire = api([
    { method: "GET", pattern: SETTINGS, reply: () => ({ sitePublishingPreferences: { footerSettings: remote } }) },
    {
      method: "POST",
      pattern: FOOTER_SETTINGS,
      reply: (call) => {
        assert.equal(call.body.expectedFooterDraftHash, footerManifestEntry(remote).expectedDraftHash);
        remote = projectFooterSettingsForWorkspace(call.body.footerSettings);
        return { footerSettings: remote };
      },
    },
    { method: "POST", pattern: SETTING, reply: {} },
  ]);

  await themePush(invoke(workspace, wire, { verb: "theme push" }).invocation);
  const document_ = await readWorkspaceJson(workspace, "settings/site-publishing-preferences.json");
  assert.equal(
    document_.settings.footerSettings.bottomContent.paragraphs[0].runs[0].text,
    "Remote content before theme push",
  );
  document_.settings.footerSettings.bottomContent.paragraphs[0].runs[0].text = "Footer content after theme push";
  await writeFile(
    workspacePath(workspace, "settings/site-publishing-preferences.json"),
    `${JSON.stringify(document_, undefined, 2)}\n`,
  );
  await footerPush(invoke(workspace, wire, { verb: "footer push" }).invocation);

  assert.equal(remote.bottomContent.paragraphs[0].runs[0].text, "Footer content after theme push");
  assert.equal(remote.light.backgroundColor, desired.light.backgroundColor);
  assert.equal(remote.dark.backgroundColor, desired.dark.backgroundColor);
});

test("footer push followed by theme push preserves the footer edit while applying later color decisions", async (site) => {
  const initial = authorableFooter();
  const files = {
    ...themeWorkspace({ footerSettings: initial }),
    ...footerWorkspace(initial),
  };
  const workspace = await fixture(site, files);
  let remote = initial;
  const wire = api([
    { method: "GET", pattern: SETTINGS, reply: () => ({ sitePublishingPreferences: { footerSettings: remote } }) },
    {
      method: "POST",
      pattern: FOOTER_SETTINGS,
      reply: (call) => {
        assert.equal(call.body.expectedFooterDraftHash, footerManifestEntry(remote).expectedDraftHash);
        remote = projectFooterSettingsForWorkspace(call.body.footerSettings);
        return { footerSettings: remote };
      },
    },
    { method: "POST", pattern: SETTING, reply: {} },
  ]);

  const document_ = await readWorkspaceJson(workspace, "settings/site-publishing-preferences.json");
  document_.settings.footerSettings.bottomContent.paragraphs[0].runs[0].text = "Footer content first";
  await writeFile(
    workspacePath(workspace, "settings/site-publishing-preferences.json"),
    `${JSON.stringify(document_, undefined, 2)}\n`,
  );
  await footerPush(invoke(workspace, wire, { verb: "footer push" }).invocation);

  const afterFooter = await readWorkspaceJson(workspace, "settings/site-publishing-preferences.json");
  afterFooter.settings.footerSettings.light.backgroundColor = "#f4eee8";
  afterFooter.settings.footerSettings.dark.backgroundColor = "#211b27";
  await writeFile(
    workspacePath(workspace, "settings/site-publishing-preferences.json"),
    `${JSON.stringify(afterFooter, undefined, 2)}\n`,
  );
  await themePush(invoke(workspace, wire, { verb: "theme push" }).invocation);

  assert.equal(remote.bottomContent.paragraphs[0].runs[0].text, "Footer content first");
  assert.equal(remote.light.backgroundColor, "#f4eee8");
  assert.equal(remote.dark.backgroundColor, "#211b27");
});

test("pull never writes outside the workspace, whatever path the server reports", async (site) => {
  const workspace = await fixture(site);
  const wire = api([
    {
      method: "GET",
      pattern: PAGES_LIST,
      reply: { pages: [pageSummary({ pageId: ABOUT_PAGE_ID, path: "../../escape" })], nextPageToken: "" },
    },
    { method: "GET", pattern: PAGE_BY_ID, reply: freeFormPageDetail(ABOUT_PAGE_ID, "text") },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    { method: "GET", pattern: SETTINGS, reply: {} },
  ]);
  const { invocation } = invoke(workspace, wire, { verb: "pull" });
  await pull(invocation);

  // The traversal-shaped path names the file after the page id instead, and the
  // manifest keeps the true path so a later push still targets the right page.
  assert.equal(await workspaceHas(workspace, `pages/${ABOUT_PAGE_ID}.pm.json`), true);
  // config-home is the fixture's own XDG_CONFIG_HOME, not something pull wrote:
  // what this pins is that the escape attempt created nothing beside them.
  assert.deepEqual((await readdir(workspace.root)).sort(), ["config-home", "project"]);
  assert.deepEqual((await readdir(workspace.project)).sort(), ["site", "taproot-site.json"]);
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.pages[0].path, "../../escape");
});

test("pull gives two pages that want the same file name distinct files", async (site) => {
  const workspace = await fixture(site);
  // The home page ("" -> index) and a page literally at path "index" both want
  // pages/index.pm.json. One clobbering the other would put one page's body
  // under the other's name and leave only one of them reachable from a push.
  const collidingPages = [
    pageSummary({ pageId: ABOUT_PAGE_ID, path: "index", title: "Index" }),
    pageSummary({ pageId: HOME_PAGE_ID, path: undefined, title: "Home" }),
  ];
  const wire = api([
    { method: "GET", pattern: PAGES_LIST, reply: { pages: collidingPages, nextPageToken: "" } },
    {
      method: "GET",
      pattern: PAGE_BY_ID,
      reply: (call) => freeFormPageDetail(call.pathname.split("/").pop(), BODY_MARKER),
    },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    { method: "GET", pattern: SETTINGS, reply: {} },
    {
      method: "PATCH",
      pattern: PAGE_BY_ID,
      reply: (call) => draftSummary(call.body.pageId, call.body.path),
    },
  ]);
  const pulled = await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  assert.equal(pulled.pages.bodies, 2);

  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  const files = new Map(manifest.pages.map((entry) => [entry.pageId, entry.file]));
  // The seeded home page keeps `index` whatever order the listing arrived in;
  // the contender falls back to its own page id, which nothing else can claim.
  assert.equal(files.get(HOME_PAGE_ID), "pages/index.pm.json");
  assert.equal(files.get(ABOUT_PAGE_ID), `pages/${ABOUT_PAGE_ID}.pm.json`);
  assert.equal(new Set(files.values()).size, 2);
  assert.equal(await workspaceHas(workspace, "pages/index.pm.json"), true);
  assert.equal(await workspaceHas(workspace, `pages/${ABOUT_PAGE_ID}.pm.json`), true);

  // Both round-trip: the manifest maps each file back to its own page, so a
  // push updates two pages rather than one.
  const pushed = await pagesPush(
    invoke(workspace, wire, {
      verb: "pages push",
      content: contentStub().module,
    }).invocation,
  );
  assert.equal(pushed.pages.updated, 2);
  assert.equal(pushed.pages.created, 0);
  assert.deepEqual(
    wire.matching("PATCH", PAGE_BY_ID).map((call) => [call.body.pageId, call.body.path]).sort(),
    [[ABOUT_PAGE_ID, "index"], [HOME_PAGE_ID, ""]].sort(),
  );
});

// ---------------------------------------------------------------------------
// TR00622 — one authoritative source per page
// ---------------------------------------------------------------------------

const ABOUT_MARKDOWN = "---\ntitle: About us\npath: about\ndescription: Who we are\n---\n\nHello.\n";

function trackedAboutEntry(overrides = {}) {
  return {
    pageId: ABOUT_PAGE_ID,
    resourceId: resourceIdFor(ABOUT_PAGE_ID),
    path: "about",
    title: "About us",
    description: "Who we are",
    status: "PAGE_STATUS_PUBLISHED",
    templateType: "TEMPLATE_TYPE_FREE_FORM",
    file: "pages/about.md",
    sourceFormat: "markdown",
    ...overrides,
  };
}

/**
 * One live free-form page whose stored body the test owns, so a pull can be
 * run twice against a body that did or did not move underneath the author.
 */
/**
 * A stand-in for the API's own body revision: opaque to the CLI, derived from
 * the stored state the site holds, and — the point of it — untouched by the
 * delivery fields a real read re-projects over the body it returns.
 */
function siteRevision(state) {
  return `v1:${
    createHash("sha256")
      .update(JSON.stringify([state.title, state.path, state.description, state.body]))
      .digest("hex")
  }`;
}

/**
 * @param state the stored page state the test owns.
 * @param options `reportsRevision: false` answers the way a Taproot that
 *   predates the revision contract does — no `bodyRevision` on any read, which
 *   is what the published CLI meets whenever it runs ahead of the deployed API.
 */
function trackedRoutes(state, { reportsRevision = true } = {}) {
  state.title ??= "About us";
  state.description ??= "Who we are";
  state.path ??= "about";
  const reportedRevision = () => (reportsRevision ? siteRevision(state) : undefined);
  return [
    {
      method: "GET",
      pattern: PAGES_LIST,
      reply: () => ({
        pages: [pageSummary({ pageId: ABOUT_PAGE_ID, bodyRevision: reportedRevision() })],
        nextPageToken: "",
      }),
    },
    {
      method: "GET",
      pattern: PAGE_BY_ID,
      reply: () => ({
        pageId: ABOUT_PAGE_ID,
        status: "PAGE_STATUS_PUBLISHED",
        title: state.title,
        shortDescription: state.description,
        bodyRevision: reportedRevision(),
        template: {
          templateType: "TEMPLATE_TYPE_FREE_FORM",
          templateVersion: "1.0",
          // Every read re-projects image delivery, so what a caller receives is
          // not what the site stored. `project` is how a test says so.
          freeFormData: { body: state.project === undefined ? state.body : state.project(state.body) },
        },
      }),
    },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    { method: "GET", pattern: SETTINGS, reply: {} },
    {
      method: "PATCH",
      pattern: PAGE_BY_ID,
      reply: (call) => {
        state.body = call.body.template.freeFormData.body;
        state.title = call.body.title;
        state.description = call.body.shortDescription;
        state.path = call.body.path;
        return draftSummary(call.body.pageId, call.body.path, { bodyRevision: reportedRevision() });
      },
    },
  ];
}

const ABOUT_BASELINE_FILE = `.taproot-site-state/pages/${ABOUT_PAGE_ID}.pm.json`;

/**
 * The rollout publishes the CLI before the API is deployed, so a fresh 0.4.0
 * workspace can be pulled against a Taproot that does not serve the redirect
 * map yet (TR00702). That pull must still succeed, and it must record no
 * redirect baseline rather than a fabricated empty one.
 */
test("a first pull against a Taproot without a redirect map records no redirect baseline", async (site) => {
  const workspace = await fixture(site, {});
  const wire = api([
    { method: "GET", pattern: REDIRECT_MAP, reply: () => new Response("", { status: 404 }) },
    ...trackedRoutes({ body: paragraphDocument(BODY_MARKER) }),
  ]);
  const { invocation, progress } = invoke(workspace, wire, { verb: "pull" });

  const result = await pull(invocation);

  assert.equal(result.ok, true);
  assert.equal(result.redirects, undefined);
  assert.equal(await workspaceHas(workspace, "redirects.json"), false);
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.redirects, undefined);
  assert.ok(progress.some((line) => line.includes("does not serve a redirect map")));

  // Without a recorded baseline a redirects push has nothing to fence on, and
  // says so rather than guessing.
  await assert.rejects(
    redirectsPush(invoke(workspace, wire, { verb: "redirects push" }).invocation),
    (error) => typeof error?.code === "string" && error.code.startsWith("redirects."),
  );
});

test("a failed redirect-map read strands nothing: pull refuses before its first workspace write", async (site) => {
  const workspace = await fixture(site, {});
  const wire = api([
    { method: "GET", pattern: REDIRECT_MAP, reply: () => new Response("", { status: 500 }) },
    ...trackedRoutes({ body: paragraphDocument(BODY_MARKER) }),
  ]);

  await assert.rejects(pull(invoke(workspace, wire, { verb: "pull" }).invocation));

  assert.equal(await workspaceHas(workspace, ".taproot-site-manifest.json"), false);
  assert.equal(await workspaceHas(workspace, "pages/about.pm.json"), false);
  assert.equal(await workspaceHas(workspace, "nav.json"), false);
});

test("pull keeps a tracked Markdown source instead of writing a competing document beside it", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry()]),
    "pages/about.md": ABOUT_MARKDOWN,
  });
  const wire = api(trackedRoutes({ body: paragraphDocument(BODY_MARKER) }));

  const result = await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  // The sibling `.pm.json` is the whole of SHY residual R4: it made every pull
  // leave two sources for one path, and the next push refused on the pair.
  assert.equal(await workspaceHas(workspace, "pages/about.pm.json"), false);
  assert.equal(await readWorkspaceText(workspace, "pages/about.md"), ABOUT_MARKDOWN);
  assert.equal(result.pages.tracked, 1);
  assert.equal(result.pages.bodies, 0);

  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.pages[0].file, "pages/about.md");
  assert.equal(manifest.pages[0].sourceFormat, "markdown");
  assert.match(manifest.pages[0].baseline.remoteHash, /^sha256:[0-9a-f]{64}$/u);
  assert.match(manifest.pages[0].baseline.sourceHash, /^sha256:[0-9a-f]{64}$/u);

  // The site's own document is still snapshotted — as internal state, where
  // nothing discovers it as a page or sends it back.
  const baseline = await readWorkspaceJson(workspace, ABOUT_BASELINE_FILE);
  assert.equal(baseline.content[0].content[0].text, BODY_MARKER);
});

test("TR00622 repeated pull, edit, and targeted push never grow a second source for one page", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry()]),
    "pages/about.md": ABOUT_MARKDOWN,
  });
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api(trackedRoutes(state));

  // The loop SHY0019 actually ran: pull for current state, edit the Markdown,
  // push that one path. It used to need a manual `rm` between every iteration.
  for (const round of [0, 1, 2]) {
    await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
    assert.equal(await workspaceHas(workspace, "pages/about.pm.json"), false);
    await writeFile(
      workspacePath(workspace, "pages/about.md"),
      `---\ntitle: About us\npath: about\ndescription: Who we are\n---\n\nRound ${round}.\n`,
    );
    const pushed = await pagesPush(
      invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module }).invocation,
    );
    assert.equal(pushed.pages.updated, 1);
    assert.equal(pushed.pages.selection, "targeted");
  }

  // And a pull that follows a push with no local edit is not a conflict
  // either: the baseline the push recorded is the local half only, because
  // what the site hands back is not comparable with what was sent.
  const settled = await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  assert.equal(settled.pages.tracked, 1);
  assert.equal(await workspaceHas(workspace, "pages/about.pm.json"), false);
  assert.equal(state.body.content[0].content[0].text, "Round 2.");
});

test("pull repairs a version-4 workspace that already tracks a Markdown source", async (site) => {
  const legacy = manifestFixture([trackedAboutEntry()]);
  legacy.manifestVersion = 4;
  delete legacy.pages[0].sourceFormat;
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": legacy,
    "pages/about.md": ABOUT_MARKDOWN,
  });
  const wire = api(trackedRoutes({ body: paragraphDocument(BODY_MARKER) }));

  // Every other verb refuses an old manifest outright. Pull is the verb that
  // repairs one, so it honors the `pageId -> file` mapping it can still read
  // rather than making the workspace grow the sibling one more time.
  const result = await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  assert.equal(result.pages.tracked, 1);
  assert.equal(await workspaceHas(workspace, "pages/about.pm.json"), false);
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.manifestVersion, 6);
  assert.equal(manifest.pages[0].file, "pages/about.md");
  assert.equal(manifest.pages[0].sourceFormat, "markdown");
});

test("pull refuses, and changes nothing, when the site edited a page this workspace authors as Markdown", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry()]),
    "pages/about.md": ABOUT_MARKDOWN,
  });
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api(trackedRoutes(state));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  const reconciled = (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).pages[0].baseline;

  // Somebody edited the page in the browser. Markdown is one-way, so there is
  // no honest way to make the workspace represent this.
  state.body = paragraphDocument("edited on the site");
  await assert.rejects(
    pull(invoke(workspace, wire, { verb: "pull" }).invocation),
    (error) =>
      error?.code === "pages.pull_conflict"
      && error?.field === "pages/about.md"
      && error.message.includes(ABOUT_BASELINE_FILE)
      && /pages push about/u.test(error.message),
  );

  // Both revisions survive, and the manifest still records what was actually
  // reconciled rather than quietly adopting the site's new document.
  assert.equal(await readWorkspaceText(workspace, "pages/about.md"), ABOUT_MARKDOWN);
  assert.equal(await workspaceHas(workspace, "pages/about.pm.json"), false);
  assert.equal((await readWorkspaceJson(workspace, ABOUT_BASELINE_FILE)).content[0].content[0].text, "edited on the site");
  assert.deepEqual((await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).pages[0].baseline, reconciled);
});

test("pull names the local edit too when both sides of a Markdown page moved", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry()]),
    "pages/about.md": ABOUT_MARKDOWN,
  });
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api(trackedRoutes(state));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  state.body = paragraphDocument("edited on the site");
  await writeFile(workspacePath(workspace, "pages/about.md"), `${ABOUT_MARKDOWN}\nEdited locally.\n`);

  await assert.rejects(
    pull(invoke(workspace, wire, { verb: "pull" }).invocation),
    (error) => error?.code === "pages.pull_conflict" && /and in this workspace/u.test(error.message),
  );
});

test("deleting the tracked Markdown source is the documented way out of a pull conflict", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry()]),
    "pages/about.md": ABOUT_MARKDOWN,
  });
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api(trackedRoutes(state));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  state.body = paragraphDocument("edited on the site");
  await assert.rejects(pull(invoke(workspace, wire, { verb: "pull" }).invocation), { code: "pages.pull_conflict" });

  // The recovery the refusal names: give up the Markdown source, and pull
  // adopts the site's document as this page's one source.
  await rm(workspacePath(workspace, "pages/about.md"));
  const result = await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  assert.equal(result.pages.tracked, 0);
  assert.equal(result.pages.bodies, 1);
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.pages[0].file, "pages/about.pm.json");
  assert.equal(manifest.pages[0].sourceFormat, "prosemirror");
  assert.equal(
    (await readWorkspaceJson(workspace, "pages/about.pm.json")).content[0].content[0].text,
    "edited on the site",
  );
  // The page's own source now holds the site's document, so the second copy of
  // it under internal state is retired rather than left to go stale.
  assert.equal(await workspaceHas(workspace, ABOUT_BASELINE_FILE), false);
});

test("pull keeps unpushed edits to a tracked ProseMirror source and still refreshes an untouched one", async (site) => {
  const workspace = await fixture(site);
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api(trackedRoutes(state));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  assert.equal(await workspaceHas(workspace, "pages/about.pm.json"), true);

  // An untouched source is refreshed, exactly as the documented pulled-source
  // behavior always did.
  state.body = paragraphDocument("second revision");
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  assert.equal(
    (await readWorkspaceJson(workspace, "pages/about.pm.json")).content[0].content[0].text,
    "second revision",
  );

  // An edited one is not. It is work no push has sent yet, and overwriting it
  // would destroy it without ever saying so.
  await writeFile(
    workspacePath(workspace, "pages/about.pm.json"),
    `${JSON.stringify(paragraphDocument("local draft"), undefined, 2)}\n`,
  );
  const { invocation, progress } = invoke(workspace, wire, { verb: "pull" });
  await pull(invocation);
  assert.equal((await readWorkspaceJson(workspace, "pages/about.pm.json")).content[0].content[0].text, "local draft");
  assert.ok(progress.some((line) => line.includes("Kept the local edits in 'pages/about.pm.json'")));
  // The site's own document is preserved as internal state, because the
  // workspace source no longer holds it.
  assert.equal(
    (await readWorkspaceJson(workspace, ABOUT_BASELINE_FILE)).content[0].content[0].text,
    "second revision",
  );
});

test("an unpushed ProseMirror edit survives every later pull, not just the first", async (site) => {
  const workspace = await fixture(site);
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api(trackedRoutes(state));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  await writeFile(
    workspacePath(workspace, "pages/about.pm.json"),
    `${JSON.stringify(paragraphDocument("local draft"), undefined, 2)}\n`,
  );

  // The baseline records the source as of the last time it agreed with the
  // site's document, not as of the last pull. Advancing it here would make the
  // second pull read the edit as already reconciled and refresh the file
  // straight over it — silently, with nothing changed on the site at all.
  for (const round of [1, 2, 3]) {
    await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
    assert.equal(
      (await readWorkspaceJson(workspace, "pages/about.pm.json")).content[0].content[0].text,
      "local draft",
      `pull ${round} overwrote an unpushed edit`,
    );
  }

  // The divergence is still live, so a site-side edit is still a conflict
  // rather than a silent overwrite.
  state.body = paragraphDocument("edited on the site");
  await assert.rejects(
    pull(invoke(workspace, wire, { verb: "pull" }).invocation),
    (error) => error?.code === "pages.pull_conflict" && error?.field === "pages/about.pm.json",
  );

  // Pushing it is what settles the divergence: the site's body now derives
  // from these bytes, so the next pull refreshes rather than refusing.
  await pagesPush(
    invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module }).invocation,
  );
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  assert.equal(
    (await readWorkspaceJson(workspace, "pages/about.pm.json")).content[0].content[0].text,
    "local draft",
  );
});

const ABOUT_OBSERVED_REVISION_FILE = `.taproot-site-state/pages/${ABOUT_PAGE_ID}.revision.json`;

/** A body carrying the one thing that broke in production: a delivery-rewritten image. */
function decoratedDocument(text, source) {
  return {
    type: "doc",
    content: [{
      type: "section",
      attrs: { decoration: { image: { src: source, urls: [{ minWidth: 640, url: `${source}?w=640` }] } } },
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    }],
  };
}

test("a projection change between two pulls is not a remote edit", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry()]),
    "pages/about.md": ABOUT_MARKDOWN,
  });
  // The SHY production home page, exactly: the stored body never changed, but
  // every read re-signs the image's delivery URLs, so the previous
  // projected-body hash reported a remote edit whose only recoveries were to
  // re-push identical content or abandon the Markdown source.
  let signature = 0;
  const state = {
    body: decoratedDocument(BODY_MARKER, "https://images.example.test/hero.webp"),
    project: (body) => {
      signature += 1;
      return decoratedDocument(
        body.content[0].content[0].content[0].text,
        `https://images.example.test/hero.webp?sig=${signature}`,
      );
    },
  };
  const wire = api(trackedRoutes(state));

  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  const settled = await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  assert.equal(settled.pages.tracked, 1);
  assert.equal(await readWorkspaceText(workspace, "pages/about.md"), ABOUT_MARKDOWN);
  assert.equal(await workspaceHas(workspace, ABOUT_OBSERVED_REVISION_FILE), false);
});

test("pull names the JSON paths at which the site's document moved", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry()]),
    "pages/about.md": ABOUT_MARKDOWN,
  });
  const state = { body: decoratedDocument(BODY_MARKER, "https://images.example.test/hero.webp") };
  const wire = api(trackedRoutes(state));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  state.body = decoratedDocument("edited on the site", "https://images.example.test/hero.webp");
  const failure = await pull(invoke(workspace, wire, { verb: "pull" }).invocation).then(
    () => undefined,
    (error) => error,
  );

  assert.equal(failure?.code, "pages.pull_conflict");
  // The list is what tells an operator whether the site gained real content or
  // only a re-signed delivery URL. Without it the refusal is unactionable.
  assert.deepEqual(failure.differences, ["$.content[0].content[0].content[0].text"]);
  assert.deepEqual(failureResult(failure).error.differences, ["$.content[0].content[0].content[0].text"]);
});

test("a title-only remote edit conflicts and reports no differing body path", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry()]),
    "pages/about.md": ABOUT_MARKDOWN,
  });
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api(trackedRoutes(state));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  // Stored state a body hash cannot see at all. The revision covers it, so the
  // refusal is raised — and the empty path list is what says the body is not
  // where to look.
  state.title = "About us, renamed";
  const failure = await pull(invoke(workspace, wire, { verb: "pull" }).invocation).then(
    () => undefined,
    (error) => error,
  );

  assert.equal(failure?.code, "pages.pull_conflict");
  // Compared, and identical: the empty list is the machine-readable half of
  // "the body is not where to look". Omitting it would leave this
  // indistinguishable from a conflict nothing could be compared against.
  assert.deepEqual(failure.differences, []);
  assert.deepEqual(failureResult(failure).error.differences, []);
});

test("pages push refuses a page the site changed since this workspace last reconciled with it", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry()]),
    "pages/about.md": ABOUT_MARKDOWN,
  });
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api(trackedRoutes(state));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  const reconciled = (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).pages[0].baseline.revision;

  // Somebody edited the page in the browser after this workspace pulled. The
  // window between a push and the next pull is the one divergence TR00622
  // could not see, and the push used to overwrite it silently.
  state.body = paragraphDocument("edited on the site");
  const live = siteRevision(state);
  const failure = await pagesPush(
    invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module }).invocation,
  ).then(() => undefined, (error) => error);

  assert.equal(failure?.code, "pages.push_conflict");
  assert.equal(failure.field, "pages/about.md");
  assert.deepEqual(failure.alternatives, [reconciled, live]);
  // Fails closed: nothing was sent, so the site still holds its own edit.
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
  assert.equal(state.body.content[0].content[0].text, "edited on the site");
});

/**
 * The revision a push records from its own response is what lets the *next*
 * push tell "nobody else touched this page" from "someone did" without a pull
 * in between (TR00643). Pinned here because every other push test either runs
 * against a wire that reports no revision, so the guard is unarmed, or pushes
 * once.
 */
test("a push records the revision it wrote, so a second push needs no pull in between", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry()]),
    "pages/about.md": ABOUT_MARKDOWN,
  });
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api(trackedRoutes(state));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  const first = await pagesPush(
    invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module }).invocation,
  );
  const second = await pagesPush(
    invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module }).invocation,
  );

  assert.equal(first.pages.updated, 1);
  assert.equal(second.pages.updated, 1);
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 2);
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.pages[0].baseline.revision, siteRevision(state));
});

/**
 * The page read is what supplies the revision, so its title and path are the
 * ones that revision describes (TR00643). A rename that lands between the
 * listing and the read must not be recorded beside the newer revision with the
 * older metadata, or the next push would revert it without a conflict.
 */
test("pull records a page's title and path from the read that supplied its revision", async (site) => {
  const workspace = await fixture(site, {});
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api([
    {
      method: "GET",
      pattern: PAGE_BY_ID,
      reply: () => ({
        pageId: ABOUT_PAGE_ID,
        status: "PAGE_STATUS_PUBLISHED",
        title: "Renamed on the site",
        path: "about-us",
        shortDescription: "Who we are",
        bodyRevision: siteRevision(state),
        template: { templateType: "TEMPLATE_TYPE_FREE_FORM", templateVersion: "1.0", freeFormData: { body: state.body } },
      }),
    },
    ...trackedRoutes(state),
  ]);
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  const entry = manifest.pages.find((candidate) => candidate.pageId === ABOUT_PAGE_ID);
  assert.equal(entry.title, "Renamed on the site");
  assert.equal(entry.path, "about-us");

  // A ProseMirror source takes its metadata from the manifest, so the next
  // push carries the rename rather than reverting it.
  await pagesPush(
    invoke(workspace, wire, { verb: "pages push", pagePaths: ["about-us"], content: contentStub().module }).invocation,
  );
  const sent = wire.matching("PATCH", PAGE_BY_ID)[0].body;
  assert.equal(sent.title, "Renamed on the site");
  assert.equal(sent.path, "about-us");
});

test("pull records a tracked page's title and path from its read too, stripped like the listing's", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry()]),
    "pages/about.md": ABOUT_MARKDOWN,
  });
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api([
    {
      method: "GET",
      pattern: PAGE_BY_ID,
      reply: () => ({
        pageId: ABOUT_PAGE_ID,
        status: "PAGE_STATUS_PUBLISHED",
        // A bidi override in the title is stripped, as the listing path strips it.
        title: "Renamed\u202E on the site",
        path: "/about-us/",
        shortDescription: "Who we are",
        bodyRevision: siteRevision(state),
        template: { templateType: "TEMPLATE_TYPE_FREE_FORM", templateVersion: "1.0", freeFormData: { body: state.body } },
      }),
    },
    ...trackedRoutes(state),
  ]);

  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  const entry = manifest.pages.find((candidate) => candidate.pageId === ABOUT_PAGE_ID);
  assert.equal(entry.file, "pages/about.md");
  assert.equal(entry.title, "Renamed on the site");
  assert.equal(entry.path, "about-us");
});

/**
 * The observed-revision record a push may spend has to be removable after the
 * send, so a shape that cannot be removed is refused before any page is
 * written — never discovered after the site has changed (TR00643).
 */
test("pages push refuses before sending when the observed-revision record is not a regular file", async (testContext) => {
  const recordFile = `.taproot-site-state/pages/${ABOUT_PAGE_ID}.revision.json`;
  const shapes = [
    { name: "a directory", plant: (target) => mkdir(target, { recursive: true }) },
    {
      name: "a symlink",
      plant: async (target) => {
        await mkdir(path.dirname(target), { recursive: true });
        await symlink(path.join(path.dirname(target), "elsewhere.json"), target);
      },
    },
  ];
  for (const shape of shapes) {
    await testContext.test(shape.name, async (site) => {
      const workspace = await fixture(site, {
        ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry()]),
        "pages/about.md": ABOUT_MARKDOWN,
      });
      const state = { body: paragraphDocument(BODY_MARKER) };
      const wire = api(trackedRoutes(state));
      await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
      await shape.plant(workspacePath(workspace, recordFile));

      await assert.rejects(
        pagesPush(
          invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module })
            .invocation,
        ),
        (error) => error?.code === "workspace.not_regular",
      );
      assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
    });
  }
});

test("a refused pull is what unblocks its own recovery push, and only for the version it showed", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry()]),
    "pages/about.md": ABOUT_MARKDOWN,
  });
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api(trackedRoutes(state));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  state.body = paragraphDocument("edited on the site");
  await assert.rejects(pull(invoke(workspace, wire, { verb: "pull" }).invocation), { code: "pages.pull_conflict" });

  // The site moved again between the refusal and the push, so the operator has
  // not been shown *this* version and the push still fails closed.
  state.body = paragraphDocument("edited on the site again");
  await assert.rejects(
    pagesPush(
      invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module }).invocation,
    ),
    { code: "pages.push_conflict" },
  );

  // Shown that version too, the documented recovery from a pull conflict —
  // push the local source to make the site match it — goes through.
  await assert.rejects(pull(invoke(workspace, wire, { verb: "pull" }).invocation), { code: "pages.pull_conflict" });
  const pushed = await pagesPush(
    invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module }).invocation,
  );

  assert.equal(pushed.pages.updated, 1);
  // The override is spent: nothing is left that would let the next push
  // overwrite an edit nobody has seen.
  assert.equal(await workspaceHas(workspace, ABOUT_OBSERVED_REVISION_FILE), false);
});

test("a second refusal for the same version reports the differences the first one showed", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry()]),
    "pages/about.md": ABOUT_MARKDOWN,
  });
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api(trackedRoutes(state));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  state.body = paragraphDocument("edited on the site");
  const first = await pull(invoke(workspace, wire, { verb: "pull" }).invocation).then(
    () => undefined,
    (error) => error,
  );

  assert.equal(first?.code, "pages.pull_conflict");
  assert.deepEqual(first.differences, ["$.content[0].content[0].text"]);

  // The refusal preserved the version it refused, overwriting the only copy the
  // comparison could be made from. A second refusal that recomputed would
  // compare that version with itself, find nothing, and tell the operator the
  // change was in the page's title, path, or description rather than its body —
  // for a page whose body is the only thing that moved.
  const second = await pull(invoke(workspace, wire, { verb: "pull" }).invocation).then(
    () => undefined,
    (error) => error,
  );

  assert.equal(second?.code, "pages.pull_conflict");
  assert.deepEqual(second.differences, first.differences);
  assert.deepEqual(failureResult(second).error.differences, first.differences);

  // A further remote edit is a different version, so the record no longer
  // applies and the comparison is redone — against the version the previous
  // refusal preserved, which is the one the operator was last shown.
  state.body = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "edited on the site" }] },
      { type: "paragraph", content: [{ type: "text", text: "and again" }] },
    ],
  };
  const third = await pull(invoke(workspace, wire, { verb: "pull" }).invocation).then(
    () => undefined,
    (error) => error,
  );

  assert.equal(third?.code, "pages.pull_conflict");
  assert.deepEqual(third.differences, ["$.content[1]"]);
});

test("a site that reports no revision still repeats the differences on the second refusal", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry()]),
    "pages/about.md": ABOUT_MARKDOWN,
  });
  // A Taproot that predates the revision contract, which the published CLI
  // meets whenever it runs ahead of the deployed API. Pull compares body hashes
  // there, and the refusal preserves the version it refused over the only copy
  // the comparison could be made from — so without a record naming that
  // version by its hash, the second refusal recomputed against the new body,
  // found nothing, and reported a body edit as a title, path, or description
  // change.
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api(trackedRoutes(state, { reportsRevision: false }));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  state.body = paragraphDocument("edited on the site");
  const first = await pull(invoke(workspace, wire, { verb: "pull" }).invocation).then(
    () => undefined,
    (error) => error,
  );
  const second = await pull(invoke(workspace, wire, { verb: "pull" }).invocation).then(
    () => undefined,
    (error) => error,
  );

  assert.equal(first?.code, "pages.pull_conflict");
  assert.equal(second?.code, "pages.pull_conflict");
  assert.deepEqual(first.differences, ["$.content[0].content[0].text"]);
  assert.deepEqual(second.differences, first.differences);
  assert.deepEqual(failureResult(second).error.differences, first.differences);
});

test("a version-5 manifest's superseded body hash does not refuse the pull that migrates it", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture(
      [trackedAboutEntry({
        baseline: {
          // Version 5 could only record the hash of a *projected* body, and the
          // projection moves on its own — the SHY case. Honoring it here would
          // make this Markdown page conflict on the first pull after the
          // upgrade and refuse without writing a manifest, and the documented
          // recovery, `pages push`, reads the manifest strictly and refuses a
          // version-5 one telling the operator to pull again.
          remoteHash: `sha256:${"a".repeat(64)}`,
          sourceHash: workspaceContentHash(Buffer.from(ABOUT_MARKDOWN, "utf8")),
        },
      })],
      { manifestVersion: 5 },
    ),
    "pages/about.md": ABOUT_MARKDOWN,
  });
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api(trackedRoutes(state));

  const migrated = await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  assert.equal(migrated.pages.tracked, 1);
  assert.equal(await readWorkspaceText(workspace, "pages/about.md"), ABOUT_MARKDOWN);
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.manifestVersion, 6);
  // The migration pull establishes the revision baseline, which is what every
  // later pull compares instead of falling back to a hash again.
  assert.equal(manifest.pages[0].baseline.revision, siteRevision(state));
});

test("a version-5 manifest keeps an edited ProseMirror source through the migration pull", async (site) => {
  const edited = paragraphDocument("local draft");
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture(
      [trackedAboutEntry({
        file: "pages/about.pm.json",
        sourceFormat: "prosemirror",
        baseline: {
          remoteHash: `sha256:${"a".repeat(64)}`,
          // Kept across the version bump, unlike the hash beside it: it answers
          // a question that has not changed — whether the author has edited
          // this file since the last pull — and losing it would let this same
          // pull refresh the site's document over unpushed work.
          sourceHash: workspaceContentHash(
            Buffer.from(`${JSON.stringify(paragraphDocument(BODY_MARKER), undefined, 2)}\n`, "utf8"),
          ),
        },
      })],
      { manifestVersion: 5 },
    ),
    "pages/about.pm.json": edited,
  });
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api(trackedRoutes(state));

  const migrated = await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  assert.equal(migrated.pages.tracked, 1);
  assert.deepEqual(await readWorkspaceJson(workspace, "pages/about.pm.json"), edited);
});

test("a hash-only baseline of this version yields to the revision the site now reports", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry({
      // This version's manifest, recorded against a Taproot that had no
      // revision to give: `withoutSupersededRemoteHashes` never sees it, so
      // nothing else drops the projected-body hash it holds.
      baseline: {
        remoteHash: `sha256:${"a".repeat(64)}`,
        sourceHash: workspaceContentHash(Buffer.from(ABOUT_MARKDOWN, "utf8")),
      },
    })]),
    "pages/about.md": ABOUT_MARKDOWN,
  });
  // The API deploy has landed, so the site reports a revision — and the image's
  // delivery projection moved in the meantime, so the hash beside it no longer
  // matches anything. Comparing it would refuse this Markdown page's every
  // later pull, which is the SHY failure this task removes.
  let signature = 0;
  const state = {
    body: decoratedDocument(BODY_MARKER, "https://images.example.test/hero.webp"),
    project: (body) => {
      signature += 1;
      return decoratedDocument(
        body.content[0].content[0].content[0].text,
        `https://images.example.test/hero.webp?sig=${signature}`,
      );
    },
  };
  const wire = api(trackedRoutes(state));

  const result = await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  assert.equal(result.pages.tracked, 1);
  assert.equal(await readWorkspaceText(workspace, "pages/about.md"), ABOUT_MARKDOWN);
  // The revision baseline is established, so the next pull compares stored
  // state rather than falling back to a hash again.
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.pages[0].baseline.revision, siteRevision(state));
  const settled = await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  assert.equal(settled.pages.tracked, 1);
});

/**
 * A body that arrives inside the API response cap and does not fit back through
 * the single-document limit once pull has preserved it.
 *
 * Pull writes the preserved copy pretty-printed and under no per-file cap of
 * its own, and indentation roughly triples a document made of many small nodes.
 * So this is not a synthetic size: it is one real page. The read that trips on
 * it is a diagnostic that decides nothing, so its failure must not decide
 * anything either — not the conflict below, and not an ordinary refresh.
 */
function bulkyDocument(text) {
  return {
    type: "doc",
    content: Array.from({ length: 5000 }, (_, index) => ({
      type: "section",
      content: [{
        type: "paragraph",
        content: [{ type: "text", marks: [{ type: "link", attrs: { href: `/p${index}` } }], text: `${text} ${index}` }],
      }],
    })),
  };
}

test("an oversized preserved baseline still refuses, rather than failing the pull", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry()]),
    "pages/about.md": ABOUT_MARKDOWN,
  });
  const state = { body: bulkyDocument("before") };
  const wire = api(trackedRoutes(state));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  state.body = bulkyDocument("after");
  const failure = await pull(invoke(workspace, wire, { verb: "pull" }).invocation).then(
    () => undefined,
    (error) => error,
  );

  // The conflict is still the outcome, and the record that keeps the refusal's
  // own recovery push reachable is still written. A `workspace.file_too_large`
  // here would replace both.
  assert.equal(failure?.code, "pages.pull_conflict");
  // Nothing was compared, so the refusal claims nothing about where the change
  // is — as distinct from the empty list, which claims the body is unchanged.
  assert.equal(failure.differences, undefined);
  assert.equal("differences" in failureResult(failure).error, false);
  assert.equal(await workspaceHas(workspace, ABOUT_OBSERVED_REVISION_FILE), true);
});

test("an oversized preserved baseline does not fail an ordinary refresh", async (site) => {
  const workspace = await fixture(site);
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api(trackedRoutes(state));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  // What an earlier refusal of a since-shrunk body leaves behind: internal
  // state past the single-document limit, beside a source file that still holds
  // exactly what pull wrote and so has nothing to protect.
  await mkdir(path.dirname(workspacePath(workspace, ABOUT_BASELINE_FILE)), { recursive: true });
  await writeFile(
    workspacePath(workspace, ABOUT_BASELINE_FILE),
    `${JSON.stringify(bulkyDocument("preserved"), undefined, 2)}\n`,
  );
  state.body = paragraphDocument("edited on the site");

  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  assert.equal(
    (await readWorkspaceJson(workspace, "pages/about.pm.json")).content[0].content[0].text,
    "edited on the site",
  );
  assert.equal(await workspaceHas(workspace, ABOUT_BASELINE_FILE), false);
});

test("push, pull, approve, deploy, pull on a page carrying an image reports no conflict", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry()]),
    "pages/about.md": ABOUT_MARKDOWN,
  });
  // The production run of 2026-09-03, as a test. Every read re-signs the
  // image's delivery URLs, and the approve/deploy steps in between move the
  // page's status without touching its stored authoring state.
  let signature = 0;
  const state = {
    body: decoratedDocument(BODY_MARKER, "https://images.example.test/hero.webp"),
    status: "PAGE_STATUS_PUBLISHED",
    hasDraft: false,
    project: (body) => {
      signature += 1;
      return decoratedDocument(
        body.content[0]?.content?.[0]?.content?.[0]?.text ?? BODY_MARKER,
        `https://images.example.test/hero.webp?sig=${signature}`,
      );
    },
  };
  const wire = api([
    {
      method: "GET",
      pattern: PAGES_LIST,
      reply: () => ({
        pages: [pageSummary({
          pageId: ABOUT_PAGE_ID,
          status: state.status,
          hasDraft: state.hasDraft,
          bodyRevision: siteRevision(state),
        })],
        nextPageToken: "",
      }),
    },
    ...trackedRoutes(state).filter((route) => route.pattern !== PAGES_LIST),
    {
      method: "POST",
      pattern: PUBLISH_DRAFTS,
      reply: () => {
        // Approval stages the draft: the status moves, the stored authoring
        // state does not, so the revision must not move either.
        state.status = "PAGE_STATUS_APPROVED";
        state.hasDraft = false;
        return {
          pages: [pageSummary({
            pageId: ABOUT_PAGE_ID,
            status: state.status,
            hasDraft: false,
            bodyRevision: siteRevision(state),
          })],
        };
      },
    },
    ...deployRoutes().filter((route) => route.pattern !== PAGES_LIST),
  ]);

  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  await writeFile(
    workspacePath(workspace, "pages/about.md"),
    `---\ntitle: About us\npath: about\ndescription: Who we are\n---\n\nLaunch copy.\n`,
  );
  await pagesPush(
    invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module }).invocation,
  );
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  await approve(invoke(workspace, wire, { verb: "approve" }).invocation);
  await deploy(invoke(workspace, wire, { verb: "deploy", deployTarget: "staging" }).invocation);
  state.status = "PAGE_STATUS_PUBLISHED";
  await deploy(invoke(workspace, wire, { verb: "deploy", deployTarget: "production" }).invocation);

  const settled = await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  assert.equal(settled.pages.tracked, 1);
  assert.equal(await workspaceHas(workspace, "pages/about.pm.json"), false);
  assert.equal(await workspaceHas(workspace, ABOUT_OBSERVED_REVISION_FILE), false);
});

test("pull refuses when a tracked ProseMirror source and the site both moved", async (site) => {
  const workspace = await fixture(site);
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api(trackedRoutes(state));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  await writeFile(
    workspacePath(workspace, "pages/about.pm.json"),
    `${JSON.stringify(paragraphDocument("local draft"), undefined, 2)}\n`,
  );
  state.body = paragraphDocument("edited on the site");

  await assert.rejects(
    pull(invoke(workspace, wire, { verb: "pull" }).invocation),
    (error) => error?.code === "pages.pull_conflict" && error?.field === "pages/about.pm.json",
  );
  assert.equal((await readWorkspaceJson(workspace, "pages/about.pm.json")).content[0].content[0].text, "local draft");
  assert.equal(
    (await readWorkspaceJson(workspace, ABOUT_BASELINE_FILE)).content[0].content[0].text,
    "edited on the site",
  );
});

test("a page whose site body is unreadable keeps its tracked source registered", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry()]),
    "pages/about.md": ABOUT_MARKDOWN,
  });
  // The server accepts and stores a body it never validates, so an unreadable
  // one is a real state. Forgetting which file authors the page because of it
  // would let the next pull mint the competing document.
  const wire = api([
    {
      method: "GET",
      pattern: PAGES_LIST,
      reply: { pages: [pageSummary({ pageId: ABOUT_PAGE_ID })], nextPageToken: "" },
    },
    {
      method: "GET",
      pattern: PAGE_BY_ID,
      reply: { pageId: ABOUT_PAGE_ID, status: "PAGE_STATUS_PUBLISHED", title: "About us", template: {} },
    },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    { method: "GET", pattern: SETTINGS, reply: {} },
  ]);

  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  assert.equal(await workspaceHas(workspace, "pages/about.pm.json"), false);
  const entry = (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).pages[0];
  assert.equal(entry.file, "pages/about.md");
  assert.equal(entry.sourceFormat, "markdown");
  assert.equal(entry.baseline, undefined);
});

test("a manifest entry naming a file the workspace walk could never produce is not a tracked source", async (site) => {
  const workspace = await fixture(site, {
    // A hand-edited registry pointing out of the tree. Pull is the verb that
    // repairs a workspace, so it drops the entry and re-registers the page
    // rather than failing on a path it would never have read anyway.
    ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry({ file: "pages/../../escape.md" })]),
    "pages/about.md": ABOUT_MARKDOWN,
  });
  const wire = api(trackedRoutes({ body: paragraphDocument(BODY_MARKER) }));

  const result = await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  assert.equal(result.pages.tracked, 0);
  const entry = (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).pages[0];
  assert.equal(entry.file, "pages/about.pm.json");
  assert.equal(entry.sourceFormat, "prosemirror");
});

test("one file recorded as two pages' source is never trusted by either verb", async (site) => {
  // Only a hand edit or a damaged manifest produces this, and both readers
  // would otherwise resolve it in favour of whichever entry was read last:
  // pull would hash one file against two unrelated baselines, and push keys
  // its manifest lookup by file, so this file's content would be sent to
  // whichever page won that lookup.
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([
      trackedAboutEntry(),
      trackedAboutEntry({
        pageId: STORY_PAGE_ID,
        resourceId: resourceIdFor(STORY_PAGE_ID),
        path: "story",
        title: "Story",
      }),
    ]),
    "pages/about.md": ABOUT_MARKDOWN,
  });
  const wire = api([
    {
      method: "GET",
      pattern: PAGES_LIST,
      reply: {
        pages: [
          pageSummary({ pageId: ABOUT_PAGE_ID, path: "about", title: "About us" }),
          pageSummary({ pageId: STORY_PAGE_ID, path: "story", title: "Story" }),
        ],
        nextPageToken: "",
      },
    },
    {
      method: "GET",
      pattern: PAGE_BY_ID,
      reply: (call) => freeFormPageDetail(call.pathname.split("/").pop(), BODY_MARKER),
    },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    { method: "GET", pattern: SETTINGS, reply: {} },
    { method: "PATCH", pattern: PAGE_BY_ID, reply: (call) => draftSummary(call.body.pageId, call.body.path) },
  ]);

  // Push refuses outright: it cannot send that file without guessing.
  await assert.rejects(
    pagesPush(
      invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module }).invocation,
    ),
    (error) => error?.code === "workspace.manifest_invalid" && error?.field === "pages/about.md",
  );
  assert.equal(wire.calls.length, 0);

  // Pull is the verb that repairs a workspace, so it ignores both entries and
  // gives each page its own collision-safe file. That rewrites the ambiguity
  // out of the manifest, which is what makes "run pull again" a real remedy
  // rather than a loop.
  const { invocation, progress } = invoke(workspace, wire, { verb: "pull" });
  const result = await pull(invocation);

  assert.equal(result.pages.tracked, 0);
  assert.ok(progress.some((line) => line.includes("recorded as the source of more than one page")));
  const files = (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).pages.map((entry) => entry.file);
  assert.deepEqual(files.slice().sort(), ["pages/about.pm.json", "pages/story.pm.json"]);
});

test("pull refuses when a renamed tracked source leaves another page nowhere to be written", async (site) => {
  // Two hand-renamed tracked sources between them claim both names the third
  // page could take: its path-derived `pages/story.pm.json` and the
  // `pages/<pageId>.pm.json` fallback that is otherwise reserved for it alone.
  // Writing it anyway would put one page's body under a file the manifest says
  // belongs to another, which is the clobbering `assignPageFiles` exists to
  // make impossible.
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([
      trackedAboutEntry({ file: "pages/story.pm.json", sourceFormat: "prosemirror" }),
      trackedAboutEntry({
        pageId: HOME_PAGE_ID,
        resourceId: resourceIdFor(HOME_PAGE_ID),
        path: "",
        title: "Home",
        file: `pages/${STORY_PAGE_ID}.pm.json`,
        sourceFormat: "prosemirror",
      }),
    ]),
    "pages/story.pm.json": paragraphDocument(BODY_MARKER),
    [`pages/${STORY_PAGE_ID}.pm.json`]: paragraphDocument(BODY_MARKER),
  });
  const wire = api([
    {
      method: "GET",
      pattern: PAGES_LIST,
      reply: {
        pages: [
          pageSummary({ pageId: ABOUT_PAGE_ID, path: "about", title: "About us" }),
          pageSummary({ pageId: HOME_PAGE_ID, path: undefined, title: "Home" }),
          pageSummary({ pageId: STORY_PAGE_ID, path: "story", title: "Story" }),
        ],
        nextPageToken: "",
      },
    },
    {
      method: "GET",
      pattern: PAGE_BY_ID,
      reply: (call) => freeFormPageDetail(call.pathname.split("/").pop(), BODY_MARKER),
    },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    { method: "GET", pattern: SETTINGS, reply: {} },
  ]);

  await assert.rejects(
    pull(invoke(workspace, wire, { verb: "pull" }).invocation),
    (error) => error?.code === "pages.source_conflict" && error?.field === `pages/${STORY_PAGE_ID}.pm.json`,
  );
  // The refusal lands before any page body is written, so neither renamed file
  // is disturbed and the workspace stays exactly as repairable as it was.
  assert.equal(await workspaceHas(workspace, "pages/about.pm.json"), false);
  assert.equal(
    (await readWorkspaceJson(workspace, "pages/story.pm.json")).content[0].content[0].text,
    BODY_MARKER,
  );
});

test("a version-4 workspace whose ProseMirror source was edited keeps the edit", async (site) => {
  // The migration pull is the one pull that has no recorded source hash to
  // compare against, so treating "unrecorded" as "unchanged" would refresh the
  // file straight over an edit nobody has pushed. The bytes still answer it:
  // a pulled source is exactly what pull wrote.
  const legacy = manifestFixture([
    trackedAboutEntry({ file: "pages/about.pm.json", sourceFormat: "prosemirror" }),
  ]);
  legacy.manifestVersion = 4;
  delete legacy.pages[0].sourceFormat;
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": legacy,
    "pages/about.pm.json": paragraphDocument("local draft"),
  });
  const wire = api(trackedRoutes({ body: paragraphDocument(BODY_MARKER) }));

  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  assert.equal(
    (await readWorkspaceJson(workspace, "pages/about.pm.json")).content[0].content[0].text,
    "local draft",
  );
  // The site's document is preserved as internal state rather than discarded,
  // and the divergence stays unrecorded so the next pull decides the same way.
  assert.equal(
    (await readWorkspaceJson(workspace, ABOUT_BASELINE_FILE)).content[0].content[0].text,
    BODY_MARKER,
  );
  const entry = (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).pages[0];
  assert.equal(entry.baseline.sourceHash, undefined);
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  assert.equal(
    (await readWorkspaceJson(workspace, "pages/about.pm.json")).content[0].content[0].text,
    "local draft",
  );
});

test("a version-4 workspace whose ProseMirror source is untouched re-establishes and keeps refreshing", async (site) => {
  // The other half of the same decision: a pristine pulled source must not be
  // mistaken for authored work, or a migrated workspace would stop tracking
  // the site. With the site unchanged the bytes still match, so the migration
  // pull records the hash and normal refreshing resumes from there.
  const workspace = await fixture(site);
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api(trackedRoutes(state));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  const migrated = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  migrated.manifestVersion = 4;
  for (const entry of migrated.pages) delete entry.baseline;
  await writeFile(
    workspacePath(workspace, ".taproot-site-manifest.json"),
    `${JSON.stringify(migrated, undefined, 2)}\n`,
  );

  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  const entry = (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).pages[0];
  assert.match(entry.baseline.sourceHash, /^sha256:[0-9a-f]{64}$/u);

  state.body = paragraphDocument("second revision");
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  assert.equal(
    (await readWorkspaceJson(workspace, "pages/about.pm.json")).content[0].content[0].text,
    "second revision",
  );
});

test("a titleless source still claims its page path against the rest of the workspace", async (site) => {
  // A file that declares `path: about` is a source for `about` whether or not
  // it also declares a title. Dropping it from the duplicate pass as
  // "unresolved" would let the other `about` source be sent as though it were
  // the only one — the guess one source per page exists to refuse.
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([]),
    "pages/about.md": ABOUT_MARKDOWN,
    "pages/about-draft.md": "---\npath: about\n---\n\nA second source for the same path.\n",
  });
  const wire = api(aboutLiveRoutes());

  await assert.rejects(
    pagesPush(
      invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module }).invocation,
    ),
    (error) => error?.code === "pages.path_conflict" && error?.field === "about",
  );
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
  assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);

  // Selecting it by name still reports the missing title rather than pretending
  // the file is unreadable.
  await assert.rejects(
    pagesPush(invoke(workspace, wire, { verb: "pages push", content: contentStub().module }).invocation),
    (error) => error?.code === "pages.path_conflict" || error?.code === "pages.title_missing",
  );
});

test("a titleless selected page is refused by name, not silently skipped", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([]),
    "pages/about.md": "---\npath: about\n---\n\nNo title here.\n",
  });
  const wire = api(aboutLiveRoutes());

  await assert.rejects(
    pagesPush(
      invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module }).invocation,
    ),
    (error) => error?.code === "pages.title_missing" && error?.field === "pages/about.md",
  );
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
});

test("two files recorded as one page's source are refused before any page is written twice", async (site) => {
  // The mirror image of one file claiming two pages. The registry is keyed by
  // page id, so the second entry would simply replace the first and the
  // manifest would read as consistent — while push keys its own lookup by
  // file, plans both, and PATCHes that one live page twice from two sources.
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([
      trackedAboutEntry(),
      trackedAboutEntry({ file: "pages/about-copy.md", path: "about-copy" }),
    ]),
    "pages/about.md": ABOUT_MARKDOWN,
    "pages/about-copy.md": "---\ntitle: About us\npath: about-copy\n---\n\nA copy.\n",
  });
  const wire = api(aboutLiveRoutes());

  await assert.rejects(
    pagesPush(invoke(workspace, wire, { verb: "pages push", content: contentStub().module }).invocation),
    (error) =>
      error?.code === "workspace.manifest_invalid"
      // Both files are named: "remove the extra one" is not guidance anybody
      // can follow without knowing which files are meant.
      && error.message.includes("pages/about.md")
      && error.message.includes("pages/about-copy.md")
      && error.message.includes(ABOUT_PAGE_ID),
  );
  assert.equal(wire.calls.length, 0);

  // Pull repairs it the same way it repairs one file claiming two pages:
  // neither entry is trusted, and each page is reassigned its own file.
  const pullWire = api([
    {
      method: "GET",
      pattern: PAGES_LIST,
      reply: {
        pages: [
          pageSummary({ pageId: ABOUT_PAGE_ID, path: "about", title: "About us" }),
          pageSummary({ pageId: STORY_PAGE_ID, path: "about-copy", title: "A copy" }),
        ],
        nextPageToken: "",
      },
    },
    {
      method: "GET",
      pattern: PAGE_BY_ID,
      reply: (call) => freeFormPageDetail(call.pathname.split("/").pop(), BODY_MARKER),
    },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    { method: "GET", pattern: SETTINGS, reply: {} },
  ]);
  const { invocation, progress } = invoke(workspace, pullWire, { verb: "pull" });
  const result = await pull(invocation);
  assert.equal(result.pages.tracked, 0);
  const files = (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).pages.map((entry) => entry.file);
  assert.equal(new Set(files).size, files.length);
  // One page with two sources is the opposite relationship to one file naming
  // two pages, so it gets its own wording: reporting this file as "the source
  // of more than one page" would send the author looking for the wrong thing.
  assert.ok(progress.some((line) =>
    line.includes(`Page ${ABOUT_PAGE_ID} is recorded with more than one source`)
    && line.includes("pages/about.md")
    && line.includes("pages/about-copy.md")
  ));
});

test("re-ordered members of an unchanged site document are not mistaken for a local edit", async (site) => {
  // `FreeFormData.body` is a protobuf Struct, so two reads of one unchanged
  // page may serialize their members in different orders. Comparing the file
  // to the site's document byte for byte would read that as an authored edit,
  // and the next genuine remote change would then raise a conflict naming a
  // local edit that never happened — whose offered remedy is to push the
  // untouched file straight over the real one.
  const ordered = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: BODY_MARKER }] }],
  };
  const reordered = {
    content: [{ content: [{ text: BODY_MARKER, type: "text" }], type: "paragraph" }],
    type: "doc",
  };
  const workspace = await fixture(site);
  const state = { body: ordered };
  const wire = api(trackedRoutes(state));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  // Drop the recorded hashes, so the next pull takes the unknown-baseline
  // path — the migration case this comparison exists for.
  const migrated = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  for (const entry of migrated.pages) delete entry.baseline;
  await writeFile(
    workspacePath(workspace, ".taproot-site-manifest.json"),
    `${JSON.stringify(migrated, undefined, 2)}\n`,
  );

  state.body = reordered;
  const { invocation, progress } = invoke(workspace, wire, { verb: "pull" });
  await pull(invocation);

  const entry = (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).pages[0];
  assert.match(entry.baseline.sourceHash, /^sha256:[0-9a-f]{64}$/u);
  assert.ok(!progress.some((line) => line.includes("does not match the site's document")));

  // And the page still tracks the site: a real edit refreshes it rather than
  // colliding with a divergence that was never there.
  state.body = paragraphDocument("second revision");
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  assert.equal(
    (await readWorkspaceJson(workspace, "pages/about.pm.json")).content[0].content[0].text,
    "second revision",
  );
});

test("internal baseline state is never discovered as an authored page source", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry()]),
    "pages/about.md": ABOUT_MARKDOWN,
  });
  const wire = api(trackedRoutes({ body: paragraphDocument(BODY_MARKER) }));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  assert.equal(await workspaceHas(workspace, ABOUT_BASELINE_FILE), true);

  // A whole-workspace push considers every authored source there is. If the
  // baseline were one of them, this page would be pushed twice — which is the
  // ambiguity the hidden directory exists to prevent, one level down.
  const result = await pagesPush(
    invoke(workspace, wire, { verb: "pages push", content: contentStub().module }).invocation,
  );
  assert.equal(result.pages.discovered, 1);
  assert.equal(result.pages.validated, 1);
  assert.deepEqual(result.pages.items.map((entry) => entry.file), ["pages/about.md"]);
});

test("a long page title round-trips through pull and push unchanged", async (site) => {
  const workspace = await fixture(site);
  // `Page.Title` is citext with no maximum. Truncating what was read renames the
  // page on the next push — silently, and in the direction nobody inspects. The
  // trailing astral character also pins that nothing slices UTF-16 units and
  // hands the server half a surrogate pair.
  const longTitle = `${"t".repeat(600)}🌱`;
  const wire = api([
    {
      method: "GET",
      pattern: PAGES_LIST,
      reply: {
        pages: [pageSummary({ pageId: ABOUT_PAGE_ID, path: "about", title: longTitle })],
        nextPageToken: "",
      },
    },
    // The read is what the manifest records the title from, so it carries the
    // same long title the listing does.
    {
      method: "GET",
      pattern: PAGE_BY_ID,
      reply: { ...freeFormPageDetail(ABOUT_PAGE_ID, BODY_MARKER), title: longTitle },
    },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    { method: "GET", pattern: SETTINGS, reply: {} },
    { method: "PATCH", pattern: PAGE_BY_ID, reply: (call) => draftSummary(call.body.pageId, call.body.path) },
  ]);

  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.pages[0].title, longTitle);

  await pagesPush(invoke(workspace, wire, { verb: "pages push", content: contentStub().module }).invocation);
  assert.equal(wire.matching("PATCH", PAGE_BY_ID)[0].body.title, longTitle);
});

test("TR00621 pull-to-push keeps a legacy raw-HTML 404 read-only while four canonical drafts update", { skip: MONOREPO_ONLY }, async (site) => {
  const workspace = await fixture(site);
  const ordinaryPages = [
    pageSummary({ pageId: HOME_PAGE_ID, path: "", title: "Taproot", status: "PAGE_STATUS_DRAFT", hasDraft: true }),
    pageSummary({ pageId: ABOUT_PAGE_ID, path: "about", title: "About Taproot", status: "PAGE_STATUS_DRAFT", hasDraft: true }),
    pageSummary({ pageId: STORY_PAGE_ID, path: "pricing", title: "Pricing", status: "PAGE_STATUS_DRAFT", hasDraft: true }),
    pageSummary({
      pageId: PUBLISHING_PAGE_ID,
      path: "publishing",
      title: "Publishing",
      status: "PAGE_STATUS_DRAFT",
      hasDraft: true,
    }),
  ];
  const legacy404 = pageSummary({
    pageId: NOT_FOUND_PAGE_ID,
    path: "404",
    title: "Not found",
    status: "PAGE_STATUS_DRAFT",
    hasDraft: true,
    isGenerated: true,
  });
  const livePages = [...ordinaryPages, legacy404];
  const wire = api([
    { method: "GET", pattern: PAGES_LIST, reply: { pages: livePages, nextPageToken: "" } },
    {
      method: "GET",
      pattern: PAGE_BY_ID,
      reply: (call) => {
        const pageId = call.pathname.split("/").pop();
        if (pageId === NOT_FOUND_PAGE_ID) {
          return {
            ...freeFormPageDetail(pageId, "unused"),
            title: "Not found",
            template: {
              templateType: "TEMPLATE_TYPE_FREE_FORM",
              templateVersion: "1.0",
              freeFormData: {
                body: {
                  type: "doc",
                  content: [{ type: "rawHtml", attrs: { html: "<h1>Nothing rooted here yet.</h1>" } }],
                },
              },
            },
          };
        }
        return freeFormPageDetail(pageId, `pulled body ${pageId}`);
      },
    },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    { method: "GET", pattern: SETTINGS, reply: {} },
    { method: "PATCH", pattern: PAGE_BY_ID, reply: (call) => draftSummary(call.body.pageId, call.body.path) },
  ]);

  const pulled = await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  assert.equal(pulled.pages.readOnly, 1);
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  const readOnly404 = manifest.pages.find((entry) => entry.pageId === NOT_FOUND_PAGE_ID);
  assert.deepEqual(
    {
      file: readOnly404.file,
      path: readOnly404.path,
      workspaceMode: readOnly404.workspaceMode,
      readOnlyReason: readOnly404.readOnlyReason,
    },
    {
      file: "pages/404.pm.json",
      path: "404",
      workspaceMode: "read-only",
      readOnlyReason: "system-404",
    },
  );
  assert.match(readOnly404.workspaceContentHash, /^sha256:[0-9a-f]{64}$/u);

  // The complete unchanged pull is executable: the legacy rawHtml projection
  // is verified and skipped while the four ordinary files take their existing
  // fresh live identities. This is the step that failed during TR00621.
  const unchanged = await pagesPush(invoke(workspace, wire, {
    verb: "pages push",
    content: REAL_CONTENT,
  }).invocation);
  assert.equal(unchanged.pages.updated, 4);
  assert.equal(unchanged.pages.skippedReadOnly, 1);
  assert.deepEqual(unchanged.pages.readOnlyItems, [{
    file: "pages/404.pm.json",
    path: "404",
    pageId: NOT_FOUND_PAGE_ID,
    reason: "system-404",
  }]);
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).some((call) => call.body.pageId === NOT_FOUND_PAGE_ID), false);

  // Reproduce the dogfood edit: replace only the four pulled editable sources
  // with the checked-in Taproot-www Markdown fixture, then push the whole
  // workspace again. The real converter and validator exercise tables,
  // sections, inline facts, and component documents beside the unchanged 404.
  const currentManifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  for (const pagePath of TAPROOT_WWW_PAGE_PATHS) {
    const entry = currentManifest.pages.find((candidate) => candidate.path === pagePath);
    await rm(workspacePath(workspace, entry.file));
    await writeFile(
      workspacePath(workspace, `pages/${TAPROOT_WWW_PAGE_FILES[pagePath]}`),
      TAPROOT_WWW_PAGE_SOURCES[pagePath],
    );
  }
  const styles = structuredClone(TAPROOT_WWW_STYLES);
  styles.entityId = SITE_ID;
  await writeFile(
    workspacePath(workspace, "settings/taproot-styles.json"),
    `${JSON.stringify(styles, undefined, 2)}\n`,
  );

  const dogfood = await pagesPush(invoke(workspace, wire, {
    verb: "pages push",
    content: REAL_CONTENT,
  }).invocation);
  assert.equal(dogfood.pages.updated, 4);
  assert.equal(dogfood.pages.skippedReadOnly, 1);
  assert.deepEqual(
    wire.matching("PATCH", PAGE_BY_ID).slice(-4).map((call) => call.body.path).sort(),
    TAPROOT_WWW_PAGE_PATHS.slice().sort(),
  );
  // Pull and both pushes each resolve the site's page list instead of trusting
  // fixture ids without a current site-bound lookup.
  assert.equal(wire.matching("GET", PAGES_LIST).length, 3);

  const readOnlySource = await readWorkspaceText(workspace, "pages/404.pm.json");
  const mutationsBeforeRefusals = wire.matching("PATCH", PAGE_BY_ID).length;
  await writeFile(workspacePath(workspace, "pages/404.pm.json"), `${readOnlySource} `);
  await assert.rejects(
    pagesPush(invoke(workspace, wire, { verb: "pages push", content: REAL_CONTENT }).invocation),
    (error) => error?.code === "pages.read_only_modified" && error?.field === "pages/404.pm.json",
  );
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, mutationsBeforeRefusals);

  await writeFile(workspacePath(workspace, "pages/404.pm.json"), readOnlySource);
  const replacementManifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  replacementManifest.pages.push({
    pageId: "00000000-0000-4000-8000-000000000099",
    resourceId: "00000000-0000-4000-8000-000000000199",
    path: "404",
    title: "Replacement",
    status: "PAGE_STATUS_DRAFT",
    templateType: "TEMPLATE_TYPE_FREE_FORM",
    hasDraft: true,
    isGenerated: false,
    file: "pages/replacement-404.pm.json",
  });
  await writeFile(
    workspacePath(workspace, ".taproot-site-manifest.json"),
    `${JSON.stringify(replacementManifest, undefined, 2)}\n`,
  );
  await writeFile(
    workspacePath(workspace, "pages/replacement-404.pm.json"),
    JSON.stringify({
      type: "doc",
      content: [{ type: "rawHtml", attrs: { html: "<aside>unsafe replacement</aside>" } }],
    }),
  );
  await assert.rejects(
    pagesPush(invoke(workspace, wire, { verb: "pages push", content: REAL_CONTENT }).invocation),
    (error) => error?.code === "pages.system_page_read_only" && error?.field === "pages/replacement-404.pm.json",
  );
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, mutationsBeforeRefusals);
});

// ---------------------------------------------------------------------------
// pages push
// ---------------------------------------------------------------------------

const PUSH_WORKSPACE = {
  ".taproot-site-manifest.json": manifestFixture([
    {
      pageId: HOME_PAGE_ID,
      resourceId: resourceIdFor(HOME_PAGE_ID),
      path: "",
      title: "Home",
      description: "The front door.",
      status: "PAGE_STATUS_PUBLISHED",
      templateType: "TEMPLATE_TYPE_FREE_FORM",
      file: "pages/index.pm.json",
    },
  ]),
  "pages/index.pm.json": paragraphDocument(BODY_MARKER),
  "pages/about.md": "---\ntitle: About us\npath: about\ndescription: Who we are\n---\n\nHello.\n",
};

function draftSummary(pageId, pagePath, overrides = {}) {
  return pageSummary({ pageId, path: pagePath, status: "PAGE_STATUS_DRAFT", hasDraft: true, ...overrides });
}

function pushRoutes({ live = [pageSummary({ pageId: HOME_PAGE_ID, path: "", title: "Home" })] } = {}) {
  return [
    { method: "GET", pattern: PAGES_LIST, reply: { pages: live, nextPageToken: "" } },
    {
      method: "POST",
      pattern: PAGES_COLLECTION,
      reply: (call) => draftSummary(NEW_PAGE_ID, call.body.path),
    },
    {
      method: "PATCH",
      pattern: PAGE_BY_ID,
      reply: (call) => draftSummary(call.body.pageId, call.body.path),
    },
  ];
}

test("pages push creates and updates from the workspace and round-trips the manifest", async (site) => {
  const workspace = await fixture(site, PUSH_WORKSPACE);
  const wire = api(pushRoutes());
  const content = contentStub();
  const { invocation, progress } = invoke(workspace, wire, { verb: "pages push", content: content.module });
  const result = await pagesPush(invocation);

  assert.equal(result.pages.created, 1);
  assert.equal(result.pages.updated, 1);
  assert.equal(result.allowRawHtml, false);
  assert.equal(result.nextStep, "approve");

  // Every document is validated before the first mutation leaves the process:
  // the server checks a free-form body only for presence, so a half-validated
  // push would leave a half-broken site behind.
  assert.equal(content.calls.validate.length, 2);
  assert.deepEqual(content.calls.validate[0].options, { allowRawHtml: false });

  const created = wire.matching("POST", PAGES_COLLECTION);
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].body, {
    siteId: SITE_ID,
    path: "about",
    title: "About us",
    shortDescription: "Who we are",
    template: {
      templateType: "TEMPLATE_TYPE_FREE_FORM",
      templateVersion: "1.0",
      freeFormData: {
        body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello." }] }] },
      },
    },
  });

  const updated = wire.matching("PATCH", PAGE_BY_ID);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].pathname, `/api/v1/pages/${HOME_PAGE_ID}`);
  assert.equal(updated[0].body.pageId, HOME_PAGE_ID);
  assert.equal(updated[0].body.siteId, undefined);
  assert.equal(updated[0].body.path, "");
  // The whole template travels on an update; PATCH here is not a patch mask.
  assert.equal(updated[0].body.template.templateType, "TEMPLATE_TYPE_FREE_FORM");

  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  const record = manifest.pages.find((entry) => entry.pageId === NEW_PAGE_ID);
  assert.equal(record.file, "pages/about.md");
  assert.equal(record.path, "about");
  assert.equal(record.pendingApproval, true);
  assert.equal(manifest.pages.find((entry) => entry.pageId === HOME_PAGE_ID).pendingApproval, true);
  assert.ok(progress.some((line) => line.includes("Validating 'pages/about.md'")));
});

/**
 * The upgrade refusal reaches the operator as an instruction, not as a field
 * name (TR00703).
 *
 * The exchange is the first request every site verb makes and it sits outside
 * each verb's own refusal guidance, so this pins that a refusal raised there is
 * still announced — and that the announcement carries the server's own
 * description, which is where both versions and the install command live. A
 * `humanFailure` line alone would say only "Taproot rejected the request field
 * 'CliUpgradeRequired'", which is the message for CLIs too old to know better,
 * not for one that can do better.
 */
test("an outdated CLI is refused at the exchange with the server's own upgrade instruction", async (site) => {
  const workspace = await fixture(site, PUSH_WORKSPACE);
  const upgradeDescription = "This @taprootio/site-authoring CLI reports version 0.1.0; Taproot accepts only the "
    + "latest published release, 9.9.9. Upgrade with: npm install -g @taprootio/site-authoring@latest.";
  const wire = api([
    {
      method: "POST",
      pattern: TOKEN_EXCHANGE,
      reply: () => jsonResponse(violation("CliUpgradeRequired", upgradeDescription), 400),
    },
    ...pushRoutes(),
  ]);
  await saveCredential(
    { XDG_CONFIG_HOME: workspace.configHome },
    {
      apiOrigin: "https://app.taproot.test",
      accountId: "eeee5555-ffff-4555-8555-aaaa55555555",
      key: "tr_live_stored_sign_in_that_must_never_be_logged",
      keyId: "dddd4444-eeee-4444-8444-ffff44444444",
      keyPrefix: "tr_live_ab12cd34...",
    },
    { now: () => 1_700_000_000_000 },
  );
  const content = contentStub();
  const { invocation, progress } = invoke(workspace, wire, {
    verb: "pages push",
    content: content.module,
    environment: { XDG_CONFIG_HOME: workspace.configHome },
  });

  await assert.rejects(
    pagesPush(invocation),
    (error) => error?.field === "CliUpgradeRequired" && error.refusalKind() === "cli_outdated",
  );

  // Refused before the push validated or sent anything: the check needs no
  // credential and no document, so nothing else should have run.
  assert.deepEqual(content.calls.validate, []);
  assert.ok(progress.some((line) => line.includes(upgradeDescription)));
  assert.ok(progress.some((line) => line.includes("npm install -g @taprootio/site-authoring@latest")));
});

/**
 * The rollout switch's whole point (TR00692): a paused platform is announced
 * before the push does any work, and the write is still attempted and still
 * refused as `platform_paused`.
 *
 * Run through the sign-in exchange rather than `TAPROOT_SITE_KEY`, because the
 * exchange is the only thing that reports the switch — the environment path
 * performs none and is deliberately left saying "not known".
 */
test("pages push warns about a paused platform before validating, then still refuses at the write", async (site) => {
  const workspace = await fixture(site, PUSH_WORKSPACE);
  const wire = api([
    {
      method: "POST",
      pattern: TOKEN_EXCHANGE,
      reply: {
        rawKey: EXCHANGED_KEY,
        keyId: "cccc3333-dddd-4333-8333-eeee33333333",
        keyPrefix: "tr_live_ex99ab88...",
        siteId: SITE_ID,
        expiresAt: "2026-12-31T23:59:59.000Z",
        capabilities: [CAPABILITY_CONTENT, CAPABILITY_DESIGN, CAPABILITY_DEPLOYMENTS],
        externalWritesEnabled: false,
      },
    },
    // Listed before pushRoutes() because the first matching route wins: this is
    // the write the transactional freeze refuses, in the shape the server sends.
    {
      method: "PATCH",
      pattern: PAGE_BY_ID,
      reply: () =>
        jsonResponse({ code: 14, details: [{ fieldViolations: [{ field: "SiteAuthoringRollout" }] }] }, 503),
    },
    ...pushRoutes(),
  ]);
  await saveCredential(
    { XDG_CONFIG_HOME: workspace.configHome },
    {
      apiOrigin: "https://app.taproot.test",
      accountId: "eeee5555-ffff-4555-8555-aaaa55555555",
      key: "tr_live_stored_sign_in_that_must_never_be_logged",
      keyId: "dddd4444-eeee-4444-8444-ffff44444444",
      keyPrefix: "tr_live_ab12cd34...",
    },
    { now: () => 1_700_000_000_000 },
  );
  const content = contentStub();
  const { invocation, progress } = invoke(workspace, wire, {
    verb: "pages push",
    content: content.module,
    // No TAPROOT_SITE_KEY: this run exchanges the stored sign-in, which is what
    // reports the switch.
    environment: { XDG_CONFIG_HOME: workspace.configHome },
  });

  await assert.rejects(
    pagesPush(invocation),
    (error) => error?.field === "SiteAuthoringRollout" && error.refusalKind() === "platform_paused",
  );

  // Warned before the first document was validated, which is the difference
  // between learning this up front and learning it from a refusal.
  const warned = progress.findIndex((line) => line.includes(EXTERNAL_WRITES_SETTING_KEY));
  const validated = progress.findIndex((line) => line.includes("Validating 'pages/about.md'"));
  assert.ok(warned >= 0, "the paused platform is announced");
  assert.ok(validated > warned, "the warning precedes validation");
  // The refusal's own guidance repeats the setting, so an agent that reads only
  // the failure still learns where the switch is and who can flip it.
  assert.ok(
    progress.findLastIndex((line) => line.includes(EXTERNAL_WRITES_SETTING_KEY)) > validated,
    "the refusal guidance names the setting too",
  );
  // Advisory, not a gate: the push validated everything and sent the write, and
  // the server is what refused it.
  assert.equal(content.calls.validate.length, 2);
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 1);
});

test("pages push keeps the '/' field in the not-found contract", async (site) => {
  // The empty normalized root path would be dropped as falsy by the result
  // emitters, so the error names the documented spelling instead.
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([]),
    "pages/about.md": "---\ntitle: About us\npath: about\ndescription: Who we are\n---\n\nHello.\n",
  });
  const wire = api(pushRoutes());
  const { invocation } = invoke(workspace, wire, {
    verb: "pages push",
    pagePaths: ["/"],
    content: contentStub().module,
  });
  await assert.rejects(
    pagesPush(invocation),
    (error) => error?.code === "pages.page_not_found" && error?.field === "/",
  );
  assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
});

test("pages push can narrow mutations by the same page-path selector approve uses", async (site) => {
  const workspace = await fixture(site, PUSH_WORKSPACE);
  const wire = api(pushRoutes());
  const { invocation } = invoke(workspace, wire, {
    verb: "pages push",
    pagePaths: ["about"],
    content: contentStub().module,
  });

  const result = await pagesPush(invocation);

  assert.equal(result.pages.total, 1);
  assert.deepEqual(result.pages.items.map((item) => item.path), ["about"]);
  assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 1);
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
});

// ---------------------------------------------------------------------------
// TR00622 — selection-scoped push
// ---------------------------------------------------------------------------

/** A workspace holding one valid page and one whose document no longer validates. */
const STALE_WORKSPACE = {
  ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry()]),
  "pages/about.md": ABOUT_MARKDOWN,
  "pages/rates.md": "---\ntitle: Rates\npath: rates\n---\n\nStale.\n",
};

/**
 * Fails exactly the document a page left on an obsolete contract would fail,
 * identified by its converted text so the selected page is unaffected.
 */
function staleDocumentContent(marker = "Stale.") {
  return contentStub({
    errors: (document_) =>
      document_?.content?.[0]?.content?.[0]?.text === marker
        ? [{ code: "content.attr_unsupported", path: "/content/0", message: "the component field was removed" }]
        : [],
  });
}

function aboutLiveRoutes() {
  return pushRoutes({ live: [pageSummary({ pageId: ABOUT_PAGE_ID, path: "about", title: "About us" })] });
}

test("TR00622 a targeted push is not blocked by an unrelated page's stale document", async (site) => {
  const workspace = await fixture(site, STALE_WORKSPACE);
  const wire = api(aboutLiveRoutes());
  const content = staleDocumentContent();
  const { invocation, progress } = invoke(workspace, wire, {
    verb: "pages push",
    pagePaths: ["about"],
    content: content.module,
  });

  const result = await pagesPush(invocation);

  // SHY residual R3: the stale page is not this push's business, and it is
  // never even converted, let alone validated.
  assert.equal(result.pages.updated, 1);
  assert.equal(result.pages.selection, "targeted");
  assert.deepEqual(result.pages.selectedPaths, ["about"]);
  assert.equal(result.pages.discovered, 2);
  assert.equal(result.pages.validated, 1);
  assert.equal(content.calls.convert.length, 1);
  assert.equal(content.calls.validate.length, 1);
  assert.ok(progress.some((line) => line.includes("Selected 1 of 2 page source(s)")));
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 1);
});

test("a whole-workspace push is still the command that reports the stale page", async (site) => {
  const workspace = await fixture(site, STALE_WORKSPACE);
  const wire = api(aboutLiveRoutes());
  const content = staleDocumentContent();
  const { invocation, progress } = invoke(workspace, wire, { verb: "pages push", content: content.module });

  await assert.rejects(
    pagesPush(invocation),
    (error) => error?.code === "pages.document_invalid" && error?.field === "pages/rates.md:/content/0",
  );
  assert.ok(progress.some((line) => line.includes("Validating every one of the 2 page source(s)")));
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
  assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
});

test("a targeted push still fails every guard that applies to the selected page", async (testContext) => {
  const cases = [
    {
      label: "invalid document",
      files: { "pages/about.md": ABOUT_MARKDOWN },
      content: () => staleDocumentContent("Hello."),
      code: "pages.document_invalid",
    },
    {
      label: "unresolved media reference",
      files: {
        "pages/about.md": ABOUT_MARKDOWN,
      },
      content: () =>
        contentStub({
          onConvert: async (options) => {
            await options.resolveImage("media/missing.png");
          },
        }),
      code: "media.unresolved_reference",
    },
    {
      label: "a path a different live page already holds",
      // Tracked as the About page, but renamed onto a path another live page
      // is sitting on. The server refuses the duplicate; without this the
      // refusal arrives mid-phase-two.
      manifest: [trackedAboutEntry()],
      files: { "pages/about.md": "---\ntitle: About us\npath: taken\n---\n\nHello.\n" },
      selector: "taken",
      live: [
        pageSummary({ pageId: ABOUT_PAGE_ID, path: "about", title: "About us" }),
        pageSummary({ pageId: STORY_PAGE_ID, path: "taken", title: "Taken" }),
      ],
      content: () => contentStub(),
      code: "pages.path_taken",
    },
    {
      label: "an immutable template type",
      files: { "pages/about.md": ABOUT_MARKDOWN },
      live: [pageSummary({ pageId: ABOUT_PAGE_ID, path: "about", templateType: "TEMPLATE_TYPE_ARTICLE" })],
      content: () => contentStub(),
      code: "pages.template_immutable",
    },
    {
      label: "a system page this site does not have",
      files: { "pages/index.md": "---\ntitle: Home\npath: \n---\n\nHello.\n" },
      selector: "/",
      live: [pageSummary({ pageId: ABOUT_PAGE_ID, path: "about", title: "About us" })],
      content: () => contentStub(),
      code: "pages.system_page_missing",
    },
  ];

  for (const scenario of cases) {
    await testContext.test(scenario.label, async (caseContext) => {
      const workspace = await fixture(caseContext, {
        ".taproot-site-manifest.json": manifestFixture(scenario.manifest ?? []),
        ...scenario.files,
      });
      const wire = api(pushRoutes({
        live: scenario.live ?? [pageSummary({ pageId: ABOUT_PAGE_ID, path: "about", title: "About us" })],
      }));
      const { invocation } = invoke(workspace, wire, {
        verb: "pages push",
        pagePaths: [scenario.selector ?? "about"],
        content: scenario.content().module,
      });

      await assert.rejects(pagesPush(invocation), (error) => error?.code === scenario.code);
      assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
      assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
    });
  }
});

test("two editable sources for one page path refuse the push that would touch that path", async (site) => {
  const workspace = await fixture(site, {
    // The manifest tracks the ProseMirror source; the author added a Markdown
    // one beside it without removing the first. Choosing between them is the
    // guess one source per page exists to refuse.
    ".taproot-site-manifest.json": manifestFixture([
      trackedAboutEntry({ file: "pages/about.pm.json", sourceFormat: "prosemirror" }),
    ]),
    "pages/about.pm.json": paragraphDocument(BODY_MARKER),
    "pages/about.md": ABOUT_MARKDOWN,
    "pages/rates.md": "---\ntitle: Rates\npath: rates\n---\n\nRates.\n",
  });
  const wire = api(aboutLiveRoutes());

  await assert.rejects(
    pagesPush(
      invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module }).invocation,
    ),
    (error) => error?.code === "pages.path_conflict" && error?.field === "about",
  );
  await assert.rejects(
    pagesPush(invoke(workspace, wire, { verb: "pages push", content: contentStub().module }).invocation),
    { code: "pages.path_conflict" },
  );

  // A selection that cannot reach the contested path is not the command that
  // has to resolve it.
  const { invocation, progress } = invoke(workspace, wire, {
    verb: "pages push",
    pagePaths: ["rates"],
    content: contentStub().module,
  });
  const result = await pagesPush(invocation);
  assert.equal(result.pages.created, 1);
  assert.ok(progress.some((line) => line.includes("neither is in this selection")));
});

test("removing the tracked source is what makes a page's format change stick", async (site) => {
  const workspace = await fixture(site, {
    // The other half of the documented transition: the `.pm.json` the manifest
    // records is gone, and a `.md` claims the same path.
    ".taproot-site-manifest.json": manifestFixture([
      trackedAboutEntry({ file: "pages/about.pm.json", sourceFormat: "prosemirror" }),
    ]),
    "pages/about.md": ABOUT_MARKDOWN,
  });
  const wire = api(aboutLiveRoutes());

  const result = await pagesPush(
    invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module }).invocation,
  );

  assert.equal(result.pages.updated, 1);
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  const entry = manifest.pages.find((page) => page.pageId === ABOUT_PAGE_ID);
  assert.equal(entry.file, "pages/about.md");
  assert.equal(entry.sourceFormat, "markdown");
  // The page's remote body now derives from these exact bytes, and only the
  // local half of that is recorded: what a read hands back is re-projected.
  assert.match(entry.baseline.sourceHash, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(entry.baseline.remoteHash, undefined);
});

test("pages push refuses a manifest whose recorded source format contradicts its file", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry({ sourceFormat: "prosemirror" })]),
    "pages/about.md": ABOUT_MARKDOWN,
  });
  const wire = api(aboutLiveRoutes());

  await assert.rejects(
    pagesPush(
      invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module }).invocation,
    ),
    (error) => error?.code === "workspace.manifest_invalid" && /pull/u.test(error.message),
  );
  assert.equal(wire.calls.length, 0);
});

test("a source that declares no page path is reported by a targeted push and refused by a whole one", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry()]),
    "pages/about.md": ABOUT_MARKDOWN,
    // No front matter at all: it says nothing about which page it is, so it
    // cannot be the page a selection asked for.
    "pages/orphan.md": "Just a body.\n",
  });
  const wire = api(aboutLiveRoutes());
  const { invocation, progress } = invoke(workspace, wire, {
    verb: "pages push",
    pagePaths: ["about"],
    content: contentStub().module,
  });

  const result = await pagesPush(invocation);
  assert.equal(result.pages.updated, 1);
  assert.equal(result.pages.unresolved, 1);
  assert.deepEqual(result.pages.unresolvedItems, [{ file: "pages/orphan.md", code: "pages.front_matter_missing" }]);
  assert.ok(progress.some((line) => line.includes("'pages/orphan.md' declares no readable page path")));

  await assert.rejects(
    pagesPush(invoke(workspace, wire, { verb: "pages push", content: contentStub().module }).invocation),
    (error) => error?.code === "pages.front_matter_missing" && error?.field === "pages/orphan.md",
  );
});

test("a targeted push reports the whole-workspace mode when no path narrows it", async (site) => {
  const workspace = await fixture(site, PUSH_WORKSPACE);
  const wire = api(pushRoutes());
  const { invocation } = invoke(workspace, wire, { verb: "pages push", content: contentStub().module });

  const result = await pagesPush(invocation);

  assert.equal(result.pages.selection, "workspace");
  assert.equal(result.pages.selectedPaths, undefined);
  assert.equal(result.pages.discovered, 2);
  assert.equal(result.pages.validated, 2);
  assert.equal(result.pages.unresolved, undefined);
});


async function readOnly404Fixture(site, extra = {}) {
  const body = `${JSON.stringify(paragraphDocument("system 404"), undefined, 2)}\n`;
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([
      trackedAboutEntry(),
      {
        pageId: NOT_FOUND_PAGE_ID,
        resourceId: resourceIdFor(NOT_FOUND_PAGE_ID),
        path: "404",
        title: "Not found",
        status: "PAGE_STATUS_PUBLISHED",
        templateType: "TEMPLATE_TYPE_FREE_FORM",
        file: "pages/404.pm.json",
        sourceFormat: "prosemirror",
        workspaceMode: "read-only",
        readOnlyReason: "system-404",
        workspaceContentHash: workspaceContentHash(Buffer.from(body, "utf8")),
      },
    ]),
    "pages/404.pm.json": body,
    "pages/about.md": ABOUT_MARKDOWN,
    ...extra,
  });
  return { workspace, body };
}

test("a selection may not name the read-only 404, and an edited one blocks only the whole-workspace push", async (site) => {
  const { workspace, body } = await readOnly404Fixture(site);
  const wire = api(pushRoutes({
    live: [
      pageSummary({ pageId: ABOUT_PAGE_ID, path: "about", title: "About us" }),
      pageSummary({ pageId: NOT_FOUND_PAGE_ID, path: "404", title: "Not found" }),
    ],
  }));

  await assert.rejects(
    pagesPush(
      invoke(workspace, wire, { verb: "pages push", pagePaths: ["404"], content: contentStub().module }).invocation,
    ),
    (error) => error?.code === "pages.page_read_only" && error?.field === "404",
  );
  assert.equal(wire.calls.length, 0);

  // An edited projection is a real refusal for the command that would verify
  // and skip it. A push of a different page never sends the 404 at all, so it
  // is not the command that has to notice.
  await writeFile(workspacePath(workspace, "pages/404.pm.json"), `${body} `);
  await assert.rejects(
    pagesPush(invoke(workspace, wire, { verb: "pages push", content: contentStub().module }).invocation),
    (error) => error?.code === "pages.read_only_modified" && error?.field === "pages/404.pm.json",
  );

  const result = await pagesPush(
    invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module }).invocation,
  );
  assert.equal(result.pages.updated, 1);
  assert.equal(result.pages.skippedReadOnly, 0);
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).every((call) => call.body.pageId === ABOUT_PAGE_ID), true);
});

test("a selection does not soften the workspace's ownership or containment guards", async (testContext) => {
  await testContext.test("a targeted push refuses a linked walk root", async (site) => {
    const workspace = await plantedWorkspace(site);
    const wire = api(pushRoutes({ live: [] }));
    await assert.rejects(
      pagesPush(
        invoke(workspace, wire, { verb: "pages push", pagePaths: ["escaped"], content: contentStub().module })
          .invocation,
      ),
      (error) => error?.code === "workspace.not_directory" && error?.field === "pages",
    );
    assert.equal(wire.calls.length, 0);
  });

  await testContext.test("a targeted push refuses a manifest bound to another site", async (site) => {
    const foreign = manifestFixture([trackedAboutEntry()]);
    foreign.siteId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const workspace = await fixture(site, {
      ".taproot-site-manifest.json": foreign,
      "pages/about.md": ABOUT_MARKDOWN,
    });
    const wire = api(aboutLiveRoutes());
    await assert.rejects(
      pagesPush(
        invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module })
          .invocation,
      ),
      { code: "workspace.manifest_site_mismatch" },
    );
    assert.equal(wire.calls.length, 0);
  });
});

test("a source with a readable path still claims it when a later front-matter entry is bad", async (testContext) => {
  // The general form of the titleless case: a file that says `path: about` is
  // a source for `about` even if the next line is nonsense. Treating every
  // front-matter fault as "declares no path" would drop it from the duplicate
  // pass and let the other `about` source be sent as though it were alone.
  const cases = [
    { label: "an unsupported field", block: "---\ntitle: A copy\npath: about\nbogus: x\n---\n\nBody.\n", code: "pages.front_matter_unknown" },
    { label: "a malformed line", block: "---\ntitle: A copy\npath: about\nnot a pair\n---\n\nBody.\n", code: "pages.front_matter_invalid" },
    { label: "a duplicated title", block: "---\ntitle: A copy\npath: about\ntitle: Again\n---\n\nBody.\n", code: "pages.front_matter_duplicate" },
  ];

  for (const scenario of cases) {
    await testContext.test(scenario.label, async (site) => {
      const workspace = await fixture(site, {
        ".taproot-site-manifest.json": manifestFixture([]),
        "pages/about.md": ABOUT_MARKDOWN,
        "pages/about-copy.md": scenario.block,
      });
      const wire = api(aboutLiveRoutes());

      // The second source is visible to the duplicate check even though it is
      // not itself pushable.
      await assert.rejects(
        pagesPush(
          invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module })
            .invocation,
        ),
        (error) => error?.code === "pages.path_conflict" && error?.field === "about",
      );
      assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
      assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
    });
  }
});

test("a deferred front-matter fault is still raised for the page being sent", async (site) => {
  // Deferring the fault must not swallow it: the file is only excused while
  // nothing intends to send it.
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([]),
    "pages/about.md": "---\ntitle: About us\npath: about\nbogus: x\n---\n\nHello.\n",
  });
  const wire = api(aboutLiveRoutes());

  await assert.rejects(
    pagesPush(
      invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module }).invocation,
    ),
    (error) => error?.code === "pages.front_matter_unknown" && error?.field === "bogus",
  );
  await assert.rejects(
    pagesPush(invoke(workspace, wire, { verb: "pages push", content: contentStub().module }).invocation),
    (error) => error?.code === "pages.front_matter_unknown",
  );
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
});

test("a page path declared twice with the same value is still that page's claim", async (site) => {
  // A repeated key is a fault, but not always an ambiguity: the same value
  // written twice says exactly one thing. Discarding it would drop this file
  // out of the duplicate pass and let the other 'about' source be sent as
  // though it were the only one.
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([]),
    "pages/about.md": ABOUT_MARKDOWN,
    "pages/about-copy.md": "---\ntitle: A copy\npath: about\npath: about\n---\n\nBody.\n",
  });
  const wire = api(aboutLiveRoutes());

  await assert.rejects(
    pagesPush(
      invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module }).invocation,
    ),
    (error) => error?.code === "pages.path_conflict" && error?.field === "about",
  );
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
  assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
});

test("a page path declared twice with different values claims both, and neither can be pushed around", async (site) => {
  // Two different values leave nothing to resolve — but the file is still a
  // candidate source for each of them, so a push that touches either one
  // cannot prove this file is not that page's second source.
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([]),
    "pages/about.md": ABOUT_MARKDOWN,
    "pages/rates.md": "---\ntitle: Rates\npath: rates\n---\n\nRates.\n",
    "pages/about-copy.md": "---\ntitle: A copy\npath: about\npath: elsewhere\n---\n\nBody.\n",
  });
  const wire = api(aboutLiveRoutes());

  for (const selector of ["about", "elsewhere"]) {
    await assert.rejects(
      pagesPush(
        invoke(workspace, wire, { verb: "pages push", pagePaths: [selector], content: contentStub().module })
          .invocation,
      ),
      (error) => error?.code === "pages.front_matter_duplicate" && error?.field === "path",
    );
  }
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
  assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);

  // A selection it cannot possibly be still goes through: an ambiguous file
  // narrows what can be proved, it does not block the whole workspace.
  const result = await pagesPush(
    invoke(workspace, wire, { verb: "pages push", pagePaths: ["rates"], content: contentStub().module }).invocation,
  );
  assert.equal(result.pages.created, 1);
  assert.deepEqual(result.pages.items.map((item) => item.path), ["rates"]);
});

test("a whole-workspace push still refuses an ambiguous page identity outright", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([]),
    "pages/about-copy.md": "---\ntitle: A copy\npath: about\npath: elsewhere\n---\n\nBody.\n",
  });
  const wire = api(aboutLiveRoutes());

  await assert.rejects(
    pagesPush(invoke(workspace, wire, { verb: "pages push", content: contentStub().module }).invocation),
    (error) => error?.code === "pages.front_matter_duplicate" && error?.field === "path",
  );
  assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
});

test("pages push refuses a workspace that was never pulled", async (site) => {
  const workspace = await fixture(site, { "pages/about.md": "---\ntitle: About\npath: about\n---\n\nHi.\n" });
  const wire = api(pushRoutes());
  const { invocation } = invoke(workspace, wire, { verb: "pages push", content: contentStub().module });
  await assert.rejects(
    pagesPush(invocation),
    (error) => error?.code === "workspace.manifest_missing" && /pull/u.test(error.message),
  );
  assert.equal(wire.calls.length, 0);
});

test("pages push keeps the seeded system pages update-only with immutable paths", async (testContext) => {
  await testContext.test("a system path with no live page is never created", async (site) => {
    const workspace = await fixture(site, {
      ".taproot-site-manifest.json": manifestFixture([]),
      "pages/index.md": "---\ntitle: Home\npath: \"\"\n---\n\nHome.\n",
    });
    const wire = api(pushRoutes({ live: [] }));
    const { invocation } = invoke(workspace, wire, { verb: "pages push", content: contentStub().module });
    await assert.rejects(
      pagesPush(invocation),
      (error) => error?.code === "pages.system_page_missing",
    );
    assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
  });

  await testContext.test("a system page's path cannot be moved", async (site) => {
    const workspace = await fixture(site, {
      ".taproot-site-manifest.json": manifestFixture([
        {
          pageId: HOME_PAGE_ID,
          path: "",
          title: "Home",
          templateType: "TEMPLATE_TYPE_FREE_FORM",
          file: "pages/index.md",
        },
      ]),
      "pages/index.md": "---\ntitle: Home\npath: welcome\n---\n\nHome.\n",
    });
    const wire = api(pushRoutes());
    const { invocation } = invoke(workspace, wire, { verb: "pages push", content: contentStub().module });
    await assert.rejects(
      pagesPush(invocation),
      (error) => error?.code === "pages.system_path_immutable" && error?.field === "pages/index.md",
    );
    assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
  });

  await testContext.test("the 404 page is a system page too", async (site) => {
    const workspace = await fixture(site, {
      ".taproot-site-manifest.json": manifestFixture([]),
      "pages/404.md": "---\ntitle: Not found\npath: 404\n---\n\nMissing.\n",
    });
    const wire = api(pushRoutes({ live: [] }));
    const { invocation } = invoke(workspace, wire, { verb: "pages push", content: contentStub().module });
    await assert.rejects(pagesPush(invocation), (error) => error?.code === "pages.system_page_missing");
  });
});

test("pages push never honors a read-only marker on an ordinary authored page", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([{
      pageId: ABOUT_PAGE_ID,
      path: "about",
      title: "About",
      templateType: "TEMPLATE_TYPE_FREE_FORM",
      file: "pages/about.pm.json",
      workspaceMode: "read-only",
      readOnlyReason: "system-404",
      workspaceContentHash: `sha256:${"a".repeat(64)}`,
    }]),
    "pages/about.pm.json": paragraphDocument("Authored page"),
  });
  const wire = api(pushRoutes({ live: [pageSummary()] }));

  await assert.rejects(
    pagesPush(invoke(workspace, wire, { verb: "pages push", content: REAL_CONTENT }).invocation),
    (error) => error?.code === "workspace.manifest_invalid"
      && error?.field === "pages[0].workspaceMode",
  );
  assert.equal(wire.calls.length, 0);
});

test("pages push verifies a marker-shaped projection against the live system 404 identity", async (site) => {
  const body = paragraphDocument("Authored page");
  const source = `${JSON.stringify(body, undefined, 2)}\n`;
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([{
      pageId: ABOUT_PAGE_ID,
      path: "404",
      title: "Not found",
      templateType: "TEMPLATE_TYPE_FREE_FORM",
      file: "pages/404.pm.json",
      workspaceMode: "read-only",
      readOnlyReason: "system-404",
      workspaceContentHash: workspaceContentHash(Buffer.from(source, "utf8")),
    }]),
    "pages/404.pm.json": source,
  });
  const wire = api(pushRoutes({ live: [pageSummary()] }));

  await assert.rejects(
    pagesPush(invoke(workspace, wire, { verb: "pages push", content: REAL_CONTENT }).invocation),
    (error) => error?.code === "workspace.manifest_invalid"
      && error?.field === "pages[0].pageId",
  );
  assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
});

test("pages push refuses to change a page's immutable template type", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([
      {
        pageId: STORY_PAGE_ID,
        path: "story",
        title: "Story",
        templateType: "TEMPLATE_TYPE_ARTICLE",
        file: "pages/story.md",
      },
    ]),
    "pages/story.md": "---\ntitle: Story\npath: story\n---\n\nOnce.\n",
  });
  const wire = api(pushRoutes({
    live: [pageSummary({ pageId: STORY_PAGE_ID, path: "story", templateType: "TEMPLATE_TYPE_ARTICLE" })],
  }));
  const { invocation } = invoke(workspace, wire, { verb: "pages push", content: contentStub().module });
  await assert.rejects(
    pagesPush(invocation),
    (error) => error?.code === "pages.template_immutable" && /TEMPLATE_TYPE_ARTICLE/u.test(error.message),
  );
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
});

test("pages push sends nothing when any document fails validation", async (site) => {
  const workspace = await fixture(site, PUSH_WORKSPACE);
  const wire = api(pushRoutes());
  const content = contentStub({
    errors: (document_, index) => (index === 2
      ? [{ path: "doc.content[0]", code: "node.unsupported", message: "table is not in the accepted vocabulary." }]
      : []),
  });
  const { invocation } = invoke(workspace, wire, { verb: "pages push", content: content.module });
  await assert.rejects(
    pagesPush(invocation),
    (error) => error?.code === "pages.document_invalid" && /doc\.content\[0\]/u.test(error.field),
  );
  assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
});

test("pages push refuses an explicit section context outside the staged theme intersection before mutation", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([{
      pageId: HOME_PAGE_ID,
      resourceId: resourceIdFor(HOME_PAGE_ID),
      path: "",
      title: "Home",
      description: "",
      status: "PAGE_STATUS_PUBLISHED",
      templateType: "TEMPLATE_TYPE_FREE_FORM",
      file: "pages/index.pm.json",
    }]),
    "pages/index.pm.json": {
      type: "doc",
      content: [{
        type: "section",
        attrs: { context: "missing", contentPadding: "standard", surface: "none" },
        content: [{ type: "paragraph", content: [{ type: "text", text: "Band" }] }],
      }],
    },
    "settings/taproot-styles.json": settingsDocument("SETTING_TYPE_TAPROOT_STYLES", {
      lightTheme: { contexts: { zebra: {}, alpha: {}, lightOnly: {} } },
      darkTheme: { contexts: { alpha: {}, zebra: {}, darkOnly: {} } },
    }),
  });
  const wire = api(pushRoutes());
  const { invocation } = invoke(workspace, wire, { verb: "pages push", content: contentStub().module });
  await assert.rejects(pagesPush(invocation), (error) => {
    assert.equal(error?.code, "content.section_context_unknown");
    assert.match(error.message, /'missing'/u);
    assert.match(error.message, /alpha, zebra/u);
    return true;
  });
  assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
});

test("pages push does not require a styles snapshot for root-only content", async (site) => {
  const workspace = await fixture(site, PUSH_WORKSPACE);
  assert.equal(await workspaceHas(workspace, "settings/taproot-styles.json"), false);
  const wire = api(pushRoutes());
  const { invocation } = invoke(workspace, wire, { verb: "pages push", content: contentStub().module });

  await pagesPush(invocation);

  assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 1);
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 1);
});

test("pages push requires the staged styles snapshot when a section names a context", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([{
      pageId: HOME_PAGE_ID,
      resourceId: resourceIdFor(HOME_PAGE_ID),
      path: "",
      title: "Home",
      description: "",
      status: "PAGE_STATUS_PUBLISHED",
      templateType: "TEMPLATE_TYPE_FREE_FORM",
      file: "pages/index.pm.json",
    }]),
    "pages/index.pm.json": {
      type: "doc",
      content: [{
        type: "section",
        attrs: { context: "inverted", contentPadding: "standard", surface: "none" },
        content: [{ type: "paragraph", content: [{ type: "text", text: "Band" }] }],
      }],
    },
  });
  const wire = api(pushRoutes());
  const { invocation } = invoke(workspace, wire, { verb: "pages push", content: contentStub().module });

  await assert.rejects(
    pagesPush(invocation),
    (error) => error?.code === "workspace.file_missing" && error?.field === "settings/taproot-styles.json",
  );
  assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
});

test("pages push only permits rawHtml when the caller explicitly asks for it", async (site) => {
  for (const allowRawHtml of [undefined, true]) {
    const workspace = await fixture(site, PUSH_WORKSPACE);
    const wire = api(pushRoutes());
    const content = contentStub();
    const { invocation } = invoke(workspace, wire, {
      verb: "pages push",
      content: content.module,
      ...(allowRawHtml === undefined ? {} : { allowRawHtml }),
    });
    const result = await pagesPush(invocation);
    assert.equal(result.allowRawHtml, allowRawHtml === true);
    for (const call of content.calls.validate) {
      assert.deepEqual(call.options, { allowRawHtml: allowRawHtml === true });
    }
  }
});

test("authored rawHtml keeps a stable human and JSON refusal before any page mutation", async (site) => {
  const file = "pages/about.pm.json";
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([{
      pageId: ABOUT_PAGE_ID,
      resourceId: resourceIdFor(ABOUT_PAGE_ID),
      path: "about",
      title: "About",
      description: "",
      status: "PAGE_STATUS_DRAFT",
      templateType: "TEMPLATE_TYPE_FREE_FORM",
      file,
    }]),
    [file]: {
      type: "doc",
      content: [{ type: "rawHtml", attrs: { html: "<aside>Agent-authored markup</aside>" } }],
    },
  });
  const wire = api(pushRoutes({ live: [draftSummary(ABOUT_PAGE_ID, "about")] }));
  let stdout = "";
  let stderr = "";

  const exitCode = await runCli({
    arguments_: ["--config", workspace.configPath, "pages", "push"],
    environment: { TAPROOT_SITE_KEY: TOKEN, XDG_CONFIG_HOME: site.configHome },
    cwd: workspace.project,
    stdout: { write: (chunk) => (stdout += chunk) },
    stderr: { write: (chunk) => (stderr += chunk) },
    handlers: {
      ...VERB_HANDLERS,
      "pages push": (invocation) => pagesPush({ ...invocation, content: REAL_CONTENT }),
    },
    fetch: wire.fetch,
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(JSON.parse(stdout).error, {
    code: "content.raw_html_forbidden",
    field: `${file}:/content/0`,
  });
  assert.match(stderr, /taproot-site failed \[content\.raw_html_forbidden\]/u);
  assert.match(stderr, new RegExp(`${file}:/content/0`, "u"));
  assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
});

test("pages push resolves media through the workspace media manifest", async (testContext) => {
  await testContext.test("a known reference becomes an image node the rewriter can fill", async (site) => {
    const workspace = await fixture(site, {
      ...PUSH_WORKSPACE,
      ".taproot-site-media.json": {
        mediaManifestVersion: 2,
        siteId: SITE_ID,
        media: { "media/hero.png": { imageId: IMAGE_ID, width: 1200, height: 800, alt: "Hero" } },
      },
    });
    const wire = api(pushRoutes());
    const resolved = [];
    const content = contentStub({
      onConvert: async (options) => {
        resolved.push(await options.resolveImage("./media/hero.png"));
      },
    });
    const { invocation } = invoke(workspace, wire, { verb: "pages push", content: content.module });
    await pagesPush(invocation);
    assert.deepEqual(resolved, [{ imageId: IMAGE_ID, src: "", urls: [], width: 1200, height: 800, alt: "Hero" }]);
  });

  await testContext.test("an unknown reference refuses with the reference named", async (site) => {
    const workspace = await fixture(site, PUSH_WORKSPACE);
    const wire = api(pushRoutes());
    const content = contentStub({
      onConvert: async (options) => {
        await options.resolveImage("media/missing.png");
      },
    });
    const { invocation } = invoke(workspace, wire, { verb: "pages push", content: content.module });
    await assert.rejects(
      pagesPush(invocation),
      (error) => error?.code === "media.unresolved_reference" && error?.field === "media/missing.png",
    );
  });
});

test("pages push refuses a page file whose name this package cannot carry", async (testContext) => {
  // The alternative is the silent narrowing this CLI exists to prevent: a page
  // someone wrote, in the right directory with the right extension, quietly
  // left out of a push that then reports success.
  for (const name of ["Hero Draft.md", "_draft.md", "café.md"]) {
    await testContext.test(name, async (site) => {
      const workspace = await fixture(site, {
        ".taproot-site-manifest.json": manifestFixture([]),
        [`pages/${name}`]: "---\ntitle: Draft\npath: draft\n---\n\nHi.\n",
      });
      const wire = api(pushRoutes({ live: [] }));
      const { invocation } = invoke(workspace, wire, { verb: "pages push", content: contentStub().module });
      await assert.rejects(
        pagesPush(invocation),
        (error) => error?.code === "workspace.name_unsupported" && error?.field === `pages/${name}`,
      );
      assert.equal(wire.calls.length, 0);
    });
  }

  // The other side of the boundary, pinned so it stays deliberate: a dot-entry
  // and a non-conforming *directory* are still passed over without a word.
  await testContext.test("dot-files and non-conforming directories are still skipped silently", async (site) => {
    const workspace = await fixture(site, {
      ".taproot-site-manifest.json": manifestFixture([]),
      "pages/.hidden.md": "---\ntitle: Hidden\npath: hidden\n---\n\nHi.\n",
      "pages/Old Drafts/kept.md": "---\ntitle: Kept\npath: kept\n---\n\nHi.\n",
      "pages/real.md": "---\ntitle: Real\npath: real\n---\n\nHi.\n",
    });
    const wire = api(pushRoutes({ live: [] }));
    const { invocation } = invoke(workspace, wire, { verb: "pages push", content: contentStub().module });
    const result = await pagesPush(invocation);
    assert.deepEqual(result.pages.items.map((item) => item.file), ["pages/real.md"]);
  });
});

test("pages push refuses a path the server's grammar rejects, in phase one", async (testContext) => {
  // `Validations.ValidatePagePath` requires every segment to match
  // \A[A-Za-z0-9][A-Za-z0-9._-]*\z. Discovering that server-side would break
  // the two-phase promise: the refusal would land mid-phase-two, after earlier
  // pages had already been created.
  for (const pagePath of ["Hello World", "news/Hello World", "-leading-hyphen", "news//gap"]) {
    await testContext.test(JSON.stringify(pagePath), async (site) => {
      const workspace = await fixture(site, {
        ".taproot-site-manifest.json": manifestFixture([]),
        "pages/one.md": "---\ntitle: First\npath: first\n---\n\nHi.\n",
        "pages/two.md": `---\ntitle: Second\npath: ${pagePath}\n---\n\nHi.\n`,
      });
      const wire = api(pushRoutes({ live: [] }));
      const { invocation } = invoke(workspace, wire, { verb: "pages push", content: contentStub().module });
      await assert.rejects(
        pagesPush(invocation),
        // "news//gap" collapses to an unusable path before the grammar sees it;
        // either refusal is phase one, which is the property under test.
        (error) => error?.code === "pages.path_unsupported" || error?.code === "pages.path_missing",
      );
      // The well-formed sibling was never created: nothing is sent until
      // everything has passed.
      assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
      assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
    });
  }

  await testContext.test("the home page's empty path is still legal", async (site) => {
    const workspace = await fixture(site, {
      ".taproot-site-manifest.json": manifestFixture([]),
      "pages/index.md": "---\ntitle: Home\npath: \"\"\n---\n\nHi.\n",
    });
    const wire = api(pushRoutes());
    const { invocation } = invoke(workspace, wire, { verb: "pages push", content: contentStub().module });
    const result = await pagesPush(invocation);
    assert.equal(result.pages.updated, 1);
  });
});

test("pages push tolerates a hand-edited manifest holding a null entry", async (site) => {
  const workspace = await fixture(site, {
    ...PUSH_WORKSPACE,
    ".taproot-site-manifest.json": manifestFixture([
      null,
      {
        pageId: HOME_PAGE_ID,
        resourceId: resourceIdFor(HOME_PAGE_ID),
        path: "",
        title: "Home",
        description: "The front door.",
        status: "PAGE_STATUS_PUBLISHED",
        templateType: "TEMPLATE_TYPE_FREE_FORM",
        file: "pages/index.pm.json",
      },
    ]),
  });
  const wire = api(pushRoutes());
  const { invocation } = invoke(workspace, wire, { verb: "pages push", content: contentStub().module });
  const result = await pagesPush(invocation);
  // The null is simply never matched — it must not become a TypeError collapsed
  // to an opaque site.failed *after* pages have already been created.
  assert.equal(result.pages.created, 1);
  assert.equal(result.pages.updated, 1);
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.pages[0], null);
  assert.ok(manifest.pages.some((entry) => entry?.pageId === NEW_PAGE_ID));
});

// `pull` records a free-form page under the `.pm.json` it wrote. The documented
// way to switch that page to Markdown is to delete the file and author a `.md`
// beside it — after which the manifest entry is reachable by pageId and by
// nothing else.
const REPLACED_FILE_WORKSPACE = {
  ".taproot-site-manifest.json": manifestFixture([{
    pageId: ABOUT_PAGE_ID,
    resourceId: resourceIdFor(ABOUT_PAGE_ID),
    path: "about",
    title: "About",
    description: "Who we are.",
    status: "PAGE_STATUS_PUBLISHED",
    templateType: "TEMPLATE_TYPE_FREE_FORM",
    file: "pages/about.pm.json",
  }]),
};

test("pages push keeps fields the workspace never restated", async (testContext) => {
  const live = [pageSummary({ pageId: ABOUT_PAGE_ID, path: "about" })];

  await testContext.test("a replacement file inherits through the page's identity", async (site) => {
    const workspace = await fixture(site, {
      ...REPLACED_FILE_WORKSPACE,
      "pages/about.md": "---\ntitle: About\npath: about\n---\n\nHi.\n",
    });
    const wire = api(pushRoutes({ live }));
    const { invocation } = invoke(workspace, wire, { verb: "pages push", content: contentStub().module });
    await pagesPush(invocation);

    // UpdatePage takes a whole template, so an omitted description is not
    // "leave it alone" — it is "clear it". Identity fallback preserves it.
    const patched = wire.matching("PATCH", PAGE_BY_ID)[0];
    assert.equal(patched.body.shortDescription, "Who we are.");
  });

  await testContext.test("front-matter still overrides what the manifest remembers", async (site) => {
    const workspace = await fixture(site, {
      ...REPLACED_FILE_WORKSPACE,
      "pages/about.md": "---\ntitle: About\npath: about\ndescription: Rewritten\n---\n\nHi.\n",
    });
    const wire = api(pushRoutes({ live }));
    const { invocation } = invoke(workspace, wire, { verb: "pages push", content: contentStub().module });
    await pagesPush(invocation);

    const patched = wire.matching("PATCH", PAGE_BY_ID)[0];
    assert.equal(patched.body.shortDescription, "Rewritten");
  });
});

test("pages push refuses a path a different live page already holds", async (testContext) => {
  await testContext.test("a rename onto an outside page's path", async (site) => {
    const workspace = await fixture(site, {
      ".taproot-site-manifest.json": manifestFixture([
        { pageId: ABOUT_PAGE_ID, path: "about", title: "About", file: "pages/about.md" },
      ]),
      "pages/about.md": "---\ntitle: About\npath: story\n---\n\nHi.\n",
    });
    const wire = api(pushRoutes({
      live: [
        pageSummary({ pageId: ABOUT_PAGE_ID, path: "about" }),
        // A page this workspace does not track, sitting on the requested path.
        pageSummary({ pageId: STORY_PAGE_ID, path: "story" }),
      ],
    }));
    const { invocation } = invoke(workspace, wire, { verb: "pages push", content: contentStub().module });
    await assert.rejects(
      pagesPush(invocation),
      (error) => error?.code === "pages.path_taken" && /already holds/u.test(error.message),
    );
    assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
    assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
  });

  await testContext.test("a page matching its own path is the ordinary update", async (site) => {
    const workspace = await fixture(site, {
      ".taproot-site-manifest.json": manifestFixture([
        { pageId: ABOUT_PAGE_ID, path: "about", title: "About", file: "pages/about.md" },
      ]),
      "pages/about.md": "---\ntitle: About\npath: about\n---\n\nHi.\n",
    });
    const wire = api(pushRoutes({ live: [pageSummary({ pageId: ABOUT_PAGE_ID, path: "about" })] }));
    const { invocation } = invoke(workspace, wire, { verb: "pages push", content: contentStub().module });
    const result = await pagesPush(invocation);
    assert.equal(result.pages.updated, 1);
    assert.equal(result.pages.created, 0);
  });
});

test("a page list the CLI cannot fully enumerate stops every verb that decides from it", async (testContext) => {
  // Each of these builds its whole decision — create-or-update, which drafts to
  // stage, which pages to publish — out of one listing. A partial one used to
  // narrow the work silently and still exit 0.
  const truncatedPages = {
    method: "GET",
    pattern: PAGES_LIST,
    reply: { pages: [pageSummary()], nextPageToken: "more" },
  };
  const cases = [
    {
      name: "pages push",
      code: "pages.live_list_truncated",
      files: PUSH_WORKSPACE,
      extra: () => ({ verb: "pages push", content: contentStub().module }),
      run: pagesPush,
    },
    {
      name: "approve",
      code: "approve.live_list_truncated",
      files: { ".taproot-site-manifest.json": manifestFixture([{ pageId: ABOUT_PAGE_ID, path: "about", title: "A" }]) },
      extra: () => ({ verb: "approve" }),
      run: approve,
    },
    {
      name: "deploy --staging",
      code: "deploy.live_list_truncated",
      files: { ".taproot-site-manifest.json": manifestFixture([{ pageId: ABOUT_PAGE_ID, path: "about", title: "A" }]) },
      extra: () => ({ verb: "deploy", deployTarget: "staging" }),
      run: deploy,
    },
  ];
  for (const scenario of cases) {
    await testContext.test(scenario.name, async (site) => {
      const workspace = await fixture(site, scenario.files);
      const wire = api([truncatedPages, ...pushRoutes().slice(1), ...deployRoutes().slice(1)]);
      const { invocation } = invoke(workspace, wire, scenario.extra());
      await assert.rejects(scenario.run(invocation), (error) => error?.code === scenario.code);
      // Nothing was written, staged, or deployed.
      assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
      assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
      assert.equal(wire.matching("POST", PUBLISH_DRAFTS).length, 0);
      assert.equal(wire.matching("POST", DEPLOY).length, 0);
    });
  }
});

test("pages push refuses front-matter it would otherwise have to drop", async (testContext) => {
  const cases = [
    {
      name: "unknown field",
      source: "---\ntitle: A\npath: a\nlayout: wide\n---\n\nHi.\n",
      code: "pages.front_matter_unknown",
    },
    {
      name: "duplicate field",
      source: "---\ntitle: A\ntitle: B\npath: a\n---\n\nHi.\n",
      code: "pages.front_matter_duplicate",
    },
    { name: "missing block", source: "Just a body.\n", code: "pages.front_matter_missing" },
    { name: "unterminated block", source: "---\ntitle: A\npath: a\n", code: "pages.front_matter_unterminated" },
    { name: "no path", source: "---\ntitle: A\n---\n\nHi.\n", code: "pages.path_missing" },
  ];
  for (const scenario of cases) {
    await testContext.test(scenario.name, async (site) => {
      const workspace = await fixture(site, {
        ".taproot-site-manifest.json": manifestFixture([]),
        "pages/new.md": scenario.source,
      });
      const wire = api(pushRoutes({ live: [] }));
      const { invocation } = invoke(workspace, wire, { verb: "pages push", content: contentStub().module });
      await assert.rejects(pagesPush(invocation), (error) => error?.code === scenario.code);
    });
  }
});

// ---------------------------------------------------------------------------
// nav push
// ---------------------------------------------------------------------------

// `SaveSiteNavigation` parses `id` and `resourceId` as GUIDs, so the fixtures
// carry real UUID shapes rather than readable stand-ins — a readable id would
// be refused by the server with an unclassified 400 naming nothing.
const NAV_ROOT = navId(1);
const NAV_PAGE_CHILD = navId(2);
const NAV_LINK_CHILD = navId(3);
const NAV_BROWSER_ONLY = navId(4);

const NAV_TREE = [
  {
    id: NAV_ROOT,
    kind: "NAV_ITEM_KIND_GROUP_HEADER",
    title: "Company",
    children: [
      { id: NAV_PAGE_CHILD, kind: "NAV_ITEM_KIND_PAGE", title: "Home", resourceId: resourceIdFor(HOME_PAGE_ID) },
      {
        id: NAV_LINK_CHILD,
        kind: "NAV_ITEM_KIND_EXTERNAL_URL",
        title: "Blog",
        externalUrl: "https://example.com/blog",
      },
    ],
  },
];

// `nav push` checks PAGE targets against the live page list before it replaces
// anything, so every nav fixture that reaches the wire needs one.
const NAV_PAGES_ROUTE = {
  method: "GET",
  pattern: PAGES_LIST,
  reply: {
    pages: [pageSummary({ pageId: HOME_PAGE_ID, path: "" }), pageSummary({ pageId: STORY_PAGE_ID, path: "story" })],
    nextPageToken: "",
  },
};

test("nav push re-reads the live tree immediately before replacing it whole", async (site) => {
  const workspace = await fixture(site, { "nav.json": { siteId: SITE_ID, navItems: NAV_TREE } });
  const wire = api([
    NAV_PAGES_ROUTE,
    {
      method: "GET",
      pattern: NAVIGATION,
      reply: {
        navItems: [
          { id: NAV_ROOT, kind: "NAV_ITEM_KIND_GROUP_HEADER", title: "Company", children: [] },
          {
            id: NAV_BROWSER_ONLY,
            kind: "NAV_ITEM_KIND_PAGE",
            title: "Added in the browser",
            resourceId: resourceIdFor(STORY_PAGE_ID),
          },
        ],
      },
    },
    { method: "PUT", pattern: NAVIGATION, reply: (call) => ({ navItems: call.body.navItems }) },
  ]);
  const { invocation, progress } = invoke(workspace, wire, { verb: "nav push" });
  const result = await navPush(invocation);

  // The navigation read is the last thing before the write: there is no
  // concurrency token, so this is the whole of the CLI's defence against a
  // concurrent editor. The page list is read first, so it cannot widen that
  // window.
  assert.deepEqual(
    wire.calls.map((call) => `${call.method} ${call.pathname.split("/").pop()}`),
    [`GET ${SITE_ID}`, "GET navigation", "PUT navigation"],
  );
  const saved = wire.matching("PUT", NAVIGATION)[0];
  assert.equal(saved.body.siteId, SITE_ID);
  assert.deepEqual(saved.body.navItems[0].children[0], {
    id: NAV_PAGE_CHILD,
    kind: "NAV_ITEM_KIND_PAGE",
    title: "Home",
    // The PAGE target is the site resource id, never the page id.
    resourceId: resourceIdFor(HOME_PAGE_ID),
    externalUrl: "",
    children: [],
  });
  assert.equal(saved.body.navItems[0].children[1].resourceId, "");
  assert.equal(result.navigation.items, 3);
  assert.deepEqual(result.navigation.removed, [NAV_BROWSER_ONLY]);
  assert.deepEqual(result.navigation.added, [NAV_PAGE_CHILD, NAV_LINK_CHILD].sort());
  assert.equal(result.lastWriteWins, true);
  assert.ok(progress.some((line) => line.includes("removes 1 navigation item")));
});

test("nav push carries a contact target to the wire exactly as authored", async (site) => {
  // A local business's phone number and email are the two header targets that
  // are not web pages. The number's punctuation is content, so nothing between
  // the workspace file and the wire may re-encode it.
  const dialable = "tel:+1 (555) 555-0123";
  const workspace = await fixture(site, {
    "nav.json": {
      siteId: SITE_ID,
      navItems: [
        { id: navId(1), kind: "NAV_ITEM_KIND_EXTERNAL_URL", title: "Call us", externalUrl: dialable },
        {
          id: navId(2),
          kind: "NAV_ITEM_KIND_EXTERNAL_URL",
          title: "Email us",
          externalUrl: "mailto:desk+bookings@example.test?subject=Class%20booking",
        },
      ],
    },
  });
  const wire = api([
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    { method: "PUT", pattern: NAVIGATION, reply: (call) => ({ navItems: call.body.navItems }) },
  ]);
  const { invocation } = invoke(workspace, wire, { verb: "nav push" });
  await navPush(invocation);

  const saved = wire.matching("PUT", NAVIGATION)[0];
  assert.deepEqual(saved.body.navItems.map((item) => item.externalUrl), [
    dialable,
    "mailto:desk+bookings@example.test?subject=Class%20booking",
  ]);
});

test("nav push refuses a malformed tree locally and names the item", async (testContext) => {
  const cases = [
    {
      name: "deeper than three levels",
      navItems: [{
        id: navId(1),
        kind: "NAV_ITEM_KIND_GROUP_HEADER",
        title: "A",
        children: [{
          id: navId(2),
          kind: "NAV_ITEM_KIND_GROUP_HEADER",
          title: "B",
          children: [{
            id: navId(3),
            kind: "NAV_ITEM_KIND_GROUP_HEADER",
            title: "C",
            children: [{
              id: navId(4),
              kind: "NAV_ITEM_KIND_PAGE",
              title: "D",
              resourceId: resourceIdFor(ABOUT_PAGE_ID),
            }],
          }],
        }],
      }],
      code: "nav.depth_exceeded",
      field: "navItems[0].children[0].children[0].children[0]",
    },
    {
      name: "a PAGE item addressed by page id",
      navItems: [{ id: navId(1), kind: "NAV_ITEM_KIND_PAGE", title: "A", pageId: HOME_PAGE_ID }],
      code: "nav.unknown_field",
      field: "navItems[0]",
    },
    {
      name: "a duplicate id",
      navItems: [
        { id: navId(1), kind: "NAV_ITEM_KIND_GROUP_HEADER", title: "A" },
        { id: navId(1), kind: "NAV_ITEM_KIND_GROUP_HEADER", title: "B" },
      ],
      code: "nav.id_duplicate",
      field: "navItems[1]",
    },
    // The server parses `id` with RequireGuid and answers a non-GUID with a
    // bare InvalidArgument naming no field, so a readable id has to be refused
    // here or it becomes an unclassified 400 with nothing to grep for.
    {
      name: "a readable id the server would parse as a GUID",
      navItems: [{ id: "home", kind: "NAV_ITEM_KIND_GROUP_HEADER", title: "A" }],
      code: "nav.id_invalid",
      field: "navItems[0]",
    },
    {
      name: "an uppercased id",
      navItems: [{ id: navId(1).toUpperCase(), kind: "NAV_ITEM_KIND_GROUP_HEADER", title: "A" }],
      code: "nav.id_invalid",
      field: "navItems[0]",
    },
    {
      name: "an unsupported kind",
      navItems: [{ id: navId(1), kind: "NAV_ITEM_KIND_FOLDER", title: "A" }],
      code: "nav.kind_invalid",
      field: "navItems[0]",
    },
    {
      name: "a PAGE item with no resource",
      navItems: [{ id: navId(1), kind: "NAV_ITEM_KIND_PAGE", title: "A" }],
      code: "nav.resource_missing",
      field: "navItems[0]",
    },
    {
      name: "a PAGE item targeting a page path instead of a resource id",
      navItems: [{ id: navId(1), kind: "NAV_ITEM_KIND_PAGE", title: "A", resourceId: "about" }],
      code: "nav.resource_missing",
      field: "navItems[0]",
    },
    {
      name: "an external item pointing at a non-http scheme",
      navItems: [{
        id: navId(1),
        kind: "NAV_ITEM_KIND_EXTERNAL_URL",
        title: "A",
        externalUrl: "javascript:alert(1)",
      }],
      code: "nav.external_url_invalid",
      field: "navItems[0]",
    },
    {
      name: "an external item pointing at a scheme that is neither web nor contact",
      navItems: [{
        id: navId(1),
        kind: "NAV_ITEM_KIND_EXTERNAL_URL",
        title: "A",
        externalUrl: "ftp://example.test/brochure.pdf",
      }],
      code: "nav.external_url_invalid",
      field: "navItems[0]",
    },
    {
      // A raw line break in a mailto body is the header-injection vector.
      name: "an external mailto item carrying a line break",
      navItems: [{
        id: navId(1),
        kind: "NAV_ITEM_KIND_EXTERNAL_URL",
        title: "A",
        externalUrl: "mailto:hello@example.test\nBcc:victim@example.test",
      }],
      code: "nav.external_url_invalid",
      field: "navItems[0]",
    },
    {
      name: "an external contact item with nothing to reach",
      navItems: [{ id: navId(1), kind: "NAV_ITEM_KIND_EXTERNAL_URL", title: "A", externalUrl: "tel:" }],
      code: "nav.external_url_invalid",
      field: "navItems[0]",
    },
    {
      name: "an external item carrying embedded credentials",
      navItems: [{
        id: navId(1),
        kind: "NAV_ITEM_KIND_EXTERNAL_URL",
        title: "A",
        externalUrl: "https://user:secret@example.test/",
      }],
      code: "nav.external_url_invalid",
      field: "navItems[0]",
    },
    {
      name: "a group header carrying a target",
      navItems: [{
        id: navId(1),
        kind: "NAV_ITEM_KIND_GROUP_HEADER",
        title: "A",
        resourceId: resourceIdFor(ABOUT_PAGE_ID),
      }],
      code: "nav.target_unexpected",
      field: "navItems[0]",
    },
  ];
  for (const scenario of cases) {
    await testContext.test(scenario.name, async (site) => {
      const workspace = await fixture(site, { "nav.json": { siteId: SITE_ID, navItems: scenario.navItems } });
      const wire = api([]);
      const { invocation } = invoke(workspace, wire, { verb: "nav push" });
      await assert.rejects(
        navPush(invocation),
        (error) => error?.code === scenario.code && error?.field === scenario.field,
      );
      // Local validation runs before any wire call, so a bad tree never reaches
      // the whole-tree replace.
      assert.equal(wire.calls.length, 0);
    });
  }
});

test("nav push refuses a PAGE target that points at nothing, by item path", async (testContext) => {
  function treeTargeting(resourceId) {
    return [{
      id: NAV_ROOT,
      kind: "NAV_ITEM_KIND_GROUP_HEADER",
      title: "Company",
      children: [{ id: NAV_PAGE_CHILD, kind: "NAV_ITEM_KIND_PAGE", title: "Somewhere", resourceId }],
    }];
  }

  // A well-formed UUID naming no page passes every local shape rule and comes
  // back from the server as a bare "ResourceId" — no index, nothing to locate
  // across a tree that may hold a thousand items.
  await testContext.test("a dangling resource id is named by path", async (site) => {
    const workspace = await fixture(site, { "nav.json": { siteId: SITE_ID, navItems: treeTargeting(navId(9)) } });
    const wire = api([NAV_PAGES_ROUTE]);
    const { invocation } = invoke(workspace, wire, { verb: "nav push" });
    await assert.rejects(
      navPush(invocation),
      (error) =>
        error?.code === "nav.resource_unknown"
        && error?.field === "navItems[0].children[0]"
        && /does not name a page on this site/u.test(error.message),
    );
    assert.equal(wire.matching("PUT", NAVIGATION).length, 0);
  });

  // The manifest carries pageId and resourceId side by side on one entry, so
  // reaching for the wrong one is the mistake to expect — and it is a valid
  // UUID, so only a liveness check can tell them apart.
  await testContext.test("a pageId used as a resource id says which field is wrong", async (site) => {
    const workspace = await fixture(site, { "nav.json": { siteId: SITE_ID, navItems: treeTargeting(HOME_PAGE_ID) } });
    const wire = api([NAV_PAGES_ROUTE]);
    const { invocation } = invoke(workspace, wire, { verb: "nav push" });
    await assert.rejects(
      navPush(invocation),
      (error) =>
        error?.code === "nav.resource_unknown"
        && error?.field === "navItems[0].children[0]"
        && /is a pageId, not a site resourceId/u.test(error.message),
    );
    assert.equal(wire.matching("PUT", NAVIGATION).length, 0);
  });

  await testContext.test("a tree whose targets all exist still pushes", async (site) => {
    const workspace = await fixture(site, {
      "nav.json": { siteId: SITE_ID, navItems: treeTargeting(resourceIdFor(STORY_PAGE_ID)) },
    });
    const wire = api([
      NAV_PAGES_ROUTE,
      { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
      { method: "PUT", pattern: NAVIGATION, reply: (call) => ({ navItems: call.body.navItems }) },
    ]);
    const { invocation } = invoke(workspace, wire, { verb: "nav push" });
    const result = await navPush(invocation);
    assert.equal(result.navigation.items, 2);
    assert.equal(wire.matching("PUT", NAVIGATION).length, 1);
  });

  // A page list the CLI could not fully enumerate must produce no refusal at
  // all: an incomplete set would reject valid trees, and a false refusal here
  // is worse than the server's vague one.
  await testContext.test("an unenumerable page list skips the check rather than refusing", async (site) => {
    const workspace = await fixture(site, { "nav.json": { siteId: SITE_ID, navItems: treeTargeting(navId(9)) } });
    const wire = api([
      { method: "GET", pattern: PAGES_LIST, reply: { pages: [pageSummary()], nextPageToken: "more" } },
      { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
      { method: "PUT", pattern: NAVIGATION, reply: (call) => ({ navItems: call.body.navItems }) },
    ]);
    const { invocation, progress } = invoke(workspace, wire, { verb: "nav push" });
    await navPush(invocation);
    assert.equal(wire.matching("PUT", NAVIGATION).length, 1);
    assert.ok(progress.some((line) => line.includes("PAGE targets are not checked")));
  });
});

test("nav push refuses a workspace with no navigation file", async (site) => {
  const workspace = await fixture(site);
  const wire = api([]);
  const { invocation } = invoke(workspace, wire, { verb: "nav push" });
  await assert.rejects(
    navPush(invocation),
    (error) => error?.code === "nav.file_missing" && /pull/u.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// redirects pull / redirects push (TR00702)
// ---------------------------------------------------------------------------

/** A pulled workspace's manifest once the redirect baseline exists. */
function redirectsManifest(revision = REDIRECT_REVISION, entries = 0) {
  return manifestFixture([], { redirects: { file: "redirects.json", revision, entries } });
}

function redirectsDocument(entries, revision = REDIRECT_REVISION) {
  return { siteId: SITE_ID, revision, entries };
}

test("redirects pull names a Taproot that serves no redirect map yet", async (site) => {
  // The missing-baseline refusal sends the operator here, so a bare 404 from a
  // site that predates the map must become a refusal that says what to wait for.
  const workspace = await fixture(site, { ".taproot-site-manifest.json": manifestFixture([]) });
  const wire = api([{ method: "GET", pattern: REDIRECT_MAP, reply: () => new Response("", { status: 404 }) }]);

  await assert.rejects(
    redirectsPull(invoke(workspace, wire, { verb: "redirects pull" }).invocation),
    (error) => error?.code === "redirects.not_served",
  );
  assert.equal(await workspaceHas(workspace, "redirects.json"), false);
});

test("redirects pull writes the map and records the revision a push is fenced by", async (site) => {
  const workspace = await fixture(site, { ".taproot-site-manifest.json": redirectsManifest() });
  const wire = api([{
    method: "GET",
    pattern: REDIRECT_MAP,
    reply: {
      siteId: SITE_ID,
      revision: NEXT_REDIRECT_REVISION,
      entries: [
        {
          path: "/faqs.html",
          kind: "SITE_REDIRECT_KIND_REDIRECT",
          target: "/faq",
          status: 301,
          origin: "SITE_REDIRECT_ORIGIN_AUTHORED",
        },
        // Transcoding omits proto default values, so a path-history redirect at
        // the default status arrives with neither field. The CLI must read that
        // as a 301 redirect a rename recorded, not as an unknown entry.
        { path: "/old-home", target: "/" },
        {
          path: "/retired",
          kind: "SITE_REDIRECT_KIND_GONE",
          status: 410,
          origin: "SITE_REDIRECT_ORIGIN_AUTHORED",
        },
      ],
    },
  }]);
  const { invocation } = invoke(workspace, wire, { verb: "redirects pull" });
  const result = await redirectsPull(invocation);

  assert.deepEqual(await readWorkspaceJson(workspace, "redirects.json"), {
    siteId: SITE_ID,
    revision: NEXT_REDIRECT_REVISION,
    entries: [
      { path: "/faqs.html", kind: "redirect", target: "/faq", status: 301, origin: "authored" },
      { path: "/old-home", kind: "redirect", target: "/", status: 301, origin: "path_history" },
      { path: "/retired", kind: "gone", status: 410, origin: "authored" },
    ],
  });
  assert.deepEqual((await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).redirects, {
    file: "redirects.json",
    revision: NEXT_REDIRECT_REVISION,
    entries: 3,
  });
  assert.equal(result.revision, NEXT_REDIRECT_REVISION);
  assert.deepEqual(
    {
      total: result.redirects.total,
      authored: result.redirects.authored,
      pathHistory: result.redirects.pathHistory,
      gone: result.redirects.gone,
    },
    { total: 3, authored: 2, pathHistory: 1, gone: 1 },
  );
});

test("redirects push sends the recorded revision and the normalized whole map", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": redirectsManifest(REDIRECT_REVISION, 1),
    // Deliberately unnormalized on the way in: a missing leading slash, a
    // trailing slash, an omitted kind, and an omitted status all have to reach
    // the wire in exactly one canonical spelling.
    "redirects.json": redirectsDocument([
      { path: "faqs.html/", target: "faq" },
      { path: "/book", kind: "redirect", target: "https://booking.example.test/riverbend", status: 302 },
      { path: "/retired", kind: "gone" },
    ]),
  });
  const wire = api([{
    method: "PUT",
    pattern: REDIRECT_MAP,
    reply: (call) => ({
      siteId: SITE_ID,
      revision: NEXT_REDIRECT_REVISION,
      entries: call.body.entries.map((entry) => ({ ...entry, origin: "SITE_REDIRECT_ORIGIN_AUTHORED" })),
    }),
  }]);
  const { invocation } = invoke(workspace, wire, { verb: "redirects push" });
  const result = await redirectsPush(invocation);

  const saved = wire.matching("PUT", REDIRECT_MAP)[0];
  assert.equal(saved.body.expectedRevision, REDIRECT_REVISION);
  assert.deepEqual(saved.body.entries, [
    {
      path: "/book",
      kind: "SITE_REDIRECT_KIND_REDIRECT",
      target: "https://booking.example.test/riverbend",
      status: 302,
    },
    { path: "/faqs.html", kind: "SITE_REDIRECT_KIND_REDIRECT", target: "/faq", status: 301 },
    { path: "/retired", kind: "SITE_REDIRECT_KIND_GONE", status: 410 },
  ]);
  // The new revision replaces the baseline, so a second push is fenced against
  // the state this one produced rather than the one before it.
  assert.equal(
    (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).redirects.revision,
    NEXT_REDIRECT_REVISION,
  );
  assert.equal(result.revision, NEXT_REDIRECT_REVISION);
  assert.equal(result.redirects.gone, 1);
});

test("redirects push never sends origin, so a pulled path-history entry stays the site's own", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": redirectsManifest(REDIRECT_REVISION, 1),
    "redirects.json": redirectsDocument([
      { path: "/old-home", kind: "redirect", target: "/", status: 301, origin: "path_history" },
    ]),
  });
  const wire = api([{
    method: "PUT",
    pattern: REDIRECT_MAP,
    reply: { siteId: SITE_ID, revision: NEXT_REDIRECT_REVISION, entries: [] },
  }]);
  const { invocation } = invoke(workspace, wire, { verb: "redirects push" });
  await redirectsPush(invocation);

  const saved = wire.matching("PUT", REDIRECT_MAP)[0];
  assert.equal(Object.hasOwn(saved.body.entries[0], "origin"), false);
});

test("redirects push translates a stale-revision refusal into re-pull guidance", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": redirectsManifest(REDIRECT_REVISION, 1),
    "redirects.json": redirectsDocument([{ path: "/faqs.html", target: "/faq" }]),
  });
  const wire = api([{
    method: "PUT",
    pattern: REDIRECT_MAP,
    reply: () => jsonResponse(violation("ExpectedRevision"), 400),
  }]);
  const { invocation } = invoke(workspace, wire, { verb: "redirects push" });

  await assert.rejects(
    redirectsPush(invocation),
    (error) => error?.code === "redirects.concurrent_modification" && error.field === "revision",
  );
  // Nothing local moved: the workspace still names the revision it read, so the
  // re-pull the guidance asks for is the only way forward.
  assert.equal(
    (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).redirects.revision,
    REDIRECT_REVISION,
  );
});

test("redirects push refuses a workspace with no recorded baseline", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([]),
    "redirects.json": redirectsDocument([{ path: "/faqs.html", target: "/faq" }]),
  });
  const wire = api([]);
  const { invocation } = invoke(workspace, wire, { verb: "redirects push" });

  await assert.rejects(
    redirectsPush(invocation),
    (error) => error?.code === "redirects.pull_required",
  );
  assert.equal(wire.matching("PUT", REDIRECT_MAP).length, 0);
});

test("redirects push refuses a malformed map locally and names the entry", async (testContext) => {
  const cases = [
    {
      name: "a chain",
      entries: [{ path: "/a", target: "/b" }, { path: "/b", target: "/c" }],
      code: "redirects.chain",
      field: "entries[0].target",
    },
    {
      name: "a loop",
      entries: [{ path: "/a", target: "/a/" }],
      code: "redirects.loop",
      field: "entries[0].target",
    },
    {
      name: "a duplicate path",
      entries: [{ path: "/a", target: "/x" }, { path: "a/", target: "/y" }],
      code: "redirects.path_duplicate",
      field: "entries[1].path",
    },
    {
      name: "a path carrying a query string",
      entries: [{ path: "/a?utm=1", target: "/x" }],
      code: "redirects.path_invalid",
      field: "entries[0].path",
    },
    {
      // The edge keys a redirect on the pathname, so a query string on the
      // target hides neither a chain nor a loop from it.
      name: "a chain whose target carries a query string",
      entries: [{ path: "/a", target: "/b?x=1" }, { path: "/b", target: "/c" }],
      code: "redirects.chain",
      field: "entries[0].target",
    },
    {
      // The pair the edge would serve forever: each hop's query string used to
      // make the target unresolvable, so neither entry saw the other.
      name: "a two-hop cycle spelled with a query string on each hop",
      entries: [{ path: "/a", target: "/b?x=1" }, { path: "/b", target: "/a?y=2" }],
      code: "redirects.chain",
      field: "entries[0].target",
    },
    {
      name: "an entry targeting itself through a fragment",
      entries: [{ path: "/a", target: "/a#top" }],
      code: "redirects.loop",
      field: "entries[0].target",
    },
    {
      name: "an over-long path you authored",
      entries: [{ path: `/${"a".repeat(REDIRECT_LIMITS.pathBytes)}`, target: "/x" }],
      code: "redirects.path_too_long",
      field: "entries[0].path",
    },
    {
      // C1, which the site's own control-character rule refuses alongside C0
      // and DEL. Missing it here sent the map to the site to be refused there.
      name: "a path carrying a C1 control character",
      entries: [{ path: "/a\u0080b", target: "/x" }],
      code: "redirects.path_invalid",
      field: "entries[0].path",
    },
    {
      name: "a target carrying a C1 control character",
      entries: [{ path: "/a", target: "/x\u009Fy" }],
      code: "redirects.target_invalid",
      field: "entries[0].target",
    },
    {
      name: "a gone entry carrying a target",
      entries: [{ path: "/a", kind: "gone", target: "/x" }],
      code: "redirects.gone_target",
      field: "entries[0].target",
    },
    {
      name: "a status outside the allowed set",
      entries: [{ path: "/a", target: "/x", status: 303 }],
      code: "redirects.status_invalid",
      field: "entries[0].status",
    },
    {
      name: "a credential-bearing absolute target",
      entries: [{ path: "/a", target: "https://user:secret@elsewhere.example.test/" }],
      code: "redirects.target_invalid",
      field: "entries[0].target",
    },
    {
      name: "an unknown entry field",
      entries: [{ path: "/a", target: "/x", permanent: true }],
      code: "redirects.unknown_field",
      field: "entries[0]",
    },
  ];
  for (const scenario of cases) {
    await testContext.test(scenario.name, async (site) => {
      const workspace = await fixture(site, {
        ".taproot-site-manifest.json": redirectsManifest(REDIRECT_REVISION, 1),
        "redirects.json": redirectsDocument(scenario.entries),
      });
      const wire = api([]);
      const { invocation } = invoke(workspace, wire, { verb: "redirects push" });
      await assert.rejects(
        redirectsPush(invocation),
        (error) => error?.code === scenario.code && error.field === scenario.field,
      );
      assert.equal(wire.matching("PUT", REDIRECT_MAP).length, 0);
    });
  }
});

test("redirects push sends a path_history entry over the path bound, because a rename recorded it", async (site) => {
  // A page may sit at a path longer than the map allows a source to be
  // (MaxPagePathLength is larger than the bound), and renaming it records a
  // path_history entry there that 'redirects pull' returns. Refusing it offline
  // would leave the site's own map failing 'validate' and unpushable without
  // dropping a live redirect, so the site decides: it alone knows whether the
  // push introduces that path or carries it back unchanged.
  const overLong = `/${"a".repeat(REDIRECT_LIMITS.pathBytes)}`;
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": redirectsManifest(REDIRECT_REVISION, 1),
    "redirects.json": redirectsDocument([
      { path: overLong, target: "/classes", origin: "path_history" },
    ]),
  });
  const wire = api([{
    method: "PUT",
    pattern: REDIRECT_MAP,
    reply: { siteId: SITE_ID, revision: NEXT_REDIRECT_REVISION, entries: [] },
  }]);
  const { invocation } = invoke(workspace, wire, { verb: "redirects push" });
  await redirectsPush(invocation);

  assert.equal(wire.matching("PUT", REDIRECT_MAP)[0].body.entries[0].path, overLong);
});

test("redirects push carries back a pulled map already over the entry bound", async (site) => {
  // Renames record entries nobody submitted, so a long-lived site can hold more
  // than the bound. Refusing offline on the submitted count alone would leave
  // its own pulled map unpushable without deleting live path history, so the
  // count the last pull recorded scopes the refusal exactly as the stored map
  // scopes it at the site.
  const entries = Array.from({ length: REDIRECT_LIMITS.entries + 1 }, (_ignored, index) => ({
    path: `/legacy-${index}`,
    target: "/faq",
    origin: "path_history",
  }));
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": redirectsManifest(REDIRECT_REVISION, entries.length),
    "redirects.json": redirectsDocument(entries),
  });
  const wire = api([{
    method: "PUT",
    pattern: REDIRECT_MAP,
    reply: { siteId: SITE_ID, revision: NEXT_REDIRECT_REVISION, entries: [] },
  }]);
  const { invocation } = invoke(workspace, wire, { verb: "redirects push" });
  await redirectsPush(invocation);

  assert.equal(wire.matching("PUT", REDIRECT_MAP)[0].body.entries.length, entries.length);
});

test("redirects push reads back a pulled map larger than the navigation tree's bound", async (site) => {
  // The map's own bound is sized from the redirect contract, not borrowed from
  // nav.json: five hundred entries pointing at long absolute targets are well
  // inside every site-side limit and well past a megabyte on disk.
  const entries = Array.from({ length: 500 }, (_ignored, index) => ({
    path: `/legacy-${index}.html`,
    target: `https://legacy.example.test/${"a".repeat(2_000)}?id=${index}`,
    origin: "path_history",
  }));
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": redirectsManifest(REDIRECT_REVISION, entries.length),
    "redirects.json": redirectsDocument(entries),
  });
  assert.ok((await readWorkspaceText(workspace, "redirects.json")).length > 1024 * 1024);
  const wire = api([{
    method: "PUT",
    pattern: REDIRECT_MAP,
    reply: { siteId: SITE_ID, revision: NEXT_REDIRECT_REVISION, entries: [] },
  }]);
  const { invocation } = invoke(workspace, wire, { verb: "redirects push" });
  await redirectsPush(invocation);

  assert.equal(wire.matching("PUT", REDIRECT_MAP)[0].body.entries.length, entries.length);
});

test("redirects pull and push read a map larger than the ordinary response bound", async (site) => {
  // Six hundred entries with long absolute targets are inside every site-side
  // limit and well past a megabyte on the wire; the map has its own budget.
  const wireEntries = Array.from({ length: 600 }, (_ignored, index) => ({
    path: `/legacy-${index}.html`,
    kind: "SITE_REDIRECT_KIND_REDIRECT",
    target: `https://legacy.example.test/${"a".repeat(1_900)}?id=${index}`,
    status: 301,
    origin: "SITE_REDIRECT_ORIGIN_AUTHORED",
  }));
  assert.ok(JSON.stringify(wireEntries).length > 1024 * 1024);
  const workspace = await fixture(site, { ".taproot-site-manifest.json": redirectsManifest() });
  const wire = api([
    { method: "GET", pattern: REDIRECT_MAP, reply: { siteId: SITE_ID, revision: REDIRECT_REVISION, entries: wireEntries } },
    {
      method: "PUT",
      pattern: REDIRECT_MAP,
      reply: { siteId: SITE_ID, revision: NEXT_REDIRECT_REVISION, entries: wireEntries },
    },
  ]);

  const pulled = await redirectsPull(invoke(workspace, wire, { verb: "redirects pull" }).invocation);
  assert.equal(pulled.redirects.total, 600);
  assert.equal((await readWorkspaceJson(workspace, "redirects.json")).entries.length, 600);

  // The reply to a replace is the whole map too, and its revision is what the
  // next push is fenced by: it has to be recorded, not refused as too large.
  await redirectsPush(invoke(workspace, wire, { verb: "redirects push" }).invocation);
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.redirects.revision, NEXT_REDIRECT_REVISION);
});

test("redirects push refuses a map authored past the entry bound", async (site) => {
  // The exemption is scoped to what the last pull recorded; it never lets an
  // authored map grow past the cap.
  const entries = Array.from({ length: REDIRECT_LIMITS.entries + 1 }, (_ignored, index) => ({
    path: `/legacy-${index}`,
    target: "/faq",
  }));
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": redirectsManifest(REDIRECT_REVISION, 1),
    "redirects.json": redirectsDocument(entries),
  });
  const wire = api([]);
  const { invocation } = invoke(workspace, wire, { verb: "redirects push" });

  await assert.rejects(
    redirectsPush(invocation),
    (error) => error?.code === "redirects.too_many_entries" && error.field === "entries",
  );
  assert.equal(wire.matching("PUT", REDIRECT_MAP).length, 0);
});

test("redirects push sends a root entry, because a home page that moved records one", async (site) => {
  // '/' is refused for exactly as long as a live home page occupies it, which
  // only the site can know. Refusing it offline would leave a site whose home
  // page moved with a map it can pull and never push back: the rename records
  // the entry at the root itself.
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": redirectsManifest(REDIRECT_REVISION, 1),
    "redirects.json": redirectsDocument([{ path: "/", target: "/welcome", origin: "path_history" }]),
  });
  const wire = api([{
    method: "PUT",
    pattern: REDIRECT_MAP,
    reply: { siteId: SITE_ID, revision: NEXT_REDIRECT_REVISION, entries: [] },
  }]);
  const { invocation } = invoke(workspace, wire, { verb: "redirects push" });
  await redirectsPush(invocation);

  assert.deepEqual(wire.matching("PUT", REDIRECT_MAP)[0].body.entries, [
    { path: "/", kind: "SITE_REDIRECT_KIND_REDIRECT", target: "/welcome", status: 301 },
  ]);
});

test("narrowing redirects push to Design is refused, because the map is a content path", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": redirectsManifest(REDIRECT_REVISION, 1),
    "redirects.json": redirectsDocument([{ path: "/faqs.html", target: "/faq" }]),
  });
  const wire = api([{
    method: "PUT",
    pattern: REDIRECT_MAP,
    reply: { siteId: SITE_ID, revision: NEXT_REDIRECT_REVISION, entries: [] },
  }]);
  // Design alone, borrowed from `theme push`: one capability short of the
  // permission the map's own gate resolves.
  const { invocation } = invoke(workspace, wire, {
    verb: "redirects push",
    fetch: capabilityGatedFetch("theme push", wire.fetch),
  });

  await assert.rejects(redirectsPush(invocation), (error) => {
    assert.equal(error.refusalKind(), "capability_missing");
    assert.deepEqual(error.capability, {
      permission: "site.pages.edit_any",
      granted: [CAPABILITY_DESIGN],
      required: [CAPABILITY_CONTENT],
    });
    return true;
  });
});

test("pull records the redirect baseline beside the navigation one", async (site) => {
  const workspace = await fixture(site);
  const wire = api([
    { method: "GET", pattern: PAGES_LIST, reply: { pages: [], nextPageToken: "" } },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    {
      method: "GET",
      pattern: REDIRECT_MAP,
      reply: {
        siteId: SITE_ID,
        revision: NEXT_REDIRECT_REVISION,
        entries: [{ path: "/faqs.html", target: "/faq", status: 301 }],
      },
    },
    { method: "GET", pattern: SETTINGS, reply: () => ({}) },
  ]);
  const { invocation } = invoke(workspace, wire, { verb: "pull" });
  const result = await pull(invocation);

  assert.deepEqual((await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).redirects, {
    file: "redirects.json",
    revision: NEXT_REDIRECT_REVISION,
    entries: 1,
  });
  assert.deepEqual(await readWorkspaceJson(workspace, "redirects.json"), {
    siteId: SITE_ID,
    revision: NEXT_REDIRECT_REVISION,
    entries: [{ path: "/faqs.html", kind: "redirect", target: "/faq", status: 301, origin: "path_history" }],
  });
  assert.deepEqual(result.redirects, {
    file: "redirects.json",
    revision: NEXT_REDIRECT_REVISION,
    entries: 1,
  });
});

test("deploy says redirect entries reach an eventually consistent store, and quotes no hold", async (site) => {
  // A spot-check run the second a deploy reports success can still read the
  // previous map, and taking that for "the redirect did not land" is the wrong
  // conclusion in front of a customer waiting to cut DNS over. What the CLI
  // must not do is report a coordinator-side hold: the propagation grace in the
  // routing coordinator defers only the deletion of a superseded Docs pointer
  // namespace, and a standard site's redirect rows are written immediately.
  const workspace = await fixture(site, { ".taproot-site-manifest.json": manifestFixture([]) });
  const wire = api(deployRoutes());
  const { invocation, progress } = invoke(workspace, wire, { verb: "deploy", deployTarget: "staging" });
  const result = await deploy(invocation);

  assert.ok(progress.some((line) => line.includes("eventually consistent")));
  assert.equal(result.redirects?.propagationGraceSeconds, undefined);
});

// ---------------------------------------------------------------------------
// media upload
// ---------------------------------------------------------------------------

test("image normalization preserves long signed delivery URLs for manifest round trips", () => {
  const sourceUrl = `https://cdn.example.test/${"a".repeat(700)}/w/1920.webp`;
  const responsiveUrl = `https://cdn.example.test/${"b".repeat(700)}/w/640.webp`;

  const image = normalizeImage({
    imageId: IMAGE_ID,
    url: sourceUrl,
    responsiveUrls: [{ minWidth: 640, url: responsiveUrl }],
    width: 1920,
    height: 1080,
    processingState: "IMAGE_PROCESSING_STATE_COMPLETE",
  });

  assert.equal(image.url, sourceUrl);
  assert.equal(image.responsiveUrls[0].url, responsiveUrl);
});

function uploadRoutes({ duplicate = false, states = ["IMAGE_PROCESSING_STATE_COMPLETE"] } = {}) {
  let read = 0;
  return [
    {
      method: "POST",
      pattern: REQUEST_UPLOAD,
      reply: (call) => (duplicate
        ? {
          isDuplicate: true,
          image: {
            imageId: IMAGE_ID,
            url: "https://cdn.example.test/hero.webp",
            responsiveUrls: [{ minWidth: 640, url: "https://cdn.example.test/hero-640.webp" }],
            width: 1200,
            height: 800,
            processingState: "IMAGE_PROCESSING_STATE_COMPLETE",
          },
        }
        : {
          presignedUrl: PRESIGNED_URL,
          uploadId: IMAGE_ID,
          isDuplicate: false,
          requiredHeaders: {
            "Content-Type": call.body.contentType,
            "Content-Length": String(call.body.fileSize),
            "x-amz-meta-original-filename": call.body.fileName,
          },
        }),
    },
    { method: "PUT", pattern: PRESIGNED_PUT, reply: () => new Response(null, { status: 200 }) },
    {
      method: "POST",
      pattern: CONFIRM_UPLOAD,
      reply: {
        image: {
          imageId: IMAGE_ID,
          width: 1200,
          height: 800,
          processingState: "IMAGE_PROCESSING_STATE_PENDING",
        },
      },
    },
    {
      method: "GET",
      pattern: SITE_IMAGES,
      reply: () => {
        const state = states[Math.min(read, states.length - 1)];
        read += 1;
        return {
          images: [{
            image: {
              imageId: IMAGE_ID,
              url: "https://cdn.example.test/hero.webp",
              responsiveUrls: [{ minWidth: 640, url: "https://cdn.example.test/hero-640.webp" }],
              width: 1200,
              height: 800,
              uploadedName: "hero.png",
            },
            processingState: state,
          }],
          nextPageToken: "",
          totalImages: 1,
          processingImages: state === "IMAGE_PROCESSING_STATE_COMPLETE" ? 0 : 1,
        };
      },
    },
  ];
}

test("media upload hashes, sniffs, uploads with the signed headers, confirms, and waits", async (site) => {
  const workspace = await fixture(site, { "media/hero.png": png(1200, 800) });
  const wire = api(uploadRoutes({ states: ["IMAGE_PROCESSING_STATE_PENDING", "IMAGE_PROCESSING_STATE_COMPLETE"] }));
  const { invocation, progress } = invoke(workspace, wire, { verb: "media upload" });
  const result = await mediaUpload(invocation);

  const request = wire.matching("POST", REQUEST_UPLOAD)[0];
  assert.match(request.body.contentHash, /^[0-9a-f]{64}$/u);
  assert.equal(request.body.contentType, "image/png");
  assert.equal(request.body.width, 1200);
  assert.equal(request.body.height, 800);
  assert.equal(request.body.fileSize, 33);
  assert.equal(request.body.ownershipScope, "IMAGE_OWNERSHIP_SCOPE_SITE");
  assert.equal(request.body.siteId, SITE_ID);
  assert.equal(request.body.fileName, "hero.png");

  // The signed headers are echoed verbatim and the bearer never travels to the
  // object store.
  const put = wire.matching("PUT", PRESIGNED_PUT)[0];
  assert.equal(put.headers.get("content-type"), "image/png");
  assert.equal(put.headers.get("content-length"), "33");
  assert.equal(put.headers.get("x-amz-meta-original-filename"), "hero.png");
  assert.equal(put.headers.get("authorization"), null);
  assert.equal(put.bytes.byteLength, 33);
  assert.equal(wire.matching("POST", CONFIRM_UPLOAD).length, 1);

  const mediaManifest = await readWorkspaceJson(workspace, ".taproot-site-media.json");
  assert.equal(mediaManifest.mediaManifestVersion, 2);
  assert.equal(mediaManifest.siteId, SITE_ID);
  assert.equal(mediaManifest.media["media/hero.png"].imageId, IMAGE_ID);
  assert.equal(mediaManifest.media["media/hero.png"].width, 1200);
  assert.equal(mediaManifest.media["media/hero.png"].deduplicated, false);
  assert.equal(mediaManifest.media["media/hero.png"].src, "https://cdn.example.test/hero.webp");
  assert.deepEqual(mediaManifest.media["media/hero.png"].urls, [
    { minWidth: 640, url: "https://cdn.example.test/hero-640.webp" },
  ]);
  assert.equal(result.media.total, 1);
  assert.equal(result.media.deduplicated, 0);
  assert.equal(result.media.items[0].processingState, "IMAGE_PROCESSING_STATE_COMPLETE");
  assert.deepEqual(result.media.items[0].media, {
    imageId: IMAGE_ID,
    src: "https://cdn.example.test/hero.webp",
    urls: [{ minWidth: 640, url: "https://cdn.example.test/hero-640.webp" }],
    width: 1200,
    height: 800,
    alt: "",
  });
  assert.ok(progress.some((line) => line.includes("Waiting for 1 image(s)")));
});

test("media upload short-circuits a dedup hit without uploading or confirming", async (site) => {
  const workspace = await fixture(site, { "media/hero.png": png(1200, 800) });
  const wire = api(uploadRoutes({ duplicate: true }));
  const { invocation, progress } = invoke(workspace, wire, { verb: "media upload" });
  const result = await mediaUpload(invocation);

  assert.equal(wire.matching("PUT", PRESIGNED_PUT).length, 0);
  assert.equal(wire.matching("POST", CONFIRM_UPLOAD).length, 0);
  assert.equal(result.media.deduplicated, 1);
  assert.equal(result.media.items[0].deduplicated, true);
  const recorded = await readWorkspaceJson(workspace, ".taproot-site-media.json");
  assert.equal(recorded.media["media/hero.png"].imageId, IMAGE_ID);
  assert.ok(progress.some((line) => line.includes("matched an existing image")));
});

test("media upload refuses a file that is not one of the accepted raster containers", async (site) => {
  const workspace = await fixture(site, {
    "media/hero.png": Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><script/></svg>"),
  });
  const wire = api(uploadRoutes());
  const { invocation } = invoke(workspace, wire, { verb: "media upload" });
  await assert.rejects(
    mediaUpload(invocation),
    (error) => error?.code === "media.unsupported_format" && error?.field === "media/hero.png",
  );
  assert.equal(wire.calls.length, 0);
});

test("media upload bounds the processing wait and keeps the ids it already earned", async (site) => {
  const workspace = await fixture(site, { "media/hero.png": png(10, 10) });
  const wire = api(uploadRoutes({ states: ["IMAGE_PROCESSING_STATE_IN_PROGRESS"] }));
  const { invocation } = invoke(workspace, wire, { verb: "media upload" });
  await assert.rejects(mediaUpload(invocation), (error) => error?.code === "media.processing_timeout");
  // The manifest is written before processing is awaited, so a timeout does not
  // orphan an image that exists.
  const recorded = await readWorkspaceJson(workspace, ".taproot-site-media.json");
  assert.equal(recorded.media["media/hero.png"].imageId, IMAGE_ID);
});

test("media upload surfaces a processing failure as a failure", async (site) => {
  const workspace = await fixture(site, { "media/hero.png": png(10, 10) });
  const wire = api(uploadRoutes({ states: ["IMAGE_PROCESSING_STATE_FAILED"] }));
  const { invocation } = invoke(workspace, wire, { verb: "media upload" });
  await assert.rejects(
    mediaUpload(invocation),
    (error) => error?.code === "media.processing_failed" && error?.field === "media/hero.png",
  );
});

test("media upload holds the processing deadline inside one paginated read", async (site) => {
  const workspace = await fixture(site, { "media/hero.png": png(10, 10) });
  const timing = clock();
  // A library that never stops paginating, and where each page costs a minute of
  // wall clock. The 5-minute budget has to be spent *within* the read: a bound
  // checked only between reads would let this walk its whole 200-request page
  // limit first.
  const wire = api([
    ...uploadRoutes({ duplicate: true }).filter((route) => route.pattern !== SITE_IMAGES),
    {
      method: "GET",
      pattern: SITE_IMAGES,
      reply: () => {
        timing.advance(61_000);
        return {
          images: [{
            image: { imageId: IMAGE_ID, width: 10, height: 10 },
            processingState: "IMAGE_PROCESSING_STATE_PENDING",
          }],
          nextPageToken: "keep-going",
          totalImages: 10_000,
          processingImages: 1,
        };
      },
    },
  ]);
  const { invocation } = invoke(workspace, wire, { verb: "media upload", now: timing.now, sleep: timing.sleep });
  await assert.rejects(mediaUpload(invocation), (error) => error?.code === "media.processing_timeout");
  // Six minute-long pages exhaust the budget. Anything near the 200-request
  // page bound would mean the deadline was not reaching the requests.
  assert.ok(wire.matching("GET", SITE_IMAGES).length <= 6, "the paginated read must stop at the deadline");
});

test("media upload takes files and directories as positional arguments", async (testContext) => {
  const mediaWorkspace = {
    "media/hero.png": png(10, 10),
    "media/gallery/one.png": png(20, 20),
    "media/gallery/two.png": png(30, 30),
    "media/gallery/notes.txt": "not an image\n",
  };

  await testContext.test("a directory expands to the media inside it", async (site) => {
    const workspace = await fixture(site, mediaWorkspace);
    const wire = api(uploadRoutes());
    const { invocation } = invoke(workspace, wire, { verb: "media upload", paths: ["media/gallery"] });
    const result = await mediaUpload(invocation);
    // The directory's media only, and the non-media file inside it is ignored
    // rather than refused.
    assert.deepEqual(result.media.items.map((item) => item.file), ["media/gallery/one.png", "media/gallery/two.png"]);
  });

  await testContext.test("a trailing slash and an overlapping file upload each file once", async (site) => {
    const workspace = await fixture(site, mediaWorkspace);
    const wire = api(uploadRoutes());
    const { invocation } = invoke(workspace, wire, {
      verb: "media upload",
      paths: ["./media/gallery/", "media/gallery/one.png", "media/hero.png"],
    });
    const result = await mediaUpload(invocation);
    assert.deepEqual(
      result.media.items.map((item) => item.file),
      ["media/gallery/one.png", "media/gallery/two.png", "media/hero.png"],
    );
    assert.equal(wire.matching("POST", REQUEST_UPLOAD).length, 3);
  });

  await testContext.test("a positional that is neither a file nor a directory is named", async (site) => {
    const workspace = await fixture(site, mediaWorkspace);
    for (const positional of ["media/missing.png", "media/gallery/nowhere"]) {
      const wire = api(uploadRoutes());
      const { invocation } = invoke(workspace, wire, { verb: "media upload", paths: [positional] });
      await assert.rejects(
        mediaUpload(invocation),
        (error) => error?.code === "media.path_invalid" && error?.field === positional,
      );
      assert.equal(wire.calls.length, 0);
    }
  });

  await testContext.test("a directory holding no media is reported against that directory", async (site) => {
    const workspace = await fixture(site, { "media/notes/readme.txt": "nothing to upload\n" });
    const wire = api(uploadRoutes());
    const { invocation } = invoke(workspace, wire, { verb: "media upload", paths: ["media/notes"] });
    await assert.rejects(
      mediaUpload(invocation),
      (error) => error?.code === "media.none_found" && error?.field === "media/notes",
    );
  });
});

test("media upload accepts conventional retina asset names", async (site) => {
  const workspace = await fixture(site, { "media/logo@2x.png": png(20, 20) });
  const wire = api(uploadRoutes());
  const { invocation } = invoke(workspace, wire, { verb: "media upload" });

  const result = await mediaUpload(invocation);

  assert.equal(result.media.items[0].file, "media/logo@2x.png");
  assert.equal(wire.matching("POST", REQUEST_UPLOAD)[0].body.fileName, "logo@2x.png");
});

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

test("approve stages only the drafts this workspace owns and says it did not deploy", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([
      { pageId: ABOUT_PAGE_ID, path: "about", title: "About", status: "PAGE_STATUS_DRAFT", file: "pages/about.md" },
      {
        pageId: NOT_FOUND_PAGE_ID,
        path: "404",
        title: "Not found",
        status: "PAGE_STATUS_DRAFT",
        hasDraft: true,
        file: "pages/404.pm.json",
        workspaceMode: "read-only",
        readOnlyReason: "system-404",
        workspaceContentHash: `sha256:${"a".repeat(64)}`,
      },
    ]),
  });
  const wire = api([
    {
      method: "GET",
      pattern: PAGES_LIST,
      reply: {
        pages: [
          pageSummary({ pageId: ABOUT_PAGE_ID, path: "about", status: "PAGE_STATUS_DRAFT", hasDraft: true }),
          // A draft an owner is editing in the browser: not in the manifest, so
          // an agent's approve must not sweep it into the next deployment.
          pageSummary({ pageId: STORY_PAGE_ID, path: "story", status: "PAGE_STATUS_DRAFT", hasDraft: true }),
          // Pull records the system 404 for visibility, but its read-only mode
          // keeps an agent's ordinary approve step from staging that draft.
          pageSummary({ pageId: NOT_FOUND_PAGE_ID, path: "404", status: "PAGE_STATUS_DRAFT", hasDraft: true }),
          pageSummary({ pageId: HOME_PAGE_ID, path: "", hasDraft: false }),
        ],
        nextPageToken: "",
      },
    },
    {
      method: "POST",
      pattern: PUBLISH_DRAFTS,
      reply: (call) => ({
        pages: call.body.pageIds.map((pageId) =>
          pageSummary({ pageId, path: "about", status: "PAGE_STATUS_APPROVED", hasDraft: false })
        ),
      }),
    },
  ]);
  const { invocation, progress } = invoke(workspace, wire, { verb: "approve" });
  const result = await approve(invocation);

  assert.deepEqual(wire.matching("POST", PUBLISH_DRAFTS)[0].body, { pageIds: [ABOUT_PAGE_ID] });
  assert.equal(result.approved.total, 1);
  assert.equal(result.stagedNotDeployed, true);
  assert.equal(result.nextStep, "deploy --staging");
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.pages[0].status, "PAGE_STATUS_APPROVED");
  assert.equal(manifest.pages[0].pendingApproval, false);
  assert.ok(progress.some((line) => line.includes("Nothing is published until")));

  await assert.rejects(
    approve(invoke(workspace, wire, { verb: "approve", pagePaths: ["404"] }).invocation),
    (error) => error?.code === "approve.page_read_only" && error?.field === "404",
  );
  assert.equal(wire.matching("POST", PUBLISH_DRAFTS).length, 1);
});

test("approve verifies a marker-shaped projection against the live system 404 identity", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([{
      pageId: ABOUT_PAGE_ID,
      path: "404",
      title: "Not found",
      status: "PAGE_STATUS_DRAFT",
      hasDraft: true,
      templateType: "TEMPLATE_TYPE_FREE_FORM",
      file: "pages/404.pm.json",
      workspaceMode: "read-only",
      readOnlyReason: "system-404",
      workspaceContentHash: `sha256:${"a".repeat(64)}`,
    }]),
  });
  const wire = api([
    {
      method: "GET",
      pattern: PAGES_LIST,
      reply: {
        pages: [pageSummary({ status: "PAGE_STATUS_DRAFT", hasDraft: true })],
        nextPageToken: "",
      },
    },
  ]);

  await assert.rejects(
    approve(invoke(workspace, wire, { verb: "approve" }).invocation),
    (error) => error?.code === "workspace.manifest_invalid"
      && error?.field === "pages[0].pageId",
  );
  assert.equal(wire.matching("POST", PUBLISH_DRAFTS).length, 0);
});

test("approve narrows to the page paths it was given", async (testContext) => {
  const workspaceFiles = {
    ".taproot-site-manifest.json": manifestFixture([
      { pageId: ABOUT_PAGE_ID, path: "about", title: "About", file: "pages/about.md" },
      { pageId: STORY_PAGE_ID, path: "news/story", title: "Story", file: "pages/news/story.md" },
    ]),
  };
  const routes = [
    {
      method: "GET",
      pattern: PAGES_LIST,
      reply: {
        pages: [
          pageSummary({ pageId: ABOUT_PAGE_ID, path: "about", status: "PAGE_STATUS_DRAFT", hasDraft: true }),
          pageSummary({ pageId: STORY_PAGE_ID, path: "news/story", status: "PAGE_STATUS_DRAFT", hasDraft: true }),
        ],
        nextPageToken: "",
      },
    },
    {
      method: "POST",
      pattern: PUBLISH_DRAFTS,
      reply: (call) => ({
        pages: call.body.pageIds.map((pageId) => pageSummary({ pageId, status: "PAGE_STATUS_APPROVED" })),
      }),
    },
  ];

  await testContext.test("a named draft is staged and the others are left alone", async (site) => {
    const workspace = await fixture(site, workspaceFiles);
    const wire = api(routes);
    // Written the way a person types it — a leading slash and a trailing one —
    // because that is the same page path.
    const { invocation } = invoke(workspace, wire, { verb: "approve", pagePaths: ["/news/story/"] });
    const result = await approve(invocation);
    assert.deepEqual(wire.matching("POST", PUBLISH_DRAFTS)[0].body, { pageIds: [STORY_PAGE_ID] });
    assert.equal(result.approved.total, 1);
    const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
    assert.equal(manifest.pages.find((entry) => entry.pageId === STORY_PAGE_ID).status, "PAGE_STATUS_APPROVED");
    assert.equal(manifest.pages.find((entry) => entry.pageId === ABOUT_PAGE_ID).status, undefined);
  });

  await testContext.test("the documented '/' spelling narrows to the homepage draft", async (site) => {
    const workspace = await fixture(site, {
      ".taproot-site-manifest.json": manifestFixture([
        { pageId: ABOUT_PAGE_ID, path: "", title: "Home", file: "pages/index.md" },
        { pageId: STORY_PAGE_ID, path: "news/story", title: "Story", file: "pages/news/story.md" },
      ]),
    });
    const wire = api([
      {
        method: "GET",
        pattern: PAGES_LIST,
        reply: {
          pages: [
            pageSummary({ pageId: ABOUT_PAGE_ID, path: "", status: "PAGE_STATUS_DRAFT", hasDraft: true }),
            pageSummary({ pageId: STORY_PAGE_ID, path: "news/story", status: "PAGE_STATUS_DRAFT", hasDraft: true }),
          ],
          nextPageToken: "",
        },
      },
      routes[1],
    ]);
    const { invocation } = invoke(workspace, wire, { verb: "approve", pagePaths: ["/"] });
    const result = await approve(invocation);
    assert.deepEqual(wire.matching("POST", PUBLISH_DRAFTS)[0].body, { pageIds: [ABOUT_PAGE_ID] });
    assert.equal(result.approved.total, 1);
  });

  await testContext.test("a path with no approvable draft is named rather than ignored", async (site) => {
    const workspace = await fixture(site, workspaceFiles);
    const wire = api(routes);
    const { invocation } = invoke(workspace, wire, { verb: "approve", pagePaths: ["nowhere"] });
    await assert.rejects(
      approve(invocation),
      (error) => error?.code === "approve.page_not_found" && error?.field === "nowhere",
    );
    assert.equal(wire.matching("POST", PUBLISH_DRAFTS).length, 0);
  });

  await testContext.test("the '/' spelling with no homepage draft keeps its field in the contract", async (site) => {
    // The empty normalized root path would be dropped as falsy by the result
    // emitters, so the error names the documented spelling instead.
    const workspace = await fixture(site, workspaceFiles);
    const wire = api(routes);
    const { invocation } = invoke(workspace, wire, { verb: "approve", pagePaths: ["/"] });
    await assert.rejects(
      approve(invocation),
      (error) => error?.code === "approve.page_not_found" && error?.field === "/",
    );
    assert.equal(wire.matching("POST", PUBLISH_DRAFTS).length, 0);
  });

  // A path this CLI cannot use must never be dropped: the selection would
  // narrow — here, to nothing — and the verb would exit 0 reporting the work
  // done, telling an agent that asked to stage a page that it had been staged.
  await testContext.test("an unusable path is refused by name, not silently dropped", async (testContext_) => {
    for (const pagePath of ["a/../b", "a//b", "back\\slash", "x".repeat(513)]) {
      await testContext_.test(JSON.stringify(pagePath.slice(0, 24)), async (site) => {
        const workspace = await fixture(site, workspaceFiles);
        const wire = api(routes);
        const { invocation } = invoke(workspace, wire, { verb: "approve", pagePaths: [pagePath] });
        await assert.rejects(
          approve(invocation),
          (error) =>
            error?.code === "approve.page_path_invalid"
            && error?.field === pagePath
            && error?.exitCode === 2,
        );
        assert.equal(wire.calls.length, 0);
      });
    }
  });
});

test("approve succeeds without calling publish_drafts when nothing carries a draft", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([{ pageId: ABOUT_PAGE_ID, path: "about", title: "About" }]),
  });
  const wire = api([
    { method: "GET", pattern: PAGES_LIST, reply: { pages: [pageSummary({ hasDraft: false })], nextPageToken: "" } },
  ]);
  const { invocation } = invoke(workspace, wire, { verb: "approve" });
  const result = await approve(invocation);
  assert.equal(result.approved.total, 0);
  assert.equal(wire.matching("POST", PUBLISH_DRAFTS).length, 0);
});

// ---------------------------------------------------------------------------
// deploy
// ---------------------------------------------------------------------------

function deploymentRecord(overrides = {}) {
  return {
    id: DEPLOYMENT_ID,
    siteId: SITE_ID,
    environment: "DEPLOYMENT_ENVIRONMENT_STAGING",
    startedAt: "2026-08-20T00:00:00Z",
    pageCount: 1,
    ...overrides,
  };
}

function deployRoutes({
  statuses = ["DEPLOYMENT_STATUS_COMPLETED"],
  deployReply,
  readiness = {},
  stagingProbeResponse,
} = {}) {
  let read = 0;
  return [
    {
      method: "GET",
      pattern: PAGES_LIST,
      reply: {
        pages: [pageSummary({ pageId: ABOUT_PAGE_ID, path: "about", status: "PAGE_STATUS_APPROVED" })],
        nextPageToken: "",
      },
    },
    {
      method: "GET",
      pattern: READINESS,
      reply: {
        state: "PAGE_PUBLISHING_READINESS_STATE_READY",
        approvedPageCount: 1,
        selectedPageCount: 1,
        hasCandidateChanges: true,
        blockers: [],
        ...readiness,
      },
    },
    {
      method: "POST",
      pattern: DEPLOY,
      reply: deployReply ?? ((call) => ({
        deployment: deploymentRecord({ environment: call.body.environment, status: undefined }),
      })),
    },
    {
      method: "GET",
      pattern: DEPLOYMENTS,
      reply: () => {
        const value = statuses[Math.min(read, statuses.length - 1)];
        read += 1;
        return {
          deployments: [deploymentRecord({
            status: value,
            completedAt: value === "DEPLOYMENT_STATUS_COMPLETED" ? "2026-08-20T00:01:00Z" : "",
          })],
          nextPageToken: "",
        };
      },
    },
    {
      method: "GET",
      pattern: STAGING_PREVIEW_STATUS,
      reply: { siteId: SITE_ID, ready: true, stagingUrl: `https://${STAGING_HOST}` },
    },
    {
      method: "GET",
      pattern: STAGING_PREVIEW_ROOT,
      reply: stagingProbeResponse ?? new Response("", {
        status: 302,
        headers: {
          location: `${API_BASE_URL}/v1/staging-preview/handoff?siteId=${SITE_ID}`
            + `&host=${STAGING_HOST}&returnPath=%2F`,
        },
      }),
    },
  ];
}

test("deploy --staging checks readiness, sends the candidate, and polls to completion", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([{ pageId: ABOUT_PAGE_ID, path: "about", title: "About" }]),
  });
  const wire = api(deployRoutes({ statuses: ["DEPLOYMENT_STATUS_GENERATING", "DEPLOYMENT_STATUS_COMPLETED"] }));
  const { invocation, progress } = invoke(workspace, wire, { verb: "deploy", deployTarget: "staging" });
  const result = await deploy(invocation);

  const readiness = wire.matching("GET", READINESS)[0];
  assert.deepEqual(readiness.query.getAll("stagedPageIds"), [ABOUT_PAGE_ID]);
  assert.deepEqual(readiness.query.getAll("selectedSettingsTypes"), ["SETTING_TYPE_SITE_HEADER"]);
  assert.equal(readiness.query.get("includeNavigation"), "true");

  const sent = wire.matching("POST", DEPLOY)[0];
  assert.deepEqual(sent.body, {
    siteId: SITE_ID,
    environment: "DEPLOYMENT_ENVIRONMENT_STAGING",
    stagedPageIds: [ABOUT_PAGE_ID],
    selectedSettingsTypes: ["SETTING_TYPE_SITE_HEADER"],
    includeNavigation: true,
  });
  assert.equal(result.deployment.status, "DEPLOYMENT_STATUS_COMPLETED");
  assert.equal(result.environment, "DEPLOYMENT_ENVIRONMENT_STAGING");
  assert.equal(result.nextStep, "deploy --production");
  assert.deepEqual(result.stagingPreview, {
    url: `https://${STAGING_HOST}/`,
    routeCheck: "resolved",
  });
  assert.ok(progress.some((line) => line.includes("DEPLOYMENT_STATUS_GENERATING")));
  assert.ok(progress.includes(`Staging URL: https://${STAGING_HOST}/`));
  const stagingProbe = wire.matching("GET", STAGING_PREVIEW_ROOT)[0];
  assert.equal(stagingProbe.headers.authorization, undefined);

  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.deployments.staging.id, DEPLOYMENT_ID);
  assert.equal(manifest.deployments.staging.status, "DEPLOYMENT_STATUS_COMPLETED");
});

test("deploy --staging warns without failing when the configured host does not resolve to the site", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([{ pageId: ABOUT_PAGE_ID, path: "about", title: "About" }]),
  });
  const wire = api(deployRoutes({ stagingProbeResponse: new Response("Site not found", { status: 404 }) }));
  const { invocation, progress } = invoke(workspace, wire, { verb: "deploy", deployTarget: "staging" });

  const result = await deploy(invocation);

  assert.equal(result.ok, true);
  assert.equal(result.deployment.status, "DEPLOYMENT_STATUS_COMPLETED");
  assert.equal(result.stagingPreview.url, `https://${STAGING_HOST}/`);
  assert.equal(result.stagingPreview.routeCheck, "unresolved");
  assert.match(result.stagingPreview.warning, /returned HTTP 404/u);
  assert.ok(progress.some((line) => line.startsWith("Warning: ") && line.includes("HTTP 404")));
});

test("deploy --staging refuses an empty candidate before it reaches the API", async (site) => {
  const workspace = await fixture(site);
  const wire = api([
    {
      method: "GET",
      pattern: PAGES_LIST,
      reply: { pages: [pageSummary({ status: "PAGE_STATUS_DRAFT" })], nextPageToken: "" },
    },
  ]);
  const { invocation } = invoke(workspace, wire, { verb: "deploy", deployTarget: "staging" });
  await assert.rejects(
    deploy(invocation),
    (error) =>
      error?.code === "deploy.empty_selection"
      && error?.field === "Candidate"
      && /approve/u.test(error.message),
  );
  assert.equal(wire.matching("POST", DEPLOY).length, 0);
});

test("deploy --staging refuses a candidate Taproot reports media blockers on", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([{ pageId: ABOUT_PAGE_ID, path: "about", title: "About" }]),
  });
  const wire = api(deployRoutes({
    readiness: {
      state: "PAGE_PUBLISHING_READINESS_STATE_FAILED",
      blockers: [{
        imageId: IMAGE_ID,
        uploadedName: "hero.png",
        state: "PAGE_PUBLISHING_READINESS_STATE_FAILED",
        message: "Processing failed.",
      }],
    },
  }));
  const { invocation } = invoke(workspace, wire, { verb: "deploy", deployTarget: "staging" });
  await assert.rejects(
    deploy(invocation),
    (error) => error?.code === "deploy.media_blocked" && /hero\.png/u.test(error.message),
  );
  assert.equal(wire.matching("POST", DEPLOY).length, 0);
});

test("deploy --production promotes a staging deployment and never carries a selection", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([], {
      deployments: { staging: { id: STAGING_DEPLOYMENT_ID, status: "DEPLOYMENT_STATUS_COMPLETED" } },
    }),
  });
  const wire = api(deployRoutes());
  const { invocation } = invoke(workspace, wire, { verb: "deploy", deployTarget: "production" });
  const result = await deploy(invocation);

  const sent = wire.matching("POST", DEPLOY)[0];
  assert.deepEqual(sent.body, {
    siteId: SITE_ID,
    environment: "DEPLOYMENT_ENVIRONMENT_PRODUCTION",
    stagingDeploymentId: STAGING_DEPLOYMENT_ID,
  });
  // Production is a promotion: there is nothing to enumerate and nothing to
  // select, so the page list is never even read.
  assert.equal(wire.matching("GET", PAGES_LIST).length, 0);
  assert.equal(result.promotedStagingDeploymentId, STAGING_DEPLOYMENT_ID);
  assert.equal(result.deployment.status, "DEPLOYMENT_STATUS_COMPLETED");
});

test("deploy --production refuses an explicit selection alongside the promotion", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([], {
      deployments: { staging: { id: STAGING_DEPLOYMENT_ID } },
    }),
  });
  for (
    const selection of [
      { stagedPageIds: [ABOUT_PAGE_ID] },
      { selectedSettingsTypes: ["SETTING_TYPE_SITE_HEADER"] },
      { includeNavigation: true },
    ]
  ) {
    const wire = api(deployRoutes());
    const { invocation } = invoke(workspace, wire, { verb: "deploy", deployTarget: "production", ...selection });
    await assert.rejects(
      deploy(invocation),
      (error) => error?.code === "deploy.production_selection" && error?.exitCode === 2,
    );
    assert.equal(wire.matching("POST", DEPLOY).length, 0);
  }
});

test("deploy --production refuses when there is no completed staging deployment to promote", async (site) => {
  const workspace = await fixture(site);
  const wire = api([{ method: "GET", pattern: DEPLOYMENTS, reply: { deployments: [], nextPageToken: "" } }]);
  const { invocation } = invoke(workspace, wire, { verb: "deploy", deployTarget: "production" });
  await assert.rejects(
    deploy(invocation),
    (error) => error?.code === "deploy.staging_required" && /--staging/u.test(error.message),
  );
});

test("deploy surfaces a plan-limit refusal prominently and keeps it classified", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([{ pageId: ABOUT_PAGE_ID, path: "about", title: "About" }]),
  });
  const wire = api(deployRoutes({
    deployReply: () => jsonResponse(violation("UpgradePrompt", "This plan allows 20 published pages."), 400),
  }));
  const { invocation, progress } = invoke(workspace, wire, { verb: "deploy", deployTarget: "staging" });
  await assert.rejects(
    deploy(invocation),
    (error) =>
      error?.code === "api.request_rejected"
      && error?.field === "UpgradePrompt"
      && error.refusalKind() === "plan_limit",
  );
  const announcement = progress.join("\n");
  assert.match(announcement, /PLAN LIMIT \(refusal=plan_limit, field=UpgradePrompt\)/u);
  assert.match(announcement, /Upgrade the site's plan/u);
  assert.match(announcement, /refused this deploy against a plan ceiling/u);
  assert.match(announcement, /run the deploy again/u);
  // The server's own violation description is surfaced verbatim — it names
  // the remedy, and the CLI must not paraphrase policy it does not own.
  assert.match(announcement, /This plan allows 20 published pages\./u);
  // The CLI never invents the numeric ceiling it was not told.
  assert.doesNotMatch(announcement, /\b\d+ pages? remaining\b/u);
});

test("a plan limit names the operation that was actually refused", async (site) => {
  // `UpgradePrompt` is not deploy's alone — the image-upload handlers raise it
  // too, and telling someone whose upload was rejected to "run the deploy
  // again" sends them to the wrong command entirely.
  const workspace = await fixture(site, { "media/hero.png": png(10, 10) });
  const wire = api([
    {
      method: "POST",
      pattern: REQUEST_UPLOAD,
      reply: () => jsonResponse(violation("UpgradePrompt", "This plan is out of image storage."), 400),
    },
  ]);
  const { invocation, progress } = invoke(workspace, wire, { verb: "media upload" });
  await assert.rejects(
    mediaUpload(invocation),
    (error) => error?.field === "UpgradePrompt" && error.refusalKind() === "plan_limit",
  );
  const announcement = progress.join("\n");
  assert.match(announcement, /refused this upload against a plan ceiling/u);
  assert.match(announcement, /run the upload again/u);
  assert.match(announcement, /This plan is out of image storage\./u);
  assert.doesNotMatch(announcement, /deploy/u);
});

test("deploy bounds the completion poll and the deployment-log observation", async (testContext) => {
  await testContext.test("a deployment that never leaves a pending state", async (site) => {
    const workspace = await fixture(site, {
      ".taproot-site-manifest.json": manifestFixture([{ pageId: ABOUT_PAGE_ID, path: "about", title: "About" }]),
    });
    const wire = api(deployRoutes({ statuses: ["DEPLOYMENT_STATUS_QUEUED"] }));
    const { invocation } = invoke(workspace, wire, { verb: "deploy", deployTarget: "staging" });
    await assert.rejects(deploy(invocation), (error) => error?.code === "deploy.timeout");
  });

  await testContext.test("a deployment the log never lists", async (site) => {
    const workspace = await fixture(site, {
      ".taproot-site-manifest.json": manifestFixture([{ pageId: ABOUT_PAGE_ID, path: "about", title: "About" }]),
    });
    const wire = api([
      ...deployRoutes().filter((route) => route.pattern !== DEPLOYMENTS),
      { method: "GET", pattern: DEPLOYMENTS, reply: { deployments: [], nextPageToken: "" } },
    ]);
    const { invocation } = invoke(workspace, wire, { verb: "deploy", deployTarget: "staging" });
    await assert.rejects(deploy(invocation), (error) => error?.code === "deploy.not_observable");
  });

  await testContext.test("a deployment that fails", async (site) => {
    const workspace = await fixture(site, {
      ".taproot-site-manifest.json": manifestFixture([{ pageId: ABOUT_PAGE_ID, path: "about", title: "About" }]),
    });
    const wire = api(deployRoutes({ statuses: ["DEPLOYMENT_STATUS_FAILED"] }));
    const { invocation } = invoke(workspace, wire, { verb: "deploy", deployTarget: "staging" });
    await assert.rejects(
      deploy(invocation),
      (error) => error?.code === "deploy.failed" && error?.status === "DEPLOYMENT_STATUS_FAILED",
    );
  });
});

// ---------------------------------------------------------------------------
// preview page
// ---------------------------------------------------------------------------

function previewRecord(overrides = {}) {
  return {
    siteId: SITE_ID,
    pageId: ABOUT_PAGE_ID,
    snapshotId: SNAPSHOT_ID,
    status: "AUTHORING_PREVIEW_STATUS_READY",
    capturedAt: PREVIEW_CAPTURED_AT,
    expiresAt: PREVIEW_EXPIRES_AT,
    draftRevision: DRAFT_REVISION,
    failureCode: "",
    stagingHost: STAGING_HOST,
    ...overrides,
  };
}

function previewRoutes({ statuses = ["AUTHORING_PREVIEW_STATUS_READY"], createReply, mintReply } = {}) {
  let read = 0;
  return [
    {
      method: "POST",
      pattern: PREVIEW_CREATE,
      reply: createReply ?? {
        preview: previewRecord({ status: "AUTHORING_PREVIEW_STATUS_QUEUED" }),
        storedPreviewCap: 10,
        storedPreviewCount: 1,
      },
    },
    {
      method: "GET",
      pattern: PREVIEW_STATUS,
      reply: () => previewRecord({ status: statuses[Math.min(read++, statuses.length - 1)] }),
    },
    {
      method: "POST",
      pattern: PREVIEW_MINT,
      reply: mintReply ?? {
        siteId: SITE_ID,
        pageId: ABOUT_PAGE_ID,
        snapshotId: SNAPSHOT_ID,
        url: HANDOFF_URL,
        handoffExpiresAt: HANDOFF_EXPIRES_AT,
        previewExpiresAt: PREVIEW_EXPIRES_AT,
        preview: previewRecord(),
      },
    },
  ];
}

test("preview page creates once, polls status, then mints and returns the stable capability result", async (site) => {
  const workspace = await fixture(site, {
    // An invalid manifest proves the preview handler does not parse workspace
    // content to choose its page or presentation state.
    ".taproot-site-manifest.json": "not json\n",
  });
  const before = await readFile(workspacePath(workspace, ".taproot-site-manifest.json"), "utf8");
  const wire = api(previewRoutes({
    statuses: ["AUTHORING_PREVIEW_STATUS_RENDERING", "AUTHORING_PREVIEW_STATUS_READY"],
  }));
  const { invocation, progress } = invoke(workspace, wire, { verb: "preview page", pageId: ABOUT_PAGE_ID });
  const result = await previewPage(invocation);

  assert.deepEqual(wire.calls.map((call) => call.method), ["POST", "GET", "GET", "POST"]);
  assert.deepEqual(wire.matching("POST", PREVIEW_CREATE)[0].body, {
    siteId: SITE_ID,
    pageId: ABOUT_PAGE_ID,
  });
  assert.deepEqual(wire.matching("POST", PREVIEW_MINT)[0].body, {
    siteId: SITE_ID,
    pageId: ABOUT_PAGE_ID,
    snapshotId: SNAPSHOT_ID,
  });
  assert.deepEqual(result, {
    schemaVersion: 1,
    ok: true,
    cli: { name: "@taprootio/site-authoring", version: "0.5.0" },
    verb: "preview page",
    siteId: SITE_ID,
    pageId: ABOUT_PAGE_ID,
    snapshotId: SNAPSHOT_ID,
    status: "AUTHORING_PREVIEW_STATUS_READY",
    draftRevision: DRAFT_REVISION,
    capturedAt: PREVIEW_CAPTURED_AT,
    stagingHost: STAGING_HOST,
    url: HANDOFF_URL,
    expiresAt: PREVIEW_EXPIRES_AT,
    handoffExpiresAt: HANDOFF_EXPIRES_AT,
    storedPreviewCap: 10,
    storedPreviewCount: 1,
    evictedPreviews: [],
  });
  assert.ok(progress.some((line) => line.includes("AUTHORING_PREVIEW_STATUS_RENDERING")));
  assert.ok(progress.some((line) => line.includes(`pageId=${ABOUT_PAGE_ID}`)));
  assert.ok(progress.some((line) => line.includes(`snapshotId=${SNAPSHOT_ID}`)));
  assert.ok(progress.some((line) => line.includes("storedPreviews=1/10")));
  assert.doesNotMatch(progress.join("\n"), /handoff=/u);
  assert.doesNotMatch(progress.join("\n"), new RegExp(HANDOFF_TOKEN, "u"));
  assert.equal(await readFile(workspacePath(workspace, ".taproot-site-manifest.json"), "utf8"), before);
});

test("preview page reports all same-authority evictions when a lowered cap requires more than its size", async (site) => {
  const workspace = await fixture(site);
  const evicted = [
    {
      pageId: STORY_PAGE_ID,
      snapshotId: STAGING_DEPLOYMENT_ID,
      capturedAt: "2023-11-14T20:00:00.000Z",
    },
    {
      pageId: ABOUT_PAGE_ID,
      snapshotId: DEPLOYMENT_ID,
      capturedAt: "2023-11-14T20:01:00.000Z",
    },
    {
      pageId: STORY_PAGE_ID,
      snapshotId: NEW_PAGE_ID,
      capturedAt: "2023-11-14T20:02:00.000Z",
    },
  ];
  const wire = api(previewRoutes({
    createReply: {
      preview: previewRecord({ status: "AUTHORING_PREVIEW_STATUS_QUEUED" }),
      storedPreviewCap: 2,
      storedPreviewCount: 2,
      evictedPreviews: evicted,
    },
  }));
  const { invocation, progress } = invoke(workspace, wire, {
    verb: "preview page",
    pageId: ABOUT_PAGE_ID,
  });

  const result = await previewPage(invocation);

  assert.equal(result.storedPreviewCap, 2);
  assert.equal(result.storedPreviewCount, 2);
  assert.deepEqual(result.evictedPreviews, evicted);
  assert.ok(progress.some((line) =>
    line.includes(`evicted at the stored-preview cap: pageId=${STORY_PAGE_ID}`)
    && line.includes(`snapshotId=${STAGING_DEPLOYMENT_ID}`)));
  assert.equal(progress.filter((line) => line.includes("evicted at the stored-preview cap:")).length, 3);
});

test("preview page resolves a human page path through the pulled manifest", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([
      { pageId: ABOUT_PAGE_ID, path: "about", title: "About", file: "pages/about.md" },
    ]),
  });
  const wire = api(previewRoutes());
  const { invocation, progress } = invoke(workspace, wire, {
    verb: "preview page",
    pageSelector: "/about/",
  });

  const result = await previewPage(invocation);

  assert.equal(result.pageId, ABOUT_PAGE_ID);
  assert.equal(wire.matching("POST", PREVIEW_CREATE)[0].body.pageId, ABOUT_PAGE_ID);
  assert.ok(progress.some((line) => line.includes("Resolved page path 'about'")));
});

test("preview page resolves the homepage by the documented '/' spelling through the pulled manifest", async (site) => {
  // The manifest records the homepage with an empty path. The route doubles
  // reply for ABOUT_PAGE_ID, so that id plays the root page here; the second
  // entry proves the selector chose the empty-path entry rather than matching
  // loosely.
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([
      { pageId: ABOUT_PAGE_ID, path: "", title: "Home", file: "pages/index.md" },
      { pageId: STORY_PAGE_ID, path: "about", title: "About", file: "pages/about.md" },
    ]),
  });
  const wire = api(previewRoutes());
  const { invocation, progress } = invoke(workspace, wire, {
    verb: "preview page",
    pageSelector: "/",
  });

  const result = await previewPage(invocation);

  assert.equal(result.pageId, ABOUT_PAGE_ID);
  assert.equal(wire.matching("POST", PREVIEW_CREATE)[0].body.pageId, ABOUT_PAGE_ID);
  assert.ok(progress.some((line) => line.includes(`to pageId=${ABOUT_PAGE_ID}`)));
});

test("preview page keeps the stable not-found contract for unknown paths", async (testContext) => {
  const cases = [
    {
      name: "an unknown non-root path",
      pages: [{ pageId: ABOUT_PAGE_ID, path: "about", title: "About", file: "pages/about.md" }],
      pageSelector: "missing",
      field: "missing",
    },
    {
      // The empty normalized path would be dropped as falsy by the result
      // emitters, so the error names the documented spelling instead.
      name: "the '/' spelling when the manifest has no root page",
      pages: [{ pageId: ABOUT_PAGE_ID, path: "about", title: "About", file: "pages/about.md" }],
      pageSelector: "/",
      field: "/",
    },
  ];
  for (const scenario of cases) {
    await testContext.test(scenario.name, async (site) => {
      const workspace = await fixture(site, {
        ".taproot-site-manifest.json": manifestFixture(scenario.pages),
      });
      const wire = api(previewRoutes());
      const { invocation } = invoke(workspace, wire, {
        verb: "preview page",
        pageSelector: scenario.pageSelector,
      });
      await assert.rejects(
        previewPage(invocation),
        (error) => error?.code === "preview.page_not_found" && error?.field === scenario.field,
      );
      assert.equal(wire.calls.length, 0);
    });
  }
});

test("preview page emits the '/' field through the serialized not-found contract", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([
      { pageId: ABOUT_PAGE_ID, path: "about", title: "About", file: "pages/about.md" },
    ]),
  });
  const wire = api(previewRoutes());
  let stdout = "";
  const exitCode = await runCli({
    arguments_: ["preview", "page", "/"],
    environment: { TAPROOT_SITE_KEY: TOKEN, XDG_CONFIG_HOME: site.configHome },
    cwd: workspace.project,
    stdout: { write: (chunk) => {
      stdout += chunk;
    } },
    stderr: { write: () => {} },
    fetch: wire.fetch,
  });

  assert.equal(exitCode, 1);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "preview.page_not_found");
  assert.equal(result.error.field, "/");
  assert.equal(wire.calls.length, 0);
});

test("preview page maps terminal preview states and bounded waiting to stable errors", async (testContext) => {
  const cases = [
    {
      name: "render failed",
      status: "AUTHORING_PREVIEW_STATUS_FAILED",
      failureCode: "preview.render_failed",
      code: "preview.render_failed",
    },
    {
      name: "render lane never claimed",
      status: "AUTHORING_PREVIEW_STATUS_FAILED",
      failureCode: "preview.render_unclaimed",
      code: "preview.render_unclaimed",
    },
    {
      name: "artifact missing",
      status: "AUTHORING_PREVIEW_STATUS_FAILED",
      failureCode: "preview.artifact_missing",
      code: "preview.render_failed",
    },
    {
      name: "expired",
      status: "AUTHORING_PREVIEW_STATUS_EXPIRED",
      failureCode: "preview.expired",
      code: "preview.expired",
    },
    {
      name: "revoked",
      status: "AUTHORING_PREVIEW_STATUS_REVOKED",
      failureCode: "preview.revoked",
      code: "preview.revoked",
    },
  ];
  for (const scenario of cases) {
    await testContext.test(scenario.name, async (site) => {
      const workspace = await fixture(site);
      const routes = previewRoutes();
      routes[1] = {
        method: "GET",
        pattern: PREVIEW_STATUS,
        reply: previewRecord({ status: scenario.status, failureCode: scenario.failureCode }),
      };
      const wire = api(routes);
      const { invocation } = invoke(workspace, wire, { verb: "preview page", pageId: ABOUT_PAGE_ID });
      await assert.rejects(
        previewPage(invocation),
        (error) => error?.code === scenario.code && error?.status === scenario.status,
      );
      assert.equal(wire.matching("POST", PREVIEW_CREATE).length, 1);
      assert.equal(wire.matching("POST", PREVIEW_MINT).length, 0);
    });
  }

  await testContext.test("bounded pending wait", async (site) => {
    const workspace = await fixture(site);
    const wire = api(previewRoutes({ statuses: ["AUTHORING_PREVIEW_STATUS_QUEUED"] }));
    const { invocation, progress } = invoke(
      workspace,
      wire,
      { verb: "preview page", pageId: ABOUT_PAGE_ID },
    );
    await assert.rejects(
      previewPage(invocation),
      (error) => {
        assert.equal(error?.code, "preview.timeout");
        assert.equal(error?.status, "AUTHORING_PREVIEW_STATUS_QUEUED");
        assert.match(error?.message ?? "", /render service has not claimed this job/u);
        assert.deepEqual(error?.previewRecovery, {
          siteId: SITE_ID,
          pageId: ABOUT_PAGE_ID,
          snapshotId: SNAPSHOT_ID,
          expiresAt: PREVIEW_EXPIRES_AT,
        });
        return true;
      },
    );
    assert.ok(progress.some((line) => line.includes(`pageId=${ABOUT_PAGE_ID}`)));
    assert.ok(progress.some((line) => line.includes(`snapshotId=${SNAPSHOT_ID}`)));
    assert.equal(wire.matching("POST", PREVIEW_CREATE).length, 1);
    assert.equal(wire.matching("POST", PREVIEW_MINT).length, 0);
  });

  await testContext.test("plain post-create failure", async (site) => {
    const workspace = await fixture(site);
    const wire = api(previewRoutes({ statuses: ["AUTHORING_PREVIEW_STATUS_QUEUED"] }));
    const { invocation } = invoke(workspace, wire, {
      verb: "preview page",
      pageId: ABOUT_PAGE_ID,
      sleep: async () => {
        throw new Error("the injected scheduler failed");
      },
    });

    await assert.rejects(
      previewPage(invocation),
      (error) => {
        assert.equal(error?.code, "site.failed");
        assert.deepEqual(error?.previewRecovery, {
          siteId: SITE_ID,
          pageId: ABOUT_PAGE_ID,
          snapshotId: SNAPSHOT_ID,
          expiresAt: PREVIEW_EXPIRES_AT,
        });
        return true;
      },
    );
    assert.equal(wire.matching("POST", PREVIEW_CREATE).length, 1);
    assert.equal(wire.matching("POST", PREVIEW_MINT).length, 0);
  });
});

test("preview page maps domain validation fields without erasing credential refusals", async (testContext) => {
  const cases = [
    { field: "AuthoringPreviewDraft", code: "preview.no_draft" },
    { field: "AuthoringPreviewStaging", code: "preview.staging_unavailable" },
    { field: "AuthoringPreviewExpiry", code: "preview.expired" },
    { field: "AuthoringPreviewReadiness", code: "preview.not_ready" },
    { field: "AuthoringPreviewRollout", code: "preview.temporarily_unavailable" },
    { field: "AuthoringPreviewCapacity", code: "preview.site_capacity" },
    { field: "AuthoringPreviewAuthorityCapacity", code: "preview.authority_capacity" },
    { field: "AuthoringPreviewManifest", code: "preview.snapshot_too_large" },
  ];
  for (const scenario of cases) {
    await testContext.test(scenario.field, async (site) => {
      const workspace = await fixture(site);
      const wire = api([{
        method: "POST",
        pattern: PREVIEW_CREATE,
        reply: () => jsonResponse(violation(scenario.field), 400),
      }]);
      const { invocation } = invoke(workspace, wire, { verb: "preview page", pageId: ABOUT_PAGE_ID });
      await assert.rejects(
        previewPage(invocation),
        (error) => {
          assert.equal(error?.code, scenario.code);
          assert.equal(error?.field, scenario.field);
          assert.equal("previewRecovery" in error, false);
          return true;
        },
      );
    });
  }

  await testContext.test("wrong-site or revoked credential remains classified", async (site) => {
    const workspace = await fixture(site);
    const wire = api([{
      method: "POST",
      pattern: PREVIEW_CREATE,
      reply: () => jsonResponse({ code: 16, message: "unauthenticated" }, 401),
    }]);
    const { invocation } = invoke(workspace, wire, { verb: "preview page", pageId: ABOUT_PAGE_ID });
    await assert.rejects(
      previewPage(invocation),
      (error) => error?.code === "api.request_rejected" && error.refusalKind() === "credential_rejected",
    );
  });

  await testContext.test("authority capacity preserves exact revoke guidance", async (site) => {
    const workspace = await fixture(site);
    const revokes = Array.from({ length: 16 }, (_, index) => {
      const snapshotId = `bbbbbbbb-bbbb-4bbb-8bbb-${String(index + 1).padStart(12, "0")}`;
      return `taproot-site preview revoke ${ABOUT_PAGE_ID} ${snapshotId}`;
    });
    const description = `The configured stored-preview cap is zero. Blocking snapshots: ${revokes.join(" | ")}`;
    assert.ok(description.length < 2_000);
    const wire = api([{
      method: "POST",
      pattern: PREVIEW_CREATE,
      reply: () => jsonResponse(
        violation("AuthoringPreviewAuthorityCapacity", description),
        400,
      ),
    }]);
    const { invocation } = invoke(workspace, wire, { verb: "preview page", pageId: ABOUT_PAGE_ID });

    await assert.rejects(
      previewPage(invocation),
      (error) => error?.code === "preview.authority_capacity"
        && error.message === description
        && revokes.every((revoke) => error.message.includes(revoke)),
    );
  });

  await testContext.test("site capacity preserves render-lane guidance", async (site) => {
    const workspace = await fixture(site);
    const description = "This site already has the maximum number of queued or rendering authoring previews.";
    const wire = api([{
      method: "POST",
      pattern: PREVIEW_CREATE,
      reply: () => jsonResponse(
        violation("AuthoringPreviewCapacity", description),
        400,
      ),
    }]);
    const { invocation } = invoke(workspace, wire, { verb: "preview page", pageId: ABOUT_PAGE_ID });

    await assert.rejects(
      previewPage(invocation),
      (error) => error?.code === "preview.site_capacity" && error.message === description,
    );
  });
});

test("preview page accepts a valid server handoff when the client clock is five minutes behind", async (site) => {
  const workspace = await fixture(site);
  const wire = api(previewRoutes());
  const { invocation } = invoke(workspace, wire, {
    verb: "preview page",
    pageId: ABOUT_PAGE_ID,
    now: () => 1_699_999_700_000,
  });

  const result = await previewPage(invocation);

  assert.equal(result.url, HANDOFF_URL);
  assert.equal(result.handoffExpiresAt, HANDOFF_EXPIRES_AT);
});

test("preview page accepts a valid server handoff when the client clock is five minutes ahead", async (site) => {
  const workspace = await fixture(site);
  const wire = api(previewRoutes());
  const { invocation } = invoke(workspace, wire, {
    verb: "preview page",
    pageId: ABOUT_PAGE_ID,
    now: () => 1_700_000_300_000,
  });

  const result = await previewPage(invocation);

  assert.equal(result.url, HANDOFF_URL);
  assert.equal(result.handoffExpiresAt, HANDOFF_EXPIRES_AT);
});

test("preview revoke frees an active snapshot without reading workspace content", async (site) => {
  const workspace = await fixture(site, { ".taproot-site-manifest.json": "not json\n" });
  const wire = api([{
    method: "DELETE",
    pattern: PREVIEW_STATUS,
    reply: previewRecord({ status: "AUTHORING_PREVIEW_STATUS_REVOKED", failureCode: "preview.revoked" }),
  }]);
  const { invocation, progress } = invoke(workspace, wire, {
    verb: "preview revoke",
    previewIds: [ABOUT_PAGE_ID, SNAPSHOT_ID],
  });

  const result = await previewRevoke(invocation);

  const revokeRequests = wire.matching("DELETE", PREVIEW_STATUS);
  assert.equal(revokeRequests.length, 1);
  assert.equal(
    revokeRequests[0].pathname,
    `/api/v1/sites/${SITE_ID}/authoring-previews/pages/${ABOUT_PAGE_ID}/${SNAPSHOT_ID}`,
  );
  assert.deepEqual(result, {
    schemaVersion: 1,
    ok: true,
    cli: { name: "@taprootio/site-authoring", version: "0.5.0" },
    verb: "preview revoke",
    siteId: SITE_ID,
    pageId: ABOUT_PAGE_ID,
    snapshotId: SNAPSHOT_ID,
    status: "AUTHORING_PREVIEW_STATUS_REVOKED",
    expiresAt: PREVIEW_EXPIRES_AT,
  });
  assert.ok(progress.some((line) => line.includes("scheduling its artifacts for cleanup")));
});

test("preview revoke validates programmatic identities before configuration or network access", async () => {
  for (const scenario of [
    { previewIds: ["NOT-A-UUID", SNAPSHOT_ID], field: "pageId" },
    { previewIds: [ABOUT_PAGE_ID, "NOT-A-UUID"], field: "snapshotId" },
  ]) {
    await assert.rejects(
      previewRevoke({
        previewIds: scenario.previewIds,
        cwd: "/path/that/must/not-be-read",
        environment: {},
        fetch: () => {
          throw new Error("network must not be reached");
        },
      }),
      (error) => error?.code === "preview.identity_invalid" && error?.field === scenario.field,
    );
  }
});

test("preview revoke refuses a non-revoked server response", async (site) => {
  const workspace = await fixture(site);
  const wire = api([{
    method: "DELETE",
    pattern: PREVIEW_STATUS,
    reply: previewRecord({ status: "AUTHORING_PREVIEW_STATUS_READY" }),
  }]);
  const { invocation } = invoke(workspace, wire, {
    verb: "preview revoke",
    previewIds: [ABOUT_PAGE_ID, SNAPSHOT_ID],
  });

  await assert.rejects(
    previewRevoke(invocation),
    (error) => error?.code === "preview.status_contract" && error?.field === "status",
  );
});

test("preview page rejects identity, status, and handoff contract drift before releasing a URL", async (testContext) => {
  const statusCases = [
    { name: "changed snapshot", mutate: (value) => ({ ...value, snapshotId: STAGING_DEPLOYMENT_ID }) },
    { name: "changed staging host", mutate: (value) => ({ ...value, stagingHost: "other.taproot.test" }) },
    { name: "unspecified status", mutate: ({ status: _status, ...value }) => value },
    { name: "noncanonical revision", mutate: (value) => ({ ...value, draftRevision: `sha256:${"A".repeat(64)}` }) },
    {
      name: "overlong preview lifetime",
      mutate: (value) => ({ ...value, expiresAt: "2023-11-15T00:13:20.000Z" }),
    },
    {
      name: "failure on ready response",
      mutate: (value) => ({ ...value, failureCode: "preview.render_failed" }),
    },
  ];
  for (const scenario of statusCases) {
    await testContext.test(`status / ${scenario.name}`, async (site) => {
      const workspace = await fixture(site);
      const routes = previewRoutes();
      routes[1] = { method: "GET", pattern: PREVIEW_STATUS, reply: scenario.mutate(previewRecord()) };
      const wire = api(routes);
      const { invocation } = invoke(workspace, wire, { verb: "preview page", pageId: ABOUT_PAGE_ID });
      await assert.rejects(previewPage(invocation), (error) => error?.code === "preview.status_contract");
      assert.equal(wire.matching("POST", PREVIEW_MINT).length, 0);
    });
  }

  const handoffCases = [
    {
      name: "wrong host",
      mutate: (value) => ({ ...value, url: value.url.replace(STAGING_HOST, "other.taproot.test") }),
    },
    { name: "extra query", mutate: (value) => ({ ...value, url: `${value.url}&extra=1` }) },
    {
      name: "noncanonical token",
      mutate: (value) => ({ ...value, url: value.url.replace(HANDOFF_TOKEN, "B".repeat(43)) }),
    },
    {
      name: "handoff beyond preview",
      mutate: (value) => ({ ...value, handoffExpiresAt: "2023-11-15T00:13:20.000Z" }),
    },
    {
      name: "handoff beyond client skew allowance",
      mutate: (value) => ({ ...value, handoffExpiresAt: "2023-11-14T22:20:21.000Z" }),
    },
    {
      name: "nested preview mismatch",
      mutate: (value) => ({ ...value, preview: previewRecord({ draftRevision: `sha256:${"b".repeat(64)}` }) }),
    },
  ];
  for (const scenario of handoffCases) {
    await testContext.test(`handoff / ${scenario.name}`, async (site) => {
      const workspace = await fixture(site);
      const original = previewRoutes()[2].reply;
      const wire = api(previewRoutes({ mintReply: scenario.mutate(structuredClone(original)) }));
      const { invocation, progress } = invoke(workspace, wire, { verb: "preview page", pageId: ABOUT_PAGE_ID });
      await assert.rejects(
        previewPage(invocation),
        (error) => error?.code === "preview.handoff_contract" && !error.message.includes(HANDOFF_TOKEN),
      );
      assert.doesNotMatch(progress.join("\n"), /handoff=/u);
    });
  }
});

test("preview page validates a programmatic page ID before config or network access", async () => {
  await assert.rejects(
    previewPage({
      pageId: "NOT-A-UUID",
      cwd: "/path/that/must/not/be-read",
      environment: {},
      fetch: () => {
        throw new Error("network must not be reached");
      },
    }),
    (error) =>
      error?.code === "preview.page_id_invalid"
      && error?.field === "pageId"
      && error?.exitCode === 2,
  );
});

test("preview page reports uppercase UUID selectors as casing errors before reading the manifest", async () => {
  await assert.rejects(
    previewPage({
      pageSelector: SITE_ID.toUpperCase(),
      cwd: "/path/that/must/not-be-read",
      environment: {},
      fetch: () => {
        throw new Error("network must not be reached");
      },
    }),
    (error) =>
      error?.code === "preview.page_selector_invalid"
      && error?.field === "pageSelector"
      && error?.exitCode === 2
      && /lowercase/u.test(error.message),
  );
});

test("preview page reports non-string programmatic selectors as typed usage errors", async (site) => {
  const workspace = await fixture(site);
  const wire = api([]);
  const { invocation } = invoke(workspace, wire, {
    pageSelector: 42,
    pageId: ABOUT_PAGE_ID,
    verb: "preview page",
  });

  await assert.rejects(
    previewPage(invocation),
    (error) =>
      error?.code === "preview.page_selector_invalid"
      && error?.field === "pageSelector"
      && error?.exitCode === 2,
  );
  assert.equal(wire.calls.length, 0);
});

test("a rejected preview handoff never leaks its bearer through failure or progress output", async (site) => {
  const workspace = await fixture(site);
  const outputPath = path.join(workspace.root, "preview-github-output");
  await writeFile(outputPath, "");
  const rawToken = "C".repeat(43);
  const rawUrl = `https://other.taproot.test/_taproot/preview/pages/${ABOUT_PAGE_ID}/${SNAPSHOT_ID}`
    + `?handoff=${rawToken}`;
  const mintReply = structuredClone(previewRoutes()[2].reply);
  mintReply.url = rawUrl;
  const wire = api(previewRoutes({ mintReply }));
  const timing = clock();
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli({
    arguments_: ["--config", workspace.configPath, "preview", "page", ABOUT_PAGE_ID, "--json"],
    environment: { TAPROOT_SITE_KEY: TOKEN, GITHUB_OUTPUT: outputPath },
    cwd: workspace.project,
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
    handlers: {
      ...VERB_HANDLERS,
      "preview page": (invocation) => previewPage({
        ...invocation,
        sleep: timing.sleep,
        now: timing.now,
        timeoutSignal: () => new AbortController().signal,
      }),
    },
    fetch: wire.fetch,
  });

  assert.equal(exitCode, 1);
  assert.equal(JSON.parse(stdout).error.code, "preview.handoff_contract");
  const emitted = `${stdout}${stderr}${await readFile(outputPath, "utf8")}`;
  assert.doesNotMatch(emitted, new RegExp(rawToken, "u"));
  assert.doesNotMatch(emitted, /handoff=/u);
  assert.doesNotMatch(emitted, new RegExp(TOKEN, "u"));
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

test("status reports deployments, readiness, and image processing — and names what it cannot cover", async (site) => {
  const workspace = await fixture(site);
  const wire = api([
    {
      method: "GET",
      pattern: READINESS,
      reply: {
        state: "PAGE_PUBLISHING_READINESS_STATE_WAITING",
        approvedPageCount: 3,
        blockedPageCount: 1,
        hasSuccessfulStagingDeployment: true,
        blockers: [{
          imageId: IMAGE_ID,
          uploadedName: "hero.png",
          state: "PAGE_PUBLISHING_READINESS_STATE_WAITING",
          message: "Still processing.",
        }],
      },
    },
    {
      method: "GET",
      pattern: DEPLOYMENTS,
      // proto3 omits the zero-valued enum, so this listing has one queued
      // deployment and one completed one.
      reply: {
        deployments: [
          deploymentRecord({ status: undefined }),
          deploymentRecord({ id: STAGING_DEPLOYMENT_ID, status: "DEPLOYMENT_STATUS_COMPLETED" }),
        ],
        nextPageToken: "",
      },
    },
    {
      method: "GET",
      pattern: SITE_IMAGES,
      reply: {
        images: [
          {
            image: { imageId: IMAGE_ID, uploadedName: "hero.png" },
            processingState: "IMAGE_PROCESSING_STATE_COMPLETE",
          },
          {
            image: { imageId: STORY_PAGE_ID, uploadedName: "broken.png" },
            processingState: "IMAGE_PROCESSING_STATE_FAILED",
            processingFailureReason: "decode failed",
          },
        ],
        nextPageToken: "",
        totalImages: 2,
        processingImages: 0,
      },
    },
  ]);
  const { invocation, progress } = invoke(workspace, wire, { verb: "status" });
  const result = await status(invocation);

  assert.equal(result.readiness.state, "PAGE_PUBLISHING_READINESS_STATE_WAITING");
  assert.equal(result.readiness.blockers.length, 1);
  assert.equal(result.deployments.items[0].status, "DEPLOYMENT_STATUS_QUEUED");
  assert.equal(result.deployments.items[1].status, "DEPLOYMENT_STATUS_COMPLETED");
  assert.equal(result.images.total, 2);
  assert.equal(result.images.failed, 1);
  assert.equal(result.images.failedItems[0].reason, "decode failed");
  // Broken references are session-only on the shipped contract; the verb says so
  // rather than reporting a clean site.
  assert.equal(result.brokenReferences.covered, false);
  assert.match(result.brokenReferences.reason, /session-only/u);
  assert.ok(progress.some((line) => /Broken references are not reported/u.test(line)));
});

test("status says when the deployment log it read is only one page", async (site) => {
  const workspace = await fixture(site);
  const wire = api([
    { method: "GET", pattern: READINESS, reply: { state: "PAGE_PUBLISHING_READINESS_STATE_READY", blockers: [] } },
    {
      method: "GET",
      pattern: DEPLOYMENTS,
      reply: { deployments: [deploymentRecord({ status: "DEPLOYMENT_STATUS_COMPLETED" })], nextPageToken: "more" },
    },
    { method: "GET", pattern: SITE_IMAGES, reply: { images: [], nextPageToken: "", totalImages: 0 } },
  ]);
  const { invocation } = invoke(workspace, wire, { verb: "status" });
  const result = await status(invocation);
  // `total` is what this read returned, not the site's deployment history — the
  // log is unbounded and only its recent end is read.
  assert.equal(result.deployments.total, 1);
  assert.equal(result.deployments.listTruncated, true);
});

// ---------------------------------------------------------------------------
// Cross-cutting
// ---------------------------------------------------------------------------

const OTHER_SITE_ID = "bbbb2222-cccc-4222-8222-dddd22222222";

// A workspace is just a directory of files; nothing about it says which site it
// came from except the site each manifest records. Repoint the configuration or
// the key at a second site and every page id, resource id, and image id still
// reads as perfectly valid — so `pages push` would plan one site's content onto
// another, and the stale image ids would only fail once phase two was already
// writing pages.
test("a workspace refuses to serve a site it was not pulled from", async (testContext) => {
  const pagesManifest = (siteId) => ({
    ...manifestFixture([{ pageId: ABOUT_PAGE_ID, path: "about", title: "About", file: "pages/about.md" }]),
    siteId,
  });
  const mediaManifest = (siteId) => ({
    mediaManifestVersion: 2,
    ...(siteId === undefined ? {} : { siteId }),
    media: { "media/hero.png": { imageId: IMAGE_ID, width: 10, height: 10 } },
  });
  const foreignPages = pagesManifest(OTHER_SITE_ID);
  const unboundPages = { ...pagesManifest(SITE_ID), siteId: undefined };

  const cases = [
    {
      name: "pages push / another site's manifest",
      files: {
        ".taproot-site-manifest.json": foreignPages,
        "pages/about.md": "---\ntitle: A\npath: about\n---\n\nHi.\n",
      },
      extra: () => ({ verb: "pages push", content: contentStub().module }),
      run: pagesPush,
    },
    {
      // A manifest predating the binding cannot be proved to belong to this
      // site, so it is treated exactly like one that names another.
      name: "pages push / a manifest that records no site",
      files: { ".taproot-site-manifest.json": unboundPages },
      extra: () => ({ verb: "pages push", content: contentStub().module }),
      run: pagesPush,
    },
    {
      name: "pages push / another site's media manifest",
      files: {
        ".taproot-site-manifest.json": pagesManifest(SITE_ID),
        ".taproot-site-media.json": mediaManifest(OTHER_SITE_ID),
      },
      extra: () => ({ verb: "pages push", content: contentStub().module }),
      run: pagesPush,
    },
    {
      name: "approve / another site's manifest",
      files: { ".taproot-site-manifest.json": foreignPages },
      extra: () => ({ verb: "approve" }),
      run: approve,
    },
    {
      name: "deploy / another site's manifest",
      files: { ".taproot-site-manifest.json": foreignPages },
      extra: () => ({ verb: "deploy", deployTarget: "staging" }),
      run: deploy,
    },
    {
      name: "media upload / another site's media manifest",
      files: { ".taproot-site-media.json": mediaManifest(OTHER_SITE_ID), "media/hero.png": png(10, 10) },
      extra: () => ({ verb: "media upload" }),
      run: mediaUpload,
    },
    {
      name: "media upload / a media manifest that records no site",
      files: { ".taproot-site-media.json": mediaManifest(undefined), "media/hero.png": png(10, 10) },
      extra: () => ({ verb: "media upload" }),
      run: mediaUpload,
    },
  ];
  for (const scenario of cases) {
    await testContext.test(scenario.name, async (site) => {
      const workspace = await fixture(site, scenario.files);
      const wire = api([]);
      const { invocation } = invoke(workspace, wire, scenario.extra());
      await assert.rejects(
        scenario.run(invocation),
        (error) =>
          error?.code === "workspace.manifest_site_mismatch"
          && /workspace of its own/u.test(error.message),
      );
      // Checked before anything is planned and before the first request.
      assert.equal(wire.calls.length, 0);
    });
  }

  await testContext.test("a matching site proceeds", async (site) => {
    const workspace = await fixture(site, {
      ".taproot-site-manifest.json": pagesManifest(SITE_ID),
      ".taproot-site-media.json": mediaManifest(SITE_ID),
      "pages/about.md": "---\ntitle: About\npath: about\n---\n\nHi.\n",
    });
    const wire = api(pushRoutes({ live: [pageSummary({ pageId: ABOUT_PAGE_ID, path: "about" })] }));
    const { invocation } = invoke(workspace, wire, { verb: "pages push", content: contentStub().module });
    const result = await pagesPush(invocation);
    assert.equal(result.pages.updated, 1);
  });

  await testContext.test("pull refuses to repoint a workspace at another site", async (site) => {
    const workspace = await fixture(site, { ".taproot-site-manifest.json": pagesManifest(OTHER_SITE_ID) });
    const wire = api([]);
    const { invocation } = invoke(workspace, wire, { verb: "pull" });
    // `pull` overwrites the manifest but not the page files beside it, so the
    // old site's documents would survive untracked and the next push would
    // create them all over again on the new site.
    await assert.rejects(
      pull(invocation),
      (error) => error?.code === "workspace.manifest_site_mismatch",
    );
    assert.equal(wire.calls.length, 0);
  });

  // The dangerous half of the same transplant, and the quieter one. A manifest
  // predating site binding names no site, so `pull` cannot tell whose files sit
  // beside it — and rewriting it would produce a manifest that agrees with
  // itself while the previous site's pages survive untracked, which the next
  // `pages push` would create as new pages here.
  await testContext.test("pull refuses a workspace whose manifest predates site binding", async (site) => {
    const beforeBinding = { manifestVersion: 1, pulledAt: "2026-08-20T00:00:00.000Z", pages: [] };
    const workspace = await fixture(site, {
      ".taproot-site-manifest.json": beforeBinding,
      "pages/carried-over.pm.json": paragraphDocument("a page from whichever site this was"),
    });
    const wire = api([]);
    const { invocation } = invoke(workspace, wire, { verb: "pull" });
    await assert.rejects(
      pull(invocation),
      (error) =>
        error?.code === "workspace.manifest_site_mismatch"
        && /predates site binding/u.test(error.message)
        && /fresh directory/u.test(error.message)
        && error?.field === ".taproot-site-manifest.json",
    );
    assert.equal(wire.calls.length, 0);
    // The refusal must leave the workspace exactly as it found it: a rewritten
    // manifest is the transplant, not a side effect of it.
    assert.deepEqual(await readWorkspaceJson(workspace, ".taproot-site-manifest.json"), beforeBinding);
  });

  // A damaged manifest is not exotic and it is not evidence of a fresh
  // workspace. It may predate the atomic writer, come from an external tool, or
  // be manually damaged while every page source survives intact — the
  // transplant with an accident for a cause rather than a repoint.
  await testContext.test("pull refuses a manifest too damaged to establish a site", async (site) => {
    const truncated = "{\"manifestVersion\": 1, \"siteId\": \"aaaa1111-bbbb-4111-8111-cc";
    const workspace = await fixture(site, {
      ".taproot-site-manifest.json": truncated,
      "pages/carried-over.pm.json": paragraphDocument("a page from whichever site this was"),
    });
    const wire = api([]);
    const { invocation } = invoke(workspace, wire, { verb: "pull" });
    await assert.rejects(
      pull(invocation),
      (error) =>
        error?.code === "workspace.manifest_site_mismatch"
        && /cannot be read/u.test(error.message)
        && /fresh directory/u.test(error.message),
    );
    assert.equal(wire.calls.length, 0);
    assert.equal(await readWorkspaceText(workspace, ".taproot-site-manifest.json"), truncated);
  });

  // `pull` writes page bodies first and the manifest last, so an interrupted
  // first pull leaves a full pages/ directory and nothing saying whose it is.
  // Page sources carry no per-file binding, so nothing here can clear them.
  await testContext.test("pull refuses page sources left behind with no manifest", async (testContext_) => {
    for (
      const [name, contents] of [
        ["pages/carried-over.pm.json", paragraphDocument("body from whichever site this was")],
        ["pages/carried-over.md", "---\ntitle: Carried over\npath: carried-over\n---\n\nHi.\n"],
      ]
    ) {
      await testContext_.test(name, async (site) => {
        const workspace = await fixture(site, { [name]: contents });
        const wire = api([]);
        const { invocation } = invoke(workspace, wire, { verb: "pull" });
        await assert.rejects(
          pull(invocation),
          (error) =>
            error?.code === "workspace.manifest_site_mismatch"
            && /page source/u.test(error.message)
            && /fresh directory/u.test(error.message),
        );
        assert.equal(wire.calls.length, 0);
      });
    }
  });

  // The flow this clause exists to protect: `media upload` is legitimate in a
  // workspace nobody has pulled into, so a media manifest bound to *this* site
  // with no page sources is a workspace this site already owns.
  await testContext.test("pull proceeds when a media manifest already binds the workspace here", async (site) => {
    const workspace = await fixture(site, { ".taproot-site-media.json": mediaManifest(SITE_ID) });
    const wire = api([
      { method: "GET", pattern: PAGES_LIST, reply: { pages: [], nextPageToken: "" } },
      { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
      { method: "GET", pattern: SETTINGS, reply: {} },
    ]);
    const { invocation } = invoke(workspace, wire, { verb: "pull" });
    assert.equal((await pull(invocation)).ok, true);
    assert.equal((await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).siteId, SITE_ID);
  });

  await testContext.test("pull refuses when a site-bound artifact names another site", async (testContext_) => {
    for (
      const [name, contents] of [
        [".taproot-site-media.json", mediaManifest(OTHER_SITE_ID)],
        ["nav.json", { siteId: OTHER_SITE_ID, navItems: [] }],
      ]
    ) {
      await testContext_.test(name, async (site) => {
        const workspace = await fixture(site, { [name]: contents });
        const wire = api([]);
        const { invocation } = invoke(workspace, wire, { verb: "pull" });
        await assert.rejects(
          pull(invocation),
          (error) => error?.code === "workspace.manifest_site_mismatch" && error?.field === name,
        );
        assert.equal(wire.calls.length, 0);
      });
    }
  });

  // The other arm of the same loop: an artifact that exists but cannot clear
  // itself. "Belongs to another site" and "cannot say which site" are the same
  // conclusion here — this workspace is not provably ours — and neither may be
  // read as a fresh directory just because the pull manifest is missing.
  await testContext.test("pull refuses an artifact that records no readable site", async (testContext_) => {
    const cases = [
      {
        name: "a media manifest truncated mid-write",
        file: ".taproot-site-media.json",
        contents: "{\"mediaManifestVersion\": 2, \"siteId\": \"aaaa1111-bbbb-4111-8111-cc",
      },
      {
        // A legacy bare array: no wrapper, so no siteId to read.
        name: "a bare-array nav.json",
        file: "nav.json",
        contents: [{ id: navId(1), kind: "NAV_ITEM_KIND_GROUP_HEADER", title: "Company" }],
      },
      {
        name: "a media manifest recording no site",
        file: ".taproot-site-media.json",
        contents: { mediaManifestVersion: 2, media: {} },
      },
    ];
    for (const scenario of cases) {
      await testContext_.test(scenario.name, async (site) => {
        const workspace = await fixture(site, { [scenario.file]: scenario.contents });
        const before = await readWorkspaceText(workspace, scenario.file);
        const wire = api([]);
        const { invocation } = invoke(workspace, wire, { verb: "pull" });
        await assert.rejects(
          pull(invocation),
          (error) =>
            error?.code === "workspace.manifest_site_mismatch"
            && error?.field === scenario.file
            && /does not record a readable site/u.test(error.message)
            && /fresh directory/u.test(error.message),
        );
        assert.equal(wire.calls.length, 0);
        // Nothing rewritten: neither the artifact nor a freshly minted manifest.
        assert.equal(await readWorkspaceText(workspace, scenario.file), before);
        assert.equal(await workspaceHas(workspace, ".taproot-site-manifest.json"), false);
      });
    }
  });

  await testContext.test("pull into an empty workspace still runs", async (site) => {
    const workspace = await fixture(site);
    const wire = api([
      { method: "GET", pattern: PAGES_LIST, reply: { pages: [], nextPageToken: "" } },
      { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
      { method: "GET", pattern: SETTINGS, reply: {} },
    ]);
    const { invocation } = invoke(workspace, wire, { verb: "pull" });
    assert.equal((await pull(invocation)).ok, true);
    assert.equal((await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).siteId, SITE_ID);
  });

  await testContext.test("pull into a fresh or same-site workspace still runs", async (site) => {
    const workspace = await fixture(site, { ".taproot-site-manifest.json": pagesManifest(SITE_ID) });
    const wire = api([
      { method: "GET", pattern: PAGES_LIST, reply: { pages: [], nextPageToken: "" } },
      { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
      { method: "GET", pattern: SETTINGS, reply: {} },
    ]);
    const { invocation } = invoke(workspace, wire, { verb: "pull" });
    assert.equal((await pull(invocation)).ok, true);
  });
});

test("nav push requires the navigation file it pulled, bound to this site", async (testContext) => {
  // `nav push` replaces a whole tree in one unversioned write, so a stale
  // `nav.json` is not a partial mistake — it is another site's entire
  // navigation landing on this one.
  const cases = [
    {
      name: "a bare array carries no site at all",
      contents: NAV_TREE,
      code: "nav.file_invalid",
    },
    {
      name: "a wrapper naming another site",
      contents: { siteId: OTHER_SITE_ID, navItems: NAV_TREE },
      code: "nav.file_site_mismatch",
    },
    {
      name: "a wrapper naming no site",
      contents: { navItems: NAV_TREE },
      code: "nav.file_site_mismatch",
    },
  ];
  for (const scenario of cases) {
    await testContext.test(scenario.name, async (site) => {
      const workspace = await fixture(site, { "nav.json": scenario.contents });
      const wire = api([]);
      const { invocation } = invoke(workspace, wire, { verb: "nav push" });
      await assert.rejects(navPush(invocation), (error) => error?.code === scenario.code);
      // Refused before validation and before the live re-read.
      assert.equal(wire.calls.length, 0);
    });
  }

  await testContext.test("the pulled wrapper for this site pushes", async (site) => {
    const workspace = await fixture(site, { "nav.json": { siteId: SITE_ID, navItems: NAV_TREE } });
    const wire = api([
      NAV_PAGES_ROUTE,
      { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
      { method: "PUT", pattern: NAVIGATION, reply: (call) => ({ navItems: call.body.navItems }) },
    ]);
    const { invocation } = invoke(workspace, wire, { verb: "nav push" });
    assert.equal((await navPush(invocation)).navigation.items, 3);
    assert.equal(wire.matching("PUT", NAVIGATION).length, 1);
  });
});

const OUTSIDE_MARKER = "content-that-lives-outside-the-workspace";

// A workspace is a checked-out tree, so a symlink inside it arrives with the
// checkout — nobody has to race anything. `resolveWorkspacePath` is lexical and
// `O_NOFOLLOW` guards only a path's final component, so before the directory
// chain was inspected a single `pages -> ../outside` was enough to make
// `pages push` publish out-of-tree documents and `media upload` upload
// out-of-tree files, with no positional argument and no unusual invocation.
async function plantedWorkspace(site) {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([]),
    "media/real.png": png(10, 10),
  });
  const outside = path.join(workspace.project, "outside");
  await mkdir(path.join(outside, "nested"), { recursive: true });
  await writeFile(
    path.join(outside, "escape.md"),
    `---\ntitle: Escaped\npath: escaped\n---\n\n${OUTSIDE_MARKER}\n`,
  );
  await writeFile(path.join(outside, "nested", "escape.png"), png(64, 64));
  // `pages` is not a directory at all; `media/link` is a directory-shaped door
  // out of the tree.
  await symlink(path.join("..", "outside"), path.join(workspace.workspaceDir, "pages"));
  await symlink(path.join("..", "..", "outside"), path.join(workspace.workspaceDir, "media", "link"));
  return workspace;
}

test("no verb reads through a symlink planted in the workspace", async (testContext) => {
  await testContext.test("pages push refuses a linked walk root", async (site) => {
    const workspace = await plantedWorkspace(site);
    const wire = api(pushRoutes({ live: [] }));
    const { invocation } = invoke(workspace, wire, { verb: "pages push", content: contentStub().module });
    await assert.rejects(
      pagesPush(invocation),
      (error) => error?.code === "workspace.not_directory" && error?.field === "pages",
    );
    // Nothing was created or updated, so no out-of-tree document reached the site.
    assert.equal(wire.calls.length, 0);
  });

  await testContext.test("media upload refuses a positional that reaches through a link", async (site) => {
    const workspace = await plantedWorkspace(site);
    const wire = api(uploadRoutes());
    const { invocation } = invoke(workspace, wire, { verb: "media upload", paths: ["media/link/nested"] });
    await assert.rejects(
      mediaUpload(invocation),
      (error) => error?.code === "workspace.not_directory" && error?.field === "media/link/nested",
    );
    assert.equal(wire.calls.length, 0);
  });

  await testContext.test("media upload refuses the link itself as a positional", async (site) => {
    const workspace = await plantedWorkspace(site);
    const wire = api(uploadRoutes());
    const { invocation } = invoke(workspace, wire, { verb: "media upload", paths: ["media/link"] });
    await assert.rejects(
      mediaUpload(invocation),
      (error) => error?.code === "media.path_invalid" && error?.field === "media/link",
    );
    assert.equal(wire.calls.length, 0);
  });

  await testContext.test("a bare media upload walks past the link instead of descending it", async (site) => {
    const workspace = await plantedWorkspace(site);
    const wire = api(uploadRoutes());
    const { invocation } = invoke(workspace, wire, { verb: "media upload" });
    const result = await mediaUpload(invocation);
    assert.deepEqual(result.media.items.map((item) => item.file), ["media/real.png"]);
    const recorded = await readWorkspaceJson(workspace, ".taproot-site-media.json");
    assert.deepEqual(Object.keys(recorded.media), ["media/real.png"]);
  });

  // A link at the *final* component used to read as absence, because the leaf
  // went through `isFile()`. Absence is the one answer callers act on by
  // carrying on regardless, so each of these got all the way to a side effect
  // before the O_NOFOLLOW write finally refused.
  await testContext.test("a linked manifest is refused, not reported missing", async (testContext_) => {
    async function linkedWorkspace(site, name, files = {}) {
      const workspace = await fixture(site, files);
      const outside = path.join(workspace.project, "outside");
      await mkdir(outside, { recursive: true });
      await writeFile(path.join(outside, "planted.json"), JSON.stringify({ siteId: OTHER_SITE_ID }));
      await symlink(path.join("..", "outside", "planted.json"), workspacePath(workspace, name));
      return workspace;
    }

    // The worst of the set: media upload would otherwise mint an empty manifest,
    // upload, and confirm images against the API, then fail on the write —
    // leaving confirmed images recorded nowhere.
    await testContext_.test("media upload refuses before uploading anything", async (site) => {
      const workspace = await linkedWorkspace(site, ".taproot-site-media.json", { "media/hero.png": png(10, 10) });
      const wire = api(uploadRoutes());
      const { invocation } = invoke(workspace, wire, { verb: "media upload" });
      await assert.rejects(
        mediaUpload(invocation),
        (error) => error?.code === "workspace.not_regular" && error?.field === ".taproot-site-media.json",
      );
      assert.equal(wire.calls.length, 0);
    });

    // Otherwise deploy resolves a staging deployment without the manifest and
    // production promotes one the workspace never recorded.
    await testContext_.test("deploy --production refuses before promoting", async (site) => {
      const workspace = await linkedWorkspace(site, ".taproot-site-manifest.json");
      const wire = api(deployRoutes());
      const { invocation } = invoke(workspace, wire, { verb: "deploy", deployTarget: "production" });
      await assert.rejects(
        deploy(invocation),
        (error) => error?.code === "workspace.not_regular" && error?.field === ".taproot-site-manifest.json",
      );
      assert.equal(wire.calls.length, 0);
    });

    await testContext_.test("nav push says not-regular, not missing", async (site) => {
      const workspace = await linkedWorkspace(site, "nav.json");
      const wire = api([]);
      const { invocation } = invoke(workspace, wire, { verb: "nav push" });
      await assert.rejects(
        navPush(invocation),
        (error) => error?.code === "workspace.not_regular" && error?.field === "nav.json",
      );
      assert.equal(wire.calls.length, 0);
    });

    await testContext_.test("pull refuses rather than proceeding then failing at the write", async (site) => {
      const workspace = await linkedWorkspace(site, ".taproot-site-manifest.json");
      const wire = api([]);
      const { invocation } = invoke(workspace, wire, { verb: "pull" });
      await assert.rejects(pull(invocation), (error) => error?.code === "workspace.not_regular");
      assert.equal(wire.calls.length, 0);
    });
  });

  await testContext.test("a read whose parent is a link is refused, not followed", async (site) => {
    const workspace = await plantedWorkspace(site);
    await assert.rejects(
      readWorkspaceFile(workspace.workspaceDir, "pages/escape.md", 1024),
      (error) => error?.code === "workspace.not_directory" && error?.field === "pages/escape.md",
    );
  });
});

function completeWorkspace() {
  const files = {
    ...themeWorkspace(),
    ...PUSH_WORKSPACE,
    "nav.json": { siteId: SITE_ID, navItems: NAV_TREE },
    "redirects.json": { siteId: SITE_ID, revision: REDIRECT_REVISION, entries: [] },
    "media/hero.png": png(20, 10),
  };
  // PUSH_WORKSPACE's manifest replaces themeWorkspace's, so re-point its
  // footer baseline at the footer document this workspace actually contains —
  // the same file/manifest agreement a real pull writes.
  files[".taproot-site-manifest.json"] = {
    ...files[".taproot-site-manifest.json"],
    redirects: { file: "redirects.json", revision: REDIRECT_REVISION, entries: 0 },
    footer: footerManifestEntry(
      files["settings/site-publishing-preferences.json"].settings.footerSettings,
    ),
  };
  return files;
}

const VERB_CASES = [
  { name: "pull", run: pull, extra: {} },
  { name: "pages push", run: pagesPush, extra: () => ({ content: contentStub().module }) },
  { name: "nav push", run: navPush, extra: {} },
  { name: "redirects pull", run: redirectsPull, extra: {} },
  { name: "redirects push", run: redirectsPush, extra: {} },
  { name: "theme push", run: themePush, extra: {} },
  { name: "footer push", run: footerPush, extra: {} },
  { name: "media upload", run: mediaUpload, extra: {} },
  { name: "approve", run: approve, extra: {} },
  { name: "deploy", run: deploy, extra: { deployTarget: "staging" } },
  { name: "preview page", run: previewPage, extra: { pageId: ABOUT_PAGE_ID } },
  { name: "status", run: status, extra: {} },
];

test("every verb maps a classified refusal to the behavior it calls for", async (testContext) => {
  const refusals = [
    // Refused at the token exchange, before any verb does its own work: this
    // CLI is behind the only release Taproot accepts (TR00703).
    { name: "cli upgrade", body: violation("CliUpgradeRequired"), httpStatus: 400, refusal: "cli_outdated" },
    { name: "rollout", body: violation("SiteAuthoringRollout"), httpStatus: 503, refusal: "platform_paused" },
    { name: "credential", body: violation("ExternalApiKey"), httpStatus: 401, refusal: "credential_rejected" },
    { name: "throttle", body: { code: 8, message: "slow down" }, httpStatus: 429, refusal: "throttled" },
    {
      name: "capability",
      body: capabilityDenialBody("site.pages.edit_any", [CAPABILITY_DESIGN], [CAPABILITY_CONTENT]),
      httpStatus: 403,
      refusal: "capability_missing",
    },
  ];
  for (const refusal of refusals) {
    for (const verb of VERB_CASES) {
      await testContext.test(`${verb.name} / ${refusal.name}`, async (site) => {
        const workspace = await fixture(site, completeWorkspace());
        const wire = api([
          { method: "GET", pattern: /.*/u, reply: () => jsonResponse(refusal.body, refusal.httpStatus) },
          { method: "POST", pattern: /.*/u, reply: () => jsonResponse(refusal.body, refusal.httpStatus) },
          { method: "PUT", pattern: /.*/u, reply: () => jsonResponse(refusal.body, refusal.httpStatus) },
        ]);
        const { invocation } = invoke(workspace, wire, {
          verb: verb.name,
          ...(typeof verb.extra === "function" ? verb.extra() : verb.extra),
        });
        await assert.rejects(
          verb.run(invocation),
          (error) =>
            typeof error?.refusalKind === "function"
            && error.refusalKind() === refusal.refusal,
        );
      });
    }
  }
});

/**
 * The pre-write warning is a per-verb contract (TR00692): every write verb
 * announces a paused platform before it validates, reads, or sends anything.
 * Pinned across the whole table rather than for one verb, because a call
 * dropped from a single verb, or moved below that verb's first read, would
 * leave every other test green while that verb quietly stopped warning.
 */
test("every write verb announces a paused platform before doing any other work", async (testContext) => {
  const writeVerbs = [
    ...VERB_CASES.filter((verb) => !["pull", "redirects pull", "status"].includes(verb.name)),
    { name: "preview revoke", run: previewRevoke, extra: { previewIds: [ABOUT_PAGE_ID, SNAPSHOT_ID] } },
  ];
  for (const verb of writeVerbs) {
    await testContext.test(verb.name, async (site) => {
      const workspace = await fixture(site, completeWorkspace());
      const paused = () =>
        jsonResponse({ code: 14, details: [{ fieldViolations: [{ field: "SiteAuthoringRollout" }] }] }, 503);
      const wire = api([
        // Listed first, because the first matching route wins: the exchange is
        // the one call that reports the switch, and it must succeed.
        {
          method: "POST",
          pattern: TOKEN_EXCHANGE,
          reply: {
            rawKey: EXCHANGED_KEY,
            keyId: "cccc3333-dddd-4333-8333-eeee33333333",
            keyPrefix: "tr_live_ex99ab88...",
            siteId: SITE_ID,
            expiresAt: "2026-12-31T23:59:59.000Z",
            capabilities: [CAPABILITY_CONTENT, CAPABILITY_DESIGN, CAPABILITY_DEPLOYMENTS],
            externalWritesEnabled: false,
          },
        },
        { method: "GET", pattern: /.*/u, reply: paused },
        { method: "POST", pattern: /.*/u, reply: paused },
        { method: "PUT", pattern: /.*/u, reply: paused },
        { method: "PATCH", pattern: /.*/u, reply: paused },
        { method: "DELETE", pattern: /.*/u, reply: paused },
      ]);
      await saveCredential(
        { XDG_CONFIG_HOME: workspace.configHome },
        {
          apiOrigin: "https://app.taproot.test",
          accountId: "eeee5555-ffff-4555-8555-aaaa55555555",
          key: "tr_live_stored_sign_in_that_must_never_be_logged",
          keyId: "dddd4444-eeee-4444-8444-ffff44444444",
          keyPrefix: "tr_live_ab12cd34...",
        },
        { now: () => 1_700_000_000_000 },
      );
      const { invocation, progress } = invoke(workspace, wire, {
        verb: verb.name,
        ...(typeof verb.extra === "function" ? verb.extra() : verb.extra),
        // No TAPROOT_SITE_KEY: this run exchanges the stored sign-in, which is
        // what reports the switch.
        environment: { XDG_CONFIG_HOME: workspace.configHome },
      });

      await assert.rejects(
        verb.run(invocation),
        (error) => typeof error?.refusalKind === "function" && error.refusalKind() === "platform_paused",
      );

      // The exchange path prints nothing of its own, so the warning is the
      // first line this verb says: nothing was validated, read, or sent first.
      assert.ok(progress.length > 0, `${verb.name} announced nothing`);
      assert.ok(progress[0].includes(EXTERNAL_WRITES_SETTING_KEY), `${verb.name} did not warn first: ${progress[0]}`);
      assert.equal(wire.calls.findIndex((call) => !TOKEN_EXCHANGE.test(call.pathname)) >= 0, true);
    });
  }
});

// The device code redeems a credential and the minted key *is* the credential,
// so both join the credential, the presigned capability, and page contents in
// the set of values that must never reach stdout, stderr, or GITHUB_OUTPUT —
// for `login` itself, and for every verb that runs alongside a stored one.
const LOGIN_DEVICE_CODE = "E".repeat(43);
const LOGIN_RAW_KEY = "tr_live_login_minted_secret_that_must_never_be_logged";
const LOGIN_USER_CODE = "BCDF-2345";
const LOGIN_KEY_ID = "dddd4444-eeee-4444-8444-ffff44444444";
const LOGIN_ACCOUNT_ID = "eeee5555-ffff-4555-8555-aaaa55555555";
const CLI_AUTHORIZATION_START = /^\/api\/v1\/site-authoring\/cli-authorizations$/u;
const CLI_AUTHORIZATION_CLAIM = /^\/api\/v1\/site-authoring\/cli-authorizations\/claim$/u;

test("no verb ever emits the credential, upload capability, or page contents", async (testContext) => {
  const secrets = [TOKEN, PRESIGNED_URL, BODY_MARKER, LOGIN_RAW_KEY, LOGIN_DEVICE_CODE];
  const routes = [
    {
      method: "POST",
      pattern: CLI_AUTHORIZATION_START,
      reply: {
        deviceCode: LOGIN_DEVICE_CODE,
        userCode: LOGIN_USER_CODE,
        expiresInSeconds: 900,
        pollIntervalSeconds: 5,
      },
    },
    {
      method: "POST",
      pattern: CLI_AUTHORIZATION_CLAIM,
      reply: {
        status: "CLI_AUTHORIZATION_CLAIM_STATUS_ISSUED",
        rawKey: LOGIN_RAW_KEY,
        keyId: LOGIN_KEY_ID,
        // The display prefix the API actually mints: eight characters and an
        // ellipsis. It is not a secret, and it is not the key.
        keyPrefix: "tr_live_ab12cd34...",
        // Account-scoped since TR00645: the sign-in names an account, not a
        // site, and the site is chosen afterwards with 'use'.
        accountId: LOGIN_ACCOUNT_ID,
      },
    },
    {
      method: "GET",
      pattern: PAGES_LIST,
      reply: {
        pages: [pageSummary({ pageId: HOME_PAGE_ID, path: "", status: "PAGE_STATUS_APPROVED", hasDraft: true })],
        nextPageToken: "",
      },
    },
    { method: "GET", pattern: PAGE_BY_ID, reply: freeFormPageDetail(HOME_PAGE_ID, BODY_MARKER) },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    { method: "PUT", pattern: NAVIGATION, reply: (call) => ({ navItems: call.body.navItems }) },
    { method: "GET", pattern: SETTINGS, reply: {} },
    { method: "POST", pattern: FOOTER_SETTINGS, reply: (call) => ({ footerSettings: call.body.footerSettings }) },
    { method: "POST", pattern: SETTING, reply: {} },
    {
      method: "POST",
      pattern: PAGES_COLLECTION,
      reply: (call) => pageSummary({ pageId: NEW_PAGE_ID, path: call.body.path }),
    },
    {
      method: "PATCH",
      pattern: PAGE_BY_ID,
      reply: (call) => pageSummary({ pageId: call.body.pageId, path: call.body.path }),
    },
    {
      method: "POST",
      pattern: PUBLISH_DRAFTS,
      reply: (call) => ({
        pages: call.body.pageIds.map((pageId) => pageSummary({ pageId, status: "PAGE_STATUS_APPROVED" })),
      }),
    },
    ...uploadRoutes(),
    {
      method: "GET",
      pattern: READINESS,
      reply: { state: "PAGE_PUBLISHING_READINESS_STATE_READY", hasCandidateChanges: true, blockers: [] },
    },
    {
      method: "POST",
      pattern: DEPLOY,
      reply: (call) => ({
        deployment: deploymentRecord({
          environment: call.body.environment,
          status: "DEPLOYMENT_STATUS_COMPLETED",
        }),
      }),
    },
    {
      method: "GET",
      pattern: DEPLOYMENTS,
      reply: {
        deployments: [deploymentRecord({
          status: "DEPLOYMENT_STATUS_COMPLETED",
          completedAt: "2026-08-20T00:01:00Z",
        })],
        nextPageToken: "",
      },
    },
  ];

  const invocations = [
    // login and logout run first: login is the one verb that ever holds a
    // freshly minted secret, and logout runs against the store it wrote.
    ["login"],
    ["logout"],
    ["pull"],
    ["pages", "push"],
    ["nav", "push"],
    ["theme", "push"],
    ["footer", "push"],
    ["media", "upload"],
    ["approve"],
    ["deploy", "--staging"],
    ["status"],
  ];
  for (const verb of invocations) {
    await testContext.test(verb.join(" "), async (site) => {
      const workspace = await fixture(site, completeWorkspace());
      const outputPath = path.join(workspace.root, `github-output-${verb.join("-")}`);
      await writeFile(outputPath, "");
      // A private config home, so `login` writes a real store without touching
      // the one belonging to whoever is running the tests.
      const configHome = path.join(workspace.root, "config-home");
      await mkdir(configHome, { recursive: true });
      const wire = api(routes);
      const content = contentStub().module;
      let stdout = "";
      let stderr = "";
      const exitCode = await runCli({
        arguments_: ["--config", workspace.configPath, ...verb],
        environment: { TAPROOT_SITE_KEY: TOKEN, GITHUB_OUTPUT: outputPath, XDG_CONFIG_HOME: configHome },
        cwd: workspace.project,
        stdout: {
          write: (chunk) => {
            stdout += chunk;
          },
        },
        stderr: {
          write: (chunk) => {
            stderr += chunk;
          },
        },
        handlers: {
          ...VERB_HANDLERS,
          "pages push": (invocation) => pagesPush({ ...invocation, content }),
        },
        fetch: wire.fetch,
      });
      assert.equal(exitCode, 0, `${verb.join(" ")} failed: ${stderr}`);
      assert.equal(JSON.parse(stdout).ok, true);
      const emitted = `${stdout}${stderr}${await readFile(outputPath, "utf8")}`;
      for (const secret of secrets) {
        assert.doesNotMatch(emitted, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
      }
    });
  }
});

test("the verb table declares every capability the verb's own routes need", async (testContext) => {
  // The claim under test is the verb table's own comment: each declared set is
  // the smallest the verb's *requests* need. `nav push` and `deploy` were both
  // one short of it, because both list the site's pages before writing anything
  // and nothing checked reads against the table (TR00691).
  await testContext.test("nav push and deploy declare Content for the page list they read", () => {
    assert.deepEqual(VERB_CAPABILITIES["nav push"], [CAPABILITY_CONTENT, CAPABILITY_DESIGN]);
    assert.deepEqual(
      VERB_CAPABILITIES["deploy"],
      [CAPABILITY_CONTENT, CAPABILITY_DESIGN, CAPABILITY_DEPLOYMENTS],
    );
  });

  // Design is on `deploy` for the promotion, not for a write: --production
  // re-authorizes the promoted candidate's stored settings and navigation.
  await testContext.test("deploy declares Design for the promotion it re-authorizes", () => {
    assert.ok(VERB_CAPABILITIES["deploy"].includes(CAPABILITY_DESIGN));
    // And `deploy` is still the only verb that needs all three: a verb table
    // where everything asks for everything would pass the gate and mint the
    // widest credential every time.
    assert.deepEqual(
      Object.entries(VERB_CAPABILITIES)
        .filter(([, capabilities]) => capabilities.length === SITE_AUTHORING_CAPABILITIES.length)
        .map(([verb]) => verb),
      ["deploy"],
    );
  });

  await testContext.test("every declared capability is one an exchange can ask for", () => {
    for (const [verb, capabilities] of Object.entries(VERB_CAPABILITIES)) {
      assert.ok(capabilities.length > 0, `${verb} declares an empty set`);
      assert.deepEqual(
        capabilities.filter((capability) => !SITE_AUTHORING_CAPABILITIES.includes(capability)),
        [],
        `${verb} declares a capability outside the site-authoring envelope`,
      );
      assert.deepEqual([...new Set(capabilities)], [...capabilities], `${verb} names a capability twice`);
    }
  });

  // The gate the whole suite now runs behind only proves a declaration is wide
  // enough while it is genuinely enforced. Narrowing one by a capability has to
  // fail, or a set could quietly go stale again.
  await testContext.test("narrowing a declared set by one capability is refused on the wire", async (site) => {
    const workspace = await fixture(site, {
      "nav.json": {
        siteId: SITE_ID,
        navItems: [{
          id: navId(1),
          kind: "NAV_ITEM_KIND_PAGE",
          title: "About",
          resourceId: resourceIdFor(ABOUT_PAGE_ID),
        }],
      },
    });
    const wire = api([
      { method: "GET", pattern: PAGES_LIST, reply: { pages: [pageSummary()] } },
      { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
      { method: "PUT", pattern: NAVIGATION, reply: { navItems: [] } },
    ]);
    // Design alone: exactly what `nav push` declared before this task, and one
    // capability short of the page list it reads.
    const narrowed = capabilityGatedFetch("theme push", wire.fetch);
    const { invocation, progress } = invoke(workspace, wire, { verb: "nav push", fetch: narrowed });
    await assert.rejects(navPush(invocation), (error) => {
      assert.equal(error.code, "api.request_rejected");
      assert.equal(error.status, "grpc:7");
      assert.equal(error.field, "GrantedCapabilities");
      assert.equal(error.refusalKind(), "capability_missing");
      assert.deepEqual(error.capability, {
        permission: "site.pages.edit_any",
        granted: [CAPABILITY_DESIGN],
        required: [CAPABILITY_CONTENT],
      });
      return true;
    });
    // The refusal lands on the read, before anything is replaced.
    assert.equal(wire.matching("PUT", NAVIGATION).length, 0);
    // And the operator is told which capability, and that the verb table — not
    // the credential — is what needs changing.
    const announced = progress.join("\n");
    assert.match(announced, /CAPABILITY MISSING \(refusal=capability_missing, field=GrantedCapabilities\)/u);
    assert.match(announced, /site\.pages\.edit_any/u);
    assert.match(announced, /Carried by: delegation\.content\./u);
    assert.match(announced, /verb table/u);
  });

  // The same proof for the second shortfall, which no route-level gate could
  // have caught: `deploy --production` sends nothing but a staging deployment
  // id, and the server re-authorizes what that deployment stored.
  await testContext.test("narrowing deploy by Design is refused on the promotion", async (site) => {
    const workspace = await fixture(site, {
      ".taproot-site-manifest.json": manifestFixture([], {
        deployments: { staging: { id: STAGING_DEPLOYMENT_ID, status: "DEPLOYMENT_STATUS_COMPLETED" } },
      }),
    });
    const wire = api(deployRoutes());
    // Content plus Deployments: exactly what `deploy` declared before this
    // task, and one capability short of the stored candidate it promotes.
    const narrowed = capabilityGatedFetch("status", wire.fetch);
    const { invocation, progress } = invoke(workspace, wire, {
      verb: "deploy",
      deployTarget: "production",
      fetch: narrowed,
    });
    await assert.rejects(deploy(invocation), (error) => {
      assert.equal(error.code, "api.request_rejected");
      assert.equal(error.refusalKind(), "capability_missing");
      assert.deepEqual(error.capability, {
        permission: "site.theme.manage",
        granted: [CAPABILITY_CONTENT, CAPABILITY_DEPLOYMENTS],
        required: [CAPABILITY_DESIGN],
      });
      return true;
    });
    // Readiness is read before the promotion, so the refusal is the deploy
    // itself and nothing was promoted.
    assert.equal(wire.matching("POST", DEPLOY).length, 0);
    assert.match(progress.join("\n"), /Carried by: delegation\.design\./u);
  });
});
