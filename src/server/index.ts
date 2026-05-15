import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { WerewolfGame } from "../game/engine";
import type { DebugScenario, GameConfig, GameEvent, SummaryMode } from "../game/types";
import { loadDotEnv } from "./env";

loadDotEnv();

const app = new Hono();
const encoder = new TextEncoder();

function intParam(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function summaryModeParam(value: string | null): SummaryMode {
  return value === "llm" ? "llm" : "deterministic";
}

function debugScenarioParam(value: string | null): DebugScenario {
  return value === "guard_success" || value === "hunter_shot" ? value : "none";
}

function parseConfig(url: URL): GameConfig & { speed: number } {
  const provider = url.searchParams.get("provider") === "llm" ? "llm" : "demo";
  const requestedModel = url.searchParams.get("model")?.trim() ?? "";
  return {
    provider,
    model: requestedModel || process.env.OPENAI_MODEL || "demo",
    playerCount: intParam(url.searchParams.get("players"), 7, 6, 9),
    language: url.searchParams.get("language") || "English",
    maxRounds: intParam(url.searchParams.get("maxRounds"), 8, 3, 15),
    summaryMode: summaryModeParam(url.searchParams.get("summary")),
    debugScenario: debugScenarioParam(url.searchParams.get("scenario")),
    speed: intParam(url.searchParams.get("speed"), 650, 80, 3000)
  };
}

function sseFrame(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

app.get("/api/health", (c) => {
  return c.json({ ok: true });
});

app.get("/api/games/stream", (c) => {
  const url = new URL(c.req.url);
  const { speed, ...config } = parseConfig(url);
  const game = new WerewolfGame(config);
  let cancelled = false;

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(sseFrame("system", { message: "stream_opened" }));

      try {
        for await (const event of game.run()) {
          if (cancelled) {
            break;
          }
          controller.enqueue(sseFrame("game", event satisfies GameEvent));
          await wait(speed);
        }
        controller.enqueue(sseFrame("done", { message: "game_complete" }));
      } catch (error) {
        controller.enqueue(
          sseFrame("error", {
            message: error instanceof Error ? error.message : String(error)
          })
        );
      } finally {
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
});

if (process.env.NODE_ENV === "production") {
  app.use("/*", serveStatic({ root: "./dist/client" }));
  app.get("*", serveStatic({ path: "./dist/client/index.html" }));
}

const port = Number(process.env.PORT ?? 8787);

serve({
  fetch: app.fetch,
  port
});

console.log(`Among AI API listening on http://localhost:${port}`);
