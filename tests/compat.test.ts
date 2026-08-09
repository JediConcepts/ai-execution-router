/**
 * Downstream compatibility.
 *
 * These tests reproduce the exact call shape used by the router's existing
 * production consumer (a controller wrapping `complete()` — see
 * ARCHITECTURE.md). They exist so that a change to the execution contract
 * cannot break a caller silently: if the pre-1.0 spelling, the argument names,
 * or the result fields move, this file fails before anyone downstream does.
 *
 * Nothing here asserts new behaviour. It asserts that old behaviour survived.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { complete } from "../src/router/router.ts";
import type { UsageRecord } from "../src/router/types.ts";

const realFetch = globalThis.fetch;

function mockOnce(body: unknown, status = 200) {
  const calls: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init?.body ? String(init.body) : "");
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

/** Mirrors the controller's own request type, field for field. */
interface ControllerRequest {
  task: string;
  input: {
    system?: string;
    messages: { role: "user" | "assistant"; content: string }[];
  };
  maxTokens?: number;
  temperature?: number;
  provider: "anthropic" | "openai-compatible";
  model: string;
  apiKey?: string;
  baseURL?: string;
}

/** Mirrors the controller's `execute()` body verbatim. */
async function execute(req: ControllerRequest, onUsage?: (r: UsageRecord) => void) {
  const result = await complete({
    task: req.task,
    model: req.model,
    input: req.input,
    maxTokens: req.maxTokens,
    temperature: req.temperature,
    endpoint: {
      provider: req.provider,
      apiKey: req.apiKey,
      baseUrl: req.baseURL,
    },
    onUsage,
  });
  return {
    text: result.text,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    latencyMs: result.latencyMs,
  };
}

test("the controller's anthropic path is unchanged", async () => {
  const m = mockOnce({
    content: [{ type: "text", text: "hello" }],
    usage: { input_tokens: 12, output_tokens: 8 },
    stop_reason: "end_turn",
  });
  try {
    const out = await execute({
      task: "FORENSIC_EXTRACTION",
      model: "claude-haiku-4-5",
      provider: "anthropic",
      apiKey: "sk-test",
      input: { system: "You extract facts.", messages: [{ role: "user", content: "doc" }] },
      maxTokens: 2048,
      temperature: 0.1,
    });
    assert.equal(out.text, "hello");
    assert.equal(out.promptTokens, 12);
    assert.equal(out.completionTokens, 8);
    assert.equal(typeof out.latencyMs, "number");
  } finally {
    m.restore();
  }
});

test('the controller\'s "openai-compatible" spelling still resolves', async () => {
  const m = mockOnce({
    choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1 },
  });
  try {
    const out = await execute({
      task: "AGENT2_DOC_MAP",
      model: "meta/llama-3.3-70b-instruct",
      provider: "openai-compatible",
      apiKey: "nvapi-test",
      baseURL: "https://integrate.api.nvidia.com/v1",
      input: { messages: [{ role: "user", content: "map" }] },
      maxTokens: 1024,
    });
    assert.equal(out.text, "hi");
    assert.equal(out.promptTokens, 3);
  } finally {
    m.restore();
  }
});

test("an assistant prefill still passes through as a trailing message", async () => {
  // The controller uses this to force small models into JSON-completion mode.
  // It needs no dedicated parameter — the message array already expresses it.
  const m = mockOnce({
    content: [{ type: "text", text: '"ok": true}' }],
    usage: { input_tokens: 4, output_tokens: 5 },
  });
  try {
    await execute({
      task: "TRIAGE",
      model: "claude-haiku-4-5",
      provider: "anthropic",
      apiKey: "sk-test",
      input: {
        messages: [
          { role: "user", content: "emit json" },
          { role: "assistant", content: "{" },
        ],
      },
    });
    const sent = JSON.parse(m.calls[0]);
    assert.deepEqual(sent.messages[1], { role: "assistant", content: "{" });
  } finally {
    m.restore();
  }
});

test("the controller's onUsage callback signature still accepts a UsageRecord", async () => {
  const m = mockOnce({
    content: [{ type: "text", text: "x" }],
    usage: { input_tokens: 1, output_tokens: 2 },
  });
  const seen: Array<{ model?: string; promptTokens: number; completionTokens: number }> = [];
  try {
    // Deliberately typed loosely, exactly as the controller types it.
    const onUsage = (record: { model?: string; promptTokens: number; completionTokens: number }) => {
      seen.push(record);
    };
    await execute(
      {
        task: "QA_ANSWER",
        model: "claude-haiku-4-5",
        provider: "anthropic",
        apiKey: "sk-test",
        input: { messages: [{ role: "user", content: "q" }] },
      },
      onUsage,
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].promptTokens, 1);
    assert.equal(seen[0].completionTokens, 2);
  } finally {
    m.restore();
  }
});
