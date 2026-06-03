import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const traceEnvName = "AMONG_AI_TRACE";
const traceDirEnvName = "AMONG_AI_TRACE_DIR";
const maxTraceKeyLength = 96;
const maxTraceStringLength = 160;
const rememberedTraceFileLimit = 100;

type TracePayload = Record<string, unknown>;

export interface PersistentTraceLog {
  filePath: string;
  streamId: string;
  rememberKey(key: string | null | undefined): void;
  write(kind: string, payload?: TracePayload): void;
  close(status: string): void;
}

interface NormalizedClientTrace {
  streamLogId: string;
  kind: string;
  payload: TracePayload;
}

export type ClientTraceAppendResult =
  | { ok: true; enabled: true; filePath: string }
  | { ok: false; enabled: false }
  | { ok: false; enabled: true; error: "invalid_trace" };

const traceFilesByKey = new Map<string, string>();

export function isPersistentTraceEnabled(value = process.env[traceEnvName]): boolean {
  return /^(?:1|true|yes|on)$/iu.test(value ?? "");
}

function traceDir(): string {
  return resolve(process.env[traceDirEnvName] || "logs/game-traces");
}

function timestampForFile(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function cleanTraceKey(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, maxTraceKeyLength);
  return cleaned || "trace";
}

function rememberTraceFile(key: string | null | undefined, filePath: string): void {
  if (!key) {
    return;
  }
  traceFilesByKey.set(cleanTraceKey(key), filePath);
  while (traceFilesByKey.size > rememberedTraceFileLimit) {
    const oldestKey = traceFilesByKey.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    traceFilesByKey.delete(oldestKey);
  }
}

function filePathForTraceKey(key: string, prefix = "trace"): string {
  const cleanKey = cleanTraceKey(key);
  const remembered = traceFilesByKey.get(cleanKey);
  if (remembered) {
    return remembered;
  }

  const filePath = join(traceDir(), `${prefix}-${timestampForFile()}-${cleanKey}.jsonl`);
  rememberTraceFile(cleanKey, filePath);
  return filePath;
}

function writeTraceRecord(filePath: string, streamId: string, kind: string, payload: TracePayload = {}): void {
  try {
    mkdirSync(traceDir(), { recursive: true });
    appendFileSync(
      filePath,
      `${JSON.stringify({
        at: new Date().toISOString(),
        streamId,
        kind: cleanTraceKind(kind),
        payload
      })}\n`,
      "utf8"
    );
  } catch (error) {
    console.warn(`[trace-log] write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function cleanTraceKind(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, maxTraceKeyLength) || "unknown";
}

function traceString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.slice(0, maxTraceStringLength);
}

function traceNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function traceBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function traceObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function compactRequest(value: unknown): TracePayload | null {
  const request = traceObject(value);
  const id = traceString(request.id);
  const kind = traceString(request.kind);
  if (!id && !kind) {
    return null;
  }
  return {
    id,
    kind,
    speechMode: traceString(request.speechMode),
    nonBlocking: traceBoolean(request.nonBlocking),
    phase: traceString(request.phase),
    playerId: traceString(request.playerId),
    revealAfterEventId: traceNumber(request.revealAfterEventId)
  };
}

function compactProgress(value: unknown): TracePayload | null {
  const progress = traceObject(value);
  if (Object.keys(progress).length === 0) {
    return null;
  }
  return {
    phase: traceString(progress.phase),
    round: traceNumber(progress.round),
    task: traceString(progress.task),
    label: traceString(progress.label),
    total: traceNumber(progress.total),
    started: traceNumber(progress.started),
    completed: traceNumber(progress.completed),
    active: traceNumber(progress.active),
    queued: traceNumber(progress.queued),
    concurrency: traceNumber(progress.concurrency),
    pass: traceNumber(progress.pass),
    passes: traceNumber(progress.passes),
    redacted: traceBoolean(progress.redacted)
  };
}

function normalizeClientTracePayload(value: unknown): TracePayload {
  const payload = traceObject(value);
  return {
    action: traceString(payload.action),
    status: traceString(payload.status),
    currentEventId: traceNumber(payload.currentEventId),
    currentEventType: traceString(payload.currentEventType),
    currentEventPhase: traceString(payload.currentEventPhase),
    currentEventRound: traceNumber(payload.currentEventRound),
    eventsCount: traceNumber(payload.eventsCount),
    queuedCount: traceNumber(payload.queuedCount),
    running: traceBoolean(payload.running),
    sourceDone: traceBoolean(payload.sourceDone),
    paused: traceBoolean(payload.paused),
    processingHudVisible: traceBoolean(payload.processingHudVisible),
    waitingForSubmittedHumanInput: traceBoolean(payload.waitingForSubmittedHumanInput),
    storyWaitingForStream: traceBoolean(payload.storyWaitingForStream),
    unreadStoryAvailable: traceBoolean(payload.unreadStoryAvailable),
    storyProcessingBlocksAdvance: traceBoolean(payload.storyProcessingBlocksAdvance),
    storyNextDisabled: traceBoolean(payload.storyNextDisabled),
    humanInputAdvanceReady: traceBoolean(payload.humanInputAdvanceReady),
    optionalDiscussionInterruptSkipReady: traceBoolean(payload.optionalDiscussionInterruptSkipReady),
    readyHumanInput: traceBoolean(payload.readyHumanInput),
    visibleHumanInput: traceBoolean(payload.visibleHumanInput),
    pendingHumanInput: compactRequest(payload.pendingHumanInput),
    submittedHumanInput: compactRequest(payload.submittedHumanInput),
    generationProgress: compactProgress(payload.generationProgress)
  };
}

function normalizeClientTrace(value: unknown): NormalizedClientTrace | null {
  const body = traceObject(value);
  const streamLogId = traceString(body.streamLogId);
  const kind = traceString(body.kind);
  if (!streamLogId || !kind) {
    return null;
  }
  return {
    streamLogId: cleanTraceKey(streamLogId),
    kind: cleanTraceKind(kind),
    payload: normalizeClientTracePayload(body.payload)
  };
}

export function createPersistentTraceLog(streamId: string): PersistentTraceLog | null {
  if (!isPersistentTraceEnabled()) {
    return null;
  }

  const cleanStreamId = cleanTraceKey(streamId);
  const filePath = filePathForTraceKey(cleanStreamId, "stream");
  rememberTraceFile(cleanStreamId, filePath);

  const log: PersistentTraceLog = {
    filePath,
    streamId: cleanStreamId,
    rememberKey(key) {
      rememberTraceFile(key, filePath);
    },
    write(kind, payload = {}) {
      writeTraceRecord(filePath, cleanStreamId, kind, payload);
    },
    close(status) {
      writeTraceRecord(filePath, cleanStreamId, "trace.closed", { status });
    }
  };

  log.write("trace.opened", { filePath });
  return log;
}

export function writeTraceForKey(key: string | null | undefined, kind: string, payload: TracePayload = {}): void {
  if (!isPersistentTraceEnabled() || !key) {
    return;
  }
  const cleanKey = cleanTraceKey(key);
  const filePath = filePathForTraceKey(cleanKey);
  writeTraceRecord(filePath, cleanKey, kind, payload);
}

export function appendClientTrace(value: unknown): ClientTraceAppendResult {
  if (!isPersistentTraceEnabled()) {
    return { ok: false, enabled: false };
  }

  const normalized = normalizeClientTrace(value);
  if (!normalized) {
    return { ok: false, enabled: true, error: "invalid_trace" };
  }

  const filePath = filePathForTraceKey(normalized.streamLogId, "client");
  writeTraceRecord(filePath, normalized.streamLogId, `client.${normalized.kind}`, normalized.payload);
  return { ok: true, enabled: true, filePath };
}
