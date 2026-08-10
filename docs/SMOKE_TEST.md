# Live smoke test

Everything in `npm test` mocks `fetch`. That suite has been fully green twice while
two independent reviews found real bugs behind it, so it is necessary and it is not
sufficient. This run checks the things a mock structurally cannot:

- the wire formats are actually **accepted** by the real API
- usage really is **reported** (and where it isn't, we find out rather than assume)
- errors really do arrive as the **taxonomy** claims
- streaming frames really do **parse and reassemble**

**Cost:** fractions of a cent. Prompts are a few tokens, `maxTokens` is capped at 32,
and each target makes at most five calls.

**Run it:**

```sh
npm run build                    # the harness exercises dist/, not the sources
npm run smoke                    # every target you have credentials for
npm run smoke -- vertex          # just one
npm run smoke -- gemini bridge   # a few
```

Targets without credentials are **skipped, not failed** — set up whichever you need.

Results go in [`VERIFIED.md`](./VERIFIED.md): dated, per-endpoint, with the commit
they were run against. That file is the honest alternative to a provider catalogue —
it claims only what happened on a given day, not what is true now.

---

## 1. Gemini Developer API

The easy one. Get a key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

```sh
export GEMINI_API_KEY='AIza…'
npm run build && npm run smoke -- gemini-developer
```

The free tier is enough.

**If the model is unavailable**, the harness asks the endpoint which models your key
can actually reach and prints them, rather than leaving you to guess:

```
  The configured model is not available to this key.
  The endpoint currently serves 24 model(s), including:
    gemini-flash-latest
    …
  Re-run with e.g.  SMOKE_GEMINI_MODEL=gemini-flash-latest npm run smoke -- gemini-developer
```

This happens: `gemini-2.5-flash` was retired for new keys between this harness being
written and first being run. The defaults here are a starting guess, not a catalogue —
which is the same reason the router itself ships no model list.

### Interop note found by this run: thinking tokens spend your output budget

Gemini counts `thoughtsTokenCount` **inside** `maxOutputTokens`. A reasoning model
given a small ceiling can consume the whole budget thinking and return **no answer at
all** — `finishReason: MAX_TOKENS`, empty text, zero deltas, and a JSON response
truncated mid-string. One cause, three symptoms, none of them a router fault.

The router reports this honestly and it is worth knowing what that looks like:

- `finishReason` is `MAX_TOKENS`, not `STOP`
- `reasoningTokens` is populated from `thoughtsTokenCount`
- `tokenSource` may read `partial`, because Gemini omits `candidatesTokenCount`
  entirely when no answer tokens were produced — an honest "we were told half of it"
  rather than a fabricated zero

If you are budgeting `maxTokens` for a Gemini model, budget for the thinking too, or
pass `reasoning: { budgetTokens: … }` to bound it explicitly. The harness now uses a
512-token ceiling for exactly this reason and prints thinking tokens when present.

**What it proves:** the `google-genai` wire shape end to end — `contents[]`/`parts[]`,
the `model` role, `systemInstruction`, `usageMetadata` mapping, `responseMimeType`
constraint, and SSE frames over `?alt=sse`.

---

## 2. Vertex AI

This is the one worth doing carefully, because it's the case the architecture argument
rests on: **the tested enterprise path to Vertex uses a controller-minted OAuth bearer
rather than an API key.** (Google offers API-key auth on some Vertex surfaces too; the
bearer is the harder case and therefore the one worth proving.) The router reads no
ambient credentials by design, so the token has to be minted outside and passed in as a
header. If that works, the execution boundary held under an auth model it was never
built for.

### One-time setup

```sh
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud services enable aiplatform.googleapis.com
```

Enabling the API is not optional and is easy to skip — a project that works fine with
the Gemini Developer API key will still 403 on Vertex until this is run. Allow a
minute for it to propagate.

Your account needs the **Vertex AI User** role (`roles/aiplatform.user`).

### Each run

Access tokens expire after about an hour, so mint one immediately before running:

```sh
export VERTEX_PROJECT="$(gcloud config get-value project)"
export VERTEX_REGION='us-central1'
export VERTEX_ACCESS_TOKEN="$(gcloud auth print-access-token)"

npm run smoke -- vertex
```

Note there is **no `VERTEX_API_KEY`** and the smoke config sets no `apiKey` at all.
That is deliberate: the bearer *is* the credential. If this passes, it proves the
router accepts a call with no API key whatsoever.

### If it fails

| Symptom | Cause |
|---|---|
| `AuthError` (401) | Token expired — re-run `gcloud auth print-access-token` |
| `AuthError` (403) *"has not been used in project … or it is disabled"* | The Vertex API is not enabled. `gcloud services enable aiplatform.googleapis.com --project=<project>`, then wait ~1 min |
| `AuthError` (403) *"permission denied"* | Missing `roles/aiplatform.user` on the account |
| `AuthError` (403) on a project created by AI Studio | Those projects often have no billing account attached; Vertex requires one, unlike the Gemini Developer API free tier |
| `ModelUnavailableError` (404) | Model not served in that region. Try `us-central1`, or set `SMOKE_VERTEX_MODEL` |
| `PermanentError` mentioning the URL | Wrong `VERTEX_REGION` — it appears twice in the URL and both must match |

The URL the router builds is worth seeing once, because it explains why Vertex needs
no code:

```
https://{region}-aiplatform.googleapis.com/v1
  /projects/{project}/locations/{region}/publishers/google
  /models/{model}:generateContent
```

Everything up to `/models/` is your `baseUrl`. The router appends the rest. That's the
whole Vertex integration.

---

## 3. Local CLI bridge

Checks the awkward topology on purpose: a keep-alive shim that commits to HTTP 200 and
flushes headers before a slow CLI has produced anything. That's where the
`TimeoutError` classification and the in-body-error handling actually matter.

### Terminal 1 — start the bridge

```sh
npx local-cli-bridge
# → listening on http://127.0.0.1:8787 ; backend=claude
```

Verify your CLI works standalone first (`claude -p "say ok"`).

### Terminal 2 — run the smoke test

```sh
export BRIDGE_URL='http://127.0.0.1:8787/v1'
export SMOKE_BRIDGE_MODEL='sonnet'      # or your Codex slug
# export BRIDGE_API_KEY='…'             # only if you started the bridge with one

npm run smoke -- local-cli-bridge
```

This target is **slow** — every request spawns a CLI process, so allow a minute or two.
The harness gives it a 15-minute deadline.

### What "pass" looks like here

Two results are inverted compared with the cloud targets, and both are correct:

- **Streaming is expected to FAIL**, with a clean typed `LLMError`. The bridge returns
  400 for `stream` rather than ignoring it. A typed refusal is the pass condition —
  it proves both sides fail loudly instead of degrading silently.
- **Usage may warn.** The bridge estimates tokens at roughly four characters each,
  because the CLI it wraps reports none. The router labels those `"reported"` — meaning
  *the endpoint sent them*, not that anyone measured them. Don't cost anything from
  bridge numbers.

### Testing the timeout path deliberately

The bug this topology exposed was a deadline expiring *after* headers arrived. To
exercise it:

```sh
npm run build
node --input-type=module -e '
import { complete, TimeoutError } from "./dist/index.js";
try {
  await complete({
    model: "sonnet",
    input: { messages: [{ role: "user", content: "Count slowly to 500." }] },
    endpoint: { provider: "openai-chat", baseUrl: "http://127.0.0.1:8787/v1", apiKey: "none" },
    timeoutMs: 3000,
  });
  console.log("FAIL: no timeout");
} catch (e) {
  console.log(e instanceof TimeoutError ? `PASS: ${e.name}` : `FAIL: got ${e.name}`);
}'
```

`TimeoutError` is the pass. A raw `AbortError` or `DOMException` means the regression
is back.

---

## 4. Optional: NVIDIA NIM

Broad coverage of the `openai-chat` shape against a real server, on a free tier.
Key from [build.nvidia.com](https://build.nvidia.com).

```sh
export NVIDIA_API_KEY='nvapi-…'
npm run smoke -- nvidia
```

---

## 5. Anthropic

```sh
export ANTHROPIC_API_KEY='sk-ant-…'
npm run smoke -- anthropic
```

Also checks that `responseFormat: { type: "json" }` is **refused** with
`UnsupportedCapabilityError` — the Messages API has no `response_format` field, and the
router must say so rather than drop the constraint.

---

## Reading the output

```
── vertex  gemini-flash-latest
  ✓ buffered call returns text            "PONG"
  ✓ usage is reported, not invented       9 in / 3 out (reported)
  ✓ request id captured                   xTf9…
  ✓ finish reason                         STOP
  ✓ streaming deltas reconstruct the final text   2 deltas, reported usage
  ✓ responseFormat json is honoured       {"ok":true}
  ✓ a bogus model id yields a typed error ModelUnavailableError (status 404)
```

- **✓** passed
- **!** warning — honest but limited behaviour (no usage reported, no request id). Not
  a bug; it does bound what you can do downstream.
- **✗** failure. Non-zero exit.

---

## Before promoting the release candidate

`1.0.0-rc.1` publishes to the `next` dist-tag, so `npm install ai-execution-router`
still resolves to the last stable version. Promote only when:

- [ ] Gemini Developer API passes
- [ ] **Vertex passes** — the OAuth-bearer path is the load-bearing architectural claim
- [ ] The bridge passes, including the deliberate timeout check
- [ ] At least one `openai-chat` cloud endpoint passes (NVIDIA or another)
- [ ] Anthropic passes, including the refusal check

Then:

```sh
npm dist-tag add ai-execution-router@1.0.0 latest
```

Until every box is ticked, a green `npm test` is not evidence that this works. It has
twice been green while it didn't.
