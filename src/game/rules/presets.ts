import type { DebugScenario, Role } from "../types";

export const minSupportedPlayers = 6;
export const maxSupportedPlayers = 20;
export const defaultPlayerCount = 7;

export function normalizePlayerCount(count: number): number {
  if (!Number.isFinite(count)) {
    return defaultPlayerCount;
  }
  return Math.min(maxSupportedPlayers, Math.max(minSupportedPlayers, Math.floor(count)));
}

export function createRoles(playerCount: number): Role[] {
  const fixed: Role[] = createWerewolfRoles(playerCount);
  fixed.push("Seer", "Witch");
  if (playerCount >= 8) {
    fixed.push("Guard");
  }
  if (playerCount >= 9) {
    fixed.push("Hunter");
  }
  if (playerCount >= 10) {
    fixed.push("Raven");
  }
  if (playerCount >= 13) {
    fixed.push("Idiot");
  }
  if (playerCount >= 15) {
    fixed.push("Elder");
  }
  if (playerCount >= 16) {
    fixed.push("Lover", "Lover");
  }
  if (playerCount >= 20) {
    fixed.push("Jester");
  }
  return [...fixed, ...Array.from<Role>({ length: playerCount - fixed.length }).fill("Villager")];
}

function createWerewolfRoles(playerCount: number): Role[] {
  if (playerCount <= 6) {
    return ["Werewolf"];
  }
  if (playerCount <= 10) {
    return ["Werewolf", "Werewolf"];
  }
  if (playerCount <= 14) {
    return ["Werewolf", "Werewolf", "AlphaWolf"];
  }
  if (playerCount <= 17) {
    return ["Werewolf", "Werewolf", "AlphaWolf", "Werewolf"];
  }
  return ["Werewolf", "Werewolf", "AlphaWolf", "WolfBeauty", "Werewolf"];
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
