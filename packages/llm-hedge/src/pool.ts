// Completion-order bounded concurrency for cases where every result is needed.
//
// Unlike raceCandidates/hedge, this does not abort slower successful work when
// a faster item completes. It keeps the pool full up to `concurrency` and yields
// each completed item immediately, so one slow earlier item cannot block later
// ready results.

import { abortError, throwIfAborted } from "./abort";

export interface MapConcurrentUnorderedOptions {
  concurrency: number;
  signal?: AbortSignal;
}

export interface MapConcurrentUnorderedResult<T, R> {
  item: T;
  index: number;
  value: R;
}

function normalizeConcurrency(concurrency: number, itemCount: number): number {
  const parsed = Number(concurrency);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 1;
  }
  return Math.max(1, Math.min(Math.floor(parsed), itemCount));
}

function abortGate(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function* mapConcurrentUnordered<T, R>(
  items: readonly T[],
  run: (item: T, ctx: { index: number; signal: AbortSignal }) => Promise<R>,
  options: MapConcurrentUnorderedOptions
): AsyncGenerator<MapConcurrentUnorderedResult<T, R>> {
  if (items.length === 0) {
    return;
  }

  const limit = normalizeConcurrency(options.concurrency, items.length);
  type Settled =
    | { ok: true; key: number; index: number; item: T; value: R }
    | { ok: false; key: number; error: unknown };
  const active = new Map<number, Promise<Settled>>();
  const controllers = new Map<number, AbortController>();
  let nextIndex = 0;
  let nextKey = 0;

  const abortAll = () => {
    for (const controller of controllers.values()) {
      controller.abort();
    }
  };

  options.signal?.addEventListener("abort", abortAll, { once: true });

  const startNext = () => {
    if (nextIndex >= items.length) {
      return;
    }
    throwIfAborted(options.signal);

    const index = nextIndex;
    const item = items[index]!;
    const key = nextKey;
    nextIndex += 1;
    nextKey += 1;
    const controller = new AbortController();
    controllers.set(key, controller);
    const promise = Promise.race([run(item, { index, signal: controller.signal }), abortGate(controller.signal)]).then(
      (value) => ({ ok: true, key, index, item, value }) as Settled,
      (error: unknown) => ({ ok: false, key, error }) as Settled
    );
    active.set(key, promise);
  };

  try {
    for (let count = 0; count < limit; count += 1) {
      startNext();
    }

    while (active.size > 0) {
      const result = await Promise.race(active.values());
      active.delete(result.key);
      controllers.delete(result.key);
      if (!result.ok) {
        abortAll();
        throw result.error;
      }
      startNext();
      yield {
        item: result.item,
        index: result.index,
        value: result.value
      };
    }
  } finally {
    options.signal?.removeEventListener("abort", abortAll);
    abortAll();
  }
}
