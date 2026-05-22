import type { DebugScenario, Role } from "../types";

export const minSupportedPlayers = 6;
export const maxSupportedPlayers = 9;
export const defaultPlayerCount = 7;

export function normalizePlayerCount(count: number): number {
  if (!Number.isFinite(count)) {
    return defaultPlayerCount;
  }
  return Math.min(maxSupportedPlayers, Math.max(minSupportedPlayers, Math.floor(count)));
}

export function createRoles(playerCount: number): Role[] {
  const werewolves = playerCount >= 7 ? 2 : 1;
  const fixed: Role[] = [
    ...Array.from<Role>({ length: werewolves }).fill("Werewolf"),
    "Seer",
    "Witch"
  ];
  if (playerCount >= 8) {
    fixed.push("Guard");
  }
  if (playerCount >= 9) {
    fixed.push("Hunter");
  }
  return [...fixed, ...Array.from<Role>({ length: playerCount - fixed.length }).fill("Villager")];
}

export function minimumPlayerCountForScenario(scenario: DebugScenario): number {
  if (scenario === "guard_success") {
    return 8;
  }
  if (scenario === "hunter_shot") {
    return 9;
  }
  return minSupportedPlayers;
}

export function createScenarioRoles(scenario: DebugScenario, playerCount: number): Role[] {
  if (scenario === "guard_success") {
    const roles: Role[] = ["Guard", "Werewolf", "Villager", "Seer", "Witch", "Werewolf", "Villager", "Villager"];
    return [...roles, ...Array.from<Role>({ length: playerCount - roles.length }).fill("Hunter")];
  }
  if (scenario === "hunter_shot") {
    const roles: Role[] = ["Werewolf", "Werewolf", "Hunter", "Witch", "Guard", "Seer", "Villager", "Villager", "Villager"];
    return roles.slice(0, playerCount);
  }
  return createRoles(playerCount);
}
