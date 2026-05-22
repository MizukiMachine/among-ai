import type { Camp, Player, Role } from "../types";

export type CampId = Camp | "neutral" | "lover";

export type RoleTag =
  | "werewolf"
  | "village"
  | "night_action"
  | "team_action"
  | "investigative"
  | "protective"
  | "death_trigger"
  | "single_use";

export type NightActionKind =
  | "guard_protect"
  | "werewolf_discussion"
  | "werewolf_attack"
  | "seer_check"
  | "witch_action";

export interface NightActionDefinition {
  kind: NightActionKind;
  priority: number;
  teamAction?: boolean;
}

export type DeathTriggerKind = "hunter_shot";

export interface DeathTriggerDefinition {
  kind: DeathTriggerKind;
  once: boolean;
}

export interface RoleDefinition {
  role: Role;
  camp: Camp;
  tags: RoleTag[];
  nightActions: NightActionDefinition[];
  deathTriggers: DeathTriggerDefinition[];
}

export type DeathCause = "werewolf" | "poison" | "vote" | "hunter" | "multiple" | string;

export interface DeathRecord {
  playerId: string;
  cause: DeathCause;
  sourceId?: string;
}

export interface NightDeathInput {
  werewolfTargetId?: string | null;
  savedTargetId?: string | null;
  protectedTargetId?: string | null;
  poisonTargetId?: string | null;
}

export interface VictoryCheckResult {
  camp: Camp;
  reason: "all_werewolves_eliminated" | "werewolf_parity";
  counts: Record<Camp, number>;
  winnerIds: string[];
}

export type RulePlayer = Pick<Player, "id" | "role" | "camp" | "alive">;
