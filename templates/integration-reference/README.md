# Taproot integration reference

This is a public, independently deployable Node 22 service that demonstrates a
small Taproot integration. It owns one managed page, one JSON data document, a
small PNG media asset, and every current placement fragment. It is deliberately
small enough to audit, while keeping the production boundaries that a real
integration needs: signed webhooks, PostgreSQL durability, encrypted
installation credentials, lease fencing, bounded settings handoffs, and a
publisher-only bundle upload.

The only Taproot runtime package is the public `@taprootio/integration-sdk`
`0.1.3`. The PostgreSQL `pg` `8.16.3` dependency is the service's only other
runtime dependency; it provides the durable receipt, operation journal, and
session state required to recover safely after a process restart. There are no
private Taproot imports, fixture imports, local `file:` dependencies, or
embedded credentials.

## What the service exposes

| Route | Purpose |
| --- | --- |
| `GET /manifest.json` | Public registration manifest. It remains available after activation for Taproot refreshes. |
| `GET /healthz` | Process health. It is healthy in bootstrap mode so App Platform can route the manifest. |
| `GET /readyz` | Active-service readiness. It is `503` while bootstrap mode intentionally lacks credentials. |
| `POST /webhooks` | Signed Taproot delivery receiver. It durably records a verified receipt before replying. |
| `GET /settings` | Settings handoff entry and local session page. |

`PUBLIC_ORIGIN` must always be an HTTPS origin. The Taproot API URL must also use HTTPS.

## Initial registration without placeholder credentials

Taproot needs to fetch the manifest before it can issue an integration id,
publisher credential, and webhook signing key. Start the service in its
manifest-only bootstrap mode with only a public HTTPS origin and port:

```sh
PUBLIC_ORIGIN=https://receiver.example.test \
REFERENCE_BOOTSTRAP_MANIFEST_ONLY=true \
npm start
```

This process exposes only `GET /manifest.json` and `GET /healthz`. It returns
`503` from `/readyz` and accepts no webhooks, installation credentials, bundle
uploads, or settings handoffs. Register the exact public manifest URL with
Taproot, complete the separately approved operator registration, and capture
the returned integration id, publisher credential, and signing key in the
managed secret store. Then set `REFERENCE_BOOTSTRAP_MANIFEST_ONLY=false`, set
every active environment variable in [`.env.example`](.env.example), and
restart. There is no fake credential or automatic registration path.

## Run locally

Use Node 22 and PostgreSQL 17. Copy `.env.example` to an untracked `.env`, use
real secrets supplied by the registration response, and install the exact
declared dependency versions:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node --env-file=.env src/main.js
```

The example file binds `HOST=127.0.0.1` for local development. The
production App Platform specification sets `HOST=0.0.0.0`; these are the only
supported public/loopback bindings, together with IPv6 loopback `::1`.

Startup applies the numbered PostgreSQL migrations transactionally before the
service listens. It fails closed if migrations, database connectivity, secret
parsing, or active configuration are invalid. Signing key IDs must be nonzero
UUIDs and secrets must use canonical padded base64. The handoff JWKS URL must
be HTTPS (loopback HTTP is allowed locally), without credentials, query, or
fragment. When `DATABASE_CA_CERT` is set, it must be a PEM chain and the
database connection verifies it with TLS; URL SSL parameters cannot override
that policy. These checks run before the service starts listening. `npm run migrate` performs only
the migration step. Keep `CREDENTIAL_ENCRYPTION_KEY` stable: replacing it
without a planned re-encryption migration makes existing encrypted credentials,
webhook payloads, journals, and pending handoffs unreadable.

## DigitalOcean App Platform deployment

[`app.yaml`](app.yaml) is a one-service production App Platform template. It
uses the current `apps-s-1vcpu-0.5gb` size and has `deploy_on_push: false`.
Before creating the App Platform app, create the managed PostgreSQL cluster
separately in the target VPC. Replace its `cluster_name` and the repository and
domain placeholders in `app.yaml`; the service receives the named component's
private database URL through `DATABASE_URL=${reference-db.DATABASE_PRIVATE_URL}`
and its CA through `DATABASE_CA_CERT=${reference-db.CA_CERT}`. The app
specification marks the database `production: true`; it does not create a
development database. The exported template uses `source_dir: /`; when the
source repository is `taprootio/trunk`, set it to
`/templates/integration-reference`.

Set these values in App Platform's encrypted runtime configuration, never in a
Git repository:

| Value | Why it is secret |
| --- | --- |
| `PUBLISHER_CREDENTIAL` | Claims an installation and requests a bundle upload. |
| `TAPROOT_WEBHOOK_SIGNING_KEYS` | Verifies HMAC-signed webhook bytes; retain overlapping keys during rotation. |
| `CREDENTIAL_ENCRYPTION_KEY` | A 32-byte base64 AES-256-GCM key that encrypts all local bearer material. |
| `DATABASE_URL` | The managed database connection URL injected through the named cluster binding. |
| `DATABASE_CA_CERT` | The managed cluster's private PEM CA chain for verified TLS. |

The deployment health check uses `/healthz`, allowing the registration manifest
to be reached in bootstrap mode. `/readyz` distinguishes that bootstrap state
from an active installation-capable service. On `SIGTERM` or `SIGINT`, the
server stops accepting new requests, waits for its serialized worker, and
closes the database pool.

## Durable webhook processing

The receiver verifies Taproot's signature against the exact received bytes and
checks the integration id. In the same PostgreSQL primary-key transaction it
records the immutable delivery id, event type, installation/site/integration
bindings, body digest, signing key id, and AES-GCM encrypted payload. A replay
is acknowledged only if every immutable value agrees; a conflicting reuse of a
delivery id returns `409`.

After the receipt is durable, the HTTP request receives `202` (or `200` for a
matching duplicate). One serialized worker claims receipts with PostgreSQL
`FOR UPDATE SKIP LOCKED` and a lease token. A restart returns expired leases to
the retry queue. The worker fences receipt completion, operation journal
completion, and installation credential storage on that token, so an expired
worker cannot finalize a newer worker's state.

Every outbound operation journals its exact encrypted request before the
network call and its encrypted response after success. Retried idempotent
operations replay their recorded request and idempotency key. Claim and media
reservation/upload/confirmation intentionally are not retried after an
unknown response, because those operations can return a one-time secret or
presigned URL. They move to terminal processing and require an operator to
start a fresh platform action. This is an explicit at-least-once delivery
design, not a claim of exactly-once external effects.

The service has fixed, configured storage bounds:

| Environment value | Default | Bound it enforces |
| --- | ---: | --- |
| `WEBHOOK_MAX_RETAINED_RECEIPTS` | 50,000 | Every receipt row: received, retry, processing, terminal, and completed tombstone. |
| `WEBHOOK_MAX_OUTSTANDING_RECEIPTS` | 512 | Received, retry, processing, and terminal rows that retain recovery or reconciliation evidence for one installation. |
| `WEBHOOK_MAX_RECEIPT_BYTES` | 262,144 | Raw signed webhook bytes before encryption. |
| `WEBHOOK_MAX_OPERATIONS_PER_RECEIPT` | 512 | Journal entries held while one receipt is recoverable. |
| `WEBHOOK_MAX_OPERATION_BYTES_PER_RECEIPT` | 2,097,152 | Total encrypted request/response journal bytes for one recoverable receipt. |
| `WEBHOOK_MAX_OPERATION_RESPONSE_BYTES` | 524,288 | Maximum encrypted response for the placement-list journal entry. |

Admission serializes duplicate lookup, the total-row count, and the
per-installation outstanding count in one PostgreSQL transaction. A matching
duplicate is still acknowledged when either cap is full. A new delivery at
either cap is not acknowledged, returns `503` with `Retry-After: 60`, and
Taproot can retry it later. `WEBHOOK_MAX_OUTSTANDING_RECEIPTS` must not exceed
the total receipt cap. A terminal backlog from one installation therefore does
not consume another installation's 512-receipt recovery budget; the global
retained receipt cap remains the total storage bound.

The service never auto-deletes accepted received, retry, processing, terminal,
or completed receipt rows to make room. A fenced **completed** receipt becomes
a compact tombstone: immutable delivery bindings, digest, status, timestamps,
and attempt count remain for deduplication, while its encrypted webhook body
and all encrypted operation journals are removed in the same transaction. A
fenced **terminal** receipt retains its encrypted webhook body and operation
journal, plus its bounded failure code, so an operator can reconcile stopped
work without guessing at a one-time credential or presigned-upload outcome.

These configured caps are retention budgets. Monitor both before either fills
and increase capacity through the normal deployment change process. Reconcile
and archive terminal evidence before any manually approved database-retention
change. Do not delete receipt tombstones while Taproot could still redeliver
their ids, and never delete accepted received, retry, processing, or terminal
work merely to admit another delivery: doing so would lose recovery evidence or
turn a duplicate into a new delivery. Use the retained terminal journal and
Taproot's authoritative state to decide whether a new owner or publisher action
is appropriate. Terminal work is never automatically retried.

`WEBHOOK_MAX_ATTEMPTS`, `WEBHOOK_LEASE_SECONDS`, and
`WEBHOOK_POLL_MILLISECONDS` bound retry timing. Leases must be at least 35
seconds: the fixed SDK configuration can make three ten-second attempts plus
less than 400 milliseconds of retry delay. An expired lease consumes an
attempt and becomes terminal at the same configured attempt cap as a caught
processing error. A journal capacity error moves the receipt to terminal
processing before a further external operation can be started; increasing a
limit later does not replay that terminal delivery.
The normal 256-placement full-sync path journals 264 operations; if its final
candidate completion is rejected, the isolated-candidate abort is operation
265. The 512-operation cap leaves room for both paths. A placement-list
response may contain all 256 configurations and revisions, so it reserves up
to 512 KiB before its network call. Fragment entries reserve 4 KiB each and
the other protocol operations reserve 16 KiB each; their actual encrypted
reply replaces that reservation on completion. This keeps the 2 MiB receipt
budget bounded while allowing the only expected large reply instead of
reserving 512 KiB for every operation.

Worker startup first verifies PostgreSQL recovery and fails before the HTTP
listener starts if that check cannot run. It then starts durable draining in
the background so an existing receipt backlog cannot prevent health routing
from binding. After startup, a transient recovery, lease, or retry failure is
logged as a short error code and deferred to the next poll or webhook wake-up.
The log never includes request bodies, credentials, connection strings, or
database error text.

## Content and synchronization

Normal operation uses `REFERENCE_SYNC_MODE=full`. It starts Taproot's requested
sync candidate, lists placements, and writes **every** listed placement
fragment at the exact configuration and expected fragment revision before it
completes the sync. A full sync never silently omits a placement, which would
select its deletion. If an owner changes a placement between the list and
write, the reference performs at most one fresh placement-list read and writes
the affected placement under a new durable operation identity; another
conflict remains terminal for operator review. It also uploads media through
the normal reservation, presigned upload, and confirmation sequence, then
writes a managed page with a real `data-image-id` image reference and one owned
JSON document.

`incremental`, `abort`, and `delete` are acceptance-only modes. Select one for
a controlled run, inspect the resulting candidate, and restart with `full`.
The delete mode removes the reference-owned page, document, and all currently
listed fragments inside a sync; Taproot retains authority over the selected
published disposition for a deleted placement.

## Lifecycle and settings handoff

Installation lifecycle webhooks are revision-monotonic. Suspension blocks local
credential use but retains encrypted data so a later active revision can use it
again. Uninstall removes local credential material. A newer
`installation.created` reissue clears the old local credential before the new
claim can be stored. A delayed older event cannot replace a newer credential or
invalidate a newer session. The lifecycle upsert reports whether it applied its
revision; only an applied state may invalidate sessions or start follow-up work.
One exception is a same-revision `pending_claim` creation: it remains applied
until its credential is stored, so a process crash after lifecycle persistence
but before the safe claim attempt recovers from the signed retry without
allowing a stale active or suspended payload to trigger side effects.

Settings handoff starts at `GET /settings?handoff=...`. The service verifies
the signed JWT and its installation, credential, site, issuer, audience, role,
and expiry before reserving one of at most 256 encrypted, expiry-bounded
pending records. It immediately redirects to the token-free
`/settings/confirm?state=...` URL. Only the form POST consumes that pending
state, re-verifies the token, calls the SDK's authoritative confirmation
helper with the installation credential, and creates an opaque, hashed
`__Host-` cookie session with Taproot's absolute expiry. The pending state is
consumed before remote confirmation, so a lost response requires a new
handoff. It cannot be replayed.

Local sessions are bound to credential id, engagement id, and a monotonic
lifecycle cutoff revision. Suspension, uninstall, source termination, or a
credential reissue invalidates affected sessions. A later resume allows new
handoffs but cannot revive a previously invalidated session. Handoff responses
use `no-store`, `no-referrer`, restrictive CSP, and never reflect the JWT.

## Optional browser bundle

The static [`public/bundle.js`](public/bundle.js) is optional progressive
enhancement. The server-rendered managed page and fragments remain useful if
the bundle is unavailable. Upload only through the publisher workflow after a
separate operator has approved the bundle and runtime major:

```sh
npm run upload-bundle -- --runtime-major ACTUAL_RUNTIME_MAJOR
```

The script hashes the exact local bundle, requests a presigned upload, uploads
that byte sequence, and confirms the result. It has no endpoint that changes
pricing, approvals, or platform registry state. It requires only
`TAPROOT_API_URL`, `INTEGRATION_ID`, and `PUBLISHER_CREDENTIAL`; it does not
load database, webhook, credential-encryption, or handoff settings.

## Tests

Unit tests cover encrypted envelopes, deterministic sanitized content, HTTP
manifest/bootstrap/handoff routes, lifecycle follow-up, drain recovery, and
the 256-placement sync path. PostgreSQL tests are opt-in and exercise durable
duplicate acknowledgement, restart lease fencing, bounded journal admission,
encrypted credentials, lifecycle session cutoffs, and encrypted single-use
pending handoffs without crossing installation rows:

```sh
REFERENCE_TEST_DATABASE_URL=postgres://reference:replace-me@127.0.0.1:55551/reference \
npm test
```

The integration test uses only the supplied dedicated database. It does not
create or drop a database, and it skips when `REFERENCE_TEST_DATABASE_URL` is
not set.
