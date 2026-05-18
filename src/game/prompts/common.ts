import type { Persona, Phase } from "../types";
import { isJapaneseLanguage, personaLabel, phaseLabel } from "../i18n";
import { personaDetails } from "./personaDetails";
import { promptMaterials } from "./materials";
import type { PromptMode, PromptPhase } from "./schemas";

export const personaStrategies: Record<Persona, string[]> = Object.fromEntries(
  (Object.keys(personaDetails) as Persona[]).map((p) => [p, personaDetails[p].strategies])
) as Record<Persona, string[]>;

export function bulletList(lines: string[]): string {
  return lines.map((line) => `- ${line}`).join("\n");
}

export function formatPlayers(players: Array<{ id: string; name: string }>): string {
  return players.length > 0 ? players.map((player) => `${player.name} (${player.id})`).join(", ") : "none";
}

export function recentLines(lines: string[], count: number): string[] {
  return lines.slice(-count).map((line) => `- ${line}`);
}

export function promptPhaseFromGamePhase(phase: Phase): PromptPhase {
  if (phase === "werewolf_discussion") {
    return "werewolf_discussion";
  }
  if (phase === "day_discussion") {
    return "discussion";
  }
  if (phase === "voting") {
    return "voting";
  }
  return "night";
}

export function promptModeFromGamePhase(phase: Phase): PromptMode {
  return phase === "day_discussion" ? "public_speech" : "internal_decision";
}

export function commonBoundaryLines(mode: PromptMode): string[] {
  return promptMaterials.common.boundaryLines[mode];
}

export function phaseHeading(phase: Phase, language: string): string {
  const japanese = isJapaneseLanguage(language);
  return japanese ? phaseLabel(phase, language) : phase;
}

export function personaHeading(persona: Persona, language: string): string {
  const japanese = isJapaneseLanguage(language);
  return japanese ? personaLabel(persona, language) : persona;
}
