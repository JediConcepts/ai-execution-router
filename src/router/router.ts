import type {
  AttemptRecord,
  Capability,
  CompleteParams,
  CompleteResult,
  Endpoint,
  Provider,
  ProviderCallResult,
  UsageRecord,
  WireShape,
} from "./types.ts";
import {
  AuthError,
  CancelledError,
  PermanentError,
  RateLimitError,
  TimeoutError,
  UnsupportedCapabilityError,
} from "./errors.ts";
import { TIMEOUT_REASON } from "./http.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import { OpenAIChatProvider } from "./providers/openai-chat.ts";
import { GoogleGenAIProvider } from "./providers/google-genai.ts";

/**
 * Wire shape → implementation.
 *
 * This table is the only place the router distinguishes between providers, and
 * it distinguishes them by schema, never by vendor. If adding a model supplier
 * ever requires editing anything below this map, the abstraction has failed.
 */
const PROVIDERS: Record<WireShape, () => Provider> = {
  anthropic: () => new AnthropicProvider(),
  "openai-chat": () => new OpenAIChatProvider(),
  "google-genai": () => new GoogleGenAIProvider(),
};

/**
 * The longest the router will block on a provider's `retry-after`.
 *
 * The router's one retry exists for short protocol-level limits — the "you are
 * one request ahead of yourself, wait two seconds" case. Anything beyond this is
 * a capacity or quota problem, and choosing to wait it out is a decision with
 * cost and latency consequences: the controller's call, not the kernel's.
 */
const MAX_RETRY_AFTER_MS = 60_000;

interface ResolvedEndpoint {
  wireShape: WireShape;
  baseUrl?: string;
  apiKey: string;
  headers?: Record<string, string>;
}

export async function complete(params: CompleteParams): Promise<CompleteResult> {
  const endpoint = resolveEndpoint(params.endpoint);
  const provider = PROVIDERS[endpoint.wireShape]();

  assertCapabilities(params, provider);

  const deadline = withDeadline(params.signal, params.timeoutMs);
  const startedAt = Date.now();

  try {
    const call = () =>
      provider.call({
        model: params.model,
        input: params.input,
        apiKey: endpoint.apiKey,
        baseUrl: endpoint.baseUrl,
        headers: endpoint.headers,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
        responseFormat: params.responseFormat,
        reasoning: params.reasoning,
        signal: deadline.signal,
        onDelta: params.onDelta,
      });

    let result: ProviderCallResult;
    try {
      result = await attempt(call, 1, params, provider.wireShape);
    } catch (err) {
      // The single retry the router permits itself: an explicit `retry-after`
      // from the provider. Anything else — including a 429 that turned out to be
      // spent quota — is a failover decision, and failover is the controller's.
      if (!(err instanceof RateLimitError) || typeof err.retryAfterMs !== "number") throw err;
      // A long retry-after is the provider saying "not for a while", which is a
      // failover question, not a sleep. Blocking a library call for an hour is
      // never the caller's intent, and with no `timeoutMs` set nothing would
      // interrupt it. Hand the error back with `retryAfterMs` intact and let the
      // controller decide whether that wait is worth taking.
      if (err.retryAfterMs > MAX_RETRY_AFTER_MS) throw err;
      await sleep(err.retryAfterMs, deadline.signal);
      result = await attempt(call, 2, params, provider.wireShape);
    }

    const latencyMs = Date.now() - startedAt;

    if (params.onUsage) {
      const record: UsageRecord = {
        task: params.task,
        model: params.model,
        wireShape: provider.wireShape,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        tokenSource: result.tokenSource,
        cachedPromptTokens: result.cachedPromptTokens,
        cacheWriteTokens: result.cacheWriteTokens,
        reasoningTokens: result.reasoningTokens,
        latencyMs,
        timestamp: new Date().toISOString(),
        finishReason: result.finishReason,
        providerRequestId: result.providerRequestId,
      };
      await params.onUsage(record);
    }

    return {
      text: result.text,
      model: params.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      tokenSource: result.tokenSource,
      cachedPromptTokens: result.cachedPromptTokens,
      cacheWriteTokens: result.cacheWriteTokens,
      reasoningTokens: result.reasoningTokens,
      latencyMs,
      finishReason: result.finishReason,
      providerRequestId: result.providerRequestId,
    };
  } finally {
    deadline.dispose();
  }
}

/** Run one attempt, reporting it to `onAttempt` whether it succeeds or fails. */
async function attempt(
  call: () => Promise<ProviderCallResult>,
  n: number,
  params: CompleteParams,
  wireShape: WireShape,
): Promise<ProviderCallResult> {
  const startedAt = Date.now();
  try {
    const result = await call();
    void report(params.onAttempt, {
      task: params.task,
      model: params.model,
      wireShape,
      attempt: n,
      outcome: "success",
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
      usage: {
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        tokenSource: result.tokenSource,
        cachedPromptTokens: result.cachedPromptTokens,
        cacheWriteTokens: result.cacheWriteTokens,
        reasoningTokens: result.reasoningTokens,
      },
      providerRequestId: result.providerRequestId,
    });
    return result;
  } catch (err) {
    void report(params.onAttempt, {
      task: params.task,
      model: params.model,
      wireShape,
      attempt: n,
      outcome: "error",
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
      errorName: (err as Error)?.name,
      errorMessage: (err as Error)?.message,
      status: (err as { status?: number })?.status,
      providerCode: (err as { providerCode?: string })?.providerCode,
    });
    throw err;
  }
}

/**
 * Audit callbacks never change control flow.
 *
 * `onAttempt` fires on the failure path, so a throwing sink would replace the
 * provider's real error with its own — the diagnostic equivalent of losing the
 * evidence while filing the report.
 */
function report(
  sink: ((record: AttemptRecord) => void | Promise<void>) | undefined,
  record: AttemptRecord,
): void {
  if (!sink) return;
  try {
    const maybe = sink(record);
    if (maybe && typeof (maybe as Promise<void>).catch === "function") {
      (maybe as Promise<void>).catch(() => {});
    }
  } catch {
    /* an audit sink must not be able to fail the call it is observing */
  }
}

/**
 * Refuse, by name, anything the chosen wire shape cannot express.
 *
 * Dropping an unsupported parameter would still return a fluent completion —
 * one whose JSON constraint or reasoning budget was silently discarded, with
 * nothing in the result to say so. For an execution layer whose purpose is
 * provable behaviour, failing open is the one unacceptable failure mode.
 */
function assertCapabilities(params: CompleteParams, provider: Provider): void {
  const need = (capability: Capability, what: string, hint?: string) => {
    if (!provider.capabilities.has(capability)) {
      throw new UnsupportedCapabilityError(what, provider.wireShape, hint);
    }
  };

  for (const message of params.input.messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type === "image") need("multimodal-image", "image content blocks");
      if (block.type === "document") need("multimodal-document", "document content blocks");
    }
  }

  if (params.responseFormat?.type === "json") {
    need("response-format-json", "responseFormat.type=json");
  }
  if (params.responseFormat?.type === "json_schema") {
    need("response-format-schema", "responseFormat.type=json_schema");
  }

  if (params.reasoning?.effort !== undefined) {
    need(
      "reasoning-effort",
      "reasoning.effort",
      "This wire shape takes an explicit reasoning.budgetTokens instead; converting between the two is a cost/quality judgement the router will not make for you.",
    );
  }
  if (params.reasoning?.budgetTokens !== undefined) {
    need(
      "reasoning-budget",
      "reasoning.budgetTokens",
      "This wire shape takes a coarse reasoning.effort instead; converting between the two is a cost/quality judgement the router will not make for you.",
    );
  }

  if (params.onDelta) need("streaming", "onDelta (streaming)");
}

function resolveEndpoint(supplied: Endpoint | undefined): ResolvedEndpoint {
  const wireShape = normaliseWireShape(supplied?.provider);
  if (!wireShape) {
    throw new PermanentError(
      `endpoint.provider is required. Supply one of: ${Object.keys(PROVIDERS).join(", ")}.`,
    );
  }
  if (wireShape === "openai-chat" && !supplied?.baseUrl) {
    throw new PermanentError("baseUrl is required for the openai-chat wire shape");
  }
  // A credential must be present — but not necessarily as an API key. Bearer
  // auth (Vertex, Bedrock, a gateway) arrives as a header the controller minted,
  // and for those endpoints `apiKey` is genuinely unused.
  const callerAuthenticates = Object.keys(supplied?.headers ?? {}).some(
    (k) => k.toLowerCase() === "authorization",
  );
  if (!supplied?.apiKey && !callerAuthenticates) {
    throw new AuthError(
      "No credential supplied. Set endpoint.apiKey, or pass an authorization header via endpoint.headers.",
    );
  }
  return {
    wireShape,
    baseUrl: supplied?.baseUrl,
    apiKey: supplied?.apiKey ?? "",
    headers: supplied?.headers,
  };
}

function normaliseWireShape(provider: string | undefined): WireShape | undefined {
  if (!provider) return undefined;
  // Pre-1.0 spelling, kept working rather than broken for cosmetics.
  if (provider === "openai-compatible") return "openai-chat";
  // `in` walks the prototype chain, so "toString" and "constructor" would pass
  // and then die deeper with a TypeError. Untyped JS callers deserve the same
  // clear PermanentError that TypeScript gives at compile time.
  if (Object.hasOwn(PROVIDERS, provider)) return provider as WireShape;
  throw new PermanentError(
    `Unknown endpoint.provider "${provider}". Expected one of: ${Object.keys(PROVIDERS).join(", ")}.`,
  );
}

interface Deadline {
  signal: AbortSignal | undefined;
  dispose: () => void;
}

/**
 * Compose the caller's cancellation with the router's own deadline.
 *
 * Whichever fires first wins, and the abort reason records which it was — a
 * timeout is transient and worth retrying, a cancellation is an instruction.
 */
function withDeadline(signal: AbortSignal | undefined, timeoutMs: number | undefined): Deadline {
  if (!signal && timeoutMs === undefined) return { signal: undefined, dispose: () => {} };

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  if (timeoutMs !== undefined && !controller.signal.aborted) {
    // Deliberately not unref'd: the timer must be able to fire on its own.
    // `dispose()` always clears it once the call settles, so it can never
    // outlive the request it bounds.
    timer = setTimeout(() => controller.abort({ [TIMEOUT_REASON]: true, timeoutMs }), timeoutMs);
  }

  return {
    signal: controller.signal,
    dispose: () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** Sleep, but abandon the wait the moment the deadline or the caller says stop. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError(signal));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason as { timeoutMs?: number } | undefined;
  if (reason && typeof reason === "object" && TIMEOUT_REASON in reason) {
    return new TimeoutError(reason.timeoutMs ?? 0);
  }
  return new CancelledError();
}
