import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Compression bytes can differ between release runtimes. A registry lock is
// accepted only after checking its immutable identity, then comparing the
// installed package files with the local tarball (assertEquivalentSdkFiles).
export async function selectSdkInstallSource(pack, installedPin, fetchImpl = fetch) {
  if (installedPin?.version !== pack.version) throw new Error("SDK version mismatch.");
  const resolved = new URL(installedPin.resolved);
  if (resolved.origin !== "https://registry.npmjs.org" || resolved.username || resolved.password) {
    throw new Error("The SDK lock must resolve to the public npm registry.");
  }
  if (installedPin.integrity === pack.integrity) return "packed";
  const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(pack.name)}/${encodeURIComponent(pack.version)}`, {
    redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("SDK integrity mismatch: no verified registry release; repack with the release runtime.");
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error("Registry metadata exceeds its byte limit.");
    chunks.push(chunk);
  }
  const metadata = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (metadata.name !== pack.name || metadata.version !== pack.version ||
      metadata.dist?.integrity !== installedPin.integrity || metadata.dist?.tarball !== installedPin.resolved) {
    throw new Error("SDK registry identity differs from the committed lock; re-lock and release a new template version.");
  }
  return "registry";
}

function packageFiles(directory, prefix = "") {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap((entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error("SDK packages must not contain symbolic links.");
    return entry.isDirectory() ? packageFiles(directory, name) : [name];
  }).sort();
}

export function assertEquivalentSdkFiles(localDirectory, registryDirectory) {
  const files = packageFiles(localDirectory);
  if (JSON.stringify(files) !== JSON.stringify(packageFiles(registryDirectory)) ||
      files.some((file) => !readFileSync(join(localDirectory, file)).equals(readFileSync(join(registryDirectory, file))))) {
    throw new Error("Published SDK contents differ from this same-version source; bump the SDK version.");
  }
}
