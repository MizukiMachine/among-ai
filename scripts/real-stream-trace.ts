/**
 * Real-server SSE trace: hits the running dev server's /api/games/stream exactly
 * like the browser does, and prints an absolute-time timeline of the "game" events
 * so we can see the REAL day-1 lead-in (warm-up greetings → first real speech),
 * including the human-player path.
 *
 * Usage: npx tsx scripts/real-stream-trace.ts
 * Env: RS_PLAYERS(15) RS_DIRECTOR(intermediate) RS_HUMAN(p1, empty=spectator) RS_PORT(8787)
 */
const players = process.env.RS_PLAYERS || "15";
const director = process.env.RS_DIRECTOR || "intermediate";
const human = process.env.RS_HUMAN ?? "p1";
const port = process.env.RS_PORT || "8787";

const params = new URLSearchParams({
  players,
  provider: "llm",
  summary: "deterministic",
  scenario: "none",
  view: human ? "player" : "village",
  speed: "0",
  language: "Japanese",
  director
});
if (human) params.set("human", human);

const url = `http://localhost:${port}/api/games/stream?${params.toString()}`;
const t0 = Date.now();
const rel = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
console.log(`Real-stream trace: players=${players} director=${director} human=${human || "(spectator)"}\nGET ${url}\n`);

const res = await fetch(url, { headers: { Accept: "text/event-stream" } });
if (!res.ok || !res.body) {
  console.error(`HTTP ${res.status}`);
  process.exit(1);
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = "";
let dayStart: number | null = null;
let lastWarmup: number | null = null;
let warmupCount = 0;
let firstReal: number | null = null;
let lastEventAt = t0;

function handleEvent(eventName: string, dataRaw: string) {
  let data: any = null;
  try {
    data = JSON.parse(dataRaw);
  } catch {
    return;
  }
  if (eventName === "progress") return; // ignore HUD spam
  const sinceLast = ((Date.now() - lastEventAt) / 1000).toFixed(1);
  lastEventAt = Date.now();

  if (eventName === "game") {
    const ev = data as { type: string; message?: string; playerName?: string; data?: any };
    if (ev.type === "phase_changed" && typeof ev.message === "string" && ev.message.includes("昼が始まりました")) {
      dayStart = Date.now();
      console.log(`[${rel()}] (+${sinceLast}s) === DAY 1 START ===`);
    } else if (ev.type === "player_speech") {
      const isWarmup = ev.data?.warmup === true;
      if (isWarmup) {
        warmupCount += 1;
        lastWarmup = Date.now();
        console.log(`[${rel()}] (+${sinceLast}s) warm-up greeting #${warmupCount} (${ev.playerName ?? ""})`);
      } else {
        if (firstReal === null) {
          firstReal = Date.now();
          console.log(`[${rel()}] (+${sinceLast}s) === FIRST REAL SPEECH (${ev.playerName ?? ""}) ===`);
        } else {
          console.log(`[${rel()}] (+${sinceLast}s) real speech (${ev.playerName ?? ""})`);
        }
      }
    } else {
      console.log(`[${rel()}] (+${sinceLast}s) ${ev.type} ${ev.message ? `– ${String(ev.message).slice(0, 40)}` : ""}`);
    }
  } else if (eventName === "human_input") {
    console.log(`[${rel()}] (+${sinceLast}s) >>> HUMAN_INPUT requested (${data?.kind ?? ""}) — stopping trace`);
    printSummary();
    process.exit(0);
  } else if (eventName === "done" || eventName === "error") {
    console.log(`[${rel()}] (+${sinceLast}s) <<< ${eventName}`);
    printSummary();
    process.exit(0);
  }
}

function printSummary() {
  const d = (a: number | null, b: number | null) => (a !== null && b !== null ? `${((b - a) / 1000).toFixed(1)}s` : "n/a");
  console.log(`\n===== SUMMARY =====`);
  console.log(`warm-up greetings: ${warmupCount}`);
  console.log(`day-start → last warm-up : ${d(dayStart, lastWarmup)}`);
  console.log(`last warm-up → first real speech : ${d(lastWarmup, firstReal)}   <-- exposed gap`);
  console.log(`day-start → first real speech : ${d(dayStart, firstReal)}`);
}

// Stop the trace after a while if it's a spectator run that keeps going.
setTimeout(() => {
  console.log(`\n[${rel()}] (timeout) stopping trace`);
  printSummary();
  process.exit(0);
}, 90_000);

for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const frames = buf.split("\n\n");
  buf = frames.pop() ?? "";
  for (const frame of frames) {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length > 0) handleEvent(eventName, dataLines.join("\n"));
  }
}
printSummary();
