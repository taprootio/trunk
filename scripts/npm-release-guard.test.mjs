import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertMonotonicRelease,
  assertNpmProvenance,
  compareSemVer,
  npmPackIntegrity,
  parseSemVer,
} from "./npm-release-guard.mjs";

const expected = {
  packageName: "@taprootio/docs-artifact",
  packageVersion: "1.0.0",
  repository: "https://github.com/taprootio/trunk",
  workflowPath: ".github/workflows/publish-docs-artifact.yml",
  ref: "refs/tags/docs-artifact-v1.0.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
};
const guardPath = fileURLToPath(new URL("./npm-release-guard.mjs", import.meta.url));

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
  assert.deepEqual(parseSemVer("2.0.0-rc.10"), {
    core: [2n, 0n, 0n],
    prerelease: ["rc", "10"],
  });
  assert.equal(compareSemVer("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareSemVer("2.0.0-rc.2", "2.0.0-rc.10"), -1);
  assert.doesNotThrow(() => assertMonotonicRelease("1.2.0", ["1.0.0", "1.2.0"]));
  assert.throws(
    () => assertMonotonicRelease("1.1.9", ["1.0.0", "1.2.0"]),
    /precedes already-published 1\.2\.0/u,
  );
});

// npm 12 currently returns a flat array for this invocation. The scalar and
// nested forms are retained defensively for historical and invocation drift.
test("the release-order guard defensively accepts known versions response shapes", () => {
  assert.doesNotThrow(() => assertMonotonicRelease("1.2.0", "1.0.0"));
  assert.doesNotThrow(() => assertMonotonicRelease("1.2.0", ["1.0.0", "1.2.0"]));
  assert.doesNotThrow(() => assertMonotonicRelease("1.2.0", [["1.0.0", "1.2.0"]]));
});

test("the release-order guard rejects malformed versions response shapes", () => {
  for (const malformed of [
    null,
    {},
    1,
    ["1.0.0", ["1.1.0"]],
    [["1.0.0"], ["1.1.0"]],
    [[[["1.0.0"]]]],
  ]) {
    assert.throws(
      () => assertMonotonicRelease("1.2.0", malformed),
      /published versions must be a version string or JSON array of version strings/u,
    );
  }
});

test("npm pack integrity accepts npm 11 and npm 12 response shapes", () => {
  const pack = { name: expected.packageName, integrity: "sha512-candidate" };
  assert.equal(npmPackIntegrity([pack]), pack.integrity);
  assert.equal(npmPackIntegrity({ [expected.packageName]: pack }), pack.integrity);
});

test("npm pack integrity rejects ambiguous or malformed response shapes", () => {
  for (const malformed of [
    null,
    [],
    {},
    [{ integrity: "sha512-one" }, { integrity: "sha512-two" }],
    { [expected.packageName]: { name: expected.packageName } },
    { [expected.packageName]: { integrity: "" } },
  ]) {
    assert.throws(
      () => npmPackIntegrity(malformed),
      /npm pack output must contain exactly one package with an integrity value/u,
    );
  }
});

test("the CLI dispatches pack integrity and rejects invalid command arity", (testContext) => {
  const directory = mkdtempSync(join(tmpdir(), "npm-release-guard-"));
  testContext.after(() => rmSync(directory, { recursive: true, force: true }));
  const packFile = join(directory, "pack.json");
  writeFileSync(
    packFile,
    JSON.stringify({ [expected.packageName]: { integrity: "sha512-cli" } }),
  );

  const success = spawnSync(
    process.execPath,
    [guardPath, "pack-integrity", packFile],
    { encoding: "utf8" },
  );
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stdout.trim(), "sha512-cli");

  for (const args of [["order"], ["pack-integrity"], ["provenance"]]) {
    const failure = spawnSync(process.execPath, [guardPath, ...args], { encoding: "utf8" });
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /usage: npm-release-guard\.mjs/u);
  }
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
