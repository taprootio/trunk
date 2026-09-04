import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { SiteAuthoringError } from "../src/errors.js";

const PAGE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SNAPSHOT_ID = "11111111-2222-4333-8444-555555555555";
const SITE_ID = "aaaa1111-bbbb-4111-8111-cccc11111111";

function sink() {
  let value = "";
  return {
    write: (chunk) => {
      value += chunk;
    },
    read: () => value,
  };
}

function successResult(verb) {
  return {
    schemaVersion: 1,
    ok: true,
    cli: { name: "@taprootio/site-authoring", version: "0.1.1" },
    verb,
  };
}

const ROUTES = [
  // Credential-free but config-reading: they manage the stored credential
  // rather than using one, so they take --config and never require a key.
  { arguments_: ["login"], verb: "login", credentialFree: true },
  { arguments_: ["login", "--name", "Laptop CLI"], verb: "login", keyName: "Laptop CLI", credentialFree: true },
  { arguments_: ["logout"], verb: "logout", credentialFree: true },
  { arguments_: ["pull"], verb: "pull" },
  { arguments_: ["pages", "push"], verb: "pages push" },
  { arguments_: ["nav", "push"], verb: "nav push" },
  { arguments_: ["theme", "push"], verb: "theme push" },
  { arguments_: ["footer", "push"], verb: "footer push" },
  { arguments_: ["media", "upload"], verb: "media upload" },
  { arguments_: ["approve"], verb: "approve" },
  { arguments_: ["deploy", "--staging"], verb: "deploy", deployTarget: "staging" },
  { arguments_: ["deploy", "--production"], verb: "deploy", deployTarget: "production" },
  { arguments_: ["preview", "page", PAGE_ID, "--json"], verb: "preview page", pageSelector: PAGE_ID },
  // The documented homepage spelling must survive positional validation, which
  // refuses the raw empty string the manifest records for the root page.
  { arguments_: ["preview", "page", "/"], verb: "preview page", pageSelector: "/" },
  {
    arguments_: ["preview", "revoke", PAGE_ID, SNAPSHOT_ID, "--json"],
    verb: "preview revoke",
    previewIds: [PAGE_ID, SNAPSHOT_ID],
  },
  { arguments_: ["status"], verb: "status" },
];

test("routes every verb to its own handler with the parsed invocation", async (testContext) => {
  for (const route of ROUTES) {
    await testContext.test(route.arguments_.join(" "), async () => {
      const invocations = [];
      const stdout = sink();
      // Login is the one verb that refuses --quiet: its approval URL exists
      // only as progress, so a silenced login could never be completed.
      const quiet = route.verb !== "login";
      const exitCode = await runCli({
        arguments_: ["--config", "site config.json", ...route.arguments_, ...(quiet ? ["--quiet"] : [])],
        environment: {},
        cwd: "/workspace",
        stdout,
        stderr: sink(),
        handlers: {
          [route.verb]: async (invocation) => {
            invocations.push(invocation);
            return successResult(route.verb);
          },
        },
      });
      assert.equal(exitCode, 0);
      assert.equal(invocations.length, 1);
      assert.equal(invocations[0].verb, route.verb);
      assert.equal(invocations[0].cwd, "/workspace");
      assert.equal(invocations[0].configPath, "site config.json");
      assert.equal(invocations[0].quiet, quiet);
      assert.equal(invocations[0].deployTarget, route.deployTarget);
      assert.equal(invocations[0].pageSelector, route.pageSelector);
      assert.equal(invocations[0].keyName, route.keyName);
      assert.deepEqual(invocations[0].previewIds, route.previewIds);
      assert.deepEqual(JSON.parse(stdout.read()), successResult(route.verb));
    });
  }
});

test("routes offline validate without config or credential state", async () => {
  let seen;
  const stdout = sink();
  const exitCode = await runCli({
    arguments_: ["validate", "fixtures/site with spaces", "--quiet"],
    environment: {},
    cwd: "/workspace",
    stdout,
    stderr: sink(),
    handlers: {
      validate: async (invocation) => {
        seen = invocation;
        return successResult("validate");
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(seen.verb, "validate");
  assert.equal(seen.fixturePath, "fixtures/site with spaces");
  assert.equal(seen.configPath, undefined);
  assert.equal(seen.quiet, true);
  assert.deepEqual(JSON.parse(stdout.read()), successResult("validate"));
});

test("the shipped status handler honors explicit config from a config-free cwd and parent discovery", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taproot-site-cli-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "configuration with spaces");
  const workspace = path.join(project, "site");
  const invocationDirectory = path.join(root, "invocation directory");
  const discoveredDirectory = path.join(project, "nested", "command");
  await mkdir(workspace, { recursive: true });
  await mkdir(invocationDirectory, { recursive: true });
  await mkdir(discoveredDirectory, { recursive: true });
  const configPath = path.join(project, "taproot-site.json");
  await writeFile(
    configPath,
    `${JSON.stringify({
      configVersion: 1,
      siteId: SITE_ID,
      workspaceDir: "site",
    })}\n`,
  );
  // The endpoint is machine state since TR00645, so it is set here the way
  // `env local` sets it rather than in the project configuration.
  const configHome = path.join(root, "config-home");
  await mkdir(path.join(configHome, "taproot-site"), { recursive: true });
  await writeFile(
    path.join(configHome, "taproot-site", "settings.json"),
    `${JSON.stringify({ schemaVersion: 1, apiBaseUrl: "https://app.taproot.test/api" })}\n`,
  );

  const token = "test-key-not-a-real-credential";
  const responses = (url, options) => {
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    let body;
    if (url.pathname.endsWith("/publishing/readiness")) {
      body = {
        state: "PAGE_PUBLISHING_READINESS_STATE_READY",
        approvedPageCount: 0,
        blockedPageCount: 0,
        hasCandidateChanges: false,
        hasSuccessfulStagingDeployment: false,
        blockers: [],
      };
    } else if (url.pathname.endsWith("/deployments")) {
      body = { deployments: [], nextPageToken: "" };
    } else if (url.pathname.endsWith("/images")) {
      body = { images: [], totalImages: 0, processingImages: 0, nextPageToken: "" };
    } else {
      assert.fail(`unexpected request path ${url.pathname}`);
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const cases = [
    {
      label: "explicit path with spaces",
      cwd: invocationDirectory,
      arguments_: ["--config", path.relative(invocationDirectory, configPath), "status"],
    },
    { label: "parent discovery", cwd: discoveredDirectory, arguments_: ["status"] },
  ];
  for (const scenario of cases) {
    await context.test(scenario.label, async () => {
      const stdout = sink();
      const stderr = sink();
      const exitCode = await runCli({
        arguments_: scenario.arguments_,
        environment: { TAPROOT_SITE_KEY: token, XDG_CONFIG_HOME: configHome },
        cwd: scenario.cwd,
        stdout,
        stderr,
        fetch: responses,
      });
      assert.equal(exitCode, 0);
      const result = JSON.parse(stdout.read());
      assert.equal(result.ok, true);
      assert.equal(result.verb, "status");
      assert.equal(result.siteId, SITE_ID);
      assert.match(stderr.read(), /^Reading publishing readiness\./u);
      assert.doesNotMatch(`${stdout.read()}${stderr.read()}`, new RegExp(token, "u"));
    });
  }
});

// Routing reaches a real handler for every key-authorized verb, and every one of
// them stops at the same place without a credential: before the configuration is
// read, before any workspace path is resolved, and before a single request is
// built. login and logout are excluded because they are credential-free by
// design — they exist to obtain and discard the credential the others need.
//
// XDG_CONFIG_HOME points at an empty directory so the sweep asserts against a
// store that is genuinely empty rather than against whatever the machine
// running the tests happens to have logged in to.
test("the shipped verb handlers refuse a missing credential before doing anything else", async (testContext) => {
  const emptyConfigHome = await mkdtemp(path.join(os.tmpdir(), "taproot-site-empty-config-"));
  testContext.after(() => rm(emptyConfigHome, { recursive: true, force: true }));
  for (const route of ROUTES.filter((candidate) => !candidate.credentialFree)) {
    await testContext.test(route.arguments_.join(" "), async () => {
      const stdout = sink();
      const stderr = sink();
      const exitCode = await runCli({
        arguments_: route.arguments_,
        environment: { XDG_CONFIG_HOME: emptyConfigHome },
        cwd: "/nonexistent-workspace-root",
        stdout,
        stderr,
        fetch: () => {
          throw new Error("no request may be built without a credential");
        },
      });
      assert.equal(exitCode, 1);
      assert.deepEqual(JSON.parse(stdout.read()).error, { code: "auth.key_missing" });
      assert.match(stderr.read(), /^taproot-site failed \[auth\.key_missing\]/u);
      // Both remedies, because there are now two: the environment variable CI
      // sets, and the login that stores one for a person.
      assert.match(stderr.read(), /TAPROOT_SITE_KEY/u);
      assert.match(stderr.read(), /taproot-site login/u);
    });
  }
});

test("usage faults exit 2 with stable codes", async (testContext) => {
  const faults = [
    { arguments_: [], code: "cli.usage" },
    { arguments_: ["pages"], code: "cli.usage" },
    { arguments_: ["nav"], code: "cli.usage" },
    { arguments_: ["publish"], code: "cli.usage" },
    { arguments_: ["pull", "extra"], code: "cli.unexpected_argument" },
    { arguments_: ["pull", "--nope"], code: "cli.unknown_option" },
    { arguments_: ["pull", "--staging"], code: "cli.unknown_option" },
    { arguments_: ["pull", "--quiet", "--quiet"], code: "cli.duplicate_option" },
    // A silenced login can never be approved: the URL and code exist only as
    // progress, and the JSON result arrives only after the approval completes.
    { arguments_: ["login", "--quiet"], code: "cli.quiet_option", field: "quiet" },
    { arguments_: ["validate"], code: "validate.fixture_path_invalid", field: "fixturePath" },
    {
      arguments_: ["validate", "one", "two"],
      code: "validate.fixture_path_invalid",
      field: "fixturePath",
    },
    {
      arguments_: ["--config", "site.json", "validate", "fixture"],
      code: "cli.config_option",
      field: "configPath",
    },
    { arguments_: ["--config"], code: "cli.config_option", field: "configPath" },
    { arguments_: ["--config", "--quiet", "pull"], code: "cli.config_option", field: "configPath" },
    { arguments_: ["pull", "--config", "one.json"], code: "cli.config_option", field: "configPath" },
    {
      arguments_: ["--config", "one.json", "pull", "--config", "two.json"],
      code: "cli.config_option",
      field: "configPath",
    },
    { arguments_: ["deploy"], code: "cli.deploy_target" },
    { arguments_: ["deploy", "--staging", "--production"], code: "cli.deploy_target" },
    { arguments_: ["deploy", "--staging", "--staging"], code: "cli.duplicate_option" },
    { arguments_: ["pull", "--allow-raw-html"], code: "cli.unknown_option" },
    { arguments_: ["pages", "push", "--allow-raw-html", "--allow-raw-html"], code: "cli.duplicate_option" },
    { arguments_: ["status", "stray-positional"], code: "cli.unexpected_argument" },
    { arguments_: ["approve", "blogpage"], code: "cli.unexpected_argument" },
    { arguments_: ["preview", "page"], code: "preview.page_selector_invalid" },
    { arguments_: ["preview", "page", PAGE_ID, PAGE_ID], code: "preview.page_selector_invalid" },
    { arguments_: ["preview", "page", PAGE_ID.toUpperCase()], code: "preview.page_selector_invalid" },
    { arguments_: ["preview", "page", PAGE_ID, "--json", "--json"], code: "cli.duplicate_option" },
    { arguments_: ["preview", "revoke", PAGE_ID], code: "preview.identity_invalid" },
    {
      arguments_: ["preview", "revoke", "NOT-A-UUID", SNAPSHOT_ID],
      code: "preview.identity_invalid",
      field: "pageId",
    },
    { arguments_: ["preview", "revoke", PAGE_ID, "NOT-A-UUID"], code: "preview.identity_invalid" },
    { arguments_: ["preview", "revoke", PAGE_ID, SNAPSHOT_ID, PAGE_ID], code: "preview.identity_invalid" },
    { arguments_: ["pull", "--json"], code: "cli.unknown_option" },
    // --name belongs to login alone, takes exactly one printable value, and is
    // refused outright on every other verb.
    { arguments_: ["login", "--name"], code: "cli.name_option", field: "keyName" },
    { arguments_: ["login", "--name", "--quiet"], code: "cli.name_option", field: "keyName" },
    { arguments_: ["login", "--name", "a", "--name", "b"], code: "cli.duplicate_option" },
    { arguments_: ["login", "stray-positional"], code: "cli.unexpected_argument" },
    { arguments_: ["logout", "--name", "a"], code: "cli.unknown_option" },
    { arguments_: ["pull", "--name", "a"], code: "cli.unknown_option" },
  ];
  for (const fault of faults) {
    await testContext.test(`[${fault.arguments_.join(" ")}] -> ${fault.code}`, async () => {
      let handlerCalls = 0;
      const stdout = sink();
      const handlers = Object.fromEntries(ROUTES.map((route) => [
        route.verb,
        async () => {
          handlerCalls += 1;
          return successResult(route.verb);
        },
      ]));
      handlers.validate = async () => {
        handlerCalls += 1;
        return successResult("validate");
      };
      const exitCode = await runCli({
        arguments_: fault.arguments_,
        environment: {},
        stdout,
        stderr: sink(),
        handlers,
      });
      assert.equal(exitCode, 2);
      assert.equal(handlerCalls, 0);
      const error = JSON.parse(stdout.read()).error;
      assert.equal(error.code, fault.code);
      if (fault.field !== undefined) assert.equal(error.field, fault.field);
      if (fault.code === "preview.page_selector_invalid") assert.equal(error.field, "pageSelector");
      if (fault.code === "preview.identity_invalid") assert.equal(error.field, fault.field ?? "snapshotId");
    });
  }
});

test("threads the raw-html flag and verb positionals into the invocation", async (testContext) => {
  const cases = [
    {
      arguments_: ["validate", "fixtures/taproot-www"],
      verb: "validate",
      expect: (invocation) => invocation.fixturePath === "fixtures/taproot-www" && invocation.configPath === undefined,
      label: "validate receives one scalar fixture directory",
    },
    {
      arguments_: ["pages", "push", "--allow-raw-html"],
      verb: "pages push",
      expect: (invocation) => invocation.allowRawHtml === true,
      label: "pages push --allow-raw-html",
    },
    {
      arguments_: ["pages", "push"],
      verb: "pages push",
      expect: (invocation) => invocation.allowRawHtml === false,
      label: "pages push defaults raw html off",
    },
    {
      arguments_: ["media", "upload", "a.png", "assets/b.jpg"],
      verb: "media upload",
      expect: (invocation) =>
        Array.isArray(invocation.paths)
        && invocation.paths.length === 2
        && invocation.paths[0] === "a.png"
        && invocation.paths[1] === "assets/b.jpg",
      label: "media upload positionals become paths",
    },
    {
      arguments_: ["media", "upload"],
      verb: "media upload",
      expect: (invocation) => invocation.paths === undefined,
      label: "media upload without positionals keeps the default walk",
    },
    {
      arguments_: ["approve", "blog/hello", "about"],
      verb: "approve",
      expect: (invocation) =>
        Array.isArray(invocation.pagePaths)
        && invocation.pagePaths.length === 2
        && invocation.pagePaths[0] === "blog/hello",
      label: "approve positionals become pagePaths",
    },
    {
      arguments_: ["preview", "page", PAGE_ID, "--json"],
      verb: "preview page",
      expect: (invocation) => invocation.pageSelector === PAGE_ID && !Array.isArray(invocation.pageSelector),
      label: "preview page receives one scalar path-or-id selector",
    },
    {
      arguments_: ["preview", "revoke", PAGE_ID, SNAPSHOT_ID, "--json"],
      verb: "preview revoke",
      expect: (invocation) =>
        Array.isArray(invocation.previewIds)
        && invocation.previewIds[0] === PAGE_ID
        && invocation.previewIds[1] === SNAPSHOT_ID,
      label: "preview revoke receives the page and snapshot IDs",
    },
  ];
  for (const scenario of cases) {
    await testContext.test(scenario.label, async () => {
      let seen;
      const exitCode = await runCli({
        arguments_: scenario.arguments_,
        environment: {},
        stdout: sink(),
        stderr: sink(),
        handlers: {
          [scenario.verb]: async (invocation) => {
            seen = invocation;
            return successResult(scenario.verb);
          },
        },
      });
      assert.equal(exitCode, 0);
      assert.ok(seen, "the handler ran");
      assert.ok(scenario.expect(seen), "the invocation carried the parsed shape");
    });
  }
});

test("does not accept a credential command-line option", async () => {
  const stdout = sink();
  const stderr = sink();
  const exitCode = await runCli({
    arguments_: ["pages", "push", "--token", "secret-on-command-line"],
    environment: {},
    stdout,
    stderr,
    handlers: { "pages push": async () => successResult("pages push") },
  });
  assert.equal(exitCode, 2);
  assert.equal(JSON.parse(stdout.read()).error.code, "cli.unknown_option");
  assert.doesNotMatch(`${stdout.read()}${stderr.read()}`, /secret-on-command-line/u);
});

test("exposes help and version at the binary and verb levels", async (testContext) => {
  const stdout = sink();
  assert.equal(await runCli({ arguments_: ["--help"], stdout, stderr: sink() }), 0);
  assert.match(stdout.read(), /^Usage: taproot-site \[--config <path>\] <verb>/u);
  assert.match(stdout.read(), /^  help\s+Show offline authoring reference help/mu);
  assert.match(stdout.read(), /^  validate\s+Validate a complete authoring fixture/mu);
  assert.match(stdout.read(), /validate,\nhelp, whoami, and env are offline and read-only/u);
  assert.match(stdout.read(), /^  login\s+Authorize this CLI against a Taproot account/mu);
  assert.match(stdout.read(), /^  logout\s+Discard the stored Taproot sign-in/mu);
  // The three verbs TR00645 added, which are what make a site selectable
  // without hand-writing one into JSON.
  assert.match(stdout.read(), /^  sites\s+List the sites this sign-in may author/mu);
  assert.match(stdout.read(), /^  use\s+Choose the site the next command writes to/mu);
  assert.match(stdout.read(), /^  whoami\s+Report the Taproot, account, site/mu);
  // The configuration contract is documented at the top level (TR00635), so
  // it is no longer discoverable only by triggering validation errors: the
  // file, its three fields, the explicit-path option, and the fact that the
  // endpoint is machine state with a reviewed origin set.
  assert.match(stdout.read(), /^Configuration:$/mu);
  assert.match(stdout.read(), /taproot-site\.json/u);
  assert.match(stdout.read(), /--config <path> before the verb/u);
  assert.match(stdout.read(), /^\s+configVersion\s+must be 1$/mu);
  assert.match(stdout.read(), /^\s+siteId\s+optional/mu);
  assert.match(stdout.read(), /^\s+workspaceDir\s+a relative POSIX path beneath the configuration directory/mu);
  assert.match(stdout.read(), /apiBaseUrl is not a field/u);
  assert.match(stdout.read(), /app\.taproot\.io \(the default\), app\.taproot\.test, or an explicit loopback URL/u);
  await testContext.test("validate", async () => {
    const verbStdout = sink();
    assert.equal(await runCli({ arguments_: ["validate", "--help"], stdout: verbStdout, stderr: sink() }), 0);
    assert.match(verbStdout.read(), /^Usage: taproot-site validate <fixture-directory>/u);
    assert.match(verbStdout.read(), /reads no configuration or credential/u);
    assert.match(verbStdout.read(), /does not prove authorization, live site ownership, concurrency/u);
    assert.doesNotMatch(verbStdout.read(), /TAPROOT_SITE_KEY/u);
    assert.doesNotMatch(verbStdout.read(), /--config/u);
  });
  // What login and logout help must say. They mention TAPROOT_SITE_KEY like
  // every other config-reading verb — the precedence rule is exactly what a
  // reader of these two needs — but must never repeat the old claim that the
  // credential comes only from the environment, which login exists to falsify.
  await testContext.test("login help contract", async () => {
    const verbStdout = sink();
    assert.equal(await runCli({ arguments_: ["login", "--help"], stdout: verbStdout, stderr: sink() }), 0);
    assert.match(verbStdout.read(), /^Usage: taproot-site \[--config <path>\] login/u);
    assert.match(verbStdout.read(), /requires no existing credential/u);
    assert.match(verbStdout.read(), /TAPROOT_SITE_KEY always takes precedence/u);
    assert.match(verbStdout.read(), /--name <text>/u);
    assert.match(verbStdout.read(), /\$XDG_CONFIG_HOME\/taproot-site\//u);
    assert.match(verbStdout.read(), /directory 0700 and file 0600/u);
    assert.match(verbStdout.read(), /never displayed, logged, or placed in the JSON\s+result/u);
    assert.match(verbStdout.read(), /--quiet is rejected for this verb/u);
    // The Options block must not advertise the option the note rejects: a
    // list entry and a contradiction two paragraphs apart is worse than
    // either alone.
    assert.doesNotMatch(verbStdout.read(), /--quiet\s+Suppress/u);
    assert.doesNotMatch(verbStdout.read(), /read only from/u);
  });
  await testContext.test("logout help contract", async () => {
    const verbStdout = sink();
    assert.equal(await runCli({ arguments_: ["logout", "--help"], stdout: verbStdout, stderr: sink() }), 0);
    assert.match(verbStdout.read(), /^Usage: taproot-site \[--config <path>\] logout/u);
    assert.match(verbStdout.read(), /local discard only/u);
    assert.match(verbStdout.read(), /Account -> Settings -> API keys/u);
    assert.match(verbStdout.read(), /TAPROOT_SITE_KEY/u);
    assert.doesNotMatch(verbStdout.read(), /--name/u);
  });
  for (
    const verb of [
      "login",
      "logout",
      "pull",
      "pages push",
      "nav push",
      "theme push",
      "footer push",
      "media upload",
      "approve",
      "deploy",
      "preview page",
      "preview revoke",
      "status",
    ]
  ) {
    await testContext.test(verb, async () => {
      const verbStdout = sink();
      assert.equal(
        await runCli({ arguments_: [...verb.split(" "), "--help"], stdout: verbStdout, stderr: sink() }),
        0,
      );
      assert.match(verbStdout.read(), new RegExp(`^Usage: taproot-site \\[--config <path>\\] ${verb}`, "u"));
      assert.match(verbStdout.read(), /TAPROOT_SITE_KEY/u);
      if (verb === "preview page") {
        assert.match(
          verbStdout.read(),
          /^Usage: taproot-site \[--config <path>\] preview page <page-path-or-id>/u,
        );
        assert.match(verbStdout.read(), /--json/u);
        // A reused preview URL answers Not found; help must say the handoff is
        // spent, not that the preview is broken (TR00635).
        assert.match(verbStdout.read(), /handoff URL in the result is single-use/u);
        assert.match(verbStdout.read(), /reused, shared, or bookmarked preview URL answers Not found/u);
      }
      if (verb === "pages push") {
        assert.match(verbStdout.read(), /system 404 projection written by pull is read-only/u);
        assert.match(verbStdout.read(), /changed, missing, or replacement source is refused before any page mutation/u);
        assert.match(verbStdout.read(), /taproot-site help page free-form/u);
      }
      if (verb === "preview revoke") {
        assert.match(
          verbStdout.read(),
          /^Usage: taproot-site \[--config <path>\] preview revoke <page-id> <snapshot-id>/u,
        );
        assert.match(verbStdout.read(), /--json/u);
      }
    });
  }
  for (
    const arguments_ of [
      ["--version"],
      ["help", "--version"],
      ["validate", "--version"],
      ["pull", "--version"],
      ["media", "upload", "--version"],
    ]
  ) {
    const versionStdout = sink();
    assert.equal(await runCli({ arguments_, stdout: versionStdout, stderr: sink() }), 0);
    assert.equal(versionStdout.read(), "0.1.1\n");
  }
});

test("serves page and component reference help without configuration, credentials, handlers, or network", async (context) => {
  const cases = [
    { arguments_: ["help"], match: /^Usage: taproot-site help/u },
    { arguments_: ["help", "--help"], match: /^Usage: taproot-site help/u },
    { arguments_: ["help", "pages"], match: /^Authorable page types:/u },
    {
      arguments_: ["help", "page", "free-form"],
      match: /^Free-form page \(free-form\)/u,
      contains: [
        "rejected by default",
        "System page projections:",
        "whole-workspace pages push verifies the hash and skips this file",
        "Do not delete, replace, or edit this file",
        "tracked .pm.json document only",
        "taproot-site pages push --allow-raw-html",
        "For .md, Inline HTML remains unsupported and is rejected even when --allow-raw-html is present",
        "Semantic tables:",
        "Table: Drop-in rates",
        "content.markdown_table_alignment",
        "Section photo background (closed object):",
        "Scrim opacity mapping:",
        "Inline facts:",
        "```inline-facts",
        "tel: remains a native link",
      ],
    },
    { arguments_: ["help", "components"], match: /^Free-form components:/u },
    {
      arguments_: ["help", "nav"],
      match: /^Navigation workspace contract/u,
      contains: ["NAV_ITEM_KIND_PAGE", "resourceId", "author-minted"],
    },
    {
      arguments_: ["help", "media"],
      match: /^Media upload contract/u,
      contains: ["workspace root", "logo@2x.png", "imageId", "src", "urls"],
    },
    {
      arguments_: ["help", "preview"],
      match: /^Authoring preview workflow/u,
      contains: [
        "snapshotId",
        "preview revoke",
        "page path",
        "default stored-preview cap is 10",
        "storedPreviewCount",
        "evictedPreviews",
      ],
    },
    {
      arguments_: ["help", "component", "hero-section"],
      match: /^Hero Section \(hero-section\)/u,
      contains: [
        "Unlisted properties are rejected at every object level",
        "componentData maximum: 262144 UTF-8 bytes",
        "titleSize",
        "primaryAction.url",
        "string (safe-url); required",
        "mediaPosition",
        "when omitted \"after\"",
        "```component:hero-section",
      ],
    },
    {
      arguments_: ["help", "component", "testimonial"],
      match: /^Testimonials \(testimonial\)/u,
      contains: ["interval", "minimum 2000", "items[].authorImage.imageId", "required"],
    },
    {
      arguments_: ["help", "component", "image-banner"],
      match: /^Image Banner \(image-banner\)/u,
      contains: ["maximum length 64", "pattern", "image.imageId", "required"],
    },
    {
      arguments_: ["help", "theme"],
      match: /^Espalier 4\.6\.0 complete site-theme contract/u,
      contains: ["Design workflow", "brand-color-model", "semantic-engine", "Valid complete pair"],
    },
    {
      arguments_: ["help", "appearance"],
      match: /^Site appearance workspace and theme-push contract/u,
      contains: [
        "lightLogoId",
        "darkLogoId",
        "no separate compact-logo",
        "tokens --esp-color-headings",
        "chroma 0..0.25",
        "Mutation order (non-atomic)",
        "Footer content guard",
        "theme.unpushed_footer_content",
      ],
    },
    {
      arguments_: ["help", "footer"],
      match: /^Complete footer workspace and save contract/u,
      contains: [
        "footer push",
        "unlisted fields rejected",
        "tokens --esp-color-background",
        "hue 0..360",
        "footer.concurrent_modification",
        "theme.unpushed_footer_content",
        "featureImage",
      ],
    },
  ];
  for (const scenario of cases) {
    await context.test(scenario.arguments_.join(" "), async () => {
      const stdout = sink();
      const exitCode = await runCli({
        arguments_: scenario.arguments_,
        environment: { GITHUB_OUTPUT: "/path/that/must/not/be-opened" },
        cwd: "/path/that/must/not/be-read",
        stdout,
        stderr: sink(),
        handlers: new Proxy({}, {
          get: () => {
            throw new Error("reference help must not resolve a handler");
          },
        }),
        fetch: () => {
          throw new Error("reference help must not make a request");
        },
      });
      assert.equal(exitCode, 0);
      assert.match(stdout.read(), scenario.match);
      for (const text of scenario.contains ?? []) assert.ok(stdout.read().includes(text), `missing '${text}'`);
    });
  }
});

test("emits versioned machine-readable reference topics", async (context) => {
  const cases = [
    { arguments_: ["help", "--json"], topic: "topics", field: "topics" },
    { arguments_: ["help", "pages", "--json"], topic: "page-types", field: "pageTypes" },
    { arguments_: ["help", "page", "free-form", "--json"], topic: "page", field: "page" },
    { arguments_: ["help", "components", "--json"], topic: "component-types", field: "components" },
    { arguments_: ["help", "component", "image-banner", "--json"], topic: "component", field: "component" },
    { arguments_: ["help", "nav", "--json"], topic: "workflow", field: "reference" },
    { arguments_: ["help", "media", "--json"], topic: "workflow", field: "reference" },
    { arguments_: ["help", "preview", "--json"], topic: "workflow", field: "reference" },
    { arguments_: ["help", "theme", "--json"], topic: "presentation", field: "reference" },
    { arguments_: ["help", "appearance", "--json"], topic: "presentation", field: "reference" },
    { arguments_: ["help", "footer", "--json"], topic: "presentation", field: "reference" },
  ];
  for (const scenario of cases) {
    await context.test(scenario.topic, async () => {
      const stdout = sink();
      assert.equal(await runCli({ arguments_: scenario.arguments_, environment: {}, stdout, stderr: sink() }), 0);
      const result = JSON.parse(stdout.read());
      assert.deepEqual(
        {
          schemaVersion: result.schemaVersion,
          ok: result.ok,
          cli: result.cli,
          verb: result.verb,
          referenceVersion: result.referenceVersion,
          topic: result.topic,
        },
        {
          schemaVersion: 1,
          ok: true,
          cli: { name: "@taprootio/site-authoring", version: "0.1.1" },
          verb: "help",
          referenceVersion: 15,
          topic: scenario.topic,
        },
      );
      assert.ok(result[scenario.field]);
    });
  }
});

test("preview reference documents the homepage spelling in human and JSON forms", async () => {
  const homepageDetail = "The homepage's manifest path is empty; address it as '/', which resolves to that empty root path.";

  const humanOut = sink();
  assert.equal(await runCli({ arguments_: ["help", "preview"], environment: {}, stdout: humanOut, stderr: sink() }), 0);
  assert.ok(humanOut.read().includes(homepageDetail));

  const jsonOut = sink();
  assert.equal(
    await runCli({ arguments_: ["help", "preview", "--json"], environment: {}, stdout: jsonOut, stderr: sink() }),
    0,
  );
  const result = JSON.parse(jsonOut.read());
  assert.ok(result.reference.details.includes(homepageDetail));

  const verbHelpOut = sink();
  assert.equal(
    await runCli({ arguments_: ["preview", "page", "--help"], environment: {}, stdout: verbHelpOut, stderr: sink() }),
    0,
  );
  assert.ok(verbHelpOut.read().includes("The homepage is recorded with an empty path, so address it as '/'."));
});

test("reference help reports stable usage errors with valid alternatives", async (context) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "taproot-site-reference-output-"));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const outputPath = path.join(temporaryDirectory, "github-output");
  await writeFile(outputPath, "");
  const cases = [
    {
      arguments_: ["help", "widgets", "--json"],
      code: "help.topic_unknown",
      alternatives: [
        "pages",
        "page",
        "components",
        "component",
        "nav",
        "media",
        "preview",
        "theme",
        "appearance",
        "footer",
      ],
    },
    {
      arguments_: ["help", "page", "article", "--json"],
      code: "help.page_type_unknown",
      alternatives: ["free-form"],
    },
    {
      arguments_: ["help", "component", "carousel", "--json"],
      code: "help.component_type_unknown",
      alternatives: [
        "hero-section",
        "cta",
        "testimonial",
        "feature-grid",
        "spacer",
        "latest-posts",
        "card-grid",
        "image-banner",
      ],
    },
  ];
  for (const scenario of cases) {
    await context.test(scenario.code, async () => {
      const stdout = sink();
      const stderr = sink();
      const exitCode = await runCli({
        arguments_: scenario.arguments_,
        environment: { GITHUB_OUTPUT: outputPath },
        stdout,
        stderr,
      });
      assert.equal(exitCode, 2);
      assert.deepEqual(JSON.parse(stdout.read()).error, {
        code: scenario.code,
        alternatives: scenario.alternatives,
      });
      for (const alternative of scenario.alternatives) assert.match(stderr.read(), new RegExp(alternative, "u"));
      assert.equal(await readFile(outputPath, "utf8"), "");
    });
  }
});

test("reference help rejects malformed topic shapes with help.usage", async (context) => {
  for (
    const arguments_ of [
      ["help", "page"],
      ["help", "component"],
      ["help", "pages", "free-form"],
      ["help", "components", "hero-section"],
      ["help", "footer", "extra"],
      ["help", "components", "--json", "--json"],
      ["help", "components", "--quiet"],
    ]
  ) {
    await context.test(arguments_.join(" "), async () => {
      const stdout = sink();
      assert.equal(await runCli({ arguments_, environment: {}, stdout, stderr: sink() }), 2);
      assert.equal(JSON.parse(stdout.read()).error.code, "help.usage");
    });
  }
});

test("config-prefixed reference help faults never write GITHUB_OUTPUT", async (context) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "taproot-site-help-output-"));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const outputPath = path.join(temporaryDirectory, "github-output");
  const initialOutput = "caller-owned-output\n";
  await writeFile(outputPath, initialOutput);
  const stdout = sink();

  const exitCode = await runCli({
    arguments_: ["--config", "site.json", "help", "pages"],
    environment: { GITHUB_OUTPUT: outputPath },
    stdout,
    stderr: sink(),
  });

  assert.equal(exitCode, 2);
  assert.deepEqual(JSON.parse(stdout.read()).error, {
    code: "cli.config_option",
    field: "configPath",
  });
  assert.equal(await readFile(outputPath, "utf8"), initialOutput);
});

test("--quiet suppresses progress and nothing else", async () => {
  for (const quiet of [false, true]) {
    const stdout = sink();
    const stderr = sink();
    const exitCode = await runCli({
      arguments_: quiet ? ["status", "--quiet"] : ["status"],
      environment: {},
      stdout,
      stderr,
      handlers: {
        status: async (invocation) => {
          invocation.onProgress("Reading deployments.");
          return successResult("status");
        },
      },
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(stdout.read()), successResult("status"));
    assert.equal(stderr.read(), quiet ? "" : "Reading deployments.\n");
  }
});

test("emits one JSON result and collision-safe GitHub Actions outputs", async (testContext) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "taproot-site-output-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const outputPath = path.join(temporaryDirectory, "github-output");
  await writeFile(outputPath, "");
  const stdout = sink();
  const exitCode = await runCli({
    arguments_: ["pull", "--quiet"],
    environment: { GITHUB_OUTPUT: outputPath, TAPROOT_SITE_KEY: "never-emitted" },
    stdout,
    stderr: sink(),
    handlers: { pull: async () => successResult("pull") },
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(stdout.read()), successResult("pull"));
  const githubOutput = await readFile(outputPath, "utf8");
  assert.match(githubOutput, /^taproot_site_result<<taproot_site_[0-9a-f]{32}\n/u);
  assert.match(githubOutput, /\ntaproot_site_verb=pull\n$/u);
  assert.doesNotMatch(`${stdout.read()}${githubOutput}`, /never-emitted/u);
});

test("preserves preview recovery identity when GitHub output fails after minting", async (testContext) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "taproot-site-preview-output-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const stdout = sink();
  const secretUrl = `https://preview.example/_taproot/preview/pages/${PAGE_ID}/${SNAPSHOT_ID}?handoff=secret`;
  const siteId = "22222222-3333-4444-8555-666666666666";
  const expiresAt = "2026-08-24T20:00:00.000Z";
  const exitCode = await runCli({
    arguments_: ["preview", "page", PAGE_ID, "--json"],
    environment: { GITHUB_OUTPUT: path.join(temporaryDirectory, "missing-output") },
    stdout,
    stderr: sink(),
    handlers: {
      "preview page": async () => ({
        ...successResult("preview page"),
        siteId,
        pageId: PAGE_ID,
        snapshotId: SNAPSHOT_ID,
        expiresAt,
        url: secretUrl,
      }),
    },
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(JSON.parse(stdout.read()).error, {
    code: "output.github_missing",
    preview: { siteId, pageId: PAGE_ID, snapshotId: SNAPSHOT_ID, expiresAt },
  });
  assert.equal(stdout.read().includes(secretUrl), false);
});

test("unexpected failures redact tokens, capability URLs, and workspace contents", async () => {
  const secrets = [
    "tr_live_site_authoring_secret",
    "https://objects.example/upload?signature=secret",
    "private page body contents",
    "unrelated-environment-secret",
  ];
  const stdout = sink();
  const stderr = sink();
  const exitCode = await runCli({
    arguments_: ["pages", "push"],
    environment: {
      TAPROOT_SITE_KEY: secrets[0],
      UNRELATED_SECRET: secrets[3],
    },
    stdout,
    stderr,
    handlers: {
      "pages push": async () => {
        throw new Error(secrets.join(" "));
      },
    },
  });
  assert.equal(exitCode, 1);
  assert.equal(JSON.parse(stdout.read()).error.code, "site.failed");
  for (const secret of secrets) {
    assert.doesNotMatch(
      `${stdout.read()}${stderr.read()}`,
      new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );
  }
});

test("strips terminal controls from stable fields and human diagnostics", async () => {
  const stdout = sink();
  const stderr = sink();
  const exitCode = await runCli({
    arguments_: ["approve"],
    environment: {},
    stdout,
    stderr,
    handlers: {
      approve: async () => {
        throw new SiteAuthoringError("api.request_rejected", "invalid\nsecond-line", { field: "Path\rspoof" });
      },
    },
  });
  assert.equal(exitCode, 1);
  assert.deepEqual(JSON.parse(stdout.read()).error, { code: "api.request_rejected", field: "Pathspoof" });
  assert.equal(
    stderr.read(),
    "taproot-site failed [api.request_rejected] field=Pathspoof: invalidsecond-line\n",
  );
  assert.doesNotMatch(stderr.read().slice(0, -1), /[\r\n]/u);
});

test("refuses a verb result that is not a serializable result object", async () => {
  const stdout = sink();
  const exitCode = await runCli({
    arguments_: ["status"],
    environment: {},
    stdout,
    stderr: sink(),
    handlers: { status: async () => undefined },
  });
  assert.equal(exitCode, 1);
  assert.equal(JSON.parse(stdout.read()).error.code, "output.result_invalid");
});
