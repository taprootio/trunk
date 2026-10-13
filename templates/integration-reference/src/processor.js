import { decrypt, encrypt } from "./crypto.js";
import { contentHash, idempotencyKey, placementFragment, referenceDocument, referenceMedia, referencePage } from "./content.js";

class TerminalProcessingError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function errorCode(error) {
  const code = typeof error?.code === "string" ? error.code : "processing_failed";
  return /^[A-Za-z0-9_.-]{1,80}$/u.test(code) ? code : "processing_failed";
}

function isTerminal(error) {
  if (error instanceof TerminalProcessingError) return true;
  if (["claim_response_unknown", "upload_response_unknown"].includes(error?.code)) return true;
  const status = error?.status;
  return Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function isPlacementRevisionConflict(error) {
  return error?.code === "configuration_revision_conflict" || error?.code === "fragment_revision_conflict";
}

// One refresh creates a new request identity without allowing revision churn
// to consume the receipt's bounded journal reservation.
const MAX_FULL_SYNC_PLACEMENT_REFRESHES = 1;

function parseReceipt(receipt, config) {
  try { return JSON.parse(decrypt(receipt.payload, config.encryptionKey, `receipt:${receipt.delivery_id}`).toString("utf8")); }
  catch { throw new TerminalProcessingError("unreadable_receipt"); }
}

function operationAad(receipt, operationKey, kind) {
  return `operation:${receipt.delivery_id}:${operationKey}:${kind}`;
}

function parseOperation(envelope, receipt, operationKey, kind, config) {
  try { return JSON.parse(decrypt(envelope, config.encryptionKey, operationAad(receipt, operationKey, kind)).toString("utf8")); }
  catch { throw new TerminalProcessingError("unreadable_operation_journal"); }
}

async function operation({ database, config, receipt, operationKey, request, retrySafe, call }) {
  // Each SDK call is bounded to ten seconds. Renew immediately before its
  // journaled side effect so a full sync cannot outlive its original lease.
  await database.renewReceiptLease(receipt, config.webhookLeaseSeconds);
  const requestEnvelope = encrypt(JSON.stringify(request), config.encryptionKey, operationAad(receipt, operationKey, "request"));
  const state = await database.startOperation(receipt, operationKey, requestEnvelope, retrySafe);
  if (state.state === "succeeded") {
    return parseOperation({ ciphertext: state.row.response_ciphertext, nonce: state.row.response_nonce, tag: state.row.response_tag }, receipt, operationKey, "response", config);
  }
  if (state.state === "pending" && !state.row.retry_safe) {
    throw new TerminalProcessingError(`${operationKey}_outcome_unknown`);
  }
  const durableRequest = state.state === "pending"
    ? parseOperation({ ciphertext: state.row.request_ciphertext, nonce: state.row.request_nonce, tag: state.row.request_tag }, receipt, operationKey, "request", config)
    : request;
  const response = await call(durableRequest);
  const responseEnvelope = encrypt(JSON.stringify(response ?? null), config.encryptionKey, operationAad(receipt, operationKey, "response"));
  if (!await database.completeOperation(receipt, operationKey, responseEnvelope)) throw new Error("operation_lease_lost");
  return response;
}

async function activeInstallation(database, config, installationId) {
  const installation = await database.installation(installationId);
  if (!installation || installation.status !== "active" || installation.credential_revoked_at || !installation.credential) {
    throw new Error("installation_not_ready");
  }
  return { ...installation, credential: decrypt(installation.credential, config.encryptionKey, `installation:${installationId}:credential`).toString("utf8") };
}

function parsePlacementConfig(placement) {
  try { return JSON.parse(placement.configJson); }
  catch { throw new TerminalProcessingError("invalid_placement_configuration"); }
}

export function createWebhookProcessor({ config, database, taproot, logger = process.stderr }) {
  let interval;
  let stopping = false;
  let draining = false;
  let active = Promise.resolve();

  async function savedOperation(receipt, operationKey, request, retrySafe, call) {
    return operation({ database, config, receipt, operationKey, request, retrySafe, call });
  }

  async function processContent(event, installation, receipt) {
    const client = taproot.installationClient(installation.credential);
    const started = await savedOperation(receipt, "begin-sync", {
      installationId: event.installationId, mode: config.referenceSyncMode === "incremental" ? "incremental" : "full", requestedSyncId: event.data.syncId,
      idempotencyKey: idempotencyKey(receipt.delivery_id, "begin-sync"),
    }, true, (request) => client.createSync(request));
    const syncId = started?.syncId;
    if (typeof syncId !== "string" || syncId.length === 0) throw new TerminalProcessingError("invalid_sync_response");

    if (config.referenceSyncMode === "abort") {
      await savedOperation(receipt, "abort-sync", {
        installationId: event.installationId, syncId, summary: "Controlled reference abort acceptance path.",
        idempotencyKey: idempotencyKey(receipt.delivery_id, "abort-sync"),
      }, true, (request) => client.abortSync(request));
      return;
    }

    try {
      // A full sync replaces the isolated candidate. Every current placement is
      // written into this candidate; omitting one would select its deletion.
      const placementList = await savedOperation(receipt, "list-placements", { installationId: event.installationId }, true,
        (request) => client.listPlacements(request));
      let refreshes = 0;
      for (const placement of placementList?.placements ?? []) {
        if (config.referenceSyncMode === "delete") {
          await savedOperation(receipt, `delete-placement-${placement.placementId}`, {
            installationId: event.installationId, placementId: placement.placementId,
            configurationRevision: placement.configurationRevision, expectedFragmentRevision: placement.fragmentRevision, syncId,
            idempotencyKey: idempotencyKey(receipt.delivery_id, `delete-placement-${placement.placementId}`),
          }, true, (request) => client.deleteFragment(request));
          continue;
        }
        let current = placement;
        let placementRefresh = 0;
        for (;;) {
          const operationKey = placementRefresh === 0
            ? `full-placement-${current.placementId}`
            : `full-placement-${current.placementId}-refresh-${placementRefresh}`;
          try {
            await savedOperation(receipt, operationKey, {
              installationId: event.installationId, placementId: current.placementId,
              configurationRevision: current.configurationRevision, expectedFragmentRevision: current.fragmentRevision,
              html: placementFragment(parsePlacementConfig(current)), structuredData: [], syncId,
              idempotencyKey: idempotencyKey(receipt.delivery_id, operationKey),
            }, true, (request) => client.putFragment(request));
            break;
          } catch (error) {
            if (!isPlacementRevisionConflict(error) || refreshes >= MAX_FULL_SYNC_PLACEMENT_REFRESHES) throw error;
            refreshes += 1;
            placementRefresh = refreshes;
            // A different journal key means the new request and idempotency key
            // cannot replay the stale configuration revision that just failed.
            const refreshed = await savedOperation(receipt, `list-placements-refresh-${refreshes}`,
              { installationId: event.installationId }, true, (request) => client.listPlacements(request));
            current = refreshed?.placements?.find((candidate) => candidate.placementId === placement.placementId);
            // The owner removed the placement while this full candidate was
            // being built. Omission is the candidate's authoritative removal.
            if (!current) break;
          }
        }
      }

      if (config.referenceSyncMode === "delete") {
        await savedOperation(receipt, "delete-page", {
          installationId: event.installationId, syncId, externalId: "reference-welcome",
          idempotencyKey: idempotencyKey(receipt.delivery_id, "delete-page"),
        }, true, (request) => client.deleteManagedPage(request));
        await savedOperation(receipt, "delete-document", {
          installationId: event.installationId, syncId, key: "reference.schedule",
          idempotencyKey: idempotencyKey(receipt.delivery_id, "delete-document"),
        }, true, (request) => client.deleteDataDocument(request));
        await savedOperation(receipt, "complete-sync", {
          installationId: event.installationId, syncId, summary: "Controlled reference deletion acceptance path.",
          idempotencyKey: idempotencyKey(receipt.delivery_id, "complete-sync"),
        }, true, (request) => client.completeSync(request));
        return;
      }

      const media = referenceMedia();
      const reserved = await savedOperation(receipt, "reserve-media", {
        installationId: event.installationId, fileName: media.fileName, contentType: media.contentType,
        fileSize: media.bytes.byteLength, contentHash: contentHash(media.bytes), width: media.width, height: media.height,
      }, false, (request) => client.requestMediaUpload(request));
      let image = reserved.image;
      if (!reserved.isDuplicate) {
        await savedOperation(receipt, "upload-media", {
          url: reserved.presignedUrl, requiredHeaders: reserved.requiredHeaders, bodyBase64: media.bytes.toString("base64"),
        }, false, (request) => client.uploadPresigned({ url: request.url, requiredHeaders: request.requiredHeaders, body: Buffer.from(request.bodyBase64, "base64") }));
        const confirmed = await savedOperation(receipt, "confirm-media", {
          installationId: event.installationId, uploadId: reserved.uploadId,
        }, false, (request) => client.confirmMediaUpload(request));
        image = confirmed.image;
      }
      if (typeof image?.imageId !== "string") throw new TerminalProcessingError("invalid_media_response");

      const page = referencePage(config.publicOrigin, event.installationId);
      await savedOperation(receipt, "page", {
        installationId: event.installationId, syncId,
        page: { ...page, fragments: [...page.fragments, `<p><img data-image-id="${image.imageId}" alt="Reference marker" width="8" height="8" loading="lazy" decoding="async"></p>`] },
        idempotencyKey: idempotencyKey(receipt.delivery_id, "page"),
      }, true, (request) => client.putManagedPage(request));
      const document = referenceDocument();
      await savedOperation(receipt, "document", {
        installationId: event.installationId, syncId, ...document, idempotencyKey: idempotencyKey(receipt.delivery_id, "document"),
      }, true, (request) => client.putDataDocument(request));
      await savedOperation(receipt, "complete-sync", {
        installationId: event.installationId, syncId,
        summary: "Reference page, media, data document, and every current placement updated.",
        idempotencyKey: idempotencyKey(receipt.delivery_id, "complete-sync"),
      }, true, (request) => client.completeSync(request));
    } catch (error) {
      if (isTerminal(error)) {
        await savedOperation(receipt, "abort-failed-sync", {
          installationId: event.installationId, syncId, summary: "Reference input rejected; isolated candidate aborted.",
          idempotencyKey: idempotencyKey(receipt.delivery_id, "abort-failed-sync"),
        }, true, (request) => client.abortSync(request));
      }
      throw error;
    }
  }

  async function processPlacement(event, installation, receipt) {
    if (event.type === "placement.deleted") {
      // Taproot alone selects the retained published fragment's remove/freeze disposition.
      return;
    }
    const client = taproot.installationClient(installation.credential);
    const placements = await savedOperation(receipt, "list-placements", { installationId: event.installationId }, true,
      (request) => client.listPlacements(request));
    const placement = placements?.placements?.find((candidate) => candidate.placementId === event.data.placementId);
    if (!placement || placement.configurationRevision !== event.data.placementRevision) return;
    await savedOperation(receipt, "placement", {
      installationId: event.installationId, placementId: event.data.placementId,
      configurationRevision: event.data.placementRevision, expectedFragmentRevision: placement.fragmentRevision,
      html: placementFragment(event.data.config), structuredData: [],
      idempotencyKey: idempotencyKey(receipt.delivery_id, "placement"),
    }, true, (request) => client.putFragment(request));
  }

  async function processClaim(event, receipt) {
    const existing = await database.installation(event.installationId);
    if (!existing || existing.integration_id !== event.integrationId || existing.site_id !== event.siteId) throw new TerminalProcessingError("claim_binding_mismatch");
    if (existing.credential) return;
    const claim = await savedOperation(receipt, "claim", {
      installationId: event.installationId, claimCode: event.data.claimCode,
    }, false, async (request) => {
      if (existing.status !== "pending_claim") throw new TerminalProcessingError("stale_claim_delivery");
      return taproot.publisherClient().claimInstallation(request);
    });
    if (claim.installation?.id !== event.installationId || claim.installation.integrationId !== event.integrationId || claim.installation.siteId !== event.siteId) {
      throw new TerminalProcessingError("claim_binding_mismatch");
    }
    if (typeof claim.credential?.secret !== "string" || claim.credential.secret.length === 0) {
      if ((await database.installation(event.installationId))?.credential) return;
      throw new TerminalProcessingError("claim_secret_not_recoverable");
    }
    await database.storeClaimedCredential(claim.installation, {
      ...encrypt(claim.credential.secret, config.encryptionKey, `installation:${event.installationId}:credential`),
      id: claim.credential.id,
    }, receipt);
  }

  async function handle(receipt) {
    const event = parseReceipt(receipt, config);
    if (event.integrationId !== config.integrationId) throw new TerminalProcessingError("wrong_integration");
    if (event.type === "installation.created" || event.type.startsWith("installation.")) {
      await database.renewReceiptLease(receipt, config.webhookLeaseSeconds);
      const applied = await database.upsertLifecycle(event, receipt);
      // A same-revision pending claim is deliberately "applied" again: if a
      // process crashed after persisting lifecycle state but before the claim,
      // the retry must still make the one safe claim attempt. Other stale
      // lifecycle payloads never invalidate sessions or trigger side effects.
      if (!applied) return;
      const lifecycle = event.type === "installation.created" ? event.data?.installation : event.data;
      if (lifecycle?.status === "pending_claim" || lifecycle?.status === "suspended" ||
          lifecycle?.status === "uninstalled" || lifecycle?.sourceTerminationReason) {
        await database.invalidateInstallationSessions(event.installationId, receipt);
      }
      if (event.type === "installation.created") await processClaim(event, receipt);
      return;
    }
    if (event.type === "sync.requested") return processContent(event, await activeInstallation(database, config, event.installationId), receipt);
    if (event.type.startsWith("placement.")) await processPlacement(event, await activeInstallation(database, config, event.installationId), receipt);
  }

  async function drainOne() {
    await database.recoverExpiredLeases(config.webhookMaxAttempts);
    const receipt = await database.leaseNextReceipt(config.webhookLeaseSeconds);
    if (!receipt) return false;
    try {
      await handle(receipt);
      await database.renewReceiptLease(receipt, config.webhookLeaseSeconds);
      if (!await database.completeReceipt(receipt)) throw new Error("operation_lease_lost");
    } catch (error) {
      const result = await database.retryReceipt(receipt, errorCode(error), isTerminal(error) ? 0 : config.webhookMaxAttempts);
      if (result.terminal) logger.write(`Webhook ${receipt.delivery_id} reached terminal state: ${errorCode(error)}\n`);
    }
    return true;
  }

  function logDrainFailure(error) {
    logger.write(`Webhook drain deferred: ${errorCode(error)}\n`);
  }

  async function drain({ propagate = false } = {}) {
    if (stopping) return;
    // A timer or HTTP wake-up may arrive while the background drain is
    // running. Its bounded failure is logged by that drain; a later wake can
    // continue after it settles.
    if (draining) {
      await active.catch(() => {});
      return;
    }
    draining = true;
    active = (async () => {
      try {
        while (!stopping && await drainOne()) { /* bounded serialized work */ }
      } catch (error) {
        logDrainFailure(error);
        if (propagate) throw error;
      } finally {
        draining = false;
      }
    })();
    return active;
  }

  return {
    async start() {
      try {
        // Recovery is the fail-closed startup database check. The potentially
        // long drain runs in the background so health routing can bind first.
        await database.recoverExpiredLeases(config.webhookMaxAttempts);
        interval = setInterval(() => { void drain(); }, config.webhookPollMilliseconds);
        void drain();
      } catch (error) {
        if (interval) clearInterval(interval);
        stopping = true;
        throw error;
      }
    },
    wake() { return drain(); },
    async stop() { stopping = true; if (interval) clearInterval(interval); await active; },
    drainOne,
  };
}
