import { isJapaneseLanguage } from "./i18n";
import { promptMaterials } from "./prompts/materials";
import type { Phase } from "./types";

export type DaySituation = "first_day" | "later_day" | "no_death" | "seer_claim" | "black_result" | "pre_vote";

export interface DaySituationInput {
  phase: Phase;
  round?: number;
  publicHistory?: string[];
  extra?: string[];
  context?: string;
  language?: string;
}

const situationOrder: DaySituation[] = ["first_day", "later_day", "no_death", "seer_claim", "black_result", "pre_vote"];

function visibleText(input: DaySituationInput): string {
  return [input.context, ...(input.publicHistory ?? []), ...(input.extra ?? [])].filter(Boolean).join("\n");
}

function taskSpecificContext(text: string | undefined): string {
  if (!text) {
    return "";
  }
  const marker = "Task-specific visible context:";
  const markerIndex = text.lastIndexOf(marker);
  return markerIndex >= 0 ? text.slice(markerIndex + marker.length) : text;
}

function currentRoundText(input: DaySituationInput): string {
  return [taskSpecificContext(input.context), ...(input.extra ?? [])].filter(Boolean).join("\n");
}

function roundFromText(text: string): number | null {
  const japanese = text.match(/ラウンド[:：]?\s*(\d+)|第(\d+)(?:昼|ラウンド)/);
  if (japanese) {
    return Number(japanese[1] ?? japanese[2]);
  }
  const english = text.match(/Round[: ]+(\d+)|Day (\d+)/i);
  if (english) {
    return Number(english[1] ?? english[2]);
  }
  return null;
}

export function detectDaySituations(input: DaySituationInput): DaySituation[] {
  if (input.phase !== "day_discussion" && input.phase !== "voting") {
    return [];
  }

  const text = visibleText(input);
  const round = input.round ?? roundFromText(text);
  const situations = new Set<DaySituation>();

  if (round === 1) {
    situations.add("first_day");
  } else if (round && round > 1) {
    situations.add("later_day");
  }

  const currentText = currentRoundText(input);
  if (
    /No one died last night|Night:\s*no deaths|no deaths/i.test(currentText) ||
    /昨夜は誰も死亡しませんでした|死亡者なし|死体なし/.test(currentText)
  ) {
    situations.add("no_death");
  }

  if (
    /\bclaims? Seer\b|\bclaiming Seer\b|\bSeer claim\b|\bI am Seer\b/i.test(text) ||
    /占い(?:師)?CO|占い師を主張|占い師として出|占い師を名乗|占い師です|占いです/.test(text)
  ) {
    situations.add("seer_claim");
  }

  if (/checked as werewolf|checked werewolf|reads as werewolf/i.test(text) || /人狼判定/.test(text)) {
    situations.add("black_result");
  }

  if (input.phase === "voting") {
    situations.add("pre_vote");
  }

  return situationOrder.filter((situation) => situations.has(situation));
}

export function daySituationGuidance(input: DaySituationInput): string[] {
  const situations = detectDaySituations(input);
  if (situations.length === 0) {
    return [];
  }

  const japanese = isJapaneseLanguage(input.language);
  const guidance = japanese ? promptMaterials.daySituations.ja : promptMaterials.daySituations.en;
  return [japanese ? "昼の状況別話法:" : "Day situation speaking guidance:", ...situations.flatMap((situation) => guidance[situation])];
}
