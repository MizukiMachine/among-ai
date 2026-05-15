import assert from "node:assert/strict";
import test from "node:test";
import { runBalanceReport } from "../src/game/balance";

test("seeded balance smoke covers 6-9 player tables without pre-day endings", async () => {
  const report = await runBalanceReport({
    runs: 8,
    maxRounds: 5,
    seed: "test-balance"
  });

  assert.deepEqual(
    report.map((bucket) => bucket.playerCount),
    [6, 7, 8, 9]
  );

  for (const bucket of report) {
    assert.equal(bucket.villageWins + bucket.werewolfWins, bucket.runs);
    assert.equal(bucket.earlyEndings, 0);
    assert.ok(bucket.averageEndRound >= 1);
    assert.ok(bucket.averageEndRound <= 5);
    assert.ok(bucket.minEndRound >= 1);
    assert.ok(bucket.maxEndRound <= 5);
  }
});
