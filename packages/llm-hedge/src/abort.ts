// Cancellation and timing primitives shared by every llm-hedge mechanism.

/** Resolve after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A cancellation error carrying a human-readable message. */
export function abortError(message = "LLM request cancelled."): Error {
  return new Error(message);
}

/** Throw an {@link abortError} immediately if `signal` is already aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

/**
 * Combine two abort signals into one that fires when either input aborts.
 *
 * Returns the live signal (or `undefined` when neither input is present) plus a
 * `cleanup` that detaches the internal listeners. Callers must invoke `cleanup`
 * once the combined signal is no longer needed to avoid leaking listeners on
 * long-lived parent signals.
 */
export function mergeAbortSignals(
  a?: AbortSignal,
  b?: AbortSignal
): { signal?: AbortSignal; cleanup: () => void } {
  if (!a) {
    return { signal: b, cleanup: () => undefined };
  }
  if (!b || a === b) {
    return { signal: a, cleanup: () => undefined };
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (a.aborted || b.aborted) {
    abort();
    return { signal: controller.signal, cleanup: () => undefined };
  }

  a.addEventListener("abort", abort, { once: true });
  b.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      a.removeEventListener("abort", abort);
      b.removeEventListener("abort", abort);
    }
  };
}
