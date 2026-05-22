import type { Player } from "../types";
import { roleDeathTriggers } from "./roles";
import { playerStatuses } from "./state";
import type { DeathCause, DeathRecord, NightDeathInput, RuleState } from "./types";

export function mergeDeathCause(existing: DeathCause | undefined, next: DeathCause): DeathCause {
  return existing && existing !== next ? "multiple" : next;
}

export function createNightDeathRecords(input: NightDeathInput): DeathRecord[] {
  const deaths = new Map<string, DeathCause>();
  const add = (playerId: string | null | undefined, cause: DeathCause) => {
    if (!playerId) {
      return;
    }
    deaths.set(playerId, mergeDeathCause(deaths.get(playerId), cause));
  };

  if (
    input.werewolfTargetId &&
    input.savedTargetId !== input.werewolfTargetId &&
    input.protectedTargetId !== input.werewolfTargetId
  ) {
    add(input.werewolfTargetId, "werewolf");
  }

  add(input.poisonTargetId, "poison");

  return [...deaths.entries()].map(([playerId, cause]) => ({ playerId, cause }));
}

export function canUseDeathTrigger(player: Player, usedPlayerIds: Set<string>, triggerKind = "hunter_shot"): boolean {
  return roleDeathTriggers(player.role).some((trigger) => trigger.kind === triggerKind && (!trigger.once || !usedPlayerIds.has(player.id)));
}

export function markPlayerDead(player: Player): boolean {
  if (!player.alive) {
    return false;
  }
  player.alive = false;
  return true;
}

export function createLinkedDeathRecords(initialDeaths: DeathRecord[], state: RuleState): DeathRecord[] {
  const deaths = [...initialDeaths];
  const queued = [...initialDeaths];
  const dyingIds = new Set(initialDeaths.map((death) => death.playerId));
  const enqueue = (record: DeathRecord) => {
    if (dyingIds.has(record.playerId)) {
      return;
    }
    dyingIds.add(record.playerId);
    deaths.push(record);
    queued.push(record);
  };

  for (let index = 0; index < queued.length; index += 1) {
    const death = queued[index];
    for (const status of playerStatuses(state, death.playerId, "lover")) {
      if (status.targetId) {
        enqueue({ playerId: status.targetId, cause: "lover", sourceId: death.playerId });
      }
    }
    for (const status of playerStatuses(state, death.playerId, "charm_anchor")) {
      if (status.targetId) {
        enqueue({ playerId: status.targetId, cause: "wolf_beauty_charm", sourceId: death.playerId });
      }
    }
  }

  return deaths;
}
