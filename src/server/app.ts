import { Hono } from "hono";
import { WerewolfGame } from "../game/engine";
import { redactEventForVillage, type SpectatorMode } from "../game/redaction";
import type { DebugScenario, GameConfig, GameEvent, SummaryMode } from "../game/types";

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

function spectatorModeParam(value: string | null): SpectatorMode {
  return value === "village" ? "village" : "omniscient";
}

export function parseStreamOptions(url: URL): GameConfig & { speed: number; view: SpectatorMode } {
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
    speed: intParam(url.searchParams.get("speed"), 650, 0, 3000),
    view: spectatorModeParam(url.searchParams.get("view"))
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

export function createApp(): Hono {
  const app = new Hono();

  app.get("/api/health", (c) => {
    return c.json({ ok: true });
  });

  app.get("/api/games/stream", (c) => {
    const url = new URL(c.req.url);
    const { speed, view, ...config } = parseStreamOptions(url);
    const game = new WerewolfGame(config);
    let cancelled = false;

    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(sseFrame("system", { message: "stream_opened", view }));

        try {
          for await (const event of game.run()) {
            if (cancelled) {
              break;
            }
            const payload = view === "village" ? redactEventForVillage(event) : (event satisfies GameEvent);
            controller.enqueue(sseFrame("game", payload));
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

  return app;
}
