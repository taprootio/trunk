import {
  CLI_BINARY_NAME,
  CLI_NAME,
  CLI_VERSION,
  DEFAULT_LOGIN_KEY_NAME,
  DEPLOY_TARGET_PRODUCTION,
  DEPLOY_TARGET_STAGING,
  LIMITS,
  LOGIN_KEY_NAME_MAXIMUM,
  PUBLISH_KEY_ENVIRONMENT_VARIABLE,
  RESULT_SCHEMA_VERSION,
  VERB_APPROVE,
  VERB_DEPLOY,
  VERB_ENV,
  VERB_FOOTER_PUSH,
  VERB_HELP,
  VERB_LOGIN,
  VERB_LOGOUT,
  VERB_MEDIA_UPLOAD,
  VERB_NAV_PUSH,
  VERB_PAGES_PUSH,
  VERB_PREVIEW_PAGE,
  VERB_PREVIEW_REVOKE,
  VERB_PULL,
  VERB_SITES,
  VERB_STATUS,
  VERB_THEME_PUSH,
  VERB_USE,
  VERB_VALIDATE,
  VERB_WHOAMI,
} from "./constants.js";
import {
  asSiteAuthoringError,
  hasAsciiControl,
  isCanonicalUuid,
  normalizePreviewRecovery,
  SiteAuthoringError,
} from "./errors.js";
import { failureResult, humanFailure, serializeResult, writeGithubActionsOutput } from "./output.js";
import {
  formatReferenceResult,
  getAppearanceReference,
  getComponentReference,
  getFooterReference,
  getPageTypeReference,
  getThemeReference,
  getWorkflowReference,
  listComponentTypeReferences,
  listPageTypeReferences,
  PAGE_TYPES,
  REFERENCE_TOPICS,
  REFERENCE_VERSION,
} from "./reference-help.js";
import {
  CAPABILITY_CONTENT,
  CAPABILITY_DEPLOYMENTS,
  CAPABILITY_DESIGN,
} from "./capabilities.js";
import { VERB_HANDLERS } from "./verbs/index.js";

// One entry per verb, in help order. `tokens` is the exact leading positional
// sequence; matching prefers the longest sequence, so a two-token family can
// never be shadowed by a one-token verb.
const VERBS = Object.freeze([
  {
    name: VERB_HELP,
    tokens: ["help"],
    summary: "Show offline authoring reference help for agents.",
  },
  {
    name: VERB_VALIDATE,
    tokens: ["validate"],
    summary: "Validate a complete authoring fixture without credentials or mutation.",
    positionals: "fixturePath",
    offline: true,
    note: "Reads manifest.fixture.json plus the fixture's page, navigation, theme, appearance, header, brand, and footer files. "
      + "This proves local structure and semantics only. It does not prove authorization, live site ownership, concurrency, "
      + "persisted round trips, or rendering; run a real pull and authorized preview before deployment.",
  },
  {
    name: VERB_LOGIN,
    tokens: ["login"],
    summary: "Authorize this CLI against a Taproot account through a browser approval.",
    credentialFree: true,
    configFree: true,
    keyName: true,
    note: "Starts a device-authorization exchange, prints the approval URL and an eight-character code, and waits for "
      + "an owner to enter that code and approve in a browser they are already signed in to. Typing the code — rather "
      + "than following a prefilled link — is what proves the approver can see this terminal. "
      + "It needs no site and no taproot-site.json: what it authorizes is the account, so it works in any directory "
      + "immediately after install. Choose a site afterwards with 'sites' and 'use'. "
      + "The approval URL is composed from the reviewed API origin and is never taken from a response. "
      + "The issued sign-in is written to credentials.json under $XDG_CONFIG_HOME/taproot-site/ (falling back to "
      + "~/.config/taproot-site/), directory 0700 and file 0600, one per API origin, replacing any sign-in already "
      + "stored for that origin. The secret itself is never displayed, logged, or placed in the JSON result: the "
      + "result names the credential by id and display prefix only. "
      + "The sign-in authorizes nothing on any site — it lists the account's sites and exchanges itself for "
      + "short-lived site credentials. It expires after 24 hours without a successful exchange, and any "
      + "expiry the approver chose bounds that: using the CLI keeps it alive, but never past their date. "
      + `${PUBLISH_KEY_ENVIRONMENT_VARIABLE} always takes precedence over the stored sign-in and skips the exchange `
      + "entirely, so existing automation is unaffected by logging in. "
      + "--quiet is rejected for this verb: the approval URL and code reach the operator only as progress, before "
      + "any JSON result exists, so silencing them would make the approval impossible to complete. "
      + "A denied, expired, or timed-out approval stores nothing. If Taproot reports the authorization was already "
      + "claimed, a credential was issued that this command never received: revoke it under Account -> Settings -> "
      + "API keys.",
  },
  {
    name: VERB_LOGOUT,
    tokens: ["logout"],
    summary: "Discard the stored Taproot sign-in.",
    credentialFree: true,
    configFree: true,
    note: "Removes the stored sign-in for this API origin and reports whether one was there. This is a local discard "
      + "only: it does not revoke anything, and the credential stays valid until an owner revokes it under "
      + "Account -> Settings -> API keys. Logging out with nothing stored is a success.",
  },
  {
    name: VERB_SITES,
    tokens: ["sites"],
    summary: "List the sites this sign-in may author.",
    configFree: true,
    note: "Runs on the stored sign-in rather than a site credential, and is one of exactly two things that credential "
      + "can do. The list is already filtered to sites an exchange would accept, so anything shown here is a site "
      + "'use' can select and the next command can author.",
  },
  {
    name: VERB_USE,
    tokens: ["use"],
    summary: "Choose the site the next command writes to.",
    configFree: true,
    positionals: "siteSelector",
    note: "Accepts a site id, an exact name, or an unambiguous case-insensitive name, and records the choice as "
      + "siteId in taproot-site.json — creating that file in the current directory when there is not one yet. "
      + "Two sites sharing a name is refused rather than guessed: pass the site id instead.",
  },
  {
    name: VERB_WHOAMI,
    tokens: ["whoami"],
    summary: "Report the Taproot, account, site, and sign-in expiry in effect.",
    credentialFree: true,
    configFree: true,
    offline: true,
    // Offline but not self-contained: it reads both the store and the
    // configuration, so it accepts --config and must not claim otherwise.
    readsLocalState: true,
    note: "Answers entirely from local state — the stored sign-in and the configuration — so it still works when the "
      + `network or the credential does not. Reports whether ${PUBLISH_KEY_ENVIRONMENT_VARIABLE} is set, but never `
      + "its value. The sign-in secret is never printed; the credential is named by id and display prefix, which are "
      + "what an owner needs to revoke it.",
  },
  {
    name: VERB_ENV,
    tokens: ["env"],
    summary: "Show or switch which Taproot the CLI talks to.",
    credentialFree: true,
    configFree: true,
    offline: true,
    // Offline, but it reads the stored endpoint and the credential store to
    // report whether you are signed in where you just switched to.
    readsLocalState: true,
    positionals: "environmentSelector",
    note: "With no argument it reports the current Taproot and whether this machine is signed in to it; with "
      + "'production' or 'local' it switches. The choice is remembered per machine, beside the credential, because "
      + "it has to be known before any taproot-site.json exists — 'login', 'sites', and 'use' all run before the "
      + "file 'use' writes. Sign-ins are stored per origin, so switching away and back finds the one that was "
      + "already there. An explicit loopback URL ending in '/api' is accepted for development; nothing else is.",
  },
  {
    name: VERB_PULL,
    // Pages and the four settings groups, and every one of those gates on
    // site.theme.manage — so a read-only snapshot still needs Design.
    capabilities: [CAPABILITY_CONTENT, CAPABILITY_DESIGN],
    tokens: ["pull"],
    summary: "Snapshot pages, navigation, and settings into the local workspace.",
    note: "Every page path keeps exactly one authoritative source. A page whose manifest entry names a source that is "
      + "still on disk keeps that file, so pull never writes a '.pm.json' beside a tracked '.md'. "
      + "For a page tracked as Markdown the site's own document is kept as internal state under "
      + "'.taproot-site-state/' instead; it is never a page source and is never pushed. "
      + "To change a page's source format, remove the tracked source and author the other format beside it — two "
      + "editable sources for one path is a refusal, not a guess. "
      + "Markdown is deliberately one-way, so a page edited on the site since the last pull cannot be rewritten as "
      + "Markdown: pull refuses with pages.pull_conflict before changing anything under 'pages/', preserves the "
      + "site's version under '.taproot-site-state/', and leaves you to either push the local source or delete it "
      + "and pull again. A locally edited '.pm.json' is kept rather than overwritten for the same reason.",
  },
  {
    name: VERB_PAGES_PUSH,
    capabilities: [CAPABILITY_CONTENT],
    tokens: ["pages", "push"],
    summary: "Create and update pages from the local workspace.",
    positionals: "pagePaths",
    allowRawHtml: true,
    note: "Positional page paths narrow the push to those pages; with none, every workspace page is validated and sent. "
      + "The homepage is recorded with an empty path, so address it as '/'. "
      + "A selected path resolves to its one authoritative source from metadata alone, and that page is then validated "
      + "exactly as a whole push would validate it — site binding, manifest integrity, live create-or-update "
      + "resolution, system-page rules, path uniqueness against the live site, media ownership, and two workspace "
      + "files claiming one path all still fail closed. What a selection does not do is convert or validate the "
      + "documents of pages it is not sending: an unrelated page left on an obsolete contract is reported by the "
      + "whole-workspace push, not used to block this one. The result states the selection and how many sources were "
      + "discovered and validated. "
      + "The system 404 projection written by pull is read-only: an unchanged whole-workspace push verifies and skips it, "
      + "while a changed, missing, or replacement source is refused before any page mutation, and naming it in a "
      + "selection is refused outright. "
      + "See 'taproot-site help page free-form' for the stable manifest and error contract. "
      + "--allow-raw-html permits rawHtml nodes, which render verbatim and"
      + " unsanitized on the published site. Off by default on purpose; leave"
      + " it off unless the content is trusted hand-written markup.",
  },
  {
    name: VERB_NAV_PUSH,
    capabilities: [CAPABILITY_DESIGN],
    tokens: ["nav", "push"],
    summary: "Replace the whole navigation tree from the local workspace.",
  },
  {
    name: VERB_THEME_PUSH,
    capabilities: [CAPABILITY_DESIGN],
    tokens: ["theme", "push"],
    summary: "Validate and push the workspace's complete theme and appearance settings.",
    note: "Run pull first. Theme JSON stays decoded in the workspace; this command validates the complete light/dark"
      + " pair and encodes it only at the API boundary. Image settings reference site-owned image IDs from media upload.",
  },
  {
    name: VERB_FOOTER_PUSH,
    capabilities: [CAPABILITY_DESIGN],
    tokens: ["footer", "push"],
    summary: "Validate and replace the workspace's complete footer document.",
    note: "Run pull first. The command validates the whole closed footer locally, uses the pulled draft hash,"
      + " and refuses a concurrent remote edit with re-pull guidance.",
  },
  {
    name: VERB_MEDIA_UPLOAD,
    capabilities: [CAPABILITY_CONTENT],
    tokens: ["media", "upload"],
    summary: "Upload media and wait for processing to finish.",
    positionals: "paths",
    note: "Positional arguments name the files or directories to upload;"
      + " with none, the workspace's media/ directory is walked.",
  },
  {
    name: VERB_APPROVE,
    capabilities: [CAPABILITY_CONTENT],
    tokens: ["approve"],
    summary: "Publish drafts. This stages the site; it does not deploy it.",
    positionals: "pagePaths",
    note: "Positional arguments narrow the selection to those page paths;"
      + " with none, every draft the workspace manifest tracks is staged."
      + " The homepage is recorded with an empty path, so address it as '/'.",
  },
  {
    name: VERB_DEPLOY,
    capabilities: [CAPABILITY_DEPLOYMENTS],
    tokens: ["deploy"],
    summary: "Deploy to staging, or promote staging to production.",
    target: true,
  },
  {
    name: VERB_PREVIEW_PAGE,
    capabilities: [CAPABILITY_CONTENT],
    tokens: ["preview", "page"],
    summary: "Render one persisted draft and mint a short-lived staging handoff.",
    positionals: "pageSelector",
    json: true,
    note: "Select the persisted draft by page path (as recorded by pull) or canonical lowercase UUID. "
      + "The homepage is recorded with an empty path, so address it as '/'. "
      + "The handoff URL in the result is single-use and expires two minutes after it is minted: opening it "
      + "consumes it, and a reused, shared, or bookmarked preview URL answers Not found. Run preview page again "
      + "for another. "
      + "--json is accepted"
      + " explicitly for agent invocations, though every operational success and failure is already JSON.",
  },
  {
    name: VERB_PREVIEW_REVOKE,
    capabilities: [CAPABILITY_CONTENT],
    tokens: ["preview", "revoke"],
    summary: "Revoke an active authoring preview and schedule its artifacts for cleanup.",
    positionals: "previewIds",
    json: true,
    note: "Supply the canonical lowercase page UUID followed by the snapshot UUID returned by preview page.",
  },
  {
    name: VERB_STATUS,
    // Readiness and the deployment log are Deployments; the image list is
    // Content.
    capabilities: [CAPABILITY_CONTENT, CAPABILITY_DEPLOYMENTS],
    tokens: ["status"],
    summary: "Report deployments, readiness, and image processing.",
    note: "Broken references are not included: that read remains"
      + " session-only on the server, so the result reports it as uncovered"
      + " rather than pretending an empty list means a clean site.",
  },
]);

const COMMON_OPTIONS = `Options:
  --config <path>  Place before a config-reading verb; bypass parent discovery.
  --quiet          Suppress human progress. The JSON result is unchanged.
  --help           Show this help.
  --version        Show the package version.`;

const HELP = `Usage: ${CLI_BINARY_NAME} [--config <path>] <verb> [options]

Authoring verbs drive one Taproot site through the authoring surface. Start with
login, then sites and use to choose which site those verbs write to. Commands
talk to production unless 'env local' says otherwise; that choice is remembered
per machine, not per project.

The site credential is taken from ${PUBLISH_KEY_ENVIRONMENT_VARIABLE} when it is
set; otherwise it is minted for each run by exchanging the account sign-in that
login stores outside the repository. There is no flag for either. The sign-in
authorizes nothing on any site: it lists sites and buys short-lived site
credentials, and it expires 24 hours after it is issued.

Verbs write one JSON result to stdout and human progress to stderr. validate,
help, whoami, and env are offline and read-only. login, logout, sites, use,
whoami, and env need no configuration and no site. The offline help family is
human-readable by default; add --json for stable reference data. Exit codes: 0
success, 1 failure, 2 usage fault.

Verbs:
${VERBS.map((verb) => `  ${verb.tokens.join(" ").padEnd(14)} ${verb.summary}`).join("\n")}

Configuration:
  Site verbs read taproot-site.json, found by walking up from the current
  directory through a bounded number of parents. Exactly one must be found, or
  pass --config <path> before the verb. It is a closed JSON object:
    configVersion  must be 1
    siteId         optional; the canonical lowercase site UUID that 'use' writes
    workspaceDir   a relative POSIX path beneath the configuration directory
                   that pull writes into; every existing segment must be a real
                   directory
  Unknown or duplicate fields are refused. apiBaseUrl is not a field: which
  Taproot to talk to is machine state, set with 'env' and limited to
  app.taproot.io (the default), app.taproot.test, or an explicit loopback URL
  ending in /api. Sign-ins are stored per origin.

${COMMON_OPTIONS}
`;

function verbHelp(verb) {
  const targetUsage = verb.target ? " (--staging | --production)" : "";
  const positionalUsage = verb.positionals === "fixturePath"
    ? " <fixture-directory>"
    : verb.positionals === "pageSelector"
    ? " <page-path-or-id>"
    : verb.positionals === "previewIds"
    ? " <page-id> <snapshot-id>"
    : verb.positionals === "environmentSelector"
    ? " [production | local | <url>]"
    : verb.positionals
    ? ` [${verb.positionals === "paths" ? "path" : "page-path"}...]`
    : "";
  const targetOption = verb.target
    ? `\n  --staging        Deploy the staged site to staging.
  --production     Promote the completed staging deployment to production.`
    : "";
  const rawHtmlOption = verb.allowRawHtml
    ? "\n  --allow-raw-html Permit rawHtml nodes. They render verbatim and unsanitized."
    : "";
  const jsonOption = verb.json
    ? "\n  --json           Emit the stable JSON contract (operational output is always JSON)."
    : "";
  const nameOption = verb.keyName
    ? `\n  --name <text>    Name recorded on the issued key (default "${DEFAULT_LOGIN_KEY_NAME}",\n`
      + `                   1-${LOGIN_KEY_NAME_MAXIMUM} characters). The approval screen shows it.`
    : "";
  const note = verb.note ? `\n\n${verb.note}` : "";
  // `offline` means "makes no network request", and until TR00645 it also
  // implied "reads no configuration or credential". whoami is the first verb
  // where those diverge — offline, but it reads both — so `readsLocalState` is
  // the opt-out rather than a second positive flag every existing offline verb
  // would have had to gain.
  const selfContained = verb.offline && !verb.readsLocalState;
  const prefix = selfContained ? CLI_BINARY_NAME : `${CLI_BINARY_NAME} [--config <path>]`;
  const boundary = selfContained
    ? "This offline verb reads no configuration or credential and performs no network request or write."
    : verb.offline
    ? "This verb answers entirely from local state — the stored sign-in and the configuration — and makes no "
      + "network request and no write."
    : verb.credentialFree
    ? `This verb reads the configuration but requires no existing credential. `
      + `${PUBLISH_KEY_ENVIRONMENT_VARIABLE} always takes precedence over the stored credential, so setting it leaves `
      + `existing automation unaffected by login and logout.`
    : `The site-scoped credential is taken from ${PUBLISH_KEY_ENVIRONMENT_VARIABLE} when it is set, and otherwise `
      + `from the credential '${CLI_BINARY_NAME} ${VERB_LOGIN}' stores outside the repository.`;
  const options = selfContained
    ? `Options:
  --quiet          Suppress human progress. The JSON result is unchanged.
  --help           Show this help.
  --version        Show the package version.`
    : verb.name === VERB_LOGIN
    // Login's option block must not advertise --quiet: the verb rejects it
    // (the approval URL exists only as progress), and an Options list that
    // contradicts the note two paragraphs below it is worse than either alone.
    ? `Options:
  --config <path>  Place before the verb; bypass parent discovery.
  --help           Show this help.
  --version        Show the package version.`
    : COMMON_OPTIONS;
  return `Usage: ${prefix} ${verb.tokens.join(" ")}${positionalUsage}${targetUsage} [options]

${verb.summary}
${boundary}

${options}${targetOption}${rawHtmlOption}${jsonOption}${nameOption}${note}
`;
}

function matchVerb(arguments_) {
  let matched;
  for (const verb of VERBS) {
    if (
      verb.tokens.every((token, index) => arguments_[index] === token)
      && (matched === undefined || verb.tokens.length > matched.tokens.length)
    ) {
      matched = verb;
    }
  }
  return matched;
}

function usageError(code, message, options = {}) {
  return new SiteAuthoringError(code, message, { ...options, exitCode: 2 });
}

function parseReferenceArguments(arguments_) {
  if (arguments_.length === 1 && arguments_[0] === "--version") return { mode: "version" };
  if (arguments_.length === 1 && arguments_[0] === "--help") {
    return { mode: "reference", topic: "topics", json: false };
  }

  let json = false;
  const terms = [];
  for (const argument of arguments_) {
    if (argument === "--json") {
      if (json) throw usageError("help.usage", "--json may be supplied only once.");
      json = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw usageError("help.usage", "Reference help accepts only --json after its topic.");
    }
    terms.push(argument);
  }

  if (terms.length === 0) return { mode: "reference", topic: "topics", json };
  const [topic, subject, ...extra] = terms;
  const topicNames = REFERENCE_TOPICS.map((entry) => entry.name);
  if (!topicNames.includes(topic)) {
    throw usageError(
      "help.topic_unknown",
      `Unknown reference topic. Expected one of: ${topicNames.join(", ")}.`,
      { alternatives: topicNames },
    );
  }
  if (
    (
      topic === "pages"
      || topic === "components"
      || topic === "nav"
      || topic === "media"
      || topic === "preview"
      || topic === "theme"
      || topic === "appearance"
      || topic === "footer"
    )
    && (subject !== undefined || extra.length > 0)) {
    throw usageError("help.usage", `The '${topic}' topic does not accept a name.`);
  }
  if ((topic === "page" || topic === "component") && (subject === undefined || extra.length > 0)) {
    throw usageError("help.usage", `The '${topic}' topic requires exactly one name.`);
  }
  return { mode: "reference", topic, subject, json };
}

function referenceResult(parsed) {
  const result = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    ok: true,
    cli: { name: CLI_NAME, version: CLI_VERSION },
    verb: VERB_HELP,
    referenceVersion: REFERENCE_VERSION,
  };
  switch (parsed.topic) {
    case "topics":
      return { ...result, topic: "topics", topics: REFERENCE_TOPICS };
    case "pages":
      return { ...result, topic: "page-types", pageTypes: listPageTypeReferences() };
    case "components":
      return { ...result, topic: "component-types", components: listComponentTypeReferences() };
    case "page": {
      const page = getPageTypeReference(parsed.subject);
      if (!page) {
        throw usageError(
          "help.page_type_unknown",
          `Unknown page type. Expected one of: ${PAGE_TYPES.join(", ")}.`,
          { alternatives: PAGE_TYPES },
        );
      }
      return { ...result, topic: "page", page };
    }
    case "component": {
      const component = getComponentReference(parsed.subject);
      if (!component) {
        const alternatives = listComponentTypeReferences().map((entry) => entry.type);
        throw usageError(
          "help.component_type_unknown",
          `Unknown component type. Expected one of: ${alternatives.join(", ")}.`,
          { alternatives },
        );
      }
      return { ...result, topic: "component", component };
    }
    case "nav":
    case "media":
    case "preview":
      return { ...result, topic: "workflow", referenceKind: parsed.topic, reference: getWorkflowReference(parsed.topic) };
    case "theme":
      return { ...result, topic: "presentation", referenceKind: "theme", reference: getThemeReference() };
    case "appearance":
      return { ...result, topic: "presentation", referenceKind: "appearance", reference: getAppearanceReference() };
    case "footer":
      return { ...result, topic: "presentation", referenceKind: "footer", reference: getFooterReference() };
    default:
      throw usageError("help.usage", "The reference-help invocation is incomplete.");
  }
}

function parseConfigOption(arguments_, index) {
  const candidate = arguments_[index + 1];
  if (
    typeof candidate !== "string"
    || candidate.length === 0
    || Buffer.byteLength(candidate, "utf8") > LIMITS.configPathBytes
    || hasAsciiControl(candidate)
    || candidate.startsWith("--")
  ) {
    throw usageError("cli.config_option", "--config requires exactly one path before the operational verb.", {
      field: "configPath",
    });
  }
  return candidate;
}

/**
 * The command-line shape of `--name`, exactly as `parseConfigOption` handles
 * `--config`: presence, bounds, and printability here; the semantic rule
 * (trimmed, 1-100 characters) belongs to the verb, which a programmatic caller
 * reaches without passing through this parser at all.
 */
function parseNameOption(arguments_, index) {
  const candidate = arguments_[index + 1];
  if (
    typeof candidate !== "string"
    || candidate.length === 0
    || Buffer.byteLength(candidate, "utf8") > LIMITS.configPathBytes
    || hasAsciiControl(candidate)
    || candidate.startsWith("--")
  ) {
    throw usageError("cli.name_option", "--name requires exactly one printable key name.", {
      field: "keyName",
    });
  }
  return candidate;
}

function parseArguments(arguments_) {
  if (!Array.isArray(arguments_) || arguments_.some((argument) => typeof argument !== "string")) {
    throw usageError("cli.usage", "The command line must be a list of strings.");
  }
  if (arguments_.length === 1 && arguments_[0] === "--help") return { mode: "help" };
  if (arguments_.length === 1 && arguments_[0] === "--version") return { mode: "version" };

  let configPath;
  let commandArguments = arguments_;
  if (arguments_[0] === "--config") {
    configPath = parseConfigOption(arguments_, 0);
    commandArguments = arguments_.slice(2);
  }

  const verb = matchVerb(commandArguments);
  if (!verb) {
    throw usageError(
      "cli.usage",
      `Expected one of: ${VERBS.map((candidate) => candidate.tokens.join(" ")).join(", ")}.`,
    );
  }
  const rest = commandArguments.slice(verb.tokens.length);
  if (verb.name === VERB_HELP) {
    if (configPath !== undefined) {
      throw usageError("cli.config_option", "--config applies only to operational verbs.", {
        field: "configPath",
      });
    }
    return parseReferenceArguments(rest);
  }
  // `--config` names the configuration a verb reads, so it is refused only by
  // the verbs that read none. login and logout are credential-free but still
  // read a configuration when one is discoverable — it is what names the API
  // origin the sign-in belongs to — so they accept it. whoami is offline and
  // reads both the store and the configuration, so it accepts it too: the test
  // is "reads nothing local", not "makes no request".
  if (verb.offline && !verb.readsLocalState && configPath !== undefined) {
    throw usageError("cli.config_option", "--config applies only to verbs that read the site configuration.", {
      field: "configPath",
    });
  }
  if (rest.length === 1 && rest[0] === "--help") return { mode: "verb_help", verb };
  if (rest.length === 1 && rest[0] === "--version") return { mode: "version" };

  let quiet = false;
  let deployTarget;
  let allowRawHtml = false;
  let json = false;
  let keyName;
  const positionals = [];
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--quiet") {
      if (quiet) throw usageError("cli.duplicate_option", "--quiet may be supplied only once.");
      quiet = true;
      continue;
    }
    if (argument === "--config") {
      throw usageError("cli.config_option", "--config must appear before the operational verb.", {
        field: "configPath",
      });
    }
    if (verb.target && (argument === "--staging" || argument === "--production")) {
      const candidate = argument === "--staging" ? DEPLOY_TARGET_STAGING : DEPLOY_TARGET_PRODUCTION;
      if (deployTarget === candidate) {
        throw usageError("cli.duplicate_option", `${argument} may be supplied only once.`);
      }
      if (deployTarget !== undefined) {
        throw usageError(
          "cli.deploy_target",
          "deploy accepts exactly one of --staging or --production.",
        );
      }
      deployTarget = candidate;
      continue;
    }
    if (verb.allowRawHtml && argument === "--allow-raw-html") {
      if (allowRawHtml) {
        throw usageError("cli.duplicate_option", "--allow-raw-html may be supplied only once.");
      }
      allowRawHtml = true;
      continue;
    }
    if (verb.json && argument === "--json") {
      if (json) throw usageError("cli.duplicate_option", "--json may be supplied only once.");
      json = true;
      continue;
    }
    if (verb.keyName && argument === "--name") {
      if (keyName !== undefined) throw usageError("cli.duplicate_option", "--name may be supplied only once.");
      keyName = parseNameOption(rest, index);
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw usageError("cli.unknown_option", "The command contains an unknown option.");
    }
    if (verb.positionals) {
      if (
        argument.length === 0
        || Buffer.byteLength(argument, "utf8") > LIMITS.configPathBytes
        || hasAsciiControl(argument)
      ) {
        throw usageError("cli.unexpected_argument", "A positional argument is empty, oversized, or unprintable.");
      }
      if (positionals.length >= 100) {
        throw usageError("cli.unexpected_argument", "Too many positional arguments; supply at most 100.");
      }
      positionals.push(argument);
      continue;
    }
    throw usageError("cli.unexpected_argument", "The command contains an unexpected argument.");
  }
  if (verb.target && deployTarget === undefined) {
    throw usageError("cli.deploy_target", "deploy requires exactly one of --staging or --production.");
  }
  if (
    verb.positionals === "fixturePath"
    && positionals.length !== 1
  ) {
    throw usageError(
      "validate.fixture_path_invalid",
      "validate requires exactly one fixture directory.",
      { field: "fixturePath" },
    );
  }
  if (
    verb.positionals === "pageSelector"
    && (
      positionals.length !== 1
      || (!isCanonicalUuid(positionals[0]) && isCanonicalUuid(positionals[0].toLowerCase()))
    )
  ) {
    throw usageError(
      "preview.page_selector_invalid",
      "preview page requires exactly one page path or canonical lowercase page UUID.",
      { field: "pageSelector" },
    );
  }
  if (
    verb.positionals === "previewIds"
    && (
      positionals.length !== 2
      || !isCanonicalUuid(positionals[0])
      || !isCanonicalUuid(positionals[1])
    )
  ) {
    const field = positionals.length === 2 && !isCanonicalUuid(positionals[0])
      ? "pageId"
      : "snapshotId";
    throw usageError(
      "preview.identity_invalid",
      "preview revoke requires one canonical lowercase page UUID and one canonical lowercase snapshot UUID.",
      { field },
    );
  }
  if (verb.positionals == "siteSelector" && positionals.length !== 1) {
    throw usageError(
      "use.selector_missing",
      "use requires exactly one site name or canonical lowercase site UUID.",
      { field: "selector" },
    );
  }
  if (verb.positionals === "environmentSelector" && positionals.length > 1) {
    throw usageError(
      "env.unexpected_argument",
      "env takes at most one environment: 'production', 'local', or an explicit loopback URL.",
      { field: "environmentSelector" },
    );
  }
  if (quiet && verb.name === VERB_LOGIN) {
    // The approval URL and user code reach the operator only as progress
    // lines, and the JSON result is serialized only after polling ends — so a
    // silenced login is one nobody can ever approve. Refusing up front beats
    // a guaranteed timeout fifteen minutes later.
    throw usageError(
      "cli.quiet_option",
      "--quiet cannot be used with login: the approval URL and code are printed as progress, "
        + "and the JSON result exists only after the approval completes.",
      { field: "quiet" },
    );
  }
  return {
    mode: "run",
    verb: verb.name,
    // The smallest capability set this verb's requests need. It reaches the
    // exchange so a content push never holds deploy, and a pull never holds
    // delete (TR00645).
    capabilities: verb.capabilities,
    configPath,
    quiet,
    deployTarget,
    allowRawHtml,
    keyName,
    positionals: verb.positionals
      ? {
        key: verb.positionals,
        values: positionals,
        scalar: verb.positionals === "pageSelector" || verb.positionals === "fixturePath"
          || verb.positionals === "siteSelector" || verb.positionals === "environmentSelector",
      }
      : undefined,
  };
}

export async function runCli({
  arguments_ = process.argv.slice(2),
  environment = process.env,
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  handlers = VERB_HANDLERS,
  fetch,
  signal,
} = {}) {
  let parsed;
  let completedPreviewRecovery;
  const isReferenceInvocation = Array.isArray(arguments_)
    && (
      arguments_[0] === "help"
      || (arguments_[0] === "--config" && arguments_[2] === "help")
    );
  // `validate` promises not to write even when parsing later rejects its
  // invocation. Detect its only legal command positions without consulting
  // config or environment, so a malformed offline command cannot fall through
  // to the generic GitHub Actions output writer.
  const isValidationInvocation = Array.isArray(arguments_)
    && (
      arguments_[0] === VERB_VALIDATE
      || (arguments_[0] === "--config" && arguments_[2] === VERB_VALIDATE)
    );
  try {
    parsed = parseArguments(arguments_);
    if (parsed.mode === "help") {
      stdout.write(HELP);
      return 0;
    }
    if (parsed.mode === "verb_help") {
      stdout.write(verbHelp(parsed.verb));
      return 0;
    }
    if (parsed.mode === "version") {
      stdout.write(`${CLI_VERSION}\n`);
      return 0;
    }
    if (parsed.mode === "reference") {
      const result = referenceResult(parsed);
      stdout.write(parsed.json ? `${serializeResult(result)}\n` : formatReferenceResult(result));
      return 0;
    }
    // Own properties only: a verb name must never resolve through the
    // prototype chain to something like `constructor`.
    const handler = Object.hasOwn(handlers, parsed.verb) ? handlers[parsed.verb] : undefined;
    if (typeof handler !== "function") {
      throw usageError("cli.unsupported_verb", `No handler is registered for '${parsed.verb}'.`);
    }
    const result = await handler(Object.freeze({
      verb: parsed.verb,
      cwd,
      environment,
      configPath: parsed.configPath,
      deployTarget: parsed.deployTarget,
      quiet: parsed.quiet,
      allowRawHtml: parsed.allowRawHtml,
      keyName: parsed.keyName,
      capabilities: parsed.capabilities,
      // Positionals land under the verb's own seam name (paths for media
      // upload, pagePaths for approve) and only when some were given, so a
      // bare invocation keeps each verb's documented default behavior.
      ...(parsed.positionals && parsed.positionals.values.length > 0
        ? {
          [parsed.positionals.key]: parsed.positionals.scalar
            ? parsed.positionals.values[0]
            : parsed.positionals.values,
        }
        : {}),
      onProgress: parsed.quiet ? () => {} : (message) => stderr.write(`${message}\n`),
      fetch,
      signal,
    }));
    if (parsed.verb === VERB_PREVIEW_PAGE && result?.ok === true) {
      completedPreviewRecovery = normalizePreviewRecovery(result);
    }
    const json = serializeResult(result);
    if (!isValidationInvocation && environment.GITHUB_OUTPUT) {
      await writeGithubActionsOutput(environment.GITHUB_OUTPUT, result);
    }
    stdout.write(`${json}\n`);
    return 0;
  } catch (unknownError) {
    const error = asSiteAuthoringError(unknownError);
    if (completedPreviewRecovery) error.withPreviewRecovery(completedPreviewRecovery);
    const result = failureResult(error);
    stdout.write(`${serializeResult(result)}\n`);
    stderr.write(`${humanFailure(error)}\n`);
    if (!isValidationInvocation && environment.GITHUB_OUTPUT && !isReferenceInvocation) {
      try {
        await writeGithubActionsOutput(environment.GITHUB_OUTPUT, result);
      } catch (outputError) {
        stderr.write(`${humanFailure(asSiteAuthoringError(outputError))}\n`);
      }
    }
    return error.exitCode;
  }
}
