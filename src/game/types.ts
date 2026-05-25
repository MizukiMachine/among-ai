export type Role =
  | "Werewolf"
  | "AlphaWolf"
  | "WolfBeauty"
  | "Seer"
  | "Witch"
  | "Guard"
  | "Hunter"
  | "Raven"
  | "Idiot"
  | "Elder"
  | "Lover"
  | "Jester"
  | "Villager";
export type Camp = "werewolf" | "village";
export type CampId = Camp | "neutral" | "lover";
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
export type HumanInputKind = "speech" | "target" | "boolean";
export type GenerationProgressTask =
  | "hidden"
  | "werewolf_discussion"
  | "werewolf_attack_vote"
  | "day_speech"
  | "day_vote"
  | "round_summary";

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
  persona: Persona;
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
  winnerCamp?: CampId | null;
  winnerIds?: string[];
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

export interface GenerationProgress {
  createdAt: string;
  round: number;
  phase: Phase;
  task: GenerationProgressTask;
  label: string;
  total: number;
  started: number;
  completed: number;
  active: number;
  queued: number;
  concurrency: number;
  pass?: number;
  passes?: number;
  redacted?: boolean;
}

export interface GameConfig {
  playerCount: number;
  provider: "demo" | "llm";
  model: string;
  language: string;
  maxRounds: number;
  summaryMode?: SummaryMode;
  debugScenario?: DebugScenario;
  humanPlayerId?: string | null;
  prefetchConcurrency?: number;
}

export interface TargetCandidate {
  id: string;
  name: string;
}

export type PublicNightDeathCauseKind =
  | "werewolf_attack"
  | "witch_poison"
  | "werewolf_and_witch_overlap"
  | "hunter_death_shot"
  | "alpha_wolf_death_shot"
  | "lover_linked_death"
  | "wolf_beauty_charm_linked_death";

export interface PublicNightDeathCause {
  kind: PublicNightDeathCauseKind;
  label: string;
}

export interface PublicNightDeathInfo {
  playerId: string;
  playerName: string;
  publicCauseLabel: string | null;
}

export type SpeechIntentKind =
  | "connect_night_death_to_living_players"
  | "ask_living_player"
  | "update_living_read"
  | "answer_or_update"
  | "vote_ready_read"
  | "open_discussion";

export interface SpeechIntent {
  kind: SpeechIntentKind;
  label: string;
  instruction: string;
}

export interface PublicSpeechPlan {
  phase: Phase;
  round: number;
  lastNightDeaths: PublicNightDeathInfo[];
  possibleNightDeathCauses: PublicNightDeathCause[];
  intents: SpeechIntent[];
  requiresForwardMove: boolean;
}

export interface AgentSpeechInput {
  player: Player;
  phase: Phase;
  task: string;
  context: string;
  uiContext?: string[];
  knownPlayers: TargetCandidate[];
  legalPlayers?: TargetCandidate[];
  speechPlan?: PublicSpeechPlan;
  publicHistory: string[];
  privateHistory: string[];
  abortSignal?: AbortSignal;
}

export interface AgentTargetInput {
  player: Player;
  phase: Phase;
  action: string;
  context: string;
  uiContext?: string[];
  candidates: TargetCandidate[];
  allowSkip: boolean;
  publicHistory?: string[];
  privateHistory?: string[];
  abortSignal?: AbortSignal;
}

export interface AgentBooleanInput {
  player: Player;
  phase: Phase;
  question: string;
  context: string;
  uiContext?: string[];
  publicHistory?: string[];
  privateHistory?: string[];
  abortSignal?: AbortSignal;
}

export interface Agent {
  name: string;
  model: string;
  speak(input: AgentSpeechInput): Promise<AgentSpeech>;
  chooseTarget(input: AgentTargetInput): Promise<TargetDecision>;
  decide(input: AgentBooleanInput): Promise<boolean>;
}

export interface HumanInputRequestBase {
  id: string;
  kind: HumanInputKind;
  playerId: string;
  playerName: string;
  phase: Phase;
  role: Role;
  context: HumanInputContext;
}

export interface HumanInputContext {
  notes: string[];
  publicHistory: string[];
  privateHistory: string[];
}

export interface HumanSpeechInputRequest extends HumanInputRequestBase {
  kind: "speech";
  task: string;
}

export interface HumanTargetInputRequest extends HumanInputRequestBase {
  kind: "target";
  action: string;
  candidates: TargetCandidate[];
  allowSkip: boolean;
}

export interface HumanBooleanInputRequest extends HumanInputRequestBase {
  kind: "boolean";
  question: string;
}

export type HumanInputRequest = HumanSpeechInputRequest | HumanTargetInputRequest | HumanBooleanInputRequest;
export type HumanInputRequestPayload =
  | Omit<HumanSpeechInputRequest, "id">
  | Omit<HumanTargetInputRequest, "id">
  | Omit<HumanBooleanInputRequest, "id">;

export interface HumanInputResponse {
  speech?: string;
  targetId?: string | null;
  reason?: string;
  decision?: boolean;
}

export interface HumanInputHandler {
  request(input: HumanInputRequestPayload): Promise<HumanInputResponse>;
}

export interface VoteRecord {
  voterId: string;
  targetId: string;
  reason?: string;
}
