import type { Camp } from "../types";
import type { RulePlayer, VictoryCheckResult } from "./types";

export function countAliveByCamp(players: RulePlayer[], camp: Camp): number {
  return players.filter((player) => player.alive && player.camp === camp).length;
}

export function checkStandardVictory(players: RulePlayer[]): VictoryCheckResult | null {
  const werewolf = countAliveByCamp(players, "werewolf");
  const village = countAliveByCamp(players, "village");

  if (werewolf === 0) {
    return {
      camp: "village",
      reason: "all_werewolves_eliminated",
      counts: { werewolf, village },
      winnerIds: players.filter((player) => player.alive && player.camp === "village").map((player) => player.id)
    };
  }

  if (werewolf >= village) {
    return {
      camp: "werewolf",
      reason: "werewolf_parity",
      counts: { werewolf, village },
      winnerIds: players.filter((player) => player.alive && player.camp === "werewolf").map((player) => player.id)
    };
  }

  return null;
}

export function adjudicateStandardVictory(players: RulePlayer[]): Camp {
  return countAliveByCamp(players, "werewolf") >= countAliveByCamp(players, "village") ? "werewolf" : "village";
}
