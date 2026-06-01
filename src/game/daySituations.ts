import { defaultLanguage, isJapaneseLanguage, roleLabel } from "./i18n";
import { promptMaterials } from "./prompts/materials";
import type { Phase, Role } from "./types";

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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const claimableRoles: Role[] = [
  "AlphaWolf",
  "WolfBeauty",
  "Werewolf",
  "Seer",
  "Witch",
  "Guard",
  "Hunter",
  "Raven",
  "Idiot",
  "Elder",
  "Lover",
  "Jester",
  "Villager"
];

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function japaneseRoleAliases(role: Role, language: string): string[] {
  const aliases: Record<Role, string[]> = {
    Werewolf: ["人狼"],
    AlphaWolf: ["α人狼", "アルファ人狼"],
    WolfBeauty: ["美女狼"],
    Seer: ["占い師", "占い"],
    Witch: ["魔女"],
    Guard: ["騎士", "狩人"],
    Hunter: ["ハンター"],
    Raven: ["鴉"],
    Idiot: ["愚者"],
    Elder: ["長老"],
    Lover: ["恋人"],
    Jester: ["道化師"],
    Villager: ["人間側", "村側", "村人", "人間"]
  };
  return unique([roleLabel(role, language), ...aliases[role]]).sort((left, right) => right.length - left.length);
}

function japaneseRolePattern(role: Role, language: string): string {
  return `(?:${japaneseRoleAliases(role, language).map(escapeRegExp).join("|")})`;
}

function speakerNamePattern(name: string): string {
  return `${escapeRegExp(name)}(?:さん|君|ちゃん)?`;
}

function lastSentenceBreakBefore(text: string, index: number): number {
  return Math.max(
    text.lastIndexOf("。", index - 1),
    text.lastIndexOf("！", index - 1),
    text.lastIndexOf("？", index - 1),
    text.lastIndexOf("!", index - 1),
    text.lastIndexOf("?", index - 1),
    text.lastIndexOf("\n", index - 1)
  );
}

function textBeforeCurrentClause(text: string, index: number): string {
  return text.slice(lastSentenceBreakBefore(text, index) + 1, index);
}

function japaneseOtherPlayerSubjectInPrefix(prefix: string, otherPlayerNames: string[]): boolean {
  return otherPlayerNames.some((name) =>
    new RegExp(`${speakerNamePattern(name)}\\s*(?:が|は|も|から|の|による)`, "u").test(prefix)
  );
}

function textHasJapaneseSpeakerRoleClaim(
  text: string,
  role: Role,
  language: string,
  speakerName?: string,
  otherPlayerNames: string[] = []
): boolean {
  const rolePattern = japaneseRolePattern(role, language);
  const selfSubjects = ["私", "僕", "俺", "自分", "こちら", ...(speakerName ? [speakerNamePattern(speakerName)] : [])].join("|");
  const roleModifier = "(?:本物の|真の|対抗の|唯一の)?";
  const openingLead = "(?:ここで|今日(?:は)?|今(?:は|から)?|この場で|必要なら|対抗で|強い主張が必要なら)?";
  const boundary = "(?=$|[\\s。！？!、,])";
  const explicitAction =
    "(?:CO(?:します|する|しました|した)?|を主張(?:します|する|しました|した)?|として(?:出(?:ます|る|ました|た)|名乗(?:ります|る|ました|った))?|を名乗(?:ります|る|りました|った|っています|っている)|です|だ)";
  const implicitAction = "(?:CO(?:します|する)?|を主張(?:します|する)?|として出(?:ます|る)|を名乗(?:ります|る)|です|だ)";
  const explicitSubjectClaim = new RegExp(
    `(?:${selfSubjects})(?:\\s*(?:は|が|も))?(?:\\s*[、,])?\\s*${openingLead}\\s*${roleModifier}${rolePattern}${explicitAction}${boundary}`,
    "u"
  );

  if (explicitSubjectClaim.test(text)) {
    return true;
  }

  const implicitClaim = new RegExp(`${roleModifier}${rolePattern}${implicitAction}${boundary}`, "gu");
  for (const match of text.matchAll(implicitClaim)) {
    const index = match.index ?? 0;
    if (!japaneseOtherPlayerSubjectInPrefix(textBeforeCurrentClause(text, index), otherPlayerNames)) {
      return true;
    }
  }

  return false;
}

function textHasEnglishSpeakerRoleClaim(text: string, role: Role, speakerName?: string): boolean {
  const rolePattern = escapeRegExp(role);
  const directSelfClaim = new RegExp(
    `\\b(?:I(?:\\s+am|'m)|my\\s+(?:role|claim)\\s+is)\\s+(?:the\\s+)?${rolePattern}\\b`,
    "iu"
  );
  const verbalSelfClaim = new RegExp(
    `\\bI\\s+(?:(?:am|'m)\\s+)?(?:claim|claiming|will\\s+claim)\\s+(?:to\\s+be\\s+)?(?:the\\s+)?${rolePattern}\\b`,
    "iu"
  );

  if (directSelfClaim.test(text) || verbalSelfClaim.test(text)) {
    return true;
  }

  if (!speakerName) {
    return false;
  }

  const speakerPattern = escapeRegExp(speakerName);
  return (
    new RegExp(`\\b${speakerPattern}\\s+(?:is|'s)\\s+(?:the\\s+)?${rolePattern}\\b`, "iu").test(text) ||
    new RegExp(
      `\\b${speakerPattern}\\s+(?:(?:is|'s)\\s+)?(?:claim|claims|claimed|claiming)\\s+(?:to\\s+be\\s+)?(?:the\\s+)?${rolePattern}\\b`,
      "iu"
    ).test(text)
  );
}

export function textHasSpeakerRoleClaimEvidence(
  text: string,
  role: Role,
  language: string = defaultLanguage,
  speakerName?: string,
  otherPlayerNames: string[] = []
): boolean {
  return isJapaneseLanguage(language)
    ? textHasJapaneseSpeakerRoleClaim(text, role, language, speakerName, otherPlayerNames)
    : textHasEnglishSpeakerRoleClaim(text, role, speakerName);
}

export function claimedRoleBySpeakerFromText(
  text: string,
  language: string = defaultLanguage,
  speakerName?: string,
  otherPlayerNames: string[] = []
): Role | undefined {
  return claimableRoles.find((role) => textHasSpeakerRoleClaimEvidence(text, role, language, speakerName, otherPlayerNames));
}

export function textHasSpeakerAnyRoleClaimEvidence(
  text: string,
  language: string = defaultLanguage,
  speakerName?: string,
  otherPlayerNames: string[] = []
): boolean {
  return Boolean(claimedRoleBySpeakerFromText(text, language, speakerName, otherPlayerNames));
}

export function textHasSeerClaimEvidence(text: string): boolean {
  return (
    /\b(?:I(?: am|'m) (?:the )?Seer|claims? (?:to be )?(?:the )?Seer|claiming (?:to be )?(?:the )?Seer|Seer claim(?:ed|s)?)\b/i.test(
      text
    ) ||
    /占い(?:師)?CO|占い師を主張|占い師として出(?:ます|る|た|ました|ている|ています)|(?:私|僕|俺|自分|こちら)(?:は|が)?占い師(?:です|だ|として)|(?:^|[\s:：])占い師(?:です|だ)(?:$|[\s。！？!、,])|占いです(?:$|[\s。！？!、,])|占い師を名乗(?:ります|りました|った|っている|っています)|占い(?:師)?主張/.test(
      text
    )
  );
}

export function textHasRoleClaimEvidence(text: string): boolean {
  const japaneseRoleClaim =
    /主張:\s*[^。\n]*が(?:占い師|魔女|騎士|狩人|ハンター|鴉|愚者|長老|恋人|道化師|人間|村人|人間側|村側)を主張|(?:占い師|魔女|騎士|狩人|ハンター|鴉|愚者|長老|恋人|道化師)(?:CO|を主張|として出(?:ます|る|た|ました|ている|ています)|を名乗(?:ります|りました|った|っている|っています))|(?:私|僕|俺|自分|こちら)(?:は|が)?(?:占い師|魔女|騎士|狩人|ハンター|鴉|愚者|長老|恋人|道化師)(?:です|だ|として|を名乗)/;
  const japaneseCampClaim =
    /(?:私|僕|俺|自分|こちら)(?:は|が)?(?:人間側|村側|村人)(?:です|だ|として|を名乗|を主張)|(?:人間側|村側|村人)(?:を主張|として動く|として村を守る)/;
  return (
    textHasSeerClaimEvidence(text) ||
    /\b(?:I(?: am|'m) (?:the )?(?:Witch|Guard|Hunter|Raven|Idiot|Elder|Lover|Jester|Villager)|claims? (?:to be )?(?:the )?(?:Witch|Guard|Hunter|Raven|Idiot|Elder|Lover|Jester|Villager)|role claim(?:ed|s)?)\b/i.test(
      text
    ) ||
    japaneseRoleClaim.test(text) ||
    japaneseCampClaim.test(text)
  );
}

export function textHasBlackResultEvidence(text: string): boolean {
  return /checked as werewolf|checked werewolf|reads as werewolf/i.test(text) || /人狼判定/.test(text);
}

export function textHasCampResultEvidence(text: string): boolean {
  return (
    textHasBlackResultEvidence(text) ||
    /checked as village|checked village|reads as village|white result|black result|wolf result|village result/i.test(text) ||
    /(?:人間側|人間|村側|村人|白|黒|狼|人狼)判定/.test(text)
  );
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
