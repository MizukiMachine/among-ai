// Concurrency races that hide tail latency: fire several attempts at once, take
// the first success, and abort the rest. `raceCandidates` runs *different*
// candidates (speculation); `hedge` runs *the same* thunk N times (redundancy).
//
// What to race and how many copies is the caller's policy — these primitives
// only own the run/cancel mechanism. Each attempt receives its own abort signal
// and is expected to honor it; losers are aborted the moment a winner settles.

export interface RaceLosersInfo<T> {
  /** The candidate whose attempt resolved first. */
  winner: T;
  /** Candidates still in flight when the winner settled (now aborted). */
  losers: T[];
  /** Total number of candidates entered into the race. */
  raceSize: number;
}

export interface RaceCandidatesOptions<T> {
  /** External cancellation: aborts every in-flight attempt when it fires. */
  signal?: AbortSignal;
  /** Invoked once when a winner aborts still-running losers (losers non-empty). */
  onLosersAborted?: (info: RaceLosersInfo<T>) => void;
}

/**
 * Race different candidates and adopt the first success. Each candidate's `run`
 * gets a dedicated abort signal; when one resolves, the rest are aborted. If a
 * candidate rejects, its slot is dropped and the race continues; only if every
 * candidate rejects does the returned promise reject (with the last error).
 */
export async function raceCandidates<T, R>(
  items: T[],
  run: (item: T, ctx: { signal: AbortSignal }) => Promise<R>,
  options: RaceCandidatesOptions<T> = {}
): Promise<{ item: T; value: R }> {
  type RaceResult =
    | { ok: true; key: number; item: T; value: R; controller: AbortController }
    | { ok: false; key: number; item: T; error: unknown; controller: AbortController };
  const active = new Map<number, Promise<RaceResult>>();
  const controllers = new Map<number, { controller: AbortController; item: T }>();
  let lastError: unknown;

  const abortAll = () => {
    for (const { controller } of controllers.values()) {
      controller.abort();
    }
  };
  const { signal } = options;
  if (signal) {
    signal.addEventListener("abort", abortAll, { once: true });
  }

  try {
    for (const [index, item] of items.entries()) {
      const controller = new AbortController();
      controllers.set(index, { controller, item });
      const promise = run(item, { signal: controller.signal }).then(
        (value) => ({ ok: true, key: index, item, value, controller }) as RaceResult,
        (error: unknown) => ({ ok: false, key: index, item, error, controller }) as RaceResult
      );
      active.set(index, promise);
    }

    // If the external signal aborted before/while we wired up the attempts, make
    // sure the freshly-created controllers see it too.
    if (signal?.aborted) {
      abortAll();
    }

    while (active.size > 0) {
      const result = await Promise.race(active.values());
      active.delete(result.key);
      controllers.delete(result.key);
      if (result.ok) {
        const losers = [...controllers.values()].map(({ item }) => item);
        for (const { controller } of controllers.values()) {
          controller.abort();
        }
        if (losers.length > 0) {
          options.onLosersAborted?.({ winner: result.item, losers, raceSize: items.length });
        }
        return { item: result.item, value: result.value };
      }
      result.controller.abort();
      lastError = result.error;
    }

    throw lastError;
  } finally {
    signal?.removeEventListener("abort", abortAll);
  }
}

export interface HedgeOptions {
  /** Number of redundant copies to launch (clamped to >= 1). */
  slots: number;
  /** External cancellation: aborts every in-flight copy when it fires. */
  signal?: AbortSignal;
}

/**
 * Run the same `run` `slots` times concurrently and adopt the first success,
 * aborting the rest. Rejects only if every copy rejects (with the last error).
 */
export async function hedge<R>(
  run: (ctx: { signal: AbortSignal }) => Promise<R>,
  options: HedgeOptions
): Promise<R> {
  const slots = Math.max(1, Math.floor(options.slots));
  const indices = Array.from({ length: slots }, (_unused, index) => index);
  const { value } = await raceCandidates(indices, (_item, ctx) => run(ctx), { signal: options.signal });
  return value;
}
