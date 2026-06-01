import { isJapaneseLanguage } from "./i18n";
import { promptMaterials } from "./prompts/materials";

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
