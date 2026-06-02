# llm-hedge

An execution layer that hides LLM **tail latency** with hedging, speculation,
prefetch, and cancellation. It wraps an Anthropic-compatible client with a small
set of domain-agnostic primitives so the slowest request stops setting the pace.

The library owns the **mechanism** (race, hedge, queue, retry, timeout, cancel,
JSON extraction). *Policy* — what to make redundant, which candidates to race,
whether a result is acceptable — stays with the caller and is injected through
callbacks and generics. `llm-hedge` knows nothing about your domain types.

> Reference implementation: [among-ai](https://github.com/) drives an entire
> browser werewolf simulation through these primitives — speculative speaker
> races, hedged decision calls, a shared admission queue, and trace-based
> latency probing. See `src/game/engine.ts` and `src/game/agents.ts` there.

## Install

```bash
pnpm add llm-hedge @anthropic-ai/sdk
```

`@anthropic-ai/sdk` is a peer dependency. The client targets any
Anthropic-compatible `baseURL` (Anthropic, z.ai, OpenAI-compatible gateways) —
provider selection is the caller's concern.

## Primitives

### Races — hide tail latency

```ts
import { hedge, raceCandidates } from "llm-hedge";

// Redundancy: run the SAME call N times, take the first success, abort the rest.
const answer = await hedge((ctx) => callModel({ signal: ctx.signal }), { slots: 3 });

// Speculation: run DIFFERENT candidates, adopt the first that finishes.
const { item, value } = await raceCandidates(
  speakers,
  (speaker, ctx) => generateSpeech(speaker, { signal: ctx.signal }),
  {
    onLosersAborted: ({ winner, losers, raceSize }) => {
      // emit a diagnostic — this hook is where your policy lives
    }
  }
);
```

Each attempt gets its own `AbortSignal`; when one wins, the others are aborted.
The race rejects only if **every** attempt rejects (with the last error). An
optional `signal` aborts all in-flight attempts.

### Admission queue — bound concurrency and rate

```ts
import { createLlmQueue } from "llm-hedge";

const queue = createLlmQueue({
  concurrency: 5,        // or () => number for dynamic limits
  minIntervalMs: 0,
  onTrace: (event) => {  // queued / started / finished / aborted_waiting
    metrics.record(event);
  }
});

const release = await queue.acquire(signal, { model, maxTokens: 384, label: "speech" });
try {
  /* ... call the model ... */
} finally {
  release(); // idempotent
}
```

Waiting entries are cancellable via their signal and are dropped from the queue
without ever consuming a slot.

### Client + retry + timeout gate

```ts
import { createLlmClient, completeWithRetry } from "llm-hedge";

const client = createLlmClient({ apiKey, baseUrl, timeoutMs: 120_000 });

const text = await completeWithRetry({
  client,
  params: { model, system, messages, max_tokens: 384, temperature: 0.8 },
  queue,
  timeoutMs: 120_000,
  signal,
  label: "decision"
});
```

Each attempt acquires a queue slot, races the request against a timeout +
external-cancellation gate, and releases the slot in `finally`. Retries are
bounded (`DEFAULT_LLM_ATTEMPTS`) and gated by `isRetryableError` (429 / 5xx /
ECONNRESET; timeouts and cancellations are terminal). Override `attempts`,
`isRetryable`, or `retryDelayMs` to change the policy.

### Cancellation & JSON helpers

```ts
import { mergeAbortSignals, throwIfAborted, abortError, sleep } from "llm-hedge";
import { parseJsonObject, tryParseJson } from "llm-hedge";

const { signal, cleanup } = mergeAbortSignals(parentSignal, requestSignal);
// ... use signal ...
cleanup();

// Tolerant structured-output parsing: strict parse, then first {...} span.
const obj = parseJsonObject(modelText); // Record<string, unknown> | null
```

## Design

- **Dependency direction**: your app → `llm-hedge`. The runtime never imports the
  app.
- **Mechanism vs policy**: primitives are generic (generics + callbacks);
  slot allocation, candidate selection, result validation, and diagnostics are
  injected by the caller.
- **Tracing**: the queue emits structured `LlmTraceEvent`s to `onTrace`; fan that
  out to a metrics sink and/or stdout in your own glue code.

## API

| Export | Purpose |
| --- | --- |
| `hedge(run, { slots, signal? })` | Redundant race over N copies of one call |
| `raceCandidates(items, run, opts?)` | Speculative race over different candidates |
| `mapConcurrentUnordered(items, run, opts)` | Bounded pool that yields every result in completion order |
| `createLlmQueue(opts)` → `LlmQueue` | Concurrency/rate admission queue |
| `createLlmClient({ apiKey, baseUrl, timeoutMs })` | Anthropic-compatible client |
| `completeWithRetry(opts)` | One completion: queue + timeout gate + retries |
| `isRetryableError`, `defaultRetryDelayMs` | Retry policy defaults |
| `mergeAbortSignals`, `throwIfAborted`, `abortError`, `sleep` | Cancellation utils |
| `parseJsonObject`, `tryParseJson` | Tolerant JSON-object extraction |

## License

MIT
