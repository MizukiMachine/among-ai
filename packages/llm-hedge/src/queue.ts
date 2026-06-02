// A concurrency- and rate-limited admission queue for LLM requests. Each
// acquired slot must be released by calling the returned function. Waiting
// entries are cancellable via their abort signal, which drops them from the
// queue without ever consuming a slot.

import { abortError, throwIfAborted } from "./abort";

/** Per-request metadata used for tracing and slot bookkeeping. */
export interface LlmRequestInfo {
  model: string;
  maxTokens: number;
  label?: string;
}

/**
 * Structured per-request trace event. Delivered to the queue's `onTrace`
 * callback so measurement tooling can aggregate timings without parsing stdout.
 */
export interface LlmTraceEvent {
  kind: string;
  requestId: number;
  model: string;
  maxTokens: number;
  label?: string;
  active: number;
  queued: number;
  concurrency: number;
  waitMs?: number;
  activeMs?: number;
}

export interface LlmQueueOptions {
  /** Max concurrent in-flight requests. A function is re-read on every drain. */
  concurrency: number | (() => number);
  /** Minimum spacing between request starts, in ms (default 0). */
  minIntervalMs?: number | (() => number);
  /** Receives every queue lifecycle event (queued/started/finished/aborted). */
  onTrace?: (event: LlmTraceEvent) => void;
}

export interface LlmQueue {
  /**
   * Wait for a slot. Resolves with a release function once admitted; rejects
   * with an abort error if `signal` fires while waiting. The release function
   * is idempotent.
   */
  acquire(signal: AbortSignal | undefined, request: LlmRequestInfo): Promise<() => void>;
}

type LlmQueueEntry = {
  id: number;
  queuedAt: number;
  startedAt?: number;
  model: string;
  maxTokens: number;
  label?: string;
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abort: () => void;
};

function asResolver(value: number | (() => number)): () => number {
  return typeof value === "function" ? value : () => value;
}

export function createLlmQueue(options: LlmQueueOptions): LlmQueue {
  const concurrencyOf = asResolver(options.concurrency);
  const minIntervalOf = asResolver(options.minIntervalMs ?? 0);
  const onTrace = options.onTrace;

  const queue: LlmQueueEntry[] = [];
  let activeRequests = 0;
  let nextStartAt = 0;
  let startTimer: ReturnType<typeof setTimeout> | null = null;
  let nextRequestId = 0;

  function emitTrace(kind: string, entry: LlmQueueEntry, extra: { waitMs?: number; activeMs?: number } = {}): void {
    if (!onTrace) {
      return;
    }
    onTrace({
      kind,
      requestId: entry.id,
      model: entry.model,
      maxTokens: entry.maxTokens,
      label: entry.label,
      active: activeRequests,
      queued: queue.length,
      concurrency: concurrencyOf(),
      waitMs: typeof extra.waitMs === "number" ? extra.waitMs : undefined,
      activeMs: typeof extra.activeMs === "number" ? extra.activeMs : undefined
    });
  }

  function schedule(): void {
    if (startTimer) {
      return;
    }

    const now = Date.now();
    const delay = Math.max(0, nextStartAt - now);
    startTimer = setTimeout(() => {
      startTimer = null;
      drain();
    }, delay);
  }

  function drain(): void {
    while (activeRequests < concurrencyOf() && queue.length > 0) {
      const now = Date.now();
      if (now < nextStartAt) {
        schedule();
        return;
      }

      const entry = queue.shift();
      if (!entry) {
        return;
      }
      entry.signal?.removeEventListener("abort", entry.abort);
      if (entry.signal?.aborted) {
        entry.reject(abortError());
        continue;
      }

      activeRequests += 1;
      nextStartAt = now + minIntervalOf();
      entry.startedAt = now;
      emitTrace("started", entry, { waitMs: now - entry.queuedAt });
      entry.resolve();
    }
  }

  async function acquire(
    signal: AbortSignal | undefined,
    request: LlmRequestInfo
  ): Promise<() => void> {
    throwIfAborted(signal);
    let acquiredEntry: LlmQueueEntry | null = null;
    await new Promise<void>((resolve, reject) => {
      const entry: LlmQueueEntry = {
        id: ++nextRequestId,
        queuedAt: Date.now(),
        model: request.model,
        maxTokens: request.maxTokens,
        label: request.label,
        resolve: () => {
          acquiredEntry = entry;
          resolve();
        },
        reject,
        signal,
        abort: () => {
          const index = queue.indexOf(entry);
          if (index !== -1) {
            queue.splice(index, 1);
          }
          emitTrace("aborted_waiting", entry, { waitMs: Date.now() - entry.queuedAt });
          reject(abortError());
        }
      };
      signal?.addEventListener("abort", entry.abort, { once: true });
      queue.push(entry);
      emitTrace("queued", entry);
      drain();
    });
    if (!acquiredEntry) {
      throw abortError();
    }
    const entry = acquiredEntry as LlmQueueEntry;

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      activeRequests = Math.max(0, activeRequests - 1);
      emitTrace("finished", entry, {
        activeMs: entry.startedAt ? Date.now() - entry.startedAt : undefined
      });
      drain();
    };
  }

  return { acquire };
}
