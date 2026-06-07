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
import type {
  DebugScenario,
  GameConfig,
  GenerationProgress,
  HumanCampPreference,
  HumanInputRequest,
  HumanInputResponse,
  SpeechGenerationDiagnostic,
  SummaryMode
} from "../game/types";
import { HumanInputSession, registerHumanInputSession, submitHumanInput, touchHumanInput, unregisterHumanInputSession } from "./humanSessions";
import {
  appendClientTrace,
  createPersistentTraceLog,
  isPersistentTraceEnabled,
  writeTraceForKey
} from "./traceLog";

const encoder = new TextEncoder();
const defaultLlmModel = "glm-5-turbo";
const defaultMaxRounds = 4;
const fixedGenerationConcurrency = 5;
const defaultHumanOptionalInputTimeoutMs = 120_000;
const defaultStreamHeartbeatMs = 15_000;
const defaultStreamWatchdogMs = 30_000;
let nextStreamLogId = 0;

interface StreamOptions extends GameConfig {
  speed: number;
  view: SpectatorMode;
}

interface TraceableGameEvent {
  id: number;
  round: number;
  phase: string;
  type: string;
  message: string;
  playerId?: string;
  targetId?: string;
  data?: Record<string, unknown> & {
    visibility?: unknown;
    redacted?: unknown;
  };
  snapshot: {
    round: number;
    phase: string;
    aliveCount: number;
    winner?: unknown;
    winnerCamp?: unknown;
  };
}

function intParam(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function intEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
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

function humanCampPreferenceParam(value: string | null): HumanCampPreference {
  if (value === "village" || value === "werewolf") {
    return value;
  }
  return "random";
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
      choiceId: typeof body.choiceId === "string" ? body.choiceId : undefined,
      targetId: body.targetId === null || typeof body.targetId === "string" ? body.targetId : undefined,
      reason: typeof body.reason === "string" ? body.reason : undefined,
      decision: typeof body.decision === "boolean" ? body.decision : undefined,
      visibleEventId: typeof body.visibleEventId === "number" && Number.isFinite(body.visibleEventId) ? body.visibleEventId : null
    }
  };
}

function humanInputActivityFromBody(value: unknown): { requestId: string; reason: string | null } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const body = value as Record<string, unknown>;
  if (typeof body.requestId !== "string" || !body.requestId) {
    return null;
  }

  return {
    requestId: body.requestId,
    reason: typeof body.reason === "string" && body.reason ? body.reason : null
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
  const humanCampPreference = humanPlayerId
    ? humanCampPreferenceParam(url.searchParams.get("humanCamp") ?? url.searchParams.get("humanCampPreference"))
    : "random";
  const humanRolePreference = null;
  const debugScenario = humanPlayerId ? "none" : debugScenarioParam(url.searchParams.get("scenario"));
  return {
    provider,
    model: requestedModel || process.env.ZAI_MODEL || process.env.OPENAI_MODEL || defaultLlmModel,
    playerCount,
    language: url.searchParams.get("language") || defaultLanguage,
    maxRounds: intParam(url.searchParams.get("maxRounds"), defaultMaxRounds, 3, 15),
    summaryMode: requestedSummaryMode ? summaryModeParam(requestedSummaryMode) : provider === "llm" ? "llm" : "deterministic",
    debugScenario,
    humanPlayerId,
    humanCampPreference,
    humanRolePreference,
    prefetchConcurrency: fixedGenerationConcurrency,
    humanOptionalInputTimeoutMs: humanOptionalInputTimeoutMs(),
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
    humanCampPreference: options.humanCampPreference,
    humanRolePreference: options.humanRolePreference,
    prefetchConcurrency: options.prefetchConcurrency,
    humanOptionalInputTimeoutMs: options.humanOptionalInputTimeoutMs
  };
}

function sseFrame(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function streamHeartbeatMs(): number {
  return intEnv(process.env.AMONG_AI_STREAM_HEARTBEAT_MS, defaultStreamHeartbeatMs, 5_000, 120_000);
}

function streamWatchdogMs(): number {
  return intEnv(process.env.AMONG_AI_STREAM_WATCHDOG_MS, defaultStreamWatchdogMs, 10_000, 300_000);
}

function humanOptionalInputTimeoutMs(): number {
  return intEnv(
    process.env.AMONG_AI_HUMAN_OPTIONAL_INPUT_TIMEOUT_MS ?? process.env.AMONG_AI_HUMAN_ALIGNMENT_TIMEOUT_MS,
    defaultHumanOptionalInputTimeoutMs,
    5_000,
    300_000
  );
}

function createStreamLogId(): string {
  nextStreamLogId += 1;
  return `stream-${nextStreamLogId}`;
}

function traceStreamOptions(options: StreamOptions): Record<string, unknown> {
  return {
    provider: options.provider,
    model: options.model,
    playerCount: options.playerCount,
    language: options.language,
    maxRounds: options.maxRounds,
    summaryMode: options.summaryMode,
    debugScenario: options.debugScenario,
    humanPlayerId: options.humanPlayerId,
    humanCampPreference: options.humanCampPreference,
    humanRolePreference: options.humanRolePreference,
    prefetchConcurrency: options.prefetchConcurrency,
    humanOptionalInputTimeoutMs: options.humanOptionalInputTimeoutMs,
    speed: options.speed,
    view: options.view
  };
}

function traceProgress(progress: GenerationProgress): Record<string, unknown> {
  return {
    round: progress.round,
    phase: progress.phase,
    task: progress.task,
    label: progress.label,
    total: progress.total,
    started: progress.started,
    completed: progress.completed,
    active: progress.active,
    queued: progress.queued,
    concurrency: progress.concurrency,
    pass: progress.pass,
    passes: progress.passes,
    redacted: progress.redacted === true
  };
}

function traceEvent(event: TraceableGameEvent): Record<string, unknown> {
  return {
    id: event.id,
    round: event.round,
    phase: event.phase,
    type: event.type,
    playerId: event.playerId,
    targetId: event.targetId,
    messageLength: event.message.length,
    visibility: event.data?.visibility,
    redacted: event.data?.redacted === true,
    snapshotRound: event.snapshot.round,
    snapshotPhase: event.snapshot.phase,
    aliveCount: event.snapshot.aliveCount,
    winner: event.snapshot.winner,
    winnerCamp: event.snapshot.winnerCamp ?? null
  };
}

function traceHumanInputRequest(request: HumanInputRequest): Record<string, unknown> {
  return {
    id: request.id,
    kind: request.kind,
    speechMode: request.kind === "speech_choice" ? request.speechMode : undefined,
    nonBlocking: request.nonBlocking === true,
    playerId: request.playerId,
    playerName: request.playerName,
    phase: request.phase,
    revealAfterEventId: request.revealAfterEventId ?? null,
    optionCount: request.kind === "speech_choice" ? request.options.length : undefined,
    candidateCount: request.kind === "target" ? request.candidates.length : undefined,
    allowFreeText: request.kind === "speech_choice" ? request.allowFreeText === true : undefined,
    allowSkip: request.kind === "target" ? request.allowSkip === true : undefined
  };
}

function traceHumanInputResponse(requestId: string, response: HumanInputResponse): Record<string, unknown> {
  return {
    requestId,
    hasSpeech: typeof response.speech === "string" && response.speech.trim().length > 0,
    hasChoiceId: typeof response.choiceId === "string" && response.choiceId.trim().length > 0,
    hasTargetId: response.targetId !== undefined,
    hasReason: typeof response.reason === "string" && response.reason.trim().length > 0,
    decision: typeof response.decision === "boolean" ? response.decision : null,
    visibleEventId: response.visibleEventId ?? null
  };
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

  app.post("/api/debug/client-log", async (c) => {
    const result = appendClientTrace(await c.req.json().catch(() => null));
    if (!result.enabled) {
      return c.json({ ok: false, enabled: false });
    }
    if (!result.ok) {
      return c.json({ ok: false, enabled: true, error: result.error }, 400);
    }
    return c.json({ ok: true, enabled: true, filePath: result.filePath });
  });

  app.post("/api/games/:id/input/activity", async (c) => {
    const sessionId = c.req.param("id");
    const parsed = humanInputActivityFromBody(await c.req.json().catch(() => null));
    if (!parsed) {
      return c.json({ ok: false, error: "invalid_input" }, 400);
    }

    const touched = touchHumanInput(sessionId, parsed.requestId);
    writeTraceForKey(sessionId, "server.human_input_activity", {
      requestId: parsed.requestId,
      reason: parsed.reason,
      ok: touched.ok,
      error: touched.ok ? null : touched.error
    });
    if (!touched.ok) {
      return c.json({ ok: false, error: touched.error }, 404);
    }

    return c.json({ ok: true });
  });

  app.post("/api/games/:id/input", async (c) => {
    const sessionId = c.req.param("id");
    const parsed = humanInputResponseFromBody(await c.req.json().catch(() => null));
    if (!parsed) {
      return c.json({ ok: false, error: "invalid_input" }, 400);
    }

    const submitted = submitHumanInput(sessionId, parsed.requestId, parsed.response);
    writeTraceForKey(sessionId, "server.human_input_submit", {
      ...traceHumanInputResponse(parsed.requestId, parsed.response),
      ok: submitted.ok,
      error: submitted.ok ? null : submitted.error
    });
    if (!submitted.ok) {
      console.warn(
        `[human-input-submit-failed] ${JSON.stringify({
          sessionId,
          requestId: parsed.requestId,
          error: submitted.error
        })}`
      );
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
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const abortController = new AbortController();
    const streamLogId = createStreamLogId();
    const traceLog = createPersistentTraceLog(streamLogId);
    traceLog?.write("server.stream_requested", traceStreamOptions(options));

    const stream = new ReadableStream({
      async start(controller) {
        const speechDiagnostics = createSpeechDiagnosticsLogger(streamLogId);
        let streamStatus: "completed" | "cancelled" | "error" = "completed";
        const startedAt = Date.now();
        let lastDataEventAt = startedAt;
        let lastDataEventKind = "stream_start";
        let lastProgress: Record<string, unknown> | null = null;
        let lastWatchdogLogAt = 0;
        const heartbeatIntervalMs = streamHeartbeatMs();
        const watchdogIntervalMs = streamWatchdogMs();
        const sendSse = (event: string, payload: unknown, options: { dataEvent?: boolean } = {}) => {
          if (cancelled || abortController.signal.aborted) {
            return;
          }
          if (options.dataEvent !== false) {
            lastDataEventAt = Date.now();
            lastDataEventKind = event;
          }
          try {
            controller.enqueue(sseFrame(event, payload));
          } catch {
            cancelled = true;
            abortController.abort();
          }
        };
        const writeWatchdogLog = () => {
          if (cancelled || abortController.signal.aborted) {
            return;
          }
          const now = Date.now();
          const idleMs = now - lastDataEventAt;
          if (idleMs < watchdogIntervalMs || now - lastWatchdogLogAt < watchdogIntervalMs) {
            return;
          }
          lastWatchdogLogAt = now;
          console.warn(
            `[stream-watchdog] ${JSON.stringify({
              streamId: streamLogId,
              idleMs,
              elapsedMs: now - startedAt,
              lastEventKind: lastDataEventKind,
              lastProgress
            })}`
          );
        };
        heartbeatTimer = setInterval(() => {
          const now = Date.now();
          sendSse(
            "heartbeat",
            {
              message: "stream_alive",
              streamLogId,
              elapsedMs: now - startedAt,
              idleMs: now - lastDataEventAt,
              lastEventKind: lastDataEventKind,
              lastProgress
            },
            { dataEvent: false }
          );
          writeWatchdogLog();
        }, heartbeatIntervalMs);
        humanSession = config.humanPlayerId
          ? new HumanInputSession((request) => {
              traceLog?.write("server.human_input", traceHumanInputRequest(request));
              sendSse("human_input", request);
            }, (request) => {
              if (!cancelled && !abortController.signal.aborted) {
                traceLog?.write("server.human_input_cancelled", { requestId: request.id });
                sendSse("human_input_cancelled", { requestId: request.id });
              }
            })
          : null;
        if (humanSession) {
          registerHumanInputSession(humanSession);
          traceLog?.rememberKey(humanSession.id);
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
              lastProgress = traceProgress(payload);
              traceLog?.write("server.progress", lastProgress);
              sendSse("progress", payload);
            }
          }
        });
        const systemPayload = {
          message: "stream_opened",
          view: streamView,
          gameId: humanSession?.id ?? null,
          humanPlayerId: config.humanPlayerId ?? null,
          humanOptionalInputTimeoutMs: config.humanOptionalInputTimeoutMs ?? null,
          prefetchConcurrency: config.prefetchConcurrency ?? null,
          streamLogId,
          traceEnabled: isPersistentTraceEnabled(),
          traceFile: traceLog?.filePath ?? null
        };
        traceLog?.write("server.system", systemPayload);
        sendSse("system", systemPayload);

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
            traceLog?.write("server.game", traceEvent(payload));
            sendSse("game", payload);
          }
          if (!cancelled && !abortController.signal.aborted) {
            traceLog?.write("server.done", { message: "game_complete" });
            sendSse("done", { message: "game_complete" });
          }
        } catch (error) {
          streamStatus = "error";
          const errorMessage = error instanceof Error ? error.message : String(error);
          traceLog?.write("server.error", { message: streamErrorMessageForClient(errorMessage) });
          console.error(
            `[stream-error] ${JSON.stringify({
              streamId: streamLogId,
              message: errorMessage,
              stack: error instanceof Error ? error.stack : undefined
            })}`
          );
          if (!cancelled && !abortController.signal.aborted) {
            sendSse(
              "error",
              {
                message: streamErrorMessageForClient(errorMessage),
                streamLogId
              }
            );
          }
        } finally {
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
          speechDiagnostics.logSummary(cancelled || abortController.signal.aborted ? "cancelled" : streamStatus);
          if (humanSession) {
            unregisterHumanInputSession(humanSession.id);
            humanSession = null;
          }
          traceLog?.close(cancelled || abortController.signal.aborted ? "cancelled" : streamStatus);
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
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        traceLog?.write("server.cancelled", { reason: "readable_stream_cancel" });
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
