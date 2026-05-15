import { WerewolfGame } from "./engine";
import type { Camp, GameConfig, GameEvent } from "./types";

export interface BalanceBucket {
  playerCount: number;
  runs: number;
  villageWins: number;
  werewolfWins: number;
  earlyEndings: number;
  averageEndRound: number;
  minEndRound: number;
  maxEndRound: number;
}

export interface BalanceReportOptions {
  playerCounts?: number[];
  runs?: number;
  maxRounds?: number;
  seed?: string;
}

function seedHash(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createSeededRandom(seed: string): () => number {
  let state = seedHash(seed) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

async function withSeededRandom<T>(seed: string, run: () => Promise<T>): Promise<T> {
  const originalRandom = Math.random;
  Math.random = createSeededRandom(seed);
  try {
    return await run();
  } finally {
    Math.random = originalRandom;
  }
}

async function collectEvents(game: WerewolfGame): Promise<GameEvent[]> {
  const events: GameEvent[] = [];
  for await (const event of game.run()) {
    events.push(event);
  }
  return events;
}

function winnerFrom(event: GameEvent | undefined): Camp | null {
  return event?.data?.winner === "village" || event?.data?.winner === "werewolf" ? event.data.winner : null;
}

export async function runBalanceReport(options: BalanceReportOptions = {}): Promise<BalanceBucket[]> {
  const playerCounts = options.playerCounts ?? [6, 7, 8, 9];
  const runs = Math.max(1, Math.floor(options.runs ?? 20));
  const maxRounds = Math.max(3, Math.floor(options.maxRounds ?? 8));
  const seed = options.seed ?? "among-ai-balance";
  const buckets: BalanceBucket[] = [];

  for (const playerCount of playerCounts) {
    let villageWins = 0;
    let werewolfWins = 0;
    let earlyEndings = 0;
    let totalEndRound = 0;
    let minEndRound = Number.POSITIVE_INFINITY;
    let maxEndRound = 0;

    for (let runIndex = 0; runIndex < runs; runIndex += 1) {
      const events = await withSeededRandom(`${seed}:${playerCount}:${runIndex}`, async () => {
        const config: GameConfig = {
          playerCount,
          provider: "demo",
          model: "demo",
          language: "English",
          maxRounds,
          summaryMode: "deterministic",
          debugScenario: "none"
        };
        return collectEvents(new WerewolfGame(config));
      });

      const ended = events.find((event) => event.type === "game_ended");
      const winner = winnerFrom(ended);
      if (winner === "village") {
        villageWins += 1;
      }
      if (winner === "werewolf") {
        werewolfWins += 1;
      }

      const sawDay = events.some((event) => event.phase === "day_discussion");
      if (!sawDay) {
        earlyEndings += 1;
      }

      const endRound = ended?.round ?? maxRounds;
      totalEndRound += endRound;
      minEndRound = Math.min(minEndRound, endRound);
      maxEndRound = Math.max(maxEndRound, endRound);
    }

    buckets.push({
      playerCount,
      runs,
      villageWins,
      werewolfWins,
      earlyEndings,
      averageEndRound: Number((totalEndRound / runs).toFixed(2)),
      minEndRound,
      maxEndRound
    });
  }

  return buckets;
}
