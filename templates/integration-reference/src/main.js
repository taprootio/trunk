import { assertValidManifest } from "@taprootio/integration-sdk";

import { loadConfig } from "./config.js";
import { ReferenceDatabase } from "./database.js";
import { createBootstrapHttpServer, createReferenceHttpServer } from "./http.js";
import { referenceManifest } from "./manifest.js";
import { createWebhookProcessor } from "./processor.js";
import { createTaprootGateway } from "./taproot.js";

const config = loadConfig();
const manifest = assertValidManifest(referenceManifest(config.publicOrigin));

if (config.bootstrapManifestOnly) {
  const server = createBootstrapHttpServer(manifest);
  await listen(server, config.port, config.host);
  process.stdout.write(`Manifest-only bootstrap listening on ${config.port}.\n`);
  await waitForShutdown(server);
} else {
  const database = new ReferenceDatabase(config.databaseUrl, config.webhookLimits, config.databaseCaCertificate);
  await database.migrate();
  const taproot = createTaprootGateway({ config, database });
  const processor = createWebhookProcessor({ config, database, taproot });
  const server = createReferenceHttpServer({
    database, webhook: taproot.webhook, settings: taproot.settings, processor, manifest,
    maxWebhookBytes: config.webhookLimits.maxReceiptBytes,
  });
  await processor.start();
  await listen(server, config.port, config.host);
  process.stdout.write(`Reference integration listening on ${config.port}.\n`);
  await waitForShutdown(server, async () => {
    await processor.stop();
    await database.close();
  });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port }, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function waitForShutdown(server, closeResources = async () => {}) {
  return new Promise((resolve) => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      // Stop accepting new webhook requests before waiting for a worker lease.
      await new Promise((done) => server.close(() => done()));
      await closeResources();
      resolve();
    };
    process.once("SIGTERM", () => { void stop(); });
    process.once("SIGINT", () => { void stop(); });
  });
}
