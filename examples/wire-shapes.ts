/**
 * The same prompt, across all three wire shapes, streaming.
 *
 * This is the claim the architecture rests on: one call site, three unrelated
 * request schemas, and the only thing that varies is the endpoint. Nothing
 * below branches on which vendor is answering.
 *
 * Run with whichever keys you have set — each shape is skipped if its key is
 * absent.
 */
import { complete, UnsupportedCapabilityError } from "../src/router/index.ts";
import type { CompleteParams, Endpoint } from "../src/router/index.ts";

interface Target {
  label: string;
  model: string;
  endpoint: Endpoint;
  /** Each shape spells "think harder" in its own currency. See below. */
  reasoning?: CompleteParams["reasoning"];
}

const targets: Target[] = [];

if (process.env.ANTHROPIC_API_KEY) {
  targets.push({
    label: "anthropic",
    model: "claude-haiku-4-5",
    endpoint: { provider: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY },
  });
}

if (process.env.NVIDIA_API_KEY) {
  targets.push({
    label: "openai-chat (NVIDIA NIM)",
    model: "meta/llama-3.3-70b-instruct",
    endpoint: {
      provider: "openai-chat",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiKey: process.env.NVIDIA_API_KEY,
    },
  });
}

if (process.env.GEMINI_API_KEY) {
  targets.push({
    label: "google-genai",
    model: "gemini-2.5-flash",
    endpoint: { provider: "google-genai", apiKey: process.env.GEMINI_API_KEY },
  });
}

if (targets.length === 0) {
  console.error("Set at least one of ANTHROPIC_API_KEY, NVIDIA_API_KEY, GEMINI_API_KEY.");
  process.exit(1);
}

for (const t of targets) {
  process.stdout.write(`\n── ${t.label} ──\n`);

  const result = await complete({
    task: "haiku",
    model: t.model,
    input: {
      system: "Answer in one short line.",
      messages: [{ role: "user", content: "Why is vendor neutrality worth paying for?" }],
    },
    endpoint: t.endpoint,
    maxTokens: 256,
    timeoutMs: 60_000,
    // Streaming does not change the return type — one call, one result.
    onDelta: (chunk) => process.stdout.write(chunk),
  });

  process.stdout.write(
    `\n   ${result.promptTokens} in / ${result.completionTokens} out ` +
    `(${result.tokenSource}) · ${result.latencyMs}ms · finish=${result.finishReason ?? "?"}\n`,
  );
}

/**
 * And the refusal, demonstrated deliberately.
 *
 * `reasoning.effort` is an enum; `reasoning.budgetTokens` is a token count.
 * Converting one into the other is a cost/quality judgement, so a wire shape
 * that understands only one of them rejects the other by name rather than
 * dropping it and returning a confident answer that ignored the instruction.
 */
if (process.env.ANTHROPIC_API_KEY) {
  try {
    await complete({
      model: "claude-haiku-4-5",
      input: { messages: [{ role: "user", content: "hi" }] },
      endpoint: { provider: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY },
      reasoning: { effort: "high" },
    });
  } catch (err) {
    if (!(err instanceof UnsupportedCapabilityError)) throw err;
    console.log(`\n── fail closed ──\n   ${err.message}`);
  }
}
