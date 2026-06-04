import { defaultLanguage, isJapaneseLanguage } from "./i18n";
import type { Player } from "./types";

type LoverFaceoffSpeaker = Pick<Player, "name" | "characterProfile">;
type LoverFaceoffLineSet = readonly [string, string];

const japaneseCharacterLoverFaceoffLines: Record<string, (partnerName: string) => LoverFaceoffLineSet> = {
  シオン: (partnerName) => [
    `僕は恋人ですね。相方は${partnerName}さん、昼は距離を保って残ります`,
    `${partnerName}さんが相方ですね。無理にかばわず、二人で最後まで残りましょう`
  ],
  ガク: (partnerName) => [
    `俺は恋人だ。相方は${partnerName}、昼は露骨に寄らずに残る`,
    `${partnerName}が相方だな。かばいすぎず、票の流れだけは見ておく`
  ],
  アカネ: (partnerName) => [
    `私は恋人です。相方は${partnerName}さん、表では冷静に距離を取ります`,
    `${partnerName}さんが相方ですね。二人生存を最優先に、目立ちすぎず動きます`
  ],
  マヒロ: (partnerName) => [
    `俺は恋人かな。相方は${partnerName}、自然に混ざって二人で残ろう`,
    `${partnerName}が相方だね。昼は軽く合わせつつ、怪しまれない距離で行くよ`
  ],
  ナギサ: (partnerName) => [
    `私は恋人だよね。相方は${partnerName}さん、安心させすぎず自然に残るよ`,
    `${partnerName}さんが相方だね。かばう時も柔らかく、二人で生き残ろう`
  ],
  シュウヘイ: (partnerName) => [
    `俺は恋人。相方は${partnerName}。余計な熱は出さず、静かに残る`,
    `${partnerName}が相方。表では近づきすぎない。必要な時だけ合わせる`
  ],
  キリエ: (partnerName) => [
    `私は恋人ですね。相方は${partnerName}さん、公開の場では慎重に距離を取ります`,
    `${partnerName}さんが相方です。監査役の顔を崩さず、二人生存を狙います`
  ],
  リクト: (partnerName) => [
    `俺は恋人だ。相方は${partnerName}、熱くなりすぎず二人で残る`,
    `${partnerName}が相方だな。守る時も自然に、最後まで一緒に行く`
  ],
  イオリ: (partnerName) => [
    `僕は恋人。相方は${partnerName}だね。冗談っぽく距離を取って残るよ`,
    `${partnerName}が相方だね。軽く合わせて、関係が見えないようにする`
  ],
  サクラコ: (partnerName) => [
    `私は恋人です。相方は${partnerName}さん、厳しさを崩さず二人生存を詰めます`,
    `${partnerName}さんが相方です。表では冷静に、守りすぎない距離で動きます`
  ],
  リンタロウ: (partnerName) => [
    `僕は恋人です。相方は${partnerName}さん、守る言葉は出しすぎず残ります`,
    `${partnerName}さんが相方ですね。慎重に発言して、二人の位置を守ります`
  ],
  コハル: (partnerName) => [
    `私は恋人だね。相方は${partnerName}、明るく混ざって二人で残ろう`,
    `${partnerName}が相方だね。近づきすぎず、自然に味方でいるよ`
  ],
  セナ: (partnerName) => [
    `俺は恋人。相方は${partnerName}、得な位置を見ながら二人で残る`,
    `${partnerName}が相方か。表では距離を取る、票だけはちゃんと見る`
  ],
  ノゾミ: (partnerName) => [
    `私は恋人です。相方は${partnerName}さん、票の差分を見て静かに残ります`,
    `${partnerName}さんが相方です。淡々と整理して、二人生存の筋を残します`
  ],
  アキオミ: (partnerName) => [
    `俺は恋人だ。相方は${partnerName}、かばいすぎず最後まで一緒に残る`,
    `${partnerName}が相方だな。まっすぐ行くが、二人の生存を優先するぞ`
  ]
};

function fallbackLoverFaceoffLines(name: string, partnerName: string, language: string): LoverFaceoffLineSet {
  if (!isJapaneseLanguage(language)) {
    return [
      `I'm ${name}, a Lover. ${partnerName} is my partner, so I'll keep distance in public`,
      `${partnerName} is my partner. I'll avoid obvious defense and keep us both alive`
    ];
  }
  return [
    `${name}、恋人です。相方は${partnerName}さん、昼は自然に距離を取ります`,
    `${partnerName}さんが相方です。かばいすぎず、二人で生き残ります`
  ];
}

export function loverFaceoffLineOptionsForPlayer(
  player: LoverFaceoffSpeaker,
  partner: Pick<Player, "name">,
  language = defaultLanguage
): LoverFaceoffLineSet {
  const characterName = player.characterProfile?.nameJa ?? player.name;
  return japaneseCharacterLoverFaceoffLines[characterName]?.(partner.name) ?? fallbackLoverFaceoffLines(player.name, partner.name, language);
}
