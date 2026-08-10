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
| **Status** | ✅ All checks passed — reproduced across two runs |
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

**Reproducibility:** 8/8 on two independent runs either side of a quota reset, with
different request ids and different thinking-token counts each time (66, 85, 95, 112,
123 across runs). `reasoningTokens` is live per-call data, not a constant — the model
budgets its own thinking, and the router reports whatever came back.

**Also observed, on an intervening run that exhausted the free tier:** a real 429
reading *"You exceeded your current quota, please check your plan and billing
details"* was classified `QuotaExhaustedError` — **not** `RateLimitError` — and was
not retried.

The check recovered to a pass on the next run once the quota window reset, which
confirms the classification was reading the condition rather than a coincidence.

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
| **Status** | ✅ All checks passed |
| **Date** | 2026-08-10 |
| **Commit** | `1e1a623` (`1.0.0-rc.1`) |
| **Wire shape** | `google-genai` |
| **Endpoint** | `https://us-central1-aiplatform.googleapis.com/v1/projects/…/locations/us-central1/publishers/google` |
| **Model** | `gemini-2.5-flash` |
| **Auth** | **Controller-minted OAuth bearer via `endpoint.headers`. No `apiKey` set at all.** |

```
── vertex  gemini-2.5-flash
  ✓ buffered call returns text                            "PONG"
  ✓ usage is reported, not invented                       6 in / 2 out / 20 thinking (reported)
  ✓ request id captured                                   wB55ap_bBoWHlNsPm8rAgQk
  ✓ finish reason                                         STOP
  ✓ streaming deltas reconstruct the final text           1 deltas, reported usage
  ✓ responseFormat json is honoured                       {"ok": true}
  ✓ an explicit thinking budget is accepted and reported  13 thinking tokens reported
  ✓ a bogus model id yields a typed error                 ModelUnavailableError (status 404)

8/8 checks passed
```

**This is the architectural claim, demonstrated rather than asserted.** Vertex wants
an OAuth bearer; minting one needs ambient credentials; the router reads no ambient
state by design. The controller mints the token and passes it through
`endpoint.headers`, and the router — which contains no knowledge of Google, GCP, or
OAuth — completes the call. The same `google-genai` provider serves both this and the
Developer API row above, differing only in `baseUrl` and credential.

**Corroborating detail worth keeping.** Google's own `gcloud ai model-garden models
list`, and a bare `curl` to the publisher-models listing, both **fail** against this
same project:

```
"reason": "SERVICE_DISABLED", "consumer": "projects/32555940559"
```

Those paths carry no project, so Google resolves one from ambient credentials, and
plain ADC has no quota project attached — so it bills Google's shared default. The
router is unaffected because the project is in the URL it was given. Ambient
resolution is the failure mode; explicit parameters are the fix. The library working
where the vendor's own CLI does not, for exactly the reason it refuses to read the
environment, is the boundary earning its keep.

**Setup gates passed, in order** — each 4xxs differently, and all three are project
configuration rather than code:

1. `aiplatform.googleapis.com` enabled — `AuthError` 403 until then
2. Billing attached to the project — `AuthError` 403 until then (an AI Studio-created
   project has none, and the Developer API free tier does not need one)
3. A Vertex model id — `ModelUnavailableError` 404 until then. Developer API aliases
   like `gemini-flash-latest` are not recognised; `gemini-2.5-flash` is.

**Known gaps at this date**

- The publisher-model listing API returned nothing usable without an explicit
  `x-goog-user-project` header (now sent by the harness). Discovery here ultimately
  worked by probing `generateContent` directly.
- `budgetTokens` maps to `thinkingConfig.thinkingBudget`, as on the Developer API.
- Vertex's **Anthropic** surface is a different protocol (`:rawPredict`) and remains
  unreachable by `baseUrl` alone.

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
| **Status** | ✅ All checks passed |
| **Date** | 2026-08-10 |
| **Commit** | `9b00c6a` (`1.0.0-rc.1`) |
| **Wire shape** | `openai-chat` |
| **Endpoint** | `http://127.0.0.1:8787/v1` — `local-cli-bridge` 0.2.0, `backend=auto` |
| **Model** | `sonnet` (Claude Code CLI, subscription login) |

```
── local-cli-bridge  sonnet
  ✓ buffered call returns text                     "PONG"
  ✓ usage is reported, not invented                6 in / 1 out (reported)
  ✓ request id captured                            chatcmpl-bridge-5upy63r5sk
  ✓ finish reason                                  stop
  ✓ streaming is refused cleanly by the endpoint   HTTP 400 — PermanentError
  ✓ a bogus model id yields a typed error          TransientError (status 502)

6/6 checks passed
```

This target exists to exercise the topology the reviews found bugs in: a keep-alive
shim that commits HTTP 200 and flushes headers before its backend has produced
anything. Three fixes on this branch were written for it, and running against **two
different bridge versions** happened to exercise all three.

**Against bridge 0.2.0 (above).** Streaming is refused with a real 400 — the endpoint
declining loudly, which is the pass condition. A nonexistent model produces a clean
502, classified `TransientError`.

**Against an older vendored bridge (0.1.x-era, same session).** Two behaviours that
0.2.0 no longer produces, and both were handled:

- A nonexistent model returned **HTTP 200 with the failure inside the body**
  (`claude failed (exit 1): There's an issue with the selected model…`). Caught and
  raised. Before this branch it would have been returned as an empty completion — a
  model that "had nothing to say".
- Streaming was **silently accepted** rather than refused; the router's non-SSE guard
  caught a reply that was not a stream. Not a pass, and the harness now reports that
  case as a warning rather than counting it.

**Deadline classification, tested separately:**

```
timeoutMs: 3000 against a long-running prompt  →  PASS: TimeoutError
```

This is the specific regression: the deadline expires *after* headers arrive, during
the body read. It previously surfaced as a raw `DOMException`. A `TimeoutError` here
means the fix holds against the one topology most likely to trigger it.

**Known gaps at this date**

- **Usage figures must not be costed.** The bridge estimates at roughly four
  characters per token because the CLI it wraps reports none. `tokenSource` reads
  `reported`, which means *the endpoint sent these* — not that anyone measured them.
- `npx local-cli-bridge` installs **0.1.1** from npm, which does not refuse streaming;
  the refusal is only on `main` (0.2.0). Use a clone until 0.2.0 is published.
- The bridge's env loader resolves `.env.bridge.local` from the script's own location,
  so an npx-installed bridge cannot find a project-local env file. `BRIDGE_ENV_FILE`
  is the workaround.
- Each call spawns a CLI process — seconds of latency per request, and real
  subscription usage. Dev and testing only.

---

## NVIDIA NIM

| | |
|---|---|
| **Status** | ✅ All checks passed |
| **Date** | 2026-08-10 |
| **Commit** | `3f02e82` (`1.0.0-rc.1`) |
| **Wire shape** | `openai-chat` |
| **Endpoint** | `https://integrate.api.nvidia.com/v1` |
| **Model** | `meta/llama-3.3-70b-instruct` |
| **Auth** | API key as `Authorization: Bearer` |

```
── nvidia (openai-chat)  meta/llama-3.3-70b-instruct
  ✓ buffered call returns text                     "PONG"
  ✓ usage is reported, not invented                41 in / 3 out / 32 cached (reported)
  ✓ request id captured                            chatcmpl-79fd32d6-31fc-417b-8c85-dc2bc40
  ✓ finish reason                                  stop
  ✓ streaming deltas reconstruct the final text    2 deltas, reported usage
  ✓ responseFormat json is honoured                {"ok": true}
  ✓ a bogus model id yields a typed error          PermanentError (status 404)

7/7 checks passed
```

The `openai-chat` shape against a real cloud server rather than a local shim — the
same code path that reaches Groq, OpenRouter, Together, Fireworks, DeepSeek, xAI and
the rest of that tail, none of which needs a line of code here.

**First live confirmation of cached prompt tokens.** `32 cached` came from
`prompt_tokens_details.cached_tokens`. Cache reads are priced very differently from
fresh prompt tokens, so folding them into `promptTokens` — which is what happens
without this mapping — produces a cost figure that is confidently wrong rather than
merely absent.

**Known gaps at this date**

- A nonexistent model returns 404 but is classified `PermanentError`, **not**
  `ModelUnavailableError`. The condition is correctly permanent and the caller is not
  misled, but it loses the one distinction that tells a controller *"substitute a
  model"* rather than *"the request was malformed"*. This is the third provider whose
  404 wording the pattern has not matched on first contact; the harness now prints the
  unmatched message so the next run can close it.
- No `cache_creation` equivalent is reported by this endpoint, so `cacheWriteTokens`
  stays undefined. Correct — the router reports what it is told and nothing more.

---

## Promotion

`1.0.0-rc.1` sits on the `next` dist-tag. It is promoted to `latest` when the rows
above are filled in. **Vertex, the row the central claim rests on, is done**, as is
the local CLI bridge — the topology three of this branch's fixes were written for —
and NVIDIA NIM. **Anthropic is the only row left.** See the checklist at the end
of `SMOKE_TEST.md`.
