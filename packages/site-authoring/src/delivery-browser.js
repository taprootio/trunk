import { sanitizeDiagnostic } from "./errors.js";
import { withholdCredentialLocation } from "./staging-check.js";

/**
 * The optional browser dimension of delivery verification (TR00824).
 *
 * HTTP evidence cannot say what a visitor's browser loaded: the shared runtime
 * comes from a mutable major pointer that a returning browser may hold in its
 * cache. This probe drives a real browser at the target twice — a fresh
 * context, then a second navigation in the same context so the browser's own
 * cache participates — and reports which runtime entry each load evaluated,
 * whether the declared capability elements were defined, and whether the
 * second load actually served the runtime entry from cache.
 *
 * Playwright is deliberately not a dependency of this package: basic CLI use
 * must not carry a browser. The probe imports it only if the operator has
 * installed it where this package's imports resolve (a global install of both
 * packages, run through the installed command), and reports the dimension as
 * unchecked with that recovery otherwise.
 *
 * Playwright's own request routing is not used: it disables the HTTP cache,
 * which is the very thing the returning load measures. Instead a DevTools
 * session on the browser itself — not on the page, because a page session
 * sees only its own target and authored script can open a popup — intercepts
 * every document request in the browser (the navigation, each redirect hop,
 * a script-driven navigation, a frame, a popup) at the request stage, before
 * it is transmitted, and fails any that would leave the target origin; the
 * subresource cache is untouched. A page session reports whether the runtime
 * entry came from the memory or disk cache. Without the browser session the
 * boundary cannot be enforced, so the dimension is unchecked rather than
 * probed without it. Every URL the probe reports passes through the
 * credential withholding the staging check uses, so a handoff-bearing
 * redirect never reaches the result. A staging cookie is attached only to the
 * staging origin it was minted for.
 */

// Node resolves `playwright` from the CLI's own dependency chain: a copy run
// through `npx` lives in npm's cache and cannot see a global Playwright, so
// the recovery installs the CLI and Playwright side by side and reruns
// through the installed `taproot-site` command rather than `npx`.
export const BROWSER_INSTALL_HINT = "npm install --global @taprootio/site-authoring@latest playwright && npx playwright install chromium, then rerun with the installed taproot-site command (not npx)";
const SETTLE_MILLISECONDS = 20_000;
const EVIDENCE_CHARACTERS = 512;
const BLOCKED_NAVIGATION = /ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/u;

async function defaultImportPlaywright() {
  return await import("playwright");
}

/** A URL or entry name as evidence: credentials withheld, controls removed, bounded. */
function evidence(value) {
  return [...withholdCredentialLocation(typeof value === "string" ? value : "")].slice(0, EVIDENCE_CHARACTERS).join("");
}

async function observe(page, capabilities) {
  return await page.evaluate((declared) => {
    const root = document.querySelector("esp-root");
    const entries = performance.getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => /taproot-shared-runtime[^/]*\.js(?:$|\?)/u.test(name));
    return {
      rootDefined: customElements.get("esp-root") !== undefined,
      themeReady: root?.hasAttribute("data-theme-ready") ?? false,
      loadingHeld: root?.hasAttribute("data-taproot-loading") ?? false,
      runtimeEntries: entries.slice(0, 4),
      capabilitiesDefined: declared.filter((tag) => customElements.get(tag) !== undefined).length,
      title: document.title,
    };
  }, capabilities);
}

const NOTHING_OBSERVED = Object.freeze({ rootDefined: false, themeReady: false, loadingHeld: false, runtimeEntries: [], capabilitiesDefined: 0 });

/** Every URL the navigation passed through, from the first request to the final document. */
function redirectChain(response) {
  const hops = [];
  let request = response?.request?.();
  while (request && hops.length < 16) {
    hops.unshift(request.url());
    request = request.redirectedFrom?.();
  }
  return hops;
}

function sameOrigin(url, origin) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * The DevTools sessions that enforce the navigation boundary (on the browser,
 * so every target is covered) and observe cache reuse (on the page). Undefined
 * when the browser offers no such sessions.
 */
async function startDevTools(browser, context, page, { origin, expectedEntryUrl }) {
  if (typeof browser.newBrowserCDPSession !== "function" || typeof context.newCDPSession !== "function") return undefined;
  let boundary;
  let session;
  try {
    boundary = await browser.newBrowserCDPSession();
    session = await context.newCDPSession(page);
  } catch {
    return undefined;
  }
  const state = { blocked: [], requests: new Map(), fromCache: undefined };
  boundary.on("Fetch.requestPaused", (event) => {
    const url = event?.request?.url ?? "";
    if (sameOrigin(url, origin)) {
      boundary.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => undefined);
    } else {
      if (state.blocked.length < 8) state.blocked.push(url);
      boundary.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
    }
  });
  session.on("Network.requestWillBeSent", (event) => {
    if (event?.request?.url === expectedEntryUrl) state.requests.set(event.requestId, event.request.url);
  });
  // A memory-cache hit is announced by requestServedFromCache; only a disk
  // (or prefetch) cache hit is visible on the response itself.
  session.on("Network.requestServedFromCache", (event) => {
    if (state.requests.has(event?.requestId)) state.fromCache = true;
  });
  session.on("Network.responseReceived", (event) => {
    if (event?.response?.url !== expectedEntryUrl || state.fromCache === true) return;
    state.fromCache = Boolean(event.response.fromDiskCache || event.response.fromPrefetchCache);
  });
  await session.send("Network.enable");
  await boundary.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] });
  return {
    state,
    reset() {
      state.blocked = [];
      state.requests.clear();
      state.fromCache = undefined;
    },
  };
}

async function load(page, url, capabilities, origin, devtools) {
  devtools.reset();
  let response;
  let blockedNavigation = false;
  try {
    response = await page.goto(url, { waitUntil: "domcontentloaded" });
  } catch (error) {
    // The boundary failed a document request before it was sent; the
    // navigation error is the expected outcome, not a probe failure.
    if (devtools.state.blocked.length === 0 && !BLOCKED_NAVIGATION.test(String(error?.message ?? ""))) throw error;
    blockedNavigation = true;
  }
  if (!blockedNavigation) {
    await page.waitForFunction(
      () => {
        const root = document.querySelector("esp-root");
        return root !== null && !root.hasAttribute("data-taproot-loading");
      },
      undefined,
      { timeout: SETTLE_MILLISECONDS },
    ).catch(() => undefined);
  }
  const hops = blockedNavigation ? [] : [...new Set([...redirectChain(response), page.url()])];
  const strayed = [...new Set([...devtools.state.blocked, ...hops.filter((hop) => !sameOrigin(hop, origin))])];
  const observed = blockedNavigation ? NOTHING_OBSERVED : await observe(page, capabilities);
  return { observed, strayed, finalUrl: blockedNavigation ? "" : page.url() };
}

function judge({ observed, strayed, finalUrl }, expectedEntryUrl, capabilityCount) {
  const loadedEntry = observed.runtimeEntries.find((name) => name === expectedEntryUrl)
    ?? observed.runtimeEntries[0]
    ?? "";
  return {
    loadedEntry: evidence(loadedEntry),
    expectedEntry: observed.runtimeEntries.includes(expectedEntryUrl),
    rootDefined: observed.rootDefined,
    themeReady: observed.themeReady,
    capabilitiesDefined: observed.capabilitiesDefined,
    capabilitiesDeclared: capabilityCount,
    finalUrl: evidence(finalUrl),
    ...(strayed.length > 0 ? { offOriginNavigation: strayed.slice(0, 4).map(evidence) } : {}),
    ok: strayed.length === 0 && observed.rootDefined && observed.themeReady
      && observed.runtimeEntries.includes(expectedEntryUrl)
      && observed.capabilitiesDefined === capabilityCount,
  };
}

/**
 * @param options.baseUrl The delivery origin.
 * @param options.expectedEntryUrl The runtime entry the major pointer names right now.
 * @param options.capabilities Custom-element tags the home page declares.
 * @param options.cookie Optional staging cookie, sent only to `baseUrl`'s host.
 * @param options.importPlaywright Test seam; defaults to a dynamic import.
 */
export async function probeDeliveryWithBrowser({
  baseUrl,
  expectedEntryUrl,
  capabilities = [],
  cookie,
  importPlaywright = defaultImportPlaywright,
}) {
  let playwright;
  try {
    playwright = await importPlaywright();
  } catch {
    return {
      status: "unchecked",
      reason: "playwright_unavailable",
      install: BROWSER_INSTALL_HINT,
      note: "Fresh and returning browser behaviour was not verified; install the CLI and Playwright together and rerun through the installed taproot-site command to check it.",
    };
  }
  const origin = new URL(baseUrl).origin;
  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext();
    if (cookie) {
      const [name, value] = cookie.split("=", 2);
      // A __Host- cookie carries no Domain attribute by definition; the URL
      // form binds it to the staging origin without one.
      await context.addCookies([{ name, value, url: baseUrl, secure: true, httpOnly: true, sameSite: "Lax" }]);
    }
    const page = await context.newPage();
    const devtools = await startDevTools(browser, context, page, { origin, expectedEntryUrl });
    if (!devtools) {
      await context.close();
      return {
        status: "unchecked",
        reason: "navigation_boundary_unavailable",
        note: "The browser offers no DevTools sessions, so document requests could not be held to the site origin; nothing was loaded.",
      };
    }
    const fresh = judge(await load(page, baseUrl, capabilities, origin, devtools), expectedEntryUrl, capabilities.length);
    if (fresh.offOriginNavigation) {
      // A target that leaves its origin is not probed again.
      await context.close();
      return {
        status: "checked",
        fresh,
        returning: { skipped: true, reason: "fresh_load_left_origin", ok: false },
        staleRuntimeObserved: false,
        returningCache: { status: "unchecked", reason: "fresh_load_left_origin" },
        ok: false,
      };
    }
    // The same context navigates again: its HTTP cache now holds whatever the
    // first load fetched, which is exactly what a returning visitor has.
    const returning = judge(await load(page, baseUrl, capabilities, origin, devtools), expectedEntryUrl, capabilities.length);
    const cacheObserved = devtools.state.fromCache;
    await context.close();
    return {
      status: "checked",
      fresh,
      returning: {
        ...returning,
        runtimeFromCache: cacheObserved === undefined ? "unchecked" : cacheObserved,
      },
      staleRuntimeObserved: fresh.ok && !returning.expectedEntry,
      returningCache: cacheObserved === undefined
        ? { status: "unchecked", reason: "cache_observation_unavailable" }
        : { status: "checked", servedFromCache: cacheObserved },
      ok: fresh.ok && returning.ok,
    };
  } catch (error) {
    return {
      status: "failed",
      reason: "browser_probe_failed",
      error: sanitizeDiagnostic(error instanceof Error ? error.name : "Error", "Error"),
      note: "The browser dimension could not be completed and is not verified.",
    };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
