import type { Camp, CampId, Player, Role } from "../types";
export type { CampId };

export type RoleTag =
  | "werewolf"
  | "village"
  | "neutral"
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

export type DeathCause = "werewolf" | "poison" | "vote" | "hunter" | "multiple" | string;

export type VictoryReason =
  | "all_werewolves_eliminated"
  | "werewolf_parity"
  | "only_lovers_alive"
  | "neutral_role_condition";

export interface DeathVictoryConditionDefinition {
  cause: DeathCause;
  camp: "neutral";
  reason: VictoryReason;
}

export interface RoleDefinition {
  role: Role;
  camp: Camp;
  victoryCamp?: CampId;
  standardCampVictory?: boolean;
  tags: RoleTag[];
  nightActions: NightActionDefinition[];
  deathTriggers: DeathTriggerDefinition[];
  deathVictoryConditions?: DeathVictoryConditionDefinition[];
}

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
  reason: VictoryReason;
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
  victoryClaims?: RuleVictoryClaim[];
}

export interface RuleStatusEffect {
  playerId: string;
  addStatuses?: RuleStatus[];
  setState?: Partial<Omit<RulePlayerState, "playerId" | "statuses">>;
}

export interface RuleVictoryClaim {
  camp: CampId;
  reason: VictoryReason;
  winnerIds: string[];
  sourceId?: string;
  sourceRole?: Role;
}
