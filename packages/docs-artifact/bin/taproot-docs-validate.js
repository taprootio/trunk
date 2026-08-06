#!/usr/bin/env node

import { validateArtifactDirectory } from "../src/node.js";

const arguments_ = process.argv.slice(2);
const json = arguments_.includes("--json");
const directory = arguments_.find((argument) => argument !== "--json") ?? process.cwd();
const result = await validateArtifactDirectory(directory);

if (json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else if (result.ok) {
  process.stdout.write(`Valid Taproot Docs artifact: ${result.value.fileCount} semantic files, ${result.value.totalBytes} bytes.\n`);
} else {
  for (const error of result.errors) process.stderr.write(`${error.code} ${error.path}: ${error.message}\n`);
}
process.exitCode = result.ok ? 0 : 1;
