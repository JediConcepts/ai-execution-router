/**
 * Live smoke run.
 *
 * Every other test in this repository mocks `fetch`. That suite has now been
 * fully green twice while two independent reviews found real bugs behind it, so
 * this file exists to check the things a mock cannot: that the wire formats are
 * actually accepted, that usage really is reported, that errors really do arrive
 * as the taxonomy claims, and that streaming frames really do parse.
 *
 * It calls real endpoints and spends real (tiny) money. Prompts are a handful of
 * tokens and `maxTokens` is capped at 32; a full run is fractions of a cent.
 *
 * Targets whose credentials are absent are skipped, not failed — run whichever
 * subset you have keys for. See docs/SMOKE_TEST.md for setup.
 *
 *   node scripts/smoke.mjs            # every configured target
 *   node scripts/smoke.mjs vertex     # just one
 */

import {
  complete,
  LLMError,
  ModelUnavailableError,
  UnsupportedCapabilityError,
} from "../src/router/index.ts";

const PROMPT = { messages: [{ role: "user", content: "Reply with exactly: PONG" }] };
const MAX_TOKENS = 32;

// ── Target definitions ────────────────────────────────────────────────────────

const env = (...names) => names.map((n) => process.env[n]).find(Boolean);

function targets() {
  const out = [];

  const anthropicKey = env("ANTHROPIC_API_KEY");
  if (anthropicKey) {
    out.push({
      name: "anthropic",
      model: env("SMOKE_ANTHROPIC_MODEL") ?? "claude-haiku-4-5",
      endpoint: { provider: "anthropic", apiKey: anthropicKey },
      // The Messages API has no response_format field; the router must say so.
      refuses: { responseFormat: { type: "json" } },
    });
  }

  const geminiKey = env("GEMINI_API_KEY", "GOOGLE_API_KEY");
  if (geminiKey) {
    out.push({
      name: "gemini-developer",
      model: env("SMOKE_GEMINI_MODEL") ?? "gemini-2.5-flash",
      endpoint: { provider: "google-genai", apiKey: geminiKey },
      supportsJson: true,
    });
  }

  const vertexToken = env("VERTEX_ACCESS_TOKEN");
  const vertexProject = env("VERTEX_PROJECT", "GOOGLE_CLOUD_PROJECT");
  const vertexRegion = env("VERTEX_REGION") ?? "us-central1";
  if (vertexToken && vertexProject) {
    out.push({
      name: "vertex",
      model: env("SMOKE_VERTEX_MODEL") ?? "gemini-2.5-flash",
      endpoint: {
        provider: "google-genai",
        baseUrl:
          `https://${vertexRegion}-aiplatform.googleapis.com/v1` +
          `/projects/${vertexProject}/locations/${vertexRegion}/publishers/google`,
        // No apiKey at all — the bearer IS the credential. This is the case the
        // router had to grow a rule for, so it is the case most worth proving.
        headers: { Authorization: `Bearer ${vertexToken}` },
      },
      supportsJson: true,
    });
  }

  const nvidiaKey = env("NVIDIA_API_KEY");
  if (nvidiaKey) {
    out.push({
      name: "nvidia (openai-chat)",
      model: env("SMOKE_NVIDIA_MODEL") ?? "meta/llama-3.3-70b-instruct",
      endpoint: {
        provider: "openai-chat",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: nvidiaKey,
      },
      supportsJson: true,
    });
  }

  const bridgeUrl = env("BRIDGE_URL") ?? (env("SMOKE_BRIDGE") ? "http://127.0.0.1:8787/v1" : undefined);
  if (bridgeUrl) {
    out.push({
      name: "local-cli-bridge",
      model: env("SMOKE_BRIDGE_MODEL") ?? "sonnet",
      endpoint: {
        provider: "openai-chat",
        baseUrl: bridgeUrl,
        apiKey: env("BRIDGE_API_KEY") ?? "none",
      },
      // The bridge deliberately 400s on streaming rather than ignoring it. A
      // clean typed error here is a PASS: it proves both sides fail loudly.
      streamingRejected: true,
      slow: true,
    });
  }

  return out;
}

// ── Harness ───────────────────────────────────────────────────────────────────

const results = [];
let indent = "";

function pass(what, detail) {
  results.push({ ok: true });
  console.log(`${indent}  \x1b[32m✓\x1b[0m ${what}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
}
function fail(what, detail) {
  results.push({ ok: false, what, detail });
  console.log(`${indent}  \x1b[31m✗\x1b[0m ${what}\n${indent}      \x1b[31m${detail}\x1b[0m`);
}
function warn(what, detail) {
  results.push({ ok: true, warned: true });
  console.log(`${indent}  \x1b[33m!\x1b[0m ${what}  \x1b[2m${detail}\x1b[0m`);
}

async function check(what, fn) {
  try {
    const detail = await fn();
    pass(what, detail);
  } catch (err) {
    fail(what, `${err?.name ?? "Error"}: ${String(err?.message ?? err).slice(0, 200)}`);
  }
}

// ── The checks ────────────────────────────────────────────────────────────────

async function runTarget(t) {
  console.log(`\n\x1b[1m── ${t.name}\x1b[0m  \x1b[2m${t.model}\x1b[0m`);
  const timeoutMs = t.slow ? 900_000 : 60_000;
  const base = { model: t.model, endpoint: t.endpoint, maxTokens: MAX_TOKENS, timeoutMs };

  let buffered;

  await check("buffered call returns text", async () => {
    buffered = await complete({ ...base, task: "smoke", input: PROMPT });
    if (!buffered.text?.trim()) throw new Error("empty text on a successful call");
    return JSON.stringify(buffered.text.trim().slice(0, 40));
  });

  if (buffered) {
    // "unreported" is the designed, honest answer when an endpoint says nothing —
    // a warning, never a failure. It does bound what can be costed downstream.
    if (buffered.tokenSource === "unreported") {
      warn("usage reporting", "unreported — honest, but this endpoint cannot be costed");
    } else {
      pass(
        "usage is reported, not invented",
        `${buffered.promptTokens} in / ${buffered.completionTokens} out (${buffered.tokenSource})`,
      );
    }

    if (buffered.providerRequestId) {
      pass("request id captured", buffered.providerRequestId.slice(0, 40));
    } else {
      warn("request id", "not reported — invoice reconciliation unavailable here");
    }

    if (buffered.finishReason) pass("finish reason", buffered.finishReason);
  }

  // Streaming: deltas must arrive, and must reconstruct the final text exactly.
  const streamCheck = async () => {
    const chunks = [];
    const r = await complete({ ...base, input: PROMPT, onDelta: (d) => chunks.push(d) });
    if (chunks.length === 0) throw new Error("no deltas received");
    const joined = chunks.join("");
    if (joined !== r.text) {
      throw new Error(`deltas !== final text (${JSON.stringify(joined)} vs ${JSON.stringify(r.text)})`);
    }
    return `${chunks.length} deltas, ${r.tokenSource} usage`;
  };

  if (t.streamingRejected) {
    await check("streaming is refused cleanly (expected for this endpoint)", async () => {
      try {
        await streamCheck();
      } catch (err) {
        if (err instanceof LLMError) return `${err.name}: ${String(err.message).slice(0, 60)}`;
        throw new Error(`refused, but with an unclassified error: ${err?.name}`);
      }
      throw new Error("expected this endpoint to reject streaming, but it succeeded");
    });
  } else {
    await check("streaming deltas reconstruct the final text", streamCheck);
  }

  if (t.supportsJson) {
    await check("responseFormat json is honoured", async () => {
      const r = await complete({
        ...base,
        input: { messages: [{ role: "user", content: 'Return {"ok":true} and nothing else.' }] },
        responseFormat: { type: "json" },
      });
      JSON.parse(r.text); // throws if the constraint was ignored
      return r.text.trim().slice(0, 40);
    });
  }

  if (t.refuses) {
    await check("an unsupportable parameter is refused before the request", async () => {
      try {
        await complete({ ...base, input: PROMPT, ...t.refuses });
      } catch (err) {
        if (err instanceof UnsupportedCapabilityError) return err.message.slice(0, 70);
        throw new Error(`refused with the wrong type: ${err?.name}`);
      }
      throw new Error("expected UnsupportedCapabilityError, got a success");
    });
  }

  // The error taxonomy, against a real provider rather than a fixture.
  await check("a bogus model id yields a typed error", async () => {
    try {
      await complete({ ...base, model: "definitely-not-a-real-model-xyz", input: PROMPT });
    } catch (err) {
      if (err instanceof ModelUnavailableError) return `ModelUnavailableError (status ${err.status})`;
      if (err instanceof LLMError) {
        // Providers word this inconsistently; a typed error still beats a raw one.
        return `${err.name} (status ${err.status}) — not classified as ModelUnavailable`;
      }
      throw new Error(`unclassified error: ${err?.name}: ${err?.message}`);
    }
    throw new Error("a nonexistent model returned a success");
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

const only = process.argv.slice(2);
const all = targets();
const selected = only.length ? all.filter((t) => only.some((o) => t.name.includes(o))) : all;

if (all.length === 0) {
  console.error(
    "No targets configured. Set at least one of ANTHROPIC_API_KEY, GEMINI_API_KEY,\n" +
    "VERTEX_ACCESS_TOKEN + VERTEX_PROJECT, NVIDIA_API_KEY, or BRIDGE_URL.\n" +
    "See docs/SMOKE_TEST.md.",
  );
  process.exit(1);
}
if (selected.length === 0) {
  console.error(`No configured target matched ${JSON.stringify(only)}. Available: ${all.map((t) => t.name).join(", ")}`);
  process.exit(1);
}

console.log(`\x1b[1mLive smoke run\x1b[0m — ${selected.length} target(s), real endpoints, real spend.`);
const skipped = all.length - selected.length;
if (skipped > 0) console.log(`\x1b[2m${skipped} configured target(s) not selected.\x1b[0m`);

for (const t of selected) {
  try {
    await runTarget(t);
  } catch (err) {
    fail(`${t.name} aborted`, String(err?.message ?? err));
  }
}

const failures = results.filter((r) => !r.ok);
const warnings = results.filter((r) => r.warned);
console.log(
  `\n\x1b[1m${results.length - failures.length}/${results.length} checks passed\x1b[0m` +
  (warnings.length ? `, ${warnings.length} warning(s)` : ""),
);
if (failures.length) {
  console.log("\n\x1b[31mFailures:\x1b[0m");
  for (const f of failures) console.log(`  • ${f.what} — ${f.detail}`);
  process.exit(1);
}
console.log("\x1b[32mAll good.\x1b[0m Safe to promote the candidate to `latest`.");
