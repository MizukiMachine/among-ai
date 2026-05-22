import { Hono } from "hono";
import { WerewolfGame } from "../game/engine";
import { defaultLanguage } from "../game/i18n";
import { redactEventForPlayer, redactEventForVillage, type SpectatorMode } from "../game/redaction";
import type { DebugScenario, GameConfig, HumanInputResponse, SummaryMode } from "../game/types";
import { HumanInputSession, registerHumanInputSession, submitHumanInput, unregisterHumanInputSession } from "./humanSessions";

const encoder = new TextEncoder();
const defaultLlmModel = "glm-5-turbo";

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
  if (value === "village" || value === "player") {
    return value;
  }
  return "omniscient";
}

function humanPlayerParam(value: string | null, playerCount: number): string | null {
  if (!value || value === "false" || value === "none") {
    return null;
  }
  if (value === "true") {
    return "p1";
  }

  const normalized = value.startsWith("p") ? value : `p${value}`;
  const match = normalized.match(/^p([1-9]\d*)$/);
  if (!match) {
    return null;
  }

  const index = Number(match[1]);
  return Number.isInteger(index) && index >= 1 && index <= playerCount ? `p${index}` : null;
}

function humanInputResponseFromBody(value: unknown): { requestId: string; response: HumanInputResponse } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const body = value as Record<string, unknown>;
  if (typeof body.requestId !== "string" || !body.requestId) {
    return null;
  }

  return {
    requestId: body.requestId,
    response: {
      speech: typeof body.speech === "string" ? body.speech : undefined,
      targetId: body.targetId === null || typeof body.targetId === "string" ? body.targetId : undefined,
      reason: typeof body.reason === "string" ? body.reason : undefined,
      decision: typeof body.decision === "boolean" ? body.decision : undefined
    }
  };
}

export function parseStreamOptions(url: URL): GameConfig & { speed: number; view: SpectatorMode } {
  const provider = url.searchParams.get("provider") === "demo" ? "demo" : "llm";
  const requestedModel = url.searchParams.get("model")?.trim() ?? "";
  const requestedSummaryMode = url.searchParams.get("summary");
  const playerCount = intParam(url.searchParams.get("players"), 7, 6, 20);
  const humanPlayerId =
    humanPlayerParam(url.searchParams.get("human"), playerCount) ??
    humanPlayerParam(url.searchParams.get("humanPlayerId"), playerCount);
  const debugScenario = humanPlayerId ? "none" : debugScenarioParam(url.searchParams.get("scenario"));
  return {
    provider,
    model: requestedModel || process.env.ZAI_MODEL || process.env.OPENAI_MODEL || defaultLlmModel,
    playerCount,
    language: url.searchParams.get("language") || defaultLanguage,
    maxRounds: intParam(url.searchParams.get("maxRounds"), 8, 3, 15),
    summaryMode: requestedSummaryMode ? summaryModeParam(requestedSummaryMode) : provider === "llm" ? "llm" : "deterministic",
    debugScenario,
    humanPlayerId,
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

  app.post("/api/games/:id/input", async (c) => {
    const sessionId = c.req.param("id");
    const parsed = humanInputResponseFromBody(await c.req.json().catch(() => null));
    if (!parsed) {
      return c.json({ ok: false, error: "invalid_input" }, 400);
    }

    const submitted = submitHumanInput(sessionId, parsed.requestId, parsed.response);
    if (!submitted.ok) {
      if (submitted.error === "invalid_input") {
        return c.json({ ok: false, error: submitted.error }, 400);
      }
      return c.json({ ok: false, error: submitted.error }, 404);
    }

    return c.json({ ok: true });
  });

  app.get("/api/games/stream", (c) => {
    const url = new URL(c.req.url);
    const { speed, view, ...config } = parseStreamOptions(url);
    let cancelled = false;
    let humanSession: HumanInputSession | null = null;
    const abortController = new AbortController();

    const stream = new ReadableStream({
      async start(controller) {
        humanSession = config.humanPlayerId
          ? new HumanInputSession((request) => {
              controller.enqueue(sseFrame("human_input", request));
            })
          : null;
        if (humanSession) {
          registerHumanInputSession(humanSession);
        }

        const streamView = view === "player" && !config.humanPlayerId ? "village" : view;
        const game = new WerewolfGame(config, {
          ...(humanSession ? { humanInput: humanSession } : {}),
          abortSignal: abortController.signal
        });
        controller.enqueue(
          sseFrame("system", {
            message: "stream_opened",
            view: streamView,
            gameId: humanSession?.id ?? null,
            humanPlayerId: config.humanPlayerId ?? null
          })
        );

        try {
          for await (const event of game.run()) {
            if (cancelled) {
              break;
            }
            const payload =
              streamView === "player" && config.humanPlayerId
                ? redactEventForPlayer(event, config.humanPlayerId)
                : streamView === "village"
                  ? redactEventForVillage(event)
                  : event;
            controller.enqueue(sseFrame("game", payload));
            await wait(speed);
          }
          if (!cancelled && !abortController.signal.aborted) {
            controller.enqueue(sseFrame("done", { message: "game_complete" }));
          }
        } catch (error) {
          if (!cancelled && !abortController.signal.aborted) {
            controller.enqueue(
              sseFrame("error", {
                message: error instanceof Error ? error.message : String(error)
              })
            );
          }
        } finally {
          if (humanSession) {
            unregisterHumanInputSession(humanSession.id);
            humanSession = null;
          }
          try {
            controller.close();
          } catch {
            // The browser may have already closed the EventSource connection.
          }
        }
      },
      cancel() {
        cancelled = true;
        abortController.abort();
        if (humanSession) {
          unregisterHumanInputSession(humanSession.id);
          humanSession = null;
        }
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
