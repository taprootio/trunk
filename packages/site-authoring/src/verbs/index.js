import {
  VERB_APPROVE,
  VERB_DEPLOY,
  VERB_ENV,
  VERB_FOOTER_PUSH,
  VERB_LOGIN,
  VERB_LOGOUT,
  VERB_MEDIA_UPLOAD,
  VERB_NAV_PUSH,
  VERB_PAGES_PUSH,
  VERB_PREVIEW_PAGE,
  VERB_PREVIEW_REVOKE,
  VERB_PULL,
  VERB_REDIRECTS_PULL,
  VERB_REDIRECTS_PUSH,
  VERB_SITES,
  VERB_STATUS,
  VERB_THEME_PUSH,
  VERB_USE,
  VERB_VALIDATE,
  VERB_WHOAMI,
} from "../constants.js";
import { approve } from "./approve.js";
import { deploy } from "./deploy.js";
import { env } from "./env.js";
import { footerPush } from "./footer-push.js";
import { login } from "./login.js";
import { logout } from "./logout.js";
import { mediaUpload } from "./media-upload.js";
import { navPush } from "./nav-push.js";
import { pagesPush } from "./pages-push.js";
import { pull } from "./pull.js";
import { previewPage } from "./preview-page.js";
import { previewRevoke } from "./preview-revoke.js";
import { redirectsPull } from "./redirects-pull.js";
import { redirectsPush } from "./redirects-push.js";
import { sites } from "./sites.js";
import { status } from "./status.js";
import { themePush } from "./theme-push.js";
import { use } from "./use.js";
import { validateFixture } from "./validate.js";
import { whoami } from "./whoami.js";

/**
 * The verb seam.
 *
 * `cli.js` parses the command line, decides nothing about what a verb means,
 * and calls exactly one handler from this table with a single frozen
 * invocation object:
 *
 * ```
 * {
 *   verb,          // the canonical verb name, e.g. "pages push"
 *   cwd,           // directory configuration discovery starts from
 *   environment,   // the process environment: TAPROOT_SITE_KEY, and the HOME /
 *                  //   XDG_CONFIG_HOME that locate the stored credential
 *   configPath,    // an explicit --config path, or undefined
 *   deployTarget,  // "staging" | "production" for `deploy`, else undefined
 *   quiet,         // --quiet; suppresses progress, never the JSON result
 *   allowRawHtml,  // --allow-raw-html; `pages push` only, false everywhere else
 *   keyName,       // --name; `login` only, undefined everywhere else
 *   onProgress,    // human progress sink (stderr, or a no-op when quiet)
 *   fetch,         // injectable fetch, for tests
 *   signal,        // optional AbortSignal
 * }
 * ```
 *
 * Two verbs are credential-free but not config-free. `login` and `logout`
 * manage the stored credential rather than using one, so they read the
 * configuration (for the site id and the reviewed API origin) and never require
 * `TAPROOT_SITE_KEY`.
 *
 * Verbs that take positional arguments receive them under their own
 * seam name, and only when some were given — a bare invocation keeps each
 * verb's documented default:
 *
 * ```
 * {
 *   fixturePath,   // validate: one offline authoring-fixture directory
 *   paths,         // media upload: files and/or directories to upload;
 *                  //   with none, the workspace's media/ directory is walked
 *   pagePaths,     // approve: narrow to these page paths; with none, every
 *                  //   draft the workspace manifest tracks is staged
 *   pageId,        // preview page: the one persisted draft UUID to render
 *   previewIds,    // preview revoke: [page UUID, snapshot UUID]
 * }
 * ```
 *
 * A handler resolves with the machine-readable result object that reaches
 * stdout, or throws a `SiteAuthoringError`.
 *
 * Handlers also accept a few optional keys `cli.js` does not set. They are the
 * seams tests inject through, and the shape a programmatic caller fills in:
 *
 * ```
 * {
 *   client,                 // a prebuilt SiteApiClient, bypassing construction
 *   sleep, now,             // deterministic clocks for the bounded polls
 *   content,                // the src/content/ module (pages push)
 *   stagedPageIds,          // deploy --staging: an explicit candidate; refused
 *   selectedSettingsTypes,  //   outright for --production, which promotes a
 *   includeNavigation,      //   staging deployment and nothing else
 *   stagingDeploymentId,    // deploy --production: promote this one
 * }
 * ```
 *
 * Every optional key defaults to the safe reading when absent: no raw HTML, the
 * workspace's own directories, and the whole approved candidate.
 */
export const VERB_HANDLERS = Object.freeze({
  [VERB_VALIDATE]: validateFixture,
  [VERB_LOGIN]: login,
  [VERB_LOGOUT]: logout,
  [VERB_PULL]: pull,
  [VERB_PAGES_PUSH]: pagesPush,
  [VERB_NAV_PUSH]: navPush,
  [VERB_REDIRECTS_PULL]: redirectsPull,
  [VERB_REDIRECTS_PUSH]: redirectsPush,
  [VERB_THEME_PUSH]: themePush,
  [VERB_FOOTER_PUSH]: footerPush,
  [VERB_MEDIA_UPLOAD]: mediaUpload,
  [VERB_APPROVE]: approve,
  [VERB_DEPLOY]: deploy,
  [VERB_PREVIEW_PAGE]: previewPage,
  [VERB_PREVIEW_REVOKE]: previewRevoke,
  [VERB_SITES]: sites,
  [VERB_USE]: use,
  [VERB_WHOAMI]: whoami,
  [VERB_ENV]: env,
  [VERB_STATUS]: status,
});
