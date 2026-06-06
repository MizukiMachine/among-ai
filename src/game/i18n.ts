import type { Persona, Phase, Role } from "./types";

export const defaultLanguage = "Japanese";

export function isJapaneseLanguage(language = defaultLanguage): boolean {
  return /japanese|日本語|ja\b/i.test(language);
}

const roleJa: Record<Role | "Hidden", string> = {
  Werewolf: "人狼",
  AlphaWolf: "α人狼",
  WolfBeauty: "美女狼",
  Seer: "占い師",
  Witch: "魔女",
  Guard: "騎士",
  Hunter: "ハンター",
  Trapper: "罠師",
  Idiot: "愚者",
  Elder: "長老",
  Lover: "恋人",
  Jester: "道化師",
  Villager: "人間",
  Hidden: "不明"
};

const personaJa: Record<Persona, string> = {
  cautious: "慎重",
  aggressive: "強気",
  logical: "論理派",
  opportunistic: "機を見る",
  empathetic: "共感型",
  trickster: "攪乱",
  stoic: "沈黙",
  passionate: "熱血"
};

const phaseJa: Record<Phase, string> = {
  setup: "準備",
  night: "夜",
  werewolf_discussion: "人狼相談",
  lover_discussion: "恋人相談",
  guard_action: "護衛",
  seer_action: "占い",
  witch_action: "魔女",
  day_discussion: "昼議論",
  voting: "投票",
  ended: "終了"
};

const phaseEn: Record<Phase, string> = {
  setup: "Setup",
  night: "Night",
  werewolf_discussion: "Wolf talk",
  lover_discussion: "Lover talk",
  guard_action: "Guard",
  seer_action: "Seer",
  witch_action: "Witch",
  day_discussion: "Discussion",
  voting: "Voting",
  ended: "Ended"
};

export function roleLabel(role: string | undefined, language = defaultLanguage): string {
  if (!role) {
    return isJapaneseLanguage(language) ? "不明" : "Unknown";
  }
  if (isJapaneseLanguage(language) && (role === "Hidden" || role in roleJa)) {
    return roleJa[role as Role | "Hidden"];
  }
  return role;
}

export function campLabel(camp: string | null | undefined, language = defaultLanguage): string {
  if (!camp) {
    return "-";
  }
  if (!isJapaneseLanguage(language)) {
    return camp;
  }
  if (camp === "werewolf") {
    return "狼陣営";
  }
  if (camp === "village") {
    return "人間側";
  }
  if (camp === "hidden") {
    return "非公開";
  }
  if (camp === "lover") {
    return "恋人陣営";
  }
  if (camp === "neutral") {
    return "中立";
  }
  return camp;
}

export function personaLabel(persona: Persona | string | undefined, language = defaultLanguage): string {
  if (!persona) {
    return isJapaneseLanguage(language) ? "不明" : "Unknown";
  }
  return isJapaneseLanguage(language) && persona in personaJa ? personaJa[persona as Persona] : persona;
}

export function phaseLabel(phase: Phase, language = defaultLanguage): string {
  return isJapaneseLanguage(language) ? phaseJa[phase] : phaseEn[phase];
}
