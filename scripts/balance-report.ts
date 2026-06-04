import { runBalanceReport } from "../src/game/balance";

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const runs = positiveInt(process.env.RUNS, 20);
const maxRounds = positiveInt(process.env.MAX_ROUNDS, 3);
const seed = process.env.SEED ?? "among-ai-balance";
const report = await runBalanceReport({ runs, maxRounds, seed });

console.log(`Balance report: runs=${runs}, maxRounds=${maxRounds}, seed=${seed}`);
console.table(
  report.map((bucket) => ({
    players: bucket.playerCount,
    runs: bucket.runs,
    village: bucket.villageWins,
    werewolf: bucket.werewolfWins,
    lover: bucket.loverWins,
    neutral: bucket.neutralWins,
    early: bucket.earlyEndings,
    avgRound: bucket.averageEndRound,
    minRound: bucket.minEndRound,
    maxRound: bucket.maxEndRound
  }))
);
