import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { validateComponentBlock } from "../src/content/components.js";
import { DATE_ANCHORS } from "../src/field-validation.js";
import {
  FORM_DATE_WINDOW_FIELD,
  FORM_NEXT_MONTH_FIELD,
  getComponentReference,
  getWorkflowReference,
} from "../src/reference-help.js";
import { shippedFixtureDirectory } from "../src/fixture-contract.js";
import { formFileName, projectFormForWorkspace, storedDefinition, validateFormDocument } from "../src/forms-contract.js";

const SITE_ID = "aaaa1111-bbbb-4111-8111-cccc11111111";
const API_BASE_URL = "https://app.taproot.test/api";

const CONTACT_FORM = Object.freeze({
  key: "contact",
  name: "Contact",
  sink: "none",
  retention_days: 365,
  definition: {
    fields: [
      { id: "name", type: "text", label: "Your name", required: true, max_length: 120 },
      { id: "email", type: "email", label: "Email", required: true },
      { id: "message", type: "long_text", label: "Message", required: true, max_length: 2000 },
      { id: "agree", type: "consent", label: "I agree that you may store this message and reply to me." },
    ],
  },
});

async function workspace(testContext, files = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "taproot-site-forms-"));
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

async function run(site, arguments_) {
  let stdout = "";
  let stderr = "";
  const exit = await runCli({
    arguments_,
    cwd: site.project,
    environment: { XDG_CONFIG_HOME: site.configHome, HOME: site.configHome },
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
  });
  return { exit, result: JSON.parse(stdout), stderr };
}

test("forms validate accepts a well-formed form file and reports it", async (t) => {
  const site = await workspace(t, { [formFileName("contact")]: CONTACT_FORM });
  const { exit, result } = await run(site, ["forms", "validate"]);
  assert.equal(exit, 0);
  assert.equal(result.ok, true);
  assert.deepEqual(result.forms, {
    count: 1,
    items: [{ key: "contact", file: "forms/contact.json", fields: 4, sink: "none" }],
  });
});

test("forms validate with no forms directory reports zero forms", async (t) => {
  const site = await workspace(t);
  const { exit, result } = await run(site, ["forms", "validate"]);
  assert.equal(exit, 0);
  assert.equal(result.forms.count, 0);
});

test("forms validate narrows to named keys and refuses a name with no file", async (t) => {
  const site = await workspace(t, { [formFileName("contact")]: CONTACT_FORM });
  const missing = await run(site, ["forms", "validate", "waitlist"]);
  assert.equal(missing.exit, 1);
  assert.equal(missing.result.error.code, "forms.file_missing");
  const named = await run(site, ["forms", "validate", "contact"]);
  assert.equal(named.exit, 0);
});

test("forms validate refuses a definition the shared validator rejects, naming the path and code", async (t) => {
  const broken = structuredClone(CONTACT_FORM);
  broken.definition.fields[1].max_length = 0;
  broken.definition.fields.push({ id: "name", type: "text", label: "Again" });
  const site = await workspace(t, { [formFileName("contact")]: broken });
  const { exit, result, stderr } = await run(site, ["forms", "validate"]);
  assert.equal(exit, 1);
  assert.equal(result.error.code, "forms.file_invalid");
  assert.match(stderr, /duplicate_id/u);
});

test("forms validate refuses a key that does not match the file name and unknown properties", async (t) => {
  const renamed = await workspace(t, { [formFileName("contact")]: { ...CONTACT_FORM, key: "other" } });
  const mismatch = await run(renamed, ["forms", "validate"]);
  assert.equal(mismatch.result.error.code, "forms.file_invalid");
  assert.match(mismatch.stderr, /key must be 'contact'/u);
  const extra = await workspace(t, { [formFileName("contact")]: { ...CONTACT_FORM, status: "archived" } });
  const unknown = await run(extra, ["forms", "validate"]);
  assert.match(unknown.stderr, /'status' is not a form property/u);
});

test("forms validate bounds retention and the labels, and refuses the retired consent_text key", async (t) => {
  assert.throws(
    () => validateFormDocument({ ...CONTACT_FORM, consent_text: "I agree." }, "contact"),
    /'consent_text' is not a form property/u,
  );
  // A consent field's label is the agreement, so it may run to 1000 characters; every other label stops at 200.
  const withConsentLabel = (length) => {
    const form = structuredClone(CONTACT_FORM);
    form.definition.fields[3].label = "a".repeat(length);
    return form;
  };
  assert.doesNotThrow(() => validateFormDocument(withConsentLabel(1000), "contact"));
  assert.throws(() => validateFormDocument(withConsentLabel(1001), "contact"), /invalid_label/u);
  const longTextLabel = structuredClone(CONTACT_FORM);
  longTextLabel.definition.fields[0].label = "a".repeat(201);
  assert.throws(() => validateFormDocument(longTextLabel, "contact"), /invalid_label/u);
  assert.throws(() => validateFormDocument({ ...CONTACT_FORM, retention_days: 10 }, "contact"), /retention_days/u);
  assert.throws(() => validateFormDocument({ ...CONTACT_FORM, sink: "webhook" }, "contact"), /sink/u);
  // The site refuses a name it would trim.
  assert.throws(() => validateFormDocument({ ...CONTACT_FORM, name: " Contact" }, "contact"), /no space at either end/u);
  // What the site cannot store, or would refuse as too large, is refused before any request.
  assert.throws(() => validateFormDocument({ ...CONTACT_FORM, name: "Con\u0000tact" }, "contact"), /NUL/u);
  const loneSurrogate = structuredClone(CONTACT_FORM);
  loneSurrogate.definition.fields[0].label = "Bad \uD800 label";
  assert.throws(() => validateFormDocument(loneSurrogate, "contact"), /unpaired surrogate/u);
  const hinted = structuredClone(CONTACT_FORM);
  hinted.definition.fields[0].hint = "We reply within two days.";
  assert.doesNotThrow(() => validateFormDocument(hinted, "contact"));
  hinted.definition.fields[0].hint = "   ";
  assert.throws(() => validateFormDocument(hinted, "contact"), /invalid_hint/u);
  hinted.definition.fields[0].hint = "x".repeat(201);
  assert.throws(() => validateFormDocument(hinted, "contact"), /invalid_hint/u);
  const oversized = structuredClone(CONTACT_FORM);
  oversized.definition.fields = Array.from({ length: 30 }, (_, index) => ({
    id: `choice_${index}`,
    type: "multi_choice",
    label: "x".repeat(200),
    choices: Array.from({ length: 50 }, (__, choice) => `${"c".repeat(95)}${String(choice).padStart(5, "0")}`),
  }));
  assert.throws(() => validateFormDocument(oversized, "contact"), /larger than 65536 bytes/u);
});

test("forms validate refuses a file that is not named for a form key", async (t) => {
  const site = await workspace(t, { "forms/Contact Us.json": CONTACT_FORM });
  const { exit, result } = await run(site, ["forms", "validate"]);
  assert.equal(exit, 1);
  assert.ok(["forms.file_invalid", "workspace.name_unsupported"].includes(result.error.code));
});

test("the workspace projection is canonical and stable when applied twice", () => {
  const shuffled = {
    definition: {
      contact_field: "email",
      fields: [
        { max_length: 50, label: "Email", type: "email", id: "email", required: true },
        { label: "Backup", type: "email", id: "backup" },
        { choices: ["a", "b"], label: "Pick", id: "pick", type: "single_choice" },
      ],
    },
    name: "Contact",
    key: "contact",
  };
  const once = projectFormForWorkspace(shuffled);
  assert.deepEqual(Object.keys(once), ["key", "name", "sink", "retention_days", "definition"]);
  assert.equal(once.definition.contact_field, "email");
  assert.deepEqual(Object.keys(once.definition.fields[0]), ["id", "type", "label", "required", "max_length"]);
  assert.equal(JSON.stringify(projectFormForWorkspace(once)), JSON.stringify(once));
  const hinted = projectFormForWorkspace({
    ...shuffled,
    definition: { fields: [{ required: true, hint: "Tip", label: "Email", type: "email", id: "email" }] },
  });
  assert.deepEqual(Object.keys(hinted.definition.fields[0]), ["id", "type", "label", "hint", "required"]);
  assert.equal(once.retention_days, 365);
});

test("the contact field is written only when several email fields need the choice", () => {
  const email = { id: "email", type: "email", label: "Email" };
  const explicit = { ...CONTACT_FORM, definition: { fields: [email], contact_field: "email" } };
  assert.doesNotThrow(() => validateFormDocument(explicit, "contact"));
  assert.equal("contact_field" in projectFormForWorkspace(explicit).definition, false);
  assert.equal(
    JSON.stringify(projectFormForWorkspace(explicit)),
    JSON.stringify(projectFormForWorkspace({ ...explicit, definition: { fields: [email] } })),
  );

  const backup = { id: "backup", type: "email", label: "Backup" };
  const unchosen = { ...CONTACT_FORM, definition: { fields: [email, backup] } };
  assert.throws(() => validateFormDocument(unchosen, "contact"), /contact_field: contact_field_required/u);
  const chosen = { ...unchosen, definition: { fields: [email, backup], contact_field: "backup" } };
  assert.doesNotThrow(() => validateFormDocument(chosen, "contact"));
  assert.equal(projectFormForWorkspace(chosen).definition.contact_field, "backup");

  const noEmail = { ...CONTACT_FORM, definition: { fields: [{ id: "n", type: "text", label: "N" }], contact_field: "n" } };
  assert.throws(() => validateFormDocument(noEmail, "contact"), /invalid_contact_field/u);
});

// ---------------------------------------------------------------------------
// forms pull / forms push against a scripted site
// ---------------------------------------------------------------------------

const FORM_ID = "bbbb2222-cccc-4222-8222-dddd22222222";
const KEY = "tr_live_site_key_for_forms_tests";
const WAITLIST_ID = "cccc3333-dddd-4333-8333-eeee33333333";
const MANIFEST = { manifestVersion: 7, siteId: SITE_ID, pages: [] };

function jsonResponse(value, httpStatus = 200) {
  return new Response(JSON.stringify(value), { status: httpStatus, headers: { "content-type": "application/json" } });
}

function wireForm(form, { version = 1, id = FORM_ID, status = "SITE_FORM_STATUS_ACTIVE" } = {}) {
  return {
    form: {
      id,
      siteId: SITE_ID,
      key: form.key,
      name: form.name,
      sink: form.sink === "newsletter" ? "SITE_FORM_SINK_NEWSLETTER" : "SITE_FORM_SINK_NONE",
      retentionDays: form.retention_days,
      status,
      currentVersion: version,
    },
    currentVersion: {
      formId: id,
      version,
      definition: JSON.stringify(form.definition),
    },
  };
}

/** A scripted site: `state.forms` maps key to its wire response; calls are recorded. */
function scriptedSite(state) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, pathname: target.pathname, body });
    const base = `/api/v1/sites/${SITE_ID}`;
    if (method === "GET" && target.pathname === `/api/v1/pages/by_site/${SITE_ID}`) {
      return jsonResponse({
        pages: (state.pages ?? []).map((page) => ({
          pageId: `${page.resourceId.slice(0, 24)}000000000000`,
          status: "PAGE_STATUS_PUBLISHED",
          title: page.path,
          ...page,
        })),
      });
    }
    if (method === "GET" && target.pathname === `${base}/forms`) {
      return jsonResponse({ forms: Object.values(state.forms).map((entry) => entry.form) });
    }
    const byKey = target.pathname.match(new RegExp(`^${base}/form-keys/([^/]+)$`, "u"));
    if (method === "GET" && byKey) {
      const entry = state.forms[byKey[1]];
      return entry ? jsonResponse(entry) : jsonResponse({ code: 5, message: "not found" }, 404);
    }
    const byId = target.pathname.match(new RegExp(`^${base}/forms/([^/]+)$`, "u"));
    if (method === "GET" && byId) {
      const entry = Object.values(state.forms).find((candidate) => candidate.form.id === byId[1]);
      return entry ? jsonResponse(entry) : jsonResponse({ code: 5, message: "not found" }, 404);
    }
    if (method === "POST" && target.pathname === `${base}/forms`) {
      const created = wireForm({
        key: body.key,
        name: body.name,
        sink: body.sink === "SITE_FORM_SINK_NEWSLETTER" ? "newsletter" : "none",
        // The site picks its plan's default when the request names none.
        retention_days: body.retentionDays ?? state.defaultRetention ?? 365,
        definition: JSON.parse(body.definition),
      });
      state.forms[body.key] = created;
      return jsonResponse(created);
    }
    const settings = target.pathname.match(new RegExp(`^${base}/forms/([^/]+)/settings$`, "u"));
    if (method === "PUT" && settings) {
      const entry = Object.values(state.forms).find((candidate) => candidate.form.id === settings[1]);
      // The site checks the caller's recorded settings under its own lock.
      if (
        (body.expectedName !== undefined && body.expectedName !== entry.form.name)
        || (body.expectedRetentionDays !== undefined && body.expectedRetentionDays !== entry.form.retentionDays)
      ) {
        return jsonResponse(
          { code: 3, message: "invalid", details: [{ fieldViolations: [{ field: "ExpectedSettings", description: "changed" }] }] },
          400,
        );
      }
      Object.assign(entry.form, { name: body.name, sink: body.sink, retentionDays: body.retentionDays });
      return jsonResponse(entry.form);
    }
    const versions = target.pathname.match(new RegExp(`^${base}/forms/([^/]+)/versions$`, "u"));
    if (method === "POST" && versions) {
      const entry = Object.values(state.forms).find((candidate) => candidate.form.id === versions[1]);
      if (body.expectedVersion !== undefined && body.expectedVersion !== entry.form.currentVersion) {
        return jsonResponse(
          { code: 3, message: "invalid", details: [{ fieldViolations: [{ field: "ExpectedVersion", description: "changed" }] }] },
          400,
        );
      }
      entry.form.currentVersion += 1;
      entry.currentVersion = {
        formId: entry.form.id,
        version: entry.form.currentVersion,
        definition: body.definition,
      };
      return jsonResponse(entry.currentVersion);
    }
    return jsonResponse({ code: 12, message: "unscripted" }, 501);
  };
  return { calls, fetchImpl };
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

async function readText(site, relative) {
  return await readFile(path.join(site.workspaceDir, ...relative.split("/")), "utf8");
}

test("forms pull writes canonical files, records versions, and reports archived forms without writing them", async (t) => {
  const site = await workspace(t, { ".taproot-site-manifest.json": MANIFEST });
  const scripted = scriptedSite({
    forms: {
      contact: wireForm(CONTACT_FORM, { version: 3 }),
      old: wireForm({ ...CONTACT_FORM, key: "old", name: "Old" }, {
        id: WAITLIST_ID,
        status: "SITE_FORM_STATUS_ARCHIVED",
      }),
    },
  });
  const { exit, result } = await runWithSite(site, scripted, ["forms", "pull"]);
  assert.equal(exit, 0);
  assert.deepEqual(result.forms, {
    total: 1,
    items: [{ key: "contact", file: "forms/contact.json" }],
    archived: ["old"],
  });
  assert.equal(await readText(site, "forms/contact.json"), `${JSON.stringify(CONTACT_FORM, undefined, 2)}\n`);
  const manifest = JSON.parse(await readText(site, ".taproot-site-manifest.json"));
  assert.deepEqual(manifest.forms, {
    items: { contact: { id: FORM_ID, version: 3, settings: { name: "Contact", sink: "none", retention_days: 365 } } },
  });
  assert.deepEqual(writes(scripted), []);
});

test("forms push after pull is unchanged and leaves the file bytes alone", async (t) => {
  const site = await workspace(t, { ".taproot-site-manifest.json": MANIFEST });
  const scripted = scriptedSite({ forms: { contact: wireForm(CONTACT_FORM, { version: 2 }) } });
  await runWithSite(site, scripted, ["forms", "pull"]);
  const before = await readText(site, "forms/contact.json");
  const { exit, result } = await runWithSite(site, scripted, ["forms", "push"]);
  assert.equal(exit, 0);
  assert.deepEqual(result.forms.items, [{ key: "contact", action: "unchanged", version: 2 }]);
  assert.equal(result.written.count, 0);
  assert.equal(result.nextStep, undefined);
  assert.equal(await readText(site, "forms/contact.json"), before);
  assert.deepEqual(writes(scripted), []);
});

test("forms push creates a new form, rewrites the file canonically and records the baseline", async (t) => {
  const shuffled = {
    definition: CONTACT_FORM.definition,
    name: "Contact",
    key: "contact",
  };
  const site = await workspace(t, { ".taproot-site-manifest.json": MANIFEST, "forms/contact.json": shuffled });
  const scripted = scriptedSite({ forms: {} });
  const { exit, result } = await runWithSite(site, scripted, ["forms", "push"]);
  assert.equal(exit, 0);
  assert.deepEqual(result.forms.items, [{ key: "contact", action: "create", version: 1 }]);
  assert.equal(result.nextStep, "deploy --staging");
  const [create] = writes(scripted);
  assert.equal(create.method, "POST");
  assert.equal(create.body.key, "contact");
  assert.equal(create.body.sink, "SITE_FORM_SINK_NONE");
  // The file named no retention, so the request names none: the site chooses.
  assert.equal(create.body.retentionDays, undefined);
  assert.deepEqual(JSON.parse(create.body.definition), CONTACT_FORM.definition);
  assert.equal(await readText(site, "forms/contact.json"), `${JSON.stringify(CONTACT_FORM, undefined, 2)}\n`);
  const manifest = JSON.parse(await readText(site, ".taproot-site-manifest.json"));
  assert.deepEqual(manifest.forms, {
    items: { contact: { id: FORM_ID, version: 1, settings: { name: "Contact", sink: "none", retention_days: 365 } } },
  });
});

test("forms push updates settings and appends a version only for what changed", async (t) => {
  const site = await workspace(t, { ".taproot-site-manifest.json": MANIFEST });
  const scripted = scriptedSite({ forms: { contact: wireForm(CONTACT_FORM, { version: 1 }) } });
  await runWithSite(site, scripted, ["forms", "pull"]);
  const edited = JSON.parse(await readText(site, "forms/contact.json"));
  edited.name = "Contact us";
  edited.definition.fields.push({ id: "phone", type: "tel", label: "Phone" });
  await writeFile(path.join(site.workspaceDir, "forms", "contact.json"), `${JSON.stringify(edited, undefined, 2)}\n`);
  const { exit, result } = await runWithSite(site, scripted, ["forms", "push", "contact"]);
  assert.equal(exit, 0);
  assert.deepEqual(result.forms.items, [{ key: "contact", action: "update", version: 2 }]);
  const [settings, version] = writes(scripted);
  assert.equal(settings.method, "PUT");
  assert.equal(settings.body.name, "Contact us");
  assert.equal(version.method, "POST");
  assert.equal(JSON.parse(version.body.definition).fields.length, 5);
  const manifest = JSON.parse(await readText(site, ".taproot-site-manifest.json"));
  assert.deepEqual(manifest.forms.items.contact, {
    id: FORM_ID,
    version: 2,
    settings: { name: "Contact us", sink: "none", retention_days: 365 },
  });

  // A settings-only edit appends no version.
  edited.name = "Contact";
  await writeFile(path.join(site.workspaceDir, "forms", "contact.json"), `${JSON.stringify(edited, undefined, 2)}\n`);
  const before = writes(scripted).length;
  const renamed = await runWithSite(site, scripted, ["forms", "push"]);
  assert.equal(renamed.exit, 0);
  assert.deepEqual(writes(scripted).slice(before).map((call) => call.method), ["PUT"]);
});

test("forms push refuses a form that changed on the site, before writing any form", async (t) => {
  const other = { ...CONTACT_FORM, key: "waitlist", name: "Waitlist" };
  const site = await workspace(t, { ".taproot-site-manifest.json": MANIFEST });
  const state = {
    forms: {
      contact: wireForm(CONTACT_FORM, { version: 1 }),
      waitlist: wireForm(other, { version: 1, id: WAITLIST_ID }),
    },
  };
  const scripted = scriptedSite(state);
  await runWithSite(site, scripted, ["forms", "pull"]);
  for (const form of [CONTACT_FORM, other]) {
    await writeFile(
      path.join(site.workspaceDir, "forms", `${form.key}.json`),
      `${JSON.stringify({ ...form, name: `${form.name} edited` }, undefined, 2)}\n`,
    );
  }
  // Someone edits the waitlist form in the browser after the pull.
  state.forms.waitlist = wireForm(other, { version: 2, id: WAITLIST_ID });
  scripted.calls.length = 0;
  const refusal = await runWithSite(site, scripted, ["forms", "push"]);
  assert.equal(refusal.exit, 1);
  assert.equal(refusal.result.error.code, "forms.concurrent_modification");
  assert.match(refusal.stderr, /Run 'forms pull'/u);
  assert.deepEqual(writes(scripted), []);
});

test("forms push refuses a form the workspace never pulled and an archived form", async (t) => {
  const site = await workspace(t, { ".taproot-site-manifest.json": MANIFEST, "forms/contact.json": CONTACT_FORM });
  const unknown = scriptedSite({ forms: { contact: wireForm(CONTACT_FORM) } });
  const never = await runWithSite(site, unknown, ["forms", "push"]);
  assert.equal(never.result.error.code, "forms.pull_required");
  const archived = scriptedSite({ forms: { contact: wireForm(CONTACT_FORM, { status: "SITE_FORM_STATUS_ARCHIVED" }) } });
  const refused = await runWithSite(site, archived, ["forms", "push"]);
  assert.equal(refused.result.error.code, "forms.archived");
  assert.deepEqual(writes(unknown).concat(writes(archived)), []);
});

test("forms push needs a pulled workspace and validates before any request", async (t) => {
  const site = await workspace(t, { "forms/contact.json": { ...CONTACT_FORM, name: "" } });
  const scripted = scriptedSite({ forms: {} });
  const invalid = await runWithSite(site, scripted, ["forms", "push"]);
  assert.equal(invalid.result.error.code, "forms.file_invalid");
  assert.equal(scripted.calls.length, 0);
  const clean = await workspace(t, { "forms/contact.json": CONTACT_FORM });
  const unpulled = await runWithSite(clean, scripted, ["forms", "push"]);
  assert.equal(unpulled.result.error.code, "workspace.manifest_missing");
});

// ---------------------------------------------------------------------------
// The offline fixture contract
// ---------------------------------------------------------------------------

async function fixtureWithForms(t, { bind = true, files = { "forms/contact.json": CONTACT_FORM } } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "taproot-site-forms-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = path.join(root, "fixture");
  await cp(shippedFixtureDirectory(), fixture, { recursive: true });
  for (const [relative, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(fixture, relative)), { recursive: true });
    await writeFile(path.join(fixture, relative), `${JSON.stringify(contents, undefined, 2)}\n`);
  }
  if (bind) {
    const manifestPath = path.join(fixture, "manifest.fixture.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.forms = { items: { contact: { id: FORM_ID, version: 1 } } };
    await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
  }
  return { root, fixture };
}

async function validateFixtureDirectory(root, fixture) {
  let stdout = "";
  const exit = await runCli({
    arguments_: ["validate", fixture, "--quiet"],
    cwd: root,
    environment: {},
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: () => {} },
    fetch: () => assert.fail("fixture validation is offline"),
  });
  return { exit, result: JSON.parse(stdout) };
}

test("a fixture that binds form files validates them and reports the count", async (t) => {
  const { root, fixture } = await fixtureWithForms(t);
  const { exit, result } = await validateFixtureDirectory(root, fixture);
  assert.equal(exit, 0, JSON.stringify(result));
  assert.deepEqual(result.validated.forms, { count: 1 });
});

test("a fixture refuses an invalid form file, an unbound form file, and a binding with no file", async (t) => {
  const invalid = await fixtureWithForms(t, {
    files: { "forms/contact.json": { ...CONTACT_FORM, definition: { fields: [] } } },
  });
  assert.equal((await validateFixtureDirectory(invalid.root, invalid.fixture)).result.error.code, "forms.file_invalid");
  const unbound = await fixtureWithForms(t, { bind: false });
  assert.equal((await validateFixtureDirectory(unbound.root, unbound.fixture)).result.error.code, "fixture.forms_unbound");
  const missing = await fixtureWithForms(t, { files: {} });
  assert.equal((await validateFixtureDirectory(missing.root, missing.fixture)).result.error.code, "fixture.forms_mismatch");
});

test("a fixture without forms still validates and reports none", async (t) => {
  const { root, fixture } = await fixtureWithForms(t, { bind: false, files: {} });
  const { exit, result } = await validateFixtureDirectory(root, fixture);
  assert.equal(exit, 0);
  assert.equal(result.validated.forms, undefined);
});

test("help forms names the capability that carries form authoring and the one nothing carries", async () => {
  let stdout = "";
  const exit = await runCli({
    arguments_: ["help", "forms", "--json"],
    environment: {},
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: () => {} },
  });
  assert.equal(exit, 0);
  const details = JSON.parse(stdout).reference.details.join("\n");
  assert.match(details, /delegation\.content capability carries site\.forms\.manage/u);
  assert.match(details, /submissions are in no capability/iu);
  assert.match(details, /site\.forms\.submissions\.manage/u);
  assert.match(details, /hint\?, \.\.\.constraints \}/u);
  assert.match(details, /not marked 'Required'/u);
});

test("forms push refuses when only the site's name, sink or retention changed since the pull", async (t) => {
  const site = await workspace(t, { ".taproot-site-manifest.json": MANIFEST });
  const state = { forms: { contact: wireForm(CONTACT_FORM, { version: 1 }) } };
  const scripted = scriptedSite(state);
  await runWithSite(site, scripted, ["forms", "pull"]);
  const edited = JSON.parse(await readText(site, "forms/contact.json"));
  edited.definition.fields.push({ id: "phone", type: "tel", label: "Phone" });
  await writeFile(path.join(site.workspaceDir, "forms", "contact.json"), `${JSON.stringify(edited, undefined, 2)}\n`);
  // Renamed in the browser: no new version, so only the settings fence can see it.
  state.forms.contact.form.name = "Contact (renamed on the site)";
  scripted.calls.length = 0;

  const refusal = await runWithSite(site, scripted, ["forms", "push"]);

  assert.equal(refusal.result.error.code, "forms.concurrent_modification");
  assert.deepEqual(writes(scripted), []);
});

test("forms push records applied settings at once when the version save then fails", async (t) => {
  const site = await workspace(t, { ".taproot-site-manifest.json": MANIFEST });
  const state = { forms: { contact: wireForm(CONTACT_FORM, { version: 1 }) } };
  const scripted = scriptedSite(state);
  await runWithSite(site, scripted, ["forms", "pull"]);
  const edited = JSON.parse(await readText(site, "forms/contact.json"));
  edited.name = "Contact us";
  edited.definition.fields.push({ id: "phone", type: "tel", label: "Phone" });
  await writeFile(path.join(site.workspaceDir, "forms", "contact.json"), `${JSON.stringify(edited, undefined, 2)}\n`);
  const original = scripted.fetchImpl;
  const failing = {
    calls: scripted.calls,
    fetchImpl: async (url, init = {}) =>
      (init.method === "POST" && String(url).endsWith("/versions")) ? jsonResponse({ code: 13, message: "boom" }, 500) : original(url, init),
  };

  const failed = await runWithSite(site, failing, ["forms", "push"]);

  assert.equal(failed.exit, 1);
  assert.deepEqual(failed.result.error.completedWrites, ["contact"]);
  // The settings write stands, so a retry is not read as someone else's edit.
  const retry = await runWithSite(site, scripted, ["forms", "push"]);
  assert.equal(retry.exit, 0, retry.stderr);
  assert.deepEqual(retry.result.forms.items, [{ key: "contact", action: "update", version: 2 }]);
});

// ---------------------------------------------------------------------------
// The button text and what happens after a response is sent
// ---------------------------------------------------------------------------

const THANKS_ID = "dddd4444-eeee-4444-8444-ffff44444444";
const withSettings = (settings) => ({ ...CONTACT_FORM, definition: { ...CONTACT_FORM.definition, ...settings } });
const THANKS_FORM = withSettings({ submit_label: "Send message", after_submit: { show: "page", page_path: "/thanks" } });

test("forms validate accepts the button text and either after_submit choice, and refuses the rest by code", () => {
  assert.doesNotThrow(() => validateFormDocument(THANKS_FORM, "contact"));
  assert.doesNotThrow(() => validateFormDocument(withSettings({ after_submit: { show: "message" } }), "contact"));
  assert.doesNotThrow(() =>
    validateFormDocument(withSettings({ after_submit: { show: "message", message: "Thanks.\nWe will reply." } }), "contact")
  );
  assert.doesNotThrow(() =>
    validateFormDocument(withSettings({ after_submit: { show: "page", page_resource_id: THANKS_ID } }), "contact")
  );
  assert.doesNotThrow(() =>
    validateFormDocument(withSettings({ after_submit: { show: "page", page_path: "/" } }), "contact")
  );
  const refused = (settings, pattern) =>
    assert.throws(() => validateFormDocument(withSettings(settings), "contact"), pattern);
  refused({ submit_label: "x".repeat(41) }, /submit_label: invalid_submit_label/u);
  refused({ submit_label: "" }, /submit_label: invalid_submit_label/u);
  refused({ after_submit: { show: "popup" } }, /after_submit: invalid_after_submit/u);
  refused({ after_submit: { show: "message", message: "x".repeat(501) } }, /invalid_after_submit_message/u);
  refused({ after_submit: { show: "page" } }, /invalid_after_submit_page/u);
  refused({ after_submit: { show: "page", page_resource_id: "nope" } }, /invalid_after_submit_page/u);
  refused({ after_submit: { show: "message", page_path: "/thanks" } }, /after_submit.page_path: unknown_property/u);
  refused({ after_submit: { show: "page", page_path: "/thanks", message: "Hi" } }, /after_submit.message: unknown_property/u);
  refused(
    { after_submit: { show: "page", page_path: "/thanks", page_resource_id: THANKS_ID } },
    /names its page twice/u,
  );
  for (const bad of ["thanks", "/thanks/", "//evil.example", "/a b", "/a?b=1", "/a#b", "https://evil.example/", "/a\\b", ""]) {
    refused({ after_submit: { show: "page", page_path: bad } }, /page_path must be a site path/u);
  }
});

test("the projection writes the settings in one order and spells a known page by its path", () => {
  const pathById = new Map([[THANKS_ID, "/about/thanks"]]);
  const shuffled = {
    ...CONTACT_FORM,
    definition: {
      after_submit: { page_resource_id: THANKS_ID, show: "page" },
      submit_label: "Send message",
      fields: CONTACT_FORM.definition.fields,
    },
  };
  const once = projectFormForWorkspace(shuffled, pathById);
  assert.deepEqual(Object.keys(once.definition), ["fields", "submit_label", "after_submit"]);
  assert.deepEqual(once.definition.after_submit, { show: "page", page_path: "/about/thanks" });
  assert.equal(JSON.stringify(projectFormForWorkspace(once, pathById)), JSON.stringify(once));
  // A page that is gone keeps its id, which is all the site can say about it.
  assert.deepEqual(projectFormForWorkspace(shuffled, new Map()).definition.after_submit, {
    show: "page",
    page_resource_id: THANKS_ID,
  });
  const message = projectFormForWorkspace(withSettings({ after_submit: { message: "Hi", show: "message" } }), pathById);
  assert.deepEqual(Object.keys(message.definition.after_submit), ["show", "message"]);
});

test("forms pull writes a page the form goes to by its path, and push after pull changes nothing", async (t) => {
  const site = await workspace(t, { ".taproot-site-manifest.json": MANIFEST });
  const stored = withSettings({ submit_label: "Send message", after_submit: { show: "page", page_resource_id: THANKS_ID } });
  const scripted = scriptedSite({
    forms: { contact: wireForm(stored, { version: 2 }) },
    pages: [{ resourceId: THANKS_ID, path: "thanks" }],
  });

  const pulled = await runWithSite(site, scripted, ["forms", "pull"]);
  assert.equal(pulled.exit, 0, pulled.stderr);
  const file = JSON.parse(await readText(site, "forms/contact.json"));
  assert.deepEqual(file.definition.after_submit, { show: "page", page_path: "/thanks" });
  assert.equal(file.definition.submit_label, "Send message");

  const before = await readText(site, "forms/contact.json");
  const pushed = await runWithSite(site, scripted, ["forms", "push"]);
  assert.equal(pushed.exit, 0, pushed.stderr);
  assert.deepEqual(pushed.result.forms.items, [{ key: "contact", action: "unchanged", version: 2 }]);
  assert.equal(await readText(site, "forms/contact.json"), before);
  assert.deepEqual(writes(scripted), []);
});

test("forms pull keeps the resource id of a page that no longer exists", async (t) => {
  const site = await workspace(t, { ".taproot-site-manifest.json": MANIFEST });
  const stored = withSettings({ after_submit: { show: "page", page_resource_id: THANKS_ID } });
  const scripted = scriptedSite({ forms: { contact: wireForm(stored, { version: 1 }) }, pages: [] });

  await runWithSite(site, scripted, ["forms", "pull"]);

  assert.deepEqual(JSON.parse(await readText(site, "forms/contact.json")).definition.after_submit, {
    show: "page",
    page_resource_id: THANKS_ID,
  });
});

test("forms push stores a page_path by the page's resource id and rewrites nothing the site would not", async (t) => {
  const site = await workspace(t, { ".taproot-site-manifest.json": MANIFEST, "forms/contact.json": THANKS_FORM });
  const scripted = scriptedSite({ forms: {}, pages: [{ resourceId: THANKS_ID, path: "/thanks/" }] });

  const created = await runWithSite(site, scripted, ["forms", "push"]);

  assert.equal(created.exit, 0, created.stderr);
  const [create] = writes(scripted);
  assert.deepEqual(JSON.parse(create.body.definition).after_submit, { show: "page", page_resource_id: THANKS_ID });
  assert.equal(JSON.parse(create.body.definition).submit_label, "Send message");
  assert.equal(await readText(site, "forms/contact.json"), `${JSON.stringify(THANKS_FORM, undefined, 2)}\n`);

  // Pointing the file at another page, and dropping the button text, appends a version that names the new resource id.
  const otherId = "eeee5555-ffff-4555-8555-aaaa55555555";
  const edited = withSettings({ after_submit: { show: "page", page_path: "/welcome" } });
  await writeFile(path.join(site.workspaceDir, "forms", "contact.json"), `${JSON.stringify(edited, undefined, 2)}\n`);
  const moving = scriptedSite({
    forms: {
      contact: wireForm(
        withSettings({ submit_label: "Send message", after_submit: { show: "page", page_resource_id: THANKS_ID } }),
        { version: 1 },
      ),
    },
    pages: [{ resourceId: THANKS_ID, path: "thanks" }, { resourceId: otherId, path: "welcome" }],
  });
  const moved = await runWithSite(site, moving, ["forms", "push"]);
  assert.equal(moved.exit, 0, moved.stderr);
  const [version] = writes(moving);
  assert.deepEqual(JSON.parse(version.body.definition).after_submit, { show: "page", page_resource_id: otherId });
  assert.equal(JSON.parse(version.body.definition).submit_label, undefined);
});

test("forms push refuses a page_path or resource id the site does not have, before any write", async (t) => {
  const site = await workspace(t, { ".taproot-site-manifest.json": MANIFEST, "forms/contact.json": THANKS_FORM });
  const scripted = scriptedSite({ forms: {}, pages: [{ resourceId: THANKS_ID, path: "about" }] });

  const unknownPath = await runWithSite(site, scripted, ["forms", "push"]);
  assert.equal(unknownPath.exit, 1);
  assert.equal(unknownPath.result.error.code, "forms.page_not_found");
  assert.match(unknownPath.stderr, /no page on the site has the path '\/thanks'/u);

  await writeFile(
    path.join(site.workspaceDir, "forms", "contact.json"),
    `${JSON.stringify(withSettings({ after_submit: { show: "page", page_resource_id: otherResourceId() } }), undefined, 2)}\n`,
  );
  const unknownId = await runWithSite(site, scripted, ["forms", "push"]);
  assert.equal(unknownId.result.error.code, "forms.page_not_found");
  assert.deepEqual(writes(scripted), []);
});

for (
  const [label, page] of [
    ["a generated page", { path: "tags/travel", templateType: "TEMPLATE_TYPE_GENERATED", isGenerated: true }],
    ["a generated page flagged only by isGenerated", { path: "thanks", isGenerated: true }],
    ["the 404 page", { path: "404", templateType: "TEMPLATE_TYPE_FREE_FORM" }],
    ["an integration-managed page", { path: "thanks", templateType: "TEMPLATE_TYPE_INTEGRATION_MANAGED" }],
    ["a legal page", { path: "terms", templateType: "TEMPLATE_TYPE_LEGAL" }],
    ["a profile home page", { path: "me", templateType: "TEMPLATE_TYPE_PROFILE_HOME" }],
  ]
) {
  test(`forms push refuses ${label} as a page_path or resource id before any write`, async (t) => {
    const form = withSettings({ after_submit: { show: "page", page_path: `/${page.path}` } });
    const site = await workspace(t, { ".taproot-site-manifest.json": MANIFEST, "forms/contact.json": form });
    const scripted = scriptedSite({ forms: {}, pages: [{ resourceId: THANKS_ID, ...page }] });

    const byPath = await runWithSite(site, scripted, ["forms", "push"]);
    assert.equal(byPath.exit, 1);
    assert.equal(byPath.result.error.code, "forms.page_not_allowed");
    assert.match(byPath.stderr, /can send visitors only to a page you created/u);

    const byId = withSettings({ after_submit: { show: "page", page_resource_id: THANKS_ID } });
    await writeFile(path.join(site.workspaceDir, "forms", "contact.json"), `${JSON.stringify(byId, undefined, 2)}\n`);
    const refused = await runWithSite(site, scripted, ["forms", "push"]);
    assert.equal(refused.result.error.code, "forms.page_not_allowed");
    assert.deepEqual(writes(scripted), []);
  });
}

test("forms push accepts the home page and an article as targets", async (t) => {
  for (const page of [{ path: "/" }, { path: "hello", templateType: "TEMPLATE_TYPE_ARTICLE" }]) {
    const form = withSettings({ after_submit: { show: "page", page_path: page.path === "/" ? "/" : `/${page.path}` } });
    const site = await workspace(t, { ".taproot-site-manifest.json": MANIFEST, "forms/contact.json": form });
    const scripted = scriptedSite({ forms: {}, pages: [{ resourceId: THANKS_ID, ...page }] });

    const pushed = await runWithSite(site, scripted, ["forms", "push"]);

    assert.equal(pushed.exit, 0, pushed.stderr);
  }
});

test("forms push resolves every page before writing any form, so a missing page leaves no partial write", async (t) => {
  const waitlist = { ...THANKS_FORM, key: "waitlist", name: "Waitlist" };
  const site = await workspace(t, {
    ".taproot-site-manifest.json": MANIFEST,
    "forms/contact.json": CONTACT_FORM,
    "forms/waitlist.json": waitlist,
  });
  const scripted = scriptedSite({ forms: {}, pages: [{ resourceId: THANKS_ID, path: "about" }] });

  const refused = await runWithSite(site, scripted, ["forms", "push"]);

  assert.equal(refused.exit, 1);
  assert.equal(refused.result.error.code, "forms.page_not_found");
  assert.equal(refused.result.error.completedWrites, undefined);
  assert.deepEqual(writes(scripted), []);
});

test("forms push still saves a name change for a form whose page was deleted, since it never sends the definition", async (t) => {
  const site = await workspace(t, { ".taproot-site-manifest.json": MANIFEST });
  const stored = withSettings({ after_submit: { show: "page", page_resource_id: THANKS_ID } });
  const scripted = scriptedSite({ forms: { contact: wireForm(stored, { version: 1 }) }, pages: [] });
  await runWithSite(site, scripted, ["forms", "pull"]);
  const edited = JSON.parse(await readText(site, "forms/contact.json"));
  edited.name = "Contact us";
  await writeFile(path.join(site.workspaceDir, "forms", "contact.json"), `${JSON.stringify(edited, undefined, 2)}\n`);

  const pushed = await runWithSite(site, scripted, ["forms", "push"]);

  assert.equal(pushed.exit, 0, pushed.stderr);
  assert.deepEqual(writes(scripted).map((call) => call.method), ["PUT"]);
});

test("forms push explains a page_path it cannot look up when the page listing was cut short", () => {
  const pages = { idByPath: new Map(), pathById: new Map(), truncated: true };
  assert.throws(
    () => storedDefinition("forms/contact.json", THANKS_FORM.definition, pages),
    /more pages than this CLI lists/u,
  );
});

function otherResourceId() {
  return "ffff6666-aaaa-4666-8666-bbbb66666666";
}

test("the form component takes only formKey, and a page that still carries the retired properties is refused", () => {
  const reference = getComponentReference("form");
  assert.deepEqual(reference.properties.map((property) => property.name), ["formKey"]);
  assert.equal(reference.additionalProperties, false);
  assert.deepEqual(validateComponentBlock("form", JSON.stringify({ formKey: "contact" }), "/body"), []);
  for (const retired of ["submitLabel", "successMessage"]) {
    const errors = validateComponentBlock("form", JSON.stringify({ formKey: "contact", [retired]: "x" }), "/body");
    assert.equal(errors.length, 1, retired);
    assert.match(errors[0].message, new RegExp(retired, "u"));
  }
});

test("the component help names resolves to the registered form component", async () => {
  let stdout = "";
  await runCli({
    arguments_: ["help", "forms", "--json"],
    environment: {},
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: () => {} },
  });
  const named = JSON.parse(stdout).reference.details.join("\n").match(/'help component ([a-z-]+)'/u)?.[1];
  assert.equal(named, "form");
  assert.ok(getComponentReference(named));
});

test("forms push creates a form without retention on a plan whose default is shorter, and records what the site chose", async (t) => {
  const { retention_days: _omitted, ...withoutRetention } = CONTACT_FORM;
  const site = await workspace(t, { ".taproot-site-manifest.json": MANIFEST, "forms/contact.json": withoutRetention });
  const scripted = scriptedSite({ forms: {}, defaultRetention: 90 });

  const { exit, result } = await runWithSite(site, scripted, ["forms", "push"]);

  assert.equal(exit, 0, JSON.stringify(result));
  assert.equal(JSON.parse(await readText(site, "forms/contact.json")).retention_days, 90);
  const manifest = JSON.parse(await readText(site, ".taproot-site-manifest.json"));
  assert.equal(manifest.forms.items.contact.settings.retention_days, 90);
});

test("forms push keeps the site's retention when an existing form's file names none", async (t) => {
  const site = await workspace(t, { ".taproot-site-manifest.json": MANIFEST });
  const scripted = scriptedSite({ forms: { contact: wireForm({ ...CONTACT_FORM, retention_days: 90 }, { version: 1 }) } });
  await runWithSite(site, scripted, ["forms", "pull"]);
  const edited = JSON.parse(await readText(site, "forms/contact.json"));
  delete edited.retention_days;
  edited.name = "Contact us";
  await writeFile(path.join(site.workspaceDir, "forms", "contact.json"), `${JSON.stringify(edited, undefined, 2)}\n`);

  const { exit } = await runWithSite(site, scripted, ["forms", "push"]);

  assert.equal(exit, 0);
  const [settings] = writes(scripted);
  assert.equal(settings.body.retentionDays, 90);
});

test("forms push sends the recorded version and settings, and a save made in between is refused by the site", async (t) => {
  const other = { ...CONTACT_FORM, key: "waitlist", name: "Waitlist" };
  const site = await workspace(t, { ".taproot-site-manifest.json": MANIFEST });
  const state = {
    forms: {
      contact: wireForm(CONTACT_FORM, { version: 1 }),
      waitlist: wireForm(other, { version: 1, id: WAITLIST_ID }),
    },
  };
  const scripted = scriptedSite(state);
  await runWithSite(site, scripted, ["forms", "pull"]);
  for (const form of [CONTACT_FORM, other]) {
    await writeFile(
      path.join(site.workspaceDir, "forms", `${form.key}.json`),
      `${JSON.stringify({ ...form, name: `${form.name} edited` }, undefined, 2)}\n`,
    );
  }
  // Another author renames the waitlist form after the CLI compared it and
  // before its write reaches the site; only the site can see that.
  const original = scripted.fetchImpl;
  const racing = {
    calls: scripted.calls,
    fetchImpl: async (url, init = {}) => {
      if ((init.method ?? "GET") === "PUT" && String(url).includes(WAITLIST_ID)) {
        state.forms.waitlist.form.name = "Renamed by someone else";
      }
      return original(url, init);
    },
  };
  scripted.calls.length = 0;

  const refusal = await runWithSite(site, racing, ["forms", "push"]);

  assert.equal(refusal.result.error.code, "forms.concurrent_modification");
  // The contact form landed first and is reported; the waitlist form was not changed.
  assert.deepEqual(refusal.result.error.completedWrites, ["contact"]);
  const put = scripted.calls.find((call) => call.method === "PUT" && call.pathname.includes(WAITLIST_ID));
  assert.equal(put.body.expectedName, "Waitlist");
  assert.equal(put.body.expectedRetentionDays, 365);
  assert.equal(state.forms.waitlist.form.name, "Renamed by someone else");
});

test("forms push names the version it last read when saving a definition", async (t) => {
  const site = await workspace(t, { ".taproot-site-manifest.json": MANIFEST });
  const scripted = scriptedSite({ forms: { contact: wireForm(CONTACT_FORM, { version: 4 }) } });
  await runWithSite(site, scripted, ["forms", "pull"]);
  const edited = JSON.parse(await readText(site, "forms/contact.json"));
  edited.definition.fields.push({ id: "phone", type: "tel", label: "Phone" });
  await writeFile(path.join(site.workspaceDir, "forms", "contact.json"), `${JSON.stringify(edited, undefined, 2)}\n`);

  const { exit } = await runWithSite(site, scripted, ["forms", "push"]);

  assert.equal(exit, 0);
  assert.equal(writes(scripted).find((call) => call.pathname.endsWith("/versions")).body.expectedVersion, 4);
});

test("forms push says the settings were applied when the definition is then refused as stale", async (t) => {
  const site = await workspace(t, { ".taproot-site-manifest.json": MANIFEST });
  const state = { forms: { contact: wireForm(CONTACT_FORM, { version: 1 }) } };
  const scripted = scriptedSite(state);
  await runWithSite(site, scripted, ["forms", "pull"]);
  const edited = JSON.parse(await readText(site, "forms/contact.json"));
  edited.name = "Contact us";
  edited.definition.fields.push({ id: "phone", type: "tel", label: "Phone" });
  await writeFile(path.join(site.workspaceDir, "forms", "contact.json"), `${JSON.stringify(edited, undefined, 2)}\n`);
  const original = scripted.fetchImpl;
  const racing = {
    calls: scripted.calls,
    fetchImpl: async (url, init = {}) => {
      // Someone saves a new version between this push's settings write and its version save.
      if ((init.method ?? "GET") === "POST" && String(url).endsWith("/versions")) state.forms.contact.form.currentVersion = 2;
      return original(url, init);
    },
  };

  const refusal = await runWithSite(site, racing, ["forms", "push"]);

  assert.equal(refusal.result.error.code, "forms.concurrent_modification");
  assert.match(refusal.stderr, /Its settings were applied; its definition was not/u);
  assert.deepEqual(refusal.result.error.completedWrites, ["contact"]);
  assert.equal(state.forms.contact.form.name, "Contact us");
});

test("forms validate accepts relative date limits and the help examples, and refuses a bad one by path and code", async (t) => {
  const withDates = structuredClone(CONTACT_FORM);
  withDates.definition.fields.push(FORM_DATE_WINDOW_FIELD, FORM_NEXT_MONTH_FIELD);
  assert.doesNotThrow(() => validateFormDocument(withDates, "contact"));

  const broken = structuredClone(withDates);
  broken.definition.fields[4].min = { from: "yesterday" };
  broken.definition.fields[5].max = { from: "end_of_next_month", offset_days: 400 };
  const site = await workspace(t, { [formFileName("contact")]: broken });
  const { exit, result, stderr } = await run(site, ["forms", "validate"]);
  assert.equal(exit, 1);
  assert.equal(result.error.code, "forms.file_invalid");
  assert.match(stderr, /fields\[4\]\.min/u);
  assert.match(stderr, /fields\[5\]\.max/u);
  assert.match(stderr, /invalid_constraint/u);
});

test("help forms documents the relative date limit shape with both examples", () => {
  const text = getWorkflowReference("forms").details.join(" ");
  assert.ok(text.includes(JSON.stringify(FORM_DATE_WINDOW_FIELD)));
  assert.ok(text.includes(JSON.stringify(FORM_NEXT_MONTH_FIELD)));
  assert.match(text, /offset_days is a whole number of days from -366 to 366/u);
  for (const anchor of DATE_ANCHORS) assert.ok(text.includes(anchor), anchor);
  assert.match(text, /timeZone in settings\/site-publishing-preferences\.json/u);
});

test("help forms states the contact address rule", () => {
  const text = getWorkflowReference("forms").details.join(" ");
  assert.match(text, /exactly one email field, that field is the contact address and the file leaves contact_field out/u);
  assert.match(text, /two or more email fields, contact_field must name one of them/u);
  assert.match(text, /contact_field_required/u);
});

test("help forms states which pages a form may send visitors to", () => {
  const text = getWorkflowReference("forms").details.join(" ");
  assert.match(text, /must be one you created, the home page included/u);
  assert.match(text, /forms\.page_not_allowed/u);
});
