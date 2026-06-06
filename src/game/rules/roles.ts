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
  AlphaWolf: {
    role: "AlphaWolf",
    camp: "werewolf",
    tags: ["werewolf", "night_action", "team_action", "death_trigger", "single_use"],
    nightActions: werewolfNightActions,
    deathTriggers: [{ kind: "alpha_wolf_shot", once: true }]
  },
  WolfBeauty: {
    role: "WolfBeauty",
    camp: "werewolf",
    tags: ["werewolf", "night_action", "team_action", "linked_death"],
    nightActions: [...werewolfNightActions, { kind: "wolf_beauty_charm", priority: 75 }],
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
  Raven: {
    role: "Raven",
    camp: "village",
    tags: ["village", "night_action", "vote_modifier"],
    nightActions: [{ kind: "raven_mark", priority: 40 }],
    deathTriggers: []
  },
  Idiot: {
    role: "Idiot",
    camp: "village",
    tags: ["village", "execution_escape"],
    nightActions: [],
    deathTriggers: []
  },
  Elder: {
    role: "Elder",
    camp: "village",
    tags: ["village"],
    nightActions: [],
    deathTriggers: []
  },
  Lover: {
    role: "Lover",
    camp: "village",
    victoryCamp: "lover",
    tags: ["village", "linked_death"],
    nightActions: [],
    deathTriggers: []
  },
  Jester: {
    role: "Jester",
    camp: "village",
    victoryCamp: "neutral",
    standardCampVictory: false,
    tags: ["neutral"],
    nightActions: [],
    deathTriggers: [],
    deathVictoryConditions: [{ cause: "vote", camp: "neutral", reason: "neutral_role_condition" }]
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
