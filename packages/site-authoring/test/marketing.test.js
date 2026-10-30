import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import campaignRules from "../src/analytics-campaign.json" with { type: "json" };
import linkLabelRules from "../src/analytics-link-label.json" with { type: "json" };
import {
  isMarketingKey,
  MARKETING_KINDS,
  projectMarketingDocument,
  validateMarketingDocument,
} from "../src/marketing-contract.js";

const SITE_ID = "aaaa1111-bbbb-4111-8111-cccc11111111";
const API_BASE_URL = "https://app.taproot.test/api";
const KEY = "tr_live_site_key_for_marketing_tests";
const MANIFEST = { manifestVersion: 7, siteId: SITE_ID, pages: [] };
const CAMPAIGN_ID = "bbbb2222-cccc-4222-8222-dddd22222222";
const OLD_CAMPAIGN_ID = "cccc3333-dddd-4333-8333-eeee33333333";
const PLACEMENT_ID = "dddd4444-eeee-4444-8444-ffff44444444";

async function workspace(testContext, files = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "taproot-site-marketing-"));
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
  await mkdir(path.join(configHome, "taproot-site"), { recursive: true });
  await writeFile(
    path.join(configHome, "taproot-site", "settings.json"),
    `${JSON.stringify({ schemaVersion: 1, apiBaseUrl: API_BASE_URL })}\n`,
  );
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(workspaceDir, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, typeof contents === "string" ? contents : `${JSON.stringify(contents, undefined, 2)}\n`);
  }
  return { project, workspaceDir, configHome };
}

function jsonResponse(value, httpStatus = 200) {
  return new Response(JSON.stringify(value), { status: httpStatus, headers: { "content-type": "application/json" } });
}

function refusal(field, description) {
  return jsonResponse(
    { code: 3, message: "invalid", details: [{ fieldViolations: [{ field, description }] }] },
    400,
  );
}

const STATE = {
  campaigns: {
    live: "SITE_CAMPAIGN_STATE_LIVE",
    publishing: "SITE_CAMPAIGN_STATE_PUBLISHING",
    archived: "SITE_CAMPAIGN_STATE_ARCHIVED",
  },
  placements: {
    live: "SITE_LINK_LABEL_STATE_LIVE",
    publishing: "SITE_LINK_LABEL_STATE_PUBLISHING",
    archived: "SITE_LINK_LABEL_STATE_ARCHIVED",
  },
};

/** A record as the site returns it. */
function wire(kind, { id, key, name, note, startsOn, endsOn, state = "live", releasedAt }) {
  return {
    id,
    key,
    name,
    ...(note === undefined ? {} : { note }),
    ...(startsOn === undefined ? {} : { startsOn: `${startsOn}T00:00:00Z` }),
    ...(endsOn === undefined ? {} : { endsOn: `${endsOn}T00:00:00Z` }),
    state: STATE[kind][state],
    createdAt: "2026-02-01T10:00:00Z",
    ...(state === "archived" ? { archivedAt: "2026-02-20T10:00:00Z" } : {}),
    ...(releasedAt === undefined ? {} : { releasedAt }),
  };
}

const ROUTES = {
  campaigns: { path: "campaigns", list: "campaigns", id: "campaignId", state: STATE.campaigns },
  placements: { path: "link-labels", list: "linkLabels", id: "linkLabelId", state: STATE.placements },
};

/**
 * A scripted site that models the real states: a created record is publishing, an archived one keeps its key for
 * ever, and a restore starts a new release. `state.records.<kind>` maps id to wire record.
 */
function scriptedSite(state) {
  const calls = [];
  const maxActive = state.maxActive ?? { campaigns: 50, placements: 200 };
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, pathname: target.pathname, body });
    const refused = method === "GET" ? undefined : await state.beforeWrite?.({ method, pathname: target.pathname, body });
    if (refused !== undefined) return refused;
    for (const [kind, route] of Object.entries(ROUTES)) {
      const base = `/api/v1/sites/${SITE_ID}/${route.path}`;
      const records = state.records[kind];
      const archivedState = route.state.archived;
      const active = () => Object.values(records).filter((record) => record.state !== archivedState).length;
      if (method === "GET" && target.pathname === base) {
        return jsonResponse({
          [route.list]: Object.values(records),
          canManage: state.canManage ?? true,
          maxActive: maxActive[kind],
        });
      }
      if (method === "POST" && target.pathname === base) {
        if (Object.values(records).some((record) => record.key === body.key)) {
          return refusal("Key", "That key is already used by a record on this site, archived ones included. Choose another.");
        }
        if (active() >= maxActive[kind]) {
          return refusal("Key", `A site can have up to ${maxActive[kind]} active ${kind}. Archive one to make room.`);
        }
        const created = {
          id: body[route.id],
          key: body.key,
          name: body.name,
          ...(body.note ? { note: body.note } : {}),
          ...(body.startsOn ? { startsOn: body.startsOn } : {}),
          ...(body.endsOn ? { endsOn: body.endsOn } : {}),
          state: route.state.publishing,
          createdAt: "2026-03-01T10:00:00Z",
        };
        records[created.id] = created;
        return jsonResponse(created);
      }
      const one = target.pathname.match(new RegExp(`^${base}/([^/]+)(?:/(archive|restore))?$`, "u"));
      if (one && records[one[1]] !== undefined) {
        const record = records[one[1]];
        if (method === "PUT" && one[2] === undefined) {
          record.name = body.name;
          if (body.note !== undefined) record.note = body.note;
          if (body.note === "") delete record.note;
          if (body.startsOn) record.startsOn = body.startsOn; else delete record.startsOn;
          if (body.endsOn) record.endsOn = body.endsOn; else delete record.endsOn;
          return jsonResponse(record);
        }
        if (method === "POST" && one[2] === "archive") {
          record.state = archivedState;
          record.archivedAt = "2026-03-02T10:00:00Z";
          return jsonResponse(record);
        }
        if (method === "POST" && one[2] === "restore") {
          if (record.state === archivedState && active() >= maxActive[kind]) {
            return refusal("CampaignId", `A site can have up to ${maxActive[kind]} active ${kind}. Archive one to make room.`);
          }
          record.state = route.state.publishing;
          delete record.archivedAt;
          return jsonResponse(record);
        }
      }
    }
    return jsonResponse({ code: 12, message: "unscripted" }, 501);
  };
  return { calls, fetchImpl, state };
}

async function runWithSite(site, scripted, arguments_) {
  let stdout = "";
  let stderr = "";
  const exit = await runCli({
    arguments_,
    cwd: site.project,
    environment: { XDG_CONFIG_HOME: site.configHome, HOME: site.configHome, TAPROOT_SITE_KEY: KEY },
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
    fetch: scripted.fetchImpl,
  });
  return { exit, result: JSON.parse(stdout), stderr };
}

const writes = (scripted) => scripted.calls.filter((call) => call.method !== "GET");
const writtenPaths = (scripted) => writes(scripted).map((call) => `${call.method} ${call.pathname.split(`${SITE_ID}/`)[1]}`);

async function readText(site, relative) {
  return await readFile(path.join(site.workspaceDir, ...relative.split("/")), "utf8");
}

async function readJson(site, relative) {
  return JSON.parse(await readText(site, relative));
}

async function putJson(site, relative, value) {
  await writeFile(path.join(site.workspaceDir, ...relative.split("/")), `${JSON.stringify(value, undefined, 2)}\n`);
}

function seededRecords() {
  return {
    campaigns: {
      [CAMPAIGN_ID]: wire("campaigns", {
        id: CAMPAIGN_ID,
        key: "spring-26",
        name: "Spring launch",
        note: "Newsletter push",
        startsOn: "2026-03-01",
        endsOn: "2026-03-31",
        releasedAt: "2026-03-04T12:34:56.789Z",
      }),
      [OLD_CAMPAIGN_ID]: wire("campaigns", { id: OLD_CAMPAIGN_ID, key: "winter-25", name: "Winter", state: "archived" }),
    },
    placements: {
      [PLACEMENT_ID]: wire("placements", { id: PLACEMENT_ID, key: "nl-footer", name: "Newsletter footer", state: "publishing" }),
    },
  };
}

async function pulledSite(t, records = seededRecords(), extra = {}) {
  const site = await workspace(t, { ".taproot-site-manifest.json": MANIFEST });
  const scripted = scriptedSite({ records, ...extra });
  const pulled = await runWithSite(site, scripted, ["marketing", "pull"]);
  assert.equal(pulled.exit, 0, pulled.stderr);
  scripted.calls.length = 0;
  return { site, scripted };
}

// ---------------------------------------------------------------------------
// The file contract
// ---------------------------------------------------------------------------

test("the key grammar passes the shared vectors for campaigns and placements", () => {
  for (const { value, valid } of [...campaignRules.vectors, ...linkLabelRules.vectors]) {
    assert.equal(isMarketingKey(value), valid, JSON.stringify(value));
  }
});

test("a marketing file is a closed object of closed records", () => {
  const campaign = { key: "spring-26", name: "Spring launch" };
  assert.deepEqual(validateMarketingDocument("campaigns", { campaigns: [campaign] }), [campaign]);
  const refused = [
    [{ campaigns: [], extra: [] }, /'extra' is not a property/u],
    [{ campaigns: {} }, /must be an array/u],
    [{ campaigns: [{ ...campaign, status: "live" }] }, /'status' is not a campaign property/u],
    [{ campaigns: [{ ...campaign, key: "Spring" }] }, /key must be 3 to 32 lowercase/u],
    [{ campaigns: [{ ...campaign, key: "promo-123456789" }] }, /key must be/u],
    [{ campaigns: [campaign, campaign] }, /more than once/u],
    [{ campaigns: [{ ...campaign, name: " Spring" }] }, /no space at either end/u],
    [{ campaigns: [{ ...campaign, name: "" }] }, /must not be empty/u],
    [{ campaigns: [{ ...campaign, name: "x".repeat(81) }] }, /at most 80/u],
    [{ campaigns: [{ ...campaign, note: "x".repeat(501) }] }, /at most 500/u],
    [{ campaigns: [{ ...campaign, name: "Bad\u0000name" }] }, /NUL or an unpaired surrogate/u],
    [{ campaigns: [{ ...campaign, starts_on: "2026-02-30" }] }, /YYYY-MM-DD/u],
    [{ campaigns: [{ ...campaign, starts_on: "2026-04-01", ends_on: "2026-03-01" }] }, /cannot be before/u],
    [{ campaigns: [{ ...campaign, state: "archived" }] }, /--archive/u],
    [{ campaigns: [{ ...campaign, state: "soon" }] }, /read-only and one of/u],
    [{ campaigns: [{ ...campaign, counted_from: "yesterday" }] }, /read-only and a day/u],
  ];
  for (const [document_, message] of refused) {
    assert.throws(() => validateMarketingDocument("campaigns", document_), message);
  }
  // A placement has no note or dates.
  assert.throws(
    () => validateMarketingDocument("placements", { placements: [{ key: "nl-footer", name: "Footer", note: "x" }] }),
    /'note' is not a placement property/u,
  );
});

test("a name or note may hold any text the site stores, and NUL and unpaired surrogates are refused", () => {
  const record = { key: "spring-26", name: "Spring\tlaunch", note: "Line one\r\nLine two\ta\u0007b" };
  assert.deepEqual(validateMarketingDocument("campaigns", { campaigns: [record] }), [record]);
  assert.deepEqual(
    validateMarketingDocument("placements", { placements: [{ key: "nl-footer", name: "Foot\ter" }] }),
    [{ key: "nl-footer", name: "Foot\ter" }],
  );
  for (const bad of ["a\u0000b", "a\ud800b", "a\udc00b"]) {
    assert.throws(() => validateMarketingDocument("campaigns", { campaigns: [{ ...record, note: bad }] }), /unpaired surrogate/u);
    assert.throws(() => validateMarketingDocument("placements", { placements: [{ key: "nl-footer", name: bad }] }), /unpaired surrogate/u);
  }
});

test("a file projects records by key in one canonical property order", () => {
  assert.deepEqual(
    projectMarketingDocument("campaigns", [
      { counted_from: "2026-03-04", state: "live", ends_on: "2026-03-31", name: "B", key: "bbbbb" },
      { name: "A", key: "aaaaa", note: "n", starts_on: "2026-03-01" },
    ]),
    {
      campaigns: [
        { key: "aaaaa", name: "A", note: "n", starts_on: "2026-03-01" },
        { key: "bbbbb", name: "B", ends_on: "2026-03-31", state: "live", counted_from: "2026-03-04" },
      ],
    },
  );
  assert.equal(MARKETING_KINDS.placements.route, "link-labels");
});

// ---------------------------------------------------------------------------
// marketing pull
// ---------------------------------------------------------------------------

test("marketing pull writes canonical files, records a baseline, and lists archived records without writing them", async (t) => {
  const site = await workspace(t, { ".taproot-site-manifest.json": MANIFEST });
  const scripted = scriptedSite({ records: seededRecords() });
  const { exit, result } = await runWithSite(site, scripted, ["marketing", "pull"]);

  assert.equal(exit, 0);
  assert.deepEqual(result.marketing.campaigns, {
    file: "marketing/campaigns.json",
    total: 1,
    items: [{ key: "spring-26", state: "live" }],
    archived: ["winter-25"],
    archivedTotal: 1,
    canManage: true,
    maxActive: 50,
  });
  assert.deepEqual(result.marketing.placements.items, [{ key: "nl-footer", state: "publishing" }]);
  assert.deepEqual(await readJson(site, "marketing/campaigns.json"), {
    campaigns: [{
      key: "spring-26",
      name: "Spring launch",
      note: "Newsletter push",
      starts_on: "2026-03-01",
      ends_on: "2026-03-31",
      state: "live",
      counted_from: "2026-03-04",
    }],
  });
  assert.deepEqual(await readJson(site, "marketing/placements.json"), {
    placements: [{ key: "nl-footer", name: "Newsletter footer", state: "publishing" }],
  });
  const manifest = await readJson(site, ".taproot-site-manifest.json");
  assert.deepEqual(Object.keys(manifest.marketing.campaigns.items), ["spring-26", "winter-25"]);
  assert.equal(manifest.marketing.campaigns.items["winter-25"].archived, true);
  assert.deepEqual(writes(scripted), []);
});

test("marketing pull needs a pulled workspace", async (t) => {
  const site = await workspace(t);
  const { exit, result } = await runWithSite(site, scriptedSite({ records: seededRecords() }), ["marketing", "pull"]);
  assert.equal(exit, 1);
  assert.equal(result.error.code, "workspace.manifest_missing");
});

test("marketing pull says why a site cannot list campaigns", async (t) => {
  const site = await workspace(t, { ".taproot-site-manifest.json": MANIFEST });
  const scripted = scriptedSite({ records: seededRecords() });
  const refusingFetch = async (url, init) => {
    if (new URL(url).pathname.endsWith("/campaigns")) {
      return jsonResponse({ code: 9, message: "This site's licence does not include analytics." }, 400);
    }
    return await scripted.fetchImpl(url, init);
  };
  const { exit, result } = await runWithSite(site, { fetchImpl: refusingFetch }, ["marketing", "pull"]);
  assert.equal(exit, 1);
  assert.equal(result.error.code, "marketing.unavailable");
});

// ---------------------------------------------------------------------------
// marketing push
// ---------------------------------------------------------------------------

test("marketing push after pull is unchanged and writes nothing", async (t) => {
  const { site, scripted } = await pulledSite(t);
  const before = [await readText(site, "marketing/campaigns.json"), await readText(site, "marketing/placements.json")];

  const { exit, result } = await runWithSite(site, scripted, ["marketing", "push"]);

  assert.equal(exit, 0);
  assert.deepEqual(result.marketing.campaigns.unchanged, ["spring-26"]);
  assert.deepEqual(result.marketing.placements.unchanged, ["nl-footer"]);
  assert.equal(result.written.count, 0);
  assert.deepEqual(writes(scripted), []);
  assert.deepEqual([await readText(site, "marketing/campaigns.json"), await readText(site, "marketing/placements.json")], before);
});

test("marketing push creates a new key and updates the labels of an existing one", async (t) => {
  const { site, scripted } = await pulledSite(t);
  const campaigns = await readJson(site, "marketing/campaigns.json");
  campaigns.campaigns[0].name = "Spring launch 2026";
  campaigns.campaigns[0].note = "";
  delete campaigns.campaigns[0].ends_on;
  campaigns.campaigns.push({ key: "summer-26", name: "Summer sale", note: "Sunscreen", starts_on: "2026-06-01" });
  await putJson(site, "marketing/campaigns.json", campaigns);

  const { exit, result } = await runWithSite(site, scripted, ["marketing", "push"]);

  assert.equal(exit, 0);
  assert.deepEqual(result.marketing.campaigns.created, ["summer-26"]);
  assert.deepEqual(result.marketing.campaigns.updated, ["spring-26"]);
  assert.deepEqual(writtenPaths(scripted), [`PUT campaigns/${CAMPAIGN_ID}`, "POST campaigns"]);
  const created = writes(scripted)[1].body;
  assert.match(created.campaignId, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(
    { key: created.key, name: created.name, note: created.note, startsOn: created.startsOn, endsOn: created.endsOn },
    { key: "summer-26", name: "Summer sale", note: "Sunscreen", startsOn: "2026-06-01T00:00:00Z", endsOn: undefined },
  );
  const updated = writes(scripted)[0].body;
  assert.deepEqual(
    { name: updated.name, note: updated.note, startsOn: updated.startsOn, endsOn: updated.endsOn },
    { name: "Spring launch 2026", note: "", startsOn: "2026-03-01T00:00:00Z", endsOn: undefined },
  );
  // The file is rewritten from what the site now holds, with the new record's state.
  const rewritten = await readJson(site, "marketing/campaigns.json");
  assert.deepEqual(rewritten.campaigns.map((record) => [record.key, record.state]), [["spring-26", "live"], ["summer-26", "publishing"]]);
  // And a second push has nothing to do.
  scripted.calls.length = 0;
  const again = await runWithSite(site, scripted, ["marketing", "push"]);
  assert.equal(again.result.written.count, 0);
  assert.deepEqual(writes(scripted), []);
});

test("marketing push never archives what the file leaves out unless --archive says so", async (t) => {
  const { site, scripted } = await pulledSite(t);
  await putJson(site, "marketing/campaigns.json", { campaigns: [] });

  const kept = await runWithSite(site, scripted, ["marketing", "push"]);
  assert.equal(kept.exit, 0);
  assert.deepEqual(kept.result.marketing.campaigns.unlisted, ["spring-26"]);
  assert.deepEqual(kept.result.marketing.campaigns.archived, []);
  assert.deepEqual(writes(scripted), []);
  assert.match(kept.stderr, /Push with --archive/u);

  const archived = await runWithSite(site, scripted, ["marketing", "push", "--archive"]);
  assert.equal(archived.exit, 0);
  assert.deepEqual(archived.result.marketing.campaigns.archived, ["spring-26"]);
  assert.deepEqual(writtenPaths(scripted), [`POST campaigns/${CAMPAIGN_ID}/archive`]);
  assert.deepEqual(await readJson(site, "marketing/campaigns.json"), { campaigns: [] });
  // The placements file was not touched by --archive on an unchanged file.
  assert.deepEqual(archived.result.marketing.placements.archived, []);
});

test("marketing push --archive leaves alone a record this workspace never pulled", async (t) => {
  const { site, scripted } = await pulledSite(t);
  scripted.state.records.campaigns["dddd4444-eeee-4444-8444-ffff44444441"] = wire("campaigns", {
    id: "dddd4444-eeee-4444-8444-ffff44444441",
    key: "made-in-app",
    name: "Made in the app",
  });
  await putJson(site, "marketing/campaigns.json", { campaigns: [] });

  const { result } = await runWithSite(site, scripted, ["marketing", "push", "--archive"]);

  assert.deepEqual(result.marketing.campaigns.archived, ["spring-26"]);
  assert.deepEqual(result.marketing.campaigns.unpulled, ["made-in-app"]);
  assert.equal(scripted.state.records.campaigns["dddd4444-eeee-4444-8444-ffff44444441"].state, STATE.campaigns.live);
});

test("marketing push restores an archived key the file names, updating its labels when they differ", async (t) => {
  const { site, scripted } = await pulledSite(t);
  const campaigns = await readJson(site, "marketing/campaigns.json");
  campaigns.campaigns.push({ key: "winter-25", name: "Winter again" });
  await putJson(site, "marketing/campaigns.json", campaigns);

  const { exit, result } = await runWithSite(site, scripted, ["marketing", "push"]);

  assert.equal(exit, 0);
  assert.deepEqual(result.marketing.campaigns.restored, ["winter-25"]);
  assert.deepEqual(result.marketing.campaigns.created, []);
  assert.deepEqual(writtenPaths(scripted), [`PUT campaigns/${OLD_CAMPAIGN_ID}`, `POST campaigns/${OLD_CAMPAIGN_ID}/restore`]);
  assert.equal(scripted.state.records.campaigns[OLD_CAMPAIGN_ID].name, "Winter again");
  assert.equal(scripted.state.records.campaigns[OLD_CAMPAIGN_ID].state, STATE.campaigns.publishing);
  // Restored once, so a second push is a no-op and does not loop on the key.
  scripted.calls.length = 0;
  assert.equal((await runWithSite(site, scripted, ["marketing", "push"])).result.written.count, 0);
  assert.deepEqual(writes(scripted), []);
});

test("a changed key is a new record, and the old one is archived only on request, before the create", async (t) => {
  const { site, scripted } = await pulledSite(t, seededRecords(), { maxActive: { campaigns: 1, placements: 200 } });
  const campaigns = await readJson(site, "marketing/campaigns.json");
  campaigns.campaigns[0].key = "spring-2026";
  await putJson(site, "marketing/campaigns.json", campaigns);

  // Without --archive the quota refuses the new key, as the site returns it, and nothing is lost.
  const refused = await runWithSite(site, scripted, ["marketing", "push"]);
  assert.equal(refused.exit, 1);
  assert.match(refused.stderr, /up to 1 active campaigns/u);
  assert.deepEqual(writes(scripted).map((call) => call.method), ["POST"]);

  scripted.calls.length = 0;
  const swapped = await runWithSite(site, scripted, ["marketing", "push", "--archive"]);
  assert.equal(swapped.exit, 0, swapped.stderr);
  assert.deepEqual(writtenPaths(scripted), [`POST campaigns/${CAMPAIGN_ID}/archive`, "POST campaigns"]);
  assert.deepEqual(swapped.result.marketing.campaigns.created, ["spring-2026"]);
  assert.deepEqual(swapped.result.marketing.campaigns.archived, ["spring-26"]);
});

test("marketing push names the key the site already uses, archived ones included", async (t) => {
  const { site, scripted } = await pulledSite(t);
  // 'winter-25' is archived; writing it with a fresh record is not possible, but restoring is. A key in use
  // by a record the workspace never saw is refused toward pull.
  scripted.state.records.campaigns["dddd4444-eeee-4444-8444-ffff44444442"] = wire("campaigns", {
    id: "dddd4444-eeee-4444-8444-ffff44444442",
    key: "made-in-app",
    name: "Made in the app",
  });
  const campaigns = await readJson(site, "marketing/campaigns.json");
  campaigns.campaigns.push({ key: "made-in-app", name: "Mine" });
  await putJson(site, "marketing/campaigns.json", campaigns);

  const { exit, result } = await runWithSite(site, scripted, ["marketing", "push"]);

  assert.equal(exit, 1);
  assert.equal(result.error.code, "marketing.pull_required");
  assert.deepEqual(writes(scripted), []);
});

test("marketing push refuses a record that changed on the site after the pull, before any write", async (t) => {
  const { site, scripted } = await pulledSite(t);
  scripted.state.records.campaigns[CAMPAIGN_ID].name = "Renamed in the app";
  const campaigns = await readJson(site, "marketing/campaigns.json");
  campaigns.campaigns.push({ key: "summer-26", name: "Summer sale" });
  await putJson(site, "marketing/campaigns.json", campaigns);

  const { exit, result } = await runWithSite(site, scripted, ["marketing", "push"]);

  assert.equal(exit, 1);
  assert.equal(result.error.code, "marketing.concurrent_modification");
  assert.equal(result.error.field, "marketing/campaigns.json:spring-26");
  assert.deepEqual(writes(scripted), []);
});

test("marketing push refuses a record that was archived on the site after the pull", async (t) => {
  const { site, scripted } = await pulledSite(t);
  scripted.state.records.campaigns[CAMPAIGN_ID].state = STATE.campaigns.archived;
  const { result } = await runWithSite(site, scripted, ["marketing", "push"]);
  assert.equal(result.error.code, "marketing.concurrent_modification");
  assert.deepEqual(writes(scripted), []);
});

test("marketing push refuses a record the site no longer has", async (t) => {
  const { site, scripted } = await pulledSite(t);
  delete scripted.state.records.campaigns[CAMPAIGN_ID];
  const { result, stderr } = await runWithSite(site, scripted, ["marketing", "push"]);
  assert.equal(result.error.code, "marketing.pull_required");
  assert.match(stderr, /no longer has it/u);
});

test("marketing push validates before reading the site, and says what is missing", async (t) => {
  const { site, scripted } = await pulledSite(t);
  await putJson(site, "marketing/campaigns.json", { campaigns: [{ key: "Bad_Key", name: "x" }] });
  scripted.calls.length = 0;
  const invalid = await runWithSite(site, scripted, ["marketing", "push"]);
  assert.equal(invalid.result.error.code, "marketing.file_invalid");
  assert.equal(invalid.result.error.field, "marketing/campaigns.json:campaigns[0].key");
  assert.deepEqual(scripted.calls, []);

  const empty = await workspace(t, { ".taproot-site-manifest.json": MANIFEST });
  const missing = await runWithSite(empty, scriptedSite({ records: seededRecords() }), ["marketing", "push"]);
  assert.equal(missing.result.error.code, "marketing.file_missing");
});

test("marketing push handles only the kinds whose file exists", async (t) => {
  const { site, scripted } = await pulledSite(t);
  const { rm: remove } = await import("node:fs/promises");
  await remove(path.join(site.workspaceDir, "marketing", "placements.json"));
  const placements = Object.keys(scripted.state.records.placements);

  const { exit, result } = await runWithSite(site, scripted, ["marketing", "push", "--archive"]);

  assert.equal(exit, 0);
  assert.deepEqual(Object.keys(result.marketing), ["campaigns"]);
  assert.deepEqual(Object.keys(scripted.state.records.placements), placements);
  assert.equal(scripted.state.records.placements[PLACEMENT_ID].state, STATE.placements.publishing);
});

test("marketing push keeps the baseline of what landed when a later write is refused", async (t) => {
  const { site, scripted } = await pulledSite(t, seededRecords(), { maxActive: { campaigns: 2, placements: 200 } });
  const campaigns = await readJson(site, "marketing/campaigns.json");
  campaigns.campaigns.push({ key: "summer-26", name: "Summer" }, { key: "autumn-26", name: "Autumn" });
  await putJson(site, "marketing/campaigns.json", campaigns);

  const failed = await runWithSite(site, scripted, ["marketing", "push"]);

  // spring-26 and summer-26 fit the quota of two; autumn-26 is refused as the site words it.
  assert.equal(failed.exit, 1);
  assert.match(failed.stderr, /up to 2 active campaigns/u);
  assert.deepEqual(failed.result.error.completedWrites, ["campaigns:summer-26:created"]);
  const baseline = (await readJson(site, ".taproot-site-manifest.json")).marketing.campaigns.items;
  assert.ok(baseline["summer-26"]);
  assert.equal(baseline["autumn-26"], undefined);
  // The retry sees summer-26 as unchanged, and the quota refuses autumn-26 again without a duplicate.
  scripted.calls.length = 0;
  const retried = await runWithSite(site, scripted, ["marketing", "push"]);
  assert.equal(retried.exit, 1);
  assert.deepEqual(writtenPaths(scripted), ["POST campaigns"]);
  assert.equal(Object.values(scripted.state.records.campaigns).filter((record) => record.key === "summer-26").length, 1);
});

test("placements push the same way, with a name and no labels", async (t) => {
  const { site, scripted } = await pulledSite(t);
  const placements = await readJson(site, "marketing/placements.json");
  placements.placements[0].name = "Footer link";
  placements.placements.push({ key: "bio-link", name: "Bio link" });
  await putJson(site, "marketing/placements.json", placements);

  const { exit, result } = await runWithSite(site, scripted, ["marketing", "push"]);

  assert.equal(exit, 0, result.error?.message);
  assert.deepEqual(result.marketing.placements.created, ["bio-link"]);
  assert.deepEqual(result.marketing.placements.updated, ["nl-footer"]);
  assert.deepEqual(writtenPaths(scripted), [`PUT link-labels/${PLACEMENT_ID}`, "POST link-labels"]);
  assert.deepEqual(Object.keys(writes(scripted)[1].body).sort(), ["key", "linkLabelId", "name"]);
});

test("the options belong to their verbs", async (t) => {
  const { site, scripted } = await pulledSite(t);
  for (const arguments_ of [
    ["marketing", "pull", "--archive"],
    ["marketing", "push", "--archive", "--archive"],
    ["marketing", "push", "spring-26"],
    ["link", "build", "--archive"],
  ]) {
    const { exit } = await runWithSite(site, scripted, arguments_);
    assert.equal(exit, 2, arguments_.join(" "));
  }
  assert.deepEqual(scripted.calls, []);
});

// ---------------------------------------------------------------------------
// link build
// ---------------------------------------------------------------------------

const LINK = ["link", "build", "--domain", "example.com"];

async function build(site, scripted, ...flags) {
  return await runWithSite(site, scripted, [...LINK, ...flags]);
}

test("link build prints one address, derives the medium from the source, and saves nothing", async (t) => {
  const site = await workspace(t);
  const scripted = scriptedSite({ records: { campaigns: {}, placements: {} } });

  const { exit, result } = await build(site, scripted, "--path", "/recipes/spring-salad", "--source", "newsletter");

  assert.equal(exit, 0);
  assert.deepEqual(result.link, {
    address: "https://example.com/recipes/spring-salad?utm_source=newsletter&utm_medium=email",
    host: "example.com",
    path: "/recipes/spring-salad",
    source: "newsletter",
    medium: "email",
  });
  assert.equal(result.notes, undefined);
  assert.deepEqual(scripted.calls, []);
});

test("link build offers the shared sources without reader, and refuses an unknown one", async (t) => {
  const site = await workspace(t);
  const scripted = scriptedSite({ records: { campaigns: {}, placements: {} } });

  const reader = await build(site, scripted, "--path", "/", "--source", "reader");
  assert.equal(reader.exit, 2);
  assert.equal(reader.result.error.code, "link.source_unknown");
  assert.match(reader.stderr, /published page's own share action/u);

  const unknown = await build(site, scripted, "--path", "/", "--source", "tiktok");
  assert.equal(unknown.result.error.code, "link.source_unknown");
  assert.ok(unknown.result.error.alternatives.includes("linkedin"));
  assert.ok(!unknown.result.error.alternatives.includes("reader"));

  const bluesky = await build(site, scripted, "--path", "/", "--source", "bluesky");
  assert.equal(bluesky.result.link.medium, "social");
});

test("link build needs a path and a source, and reads the path as the builder does", async (t) => {
  const site = await workspace(t);
  const scripted = scriptedSite({ records: { campaigns: {}, placements: {} } });

  assert.equal((await build(site, scripted, "--source", "x")).result.error.code, "link.path_missing");
  assert.equal((await build(site, scripted, "--path", "/")).result.error.code, "link.source_missing");

  // The home page, a path without its leading slash, an existing query, and a utm_ pair that is replaced.
  assert.equal((await build(site, scripted, "--path", "", "--source", "x")).result.link.address,
    "https://example.com/?utm_source=x&utm_medium=social");
  assert.equal((await build(site, scripted, "--path", "about", "--source", "x")).result.link.path, "/about");
  assert.equal(
    (await build(site, scripted, "--path", "/a?b=1&utm_source=old#frag", "--source", "x")).result.link.address,
    "https://example.com/a?b=1&utm_source=x&utm_medium=social#frag",
  );

  const other = await build(site, scripted, "--path", "https://elsewhere.test/page", "--source", "x");
  assert.equal(other.result.error.code, "link.path_invalid");
  assert.equal(other.result.error.field, "path");

  const bareDomain = await runWithSite(site, scripted, ["link", "build", "--domain", "https://example.com/", "--path", "/", "--source", "x"]);
  assert.equal(bareDomain.result.error.code, "link.domain_invalid");
});

test("link build refuses a value that swallows the next flag, and an invalid key", async (t) => {
  const site = await workspace(t);
  const scripted = scriptedSite({ records: { campaigns: {}, placements: {} } });

  assert.equal((await build(site, scripted, "--path", "--source", "x")).exit, 2);
  assert.equal((await build(site, scripted, "--path", "/", "--source", "x", "--source", "x")).exit, 2);
  const badKey = await build(site, scripted, "--path", "/", "--source", "x", "--campaign", "Bad_Key");
  assert.equal(badKey.result.error.code, "link.key_invalid");
});

test("link build checks a campaign and placement against the pulled files, and notes one that is not live", async (t) => {
  const { site, scripted } = await pulledSite(t);

  const live = await build(site, scripted, "--path", "/", "--source", "x", "--campaign", "spring-26");
  assert.equal(live.exit, 0);
  assert.equal(live.result.link.address, "https://example.com/?utm_source=x&utm_medium=social&utm_campaign=spring-26");
  assert.equal(live.result.notes, undefined);

  const publishing = await build(
    site, scripted, "--path", "/", "--source", "newsletter", "--campaign", "spring-26", "--placement", "nl-footer",
  );
  assert.equal(
    publishing.result.link.address,
    "https://example.com/?utm_source=newsletter&utm_medium=email&utm_campaign=spring-26&utm_content=nl-footer",
  );
  assert.deepEqual(publishing.result.notes, [
    "Newsletter footer is publishing. Until it is live, page views count under the source only. "
      + "(As of the last marketing pull or push; marketing/placements.json.)",
  ]);
  // The workspace file answered, so the site was not asked.
  assert.deepEqual(scripted.calls, []);
});

test("link build words the note for each state a key can be waiting in", async (t) => {
  const { site, scripted } = await pulledSite(t);
  const expectations = {
    publishing: "Spring launch is publishing. Until it is live, page views count under the source only.",
    goes_live_with_first_publish: "Spring launch goes live with your first publish. Until it is live, page views count under the source only.",
    not_in_current_release: "Spring launch is not in the current release; it goes live with your next publish. Until it is live, page views count under the source only.",
  };
  const fromFile = " (As of the last marketing pull or push; marketing/campaigns.json.)";
  for (const [state, note] of Object.entries(expectations)) {
    // The state a pull recorded for the key is the one reported, not what the file says.
    const manifest = await readJson(site, ".taproot-site-manifest.json");
    manifest.marketing.campaigns.items["spring-26"].state = state;
    await putJson(site, ".taproot-site-manifest.json", manifest);
    const { result } = await build(site, scripted, "--path", "/", "--source", "x", "--campaign", "spring-26");
    assert.deepEqual(result.notes, [`${note}${fromFile}`], state);
  }
});

test("link build refuses a campaign the pulled file does not hold, including one the site archived", async (t) => {
  const { site, scripted } = await pulledSite(t);

  const unknown = await build(site, scripted, "--path", "/", "--source", "x", "--campaign", "winter-25");
  assert.equal(unknown.exit, 1);
  assert.equal(unknown.result.error.code, "link.campaign_unknown");
  assert.match(unknown.stderr, /marketing pull/u);

  const placement = await build(site, scripted, "--path", "/", "--source", "x", "--placement", "bio-link");
  assert.equal(placement.result.error.code, "link.placement_unknown");
});

test("link build asks the live site when the workspace has no marketing file, and refuses an archived key", async (t) => {
  const site = await workspace(t);
  const scripted = scriptedSite({ records: seededRecords() });

  const live = await build(site, scripted, "--path", "/", "--source", "x", "--campaign", "spring-26");
  assert.equal(live.exit, 0, live.stderr);
  assert.deepEqual(scripted.calls.map((call) => call.pathname.split(`${SITE_ID}/`)[1]), ["campaigns"]);

  const archived = await build(site, scripted, "--path", "/", "--source", "x", "--campaign", "winter-25");
  assert.equal(archived.result.error.code, "link.campaign_unknown");
  assert.match(archived.stderr, /no unarchived campaign/u);

  const missing = await build(site, scripted, "--path", "/", "--source", "x", "--campaign", "never-made");
  assert.equal(missing.result.error.code, "link.campaign_unknown");
});

test("link build asks the site about a campaign only the file holds, and refuses it until a push puts it there", async (t) => {
  const { site, scripted } = await pulledSite(t);
  const campaigns = await readJson(site, "marketing/campaigns.json");
  campaigns.campaigns.push({ key: "summer-26", name: "Summer sale" });
  await putJson(site, "marketing/campaigns.json", campaigns);

  const before = await build(site, scripted, "--path", "/", "--source", "x", "--campaign", "summer-26");
  assert.equal(before.result.error.code, "link.campaign_unknown");
  assert.match(before.stderr, /marketing push/u);

  await runWithSite(site, scripted, ["marketing", "push"]);
  const after = await build(site, scripted, "--path", "/", "--source", "x", "--campaign", "summer-26");
  assert.equal(after.exit, 0, after.stderr);
  assert.match(after.result.notes[0], /Summer sale is publishing/u);
});

test("a plain link build ignores a half-edited marketing file, and a Docs-presentation site is refused", async (t) => {
  const site = await workspace(t, { "marketing/campaigns.json": "{ not json" });
  const scripted = scriptedSite({ records: { campaigns: {}, placements: {} } });

  const plain = await build(site, scripted, "--path", "/", "--source", "x");
  assert.equal(plain.exit, 0, plain.stderr);
  const named = await build(site, scripted, "--path", "/", "--source", "x", "--campaign", "spring-26");
  assert.equal(named.exit, 1);

  await writeFile(
    path.join(site.project, "taproot-site.json"),
    `${JSON.stringify({ configVersion: 1, siteId: SITE_ID, workspaceDir: "site", authoringSurface: "docs-presentation" })}\n`,
  );
  const docs = await build(site, scripted, "--path", "/", "--source", "x");
  assert.equal(docs.result.error.code, "surface.presentation_only");
  assert.deepEqual(scripted.calls, []);
});

test("marketing pull writes no file when the second listing is refused", async (t) => {
  const site = await workspace(t, { ".taproot-site-manifest.json": MANIFEST });
  const scripted = scriptedSite({ records: seededRecords() });
  const refusing = async (url, init) =>
    new URL(url).pathname.endsWith("/link-labels")
      ? jsonResponse({ code: 9, message: "no" }, 400)
      : await scripted.fetchImpl(url, init);

  const { exit } = await runWithSite(site, { fetchImpl: refusing }, ["marketing", "pull"]);

  assert.equal(exit, 1);
  await assert.rejects(readText(site, "marketing/campaigns.json"));
  assert.equal((await readJson(site, ".taproot-site-manifest.json")).marketing, undefined);
});

test("link build reads only the marketing files of the kinds it names, and a note may hold a tab", async (t) => {
  const site = await workspace(t, {
    "marketing/placements.json": "{ not json",
    "marketing/campaigns.json": { campaigns: [{ key: "spring-26", name: "Spring", note: "a\tb" }] },
  });
  const scripted = scriptedSite({ records: seededRecords() });

  // No baseline, so the site answers; the malformed placements file is never read.
  const { exit, stderr } = await build(site, scripted, "--path", "/", "--source", "x", "--campaign", "spring-26");

  assert.equal(exit, 0, stderr);
});

test("marketing push settles a write whose answer was lost without a pull", async (t) => {
  const { site, scripted } = await pulledSite(t);
  const campaigns = await readJson(site, "marketing/campaigns.json");
  campaigns.campaigns.push({ key: "summer-26", name: "Summer sale" });
  campaigns.campaigns[0].name = "Spring launch 2026";
  await putJson(site, "marketing/campaigns.json", campaigns);

  // The site commits the create, then the connection drops before the CLI reads the answer.
  const dropped = {
    ...scripted,
    fetchImpl: async (url, init = {}) => {
      const answer = await scripted.fetchImpl(url, init);
      if (init.method === "POST" && new URL(url).pathname.endsWith("/campaigns")) throw new TypeError("fetch failed");
      return answer;
    },
  };
  const first = await runWithSite(site, dropped, ["marketing", "push"]);
  assert.equal(first.exit, 1);
  assert.equal(Object.values(scripted.state.records.campaigns).filter((record) => record.key === "summer-26").length, 1);

  // The next push finds the site already as the file asks: no second create, and the baseline catches up.
  scripted.calls.length = 0;
  const second = await runWithSite(site, scripted, ["marketing", "push"]);
  assert.equal(second.exit, 0, second.stderr);
  assert.deepEqual(writes(scripted), []);
  assert.deepEqual(second.result.marketing.campaigns.unchanged, ["spring-26", "summer-26"]);
  assert.ok((await readJson(site, ".taproot-site-manifest.json")).marketing.campaigns.items["summer-26"]);
});

test("marketing push resumes a restore whose label update landed but whose answer was lost", async (t) => {
  const { site, scripted } = await pulledSite(t);
  const campaigns = await readJson(site, "marketing/campaigns.json");
  campaigns.campaigns.push({ key: "winter-25", name: "Winter again" });
  await putJson(site, "marketing/campaigns.json", campaigns);

  // The update commits, the answer is lost, and the restore never runs.
  const dropped = {
    ...scripted,
    fetchImpl: async (url, init = {}) => {
      const answer = await scripted.fetchImpl(url, init);
      if (init.method === "PUT" && new URL(url).pathname.endsWith(`/campaigns/${OLD_CAMPAIGN_ID}`)) {
        throw new TypeError("fetch failed");
      }
      return answer;
    },
  };
  assert.equal((await runWithSite(site, dropped, ["marketing", "push"])).exit, 1);
  assert.equal(scripted.state.records.campaigns[OLD_CAMPAIGN_ID].name, "Winter again");
  assert.equal(scripted.state.records.campaigns[OLD_CAMPAIGN_ID].state, STATE.campaigns.archived);

  scripted.calls.length = 0;
  const resumed = await runWithSite(site, scripted, ["marketing", "push"]);
  assert.equal(resumed.exit, 0, resumed.stderr);
  assert.deepEqual(writtenPaths(scripted), [`POST campaigns/${OLD_CAMPAIGN_ID}/restore`]);
  assert.deepEqual(resumed.result.marketing.campaigns.restored, ["winter-25"]);
});

test("link build reports the state a push recorded, not the state a renamed key's file entry kept", async (t) => {
  const { site, scripted } = await pulledSite(t, seededRecords(), { maxActive: { campaigns: 2, placements: 200 } });
  const campaigns = await readJson(site, "marketing/campaigns.json");
  // The old key's entry keeps `state: live` when only its key is changed; the new key is created (publishing), and a
  // second create is refused by the quota, so the push stops before the file is rewritten.
  campaigns.campaigns[0].key = "spring-2026";
  campaigns.campaigns.push({ key: "autumn-26", name: "Autumn" });
  await putJson(site, "marketing/campaigns.json", campaigns);
  assert.equal((await runWithSite(site, scripted, ["marketing", "push"])).exit, 1);
  assert.equal((await readJson(site, "marketing/campaigns.json")).campaigns[0].state, "live");
  scripted.calls.length = 0;

  const { exit, result, stderr } = await build(site, scripted, "--path", "/", "--source", "x", "--campaign", "spring-2026");

  assert.equal(exit, 0, stderr);
  assert.match(result.notes[0], /Spring launch is publishing/u);
  assert.deepEqual(scripted.calls, []);
});

test("link build asks the site about a key whose baseline recorded no state", async (t) => {
  const { site, scripted } = await pulledSite(t);
  const manifest = await readJson(site, ".taproot-site-manifest.json");
  delete manifest.marketing.campaigns.items["spring-26"].state;
  await putJson(site, ".taproot-site-manifest.json", manifest);

  const { exit, stderr } = await build(site, scripted, "--path", "/", "--source", "x", "--campaign", "spring-26");

  assert.equal(exit, 0, stderr);
  assert.deepEqual(scripted.calls.map((call) => call.pathname.split(`${SITE_ID}/`)[1]), ["campaigns"]);
});

test("link build asks the site when the workspace has a marketing file but never pulled that kind", async (t) => {
  const site = await workspace(t, {
    ".taproot-site-manifest.json": MANIFEST,
    "marketing/campaigns.json": { campaigns: [{ key: "spring-26", name: "Spring launch", state: "live" }] },
  });
  const scripted = scriptedSite({ records: seededRecords() });

  const { exit, result, stderr } = await build(site, scripted, "--path", "/", "--source", "x", "--campaign", "spring-26");

  assert.equal(exit, 0, stderr);
  assert.equal(result.notes, undefined);
  assert.deepEqual(scripted.calls.map((call) => call.pathname.split(`${SITE_ID}/`)[1]), ["campaigns"]);
});

test("an unchanged push refreshes the recorded state, so link build follows a release that finished", async (t) => {
  const { site, scripted } = await pulledSite(t);
  // nl-footer was pulled as publishing; the site's release then finishes.
  scripted.state.records.placements[PLACEMENT_ID].state = STATE.placements.live;

  const pushed = await runWithSite(site, scripted, ["marketing", "push"]);
  assert.equal(pushed.exit, 0, pushed.stderr);
  assert.deepEqual(writes(scripted), []);
  assert.equal((await readJson(site, ".taproot-site-manifest.json")).marketing.placements.items["nl-footer"].state, "live");

  scripted.calls.length = 0;
  const built = await build(site, scripted, "--path", "/", "--source", "x", "--placement", "nl-footer");
  assert.equal(built.exit, 0, built.stderr);
  assert.equal(built.result.notes, undefined);
  assert.deepEqual(scripted.calls, []);
});

test("link build does not trust a recorded state it does not know", async (t) => {
  const { site, scripted } = await pulledSite(t);
  const manifest = await readJson(site, ".taproot-site-manifest.json");
  manifest.marketing.campaigns.items["spring-26"].state = "lve";
  await putJson(site, ".taproot-site-manifest.json", manifest);

  const { exit, stderr } = await build(site, scripted, "--path", "/", "--source", "x", "--campaign", "spring-26");

  assert.equal(exit, 0, stderr);
  assert.deepEqual(scripted.calls.map((call) => call.pathname.split(`${SITE_ID}/`)[1]), ["campaigns"]);
});

test("a note with Windows line breaks survives pull and an unchanged push", async (t) => {
  const records = seededRecords();
  records.campaigns[CAMPAIGN_ID].note = "First line\r\nSecond line";
  const { site, scripted } = await pulledSite(t, records);
  assert.equal((await readJson(site, "marketing/campaigns.json")).campaigns[0].note, "First line\r\nSecond line");

  const { exit, result, stderr } = await runWithSite(site, scripted, ["marketing", "push"]);

  assert.equal(exit, 0, stderr);
  assert.deepEqual(result.marketing.campaigns.unchanged, ["spring-26"]);
  assert.deepEqual(writes(scripted), []);
});

test("a name with a tab survives pull and an unchanged push, for both kinds", async (t) => {
  const records = seededRecords();
  records.campaigns[CAMPAIGN_ID].name = "Spring\tlaunch";
  records.placements[PLACEMENT_ID].name = "Footer\tlink";
  const { site, scripted } = await pulledSite(t, records);

  const { exit, result, stderr } = await runWithSite(site, scripted, ["marketing", "push"]);

  assert.equal(exit, 0, stderr);
  assert.deepEqual([result.marketing.campaigns.unchanged, result.marketing.placements.unchanged], [["spring-26"], ["nl-footer"]]);
  assert.deepEqual(writes(scripted), []);
});

test("results stay inside the output bound for a site with thousands of records", async (t) => {
  const records = { campaigns: {}, placements: {} };
  for (let index = 0; index < 2000; index += 1) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const key = `placement-${String(index).padStart(4, "0")}-aaaaaaaaaaaaaaaaaaaa`.slice(0, 32);
    records.placements[id] = wire("placements", { id, key, name: "Archived", state: index < 1800 ? "archived" : "live" });
  }
  const { site, scripted } = await pulledSite(t, records);

  // Pull already ran inside pulledSite without tripping serializeResult; a push with nothing in the file lists every
  // live record as left out, and must also fit.
  await putJson(site, "marketing/placements.json", { placements: [] });
  const pushed = await runWithSite(site, scripted, ["marketing", "push"]);

  assert.equal(pushed.exit, 0, pushed.stderr);
  assert.equal(pushed.result.marketing.placements.unlisted.length, 50);
  assert.equal(pushed.result.marketing.placements.counts.unlisted, 200);
  assert.deepEqual(pushed.result.marketing.placements.truncated, ["unlisted"]);
  const pulled = await runWithSite(site, scripted, ["marketing", "pull"]);
  assert.equal(pulled.exit, 0, pulled.stderr);
  assert.equal(pulled.result.marketing.placements.archivedTotal, 1800);
  assert.equal(pulled.result.marketing.placements.archivedTruncated, true);
  assert.equal(pulled.result.marketing.placements.archived.length, 200);
});

test("a pulled value the site keeps validates: a typo year, a U+FEFF edge, and the .NET whitespace set", () => {
  const record = { key: "spring-26", name: "Spring", starts_on: "0026-05-01" };
  assert.deepEqual(validateMarketingDocument("campaigns", { campaigns: [record] }), [record]);
  assert.throws(() => validateMarketingDocument("campaigns", { campaigns: [{ ...record, starts_on: "0026-02-30" }] }), /YYYY-MM-DD/u);
  // U+FEFF is not whitespace to .NET's Trim(), so the site stores it and a pull writes it back.
  assert.doesNotThrow(() => validateMarketingDocument("campaigns", { campaigns: [{ ...record, name: "﻿Spring" }] }));
  // U+0085 and U+3000 are, so the site would have trimmed them and the file may not carry them.
  for (const edge of ["\u0085", "　", " "]) {
    assert.throws(() => validateMarketingDocument("campaigns", { campaigns: [{ ...record, name: `Spring${edge}` }] }), /no space/u);
  }
});

test("link build prints a name from the site only after sanitizing it", async (t) => {
  const records = seededRecords();
  records.campaigns[CAMPAIGN_ID].name = "Spring \u001b[31mlaunch";
  records.campaigns[CAMPAIGN_ID].state = STATE.campaigns.publishing;
  const site = await workspace(t);
  const scripted = scriptedSite({ records });

  const { exit, result, stderr } = await build(site, scripted, "--path", "/", "--source", "x", "--campaign", "spring-26");

  assert.equal(exit, 0, stderr);
  assert.ok(!result.notes[0].includes("\u001b"));
  assert.ok(!stderr.includes("\u001b"));
});

test("year 0000 is refused before any write, while years 0001 to 0099 stay valid", async (t) => {
  const record = { key: "spring-26", name: "Spring" };
  assert.throws(() => validateMarketingDocument("campaigns", { campaigns: [{ ...record, starts_on: "0000-05-01" }] }), /YYYY-MM-DD/u);
  assert.doesNotThrow(() => validateMarketingDocument("campaigns", { campaigns: [{ ...record, starts_on: "0001-01-01", ends_on: "0099-12-31" }] }));

  const { site, scripted } = await pulledSite(t);
  await putJson(site, "marketing/campaigns.json", { campaigns: [{ key: "summer-26", name: "Summer", ends_on: "0000-05-01" }] });
  scripted.calls.length = 0;
  const { exit, result } = await runWithSite(site, scripted, ["marketing", "push", "--archive"]);
  assert.equal(exit, 1);
  assert.equal(result.error.code, "marketing.file_invalid");
  assert.deepEqual(scripted.calls, []);
});

test("link build takes a key that starts with hyphens only as --option=value", async (t) => {
  const records = seededRecords();
  records.campaigns["eeee5555-ffff-4555-8555-aaaa55555555"] = wire("campaigns", {
    id: "eeee5555-ffff-4555-8555-aaaa55555555", key: "--launch", name: "Launch", state: "live",
  });
  const site = await workspace(t);
  const scripted = scriptedSite({ records });

  const separated = await build(site, scripted, "--path", "/", "--source", "x", "--campaign", "--launch");
  assert.equal(separated.exit, 2);
  assert.equal(separated.result.error.code, "cli.option_value");

  const inline = await build(site, scripted, "--path=/", "--source=x", "--campaign=--launch");
  assert.equal(inline.exit, 0, inline.stderr);
  assert.equal(inline.result.link.campaign, "--launch");
  assert.equal(inline.result.link.address, "https://example.com/?utm_source=x&utm_medium=social&utm_campaign=--launch");

  assert.equal((await build(site, scripted, "--path=/", "--source=x", "--campaign=")).exit, 2);
  assert.equal((await build(site, scripted, "--path=/", "--path=/a", "--source=x")).exit, 2);

  // An empty --path= is the home page, an '=' inside a value belongs to the value, and a bad inline value is
  // named as bad rather than as missing.
  assert.equal((await build(site, scripted, "--path=", "--source=x")).result.link.path, "/");
  assert.equal((await build(site, scripted, "--path=/a?b=c", "--source=x")).result.link.address,
    "https://example.com/a?b=c&utm_source=x&utm_medium=social");
  const tab = await build(site, scripted, "--path=/a\tb", "--source=x");
  assert.equal(tab.exit, 2);
  assert.match(tab.stderr, /no control characters/u);
  const oversize = await build(site, scripted, `--path=/${"a".repeat(5000)}`, "--source=x");
  assert.equal(oversize.exit, 2);
  assert.equal(oversize.result.error.code, "cli.option_value");
});
