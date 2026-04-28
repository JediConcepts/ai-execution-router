import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOG, lookupCatalog } from "../src/router/catalog.ts";

test("known anthropic model returns provider only", () => {
  assert.deepEqual(lookupCatalog("claude-sonnet-4-6"), { provider: "anthropic" });
});

test("known openai-compatible model returns provider and baseUrl", () => {
  const e = lookupCatalog("meta/llama-3.3-70b-instruct");
  assert.equal(e?.provider, "openai-compatible");
  assert.equal(e?.baseUrl, "https://integrate.api.nvidia.com/v1");
});

test("unknown model returns undefined", () => {
  assert.equal(lookupCatalog("not/a-real-model"), undefined);
});

test("every catalog entry has only provider and optional baseUrl", () => {
  const allowed = new Set(["provider", "baseUrl"]);
  for (const [model, entry] of Object.entries(CATALOG)) {
    for (const key of Object.keys(entry)) {
      assert.ok(allowed.has(key), `entry "${model}" has disallowed key "${key}"`);
    }
    assert.ok(entry.provider === "anthropic" || entry.provider === "openai-compatible");
  }
});
