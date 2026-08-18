import type { ArtifactFileEntry } from "./index.js";
import type { ValidationResult } from "./index.js";
import type { ValidatedPrebuiltArtifact } from "./prebuilt.js";

export interface PrebuiltNodeConformanceScenario {
  type: "replace-file-with-directory-before-open";
  path: string;
}

export interface PrebuiltArtifactConformanceCase {
  name: string;
  valid: boolean;
  expectedCodes: string[];
  manifest: Uint8Array;
  files: ArtifactFileEntry[];
  nodeScenario?: PrebuiltNodeConformanceScenario;
  expectedArchive?: {
    bytes: Uint8Array;
    byteLength: number;
    sha256: `sha256:${string}`;
  };
}

export function loadPrebuiltConformanceCases(): Promise<PrebuiltArtifactConformanceCase[]>;
export function validatePrebuiltConformanceCase(
  fixture: PrebuiltArtifactConformanceCase,
): Promise<ValidationResult<ValidatedPrebuiltArtifact>>;
