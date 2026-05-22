import type { Role } from "../types";
import { roleNightActions } from "./roles";
import type { NightActionDefinition } from "./types";

export interface NightActionStep extends NightActionDefinition {
  roles: Role[];
}

export function createNightActionPlan(roles: Role[]): NightActionStep[] {
  const byKind = new Map<NightActionDefinition["kind"], NightActionStep>();

  for (const role of roles) {
    for (const action of roleNightActions(role)) {
      const existing = byKind.get(action.kind);
      if (existing) {
        existing.roles.push(role);
        existing.priority = Math.max(existing.priority, action.priority);
        existing.teamAction ||= action.teamAction;
        continue;
      }
      byKind.set(action.kind, { ...action, roles: [role] });
    }
  }

  return [...byKind.values()].sort((a, b) => b.priority - a.priority || a.kind.localeCompare(b.kind));
}
