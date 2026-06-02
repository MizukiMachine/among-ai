import { defaultLanguage, isJapaneseLanguage, roleLabel } from "./i18n";
import type { Persona, Player } from "./types";

export const DEFAULT_WEREWOLF_ALIGNMENT_SPEECH = "昼は人間側として合わせます";

type AlignmentSpeaker = Pick<Player, "name" | "role" | "persona" | "characterProfile">;

const japaneseCharacterAlignmentLines: Record<string, (role: string) => string> = {
  シオン: (role) => `僕は${role}ですね。昼は人間側として慎重に合わせ、崩れない発言を置きます`,
  ガク: (role) => `俺は${role}だ。昼は人間側として強く出る、流れはそこで動かす`,
  アカネ: (role) => `私は${role}です。昼は人間側として発言し、事実と推測を分けて動きます`,
  マヒロ: (role) => `俺は${role}かな。昼は人間側っぽく自然に乗って、流れが固まる前に動く`,
  ナギサ: (role) => `私は${role}だよね。昼は人間側として柔らかく合わせて、話しやすい空気を作る`,
  シュウヘイ: (role) => `俺は${role}。昼は人間側で通す。余計なことは言わない`,
  キリエ: (role) => `私は${role}ですね。昼は人間側として振る舞い、主張の出方を確認します`,
  リクト: (role) => `俺は${role}だ。昼は人間側として堂々と行こう、票を折らせない`,
  イオリ: (role) => `僕は${role}。昼は人間側の顔で揺らして、反応を見るよ。冗談だけど本気`,
  サクラコ: (role) => `私は${role}です。昼は人間側として立ち、曖昧な人を詰めます`,
  リンタロウ: (role) => `僕は${role}です。昼は人間側として、役職を守る形で発言したいです`,
  コハル: (role) => `私は${role}だね。昼は人間側として自然に話して、反応の温度を拾ってみる`,
  セナ: (role) => `俺は${role}。昼は人間側の顔で、票が集まりやすい位置に置くのが得でしょ`,
  ノゾミ: (role) => `私は${role}です。昼は人間側として振る舞い、票の差分を見える形で残します`,
  アキオミ: (role) => `俺は${role}だ。昼は人間側として信じられる顔で行く、そこに賭ける`
};

const englishPersonaAlignmentLines: Record<Persona, (name: string, role: string) => string> = {
  cautious: (name, role) => `I'm ${name}, the ${role}. I'll pass as human-side and keep the story consistent`,
  aggressive: (name, role) => `I'm ${name}, the ${role}. I'll push like a villager and force the table to move`,
  logical: (name, role) => `I'm ${name}, the ${role}. I'll act human-side and keep the public logic clean`,
  opportunistic: (name, role) => `I'm ${name}, the ${role}. I'll look human-side and move where the votes can land`,
  empathetic: (name, role) => `I'm ${name}, the ${role}. I'll sound human-side and keep people talking`,
  trickster: (name, role) => `I'm ${name}, the ${role}. I'll wear the human-side face and stir reactions`,
  stoic: (name, role) => `I'm ${name}, the ${role}. I'll pass as human-side and say only what helps`,
  passionate: (name, role) => `I'm ${name}, the ${role}. I'll sell the human-side act with conviction`
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
  return englishPersonaAlignmentLines[player.persona]?.(player.name, role) ?? `I'm ${player.name}, the ${role}. I'll act human-side`;
}
