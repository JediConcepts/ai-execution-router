import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AuthError,
  LLMError,
  ModelUnavailableError,
  PermanentError,
  RateLimitError,
  TransientError,
  classifyHttpError,
  isModelUnavailable,
} from "../src/router/errors.ts";

test("all subclasses extend LLMError", () => {
  assert.ok(new RateLimitError("x") instanceof LLMError);
  assert.ok(new TransientError("x") instanceof LLMError);
  assert.ok(new PermanentError("x") instanceof LLMError);
  assert.ok(new AuthError("x") instanceof LLMError);
});

test("error names are set correctly", () => {
  assert.equal(new LLMError("x").name, "LLMError");
  assert.equal(new RateLimitError("x").name, "RateLimitError");
  assert.equal(new TransientError("x").name, "TransientError");
  assert.equal(new PermanentError("x").name, "PermanentError");
  assert.equal(new AuthError("x").name, "AuthError");
});

test("RateLimitError carries retryAfterMs", () => {
  const e = new RateLimitError("rl", 1500);
  assert.equal(e.retryAfterMs, 1500);
});

test("LLMError carries cause", () => {
  const original = new Error("orig");
  const e = new LLMError("wrapped", original);
  assert.equal(e.cause, original);
});

test("classifyHttpError: 401 maps to AuthError", () => {
  assert.ok(classifyHttpError(401, undefined, "u") instanceof AuthError);
});

test("classifyHttpError: 403 maps to AuthError", () => {
  assert.ok(classifyHttpError(403, undefined, "u") instanceof AuthError);
});

test("classifyHttpError: 429 with seconds retry-after sets retryAfterMs", () => {
  const e = classifyHttpError(429, "30", "rl");
  assert.ok(e instanceof RateLimitError);
  assert.equal((e as RateLimitError).retryAfterMs, 30_000);
});

test("classifyHttpError: 429 without retry-after has undefined retryAfterMs", () => {
  const e = classifyHttpError(429, undefined, "rl");
  assert.ok(e instanceof RateLimitError);
  assert.equal((e as RateLimitError).retryAfterMs, undefined);
});

test("classifyHttpError: 429 with HTTP-date retry-after parses to positive ms", () => {
  const future = new Date(Date.now() + 60_000).toUTCString();
  const e = classifyHttpError(429, future, "rl");
  assert.ok(e instanceof RateLimitError);
  const ms = (e as RateLimitError).retryAfterMs;
  assert.ok(ms !== undefined && ms > 0 && ms <= 60_000);
});

test("classifyHttpError: 429 with past HTTP-date clamps retryAfterMs to 0", () => {
  const past = new Date(Date.now() - 60_000).toUTCString();
  const e = classifyHttpError(429, past, "rl");
  assert.equal((e as RateLimitError).retryAfterMs, 0);
});

test("classifyHttpError: 400/404/422 map to PermanentError", () => {
  assert.ok(classifyHttpError(400, undefined, "x") instanceof PermanentError);
  assert.ok(classifyHttpError(404, undefined, "x") instanceof PermanentError);
  assert.ok(classifyHttpError(422, undefined, "x") instanceof PermanentError);
});

test("classifyHttpError: 5xx maps to TransientError", () => {
  assert.ok(classifyHttpError(500, undefined, "x") instanceof TransientError);
  assert.ok(classifyHttpError(502, undefined, "x") instanceof TransientError);
  assert.ok(classifyHttpError(503, undefined, "x") instanceof TransientError);
});

test("classifyHttpError: undefined status maps to TransientError", () => {
  assert.ok(classifyHttpError(undefined, undefined, "network") instanceof TransientError);
});

// ─── Regression: model names contain dots ─────────────────────────────────────

test("isModelUnavailable matches real provider messages, including dotted model ids", () => {
  // The first live call ever made through this router hit exactly this message
  // and was classified PermanentError instead of ModelUnavailableError, because
  // the pattern bounded the gap with [^.] and every real model id has dots in it.
  const shouldMatch = [
    "This model models/gemini-2.5-flash is no longer available to new users.",
    "The model `does-not-exist-xyz` does not exist",
    "model claude-4.6-opus is not supported",
    "Publisher Model `projects/p/locations/eu/publishers/google/models/gemini-3.0-pro` was not found",
    "The model gpt-5.4 has been deprecated",
  ];
  for (const m of shouldMatch) {
    assert.ok(isModelUnavailable(m), `expected a match: ${m}`);
  }

  const shouldNotMatch = [
    "Rate limit exceeded, please slow down",
    "This model's maximum context length is 8192 tokens",
    "Invalid API key provided",
  ];
  for (const m of shouldNotMatch) {
    assert.ok(!isModelUnavailable(m), `expected no match: ${m}`);
  }
});

test("a dotted-model 404 classifies as ModelUnavailableError end to end", () => {
  const err = classifyHttpError(404, undefined, "This model models/gemini-2.5-flash is no longer available.", undefined, {
    status: 404,
  });
  assert.ok(err instanceof ModelUnavailableError, `got ${err.name}`);
});

test("a provider's own message is preferred over the raw JSON envelope", () => {
  // Not a unit of classifyHttpError, but the property that makes its output
  // readable: callers see the sentence, not 400 characters of envelope.
  const err = classifyHttpError(404, undefined, "This model is no longer available.", undefined, {
    status: 404,
    body: '{"error":{"code":404,"message":"This model is no longer available.","status":"NOT_FOUND"}}',
    providerCode: "NOT_FOUND",
  });
  assert.ok(!err.message.includes("{"), "message must not be a JSON dump");
  assert.equal(err.providerCode, "NOT_FOUND");
  assert.ok(err.body?.includes("NOT_FOUND"), "full envelope stays on .body");
});
