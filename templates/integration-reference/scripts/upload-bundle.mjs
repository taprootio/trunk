import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { TaprootIntegrationClient } from "@taprootio/integration-sdk";

import { loadBundleUploadConfig } from "../src/config.js";

function runtimeMajorFromArguments(argumentsList) {
  if (argumentsList.length !== 2 || argumentsList[0] !== "--runtime-major" || !/^\d+$/u.test(argumentsList[1])) {
    throw new Error("Usage: npm run upload-bundle -- --runtime-major <published-site-runtime-major>");
  }
  const major = Number(argumentsList[1]);
  if (!Number.isSafeInteger(major) || major < 1 || major > 100) throw new Error("runtime major must be between 1 and 100.");
  return major;
}

const config = loadBundleUploadConfig();
const runtimeMajor = runtimeMajorFromArguments(process.argv.slice(2));
const bytes = await readFile(new URL("../public/bundle.js", import.meta.url));
const contentHash = createHash("sha256").update(bytes).digest("hex");
const client = new TaprootIntegrationClient({
  baseUrl: config.taprootApiUrl,
  publisherCredential: config.publisherCredential,
  timeoutMs: 10_000,
  maxAttempts: 3,
  maxConcurrentRequests: 1,
});

const requested = await client.requestBundleUpload({
  integrationId: config.integrationId,
  contentHash,
  byteLength: bytes.byteLength,
  runtimeMajor,
});
if (requested.isDuplicate) {
  process.stdout.write(`${JSON.stringify({ status: "already_uploaded", bundleId: requested.existingBundle?.id, contentHash })}\n`);
} else {
  await client.uploadPresigned({ url: requested.presignedUrl, requiredHeaders: requested.requiredHeaders, body: bytes });
  const bundle = await client.confirmBundleUpload({ integrationId: config.integrationId, uploadId: requested.uploadId });
  process.stdout.write(`${JSON.stringify({ status: "uploaded", bundleId: bundle.id, contentHash: bundle.contentHash, runtimeMajor: bundle.runtimeMajor })}\n`);
}

// This publisher-only script never calls the operator approval/registry
// selection endpoint or the site-owner pinning endpoint. Those approvals are
// intentionally separate from an integration's publisher credential.
