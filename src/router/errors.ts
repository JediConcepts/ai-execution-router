/**
 * Typed errors.
 *
 * A governance kernel that collapses a provider's failure into a bare message
 * forces its caller to reconstruct the details by regex. Every error here
 * therefore carries the HTTP `status`, the provider's own error `code`, a
 * truncated `body`, and the provider's `requestId` where one was returned —
 * the fields a controller needs to decide "retry, fail over, or stop" and the
 * fields an audit trail needs to reconcile against a vendor invoice.
 *
 * Classification is deliberately conservative: an error is only promoted out of
 * a generic class when the provider gave us something unambiguous to promote it
 * on. Guessing here would be policy.
 */

/** Provider-reported context attached to every error the router throws. */
export interface ErrorDetails {
  /** HTTP status, when the failure came from a response. */
  status?: number;
  /** The provider's own machine-readable error code, when it supplied one. */
  providerCode?: string;
  /** Truncated response body, for diagnosis. Never parsed for control flow by the router. */
  body?: string;
  /** The provider's request id, for reconciling against their logs and billing. */
  requestId?: string;
}

const BODY_SNIPPET_LIMIT = 2000;

export class LLMError extends Error {
  readonly cause?: unknown;
  readonly status?: number;
  readonly providerCode?: string;
  readonly body?: string;
  readonly requestId?: string;

  constructor(message: string, cause?: unknown, details: ErrorDetails = {}) {
    super(message);
    this.name = "LLMError";
    this.cause = cause;
    this.status = details.status;
    this.providerCode = details.providerCode;
    this.body = details.body?.slice(0, BODY_SNIPPET_LIMIT);
    this.requestId = details.requestId;
  }
}

/**
 * A transient rate limit — the same request may succeed shortly.
 *
 * Distinct from `QuotaExhaustedError`: both arrive as HTTP 429, but only this
 * one is worth waiting out.
 */
export class RateLimitError extends LLMError {
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number, cause?: unknown, details: ErrorDetails = {}) {
    super(message, cause, details);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class TransientError extends LLMError {
  constructor(message: string, cause?: unknown, details: ErrorDetails = {}) {
    super(message, cause, details);
    this.name = "TransientError";
  }
}

export class PermanentError extends LLMError {
  constructor(message: string, cause?: unknown, details: ErrorDetails = {}) {
    super(message, cause, details);
    this.name = "PermanentError";
  }
}

export class AuthError extends LLMError {
  constructor(message: string, cause?: unknown, details: ErrorDetails = {}) {
    super(message, cause, details);
    this.name = "AuthError";
  }
}

/**
 * Billing or free-tier quota is spent — permanent for the life of this request.
 *
 * Extends `PermanentError`, not `RateLimitError`, and that inheritance is the
 * whole point: a controller that backs off on a 429 will burn a full quota
 * window before failing over, when the correct move was to fail over
 * immediately. Both conditions are HTTP 429; only the body distinguishes them.
 */
export class QuotaExhaustedError extends PermanentError {
  constructor(message: string, cause?: unknown, details: ErrorDetails = {}) {
    super(message, cause, details);
    this.name = "QuotaExhaustedError";
  }
}

/**
 * The request exceeded the model's context window.
 *
 * Worth its own type because it is the one permanent failure a controller can
 * often route around unchanged — a larger-context candidate may accept the
 * identical payload.
 */
export class ContextLengthError extends PermanentError {
  constructor(message: string, cause?: unknown, details: ErrorDetails = {}) {
    super(message, cause, details);
    this.name = "ContextLengthError";
  }
}

/** The model id is unknown, retired, or not enabled for this account. */
export class ModelUnavailableError extends PermanentError {
  constructor(message: string, cause?: unknown, details: ErrorDetails = {}) {
    super(message, cause, details);
    this.name = "ModelUnavailableError";
  }
}

/**
 * The caller asked for something this wire shape cannot express.
 *
 * The router fails closed rather than dropping the parameter: a request that
 * silently loses its JSON constraint or its reasoning budget still returns a
 * plausible-looking completion, and nothing downstream can tell that the
 * governing instruction was discarded.
 */
export class UnsupportedCapabilityError extends PermanentError {
  readonly capability: string;
  readonly wireShape: string;
  constructor(capability: string, wireShape: string, hint?: string) {
    super(
      `Wire shape "${wireShape}" cannot express "${capability}"` +
        (hint ? `. ${hint}` : ". Remove the parameter or route to a wire shape that supports it."),
    );
    this.name = "UnsupportedCapabilityError";
    this.capability = capability;
    this.wireShape = wireShape;
  }
}

/** The request exceeded `timeoutMs`. Transient: the same call may succeed on a retry. */
export class TimeoutError extends TransientError {
  readonly timeoutMs: number;
  constructor(timeoutMs: number, cause?: unknown) {
    super(`Request aborted after ${timeoutMs}ms timeout`, cause);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** The caller's `signal` aborted the request. Never retried — the caller asked to stop. */
export class CancelledError extends LLMError {
  constructor(message = "Request cancelled by caller", cause?: unknown) {
    super(message, cause);
    this.name = "CancelledError";
  }
}

/**
 * Free-tier and billing exhaustion, as distinct from a per-minute rate limit.
 *
 * Both surface as 429. The patterns below are the ones observed in production
 * across OpenAI-compatible tiers (Gemini AI Studio daily quota, OpenAI
 * `insufficient_quota`, OpenRouter credit messages). Exported for testing.
 */
export function isQuotaExhaustion(body: string, providerCode?: string): boolean {
  if (providerCode && /insufficient_quota|quota_exceeded|billing/i.test(providerCode)) return true;
  return /exceeded your current quota|check your plan and billing|insufficient[_ ]quota|quota exceeded|billing details|daily limit|out of credits|credit balance/i.test(
    body,
  );
}

/** Context-window overflow, reported differently by every provider. Exported for testing. */
export function isContextOverflow(body: string, providerCode?: string): boolean {
  if (providerCode && /context_length_exceeded|prompt_too_long/i.test(providerCode)) return true;
  return /context[_ ]length[_ ]exceeded|prompt is too long|prompt_too_long|maximum context length|input token count|exceeds the maximum number of tokens|too many tokens/i.test(
    body,
  );
}

/**
 * An unknown, retired, or unentitled model id. Exported for testing.
 *
 * The gap between "model" and the verdict is bounded by newline rather than by
 * `[^.]`, which is what an earlier version used and which quietly failed on every
 * model whose name contains a dot — `gemini-2.5-flash`, `claude-4.6`, `gpt-5.4`.
 * The bound existed to stop a match running across sentences; excluding dots
 * excluded the identifiers this predicate is entirely about. Found by the first
 * live call ever made through this router.
 */
export function isModelUnavailable(body: string, providerCode?: string): boolean {
  if (providerCode && /model_not_found|model_unavailable|NOT_FOUND/i.test(providerCode)) return true;
  return /model[^\n]{0,80}?(not found|does not exist|no longer available|is unavailable|not supported|is not allowed|has been (deprecated|retired))|unknown model|invalid model|model_not_found/i.test(
    body,
  );
}

/**
 * Map an HTTP failure onto the taxonomy.
 *
 * Status alone is not enough — 429 is both "slow down" and "you are out of
 * credit", and 400 is both "malformed" and "too many tokens" — so the body is
 * inspected for the three conditions whose remedy genuinely differs. Everything
 * unrecognised stays in its generic class rather than being guessed at.
 */
export function classifyHttpError(
  status: number | undefined,
  retryAfterHeader: string | undefined,
  message: string,
  cause?: unknown,
  details: ErrorDetails = {},
): LLMError {
  const d: ErrorDetails = { ...details, status: details.status ?? status };
  const haystack = `${message} ${d.body ?? ""}`;

  if (status === 401 || status === 403) {
    return new AuthError(message, cause, d);
  }

  // Spent credit is not tied to one status, and assuming it was is a mistake this
  // made until a live call with an empty balance proved otherwise. It arrives as
  // 429 (rate-limit-shaped), as 402 (payment required), and as 400 — Anthropic
  // returns "Your credit balance is too low" with a 400, which without this check
  // is indistinguishable from a malformed request. So the body decides, and the
  // status only bounds where we bother looking.
  if (status !== undefined && status >= 400 && status < 500) {
    if (isQuotaExhaustion(haystack, d.providerCode)) {
      return new QuotaExhaustedError(message, cause, d);
    }
  }

  // 402 is the standard "you owe money" status; OpenRouter and others use it.
  if (status === 402) {
    return new QuotaExhaustedError(message, cause, d);
  }

  if (status === 429) {
    // Past the exhaustion check above, a 429 is a per-minute limit: worth waiting out.
    return new RateLimitError(message, parseRetryAfter(retryAfterHeader), cause, d);
  }

  if (status === 400 || status === 404 || status === 422) {
    if (isContextOverflow(haystack, d.providerCode)) return new ContextLengthError(message, cause, d);
    if (isModelUnavailable(haystack, d.providerCode)) return new ModelUnavailableError(message, cause, d);
    return new PermanentError(message, cause, d);
  }

  if (status !== undefined && status >= 500) {
    return new TransientError(message, cause, d);
  }

  if (status === undefined) {
    return new TransientError(message, cause, d);
  }

  return new LLMError(message, cause, d);
}

/**
 * Classify an error the provider put in the body rather than in the status line.
 *
 * There is no meaningful status to classify on here — a proxy that already
 * committed to HTTP 200 has thrown that channel away — so the three conditions
 * whose remedy differs are matched on the message directly, before falling back
 * to whatever status the payload claimed.
 *
 * Without this, a spent-quota message delivered in a 200 body would be reported
 * as transient, and a controller would back off and retry an endpoint that has
 * nothing left to give: exactly the failure `QuotaExhaustedError` exists to stop.
 */
export function classifyBodyError(message: string, details: ErrorDetails = {}): LLMError {
  const haystack = `${message} ${details.body ?? ""}`;
  if (isQuotaExhaustion(haystack, details.providerCode)) {
    return new QuotaExhaustedError(message, undefined, details);
  }
  if (isContextOverflow(haystack, details.providerCode)) {
    return new ContextLengthError(message, undefined, details);
  }
  if (isModelUnavailable(haystack, details.providerCode)) {
    return new ModelUnavailableError(message, undefined, details);
  }
  if (typeof details.status === "number" && details.status >= 400) {
    return classifyHttpError(details.status, undefined, message, undefined, details);
  }
  // A late failure behind a committed 200 is most often an upstream giving up.
  return new TransientError(message, undefined, details);
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
