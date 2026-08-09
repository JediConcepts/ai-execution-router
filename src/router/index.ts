export { complete } from "./router.ts";

export type {
  AttemptRecord,
  Capability,
  CompleteParams,
  CompleteResult,
  ContentBlock,
  Endpoint,
  Input,
  MediaSource,
  Message,
  ProviderName,
  ReasoningOptions,
  ResponseFormat,
  TokenSource,
  TokenUsage,
  UsageRecord,
  WireShape,
} from "./types.ts";

export {
  AuthError,
  CancelledError,
  ContextLengthError,
  LLMError,
  ModelUnavailableError,
  PermanentError,
  QuotaExhaustedError,
  RateLimitError,
  TimeoutError,
  TransientError,
  UnsupportedCapabilityError,
} from "./errors.ts";

export type { ErrorDetails } from "./errors.ts";
