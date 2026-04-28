# Integration Guide

> The router executes. The controller decides.

This guide shows how to wrap `complete()` in a caller-side controller. The router stays untouched; everything below is host-project code.

---

## Minimal Controller

A controller can be as simple as a one-function wrapper that handles env lookup and calls `complete()`:

```ts
import { complete } from "<router-path>";

export async function ask(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const r = await complete({
    task: "ask",
    model: "claude-haiku-4-5",
    input: { messages: [{ role: "user", content: prompt }] },
    endpoint: { apiKey },
  });
  return r.text;
}
```

The controller reads `process.env`. The router never does. The router is given a resolved `apiKey` via `endpoint.apiKey`. If `apiKey` is missing, the router throws `AuthError`.

---

## Pattern: Task → Model Mapping

The router does not know how to map task labels to models. The controller does.

```ts
const TASK_MODELS = {
  summarize: "claude-haiku-4-5",
  reason:    "claude-opus-4-7",
  classify:  "meta/llama-3.1-8b-instruct",
} as const;

type TaskName = keyof typeof TASK_MODELS;

async function run(task: TaskName, prompt: string) {
  return complete({
    task,
    model: TASK_MODELS[task],
    input: { messages: [{ role: "user", content: prompt }] },
    endpoint: { apiKey: keyFor(TASK_MODELS[task]) },
  });
}
```

The router treats `task` as an opaque string and passes it through to `onUsage`. Mapping is a decision, so it lives in the controller.

---

## Pattern: External Fallback

The router never falls back. To get fallback, write a wrapper:

```ts
import {
  AuthError,
  complete,
  PermanentError,
  RateLimitError,
  TransientError,
} from "<router-path>";

interface Attempt {
  model: string;
  apiKey: string;
}

export async function callWithFallback(
  task: string,
  prompt: string,
  attempts: Attempt[],
): Promise<string> {
  let last: unknown;
  for (const a of attempts) {
    try {
      const r = await complete({
        task,
        model: a.model,
        input: { messages: [{ role: "user", content: prompt }] },
        endpoint: { apiKey: a.apiKey },
      });
      return r.text;
    } catch (err) {
      last = err;
      if (err instanceof AuthError) throw err; // never silently retry on auth
      if (
        err instanceof RateLimitError ||
        err instanceof TransientError ||
        err instanceof PermanentError
      ) {
        continue;
      }
      throw err;
    }
  }
  throw new Error(`all attempts failed: ${(last as Error)?.message ?? "unknown"}`);
}
```

The router gives typed labels; the controller decides which labels mean "try the next attempt" versus "fail loudly". Treat `AuthError` as terminal: a misconfigured key should not silently mask itself by falling through.

---

## Pattern: Usage Logging

The router emits one `UsageRecord` per successful call via `onUsage`. The controller decides what to do with it.

```ts
import { complete } from "<router-path>";
import type { UsageRecord } from "<router-path>";
import { appendFile } from "node:fs/promises";

async function logUsage(r: UsageRecord): Promise<void> {
  await appendFile("./usage.jsonl", JSON.stringify(r) + "\n");
}

await complete({
  task: "ping",
  model: "claude-haiku-4-5",
  input: { messages: [{ role: "user", content: "Reply with: pong" }] },
  endpoint: { apiKey: process.env.ANTHROPIC_API_KEY! },
  onUsage: logUsage,
});
```

For metrics, send the record to a collector. For audit, write to a database. For nothing, omit `onUsage`. The router has no opinion.

`onUsage` is invoked only on success. On failure, the router throws and `onUsage` is not called — failure handling is the caller's concern.

---

## Pattern: Pre-Execution Guards

The router has no cost guards, rate caps, or approval gates. They live in the controller, before the call:

```ts
async function ask(task: string, prompt: string): Promise<string> {
  await checkSpendBudget(task);    // throws if over budget
  await requireApproval(task);     // throws if denied
  const r = await complete({
    task,
    model: pickModel(task),
    input: { messages: [{ role: "user", content: prompt }] },
    endpoint: { apiKey: keyFor(task) },
    onUsage: recordUsage,
  });
  await audit(task, r);            // post-call hook in controller
  return r.text;
}
```

If a guard throws, `complete()` is never called. If `complete()` throws, the guards still ran. The router has no opinion about any of this.

---

## Pattern: Capability-Aware Routing

The router does not know which models support vision, tools, or long context. The controller picks an appropriate model:

```ts
function pickModel(needs: { vision?: boolean; longContext?: boolean }): string {
  if (needs.vision)      return "meta/llama-3.2-90b-vision-instruct";
  if (needs.longContext) return "claude-sonnet-4-6";
  return "claude-haiku-4-5";
}
```

Catalog data about model capabilities lives in the controller. The router only knows where each model can be reached, not what it is good at.

---

## Pattern: Custom Endpoints (Self-Hosted, Local, Private)

The router resolves endpoints from a built-in catalog only when no `endpoint` is supplied. Pass `endpoint` to override:

```ts
await complete({
  model: "my-org/my-tuned-model",
  input: { messages: [{ role: "user", content: "hi" }] },
  endpoint: {
    provider: "openai-compatible",
    baseUrl: "https://llm.internal.example/v1",
    apiKey: process.env.INTERNAL_LLM_KEY!,
  },
});
```

For local Ollama:

```ts
endpoint: {
  provider: "openai-compatible",
  baseUrl: "http://localhost:11434/v1",
  apiKey: "ollama", // any non-empty string; Ollama ignores it
}
```

Whether a request *should* go to a local model rather than the cloud is a controller decision — not the router's.

---

## What Goes in the Router (and What Does Not)

| In the router | In the controller |
|---|---|
| Provider HTTP transport | Task → model resolution |
| Message and content format translation | Provider preference and trade-offs |
| Single 429 retry when `retry-after` is supplied | Multi-provider fallback chains |
| Typed error labels | What to do with each label |
| Latency, token, finish-reason reporting | Spend caps, budgets, gating |
| `onUsage` callback emission | Usage persistence (DB, metrics, audit logs) |
| Catalog: model → endpoint (factual) | Catalog: model → suitability, cost, trust, capability |

When in doubt: if it is a decision, it goes in the controller.

---

## Anti-Patterns

Do not:

- **Add fallback inside the router.** Wrap `complete()` in a controller instead.
- **Read `process.env` from router code.** The controller resolves `apiKey` and passes it via `endpoint`.
- **Log to stdout from the router.** Use `onUsage` and let the controller route the record where it belongs.
- **Store model preferences in the catalog.** The catalog is factual (model → endpoint). Preference is policy.
- **Add capability flags to the catalog.** Capability awareness is a controller concern.
- **Add "if regulated, do X" branches to router code.** Regulatory awareness belongs in a controller written for that regulated context.

If a proposed router change feels like a decision, it is policy, and it belongs in the controller layer, not in this skill.
