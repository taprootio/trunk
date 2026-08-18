import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FILE_OPEN_RACE_HOOK } from "./node-internal.js";
import { validatePrebuiltArtifact } from "./prebuilt-artifact-validator.js";
import { PREBUILT_LIMITS } from "./prebuilt-constants.js";
import { serializePrebuiltManifest } from "./prebuilt-manifest-validator.js";
import { validatePrebuiltArtifactDirectory } from "./prebuilt-node.js";

const FIXTURES_ROOT = new URL("../fixtures/", import.meta.url);

function targetAt(root, segments) {
  let target = root;
  for (let index = 0; index < segments.length - 1; index += 1) target = target[segments[index]];
  return { target, key: segments.at(-1) };
}

function applyMutations(manifest, mutations = []) {
  for (const mutation of mutations) {
    const { target, key } = targetAt(manifest, mutation.path);
    if (mutation.operation === "repeat-array") {
      const source = target[key][mutation.sourceIndex];
      target[key] = Array.from({ length: mutation.count }, () => structuredClone(source));
      continue;
    }
    const value = mutation.repeat === undefined
      ? structuredClone(mutation.value)
      : `${mutation.repeat.repeat(mutation.count)}${mutation.suffix ?? ""}`;
    if (mutation.operation === "append") target[key].push(value);
    else if (mutation.operation === "remove") target.splice(key, 1);
    else if (mutation.operation === "replace") target[key] = value;
    else throw new Error(`Unsupported prebuilt conformance mutation '${mutation.operation}'.`);
  }
}

async function baseFiles(manifest, baseManifest, omitted = []) {
  const directory = baseManifest.slice(0, baseManifest.lastIndexOf("/") + 1);
  const files = [];
  for (const descriptor of manifest.files) {
    if (omitted.includes(descriptor.path)) continue;
    files.push({
      path: descriptor.path,
      content: await readFile(new URL(`${directory}${descriptor.path}`, FIXTURES_ROOT)),
    });
  }
  return files;
}

async function specifiedFiles(specifications = []) {
  const result = [];
  for (const specification of specifications) {
    let content;
    if (specification.source) content = await readFile(new URL(specification.source, FIXTURES_ROOT));
    else if (specification.base64 !== undefined) content = Buffer.from(specification.base64, "base64");
    else content = Buffer.from(specification.utf8 ?? "", "utf8");
    result.push({ path: specification.path, content });
  }
  return result;
}

async function expectedArchive(specification) {
  if (!specification) return undefined;
  return {
    bytes: await readFile(new URL(specification.path, FIXTURES_ROOT)),
    byteLength: specification.byteLength,
    sha256: specification.sha256,
  };
}

export async function loadPrebuiltConformanceCases() {
  const index = JSON.parse(await readFile(new URL("prebuilt/conformance.json", FIXTURES_ROOT), "utf8"));
  if (index.schemaVersion !== 1 || !Array.isArray(index.cases)) {
    throw new Error("Unsupported prebuilt conformance fixture index.");
  }
  const cases = [];
  for (const fixture of index.cases) {
    let manifest;
    let manifestValue;
    if (fixture.baseManifest) {
      manifestValue = JSON.parse(await readFile(new URL(fixture.baseManifest, FIXTURES_ROOT), "utf8"));
      applyMutations(manifestValue, fixture.mutations);
      manifest = Buffer.from(JSON.stringify(manifestValue));
    } else {
      manifest = await readFile(new URL(fixture.manifest, FIXTURES_ROOT));
    }
    const files = [
      ...(fixture.includeBaseFiles ? await baseFiles(manifestValue, fixture.baseManifest, fixture.omitBaseFiles) : []),
      ...await specifiedFiles(fixture.files),
    ];
    if (fixture.manifestPaddingBytes) {
      manifest = Buffer.concat([
        manifest,
        Buffer.alloc(Math.min(fixture.manifestPaddingBytes, PREBUILT_LIMITS.manifestBytes + 1), 0x20),
      ]);
    }
    cases.push({
      name: fixture.name,
      valid: fixture.valid,
      expectedCodes: fixture.expectedCodes,
      manifest,
      files,
      nodeScenario: fixture.nodeScenario === undefined ? undefined : structuredClone(fixture.nodeScenario),
      expectedArchive: await expectedArchive(fixture.archive),
    });
  }
  return cases;
}

async function materializeDirectory(root, manifest, files) {
  await writeFile(path.join(root, "taproot-docs-prebuilt-manifest.json"), manifest);
  for (const file of files) {
    const target = path.join(root, ...file.path.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
}

export async function validatePrebuiltConformanceCase(fixture) {
  if (fixture.nodeScenario === undefined) {
    return validatePrebuiltArtifact(fixture.manifest, fixture.files);
  }
  if (fixture.nodeScenario.type !== "replace-file-with-directory-before-open") {
    throw new Error(`Unsupported prebuilt Node conformance scenario '${fixture.nodeScenario.type}'.`);
  }
  const semanticResult = await validatePrebuiltArtifact(fixture.manifest, fixture.files);
  if (!semanticResult.ok) return semanticResult;
  if (!semanticResult.value.files.some((file) => file.path === fixture.nodeScenario.path)) {
    throw new Error("The prebuilt Node conformance scenario must target a declared payload file.");
  }

  const root = await mkdtemp(path.join(tmpdir(), "taproot-docs-prebuilt-conformance-"));
  try {
    await materializeDirectory(
      root,
      serializePrebuiltManifest(semanticResult.value.manifest),
      semanticResult.value.files,
    );
    let replaced = false;
    const options = {
      [FILE_OPEN_RACE_HOOK]: async (displayPath, absolutePath) => {
        if (replaced || displayPath !== fixture.nodeScenario.path) return;
        replaced = true;
        await rm(absolutePath);
        await mkdir(absolutePath);
      },
    };
    return await validatePrebuiltArtifactDirectory(root, options);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
