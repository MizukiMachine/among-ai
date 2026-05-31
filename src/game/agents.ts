import Anthropic, { APIConnectionTimeoutError, APIError } from "@anthropic-ai/sdk";
import type { MessageParam, TextBlock } from "@anthropic-ai/sdk/resources/messages";
import { detectDaySituations, type DaySituation } from "./daySituations";
import { sanitizeDemoJapaneseGameText, stripJapaneseSpeechTerminalPeriod } from "./japaneseStyle";
import {
  buildTargetList,
  buildBooleanSystemPrompt,
  buildSpeechReasoningSystemPrompt,
  buildSpeechRealizationSystemPrompt,
  buildTargetSystemPrompt
} from "./prompts";
import { promptMaterials } from "./prompts/materials";
import { campLabel, defaultLanguage, isJapaneseLanguage, personaLabel, roleLabel } from "./i18n";
import { sample, weightedChance } from "./random";
import type {
  Agent,
  AgentBooleanInput,
  AgentSpeech,
  AgentSpeechInput,
  AgentTargetInput,
  Camp,
  ClaimMetadata,
  FirstDayOpeningMove,
  Persona,
  PlayerReadMetadata,
  ReadEvidenceKind,
  ReadEvidenceMetadata,
  Role,
  SpeechMetadata,
  TargetCandidate,
  TargetDecision
} from "./types";

const defaultLlmTimeoutMs = 120_000;
const defaultLlmMaxTokens = 384;
const targetDecisionMaxTokens = 160;
const booleanDecisionMaxTokens = 96;
// Day-1 warm-up self-intros are short and single-call (no reasoning stage).
const introMaxTokens = 140;
const defaultZaiBaseUrl = "https://api.z.ai/api/anthropic";
const defaultZaiModel = "glm-5-turbo";
const fixedLlmRequestConcurrency = 5;
const fixedLlmRequestMinIntervalMs = 0;
const llmRequestRetries = 3;
const llmRequestAttempts = llmRequestRetries + 1;
const initialLlmBackoffMs = 1_000;
const targetSelectionAttempts = 2;
const booleanDecisionAttempts = 2;
const maxSpeechMessages = 3;

const demoSpeechEn: Partial<Record<Role, string[]>> = {
  Werewolf: [
    "I do not like how quickly the suspicion moved without evidence. We should pressure the quiet players before committing.",
    "That claim feels convenient, especially after the night result. I am holding it as suspicious until the timeline fits.",
    "The safest vote is the player avoiding a clear stance. Wolves benefit when the village argues in circles."
  ],
  Seer: [
    "I have a result that changes how I read the table, so I am watching the statements that do not fit it.",
    "The voting pattern matters here. Someone is trying to make a weak case look inevitable.",
    "I am watching the players who immediately accepted the easiest explanation after nightfall."
  ],
  Witch: [
    "The lack of a clean night result matters. We should not assume the obvious story is true.",
    "I am more concerned by people pushing certainty than by people keeping a careful read.",
    "There is enough pressure on the table now that a rushed vote would help the wolves."
  ],
  Guard: [
    "The night outcome gives us information, but I do not want to overstate it before the claims are clear.",
    "If a claimed power role is real, the wolves have a reason to steer today around that pressure.",
    "We should separate who looked protected by the night result from who is actually trustworthy."
  ],
  Hunter: [
    "Before anyone pushes me as an easy vote, I want clear reasons on the record for who should be punished next.",
    "The table needs a ranked suspect list. A vague pile-on creates a dangerous death chain.",
    "I am watching who treats my slot as disposable without explaining the follow-up."
  ],
  Villager: [
    "I am reading by concrete benefit, not vibes. The player helped most by last night's outcome is suspicious.",
    "The contradiction is in the timing: the suspicion appeared only after a safer target was available.",
    "I am not convinced by a broad accusation. The read needs to connect to one changed statement."
  ]
};

const demoSpeechJa: Partial<Record<Role, string[]>> = {
  Werewolf: [
    "まだ根拠は薄いですが、発言の少ない人を暫定の投票候補に入れます。",
    "その主張は夜の結果を見てから出したように見えます。今は信用を保留します。",
    "明確な意見を避けている人に投票したいです。人間側が迷うほど人狼は動きやすくなります。"
  ],
  Seer: [
    "私には状況の見え方が変わる結果があります。今はその結果とずれる発言を疑っています。",
    "投票の流れが重要です。弱い根拠を既定路線に見せようとしている人がいます。",
    "夜明け後に一番簡単な説明へすぐ乗った人を見ています。"
  ],
  Witch: [
    "夜の結果が単純ではない点は大事です。見た目どおりの話だと決めつけない方がいいです。",
    "慎重に考えている人より、妙に断定して押している人を疑っています。",
    "今は疑いが十分に出ています。急いだ投票は人狼を助けます。"
  ],
  Guard: [
    "夜の結果から情報は出ていますが、主張が揃うまでは強く言い切りたくありません。",
    "本物の役職主張がいるなら、人狼は今日の議論をそこから逸らす理由があります。",
    "夜の結果で守られたように見える人と、本当に信用できる人は分けて考えるべきです。"
  ],
  Hunter: [
    "私を安易な投票先にする流れは怪しいです。次の疑い先まで見えない押し方だからです。",
    "今は疑い先を一人に絞るべきです。雑な便乗は危険です。",
    "私を雑に吊ろうとしている人が、次にどう進めるつもりなのか見ています。"
  ],
  Villager: [
    "雰囲気ではなく具体的な得で見ます。昨夜の結果で一番得をした人が怪しいです。",
    "矛盾しているのはタイミングです。投票しやすい相手が見えてから疑いが出ています。",
    "広い疑いだけでは納得できません。考えが急に変わった人を投票候補に入れます。"
  ]
};

function demoSpeechForRole(pool: Partial<Record<Role, string[]>>, role: Role): string[] {
  return pool[role] ?? (role === "AlphaWolf" || role === "WolfBeauty" ? pool.Werewolf : pool.Villager) ?? [];
}

const demoDaySituationSpeechEn: Record<DaySituation, string[]> = {
  first_day: [
    "It is too early to lock anyone in, but I am holding the quiet and follower slots as tentative vote candidates.",
    "With so little public information, I am starting from speaking volume and early stance instead of waiting for others.",
    "My read is only a hypothesis for now. The useful thing today is to see who gives reasons and who only follows along."
  ],
  later_day: [
    "Yesterday's vote matters more now. I want to compare who changed their read after the night result.",
    "We have enough history to connect votes, claims, and reactions instead of starting from scratch.",
    "My read changed because the night result and yesterday's vote do not point in the same direction."
  ],
  no_death: [
    "No one died last night, but I do not want to decide why too quickly. The reactions to that result matter.",
    "A missing death can come from several causes. I suspect the players treating one explanation as certain.",
    "The no-death result is useful, but only if we separate possibilities before voting."
  ],
  seer_claim: [
    "Before trusting the Seer claim, I am weighing the result order, timing, and reason for coming out now.",
    "The claim gives us something testable: the result history needs to line up with yesterday's votes.",
    "I am not deciding true or fake yet. I am holding the claim by timing and counterclaim risk."
  ],
  black_result: [
    "A black result is important, so the accused player's reaction is central before I treat it as settled.",
    "The result, the Seer's timing, and the accused reaction all need to line up before I vote.",
    "If we vote the black result today, I want a clear reason we can revisit tomorrow."
  ],
  pre_vote: [
    "At this point I want a short vote reason, not a new theory. Pick the read that is easiest to verify tomorrow.",
    "Before voting, I am narrowing to the claim and reaction that gave the table the clearest information.",
    "My vote should follow today's public reasons, so I am choosing the case that can be checked later."
  ]
};

const demoDaySituationSpeechJa: Record<DaySituation, string[]> = {
  first_day: [
    "初日は疑いを急がず、まず投票理由を残す進め方を合わせたいです。",
    "まだ情報が少ないので、占い師が名乗る条件と投票基準を先に決めたいです。",
    "今日は強く決めませんが、理由を出さずに流れに乗る人は後で見返します。"
  ],
  later_day: [
    "昨日の投票と夜の結果をつなげて見ます。考えを変えた人を今日の投票候補に入れます。",
    "ここからは昨日の発言も材料になります。疑い先が変わった人を重く見ます。",
    "前日の投票理由と今日の反応が合っているかを見ます。そこがずれている人が気になります。"
  ],
  no_death: [
    "死体なしの理由はまだ決めつけません。この結果を急いで固めた人を疑います。",
    "昨夜の死亡者がいないなら、説明はいくつかあります。一つに決めず、発言の変化を見ましょう。",
    "死体なしは大事ですが、誰が守られたかを断定する人は疑い寄りで見ます。"
  ],
  seer_claim: [
    "占い主張は結果の順番と出た理由で見ます。今は真偽を保留します。",
    "占い師を名乗る人の結果が昨日の投票と合うかを見ます。",
    "対抗がいるか、昨日の投票と結果が合うかを見てから判断したいです。"
  ],
  black_result: [
    "人狼判定は重いので、今日はその人を投票候補の中心に置きます。",
    "黒を出した人のこれまでの結果が自然なら、出された人を疑い寄りに置きます。",
    "今日その人を吊るなら、明日確認できる理由にしたいです。"
  ],
  pre_vote: [
    "投票直前なので、新しい話を広げず、今日一番理由が残っている人に絞ります。",
    "投票理由は短く出します。明日見返せるように、今日の発言から選びます。",
    "ここからは迷いを増やすより、公開された主張と反応で一人に決めたいです。"
  ]
};

const demoOpeningDaySituationSpeechEn = [
  "It is day one, so I am not locking anyone in. I am placing one early tentative read.",
  "I am not using anyone's statement as evidence yet. I will start with a light read of my own.",
  "With so little information, I want us to build a record of reasons first."
];

const demoOpeningDaySituationSpeechJa = [
  "初日なので決め打ちはしません。まず今日の進め方と投票理由の残し方を合わせたいです。",
  "まだ誰の発言も材料にしません。占い師が名乗る条件だけ先に決めたいです。",
  "今は情報が少ないので、理由を短く出して投票前に比べる形にしたいです。"
];

const personaReasonsEn: Record<AgentSpeechInput["player"]["persona"], string[]> = {
  cautious: [
    "their stance has been careful but not testable",
    "the risk profile around their claim is unclear",
    "they avoided giving a firm read when pressure rose"
  ],
  aggressive: [
    "they need direct pressure after a weak defense",
    "their push looks forced and timed for a misvote",
    "they are steering the table without enough evidence"
  ],
  logical: [
    "their vote does not match their stated suspicion",
    "their timeline conflicts with the public claims",
    "the incentives point to them benefiting from confusion"
  ],
  opportunistic: [
    "their position is the easiest one for a wolf to exploit",
    "their claim gives the table leverage if tested",
    "their late movement creates a useful pressure point"
  ],
  empathetic: [
    "their reaction became defensive when pressed for details",
    "their tone changed after the night result",
    "they are not engaging with the concerns aimed at them"
  ],
  trickster: [
    "just to see how they react",
    "because predictable players are suspicious",
    "the chaos reveals the truth"
  ],
  stoic: [
    "based on what was not said",
    "the silence speaks volumes",
    "observation over conversation"
  ],
  passionate: [
    "because I believe in this team",
    "my gut tells me so",
    "I can feel it in my heart"
  ]
};

const personaReasonsJa: Record<AgentSpeechInput["player"]["persona"], string[]> = {
  cautious: [
    "立場が慎重すぎて検証しにくい",
    "その主張まわりのリスクがまだ整理できていない",
    "疑われ始めた時に明確な考えを避けた"
  ],
  aggressive: [
    "弱い弁明の後なので疑いを強めたい",
    "その押し方は誤投票を作るために無理をしているように見える",
    "十分な根拠なしに議論を誘導している"
  ],
  logical: [
    "投票した相手と発言で疑っている相手が一致していない",
    "時系列が公開情報と噛み合っていない",
    "混乱で得をする人に見える"
  ],
  opportunistic: [
    "人狼が利用しやすい一番楽な立場を取っている",
    "その主張は確かめれば手がかりになる",
    "終盤の動きが投票材料になる"
  ],
  empathetic: [
    "詳細を聞かれた時に防御的になった",
    "夜の結果後に反応が変わった",
    "向けられた懸念に向き合っていない"
  ],
  trickster: [
    "反応を見たかっただけ",
    "予測可能な人こそ怪しい",
    "カオスの中に真実がある"
  ],
  stoic: [
    "言わなかったことに基づいて",
    "沈黙が語るものがある",
    "観察こそが武器"
  ],
  passionate: [
    "このチームを信じてるから",
    "直感がそう言ってる",
    "心が感じてるんだ"
  ]
};

const firstDayReasonsEn: Record<AgentSpeechInput["player"]["persona"], string[]> = {
  cautious: [
    "their early stance is careful, so I am holding them as difficult to verify",
    "they have spoken less than others and should leave a clearer read",
    "whose suspicion they are following is still unclear"
  ],
  aggressive: [
    "their first stance did not give enough reasoning",
    "they followed the easiest line without adding their own view",
    "they are avoiding a clear stance of their own"
  ],
  logical: [
    "their first-day reasoning is still hard to compare",
    "their stated concern does not yet connect to a clear read",
    "their reaction is useful to test before the vote"
  ],
  opportunistic: [
    "they are taking a flexible early stance that needs a reason",
    "their timing makes them a useful first vote candidate",
    "they are following the discussion without shaping it"
  ],
  empathetic: [
    "their tone changed when pressed for details",
    "they have not addressed the concern aimed at them yet",
    "I am holding them lightly before reading them too strongly"
  ],
  trickster: [
    "their seriousness feels like a mask",
    "their safe reaction is more interesting than it looks",
    "everyone is playing it safe and that is boring"
  ],
  stoic: [
    "their silence on day one is data",
    "they said nothing when they could have",
    "I am watching who avoids eye contact"
  ],
  passionate: [
    "I want to believe them but need to see conviction",
    "their energy feels real but energy can be faked",
    "my heart says trust them but let me verify"
  ]
};

const firstDayReasonsJa: Record<AgentSpeechInput["player"]["persona"], string[]> = {
  cautious: [
    "発言が少ないので、暫定で保留寄りに見ている",
    "慎重な立場が続いていて、投票前に判断しにくい",
    "誰の疑いに乗っているのかが曖昧に見える"
  ],
  aggressive: [
    "最初の返答に理由が少ないので、投票候補に入れる",
    "楽な流れに乗っただけに見える",
    "自分の見方を出さない姿勢が怪しい"
  ],
  logical: [
    "初日の理由としてまだ比べにくい",
    "疑い先と理由がまだつながっていない",
    "投票前に一度疑い寄りで置いておきたい"
  ],
  opportunistic: [
    "初日の立場が広すぎるので疑い寄りで見る",
    "話に乗るタイミングが都合よく見える",
    "議論についてきているが、自分の見方がまだ薄い"
  ],
  empathetic: [
    "詳細に触れられた時の反応が防御的に見える",
    "向けられた疑いにまだ答えきっていない",
    "強く読む前の保留枠として残したい"
  ],
  trickster: [
    "真面目すぎるのが逆に怪しい",
    "安全な反応だけを選んでいるように見える",
    "みんな安全牌すぎて面白くない"
  ],
  stoic: [
    "初日の沈黙もデータ",
    "言えたはずなのに言わなかった",
    "目を逸らす人を観察してる"
  ],
  passionate: [
    "信じたいけど覚悟を見せてほしい",
    "エネルギーは本物に感じるけど演技もできる",
    "心は信じたいけど保留に置く"
  ]
};

const openingFirstDayReasonsEn: Record<AgentSpeechInput["player"]["persona"], string[]> = {
  cautious: [
    "their opening stance is still thin",
    "an early read will be easier to compare later",
    "starting with a small read keeps the table readable"
  ],
  aggressive: [
    "not giving their own view from the start looks suspicious",
    "early pressure should create useful vote movement",
    "someone needs to open with a clear stance"
  ],
  logical: [
    "I want material we can compare later",
    "an opening reason gives the table a baseline",
    "the first stance helps structure later votes"
  ],
  opportunistic: [
    "an early stance is useful to revisit later",
    "their movement now will be easier to judge later",
    "the table needs a first point to test"
  ],
  empathetic: [
    "I am holding them lightly before reading them strongly",
    "a soft read should make the start easier",
    "their first thought will help me understand them"
  ],
  trickster: [
    "a normal opening is a little too safe",
    "opening with something odd can reveal useful reactions",
    "safe starts are boring and hard to read"
  ],
  stoic: [
    "even a short first word is useful",
    "I need one stance before judging",
    "observation starts with the first response"
  ],
  passionate: [
    "I want to see their conviction early",
    "the first stance should carry some heart",
    "I want a reason I can believe in later"
  ]
};

const openingFirstDayReasonsJa: Record<AgentSpeechInput["player"]["persona"], string[]> = {
  cautious: [
    "最初の立場が薄いので保留寄りで見る",
    "後で比べやすいように早めの読みとして置く",
    "小さい根拠ですが今は保留寄りに置く"
  ],
  aggressive: [
    "最初から自分の見方を出さないのが怪しい",
    "早めに疑い先を置く方が票をまとめやすい",
    "ここははっきりした立場を開くべき"
  ],
  logical: [
    "後で比べられる材料を作りたい",
    "最初の理由があると流れを追いやすい",
    "最初の答えが投票前の基準になる"
  ],
  opportunistic: [
    "早めの立場は後で見返しやすい",
    "早めに保留先を置くと後で比べやすい",
    "最初の投票候補として置きやすい"
  ],
  empathetic: [
    "強く読む前の保留枠に置く",
    "柔らかい態度ですが立場はまだ薄い",
    "最初の保留先として見やすい"
  ],
  trickster: [
    "普通すぎる始まりが逆に読みにくい",
    "少し揺らすと反応が見えやすい",
    "安全な始まりだけだと読みにくい"
  ],
  stoic: [
    "短くても最初の一言は材料になる",
    "判断する前の仮置きにする",
    "観察は最初の返答から始まる"
  ],
  passionate: [
    "早めに投票候補を置く方が覚悟が出る",
    "最初の答えが薄ければ疑い寄りに置く",
    "後で信じられる理由がほしい"
  ]
};

export function listJapaneseDemoCopySamples(): string[] {
  const name = "シオン";
  return [
    ...Object.values(demoSpeechJa).flatMap((lines) => lines ?? []),
    ...Object.values(demoDaySituationSpeechJa).flat(),
    ...demoOpeningDaySituationSpeechJa,
    ...Object.values(personaReasonsJa).flat(),
    ...Object.values(firstDayReasonsJa).flat(),
    ...Object.values(openingFirstDayReasonsJa).flat(),
    "発言と投票の理由が一貫している",
    "夜の状況に関わる薬の情報があります。",
    "私の護衛先が夜の結果を説明できるかもしれません。",
    `私が死ぬなら、撃つ候補は${name}です。`,
    "私は安易に吊っていい人ではありません。",
    "疑いを向けるための偽主張",
    `強い主張が必要なら、私は占い師として出ます。${name}は人狼判定です。動きが不自然です。`,
    "今夜は議論をまとめそうな人を優先したいです。初日は情報が少ないので、明日こちらが疑いやすくなる襲撃にしましょう。",
    `今夜は${name}で合わせたいです。直近の相談を踏まえると、議論をまとめそうな人を先に噛むのが自然です。`,
    `今夜は${name}を襲撃候補にしたいです。初日は公開情報が少ないので、発言力を持ちそうな人を先に噛んで明日の議論を作りやすくしましょう。`,
    "襲撃相談で優先したい人",
    "今は選択肢を残す方が低リスクです。",
    "ここで見送る方が後半の手を残せます。",
    "選べる対象がいません。",
    `${name}は公開された主張と発言から最も疑いが集まっています。`,
    `${name}は人狼判定への返答がまだ弱く、今日の投票理由になります。`,
    `${name}は占い主張への反応がはっきりしないため投票します。`,
    `${name}は死体なし後に説明を急いだように見えます。`,
    `${name}は初日の発言が少なく、理由を確認する投票です。`,
    `${name}は昨日の投票理由と今日の発言がつながっていません。`,
    `${name}は今日の公開発言から一番検証しやすい投票先です。`
  ];
}

function clampText(text: string, fallback: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return fallback;
  }
  return compact.length > 150 ? `${compact.slice(0, 147)}...` : compact;
}

function splitSpeechText(text: string): string[] {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return [];
  }
  return (compact.match(/[^。！？.!?]+[。！？.!?]+|[^。！？.!?]+$/g) ?? [compact]).map((part) => part.trim()).filter(Boolean);
}

function isSpeechJsonLeak(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    /```(?:json)?/i.test(trimmed) ||
    /"(?:messages|message|speech|suspects|trusts|claims|targetId|reason|weight|result)"\s*:/i.test(trimmed)
  );
}

function stripDialogueLabel(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  const match = compact.match(/^(?:実際の発話|実際のセリフ|セリフ|発言)\s*[:：]\s*(.+)$/);
  return match ? match[1].trim() : compact;
}

function isDialogueMetaMessage(message: string): boolean {
  const compact = message.replace(/\s+/g, " ").trim();
  return /^(?:方針|戦略|作戦|推理メモ|進行メモ|内部メモ|補助メモ|メモ|出力|スキーマ|JSON|strategy|reasoning|analysis|public speech|message|messages|suspects|trusts|claims)\s*[:：]/i.test(
    compact
  );
}

function normalizeSpeechLine(text: string, fallback: string, language: string): string {
  return stripJapaneseSpeechTerminalPeriod(clampText(text, fallback), language);
}

function normalizeSpeechMessages(messagesSource: string[], fallback: string, language: string): string[] {
  return messagesSource
    .flatMap(splitSpeechText)
    .map(stripDialogueLabel)
    .filter((message) => message.length > 0 && !isSpeechJsonLeak(message) && !isDialogueMetaMessage(message))
    .slice(0, maxSpeechMessages)
    .map((message) => normalizeSpeechLine(message, fallback, language))
    .filter(Boolean);
}

function readJsonStringLiteral(text: string, startIndex: number): { value: string; endIndex: number } | null {
  let escaped = false;
  for (let index = startIndex + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char !== "\"") {
      continue;
    }

    try {
      return {
        value: JSON.parse(text.slice(startIndex, index + 1)) as string,
        endIndex: index + 1
      };
    } catch {
      return null;
    }
  }

  return null;
}

function extractMalformedStringArrayField(text: string, fieldName: string): string[] {
  const match = new RegExp(`"${fieldName}"\\s*:\\s*\\[`, "i").exec(text);
  if (!match) {
    return [];
  }

  const values: string[] = [];
  let index = match.index + match[0].length;
  while (index < text.length && values.length < maxSpeechMessages) {
    const char = text[index];
    if (char === "]") {
      break;
    }
    if (char !== "\"") {
      index += 1;
      continue;
    }

    const literal = readJsonStringLiteral(text, index);
    if (!literal) {
      break;
    }
    values.push(literal.value);
    index = literal.endIndex;
  }

  return values;
}

function extractMalformedStringField(text: string, fieldName: string): string[] {
  const match = new RegExp(`"${fieldName}"\\s*:\\s*"`, "i").exec(text);
  if (!match) {
    return [];
  }

  const literalStart = match.index + match[0].length - 1;
  const literal = readJsonStringLiteral(text, literalStart);
  return literal ? [literal.value] : [];
}

function extractMalformedSpeechMessages(text: string): string[] {
  const messages = extractMalformedStringArrayField(text, "messages");
  if (messages.length > 0) {
    return messages;
  }
  const message = extractMalformedStringField(text, "message");
  if (message.length > 0) {
    return message;
  }
  return extractMalformedStringField(text, "speech");
}

function clampSummary(text: string): string | null {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return null;
  }
  return compact.length > 260 ? `${compact.slice(0, 257)}...` : compact;
}

function summaryStyleInstruction(language: string): string {
  if (/japanese|日本語|ja\b/i.test(language)) {
    return promptMaterials.roundSummary.style.japanese;
  }
  return promptMaterials.roundSummary.style.english;
}

function clampReason(text: unknown, fallback: string): string {
  if (typeof text !== "string") {
    return fallback;
  }
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return fallback;
  }
  return compact.length > 150 ? `${compact.slice(0, 147)}...` : compact;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const direct = tryParseJson(trimmed);
  if (direct) {
    return direct;
  }

  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  return tryParseJson(match[0]);
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptySpeechMetadata(): SpeechMetadata {
  return {
    suspects: [],
    trusts: [],
    claims: []
  };
}

function candidateById(candidates: TargetCandidate[]): Map<string, TargetCandidate> {
  return new Map(candidates.map((candidate) => [candidate.id, candidate]));
}

function isRole(value: unknown): value is Role {
  return (
    value === "Werewolf" ||
    value === "AlphaWolf" ||
    value === "WolfBeauty" ||
    value === "Seer" ||
    value === "Witch" ||
    value === "Guard" ||
    value === "Hunter" ||
    value === "Raven" ||
    value === "Idiot" ||
    value === "Elder" ||
    value === "Lover" ||
    value === "Jester" ||
    value === "Villager"
  );
}

function isCamp(value: unknown): value is Camp {
  return value === "werewolf" || value === "village";
}

function normalizeWeight(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(1, value));
}

const readEvidenceKindAliases: Record<string, ReadEvidenceKind> = {
  speech_timing: "speech_timing",
  timing: "speech_timing",
  stance_change: "stance_change",
  changed_stance: "stance_change",
  weak_reason: "weak_reason",
  thin_reason: "weak_reason",
  vote: "vote",
  voting: "vote",
  claim_timing: "claim_timing",
  claim_reaction: "claim_reaction",
  seer_result: "seer_result",
  white_result: "seer_result",
  black_result: "seer_result",
  night_result: "night_result",
  participation: "participation",
  consistency: "consistency",
  first_day_tentative: "first_day_tentative",
  other: "other"
};

function normalizeReadEvidenceKind(value: unknown): ReadEvidenceKind | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return readEvidenceKindAliases[value.trim().toLowerCase().replace(/[\s-]+/g, "_")];
}

function candidateRef(
  raw: Record<string, unknown>,
  idKey: string,
  nameKey: string,
  candidates: TargetCandidate[]
): { id?: string; name?: string } {
  const byId = candidateById(candidates);
  const idValue = raw[idKey];
  if (typeof idValue === "string" && byId.has(idValue)) {
    const candidate = byId.get(idValue);
    return { id: idValue, name: candidate?.name };
  }

  const nameValue = raw[nameKey];
  if (typeof nameValue === "string") {
    const candidate = candidates.find((item) => item.name === nameValue.trim());
    if (candidate) {
      return { id: candidate.id, name: candidate.name };
    }
  }

  return {};
}

function normalizeReadEvidence(value: unknown, candidates: TargetCandidate[]): ReadEvidenceMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = normalizeReadEvidenceKind(value.kind ?? value.type);
  if (!kind) {
    return undefined;
  }
  const source = candidateRef(value, "sourceId", "sourceName", candidates);
  const claimant = candidateRef(value, "claimantId", "claimantName", candidates);
  const resultTarget = candidateRef(value, "resultTargetId", "resultTargetName", candidates);
  const resultCamp = isCamp(value.resultCamp) ? value.resultCamp : isCamp(value.camp) ? value.camp : undefined;
  const round = typeof value.round === "number" && Number.isFinite(value.round) ? Math.max(1, Math.floor(value.round)) : undefined;
  return {
    kind,
    sourceId: source.id,
    sourceName: source.name,
    claimantId: claimant.id,
    claimantName: claimant.name,
    resultTargetId: resultTarget.id,
    resultTargetName: resultTarget.name,
    resultCamp,
    round
  };
}

function canonicalReadReason(kind: "suspect" | "trust", evidence: ReadEvidenceMetadata | undefined, language: string): string {
  const japanese = isJapaneseLanguage(language);
  if (!evidence) {
    return japanese
      ? kind === "suspect"
        ? "公開発言から確認したい点がある"
        : "公開発言の立場が比較的はっきりしている"
      : kind === "suspect"
        ? "public stance needs pressure"
        : "public stance is comparatively clear";
  }

  if (japanese) {
    if (evidence.kind === "seer_result") {
      const claimant = evidence.claimantName ?? evidence.sourceName;
      const resultTarget = evidence.resultTargetName;
      const camp = evidence.resultCamp ? campLabel(evidence.resultCamp, language) : undefined;
      if (claimant && resultTarget && camp) {
        return `${claimant}が${resultTarget}を${camp}だと言った後の反応`;
      }
      if (resultTarget && camp) {
        return `${resultTarget}への${camp}判定への反応`;
      }
      return "占い結果への反応";
    }
    if (evidence.kind === "claim_timing") {
      return "役職を名乗ったタイミング";
    }
    if (evidence.kind === "claim_reaction") {
      return kind === "suspect" ? "役職主張への反応がはっきりしない" : "役職主張への反応が落ち着いている";
    }
    if (evidence.kind === "stance_change") {
      return kind === "suspect" ? "発言の変化が気になる" : "立場の出し方が一貫している";
    }
    if (evidence.kind === "weak_reason") {
      return kind === "suspect" ? "理由の薄さが気になる" : "理由が具体的";
    }
    if (evidence.kind === "vote") {
      return kind === "suspect" ? "投票理由を確認したい" : "投票理由が発言とつながっている";
    }
    if (evidence.kind === "night_result") {
      return kind === "suspect" ? "夜の結果への反応が気になる" : "夜の結果への反応が落ち着いている";
    }
    if (evidence.kind === "participation") {
      return kind === "suspect" ? "参加姿勢と理由を確認したい" : "参加姿勢と理由が見えている";
    }
    if (evidence.kind === "consistency") {
      return kind === "suspect" ? "前後の発言がつながっていない" : "前後の発言がつながっている";
    }
    if (evidence.kind === "first_day_tentative") {
      return kind === "suspect"
        ? "まだ公開発言がないので、軽い印象として気にしている"
        : "まだ公開発言がないので、軽い印象として置いている";
    }
    return kind === "suspect" ? "公開発言から確認したい点がある" : "公開発言の立場が比較的はっきりしている";
  }

  if (evidence.kind === "seer_result") {
    const claimant = evidence.claimantName ?? evidence.sourceName;
    const resultTarget = evidence.resultTargetName;
    const camp = evidence.resultCamp;
    if (claimant && resultTarget && camp) {
      return `${claimant}'s ${camp} result on ${resultTarget} and the reaction to it`;
    }
    if (resultTarget && camp) {
      return `${camp} result on ${resultTarget}`;
    }
    return "reaction to the Seer result";
  }
  if (evidence.kind === "claim_timing") {
    return "timing of the role claim";
  }
  if (evidence.kind === "claim_reaction") {
    return kind === "suspect" ? "unclear reaction to the role claim" : "steady reaction to the role claim";
  }
  if (evidence.kind === "stance_change") {
    return kind === "suspect" ? "changed public stance" : "consistent public stance";
  }
  if (evidence.kind === "weak_reason") {
    return kind === "suspect" ? "thin public reason" : "specific public reason";
  }
  if (evidence.kind === "vote") {
    return kind === "suspect" ? "vote reason needs pressure" : "vote reason matches the stated read";
  }
  if (evidence.kind === "night_result") {
    return kind === "suspect" ? "reaction to the night result needs pressure" : "steady reaction to the night result";
  }
  if (evidence.kind === "participation") {
    return kind === "suspect" ? "participation and stance need pressure" : "participation and stance are visible";
  }
  if (evidence.kind === "consistency") {
    return kind === "suspect" ? "statements do not connect" : "statements connect consistently";
  }
  if (evidence.kind === "first_day_tentative") {
    return kind === "suspect"
      ? "a light first impression while no one has spoken yet"
      : "a light first impression to hold while no one has spoken yet";
  }
  return kind === "suspect" ? "public stance needs pressure" : "public stance is comparatively clear";
}

function normalizeRead(
  value: unknown,
  readCandidates: TargetCandidate[],
  evidenceCandidates: TargetCandidate[],
  language: string,
  kind: "suspect" | "trust"
): PlayerReadMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const byId = candidateById(readCandidates);
  const raw = value as Record<string, unknown>;
  const targetId = typeof raw.targetId === "string" ? raw.targetId : "";
  const target = byId.get(targetId);
  if (!target) {
    return null;
  }
  const evidence = normalizeReadEvidence(raw.evidence, evidenceCandidates);

  return {
    targetId,
    targetName: target.name,
    reason: canonicalReadReason(kind, evidence, language),
    weight: normalizeWeight(raw.weight),
    evidence
  };
}

function normalizeClaimResult(
  value: unknown,
  candidates: TargetCandidate[]
): ClaimMetadata["result"] | undefined {
  if (typeof value === "string") {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const byId = candidateById(candidates);
  const raw = value as Record<string, unknown>;
  const targetId = typeof raw.targetId === "string" ? raw.targetId : "";
  const target = byId.get(targetId);
  const camp = isCamp(raw.camp) ? raw.camp : undefined;
  if (!target || !camp) {
    return undefined;
  }

  const round = typeof raw.round === "number" && Number.isFinite(raw.round) ? Math.max(1, Math.floor(raw.round)) : undefined;
  return {
    targetId,
    targetName: target.name,
    camp,
    round
  };
}

function canonicalClaimNote(input: {
  type: ClaimMetadata["type"];
  role?: Role;
  targetName?: string;
  camp?: Camp;
  result?: ClaimMetadata["result"];
  language: string;
}): string | undefined {
  const japanese = isJapaneseLanguage(input.language);
  if (input.result && typeof input.result === "object") {
    return undefined;
  }
  if (input.role) {
    return japanese ? `${roleLabel(input.role, input.language)}を名乗った` : `claimed ${input.role}`;
  }
  if (input.targetName && input.camp) {
    return japanese ? `${input.targetName}を${campLabel(input.camp, input.language)}側として扱った` : `treated ${input.targetName} as ${input.camp}`;
  }
  if (input.type === "seer_result") {
    return japanese ? "占い結果に関する主張" : "claim about a Seer result";
  }
  if (input.type === "witch_info") {
    return japanese ? "夜の薬に関する主張" : "claim about night potion information";
  }
  return undefined;
}

function normalizeClaim(value: unknown, candidates: TargetCandidate[], language: string): ClaimMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const byId = candidateById(candidates);
  const raw = value as Record<string, unknown>;
  const type =
    raw.type === "role_claim" || raw.type === "seer_result" || raw.type === "witch_info" || raw.type === "generic"
      ? raw.type
      : "generic";
  const role = isRole(raw.role) ? raw.role : undefined;
  const targetId = typeof raw.targetId === "string" && byId.has(raw.targetId) ? raw.targetId : undefined;
  const target = targetId ? byId.get(targetId) : undefined;
  const camp = isCamp(raw.camp) ? raw.camp : undefined;
  const result = normalizeClaimResult(raw.result, candidates);
  const note = canonicalClaimNote({ type, role, targetName: target?.name, camp, result, language });

  if (!role && !targetId && !camp && !result && !note) {
    return null;
  }

  return {
    type,
    role,
    targetId,
    targetName: target?.name,
    camp,
    result,
    note
  };
}

function normalizeSpeechMetadata(
  parsed: Record<string, unknown>,
  readCandidates: TargetCandidate[],
  language: string,
  claimCandidates = readCandidates
): SpeechMetadata {
  const suspects = Array.isArray(parsed.suspects)
    ? parsed.suspects
        .map((item) => normalizeRead(item, readCandidates, claimCandidates, language, "suspect"))
        .filter((item): item is PlayerReadMetadata => Boolean(item))
    : [];
  const trusts = Array.isArray(parsed.trusts)
    ? parsed.trusts
        .map((item) => normalizeRead(item, readCandidates, claimCandidates, language, "trust"))
        .filter((item): item is PlayerReadMetadata => Boolean(item))
    : [];
  const claims = Array.isArray(parsed.claims)
    ? parsed.claims.map((item) => normalizeClaim(item, claimCandidates, language)).filter((item): item is ClaimMetadata => Boolean(item))
    : [];

  return {
    suspects: suspects.slice(0, 3),
    trusts: trusts.slice(0, 3),
    claims: claims.slice(0, 3)
  };
}

interface SpeechIntentMetadata {
  act?: string;
  targetId?: string;
  targetName?: string;
  stance?: string;
  reason?: string;
  claimAssessment?: string;
}

interface SpeechReasoningResult {
  intent: SpeechIntentMetadata;
  metadata: SpeechMetadata;
}

const speechIntentActs = new Set([
  "suspect",
  "trust",
  "hold",
  "vote_candidate",
  "claim_judgment",
  "claim",
  "defense",
  "private_plan"
]);

function normalizeSpeechIntentAct(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return speechIntentActs.has(normalized) ? normalized : undefined;
}

function normalizeSpeechIntent(
  value: unknown,
  metadata: SpeechMetadata,
  candidates: TargetCandidate[],
  language: string
): SpeechIntentMetadata {
  const byId = candidateById(candidates);
  const raw = isRecord(value) ? value : {};
  const targetIdValue = raw.targetId;
  const targetId = typeof targetIdValue === "string" && byId.has(targetIdValue) ? targetIdValue : undefined;
  const target = targetId ? byId.get(targetId) : undefined;
  const read =
    targetId && metadata.suspects.some((item) => item.targetId === targetId)
      ? metadata.suspects.find((item) => item.targetId === targetId)
      : targetId && metadata.trusts.some((item) => item.targetId === targetId)
        ? metadata.trusts.find((item) => item.targetId === targetId)
        : undefined;
  const act =
    normalizeSpeechIntentAct(raw.act) ??
    (read && metadata.suspects.some((item) => item.targetId === read.targetId)
      ? "suspect"
      : read
        ? "trust"
        : undefined);
  const stance =
    act === "suspect" || act === "vote_candidate"
      ? "suspicion"
      : act === "trust"
        ? "trust"
        : act === "claim_judgment" || act === "claim"
          ? "claim"
          : act === "hold"
            ? "hold"
            : undefined;
  const reason = read?.reason;
  const claimAssessment =
    act === "claim_judgment" || act === "claim"
      ? isJapaneseLanguage(language)
        ? "役職主張は公開情報で保留して見る"
        : "hold the role claim against public information"
      : undefined;

  if (!target && (act === "suspect" || act === "vote_candidate") && metadata.suspects[0]) {
    const suspect = metadata.suspects[0];
    return {
      act: "suspect",
      targetId: suspect.targetId,
      targetName: suspect.targetName,
      stance: "suspicion",
      reason: suspect.reason
    };
  }

  if (!target && act === "trust" && metadata.trusts[0]) {
    const trust = metadata.trusts[0];
    return {
      act: "trust",
      targetId: trust.targetId,
      targetName: trust.targetName,
      stance: "trust",
      reason: trust.reason
    };
  }

  if (!target && (act === "claim_judgment" || act === "claim") && metadata.claims[0]) {
    const claim = metadata.claims[0];
    const result = typeof claim.result === "object" && claim.result !== null ? claim.result : undefined;
    return {
      act: claim.role ? "claim_judgment" : "claim",
      targetId: claim.targetId ?? result?.targetId,
      targetName: claim.targetName ?? result?.targetName,
      stance: claim.role ? `${claim.role} claim` : "claim",
      reason: claim.note,
      claimAssessment
    };
  }

  if (act || stance || reason || claimAssessment || target) {
    return {
      act,
      targetId,
      targetName: target?.name,
      stance,
      reason,
      claimAssessment
    };
  }

  const suspect = metadata.suspects[0];
  if (suspect) {
    return {
      act: "suspect",
      targetId: suspect.targetId,
      targetName: suspect.targetName,
      stance: "suspicion",
      reason: suspect.reason
    };
  }

  const trust = metadata.trusts[0];
  if (trust) {
    return {
      act: "trust",
      targetId: trust.targetId,
      targetName: trust.targetName,
      stance: "trust",
      reason: trust.reason
    };
  }

  const claim = metadata.claims[0];
  if (claim) {
    const result = typeof claim.result === "object" && claim.result !== null ? claim.result : undefined;
    return {
      act: claim.role ? "claim_judgment" : "claim",
      targetId: claim.targetId ?? result?.targetId,
      targetName: claim.targetName ?? result?.targetName,
      stance: claim.role ? `${claim.role} claim` : "claim",
      reason: claim.note
    };
  }

  return {
    act: "hold",
    stance: "hold"
  };
}

function parseSpeechReasoning(
  content: string,
  readCandidates: TargetCandidate[],
  language: string,
  claimCandidates = readCandidates
): SpeechReasoningResult {
  const parsed = extractJsonObject(content);
  if (!parsed) {
    return {
      intent: { act: "hold", stance: "hold" },
      metadata: emptySpeechMetadata()
    };
  }

  const metadata = normalizeSpeechMetadata(parsed, readCandidates, language, claimCandidates);
  const intentSource = isRecord(parsed.intent) ? parsed.intent : isRecord(parsed.speechIntent) ? parsed.speechIntent : parsed;
  return {
    intent: normalizeSpeechIntent(intentSource, metadata, readCandidates, language),
    metadata
  };
}

function parseSpeechRealizationMessages(content: string, fallback: string, language: string): string[] {
  const parsed = extractJsonObject(content);
  if (!parsed) {
    if (isSpeechJsonLeak(content)) {
      return normalizeSpeechMessages(extractMalformedSpeechMessages(content), fallback, language);
    }
    const line = normalizeSpeechLine(content, fallback, language);
    return line ? [line] : [];
  }

  const messagesSource = Array.isArray(parsed.messages)
    ? parsed.messages.filter((msg): msg is string => typeof msg === "string")
    : typeof parsed.message === "string"
      ? [parsed.message]
      : typeof parsed.speech === "string"
        ? [parsed.speech]
        : [];
  return normalizeSpeechMessages(messagesSource, fallback, language);
}

function speechReasoningFallback(reasoning: SpeechReasoningResult, input: AgentSpeechInput, language: string): string {
  const japanese = isJapaneseLanguage(language);
  const target = reasoning.intent.targetName ?? (reasoning.intent.targetId ? targetName(reasoning.intent.targetId, input.knownPlayers) : "");
  const reason = reasoning.intent.reason || reasoning.intent.claimAssessment || reasoning.intent.stance || "";
  const act = reasoning.intent.act ?? "";

  if (japanese) {
    const reasonPrefix = reason ? `${reason}という点から、` : "";
    if (target && /trust|信頼|信用/i.test(act)) {
      return `${target}は${reasonPrefix}信頼寄りで見ます`;
    }
    if (target && /suspect|vote|疑|投票/i.test(act)) {
      return `${target}は${reasonPrefix}疑い寄りで見ます`;
    }
    if (target && /claim|主張|hold|保留/i.test(act)) {
      return `${target}については${reasonPrefix}今は保留します`;
    }
    return buildLlmSpeechFallback(input, language);
  }

  if (target && /trust/i.test(act)) {
    return `${target} is my trust lean${reason ? ` because ${reason}` : ""}.`;
  }
  if (target && /suspect|vote/i.test(act)) {
    return `${target} is my suspicion lean${reason ? ` because ${reason}` : ""}.`;
  }
  if (target && /claim|hold/i.test(act)) {
    return `I am holding on ${target}${reason ? ` because ${reason}` : ""}.`;
  }
  return buildLlmSpeechFallback(input, language);
}

function speechRealizationUserContent(reasoning: SpeechReasoningResult, language: string): string {
  const payload = {
    intent: reasoning.intent,
    metadata: reasoning.metadata
  };
  if (isJapaneseLanguage(language)) {
    return [
      "構造化された発話意図:",
      JSON.stringify(payload),
      "",
      "作業:",
      "上の intent と metadata だけを、画面に表示する自然な短いセリフにしてください。新しい推理や対象は足しません。"
    ].join("\n");
  }
  return [
    "Structured speech intent:",
    JSON.stringify(payload),
    "",
    "Task:",
    "Render only the supplied intent and metadata as short displayed dialogue. Do not add new reasoning or targets."
  ].join("\n");
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function abortError(message = "LLM request cancelled."): Error {
  return new Error(message);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return error.name === "AbortError" || message.includes("aborted") || message.includes("cancelled");
}

function createAnthropicClient(apiKey: string, baseUrl: string, timeoutMs: number): Anthropic {
  return new Anthropic({
    apiKey,
    baseURL: baseUrl,
    timeout: timeoutMs,
    maxRetries: 0
  });
}

type LlmQueueEntry = {
  id: number;
  queuedAt: number;
  startedAt?: number;
  model: string;
  maxTokens: number;
  label?: string;
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abort: () => void;
};

/**
 * Structured per-request trace event. Mirrors the AMONG_AI_LLM_QUEUE_TRACE
 * console output but is delivered to an in-process sink so measurement tooling
 * (scripts/llm-latency-probe.ts) can aggregate timings without parsing stdout.
 */
export interface LlmTraceEvent {
  kind: string;
  requestId: number;
  model: string;
  maxTokens: number;
  label?: string;
  active: number;
  queued: number;
  concurrency: number;
  waitMs?: number;
  activeMs?: number;
}

let llmTraceSink: ((event: LlmTraceEvent) => void) | null = null;

/** Register (or clear with null) a sink that receives every LLM queue trace event. */
export function setLlmQueueTraceSink(sink: ((event: LlmTraceEvent) => void) | null): void {
  llmTraceSink = sink;
}

const llmQueue: LlmQueueEntry[] = [];
let activeLlmRequests = 0;
let nextLlmStartAt = 0;
let llmStartTimer: ReturnType<typeof setTimeout> | null = null;
let nextLlmRequestId = 0;

function llmRequestConcurrency(): number {
  return fixedLlmRequestConcurrency;
}

function llmRequestMinIntervalMs(): number {
  return fixedLlmRequestMinIntervalMs;
}

function llmQueueTraceEnabled(): boolean {
  return process.env.AMONG_AI_LLM_QUEUE_TRACE === "1";
}

function emitLlmQueueTrace(kind: string, entry: LlmQueueEntry, extra: Record<string, unknown> = {}): void {
  if (llmTraceSink) {
    llmTraceSink({
      kind,
      requestId: entry.id,
      model: entry.model,
      maxTokens: entry.maxTokens,
      label: entry.label,
      active: activeLlmRequests,
      queued: llmQueue.length,
      concurrency: llmRequestConcurrency(),
      waitMs: typeof extra.waitMs === "number" ? extra.waitMs : undefined,
      activeMs: typeof extra.activeMs === "number" ? extra.activeMs : undefined
    });
  }

  if (!llmQueueTraceEnabled()) {
    return;
  }

  console.info(
    `[llm-queue] ${JSON.stringify({
      kind,
      requestId: entry.id,
      model: entry.model,
      maxTokens: entry.maxTokens,
      label: entry.label,
      active: activeLlmRequests,
      queued: llmQueue.length,
      concurrency: llmRequestConcurrency(),
      ...extra
    })}`
  );
}

function scheduleLlmQueue(): void {
  if (llmStartTimer) {
    return;
  }

  const now = Date.now();
  const delay = Math.max(0, nextLlmStartAt - now);
  llmStartTimer = setTimeout(() => {
    llmStartTimer = null;
    drainLlmQueue();
  }, delay);
}

function drainLlmQueue(): void {
  while (activeLlmRequests < llmRequestConcurrency() && llmQueue.length > 0) {
    const now = Date.now();
    if (now < nextLlmStartAt) {
      scheduleLlmQueue();
      return;
    }

    const entry = llmQueue.shift();
    if (!entry) {
      return;
    }
    entry.signal?.removeEventListener("abort", entry.abort);
    if (entry.signal?.aborted) {
      entry.reject(abortError());
      continue;
    }

    activeLlmRequests += 1;
    nextLlmStartAt = now + llmRequestMinIntervalMs();
    entry.startedAt = now;
    emitLlmQueueTrace("started", entry, { waitMs: now - entry.queuedAt });
    entry.resolve();
  }
}

async function acquireLlmSlot(
  signal: AbortSignal | undefined,
  request: { model: string; maxTokens: number; label?: string }
): Promise<() => void> {
  throwIfAborted(signal);
  let acquiredEntry: LlmQueueEntry | null = null;
  await new Promise<void>((resolve, reject) => {
    const entry: LlmQueueEntry = {
      id: ++nextLlmRequestId,
      queuedAt: Date.now(),
      model: request.model,
      maxTokens: request.maxTokens,
      label: request.label,
      resolve: () => {
        acquiredEntry = entry;
        resolve();
      },
      reject,
      signal,
      abort: () => {
        const index = llmQueue.indexOf(entry);
        if (index !== -1) {
          llmQueue.splice(index, 1);
        }
        emitLlmQueueTrace("aborted_waiting", entry, { waitMs: Date.now() - entry.queuedAt });
        reject(abortError());
      }
    };
    signal?.addEventListener("abort", entry.abort, { once: true });
    llmQueue.push(entry);
    emitLlmQueueTrace("queued", entry);
    drainLlmQueue();
  });
  if (!acquiredEntry) {
    throw abortError();
  }
  const entry = acquiredEntry as LlmQueueEntry;

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    activeLlmRequests = Math.max(0, activeLlmRequests - 1);
    emitLlmQueueTrace("finished", entry, {
      activeMs: entry.startedAt ? Date.now() - entry.startedAt : undefined
    });
    drainLlmQueue();
  };
}

function isRetryableAnthropicError(error: unknown): boolean {
  if (error instanceof APIConnectionTimeoutError) {
    return false;
  }
  if (error instanceof APIError) {
    const status = error.status ?? 0;
    return status === 429 || status >= 500 || /(?:rate limit|429)/i.test(error.message);
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (
      error.name === "AbortError" ||
      message.includes("timeout") ||
      message.includes("aborted") ||
      message.includes("cancelled")
    ) {
      return false;
    }
    return (
      message.includes("econnreset") ||
      message.includes("rate limit") ||
      message.includes("429")
    );
  }
  return false;
}

function retryDelayMs(attempt: number): number {
  return initialLlmBackoffMs * 2 ** Math.max(0, attempt - 1);
}

function parseTargetSelection(
  content: string,
  candidates: AgentTargetInput["candidates"],
  allowSkip: boolean
): { valid: true; decision: TargetDecision } | { valid: false } {
  const parsed = extractJsonObject(content);
  if (!parsed || !Object.hasOwn(parsed, "targetId")) {
    return { valid: false };
  }

  const reason = clampReason(parsed.reason, "No reason provided.");
  const targetId = parsed.targetId;
  if (targetId === null || targetId === "null" || targetId === "") {
    return allowSkip ? { valid: true, decision: { targetId: null, reason } } : { valid: false };
  }

  if (typeof targetId !== "string") {
    return { valid: false };
  }

  const ids = new Set(candidates.map((candidate) => candidate.id));
  return ids.has(targetId) ? { valid: true, decision: { targetId, reason } } : { valid: false };
}

function parseBooleanDecision(content: string): { valid: true; decision: boolean } | { valid: false } {
  const parsed = extractJsonObject(content);
  return typeof parsed?.decision === "boolean" ? { valid: true, decision: parsed.decision } : { valid: false };
}

function targetName(targetId: string, candidates: TargetCandidate[]): string {
  return candidates.find((candidate) => candidate.id === targetId)?.name ?? targetId;
}

function stripTargetReasonLabel(reason: string): string {
  const compact = reason.replace(/\s+/g, " ").trim();
  const match = compact.match(/^(?:理由|投票理由|表示理由|実際の理由|reason)\s*[:：]\s*(.+)$/i);
  return match ? match[1].trim() : compact;
}

function isTargetReasonMeta(reason: string): boolean {
  const compact = reason.replace(/\s+/g, " ").trim();
  return /^(?:方針|戦略|作戦|内部メモ|補助メモ|推理メモ|出力|スキーマ|JSON|strategy|reasoning|analysis|target|targetId|reason)\s*[:：]/i.test(
    compact
  );
}

function fallbackTargetReason(decision: TargetDecision, candidates: TargetCandidate[], language: string, phase: AgentTargetInput["phase"]): string {
  const target = decision.targetId ? candidates.find((candidate) => candidate.id === decision.targetId) : null;
  if (isJapaneseLanguage(language)) {
    if (!target) {
      return "今回は対象を選びません。";
    }
    return phase === "voting"
      ? `${target.name}は今日の公開発言から一番疑わしいためです。`
      : `${target.name}を選ぶのが今の状況で一番よいと判断しました。`;
  }
  if (!target) {
    return "Skipping is the best available choice.";
  }
  return phase === "voting" ? `${target.name} is the most suspicious public vote.` : `${target.name} is the best available target.`;
}

function normalizeTargetDecision(decision: TargetDecision, candidates: TargetCandidate[], language: string, phase: AgentTargetInput["phase"]): TargetDecision {
  const fallback = fallbackTargetReason(decision, candidates, language, phase);
  const reason = stripTargetReasonLabel(clampReason(decision.reason, fallback));
  return {
    ...decision,
    reason: reason.length > 0 && !isSpeechJsonLeak(reason) && !isTargetReasonMeta(reason) ? reason : fallback
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function evidenceTarget(input: AgentTargetInput): TargetCandidate | null {
  if (!/day elimination vote/i.test(input.action)) {
    return null;
  }

  const context = input.context.toLowerCase();
  const ranked = input.candidates
    .map((candidate) => {
      const name = candidate.name.toLowerCase();
      const escapedName = escapeRegExp(name);
      let score = 0;
      if (
        context.includes(`${name} checked as werewolf`) ||
        context.includes(`${name} checked werewolf`) ||
        context.includes(`${name} reads as werewolf`)
      ) {
        score += 4;
      }
      const suspectMentions = context.match(new RegExp(`suspects: [^\\n.]*${escapedName}`, "g"))?.length ?? 0;
      score += suspectMentions;
      return { candidate, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.name.localeCompare(b.candidate.name));

  return ranked[0]?.candidate ?? null;
}

function normalizeLlmSummary(content: string): string | null {
  const parsed = extractJsonObject(content);
  const summary = typeof parsed?.summary === "string" ? parsed.summary : content.replace(/```(?:json)?|```/g, "");
  return clampSummary(summary);
}

function naturalizeDemoText(text: string, language: string): string {
  return stripJapaneseSpeechTerminalPeriod(sanitizeDemoJapaneseGameText(clampText(text, text), language), language);
}

function buildDemoSpeechMessages(parts: string[], language: string): string[] {
  const messages = parts
    .flatMap(splitSpeechText)
    .map((part) => naturalizeDemoText(part, language))
    .filter(Boolean)
    .slice(0, maxSpeechMessages);
  return messages.length > 0 ? messages : [naturalizeDemoText(parts.join(" "), language)];
}

function naturalizeDemoReason(text: string, language: string): string {
  return sanitizeDemoJapaneseGameText(clampReason(text, text), language);
}

function punctuateJapaneseSentence(text: string): string {
  return /[。！？!?]$/.test(text) ? text : `${text}。`;
}

function japaneseReasonSentence(reason: string): string {
  const compact = reason.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "理由はまだ整理中です。";
  }
  if (/[。！？!?]$/.test(compact)) {
    return compact;
  }
  if (compact.endsWith("から") || compact.endsWith("ため") || compact.endsWith("だけ")) {
    return `理由は${compact}です。`;
  }
  return punctuateJapaneseSentence(compact);
}

function demoCharacterFlavorLine(input: AgentSpeechInput, language: string): string | null {
  if (!isJapaneseLanguage(language) || input.phase !== "day_discussion" || !input.player.characterProfile || !weightedChance(0.35)) {
    return null;
  }
  return punctuateJapaneseSentence(input.player.characterProfile.tagline);
}

function finalizeDemoSpeech(speech: AgentSpeech, language: string): AgentSpeech {
  return {
    messages: speech.messages.map((msg) => naturalizeDemoText(msg, language)),
    metadata: {
      suspects: speech.metadata.suspects.map((read) => ({
        ...read,
        reason: read.reason ? naturalizeDemoReason(read.reason, language) : read.reason
      })),
      trusts: speech.metadata.trusts.map((read) => ({
        ...read,
        reason: read.reason ? naturalizeDemoReason(read.reason, language) : read.reason
      })),
      claims: speech.metadata.claims.map((claim) => ({
        ...claim,
        note: claim.note ? naturalizeDemoReason(claim.note, language) : claim.note,
        result: typeof claim.result === "string" ? naturalizeDemoReason(claim.result, language) : claim.result
      }))
    }
  };
}

function extractNamedPlayers(context: string, labels: string[], knownPlayers: TargetCandidate[]): TargetCandidate[] {
  for (const label of labels) {
    const match = context.match(new RegExp(`${escapeRegExp(label)}\\s*[:：]\\s*([^\\n.。]+)`));
    if (!match) {
      continue;
    }
    const names = new Set(match[1].split(",").map((name) => name.trim()).filter(Boolean));
    const players = knownPlayers.filter((player) => names.has(player.name));
    if (players.length > 0) {
      return players;
    }
  }
  return [];
}

function werewolfVictimCandidates(input: AgentSpeechInput): TargetCandidate[] {
  const legalPlayers = input.legalPlayers ?? input.knownPlayers;
  const listedVictims = extractNamedPlayers(input.context, ["Possible victims", "襲撃候補"], legalPlayers);
  if (listedVictims.length > 0) {
    return listedVictims;
  }

  const allies = new Set(
    extractNamedPlayers(input.context, ["Known werewolves", "把握している人狼"], input.knownPlayers).map((player) => player.id)
  );
  allies.add(input.player.id);
  return legalPlayers.filter((candidate) => !allies.has(candidate.id));
}

function buildDemoWerewolfDiscussion(input: AgentSpeechInput, language: string): AgentSpeech {
  const japanese = isJapaneseLanguage(language);
  const candidates = werewolfVictimCandidates(input);
  const target = candidates.length > 0 ? sample(candidates) : null;
  const hasWolfChat = /Werewolf chat|人狼チャット/.test(input.context);
  const fallback = japanese
    ? "今夜は議論をまとめそうな人を優先したいです。初日は情報が少ないので、明日こちらが疑いやすくなる襲撃にしましょう。"
    : "Tonight I want to remove someone likely to organize the village. With little day-one information, the kill should make tomorrow easier to frame.";

  if (!target) {
    return {
      messages: buildDemoSpeechMessages([fallback], language),
      metadata: emptySpeechMetadata()
    };
  }

  const messageText = japanese
    ? hasWolfChat
      ? `今夜は${target.name}で合わせたいです。直近の相談を踏まえると、議論をまとめそうな人を先に噛むのが自然です。`
      : `今夜は${target.name}を襲撃候補にしたいです。初日は公開情報が少ないので、発言力を持ちそうな人を先に噛んで明日の議論を作りやすくしましょう。`
    : hasWolfChat
      ? `I want us to settle on ${target.name} tonight. Based on our chat, removing a likely village anchor gives us the cleanest tomorrow.`
      : `I want ${target.name} as tonight's victim. On day one there is little public evidence, so we should remove someone likely to become a village anchor.`;

  return {
    messages: buildDemoSpeechMessages([messageText], language),
    metadata: {
      suspects: [
        {
          targetId: target.id,
          targetName: target.name,
          reason: japanese ? "襲撃相談で優先したい人" : "priority night-kill candidate",
          weight: 0.7
        }
      ],
      trusts: [],
      claims: []
    }
  };
}

const demoDaySpeechPriority: DaySituation[] = ["black_result", "seer_claim", "first_day", "no_death", "later_day", "pre_vote"];
const demoVoteReasonPriority: DaySituation[] = ["black_result", "seer_claim", "no_death", "pre_vote", "first_day", "later_day"];

function detectSpeechDaySituations(input: AgentSpeechInput, language: string): DaySituation[] {
  return detectDaySituations({
    phase: input.phase,
    context: input.context,
    publicHistory: input.publicHistory,
    language
  });
}

function buildDemoDaySituationSpeech(input: AgentSpeechInput, language: string): string | null {
  if (input.phase !== "day_discussion") {
    return null;
  }

  const situations = detectSpeechDaySituations(input, language);
  const situation = demoDaySpeechPriority.find((candidate) => situations.includes(candidate));
  if (!situation) {
    return null;
  }

  if (situation === "first_day" && input.publicHistory.length === 0) {
    return sample(isJapaneseLanguage(language) ? demoOpeningDaySituationSpeechJa : demoOpeningDaySituationSpeechEn);
  }

  return sample((isJapaneseLanguage(language) ? demoDaySituationSpeechJa : demoDaySituationSpeechEn)[situation]);
}

function demoSpeechReasonPool(input: AgentSpeechInput, situations: DaySituation[], language: string, openingFirstDay = false): string[] {
  if (openingFirstDay) {
    return (isJapaneseLanguage(language) ? openingFirstDayReasonsJa : openingFirstDayReasonsEn)[input.player.persona];
  }

  const firstDayOnly =
    input.phase === "day_discussion" &&
    situations.includes("first_day") &&
    !situations.includes("seer_claim") &&
    !situations.includes("black_result");
  if (firstDayOnly) {
    return (isJapaneseLanguage(language) ? firstDayReasonsJa : firstDayReasonsEn)[input.player.persona];
  }
  return (isJapaneseLanguage(language) ? personaReasonsJa : personaReasonsEn)[input.player.persona];
}

function buildLlmSpeechFallback(input: AgentSpeechInput, language: string): string {
  if (input.phase === "day_discussion" && input.publicHistory.length === 0) {
    return sample(isJapaneseLanguage(language) ? demoOpeningDaySituationSpeechJa : demoOpeningDaySituationSpeechEn);
  }

  return sample(demoSpeechForRole(isJapaneseLanguage(language) ? demoSpeechJa : demoSpeechEn, input.player.role));
}

function buildDemoVotingReason(input: AgentTargetInput, target: TargetCandidate, language: string): string | null {
  if (input.phase !== "voting") {
    return null;
  }

  const situations = detectDaySituations({ phase: input.phase, context: input.context, language });
  const situation = demoVoteReasonPriority.find((candidate) => situations.includes(candidate));
  const japanese = isJapaneseLanguage(language);

  if (japanese) {
    if (situation === "black_result") {
      return `${target.name}は人狼判定への返答がまだ弱く、今日の投票理由になります。`;
    }
    if (situation === "seer_claim") {
      return `${target.name}は占い主張への反応がはっきりしないため投票します。`;
    }
    if (situation === "no_death") {
      return `${target.name}は死体なし後に説明を急いだように見えます。`;
    }
    if (situation === "first_day") {
      return `${target.name}は初日の発言が少なく、理由を確認する投票です。`;
    }
    if (situation === "later_day") {
      return `${target.name}は昨日の投票理由と今日の発言がつながっていません。`;
    }
    return `${target.name}は今日の公開発言から一番検証しやすい投票先です。`;
  }

  if (situation === "black_result") {
    return `${target.name}'s reaction to the black result is still the weakest vote reason.`;
  }
  if (situation === "seer_claim") {
    return `${target.name}'s reaction to the Seer claim stayed unclear.`;
  }
  if (situation === "no_death") {
    return `${target.name} rushed an explanation after the no-death night.`;
  }
  if (situation === "first_day") {
    return `${target.name} has the least developed first-day reasoning, so this vote marks the unclear stance.`;
  }
  if (situation === "later_day") {
    return `${target.name}'s vote reason yesterday does not connect with today's statement.`;
  }
  return `${target.name} is the most testable vote from today's public discussion.`;
}

function demoFirstDayOpeningMoveSpeech(
  move: FirstDayOpeningMove | undefined,
  target: TargetCandidate | null,
  language: string
): string | null {
  if (!move) {
    return null;
  }

  const japanese = isJapaneseLanguage(language);
  const targetName = target?.name ?? (japanese ? "誰か" : "someone");
  if (japanese) {
    if (move.kind === "self_introduction") {
      return "まず軽く自己紹介から。今日は落ち着いて、みんなの話を一通り聞いてから動きたいです";
    }
    if (move.kind === "organize_setup") {
      return "先に段取りだけ整理したいです。初日は情報が少ないので、自己紹介と方針合わせから始めませんか";
    }
    if (move.kind === "overstate_village_side") {
      return "私は人間側なので、初日に変な疑いで吊られるのは避けたいです。そこは先に言っておきます";
    }
    if (move.kind === "state_vote_criteria") {
      return "今日は理由の具体性と、質問にちゃんと答えたかを投票基準にしたいです";
    }
    if (move.kind === "ask_role_claim_policy") {
      return "占い師が今日名乗る条件を先に決めたいです。すぐ名乗るのか、結果が重い時だけにするのかを合わせたいです";
    }
    if (move.kind === "ask_table_question") {
      return "初日は誰を疑うかより、投票理由をどう残すかを先に聞きたいです。みんなはどこを基準にしますか";
    }
    if (move.kind === "tentative_reaction_read") {
      return `${targetName}の出方をまず見たいので、今は軽い印象として置いておきます`;
    }
    return "占い師・魔女・騎士への触れ方は早めに決めたいです。役職を明かさせすぎない進め方にしたいです";
  }

  if (move.kind === "self_introduction") {
    return "Let me introduce myself first. I want to take today calmly and hear everyone out before moving.";
  }
  if (move.kind === "organize_setup") {
    return "Let me organize the plan first. Day one is thin on info, so let's start with intros and aligning on approach.";
  }
  if (move.kind === "overstate_village_side") {
    return "I am on the village side, so I do not want a loose day-one suspicion to become an easy elimination.";
  }
  if (move.kind === "state_vote_criteria") {
    return "My vote criteria today are concrete answers and whether people actually take a position.";
  }
  if (move.kind === "ask_role_claim_policy") {
    return "I want us to decide early how we handle Seer claims today, whether they come out or stay hidden.";
  }
  if (move.kind === "ask_table_question") {
    return "Before we accuse anyone, I want to ask how everyone wants vote reasons handled today.";
  }
  if (move.kind === "tentative_reaction_read") {
    return `${targetName} is someone I want to watch first, so I am keeping it as a light early impression for now.`;
  }
  return "We should talk early about how Seer, Witch, and Guard should be handled without forcing them into the open.";
}

function buildDemoSpeech(input: AgentSpeechInput, language: string): AgentSpeech {
  const japanese = isJapaneseLanguage(language);
  const speechPool = japanese ? demoSpeechJa : demoSpeechEn;
  const candidates = (input.legalPlayers ?? input.knownPlayers).filter((candidate) => candidate.id !== input.player.id);

  if (input.phase === "werewolf_discussion" && input.player.camp === "werewolf") {
    return buildDemoWerewolfDiscussion(input, language);
  }

  const situations = detectSpeechDaySituations(input, language);
  const firstDaySoft =
    input.phase === "day_discussion" &&
    situations.includes("first_day") &&
    !situations.includes("seer_claim") &&
    !situations.includes("black_result");
  const openingFirstDay = firstDaySoft && input.publicHistory.length === 0;
  const reasonPool = demoSpeechReasonPool(input, situations, language, openingFirstDay);
  const suspect = !openingFirstDay && candidates.length > 0 ? sample(candidates) : null;
  const fallback =
    demoFirstDayOpeningMoveSpeech(input.speechPlan?.firstDayOpeningMove, suspect, language) ??
    buildDemoDaySituationSpeech(input, language) ??
    sample(demoSpeechForRole(speechPool, input.player.role));
  const metadata = emptySpeechMetadata();
  const trustPool = suspect ? candidates.filter((candidate) => candidate.id !== suspect.id) : candidates;
  const trusted = trustPool.length > 0 ? sample(trustPool) : null;
  const personaReason = sample(reasonPool);

  if (suspect) {
    metadata.suspects.push({
      targetId: suspect.id,
      targetName: suspect.name,
      reason: personaReason,
      weight: openingFirstDay ? (input.player.persona === "aggressive" ? 0.46 : 0.34) : input.player.persona === "aggressive" ? 0.78 : 0.58
    });
  }

  if (trusted && !openingFirstDay && input.player.persona !== "aggressive") {
    metadata.trusts.push({
      targetId: trusted.id,
      targetName: trusted.name,
      reason: japanese ? "発言と投票の理由が一貫している" : "their pressure has been consistent with their stated read",
      weight: input.player.persona === "empathetic" ? 0.66 : 0.52
    });
  }

  const seerResult = Object.entries(input.player.seerResults).at(-1);
  if (input.player.role === "Seer" && seerResult) {
    const [targetId, camp] = seerResult;
    const name = targetName(targetId, input.knownPlayers);
    const shouldClaim = camp === "werewolf" || !firstDaySoft;
    if (shouldClaim) {
      metadata.claims.push({
        type: "role_claim",
        role: "Seer",
        result: {
          targetId,
          targetName: name,
          camp,
          round: input.player.seerResultRounds[targetId]
        },
        note: japanese ? `${name}は${campLabel(camp, language)}判定` : `${name} checked as ${camp}`
      });
      return {
        messages: buildDemoSpeechMessages(
          [
            japanese
              ? `ここで${roleLabel("Seer", language)}を名乗ります。${name}は${campLabel(camp, language)}判定です。`
              : `I am claiming Seer now: ${name} checked as ${camp}.`,
            suspect
              ? japanese
                ? `${suspect.name}も投票候補に入れます。${japaneseReasonSentence(personaReason)}`
                : `${suspect.name} still needs pressure because ${personaReason}.`
              : fallback
          ],
          language
        ),
        metadata
      };
    }
  }

  if (input.player.role === "Witch" && input.player.memories.some((memory) => /saved|poisoned/.test(memory))) {
    metadata.claims.push({
      type: "role_claim",
      role: "Witch",
      note: japanese ? "夜の状況に関わる薬の情報があります。" : "I have potion information that affects the night story."
    });
  }

  if (input.player.role === "Guard" && input.player.memories.some((memory) => memory.includes("protected"))) {
    metadata.claims.push({
      type: "role_claim",
      role: "Guard",
      note: japanese ? "私の護衛先が夜の結果を説明できるかもしれません。" : "My protection choice may explain the night outcome."
    });
  }

  if (input.player.role === "Hunter" && weightedChance(0.2)) {
    metadata.claims.push({
      type: "role_claim",
      role: "Hunter",
      note: suspect
        ? japanese
          ? `私が死ぬなら、撃つ候補は${suspect.name}です。`
          : `If I die, ${suspect.name} is my likely shot.`
        : japanese
          ? "私は安易に吊っていい人ではありません。"
          : "I am not an easy safe elimination."
    });
  }

  const fakeClaimChance = situations.includes("seer_claim") || situations.includes("black_result") ? 0.16 : 0.06;
  if (input.player.camp === "werewolf" && suspect && !firstDaySoft && weightedChance(fakeClaimChance)) {
    metadata.claims.push({
      type: "role_claim",
      role: "Seer",
      result: {
        targetId: suspect.id,
        targetName: suspect.name,
        camp: "werewolf"
      },
      note: japanese ? "疑いを向けるための偽主張" : "Fake pressure claim"
    });
    return {
      messages: buildDemoSpeechMessages(
        [
          japanese
            ? `強い主張が必要なら、私は${roleLabel("Seer", language)}として出ます。${suspect.name}は${campLabel("werewolf", language)}判定です。`
            : `I am willing to claim Seer if the table needs a hard line: ${suspect.name} reads as werewolf.`,
          japanese ? "動きが不自然です。" : "Their movement is too convenient."
        ],
        language
      ),
      metadata
    };
  }

  const flavor = demoCharacterFlavorLine(input, language);
  return {
    messages: buildDemoSpeechMessages(
      [
        flavor ?? fallback,
        flavor ? fallback : "",
        suspect
          ? japanese
            ? `${suspect.name}が気になります。${japaneseReasonSentence(personaReason)}`
            : `${suspect.name} stands out because ${personaReason}.`
          : ""
      ],
      language
    ),
    metadata
  };
}

// --- Day-1 warm-up self-introduction -----------------------------------------

function buildIntroSystemPrompt(language: string, persona: Persona): string {
  const persona_ = personaLabel(persona, language);
  if (isJapaneseLanguage(language)) {
    return [
      "あなたは人狼ゲームのプレイヤーです。議論が始まる前の、ごく軽い自己紹介と挨拶をします。",
      `性格・話し方の傾向は「${persona_}」。性格は説明せず、口調や言い回しで自然ににじませてください。`,
      "ルール: 1〜2文の短さ。役職・陣営・占い等には触れない。誰かへの疑い・信頼・投票の話もまだしない。挨拶と人柄だけ。",
      "重要: 『普段は〜』のような決まり文句や、毎回同じ書き出しは禁止。切り出し方は一人ひとり変え、自分の言葉で自然に。",
      "出力は表示するセリフそのものだけ。前置きや説明は不要。"
    ].join("\n");
  }
  return [
    "You are a player in a hidden-role werewolf game, giving a very light self-introduction and greeting before the discussion begins.",
    `Your personality/speaking style leans "${persona_}"; do not state it outright — let it show through your tone and word choice.`,
    "Rules: 1-2 short sentences. Do NOT mention roles, camps, or seer results. Do NOT state suspicion, trust, or votes yet. Greeting and personality only.",
    "Important: no stock opener like \"I usually...\"; vary how you open and use your own natural voice.",
    "Output only the spoken line itself; no preamble or explanation."
  ].join("\n");
}

function defaultIntroLine(name: string, language: string): string {
  return isJapaneseLanguage(language) ? `${name}です、よろしく。` : `I'm ${name}, nice to meet you all.`;
}

// System prompt for the first-day werewolf face-off: allies-only, so the player owns their
// werewolf-camp role here (unlike the public warm-up intro, which forbids role talk).
function buildWerewolfIntroSystemPrompt(language: string, persona: Persona, role: Role | undefined): string {
  const persona_ = personaLabel(persona, language);
  const roleName = roleLabel(role, language);
  if (isJapaneseLanguage(language)) {
    return [
      "あなたは人狼ゲームのプレイヤーです。夜明け前、人狼陣営だけが集まる内緒の顔合わせの場で、仲間に向けて短く名乗ります。",
      `性格・話し方の傾向は「${persona_}」。性格は説明せず、口調や言い回しで自然ににじませてください。`,
      `あなたの役職は「${roleName}」。仲間にだけ、自分が${roleName}であることをはっきり名乗ってください（例: 「俺が${roleName}だ」のように自分の言葉で）。`,
      "ルール: 1〜2文の短さ。ここは味方だけの場なので正体は隠さない。ただし襲撃先や具体的な作戦の相談はまだしない。挨拶と自分の役職の名乗りだけ。",
      "重要: 『普段は〜』のような決まり文句や、毎回同じ書き出しは禁止。切り出し方は自分の言葉で自然に。",
      "出力は表示するセリフそのものだけ。前置きや説明は不要。"
    ].join("\n");
  }
  return [
    "You are a player in a hidden-role werewolf game. Before dawn, the werewolf team meets privately; you introduce yourself to your fellow wolves.",
    `Your personality/speaking style leans "${persona_}"; do not state it outright — let it show through your tone and word choice.`,
    `Your role is "${roleName}". To your allies only, clearly own that you are the ${roleName} (e.g. "I'm the ${roleName}", in your own voice).`,
    "Rules: 1-2 short sentences. This is allies-only, so do NOT hide your identity, but do NOT discuss attack targets or concrete plans yet. Just a greeting and naming your role.",
    "Important: no stock opener like \"I usually...\"; open in your own natural voice.",
    "Output only the spoken line itself; no preamble or explanation."
  ].join("\n");
}

function defaultWerewolfIntroLine(name: string, role: Role | undefined, language: string): string {
  const roleName = roleLabel(role, language);
  return isJapaneseLanguage(language) ? `${name}だ。俺が${roleName}、よろしく頼む。` : `I'm ${name} — I'm the ${roleName}, let's work together.`;
}

export class DemoAgent implements Agent {
  constructor(
    public readonly name: string,
    public readonly model = "demo",
    protected readonly language = defaultLanguage
  ) {}

  async speak(input: AgentSpeechInput): Promise<AgentSpeech> {
    return finalizeDemoSpeech(buildDemoSpeech(input, this.language), this.language);
  }

  async improviseIntro(input: AgentSpeechInput): Promise<AgentSpeech> {
    const persona_ = personaLabel(input.player.persona, this.language);
    const name = input.player.name;
    // Vary the opener per player (stable by id, no RNG) so the table does not read as
    // identical templated lines, and never lead with a stock "普段は" phrase.
    const variants = isJapaneseLanguage(this.language)
      ? [
          `${name}です、よろしく。${persona_}なタイプだけど仲良くやろう。`,
          `どうも、${name}。${persona_}な感じで進めるね。`,
          `${name}だよ。${persona_}なほうだと思う、よろしく。`,
          `こんにちは、${name}。${persona_}な性格、よろしく頼むね。`
        ]
      : [
          `I'm ${name} — nice to meet you all. I lean ${persona_}, by the way.`,
          `Hey, ${name} here. I tend to come off ${persona_}.`,
          `${name}, good to be here — the ${persona_} sort.`,
          `Hi all, ${name}. A bit ${persona_}, but let's get along.`
        ];
    const index = [...input.player.id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % variants.length;
    const line = variants[index];
    return {
      messages: [normalizeSpeechLine(line, line, this.language)],
      metadata: { suspects: [], trusts: [], claims: [] }
    };
  }

  async improviseWerewolfIntro(input: AgentSpeechInput): Promise<AgentSpeech> {
    const persona_ = personaLabel(input.player.persona, this.language);
    const name = input.player.name;
    const roleName = roleLabel(input.player.role, this.language);
    const variants = isJapaneseLanguage(this.language)
      ? [
          `${name}だ。俺が${roleName}、よろしく頼む。`,
          `どうも、${name}。${roleName}担当だ、${persona_}なりにやるよ。`,
          `${name}です。${roleName}なので、仲間としてよろしく。`,
          `こんばんは、${name}。こっちが${roleName}、${persona_}だけど頼りにしてくれ。`
        ]
      : [
          `I'm ${name} — I'm the ${roleName}, count me in.`,
          `Hey, ${name} here. I'm the ${roleName}; I'll play it ${persona_}.`,
          `${name}, and I'm the ${roleName}. Good to have allies.`,
          `Evening — ${name}, the ${roleName}. A bit ${persona_}, but lean on me.`
        ];
    const index = [...input.player.id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % variants.length;
    const line = variants[index];
    return {
      messages: [normalizeSpeechLine(line, line, this.language)],
      metadata: { suspects: [], trusts: [], claims: [] }
    };
  }

  async chooseTarget(input: AgentTargetInput): Promise<TargetDecision> {
    if (input.allowSkip && weightedChance(0.35)) {
      return {
        targetId: null,
        reason: isJapaneseLanguage(this.language)
          ? input.player.persona === "cautious"
            ? "今は選択肢を残す方が低リスクです。"
            : "ここで見送る方が後半の手を残せます。"
          : input.player.persona === "cautious"
            ? "Saving the option is lower risk right now."
            : "Skipping keeps more leverage for later."
      };
    }
    if (input.candidates.length === 0) {
      return {
        targetId: null,
        reason: isJapaneseLanguage(this.language) ? "選べる対象がいません。" : "No legal targets are available."
      };
    }
    const publicEvidenceTarget = evidenceTarget(input);
    if (publicEvidenceTarget && weightedChance(0.72)) {
      return {
        targetId: publicEvidenceTarget.id,
        reason: isJapaneseLanguage(this.language)
          ? `${publicEvidenceTarget.name}は公開された主張と発言から最も疑いが集まっています。`
          : `${publicEvidenceTarget.name} has the clearest public pressure from claims and reads.`
      };
    }
    const target = sample(input.candidates);
    return {
      targetId: target.id,
      reason: naturalizeDemoReason(
        buildDemoVotingReason(input, target, this.language) ??
          sample(isJapaneseLanguage(this.language) ? personaReasonsJa[input.player.persona] : personaReasonsEn[input.player.persona]),
        this.language
      )
    };
  }

  async decide(input: AgentBooleanInput): Promise<boolean> {
    if (input.question.toLowerCase().includes("save")) {
      return input.context.includes(input.player.name) || input.context.includes("Round: 1") || weightedChance(0.6);
    }
    if (input.question.toLowerCase().includes("poison")) {
      return weightedChance(0.25);
    }
    return weightedChance(0.5);
  }
}

async function completeAnthropic(
  client: Anthropic,
  model: string,
  system: string,
  messages: MessageParam[],
  maxTokens: number,
  temperature: number,
  timeoutMs?: number,
  signal?: AbortSignal,
  label?: string
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= llmRequestAttempts; attempt += 1) {
    try {
      throwIfAborted(signal);
      const releaseSlot = await acquireLlmSlot(signal, { model, maxTokens, label });
      const configuredTimeoutMs = positiveInt(process.env.ZAI_TIMEOUT_MS ?? process.env.LLM_TIMEOUT_MS, defaultLlmTimeoutMs);
      const abortTimeoutMs = timeoutMs ?? configuredTimeoutMs;
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let abortFromExternalSignal: (() => void) | null = null;
      const abortGate = new Promise<never>((_, reject) => {
        const rejectWithAbort = (error: Error) => {
          controller.abort();
          reject(error);
        };
        abortFromExternalSignal = () => {
          rejectWithAbort(abortError());
        };
        if (signal?.aborted) {
          abortFromExternalSignal();
          return;
        }
        signal?.addEventListener("abort", abortFromExternalSignal, { once: true });
        timeout = setTimeout(() => {
          rejectWithAbort(abortError("LLM request timed out."));
        }, abortTimeoutMs);
      });
      const abortFromExternalSignalForCleanup = abortFromExternalSignal;
      if (!abortFromExternalSignalForCleanup) {
        controller.abort();
        throw abortError();
      }
      try {
        const request = client.messages.create(
          {
            model,
            system,
            messages,
            max_tokens: maxTokens,
            thinking: { type: "disabled" },
            temperature
          },
          { signal: controller.signal }
        );
        const response = await Promise.race([request, abortGate]);
        const textBlock = response.content.find((block): block is TextBlock => block.type === "text");
        return textBlock?.text ?? "";
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
        signal?.removeEventListener("abort", abortFromExternalSignalForCleanup);
        releaseSlot();
      }
    } catch (error) {
      lastError = error;
      if (!isRetryableAnthropicError(error) || attempt === llmRequestAttempts) {
        throw error;
      }
      await sleep(retryDelayMs(attempt));
    }
  }
  throw lastError;
}

export async function summarizeRoundWithLlm(input: {
  deterministicMessage: string;
  round: number;
  model: string;
  language: string;
  data: Record<string, unknown>;
  abortSignal?: AbortSignal;
}): Promise<string | null> {
  const apiKey = process.env.ZAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const system = [
    promptMaterials.roundSummary.systemPreamble,
    promptMaterials.roundSummary.jsonInstruction,
    summaryStyleInstruction(input.language),
    promptMaterials.roundSummary.brevityInstruction,
    promptMaterials.roundSummary.sourcePolicy,
    `Respond in ${input.language}.`
  ].join("\n");
  const messages: MessageParam[] = [
    {
      role: "user",
      content: [
        `Round: ${input.round}`,
        `Deterministic summary: ${input.deterministicMessage}`,
        "Structured public round data:",
        JSON.stringify(input.data)
      ].join("\n")
    }
  ];
  const model = input.model || process.env.ZAI_MODEL || process.env.OPENAI_MODEL || defaultZaiModel;
  const client = createAnthropicClient(
    apiKey,
    process.env.ZAI_BASE_URL ?? process.env.OPENAI_BASE_URL ?? defaultZaiBaseUrl,
    positiveInt(process.env.ZAI_TIMEOUT_MS ?? process.env.LLM_TIMEOUT_MS, defaultLlmTimeoutMs)
  );
  const content = await completeAnthropic(client, model, system, messages, 512, 0.35, undefined, input.abortSignal, "recap");

  return normalizeLlmSummary(content);
}

/**
 * Director-layer completion. Runs a single omniscient planning call that returns
 * a round-script (beats/arc/directives) as raw JSON text. Returns null when no
 * API key is configured so the caller can fall back to a deterministic script.
 */
export async function runDirectorCompletion(input: {
  system: string;
  user: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
}): Promise<string | null> {
  const apiKey = process.env.ZAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }
  const model = input.model || process.env.ZAI_MODEL || process.env.OPENAI_MODEL || defaultZaiModel;
  const client = createAnthropicClient(
    apiKey,
    process.env.ZAI_BASE_URL ?? process.env.OPENAI_BASE_URL ?? defaultZaiBaseUrl,
    positiveInt(process.env.ZAI_TIMEOUT_MS ?? process.env.LLM_TIMEOUT_MS, defaultLlmTimeoutMs)
  );
  const messages: MessageParam[] = [{ role: "user", content: input.user }];
  return completeAnthropic(
    client,
    model,
    input.system,
    messages,
    input.maxTokens ?? 1024,
    input.temperature ?? 0.6,
    undefined,
    input.abortSignal,
    "director"
  );
}

type CompleteRequest = (
  system: string,
  messages: MessageParam[],
  maxTokens: number,
  temperature: number,
  timeoutMs?: number,
  signal?: AbortSignal,
  label?: string
) => Promise<string>;

class LlmAgent implements Agent {
  constructor(
    public readonly name: string,
    public readonly model: string,
    private readonly language: string,
    private readonly maxTokens: number,
    private readonly completeRequest: CompleteRequest
  ) {}

  async speak(input: AgentSpeechInput): Promise<AgentSpeech> {
    const legalPlayers = input.legalPlayers ?? input.knownPlayers;
    // The opening turn's plan does not require a forward move; pass that through so
    // the system prompts suppress their stance-forcing guidance too (the context
    // alone is not enough — the forcing also lives in the reasoning/realization
    // system prompts).
    const requiresForwardMove = input.speechPlan?.requiresForwardMove ?? true;
    const reasoningSystem = buildSpeechReasoningSystemPrompt({
      player: input.player,
      phase: input.phase,
      language: this.language,
      legalPlayers,
      requiresForwardMove
    });
    const reasoningContent = await this.complete(
      reasoningSystem,
      [
        {
          role: "user",
          content: [input.context, "", `Task: ${input.task}`].join("\n")
        }
      ],
      this.maxTokens,
      input.abortSignal,
      "speech.reasoning"
    );
    const reasoning = parseSpeechReasoning(reasoningContent, legalPlayers, this.language, input.knownPlayers);
    const fallback = speechReasoningFallback(reasoning, input, this.language);
    const realizationSystem = buildSpeechRealizationSystemPrompt({
      player: input.player,
      phase: input.phase,
      language: this.language,
      legalPlayers,
      requiresForwardMove
    });
    let realizationContent: string;
    try {
      realizationContent = await this.complete(
        realizationSystem,
        [
          {
            role: "user",
            content: speechRealizationUserContent(reasoning, this.language)
          }
        ],
        Math.min(this.maxTokens, defaultLlmMaxTokens),
        input.abortSignal,
        "speech.realization"
      );
    } catch (error) {
      if (input.abortSignal?.aborted || isAbortLikeError(error)) {
        throw error;
      }
      return {
        messages: [normalizeSpeechLine(fallback, fallback, this.language)],
        metadata: reasoning.metadata
      };
    }
    const messages = parseSpeechRealizationMessages(realizationContent, fallback, this.language);

    return {
      messages: messages.length > 0 ? messages : [normalizeSpeechLine(fallback, fallback, this.language)],
      metadata: reasoning.metadata
    };
  }

  // Single fast call (no reasoning stage) for the day-1 warm-up greeting.
  async improviseIntro(input: AgentSpeechInput): Promise<AgentSpeech> {
    const system = buildIntroSystemPrompt(this.language, input.player.persona);
    const fallback = defaultIntroLine(input.player.name, this.language);
    const content = await this.complete(
      system,
      [{ role: "user", content: input.context }],
      introMaxTokens,
      input.abortSignal,
      "speech.intro"
    );
    const messages = parseSpeechRealizationMessages(content, fallback, this.language);
    return {
      messages: messages.length > 0 ? messages : [normalizeSpeechLine(fallback, fallback, this.language)],
      metadata: { suspects: [], trusts: [], claims: [] }
    };
  }

  async improviseWerewolfIntro(input: AgentSpeechInput): Promise<AgentSpeech> {
    const system = buildWerewolfIntroSystemPrompt(this.language, input.player.persona, input.player.role);
    const fallback = defaultWerewolfIntroLine(input.player.name, input.player.role, this.language);
    const content = await this.complete(
      system,
      [{ role: "user", content: input.context }],
      introMaxTokens,
      input.abortSignal,
      "speech.intro"
    );
    const messages = parseSpeechRealizationMessages(content, fallback, this.language);
    return {
      messages: messages.length > 0 ? messages : [normalizeSpeechLine(fallback, fallback, this.language)],
      metadata: { suspects: [], trusts: [], claims: [] }
    };
  }

  async chooseTarget(input: AgentTargetInput): Promise<TargetDecision> {
    if (input.candidates.length === 0) {
      return {
        targetId: null,
        reason: isJapaneseLanguage(this.language) ? "選べる対象がいません。" : "No legal targets are available."
      };
    }

    const japanese = isJapaneseLanguage(this.language);
    const system = buildTargetSystemPrompt({
      player: input.player,
      phase: input.phase,
      language: this.language,
      legalPlayers: input.candidates,
      allowSkip: input.allowSkip
    });
    const messages: MessageParam[] = [
      {
        role: "user",
        content: japanese
          ? [input.context, "", `行動: ${input.action}`, "選べる対象:", buildTargetList(input.candidates)].join("\n")
          : [input.context, "", `Action: ${input.action}`, "Legal targets:", buildTargetList(input.candidates)].join("\n")
      }
    ];

    for (let attempt = 0; attempt < targetSelectionAttempts; attempt += 1) {
      const content = await this.complete(system, messages, targetDecisionMaxTokens, input.abortSignal, "decision.target");
      const selection = parseTargetSelection(content, input.candidates, input.allowSkip);
      if (selection.valid) {
        return normalizeTargetDecision(selection.decision, input.candidates, this.language, input.phase);
      }

      messages.push({
        role: "assistant",
        content: content || "(empty response)"
      });
      messages.push({
        role: "user",
        content: japanese
          ? [
              "直前の返答は、対象選択の JSON として不正か、一覧にない対象 ID を選んでいました。",
              "厳密な JSON だけでやり直してください。",
              `選べる対象 ID: ${input.candidates.map((candidate) => candidate.id).join(", ")}。`,
              input.allowSkip
                ? '選ばない場合だけ {"targetId":null,"reason":"短い理由"} を使えます。'
                : "必ず一覧にある対象 ID を一つ選んでください。"
            ].join("\n")
          : [
              "Your previous response was not valid target-selection JSON or selected an illegal target.",
              "Retry with strict JSON only.",
              `Legal target ids: ${input.candidates.map((candidate) => candidate.id).join(", ")}.`,
              input.allowSkip ? 'Use {"targetId":null,"reason":"short reason"} only if skipping.' : "You must choose one listed target id."
            ].join("\n")
      });
    }

    const fallbackTarget = sample(input.candidates);
    return {
      targetId: fallbackTarget.id,
      reason: isJapaneseLanguage(this.language)
        ? "対象選択JSONが不正だったため、合法な対象を代替選択しました。"
        : "Fallback legal choice after invalid target JSON."
    };
  }

  async decide(input: AgentBooleanInput): Promise<boolean> {
    const system = buildBooleanSystemPrompt({
      player: input.player,
      phase: input.phase,
      language: this.language
    });
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [input.context, "", `Question: ${input.question}`].join("\n")
      }
    ];

    for (let attempt = 0; attempt < booleanDecisionAttempts; attempt += 1) {
      const content = await this.complete(system, messages, booleanDecisionMaxTokens, input.abortSignal, "decision.boolean");
      const decision = parseBooleanDecision(content);
      if (decision.valid) {
        return decision.decision;
      }

      messages.push({
        role: "assistant",
        content: content || "(empty response)"
      });
      messages.push({
        role: "user",
        content: [
          "Your previous response was not valid boolean-decision JSON.",
          "Retry with strict JSON only.",
          'Use exactly this shape: {"decision":true,"reason":"short reason"} or {"decision":false,"reason":"short reason"}.'
        ].join("\n")
      });
    }

    return false;
  }

  private async complete(
    system: string,
    messages: MessageParam[],
    maxTokens = this.maxTokens,
    signal?: AbortSignal,
    label?: string
  ): Promise<string> {
    return this.completeRequest(system, messages, maxTokens, 0.8, undefined, signal, label);
  }
}

export class AnthropicAgent extends LlmAgent {
  constructor(
    name: string,
    client: Anthropic,
    model: string,
    language: string,
    maxTokens = defaultLlmMaxTokens
  ) {
    super(name, model, language, maxTokens, (system, messages, requestMaxTokens, temperature, timeoutMs, signal, label) =>
      completeAnthropic(client, model, system, messages, requestMaxTokens, temperature, timeoutMs, signal, label)
    );
  }
}

export function createAgentFactory(options: {
  provider: "demo" | "llm";
  model: string;
  language: string;
}): (name: string) => Agent {
  const apiKey = process.env.ZAI_API_KEY || process.env.OPENAI_API_KEY;
  const configuredModel = options.model || process.env.ZAI_MODEL || process.env.OPENAI_MODEL || defaultZaiModel;
  const maxTokens = positiveInt(process.env.ZAI_MAX_TOKENS ?? process.env.LLM_MAX_TOKENS, defaultLlmMaxTokens);
  const anthropicCompatibleClient = apiKey
    ? createAnthropicClient(
        apiKey,
        process.env.ZAI_BASE_URL ?? process.env.OPENAI_BASE_URL ?? defaultZaiBaseUrl,
        positiveInt(process.env.ZAI_TIMEOUT_MS ?? process.env.LLM_TIMEOUT_MS, defaultLlmTimeoutMs)
      )
    : null;

  return (name: string) => {
    if (options.provider === "llm" && anthropicCompatibleClient) {
      return new AnthropicAgent(name, anthropicCompatibleClient, configuredModel, options.language, maxTokens);
    }
    return new DemoAgent(name, options.provider === "llm" ? "demo-fallback" : "demo", options.language);
  };
}
