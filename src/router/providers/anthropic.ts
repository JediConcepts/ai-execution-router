/**
 * Anthropic Messages wire shape.
 *
 * Covers the Anthropic API and any gateway that proxies it verbatim — a
 * corporate egress proxy, an observability shim, a self-hosted relay. Point
 * `baseUrl` at it and supply whatever auth it wants via `headers`.
 *
 * NOT currently reachable: Bedrock and Vertex. Both serve Anthropic models, but
 * neither serves this exact shape. Bedrock posts to `/model/{id}/invoke` and
 * wants `anthropic_version` in the body with no `model` field; Vertex posts to
 * `…/publishers/anthropic/models/{model}:rawPredict`. The path and body here are
 * fixed, so a `baseUrl` alone cannot reach either. Supporting them means a
 * dedicated variant, not a configuration change — and claiming otherwise in the
 * docs would send callers to a 404.
 */

import type {
  WireFeature,
  ContentBlock,
  Message,
  Provider,
  ProviderCallParams,
  ProviderCallResult,
} from "../types.ts";
import { PermanentError } from "../errors.ts";
import { hasCallerAuth, malformedResponse, mergeHeaders, openSse, postJson, tokenSourceOf } from "../http.ts";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 1024;

/**
 * Reject a thinking budget that cannot fit inside the output allowance.
 *
 * Distinguishes the two cases, because the fix differs: if the caller set
 * `maxTokens` themselves, they need a bigger one; if they did not, the router's
 * own default is what is in the way and saying so saves a confusing round trip.
 */
function assertBudgetFitsMaxTokens(
  budgetTokens: number,
  maxTokens: number,
  callerSuppliedMaxTokens: number | undefined,
): void {
  if (budgetTokens < maxTokens) return;
  throw new PermanentError(
    callerSuppliedMaxTokens === undefined
      ? `reasoning.budgetTokens (${budgetTokens}) must be below maxTokens, which defaults to ` +
        `${DEFAULT_MAX_TOKENS} on this wire shape. Set maxTokens above the thinking budget.`
      : `reasoning.budgetTokens (${budgetTokens}) must be below maxTokens (${maxTokens}) — ` +
        "the thinking budget is taken out of the output allowance, not added to it.",
  );
}

/**
 * No `response-format-*`: the Messages API has no `response_format` field.
 * JSON output is achieved with tool-forcing or an assistant prefill, both of
 * which are caller-side techniques — the second is already expressible as a
 * trailing assistant message. Declaring support we do not have would mean
 * silently dropping the constraint.
 */
const ENCODES: ReadonlySet<WireFeature> = new Set<WireFeature>([
  "multimodal-image",
  "multimodal-document",
  "reasoning-budget",
  "streaming",
]);

export class AnthropicProvider implements Provider {
  readonly wireShape = "anthropic" as const;
  readonly encodes = ENCODES;

  async call(p: ProviderCallParams): Promise<ProviderCallResult> {
    const baseUrl = (p.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const streaming = typeof p.onDelta === "function";

    const body: Record<string, unknown> = {
      model: p.model,
      // Required by the API and with no server-side default worth relying on.
      max_tokens: p.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: p.input.messages.map(toAnthropicMessage),
    };
    if (p.input.system !== undefined) body.system = p.input.system;
    if (p.temperature !== undefined) body.temperature = p.temperature;
    if (p.reasoning?.budgetTokens !== undefined) {
      // The API requires max_tokens > thinking.budget_tokens: the budget is
      // carved out of the output allowance, not added to it. Left unchecked, a
      // caller who set a budget and no maxTokens got the 1024 default against a
      // larger budget and a guaranteed 400 whose message blamed the API for a
      // number the router invented. Refusing here says whose fault it is, and
      // picking an output budget on the caller's behalf is a cost decision this
      // layer does not make.
      assertBudgetFitsMaxTokens(p.reasoning.budgetTokens, body.max_tokens as number, p.maxTokens);
      body.thinking = { type: "enabled", budget_tokens: p.reasoning.budgetTokens };
    }
    if (streaming) body.stream = true;

    const base: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
    };
    // Two independent reasons to leave `x-api-key` off, and both are needed.
    // `hasCallerAuth` covers a caller who brought a bearer: a different header
    // name, so `mergeHeaders` cannot displace ours and the shape has to stand
    // down itself. The `p.apiKey` test covers every other scheme the router now
    // accepts — Azure's `api-key`, a Cloudflare Access service token — where
    // `apiKey` is legitimately empty and there is no `authorization` header to
    // detect. Without it, those callers got `x-api-key: ""` sent alongside their
    // real credential, which is a 401 on an otherwise correct request.
    if (p.apiKey && !hasCallerAuth(p.headers)) base["x-api-key"] = p.apiKey;
    const headers = mergeHeaders(base, p.headers);

    const request = { url: `${baseUrl}/v1/messages`, headers, body, signal: p.signal };
    return streaming ? this.stream(request, p.onDelta!) : this.buffered(request);
  }

  private async buffered(request: Parameters<typeof postJson>[0]): Promise<ProviderCallResult> {
    const { json, requestId } = await postJson<AnthropicResponse>(request);
    // See the note in openai-chat: an empty block list is an answer, an absent
    // one is a substituted body.
    if (!Array.isArray(json.content) || json.content.length === 0) {
      throw malformedResponse("no content blocks returned", json, requestId);
    }
    const text = json.content
      .filter((b): b is AnthropicTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    return {
      text,
      ...usageOf(json.usage),
      finishReason: json.stop_reason ?? undefined,
      // The payload id wins over the header. `msg_…` is what appears on the
      // invoice and in the provider's logs; a header id is whatever the last hop
      // chose to stamp on the way out, which is only useful when there is no
      // payload id at all. google-genai has always read it this way — the three
      // shapes now agree on what this field means.
      providerRequestId: json.id ?? requestId,
    };
  }

  private async stream(
    request: Parameters<typeof openSse>[0],
    onDelta: (delta: string) => void,
  ): Promise<ProviderCallResult> {
    let text = "";
    let stopReason: string | undefined;
    // Anthropic splits usage across two events: input tokens land on
    // `message_start`, output tokens on the final `message_delta`.
    let usage: AnthropicUsage = {};

    // Anthropic terminates with `message_stop`, never with `[DONE]`.
    let sawStop = false;
    const { requestId, frames } = await openSse(request);
    let messageId: string | undefined;

    for await (const raw of frames) {
      const event = raw as AnthropicStreamEvent;
      switch (event.type) {
        case "message_start":
          // The payload id wins where present, matching the buffered path.
          messageId ??= event.message?.id;
          if (event.message?.usage) usage = { ...usage, ...event.message.usage };
          break;
        case "content_block_delta": {
          const delta = event.delta;
          // `thinking_delta` is reasoning, not answer text — billed, but not output.
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            text += delta.text;
            onDelta(delta.text);
          }
          break;
        }
        case "message_delta":
          if (event.usage) usage = { ...usage, ...event.usage };
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          break;
        case "message_stop":
          sawStop = true;
          break;
      }
    }

    if (!sawStop && !stopReason) {
      // The length, never the text. `malformedResponse` puts its second argument
      // on `.body`, which controllers are told to log — so passing the partial
      // completion here wrote model output into every error sink.
      throw malformedResponse(
        "stream ended without a terminal event — the connection closed mid-answer",
        { textLength: text.length },
        requestId,
      );
    }

    return {
      text,
      ...usageOf(usage),
      finishReason: stopReason,
      providerRequestId: messageId ?? requestId,
    };
  }
}

function toAnthropicMessage(m: Message): { role: string; content: unknown } {
  if (typeof m.content === "string") return { role: m.role, content: m.content };
  return { role: m.role, content: m.content.map(toAnthropicBlock) };
}

function toAnthropicBlock(block: ContentBlock): unknown {
  if (block.type === "text") return { type: "text", text: block.text };
  return {
    type: block.type, // "image" | "document" — both use the same source envelope
    source: { type: "base64", media_type: block.source.mediaType, data: block.source.data },
  };
}

function usageOf(u: AnthropicUsage | undefined) {
  const prompt = u?.input_tokens;
  const completion = u?.output_tokens;
  return {
    promptTokens: prompt ?? 0,
    completionTokens: completion ?? 0,
    tokenSource: tokenSourceOf(prompt, completion),
    cachedPromptTokens: u?.cache_read_input_tokens,
    cacheWriteTokens: u?.cache_creation_input_tokens,
  };
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicResponse {
  id?: string;
  content?: Array<AnthropicTextBlock | { type: string }>;
  usage?: AnthropicUsage;
  stop_reason?: string | null;
}

interface AnthropicStreamEvent {
  type?: string;
  message?: { id?: string; usage?: AnthropicUsage };
  delta?: { type?: string; text?: string; stop_reason?: string };
  usage?: AnthropicUsage;
}
