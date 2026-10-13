import { randomBytes, randomUUID } from "node:crypto";
import {
  IntegrationSdkError,
  TaprootIntegrationClient,
  confirmHandoff,
  verifyHandoff,
  verifyWebhookSignature,
} from "@taprootio/integration-sdk";

import { decrypt, encrypt, tokenHash } from "./crypto.js";

function clientOptions(config, credentials) {
  return {
    baseUrl: config.taprootApiUrl,
    timeoutMs: 10_000,
    maxAttempts: 3,
    maxConcurrentRequests: 4,
    ...credentials,
  };
}

function sessionToken() {
  return randomBytes(32).toString("base64url");
}

export function createTaprootGateway({ config, database }) {
  async function verifiedHandoff(token) {
    return verifyHandoff({
      token,
      issuer: config.handoffIssuer,
      audience: config.integrationId,
      installationId: parseInstallationId(token),
      jwksUrl: config.handoffJwksUrl,
    });
  }

  async function availableInstallation(claims) {
    const installation = await database.installation(claims.installationId);
    if (!installation || installation.integration_id !== claims.integrationId || installation.site_id !== claims.siteId ||
        installation.status !== "active" || installation.credential_revoked_at || !installation.credential ||
        installation.credential_id !== claims.credentialId) {
      throw new IntegrationSdkError("invalid_handoff", "The installation is unavailable.");
    }
    return installation;
  }

  return {
    publisherClient() {
      return new TaprootIntegrationClient(clientOptions(config, { publisherCredential: config.publisherCredential }));
    },
    installationClient(installationCredential) {
      return new TaprootIntegrationClient(clientOptions(config, { installationCredential }));
    },
    webhook: {
      verify({ headers, body }) {
        const verified = verifyWebhookSignature({ headers, body, signingSecrets: config.signingKeys });
        if (verified.event.integrationId !== config.integrationId) {
          throw new IntegrationSdkError("wrong_integration", "The webhook belongs to a different integration.");
        }
        return verified;
      },
      async accept(verified, body) {
        return database.recordReceipt(verified, encrypt(body, config.encryptionKey, `receipt:${verified.deliveryId}`));
      },
    },
    settings: {
      async prepare(token) {
        const claims = await verifiedHandoff(token);
        await availableInstallation(claims);
        if (await database.hasHandoffJti(claims.jti)) {
          throw new IntegrationSdkError("handoff_replayed", "The handoff was already consumed by this service.");
        }
        const state = randomUUID();
        await database.reservePendingHandoff({
          state,
          jti: claims.jti,
          installationId: claims.installationId,
          token: encrypt(token, config.encryptionKey, `pending-handoff:${state}`),
          expiresAt: claims.expiresAt,
        });
        return { state };
      },
      async confirm(state) {
        // Consume before network confirmation. A disconnected browser cannot
        // replay this capability after a lost response; it must request a new
        // Taproot handoff instead.
        const pending = await database.consumePendingHandoff(state);
        const token = decrypt(pending.token, config.encryptionKey, `pending-handoff:${state}`).toString("utf8");
        const claims = await verifiedHandoff(token);
        if (claims.jti !== pending.handoff_jti || claims.installationId !== pending.installation_id) {
          throw new IntegrationSdkError("invalid_handoff", "The pending handoff binding changed.");
        }
        if (await database.hasConfirmedHandoffJti(claims.jti)) {
          throw new IntegrationSdkError("handoff_replayed", "The handoff was already consumed by this service.");
        }
        const installation = await availableInstallation(claims);
        const credential = decrypt(installation.credential, config.encryptionKey,
          `installation:${claims.installationId}:credential`).toString("utf8");
        const confirmed = await confirmHandoff({
          client: thisInstallationClient(config, credential),
          claims,
          token,
          maximumSessionLifetimeSeconds: 24 * 60 * 60,
        });
        const value = sessionToken();
        const expiresAt = new Date(confirmed.sessionExpiresAt);
        const maxAgeSeconds = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
        await database.createSettingsSession({
          hash: tokenHash(value),
          jti: claims.jti,
          installationId: claims.installationId,
          siteId: claims.siteId,
          userId: claims.userId,
          role: claims.role,
          credentialId: claims.credentialId,
          engagementId: claims.engagementId,
          lifecycleCutoffRevision: installation.session_cutoff_revision,
          expiresAt: confirmed.sessionExpiresAt,
        });
        return { token: value, maxAgeSeconds };
      },
      async read(value) {
        if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) return undefined;
        return database.readSettingsSession(tokenHash(value));
      },
    },
  };
}

function thisInstallationClient(config, credential) {
  return new TaprootIntegrationClient(clientOptions(config, { installationCredential: credential }));
}

/**
 * `verifyHandoff` requires the installation id to bind the JWT before the
 * confirmation call. Decode only this untrusted routing claim; the SDK then
 * verifies the RS256 signature and every claim before it is used.
 */
function parseInstallationId(token) {
  try {
    const payload = token.split(".")[1];
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof value?.installation_id !== "string") throw new Error();
    return value.installation_id;
  } catch {
    throw new IntegrationSdkError("invalid_handoff", "The settings handoff is malformed.");
  }
}
