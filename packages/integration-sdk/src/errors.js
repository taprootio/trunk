/** A safe, machine-readable rejection from a public integration contract. */
export class IntegrationSdkError extends Error {
  constructor(code, message = code, options = {}) {
    super(message, options);
    this.name = "IntegrationSdkError";
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** The HTTP response from Taproot was valid HTTP but not a successful API result. */
export class IntegrationApiError extends IntegrationSdkError {
  constructor(status, code = "api_error", message = "Taproot rejected the request.", details) {
    super(code, message, { status, details });
    this.name = "IntegrationApiError";
  }
}
