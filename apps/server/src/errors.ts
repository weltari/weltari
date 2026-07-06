// The one Result convention and the three error kinds (Guide §0.5, C1).
// operational: expected failure of something we don't control -> retry/return err
// bug: our code broke its own contract -> throw, reaches fatal()
// corrupt_state: durable rows contradict an invariant -> throw, fatal() exits 3

export type ErrorKind = 'operational' | 'bug' | 'corrupt_state';

export class AppError extends Error {
  readonly kind: ErrorKind;
  readonly code: string;

  constructor(
    kind: ErrorKind,
    code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AppError';
    this.kind = kind;
    this.code = code;
  }
}

export class OperationalError extends AppError {
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super('operational', code, message, options);
    this.name = 'OperationalError';
  }
}

export class BugError extends AppError {
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super('bug', code, message, options);
    this.name = 'BugError';
  }
}

export class CorruptStateError extends AppError {
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super('corrupt_state', code, message, options);
    this.name = 'CorruptStateError';
  }
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T>(error: AppError): Result<T> {
  return { ok: false, error };
}
