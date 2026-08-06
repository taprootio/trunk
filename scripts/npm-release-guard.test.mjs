import assert from "node:assert/strict";
import test from "node:test";

import {
  assertMonotonicRelease,
  assertNpmProvenance,
  compareSemVer,
} from "./npm-release-guard.mjs";

const expected = {
  packageName: "@taprootio/docs-artifact",
  packageVersion: "1.0.0",
  repository: "https://github.com/taprootio/trunk",
  workflowPath: ".github/workflows/publish-docs-artifact.yml",
  ref: "refs/tags/docs-artifact-v1.0.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
};

function provenanceStatement(overrides = {}) {
  return {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: expected.repository,
            path: `/${expected.workflowPath}`,
            ref: expected.ref,
            ...overrides.workflow,
          },
        },
        internalParameters: { github: { event_name: "push" } },
        resolvedDependencies: [{
          uri: `git+${expected.repository}@${expected.ref}`,
          digest: { gitCommit: overrides.commit ?? expected.commit },
        }],
      },
      runDetails: {
        builder: { id: "https://github.com/actions/runner/github-hosted" },
      },
    },
  };
}

function auditWith(statement) {
  return {
    invalid: [],
    missing: [],
    verified: [{
      name: expected.packageName,
      version: expected.packageVersion,
      attestationBundles: statement === null
        ? []
        : [{
            bundle: {
              dsseEnvelope: {
                payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64"),
              },
            },
          }],
    }],
  };
}

test("semantic version comparison and the release-order guard fail closed", () => {
  assert.equal(compareSemVer("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareSemVer("2.0.0-rc.2", "2.0.0-rc.10"), -1);
  assert.doesNotThrow(() => assertMonotonicRelease("1.2.0", ["1.0.0", "1.2.0"]));
  assert.throws(
    () => assertMonotonicRelease("1.1.9", ["1.0.0", "1.2.0"]),
    /precedes already-published 1\.2\.0/u,
  );
});

test("an existing package succeeds only with verified provenance for this Trunk release", () => {
  assert.doesNotThrow(() => assertNpmProvenance({ audit: auditWith(provenanceStatement()), ...expected }));

  assert.throws(
    () => assertNpmProvenance({ audit: auditWith(null), ...expected }),
    /does not bind/u,
  );
  assert.throws(
    () => assertNpmProvenance({
      audit: auditWith(provenanceStatement({ workflow: { repository: "https://github.com/taprootio/elsewhere" } })),
      ...expected,
    }),
    /does not bind/u,
  );
  assert.throws(
    () => assertNpmProvenance({
      audit: auditWith(provenanceStatement({ commit: "ffffffffffffffffffffffffffffffffffffffff" })),
      ...expected,
    }),
    /does not bind/u,
  );
});
