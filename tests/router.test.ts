import { test } from "node:test";
import assert from "node:assert/strict";
import { complete } from "../src/router/router.ts";
import {
  AuthError,
  PermanentError,
  RateLimitError,
  TransientError,
} from "../src/router/errors.ts";
import type { UsageRecord } from "../src/router/types.ts";

const realFetch = globalThis.fetch;

interface MockResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

interface CapturedCall {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

function mockFetch(responses: MockResponse[]): { calls: CapturedCall[]; restore: () => void } {
  const calls: CapturedCall[] = [];
  let i = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const body = init?.body ? String(init.body) : "";
    calls.push({ url: req.url, method: req.method, headers: req.headers, body });
    const r = responses[i++] ?? responses[responses.length - 1];
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

const ANTHROPIC_OK: MockResponse = {
  status: 200,
  body: {
    content: [{ type: "text", text: "ok" }],
    usage: { input_tokens: 5, output_tokens: 3 },
    stop_reason: "end_turn",
  },
};

const OAI_OK: MockResponse = {
  status: 200,
  body: {
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 7, completion_tokens: 4 },
  },
};

test("unknown model with no endpoint throws PermanentError", async () => {
  await assert.rejects(
    () => complete({
      model: "no-such-model",
      input: { messages: [{ role: "user", content: "hi" }] },
    }),
    PermanentError,
  );
});

test("known model without apiKey throws AuthError", async () => {
  await assert.rejects(
    () => complete({
      model: "claude-sonnet-4-6",
      input: { messages: [{ role: "user", content: "hi" }] },
    }),
    AuthError,
  );
});

test("openai-compatible with no baseUrl and unknown model throws PermanentError", async () => {
  await assert.rejects(
    () => complete({
      model: "private/custom",
      input: { messages: [{ role: "user", content: "hi" }] },
      endpoint: { provider: "openai-compatible", apiKey: "k" },
    }),
    PermanentError,
  );
});

test("anthropic success returns text and tokens, calls /v1/messages", async () => {
  const m = mockFetch([ANTHROPIC_OK]);
  try {
    const r = await complete({
      model: "claude-sonnet-4-6",
      input: { system: "be helpful", messages: [{ role: "user", content: "hi" }] },
      endpoint: { apiKey: "k" },
    });
    assert.equal(r.text, "ok");
    assert.equal(r.promptTokens, 5);
    assert.equal(r.completionTokens, 3);
    assert.equal(r.model, "claude-sonnet-4-6");
    assert.equal(r.finishReason, "end_turn");
    assert.ok(r.latencyMs >= 0);
    assert.equal(m.calls.length, 1);
    assert.ok(m.calls[0].url.endsWith("/v1/messages"));
    assert.equal(m.calls[0].headers.get("x-api-key"), "k");
    assert.equal(m.calls[0].headers.get("anthropic-version"), "2023-06-01");
  } finally {
    m.restore();
  }
});

test("openai-compatible success returns text and tokens, calls /chat/completions", async () => {
  const m = mockFetch([OAI_OK]);
  try {
    const r = await complete({
      model: "meta/llama-3.3-70b-instruct",
      input: { messages: [{ role: "user", content: "hi" }] },
      endpoint: { apiKey: "k" },
    });
    assert.equal(r.text, "ok");
    assert.equal(r.promptTokens, 7);
    assert.equal(r.completionTokens, 4);
    assert.equal(m.calls.length, 1);
    assert.ok(m.calls[0].url.endsWith("/chat/completions"));
    assert.equal(m.calls[0].headers.get("authorization"), "Bearer k");
  } finally {
    m.restore();
  }
});

test("openai-compatible 200 with a top-level error body is a failed attempt, not empty text", async () => {
  // Proxies and tunnel bridges that must commit response headers before the
  // upstream finishes deliver failures as {"error":{...}} on a 200.
  const m = mockFetch([
    { status: 200, body: { error: { message: "backend failed", type: "bridge_backend_error" } } },
  ]);
  try {
    await assert.rejects(
      () => complete({
        model: "meta/llama-3.3-70b-instruct",
        input: { messages: [{ role: "user", content: "hi" }] },
        endpoint: { apiKey: "k" },
      }),
      (err: unknown) =>
        err instanceof TransientError && /backend failed/.test((err as Error).message),
    );
  } finally {
    m.restore();
  }
});

test("429 with retry-after header triggers exactly one retry then succeeds", async () => {
  const m = mockFetch([
    { status: 429, headers: { "retry-after": "0" }, body: { error: "slow down" } },
    ANTHROPIC_OK,
  ]);
  try {
    const r = await complete({
      model: "claude-sonnet-4-6",
      input: { messages: [{ role: "user", content: "hi" }] },
      endpoint: { apiKey: "k" },
    });
    assert.equal(r.text, "ok");
    assert.equal(m.calls.length, 2);
  } finally {
    m.restore();
  }
});

test("429 without retry-after header throws RateLimitError without retrying", async () => {
  const m = mockFetch([{ status: 429, body: { error: "slow down" } }]);
  try {
    await assert.rejects(
      () => complete({
        model: "claude-sonnet-4-6",
        input: { messages: [{ role: "user", content: "hi" }] },
        endpoint: { apiKey: "k" },
      }),
      RateLimitError,
    );
    assert.equal(m.calls.length, 1);
  } finally {
    m.restore();
  }
});

test("500 throws TransientError without retrying", async () => {
  const m = mockFetch([{ status: 500, body: { error: "internal" } }]);
  try {
    await assert.rejects(
      () => complete({
        model: "claude-sonnet-4-6",
        input: { messages: [{ role: "user", content: "hi" }] },
        endpoint: { apiKey: "k" },
      }),
      TransientError,
    );
    assert.equal(m.calls.length, 1);
  } finally {
    m.restore();
  }
});

test("401 throws AuthError without retrying", async () => {
  const m = mockFetch([{ status: 401, body: { error: "unauthorized" } }]);
  try {
    await assert.rejects(
      () => complete({
        model: "claude-sonnet-4-6",
        input: { messages: [{ role: "user", content: "hi" }] },
        endpoint: { apiKey: "k" },
      }),
      AuthError,
    );
    assert.equal(m.calls.length, 1);
  } finally {
    m.restore();
  }
});

test("404 throws PermanentError without retrying", async () => {
  const m = mockFetch([{ status: 404, body: { error: "not found" } }]);
  try {
    await assert.rejects(
      () => complete({
        model: "claude-sonnet-4-6",
        input: { messages: [{ role: "user", content: "hi" }] },
        endpoint: { apiKey: "k" },
      }),
      PermanentError,
    );
    assert.equal(m.calls.length, 1);
  } finally {
    m.restore();
  }
});

test("onUsage receives a record with task passed through opaquely", async () => {
  const m = mockFetch([ANTHROPIC_OK]);
  let received: UsageRecord | undefined;
  try {
    await complete({
      task: "an-opaque-label",
      model: "claude-sonnet-4-6",
      input: { messages: [{ role: "user", content: "hi" }] },
      endpoint: { apiKey: "k" },
      onUsage: (r) => { received = r; },
    });
    assert.ok(received);
    assert.equal(received!.task, "an-opaque-label");
    assert.equal(received!.model, "claude-sonnet-4-6");
    assert.equal(received!.promptTokens, 5);
    assert.equal(received!.completionTokens, 3);
    assert.ok(received!.latencyMs >= 0);
    assert.match(received!.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    m.restore();
  }
});

test("onUsage is not invoked on failure", async () => {
  const m = mockFetch([{ status: 500, body: {} }]);
  let invoked = false;
  try {
    await assert.rejects(
      () => complete({
        model: "claude-sonnet-4-6",
        input: { messages: [{ role: "user", content: "hi" }] },
        endpoint: { apiKey: "k" },
        onUsage: () => { invoked = true; },
      }),
    );
    assert.equal(invoked, false);
  } finally {
    m.restore();
  }
});

test("explicit endpoint overrides catalog provider and baseUrl", async () => {
  const m = mockFetch([OAI_OK]);
  try {
    await complete({
      model: "claude-sonnet-4-6",
      input: { messages: [{ role: "user", content: "hi" }] },
      endpoint: {
        provider: "openai-compatible",
        baseUrl: "https://example.test/v1",
        apiKey: "k",
      },
    });
    assert.ok(m.calls[0].url.startsWith("https://example.test/v1/"));
    assert.ok(m.calls[0].url.endsWith("/chat/completions"));
  } finally {
    m.restore();
  }
});

test("anthropic body includes system when supplied", async () => {
  const m = mockFetch([ANTHROPIC_OK]);
  try {
    await complete({
      model: "claude-sonnet-4-6",
      input: { system: "S", messages: [{ role: "user", content: "U" }] },
      endpoint: { apiKey: "k" },
    });
    const body = JSON.parse(m.calls[0].body);
    assert.equal(body.system, "S");
    assert.deepEqual(body.messages, [{ role: "user", content: "U" }]);
  } finally {
    m.restore();
  }
});

test("openai-compatible body prepends system as first message", async () => {
  const m = mockFetch([OAI_OK]);
  try {
    await complete({
      model: "meta/llama-3.3-70b-instruct",
      input: { system: "S", messages: [{ role: "user", content: "U" }] },
      endpoint: { apiKey: "k" },
    });
    const body = JSON.parse(m.calls[0].body);
    assert.deepEqual(body.messages, [
      { role: "system", content: "S" },
      { role: "user", content: "U" },
    ]);
  } finally {
    m.restore();
  }
});

test("temperature and maxTokens propagate when set", async () => {
  const m = mockFetch([ANTHROPIC_OK]);
  try {
    await complete({
      model: "claude-sonnet-4-6",
      input: { messages: [{ role: "user", content: "U" }] },
      temperature: 0.2,
      maxTokens: 50,
      endpoint: { apiKey: "k" },
    });
    const body = JSON.parse(m.calls[0].body);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.max_tokens, 50);
  } finally {
    m.restore();
  }
});
