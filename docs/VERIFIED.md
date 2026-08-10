# Verified endpoints

**Dated observations, not a catalogue.** Each row records what was actually run,
when, and against which commit. Nothing here is normative: an endpoint absent from
this file is not unsupported, and an endpoint present in it may have changed since.

This is the deliberate alternative to shipping a provider/model catalogue. A
catalogue claims to know what is true now; this claims only to know what happened on
a given day. See *Why there is no model catalog* in [`ARCHITECTURE.md`](../ARCHITECTURE.md).

Reproduce any row with [`SMOKE_TEST.md`](./SMOKE_TEST.md).

---

## Google — Gemini Developer API

| | |
|---|---|
| **Status** | ✅ All checks passed |
| **Date** | 2026-08-10 |
| **Commit** | `eebe1c8` (`1.0.0-rc.1`) |
| **Wire shape** | `google-genai` |
| **Endpoint** | `https://generativelanguage.googleapis.com/v1beta` (default) |
| **Model** | `gemini-flash-latest` |
| **Auth** | API key via `x-goog-api-key`, free (AI Studio) tier |

**Exercised:** buffered completion · usage reporting (`reported`, including
`thoughtsTokenCount` → `reasoningTokens`) · `providerRequestId` from the payload ·
`finishReason` · SSE streaming over `?alt=sse` with deltas reconstructing the final
text exactly · `responseFormat: { type: "json" }` honoured · explicit
`reasoning.budgetTokens` accepted and reflected in the reported thinking count ·
a nonexistent model id classified as `ModelUnavailableError` (404).

```
── gemini-developer  gemini-flash-latest
  ✓ buffered call returns text                            "PONG"
  ✓ usage is reported, not invented                       7 in / 2 out / 66 thinking (reported)
  ✓ request id captured                                   BRR5arK…
  ✓ finish reason                                         STOP
  ✓ streaming deltas reconstruct the final text           1 deltas, reported usage
  ✓ responseFormat json is honoured                       {"ok":true}
  ✓ an explicit thinking budget is accepted and reported  95 thinking tokens reported
  ✓ a bogus model id yields a typed error                 ModelUnavailableError (status 404)

8/8 checks passed
```

**Also observed, on a subsequent run that exhausted the free tier:** a real 429
reading *"You exceeded your current quota, please check your plan and billing
details"* was classified `QuotaExhaustedError` — **not** `RateLimitError` — and was
not retried.

That is the release's central governance claim proving itself against a live
provider. The pattern that caught it was carried over from a production controller
that had learned the distinction the expensive way: a caller treating quota
exhaustion as a rate limit waits out a full window before failing over to a
candidate that would have answered immediately.

**Known gaps at this date**

- `maxTokens` must budget for thinking. Gemini counts `thoughtsTokenCount` inside
  `maxOutputTokens`, so a tight ceiling returns `finishReason: MAX_TOKENS` with no
  answer text. Observed at 32 tokens; fine at 512. See the interop note in
  `SMOKE_TEST.md`.
- When no answer tokens are produced, Gemini omits `candidatesTokenCount` entirely
  and `tokenSource` correctly reports `partial` rather than a fabricated zero.
- `budgetTokens` maps to `thinkingConfig.thinkingBudget`, the Gemini 2.5-lineage
  control. Newer families may expose a coarse level instead; that will need its own
  field rather than a reinterpretation of this one.
- `gemini-2.5-flash` was retired for new API keys at some point before this date.
  Model ids rot — this is why the harness asks the endpoint rather than guessing.

---

## Google — Vertex AI

| | |
|---|---|
| **Status** | ⬜ Not yet run |
| **Wire shape** | `google-genai` |
| **Auth** | Controller-minted OAuth bearer via `endpoint.headers`, **no `apiKey`** |

The load-bearing architectural claim: the router reads no ambient credentials, so a
Vertex call is only possible if a token minted entirely outside it works through the
header seam. Until this row is filled in, that claim is designed and tested against
fixtures, not demonstrated.

---

## Anthropic — Messages API

| | |
|---|---|
| **Status** | ⬜ Not yet run |
| **Wire shape** | `anthropic` |

Should also confirm that `responseFormat: { type: "json" }` is **refused** with
`UnsupportedCapabilityError` — the Messages API has no `response_format` field, and
a silent drop is the failure mode the fail-closed rule exists to prevent.

---

## Local CLI bridge

| | |
|---|---|
| **Status** | ⬜ Not yet run |
| **Wire shape** | `openai-chat` |

The awkward topology on purpose: a keep-alive shim that commits to HTTP 200 before
its backend has produced anything. Two results are inverted here — streaming must be
**refused** with a typed error, and usage warns because the bridge estimates.

---

## NVIDIA NIM

| | |
|---|---|
| **Status** | ⬜ Not yet run |
| **Wire shape** | `openai-chat` |

Broad coverage of the most common shape against a real cloud server.

---

## Promotion

`1.0.0-rc.1` sits on the `next` dist-tag. It is promoted to `latest` when the rows
above are filled in — specifically Vertex, without which the central claim is
unproven. See the checklist at the end of `SMOKE_TEST.md`.
