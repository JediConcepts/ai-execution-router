import { test } from "node:test";
import assert from "node:assert/strict";
import { complete } from "../src/router/router.ts";
import {
  AuthError,
  CancelledError,
  ContextLengthError,
  ModelUnavailableError,
  PermanentError,
  QuotaExhaustedError,
  RateLimitError,
  TimeoutError,
  TransientError,
  UnsupportedCapabilityError,
} from "../src/router/errors.ts";
import type { AttemptRecord, UsageRecord } from "../src/router/types.ts";

const realFetch = globalThis.fetch;

interface MockResponse {
  status: number;
  headers?: Record<string, string>;
  /** Object bodies are JSON-encoded; strings are sent verbatim (for SSE). */
  body: unknown;
  contentType?: string;
}

interface CapturedCall {
  url: string;
  headers: Headers;
  body: string;
}

function mockFetch(responses: MockResponse[]): { calls: CapturedCall[]; restore: () => void } {
  const calls: CapturedCall[] = [];
  let i = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers as HeadersInit),
      body: init?.body ? String(init.body) : "",
    });
    const r = responses[i++] ?? responses[responses.length - 1];
    const payload = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(payload, {
      status: r.status,
      headers: {
        "content-type": r.contentType ?? "application/json",
        ...(r.headers ?? {}),
      },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

/** A fetch that never resolves until its signal aborts — for deadline tests. */
function mockHangingFetch(): { restore: () => void } {
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      const onAbort = () => {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        reject(err);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    })) as typeof fetch;
  return { restore: () => { globalThis.fetch = realFetch; } };
}

const ANTHROPIC_OK: MockResponse = {
  status: 200,
  headers: { "request-id": "req_abc" },
  body: {
    id: "msg_1",
    content: [{ type: "text", text: "ok" }],
    usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2 },
    stop_reason: "end_turn",
  },
};

const OAI_OK: MockResponse = {
  status: 200,
  body: {
    id: "chatcmpl_1",
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 7,
      completion_tokens: 4,
      prompt_tokens_details: { cached_tokens: 3 },
      completion_tokens_details: { reasoning_tokens: 2 },
    },
  },
};

const GEMINI_OK: MockResponse = {
  status: 200,
  body: {
    responseId: "resp_1",
    candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: 11,
      candidatesTokenCount: 6,
      cachedContentTokenCount: 4,
      thoughtsTokenCount: 9,
    },
  },
};

const ANTHROPIC = { provider: "anthropic" as const, apiKey: "k" };
const OAI = { provider: "openai-chat" as const, apiKey: "k", baseUrl: "https://x.test/v1" };
const GEMINI = { provider: "google-genai" as const, apiKey: "k" };
const HI = { messages: [{ role: "user" as const, content: "hi" }] };

// ─── Endpoint resolution ──────────────────────────────────────────────────────

test("missing endpoint.provider throws PermanentError", async () => {
  await assert.rejects(() => complete({ model: "m", input: HI }), PermanentError);
});

test("unknown endpoint.provider throws PermanentError naming the valid shapes", async () => {
  await assert.rejects(
    () => complete({ model: "m", input: HI, endpoint: { provider: "gemini" as never, apiKey: "k" } }),
    (err: Error) => err instanceof PermanentError && /google-genai/.test(err.message),
  );
});

test("missing apiKey throws AuthError", async () => {
  await assert.rejects(
    () => complete({ model: "m", input: HI, endpoint: { provider: "anthropic" } }),
    AuthError,
  );
});

test("an authorization header counts as the credential (Vertex/Bedrock/gateway)", async () => {
  const m = mockFetch([GEMINI_OK]);
  try {
    // apiKey is genuinely unused when the controller minted a bearer token.
    const r = await complete({
      model: "gemini-x",
      input: HI,
      endpoint: {
        provider: "google-genai",
        baseUrl: "https://eu-aiplatform.googleapis.com/v1/projects/p/locations/eu/publishers/google",
        headers: { Authorization: "Bearer adc-token" },
      },
    });
    assert.equal(r.text, "ok");
    assert.equal(m.calls[0].headers.get("authorization"), "Bearer adc-token");
    assert.equal(m.calls[0].headers.get("x-goog-api-key"), null);
  } finally {
    m.restore();
  }
});

test("openai-chat without baseUrl throws PermanentError", async () => {
  await assert.rejects(
    () => complete({ model: "m", input: HI, endpoint: { provider: "openai-chat", apiKey: "k" } }),
    PermanentError,
  );
});

test('legacy "openai-compatible" is still accepted as openai-chat', async () => {
  const m = mockFetch([OAI_OK]);
  try {
    const r = await complete({
      model: "m",
      input: HI,
      endpoint: { provider: "openai-compatible", apiKey: "k", baseUrl: "https://x.test/v1" },
    });
    assert.equal(r.text, "ok");
    assert.equal(m.calls[0].url, "https://x.test/v1/chat/completions");
  } finally {
    m.restore();
  }
});

// ─── Wire shape translation ───────────────────────────────────────────────────

test("anthropic: system hoisted, usage and cache tokens mapped, request id from header", async () => {
  const m = mockFetch([ANTHROPIC_OK]);
  try {
    const r = await complete({
      model: "claude-x",
      input: { system: "sys", messages: [{ role: "user", content: "hi" }] },
      endpoint: ANTHROPIC,
    });
    const body = JSON.parse(m.calls[0].body);
    assert.equal(body.system, "sys");
    assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
    assert.equal(m.calls[0].headers.get("x-api-key"), "k");
    assert.equal(r.promptTokens, 5);
    assert.equal(r.completionTokens, 3);
    assert.equal(r.cachedPromptTokens, 2);
    assert.equal(r.tokenSource, "provider");
    assert.equal(r.providerRequestId, "req_abc");
  } finally {
    m.restore();
  }
});

test("openai-chat: system becomes the first message; cached and reasoning tokens mapped", async () => {
  const m = mockFetch([OAI_OK]);
  try {
    const r = await complete({
      model: "m",
      input: { system: "sys", messages: [{ role: "user", content: "hi" }] },
      endpoint: OAI,
      maxTokens: 100,
      temperature: 0.2,
    });
    const body = JSON.parse(m.calls[0].body);
    assert.deepEqual(body.messages[0], { role: "system", content: "sys" });
    assert.equal(body.max_tokens, 100);
    assert.equal(body.temperature, 0.2);
    assert.equal(r.cachedPromptTokens, 3);
    assert.equal(r.reasoningTokens, 2);
  } finally {
    m.restore();
  }
});

test("google-genai: contents/parts, model role, systemInstruction, api-key header, url path", async () => {
  const m = mockFetch([GEMINI_OK]);
  try {
    const r = await complete({
      model: "models/gemini-x",
      input: {
        system: "sys",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "prior" },
        ],
      },
      endpoint: GEMINI,
      maxTokens: 64,
    });
    const call = m.calls[0];
    // The "models/" prefix is supplied by the path template, not duplicated.
    assert.equal(
      call.url,
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent",
    );
    assert.equal(call.headers.get("x-goog-api-key"), "k");
    const body = JSON.parse(call.body);
    assert.deepEqual(body.systemInstruction, { parts: [{ text: "sys" }] });
    assert.deepEqual(body.contents, [
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "prior" }] },
    ]);
    assert.equal(body.generationConfig.maxOutputTokens, 64);
    assert.equal(r.promptTokens, 11);
    assert.equal(r.completionTokens, 6);
    assert.equal(r.cachedPromptTokens, 4);
    assert.equal(r.reasoningTokens, 9);
    assert.equal(r.finishReason, "STOP");
    assert.equal(r.providerRequestId, "resp_1");
  } finally {
    m.restore();
  }
});

test("google-genai: a caller-supplied bearer (Vertex) suppresses x-goog-api-key", async () => {
  const m = mockFetch([GEMINI_OK]);
  try {
    await complete({
      model: "gemini-x",
      input: HI,
      endpoint: {
        provider: "google-genai",
        apiKey: "unused",
        baseUrl: "https://eu-aiplatform.googleapis.com/v1/projects/p/locations/eu/publishers/google",
        headers: { authorization: "Bearer adc-token" },
      },
    });
    const call = m.calls[0];
    assert.equal(call.headers.get("x-goog-api-key"), null);
    assert.equal(call.headers.get("authorization"), "Bearer adc-token");
    assert.equal(
      call.url,
      "https://eu-aiplatform.googleapis.com/v1/projects/p/locations/eu/publishers/google/models/gemini-x:generateContent",
    );
  } finally {
    m.restore();
  }
});

test("google-genai: a safety-blocked prompt raises rather than returning an empty success", async () => {
  const m = mockFetch([{ status: 200, body: { promptFeedback: { blockReason: "SAFETY" } } }]);
  try {
    await assert.rejects(
      () => complete({ model: "gemini-x", input: HI, endpoint: GEMINI }),
      (err: Error) => err instanceof PermanentError && /SAFETY/.test(err.message),
    );
  } finally {
    m.restore();
  }
});

// ─── Headers ──────────────────────────────────────────────────────────────────

test("endpoint.headers reach the provider (the Cloudflare Access case)", async () => {
  const m = mockFetch([OAI_OK]);
  try {
    await complete({
      model: "m",
      input: HI,
      endpoint: {
        ...OAI,
        headers: { "CF-Access-Client-Id": "cid", "CF-Access-Client-Secret": "csec" },
      },
    });
    assert.equal(m.calls[0].headers.get("cf-access-client-id"), "cid");
    assert.equal(m.calls[0].headers.get("cf-access-client-secret"), "csec");
    assert.equal(m.calls[0].headers.get("authorization"), "Bearer k");
  } finally {
    m.restore();
  }
});

// ─── Error taxonomy ───────────────────────────────────────────────────────────

test("401 -> AuthError, 500 -> TransientError", async () => {
  for (const [status, type] of [[401, AuthError], [500, TransientError]] as const) {
    const m = mockFetch([{ status, body: { error: { message: "no" } } }]);
    try {
      await assert.rejects(() => complete({ model: "m", input: HI, endpoint: ANTHROPIC }), type);
    } finally {
      m.restore();
    }
  }
});

test("429 with retry-after is a RateLimitError carrying the delay", async () => {
  const m = mockFetch([
    { status: 429, headers: { "retry-after": "2" }, body: { error: { message: "slow down" } } },
  ]);
  try {
    await assert.rejects(
      () => complete({ model: "m", input: HI, endpoint: ANTHROPIC }),
      (err: Error) => err instanceof RateLimitError && err.retryAfterMs === 2000,
    );
  } finally {
    m.restore();
  }
});

test("429 that is spent quota is a QuotaExhaustedError, not a RateLimitError", async () => {
  const m = mockFetch([
    {
      status: 429,
      headers: { "retry-after": "60" },
      body: { error: { message: "You exceeded your current quota, please check your plan and billing details." } },
    },
  ]);
  try {
    await assert.rejects(
      () => complete({ model: "m", input: HI, endpoint: ANTHROPIC }),
      (err: Error) => err instanceof QuotaExhaustedError && !(err instanceof RateLimitError),
    );
  } finally {
    m.restore();
  }
});

test("402 is QuotaExhaustedError; context overflow and unknown model get their own types", async () => {
  const cases: Array<[MockResponse, Function]> = [
    [{ status: 402, body: { error: { message: "insufficient credits" } } }, QuotaExhaustedError],
    [
      { status: 400, body: { error: { message: "This model's maximum context length is 8192 tokens" } } },
      ContextLengthError,
    ],
    [{ status: 404, body: { error: { message: "The model `zzz` does not exist" } } }, ModelUnavailableError],
  ];
  for (const [response, type] of cases) {
    const m = mockFetch([response]);
    try {
      await assert.rejects(
        () => complete({ model: "m", input: HI, endpoint: OAI }),
        type as never,
      );
    } finally {
      m.restore();
    }
  }
});

test("errors carry status and the provider's own code", async () => {
  const m = mockFetch([
    { status: 400, body: { error: { message: "bad", code: "invalid_request_error" } } },
  ]);
  try {
    await assert.rejects(
      () => complete({ model: "m", input: HI, endpoint: OAI }),
      (err: Error & { status?: number; providerCode?: string }) =>
        err.status === 400 && err.providerCode === "invalid_request_error",
    );
  } finally {
    m.restore();
  }
});

// ─── Retry policy ─────────────────────────────────────────────────────────────

test("a 429 with retry-after is retried exactly once, then succeeds", async () => {
  const m = mockFetch([
    { status: 429, headers: { "retry-after": "0" }, body: { error: { message: "slow" } } },
    ANTHROPIC_OK,
  ]);
  try {
    const r = await complete({ model: "m", input: HI, endpoint: ANTHROPIC });
    assert.equal(r.text, "ok");
    assert.equal(m.calls.length, 2);
  } finally {
    m.restore();
  }
});

test("spent quota is NOT retried — the controller must fail over instead", async () => {
  const m = mockFetch([
    {
      status: 429,
      headers: { "retry-after": "60" },
      body: { error: { message: "quota exceeded" } },
    },
  ]);
  try {
    await assert.rejects(() => complete({ model: "m", input: HI, endpoint: ANTHROPIC }), QuotaExhaustedError);
    assert.equal(m.calls.length, 1, "must not burn a retry on a permanent condition");
  } finally {
    m.restore();
  }
});

// ─── In-body errors on a 200 ──────────────────────────────────────────────────

test("an error delivered inside a 200 body is raised, not read as an empty completion", async () => {
  const m = mockFetch([
    {
      status: 200,
      body: { choices: [{ message: { content: "" } }], error: { message: "backend died late" } },
    },
  ]);
  try {
    await assert.rejects(
      () => complete({ model: "m", input: HI, endpoint: OAI }),
      (err: Error) => /backend died late/.test(err.message),
    );
  } finally {
    m.restore();
  }
});

test("a non-JSON body is an error rather than an empty completion", async () => {
  const m = mockFetch([{ status: 200, body: "<html>gateway</html>", contentType: "text/html" }]);
  try {
    await assert.rejects(
      () => complete({ model: "m", input: HI, endpoint: OAI }),
      (err: Error) => /non-JSON/.test(err.message),
    );
  } finally {
    m.restore();
  }
});

// ─── Deadlines and cancellation ───────────────────────────────────────────────

test("timeoutMs aborts the call with a TimeoutError", async () => {
  const m = mockHangingFetch();
  try {
    await assert.rejects(
      () => complete({ model: "m", input: HI, endpoint: ANTHROPIC, timeoutMs: 25 }),
      (err: Error) => err instanceof TimeoutError,
    );
  } finally {
    m.restore();
  }
});

test("an aborted caller signal yields CancelledError, distinct from a timeout", async () => {
  const m = mockHangingFetch();
  const controller = new AbortController();
  try {
    const promise = complete({ model: "m", input: HI, endpoint: ANTHROPIC, signal: controller.signal });
    controller.abort();
    await assert.rejects(promise, (err: Error) => err instanceof CancelledError && !(err instanceof TimeoutError));
  } finally {
    m.restore();
  }
});

// ─── Fail closed on unsupported capabilities ──────────────────────────────────

test("responseFormat json is refused by anthropic, by name", async () => {
  await assert.rejects(
    () => complete({ model: "m", input: HI, endpoint: ANTHROPIC, responseFormat: { type: "json" } }),
    (err: Error) =>
      err instanceof UnsupportedCapabilityError && /responseFormat\.type=json/.test(err.message),
  );
});

test("document blocks are refused by openai-chat", async () => {
  await assert.rejects(
    () =>
      complete({
        model: "m",
        endpoint: OAI,
        input: {
          messages: [
            {
              role: "user",
              content: [
                { type: "document", source: { type: "base64", mediaType: "application/pdf", data: "x" } },
              ],
            },
          ],
        },
      }),
    (err: Error) => err instanceof UnsupportedCapabilityError && /document/.test(err.message),
  );
});

test("the two reasoning currencies are not silently converted", async () => {
  await assert.rejects(
    () => complete({ model: "m", input: HI, endpoint: ANTHROPIC, reasoning: { effort: "high" } }),
    (err: Error) => err instanceof UnsupportedCapabilityError && /reasoning\.effort/.test(err.message),
  );
  await assert.rejects(
    () => complete({ model: "m", input: HI, endpoint: OAI, reasoning: { budgetTokens: 2048 } }),
    (err: Error) => err instanceof UnsupportedCapabilityError && /reasoning\.budgetTokens/.test(err.message),
  );
});

test("supported request features are actually sent", async () => {
  const m = mockFetch([OAI_OK, ANTHROPIC_OK, GEMINI_OK]);
  try {
    await complete({
      model: "m",
      input: HI,
      endpoint: OAI,
      responseFormat: { type: "json_schema", schema: { type: "object" }, name: "out" },
      reasoning: { effort: "high" },
    });
    const oai = JSON.parse(m.calls[0].body);
    assert.equal(oai.response_format.type, "json_schema");
    assert.equal(oai.response_format.json_schema.name, "out");
    assert.equal(oai.reasoning_effort, "high");

    await complete({ model: "m", input: HI, endpoint: ANTHROPIC, reasoning: { budgetTokens: 2048 } });
    assert.deepEqual(JSON.parse(m.calls[1].body).thinking, { type: "enabled", budget_tokens: 2048 });

    await complete({
      model: "g",
      input: HI,
      endpoint: GEMINI,
      responseFormat: { type: "json" },
      reasoning: { budgetTokens: 512 },
    });
    const gen = JSON.parse(m.calls[2].body).generationConfig;
    assert.equal(gen.responseMimeType, "application/json");
    assert.deepEqual(gen.thinkingConfig, { thinkingBudget: 512 });
  } finally {
    m.restore();
  }
});

test("image blocks are encoded per wire shape", async () => {
  const m = mockFetch([OAI_OK, ANTHROPIC_OK, GEMINI_OK]);
  const image = {
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "image" as const, source: { type: "base64" as const, mediaType: "image/png", data: "AAA" } },
        ],
      },
    ],
  };
  try {
    await complete({ model: "m", input: image, endpoint: OAI });
    assert.equal(
      JSON.parse(m.calls[0].body).messages[0].content[0].image_url.url,
      "data:image/png;base64,AAA",
    );

    await complete({ model: "m", input: image, endpoint: ANTHROPIC });
    assert.deepEqual(JSON.parse(m.calls[1].body).messages[0].content[0], {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAA" },
    });

    await complete({ model: "g", input: image, endpoint: GEMINI });
    assert.deepEqual(JSON.parse(m.calls[2].body).contents[0].parts[0], {
      inlineData: { mimeType: "image/png", data: "AAA" },
    });
  } finally {
    m.restore();
  }
});

// ─── Honest token accounting ──────────────────────────────────────────────────

test("a provider that reports no usage yields zeros marked unreported, never an estimate", async () => {
  const m = mockFetch([{ status: 200, body: { choices: [{ message: { content: "a fairly long answer" } }] } }]);
  try {
    const r = await complete({ model: "m", input: HI, endpoint: OAI });
    assert.equal(r.promptTokens, 0);
    assert.equal(r.completionTokens, 0);
    assert.equal(r.tokenSource, "unreported");
  } finally {
    m.restore();
  }
});

test("partial usage is labelled partial", async () => {
  const m = mockFetch([
    { status: 200, body: { choices: [{ message: { content: "x" } }], usage: { completion_tokens: 4 } } },
  ]);
  try {
    const r = await complete({ model: "m", input: HI, endpoint: OAI });
    assert.equal(r.tokenSource, "partial");
  } finally {
    m.restore();
  }
});

// ─── Observation callbacks ────────────────────────────────────────────────────

test("onUsage fires once on success and carries the wire shape", async () => {
  const m = mockFetch([ANTHROPIC_OK]);
  const records: UsageRecord[] = [];
  try {
    await complete({
      model: "m",
      task: "summarize",
      input: HI,
      endpoint: ANTHROPIC,
      onUsage: (r) => { records.push(r); },
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].task, "summarize");
    assert.equal(records[0].wireShape, "anthropic");
    assert.equal(records[0].tokenSource, "provider");
  } finally {
    m.restore();
  }
});

test("onUsage does NOT fire on failure; onAttempt records both legs of a retry", async () => {
  const m = mockFetch([
    { status: 429, headers: { "retry-after": "0" }, body: { error: { message: "slow" } } },
    ANTHROPIC_OK,
  ]);
  const usage: UsageRecord[] = [];
  const attempts: AttemptRecord[] = [];
  try {
    await complete({
      model: "m",
      input: HI,
      endpoint: ANTHROPIC,
      onUsage: (r) => { usage.push(r); },
      onAttempt: (r) => { attempts.push(r); },
    });
    assert.equal(usage.length, 1, "one billable success");
    assert.equal(attempts.length, 2, "both attempts audited");
    assert.equal(attempts[0].outcome, "error");
    assert.equal(attempts[0].errorName, "RateLimitError");
    assert.equal(attempts[0].status, 429);
    assert.equal(attempts[1].outcome, "success");
  } finally {
    m.restore();
  }
});

test("a throwing onAttempt sink cannot mask the provider's real error", async () => {
  const m = mockFetch([{ status: 401, body: { error: { message: "bad key" } } }]);
  try {
    await assert.rejects(
      () =>
        complete({
          model: "m",
          input: HI,
          endpoint: ANTHROPIC,
          onAttempt: () => { throw new Error("audit sink exploded"); },
        }),
      AuthError,
    );
  } finally {
    m.restore();
  }
});

// ─── Streaming ────────────────────────────────────────────────────────────────

const SSE = "text/event-stream";

test("openai-chat streams deltas and still returns one result with usage", async () => {
  const frames = [
    'data: {"id":"c1","choices":[{"delta":{"content":"He"}}]}',
    'data: {"id":"c1","choices":[{"delta":{"content":"llo"}}]}',
    'data: {"id":"c1","choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
    "data: [DONE]",
  ].join("\n\n") + "\n\n";
  const m = mockFetch([{ status: 200, body: frames, contentType: SSE }]);
  const seen: string[] = [];
  try {
    const r = await complete({
      model: "m",
      input: HI,
      endpoint: OAI,
      onDelta: (d) => { seen.push(d); },
    });
    assert.deepEqual(seen, ["He", "llo"]);
    assert.equal(r.text, "Hello");
    assert.equal(r.finishReason, "stop");
    assert.equal(r.promptTokens, 3);
    assert.equal(r.tokenSource, "provider");
    const body = JSON.parse(m.calls[0].body);
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
  } finally {
    m.restore();
  }
});

test("anthropic streams, splitting usage across message_start and message_delta", async () => {
  const frames = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_9","usage":{"input_tokens":10}}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
  ].join("\n\n") + "\n\n";
  const m = mockFetch([{ status: 200, body: frames, contentType: SSE }]);
  const seen: string[] = [];
  try {
    const r = await complete({
      model: "m",
      input: HI,
      endpoint: ANTHROPIC,
      onDelta: (d) => { seen.push(d); },
    });
    assert.deepEqual(seen, ["Hi"], "thinking deltas are not answer text");
    assert.equal(r.text, "Hi");
    assert.equal(r.promptTokens, 10);
    assert.equal(r.completionTokens, 4);
    assert.equal(r.finishReason, "end_turn");
    assert.equal(r.providerRequestId, "msg_9");
  } finally {
    m.restore();
  }
});

test("google-genai streams via alt=sse and skips thought parts", async () => {
  const frames = [
    'data: {"responseId":"r9","candidates":[{"content":{"parts":[{"text":"Go"}]}}]}',
    'data: {"candidates":[{"content":{"parts":[{"text":"reason","thought":true}]}}]}',
    'data: {"candidates":[{"content":{"parts":[{"text":"od"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":1}}',
  ].join("\n\n") + "\n\n";
  const m = mockFetch([{ status: 200, body: frames, contentType: SSE }]);
  const seen: string[] = [];
  try {
    const r = await complete({
      model: "gemini-x",
      input: HI,
      endpoint: GEMINI,
      onDelta: (d) => { seen.push(d); },
    });
    assert.ok(m.calls[0].url.endsWith(":streamGenerateContent?alt=sse"));
    assert.deepEqual(seen, ["Go", "od"]);
    assert.equal(r.text, "Good");
    assert.equal(r.finishReason, "STOP");
    assert.equal(r.promptTokens, 2);
  } finally {
    m.restore();
  }
});

test("a streamed HTTP failure is classified and retried like any other", async () => {
  // The retry re-streams, so the follow-up response must also be an SSE body.
  const retryFrames =
    'data: {"id":"c2","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const m = mockFetch([
    { status: 429, headers: { "retry-after": "0" }, body: { error: { message: "slow" } } },
    { status: 200, body: retryFrames, contentType: SSE },
  ]);
  const seen: string[] = [];
  try {
    const r = await complete({
      model: "m",
      input: HI,
      endpoint: OAI,
      onDelta: (d) => { seen.push(d); },
    });
    assert.equal(m.calls.length, 2);
    assert.deepEqual(seen, ["ok"]);
    assert.equal(r.text, "ok");
  } finally {
    m.restore();
  }
});

test("a streamed call that exhausts quota is not retried either", async () => {
  const m = mockFetch([
    { status: 429, headers: { "retry-after": "5" }, body: { error: { message: "insufficient_quota" } } },
  ]);
  try {
    await assert.rejects(
      () => complete({ model: "m", input: HI, endpoint: OAI, onDelta: () => {} }),
      QuotaExhaustedError,
    );
    assert.equal(m.calls.length, 1);
  } finally {
    m.restore();
  }
});
