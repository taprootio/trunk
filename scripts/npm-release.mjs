#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertExactVersion,
  assertMonotonicRelease,
  assertNpmIntegrity,
  assertNpmProvenance,
  npmPackIntegrity,
} from "./npm-release-guard.mjs";

const PUBLIC_REGISTRY = "https://registry.npmjs.org/";

function fail(message) {
  throw new Error(`npm release failed: ${message}`);
}

function readPackageJson(workingDirectory) {
  const packageJsonPath = path.join(workingDirectory, "package.json");
  try {
    return JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    fail(`could not read package metadata from ${packageJsonPath}: ${error.message}`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} is required`);
  return value;
}

function requireEnvironment(environment, name) {
  return requireString(environment[name], name);
}

function readReleasePackage(workingDirectory) {
  const packageJson = readPackageJson(workingDirectory);
  const name = requireString(packageJson.name, "package name");
  const version = assertExactVersion(packageJson.version, "package version");
  const repositoryUrl = requireString(packageJson.repository?.url, "package repository URL");
  if (!repositoryUrl.startsWith("https://github.com/") || !repositoryUrl.endsWith(".git")) {
    fail("package repository URL must be an HTTPS GitHub repository URL ending in .git");
  }
  return {
    name,
    repository: repositoryUrl.slice(0, -".git".length),
    version,
  };
}

function requireWorkflowPath(workflowPath) {
  if (!/^\.github\/workflows\/[A-Za-z0-9._-]+\.yml$/u.test(workflowPath)) {
    fail(`workflow path must be a public workflow path, got ${JSON.stringify(workflowPath)}`);
  }
  return workflowPath;
}

function runNpm(npmExecutable, args, { environment, workingDirectory, stdio = "pipe" }) {
  const result = spawnSync(npmExecutable, args, {
    cwd: workingDirectory,
    encoding: "utf8",
    env: environment,
    stdio,
    // Verified attestation JSON grows with the installed dependency tree.
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(`could not run npm ${args.join(" ")}: ${result.error.message}`);
  if (result.signal || result.status === null) fail(`npm ${args.join(" ")} did not complete`);
  return {
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

function requireNpmSuccess(result, args) {
  if (result.status === 0) return result.stdout;
  const detail = (result.stderr || result.stdout || "unknown npm error").trim();
  fail(`npm ${args.join(" ")} failed: ${detail}`);
}

function isNpmNotFound(result) {
  return result.stderr.split(/\r?\n/u).includes("npm error code E404");
}

function parseNpmJson(output, label) {
  try {
    return JSON.parse(output);
  } catch (error) {
    fail(`${label} was not valid JSON: ${error.message}`);
  }
}

function writeShouldPublish(outputPath, shouldPublish) {
  appendFileSync(outputPath, `should_publish=${shouldPublish}\n`);
}

/**
 * Checks the registry before a public release. An exact existing version is a
 * safe retry only when the local pack, signed audit record, and provenance all
 * bind to this Trunk workflow and commit.
 */
export function inspectNpmRelease({
  environment = process.env,
  npmExecutable = "npm",
  workingDirectory = process.cwd(),
  workflowPath,
} = {}) {
  const workflow = requireWorkflowPath(workflowPath);
  const releasePackage = readReleasePackage(workingDirectory);
  const runnerTemp = requireEnvironment(environment, "RUNNER_TEMP");
  const outputPath = requireEnvironment(environment, "GITHUB_OUTPUT");
  const tagName = requireEnvironment(environment, "GITHUB_REF_NAME");
  const commit = requireEnvironment(environment, "GITHUB_SHA");
  const packageSpec = `${releasePackage.name}@${releasePackage.version}`;
  const registryArguments = ["--registry", PUBLIC_REGISTRY];

  const versionsArguments = ["view", releasePackage.name, "versions", "--json", ...registryArguments];
  const versionsResult = runNpm(npmExecutable, versionsArguments, { environment, workingDirectory });
  const publishedVersions = versionsResult.status === 0
    ? parseNpmJson(versionsResult.stdout, "published versions response")
    : (() => {
        if (isNpmNotFound(versionsResult)) return [];
        requireNpmSuccess(versionsResult, versionsArguments);
      })();
  assertMonotonicRelease(releasePackage.version, publishedVersions);

  const integrityArguments = ["view", packageSpec, "dist.integrity", ...registryArguments];
  const integrityResult = runNpm(npmExecutable, integrityArguments, { environment, workingDirectory });
  if (integrityResult.status !== 0) {
    if (!isNpmNotFound(integrityResult)) requireNpmSuccess(integrityResult, integrityArguments);
    writeShouldPublish(outputPath, true);
    console.log(`${packageSpec} is not on npm and can be published.`);
    return { packageSpec, shouldPublish: true };
  }

  const publishedIntegrity = assertNpmIntegrity(
    integrityResult.stdout.trim(),
    "published package integrity",
  );
  const packArguments = ["pack", "--json", "--ignore-scripts", "--pack-destination", runnerTemp];
  const packResult = runNpm(npmExecutable, packArguments, { environment, workingDirectory });
  const localIntegrity = npmPackIntegrity(
    parseNpmJson(requireNpmSuccess(packResult, packArguments), "npm pack response"),
  );
  if (localIntegrity !== publishedIntegrity) {
    fail(`${packageSpec} already exists with a different package integrity`);
  }

  const auditDirectory = mkdtempSync(
    path.join(runnerTemp, `${releasePackage.name.replaceAll(/[^A-Za-z0-9._-]/gu, "-")}-provenance-`),
  );
  const installArguments = [
    "install",
    "--prefix",
    auditDirectory,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--save-exact",
    packageSpec,
    ...registryArguments,
  ];
  const installResult = runNpm(npmExecutable, installArguments, { environment, workingDirectory });
  requireNpmSuccess(installResult, installArguments);

  const auditArguments = [
    "--prefix",
    auditDirectory,
    "audit",
    "signatures",
    "--json",
    "--include-attestations",
    ...registryArguments,
  ];
  const auditResult = runNpm(npmExecutable, auditArguments, { environment, workingDirectory });
  const audit = parseNpmJson(requireNpmSuccess(auditResult, auditArguments), "npm audit signatures response");
  assertNpmProvenance({
    audit,
    packageName: releasePackage.name,
    packageVersion: releasePackage.version,
    repository: releasePackage.repository,
    workflowPath: workflow,
    ref: `refs/tags/${tagName}`,
    commit,
  });
  writeShouldPublish(outputPath, false);
  console.log(`${packageSpec} already exists with identical package integrity and verified Trunk provenance.`);
  return { packageSpec, shouldPublish: false };
}

export function publishNpmRelease({
  environment = process.env,
  npmExecutable = "npm",
  workingDirectory = process.cwd(),
} = {}) {
  const publishArguments = ["publish", "--access", "public", "--provenance", "--ignore-scripts"];
  // Keep npm's authentication/provenance notices in the job log, and avoid
  // capturing output from the irreversible publish operation in a bounded pipe.
  const result = runNpm(npmExecutable, publishArguments, {
    environment,
    workingDirectory,
    stdio: "inherit",
  });
  requireNpmSuccess(result, publishArguments);
}

export function assertExactDependency(packageJson, dependencyName) {
  const declared = packageJson.dependencies?.[dependencyName];
  if (typeof declared !== "string") {
    fail(`package must pin ${dependencyName} at an exact semantic version`);
  }
  try {
    return assertExactVersion(declared, `dependency ${dependencyName}`);
  } catch {
    fail(`package must pin ${dependencyName} at an exact semantic version`);
  }
}

function main(args) {
  const [command, ...values] = args;
  if (command === "exact-dependency" && values.length === 1) {
    assertExactDependency(readPackageJson(process.cwd()), values[0]);
    return;
  }
  if (command === "inspect" && values.length === 1) {
    inspectNpmRelease({ workflowPath: values[0] });
    return;
  }
  if (command === "publish" && values.length === 0) {
    publishNpmRelease();
    return;
  }
  fail("usage: npm-release.mjs exact-dependency <package-name> | inspect <workflow-path> | publish");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
