import type { EventVisibility, GameEvent, GameSnapshot, PlayerSnapshot } from "./types";

export type SpectatorMode = "omniscient" | "village";

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
    message: secret ? "村視点では非公開情報です。" : event.message,
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
