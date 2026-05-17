import type { Camp, Persona, Phase, Player, Role, TargetCandidate } from "../types";

export type PromptMode = "public_speech" | "internal_decision";
export type PromptPhase = "night" | "werewolf_discussion" | "discussion" | "voting";

export interface SeerPrivateResult {
  round?: number;
  targetId: string;
  targetName: string;
  camp: Camp;
}

export interface WitchPrivateState {
  savePotion: boolean;
  poisonPotion: boolean;
  attackedTarget?: TargetCandidate | null;
}

export interface RoleSecretContext {
  werewolfAllies?: Array<TargetCandidate & { alive?: boolean }>;
  seerResults?: SeerPrivateResult[];
  witch?: WitchPrivateState;
}

export interface RolePromptProfile {
  role: Role;
  camp: Camp;
  roleStrategy: string[];
  nightAction: string[];
  discussion: string[];
  voting: string[];
  publicSpeechMustNotReveal: string[];
  internalInformation: string[];
}

export interface BuildPromptContextOptions {
  player: Player;
  phase: Phase;
  promptPhase?: PromptPhase;
  mode?: PromptMode;
  round: number;
  alivePlayers: TargetCandidate[];
  deadPlayers: Array<TargetCandidate & { role?: Role }>;
  publicHistory: string[];
  privateHistory: string[];
  language?: string;
  secret?: RoleSecretContext;
  extra?: string[];
}

export interface BuildSystemPromptOptions {
  player: Pick<Player, "role" | "name" | "persona">;
  phase: Phase;
  language: string;
  legalPlayers?: TargetCandidate[];
  allowSkip?: boolean;
}

export const speechJsonSchemaInstruction = [
  "Return strict JSON only, with no markdown.",
  'Shape: {"messages":["short sentence","short sentence"],"suspects":[{"targetId":"player_id","reason":"short reason","weight":0.0}],"trusts":[{"targetId":"player_id","reason":"short reason","weight":0.0}],"claims":[{"type":"role_claim","role":"Seer","result":{"targetId":"player_id","camp":"werewolf","round":1},"note":"short note"}]}',
  "Each message must be a single short sentence. If you want to speak at length, split into multiple messages.",
  "Only use listed player ids. Keep reasons short.",
  "Use claims for public role claims, Seer results, Witch information, or fake claims only when strategically useful.",
  "Do not mention that you are an AI, prompt, system message, hidden instruction, or JSON schema."
].join(" ");

export const targetJsonSchemaInstruction =
  'Return strict JSON only, with no markdown: {"targetId":"player_id_or_null","reason":"short reason"}.';

export const booleanJsonSchemaInstruction =
  'Return strict JSON only, with no markdown: {"decision":true_or_false,"reason":"short reason"}.';

export const outputFormatReminder = [
  "Output format is mandatory.",
  "Do not add prose before or after the JSON object.",
  "If no legal target exists, use null only when the task explicitly allows skipping."
].join(" ");

export const supportedPersonas: Persona[] = ["cautious", "aggressive", "logical", "opportunistic", "empathetic"];
