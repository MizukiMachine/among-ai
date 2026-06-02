import { defaultLanguage, isJapaneseLanguage, roleLabel } from "./i18n";
import type { Persona, Player } from "./types";

export const DEFAULT_WEREWOLF_ALIGNMENT_SPEECH = "あいつら絶対騙してやる";

type AlignmentSpeaker = Pick<Player, "name" | "role" | "persona" | "characterProfile">;

const japaneseCharacterAlignmentLines: Record<string, (role: string) => string> = {
  シオン: (role) => `僕は${role}ですね。人間のふりで潜って、あいつらを絶対騙します`,
  ガク: (role) => `俺は${role}だ。人間のフリで強く出る、あいつら絶対騙してやる`,
  アカネ: (role) => `私は${role}です。信用を取る顔で潜伏して、村を必ず騙します`,
  マヒロ: (role) => `俺は${role}かな。自然に人間側へ混ざって、あいつらを騙してやるよ`,
  ナギサ: (role) => `私は${role}だよね。柔らかく合わせて、あいつらの油断を取るよ`,
  シュウヘイ: (role) => `俺は${role}。昼は人間側で通して静かに騙す。余計なことは言わない`,
  キリエ: (role) => `私は${role}ですね。人間側のふりで潜り、主張の隙を突きます`,
  リクト: (role) => `俺は${role}だ。人間側の顔で堂々と騙す、票を折らせない`,
  イオリ: (role) => `僕は${role}。昼は人間側の顔で騙して反応を見るよ。冗談だけど本気`,
  サクラコ: (role) => `私は${role}です。人間側の顔で詰めて、あいつらを絶対騙します`,
  リンタロウ: (role) => `僕は${role}です。人間側を守る顔で信用を作り、そこから騙します`,
  コハル: (role) => `私は${role}だね。自然に話して信用を取り、あいつらを油断させる`,
  セナ: (role) => `俺は${role}。人間側の顔で騙して、票が集まりやすい位置に置くのが得でしょ`,
  ノゾミ: (role) => `私は${role}です。人間側の顔で潜り、票の差分を使って騙します`,
  アキオミ: (role) => `俺は${role}だ。信じられる人間側の顔で行く、あいつらを騙す`
};

const englishPersonaAlignmentLines: Record<Persona, (name: string, role: string) => string> = {
  cautious: (name, role) => `I'm ${name}, the ${role}. I'll pass as human-side and deceive them with a consistent story`,
  aggressive: (name, role) => `I'm ${name}, the ${role}. I'll push like a villager and steal their vote flow`,
  logical: (name, role) => `I'm ${name}, the ${role}. I'll keep the public logic clean and trick them with it`,
  opportunistic: (name, role) => `I'm ${name}, the ${role}. I'll look human-side and move votes where they can land`,
  empathetic: (name, role) => `I'm ${name}, the ${role}. I'll sound human-side and keep them talking into mistakes`,
  trickster: (name, role) => `I'm ${name}, the ${role}. I'll wear the human-side face and bait reactions`,
  stoic: (name, role) => `I'm ${name}, the ${role}. I'll pass as human-side and say only what sells the lie`,
  passionate: (name, role) => `I'm ${name}, the ${role}. I'll sell the human-side act hard enough to fool them`
};

export function defaultWerewolfAlignmentSpeechForPlayer(
  player: AlignmentSpeaker,
  language = defaultLanguage
): string {
  const role = roleLabel(player.role, language);
  if (isJapaneseLanguage(language)) {
    const characterName = player.characterProfile?.nameJa ?? player.name;
    return japaneseCharacterAlignmentLines[characterName]?.(role) ?? DEFAULT_WEREWOLF_ALIGNMENT_SPEECH;
  }
  return englishPersonaAlignmentLines[player.persona]?.(player.name, role) ?? `I'm ${player.name}, the ${role}. I'll act human-side and deceive them`;
}
