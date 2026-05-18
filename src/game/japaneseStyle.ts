import { isJapaneseLanguage } from "./i18n";
import { promptMaterials } from "./prompts/materials";

// Output-only audit list; prompts may mention these terms as examples of wording to avoid.
export const awkwardJapaneseOutputTerms = ["位置", "盤面", "処理枠", "処理", "圧", "落とす", "落として", "陣営の軸"];

// Simplified Chinese characters and word patterns that should never appear in Japanese output.
// These are common Chinese-only vocabulary items that LLMs occasionally mix into Japanese text.
const chineseVocabularyPatterns: RegExp[] = [
  /观望/,    // watch/observe (Chinese) - should be 様子を見る/傍観
  /确实/,    // indeed (Chinese)
  /应该/,    // should (Chinese)
  /觉得/,    // feel/think (Chinese)
  /知道/,    // know (Chinese)
  /认为/,    // think/consider (Chinese)
  /可能/,    // maybe (Chinese)
  /但是/,    // but (Chinese)
  /因为/,    // because (Chinese)
  /所以/,    // therefore (Chinese)
  /这个/,    // this (Chinese)
  /那个/,    // that (Chinese)
  /什么/,    // what (Chinese)
  /怎么/,    // how (Chinese)
  /已经/,    // already (Chinese)
  /可以/,    // can (Chinese)
  /需要/,    // need (Chinese)
  /没有/,    // not have (Chinese)
  /我们/,    // we (Chinese)
  /他们/,    // they (Chinese)
  /自己/,    // oneself (Chinese)
  /如果/,    // if (Chinese)
  /虽然/,    // although (Chinese)
  /或者/,    // or (Chinese)
  /还是/,    // still/or (Chinese)
  /然后/,    // then (Chinese)
  /非常/,    // very (Chinese)
  /其实/,    // actually (Chinese)
  /比较/,    // relatively (Chinese)
  /感觉/,    // feel (Chinese)
  /选择/,    // choose (Chinese)
  /作为/,    // as (Chinese)
  /为了/,    // in order to (Chinese)
  /关于/,    // about (Chinese)
  /通过/,    // through (Chinese)
  /进行/,    // conduct (Chinese)
  /分析/,    // analyze (Chinese)
  /表现/,    // perform/show (Chinese)
  /逻辑/,    // logic (Chinese)
  /视角/,    // perspective (Chinese)
  /情况/,    // situation (Chinese)
  /发言者/,  // speaker (Chinese)
  /明显/,    // obvious (Chinese)
  /明显地/,  // obviously (Chinese)
  /目前/,    // currently (Chinese)
  /似乎/,    // seems (Chinese)
  /看起来/,  // looks like (Chinese)
  /问题/,    // problem (Chinese)
  /来说/,    // for (Chinese)
  /的话/,    // if (Chinese)
  /大家/,    // everyone (Chinese)
  /相信/,    // believe (Chinese)
  /怀疑/,    // suspect (Chinese)
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

  const [heading, ...guidelines] = promptMaterials.languageStyles.japanese.systemStyleGuide;
  return [heading, ...guidelines.map((line) => `- ${line}`)];
}

// Keep this scoped to deterministic demo copy. LLM output should be steered by prompts, not broad post-processing.
export function sanitizeDemoJapaneseGameText(text: string, language: string): string {
  if (!isJapaneseLanguage(language)) {
    return text;
  }

  return demoOutputReplacements.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}
