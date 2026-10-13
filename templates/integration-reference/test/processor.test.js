import assert from "node:assert/strict";
import test from "node:test";

import { decrypt, encrypt } from "../src/crypto.js";
import { createWebhookProcessor } from "../src/processor.js";

const encryptionKey = Buffer.alloc(32, 19);
const integrationId = "10000000-0000-4000-8000-000000000001";
const siteId = "20000000-0000-4000-8000-000000000001";
const installationId = "30000000-0000-4000-8000-000000000001";

function processorConfig(overrides = {}) {
  return {
    encryptionKey,
    integrationId,
    publicOrigin: "https://receiver.example.test",
    referenceSyncMode: "full",
    webhookLeaseSeconds: 60,
    webhookMaxAttempts: 3,
    webhookPollMilliseconds: 30_000,
    webhookLimits: {
      maxOperationsPerReceipt: 512,
      maxOperationResponseBytes: 524_288,
      ...overrides.webhookLimits,
    },
    ...overrides,
  };
}

function receipt(event, deliveryId = "40000000-0000-4000-8000-000000000001", leaseToken = "50000000-0000-4000-8000-000000000001") {
  return {
    delivery_id: deliveryId,
    leaseToken,
    attempts: 1,
    payload: encrypt(JSON.stringify(event), encryptionKey, `receipt:${deliveryId}`),
  };
}

function syncEvent() {
  return {
    type: "sync.requested",
    integrationId,
    siteId,
    installationId,
    data: { syncId: "60000000-0000-4000-8000-000000000001" },
  };
}

function claimedInstallation() {
  return {
    id: installationId,
    integrationId,
    siteId,
    revision: 1,
    grantedCapabilities: ["pages.manage_own"],
    publishPolicy: "stage",
    contractVersion: "1",
  };
}

function activeInstallation() {
  return {
    installation_id: installationId,
    integration_id: integrationId,
    site_id: siteId,
    status: "active",
    credential_revoked_at: null,
    credential: encrypt("installation-secret", encryptionKey, `installation:${installationId}:credential`),
  };
}

function placement(index) {
  // The configuration is valid for the public manifest. `fragmentStatus` is
  // representative response metadata retained by a platform placement read.
  return {
    placementId: `70000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    componentId: "schedule",
    configurationRevision: index + 1,
    fragmentRevision: index,
    configJson: JSON.stringify({ location: `Studio ${String(index).padStart(3, "0")} ${"x".repeat(109)}`, showCapacity: index % 2 === 0 }),
    fragmentStatus: "current",
  };
}

function operationDatabase(receipts, options = {}) {
  const operations = [];
  const responses = new Map();
  const terminal = [];
  return {
    operations,
    responses,
    terminal,
    async recoverExpiredLeases() {},
    async leaseNextReceipt() { return receipts.shift(); },
    async renewReceiptLease() {},
    async startOperation(current, operationKey, request, retrySafe) {
      if (operations.length >= (options.maxOperations ?? 512)) {
        const error = new Error("operation_journal_capacity");
        error.code = "operation_journal_capacity";
        error.status = 413;
        throw error;
      }
      operations.push({ current, operationKey, request, retrySafe });
      return { state: "new", row: {} };
    },
    async completeOperation(current, operationKey, response) {
      responses.set(operationKey, decrypt(response, encryptionKey, `operation:${current.delivery_id}:${operationKey}:response`));
      return true;
    },
    async completeReceipt() { return true; },
    async retryReceipt(current, code, maxAttempts) {
      const result = { changed: true, terminal: current.attempts >= maxAttempts };
      terminal.push({ code, result });
      return result;
    },
    async installation() { return activeInstallation(); },
    async upsertLifecycle() { return true; },
    async invalidateInstallationSessions() {},
    async storeClaimedCredential() {},
  };
}

function fullSyncClient({ failComplete = false, listPlacements, putFragment } = {}) {
  const placements = Array.from({ length: 256 }, (_, index) => placement(index));
  return {
    createSync: async () => ({ syncId: "80000000-0000-4000-8000-000000000001" }),
    listPlacements: listPlacements ?? (async () => ({ placements })),
    putFragment: putFragment ?? (async () => ({ changed: true })),
    requestMediaUpload: async () => ({ isDuplicate: false, presignedUrl: "https://upload.example.test", requiredHeaders: {}, uploadId: "upload-1" }),
    uploadPresigned: async () => {},
    confirmMediaUpload: async () => ({ image: { imageId: "90000000-0000-4000-8000-000000000001" } }),
    putManagedPage: async () => ({ changed: true }),
    putDataDocument: async () => ({ changed: true }),
    completeSync: async () => {
      if (failComplete) {
        const error = new Error("candidate_rejected");
        error.code = "candidate_rejected";
        error.status = 400;
        throw error;
      }
      return { changed: true };
    },
    abortSync: async () => ({ aborted: true }),
  };
}

test("a 256-placement full sync journals every operation and its placement response within the production budget", async () => {
  const current = receipt(syncEvent());
  const database = operationDatabase([current]);
  const client = fullSyncClient();
  const logger = { write: () => {} };
  const processor = createWebhookProcessor({
    config: processorConfig(), database, logger,
    taproot: { installationClient: () => client },
  });

  assert.equal(await processor.drainOne(), true);
  assert.equal(database.operations.length, 264, "256 placements plus sync, media, page, document, and completion operations fit below 512");
  assert.equal(database.operations.at(-1).operationKey, "complete-sync");
  const placementResponse = database.responses.get("list-placements");
  assert.ok(placementResponse.byteLength > 65_536, "a 256-placement response is larger than the former 64 KiB response budget");
  assert.ok(placementResponse.byteLength <= 524_288);
});

test("a rejected 256-placement completion still journals the isolated-candidate abort within capacity", async () => {
  const current = receipt(syncEvent());
  const database = operationDatabase([current]);
  const client = fullSyncClient({ failComplete: true });
  const processor = createWebhookProcessor({
    config: processorConfig(), database, logger: { write: () => {} },
    taproot: { installationClient: () => client },
  });

  assert.equal(await processor.drainOne(), true);
  assert.equal(database.operations.length, 265, "the post-failure abort has room after the 264-operation full-sync path");
  assert.equal(database.operations.at(-1).operationKey, "abort-failed-sync");
  assert.deepEqual(database.terminal, [{ code: "candidate_rejected", result: { changed: true, terminal: true } }]);
});

test("a full sync refreshes one conflicted placement with a new durable operation identity", async () => {
  const current = receipt(syncEvent());
  const database = operationDatabase([current]);
  const initial = placement(0);
  const refreshed = { ...placement(0), configurationRevision: 2, fragmentRevision: 1,
    configJson: JSON.stringify({ location: "Updated studio", showCapacity: true }) };
  let lists = 0;
  const fragmentRequests = [];
  const client = fullSyncClient({
    listPlacements: async () => ({ placements: lists++ === 0 ? [initial] : [refreshed] }),
    putFragment: async (request) => {
      fragmentRequests.push(request);
      if (fragmentRequests.length === 1) {
        const error = new Error("configuration_revision_conflict");
        error.code = "configuration_revision_conflict";
        error.status = 400;
        throw error;
      }
      return { changed: true };
    },
  });
  const processor = createWebhookProcessor({
    config: processorConfig(), database, logger: { write: () => {} }, taproot: { installationClient: () => client },
  });

  assert.equal(await processor.drainOne(), true);
  assert.equal(lists, 2);
  assert.deepEqual(fragmentRequests.map((request) => [request.configurationRevision, request.expectedFragmentRevision]), [[1, 0], [2, 1]]);
  assert.deepEqual(database.operations.filter((entry) => entry.operationKey.includes("placement")).map((entry) => entry.operationKey), [
    `list-placements`, `full-placement-${initial.placementId}`, "list-placements-refresh-1", `full-placement-${initial.placementId}-refresh-1`,
  ]);
  assert.deepEqual(database.terminal, []);
});

test("a full sync limits revision-conflict refreshes before terminal processing", async () => {
  const current = receipt(syncEvent());
  const database = operationDatabase([current]);
  const client = fullSyncClient({
    listPlacements: async () => ({ placements: [placement(0)] }),
    putFragment: async () => {
      const error = new Error("fragment_revision_conflict");
      error.code = "fragment_revision_conflict";
      error.status = 400;
      throw error;
    },
  });
  const processor = createWebhookProcessor({
    config: processorConfig(), database, logger: { write: () => {} }, taproot: { installationClient: () => client },
  });

  assert.equal(await processor.drainOne(), true);
  assert.deepEqual(database.operations.filter((entry) => entry.operationKey.includes("placement")).map((entry) => entry.operationKey), [
    "list-placements", `full-placement-${placement(0).placementId}`, "list-placements-refresh-1", `full-placement-${placement(0).placementId}-refresh-1`,
  ]);
  assert.deepEqual(database.terminal, [{ code: "fragment_revision_conflict", result: { changed: true, terminal: true } }]);
});

test("a stale lifecycle payload cannot invalidate settings", async () => {
  const event = {
    type: "installation.suspended", integrationId, siteId, installationId,
    data: { status: "suspended", revision: 2 },
  };
  const current = receipt(event);
  let invalidations = 0;
  const database = operationDatabase([current]);
  database.upsertLifecycle = async () => false;
  database.invalidateInstallationSessions = async () => { invalidations += 1; };
  const processor = createWebhookProcessor({
    config: processorConfig(), database, logger: { write: () => {} }, taproot: {},
  });

  assert.equal(await processor.drainOne(), true);
  assert.equal(invalidations, 0);
});

test("a retry after lifecycle persistence still claims the same pending installation", async () => {
  const event = {
    type: "installation.created", integrationId, siteId, installationId,
    data: { installation: { status: "pending_claim", revision: 1, grantedCapabilities: ["pages.manage_own"], publishPolicy: "stage", contractVersion: "1" }, claimCode: "claim-code" },
  };
  const first = receipt(event, "40000000-0000-4000-8000-000000000002", "50000000-0000-4000-8000-000000000002");
  const second = receipt(event, first.delivery_id, "50000000-0000-4000-8000-000000000003");
  const database = operationDatabase([first, second]);
  let installations = 0;
  let claims = 0;
  let stored = 0;
  database.installation = async () => {
    installations += 1;
    if (installations === 1) {
      const error = new Error("database temporarily unavailable before claim");
      error.code = "db_transient";
      throw error;
    }
    return { installation_id: installationId, integration_id: integrationId, site_id: siteId, status: "pending_claim" };
  };
  database.storeClaimedCredential = async () => { stored += 1; };
  const processor = createWebhookProcessor({
    config: processorConfig(), database, logger: { write: () => {} },
    taproot: {
      publisherClient: () => ({
        claimInstallation: async () => {
          claims += 1;
          return { installation: claimedInstallation(), credential: { id: "60000000-0000-4000-8000-000000000001", secret: "claimed-secret" } };
        },
      }),
    },
  });

  await processor.drainOne();
  await processor.drainOne();
  assert.equal(claims, 1);
  assert.equal(stored, 1);
  assert.equal(database.operations.filter((entry) => entry.operationKey === "claim").length, 1);
});

test("a pending non-retry-safe claim journal stops instead of repeating its one-time claim", async () => {
  const event = {
    type: "installation.created", integrationId, siteId, installationId,
    data: { installation: { status: "pending_claim", revision: 1, grantedCapabilities: ["pages.manage_own"], publishPolicy: "stage", contractVersion: "1" }, claimCode: "claim-code" },
  };
  const database = operationDatabase([receipt(event)]);
  database.installation = async () => ({ installation_id: installationId, integration_id: integrationId, site_id: siteId, status: "pending_claim" });
  database.startOperation = async (current, operationKey, request, retrySafe) => {
    database.operations.push({ current, operationKey, request, retrySafe });
    return { state: "pending", row: { retry_safe: false } };
  };
  let claims = 0;
  const processor = createWebhookProcessor({
    config: processorConfig(), database, logger: { write: () => {} },
    taproot: { publisherClient: () => ({ claimInstallation: async () => { claims += 1; } }) },
  });

  assert.equal(await processor.drainOne(), true);
  assert.equal(claims, 0);
  assert.deepEqual(database.terminal, [{ code: "claim_outcome_unknown", result: { changed: true, terminal: true } }]);
});

test("a transient drain failure is logged by code only and a later wake continues", async () => {
  let failRecovery = false;
  let leases = 0;
  const writes = [];
  const database = operationDatabase([]);
  database.recoverExpiredLeases = async () => {
    if (failRecovery) {
      failRecovery = false;
      const error = new Error("postgres password super-secret-value");
      error.code = "db_transient";
      throw error;
    }
  };
  database.leaseNextReceipt = async () => { leases += 1; };
  const processor = createWebhookProcessor({
    config: processorConfig(), database, logger: { write: (line) => writes.push(line) }, taproot: {},
  });

  await processor.start();
  await processor.wake(); // Settle the background startup drain.
  failRecovery = true;
  await processor.wake();
  const leasesAfterFailure = leases;
  await processor.wake();
  await processor.stop();
  assert.deepEqual(writes, ["Webhook drain deferred: db_transient\n"]);
  assert.equal(leases, leasesAfterFailure + 1, "a later wake resumes polling after the database failure");
});

test("a wake that joins a failing background startup drain stays settled after startup health passes", async () => {
  let recoveries = 0;
  let enteredDrain;
  let releaseDrain;
  const entered = new Promise((resolve) => { enteredDrain = resolve; });
  const release = new Promise((resolve) => { releaseDrain = resolve; });
  const failure = new Error("database secret must not escape");
  failure.code = "db_unavailable";
  const database = operationDatabase([]);
  database.recoverExpiredLeases = async () => {
    recoveries += 1;
    if (recoveries === 2) {
      enteredDrain();
      await release;
      throw failure;
    }
  };
  const writes = [];
  const processor = createWebhookProcessor({
    config: processorConfig(), database, logger: { write: (line) => writes.push(line) }, taproot: {},
  });

  const starting = processor.start();
  await entered;
  let timeout;
  try {
    await assert.doesNotReject(() => Promise.race([
      starting,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("startup waited for the queued drain")), 500); }),
    ]));
    clearTimeout(timeout);
    const joinedWake = processor.wake();
    releaseDrain();
    await assert.doesNotReject(() => joinedWake);
    assert.deepEqual(writes, ["Webhook drain deferred: db_unavailable\n"]);
  } finally {
    clearTimeout(timeout);
    releaseDrain();
    await processor.stop();
  }
});

test("startup remains fail-closed when PostgreSQL recovery is unavailable", async () => {
  const database = operationDatabase([]);
  const error = new Error("database unavailable");
  error.code = "db_unavailable";
  database.recoverExpiredLeases = async () => { throw error; };
  const processor = createWebhookProcessor({
    config: processorConfig(), database, logger: { write: () => {} }, taproot: {},
  });

  await assert.rejects(() => processor.start(), (received) => received === error);
});
