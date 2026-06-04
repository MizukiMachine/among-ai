import { roleValues, type DebugScenario, type Role } from "../types";
import { roleCamp } from "./roles";

export const minSupportedPlayers = 6;
export const maxSupportedPlayers = 15;
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
  if (playerCount >= 9) {
    fixed.push("Raven");
  }
  if (playerCount >= 11) {
    fixed.push("Idiot");
  }
  if (playerCount >= 12) {
    fixed.push("Elder");
  }
  if (playerCount >= 13) {
    fixed.push("Lover", "Lover");
  }
  if (playerCount >= 15) {
    fixed.push("Jester");
  }
  return [...fixed, ...Array.from<Role>({ length: playerCount - fixed.length }).fill("Villager")];
}

export function isRole(value: string | null | undefined): value is Role {
  return roleValues.includes(value as Role);
}

export function createRolesWithFixedHumanRole(playerCount: number, humanRole: Role): Role[] {
  const roles = createRoles(playerCount);
  if (humanRole === "Lover") {
    return ensureMinimumRoleCount(roles, "Lover", 2);
  }
  if (roles.includes(humanRole)) {
    return roles;
  }
  if (roleCamp(humanRole) === "werewolf") {
    const werewolfIndex = roles.findIndex((role) => roleCamp(role) === "werewolf");
    if (werewolfIndex >= 0) {
      return [...roles.slice(0, werewolfIndex), humanRole, ...roles.slice(werewolfIndex + 1)];
    }
  }
  return replaceFillRole(roles, humanRole);
}

function ensureMinimumRoleCount(roles: Role[], role: Role, count: number): Role[] {
  let nextRoles = [...roles];
  while (nextRoles.filter((candidate) => candidate === role).length < count) {
    nextRoles = replaceFillRole(nextRoles, role);
  }
  return nextRoles;
}

function replaceFillRole(roles: Role[], replacement: Role): Role[] {
  const fillIndex = roles.findIndex((role) => role === "Villager");
  const replaceIndex = fillIndex >= 0 ? fillIndex : roles.findIndex((role) => role !== replacement);
  if (replaceIndex < 0) {
    return roles;
  }
  return [...roles.slice(0, replaceIndex), replacement, ...roles.slice(replaceIndex + 1)];
}

function createWerewolfRoles(playerCount: number): Role[] {
  if (playerCount <= 6) {
    return ["Werewolf"];
  }
  if (playerCount <= 9) {
    return ["Werewolf", "Werewolf"];
  }
  if (playerCount <= 13) {
    return ["Werewolf", "Werewolf", "AlphaWolf"];
  }
  return ["Werewolf", "Werewolf", "AlphaWolf", "WolfBeauty"];
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
