import { randomUUID } from "node:crypto";
import { DEFAULT_WEREWOLF_ALIGNMENT_SPEECH } from "../game/humanInputDefaults";
import type { HumanInputHandler, HumanInputRequest, HumanInputRequestPayload, HumanInputResponse } from "../game/types";

interface PendingHumanInput {
  request: HumanInputRequest;
  resolve: (response: HumanInputResponse | null) => void;
  reject: (error: Error) => void;
  cleanup?: () => void;
}

export class HumanInputSession implements HumanInputHandler {
  readonly id = randomUUID();
  private readonly pending = new Map<string, PendingHumanInput>();
  private closed = false;

  constructor(
    private readonly onRequest: (request: HumanInputRequest) => void,
    private readonly onCancel?: (request: HumanInputRequest) => void
  ) {}

  request(input: HumanInputRequestPayload): Promise<HumanInputResponse> {
    return this.requestInternal(input, { optional: false }) as Promise<HumanInputResponse>;
  }

  requestOptional(input: HumanInputRequestPayload, options: { signal?: AbortSignal } = {}): Promise<HumanInputResponse | null> {
    return this.requestInternal(input, { optional: true, signal: options.signal });
  }

  private requestInternal(
    input: HumanInputRequestPayload,
    options: { optional: boolean; signal?: AbortSignal }
  ): Promise<HumanInputResponse | null> {
    if (this.closed) {
      return Promise.reject(new Error("Human input session is closed."));
    }
    if (options.signal?.aborted) {
      return options.optional ? Promise.resolve(null) : Promise.reject(new Error("Human input request was cancelled."));
    }

    const request = {
      ...input,
      id: randomUUID()
    } as HumanInputRequest;

    return new Promise((resolve, reject) => {
      const cancel = () => {
        const pending = this.pending.get(request.id);
        if (!pending) {
          return;
        }
        this.pending.delete(request.id);
        pending.cleanup?.();
        this.onCancel?.(request);
        if (options.optional) {
          resolve(null);
        } else {
          reject(new Error("Human input request was cancelled."));
        }
      };
      const cleanup = options.signal ? () => options.signal?.removeEventListener("abort", cancel) : undefined;
      if (options.signal) {
        options.signal.addEventListener("abort", cancel, { once: true });
      }
      this.pending.set(request.id, { request, resolve, reject, cleanup });
      try {
        this.onRequest(request);
      } catch (error) {
        this.pending.delete(request.id);
        cleanup?.();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  submit(requestId: string, response: HumanInputResponse): HumanInputSubmitResult {
    const pending = this.pending.get(requestId);
    if (!pending || this.closed) {
      return { ok: false, error: "input_not_pending" };
    }
    const normalized = normalizeResponseForRequest(pending.request, response);
    if (!normalized) {
      return { ok: false, error: "invalid_input" };
    }
    this.pending.delete(requestId);
    pending.cleanup?.();
    pending.resolve(normalized);
    return { ok: true };
  }

  close(): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.cleanup?.();
      pending.reject(new Error("Human input session was closed."));
    }
    this.pending.clear();
  }
}

const sessions = new Map<string, HumanInputSession>();

export type HumanInputSubmitResult =
  | { ok: true }
  | { ok: false; error: "input_not_pending" | "invalid_input" };

function normalizeString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeResponseForRequest(request: HumanInputRequest, response: HumanInputResponse): HumanInputResponse | null {
  if (request.kind === "speech_choice") {
    if (request.nonBlocking && request.speechMode === "discussion_interrupt" && response.decision === false) {
      return { decision: false };
    }

    const speech = normalizeString(response.speech);
    if (speech) {
      return { speech };
    }

    const choiceId = normalizeString(response.choiceId);
    if (!choiceId) {
      if (request.nonBlocking && request.speechMode === "werewolf_alignment" && request.options.length === 0) {
        return { speech: DEFAULT_WEREWOLF_ALIGNMENT_SPEECH };
      }
      return null;
    }
    return request.options.some((option) => option.id === choiceId) ? { choiceId } : null;
  }

  if (request.kind === "boolean") {
    return typeof response.decision === "boolean" ? { decision: response.decision } : null;
  }

  const targetId = response.targetId ?? null;
  if (targetId === null) {
    return request.allowSkip ? { targetId: null, reason: normalizeString(response.reason) } : null;
  }

  const validTarget = request.candidates.some((candidate) => candidate.id === targetId);
  if (!validTarget) {
    return null;
  }
  return {
    targetId,
    reason: normalizeString(response.reason)
  };
}

export function registerHumanInputSession(session: HumanInputSession): void {
  sessions.set(session.id, session);
}

export function unregisterHumanInputSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  session?.close();
  sessions.delete(sessionId);
}

export function submitHumanInput(sessionId: string, requestId: string, response: HumanInputResponse): HumanInputSubmitResult {
  return sessions.get(sessionId)?.submit(requestId, response) ?? { ok: false, error: "input_not_pending" };
}
