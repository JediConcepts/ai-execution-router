# Changelog

## 0.2.0 — unreleased

This release is **breaking**. Under 0.x there is no major number to bump, so a minor
bump is the breaking signal, per the versioning rule in `ARCHITECTURE.md`.

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
