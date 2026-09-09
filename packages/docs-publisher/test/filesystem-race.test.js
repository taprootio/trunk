import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { readInspectedConfigFile } from "../src/config.js";
import { appendInspectedGithubOutput } from "../src/output.js";

const makeFifo = promisify(execFile);
const supportsFifos = process.platform !== "win32" && fsConstants.O_NONBLOCK !== undefined;

async function replacedByFifo(testContext, name) {
  const root = await mkdtemp(path.join(os.tmpdir(), "taproot-docs-publisher-race-"));
  testContext.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, name);
  await writeFile(filePath, "regular file\n");
  const inspectedStats = await lstat(filePath, { bigint: true });
  await rm(filePath);
  await makeFifo("mkfifo", [filePath]);
  return { filePath, inspectedStats };
}

test("a config regular-file to FIFO race fails closed without blocking", {
  skip: !supportsFifos,
  timeout: 2_000,
}, async (testContext) => {
  const { filePath, inspectedStats } = await replacedByFifo(testContext, "config.json");
  await assert.rejects(
    readInspectedConfigFile(filePath, inspectedStats),
    (error) => error?.code === "config.changed",
  );
});

test("a GITHUB_OUTPUT regular-file to FIFO race fails closed without blocking", {
  skip: !supportsFifos,
  timeout: 2_000,
}, async (testContext) => {
  const { filePath, inspectedStats } = await replacedByFifo(testContext, "github-output");
  const fifoReader = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    await assert.rejects(
      appendInspectedGithubOutput(filePath, inspectedStats, "result\n"),
      (error) => error?.code === "output.github_changed",
    );
  } finally {
    await fifoReader.close();
  }
});
