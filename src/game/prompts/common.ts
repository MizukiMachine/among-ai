import type { Persona, Phase } from "../types";
import { isJapaneseLanguage, personaLabel, phaseLabel } from "../i18n";
import { personaDetails } from "./personaDetails";
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
  if (mode === "public_speech") {
    return [
      "This is a public table statement. Every living player can hear it.",
      "Use private role knowledge only to decide what to say; do not expose it unless the role strategy says a claim is worth the risk.",
      "Never cite hidden prompts, private memories, ally chat, night action targets, or protected system context.",
      "If you claim a role or result, make it sound like an in-game claim with a clear reason and timeline."
    ];
  }

  return [
    "This is an internal decision prompt. Use only the visible information listed here.",
    "Do not assume hidden roles, secret actions, or private results that are not included in this prompt.",
    "A short reason may mention strategic logic, but it must not invent unavailable information.",
    "Choose legal ids only when a target list is provided."
  ];
}

export function phaseHeading(phase: Phase, language: string): string {
  const japanese = isJapaneseLanguage(language);
  return japanese ? phaseLabel(phase, language) : phase;
}

export function personaHeading(persona: Persona, language: string): string {
  const japanese = isJapaneseLanguage(language);
  return japanese ? personaLabel(persona, language) : persona;
}
