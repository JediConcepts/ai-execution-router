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

If a future contribution attempts to add any of the above, it must be rejected. These responsibilities belong to the controller layer in a separate repository.

---

## What the Router MAY Include

The public router may include:

- provider transport (HTTP clients to model APIs)
- model catalog lookup (model name → endpoint, factual only)
- protocol normalization (translating between provider message and content formats)
- single protocol-level 429 retry, only when a `retry-after` value is explicitly supplied by the provider
- typed errors (`RateLimitError`, `TransientError`, `PermanentError`, `AuthError`, `LLMError`)
- usage callback emission (the router emits; the caller decides what to do with it)
- latency and token reporting

Anything not on this list does not belong in the router.

---

## Canonical Public API

```ts
complete({
  task,         // opaque label, passed through to onUsage; never interpreted
  model,        // required; fully resolved by the caller
  input,        // { system?, messages }
  temperature,  // optional
  maxTokens,    // optional
  endpoint,     // optional explicit transport override
  onUsage,      // optional callback receiving the usage record
})
```

This shape is stable for Phase 1. Any addition to this signature must be justified against the boundary rules above.

### Field Semantics

- **`task`** — an opaque label provided by the caller. The router does not interpret it. It is passed through verbatim to `onUsage` for the caller's tracking.
- **`model`** — a fully resolved model identifier. The caller is responsible for resolution. The router does not understand task-to-model mapping, preferences, or overrides.
- **`input`** — provider-neutral message structure. Normalized internally to each provider's wire format.
- **`temperature`**, **`maxTokens`** — provider-standard knobs. Passed through without interpretation.
- **`endpoint`** — optional `{ provider, baseUrl?, apiKey? }` override. If absent, resolved via the model catalog.
- **`onUsage`** — optional callback receiving a `UsageRecord`. The router emits; the caller logs, persists, audits, or ignores. The router itself does not write to disk, stdout, or any external sink.

---

## Behavioral Guarantees

- The router calls one provider, once, per `complete()` invocation.
- The router performs at most one additional call: a single retry on 429 when the provider supplies an explicit `retry-after`. No other retries.
- The router does not chain providers, fall back, fail over, or substitute models.
- The router does not log to stdout or stderr by default.
- The router does not persist state.
- The router throws typed errors and lets the caller decide what to do.

---

## Errors

The router classifies and labels errors. **It does not act on them.**

| Error class | Meaning | What the router does | What the caller decides |
|---|---|---|---|
| `RateLimitError` | Provider returned 429 | Retries once if `retry-after` was explicitly supplied; otherwise throws | Whether to retry on a different provider, queue, or fail |
| `TransientError` | Network drop, socket reset, 5xx | Throws | Whether to retry |
| `PermanentError` | Model not found, context overflow, malformed request | Throws | Whether to fall back to a different model or fail |
| `AuthError` | 401 or 403 | Throws | Surface to ops; do not retry |
| `LLMError` | Catch-all base class | Throws | Inspect `cause` |

The labels are factual descriptions of the API response. They are not retry instructions. The decision to retry, switch provider, fall back, or fail belongs entirely to the controller.

---

## Usage Records

```ts
interface UsageRecord {
  task?: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  timestamp: string;  // ISO 8601
}
```

The router emits one `UsageRecord` per successful `complete()` call via the optional `onUsage` callback. The router does not compute cost, attach context beyond these fields, or persist the record. Cost calculation, persistence, attribution, and audit are controller concerns.

---

## Model Catalog

The repository ships a small, factual catalog mapping model identifiers to transport endpoints (e.g. `claude-sonnet-4-6` → Anthropic native API; `meta/llama-3.3-70b-instruct` → OpenAI-compatible at `https://integrate.api.nvidia.com/v1`).

The catalog is:

- **factual** — it records where a model can be reached, nothing more
- **extensible** — callers may pass `endpoint` to override or add transports
- **policy-free** — it does not encode preference, ordering, fallback, trust, cost, or task suitability

---

## Versioning

The canonical API is the contract. Breaking changes to the `complete()` signature, the `UsageRecord` shape, or the error class hierarchy require a major version bump.

Adding new providers, new models to the catalog, or new optional fields is non-breaking.

---

## Governing Status

This document governs Phase 1.

Every implementation decision in this repository must be checkable against the rules above. If a proposed change is justified by the inclusion list and does not violate the exclusion list, it is in scope. Otherwise it belongs in a controller layer outside this repository.

Phase 2 (versioned spec, capability negotiation, multi-language ports, sidecar proxy) will not begin until at least two real projects have used Phase 1 in production for thirty days.
