import type { Camp, EventVisibility, GameEvent, GameSnapshot, GenerationProgress, PlayerSnapshot, Role } from "./types";

export type SpectatorMode = "omniscient" | "village" | "player";
export const redactedMessage = "あなたの視点では非公開情報です\n次へ進んでください";

export interface VillagePlayerSnapshot extends Omit<PlayerSnapshot, "camp" | "role" | "witch"> {
  camp: "hidden";
  role: "Hidden";
}

export interface VillageGameSnapshot extends Omit<GameSnapshot, "players" | "villageCount" | "werewolfCount"> {
  players: VillagePlayerSnapshot[];
  villageCount: null;
  werewolfCount: null;
}

export interface VillageGameEvent extends Omit<GameEvent, "data" | "role" | "snapshot"> {
  data: Record<string, unknown> & {
    redacted?: boolean;
    visibility?: EventVisibility;
  };
  role?: undefined;
  snapshot: VillageGameSnapshot;
}

export interface PlayerViewPlayerSnapshot extends Omit<PlayerSnapshot, "camp" | "role"> {
  camp: Camp | "hidden";
  role: Role | "Hidden";
}

export interface PlayerViewGameSnapshot extends Omit<GameSnapshot, "players" | "villageCount" | "werewolfCount"> {
  players: PlayerViewPlayerSnapshot[];
  villageCount: null;
  werewolfCount: null;
}

export interface PlayerViewGameEvent extends Omit<GameEvent, "data" | "role" | "snapshot"> {
  data: Record<string, unknown> & {
    redacted?: boolean;
    visibility?: EventVisibility;
  };
  role?: Role;
  snapshot: PlayerViewGameSnapshot;
}

export function isVisibility(value: unknown): value is EventVisibility {
  return value === "public" || value === "private" || value === "werewolf" || value === "lover";
}

export function isSecretEvent(event: GameEvent): boolean {
  const visibility = event.data?.visibility;
  if (visibility === "private" || visibility === "werewolf" || visibility === "lover") {
    return true;
  }
  return (
    event.type === "private_info" ||
    event.type === "night_action" ||
    (event.type === "player_speech" && (event.phase === "werewolf_discussion" || event.phase === "lover_discussion"))
  );
}

export function eventVisibility(event: GameEvent): EventVisibility {
  const visibility = event.data?.visibility;
  if (isVisibility(visibility)) {
    return visibility;
  }
  return isSecretEvent(event) ? "private" : "public";
}

export function redactSnapshotForVillage(snapshot: GameSnapshot): VillageGameSnapshot {
  return {
    ...snapshot,
    werewolfCount: null,
    villageCount: null,
    players: snapshot.players.map((player) => ({
      id: player.id,
      name: player.name,
      alive: player.alive,
      model: player.model,
      memoryCount: player.memoryCount,
      persona: player.persona,
      camp: "hidden",
      role: "Hidden"
    }))
  };
}

export function redactSnapshotForPlayer(snapshot: GameSnapshot, playerId: string): PlayerViewGameSnapshot {
  // A werewolf-camp viewer knows their fellow werewolves' identities — they are revealed at
  // the first-day face-off and share the night chat. A Lover viewer likewise learns their
  // partner at the lover face-off. The UI still gates when those real roles are displayed.
  const viewer = snapshot.players.find((player) => player.id === playerId);
  const viewerIsWerewolf = viewer?.camp === "werewolf";
  const viewerIsLover = viewer?.role === "Lover";
  return {
    ...snapshot,
    werewolfCount: null,
    villageCount: null,
    players: snapshot.players.map((player) => {
      if (player.id === playerId || (viewerIsWerewolf && player.camp === "werewolf") || (viewerIsLover && player.role === "Lover")) {
        return player;
      }
      return {
        id: player.id,
        name: player.name,
        alive: player.alive,
        model: player.model,
        memoryCount: player.memoryCount,
        persona: player.persona,
        camp: "hidden",
        role: "Hidden"
      };
    })
  };
}

export function redactEventDataForVillage(
  eventType: GameEvent["type"],
  data: GameEvent["data"] = {},
  secret = false
): VillageGameEvent["data"] {
  if (secret) {
    return {
      visibility: isVisibility(data.visibility) ? data.visibility : "private",
      redacted: true
    };
  }

  const publicData: Record<string, unknown> = { ...data };
  delete publicData.targetRole;
  delete publicData.visibleTo;
  delete publicData.result;
  redactPublicVoteData(eventType, publicData);
  redactPublicDeathData(eventType, publicData);
  return publicData;
}

export function redactEventForVillage(event: GameEvent): VillageGameEvent {
  const secret = isSecretEvent(event);
  const redactedEvent: VillageGameEvent = {
    id: event.id,
    createdAt: event.createdAt,
    round: event.round,
    phase: event.phase,
    type: event.type,
    message: secret ? redactedMessage : event.message,
    playerId: secret ? undefined : event.playerId,
    playerName: secret ? undefined : event.playerName,
    targetId: secret ? undefined : event.targetId,
    targetName: secret ? undefined : event.targetName,
    data: redactEventDataForVillage(event.type, event.data, secret),
    role: undefined,
    snapshot: redactSnapshotForVillage(event.snapshot)
  };
  return redactedEvent;
}

function dataVisibleToPlayer(data: GameEvent["data"], playerId: string): boolean {
  if (data?.visibleTo === playerId) {
    return true;
  }
  const visibleTo = data?.visibleTo;
  if (Array.isArray(visibleTo) && visibleTo.includes(playerId)) {
    return true;
  }
  const loverIds = data?.loverIds;
  return Array.isArray(loverIds) && loverIds.includes(playerId);
}

function isEventVisibleToPlayer(event: GameEvent, playerId: string): boolean {
  if (!isSecretEvent(event)) {
    return true;
  }
  if (dataVisibleToPlayer(event.data, playerId)) {
    return true;
  }
  // Werewolf-visibility events (e.g. the night discussion) are shared across the whole werewolf team,
  // so any werewolf-camp viewer should see them, not just the speaker.
  if (eventVisibility(event) === "werewolf") {
    const viewer = event.snapshot?.players.find((player) => player.id === playerId);
    if (viewer?.camp === "werewolf") {
      return true;
    }
  }
  if (eventVisibility(event) === "lover") {
    return false;
  }
  return event.playerId === playerId && (event.data?.visibility === "private" || event.data?.visibility === "werewolf");
}

function redactPublicVoteData(eventType: GameEvent["type"], data: Record<string, unknown>): void {
  if (eventType === "vote_cast") {
    delete data.reason;
  }
  if (eventType === "vote_result" || eventType === "round_summary") {
    if (Array.isArray(data.votes)) {
      data.votes = data.votes.map((vote) => stripReason(vote));
    }
    delete data.modifiers;
  }
}

function redactPublicDeathData(eventType: GameEvent["type"], data: Record<string, unknown>): void {
  if (eventType !== "death" || data.cause === "no_death") {
    return;
  }
  delete data.cause;
  delete data.sourceId;
  delete data.sourceName;
  delete data.hunterId;
  delete data.hunterName;
  delete data.alphaWolfId;
  delete data.alphaWolfName;
  delete data.chainDepth;
}

function stripReason(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const copy = { ...(value as Record<string, unknown>) };
  delete copy.reason;
  return copy;
}

function redactEventDataForPlayer(event: GameEvent, playerId: string): PlayerViewGameEvent["data"] {
  const secret = isSecretEvent(event);
  const visible = isEventVisibleToPlayer(event, playerId);
  if (secret && !visible) {
    return {
      visibility: isVisibility(event.data?.visibility) ? event.data.visibility : "private",
      redacted: true
    };
  }

  const publicData: Record<string, unknown> = { ...(event.data ?? {}) };
  delete publicData.visibleTo;
  delete publicData.loverIds;
  redactPublicVoteData(event.type, publicData);
  if (!secret) {
    delete publicData.targetRole;
    delete publicData.result;
    redactPublicDeathData(event.type, publicData);
  }
  return publicData;
}

export function redactEventForPlayer(event: GameEvent, playerId: string): PlayerViewGameEvent {
  const visible = isEventVisibleToPlayer(event, playerId);
  const redactedEvent: PlayerViewGameEvent = {
    id: event.id,
    createdAt: event.createdAt,
    round: event.round,
    phase: event.phase,
    type: event.type,
    message: visible ? event.message : redactedMessage,
    playerId: visible ? event.playerId : undefined,
    playerName: visible ? event.playerName : undefined,
    targetId: visible ? event.targetId : undefined,
    targetName: visible ? event.targetName : undefined,
    data: redactEventDataForPlayer(event, playerId),
    role: visible && event.playerId === playerId ? event.role : undefined,
    snapshot: redactSnapshotForPlayer(event.snapshot, playerId)
  };
  return redactedEvent;
}

function isSecretProgress(progress: GenerationProgress): boolean {
  return (
    progress.task === "werewolf_discussion" ||
    progress.task === "werewolf_attack_vote" ||
    progress.phase === "werewolf_discussion" ||
    progress.phase === "lover_discussion"
  );
}

export function redactProgressForVillage(progress: GenerationProgress): GenerationProgress {
  if (!isSecretProgress(progress)) {
    return progress;
  }

  return {
    ...progress,
    phase: "night",
    task: "hidden",
    label: "夜の処理",
    redacted: true
  };
}

export function redactProgressForPlayer(progress: GenerationProgress): GenerationProgress {
  return redactProgressForVillage(progress);
}
