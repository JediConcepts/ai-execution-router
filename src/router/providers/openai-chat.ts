/**
 * OpenAI Chat Completions wire shape.
 *
 * The broadest shape by far: OpenAI, Azure, NVIDIA NIM, Groq, OpenRouter,
 * Together, Fireworks, DeepSeek, xAI, Mistral, Cerebras, Ollama, LM Studio,
 * vLLM, and any local bridge exposing `/chat/completions`. Reaching a new one
 * of these is a `baseUrl`, not a provider.
 */

import type {
  Capability,
  ContentBlock,
  Message,
  Provider,
  ProviderCallParams,
  ProviderCallResult,
  ResponseFormat,
} from "../types.ts";
import { PermanentError } from "../errors.ts";
import { mergeHeaders, openSse, postJson, tokenSourceOf } from "../http.ts";

/**
 * No `multimodal-document`: document/file parts are not part of the chat
 * completions schema. Individual servers bolt on their own variants, but there
 * is no portable spelling, and inventing one would produce a request most of
 * the compatible tail would reject.
 */
const CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "multimodal-image",
  "response-format-json",
  "response-format-schema",
  "reasoning-effort",
  "streaming",
]);

export class OpenAIChatProvider implements Provider {
  readonly wireShape = "openai-chat" as const;
  readonly capabilities = CAPABILITIES;

  async call(p: ProviderCallParams): Promise<ProviderCallResult> {
    if (!p.baseUrl) {
      throw new PermanentError(
        "baseUrl is required for the openai-chat wire shape — it identifies which server is being called",
      );
    }
    const baseUrl = p.baseUrl.replace(/\/+$/, "");
    const streaming = typeof p.onDelta === "function";

    const messages: Array<{ role: string; content: unknown }> = [];
    if (p.input.system !== undefined) messages.push({ role: "system", content: p.input.system });
    for (const m of p.input.messages) messages.push(toChatMessage(m));

    const body: Record<string, unknown> = { model: p.model, messages };
    // `max_tokens` rather than `max_completion_tokens`: the former is what the
    // compatible ecosystem accepts, and the latter is not understood by most of it.
    if (p.maxTokens !== undefined) body.max_tokens = p.maxTokens;
    if (p.temperature !== undefined) body.temperature = p.temperature;
    if (p.responseFormat) body.response_format = toResponseFormat(p.responseFormat);
    if (p.reasoning?.effort !== undefined) body.reasoning_effort = p.reasoning.effort;
    if (streaming) {
      body.stream = true;
      // Without this most servers omit `usage` entirely on a streamed response,
      // which would silently downgrade every streamed call to "unreported".
      body.stream_options = { include_usage: true };
    }

    const headers = mergeHeaders(
      { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
      p.headers,
    );

    const request = { url: `${baseUrl}/chat/completions`, headers, body, signal: p.signal };
    return streaming ? this.stream(request, p.onDelta!) : this.buffered(request);
  }

  private async buffered(request: Parameters<typeof postJson>[0]): Promise<ProviderCallResult> {
    const { json, requestId } = await postJson<OpenAIResponse>(request);
    const choice = json.choices?.[0];
    return {
      text: choice?.message?.content ?? "",
      ...usageOf(json.usage),
      finishReason: choice?.finish_reason ?? undefined,
      providerRequestId: requestId ?? json.id,
    };
  }

  private async stream(
    request: Parameters<typeof openSse>[0],
    onDelta: (delta: string) => void,
  ): Promise<ProviderCallResult> {
    let text = "";
    let finishReason: string | undefined;
    let usage: OpenAIUsage | undefined;

    const { requestId, frames } = await openSse(request);
    let id: string | undefined = requestId;

    for await (const raw of frames) {
      const chunk = raw as OpenAIStreamChunk;
      id ??= chunk.id;
      // The usage-bearing frame typically carries an empty `choices` array.
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        text += delta;
        onDelta(delta);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    return { text, ...usageOf(usage), finishReason, providerRequestId: id };
  }
}

function toChatMessage(m: Message): { role: string; content: unknown } {
  if (typeof m.content === "string") return { role: m.role, content: m.content };
  return { role: m.role, content: m.content.map(toChatPart) };
}

function toChatPart(block: ContentBlock): unknown {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "image") {
    return {
      type: "image_url",
      image_url: { url: `data:${block.source.mediaType};base64,${block.source.data}` },
    };
  }
  // Unreachable: "multimodal-document" is not declared, so the router rejects
  // document blocks before a provider ever sees them.
  throw new PermanentError(`openai-chat cannot encode content block "${block.type}"`);
}

function toResponseFormat(rf: ResponseFormat): unknown {
  if (rf.type === "text") return { type: "text" };
  if (rf.type === "json") return { type: "json_object" };
  return {
    type: "json_schema",
    json_schema: { name: rf.name ?? "response", schema: rf.schema, strict: true },
  };
}

function usageOf(u: OpenAIUsage | undefined) {
  const prompt = u?.prompt_tokens;
  const completion = u?.completion_tokens;
  return {
    promptTokens: prompt ?? 0,
    completionTokens: completion ?? 0,
    tokenSource: tokenSourceOf(prompt, completion),
    cachedPromptTokens: u?.prompt_tokens_details?.cached_tokens,
    reasoningTokens: u?.completion_tokens_details?.reasoning_tokens,
  };
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface OpenAIResponse {
  id?: string;
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: OpenAIUsage;
}

interface OpenAIStreamChunk {
  id?: string;
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: OpenAIUsage;
}
