/**
 * LLM latency probe: runs one full game per director mode (off / describe /
 * intermediate) against the real LLM provider and reports a per-stage timing
 * breakdown so we can see where the wall-clock goes after adopting the director.
 *
 * Usage:
 *   ZAI_API_KEY=... npx tsx scripts/llm-latency-probe.ts
 * Env knobs:
 *   PROBE_PLAYERS   (default 6)   players per game
 *   PROBE_ROUNDS    (default 3)   maxRounds cap
 *   PROBE_MODES     (default "off,describe,intermediate")
 *   PROBE_SEED      (default "probe") seeds Math.random for role/order parity
 *   ZAI_MODEL       model id (falls back to glm-5-turbo)
 */
import { setLlmQueueTraceSink, type LlmTraceEvent } from "../src/game/agents";
import { WerewolfGame } from "../src/game/engine";
import type { DirectorMode, GameConfig, GameEvent } from "../src/game/types";

function intEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

// Deterministic Math.random so role assignment / speaker order are comparable
// across modes. LLM responses are still nondeterministic, but the structure is
// held fixed.
function seedHash(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}
function createSeededRandom(seed: string): () => number {
  let state = seedHash(seed) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
}

interface LabelStat {
  count: number;
  sumActiveMs: number;
  maxActiveMs: number;
  sumWaitMs: number;
}

interface ModeReport {
  mode: DirectorMode;
  wallMs: number;
  endRound: number;
  winner: string;
  totalCalls: number;
  abortedWaiting: number;
  byLabel: Record<string, LabelStat>;
  dayStartGapsMs: number[];
}

function emptyStat(): LabelStat {
  return { count: 0, sumActiveMs: 0, maxActiveMs: 0, sumWaitMs: 0 };
}

async function runMode(mode: DirectorMode, players: number, maxRounds: number, seed: string): Promise<ModeReport> {
  const byLabel: Record<string, LabelStat> = {};
  const startedWaitByRequest = new Map<number, { label: string; waitMs: number }>();
  let abortedWaiting = 0;

  const sink = (event: LlmTraceEvent) => {
    const label = event.label ?? "(unlabeled)";
    if (event.kind === "started") {
      startedWaitByRequest.set(event.requestId, { label, waitMs: event.waitMs ?? 0 });
    } else if (event.kind === "finished") {
      const stat = (byLabel[label] ??= emptyStat());
      stat.count += 1;
      const activeMs = event.activeMs ?? 0;
      stat.sumActiveMs += activeMs;
      stat.maxActiveMs = Math.max(stat.maxActiveMs, activeMs);
      const started = startedWaitByRequest.get(event.requestId);
      stat.sumWaitMs += started?.waitMs ?? 0;
      startedWaitByRequest.delete(event.requestId);
    } else if (event.kind === "aborted_waiting") {
      abortedWaiting += 1;
    }
  };

  const config: GameConfig = {
    playerCount: players,
    provider: "llm",
    model: process.env.ZAI_MODEL || process.env.OPENAI_MODEL || "glm-5-turbo",
    language: "Japanese",
    maxRounds,
    summaryMode: "llm",
    debugScenario: "none",
    prefetchConcurrency: 5,
    directorMode: mode
  };

  const originalRandom = Math.random;
  Math.random = createSeededRandom(`${seed}:${players}`);
  setLlmQueueTraceSink(sink);

  const dayStartGapsMs: number[] = [];
  let pendingDayStart: number | null = null;
  let endRound = 0;
  let winner = "(none)";
  const start = Date.now();
  try {
    const game = new WerewolfGame(config);
    for await (const event of game.run() as AsyncGenerator<GameEvent>) {
      if (event.type === "phase_changed" && typeof event.message === "string" && event.message.includes("昼が始まりました")) {
        pendingDayStart = Date.now();
      } else if (event.type === "player_speech" && pendingDayStart !== null) {
        const gap = Date.now() - pendingDayStart;
        dayStartGapsMs.push(gap);
        console.log(`  [${mode}] day ${dayStartGapsMs.length} start→first-speech gap = ${gap}ms`);
        pendingDayStart = null;
      } else if (event.type === "game_ended") {
        winner = String(event.data?.winnerCamp ?? event.data?.winner ?? "(none)");
      }
      if (typeof event.data?.round === "number") {
        endRound = Math.max(endRound, event.data.round);
      }
    }
  } finally {
    setLlmQueueTraceSink(null);
    Math.random = originalRandom;
  }

  const wallMs = Date.now() - start;
  const totalCalls = Object.values(byLabel).reduce((sum, stat) => sum + stat.count, 0);
  return { mode, wallMs, endRound, winner, totalCalls, abortedWaiting, byLabel, dayStartGapsMs };
}

function fmt(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
function avg(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function printReport(report: ModeReport): void {
  console.log(`\n===== directorMode = ${report.mode} =====`);
  console.log(
    `wall=${fmt(report.wallMs)}  endRound=${report.endRound}  winner=${report.winner}  totalLlmCalls=${report.totalCalls}  abortedWhileQueued=${report.abortedWaiting}`
  );
  const labels = Object.keys(report.byLabel).sort();
  console.table(
    labels.map((label) => {
      const stat = report.byLabel[label];
      return {
        label,
        calls: stat.count,
        sumActive: fmt(stat.sumActiveMs),
        avgActive: `${Math.round(stat.sumActiveMs / Math.max(1, stat.count))}ms`,
        maxActive: `${stat.maxActiveMs}ms`,
        sumQueueWait: fmt(stat.sumWaitMs)
      };
    })
  );
  console.log(
    `day-start → first-speech gap: avg=${Math.round(avg(report.dayStartGapsMs))}ms  per-day=[${report.dayStartGapsMs
      .map((ms) => `${Math.round(ms)}ms`)
      .join(", ")}]`
  );
}

const players = intEnv("PROBE_PLAYERS", 6);
const maxRounds = intEnv("PROBE_ROUNDS", 3);
const seed = process.env.PROBE_SEED ?? "probe";
const modes = (process.env.PROBE_MODES ?? "off,describe,intermediate")
  .split(",")
  .map((mode) => mode.trim())
  .filter((mode): mode is DirectorMode => mode === "off" || mode === "describe" || mode === "intermediate");

console.log(`LLM latency probe: players=${players} maxRounds=${maxRounds} seed=${seed} modes=${modes.join(",")}`);

const reports: ModeReport[] = [];
for (const mode of modes) {
  console.log(`\n>>> running ${mode} ...`);
  const report = await runMode(mode, players, maxRounds, seed);
  reports.push(report);
  printReport(report);
}

console.log(`\n===== SUMMARY (director vs off) =====`);
console.table(
  reports.map((report) => ({
    mode: report.mode,
    wall: fmt(report.wallMs),
    llmCalls: report.totalCalls,
    directorCalls: report.byLabel.director?.count ?? 0,
    directorSum: fmt(report.byLabel.director?.sumActiveMs ?? 0),
    directorAvg: `${Math.round((report.byLabel.director?.sumActiveMs ?? 0) / Math.max(1, report.byLabel.director?.count ?? 0))}ms`,
    reasoningCalls: report.byLabel["speech.reasoning"]?.count ?? 0,
    realizationCalls: report.byLabel["speech.realization"]?.count ?? 0,
    dayGapAvg: `${Math.round(avg(report.dayStartGapsMs))}ms`
  }))
);
