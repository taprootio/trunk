import assert from "node:assert/strict";
import test from "node:test";

import { ARTIFACT_PACKAGE_VERSION, CONFIG_VERSION, LIMITS, PUBLISHER_VERSION } from "../src/constants.js";
import { PublisherError } from "../src/errors.js";
import { publishPreparedArtifact } from "../src/publish.js";
import { ApiError, DocsApiClient } from "../src/transport.js";

const MANAGED_WIRE_MODE = "DOCS_PUBLICATION_MODE_MANAGED";
const PREBUILT_WIRE_MODE = "DOCS_PUBLICATION_MODE_PREBUILT";
const MANAGED_WIRE_FORMAT = "DOCS_ARCHIVE_FORMAT_TAPROOT_DOCS_TAR_GZIP_V1";
const PREBUILT_WIRE_FORMAT = "DOCS_ARCHIVE_FORMAT_TAPROOT_DOCS_PREBUILT_TAR_GZIP_V1";

const SITE_ID = "11111111-1111-4111-8111-111111111111";
const RELEASE_ID = "22222222-2222-4222-8222-222222222222";
const STAGING_ID = "33333333-3333-4333-8333-333333333333";
const PRODUCTION_ID = "44444444-4444-4444-8444-444444444444";
const OUTPUT_ID = "55555555-5555-4555-8555-555555555555";
const UPLOAD_ID = "66666666-6666-4666-8666-666666666666";
const RESTART_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_RELEASE_ID = "88888888-8888-4888-8888-888888888888";
const THIRD_UPLOAD_ID = "99999999-9999-4999-8999-999999999999";
const HASH = `sha256:${"a".repeat(64)}`;

function manifest(
  revision = "0123456789abcdef0123456789abcdef01234567",
  sourceDateEpoch = 1_767_225_600,
) {
  return {
    schemaVersion: 1,
    source: {
      provider: "github",
      repositoryId: "R_test",
      repository: "taprootio/test",
      repositoryUrl: "https://github.com/taprootio/test",
      revision,
      ref: "refs/heads/main",
    },
    build: {
      producer: "@taprootio/wtfm",
      producerVersion: "1.0.0",
      configurationSha256: `sha256:${"b".repeat(64)}`,
      sourceDateEpoch,
    },
  };
}

function release(body, overrides = {}) {
  return {
    id: RELEASE_ID,
    siteId: SITE_ID,
    sourceBindingVersion: "1",
    sourceProvider: "github",
    sourceRepositoryId: "R_test",
    sourceRepository: "taprootio/test",
    sourceRevision: body.sourceRevision,
    sourceRef: body.sourceRef,
    artifactSchemaVersion: body.artifactSchemaVersion,
    buildProducer: body.buildProducer,
    buildProducerVersion: body.buildProducerVersion,
    buildConfigurationHash: body.buildConfigurationHash,
    ...(body.buildSourceDateEpoch === 0 ? {} : { buildSourceDateEpoch: body.buildSourceDateEpoch }),
    artifactContentHash: body.artifactContentHash,
    artifactByteLength: body.artifactByteLength,
    archiveFormat: body.archiveFormat,
    mode: body.mode,
    status: "DOCS_RELEASE_STATUS_VALIDATING",
    ...overrides,
  };
}

function upload(id = UPLOAD_ID, overrides = {}) {
  return {
    uploadIntentId: id,
    method: "PUT",
    url: `https://objects.example/${id}?signature=not-for-output`,
    requiredHeaders: [
      { name: "content-type", value: "application/gzip" },
      { name: "content-length", value: "7" },
    ],
    contentLength: 7,
    expiresAt: "2099-01-01T00:00:00Z",
    ...overrides,
  };
}

function deployment(id, environment, status, promotedFromStagingDeploymentId = "", releaseId = RELEASE_ID) {
  const outputPresent = status !== "DEPLOYMENT_STATUS_FAILED";
  const outputStatus = environment === "DEPLOYMENT_ENVIRONMENT_STAGING"
      && status !== "DEPLOYMENT_STATUS_COMPLETED"
    ? "DOCS_PUBLISHED_OUTPUT_STATUS_RESERVED"
    : "DOCS_PUBLISHED_OUTPUT_STATUS_AVAILABLE";
  const pointerVersion = status === "DEPLOYMENT_STATUS_COMPLETED" ? 1 : 0;
  return {
    deployment: {
      id,
      siteId: SITE_ID,
      status,
      environment,
      docsReleaseId: releaseId,
      docsOutputReleaseId: OUTPUT_ID,
      docsPointerVersion: pointerVersion,
    },
    docsReleaseId: releaseId,
    outputReleaseId: OUTPUT_ID,
    ...(outputPresent
      ? {
        output: {
          outputReleaseId: OUTPUT_ID,
          siteId: SITE_ID,
          sourceDeploymentId: promotedFromStagingDeploymentId || id,
          docsReleaseId: releaseId,
          status: outputStatus,
        },
      }
      : {}),
    pointerVersion,
    pointerAcknowledgedAt: status === "DEPLOYMENT_STATUS_COMPLETED" ? "2026-01-01T00:00:00Z" : undefined,
    promotedFromStagingDeploymentId,
  };
}

function harness(requestImplementation, uploadImplementation = async () => {}) {
  return {
    requests: [],
    uploads: 0,
    signal: undefined,
    sleep: async () => {},
    async request(path, options = {}) {
      this.requests.push({ path, options });
      return await requestImplementation(path, options, this);
    },
    async upload(capability, bytes) {
      this.uploads += 1;
      return await uploadImplementation(capability, bytes, this);
    },
  };
}

function prepared(client, revision, now, sourceDateEpoch = 1_767_225_600, mode = "managed") {
  return publishPreparedArtifact({
    config: { siteId: SITE_ID, mode },
    snapshot: { mode, manifest: manifest(revision, sourceDateEpoch) },
    archive: { mode, bytes: Buffer.from("archive"), byteLength: 7, contentHash: HASH },
    client,
    now,
  });
}

function createBody(client) {
  return client.requests.find((request) => request.path.endsWith("/docs/releases")).options.body;
}

// Rewrites what the server echoes back on every release read for this publish.
function withReleaseEcho(client, overrides) {
  const original = client.request.bind(client);
  client.request = async (path, options) => {
    const response = await original(path, options);
    if (path.endsWith("/docs/releases") && options?.method === "POST") {
      return { ...response, release: { ...response.release, ...overrides } };
    }
    if (path.includes("/docs/releases/")) return { ...response, ...overrides };
    return response;
  };
  return client;
}

function successClient({ reused = false, uploadBehavior, releaseId = RELEASE_ID, uploadContentLength = 7 } = {}) {
  let body;
  const client = harness(async (path, options) => {
    if (path.endsWith("/docs/releases") && options.method === "POST") {
      body = options.body;
      return {
        release: release(body, { id: releaseId, ...(reused ? {} : { status: "DOCS_RELEASE_STATUS_STAGED" }) }),
        uploadRequired: !reused,
        artifactReused: reused,
        upload: reused ? undefined : upload(UPLOAD_ID, { contentLength: uploadContentLength }),
      };
    }
    if (path.endsWith(`/${releaseId}/complete`)) return release(body, { id: releaseId });
    if (path.endsWith(`/docs/releases/${releaseId}`)) {
      return release(body, {
        id: releaseId,
        status: "DOCS_RELEASE_STATUS_VALIDATED",
        validatedAt: "2026-01-01T00:00:00Z",
      });
    }
    if (path.endsWith("/docs/deployments:stage")) {
      return deployment(STAGING_ID, "DEPLOYMENT_ENVIRONMENT_STAGING", "DEPLOYMENT_STATUS_QUEUED", "", releaseId);
    }
    if (path.endsWith(`/docs/deployments/${STAGING_ID}`)) {
      return deployment(STAGING_ID, "DEPLOYMENT_ENVIRONMENT_STAGING", "DEPLOYMENT_STATUS_COMPLETED", "", releaseId);
    }
    if (path.endsWith("/docs/deployments:promote")) {
      return deployment(
        PRODUCTION_ID,
        "DEPLOYMENT_ENVIRONMENT_PRODUCTION",
        "DEPLOYMENT_STATUS_DEPLOYING",
        STAGING_ID,
        releaseId,
      );
    }
    if (path.endsWith(`/docs/deployments/${PRODUCTION_ID}`)) {
      return deployment(
        PRODUCTION_ID,
        "DEPLOYMENT_ENVIRONMENT_PRODUCTION",
        "DEPLOYMENT_STATUS_COMPLETED",
        STAGING_ID,
        releaseId,
      );
    }
    throw new Error(`Unexpected test request path: ${path}`);
  }, uploadBehavior);
  return client;
}

test("publishes through reserved staging and production promoted from its exact output", async () => {
  const client = successClient();
  const result = await prepared(client);
  assert.equal(result.ok, true);
  assert.equal(result.release.id, RELEASE_ID);
  assert.equal(result.staging.deploymentId, STAGING_ID);
  assert.equal(result.production.deploymentId, PRODUCTION_ID);
  assert.equal(result.production.outputReleaseId, OUTPUT_ID);
  assert.equal(result.artifact.uploaded, true);
  assert.equal(client.uploads, 1);
});

test("managed and prebuilt release intents never share a mode, format, or idempotency key", async () => {
  const managedClient = successClient({ reused: true });
  const prebuiltClient = successClient({ reused: true, releaseId: OTHER_RELEASE_ID });
  const managedResult = await prepared(managedClient, undefined, undefined, undefined, "managed");
  const prebuiltResult = await prepared(prebuiltClient, undefined, undefined, undefined, "prebuilt");
  const managedBody = createBody(managedClient);
  const prebuiltBody = createBody(prebuiltClient);

  assert.equal(managedBody.mode, MANAGED_WIRE_MODE);
  assert.equal(prebuiltBody.mode, PREBUILT_WIRE_MODE);
  assert.equal(managedBody.archiveFormat, MANAGED_WIRE_FORMAT);
  assert.equal(prebuiltBody.archiveFormat, PREBUILT_WIRE_FORMAT);
  // The same source build and the same bytes still cannot share an intent.
  assert.equal(managedBody.artifactContentHash, prebuiltBody.artifactContentHash);
  assert.equal(managedBody.sourceRevision, prebuiltBody.sourceRevision);
  assert.notEqual(managedBody.idempotencyKey, prebuiltBody.idempotencyKey);
  assert.equal(managedResult.mode, "managed");
  assert.equal(prebuiltResult.mode, "prebuilt");
  assert.equal(managedResult.compatibility.archiveFormat, "taproot-docs-tar-gzip-v1");
  assert.equal(prebuiltResult.compatibility.archiveFormat, "taproot-docs-prebuilt-tar-gzip-v1");
  // Taproot's validation worker computes and records the prebuilt manifest
  // digest; the publisher never claims it.
  assert.equal(Object.hasOwn(prebuiltBody, "prebuiltManifestSha256"), false);
});

test("an unstamped prepared publish uses the managed contract", async () => {
  const client = successClient({ reused: true });
  const result = await publishPreparedArtifact({
    config: { siteId: SITE_ID },
    snapshot: { manifest: manifest() },
    archive: { bytes: Buffer.from("archive"), byteLength: 7, contentHash: HASH },
    client,
  });

  assert.equal(result.mode, "managed");
  assert.equal(createBody(client).mode, MANAGED_WIRE_MODE);
  assert.equal(createBody(client).archiveFormat, MANAGED_WIRE_FORMAT);
});

test("the success result carries the publisher's exact compatibility contract", async () => {
  const result = await prepared(successClient({ reused: true }), undefined, undefined, undefined, "prebuilt");

  assert.deepEqual(result.compatibility, {
    configVersion: CONFIG_VERSION,
    artifactPackageVersion: ARTIFACT_PACKAGE_VERSION,
    artifactSchemaVersion: 1,
    archiveFormat: "taproot-docs-prebuilt-tar-gzip-v1",
  });
  assert.deepEqual(result.publisher, { name: "@taprootio/docs-publisher", version: PUBLISHER_VERSION });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.mode, "prebuilt");
  assert.equal(result.siteId, SITE_ID);
  assert.equal(result.release.id, RELEASE_ID);
  assert.equal(result.staging.deploymentId, STAGING_ID);
  assert.equal(result.production.deploymentId, PRODUCTION_ID);
});

test("rejects a release echo that is not the exact sent mode and container pair", async (testContext) => {
  for (
    const [scenario, mode, echo] of [
      ["managed echoed as prebuilt", "managed", { mode: PREBUILT_WIRE_MODE }],
      ["prebuilt echoed as managed", "prebuilt", { mode: MANAGED_WIRE_MODE }],
      ["prebuilt echoed without a mode", "prebuilt", { mode: undefined }],
      ["prebuilt echoed as unspecified", "prebuilt", { mode: "DOCS_PUBLICATION_MODE_UNSPECIFIED" }],
      ["managed echoed with the prebuilt container", "managed", { archiveFormat: PREBUILT_WIRE_FORMAT }],
      ["prebuilt echoed with the managed container", "prebuilt", { archiveFormat: MANAGED_WIRE_FORMAT }],
    ]
  ) {
    await testContext.test(scenario, async () => {
      const client = withReleaseEcho(successClient({ reused: true }), echo);
      await assert.rejects(
        prepared(client, undefined, undefined, undefined, mode),
        (error) => error?.code === "api.release_intent_mismatch",
      );
    });
  }
});

test("accepts a managed release echo from a server that predates explicit mode identity", async (testContext) => {
  for (const echoedMode of [undefined, "", "DOCS_PUBLICATION_MODE_UNSPECIFIED"]) {
    await testContext.test(`echoed mode ${JSON.stringify(echoedMode)}`, async () => {
      const client = withReleaseEcho(successClient({ reused: true }), { mode: echoedMode });
      const result = await prepared(client, undefined, undefined, undefined, "managed");
      assert.equal(result.ok, true);
      assert.equal(result.mode, "managed");
    });
  }
});

test("refuses to publish when the selected mode, snapshot, and archive disagree", async (testContext) => {
  for (
    const [scenario, selected, snapshotMode, archiveMode, code] of [
      ["unsupported selection", "static", "static", "static", "publish.mode_unsupported"],
      ["snapshot disagrees", "prebuilt", "managed", "prebuilt", "publish.mode_mismatch"],
      ["archive disagrees", "prebuilt", "prebuilt", "managed", "publish.mode_mismatch"],
    ]
  ) {
    await testContext.test(scenario, async () => {
      const client = successClient({ reused: true });
      await assert.rejects(
        publishPreparedArtifact({
          config: { siteId: SITE_ID, mode: selected },
          snapshot: { mode: snapshotMode, manifest: manifest() },
          archive: { mode: archiveMode, bytes: Buffer.from("archive"), byteLength: 7, contentHash: HASH },
          client,
        }),
        (error) => error?.code === code && error?.field === "mode",
      );
      assert.equal(client.requests.length, 0);
    });
  }
});

test("accepts an omitted protobuf default epoch for a zero-date build", async () => {
  const client = successClient();
  const result = await prepared(client, undefined, undefined, 0);
  const create = client.requests.find((request) => request.path.endsWith("/docs/releases"));

  assert.equal(result.ok, true);
  assert.equal(create.options.body.buildSourceDateEpoch, 0);
});

test("normalizes protobuf JSON int64 upload lengths and rejects unsafe values", async (testContext) => {
  await testContext.test("decimal string", async () => {
    let normalizedCapability;
    const client = successClient({
      uploadContentLength: "7",
      uploadBehavior: async (capability) => {
        normalizedCapability = capability;
      },
    });
    const result = await prepared(client);
    assert.equal(result.ok, true);
    assert.equal(normalizedCapability.contentLength, 7);
    assert.equal(normalizedCapability.uploadIntentId, UPLOAD_ID);
    assert.equal(client.uploads, 1);
  });

  for (const contentLength of ["7x", "9007199254740992"]) {
    await testContext.test(`invalid ${contentLength}`, async () => {
      const client = successClient({ uploadContentLength: contentLength });
      await assert.rejects(
        prepared(client),
        (error) => error?.code === "api.upload_contract" && error?.field === "upload.contentLength",
      );
      assert.equal(client.uploads, 0);
    });
  }
});

test("rejects sibling identities returned by release and deployment reads", async (testContext) => {
  await testContext.test("current release", async () => {
    const client = successClient({ reused: true });
    const original = client.request.bind(client);
    client.request = async (path, options) => {
      if (path.endsWith(`/docs/releases/${RELEASE_ID}`)) {
        const body = client.requests.find((request) => request.path.endsWith("/docs/releases")).options.body;
        return release(body, {
          id: OTHER_RELEASE_ID,
          status: "DOCS_RELEASE_STATUS_VALIDATED",
          validatedAt: "2026-01-01T00:00:00Z",
        });
      }
      return await original(path, options);
    };
    await assert.rejects(prepared(client), (error) => error?.code === "api.release_intent_mismatch");
  });

  await testContext.test("release completion", async () => {
    let body;
    let createCount = 0;
    const client = harness(async (path, options) => {
      if (path.endsWith("/docs/releases") && options.method === "POST") {
        createCount += 1;
        if (createCount > 1) throw new ApiError(409, { code: 6 });
        body = options.body;
        return {
          release: release(body, { status: "DOCS_RELEASE_STATUS_STAGED" }),
          uploadRequired: true,
          upload: upload(),
        };
      }
      if (path.endsWith(`/${RELEASE_ID}/complete`)) {
        return release(body, { id: OTHER_RELEASE_ID });
      }
      if (path.endsWith(`/docs/releases/${RELEASE_ID}`)) {
        return release(body, { status: "DOCS_RELEASE_STATUS_STAGED" });
      }
      throw new Error(`Unexpected test request path: ${path}`);
    });
    await assert.rejects(prepared(client), (error) => error?.code === "api.release_intent_mismatch");
  });

  await testContext.test("deployment poll", async () => {
    const client = successClient();
    const original = client.request.bind(client);
    client.request = async (path, options) => {
      if (path.endsWith(`/docs/deployments/${STAGING_ID}`)) {
        return deployment(
          PRODUCTION_ID,
          "DEPLOYMENT_ENVIRONMENT_STAGING",
          "DEPLOYMENT_STATUS_COMPLETED",
        );
      }
      return await original(path, options);
    };
    await assert.rejects(prepared(client), (error) => error?.code === "api.deployment_intent_mismatch");
  });
});

test("identical bytes skip only upload while distinct source builds use distinct release identities", async () => {
  const first = successClient({ reused: true });
  const second = successClient({ reused: true, releaseId: OTHER_RELEASE_ID });
  const firstResult = await prepared(first, "0123456789abcdef0123456789abcdef01234567");
  const secondResult = await prepared(second, "1123456789abcdef0123456789abcdef01234567");
  const firstCreate = first.requests.find((request) => request.path.endsWith("/docs/releases"));
  const secondCreate = second.requests.find((request) => request.path.endsWith("/docs/releases"));
  assert.notEqual(firstCreate.options.body.idempotencyKey, secondCreate.options.body.idempotencyKey);
  assert.equal(firstCreate.options.body.artifactContentHash, secondCreate.options.body.artifactContentHash);
  assert.notEqual(firstResult.release.id, secondResult.release.id);
  assert.equal(firstResult.artifact.uploaded, false);
  assert.equal(secondResult.artifact.uploaded, false);
  assert.equal(first.uploads, 0);
  assert.equal(second.uploads, 0);
});

test("accepts only retained releases that preserve successful validation provenance", async () => {
  const client = successClient({ reused: true });
  const original = client.request.bind(client);
  client.request = async (path, options) => {
    if (path.endsWith(`/docs/releases/${RELEASE_ID}`)) {
      const body = client.requests.find((request) => request.path.endsWith("/docs/releases")).options.body;
      return release(body, {
        status: "DOCS_RELEASE_STATUS_RETAINED",
        validatedAt: "2026-01-01T00:00:00Z",
      });
    }
    return await original(path, options);
  };
  assert.equal((await prepared(client)).release.status, "DOCS_RELEASE_STATUS_RETAINED");
});

test("a lost PUT response is settled by exact completion without logging or restarting", async () => {
  const client = successClient({
    uploadBehavior: async () => {
      throw new PublisherError("upload.ambiguous", "No authoritative upload response.");
    },
  });
  const result = await prepared(client);
  assert.equal(result.release.status, "DOCS_RELEASE_STATUS_VALIDATED");
  assert.equal(client.uploads, 1);
  const createCalls = client.requests.filter((request) => request.path.endsWith("/docs/releases"));
  assert.equal(createCalls.length, 1);
});

test("lost create, complete, stage, and promotion responses replay byte-identical immutable intents", async () => {
  const mutationAttempts = new Map();
  let createBody;
  const api = new DocsApiClient({
    apiBaseUrl: "https://app.taproot.test/api",
    token: "tr_live_control_retry",
    sleep: async () => {},
    fetch: async (url, init) => {
      const pathname = new URL(url).pathname;
      if (new URL(url).origin === "https://objects.example") return new Response(null, { status: 200 });

      const lostResponseOperation = pathname.endsWith("/docs/releases")
        ? "create"
        : pathname.endsWith(`/${RELEASE_ID}/complete`)
        ? "complete"
        : pathname.endsWith("/docs/deployments:stage")
        ? "stage"
        : pathname.endsWith("/docs/deployments:promote")
        ? "promote"
        : undefined;
      if (lostResponseOperation) {
        const attempts = mutationAttempts.get(lostResponseOperation) ?? [];
        attempts.push(init.body);
        mutationAttempts.set(lostResponseOperation, attempts);
        if (lostResponseOperation === "create") createBody = JSON.parse(init.body);
        if (attempts.length === 1) throw new Error("response lost after persistence");
      }

      if (pathname.endsWith("/docs/releases")) {
        return new Response(
          JSON.stringify({
            release: release(createBody, { status: "DOCS_RELEASE_STATUS_STAGED" }),
            uploadRequired: true,
            upload: upload(),
          }),
          { status: 200 },
        );
      }
      if (pathname.endsWith(`/${RELEASE_ID}/complete`)) {
        return new Response(JSON.stringify(release(createBody)), { status: 200 });
      }
      if (pathname.endsWith(`/docs/releases/${RELEASE_ID}`)) {
        return new Response(
          JSON.stringify(release(createBody, {
            status: "DOCS_RELEASE_STATUS_VALIDATED",
            validatedAt: "2026-01-01T00:00:00Z",
          })),
          { status: 200 },
        );
      }
      if (pathname.endsWith("/docs/deployments:stage")) {
        return new Response(
          JSON.stringify(deployment(
            STAGING_ID,
            "DEPLOYMENT_ENVIRONMENT_STAGING",
            "DEPLOYMENT_STATUS_QUEUED",
          )),
          { status: 200 },
        );
      }
      if (pathname.endsWith(`/docs/deployments/${STAGING_ID}`)) {
        return new Response(
          JSON.stringify(deployment(
            STAGING_ID,
            "DEPLOYMENT_ENVIRONMENT_STAGING",
            "DEPLOYMENT_STATUS_COMPLETED",
          )),
          { status: 200 },
        );
      }
      if (pathname.endsWith("/docs/deployments:promote")) {
        return new Response(
          JSON.stringify(deployment(
            PRODUCTION_ID,
            "DEPLOYMENT_ENVIRONMENT_PRODUCTION",
            "DEPLOYMENT_STATUS_DEPLOYING",
            STAGING_ID,
          )),
          { status: 200 },
        );
      }
      if (pathname.endsWith(`/docs/deployments/${PRODUCTION_ID}`)) {
        return new Response(
          JSON.stringify(deployment(
            PRODUCTION_ID,
            "DEPLOYMENT_ENVIRONMENT_PRODUCTION",
            "DEPLOYMENT_STATUS_COMPLETED",
            STAGING_ID,
          )),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected test request path: ${pathname}`);
    },
  });

  const result = await prepared(api);
  assert.equal(result.ok, true);
  for (const operation of ["create", "complete", "stage", "promote"]) {
    const attempts = mutationAttempts.get(operation);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0], attempts[1]);
  }
});

test("a one-shot restart CAS reconciles a lost commit or concurrent winner", async (testContext) => {
  for (
    const [scenario, restartFailure] of [
      [
        "committed response lost",
        () => new PublisherError("transport.network", "The restart response was lost."),
      ],
      [
        "concurrent CAS winner",
        () =>
          new ApiError(409, {
            code: 10,
            details: [{ fieldViolations: [{ field: "RestartUploadIntentId" }] }],
          }),
      ],
    ]
  ) {
    await testContext.test(scenario, async () => {
      let body;
      let createCount = 0;
      let completeCount = 0;
      let restartAttempts = 0;
      const client = harness(async (path, options) => {
        if (path.endsWith("/docs/releases") && options.method === "POST") {
          createCount += 1;
          body ??= options.body;
          if (options.body.restartUploadIntentId) {
            restartAttempts += 1;
            assert.equal(options.body.restartUploadIntentId, UPLOAD_ID);
            assert.equal(options.attempts, 1);
            throw restartFailure();
          }
          assert.equal(options.body.restartUploadIntentId, "");
          if (createCount === 1) {
            return {
              release: release(body, { status: "DOCS_RELEASE_STATUS_STAGED" }),
              uploadRequired: true,
              upload: upload(),
            };
          }
          if (createCount === 2) {
            throw new ApiError(409, {
              code: 9,
              details: [{ fieldViolations: [{ field: "RestartUploadIntentId" }] }],
            });
          }
          assert.equal(createCount, 4);
          return {
            release: release(body, { status: "DOCS_RELEASE_STATUS_STAGED" }),
            uploadRequired: true,
            upload: upload(RESTART_ID),
          };
        }
        if (path.endsWith(`/${RELEASE_ID}/complete`)) {
          completeCount += 1;
          if (completeCount === 1) throw new ApiError(409, { code: 9 });
          assert.equal(options.body.uploadIntentId, RESTART_ID);
          return release(body);
        }
        if (path.endsWith(`/docs/releases/${RELEASE_ID}`)) {
          return completeCount === 1
            ? release(body, { status: "DOCS_RELEASE_STATUS_STAGED" })
            : release(body, {
              status: "DOCS_RELEASE_STATUS_VALIDATED",
              validatedAt: "2026-01-01T00:00:00Z",
            });
        }
        if (path.endsWith("/docs/deployments:stage")) {
          return deployment(STAGING_ID, "DEPLOYMENT_ENVIRONMENT_STAGING", "DEPLOYMENT_STATUS_QUEUED");
        }
        if (path.endsWith(`/docs/deployments/${STAGING_ID}`)) {
          return deployment(STAGING_ID, "DEPLOYMENT_ENVIRONMENT_STAGING", "DEPLOYMENT_STATUS_COMPLETED");
        }
        if (path.endsWith("/docs/deployments:promote")) {
          return deployment(
            PRODUCTION_ID,
            "DEPLOYMENT_ENVIRONMENT_PRODUCTION",
            "DEPLOYMENT_STATUS_DEPLOYING",
            STAGING_ID,
          );
        }
        if (path.endsWith(`/docs/deployments/${PRODUCTION_ID}`)) {
          return deployment(
            PRODUCTION_ID,
            "DEPLOYMENT_ENVIRONMENT_PRODUCTION",
            "DEPLOYMENT_STATUS_COMPLETED",
            STAGING_ID,
          );
        }
        throw new Error(`Unexpected test request path: ${path}`);
      });

      const result = await prepared(client);
      assert.equal(result.ok, true);
      assert.equal(restartAttempts, 1);
      assert.equal(createCount, 4);
      assert.equal(client.uploads, 2);
    });
  }
});

test("an uncommitted ambiguous restart retries the exact CAS within one bounded budget", async () => {
  let body;
  let createCount = 0;
  let completeCount = 0;
  const restartBodies = [];
  const client = harness(async (path, options) => {
    if (path.endsWith("/docs/releases") && options.method === "POST") {
      createCount += 1;
      body ??= options.body;
      if (options.body.restartUploadIntentId) {
        restartBodies.push(options.body);
        assert.equal(options.attempts, 1);
        if (restartBodies.length === 1) {
          throw new PublisherError("transport.network", "The uncommitted restart request was lost.");
        }
        return {
          release: release(body, { status: "DOCS_RELEASE_STATUS_STAGED" }),
          uploadRequired: true,
          upload: upload(RESTART_ID),
        };
      }
      if (createCount === 1) {
        return {
          release: release(body, { status: "DOCS_RELEASE_STATUS_STAGED" }),
          uploadRequired: true,
          upload: upload(),
        };
      }
      throw new ApiError(409, {
        code: 9,
        details: [{ fieldViolations: [{ field: "RestartUploadIntentId" }] }],
      });
    }
    if (path.endsWith(`/${RELEASE_ID}/complete`)) {
      completeCount += 1;
      if (completeCount === 1) throw new ApiError(409, { code: 9 });
      assert.equal(options.body.uploadIntentId, RESTART_ID);
      return release(body);
    }
    if (path.endsWith(`/docs/releases/${RELEASE_ID}`)) {
      return completeCount === 1
        ? release(body, { status: "DOCS_RELEASE_STATUS_STAGED" })
        : release(body, {
          status: "DOCS_RELEASE_STATUS_VALIDATED",
          validatedAt: "2026-01-01T00:00:00Z",
        });
    }
    if (path.endsWith("/docs/deployments:stage")) {
      return deployment(STAGING_ID, "DEPLOYMENT_ENVIRONMENT_STAGING", "DEPLOYMENT_STATUS_QUEUED");
    }
    if (path.endsWith(`/docs/deployments/${STAGING_ID}`)) {
      return deployment(STAGING_ID, "DEPLOYMENT_ENVIRONMENT_STAGING", "DEPLOYMENT_STATUS_COMPLETED");
    }
    if (path.endsWith("/docs/deployments:promote")) {
      return deployment(
        PRODUCTION_ID,
        "DEPLOYMENT_ENVIRONMENT_PRODUCTION",
        "DEPLOYMENT_STATUS_DEPLOYING",
        STAGING_ID,
      );
    }
    if (path.endsWith(`/docs/deployments/${PRODUCTION_ID}`)) {
      return deployment(
        PRODUCTION_ID,
        "DEPLOYMENT_ENVIRONMENT_PRODUCTION",
        "DEPLOYMENT_STATUS_COMPLETED",
        STAGING_ID,
      );
    }
    throw new Error(`Unexpected test request path: ${path}`);
  });

  const result = await prepared(client);
  assert.equal(result.ok, true);
  assert.equal(restartBodies.length, 2);
  assert.deepEqual(restartBodies[0], restartBodies[1]);
  assert.equal(client.uploads, 2);
});

test("uncommitted ambiguous restart reconciliation exhausts the existing intent budget", async () => {
  let body;
  let createCount = 0;
  let restartAttempts = 0;
  const client = harness(async (path, options) => {
    if (path.endsWith("/docs/releases") && options.method === "POST") {
      createCount += 1;
      body ??= options.body;
      if (options.body.restartUploadIntentId) {
        restartAttempts += 1;
        assert.equal(options.body.restartUploadIntentId, UPLOAD_ID);
        assert.equal(options.attempts, 1);
        throw new PublisherError("transport.network", "The uncommitted restart request was lost.");
      }
      if (createCount === 1) {
        return {
          release: release(body, { status: "DOCS_RELEASE_STATUS_STAGED" }),
          uploadRequired: true,
          upload: upload(),
        };
      }
      throw new ApiError(409, {
        code: 9,
        details: [{ fieldViolations: [{ field: "RestartUploadIntentId" }] }],
      });
    }
    if (path.endsWith(`/${RELEASE_ID}/complete`)) throw new ApiError(409, { code: 9 });
    if (path.endsWith(`/docs/releases/${RELEASE_ID}`)) {
      return release(body, { status: "DOCS_RELEASE_STATUS_STAGED" });
    }
    throw new Error(`Unexpected test request path: ${path}`);
  });

  await assert.rejects(prepared(client), (error) => error?.code === "upload.restart_exhausted");
  assert.equal(restartAttempts, LIMITS.uploadIntents);
  assert.equal(client.uploads, 1);
});

test("three restart-required upload intents surface final completion without reserving a fourth", async () => {
  let body;
  let createCount = 0;
  let completionCount = 0;
  let authoritativeCompletion;
  const restartBodies = [];
  const client = harness(async (path, options) => {
    if (path.endsWith("/docs/releases") && options.method === "POST") {
      createCount += 1;
      body ??= options.body;
      if (options.body.restartUploadIntentId) {
        restartBodies.push(options.body);
        assert.equal(options.attempts, 1);
        return {
          release: release(body, { status: "DOCS_RELEASE_STATUS_STAGED" }),
          uploadRequired: true,
          upload: upload(restartBodies.length === 1 ? RESTART_ID : THIRD_UPLOAD_ID),
        };
      }
      if (createCount === 1) {
        return {
          release: release(body, { status: "DOCS_RELEASE_STATUS_STAGED" }),
          uploadRequired: true,
          upload: upload(),
        };
      }
      throw new ApiError(409, {
        code: 9,
        details: [{ fieldViolations: [{ field: "RestartUploadIntentId" }] }],
      });
    }
    if (path.endsWith(`/${RELEASE_ID}/complete`)) {
      completionCount += 1;
      authoritativeCompletion = new ApiError(409, { code: 9 });
      throw authoritativeCompletion;
    }
    if (path.endsWith(`/docs/releases/${RELEASE_ID}`)) {
      return release(body, { status: "DOCS_RELEASE_STATUS_STAGED" });
    }
    throw new Error(`Unexpected test request path: ${path}`);
  });

  await assert.rejects(prepared(client), (error) => error === authoritativeCompletion);
  assert.equal(completionCount, LIMITS.uploadIntents);
  assert.equal(client.uploads, LIMITS.uploadIntents);
  assert.equal(restartBodies.length, LIMITS.uploadIntents - 1);
  assert.notEqual(restartBodies[0].restartUploadIntentId, restartBodies[1].restartUploadIntentId);
  assert.equal(restartBodies[0].restartUploadIntentId, UPLOAD_ID);
  assert.equal(restartBodies[1].restartUploadIntentId, RESTART_ID);
});

test("restarts only the exact current upload intent after a stable restart field rejection", async () => {
  let body;
  let createCount = 0;
  let completeCount = 0;
  const client = harness(async (path, options) => {
    if (path.endsWith("/docs/releases") && options.method === "POST") {
      createCount += 1;
      body ??= options.body;
      if (createCount === 1) {
        return {
          release: release(body, { status: "DOCS_RELEASE_STATUS_STAGED" }),
          uploadRequired: true,
          upload: upload(),
        };
      }
      if (createCount === 2) {
        throw new ApiError(400, {
          code: 3,
          details: [{ fieldViolations: [{ field: "RestartUploadIntentId" }] }],
        });
      }
      assert.equal(options.body.restartUploadIntentId, UPLOAD_ID);
      assert.equal(options.attempts, 1);
      assert.deepEqual({ ...options.body, restartUploadIntentId: "" }, body);
      return {
        release: release(body, { status: "DOCS_RELEASE_STATUS_STAGED" }),
        uploadRequired: true,
        upload: upload(RESTART_ID),
      };
    }
    if (path.endsWith(`/${RELEASE_ID}/complete`)) {
      completeCount += 1;
      if (completeCount === 1) throw new ApiError(400, { code: 9 });
      assert.equal(options.body.uploadIntentId, RESTART_ID);
      return release(body);
    }
    if (path.endsWith(`/docs/releases/${RELEASE_ID}`)) {
      if (completeCount === 1) return release(body, { status: "DOCS_RELEASE_STATUS_STAGED" });
      return release(body, { status: "DOCS_RELEASE_STATUS_VALIDATED", validatedAt: "2026-01-01T00:00:00Z" });
    }
    if (path.endsWith("/docs/deployments:stage")) {
      return deployment(STAGING_ID, "DEPLOYMENT_ENVIRONMENT_STAGING", "DEPLOYMENT_STATUS_QUEUED");
    }
    if (path.endsWith(`/docs/deployments/${STAGING_ID}`)) {
      return deployment(STAGING_ID, "DEPLOYMENT_ENVIRONMENT_STAGING", "DEPLOYMENT_STATUS_COMPLETED");
    }
    if (path.endsWith("/docs/deployments:promote")) {
      return deployment(PRODUCTION_ID, "DEPLOYMENT_ENVIRONMENT_PRODUCTION", "DEPLOYMENT_STATUS_DEPLOYING", STAGING_ID);
    }
    if (path.endsWith(`/docs/deployments/${PRODUCTION_ID}`)) {
      return deployment(PRODUCTION_ID, "DEPLOYMENT_ENVIRONMENT_PRODUCTION", "DEPLOYMENT_STATUS_COMPLETED", STAGING_ID);
    }
    throw new Error(`Unexpected test request path: ${path}`);
  }, async (_capability, _bytes, current) => {
    if (current.uploads === 1) throw new PublisherError("upload.rejected", "Rejected.");
  });

  const result = await prepared(client);
  assert.equal(result.ok, true);
  assert.equal(createCount, 3);
  assert.equal(client.uploads, 2);
});

test("stable release and deployment failures terminate non-successfully", async (testContext) => {
  await testContext.test("release rejection", async () => {
    let body;
    const client = harness(async (path, options) => {
      if (path.endsWith("/docs/releases")) {
        body = options.body;
        return { release: release(body), artifactReused: true };
      }
      if (path.endsWith(`/docs/releases/${RELEASE_ID}`)) {
        return release(body, { status: "DOCS_RELEASE_STATUS_REJECTED", failureCode: "docs_artifact_invalid" });
      }
      throw new Error("Unexpected request");
    });
    await assert.rejects(prepared(client), (error) => error?.code === "release.validation_failed");
  });

  await testContext.test("staging failure", async () => {
    const client = successClient();
    const original = client.request.bind(client);
    client.request = async (path, options) => {
      if (path.endsWith(`/docs/deployments/${STAGING_ID}`)) {
        return deployment(STAGING_ID, "DEPLOYMENT_ENVIRONMENT_STAGING", "DEPLOYMENT_STATUS_FAILED");
      }
      return await original(path, options);
    };
    await assert.rejects(prepared(client), (error) => error?.code === "deployment.failed");
  });
});

test("completed staging and production require valid pointer acknowledgement timestamps", async (testContext) => {
  for (
    const [scenario, deploymentId, pointerAcknowledgedAt, errorCode] of [
      ["staging missing", STAGING_ID, undefined, "api.deployment_incomplete"],
      ["production missing", PRODUCTION_ID, undefined, "api.deployment_incomplete"],
      ["production malformed", PRODUCTION_ID, "not-a-timestamp", "api.deployment_contract"],
    ]
  ) {
    await testContext.test(scenario, async () => {
      const client = successClient();
      const original = client.request.bind(client);
      client.request = async (path, options) => {
        if (path.endsWith(`/docs/deployments/${deploymentId}`)) {
          const value = deployment(
            deploymentId,
            deploymentId === STAGING_ID
              ? "DEPLOYMENT_ENVIRONMENT_STAGING"
              : "DEPLOYMENT_ENVIRONMENT_PRODUCTION",
            "DEPLOYMENT_STATUS_COMPLETED",
            deploymentId === STAGING_ID ? "" : STAGING_ID,
          );
          if (pointerAcknowledgedAt === undefined) delete value.pointerAcknowledgedAt;
          else value.pointerAcknowledgedAt = pointerAcknowledgedAt;
          return value;
        }
        return await original(path, options);
      };
      await assert.rejects(
        prepared(client),
        (error) =>
          error?.code === errorCode
          && error?.field === "deployment.pointerAcknowledgedAt",
      );
    });
  }
});

test("release and deployment reads receive and enforce their absolute poll deadlines", async (testContext) => {
  for (
    const [scenario, targetPath, timeoutMilliseconds, timeoutCode, reused] of [
      [
        "release validation",
        `/docs/releases/${RELEASE_ID}`,
        LIMITS.validationMilliseconds,
        "release.validation_timeout",
        true,
      ],
      [
        "staging deployment",
        `/docs/deployments/${STAGING_ID}`,
        LIMITS.deploymentMilliseconds,
        "deployment.timeout",
        false,
      ],
    ]
  ) {
    await testContext.test(scenario, async () => {
      let clock = 0;
      const client = successClient({ reused });
      const original = client.request.bind(client);
      client.request = async (path, options = {}) => {
        if (path.endsWith(targetPath)) {
          assert.equal(options.deadline, timeoutMilliseconds);
          assert.equal(options.now(), clock);
          clock = options.deadline;
          throw new PublisherError("transport.deadline", "The poll read reached its deadline.");
        }
        return await original(path, options);
      };
      await assert.rejects(
        prepared(client, undefined, () => clock),
        (error) => error?.code === timeoutCode,
      );
    });
  }
});

test("parent cancellation at the poll deadline remains cancellation", async () => {
  let clock = 0;
  const controller = new AbortController();
  const client = successClient({ reused: true });
  client.signal = controller.signal;
  const original = client.request.bind(client);
  client.request = async (path, options = {}) => {
    if (path.endsWith(`/docs/releases/${RELEASE_ID}`)) {
      assert.equal(options.deadline, LIMITS.validationMilliseconds);
      clock = options.deadline;
      controller.abort();
      throw new PublisherError("publisher.cancelled", "Cancelled.");
    }
    return await original(path, options);
  };

  await assert.rejects(
    prepared(client, undefined, () => clock),
    (error) => error?.code === "publisher.cancelled",
  );
  assert.equal(controller.signal.aborted, true);
});
