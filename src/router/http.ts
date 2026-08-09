/**
 * Shared transport for every wire shape.
 *
 * Three providers previously each had their own copy of "fetch, check `ok`,
 * classify". Centralising it means a transport-level fix — the in-body error
 * handling below, abort classification, header merging — lands for all of them
 * by construction rather than by remembering to patch three files.
 */

import {
  CancelledError,
  LLMError,
  TimeoutError,
  classifyBodyError,
  classifyHttpError,
  type ErrorDetails,
} from "./errors.ts";

export interface HttpPostParams {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
  /** Which response header carries the provider's request id, if any. */
  requestIdHeaders?: string[];
}

const DEFAULT_REQUEST_ID_HEADERS = ["request-id", "x-request-id", "x-amzn-requestid", "cf-ray"];

/** Marker set by the router on the signal it owns, so aborts can be attributed. */
export const TIMEOUT_REASON = Symbol.for("ai-execution-router.timeout");

export interface TimeoutSignalReason {
  [TIMEOUT_REASON]: true;
  timeoutMs: number;
}

function isTimeoutReason(reason: unknown): reason is TimeoutSignalReason {
  return typeof reason === "object" && reason !== null && TIMEOUT_REASON in reason;
}

/**
 * Turn an aborted fetch into the right error.
 *
 * A deadline and a caller cancellation are both `AbortError` at the fetch
 * boundary but mean opposite things to a controller: one is worth retrying,
 * the other was an explicit instruction to stop.
 */
export function classifyAbort(err: unknown, signal: AbortSignal | undefined): LLMError | undefined {
  const aborted = signal?.aborted === true || (err as { name?: string })?.name === "AbortError";
  if (!aborted) return undefined;
  const reason = signal?.reason;
  if (isTimeoutReason(reason)) return new TimeoutError(reason.timeoutMs, err);
  return new CancelledError(undefined, err);
}

function readRequestId(response: Response, candidates: string[]): string | undefined {
  for (const name of candidates) {
    const value = response.headers.get(name);
    if (value) return value;
  }
  return undefined;
}

interface ProviderErrorPayload {
  message: string;
  code?: string;
  status?: number;
}

/**
 * Extract a provider error from an `error` field, or `undefined` if there isn't
 * a real one there.
 *
 * Mere presence of the key is not enough. Several OpenAI-compatible servers and
 * proxies always include `error`, populating it only on failure, so treating
 * `{"error": {}}` as a failure would throw away perfectly good completions.
 */
function readProviderError(err: unknown): ProviderErrorPayload | undefined {
  if (err === null || err === undefined) return undefined;
  if (typeof err === "string") return err.trim() ? { message: err } : undefined;
  if (typeof err !== "object") return { message: String(err) };

  const o = err as { message?: unknown; code?: unknown; type?: unknown; status?: unknown };
  const message = typeof o.message === "string" ? o.message.trim() : "";
  const rawCode = o.code ?? o.type;
  const code = typeof rawCode === "string" && rawCode.trim() ? rawCode : undefined;
  if (!message && !code) return undefined;

  return {
    message: message || code || "unknown provider error",
    code,
    status: typeof o.status === "number" ? o.status : undefined,
  };
}

/**
 * An error delivered inside a 200 response.
 *
 * Any proxy that must beat an upstream idle timeout — a Cloudflare Tunnel
 * avoiding a 524, a keep-alive shim in front of a slow CLI — commits to a 200
 * and flushes headers before the backend has finished. A late backend failure
 * then arrives in the body of an otherwise successful response. Without this
 * check it reads as an empty completion, which is far worse than an error: it
 * looks like the model had nothing to say.
 */
function throwIfBodyError(json: unknown, details: ErrorDetails): void {
  if (typeof json !== "object" || json === null) return;
  const payload = readProviderError((json as { error?: unknown }).error);
  if (!payload) return;
  throw bodyError(payload, json, details);
}

function bodyError(payload: ProviderErrorPayload, cause: unknown, details: ErrorDetails): LLMError {
  const err = classifyBodyError(
    `provider returned an error in a successful response: ${payload.message}`,
    {
      ...details,
      status: payload.status ?? details.status,
      providerCode: payload.code ?? details.providerCode,
      body: details.body ?? safeStringify(cause),
    },
  );
  return err;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

async function readErrorResponse(response: Response, requestId: string | undefined): Promise<never> {
  const text = await response.text().catch(() => "");
  let providerCode: string | undefined;
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; type?: string; message?: string } };
    providerCode = parsed.error?.code ?? parsed.error?.type;
  } catch {
    // Not JSON — the raw text is all the detail there is.
  }
  throw classifyHttpError(
    response.status,
    response.headers.get("retry-after") ?? undefined,
    text || response.statusText,
    undefined,
    { status: response.status, body: text, providerCode, requestId },
  );
}

/** POST JSON, parse JSON. Throws a typed `LLMError` for every failure mode. */
export async function postJson<T>(p: HttpPostParams): Promise<{ json: T; requestId?: string }> {
  const response = await doFetch(p);
  const requestId = readRequestId(response, p.requestIdHeaders ?? DEFAULT_REQUEST_ID_HEADERS);
  if (!response.ok) await readErrorResponse(response, requestId);

  const raw = await response.text();
  let json: T;
  try {
    json = JSON.parse(raw) as T;
  } catch (err) {
    throw classifyHttpError(502, undefined, "provider returned a non-JSON body", err, {
      status: 502,
      body: raw,
      requestId,
    });
  }
  throwIfBodyError(json, { status: response.status, requestId });
  return { json, requestId };
}

export interface SseStream {
  /** Read from the response headers, before any frame is consumed. */
  requestId?: string;
  frames: AsyncGenerator<unknown, void, void>;
}

/**
 * POST JSON, then stream a `text/event-stream` response.
 *
 * Returns the request id alongside the frames rather than only yielding frames:
 * an endpoint that reports its id in a header and not in the payload would
 * otherwise lose it on every streamed call, leaving the record unreconcilable
 * against the provider's billing.
 */
export async function openSse(p: HttpPostParams): Promise<SseStream> {
  const response = await doFetch(p);
  const requestId = readRequestId(response, p.requestIdHeaders ?? DEFAULT_REQUEST_ID_HEADERS);
  if (!response.ok) await readErrorResponse(response, requestId);
  if (!response.body) {
    throw classifyHttpError(502, undefined, "provider returned no body for a streaming request", undefined, {
      status: 502,
      requestId,
    });
  }
  return { requestId, frames: readFrames(response.body, p.signal, requestId) };
}

async function* readFrames(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  requestId: string | undefined,
): AsyncGenerator<unknown, void, void> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";

  /**
   * A provider error can also arrive mid-stream, as a frame.
   *
   * Same trap as the buffered case and the same consequence: the stream simply
   * stops, the accumulated text is returned, and a truncated or empty answer
   * is reported as a success. Anthropic sends `{"type":"error","error":{…}}`;
   * OpenAI-compatible servers send a bare `{"error":{…}}`.
   */
  const check = (payload: unknown): void => {
    if (typeof payload !== "object" || payload === null) return;
    const providerError = readProviderError((payload as { error?: unknown }).error);
    if (!providerError) return;
    throw bodyError(providerError, payload, { requestId });
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by a blank line; tolerate CRLF.
      let boundary: number;
      while ((boundary = findEventBoundary(buffer)) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^(\r?\n){2}/, "");
        const data = parseSseData(rawEvent);
        if (data === undefined) continue;
        if (data === "[DONE]") return;
        let payload: unknown;
        try {
          payload = JSON.parse(data);
        } catch {
          // A malformed frame mid-stream is not worth failing the whole call
          // over; the terminating event still decides success.
          continue;
        }
        check(payload);
        yield payload;
      }
    }
    // Some servers close without a trailing blank line — flush whatever is left.
    const tail = parseSseData(buffer);
    if (tail !== undefined && tail !== "[DONE]") {
      try {
        const payload = JSON.parse(tail);
        check(payload);
        yield payload;
      } catch (err) {
        if (err instanceof LLMError) throw err;
        // Trailing partial frame: ignore.
      }
    }
  } catch (err) {
    const aborted = classifyAbort(err, signal);
    if (aborted) throw aborted;
    if (err instanceof LLMError) throw err;
    throw classifyHttpError(undefined, undefined, `stream read failed: ${errMessage(err)}`, err, { requestId });
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function findEventBoundary(buffer: string): number {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

/** Concatenate the `data:` lines of one SSE event. Returns undefined for comment-only frames. */
function parseSseData(rawEvent: string): string | undefined {
  const parts: string[] = [];
  for (const line of rawEvent.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    parts.push(line.slice(5).replace(/^ /, ""));
  }
  if (parts.length === 0) return undefined;
  return parts.join("\n");
}

async function doFetch(p: HttpPostParams): Promise<Response> {
  try {
    return await fetch(p.url, {
      method: "POST",
      headers: p.headers,
      body: JSON.stringify(p.body),
      signal: p.signal,
    });
  } catch (err) {
    const aborted = classifyAbort(err, p.signal);
    if (aborted) throw aborted;
    throw classifyHttpError(undefined, undefined, errMessage(err), err);
  }
}

function errMessage(err: unknown): string {
  return String((err as Error)?.message ?? err ?? "network error");
}

/** Merge caller headers over the wire shape's own. Caller wins, deliberately. */
export function mergeHeaders(
  base: Record<string, string>,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  if (!extra) return base;
  return { ...base, ...extra };
}

/** True when the caller supplied their own `authorization` header, in any casing. */
export function hasCallerAuth(extra: Record<string, string> | undefined): boolean {
  return Object.keys(extra ?? {}).some((k) => k.toLowerCase() === "authorization");
}

/** Classify reported token counts without ever inventing a number. */
export function tokenSourceOf(prompt: number | undefined, completion: number | undefined) {
  const hasPrompt = typeof prompt === "number";
  const hasCompletion = typeof completion === "number";
  if (hasPrompt && hasCompletion) return "provider" as const;
  if (hasPrompt || hasCompletion) return "partial" as const;
  return "unreported" as const;
}
