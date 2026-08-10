/**
 * Live smoke run.
 *
 * Every other test in this repository mocks `fetch`. That suite has now been
 * fully green twice while two independent reviews found real bugs behind it, so
 * this file exists to check the things a mock cannot: that the wire formats are
 * actually accepted, that usage really is reported, that errors really do arrive
 * as the taxonomy claims, and that streaming frames really do parse.
 *
 * It calls real endpoints and spends real (tiny) money. Prompts are a handful of
 * tokens and `maxTokens` is capped at 32; a full run is fractions of a cent.
 *
 * Targets whose credentials are absent are skipped, not failed — run whichever
 * subset you have keys for. See docs/SMOKE_TEST.md for setup.
 *
 *   npm run build && npm run smoke    # every configured target
 *   npm run smoke -- vertex           # just one
 *
 * It imports `dist/`, deliberately: the point is to exercise the artefact that
 * actually ships, on the Node version consumers actually run, rather than the
 * TypeScript sources that only the repo's own toolchain ever sees.
 */

let complete, AuthError, LLMError, ModelUnavailableError, QuotaExhaustedError, UnsupportedCapabilityError;
try {
  ({ complete, AuthError, LLMError, ModelUnavailableError, QuotaExhaustedError, UnsupportedCapabilityError } =
    await import("../dist/index.js"));
} catch (err) {
  console.error(
    "Could not load ../dist/index.js — run `npm run build` first.\n" +
    `(${err?.message ?? err})`,
  );
  process.exit(1);
}

const PROMPT = { messages: [{ role: "user", content: "Reply with exactly: PONG" }] };

/**
 * Deliberately generous for a two-token answer.
 *
 * Reasoning models bill thinking against the SAME output ceiling — Gemini counts
 * `thoughtsTokenCount` inside `maxOutputTokens` — so a tight budget is consumed
 * before any answer text exists. A 32-token cap produced `finishReason:
 * MAX_TOKENS` with empty text, no stream deltas, and JSON truncated mid-string:
 * one cause, three symptoms, none of them the router's fault. Still under a
 * hundredth of a cent per call.
 */
const MAX_TOKENS = 512;

// ── Target definitions ────────────────────────────────────────────────────────

const env = (...names) => names.map((n) => process.env[n]).find(Boolean);

function targets() {
  const out = [];

  const anthropicKey = env("ANTHROPIC_API_KEY");
  if (anthropicKey) {
    out.push({
      name: "anthropic",
      envVar: "SMOKE_ANTHROPIC_MODEL",
      supportsBudget: true,
      model: env("SMOKE_ANTHROPIC_MODEL") ?? "claude-haiku-4-5",
      endpoint: { provider: "anthropic", apiKey: anthropicKey },
      // The Messages API has no response_format field; the router must say so.
      refuses: { responseFormat: { type: "json" } },
    });
  }

  const geminiKey = env("GEMINI_API_KEY", "GOOGLE_API_KEY");
  if (geminiKey) {
    out.push({
      name: "gemini-developer",
      envVar: "SMOKE_GEMINI_MODEL",
      supportsBudget: true,
      model: env("SMOKE_GEMINI_MODEL") ?? "gemini-flash-latest",
      endpoint: { provider: "google-genai", apiKey: geminiKey },
      supportsJson: true,
    });
  }

  const vertexToken = env("VERTEX_ACCESS_TOKEN");
  const vertexProject = env("VERTEX_PROJECT", "GOOGLE_CLOUD_PROJECT");
  const vertexRegion = env("VERTEX_REGION") ?? "us-central1";
  if (vertexToken && vertexProject) {
    out.push({
      name: "vertex",
      envVar: "SMOKE_VERTEX_MODEL",
      supportsBudget: true,
      model: env("SMOKE_VERTEX_MODEL") ?? "gemini-flash-latest",
      endpoint: {
        provider: "google-genai",
        baseUrl:
          `https://${vertexRegion}-aiplatform.googleapis.com/v1` +
          `/projects/${vertexProject}/locations/${vertexRegion}/publishers/google`,
        // No apiKey at all — the bearer IS the credential. This is the case the
        // router had to grow a rule for, so it is the case most worth proving.
        headers: { Authorization: `Bearer ${vertexToken}` },
      },
      supportsJson: true,
    });
  }

  const nvidiaKey = env("NVIDIA_API_KEY");
  if (nvidiaKey) {
    out.push({
      name: "nvidia (openai-chat)",
      envVar: "SMOKE_NVIDIA_MODEL",
      model: env("SMOKE_NVIDIA_MODEL") ?? "meta/llama-3.3-70b-instruct",
      endpoint: {
        provider: "openai-chat",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: nvidiaKey,
      },
      supportsJson: true,
    });
  }

  const bridgeUrl = env("BRIDGE_URL") ?? (env("SMOKE_BRIDGE") ? "http://127.0.0.1:8787/v1" : undefined);
  if (bridgeUrl) {
    out.push({
      name: "local-cli-bridge",
      envVar: "SMOKE_BRIDGE_MODEL",
      model: env("SMOKE_BRIDGE_MODEL") ?? "sonnet",
      endpoint: {
        provider: "openai-chat",
        baseUrl: bridgeUrl,
        apiKey: env("BRIDGE_API_KEY") ?? "none",
      },
      // The bridge deliberately 400s on streaming rather than ignoring it. A
      // clean typed error here is a PASS: it proves both sides fail loudly.
      streamingRejected: true,
      slow: true,
    });
  }

  return out;
}

/**
 * Ask the endpoint which models it will actually serve.
 *
 * A hardcoded default rots — `gemini-2.5-flash` was retired for new keys, and
 * `gemini-flash-latest` is a Developer API alias that Vertex does not recognise.
 * Rather than guess a third time, ask: which is the same answer this project gives
 * to "should the router ship a catalogue?" — no, the endpoint knows.
 *
 * The two Google surfaces answer in different shapes. The Developer API returns
 * `models[]` with `supportedGenerationMethods`; Vertex returns `publisherModels[]`
 * with `supportedActions` and fully-qualified `publishers/google/models/...` names.
 * Both are handled, because "it works on one Google endpoint" was exactly the
 * assumption that produced the wrong default.
 *
 * Best-effort and never fatal: a listing failure just means no suggestion.
 */
async function suggestModels(t) {
  if (t.endpoint.provider !== "google-genai") return null;
  const base = (t.endpoint.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const headers = { ...(t.endpoint.headers ?? {}) };
  if (!Object.keys(headers).some((k) => k.toLowerCase() === "authorization")) {
    headers["x-goog-api-key"] = t.endpoint.apiKey ?? "";
  }
  // Vertex does not list publisher models under projects/locations — that path
  // holds *your* uploaded models (which is also why `gcloud ai models list`
  // returns nothing here). Publisher models live at the host root under v1beta1.
  const vertexHost = base.match(/^(https:\/\/[^/]*-aiplatform\.googleapis\.com)/);
  const listUrl = vertexHost
    ? `${vertexHost[1]}/v1beta1/publishers/google/models?pageSize=200`
    : `${base}/models?pageSize=200`;

  // The listing path carries no project, so Google resolves one from ambient
  // credentials — and plain ADC has no quota project, so it bills Google's shared
  // default and 403s with SERVICE_DISABLED. Naming the project explicitly fixes it.
  //
  // Worth noting what this says about the router: its own calls never hit this,
  // because the project is in the URL path rather than inferred from whoever
  // happens to be logged in. Ambient resolution is the failure mode; explicit
  // parameters are the fix. That is the same argument, one layer down.
  const projectFromPath = base.match(/\/projects\/([^/]+)/)?.[1];
  if (vertexHost && projectFromPath) headers["x-goog-user-project"] = projectFromPath;

  try {
    const res = await fetch(listUrl, { headers });
    if (!res.ok) return null;
    const json = await res.json();
    const entries = json.models ?? json.publisherModels ?? [];
    return entries
      .filter((m) => {
        // Developer API states the methods outright. Vertex's shape varies, so an
        // absent field means "include it" rather than a silently empty list.
        const methods = m.supportedGenerationMethods;
        if (!Array.isArray(methods)) return true;
        return methods.includes("generateContent");
      })
      .map((m) => String(m.name ?? "").replace(/^(publishers\/google\/)?models\//, ""))
      .filter(Boolean)
      .sort();
  } catch {
    return null;
  }
}

/**
 * Why a successful call produced no text.
 *
 * "empty text" on its own sends you looking at the router. The finish reason
 * almost always names the real cause, and for reasoning models it is usually the
 * output budget being spent on thinking.
 */
function emptyTextDiagnosis(r) {
  const reason = r.finishReason ?? "no finishReason";
  if (/max.?tokens|length/i.test(reason)) {
    const thinking = r.reasoningTokens ? `${r.reasoningTokens} thinking tokens; ` : "";
    return `no text: hit the output ceiling (${reason}). ${thinking}` +
      "Reasoning models bill thinking against maxTokens — raise it, or set reasoning.budgetTokens lower.";
  }
  if (/safety|blocked|recitation/i.test(reason)) return `no text: the response was filtered (${reason}).`;
  return `no text on a successful call (finishReason: ${reason}).`;
}

/**
 * Ask `generateContent` directly which model ids a Vertex project will accept.
 *
 * Deliberately a guess list, deliberately confined to this harness. The listing
 * API is the correct answer and this is the fallback for when it returns nothing;
 * a 404 from a probe is information, whereas the same list shipped inside the
 * router would be a confident wrong answer with a shelf life.
 *
 * One token of output each, so the whole sweep costs almost nothing.
 */
const VERTEX_PROBE_IDS = [
  "gemini-2.0-flash-001",
  "gemini-2.0-flash",
  "gemini-2.5-flash",
  "gemini-2.5-flash-002",
  "gemini-2.5-pro",
  "gemini-2.0-flash-lite-001",
];

async function probeVertexModels(t) {
  const base = (t.endpoint.baseUrl ?? "").replace(/\/+$/, "");
  const headers = { "content-type": "application/json", ...(t.endpoint.headers ?? {}) };
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    generationConfig: { maxOutputTokens: 1 },
  });
  const accepted = [];
  for (const id of VERTEX_PROBE_IDS) {
    try {
      const res = await fetch(`${base}/models/${id}:generateContent`, { method: "POST", headers, body });
      // Anything that is not "no such model" means the id resolved — a 429 or a
      // 400 about the payload still tells us the model exists.
      if (res.status !== 404) accepted.push({ id, status: res.status });
    } catch {
      /* network hiccup on a probe is not worth reporting */
    }
  }
  return accepted;
}

// ── Harness ───────────────────────────────────────────────────────────────────

const results = [];
let indent = "";

function pass(what, detail) {
  results.push({ ok: true });
  console.log(`${indent}  \x1b[32m✓\x1b[0m ${what}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
}
function fail(what, detail) {
  results.push({ ok: false, what, detail });
  console.log(`${indent}  \x1b[31m✗\x1b[0m ${what}\n${indent}      \x1b[31m${detail}\x1b[0m`);
}
function warn(what, detail) {
  results.push({ ok: true, warned: true });
  console.log(`${indent}  \x1b[33m!\x1b[0m ${what}  \x1b[2m${detail}\x1b[0m`);
}

function unverified(what, detail) {
  results.push({ ok: true, warned: true, unverified: true });
  console.log(`${indent}  \x1b[33m?\x1b[0m ${what}  \x1b[2m${detail}\x1b[0m`);
}

async function check(what, fn) {
  try {
    const detail = await fn();
    pass(what, detail);
  } catch (err) {
    // Exhausting a free tier says nothing about the code. Filing it as a failure
    // buries real defects under an account limit, but calling it a pass would
    // claim a check ran when it did not — so it gets its own outcome.
    if (err instanceof QuotaExhaustedError) {
      unverified(what, "quota exhausted — check did not run; retry when the quota resets");
      return;
    }
    fail(what, `${err?.name ?? "Error"}: ${String(err?.message ?? err).slice(0, 200)}`);
  }
}

// ── The checks ────────────────────────────────────────────────────────────────

async function runTarget(t) {
  console.log(`\n\x1b[1m── ${t.name}\x1b[0m  \x1b[2m${t.model}\x1b[0m`);
  const timeoutMs = t.slow ? 900_000 : 60_000;
  const base = { model: t.model, endpoint: t.endpoint, maxTokens: MAX_TOKENS, timeoutMs };

  let buffered;
  let modelUnavailable = false;
  let authFailure = null;

  await check("buffered call returns text", async () => {
    try {
      buffered = await complete({ ...base, task: "smoke", input: PROMPT });
    } catch (err) {
      if (err instanceof ModelUnavailableError) modelUnavailable = true;
      if (err instanceof AuthError) authFailure = err;
      throw err;
    }
    if (!buffered.text?.trim()) throw new Error(emptyTextDiagnosis(buffered));
    return JSON.stringify(buffered.text.trim().slice(0, 40));
  });

  // Credentials or project configuration: every remaining check fails identically,
  // and four copies of the same message bury the one line that matters.
  if (authFailure) {
    console.log(`\n${indent}  \x1b[33mAuthentication or project configuration is blocking this target.\x1b[0m`);
    console.log(`${indent}  \x1b[2m${String(authFailure.message).slice(0, 300)}\x1b[0m`);
    if (/has not been used in project|is disabled|SERVICE_DISABLED/i.test(authFailure.message ?? "")) {
      console.log(`${indent}  Looks like the API is not enabled. For Vertex:`);
      console.log(`${indent}    \x1b[1mgcloud services enable aiplatform.googleapis.com --project=<project>\x1b[0m`);
    }
    console.log(`${indent}  \x1b[2mSkipping this target's remaining checks. See docs/SMOKE_TEST.md.\x1b[0m`);
    return;
  }

  // No point running four more checks against a model that does not exist — they
  // would all fail for the same reason and bury it.
  if (modelUnavailable) {
    const available = await suggestModels(t);
    console.log(`\n${indent}  \x1b[33mThe configured model is not available to this key.\x1b[0m`);
    if (available?.length) {
      console.log(`${indent}  The endpoint currently serves ${available.length} model(s), including:`);
      for (const name of available.slice(0, 8)) console.log(`${indent}    ${name}`);
      console.log(`${indent}  Re-run with e.g.  \x1b[1m${t.envVar}=${available[0]} npm run smoke -- ${t.name}\x1b[0m`);
    } else if (t.name === "vertex") {
      // The listing API returned nothing usable. Fall back to asking the endpoint
      // that definitely exists — generateContent — whether it accepts each of a
      // few plausible ids.
      //
      // This IS a guess list, and it is confined to the test harness on purpose.
      // It is not authoritative, it will go stale, and nothing like it belongs in
      // the router: a 404 here is information, whereas a stale id shipped inside
      // the library would be a confident wrong answer. See "Why there is no model
      // catalog" in ARCHITECTURE.md.
      console.log(`${indent}  The listing API returned nothing. Probing a few common ids directly…`);
      const found = await probeVertexModels(t);
      if (found.length) {
        console.log(`${indent}  Accepted by this project:`);
        for (const m of found) console.log(`${indent}    ${m.id}  \x1b[2m(HTTP ${m.status})\x1b[0m`);
        console.log(`${indent}  Re-run with  \x1b[1m${t.envVar}=${found[0].id} npm run smoke -- ${t.name}\x1b[0m`);
      } else {
        console.log(`${indent}  None of the probed ids were accepted. Check the Model Garden page`);
        console.log(`${indent}  for your project and region, then set \x1b[1m${t.envVar}\x1b[0m.`);
      }
    } else {
      console.log(`${indent}  Set \x1b[1m${t.envVar}\x1b[0m to a model this endpoint serves.`);
      if (t.name === "vertex") {
        console.log(`${indent}  To list them:  \x1b[1mgcloud ai model-garden models list\x1b[0m`);
        console.log(`${indent}  \x1b[2m(\`gcloud ai models list\` shows only models YOU uploaded, not Google's.)\x1b[0m`);
        console.log(`${indent}  \x1b[2mVertex uses its own model ids — Developer API aliases like`);
        console.log(`${indent}  "gemini-flash-latest" are not recognised there.\x1b[0m`);
      }
    }
    console.log(`${indent}  \x1b[2mSkipping this target's remaining checks.\x1b[0m`);
    return;
  }

  if (buffered) {
    // "unreported" is the designed, honest answer when an endpoint says nothing —
    // a warning, never a failure. It does bound what can be costed downstream.
    if (buffered.tokenSource === "unreported") {
      warn("usage reporting", "unreported — honest, but this endpoint cannot be costed");
    } else {
      const parts = [`${buffered.promptTokens} in`, `${buffered.completionTokens} out`];
      if (buffered.reasoningTokens) parts.push(`${buffered.reasoningTokens} thinking`);
      if (buffered.cachedPromptTokens) parts.push(`${buffered.cachedPromptTokens} cached`);
      pass("usage is reported, not invented", `${parts.join(" / ")} (${buffered.tokenSource})`);
    }

    if (buffered.providerRequestId) {
      pass("request id captured", buffered.providerRequestId.slice(0, 40));
    } else {
      warn("request id", "not reported — invoice reconciliation unavailable here");
    }

    if (buffered.finishReason) pass("finish reason", buffered.finishReason);
  }

  // Streaming: deltas must arrive, and must reconstruct the final text exactly.
  const streamCheck = async () => {
    const chunks = [];
    const r = await complete({ ...base, input: PROMPT, onDelta: (d) => chunks.push(d) });
    if (chunks.length === 0) throw new Error(`no deltas received — ${emptyTextDiagnosis(r)}`);
    const joined = chunks.join("");
    if (joined !== r.text) {
      throw new Error(`deltas !== final text (${JSON.stringify(joined)} vs ${JSON.stringify(r.text)})`);
    }
    return `${chunks.length} deltas, ${r.tokenSource} usage`;
  };

  if (t.streamingRejected) {
    // "It threw" is not the same as "the endpoint refused". A 4xx is the endpoint
    // declining loudly, which is what this check exists to verify. Our own
    // malformed-response guard firing means the endpoint *accepted* the streaming
    // request and answered with something that was not a stream — a quieter
    // failure that the router happened to catch, and not a pass.
    let outcome;
    try {
      const detail = await streamCheck();
      outcome = { kind: "succeeded", detail };
    } catch (err) {
      outcome = { kind: "threw", err };
    }

    if (outcome.kind === "succeeded") {
      warn(
        "streaming",
        `expected this endpoint to reject it, but it streamed: ${outcome.detail}`,
      );
    } else {
      const err = outcome.err;
      const status = err?.status;
      if (err instanceof LLMError && typeof status === "number" && status >= 400 && status < 500) {
        pass("streaming is refused cleanly by the endpoint", `HTTP ${status} — ${err.name}`);
      } else if (err instanceof LLMError) {
        warn(
          "streaming",
          `the endpoint did not refuse — the router's own guard caught the reply ` +
            `(${err.name}${status ? ` status ${status}` : ""}). ` +
            `Ideally the endpoint returns 4xx naming the feature.`,
        );
      } else {
        fail("streaming is refused cleanly", `unclassified error: ${err?.name}: ${err?.message}`);
      }
    }
  } else {
    await check("streaming deltas reconstruct the final text", streamCheck);
  }

  if (t.supportsJson) {
    await check("responseFormat json is honoured", async () => {
      const r = await complete({
        ...base,
        input: { messages: [{ role: "user", content: 'Return {"ok":true} and nothing else.' }] },
        responseFormat: { type: "json" },
      });
      JSON.parse(r.text); // throws if the constraint was ignored
      return r.text.trim().slice(0, 40);
    });
  }

  if (t.supportsBudget) {
    await check("an explicit thinking budget is accepted and reported", async () => {
      const r = await complete({
        ...base,
        input: PROMPT,
        reasoning: { budgetTokens: 128 },
      });
      if (!r.text?.trim()) throw new Error(emptyTextDiagnosis(r));
      return r.reasoningTokens !== undefined
        ? `${r.reasoningTokens} thinking tokens reported`
        : "accepted (endpoint reported no thinking count)";
    });
  }

  if (t.refuses) {
    await check("an unsupportable parameter is refused before the request", async () => {
      try {
        await complete({ ...base, input: PROMPT, ...t.refuses });
      } catch (err) {
        if (err instanceof UnsupportedCapabilityError) return err.message.slice(0, 70);
        throw new Error(`refused with the wrong type: ${err?.name}`);
      }
      throw new Error("expected UnsupportedCapabilityError, got a success");
    });
  }

  // The error taxonomy, against a real provider rather than a fixture.
  await check("a bogus model id yields a typed error", async () => {
    try {
      await complete({ ...base, model: "definitely-not-a-real-model-xyz", input: PROMPT });
    } catch (err) {
      if (err instanceof ModelUnavailableError) return `ModelUnavailableError (status ${err.status})`;
      if (err instanceof LLMError) {
        // An error delivered inside an HTTP 200 is the keep-alive topology: the
        // endpoint committed to a success status before its backend had failed.
        // Catching it at all is the point — left alone it reads as a model that
        // had nothing to say.
        if (err.status === 200) {
          return `${err.name} — error arrived inside a 200 body and was caught (not ` +
            `classified as ModelUnavailable, but not swallowed either)`;
        }
        // Providers word this inconsistently; a typed error still beats a raw one.
        // Print the message when we could not promote it: every time the classifier
        // has missed, the fix was one word in a pattern, and the only thing standing
        // between the miss and the fix was seeing what the provider actually said.
        const said = String(err.message ?? "").replace(/\s+/g, " ").slice(0, 160);
        return `${err.name} (status ${err.status}) — not classified as ModelUnavailable\n` +
          `${indent}      provider said: ${said}`;
      }
      throw new Error(`unclassified error: ${err?.name}: ${err?.message}`);
    }
    throw new Error("a nonexistent model returned a success");
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

const only = process.argv.slice(2);
const all = targets();
const selected = only.length ? all.filter((t) => only.some((o) => t.name.includes(o))) : all;

if (all.length === 0) {
  console.error(
    "No targets configured. Set at least one of ANTHROPIC_API_KEY, GEMINI_API_KEY,\n" +
    "VERTEX_ACCESS_TOKEN + VERTEX_PROJECT, NVIDIA_API_KEY, or BRIDGE_URL.\n" +
    "See docs/SMOKE_TEST.md.",
  );
  process.exit(1);
}
if (selected.length === 0) {
  console.error(`No configured target matched ${JSON.stringify(only)}. Available: ${all.map((t) => t.name).join(", ")}`);
  process.exit(1);
}

console.log(`\x1b[1mLive smoke run\x1b[0m — ${selected.length} target(s), real endpoints, real spend.`);
const skipped = all.length - selected.length;
if (skipped > 0) console.log(`\x1b[2m${skipped} configured target(s) not selected.\x1b[0m`);

for (const t of selected) {
  try {
    await runTarget(t);
  } catch (err) {
    fail(`${t.name} aborted`, String(err?.message ?? err));
  }
}

const failures = results.filter((r) => !r.ok);
const warnings = results.filter((r) => r.warned && !r.unverified);
const unverifiedCount = results.filter((r) => r.unverified).length;
console.log(
  `\n\x1b[1m${results.length - failures.length - unverifiedCount}/${results.length} checks passed\x1b[0m` +
  (unverifiedCount ? `, ${unverifiedCount} unverified (quota)` : "") +
  (warnings.length ? `, ${warnings.length} warning(s)` : ""),
);
if (unverifiedCount) {
  console.log(
    "\x1b[33mSome checks could not run because the endpoint's quota was exhausted.\x1b[0m\n" +
    "That is an account limit, not a defect — but those checks remain unproven.",
  );
}
if (failures.length) {
  console.log("\n\x1b[31mFailures:\x1b[0m");
  for (const f of failures) console.log(`  • ${f.what} — ${f.detail}`);
  process.exit(1);
}
if (selected.length < all.length || only.length > 0) {
  console.log(
    `\x1b[32mAll selected checks passed.\x1b[0m ` +
    `${selected.length} of ${all.length} configured target(s) ran — this is not yet a\n` +
    "promotion signal. Work the checklist at the end of docs/SMOKE_TEST.md.",
  );
} else if (warnings.length) {
  console.log(
    "\x1b[32mAll checks passed\x1b[0m, with warnings above. Confirm each warning is\n" +
    "expected for that endpoint before promoting.",
  );
} else {
  console.log(
    "\x1b[32mAll good.\x1b[0m Every configured target passed cleanly. Check the\n" +
    "docs/SMOKE_TEST.md list covers the targets you intend to support, then promote.",
  );
}
