import type { Camp } from "../types";
import { getRoleDefinition } from "./roles";
import { playerStatuses } from "./state";
import type { RulePlayer, RuleState, VictoryCheckResult } from "./types";

export function countAliveByCamp(players: RulePlayer[], camp: Camp): number {
  return players.filter((player) => player.alive && player.camp === camp).length;
}

function winsWithStandardCamp(player: RulePlayer): boolean {
  return getRoleDefinition(player.role).standardCampVictory !== false;
}

export function checkStandardVictory(players: RulePlayer[]): VictoryCheckResult | null {
  const werewolf = countAliveByCamp(players, "werewolf");
  const village = countAliveByCamp(players, "village");

  if (werewolf === 0) {
    return {
      camp: "village",
      fallbackCamp: "village",
      reason: "all_werewolves_eliminated",
      counts: { werewolf, village },
      winnerIds: players.filter((player) => player.alive && player.camp === "village" && winsWithStandardCamp(player)).map((player) => player.id)
    };
  }

  if (werewolf >= village) {
    return {
      camp: "werewolf",
      fallbackCamp: "werewolf",
      reason: "werewolf_parity",
      counts: { werewolf, village },
      winnerIds: players.filter((player) => player.alive && player.camp === "werewolf" && winsWithStandardCamp(player)).map((player) => player.id)
    };
  }

  return null;
}

export function checkLoverVictory(players: RulePlayer[], state: RuleState): VictoryCheckResult | null {
  const lovers = players.filter((player) => playerStatuses(state, player.id, "lover").some((status) => status.targetId));

  if (lovers.length === 2 && lovers.every((player) => player.alive)) {
    const werewolf = countAliveByCamp(players, "werewolf");
    const village = countAliveByCamp(players, "village");
    return {
      camp: "lover",
      fallbackCamp: adjudicateStandardVictory(players),
      reason: "lovers_alive_at_game_end",
      counts: { werewolf, village },
      winnerIds: lovers.map((player) => player.id)
    };
  }

  return null;
}

export function checkNeutralVictory(players: RulePlayer[], state: RuleState): VictoryCheckResult | null {
  const neutralClaims = (state.victoryClaims ?? []).filter((claim) => claim.camp === "neutral");
  if (neutralClaims.length === 0) {
    return null;
  }

  const werewolf = countAliveByCamp(players, "werewolf");
  const village = countAliveByCamp(players, "village");
  return {
    camp: "neutral",
    fallbackCamp: adjudicateStandardVictory(players),
    reason: "neutral_role_condition",
    counts: { werewolf, village },
    winnerIds: [...new Set(neutralClaims.flatMap((claim) => claim.winnerIds))]
  };
}

export function adjudicateStandardVictory(players: RulePlayer[]): Camp {
  return countAliveByCamp(players, "werewolf") >= countAliveByCamp(players, "village") ? "werewolf" : "village";
}
