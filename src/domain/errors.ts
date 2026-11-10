export type DomainErrorCode =
  | "invalid_argument"
  | "not_found"
  | "conflict"
  | "invalid_state_transition"
  | "scope_violation"
  | "unsupported_capability"
  | "invalid_parameter"
  | "context_overflow"
  | "permission_denied";

export interface DomainErrorDetails {
  readonly [key: string]: unknown;
}

/**
 * A renderer-safe error produced by a domain invariant. Details must never
 * contain credentials, raw auth headers, or other secret values.
 */
export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: DomainErrorDetails;

  constructor(code: DomainErrorCode, message: string, details: DomainErrorDetails = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function assertDomain(
  condition: unknown,
  code: DomainErrorCode,
  message: string,
  details: DomainErrorDetails = {},
): asserts condition {
  if (!condition) {
    throw new DomainError(code, message, details);
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
