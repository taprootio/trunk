import type { ArtifactFileEntry } from "./index.js";

export interface DocsArtifactConformanceCase {
  name: string;
  valid: boolean;
  expectedCodes: string[];
  manifest: Uint8Array;
  files: ArtifactFileEntry[];
}

export function loadConformanceCases(): Promise<DocsArtifactConformanceCase[]>;
