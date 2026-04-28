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
| Typed error labelling (`RateLimitError`, `TransientError`, `PermanentError`, `AuthError`) | Router |
| `UsageRecord` emission via callback | Router |
| Latency, token, and finish-reason reporting | Router |
| Catalog: model → endpoint (factual) | Router |
| Task → model resolution | Controller |
| Fallback chains, provider switching | Controller |
| Cost guards, spend caps, budgets | Controller |
| Audit logs, decision trails | Controller |
| Approval gates, human review | Controller |
| Data residency, retention policy | Controller |
| Capability negotiation (vision, tools, long context) | Controller |
| Catalog of model preferences, cost, trust | Controller |

If it is a decision, it goes in the controller.

## The Only API

```ts
import { complete } from "<router-path>";

const result = await complete({
  task,         // optional opaque label, passed through to onUsage; never interpreted
  model,        // required; the caller resolved this
  input: { system?, messages },
  temperature,  // optional
  maxTokens,    // optional
  endpoint: { provider?, baseUrl?, apiKey },
  onUsage,      // optional callback receiving one UsageRecord on success
});
```

### What the router does

- Calls one provider, once.
- Retries exactly once if (and only if) the provider returned 429 with an explicit `retry-after`.
- Throws a typed error otherwise.
- Emits one `UsageRecord` to `onUsage` on success.

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
  endpoint: { apiKey },
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
| `RateLimitError` | Provider returned 429 | Try a different provider, queue, or fail |
| `TransientError` | Network drop, socket reset, 5xx | Retry once, fall back, or fail |
| `PermanentError` | Model not found, context overflow, malformed request | Pick a different model or fail |
| `AuthError` | 401, 403, or missing apiKey | Surface to ops; do not retry |
| `LLMError` | Catch-all base class | Inspect `cause` |

The labels are factual, not retry instructions. The decision belongs to the controller.
