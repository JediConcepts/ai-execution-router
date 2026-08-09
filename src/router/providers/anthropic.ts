/**
 * Anthropic Messages wire shape.
 *
 * Served by Anthropic direct, AWS Bedrock, and GCP Vertex. Bedrock and Vertex
 * differ only in `baseUrl` and auth, both of which reach this provider through
 * `endpoint.baseUrl` / `endpoint.headers` — no code here knows which one it is
 * talking to.
 */

import type {
  Capability,
  ContentBlock,
  Message,
  Provider,
  ProviderCallParams,
  ProviderCallResult,
} from "../types.ts";
import { mergeHeaders, postJson, postSse, tokenSourceOf } from "../http.ts";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * No `response-format-*`: the Messages API has no `response_format` field.
 * JSON output is achieved with tool-forcing or an assistant prefill, both of
 * which are caller-side techniques — the second is already expressible as a
 * trailing assistant message. Declaring support we do not have would mean
 * silently dropping the constraint.
 */
const CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "multimodal-image",
  "multimodal-document",
  "reasoning-budget",
  "streaming",
]);

export class AnthropicProvider implements Provider {
  readonly wireShape = "anthropic" as const;
  readonly capabilities = CAPABILITIES;

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

    const headers = mergeHeaders(
      {
        "content-type": "application/json",
        "x-api-key": p.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      p.headers,
    );

    const request = { url: `${baseUrl}/v1/messages`, headers, body, signal: p.signal };
    return streaming ? this.stream(request, p.onDelta!) : this.buffered(request);
  }

  private async buffered(request: Parameters<typeof postJson>[0]): Promise<ProviderCallResult> {
    const { json, requestId } = await postJson<AnthropicResponse>(request);
    const text = (json.content ?? [])
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
    request: Parameters<typeof postSse>[0],
    onDelta: (delta: string) => void,
  ): Promise<ProviderCallResult> {
    let text = "";
    let stopReason: string | undefined;
    let messageId: string | undefined;
    // Anthropic splits usage across two events: input tokens land on
    // `message_start`, output tokens on the final `message_delta`.
    let usage: AnthropicUsage = {};

    for await (const raw of postSse(request)) {
      const event = raw as AnthropicStreamEvent;
      switch (event.type) {
        case "message_start":
          messageId = event.message?.id;
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
