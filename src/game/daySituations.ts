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

function publicClaimText(input: DaySituationInput): string {
  const publicHistory = input.publicHistory ?? [];
  if (publicHistory.length > 0) {
    return publicHistory.join("\n");
  }
  return taskSpecificContext(input.context);
}

export function textHasSeerClaimEvidence(text: string): boolean {
  return (
    /\b(?:I(?: am|'m) (?:the )?Seer|claims? (?:to be )?(?:the )?Seer|claiming (?:to be )?(?:the )?Seer|Seer claim(?:ed|s)?)\b/i.test(
      text
    ) ||
    /占い(?:師)?CO|占い師を主張|占い師として出(?:ます|る|た|ました|ている|ています)|(?:私|僕|俺|自分|こちら)(?:は|が)?占い師(?:です|だ|として)|(?:^|[\s:：])占い師(?:です|だ)(?:$|[\s。！？!、,])|占いです(?:$|[\s。！？!、,])|占い師を名乗(?:ります|りました|った|っている|っています|る人|る者)|占い(?:師)?主張/.test(
      text
    )
  );
}

export function textHasBlackResultEvidence(text: string): boolean {
  return /checked as werewolf|checked werewolf|reads as werewolf/i.test(text) || /人狼判定/.test(text);
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
  const japanese = text.match(/ラウンド[:：]?\s*(\d+)|第(\d+)(?:昼|ラウンド)|(\d+)日目の昼/);
  if (japanese) {
    return Number(japanese[1] ?? japanese[2] ?? japanese[3]);
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

  const claimText = publicClaimText(input);
  if (textHasSeerClaimEvidence(claimText)) {
    situations.add("seer_claim");
  }

  if (textHasBlackResultEvidence(claimText)) {
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
