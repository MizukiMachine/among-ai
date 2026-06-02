import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { completeWithRetry, createLlmClient, createLlmQueue, parseJsonObject, type LlmTraceEvent } from "llm-hedge";
import { claimedRoleBySpeakerFromText, detectDaySituations, type DaySituation } from "./daySituations";
import { stripJapaneseSpeechTerminalPeriod } from "./japaneseStyle";
import {
  buildTargetList,
  buildBooleanSystemPrompt,
  buildSimpleSpeechSystemPrompt,
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
  FirstDayOpeningMove,
  Persona,
  Role,
  SpeechMetadata,
  TargetCandidate,
  TargetDecision,
  TargetReasonKind
} from "./types";

const defaultLlmTimeoutMs = 120_000;
const defaultLlmMaxTokens = 384;
const targetDecisionMaxTokens = 160;
const booleanDecisionMaxTokens = 96;
// Day-1 warm-up opening resolves are short and single-call (no reasoning stage).
const introMaxTokens = 140;
const defaultZaiBaseUrl = "https://api.z.ai/api/anthropic";
const defaultZaiModel = "glm-5-turbo";
const fixedLlmRequestConcurrency = 5;
const fixedLlmRequestMinIntervalMs = 0;
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
    "初日は疑いを急がず、投票理由を一人一つ残す形にしたいです。",
    "まだ情報が少ないので、占い師が名乗る条件と投票基準を先に決めましょう。",
    "今日は強く決めませんが、理由を出さずに流れに乗る人は投票候補に入れます。"
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
  "初日なので決め打ちはしません。まず全員が投票理由を一つ残す形にしたいです。",
  "まだ誰の発言も材料にしません。占い師が名乗る条件だけ先に決めましょう。",
  "初日は情報が少ないので、理由を出さずに乗る人は投票候補に入れます。"
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

function normalizeSpeechLine(text: string, fallback: string, language: string): string {
  return stripJapaneseSpeechTerminalPeriod(clampText(text, fallback), language);
}

function stripSpeechMessageLabel(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const speechLabel = trimmed.match(/^(?:実際の発話|発話|発言|セリフ|台詞|speech|spoken line|message|line)\s*[:：]\s*(.+)$/iu);
  if (speechLabel?.[1]) {
    return speechLabel[1].trim();
  }
  if (/^(?:方針|思考|理由|分析|狙い|作戦|計画|plan|strategy|reasoning|analysis|rationale)\s*[:：]/iu.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function normalizeSpeechMessages(messagesSource: string[], fallback: string, language: string): string[] {
  return messagesSource
    .map(stripSpeechMessageLabel)
    .filter((message): message is string => Boolean(message))
    .flatMap(splitSpeechText)
    .filter((message) => message.length > 0 && !isSpeechJsonLeak(message))
    .slice(0, maxSpeechMessages)
    .map((message) => normalizeSpeechLine(message, fallback, language))
    .filter(Boolean);
}

function metadataReason(text: string): string {
  const compact = text.replace(/\s+/g, " ").replace(/[。！？.!?]+$/u, "").trim();
  return compact.length > 64 ? `${compact.slice(0, 61)}...` : compact;
}

function sentenceMentionsTarget(sentence: string, target: TargetCandidate): boolean {
  const lower = sentence.toLowerCase();
  return lower.includes(target.name.toLowerCase()) || lower.includes(target.id.toLowerCase());
}

function sentenceHasSuspicion(sentence: string, language: string): boolean {
  if (isJapaneseLanguage(language)) {
    return /疑|怪し|引っかか|気になる|違和感|不自然|投票候補|吊り候補|黒|人狼|狼|薄い|弱い|圧|警戒|便乗/u.test(sentence);
  }
  return /\b(?:suspect|suspicious|pressure|pressured|vote candidate|vote pool|wolfy|werewolf|doubt|concern|concerned|shaky|thin|weak|push|scum)\b/iu.test(
    sentence
  );
}

function sentenceHasTrust(sentence: string, language: string): boolean {
  if (isJapaneseLanguage(language)) {
    return /信頼|信用|白|人間側|村側|村っぽ|信じ|一貫|頼り|安心/u.test(sentence);
  }
  return /\b(?:trust|trusted|clear|village|town|reliable|believe|white|safe|consistent)\b/iu.test(sentence);
}

function inferSpeechMetadata(messages: string[], input: AgentSpeechInput, language: string): SpeechMetadata {
  const metadata = emptySpeechMetadata();
  const text = messages.join(" ");
  const sentences = messages.flatMap(splitSpeechText);
  const targets = (input.legalPlayers ?? input.knownPlayers).filter((target) => target.id !== input.player.id);
  const otherPlayerNames = targets.map((target) => target.name);
  const seenSuspects = new Set<string>();
  const seenTrusts = new Set<string>();

  for (const sentence of sentences) {
    for (const target of targets) {
      if (!sentenceMentionsTarget(sentence, target)) {
        continue;
      }
      if (!seenSuspects.has(target.id) && sentenceHasSuspicion(sentence, language)) {
        seenSuspects.add(target.id);
        metadata.suspects.push({
          targetId: target.id,
          targetName: target.name,
          reason: metadataReason(sentence),
          weight: 0.55
        });
      } else if (!seenTrusts.has(target.id) && sentenceHasTrust(sentence, language)) {
        seenTrusts.add(target.id);
        metadata.trusts.push({
          targetId: target.id,
          targetName: target.name,
          reason: metadataReason(sentence),
          weight: 0.5
        });
      }
    }
  }

  const claimedRole = claimedRoleBySpeakerFromText(text, language, input.player.name, otherPlayerNames);
  if (claimedRole) {
    metadata.claims.push({
      type: "role_claim",
      role: claimedRole,
      note: metadataReason(text)
    });
  }

  return metadata;
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

function emptySpeechMetadata(): SpeechMetadata {
  return {
    suspects: [],
    trusts: [],
    claims: []
  };
}

function simpleSpeechFallbackLine(input: AgentSpeechInput, language: string): string {
  const japanese = isJapaneseLanguage(language);
  if (input.phase === "werewolf_discussion" && input.player.camp === "werewolf") {
    return japanese ? "昼は自然に人間側らしく話します" : "I will sound natural on the village side during the day.";
  }
  if (input.phase === "voting") {
    return japanese ? "今日の発言を見て投票先を決めます" : "I will vote from what was said today.";
  }
  return japanese ? "今は見えている発言から考えます" : "I am reading from what is visible.";
}

export function buildSimpleFallbackSpeech(input: AgentSpeechInput, language: string = defaultLanguage): AgentSpeech {
  const line = simpleSpeechFallbackLine(input, language);
  return {
    messages: [normalizeSpeechLine(line, line, language)],
    metadata: emptySpeechMetadata()
  };
}

function parseDisplayedSpeechMessages(content: string, fallback: string, language: string): string[] {
  const parsed = parseJsonObject(content);
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

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

// LlmTraceEvent is owned by llm-hedge; re-exported so trace tooling can keep
// `import { type LlmTraceEvent } from "../src/game/agents"`.
export type { LlmTraceEvent };

let llmTraceSink: ((event: LlmTraceEvent) => void) | null = null;

/** Register (or clear with null) a sink that receives every LLM queue trace event. */
export function setLlmQueueTraceSink(sink: ((event: LlmTraceEvent) => void) | null): void {
  llmTraceSink = sink;
}

function llmQueueTraceEnabled(): boolean {
  return process.env.AMONG_AI_LLM_QUEUE_TRACE === "1";
}

// A single process-wide admission queue shared by every LLM request, preserving
// the previous module-global behavior. The trace callback fans the structured
// event out to the optional in-process sink and, when AMONG_AI_LLM_QUEUE_TRACE=1,
// to stdout (byte-identical to the prior `[llm-queue]` output).
const sharedLlmQueue = createLlmQueue({
  concurrency: fixedLlmRequestConcurrency,
  minIntervalMs: fixedLlmRequestMinIntervalMs,
  onTrace: (event) => {
    llmTraceSink?.(event);
    if (!llmQueueTraceEnabled()) {
      return;
    }
    console.info(`[llm-queue] ${JSON.stringify(event)}`);
  }
});

function parseTargetSelection(
  content: string,
  candidates: AgentTargetInput["candidates"],
  allowSkip: boolean
): { valid: true; decision: TargetDecision } | { valid: false } {
  const parsed = parseJsonObject(content);
  if (!parsed || !Object.hasOwn(parsed, "targetId")) {
    return { valid: false };
  }

  const reason = typeof parsed.reason === "string" ? clampReason(parsed.reason, "Selected by target id.") : "Selected by target id.";
  const reasonKind = normalizeTargetReasonKind(parsed.reasonKind ?? parsed.kind ?? parsed.evidenceKind);
  const targetId = parsed.targetId;
  if (targetId === null || targetId === "null" || targetId === "") {
    return allowSkip ? { valid: true, decision: { targetId: null, reason, reasonKind: reasonKind ?? "skip_preserve" } } : { valid: false };
  }

  if (typeof targetId !== "string") {
    return { valid: false };
  }

  const ids = new Set(candidates.map((candidate) => candidate.id));
  return ids.has(targetId) ? { valid: true, decision: { targetId, reason, reasonKind } } : { valid: false };
}

function parseBooleanDecision(content: string): { valid: true; decision: boolean } | { valid: false } {
  const parsed = parseJsonObject(content);
  return typeof parsed?.decision === "boolean" ? { valid: true, decision: parsed.decision } : { valid: false };
}

function targetName(targetId: string, candidates: TargetCandidate[]): string {
  return candidates.find((candidate) => candidate.id === targetId)?.name ?? targetId;
}

const targetReasonKinds = new Set<TargetReasonKind>([
  "public_suspicion",
  "claim_reaction",
  "vote_reason",
  "stance_change",
  "weak_reason",
  "coordination_threat",
  "role_threat",
  "protect_value",
  "check_value",
  "risk_control",
  "skip_preserve",
  "legal_fallback"
]);

function normalizeTargetReasonKind(value: unknown): TargetReasonKind | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return targetReasonKinds.has(normalized as TargetReasonKind) ? (normalized as TargetReasonKind) : undefined;
}

function fallbackTargetReasonKind(decision: TargetDecision, phase: AgentTargetInput["phase"], action: string): TargetReasonKind {
  if (!decision.targetId) {
    return "skip_preserve";
  }
  const text = `${phase} ${action}`.toLowerCase();
  if (text.includes("seer") || text.includes("占い")) {
    return "check_value";
  }
  if (text.includes("guard") || text.includes("護衛")) {
    return "protect_value";
  }
  if (text.includes("poison") || text.includes("毒")) {
    return "risk_control";
  }
  if (text.includes("kill") || text.includes("attack") || text.includes("襲撃")) {
    return "coordination_threat";
  }
  return phase === "voting" ? "public_suspicion" : "legal_fallback";
}

function fallbackTargetReason(
  decision: TargetDecision,
  candidates: TargetCandidate[],
  language: string,
  phase: AgentTargetInput["phase"],
  action: string
): string {
  const target = decision.targetId ? candidates.find((candidate) => candidate.id === decision.targetId) : null;
  const kind = decision.reasonKind ?? fallbackTargetReasonKind(decision, phase, action);
  if (isJapaneseLanguage(language)) {
    if (!target) {
      return kind === "skip_preserve" ? "今は選ばず、後半の選択肢を残します。" : "今回は対象を選びません。";
    }
    if (kind === "claim_reaction") {
      return `${target.name}は役職主張への反応がはっきりしないためです。`;
    }
    if (kind === "vote_reason") {
      return `${target.name}は投票理由をもう一度確認したいためです。`;
    }
    if (kind === "stance_change") {
      return `${target.name}は発言の変化が気になるためです。`;
    }
    if (kind === "weak_reason") {
      return `${target.name}は理由の薄さが残るためです。`;
    }
    if (kind === "coordination_threat") {
      return `${target.name}は議論をまとめる力があり、残すと人間側がまとまりやすいためです。`;
    }
    if (kind === "role_threat") {
      return `${target.name}は役職情報につながる可能性が高いためです。`;
    }
    if (kind === "protect_value") {
      return `${target.name}を守る価値が今の状況で高いためです。`;
    }
    if (kind === "check_value") {
      return `${target.name}の立場を早めに確かめる価値があるためです。`;
    }
    if (kind === "risk_control") {
      return `${target.name}を残すリスクが今の状況で大きいためです。`;
    }
    return phase === "voting"
      ? `${target.name}は今日の発言で一番疑いが残るためです。`
      : `${target.name}を選ぶのが今の状況で一番よいと判断しました。`;
  }
  if (!target) {
    return kind === "skip_preserve" ? "Skipping preserves the option for later." : "Skipping is the best available choice.";
  }
  if (kind === "claim_reaction") {
    return `${target.name}'s reaction to the role claim is still unclear.`;
  }
  if (kind === "vote_reason") {
    return `${target.name}'s vote reason needs another check.`;
  }
  if (kind === "stance_change") {
    return `${target.name}'s public stance changed in a way that needs pressure.`;
  }
  if (kind === "weak_reason") {
    return `${target.name}'s reason is still too thin.`;
  }
  if (kind === "coordination_threat") {
    return `${target.name} is likely to coordinate the village if left alive.`;
  }
  if (kind === "role_threat") {
    return `${target.name} is the strongest threat to expose role information.`;
  }
  if (kind === "protect_value") {
    return `${target.name} is the highest-value protection target right now.`;
  }
  if (kind === "check_value") {
    return `${target.name}'s alignment is worth checking early.`;
  }
  if (kind === "risk_control") {
    return `${target.name} is the largest risk to leave unchecked.`;
  }
  return phase === "voting" ? `${target.name} is the most suspicious public vote.` : `${target.name} is the best available target.`;
}

function normalizeTargetDecision(
  decision: TargetDecision,
  candidates: TargetCandidate[],
  language: string,
  phase: AgentTargetInput["phase"],
  action: string
): TargetDecision {
  const reasonKind = decision.reasonKind ?? fallbackTargetReasonKind(decision, phase, action);
  return {
    ...decision,
    reasonKind,
    reason: fallbackTargetReason({ ...decision, reasonKind }, candidates, language, phase, action)
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
  const parsed = parseJsonObject(content);
  const summary = typeof parsed?.summary === "string" ? parsed.summary : content.replace(/```(?:json)?|```/g, "");
  return clampSummary(summary);
}

function naturalizeDemoText(text: string, language: string): string {
  return stripJapaneseSpeechTerminalPeriod(clampText(text, text), language);
}

function buildDemoSpeechMessages(parts: string[], language: string): string[] {
  const messages = parts
    .flatMap(splitSpeechText)
    .map((part) => naturalizeDemoText(part, language))
    .filter(Boolean)
    .slice(0, maxSpeechMessages);
  return messages.length > 0 ? messages : [naturalizeDemoText(parts.join(" "), language)];
}

function naturalizeDemoReason(text: string): string {
  return clampReason(text, text);
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
        reason: read.reason ? naturalizeDemoReason(read.reason) : read.reason
      })),
      trusts: speech.metadata.trusts.map((read) => ({
        ...read,
        reason: read.reason ? naturalizeDemoReason(read.reason) : read.reason
      })),
      claims: speech.metadata.claims.map((claim) => ({
        ...claim,
        note: claim.note ? naturalizeDemoReason(claim.note) : claim.note,
        result: typeof claim.result === "string" ? naturalizeDemoReason(claim.result) : claim.result
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
    ? "今夜は議論をまとめそうな人を優先したいです。明日は全員で人間側の顔をして、残った村を疑わせましょう。"
    : "Tonight I want to remove someone likely to organize the village. Tomorrow we wear village faces and make the survivors doubt each other.";

  if (!target) {
    return {
      messages: buildDemoSpeechMessages([fallback], language),
      metadata: emptySpeechMetadata()
    };
  }

  const messageText = japanese
    ? hasWolfChat
      ? `今夜は${target.name}で合わせたいです。議論をまとめそうな人を噛めば、明日は人間側のふりで疑い先を作りやすいです。`
      : `今夜は${target.name}を襲撃候補にしたいです。発言力を持ちそうな人を先に噛んで、明日の村を崩しやすくしましょう。`
    : hasWolfChat
      ? `I want us to settle on ${target.name} tonight. Removing a likely village anchor gives our public act the cleanest cover tomorrow.`
      : `I want ${target.name} as tonight's victim. Removing a likely village anchor makes tomorrow's table easier to break.`;

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
    return `${target.name}は今日の発言から一番検証しやすい投票先です。`;
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
  const targetName = target?.name ?? (japanese ? "誰か一人" : "someone");
  const targetAddress = target ? `${target.name}さん` : targetName;
  if (japanese) {
    if (move.kind === "opening_resolve") {
      return "まず開幕の姿勢を置きます。私は理由の薄い便乗を投票候補に入れるつもりです";
    }
    if (move.kind === "organize_setup") {
      return "先に段取りを決めたいです。占い師の名乗り条件と投票基準を今合わせませんか";
    }
    if (move.kind === "overstate_village_side") {
      return "私は人間側として動きます。様子見だけの人は初日の投票候補に入れます";
    }
    if (move.kind === "wolf_human_side_claim") {
      return "俺は人間側として村を守る。理由を出さずに様子見する人は投票候補に入れる";
    }
    if (move.kind === "wolf_fake_role_claim") {
      return "私は占い師です。黒結果が出るまでは結果を伏せます。今日は誰がその条件を嫌がるか見たい";
    }
    if (move.kind === "state_vote_criteria") {
      return "今日は理由の具体性と、質問にちゃんと答えたかを投票基準にします";
    }
    if (move.kind === "ask_role_claim_policy") {
      return "占い師は黒結果か吊られそうな時だけ名乗る形にしたいです。反対意見はありますか";
    }
    if (move.kind === "ask_table_question") {
      return `${targetAddress}、最初の投票基準を一つ聞かせてください。私は理由が薄い人を候補に入れます`;
    }
    if (move.kind === "tentative_reaction_read") {
      return `${targetAddress}に先に理由を聞きます。初日は理由を出せない人を疑い寄りで見ます`;
    }
    return "占い師・魔女・騎士への触れ方は早めに決めたいです。役職を明かさせすぎない条件を合わせましょう";
  }

  if (move.kind === "opening_resolve") {
    return "Let me set my opening stance first. I will treat thin follow-along answers as vote candidates today.";
  }
  if (move.kind === "organize_setup") {
    return "Let me organize the plan first. I want us to settle Seer-claim conditions and vote criteria now.";
  }
  if (move.kind === "overstate_village_side") {
    return "I am playing for the village, and I will pressure anyone who hides behind wait-and-see today.";
  }
  if (move.kind === "wolf_human_side_claim") {
    return "I am playing for the village side; passive wait-and-see slots go straight into my vote pool.";
  }
  if (move.kind === "wolf_fake_role_claim") {
    return "I am the Seer. I want to hold results unless I find black; first I want to see who resists that condition.";
  }
  if (move.kind === "state_vote_criteria") {
    return "My vote criteria today are concrete answers and whether people actually take a position.";
  }
  if (move.kind === "ask_role_claim_policy") {
    return "My starting policy is Seers claim on a black result or if pressured; I want objections now.";
  }
  if (move.kind === "ask_table_question") {
    return `${targetName}, give one vote criterion first. Mine is whether the reason is concrete.`;
  }
  if (move.kind === "tentative_reaction_read") {
    return `${targetName}, I am applying light pressure first: no reason means a suspicion lean today.`;
  }
  return "We should set conditions for Seer, Witch, and Guard talk early without forcing them into the open.";
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
  const plannedOpeningMove = input.speechPlan?.opensFirstDay === true && Boolean(input.speechPlan.firstDayOpeningMove);
  const reasonPool = demoSpeechReasonPool(input, situations, language, openingFirstDay);
  const openingTarget = openingFirstDay && candidates.length > 0 ? sample(candidates) : null;
  const suspect = !openingFirstDay && candidates.length > 0 ? sample(candidates) : null;
  const fallback =
    demoFirstDayOpeningMoveSpeech(input.speechPlan?.firstDayOpeningMove, openingTarget ?? suspect, language) ??
    buildDemoDaySituationSpeech(input, language) ??
    sample(demoSpeechForRole(speechPool, input.player.role));
  const metadata = emptySpeechMetadata();
  if ((openingFirstDay || plannedOpeningMove) && input.speechPlan?.firstDayOpeningMove?.kind === "wolf_fake_role_claim") {
    metadata.claims.push({
      type: "role_claim",
      role: "Seer",
      note: japanese ? "初日の反応を見るための占い師主張" : "day-one reaction-test claim"
    });
  }
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

  if (openingFirstDay && openingTarget && input.speechPlan?.firstDayOpeningMove?.kind === "tentative_reaction_read") {
    metadata.suspects.push({
      targetId: openingTarget.id,
      targetName: openingTarget.name,
      reason: japanese ? "最初の返答で考えを確認したい" : "light first-day pressure to test their reason",
      weight: input.player.persona === "aggressive" ? 0.48 : 0.36
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
  const openingMoveFallback = plannedOpeningMove ? fallback : null;
  return {
    messages: buildDemoSpeechMessages(
      [
        openingMoveFallback ?? flavor ?? fallback,
        openingMoveFallback && flavor ? flavor : flavor ? fallback : "",
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

// --- Day-1 warm-up opening resolve -------------------------------------------

function buildIntroSystemPrompt(language: string, persona: Persona): string {
  const persona_ = personaLabel(persona, language);
  if (isJapaneseLanguage(language)) {
    return [
      "あなたは人狼ゲームのプレイヤーです。議論が始まる前に、開幕の短い意気込みを一言だけ話します。",
      "舞台設定: プレイヤー同士は初対面ではありません。同じ宇宙船内のクルーとして互いの名前や普段の雰囲気は知っています。ただし、この対局で誰がどの役職かは知りません。",
      `性格・話し方の傾向は「${persona_}」。性格は説明せず、口調や言い回しで自然ににじませてください。`,
      "ルール: 1〜2文の短さ。役職・陣営・占い等には触れない。誰かへの疑い・信頼・投票の話もまだしない。名前だけの自己紹介や初対面の挨拶にしない。",
      "「はじめまして」「初めまして」は使わない。すでに知っているクルー同士として、これからの議論に向けた姿勢だけを出す。",
      "重要: 毎回同じ書き出しに寄せず、切り出し方は一人ひとり変え、自分の言葉で自然に。",
      "出力は表示するセリフそのものだけ。前置きや説明は不要。"
    ].join("\n");
  }
  return [
    "You are a player in a hidden-role werewolf game, giving one short opening line of resolve before the discussion begins.",
    "Setting: the players are not strangers. They are crew on the same spaceship and already know each other's names and usual demeanor, but they do not know the roles in this match.",
    `Your personality/speaking style leans "${persona_}"; do not state it outright — let it show through your tone and word choice.`,
    "Rules: 1-2 short sentences. Do NOT mention roles, camps, or seer results. Do NOT state suspicion, trust, or votes yet. Do not make it a first-meeting introduction.",
    'Do not say "nice to meet you" or act as if you just met. Speak like crew who already know each other, and show only your stance for the coming discussion.',
    "Important: vary how you open and use your own natural voice.",
    "Output only the spoken line itself; no preamble or explanation."
  ].join("\n");
}

function defaultIntroLine(name: string, language: string): string {
  void name;
  return isJapaneseLanguage(language)
    ? "まずは落ち着いて、理由の残る議論にします。"
    : "I will keep this tight and make my reasons traceable.";
}

function withoutFirstMeetingFraming(messages: string[], language: string): string[] {
  const firstMeeting = isJapaneseLanguage(language)
    ? /(?:はじめまして|初めまして|初対面|初めて(?:会|話))/u
    : /\b(?:nice to meet|first time meeting|strangers?)\b/i;
  return messages.filter((message) => !firstMeeting.test(message));
}

// System prompt for the first-day werewolf face-off: allies-only, so the player owns their
// werewolf-camp role here (unlike the public warm-up intro, which forbids role talk).
function buildWerewolfIntroSystemPrompt(language: string, persona: Persona, role: Role | undefined): string {
  const persona_ = personaLabel(persona, language);
  const roleName = roleLabel(role, language);
  if (isJapaneseLanguage(language)) {
    return [
      "あなたは人狼ゲームのプレイヤーです。夜明け前、人狼陣営だけが集まる内緒の意思合わせの場で、仲間に自分の役職を確認し、「あいつら絶対騙してやる」「人間のフリして潜伏するぜ」のような欺く意気込みを短く話します。",
      "舞台設定: プレイヤー同士は初対面ではありません。同じ宇宙船内のクルーとして互いの名前や普段の雰囲気は知っています。ただし、ここで初めて人狼陣営の仲間と役職内訳を確認します。",
      `性格・話し方の傾向は「${persona_}」。性格は説明せず、口調や言い回しで自然ににじませてください。`,
      `あなたの役職は「${roleName}」。仲間にだけ、自分が${roleName}であることをはっきり確認してください（例: 「俺が${roleName}だ」のように自分の言葉で）。`,
      "ルール: 1〜2文、日本語では70字以内。ここは味方だけの場なので正体は隠さない。初対面の自己紹介や世間話にしない。主軸は作戦説明ではなく、狼同士の悪巧みの意気込み。『騙す』『人間のフリ』『潜伏』『油断させる』のどれかを自然に入れてください。",
      "占い師・霊能などの特殊役職騙りは確定宣言しない。触れる場合は状況次第の選択肢として残し、信用を取る、距離を取る、疑いを作る、票を寄せるなど、人間側の顔で騙す方向にしてください。襲撃先や具体的な夜の作戦はまだ話しません。",
      "入力に『この顔合わせで先に出た仲間の発言』がある場合、それは同じ顔合わせ内で自分より前に話した仲間のセリフです。『あいつら騙そうな』『俺は人間のフリで潜る』のように短く乗ってください。自分も特殊役職を騙る確定宣言で上書きしないでください。",
      "重要: 毎回同じ書き出しに寄せず、切り出し方は自分の言葉で自然に。",
      "出力は表示するセリフそのものだけ。前置きや説明は不要。"
    ].join("\n");
  }
  return [
    'You are a player in a hidden-role werewolf game. Before dawn, the werewolf team meets privately; confirm your role to allies and give a short deceptive rally like "we are going to fool them" or "I will pass as human and stay hidden."',
    "Setting: the players are not strangers. They are crew on the same spaceship and already know each other's names and usual demeanor, but this is when the werewolf team confirms its members and role mix.",
    `Your personality/speaking style leans "${persona_}"; do not state it outright — let it show through your tone and word choice.`,
    `Your role is "${roleName}". To your allies only, clearly own that you are the ${roleName} (e.g. "I'm the ${roleName}", in your own voice).`,
    "Rules: 1-2 short sentences, under 24 words when possible. This is allies-only, so do NOT hide your identity. Do not frame it as meeting strangers. Make it a wolf-to-wolf vow to deceive, not a dry strategy report. Naturally include fooling them, passing as human, staying hidden, or making them lower their guard.",
    "Do not commit to a Seer/Medium/etc. fake claim; if mentioned, keep it situational while choosing a social job such as gaining trust, keeping distance, seeding suspicion, or nudging votes. Do NOT discuss attack targets or concrete night plans yet.",
    'If the input includes "Earlier ally face-off line" entries, they are only allies who spoke before you in this same opening face-off. Answer with a short ally-facing rally such as "let us fool them" or "I will pass as human." Do not overwrite it with a firm special-role fake claim.',
    "Important: open in your own natural voice.",
    "Output only the spoken line itself; no preamble or explanation."
  ].join("\n");
}

function defaultWerewolfIntroLine(name: string, role: Role | undefined, language: string): string {
  const roleName = roleLabel(role, language);
  return isJapaneseLanguage(language)
    ? `俺は${name}、${roleName}だ。人間のフリで潜って、あいつら絶対騙してやる`
    : `I'm ${name}, the ${roleName}; I will pass as human and fool them.`;
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
    // identical templated lines.
    const variants = isJapaneseLanguage(this.language)
      ? [
          `${name}です。今日は焦らず、理由が残る発言で進めます。`,
          `${name}、いつも通り${persona_}寄りで見ます。まずは薄い便乗を流さない。`,
          `${name}だよ。今日は様子見だけで終わらせず、基準を先に置くね。`,
          `${name}。議論が散らないよう、最初から投票理由を残していきます。`
      ]
      : [
          `${name}. I will keep the first day grounded and leave reasons people can check.`,
          `${name} here; I will lean ${persona_} as usual and watch for thin follow-alongs.`,
          `${name}. I do not want us ending at wait-and-see, so I will set criteria early.`,
          `${name}. I will keep the discussion from scattering and make vote reasons visible.`
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
          `俺は${name}、${roleName}だ。人間のフリで潜って、あいつら絶対騙してやる`,
          `${name}は${roleName}担当だ。${persona_}なりに、疑われない位置から騙すよ`,
          `${name}です。${roleName}として人間っぽく信用を取り、村を騙します`,
          `${name}、${roleName}です。あいつらを油断させて、最後まで人間側で通します`
      ]
      : [
          `I'm ${name}, the ${roleName}; I will pass as human and fool them.`,
          `Hey, ${name} here. I'm the ${roleName}; I will sell the act and stay hidden.`,
          `${name}, the ${roleName}. I will build trust first, then trick them with it.`,
          `Evening, ${name}, the ${roleName}; let us make them lower their guard.`
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
          sample(isJapaneseLanguage(this.language) ? personaReasonsJa[input.player.persona] : personaReasonsEn[input.player.persona])
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

// Thin wrapper over llm-hedge's completeWithRetry: resolves the provider/env
// timeout and assembles the (provider-specific) create params, then delegates
// the slot/timeout/retry mechanism to the SDK against the shared queue.
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
  const configuredTimeoutMs = positiveInt(process.env.ZAI_TIMEOUT_MS ?? process.env.LLM_TIMEOUT_MS, defaultLlmTimeoutMs);
  return completeWithRetry({
    client,
    params: {
      model,
      system,
      messages,
      max_tokens: maxTokens,
      thinking: { type: "disabled" },
      temperature
    },
    queue: sharedLlmQueue,
    timeoutMs: timeoutMs ?? configuredTimeoutMs,
    signal,
    label
  });
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
  const client = createLlmClient({
    apiKey,
    baseUrl: process.env.ZAI_BASE_URL ?? process.env.OPENAI_BASE_URL ?? defaultZaiBaseUrl,
    timeoutMs: positiveInt(process.env.ZAI_TIMEOUT_MS ?? process.env.LLM_TIMEOUT_MS, defaultLlmTimeoutMs)
  });
  const content = await completeAnthropic(client, model, system, messages, 512, 0.35, undefined, input.abortSignal, "recap");

  return normalizeLlmSummary(content);
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
    const system = buildSimpleSpeechSystemPrompt({
      player: input.player,
      phase: input.phase,
      language: this.language,
      legalPlayers
    });
    const fallbackSpeech = buildSimpleFallbackSpeech(input, this.language);
    const fallback = fallbackSpeech.messages[0] ?? simpleSpeechFallbackLine(input, this.language);
    const content = await this.complete(
      system,
      [
        {
          role: "user",
          content: [input.context, "", `Task: ${input.task}`].join("\n")
        }
      ],
      this.maxTokens,
      input.abortSignal,
      "speech"
    );
    const messages = parseDisplayedSpeechMessages(content, fallback, this.language);

    return {
      messages: messages.length > 0 ? messages : [normalizeSpeechLine(fallback, fallback, this.language)],
      metadata: inferSpeechMetadata(messages.length > 0 ? messages : [fallback], input, this.language)
    };
  }

  // Single fast call (no reasoning stage) for the day-1 warm-up resolve.
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
    const messages = parseDisplayedSpeechMessages(content, fallback, this.language);
    const cleanMessages = withoutFirstMeetingFraming(messages, this.language);
    return {
      messages: cleanMessages.length > 0 ? cleanMessages : [normalizeSpeechLine(fallback, fallback, this.language)],
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
    const messages = parseDisplayedSpeechMessages(content, fallback, this.language);
    const cleanMessages = withoutFirstMeetingFraming(messages, this.language);
    return {
      messages: cleanMessages.length > 0 ? cleanMessages : [normalizeSpeechLine(fallback, fallback, this.language)],
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
        return normalizeTargetDecision(selection.decision, input.candidates, this.language, input.phase, input.action);
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
                ? '選ばない場合だけ {"targetId":null,"reasonKind":"skip_preserve"} を使えます。'
                : "必ず一覧にある対象 ID と reasonKind を返してください。"
            ].join("\n")
          : [
              "Your previous response was not valid target-selection JSON or selected an illegal target.",
              "Retry with strict JSON only.",
              `Legal target ids: ${input.candidates.map((candidate) => candidate.id).join(", ")}.`,
              input.allowSkip
                ? 'Use {"targetId":null,"reasonKind":"skip_preserve"} only if skipping.'
                : "You must choose one listed target id and reasonKind."
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
    ? createLlmClient({
        apiKey,
        baseUrl: process.env.ZAI_BASE_URL ?? process.env.OPENAI_BASE_URL ?? defaultZaiBaseUrl,
        timeoutMs: positiveInt(process.env.ZAI_TIMEOUT_MS ?? process.env.LLM_TIMEOUT_MS, defaultLlmTimeoutMs)
      })
    : null;

  return (name: string) => {
    if (options.provider === "llm" && anthropicCompatibleClient) {
      return new AnthropicAgent(name, anthropicCompatibleClient, configuredModel, options.language, maxTokens);
    }
    return new DemoAgent(name, options.provider === "llm" ? "demo-fallback" : "demo", options.language);
  };
}
