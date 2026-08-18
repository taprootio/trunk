#!/usr/bin/env node

import { validateArtifactDirectory } from "../src/node.js";
import { validatePrebuiltArtifactDirectory } from "../src/prebuilt-node.js";

const arguments_ = process.argv.slice(2);
const json = arguments_.includes("--json");
const modeIndex = arguments_.indexOf("--mode");
const mode = modeIndex === -1 ? "managed" : arguments_[modeIndex + 1];
const positional = arguments_.filter((argument, index) => (
  argument !== "--json" && argument !== "--mode" && (modeIndex === -1 || index !== modeIndex + 1)
));
const invalidArguments = arguments_.filter((argument) => argument === "--mode").length > 1
  || arguments_.filter((argument) => argument === "--json").length > 1
  || positional.length > 1
  || positional.some((argument) => argument.startsWith("--"));
if (!["managed", "prebuilt"].includes(mode) || invalidArguments) {
  process.stderr.write("Usage: taproot-docs-validate [--json] [--mode managed|prebuilt] [directory]\n");
  process.exitCode = 2;
} else {
  const directory = positional[0] ?? process.cwd();
  const result = mode === "prebuilt"
    ? await validatePrebuiltArtifactDirectory(directory)
    : await validateArtifactDirectory(directory);

  if (json) {
    const output = mode === "prebuilt" && result.ok
      ? {
        ok: true,
        value: {
          manifest: result.value.manifest,
          fileCount: result.value.fileCount,
          totalBytes: result.value.totalBytes,
        },
      }
      : result;
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else if (result.ok) {
    if (mode === "prebuilt") {
      process.stdout.write(
        `Valid Taproot Docs prebuilt artifact: ${result.value.fileCount} payload files, ${result.value.totalBytes} bytes.\n`,
      );
    } else {
      process.stdout.write(
        `Valid Taproot Docs artifact: ${result.value.fileCount} semantic files, ${result.value.totalBytes} bytes.\n`,
      );
    }
  } else {
    for (const error of result.errors) process.stderr.write(`${error.code} ${error.path}: ${error.message}\n`);
  }
  process.exitCode = result.ok ? 0 : 1;
}
