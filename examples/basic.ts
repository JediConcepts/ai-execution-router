/**
 * Basic example: a single complete() call.
 *
 * The caller reads its own API key from the environment and supplies it to
 * the router via endpoint.apiKey. The router never reads environment
 * variables itself.
 */
import { complete } from "../src/router/index.ts";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("Set ANTHROPIC_API_KEY to run this example.");
  process.exit(1);
}

const result = await complete({
  task: "summarize",
  model: "claude-haiku-4-5",
  input: {
    system: "You are a concise summarizer. Reply in one sentence.",
    messages: [
      { role: "user", content: "What is the capital of France?" },
    ],
  },
  endpoint: { apiKey },
});

console.log(result.text);
console.log(
  `tokens: ${result.promptTokens} in / ${result.completionTokens} out, ` +
  `${result.latencyMs}ms`,
);
