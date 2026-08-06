#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const GITHUB_HOSTED_BUILDER = "https://github.com/actions/runner/github-hosted";

function fail(message) {
  throw new Error(`npm release guard failed: ${message}`);
}

export function parseSemVer(version) {
  if (typeof version !== "string") fail(`invalid semantic version ${JSON.stringify(version)}`);
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(version);
  if (!match) fail(`invalid semantic version ${JSON.stringify(version)}`);
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^\d+$/u.test(part) && part.length > 1 && part.startsWith("0"))) {
    fail(`invalid semantic version ${JSON.stringify(version)}`);
  }
  return {
    core: match.slice(1, 4).map((part) => BigInt(part)),
    prerelease,
  };
}

export function compareSemVer(leftVersion, rightVersion) {
  const left = parseSemVer(leftVersion);
  const right = parseSemVer(rightVersion);
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] < right.core[index]) return -1;
    if (left.core[index] > right.core[index]) return 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function assertMonotonicRelease(candidateVersion, publishedVersions) {
  let normalizedVersions = publishedVersions;
  if (typeof normalizedVersions === "string") normalizedVersions = [normalizedVersions];
  if (
    Array.isArray(normalizedVersions)
    && normalizedVersions.length === 1
    && Array.isArray(normalizedVersions[0])
  ) {
    normalizedVersions = normalizedVersions[0];
  }
  if (
    !Array.isArray(normalizedVersions)
    || normalizedVersions.some((version) => typeof version !== "string")
  ) {
    fail("published versions must be a version string or JSON array of version strings");
  }
  for (const publishedVersion of normalizedVersions) {
    if (compareSemVer(candidateVersion, publishedVersion) < 0) {
      fail(
        `candidate ${candidateVersion} precedes already-published ${publishedVersion}; release tags must complete in version order`,
      );
    }
  }
}

function decodeStatement(attestationBundle) {
  const envelope = attestationBundle?.bundle?.dsseEnvelope ?? attestationBundle?.dsseEnvelope;
  const payload = envelope?.payload;
  if (typeof payload !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(payload)) return null;
  try {
    const decoded = Buffer.from(payload, "base64");
    if (decoded.toString("base64") !== payload) return null;
    return JSON.parse(decoded.toString("utf8"));
  } catch {
    return null;
  }
}

function normalizedWorkflowPath(workflowPath) {
  return typeof workflowPath === "string" ? workflowPath.replace(/^\//u, "") : workflowPath;
}

export function assertNpmProvenance({
  audit,
  packageName,
  packageVersion,
  repository,
  workflowPath,
  ref,
  commit,
}) {
  if (!audit || !Array.isArray(audit.verified)) {
    fail("npm did not return cryptographically verified attestation bundles");
  }
  if ((audit.invalid?.length ?? 0) !== 0 || (audit.missing?.length ?? 0) !== 0) {
    fail("npm reported an invalid or missing registry signature or attestation");
  }

  const verifiedPackage = audit.verified.find(
    (entry) => entry?.name === packageName && entry?.version === packageVersion,
  );
  const statements = (verifiedPackage?.attestationBundles ?? [])
    .map(decodeStatement)
    .filter(Boolean);
  const matches = statements.some((statement) => {
    if (
      statement?._type !== "https://in-toto.io/Statement/v1"
      || statement?.predicateType !== SLSA_PROVENANCE_V1
    ) return false;
    const buildDefinition = statement.predicate?.buildDefinition;
    const workflow = buildDefinition?.externalParameters?.workflow;
    const github = buildDefinition?.internalParameters?.github;
    const dependency = buildDefinition?.resolvedDependencies?.find(
      (entry) => entry?.uri === `git+${repository}@${ref}` && entry?.digest?.gitCommit === commit,
    );
    return workflow?.repository === repository
      && normalizedWorkflowPath(workflow?.path) === normalizedWorkflowPath(workflowPath)
      && workflow?.ref === ref
      && github?.event_name === "push"
      && statement.predicate?.runDetails?.builder?.id === GITHUB_HOSTED_BUILDER
      && Boolean(dependency);
  });
  if (!matches) {
    fail(
      `verified provenance does not bind ${repository}/${workflowPath} at ${ref} and commit ${commit}`,
    );
  }
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`could not read ${label} from ${filePath}: ${error.message}`);
  }
}

function main(args) {
  const [command, ...values] = args;
  if (command === "order" && values.length === 2) {
    assertMonotonicRelease(values[0], readJson(values[1], "published versions"));
    return;
  }
  if (command === "provenance" && values.length === 7) {
    assertNpmProvenance({
      audit: readJson(values[0], "npm audit output"),
      packageName: values[1],
      packageVersion: values[2],
      repository: values[3],
      workflowPath: values[4],
      ref: values[5],
      commit: values[6],
    });
    return;
  }
  fail("usage: npm-release-guard.mjs order <version> <versions-json> | provenance <audit-json> <name> <version> <repository> <workflow> <ref> <commit>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
