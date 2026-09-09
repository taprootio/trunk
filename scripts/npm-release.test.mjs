import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runnerPath = fileURLToPath(new URL("./npm-release.mjs", import.meta.url));
const workflowPath = ".github/workflows/publish-docs-artifact.yml";
const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const otherIntegrity = `sha512-${Buffer.alloc(64, 2).toString("base64")}`;

function createFakeNpm(directory) {
  const executable = join(directory, "npm");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPM_LOG, \`${"${JSON.stringify(args)}"}\\n\`);
const scenario = process.env.FAKE_NPM_SCENARIO;
const integrity = ${JSON.stringify(integrity)};
const otherIntegrity = ${JSON.stringify(otherIntegrity)};

function fail(code) {
  process.stderr.write(\`npm error code \${code}\\n\`);
  process.exitCode = 1;
}

if (args[0] === "view" && args[2] === "versions") {
  if (scenario === "missing") fail("E404");
  else if (scenario === "registry-error") fail("E503");
  else if (scenario === "malformed-versions") process.stdout.write("not json");
  else if (scenario === "superseded-version") process.stdout.write(JSON.stringify(["1.1.0"]));
  else process.stdout.write(JSON.stringify(["0.9.0"]));
} else if (args[0] === "view" && args[2] === "dist.integrity") {
  if (scenario === "missing") fail("E404");
  else if (scenario === "integrity-error") fail("E503");
  else if (scenario === "invalid-integrity") process.stdout.write("sha512-YQ==\\n");
  else process.stdout.write(\`${"${scenario === \"integrity-drift\" ? otherIntegrity : integrity}"}\\n\`);
} else if (args[0] === "pack") {
  if (scenario === "pack-error") fail("E500");
  else process.stdout.write(JSON.stringify([{ integrity }]));
} else if (args[0] === "install") {
  if (scenario === "install-error") fail("E500");
  else process.stdout.write("ok\\n");
} else if (args[0] === "--prefix" && args[2] === "audit") {
  if (scenario === "audit-error") {
    fail("E500");
  } else {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: "https://github.com/taprootio/trunk",
            path: scenario === "mismatched-provenance" ? ".github/workflows/publish-docs-publisher.yml" : process.env.FAKE_WORKFLOW_PATH,
            ref: \`refs/tags/\${process.env.GITHUB_REF_NAME}\`,
          },
        },
        internalParameters: { github: { event_name: "push" } },
        resolvedDependencies: [{
          uri: \`git+https://github.com/taprootio/trunk@refs/tags/\${process.env.GITHUB_REF_NAME}\`,
          digest: { gitCommit: process.env.GITHUB_SHA },
        }],
      },
      runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } },
    },
  };
  process.stdout.write(JSON.stringify({
    padding: scenario === "large-audit" ? "x".repeat(2 * 1024 * 1024) : undefined,
    invalid: scenario === "bad-audit" ? [{}] : [],
    missing: [],
    verified: [{
      name: "@taprootio/docs-artifact",
      version: "1.0.0",
      attestationBundles: [{ bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") } } }],
    }],
  }));
  }
} else if (args[0] === "publish") {
  if (scenario === "publish-error") fail("E500");
  else {
    if (scenario === "large-publish") {
      process.stdout.write("x".repeat(2 * 1024 * 1024));
      process.stderr.write("y".repeat(2 * 1024 * 1024));
    }
    process.stdout.write("published-spec\\n");
    process.stderr.write("provenance-notice\\n");
  }
} else {
  fail("E999");
}
`,
  );
  chmodSync(executable, 0o755);
}

function releaseTree(testContext, { dependency = "1.1.0" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "taproot-npm-release-"));
  testContext.after(() => rmSync(root, { recursive: true, force: true }));
  const packageDirectory = join(root, "package");
  const runnerTemp = join(root, "runner-temp");
  const binaryDirectory = join(root, "bin");
  mkdirSync(packageDirectory, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  mkdirSync(binaryDirectory, { recursive: true });
  writeFileSync(
    join(packageDirectory, "package.json"),
    `${JSON.stringify({
      name: "@taprootio/docs-artifact",
      version: "1.0.0",
      repository: { url: "https://github.com/taprootio/trunk.git" },
      dependencies: { "@taprootio/docs-artifact": dependency },
    }, null, 2)}\n`,
  );
  const logPath = join(root, "npm-commands.jsonl");
  createFakeNpm(binaryDirectory);
  return { binaryDirectory, logPath, packageDirectory, root, runnerTemp };
}

function runRunner(tree, args, scenario = "existing") {
  const outputPath = join(tree.root, "github-output");
  const result = spawnSync(process.execPath, [runnerPath, ...args], {
    cwd: tree.packageDirectory,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      FAKE_NPM_LOG: tree.logPath,
      FAKE_NPM_SCENARIO: scenario,
      FAKE_WORKFLOW_PATH: workflowPath,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REF_NAME: "docs-artifact-v1.0.0",
      GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
      PATH: `${tree.binaryDirectory}:${process.env.PATH}`,
      RUNNER_TEMP: tree.runnerTemp,
    },
  });
  return { ...result, outputPath };
}

function npmCommands(tree) {
  try {
    return readFileSync(tree.logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

test("the release CLI shares exact dependency grammar", (testContext) => {
  const tree = releaseTree(testContext);
  const success = runRunner(tree, ["exact-dependency", "@taprootio/docs-artifact"]);
  assert.equal(success.status, 0, success.stderr);

  writeFileSync(
    join(tree.packageDirectory, "package.json"),
    `${JSON.stringify({ dependencies: { "@taprootio/docs-artifact": "^1.1.0" } }, null, 2)}\n`,
  );
  const failure = runRunner(tree, ["exact-dependency", "@taprootio/docs-artifact"]);
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /must pin @taprootio\/docs-artifact at an exact semantic version/u);
});

test("a missing package is eligible for publication and publication preserves lifecycle-script suppression", (testContext) => {
  const tree = releaseTree(testContext);
  const inspection = runRunner(tree, ["inspect", workflowPath], "missing");

  assert.equal(inspection.status, 0, inspection.stderr);
  assert.equal(readFileSync(inspection.outputPath, "utf8"), "should_publish=true\n");
  assert.deepEqual(npmCommands(tree).map((args) => args.slice(0, 3)), [
    ["view", "@taprootio/docs-artifact", "versions"],
    ["view", "@taprootio/docs-artifact@1.0.0", "dist.integrity"],
  ]);

  const publication = runRunner(tree, ["publish"], "missing");
  assert.equal(publication.status, 0, publication.stderr);
  assert.deepEqual(npmCommands(tree).at(-1), ["publish", "--access", "public", "--provenance", "--ignore-scripts"]);
});

test("an identical retry requires matching integrity and verified npm provenance", (testContext) => {
  const tree = releaseTree(testContext);
  const inspection = runRunner(tree, ["inspect", workflowPath]);

  assert.equal(inspection.status, 0, inspection.stderr);
  assert.equal(readFileSync(inspection.outputPath, "utf8"), "should_publish=false\n");
  const commands = npmCommands(tree);
  assert.ok(commands.some((args) => args[0] === "pack" && args.includes("--ignore-scripts")));
  assert.ok(commands.some((args) => args[0] === "install" && args.includes("--ignore-scripts") && args.includes("--registry")));
  assert.ok(commands.some((args) => args[2] === "audit" && args.includes("signatures") && args.includes("--registry")));
  assert.equal(commands.some((args) => args[0] === "publish"), false);
});

test("registry, integrity, provenance, and command failures fail closed", (testContext) => {
  for (const [scenario, command, expectedError] of [
    ["registry-error", ["inspect", workflowPath], /npm view @taprootio\/docs-artifact versions/u],
    ["malformed-versions", ["inspect", workflowPath], /published versions response was not valid JSON/u],
    ["superseded-version", ["inspect", workflowPath], /precedes already-published 1\.1\.0/u],
    ["integrity-error", ["inspect", workflowPath], /npm view @taprootio\/docs-artifact@1\.0\.0 dist\.integrity/u],
    ["invalid-integrity", ["inspect", workflowPath], /published package integrity must be a SHA-512/u],
    ["pack-error", ["inspect", workflowPath], /npm pack --json/u],
    ["integrity-drift", ["inspect", workflowPath], /already exists with a different package integrity/u],
    ["install-error", ["inspect", workflowPath], /npm install --prefix/u],
    ["audit-error", ["inspect", workflowPath], /npm --prefix .* audit signatures/u],
    ["bad-audit", ["inspect", workflowPath], /invalid or missing registry signature or attestation/u],
    ["mismatched-provenance", ["inspect", workflowPath], /verified provenance does not bind/u],
    ["publish-error", ["publish"], /npm publish --access public --provenance --ignore-scripts/u],
  ]) {
    const tree = releaseTree(testContext);
    const result = runRunner(tree, command, scenario);
    assert.equal(result.status, 1, `${scenario} unexpectedly passed`);
    assert.match(result.stderr, expectedError, scenario);
  }
});


test("successful publication preserves both output streams beyond the default capture limit", (testContext) => {
  const tree = releaseTree(testContext);
  const result = runRunner(tree, ["publish"], "large-publish");
  assert.equal(result.status, 0, result.error?.message ?? result.stderr.slice(-200));
  assert.equal(result.stdout, `${"x".repeat(2 * 1024 * 1024)}published-spec\n`);
  assert.equal(result.stderr, `${"y".repeat(2 * 1024 * 1024)}provenance-notice\n`);
});

test("an identical retry can verify an attestation response larger than one MiB", (testContext) => {
  const tree = releaseTree(testContext);
  const result = runRunner(tree, ["inspect", workflowPath], "large-audit");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(result.outputPath, "utf8"), "should_publish=false\n");
});
