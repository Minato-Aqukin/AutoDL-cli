/**
 * Error taxonomy for AutoDL-cli.
 *
 * Every failure that reaches the CLI surface maps to exactly one exit code so that
 * agents can branch on the result without parsing prose. The codes are part of the
 * public contract — changing one is a breaking change.
 */

export const ExitCode = {
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  AUTH: 3,
  NOT_FOUND: 4,
  BUDGET: 5,
  NO_STOCK: 6,
  TIMEOUT: 7,
  SSH: 8,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** Machine-readable error codes surfaced in `--json` output. */
export type ErrorCode =
  | "GENERIC"
  | "USAGE"
  | "AUTH_MISSING"
  | "AUTH_INVALID"
  | "NOT_FOUND"
  | "INSUFFICIENT_BALANCE"
  | "GUARD_BLOCKED"
  | "NO_STOCK"
  | "TIMEOUT"
  | "SSH_FAILED"
  | "API_ERROR"
  | "NETWORK";

export interface AutoDLErrorOptions {
  code?: ErrorCode;
  exitCode?: ExitCode;
  /** Actionable next step shown to humans and handed to agents verbatim. */
  hint?: string;
  /** AutoDL's own `request_id`, invaluable when asking support about a failure. */
  requestId?: string;
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class AutoDLError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: ExitCode;
  readonly hint?: string;
  readonly requestId?: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: AutoDLErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AutoDLError";
    this.code = options.code ?? "GENERIC";
    this.exitCode = options.exitCode ?? ExitCode.GENERIC;
    this.hint = options.hint;
    this.requestId = options.requestId;
    this.details = options.details;
  }

  toJSON(): { code: ErrorCode; message: string; hint?: string; requestId?: string } {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.requestId ? { requestId: this.requestId } : {}),
    };
  }
}

export class AuthError extends AutoDLError {
  constructor(message: string, options: AutoDLErrorOptions = {}) {
    super(message, { code: "AUTH_INVALID", exitCode: ExitCode.AUTH, ...options });
    this.name = "AuthError";
  }
}

export class NotFoundError extends AutoDLError {
  constructor(message: string, options: AutoDLErrorOptions = {}) {
    super(message, { code: "NOT_FOUND", exitCode: ExitCode.NOT_FOUND, ...options });
    this.name = "NotFoundError";
  }
}

export class UsageError extends AutoDLError {
  constructor(message: string, options: AutoDLErrorOptions = {}) {
    super(message, { code: "USAGE", exitCode: ExitCode.USAGE, ...options });
    this.name = "UsageError";
  }
}

export class BudgetError extends AutoDLError {
  constructor(message: string, options: AutoDLErrorOptions = {}) {
    super(message, { code: "GUARD_BLOCKED", exitCode: ExitCode.BUDGET, ...options });
    this.name = "BudgetError";
  }
}

export class NoStockError extends AutoDLError {
  constructor(message: string, options: AutoDLErrorOptions = {}) {
    super(message, { code: "NO_STOCK", exitCode: ExitCode.NO_STOCK, ...options });
    this.name = "NoStockError";
  }
}

export class TimeoutError extends AutoDLError {
  constructor(message: string, options: AutoDLErrorOptions = {}) {
    super(message, { code: "TIMEOUT", exitCode: ExitCode.TIMEOUT, ...options });
    this.name = "TimeoutError";
  }
}

export class SSHError extends AutoDLError {
  constructor(message: string, options: AutoDLErrorOptions = {}) {
    super(message, { code: "SSH_FAILED", exitCode: ExitCode.SSH, ...options });
    this.name = "SSHError";
  }
}

/** Coerce anything thrown into an AutoDLError so the CLI always has an exit code. */
export function toAutoDLError(err: unknown): AutoDLError {
  if (err instanceof AutoDLError) return err;
  if (err instanceof Error) {
    return new AutoDLError(err.message, { cause: err });
  }
  return new AutoDLError(String(err));
}

/**
 * Whether a failure means "this token will not work", as opposed to a transient fault.
 *
 * Matched on the code rather than the class: an auth failure can be raised by the HTTP
 * layer or mapped out of a 200-with-error-code envelope, and callers that react to an
 * expired session — the TUI drops back to its login screen — must catch both.
 */
export function isAuthError(err: unknown): boolean {
  return err instanceof AutoDLError && (err.code === "AUTH_INVALID" || err.code === "AUTH_MISSING");
}
