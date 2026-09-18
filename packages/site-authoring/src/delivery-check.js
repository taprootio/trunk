import { sanitizeDiagnostic, SiteAuthoringError } from "./errors.js";
import { withholdCredentialLocation } from "./staging-check.js";

/**
 * Visitor-facing delivery verification (TR00824).
 *
 * A completed deployment job proves that Taproot wrote what it meant to
 * write. It does not prove that a visitor receives it: the edge may still
 * serve the previous route, an asset may 404 behind a 200 HTML error page, and
 * the shared runtime a browser loads comes from a mutable major pointer that
 * can lag or be cached. This module checks the public HTTP surface of a
 * deployment target with explicit bounds and reports each dimension on its
 * own: HTTP delivery is checked here, browser-observed behaviour is the
 * optional probe in `delivery-browser.js`, and a dimension nobody checked is
 * reported as unchecked, never as passed.
 *
 * Everything here is read-only. It never purges, republishes, or follows a
 * link off the site's own origin, and it never sends the staging credential
 * anywhere but the staging origin it was minted for. HTML is read by a small
 * start-tag tokenizer that follows the browser's rules for comments, quoted
 * attribute values and raw-text elements, not by a full parser: a reference
 * a browser would resolve through tree construction quirks may be missed,
 * never invented.
 */

export const DELIVERY_LIMITS = Object.freeze({
  routes: 20,
  images: 6,
  links: 40,
  capabilities: 12,
  localReferences: 20,
  concurrency: 4,
  attempts: 2,
  retryMilliseconds: 1_000,
  requestMilliseconds: 15_000,
  htmlBytes: 2 * 1024 * 1024,
  manifestBytes: 256 * 1024,
  propagationWaitMaximumSeconds: 120,
  failures: 40,
  reportBytes: 24_000,
  outputBytes: 48 * 1024,
  urlScalars: 512,
  tags: 50_000,
  attributesPerTag: 64,
});

const HTML_TYPES = /^text\/html\b/iu;
const JSON_TYPES = /^application\/(?:json|manifest\+json)\b/iu;
const SCRIPT_TYPES = /^(?:text|application)\/(?:javascript|ecmascript|x-javascript)\b/iu;
const IMAGE_TYPES = /^image\//iu;
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|[^/]*\.(?:test|local|localhost|internal))(?::\d+)?$/iu;
// Untrusted names index these tables, so they carry no prototype: an element
// called <constructor> or an entity &constructor; is ordinary markup.
const ENTITIES = new Map([["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", "\""], ["apos", "'"], ["#39", "'"]]);
// Raw-text elements: their bodies are text to a browser, never markup.
const RAW_TEXT_END = new Map([
  ["script", /<\/script(?=[\s/>])/giu],
  ["style", /<\/style(?=[\s/>])/giu],
  ["textarea", /<\/textarea(?=[\s/>])/giu],
  ["title", /<\/title(?=[\s/>])/giu],
]);
const TAG_NAME = /^[a-z][^\s/>]*/iu;
// One attribute at a time, in document order, so a quoted value that happens
// to contain attribute-like text is consumed as that value and never read as
// an attribute of its own.
const ATTRIBUTE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
const CUSTOM_ELEMENT_NAME = /^[a-z][a-z0-9._-]{0,63}$/u;

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, entity) => {
    let codePoint;
    if (entity.startsWith("#x")) codePoint = Number.parseInt(entity.slice(2), 16);
    else if (entity.startsWith("#")) codePoint = Number(entity.slice(1));
    else return ENTITIES.get(entity.toLowerCase()) ?? whole;
    // An out-of-range or surrogate reference decodes to the replacement
    // character, as a browser does, never to an exception.
    return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? String.fromCodePoint(codePoint)
      : "\ufffd";
  });
}

/** A start tag's attributes, first occurrence of a name winning as in a browser. */
function parseAttributes(text) {
  const attributes = new Map();
  ATTRIBUTE.lastIndex = 0;
  let match;
  while ((match = ATTRIBUTE.exec(text)) !== null && attributes.size < DELIVERY_LIMITS.attributesPerTag) {
    const name = match[1].toLowerCase();
    if (attributes.has(name)) continue;
    const decoded = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "").trim();
    attributes.set(name, decoded === "" ? undefined : decoded);
  }
  return attributes;
}

/**
 * The live start tags of a document in order, each with its attributes and,
 * for a raw-text element, its body. Comments are skipped, a quoted attribute
 * value may hold any character including `>`, an unterminated tag or comment
 * ends the live document, and script, style, textarea and title bodies are
 * attached to their element rather than scanned. Used for reference and
 * bootstrap discovery alike, so both read the same document.
 */
export function tokenizeMarkup(html) {
  const tags = [];
  const length = html.length;
  let index = 0;
  while (index < length && tags.length < DELIVERY_LIMITS.tags) {
    const open = html.indexOf("<", index);
    if (open < 0) break;
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      if (close < 0) break;
      index = close + 3;
      continue;
    }
    const nameMatch = TAG_NAME.exec(html.slice(open + 1, open + 65));
    if (!nameMatch) {
      index = open + 1;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    let cursor = open + 1 + nameMatch[0].length;
    let terminated = false;
    while (cursor < length) {
      const character = html[cursor];
      if (character === ">") {
        terminated = true;
        break;
      }
      if (character === "=") {
        let next = cursor + 1;
        while (next < length && /\s/u.test(html[next])) next += 1;
        const quote = html[next];
        if (quote === "\"" || quote === "'") {
          const close = html.indexOf(quote, next + 1);
          if (close < 0) break;
          cursor = close + 1;
          continue;
        }
        cursor = next;
        continue;
      }
      cursor += 1;
    }
    if (!terminated) break;
    const tag = { name, attributes: parseAttributes(html.slice(open + 1 + nameMatch[0].length, cursor)), text: "" };
    index = cursor + 1;
    const rawEnd = RAW_TEXT_END.get(name);
    if (rawEnd) {
      rawEnd.lastIndex = index;
      const end = rawEnd.exec(html);
      if (!end) {
        tag.text = html.slice(index);
        index = length;
      } else {
        tag.text = html.slice(index, end.index);
        const close = html.indexOf(">", end.index);
        index = close < 0 ? length : close + 1;
      }
    }
    tags.push(tag);
  }
  return tags;
}

function typeOf(response) {
  return (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
}

function expectationFor(kind) {
  if (kind === "route" || kind === "link") return { name: "text/html", test: HTML_TYPES };
  if (kind === "manifest") return { name: "application/json", test: JSON_TYPES };
  if (kind === "site-bundle" || kind === "runtime-entry" || kind === "module" || kind === "capability") {
    return { name: "javascript", test: SCRIPT_TYPES };
  }
  return { name: "image/*", test: IMAGE_TYPES };
}

export function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value ?? "");
    return match ? match.slice(1).map(Number) : undefined;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

/** The runtime bootstrap a rendered page declares, or undefined when absent. */
export function parseBootstrap(html) {
  const script = tokenizeMarkup(html).find((tag) => tag.name === "script" && tag.attributes.get("id") === "taproot-runtime-bootstrap");
  if (!script) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(script.text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const text = (value) => (typeof value === "string" ? [...value].slice(0, DELIVERY_LIMITS.urlScalars * 4).join("") : "");
  // Capability tags are custom-element names; anything else is not a
  // capability this page could declare and is counted, never carried.
  const declared = Array.isArray(parsed.runtimeCapabilities) ? parsed.runtimeCapabilities : [];
  const runtimeCapabilities = declared.filter((value) => typeof value === "string" && CUSTOM_ELEMENT_NAME.test(value)).slice(0, 64);
  return {
    runtimeMajorVersion: text(parsed.runtimeMajorVersion).slice(0, 16),
    runtimeManifestUrl: text(parsed.runtimeManifestUrl),
    fallbackRuntimeManifestUrl: text(parsed.fallbackRuntimeManifestUrl),
    siteBundleUrl: text(parsed.siteBundleUrl),
    runtimeCapabilities,
    ...(declared.length > runtimeCapabilities.length ? { capabilitiesDropped: declared.length - runtimeCapabilities.length } : {}),
  };
}

/**
 * A reference resolved against its page, or undefined when it is not an
 * http(s) URL, carries credentials, or uses a spelling (a backslash, a
 * network-path `//host`) that a later reparse could send elsewhere.
 */
function resolveReference(value, base) {
  if (typeof value !== "string" || value.includes("\\") || /[ -]/u.test(value)) return undefined;
  let url;
  try {
    url = new URL(value, base);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return undefined;
  if (url.pathname.startsWith("//")) return undefined;
  return url;
}

function isLocalOnly(url) {
  return LOCAL_HOST.test(url.host);
}

/**
 * The references a rendered page makes that a visitor's browser would fetch
 * next, bounded, and separated into the site's own routes, its assets, and
 * anything that points at a developer-only host. Only same-origin references
 * are kept, as validated absolute URLs: an authored reference to any other
 * host is content, not delivery, and the CLI never probes a host the site did
 * not publish to.
 */
export function discoverReferences(markup, pageUrl) {
  const page = new URL(pageUrl);
  const favicon = [];
  const modules = [];
  const images = [];
  const internalLinks = new Set();
  const localOnly = new Set();
  const note = (url, into) => {
    if (!url) return;
    if (url.origin === page.origin) into?.(url);
    else if (isLocalOnly(url)) localOnly.add(url.href);
  };
  for (const tag of tokenizeMarkup(markup)) {
    if (tag.name === "link") {
      const rel = (tag.attributes.get("rel") ?? "").toLowerCase().split(/\s+/u);
      const url = resolveReference(tag.attributes.get("href"), page);
      if (rel.includes("icon") || rel.includes("apple-touch-icon")) note(url, (value) => favicon.push(value.href));
      else if (rel.includes("modulepreload")) note(url, (value) => modules.push(value.href));
    } else if (tag.name === "img" || tag.name === "esp-image") {
      note(resolveReference(tag.attributes.get("src"), page), (value) => images.push(value.href));
    } else if (tag.name === "a") {
      const url = resolveReference(tag.attributes.get("href"), page);
      if (!url) continue;
      if (url.origin === page.origin) {
        if (!url.pathname.startsWith("/_") && !url.search) {
          url.hash = "";
          internalLinks.add(url.href);
        }
      } else if (isLocalOnly(url)) localOnly.add(url.href);
    }
  }
  return {
    favicon: [...new Set(favicon)].slice(0, 2),
    modules: [...new Set(modules)].slice(0, 4),
    images: [...new Set(images)].slice(0, DELIVERY_LIMITS.images),
    internalLinks: [...internalLinks].slice(0, DELIVERY_LIMITS.links),
    localOnly: [...localOnly].slice(0, DELIVERY_LIMITS.localReferences),
  };
}

function describeFailure(row) {
  if (row.error) return row.error;
  if (row.status === 0) return "unreachable";
  if (row.status >= 300 && row.status < 400) return "redirected";
  if (row.status !== 200) return `http_${row.status}`;
  if (!row.contentTypeMatches) return "wrong_content_type";
  return undefined;
}

/**
 * Read a body up to `maximumBytes`, streaming so a missing or understated
 * Content-Length cannot make the CLI buffer more than the bound. Returns
 * undefined once the bound is exceeded, after cancelling the stream.
 */
async function readBounded(response, maximumBytes) {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maximumBytes) {
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

/** A URL-ish scalar as evidence: credentials withheld, controls removed, bounded. */
function bounded(value) {
  return [...withholdCredentialLocation(typeof value === "string" ? value : "")].slice(0, DELIVERY_LIMITS.urlScalars).join("");
}

/**
 * One bounded, retried GET against the delivery target. Redirects are never
 * followed: an authored route that answers a redirect is not delivered, and a
 * redirect could otherwise carry the staging cookie to another host. The body
 * read is part of the attempt, so a server that stalls or resets after its
 * headers is retried and recorded, never thrown.
 */
async function probe(context, url, kind, { readBody = false, maximumBytes = DELIVERY_LIMITS.manifestBytes } = {}) {
  const expectation = expectationFor(kind);
  const origin = new URL(url).origin;
  if (!context.allowedOrigins.has(origin)) {
    return {
      row: { url: bounded(url), kind, status: 0, contentType: "", ok: false, attempts: 0, failure: "origin_not_allowed", expectedContentType: expectation.name },
      body: "",
    };
  }
  let last;
  for (let attempt = 1; attempt <= DELIVERY_LIMITS.attempts; attempt += 1) {
    const row = { url: bounded(url), kind, status: 0, contentType: "", attempts: attempt, expectedContentType: expectation.name };
    let body = "";
    try {
      const response = await context.fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: context.timeoutSignal(DELIVERY_LIMITS.requestMilliseconds),
        headers: {
          accept: kind === "route" || kind === "link" ? "text/html" : "*/*",
          "user-agent": "taproot-site/delivery-check",
          ...(context.cookie && origin === context.cookieOrigin ? { cookie: context.cookie } : {}),
        },
      });
      row.status = response.status;
      row.contentType = typeOf(response);
      row.contentTypeMatches = expectation.test.test(row.contentType);
      row.cacheControl = bounded(response.headers.get("cache-control") ?? "");
      const location = response.headers.get("location");
      // A redirect from the staging edge can carry a handoff or cookie in its
      // Location; the same withholding staging-check applies keeps it out of
      // the report and GITHUB_OUTPUT.
      if (location && response.status >= 300 && response.status < 400) row.location = bounded(withholdCredentialLocation(location));
      if (readBody && response.status === 200) {
        const read = await readBounded(response, maximumBytes);
        if (read === undefined) row.error = "body_too_large";
        else body = read;
      } else {
        await response.body?.cancel().catch(() => {});
      }
    } catch {
      row.error = row.status === 0 ? "request_failed" : "read_failed";
    }
    row.ok = row.status === 200 && row.contentTypeMatches === true && !row.error;
    const failure = describeFailure(row);
    if (failure) row.failure = failure;
    last = { row, body };
    const retryable = row.error === "request_failed" || row.error === "read_failed" || row.status >= 500;
    if (row.ok || !retryable || attempt === DELIVERY_LIMITS.attempts) break;
    await context.sleep(DELIVERY_LIMITS.retryMilliseconds);
  }
  return last;
}

async function mapBounded(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(DELIVERY_LIMITS.concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

function requireHttpsOrigin(value, field) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SiteAuthoringError("delivery.target_invalid", "The delivery target must be an absolute https origin.", { field });
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new SiteAuthoringError(
      "delivery.target_invalid",
      "The delivery target must be an https origin with no path, query, credentials or fragment.",
      { field },
    );
  }
  return `${url.origin}/`;
}

/** A site-relative route as the visitor would request it, or undefined when its spelling could leave the origin. */
function routeUrl(path, origin) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return undefined;
  const url = resolveReference(path, origin);
  return url && url.origin === new URL(origin).origin && url.pathname === path ? url.href : undefined;
}

function strip(row) {
  const { contentTypeMatches, ...rest } = row;
  return rest;
}

/** One complete observation of the target. Run once, and once more after a propagation wait. */
async function observe(context, origin, sampledRoutes) {
  const routeRows = [];
  const assetRows = [];
  const assetUrls = new Set();
  let imageCount = 0;
  const addAsset = (url, kind) => {
    if (assetUrls.has(url)) return false;
    assetUrls.add(url);
    assetRows.push({ url, kind });
    return true;
  };
  const links = new Set();
  const localOnly = new Set();
  let bootstrap;

  const routeResults = await mapBounded(sampledRoutes, async (path) => {
    const url = routeUrl(path, origin);
    if (!url) {
      return {
        path,
        row: { url: bounded(path), kind: "route", status: 0, ok: false, attempts: 0, failure: "invalid_route", expectedContentType: "text/html" },
        body: "",
      };
    }
    const { row, body } = await probe(context, url, "route", { readBody: true, maximumBytes: DELIVERY_LIMITS.htmlBytes });
    return { path, row, body };
  });
  for (const { path, row, body } of routeResults) {
    routeRows.push({ path: bounded(path), ...row });
    if (!row.ok) continue;
    const references = discoverReferences(body, row.url);
    for (const link of references.internalLinks) links.add(link);
    for (const reference of references.localOnly) localOnly.add(reference);
    if (path === "/") {
      bootstrap = parseBootstrap(body);
      for (const href of references.favicon) addAsset(href, "favicon");
      for (const href of references.modules) addAsset(href, "module");
    }
    // Images are a sample, bounded across every route, not per page.
    for (const href of references.images) {
      if (imageCount >= DELIVERY_LIMITS.images) break;
      if (addAsset(href, "image")) imageCount += 1;
    }
  }

  // The runtime the page declares: the mutable major pointer a browser
  // resolves, the immutable fallback copy shipped with the site, the entry
  // module the pointer names and the capability modules it maps. The
  // bootstrap is generator-authored, so its origins are trusted here and
  // admitted for the runtime probes only.
  const runtime = {
    declared: bootstrap !== undefined,
    expectedMajorVersion: bootstrap?.runtimeMajorVersion ?? "",
    capabilities: bootstrap?.runtimeCapabilities ?? [],
    ...(bootstrap?.capabilitiesDropped ? { capabilitiesDropped: bootstrap.capabilitiesDropped } : {}),
  };
  const admit = (value) => {
    const url = value ? resolveReference(value, origin) : undefined;
    if (url) context.allowedOrigins.add(url.origin);
    return url;
  };
  if (bootstrap?.siteBundleUrl) {
    const bundle = admit(bootstrap.siteBundleUrl);
    // The bundle is also module-preloaded; report it once, as the site bundle.
    if (bundle) {
      const preloaded = assetRows.findIndex((row) => row.url === bundle.href);
      if (preloaded >= 0) assetRows[preloaded].kind = "site-bundle";
      else addAsset(bundle.href, "site-bundle");
    }
  }
  const manifests = [];
  for (const [name, value] of [["majorPointer", bootstrap?.runtimeManifestUrl], ["fallback", bootstrap?.fallbackRuntimeManifestUrl]]) {
    const url = admit(value);
    if (url) manifests.push({ name, url: url.href });
    else runtime[name] = { url: "", ok: false, failure: "undeclared" };
  }
  const manifestResults = await mapBounded(manifests, async ({ name, url }) => {
    const { row, body } = await probe(context, url, "manifest", { readBody: true });
    let parsed;
    if (row.ok) {
      try {
        parsed = JSON.parse(body);
      } catch {
        row.ok = false;
        row.failure = "invalid_json";
      }
    }
    return { name, row, parsed, url };
  });
  const capabilityUrls = [];
  for (const { name, row, parsed, url } of manifestResults) {
    const capabilities = parsed?.capabilities && typeof parsed.capabilities === "object" && !Array.isArray(parsed.capabilities)
      ? parsed.capabilities
      : {};
    const declared = runtime.capabilities.filter((tag) => typeof capabilities[tag] === "string" && capabilities[tag] !== "");
    // Declared is not resolvable: a module URL that is invalid or points off
    // the runtime's origin is a failed observation, not a silent omission.
    const outcomes = declared.map((tag) => {
      const module = resolveReference(capabilities[tag], url);
      if (!module) return { tag, failure: "invalid_url" };
      if (!context.allowedOrigins.has(module.origin)) return { tag, url: module.href, failure: "origin_not_allowed" };
      return { tag, url: module.href };
    });
    const resolvable = outcomes.filter((outcome) => outcome.failure === undefined);
    runtime[name] = {
      url: bounded(row.url),
      status: row.status,
      ok: row.ok,
      ...(row.failure ? { failure: row.failure } : {}),
      version: typeof parsed?.version === "string" ? bounded(parsed.version) : "",
      majorVersion: parsed?.majorVersion === undefined ? "" : bounded(String(parsed.majorVersion)),
      entry: typeof parsed?.entry === "string" ? bounded(parsed.entry) : "",
      cacheControl: row.cacheControl ?? "",
      capabilities: Object.keys(capabilities).length,
      declaredCapabilities: declared.length,
      resolvableCapabilities: resolvable.length,
    };
    if (name === "majorPointer" && row.ok) {
      for (const outcome of outcomes) {
        if (outcome.failure) capabilityUrls.push({ tag: outcome.tag, url: outcome.url ?? "", failure: outcome.failure });
        else if (capabilityUrls.filter((entry) => !entry.failure).length < DELIVERY_LIMITS.capabilities) capabilityUrls.push(outcome);
        else capabilityUrls.push({ tag: outcome.tag, url: outcome.url, unchecked: true });
      }
    }
  }
  const pointer = runtime.majorPointer;
  if (pointer?.ok && pointer.entry) {
    const entry = resolveReference(pointer.entry, pointer.url);
    if (entry && context.allowedOrigins.has(entry.origin)) {
      const { row } = await probe(context, entry.href, "runtime-entry");
      runtime.entry = { url: row.url, status: row.status, ok: row.ok, ...(row.failure ? { failure: row.failure } : {}) };
    } else {
      runtime.entry = { url: bounded(pointer.entry), ok: false, failure: "origin_not_allowed" };
    }
  } else {
    runtime.entry = { url: "", ok: false, failure: "pointer_unavailable" };
  }
  const capabilityResults = await mapBounded(capabilityUrls, async ({ tag, url, failure, unchecked }) => {
    if (failure) return { tag: bounded(tag), url: bounded(url), kind: "capability", status: 0, ok: false, attempts: 0, failure };
    if (unchecked) return { tag: bounded(tag), url: bounded(url), kind: "capability", ok: false, unchecked: true };
    const { row } = await probe(context, url, "capability");
    return { tag: bounded(tag), ...strip(row) };
  });
  const uncheckedCapabilities = capabilityResults.filter((row) => row.unchecked).length;
  const invalidCapabilities = capabilityResults.filter((row) => row.attempts === 0).length;
  runtime.capabilityModules = {
    checked: capabilityResults.length - uncheckedCapabilities - invalidCapabilities,
    invalid: invalidCapabilities,
    failed: capabilityResults.filter((row) => !row.ok && !row.unchecked).length,
    unchecked: uncheckedCapabilities,
    items: capabilityResults.filter((row) => !row.ok && !row.unchecked).slice(0, DELIVERY_LIMITS.capabilities),
  };
  runtime.majorStreamMatches = Boolean(pointer?.ok) && pointer.majorVersion === runtime.expectedMajorVersion;
  runtime.pointerBehindFallback = Boolean(pointer?.ok && runtime.fallback?.ok)
    && compareVersions(pointer.version, runtime.fallback.version) === -1;
  runtime.capabilitiesResolvable = Boolean(pointer?.ok)
    && pointer.resolvableCapabilities === runtime.capabilities.length
    && runtime.capabilityModules.failed === 0;
  runtime.compatible = runtime.declared && runtime.majorStreamMatches && runtime.entry.ok && runtime.capabilitiesResolvable;

  const assetResults = await mapBounded(assetRows, async ({ url, kind }) => {
    const { row } = await probe(context, url, kind);
    return { kind, ...row };
  });
  const sampledSet = new Set(sampledRoutes.map((path) => routeUrl(path, origin)).filter(Boolean));
  const linkUrls = [...links].filter((href) => !sampledSet.has(href)).slice(0, DELIVERY_LIMITS.links);
  const linkResults = await mapBounded(linkUrls, async (href) => {
    const { row } = await probe(context, href, "link");
    return { path: bounded(new URL(href).pathname), ...row };
  });

  const failures = [
    ...routeRows.filter((row) => !row.ok).map((row) => `route ${row.path}: ${row.failure}`),
    ...assetResults.filter((row) => !row.ok).map((row) => `${row.kind} ${row.url}: ${row.failure}`),
    ...linkResults.filter((row) => !row.ok).map((row) => `link ${row.path}: ${row.failure}`),
    ...(runtime.declared ? [] : ["runtime: the home page declares no runtime bootstrap"]),
    ...(runtime.declared && !runtime.majorStreamMatches
      ? [`runtime: the major pointer serves major ${pointer?.majorVersion || "unknown"}, the page expects ${runtime.expectedMajorVersion}`]
      : []),
    ...(runtime.declared && !runtime.entry.ok ? [`runtime: entry ${runtime.entry.url || "(undeclared)"}: ${runtime.entry.failure}`] : []),
    ...(runtime.declared && runtime.fallback && !runtime.fallback.ok
      ? [`runtime: fallback ${runtime.fallback.url || "(undeclared)"}: ${runtime.fallback.failure}`]
      : []),
    ...(runtime.declared && !runtime.capabilitiesResolvable
      ? [`runtime: ${runtime.capabilities.length - (pointer?.declaredCapabilities ?? 0)} declared capability module(s) are missing from the major pointer and ${runtime.capabilityModules.failed} were invalid or did not load`]
      : []),
    ...(runtime.pointerBehindFallback
      ? [`runtime: the major pointer (${pointer.version}) is behind the fallback runtime this site shipped with (${runtime.fallback.version}); returning browsers may be on an older runtime until it is promoted`]
      : []),
    ...([...localOnly].slice(0, DELIVERY_LIMITS.localReferences).map((reference) => `local-only reference: ${bounded(reference)}`)),
  ].map((value) => [...sanitizeDiagnostic(value, "")].slice(0, DELIVERY_LIMITS.urlScalars).join(""));

  return {
    routeRows,
    assetResults,
    linkResults,
    localOnly: [...localOnly].slice(0, DELIVERY_LIMITS.localReferences),
    localOnlyTotal: localOnly.size,
    runtime,
    failures: failures.slice(0, DELIVERY_LIMITS.failures),
    failuresTotal: failures.length,
  };
}

/** Keep the report inside the output budget: failures first, then successes, with truncation flags. */
function budgeted(observed, sampledRoutes, selected) {
  const sections = [
    ["routes", observed.routeRows],
    ["assets", observed.assetResults],
    ["links", observed.linkResults],
  ];
  let bytes = 0;
  const report = {};
  for (const [name, rows] of sections) {
    const items = [];
    const ordered = [...rows.filter((row) => !row.ok), ...rows.filter((row) => row.ok)];
    for (const row of ordered) {
      const item = strip(row);
      const size = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
      if (bytes + size > DELIVERY_LIMITS.reportBytes) break;
      items.push(item);
      bytes += size;
    }
    report[name] = {
      items,
      checked: rows.length,
      failed: rows.filter((row) => !row.ok).length,
      ...(items.length < rows.length ? { itemsTruncated: true } : {}),
    };
  }
  if (selected.length > sampledRoutes.length) Object.assign(report.routes, { truncated: true, requested: selected.length });
  return report;
}

/**
 * Verify a completed deployment's public delivery.
 *
 * @param options.fetch The transport's fetch; bounded per request by `timeoutSignal`.
 * @param options.baseUrl The target origin (staging or production), https only.
 * @param options.routes Site-relative paths to verify; "/" is always included.
 * @param options.cookie Optional staging cookie, sent only to `baseUrl`'s origin.
 * @param options.propagationWaitSeconds Bounded wait before one complete re-observation.
 */
export async function checkDelivery({
  fetch,
  timeoutSignal,
  baseUrl,
  routes = [],
  cookie,
  propagationWaitSeconds = 0,
  sleep,
  now = Date.now,
}) {
  const origin = requireHttpsOrigin(baseUrl, "url");
  const waitSeconds = Math.min(
    Math.max(0, Number.isFinite(propagationWaitSeconds) ? Math.trunc(propagationWaitSeconds) : 0),
    DELIVERY_LIMITS.propagationWaitMaximumSeconds,
  );
  const context = {
    fetch,
    timeoutSignal,
    cookie,
    cookieOrigin: new URL(origin).origin,
    // The site's own origin, plus whatever the page's generator-authored
    // bootstrap declares for the runtime once it has been read.
    allowedOrigins: new Set([new URL(origin).origin]),
    sleep: sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  };
  const selected = [...new Set(["/", ...routes.filter((path) => typeof path === "string" && path.startsWith("/"))])];
  const sampledRoutes = selected.slice(0, DELIVERY_LIMITS.routes);

  let observed = await observe(context, origin, sampledRoutes);
  // One bounded re-observation of everything, for edge propagation: it waits
  // the caller's budget once and observes again from the home page down, so a
  // recovered route, asset, pointer or bootstrap is seen fresh. It never loops.
  let waited = 0;
  if (waitSeconds > 0 && observed.failures.length > 0) {
    await context.sleep(waitSeconds * 1000);
    waited = waitSeconds;
    observed = await observe(context, origin, sampledRoutes);
  }

  const verdict = observed.failuresTotal === 0
    ? "delivered"
    : observed.routeRows.every((row) => row.ok) && observed.runtime.compatible
    ? "degraded"
    : "failed";
  const report = {
    target: { url: origin, stagingAuthorized: Boolean(cookie) },
    verdict,
    ...budgeted(observed, sampledRoutes, selected),
    localOnlyReferences: observed.localOnly.map((value) => bounded(value)),
    ...(observed.localOnlyTotal > observed.localOnly.length ? { localOnlyReferencesTotal: observed.localOnlyTotal } : {}),
    runtime: observed.runtime,
    failures: observed.failures,
    ...(observed.failuresTotal > observed.failures.length ? { failuresTotal: observed.failuresTotal, failuresTruncated: true } : {}),
    propagation: {
      waitedSeconds: waited,
      maximumSeconds: DELIVERY_LIMITS.propagationWaitMaximumSeconds,
      ...(waited > 0 ? { reobservedAfterSeconds: waited } : {}),
    },
    limits: {
      routes: DELIVERY_LIMITS.routes,
      images: DELIVERY_LIMITS.images,
      links: DELIVERY_LIMITS.links,
      capabilities: DELIVERY_LIMITS.capabilities,
      concurrency: DELIVERY_LIMITS.concurrency,
      attempts: DELIVERY_LIMITS.attempts,
      requestMilliseconds: DELIVERY_LIMITS.requestMilliseconds,
      reportBytes: DELIVERY_LIMITS.reportBytes,
      outputBytes: DELIVERY_LIMITS.outputBytes,
      localReferences: DELIVERY_LIMITS.localReferences,
      failures: DELIVERY_LIMITS.failures,
    },
    checkedAt: new Date(now()).toISOString(),
  };
  return withinOutputBudget(report, observed.failuresTotal);
}

/**
 * The whole report, not just its item lists, must stay inside the output
 * budget the CLI's machine-readable result has to fit. Evidence is shed in
 * order of least value: successful items first, then failed items, then
 * failure lines; counts, totals and the verdict always remain.
 */
function withinOutputBudget(report, failuresTotal) {
  const size = () => Buffer.byteLength(JSON.stringify(report), "utf8");
  const fits = () => size() <= DELIVERY_LIMITS.outputBytes;
  const shed = [
    ...["links", "assets", "routes"].map((section) => () => {
      report[section].items = report[section].items.filter((item) => !item.ok);
      report[section].itemsTruncated = true;
    }),
    ...["links", "assets", "routes"].map((section) => () => {
      report[section].items = [];
    }),
    () => {
      report.failures = report.failures.slice(0, Math.floor(report.failures.length / 2));
      report.failuresTruncated = true;
      report.failuresTotal = failuresTotal;
    },
    () => {
      report.failures = [];
      report.failuresTruncated = true;
      report.failuresTotal = failuresTotal;
    },
    () => {
      report.localOnlyReferencesTotal = report.localOnlyReferencesTotal ?? report.localOnlyReferences.length;
      report.localOnlyReferences = [];
    },
    () => {
      if (report.runtime.capabilityModules) {
        report.runtime.capabilityModules.items = [];
        report.runtime.capabilityModules.itemsTruncated = true;
      }
    },
    // Last resort: the runtime detail collapses to its verdict booleans and
    // counts, which are fixed-size, so the report is bounded by construction.
    () => {
      const { runtime } = report;
      report.runtime = {
        declared: runtime.declared,
        expectedMajorVersion: runtime.expectedMajorVersion,
        capabilities: runtime.capabilities.length,
        majorStreamMatches: runtime.majorStreamMatches,
        pointerBehindFallback: runtime.pointerBehindFallback,
        capabilitiesResolvable: runtime.capabilitiesResolvable,
        compatible: runtime.compatible,
        entryOk: Boolean(runtime.entry?.ok),
        detailTruncated: true,
      };
    },
  ];
  for (const step of shed) {
    if (fits()) break;
    step();
  }
  return report;
}
