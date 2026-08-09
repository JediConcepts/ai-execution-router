/**
 * Usage and attempt callbacks.
 *
 * The router emits a UsageRecord per successful call and an AttemptRecord per
 * attempt — including failures. The caller decides what to do with each: log
 * to a file, send to a metrics backend, ignore. The router itself never writes
 * to disk or stdout.
 *
 * The two are separate on purpose. `onUsage` is what you bill from; it fires
 * only on success. `onAttempt` is what you audit from; a failed call is an
 * event worth recording but not a charge worth raising.
 *
 * Note `tokenSource` on the usage record. When a provider reports no usage the
 * router emits zeroes labelled "unreported" rather than estimating, so a cost
 * model downstream can decline to price the call instead of pricing a guess.
 */
import { appendFile } from "node:fs/promises";
import { complete } from "../src/router/index.ts";
import type { AttemptRecord, UsageRecord } from "../src/router/index.ts";

const USAGE_LOG = "./router-usage.jsonl";
const ATTEMPT_LOG = "./router-attempts.jsonl";

async function appendJsonLine(path: string, record: unknown): Promise<void> {
  await appendFile(path, JSON.stringify(record) + "\n");
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("Set ANTHROPIC_API_KEY to run this example.");
  process.exit(1);
}

const result = await complete({
  task: "ping",
  model: "claude-haiku-4-5",
  input: { messages: [{ role: "user", content: "Reply with the word: pong" }] },
  endpoint: { provider: "anthropic", apiKey },
  onUsage: (record: UsageRecord) => appendJsonLine(USAGE_LOG, record),
  onAttempt: (record: AttemptRecord) => appendJsonLine(ATTEMPT_LOG, record),
});

console.log(`Reply: ${result.text}`);
console.log(`Token counts are ${result.tokenSource}.`);
console.log(`Provider request id: ${result.providerRequestId ?? "(not reported)"}`);
console.log(`Usage logged to ${USAGE_LOG}, attempts to ${ATTEMPT_LOG}`);
