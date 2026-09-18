import assert from "node:assert/strict";
import test from "node:test";

import { BROWSER_INSTALL_HINT, probeDeliveryWithBrowser } from "../src/delivery-browser.js";
import { checkDelivery, compareVersions, DELIVERY_LIMITS, discoverReferences, parseBootstrap } from "../src/delivery-check.js";

const ORIGIN = "https://site.example.test";
const RUNTIME = "https://static.example.test/taproot/5/latest.json";
const FALLBACK = `${ORIGIN}/public/taproot-runtime-fallback/5.0.35/manifest.json`;
const ENTRY = "https://static.example.test/taproot/5/taproot-shared-runtime-abc.esm.js";
const CAPABILITY = "https://static.example.test/taproot/5/chunks/taproot-image-banner-1.js";

function bootstrap(overrides = {}) {
  return JSON.stringify({
    runtimeMajorVersion: "5",
    runtimeManifestUrl: RUNTIME,
    fallbackRuntimeManifestUrl: "/public/taproot-runtime-fallback/5.0.35/manifest.json",
    siteBundleUrl: "/public/main.root-DNz.js",
    runtimeCapabilities: ["taproot-image-banner"],
    ...overrides,
  }).replaceAll("</", "<\\/");
}

function html({ boot = bootstrap(), links = ["/about/"], images = ["/public/hero.webp"], extra = "" } = {}) {
  return `<!doctype html><html><head><title>Home</title>
<link rel="icon" href="/favicon.ico">
<link rel="modulepreload" href="/public/main.root-DNz.js">
<script type="application/json" id="taproot-runtime-bootstrap">${boot}</script>
</head><body><esp-root>${images.map((src) => `<img src="${src}" alt="">`).join("")}
${links.map((href) => `<a href="${href}">link</a>`).join("")}${extra}</body></html>`;
}

/** A delivery target: a map of URL → { status, type, body, headers }. */
function server(entries, { failuresBeforeSuccess = {} } = {}) {
  const calls = [];
  const remaining = { ...failuresBeforeSuccess };
  const fetchImpl = async (url, init) => {
    calls.push({ url, cookie: init?.headers?.cookie });
    if ((remaining[url] ?? 0) > 0) {
      remaining[url] -= 1;
      throw new TypeError("fetch failed");
    }
    const entry = entries[url];
    if (!entry) return new Response("<h1>Not found</h1>", { status: 404, headers: { "content-type": "text/html" } });
    return new Response(entry.body ?? "", {
      status: entry.status ?? 200,
      headers: { "content-type": entry.type ?? "text/html; charset=utf-8", ...(entry.headers ?? {}) },
    });
  };
  return { calls, fetch: fetchImpl };
}

const manifests = (pointerVersion = "5.0.35", fallbackVersion = "5.0.35") => ({
  [RUNTIME]: {
    type: "application/json",
    body: JSON.stringify({
      version: pointerVersion,
      majorVersion: "5",
      entry: "taproot-shared-runtime-abc.esm.js",
      capabilities: { "taproot-image-banner": "chunks/taproot-image-banner-1.js" },
    }),
    headers: { "cache-control": "public, max-age=0, s-maxage=60" },
  },
  [FALLBACK]: { type: "application/json", body: JSON.stringify({ version: fallbackVersion, majorVersion: "5", entry: "x.js", capabilities: {} }) },
  [ENTRY]: { type: "text/javascript", body: "export {};" },
  [CAPABILITY]: { type: "text/javascript", body: "export {};" },
});

function healthy(overrides = {}) {
  return {
    [`${ORIGIN}/`]: { body: html() },
    [`${ORIGIN}/about/`]: { body: html({ links: ["/"] }) },
    [`${ORIGIN}/favicon.ico`]: { type: "image/x-icon", body: "ico" },
    [`${ORIGIN}/public/main.root-DNz.js`]: { type: "text/javascript", body: "export {};" },
    [`${ORIGIN}/public/hero.webp`]: { type: "image/webp", body: "webp" },
    ...manifests(),
    ...overrides,
  };
}

const timeoutSignal = () => AbortSignal.timeout(5_000);
const noSleep = async () => undefined;

test("a delivered deployment verifies routes, assets, links and the declared runtime", async () => {
  const { fetch, calls } = server(healthy());
  const report = await checkDelivery({ fetch, timeoutSignal, baseUrl: `${ORIGIN}/`, routes: ["/about/"], sleep: noSleep });
  assert.equal(report.verdict, "delivered");
  assert.deepEqual(report.failures, []);
  assert.equal(report.routes.checked, 2);
  assert.equal(report.routes.failed, 0);
  assert.deepEqual(report.assets.items.map((item) => item.kind).sort(), ["favicon", "image", "site-bundle"]);
  assert.equal(report.assets.failed, 0);
  assert.equal(report.runtime.compatible, true);
  assert.equal(report.runtime.majorStreamMatches, true);
  assert.equal(report.runtime.pointerBehindFallback, false);
  assert.equal(report.runtime.entry.ok, true);
  assert.equal(report.runtime.majorPointer.cacheControl, "public, max-age=0, s-maxage=60");
  assert.equal(report.propagation.waitedSeconds, 0);
  assert.deepEqual(report.localOnlyReferences, []);
  // Read-only: only GETs, nothing followed off the site or the static origin.
  assert.ok(calls.every((call) => call.url.startsWith(ORIGIN) || call.url.startsWith("https://static.example.test/")));
});

test("a missing asset and a wrong content type are reported with observed and expected values", async () => {
  const { fetch } = server(healthy({
    [`${ORIGIN}/favicon.ico`]: undefined,
    [`${ORIGIN}/public/hero.webp`]: { type: "text/html", body: "<h1>Sorry</h1>" },
  }));
  const report = await checkDelivery({ fetch, timeoutSignal, baseUrl: `${ORIGIN}/`, sleep: noSleep });
  assert.equal(report.verdict, "degraded");
  const favicon = report.assets.items.find((item) => item.kind === "favicon");
  assert.equal(favicon.status, 404);
  assert.equal(favicon.failure, "http_404");
  const image = report.assets.items.find((item) => item.kind === "image");
  assert.equal(image.status, 200);
  assert.equal(image.contentType, "text/html");
  assert.equal(image.expectedContentType, "image/*");
  assert.equal(image.failure, "wrong_content_type");
  assert.ok(report.failures.some((line) => /favicon .*http_404/u.test(line)));
  assert.ok(report.failures.some((line) => /image .*wrong_content_type/u.test(line)));
});

test("a stale major pointer is reported as behind the fallback the site shipped with", async () => {
  const { fetch } = server(healthy(manifests("5.0.15", "5.0.35")));
  const report = await checkDelivery({ fetch, timeoutSignal, baseUrl: `${ORIGIN}/`, sleep: noSleep });
  assert.equal(report.runtime.pointerBehindFallback, true);
  assert.equal(report.runtime.compatible, true);
  assert.equal(report.verdict, "degraded");
  assert.ok(report.failures.some((line) => /major pointer \(5\.0\.15\) is behind the fallback .*\(5\.0\.35\)/u.test(line)));
});

test("a major stream mismatch, a missing capability module and a missing entry make the runtime incompatible", async () => {
  const { fetch } = server(healthy({
    [RUNTIME]: {
      type: "application/json",
      body: JSON.stringify({ version: "6.0.0", majorVersion: "6", entry: "missing.js", capabilities: {} }),
    },
  }));
  const report = await checkDelivery({ fetch, timeoutSignal, baseUrl: `${ORIGIN}/`, sleep: noSleep });
  assert.equal(report.runtime.majorStreamMatches, false);
  assert.equal(report.runtime.capabilitiesResolvable, false);
  assert.equal(report.runtime.entry.ok, false);
  assert.equal(report.runtime.compatible, false);
  assert.equal(report.verdict, "failed");
  assert.ok(report.failures.some((line) => /serves major 6, the page expects 5/u.test(line)));
});

test("a route that redirects or answers an error is not delivered, and retries are truthful", async () => {
  const { fetch, calls } = server(
    healthy({
      [`${ORIGIN}/about/`]: { status: 301, headers: { location: `${ORIGIN}/about` }, body: "" },
      [`${ORIGIN}/broken/`]: { status: 503, type: "text/html", body: "down" },
    }),
    { failuresBeforeSuccess: { [`${ORIGIN}/public/hero.webp`]: 1 } },
  );
  const report = await checkDelivery({ fetch, timeoutSignal, baseUrl: `${ORIGIN}/`, routes: ["/about/", "/broken/"], sleep: noSleep });
  const about = report.routes.items.find((item) => item.path === "/about/");
  assert.equal(about.failure, "redirected");
  assert.equal(about.location, `${ORIGIN}/about`);
  const broken = report.routes.items.find((item) => item.path === "/broken/");
  assert.equal(broken.failure, "http_503");
  assert.equal(broken.attempts, DELIVERY_LIMITS.attempts);
  const image = report.assets.items.find((item) => item.kind === "image");
  assert.equal(image.ok, true);
  assert.equal(image.attempts, 2);
  assert.equal(calls.filter((call) => call.url === `${ORIGIN}/public/hero.webp`).length, 2);
  assert.equal(report.verdict, "failed");
});

test("a bounded propagation wait observes once more and records the wait", async () => {
  const entries = healthy({ [`${ORIGIN}/late/`]: { status: 404, body: "" } });
  const { fetch, calls } = server(entries);
  let slept = 0;
  const report = await checkDelivery({
    fetch,
    timeoutSignal,
    baseUrl: `${ORIGIN}/`,
    routes: ["/late/"],
    propagationWaitSeconds: 500,
    sleep: async (milliseconds) => {
      slept += milliseconds;
      // The route lands during the wait.
      entries[`${ORIGIN}/late/`] = { body: html({ links: [] }) };
    },
  });
  assert.equal(report.propagation.waitedSeconds, DELIVERY_LIMITS.propagationWaitMaximumSeconds);
  assert.equal(report.propagation.reobservedAfterSeconds, DELIVERY_LIMITS.propagationWaitMaximumSeconds);
  assert.equal(slept, DELIVERY_LIMITS.propagationWaitMaximumSeconds * 1000);
  const late = report.routes.items.find((item) => item.path === "/late/");
  assert.equal(late.ok, true);
  assert.equal(late.failure, undefined);
  assert.equal(report.verdict, "delivered");
  // Exactly two observations, never a loop.
  assert.equal(calls.filter((call) => call.url === `${ORIGIN}/late/`).length, 2);
});

test("local-only references and the staging cookie boundary are enforced", async () => {
  const { fetch, calls } = server(healthy({
    [`${ORIGIN}/`]: {
      body: html({
        extra: "<img src=\"http://localhost:3000/dev.png\"><a href=\"https://app.taproot.test/x\">app</a>"
          + "<img src=\"https://169.254.169.254/latest/meta-data\"><link rel=\"icon\" href=\"https://cdn.example.net/icon.png\">",
      }),
    },
  }));
  const report = await checkDelivery({
    fetch,
    timeoutSignal,
    baseUrl: `${ORIGIN}/`,
    cookie: "__Host-taproot_staging_preview=secret",
    sleep: noSleep,
  });
  assert.deepEqual(report.localOnlyReferences, ["http://localhost:3000/dev.png", "https://app.taproot.test/x"]);
  assert.equal(report.target.stagingAuthorized, true);
  assert.ok(report.failures.some((line) => /local-only reference/u.test(line)));
  // The cookie goes to the site origin only, never to the static origin, and
  // neither the local-only URLs nor any other host's assets are fetched.
  for (const call of calls) {
    assert.equal(call.cookie === "__Host-taproot_staging_preview=secret", call.url.startsWith(ORIGIN), call.url);
    assert.ok(!call.url.startsWith("http://localhost"), call.url);
    assert.ok(!call.url.includes("169.254.169.254") && !call.url.includes("cdn.example.net"), call.url);
  }
  assert.ok(report.assets.items.every((item) => item.url.startsWith(ORIGIN)));
});

test("a redirect Location that could reflect a credential is withheld and bodies are read within the bound", async () => {
  const big = "x".repeat(DELIVERY_LIMITS.manifestBytes + 1);
  const { fetch } = server(healthy({
    [`${ORIGIN}/about/`]: {
      status: 302,
      body: "",
      headers: { location: `${ORIGIN}/?__taproot_preview_handoff=${"A".repeat(43)}` },
    },
    // No Content-Length is declared by the fake, so only the streamed bound protects the reader.
    [RUNTIME]: { type: "application/json", body: big },
  }));
  const report = await checkDelivery({ fetch, timeoutSignal, baseUrl: `${ORIGIN}/`, routes: ["/about/"], sleep: noSleep });
  const about = report.routes.items.find((item) => item.path === "/about/");
  assert.equal(about.failure, "redirected");
  assert.equal(about.location, "[withheld]");
  assert.ok(!JSON.stringify(report).includes("A".repeat(43)));
  assert.equal(report.runtime.majorPointer.failure, "body_too_large");
  assert.equal(report.runtime.majorPointer.ok, false);
});

test("sampling is bounded and reported", async () => {
  const routes = Array.from({ length: 30 }, (_, index) => `/page-${index}/`);
  const entries = healthy();
  for (const [index, path] of routes.entries()) {
    // Every page carries its own images; the sample across routes stays at the bound.
    const images = [`/public/${index}-a.webp`, `/public/${index}-b.webp`];
    for (const image of images) entries[`${ORIGIN}${image}`] = { type: "image/webp", body: "webp" };
    entries[`${ORIGIN}${path}`] = { body: html({ links: [], images }) };
  }
  const { fetch, calls } = server(entries);
  const report = await checkDelivery({ fetch, timeoutSignal, baseUrl: `${ORIGIN}/`, routes, sleep: noSleep });
  assert.equal(report.routes.checked, DELIVERY_LIMITS.routes);
  assert.equal(report.routes.truncated, true);
  assert.equal(report.routes.requested, 31);
  assert.equal(report.assets.items.filter((item) => item.kind === "image").length, DELIVERY_LIMITS.images);
  assert.equal(calls.filter((call) => /\.webp$/u.test(call.url)).length, DELIVERY_LIMITS.images);
});

test("references that could leave the origin are never reconstructed into another host, and attributes are read as a browser would", async () => {
  const page = `${ORIGIN}/`;
  const references = discoverReferences(
    "<a href=\"https://site.example.test//127.0.0.1/private\">x</a><a href=\"/ok/\">y</a><a href='/single/'>z</a>"
      + "<a href=\"/x?a=1&amp;b=2\">q</a><a href=\"/back\\slash/\">b</a>"
      + "<img data-src=\"/valid.png\" src=\"/broken.png\"><img src='/other.png'><img src=\"/x?a=1&amp;b=2\"><img data-src=\"/only-data.png\">",
    page,
  );
  assert.deepEqual(references.internalLinks, [`${ORIGIN}/ok/`, `${ORIGIN}/single/`]);
  assert.deepEqual(references.images, [`${ORIGIN}/broken.png`, `${ORIGIN}/other.png`, `${ORIGIN}/x?a=1&b=2`]);
  const { fetch, calls } = server(healthy({
    [`${ORIGIN}/`]: { body: html({ links: ["https://site.example.test//127.0.0.1/private", "//127.0.0.1/private"] }) },
  }));
  await checkDelivery({ fetch, timeoutSignal, baseUrl: `${ORIGIN}/`, routes: ["//127.0.0.1/private", "/back\\slash/"], sleep: noSleep }).then((report) => {
    assert.ok(calls.every((call) => call.url.startsWith(ORIGIN) || call.url.startsWith("https://static.example.test/")), JSON.stringify(calls.map((c) => c.url)));
    assert.equal(report.links.checked, 0);
    const invalid = report.routes.items.filter((item) => item.failure === "invalid_route");
    assert.equal(invalid.length, 2);
  });
});

test("runtime delivery probes the declared capability modules and reports a broken fallback", async () => {
  const { fetch } = server(healthy({
    [RUNTIME]: {
      type: "application/json",
      body: JSON.stringify({
        version: "5.0.35",
        majorVersion: "5",
        entry: "taproot-shared-runtime-abc.esm.js",
        capabilities: { "taproot-image-banner": "chunks/missing.js" },
      }),
    },
    [FALLBACK]: undefined,
  }));
  const report = await checkDelivery({ fetch, timeoutSignal, baseUrl: `${ORIGIN}/`, sleep: noSleep });
  assert.equal(report.runtime.capabilityModules.checked, 1);
  assert.equal(report.runtime.capabilityModules.failed, 1);
  assert.equal(report.runtime.capabilityModules.items[0].failure, "http_404");
  assert.equal(report.runtime.capabilitiesResolvable, false);
  assert.equal(report.runtime.fallback.ok, false);
  assert.ok(report.failures.some((line) => /fallback .*http_404/u.test(line)));
  assert.ok(report.failures.some((line) => /did not load/u.test(line)));
  assert.equal(report.verdict, "failed");
});

test("a propagation wait re-observes everything so recovered rows and a recovered bootstrap replace the old findings", async () => {
  const entries = healthy({ [`${ORIGIN}/`]: { body: "<html><body>not ready</body></html>" }, [`${ORIGIN}/public/hero.webp`]: undefined });
  const { fetch } = server(entries);
  const report = await checkDelivery({
    fetch,
    timeoutSignal,
    baseUrl: `${ORIGIN}/`,
    propagationWaitSeconds: 30,
    sleep: async () => {
      entries[`${ORIGIN}/`] = { body: html() };
      entries[`${ORIGIN}/public/hero.webp`] = { type: "image/webp", body: "webp" };
    },
  });
  assert.equal(report.verdict, "delivered", JSON.stringify(report.failures));
  assert.equal(report.assets.failed, 0);
  assert.ok(report.assets.items.every((item) => item.failure === undefined));
  assert.equal(report.runtime.declared, true);
  assert.equal(report.propagation.reobservedAfterSeconds, 30);
});

test("a body that fails mid-stream is a recorded, retried failure rather than an abort", async () => {
  let served = 0;
  const failing = () => {
    served += 1;
    const stream = new ReadableStream({
      pull(controller) {
        controller.error(new Error("connection reset"));
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/html" } });
  };
  const entries = healthy();
  const base = server(entries);
  const fetchImpl = async (url, init) => (url === `${ORIGIN}/about/` ? failing() : base.fetch(url, init));
  const report = await checkDelivery({ fetch: fetchImpl, timeoutSignal, baseUrl: `${ORIGIN}/`, routes: ["/about/"], sleep: noSleep });
  const about = report.routes.items.find((item) => item.path === "/about/");
  assert.equal(about.failure, "read_failed");
  assert.equal(about.attempts, DELIVERY_LIMITS.attempts);
  assert.equal(served, DELIVERY_LIMITS.attempts);
  assert.equal(report.verdict, "failed");
});

test("the report stays inside its byte budget with failures first", async () => {
  const longPath = `/public/${"x".repeat(70_000)}.webp`;
  const entries = healthy({ [`${ORIGIN}/`]: { body: html({ images: [longPath] }) } });
  const { fetch } = server(entries);
  const report = await checkDelivery({ fetch, timeoutSignal, baseUrl: `${ORIGIN}/`, sleep: noSleep });
  const serialized = JSON.stringify(report);
  assert.ok(serialized.length < 48 * 1024, String(serialized.length));
  const image = report.assets.items.find((item) => item.kind === "image");
  assert.ok(image.url.length <= DELIVERY_LIMITS.urlScalars);
  assert.equal(image.failure, "http_404");
  assert.equal(report.assets.items[0].ok, false);
});

test("an https origin is required and the bootstrap and reference parsers are defensive", async () => {
  await assert.rejects(
    () => checkDelivery({ fetch: async () => new Response(""), timeoutSignal, baseUrl: "http://site.example/", sleep: noSleep }),
    (error) => error?.code === "delivery.target_invalid",
  );
  assert.equal(parseBootstrap("<html></html>"), undefined);
  assert.equal(parseBootstrap("<script id=\"taproot-runtime-bootstrap\" type=\"application/json\">{nope</script>"), undefined);
  assert.deepEqual(parseBootstrap(html()).runtimeCapabilities, ["taproot-image-banner"]);
  const references = discoverReferences(html({ links: ["/a/", "/a/?x=1", "/_taproot/x", "mailto:a@b"] }), `${ORIGIN}/`);
  assert.deepEqual(references.internalLinks, [`${ORIGIN}/a/`]);
  assert.equal(compareVersions("5.0.15", "5.0.35"), -1);
  assert.equal(compareVersions("5.0.35", "5.0.35"), 0);
  assert.equal(compareVersions("5.1.0", "5.0.35"), 1);
  assert.equal(compareVersions("x", "5.0.35"), undefined);
});

/**
 * A fake Chromium: `goto` walks the navigation's hops, asking the DevTools
 * Fetch interceptor about each document request before "transmitting" it, and
 * announces the runtime entry's response with real CDP event shapes.
 */
/**
 * A fake Chromium: `goto` walks the navigation's hops, asking the browser-level
 * DevTools Fetch interceptor about each document request before
 * "transmitting" it, and announces the runtime entry's response on the page
 * session with real CDP event shapes.
 */
function fakeBrowser({ observations, hops = [`${ORIGIN}/`], cdp = true, browserCdp = cdp, entryResponses = [] }) {
  const cookies = [];
  const listeners = new Map();
  const cdpCommands = [];
  const browserCommands = [];
  const transmitted = [];
  let loads = 0;
  let nextRequestId = 1;
  const emit = (event, payload) => listeners.get(event)?.(payload);
  const session = (commands) => ({
    send: async (method, params) => {
      commands.push({ method, params });
    },
    on: (event, listener) => listeners.set(event, listener),
  });
  const playwright = {
    chromium: {
      launch: async () => ({
        ...(browserCdp ? { newBrowserCDPSession: async () => session(browserCommands) } : {}),
        newContext: async () => ({
          addCookies: async (values) => cookies.push(...values),
          ...(cdp ? { newCDPSession: async () => session(cdpCommands) } : {}),
          newPage: async () => {
            let currentUrl = "about:blank";
            return {
              goto: async () => {
                const chain = [];
                for (const hop of hops) {
                  const requestId = `interception-${nextRequestId++}`;
                  const before = browserCommands.length;
                  emit("Fetch.requestPaused", { requestId, request: { url: hop }, resourceType: "Document" });
                  const decision = browserCommands.slice(before).find((command) => command.params?.requestId === requestId);
                  if (decision?.method === "Fetch.failRequest") throw new Error("page.goto: net::ERR_BLOCKED_BY_CLIENT");
                  transmitted.push(hop);
                  const request = { url: () => hop };
                  if (chain.length > 0) request.redirectedFrom = () => chain.at(-1);
                  chain.push(request);
                }
                currentUrl = hops.at(-1);
                const entry = entryResponses[loads];
                loads += 1;
                if (entry) {
                  const requestId = `entry-${loads}`;
                  emit("Network.requestWillBeSent", { requestId, request: { url: ENTRY } });
                  if (entry === "memory") emit("Network.requestServedFromCache", { requestId });
                  emit("Network.responseReceived", {
                    requestId,
                    response: { url: ENTRY, fromDiskCache: entry === "disk", fromServiceWorker: entry === "service-worker" },
                  });
                }
                return { request: () => chain.at(-1) };
              },
              url: () => currentUrl,
              waitForFunction: async () => undefined,
              evaluate: async () => observations.shift(),
            };
          },
          close: async () => undefined,
        }),
        close: async () => undefined,
      }),
    },
  };
  return { playwright, cookies, cdpCommands, browserCommands, transmitted };
}

const healthyObservation = () => ({ rootDefined: true, themeReady: true, loadingHeld: false, runtimeEntries: [ENTRY], capabilitiesDefined: 1 });

test("the browser dimension is unchecked without Playwright and reports fresh and returning loads with it", async () => {
  const unchecked = await probeDeliveryWithBrowser({
    baseUrl: `${ORIGIN}/`,
    expectedEntryUrl: ENTRY,
    importPlaywright: async () => {
      throw new Error("Cannot find package 'playwright'");
    },
  });
  assert.equal(unchecked.status, "unchecked");
  assert.equal(unchecked.reason, "playwright_unavailable");
  assert.equal(unchecked.install, BROWSER_INSTALL_HINT);

  // A fake browser whose second (cached) navigation evaluates an older runtime.
  const { playwright, cookies, cdpCommands, browserCommands } = fakeBrowser({
    observations: [healthyObservation(), { ...healthyObservation(), runtimeEntries: [ENTRY.replace("abc", "old")] }],
    entryResponses: ["network", "disk"],
  });
  const checked = await probeDeliveryWithBrowser({
    baseUrl: `${ORIGIN}/`,
    expectedEntryUrl: ENTRY,
    capabilities: ["taproot-image-banner"],
    cookie: "__Host-taproot_staging_preview=secret",
    importPlaywright: async () => playwright,
  });
  assert.equal(checked.status, "checked");
  assert.equal(checked.fresh.ok, true);
  assert.equal(checked.returning.ok, false);
  assert.equal(checked.staleRuntimeObserved, true);
  assert.equal(checked.ok, false);
  // The boundary is armed on the browser (every target, popups included) before the first navigation:
  // document requests only, at the request stage; the page session only observes the network.
  assert.deepEqual(cdpCommands.map((command) => command.method), ["Network.enable"]);
  assert.equal(browserCommands[0].method, "Fetch.enable");
  assert.deepEqual(browserCommands[0].params.patterns, [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }]);
  assert.deepEqual(checked.returningCache, { status: "checked", servedFromCache: true });
  assert.equal(checked.returning.runtimeFromCache, true);
  // A __Host- cookie is bound by URL, never by a Domain attribute.
  assert.equal(cookies[0].url, `${ORIGIN}/`);
  assert.equal(cookies[0].domain, undefined);
  assert.equal(cookies[0].value, "secret");
});

test("the browser probe fails an off-origin document request before it is sent and skips the returning load", async () => {
  // The edge answers the home page with a redirect to another host, carrying a handoff token.
  const strayed = fakeBrowser({
    observations: [healthyObservation(), healthyObservation()],
    hops: [`${ORIGIN}/`, "https://other-host.example/landing?__taproot_preview_handoff=tok-123", "https://other-host.example/final"],
  });
  const report = await probeDeliveryWithBrowser({
    baseUrl: `${ORIGIN}/`,
    expectedEntryUrl: ENTRY,
    capabilities: ["taproot-image-banner"],
    importPlaywright: async () => strayed.playwright,
  });
  assert.equal(report.status, "checked");
  assert.equal(report.fresh.ok, false);
  assert.deepEqual(report.fresh.offOriginNavigation, ["[withheld]"]);
  assert.equal(report.fresh.finalUrl, "");
  assert.deepEqual(report.returning, { skipped: true, reason: "fresh_load_left_origin", ok: false });
  assert.equal(report.returningCache.status, "unchecked");
  assert.equal(report.ok, false);
  // The external destination received nothing: only the same-origin hop was transmitted.
  assert.deepEqual(strayed.transmitted, [`${ORIGIN}/`]);
  assert.ok(!JSON.stringify(report).includes("tok-123"));

  // A same-origin redirect chain is fine; a handoff-bearing same-origin final URL is still withheld.
  const plain = fakeBrowser({
    observations: [healthyObservation(), healthyObservation()],
    hops: [`${ORIGIN}/`, `${ORIGIN}/?__taproot_preview_handoff=tok-456`],
    entryResponses: ["network", "memory"],
  });
  const fine = await probeDeliveryWithBrowser({
    baseUrl: `${ORIGIN}/`,
    expectedEntryUrl: ENTRY,
    capabilities: ["taproot-image-banner"],
    importPlaywright: async () => plain.playwright,
  });
  assert.equal(fine.ok, true);
  assert.equal(fine.fresh.offOriginNavigation, undefined);
  assert.equal(fine.fresh.finalUrl, "[withheld]");
  assert.ok(!JSON.stringify(fine).includes("tok-456"));
  // A memory-cache hit is announced by requestServedFromCache, not by the response.
  assert.deepEqual(fine.returningCache, { status: "checked", servedFromCache: true });

  // A service-worker or network response on the returning load is not cache reuse.
  const uncached = fakeBrowser({ observations: [healthyObservation(), healthyObservation()], entryResponses: ["network", "service-worker"] });
  const fresh = await probeDeliveryWithBrowser({ baseUrl: `${ORIGIN}/`, expectedEntryUrl: ENTRY, capabilities: ["taproot-image-banner"], importPlaywright: async () => uncached.playwright });
  assert.deepEqual(fresh.returningCache, { status: "checked", servedFromCache: false });

  // Without a browser-level DevTools session the boundary cannot be enforced, so nothing is loaded.
  for (const options of [{ cdp: false }, { cdp: true, browserCdp: false }]) {
    const blind = fakeBrowser({ observations: [healthyObservation(), healthyObservation()], ...options });
    const unchecked = await probeDeliveryWithBrowser({ baseUrl: `${ORIGIN}/`, expectedEntryUrl: ENTRY, importPlaywright: async () => blind.playwright });
    assert.equal(unchecked.status, "unchecked");
    assert.equal(unchecked.reason, "navigation_boundary_unavailable");
    assert.deepEqual(blind.transmitted, []);
  }
});

test("the reference scanner ignores comments and raw text, reads attributes in order, and never throws on entities", () => {
  const page = `${ORIGIN}/`;
  const markup = html({
    images: ["/real.png"],
    extra: [
      "<!-- <img src=\"/commented.png\"> <a href=\"/commented/\">x</a> -->",
      "<script>const s = '<img src=\"/scripted.png\">';</script>",
      "<style>/* <a href=\"/styled/\"> */</style>",
      "<textarea><img src=\"/typed.png\"></textarea>",
      "<img alt='say src=\"/wrong.png\"' src=\"/quoted.png\">",
      "<img src=\"/&#1114112;.png\">",
      "<img src=\"/&#xD800;.png\">",
      "<img data-src=\"/lazy.png\" src=/bare.png>",
    ].join(""),
  });
  const references = discoverReferences(markup, page);
  assert.deepEqual(references.images, [
    `${ORIGIN}/real.png`,
    `${ORIGIN}/quoted.png`,
    `${ORIGIN}/%EF%BF%BD.png`,
    `${ORIGIN}/bare.png`,
  ]);
  assert.deepEqual(references.internalLinks, [`${ORIGIN}/about/`]);
  // A bootstrap inside a comment is not the page's bootstrap.
  assert.equal(parseBootstrap(`<!-- <script id="taproot-runtime-bootstrap">${bootstrap()}</script> -->`), undefined);
  assert.equal(parseBootstrap(`<!-- old --><script id="taproot-runtime-bootstrap">${bootstrap()}</script>`).runtimeMajorVersion, "5");
  // Bootstrap strings are bounded.
  const long = parseBootstrap(`<script id="taproot-runtime-bootstrap">${bootstrap({ runtimeMajorVersion: "9".repeat(100), runtimeCapabilities: ["x".repeat(500), "bad\u0007tag", "taproot-ok"] })}</script>`);
  assert.equal(long.runtimeMajorVersion.length, 16);
  assert.deepEqual(long.runtimeCapabilities, ["taproot-ok"]);
  assert.equal(long.capabilitiesDropped, 2);
  // A quoted attribute value may hold ">" without ending the tag, and a
  // bootstrap inside a raw-text element is text, not the page's bootstrap.
  const quoted = discoverReferences(html({ images: [], extra: "<img alt=\"A > B\" src=\"/missing.png\"><img alt='x' src=\"/next.png\">" }), page);
  assert.deepEqual(quoted.images, [`${ORIGIN}/missing.png`, `${ORIGIN}/next.png`]);
  assert.equal(parseBootstrap(`<textarea><script id="taproot-runtime-bootstrap">${bootstrap()}</script></textarea>`), undefined);
  assert.equal(parseBootstrap(`<title><script id="taproot-runtime-bootstrap">${bootstrap()}</script></title><script id="taproot-runtime-bootstrap">${bootstrap({ runtimeMajorVersion: "7" })}</script>`).runtimeMajorVersion, "7");
  // An unterminated comment or tag ends the live document rather than inventing a reference.
  assert.deepEqual(discoverReferences("<!-- <img src=\"/a.png\">", page).images, []);
  assert.deepEqual(discoverReferences("<img src=\"/a.png\"><img src=\"/b.png", page).images, [`${ORIGIN}/a.png`]);
  // Script bodies with a closing tag spelled differently still end where a browser ends them.
  assert.deepEqual(discoverReferences("<script>'<img src=\"/s.png\">'</SCRIPT ><img src=\"/after.png\">", page).images, [`${ORIGIN}/after.png`]);
  // Names that exist on Object's prototype are ordinary markup, not table hits.
  assert.deepEqual(
    discoverReferences("<constructor><img src=\"/c.png\"></constructor><hasOwnProperty><a href=\"/own/\">x</a><img src=\"/&constructor;.png\">", page).images,
    [`${ORIGIN}/c.png`, `${ORIGIN}/&constructor;.png`],
  );
  assert.deepEqual(discoverReferences("<__proto__><a href=\"/proto/\">x</a>", page).internalLinks, [`${ORIGIN}/proto/`]);
  // A URL that could carry a handoff is withheld wherever it is reported.
  assert.deepEqual(discoverReferences("<img src=\"http://localhost:3000/x?__taproot_preview_handoff=t\">", page).localOnly, ["http://localhost:3000/x?__taproot_preview_handoff=t"]);
});

test("the whole report stays inside its bound however large the runtime detail and reference lists get", async () => {
  const wide = "\u{1F600}".repeat(2_000);
  const localLinks = Array.from({ length: 20 }, (_, index) => `<a href="https://dev-${index}.taproot.test/${"p".repeat(600)}">x</a>`);
  const links = Array.from({ length: DELIVERY_LIMITS.links }, (_, index) => `/gone-${"g".repeat(400)}-${index}/`);
  const declared = Array.from({ length: 64 }, (_, index) => `taproot-${"c".repeat(50)}-${index}`);
  const capabilities = Object.fromEntries(declared.map((tag) => [tag, `chunks/${tag}-${"m".repeat(400)}.js`]));
  const entries = healthy({
    [`${ORIGIN}/`]: { body: html({ links, boot: bootstrap({ runtimeCapabilities: declared }), extra: localLinks.join("") }) },
    [RUNTIME]: {
      type: "application/json",
      body: JSON.stringify({ version: wide, majorVersion: wide, entry: `${wide}.js`, capabilities }),
      headers: { "cache-control": wide },
    },
  });
  const { fetch } = server(entries);
  const report = await checkDelivery({ fetch, timeoutSignal, baseUrl: `${ORIGIN}/`, routes: Array.from({ length: 19 }, (_, index) => `/m-${"r".repeat(400)}-${index}/`), sleep: noSleep });
  assert.ok(Buffer.byteLength(JSON.stringify(report), "utf8") <= DELIVERY_LIMITS.outputBytes, String(Buffer.byteLength(JSON.stringify(report), "utf8")));
  assert.equal(report.verdict, "failed");
  assert.ok(report.failuresTotal >= 19 + DELIVERY_LIMITS.links + 20, String(report.failuresTotal));
  assert.equal(report.runtime.declared, true);
  assert.equal(report.runtime.compatible, false);
  // Withholding also applies to a URL string that could reflect a credential.
  assert.ok(!JSON.stringify(report).includes("__taproot_preview_handoff=leak"));
});

test("a redirect Location on an asset that carries a handoff is withheld in the report", async () => {
  const { fetch } = server(healthy({
    [`${ORIGIN}/public/hero.webp`]: { status: 302, headers: { location: `${ORIGIN}/public/hero.webp?__taproot_preview_handoff=leak` } },
  }));
  const report = await checkDelivery({ fetch, timeoutSignal, baseUrl: `${ORIGIN}/`, sleep: noSleep });
  const image = report.assets.items.find((item) => item.kind === "image");
  assert.equal(image.failure, "redirected");
  assert.equal(image.location, "[withheld]");
  assert.ok(!JSON.stringify(report).includes("leak"));
});

test("a capability module with an invalid or disallowed URL is a failed observation, and modules past the bound are unchecked", async () => {
  const declared = Array.from({ length: DELIVERY_LIMITS.capabilities + 2 }, (_, index) => `taproot-cap-${index}`);
  const capabilities = Object.fromEntries(declared.map((tag) => [tag, `chunks/${tag}.js`]));
  capabilities["taproot-cap-0"] = "https://untrusted.example/evil.js";
  capabilities["taproot-cap-1"] = "https://user:pw@static.example.test/creds.js";
  const entries = healthy({
    [`${ORIGIN}/`]: { body: html({ boot: bootstrap({ runtimeCapabilities: declared }) }) },
    [RUNTIME]: {
      type: "application/json",
      body: JSON.stringify({ version: "5.0.35", majorVersion: "5", entry: "taproot-shared-runtime-abc.esm.js", capabilities }),
    },
  });
  for (const tag of declared) entries[`https://static.example.test/taproot/5/chunks/${tag}.js`] = { type: "text/javascript", body: "export {};" };
  const { fetch, calls } = server(entries);
  const report = await checkDelivery({ fetch, timeoutSignal, baseUrl: `${ORIGIN}/`, sleep: noSleep });
  assert.equal(report.verdict, "failed");
  assert.equal(report.runtime.capabilitiesResolvable, false);
  assert.equal(report.runtime.majorPointer.declaredCapabilities, declared.length);
  assert.equal(report.runtime.majorPointer.resolvableCapabilities, declared.length - 2);
  const failures = Object.fromEntries(report.runtime.capabilityModules.items.map((item) => [item.tag, item.failure]));
  assert.equal(failures["taproot-cap-0"], "origin_not_allowed");
  assert.equal(failures["taproot-cap-1"], "invalid_url");
  assert.equal(report.runtime.capabilityModules.failed, 2);
  assert.equal(report.runtime.capabilityModules.checked, DELIVERY_LIMITS.capabilities);
  assert.equal(report.runtime.capabilityModules.unchecked, declared.length - 2 - DELIVERY_LIMITS.capabilities);
  assert.ok(!calls.some((call) => call.url.startsWith("https://untrusted.example/")));
  assert.ok(report.failures.some((line) => /0 declared capability module\(s\) are missing .* 2 were invalid or did not load/u.test(line)));
});

test("the whole report stays inside the output budget when local-only references and failures pile up", async () => {
  const localLinks = Array.from({ length: 400 }, (_, index) => `<a href="https://dev-${index}.taproot.test/${"p".repeat(300)}">x</a>`);
  const links = Array.from({ length: DELIVERY_LIMITS.links }, (_, index) => `/gone-${index}/`);
  const entries = healthy({ [`${ORIGIN}/`]: { body: html({ links, extra: localLinks.join("") }) } });
  const routes = Array.from({ length: 19 }, (_, index) => `/missing-${index}/`);
  const { fetch } = server(entries);
  const report = await checkDelivery({ fetch, timeoutSignal, baseUrl: `${ORIGIN}/`, routes, sleep: noSleep });
  assert.ok(Buffer.byteLength(JSON.stringify(report), "utf8") <= DELIVERY_LIMITS.outputBytes);
  assert.equal(report.localOnlyReferences.length, DELIVERY_LIMITS.localReferences);
  assert.equal(report.localOnlyReferencesTotal, undefined);
  assert.ok(report.failures.length <= DELIVERY_LIMITS.failures);
  assert.equal(report.failures.length, DELIVERY_LIMITS.failures);
  assert.equal(report.failuresTotal, 19 + DELIVERY_LIMITS.links + DELIVERY_LIMITS.localReferences);
  assert.equal(report.failuresTruncated, true);
  assert.equal(report.verdict, "failed");
  // Local-only references discovered across several routes are bounded globally, not per page.
  const spread = healthy({
    [`${ORIGIN}/`]: { body: html({ extra: localLinks.slice(0, 15).join("") }) },
    [`${ORIGIN}/about/`]: { body: html({ links: ["/"], extra: localLinks.slice(15, 30).join("") }) },
  });
  const wide = await checkDelivery({ fetch: server(spread).fetch, timeoutSignal, baseUrl: `${ORIGIN}/`, routes: ["/about/"], sleep: noSleep });
  assert.equal(wide.localOnlyReferences.length, DELIVERY_LIMITS.localReferences);
  assert.equal(wide.localOnlyReferencesTotal, 30);
});
