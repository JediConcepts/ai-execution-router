# AI Execution Router

A deterministic execution engine for LLM calls. One function: `complete()`. It takes a fully resolved request, calls one provider, returns one result.

Built for systems where model execution must remain predictable, auditable, and separate from policy, routing, fallback, cost, and governance decisions.

## Why this exists

Most AI applications are welded to one provider. That is a single point of failure dressed up as convenience. Models change, pricing changes, terms change, access gets rationed, and the customer rarely controls the switch.

This is the execution kernel for systems that need to keep control of where AI runs, where data goes, and how decisions are proven, independent of any one vendor.

## The Boundary

> The router executes. The controller decides.

This is the **execution layer**. Policy lives in a thin caller side controller wrapping `complete()`: the task → model mapping, fallback chains, cost guards, audit, and gating. The router itself never decides.

```text
Application
      │
      ▼
Governance Controller     policy, routing, failover, audit, cost
      │
      ▼
AI Execution Router       this repo: deterministic execution only
      │
 ┌────┼────┬────┐
 ▼    ▼    ▼    ▼
 OpenAI  Anthropic  NVIDIA  Local / Private
```

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the governing rules.

## Minimal Example

```ts
import { complete } from "./src/router/index.ts";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

const r = await complete({
  task: "summarize",
  model: "claude-haiku-4-5",
  input: {
    messages: [{ role: "user", content: "What is the capital of France?" }],
  },
  endpoint: { apiKey },
});

console.log(r.text);
```

The caller reads `process.env`. The router does not.

## What the Router Does

- Calls one provider, once.
- Retries exactly once if (and only if) the provider returned `429` with an explicit `retry-after`.
- Throws typed errors: `RateLimitError`, `TransientError`, `PermanentError`, `AuthError`, `LLMError`.
- Emits one `UsageRecord` to the optional `onUsage` callback on success.

## What the Router Does NOT Do

- Read environment variables.
- Write to disk, stdout, or stderr.
- Fall back to other providers, substitute models, or chain attempts.
- Decide whether a request is allowed.
- Enforce cost, quotas, or budgets.
- Persist any state.
- Log, audit, or trace by default.
- Embed domain or regulatory logic.

## Layout

```
src/router/             zero-runtime-dependency router source
tests/                  node:test suite
examples/               runnable examples (basic, fallback, usage logging)
docs/                   phase 2 spec plan
.claude/skills/         Claude Code skill bundle
ARCHITECTURE.md         governing document
```

## Requirements

- Node 20 or later (uses native `fetch` and TypeScript type-stripping).

## Running

```sh
npm install
npm test
```

## Status

Phase 1: this repo is the execution kernel.

It is also the open core of a governed multi provider pipeline that runs in production, where a controller wraps this kernel and adds per stage policy routing, automatic failover across providers, data classification, and audit. A live deployment runs inside a forensic litigation platform, routing real workloads and failing over across providers when one goes dark, with every switch written to a log.

See [`docs/PHASE_2_SPEC_PLAN.md`](./docs/PHASE_2_SPEC_PLAN.md) for what is coming to the open core, and `ARCHITECTURE.md` for what will not be added.
