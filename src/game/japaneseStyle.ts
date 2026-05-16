import { isJapaneseLanguage } from "./i18n";

// Output-only audit list; prompts may mention these terms as examples of wording to avoid.
export const awkwardJapaneseOutputTerms = ["位置", "盤面", "処理枠", "処理", "圧", "落とす", "落として", "村の軸"];

const demoOutputReplacements: Array<[RegExp, string]> = [
  [/村の軸になりそうな位置を落として/g, "村をまとめそうな人を襲撃して"],
  [/村の軸になりそうな位置/g, "村をまとめそうな人"],
  [/村の軸/g, "村をまとめる人"],
  [/軸になりそうな位置/g, "中心になりそうな人"],
  [/発言力が伸びそうな位置/g, "発言力を持ちそうな人"],
  [/信用できる位置/g, "信用できる人"],
  [/守られて見える位置/g, "守られたように見える人"],
  [/処理枠/g, "投票先"],
  [/圧をかけたい/g, "理由を聞きたい"],
  [/圧をかける/g, "理由を聞く"],
  [/圧が強まった/g, "疑われ始めた"],
  [/圧が強い/g, "疑いが集まっている"],
  [/投票圧/g, "投票の流れ"],
  [/この盤面/g, "この状況"],
  [/盤面では/g, "状況では"],
  [/盤面です/g, "状況です"],
  [/盤面を/g, "状況を"],
  [/盤面の/g, "状況の"],
  [/候補を落として/g, "候補を襲撃して"],
  [/相手を落として/g, "相手を襲撃して"],
  [/人を落として/g, "人を襲撃して"],
  [/候補を落とす/g, "候補を襲撃する"],
  [/相手を落とす/g, "相手を襲撃する"],
  [/人を落とす/g, "人を襲撃する"]
];

export function japaneseStyleGuide(language: string): string[] {
  if (!isJapaneseLanguage(language)) {
    return [];
  }

  return [
    "日本語の話し方:",
    "- 翻訳調ではなく、配信で聞いて自然な短い会話にする。",
    "- プレイヤーを指す時は「位置」ではなく「人」「相手」「発言している人」を使う。",
    "- 「村の軸」ではなく「村をまとめそうな人」「議論を引っ張りそうな人」と言う。",
    "- 「圧をかける」ではなく「理由を聞く」「質問する」「疑いを向ける」と言う。",
    "- 「処理」「処理枠」ではなく「投票する」「吊る」「投票先」と言う。",
    "- 人狼の夜会話では「落とす」ではなく「襲撃する」「噛む」を使う。",
    "- 「盤面」は多用せず、「状況」「今の流れ」「今日の話」を使う。"
  ];
}

// Keep this scoped to deterministic demo copy. LLM output should be steered by prompts, not broad post-processing.
export function sanitizeDemoJapaneseGameText(text: string, language: string): string {
  if (!isJapaneseLanguage(language)) {
    return text;
  }

  return demoOutputReplacements.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}

export function containsAwkwardJapaneseOutputTerm(text: string): boolean {
  return awkwardJapaneseOutputTerms.some((term) => text.includes(term));
}
