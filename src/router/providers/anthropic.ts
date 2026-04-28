import type { Provider, ProviderCallParams, ProviderCallResult } from "../types.ts";
import { classifyHttpError, TransientError } from "../errors.ts";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

export class AnthropicProvider implements Provider {
  async call(p: ProviderCallParams): Promise<ProviderCallResult> {
    const baseUrl = (p.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    const body: Record<string, unknown> = {
      model: p.model,
      max_tokens: p.maxTokens ?? 1024,
      messages: p.input.messages,
    };
    if (p.input.system !== undefined) body.system = p.input.system;
    if (p.temperature !== undefined) body.temperature = p.temperature;

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": p.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new TransientError(String((err as Error)?.message ?? "network error"), err);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw classifyHttpError(
        response.status,
        response.headers.get("retry-after") ?? undefined,
        text || response.statusText,
      );
    }

    const json = (await response.json()) as AnthropicResponse;
    const text = (json.content ?? [])
      .filter((b): b is AnthropicTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    return {
      text,
      promptTokens: json.usage?.input_tokens ?? 0,
      completionTokens: json.usage?.output_tokens ?? 0,
      finishReason: json.stop_reason ?? undefined,
    };
  }
}

interface AnthropicTextBlock { type: "text"; text: string }
interface AnthropicResponse {
  content?: Array<AnthropicTextBlock | { type: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string | null;
}
