import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AuthError,
  classifyHttpError,
  LLMError,
  PermanentError,
  RateLimitError,
  TransientError,
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
