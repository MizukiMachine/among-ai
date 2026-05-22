import type { Camp, Role } from "../types";
import type { DeathTriggerDefinition, NightActionDefinition, RoleDefinition } from "./types";

const werewolfNightActions: NightActionDefinition[] = [
  { kind: "werewolf_discussion", priority: 90, teamAction: true },
  { kind: "werewolf_attack", priority: 80, teamAction: true }
];

export const roleDefinitions: Record<Role, RoleDefinition> = {
  Werewolf: {
    role: "Werewolf",
    camp: "werewolf",
    tags: ["werewolf", "night_action", "team_action"],
    nightActions: werewolfNightActions,
    deathTriggers: []
  },
  Seer: {
    role: "Seer",
    camp: "village",
    tags: ["village", "night_action", "investigative"],
    nightActions: [{ kind: "seer_check", priority: 70 }],
    deathTriggers: []
  },
  Witch: {
    role: "Witch",
    camp: "village",
    tags: ["village", "night_action", "single_use"],
    nightActions: [{ kind: "witch_action", priority: 60 }],
    deathTriggers: []
  },
  Guard: {
    role: "Guard",
    camp: "village",
    tags: ["village", "night_action", "protective"],
    nightActions: [{ kind: "guard_protect", priority: 100 }],
    deathTriggers: []
  },
  Hunter: {
    role: "Hunter",
    camp: "village",
    tags: ["village", "death_trigger", "single_use"],
    nightActions: [],
    deathTriggers: [{ kind: "hunter_shot", once: true }]
  },
  Villager: {
    role: "Villager",
    camp: "village",
    tags: ["village"],
    nightActions: [],
    deathTriggers: []
  }
};

export function getRoleDefinition(role: Role): RoleDefinition {
  return roleDefinitions[role];
}

export function roleCamp(role: Role): Camp {
  return getRoleDefinition(role).camp;
}

export function roleNightActions(role: Role): NightActionDefinition[] {
  return getRoleDefinition(role).nightActions;
}

export function roleDeathTriggers(role: Role): DeathTriggerDefinition[] {
  return getRoleDefinition(role).deathTriggers;
}

export function hasRoleTag(role: Role, tag: RoleDefinition["tags"][number]): boolean {
  return getRoleDefinition(role).tags.includes(tag);
}
