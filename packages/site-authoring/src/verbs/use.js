import path from "node:path";

import { listAuthorableSites, withRefusalGuidance } from "../api.js";
import { atomicWriteFile } from "../atomic-file.js";
import {
  CLI_BINARY_NAME,
  CONFIG_FILE_NAME,
  CONFIG_VERSION,
  DEFAULT_WORKSPACE_DIR,
  VERB_SITES,
  VERB_USE,
} from "../constants.js";
import { isCanonicalUuid, sanitizeDiagnostic, SiteAuthoringError } from "../errors.js";
import { openAccountSession, successResult } from "../session.js";

/**
 * `taproot-site use <site>` — choose the site the next command writes to.
 *
 * The half of TR00645's onboarding fix that `sites` sets up: rather than
 * hand-writing a site id into JSON, an operator names a site and this records
 * the choice. Resolution accepts an id, an exact name, or an unambiguous
 * case-insensitive name, because the id is the thing a human is least able to
 * type from memory and most likely to get subtly wrong.
 *
 * An ambiguous name is refused rather than guessed. Two sites called "Blog" on
 * one account is a real situation, and picking one of them silently would point
 * every subsequent write at a site the operator did not choose.
 */

function selectSite(authorable, selector) {
  if (isCanonicalUuid(selector)) {
    return authorable.filter((site) => site.siteId === selector);
  }
  const exact = authorable.filter((site) => site.name === selector);
  if (exact.length > 0) return exact;
  const folded = selector.toLocaleLowerCase();
  return authorable.filter((site) => site.name.toLocaleLowerCase() === folded);
}

export async function use(invocation) {
  const selector = typeof invocation.siteSelector === "string" ? invocation.siteSelector.trim() : "";
  if (selector.length === 0) {
    throw new SiteAuthoringError(
      "use.selector_missing",
      `Name the site to use: '${CLI_BINARY_NAME} ${VERB_USE} <name or id>'. `
        + `'${CLI_BINARY_NAME} ${VERB_SITES}' lists them.`,
      { field: "selector", exitCode: 2 },
    );
  }

  const { client, config, signIn, onProgress } = await openAccountSession(invocation);
  // With no configuration yet, this is the command that creates one, in the
  // directory the operator ran it from.
  const configPath = config?.configPath
    ?? path.join(path.resolve(invocation.cwd ?? process.cwd()), CONFIG_FILE_NAME);

  return await withRefusalGuidance(onProgress, "site selection", async () => {
    const authorable = await listAuthorableSites(client);
    const matches = selectSite(authorable, selector);

    if (matches.length === 0) {
      throw new SiteAuthoringError(
        "use.site_unknown",
        `No site on this account matches '${selector}'. `
          + `Run '${CLI_BINARY_NAME} ${VERB_SITES}' to see what is available.`,
        { field: "selector" },
      );
    }
    if (matches.length > 1) {
      throw new SiteAuthoringError(
        "use.site_ambiguous",
        `More than one site is named '${selector}': ${matches.map((site) => site.siteId).join(", ")}. `
          + "Use the site id instead.",
        { field: "selector" },
      );
    }

    const [site] = matches;
    // An existing configuration keeps its workspace; a new one gets a real
    // child directory. Never "." — `validateWorkspaceDirectoryText` rejects a
    // "." segment outright, so writing it would produce a configuration the
    // very next command refuses to load.
    const workspaceDir = config === undefined
      ? DEFAULT_WORKSPACE_DIR
      : path.relative(config.configDirectory, config.workspaceDir) || DEFAULT_WORKSPACE_DIR;
    const contents = `${
      JSON.stringify(
        {
          configVersion: CONFIG_VERSION,
          siteId: site.siteId,
          workspaceDir,
          // No endpoint. Which Taproot this is talking to lives with the
          // credential, per machine — writing it here would pin a project to
          // whichever environment happened to be selected when someone ran
          // `use`, which is how a repository ends up authoring against local
          // in CI.
        },
        undefined,
        2,
      )
    }\n`;

    // The configuration is not a secret, so 0644 rather than the credential
    // store's 0600 — but the write is the same atomic one, because a
    // half-written config would leave the next command pointed at nothing.
    await atomicWriteFile(configPath, contents, {
      mode: 0o644,
      failures: {
        inspect: () =>
          new SiteAuthoringError("use.config_unwritable", `Could not inspect '${configPath}' before writing.`),
        notRegular: () =>
          new SiteAuthoringError("use.config_not_regular", `'${configPath}' is not a regular file.`),
        write: () =>
          new SiteAuthoringError("use.config_unwritable", `Could not write '${configPath}'.`),
      },
    });

    // Sanitized for the same reason the listing is: the name is authored
      // by a person and this line is what confirms the selection.
      onProgress(`Now authoring ${sanitizeDiagnostic(site.name, site.siteId)} (${site.siteId}).`);
    onProgress(`Recorded in ${configPath}.`);

    return successResult(VERB_USE, site.siteId, {
      accountId: signIn.accountId,
      site: { siteId: site.siteId, name: site.name, primaryDomain: site.primaryDomain },
      configPath: configPath,
    });
  });
}
