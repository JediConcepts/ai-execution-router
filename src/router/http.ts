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
  MalformedResponseError,
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

/**
 * Headers that carry a *provider's* request id.
 *
 * `cf-ray` used to be on this list and should not have been: it is a Cloudflare
 * edge trace id, not the model provider's id, and OpenRouter, Groq and most
 * self-hosted endpoints sit behind Cloudflare while reporting their own id only
 * in the body. Preferring it meant `providerRequestId` — documented as the key
 * for invoice reconciliation — held a value that appears on no invoice.
 */
const DEFAULT_REQUEST_ID_HEADERS = ["request-id", "x-request-id", "x-amzn-requestid"];

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
  // `false` and `0` are how a server that always emits the key spells "no error
  // here" when it does not use `{}`. Stringifying them threw away an
  // already-billed completion and sent the controller off to retry a call that
  // had just succeeded.
  if (typeof err !== "object") return err ? { message: String(err) } : undefined;

  const o = err as { message?: unknown; code?: unknown; type?: unknown; status?: unknown };
  const message = typeof o.message === "string" ? o.message.trim() : "";
  const rawCode = o.code ?? o.type;
  const code = typeof rawCode === "string" && rawCode.trim() ? rawCode : undefined;

  if (!message && !code) {
    // Neither field, but the object is not empty: this is still a real failure
    // wearing an unfamiliar shape. FastAPI and vLLM send `{"detail": …}`, some
    // gateways `{"reason": …}` or a numeric `{"code": 503}`. Returning undefined
    // for those swallowed the failure and reported an empty completion — the one
    // outcome this whole path exists to prevent. Only the empty-object idiom,
    // which is what "no error here" actually looks like, means no error.
    if (Object.keys(o as object).length === 0) return undefined;
    const serialised = safeStringify(err);
    if (!serialised || serialised === "{}") return undefined;
    return { message: serialised.slice(0, 300) };
  }

  return {
    message: message || (code as string),
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

async function readErrorResponse(
  response: Response,
  requestId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<never> {
  let text = "";
  try {
    text = await response.text();
  } catch (err) {
    // A deadline that expires while the error body is being read is still a
    // deadline. Swallowing it here reported the original status instead, so a
    // timeout against a slow 503 surfaced as a plain TransientError.
    const aborted = classifyAbort(err, signal);
    if (aborted) throw aborted;
  }
  // Prefer the provider's own message over the raw envelope. A thrown error
  // whose `.message` is 400 characters of JSON is unreadable everywhere it
  // surfaces — logs, test output, a controller's skip log — and the full body is
  // still carried on `.body` for anyone who wants it.
  let providerCode: string | undefined;
  let message = text || response.statusText;
  try {
    const parsed = JSON.parse(text) as {
      error?: { code?: string | number; status?: string; type?: string; message?: string };
    };
    const err = parsed.error;
    if (err) {
      const code = err.status ?? err.type ?? err.code;
      providerCode = code === undefined ? undefined : String(code);
      if (typeof err.message === "string" && err.message.trim()) message = err.message.trim();
    }
  } catch {
    // Not JSON — the raw text is all the detail there is.
  }
  throw classifyHttpError(
    response.status,
    response.headers.get("retry-after") ?? undefined,
    message,
    undefined,
    { status: response.status, body: text, providerCode, requestId },
  );
}

/** POST JSON, parse JSON. Throws a typed `LLMError` for every failure mode. */
export async function postJson<T>(p: HttpPostParams): Promise<{ json: T; requestId?: string }> {
  const response = await doFetch(p);
  const requestId = readRequestId(response, p.requestIdHeaders ?? DEFAULT_REQUEST_ID_HEADERS);
  if (!response.ok) await readErrorResponse(response, requestId, p.signal);

  const raw = await readBodyText(response, p.signal, requestId);
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
  // `null`, an array, a bare number — all parse, none are a response. Rejecting
  // them centrally also stops every provider dereferencing null.
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw malformedResponse("body is not a JSON object", json, requestId);
  }
  throwIfBodyError(json, { status: response.status, requestId });
  return { json, requestId };
}

export interface SseStream {
  /** Read from the response headers, before any frame is consumed. */
  requestId?: string;
  frames: AsyncGenerator<unknown, void, void>;
  /**
   * Set when the stream reached an explicit `data: [DONE]`.
   *
   * A socket closing is not the same as a provider finishing. Without a terminal
   * marker — this, or a finish reason in the payload — the frames received so far
   * are a fragment, and returning them as a completed answer is the truncation
   * failure in its quietest form.
   */
  state: { sawDone: boolean };
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
  if (!response.ok) await readErrorResponse(response, requestId, p.signal);
  if (!response.body) {
    throw classifyHttpError(502, undefined, "provider returned no body for a streaming request", undefined, {
      status: 502,
      requestId,
    });
  }

  // A 200 that is not an event stream is not a stream at all. Left to the frame
  // parser it yields zero frames and reads as an empty completion — so an error
  // body returned against a streaming request would vanish entirely.
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("event-stream")) {
    const raw = await readBodyText(response, p.signal, requestId);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw malformedResponse(`expected an event stream, got "${contentType || "no content-type"}"`, raw, requestId);
    }
    throwIfBodyError(json, { status: response.status, requestId });
    throw malformedResponse(
      `expected an event stream, got "${contentType || "no content-type"}"`,
      json,
      requestId,
    );
  }

  const state = { sawDone: false };
  return { requestId, state, frames: readFrames(response.body, p.signal, requestId, state) };
}

async function* readFrames(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  requestId: string | undefined,
  state: { sawDone: boolean },
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
        // `data:` with nothing after it is a keep-alive heartbeat — proxies and
        // several gateways emit them to hold the connection open. It is not a
        // frame, and `JSON.parse("")` throws, so failing closed on it destroyed
        // otherwise perfect streams.
        if (data === undefined || data === "") continue;
        if (data === "[DONE]") {
          state.sawDone = true;
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(data);
        } catch {
          // Fail closed. A complete `data:` frame that is not JSON means the
          // stream is corrupt, and swallowing it returns whatever text arrived
          // before the corruption as though the model had finished speaking.
          throw malformedResponse("unparseable data frame mid-stream", data, requestId);
        }
        check(payload);
        yield payload;
      }
    }
    // Some servers close without a trailing blank line — flush whatever is left.
    const tail = parseSseData(buffer);
    // A `[DONE]` that arrives without its trailing blank line is still the
    // provider saying it finished. Skipping it here without recording it left
    // `sawDone` false, so a complete answer was rejected as truncated.
    if (tail === "[DONE]") {
      state.sawDone = true;
    } else if (tail !== undefined && tail !== "") {
      let payload: unknown;
      try {
        payload = JSON.parse(tail);
      } catch {
        // The connection ended mid-frame. That is a truncated response, not a
        // complete one, and the accumulated text must not be passed off as final.
        throw malformedResponse("stream ended mid-frame", tail, requestId);
      }
      check(payload);
      yield payload;
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

/**
 * Read a response body, classifying an abort that fires mid-read.
 *
 * The deadline can easily expire *after* headers arrive: any keep-alive shim
 * committing to a 200 while a slow backend works — the local CLI bridge does
 * exactly this for runs of several minutes — flushes headers early and streams
 * the body late. Left unwrapped, that abort surfaces as a raw DOMException
 * instead of TimeoutError, and every typed-error guarantee in the README is
 * false for the one topology most likely to hit it.
 */
async function readBodyText(
  response: Response,
  signal: AbortSignal | undefined,
  requestId: string | undefined,
): Promise<string> {
  try {
    return await response.text();
  } catch (err) {
    const aborted = classifyAbort(err, signal);
    if (aborted) throw aborted;
    throw classifyHttpError(undefined, undefined, `response body read failed: ${errMessage(err)}`, err, {
      requestId,
    });
  }
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

/**
 * Merge caller headers over the wire shape's own. Caller wins, deliberately.
 *
 * Keys are lowercased first. HTTP header names are case-insensitive, but object
 * keys are not: merging `{authorization}` with `{Authorization}` keeps BOTH, and
 * `fetch` then joins them into `"Bearer ours, Bearer theirs"` — a header that
 * satisfies no bearer check anywhere. The caller's value has to actually replace
 * ours, not queue behind it.
 */
export function mergeHeaders(
  base: Record<string, string>,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) out[k.toLowerCase()] = v;
  for (const [k, v] of Object.entries(extra ?? {})) out[k.toLowerCase()] = v;
  return out;
}

/**
 * A response that parsed but carries none of the fields its wire shape requires.
 *
 * Named rather than folded into `TransientError`, because the two causes need
 * different handling and only the caller can tell them apart across attempts:
 * a proxy substituting its own body clears on a retry, a request whose output
 * budget was entirely consumed by thinking never will. See `MalformedResponseError`.
 */
/**
 * True when the caller supplied their own `authorization` header, in any casing.
 *
 * Load-bearing only for shapes whose own credential header has a *different*
 * name — `x-api-key`, `x-goog-api-key`. `mergeHeaders` cannot override those
 * with a bearer, so the shape has to stand down explicitly. It is never on its
 * own sufficient: an empty `apiKey` must be suppressed regardless of which
 * header the caller used to authenticate.
 */
export function hasCallerAuth(extra: Record<string, string> | undefined): boolean {
  return Object.keys(extra ?? {}).some((k) => k.toLowerCase() === "authorization");
}

export function malformedResponse(detail: string, json: unknown, requestId?: string): LLMError {
  return new MalformedResponseError(`malformed provider response: ${detail}`, json, {
    status: 502,
    body: safeStringify(json),
    requestId,
  });
}

/**
 * Classify token counts without ever inventing one.
 *
 * "reported" means the endpoint sent them, not that anyone measured them.
 */
export function tokenSourceOf(prompt: number | undefined, completion: number | undefined) {
  const hasPrompt = typeof prompt === "number";
  const hasCompletion = typeof completion === "number";
  if (hasPrompt && hasCompletion) return "reported" as const;
  if (hasPrompt || hasCompletion) return "partial" as const;
  return "unreported" as const;
}
