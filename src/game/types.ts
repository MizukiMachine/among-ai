export type Role = "Werewolf" | "Seer" | "Witch" | "Villager";
export type Camp = "werewolf" | "village";

export type Phase =
  | "setup"
  | "night"
  | "werewolf_discussion"
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
  | "game_ended"
  | "system";

export interface Player {
  id: string;
  name: string;
  role: Role;
  camp: Camp;
  alive: boolean;
  model: string;
  memories: string[];
  seerResults: Record<string, Camp>;
  witch: {
    savePotion: boolean;
    poisonPotion: boolean;
  };
}

export interface PlayerSnapshot {
  id: string;
  name: string;
  role: Role;
  camp: Camp;
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
  data?: Record<string, unknown>;
  snapshot: GameSnapshot;
}

export interface GameConfig {
  playerCount: number;
  provider: "demo" | "llm";
  model: string;
  language: string;
  maxRounds: number;
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
  speak(input: AgentSpeechInput): Promise<string>;
  chooseTarget(input: AgentTargetInput): Promise<string | null>;
  decide(input: AgentBooleanInput): Promise<boolean>;
}

export interface VoteRecord {
  voterId: string;
  targetId: string;
}
