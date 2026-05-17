export type Role = "Werewolf" | "Seer" | "Witch" | "Guard" | "Hunter" | "Villager";
export type Camp = "werewolf" | "village";
export type Persona =
  | "cautious"
  | "aggressive"
  | "logical"
  | "opportunistic"
  | "empathetic"
  | "trickster"
  | "stoic"
  | "passionate";

export type Phase =
  | "setup"
  | "night"
  | "werewolf_discussion"
  | "guard_action"
  | "seer_action"
  | "witch_action"
  | "day_discussion"
  | "voting"
  | "ended";

export type GameEventType =
  | "game_started"
  | "phase_changed"
  | "warning"
  | "player_speech"
  | "private_info"
  | "night_action"
  | "death"
  | "vote_cast"
  | "vote_result"
  | "round_summary"
  | "game_ended"
  | "system";

export type EventVisibility = "public" | "private" | "werewolf";
export type SummaryMode = "deterministic" | "llm";
export type DebugScenario = "none" | "guard_success" | "hunter_shot";

export interface SeerClaimResult {
  targetId: string;
  targetName?: string;
  camp: Camp;
  round?: number;
}

export interface ClaimMetadata {
  type: "role_claim" | "seer_result" | "witch_info" | "generic";
  role?: Role;
  targetId?: string;
  targetName?: string;
  camp?: Camp;
  result?: SeerClaimResult | string;
  note?: string;
}

export interface PlayerReadMetadata {
  targetId: string;
  targetName?: string;
  reason?: string;
  weight?: number;
}

export interface SpeechMetadata {
  suspects: PlayerReadMetadata[];
  trusts: PlayerReadMetadata[];
  claims: ClaimMetadata[];
}

export interface AgentSpeech {
  messages: string[];
  metadata: SpeechMetadata;
}

export interface TargetDecision {
  targetId: string | null;
  reason: string;
}

export interface CharacterProfile {
  playerId: string;
  nameJa: string;
  gender: "male" | "female";
  tagline: string;
  speechStyle: string;
  values: string;
  sampleLines: string[];
  relations: Record<string, string>;
}

export interface Player {
  id: string;
  name: string;
  role: Role;
  camp: Camp;
  persona: Persona;
  alive: boolean;
  model: string;
  memories: string[];
  seerResults: Record<string, Camp>;
  seerResultRounds: Record<string, number>;
  witch: {
    savePotion: boolean;
    poisonPotion: boolean;
  };
  characterProfile?: CharacterProfile;
}

export interface PlayerSnapshot {
  id: string;
  name: string;
  role: Role;
  camp: Camp;
  persona: Persona;
  alive: boolean;
  model: string;
  memoryCount: number;
  witch?: {
    savePotion: boolean;
    poisonPotion: boolean;
  };
}

export interface GameSnapshot {
  round: number;
  phase: Phase;
  winner: Camp | null;
  players: PlayerSnapshot[];
  aliveCount: number;
  werewolfCount: number;
  villageCount: number;
}

export interface GameEvent {
  id: number;
  createdAt: string;
  round: number;
  phase: Phase;
  type: GameEventType;
  message: string;
  playerId?: string;
  playerName?: string;
  role?: Role;
  targetId?: string;
  targetName?: string;
  data?: Record<string, unknown> & {
    visibility?: EventVisibility;
  };
  snapshot: GameSnapshot;
}

export interface GameConfig {
  playerCount: number;
  provider: "demo" | "llm";
  model: string;
  language: string;
  maxRounds: number;
  summaryMode?: SummaryMode;
  debugScenario?: DebugScenario;
}

export interface TargetCandidate {
  id: string;
  name: string;
}

export interface AgentSpeechInput {
  player: Player;
  phase: Phase;
  task: string;
  context: string;
  knownPlayers: TargetCandidate[];
  publicHistory: string[];
  privateHistory: string[];
}

export interface AgentTargetInput {
  player: Player;
  phase: Phase;
  action: string;
  context: string;
  candidates: TargetCandidate[];
  allowSkip: boolean;
}

export interface AgentBooleanInput {
  player: Player;
  phase: Phase;
  question: string;
  context: string;
}

export interface Agent {
  name: string;
  model: string;
  speak(input: AgentSpeechInput): Promise<AgentSpeech>;
  chooseTarget(input: AgentTargetInput): Promise<TargetDecision>;
  decide(input: AgentBooleanInput): Promise<boolean>;
}

export interface VoteRecord {
  voterId: string;
  targetId: string;
  reason?: string;
}
