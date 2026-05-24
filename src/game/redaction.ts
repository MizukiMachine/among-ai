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
  return value === "public" || value === "private" || value === "werewolf";
}

export function isSecretEvent(event: GameEvent): boolean {
  const visibility = event.data?.visibility;
  if (visibility === "private" || visibility === "werewolf") {
    return true;
  }
  return (
    event.type === "private_info" ||
    event.type === "night_action" ||
    (event.type === "player_speech" && event.phase === "werewolf_discussion")
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
  return {
    ...snapshot,
    werewolfCount: null,
    villageCount: null,
    players: snapshot.players.map((player) => {
      if (player.id === playerId) {
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
    data: redactEventDataForVillage(event.data, secret),
    role: undefined,
    snapshot: redactSnapshotForVillage(event.snapshot)
  };
  return redactedEvent;
}

function isEventVisibleToPlayer(event: GameEvent, playerId: string): boolean {
  if (!isSecretEvent(event)) {
    return true;
  }
  if (event.data?.visibleTo === playerId) {
    return true;
  }
  return event.playerId === playerId && (event.data?.visibility === "private" || event.data?.visibility === "werewolf");
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
  delete publicData.votes;
  delete publicData.modifiers;
  if (event.type === "vote_cast" && event.playerId !== playerId) {
    delete publicData.reason;
  }
  if (!secret) {
    delete publicData.targetRole;
    delete publicData.result;
  }
  return publicData;
}

export function redactEventForPlayer(event: GameEvent, playerId: string): PlayerViewGameEvent {
  const visible = isEventVisibleToPlayer(event, playerId);
  const hiddenVoteCast = visible && event.type === "vote_cast" && event.playerId !== playerId;
  const redactedEvent: PlayerViewGameEvent = {
    id: event.id,
    createdAt: event.createdAt,
    round: event.round,
    phase: event.phase,
    type: event.type,
    message: hiddenVoteCast ? "投票が行われました。" : visible ? event.message : redactedMessage,
    playerId: visible && !hiddenVoteCast ? event.playerId : undefined,
    playerName: visible && !hiddenVoteCast ? event.playerName : undefined,
    targetId: visible && !hiddenVoteCast ? event.targetId : undefined,
    targetName: visible && !hiddenVoteCast ? event.targetName : undefined,
    data: redactEventDataForPlayer(event, playerId),
    role: visible && !hiddenVoteCast && event.playerId === playerId ? event.role : undefined,
    snapshot: redactSnapshotForPlayer(event.snapshot, playerId)
  };
  return redactedEvent;
}

function isSecretProgress(progress: GenerationProgress): boolean {
  return progress.task === "werewolf_discussion" || progress.task === "werewolf_attack_vote" || progress.phase === "werewolf_discussion";
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
