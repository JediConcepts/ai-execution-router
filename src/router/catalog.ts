import type { ProviderName } from "./types.ts";

interface CatalogEntry {
  provider: ProviderName;
  baseUrl?: string;
}

const NVIDIA_OAI = "https://integrate.api.nvidia.com/v1";

export const CATALOG: Record<string, CatalogEntry> = {
  "claude-opus-4-7":   { provider: "anthropic" },
  "claude-sonnet-4-6": { provider: "anthropic" },
  "claude-haiku-4-5":  { provider: "anthropic" },

  "meta/llama-3.3-70b-instruct":              { provider: "openai-compatible", baseUrl: NVIDIA_OAI },
  "meta/llama-3.1-405b-instruct":             { provider: "openai-compatible", baseUrl: NVIDIA_OAI },
  "meta/llama-3.1-8b-instruct":               { provider: "openai-compatible", baseUrl: NVIDIA_OAI },
  "meta/llama-3.2-90b-vision-instruct":       { provider: "openai-compatible", baseUrl: NVIDIA_OAI },
  "nvidia/llama-3.1-nemotron-70b-instruct":   { provider: "openai-compatible", baseUrl: NVIDIA_OAI },
  "deepseek-ai/deepseek-r1":                  { provider: "openai-compatible", baseUrl: NVIDIA_OAI },
  "qwen/qwen2.5-coder-32b-instruct":          { provider: "openai-compatible", baseUrl: NVIDIA_OAI },
};

export function lookupCatalog(model: string): CatalogEntry | undefined {
  return CATALOG[model];
}
