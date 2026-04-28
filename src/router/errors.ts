export class LLMError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "LLMError";
    this.cause = cause;
  }
}

export class RateLimitError extends LLMError {
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number, cause?: unknown) {
    super(message, cause);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class TransientError extends LLMError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "TransientError";
  }
}

export class PermanentError extends LLMError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "PermanentError";
  }
}

export class AuthError extends LLMError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "AuthError";
  }
}

export function classifyHttpError(
  status: number | undefined,
  retryAfterHeader: string | undefined,
  message: string,
  cause?: unknown,
): LLMError {
  if (status === 401 || status === 403) {
    return new AuthError(message, cause);
  }
  if (status === 429) {
    return new RateLimitError(message, parseRetryAfter(retryAfterHeader), cause);
  }
  if (status === 400 || status === 404 || status === 422) {
    return new PermanentError(message, cause);
  }
  if (status !== undefined && status >= 500) {
    return new TransientError(message, cause);
  }
  if (status === undefined) {
    return new TransientError(message, cause);
  }
  return new LLMError(message, cause);
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}
