import type { Camp, Persona, Phase, Player, PublicSpeechPlan, Role, TargetCandidate } from "../types";
import { promptMaterials } from "./materials";

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
  loverPartner?: TargetCandidate & { alive?: boolean };
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
  publicSpeechGuidanceJa: string[];
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
  speechPlan?: PublicSpeechPlan;
  extra?: string[];
}

export interface BuildSystemPromptOptions {
  player: Pick<Player, "role" | "name" | "persona">;
  phase: Phase;
  language: string;
  legalPlayers?: TargetCandidate[];
  allowSkip?: boolean;
}

export const speechJsonSchemaInstruction = promptMaterials.outputFormats.speechJson.instruction;

export const targetJsonSchemaInstruction = promptMaterials.outputFormats.targetJson.instruction;

export const booleanJsonSchemaInstruction = promptMaterials.outputFormats.booleanJson.instruction;

export const outputFormatReminder = promptMaterials.outputFormats.reminder;

export const supportedPersonas: Persona[] = [
  "cautious",
  "aggressive",
  "logical",
  "opportunistic",
  "empathetic",
  "trickster",
  "stoic",
  "passionate"
];
