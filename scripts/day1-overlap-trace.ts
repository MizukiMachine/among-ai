/**
 * Day-1 overlap trace: runs a real 15-player game for ONE day and prints an
 * absolute-time timeline so we can SEE whether the director plan ("台本作り")
 * actually runs DURING the warm-up greetings, and where the post-greeting gap is.
 *
 * Usage: ZAI_API_KEY=... npx tsx scripts/day1-overlap-trace.ts
 * Env: D1_PLAYERS (default 15), D1_MODE (default intermediate), ZAI_MODEL
 */
import { setLlmQueueTraceSink, type LlmTraceEvent } from "../src/game/agents";
import { WerewolfGame } from "../src/game/engine";
import type { DirectorMode, GameConfig, GameEvent } from "../src/game/types";

function intEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const players = intEnv("D1_PLAYERS", 15);
const mode = (process.env.D1_MODE === "describe" ? "describe" : "intermediate") as DirectorMode;
const model = process.env.ZAI_MODEL || process.env.OPENAI_MODEL || "glm-5-turbo";

const t0 = Date.now();
const rel = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

// Trace director (and warmup intro / reasoning) LLM calls with absolute timing.
let directorStarted: number | null = null;
let directorFinished = 0;
let introStarted: number | null = null;
let firstReasoningStarted: number | null = null;
setLlmQueueTraceSink((event: LlmTraceEvent) => {
  if (event.kind === "started") {
    if (event.label === "director") {
      if (directorStarted === null) {
        directorStarted = Date.now();
        console.log(`[${rel()}] director call STARTED (first of best-of-3)`);
      }
    } else if (event.label === "speech.intro" && introStarted === null) {
      introStarted = Date.now();
      console.log(`[${rel()}] first warm-up intro call STARTED`);
    } else if (event.label === "speech.reasoning" && firstReasoningStarted === null) {
      firstReasoningStarted = Date.now();
      console.log(`[${rel()}] first REAL speech (reasoning) call STARTED`);
    }
  } else if (event.kind === "finished" && event.label === "director") {
    directorFinished = Date.now();
  }
});

const config: GameConfig = {
  playerCount: players,
  provider: "llm",
  model,
  language: "Japanese",
  maxRounds: 1,
  summaryMode: "deterministic",
  debugScenario: "none",
  prefetchConcurrency: 5,
  directorMode: mode
};

console.log(`Day-1 overlap trace: players=${players} mode=${mode} model=${model}\n`);

let dayStart: number | null = null;
let lastWarmup: number | null = null;
let firstReal: number | null = null;
let warmupCount = 0;

const game = new WerewolfGame(config);
for await (const event of game.run() as AsyncGenerator<GameEvent>) {
  if (event.type === "phase_changed" && typeof event.message === "string" && event.message.includes("昼が始まりました")) {
    dayStart = Date.now();
    console.log(`[${rel()}] === DAY 1 START ===`);
  } else if (event.type === "player_speech") {
    const isWarmup = event.data?.warmup === true;
    if (isWarmup) {
      warmupCount += 1;
      lastWarmup = Date.now();
    } else if (firstReal === null) {
      firstReal = Date.now();
      console.log(`[${rel()}] === FIRST REAL DISCUSSION SPEECH shown (${event.playerName ?? ""}) ===`);
      break; // we only care about the day-1 lead-in
    }
  }
}
setLlmQueueTraceSink(null);

console.log(`\n===== TIMELINE SUMMARY (players=${players}) =====`);
const d = (a: number | null, b: number | null) => (a !== null && b !== null ? `${((b - a) / 1000).toFixed(1)}s` : "n/a");
console.log(`warm-up intros shown: ${warmupCount}`);
console.log(`day-start → director call start : ${d(dayStart, directorStarted)}`);
console.log(`director call active (model)    : ${directorStarted ? `${((directorFinished - directorStarted) / 1000).toFixed(1)}s` : "n/a"}`);
console.log(`day-start → director FINISHED   : ${d(dayStart, directorFinished || null)}`);
console.log(`day-start → last warm-up intro  : ${d(dayStart, lastWarmup)}`);
console.log(`last warm-up → first real speech : ${d(lastWarmup, firstReal)}   <-- the exposed gap`);
console.log(`director FINISHED → first real speech : ${d(directorFinished || null, firstReal)}`);
console.log(`\nOverlap check: director runs from +${d(dayStart, directorStarted)} for ${directorStarted ? `${((directorFinished - directorStarted) / 1000).toFixed(1)}s` : "?"}; warm-up ends at +${d(dayStart, lastWarmup)}.`);
