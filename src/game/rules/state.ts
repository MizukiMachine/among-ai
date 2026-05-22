import type { Camp } from "../types";
import { getRoleDefinition } from "./roles";
import type {
  RulePlayer,
  RulePlayerState,
  RuleState,
  RuleStatus,
  RuleStatusDuration,
  RuleStatusEffect,
  RuleStatusKind,
  RuleVictoryClaim
} from "./types";

export function createRuleState(players: Array<Pick<RulePlayer, "id">>): RuleState {
  return {
    victoryClaims: [],
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

export function createInitialRuleState(players: RulePlayer[]): RuleState {
  let state = createRuleState(players);
  const effects: RuleStatusEffect[] = [];

  for (const player of players) {
    if (player.role === "Idiot") {
      effects.push({
        playerId: player.id,
        addStatuses: [{ kind: "execution_escape", sourceId: "role", duration: "game" }]
      });
    }
  }

  const lovers = players.filter((player) => player.role === "Lover");
  for (let index = 0; index + 1 < lovers.length; index += 2) {
    const first = lovers[index];
    const second = lovers[index + 1];
    effects.push(
      {
        playerId: first.id,
        addStatuses: [{ kind: "lover", sourceId: "role", targetId: second.id, duration: "game" }]
      },
      {
        playerId: second.id,
        addStatuses: [{ kind: "lover", sourceId: "role", targetId: first.id, duration: "game" }]
      }
    );
  }

  if (effects.length > 0) {
    state = applyStatusEffects(state, effects);
  }
  return state;
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
  return { ...state, players };
}

export function expireStatuses(state: RuleState, duration: RuleStatusDuration): RuleState {
  const players = Object.fromEntries(
    Object.entries(state.players).map(([playerId, playerState]) => [
      playerId,
      {
        ...playerState,
        statuses: playerState.statuses.filter((status) => status.duration !== duration)
      }
    ])
  );
  return { ...state, players };
}

export function addVictoryClaims(state: RuleState, claims: RuleVictoryClaim[]): RuleState {
  if (claims.length === 0) {
    return state;
  }
  return {
    ...state,
    victoryClaims: [...(state.victoryClaims ?? []), ...claims]
  };
}

export function createCampAbilityDisableEffects(
  players: RulePlayer[],
  camp: Camp,
  sourceId?: string
): RuleStatusEffect[] {
  return players
    .filter(
      (player) =>
        player.alive &&
        player.camp === camp &&
        player.role !== "Villager" &&
        getRoleDefinition(player.role).standardCampVictory !== false
    )
    .map((player) => ({
      playerId: player.id,
      addStatuses: [{ kind: "abilities_disabled", sourceId, duration: "game" }]
    }));
}
