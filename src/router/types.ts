/**
 * The execution contract.
 *
 * Every name here describes a WIRE SHAPE or a request parameter — never a
 * vendor, a tier, a price, or a policy. See ARCHITECTURE.md ("Wire shapes, not
 * vendors") for why that distinction is load-bearing.
 */

/**
 * A provider protocol, named after the request/response schema on the wire
 * rather than after whoever is serving it.
 *
 * `anthropic` is served by Anthropic, Bedrock, and Vertex. `openai-chat` is
 * served by OpenAI, Azure, NVIDIA NIM, Groq, OpenRouter, Together, Fireworks,
 * DeepSeek, xAI, Ollama, LM Studio, vLLM, and any local bridge that speaks
 * `/chat/completions`. `google-genai` is served by the Gemini Developer API and
 * Vertex AI.
 *
 * Adding a vendor is therefore usually a `baseUrl`, not a code change. That is
 * the property the whole design exists to preserve.
 */
export type WireShape = "anthropic" | "openai-chat" | "google-genai";

/**
 * Accepted on input. `"openai-compatible"` is the pre-1.0 spelling of
 * `"openai-chat"` and is normalised on the way in, so existing callers keep
 * working unchanged.
 *
 * @deprecated `"openai-compatible"` — use `"openai-chat"`.
 */
export type ProviderName = WireShape | "openai-compatible";

/**
 * Request features that genuinely differ between wire shapes.
 *
 * A provider declares what it can express; the router refuses anything else by
 * name rather than dropping it. Features that are merely *expressible in the
 * message array* (an assistant prefill, for instance) are not listed here —
 * they need no gate.
 */
export type Capability =
  | "multimodal-image"
  | "multimodal-document"
  | "response-format-json"
  | "response-format-schema"
  /** Accepts a coarse effort enum (`reasoning.effort`). */
  | "reasoning-effort"
  /** Accepts an explicit thinking-token budget (`reasoning.budgetTokens`). */
  | "reasoning-budget"
  | "streaming";

// ─── Input ────────────────────────────────────────────────────────────────────

/** A base64-embedded binary part. The router never fetches remote media. */
export interface MediaSource {
  type: "base64";
  mediaType: string;
  data: string;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: MediaSource }
  | { type: "document"; source: MediaSource };

export interface Message {
  role: "user" | "assistant";
  /**
   * Plain text, or an ordered list of blocks for multimodal input.
   *
   * A trailing `assistant` message is passed through verbatim, which is how an
   * assistant prefill works — no dedicated parameter is needed for it.
   */
  content: string | ContentBlock[];
}

export interface Input {
  system?: string;
  messages: Message[];
}

/** How the model's output should be constrained. */
export type ResponseFormat =
  | { type: "text" }
  | { type: "json" }
  | { type: "json_schema"; schema: Record<string, unknown>; name?: string };

/**
 * Reasoning controls.
 *
 * The two fields are different currencies and are deliberately NOT
 * interconvertible here: translating an effort enum into a token budget is a
 * judgement about cost and quality, which is policy. A wire shape that only
 * understands one of them rejects the other by name.
 */
export interface ReasoningOptions {
  /** Coarse effort level. Expressible by `openai-chat`. */
  effort?: "minimal" | "low" | "medium" | "high";
  /** Explicit thinking-token budget. Expressible by `anthropic` and `google-genai`. */
  budgetTokens?: number;
}

export interface Endpoint {
  provider?: ProviderName;
  baseUrl?: string;
  apiKey?: string;
  /**
   * Extra request headers, merged over the router's own.
   *
   * This is the seam for auth and transport concerns the router deliberately
   * knows nothing about: Cloudflare Access service tokens, Azure's `api-key`,
   * a Vertex/Bedrock bearer minted by the controller, provider attribution
   * headers. The router never reads the environment, so anything of this kind
   * has to arrive here.
   *
   * `authorization` and the shape's own auth header may be overridden — the
   * caller is assumed to know what it is doing. Header values are never logged
   * (the router does no logging at all).
   */
  headers?: Record<string, string>;
}

export interface CompleteParams {
  /** Opaque caller-side label, echoed into `UsageRecord`. Never interpreted. */
  task?: string;
  model: string;
  input: Input;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: ResponseFormat;
  reasoning?: ReasoningOptions;
  endpoint?: Endpoint;

  /**
   * Wall-clock ceiling for the call, including retry-after sleep.
   *
   * Unset means no router-imposed deadline; the request then lives as long as
   * the platform's own socket timeouts allow, which for some endpoints is
   * effectively forever.
   */
  timeoutMs?: number;
  /** Caller cancellation. Composed with `timeoutMs`; whichever fires first wins. */
  signal?: AbortSignal;

  /**
   * Receive output incrementally.
   *
   * Supplying this switches the provider to its streaming transport but does
   * NOT change the return type: `complete()` still resolves to exactly one
   * `CompleteResult`. Streaming is an observation channel, not a different
   * execution model — that is what keeps one call auditable as one record.
   */
  onDelta?: (delta: string) => void;

  /**
   * Emitted once, on success only. Safe to bill from.
   *
   * Unlike `onAttempt`, a throwing or rejecting `onUsage` **does** fail the
   * call, and the completion text is lost. The asymmetry is deliberate: this
   * sink runs on the success path, where a silent failure to record a billable
   * call is the more expensive outcome, and awaiting it gives a slow sink real
   * backpressure. `onAttempt` runs on the failure path, where throwing would
   * replace the provider's real error with the sink's own.
   *
   * If losing the text matters more to you than a loud billing failure, catch
   * inside your own callback — the router will not decide that trade for you.
   */
  onUsage?: (record: UsageRecord) => void | Promise<void>;
  /**
   * Emitted once per attempt, including failures and including each leg of the
   * router's single rate-limit retry.
   *
   * Separate from `onUsage` on purpose: a failed attempt is an audit event, not
   * a billable one, and folding the two together would make every consumer of
   * `onUsage` start charging for errors.
   */
  onAttempt?: (record: AttemptRecord) => void | Promise<void>;
}

// ─── Output ───────────────────────────────────────────────────────────────────

/**
 * Where the token counts came from.
 *
 * The router never estimates. A provider that reports nothing yields zeroes
 * marked `"unreported"`, so a downstream cost model can refuse to price the
 * call instead of silently pricing a fabricated number. Callers that want an
 * estimate must make — and own — that assumption themselves.
 */
export type TokenSource = "provider" | "partial" | "unreported";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  tokenSource: TokenSource;
  /** Prompt tokens served from the provider's cache, when reported. Priced differently. */
  cachedPromptTokens?: number;
  /** Prompt tokens written to cache, when reported. Usually the most expensive class. */
  cacheWriteTokens?: number;
  /** Reasoning/thinking tokens billed as output, when reported separately. */
  reasoningTokens?: number;
}

export interface CompleteResult extends TokenUsage {
  text: string;
  model: string;
  latencyMs: number;
  finishReason?: string;
  /** The provider's own request id, when returned. The key for invoice reconciliation. */
  providerRequestId?: string;
}

export interface UsageRecord extends TokenUsage {
  task?: string;
  model: string;
  latencyMs: number;
  timestamp: string;
  wireShape: WireShape;
  finishReason?: string;
  providerRequestId?: string;
}

/** One execution attempt — succeeded or failed. */
export interface AttemptRecord {
  task?: string;
  model: string;
  wireShape: WireShape;
  /** 1 for the first call, 2 for the post-`retry-after` retry. */
  attempt: number;
  outcome: "success" | "error";
  latencyMs: number;
  timestamp: string;
  /** Present on success. Absent when the attempt produced no usable response. */
  usage?: TokenUsage;
  providerRequestId?: string;
  /** Present on failure: the thrown error's class name, e.g. `"QuotaExhaustedError"`. */
  errorName?: string;
  errorMessage?: string;
  status?: number;
  providerCode?: string;
}

// ─── Provider plumbing ────────────────────────────────────────────────────────

export interface Provider {
  readonly wireShape: WireShape;
  readonly capabilities: ReadonlySet<Capability>;
  call(params: ProviderCallParams): Promise<ProviderCallResult>;
}

export interface ProviderCallParams {
  model: string;
  input: Input;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: ResponseFormat;
  reasoning?: ReasoningOptions;
  /** Already composed from the caller's signal and `timeoutMs` by the router. */
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}

export interface ProviderCallResult extends TokenUsage {
  text: string;
  finishReason?: string;
  providerRequestId?: string;
}
