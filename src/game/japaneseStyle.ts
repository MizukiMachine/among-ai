import { isJapaneseLanguage } from "./i18n";
import { promptMaterials } from "./prompts/materials";

// Output-only audit list; prompts may mention these terms as examples of wording to avoid.
export const awkwardJapaneseOutputTerms = [
  "位置",
  "盤面",
  "処理枠",
  "処理",
  "圧",
  "落とす",
  "落として",
  "陣営の軸",
  "煙幕"
];

// Chinese-specific word patterns that should never appear in Japanese output.
// Only includes patterns using simplified Chinese characters (简体字) that have
// distinct Japanese equivalents, or Chinese-exclusive compound words.
// Words that are identical in both Japanese and Chinese (e.g. 可能, 分析, 自己, 非常)
// are intentionally excluded to avoid false positives.
const chineseVocabularyPatterns: RegExp[] = [
  /观望/,    // Chinese: 様子を見る/傍観
  /确实/,    // Chinese (简): 確実に
  /应该/,    // Chinese (简): ～すべき
  /觉得/,    // Chinese (简): ～と思う
  /认为/,    // Chinese (简): ～と考える
  /但是/,    // Chinese: しかし
  /因为/,    // Chinese: なぜなら
  /所以/,    // Chinese: だから
  /这个/,    // Chinese (简): この
  /那个/,    // Chinese (简): その/あの
  /什么/,    // Chinese (简): 何
  /怎么/,    // Chinese (简): どう
  /已经/,    // Chinese: もう/すでに
  /可以/,    // Chinese: できる
  /没有/,    // Chinese (简): ～がない
  /我们/,    // Chinese: 私たち
  /他们/,    // Chinese (简): 彼ら
  /如果/,    // Chinese: もし
  /虽然/,    // Chinese: けれども
  /或者/,    // Chinese: または
  /还是/,    // Chinese: ～それとも
  /然后/,    // Chinese: それから
  /其实/,    // Chinese: 実は
  /比较/,    // Chinese: 比較的
  /感觉/,    // Chinese (简): 感じる
  /选择/,    // Chinese (简): 選ぶ
  /作为/,    // Chinese: ～として
  /为了/,    // Chinese: ～のために
  /关于/,    // Chinese (简): ～について
  /通过/,    // Chinese (简): ～を通じて
  /进行/,    // Chinese (简): 行う
  /表现/,    // Chinese (简): 表れる
  /逻辑/,    // Chinese (简): 論理
  /视角/,    // Chinese (简): 視点
  /情况/,    // Chinese (简): 状況
  /发言者/,  // Chinese (简): 発言者
  /明显/,    // Chinese (简): 明らか
  /明显地/,  // Chinese (简): 明らかに
  /似乎/,    // Chinese: ～のようだ
  /看起来/,  // Chinese: ～に見える
  /来说/,    // Chinese: ～について言えば
  /的话/,    // Chinese: ～なら
  /相信/,    // Chinese: 信じる
  /怀疑/,    // Chinese (简): 疑う
];

export function containsChineseVocabulary(text: string): boolean {
  return chineseVocabularyPatterns.some((pattern) => pattern.test(text));
}

export function containsAwkwardJapaneseOutputTerm(text: string): boolean {
  return awkwardJapaneseOutputTerms.some((term) => text.includes(term));
}

export function reviewJapaneseOutput(text: string, language: string): { ok: boolean; issues: string[] } {
  if (!isJapaneseLanguage(language)) {
    return { ok: true, issues: [] };
  }

  const issues: string[] = [];

  if (containsChineseVocabulary(text)) {
    issues.push("contains Chinese vocabulary");
  }

  if (containsAwkwardJapaneseOutputTerm(text)) {
    issues.push("contains awkward game terminology");
  }

  return { ok: issues.length === 0, issues };
}

const demoOutputReplacements: Array<[RegExp, string]> = [
  [/陣営の軸になりそうな位置を落として/g, "議論をまとめそうな人を襲撃して"],
  [/陣営の軸になりそうな位置/g, "議論をまとめそうな人"],
  [/陣営の軸/g, "議論をまとめる人"],
  [/軸になりそうな位置/g, "中心になりそうな人"],
  [/発言力が伸びそうな位置/g, "発言力を持ちそうな人"],
  [/信用できる位置/g, "信用できる人"],
  [/守られて見える位置/g, "守られたように見える人"],
  [/処理枠/g, "投票先"],
  [/圧をかけたい/g, "疑いを向けたい"],
  [/圧をかける/g, "疑いを向ける"],
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

  const [heading, ...guidelines] = promptMaterials.languageStyles.japanese.systemStyleGuide;
  return [heading, ...guidelines.map((line) => `- ${line}`)];
}

export function japaneseDialogueContract(language: string): string[] {
  if (!isJapaneseLanguage(language)) {
    return [];
  }

  const [heading, ...guidelines] = promptMaterials.languageStyles.japanese.dialogueContract;
  return [heading, ...guidelines.map((line) => `- ${line}`)];
}

export function stripJapaneseSpeechTerminalPeriod(text: string, language: string): string {
  if (!isJapaneseLanguage(language)) {
    return text;
  }

  return text.trimEnd().replace(/。+(?=」?$)/u, "");
}

// Keep this scoped to deterministic demo copy. LLM output should be steered by prompts, not broad post-processing.
export function sanitizeDemoJapaneseGameText(text: string, language: string): string {
  if (!isJapaneseLanguage(language)) {
    return text;
  }

  return demoOutputReplacements.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}
