import type { Provider, ProviderCallParams, ProviderCallResult } from "../types.ts";
import { classifyHttpError, PermanentError, TransientError } from "../errors.ts";

export class OpenAICompatibleProvider implements Provider {
  async call(p: ProviderCallParams): Promise<ProviderCallResult> {
    if (!p.baseUrl) {
      throw new PermanentError("baseUrl is required for openai-compatible provider");
    }
    const baseUrl = p.baseUrl.replace(/\/$/, "");

    const messages: Array<{ role: string; content: string }> = [];
    if (p.input.system !== undefined) {
      messages.push({ role: "system", content: p.input.system });
    }
    for (const m of p.input.messages) {
      messages.push({ role: m.role, content: m.content });
    }

    const body: Record<string, unknown> = { model: p.model, messages };
    if (p.maxTokens !== undefined) body.max_tokens = p.maxTokens;
    if (p.temperature !== undefined) body.temperature = p.temperature;

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${p.apiKey}`,
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

    const json = (await response.json()) as OpenAIResponse;
    const choice = json.choices?.[0];
    return {
      text: choice?.message?.content ?? "",
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
      finishReason: choice?.finish_reason ?? undefined,
    };
  }
}

interface OpenAIResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
