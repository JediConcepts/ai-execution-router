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

### Added

- `google-genai` wire shape (Gemini Developer API and Vertex AI). `router.ts` gained
  one row in a lookup table and no branches.
- `endpoint.headers` — transport auth the router does not perform: Cloudflare Access
  service tokens, Azure `api-key`, a Vertex or Bedrock bearer minted by the controller.
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
