import type { PrebuiltValidationOptions, ValidatedPrebuiltArtifact } from "./prebuilt.js";

export { DocsArtifactValidationError } from "./index.js";

export interface DeterministicPrebuiltArchive {
  readonly format: "taproot-docs-prebuilt-tar-gzip-v1";
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly contentHash: `sha256:${string}`;
}

export class PrebuiltArchiveError extends Error {
  readonly code: string;
  readonly field?: string;
  constructor(code: string, message: string, field?: string);
}

/**
 * Encodes an isolated snapshot returned by `validatePrebuiltArtifact` or
 * `validatePrebuiltArtifactDirectory` into the frozen prebuilt archive format.
 * Throws `PrebuiltArchiveError` for inventory, size, or hash faults and
 * `DocsArtifactValidationError` when the snapshot manifest fails revalidation.
 */
export function createDeterministicPrebuiltArchive(
  snapshot: ValidatedPrebuiltArtifact,
  options?: PrebuiltValidationOptions,
): DeterministicPrebuiltArchive;
