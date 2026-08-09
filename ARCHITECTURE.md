# Architecture

## Core Principle

> **The router executes. The controller decides.**

This document governs Phase 1 of `ai-execution-router`. Every implementation decision in this repository must be checkable against the rules below.

---

## Scope

This repository contains **only the public execution engine**.

The router is a deterministic, stateless primitive that accepts a fully resolved request, executes it against a model provider, and returns a result. It is intentionally minimal.

Higher-level concerns belong in a separate **controller** layer that wraps this router. Such a controller is out of scope for this repository.

---

## The Two Layers

### 1. Public Execution Layer (this repo)

Stateless. Domain-agnostic. Free of policy.

The router accepts a resolved task and executes it. Nothing more.

### 2. Private Control Layer (NOT in this repo)

Where decisions are made: policy enforcement, audit logging, regulatory awareness, gating, fallback strategies, domain reasoning, human review.

The controller wraps the router. The controller calls `complete()`. The router never calls back into the controller for permission, context, or interpretation.

The boundary is one-way and strict.

---

## What the Router Must NOT Include

The public router must never include:

- policy logic
- regulatory context
- data profile (sensitivity, classification, residency)
- execution policy (when to call, when not to)
- fallback strategy (what to try next on failure)
- provider trust scoring
- cost guardrails (spend caps, budget enforcement)
- audit trails (decision logs, evidence chains)
- decision reasoning
- domain-specific routing (legal, medical, financial)
- ZDR logic (zero-data-retention enforcement)
- local-versus-remote policy
- jurisdiction logic
- human review gates
- credential acquisition (OAuth flows, ADC, key pools, key rotation)
- model catalogs, capability tables, context-window registries, or tier ceilings

If a future contribution attempts to add any of the above, it must be rejected. These responsibilities belong to the controller layer in a separate repository.

---

## Wire shapes, not vendors

**The router models the schema on the wire. It does not model who is serving it.**

This is the rule that keeps the exclusion list above enforceable. A "provider" in this codebase is a request/response format, never a company, a tier, or a price:

| Wire shape | Served by |
|---|---|
| `anthropic` | Anthropic, AWS Bedrock, GCP Vertex |
| `openai-chat` | OpenAI, Azure, NVIDIA NIM, Groq, OpenRouter, Together, Fireworks, DeepSeek, xAI, Mistral, Cerebras, Ollama, LM Studio, vLLM, local CLI bridges |
| `google-genai` | Gemini Developer API, GCP Vertex |

Three consequences follow, and each one is a test the design must keep passing:

1. **Adding a supplier is a `baseUrl`, not a code change.** Most of the ecosystem is reachable today without touching this repository. If onboarding a vendor requires editing a provider, ask first whether it genuinely speaks a fourth schema.
2. **The same vendor can appear under two shapes.** Vertex serves both `anthropic` and `google-genai`. A vendor-keyed abstraction cannot express that; a schema-keyed one does so for free.
3. **Deployment facts stay outside.** Free-tier throughput ceilings, per-key rate limits, credit balances, and model context windows are properties of *an account on a serving tier*, not of a schema. They belong to the controller, and the router has no table for them.

A concrete test of the boundary: **Vertex AI authenticates with an OAuth bearer token, not an API key.** Minting one requires ambient credentials, and the router reads no ambient state. The controller acquires the token and passes it via `endpoint.headers`. The router gained no knowledge of Google, GCP, or OAuth — the boundary absorbed a new auth model without moving.

---

## Fail closed

**An unsupported parameter must raise. It must never be silently dropped.**

A request whose JSON constraint or reasoning budget was quietly discarded still returns a fluent, plausible completion, and nothing in the result records that the governing instruction was lost. For a layer whose purpose is provable execution, that is the one unacceptable failure mode — worse than an error, because it is invisible.

Each provider therefore declares the `Capability` set it can actually express, and the router rejects anything else by name before a request is sent:

```
UnsupportedCapabilityError: Wire shape "anthropic" cannot express "responseFormat.type=json"
```

Two rules follow from this:

- **Never invent a translation.** `reasoning.effort` (a coarse enum) and `reasoning.budgetTokens` (a token count) are different currencies. Converting between them is a cost/quality judgement — policy — so a shape that understands only one rejects the other rather than guessing.
- **Never invent a number.** See *Usage Records* below.

---

## What the Router MAY Include

The public router may include:

- provider transport (HTTP clients to model APIs)
- protocol normalization (translating between the wire shapes' message and content formats)
- capability declaration and refusal of unsupported parameters
- request deadlines and caller cancellation
- header passthrough for transport-level auth the router itself does not perform
- single protocol-level 429 retry, only when a `retry-after` value is explicitly supplied by the provider
- typed errors that carry the provider's own status, code, and request id
- usage and attempt callback emission (the router emits; the caller decides what to do with it)
- latency and token reporting, labelled with its provenance

Anything not on this list does not belong in the router.

---

## Canonical Public API

```ts
complete({
  task,           // opaque label, passed through to onUsage; never interpreted
  model,          // required; fully resolved by the caller
  input,          // { system?, messages }
  temperature,    // optional
  maxTokens,      // optional
  responseFormat, // optional; refused by shapes that cannot express it
  reasoning,      // optional; { effort } or { budgetTokens }, never converted
  endpoint,       // { provider, baseUrl?, apiKey, headers? }
  timeoutMs,      // optional wall-clock ceiling
  signal,         // optional caller cancellation
  onDelta,        // optional; observe output incrementally
  onUsage,        // optional; fires once, on success only
  onAttempt,      // optional; fires per attempt, success or failure
})
```

### Field Semantics

- **`task`** — an opaque label provided by the caller. The router does not interpret it. It is passed through verbatim to `onUsage` and `onAttempt`.
- **`model`** — a fully resolved model identifier. The caller is responsible for resolution. The router does not understand task-to-model mapping, preferences, or overrides.
- **`input`** — provider-neutral message structure. `content` is a string or an ordered list of content blocks. A trailing `assistant` message passes through verbatim, which is how an assistant prefill works; no dedicated parameter exists for it.
- **`temperature`**, **`maxTokens`** — provider-standard knobs. Passed through without interpretation.
- **`endpoint`** — `{ provider, baseUrl?, apiKey, headers? }`. `provider` is a **wire shape** and is required; there is no inference. `headers` merge over the router's own and are the seam for auth the router does not perform (Cloudflare Access, Azure `api-key`, a Vertex or Bedrock bearer minted by the controller).
- **`timeoutMs`** / **`signal`** — composed into a single deadline. A timeout raises `TimeoutError` (transient); a caller abort raises `CancelledError` (never retried). Unset means no router-imposed deadline.
- **`onDelta`** — switches the provider to its streaming transport. It does **not** change the return type: `complete()` still resolves to exactly one `CompleteResult`. Streaming is an observation channel, not a second execution model, because one call must remain auditable as one record.
- **`onUsage`** — fires once, on success only. Safe to bill from.
- **`onAttempt`** — fires once per attempt, including failures and both legs of a retry. A throwing sink is swallowed: an audit callback must never be able to replace the provider's real error with its own.

---

## Behavioral Guarantees

- The router calls one provider, once, per `complete()` invocation.
- The router performs at most one additional call: a single retry on 429 when the provider supplies an explicit `retry-after`. No other retries.
- The router does not chain providers, fall back, fail over, or substitute models.
- The router does not read environment variables.
- The router does not log to stdout or stderr, ever.
- The router does not persist state.
- The router never estimates a token count.
- The router throws typed errors and lets the caller decide what to do.

---

## Errors

The router classifies and labels errors. **It does not act on them.**

Every error carries `status`, `providerCode`, `body`, and `requestId` where the provider supplied them. This is deliberate: a caller that has to recover a failure category by pattern-matching an error *message* is paying for an abstraction that discarded the structure it was given.

| Error class | Meaning | What the caller decides |
|---|---|---|
| `RateLimitError` | 429, transient. Retried once if `retry-after` was supplied | Whether to wait, queue, or route elsewhere |
| `QuotaExhaustedError` | 429 or 402 where the body indicates spent quota or credit | Fail over now — waiting cannot help |
| `TransientError` | Network drop, socket reset, 5xx, malformed body | Whether to retry |
| `TimeoutError` | `timeoutMs` elapsed. A `TransientError` | Whether to retry, perhaps with a longer deadline |
| `ContextLengthError` | Input exceeded the context window. A `PermanentError` | Whether a larger-context candidate can take the same payload |
| `ModelUnavailableError` | Unknown, retired, or unentitled model. A `PermanentError` | Whether to substitute a model |
| `UnsupportedCapabilityError` | The wire shape cannot express a requested parameter. A `PermanentError` | Fix the request, or route to a shape that supports it |
| `AuthError` | 401 or 403 | Surface to ops; do not retry |
| `CancelledError` | The caller's `signal` aborted | Nothing — the caller asked to stop |
| `PermanentError` | Malformed request, or an unclassified 4xx | Whether to fall back or fail |
| `LLMError` | Catch-all base class | Inspect `cause` |

`QuotaExhaustedError` extends `PermanentError`, **not** `RateLimitError`, and that inheritance is load-bearing. Both conditions arrive as HTTP 429 and only the body distinguishes them; a caller that treats them alike will sit out a full quota window before failing over to a candidate that would have answered immediately.

The labels are factual descriptions of the API response. They are not retry instructions.

---

## Usage Records

```ts
interface UsageRecord {
  task?: string;
  model: string;
  wireShape: WireShape;
  promptTokens: number;
  completionTokens: number;
  tokenSource: "provider" | "partial" | "unreported";
  cachedPromptTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  latencyMs: number;
  timestamp: string;      // ISO 8601
  finishReason?: string;
  providerRequestId?: string;
}
```

**`tokenSource` is the most important field here.** The router never estimates. A provider that reports no usage yields zeroes marked `"unreported"`, so a downstream cost model can refuse to price the call rather than silently pricing a fabricated number. A caller that wants an estimate must make — and own — that assumption itself.

Cache and reasoning token classes are reported separately because they are priced separately, often by an order of magnitude. Collapsing them into `promptTokens` produces a cost figure that is confidently wrong.

`providerRequestId` exists so a record can be reconciled against the provider's own logs and invoice. An audit trail that cannot be checked against the counterparty's books is not an audit trail.

The router emits one `UsageRecord` per successful call, and one `AttemptRecord` per attempt including failures. It does not compute cost, attach further context, or persist anything. Cost calculation, persistence, attribution, and audit are controller concerns.

---

## Why there is no model catalog

Earlier revisions shipped a catalog mapping model ids to transports, on the grounds that it was "factual, not policy". It was removed, for three reasons worth recording:

1. **It was inference the caller had already done.** The only production consumer always passed `endpoint.provider` explicitly and never once read the catalog.
2. **It rots.** A hardcoded model list is wrong the week a vendor ships a new tier, and a stale catalog in a routing library is worse than none — it answers confidently.
3. **"Factual" was doing too much work.** Which endpoint serves a model is an account-level deployment fact, not a property of the model. Encoding it here quietly imports the assumption that everyone reaches that model the same way, which is precisely the vendor lock-in this project exists to refuse.

`endpoint.provider` is therefore required. Convenience presets, if ever wanted, belong to the controller.

---

## Versioning

The canonical API is the contract. Breaking changes to the `complete()` signature, the `UsageRecord` shape, or the error class hierarchy require a major version bump.

Adding new wire shapes, new capabilities, or new optional fields is non-breaking. Narrowing a declared capability is breaking.

---

## Governing Status

This document governs Phase 1.

Every implementation decision in this repository must be checkable against the rules above. If a proposed change is justified by the inclusion list and does not violate the exclusion list, it is in scope. Otherwise it belongs in a controller layer outside this repository.

Phase 2 (versioned spec, multi-language ports, sidecar proxy) will not begin until at least two real projects have used Phase 1 in production for thirty days.
