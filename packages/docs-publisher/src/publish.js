import { createHash } from "node:crypto";

import { createReleaseArchive } from "./archive.js";
import { snapshotDocsArtifact } from "./artifact.js";
import { loadPublisherConfig } from "./config.js";
import {
  ARCHIVE_FORMAT_NAMES,
  ARCHIVE_FORMAT_WIRE_VALUES,
  ARTIFACT_PACKAGE_VERSION,
  ARTIFACT_SCHEMA_VERSION,
  CONFIG_VERSION,
  DEFAULT_PUBLICATION_MODE,
  isPublicationMode,
  LIMITS,
  MODE_MANAGED,
  MODE_PREBUILT,
  PUBLICATION_MODE_WIRE_VALUES,
  PUBLISH_KEY_ENVIRONMENT_VARIABLE,
  PUBLISH_RESULT_SCHEMA_VERSION,
  PUBLISHER_NAME,
  PUBLISHER_VERSION,
  UNSTAMPED_WIRE_MODES,
} from "./constants.js";
import { PublisherError } from "./errors.js";
import { ApiError, DocsApiClient } from "./transport.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UTC_TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/u;
const RELEASE_STAGED = "DOCS_RELEASE_STATUS_STAGED";
const RELEASE_VALIDATING = "DOCS_RELEASE_STATUS_VALIDATING";
const RELEASE_VALIDATED = "DOCS_RELEASE_STATUS_VALIDATED";
const RELEASE_RETAINED = "DOCS_RELEASE_STATUS_RETAINED";
const RELEASE_STATUSES = new Set([
  RELEASE_STAGED,
  RELEASE_VALIDATING,
  RELEASE_VALIDATED,
  "DOCS_RELEASE_STATUS_REJECTED",
  "DOCS_RELEASE_STATUS_SUPERSEDED",
  RELEASE_RETAINED,
  "DOCS_RELEASE_STATUS_DELETED",
]);
const RELEASE_FAILURES = new Set([
  "DOCS_RELEASE_STATUS_REJECTED",
  "DOCS_RELEASE_STATUS_SUPERSEDED",
  "DOCS_RELEASE_STATUS_DELETED",
]);
const DEPLOYMENT_COMPLETED = "DEPLOYMENT_STATUS_COMPLETED";
const DEPLOYMENT_FAILED = "DEPLOYMENT_STATUS_FAILED";
const DEPLOYMENT_PENDING = new Set([
  "DEPLOYMENT_STATUS_QUEUED",
  "DEPLOYMENT_STATUS_GENERATING",
  "DEPLOYMENT_STATUS_DEPLOYING",
]);
const DEPLOYMENT_STATUSES = new Set([
  ...DEPLOYMENT_PENDING,
  DEPLOYMENT_COMPLETED,
  DEPLOYMENT_FAILED,
]);
const OUTPUT_RESERVED = "DOCS_PUBLISHED_OUTPUT_STATUS_RESERVED";
const OUTPUT_AVAILABLE = "DOCS_PUBLISHED_OUTPUT_STATUS_AVAILABLE";
const AMBIGUOUS_RESTART_ERRORS = new Set([
  "transport.invalid_json",
  "transport.network",
  "transport.response_read",
  "transport.response_too_large",
]);

function requireObject(value, code, description) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new PublisherError(code, `Taproot returned an invalid ${description} response.`);
  }
  return value;
}

function requireUuid(value, code, field) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new PublisherError(code, `Taproot returned an invalid ${field}.`, { field });
  }
  return value;
}

function requireStatus(value, code, field) {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{1,100}$/u.test(value)) {
    throw new PublisherError(code, `Taproot returned an invalid ${field}.`, { field });
  }
  return value;
}

function safeInteger(value, code, field) {
  const number = typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new PublisherError(code, `Taproot returned an invalid ${field}.`, { field });
  }
  return number;
}

function isTimestamp(value) {
  return typeof value === "string" && UTC_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

function intentKey(phase, values) {
  const hash = createHash("sha256");
  hash.update(`taproot-docs-publisher:${phase}:v1\0`, "utf8");
  for (const value of values) {
    hash.update(String(value), "utf8");
    hash.update("\0", "utf8");
  }
  return `${phase}-v1:${hash.digest("hex")}`;
}

function resolvePublicationMode(config, snapshot, archive) {
  const selected = config?.mode ?? DEFAULT_PUBLICATION_MODE;
  if (!isPublicationMode(selected)) {
    throw new PublisherError(
      "publish.mode_unsupported",
      "The publish request names an unsupported publication mode.",
      { field: "mode" },
    );
  }
  for (const prepared of [snapshot?.mode, archive?.mode]) {
    if (prepared !== undefined && prepared !== selected) {
      throw new PublisherError(
        "publish.mode_mismatch",
        "The validated artifact and its archive do not match the selected publication mode.",
        { field: "mode" },
      );
    }
  }
  return selected;
}

function releaseBody(siteId, mode, manifest, archive, restartUploadIntentId = "") {
  const wireMode = PUBLICATION_MODE_WIRE_VALUES[mode];
  const archiveFormat = ARCHIVE_FORMAT_WIRE_VALUES[mode];
  return {
    idempotencyKey: intentKey("release", [
      siteId,
      // The mode/format pair is part of the release identity so a managed and a
      // prebuilt attempt for the same source build can never share an intent.
      wireMode,
      archiveFormat,
      manifest.source.provider,
      manifest.source.repositoryId,
      manifest.source.repository,
      manifest.source.repositoryUrl,
      manifest.source.revision,
      manifest.source.ref,
      manifest.schemaVersion,
      manifest.build.producer,
      manifest.build.producerVersion,
      manifest.build.configurationSha256,
      manifest.build.sourceDateEpoch,
    ]),
    sourceRevision: manifest.source.revision,
    sourceRef: manifest.source.ref,
    artifactSchemaVersion: manifest.schemaVersion,
    buildProducer: manifest.build.producer,
    buildProducerVersion: manifest.build.producerVersion,
    buildConfigurationHash: manifest.build.configurationSha256,
    buildSourceDateEpoch: manifest.build.sourceDateEpoch,
    artifactContentHash: archive.contentHash,
    artifactByteLength: archive.byteLength,
    archiveFormat,
    mode: wireMode,
    restartUploadIntentId,
  };
}

function echoedModeMatches(mode, value) {
  if (value === PUBLICATION_MODE_WIRE_VALUES[mode]) return true;
  // A server or row that predates explicit mode identity omits the field, and
  // that omission reads as managed. It is never accepted for prebuilt.
  return mode === MODE_MANAGED && UNSTAMPED_WIRE_MODES.includes(value);
}

function validateRelease(value, expected, releaseId) {
  const release = requireObject(value, "api.release_contract", "Docs release");
  const id = requireUuid(release.id, "api.release_contract", "release.id");
  const status = requireStatus(release.status, "api.release_contract", "release.status");
  if (!RELEASE_STATUSES.has(status)) {
    throw new PublisherError("api.release_status", "Taproot returned an unsupported Docs release status.", { status });
  }
  if (
    (releaseId !== undefined && id !== releaseId)
    || release.siteId !== expected.siteId
    || safeInteger(release.sourceBindingVersion, "api.release_contract", "release.sourceBindingVersion") <= 0
    || release.sourceProvider !== expected.source.provider
    || release.sourceRepositoryId !== expected.source.repositoryId
    || release.sourceRepository !== expected.source.repository
    || release.sourceRevision !== expected.body.sourceRevision
    || release.sourceRef !== expected.body.sourceRef
    || release.artifactSchemaVersion !== expected.body.artifactSchemaVersion
    || release.buildProducer !== expected.body.buildProducer
    || release.buildProducerVersion !== expected.body.buildProducerVersion
    || release.buildConfigurationHash !== expected.body.buildConfigurationHash
    || safeInteger(release.buildSourceDateEpoch ?? 0, "api.release_contract", "release.buildSourceDateEpoch")
      !== expected.body.buildSourceDateEpoch
    || release.artifactContentHash !== expected.body.artifactContentHash
    || safeInteger(release.artifactByteLength, "api.release_contract", "release.artifactByteLength")
      !== expected.body.artifactByteLength
    || release.archiveFormat !== expected.body.archiveFormat
    || !echoedModeMatches(expected.mode, release.mode)
  ) {
    throw new PublisherError(
      "api.release_intent_mismatch",
      "Taproot returned a release that does not match the immutable publish intent.",
    );
  }
  return release;
}

function validateUpload(value, archive) {
  const upload = requireObject(value, "api.upload_contract", "Docs upload");
  requireUuid(upload.uploadIntentId, "api.upload_contract", "upload.uploadIntentId");
  const contentLength = safeInteger(upload.contentLength, "api.upload_contract", "upload.contentLength");
  if (
    upload.method !== "PUT"
    || typeof upload.url !== "string"
    || !Array.isArray(upload.requiredHeaders)
    || contentLength !== archive.byteLength
    || !isTimestamp(upload.expiresAt)
  ) {
    throw new PublisherError("api.upload_contract", "Taproot returned an invalid Docs upload capability.");
  }
  return { ...upload, contentLength };
}

function validateCreateResponse(value, expected, archive) {
  const response = requireObject(value, "api.create_contract", "Docs release initialization");
  const release = validateRelease(response.release, expected);
  if (
    (response.uploadRequired !== undefined && typeof response.uploadRequired !== "boolean")
    || (response.artifactReused !== undefined && typeof response.artifactReused !== "boolean")
  ) {
    throw new PublisherError("api.create_contract", "Taproot returned invalid release upload flags.");
  }
  const uploadRequired = response.uploadRequired === true;
  const artifactReused = response.artifactReused === true;
  const upload = uploadRequired ? validateUpload(response.upload, archive) : undefined;
  if (!uploadRequired && response.upload !== undefined && response.upload !== null) {
    throw new PublisherError(
      "api.create_contract",
      "Taproot returned an upload capability when no upload was required.",
    );
  }
  if (artifactReused && uploadRequired) {
    throw new PublisherError("api.create_contract", "Taproot returned conflicting artifact reuse and upload flags.");
  }
  if (uploadRequired && release.status !== RELEASE_STAGED) {
    throw new PublisherError(
      "api.create_contract",
      "Taproot returned an upload capability for a release that is not staged.",
    );
  }
  return { release, uploadRequired, artifactReused, upload };
}

function releasePath(siteId, releaseId = "") {
  return releaseId
    ? `v1/sites/${encodeURIComponent(siteId)}/docs/releases/${encodeURIComponent(releaseId)}`
    : `v1/sites/${encodeURIComponent(siteId)}/docs/releases`;
}

function deploymentPath(siteId, deploymentId) {
  return `v1/sites/${encodeURIComponent(siteId)}/docs/deployments/${encodeURIComponent(deploymentId)}`;
}

function isUploadKnownExpired(upload, now) {
  return Date.parse(upload.expiresAt) <= now();
}

async function initializeRelease(
  client,
  expected,
  archive,
  requestBody = expected.body,
  attempts = LIMITS.requestAttempts,
) {
  const response = await client.request(releasePath(expected.siteId), {
    method: "POST",
    body: requestBody,
    attempts,
  });
  return validateCreateResponse(response, expected, archive);
}

async function currentRelease(client, siteId, releaseId, expected, requestOptions) {
  return validateRelease(
    await client.request(releasePath(siteId, releaseId), requestOptions),
    expected,
    releaseId,
  );
}

async function completeRelease(client, siteId, release, upload, expected) {
  const response = await client.request(`${releasePath(siteId, release.id)}/complete`, {
    method: "POST",
    body: { uploadIntentId: upload.uploadIntentId },
  });
  return validateRelease(response, expected, release.id);
}

function shouldReconcileRestart(error) {
  return (
    error instanceof ApiError
    && (error.hasField("RestartUploadIntentId") || error.isRetryable())
  ) || (
    error instanceof PublisherError
    && AMBIGUOUS_RESTART_ERRORS.has(error.code)
  );
}

async function restartOrReconcileUpload(client, expected, archive, upload, restartBudget) {
  const restartBody = { ...expected.body, restartUploadIntentId: upload.uploadIntentId };
  while (restartBudget.attempts < LIMITS.uploadIntents) {
    restartBudget.attempts += 1;
    try {
      return await initializeRelease(client, expected, archive, restartBody, 1);
    } catch (restartError) {
      if (!shouldReconcileRestart(restartError)) throw restartError;
      try {
        return await initializeRelease(client, expected, archive);
      } catch (reconciliationError) {
        if (!(reconciliationError instanceof ApiError && reconciliationError.hasField("RestartUploadIntentId"))) {
          throw reconciliationError;
        }
      }
    }
  }
  throw new PublisherError("upload.restart_exhausted", "The whole-object upload exhausted its restart budget.");
}

async function freezeUploadedRelease(client, initial, expected, archive, now, onProgress) {
  let creation = initial;
  let uploaded = false;
  const restartBudget = { attempts: 0 };
  for (let round = 0; round < LIMITS.uploadIntents; round += 1) {
    if (!creation.uploadRequired) return { release: creation.release, uploaded, reused: creation.artifactReused };
    const upload = creation.upload;
    onProgress(`Uploading immutable artifact bytes (intent ${round + 1}/${LIMITS.uploadIntents}).`);
    let uploadError;
    try {
      await client.upload(upload, archive.bytes);
      uploaded = true;
    } catch (error) {
      uploadError = error;
    }
    try {
      const release = await completeRelease(client, expected.siteId, creation.release, upload, expected);
      return { release, uploaded, reused: creation.artifactReused };
    } catch (completionError) {
      // Completion is the authority after an ambiguous PUT or lost completion
      // response. A terminal/non-staged read proves that the exact intent was
      // accepted even when this process missed the response.
      const release = await currentRelease(client, expected.siteId, creation.release.id, expected);
      if (release.status !== RELEASE_STAGED) return { release, uploaded, reused: creation.artifactReused };

      try {
        creation = await initializeRelease(client, expected, archive);
        continue;
      } catch (replayError) {
        const restartRequired = replayError instanceof ApiError
          && (replayError.hasField("RestartUploadIntentId") || isUploadKnownExpired(upload, now));
        if (!restartRequired) throw completionError;
        if (round + 1 >= LIMITS.uploadIntents) throw completionError;
        onProgress("Restarting an expired or server-rejected whole-object upload intent.");
        creation = await restartOrReconcileUpload(client, expected, archive, upload, restartBudget);
      }
    }
    if (uploadError && round + 1 >= LIMITS.uploadIntents) throw uploadError;
  }
  throw new PublisherError("upload.restart_exhausted", "The whole-object upload exhausted its restart budget.");
}

async function poll({ client, timeoutMilliseconds, read, evaluate, timeoutCode, onProgress, now }) {
  const deadline = now() + timeoutMilliseconds;
  const maximumReads = Math.ceil(timeoutMilliseconds / LIMITS.pollIntervalMilliseconds) + 2;
  for (let readCount = 0; readCount < maximumReads; readCount += 1) {
    if (now() >= deadline) break;
    let value;
    try {
      value = await read({ deadline, now });
    } catch (error) {
      if (error instanceof PublisherError && error.code === "transport.deadline") break;
      throw error;
    }
    if (now() >= deadline) break;
    const result = evaluate(value);
    if (result.done) return result.value;
    onProgress(result.progress);
    if (now() >= deadline) break;
    await client.sleep(Math.min(LIMITS.pollIntervalMilliseconds, Math.max(1, deadline - now())), client.signal);
  }
  throw new PublisherError(
    timeoutCode,
    "Taproot did not reach the required terminal state before the bounded deadline.",
  );
}

async function waitForValidatedRelease(client, siteId, release, expected, onProgress, now) {
  return await poll({
    client,
    timeoutMilliseconds: LIMITS.validationMilliseconds,
    read: async (requestOptions) => await currentRelease(client, siteId, release.id, expected, requestOptions),
    evaluate: (current) => {
      if (
        current.status === RELEASE_VALIDATED
        || (current.status === RELEASE_RETAINED && typeof current.validatedAt === "string")
      ) {
        if (!isTimestamp(current.validatedAt)) {
          throw new PublisherError("api.release_contract", "Taproot returned invalid release validation provenance.", {
            field: "release.validatedAt",
          });
        }
        return { done: true, value: current };
      }
      if (RELEASE_FAILURES.has(current.status) || (current.status === RELEASE_RETAINED && !current.validatedAt)) {
        throw new PublisherError(
          "release.validation_failed",
          "Taproot rejected or retired the exact Docs release during validation.",
          {
            field: typeof current.failureCode === "string" && current.failureCode ? current.failureCode : undefined,
            status: current.status,
          },
        );
      }
      if (current.status !== RELEASE_STAGED && current.status !== RELEASE_VALIDATING) {
        throw new PublisherError("api.release_status", "Taproot returned an unsupported Docs release status.", {
          status: current.status,
        });
      }
      return { done: false, progress: `Waiting for release validation (${current.status}).` };
    },
    timeoutCode: "release.validation_timeout",
    onProgress,
    now,
  });
}

function validateDeployment(value, { siteId, releaseId, environment, stagingDeploymentId, deploymentId }) {
  const docsDeployment = requireObject(value, "api.deployment_contract", "Docs deployment");
  const deployment = requireObject(docsDeployment.deployment, "api.deployment_contract", "site deployment");
  const id = requireUuid(deployment.id, "api.deployment_contract", "deployment.id");
  const status = deployment.status === undefined
    ? "DEPLOYMENT_STATUS_QUEUED"
    : requireStatus(deployment.status, "api.deployment_contract", "deployment.status");
  if (!DEPLOYMENT_STATUSES.has(status)) {
    throw new PublisherError("api.deployment_status", "Taproot returned an unsupported deployment status.", { status });
  }
  if (
    (deploymentId !== undefined && id !== deploymentId)
    || deployment.siteId !== siteId
    || docsDeployment.docsReleaseId !== releaseId
    || deployment.docsReleaseId !== releaseId
    || deployment.environment !== environment
  ) {
    throw new PublisherError(
      "api.deployment_intent_mismatch",
      "Taproot returned a deployment that does not match the immutable publish intent.",
    );
  }
  const promotedFrom = docsDeployment.promotedFromStagingDeploymentId ?? "";
  if (
    (stagingDeploymentId !== undefined && promotedFrom !== stagingDeploymentId)
    || (stagingDeploymentId === undefined && promotedFrom !== "")
  ) {
    throw new PublisherError(
      "api.deployment_intent_mismatch",
      "Taproot returned a production deployment for another staging deployment.",
    );
  }
  if (
    docsDeployment.outputReleaseId
    && deployment.docsOutputReleaseId
    && docsDeployment.outputReleaseId !== deployment.docsOutputReleaseId
  ) {
    throw new PublisherError(
      "api.deployment_intent_mismatch",
      "Taproot returned conflicting immutable output identities.",
    );
  }
  const outputReleaseId = docsDeployment.outputReleaseId || deployment.docsOutputReleaseId;
  if (outputReleaseId) requireUuid(outputReleaseId, "api.deployment_contract", "deployment.outputReleaseId");
  const pointerVersion = safeInteger(
    docsDeployment.pointerVersion ?? deployment.docsPointerVersion ?? 0,
    "api.deployment_contract",
    "deployment.pointerVersion",
  );
  if (
    docsDeployment.pointerVersion !== undefined
    && deployment.docsPointerVersion !== undefined
    && safeInteger(deployment.docsPointerVersion, "api.deployment_contract", "deployment.docsPointerVersion")
      !== pointerVersion
  ) {
    throw new PublisherError(
      "api.deployment_intent_mismatch",
      "Taproot returned conflicting deployment pointer versions.",
    );
  }
  const pointerAcknowledgedAt = docsDeployment.pointerAcknowledgedAt;
  if (pointerAcknowledgedAt !== undefined && !isTimestamp(pointerAcknowledgedAt)) {
    throw new PublisherError(
      "api.deployment_contract",
      "Taproot returned an invalid deployment pointer acknowledgement timestamp.",
      { field: "deployment.pointerAcknowledgedAt" },
    );
  }
  if (status === DEPLOYMENT_COMPLETED && pointerAcknowledgedAt === undefined) {
    throw new PublisherError(
      "api.deployment_incomplete",
      "Taproot completed the deployment without its pointer acknowledgement timestamp.",
      { field: "deployment.pointerAcknowledgedAt" },
    );
  }
  if (docsDeployment.output !== undefined && docsDeployment.output !== null) {
    const output = requireObject(docsDeployment.output, "api.deployment_contract", "Docs published output");
    const outputStatus = requireStatus(output.status, "api.deployment_contract", "output.status");
    const reservedStagingOutput = outputStatus === OUTPUT_RESERVED
      && environment === "DEPLOYMENT_ENVIRONMENT_STAGING"
      && stagingDeploymentId === undefined
      && DEPLOYMENT_PENDING.has(status);
    if (
      output.outputReleaseId !== outputReleaseId
      || output.siteId !== siteId
      || output.sourceDeploymentId !== (stagingDeploymentId ?? deployment.id)
      || output.docsReleaseId !== releaseId
      || (outputStatus !== OUTPUT_AVAILABLE && !reservedStagingOutput)
    ) {
      throw new PublisherError(
        "api.deployment_intent_mismatch",
        "Taproot returned an output that does not match the exact deployment.",
      );
    }
  } else if (status === DEPLOYMENT_COMPLETED) {
    throw new PublisherError(
      "api.deployment_incomplete",
      "Taproot completed the deployment without its immutable output contract.",
    );
  }
  return {
    raw: docsDeployment,
    id: deployment.id,
    status,
    outputReleaseId,
    pointerVersion,
    pointerAcknowledgedAt,
  };
}

async function waitForDeployment(client, initial, expected, onProgress, now) {
  const polledExpected = { ...expected, deploymentId: initial.id };
  return await poll({
    client,
    timeoutMilliseconds: LIMITS.deploymentMilliseconds,
    read: async (requestOptions) =>
      validateDeployment(
        await client.request(deploymentPath(expected.siteId, initial.id), requestOptions),
        polledExpected,
      ),
    evaluate: (deployment) => {
      if (deployment.status === DEPLOYMENT_COMPLETED) {
        if (!deployment.outputReleaseId || deployment.pointerVersion <= 0) {
          throw new PublisherError(
            "api.deployment_incomplete",
            "Taproot completed the deployment without its immutable output or pointer acknowledgement.",
          );
        }
        return { done: true, value: deployment };
      }
      if (deployment.status === DEPLOYMENT_FAILED) {
        throw new PublisherError("deployment.failed", "The exact Docs deployment failed.", {
          status: deployment.status,
        });
      }
      if (!DEPLOYMENT_PENDING.has(deployment.status)) {
        throw new PublisherError("api.deployment_status", "Taproot returned an unsupported deployment status.", {
          status: deployment.status,
        });
      }
      return {
        done: false,
        progress: `Waiting for ${
          expected.environment.endsWith("STAGING") ? "staging" : "production"
        } deployment (${deployment.status}).`,
      };
    },
    timeoutCode: "deployment.timeout",
    onProgress,
    now,
  });
}

export async function publishPreparedArtifact({
  config,
  snapshot,
  archive,
  client,
  onProgress = () => {},
  now = Date.now,
}) {
  const mode = resolvePublicationMode(config, snapshot, archive);
  const body = releaseBody(config.siteId, mode, snapshot.manifest, archive);
  const expectedRelease = {
    siteId: config.siteId,
    mode,
    body,
    source: snapshot.manifest.source,
  };
  onProgress("Creating or resolving the exact source-build release.");
  const initialized = await initializeRelease(client, expectedRelease, archive);
  const frozen = await freezeUploadedRelease(
    client,
    initialized,
    expectedRelease,
    archive,
    now,
    onProgress,
  );
  const validated = await waitForValidatedRelease(
    client,
    config.siteId,
    frozen.release,
    expectedRelease,
    onProgress,
    now,
  );

  onProgress("Creating or resolving the exact staging deployment.");
  const stageExpected = {
    siteId: config.siteId,
    releaseId: validated.id,
    environment: "DEPLOYMENT_ENVIRONMENT_STAGING",
  };
  const staged = validateDeployment(
    await client.request(`v1/sites/${encodeURIComponent(config.siteId)}/docs/deployments:stage`, {
      method: "POST",
      body: {
        idempotencyKey: intentKey("stage", [config.siteId, validated.id]),
        releaseId: validated.id,
      },
    }),
    stageExpected,
  );
  const completedStaging = await waitForDeployment(client, staged, stageExpected, onProgress, now);

  onProgress("Promoting the exact completed staging deployment to production.");
  const productionExpected = {
    siteId: config.siteId,
    releaseId: validated.id,
    environment: "DEPLOYMENT_ENVIRONMENT_PRODUCTION",
    stagingDeploymentId: completedStaging.id,
  };
  const promoted = validateDeployment(
    await client.request(`v1/sites/${encodeURIComponent(config.siteId)}/docs/deployments:promote`, {
      method: "POST",
      body: {
        idempotencyKey: intentKey("promote", [config.siteId, completedStaging.id]),
        stagingDeploymentId: completedStaging.id,
      },
    }),
    productionExpected,
  );
  const completedProduction = await waitForDeployment(client, promoted, productionExpected, onProgress, now);

  if (completedProduction.outputReleaseId !== completedStaging.outputReleaseId) {
    throw new PublisherError(
      "deployment.output_mismatch",
      "Production did not promote the exact immutable staging output.",
    );
  }

  return Object.freeze({
    schemaVersion: PUBLISH_RESULT_SCHEMA_VERSION,
    ok: true,
    publisher: { name: PUBLISHER_NAME, version: PUBLISHER_VERSION },
    compatibility: {
      configVersion: CONFIG_VERSION,
      artifactPackageVersion: ARTIFACT_PACKAGE_VERSION,
      artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
      archiveFormat: ARCHIVE_FORMAT_NAMES[mode],
    },
    siteId: config.siteId,
    mode,
    artifact: {
      contentHash: archive.contentHash,
      byteLength: archive.byteLength,
      uploaded: frozen.uploaded,
      reused: frozen.reused,
    },
    release: { id: validated.id, status: validated.status, sourceRevision: validated.sourceRevision },
    staging: {
      deploymentId: completedStaging.id,
      outputReleaseId: completedStaging.outputReleaseId,
      pointerVersion: completedStaging.pointerVersion,
      status: completedStaging.status,
    },
    production: {
      deploymentId: completedProduction.id,
      outputReleaseId: completedProduction.outputReleaseId,
      pointerVersion: completedProduction.pointerVersion,
      status: completedProduction.status,
    },
  });
}

export async function publishDocs(options = {}) {
  const environment = options.environment ?? process.env;
  const token = environment[PUBLISH_KEY_ENVIRONMENT_VARIABLE];
  if (typeof token !== "string" || token.length === 0) {
    throw new PublisherError(
      "auth.key_missing",
      `${PUBLISH_KEY_ENVIRONMENT_VARIABLE} must contain the site-scoped taproot-docs-publish key.`,
    );
  }
  const onProgress = options.quiet ? () => {} : options.onProgress ?? (() => {});
  onProgress("Discovering publisher configuration.");
  const config = await loadPublisherConfig({ cwd: options.cwd, configPath: options.configPath });
  onProgress(
    config.mode === MODE_PREBUILT
      ? "Validating the declared prebuilt Docs artifact without executing it."
      : "Validating the managed Docs artifact.",
  );
  const snapshot = await snapshotDocsArtifact(config.artifactDirectory, config.mode);
  const archive = createReleaseArchive(snapshot);
  const client = new DocsApiClient({
    apiBaseUrl: config.apiBaseUrl,
    token,
    fetch: options.fetch,
    signal: options.signal,
  });
  return await publishPreparedArtifact({ config, snapshot, archive, client, onProgress });
}
