import type { ValidatedArtifact, ValidationOptions, ValidationResult } from "./index.js";

export function validateArtifactDirectory(
  rootDirectory: string,
  options?: ValidationOptions,
): Promise<ValidationResult<ValidatedArtifact>>;
export const validateManagedArtifactDirectory: typeof validateArtifactDirectory;
