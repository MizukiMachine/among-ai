// Anthropic-compatible client construction plus a retry/timeout-gated single
// completion. The client points at any Anthropic-compatible baseURL (Anthropic,
// z.ai, OpenAI-compatible gateways), so provider portability is the caller's
// concern — this layer only owns the execution mechanism: admission via a
// queue, a timeout + external-cancellation gate, and bounded retries.

import Anthropic, { APIConnectionTimeoutError, APIError } from "@anthropic-ai/sdk";
import type { MessageCreateParamsNonStreaming, TextBlock } from "@anthropic-ai/sdk/resources/messages";
import { abortError, sleep, throwIfAborted } from "./abort";
import type { LlmQueue } from "./queue";

export const DEFAULT_LLM_RETRIES = 3;
export const DEFAULT_LLM_ATTEMPTS = DEFAULT_LLM_RETRIES + 1;
export const DEFAULT_LLM_BACKOFF_MS = 1_000;

/** Construct an Anthropic-compatible client with SDK-level retries disabled. */
export function createLlmClient(options: { apiKey: string; baseUrl: string; timeoutMs: number }): Anthropic {
  return new Anthropic({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    timeout: options.timeoutMs,
    maxRetries: 0
  });
}

/**
 * Default retry classifier: retry only transient transport/server errors
 * (429, 5xx, ECONNRESET, rate limit). Timeouts and cancellations are terminal.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof APIConnectionTimeoutError) {
    return false;
  }
  if (error instanceof APIError) {
    const status = error.status ?? 0;
    return status === 429 || status >= 500 || /(?:rate limit|429)/i.test(error.message);
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (
      error.name === "AbortError" ||
      message.includes("timeout") ||
      message.includes("aborted") ||
      message.includes("cancelled")
    ) {
      return false;
    }
    return (
      message.includes("econnreset") ||
      message.includes("rate limit") ||
      message.includes("429")
    );
  }
  return false;
}

/** Exponential backoff: `DEFAULT_LLM_BACKOFF_MS * 2^(attempt-1)`. */
export function defaultRetryDelayMs(attempt: number): number {
  return DEFAULT_LLM_BACKOFF_MS * 2 ** Math.max(0, attempt - 1);
}

export interface CompleteWithRetryOptions {
  client: Anthropic;
  /** Full create params (model, messages, max_tokens, and any provider quirks). */
  params: MessageCreateParamsNonStreaming;
  /** Admission queue gating concurrency/rate. */
  queue: LlmQueue;
  /** Per-request timeout in ms (caller resolves env/config). */
  timeoutMs: number;
  /** External cancellation signal. */
  signal?: AbortSignal;
  /** Trace label forwarded to the queue. */
  label?: string;
  /** Total attempts including the first (default {@link DEFAULT_LLM_ATTEMPTS}). */
  attempts?: number;
  /** Retry predicate (default {@link isRetryableError}). */
  isRetryable?: (error: unknown) => boolean;
  /** Backoff for the given 1-based attempt (default {@link defaultRetryDelayMs}). */
  retryDelayMs?: (attempt: number) => number;
}

/**
 * Run one logical completion with bounded retries. Each attempt acquires a queue
 * slot, races the request against a timeout + external-cancellation gate, and
 * releases the slot in `finally`. Returns the first text block's text (or "").
 */
export async function completeWithRetry(options: CompleteWithRetryOptions): Promise<string> {
  const {
    client,
    params,
    queue,
    timeoutMs,
    signal,
    label,
    attempts = DEFAULT_LLM_ATTEMPTS,
    isRetryable = isRetryableError,
    retryDelayMs = defaultRetryDelayMs
  } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      throwIfAborted(signal);
      const releaseSlot = await queue.acquire(signal, {
        model: params.model,
        maxTokens: params.max_tokens,
        label
      });
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let abortFromExternalSignal: (() => void) | null = null;
      const abortGate = new Promise<never>((_, reject) => {
        const rejectWithAbort = (error: Error) => {
          controller.abort();
          reject(error);
        };
        abortFromExternalSignal = () => {
          rejectWithAbort(abortError());
        };
        if (signal?.aborted) {
          abortFromExternalSignal();
          return;
        }
        signal?.addEventListener("abort", abortFromExternalSignal, { once: true });
        timeout = setTimeout(() => {
          rejectWithAbort(abortError("LLM request timed out."));
        }, timeoutMs);
      });
      const abortFromExternalSignalForCleanup = abortFromExternalSignal;
      if (!abortFromExternalSignalForCleanup) {
        controller.abort();
        throw abortError();
      }
      try {
        const request = client.messages.create(params, { signal: controller.signal });
        const response = await Promise.race([request, abortGate]);
        const textBlock = response.content.find((block): block is TextBlock => block.type === "text");
        return textBlock?.text ?? "";
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
        signal?.removeEventListener("abort", abortFromExternalSignalForCleanup);
        releaseSlot();
      }
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts) {
        throw error;
      }
      await sleep(retryDelayMs(attempt));
    }
  }
  throw lastError;
}
