import type {
  CompleteParams,
  CompleteResult,
  Endpoint,
  Provider,
  ProviderName,
  UsageRecord,
} from "./types.ts";
import { AuthError, PermanentError, RateLimitError } from "./errors.ts";
import { lookupCatalog } from "./catalog.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.ts";

interface ResolvedEndpoint {
  provider: ProviderName;
  baseUrl?: string;
  apiKey: string;
}

export async function complete(params: CompleteParams): Promise<CompleteResult> {
  const endpoint = resolveEndpoint(params.model, params.endpoint);
  const provider = buildProvider(endpoint.provider);

  const startedAt = Date.now();
  let result;
  try {
    result = await provider.call({
      model: params.model,
      input: params.input,
      apiKey: endpoint.apiKey,
      baseUrl: endpoint.baseUrl,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
    });
  } catch (err) {
    if (err instanceof RateLimitError && typeof err.retryAfterMs === "number") {
      await sleep(err.retryAfterMs);
      result = await provider.call({
        model: params.model,
        input: params.input,
        apiKey: endpoint.apiKey,
        baseUrl: endpoint.baseUrl,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
      });
    } else {
      throw err;
    }
  }

  const latencyMs = Date.now() - startedAt;

  if (params.onUsage) {
    const record: UsageRecord = {
      task: params.task,
      model: params.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      latencyMs,
      timestamp: new Date().toISOString(),
    };
    await params.onUsage(record);
  }

  return {
    text: result.text,
    model: params.model,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    latencyMs,
    finishReason: result.finishReason,
  };
}

function resolveEndpoint(model: string, supplied: Endpoint | undefined): ResolvedEndpoint {
  const catalogEntry = lookupCatalog(model);
  const provider = supplied?.provider ?? catalogEntry?.provider;
  if (!provider) {
    throw new PermanentError(
      `Cannot resolve provider for model "${model}". Supply endpoint.provider or use a model present in the catalog.`,
    );
  }
  const baseUrl = supplied?.baseUrl ?? catalogEntry?.baseUrl;
  if (provider === "openai-compatible" && !baseUrl) {
    throw new PermanentError("baseUrl is required for openai-compatible provider");
  }
  if (!supplied?.apiKey) {
    throw new AuthError("apiKey is required; supply it via endpoint.apiKey");
  }
  return { provider, baseUrl, apiKey: supplied.apiKey };
}

function buildProvider(name: ProviderName): Provider {
  if (name === "anthropic") return new AnthropicProvider();
  return new OpenAICompatibleProvider();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
