import type { Camp, CampId, Player, Role } from "../types";
export type { CampId };

export type RoleTag =
  | "werewolf"
  | "village"
  | "night_action"
  | "team_action"
  | "investigative"
  | "protective"
  | "death_trigger"
  | "single_use"
  | "vote_modifier"
  | "execution_escape"
  | "linked_death";

export type NightActionKind =
  | "guard_protect"
  | "werewolf_discussion"
  | "werewolf_attack"
  | "seer_check"
  | "witch_action"
  | "raven_mark"
  | "wolf_beauty_charm";

export interface NightActionDefinition {
  kind: NightActionKind;
  priority: number;
  teamAction?: boolean;
}

export type DeathTriggerKind = "hunter_shot" | "alpha_wolf_shot";

export interface DeathTriggerDefinition {
  kind: DeathTriggerKind;
  once: boolean;
}

export interface RoleDefinition {
  role: Role;
  camp: Camp;
  victoryCamp?: CampId;
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
  camp: CampId;
  fallbackCamp: Camp;
  reason: "all_werewolves_eliminated" | "werewolf_parity" | "only_lovers_alive";
  counts: Record<Camp, number>;
  winnerIds: string[];
}

export type RulePlayer = Pick<Player, "id" | "role" | "camp" | "alive">;

export type RuleStatusKind =
  | "raven_marked"
  | "no_vote"
  | "revealed"
  | "abilities_disabled"
  | "execution_escape"
  | "lover"
  | "charm_anchor"
  | "charmed";

export type RuleStatusDuration = "phase" | "round" | "game";

export interface RuleStatus {
  kind: RuleStatusKind;
  sourceId?: string;
  targetId?: string;
  duration?: RuleStatusDuration;
  round?: number;
  phase?: string;
  count?: number;
}

export interface RulePlayerState {
  playerId: string;
  statuses: RuleStatus[];
  executionEscapeUsed?: boolean;
}

export interface RuleState {
  players: Record<string, RulePlayerState>;
}

export interface RuleStatusEffect {
  playerId: string;
  addStatuses?: RuleStatus[];
  setState?: Partial<Omit<RulePlayerState, "playerId" | "statuses">>;
}
