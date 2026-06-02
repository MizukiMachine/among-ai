// llm-hedge: an execution layer that hides LLM tail latency with hedging,
// speculation, prefetch, and cancellation.
//
// The runtime primitives are organized by category and re-exported here so
// consumers import from a single entry point (`llm-hedge`).

export { sleep, abortError, throwIfAborted, mergeAbortSignals } from "./abort";
export { tryParseJson, parseJsonObject } from "./json";
export { createLlmQueue } from "./queue";
export type { LlmQueue, LlmQueueOptions, LlmRequestInfo, LlmTraceEvent } from "./queue";
export {
  createLlmClient,
  completeWithRetry,
  isRetryableError,
  defaultRetryDelayMs,
  DEFAULT_LLM_RETRIES,
  DEFAULT_LLM_ATTEMPTS,
  DEFAULT_LLM_BACKOFF_MS
} from "./client";
export type { CompleteWithRetryOptions } from "./client";
export { raceCandidates, hedge } from "./race";
export type { RaceCandidatesOptions, RaceLosersInfo, HedgeOptions } from "./race";
