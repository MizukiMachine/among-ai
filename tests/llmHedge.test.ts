import assert from "node:assert/strict";
import test from "node:test";
import { mapConcurrentUnordered } from "llm-hedge";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

test("mapConcurrentUnordered yields ready results without waiting for lower indexes", async () => {
  const yielded: number[] = [];
  for await (const result of mapConcurrentUnordered(
    [30, 1, 1],
    async (delay, { index }) => {
      await sleep(delay);
      return index;
    },
    { concurrency: 2 }
  )) {
    yielded.push(result.value);
  }

  assert.deepEqual(yielded, [1, 2, 0]);
});

test("mapConcurrentUnordered treats invalid concurrency as one active task", async () => {
  const started: number[] = [];
  const yielded: number[] = [];

  for await (const result of mapConcurrentUnordered(
    [1, 1, 1],
    async (_delay, { index }) => {
      started.push(index);
      if (index === 0) {
        assert.deepEqual(started, [0]);
      }
      await sleep(1);
      return index;
    },
    { concurrency: Number.NaN }
  )) {
    yielded.push(result.value);
  }

  assert.deepEqual(yielded, [0, 1, 2]);
});

test("mapConcurrentUnordered aborts active work when the external signal aborts", async () => {
  const controller = new AbortController();
  const aborted: number[] = [];
  const iterator = mapConcurrentUnordered(
    [0, 1],
    async (_item, { index, signal }) => {
      try {
        await sleepWithAbort(10_000, signal);
        return index;
      } catch (error) {
        aborted.push(index);
        throw error;
      }
    },
    { concurrency: 2, signal: controller.signal }
  );

  const pending = iterator.next();
  await sleep(1);
  controller.abort();
  await assert.rejects(pending, /aborted|cancelled/i);
  await sleep(0);
  assert.deepEqual(aborted.sort(), [0, 1]);
});

test("mapConcurrentUnordered aborts active work when the iterator is returned", async () => {
  const aborted: number[] = [];
  const iterator = mapConcurrentUnordered(
    [1, 10_000],
    async (delay, { index, signal }) => {
      try {
        await sleepWithAbort(delay, signal);
        return index;
      } catch (error) {
        aborted.push(index);
        throw error;
      }
    },
    { concurrency: 2 }
  );

  const first = await iterator.next();
  assert.equal(first.value?.value, 0);
  await iterator.return(undefined);
  await sleep(0);
  assert.deepEqual(aborted, [1]);
});
