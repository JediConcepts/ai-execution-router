export type ProviderName = "anthropic" | "openai-compatible";

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface Input {
  system?: string;
  messages: Message[];
}

export interface Endpoint {
  provider?: ProviderName;
  baseUrl?: string;
  apiKey?: string;
}

export interface CompleteParams {
  task?: string;
  model: string;
  input: Input;
  temperature?: number;
  maxTokens?: number;
  endpoint?: Endpoint;
  onUsage?: (record: UsageRecord) => void | Promise<void>;
}

export interface CompleteResult {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  finishReason?: string;
}

export interface UsageRecord {
  task?: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  timestamp: string;
}

export interface Provider {
  call(params: ProviderCallParams): Promise<ProviderCallResult>;
}

export interface ProviderCallParams {
  model: string;
  input: Input;
  apiKey: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ProviderCallResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  finishReason?: string;
}
