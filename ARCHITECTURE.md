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
| `anthropic` | Anthropic, and any gateway proxying the Messages API verbatim |
| `openai-chat` | OpenAI, Azure, NVIDIA NIM, Groq, OpenRouter, Together, Fireworks, DeepSeek, xAI, Mistral, Cerebras, Ollama, LM Studio, vLLM, local CLI bridges |
| `google-genai` | Gemini Developer API, GCP Vertex |

Three consequences follow, and each one is a test the design must keep passing:

1. **Adding a supplier is a `baseUrl`, not a code change.** Most of the ecosystem is reachable today without touching this repository. If onboarding a vendor requires editing a provider, ask first whether it genuinely speaks a fourth schema.
2. **The same vendor can appear under two shapes.** Vertex serves Anthropic models *and* Gemini, under two different schemas. A vendor-keyed abstraction cannot express that; a schema-keyed one does so for free. (In practice the router reaches Vertex's `google-genai` surface today. Its Anthropic surface uses a different path and body convention — see *Known gaps*.)
3. **Deployment facts stay outside.** Free-tier throughput ceilings, per-key rate limits, credit balances, and model context windows are properties of *an account on a serving tier*, not of a schema. They belong to the controller, and the router has no table for them.

A concrete test of the boundary: **the tested enterprise path to Vertex AI uses a controller-minted OAuth bearer rather than an API key.** (Google also offers API-key auth on some Vertex surfaces; the bearer is the harder case and therefore the one worth proving.) Minting a token requires ambient credentials, and the router reads no ambient state. The controller acquires it and passes it via `endpoint.headers`. The router gained no knowledge of Google, GCP, or OAuth — the boundary absorbed a new auth model without moving.

### Known gaps

Being specific about what "reachable by `baseUrl`" does **not** cover, so nobody
follows the table above into a 404:

- **AWS Bedrock's native runtime** posts to `/model/{modelId}/invoke`, wants
  `anthropic_version` in the body, rejects a `model` field, and signs with SigV4.
- **Vertex AI's Anthropic surface** posts to
  `…/publishers/anthropic/models/{model}:rawPredict`.

Neither serves the Messages shape at the path this provider uses, so neither is
reachable by `baseUrl` alone. Vertex's *Gemini* surface is, and is tested.

Treat this list as **dated, not authoritative**. Vendors keep adding
OpenAI- and Anthropic-compatible surfaces alongside their native ones, and any of
these gaps may already have closed via a compatibility endpoint. Check the
provider's current documentation before concluding something is unreachable — and
if a compatible surface exists, it needs no code here, only a `baseUrl`.

---

## Fail closed

**An unsupported parameter must raise. It must never be silently dropped.**

A request whose JSON constraint or reasoning budget was quietly discarded still returns a fluent, plausible completion, and nothing in the result records that the governing instruction was lost. For a layer whose purpose is provable execution, that is the one unacceptable failure mode — worse than an error, because it is invisible.

Each provider therefore declares the `Capability` set it can actually express, and the router rejects anything else by name before a request is sent:

```
UnsupportedCapabilityError: Wire shape "anthropic" cannot express "responseFormat.type=json"
```

What a shape declares it can encode is a **conservative snapshot**, maintained by hand against provider documentation. Providers add parameters faster than this file is updated, so the sets will lag — and when they lag, they lag *closed*: a caller gets a clear `UnsupportedCapabilityError` for something the provider has since started accepting. That is the safe direction to be wrong in, but it is still wrong, and widening a set as providers move is expected maintenance rather than a redesign.

The sets also describe **protocols, not endpoints**. `openai-chat` can encode `stream` and `response_format`; a particular server behind that protocol may reject both, or accept and silently ignore them. The router cannot close that gap — only the endpoint knows what it honours. Endpoint and model capability profiles are a controller concern.

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
- **`endpoint`** — `{ provider, baseUrl?, apiKey, headers? }`. `provider` is a **wire shape** and is required; there is no inference. `headers` merge over the router's own and are the seam for auth the router does not perform (Cloudflare Access, Azure `api-key`, a Vertex bearer minted by the controller).
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
  tokenSource: "reported" | "partial" | "unreported";
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

`"reported"` deliberately does not say *measured*. It means the endpoint sent these numbers, and no more than that: an endpoint may itself be estimating — a CLI bridge deriving counts at roughly four characters per token because the tool it wraps reports none. The router cannot distinguish that from a metered count, so it does not claim to.

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

That rule was unenforceable while the package sat at 0.x, which has no major number to bump — the gap that made an earlier draft of this release claim to follow a rule it could not. **The package is therefore moving to 1.0.0**, where the rule works as written and `^1.x` gives callers the protection `^0.x` never did.

`1.0.0` was held behind a live-endpoint gate rather than a green test suite, and shipped once [`docs/VERIFIED.md`](./docs/VERIFIED.md) recorded all five rows passing against real providers. The mocked suite is necessary and proved insufficient three times: two independent reviews and the live runs each found defects behind it. Any future release that changes transport, classification, or token reporting should re-run [`SMOKE_TEST.md`](./docs/SMOKE_TEST.md) before promotion.

Adding new wire shapes, new encodable features, or new optional fields is non-breaking. Narrowing what a shape declares it can encode is breaking.

---

## Governing Status

This document governs Phase 1.

Every implementation decision in this repository must be checkable against the rules above. If a proposed change is justified by the inclusion list and does not violate the exclusion list, it is in scope. Otherwise it belongs in a controller layer outside this repository.

Phase 2 (versioned spec, **capability negotiation**, multi-language ports, sidecar proxy) will not begin until at least two real projects have used Phase 1 in production for thirty days.

An earlier draft of this release deleted "capability negotiation" from that sentence, because capability declaration had shipped in Phase 1. That was the wrong repair: it relaxed a constraint to fit an implementation. The words are restored, and the distinction the draft should have drawn is made explicit instead.

**Protocol encodability declaration — permitted in Phase 1, and shipped.** A provider states which request features its own wire format can encode. This is a fixed property of a schema, known at author time, requiring no discovery and no per-model data. The router already had to know it; it previously acted on that knowledge by silently discarding parameters, which is the failure `UnsupportedCapabilityError` replaces.

**Capability negotiation — still Phase 2, still out of scope.** Discovering what a specific *endpoint*, *account*, or *model* supports; probing an endpoint's advertised features; maintaining per-model context windows or feature tables; selecting a model or route from any of the above. All of it is deployment fact rather than protocol fact, all of it goes stale, and all of it belongs to the controller.

The test: if answering "can this be encoded?" requires knowing anything beyond which schema is being spoken, it is negotiation and it does not go here.
