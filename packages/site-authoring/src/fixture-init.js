import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { loadSiteConfig } from "./config.js";
import { isCanonicalUuid, SiteAuthoringError } from "./errors.js";
import { FIXTURE_CONTRACT_VERSION, FIXTURE_MANIFEST_FILE_NAME } from "./fixture-contract.js";
import { appearanceManifestEntry, footerManifestEntry } from "./footer-workspace.js";
import { SETTINGS_GROUPS, SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES } from "./settings-catalog.js";
import { validateWorkspacePageSource } from "./verbs/pages-push.js";
import { validateThemeWorkspace } from "./verbs/theme-push.js";
import {
  MANIFEST_FILE_NAME,
  MANIFEST_VERSION,
  PAGE_WORKSPACE_MODE_EDITABLE,
  readManifest,
  readMediaManifest,
  readWorkspaceJson,
  WORKSPACE_LIMITS,
  workspaceFileExists,
  writeWorkspaceJson,
} from "./workspace.js";

function refuse(message, field = "fixturePath") {
  throw new SiteAuthoringError("fixture.init_invalid", message, { field });
}

/** Export only authored fixture inputs, never credentials, internal state or deployment receipts. */
export async function initializeFixture(invocation, validate) {
  const cwd = await realpath(invocation.cwd ?? process.cwd());
  let workspaceDir = cwd;
  let siteId;
  if (invocation.configPath !== undefined || !await workspaceFileExists(cwd, MANIFEST_FILE_NAME)) {
    const config = await loadSiteConfig({ cwd, configPath: invocation.configPath });
    workspaceDir = config.workspaceDir;
    siteId = config.siteId;
  } else {
    siteId = (await readWorkspaceJson(cwd, MANIFEST_FILE_NAME, WORKSPACE_LIMITS.manifestBytes)).siteId;
  }
  if (!isCanonicalUuid(siteId)) refuse("The source workspace must have a canonical site identity.", "siteId");
  const source = await readManifest(workspaceDir, siteId);
  if (source.manifestVersion !== MANIFEST_VERSION || source.pagesTruncated || source.settingsSkipped?.length) {
    refuse("A complete current pull is required before fixture initialization. Run 'taproot-site pull'.");
  }
  if (typeof invocation.fixturePath !== "string" || !invocation.fixturePath.trim()) {
    refuse("Choose a new fixture directory.");
  }
  const destination = path.resolve(cwd, invocation.fixturePath);
  const sourceRoot = await realpath(workspaceDir);
  if (destination === sourceRoot || destination.startsWith(`${sourceRoot}${path.sep}`)) {
    refuse("Choose a fixture destination outside the source workspace.");
  }
  const parent = path.dirname(destination);
  if (await realpath(parent).catch(() => undefined) !== parent) {
    refuse("The destination parent must exist and contain no symlinks.");
  }
  if (
    await lstat(destination).then(() => true, (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    })
  ) refuse("The fixture destination already exists; choose a new directory.");

  const identities = new Map();
  const imageIds = new Set();
  const origins = new Map();
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu;
  function identity(value) {
    const key = value.toLowerCase();
    if (!identities.has(key)) {
      const n = identities.size + 1;
      identities.set(key, `f0000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`);
    }
    return identities.get(key);
  }
  function text(value) {
    return value.replace(uuid, identity).replace(/https?:\/\/[^\s<>"'\\)]+/giu, (value) => {
      let url;
      try {
        url = new URL(value);
      } catch {
        return "https://origin.example.test/";
      }
      if (!origins.has(url.origin)) origins.set(url.origin, `https://origin-${origins.size + 1}.example.test`);
      // Query, fragment and userinfo may carry delivery signatures or handoffs.
      return origins.get(url.origin) + url.pathname;
    });
  }
  function sanitize(value, depth = 0) {
    if (depth > 100) refuse("The source exceeds the fixture nesting bound.");
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map((child) => sanitize(child, depth + 1));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (key === "componentData" && typeof child === "string") {
          return [key, JSON.stringify(sanitize(JSON.parse(child), depth + 1))];
        }
        const result = sanitize(child, depth + 1);
        if (/(?:imageId|logoId|canvasImageId|faviconId)$/iu.test(key) && isCanonicalUuid(result)) imageIds.add(result);
        return [key, result];
      }),
    );
  }
  const fixtureSiteId = identity(siteId);
  const documents = new Map();
  let totalBytes = 0;
  function add(file, value) {
    totalBytes += Buffer.byteLength(JSON.stringify(value), "utf8");
    if (totalBytes > WORKSPACE_LIMITS.pulledBodyBytes) refuse("The fixture exceeds the 64 MiB export bound.");
    documents.set(file, value);
  }
  const pages = [];
  const mediaManifest = await readMediaManifest(workspaceDir, siteId);
  for (const entry of source.pages) {
    if (entry.workspaceMode !== PAGE_WORKSPACE_MODE_EDITABLE) continue;
    if (!isCanonicalUuid(entry.pageId) || !isCanonicalUuid(entry.resourceId)) {
      refuse("A source page identity is invalid.", "pages");
    }
    const page = await validateWorkspacePageSource({
      workspaceDir,
      file: entry.file,
      manifestEntry: entry,
      mediaManifest,
      content: invocation.content,
    });
    const file = `pages/page-${pages.length + 1}.pm.json`;
    pages.push(sanitize({
      pageId: entry.pageId,
      resourceId: entry.resourceId,
      path: page.pagePath,
      title: page.title,
      description: page.declaredDescription ?? "",
      status: entry.status,
      templateType: entry.templateType,
      hasDraft: entry.hasDraft,
      isGenerated: false,
      file,
      sourceFormat: "prosemirror",
      workspaceMode: "editable",
    }));
    add(file, sanitize(page.document));
  }
  const settings = [];
  const appearanceDocuments = {};
  for (const group of SETTINGS_GROUPS) {
    const file = `settings/${group.file}`;
    const original = await readWorkspaceJson(workspaceDir, file, WORKSPACE_LIMITS.settingsBytes);
    if (original.entityId !== siteId || original.settingsType !== group.settingsType) {
      refuse("A settings document belongs to a different site or group.", file);
    }
    const document = sanitize({
      entityId: original.entityId,
      settingsType: original.settingsType,
      settings: Object.fromEntries(
        group.fields.filter((field) => Object.hasOwn(original.settings, field.name))
          .map((field) => [field.name, original.settings[field.name]]),
      ),
    });
    add(file, document);
    settings.push({ settingsType: group.settingsType, file, entityId: document.entityId });
    appearanceDocuments[group.settingsType] = document.settings;
  }
  await validateThemeWorkspace(
    workspaceDir,
    siteId,
    new Set(
      [...identities].filter(([, mapped]) => imageIds.has(mapped)).map(([original]) => original),
    ),
  );
  for (
    const [file, limit] of [["nav.json", WORKSPACE_LIMITS.navigationBytes], [
      "redirects.json",
      WORKSPACE_LIMITS.redirectsBytes,
    ]]
  ) {
    const original = await readWorkspaceJson(workspaceDir, file, limit);
    if (original.siteId !== siteId) refuse("A source document belongs to a different site.", file);
    add(
      file,
      sanitize(
        file === "nav.json"
          ? { siteId: original.siteId, navItems: original.navItems }
          : { siteId: original.siteId, revision: original.revision, entries: original.entries },
      ),
    );
  }
  const redirects = documents.get("redirects.json");
  // A fixture hash is a local placeholder, not authority to mutate the original site.
  const revision = createHash("sha256").update(JSON.stringify(redirects.entries)).digest("hex");
  if (Object.hasOwn(redirects, "revision")) redirects.revision = revision;
  const footer = footerManifestEntry(appearanceDocuments[SETTINGS_TYPE_SITE_PUBLISHING_PREFERENCES].footerSettings);
  const appearance = appearanceManifestEntry(appearanceDocuments);
  for (const id of [...footer.imageIds, ...appearance.imageIds]) imageIds.add(id);
  add(FIXTURE_MANIFEST_FILE_NAME, {
    manifestVersion: MANIFEST_VERSION,
    siteId: fixtureSiteId,
    pages,
    pagesTruncated: false,
    navigation: { file: "nav.json", items: source.navigation?.items },
    redirects: { file: "redirects.json", revision, entries: redirects.entries?.length },
    settings,
    settingsSkipped: [],
    appearance,
    footer,
    fixture: {
      contractVersion: FIXTURE_CONTRACT_VERSION,
      imageIds: [...imageIds].sort(),
      deliveryOrigins: [...origins.values()],
    },
  });

  // mkdir is exclusive even if another process wins the path after the earlier inspection.
  try {
    await mkdir(destination, { mode: 0o700 });
  } catch {
    refuse("The fixture destination could not be created exclusively.");
  }
  try {
    for (const [file, value] of documents) await writeWorkspaceJson(destination, file, value);
    const result = await validate({ ...invocation, init: false, cwd, fixturePath: destination });
    invocation.onProgress?.(`Initialized a sanitized fixture with ${pages.length} editable page(s).`);
    return {
      ...result,
      initialized: { directory: destination, pages: pages.length, skippedPages: source.pages.length - pages.length },
    };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
