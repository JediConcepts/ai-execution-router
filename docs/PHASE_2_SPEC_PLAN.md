> **⚠️ Superseded in part by 1.0.0-rc.1. Do not read this as current design.**
>
> This document was written against the 0.1.0 kernel and predates the wire-shape
> release. Several things it proposes as future work have since shipped, and at
> least one thing it assumes as present has been deliberately removed:
>
> | This document says | Actual state in 1.0.0-rc.1 |
> |---|---|
> | The model catalogue is retained and extended | **Removed.** `endpoint.provider` is required. See *Why there is no model catalog* in `ARCHITECTURE.md` |
> | Capability data is future work | **Protocol encodability shipped**; endpoint/model capability remains Phase 2 and out of scope |
> | Streaming, timeouts, cancellation are unaddressed | **Shipped** — `onDelta`, `timeoutMs`, `signal` |
> | Two wire shapes | **Three** — `google-genai` added |
> | Callbacks unspecified | `onUsage` (success only, awaited, propagates) and `onAttempt` (every attempt, awaited, swallowed) |
>
> `ARCHITECTURE.md` is the governing document and wins wherever the two disagree.
> This file is kept for the reasoning it records, not as a specification.

---

# Phase 2 — Forward-Looking Spec Plan

> Status: planning only. No code in this phase yet. The router as shipped in Phase 1 is the contract. Phase 2 evolutions extend the execution layer **without** introducing policy, controller responsibilities, or domain-specific logic.

---

## 1. Status and Entry Criteria

Phase 2 begins only when:

1. The Phase 1 router has been integrated into **at least two independent projects**.
2. Both have run in production for **thirty days or more** without architectural regressions.
3. Real call-site experience has produced concrete revisions or confirmed that the surface needs no change.

Until then, this document is design-only. Speculative changes are not implemented.

The architectural rules of `ARCHITECTURE.md` continue to govern. Every Phase 2 evolution must be checkable against the inclusion list and must not violate the exclusion list. If a proposed evolution requires a decision (rather than a capability the caller can make a decision with), it does not belong in the router.

---

## 2. Versioning and Compatibility

Phase 1 establishes the canonical API:

```ts
complete({ task, model, input, temperature, maxTokens, endpoint, onUsage })
```

Compatibility commitments for Phase 2:

- **No breaking changes** to the existing `complete()` signature, `UsageRecord` shape, or error class hierarchy without a major version bump.
- **All new fields are optional** and defaulted to behaviour identical to Phase 1.
- **All new exports are additive.** Removing or renaming an existing export requires a major version bump.
- **The behavioral guarantees** ("one provider, once; at most one retry; no logging; no persisted state") apply to every code path added in Phase 2.

A separate `SPEC.md` will be lifted out of the TypeScript reference implementation as the source of truth, so reference ports in other languages can target it without inspecting TypeScript source.

---

## 3. Capability-Aware Routing

**Goal**: expose factual model capabilities so the controller can make capability-aware decisions. The router itself remains a pure executor.

**Proposed shape**: extend `CatalogEntry` with optional fields that describe what the model accepts.

```ts
interface CatalogEntry {
  provider: ProviderName;
  baseUrl?: string;
  capabilities?: ReadonlySet<Capability>;
  contextWindow?: number;        // tokens
}

type Capability = "text" | "vision" | "tools" | "streaming" | "json_mode";
```

Plus a public lookup helper:

```ts
function capabilitiesFor(model: string): ReadonlySet<Capability> | undefined;
```

**Boundary check**:

- The router **does not** select a model based on capability. The controller does.
- The router **does not** validate capability before dispatch. If the model rejects the call, the provider returns a 4xx, which the router classifies as `PermanentError` and propagates.
- The catalog remains factual: capability data is descriptive, not prescriptive. There is no "preferred for X" field, no scoring, no ordering.

**Open questions**:

- Whether to ship a curated capability list per known model, or only allow the catalog consumer (controller) to extend it.
- Whether `tools` should be split (e.g. `tools_parallel`, `tools_strict`) once tool-use normalization (§6) is in place.

---

## 4. Sidecar / Proxy Mode

**Goal**: let any project — in any language — use the router by pointing an OpenAI-compatible client at a local HTTP endpoint.

**Proposed shape**: an optional `proxy` package that hosts an HTTP server exposing `/v1/chat/completions`. The server translates each request to a `complete()` call and translates the result back to OpenAI Chat Completions format.

```
client (any lang) ──▶ proxy :8787 ──▶ complete() ──▶ provider
                            │
                            └─ caller-supplied endpoint via headers
```

**Boundary check**:

- The proxy is **transport, not policy**. It performs no authentication of its own, no rate limiting, no fallback, no logging beyond what the underlying router emits via `onUsage`.
- The caller still supplies `apiKey` — typically through a header. The proxy passes it to `endpoint.apiKey` and never reads it from the proxy's own environment.
- Unsupported request features (streaming, tools, etc.) are returned as `400` with a clear error until the underlying execution layer supports them.

**Open questions**:

- Whether the proxy ships as a separate package, a separate binary, or a subcommand of the same package.
- Whether `task` is read from a non-standard request field (e.g. `x-task` header) or omitted in proxy mode.
- Whether the proxy can be embedded in-process for test scenarios without spinning a real socket.

---

## 5. Multi-Language Ports

**Goal**: identical execution semantics in languages other than TypeScript.

**Order**:

1. **Python** first. Highest demand; widely used in data-science and orchestration contexts.
2. **Go or Rust** next, only if a real project demands it.

**Constraints**:

- Each port targets the same `SPEC.md`, not the TypeScript implementation.
- Same canonical API, same error class hierarchy (idiomatic naming where conventions differ — e.g. `snake_case` arguments in Python — but identical semantics).
- Each port has its own zero-dependency target (Python: `httpx` is acceptable, but `requests` is not preferred for async).
- Each port ships with its own test suite that can be run against a shared fixture set.

**Boundary check**:

- No port adds policy, fallback, capability validation beyond §3, or logging beyond `on_usage` callback emission.
- Equivalence is enforced by a cross-language conformance test suite (one fixture set, run by every port's test runner).

**Open questions**:

- Whether to maintain ports in the same repo or in language-specific repos. Single repo simplifies cross-language conformance; separate repos simplify per-language tooling.

---

## 6. Tool-Use / Function-Call Normalization

**Goal**: enable callers to pass a single tool/function-call schema and have it translated to whichever provider format the chosen model expects.

**Proposed canonical schema**: align with the OpenAI Chat Completions tool format. It is the most widely adopted, most ported, and most tooling-supported.

```ts
interface Tool {
  name: string;
  description?: string;
  parameters: JsonSchema;       // JSON Schema draft-2020
}

interface ToolCallRequest extends CompleteParams {
  tools?: Tool[];
  toolChoice?: "auto" | "required" | "none" | { name: string };
}

interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;            // parsed from JSON
}

interface CompleteResultWithTools extends CompleteResult {
  toolCalls?: ToolCall[];
}
```

**Provider translation**:

- **Anthropic**: emit native `tools` array with `input_schema`; parse `tool_use` content blocks back into `ToolCall[]`.
- **OpenAI-compatible**: pass-through (canonical format matches the wire format on most providers).
- **Future providers** (Gemini, Cohere): translate to and from their respective formats.

**Boundary check**:

- Translation of a provider's schema is **protocol normalization**, which is router territory.
- The router **does not** select tools, validate arguments against application-level rules, or interpret tool results. The caller invokes the tool, supplies the result back via the next `complete()` call, and the loop continues.
- The router emits one `UsageRecord` per `complete()` call; tool-use loops produce multiple records, one per round trip. The controller assembles them.

**Open questions**:

- Whether `streaming` (§7) and `tools` interact natively or require a separate API.
- How to surface partial tool calls during streaming.
- Whether the canonical schema accepts vendor-specific extensions via an `extensions: { [vendor]: unknown }` escape hatch or rejects them.

---

## 7. Streaming Support

**Goal**: emit response chunks as they arrive, not only on completion.

**Proposed shape**: a separate function rather than overloading `complete()` with a mode flag.

```ts
async function* streamComplete(params: CompleteParams): AsyncGenerator<StreamChunk, CompleteResult, void>;

interface StreamChunk {
  delta: string;                 // incremental text
  finishReason?: string;         // present on the terminal chunk
}
```

The generator yields chunks and returns the same `CompleteResult` that `complete()` would have returned.

**Boundary check**:

- Streaming is transport, not policy. The router emits chunks; the caller decides whether to forward them, buffer them, or abort the stream.
- `onUsage` is invoked exactly once when the stream completes, with the same `UsageRecord` shape.
- Aborting a stream is the caller's responsibility (via `AbortController`). The router does not implement timeouts.

**Open questions**:

- Whether `streamComplete()` should accept its own `signal: AbortSignal` parameter or rely on the underlying `fetch` abort behaviour.
- Whether tool-use rounds (§6) stream the partial JSON arguments or only emit the completed tool call at the end.

---

## 8. Provider Expansion

**Goal**: add transport adapters for additional providers without introducing preference, ranking, or trust scoring.

**Eligible additions** (illustrative, not committed):

- AWS Bedrock (native API, not the OpenAI-compatible shim)
- Google Vertex AI (native Gemini API)
- Cohere
- Mistral platform (native, beyond the OpenAI-compatible endpoint)
- Together, Fireworks, Groq, DeepInfra (most are OpenAI-compatible already, may not need new adapters)

**Constraints**:

- Each new provider is a new `Provider` implementation behind a new `ProviderName` literal.
- Each provider's catalog entries are factual: `{ provider, baseUrl }` plus optional capabilities (§3).
- No "recommended", "premium", "fast", "free", or any judgemental classification appears in the catalog or in the public API.
- Providers that require additional auth shapes (signed requests, OAuth, region selection) extend `Endpoint` with optional fields, never with required project-specific fields.

**Open questions**:

- Whether providers requiring SDK-style request signing (Bedrock, Vertex) ship as separate optional packages so the core router stays at zero runtime dependencies.

---

## 9. Observability Hooks

**Goal**: make the router observable in production without introducing built-in logging.

**Proposed additions**:

1. **OpenTelemetry semantic conventions**: document the attributes a controller should attach to a span wrapping `complete()`. The router does not create spans itself.

   ```
   gen_ai.system           = "anthropic" | "openai-compatible" | …
   gen_ai.request.model    = params.model
   gen_ai.usage.input_tokens   = result.promptTokens
   gen_ai.usage.output_tokens  = result.completionTokens
   gen_ai.response.finish_reason = result.finishReason
   ```

2. **Optional `onError(err: LLMError, context: ErrorContext)` callback**: complementary to `onUsage`. Invoked exactly once on failure with the typed error and a small context object (model, latency to failure, attempt count). The callback decides what to do; the router still throws.

3. **Optional `onAttempt(attempt: AttemptRecord)` callback**: fires once per HTTP attempt (i.e. twice if a 429 retry occurs). Useful for fine-grained tracing.

**Boundary check**:

- All hooks are caller-supplied. The router never opens a span, writes a log line, or sends to a network sink.
- All hook failures are swallowed: a buggy `onUsage` cannot break a successful call.
- No hook receives information beyond what is already reportable (model, tokens, latency, status, typed error). No prompt content leaks via hooks unless the caller already has it.

**Open questions**:

- Whether hooks are passed individually or bundled as `observers: { onUsage?, onError?, onAttempt? }` to reduce signature growth.

---

## 10. MCP / Transport Abstraction

**Goal**: be ready for the Model Context Protocol becoming a standard transport for model and tool access.

**Position**: speculative. Not committed for v2. Documented here so it does not surprise the architecture later.

**Possible shape**: an additional `Provider` implementation whose transport is an MCP client rather than HTTPS. Public API unchanged: the caller still calls `complete()` with a fully resolved `model` and `endpoint`.

**Boundary check**:

- MCP changes the wire, not the contract. `complete()` semantics remain identical.
- The router does not become an MCP server. Hosting MCP-style tool execution is a controller and orchestration concern.
- If MCP adoption stalls, this section is removed without affecting any other Phase 2 work.

---

## 11. What Will Not Be Added

To prevent policy creep, this list is binding. None of the following will appear in the router under any Phase 2 scope:

- Multi-step fallback chains, model substitution, tier promotion, or "auto-best" selection.
- Cost computation, spend caps, budget enforcement, or quota tracking.
- Audit log writers or decision-trail persistence.
- Authentication beyond passing the caller-supplied `apiKey` to the provider.
- Authorization checks, approval gates, or human review handoffs.
- Data classification, sensitivity tagging, redaction, or transformation of `input`.
- Data residency or jurisdiction routing logic.
- Retention policy, ZDR enforcement, or per-tenant data handling.
- Domain-specific request shapes, vocabulary, or task taxonomies.
- Provider trust scoring, reputation, or fitness ranking.
- A "best model for X" registry or any judgemental classification.
- Built-in stdout/stderr logging or any default file output.

If a contribution proposes any of the above, it is rejected. Those features are controller responsibilities and live above the router, not inside it.

---

## 12. Open Questions Across Phase 2

- Should Phase 2 ship as one major version (v2.0.0) covering everything, or as a sequence of minor versions adding features one at a time? The latter is preferred unless a coupling forces grouping.
- Should the conformance test suite (§5) be authored in a fourth, language-neutral form (e.g. JSON fixtures + a minimal harness spec) so each port consumes the same source-of-truth?
- Should `SPEC.md` be a separate document at the repo root or live under `docs/`?
- For the proxy (§4), is OpenAI Chat Completions the only ingress format, or does Anthropic's `/v1/messages` ingress also need to be served for callers that natively speak Anthropic?

---

## Closing Discipline

Phase 2 succeeds if the public API in two years still reads like a primitive — small, predictable, and unopinionated — even though the implementation underneath has gained capability lookup, streaming, tool translation, an HTTP proxy, more providers, and additional observability hooks.

It fails the moment the router starts deciding.
