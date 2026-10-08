import { encodeTheme, parseTheme } from "@taprootio/espalier/shared/theme";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeImage } from "../src/api.js";
import {
  CAPABILITY_CONTENT,
  CAPABILITY_DEPLOYMENTS,
  CAPABILITY_DESIGN,
  SITE_AUTHORING_CAPABILITIES,
} from "../src/capabilities.js";
import { runCli, VERB_CAPABILITIES, VERB_SURFACES, verbCapabilitiesForSurface } from "../src/cli.js";
import { CLI_VERSION, CAPABILITY_REFUSAL_REASON, EXTERNAL_WRITES_SETTING_KEY, LIMITS } from "../src/constants.js";
import { markdownToProseMirror, validateDocument } from "../src/content/index.js";
import { saveCredential } from "../src/credentials.js";
import { applyFooterColors } from "../src/appearance-contract.js";
import { FOOTER_EXAMPLE, projectFooterSettingsForWorkspace } from "../src/footer-contract.js";
import { computeFooterContentHash, computeFooterDraftHash } from "../src/footer-draft-hash.js";
import { appearanceManifestEntry, footerManifestEntry, presentationManifestEntry } from "../src/footer-workspace.js";
import { failureResult, writeGithubActionsOutput } from "../src/output.js";
import { REDIRECT_LIMITS } from "../src/redirects-contract.js";
import { SETTINGS_GROUPS } from "../src/settings-catalog.js";
import { approve } from "../src/verbs/approve.js";
import { deliveryCheck } from "../src/verbs/delivery-check.js";
import { deploy } from "../src/verbs/deploy.js";
import { footerPush } from "../src/verbs/footer-push.js";
import { VERB_HANDLERS } from "../src/verbs/index.js";
import { mediaUpload } from "../src/verbs/media-upload.js";
import { navPush } from "../src/verbs/nav-push.js";
import { pagesPush } from "../src/verbs/pages-push.js";
import { previewPage } from "../src/verbs/preview-page.js";
import { projectPulledTheme } from "../src/theme-projection.js";
import { missingThemeFields } from "../src/theme-validation.js";
import { previewRevoke } from "../src/verbs/preview-revoke.js";
import { pull } from "../src/verbs/pull.js";
import { redirectsPull } from "../src/verbs/redirects-pull.js";
import { redirectsPush } from "../src/verbs/redirects-push.js";
import { stagingReview } from "../src/verbs/staging-review.js";
import { status } from "../src/verbs/status.js";
import { themePush, validateThemeWorkspace } from "../src/verbs/theme-push.js";
import {
  internalPageObservedRevisionFile,
  pageContentKey,
  readWorkspaceFile,
  workspaceContentHash,
  writeWorkspaceFile,
} from "../src/workspace.js";
import { INSIDE_MONOREPO, MONOREPO_ONLY } from "./monorepo.js";

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
  ? Object.freeze(Object.fromEntries(
    await Promise.all(
      TAPROOT_WWW_PAGE_PATHS.map(async (pagePath) => [
        pagePath,
        await readFile(new URL(`pages/${TAPROOT_WWW_PAGE_FILES[pagePath]}`, TAPROOT_WWW_FIXTURE_ROOT), "utf8"),
      ]),
    ),
  ))
  : undefined;
const TAPROOT_WWW_STYLES = INSIDE_MONOREPO
  ? JSON.parse(await readFile(new URL("settings/taproot-styles.json", TAPROOT_WWW_FIXTURE_ROOT), "utf8"))
  : undefined;
const TAPROOT_WWW_MEDIA = INSIDE_MONOREPO
  ? JSON.parse(await readFile(new URL(".taproot-site-media.json", TAPROOT_WWW_FIXTURE_ROOT), "utf8"))
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

async function fixture(testContext, files = {}, { config = {} } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "taproot-site-verbs-"));
  testContext.after(() => rm(base, { recursive: true, force: true }));
  const root = await realpath(base);
  const project = path.join(root, "project");
  const workspaceDir = path.join(project, "site");
  const configHome = path.join(root, "config-home");
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    path.join(project, "taproot-site.json"),
    `${JSON.stringify({ configVersion: 1, siteId: SITE_ID, workspaceDir: "site", ...config })}\n`,
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

/**
 * Appends a newline to every editable page source the manifest names, the way an
 * edit changes a file's bytes. A push skips a page whose source and metadata
 * match what the site last agreed to, so a test that needs a page sent edits it first.
 */
async function touchPulledSources(site) {
  const manifest = await readWorkspaceJson(site, ".taproot-site-manifest.json");
  for (const entry of manifest.pages) {
    if (typeof entry.file !== "string") continue;
    await writeWorkspaceFile(site.workspaceDir, entry.file, Buffer.from(`${await readWorkspaceText(site, entry.file)}\n`));
  }
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
  const withRedirects = routes.some((route) => route.method === "GET" && route.pattern === REDIRECT_MAP)
    ? [...routes]
    : [...routes, { method: "GET", pattern: REDIRECT_MAP, reply: emptyRedirectMap() }];
  // `pull` also reads who a page can be credited to (TR01196), so a test that
  // is not about authors gets the answer of a site with nobody to name.
  const effectiveRoutes = withRedirects.some((route) => route.method === "GET" && route.pattern === AUTHORS)
    ? withRedirects
    : [...withRedirects, { method: "GET", pattern: AUTHORS, reply: { authors: [], members: [] } }];
  // Likewise the presentation snapshot `pull` projects the four settings
  // groups from, with the revision it records as the baseline (TR00807): a
  // test about something else gets a stable baseline, and the snapshot is
  // synthesized from whatever the test's own settings route answers per
  // group — so a fixture written per group still describes the site. A group
  // the settings route refuses refuses the snapshot the same way, which is
  // what the server does: the snapshot is gated on the same permissions.
  if (!routes.some((route) => route.method === "GET" && route.pattern === PRESENTATION)) {
    const settingsRoute = routes.find((route) => route.method === "GET" && route.pattern === SETTINGS);
    effectiveRoutes.push({
      method: "GET",
      pattern: PRESENTATION,
      reply: async (call, calls) => {
        if (settingsRoute === undefined) return jsonResponse({ code: 5, message: "not found" }, 404);
        const snapshot = { siteId: SITE_ID, revision: PRESENTATION_REVISION };
        for (const group of SETTINGS_GROUPS) {
          const groupCall = {
            ...call,
            pathname: `/api/v1/settings/${group.settingsType}`,
            query: new URLSearchParams({ entityId: SITE_ID, environment: "SITE_ENVIRONMENT_DRAFT" }),
          };
          let value = typeof settingsRoute.reply === "function"
            ? await settingsRoute.reply(groupCall, calls)
            : settingsRoute.reply;
          if (value instanceof Response) {
            if (!value.ok) return value;
            value = await value.json();
          }
          snapshot[group.responseProperty] = value?.[group.responseProperty] ?? {};
        }
        return snapshot;
      },
    });
  }
  effectiveRoutes.push({
    method: "GET",
    pattern: DEPLOY_REVIEW,
    reply: {
      stagedPages: [{ pageId: ABOUT_PAGE_ID }],
      settingsChanges: [{ settingsType: "SETTING_TYPE_SITE_HEADER", changes: [{ fieldName: "headerLayout" }] }],
      navigationChanged: true,
    },
  });
  const calls = [];
  const queryViolations = [];
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url);
    const method = init.method ?? "GET";
    const bodyText = typeof init.body === "string" ? init.body : undefined;
    // A streamed upload body (a video original) is read to the end here, as the
    // object store would, so a test can assert what was actually sent.
    const streamedBytes = init.body !== null && typeof init.body === "object" && typeof init.body.getReader === "function"
      ? new Uint8Array(await new Response(init.body).arrayBuffer())
      : undefined;
    const call = {
      method,
      pathname: target.pathname,
      query: target.searchParams,
      body: bodyText === undefined ? undefined : JSON.parse(bodyText),
      bytes: ArrayBuffer.isView(init.body) ? init.body : streamedBytes,
      duplex: init.duplex,
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
const AUTHORS = /\/authors$/u;
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
const PRESENTATION = /\/presentation$/u;
// Two stand-ins for the server's presentation revision (TR00807): 64 lowercase
// hex characters because that is what the CLI accepts; stable across a test's
// pull and its push, and different from each other so a moved baseline reads.
const PRESENTATION_REVISION = "c".repeat(64);
const NEXT_PRESENTATION_REVISION = "d".repeat(64);
const READINESS = /\/publishing\/readiness$/u;
const DEPLOY_REVIEW = /\/deploy\/review$/u;
const STAGING_MINT = /\/staging-preview:mint-handoff$/u;
const STAGING_HANDOFF_URL = `https://${STAGING_HOST}/?__taproot_preview_handoff=${HANDOFF_TOKEN}`;
const DEPLOY = /\/deploy$/u;
const DEPLOYMENTS = /\/deployments$/u;
const STAGING_PREVIEW_STATUS = /\/staging-preview\/status$/u;
const STAGING_PREVIEW_ROOT = /^\/$/u;
const SITE_IMAGES = /\/sites\/[^/]+\/images$/u;
const PLACES_SEARCH = /^\/api\/v1\/places\/search$/u;
const PLACES_SELECT = /^\/api\/v1\/places\/select$/u;
const BROKEN_REFERENCES = /\/sites\/[^/]+\/broken-references$/u;
const REQUEST_UPLOAD = /\/images\/request-upload$/u;
const CONFIRM_UPLOAD = /\/images\/confirm-upload$/u;
const PRESIGNED_PUT = /^\/upload$/u;
const SITE_VIDEOS = /\/sites\/[^/]+\/videos$/u;
const REQUEST_VIDEO_UPLOAD = /\/sites\/[^/]+\/videos\/request-upload$/u;
const CONFIRM_VIDEO_UPLOAD = /\/sites\/[^/]+\/videos\/confirm-upload$/u;
const IMPORT_VIDEO_EMBED_POSTER = /\/sites\/[^/]+\/videos\/import-embed-poster$/u;
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
  // Naming an author is part of creating a page, so both halves resolve the
  // permission that creates pages (TR01196).
  { method: "GET", pattern: AUTHORS, permission: "site.pages.create" },
  { method: "POST", pattern: AUTHORS, permission: "site.pages.create" },
  { method: "GET", pattern: SETTINGS, permission: "site.theme.manage" },
  { method: "POST", pattern: SETTING, permission: "site.theme.manage" },
  { method: "POST", pattern: FOOTER_SETTINGS, permission: "site.theme.manage" },
  { method: "GET", pattern: PRESENTATION, permission: "site.theme.manage" },
  { method: "POST", pattern: PRESENTATION, permission: "site.theme.manage" },
  { method: "GET", pattern: DEPLOY_REVIEW, permission: "site.deploy" },
  { method: "POST", pattern: STAGING_MINT, permission: "site.staging.view" },
  { method: "GET", pattern: READINESS, permission: "site.deploy" },
  { method: "POST", pattern: DEPLOY, permission: "site.deploy" },
  { method: "GET", pattern: DEPLOYMENTS, permission: "site.deployments.view_any" },
  { method: "GET", pattern: STAGING_PREVIEW_STATUS, permission: "site.staging.view" },
  { method: "GET", pattern: SITE_IMAGES, permission: "site.media.manage" },
  { method: "GET", pattern: SITE_VIDEOS, permission: "site.media.manage" },
  { method: "POST", pattern: REQUEST_VIDEO_UPLOAD, permission: "site.media.manage" },
  { method: "POST", pattern: CONFIRM_VIDEO_UPLOAD, permission: "site.media.manage" },
  { method: "POST", pattern: IMPORT_VIDEO_EMBED_POSTER, permission: "site.media.manage" },
  { method: "GET", pattern: BROKEN_REFERENCES, permission: "site.pages.edit_any" },
  { method: "POST", pattern: REQUEST_UPLOAD, permission: "site.media.manage" },
  { method: "POST", pattern: CONFIRM_UPLOAD, permission: "site.media.manage" },
  { method: "POST", pattern: PREVIEW_MINT, permission: "site.pages.edit_any" },
  { method: "POST", pattern: PREVIEW_CREATE, permission: "site.pages.edit_any" },
  { method: "GET", pattern: PREVIEW_STATUS, permission: "site.pages.edit_any" },
  { method: "DELETE", pattern: PREVIEW_STATUS, permission: "site.pages.edit_any" },
  { method: "GET", pattern: PLACES_SEARCH, permission: "site.pages.edit_any" },
  { method: "POST", pattern: PLACES_SELECT, permission: "site.pages.edit_any" },
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
    manifestVersion: 7,
    siteId: SITE_ID,
    pulledAt: "2026-08-20T00:00:00.000Z",
    navigation: { file: "nav.json", items: 1 },
    settings: [{ settingsType: "SETTING_TYPE_SITE_HEADER", file: "settings/site-header.json" }],
    settingsSkipped: [],
    footer: footerManifestEntry(projectFooterSettingsForWorkspace({})),
    appearance: appearanceManifestEntry({}),
    pages: pages.map((entry) =>
      entry === null
        ? null
        : {
          workspaceMode: typeof entry?.file === "string" ? "editable" : "metadata-only",
          ...entry,
        }
    ),
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
      presentation: presentationManifestEntry(PRESENTATION_REVISION),
      ...overrides.manifest,
    }),
    "settings/taproot-styles.json": settingsDocument("SETTING_TYPE_TAPROOT_STYLES", {
      lightTheme: agentTheme(DEFAULT_SITE_THEME.light.theme),
      darkTheme: agentTheme(DEFAULT_SITE_THEME.dark.theme),
      defaultScheme: "system",
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
          pages: [pageSummary({ pageId: STORY_PAGE_ID, path: "story", templateType: "TEMPLATE_TYPE_LEGAL" })],
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
    // No per-group settings route: the four documents and the revision that
    // covers them come from the one presentation snapshot (TR00807), so the
    // baseline the manifest records is the revision of the documents it holds.
    {
      method: "GET",
      pattern: PRESENTATION,
      reply: presentationReply({
        revision: NEXT_PRESENTATION_REVISION,
        headerSettings: { headerLayout: "centered-brand", showThemeToggle: true },
        styleSettings: { lightLogoId: IMAGE_ID },
        footerSettings: pulledFooterResponse,
      }),
    },
  ]);
  const { invocation, progress } = invoke(workspace, wire, { verb: "pull" });
  const result = await pull(invocation);

  assert.equal(result.ok, true);
  assert.equal(result.verb, "pull");
  assert.equal(result.siteId, SITE_ID);
  assert.equal(wire.matching("GET", PRESENTATION).length, 1);
  assert.equal(wire.matching("GET", SETTINGS).length, 0);
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
  // The legal page is snapshotted as metadata only: this CLI authors the five
  // content templates and does not pretend to round-trip the others.
  assert.equal(await workspaceHas(workspace, "pages/story.pm.json"), false);
  assert.deepEqual(
    (await readWorkspaceJson(workspace, "pages/index.pm.json")).content[0].content[0].text,
    BODY_MARKER,
  );
  assert.deepEqual((await readWorkspaceJson(workspace, "nav.json")).navItems.length, 1);

  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.manifestVersion, 7);
  assert.equal(manifest.siteId, SITE_ID);
  assert.equal(manifest.pulledAt, new Date(1_700_000_000_000).toISOString());
  assert.deepEqual(
    manifest.pages.map((entry) => [
      entry.pageId,
      entry.path,
      entry.status,
      entry.file,
      entry.workspaceMode,
    ]),
    [
      [HOME_PAGE_ID, "", "PAGE_STATUS_APPROVED", "pages/index.pm.json", "editable"],
      [ABOUT_PAGE_ID, "about", "PAGE_STATUS_PUBLISHED", "pages/about.pm.json", "editable"],
      [STORY_PAGE_ID, "story", "PAGE_STATUS_PUBLISHED", undefined, "metadata-only"],
    ],
  );
  assert.equal(manifest.pages[0].resourceId, resourceIdFor(HOME_PAGE_ID));
  assert.deepEqual(manifest.appearance.imageIds, [IMAGE_ID]);
  assert.deepEqual(manifest.presentation, { revision: NEXT_PRESENTATION_REVISION });

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
  // A theme the site never set is still written complete: the effective
  // defaults every consumer renders, with no mapping pins (TR00775).
  const styles = await readWorkspaceJson(workspace, "settings/taproot-styles.json");
  for (const scheme of ["light", "dark"]) {
    const theme = styles.settings[`${scheme}Theme`];
    assert.deepEqual(missingThemeFields(theme, scheme), []);
    assert.deepEqual(theme.semanticMappings, {});
    assert.deepEqual(theme.explicitMappingTokens, []);
  }
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
      reply: (call) =>
        call.pathname.endsWith("SETTING_TYPE_SITE_PUBLISHING_PREFERENCES")
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
    (error) =>
      error?.code === "footer.url_invalid"
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
    (error) =>
      error?.code === "footer.text_invalid"
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
    // The per-group reads are made only against a Taproot without the
    // presentation snapshot (TR00807); this is that Taproot.
    { method: "GET", pattern: PRESENTATION, reply: () => jsonResponse({ code: 5, message: "not found" }, 404) },
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
          sitePublishingPreferences: pulledThemeWorkspace["settings/site-publishing-preferences.json"].settings,
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
    { method: "GET", pattern: PRESENTATION, reply: presentationReply() },
    { method: "POST", pattern: PRESENTATION, reply: (call) => presentationSaveReply(call) },
  ]);
  await themePush(invoke(workspace, pushWire, { verb: "theme push" }).invocation);
  const themeWrites = pushWire.matching("POST", PRESENTATION)[0].body.settings.slice(-2);
  for (const write of themeWrites) {
    assert.equal(parseTheme(write.value)?.fontBrand, "\"日本語 😀\", serif");
  }
});

test("pull projects a pre-menu-font stored theme to the complete effective pair that validates, holds across a second pull, and pushes pins only", async (site) => {
  const workspace = await fixture(site);
  // The SHY Wellness shape: a seeded complete theme stored before the
  // per-scheme menu font existed, with the defaults' cached mappings and
  // one authored pin, still managed by Taproot (no external provenance).
  // The pin is claimed by the marker, which is what makes it a pin at all
  // since Espalier 4.18.0 and what the settings editor now writes.
  const stored = (scheme) => {
    const theme = structuredClone(DEFAULT_SITE_THEME[scheme].theme);
    delete theme.fontMenu;
    delete theme.fontWeightMenu;
    theme.seedColor = "#3b5b3b";
    theme.semanticMappings.headings = { source: "complementary", lightness: "ink" };
    theme.explicitMappingTokens = ["headings"];
    return theme;
  };
  const pulledThemeWorkspace = themeWorkspace();
  const styleSettings = {
    ...pulledThemeWorkspace["settings/taproot-styles.json"].settings,
    lightTheme: encodeTheme(stored("light")),
    darkTheme: encodeTheme(stored("dark")),
  };
  const routes = () => [
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
          sitePublishingPreferences: pulledThemeWorkspace["settings/site-publishing-preferences.json"].settings,
        };
      },
    },
  ];

  await pull(invoke(workspace, api(routes()), { verb: "pull" }).invocation);
  const first = await readWorkspaceJson(workspace, "settings/taproot-styles.json");
  for (const scheme of ["light", "dark"]) {
    const theme = first.settings[`${scheme}Theme`];
    assert.deepEqual(missingThemeFields(theme, scheme), []);
    assert.equal(typeof theme.fontMenu, "string");
    assert.equal(typeof theme.fontWeightMenu, "string");
    assert.equal(theme.seedColor, "#3b5b3b");
    // Only the authored pin survives; the twenty-two cached defaults do not.
    assert.deepEqual(Object.keys(theme.semanticMappings), ["headings"]);
    assert.deepEqual(theme.explicitMappingTokens, ["headings"]);
  }
  // The untouched workspace validates offline without hand-completing anything.
  await validateThemeWorkspace(workspace.workspaceDir, SITE_ID, new Set());

  // A second pull against the same sparse server projection retains the fields.
  await pull(invoke(workspace, api(routes()), { verb: "pull" }).invocation);
  assert.deepEqual(await readWorkspaceJson(workspace, "settings/taproot-styles.json"), first);

  // What push stores is the complete theme with its pin marker, so roles
  // compile at render time for every other token.
  const pushWire = api([
    { method: "GET", pattern: PRESENTATION, reply: presentationReply() },
    { method: "POST", pattern: PRESENTATION, reply: (call) => presentationSaveReply(call) },
  ]);
  await themePush(invoke(workspace, pushWire, { verb: "theme push" }).invocation);
  for (const write of pushWire.matching("POST", PRESENTATION)[0].body.settings.slice(-2)) {
    const pushed = parseTheme(write.value);
    assert.equal(pushed.fontMenu, first.settings.lightTheme.fontMenu);
    assert.deepEqual(pushed.explicitMappingTokens, ["headings"]);
    assert.deepEqual(Object.keys(pushed.semanticMappings), ["headings"]);
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
      reply: (call) =>
        call.pathname.endsWith("SETTING_TYPE_TAPROOT_STYLES")
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
      // Themes are projected to the complete effective defaults (TR00775);
      // the other zeros stay the wire's own.
      lightTheme: projectPulledTheme({}, "light"),
      darkTheme: projectPulledTheme({}, "dark"),
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
      showFollowButton: false,
      albumSeamless: false,
      hideLightboxComments: false,
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

test("pull records no presentation baseline against a Taproot without the atomic save", async (site) => {
  const workspace = await fixture(site);
  const wire = api([
    { method: "GET", pattern: PAGES_LIST, reply: { pages: [], nextPageToken: "" } },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    { method: "GET", pattern: SETTINGS, reply: {} },
    { method: "GET", pattern: PRESENTATION, reply: () => jsonResponse({ code: 5, message: "not found" }, 404) },
  ]);
  const { invocation, progress } = invoke(workspace, wire, { verb: "pull" });
  const result = await pull(invocation);

  assert.equal(result.ok, true);
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.presentation, undefined);
  assert.ok(manifest.appearance !== undefined);
  assert.ok(progress.some((line) => line.includes("does not serve the atomic presentation save")));
});

test("pull falls back to per-group reads and records no baseline when the snapshot is refused", async (site) => {
  const workspace = await fixture(site);
  const wire = api([
    { method: "GET", pattern: PAGES_LIST, reply: { pages: [], nextPageToken: "" } },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    {
      method: "GET",
      pattern: SETTINGS,
      reply: (call) => (call.pathname.endsWith("SETTING_TYPE_TAPROOT_STYLES")
        ? capabilityDenied("site.theme.manage", [CAPABILITY_CONTENT], [CAPABILITY_DESIGN])
        : {}),
    },
  ]);
  const result = await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  assert.deepEqual(result.settings.skipped, ["SETTING_TYPE_TAPROOT_STYLES"]);
  // The snapshot is gated on the same permissions as the groups it carries,
  // so the credential that cannot read styles cannot read it either; the
  // groups it can read are then read one at a time, and no baseline is
  // recorded for a workspace whose appearance files are incomplete.
  assert.equal(wire.matching("GET", PRESENTATION).length, 1);
  assert.equal(wire.matching("GET", SETTINGS).length, 4);
  assert.equal((await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).presentation, undefined);
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

/**
 * The site's presentation as the read and the save answer it (TR00807): the
 * four groups as GetSettings projects them, plus the revision. Groups a test
 * does not care about are left at proto3's omitted zero.
 */
function presentationReply({
  revision = PRESENTATION_REVISION,
  footerSettings = {},
  headerSettings = {},
  styleSettings = {},
  brandSettings = {},
} = {}) {
  return {
    siteId: SITE_ID,
    revision,
    styleSettings,
    brandSettings,
    headerSettings,
    sitePublishingPreferences: { footerSettings },
  };
}

/**
 * What the server does with a save: overlays the ten colours from the request
 * onto the footer document it holds and answers with the new revision. The
 * footer is a function of the request so a test can assert the overlay
 * reached the document the site holds rather than the workspace's copy.
 */
function presentationSaveReply(call, { footerSettings = {}, revision = NEXT_PRESENTATION_REVISION, applied = true } = {}) {
  return {
    applied,
    presentation: presentationReply({
      revision,
      footerSettings: applyFooterColors(footerSettings, call.body.footerColors),
    }),
  };
}

test("theme push saves the complete change set in one request fenced by the pull baseline", async (site) => {
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
    { method: "GET", pattern: PRESENTATION, reply: presentationReply({ footerSettings: currentFooter }) },
    {
      method: "POST",
      pattern: PRESENTATION,
      reply: (call) => presentationSaveReply(call, { footerSettings: currentFooter }),
    },
  ]);

  const { invocation, progress } = invoke(workspace, wire, { verb: "theme push" });
  const result = await themePush(invocation);

  assert.equal(result.ok, true);
  assert.equal(result.verb, "theme push");
  assert.equal(result.applied, true);
  assert.equal(result.revision, NEXT_PRESENTATION_REVISION);
  assert.equal(result.written.items.length, 26);
  // One read, one write: nothing else touches the site.
  assert.deepEqual(wire.calls.map((call) => call.method), ["GET", "POST"]);
  const save = wire.matching("POST", PRESENTATION)[0];
  assert.equal(save.pathname, `/api/v1/sites/${SITE_ID}/presentation`);
  assert.equal(save.body.siteId, SITE_ID);
  assert.equal(save.body.expectedRevision, PRESENTATION_REVISION);
  assert.equal(save.body.expectedFooterDraftHash, computeFooterDraftHash(currentFooter));
  // The ten colours travel as a typed overlay, never the footer document.
  assert.equal("footerSettings" in save.body, false);
  assert.equal(save.body.footerColors.light.backgroundColor, "--esp-color-layer-1");
  assert.equal(save.body.footerColors.dark.headingColor, "#ffffff");
  assert.equal(save.body.settings.length, 25);
  assert.equal(
    save.body.settings.find((write) => write.setting === "lightLogoId")?.value,
    IMAGE_ID,
  );
  assert.equal(
    save.body.settings.find((write) => write.setting === "lightLogoId")?.settingsType,
    "SETTING_TYPE_TAPROOT_STYLES",
  );
  const themes = save.body.settings.slice(-2);
  assert.deepEqual(themes.map((write) => write.setting), ["lightTheme", "darkTheme"]);
  for (const write of themes) {
    const decoded = JSON.parse(Buffer.from(write.value, "base64").toString("utf8"));
    assert.deepEqual(decoded.roles.action, { color: "anchor:brand", ink: "primary" });
    assert.equal(decoded.contexts.feature.canvas, "anchor:brand");
    assert.equal(decoded.anchors.brand, "#b83280");
    assert.deepEqual(decoded.semanticMappings, {});
  }
  // The footer document is rewritten from the saved result — the site's
  // prose and links, the workspace's colours — and both baselines advance.
  const publishing = await readWorkspaceJson(workspace, "settings/site-publishing-preferences.json");
  assert.deepEqual(publishing.settings.footerSettings.bottomLinks, currentFooter.bottomLinks);
  assert.equal(publishing.settings.footerSettings.light.backgroundColor, "--esp-color-layer-1");
  assert.equal(publishing.settings.footerSettings.light.backgroundImageOpacity, 0.4);
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.presentation.revision, NEXT_PRESENTATION_REVISION);
  assert.equal(
    manifest.footer.expectedDraftHash,
    computeFooterDraftHash(publishing.settings.footerSettings),
  );
  assert.equal(
    manifest.footer.expectedContentHash,
    computeFooterContentHash(publishing.settings.footerSettings),
  );
  assert.ok(progress.some((line) => line.includes("one transaction")));
  assert.ok(progress.some((line) => line.includes("externally managed")));
  wire.assertQueryContracts();
});

test("theme push --dry-run reads the site, names the paths that differ per file, and writes nothing", async (site) => {
  const workspace = await fixture(site, themeWorkspace());
  const before = {};
  for (
    const file of [
      "settings/taproot-styles.json",
      "settings/brand.json",
      "settings/site-header.json",
      "settings/site-publishing-preferences.json",
      ".taproot-site-manifest.json",
    ]
  ) {
    before[file] = await readWorkspaceText(workspace, file);
  }
  const wire = api([
    {
      method: "GET",
      pattern: PRESENTATION,
      reply: presentationReply({
        headerSettings: { brandText: "Remote brand", showThemeToggle: true, showBrandText: true },
        footerSettings: { light: { backgroundColor: "#000000" } },
      }),
    },
  ]);

  const { invocation, progress } = invoke(workspace, wire, { verb: "theme push", dryRun: true });
  const result = await themePush(invocation);

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.revision, {
    baseline: PRESENTATION_REVISION,
    current: PRESENTATION_REVISION,
    stale: false,
  });
  assert.deepEqual(wire.calls.map((call) => call.method), ["GET"]);
  const header = result.differences.find((entry) => entry.file === "settings/site-header.json");
  assert.ok(header.paths.includes("$.brandText"));
  // A field the workspace and the site agree on is not reported.
  assert.equal(header.paths.includes("$.showThemeToggle"), false);
  // The site holds one light colour and no dark ones; the workspace sets all
  // ten, so every colour path is named — sorted, so two runs report alike.
  const footer = result.differences.find((entry) => entry.file === "settings/site-publishing-preferences.json");
  assert.deepEqual(
    footer.paths,
    ["dark", "light"].flatMap((scheme) =>
      ["backgroundColor", "headingColor", "linkColor", "linkHoverColor", "textColor"].map((color) =>
        `$.footerSettings.${scheme}.${color}`
      )
    ),
  );
  // Only the fields the save owns are compared: the site's `allowSearch` or
  // footer prose never appears here.
  assert.ok(result.differences.every((entry) => entry.paths.every((path) => !path.includes("allowSearch"))));
  assert.ok(progress.some((line) => line.includes("Dry run: nothing was written.")));
  for (const [file, contents] of Object.entries(before)) {
    assert.equal(await readWorkspaceText(workspace, file), contents, file);
  }
});

test("theme push --dry-run reports a baseline the site has moved past as stale", async (site) => {
  const workspace = await fixture(site, themeWorkspace());
  const wire = api([
    { method: "GET", pattern: PRESENTATION, reply: presentationReply({ revision: NEXT_PRESENTATION_REVISION }) },
  ]);

  const result = await themePush(invoke(workspace, wire, { verb: "theme push", dryRun: true }).invocation);

  assert.equal(result.ok, true);
  assert.equal(result.revision.stale, true);
  assert.equal(result.revision.current, NEXT_PRESENTATION_REVISION);
  assert.equal(wire.matching("POST", PRESENTATION).length, 0);
});

test("theme push refuses before any write when the site's presentation moved since the pull", async (site) => {
  const workspace = await fixture(site, themeWorkspace());
  const manifestBefore = await readWorkspaceText(workspace, ".taproot-site-manifest.json");
  const wire = api([
    {
      method: "GET",
      pattern: PRESENTATION,
      reply: presentationReply({
        revision: NEXT_PRESENTATION_REVISION,
        headerSettings: { brandText: "Changed in the app" },
      }),
    },
  ]);

  await assert.rejects(
    themePush(invoke(workspace, wire, { verb: "theme push" }).invocation),
    (error) =>
      error?.code === "theme.concurrent_modification"
      && error?.field === "revision"
      && error?.message.includes("'taproot-site pull'")
      && error?.differences.some((path) => path === "settings/site-header.json:$.brandText"),
  );
  assert.equal(wire.matching("POST", PRESENTATION).length, 0);
  assert.equal(await readWorkspaceText(workspace, ".taproot-site-manifest.json"), manifestBefore);
});

test("theme push refuses a workspace whose manifest records no presentation baseline", async (site) => {
  const files = themeWorkspace();
  delete files[".taproot-site-manifest.json"].presentation;
  const workspace = await fixture(site, files);
  const wire = api([]);

  await assert.rejects(
    themePush(invoke(workspace, wire, { verb: "theme push" }).invocation),
    (error) =>
      error?.code === "theme.pull_required"
      && error?.field === "presentation.revision"
      && error?.message.includes("'taproot-site pull'"),
  );
  assert.equal(wire.calls.length, 0);
});

test("theme push refuses truthfully against a Taproot without the atomic save instead of writing sequentially", async (site) => {
  const workspace = await fixture(site, themeWorkspace());
  const wire = api([
    { method: "GET", pattern: PRESENTATION, reply: () => jsonResponse({ code: 5, message: "not found" }, 404) },
    { method: "GET", pattern: SETTINGS, reply: { sitePublishingPreferences: { footerSettings: {} } } },
    { method: "POST", pattern: FOOTER_SETTINGS, reply: { footerSettings: {} } },
    { method: "POST", pattern: SETTING, reply: {} },
  ]);

  await assert.rejects(
    themePush(invoke(workspace, wire, { verb: "theme push" }).invocation),
    (error) =>
      error?.code === "theme.server_unsupported"
      && error?.field === "presentation"
      && error?.message.includes("does not fall back"),
  );
  assert.equal(wire.calls.filter((call) => call.method === "POST").length, 0);
});

test("theme push maps the site's stale-baseline refusal to pull-and-reconcile guidance without local writes", async (site) => {
  const workspace = await fixture(site, themeWorkspace());
  const beforeSettings = await readWorkspaceText(workspace, "settings/site-publishing-preferences.json");
  const beforeManifest = await readWorkspaceText(workspace, ".taproot-site-manifest.json");
  const wire = api([
    { method: "GET", pattern: PRESENTATION, reply: presentationReply() },
    {
      method: "POST",
      pattern: PRESENTATION,
      reply: () => jsonResponse(violation("ExpectedRevision", "changed after it was read"), 400),
    },
  ]);

  await assert.rejects(
    themePush(invoke(workspace, wire, { verb: "theme push" }).invocation),
    (error) =>
      error?.code === "theme.concurrent_modification"
      && error?.field === "revision"
      && /pull.*re-apply/su.test(error.message),
  );
  assert.equal(wire.matching("POST", PRESENTATION).length, 1);
  assert.equal(await readWorkspaceText(workspace, "settings/site-publishing-preferences.json"), beforeSettings);
  assert.equal(await readWorkspaceText(workspace, ".taproot-site-manifest.json"), beforeManifest);
});

test("theme push maps a footer document race to a retry, not a pull", async (site) => {
  const workspace = await fixture(site, themeWorkspace());
  const wire = api([
    { method: "GET", pattern: PRESENTATION, reply: presentationReply() },
    {
      method: "POST",
      pattern: PRESENTATION,
      reply: () => jsonResponse(violation("ExpectedFooterDraftHash", "changed"), 400),
    },
  ]);

  await assert.rejects(
    themePush(invoke(workspace, wire, { verb: "theme push" }).invocation),
    (error) =>
      error?.code === "theme.footer_concurrent_modification"
      && error?.field === "expectedFooterDraftHash"
      && error?.message.includes("again"),
  );
});

test("theme push accepts an already-current answer as success and refreshes the baseline", async (site) => {
  const workspace = await fixture(site, themeWorkspace());
  const wire = api([
    { method: "GET", pattern: PRESENTATION, reply: presentationReply() },
    {
      method: "POST",
      pattern: PRESENTATION,
      reply: (call) => presentationSaveReply(call, { applied: false, revision: PRESENTATION_REVISION }),
    },
  ]);

  const { invocation, progress } = invoke(workspace, wire, { verb: "theme push" });
  const result = await themePush(invocation);

  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.equal(result.revision, PRESENTATION_REVISION);
  assert.ok(progress.some((line) => line.includes("already held this presentation")));
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.presentation.revision, PRESENTATION_REVISION);
});

test("theme push replays a save whose response was lost and takes the already-current answer", async (site) => {
  const workspace = await fixture(site, themeWorkspace());
  let attempts = 0;
  const wire = api([
    { method: "GET", pattern: PRESENTATION, reply: presentationReply() },
    {
      method: "POST",
      pattern: PRESENTATION,
      reply: (call) => {
        attempts += 1;
        // The first attempt committed on the server and the reply never
        // arrived; the second finds the site already at the new revision.
        if (attempts === 1) throw new Error("connection reset after the save committed");
        return presentationSaveReply(call, { applied: false });
      },
    },
  ]);

  const result = await themePush(invoke(workspace, wire, { verb: "theme push" }).invocation);

  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.equal(result.revision, NEXT_PRESENTATION_REVISION);
  assert.equal(wire.matching("POST", PRESENTATION).length, 2);
  const [first, second] = wire.matching("POST", PRESENTATION);
  assert.deepEqual(first.body, second.body);
  assert.equal((await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).presentation.revision, NEXT_PRESENTATION_REVISION);
});

test("theme push records the save as pending before sending it and clears the record on an answer", async (site) => {
  const workspace = await fixture(site, themeWorkspace());
  let pendingDuringSave;
  const wire = api([
    { method: "GET", pattern: PRESENTATION, reply: presentationReply() },
    {
      method: "POST",
      pattern: PRESENTATION,
      reply: async (call) => {
        pendingDuringSave = (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).presentation.pending;
        return presentationSaveReply(call);
      },
    },
  ]);

  const result = await themePush(invoke(workspace, wire, { verb: "theme push" }).invocation);

  assert.equal(result.ok, true);
  // Written before the request: the baseline it was sent under, the change
  // set's identity, and when.
  assert.equal(pendingDuringSave.expectedRevision, PRESENTATION_REVISION);
  assert.match(pendingDuringSave.changeSetHash, /^[0-9a-f]{64}$/u);
  assert.equal(pendingDuringSave.startedAt, new Date(1_700_000_000_000).toISOString());
  assert.deepEqual(
    (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).presentation,
    { revision: NEXT_PRESENTATION_REVISION },
  );
});

test("theme push replays a pending save of the same change set under its original baseline after the site moved past it", async (site) => {
  // The earlier run's save committed on the server and its response never
  // arrived (the transport's retries were exhausted too), so the site is at
  // the next revision and the workspace still records the baseline the save
  // was sent under. The pending record proves the moved revision is that
  // save's own, not a concurrent edit.
  const workspace = await fixture(site, themeWorkspace());
  const wire = api([
    { method: "GET", pattern: PRESENTATION, reply: presentationReply({ revision: NEXT_PRESENTATION_REVISION }) },
    {
      method: "POST",
      pattern: PRESENTATION,
      reply: (call) => {
        assert.equal(call.body.expectedRevision, PRESENTATION_REVISION);
        return presentationSaveReply(call, { applied: false, revision: NEXT_PRESENTATION_REVISION });
      },
    },
  ]);
  const first = invoke(workspace, wire, { verb: "theme push" });
  // Stand in for the earlier run: the record it wrote before its request.
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  const lostWire = api([
    { method: "GET", pattern: PRESENTATION, reply: presentationReply() },
    { method: "POST", pattern: PRESENTATION, reply: () => { throw new Error("socket hang up"); } },
  ]);
  await assert.rejects(
    themePush(invoke(workspace, lostWire, { verb: "theme push" }).invocation),
    (error) => error?.code === "transport.mutation_ambiguous",
  );
  const pending = (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).presentation.pending;
  assert.equal(pending.expectedRevision, PRESENTATION_REVISION);
  assert.equal(manifest.presentation.pending, undefined);

  const { invocation, progress } = first;
  const result = await themePush(invocation);

  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.equal(result.revision, NEXT_PRESENTATION_REVISION);
  assert.ok(progress.some((line) => line.includes("Replaying the presentation save")));
  assert.deepEqual(
    (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).presentation,
    { revision: NEXT_PRESENTATION_REVISION },
  );
});

test("theme push --dry-run reports a replayable pending save instead of a stale baseline", async (site) => {
  const files = themeWorkspace();
  const workspace = await fixture(site, files);
  const lostWire = api([
    { method: "GET", pattern: PRESENTATION, reply: presentationReply() },
    { method: "POST", pattern: PRESENTATION, reply: () => { throw new Error("socket hang up"); } },
  ]);
  await assert.rejects(themePush(invoke(workspace, lostWire, { verb: "theme push" }).invocation));
  const wire = api([
    { method: "GET", pattern: PRESENTATION, reply: presentationReply({ revision: NEXT_PRESENTATION_REVISION }) },
  ]);

  const { invocation, progress } = invoke(workspace, wire, { verb: "theme push", dryRun: true });
  const result = await themePush(invocation);

  assert.equal(result.revision.stale, true);
  assert.deepEqual(result.pendingSave, { startedAt: new Date(1_700_000_000_000).toISOString(), sameChangeSet: true });
  assert.ok(progress.some((line) => line.includes("would replay it")));
  assert.equal(wire.matching("POST", PRESENTATION).length, 0);
});

test("theme push refuses a stale baseline when the pending save carried a different change set", async (site) => {
  const workspace = await fixture(site, themeWorkspace());
  const lostWire = api([
    { method: "GET", pattern: PRESENTATION, reply: presentationReply() },
    { method: "POST", pattern: PRESENTATION, reply: () => { throw new Error("socket hang up"); } },
  ]);
  await assert.rejects(themePush(invoke(workspace, lostWire, { verb: "theme push" }).invocation));
  // The author edits again before retrying: the pending record no longer
  // describes what is about to be sent, so it proves nothing about the site.
  const header = await readWorkspaceJson(workspace, "settings/site-header.json");
  header.settings.brandText = "Edited after the lost save";
  await writeFile(workspacePath(workspace, "settings/site-header.json"), `${JSON.stringify(header, undefined, 2)}\n`);
  const wire = api([
    { method: "GET", pattern: PRESENTATION, reply: presentationReply({ revision: NEXT_PRESENTATION_REVISION }) },
  ]);

  const { invocation, progress } = invoke(workspace, wire, { verb: "theme push" });
  await assert.rejects(themePush(invocation), (error) => error?.code === "theme.concurrent_modification");

  assert.equal(wire.matching("POST", PRESENTATION).length, 0);
  assert.ok(progress.some((line) => line.includes("different change set")));
});

test("theme push drops the pending record after an authoritative refusal", async (site) => {
  const workspace = await fixture(site, themeWorkspace());
  const wire = api([
    { method: "GET", pattern: PRESENTATION, reply: presentationReply() },
    {
      method: "POST",
      pattern: PRESENTATION,
      reply: () => jsonResponse(violation("ExpectedFooterDraftHash", "changed"), 400),
    },
  ]);

  await assert.rejects(
    themePush(invoke(workspace, wire, { verb: "theme push" }).invocation),
    (error) => error?.code === "theme.footer_concurrent_modification",
  );

  assert.deepEqual(
    (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).presentation,
    { revision: PRESENTATION_REVISION },
  );
});

test("theme push keeps the pending record when the save errs after it may have committed, and replays it", async (site) => {
  // The server commits the presentation before deriving favicon renditions;
  // an error from that derivation arrives as an ordinary response, so the
  // transport does not call it ambiguous — but the revision has moved.
  const workspace = await fixture(site, themeWorkspace());
  let saves = 0;
  const wire = api([
    {
      method: "GET",
      pattern: PRESENTATION,
      reply: () => presentationReply({ revision: saves === 0 ? PRESENTATION_REVISION : NEXT_PRESENTATION_REVISION }),
    },
    {
      method: "POST",
      pattern: PRESENTATION,
      reply: (call) => {
        saves += 1;
        if (saves === 1) return jsonResponse({ code: 9, message: "favicon renditions failed" }, 400);
        assert.equal(call.body.expectedRevision, PRESENTATION_REVISION);
        return presentationSaveReply(call, { applied: false, revision: NEXT_PRESENTATION_REVISION });
      },
    },
  ]);

  const first = invoke(workspace, wire, { verb: "theme push" });
  await assert.rejects(themePush(first.invocation), (error) => error?.httpStatus === 400);
  assert.ok(first.progress.some((line) => line.includes("stays recorded as pending")));
  const pending = (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).presentation.pending;
  assert.equal(pending.expectedRevision, PRESENTATION_REVISION);

  const result = await themePush(invoke(workspace, wire, { verb: "theme push" }).invocation);

  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.deepEqual(
    (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).presentation,
    { revision: NEXT_PRESENTATION_REVISION },
  );
});

test("theme push refuses a workspace still carrying a retired top-level scalar font", async (site) => {
  // TR00728: a workspace pulled before the change can still carry fontBrand at
  // the top level of taproot-styles.json. There is no compatibility read path
  // (the ADR forbids one), so push must refuse rather than silently discard
  // the authored value.
  const workspace = await fixture(site, themeWorkspace({ style: { fontBrand: "Georgia, serif" } }));
  const wire = api([]);

  await assert.rejects(
    themePush(invoke(workspace, wire, { verb: "theme push" }).invocation),
    (error) =>
      error?.code === "appearance.retired_scalar"
      && error?.field === "taproot-styles.fontBrand",
  );
  assert.equal(wire.calls.length, 0);
});

test("theme push succeeds when the same fonts live only inside the per-scheme themes", async (site) => {
  // The default fixture's themes already carry fontBrand/fontMenu (and their
  // weights) inside lightTheme/darkTheme with nothing at the top level of
  // taproot-styles.json, so the retired-scalar refusal above must not
  // misfire on the normal, current-shape workspace.
  const workspace = await fixture(site, themeWorkspace());
  const wire = api([
    { method: "GET", pattern: PRESENTATION, reply: presentationReply() },
    { method: "POST", pattern: PRESENTATION, reply: (call) => presentationSaveReply(call) },
  ]);

  const result = await themePush(invoke(workspace, wire, { verb: "theme push" }).invocation);

  assert.equal(result.ok, true);
});

test("theme push refuses an incomplete pair before the first API call", async (site) => {
  const invalidLight = agentTheme(DEFAULT_SITE_THEME.light.theme);
  delete invalidLight.roles;
  const workspace = await fixture(site, themeWorkspace({ style: { lightTheme: invalidLight } }));
  const wire = api([]);

  await assert.rejects(
    themePush(invoke(workspace, wire, { verb: "theme push" }).invocation),
    (error) => error?.code === "theme.settings_missing" && error?.field === "lightTheme.roles",
  );
  assert.equal(wire.calls.length, 0);
});

test("theme push refuses an image id not proven by pull or media upload before any request", async (site) => {
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

test("theme push reports a remote refusal with no completed writes, because nothing was written", async (site) => {
  const workspace = await fixture(site, themeWorkspace());
  const wire = api([
    { method: "GET", pattern: PRESENTATION, reply: presentationReply() },
    {
      method: "POST",
      pattern: PRESENTATION,
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
  assert.equal(rejected?.completedWrites, undefined);
  assert.equal("completedWrites" in failureResult(rejected).error, false);
});

test("theme push can project stricter stored footer values after its color overlay", async (site) => {
  const workspace = await fixture(site, themeWorkspace());
  const currentFooter = projectFooterSettingsForWorkspace({
    bottomLinks: [{ id: navId(22), label: "Legacy", externalUrl: "https://good.example/a\\b" }],
    asideBodyContent: { paragraphs: [{ runs: [{ text: "Storedtext" }] }] },
  });
  const wire = api([
    { method: "GET", pattern: PRESENTATION, reply: presentationReply({ footerSettings: currentFooter }) },
    {
      method: "POST",
      pattern: PRESENTATION,
      reply: (call) => presentationSaveReply(call, { footerSettings: currentFooter }),
    },
  ]);

  const result = await themePush(invoke(workspace, wire, { verb: "theme push" }).invocation);

  assert.equal(result.ok, true);
  const save = wire.matching("POST", PRESENTATION)[0];
  assert.equal(save.body.expectedFooterDraftHash, computeFooterDraftHash(currentFooter));
  const publishing = await readWorkspaceJson(workspace, "settings/site-publishing-preferences.json");
  assert.equal(publishing.settings.footerSettings.bottomLinks[0].externalUrl, "https://good.example/a\\b");
  assert.equal(
    publishing.settings.footerSettings.asideBodyContent.paragraphs[0].runs[0].text,
    "Storedtext",
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
    { method: "GET", pattern: PRESENTATION, reply: presentationReply({ footerSettings: currentFooter }) },
    {
      method: "POST",
      pattern: PRESENTATION,
      reply: (call) => presentationSaveReply(call, { footerSettings: currentFooter }),
    },
  ]);

  const result = await themePush(invoke(workspace, wire, { verb: "theme push" }).invocation);

  assert.equal(result.ok, true);
  const save = wire.matching("POST", PRESENTATION)[0];
  assert.equal(save.body.footerColors.light.backgroundColor, "#f6efe8");
  assert.equal(save.body.footerColors.dark.headingColor, "oklch(0.9 0.05 330)");
  const written = await readWorkspaceJson(workspace, "settings/site-publishing-preferences.json");
  assert.deepEqual(written.settings.footerSettings.bottomLinks, currentFooter.bottomLinks);
  assert.equal(written.settings.footerSettings.light.backgroundColor, "#f6efe8");
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

test("footer push advances the presentation baseline only when the save replaced the revision it was pulled at", async (site) => {
  const cases = [
    // The save replaced the recorded baseline: the workspace's appearance
    // files are still the site's, and the new revision covers them plus this
    // footer save.
    { previous: PRESENTATION_REVISION, next: NEXT_PRESENTATION_REVISION, expected: NEXT_PRESENTATION_REVISION, warned: false },
    // The save replaced a revision the workspace never pulled: the site's
    // appearance moved unseen, so the baseline stays and theme push refuses
    // toward a pull instead of overwriting that edit.
    { previous: "e".repeat(64), next: "f".repeat(64), expected: PRESENTATION_REVISION, warned: true },
    // A Taproot that predates the fields leaves the baseline alone.
    { previous: undefined, next: undefined, expected: PRESENTATION_REVISION, warned: false },
  ];
  for (const { previous, next, expected, warned } of cases) {
    const footer = authorableFooter();
    const workspace = await fixture(site, {
      ...footerWorkspace(footer),
      ".taproot-site-manifest.json": {
        ...footerWorkspace(footer)[".taproot-site-manifest.json"],
        presentation: presentationManifestEntry(PRESENTATION_REVISION),
      },
    });
    const wire = api([{
      method: "POST",
      pattern: FOOTER_SETTINGS,
      reply: (call) => ({
        footerSettings: call.body.footerSettings,
        ...(next === undefined ? {} : { presentationRevision: next, previousPresentationRevision: previous }),
      }),
    }]);

    const { invocation, progress } = invoke(workspace, wire, { verb: "footer push" });
    const result = await footerPush(invocation);

    assert.equal(result.ok, true);
    const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
    assert.equal(manifest.presentation.revision, expected);
    assert.equal(progress.some((line) => line.includes("presentation baseline was left")), warned);
  }
});

test("footer push does not mint a presentation baseline for a workspace that has none", async (site) => {
  const footer = authorableFooter();
  const workspace = await fixture(site, footerWorkspace(footer));
  const wire = api([{
    method: "POST",
    pattern: FOOTER_SETTINGS,
    reply: (call) => ({
      footerSettings: call.body.footerSettings,
      presentationRevision: NEXT_PRESENTATION_REVISION,
      previousPresentationRevision: PRESENTATION_REVISION,
    }),
  }]);

  const result = await footerPush(invoke(workspace, wire, { verb: "footer push" }).invocation);

  assert.equal(result.ok, true);
  // The workspace's appearance files were pulled at no known revision, so no
  // revision this save reports can vouch for them.
  assert.equal((await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).presentation, undefined);
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
  files[".taproot-site-manifest.json"].presentation = presentationManifestEntry(PRESENTATION_REVISION);
  const workspace = await fixture(site, files);
  let remote = remoteStart;
  let revision = PRESENTATION_REVISION;
  const wire = api([
    {
      method: "GET",
      pattern: PRESENTATION,
      reply: () => presentationReply({ revision, footerSettings: remote }),
    },
    {
      method: "POST",
      pattern: PRESENTATION,
      reply: (call) => {
        assert.equal(call.body.expectedRevision, revision);
        assert.equal(call.body.expectedFooterDraftHash, footerManifestEntry(remote).expectedDraftHash);
        remote = projectFooterSettingsForWorkspace(applyFooterColors(remote, call.body.footerColors));
        revision = NEXT_PRESENTATION_REVISION;
        return { applied: true, presentation: presentationReply({ revision, footerSettings: remote }) };
      },
    },
    {
      method: "POST",
      pattern: FOOTER_SETTINGS,
      reply: (call) => {
        assert.equal(call.body.expectedFooterDraftHash, footerManifestEntry(remote).expectedDraftHash);
        remote = projectFooterSettingsForWorkspace(call.body.footerSettings);
        return { footerSettings: remote, presentationRevision: revision };
      },
    },
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
  files[".taproot-site-manifest.json"].presentation = presentationManifestEntry(PRESENTATION_REVISION);
  const workspace = await fixture(site, files);
  let remote = initial;
  // The footer save moves the presentation revision (its colours are in the
  // change set), reports the new one, and the workspace records it — so the
  // theme push that follows carries a baseline the site still holds.
  let revision = PRESENTATION_REVISION;
  const wire = api([
    {
      method: "GET",
      pattern: PRESENTATION,
      reply: () => presentationReply({ revision, footerSettings: remote }),
    },
    {
      method: "POST",
      pattern: PRESENTATION,
      reply: (call) => {
        assert.equal(call.body.expectedRevision, revision);
        remote = projectFooterSettingsForWorkspace(applyFooterColors(remote, call.body.footerColors));
        revision = "e".repeat(64);
        return { applied: true, presentation: presentationReply({ revision, footerSettings: remote }) };
      },
    },
    {
      method: "POST",
      pattern: FOOTER_SETTINGS,
      reply: (call) => {
        assert.equal(call.body.expectedFooterDraftHash, footerManifestEntry(remote).expectedDraftHash);
        remote = projectFooterSettingsForWorkspace(call.body.footerSettings);
        const previousPresentationRevision = revision;
        revision = NEXT_PRESENTATION_REVISION;
        return { footerSettings: remote, presentationRevision: revision, previousPresentationRevision };
      },
    },
  ]);

  const document_ = await readWorkspaceJson(workspace, "settings/site-publishing-preferences.json");
  document_.settings.footerSettings.bottomContent.paragraphs[0].runs[0].text = "Footer content first";
  await writeFile(
    workspacePath(workspace, "settings/site-publishing-preferences.json"),
    `${JSON.stringify(document_, undefined, 2)}\n`,
  );
  await footerPush(invoke(workspace, wire, { verb: "footer push" }).invocation);
  assert.equal(
    (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).presentation.revision,
    NEXT_PRESENTATION_REVISION,
  );

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
  await touchPulledSources(workspace);

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
        pages: [pageSummary({
          pageId: ABOUT_PAGE_ID,
          bodyRevision: reportedRevision(),
          authorRef: state.authorRef,
          // A page that credits someone shows their name, which an empty
          // authorRef alone cannot say.
          ...(state.authorRef || state.authorDisplayName
            ? { authorDisplayName: state.authorDisplayName ?? state.authorRef }
            : {}),
        })],
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
        // The site only ever fills an empty author, as the real one does (TR01196).
        if (call.body.author !== undefined && state.authorRef === undefined) state.authorRef = call.body.author;
        return draftSummary(call.body.pageId, call.body.path, {
          bodyRevision: reportedRevision(),
          authorRef: state.authorRef,
        });
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
  assert.equal(manifest.manifestVersion, 7);
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
  assert.equal(
    (await readWorkspaceJson(workspace, ABOUT_BASELINE_FILE)).content[0].content[0].text,
    "edited on the site",
  );
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

test("pages push warns about autolinks only in the pages it sends, real push included (TR01198)", async (site) => {
  const autolinked = (text) => ({
    type: "doc",
    content: [{
      type: "paragraph",
      content: [
        { type: "text", text: "ASP.NET", marks: [{ type: "link", attrs: { href: "http://ASP.NET" } }] },
        { type: "text", text },
      ],
    }],
  });
  const workspace = await fixture(site);
  const state = { body: autolinked(" Core") };
  const wire = api(trackedRoutes(state));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  const pushAbout = () =>
    pagesPush(
      invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module }).invocation,
    );
  // Unchanged since the pull: nothing is sent, so nothing is re-reported.
  assert.equal((await pushAbout()).linkWarnings, undefined);
  await writeFile(
    workspacePath(workspace, "pages/about.pm.json"),
    `${JSON.stringify(autolinked(" Core, edited"), undefined, 2)}\n`,
  );
  const pushed = await pushAbout();
  assert.equal(pushed.pages.updated, 1);
  assert.deepEqual(pushed.linkWarnings.items.map((item) => [item.file, item.text]), [["pages/about.pm.json", "ASP.NET"]]);
});

test("pages meta set changes a .pm.json page's description, pull keeps it, and push sends it (TR01194)", async (site) => {
  const workspace = await fixture(site);
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api(trackedRoutes(state));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  const set = await VERB_HANDLERS["pages meta set"](
    invoke(workspace, wire, { verb: "pages meta set", metaPagePath: "/about/", metaDescription: "Small classes." })
      .invocation,
  );
  assert.equal(set.changed, true);
  assert.deepEqual(set.page, {
    path: "about",
    file: "pages/about.pm.json",
    title: "About us",
    description: "Small classes.",
  });
  assert.equal(set.nextStep, "pages push");

  // The site has not moved, so a pull keeps the local edit rather than
  // restoring the site's description.
  const { invocation, progress } = invoke(workspace, wire, { verb: "pull" });
  await pull(invocation);
  const entry = () => readWorkspaceJson(workspace, ".taproot-site-manifest.json")
    .then((manifest) => manifest.pages.find((page) => page.pageId === ABOUT_PAGE_ID));
  assert.equal((await entry()).description, "Small classes.");
  assert.ok(progress.some((line) => line.includes("Kept the local title, path and description")));

  await pagesPush(
    invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module }).invocation,
  );
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).at(-1).body.shortDescription, "Small classes.");
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  assert.equal((await entry()).description, "Small classes.");
});

test("a local metadata edit conflicts with a site edit instead of being overwritten (TR01194)", async (site) => {
  const workspace = await fixture(site);
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api(trackedRoutes(state));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  await VERB_HANDLERS["pages meta set"](
    invoke(workspace, wire, { verb: "pages meta set", metaPagePath: "about", metaTitle: "About the studio" }).invocation,
  );
  state.description = "Edited in the app";
  await assert.rejects(
    pull(invoke(workspace, wire, { verb: "pull" }).invocation),
    (error) => error?.code === "pages.pull_conflict",
  );
});

test("pages meta set refuses what it cannot set and warns on a long description (TR01194)", async (t) => {
  await t.test("a Markdown page points at its front matter", async (site) => {
    const workspace = await fixture(site, {
      ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry()]),
      "pages/about.md": ABOUT_MARKDOWN,
    });
    await assert.rejects(
      VERB_HANDLERS["pages meta set"](
        invoke(workspace, api([]), { verb: "pages meta set", metaPagePath: "about", metaTitle: "X" }).invocation,
      ),
      (error) => error?.code === "pages.meta_markdown",
    );
  });
  await t.test("an unknown path is named", async (site) => {
    const workspace = await fixture(site, { ".taproot-site-manifest.json": manifestFixture([]) });
    await assert.rejects(
      VERB_HANDLERS["pages meta set"](
        invoke(workspace, api([]), { verb: "pages meta set", metaPagePath: "nowhere", metaTitle: "X" }).invocation,
      ),
      (error) => error?.code === "pages.meta_page_unknown" && error?.field === "nowhere",
    );
  });
  await t.test("over 1000 characters is refused; over 160 is warned about", async (site) => {
    const workspace = await fixture(site);
    const wire = api(trackedRoutes({ body: paragraphDocument(BODY_MARKER) }));
    await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
    await assert.rejects(
      VERB_HANDLERS["pages meta set"](
        invoke(workspace, wire, { verb: "pages meta set", metaPagePath: "about", metaDescription: "x".repeat(1001) })
          .invocation,
      ),
      (error) => error?.code === "pages.description_too_long",
    );
    const { invocation, progress } = invoke(workspace, wire, {
      verb: "pages meta set",
      metaPagePath: "about",
      metaDescription: "x".repeat(161),
    });
    const result = await VERB_HANDLERS["pages meta set"](invocation);
    assert.equal(result.descriptionWarnings.items[0].length, 161);
    assert.ok(progress.some((line) => line.includes("search results show about 160")));
  });
});

test("pages meta set from the command line reaches the workspace, trimmed (TR01194)", async (site) => {
  const workspace = await fixture(site);
  const wire = api(trackedRoutes({ body: paragraphDocument(BODY_MARKER) }));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  const set = await cliRun(workspace, [
    "pages",
    "meta",
    "set",
    "about",
    "--title",
    "  About the studio ",
    "--description",
    "Small classes.",
  ], wire);
  assert.equal(set.exitCode, 0, set.stderr);
  assert.equal(set.result.changed, true);
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  const entry = manifest.pages.find((page) => page.pageId === ABOUT_PAGE_ID);
  assert.deepEqual([entry.title, entry.description], ["About the studio", "Small classes."]);
});

test("pages meta set refuses an empty request and a page whose source is gone (TR01194)", async (site) => {
  const workspace = await fixture(site);
  const wire = api(trackedRoutes({ body: paragraphDocument(BODY_MARKER) }));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  await assert.rejects(
    VERB_HANDLERS["pages meta set"](invoke(workspace, wire, { verb: "pages meta set", metaPagePath: "about" }).invocation),
    (error) => error?.code === "pages.meta_nothing_to_set",
  );
  await rm(workspacePath(workspace, "pages/about.pm.json"));
  await assert.rejects(
    VERB_HANDLERS["pages meta set"](
      invoke(workspace, wire, { verb: "pages meta set", metaPagePath: "about", metaTitle: "X" }).invocation,
    ),
    (error) => error?.code === "pages.meta_source_missing",
  );
});

test("a metadata-only conflict says the title, path or description moved, not the file (TR01194)", async (site) => {
  const workspace = await fixture(site);
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api(trackedRoutes(state));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  await VERB_HANDLERS["pages meta set"](
    invoke(workspace, wire, { verb: "pages meta set", metaPagePath: "about", metaDescription: "Mine" }).invocation,
  );
  state.body = paragraphDocument("edited in the app");
  await assert.rejects(
    pull(invoke(workspace, wire, { verb: "pull" }).invocation),
    (error) =>
      error?.code === "pages.pull_conflict"
      && error.message.includes("pages meta set")
      && error.message.includes("drops the local title, path and description"),
  );
  // The refusal says the site's version is preserved; it must be the new one.
  assert.equal(
    (await readWorkspaceJson(workspace, ABOUT_BASELINE_FILE)).content[0].content[0].text,
    "edited in the app",
  );
});

test("pages meta set refuses a page this workspace has not reconciled (TR01194)", async (site) => {
  const workspace = await fixture(site);
  const wire = api(trackedRoutes({ body: paragraphDocument(BODY_MARKER) }));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  delete manifest.pages.find((page) => page.pageId === ABOUT_PAGE_ID).baseline;
  await writeFile(
    workspacePath(workspace, ".taproot-site-manifest.json"),
    `${JSON.stringify(manifest, undefined, 2)}\n`,
  );
  await assert.rejects(
    VERB_HANDLERS["pages meta set"](
      invoke(workspace, wire, { verb: "pages meta set", metaPagePath: "about", metaTitle: "X" }).invocation,
    ),
    (error) => error?.code === "pages.meta_unreconciled",
  );
});

test("a metadata edit survives a pull that cannot read the site's body (TR01194)", async (site) => {
  const workspace = await fixture(site);
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api(trackedRoutes(state));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  await VERB_HANDLERS["pages meta set"](
    invoke(workspace, wire, { verb: "pages meta set", metaPagePath: "about", metaDescription: "Mine" }).invocation,
  );
  const readable = state.body;
  state.body = null;
  const unreadable = invoke(workspace, wire, { verb: "pull" });
  await pull(unreadable.invocation);
  assert.ok(unreadable.progress.some((line) => line.includes("has no readable body")));
  state.body = readable;
  const { invocation, progress } = invoke(workspace, wire, { verb: "pull" });
  await pull(invocation);
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.pages.find((page) => page.pageId === ABOUT_PAGE_ID).description, "Mine");
  assert.ok(progress.some((line) => line.includes("Kept the local title, path and description")));
});

test("a site title adopted while a body edit is kept is not later read as a local edit (TR01194)", async (site) => {
  const workspace = await fixture(site);
  // A Taproot that reports no revision compares bodies only, so a title moved
  // on the site is adopted beside the kept body edit.
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api(trackedRoutes(state, { reportsRevision: false }));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  await writeFile(
    workspacePath(workspace, "pages/about.pm.json"),
    `${JSON.stringify(paragraphDocument("edited here"), undefined, 2)}\n`,
  );
  state.title = "Retitled in the app";
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  const { invocation, progress } = invoke(workspace, wire, { verb: "pull" });
  await pull(invocation);
  assert.ok(!progress.some((line) => line.includes("Kept the local title, path and description")));
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.pages.find((page) => page.pageId === ABOUT_PAGE_ID).title, "Retitled in the app");
});

test("an over-long description refuses only a page the push sends (TR01194)", async (site) => {
  const workspace = await fixture(site);
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api(trackedRoutes(state));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  await writeFile(
    workspacePath(workspace, "pages/notes.md"),
    `---\ntitle: Notes\npath: notes\ndescription: ${"x".repeat(1001)}\n---\n\nText.\n`,
  );
  await writeFile(
    workspacePath(workspace, "pages/about.pm.json"),
    `${JSON.stringify(paragraphDocument("edited here"), undefined, 2)}\n`,
  );
  const pushed = await pagesPush(
    invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module }).invocation,
  );
  assert.equal(pushed.pages.updated, 1);
  await assert.rejects(
    pagesPush(invoke(workspace, wire, { verb: "pages push", content: contentStub().module }).invocation),
    (error) =>
      [error?.code, ...(error?.problems ?? []).map((problem) => problem.code)].includes("pages.description_too_long"),
  );
});

// ---------------------------------------------------------------------------
// TR01195 — generated pages are update-only sources
// ---------------------------------------------------------------------------

const TAG_PAGE_ID = "55555555-aaaa-4aaa-8aaa-555555555555";
const TAG_ID = "0198a3f2-7c4e-4a10-9b2d-3f6e5d4c3b2a";

/** The text of a document's first paragraph, the way the site derives a generated page's description from an introduction. */
function firstParagraphText(document_) {
  const paragraph = (document_?.content ?? []).find((node) => node.type === "paragraph");
  return (paragraph?.content ?? []).map((node) => node.text ?? "").join("");
}

/**
 * One generated tag page whose stored state the test owns, and the PATCH that edits it.
 *
 * It behaves as the site does: the title and description a read reports are
 * derived (the custom value, else the introduction's first paragraph, else the
 * system default) and whatever a caller sends for them is ignored; the system's
 * own title and default are output-only fields; and the body revision leaves
 * those two fields out.
 */
function generatedRoutes(state) {
  state.title ??= "Trails";
  state.description ??= "Pages tagged with Trails.";
  state.data ??= {
    kind: "GENERATED_PAGE_KIND_TAG",
    tagId: TAG_ID,
    customTitle: "",
    breadcrumbTitle: "",
    customDescription: "",
    introductionBody: { type: "doc", content: [] },
    generatedTitle: "Trails",
    generatedDescription: "Pages tagged with Trails.",
  };
  const revision = () => {
    const { generatedTitle: _title, generatedDescription: _description, ...owned } = state.data;
    return `v1:${createHash("sha256").update(JSON.stringify([state.title, state.description, owned])).digest("hex")}`;
  };
  // What a deploy's synchronizer does: recompute the derived title and description.
  state.recompute = () => {
    state.title = state.data.customTitle.trim() || state.data.generatedTitle;
    state.description = state.data.customDescription.trim()
      || firstParagraphText(state.data.introductionBody)
      || state.data.generatedDescription;
  };
  const listing = () => ({
    pages: state.retired === true ? [] : [pageSummary({
      pageId: state.pageId ?? TAG_PAGE_ID,
      path: "tags/trails",
      title: state.title,
      templateType: "TEMPLATE_TYPE_GENERATED",
      isGenerated: true,
      bodyRevision: revision(),
    })],
    nextPageToken: "",
  });
  return [
    { method: "GET", pattern: PAGES_LIST, reply: listing },
    {
      method: "GET",
      pattern: PAGE_BY_ID,
      reply: () => ({
        pageId: state.pageId ?? TAG_PAGE_ID,
        status: "PAGE_STATUS_PUBLISHED",
        title: state.title,
        path: "tags/trails",
        shortDescription: state.description,
        bodyRevision: revision(),
        isGenerated: true,
        template: {
          templateType: "TEMPLATE_TYPE_GENERATED",
          templateVersion: "1.0.0",
          // An unreadable body is a read whose generated data is missing.
          ...(state.unreadable === true ? {} : { generatedPageData: state.data }),
        },
      }),
    },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    { method: "GET", pattern: SETTINGS, reply: {} },
    {
      method: "PATCH",
      pattern: PAGE_BY_ID,
      reply: (call) => {
        state.data = {
          ...call.body.template.generatedPageData,
          generatedTitle: state.data.generatedTitle,
          generatedDescription: state.data.generatedDescription,
        };
        state.recompute();
        return draftSummary(call.body.pageId, call.body.path, {
          title: state.title,
          templateType: "TEMPLATE_TYPE_GENERATED",
          bodyRevision: revision(),
        });
      },
    },
  ];
}

const TAG_SOURCE = "pages/tags/trails.pm.json";

async function pullGeneratedTag(site, state = {}) {
  const workspace = await fixture(site);
  const wire = api(generatedRoutes(state));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  return { workspace, wire, state };
}

const pushTag = (workspace, wire, extra = {}) =>
  pagesPush(
    invoke(workspace, wire, { verb: "pages push", pagePaths: ["tags/trails"], content: contentStub().module, ...extra })
      .invocation,
  );

test("pull writes a generated page as an editable source with its identity recorded (TR01195)", async (site) => {
  const { workspace } = await pullGeneratedTag(site);

  assert.deepEqual(await readWorkspaceJson(workspace, TAG_SOURCE), {
    template: "generated",
    data: {
      kind: "GENERATED_PAGE_KIND_TAG",
      tagId: TAG_ID,
      year: 0,
      month: 0,
      countryCode: "",
      regionCode: "",
      citySlug: "",
      categorySlug: "",
      customTitle: "",
      breadcrumbTitle: "",
      customDescription: "",
    },
  });
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  const entry = manifest.pages.find((page) => page.pageId === TAG_PAGE_ID);
  assert.equal(entry.workspaceMode, "editable");
  assert.equal(entry.file, TAG_SOURCE);
  assert.equal(entry.templateType, "TEMPLATE_TYPE_GENERATED");
  // What the site reports is recorded for reference; the owner's own values are in the document.
  assert.equal(entry.title, "Trails");
  assert.equal(entry.description, "Pages tagged with Trails.");
  assert.equal(entry.generated.kind, "GENERATED_PAGE_KIND_TAG");
  assert.equal(entry.generated.tagId, TAG_ID);
});

test("a generated page's description and introduction round-trip through pull, edit and push (TR01195)", async (site) => {
  const { workspace, wire, state } = await pullGeneratedTag(site);
  const document_ = await readWorkspaceJson(workspace, TAG_SOURCE);
  document_.data.customDescription = "Field notes from the trails I walk most often.";
  document_.data.introductionBody = paragraphDocument("Everything I have written about walking.");
  await writeFile(workspacePath(workspace, TAG_SOURCE), `${JSON.stringify(document_, undefined, 2)}\n`);

  const pushed = await pushTag(workspace, wire);

  assert.equal(pushed.pages.updated, 1);
  const sent = wire.matching("PATCH", PAGE_BY_ID).at(-1).body;
  assert.equal(sent.pageId, TAG_PAGE_ID);
  assert.equal(sent.path, "tags/trails");
  // No custom title, so the title the site reported is sent back unchanged.
  assert.equal(sent.title, "Trails");
  assert.equal(sent.shortDescription, "Field notes from the trails I walk most often.");
  assert.equal(sent.template.templateType, "TEMPLATE_TYPE_GENERATED");
  assert.deepEqual(sent.template.generatedPageData, {
    kind: "GENERATED_PAGE_KIND_TAG",
    tagId: TAG_ID,
    year: 0,
    month: 0,
    countryCode: "",
    regionCode: "",
    citySlug: "",
    categorySlug: "",
    customTitle: "",
    breadcrumbTitle: "",
    customDescription: "Field notes from the trails I walk most often.",
    introductionBody: paragraphDocument("Everything I have written about walking."),
  });
  assert.equal("displayDate" in sent, false);
  assert.equal("coverImageId" in sent, false);
  assert.equal(state.data.customDescription, "Field notes from the trails I walk most often.");

  // The push recorded what it sent, so the next pull keeps the document and the next push has nothing to send.
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  const after = await readWorkspaceJson(workspace, TAG_SOURCE);
  assert.equal(after.data.customDescription, "Field notes from the trails I walk most often.");
  assert.deepEqual(after.data.introductionBody, paragraphDocument("Everything I have written about walking."));
  const again = await pushTag(workspace, wire);
  assert.equal(again.pages.unchanged, 1);
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 1);
});

test("a custom generated title is sent as the title, and an empty one falls back to the reported title (TR01195)", async (site) => {
  const { workspace, wire } = await pullGeneratedTag(site);
  const document_ = await readWorkspaceJson(workspace, TAG_SOURCE);
  document_.data.customTitle = "Trail notes";
  await writeFile(workspacePath(workspace, TAG_SOURCE), `${JSON.stringify(document_, undefined, 2)}\n`);
  await pushTag(workspace, wire);
  const sent = wire.matching("PATCH", PAGE_BY_ID).at(-1).body;
  assert.equal(sent.title, "Trail notes");
  assert.equal(sent.template.templateType, "TEMPLATE_TYPE_GENERATED");
  assert.equal(sent.template.generatedPageData.customTitle, "Trail notes");
  // The description is the one the site reported: the owner wrote none.
  assert.equal(sent.shortDescription, "Pages tagged with Trails.");
});

test("a padded custom title the site trimmed leaves an untouched generated page unchanged (TR01195)", async (site) => {
  const state = {};
  generatedRoutes(state);
  state.data = { ...state.data, customTitle: "  Trail notes  " };
  state.recompute();
  const { workspace, wire } = await pullGeneratedTag(site, state);
  const pushed = await pushTag(workspace, wire);
  assert.equal(pushed.pages.unchanged, 1);
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
});

test("a push refuses to create, move, or re-identify a generated page (TR01195)", async (t) => {
  await t.test("a source whose page the site no longer has is not created", async (site) => {
    const { workspace } = await pullGeneratedTag(site);
    const wire = api([
      { method: "GET", pattern: PAGES_LIST, reply: { pages: [], nextPageToken: "" } },
      ...pushRoutes({ live: [] }).slice(1),
    ]);
    await assert.rejects(
      pushTag(workspace, wire),
      (error) => error?.code === "pages.generated_create" && error?.field === TAG_SOURCE,
    );
    assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
  });
  await t.test("a different path is a move", async (site) => {
    const { workspace, wire } = await pullGeneratedTag(site);
    const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
    manifest.pages.find((page) => page.pageId === TAG_PAGE_ID).path = "tags/hikes";
    await writeFile(workspacePath(workspace, ".taproot-site-manifest.json"), `${JSON.stringify(manifest, undefined, 2)}\n`);
    await assert.rejects(
      pushTag(workspace, wire, { pagePaths: ["tags/hikes"] }),
      (error) => error?.code === "pages.generated_move",
    );
    assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
  });
  await t.test("changing the kind or an identity field is refused, naming the field", async (site) => {
    const { workspace, wire } = await pullGeneratedTag(site);
    const document_ = await readWorkspaceJson(workspace, TAG_SOURCE);
    document_.data.kind = "GENERATED_PAGE_KIND_TAGS_INDEX";
    document_.data.tagId = "";
    await writeFile(workspacePath(workspace, TAG_SOURCE), `${JSON.stringify(document_, undefined, 2)}\n`);
    await assert.rejects(
      pushTag(workspace, wire),
      (error) => error?.code === "pages.generated_identity" && error.message.includes("kind, tagId"),
    );
    assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
  });
  await t.test("a Markdown source cannot declare the generated template", async (site) => {
    const { workspace, wire } = await pullGeneratedTag(site);
    await writeFile(
      workspacePath(workspace, "pages/hand-made.md"),
      "---\ntitle: Hand made\npath: hand-made\ntemplate: generated\n---\n\nHello.\n",
    );
    await assert.rejects(
      pagesPush(
        invoke(workspace, wire, {
          verb: "pages push",
          pagePaths: ["hand-made"],
          content: contentStub().module,
        }).invocation,
      ),
      (error) => error?.code === "pages.generated_markdown",
    );
  });
  await t.test("a custom description over 1000 characters is refused, and over 160 is warned about", async (site) => {
    const { workspace, wire } = await pullGeneratedTag(site);
    const document_ = await readWorkspaceJson(workspace, TAG_SOURCE);
    document_.data.customDescription = "x".repeat(1001);
    await writeFile(workspacePath(workspace, TAG_SOURCE), `${JSON.stringify(document_, undefined, 2)}\n`);
    await assert.rejects(pushTag(workspace, wire), (error) => error?.code === "pages.description_too_long");

    document_.data.customDescription = "x".repeat(161);
    await writeFile(workspacePath(workspace, TAG_SOURCE), `${JSON.stringify(document_, undefined, 2)}\n`);
    const pushed = await pushTag(workspace, wire);
    assert.equal(pushed.descriptionWarnings.items[0].length, 161);
  });
  await t.test("a stale reported description is not warned about when the owner wrote none", async (site) => {
    const { workspace, wire } = await pullGeneratedTag(site, { description: "y".repeat(400) });
    const document_ = await readWorkspaceJson(workspace, TAG_SOURCE);
    document_.data.customTitle = "Trail notes";
    await writeFile(workspacePath(workspace, TAG_SOURCE), `${JSON.stringify(document_, undefined, 2)}\n`);
    const pushed = await pushTag(workspace, wire);
    assert.equal(pushed.pages.updated, 1);
    assert.equal(pushed.descriptionWarnings, undefined);
  });
});

test("a generated page's server-only title and default description are neither pulled nor sent (TR01195)", async (site) => {
  const { workspace, wire } = await pullGeneratedTag(site);
  const pulled = await readWorkspaceJson(workspace, TAG_SOURCE);
  assert.equal("generatedTitle" in pulled.data, false);
  assert.equal("generatedDescription" in pulled.data, false);

  pulled.data.customDescription = "Field notes.";
  await writeFile(workspacePath(workspace, TAG_SOURCE), `${JSON.stringify(pulled, undefined, 2)}\n`);
  await pushTag(workspace, wire);
  const sent = wire.matching("PATCH", PAGE_BY_ID).at(-1).body.template.generatedPageData;
  assert.equal("generatedTitle" in sent, false);
  assert.equal("generatedDescription" in sent, false);
});

test("an introduction-only edit leaves the next push unrefused once the site recomputes its description (TR01195)", async (site) => {
  const { workspace, wire, state } = await pullGeneratedTag(site);
  const document_ = await readWorkspaceJson(workspace, TAG_SOURCE);
  document_.data.introductionBody = paragraphDocument("Everything I have written about walking.");
  await writeFile(workspacePath(workspace, TAG_SOURCE), `${JSON.stringify(document_, undefined, 2)}\n`);
  const first = await pushTag(workspace, wire);
  assert.equal(first.pages.updated, 1);
  // The site derived the description from the introduction when it saved the draft.
  assert.equal(state.description, "Everything I have written about walking.");

  // A deploy's synchronizer recomputes the description; the draft already holds it.
  const revisionBefore = (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).pages
    .find((page) => page.pageId === TAG_PAGE_ID).baseline.revision;
  state.recompute();

  document_.data.customDescription = "Field notes.";
  await writeFile(workspacePath(workspace, TAG_SOURCE), `${JSON.stringify(document_, undefined, 2)}\n`);
  const second = await pushTag(workspace, wire);

  assert.equal(second.pages.updated, 1);
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 2);
  assert.notEqual(
    (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).pages.find((page) => page.pageId === TAG_PAGE_ID)
      .baseline.revision,
    revisionBefore,
  );
});

test("an untouched generated page never blocks a whole-workspace push (TR01195)", async (t) => {
  const handMade = "---\ntitle: Hand made\npath: hand-made\n---\n\nHello.\n";
  const routes = (state, extra = []) => [
    ...extra,
    ...generatedRoutes(state),
    { method: "POST", pattern: PAGES_COLLECTION, reply: (call) => draftSummary(NEW_PAGE_ID, call.body.path) },
  ];
  const wholePush = (workspace, wire) =>
    pagesPush(invoke(workspace, wire, { verb: "pages push", content: contentStub().module }).invocation);

  await t.test("its revision moved because the site renamed the tag", async (site) => {
    const { workspace, state } = await pullGeneratedTag(site);
    await writeFile(workspacePath(workspace, "pages/hand-made.md"), handMade);
    state.data = { ...state.data, generatedTitle: "Hikes", generatedDescription: "Pages tagged with Hikes." };
    state.recompute();
    const wire = api(routes(state));

    const pushed = await wholePush(workspace, wire);

    assert.equal(pushed.pages.created, 1);
    assert.equal(pushed.pages.unchanged, 1);
    assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
  });
  await t.test("but one the push sends still refuses a revision that moved", async (site) => {
    const { workspace, state } = await pullGeneratedTag(site);
    const document_ = await readWorkspaceJson(workspace, TAG_SOURCE);
    document_.data.customDescription = "Mine.";
    await writeFile(workspacePath(workspace, TAG_SOURCE), `${JSON.stringify(document_, undefined, 2)}\n`);
    state.data = { ...state.data, introductionBody: paragraphDocument("Theirs.") };
    state.recompute();
    const wire = api(routes(state));

    await assert.rejects(wholePush(workspace, wire), (error) =>
      [error?.code, ...(error?.problems ?? []).map((problem) => problem.code)].includes("pages.push_conflict"));
    assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
  });
  await t.test("its page is gone: reported, nothing sent, and the other pages still go", async (site) => {
    const { workspace, state } = await pullGeneratedTag(site);
    await writeFile(workspacePath(workspace, "pages/hand-made.md"), handMade);
    state.retired = true;
    const wire = api(routes(state));
    const progressWire = invoke(workspace, wire, { verb: "pages push", content: contentStub().module });

    const pushed = await pagesPush(progressWire.invocation);

    assert.equal(pushed.pages.created, 1);
    assert.deepEqual(pushed.pages.staleGeneratedSources, {
      total: 1,
      items: [{ file: TAG_SOURCE, path: "tags/trails" }],
    });
    assert.ok(progressWire.progress.some((line) => line.includes(TAG_SOURCE) && line.includes("Delete the file")));
    assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);

    // A dry run reports it too.
    const dry = await pagesPush(
      invoke(workspace, wire, { verb: "pages push", dryRun: true, content: contentStub().module }).invocation,
    );
    assert.equal(dry.pages.staleGeneratedSources.total, 1);

    // So does a pull, which will not delete the authored file.
    const pulling = invoke(workspace, wire, { verb: "pull" });
    await pull(pulling.invocation);
    assert.ok(pulling.progress.some((line) => line.includes(TAG_SOURCE) && line.includes("no longer has")));
    assert.equal(await workspaceHas(workspace, TAG_SOURCE), true);

    // After that pull, and the next, the file is still known: a whole push
    // reports it and sends the rest instead of refusing it as an unknown
    // raw document, and naming its path is still refused.
    await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
    const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
    assert.deepEqual(manifest.retiredGeneratedSources, [{ pageId: TAG_PAGE_ID, file: TAG_SOURCE, path: "tags/trails" }]);
    assert.equal(manifest.pages.some((page) => page.file === TAG_SOURCE), false);
    await writeFile(workspacePath(workspace, "pages/hand-made.md"), handMade.replace("Hello", "Hello again"));
    const afterPull = await pagesPush(
      invoke(workspace, wire, { verb: "pages push", content: contentStub().module }).invocation,
    );
    assert.equal(afterPull.pages.staleGeneratedSources.total, 1);
    await assert.rejects(pushTag(workspace, wire), (error) => error?.code === "pages.generated_create");
    // validate reads the same record (the mock site's settings fail it for
    // reasons of their own, so only this file's handling is asserted).
    const validated = await cliRun(workspace, ["validate"]);
    assert.ok(validated.stderr.includes(`'${TAG_SOURCE}' is the source of a generated page the site no longer has`));
    assert.ok(!validated.stderr.includes("pages.metadata_missing"), validated.stderr);

    // Deleting the file ends the record.
    await rm(workspacePath(workspace, TAG_SOURCE));
    await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
    assert.equal(
      (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).retiredGeneratedSources,
      undefined,
    );
  });
  await t.test("its page is gone and the path was asked for: refused", async (site) => {
    const { workspace, state } = await pullGeneratedTag(site);
    state.retired = true;
    const wire = api(routes(state));

    await assert.rejects(
      pushTag(workspace, wire),
      (error) => error?.code === "pages.generated_create" && error?.field === TAG_SOURCE,
    );
    assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
    assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
  });
});

test("a generated page recreated at a retired page's path never writes over its source (TR01195)", async (site) => {
  const { workspace, state } = await pullGeneratedTag(site);
  const document_ = await readWorkspaceJson(workspace, TAG_SOURCE);
  document_.data.customDescription = "Unpushed words.";
  const edited = `${JSON.stringify(document_, undefined, 2)}\n`;
  await writeFile(workspacePath(workspace, TAG_SOURCE), edited);

  // Retired and recreated between two pulls: a new page id at the same path.
  const recreatedId = "6f2d7c1e-3a4b-4c5d-8e9f-0a1b2c3d4e5f";
  state.pageId = recreatedId;
  const wire = api(generatedRoutes(state));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  assert.equal(await readFile(workspacePath(workspace, TAG_SOURCE), "utf8"), edited);
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.deepEqual(manifest.retiredGeneratedSources, [{ pageId: TAG_PAGE_ID, file: TAG_SOURCE, path: "tags/trails" }]);
  const recreated = manifest.pages.find((page) => page.pageId === recreatedId);
  assert.equal(recreated.file, `pages/${recreatedId}.pm.json`);

  // A push by that path sends the new page's own source.
  const pushed = await pushTag(workspace, wire);
  assert.equal(pushed.pages.unchanged, 1);
});

test("a bounded listing keeps a generated source it cannot see, and a full one gives it back (TR01195)", async (site) => {
  const { workspace, state } = await pullGeneratedTag(site);
  const document_ = await readWorkspaceJson(workspace, TAG_SOURCE);
  document_.data.customDescription = "Unpushed words.";
  const edited = `${JSON.stringify(document_, undefined, 2)}\n`;
  await writeFile(workspacePath(workspace, TAG_SOURCE), edited);

  // A listing the CLI cannot finish: it shows a page created at the tag's
  // path with a new id, and not the tracked one.
  const recreatedId = "6f2d7c1e-3a4b-4c5d-8e9f-0a1b2c3d4e5f";
  const filler = (index) =>
    pageSummary({
      pageId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      path: `legal-${index}`,
      templateType: "TEMPLATE_TYPE_LEGAL",
    });
  let calls = 0;
  const bounded = {
    method: "GET",
    pattern: PAGES_LIST,
    reply: () => {
      calls += 1;
      return {
        pages: calls === 1
          ? [pageSummary({
            pageId: recreatedId,
            path: "tags/trails",
            title: "Trails",
            templateType: "TEMPLATE_TYPE_GENERATED",
            isGenerated: true,
          })]
          : [filler(calls)],
        nextPageToken: "more",
      };
    },
  };
  const boundedState = { ...state, pageId: recreatedId };
  const boundedWire = api([bounded, ...generatedRoutes(boundedState).slice(1)]);
  const boundedPull = invoke(workspace, boundedWire, { verb: "pull" });
  await pull(boundedPull.invocation);
  assert.equal(await readFile(workspacePath(workspace, TAG_SOURCE), "utf8"), edited);
  assert.ok(boundedPull.progress.some((line) => line.includes("bounded listing did not include")));
  assert.deepEqual(
    (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).retiredGeneratedSources,
    [{ pageId: TAG_PAGE_ID, file: TAG_SOURCE, path: "tags/trails" }],
  );

  // The full listing has the tracked page after all: it takes its file back,
  // and the unpushed edit is kept rather than replaced by the site's copy.
  const fullWire = api(generatedRoutes(state));
  await pull(invoke(workspace, fullWire, { verb: "pull" }).invocation);
  assert.equal(await readFile(workspacePath(workspace, TAG_SOURCE), "utf8"), edited);
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.pages.find((page) => page.pageId === TAG_PAGE_ID).file, TAG_SOURCE);
  // The page the bounded listing showed is the one this listing lacks now.
  assert.deepEqual(manifest.retiredGeneratedSources, [
    { pageId: recreatedId, file: `pages/${recreatedId}.pm.json`, path: "tags/trails" },
  ]);
});

test("a first pull over a manifest that held generated pages as metadata only writes their sources cleanly (TR01195)", async (site) => {
  const state = {};
  const workspace = await fixture(site);
  const routes = generatedRoutes(state);
  // The workspace tracks an ordinary page whose file was renamed onto the name the generated page would prefer.
  const trackedFile = TAG_SOURCE;
  const tracked = { body: paragraphDocument(BODY_MARKER), path: "about" };
  const aboutRoutes = trackedRoutes(tracked);
  const combined = api([
    {
      method: "GET",
      pattern: PAGES_LIST,
      reply: () => ({
        pages: [
          pageSummary({ pageId: ABOUT_PAGE_ID, bodyRevision: siteRevision(tracked) }),
          ...routes[0].reply().pages,
        ],
        nextPageToken: "",
      }),
    },
    {
      method: "GET",
      pattern: new RegExp(`^/api/v1/pages/${ABOUT_PAGE_ID}$`, "u"),
      reply: aboutRoutes[1].reply,
    },
    ...routes.slice(1),
  ]);
  await pull(invoke(workspace, combined, { verb: "pull" }).invocation);
  // Rewrite what that pull recorded into what an older CLI left: the generated page metadata only, no source.
  const manifestFile = ".taproot-site-manifest.json";
  const manifest = await readWorkspaceJson(workspace, manifestFile);
  const generatedEntry = manifest.pages.find((page) => page.pageId === TAG_PAGE_ID);
  for (const key of ["file", "sourceFormat", "baseline", "generated"]) delete generatedEntry[key];
  generatedEntry.workspaceMode = "metadata-only";
  await writeFile(workspacePath(workspace, manifestFile), `${JSON.stringify(manifest, undefined, 2)}\n`);
  await rm(workspacePath(workspace, TAG_SOURCE), { force: true });
  // And the ordinary page's tracked source now sits where the generated page would go.
  const aboutEntry = manifest.pages.find((page) => page.pageId === ABOUT_PAGE_ID);
  const aboutBytes = await readFile(workspacePath(workspace, aboutEntry.file));
  await mkdir(path.dirname(workspacePath(workspace, trackedFile)), { recursive: true });
  await writeFile(workspacePath(workspace, trackedFile), aboutBytes);
  await rm(workspacePath(workspace, aboutEntry.file), { force: true });
  aboutEntry.file = trackedFile;
  await writeFile(workspacePath(workspace, manifestFile), `${JSON.stringify(manifest, undefined, 2)}\n`);

  const result = await pull(invoke(workspace, combined, { verb: "pull" }).invocation);

  assert.equal(result.ok, true);
  const after = await readWorkspaceJson(workspace, manifestFile);
  const aboutAfter = after.pages.find((page) => page.pageId === ABOUT_PAGE_ID);
  const tagAfter = after.pages.find((page) => page.pageId === TAG_PAGE_ID);
  assert.equal(aboutAfter.file, trackedFile);
  assert.equal(tagAfter.workspaceMode, "editable");
  assert.equal(tagAfter.file, `pages/${TAG_PAGE_ID}.pm.json`);
  assert.equal(tagAfter.generated.tagId, TAG_ID);
  assert.deepEqual(await readFile(workspacePath(workspace, trackedFile)), aboutBytes);
  assert.equal((await readWorkspaceJson(workspace, tagAfter.file)).template, "generated");
});

test("a generated page's identity is carried through a pull that cannot read its body, and a push without it is refused (TR01195)", async (site) => {
  const { workspace, wire, state } = await pullGeneratedTag(site);
  const manifestFile = ".taproot-site-manifest.json";
  const recorded = (await readWorkspaceJson(workspace, manifestFile)).pages.find((page) => page.pageId === TAG_PAGE_ID)
    .generated;

  state.unreadable = true;
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  const kept = (await readWorkspaceJson(workspace, manifestFile)).pages.find((page) => page.pageId === TAG_PAGE_ID);
  assert.deepEqual(kept.generated, recorded);
  assert.equal(kept.file, TAG_SOURCE);

  // A manifest entry with no record cannot prove what the file is, so an edit to its identity would pass.
  state.unreadable = false;
  const manifest = await readWorkspaceJson(workspace, manifestFile);
  delete manifest.pages.find((page) => page.pageId === TAG_PAGE_ID).generated;
  await writeFile(workspacePath(workspace, manifestFile), `${JSON.stringify(manifest, undefined, 2)}\n`);
  const document_ = await readWorkspaceJson(workspace, TAG_SOURCE);
  document_.data.customDescription = "Mine.";
  await writeFile(workspacePath(workspace, TAG_SOURCE), `${JSON.stringify(document_, undefined, 2)}\n`);
  await assert.rejects(
    pushTag(workspace, wire),
    (error) => error?.code === "pages.generated_identity" && error.message.includes("pull"),
  );
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
});

test("pages meta set edits a generated page's own title and description in its source (TR01195)", async (site) => {
  const { workspace, wire } = await pullGeneratedTag(site);

  const set = await VERB_HANDLERS["pages meta set"](
    invoke(workspace, wire, {
      verb: "pages meta set",
      metaPagePath: "tags/trails",
      metaTitle: "Trail notes",
      metaDescription: "  Field notes.  ",
    }).invocation,
  );
  assert.equal(set.changed, true);
  assert.deepEqual(set.page, {
    path: "tags/trails",
    file: TAG_SOURCE,
    title: "Trail notes",
    description: "Field notes.",
    generated: true,
  });
  const document_ = await readWorkspaceJson(workspace, TAG_SOURCE);
  assert.equal(document_.data.customTitle, "Trail notes");
  assert.equal(document_.data.customDescription, "Field notes.");
  // The manifest keeps what the site reported.
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.pages.find((page) => page.pageId === TAG_PAGE_ID).title, "Trails");

  await pushTag(workspace, wire);
  const sent = wire.matching("PATCH", PAGE_BY_ID).at(-1).body;
  assert.equal(sent.title, "Trail notes");
  assert.equal(sent.shortDescription, "Field notes.");

  // An empty value clears the custom one, back to the generated default.
  const cleared = await VERB_HANDLERS["pages meta set"](
    invoke(workspace, wire, {
      verb: "pages meta set",
      metaPagePath: "tags/trails",
      metaTitle: "",
      metaDescription: "",
    }).invocation,
  );
  assert.equal(cleared.changed, true);
  assert.equal((await readWorkspaceJson(workspace, TAG_SOURCE)).data.customDescription, "");
  assert.equal((await readWorkspaceJson(workspace, TAG_SOURCE)).data.customTitle, "");
  const unchanged = await VERB_HANDLERS["pages meta set"](
    invoke(workspace, wire, { verb: "pages meta set", metaPagePath: "tags/trails", metaDescription: "" }).invocation,
  );
  assert.equal(unchanged.changed, false);

  // The 160-character warning and the 1000-character refusal apply here too.
  await assert.rejects(
    VERB_HANDLERS["pages meta set"](
      invoke(workspace, wire, {
        verb: "pages meta set",
        metaPagePath: "tags/trails",
        metaDescription: "x".repeat(1001),
      }).invocation,
    ),
    (error) => error?.code === "pages.description_too_long",
  );
  const warned = await VERB_HANDLERS["pages meta set"](
    invoke(workspace, wire, {
      verb: "pages meta set",
      metaPagePath: "tags/trails",
      metaDescription: "x".repeat(161),
    }).invocation,
  );
  assert.equal(warned.descriptionWarnings.items[0].length, 161);
});

test("pages meta set will not empty an ordinary page's title (TR01195)", async (site) => {
  const workspace = await fixture(site);
  const wire = api(trackedRoutes({ body: paragraphDocument(BODY_MARKER) }));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  await assert.rejects(
    VERB_HANDLERS["pages meta set"](
      invoke(workspace, wire, { verb: "pages meta set", metaPagePath: "about", metaTitle: " " }).invocation,
    ),
    (error) => error?.code === "pages.meta_title_empty",
  );
});

test("a local edit to a generated page survives a pull and conflicts with a site change (TR01195)", async (site) => {
  const { workspace, wire, state } = await pullGeneratedTag(site);
  await VERB_HANDLERS["pages meta set"](
    invoke(workspace, wire, { verb: "pages meta set", metaPagePath: "tags/trails", metaDescription: "Mine." })
      .invocation,
  );
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  assert.equal((await readWorkspaceJson(workspace, TAG_SOURCE)).data.customDescription, "Mine.");

  state.data = { ...state.data, customDescription: "Theirs." };
  await assert.rejects(
    pull(invoke(workspace, wire, { verb: "pull" }).invocation),
    (error) => error?.code === "pages.pull_conflict" && error?.field === TAG_SOURCE,
  );
});

test("a hand-edited manifest title for a generated page is not local work to keep (TR01195)", async (site) => {
  const { workspace, wire } = await pullGeneratedTag(site);
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  manifest.pages.find((page) => page.pageId === TAG_PAGE_ID).title = "Edited by hand";
  await writeFile(workspacePath(workspace, ".taproot-site-manifest.json"), `${JSON.stringify(manifest, undefined, 2)}\n`);

  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  const refreshed = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(refreshed.pages.find((page) => page.pageId === TAG_PAGE_ID).title, "Trails");
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
  // Nothing changed between the two pushes, so the second sends nothing.
  assert.equal(second.pages.updated, 0);
  assert.equal(second.pages.unchanged, 1);
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 1);
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
        template: {
          templateType: "TEMPLATE_TYPE_FREE_FORM",
          templateVersion: "1.0",
          freeFormData: { body: state.body },
        },
      }),
    },
    ...trackedRoutes(state),
  ]);
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  const entry = manifest.pages.find((candidate) => candidate.pageId === ABOUT_PAGE_ID);
  assert.equal(entry.title, "Renamed on the site");
  assert.equal(entry.path, "about-us");
  await touchPulledSources(workspace);

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
        template: {
          templateType: "TEMPLATE_TYPE_FREE_FORM",
          templateVersion: "1.0",
          freeFormData: { body: state.body },
        },
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
  assert.equal(manifest.manifestVersion, 7);
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
  await touchPulledSources(workspace);

  await pagesPush(invoke(workspace, wire, { verb: "pages push", content: contentStub().module }).invocation);
  assert.equal(wire.matching("PATCH", PAGE_BY_ID)[0].body.title, longTitle);
});

test("TR00621 pull-to-push tracks the system 404 as an editable page beside four canonical drafts", {
  skip: MONOREPO_ONLY,
}, async (site) => {
  const workspace = await fixture(site);
  const ordinaryPages = [
    pageSummary({ pageId: HOME_PAGE_ID, path: "", title: "Taproot", status: "PAGE_STATUS_DRAFT", hasDraft: true }),
    pageSummary({
      pageId: ABOUT_PAGE_ID,
      path: "about",
      title: "About Taproot",
      status: "PAGE_STATUS_DRAFT",
      hasDraft: true,
    }),
    pageSummary({
      pageId: STORY_PAGE_ID,
      path: "pricing",
      title: "Pricing",
      status: "PAGE_STATUS_DRAFT",
      hasDraft: true,
    }),
    pageSummary({
      pageId: PUBLISHING_PAGE_ID,
      path: "publishing",
      title: "Publishing",
      status: "PAGE_STATUS_DRAFT",
      hasDraft: true,
    }),
  ];
  const notFound = pageSummary({
    pageId: NOT_FOUND_PAGE_ID,
    path: "404",
    title: "Not found",
    status: "PAGE_STATUS_DRAFT",
    hasDraft: true,
    isGenerated: true,
  });
  const livePages = [...ordinaryPages, notFound];
  const wire = api([
    { method: "GET", pattern: PAGES_LIST, reply: { pages: livePages, nextPageToken: "" } },
    {
      method: "GET",
      pattern: PAGE_BY_ID,
      reply: (call) => {
        const pageId = call.pathname.split("/").pop();
        if (pageId === NOT_FOUND_PAGE_ID) {
          return { ...freeFormPageDetail(pageId, "Nothing rooted here yet."), title: "Not found" };
        }
        return freeFormPageDetail(pageId, `pulled body ${pageId}`);
      },
    },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    { method: "GET", pattern: SETTINGS, reply: {} },
    { method: "PATCH", pattern: PAGE_BY_ID, reply: (call) => draftSummary(call.body.pageId, call.body.path) },
  ]);

  const pulled = await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  assert.equal(Object.hasOwn(pulled.pages, "readOnly"), false);
  // Results spell the home page '/', as plan does; the manifest keeps "" (TR01192).
  assert.ok(pulled.pages.items.some((item) => item.pageId === HOME_PAGE_ID && item.path === "/"));
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  const notFoundEntry = manifest.pages.find((entry) => entry.pageId === NOT_FOUND_PAGE_ID);
  assert.deepEqual(
    { file: notFoundEntry.file, path: notFoundEntry.path, workspaceMode: notFoundEntry.workspaceMode },
    { file: "pages/404.pm.json", path: "404", workspaceMode: "editable" },
  );
  assert.match(notFoundEntry.baseline.sourceHash, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(Object.hasOwn(notFoundEntry, "readOnlyReason"), false);
  assert.equal(Object.hasOwn(notFoundEntry, "workspaceContentHash"), false);

  // The complete unchanged pull is executable: every page validates, and none
  // is sent, because nothing changed since the pull.
  const unchanged = await pagesPush(
    invoke(workspace, wire, {
      verb: "pages push",
      content: REAL_CONTENT,
    }).invocation,
  );
  assert.equal(unchanged.pages.updated, 0);
  assert.equal(unchanged.pages.unchanged, 5);
  assert.equal(Object.hasOwn(unchanged.pages, "skippedReadOnly"), false);
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);

  // Reproduce the dogfood edit: replace the four ordinary pulled sources with
  // the checked-in Taproot-www Markdown fixture and edit the 404 in place, then
  // push the whole workspace again. The real converter and validator exercise
  // tables, sections, inline facts, and component documents.
  const currentManifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  for (const pagePath of TAPROOT_WWW_PAGE_PATHS) {
    const entry = currentManifest.pages.find((candidate) => candidate.path === pagePath);
    await rm(workspacePath(workspace, entry.file));
    await writeFile(
      workspacePath(workspace, `pages/${TAPROOT_WWW_PAGE_FILES[pagePath]}`),
      TAPROOT_WWW_PAGE_SOURCES[pagePath],
    );
  }
  await writeFile(
    workspacePath(workspace, "pages/404.pm.json"),
    `${JSON.stringify(paragraphDocument("This page wandered off."), undefined, 2)}\n`,
  );
  // The pages name their media by path, recorded in the fixture's media manifest.
  await writeFile(
    workspacePath(workspace, ".taproot-site-media.json"),
    `${JSON.stringify({ ...TAPROOT_WWW_MEDIA, siteId: SITE_ID }, undefined, 2)}\n`,
  );
  const styles = structuredClone(TAPROOT_WWW_STYLES);
  styles.entityId = SITE_ID;
  await writeFile(
    workspacePath(workspace, "settings/taproot-styles.json"),
    `${JSON.stringify(styles, undefined, 2)}\n`,
  );

  const dogfood = await pagesPush(
    invoke(workspace, wire, {
      verb: "pages push",
      content: REAL_CONTENT,
    }).invocation,
  );
  assert.equal(dogfood.pages.updated, 5);
  const dogfoodPatches = wire.matching("PATCH", PAGE_BY_ID).slice(-5);
  assert.deepEqual(
    dogfoodPatches.map((call) => call.body.path).sort(),
    [...TAPROOT_WWW_PAGE_PATHS, "404"].sort(),
  );
  const notFoundPatch = dogfoodPatches.find((call) => call.body.pageId === NOT_FOUND_PAGE_ID);
  assert.match(JSON.stringify(notFoundPatch.body), /This page wandered off\./u);
  // Pull and both pushes each resolve the site's page list instead of trusting
  // fixture ids without a current site-bound lookup.
  assert.equal(wire.matching("GET", PAGES_LIST).length, 3);
});

test("pull re-pulls a version-6 read-only 404 projection as an ordinary editable page", async (site) => {
  // Version 6 wrote the system 404 as a hash-checked read-only projection with
  // no baseline, holding the site's then-current rawHtml body. The owner has
  // since converted the page on the site.
  const retiredSource = {
    type: "doc",
    content: [{ type: "rawHtml", attrs: { html: "<p>Old stored markup</p>" } }],
  };
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([{
      pageId: NOT_FOUND_PAGE_ID,
      resourceId: resourceIdFor(NOT_FOUND_PAGE_ID),
      path: "404",
      title: "Not found",
      description: "",
      status: "PAGE_STATUS_PUBLISHED",
      templateType: "TEMPLATE_TYPE_FREE_FORM",
      file: "pages/404.pm.json",
      workspaceMode: "read-only",
      readOnlyReason: "system-404",
      workspaceContentHash: `sha256:${"0".repeat(64)}`,
    }], { manifestVersion: 6 }),
    "pages/404.pm.json": `${JSON.stringify(retiredSource, undefined, 2)}\n`,
  });
  const wire = api([
    {
      method: "GET",
      pattern: PAGES_LIST,
      reply: {
        pages: [pageSummary({ pageId: NOT_FOUND_PAGE_ID, path: "404", title: "Not found", isGenerated: true })],
        nextPageToken: "",
      },
    },
    {
      method: "GET",
      pattern: PAGE_BY_ID,
      reply: { ...freeFormPageDetail(NOT_FOUND_PAGE_ID, "Converted not-found body."), title: "Not found" },
    },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    { method: "GET", pattern: SETTINGS, reply: {} },
    { method: "PATCH", pattern: PAGE_BY_ID, reply: (call) => draftSummary(call.body.pageId, call.body.path) },
  ]);

  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.manifestVersion, 7);
  const entry = manifest.pages.find((candidate) => candidate.pageId === NOT_FOUND_PAGE_ID);
  assert.equal(entry.file, "pages/404.pm.json");
  assert.equal(entry.workspaceMode, "editable");
  assert.equal(Object.hasOwn(entry, "readOnlyReason"), false);
  assert.equal(Object.hasOwn(entry, "workspaceContentHash"), false);
  assert.match(entry.baseline.sourceHash, /^sha256:[0-9a-f]{64}$/u);
  assert.match(entry.baseline.remoteHash, /^sha256:[0-9a-f]{64}$/u);
  const pulledSource = await readWorkspaceJson(workspace, "pages/404.pm.json");
  assert.match(JSON.stringify(pulledSource), /Converted not-found body\./u);
  assert.doesNotMatch(JSON.stringify(pulledSource), /rawHtml/u);

  // Once the author edits it, the next whole-workspace push sends the page like
  // any other rather than refusing on the retired markup the author never touched.
  await touchPulledSources(workspace);
  const pushed = await pagesPush(
    invoke(workspace, wire, { verb: "pages push", content: REAL_CONTENT }).invocation,
  );
  assert.equal(pushed.pages.updated, 1);
  const patches = wire.matching("PATCH", PAGE_BY_ID);
  assert.deepEqual(patches.map((call) => call.body.pageId), [NOT_FOUND_PAGE_ID]);
  assert.match(JSON.stringify(patches[0].body), /Converted not-found body\./u);
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
  assert.equal(Object.hasOwn(result, "allowRawHtml"), false);
  assert.equal(result.nextStep, "approve");

  // Every document is validated before the first mutation leaves the process:
  // the server checks a free-form body only for presence, so a half-validated
  // push would leave a half-broken site behind.
  assert.equal(content.calls.validate.length, 2);

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
      reply: () => jsonResponse({ code: 14, details: [{ fieldViolations: [{ field: "SiteAuthoringRollout" }] }] }, 503),
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

test("a selection may name the system 404, which pushes like any tracked page", async (site) => {
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
        workspaceMode: "editable",
      },
    ]),
    "pages/404.pm.json": `${JSON.stringify(paragraphDocument("system 404"), undefined, 2)}\n`,
    "pages/about.md": ABOUT_MARKDOWN,
  });
  const wire = api(pushRoutes({
    live: [
      pageSummary({ pageId: ABOUT_PAGE_ID, path: "about", title: "About us" }),
      pageSummary({ pageId: NOT_FOUND_PAGE_ID, path: "404", title: "Not found" }),
    ],
  }));

  const result = await pagesPush(
    invoke(workspace, wire, { verb: "pages push", pagePaths: ["404"], content: contentStub().module }).invocation,
  );

  assert.equal(result.pages.updated, 1);
  const patches = wire.matching("PATCH", PAGE_BY_ID);
  assert.deepEqual(patches.map((call) => [call.body.pageId, call.body.path]), [[NOT_FOUND_PAGE_ID, "404"]]);
  assert.match(JSON.stringify(patches[0].body), /system 404/u);
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
    {
      label: "an unsupported field",
      block: "---\ntitle: A copy\npath: about\nbogus: x\n---\n\nBody.\n",
      code: "pages.front_matter_unknown",
    },
    {
      label: "a malformed line",
      block: "---\ntitle: A copy\npath: about\nnot a pair\n---\n\nBody.\n",
      code: "pages.front_matter_invalid",
    },
    {
      label: "a duplicated title",
      block: "---\ntitle: A copy\npath: about\ntitle: Again\n---\n\nBody.\n",
      code: "pages.front_matter_duplicate",
    },
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

// ---------------------------------------------------------------------------
// TR00893 — every authored content type, not only free-form pages
// ---------------------------------------------------------------------------

const TYPED_PLACE_ID = "0198a3f2-7c4e-4a10-9b2d-3f6e5d4c3b2a";
const TYPED_COVER_ID = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const TYPED_ALBUM_IMAGE_ID = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const TYPED_SOURCES = {
  "pages/story.md": "---\ntitle: The story\npath: blog/story\ntemplate: article\ndisplayDate: 2019-02-03\n"
    + "coverImage: media/cover.jpg\n---\n\nOnce upon a time.\n\n![Cover](media/cover.jpg)\n",
  "pages/lemon-bars.md":
    "---\ntitle: Lemon bars\npath: recipes/lemon-bars\ntemplate: recipe\nservings: 16\n---\n\nTart.\n\n"
    + "## Ingredients\n\n- 4 eggs\n\n## Instructions\n\n1. Bake.\n",
  "pages/trip.md":
    "---\ntitle: The trip\npath: albums/trip\ntemplate: album\n---\n\n## Images\n\n![Sunrise](media/one.jpg)\n",
  "pages/cafe.md":
    `---\ntitle: Cafe\npath: reviews/cafe\ntemplate: place-review\nplaceId: ${TYPED_PLACE_ID}\nrating: will-return\n---\n\nGreat.\n`,
};
const TYPED_MEDIA_MANIFEST = {
  mediaManifestVersion: 2,
  siteId: SITE_ID,
  media: {
    "media/cover.jpg": { imageId: TYPED_COVER_ID, width: 1600, height: 900, alt: "Cover" },
    "media/one.jpg": { imageId: TYPED_ALBUM_IMAGE_ID, width: 1200, height: 800, alt: "One" },
  },
};

function typedCreateRoutes(live = []) {
  let created = 0;
  return [
    { method: "GET", pattern: PAGES_LIST, reply: { pages: live, nextPageToken: "" } },
    {
      method: "POST",
      pattern: PAGES_COLLECTION,
      reply: (call) => {
        created += 1;
        return draftSummary(`5555555${created}-5555-4555-8555-555555555555`, call.body.path, {
          templateType: call.body.template.templateType,
        });
      },
    },
    { method: "PATCH", pattern: PAGE_BY_ID, reply: (call) => draftSummary(call.body.pageId, call.body.path) },
  ];
}

test("pages push creates an article, a recipe, an album, and a place review with their own templates", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([]),
    ".taproot-site-media.json": TYPED_MEDIA_MANIFEST,
    ...TYPED_SOURCES,
  });
  const wire = api(typedCreateRoutes());
  const result = await pagesPush(invoke(workspace, wire, { verb: "pages push", content: REAL_CONTENT }).invocation);

  assert.equal(result.pages.created, 4);
  const byPath = new Map(wire.matching("POST", PAGES_COLLECTION).map((call) => [call.body.path, call.body]));
  const article = byPath.get("blog/story");
  assert.equal(article.template.templateType, "TEMPLATE_TYPE_ARTICLE");
  assert.equal(article.template.articleData.body.type, "doc");
  assert.equal(article.displayDate, "2019-02-03");
  assert.equal(article.coverImageId, TYPED_COVER_ID);

  const recipe = byPath.get("recipes/lemon-bars");
  assert.equal(recipe.template.templateType, "TEMPLATE_TYPE_RECIPE");
  assert.equal(recipe.template.recipeData.servings, 16);
  assert.equal(recipe.template.recipeData.ingredientGroups[0].ingredients[0].rawText, "4 eggs");
  assert.equal(recipe.template.recipeData.instructionSections[0].stepBodies.length, 1);
  assert.equal("displayDate" in recipe, false, "an unstated date is left to the first publication");

  const album = byPath.get("albums/trip");
  assert.equal(album.template.templateType, "TEMPLATE_TYPE_ALBUM");
  assert.deepEqual(album.template.albumData.images, [
    { imageId: TYPED_ALBUM_IMAGE_ID, caption: "Sunrise", width: 1200, height: 800 },
  ]);

  const review = byPath.get("reviews/cafe");
  assert.equal(review.template.templateType, "TEMPLATE_TYPE_PLACE_REVIEW");
  assert.equal(review.template.placeReviewData.rating, "PLACE_REVIEW_RATING_WILL_RETURN");
  assert.equal(review.template.placeReviewData.placeId, TYPED_PLACE_ID);

  // The manifest records each page's own type so a later push targets it.
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.deepEqual(
    manifest.pages.map((entry) => [entry.path, entry.templateType]).sort(),
    [
      ["albums/trip", "TEMPLATE_TYPE_ALBUM"],
      ["blog/story", "TEMPLATE_TYPE_ARTICLE"],
      ["recipes/lemon-bars", "TEMPLATE_TYPE_RECIPE"],
      ["reviews/cafe", "TEMPLATE_TYPE_PLACE_REVIEW"],
    ],
  );
  wire.assertQueryContracts();
});

test("pull writes each authored type as a document, and a pull-edit-push cycle sends only the edit", async (site) => {
  const workspace = await fixture(site, { ".taproot-site-media.json": TYPED_MEDIA_MANIFEST });
  const pages = [
    ["blog/story", "TEMPLATE_TYPE_ARTICLE", {
      articleData: {
        body: {
          type: "doc",
          content: [
            ...paragraphDocument("Once upon a time.").content,
            { type: "taprootImage", attrs: { imageId: TYPED_COVER_ID, src: "", urls: [], width: 1600, height: 900, alt: "Cover" } },
          ],
        },
      },
    }],
    ["recipes/lemon-bars", "TEMPLATE_TYPE_RECIPE", {
      recipeData: {
        ingredientGroups: [{ ingredients: [{ rawText: "4 eggs" }] }],
        instructionSections: [{ stepBodies: [paragraphDocument("Bake.")] }],
        servings: 16,
      },
    }],
    ["albums/trip", "TEMPLATE_TYPE_ALBUM", {
      albumData: {
        images: [{ imageId: TYPED_ALBUM_IMAGE_ID, caption: "Sunrise", width: 1200, height: 800, urls: [{ url: "https://cdn.example/x.webp", minWidth: 640 }] }],
      },
    }],
    ["reviews/cafe", "TEMPLATE_TYPE_PLACE_REVIEW", {
      placeReviewData: {
        placeId: TYPED_PLACE_ID,
        rating: "PLACE_REVIEW_RATING_MIGHT_RETURN",
        body: paragraphDocument("Fine."),
        placeName: "Cafe",
      },
    }],
  ].map(([pagePath, templateType, data], index) => ({
    summary: pageSummary({
      pageId: `6666666${index}-6666-4666-8666-666666666666`,
      path: pagePath,
      title: pagePath,
      templateType,
      ...(pagePath === "blog/story" ? { displayDate: "2019-02-03" } : {}),
    }),
    templateType,
    data,
  }));
  const detail = (call) => {
    const page = pages.find(({ summary }) => call.pathname.endsWith(`/${summary.pageId}`));
    return {
      pageId: page.summary.pageId,
      title: page.summary.title,
      path: page.summary.path,
      displayDate: page.summary.path === "blog/story" ? "2019-02-03" : undefined,
      coverImageId: page.summary.path === "blog/story" ? TYPED_COVER_ID : undefined,
      template: { templateType: page.templateType, templateVersion: "1.0.0", ...page.data },
    };
  };
  const routes = [
    { method: "GET", pattern: PAGES_LIST, reply: { pages: pages.map(({ summary }) => summary), nextPageToken: "" } },
    { method: "GET", pattern: PAGE_BY_ID, reply: detail },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    { method: "GET", pattern: SETTINGS, reply: {} },
    { method: "PATCH", pattern: PAGE_BY_ID, reply: (call) => draftSummary(call.body.pageId, call.body.path) },
  ];
  const wire = api(routes);
  const pulled = await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  assert.equal(pulled.pages.bodies, 4);

  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.deepEqual(
    manifest.pages.map((entry) => [entry.path, entry.workspaceMode, entry.sourceFormat]),
    pages.map(({ summary }) => [summary.path, "editable", "prosemirror"]),
  );
  const storyFile = manifest.pages[0].file;
  const story = await readWorkspaceJson(workspace, storyFile);
  assert.deepEqual(Object.keys(story), ["template", "displayDate", "coverImageId", "data"]);
  assert.equal(story.displayDate, "2019-02-03");
  const albumFile = manifest.pages[2].file;
  assert.deepEqual((await readWorkspaceJson(workspace, albumFile)).data.images, [
    { imageId: TYPED_ALBUM_IMAGE_ID, caption: "Sunrise", width: 1200, height: 800 },
  ]);
  const reviewFile = manifest.pages[3].file;
  assert.equal((await readWorkspaceJson(workspace, reviewFile)).data.rating, "might-return");

  // A second pull over unchanged pages rewrites nothing.
  const before = await Promise.all(manifest.pages.map((entry) => readWorkspaceText(workspace, entry.file)));
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  assert.deepEqual(
    await Promise.all(manifest.pages.map((entry) => readWorkspaceText(workspace, entry.file))),
    before,
  );

  // Edit one page's text; push the workspace. Every page is sent back as the
  // site holds it, and only the edited one differs.
  const edited = structuredClone(story);
  edited.data.body.content[0].content[0].text = "Twice upon a time.";
  await writeWorkspaceFile(workspace.workspaceDir, storyFile, Buffer.from(`${JSON.stringify(edited, undefined, 2)}\n`));
  const pushWire = api(routes);
  await pagesPush(invoke(workspace, pushWire, { verb: "pages push", content: REAL_CONTENT }).invocation);
  const sent = new Map(pushWire.matching("PATCH", PAGE_BY_ID).map((call) => [call.body.path, call.body]));
  // Only the edited page is sent; the other three are unchanged since the pull.
  assert.deepEqual([...sent.keys()], ["blog/story"]);
  assert.equal(sent.get("blog/story").template.articleData.body.content[0].content[0].text, "Twice upon a time.");
  assert.equal(sent.get("blog/story").displayDate, "2019-02-03");
  assert.equal(sent.get("blog/story").coverImageId, TYPED_COVER_ID);
  // Edit every source, and each page reaches the wire as the site holds it: only
  // defaults added, and the server-derived delivery URLs left off.
  await touchPulledSources(workspace);
  const everyWire = api(routes);
  await pagesPush(invoke(workspace, everyWire, { verb: "pages push", content: REAL_CONTENT }).invocation);
  const every = new Map(everyWire.matching("PATCH", PAGE_BY_ID).map((call) => [call.body.path, call.body]));
  for (const { summary, templateType, data } of pages.slice(1)) {
    const body = every.get(summary.path);
    assert.equal(body.template.templateType, templateType);
    const [dataKey] = Object.keys(data);
    // The site's template data reaches the wire with only defaults added and
    // the server-derived delivery URLs left off.
    assert.equal(body.template[dataKey].placeName, undefined);
    assert.equal(JSON.stringify(body.template[dataKey]).includes("cdn.example"), false);
  }
});

test("a display date changed on the site is not overwritten by a stale local copy", async (site) => {
  const workspace = await fixture(site, {});
  const state = { displayDate: "2019-02-03" };
  const summary = () => pageSummary({ pageId: STORY_PAGE_ID, path: "blog/story", title: "Story", templateType: "TEMPLATE_TYPE_ARTICLE", displayDate: state.displayDate });
  const routes = [
    { method: "GET", pattern: PAGES_LIST, reply: () => ({ pages: [summary()], nextPageToken: "" }) },
    {
      method: "GET",
      pattern: PAGE_BY_ID,
      // The revision does not move with the date: the server's revision covers
      // the body, title, path, description and cover, but not the date.
      reply: () => ({
        pageId: STORY_PAGE_ID,
        title: "Story",
        path: "blog/story",
        bodyRevision: `v2:${"a".repeat(64)}`,
        displayDate: state.displayDate,
        template: { templateType: "TEMPLATE_TYPE_ARTICLE", articleData: { body: paragraphDocument("Once.") } },
      }),
    },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    { method: "GET", pattern: SETTINGS, reply: {} },
    { method: "PATCH", pattern: PAGE_BY_ID, reply: (call) => draftSummary(call.body.pageId, call.body.path) },
  ];
  const wire = api(routes);
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.pages[0].baseline.displayDate, "2019-02-03");

  // Someone changes only the date in the app, and the author edits the body.
  state.displayDate = "2021-05-05";
  const document_ = await readWorkspaceJson(workspace, manifest.pages[0].file);
  document_.data.body.content[0].content[0].text = "Twice.";
  await writeWorkspaceFile(workspace.workspaceDir, manifest.pages[0].file, Buffer.from(`${JSON.stringify(document_)}\n`));
  const pushWire = api(routes);
  await assert.rejects(
    pagesPush(invoke(workspace, pushWire, { verb: "pages push", content: REAL_CONTENT }).invocation),
    (error) => error?.code === "pages.push_conflict" && error.alternatives.join() === "2019-02-03,2021-05-05",
  );
  assert.equal(pushWire.matching("PATCH", PAGE_BY_ID).length, 0);

  // pull reports the same movement as a conflict rather than adopting it over the local edit.
  await assert.rejects(
    pull(invoke(workspace, api(routes), { verb: "pull" }).invocation),
    { code: "pages.pull_conflict" },
  );

  // Once the author takes the site's version, the next push goes through.
  await rm(workspacePath(workspace, manifest.pages[0].file));
  await pull(invoke(workspace, api(routes), { verb: "pull" }).invocation);
  const adopted = await readWorkspaceJson(workspace, manifest.pages[0].file);
  assert.equal(adopted.displayDate, "2021-05-05");
  // Adopting the site's version left nothing to send.
  const idleWire = api(routes);
  await pagesPush(invoke(workspace, idleWire, { verb: "pages push", content: REAL_CONTENT }).invocation);
  assert.equal(idleWire.matching("PATCH", PAGE_BY_ID).length, 0);
  await touchPulledSources(workspace);
  const settledWire = api(routes);
  await pagesPush(invoke(workspace, settledWire, { verb: "pages push", content: REAL_CONTENT }).invocation);
  assert.equal(settledWire.matching("PATCH", PAGE_BY_ID)[0].body.displayDate, "2021-05-05");
});

test("after a refused pull, a push overrides only the display date that pull showed", async (site) => {
  const workspace = await fixture(site, {});
  const state = { displayDate: "2019-02-03" };
  const routes = [
    {
      method: "GET",
      pattern: PAGES_LIST,
      reply: () => ({
        pages: [pageSummary({
          pageId: STORY_PAGE_ID,
          path: "blog/story",
          title: "Story",
          templateType: "TEMPLATE_TYPE_ARTICLE",
          displayDate: state.displayDate,
        })],
        nextPageToken: "",
      }),
    },
    {
      method: "GET",
      pattern: PAGE_BY_ID,
      reply: () => ({
        pageId: STORY_PAGE_ID,
        title: "Story",
        path: "blog/story",
        bodyRevision: `v2:${"a".repeat(64)}`,
        displayDate: state.displayDate,
        template: { templateType: "TEMPLATE_TYPE_ARTICLE", articleData: { body: paragraphDocument("Once.") } },
      }),
    },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    { method: "GET", pattern: SETTINGS, reply: {} },
    { method: "PATCH", pattern: PAGE_BY_ID, reply: (call) => draftSummary(call.body.pageId, call.body.path) },
  ];
  await pull(invoke(workspace, api(routes), { verb: "pull" }).invocation);
  const { file } = (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).pages[0];
  const document_ = await readWorkspaceJson(workspace, file);
  document_.data.body.content[0].content[0].text = "Twice.";
  await writeWorkspaceFile(workspace.workspaceDir, file, Buffer.from(`${JSON.stringify(document_)}\n`));

  state.displayDate = "2021-05-05";
  await assert.rejects(pull(invoke(workspace, api(routes), { verb: "pull" }).invocation), {
    code: "pages.pull_conflict",
  });

  // The date moved again after the operator was shown 2021-05-05.
  state.displayDate = "2022-06-06";
  await assert.rejects(
    pagesPush(invoke(workspace, api(routes), { verb: "pages push", content: REAL_CONTENT }).invocation),
    { code: "pages.push_conflict" },
  );

  // The date the refusal showed is the site's again: the documented recovery goes through.
  state.displayDate = "2021-05-05";
  const recovery = api(routes);
  await pagesPush(invoke(workspace, recovery, { verb: "pages push", content: REAL_CONTENT }).invocation);
  assert.equal(recovery.matching("PATCH", PAGE_BY_ID)[0].body.displayDate, "2019-02-03");
});

test("a node the API refuses in an album introduction stops the whole push before any send", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([
      { pageId: NEW_PAGE_ID, path: "albums/trip", title: "Trip", templateType: "TEMPLATE_TYPE_ALBUM", file: "pages/trip.pm.json" },
    ]),
    "pages/story.md": "---\ntitle: Story\npath: blog/story\ntemplate: article\n---\n\nOnce.\n",
    "pages/trip.pm.json": {
      template: "album",
      data: {
        introductionBody: {
          type: "doc",
          content: [{ type: "section", attrs: {}, content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] }],
        },
        images: [{ imageId: TYPED_ALBUM_IMAGE_ID, caption: "", width: 1, height: 1 }],
      },
    },
  });
  const wire = api(typedCreateRoutes([pageSummary({ pageId: NEW_PAGE_ID, path: "albums/trip", templateType: "TEMPLATE_TYPE_ALBUM" })]));
  await assert.rejects(
    pagesPush(invoke(workspace, wire, { verb: "pages push", content: REAL_CONTENT }).invocation),
    { code: "pages.node_unsupported_for_template" },
  );
  assert.equal(wire.matching("POST", PAGES_COLLECTION).length + wire.matching("PATCH", PAGE_BY_ID).length, 0);
});

test("a whole-workspace push sends only the pages whose source changed since the last pull or push", async (site) => {
  const workspace = await fixture(site);
  const summaries = [
    pageSummary({ pageId: HOME_PAGE_ID, path: undefined, title: "Home" }),
    pageSummary({ pageId: ABOUT_PAGE_ID, path: "about", title: "About" }),
    pageSummary({ pageId: STORY_PAGE_ID, path: "story", title: "Story" }),
  ];
  const routes = [
    { method: "GET", pattern: PAGES_LIST, reply: { pages: summaries, nextPageToken: "" } },
    { method: "GET", pattern: PAGE_BY_ID, reply: (call) => freeFormPageDetail(call.pathname.split("/").pop(), BODY_MARKER) },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    { method: "GET", pattern: SETTINGS, reply: {} },
    { method: "PATCH", pattern: PAGE_BY_ID, reply: (call) => draftSummary(call.body.pageId, call.body.path) },
  ];
  await pull(invoke(workspace, api(routes), { verb: "pull" }).invocation);
  const push = async () => {
    const wire = api(routes);
    const result = await pagesPush(invoke(workspace, wire, { verb: "pages push", content: REAL_CONTENT }).invocation);
    return { result, patched: wire.matching("PATCH", PAGE_BY_ID).map((call) => call.body.pageId) };
  };

  // Nothing edited since the pull: nothing is sent, so approved pages stay approved.
  const idle = await push();
  assert.deepEqual(idle.patched, []);
  assert.equal(idle.result.pages.unchanged, 3);
  assert.equal(idle.result.pages.updated, 0);

  // One page edited: exactly that page is sent.
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  const aboutFile = manifest.pages.find((entry) => entry.pageId === ABOUT_PAGE_ID).file;
  const edited = await readWorkspaceJson(workspace, aboutFile);
  edited.content[0].content[0].text = "Edited";
  await writeWorkspaceFile(workspace.workspaceDir, aboutFile, Buffer.from(`${JSON.stringify(edited, undefined, 2)}\n`));
  const one = await push();
  assert.deepEqual(one.patched, [ABOUT_PAGE_ID]);
  assert.equal(one.result.pages.unchanged, 2);

  // The push recorded what it sent, so repeating it sends nothing.
  assert.deepEqual((await push()).patched, []);

  // A manifest-only edit (a .pm.json takes its description from the manifest) is a change.
  const current = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  current.pages.find((entry) => entry.pageId === STORY_PAGE_ID).description = "A new description";
  await writeWorkspaceFile(workspace.workspaceDir, ".taproot-site-manifest.json", Buffer.from(`${JSON.stringify(current)}\n`));
  assert.deepEqual((await push()).patched, [STORY_PAGE_ID]);
});

test("an unchanged Markdown page is skipped, and everything that changes what would be sent brings it back", async (site) => {
  const media = (imageId) => ({
    mediaManifestVersion: 2,
    siteId: SITE_ID,
    media: { "media/hero.png": { imageId, width: 10, height: 10, alt: "Hero", src: "", urls: [] } },
  });
  const markdown = "---\ntitle: About us\npath: about\ndescription: Who we are\n---\n\n![Hero](media/hero.png)\n\nHello.\n";
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry()]),
    ".taproot-site-media.json": media(IMAGE_ID),
    "pages/about.md": markdown,
  });
  const state = { body: paragraphDocument(BODY_MARKER) };
  const routes = trackedRoutes(state);
  await pull(invoke(workspace, api(routes), { verb: "pull" }).invocation);
  const push = async () => {
    const wire = api(routes);
    const result = await pagesPush(invoke(workspace, wire, { verb: "pages push", content: REAL_CONTENT }).invocation);
    return { result, patches: wire.matching("PATCH", PAGE_BY_ID).length };
  };
  assert.equal((await push()).patches, 1, "the first push after a pull of a Markdown source sends it");
  // A later pull keeps the recorded key, so the next push still has nothing to send.
  await pull(invoke(workspace, api(routes), { verb: "pull" }).invocation);
  const idle = await push();
  assert.equal(idle.patches, 0);
  assert.equal(idle.result.pages.unchanged, 1);
  assert.equal(idle.result.nextStep, undefined);
  // A targeted push of an unchanged page sends nothing either.
  const targeted = api(routes);
  await pagesPush(invoke(workspace, targeted, { verb: "pages push", pagePaths: ["about"], content: REAL_CONTENT }).invocation);
  assert.equal(targeted.matching("PATCH", PAGE_BY_ID).length, 0);

  // Re-uploading the image changes the manifest, not the file, and changes what is sent.
  await writeWorkspaceFile(workspace.workspaceDir, ".taproot-site-media.json", Buffer.from(`${JSON.stringify(media("66666666-6666-4666-8666-666666666667"))}\n`));
  assert.equal((await push()).patches, 1);
  assert.equal((await push()).patches, 0);

  // A front-matter edit is a change.
  await writeWorkspaceFile(workspace.workspaceDir, "pages/about.md", Buffer.from(markdown.replace("Who we are", "Who we really are")));
  assert.equal((await push()).patches, 1);

  // A conflict the operator was shown lets the source be reasserted even though it is unchanged.
  const { revision } = (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).pages[0].baseline;
  await writeWorkspaceFile(
    workspace.workspaceDir,
    internalPageObservedRevisionFile(ABOUT_PAGE_ID),
    Buffer.from(JSON.stringify({ pageId: ABOUT_PAGE_ID, revision })),
  );
  assert.equal((await push()).patches, 1);

  // Moving the source to another file re-registers it in the manifest, even with identical bytes.
  await rm(workspacePath(workspace, "pages/about.md"));
  await writeWorkspaceFile(workspace.workspaceDir, "pages/company.md", Buffer.from(markdown.replace("Who we are", "Who we really are")));
  assert.equal((await push()).patches, 1);
  assert.equal((await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).pages[0].file, "pages/company.md");
});

test("a failed send leaves its page unrecorded, so the retry sends it and skips the one that succeeded", async (site) => {
  const workspace = await fixture(site);
  const summaries = [
    pageSummary({ pageId: HOME_PAGE_ID, path: undefined, title: "Home" }),
    pageSummary({ pageId: ABOUT_PAGE_ID, path: "about", title: "About" }),
  ];
  let failHome = true;
  const routes = [
    { method: "GET", pattern: PAGES_LIST, reply: { pages: summaries, nextPageToken: "" } },
    { method: "GET", pattern: PAGE_BY_ID, reply: (call) => freeFormPageDetail(call.pathname.split("/").pop(), BODY_MARKER) },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    { method: "GET", pattern: SETTINGS, reply: {} },
    {
      method: "PATCH",
      pattern: PAGE_BY_ID,
      reply: (call) => (failHome && call.body.pageId === HOME_PAGE_ID
        ? jsonResponse({ code: 3, message: "invalid" }, 400)
        : draftSummary(call.body.pageId, call.body.path)),
    },
  ];
  await pull(invoke(workspace, api(routes), { verb: "pull" }).invocation);
  await touchPulledSources(workspace);
  await assert.rejects(pagesPush(invoke(workspace, api(routes), { verb: "pages push", content: REAL_CONTENT }).invocation));
  failHome = false;
  const retry = api(routes);
  await pagesPush(invoke(workspace, retry, { verb: "pages push", content: REAL_CONTENT }).invocation);
  assert.deepEqual(retry.matching("PATCH", PAGE_BY_ID).map((call) => call.body.pageId), [HOME_PAGE_ID]);
});

test("pages push refuses to send a typed source at a page that has another template", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([]),
    ".taproot-site-media.json": TYPED_MEDIA_MANIFEST,
    "pages/story.md": TYPED_SOURCES["pages/story.md"],
  });
  const wire = api([
    ...typedCreateRoutes([
      pageSummary({ pageId: STORY_PAGE_ID, path: "blog/story", templateType: "TEMPLATE_TYPE_FREE_FORM" }),
    ]),
  ]);
  await assert.rejects(
    pagesPush(invoke(workspace, wire, { verb: "pages push", content: REAL_CONTENT }).invocation),
    (error) => error?.code === "pages.template_immutable" && /article source/u.test(error.message),
  );
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
  assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
});

test("a typed source that fails validation sends nothing, even beside pages that are valid", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([]),
    ".taproot-site-media.json": TYPED_MEDIA_MANIFEST,
    "pages/story.md": TYPED_SOURCES["pages/story.md"],
    "pages/trip.md": "---\ntitle: The trip\npath: albums/trip\ntemplate: album\n---\n\n## Images\n\n![Gone](media/missing.jpg)\n",
  });
  const wire = api(typedCreateRoutes());
  await assert.rejects(
    pagesPush(invoke(workspace, wire, { verb: "pages push", content: REAL_CONTENT }).invocation),
    { code: "media.unresolved_reference" },
  );
  assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
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

test("a retired rawHtml node keeps a stable human and JSON refusal before any page mutation", async (site) => {
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
  // The page's every finding travels with the refusal (TR01002): the retired
  // node, and the empty body its removal would leave.
  const { problems, ...error } = JSON.parse(stdout).error;
  assert.deepEqual(error, {
    code: "content.raw_html_forbidden",
    field: `${file}:/content/0`,
    problemCount: 2,
  });
  assert.deepEqual(problems.map((problem) => [problem.code, problem.field]), [
    ["content.raw_html_forbidden", `${file}:/content/0`],
    ["content.empty_document", `${file}:doc`],
  ]);
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

  // TR01144: the runtime mirror is answered before the Worker, so the server
  // refuses these (PublishedOutputPaths.IsRuntimeMirrorPath) and so does phase one.
  for (const pagePath of ["taproot/5.0.62", "taproot/5.0.62/manifest.json", "Taproot/10.20.30/x"]) {
    await testContext.test(`the runtime mirror path ${pagePath} is refused before anything is sent`, async (site) => {
      const workspace = await fixture(site, {
        ".taproot-site-manifest.json": manifestFixture([]),
        "pages/one.md": "---\ntitle: First\npath: first\n---\n\nHi.\n",
        "pages/two.md": `---\ntitle: Second\npath: ${pagePath}\n---\n\nHi.\n`,
      });
      const wire = api(pushRoutes({ live: [] }));
      const { invocation } = invoke(workspace, wire, { verb: "pages push", content: contentStub().module });
      await assert.rejects(pagesPush(invocation), (error) => error?.code === "pages.path_unsupported" && /published-site runtime/u.test(error.message));
      assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
    });
  }

  await testContext.test("near misses of the runtime mirror path are ordinary pages", async (site) => {
    const workspace = await fixture(site, {
      ".taproot-site-manifest.json": manifestFixture([]),
      "pages/a.md": "---\ntitle: A\npath: taproot/about\n---\n\nHi.\n",
      "pages/b.md": "---\ntitle: B\npath: taproot/5.0\n---\n\nHi.\n",
    });
    const wire = api(pushRoutes({ live: [] }));
    const { invocation } = invoke(workspace, wire, { verb: "pages push", content: contentStub().module });
    const result = await pagesPush(invocation);
    assert.deepEqual(result.pages.items.map((item) => item.file).sort(), ["pages/a.md", "pages/b.md"]);
  });

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
  // Short segments, so only the total length (not a file-name limit) is over.
  const overLong = `/${Array.from({ length: Math.floor(REDIRECT_LIMITS.pathBytes / 100) + 1 }, () => "a".repeat(99)).join("/")}`;
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
  // inside every site-side limit and well past a megabyte on disk. Targets stay
  // under the length a redirect file can store as metadata.
  const entries = Array.from({ length: 700 }, (_ignored, index) => ({
    path: `/legacy-${index}.html`,
    target: `https://legacy.example.test/${"a".repeat(1_700)}?id=${index}`,
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
    target: `https://legacy.example.test/${"a".repeat(1_700)}?id=${index}`,
    status: 301,
    origin: "SITE_REDIRECT_ORIGIN_AUTHORED",
  }));
  assert.ok(JSON.stringify(wireEntries).length > 1024 * 1024);
  const workspace = await fixture(site, { ".taproot-site-manifest.json": redirectsManifest() });
  const wire = api([
    {
      method: "GET",
      pattern: REDIRECT_MAP,
      reply: { siteId: SITE_ID, revision: REDIRECT_REVISION, entries: wireEntries },
    },
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

test("deploy says redirect entries live inside the release, and quotes no hold", async (site) => {
  // A redirect is a file inside the release the deploy publishes (TR00968), so
  // it is live exactly when that release is served. There is no store to wait
  // on, and the CLI must not invent a propagation hold.
  const workspace = await fixture(site, { ".taproot-site-manifest.json": manifestFixture([]) });
  const wire = api(deployRoutes());
  const { invocation, progress } = invoke(workspace, wire, { verb: "deploy", deployTarget: "staging" });
  const result = await deploy(invocation);

  assert.ok(progress.some((line) => line.includes("no separate propagation delay")));
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
  // The delivery URLs live in the media manifest (asserted above), not the result (TR01001).
  assert.deepEqual(result.media.items[0], {
    file: "media/hero.png",
    imageId: IMAGE_ID,
    deduplicated: false,
    width: 1200,
    height: 800,
    processingState: "IMAGE_PROCESSING_STATE_COMPLETE",
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

// ---------------------------------------------------------------------------
// media upload: video
// ---------------------------------------------------------------------------

const VIDEO_ID = "7c5e2b1a-9d3f-4a68-b0c4-1e2f3a4b5c6d";
const OTHER_VIDEO_ID = "0a1b2c3d-0a1b-4c3d-8a1b-0a1b2c3d4e5f";

// Real, small H.264 files (no audio) written once with mediabunny from a sample: an MP4
// with its index first, the same file with its index last, and a MOV. Taproot does not
// encode, so these are what the CLI reads, remuxes and declares.
const videoFixture = (name) => readFileSync(new URL(`./fixtures/video/${name}`, import.meta.url));
const FASTSTART = videoFixture("faststart.mp4");
const INDEX_AT_END = videoFixture("index-at-end.mp4");
const QUICKTIME = videoFixture("quick.mov");
const HEVC_REFUSAL = "This video uses HEVC (H.265). Export it as H.264 and upload again.";

/** The index (`moov`) before the media data (`mdat`) among a file's top-level boxes. */
function indexComesFirstIn(bytes) {
  let offset = 0;
  while (offset + 8 <= bytes.byteLength) {
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (type === "moov") return true;
    if (type === "mdat") return false;
    offset += bytes.readUInt32BE(offset);
  }
  return false;
}

/** An EBML header declaring `docType`, enough for the container sniffer. */
function ebml(docType, size = 1024) {
  const bytes = Buffer.alloc(size, 0x11);
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, docType.length + 0x80]).copy(bytes, 0);
  bytes.write(docType, 8, "ascii");
  return bytes;
}

/** Bytes that carry an MP4 `ftyp` brand and nothing a reader can use. */
function unreadableMp4(size = 512) {
  const bytes = Buffer.alloc(size, 0x5a);
  bytes.writeUInt32BE(24, 0);
  bytes.write("ftyp", 4, "ascii");
  bytes.write("isom", 8, "ascii");
  return bytes;
}

const confirmedVideo = (id = VIDEO_ID) => ({
  videoId: id,
  title: "tour",
  caption: "",
  fileName: "tour.mp4",
  bytes: String(FASTSTART.byteLength),
  durationMs: 1000,
  width: 1280,
  height: 720,
  sourceUrl: `https://video.example.test/site/${id}/video.mp4`,
});

function videoUploadRoutes() {
  return [
    {
      method: "POST",
      pattern: REQUEST_VIDEO_UPLOAD,
      reply: (call) => ({
        presignedUrl: PRESIGNED_URL,
        uploadId: VIDEO_ID,
        requiredHeaders: {
          "Content-Type": call.body.contentType,
          "Content-Length": String(call.body.sizeBytes),
          "If-None-Match": "*",
        },
      }),
    },
    { method: "PUT", pattern: PRESIGNED_PUT, reply: () => new Response(null, { status: 200 }) },
    { method: "POST", pattern: CONFIRM_VIDEO_UPLOAD, reply: () => confirmedVideo() },
    { method: "GET", pattern: SITE_VIDEOS, reply: { videos: [confirmedVideo()], nextPageToken: "" } },
  ];
}

test("media upload sends a faststart H.264 MP4 as it is, declares its codecs and confirms it ready", async (site) => {
  const workspace = await fixture(site, { "media/tour.mp4": FASTSTART });
  const wire = api(videoUploadRoutes());
  const { invocation } = invoke(workspace, wire, { verb: "media upload" });
  const result = await mediaUpload(invocation);

  const request = wire.matching("POST", REQUEST_VIDEO_UPLOAD)[0];
  assert.deepEqual(request.body, {
    fileName: "tour.mp4",
    contentType: "video/mp4",
    sizeBytes: FASTSTART.byteLength,
    videoCodec: request.body.videoCodec,
    audioCodec: "",
  });
  assert.match(request.body.videoCodec, /^avc[13]\./u);
  assert.equal(wire.matching("POST", REQUEST_UPLOAD).length, 0);

  // Sent as it is, with the signed length, type and create-only header echoed verbatim and no bearer.
  const put = wire.matching("PUT", PRESIGNED_PUT)[0];
  assert.equal(put.duplex, "half");
  assert.equal(put.headers.get("content-type"), "video/mp4");
  assert.equal(put.headers.get("content-length"), String(FASTSTART.byteLength));
  assert.equal(put.headers.get("if-none-match"), "*");
  assert.equal(put.headers.get("authorization"), null);
  assert.ok(Buffer.from(put.bytes).equals(FASTSTART));
  assert.equal(wire.matching("POST", CONFIRM_VIDEO_UPLOAD)[0].body.uploadId, VIDEO_ID);
  // Ready on confirm: nothing is read back to wait for it.
  assert.equal(wire.matching("GET", SITE_VIDEOS).length, 0);

  const manifest = await readWorkspaceJson(workspace, ".taproot-site-media.json");
  assert.deepEqual(manifest.videos["media/tour.mp4"], {
    videoId: VIDEO_ID,
    contentType: "video/mp4",
    byteLength: FASTSTART.byteLength,
    modifiedMilliseconds: manifest.videos["media/tour.mp4"].modifiedMilliseconds,
  });
  assert.equal(result.media.total, 0);
  assert.equal(result.videos.total, 1);
  assert.deepEqual(result.videos.items[0], {
    file: "media/tour.mp4",
    videoId: VIDEO_ID,
    title: "tour",
    caption: "",
    fileName: "tour.mp4",
    contentType: "video/mp4",
    byteLength: FASTSTART.byteLength,
    deduplicated: false,
    durationMilliseconds: 1000,
    component: {
      markdown: `\`\`\`component:video\n${JSON.stringify({ videoId: VIDEO_ID })}\n\`\`\``,
      block: {
        type: "componentBlock",
        attrs: { componentType: "video", componentData: JSON.stringify({ videoId: VIDEO_ID }) },
      },
    },
  });
  // Each form is accepted as reported, and both mean the same block.
  const { component } = result.videos.items[0];
  assert.deepEqual(validateDocument({ type: "doc", content: [component.block] }).errors, []);
  const converted = await markdownToProseMirror(component.markdown, { resolveImage: async () => assert.fail() });
  assert.deepEqual(converted.doc.content, [component.block]);
});

test("media upload rewrites an MP4 whose index is at the end with the index first, without re-encoding", async (site) => {
  assert.equal(indexComesFirstIn(INDEX_AT_END), false);
  const workspace = await fixture(site, { "media/tour.mp4": INDEX_AT_END });
  const wire = api(videoUploadRoutes());
  const { invocation, progress } = invoke(workspace, wire, { verb: "media upload" });
  await mediaUpload(invocation);

  const request = wire.matching("POST", REQUEST_VIDEO_UPLOAD)[0];
  const put = wire.matching("PUT", PRESIGNED_PUT)[0];
  // What was declared is what was sent: the rewritten file, with its index first.
  assert.equal(request.body.sizeBytes, put.bytes.byteLength);
  assert.equal(indexComesFirstIn(Buffer.from(put.bytes)), true);
  assert.equal(put.headers.get("content-length"), String(put.bytes.byteLength));
  // Copied, not re-encoded: the video's codec string is unchanged.
  assert.match(request.body.videoCodec, /^avc[13]\./u);
  assert.ok(progress.some((line) => line.includes("without re-encoding")));
  // The record keeps the source file's size, which is what an unchanged re-run compares.
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-media.json");
  assert.equal(manifest.videos["media/tour.mp4"].byteLength, INDEX_AT_END.byteLength);
});

test("media upload rewrites a MOV as an MP4 and names the upload .mp4", async (site) => {
  const workspace = await fixture(site, { "media/quick.mov": QUICKTIME });
  const wire = api(videoUploadRoutes());
  const { invocation } = invoke(workspace, wire, { verb: "media upload" });
  await mediaUpload(invocation);

  const request = wire.matching("POST", REQUEST_VIDEO_UPLOAD)[0];
  assert.equal(request.body.fileName, "quick.mp4");
  assert.equal(request.body.contentType, "video/mp4");
  const sent = Buffer.from(wire.matching("PUT", PRESIGNED_PUT)[0].bytes);
  assert.equal(sent.toString("latin1", 4, 8), "ftyp");
  assert.equal(indexComesFirstIn(sent), true);
});

test("media upload reads a video's container from its bytes, not its name", async (site) => {
  const workspace = await fixture(site, { "media/quick.dat": QUICKTIME, "media/clip.bin": ebml("webm") });
  const wire = api(videoUploadRoutes());
  const { invocation } = invoke(workspace, wire, {
    verb: "media upload",
    paths: ["media/quick.dat", "media/clip.bin"],
  });
  await mediaUpload(invocation);

  // Both are declared as MP4: the MOV after its rewrite, the WebM with no usable codecs so
  // the server, which decides, refuses it by name.
  assert.deepEqual(
    wire.matching("POST", REQUEST_VIDEO_UPLOAD).map((call) => [call.body.fileName, call.body.contentType]),
    [["quick.mp4", "video/mp4"], ["clip.mp4", "video/mp4"]],
  );
});

test("media upload does not claim a Matroska file as WebM", async (site) => {
  const workspace = await fixture(site, { "media/clip.mkv": ebml("matroska") });
  const wire = api(videoUploadRoutes());
  const { invocation } = invoke(workspace, wire, { verb: "media upload", paths: ["media/clip.mkv"] });

  await assert.rejects(
    mediaUpload(invocation),
    (error) => error?.code === "media.unsupported_format" && error?.field === "media/clip.mkv",
  );
  assert.equal(wire.calls.length, 0);
});

test("media upload prints the server's one-line refusal as it came and sends nothing", async (site) => {
  const workspace = await fixture(site, { "media/tour.mp4": FASTSTART });
  const wire = api([
    ...videoUploadRoutes().filter((route) => route.pattern !== REQUEST_VIDEO_UPLOAD),
    {
      method: "POST",
      pattern: REQUEST_VIDEO_UPLOAD,
      reply: () => jsonResponse(violation("VideoCodec", HEVC_REFUSAL), 400),
    },
  ]);
  const { invocation } = invoke(workspace, wire, { verb: "media upload" });

  await assert.rejects(
    mediaUpload(invocation),
    (error) =>
      error?.code === "media.video_refused"
      && error?.field === "media/tour.mp4"
      && error.message === `'media/tour.mp4': ${HEVC_REFUSAL}`,
  );
  assert.equal(wire.matching("PUT", PRESIGNED_PUT).length, 0);
});

test("media upload prints a refusal the server words under the file, site or upload field", async (site) => {
  for (const field of ["FileName", "SiteId", "UploadId"]) {
    const workspace = await fixture(site, { "media/tour.mp4": FASTSTART });
    const wire = api([
      ...videoUploadRoutes().filter((route) => route.pattern !== REQUEST_VIDEO_UPLOAD),
      {
        method: "POST",
        pattern: REQUEST_VIDEO_UPLOAD,
        reply: () => jsonResponse(violation(field, "The file name is not usable."), 400),
      },
    ]);

    await assert.rejects(
      mediaUpload(invoke(workspace, wire, { verb: "media upload" }).invocation),
      (error) =>
        error?.code === "media.video_refused" && error.message === "'media/tour.mp4': The file name is not usable.",
      field,
    );
  }
});

test("media upload declares a file it cannot read with no codecs and lets the server refuse it", async (site) => {
  const workspace = await fixture(site, { "media/tour.mp4": unreadableMp4() });
  const wire = api(videoUploadRoutes());
  const { invocation } = invoke(workspace, wire, { verb: "media upload" });
  await mediaUpload(invocation);

  const request = wire.matching("POST", REQUEST_VIDEO_UPLOAD)[0];
  assert.deepEqual([request.body.videoCodec, request.body.audioCodec], ["", ""]);
  assert.equal(request.body.sizeBytes, 512);
});

test("media upload prints the server's refusal of a confirm whose stored file failed the check", async (site) => {
  const workspace = await fixture(site, { "media/tour.mp4": FASTSTART });
  const line = "This video's index is at the end of the file, so it cannot start playing at once.";
  const wire = api([
    ...videoUploadRoutes().filter((route) => route.pattern !== CONFIRM_VIDEO_UPLOAD),
    { method: "POST", pattern: CONFIRM_VIDEO_UPLOAD, reply: () => jsonResponse(violation("Video", line), 400) },
  ]);

  await assert.rejects(
    mediaUpload(invoke(workspace, wire, { verb: "media upload" }).invocation),
    (error) => error?.code === "media.video_refused" && error.message.includes(line),
  );
});

test("media upload reuses an unchanged video it already uploaded instead of uploading it again", async (site) => {
  const workspace = await fixture(site, { "media/tour.mp4": FASTSTART });
  const first = api(videoUploadRoutes());
  await mediaUpload(invoke(workspace, first, { verb: "media upload" }).invocation);
  assert.equal(first.matching("PUT", PRESIGNED_PUT).length, 1);

  const second = api(videoUploadRoutes());
  const { invocation, progress } = invoke(workspace, second, { verb: "media upload" });
  const result = await mediaUpload(invocation);

  assert.equal(second.matching("POST", REQUEST_VIDEO_UPLOAD).length, 0);
  assert.equal(second.matching("PUT", PRESIGNED_PUT).length, 0);
  assert.equal(result.videos.items[0].deduplicated, true);
  assert.equal(result.videos.items[0].videoId, VIDEO_ID);
  assert.ok(progress.some((line) => line.includes("unchanged since it was uploaded")));
});

test("media upload resumes a confirm whose answer was lost instead of uploading the video again", async (site) => {
  const workspace = await fixture(site, { "media/tour.mp4": FASTSTART });
  const lostConfirm = api([
    ...videoUploadRoutes().filter((route) => route.pattern !== CONFIRM_VIDEO_UPLOAD),
    // The confirm reached the server and committed, but its answer never arrived.
    { method: "POST", pattern: CONFIRM_VIDEO_UPLOAD, reply: () => new Response("bad gateway", { status: 502 }) },
  ]);
  await assert.rejects(mediaUpload(invoke(workspace, lostConfirm, { verb: "media upload" }).invocation));
  const pending = await readWorkspaceJson(workspace, ".taproot-site-media.json");
  assert.equal(pending.videos["media/tour.mp4"].videoId, VIDEO_ID);
  assert.equal(pending.videos["media/tour.mp4"].pendingConfirm, true);

  const rerun = api(videoUploadRoutes());
  const { invocation, progress } = invoke(workspace, rerun, { verb: "media upload" });
  const result = await mediaUpload(invocation);

  assert.equal(rerun.matching("POST", REQUEST_VIDEO_UPLOAD).length, 0);
  assert.equal(rerun.matching("PUT", PRESIGNED_PUT).length, 0);
  assert.equal(rerun.matching("POST", CONFIRM_VIDEO_UPLOAD)[0].body.uploadId, VIDEO_ID);
  assert.equal(result.videos.items[0].videoId, VIDEO_ID);
  assert.ok(progress.some((line) => line.includes("Confirmed the earlier upload")));
  const settled = await readWorkspaceJson(workspace, ".taproot-site-media.json");
  assert.equal(Object.hasOwn(settled.videos["media/tour.mp4"], "pendingConfirm"), false);
});

test("media upload sends a video again when its earlier upload can no longer be confirmed", async (site) => {
  const workspace = await fixture(site, { "media/tour.mp4": FASTSTART });
  await assert.rejects(mediaUpload(invoke(workspace, api([
    ...videoUploadRoutes().filter((route) => route.pattern !== CONFIRM_VIDEO_UPLOAD),
    { method: "POST", pattern: CONFIRM_VIDEO_UPLOAD, reply: () => new Response("bad gateway", { status: 502 }) },
  ]), { verb: "media upload" }).invocation));

  let confirms = 0;
  const rerun = api([
    ...videoUploadRoutes().filter((route) => route.pattern !== CONFIRM_VIDEO_UPLOAD),
    {
      method: "POST",
      pattern: CONFIRM_VIDEO_UPLOAD,
      // The reservation expired: the first confirm is refused, the new upload's is accepted.
      reply: () => {
        confirms += 1;
        return confirms === 1 ? jsonResponse({ code: 3, message: "Pending upload has expired." }, 400) : confirmedVideo();
      },
    },
  ]);
  await mediaUpload(invoke(workspace, rerun, { verb: "media upload" }).invocation);

  assert.equal(rerun.matching("POST", REQUEST_VIDEO_UPLOAD).length, 1);
  assert.equal(rerun.matching("PUT", PRESIGNED_PUT).length, 1);
});

test("media upload does not upload an unchanged video again when the library is too large to check", async (site) => {
  const workspace = await fixture(site, { "media/tour.mp4": FASTSTART });
  await mediaUpload(invoke(workspace, api(videoUploadRoutes()), { verb: "media upload" }).invocation);

  const wire = api([
    ...videoUploadRoutes().filter((route) => route.pattern !== SITE_VIDEOS),
    {
      method: "GET",
      pattern: SITE_VIDEOS,
      // Never stops paginating and never lists the recorded video: truncated.
      reply: () => ({ videos: [confirmedVideo(OTHER_VIDEO_ID)], nextPageToken: "more" }),
    },
  ]);
  await assert.rejects(
    mediaUpload(invoke(workspace, wire, { verb: "media upload" }).invocation),
    (error) => error?.code === "media.video_library_unverifiable" && error?.field === "media/tour.mp4",
  );
  assert.equal(wire.matching("POST", REQUEST_VIDEO_UPLOAD).length, 0);
  assert.equal(wire.matching("PUT", PRESIGNED_PUT).length, 0);
});

test("media upload uploads a video again when the file changed or the site no longer has it", async (testContext) => {
  await testContext.test("the file changed", async (site) => {
    const workspace = await fixture(site, { "media/tour.mp4": FASTSTART });
    await mediaUpload(invoke(workspace, api(videoUploadRoutes()), { verb: "media upload" }).invocation);
    await writeWorkspaceFile(workspace.workspaceDir, "media/tour.mp4", INDEX_AT_END);

    const wire = api(videoUploadRoutes());
    await mediaUpload(invoke(workspace, wire, { verb: "media upload" }).invocation);

    assert.equal(wire.matching("PUT", PRESIGNED_PUT).length, 1);
  });

  await testContext.test("the library no longer holds the video", async (site) => {
    const workspace = await fixture(site, { "media/tour.mp4": FASTSTART });
    await mediaUpload(invoke(workspace, api(videoUploadRoutes()), { verb: "media upload" }).invocation);

    const wire = api([
      ...videoUploadRoutes().filter((route) => route.pattern !== SITE_VIDEOS),
      { method: "GET", pattern: SITE_VIDEOS, reply: { videos: [], nextPageToken: "" } },
    ]);
    await mediaUpload(invoke(workspace, wire, { verb: "media upload" }).invocation);

    assert.equal(wire.matching("PUT", PRESIGNED_PUT).length, 1);
  });
});

test("media upload renews the exchanged credential when a long upload outlasts it", async (site) => {
  const workspace = await fixture(site, { "media/tour.mp4": FASTSTART });
  const RENEWED = "tr_live_renewed_site_credential_never_logged";
  let exchanges = 0;
  let timing;
  const routes = videoUploadRoutes().map((route) =>
    route.method === "PUT"
      ? {
        ...route,
        // The send takes almost the whole hour the exchanged credential lives.
        reply: () => {
          timing.advance(58 * 60_000);
          return new Response(null, { status: 200 });
        },
      }
      : route
  );
  const wire = api([
    {
      method: "POST",
      pattern: TOKEN_EXCHANGE,
      reply: () => {
        exchanges += 1;
        return {
          rawKey: exchanges === 1 ? EXCHANGED_KEY : RENEWED,
          keyId: "cccc3333-dddd-4333-8333-eeee33333333",
          keyPrefix: "tr_live_ex99ab88...",
          siteId: SITE_ID,
          // One hour after the suite's fixed clock.
          expiresAt: exchanges === 1 ? "2023-11-14T23:13:20.000Z" : "2023-11-15T00:11:20.000Z",
          capabilities: [CAPABILITY_CONTENT, CAPABILITY_DESIGN, CAPABILITY_DEPLOYMENTS],
        };
      },
    },
    ...routes,
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
  const invoked = invoke(workspace, wire, {
    verb: "media upload",
    environment: { XDG_CONFIG_HOME: workspace.configHome },
  });
  timing = invoked.timing;

  await mediaUpload(invoked.invocation);

  assert.equal(exchanges, 2);
  const bearerOf = (call) => call.headers.authorization;
  assert.equal(bearerOf(wire.matching("POST", REQUEST_VIDEO_UPLOAD)[0]), `Bearer ${EXCHANGED_KEY}`);
  // Confirm comes after the upload outlasted the first credential.
  assert.equal(bearerOf(wire.matching("POST", CONFIRM_VIDEO_UPLOAD)[0]), `Bearer ${RENEWED}`);
  // The object store never sees either credential.
  assert.equal(wire.matching("PUT", PRESIGNED_PUT)[0].headers.get("authorization"), null);
});

test("media upload keeps a confirmed video's id when a later upload in the run fails", async (site) => {
  const workspace = await fixture(site, { "media/a.mp4": FASTSTART, "media/b.mp4": INDEX_AT_END });
  const ids = [VIDEO_ID, OTHER_VIDEO_ID];
  let requested = 0;
  let sent = 0;
  const wire = api([
    {
      method: "POST",
      pattern: REQUEST_VIDEO_UPLOAD,
      reply: (call) => {
        const uploadId = ids[requested];
        requested += 1;
        return {
          presignedUrl: PRESIGNED_URL,
          uploadId,
          requiredHeaders: { "Content-Type": call.body.contentType, "Content-Length": String(call.body.sizeBytes) },
        };
      },
    },
    {
      method: "PUT",
      pattern: PRESIGNED_PUT,
      reply: () => {
        sent += 1;
        return new Response(null, { status: sent === 1 ? 200 : 403 });
      },
    },
    { method: "POST", pattern: CONFIRM_VIDEO_UPLOAD, reply: (call) => confirmedVideo(call.body.uploadId) },
  ]);
  const { invocation } = invoke(workspace, wire, { verb: "media upload" });

  await assert.rejects(mediaUpload(invocation), (error) => error?.code === "upload.rejected");

  const manifest = await readWorkspaceJson(workspace, ".taproot-site-media.json");
  assert.equal(manifest.videos["media/a.mp4"].videoId, VIDEO_ID);
  assert.equal(Object.hasOwn(manifest.videos["media/a.mp4"], "pendingConfirm"), false);
  // The failed one is recorded as an unconfirmed upload, so a re-run confirms or resends it.
  assert.deepEqual(
    [manifest.videos["media/b.mp4"].videoId, manifest.videos["media/b.mp4"].pendingConfirm],
    [OTHER_VIDEO_ID, true],
  );
});

test("media upload confirms a video whose PUT landed but whose answer was lost", async (site) => {
  const workspace = await fixture(site, { "media/tour.mp4": FASTSTART });
  let puts = 0;
  const wire = api([
    ...videoUploadRoutes().filter((route) => route.method !== "PUT"),
    {
      method: "PUT",
      pattern: PRESIGNED_PUT,
      // The first PUT is stored but its answer never arrives; the retry meets the create-only
      // condition and is refused with 412.
      reply: () => {
        puts += 1;
        return puts === 1 ? new Response("bad gateway", { status: 502 }) : new Response(null, { status: 412 });
      },
    },
  ]);
  const { invocation, progress } = invoke(workspace, wire, { verb: "media upload" });

  const result = await mediaUpload(invocation);

  assert.equal(puts, 2);
  assert.equal(wire.matching("POST", CONFIRM_VIDEO_UPLOAD).length, 1);
  assert.equal(result.videos.items[0].videoId, VIDEO_ID);
  assert.ok(progress.some((line) => line.includes("had already landed")));
});

test("media upload does not confirm a video whose file changed while it was being sent", async (site) => {
  const workspace = await fixture(site, { "media/tour.mp4": FASTSTART });
  const routes = videoUploadRoutes().map((route) =>
    route.method === "PUT"
      ? {
        ...route,
        // A recorder still appending to the file while the PUT runs.
        reply: async () => {
          await writeWorkspaceFile(workspace.workspaceDir, "media/tour.mp4", INDEX_AT_END);
          return new Response(null, { status: 200 });
        },
      }
      : route
  );
  const wire = api(routes);
  const { invocation } = invoke(workspace, wire, { verb: "media upload" });

  await assert.rejects(
    mediaUpload(invocation),
    (error) => error?.code === "workspace.file_changed" && error?.field === "media/tour.mp4",
  );
  assert.equal(wire.matching("POST", CONFIRM_VIDEO_UPLOAD).length, 0);
});

test("media upload does not confirm a video that was appended to in place while it was being sent", async (site) => {
  const workspace = await fixture(site, { "media/tour.mp4": FASTSTART });
  const routes = videoUploadRoutes().map((route) =>
    route.method === "PUT"
      ? {
        ...route,
        reply: async () => {
          await appendFile(path.join(workspace.workspaceDir, "media/tour.mp4"), Buffer.alloc(64));
          return new Response(null, { status: 200 });
        },
      }
      : route
  );
  const wire = api(routes);
  const { invocation } = invoke(workspace, wire, { verb: "media upload" });

  await assert.rejects(mediaUpload(invocation), (error) => error?.code === "workspace.file_changed");
  assert.equal(wire.matching("POST", CONFIRM_VIDEO_UPLOAD).length, 0);
});

test("media upload names a video over the upload ceiling as a video, before sending anything", async (site) => {
  const workspace = await fixture(site, { "media/huge.mp4": FASTSTART });
  // Sparse: the file claims one byte past the ceiling without writing it.
  await truncate(path.join(workspace.workspaceDir, "media/huge.mp4"), 5 * 1024 * 1024 * 1024 + 1);
  const wire = api(videoUploadRoutes());
  const { invocation } = invoke(workspace, wire, { verb: "media upload" });

  await assert.rejects(
    mediaUpload(invocation),
    (error) => error?.code === "media.video_too_large" && error?.field === "media/huge.mp4",
  );
  assert.equal(wire.calls.length, 0);
});

test("media upload uploads images and videos in one run", async (site) => {
  const workspace = await fixture(site, { "media/hero.png": png(1200, 800), "media/tour.mp4": FASTSTART });
  const wire = api([...uploadRoutes(), ...videoUploadRoutes()]);
  const { invocation } = invoke(workspace, wire, { verb: "media upload" });
  const result = await mediaUpload(invocation);

  assert.equal(result.media.total, 1);
  assert.equal(result.videos.total, 1);
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-media.json");
  assert.equal(manifest.media["media/hero.png"].imageId, IMAGE_ID);
  assert.equal(manifest.videos["media/tour.mp4"].videoId, VIDEO_ID);
});

test("a media manifest written before video upload reads as holding no videos", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-media.json": { mediaManifestVersion: 2, siteId: SITE_ID, media: {} },
    "media/tour.mp4": FASTSTART,
  });
  const wire = api(videoUploadRoutes());
  const { invocation } = invoke(workspace, wire, { verb: "media upload" });
  await mediaUpload(invocation);

  const manifest = await readWorkspaceJson(workspace, ".taproot-site-media.json");
  assert.equal(manifest.mediaManifestVersion, 2);
  assert.equal(Object.keys(manifest.videos).length, 1);
});

// ---------------------------------------------------------------------------
// pages push: a page that places a video
// ---------------------------------------------------------------------------

function videoPage(videoId) {
  return {
    ...PUSH_WORKSPACE,
    "pages/about.md": "---\ntitle: About us\npath: about\ndescription: Who we are\n---\n\nHello.\n\n"
      + `\`\`\`component:video\n${JSON.stringify({ videoId })}\n\`\`\`\n`,
  };
}

function videoLibraryRoute(videos) {
  return { method: "GET", pattern: SITE_VIDEOS, reply: { videos, nextPageToken: "" } };
}

test("pages push places a ready video the site has", async (site) => {
  const workspace = await fixture(site, videoPage(VIDEO_ID));
  const wire = api([
    ...pushRoutes(),
    videoLibraryRoute([{ videoId: VIDEO_ID }]),
  ]);
  const { invocation } = invoke(workspace, wire, { verb: "pages push", content: REAL_CONTENT });
  const result = await pagesPush(invocation);

  assert.equal(result.pages.created, 1);
  assert.equal(wire.matching("GET", SITE_VIDEOS).length, 1);
  const sent = wire.matching("POST", PAGES_COLLECTION)[0].body.template.freeFormData.body;
  const block = sent.content.find((node) => node.type === "componentBlock");
  assert.equal(block.attrs.componentType, "video");
  assert.deepEqual(JSON.parse(block.attrs.componentData), { videoId: VIDEO_ID });
});

test("pages push refuses a video the site does not have before anything is written", async (site) => {
  const workspace = await fixture(site, videoPage(OTHER_VIDEO_ID));
  const wire = api([
    ...pushRoutes(),
    videoLibraryRoute([{ videoId: VIDEO_ID }]),
  ]);
  const { invocation } = invoke(workspace, wire, { verb: "pages push", content: REAL_CONTENT });

  await assert.rejects(
    pagesPush(invocation),
    (error) => error?.code === "pages.video_unknown" && error?.field === "pages/about.md",
  );
  assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
});

test("pages push does not call a video unknown when the library was too large to read in full", async (site) => {
  const workspace = await fixture(site, videoPage(OTHER_VIDEO_ID));
  const wire = api([
    ...pushRoutes(),
    {
      method: "GET",
      pattern: SITE_VIDEOS,
      // A library that never stops paginating: the listing is truncated.
      reply: () => ({ videos: [{ videoId: VIDEO_ID }], nextPageToken: "more" }),
    },
  ]);
  const { invocation } = invoke(workspace, wire, { verb: "pages push", content: REAL_CONTENT });

  await assert.rejects(pagesPush(invocation), (error) => error?.code === "pages.video_library_unverifiable");
  assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
});

test("pages push asks the video library nothing when no page places a video", async (site) => {
  const workspace = await fixture(site, PUSH_WORKSPACE);
  const wire = api(pushRoutes());
  const { invocation } = invoke(workspace, wire, { verb: "pages push", content: REAL_CONTENT });
  await pagesPush(invocation);

  assert.equal(wire.matching("GET", SITE_VIDEOS).length, 0);
});

// ---------------------------------------------------------------------------
// pages push: a video embed with no poster gets the provider's thumbnail
// ---------------------------------------------------------------------------

const EMBED_FENCE = (data) => `\`\`\`component:video-embed\n${JSON.stringify(data)}\n\`\`\`\n`;

function embedPage(...fences) {
  return {
    ...PUSH_WORKSPACE,
    "pages/about.md": "---\ntitle: About us\npath: about\ndescription: Who we are\n---\n\nHello.\n\n" + fences.join("\n"),
  };
}

function importedPosterImage() {
  return {
    imageId: IMAGE_ID,
    url: "https://img.example/poster-low.webp",
    responsiveUrls: [{ minWidth: 640, url: "https://img.example/poster-640.webp" }],
    width: 1280,
    height: 720,
    uploadedName: "youtube dQw4w9WgXcQ poster",
    processingState: "IMAGE_PROCESSING_STATE_PENDING",
  };
}

function importPosterRoute(reply = () => ({ imageId: IMAGE_ID, width: 1280, height: 720, image: importedPosterImage() })) {
  return { method: "POST", pattern: IMPORT_VIDEO_EMBED_POSTER, reply };
}

/**
 * The listing the CLI polls for the copied image's processing state, one state per read.
 * An embed poster is owned media: the server's library never lists it, so only a read that
 * names the image's id returns it, as the real listing does.
 */
function posterLibraryRoute(states = ["IMAGE_PROCESSING_STATE_COMPLETE"]) {
  let read = 0;
  return {
    method: "GET",
    pattern: SITE_IMAGES,
    reply: (call) => {
      if (!call.query.getAll("imageIds").includes(IMAGE_ID)) {
        return { images: [], nextPageToken: "", totalImages: 0, processingImages: 0 };
      }
      const state = states[Math.min(read, states.length - 1)];
      read += 1;
      return {
        images: [{ image: importedPosterImage(), processingState: state }],
        nextPageToken: "",
        totalImages: 1,
        processingImages: state === "IMAGE_PROCESSING_STATE_COMPLETE" ? 0 : 1,
      };
    },
  };
}

const sentEmbeds = (wire) =>
  wire.matching("POST", PAGES_COLLECTION)[0].body.template.freeFormData.body.content
    .filter((node) => node.type === "componentBlock")
    .map((node) => JSON.parse(node.attrs.componentData));

test("pages push copies the provider thumbnail for an embed with no poster, once per video", async (site) => {
  const workspace = await fixture(site, embedPage(
    EMBED_FENCE({ url: "https://youtu.be/dQw4w9WgXcQ", title: "Tour" }),
    EMBED_FENCE({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Tour again" }),
  ));
  const wire = api([...pushRoutes(), importPosterRoute(), posterLibraryRoute()]);
  const { invocation } = invoke(workspace, wire, { verb: "pages push", content: REAL_CONTENT });
  await pagesPush(invocation);

  const imports = wire.matching("POST", IMPORT_VIDEO_EMBED_POSTER);
  assert.equal(imports.length, 1);
  assert.deepEqual(imports[0].body, { provider: "youtube", videoId: "dQw4w9WgXcQ" });
  const poster = {
    imageId: IMAGE_ID,
    src: "https://img.example/poster-low.webp",
    urls: [{ minWidth: 640, url: "https://img.example/poster-640.webp" }],
    width: 1280,
    height: 720,
    alt: "",
  };
  assert.deepEqual(sentEmbeds(wire).map((data) => data.poster), [poster, poster]);
});

test("pages push leaves an embed that already has a poster alone", async (site) => {
  const kept = { imageId: OTHER_VIDEO_ID, src: "", urls: [], width: 1280, height: 720, alt: "Our poster" };
  const workspace = await fixture(site, {
    ...embedPage(EMBED_FENCE({ url: "https://youtu.be/dQw4w9WgXcQ", title: "Tour", poster: "media/poster.webp" })),
    ".taproot-site-media.json": {
      mediaManifestVersion: 2,
      siteId: SITE_ID,
      media: { "media/poster.webp": { imageId: OTHER_VIDEO_ID, width: 1280, height: 720, alt: "Our poster" } },
    },
  });
  const wire = api([...pushRoutes(), importPosterRoute(), posterLibraryRoute()]);
  const { invocation } = invoke(workspace, wire, { verb: "pages push", content: REAL_CONTENT });
  await pagesPush(invocation);

  assert.equal(wire.matching("POST", IMPORT_VIDEO_EMBED_POSTER).length, 0);
  assert.deepEqual(sentEmbeds(wire)[0].poster, kept);
});

test("pages push sends an embed with no poster when the thumbnail cannot be copied", async (site) => {
  const workspace = await fixture(site, embedPage(
    EMBED_FENCE({ url: "https://vimeo.com/76979871", title: "Tour" }),
  ));
  const wire = api([
    ...pushRoutes(),
    importPosterRoute(() => jsonResponse(violation("Poster", "That video's thumbnail could not be copied."), 400)),
    posterLibraryRoute(),
  ]);
  const { invocation, progress } = invoke(workspace, wire, { verb: "pages push", content: REAL_CONTENT });
  const result = await pagesPush(invocation);

  assert.equal(result.pages.created, 1);
  assert.equal(sentEmbeds(wire)[0].poster, undefined);
  assert.ok(progress.some((line) => line.includes("keeps no poster for vimeo video 76979871")));
});

test("pages push waits for the copied thumbnail to finish processing before using it", async (site) => {
  const workspace = await fixture(site, embedPage(
    EMBED_FENCE({ url: "https://youtu.be/dQw4w9WgXcQ", title: "Tour" }),
  ));
  const wire = api([
    ...pushRoutes(),
    importPosterRoute(),
    posterLibraryRoute(["IMAGE_PROCESSING_STATE_PENDING", "IMAGE_PROCESSING_STATE_COMPLETE"]),
  ]);
  const { invocation } = invoke(workspace, wire, { verb: "pages push", content: REAL_CONTENT });
  await pagesPush(invocation);

  assert.equal(wire.matching("GET", SITE_IMAGES).length, 2);
  assert.equal(sentEmbeds(wire)[0].poster.imageId, IMAGE_ID);
});

test("pages push sends an embed with no poster when the copied thumbnail fails processing", async (site) => {
  const workspace = await fixture(site, embedPage(
    EMBED_FENCE({ url: "https://youtu.be/dQw4w9WgXcQ", title: "Tour" }),
  ));
  const wire = api([...pushRoutes(), importPosterRoute(), posterLibraryRoute(["IMAGE_PROCESSING_STATE_FAILED"])]);
  const { invocation, progress } = invoke(workspace, wire, { verb: "pages push", content: REAL_CONTENT });
  const result = await pagesPush(invocation);

  assert.equal(result.pages.created, 1);
  assert.equal(sentEmbeds(wire)[0].poster, undefined);
  assert.ok(progress.some((line) => line.includes("keeps no poster for youtube video dQw4w9WgXcQ")));
});

test("pages push copies nothing when no page places an embed", async (site) => {
  const workspace = await fixture(site, PUSH_WORKSPACE);
  const wire = api([...pushRoutes(), importPosterRoute(), posterLibraryRoute()]);
  const { invocation } = invoke(workspace, wire, { verb: "pages push", content: REAL_CONTENT });
  await pagesPush(invocation);

  assert.equal(wire.matching("POST", IMPORT_VIDEO_EMBED_POSTER).length, 0);
});

test("a video component refuses fields the page may not author", async () => {
  const errors = validateDocument({
    type: "doc",
    content: [{
      type: "componentBlock",
      attrs: {
        componentType: "video",
        componentData: JSON.stringify({
          videoId: VIDEO_ID,
          aspectRatio: "wide",
          caption: "x".repeat(301),
          delivery: { sourceUrl: "https://evil.example/x.mp4" },
        }),
      },
    }],
  }).errors.map((error) => error.path).sort();

  assert.deepEqual(errors, [
    "/content/0/attrs/componentData/aspectRatio",
    "/content/0/attrs/componentData/caption",
    "/content/0/attrs/componentData/delivery",
  ]);
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
        workspaceMode: "editable",
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
          // The system 404 is an ordinary tracked page, so its draft is staged
          // like any other the workspace owns.
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

  assert.deepEqual(wire.matching("POST", PUBLISH_DRAFTS)[0].body, { pageIds: [ABOUT_PAGE_ID, NOT_FOUND_PAGE_ID] });
  assert.equal(result.approved.total, 2);
  assert.equal(result.stagedNotDeployed, true);
  assert.equal(result.nextStep, "deploy --staging");
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.pages[0].status, "PAGE_STATUS_APPROVED");
  assert.equal(manifest.pages[0].pendingApproval, false);
  assert.ok(progress.some((line) => line.includes("Nothing is published until")));
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

  await testContext.test("an already-approved page is skipped and the rest of the batch is approved (TR01192)", async (site) => {
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
            pageSummary({ pageId: STORY_PAGE_ID, path: "news/story", status: "PAGE_STATUS_APPROVED", hasDraft: false }),
          ],
          nextPageToken: "",
        },
      },
      {
        method: "POST",
        pattern: PUBLISH_DRAFTS,
        reply: (call) => ({
          pages: call.body.pageIds.map((pageId) => pageSummary({ pageId, path: "", status: "PAGE_STATUS_APPROVED" })),
        }),
      },
    ]);
    const { invocation, progress } = invoke(workspace, wire, { verb: "approve", pagePaths: ["news/story", "/"] });
    const result = await approve(invocation);
    assert.deepEqual(wire.matching("POST", PUBLISH_DRAFTS)[0].body, { pageIds: [ABOUT_PAGE_ID] });
    assert.equal(result.approved.total, 1);
    // The home page is spelled '/' in results, as plan spells it.
    assert.equal(result.approved.items[0].path, "/");
    assert.deepEqual(result.skipped, {
      total: 1,
      items: [{ pageId: STORY_PAGE_ID, path: "news/story", status: "PAGE_STATUS_APPROVED", reason: "already_approved" }],
    });
    assert.ok(progress.some((line) => line.includes("news/story has no pending draft (already approved)")));
  });

  await testContext.test("an untracked path still refuses the batch, naming every one (TR01192)", async (site) => {
    const workspace = await fixture(site, workspaceFiles);
    const wire = api(routes);
    const { invocation } = invoke(workspace, wire, { verb: "approve", pagePaths: ["zeta", "alpha"] });
    await assert.rejects(
      approve(invocation),
      (error) => error?.code === "approve.page_not_found" && error?.field === "alpha"
        && error.message.includes("'alpha', 'zeta'") && error.alternatives.join() === "alpha,zeta",
    );
    assert.equal(wire.matching("POST", PUBLISH_DRAFTS).length, 0);
  });

  await testContext.test("a long batch of unknown paths is listed on progress and in alternatives (TR01192)", async (site) => {
    const workspace = await fixture(site, workspaceFiles);
    const wire = api(routes);
    const paths = Array.from({ length: 120 }, (_, index) => `missing/${"x".repeat(40)}-${String(index).padStart(3, "0")}`);
    const { invocation, progress } = invoke(workspace, wire, { verb: "approve", pagePaths: paths });
    await assert.rejects(approve(invocation), (error) => {
      assert.equal(error.code, "approve.page_not_found");
      assert.match(error.message, /^120 requested path\(s\)/u);
      assert.equal(error.alternatives.length, 100);
      return true;
    });
    for (const value of paths) assert.ok(progress.some((line) => line.includes(`'${value}'`)), value);
    assert.equal(wire.matching("POST", PUBLISH_DRAFTS).length, 0);
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
  stagingProbeError,
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
      method: "POST",
      pattern: STAGING_MINT,
      reply: {
        siteId: SITE_ID,
        stagingUrl: `https://${STAGING_HOST}/`,
        url: STAGING_HANDOFF_URL,
        handoffExpiresAt: HANDOFF_EXPIRES_AT,
      },
    },
    {
      method: "GET",
      pattern: STAGING_PREVIEW_ROOT,
      reply: (call) => {
        if (stagingProbeError) throw stagingProbeError;
        return stagingProbeResponse ?? new Response("", {
          status: 302,
          headers: {
            location: call.query.has("__taproot_preview_handoff")
              ? `https://${STAGING_HOST}/?__taproot_preview_check=1`
              : `https://${STAGING_HOST}/`,
            ...(call.query.has("__taproot_preview_handoff")
              ? {
                "set-cookie": `__Host-taproot_staging_preview=${
                  "B".repeat(43)
                }; Path=/; Secure; HttpOnly; SameSite=Lax`,
              }
              : {}),
          },
        });
      },
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
  assert.equal(result.stagingPreview.url, STAGING_HANDOFF_URL);
  assert.equal(result.routeCheck, "resolved");
  assert.equal(result.redirects.verified, true);
  assert.equal(wire.matching("POST", STAGING_MINT).length, 2);
  assert.ok(progress.some((line) => line.includes("DEPLOYMENT_STATUS_GENERATING")));
  assert.ok(progress.every((line) => !line.includes(HANDOFF_TOKEN)));
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
  assert.equal(result.stagingPreview.url, STAGING_HANDOFF_URL);
  assert.equal(result.routeCheck, "unresolved");
  assert.equal(result.redirects.verified, false);
  // A check that cannot finish keeps the result's shape and says why.
  assert.deepEqual(result.redirects.items, []);
  assert.match(result.redirects.error.code, /^[a-z0-9_.]+$/u);
  assert.equal(result.nextStep, "redirects check");
  assert.equal(result.stagingPreview.routeCheck, undefined);
  assert.ok(progress.some((line) => line.startsWith("Warning: ")));
});

test("deploy --staging names a foreign check failure without echoing its text (TR01192)", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([{ pageId: ABOUT_PAGE_ID, path: "about", title: "About" }]),
  });
  const wire = api(deployRoutes({
    stagingProbeError: new TypeError("fetch failed https://evil.example/?token=secret\u202e"),
  }));
  const { invocation } = invoke(workspace, wire, { verb: "deploy", deployTarget: "staging" });

  const result = await deploy(invocation);

  assert.equal(result.ok, true);
  assert.equal(result.routeCheck, "unresolved");
  assert.deepEqual(result.redirects.error, {
    code: "redirects.check_failed",
    message: "The redirect check could not finish (TypeError).",
  });
  assert.ok(!JSON.stringify(result).includes("token=secret"));
});

test("deploy --staging refuses an empty candidate before it reaches the API", async (site) => {
  const workspace = await fixture(site);
  const wire = api([
    {
      method: "GET",
      pattern: DEPLOY_REVIEW,
      reply: {},
    },
    // Nothing selected, and Taproot sees no other change (no edited redirect map).
    {
      method: "GET",
      pattern: READINESS,
      reply: { state: "PAGE_PUBLISHING_READINESS_STATE_READY", hasCandidateChanges: false, blockers: [] },
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

test("deploy --staging stages an edited redirect map when nothing else is selected", async (site) => {
  const workspace = await fixture(site);
  const wire = api([
    { method: "GET", pattern: DEPLOY_REVIEW, reply: {} },
    ...deployRoutes({ readiness: { selectedPageCount: 0, approvedPageCount: 0, hasCandidateChanges: true } })
      .filter((route) => route.pattern !== PAGES_LIST),
  ]);
  const { invocation, progress } = invoke(workspace, wire, { verb: "deploy", deployTarget: "staging" });

  const result = await deploy(invocation);

  assert.equal(result.ok, true);
  assert.equal(wire.matching("GET", READINESS)[0].query.get("useExactPageSelection"), "true");
  assert.equal(wire.matching("POST", DEPLOY).length, 1);
  assert.deepEqual(wire.matching("POST", DEPLOY)[0].body.stagedPageIds ?? [], []);
  // Readiness here names no site-wide change, so the generic line is the fallback.
  assert.ok(progress.includes("Your site has changed since the last release. Staging publishes the change."));
});

test("deploy --staging excludes a deselected failed-media page from redirect readiness", async (site) => {
  const workspace = await fixture(site);
  const routes = deployRoutes().map((route) => route.pattern !== READINESS ? route : {
    ...route,
    reply: (call) => call.query.get("useExactPageSelection") === "true"
      ? { state: "PAGE_PUBLISHING_READINESS_STATE_READY", approvedPageCount: 1, selectedPageCount: 0,
        hasCandidateChanges: true, redirectsChanged: true, blockers: [] }
      : { state: "PAGE_PUBLISHING_READINESS_STATE_FAILED", hasCandidateChanges: true,
        blockers: [{ imageId: IMAGE_ID, uploadedName: "unselected.jpg",
          state: "PAGE_PUBLISHING_READINESS_STATE_FAILED", message: "Processing failed." }] },
  });
  const wire = api([
    { method: "GET", pattern: DEPLOY_REVIEW,
      reply: { stagedPages: [{ pageId: ABOUT_PAGE_ID }], settingsChanges: [], navigationChanged: false } },
    ...routes,
  ]);
  const { invocation } = invoke(workspace, wire, {
    verb: "deploy", deployTarget: "staging", stagedPageIds: [], selectedSettingsTypes: [], includeNavigation: false,
  });

  const result = await deploy(invocation);

  assert.equal(result.ok, true);
  const readiness = wire.matching("GET", READINESS)[0];
  assert.equal(readiness.query.get("useExactPageSelection"), "true");
  assert.deepEqual(readiness.query.getAll("stagedPageIds"), []);
  assert.deepEqual(wire.matching("POST", DEPLOY)[0].body.stagedPageIds ?? [], []);
});

test("deploy --staging retains the site-wide readiness fallback for a large page selection", async (site) => {
  const workspace = await fixture(site);
  const pageIds = Array.from({ length: 101 }, (_, index) =>
    `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`);
  const wire = api([
    { method: "GET", pattern: DEPLOY_REVIEW,
      reply: { stagedPages: pageIds.map(pageId => ({ pageId })), settingsChanges: [], navigationChanged: false } },
    ...deployRoutes({ readiness: { approvedPageCount: 101, selectedPageCount: 101 } }),
  ]);
  const { invocation } = invoke(workspace, wire, {
    verb: "deploy", deployTarget: "staging", stagedPageIds: pageIds, selectedSettingsTypes: [], includeNavigation: false,
  });

  const result = await deploy(invocation);

  assert.equal(result.ok, true);
  const readiness = wire.matching("GET", READINESS)[0];
  assert.deepEqual(readiness.query.getAll("stagedPageIds"), []);
  assert.equal(readiness.query.get("useExactPageSelection"), "false");
  assert.deepEqual(wire.matching("POST", DEPLOY)[0].body.stagedPageIds, pageIds);
});

test("deploy --staging names the site-wide changes it publishes when nothing else is selected", async (site) => {
  const workspace = await fixture(site);
  const wire = api([
    { method: "GET", pattern: DEPLOY_REVIEW, reply: {} },
    ...deployRoutes({
      readiness: { selectedPageCount: 0, approvedPageCount: 0, hasCandidateChanges: true, videosChanged: true, formsChanged: true },
    }).filter((route) => route.pattern !== PAGES_LIST),
  ]);
  const { invocation, progress } = invoke(workspace, wire, { verb: "deploy", deployTarget: "staging" });

  const result = await deploy(invocation);

  assert.equal(result.ok, true);
  assert.ok(progress.some((line) => line === "Staging publishes what changed since the last release: a form, a video's caption or poster."));
  assert.deepEqual(
    [result.readiness.redirectsChanged, result.readiness.formsChanged, result.readiness.videosChanged],
    [false, true, true],
  );
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
    cli: { name: "@taprootio/site-authoring", version: CLI_VERSION },
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
    && line.includes(`snapshotId=${STAGING_DEPLOYMENT_ID}`)
  ));
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
    stdout: {
      write: (chunk) => {
        stdout += chunk;
      },
    },
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
      reply: () =>
        jsonResponse(
          violation("AuthoringPreviewAuthorityCapacity", description),
          400,
        ),
    }]);
    const { invocation } = invoke(workspace, wire, { verb: "preview page", pageId: ABOUT_PAGE_ID });

    await assert.rejects(
      previewPage(invocation),
      (error) =>
        error?.code === "preview.authority_capacity"
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
      reply: () =>
        jsonResponse(
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
    cli: { name: "@taprootio/site-authoring", version: CLI_VERSION },
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
  for (
    const scenario of [
      { previewIds: ["NOT-A-UUID", SNAPSHOT_ID], field: "pageId" },
      { previewIds: [ABOUT_PAGE_ID, "NOT-A-UUID"], field: "snapshotId" },
    ]
  ) {
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

test("preview revoke reports a missing or unavailable snapshot as preview.not_found, never as a draft outcome", async (testContext) => {
  for (
    const [name, reply, field] of [
      ["NotFound status", () => jsonResponse({ code: 5, message: "AuthoringPreview 'x' not found." }, 404), undefined],
      ["in-transaction unavailability", () => jsonResponse(violation("AuthoringPreview", "unavailable"), 400), "snapshotId"],
    ]
  ) {
    await testContext.test(name, async (site) => {
      const workspace = await fixture(site);
      const wire = api([{ method: "DELETE", pattern: PREVIEW_STATUS, reply }]);
      const { invocation } = invoke(workspace, wire, {
        verb: "preview revoke",
        previewIds: [ABOUT_PAGE_ID, SNAPSHOT_ID],
      });
      await assert.rejects(previewRevoke(invocation), (error) => {
        assert.equal(error.code, "preview.not_found");
        assert.equal(error.field, field);
        assert.doesNotMatch(error.message, /draft/u);
        return true;
      });
    });
  }
});

test("preview revoke keeps the draft, authorization and unclassified refusals distinct from a missing snapshot", async (testContext) => {
  for (
    const [name, reply, code, refusal] of [
      ["no persisted draft on create-only paths", () => jsonResponse(violation("AuthoringPreviewDraft"), 400), "preview.no_draft", undefined],
      ["rejected credential", () => jsonResponse({ code: 16, message: "unauthenticated" }, 401), "api.request_rejected", "credential_rejected"],
      ["server failure", () => jsonResponse({ code: 13, message: "internal" }, 500), "api.request_rejected", "unclassified"],
    ]
  ) {
    await testContext.test(name, async (site) => {
      const workspace = await fixture(site);
      const wire = api([{ method: "DELETE", pattern: PREVIEW_STATUS, reply }]);
      const { invocation } = invoke(workspace, wire, {
        verb: "preview revoke",
        previewIds: [ABOUT_PAGE_ID, SNAPSHOT_ID],
      });
      await assert.rejects(previewRevoke(invocation), (error) => {
        assert.equal(error.code, code);
        if (refusal !== undefined) assert.equal(error.refusalKind(), refusal);
        return true;
      });
    });
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
      "preview page": (invocation) =>
        previewPage({
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

test("status reports deployments, readiness, image processing and broken-reference pages", async (site) => {
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
    {
      method: "GET",
      pattern: BROKEN_REFERENCES,
      reply: {
        pages: [{
          pageId: ABOUT_PAGE_ID,
          pageTitle: "About",
          missingImageIds: [IMAGE_ID],
          missingPagePaths: ["/missing"],
        }],
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
  assert.deepEqual(result.brokenReferences, {
    covered: true,
    totalPages: 1,
    pages: [{ pageId: ABOUT_PAGE_ID, pageTitle: "About", missingImageIds: [IMAGE_ID], missingPagePaths: ["/missing"] }],
  });
  assert.ok(progress.some((line) => /Broken references: 1 page/u.test(line)));
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
    { method: "GET", pattern: BROKEN_REFERENCES, reply: {} },
  ]);
  const { invocation } = invoke(workspace, wire, { verb: "status" });
  const result = await status(invocation);
  // `total` is what this read returned, not the site's deployment history — the
  // log is unbounded and only its recent end is read.
  assert.equal(result.deployments.total, 1);
  assert.equal(result.deployments.listTruncated, true);
  assert.deepEqual(result.brokenReferences, { covered: true, totalPages: 0, pages: [] });
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
    presentation: presentationManifestEntry(PRESENTATION_REVISION),
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
    { method: "POST", pattern: PRESENTATION, reply: (call) => presentationSaveReply(call) },
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
    { method: "GET", pattern: BROKEN_REFERENCES, reply: {} },
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

test("status refuses a denied or malformed broken-reference report instead of claiming a clean site", async (context) => {
  for (
    const [name, reply, code] of [
      ["denied", () => jsonResponse({ code: 7 }, 403), "api.request_rejected"],
      ["invalid page list", { pages: {} }, "api.broken_references_contract"],
      [
        "invalid target list",
        { pages: [{ pageId: ABOUT_PAGE_ID, missingPagePaths: [null] }] },
        "api.broken_references_contract",
      ],
    ]
  ) {
    await context.test(name, async (child) => {
      const workspace = await fixture(child);
      const wire = api([
        { method: "GET", pattern: READINESS, reply: {} },
        { method: "GET", pattern: DEPLOYMENTS, reply: {} },
        { method: "GET", pattern: SITE_IMAGES, reply: {} },
        { method: "GET", pattern: BROKEN_REFERENCES, reply },
      ]);
      await assert.rejects(
        status(invoke(workspace, wire, { verb: "status" }).invocation),
        (error) => error.code === code,
      );
    });
  }
});

test("status bounds broken-reference pages and targets and reports every truncation", async (context) => {
  const workspace = await fixture(context);
  const pages = Array.from({ length: 51 }, (_, index) => ({
    pageId: `aaaaaaaa-bbbb-4ccc-8ddd-${String(index).padStart(12, "0")}`,
    pageTitle: `Page ${index}`,
    missingImageIds: Array.from({ length: 51 }, () => IMAGE_ID),
    missingPagePaths: Array.from({ length: 51 }, (_, target) => `/missing-${target}`),
  }));
  const wire = api([
    { method: "GET", pattern: READINESS, reply: {} },
    { method: "GET", pattern: DEPLOYMENTS, reply: {} },
    { method: "GET", pattern: SITE_IMAGES, reply: {} },
    { method: "GET", pattern: BROKEN_REFERENCES, reply: { pages } },
  ]);
  const result = await status(invoke(workspace, wire, { verb: "status" }).invocation);
  assert.equal(result.brokenReferences.totalPages, 51);
  assert.equal(result.brokenReferences.pages.length, 50);
  assert.equal(result.brokenReferences.pagesTruncated, true);
  const page = result.brokenReferences.pages[0];
  assert.equal(page.missingImageIds.length, 50);
  assert.equal(page.missingPagePaths.length, 50);
  assert.equal(page.missingImageIdsTruncated, true);
  assert.equal(page.missingPagePathsTruncated, true);
});

test("deploy and status select only the release changes shown by the UI", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([{ pageId: ABOUT_PAGE_ID, path: "about", title: "About" }]),
  });
  const selection = { stagedPages: [{ pageId: STORY_PAGE_ID }], settingsChanges: [], navigationChanged: false };
  const wire = api([
    { method: "GET", pattern: DEPLOY_REVIEW, reply: selection },
    ...deployRoutes({ readiness: { hasSuccessfulStagingDeployment: true } }),
    { method: "GET", pattern: SITE_IMAGES, reply: {} },
    { method: "GET", pattern: BROKEN_REFERENCES, reply: {} },
  ]);
  await deploy(invoke(workspace, wire, { verb: "deploy", deployTarget: "staging" }).invocation);
  const result = await status(invoke(workspace, wire, { verb: "status" }).invocation);
  const sent = wire.matching("POST", DEPLOY)[0].body;
  assert.deepEqual(sent.stagedPageIds, [STORY_PAGE_ID]);
  assert.deepEqual(sent.selectedSettingsTypes, []);
  assert.equal(sent.includeNavigation, false);
  assert.equal(result.readiness.hasSuccessfulStagingDeployment, true);
  for (const call of wire.matching("GET", READINESS)) {
    assert.deepEqual(call.query.getAll("stagedPageIds"), [STORY_PAGE_ID]);
    assert.deepEqual(call.query.getAll("selectedSettingsTypes"), []);
    assert.equal(call.query.get("includeNavigation"), "false");
  }
});

test("staging checks record real 301 and 410 responses without following targets or exporting handoffs", async (site) => {
  const workspace = await fixture(site);
  const checked = [
    { path: "/old.html", target: "https://external.example/visit", status: 301 },
    { path: "/gone", kind: "SITE_REDIRECT_KIND_GONE", status: 410 },
  ];
  const wire = api([
    { method: "GET", pattern: REDIRECT_MAP, reply: { siteId: SITE_ID, revision: REDIRECT_REVISION, entries: checked } },
    ...deployRoutes(),
    {
      method: "GET",
      pattern: /^\/old\.html$/u,
      reply: new Response(null, { status: 301, headers: { location: checked[0].target } }),
    },
    { method: "GET", pattern: /^\/gone$/u, reply: new Response(null, { status: 410 }) },
  ]);
  const outputPath = path.join(workspace.project, "staging-actions-output");
  await writeFile(outputPath, "");
  let stdout = "";
  let stderr = "";
  // runCli uses the real clock, so mint times follow it in this entry-point check.
  const fetch = async (url, init) => {
    if (STAGING_MINT.test(new URL(url).pathname)) {
      return jsonResponse({
        siteId: SITE_ID,
        stagingUrl: `https://${STAGING_HOST}/`,
        url: STAGING_HANDOFF_URL,
        handoffExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      });
    }
    return wire.fetch(url, init);
  };
  const exitCode = await runCli({
    arguments_: ["--config", workspace.configPath, "redirects", "check"],
    cwd: workspace.project,
    environment: { TAPROOT_SITE_KEY: TOKEN, GITHUB_OUTPUT: outputPath },
    fetch,
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
  });
  assert.equal(exitCode, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.redirects.verified, true);
  assert.deepEqual(result.redirects.items.map((row) => [row.path, row.status, row.location]), [
    ["/old.html", 301, checked[0].target],
    ["/gone", 410, ""],
  ]);
  assert.equal(result.stagingPreview.url, STAGING_HANDOFF_URL);
  assert.ok(!stderr.includes(HANDOFF_TOKEN));
  assert.ok(!(await readFile(outputPath, "utf8")).includes(HANDOFF_TOKEN));
  for (const call of wire.calls.filter((call) => call.pathname === "/old.html" || call.pathname === "/gone")) {
    assert.equal(call.headers.authorization, undefined);
    assert.match(call.headers.cookie, /^__Host-taproot_staging_preview=/u);
  }
  assert.ok(wire.calls.every((call) => call.pathname !== "/visit"));
});

test("approve's unknown-path refusal fits the result bound through the CLI, however the paths escape (TR01192)", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([{ pageId: ABOUT_PAGE_ID, path: "about", title: "About" }]),
  });
  const wire = api([{ method: "GET", pattern: PAGES_LIST, reply: { pages: [], nextPageToken: "" } }]);
  const paths = Array.from({ length: 100 }, (_, index) => `${"\"".repeat(500)}${index}`);
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli({
    arguments_: ["--config", workspace.configPath, "approve", ...paths],
    cwd: workspace.project,
    environment: { TAPROOT_SITE_KEY: TOKEN },
    fetch: wire.fetch,
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
  });
  assert.notEqual(exitCode, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "approve.page_not_found");
  assert.ok(result.error.alternatives.length > 0 && result.error.alternatives.length < 100);
  assert.ok(Buffer.byteLength(stdout, "utf8") <= 64 * 1024);
  // The message is on stderr; JSON carries the code and the bounded list.
  assert.ok(stderr.includes(`The first ${result.error.alternatives.length} are in alternatives`), stderr.slice(-300));
});

test("redirects check reports a check that cannot finish in the same shape (TR01192)", async (site) => {
  const workspace = await fixture(site);
  const wire = api([
    {
      method: "GET",
      pattern: REDIRECT_MAP,
      reply: { siteId: SITE_ID, revision: REDIRECT_REVISION, entries: [{ path: "/old", target: "/new", status: 301 }] },
    },
    ...deployRoutes({ stagingProbeResponse: new Response("Site not found", { status: 404 }) }),
  ]);
  const { invocation, progress } = invoke(workspace, wire, { verb: "redirects check" });
  const result = await VERB_HANDLERS["redirects check"](invocation);
  assert.equal(result.ok, true);
  assert.equal(result.routeCheck, "unresolved");
  assert.equal(result.redirects.verified, false);
  assert.deepEqual(result.redirects.items, []);
  assert.equal(result.redirects.error.code, "staging.gate_unavailable");
  assert.equal(result.stagingPreview.url, STAGING_HANDOFF_URL);
  assert.ok(progress.some((line) => line.includes("could not finish")));
});

test("redirect checks refuse gate bounces as proof and report a map revision changed during checks", async (site) => {
  const workspace = await fixture(site);
  let reads = 0;
  const wire = api([
    {
      method: "GET",
      pattern: REDIRECT_MAP,
      reply: () => ({
        siteId: SITE_ID,
        revision: reads++ === 0 ? REDIRECT_REVISION : NEXT_REDIRECT_REVISION,
        entries: [{ path: "/old", target: "/new", status: 301 }],
      }),
    },
    ...deployRoutes(),
    {
      method: "GET",
      pattern: /^\/old$/u,
      reply: new Response(null, { status: 302, headers: { location: STAGING_HANDOFF_URL } }),
    },
  ]);
  const { invocation, progress } = invoke(workspace, wire, { verb: "redirects check" });
  const result = await VERB_HANDLERS["redirects check"](invocation);
  assert.equal(result.redirects.verified, false);
  assert.equal(result.redirects.revisionUnchanged, false);
  assert.equal(result.redirects.items[0].location, "[withheld]");
  assert.ok(progress.every((line) => !line.includes(HANDOFF_TOKEN)));
});

test("phase timings retain retries, omit unobserved durations and keep legacy evidence unknown", async () => {
  const { normalizeDeployment } = await import("../src/api.js");
  const record = deploymentRecord({
    phaseHistory: {
      phases: [
        { enteredAt: "2026-09-08T00:00:00Z" },
        { status: "DEPLOYMENT_STATUS_GENERATING", enteredAt: "2026-09-08T00:00:01Z" },
        { status: "DEPLOYMENT_STATUS_DEPLOYING", enteredAt: "2026-09-08T00:00:02Z" },
        { status: "DEPLOYMENT_STATUS_GENERATING", enteredAt: "2026-09-08T00:10:01Z" },
        { status: "DEPLOYMENT_STATUS_COMPLETED", enteredAt: "2026-09-08T00:10:04Z" },
      ],
    },
  });
  const result = normalizeDeployment(record);
  assert.deepEqual(result.phaseTimings.phases.map((phase) => phase.durationMilliseconds), [
    1000,
    1000,
    599000,
    3000,
    undefined,
  ]);
  assert.equal(result.phaseTimings.phases[3].status, "DEPLOYMENT_STATUS_GENERATING");
  assert.deepEqual(normalizeDeployment(deploymentRecord()).phaseTimings, { known: false });
  record.phaseHistory.phases[1].enteredAt = "2026-09-07T00:00:00Z";
  assert.throws(() => normalizeDeployment(record), (error) => error.code === "api.deployment_phase_contract");
});

function phasedDeployments(steps) {
  // Each poll reads the next step; the last one repeats.
  let read = 0;
  return {
    method: "GET",
    pattern: DEPLOYMENTS,
    reply: () => {
      const step = steps[Math.min(read, steps.length - 1)];
      read += 1;
      return {
        deployments: [deploymentRecord({
          status: step.status,
          errorMessage: step.errorMessage,
          completedAt: step.status === "DEPLOYMENT_STATUS_COMPLETED" ? "2026-08-20T00:01:00Z" : "",
          phaseHistory: {
            phases: [{ enteredAt: "2026-09-08T00:00:00Z" }, ...step.phases.map(([status, enteredAt]) => ({
              status,
              enteredAt,
            }))],
          },
        })],
        nextPageToken: "",
      };
    },
  };
}

const GENERATING = ["DEPLOYMENT_STATUS_GENERATING", "2026-09-08T00:00:01Z"];
const DEPLOYING = ["DEPLOYMENT_STATUS_DEPLOYING", "2026-09-08T00:00:05Z"];
const COMPLETED = ["DEPLOYMENT_STATUS_COMPLETED", "2026-09-08T00:00:09Z"];

test("a deployment wait reports each phase once when entered and once when it ends, then ends the wait", async (site) => {
  const workspace = await fixture(site);
  const routes = deployRoutes().filter((route) => route.pattern !== DEPLOYMENTS);
  const wire = api([
    ...routes,
    phasedDeployments([
      { status: "DEPLOYMENT_STATUS_GENERATING", phases: [GENERATING] },
      { status: "DEPLOYMENT_STATUS_GENERATING", phases: [GENERATING] },
      { status: "DEPLOYMENT_STATUS_DEPLOYING", phases: [GENERATING, DEPLOYING] },
      { status: "DEPLOYMENT_STATUS_DEPLOYING", phases: [GENERATING, DEPLOYING] },
      { status: "DEPLOYMENT_STATUS_COMPLETED", phases: [GENERATING, DEPLOYING, COMPLETED] },
    ]),
  ]);
  const { invocation, progress } = invoke(workspace, wire, { verb: "deploy", deployTarget: "staging" });
  let waitEnded = 0;
  const onProgress = Object.assign((message, event) => invocation.onProgress(message, event), {
    endWait: () => {
      waitEnded += 1;
    },
  });

  await deploy({ ...invocation, onProgress });

  const phaseLines = progress.filter((line) => line.startsWith("Deployment phase"));
  assert.equal(new Set(phaseLines).size, phaseLines.length, "no phase line repeats");
  const generating = phaseLines.filter((line) => line.includes("DEPLOYMENT_STATUS_GENERATING"));
  assert.equal(generating.length, 2, "once while it runs, once when it ends");
  assert.equal(generating.filter((line) => line.includes("ms until")).length, 1);
  assert.ok(generating.some((line) => line.includes("4000ms until")));
  assert.equal(waitEnded, 1);
});

test("a failed deployment still reports its phases and ends the wait before the failure surfaces", async (site) => {
  const workspace = await fixture(site);
  const routes = deployRoutes().filter((route) => route.pattern !== DEPLOYMENTS);
  const wire = api([
    ...routes,
    phasedDeployments([
      { status: "DEPLOYMENT_STATUS_GENERATING", phases: [GENERATING] },
      { status: "DEPLOYMENT_STATUS_FAILED", errorMessage: "Files: The HTML inventory must contain its root page.", phases: [GENERATING, ["DEPLOYMENT_STATUS_FAILED", "2026-09-08T00:00:03Z"]] },
    ]),
  ]);
  const { invocation, progress } = invoke(workspace, wire, { verb: "deploy", deployTarget: "staging" });
  let waitEnded = 0;
  const onProgress = Object.assign((message, event) => invocation.onProgress(message, event), {
    endWait: () => {
      waitEnded += 1;
    },
  });

  await assert.rejects(
    deploy({ ...invocation, onProgress }),
    (error) => error.code === "deploy.failed" && error.message.includes("root page"),
  );

  assert.ok(progress.some((line) => line.includes("DEPLOYMENT_STATUS_FAILED entered")));
  assert.equal(waitEnded, 1);
});

test("a deployment that never appears in the log ends the wait too", async (site) => {
  const workspace = await fixture(site);
  const routes = deployRoutes().filter((route) => route.pattern !== DEPLOYMENTS);
  const wire = api([...routes, { method: "GET", pattern: DEPLOYMENTS, reply: { deployments: [], nextPageToken: "" } }]);
  const { invocation } = invoke(workspace, wire, { verb: "deploy", deployTarget: "staging" });
  let waitEnded = 0;
  const onProgress = Object.assign((message, event) => invocation.onProgress(message, event), {
    endWait: () => {
      waitEnded += 1;
    },
  });

  await assert.rejects(deploy({ ...invocation, onProgress }), (error) => error.code === "deploy.not_observable");

  assert.equal(waitEnded, 1);
});

test("preview failure reports typed diagnostic context without renderer content", async (site) => {
  const workspace = await fixture(site);
  const diagnostic = {
    errorClass: "preview.revision_mismatch",
    pageId: ABOUT_PAGE_ID,
    nodeType: "inlineFacts",
    attribute: "value",
  };
  const wire = api([
    {
      method: "POST",
      pattern: PREVIEW_CREATE,
      reply: { preview: previewRecord(), storedPreviewCap: 10, storedPreviewCount: 1 },
    },
    {
      method: "GET",
      pattern: PREVIEW_STATUS,
      reply: previewRecord({
        status: "AUTHORING_PREVIEW_STATUS_FAILED",
        failureCode: "preview.render_failed",
        failureDiagnostic: diagnostic,
      }),
    },
  ]);
  await assert.rejects(
    previewPage(invoke(workspace, wire, { verb: "preview page", pageId: ABOUT_PAGE_ID }).invocation),
    (error) => {
      assert.equal(error.code, "preview.render_failed");
      assert.deepEqual(failureResult(error).error.diagnostic, diagnostic);
      assert.ok(error.message.includes("preview.revision_mismatch"));
      return true;
    },
  );
});

test("deploy names a failed candidate preview and sends its override only when explicit", async (site) => {
  const workspace = await fixture(site);
  const wire = api(deployRoutes({
    deployReply: (call) =>
      call.body.allowFailedPreview
        ? { deployment: deploymentRecord({ status: "DEPLOYMENT_STATUS_COMPLETED" }) }
        : jsonResponse(
          violation("AuthoringPreviewFailed", `Snapshot ${SNAPSHOT_ID} failed for page ${ABOUT_PAGE_ID}.`),
          400,
        ),
  }));
  await assert.rejects(
    deploy(invoke(workspace, wire, { verb: "deploy", deployTarget: "staging" }).invocation),
    (error) => {
      assert.equal(error.code, "deploy.preview_failed");
      assert.ok(error.message.includes(SNAPSHOT_ID));
      assert.ok(error.message.includes("--allow-failed-preview"));
      return true;
    },
  );
  await deploy(
    invoke(workspace, wire, { verb: "deploy", deployTarget: "staging", allowFailedPreview: true }).invocation,
  );
  assert.equal(wire.matching("POST", DEPLOY)[0].body.allowFailedPreview, undefined);
  assert.equal(wire.matching("POST", DEPLOY)[1].body.allowFailedPreview, true);
});

// ── The Docs-presentation surface (TR00790) ──────────────────────────────────
//
// A managed Docs site takes the design verbs and nothing else: its pages,
// navigation, and redirects come from the artifact the Docs shell renders. The
// configuration `use` writes records that, and every site verb reads it before
// touching the wire.

function docsSettingsRoutes() {
  return [{
    method: "GET",
    pattern: SETTINGS,
    reply: (call) => {
      if (call.pathname.endsWith("SETTING_TYPE_SITE_HEADER")) {
        return { settingsType: "SETTING_TYPE_SITE_HEADER", headerSettings: { headerLayout: "centered-brand" } };
      }
      if (call.pathname.endsWith("SETTING_TYPE_TAPROOT_STYLES")) {
        return { styleSettings: { lightLogoId: IMAGE_ID } };
      }
      if (call.pathname.endsWith("SETTING_TYPE_SITE_PUBLISHING_PREFERENCES")) {
        return { sitePublishingPreferences: { footerSettings: authorableFooter() } };
      }
      return {};
    },
  }];
}

test("pull on a managed Docs site snapshots settings only and records the surface in the manifest", async (site) => {
  const workspace = await fixture(site, {}, { config: { authoringSurface: "docs-presentation" } });
  const wire = api(docsSettingsRoutes());
  const { invocation, progress } = invoke(workspace, wire, { verb: "pull", surface: "docs-presentation" });
  const result = await pull(invocation);

  assert.equal(result.ok, true);
  assert.equal(result.authoringSurface, "docs-presentation");
  assert.equal(result.pages.total, 0);
  assert.equal(result.navigation, undefined);
  assert.equal(result.redirects, undefined);
  assert.deepEqual(result.settings.pulled, [
    "SETTING_TYPE_TAPROOT_STYLES",
    "SETTING_TYPE_BRAND",
    "SETTING_TYPE_SITE_HEADER",
    "SETTING_TYPE_SITE_PUBLISHING_PREFERENCES",
  ]);
  // No page, navigation, or redirect read was made: those are the reads a
  // Docs site refuses, and the wire has no route for them.
  assert.equal(wire.matching("GET", PAGES_LIST).length, 0);
  assert.equal(wire.matching("GET", NAVIGATION).length, 0);
  assert.equal(wire.matching("GET", REDIRECT_MAP).length, 0);
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.equal(manifest.authoringSurface, "docs-presentation");
  assert.equal(manifest.navigation, undefined);
  assert.deepEqual(manifest.pages, []);
  await assert.rejects(readWorkspaceJson(workspace, "nav.json"));
  assert.ok(progress.some((line) => /managed Docs site/u.test(line)));
});

test("status on a managed Docs site reports the reads it cannot make as not covered", async (site) => {
  const workspace = await fixture(site, {}, { config: { authoringSurface: "docs-presentation" } });
  const wire = api([
    // The review names pages and navigation the site cannot deploy; readiness
    // is asked about the settings-only candidate deploy would send instead.
    {
      method: "GET",
      pattern: DEPLOY_REVIEW,
      reply: {
        stagedPages: [{ pageId: STORY_PAGE_ID }],
        settingsChanges: [{ settingsType: "SETTING_TYPE_BRAND", changes: [{ path: "faviconId" }] }],
        navigationChanged: true,
      },
    },
    { method: "GET", pattern: READINESS, reply: { state: "PAGE_PUBLISHING_READINESS_STATE_READY", blockers: [] } },
    { method: "GET", pattern: DEPLOYMENTS, reply: { deployments: [], nextPageToken: "" } },
  ]);
  const result = await status(invoke(workspace, wire, { verb: "status", surface: "docs-presentation" }).invocation);

  assert.equal(result.authoringSurface, "docs-presentation");
  assert.equal(result.readiness.state, "PAGE_PUBLISHING_READINESS_STATE_READY");
  // Status reports readiness in the same shape deploy does, site-wide change flags included.
  assert.deepEqual(
    [result.readiness.redirectsChanged, result.readiness.formsChanged, result.readiness.videosChanged],
    [false, false, false],
  );
  assert.equal(result.images.covered, false);
  assert.equal(result.images.total, undefined);
  assert.equal(result.brokenReferences.covered, false);
  assert.equal(wire.matching("GET", SITE_IMAGES).length, 0);
  assert.equal(wire.matching("GET", BROKEN_REFERENCES).length, 0);
  const readinessCall = wire.matching("GET", READINESS)[0];
  assert.deepEqual(readinessCall.query.getAll("stagedPageIds"), []);
  assert.equal(readinessCall.query.get("includeNavigation"), "false");
  assert.deepEqual(readinessCall.query.getAll("selectedSettingsTypes"), ["SETTING_TYPE_BRAND"]);
});

// ── delivery check (TR00824) ───────────────────────────────────────────────

const PUBLIC_ORIGIN = "https://www.example.com";
const RUNTIME_ENTRY = /\/taproot\/5\.0\.63\/taproot-shared-runtime-abc\.esm\.js$/u;

// An unpinned page declares a bootstrap that names no runtime version or entry.
function deliveredHtml(links = [], { pinned = true } = {}) {
  const bootstrap = JSON.stringify(pinned
    ? {
      version: "5.0.63",
      entry: "/taproot/5.0.63/taproot-shared-runtime-abc.esm.js",
      capabilities: {},
      siteBundleUrl: "/public/main.root-abc.js",
      runtimeCapabilities: [],
    }
    : {
      siteBundleUrl: "/public/main.root-abc.js",
      runtimeCapabilities: [],
    });
  return `<!doctype html><html><head><link rel="icon" href="/favicon.ico"><script type="application/json" id="taproot-runtime-bootstrap">${bootstrap}</script></head><body><esp-root>${
    links.map((href) => `<a href="${href}">x</a>`).join("")
  }</esp-root></body></html>`;
}

function deliveryRoutes({ pinned = true, environment = "DEPLOYMENT_ENVIRONMENT_PRODUCTION", completed = true } = {}) {
  const html = (body) => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  const asset = (type, body = "x") => new Response(body, { status: 200, headers: { "content-type": type } });
  return [
    {
      method: "GET",
      pattern: DEPLOYMENTS,
      reply: {
        deployments: completed
          ? [deploymentRecord({ environment, status: "DEPLOYMENT_STATUS_COMPLETED", completedAt: "2026-08-20T00:01:00Z" })]
          : [deploymentRecord({ environment, status: "DEPLOYMENT_STATUS_FAILED" })],
        nextPageToken: "",
      },
    },
    { method: "GET", pattern: RUNTIME_ENTRY, reply: () => asset("text/javascript", "export {};") },
    { method: "GET", pattern: /^\/public\/main\.root-abc\.js$/u, reply: () => asset("text/javascript", "export {};") },
    { method: "GET", pattern: /^\/favicon\.ico$/u, reply: () => asset("image/x-icon") },
    { method: "GET", pattern: /^\/about\/$/u, reply: () => html(deliveredHtml(["/"], { pinned })) },
    { method: "GET", pattern: /^\/$/u, reply: () => html(deliveredHtml(["/about/"], { pinned })) },
  ];
}

test("delivery check --production verifies the public origin it is given and reports every dimension", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([{ pageId: ABOUT_PAGE_ID, path: "about", title: "About" }], {
      deployments: { production: { id: DEPLOYMENT_ID, status: "DEPLOYMENT_STATUS_COMPLETED", completedAt: "2026-08-20T00:01:00Z" } },
    }),
  });
  const wire = api(deliveryRoutes());
  const { invocation, progress } = invoke(workspace, wire, {
    verb: "delivery check",
    deployTarget: "production",
    deliveryUrl: `${PUBLIC_ORIGIN}/`,
    browser: false,
  });
  const result = await deliveryCheck(invocation);
  assert.equal(result.verb, "delivery check");
  assert.equal(result.environment, "DEPLOYMENT_ENVIRONMENT_PRODUCTION");
  assert.equal(result.verdict, "delivered");
  assert.deepEqual(result.deployment, { id: DEPLOYMENT_ID, completedAt: "2026-08-20T00:01:00Z", recordedInWorkspace: true });
  assert.equal(result.target.url, `${PUBLIC_ORIGIN}/`);
  assert.equal(result.target.resolvedFrom, "option");
  assert.equal(result.target.stagingAuthorized, false);
  assert.deepEqual(result.routes.items.map((item) => item.path), ["/", "/about/"]);
  assert.equal(result.runtime.compatible, true);
  assert.equal(result.browser.status, "unchecked");
  assert.equal(result.browser.reason, "disabled");
  assert.ok(result.doesNotProve.some((line) => /returning browser/u.test(line)));
  // Read-only: the platform API saw only the deployment log; the public origin saw only GETs.
  assert.deepEqual(wire.calls.filter((call) => call.pathname.startsWith("/api/")).map((call) => `${call.method} ${call.pathname}`), [
    `GET /api/v1/sites/${SITE_ID}/deployments`,
  ]);
  assert.ok(wire.calls.every((call) => call.method === "GET"));
  assert.ok(progress.some((line) => /Delivery verified over HTTP/u.test(line)));
});

test("delivery check spends its route allowance on every template before repeating one", async (site) => {
  const posts = Array.from({ length: 25 }, (_, index) => ({
    pageId: `7777777${index % 10}-7777-4777-8777-77777777${String(index).padStart(4, "0")}`,
    path: `journal/post-${index}`,
    title: `Post ${index}`,
    templateType: "TEMPLATE_TYPE_ARTICLE",
  }));
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([
      ...posts,
      { pageId: STORY_PAGE_ID, path: "recipes/lemon-bars", title: "Lemon bars", templateType: "TEMPLATE_TYPE_RECIPE" },
    ]),
  });
  const html = () => new Response(deliveredHtml(), { status: 200, headers: { "content-type": "text/html" } });
  const wire = api([
    ...deliveryRoutes(),
    { method: "GET", pattern: /^\/(journal\/post-\d+|recipes\/lemon-bars)\/$/u, reply: html },
  ]);
  const { invocation } = invoke(workspace, wire, {
    verb: "delivery check",
    deployTarget: "production",
    deliveryUrl: `${PUBLIC_ORIGIN}/`,
    browser: false,
  });
  const result = await deliveryCheck(invocation);
  const checked = result.routes.items.map((item) => item.path);
  assert.equal(result.routes.truncated, true);
  // The recipe is the last page in the manifest, yet it is among the routes
  // fetched: the first article and the recipe are chosen before the second article.
  assert.deepEqual(checked.slice(0, 3), ["/", "/journal/post-0/", "/recipes/lemon-bars/"]);
});

test("delivery check fails a page that pins no runtime, with a differing workspace record", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([], {
      deployments: { production: { id: STAGING_DEPLOYMENT_ID, status: "DEPLOYMENT_STATUS_COMPLETED", completedAt: "2026-08-19T00:00:00Z" } },
    }),
  });
  const wire = api(deliveryRoutes({ pinned: false }));
  const { invocation, progress } = invoke(workspace, wire, {
    verb: "delivery check",
    deployTarget: "production",
    deliveryUrl: `${PUBLIC_ORIGIN}/`,
    browser: false,
  });
  const result = await deliveryCheck(invocation);
  assert.equal(result.verdict, "failed");
  assert.equal(result.runtime.pinned, false);
  assert.equal(result.deployment.recordedInWorkspace, false);
  assert.equal(result.deployment.workspaceRecordedId, STAGING_DEPLOYMENT_ID);
  assert.ok(result.failures.some((line) => /does not pin a runtime version and entry/u.test(line)));
  assert.ok(progress.some((line) => /latest completed production deployment is/u.test(line)));
});

test("delivery check refuses without a completed deployment, and production without --url, before touching the target", async (testContext) => {
  await testContext.test("no completed deployment", async (site) => {
    const workspace = await fixture(site);
    const wire = api(deliveryRoutes({ completed: false }));
    await assert.rejects(
      deliveryCheck(invoke(workspace, wire, { verb: "delivery check", deployTarget: "production", deliveryUrl: `${PUBLIC_ORIGIN}/`, browser: false }).invocation),
      (error) => error?.code === "delivery.no_completed_deployment",
    );
    assert.ok(wire.calls.every((call) => call.pathname.startsWith("/api/")));
  });
  await testContext.test("staging refuses --url", async (site) => {
    const workspace = await fixture(site);
    const wire = api(deliveryRoutes({ environment: "DEPLOYMENT_ENVIRONMENT_STAGING" }));
    await assert.rejects(
      deliveryCheck(invoke(workspace, wire, { verb: "delivery check", deployTarget: "staging", deliveryUrl: `${PUBLIC_ORIGIN}/`, browser: false }).invocation),
      (error) => error?.code === "delivery.url_not_for_staging" && error?.exitCode === 2,
    );
    assert.ok(wire.calls.every((call) => call.pathname.startsWith("/api/")));
  });
  await testContext.test("production needs --url", async (site) => {
    const workspace = await fixture(site);
    const wire = api(deliveryRoutes());
    await assert.rejects(
      deliveryCheck(invoke(workspace, wire, { verb: "delivery check", deployTarget: "production", browser: false }).invocation),
      (error) => error?.code === "delivery.production_url_required" && error?.exitCode === 2,
    );
    assert.ok(wire.calls.every((call) => call.pathname.startsWith("/api/")));
  });
});

test("delivery check --staging follows the handoff's host when the acknowledged host moved after the status read", async (site) => {
  const workspace = await fixture(site);
  const movedHost = `moved-${STAGING_HOST}`;
  const cookieValue = "C".repeat(43);
  const routes = deliveryRoutes({ environment: "DEPLOYMENT_ENVIRONMENT_STAGING" }).filter((route) => route.pattern.source !== "^\\/$");
  const wire = api([
    { method: "GET", pattern: STAGING_PREVIEW_STATUS, reply: { siteId: SITE_ID, ready: true, stagingUrl: `https://${STAGING_HOST}/` } },
    {
      method: "POST",
      pattern: STAGING_MINT,
      reply: {
        siteId: SITE_ID,
        stagingUrl: `https://${movedHost}/`,
        url: `https://${movedHost}/?__taproot_preview_handoff=${HANDOFF_TOKEN}`,
        handoffExpiresAt: HANDOFF_EXPIRES_AT,
      },
    },
    {
      method: "GET",
      pattern: STAGING_PREVIEW_ROOT,
      reply: (call) => {
        if (call.query.has("__taproot_preview_handoff")) {
          return new Response("", {
            status: 302,
            headers: {
              location: `https://${movedHost}/?__taproot_preview_check=1`,
              "set-cookie": `__Host-taproot_staging_preview=${cookieValue}; Path=/; Secure; HttpOnly; SameSite=Lax`,
            },
          });
        }
        if (call.query.has("__taproot_preview_check")) return new Response("", { status: 302, headers: { location: `https://${movedHost}/` } });
        return new Response(deliveredHtml([]), { status: 200, headers: { "content-type": "text/html" } });
      },
    },
    ...routes,
  ]);
  const { invocation, progress } = invoke(workspace, wire, { verb: "delivery check", deployTarget: "staging", browser: false });
  const result = await deliveryCheck(invocation);
  assert.equal(result.target.url, `https://${movedHost}/`);
  assert.ok(progress.some((line) => /staging host changed/u.test(line)));
});

test("delivery check --staging keeps a handoff-bearing browser redirect out of the result and GITHUB_OUTPUT, inside the output bound", async (site) => {
  const workspace = await fixture(site);
  const cookieValue = "D".repeat(43);
  const leaked = `https://${STAGING_HOST}/?__taproot_preview_handoff=${HANDOFF_TOKEN}`;
  const routes = deliveryRoutes({ environment: "DEPLOYMENT_ENVIRONMENT_STAGING" }).filter((route) => route.pattern.source !== "^\\/$");
  const wire = api([
    { method: "GET", pattern: STAGING_PREVIEW_STATUS, reply: { siteId: SITE_ID, ready: true, stagingUrl: `https://${STAGING_HOST}/` } },
    { method: "POST", pattern: STAGING_MINT, reply: { siteId: SITE_ID, stagingUrl: `https://${STAGING_HOST}/`, url: STAGING_HANDOFF_URL, handoffExpiresAt: HANDOFF_EXPIRES_AT } },
    {
      method: "GET",
      pattern: STAGING_PREVIEW_ROOT,
      reply: (call) => {
        if (call.query.has("__taproot_preview_handoff")) {
          return new Response("", {
            status: 302,
            headers: {
              location: `https://${STAGING_HOST}/?__taproot_preview_check=1`,
              "set-cookie": `__Host-taproot_staging_preview=${cookieValue}; Path=/; Secure; HttpOnly; SameSite=Lax`,
            },
          });
        }
        if (call.query.has("__taproot_preview_check")) return new Response("", { status: 302, headers: { location: `https://${STAGING_HOST}/` } });
        return new Response(deliveredHtml([]), { status: 200, headers: { "content-type": "text/html" } });
      },
    },
    ...routes,
  ]);
  // A browser whose every navigation lands on a same-origin URL that carries the handoff token.
  const listeners = new Map();
  const fakePlaywright = {
    chromium: {
      launch: async () => ({
        newBrowserCDPSession: async () => ({ send: async () => undefined, on: (event, listener) => listeners.set(event, listener) }),
        newContext: async () => ({
          addCookies: async () => undefined,
          newCDPSession: async () => ({ send: async () => undefined, on: (event, listener) => listeners.set(event, listener) }),
          newPage: async () => ({
            goto: async () => {
              listeners.get("Fetch.requestPaused")?.({ requestId: "r", request: { url: leaked } });
              const first = { url: () => `https://${STAGING_HOST}/` };
              return { request: () => ({ url: () => leaked, redirectedFrom: () => first }) };
            },
            url: () => leaked,
            waitForFunction: async () => undefined,
            evaluate: async () => ({ rootDefined: true, themeReady: true, loadingHeld: false, runtimeEntries: [leaked], capabilitiesDefined: 0 }),
          }),
          close: async () => undefined,
        }),
        close: async () => undefined,
      }),
    },
  };
  const { invocation, progress } = invoke(workspace, wire, { verb: "delivery check", deployTarget: "staging", importPlaywright: async () => fakePlaywright });
  const result = await deliveryCheck(invocation);
  assert.equal(result.browser.status, "checked");
  assert.equal(result.browser.fresh.finalUrl, "[withheld]");
  assert.equal(result.browser.fresh.loadedEntry, "[withheld]");
  assert.equal(result.browser.returning.finalUrl, "[withheld]");
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(HANDOFF_TOKEN));
  assert.ok(!serialized.includes(cookieValue));
  assert.ok(!progress.some((line) => line.includes(HANDOFF_TOKEN) || line.includes(cookieValue)));
  assert.ok(Buffer.byteLength(serialized, "utf8") <= LIMITS.githubOutputBytes);
  const outputPath = path.join(workspace.project, "github-output.txt");
  await writeFile(outputPath, "");
  await writeGithubActionsOutput(outputPath, result);
  const written = await readFile(outputPath, "utf8");
  assert.ok(written.includes("[withheld]"));
  assert.ok(!written.includes(HANDOFF_TOKEN));
  assert.ok(!written.includes(cookieValue));
});

test("staging review mints a fresh handoff on the presentation surface and reports it only in the result", async (site) => {
  const workspace = await fixture(site, {}, { config: { authoringSurface: "docs-presentation" } });
  const wire = api([{
    method: "POST",
    pattern: STAGING_MINT,
    reply: { siteId: SITE_ID, stagingUrl: `https://${STAGING_HOST}/`, url: STAGING_HANDOFF_URL, handoffExpiresAt: HANDOFF_EXPIRES_AT },
  }]);
  const { invocation, progress } = invoke(workspace, wire, { verb: "staging review", surface: "docs-presentation" });
  const result = await stagingReview(invocation);
  assert.equal(result.verb, "staging review");
  assert.equal(result.stagingPreview.url, STAGING_HANDOFF_URL);
  assert.match(result.stagingPreview.review, /light and dark/u);
  assert.ok(!progress.some((line) => line.includes(HANDOFF_TOKEN)));
  assert.equal(wire.matching("POST", STAGING_MINT).length, 1);
});

test("delivery check --staging resolves the acknowledged host, authorizes one preview session, and never reports the cookie", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([{ pageId: ABOUT_PAGE_ID, path: "about", title: "About" }]),
  });
  const cookieValue = "B".repeat(43);
  const routes = deliveryRoutes({ environment: "DEPLOYMENT_ENVIRONMENT_STAGING" }).filter((route) => !/^\/\$$/u.test(String(route.pattern)) && route.pattern.source !== "^\\/$");
  const wire = api([
    { method: "GET", pattern: STAGING_PREVIEW_STATUS, reply: { siteId: SITE_ID, ready: true, stagingUrl: `https://${STAGING_HOST}/` } },
    {
      method: "POST",
      pattern: STAGING_MINT,
      reply: { siteId: SITE_ID, stagingUrl: `https://${STAGING_HOST}/`, url: STAGING_HANDOFF_URL, handoffExpiresAt: HANDOFF_EXPIRES_AT },
    },
    {
      method: "GET",
      pattern: STAGING_PREVIEW_ROOT,
      reply: (call) => {
        if (call.query.has("__taproot_preview_handoff")) {
          return new Response("", {
            status: 302,
            headers: {
              location: `https://${STAGING_HOST}/?__taproot_preview_check=1`,
              "set-cookie": `__Host-taproot_staging_preview=${cookieValue}; Path=/; Secure; HttpOnly; SameSite=Lax`,
            },
          });
        }
        if (call.query.has("__taproot_preview_check")) {
          return new Response("", { status: 302, headers: { location: `https://${STAGING_HOST}/` } });
        }
        // The gated page: served only with the preview cookie.
        return call.headers?.cookie === `__Host-taproot_staging_preview=${cookieValue}`
          ? new Response(deliveredHtml(["/about/"]), { status: 200, headers: { "content-type": "text/html" } })
          : new Response("denied", { status: 403, headers: { "content-type": "text/html" } });
      },
    },
    ...routes,
  ]);
  const { invocation } = invoke(workspace, wire, { verb: "delivery check", deployTarget: "staging", browser: false });
  const result = await deliveryCheck(invocation);
  assert.equal(result.verdict, "delivered", JSON.stringify(result.failures));
  assert.equal(result.target.url, `https://${STAGING_HOST}/`);
  assert.equal(result.target.resolvedFrom, "staging-status");
  assert.equal(result.target.stagingAuthorized, true);
  assert.equal(wire.matching("POST", STAGING_MINT).length, 1);
  assert.ok(!JSON.stringify(result).includes(cookieValue));
  assert.ok(!JSON.stringify(result).includes(HANDOFF_TOKEN));
});

test("deploy --staging on a managed Docs site stages settings and skips the staging redirect inspection", async (site) => {
  const workspace = await fixture(site, {}, { config: { authoringSurface: "docs-presentation" } });
  const wire = api([
    {
      method: "GET",
      pattern: DEPLOY_REVIEW,
      reply: {
        stagedPages: [],
        settingsChanges: [{ settingsType: "SETTING_TYPE_TAPROOT_STYLES", changes: [{ path: "lightTheme" }] }],
        navigationChanged: false,
      },
    },
    ...deployRoutes(),
  ]);
  const result = await deploy(
    invoke(workspace, wire, { verb: "deploy", deployTarget: "staging", surface: "docs-presentation" }).invocation,
  );

  assert.equal(result.authoringSurface, "docs-presentation");
  assert.deepEqual(result.selection, {
    stagedPageCount: 0,
    selectedSettingsTypes: ["SETTING_TYPE_TAPROOT_STYLES"],
    includeNavigation: false,
  });
  assert.equal(result.nextStep, "deploy --production");
  // A settings-only stage still returns a usable review handoff (TR00800),
  // minted once after completion and never before the deployment.
  assert.equal(result.stagingPreview.stagingUrl, `https://${STAGING_HOST}/`);
  assert.equal(result.stagingPreview.url, STAGING_HANDOFF_URL);
  assert.equal(result.stagingPreview.handoffExpiresAt, HANDOFF_EXPIRES_AT);
  assert.match(result.stagingPreview.review, /light and dark/u);
  assert.equal(wire.matching("POST", STAGING_MINT).length, 1);
  assert.ok(wire.calls.findIndex((call) => STAGING_MINT.test(call.pathname)) > wire.calls.findIndex((call) => DEPLOY.test(call.pathname)));
  assert.equal(wire.matching("GET", STAGING_PREVIEW_ROOT).length, 0);
  const sent = wire.matching("POST", DEPLOY)[0].body;
  assert.deepEqual(sent.stagedPageIds, []);
  assert.equal(sent.includeNavigation, false);
});

test("deploy --staging on a managed Docs site reports a stable reason when no review handoff can be minted", async (testContext) => {
  for (
    const [name, reply, reason] of [
      ["no acknowledged staging host", () => jsonResponse(violation("Host", "Staging preview is unavailable."), 400), "staging.host_unavailable"],
      ["denied authority", () => jsonResponse({ code: 16, message: "unauthenticated" }, 401), "staging.authority_denied"],
      [
        "missing capability",
        () => jsonResponse(capabilityDenialBody("site.staging.view", ["site.settings.manage"], ["site.staging.view"]), 403),
        "staging.authority_denied",
      ],
      ["source became prebuilt", () => jsonResponse(violation("SiteId", "refused"), 400), "staging.surface_refused"],
      ["server failure", () => jsonResponse({ code: 13, message: "internal" }, 500), "staging.handoff_unavailable"],
    ]
  ) {
    await testContext.test(name, async (site) => {
      const workspace = await fixture(site, {}, { config: { authoringSurface: "docs-presentation" } });
      const wire = api([
        {
          method: "GET",
          pattern: DEPLOY_REVIEW,
          reply: {
            stagedPages: [],
            settingsChanges: [{ settingsType: "SETTING_TYPE_TAPROOT_STYLES", changes: [{ path: "lightTheme" }] }],
            navigationChanged: false,
          },
        },
        { method: "POST", pattern: STAGING_MINT, reply },
        ...deployRoutes().filter((route) => route.pattern !== STAGING_MINT),
      ]);
      const { invocation, progress } = invoke(workspace, wire, {
        verb: "deploy",
        deployTarget: "staging",
        surface: "docs-presentation",
      });
      const result = await deploy(invocation);
      assert.equal(result.ok, true);
      assert.equal(result.deployment.status, "DEPLOYMENT_STATUS_COMPLETED");
      assert.equal(result.stagingPreview.url, "");
      assert.equal(result.stagingPreview.reason, reason);
      assert.match(result.stagingPreview.recovery, /taproot-site/u);
      assert.doesNotMatch(result.stagingPreview.recovery, /production/u);
      assert.equal(result.nextStep, "staging review");
      assert.doesNotMatch(result.stagingPreview.recovery, /redirects check/u);
      assert.ok(progress.some((line) => line.includes(reason)));
    });
  }
});

test("deploy --staging on a managed Docs site refuses an explicit page or navigation selection before any read", async (context) => {
  for (const [name, extra] of [["pages", { stagedPageIds: [STORY_PAGE_ID] }], ["navigation", { includeNavigation: true }]]) {
    await context.test(name, async (child) => {
      const workspace = await fixture(child, {}, { config: { authoringSurface: "docs-presentation" } });
      const wire = api([]);
      await assert.rejects(
        deploy(
          invoke(workspace, wire, { verb: "deploy", deployTarget: "staging", surface: "docs-presentation", ...extra })
            .invocation,
        ),
        (error) => {
          assert.equal(error.code, "deploy.presentation_only");
          assert.equal(error.exitCode, 2);
          return true;
        },
      );
      assert.equal(wire.calls.length, 0);
    });
  }
});

test("deploy --staging on a managed Docs site with no settings change names the settings-only remedy", async (site) => {
  const workspace = await fixture(site, {}, { config: { authoringSurface: "docs-presentation" } });
  const wire = api([
    { method: "GET", pattern: DEPLOY_REVIEW, reply: { stagedPages: [], settingsChanges: [], navigationChanged: true } },
  ]);
  await assert.rejects(
    deploy(invoke(workspace, wire, { verb: "deploy", deployTarget: "staging", surface: "docs-presentation" }).invocation),
    (error) => {
      assert.equal(error.code, "deploy.empty_selection");
      assert.match(error.message, /stages settings only/u);
      assert.doesNotMatch(error.message, /approve/u);
      return true;
    },
  );
  assert.equal(wire.matching("POST", DEPLOY).length, 0);
});

test("deploy --staging on a managed Docs site ignores the review's page and navigation defaults, like the Deployments page", async (site) => {
  const workspace = await fixture(site, {}, { config: { authoringSurface: "docs-presentation" } });
  // A Docs site's settings-only production manifest makes any draft
  // navigation row read as changed forever; the review is site-type-blind.
  const wire = api([
    {
      method: "GET",
      pattern: DEPLOY_REVIEW,
      reply: {
        stagedPages: [{ pageId: STORY_PAGE_ID }],
        settingsChanges: [{ settingsType: "SETTING_TYPE_BRAND", changes: [{ path: "faviconId" }] }],
        navigationChanged: true,
      },
    },
    ...deployRoutes(),
  ]);
  const result = await deploy(
    invoke(workspace, wire, { verb: "deploy", deployTarget: "staging", surface: "docs-presentation" }).invocation,
  );

  assert.deepEqual(result.selection, {
    stagedPageCount: 0,
    selectedSettingsTypes: ["SETTING_TYPE_BRAND"],
    includeNavigation: false,
  });
  const sent = wire.matching("POST", DEPLOY)[0].body;
  assert.deepEqual(sent.stagedPageIds, []);
  assert.equal(sent.includeNavigation, false);
  assert.deepEqual(sent.selectedSettingsTypes, ["SETTING_TYPE_BRAND"]);
});

test("a content verb on a managed Docs site is refused offline, before any request", async (context) => {
  const cases = [
    { name: "pages push", run: pagesPush, extra: { verb: "pages push" } },
    { name: "nav push", run: navPush, extra: { verb: "nav push" } },
    { name: "approve", run: approve, extra: { verb: "approve" } },
  ];
  for (const { name, run, extra } of cases) {
    await context.test(name, async (child) => {
      const workspace = await fixture(child, {}, { config: { authoringSurface: "docs-presentation" } });
      const wire = api([]);
      await assert.rejects(run(invoke(workspace, wire, { ...extra, surface: "standard" }).invocation), (error) => {
        assert.equal(error.code, "surface.presentation_only");
        assert.equal(error.exitCode, 2);
        assert.match(error.message, new RegExp(`'${name}' does not apply to a managed Docs site`, "u"));
        return true;
      });
      assert.equal(wire.calls.length, 0);
    });
  }
});

test("every site verb on a prebuilt Docs site is refused offline with surface.none", async (context) => {
  for (const [name, run] of [["pull", pull], ["theme push", themePush], ["status", status]]) {
    await context.test(name, async (child) => {
      const workspace = await fixture(child, {}, { config: { authoringSurface: "none" } });
      const wire = api([]);
      await assert.rejects(
        run(invoke(workspace, wire, { verb: name, surface: VERB_SURFACES[name] }).invocation),
        (error) => {
          assert.equal(error.code, "surface.none");
          assert.equal(error.status, "none");
          return true;
        },
      );
      assert.equal(wire.calls.length, 0);
    });
  }
});

test("the verb table declares a surface for exactly the site verbs, and pages-side verbs need a standard site", () => {
  assert.deepEqual(new Set(Object.keys(VERB_SURFACES)), new Set(Object.keys(VERB_CAPABILITIES)));
  for (const verb of ["pages push", "nav push", "redirects check", "redirects pull", "redirects push", "approve", "preview page", "preview revoke"]) {
    assert.equal(VERB_SURFACES[verb], "standard", verb);
  }
  for (const verb of ["pull", "theme push", "footer push", "media upload", "deploy", "status"]) {
    assert.equal(VERB_SURFACES[verb], "docs-presentation", verb);
  }
});

test("the CLI passes each verb's surface through to its handler", async () => {
  let received;
  const exitCode = await runCli({
    arguments_: ["pages", "push"],
    environment: { TAPROOT_SITE_KEY: TOKEN },
    handlers: {
      "pages push": async (invocation) => {
        received = invocation.surface;
        return { ok: true, verb: "pages push" };
      },
    },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  });
  assert.equal(exitCode, 0);
  assert.equal(received, "standard");
});

test("no site verb asks its surface for nothing, because an empty request means the whole envelope", () => {
  for (const [verb, surface] of Object.entries(VERB_SURFACES)) {
    const request = verbCapabilitiesForSurface(verb, surface);
    assert.ok(request.length > 0, `${verb} on ${surface}`);
    // Every capability asked for is one the surface offers.
    if (surface === "docs-presentation") {
      assert.ok(!request.includes(CAPABILITY_CONTENT), verb);
    }
  }
  // The one verb that needed its own declaration: Content is what it holds on
  // a standard site, Design is what carries site.media.manage on a Docs site.
  assert.deepEqual(verbCapabilitiesForSurface("media upload", "standard"), [CAPABILITY_CONTENT]);
  assert.deepEqual(verbCapabilitiesForSurface("media upload", "docs-presentation"), [CAPABILITY_DESIGN]);
});

test("a cover image the page does not use stops the whole push before any request is sent", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([]),
    ".taproot-site-media.json": TYPED_MEDIA_MANIFEST,
    "pages/ok.md": "---\ntitle: Fine\npath: journal/fine\ntemplate: article\n---\n\nText.\n",
    "pages/story.md": "---\ntitle: Story\npath: journal/story\ntemplate: article\ncoverImage: media/cover.jpg\n---\n\nNo picture.\n",
  });
  const wire = api(typedCreateRoutes());
  await assert.rejects(
    pagesPush(invoke(workspace, wire, { verb: "pages push", content: REAL_CONTENT }).invocation),
    (error) =>
      error?.code === "pages.cover_image_unused"
      && /The selected cover image must be used by this page\./u.test(error.message),
  );
  assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
});

// ---------------------------------------------------------------------------
// Whole-workspace checks: validate on a pulled workspace, pages push
// --dry-run, plan and apply (TR01002, TR00823)
// ---------------------------------------------------------------------------

const HOME_ENTRY = Object.freeze({
  pageId: HOME_PAGE_ID,
  resourceId: resourceIdFor(HOME_PAGE_ID),
  path: "",
  title: "Home",
  description: "The front door.",
  status: "PAGE_STATUS_PUBLISHED",
  templateType: "TEMPLATE_TYPE_FREE_FORM",
  file: "pages/index.pm.json",
  sourceFormat: "prosemirror",
});

/** A complete pulled workspace: settings, navigation, a tracked home page, and a new page with new media. */
const STUDIO_MEDIA_MANIFEST = Object.freeze({
  mediaManifestVersion: 2,
  siteId: SITE_ID,
  media: { "media/studio.png": { imageId: IMAGE_ID, contentHash: contentHashOf(png(1200, 800)), src: "", urls: [], width: 1200, height: 800 } },
});

function contentHashOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function wholeWorkspace({ navItems = [], files = {}, uploaded = false } = {}) {
  const theme = themeWorkspace();
  return {
    ...theme,
    ...(uploaded ? { ".taproot-site-media.json": STUDIO_MEDIA_MANIFEST } : {}),
    ".taproot-site-manifest.json": {
      ...theme[".taproot-site-manifest.json"],
      pages: [{ workspaceMode: "editable", ...HOME_ENTRY }],
    },
    "nav.json": { siteId: SITE_ID, navItems },
    "pages/index.pm.json": paragraphDocument("Welcome home."),
    "pages/about.md": "---\ntitle: About us\npath: about\n---\n\n![The studio](media/studio.png)\n",
    "media/studio.png": png(1200, 800),
    ...files,
  };
}

const BROKEN_PAGES = Object.freeze({
  "pages/bad-path.md": "---\ntitle: Bad path\npath: Hello World\n---\n\nText.\n",
  "pages/missing-media.md": "---\ntitle: Missing\npath: missing\n---\n\n![Gone](media/gone.png)\n",
});

/** The site's side of a whole-workspace run, with pages that a create or update really changes. */
function siteRoutes({
  live = [pageSummary({ pageId: HOME_PAGE_ID, path: "", title: "Home" })],
  navItems = [],
  presentationSave = (call) => presentationSaveReply(call),
  site = { presentationRevision: PRESENTATION_REVISION },
  // The footer the workspace was pulled with, so its draft is current.
  footerSettings = themeWorkspace()["settings/site-publishing-preferences.json"].settings.footerSettings,
} = {}) {
  const pages = [...live];
  return [
    { method: "GET", pattern: PAGES_LIST, reply: () => ({ pages, nextPageToken: "" }) },
    {
      method: "POST",
      pattern: PAGES_COLLECTION,
      reply: (call) => {
        const summary = draftSummary(NEW_PAGE_ID, call.body.path);
        pages.push(summary);
        return summary;
      },
    },
    { method: "PATCH", pattern: PAGE_BY_ID, reply: (call) => draftSummary(call.body.pageId, call.body.path) },
    {
      method: "GET",
      pattern: PRESENTATION,
      reply: () => presentationReply({ revision: site.presentationRevision, footerSettings }),
    },
    { method: "POST", pattern: PRESENTATION, reply: presentationSave },
    { method: "POST", pattern: FOOTER_SETTINGS, reply: (call) => ({ footerSettings: call.body.footerSettings }) },
    { method: "GET", pattern: NAVIGATION, reply: { navItems } },
    { method: "PUT", pattern: NAVIGATION, reply: (call) => ({ navItems: call.body.navItems }) },
    ...uploadRoutes(),
  ];
}

function cliRun(site, arguments_, wire, content = REAL_CONTENT) {
  let stdout = "";
  let stderr = "";
  return runCli({
    arguments_: ["--config", site.configPath, ...arguments_],
    environment: { TAPROOT_SITE_KEY: TOKEN, XDG_CONFIG_HOME: site.configHome },
    cwd: site.project,
    stdout: { write: (chunk) => (stdout += chunk) },
    stderr: { write: (chunk) => (stderr += chunk) },
    handlers: Object.fromEntries(Object.entries(VERB_HANDLERS).map(([name, handler]) => [
      name,
      (invocation) => handler({ ...invocation, content }),
    ])),
    fetch: wire === undefined
      ? async () => assert.fail("an offline verb made a request")
      : capabilityGatedFetch(
        Object.hasOwn(VERB_CAPABILITIES, arguments_.slice(0, 2).join(" ")) ? arguments_.slice(0, 2).join(" ") : arguments_[0],
        wire.fetch,
      ),
  }).then((exitCode) => ({ exitCode, result: JSON.parse(stdout), stderr }));
}

function writes(wire) {
  return wire.calls.filter((call) => call.method !== "GET");
}

test("validate checks a pulled workspace with no credential or request and reports every problem at once", async (site) => {
  const clean = await fixture(site, wholeWorkspace({ uploaded: true }));
  const passed = await cliRun(clean, ["validate"]);
  assert.equal(passed.exitCode, 0, passed.stderr);
  assert.equal(passed.result.offline, true);
  assert.deepEqual(passed.result.workspace, { manifest: ".taproot-site-manifest.json", settingsOnly: false });
  assert.equal(passed.result.validated.pages.total, 2);

  const broken = await fixture(site, wholeWorkspace({
    navItems: [{ id: navId(1), kind: "NAV_ITEM_KIND_PAGE", title: "Nowhere", resourceId: resourceIdFor(STORY_PAGE_ID) }],
    files: BROKEN_PAGES,
    uploaded: true,
  }));
  const failed = await cliRun(broken, ["validate"]);
  assert.equal(failed.exitCode, 1);
  const found = failed.result.error.problems.map((problem) => [problem.area, problem.file, problem.code]);
  assert.deepEqual(found, [
    ["navigation", "nav.json", "nav.resource_unknown"],
    ["pages", "pages/bad-path.md", "pages.path_unsupported"],
    ["pages", "pages/missing-media.md", "content.markdown_image"],
  ]);
  assert.equal(failed.result.error.problemCount, 3);
  assert.equal(failed.result.error.code, "nav.resource_unknown");
  for (const [, file] of found) assert.ok(failed.stderr.includes(file), `stderr names ${file}`);
});

test("pages push --dry-run checks every page against the site, lists what it would send, and sends nothing", async (site) => {
  const workspace = await fixture(site, wholeWorkspace({ uploaded: true }));
  const wire = api(siteRoutes());
  const clean = await cliRun(workspace, ["pages", "push", "--dry-run"], wire);
  assert.equal(clean.exitCode, 0, clean.stderr);
  assert.equal(clean.result.dryRun, true);
  assert.equal(clean.result.pages.wouldCreate, 1);
  assert.equal(clean.result.pages.wouldUpdate, 1);
  assert.deepEqual(clean.result.pages.items.map((item) => [item.path, item.action]), [
    ["about", "created"],
    ["/", "updated"],
  ]);
  assert.deepEqual(writes(wire), []);

  for (const [file, contents] of Object.entries(BROKEN_PAGES)) {
    await writeFile(workspacePath(workspace, file), contents);
  }
  const refused = await cliRun(workspace, ["pages", "push", "--dry-run"], wire);
  assert.equal(refused.exitCode, 1);
  assert.deepEqual(refused.result.error.problems.map((problem) => [problem.file, problem.code]), [
    ["pages/bad-path.md", "pages.path_unsupported"],
    ["pages/missing-media.md", "content.markdown_image"],
  ]);
  // The real push refuses with the same list before sending anything.
  const pushed = await cliRun(workspace, ["pages", "push"], wire);
  assert.equal(pushed.exitCode, 1);
  assert.equal(pushed.result.error.problemCount, 2);
  assert.deepEqual(writes(wire), []);
});

test("validate refuses a description over 1000 characters (TR01194)", async (site) => {
  const long = await fixture(site, wholeWorkspace({
    uploaded: true,
    files: { "pages/notes.md": `---\ntitle: Notes\npath: notes\ndescription: ${"x".repeat(1001)}\n---\n\nText.\n` },
  }));
  const refused = await cliRun(long, ["validate"]);
  assert.equal(refused.exitCode, 1);
  const codes = [refused.result.error.code, ...(refused.result.error.problems ?? []).map((problem) => problem.code)];
  assert.ok(codes.includes("pages.description_too_long"), JSON.stringify(refused.result.error));
});

test("validate warns on a description search results will cut off (TR01194)", async (site) => {
  const workspace = await fixture(site, wholeWorkspace({
    uploaded: true,
    files: { "pages/notes.md": `---\ntitle: Notes\npath: notes\ndescription: ${"x".repeat(200)}\n---\n\nText.\n` },
  }));
  const validated = await cliRun(workspace, ["validate"]);
  assert.equal(validated.exitCode, 0, validated.stderr);
  assert.deepEqual(validated.result.descriptionWarnings.items.map((item) => [item.file, item.length]), [
    ["pages/notes.md", 200],
  ]);
});

/** A pulled workspace that also tracks one generated tag page. */
function workspaceWithGeneratedTag(data) {
  const base = wholeWorkspace({ uploaded: true });
  const identity = {
    kind: "GENERATED_PAGE_KIND_TAG",
    tagId: TAG_ID,
    year: 0,
    month: 0,
    countryCode: "",
    regionCode: "",
    citySlug: "",
    categorySlug: "",
  };
  return {
    ...base,
    ".taproot-site-manifest.json": {
      ...base[".taproot-site-manifest.json"],
      pages: [
        ...base[".taproot-site-manifest.json"].pages,
        {
          pageId: TAG_PAGE_ID,
          resourceId: resourceIdFor(TAG_PAGE_ID),
          path: "tags/trails",
          title: "Trails",
          description: "y".repeat(400),
          status: "PAGE_STATUS_PUBLISHED",
          templateType: "TEMPLATE_TYPE_GENERATED",
          isGenerated: true,
          file: TAG_SOURCE,
          sourceFormat: "prosemirror",
          workspaceMode: "editable",
          generated: identity,
        },
      ],
    },
    [TAG_SOURCE]: {
      template: "generated",
      data: { ...identity, customTitle: "", breadcrumbTitle: "", customDescription: "", ...data },
    },
  };
}

test("validate accepts a pulled generated page and warns on its custom description only (TR01195)", async (site) => {
  const plain = await fixture(site, workspaceWithGeneratedTag({}));
  const accepted = await cliRun(plain, ["validate"]);
  assert.equal(accepted.exitCode, 0, accepted.stderr);
  // The long description the site derived is not the owner's to shorten.
  assert.equal(accepted.result.descriptionWarnings, undefined);

  const long = await fixture(site, workspaceWithGeneratedTag({
    customDescription: "x".repeat(200),
    introductionBody: paragraphDocument("Intro."),
  }));
  const warned = await cliRun(long, ["validate"]);
  assert.equal(warned.exitCode, 0, warned.stderr);
  assert.deepEqual(warned.result.descriptionWarnings.items.map((item) => [item.file, item.length]), [[TAG_SOURCE, 200]]);

  const refused = await fixture(site, workspaceWithGeneratedTag({ customDescription: "x".repeat(1001) }));
  const failed = await cliRun(refused, ["validate"]);
  assert.equal(failed.exitCode, 1);
  const codes = [failed.result.error.code, ...(failed.result.error.problems ?? []).map((problem) => problem.code)];
  assert.ok(codes.includes("pages.description_too_long"), JSON.stringify(failed.result.error));
});

test("validate refuses a generated page whose identity was edited, and autolinks in its introduction are warned about (TR01195)", async (site) => {
  const edited = await fixture(site, workspaceWithGeneratedTag({ kind: "GENERATED_PAGE_KIND_FOLDER_INDEX" }));
  const failed = await cliRun(edited, ["validate"]);
  assert.equal(failed.exitCode, 1);
  const codes = [failed.result.error.code, ...(failed.result.error.problems ?? []).map((problem) => problem.code)];
  assert.ok(codes.includes("pages.generated_identity"), JSON.stringify(failed.result.error));

  const linked = await fixture(site, workspaceWithGeneratedTag({
    introductionBody: {
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{
          type: "text",
          text: "ASP.NET",
          marks: [{ type: "link", attrs: { href: "http://ASP.NET" } }],
        }],
      }],
    },
  }));
  const warned = await cliRun(linked, ["validate"]);
  assert.equal(warned.exitCode, 0, warned.stderr);
  assert.deepEqual(warned.result.linkWarnings.items.map((item) => [item.code, item.file, item.text]), [
    ["content.link_autolinked", TAG_SOURCE, "ASP.NET"],
  ]);
});

test("validate and pages push --dry-run warn on an autolink-shaped link without refusing (TR01198)", async (site) => {
  const workspace = await fixture(site, wholeWorkspace({
    uploaded: true,
    files: { "pages/notes.md": "---\ntitle: Notes\npath: notes\n---\n\nBuilt on [ASP.NET](http://ASP.NET) Core.\n" },
  }));
  const validated = await cliRun(workspace, ["validate"]);
  assert.equal(validated.exitCode, 0, validated.stderr);
  assert.deepEqual(validated.result.linkWarnings.items.map((item) => [item.code, item.file, item.text]), [
    ["content.link_autolinked", "pages/notes.md", "ASP.NET"],
  ]);
  assert.ok(validated.stderr.includes("looks made by autolinking"));
  const wire = api(siteRoutes());
  const dryRun = await cliRun(workspace, ["pages", "push", "--dry-run"], wire);
  assert.equal(dryRun.exitCode, 0, dryRun.stderr);
  assert.equal(dryRun.result.linkWarnings.total, 1);
  assert.deepEqual(writes(wire), []);
});

test("a refusal's problem list stays inside the result bound however many pages fail", async (site) => {
  const files = {};
  for (let index = 0; index < 400; index += 1) {
    files[`pages/broken-${String(index).padStart(3, "0")}.md`] =
      `---\ntitle: Broken ${index}\npath: Broken Page ${index}\n---\n\nText.\n`;
  }
  const workspace = await fixture(site, wholeWorkspace({ files, uploaded: true }));
  const failed = await cliRun(workspace, ["validate"]);
  assert.equal(failed.exitCode, 1);
  assert.deepEqual(failed.stderr.split("\n").filter((line) => line.startsWith("  ") && !line.includes("[pages.path_unsupported]")), []);
  assert.equal(failed.result.error.problemCount, 400);
  assert.equal(failed.result.error.problemsTruncated, true);
  assert.ok(failed.result.error.problems.length > 50);
  assert.ok(failed.result.error.problems.length < 400);
  // stderr carries every one.
  assert.equal(failed.stderr.split("\n").filter((line) => line.startsWith("  pages/broken-")).length, 400);
});

test("plan orders the remaining steps, binds them to a hash, and writes nothing", async (site) => {
  const workspace = await fixture(site, wholeWorkspace({
    navItems: [{ id: navId(1), kind: "NAV_ITEM_KIND_EXTERNAL_URL", title: "Blog", externalUrl: "https://example.com/blog" }],
  }));
  const wire = api(siteRoutes());
  const planned = await cliRun(workspace, ["plan"], wire);

  assert.equal(planned.exitCode, 0, planned.stderr);
  assert.match(planned.result.planHash, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(planned.result.problems, []);
  assert.equal(planned.result.ready, true);
  assert.deepEqual(planned.result.steps.map((entry) => [entry.step, entry.status]), [
    ["media upload", "ready"],
    ["pages push", "ready"],
    ["footer push", "nothing to do"],
    ["theme push", "ready"],
    ["nav push", "ready"],
  ]);
  assert.deepEqual(planned.result.steps[0].items, ["media/studio.png"]);
  assert.equal(planned.result.steps[1].create, 1);
  assert.equal(planned.result.steps[1].update, 1);
  assert.ok(planned.result.steps.every((entry) => typeof entry.reason === "string"));
  assert.deepEqual(writes(wire), []);
  // Nothing in the workspace moved either: the same plan hashes the same.
  const again = await cliRun(workspace, ["plan"], wire);
  assert.equal(again.result.planHash, planned.result.planHash);
});

test("plan marks the step a problem blocks, and apply refuses that plan without writing", async (site) => {
  const workspace = await fixture(site, wholeWorkspace({
    navItems: [{ id: navId(1), kind: "NAV_ITEM_KIND_PAGE", title: "Story", resourceId: resourceIdFor(STORY_PAGE_ID) }],
  }));
  const wire = api(siteRoutes());
  const planned = await cliRun(workspace, ["plan"], wire);
  assert.equal(planned.exitCode, 0);
  assert.equal(planned.result.ready, false);
  assert.equal(planned.result.steps.find((entry) => entry.step === "nav push").status, "blocked");
  assert.deepEqual(planned.result.problems.map((problem) => problem.code), ["nav.resource_unknown"]);

  const applied = await cliRun(workspace, ["apply", "--plan", planned.result.planHash], wire);
  assert.equal(applied.exitCode, 1);
  assert.equal(applied.result.error.code, "nav.resource_unknown");
  assert.deepEqual(writes(wire), []);
});

test("apply refuses a plan the workspace has moved past", async (site) => {
  const workspace = await fixture(site, wholeWorkspace());
  const wire = api(siteRoutes());
  const planned = await cliRun(workspace, ["plan"], wire);
  await writeFile(workspacePath(workspace, "pages/about.md"), "---\ntitle: About us\npath: about\n---\n\nRewritten.\n");

  const applied = await cliRun(workspace, ["apply", "--plan", planned.result.planHash], wire);
  assert.equal(applied.exitCode, 1);
  assert.equal(applied.result.error.code, "apply.plan_stale");
  assert.equal(applied.result.error.field, "planHash");
  assert.deepEqual(writes(wire), []);
  const usage = await cliRun(workspace, ["apply"], wire);
  assert.equal(usage.exitCode, 2);
  assert.equal(usage.result.error.code, "apply.plan_required");
});

test("an apply that fails partway reports each step, and the next plan picks up where it stopped", async (site) => {
  const workspace = await fixture(site, wholeWorkspace({
    navItems: [{ id: navId(1), kind: "NAV_ITEM_KIND_EXTERNAL_URL", title: "Blog", externalUrl: "https://example.com/blog" }],
  }));
  const wire = api(siteRoutes({
    presentationSave: () => jsonResponse(violation("StyleSettings", "refused for the test"), 400),
  }));
  const planned = await cliRun(workspace, ["plan"], wire);
  const failed = await cliRun(workspace, ["apply", "--plan", planned.result.planHash], wire);

  assert.equal(failed.exitCode, 1);
  assert.deepEqual(failed.result.error.completedWrites, [
    "media upload: completed",
    "pages push: completed",
    "theme push: failed",
    "nav push: not run",
  ]);
  assert.equal(wire.matching("PUT", NAVIGATION).length, 0);
  assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 1);

  // What finished reads as finished; what failed or never ran is still ready.
  const replanned = await cliRun(workspace, ["plan"], wire);
  assert.deepEqual(replanned.result.steps.map((entry) => [entry.step, entry.status]), [
    ["media upload", "nothing to do"],
    ["pages push", "nothing to do"],
    ["footer push", "nothing to do"],
    ["theme push", "ready"],
    ["nav push", "ready"],
  ]);
  assert.notEqual(replanned.result.planHash, planned.result.planHash);
});

test("an unexpected error in an apply step still reports the steps that completed", async (site) => {
  const workspace = await fixture(site, wholeWorkspace());
  const wire = api(siteRoutes());
  // Converts as usual while planning, then fails the way a bug would when the
  // pages step converts again.
  let conversions = 0;
  const content = {
    validateDocument,
    markdownToProseMirror: async (...arguments_) => {
      conversions += 1;
      if (conversions > 2) throw new TypeError("unexpected");
      return await markdownToProseMirror(...arguments_);
    },
  };
  const planned = await cliRun(workspace, ["plan"], wire, content);
  const failed = await cliRun(workspace, ["apply", "--plan", planned.result.planHash], wire, content);

  assert.equal(failed.exitCode, 1);
  assert.equal(failed.result.error.code, "apply.step_failed");
  assert.match(failed.stderr, /pages push failed unexpectedly \(TypeError\)/u);
  assert.deepEqual(failed.result.error.completedWrites.slice(0, 2), ["media upload: completed", "pages push: failed"]);
  assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
});

test("apply runs every ready step in order through the push verbs and reports what it applied", async (site) => {
  const workspace = await fixture(site, wholeWorkspace({
    navItems: [{ id: navId(1), kind: "NAV_ITEM_KIND_EXTERNAL_URL", title: "Blog", externalUrl: "https://example.com/blog" }],
  }));
  // A footer content edit, which footer push owns and theme push refuses to overwrite.
  const publishingFile = "settings/site-publishing-preferences.json";
  const publishing = await readWorkspaceJson(workspace, publishingFile);
  publishing.settings.footerSettings.enabled = true;
  await writeFile(workspacePath(workspace, publishingFile), `${JSON.stringify(publishing, undefined, 2)}\n`);
  const wire = api(siteRoutes());

  const planned = await cliRun(workspace, ["plan"], wire);
  assert.equal(planned.result.steps.find((entry) => entry.step === "footer push").status, "ready");
  const applied = await cliRun(workspace, ["apply", "--plan", planned.result.planHash], wire);

  assert.equal(applied.exitCode, 0, applied.stderr);
  assert.deepEqual(applied.result.applied.map((entry) => entry.step), [
    "media upload",
    "pages push",
    "footer push",
    "theme push",
    "nav push",
  ]);
  assert.deepEqual(applied.result.skipped, []);
  assert.equal(applied.result.nextStep, "approve");
  assert.deepEqual(applied.result.applied[1].result, { created: 1, updated: 1, unchanged: 0 });
  // The writes reached the site in the plan's order.
  const order = writes(wire).map((call) => {
    if (REQUEST_UPLOAD.test(call.pathname) || CONFIRM_UPLOAD.test(call.pathname) || PRESIGNED_PUT.test(call.pathname)) return "media";
    if (PAGES_COLLECTION.test(call.pathname) || PAGE_BY_ID.test(call.pathname)) return "pages";
    if (FOOTER_SETTINGS.test(call.pathname)) return "footer";
    if (PRESENTATION.test(call.pathname)) return "theme";
    return NAVIGATION.test(call.pathname) ? "nav" : call.pathname;
  });
  assert.deepEqual([...new Set(order)], ["media", "pages", "footer", "theme", "nav"]);
  // Nothing is deployed or approved.
  assert.equal(wire.matching("POST", PUBLISH_DRAFTS).length, 0);
  assert.equal(wire.matching("POST", DEPLOY).length, 0);
});

test("component and section images name a media path the same apply uploads", async (site) => {
  const about = "---\ntitle: About us\npath: about\n---\n\n"
    + "```component:image-banner\n{\"image\":\"media/studio.png\",\"overlayText\":\"Visit\"}\n```\n\n"
    + ":::section {\"background\":{\"image\":\"media/studio.png\"}}\n## Our studio\n:::\n";
  const workspace = await fixture(site, wholeWorkspace({ files: { "pages/about.md": about } }));
  const wire = api(siteRoutes());

  const planned = await cliRun(workspace, ["plan"], wire);
  assert.deepEqual(planned.result.problems, []);
  const applied = await cliRun(workspace, ["apply", "--plan", planned.result.planHash], wire);
  assert.equal(applied.exitCode, 0, applied.stderr);

  // Each path resolves to the record media upload wrote; the server fills the delivery URLs.
  const { imageId } = (await readWorkspaceJson(workspace, ".taproot-site-media.json")).media["media/studio.png"];
  const stored = { imageId, src: "", urls: [], width: 1200, height: 800, alt: "" };
  const body = wire.matching("POST", PAGES_COLLECTION)[0].body.template.freeFormData.body;
  const banner = body.content.find((node) => node.type === "componentBlock");
  assert.deepEqual(JSON.parse(banner.attrs.componentData).image, stored);
  assert.deepEqual(body.content.find((node) => node.type === "section").attrs.background.image, stored);
});

test("apply refuses a plan the site has moved past", async (site) => {
  const workspace = await fixture(site, wholeWorkspace());
  const state = { presentationRevision: PRESENTATION_REVISION };
  const wire = api(siteRoutes({ site: state }));
  const planned = await cliRun(workspace, ["plan"], wire);
  state.presentationRevision = NEXT_PRESENTATION_REVISION;

  const applied = await cliRun(workspace, ["apply", "--plan", planned.result.planHash], wire);
  assert.equal(applied.exitCode, 1);
  assert.equal(applied.result.error.code, "apply.plan_stale");
  assert.deepEqual(writes(wire), []);
});

test("a media file replaced after the plan makes the plan stale", async (site) => {
  const workspace = await fixture(site, wholeWorkspace());
  const wire = api(siteRoutes());
  const planned = await cliRun(workspace, ["plan"], wire);
  await writeFile(workspacePath(workspace, "media/studio.png"), png(1300, 800));

  const applied = await cliRun(workspace, ["apply", "--plan", planned.result.planHash], wire);
  assert.equal(applied.exitCode, 1);
  assert.equal(applied.result.error.code, "apply.plan_stale");
  assert.deepEqual(writes(wire), []);
});

test("plan blocks pages on a manifest whose source registry contradicts itself", async (site) => {
  const files = wholeWorkspace();
  const manifest = structuredClone(files[".taproot-site-manifest.json"]);
  manifest.pages.push({ ...manifest.pages[0], pageId: ABOUT_PAGE_ID, resourceId: resourceIdFor(ABOUT_PAGE_ID), path: "about" });
  const workspace = await fixture(site, { ...files, ".taproot-site-manifest.json": manifest });
  const wire = api(siteRoutes());

  const planned = await cliRun(workspace, ["plan"], wire);
  assert.equal(planned.result.ready, false);
  assert.equal(planned.result.steps.find((entry) => entry.step === "pages push").status, "blocked");
  assert.deepEqual(planned.result.problems.map((problem) => [problem.area, problem.code]), [
    ["pages", "workspace.manifest_invalid"],
  ]);
});

test("plan refuses a Docs workspace, which holds its settings only", async (site) => {
  const files = wholeWorkspace();
  const workspace = await fixture(site, {
    ...files,
    ".taproot-site-manifest.json": { ...files[".taproot-site-manifest.json"], authoringSurface: "docs-presentation" },
  });
  const planned = await cliRun(workspace, ["plan"], api(siteRoutes()));
  assert.equal(planned.exitCode, 2);
  assert.equal(planned.result.error.code, "plan.surface_unsupported");
});

test("plan keeps its problem list inside the result bound", async (site) => {
  const files = {};
  for (let index = 0; index < 300; index += 1) {
    files[`pages/broken-${String(index).padStart(3, "0")}.md`] =
      `---\ntitle: Broken ${index}\npath: Broken Page With A Long Name Number ${index}\n---\n\nText.\n`;
  }
  const workspace = await fixture(site, wholeWorkspace({ files }));
  const planned = await cliRun(workspace, ["plan"], api(siteRoutes()));
  assert.equal(planned.exitCode, 0, planned.stderr);
  assert.equal(planned.result.problemCount, 300);
  assert.equal(planned.result.problemsTruncated, true);
  assert.ok(planned.result.problems.length < 300);
});

test("validate judges redirect sources against the paths the workspace's own sources will hold", async (site) => {
  const files = wholeWorkspace({ uploaded: true });
  const manifest = {
    ...files[".taproot-site-manifest.json"],
    redirects: { file: "redirects.json", revision: REDIRECT_REVISION, entries: 1 },
    pages: [
      ...files[".taproot-site-manifest.json"].pages,
      {
        workspaceMode: "editable",
        pageId: STORY_PAGE_ID,
        resourceId: resourceIdFor(STORY_PAGE_ID),
        path: "old-story",
        title: "Story",
        status: "PAGE_STATUS_PUBLISHED",
        templateType: "TEMPLATE_TYPE_FREE_FORM",
        file: "pages/story.md",
        sourceFormat: "markdown",
      },
    ],
  };
  // The source renames the page, so its old path is free for a redirect.
  const renamed = await fixture(site, {
    ...files,
    ".taproot-site-manifest.json": manifest,
    "pages/story.md": "---\ntitle: Story\npath: story\n---\n\nText.\n",
    "redirects.json": redirectsDocument([{ path: "/old-story", target: "/story" }]),
  });
  const passed = await cliRun(renamed, ["validate"]);
  assert.equal(passed.exitCode, 0, passed.stderr);

  // A new source at a redirect's source path is the collision the site refuses.
  const occupied = await fixture(site, {
    ...files,
    ".taproot-site-manifest.json": { ...manifest, pages: files[".taproot-site-manifest.json"].pages },
    "redirects.json": redirectsDocument([{ path: "/about", target: "/" }]),
  });
  const failed = await cliRun(occupied, ["validate"]);
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.result.error.code, "redirects.path_occupied");
});

/**
 * Sends the workspace's presentation in a save whose answer is lost, and
 * returns what the site then holds: exactly the workspace's change set, one
 * revision on. The workspace keeps the pending record that save left.
 */
async function committedLostSave(workspace) {
  let committed;
  const lostWire = api([
    { method: "GET", pattern: PRESENTATION, reply: presentationReply() },
    {
      method: "POST",
      pattern: PRESENTATION,
      reply: (call) => {
        committed = call.body;
        throw new Error("socket hang up");
      },
    },
  ]);
  await assert.rejects(themePush(invoke(workspace, lostWire, { verb: "theme push" }).invocation));
  const held = { siteId: SITE_ID, revision: NEXT_PRESENTATION_REVISION, sitePublishingPreferences: {} };
  for (const group of SETTINGS_GROUPS) held[group.responseProperty] ??= {};
  for (const write of committed.settings) {
    const group = SETTINGS_GROUPS.find((candidate) => candidate.settingsType === write.settingsType);
    // SetSetting carries every value as text; the read answers booleans as booleans.
    held[group.responseProperty][write.setting] = write.value === "true" || write.value === "false"
      ? write.value === "true"
      : write.value;
  }
  held.sitePublishingPreferences.footerSettings = applyFooterColors(
    themeWorkspace()["settings/site-publishing-preferences.json"].settings.footerSettings,
    committed.footerColors,
  );
  return held;
}

function routesHolding(held, options) {
  return siteRoutes(options)
    .map((route) => (route.method === "GET" && route.pattern === PRESENTATION ? { ...route, reply: held } : route));
}

test("plan runs theme push again to settle a save whose answer was lost even when nothing else changed", async (site) => {
  const workspace = await fixture(site, wholeWorkspace({ uploaded: true }));
  const held = await committedLostSave(workspace);
  const wire = api(routesHolding(held, {
    presentationSave: (call) => presentationSaveReply(call, { applied: false, revision: NEXT_PRESENTATION_REVISION }),
  }));

  const planned = await cliRun(workspace, ["plan"], wire);
  const theme = planned.result.steps.find((entry) => entry.step === "theme push");
  assert.deepEqual(theme.differences, []);
  assert.equal(theme.replaysLostSave, true);
  assert.equal(theme.status, "ready");
});

test("plan refuses only the theme or footer step that would run against a site that moved", async (site) => {
  // A theme that would change, against a revision the site has moved past.
  const moved = await fixture(site, wholeWorkspace({ uploaded: true }));
  const movedPlan = await cliRun(moved, ["plan"], api(siteRoutes({ site: { presentationRevision: NEXT_PRESENTATION_REVISION } })));
  assert.equal(movedPlan.result.steps.find((entry) => entry.step === "theme push").status, "blocked");
  assert.deepEqual(movedPlan.result.problems.map((problem) => problem.code), ["theme.concurrent_modification"]);

  // A theme that would change, from a workspace with no presentation baseline.
  const files = wholeWorkspace({ uploaded: true });
  const { presentation: _presentation, ...unbaselined } = files[".taproot-site-manifest.json"];
  const old = await fixture(site, { ...files, ".taproot-site-manifest.json": unbaselined });
  const oldPlan = await cliRun(old, ["plan"], api(siteRoutes()));
  assert.deepEqual(oldPlan.result.problems.map((problem) => problem.code), ["theme.pull_required"]);

  // A theme with nothing to send is not refused for a moved revision, so a
  // page-only apply goes ahead.
  const unchanged = await fixture(site, wholeWorkspace({ uploaded: true }));
  const held = await committedLostSave(unchanged);
  const manifestFile = workspacePath(unchanged, ".taproot-site-manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  delete manifest.presentation.pending;
  await writeFile(manifestFile, JSON.stringify(manifest));
  const unchangedPlan = await cliRun(unchanged, ["plan"], api(routesHolding(held)));
  assert.deepEqual(unchangedPlan.result.problems, []);
  assert.equal(unchangedPlan.result.steps.find((entry) => entry.step === "theme push").status, "nothing to do");
  assert.equal(unchangedPlan.result.steps.find((entry) => entry.step === "pages push").status, "ready");
  // Nor for a missing baseline: there is nothing to fence.
  delete manifest.presentation;
  await writeFile(manifestFile, JSON.stringify(manifest));
  const unbaselinedPlan = await cliRun(unchanged, ["plan"], api(routesHolding(held)));
  assert.deepEqual(unbaselinedPlan.result.problems, []);
  assert.equal(unbaselinedPlan.result.steps.find((entry) => entry.step === "theme push").status, "nothing to do");

  // A footer content edit whose draft moved on the site since the pull.
  const footer = await fixture(site, wholeWorkspace({ uploaded: true }));
  const publishingFile = workspacePath(footer, "settings/site-publishing-preferences.json");
  const publishing = JSON.parse(await readFile(publishingFile, "utf8"));
  publishing.settings.footerSettings.enabled = true;
  await writeFile(publishingFile, JSON.stringify(publishing));
  const footerManifestFile = workspacePath(footer, ".taproot-site-manifest.json");
  const footerManifest = JSON.parse(await readFile(footerManifestFile, "utf8"));
  footerManifest.footer.expectedDraftHash = "0".repeat(64);
  await writeFile(footerManifestFile, JSON.stringify(footerManifest));
  const footerPlan = await cliRun(footer, ["plan"], api(siteRoutes()));
  assert.equal(footerPlan.result.steps.find((entry) => entry.step === "footer push").status, "blocked");
  assert.ok(footerPlan.result.problems.some((problem) => problem.code === "footer.concurrent_modification"));
});

test("plan blocks media upload on a file the upload would refuse", async (site) => {
  const workspace = await fixture(site, wholeWorkspace({ files: { "media/broken.png": Buffer.from("not an image") } }));
  const planned = await cliRun(workspace, ["plan"], api(siteRoutes()));
  assert.equal(planned.result.ready, false);
  assert.equal(planned.result.steps[0].status, "blocked");
  assert.deepEqual(planned.result.problems.map((problem) => [problem.area, problem.file]), [["media", "media/broken.png"]]);
});

test("plan uploads a new or replaced video but not one that still matches its upload, and caps a run's files", async (site) => {
  const workspace = await fixture(site, wholeWorkspace({ uploaded: true, files: { "media/tour.mp4": FASTSTART } }));
  const library = [];
  const wire = api([{ method: "GET", pattern: SITE_VIDEOS, reply: () => ({ videos: library, nextPageToken: "" }) }, ...siteRoutes()]);
  const fresh = await cliRun(workspace, ["plan"], wire);
  assert.equal(fresh.result.ready, true, JSON.stringify(fresh.result.problems));
  assert.deepEqual(fresh.result.steps[0].items, ["media/tour.mp4"]);

  // Recorded at the size and time on disk: done. Recorded at another size: replaced, so pending again.
  const onDisk = await stat(workspacePath(workspace, "media/tour.mp4"));
  const record = (byteLength) => ({
    ...STUDIO_MEDIA_MANIFEST,
    videos: { "media/tour.mp4": { videoId: VIDEO_ID, byteLength, modifiedMilliseconds: Math.floor(onDisk.mtimeMs) } },
  });
  await writeFile(workspacePath(workspace, ".taproot-site-media.json"), JSON.stringify(record(onDisk.size)));
  // Unchanged but deleted from the site's library: uploaded again.
  assert.deepEqual((await cliRun(workspace, ["plan"], wire)).result.steps[0].items, ["media/tour.mp4"]);
  library.push({ videoId: VIDEO_ID });
  assert.equal((await cliRun(workspace, ["plan"], wire)).result.steps[0].status, "nothing to do");
  await writeFile(workspacePath(workspace, ".taproot-site-media.json"), JSON.stringify(record(onDisk.size + 1)));
  assert.deepEqual((await cliRun(workspace, ["plan"], wire)).result.steps[0].items, ["media/tour.mp4"]);

  // A recorded image whose bytes changed is pending too.
  await writeFile(workspacePath(workspace, "media/studio.png"), png(1300, 800));
  assert.deepEqual((await cliRun(workspace, ["plan"], wire)).result.steps[0].items, ["media/studio.png", "media/tour.mp4"]);

  const files = {};
  for (let index = 0; index < 501; index += 1) files[`media/bulk-${String(index).padStart(3, "0")}.png`] = png(10 + index, 10);
  const bulk = await fixture(site, wholeWorkspace({ files }));
  const capped = await cliRun(bulk, ["plan"], api(siteRoutes()));
  assert.equal(capped.result.ready, false);
  assert.deepEqual(capped.result.problems.map((problem) => problem.code), ["media.too_many_files"]);
});

test("a plan with many problems, pages, and pending media still fits the result bound", async (site) => {
  const files = {};
  for (let index = 0; index < 300; index += 1) {
    files[`pages/broken-${String(index).padStart(3, "0")}.md`] =
      `---\ntitle: Broken ${index}\npath: Broken Page With A Long Name Number ${index}\n---\n\nText.\n`;
  }
  // Long names, so the page and media lists alone would pass 64 KiB unbounded.
  const long = "x".repeat(180);
  for (let index = 0; index < 120; index += 1) {
    const name = `fine-${long}-${String(index).padStart(3, "0")}`;
    files[`pages/${name}.md`] = `---\ntitle: Fine ${index}\npath: ${name}\n---\n\nText.\n`;
    files[`media/${long}-${String(index).padStart(3, "0")}.png`] = png(20 + index, 20);
  }
  const workspace = await fixture(site, wholeWorkspace({ files }));
  const planned = await cliRun(workspace, ["plan"], api(siteRoutes()));
  assert.equal(planned.exitCode, 0, planned.stderr);
  assert.equal(planned.result.problemCount, 300);
  assert.equal(planned.result.problemsTruncated, true);
  assert.equal(planned.result.steps[0].itemsTruncated, true);
  assert.equal(planned.result.steps[0].files, 121);
  assert.equal(planned.result.steps[1].itemsTruncated, true);
  assert.equal(planned.result.steps[1].create, 121);
});

test("plan reads a recorded image as done only when the site holds it processed", async (site) => {
  const workspace = await fixture(site, wholeWorkspace({ uploaded: true }));
  const planWith = async (library) => {
    const routes = [{ method: "GET", pattern: SITE_IMAGES, reply: { images: library, nextPageToken: "" } }, ...siteRoutes()];
    return (await cliRun(workspace, ["plan"], api(routes))).result;
  };
  const held = (processingState) => [{ image: { imageId: IMAGE_ID, processingState }, processingState }];

  assert.equal((await planWith(held("IMAGE_PROCESSING_STATE_COMPLETE"))).steps[0].status, "nothing to do");
  // Still processing, or gone from the library: sent again, which deduplicates and waits.
  assert.deepEqual((await planWith(held("IMAGE_PROCESSING_STATE_PENDING"))).steps[0].items, ["media/studio.png"]);
  assert.deepEqual((await planWith([])).steps[0].items, ["media/studio.png"]);
  const failed = await planWith(held("IMAGE_PROCESSING_STATE_FAILED"));
  assert.equal(failed.steps[0].status, "blocked");
  assert.deepEqual(failed.problems.map((problem) => [problem.file, problem.code]), [["media/studio.png", "media.processing_failed"]]);
});

test("a page that fails partway through the pages step is reported with the pages sent before it", async (site) => {
  const workspace = await fixture(site, wholeWorkspace({ uploaded: true }));
  const routes = [
    { method: "GET", pattern: SITE_IMAGES, reply: { images: [{ image: { imageId: IMAGE_ID }, processingState: "IMAGE_PROCESSING_STATE_COMPLETE" }], nextPageToken: "" } },
    { method: "PATCH", pattern: PAGE_BY_ID, reply: () => jsonResponse(violation("Title", "refused for the test"), 400) },
    ...siteRoutes(),
  ];
  const wire = api(routes);
  const planned = await cliRun(workspace, ["plan"], wire);
  const failed = await cliRun(workspace, ["apply", "--plan", planned.result.planHash], wire);

  assert.equal(failed.exitCode, 1);
  assert.deepEqual(failed.result.error.completedWrites, [
    "pages push: failed",
    "theme push: not run",
    "page /: failed",
    "page about: created",
  ]);
  // The written page is recorded, so the next plan updates nothing twice.
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  assert.ok(manifest.pages.some((entry) => entry.pageId === NEW_PAGE_ID && entry.file === "pages/about.md"));
});

test("a pages step that fails after many writes still names the failure and the steps not run", async (site) => {
  const files = {};
  for (let index = 0; index < 130; index += 1) {
    files[`pages/page-${String(index).padStart(3, "0")}.md`] = `---\ntitle: Page ${index}\npath: page-${index}\n---\n\nText.\n`;
  }
  const workspace = await fixture(site, wholeWorkspace({ uploaded: true, files }));
  let creates = 0;
  const routes = [
    { method: "GET", pattern: SITE_IMAGES, reply: { images: [{ image: { imageId: IMAGE_ID }, processingState: "IMAGE_PROCESSING_STATE_COMPLETE" }], nextPageToken: "" } },
    {
      method: "POST",
      pattern: PAGES_COLLECTION,
      reply: (call) => {
        creates += 1;
        if (creates === 111) return jsonResponse(violation("Title", "refused for the test"), 400);
        return draftSummary(`44444444-4444-4444-8444-${String(creates).padStart(12, "0")}`, call.body.path);
      },
    },
    ...siteRoutes(),
  ];
  const wire = api(routes);
  const planned = await cliRun(workspace, ["plan"], wire);
  const failed = await cliRun(workspace, ["apply", "--plan", planned.result.planHash], wire);

  const labels = failed.result.error.completedWrites;
  assert.equal(labels.length, 100);
  assert.deepEqual(labels.slice(0, 2), ["pages push: failed", "theme push: not run"]);
  assert.match(labels[2], /^page page-\d+: failed$/u);
  assert.equal(labels[3], "20 more page(s): not sent");
  assert.match(labels[4], /^page .+: created$/u);
});

test("plan reads recorded images by id, so a large library cannot hide one", async (site) => {
  const workspace = await fixture(site, wholeWorkspace({ uploaded: true }));
  const routes = [{
    method: "GET",
    pattern: SITE_IMAGES,
    reply: (call) => ({
      images: call.query.getAll("imageIds").map((imageId) => ({
        image: { imageId },
        processingState: "IMAGE_PROCESSING_STATE_COMPLETE",
      })),
      nextPageToken: "",
    }),
  }, ...siteRoutes()];
  const wire = api(routes);
  const planned = await cliRun(workspace, ["plan"], wire);
  assert.equal(planned.result.steps[0].status, "nothing to do");
  assert.deepEqual(wire.matching("GET", SITE_IMAGES).map((call) => call.query.getAll("imageIds")), [[IMAGE_ID]]);
});

test("a page whose write may have committed is reported as unknown, not failed", async (testContext) => {
  const answers = {
    "an unreadable body": () => new Response(
      new ReadableStream({ start: (controller) => controller.error(new Error("connection reset")) }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    "a body that is not JSON": () => new Response("<html>", { status: 200, headers: { "content-type": "application/json" } }),
    "a server error": () => jsonResponse({ code: 13, message: "internal" }, 500),
  };
  for (const [label, answer] of Object.entries(answers)) {
    await testContext.test(label, async (site) => {
      const workspace = await fixture(site, wholeWorkspace({ uploaded: true }));
      const routes = [{ method: "POST", pattern: PAGES_COLLECTION, reply: answer }, ...siteRoutes()];
      const pushed = await cliRun(workspace, ["pages", "push"], api(routes));
      assert.equal(pushed.exitCode, 1);
      assert.equal(pushed.result.error.completedWrites[0], "page about: unknown");
    });
  }
});

test("pages push --dry-run keeps its page list inside the result bound", async (site) => {
  const files = {};
  const long = "x".repeat(180);
  for (let index = 0; index < 300; index += 1) {
    const name = `fine-${long}-${String(index).padStart(3, "0")}`;
    files[`pages/${name}.md`] = `---\ntitle: Fine ${index}\npath: ${name}\n---\n\nText.\n`;
  }
  const workspace = await fixture(site, wholeWorkspace({ uploaded: true, files }));
  const dry = await cliRun(workspace, ["pages", "push", "--dry-run"], api(siteRoutes()));
  assert.equal(dry.exitCode, 0, dry.stderr);
  assert.equal(dry.result.pages.wouldCreate, 301);
  assert.equal(dry.result.pages.itemsTruncated, true);
});

test("plan refuses a recorded video a truncated library cannot vouch for, and reads images in batches of 100", async (site) => {
  const media = {};
  for (let index = 0; index < 101; index += 1) {
    media[`media/gone-${index}.png`] = { imageId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` };
  }
  const workspace = await fixture(site, wholeWorkspace({ files: { "media/tour.mp4": FASTSTART } }));
  const onDisk = await stat(workspacePath(workspace, "media/tour.mp4"));
  await writeFile(workspacePath(workspace, ".taproot-site-media.json"), JSON.stringify({
    mediaManifestVersion: 2,
    siteId: SITE_ID,
    media,
    videos: { "media/tour.mp4": { videoId: VIDEO_ID, byteLength: onDisk.size, modifiedMilliseconds: Math.floor(onDisk.mtimeMs) } },
  }));
  const others = Array.from({ length: 1000 }, (_, index) => ({ videoId: `0a1b2c3d-0a1b-4c3d-8a1b-${String(index).padStart(12, "0")}` }));
  const routes = [
    { method: "GET", pattern: SITE_VIDEOS, reply: { videos: others, nextPageToken: "more" } },
    { method: "GET", pattern: SITE_IMAGES, reply: { images: [], nextPageToken: "" } },
    ...siteRoutes(),
  ];
  const wire = api(routes);
  const planned = await cliRun(workspace, ["plan"], wire);
  assert.equal(planned.result.steps[0].status, "blocked");
  assert.ok(planned.result.problems.some((problem) => problem.code === "media.video_library_unverifiable"));
  assert.deepEqual(wire.matching("GET", SITE_IMAGES).map((call) => call.query.getAll("imageIds").length), [100, 1]);
});

test("a targeted pages push --dry-run bounds its selected paths too", async (site) => {
  const files = {};
  const paths = [];
  for (let index = 0; index < 60; index += 1) {
    const name = `page-${"y".repeat(180)}-${String(index).padStart(3, "0")}`;
    files[`pages/${name}.md`] = `---\ntitle: Page ${index}\npath: ${name}\n---\n\nText.\n`;
    paths.push(name);
  }
  const workspace = await fixture(site, wholeWorkspace({ uploaded: true, files }));
  const dry = await cliRun(workspace, ["pages", "push", "--dry-run", ...paths], api(siteRoutes()));
  assert.equal(dry.exitCode, 0, dry.stderr);
  assert.equal(dry.result.pages.selectedPathsTruncated, true);
  assert.ok(dry.result.pages.selectedPaths.length < 60);
});

test("plan blocks a video the upload would refuse before anything is uploaded", async (site) => {
  const workspace = await fixture(site, wholeWorkspace({ files: { "media/broken.mp4": unreadableMp4() } }));
  const wire = api(siteRoutes());
  const planned = await cliRun(workspace, ["plan"], wire);
  assert.equal(planned.result.steps[0].status, "blocked");
  assert.deepEqual(planned.result.problems.map((problem) => [problem.file, problem.code]), [["media/broken.mp4", "media.video_unsupported"]]);
  const applied = await cliRun(workspace, ["apply", "--plan", planned.result.planHash], wire);
  assert.equal(applied.exitCode, 1);
  assert.deepEqual(writes(wire), []);
});

/** A workspace whose footer links the about page and carries a feature image, both recorded by the pull. */
function linkedFooterWorkspace({ liveAbout }) {
  const files = wholeWorkspace({ uploaded: true });
  const manifest = structuredClone(files[".taproot-site-manifest.json"]);
  manifest.pages.push({
    workspaceMode: "metadata-only",
    pageId: ABOUT_PAGE_ID,
    resourceId: resourceIdFor(ABOUT_PAGE_ID),
    path: "about-us",
    title: "About",
    status: "PAGE_STATUS_PUBLISHED",
    templateType: "TEMPLATE_TYPE_FREE_FORM",
  });
  const publishing = structuredClone(files["settings/site-publishing-preferences.json"]);
  const footerSettings = { ...authorableFooter(), light: publishing.settings.footerSettings.light, dark: publishing.settings.footerSettings.dark };
  publishing.settings.footerSettings = footerSettings;
  // Recorded as pulled, then edited, so the footer step would run.
  const pulled = { ...footerSettings, enabled: !footerSettings.enabled };
  manifest.footer = footerManifestEntry(pulled);
  const live = [pageSummary({ pageId: HOME_PAGE_ID, path: "", title: "Home" })];
  if (liveAbout) live.push(pageSummary({ pageId: ABOUT_PAGE_ID, path: "about-us" }));
  return {
    files: { ...files, ".taproot-site-manifest.json": manifest, "settings/site-publishing-preferences.json": publishing },
    featureImageId: footerSettings.featureImage.imageId,
    live,
    pulled,
  };
}

function heldImages(imageIds) {
  return {
    method: "GET",
    pattern: SITE_IMAGES,
    reply: (call) => ({
      images: call.query.getAll("imageIds").filter((imageId) => imageIds.includes(imageId))
        .map((imageId) => ({ image: { imageId }, processingState: "IMAGE_PROCESSING_STATE_COMPLETE" })),
      nextPageToken: "",
    }),
  };
}

test("plan refuses a footer link to a page the site has deleted since the pull", async (site) => {
  const { files, featureImageId, live, pulled } = linkedFooterWorkspace({ liveAbout: false });
  const workspace = await fixture(site, files);
  const planned = await cliRun(workspace, ["plan"], api([heldImages([IMAGE_ID, featureImageId]), ...siteRoutes({ live, footerSettings: pulled })]));
  assert.equal(planned.result.steps.find((entry) => entry.step === "footer push").status, "blocked");
  assert.deepEqual(planned.result.problems.map((problem) => problem.code), ["footer.page_reference_unknown"]);
  assert.match(planned.result.problems[0].field, /\.pageResourceId$/u);
});

test("plan refuses a footer image the site no longer holds, and passes one it holds", async (site) => {
  const { files, featureImageId, live, pulled } = linkedFooterWorkspace({ liveAbout: true });
  const workspace = await fixture(site, files);
  const missing = await cliRun(workspace, ["plan"], api([heldImages([IMAGE_ID]), ...siteRoutes({ live, footerSettings: pulled })]));
  assert.equal(missing.result.steps.find((entry) => entry.step === "footer push").status, "blocked");
  assert.deepEqual(missing.result.problems.map((problem) => [problem.area, problem.code, problem.field]), [
    ["footer", "plan.image_missing", featureImageId],
  ]);
  const held = await cliRun(workspace, ["plan"], api([heldImages([IMAGE_ID, featureImageId]), ...siteRoutes({ live, footerSettings: pulled })]));
  assert.deepEqual(held.result.problems, []);
  assert.equal(held.result.steps.find((entry) => entry.step === "footer push").status, "ready");
});

test("plan refuses a logo the site no longer holds only when the theme would be saved", async (site) => {
  const workspace = await fixture(site, wholeWorkspace({ uploaded: true }));
  const stylesFile = workspacePath(workspace, "settings/taproot-styles.json");
  const styles = JSON.parse(await readFile(stylesFile, "utf8"));
  styles.settings.lightLogoId = IMAGE_ID;
  await writeFile(stylesFile, JSON.stringify(styles));
  const planned = await cliRun(workspace, ["plan"], api([heldImages([]), ...siteRoutes()]));
  assert.equal(planned.result.steps.find((entry) => entry.step === "theme push").status, "blocked");
  assert.ok(planned.result.problems.some((problem) => problem.code === "plan.image_missing" && problem.field === IMAGE_ID));
  const held = await cliRun(workspace, ["plan"], api([heldImages([IMAGE_ID]), ...siteRoutes()]));
  assert.equal(held.result.steps.find((entry) => entry.step === "theme push").status, "ready");
});

test("a create whose answer was lost blocks a later push to that path until a pull adopts the page", async (site) => {
  const workspace = await fixture(site, wholeWorkspace({ uploaded: true }));
  const live = [pageSummary({ pageId: HOME_PAGE_ID, path: "", title: "Home" })];
  const lost = [
    {
      method: "POST",
      pattern: PAGES_COLLECTION,
      reply: (call) => {
        // The page is made; the answer never arrives.
        live.push(draftSummary(NEW_PAGE_ID, call.body.path));
        return new Response(new ReadableStream({ start: (controller) => controller.error(new Error("reset")) }), { status: 200 });
      },
    },
    ...siteRoutes({ live }),
  ];
  const first = await cliRun(workspace, ["pages", "push"], api(lost));
  assert.equal(first.result.error.completedWrites[0], "page about: unknown");
  assert.deepEqual((await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).pendingCreates, { about: "pages/about.md" });

  const wire = api(siteRoutes({ live }));
  const planned = await cliRun(workspace, ["plan"], wire);
  assert.equal(planned.result.steps.find((entry) => entry.step === "pages push").status, "blocked");
  assert.ok(planned.result.problems.some((problem) => problem.code === "pages.create_unconfirmed"));
  const again = await cliRun(workspace, ["pages", "push"], wire);
  assert.equal(again.result.error.code, "pages.create_unconfirmed");
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).filter((call) => call.body.path === "about").length, 0);
  assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
});

test("a create that is confirmed, or refused outright, leaves no pending-create marker", async (site) => {
  const confirmed = await fixture(site, wholeWorkspace({ uploaded: true }));
  assert.equal((await cliRun(confirmed, ["pages", "push"], api(siteRoutes()))).exitCode, 0);
  assert.equal((await readWorkspaceJson(confirmed, ".taproot-site-manifest.json")).pendingCreates, undefined);

  const refused = await fixture(site, wholeWorkspace({ uploaded: true }));
  const routes = [{ method: "POST", pattern: PAGES_COLLECTION, reply: () => jsonResponse(violation("Path", "taken"), 400) }, ...siteRoutes()];
  assert.equal((await cliRun(refused, ["pages", "push"], api(routes))).exitCode, 1);
  assert.equal((await readWorkspaceJson(refused, ".taproot-site-manifest.json")).pendingCreates, undefined);
});

test("apply sends only the page sources and replaces only the navigation its plan saw", async (testContext) => {
  await testContext.test("a page edited while media uploads is not sent", async (site) => {
    const workspace = await fixture(site, wholeWorkspace());
    const routes = siteRoutes().map((route) => (route.method === "POST" && route.pattern === REQUEST_UPLOAD
      ? {
        ...route,
        reply: async (call, calls) => {
          await writeFile(workspacePath(workspace, "pages/about.md"), "---\ntitle: About us\npath: about\n---\n\nUnreviewed.\n");
          return await route.reply(call, calls);
        },
      }
      : route));
    const wire = api(routes);
    const planned = await cliRun(workspace, ["plan"], wire);
    const applied = await cliRun(workspace, ["apply", "--plan", planned.result.planHash], wire);
    assert.equal(applied.exitCode, 1);
    assert.equal(applied.result.error.code, "apply.plan_stale");
    assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
    assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);
  });

  await testContext.test("navigation changed on the site during an earlier step is not replaced", async (site) => {
    const workspace = await fixture(site, wholeWorkspace({
      uploaded: true,
      navItems: [{ id: navId(1), kind: "NAV_ITEM_KIND_EXTERNAL_URL", title: "Blog", externalUrl: "https://example.com/blog" }],
    }));
    const liveNav = [];
    const routes = [
      { method: "GET", pattern: SITE_IMAGES, reply: { images: [{ image: { imageId: IMAGE_ID }, processingState: "IMAGE_PROCESSING_STATE_COMPLETE" }], nextPageToken: "" } },
      { method: "GET", pattern: NAVIGATION, reply: () => ({ navItems: liveNav }) },
      ...siteRoutes().map((route) => (route.method === "POST" && route.pattern === PAGES_COLLECTION
        ? {
          ...route,
          reply: (call, calls) => {
            liveNav.push({ id: navId(9), kind: "NAV_ITEM_KIND_EXTERNAL_URL", title: "Theirs", externalUrl: "https://example.com/theirs" });
            return route.reply(call, calls);
          },
        }
        : route)),
    ];
    const wire = api(routes);
    const planned = await cliRun(workspace, ["plan"], wire);
    const applied = await cliRun(workspace, ["apply", "--plan", planned.result.planHash], wire);
    assert.equal(applied.exitCode, 1);
    assert.equal(applied.result.error.code, "apply.plan_stale");
    assert.ok(applied.result.error.completedWrites.includes("nav push: failed"));
    assert.equal(wire.matching("PUT", NAVIGATION).length, 0);
  });
});

test("a page added while an earlier apply step runs is not sent", async (site) => {
  const workspace = await fixture(site, wholeWorkspace());
  const routes = siteRoutes().map((route) => (route.method === "POST" && route.pattern === REQUEST_UPLOAD
    ? {
      ...route,
      reply: async (call, calls) => {
        await writeFile(workspacePath(workspace, "pages/late.md"), "---\ntitle: Late\npath: late\n---\n\nUnreviewed.\n");
        return await route.reply(call, calls);
      },
    }
    : route));
  const wire = api(routes);
  const planned = await cliRun(workspace, ["plan"], wire);
  const applied = await cliRun(workspace, ["apply", "--plan", planned.result.planHash], wire);
  assert.equal(applied.result.error.code, "apply.plan_stale");
  assert.equal(applied.result.error.field, "pages/late.md");
  assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 0);
});

test("apply refuses footer, theme, navigation, and media edited while an earlier step runs", async (testContext) => {
  const editJson = async (workspace, file, change) => {
    const document_ = JSON.parse(await readFile(workspacePath(workspace, file), "utf8"));
    change(document_);
    await writeFile(workspacePath(workspace, file), JSON.stringify(document_));
  };
  const cases = [
    {
      label: "footer",
      before: (workspace) => editJson(workspace, "settings/site-publishing-preferences.json", (document_) => {
        document_.settings.footerSettings.enabled = true;
      }),
      during: (workspace) => editJson(workspace, "settings/site-publishing-preferences.json", (document_) => {
        document_.settings.footerSettings.showBrand = false;
      }),
      field: "settings/site-publishing-preferences.json",
      unsent: (wire) => wire.matching("POST", FOOTER_SETTINGS).length,
    },
    {
      label: "footer color",
      before: (workspace) => editJson(workspace, "settings/site-publishing-preferences.json", (document_) => {
        document_.settings.footerSettings.enabled = true;
      }),
      during: (workspace) => editJson(workspace, "settings/site-publishing-preferences.json", (document_) => {
        document_.settings.footerSettings.light.textColor = "#123456";
      }),
      field: "settings/site-publishing-preferences.json",
      unsent: (wire) => wire.matching("POST", FOOTER_SETTINGS).length,
    },
    {
      label: "page manifest title",
      during: (workspace) => editJson(workspace, ".taproot-site-manifest.json", (document_) => {
        document_.pages[0].title = "Retitled mid-apply";
      }),
      field: ".taproot-site-manifest.json",
      unsent: (wire) => wire.matching("POST", PAGES_COLLECTION).length + wire.matching("PATCH", PAGE_BY_ID).length,
    },
    {
      label: "page media record",
      files: { "media/other.png": png(320, 200) },
      before: (workspace) => writeFile(workspacePath(workspace, ".taproot-site-media.json"), JSON.stringify({
        mediaManifestVersion: 2,
        siteId: SITE_ID,
        media: { "media/other.png": { imageId: IMAGE_ID, contentHash: contentHashOf(png(320, 200)), width: 320, height: 200, alt: "" } },
      })),
      during: (workspace) => editJson(workspace, ".taproot-site-media.json", (document_) => {
        document_.media["media/other.png"].alt = "Changed mid-apply";
      }),
      // While apply re-plans, after it read the media records: the plan's own
      // read is the first navigation read, apply's the second.
      trigger: { method: "GET", pattern: NAVIGATION, occurrence: 2 },
      field: ".taproot-site-media.json",
      unsent: (wire) => wire.matching("POST", PAGES_COLLECTION).length + wire.matching("PATCH", PAGE_BY_ID).length,
    },
    {
      label: "pending media alt text",
      files: { "media/other.png": png(320, 200) },
      before: (workspace) => writeFile(workspacePath(workspace, ".taproot-site-media.json"), JSON.stringify({
        mediaManifestVersion: 2,
        siteId: SITE_ID,
        // Recorded, but its bytes changed since, so this apply uploads it again.
        media: { "media/other.png": { imageId: IMAGE_ID, contentHash: "0".repeat(64), width: 320, height: 200, alt: "" } },
      })),
      during: (workspace) => editJson(workspace, ".taproot-site-media.json", (document_) => {
        document_.media["media/other.png"].alt = "Changed mid-apply";
      }),
      trigger: { method: "GET", pattern: NAVIGATION, occurrence: 2 },
      field: ".taproot-site-media.json",
      unsent: (wire) => wire.matching("POST", PAGES_COLLECTION).length + wire.matching("PATCH", PAGE_BY_ID).length,
    },
    {
      label: "page revision",
      live: () => [pageSummary({ pageId: HOME_PAGE_ID, path: "", title: "Home", bodyRevision: "sha256:aaaaaaaaaaaaaaaa" })],
      during: (workspace, live) => {
        live[0] = pageSummary({ pageId: HOME_PAGE_ID, path: "", title: "Home", bodyRevision: "sha256:bbbbbbbbbbbbbbbb" });
      },
      field: "pages/index.pm.json",
      unsent: (wire) => wire.matching("POST", PAGES_COLLECTION).length + wire.matching("PATCH", PAGE_BY_ID).length,
    },
    {
      label: "theme",
      during: (workspace) => editJson(workspace, "settings/site-header.json", (document_) => {
        document_.settings.brandText = "Edited mid-apply";
      }),
      field: "settings/site-header.json",
      unsent: (wire) => wire.matching("POST", PRESENTATION).length,
    },
    {
      label: "navigation",
      during: (workspace) => editJson(workspace, "nav.json", (document_) => {
        document_.navItems[0].title = "Edited mid-apply";
      }),
      field: "nav.json",
      unsent: (wire) => wire.matching("PUT", NAVIGATION).length,
    },
    {
      label: "media",
      files: { "media/zz-second.png": png(640, 480) },
      during: (workspace) => writeFile(workspacePath(workspace, "media/zz-second.png"), png(641, 480)),
      field: "media/zz-second.png",
      unsent: (wire) => wire.matching("POST", REQUEST_UPLOAD).length - 1,
    },
  ];
  for (const scenario of cases) {
    await testContext.test(scenario.label, async (site) => {
      const workspace = await fixture(site, wholeWorkspace({
        navItems: [{ id: navId(1), kind: "NAV_ITEM_KIND_EXTERNAL_URL", title: "Blog", externalUrl: "https://example.com/blog" }],
        files: scenario.files ?? {},
      }));
      await scenario.before?.(workspace);
      let edited = false;
      const live = scenario.live?.();
      const routes = [
        ...(live === undefined ? [] : [{ method: "GET", pattern: PAGES_LIST, reply: () => ({ pages: live, nextPageToken: "" }) }]),
        { method: "GET", pattern: SITE_IMAGES, reply: { images: [{ image: { imageId: IMAGE_ID }, processingState: "IMAGE_PROCESSING_STATE_COMPLETE" }], nextPageToken: "" } },
        ...siteRoutes(),
      ];
      const trigger = scenario.trigger ?? { method: "POST", pattern: REQUEST_UPLOAD, occurrence: 1 };
      let seen = 0;
      const index = routes.findIndex((route) => route.method === trigger.method && route.pattern === trigger.pattern);
      const original = routes[index];
      routes[index] = {
        ...original,
        reply: async (call, calls) => {
          seen += 1;
          if (!edited && seen === trigger.occurrence) {
            edited = true;
            await scenario.during(workspace, live);
          }
          return typeof original.reply === "function" ? await original.reply(call, calls) : original.reply;
        },
      };
      const wire = api(routes);
      const planned = await cliRun(workspace, ["plan"], wire);
      assert.equal(planned.result.ready, true, JSON.stringify(planned.result.problems));
      const applied = await cliRun(workspace, ["apply", "--plan", planned.result.planHash], wire);
      assert.equal(applied.result.error?.code, "apply.plan_stale");
      assert.equal(applied.result.error.field, scenario.field);
      assert.equal(scenario.unsent(wire), 0);
    });
  }
});

/**
 * The read ledger's guarantee, over every file the workspace holds rather than
 * the inputs anyone thought to list: a file edited while an earlier apply step
 * runs either stops the step that would read it, naming it, or is never read
 * again, so nothing unreviewed is sent (TR00823).
 */
test("an edit to any workspace file during apply is refused by name, or never read again", async (testContext) => {
  const navItems = [{ id: navId(1), kind: "NAV_ITEM_KIND_EXTERNAL_URL", title: "Blog", externalUrl: "https://example.com/blog" }];
  const probe = await fixture(testContext, wholeWorkspace({ navItems }));
  const files = (await readdir(probe.workspaceDir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(probe.workspaceDir, path.join(entry.parentPath ?? entry.path, entry.name)).split(path.sep).join("/")
    )
    .sort();
  // What the steps after the media upload read: these must refuse. The edit
  // lands during the upload, the first step; the unit tests cover edits to a
  // file apply itself wrote.
  const mustRefuse = [
    ".taproot-site-manifest.json",
    "nav.json",
    "pages/about.md",
    "pages/index.pm.json",
    "settings/brand.json",
    "settings/site-header.json",
    "settings/site-publishing-preferences.json",
    "settings/taproot-styles.json",
  ];
  assert.ok(mustRefuse.every((file) => files.includes(file)), files.join(", "));
  const outcomes = {};
  for (const file of files) {
    await testContext.test(file, async (site) => {
      const workspace = await fixture(site, wholeWorkspace({ navItems }));
      const routes = siteRoutes();
      const index = routes.findIndex((route) => route.method === "POST" && route.pattern === REQUEST_UPLOAD);
      const original = routes[index];
      let edited = false;
      routes[index] = {
        ...original,
        reply: async (call, calls) => {
          if (!edited) {
            edited = true;
            await appendFile(workspacePath(workspace, file), file.endsWith(".png") ? Buffer.from([0]) : "\n");
          }
          return typeof original.reply === "function" ? await original.reply(call, calls) : original.reply;
        },
      };
      const wire = api(routes);
      const planned = await cliRun(workspace, ["plan"], wire);
      assert.equal(planned.result.ready, true, JSON.stringify(planned.result.problems));
      const applied = await cliRun(workspace, ["apply", "--plan", planned.result.planHash], wire);
      assert.ok(edited);
      if (applied.exitCode === 0) {
        outcomes[file] = "not read again";
      } else {
        assert.equal(applied.result.error.code, "apply.plan_stale", applied.stderr);
        assert.equal(applied.result.error.field, file);
        outcomes[file] = "refused";
      }
    });
  }
  for (const file of mustRefuse) assert.equal(outcomes[file], "refused", file);
});

test("plan tells two images it has not uploaded apart, so an unused cover is caught before apply", async (site) => {
  const workspace = await fixture(site, wholeWorkspace({
    files: {
      "media/cover.png": png(800, 600),
      "media/inside.png": png(640, 480),
      "pages/story.md": "---\ntitle: Story\npath: journal/story\ntemplate: article\ncoverImage: media/cover.png\n---\n\n"
        + "Inside.\n\n![Inside](media/inside.png)\n",
    },
  }));
  const planned = await cliRun(workspace, ["plan"], api(siteRoutes()));

  assert.equal(planned.result.ready, false);
  assert.ok(
    planned.result.problems.some((problem) => problem.code === "pages.cover_image_unused" && problem.file === "pages/story.md"),
    JSON.stringify(planned.result.problems),
  );
});

test("plan names a page image the site does not hold, and leaves images this plan uploads to the media step", async (site) => {
  const foreign = "99999999-9999-4999-8999-999999999999";
  const workspace = await fixture(site, wholeWorkspace({
    files: {
      "pages/index.pm.json": {
        type: "doc",
        content: [{ type: "taprootImage", attrs: { imageId: foreign, src: "", urls: [], width: 10, height: 10, alt: "Elsewhere" } }],
      },
    },
  }));
  const wire = api([
    // The library holds only the images it is asked about that are its own.
    {
      method: "GET",
      pattern: SITE_IMAGES,
      reply: (call) => ({
        images: call.query.getAll("imageIds").filter((imageId) => imageId === IMAGE_ID)
          .map((imageId) => ({ image: { imageId }, processingState: "IMAGE_PROCESSING_STATE_COMPLETE" })),
        nextPageToken: "",
      }),
    },
    ...siteRoutes(),
  ]);
  const planned = await cliRun(workspace, ["plan"], wire);

  assert.equal(planned.result.ready, false);
  assert.deepEqual(
    planned.result.problems.map(({ code, file, field }) => [code, file, field]),
    [["plan.page_image_missing", "pages/index.pm.json", foreign]],
  );
  // pages/about.md names media/studio.png, which this plan uploads: not a problem.
  assert.ok(!planned.result.problems.some((problem) => problem.file === "pages/about.md"));
});

test("a planned page that an upload's deduplication leaves unchanged is skipped, not refused", async (site) => {
  const workspace = await fixture(site, wholeWorkspace());
  // The site's presentation revision follows the theme save, as a real site's does.
  const siteState = { presentationRevision: PRESENTATION_REVISION };
  const wire = api(siteRoutes({ site: siteState }));
  const first = await cliRun(workspace, ["plan"], wire);
  const firstApply = await cliRun(workspace, ["apply", "--plan", first.result.planHash], wire);
  assert.equal(firstApply.exitCode, 0, firstApply.stderr);
  siteState.presentationRevision = firstApply.result.applied.find((entry) => entry.step === "theme push").result.revision;
  // The page is pushed with the uploaded image; then its media record is lost,
  // so the next plan uploads the file again and sees the page as changed.
  const media = await readWorkspaceJson(workspace, ".taproot-site-media.json");
  delete media.media["media/studio.png"];
  await writeFile(workspacePath(workspace, ".taproot-site-media.json"), `${JSON.stringify(media, undefined, 2)}\n`);
  const patchesBefore = wire.matching("PATCH", PAGE_BY_ID).length;

  const second = await cliRun(workspace, ["plan"], wire);
  assert.equal(second.result.steps.find((entry) => entry.step === "pages push").status, "ready");
  const applied = await cliRun(workspace, ["apply", "--plan", second.result.planHash], wire);

  // The upload returns the image the page already shows, so the page is
  // unchanged and skipped rather than refused.
  assert.equal(applied.exitCode, 0, applied.stderr);
  assert.equal(applied.result.applied.find((entry) => entry.step === "pages push").result.updated, 0);
  assert.equal(
    wire.matching("PATCH", PAGE_BY_ID).slice(patchesBefore).filter((call) => call.body.path === "about").length,
    0,
  );
});

test("every apply step uses the configuration apply planned with, even if taproot-site.json changes", async (site) => {
  const otherSite = "77777777-7777-4777-8777-777777777777";
  const workspace = await fixture(site, wholeWorkspace());
  const routes = siteRoutes();
  const index = routes.findIndex((route) => route.method === "POST" && route.pattern === REQUEST_UPLOAD);
  const original = routes[index];
  routes[index] = {
    ...original,
    reply: async (call, calls) => {
      const config = JSON.parse(await readFile(workspace.configPath, "utf8"));
      await writeFile(workspace.configPath, `${JSON.stringify({ ...config, siteId: otherSite })}\n`);
      return typeof original.reply === "function" ? await original.reply(call, calls) : original.reply;
    },
  };
  const wire = api(routes);
  const planned = await cliRun(workspace, ["plan"], wire);
  const applied = await cliRun(workspace, ["apply", "--plan", planned.result.planHash], wire);

  assert.equal(applied.exitCode, 0, applied.stderr);
  assert.ok(!wire.calls.some((call) => call.pathname.includes(otherSite) || call.query?.toString().includes(otherSite)));
});

test("a planned page whose source is deleted while an earlier apply step runs stops the pages step", async (site) => {
  const workspace = await fixture(site, wholeWorkspace());
  const routes = siteRoutes();
  const index = routes.findIndex((route) => route.method === "POST" && route.pattern === REQUEST_UPLOAD);
  const original = routes[index];
  routes[index] = {
    ...original,
    reply: async (call, calls) => {
      await rm(workspacePath(workspace, "pages/about.md"), { force: true });
      return typeof original.reply === "function" ? await original.reply(call, calls) : original.reply;
    },
  };
  const wire = api(routes);
  const planned = await cliRun(workspace, ["plan"], wire);
  const applied = await cliRun(workspace, ["apply", "--plan", planned.result.planHash], wire);

  assert.equal(applied.result.error.code, "apply.plan_stale");
  assert.equal(applied.result.error.field, "pages/about.md");
  assert.equal(wire.matching("POST", PAGES_COLLECTION).length + wire.matching("PATCH", PAGE_BY_ID).length, 0);
});

test("a 500-file media upload with long delivery URLs reports within the result bound and exits 0", async (site) => {
  const files = {};
  for (let index = 0; index < 500; index += 1) {
    files[`media/batch/photo-with-a-long-descriptive-name-${String(index).padStart(3, "0")}.png`] = png(100 + index, 100);
  }
  const workspace = await fixture(site, files);
  const imageIdFor = (index) => `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`;
  const longUrl = (index, width) => `https://cdn.example.test/${"signed/".repeat(20)}${index}-${width}.webp?X-Amz-Signature=${"a".repeat(256)}`;
  let requested = 0;
  const routes = [
    {
      method: "POST",
      pattern: REQUEST_UPLOAD,
      reply: (call) => {
        requested += 1;
        return {
          presignedUrl: PRESIGNED_URL,
          uploadId: imageIdFor(requested),
          isDuplicate: false,
          requiredHeaders: {
            "Content-Type": call.body.contentType,
            "Content-Length": String(call.body.fileSize),
            "x-amz-meta-original-filename": call.body.fileName,
          },
        };
      },
    },
    { method: "PUT", pattern: PRESIGNED_PUT, reply: () => new Response(null, { status: 200 }) },
    {
      method: "POST",
      pattern: CONFIRM_UPLOAD,
      reply: (call) => ({ image: { imageId: call.body.uploadId, processingState: "IMAGE_PROCESSING_STATE_PENDING" } }),
    },
    {
      method: "GET",
      pattern: SITE_IMAGES,
      // Paged as the library pages, a hundred at a time.
      reply: (call) => {
        const start = Number(call.query.get("pageToken") || 0);
        return {
          images: Array.from({ length: Math.min(100, 500 - start) }, (_, offset) => {
            const index = start + offset;
            return {
              image: {
                imageId: imageIdFor(index + 1),
                url: longUrl(index, 1200),
                responsiveUrls: [320, 640, 960, 1280, 1920].map((width) => ({ minWidth: width, url: longUrl(index, width) })),
                processingState: "IMAGE_PROCESSING_STATE_COMPLETE",
              },
              processingState: "IMAGE_PROCESSING_STATE_COMPLETE",
            };
          }),
          nextPageToken: start + 100 < 500 ? String(start + 100) : "",
        };
      },
    },
  ];
  const uploaded = await cliRun(workspace, ["media", "upload"], api(routes));
  assert.equal(uploaded.exitCode, 0, uploaded.stderr);
  assert.equal(uploaded.result.media.total, 500);
  assert.equal(uploaded.result.media.itemsTruncated, true);
  assert.ok(uploaded.result.media.items.length > 0);
  assert.ok(uploaded.result.media.items.every((item) => !("media" in item) && !("src" in item)));
  assert.ok(Buffer.byteLength(JSON.stringify(uploaded.result), "utf8") <= LIMITS.githubOutputBytes);
  const manifest = await readWorkspaceJson(workspace, ".taproot-site-media.json");
  assert.equal(Object.keys(manifest.media).length, 500);
  assert.equal(manifest.media["media/batch/photo-with-a-long-descriptive-name-000.png"].urls.length, 5);
});

test("delivery check's --production --url, --wait and --no-browser reach the check from the command line", async (site) => {
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([{ pageId: ABOUT_PAGE_ID, path: "about", title: "About" }]),
  });
  // The about route is still propagating on the first look, so --wait has something to re-check.
  let aboutReads = 0;
  const routes = deliveryRoutes().map((route) => (route.pattern.source === "^\\/about\\/$"
    ? { ...route, reply: () => (aboutReads++ === 0 ? new Response("", { status: 404 }) : route.reply()) }
    : route));
  const checked = await cliRun(
    workspace,
    ["delivery", "check", "--production", "--url", `${PUBLIC_ORIGIN}/`, "--wait", "1", "--no-browser"],
    api(routes),
  );
  assert.equal(checked.exitCode, 0, checked.stderr);
  assert.equal(checked.result.target.url, `${PUBLIC_ORIGIN}/`);
  assert.equal(checked.result.target.resolvedFrom, "option");
  assert.equal(checked.result.browser.reason, "disabled");
  assert.equal(checked.result.propagation.waitedSeconds, 1);
  assert.equal(checked.result.verdict, "delivered");
});

test("places search and select find the Taproot place a review names, in one billed session", async (site) => {
  const workspace = await fixture(site, { ".taproot-site-manifest.json": manifestFixture([]) });
  const wire = api([
    {
      method: "GET",
      pattern: PLACES_SEARCH,
      reply: {
        predictions: [
          { googlePlaceId: "ChIJ-blue-bottle", name: "Blue Bottle Coffee", formattedAddress: "300 Webster St, Oakland" },
          // Google ids run past 100 characters; Taproot stores up to 256.
          { googlePlaceId: `ChIJ${"x".repeat(252)}`, name: "Blue Bottle Coffee", formattedAddress: "4270 Broadway, Oakland" },
        ],
      },
    },
    {
      method: "POST",
      pattern: PLACES_SELECT,
      reply: { id: TYPED_PLACE_ID, name: "Blue Bottle Coffee", category: "Cafe", city: "Oakland" },
    },
  ]);
  const searched = await cliRun(workspace, ["places", "search", "Blue", "Bottle", "Oakland"], wire);
  assert.equal(searched.exitCode, 0, searched.stderr);
  assert.equal(searched.result.predictions[0].googlePlaceId, "ChIJ-blue-bottle");
  assert.equal(searched.result.predictions[1].googlePlaceId.length, 256);
  const search = wire.matching("GET", PLACES_SEARCH)[0];
  assert.equal(search.query.get("query"), "Blue Bottle Oakland");
  assert.equal(search.query.get("siteId"), SITE_ID);
  assert.equal(search.query.get("sessionToken"), searched.result.sessionToken);

  const selected = await cliRun(workspace, ["places", "select", "ChIJ-blue-bottle", searched.result.sessionToken], wire);
  assert.equal(selected.exitCode, 0, selected.stderr);
  assert.equal(selected.result.place.placeId, TYPED_PLACE_ID);
  assert.deepEqual(wire.matching("POST", PLACES_SELECT)[0].body, {
    siteId: SITE_ID,
    googlePlaceId: "ChIJ-blue-bottle",
    sessionToken: searched.result.sessionToken,
  });

  const longId = searched.result.predictions[1].googlePlaceId;
  const selectedLong = await cliRun(workspace, ["places", "select", longId, searched.result.sessionToken], wire);
  assert.equal(selectedLong.exitCode, 0, selectedLong.stderr);
  assert.equal(wire.matching("POST", PLACES_SELECT)[1].body.googlePlaceId, longId);

  for (const selection of [
    ["ChIJ-blue-bottle", "not-a-token"],
    ["ChIJ-blue-bottle"],
    ["x".repeat(257), searched.result.sessionToken],
    ["ChIJ.blue bottle", searched.result.sessionToken],
  ]) {
    const usage = await cliRun(workspace, ["places", "select", ...selection], wire);
    assert.equal(usage.exitCode, 2);
    assert.equal(usage.result.error.code, "places.selection_invalid");
  }
  assert.equal(wire.matching("POST", PLACES_SELECT).length, 2);
});

test("places search refuses a prediction whose Google place id Taproot could not store", async (site) => {
  const workspace = await fixture(site, { ".taproot-site-manifest.json": manifestFixture([]) });
  for (const googlePlaceId of ["x".repeat(257), "ChIJ.blue bottle"]) {
    const wire = api([
      { method: "GET", pattern: PLACES_SEARCH, reply: { predictions: [{ googlePlaceId, name: "Blue Bottle Coffee" }] } },
    ]);
    const searched = await cliRun(workspace, ["places", "search", "Blue", "Bottle"], wire);
    assert.notEqual(searched.exitCode, 0);
    assert.equal(searched.result.error.code, "api.place_contract");
  }
});

// ── Page authors (TR01196) ───────────────────────────────────────────────

const JANE = { handle: "jane-doe", displayName: "Jane Doe", hasEmail: true };
const OWNER_MEMBER = { email: "owner@example.com", displayName: "Olivia Owner" };

function authorsRoute(listing = { authors: [JANE], members: [OWNER_MEMBER] }) {
  return { method: "GET", pattern: AUTHORS, reply: () => listing };
}

test("authors list reports who can be named and refreshes authors.json without any private address", async (site) => {
  const workspace = await fixture(site);
  const wire = api([
    authorsRoute({
      // A key is shown the author's own address; it must reach neither the result nor the file.
      authors: [{ ...JANE, email: "jane-private@example.com" }],
      members: [{ displayName: "Olivia Owner", email: "Owner@Example.com" }],
    }),
  ]);
  const { invocation, progress } = invoke(workspace, wire, { verb: "authors list" });

  const result = await VERB_HANDLERS["authors list"](invocation);

  assert.deepEqual(result.authors, { total: 1, items: [JANE] });
  assert.deepEqual(result.members, { total: 1, items: [OWNER_MEMBER] });
  assert.equal(result.authorsFile, "authors.json");
  const file = await readWorkspaceJson(workspace, "authors.json");
  assert.deepEqual(file, {
    siteId: SITE_ID,
    authors: [{ handle: "jane-doe", displayName: "Jane Doe" }],
    members: [OWNER_MEMBER],
  });
  assert.equal(JSON.stringify(result).includes("jane-private"), false);
  assert.equal(JSON.stringify(file).includes("jane-private"), false);
  assert.ok(progress.some((line) => line.includes("jane-doe: Jane Doe")));
  assert.ok(progress.some((line) => line.includes("owner@example.com: Olivia Owner")));
});

test("authors add folds the handle and address, creates the author, and refreshes authors.json", async (site) => {
  const workspace = await fixture(site);
  const listing = { authors: [], members: [OWNER_MEMBER] };
  const wire = api([
    authorsRoute(listing),
    {
      method: "POST",
      pattern: AUTHORS,
      reply: (call) => {
        listing.authors.push({ handle: call.body.handle, displayName: call.body.displayName, hasEmail: true });
        return { siteAuthorId: NEW_PAGE_ID, siteId: SITE_ID, ...listing.authors.at(-1) };
      },
    },
  ]);

  const run = await cliRun(
    workspace,
    ["authors", "add", "Jane-Doe", "--name", "  Jane Doe ", "--email", "Jane@Example.COM"],
    wire,
  );

  assert.equal(run.exitCode, 0, run.stderr);
  assert.deepEqual(wire.matching("POST", AUTHORS).map((call) => call.body), [
    { handle: "jane-doe", displayName: "Jane Doe", email: "jane@example.com" },
  ]);
  assert.deepEqual(run.result.author, JANE);
  assert.equal(run.result.authorsFile, "authors.json");
  assert.match(run.result.nextStep, /author: jane-doe/u);
  assert.deepEqual((await readWorkspaceJson(workspace, "authors.json")).authors, [
    { handle: "jane-doe", displayName: "Jane Doe" },
  ]);
});

test("authors add refuses a bad handle, name, or address before any request, and names a taken handle", async (site) => {
  const workspace = await fixture(site);
  const wire = api([authorsRoute()]);
  for (const [args, code] of [
    [["authors", "add", "Not A Handle", "--name", "X"], "authors.handle_invalid"],
    [["authors", "add", "double--hyphen", "--name", "X"], "authors.handle_invalid"],
    [["authors", "add", "jane-doe", "--name", "X", "--email", "nope"], "authors.email_invalid"],
    [["authors", "add", "jane-doe"], "authors.name_missing"],
    [["authors", "add", "--name", "X"], "authors.handle_missing"],
  ]) {
    const run = await cliRun(workspace, args, wire);
    assert.equal(run.exitCode, 2, `${args.join(" ")}: ${run.stderr}`);
    assert.equal(run.result.error.code, code);
  }
  assert.deepEqual(wire.calls, []);

  const taken = api([
    {
      method: "POST",
      pattern: AUTHORS,
      reply: () => jsonResponse(violation("HandleTaken", "A site author with that handle already exists."), 400),
    },
  ]);
  const refused = await cliRun(workspace, ["authors", "add", "jane-doe", "--name", "Jane"], taken);
  assert.equal(refused.exitCode, 1);
  assert.equal(refused.result.error.code, "authors.handle_taken");
});

test("authors add succeeds again for the same author and refuses a different name for a taken handle", async (site) => {
  const workspace = await fixture(site);
  const taken = (listing) =>
    api([
      authorsRoute(listing),
      {
        method: "POST",
        pattern: AUTHORS,
        reply: () => jsonResponse(violation("HandleTaken", "A site author with that handle already exists."), 400),
      },
    ]);

  const repeated = await cliRun(workspace, ["authors", "add", "jane-doe", "--name", "Jane Doe"], taken({
    authors: [JANE],
    members: [OWNER_MEMBER],
  }));
  assert.equal(repeated.exitCode, 0, repeated.stderr);
  assert.equal(repeated.result.existing, true);
  assert.equal(repeated.result.author.handle, "jane-doe");
  assert.equal(repeated.result.authorsFile, "authors.json");

  const renamed = await cliRun(workspace, ["authors", "add", "jane-doe", "--name", "Janet Doe"], taken({
    authors: [JANE],
    members: [],
  }));
  assert.equal(renamed.exitCode, 1);
  assert.equal(renamed.result.error.code, "authors.handle_taken");
  assert.match(renamed.stderr, /Jane Doe/u);

  // A taken handle the list does not show stays the site's own refusal.
  const unexplained = await cliRun(workspace, ["authors", "add", "jane-doe", "--name", "Jane Doe"], taken({
    authors: [],
    members: [],
  }));
  assert.equal(unexplained.exitCode, 1);
  assert.equal(unexplained.result.error.code, "authors.handle_taken");
});

test("authors verbs ask for the content capability only", () => {
  assert.deepEqual(VERB_CAPABILITIES["authors list"], [CAPABILITY_CONTENT]);
  assert.deepEqual(VERB_CAPABILITIES["authors add"], [CAPABILITY_CONTENT]);
});

test("an author round trip: authors add, author: front matter, push sends it, pull records it", async (site) => {
  const listing = { authors: [JANE], members: [OWNER_MEMBER] };
  const workspace = await fixture(site, {
    ".taproot-site-manifest.json": manifestFixture([]),
    "authors.json": {
      siteId: SITE_ID,
      authors: [{ handle: "jane-doe", displayName: "Jane Doe" }],
      members: [OWNER_MEMBER],
    },
    "pages/hello.md": "---\ntitle: Hello\npath: hello\nauthor: Jane-Doe\n---\n\nHello.\n",
  });
  const posted = [];
  const wire = api([
    authorsRoute(listing),
    { method: "GET", pattern: PAGES_LIST, reply: () => ({ pages: posted.map((entry) => entry.summary), nextPageToken: "" }) },
    {
      method: "POST",
      pattern: PAGES_COLLECTION,
      reply: (call) => {
        const summary = draftSummary(NEW_PAGE_ID, call.body.path, { authorRef: call.body.author ?? "" });
        posted.push({ summary });
        return summary;
      },
    },
    { method: "GET", pattern: NAVIGATION, reply: { navItems: [] } },
    { method: "GET", pattern: SETTINGS, reply: {} },
    { method: "GET", pattern: PAGE_BY_ID, reply: () => freeFormPageDetail(NEW_PAGE_ID, "Hello.") },
  ]);

  const result = await pagesPush(
    invoke(workspace, wire, { verb: "pages push", content: contentStub().module }).invocation,
  );

  assert.equal(result.pages.created, 1);
  // The folded reference is what travels, and the page is not reported as authorless.
  assert.equal(wire.matching("POST", PAGES_COLLECTION)[0].body.author, "jane-doe");
  assert.equal(result.pages.authorless, undefined);
  assert.equal(result.pages.items[0].author, "jane-doe");
  let manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  let record = manifest.pages.find((entry) => entry.pageId === NEW_PAGE_ID);
  assert.equal(record.author, "jane-doe");
  assert.equal(record.baseline.author, "jane-doe");

  // A second push of the same source repeats nothing: not even the author.
  const again = await pagesPush(
    invoke(workspace, wire, { verb: "pages push", content: contentStub().module }).invocation,
  );
  assert.equal(again.pages.unchanged, 1);
  assert.equal(wire.matching("POST", PAGES_COLLECTION).length, 1);
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 0);

  // Pull records the author the site reports, and keeps the Markdown source.
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
  record = manifest.pages.find((entry) => entry.pageId === NEW_PAGE_ID);
  assert.equal(record.author, "jane-doe");
  assert.equal(record.baseline.author, "jane-doe");
  assert.equal(record.file, "pages/hello.md");
});

test("a page created without an author is listed, with how to credit one (TR01196)", async (site) => {
  const workspace = await fixture(site, PUSH_WORKSPACE);
  const wire = api(pushRoutes());
  const { invocation, progress } = invoke(workspace, wire, { verb: "pages push", content: contentStub().module });

  const result = await pagesPush(invocation);

  assert.deepEqual(result.pages.authorless, { total: 1, items: [{ file: "pages/about.md", path: "about" }] });
  assert.equal(wire.matching("POST", PAGES_COLLECTION)[0].body.author, undefined);
  assert.ok(progress.some((line) => line.includes("created without an author") && line.includes("--author")));
});

test("a workspace of authorless pages keeps every content key it had, so nothing is resent", () => {
  // The key as it was computed before authors existed.
  const legacy = workspaceContentHash(
    Buffer.from(JSON.stringify([`sha256:${"1".repeat(64)}`, "About", "about", "Who we are", ""]), "utf8"),
  );
  assert.equal(
    pageContentKey(`sha256:${"1".repeat(64)}`, { title: "About", path: "about", description: "Who we are" }),
    legacy,
  );
  assert.equal(
    pageContentKey(`sha256:${"1".repeat(64)}`, { title: "About", path: "about", description: "Who we are", author: "" }),
    legacy,
  );
  assert.notEqual(
    pageContentKey(`sha256:${"1".repeat(64)}`, {
      title: "About",
      path: "about",
      description: "Who we are",
      author: "jane-doe",
    }),
    legacy,
  );
});

test("pages meta set --author fills a .pm.json page, pull keeps it, push sends it once", async (site) => {
  const workspace = await fixture(site);
  const state = { body: paragraphDocument(BODY_MARKER) };
  const wire = api([authorsRoute(), ...trackedRoutes(state)]);
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  const set = await VERB_HANDLERS["pages meta set"](
    invoke(workspace, wire, { verb: "pages meta set", metaPagePath: "about", metaAuthor: "Jane-Doe" }).invocation,
  );
  assert.equal(set.changed, true);
  assert.equal(set.page.author, "jane-doe");
  const entry = async () => (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).pages
    .find((page) => page.pageId === ABOUT_PAGE_ID);
  assert.equal((await entry()).author, "jane-doe");
  assert.equal((await entry()).baseline.author, undefined);

  // The site has not moved, so a pull keeps the edit instead of restoring "no author".
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  assert.equal((await entry()).author, "jane-doe");

  await pagesPush(
    invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module }).invocation,
  );
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).at(-1).body.author, "jane-doe");
  assert.equal((await entry()).baseline.author, "jane-doe");

  // Now the site holds it; nothing about authorship is resent.
  await pagesPush(
    invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module }).invocation,
  );
  assert.equal(wire.matching("PATCH", PAGE_BY_ID).length, 1);
  await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
  assert.equal((await entry()).author, "jane-doe");
  assert.equal((await entry()).baseline.author, "jane-doe");
});

test("pages meta set --author never replaces the author the site holds, and checks who it names", async (t) => {
  await t.test("a different author is a conflict", async (site) => {
    const workspace = await fixture(site);
    const wire = api([authorsRoute(), ...trackedRoutes({ body: paragraphDocument(BODY_MARKER), authorRef: "bob-smith" })]);
    await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
    await assert.rejects(
      VERB_HANDLERS["pages meta set"](
        invoke(workspace, wire, { verb: "pages meta set", metaPagePath: "about", metaAuthor: "jane-doe" }).invocation,
      ),
      (error) =>
        error?.code === "pages.author_conflict"
        && error.message.includes("pages meta set about --author bob-smith")
        && !error.message.includes('--author ""'),
    );
    // The same author is accepted and changes nothing.
    const same = await VERB_HANDLERS["pages meta set"](
      invoke(workspace, wire, { verb: "pages meta set", metaPagePath: "about", metaAuthor: "Bob-Smith" }).invocation,
    );
    assert.equal(same.changed, false);
  });
  await t.test("someone authors.json does not know is only warned about, and text that is no reference is refused", async (site) => {
    const workspace = await fixture(site);
    const wire = api([authorsRoute(), ...trackedRoutes({ body: paragraphDocument(BODY_MARKER) })]);
    await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
    const { invocation, progress } = invoke(workspace, wire, {
      verb: "pages meta set",
      metaPagePath: "about",
      metaAuthor: "ghost@example.com",
    });
    const result = await VERB_HANDLERS["pages meta set"](invocation);
    // Offline, authors.json is only as fresh as the last pull: the name may be newer.
    assert.equal(result.changed, true);
    assert.equal(result.page.author, "ghost@example.com");
    assert.equal(result.authorWarnings.total, 1);
    assert.equal(result.authorWarnings.items[0].code, "pages.author_unverified");
    assert.ok(progress.some((line) => line.includes("not in authors.json")));
    await assert.rejects(
      VERB_HANDLERS["pages meta set"](
        invoke(workspace, wire, { verb: "pages meta set", metaPagePath: "about", metaAuthor: "Not A Handle" })
          .invocation,
      ),
      (error) => error?.code === "pages.author_invalid",
    );
  });
  await t.test("an empty --author drops a pending author, and never asks the site to remove one", async (site) => {
    const workspace = await fixture(site);
    const state = { body: paragraphDocument(BODY_MARKER) };
    const wire = api([authorsRoute(), ...trackedRoutes(state)]);
    await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
    const manifestEntry = async () => (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).pages
      .find((page) => page.pageId === ABOUT_PAGE_ID);

    await cliRun(workspace, ["pages", "meta", "set", "about", "--author", "jane-doe"], wire);
    assert.equal((await manifestEntry()).author, "jane-doe");
    const cleared = await cliRun(workspace, ["pages", "meta", "set", "about", "--author", ""], wire);
    assert.equal(cleared.exitCode, 0, cleared.stderr);
    assert.equal(cleared.result.changed, true);
    assert.equal(cleared.result.page.author, undefined);
    assert.equal((await manifestEntry()).author, undefined);
    // Nothing pending any more: saying so again changes nothing.
    const again = await cliRun(workspace, ["pages", "meta", "set", "about", "--author", ""], wire);
    assert.equal(again.result.changed, false);

    // Once the site holds an author, only the app changes it.
    state.authorRef = "bob-smith";
    await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
    assert.equal((await manifestEntry()).author, "bob-smith");
    const refused = await cliRun(workspace, ["pages", "meta", "set", "about", "--author", ""], wire);
    assert.equal(refused.exitCode, 1);
    assert.equal(refused.result.error.code, "pages.author_conflict");
    assert.equal((await manifestEntry()).author, "bob-smith");
  });
  await t.test("a pull keeps a pending author the site disagrees with, and says how to settle it", async (site) => {
    const workspace = await fixture(site);
    const state = { body: paragraphDocument(BODY_MARKER) };
    const wire = api([authorsRoute(), ...trackedRoutes(state)]);
    await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
    await cliRun(workspace, ["pages", "meta", "set", "about", "--author", "jane-doe"], wire);

    // Someone credited the page in the app after the pending edit was made.
    state.authorRef = "bob-smith";
    const { invocation, progress } = invoke(workspace, wire, { verb: "pull" });
    await pull(invocation);

    const entry = (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).pages
      .find((page) => page.pageId === ABOUT_PAGE_ID);
    assert.equal(entry.author, "jane-doe");
    assert.equal(entry.baseline.author, "bob-smith");
    const notice = progress.find((line) => line.includes("Kept the local author"));
    assert.ok(notice?.includes("'bob-smith'"), progress.join("\n"));
    assert.ok(notice.includes("pages meta set about --author bob-smith"));
  });
  await t.test("a Markdown page points at its front matter", async (site) => {
    const workspace = await fixture(site, {
      ".taproot-site-manifest.json": manifestFixture([trackedAboutEntry()]),
      "pages/about.md": ABOUT_MARKDOWN,
    });
    await assert.rejects(
      VERB_HANDLERS["pages meta set"](
        invoke(workspace, api([]), { verb: "pages meta set", metaPagePath: "about", metaAuthor: "jane-doe" })
          .invocation,
      ),
      (error) => error?.code === "pages.meta_markdown",
    );
  });
  await t.test("--author reaches the verb from the command line", async (site) => {
    const workspace = await fixture(site);
    const wire = api([authorsRoute(), ...trackedRoutes({ body: paragraphDocument(BODY_MARKER) })]);
    await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
    const run = await cliRun(workspace, ["pages", "meta", "set", "about", "--author", "jane-doe"], wire);
    assert.equal(run.exitCode, 0, run.stderr);
    assert.equal(run.result.page.author, "jane-doe");
    const empty = await cliRun(workspace, ["pages", "meta", "set", "about", "--author"], wire);
    assert.equal(empty.exitCode, 2);
  });
});

test("pages push refuses an author it can already tell is wrong, before anything is sent", async (t) => {
  const markdown = (author) => `---\ntitle: Hello\npath: hello\nauthor: ${author}\n---\n\nHello.\n`;
  const recorded = { authors: [{ handle: "jane-doe", displayName: "Jane" }], members: [OWNER_MEMBER] };
  const codes = async (site, author, { withAuthors = true, routes = [], dryRun = false } = {}) => {
    const workspace = await fixture(site, {
      ".taproot-site-manifest.json": manifestFixture([]),
      ...(withAuthors ? { "authors.json": { siteId: SITE_ID, ...recorded } } : {}),
      "pages/hello.md": markdown(author),
    });
    const wire = api([...routes, ...pushRoutes()]);
    const error = await pagesPush(
      invoke(workspace, wire, { verb: "pages push", dryRun, content: contentStub().module }).invocation,
    ).then(() => undefined, (caught) => caught);
    return { workspace, error, wire, codes: [error?.code, ...(error?.problems ?? []).map((problem) => problem.code)] };
  };
  await t.test("text that is no reference", async (site) => {
    const { codes: found, wire } = await codes(site, "Not A Handle");
    assert.ok(found.includes("pages.author_invalid"), found.join());
    assert.deepEqual(writes(wire), []);
  });
  await t.test("someone neither authors.json nor the site lists", async (site) => {
    const { codes: found, wire } = await codes(site, "ghost-writer", { routes: [authorsRoute()] });
    assert.ok(found.includes("pages.author_unknown"), found.join());
    assert.deepEqual(writes(wire), []);
    // Asked once, however the miss was found.
    assert.equal(wire.matching("GET", AUTHORS).length, 1);
  });
  await t.test("a stale authors.json is refreshed from the site before anyone is refused", async (site) => {
    const added = { handle: "john-doe", displayName: "John Doe", hasEmail: false };
    const { workspace, error, wire } = await codes(site, "john-doe", {
      routes: [authorsRoute({ authors: [JANE, added], members: [OWNER_MEMBER] })],
    });
    assert.equal(error, undefined);
    assert.equal(wire.matching("POST", PAGES_COLLECTION)[0].body.author, "john-doe");
    assert.deepEqual((await readWorkspaceJson(workspace, "authors.json")).authors.map((author) => author.handle), [
      "jane-doe",
      "john-doe",
    ]);
  });
  await t.test("a dry run asks the site but writes no authors.json", async (site) => {
    const added = { handle: "john-doe", displayName: "John Doe", hasEmail: false };
    const route = authorsRoute({ authors: [JANE, added], members: [OWNER_MEMBER] });
    const stale = await codes(site, "john-doe", { routes: [route], dryRun: true });
    assert.equal(stale.error, undefined);
    assert.deepEqual(writes(stale.wire), []);
    assert.deepEqual(
      (await readWorkspaceJson(stale.workspace, "authors.json")).authors.map((author) => author.handle),
      ["jane-doe"],
    );
    const missing = await codes(site, "john-doe", { routes: [route], withAuthors: false, dryRun: true });
    assert.equal(missing.error, undefined);
    assert.equal(await workspaceHas(missing.workspace, "authors.json"), false);
  });
  await t.test("a listed author needs no request for the list", async (site) => {
    const { error, wire } = await codes(site, "Jane-Doe");
    assert.equal(error, undefined);
    assert.equal(wire.matching("GET", AUTHORS).length, 0);
    assert.equal(wire.matching("POST", PAGES_COLLECTION)[0].body.author, "jane-doe");
  });
  await t.test("with no authors.json the site is asked, and a list it cannot give leaves the name to the site", async (site) => {
    const refused = await codes(site, "ghost-writer", { withAuthors: false, routes: [authorsRoute()] });
    assert.ok(refused.codes.includes("pages.author_unknown"), refused.codes.join());
    assert.deepEqual(writes(refused.wire), []);

    const unreadable = await codes(site, "ghost-writer", {
      withAuthors: false,
      routes: [{ method: "GET", pattern: AUTHORS, reply: () => jsonResponse({ code: 5, message: "not found" }, 404) }],
    });
    assert.equal(unreadable.error, undefined);
    assert.equal(unreadable.wire.matching("POST", PAGES_COLLECTION)[0].body.author, "ghost-writer");
  });
  await t.test("a different author than the page already has", async (site) => {
    const workspace = await fixture(site, {
      ".taproot-site-manifest.json": manifestFixture([
        trackedAboutEntry({ author: "bob-smith", baseline: { author: "bob-smith" } }),
      ]),
      "authors.json": { siteId: SITE_ID, ...recorded },
      "pages/about.md": ABOUT_MARKDOWN.replace("description:", "author: jane-doe\ndescription:"),
    });
    const wire = api(pushRoutes({
      live: [pageSummary({
        pageId: ABOUT_PAGE_ID,
        path: "about",
        title: "About us",
        authorRef: "bob-smith",
        authorDisplayName: "Bob Smith",
      })],
    }));
    const error = await pagesPush(
      invoke(workspace, wire, { verb: "pages push", content: contentStub().module }).invocation,
    ).then(() => undefined, (caught) => caught);
    const found = [error?.code, ...(error?.problems ?? []).map((problem) => problem.code)];
    assert.ok(found.includes("pages.author_conflict"), found.join());
    assert.deepEqual(writes(wire), []);
    // A Markdown page is told to fix its front matter.
    const conflict = (error.problems ?? [error]).find((problem) => problem.code === "pages.author_conflict");
    assert.match(conflict.message, /front matter/u);
    assert.match(conflict.message, /bob-smith/u);
  });
  await t.test("an author the site dropped (a discarded draft) is sent again with the next edit", async (site) => {
    const workspace = await fixture(site);
    const state = { body: paragraphDocument(BODY_MARKER), authorRef: "jane-doe" };
    const wire = api([authorsRoute(), ...trackedRoutes(state)]);
    await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
    await VERB_HANDLERS["pages meta set"](
      invoke(workspace, wire, { verb: "pages meta set", metaPagePath: "about", metaDescription: "Small." }).invocation,
    );
    const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
    manifest.pages.find((page) => page.pageId === ABOUT_PAGE_ID).author = "jane-doe";
    await writeFile(workspacePath(workspace, ".taproot-site-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    // The app discarded the draft that carried the author: the site credits nobody now.
    state.authorRef = "";
    await writeFile(
      workspacePath(workspace, "pages/about.pm.json"),
      `${JSON.stringify(paragraphDocument("edited here"), undefined, 2)}\n`,
    );
    await pagesPush(
      invoke(workspace, wire, { verb: "pages push", pagePaths: ["about"], content: contentStub().module }).invocation,
    );
    assert.equal(wire.matching("PATCH", PAGE_BY_ID).at(-1).body.author, "jane-doe");
  });
  await t.test("a .pm.json page is told to use pages meta set, not to edit its source", async (site) => {
    const workspace = await fixture(site);
    const wire = api([authorsRoute(), ...trackedRoutes({ body: paragraphDocument(BODY_MARKER), authorRef: "bob-smith" })]);
    await pull(invoke(workspace, wire, { verb: "pull" }).invocation);
    // An unsent `pages meta set --author jane-doe` that the site has since overtaken.
    const manifest = await readWorkspaceJson(workspace, ".taproot-site-manifest.json");
    manifest.pages.find((page) => page.pageId === ABOUT_PAGE_ID).author = "jane-doe";
    await writeFile(workspacePath(workspace, ".taproot-site-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const before = writes(wire).length;

    const error = await pagesPush(
      invoke(workspace, wire, { verb: "pages push", content: contentStub().module }).invocation,
    ).then(() => undefined, (caught) => caught);

    const conflict = (error?.problems ?? [error]).find((problem) => problem?.code === "pages.author_conflict");
    assert.ok(conflict, String(error?.code));
    assert.match(conflict.message, /pages meta set about --author bob-smith/u);
    // Clearing is refused once the site holds an author, so it is not offered.
    assert.doesNotMatch(conflict.message, /--author ""/u);
    assert.doesNotMatch(conflict.message, /remove the author from the page's source/u);
    assert.equal(writes(wire).length, before);
  });
});

test("the site's two author refusals reach the operator under their documented codes", async (t) => {
  for (const [field, code] of [["AuthorUnknown", "pages.author_unknown"], ["AuthorConflict", "pages.author_conflict"]]) {
    await t.test(field, async (site) => {
      const workspace = await fixture(site, {
        ".taproot-site-manifest.json": manifestFixture([]),
        "pages/hello.md": "---\ntitle: Hello\npath: hello\nauthor: jane-doe\n---\n\nHello.\n",
      });
      const wire = api([
        // The site lists her, so the refusal below is the site's own, reached on a race.
        authorsRoute(),
        { method: "GET", pattern: PAGES_LIST, reply: { pages: [], nextPageToken: "" } },
        {
          method: "POST",
          pattern: PAGES_COLLECTION,
          reply: () => jsonResponse(violation(field, "No site author or member who can create pages is named 'jane-doe'."), 400),
        },
      ]);
      await assert.rejects(
        pagesPush(invoke(workspace, wire, { verb: "pages push", content: contentStub().module }).invocation),
        (error) => error?.code === code && error.message.includes("jane-doe"),
      );
    });
  }
});

test("a pulled site records each page's author on its manifest entry, and a former member's page records none", async (site) => {
  const workspace = await fixture(site);
  const state = { body: paragraphDocument(BODY_MARKER), authorRef: "owner@example.com" };
  const wire = api([authorsRoute(), ...trackedRoutes(state)]);

  const result = await pull(invoke(workspace, wire, { verb: "pull" }).invocation);

  assert.deepEqual(result.authors, { file: "authors.json", authors: 1, members: 1 });
  const entry = (await readWorkspaceJson(workspace, ".taproot-site-manifest.json")).pages
    .find((page) => page.pageId === ABOUT_PAGE_ID);
  assert.equal(entry.author, "owner@example.com");
  assert.equal(entry.baseline.author, "owner@example.com");
});

test("validate cannot prove an author absent from a stale authors.json, so it warns instead of refusing", async (site) => {
  const files = (author) => ({
    "authors.json": { siteId: SITE_ID, authors: [{ handle: "jane-doe", displayName: "Jane" }], members: [] },
    "pages/about.md": `---\ntitle: About us\npath: about\nauthor: ${author}\n---\n\nHello.\n`,
  });
  const known = await fixture(site, wholeWorkspace({ uploaded: true, files: files("jane-doe") }));
  const passed = await cliRun(known, ["validate"]);
  assert.equal(passed.exitCode, 0, passed.stderr);
  assert.equal(passed.result.authorWarnings, undefined);

  // The name may have been added since authors.json was written: flagged, not refused.
  const unknown = await fixture(site, wholeWorkspace({ uploaded: true, files: files("ghost-writer") }));
  const warned = await cliRun(unknown, ["validate"]);
  assert.equal(warned.exitCode, 0, warned.stderr);
  assert.equal(warned.result.authorWarnings.total, 1);
  assert.deepEqual(
    { code: warned.result.authorWarnings.items[0].code, file: warned.result.authorWarnings.items[0].file },
    { code: "pages.author_unverified", file: "pages/about.md" },
  );

  // What it can prove offline it still refuses.
  const malformed = await fixture(site, wholeWorkspace({ uploaded: true, files: files("Not A Handle") }));
  const failed = await cliRun(malformed, ["validate"]);
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.result.error.code, "pages.author_invalid");
});
