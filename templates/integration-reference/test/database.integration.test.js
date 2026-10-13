import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";

import { decrypt, encrypt } from "../src/crypto.js";
import { placementFragment } from "../src/content.js";
import { ReferenceDatabase } from "../src/database.js";

const connectionString = process.env.REFERENCE_TEST_DATABASE_URL;
if (process.env.CI && !connectionString) {
  throw new Error("REFERENCE_TEST_DATABASE_URL is required when running the reference integration tests in CI.");
}
const integrationId = "10000000-0000-4000-8000-000000000001";
const siteId = "20000000-0000-4000-8000-000000000001";
const installationA = "30000000-0000-4000-8000-000000000001";
const installationB = "30000000-0000-4000-8000-000000000002";
const encryptionKey = Buffer.alloc(32, 11);

function lifecycleEvent(installationId, status = "active", revision = 1) {
  return {
    type: "installation.updated",
    installationId,
    integrationId,
    siteId,
    data: {
      status,
      revision,
      grantedCapabilities: ["pages.manage_own"],
      publishPolicy: "stage",
      contractVersion: "1",
    },
  };
}

const skip = !connectionString;
let database;
let sql;
let deliverySequence = 10;

async function applyLifecycle(event) {
  const suffix = String(deliverySequence++).padStart(12, "0");
  const deliveryId = `40000000-0000-4000-8000-${suffix}`;
  await database.recordReceipt({
    keyId: "50000000-0000-4000-8000-000000000001",
    bodySha256: `l${suffix}`.padEnd(64, "0"),
    event: { id: deliveryId, type: event.type, installationId: event.installationId, integrationId, siteId },
  }, encrypt(Buffer.from(JSON.stringify(event)), encryptionKey, `receipt:${deliveryId}`));
  const receipt = await database.leaseNextReceipt(30);
  const applied = await database.upsertLifecycle(event, receipt);
  await database.completeReceipt(receipt);
  return applied;
}

async function waitForOperationLockWaiters(minimum) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await sql.query(
      "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'",
    );
    if (result.rows[0].count >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Expected ${minimum} PostgreSQL advisory-lock waiters.`);
}

before(async () => {
  if (skip) return;
  database = new ReferenceDatabase(connectionString);
  await database.migrate();
  sql = new Pool({ connectionString });
});

beforeEach(async () => {
  if (skip) return;
  await sql.query("TRUNCATE webhook_operations, webhook_receipts, pending_settings_handoffs, settings_sessions, installations CASCADE");
  deliverySequence = 10;
});

after(async () => {
  if (skip) return;
  await sql.end();
  await database.close();
});

test("PostgreSQL receipts survive a duplicate delivery and fence an expired worker lease", { skip }, async () => {
  const body = Buffer.from(JSON.stringify({ type: "installation.updated", installationId: installationA }), "utf8");
  const payload = encrypt(body, encryptionKey, "receipt:40000000-0000-4000-8000-000000000001");
  const verified = {
    keyId: "50000000-0000-4000-8000-000000000001",
    bodySha256: "a".repeat(64),
    event: { id: "40000000-0000-4000-8000-000000000001", type: "installation.updated", installationId: installationA, integrationId, siteId },
  };

  assert.equal(await database.recordReceipt(verified, payload), true);
  assert.equal(await database.recordReceipt(verified, payload), false, "a second HTTP delivery is acknowledged from the durable primary key");
  await assert.rejects(() => database.recordReceipt({
    ...verified,
    bodySha256: "b".repeat(64),
  }, payload), (error) => error.code === "receipt_conflict");

  const firstLease = await database.leaseNextReceipt(10);
  assert.ok(firstLease);
  assert.equal(decrypt(firstLease.payload, encryptionKey, `receipt:${firstLease.delivery_id}`).toString("utf8"), body.toString("utf8"));

  await sql.query("UPDATE webhook_receipts SET lease_expires_at = now() - interval '1 second' WHERE delivery_id = $1", [firstLease.delivery_id]);
  await database.close();
  database = new ReferenceDatabase(connectionString);
  await database.recoverExpiredLeases(8);
  await sql.query("UPDATE webhook_receipts SET available_at = now() - interval '1 second' WHERE delivery_id = $1", [firstLease.delivery_id]);
  const secondLease = await database.leaseNextReceipt(10);
  assert.ok(secondLease);
  assert.notEqual(secondLease.leaseToken, firstLease.leaseToken, "recovery issues a new fencing token");
  assert.deepEqual(await database.retryReceipt(firstLease, "late_worker", 8), { changed: false, terminal: false });
  const operationRequest = encrypt(JSON.stringify({ idempotencyKey: "same-logical-operation" }), encryptionKey,
    `operation:${secondLease.delivery_id}:page:request`);
  const operation = await database.startOperation(secondLease, "page", operationRequest, true);
  assert.equal(operation.state, "new", "the external request body is journaled before a side effect");
  const operationResponse = encrypt(JSON.stringify({ changed: true }), encryptionKey,
    `operation:${secondLease.delivery_id}:page:response`);
  assert.equal(await database.completeOperation(secondLease, "page", operationResponse), true);
  assert.equal(await database.completeReceipt(secondLease), true);
  const compacted = await sql.query(
    "SELECT octet_length(payload_ciphertext) AS bytes FROM webhook_receipts WHERE delivery_id = $1",
    [secondLease.delivery_id],
  );
  assert.equal(compacted.rows[0].bytes, 0, "completion retains a metadata tombstone but clears its encrypted body");
  assert.equal((await sql.query("SELECT count(*)::integer AS count FROM webhook_operations WHERE delivery_id = $1", [secondLease.delivery_id])).rows[0].count, 0,
    "completion compacts request and response journals in the same fenced transaction");
});

test("lifecycle application distinguishes stale state from a retryable pending claim", { skip }, async () => {
  assert.equal(await applyLifecycle(lifecycleEvent(installationA, "active", 4)), true);
  assert.equal(await applyLifecycle(lifecycleEvent(installationA, "suspended", 3)), false, "a stale lifecycle revision is not applied");
  const pendingClaim = {
    type: "installation.created", installationId: installationA, integrationId, siteId,
    data: {
      installation: { status: "pending_claim", revision: 5, grantedCapabilities: ["pages.manage_own"], publishPolicy: "stage", contractVersion: "1" },
      claimCode: "retryable-claim-code", claimExpiresAt: "2026-01-01T00:00:00Z",
    },
  };
  assert.equal(await applyLifecycle(pendingClaim), true);
  assert.equal(await applyLifecycle(pendingClaim), true, "a same-revision pending claim remains eligible after a crash before its claim side effect");
  assert.equal(await applyLifecycle({
    type: "installation.updated", installationId: installationA, integrationId, siteId,
    data: { status: "active", revision: 5, grantedCapabilities: ["pages.manage_own"], publishPolicy: "stage", contractVersion: "1" },
  }), false, "a same-revision metadata event cannot replace a pending claim before its one-time credential is stored");
});

test("outstanding admission is atomic and matching duplicates acknowledge at its cap", { skip }, async () => {
  const limits = { maxRetainedReceipts: 10, maxOutstandingReceipts: 1 };
  const first = new ReferenceDatabase(connectionString, limits);
  const second = new ReferenceDatabase(connectionString, limits);
  const deliveries = [
    "40000000-0000-4000-8000-000000000010",
    "40000000-0000-4000-8000-000000000011",
  ].map((id) => ({
    keyId: "50000000-0000-4000-8000-000000000001",
    bodySha256: id.replaceAll("-", "").padEnd(64, "0"),
    event: { id, type: "installation.updated", installationId: installationA, integrationId, siteId },
  }));
  try {
    const results = await Promise.allSettled(deliveries.map((verified, index) =>
      (index === 0 ? first : second).recordReceipt(verified, encrypt(Buffer.from(verified.event.id), encryptionKey, `receipt:${verified.event.id}`)),
    ));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1, "only one concurrent new delivery crosses the outstanding cap");
    const acceptedIndex = results.findIndex((result) => result.status === "fulfilled");
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected.reason.code, "webhook_capacity_exhausted");
    assert.equal(rejected.reason.status, 503);
    assert.equal(await first.recordReceipt(deliveries[acceptedIndex], encrypt(Buffer.from(deliveries[acceptedIndex].event.id), encryptionKey,
      `receipt:${deliveries[acceptedIndex].event.id}`)), false, "a matching duplicate still acknowledges after the outstanding cap is full");
    assert.equal((await sql.query("SELECT count(*)::integer AS count FROM webhook_receipts")).rows[0].count, 1);
  } finally {
    await first.close();
    await second.close();
  }
});

test("a terminal receipt exhausts only its installation's recovery budget", { skip }, async () => {
  const limited = new ReferenceDatabase(connectionString, { maxRetainedReceipts: 10, maxOutstandingReceipts: 1 });
  const terminalDelivery = "40000000-0000-4000-8000-000000000017";
  const terminal = {
    keyId: "50000000-0000-4000-8000-000000000001",
    bodySha256: "i".repeat(64),
    event: { id: terminalDelivery, type: "sync.requested", installationId: installationA, integrationId, siteId },
  };
  const otherInstallation = {
    keyId: "50000000-0000-4000-8000-000000000001",
    bodySha256: "j".repeat(64),
    event: { id: "40000000-0000-4000-8000-000000000018", type: "sync.requested", installationId: installationB, integrationId, siteId },
  };
  try {
    await limited.recordReceipt(terminal, encrypt(Buffer.from("terminal"), encryptionKey, `receipt:${terminalDelivery}`));
    const receipt = await limited.leaseNextReceipt(30);
    assert.deepEqual(await limited.retryReceipt(receipt, "processing_failed", 0), { changed: true, terminal: true });

    await assert.rejects(() => limited.recordReceipt({
      ...terminal,
      event: { ...terminal.event, id: "40000000-0000-4000-8000-000000000019" },
      bodySha256: "k".repeat(64),
    }, encrypt(Buffer.from("blocked"), encryptionKey, "receipt:40000000-0000-4000-8000-000000000019")),
    (error) => error.code === "webhook_capacity_exhausted");
    assert.equal(await limited.recordReceipt(otherInstallation,
      encrypt(Buffer.from("other-installation"), encryptionKey, `receipt:${otherInstallation.event.id}`)), true);
  } finally {
    await limited.close();
  }
});

test("expired leases consume attempts and stop at the configured terminal cap", { skip }, async () => {
  const deliveryId = "40000000-0000-4000-8000-000000000020";
  const verified = {
    keyId: "50000000-0000-4000-8000-000000000001",
    bodySha256: "m".repeat(64),
    event: { id: deliveryId, type: "sync.requested", installationId: installationA, integrationId, siteId },
  };
  await database.recordReceipt(verified, encrypt(Buffer.from("receipt"), encryptionKey, `receipt:${deliveryId}`));
  const first = await database.leaseNextReceipt(30);
  await sql.query("UPDATE webhook_receipts SET lease_expires_at = now() - interval '1 second' WHERE delivery_id = $1", [deliveryId]);
  await database.recoverExpiredLeases(2);
  const retry = await sql.query("SELECT status, failure_code, available_at > now() AS delayed FROM webhook_receipts WHERE delivery_id = $1", [deliveryId]);
  assert.deepEqual(retry.rows[0], { status: "retry", failure_code: "lease_expired", delayed: true });
  await sql.query("UPDATE webhook_receipts SET available_at = now() - interval '1 second' WHERE delivery_id = $1", [deliveryId]);
  const second = await database.leaseNextReceipt(30);
  assert.ok(second);
  assert.notEqual(second.leaseToken, first.leaseToken);
  await sql.query("UPDATE webhook_receipts SET lease_expires_at = now() - interval '1 second' WHERE delivery_id = $1", [deliveryId]);
  await database.recoverExpiredLeases(2);
  assert.equal(await database.leaseNextReceipt(30), undefined, "a terminal lease-expiry receipt is never re-leased");
  const terminal = await sql.query("SELECT status, failure_code FROM webhook_receipts WHERE delivery_id = $1", [deliveryId]);
  assert.deepEqual(terminal.rows[0], { status: "terminal", failure_code: "lease_expired" });
});

test("a refreshed placement-list response keeps its full bounded reservation", { skip }, async () => {
  const deliveryId = "40000000-0000-4000-8000-000000000021";
  const verified = {
    keyId: "50000000-0000-4000-8000-000000000001",
    bodySha256: "n".repeat(64),
    event: { id: deliveryId, type: "sync.requested", installationId: installationA, integrationId, siteId },
  };
  await database.recordReceipt(verified, encrypt(Buffer.from("receipt"), encryptionKey, `receipt:${deliveryId}`));
  const receipt = await database.leaseNextReceipt(30);
  const operationKey = "list-placements-refresh-1";
  const request = encrypt(JSON.stringify({ installationId: installationA }), encryptionKey, `operation:${deliveryId}:${operationKey}:request`);
  await database.startOperation(receipt, operationKey, request, true);
  const response = encrypt(JSON.stringify({ placements: [
    { configJson: "x".repeat(70_000) },
  ] }), encryptionKey, `operation:${deliveryId}:${operationKey}:response`);
  assert.ok(response.ciphertext.byteLength > 16_384);
  assert.equal(await database.completeOperation(receipt, operationKey, response), true);
});

test("migration execution waits for the database-wide advisory lock", { skip }, async () => {
  const heldLock = await sql.connect();
  let unlocked = false;
  await heldLock.query("SELECT pg_advisory_lock(hashtext('taproot_reference_migrate'))");
  try {
    const migrating = database.migrate();
    await waitForOperationLockWaiters(1);
    await heldLock.query("SELECT pg_advisory_unlock(hashtext('taproot_reference_migrate'))");
    unlocked = true;
    await migrating;
  } finally {
    if (!unlocked) await heldLock.query("SELECT pg_advisory_unlock(hashtext('taproot_reference_migrate'))");
    heldLock.release();
  }
});

test("a completed tombstone consumes the retained cap while its duplicate still acknowledges", { skip }, async () => {
  const limited = new ReferenceDatabase(connectionString, { maxRetainedReceipts: 1, maxOutstandingReceipts: 1 });
  const deliveryId = "40000000-0000-4000-8000-000000000012";
  const verified = {
    keyId: "50000000-0000-4000-8000-000000000001",
    bodySha256: "e".repeat(64),
    event: { id: deliveryId, type: "sync.requested", installationId: installationA, integrationId, siteId },
  };
  try {
    const payload = encrypt(Buffer.from("completed-tombstone"), encryptionKey, `receipt:${deliveryId}`);
    await limited.recordReceipt(verified, payload);
    const receipt = await limited.leaseNextReceipt(30);
    assert.equal(await limited.completeReceipt(receipt), true);
    assert.equal(await limited.recordReceipt(verified, payload), false, "tombstone duplicate acknowledgement precedes either capacity check");
    await assert.rejects(() => limited.recordReceipt({
      ...verified,
      event: { ...verified.event, id: "40000000-0000-4000-8000-000000000013" },
      bodySha256: "f".repeat(64),
    }, encrypt(Buffer.from("new"), encryptionKey, "receipt:40000000-0000-4000-8000-000000000013")),
    (error) => error.code === "webhook_capacity_exhausted" && error.status === 503);
  } finally {
    await limited.close();
  }
});

test("fenced completion serializes with a concurrent journal writer and leaves no post-tombstone journal", { skip }, async () => {
  const deliveryId = "40000000-0000-4000-8000-000000000015";
  const verified = {
    keyId: "50000000-0000-4000-8000-000000000001",
    bodySha256: "g".repeat(64),
    event: { id: deliveryId, type: "sync.requested", installationId: installationA, integrationId, siteId },
  };
  await database.recordReceipt(verified, encrypt(Buffer.from("receipt"), encryptionKey, `receipt:${deliveryId}`));
  const receipt = await database.leaseNextReceipt(30);
  const heldLock = await sql.connect();
  const lockName = `taproot_reference_operation:${deliveryId}`;
  await heldLock.query("SELECT pg_advisory_lock(hashtext($1))", [lockName]);
  try {
    const completion = database.completeReceipt(receipt);
    await waitForOperationLockWaiters(1);
    const writer = database.startOperation(receipt, "racing-operation",
      encrypt(JSON.stringify({ idempotencyKey: "racing" }), encryptionKey, `operation:${deliveryId}:racing-operation:request`), true);
    await waitForOperationLockWaiters(2);
    await heldLock.query("SELECT pg_advisory_unlock(hashtext($1))", [lockName]);

    assert.equal(await completion, true);
    await assert.rejects(() => writer, (error) => error.code === "operation_lease_lost");
    assert.equal((await sql.query("SELECT count(*)::integer AS count FROM webhook_operations WHERE delivery_id = $1", [deliveryId])).rows[0].count, 0);
  } finally {
    await heldLock.query("SELECT pg_advisory_unlock(hashtext($1))", [lockName]);
    heldLock.release();
  }
});

test("operation journals have count and byte bounds, and terminal receipts retain reconciliation evidence", { skip }, async () => {
  const limits = {
    maxRetainedReceipts: 10,
    maxOperationsPerReceipt: 1,
    maxOperationBytesPerReceipt: 1_024,
    maxOperationResponseBytes: 256,
  };
  const constrained = new ReferenceDatabase(connectionString, limits);
  const deliveryId = "40000000-0000-4000-8000-000000000014";
  const verified = {
    keyId: "50000000-0000-4000-8000-000000000001",
    bodySha256: "d".repeat(64),
    event: { id: deliveryId, type: "sync.requested", installationId: installationA, integrationId, siteId },
  };
  try {
    await constrained.recordReceipt(verified, encrypt(Buffer.from("receipt"), encryptionKey, `receipt:${deliveryId}`));
    const receipt = await constrained.leaseNextReceipt(30);
    const request = encrypt(JSON.stringify({ idempotencyKey: "bounded" }), encryptionKey, `operation:${deliveryId}:one:request`);
    await constrained.startOperation(receipt, "one", request, true);
    await assert.rejects(() => constrained.startOperation(receipt, "two", request, true), (error) =>
      error.code === "operation_journal_capacity" && error.status === 413);
    assert.deepEqual(await constrained.retryReceipt(receipt, "operation_journal_capacity", 0), { changed: true, terminal: true });
    const terminal = await sql.query(
      "SELECT status, octet_length(payload_ciphertext) AS bytes FROM webhook_receipts WHERE delivery_id = $1",
      [deliveryId],
    );
    assert.equal(terminal.rows[0].status, "terminal");
    assert.ok(terminal.rows[0].bytes > 0, "terminal receipts retain their encrypted webhook body for manual reconciliation");
    assert.equal((await sql.query("SELECT count(*)::integer AS count FROM webhook_operations WHERE delivery_id = $1", [deliveryId])).rows[0].count, 1,
      "terminal processing retains the encrypted operation request that explains the stopped work");
  } finally {
    await constrained.close();
  }
});

test("the default journal budget admits a realistic 256-placement sync and its post-rejection abort", { skip }, async () => {
  const deliveryId = "40000000-0000-4000-8000-000000000016";
  const installationId = installationA;
  const verified = {
    keyId: "50000000-0000-4000-8000-000000000001",
    bodySha256: "h".repeat(64),
    event: { id: deliveryId, type: "sync.requested", installationId: installationA, integrationId, siteId },
  };
  await database.recordReceipt(verified, encrypt(Buffer.from("receipt"), encryptionKey, `receipt:${deliveryId}`));
  const receipt = await database.leaseNextReceipt(30);
  const placements = Array.from({ length: 256 }, (_, index) => ({
    placementId: `70000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    componentId: "schedule",
    configurationRevision: index + 1,
    fragmentRevision: index,
    configJson: JSON.stringify({ location: `Studio ${String(index).padStart(3, "0")} ${"x".repeat(109)}`, showCapacity: index % 2 === 0 }),
  }));
  const keys = [
    "begin-sync",
    "list-placements",
    ...placements.map((placement) => `full-placement-${placement.placementId}`),
    "reserve-media", "upload-media", "confirm-media", "page", "document", "complete-sync", "abort-failed-sync",
  ];
  const listReply = {
    placements,
  };
  const listResponse = encrypt(JSON.stringify(listReply), encryptionKey, `operation:${deliveryId}:list-placements:response`);
  assert.ok(listResponse.ciphertext.byteLength > 65_536, "the real 256-placement reply exceeds the old 64 KiB response cap");

  for (const key of keys) {
    const placement = placements.find((candidate) => key === `full-placement-${candidate.placementId}`);
    const requestValue = placement ? {
      installationId, syncId: "80000000-0000-4000-8000-000000000001", placementId: placement.placementId,
      configurationRevision: placement.configurationRevision, expectedFragmentRevision: placement.fragmentRevision,
      html: placementFragment(JSON.parse(placement.configJson)), structuredData: [], idempotencyKey: key,
    } : { installationId, syncId: "80000000-0000-4000-8000-000000000001", idempotencyKey: key };
    const request = encrypt(JSON.stringify(requestValue), encryptionKey, `operation:${deliveryId}:${key}:request`);
    assert.equal((await database.startOperation(receipt, key, request, true)).state, "new");
    if (key === "list-placements") {
      assert.equal(await database.completeOperation(receipt, key, listResponse), true);
    }
  }
  assert.equal(keys.length, 265, "the rejected completion has a bounded journal slot for its candidate abort");
  assert.equal((await sql.query("SELECT count(*)::integer AS count FROM webhook_operations WHERE delivery_id = $1", [deliveryId])).rows[0].count, 265);
  assert.equal(await database.completeReceipt(receipt), true);
});

test("installation credentials stay encrypted, lifecycle events revoke settings, and rows do not cross installations", { skip }, async () => {
  await applyLifecycle(lifecycleEvent(installationA));
  await applyLifecycle(lifecycleEvent(installationB));
  const secret = "installation-credential-a";
  await database.storeCredential(installationA, encrypt(secret, encryptionKey, `installation:${installationA}:credential`));

  const stored = await sql.query("SELECT credential_ciphertext FROM installations WHERE installation_id = $1", [installationA]);
  assert.doesNotMatch(stored.rows[0].credential_ciphertext.toString("utf8"), /installation-credential-a/u);
  const a = await database.installation(installationA);
  const b = await database.installation(installationB);
  assert.equal(decrypt(a.credential, encryptionKey, `installation:${installationA}:credential`).toString("utf8"), secret);
  assert.equal(b.credential, undefined, "an installation cannot read another installation's credential row");

  await applyLifecycle(lifecycleEvent(installationA, "suspended", 2));
  const suspended = await database.installation(installationA);
  assert.ok(suspended.credential_revoked_at, "suspension prevents later use of the persisted credential");
  await applyLifecycle(lifecycleEvent(installationA, "active", 3));
  assert.equal((await database.installation(installationA)).credential_revoked_at, null, "a later active lifecycle revision restores the encrypted installation credential");

  const reissue = {
    ...lifecycleEvent(installationA, "active", 4),
    type: "installation.created",
    data: {
      installation: { ...lifecycleEvent(installationA, "pending_claim", 4).data },
      claimCode: "new-claim",
      claimExpiresAt: "2026-01-01T00:00:00Z",
    },
  };
  await applyLifecycle(reissue);
  assert.equal((await database.installation(installationA)).credential, undefined, "a higher pending-claim revision removes the old encrypted key before reissue");
  const replacement = encrypt("replacement-credential", encryptionKey, `installation:${installationA}:credential`);
  const claimDeliveryId = "40000000-0000-4000-8000-000000000002";
  await database.recordReceipt({
    keyId: "50000000-0000-4000-8000-000000000001",
    bodySha256: "c".repeat(64),
    event: { id: claimDeliveryId, type: "installation.created", installationId: installationA, integrationId, siteId },
  }, encrypt(Buffer.from("claim"), encryptionKey, `receipt:${claimDeliveryId}`));
  const claimLease = await database.leaseNextReceipt(10);
  await database.storeClaimedCredential({
    id: installationA,
    integrationId,
    siteId,
    revision: 4,
    grantedCapabilities: ["pages.manage_own"],
    publishPolicy: "stage",
    contractVersion: "1",
  }, { ...replacement, id: "60000000-0000-4000-8000-000000000001" }, claimLease);
  assert.equal(decrypt((await database.installation(installationA)).credential, encryptionKey,
    `installation:${installationA}:credential`).toString("utf8"), "replacement-credential");
  await database.completeReceipt(claimLease);
});

test("pending handoffs are encrypted, single-use, and lifecycle revisions cannot revive an invalidated session", { skip }, async () => {
  await applyLifecycle(lifecycleEvent(installationA, "active", 10));
  const credentialId = "60000000-0000-4000-8000-000000000002";
  await sql.query("UPDATE installations SET credential_id = $2 WHERE installation_id = $1", [installationA, credentialId]);
  const lifecycleCutoffRevision = (await database.installation(installationA)).session_cutoff_revision;
  await database.createSettingsSession({
    hash: "old-session", jti: "old-jti", installationId: installationA, siteId, userId: "70000000-0000-4000-8000-000000000001",
    role: "owner", credentialId, engagementId: null, lifecycleCutoffRevision,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.ok(await database.readSettingsSession("old-session"));
  await applyLifecycle(lifecycleEvent(installationA, "suspended", 11));
  await applyLifecycle(lifecycleEvent(installationA, "active", 12));
  assert.equal(await database.readSettingsSession("old-session"), undefined, "resumption cannot restore a session invalidated by a lifecycle cutoff");

  const state = "80000000-0000-4000-8000-000000000001";
  const token = "signed-handoff-kept-off-the-browser-after-entry";
  await database.reservePendingHandoff({
    state, jti: "pending-jti", installationId: installationA,
    token: encrypt(token, encryptionKey, `pending-handoff:${state}`),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(await database.hasHandoffJti("pending-jti"), true);
  const pending = await database.consumePendingHandoff(state);
  assert.equal(decrypt(pending.token, encryptionKey, `pending-handoff:${state}`).toString("utf8"), token);
  await assert.rejects(() => database.consumePendingHandoff(state), (error) => error.code === "handoff_unavailable");
});


test("an idle PostgreSQL connection loss reconnects without an unhandled pool error", { skip }, async () => {
  const url = new URL(connectionString);
  const application = "reference-idle-recovery-test";
  url.searchParams.set("application_name", application);
  const recovering = new ReferenceDatabase(url.href);
  try {
    await recovering.ping();
    const terminated = await sql.query("SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE application_name = $1", [application]);
    assert.equal(terminated.rowCount, 1, "terminate only this test's dedicated idle client");
    assert.equal(terminated.rows[0].terminated, true);
    // Let pg deliver the asynchronous idle-client error before reacquiring.
    await new Promise(resolve => setTimeout(resolve, 25));
    await recovering.ping();
  } finally {
    await recovering.close();
  }
});
