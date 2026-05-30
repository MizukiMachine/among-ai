import { Hono } from "hono";
import { WerewolfGame } from "../game/engine";
import { defaultLanguage } from "../game/i18n";
import {
  redactEventForPlayer,
  redactEventForVillage,
  redactProgressForPlayer,
  redactProgressForVillage,
  type SpectatorMode
} from "../game/redaction";
import { maxSupportedPlayers, minSupportedPlayers } from "../game/rules/presets";
import type { DebugScenario, DirectorMode, GameConfig, HumanInputResponse, SpeechGenerationDiagnostic, SummaryMode } from "../game/types";
import { HumanInputSession, registerHumanInputSession, submitHumanInput, unregisterHumanInputSession } from "./humanSessions";

const encoder = new TextEncoder();
const defaultLlmModel = "glm-5-turbo";
const fixedGenerationConcurrency = 5;
let nextStreamLogId = 0;

interface StreamOptions extends GameConfig {
  speed: number;
  view: SpectatorMode;
}

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

function directorModeParam(value: string | null): DirectorMode {
  return value === "describe" || value === "intermediate" ? value : "off";
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
      choiceId: typeof body.choiceId === "string" ? body.choiceId : undefined,
      targetId: body.targetId === null || typeof body.targetId === "string" ? body.targetId : undefined,
      reason: typeof body.reason === "string" ? body.reason : undefined,
      decision: typeof body.decision === "boolean" ? body.decision : undefined
    }
  };
}

export function parseStreamOptions(url: URL): StreamOptions {
  const provider = url.searchParams.get("provider") === "demo" ? "demo" : "llm";
  const requestedModel = url.searchParams.get("model")?.trim() ?? "";
  const requestedSummaryMode = url.searchParams.get("summary");
  const playerCount = intParam(url.searchParams.get("players"), 7, minSupportedPlayers, maxSupportedPlayers);
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
    prefetchConcurrency: fixedGenerationConcurrency,
    directorMode: directorModeParam(url.searchParams.get("director")),
    speed: intParam(url.searchParams.get("speed"), 650, 0, 3000),
    view: spectatorModeParam(url.searchParams.get("view"))
  };
}

function gameConfigFromStreamOptions(options: StreamOptions): GameConfig {
  return {
    provider: options.provider,
    model: options.model,
    playerCount: options.playerCount,
    language: options.language,
    maxRounds: options.maxRounds,
    summaryMode: options.summaryMode,
    debugScenario: options.debugScenario,
    humanPlayerId: options.humanPlayerId,
    prefetchConcurrency: options.prefetchConcurrency,
    directorMode: options.directorMode
  };
}

function sseFrame(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function createStreamLogId(): string {
  nextStreamLogId += 1;
  return `stream-${nextStreamLogId}`;
}

function isRateLimitErrorMessage(message: string): boolean {
  return /(?:429|rate[_ -]?limit|\[1302\])/iu.test(message);
}

function streamErrorMessageForClient(message: string): string {
  if (isRateLimitErrorMessage(message)) {
    return "生成リクエストが混み合っています。少し待ってから再開してください。";
  }
  return message;
}

function createSpeechDiagnosticsLogger(streamId: string): {
  onDiagnostic: (diagnostic: SpeechGenerationDiagnostic) => void;
  logSummary: (status: "completed" | "cancelled" | "error") => void;
} {
  const startedAt = Date.now();
  const counts = {
    speechReviewRejected: 0,
    speechRetryAccepted: 0,
    speechRetryRejected: 0,
    speechRetryCompleted: 0,
    speechAborted: 0,
    speechFailed: 0,
    speechRaceLosersAbortedEvents: 0,
    speechRaceLoserAbortCount: 0
  };

  return {
    onDiagnostic: (diagnostic) => {
      if (diagnostic.kind === "speech_review_rejected") {
        counts.speechReviewRejected += 1;
      }
      if (diagnostic.kind === "speech_retry_accepted") {
        counts.speechRetryAccepted += 1;
        counts.speechRetryCompleted += 1;
      }
      if (diagnostic.kind === "speech_retry_rejected") {
        counts.speechRetryRejected += 1;
        counts.speechRetryCompleted += 1;
      }
      if (diagnostic.kind === "speech_aborted") {
        counts.speechAborted += 1;
      }
      if (diagnostic.kind === "speech_failed") {
        counts.speechFailed += 1;
      }
      if (diagnostic.kind === "speech_race_losers_aborted") {
        counts.speechRaceLosersAbortedEvents += 1;
        counts.speechRaceLoserAbortCount += diagnostic.abortedPlayerIds?.length ?? 0;
      }

      if (
        diagnostic.kind !== "speech_review_rejected" &&
        diagnostic.kind !== "speech_retry_accepted" &&
        diagnostic.kind !== "speech_retry_rejected" &&
        diagnostic.kind !== "speech_aborted" &&
        diagnostic.kind !== "speech_failed"
      ) {
        return;
      }

      console.info(
        `[speech-diagnostic] ${JSON.stringify({
          streamId,
          kind: diagnostic.kind,
          round: diagnostic.round,
          phase: diagnostic.phase,
          playerId: diagnostic.playerId,
          playerName: diagnostic.playerName,
          speculative: diagnostic.speculative,
          attempts: diagnostic.attempts,
          durationMs: diagnostic.durationMs,
          speechPlanReviewEnabled: diagnostic.speechPlanReviewEnabled,
          speechPlanRequiresForwardMove: diagnostic.speechPlanRequiresForwardMove,
          issues: diagnostic.issues,
          styleIssues: diagnostic.styleIssues,
          speechPlanIssues: diagnostic.speechPlanIssues,
          timelineIssues: diagnostic.timelineIssues,
          error: diagnostic.error
        })}`
      );
    },
    logSummary: (status) => {
      console.info(
        `[speech-diagnostic-summary] ${JSON.stringify({
          streamId,
          status,
          durationMs: Date.now() - startedAt,
          ...counts
        })}`
      );
    }
  };
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
    const options = parseStreamOptions(url);
    const { view } = options;
    const config = gameConfigFromStreamOptions(options);
    let cancelled = false;
    let humanSession: HumanInputSession | null = null;
    const abortController = new AbortController();
    const streamLogId = createStreamLogId();

    const stream = new ReadableStream({
      async start(controller) {
        const speechDiagnostics = createSpeechDiagnosticsLogger(streamLogId);
        let streamStatus: "completed" | "cancelled" | "error" = "completed";
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
          abortSignal: abortController.signal,
          onSpeechDiagnostics: speechDiagnostics.onDiagnostic,
          onProgress: (progress) => {
            if (!cancelled && !abortController.signal.aborted) {
              const payload =
                streamView === "player" && config.humanPlayerId
                  ? redactProgressForPlayer(progress)
                  : streamView === "village"
                    ? redactProgressForVillage(progress)
                    : progress;
              controller.enqueue(sseFrame("progress", payload));
            }
          }
        });
        controller.enqueue(
          sseFrame("system", {
            message: "stream_opened",
            view: streamView,
            gameId: humanSession?.id ?? null,
            humanPlayerId: config.humanPlayerId ?? null,
            prefetchConcurrency: config.prefetchConcurrency ?? null,
            streamLogId
          })
        );

        try {
          for await (const event of game.run()) {
            if (cancelled) {
              streamStatus = "cancelled";
              break;
            }
            const payload =
              streamView === "player" && config.humanPlayerId
                ? redactEventForPlayer(event, config.humanPlayerId)
                : streamView === "village"
                  ? redactEventForVillage(event)
                  : event;
            controller.enqueue(sseFrame("game", payload));
          }
          if (!cancelled && !abortController.signal.aborted) {
            controller.enqueue(sseFrame("done", { message: "game_complete" }));
          }
        } catch (error) {
          streamStatus = "error";
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(
            `[stream-error] ${JSON.stringify({
              streamId: streamLogId,
              message: errorMessage,
              stack: error instanceof Error ? error.stack : undefined
            })}`
          );
          if (!cancelled && !abortController.signal.aborted) {
            controller.enqueue(
              sseFrame("error", {
                message: streamErrorMessageForClient(errorMessage),
                streamLogId
              })
            );
          }
        } finally {
          speechDiagnostics.logSummary(cancelled || abortController.signal.aborted ? "cancelled" : streamStatus);
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
