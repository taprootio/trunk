import type { ValidationResult } from "./index.js";
import type { PrebuiltValidationOptions, ValidatedPrebuiltArtifact } from "./prebuilt.js";

export function validatePrebuiltArtifactDirectory(
  rootDirectory: string,
  options?: PrebuiltValidationOptions,
): Promise<ValidationResult<ValidatedPrebuiltArtifact>>;
