import { getSiteRedirectMap, mintStagingPreviewHandoff } from "./api.js";
import { sanitizeDiagnostic, SiteAuthoringError } from "./errors.js";

const COOKIE = "__Host-taproot_staging_preview";
const CHECK = "__taproot_preview_check";
const TIMEOUT = 5_000;
const REPORT_BYTES = 28_000;

async function request(client, url, cookie, signal) {
  const response = await client.fetch(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.any([
      client.timeoutSignal(TIMEOUT),
      ...(signal ? [signal] : []),
      ...(client.signal ? [client.signal] : []),
    ]),
    headers: {
      accept: "text/html",
      "user-agent": "taproot-site/staging-redirect-check",
      ...(cookie ? { cookie } : {}),
    },
  });
  await response.body?.cancel().catch(() => {});
  return response;
}

function unavailable() {
  return new SiteAuthoringError("staging.gate_unavailable", "The staging gate could not establish authorized access.");
}

/** Consume only the checker's handoff; never forward a platform bearer or follow a redirect. */
async function authorize(client, handoff, signal) {
  const response = await request(client, handoff.url, undefined, signal);
  const origin = new URL(handoff.stagingUrl).origin;
  const checkUrl = `${origin}/?${CHECK}=1`;
  const cookies = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  const matching = cookies.filter((value) => value.startsWith(`${COOKIE}=`));
  if (response.status !== 302 || response.headers.get("location") !== checkUrl || matching.length !== 1) {
    throw unavailable();
  }
  const match = new RegExp(`^${COOKIE}=([A-Za-z0-9_-]{43});`).exec(matching[0]);
  if (!match || !/;\s*Secure(?:;|$)/i.test(matching[0]) || !/;\s*HttpOnly(?:;|$)/i.test(matching[0])) {
    throw unavailable();
  }
  const cookie = `${COOKIE}=${match[1]}`;
  const checked = await request(client, checkUrl, cookie, signal);
  if (checked.status !== 302 || checked.headers.get("location") !== `${origin}/`) throw unavailable();
  return cookie;
}

function safeLocation(value) {
  if (value === null) return "";
  // The edge could be misconfigured. Never reflect handoff credentials from a
  // redirect response into JSON, stderr or Actions, even if the check fails.
  if (
    value.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || /__taproot_preview_|[?&]handoff=/iu.test(value)
  ) return "[withheld]";
  return sanitizeDiagnostic(value, "");
}

/** Check the current redirect-map revision at the real edge from the Node CLI. */
export async function checkStagingRedirects(client, siteId, onProgress, now) {
  const map = await getSiteRedirectMap(client, siteId);
  const handoff = await mintStagingPreviewHandoff(client, siteId, { now });
  const signal = client.timeoutSignal(90_000);
  const cookie = await authorize(client, handoff, signal);
  const origin = new URL(handoff.stagingUrl).origin;
  const rows = new Array(map.entries.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, map.entries.length) }, async () => {
    while (next < map.entries.length) {
      const index = next++;
      const entry = map.entries[index];
      if (
        !entry.path.startsWith("/") || entry.path.startsWith("//") || entry.path.includes("\\")
        || /[?#\u0000-\u001f\u007f]/u.test(entry.path)
      ) throw unavailable();
      const url = new URL(entry.path, `${origin}/`);
      if (
        url.origin !== origin || url.pathname !== entry.path || url.username || url.password || url.hash
        || [...url.searchParams.keys()].some((key) => key.startsWith("__taproot_preview_"))
      ) throw unavailable();
      let row;
      try {
        const response = await request(client, url.href, cookie, signal);
        const location = safeLocation(response.headers.get("location"));
        const expectedLocation = entry.kind === "gone" ? "" : entry.target;
        // Compare URL semantics while retaining the literal Location evidence.
        const targetMatches = entry.kind === "gone"
          ? location === ""
          : location !== "[withheld]" && location !== ""
            && new URL(location, url).href === new URL(expectedLocation, url).href;
        row = {
          path: entry.path,
          status: response.status,
          location,
          expectedStatus: entry.status,
          matches: response.status === entry.status && targetMatches,
        };
      } catch {
        row = {
          path: entry.path,
          status: 0,
          location: "",
          expectedStatus: entry.status,
          matches: false,
          error: "request_failed",
        };
      }
      rows[index] = row;
      onProgress(
        `${sanitizeDiagnostic(row.path)} → ${row.status || "unavailable"} → ${row.location || "(no Location)"}`,
      );
    }
  }));
  const latest = await getSiteRedirectMap(client, siteId);
  const revisionUnchanged = latest.revision === map.revision;
  const failed = rows.filter((row) => !row.matches).length;
  const items = [];
  let bytes = 2;
  // Include failures first when a large map exceeds the JSON output budget.
  for (const row of [...rows.filter((row) => !row.matches), ...rows.filter((row) => row.matches)]) {
    const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
    if (bytes + size > REPORT_BYTES) break;
    items.push(row);
    bytes += size;
  }
  return {
    routeCheck: "resolved",
    stagingUrl: handoff.stagingUrl,
    redirects: {
      revision: map.revision,
      revisionUnchanged,
      total: rows.length,
      checked: rows.length,
      matched: rows.length - failed,
      failed,
      verified: revisionUnchanged && failed === 0,
      items,
      ...(items.length < rows.length ? { itemsTruncated: true } : {}),
    },
  };
}
