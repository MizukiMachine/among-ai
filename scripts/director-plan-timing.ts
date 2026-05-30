/**
 * Director plan timing probe (focused).
 *
 * Measures ONLY how long the director "台本作り" (round-script) LLM call takes,
 * for a given player count. No full game is played — we just call buildRoundScript
 * directly and wall-time it.
 *
 * Usage:
 *   ZAI_API_KEY=... npx tsx scripts/director-plan-timing.ts
 * Env knobs:
 *   DPT_PLAYERS  (default 15)
 *   DPT_MODE     (default "intermediate")  describe | intermediate
 *   DPT_REPEAT   (default 3)               samples per path (averaged)
 *   ZAI_MODEL    model id (falls back to glm-5-turbo)
 */
import { buildRoundScript, type DirectorPlayerInfo } from "../src/game/director";
import { setLlmQueueTraceSink, type LlmTraceEvent } from "../src/game/agents";
import { createRoles } from "../src/game/rules/presets";
import { roleCamp } from "../src/game/rules/roles";
import { characterNames } from "../src/game/characters";
import type { DirectorMode, Persona } from "../src/game/types";

function intEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const personas: Persona[] = ["cautious", "aggressive", "logical", "opportunistic", "empathetic", "trickster", "stoic", "passionate"];

function buildPlayers(count: number): DirectorPlayerInfo[] {
  const roles = createRoles(count);
  return roles.map((role, index) => ({
    id: `p${index + 1}`,
    name: characterNames[index] ?? `P${index + 1}`,
    role,
    camp: roleCamp(role),
    persona: personas[index % personas.length],
    alive: true,
    isHuman: false
  }));
}

const players = intEnv("DPT_PLAYERS", 15);
const repeat = intEnv("DPT_REPEAT", 3);
const mode = (process.env.DPT_MODE === "describe" ? "describe" : "intermediate") as Exclude<DirectorMode, "off">;
const model = process.env.ZAI_MODEL || process.env.OPENAI_MODEL || "glm-5-turbo";

// Capture per-LLM-call active time (the model-side time) via the trace sink, so we
// can see how much of the wall time is the actual director completion(s).
const callActiveMs: number[] = [];
setLlmQueueTraceSink((event: LlmTraceEvent) => {
  if (event.kind === "finished" && event.label === "director") {
    callActiveMs.push(event.activeMs ?? 0);
  }
});

function fmt(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
function avg(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

async function timePath(label: string, round: number): Promise<void> {
  console.log(`\n>>> ${label} (round=${round}, players=${players}, mode=${mode}, model=${model})`);
  const walls: number[] = [];
  for (let i = 0; i < repeat; i += 1) {
    callActiveMs.length = 0;
    const start = Date.now();
    await buildRoundScript({
      round,
      language: "Japanese",
      model,
      provider: "llm",
      mode,
      players: buildPlayers(players),
      lastNightDeathNames: round > 1 ? [characterNames[2] ?? "P3"] : [],
      publicHistory: round > 1 ? ["P1: とりあえず様子見します。", "P2: 私はP5が怪しいと思う。"] : []
    });
    const wall = Date.now() - start;
    walls.push(wall);
    const calls = [...callActiveMs];
    console.log(
      `  sample ${i + 1}: wall=${fmt(wall)}  directorCalls=${calls.length}  callActive=[${calls.map(fmt).join(", ")}]`
    );
  }
  console.log(`  => ${label}: avg wall=${fmt(avg(walls))}  (min=${fmt(Math.min(...walls))}, max=${fmt(Math.max(...walls))})`);
}

console.log(`Director plan timing: players=${players} mode=${mode} repeat=${repeat} model=${model}`);
// Round 1 = first-day inline path (best-of-3 race). Round 2 = regular single call.
await timePath("FIRST-DAY (round 1, best-of-3 race)", 1);
await timePath("REGULAR (round 2, single call)", 2);
setLlmQueueTraceSink(null);
