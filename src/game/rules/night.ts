import type { Role } from "../types";
import { roleNightActions } from "./roles";
import type { NightActionDefinition } from "./types";

export interface NightActionActor {
  role: Role;
  playerId?: string;
}

export interface NightActionStep extends NightActionDefinition {
  roles: Role[];
  actorIds: string[];
}

function normalizeActor(input: Role | NightActionActor): NightActionActor {
  return typeof input === "string" ? { role: input } : input;
}

export function createNightActionPlan(inputs: Array<Role | NightActionActor>): NightActionStep[] {
  const steps: NightActionStep[] = [];
  const teamActionsByKind = new Map<NightActionDefinition["kind"], NightActionStep>();

  for (const input of inputs) {
    const { role, playerId } = normalizeActor(input);
    for (const action of roleNightActions(role)) {
      if (!action.teamAction) {
        steps.push({ ...action, roles: [role], actorIds: playerId ? [playerId] : [] });
        continue;
      }

      const existing = teamActionsByKind.get(action.kind);
      if (existing) {
        existing.roles.push(role);
        if (playerId) {
          existing.actorIds.push(playerId);
        }
        existing.priority = Math.max(existing.priority, action.priority);
        existing.teamAction ||= action.teamAction;
        continue;
      }
      const step = { ...action, roles: [role], actorIds: playerId ? [playerId] : [] };
      teamActionsByKind.set(action.kind, step);
      steps.push(step);
    }
  }

  return steps.sort((a, b) => b.priority - a.priority || a.kind.localeCompare(b.kind));
}
