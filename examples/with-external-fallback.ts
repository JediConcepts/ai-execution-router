/**
 * External fallback example.
 *
 * The router itself does not fall back. Fallback strategy is a controller
 * concern: this example shows a thin caller-side wrapper that tries a list
 * of providers in order and decides which errors should pass through to
 * the next attempt.
 *
 * The router's job is to execute one call and label any error. The wrapper
 * below decides what to do with each label.
 */
import {
  AuthError,
  complete,
  PermanentError,
  RateLimitError,
  TransientError,
} from "../src/router/index.ts";

interface Attempt {
  model: string;
  apiKey: string;
}

async function callWithFallback(
  task: string,
  prompt: string,
  attempts: Attempt[],
): Promise<string> {
  let lastError: unknown;
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
      lastError = err;
      if (err instanceof AuthError) throw err;
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
  throw new Error(`all attempts failed: ${String((lastError as Error)?.message)}`);
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
    { model: "meta/llama-3.1-8b-instruct", apiKey: nvidiaKey },
    { model: "claude-haiku-4-5", apiKey: anthropicKey },
  ],
);

console.log(text);
