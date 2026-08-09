/**
 * Google GenAI `generateContent` wire shape.
 *
 * The third genuinely different schema the router speaks: `contents[]` of
 * `parts[]` rather than `messages[]`, the assistant turn is called `model`,
 * the system prompt is hoisted out of the turn list into `systemInstruction`,
 * and usage arrives as `usageMetadata`.
 *
 * Served by both the Gemini Developer API and Vertex AI. The two differ only in
 * URL prefix and credential, and both are reachable without a line of
 * conditional code here:
 *
 *   Developer API  baseUrl: (default) + `endpoint.apiKey`
 *   Vertex AI      baseUrl: https://{region}-aiplatform.googleapis.com/v1/
 *                             projects/{project}/locations/{region}/publishers/google
 *                  headers: { authorization: `Bearer ${adcToken}` }
 *
 * Vertex wants an OAuth token rather than an API key. Minting it needs ambient
 * credentials, and the router reads no ambient state by design — so the
 * controller acquires the token and passes it as a header. The execution
 * boundary holds under an auth model it was never built for, which is the point.
 */

import type {
  WireFeature,
  ContentBlock,
  Message,
  Provider,
  ProviderCallParams,
  ProviderCallResult,
  ResponseFormat,
} from "../types.ts";
import { PermanentError } from "../errors.ts";
import { hasCallerAuth, malformedResponse, mergeHeaders, openSse, postJson, tokenSourceOf } from "../http.ts";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

const ENCODES: ReadonlySet<WireFeature> = new Set<WireFeature>([
  "multimodal-image",
  "multimodal-document",
  "response-format-json",
  "response-format-schema",
  "reasoning-budget",
  "streaming",
]);

export class GoogleGenAIProvider implements Provider {
  readonly wireShape = "google-genai" as const;
  readonly encodes = ENCODES;

  async call(p: ProviderCallParams): Promise<ProviderCallResult> {
    const baseUrl = (p.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    // Callers commonly write the fully-qualified "models/gemini-…"; the path
    // template supplies that segment itself.
    const model = p.model.replace(/^models\//, "");
    const streaming = typeof p.onDelta === "function";

    const generationConfig: Record<string, unknown> = {};
    if (p.maxTokens !== undefined) generationConfig.maxOutputTokens = p.maxTokens;
    if (p.temperature !== undefined) generationConfig.temperature = p.temperature;
    if (p.responseFormat) Object.assign(generationConfig, toGenerationFormat(p.responseFormat));
    if (p.reasoning?.budgetTokens !== undefined) {
      // `thinkingBudget` is the Gemini 2.5-lineage control. If a newer model
      // family replaces it with a coarse level, that needs its own field —
      // quietly mapping a token budget onto a level would be the router making
      // a cost/quality judgement on the caller's behalf.
      generationConfig.thinkingConfig = { thinkingBudget: p.reasoning.budgetTokens };
    }

    const body: Record<string, unknown> = { contents: p.input.messages.map(toContent) };
    if (p.input.system !== undefined) {
      body.systemInstruction = { parts: [{ text: p.input.system }] };
    }
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

    const method = streaming ? "streamGenerateContent" : "generateContent";
    const query = streaming ? "?alt=sse" : "";
    const request = {
      url: `${baseUrl}/models/${model}:${method}${query}`,
      headers: buildHeaders(p.apiKey, p.headers),
      body,
      signal: p.signal,
    };

    return streaming ? this.stream(request, p.onDelta!) : this.buffered(request);
  }

  private async buffered(request: Parameters<typeof postJson>[0]): Promise<ProviderCallResult> {
    const { json, requestId } = await postJson<GenerateContentResponse>(request);
    throwIfPromptBlocked(json);
    // Past the block check, no candidates means no response — not a silent one.
    if (!Array.isArray(json.candidates) || json.candidates.length === 0) {
      throw malformedResponse("no candidates returned", json, requestId);
    }

    const candidate = json.candidates[0];
    // `thought: true` parts are reasoning traces, not answer text. The streaming
    // path already skips them; without the same filter here the identical
    // request would return different text depending on whether onDelta was passed.
    const text = (candidate?.content?.parts ?? [])
      .filter((part) => part.thought !== true)
      .map((part) => part.text ?? "")
      .join("");

    return {
      text,
      ...usageOf(json.usageMetadata),
      finishReason: candidate?.finishReason,
      providerRequestId: json.responseId ?? requestId,
    };
  }

  private async stream(
    request: Parameters<typeof openSse>[0],
    onDelta: (delta: string) => void,
  ): Promise<ProviderCallResult> {
    let text = "";
    let finishReason: string | undefined;
    // Every frame repeats cumulative usage; the last one seen is authoritative.
    let usage: UsageMetadata | undefined;
    let sawCandidate = false;
    let blocked: GenerateContentResponse | undefined;

    const { requestId, frames } = await openSse(request);
    let responseId: string | undefined;

    for await (const raw of frames) {
      const chunk = raw as GenerateContentResponse;
      responseId ??= chunk.responseId;
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
      if (chunk.promptFeedback?.blockReason) blocked = chunk;

      const candidate = chunk.candidates?.[0];
      if (!candidate) continue;
      sawCandidate = true;
      for (const part of candidate.content?.parts ?? []) {
        // `thought: true` parts are reasoning traces, not answer text.
        if (part.thought === true || typeof part.text !== "string" || part.text.length === 0) continue;
        text += part.text;
        onDelta(part.text);
      }
      if (candidate.finishReason) finishReason = candidate.finishReason;
    }

    if (!sawCandidate && blocked) throwIfPromptBlocked(blocked);
    // Google sends no `[DONE]`; the last candidate's finishReason is the marker.
    if (!finishReason) {
      throw malformedResponse(
        "stream ended without a finishReason — the connection closed mid-answer",
        { text },
        requestId,
      );
    }

    // Google reports its own id in the payload; the header is the fallback.
    return { text, ...usageOf(usage), finishReason, providerRequestId: responseId ?? requestId };
  }
}

/**
 * A prompt rejected by safety filters returns HTTP 200 with no candidates.
 *
 * Left alone that is indistinguishable from a model with nothing to say, so it
 * is promoted to an error carrying the actual reason.
 */
function throwIfPromptBlocked(json: GenerateContentResponse): void {
  const blockReason = json.promptFeedback?.blockReason;
  if (!blockReason) return;
  if (json.candidates && json.candidates.length > 0) return;
  throw new PermanentError(`prompt blocked by provider: ${blockReason}`, json, {
    status: 200,
    providerCode: blockReason,
  });
}

function buildHeaders(
  apiKey: string,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  const base: Record<string, string> = { "content-type": "application/json" };
  // Vertex authenticates with a bearer token instead of an API key. When the
  // caller supplies one, sending a stray `x-goog-api-key` alongside it is at
  // best noise and at worst a rejected request.
  if (!hasCallerAuth(extra)) base["x-goog-api-key"] = apiKey;
  return mergeHeaders(base, extra);
}

function toContent(m: Message): { role: string; parts: unknown[] } {
  const role = m.role === "assistant" ? "model" : "user";
  if (typeof m.content === "string") return { role, parts: [{ text: m.content }] };
  return { role, parts: m.content.map(toPart) };
}

function toPart(block: ContentBlock): unknown {
  if (block.type === "text") return { text: block.text };
  // Images and documents share one inline envelope; the mime type distinguishes them.
  return { inlineData: { mimeType: block.source.mediaType, data: block.source.data } };
}

function toGenerationFormat(rf: ResponseFormat): Record<string, unknown> {
  if (rf.type === "text") return { responseMimeType: "text/plain" };
  if (rf.type === "json") return { responseMimeType: "application/json" };
  // `responseSchema` accepts an OpenAPI-3 subset rather than full JSON Schema.
  // It is forwarded as given: rewriting the caller's schema would be the router
  // making a semantic decision about their contract.
  return { responseMimeType: "application/json", responseSchema: rf.schema };
}

function usageOf(u: UsageMetadata | undefined) {
  const prompt = u?.promptTokenCount;
  const completion = u?.candidatesTokenCount;
  return {
    promptTokens: prompt ?? 0,
    completionTokens: completion ?? 0,
    tokenSource: tokenSourceOf(prompt, completion),
    cachedPromptTokens: u?.cachedContentTokenCount,
    reasoningTokens: u?.thoughtsTokenCount,
  };
}

interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

interface GenerateContentResponse {
  responseId?: string;
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
  }>;
  usageMetadata?: UsageMetadata;
  promptFeedback?: { blockReason?: string };
}
