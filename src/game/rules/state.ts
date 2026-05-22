import type { Camp } from "../types";
import type { RulePlayer, RulePlayerState, RuleState, RuleStatus, RuleStatusEffect, RuleStatusKind } from "./types";

export function createRuleState(players: Array<Pick<RulePlayer, "id">>): RuleState {
  return {
    players: Object.fromEntries(
      players.map((player) => [
        player.id,
        {
          playerId: player.id,
          statuses: []
        }
      ])
    )
  };
}

export function playerRuleState(state: RuleState, playerId: string): RulePlayerState {
  return state.players[playerId] ?? { playerId, statuses: [] };
}

export function playerStatuses(state: RuleState, playerId: string, kind?: RuleStatusKind): RuleStatus[] {
  const statuses = playerRuleState(state, playerId).statuses;
  return kind ? statuses.filter((status) => status.kind === kind) : statuses;
}

export function hasStatus(state: RuleState, playerId: string, kind: RuleStatusKind): boolean {
  return playerStatuses(state, playerId, kind).length > 0;
}

export function canUseAbilities(state: RuleState, playerId: string): boolean {
  return !hasStatus(state, playerId, "abilities_disabled");
}

export function applyStatusEffects(state: RuleState, effects: RuleStatusEffect[]): RuleState {
  const players = { ...state.players };
  for (const effect of effects) {
    const current = playerRuleState({ players }, effect.playerId);
    players[effect.playerId] = {
      ...current,
      ...effect.setState,
      statuses: [...current.statuses, ...(effect.addStatuses ?? [])]
    };
  }
  return { players };
}

export function createCampAbilityDisableEffects(
  players: RulePlayer[],
  camp: Camp,
  sourceId?: string
): RuleStatusEffect[] {
  return players
    .filter((player) => player.alive && player.camp === camp && player.role !== "Villager")
    .map((player) => ({
      playerId: player.id,
      addStatuses: [{ kind: "abilities_disabled", sourceId, duration: "game" }]
    }));
}
