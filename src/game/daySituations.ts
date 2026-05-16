import { isJapaneseLanguage } from "./i18n";
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

const guidanceJa: Record<DaySituation, string[]> = {
  first_day: [
    "初日昼: 公開情報が少ないので強い断定を避ける。",
    "質問する、発言量を見る、誰が誰の疑いに乗ったかを見る、仮説として軽く疑う。",
    "黒確定のように言わず、「気になる」「理由を聞きたい」で止める。"
  ],
  later_day: [
    "2日目以降の昼: 昨日の投票、夜の結果、前日の疑い先の変化をつなげて話す。",
    "前日の発言から考えが変わった理由を一つ示し、新情報で読みを更新する。"
  ],
  no_death: [
    "死体なし後: 護衛成功、魔女の救済、襲撃先選びなどを断定せず、可能性を分ける。",
    "誰が守られた、誰が襲撃されたと決めつけず、発言の変化を見る。"
  ],
  seer_claim: [
    "占いCO後: CO者の結果履歴、COタイミング、対抗の有無、投票理由を確認する。",
    "真偽を即断せず、具体的な質問で詰める。"
  ],
  black_result: [
    "黒結果後: 黒を出された人の反応、占い師の履歴、吊るか保留するかの理由を話す。",
    "自分にしか見えない情報がある場合も、公開発言では公開根拠に言い換える。"
  ],
  pre_vote: [
    "投票直前: 新しい長い推理を増やさず、今日の発言、投票理由、CO結果から一つに絞る。",
    "投票理由は短く、明日検証できる形にする。"
  ]
};

const guidanceEn: Record<DaySituation, string[]> = {
  first_day: [
    "First day: public information is thin, so avoid hard certainty.",
    "Ask questions, compare speaking volume, watch who follows whose suspicion, and frame reads as light hypotheses.",
    'Prefer wording like "stands out" or "I want an answer" over treating anyone as confirmed.'
  ],
  later_day: [
    "Day two and later: connect yesterday's votes, the night result, and changes in earlier reads.",
    "Name one reason your view changed, then update the read with the new public information."
  ],
  no_death: [
    "After no night death: separate possible explanations such as protection, a save, or wolf target choice without declaring one certain.",
    "Do not assume who was protected or attacked; watch how players react to the missing death."
  ],
  seer_claim: [
    "After a Seer claim: examine the claim history, timing, counterclaims, and voting reasons.",
    "Do not instantly decide true or fake; ask concrete questions that test the claim."
  ],
  black_result: [
    "After a black result: discuss the accused player's reaction, the Seer's history, and the reason to eliminate or hold.",
    "If private information drives your read, translate it into public evidence unless you are intentionally claiming."
  ],
  pre_vote: [
    "Right before voting: do not introduce a long new theory; narrow the vote using today's statements, vote reasons, and claims.",
    "Keep the vote reason short and testable tomorrow."
  ]
};

export function daySituationGuidance(input: DaySituationInput): string[] {
  const situations = detectDaySituations(input);
  if (situations.length === 0) {
    return [];
  }

  const japanese = isJapaneseLanguage(input.language);
  const guidance = japanese ? guidanceJa : guidanceEn;
  return [japanese ? "昼の状況別話法:" : "Day situation speaking guidance:", ...situations.flatMap((situation) => guidance[situation])];
}
