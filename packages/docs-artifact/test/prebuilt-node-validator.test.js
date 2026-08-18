import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DIRECTORY_LIMITS_OVERRIDE, FILE_READ_RACE_HOOK } from "../src/node-internal.js";
import { validatePrebuiltArtifactDirectory } from "../src/prebuilt-node.js";

const execFileAsync = promisify(execFile);
const fixtureDirectory = new URL("../fixtures/prebuilt/valid/espalier/", import.meta.url);

async function temporaryFixture(testContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taproot-docs-prebuilt-"));
  testContext.after(() => rm(directory, { recursive: true, force: true }));
  await cp(fixtureDirectory, directory, { recursive: true });
  return directory;
}

test("prebuilt directory validation accepts the exact closed representative tree", async (testContext) => {
  const directory = await temporaryFixture(testContext);

  const result = await validatePrebuiltArtifactDirectory(directory);

  assert.equal(result.ok, true);
  assert.equal(result.value.fileCount, 14);
  assert.equal(result.value.totalBytes, 2247);
  assert.equal(result.value.files.every((file) => file.content instanceof Uint8Array), true);
  assert.equal(result.value.files.every((file) => file.content.buffer.byteLength === file.content.byteLength), true);
});

test("prebuilt directory validation stops at the bounded path envelope", async (testContext) => {
  const directory = await temporaryFixture(testContext);

  const result = await validatePrebuiltArtifactDirectory(directory, {
    [DIRECTORY_LIMITS_OVERRIDE]: { pathLength: 3 },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map(({ code, path: errorPath }) => ({ code, path: errorPath })), [{
    code: "path.too_long",
    path: "404.html",
  }]);
});

test("prebuilt directory validation rejects payload descendants of its manifest path", async (testContext) => {
  const directory = await temporaryFixture(testContext);
  const manifestPath = path.join(directory, "taproot-docs-prebuilt-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files[13].path = "taproot-docs-prebuilt-manifest.json/payload.js";
  await writeFile(manifestPath, JSON.stringify(manifest));

  const result = await validatePrebuiltArtifactDirectory(directory);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "path.manifest"));
});

test("validation CLI dispatches prebuilt mode explicitly", async (testContext) => {
  const directory = await temporaryFixture(testContext);
  const cli = fileURLToPath(new URL("../bin/taproot-docs-validate.js", import.meta.url));

  const { stdout } = await execFileAsync(process.execPath, [cli, "--mode", "prebuilt", "--json", directory]);
  const result = JSON.parse(stdout);

  assert.equal(result.ok, true);
  assert.equal(result.value.manifest.mode, "prebuilt");
});

test("prebuilt directory validation rejects undeclared files and directories", async (testContext) => {
  const directory = await temporaryFixture(testContext);
  await writeFile(path.join(directory, "extra.txt"), "extra\n");
  await mkdir(path.join(directory, "empty"));

  const result = await validatePrebuiltArtifactDirectory(directory);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "file.unexpected"));
  assert.ok(result.errors.some((error) => error.code === "directory.unexpected"));
});

test("prebuilt directory validation rejects symbolic links anywhere in the tree", async (testContext) => {
  const directory = await temporaryFixture(testContext);
  await symlink(path.join(directory, "index.html"), path.join(directory, "linked.html"));

  const result = await validatePrebuiltArtifactDirectory(directory);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "file.symlink"));
});

test("prebuilt directory validation rejects hard links anywhere in the tree", async (testContext) => {
  const directory = await temporaryFixture(testContext);
  await link(path.join(directory, "index.html"), path.join(directory, "linked.html"));

  const result = await validatePrebuiltArtifactDirectory(directory);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "file.hard_link"));
});

test("prebuilt directory validation cannot block on a FIFO payload", {
  skip: process.platform === "win32" ? "Windows does not provide mkfifo." : false,
}, async (testContext) => {
  const directory = await temporaryFixture(testContext);
  const file = path.join(directory, "assets", "site.js");
  await rm(file);
  await execFileAsync("mkfifo", [file]);

  const result = await validatePrebuiltArtifactDirectory(directory);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "file.not_regular"));
});

test("prebuilt directory validation cannot block when an enumerated payload becomes a FIFO", {
  skip: process.platform === "win32" ? "Windows does not provide mkfifo." : false,
}, async (testContext) => {
  const directory = await temporaryFixture(testContext);
  const validatorModule = new URL("../src/prebuilt-node.js", import.meta.url).href;
  const internalModule = new URL("../src/node-internal.js", import.meta.url).href;
  const script = `
    const { execFile } = await import("node:child_process");
    const { rm } = await import("node:fs/promises");
    const { promisify } = await import("node:util");
    const { validatePrebuiltArtifactDirectory } = await import(process.argv[1]);
    const { FILE_OPEN_RACE_HOOK } = await import(process.argv[2]);
    const execFileAsync = promisify(execFile);
    let replaced = false;
    const result = await validatePrebuiltArtifactDirectory(process.argv[3], {
      [FILE_OPEN_RACE_HOOK]: async (displayPath, absolutePath) => {
        if (displayPath !== "assets/site.js" || replaced) return;
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
    ["--input-type=module", "--eval", script, validatorModule, internalModule, directory],
    { timeout: 2_000, killSignal: "SIGKILL" },
  );

  assert.deepEqual(JSON.parse(stdout), {
    replaced: true,
    errors: [{
      code: "file.not_regular",
      path: "assets/site.js",
    }],
  });
});

test("prebuilt directory validation rejects an ancestor replacement race", async (testContext) => {
  const directory = await temporaryFixture(testContext);
  const assets = path.join(directory, "assets");
  const moved = path.join(directory, "moved-assets");
  let replaced = false;

  const result = await validatePrebuiltArtifactDirectory(directory, {
    [FILE_READ_RACE_HOOK]: async (displayPath) => {
      if (displayPath !== "assets/icons.svg" || replaced) return;
      await rename(assets, moved);
      await symlink(moved, assets);
      replaced = true;
    },
  });

  assert.equal(replaced, true);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "file.changed"));
});

test("prebuilt directory validation rejects a real parent replacement that reuses its child subtree", async (testContext) => {
  const directory = await temporaryFixture(testContext);
  const api = path.join(directory, "api");
  const movedApi = path.join(directory, "moved-api");
  const child = path.join(api, "show-toast");
  const file = path.join(child, "index.html");
  const parentBefore = await lstat(api, { bigint: true });
  const childBefore = await lstat(child, { bigint: true });
  const fileBefore = await lstat(file, { bigint: true });
  let replaced = false;

  const result = await validatePrebuiltArtifactDirectory(directory, {
    [FILE_READ_RACE_HOOK]: async (displayPath) => {
      if (displayPath !== "api/show-toast/index.html" || replaced) return;
      await rename(api, movedApi);
      await mkdir(api);
      await rename(path.join(movedApi, "show-toast"), child);
      await rm(movedApi, { recursive: true });
      replaced = true;
    },
  });

  const parentAfter = await lstat(api, { bigint: true });
  const childAfter = await lstat(child, { bigint: true });
  const fileAfter = await lstat(file, { bigint: true });
  assert.equal(replaced, true);
  assert.equal(parentBefore.dev === parentAfter.dev && parentBefore.ino === parentAfter.ino, false);
  assert.equal(childBefore.dev, childAfter.dev);
  assert.equal(childBefore.ino, childAfter.ino);
  assert.equal(fileBefore.dev, fileAfter.dev);
  assert.equal(fileBefore.ino, fileAfter.ino);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "file.changed"));
});

test("prebuilt directory validation compares real directory identities across both walks", async (testContext) => {
  const directory = await temporaryFixture(testContext);
  const api = path.join(directory, "api");
  const movedApi = path.join(directory, "moved-api");
  const child = path.join(api, "show-toast");
  const file = path.join(child, "index.html");
  const parentBefore = await lstat(api, { bigint: true });
  const childBefore = await lstat(child, { bigint: true });
  const fileBefore = await lstat(file, { bigint: true });
  let replaced = false;

  const result = await validatePrebuiltArtifactDirectory(directory, {
    [FILE_READ_RACE_HOOK]: async (displayPath) => {
      if (displayPath !== "pagefind/pagefind.js" || replaced) return;
      await rename(api, movedApi);
      await mkdir(api);
      await rename(path.join(movedApi, "show-toast"), child);
      await rm(movedApi, { recursive: true });
      replaced = true;
    },
  });

  const parentAfter = await lstat(api, { bigint: true });
  const childAfter = await lstat(child, { bigint: true });
  const fileAfter = await lstat(file, { bigint: true });
  assert.equal(replaced, true);
  assert.equal(parentBefore.dev === parentAfter.dev && parentBefore.ino === parentAfter.ino, false);
  assert.equal(childBefore.dev, childAfter.dev);
  assert.equal(childBefore.ino, childAfter.ino);
  assert.equal(fileBefore.dev, fileAfter.dev);
  assert.equal(fileBefore.ino, fileAfter.ino);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "directory.changed"));
});

test("prebuilt directory validation compares regular file identities across both walks", async (testContext) => {
  const directory = await temporaryFixture(testContext);
  const replacementDirectory = await mkdtemp(path.join(os.tmpdir(), "taproot-docs-prebuilt-replacement-"));
  testContext.after(() => rm(replacementDirectory, { recursive: true, force: true }));
  const file = path.join(directory, "index.html");
  const replacement = path.join(replacementDirectory, "index.html");
  await cp(file, replacement);
  const fileBefore = await lstat(file, { bigint: true });
  let replaced = false;

  const result = await validatePrebuiltArtifactDirectory(directory, {
    [FILE_READ_RACE_HOOK]: async (displayPath) => {
      if (displayPath !== "pagefind/pagefind.js" || replaced) return;
      await rm(file);
      await rename(replacement, file);
      replaced = true;
    },
  });

  const fileAfter = await lstat(file, { bigint: true });
  assert.equal(replaced, true);
  assert.equal(fileBefore.dev === fileAfter.dev && fileBefore.ino === fileAfter.ino, false);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "directory.changed"));
});
