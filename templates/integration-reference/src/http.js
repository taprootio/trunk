import { createServer } from "node:http";

const DEFAULT_MAX_WEBHOOK_BYTES = 262_144;
const MAX_HANDOFF_LENGTH = 8_192;
const MAX_SETTINGS_FORM_BYTES = 1_024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const PUBLIC_WEBHOOK_ERROR_CODES = new Set([
  "body_too_large", "webhook_payload_too_large", "receipt_conflict", "webhook_capacity_exhausted",
  "missing_signature", "invalid_signature", "timestamp_out_of_range", "unknown_signing_key", "header_body_mismatch",
  "invalid_json", "invalid_event", "invalid_delivery_header", "invalid_installation_header", "wrong_integration",
]);

function securityHeaders(response) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cache-control", "no-store");
}

function json(response, status, value) {
  securityHeaders(response);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function html(response, status, value) {
  securityHeaders(response);
  response.statusCode = status;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  response.end(value);
}

function redirect(response, location, cookie) {
  securityHeaders(response);
  response.statusCode = 303;
  response.setHeader("location", location);
  if (cookie) response.setHeader("set-cookie", cookie);
  response.end();
}

function cookieValue(request, name) {
  const entries = request.headers.cookie?.split(";") ?? [];
  for (const entry of entries) {
    const [key, ...value] = entry.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

async function rawBody(request, maximum = DEFAULT_MAX_WEBHOOK_BYTES) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximum) {
      request.destroy();
      const error = new Error("body_too_large");
      error.code = "body_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function settingsPage(session) {
  if (!session) {
    return "<!doctype html><title>Reference integration settings</title><main><h1>Reference integration settings</h1><p>Open this page from a Taproot settings handoff.</p></main>";
  }
  return `<!doctype html><title>Reference integration settings</title><main><h1>Reference integration settings</h1><p>Connected to site ${escapeHtml(session.site_id)} as ${escapeHtml(session.role)}.</p><p>This minimal example stores no owner profile or session refresh credential.</p></main>`;
}

function isState(value) {
  return typeof value === "string" && UUID.test(value);
}

export function createReferenceHttpServer({ database, webhook, settings, processor, manifest, maxWebhookBytes = DEFAULT_MAX_WEBHOOK_BYTES }) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://reference.invalid");
      if (request.method === "GET" && url.pathname === "/healthz") {
        json(response, 200, { status: "ok" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/readyz") {
        await database.ping();
        json(response, 200, { status: "ready" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/manifest.json") {
        json(response, 200, manifest);
        return;
      }
      if (request.method === "POST" && url.pathname === "/webhooks") {
        const body = await rawBody(request, maxWebhookBytes);
        const verified = webhook.verify({ headers: request.headers, body });
        const inserted = await webhook.accept(verified, body);
        processor.wake();
        json(response, inserted ? 202 : 200, { accepted: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/settings") {
        const handoff = url.searchParams.get("handoff");
        if (handoff !== null) {
          try {
            if (url.searchParams.size !== 1 || handoff.length === 0 || handoff.length > MAX_HANDOFF_LENGTH) {
              const error = new Error("invalid_handoff");
              error.code = "invalid_handoff";
              throw error;
            }
            // Signature verification and a bounded, encrypted pending record
            // happen here; remote confirmation waits until this redirect has
            // removed the JWT from the browser URL and referrer surface.
            const pending = await settings.prepare(handoff);
            redirect(response, `/settings/confirm?state=${pending.state}`);
          } catch (error) {
            // Rejected handoffs also leave through a fixed token-free URL.
            redirect(response, "/settings/unavailable");
          }
          return;
        }
        const session = await settings.read(cookieValue(request, "__Host-taproot-reference-session"));
        html(response, 200, settingsPage(session));
        return;
      }
      if (request.method === "GET" && url.pathname === "/settings/unavailable") {
        html(response, 401, "<!doctype html><title>Settings unavailable</title><main><h1>Settings unavailable</h1><p>Ask the site owner to open a new settings link.</p></main>");
        return;
      }
      if (request.method === "GET" && url.pathname === "/settings/confirm") {
        const state = url.searchParams.get("state");
        if (url.searchParams.size !== 1 || !isState(state)) {
          html(response, 410, "<!doctype html><title>Settings unavailable</title><main><p>This handoff is unavailable. Open a new link from Taproot.</p></main>");
          return;
        }
        html(response, 200, `<!doctype html><title>Confirm settings access</title><main><h1>Confirm settings access</h1><form method="post" action="/settings/confirm"><input type="hidden" name="state" value="${state}"><button type="submit">Continue</button></form></main>`);
        return;
      }
      if (request.method === "POST" && url.pathname === "/settings/confirm") {
        try {
          const form = new URLSearchParams((await rawBody(request, MAX_SETTINGS_FORM_BYTES)).toString("utf8"));
          const state = form.get("state");
          if (form.size !== 1 || !form.has("state") || !isState(state)) {
            const error = new Error("handoff_unavailable");
            error.code = "handoff_unavailable";
            throw error;
          }
          const session = await settings.confirm(state);
          redirect(response, "/settings", `__Host-taproot-reference-session=${session.token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${session.maxAgeSeconds}`);
        } catch {
          html(response, 410, "<!doctype html><title>Settings unavailable</title><main><p>This handoff is unavailable. Open a new link from Taproot.</p></main>");
        }
        return;
      }
      json(response, 404, { code: "not_found" });
    } catch (error) {
      // Drivers can surface hostnames, SQLSTATEs, and connection details as
      // `code`. Expose only the webhook contract's fixed vocabulary.
      const code = PUBLIC_WEBHOOK_ERROR_CODES.has(error?.code) ? error.code : "internal_error";
      const status = code === "body_too_large" || code === "webhook_payload_too_large" ? 413 : code === "receipt_conflict" ? 409 :
        code === "webhook_capacity_exhausted" ? 503 :
        ["missing_signature", "invalid_signature", "timestamp_out_of_range", "unknown_signing_key", "header_body_mismatch"].includes(code) ? 401 :
          code === "internal_error" ? 503 : 400;
      if (status === 503) response.setHeader("retry-after", "60");
      json(response, status, { code });
    }
  });
}

/** Initial registration mode deliberately exposes only the public manifest. */
export function createBootstrapHttpServer(manifest) {
  return createServer((request, response) => {
    const url = new URL(request.url, "http://reference.invalid");
    if (request.method === "GET" && url.pathname === "/manifest.json") {
      json(response, 200, manifest);
      return;
    }
    if (request.method === "GET" && url.pathname === "/healthz") {
      json(response, 200, { status: "bootstrap_manifest_only" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      json(response, 503, { status: "bootstrap_manifest_only" });
      return;
    }
    json(response, 404, { code: "not_found" });
  });
}
