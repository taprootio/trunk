import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const MIGRATIONS = ["001_initial.sql", "002_operation_journal.sql", "003_lifecycle_session_bindings.sql", "004_pending_settings_handoffs.sql", "005_single_installation_worker.sql", "006_operation_response_reservations.sql"];
const DEFAULT_WEBHOOK_LIMITS = Object.freeze({
  maxReceiptBytes: 262_144,
  maxRetainedReceipts: 50_000,
  maxOutstandingReceipts: 512,
  maxOperationsPerReceipt: 512,
  maxOperationBytesPerReceipt: 2_097_152,
  maxOperationResponseBytes: 524_288,
});

function decodeEnvelope(row, prefix) {
  return {
    ciphertext: row[`${prefix}_ciphertext`],
    nonce: row[`${prefix}_nonce`],
    tag: row[`${prefix}_tag`],
  };
}

function delayForAttempt(attempt) {
  return Math.min(300, 2 ** Math.min(attempt, 8));
}

function envelopeBytes(envelope) {
  return envelope.ciphertext.byteLength + envelope.nonce.byteLength + envelope.tag.byteLength;
}

function capacityError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function leaseError() {
  const error = new Error("operation_lease_lost");
  error.code = "operation_lease_lost";
  return error;
}

function responseReservation(operationKey, limits) {
  if (operationKey === "list-placements" || operationKey.startsWith("list-placements-refresh-")) {
    return limits.maxOperationResponseBytes;
  }
  if (operationKey === "placement" || operationKey.startsWith("full-placement-") || operationKey.startsWith("delete-placement-")) {
    return Math.min(4_096, limits.maxOperationResponseBytes);
  }
  return Math.min(16_384, limits.maxOperationResponseBytes);
}

const CONNECTION_STRING_SSL_PARAMETERS = new Set(["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert"]);

/**
 * A managed-database URL may carry libpq SSL parameters. pg gives those URL
 * parameters precedence over its explicit SSL object, so remove them when the
 * managed CA is configured and make the verification policy unambiguous.
 */
export function databasePoolOptions(databaseUrl, databaseCaCertificate) {
  const options = { max: 10, idleTimeoutMillis: 30_000 };
  if (databaseCaCertificate === undefined) return { ...options, connectionString: databaseUrl };
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be an absolute URL when DATABASE_CA_CERT is configured.");
  }
  for (const parameter of [...url.searchParams.keys()]) {
    if (CONNECTION_STRING_SSL_PARAMETERS.has(parameter.toLowerCase())) url.searchParams.delete(parameter);
  }
  return {
    ...options,
    connectionString: url.href,
    ssl: { ca: databaseCaCertificate, rejectUnauthorized: true },
  };
}

export class ReferenceDatabase {
  #pool;
  #limits;

  constructor(databaseUrl, limits = {}, databaseCaCertificate) {
    this.#pool = new Pool(databasePoolOptions(databaseUrl, databaseCaCertificate));
    this.#pool.on("error", () => {
      // pg has already discarded the failed idle client. Never log its error
      // object: it can carry connection credentials and backend state.
      process.stderr.write("PostgreSQL idle connection lost; the next operation will reconnect.\n");
    });
    this.#limits = Object.freeze({ ...DEFAULT_WEBHOOK_LIMITS, ...limits });
  }

  async migrate() {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('taproot_reference_migrate'))");
      await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      for (const migration of MIGRATIONS) {
        const prior = await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", [migration]);
        if (prior.rowCount === 0) {
          const source = await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8");
          await client.query(source);
          await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migration]);
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.#pool.end();
  }

  async ping() {
    await this.#pool.query("SELECT 1");
  }

  async recordReceipt(verified, envelope) {
    const event = verified.event;
    // AES-GCM adds a fixed nonce/tag overhead. The HTTP raw-body limit bounds
    // this encrypted durable value before this method ever starts a transaction.
    if (envelopeBytes(envelope) > this.#limits.maxReceiptBytes + 64) {
      throw capacityError("webhook_payload_too_large", 413);
    }
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      // This small service prefers an admission lock over an approximate count:
      // concurrent new deliveries must never overrun the durable cap.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('taproot_reference_receipt_admission'))");
      const existing = await client.query(
        `SELECT event_type, installation_id, integration_id, site_id, body_sha256
         FROM webhook_receipts WHERE delivery_id = $1`,
        [event.id],
      );
      if (existing.rowCount === 1) {
        const row = existing.rows[0];
        if (row.event_type !== event.type || row.installation_id !== event.installationId ||
            row.integration_id !== event.integrationId || row.site_id !== event.siteId || row.body_sha256 !== verified.bodySha256) {
          const error = new Error("receipt_conflict");
          error.code = "receipt_conflict";
          throw error;
        }
        await client.query("COMMIT");
        return false;
      }
      const retained = await client.query("SELECT count(*)::integer AS count FROM webhook_receipts");
      if (retained.rows[0].count >= this.#limits.maxRetainedReceipts) {
        throw capacityError("webhook_capacity_exhausted", 503);
      }
      const outstanding = await client.query(
        "SELECT count(*)::integer AS count FROM webhook_receipts WHERE installation_id = $1 AND status <> 'completed'",
        [event.installationId],
      );
      if (outstanding.rows[0].count >= this.#limits.maxOutstandingReceipts) {
        throw capacityError("webhook_capacity_exhausted", 503);
      }
      await client.query(
        `INSERT INTO webhook_receipts
          (delivery_id, event_type, installation_id, integration_id, site_id, signing_key_id, body_sha256,
           payload_ciphertext, payload_nonce, payload_tag, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'received')`,
        [event.id, event.type, event.installationId, event.integrationId, event.siteId, verified.keyId,
          verified.bodySha256, envelope.ciphertext, envelope.nonce, envelope.tag],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recoverExpiredLeases(maxAttempts = 8) {
    await this.#pool.query(
      `UPDATE webhook_receipts
       SET status = CASE WHEN attempts >= $1 THEN 'terminal' ELSE 'retry' END,
           lease_token = NULL, lease_expires_at = NULL,
           available_at = CASE WHEN attempts >= $1 THEN available_at ELSE
             now() + (LEAST(300, power(2, LEAST(attempts, 8))::integer) * interval '1 second') END,
           failure_code = 'lease_expired'
       WHERE status = 'processing' AND lease_expires_at <= now()`,
      [maxAttempts],
    );
  }

  async leaseNextReceipt(leaseSeconds) {
    const leaseToken = randomUUID();
    try {
      const result = await this.#pool.query(
        `WITH candidate AS (
         SELECT delivery_id
         FROM webhook_receipts candidate
         WHERE candidate.status IN ('received', 'retry') AND candidate.available_at <= now()
           AND NOT EXISTS (
             SELECT 1 FROM webhook_receipts active
             WHERE active.installation_id = candidate.installation_id AND active.status = 'processing'
           )
         ORDER BY available_at, received_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE webhook_receipts receipt
       SET status = 'processing', attempts = attempts + 1, lease_token = $1,
           lease_expires_at = now() + ($2 * interval '1 second')
       FROM candidate
       WHERE receipt.delivery_id = candidate.delivery_id
       RETURNING receipt.*`,
        [leaseToken, leaseSeconds],
      );
      if (result.rowCount === 0) return undefined;
      return { ...result.rows[0], leaseToken, payload: decodeEnvelope(result.rows[0], "payload") };
    } catch (error) {
      // The partial unique index is the cross-process backstop if two readers
      // picked different queued rows for the same installation concurrently.
      if (error?.code === "23505") return undefined;
      throw error;
    }
  }

  async renewReceiptLease(receipt, leaseSeconds) {
    const result = await this.#pool.query(
      `UPDATE webhook_receipts
       SET lease_expires_at = now() + ($3 * interval '1 second')
       WHERE delivery_id = $1 AND status = 'processing' AND lease_token = $2 AND lease_expires_at > now()`,
      [receipt.delivery_id, receipt.leaseToken, leaseSeconds],
    );
    if (result.rowCount !== 1) {
      const error = new Error("operation_lease_lost");
      error.code = "operation_lease_lost";
      throw error;
    }
  }

  async completeReceipt(receipt) {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      // Lock before changing receipt state and deleting journals. This is the
      // same per-delivery lock used by journal writers, so a writer cannot pass
      // its live-lease check and insert after this tombstone compacts.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('taproot_reference_operation:' || $1::text))", [receipt.delivery_id]);
      const result = await client.query(
        `UPDATE webhook_receipts
         SET status = 'completed', completed_at = now(), lease_token = NULL, lease_expires_at = NULL,
             payload_ciphertext = '\\x', payload_nonce = '\\x', payload_tag = '\\x', failure_code = NULL
         WHERE delivery_id = $1 AND status = 'processing' AND lease_token = $2 AND lease_expires_at > now()
         RETURNING delivery_id`,
        [receipt.delivery_id, receipt.leaseToken],
      );
      if (result.rowCount !== 1) {
        await client.query("ROLLBACK");
        return false;
      }
      // A completed tombstone retains immutable duplicate detection fields but
      // no webhook body or operation request/response ciphertext.
      await client.query("DELETE FROM webhook_operations WHERE delivery_id = $1", [receipt.delivery_id]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async startOperation(receipt, operationKey, request, retrySafe) {
    if (envelopeBytes(request) > this.#limits.maxOperationBytesPerReceipt) {
      throw capacityError("operation_journal_capacity", 413);
    }
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('taproot_reference_operation:' || $1::text))", [receipt.delivery_id]);
      const existing = await client.query(
        "SELECT * FROM webhook_operations WHERE delivery_id = $1 AND operation_key = $2 FOR UPDATE",
        [receipt.delivery_id, operationKey],
      );
      if (existing.rowCount === 1) {
        let result = { state: existing.rows[0].status, row: existing.rows[0] };
        if (existing.rows[0].status === "pending" && existing.rows[0].retry_safe) {
          const resumed = await client.query(
            `UPDATE webhook_operations
             SET lease_token = $3
             WHERE delivery_id = $1 AND operation_key = $2 AND status = 'pending' AND retry_safe
               AND EXISTS (
                 SELECT 1 FROM webhook_receipts receipt
                 WHERE receipt.delivery_id = $1 AND receipt.status = 'processing' AND receipt.lease_token = $3
                   AND receipt.lease_expires_at > now()
               )
             RETURNING *`,
            [receipt.delivery_id, operationKey, receipt.leaseToken],
          );
          if (resumed.rowCount !== 1) throw leaseError();
          result = { state: "pending", row: resumed.rows[0] };
        }
        await client.query("COMMIT");
        return result;
      }
      const live = await client.query(
        `SELECT 1 FROM webhook_receipts receipt
         WHERE receipt.delivery_id = $1 AND receipt.status = 'processing' AND receipt.lease_token = $2
           AND receipt.lease_expires_at > now()`,
        [receipt.delivery_id, receipt.leaseToken],
      );
      if (live.rowCount !== 1) throw leaseError();
      const responseReservationBytes = responseReservation(operationKey, this.#limits);
      const retained = await client.query(
        `SELECT count(*)::integer AS count,
                coalesce(sum(octet_length(request_ciphertext) + octet_length(request_nonce) + octet_length(request_tag) +
                  CASE WHEN status = 'pending' THEN response_reservation_bytes
                       ELSE coalesce(octet_length(response_ciphertext), 0) + coalesce(octet_length(response_nonce), 0) + coalesce(octet_length(response_tag), 0)
                  END), 0)::bigint AS reserved_bytes
         FROM webhook_operations WHERE delivery_id = $1`,
        [receipt.delivery_id],
      );
      const retainedBytes = Number(retained.rows[0].reserved_bytes);
      if (retained.rows[0].count >= this.#limits.maxOperationsPerReceipt ||
          retainedBytes + envelopeBytes(request) + responseReservationBytes > this.#limits.maxOperationBytesPerReceipt) {
        throw capacityError("operation_journal_capacity", 413);
      }
      const inserted = await client.query(
        `INSERT INTO webhook_operations
         (delivery_id, operation_key, lease_token, retry_safe, request_ciphertext, request_nonce, request_tag, response_reservation_bytes, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
         RETURNING *`,
        [receipt.delivery_id, operationKey, receipt.leaseToken, retrySafe,
          request.ciphertext, request.nonce, request.tag, responseReservationBytes],
      );
      await client.query("COMMIT");
      return { state: "new", row: inserted.rows[0] };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeOperation(receipt, operationKey, response) {
    if (envelopeBytes(response) > this.#limits.maxOperationResponseBytes) {
      throw capacityError("operation_journal_capacity", 413);
    }
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('taproot_reference_operation:' || $1::text))", [receipt.delivery_id]);
      const pending = await client.query(
        `SELECT response_reservation_bytes
         FROM webhook_operations
         WHERE delivery_id = $1 AND operation_key = $2 AND status = 'pending' AND lease_token = $3
         FOR UPDATE`,
        [receipt.delivery_id, operationKey, receipt.leaseToken],
      );
      if (pending.rowCount === 1 && envelopeBytes(response) > pending.rows[0].response_reservation_bytes) {
        throw capacityError("operation_journal_capacity", 413);
      }
      const result = await client.query(
        `UPDATE webhook_operations
         SET status = 'succeeded', response_ciphertext = $4, response_nonce = $5, response_tag = $6, completed_at = now()
         WHERE delivery_id = $1 AND operation_key = $2 AND status = 'pending' AND lease_token = $3
           AND EXISTS (
             SELECT 1 FROM webhook_receipts receipt
             WHERE receipt.delivery_id = $1 AND receipt.status = 'processing' AND receipt.lease_token = $3
               AND receipt.lease_expires_at > now()
           )`,
        [receipt.delivery_id, operationKey, receipt.leaseToken, response.ciphertext, response.nonce, response.tag],
      );
      await client.query("COMMIT");
      return result.rowCount === 1;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async retryReceipt(receipt, code, maxAttempts) {
    const terminal = receipt.attempts >= maxAttempts;
    if (!terminal) {
      const result = await this.#pool.query(
        `UPDATE webhook_receipts
         SET status = 'retry', lease_token = NULL, lease_expires_at = NULL, failure_code = $3,
             available_at = now() + ($4 * interval '1 second')
         WHERE delivery_id = $1 AND status = 'processing' AND lease_token = $2 AND lease_expires_at > now()`,
        [receipt.delivery_id, receipt.leaseToken, code, delayForAttempt(receipt.attempts)],
      );
      return { changed: result.rowCount === 1, terminal: false };
    }
    const result = await this.#pool.query(
      `UPDATE webhook_receipts
       SET status = 'terminal', lease_token = NULL, lease_expires_at = NULL, failure_code = $3
       WHERE delivery_id = $1 AND status = 'processing' AND lease_token = $2 AND lease_expires_at > now()`,
      [receipt.delivery_id, receipt.leaseToken, code],
    );
    // Terminal rows retain their encrypted body and operation journal for an
    // operator to reconcile. The outstanding-cap prevents that evidence from
    // growing beyond the configured recovery budget.
    return { changed: result.rowCount === 1, terminal: true };
  }

  async upsertLifecycle(event, receipt) {
    const state = event.type === "installation.created" ? event.data.installation : event.data;
    if (!state || typeof state !== "object" || !Number.isInteger(state.revision)) {
      throw new Error("The lifecycle webhook did not contain an installation state.");
    }
    const result = await this.#pool.query(
      `INSERT INTO installations
        (installation_id, integration_id, site_id, status, revision, granted_capabilities, publish_policy, contract_version, source_engagement_id)
       SELECT $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9
       WHERE EXISTS (
         SELECT 1 FROM webhook_receipts receipt
         WHERE receipt.delivery_id = $11 AND receipt.status = 'processing' AND receipt.lease_token = $12
           AND receipt.lease_expires_at > now()
       )
       ON CONFLICT (installation_id) DO UPDATE
       SET integration_id = EXCLUDED.integration_id, site_id = EXCLUDED.site_id, status = EXCLUDED.status,
           revision = EXCLUDED.revision, granted_capabilities = EXCLUDED.granted_capabilities,
           publish_policy = EXCLUDED.publish_policy, contract_version = EXCLUDED.contract_version,
           source_engagement_id = EXCLUDED.source_engagement_id, updated_at = now(),
           credential_ciphertext = CASE WHEN EXCLUDED.status = 'uninstalled' OR
               ($10 AND EXCLUDED.revision > installations.revision AND EXCLUDED.status = 'pending_claim')
             THEN NULL ELSE installations.credential_ciphertext END,
           credential_nonce = CASE WHEN EXCLUDED.status = 'uninstalled' OR
               ($10 AND EXCLUDED.revision > installations.revision AND EXCLUDED.status = 'pending_claim')
             THEN NULL ELSE installations.credential_nonce END,
           credential_tag = CASE WHEN EXCLUDED.status = 'uninstalled' OR
               ($10 AND EXCLUDED.revision > installations.revision AND EXCLUDED.status = 'pending_claim')
             THEN NULL ELSE installations.credential_tag END,
           credential_id = CASE WHEN EXCLUDED.status = 'uninstalled' OR
               ($10 AND EXCLUDED.revision > installations.revision AND EXCLUDED.status = 'pending_claim')
             THEN NULL ELSE installations.credential_id END,
           credential_issued_at = CASE WHEN EXCLUDED.status = 'uninstalled' OR
               ($10 AND EXCLUDED.revision > installations.revision AND EXCLUDED.status = 'pending_claim')
             THEN NULL ELSE installations.credential_issued_at END,
           credential_revoked_at = CASE
             WHEN EXCLUDED.status = 'uninstalled' THEN now()
             WHEN EXCLUDED.status = 'suspended' THEN now()
             WHEN EXCLUDED.status = 'pending_claim' THEN now()
             WHEN EXCLUDED.status = 'active' THEN NULL
             ELSE installations.credential_revoked_at END,
           session_cutoff_revision = CASE
             WHEN EXCLUDED.status IN ('pending_claim', 'suspended', 'uninstalled')
               THEN GREATEST(installations.session_cutoff_revision, EXCLUDED.revision)
             ELSE installations.session_cutoff_revision END
       WHERE (EXCLUDED.revision > installations.revision
          OR (EXCLUDED.revision = installations.revision AND installations.status = 'pending_claim'
            AND $10 AND EXCLUDED.status = 'pending_claim'))
         AND EXISTS (
           SELECT 1 FROM webhook_receipts receipt
           WHERE receipt.delivery_id = $11 AND receipt.status = 'processing' AND receipt.lease_token = $12
             AND receipt.lease_expires_at > now()
         )`,
      [event.installationId, event.integrationId, event.siteId, state.status, state.revision,
        JSON.stringify(state.grantedCapabilities ?? []), state.publishPolicy, state.contractVersion,
        state.sourceEngagementId ?? null, event.type === "installation.created", receipt.delivery_id, receipt.leaseToken],
    );
    return result.rowCount === 1;
  }

  async storeCredential(installationId, credential) {
    const result = await this.#pool.query(
      `UPDATE installations
       SET credential_ciphertext = $2, credential_nonce = $3, credential_tag = $4,
           credential_issued_at = now(), credential_revoked_at = NULL, updated_at = now()
       WHERE installation_id = $1 AND status = 'active'`,
      [installationId, credential.ciphertext, credential.nonce, credential.tag],
    );
    if (result.rowCount !== 1) throw new Error("The installation is not active while storing its credential.");
  }

  async storeClaimedCredential(installation, credential, receipt) {
    const result = await this.#pool.query(
      `UPDATE installations
       SET status = 'active', revision = $2, granted_capabilities = $3::jsonb,
           publish_policy = $4, contract_version = $5,
           credential_ciphertext = $6, credential_nonce = $7, credential_tag = $8, credential_id = $11,
           credential_issued_at = now(), credential_revoked_at = NULL, updated_at = now()
       WHERE installation_id = $1 AND integration_id = $9 AND site_id = $10
         AND status IN ('pending_claim', 'active') AND credential_ciphertext IS NULL
         AND EXISTS (
           SELECT 1 FROM webhook_receipts receipt
           WHERE receipt.delivery_id = $12 AND receipt.status = 'processing' AND receipt.lease_token = $13
             AND receipt.lease_expires_at > now()
         )`,
      [installation.id, installation.revision, JSON.stringify(installation.grantedCapabilities ?? []),
        installation.publishPolicy, installation.contractVersion, credential.ciphertext, credential.nonce, credential.tag,
        installation.integrationId, installation.siteId, credential.id, receipt.delivery_id, receipt.leaseToken],
    );
    if (result.rowCount !== 1) throw new Error("The claimed installation no longer has a valid lifecycle state.");
  }

  async installation(installationId) {
    const result = await this.#pool.query("SELECT * FROM installations WHERE installation_id = $1", [installationId]);
    if (result.rowCount === 0) return undefined;
    const row = result.rows[0];
    return { ...row, credential: row.credential_ciphertext ? decodeEnvelope(row, "credential") : undefined };
  }

  async createSettingsSession(session) {
    await this.#pool.query(
      `INSERT INTO settings_sessions
        (session_hash, handoff_jti, installation_id, site_id, user_id, role, expires_at, credential_id, engagement_id, lifecycle_cutoff_revision)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [session.hash, session.jti, session.installationId, session.siteId, session.userId, session.role, session.expiresAt,
        session.credentialId, session.engagementId, session.lifecycleCutoffRevision],
    );
  }

  async readSettingsSession(hash) {
    const result = await this.#pool.query(
      `SELECT sessions.*
       FROM settings_sessions sessions
       JOIN installations installations ON installations.installation_id = sessions.installation_id
       WHERE sessions.session_hash = $1 AND sessions.expires_at > now()
         AND installations.status = 'active' AND installations.credential_revoked_at IS NULL
         AND sessions.credential_id = installations.credential_id
         AND sessions.engagement_id IS NOT DISTINCT FROM installations.source_engagement_id
         AND sessions.lifecycle_cutoff_revision = installations.session_cutoff_revision`,
      [hash],
    );
    return result.rows[0];
  }

  async hasHandoffJti(jti) {
    const result = await this.#pool.query(
      `SELECT 1 FROM settings_sessions WHERE handoff_jti = $1
       UNION ALL
       SELECT 1 FROM pending_settings_handoffs WHERE handoff_jti = $1 AND expires_at > now()
       LIMIT 1`,
      [jti],
    );
    return result.rowCount === 1;
  }

  async hasConfirmedHandoffJti(jti) {
    const result = await this.#pool.query("SELECT 1 FROM settings_sessions WHERE handoff_jti = $1", [jti]);
    return result.rowCount === 1;
  }

  async reservePendingHandoff(pending) {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      // The bounded pending set needs a transaction-scoped lock; a plain count
      // allows concurrent requests to exceed its memory and storage budget.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('taproot_reference_pending_handoffs'))");
      await client.query("DELETE FROM pending_settings_handoffs WHERE expires_at <= now()");
      const count = await client.query("SELECT count(*)::integer AS count FROM pending_settings_handoffs");
      if (count.rows[0].count >= 256) {
        const error = new Error("handoff_unavailable");
        error.code = "handoff_unavailable";
        throw error;
      }
      const result = await client.query(
        `INSERT INTO pending_settings_handoffs
          (state, handoff_jti, installation_id, token_ciphertext, token_nonce, token_tag, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (handoff_jti) DO NOTHING
         RETURNING state`,
        [pending.state, pending.jti, pending.installationId, pending.token.ciphertext, pending.token.nonce, pending.token.tag, pending.expiresAt],
      );
      if (result.rowCount !== 1) {
        const error = new Error("handoff_unavailable");
        error.code = "handoff_unavailable";
        throw error;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async consumePendingHandoff(state) {
    const result = await this.#pool.query(
      `DELETE FROM pending_settings_handoffs
       WHERE state = $1 AND expires_at > now()
       RETURNING handoff_jti, installation_id, token_ciphertext, token_nonce, token_tag, expires_at`,
      [state],
    );
    if (result.rowCount !== 1) {
      const error = new Error("handoff_unavailable");
      error.code = "handoff_unavailable";
      throw error;
    }
    const row = result.rows[0];
    return { ...row, token: decodeEnvelope(row, "token") };
  }

  async invalidateInstallationSessions(installationId, receipt) {
    await this.#pool.query(
      `UPDATE settings_sessions SET expires_at = now()
       WHERE installation_id = $1 AND consumed_at IS NULL
         AND EXISTS (
           SELECT 1 FROM webhook_receipts receipt
           WHERE receipt.delivery_id = $2 AND receipt.status = 'processing' AND receipt.lease_token = $3
             AND receipt.lease_expires_at > now()
         )`,
      [installationId, receipt.delivery_id, receipt.leaseToken],
    );
  }
}
