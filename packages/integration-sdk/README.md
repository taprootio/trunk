# @taprootio/integration-sdk

`@taprootio/integration-sdk` is the public Node 22 kit for integrations that push their own content into Taproot. It has no third-party runtime dependencies and is versioned independently from the Taproot application.

Taproot publishes accepted, immutable content; it does not call an integration during rendering or publishing. An integration receives signed webhooks that request reconciliation, then uses its installation credential to push pages, media, JSON documents, and placement fragments.

## Install

```sh
npm install @taprootio/integration-sdk@0.1.2
```

The public manifest schema is exported at `@taprootio/integration-sdk/schema`. The fixtures under `@taprootio/integration-sdk/fixtures/...` are contract examples, not a local fixture host or a production deployment recipe.

## Manifest

The manifest is declarative data for registration, review, and owner consent. It does not cause Taproot to run integration code.

```js
import { assertValidManifest } from "@taprootio/integration-sdk";

const manifest = assertValidManifest({
  slug: "class-schedule",
  displayName: "Class Schedule",
  webhookEndpointUrl: "https://integration.example/webhooks/taproot",
  settingsUrl: "https://integration.example/settings",
  requestedCapabilities: ["pages.manage_own", "data.manage_own", "publish"],
  offeredComponents: [],
  externalScriptOrigins: [],
  defaultPublishPolicy: "stage",
  recommendedUninstallDisposition: "freeze",
  contractVersion: "1",
  pricingOptions: [{ id: "free", version: "1", quantityMin: 1, quantityMax: null, cadence: "free", catalogueItemKey: null }],
});
```

`validateManifest` is a bounded local preflight. Taproot remains authoritative for DNS resolution, public-route validation, registry status, consent, and authorization. Do not treat a successful local validation as registration.

## Credentials and content

Publisher and installation credentials are separate authorities. Never put a browser session, a site-authoring key, or an owner credential in this client. Pass credentials when constructing the client; each method uses only the credential appropriate to its contract scope.

```js
import { TaprootIntegrationClient, createIdempotencyKey } from "@taprootio/integration-sdk";

const client = new TaprootIntegrationClient({
  // Canonical API base: include /api when Taproot serves its API beneath it.
  baseUrl: "https://app.example/api",
  installationCredential: process.env.TAPROOT_INSTALLATION_CREDENTIAL,
  publisherCredential: process.env.TAPROOT_PUBLISHER_CREDENTIAL,
});

const sync = await client.createSync({
  installationId,
  mode: "full",
  requestedSyncId: webhook.event.data.syncId,
  idempotencyKey: createIdempotencyKey(),
});

await client.putManagedPage({
  installationId,
  syncId: sync.syncId,
  idempotencyKey: createIdempotencyKey(),
  page: {
    externalId: "class-101", path: "/classes/class-101/", title: "Strength 101",
    description: "A beginner strength class.", indexable: true, fragments: ["<p>Bring water.</p>"],
    structuredData: [JSON.stringify({ "@context": "https://schema.org", "@type": "WebPage", "@id": "https://integration.example/classes#primary", name: "Classes" })],
    primaryStructuredDataId: "https://integration.example/classes#primary", folder: "classes", tagIds: [],
    includeInNavigation: false, publicationDate: "", archiveDate: "", includeInLatestPosts: false,
  },
});
await client.completeSync({ installationId, syncId: sync.syncId, idempotencyKey: createIdempotencyKey() });
```

Keep an idempotency key with its one logical operation in durable application state. Content, sync, and fragment mutations retry a bounded number of transient failures with that same key. The SDK does not retry validation or authorization failures.

`claimInstallation` deliberately does not retry after a transport failure or an unreadable successful response. The installation credential secret is returned only once; a lost successful claim response cannot recover it. Persist the secret before replying to the webhook. If the response is unknown, validate the installation and use the owner-visible claim reissue workflow when appropriate; do not submit the claim code repeatedly.

Bundle admission is publisher-scoped. `requestBundleUpload` and `confirmBundleUpload` only create and confirm an immutable upload. Operator approval and owner pinning are separate Taproot-side authorities and are not SDK operations.

## Webhooks

Read request bytes with a size limit, then verify those same bytes before parsing JSON. The HMAC is over the ASCII timestamp, a period, and the exact body bytes: `ASCII(t + ".") + body`.

```js
import { claimWebhookReceipt, finishWebhookReceipt, verifyWebhookSignature } from "@taprootio/integration-sdk";

const verified = verifyWebhookSignature({
  headers: request.headers,
  body: rawRequestBytes,
  signingSecrets: signingSecretsByKeyId,
});
const claimed = await claimWebhookReceipt({ store: postgresWebhookReceipts, verified });
if (claimed.state === "duplicate") return new Response(null, { status: 204 });
if (claimed.state === "in_progress") return new Response(null, { status: 503, headers: { "Retry-After": "1" } });
if (claimed.state === "conflict") return new Response(null, { status: 409 });

try {
  await process(verified.event);
  await finishWebhookReceipt({ store: postgresWebhookReceipts, verified, token: claimed.token, status: "delivered" });
  return new Response(null, { status: 204 });
} catch (error) {
  await finishWebhookReceipt({ store: postgresWebhookReceipts, verified, token: claimed.token, status: "failed" });
  throw error;
}
```

`WebhookReceiptStore` is intentionally an interface. Its `claim` operation must be atomic and durable across process restarts, keyed by delivery id and immutable signed metadata. An in-memory `Set` is not receipt persistence. Return `duplicate` only after the same immutable receipt is delivered. A current processing lease returns `in_progress`, so respond `503` rather than acknowledge it: Taproot must redeliver if that worker fails. A failed receipt or expired lease must be claimed again with a fresh token. A durable receipt gives at-least-once processing; it does not make external side effects exactly once. Recover expired processing leases in your database and make every downstream effect idempotent.

During key rotation, keep active and overlapping retired HMAC secrets in `signingSecrets` until Taproot no longer sends either key id. Unknown key ids, stale timestamps, malformed signatures, modified body bytes, and mismatched delivery headers are rejected.

## Settings handoff

The owner settings redirect contains a five-minute RS256 handoff token. Strip it from the browser URL immediately and never log it, put it in analytics, or use it as a session. Verify the token, place a short-lived pending record in your service, then call the authoritative one-time confirmation before creating an integration-owned session.

```js
import { confirmHandoff, verifyHandoff } from "@taprootio/integration-sdk";

const claims = await verifyHandoff({
  token: handoffToken,
  issuer: "https://app.taproot.io",
  audience: integrationId,
  installationId,
  jwksUrl: "https://app.taproot.io/api/.well-known/taproot-integrations-jwks.json",
});

// Delete the local pending record before this request. If its response is lost,
// do not replay the token: begin a new owner handoff.
const session = await confirmHandoff({ client, claims, token: handoffToken });
```

`verifyHandoff` checks the token's exact RS256 header, JWK key selection, issuer, audience, installation binding, issued/expiry times, role, and claim shape. Set `issuer` to the exact operator-published `iss` value, not an API base URL, and configure the operator-published JWKS URL explicitly. The default `<issuer>/.well-known/taproot-integrations-jwks.json` is only suitable when the operator publishes keys at that derived URL. The JWKS cache observes the published lifetime, capped at five minutes. Confirmation checks the returned identity against verified claims and bounds the integration-owned session to 24 hours by default. There is no refresh credential.

## Fragments and placements

`validateFragment` is advisory feedback for obvious unsafe markup. It is not a copy of Taproot's sanitizer and cannot promise the same result. Send the original fragment to `putFragment`; the server validates final bytes, links them to the exact requested placement configuration revision, and selects them only through immutable publication. A static fragment must remain useful when an optional browser bundle is unavailable.

`listPlacements` returns only the installation's placement identities and configuration. It never grants access to host page content. For stale configuration or fragment revision conflicts, fetch the latest placement, render against its exact configuration revision, and write a new idempotent operation rather than overwriting an older fragment.

## Public boundaries

This SDK deliberately excludes owner, administrator, operator, billing, registry-management, bundle-approval, and internal RPCs. It does not store credentials, execute integration bundles, provide an HTML sanitizer, or call Taproot from the published-site render path.
