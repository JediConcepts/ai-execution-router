/**
 * Usage callback example.
 *
 * The router emits a UsageRecord per successful call. The caller decides
 * what to do with it: log to a file, send to a metrics backend, ignore,
 * or anything else. The router itself never writes to disk or stdout.
 *
 * Here we append each record as one JSON line to a local file.
 */
import { appendFile } from "node:fs/promises";
import { complete } from "../src/router/index.ts";
import type { UsageRecord } from "../src/router/index.ts";

const LOG_PATH = "./router-usage.jsonl";

async function appendJsonLine(record: UsageRecord): Promise<void> {
  await appendFile(LOG_PATH, JSON.stringify(record) + "\n");
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
  endpoint: { apiKey },
  onUsage: appendJsonLine,
});

console.log(`Reply: ${result.text}`);
console.log(`Usage logged to ${LOG_PATH}`);
