---
name: ai-routing
description: Use this skill when adding multi-provider LLM execution to a project — calling Anthropic, NVIDIA NIM, Ollama, OpenRouter, or any OpenAI-compatible endpoint behind a single deterministic call. The skill ships a pure execution engine. Policy (task→model mapping, fallback chains, cost guards, audit, gating) belongs in a thin caller-side controller, never inside the router.
---

# AI Routing Skill

A pure execution engine for LLM calls. One function: `complete()`. It takes a fully resolved request, calls one provider, returns one result, throws typed errors on failure.

The router executes. The controller decides.

## Two Layers

This skill ships only the **execution layer**. The host project writes the **control layer**.

| Concern | Where it lives |
|---|---|
| Provider HTTP transport, message format translation | Router |
| Single 429 retry when `retry-after` is supplied | Router |
| Typed error labelling, carrying provider `status` / `providerCode` / `requestId` | Router |
| Refusing parameters the wire shape cannot express (fail closed) | Router |
| Request deadlines and caller cancellation | Router |
| `UsageRecord` emission via callback | Router |
| Latency, token, and finish-reason reporting | Router |
| Token reporting labelled with its provenance (`tokenSource`) | Router |
| Task → model resolution | Controller |
| Fallback chains, provider switching | Controller |
| Cost guards, spend caps, budgets | Controller |
| Audit logs, decision trails | Controller |
| Approval gates, human review | Controller |
| Data residency, retention policy | Controller |
| Which model is capable of what (vision, tools, long context) | Controller |
| Any catalog: model → endpoint, preference, cost, trust | Controller |
| Credential acquisition, key pools, key rotation | Controller |

If it is a decision, it goes in the controller.

## The Only API

```ts
import { complete } from "<router-path>";

const result = await complete({
  task,         // optional opaque label, passed through to onUsage; never interpreted
  model,        // required; the caller resolved this
  input: { system?, messages },
  temperature,    // optional
  maxTokens,      // optional
  responseFormat, // optional; refused by shapes that cannot express it
  reasoning,      // optional; { effort } or { budgetTokens } — never converted between them
  endpoint: { provider, baseUrl?, apiKey, headers? },
  timeoutMs,      // optional wall-clock ceiling
  signal,         // optional caller cancellation
  onDelta,        // optional; observe output incrementally, still one result
  onUsage,        // optional; fires once, on success only
  onAttempt,      // optional; fires per attempt, success or failure
});
```

`endpoint.provider` is a **wire shape**, not a vendor, and is required:
`"anthropic"` | `"openai-chat"` | `"google-genai"`. Most suppliers (NVIDIA, Groq,
OpenRouter, Together, Ollama, LM Studio, a local CLI bridge) are `openai-chat`
plus a `baseUrl`. `endpoint.headers` carries transport auth the router does not
perform — Cloudflare Access, Azure `api-key`, a Vertex bearer the controller minted.

### What the router does

- Calls one provider, once.
- Retries at most once, and only on a 429 carrying an explicit `retry-after` of 60s or less.
  A longer wait, or a 429 that is actually spent quota, is returned to you with `retryAfterMs`
  set so you can decide between waiting and failing over.
- Throws a typed error otherwise, carrying the provider's own status and code.
- Refuses unsupported parameters by name rather than dropping them silently.
- Reports token counts with provenance, and never estimates one.
- Emits one `UsageRecord` on success, and one `AttemptRecord` per attempt.

### What the router does not do

- Read environment variables.
- Write to disk, stdout, or stderr.
- Fall back, switch providers, substitute models.
- Decide whether a request is allowed.
- Compute or enforce cost.
- Persist any state.

## Quick Start

```ts
import { complete } from "<router-path>";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

const r = await complete({
  task: "summarize",
  model: "claude-haiku-4-5",
  input: {
    system: "You are a concise summarizer.",
    messages: [{ role: "user", content: "What is the capital of France?" }],
  },
  endpoint: { provider: "anthropic", apiKey },
});

console.log(r.text);
```

The caller reads `process.env`. The router is given a resolved `apiKey`. Missing `apiKey` throws `AuthError`.

## When to Use This Skill

Invoke this skill when a project needs:

- One function to talk to multiple LLM providers.
- Deterministic execution semantics with typed error labelling.
- Pluggable usage tracking via callback.
- Policy (fallback, cost guards, audit) to live in caller code rather than provider plumbing.

## When Not to Use

- Single-provider apps that are happy calling a vendor SDK directly.
- Projects that want policy embedded in their LLM layer — those should still use this skill but build a controller above it.

## Installation

Copy `src/router/` into the host project. Zero runtime dependencies (uses native `fetch`). Node 20+ required.

If the host project transpiles TypeScript itself, the `.ts` extensions on relative imports are tolerated by every modern TS toolchain (`moduleResolution: "bundler"` or `"nodenext"`).

## Next Steps

See `reference/INTEGRATION.md` for:

- The canonical controller pattern (wrapping `complete()`).
- External fallback handling.
- Plugging usage logging into observability stacks.
- What belongs in the controller, never in the router.

## Errors at a Glance

| Error class | Meaning | Caller's typical decision |
|---|---|---|
| `RateLimitError` | 429, transient | Wait, queue, or route elsewhere |
| `QuotaExhaustedError` | 429/402 where credit is spent. A `PermanentError`, **not** a `RateLimitError` | Fail over now — waiting cannot help |
| `TransientError` | Network drop, socket reset, 5xx, malformed body | Retry once, fall back, or fail |
| `TimeoutError` | `timeoutMs` elapsed. A `TransientError` | Retry, perhaps with a longer deadline |
| `ContextLengthError` | Input exceeded the context window. A `PermanentError` | Try a larger-context candidate |
| `ModelUnavailableError` | Unknown or retired model. A `PermanentError` | Substitute a model |
| `UnsupportedCapabilityError` | The wire shape cannot express a parameter. A `PermanentError` | Fix the request or change shape |
| `CancelledError` | The caller's `signal` aborted | Nothing — the caller asked to stop |
| `AuthError` | 401, 403, or missing apiKey | Surface to ops; do not retry |
| `PermanentError` | Malformed request, unclassified 4xx | Fall back or fail |
| `LLMError` | Catch-all base class | Inspect `cause` |

`QuotaExhaustedError` deliberately does **not** extend `RateLimitError`: both are
HTTP 429, and a controller that backs off on both will sit out a full quota window
before failing over to a candidate that would have answered immediately.

The labels are factual, not retry instructions. The decision belongs to the controller.
