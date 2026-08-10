# Changelog

## Unreleased

A fourth review round. Four of these were regressions introduced by the hardening in
1.0.0 — the fail-closed guards were right in principle and too eager in practice, and
each one turned a working call into a thrown error.

### Fixed — regressions in 1.0.0

- **A `data: [DONE]` arriving without its trailing blank line was not counted as a
  terminal event.** It fell into the tail-flush branch, which skipped it without
  setting `sawDone`, so a complete answer from any server that ends the body that way
  was rejected as truncated.
- **An empty `data:` keep-alive frame killed the stream.** `parseSseData` returns `""`
  for a heartbeat, `JSON.parse("")` throws, and the new fail-closed branch turned that
  into `MalformedResponseError` mid-answer. Heartbeats are now skipped like comments.
- **`anthropic` and `google-genai` sent an empty key header** when the caller
  authenticated with anything other than `authorization`. `resolveEndpoint` was widened
  in 1.0.0 to accept any header as a credential, but the two providers still gated on
  `hasCallerAuth`, so a Cloudflare Access or Azure-style caller got `x-api-key: ""`
  alongside their real credential. Both now also require a non-empty `apiKey`.
- **`isModelUnavailable` matched parameter rejections.** Widening the gap bound and
  adding "is not allowed" made `Model <id>: response_format is not supported` — how
  NVIDIA NIM rejects an unsupported field — classify as a dead model, so a controller
  retired a healthy endpoint instead of dropping one parameter. The two verdict classes
  are now separated: "gone" keeps the wide bound, "refused" may not cross a clause.

### Fixed — carried over from earlier rounds

- **A hanging `onAttempt` sink could hold a completed call open forever.** Neither
  `timeoutMs` nor the caller's `signal` covered that await. Bounded at 5s.
- **`latencyMs` included the audit sink's own duration**, so the record measured
  observation cost as provider cost. Now clocked when the provider returns.
- **`responseFormat: { type: "text" }` bypassed the capability gate** and was dropped
  silently by `anthropic`. Added `response-format-text` so every branch of the union is
  gated; the two shapes that implement it declare it.
- **A thinking budget at or above `max_tokens` is now refused before the request.**
  With `maxTokens` unset the router's own 1024 default collided with any larger budget
  and the API answered with a guaranteed 400 blaming a number the router invented.
- **408, 409 and 425 are `TransientError`; every other 4xx is `PermanentError`.** The
  unenumerated statuses previously returned a bare `LLMError`, outside both arms of the
  documented branch, so a retryable 408 was never retried and a 451 never failed over.
- **In-body errors with neither `message` nor `code` are no longer swallowed.** The
  FastAPI/vLLM `{"error":{"detail":…}}` shape returned `undefined` and reported an empty
  completion. Only the genuinely empty `{}` idiom now means "no error".
- **A falsy `"error"` field no longer discards a good completion.** `{"error": false}`
  was stringified into a thrown `TransientError`, throwing away an already-billed answer.
- **`cf-ray` removed from the request-id headers, and the payload id now wins.** A
  Cloudflare edge trace was displacing `chatcmpl-…`/`msg_…` in `providerRequestId`, the
  field documented as the key for invoice reconciliation. All three shapes now agree.
- **Stream-truncation errors carry the length, not the text.** The partial completion
  was being written to `err.body`, which controllers are told to log.

### Added

- `MalformedResponseError` — a named `TransientError` for a 200 carrying none of the
  fields its wire shape requires. Retryable when a proxy substituted the body,
  deterministic when the output allowance was consumed by thinking; one response cannot
  tell them apart, so the router names it rather than guessing.

### Fixed — tooling and docs

- The CI "smoke harness loads" step asserted `exit 1`, which a syntax error, a missing
  `dist/` and a clean no-op all satisfied — it could never fail. The harness now exits
  `78` for "loaded, no targets configured" and CI asserts on that.
- Unreachable Vertex guidance in `scripts/smoke.mjs` moved to a branch that can run.
- The retry rule is no longer described as firing "if and only if" a `retry-after` is
  present: the 60s ceiling and the `QuotaExhaustedError` split made that false in two
  directions. Corrected in `README.md`, `ARCHITECTURE.md` and `SKILL.md`.
- Removed a paragraph duplicated into a README section where its "these" had no
  antecedent.

## 1.0.1 — 2026-08-10

Metadata and documentation only. No code changes; `dist/` is byte-identical to 1.0.0.

- **npm now names Google.** The keywords listed `anthropic` and `openai` and no Google
  at all, so a search for `gemini` or `vertex` did not find this package — despite
  `google-genai` being a first-class wire format verified against two live Google
  endpoints. Added `google`, `gemini`, `vertex-ai`, `google-genai`, `claude`,
  `openai-compatible`, `nvidia-nim`, `ollama`, `vendor-neutral`.
- **The description names all three wire formats** rather than none.
- **The provider diagram shows Google**, alongside the suppliers each format reaches.
  It still showed the pre-Gemini set.
- **The live verification table moved above the fold.** Five endpoints, including
  Vertex AI with a controller-minted OAuth bearer and no API key — the most
  interesting property this package has, previously reachable only by opening
  `docs/VERIFIED.md`.

Registry metadata only refreshes on publish, which is why this is a release rather
than a docs commit.

## 1.0.0 — 2026-08-10

This release is **breaking**, and goes to 1.0.0 rather than 0.2.0 for a reason worth
stating: the versioning rule in `ARCHITECTURE.md` demands "a major version bump" for
exactly these changes, and 0.x cannot express one. An earlier draft claimed to follow
that rule while bumping a minor. It didn't. 1.0.0 makes the rule enforceable and gives
callers a `^1.x` range that actually protects them.

### Verified against live endpoints before release

| Endpoint | Wire shape | Result |
|---|---|---|
| Anthropic Messages | `anthropic` | 8/8 |
| Gemini Developer API | `google-genai` | 8/8, reproduced |
| Vertex AI | `google-genai` | 8/8, **no `apiKey`** — controller-minted OAuth bearer |
| NVIDIA NIM | `openai-chat` | 7/7, incl. cached prompt tokens |
| local-cli-bridge | `openai-chat` | 6/6, plus the post-header `TimeoutError` |

Full records, including known gaps per endpoint, in [`docs/VERIFIED.md`](./docs/VERIFIED.md).

Shipped as `1.0.0` on `latest` because the gate it was held behind has been met:
**all five rows of [`docs/VERIFIED.md`](./docs/VERIFIED.md) are green against live
endpoints** — Anthropic, the Gemini Developer API, Vertex AI, NVIDIA NIM, and a local
CLI bridge. Three wire shapes, five endpoints, dated and recorded with the commit each
was run against.

The candidate never needed publishing: the remaining checks were finished before it
would have been useful, so `1.0.0` goes straight out rather than an rc nobody would
have installed.

That matrix earned its keep. Two independent reviews found sixteen issues behind a
fully green mocked suite, and the live runs then found five more that no mock could
have — a dotted-model-name regex that never matched a real model id, spent credit
arriving as a 400 rather than a 429, and three others recorded in `VERIFIED.md`.

### Governance note — read this first

`ARCHITECTURE.md` publishes a **closed** list ("What the Router MAY Include") ending
with *"Anything not on this list does not belong in the router."* Several changes below
add behaviour that was not on that list. The list has been amended in the same commit,
which means the amendment cannot be used to justify the changes — the changes have to
justify the amendment. Each is argued individually under *Rule changes* below.

One edit deserves separate attention: the Phase 2 gate previously read
*"Phase 2 (versioned spec, **capability negotiation**, multi-language ports, sidecar
proxy) will not begin until at least two real projects have used Phase 1 in production
for thirty days."* The phrase "capability negotiation" was removed from that sentence,
because capability declaration now ships in Phase 1. That is a governing constraint
being relaxed by the same change it would otherwise have blocked. It is called out here
rather than left in the diff. See *Rule changes → Capability refusal*.

### Breaking

- **`endpoint.provider` is now required**, and the built-in model catalog is removed
  (`CATALOG` / `lookupCatalog` no longer exported). A call that previously relied on
  the catalog to infer its transport now throws `PermanentError`.
- **`ProviderName` values are wire shapes**: `"anthropic"`, `"openai-chat"`,
  `"google-genai"`. The former `"openai-compatible"` is accepted as an alias for
  `"openai-chat"` and is not scheduled for removal.
- **`UsageRecord` gained two required fields**, `wireShape` and `tokenSource`.
- **A 429 whose body indicates spent quota or credit now raises
  `QuotaExhaustedError`**, which extends `PermanentError`, not `RateLimitError`. It is
  therefore **no longer retried**. Callers relying on the old back-off behaviour for
  exhausted quota will now see an immediate throw — which is the intent.
- **Unsupported parameters now raise** `UnsupportedCapabilityError` instead of being
  silently dropped. Any call passing a parameter its wire shape cannot express changes
  from "quietly succeeds" to "fails".

### Fixed

- **The router had no timeout.** A hung provider hung the caller indefinitely. Adds
  `timeoutMs` and `signal`, composed into one deadline, raising `TimeoutError`
  (transient) or `CancelledError` (never retried) as appropriate.
- **An error delivered inside an HTTP 200 body was read as an empty completion.**
  Any proxy that must beat an upstream idle timeout — a Cloudflare Tunnel avoiding a
  524, a keep-alive shim in front of a slow CLI — commits to a 200 before the backend
  finishes, so late failures arrive in the body. These now raise.
- **A non-JSON body** (an HTML gateway error page) was likewise read as an empty
  completion. Now raises.
- **A safety-blocked Google prompt** returns HTTP 200 with no candidates; this was
  indistinguishable from a model with nothing to say. Now raises with the block reason.
- Errors now carry `status`, `providerCode`, `body`, and `requestId`, so callers no
  longer have to recover a failure category by pattern-matching an error message.

### Fixed (second pass, after independent code review)

An independent review of the branch found ten issues; all ten are addressed here.
Two were the same class of bug this release set out to fix, still present on paths
it had not covered:

- **The streaming path had no in-body error detection at all.** An `{"error":{…}}`
  frame mid-stream — or Anthropic's `event: error` — was swallowed and the
  truncated text returned as a success. The buffered path was fixed; the streamed
  path was not. Error frames now raise.
- **In-body errors were always classified transient.** The synthetic 502 used for
  a body-delivered error skipped the quota/context/model checks, so a spent-quota
  message in a 200 body produced a `TransientError` — the retry-forever behaviour
  `QuotaExhaustedError` exists to prevent. `classifyBodyError` now matches on the
  message directly, since a committed 200 has thrown the status channel away.
- **`retry-after` was honoured with no ceiling.** `Retry-After: 3600` blocked
  `complete()` for an hour when no `timeoutMs` was set. Waits beyond 60s now
  rethrow with `retryAfterMs` intact: a long wait is a failover decision.
- **`{"error": {}}` discarded good completions.** Some proxies always include the
  key. Detection now requires a non-empty message or code.
- **Anthropic sent `x-api-key: ""`** when the caller authenticated by header — the
  case `resolveEndpoint` explicitly permits. `google-genai` already guarded this;
  Anthropic now does too.
- **`provider in PROVIDERS`** walked the prototype chain, so `"toString"` passed
  validation and died later as a `TypeError`. Now `Object.hasOwn`.
- **Google's buffered path leaked reasoning traces.** Streaming skipped
  `thought: true` parts; buffered did not, so the same request returned different
  text depending on whether `onDelta` was passed.
- **Streaming discarded the header request id**, leaving `providerRequestId`
  undefined for endpoints that only report it there — a hole in the invoice
  reconciliation this release advertises.
- **The Bedrock and Vertex-Anthropic claim was false.** `ARCHITECTURE.md`, the
  README, and the provider header all said both were reachable via `baseUrl` +
  `headers`. They are not: Bedrock uses `/model/{id}/invoke` with
  `anthropic_version` in the body, Vertex uses `:rawPredict`. The claim is
  withdrawn and recorded under *Known gaps*. Vertex's Gemini surface genuinely
  does work and is tested.
- **`onUsage` throwing destroys a completion the caller already paid for.**
  Reviewed and kept, now documented as deliberate: it runs on the success path
  where a silent billing-write failure is the worse outcome, and awaiting it gives
  a slow sink backpressure. `onAttempt` is swallowed because it runs on the
  failure path, where throwing would destroy the provider's real error. Callers
  who prefer the text can catch inside their own callback.

### Fixed (third pass, after a second independent review)

A second review — run against the pushed branch, with live probes rather than
reading — found six more ways a failure could still be reported as a success, plus
a broken header merge. All six were reproduced locally before being fixed, and the
same probe now reports the corrected behaviour.

- **A caller's `Authorization` header queued behind ours instead of replacing it.**
  Object keys are case-sensitive; HTTP header names are not. Merging
  `{authorization}` with `{Authorization}` kept both, and `fetch` joined them into
  `"Bearer ours, Bearer theirs"` — a header no bearer check accepts. This broke
  every gateway and bridge the feature was added for. `mergeHeaders` now lowercases
  keys first.
- **A 200 carrying none of the shape's fields became an empty completion.** A bare
  `{}` produced `text: ""`. All three providers now require the response to have the
  field their schema is built on; an empty `content` *inside* a real choice is still
  a valid answer, an absent `choices` array is not.
- **A streaming request answered with a non-SSE body vanished.** The frame parser
  found no `data:` lines, yielded nothing, and returned success — so an error body
  returned against a streaming call disappeared entirely. Content-type is now
  checked, and a JSON body is classified rather than discarded.
- **A malformed frame mid-stream truncated silently.** The parser skipped
  unparseable frames by design, returning whatever arrived before the corruption as
  though the model had finished. Now fails closed, as does a stream cut mid-frame.
- **A deadline expiring during the body read threw a raw `DOMException`.** Body
  consumption sat outside the abort classifier, so the one topology most likely to
  hit it — a keep-alive shim flushing headers early and streaming the body minutes
  later, exactly what the local CLI bridge does — got an unclassified error instead
  of `TimeoutError`.
- **An `api-key`-only endpoint (Azure) was rejected before the request was sent**,
  despite the docs promising support. The credential check required `apiKey` or an
  `authorization` header; it now accepts any caller-supplied header. It exists to
  catch the empty-handed call, not to police auth schemes.

### Changed after review

- **`tokenSource: "provider"` → `"reported"`.** The old value implied the provider
  *measured* the counts. It only means the endpoint sent them — and an endpoint may
  be estimating: the local CLI bridge derives counts at roughly four characters per
  token because the CLI it wraps reports none. The router cannot tell that apart
  from a metered count, so it no longer implies it can.
- **`Capability` → `WireFeature`; `Provider.capabilities` → `Provider.encodes`.**
  The old name claimed more than the thing did. These sets describe what a
  *protocol* can encode, not what an endpoint or model will honour — `openai-chat`
  can encode `stream`, and the bridge behind it rejects it. Documented as a
  conservative, hand-maintained snapshot that lags provider additions, and lags
  closed.
- **`endpoint` and `endpoint.provider` are now required in the type.** Both were
  optional while being mandatory at runtime. With catalogue inference gone, the
  requirement belongs at compile time.
- **The versioning rule now says what happens pre-1.0.** It required "a major
  version bump" for breaking changes, which 0.x cannot express — so the claim that
  0.2.0 followed the rule was not true as written. The rule now states the pre-1.0
  convention explicitly and records that 1.0.0 is the better home for a kernel with
  production dependents. That call is open.
- **The Bedrock and Vertex gap list is marked dated, not authoritative.** Vendors
  keep adding compatibility surfaces; any of these may already have closed.

### Fixed (fourth pass, after a third review of the pushed branch)

- **A stream ending without a terminal event returned partial text as success.**
  Valid frames followed by a clean EOF — no `[DONE]`, no finish reason — is a
  socket closing, not a provider finishing. Each shape now requires its own
  marker: `[DONE]` or `finish_reason` for `openai-chat`, `message_stop` or
  `stop_reason` for `anthropic`, `finishReason` for `google-genai`.
- **Empty `choices` / `content` / `candidates` arrays became empty answers.** The
  previous fix required the array to exist; it must also be non-empty.
- **A body of `null`, `[]`, or a bare scalar dereferenced or coerced.** Rejected
  centrally in `postJson` now, before any provider touches it.
- **Non-string content was coerced into text.** `content: 42` returned `42` as the
  completion. Refused.
- **`openai-chat` still sent `Authorization: Bearer ` when authenticating by
  `api-key`.** The same empty-credential guard the other two shapes already had —
  fixed inconsistently the first time, now applied everywhere.
- **A deadline expiring while an ERROR body was read reported the original
  status**, not `TimeoutError`. `readErrorResponse` swallowed the abort.
- **`onAttempt` was fire-and-forget**, so an async sink could still be in flight
  when `complete()` returned and lose exactly the records worth keeping — the
  failures that made the process exit. Now awaited, still swallowed, so it gains
  durability without gaining the ability to mask the provider's error.

### Release process

- `package-lock.json` now matches the package version.
- `files` ships what the package advertises: `scripts/`, `docs/`, `CHANGELOG.md`.
- **The smoke harness imports `dist/`, not the TypeScript sources.** It exists to
  test the artefact that ships; importing `src/` tested something no consumer runs.
- The harness no longer prints "safe to promote" after running a single target.
- **New CI lane: packaged artefact on Node 20.** Builds, packs, installs the
  tarball into a clean project, imports through the package root and exercises the
  guards. A broken `files` list, a missing `dist`, a bad `exports` map or a stray
  `.ts` import now fails in CI rather than in someone's install.

### Governance (reversal)

- **"capability negotiation" is restored to the Phase 2 gate.** Deleting it was the
  wrong repair — it relaxed a constraint to fit an implementation. The distinction
  that should have been drawn is now explicit: *protocol encodability* (a fixed
  property of a schema, known at author time, no discovery) ships in Phase 1;
  *capability negotiation* (what an endpoint, account or model supports; probing;
  per-model tables; selection) remains Phase 2 and out of scope. The test: if
  answering "can this be encoded?" needs anything beyond which schema is spoken, it
  is negotiation.
- **`docs/PHASE_2_SPEC_PLAN.md` is marked superseded**, with a table of where it
  contradicts the implementation. It predates the wire-shape release and still
  assumed the model catalogue.
- **The Vertex auth claim is softened.** "OAuth, not an API key" was too absolute —
  Google offers API-key auth on Vertex surfaces too. It now reads as the *tested
  enterprise path*, which is the honest and still-interesting claim.
- **`budgetTokens` is documented as the Gemini 2.5-lineage control**
  (`thinkingConfig.thinkingBudget`). Newer families may use a coarse level instead;
  that will need its own field rather than a silent reinterpretation of this one.
- Stale `Capability` and `tokenSource: "provider"` references removed from the
  docs; every skill example now shows the required `endpoint.provider`.

### Fixed (fifth pass, after the first live call)

The first real request ever made through this router found a bug that 83 mocked
tests did not.

- **`ModelUnavailableError` never fired for real model ids.** The pattern bounded
  the gap between "model" and the verdict with `[^.]`, and every model id in
  production has dots in it — `gemini-2.5-flash`, `claude-4.6`, `gpt-5.4`. A live
  404 reading *"This model models/gemini-2.5-flash is no longer available"*
  classified as a plain `PermanentError`, so a controller could not tell "swap the
  model" from "the request was malformed". The synthetic test passed only because
  `definitely-not-a-real-model-xyz` has no dots in it.
- **Error messages were raw JSON envelopes.** A thrown error whose `.message` is
  400 characters of `{"error":{...}}` is unreadable in logs, in test output, and in
  a controller's skip log. The provider's own sentence is now the message; the full
  envelope stays on `.body` and the status string on `.providerCode`.
- **The smoke harness asks the endpoint which models it serves** when the
  configured one is unavailable, instead of failing four checks with the same
  message. `gemini-2.5-flash` was retired for new keys between the harness being
  written and first being run — a hardcoded default is the same catalogue rot the
  router refuses to ship, so the harness now does what it tells callers to do.

### Smoke harness (second live run)

No router changes — the harness was at fault, and the run is recorded because the
finding is worth keeping.

- **A 32-token output ceiling is unusable against a reasoning model.** Gemini bills
  `thoughtsTokenCount` inside `maxOutputTokens`, so the budget was spent thinking
  and the call returned `finishReason: MAX_TOKENS` with no answer text — which
  presented as three separate failures (empty text, zero stream deltas, JSON
  truncated mid-string) with one cause. Ceiling raised to 512.
- **Thinking and cached tokens are now printed.** Their absence from the output is
  what made the above hard to read; `reasoningTokens` named the cause immediately
  once shown.
- **"empty text on a successful call" now explains itself**, naming the finish
  reason and, for an output-ceiling stop, saying that reasoning models bill
  thinking against `maxTokens`.
- **New check: an explicit `reasoning.budgetTokens` is accepted and reported**, on
  the shapes that encode one.

The router's behaviour throughout was correct: it surfaced `MAX_TOKENS`, populated
`reasoningTokens`, and honestly downgraded `tokenSource` to `partial` when Gemini
omitted `candidatesTokenCount` rather than reporting a fabricated zero.

### Verified live (2026-08-10)

**Vertex AI: 8/8, with no `apiKey` set at all.** The controller mints an OAuth bearer,
passes it through `endpoint.headers`, and a router containing no knowledge of Google,
GCP or OAuth completes the call. The same `google-genai` provider serves both Google
surfaces, differing only in `baseUrl` and credential. This is the release's
architectural claim demonstrated rather than asserted.

Corroborating: `gcloud ai model-garden models list` and a bare `curl` to the
publisher-models listing both *fail* against the same project, because those paths
resolve the project from ambient credentials and plain ADC has no quota project
attached. The router is unaffected — the project is in the URL it was given. Ambient
resolution is the failure mode; explicit parameters are the fix.

**Gemini Developer API: 8/8.** Buffered and streamed completions, usage with
`thoughtsTokenCount` mapped to `reasoningTokens`, request id, `finishReason`, JSON
response format, an explicit thinking budget, and a nonexistent model classified as
`ModelUnavailableError`. Recorded in [`docs/VERIFIED.md`](./docs/VERIFIED.md).

**The 429 distinction proved itself.** A follow-up run exhausted the free tier and
produced a real *"You exceeded your current quota, please check your plan and billing
details"* — classified `QuotaExhaustedError`, not `RateLimitError`, and not retried.
That pattern was carried over from a production controller that had learned the
difference the expensive way; this is the first time it has been confirmed end to end
inside the kernel.

- **New: `docs/VERIFIED.md`** — dated, per-endpoint records with the commit each was
  run against. Deliberately not a catalogue: it claims only what happened on a given
  day. Vertex, Anthropic, the bridge and NVIDIA remain unrun.
- The harness now gives quota exhaustion its own outcome (`?  unverified`) rather
  than filing it as a failure. Running out of free tier says nothing about the code —
  but the check did not run, so it cannot count as a pass either.

### Added

- `google-genai` wire shape (Gemini Developer API and Vertex AI). `router.ts` gained
  one row in a lookup table and no branches.
- `endpoint.headers` — transport auth the router does not perform: Cloudflare Access
  service tokens, Azure `api-key`, a Vertex bearer minted by the controller.
  An `authorization` header now counts as the credential, so `apiKey` may be omitted.
- Multimodal `ContentBlock[]` message content (text / image / document), translated per
  wire shape.
- `responseFormat` (`text` / `json` / `json_schema`) and `reasoning`
  (`effort` **or** `budgetTokens`). The two reasoning currencies are never converted
  into one another — that is a cost/quality judgement, and therefore policy.
- `onDelta` streaming. `complete()` still resolves to exactly one `CompleteResult`;
  streaming is an observation channel, not a second execution model.
- `onAttempt`, fired once per attempt including failures and both legs of a retry.
  Separate from `onUsage`, which remains success-only so nothing starts billing for
  errors. A throwing `onAttempt` sink is swallowed rather than allowed to replace the
  provider's real error.
- Token provenance: `tokenSource` (`provider` / `partial` / `unreported`), plus
  `cachedPromptTokens`, `cacheWriteTokens`, `reasoningTokens`, and
  `providerRequestId`. **The router never estimates a token count.**
- `tests/compat.test.ts`, pinning the downstream controller's exact call shape.
- `npm run clean`, wired into `build` — `dist/` previously kept deleted modules and
  would have shipped them.

### Rule changes

Each of these adds something the published MAY-list did not permit. The argument for
each, so a reviewer can disagree with a specific one rather than the whole batch:

- **Deadlines and cancellation.** Argued as a defect, not a feature. *"The router calls
  one provider, once"* is not a meaningful guarantee if the call need never terminate.
- **Header passthrough.** Argued as already covered by *"provider transport"*. It also
  *reduces* what the kernel must know: credential acquisition stays outside, which is
  what let Vertex work without the router learning about OAuth.
- **Capability refusal.** The weakest fit, and the one that relaxed the Phase 2 gate.
  The defence is that this is not capability *negotiation* — there is no discovery, no
  per-model table, no selection. The router has always had to know what its own wire
  format can express; it previously acted on that knowledge by silently discarding the
  parameter. This changes the response from dropping to refusing. If that argument is
  rejected, the honest remedy is to restore the Phase 2 gate and revert this item; the
  rest of the release does not depend on it.
- **Streaming.** Argued as a transport mode rather than an execution model, on the
  strength of the return type being unchanged.
- **`onAttempt`.** The closest call against the MUST-NOT list, which forbids *"audit
  trails (decision logs, evidence chains)"*. The router emits a record and forgets it —
  it does not persist, correlate, or decide. This is the same posture as `onUsage`,
  which was always permitted. The MUST-NOT is read as forbidding the router from
  *keeping* an audit trail, not from emitting the facts one would be built from.
- **New error classes.** The MAY-list enumerated five by name. All additions except
  `CancelledError` extend an existing class, so existing `instanceof` checks keep
  working. `CancelledError` extends `LLMError` directly and is new behaviour on a path
  that did not previously exist.

### Removed

- `CATALOG`, `lookupCatalog`, and `tests/catalog.test.ts`. Rationale is recorded in
  `ARCHITECTURE.md` under *Why there is no model catalog*: the only production consumer
  never read it, a hardcoded model list rots, and encoding which endpoint serves a model
  imports the assumption that everyone reaches it the same way.
