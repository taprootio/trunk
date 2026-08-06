import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { LIMITS } from "../src/constants.js";
import { DIRECTORY_LIMITS_OVERRIDE, FILE_READ_RACE_HOOK } from "../src/node-internal.js";
import { validateArtifactDirectory } from "../src/node.js";

const fixtureDirectory = new URL("../fixtures/valid/minimal/", import.meta.url);
const execFileAsync = promisify(execFile);

test("directory validation consumes only the semantic payload beside portable static output", async (testContext) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "taproot-docs-artifact-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await cp(fixtureDirectory, temporaryDirectory, { recursive: true });
  await writeFile(path.join(temporaryDirectory, "index.html"), "<!doctype html><title>Portable site</title>\n");
  await writeFile(path.join(temporaryDirectory, "site.js"), "console.log('ordinary static output');\n");

  const result = await validateArtifactDirectory(temporaryDirectory);

  assert.equal(result.ok, true);
  assert.equal(result.value.fileCount, 1);
  assert.equal(result.value.totalBytes, 37);
});

test("directory validation rejects a manifest FIFO without waiting for a reader", {
  skip: process.platform === "win32" ? "Windows does not provide mkfifo." : false,
}, async (testContext) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "taproot-docs-artifact-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await cp(fixtureDirectory, temporaryDirectory, { recursive: true });
  const manifestPath = path.join(temporaryDirectory, "taproot-docs-manifest.json");
  await rm(manifestPath);
  await execFileAsync("mkfifo", [manifestPath]);

  const validatorModule = new URL("../src/node.js", import.meta.url).href;
  const script = `
    const { validateArtifactDirectory } = await import(process.argv[1]);
    const result = await validateArtifactDirectory(process.argv[2]);
    process.stdout.write(JSON.stringify(result.errors.map(({ code, path }) => ({ code, path }))));
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", script, validatorModule, temporaryDirectory],
    { timeout: 2_000, killSignal: "SIGKILL" },
  );

  assert.deepEqual(JSON.parse(stdout), [{
    code: "file.not_regular",
    path: "taproot-docs-manifest.json",
  }]);
});

test("directory validation cannot block when an enumerated semantic file becomes a FIFO", {
  skip: process.platform === "win32" ? "Windows does not provide mkfifo." : false,
}, async (testContext) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "taproot-docs-artifact-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await cp(fixtureDirectory, temporaryDirectory, { recursive: true });

  const validatorModule = new URL("../src/node.js", import.meta.url).href;
  const internalModule = new URL("../src/node-internal.js", import.meta.url).href;
  const script = `
    const { execFile } = await import("node:child_process");
    const { rm } = await import("node:fs/promises");
    const { promisify } = await import("node:util");
    const { validateArtifactDirectory } = await import(process.argv[1]);
    const { FILE_OPEN_RACE_HOOK } = await import(process.argv[2]);
    const execFileAsync = promisify(execFile);
    let replaced = false;
    const result = await validateArtifactDirectory(process.argv[3], {
      [FILE_OPEN_RACE_HOOK]: async (displayPath, absolutePath) => {
        if (displayPath !== "taproot-docs/fragments/welcome.html") return;
        await rm(absolutePath);
        await execFileAsync("mkfifo", [absolutePath]);
        replaced = true;
      },
    });
    process.stdout.write(JSON.stringify({
      replaced,
      errors: result.errors.map(({ code, path }) => ({ code, path })),
    }));
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", script, validatorModule, internalModule, temporaryDirectory],
    { timeout: 2_000, killSignal: "SIGKILL" },
  );

  assert.deepEqual(JSON.parse(stdout), {
    replaced: true,
    errors: [{
      code: "file.not_regular",
      path: "taproot-docs/fragments/welcome.html",
    }],
  });
});

test("directory validation snapshots a one-shot supported-capability generator once", async (testContext) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "taproot-docs-artifact-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await cp(fixtureDirectory, temporaryDirectory, { recursive: true });
  const manifestPath = path.join(temporaryDirectory, "taproot-docs-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const additionalCapability = "taproot.docs.generator-regression.v1";
  manifest.capabilities.required.push(additionalCapability);
  manifest.capabilities.required.sort();
  await writeFile(manifestPath, JSON.stringify(manifest));
  function* supportedCapabilities() {
    yield additionalCapability;
  }

  const result = await validateArtifactDirectory(temporaryDirectory, {
    supportedCapabilities: supportedCapabilities(),
  });

  assert.equal(result.ok, true);
});

test("directory validation rejects a scalar supported-capabilities string before iteration", async (testContext) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "taproot-docs-artifact-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await cp(fixtureDirectory, temporaryDirectory, { recursive: true });
  const manifestPath = path.join(temporaryDirectory, "taproot-docs-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.capabilities.required.push("a");
  manifest.capabilities.required.sort();
  await writeFile(manifestPath, JSON.stringify(manifest));

  const result = await validateArtifactDirectory(temporaryDirectory, { supportedCapabilities: "a" });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{
    code: "capability.invalid_iterable",
    path: "$options.supportedCapabilities",
    message: "Could not enumerate supported capabilities safely.",
  }]);
});

test("directory validation bounds and sanitizes supported-capability iteration", async (testContext) => {
  await testContext.test("entry ceiling", async () => {
    const supportedCapabilities = Array.from(
      { length: LIMITS.supportedCapabilities + 1 },
      (_, index) => `taproot.docs.option-${index}.v1`,
    );
    const result = await validateArtifactDirectory(".", { supportedCapabilities });

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((error) => error.code), ["limit.supported_capabilities"]);
  });
  await testContext.test("iterator failure", async () => {
    const sensitiveMessage = "do not expose this iterator failure";
    function* supportedCapabilities() {
      throw new Error(sensitiveMessage);
    }
    const result = await validateArtifactDirectory(".", {
      supportedCapabilities: supportedCapabilities(),
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((error) => error.code), ["capability.invalid_iterable"]);
    assert.ok(result.errors.every((error) => !error.message.includes(sensitiveMessage)));
  });
  await testContext.test("invalid values", async () => {
    const sensitiveMessage = "do not inspect hostile capability values";
    const hostile = Object.create(null);
    Object.defineProperty(hostile, "toString", {
      get() {
        throw new Error(sensitiveMessage);
      },
    });
    const values = ["a".repeat(LIMITS.resourceKey + 1), "Taproot Docs", hostile];
    for (const value of values) {
      const result = await validateArtifactDirectory(".", { supportedCapabilities: [value] });
      assert.equal(result.ok, false);
      assert.deepEqual(result.errors, [{
        code: "capability.invalid_value",
        path: "$options.supportedCapabilities",
        message: `Supported capabilities must be canonical strings of at most ${LIMITS.resourceKey} characters.`,
      }]);
      assert.ok(result.errors.every((error) => !error.message.includes(sensitiveMessage)));
    }
  });
});

test("directory validation rejects undeclared regular files inside the managed subtree", async (testContext) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "taproot-docs-artifact-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await cp(fixtureDirectory, temporaryDirectory, { recursive: true });
  await writeFile(path.join(temporaryDirectory, "taproot-docs", "fragments", "undeclared.html"), "<p>Extra</p>\n");

  const result = await validateArtifactDirectory(temporaryDirectory);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "file.unexpected"));
});

test("directory validation rejects symbolic links anywhere inside the managed subtree", async (testContext) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "taproot-docs-artifact-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await cp(fixtureDirectory, temporaryDirectory, { recursive: true });
  await symlink(
    path.join(temporaryDirectory, "taproot-docs", "fragments", "welcome.html"),
    path.join(temporaryDirectory, "taproot-docs", "linked.html"),
  );

  const result = await validateArtifactDirectory(temporaryDirectory);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "file.symlink"));
});

test("directory validation rejects an ancestor replaced with a symlink after a file read", async (testContext) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "taproot-docs-artifact-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await cp(fixtureDirectory, temporaryDirectory, { recursive: true });
  const fragmentsPath = path.join(temporaryDirectory, "taproot-docs", "fragments");
  const movedFragmentsPath = path.join(temporaryDirectory, "taproot-docs", "moved-fragments");
  let replaced = false;

  const result = await validateArtifactDirectory(temporaryDirectory, {
    [FILE_READ_RACE_HOOK]: async (displayPath) => {
      if (displayPath !== "taproot-docs/fragments/welcome.html" || replaced) return;
      await rename(fragmentsPath, movedFragmentsPath);
      await symlink(movedFragmentsPath, fragmentsPath);
      replaced = true;
    },
  });

  assert.equal(replaced, true);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "file.changed"));
});

test("directory validation rejects a file path replaced with a symlink after its handle read", async (testContext) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "taproot-docs-artifact-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await cp(fixtureDirectory, temporaryDirectory, { recursive: true });
  const fragmentPath = path.join(temporaryDirectory, "taproot-docs", "fragments", "welcome.html");
  const movedFragmentPath = path.join(temporaryDirectory, "taproot-docs", "fragments", "welcome-original.html");
  let replaced = false;

  const result = await validateArtifactDirectory(temporaryDirectory, {
    [FILE_READ_RACE_HOOK]: async (displayPath) => {
      if (displayPath !== "taproot-docs/fragments/welcome.html" || replaced) return;
      await rename(fragmentPath, movedFragmentPath);
      await symlink(movedFragmentPath, fragmentPath);
      replaced = true;
    },
  });

  assert.equal(replaced, true);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "file.changed"));
});

test("directory validation rejects an undeclared file added after the final declared-file read", async (testContext) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "taproot-docs-artifact-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await cp(fixtureDirectory, temporaryDirectory, { recursive: true });
  const extraPath = path.join(temporaryDirectory, "taproot-docs", "fragments", "late-extra.html");
  let added = false;

  const result = await validateArtifactDirectory(temporaryDirectory, {
    [FILE_READ_RACE_HOOK]: async (displayPath) => {
      if (displayPath !== "taproot-docs/fragments/welcome.html" || added) return;
      await writeFile(extraPath, "<p>Late extra</p>\n");
      added = true;
    },
  });

  assert.equal(added, true);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "directory.changed"));
});

test("directory validation rejects a directory where the manifest declares a regular file", async (testContext) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "taproot-docs-artifact-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await cp(fixtureDirectory, temporaryDirectory, { recursive: true });
  const fragmentPath = path.join(temporaryDirectory, "taproot-docs", "fragments", "welcome.html");
  await rm(fragmentPath);
  await mkdir(fragmentPath);

  const result = await validateArtifactDirectory(temporaryDirectory);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "file.not_regular"));
});

test("directory validation stops after the regular-file ceiling is exceeded", async (testContext) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "taproot-docs-artifact-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await cp(fixtureDirectory, temporaryDirectory, { recursive: true });
  await writeFile(path.join(temporaryDirectory, "taproot-docs", "extra-a.html"), "a");
  await writeFile(path.join(temporaryDirectory, "taproot-docs", "extra-b.html"), "b");

  const result = await validateArtifactDirectory(temporaryDirectory, {
    [DIRECTORY_LIMITS_OVERRIDE]: {
      entries: 20,
      files: 2,
      depth: 10,
      pathLength: 512,
    },
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "limit.files"));
});

test("directory validation counts directories toward the total-entry ceiling", async (testContext) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "taproot-docs-artifact-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await cp(fixtureDirectory, temporaryDirectory, { recursive: true });
  await mkdir(path.join(temporaryDirectory, "taproot-docs", "empty-a"));
  await mkdir(path.join(temporaryDirectory, "taproot-docs", "empty-b"));
  await mkdir(path.join(temporaryDirectory, "taproot-docs", "empty-c"));

  const result = await validateArtifactDirectory(temporaryDirectory, {
    [DIRECTORY_LIMITS_OVERRIDE]: {
      entries: 2,
      files: 20,
      depth: 10,
      pathLength: 512,
    },
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "limit.directory_entries"));
});

test("directory validation counts unsupported entries toward the total-entry ceiling", async (testContext) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "taproot-docs-artifact-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await cp(fixtureDirectory, temporaryDirectory, { recursive: true });
  const target = path.join(temporaryDirectory, "taproot-docs-manifest.json");
  await symlink(target, path.join(temporaryDirectory, "taproot-docs", "linked-a"));
  await symlink(target, path.join(temporaryDirectory, "taproot-docs", "linked-b"));
  await symlink(target, path.join(temporaryDirectory, "taproot-docs", "linked-c"));

  const result = await validateArtifactDirectory(temporaryDirectory, {
    [DIRECTORY_LIMITS_OVERRIDE]: {
      entries: 4,
      files: 20,
      depth: 10,
      pathLength: 512,
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), ["limit.directory_entries"]);
});

test("directory validation rejects many declared-tiny sparse files from stat data before reading", async (testContext) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "taproot-docs-artifact-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await cp(fixtureDirectory, temporaryDirectory, { recursive: true });
  const manifestPath = path.join(temporaryDirectory, "taproot-docs-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const fragments = manifest.resources[0].variants[0].fragments;
  const sparseFileCount = 64;
  for (let index = 0; index < sparseFileCount; index += 1) {
    const suffix = String(index).padStart(2, "0");
    const relativePath = `taproot-docs/fragments/sparse-${suffix}.html`;
    fragments.push({
      key: `example-${suffix}`,
      role: "example",
      path: relativePath,
      mediaType: "text/html; charset=utf-8",
      bytes: 1,
      sha256: "sha256:2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
    });
    const absolutePath = path.join(temporaryDirectory, ...relativePath.split("/"));
    await writeFile(absolutePath, "x");
    await truncate(absolutePath, LIMITS.fragmentBytes);
  }
  await writeFile(manifestPath, JSON.stringify(manifest));

  const result = await validateArtifactDirectory(temporaryDirectory);

  assert.equal(result.ok, false);
  assert.equal(result.errors.filter((error) => error.code === "file.size_drift").length, sparseFileCount);
  assert.ok(!result.errors.some((error) => error.code === "file.hash_drift"));
});

test("directory diagnostics escape hostile filename controls", async (testContext) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "taproot-docs-artifact-"));
  testContext.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await cp(fixtureDirectory, temporaryDirectory, { recursive: true });
  await writeFile(path.join(temporaryDirectory, "taproot-docs", "hostile\n\u202e.html"), "x");

  const result = await validateArtifactDirectory(temporaryDirectory);

  assert.equal(result.ok, false);
  const diagnostic = result.errors.find((error) => error.code === "file.unexpected");
  assert.ok(diagnostic);
  assert.ok(!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(`${diagnostic.path}${diagnostic.message}`));
  assert.match(diagnostic.path, /\\u000a/);
  assert.match(diagnostic.path, /\\u202e/);
});
