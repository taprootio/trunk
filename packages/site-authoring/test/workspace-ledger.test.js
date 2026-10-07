import assert from "node:assert/strict";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { enforceWorkspaceReads, ledgerDigest, recordWorkspaceReads } from "../src/workspace-ledger.js";
import {
  deleteWorkspaceFile,
  inspectWorkspaceEntry,
  readWorkspaceFile,
  walkWorkspaceFiles,
  workspaceFileExists,
  writeWorkspaceFile,
} from "../src/workspace.js";

async function workspace(context, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "taproot-ledger-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, contents] of Object.entries(files)) await writeWorkspaceFile(root, file, contents);
  return root;
}

async function refusedNaming(action, field, code = "apply.plan_stale") {
  await assert.rejects(action, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.field, field);
    return true;
  });
}

test("a read the plan made passes unchanged, and refuses once the file changed", async (context) => {
  const root = await workspace(context, { "nav.json": "{}" });
  const { ledger } = await recordWorkspaceReads(() => readWorkspaceFile(root, "nav.json", 1024));

  await enforceWorkspaceReads(ledger, () => readWorkspaceFile(root, "nav.json", 1024));
  await writeFile(path.join(root, "nav.json"), "{ }");
  await refusedNaming(() => enforceWorkspaceReads(ledger, () => readWorkspaceFile(root, "nav.json", 1024)), "nav.json");
});

test("a read the plan never made is refused", async (context) => {
  const root = await workspace(context, { "nav.json": "{}", "redirects.json": "{}" });
  const { ledger } = await recordWorkspaceReads(() => readWorkspaceFile(root, "nav.json", 1024));

  await refusedNaming(
    () => enforceWorkspaceReads(ledger, () => readWorkspaceFile(root, "redirects.json", 1024)),
    "redirects.json",
  );
});

test("a file apply writes is read back as written, and an outside edit after that is refused", async (context) => {
  const root = await workspace(context, { ".taproot-site-media.json": "{}" });
  const { ledger } = await recordWorkspaceReads(() => readWorkspaceFile(root, ".taproot-site-media.json", 1024));

  await enforceWorkspaceReads(ledger, async () => {
    await writeWorkspaceFile(root, ".taproot-site-media.json", "{\"media\":{}}");
    await readWorkspaceFile(root, ".taproot-site-media.json", 1024);
    await writeFile(path.join(root, ".taproot-site-media.json"), "{\"media\":{\"x\":1}}");
    await refusedNaming(() => readWorkspaceFile(root, ".taproot-site-media.json", 1024), ".taproot-site-media.json");
  });
});

test("a directory listing must match the plan's, apart from what apply itself wrote or removed", async (context) => {
  const root = await workspace(context, { "pages/a.md": "a", "pages/b.md": "b" });
  const walk = () => walkWorkspaceFiles(root, "pages", [".md"]);
  const { ledger } = await recordWorkspaceReads(walk);

  await enforceWorkspaceReads(ledger, async () => {
    await writeWorkspaceFile(root, "pages/c.md", "c");
    await deleteWorkspaceFile(root, "pages/a.md");
    await walk();
  });
  // A new apply starts from the plan's listing again: c.md was not in it.
  await refusedNaming(() => enforceWorkspaceReads(ledger, walk), "pages/c.md");
  await unlink(path.join(root, "pages/c.md"));
  await refusedNaming(() => enforceWorkspaceReads(ledger, walk), "pages/a.md");
  await writeFile(path.join(root, "pages/a.md"), "a");
  await writeFile(path.join(root, "pages/late.md"), "late");
  await refusedNaming(() => enforceWorkspaceReads(ledger, walk), "pages/late.md");
});

test("whether a file exists, and what it is, must match the plan's answer or follow from a read it made", async (context) => {
  const root = await workspace(context, { "redirects.json": "{}", "nav.json": "{}" });
  const { ledger } = await recordWorkspaceReads(async () => {
    await workspaceFileExists(root, "redirects.json");
    await readWorkspaceFile(root, "nav.json", 1024);
  });

  await enforceWorkspaceReads(ledger, async () => {
    // Implied by the read of nav.json.
    assert.equal(await workspaceFileExists(root, "nav.json"), true);
    assert.equal(await inspectWorkspaceEntry(root, "nav.json"), "file");
  });
  await unlink(path.join(root, "redirects.json"));
  await refusedNaming(
    () => enforceWorkspaceReads(ledger, () => workspaceFileExists(root, "redirects.json")),
    "redirects.json",
  );
});

test("a file that changes while it is being planned is refused, and the ledger digest follows the reads", async (context) => {
  const root = await workspace(context, { "nav.json": "{}" });
  await refusedNaming(() =>
    recordWorkspaceReads(async () => {
      await readWorkspaceFile(root, "nav.json", 1024);
      await writeFile(path.join(root, "nav.json"), "{ }");
      await readWorkspaceFile(root, "nav.json", 1024);
    }), "nav.json", "plan.workspace_changed");

  const first = ledgerDigest((await recordWorkspaceReads(() => readWorkspaceFile(root, "nav.json", 1024))).ledger);
  await writeFile(path.join(root, "nav.json"), "{}");
  const second = ledgerDigest((await recordWorkspaceReads(() => readWorkspaceFile(root, "nav.json", 1024))).ledger);
  assert.notEqual(first, second);
});
