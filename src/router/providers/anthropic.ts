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
import { hasCallerAuth, malformedResponse, mergeHeaders, openSse, postJson, tokenSourceOf } from "../http.ts";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

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
      max_tokens: p.maxTokens ?? 1024,
      messages: p.input.messages.map(toAnthropicMessage),
    };
    if (p.input.system !== undefined) body.system = p.input.system;
    if (p.temperature !== undefined) body.temperature = p.temperature;
    if (p.reasoning?.budgetTokens !== undefined) {
      body.thinking = { type: "enabled", budget_tokens: p.reasoning.budgetTokens };
    }
    if (streaming) body.stream = true;

    const base: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
    };
    // When the caller brought their own bearer — a gateway, a relay — `apiKey`
    // is legitimately absent, and sending `x-api-key: ""` alongside it is at
    // best noise and at worst a 401 on a correctly credentialled request.
    if (!hasCallerAuth(p.headers)) base["x-api-key"] = p.apiKey;
    const headers = mergeHeaders(base, p.headers);

    const request = { url: `${baseUrl}/v1/messages`, headers, body, signal: p.signal };
    return streaming ? this.stream(request, p.onDelta!) : this.buffered(request);
  }

  private async buffered(request: Parameters<typeof postJson>[0]): Promise<ProviderCallResult> {
    const { json, requestId } = await postJson<AnthropicResponse>(request);
    // See the note in openai-chat: an empty block list is an answer, an absent
    // one is a substituted body.
    if (!Array.isArray(json.content)) throw malformedResponse("no content array", json, requestId);
    const text = json.content
      .filter((b): b is AnthropicTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    return {
      text,
      ...usageOf(json.usage),
      finishReason: json.stop_reason ?? undefined,
      providerRequestId: requestId ?? json.id,
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

    const { requestId, frames } = await openSse(request);
    let messageId: string | undefined = requestId;

    for await (const raw of frames) {
      const event = raw as AnthropicStreamEvent;
      switch (event.type) {
        case "message_start":
          // The header id wins where present, matching the buffered path.
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
      }
    }

    return {
      text,
      ...usageOf(usage),
      finishReason: stopReason,
      providerRequestId: messageId,
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
