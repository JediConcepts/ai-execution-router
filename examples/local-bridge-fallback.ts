/**
 * Local-bridge-first with cloud fallback.
 *
 * Attempt 1 goes to a local-cli-bridge instance (https://github.com/JediConcepts/local-cli-bridge):
 * an OpenAI-compatible endpoint in front of a locally authenticated CLI
 * (Claude Code / Codex), so bulky dev traffic runs on the workstation's
 * subscription login and the data stays local. Attempt 2 falls back to hosted
 * Anthropic when the bridge is down, busy, or failing.
 *
 * As always, the router executes ONE call and labels any error; the fallback
 * order lives here in the caller. The bridge's endpoint is deliberately NOT in
 * the router's catalog — a loopback port is deployment configuration, not a
 * global model→endpoint fact — so the attempt passes an explicit `endpoint`.
 *
 * Worth knowing when pointing the router at a bridge:
 *  - The router has no client-side timeout; a hung call is bounded by the
 *    bridge's own BRIDGE_TIMEOUT_MS (default 15 minutes). Lower it on the
 *    bridge if your callers can't wait that long.
 *  - A TUNNEL-exposed bridge (Cloudflare) delivers late failures as an
 *    {"error":...} body on a committed 200. The openai-compatible provider
 *    detects that shape and raises TransientError, so the fallback below
 *    genuinely triggers — this is covered by a router test, not just this
 *    comment. A LOCAL bridge (0.2.0+, keepalive "auto") returns real status
 *    codes: 429 → RateLimitError, 5xx → TransientError, same outcome.
 *  - Bridge token counts are estimates (~4 chars/token), fine for latency
 *    attribution, soft for cost accounting.
 *
 * Run:
 *   npx local-cli-bridge                     # in another terminal, CLI logged in
 *   BRIDGE_API_KEY=... ANTHROPIC_API_KEY=... npx tsx examples/local-bridge-fallback.ts
 */
import {
  AuthError,
  complete,
  PermanentError,
  RateLimitError,
  TransientError,
} from "../src/router/index.ts";
import type { Endpoint } from "../src/router/types.ts";

interface Attempt {
  label: string;
  model: string;
  endpoint: Endpoint;
}

async function callWithFallback(prompt: string, attempts: Attempt[]): Promise<string> {
  let lastError: unknown;
  for (const a of attempts) {
    try {
      const r = await complete({
        task: "bridge-fallback-demo",
        model: a.model,
        input: { messages: [{ role: "user", content: prompt }] },
        endpoint: a.endpoint,
      });
      console.error(`[example] served by: ${a.label} (${r.latencyMs}ms)`);
      return r.text;
    } catch (err) {
      lastError = err;
      console.error(`[example] ${a.label} failed: ${(err as Error).name}: ${(err as Error).message}`);
      if (
        err instanceof RateLimitError ||
        err instanceof TransientError ||
        err instanceof PermanentError ||
        err instanceof AuthError // a down/misconfigured bridge shouldn't strand the caller
      ) {
        continue;
      }
      throw err;
    }
  }
  throw new Error(`all attempts failed: ${String((lastError as Error)?.message)}`);
}

const anthropicKey = process.env.ANTHROPIC_API_KEY;
if (!anthropicKey) {
  console.error("Set ANTHROPIC_API_KEY (cloud fallback). Optional: BRIDGE_BASE_URL, BRIDGE_API_KEY, BRIDGE_MODEL.");
  process.exit(1);
}

// The router refuses an empty apiKey (AuthError before any request), so a
// keyless loopback bridge gets a placeholder — the bridge ignores the header
// when BRIDGE_API_KEY is unset on its side. If the bridge HAS a key, set the
// same BRIDGE_API_KEY here or every attempt will 401.
const bridgeKey = process.env.BRIDGE_API_KEY || "local";

const text = await callWithFallback(
  "Write one short sentence about the number forty-two.",
  [
    {
      label: "local bridge",
      model: process.env.BRIDGE_MODEL || "sonnet",
      endpoint: {
        provider: "openai-compatible",
        baseUrl: process.env.BRIDGE_BASE_URL || "http://127.0.0.1:8787/v1",
        apiKey: bridgeKey,
      },
    },
    {
      label: "hosted anthropic",
      model: "claude-haiku-4-5",
      endpoint: { apiKey: anthropicKey },
    },
  ],
);

console.log(text);
