/**
 * External fallback example.
 *
 * The router itself does not fall back. Fallback strategy is a controller
 * concern: this example is a thin caller-side wrapper that tries a list of
 * candidates in order and decides which errors should pass through to the next
 * attempt.
 *
 * The interesting part is the error taxonomy. A 429 arrives for two completely
 * different reasons and the correct response to each is the opposite of the
 * other:
 *
 *   RateLimitError      transient — the same candidate will work shortly
 *   QuotaExhaustedError spent credit — this candidate is done for the day
 *
 * A controller that treats them alike will sit out a full quota window before
 * failing over to a candidate that would have answered immediately. Because
 * QuotaExhaustedError extends PermanentError rather than RateLimitError, the
 * ordering of the checks below does that for free.
 */
import {
  AuthError,
  complete,
  ContextLengthError,
  PermanentError,
  QuotaExhaustedError,
  RateLimitError,
  TransientError,
} from "../src/router/index.ts";
import type { Endpoint } from "../src/router/index.ts";

interface Candidate {
  label: string;
  model: string;
  endpoint: Endpoint;
}

async function callWithFallback(
  task: string,
  prompt: string,
  candidates: Candidate[],
): Promise<string> {
  let lastError: unknown;

  for (const c of candidates) {
    try {
      const r = await complete({
        task,
        model: c.model,
        input: { messages: [{ role: "user", content: prompt }] },
        endpoint: c.endpoint,
        timeoutMs: 60_000,
      });
      console.log(`[${c.label}] answered in ${r.latencyMs}ms`);
      return r.text;
    } catch (err) {
      lastError = err;

      // Never retriable, and never someone else's problem to absorb.
      if (err instanceof AuthError) throw err;

      if (err instanceof QuotaExhaustedError) {
        console.warn(`[${c.label}] quota spent — moving on immediately, not waiting`);
        continue;
      }
      if (err instanceof RateLimitError) {
        // The router already honoured one explicit retry-after. Beyond that,
        // whether to wait or move on is this wrapper's call, not the router's.
        console.warn(`[${c.label}] rate limited — moving on`);
        continue;
      }
      if (err instanceof ContextLengthError) {
        console.warn(`[${c.label}] payload too large — a bigger-context candidate may take it`);
        continue;
      }
      if (err instanceof TransientError || err instanceof PermanentError) {
        console.warn(`[${c.label}] ${(err as Error).name} — moving on`);
        continue;
      }
      throw err;
    }
  }

  throw new Error(`all candidates failed: ${String((lastError as Error)?.message)}`);
}

const nvidiaKey = process.env.NVIDIA_API_KEY;
const anthropicKey = process.env.ANTHROPIC_API_KEY;
if (!nvidiaKey || !anthropicKey) {
  console.error("Set NVIDIA_API_KEY and ANTHROPIC_API_KEY to run this example.");
  process.exit(1);
}

const text = await callWithFallback(
  "one-sentence",
  "Write one short sentence about the number forty-two.",
  [
    {
      label: "nvidia-free",
      model: "meta/llama-3.1-8b-instruct",
      // A different supplier is a baseUrl, not a different provider.
      endpoint: {
        provider: "openai-chat",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: nvidiaKey,
      },
    },
    {
      label: "anthropic-paid",
      model: "claude-haiku-4-5",
      endpoint: { provider: "anthropic", apiKey: anthropicKey },
    },
  ],
);

console.log(text);
