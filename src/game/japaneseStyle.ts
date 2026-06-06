import { isJapaneseLanguage } from "./i18n";
import { promptMaterials } from "./prompts/materials";

const chineseVocabularyPatterns: RegExp[] = [
  /发言/u,
  /发言者/u,
  /观望/u,
  /确实/u,
  /应该/u,
  /觉得/u,
  /认为/u,
  /但是/u,
  /因为/u,
  /所以/u,
  /这个/u,
  /那个/u,
  /什么/u,
  /怎么/u,
  /已经/u,
  /可以/u,
  /没有/u,
  /我们/u,
  /他们/u,
  /如果/u,
  /虽然/u,
  /或者/u,
  /还是/u,
  /然后/u,
  /其实/u,
  /比较/u,
  /感觉/u,
  /选择/u,
  /作为/u,
  /为了/u,
  /关于/u,
  /通过/u,
  /进行/u,
  /表现/u,
  /逻辑/u,
  /视角/u,
  /情况/u,
  /明显/u,
  /似乎/u,
  /看起来/u,
  /来说/u,
  /的话/u,
  /相信/u,
  /怀疑/u
];

const simplifiedChineseCharacters = /[发观确该觉认这们说问题对实过还选择辑视况]/u;
const internalPlayerIdToken = /\bp\d+\b/iu;

export function containsChineseVocabulary(text: string): boolean {
  return chineseVocabularyPatterns.some((pattern) => pattern.test(text)) || simplifiedChineseCharacters.test(text);
}

export function containsInternalPlayerIdToken(text: string): boolean {
  return internalPlayerIdToken.test(text);
}

export function reviewJapaneseOutput(text: string, language: string): { ok: boolean; issues: string[] } {
  if (!isJapaneseLanguage(language)) {
    return { ok: true, issues: [] };
  }

  const issues: string[] = [];
  if (containsChineseVocabulary(text)) {
    issues.push("contains Chinese vocabulary or simplified Chinese characters");
  }
  if (containsInternalPlayerIdToken(text)) {
    issues.push("contains internal player id token");
  }

  return { ok: issues.length === 0, issues };
}

export function japaneseStyleGuide(language: string): string[] {
  if (!isJapaneseLanguage(language)) {
    return [];
  }

  const [heading, ...guidelines] = promptMaterials.languageStyles.japanese.systemStyleGuide;
  return [heading, ...guidelines.map((line) => `- ${line}`)];
}

export function stripJapaneseSpeechTerminalPeriod(text: string, language: string): string {
  if (!isJapaneseLanguage(language)) {
    return text;
  }

  return text.trimEnd().replace(/。+(?=」?$)/u, "");
}
