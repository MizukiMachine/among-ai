import type { Camp } from "../types";
import { playerStatuses } from "./state";
import type { RulePlayer, RuleState, VictoryCheckResult } from "./types";

export function countAliveByCamp(players: RulePlayer[], camp: Camp): number {
  return players.filter((player) => player.alive && player.camp === camp).length;
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
      winnerIds: players.filter((player) => player.alive && player.camp === "village").map((player) => player.id)
    };
  }

  if (werewolf >= village) {
    return {
      camp: "werewolf",
      fallbackCamp: "werewolf",
      reason: "werewolf_parity",
      counts: { werewolf, village },
      winnerIds: players.filter((player) => player.alive && player.camp === "werewolf").map((player) => player.id)
    };
  }

  return null;
}

export function checkLoverVictory(players: RulePlayer[], state: RuleState): VictoryCheckResult | null {
  const alivePlayers = players.filter((player) => player.alive);
  const lovers = alivePlayers.filter((player) => playerStatuses(state, player.id, "lover").length > 0);

  if (alivePlayers.length === 2 && lovers.length === 2) {
    const werewolf = countAliveByCamp(players, "werewolf");
    const village = countAliveByCamp(players, "village");
    return {
      camp: "lover",
      fallbackCamp: adjudicateStandardVictory(players),
      reason: "only_lovers_alive",
      counts: { werewolf, village },
      winnerIds: lovers.map((player) => player.id)
    };
  }

  return null;
}

export function adjudicateStandardVictory(players: RulePlayer[]): Camp {
  return countAliveByCamp(players, "werewolf") >= countAliveByCamp(players, "village") ? "werewolf" : "village";
}
