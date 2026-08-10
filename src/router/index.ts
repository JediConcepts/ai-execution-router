export { complete } from "./router.ts";

export type {
  AttemptRecord,
  WireFeature,
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
  MalformedResponseError,
  ModelUnavailableError,
  PermanentError,
  QuotaExhaustedError,
  RateLimitError,
  TimeoutError,
  TransientError,
  UnsupportedCapabilityError,
} from "./errors.ts";

export type { ErrorDetails } from "./errors.ts";
