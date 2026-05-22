import { hasStatus, playerRuleState } from "./state";
import type { RuleState, RuleStatusEffect } from "./types";

export interface VoteEliminationResolution {
  targetId: string;
  eliminated: boolean;
  cancelledBy?: "execution_escape";
  effects: RuleStatusEffect[];
}

export function resolveVoteElimination(targetId: string, state: RuleState): VoteEliminationResolution {
  const targetState = playerRuleState(state, targetId);
  if (hasStatus(state, targetId, "execution_escape") && !targetState.executionEscapeUsed) {
    return {
      targetId,
      eliminated: false,
      cancelledBy: "execution_escape",
      effects: [
        {
          playerId: targetId,
          addStatuses: [
            { kind: "revealed", duration: "game" },
            { kind: "no_vote", duration: "game" }
          ],
          setState: { executionEscapeUsed: true }
        }
      ]
    };
  }

  return {
    targetId,
    eliminated: true,
    effects: []
  };
}
