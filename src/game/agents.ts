import Anthropic, { APIConnectionTimeoutError, APIError } from "@anthropic-ai/sdk";
import type { MessageParam, TextBlock } from "@anthropic-ai/sdk/resources/messages";
import { detectDaySituations, type DaySituation } from "./daySituations";
import { stripJapaneseSpeechTerminalPeriod } from "./japaneseStyle";
import {
  buildTargetList,
  buildBooleanSystemPrompt,
  buildSpeechReasoningSystemPrompt,
  buildSpeechSurfaceSystemPrompt,
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
  TargetDecision,
  TargetReasonKind
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

function normalizeSpeechMessages(messagesSource: string[], fallback: string, language: string): string[] {
  return messagesSource
    .flatMap(splitSpeechText)
    .filter((message) => message.length > 0 && !isSpeechJsonLeak(message))
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

function chooseReasonVariant(variants: string[], seedParts: string[]): string {
  return variants[stableTextIndex(seedParts, variants.length)] ?? variants[0] ?? "";
}

function readReasonSeed(kind: "suspect" | "trust", targetId: string, evidence: ReadEvidenceMetadata | undefined): string[] {
  return [
    kind,
    targetId,
    evidence?.kind ?? "none",
    evidence?.sourceId ?? "",
    evidence?.claimantId ?? "",
    evidence?.resultTargetId ?? "",
    evidence?.resultCamp ?? "",
    evidence?.round ? String(evidence.round) : ""
  ];
}

function japaneseGenericReadReasons(kind: "suspect" | "trust"): string[] {
  return kind === "suspect"
    ? [
        "今日の発言で確認したい点がある",
        "今の立場をもう少し聞きたい",
        "判断材料を増やすために一度圧をかけたい",
        "投票前に理由をはっきりさせたい",
        "曖昧なまま残すと票が流れそう",
        "最初に置くならここを確認したい",
        "議論の軸として返答を見たい",
        "まだ白く置く理由が足りない",
        "考え方を一段深く聞きたい",
        "今日の見方を言葉にしてもらいたい",
        "他の候補と比べるために反応を取りたい",
        "ここを放置すると投票理由がぼやける"
      ]
    : [
        "今日の立場が比較的はっきりしている",
        "考えの出し方が見えやすい",
        "今のところ判断の軸が読みやすい",
        "発言から投票方針が追いやすい",
        "議論への入り方に無理が少ない",
        "一旦村側に寄せて扱いやすい",
        "考えを隠している感じが薄い",
        "他の候補より見方を説明しやすい",
        "現時点では疑いを急がなくてよい",
        "返答の方向が比較的整理されている",
        "投票理由を後で検証しやすい",
        "議論の進め方に筋がある"
      ];
}

function englishGenericReadReasons(kind: "suspect" | "trust"): string[] {
  return kind === "suspect"
    ? [
        "public stance needs pressure",
        "their position needs one more clear answer",
        "the table should test that read before voting",
        "their vote reason needs to be pinned down",
        "leaving that slot vague would muddy the vote",
        "that is the read I most want clarified today",
        "their reasoning needs another step",
        "there is not enough there to call them clear yet",
        "their view should be put into words before the vote",
        "that slot is the best pressure point right now",
        "their answer will help separate the vote options",
        "the case around them still needs structure"
      ]
    : [
        "public stance is comparatively clear",
        "their reasoning is easy to track",
        "their vote direction is visible enough for now",
        "their table position has a clear shape",
        "their entry into the discussion looks low-risk",
        "I can follow their stated priorities",
        "they are not hiding the core of their read",
        "their stance is easier to revisit tomorrow",
        "I do not need to rush suspicion there yet",
        "their response is comparatively organized",
        "their vote reason will be testable later",
        "their discussion path has a coherent line"
      ];
}

function japaneseReadReasonVariants(kind: "suspect" | "trust", evidence: ReadEvidenceMetadata, language: string): string[] {
  if (evidence.kind === "seer_result") {
    const claimant = evidence.claimantName ?? evidence.sourceName;
    const resultTarget = evidence.resultTargetName;
    const camp = evidence.resultCamp ? campLabel(evidence.resultCamp, language) : undefined;
    if (claimant && resultTarget && camp) {
      return kind === "suspect"
        ? [
            `${claimant}が${resultTarget}を${camp}だと言った後の反応`,
            `${claimant}の${resultTarget}への${camp}判定を受けた返答`,
            `${claimant}の判定に対する立場の出し方`,
            `${resultTarget}への${camp}判定をどう扱うかが曖昧`,
            `${claimant}の結果まわりで態度を見たい`,
            `${resultTarget}判定への反応が投票理由に直結する`,
            `${claimant}の結果と今日の反応を並べて確認したい`,
            `${camp}判定が出た後の距離の取り方`
          ]
        : [
            `${claimant}の${resultTarget}への${camp}判定と反応が大きく崩れていない`,
            `${claimant}の結果への返し方が落ち着いている`,
            `${resultTarget}への${camp}判定を急に利用しすぎていない`,
            `${claimant}の判定まわりで立場が追いやすい`,
            `${camp}判定後の発言が比較的整理されている`,
            `${claimant}の結果を材料として扱う姿勢が自然`,
            `${resultTarget}判定への向き合い方に無理が少ない`,
            `${claimant}の結果と今日の発言が大きくずれていない`
          ];
    }
    if (resultTarget && camp) {
      return kind === "suspect"
        ? [
            `${resultTarget}への${camp}判定への反応`,
            `${camp}判定が出た後の立場の出し方`,
            `${resultTarget}判定を受けた返答の弱さ`,
            `${resultTarget}への結果をどう見るかが曖昧`,
            `${camp}判定後の距離感を確認したい`
          ]
        : [
            `${resultTarget}への${camp}判定を落ち着いて扱っている`,
            `${camp}判定後の発言が整理されている`,
            `${resultTarget}判定への反応に無理が少ない`,
            `${camp}判定を急に利用しすぎていない`,
            `${resultTarget}への結果と態度が大きくずれていない`
          ];
    }
    return kind === "suspect"
      ? [
          "占い結果への反応",
          "占い結果を受けた立場の出し方",
          "判定後の距離感",
          "結果をどう扱うかの曖昧さ",
          "占い結果まわりの返答"
        ]
      : [
          "占い結果への反応が落ち着いている",
          "判定後の立場が整理されている",
          "結果の扱い方に無理が少ない",
          "占い結果を急に利用しすぎていない",
          "結果まわりの発言が追いやすい"
        ];
  }

  const byKind: Record<ReadEvidenceKind, { suspect: string[]; trust: string[] }> = {
    seer_result: {
      suspect: ["占い結果への反応"],
      trust: ["占い結果への反応が落ち着いている"]
    },
    speech_timing: {
      suspect: [
        "出るタイミングが少し遅い",
        "話題が固まってから乗ったように見える",
        "先に様子を見てから立場を出したように見える",
        "重要な話題への反応が一拍遅れている",
        "流れが見えてから安全な位置に入ったように見える",
        "最初の判断を避けてから発言している",
        "発言順と内容の噛み合いを確認したい",
        "押されてから出した意見に見える",
        "早く言えたはずの立場が後ろに回っている",
        "場の空気を見てから合わせた可能性がある"
      ],
      trust: [
        "早めに立場を出している",
        "流れが固まる前に考えを置いている",
        "判断を後出しにしていない",
        "話題が動く前から基準を示している",
        "反応の遅さで逃げていない",
        "最初の段階で見方を明かしている",
        "発言順と内容に無理が少ない",
        "押される前に意見を出している",
        "場に合わせた後出しには見えにくい",
        "早い段階の発言として検証しやすい"
      ]
    },
    stance_change: {
      suspect: [
        "立場の変わり方を確認したい",
        "読み替えの理由がまだ見えにくい",
        "前の見方から急に寄せたように見える",
        "疑い先を変えた理由が薄く見える",
        "流れに合わせて結論を動かしたように見える",
        "考えを変えた過程をもう一度聞きたい",
        "昨日の見方と今日の結論に段差がある",
        "意見変更のタイミングが都合よく見える",
        "読みの移動が票の流れに寄りすぎている",
        "変えた理由を説明できるか見たい",
        "結論だけが動いて根拠が追いにくい",
        "発言の向きが急に変わっている"
      ],
      trust: [
        "見方を変えた理由が説明されている",
        "立場の更新に筋がある",
        "前の発言から今日の結論まで追いやすい",
        "読み替えが新しい材料に結びついている",
        "意見変更の理由が票だけに寄っていない",
        "変えた部分と残した部分が分かる",
        "昨日からの考え方が整理されている",
        "更新した読みを言葉にできている",
        "新情報を受けた自然な見直しに見える",
        "結論の移動に説明がついている",
        "前の立場をなかったことにしていない",
        "読みの変化が検証しやすい"
      ]
    },
    weak_reason: {
      suspect: [
        "根拠が結論に届いていない",
        "投票理由の芯がまだ見えない",
        "結論だけが先に出ていて過程を追いにくい",
        "質問への返答が短くて判断しづらい",
        "便乗か自分の考えかを分けたい",
        "疑いの置き方が広すぎる",
        "誰をどう見ているかが絞れていない",
        "説明が一段足りない",
        "投票先にするには理由をもう少し聞きたい",
        "根拠の具体例がまだ足りない",
        "言い切りの強さに比べて材料が少ない",
        "質問に対して結論だけ返している",
        "疑いを置く順番が見えにくい",
        "他人の見方に乗っただけか確認したい",
        "どの発言を重く見たのかが曖昧",
        "投票に使うなら理由を補ってほしい",
        "疑いの根っこをまだ出していない",
        "判断の基準がまだ共有されていない",
        "説明を避けて安全な言葉に寄せている",
        "材料と結論の間に飛びがある"
      ],
      trust: [
        "理由の出し方が具体的",
        "根拠から結論まで追いやすい",
        "投票理由として後で見返しやすい",
        "質問への答えに自分の基準が入っている",
        "疑い先を絞った理由が分かる",
        "結論だけでなく過程も出している",
        "どの点を重く見たかが明確",
        "他人の意見に乗るだけで終わっていない",
        "票に使える説明になっている",
        "判断基準を隠していない",
        "理由と対象がずれていない",
        "疑いの根拠を短く出せている",
        "比較したうえで立場を置いている",
        "返答の中身が検証しやすい",
        "発言から考えの順番が見える",
        "根拠を一つに絞れている",
        "投票前に見返せる理由になっている",
        "立場の説明に余計な濁しが少ない"
      ]
    },
    vote: {
      suspect: [
        "投票理由をもう一度聞きたい",
        "票の向きと発言が少しずれて見える",
        "その投票で誰が得をしたかを確認したい",
        "前日の疑い先と投票先の差が気になる",
        "票を集めやすい所へ寄せたように見える",
        "投票の根拠が今日の発言とつながりにくい",
        "終盤の票移動として理由を確認したい",
        "孤立した票なら意図を聞きたい",
        "投票先を選んだ順番が見えにくい",
        "票の置き方が安全側に寄っている"
      ],
      trust: [
        "投票理由が発言と合っている",
        "票の置き方に説明がある",
        "前日の疑い先と投票先がつながっている",
        "投票の根拠を後から検証しやすい",
        "票を集めやすい所へ安易に流れていない",
        "投票先を選んだ順番が追いやすい",
        "票の向きが今日の発言と矛盾しにくい",
        "投票理由を隠さず出している",
        "終盤の票として不自然さが少ない",
        "票の置き方に責任を持っている"
      ]
    },
    claim_timing: {
      suspect: [
        "役職を名乗ったタイミングを確認したい",
        "名乗りが票の流れに合わせて出たように見える",
        "出る理由が今なのかを聞きたい",
        "結果より先にタイミングが引っかかる",
        "吊られそうになってからの名乗りに見える",
        "対抗の有無を見る前に信用しづらい",
        "名乗り方が少し都合よく見える",
        "出た順番と結果の重さを比べたい",
        "COの理由がまだ整理されていない",
        "名乗る条件を満たしていたか確認したい"
      ],
      trust: [
        "名乗ったタイミングに説明がある",
        "出る理由と結果の重さが合っている",
        "COの順番が不自然には見えにくい",
        "吊り逃れだけには見えにくい",
        "対抗確認まで含めて見方を置ける",
        "名乗る条件が発言と合っている",
        "結果を出すタイミングとして理解できる",
        "出方と今日の議題がつながっている",
        "名乗り方に過剰な作り込みが少ない",
        "CO後の説明が比較的追いやすい"
      ]
    },
    claim_reaction: {
      suspect: [
        "役職主張への反応がはっきりしない",
        "主張を急に利用しすぎている",
        "名乗りへの距離感が曖昧",
        "真偽を決める理由がまだ足りない",
        "役職主張を避けて別の話に逃げたように見える",
        "対抗や結果への触れ方が浅い",
        "主張への評価を濁している",
        "COをどう投票に使うかが見えない",
        "名乗りに対する警戒が急に強すぎる",
        "役職主張への反応が流れ任せに見える"
      ],
      trust: [
        "役職主張への反応が落ち着いている",
        "名乗りをすぐ決め打ちしていない",
        "結果とタイミングを分けて見ている",
        "対抗の有無まで含めて考えている",
        "COへの距離感が自然",
        "役職主張を投票理由に使いすぎていない",
        "真偽を急がず確認点を出している",
        "主張への評価が短く整理されている",
        "名乗りを材料として慎重に扱っている",
        "CO後の反応に大きなブレがない"
      ]
    },
    night_result: {
      suspect: [
        "夜の結果への反応を確認したい",
        "死亡結果を自分に都合よく使っているように見える",
        "死体なしの説明を急ぎすぎている",
        "誰が得をしたかへの触れ方が浅い",
        "夜結果から投票先へのつなぎ方が強引に見える",
        "死亡者を材料にした結論が早すぎる",
        "複数の可能性を切るのが早い",
        "夜結果への第一声が安全側に見える",
        "昨夜の結果と前日の票のつながりを確認したい",
        "死因候補を絞る根拠が足りない"
      ],
      trust: [
        "夜の結果への反応が落ち着いている",
        "死体なしの可能性を分けて考えている",
        "死亡結果を急に利用しすぎていない",
        "夜結果と投票理由を分けて見ている",
        "誰が得をしたかを短く整理している",
        "昨夜の結果から断定に飛んでいない",
        "死因候補を広く見たうえで立場を置いている",
        "夜結果への触れ方に無理が少ない",
        "死亡者を現在の疑い先にしていない",
        "夜結果と今日の発言を分けて扱えている"
      ]
    },
    participation: {
      suspect: [
        "議論への入り方を確認したい",
        "参加はしているが立場が見えにくい",
        "発言量に比べて判断が出ていない",
        "質問は多いが自分の結論が少ない",
        "場を整理するだけで投票先が見えない",
        "会話には入るが責任のある読みが薄い",
        "発言の量より中身を見たい",
        "答えやすい所だけ拾っているように見える",
        "議論の中心を避けている可能性がある",
        "踏み込む場面で一歩引いている"
      ],
      trust: [
        "議論への入り方が見えている",
        "参加しながら自分の立場も出している",
        "質問と結論のバランスが取れている",
        "場を整理しつつ投票基準も出している",
        "発言量と判断の中身が合っている",
        "答えるべき話題から逃げていない",
        "議論の中心に自然に入っている",
        "確認点を短く出せている",
        "自分の読みを隠さず置いている",
        "会話への参加が投票理由につながっている"
      ]
    },
    consistency: {
      suspect: [
        "さっきの立場と今の結論が噛み合いにくい",
        "疑い先と投票方針の間にずれがある",
        "同じ材料から別の結論に飛んでいるように見える",
        "主張の軸が途中で入れ替わっている",
        "発言ごとの重視点がそろっていない",
        "前に置いた基準と今の判断が合いにくい",
        "説明の順番をもう一度確認したい",
        "立場の線が途中で途切れて見える",
        "今日の理由と前の読みがつながりにくい",
        "判断基準が場面ごとに変わっている",
        "発言の筋道に引っかかる部分がある",
        "結論だけが残って理由の線が薄い"
      ],
      trust: [
        "発言の筋道が追いやすい",
        "疑い先と投票方針がそろっている",
        "置いた基準と今日の判断が合っている",
        "話の軸が途中で大きくぶれていない",
        "同じ材料を同じ見方で扱えている",
        "前の読みから今日の結論まで見える",
        "説明の順番が自然",
        "発言ごとの重視点がそろっている",
        "投票理由と疑い先が近い",
        "判断基準が場面ごとに変わっていない",
        "今日の立場を後で検証しやすい",
        "結論に至る線が切れていない"
      ]
    },
    first_day_tentative: {
      suspect: [
        "最初の返答で考えを確認したい",
        "初日の基準をどう出すか見たい",
        "返答が曖昧なら投票候補に入れたい",
        "最初の質問への向き合い方を見たい",
        "序盤の立場を一つ聞いておきたい",
        "材料が少ない分、基準の出し方を見たい",
        "初日の火種として返答を取りたい",
        "役職方針への姿勢を確認したい",
        "投票理由を出せるか先に見たい",
        "最初に逃げ道を作るかどうか見たい"
      ],
      trust: [
        "最初の進め方がはっきりしている",
        "初日の基準を先に出せている",
        "材料が少ない中でも議題を作れている",
        "投票理由の残し方を示している",
        "役職方針への触れ方が整理されている",
        "序盤の立場が見えやすい",
        "質問だけでなく自分の基準も置いている",
        "初日の会話を動かす内容になっている",
        "返答しやすい形で話題を出している",
        "様子見だけで終わっていない"
      ]
    },
    other: {
      suspect: japaneseGenericReadReasons("suspect"),
      trust: japaneseGenericReadReasons("trust")
    }
  };

  return byKind[evidence.kind][kind];
}

function englishReadReasonVariants(kind: "suspect" | "trust", evidence: ReadEvidenceMetadata): string[] {
  if (evidence.kind === "seer_result") {
    const claimant = evidence.claimantName ?? evidence.sourceName;
    const resultTarget = evidence.resultTargetName;
    const camp = evidence.resultCamp;
    if (claimant && resultTarget && camp) {
      return kind === "suspect"
        ? [
            `${claimant}'s ${camp} result on ${resultTarget} and the reaction to it`,
            `the response after ${claimant}'s ${camp} result on ${resultTarget}`,
            `how they handled ${claimant}'s check on ${resultTarget}`,
            `the distance they kept from the ${camp} result on ${resultTarget}`,
            `their stance after ${claimant}'s result became visible`,
            `whether the ${resultTarget} result is being used too easily`
          ]
        : [
            `a steady response to ${claimant}'s ${camp} result on ${resultTarget}`,
            `a measured way of handling ${claimant}'s check on ${resultTarget}`,
            `not overusing the ${camp} result on ${resultTarget}`,
            `a traceable stance after ${claimant}'s result`,
            `their reaction to the ${resultTarget} result stays organized`,
            `the check result and their stance do not pull apart`
          ];
    }
    return kind === "suspect"
      ? ["reaction to the Seer result", "how they handled the check result", "their stance after the result", "unclear distance from the result"]
      : ["steady reaction to the Seer result", "measured handling of the check result", "organized stance after the result", "not overusing the result"];
  }

  const byKind: Record<ReadEvidenceKind, { suspect: string[]; trust: string[] }> = {
    seer_result: {
      suspect: ["reaction to the Seer result"],
      trust: ["steady reaction to the Seer result"]
    },
    speech_timing: {
      suspect: ["late timing", "waiting for the table before taking a stance", "a delayed reaction to the key point", "a safe-looking entry", "pressure only after the flow was clear", "their timing needs testing"],
      trust: ["early stance timing", "speaking before the table settled", "not waiting for a safe lane", "clear timing on the first read", "a stance before pressure arrived", "timing that is easy to revisit"]
    },
    stance_change: {
      suspect: ["changed public stance", "the reason for the read change is unclear", "the shift follows the vote flow too neatly", "the changed position needs another answer", "the old read and new conclusion do not line up", "their read moved faster than the evidence", "the timing of the shift is too convenient", "the change looks more tactical than explained"],
      trust: ["consistent public stance", "the changed read is explained", "the update follows new information", "the old position and new conclusion connect", "the shift is easy to verify later", "they did not erase their earlier read", "the change has a clear reason", "their read update is organized"]
    },
    weak_reason: {
      suspect: ["the reason does not reach the conclusion", "the vote case needs a clearer core", "the answer gives a conclusion without the steps", "the concrete example is still missing", "it may be follow-along rather than their own read", "the suspicion is too broad to vote on yet", "their criteria are not shared", "the explanation avoids the hard part", "the target and reason need to be tied together", "the case skips a step"],
      trust: ["the reason is specific", "the evidence and conclusion connect", "the vote reason will be testable later", "the answer includes their own criteria", "the target and reason line up", "the explanation includes the important step", "the read is not just follow-along", "the case is narrow enough to revisit", "their reasoning path is visible", "they gave a usable vote reason"]
    },
    vote: {
      suspect: ["vote reason needs pressure", "the vote and stated read do not quite match", "the vote helped the easiest wagon", "the vote target needs a fresh explanation", "the timing of the vote move needs checking", "their isolated vote should be explained", "the vote looks safer than the stated suspicion", "the vote path is hard to track"],
      trust: ["vote reason matches the stated read", "the vote has a public reason", "the vote target follows their suspicion", "the vote can be checked tomorrow", "the vote does not look like easy wagoning", "their vote path is easy to track", "the vote and current stance connect", "the vote reason was not hidden"]
    },
    claim_timing: {
      suspect: ["timing of the role claim", "the claim timing needs checking", "the claim arrived with the vote pressure", "the reason to claim now is unclear", "the claim may be too convenient", "the result and timing need to be compared", "the claim conditions need testing", "the order of the claim matters"],
      trust: ["the claim timing has an explanation", "the claim timing fits the result", "the claim does not look purely defensive", "the claim order is understandable", "the claim conditions are consistent", "the timing is not overbuilt", "the claim links to today's agenda", "the result explains why they came out"]
    },
    claim_reaction: {
      suspect: ["unclear reaction to the role claim", "they are using the claim too quickly", "their distance from the claim is vague", "the claim judgment lacks a reason", "they avoided the claim and moved elsewhere", "their counterclaim check is shallow", "their use of the claim in the vote is unclear", "the reaction follows the flow too closely"],
      trust: ["steady reaction to the role claim", "they did not instantly hard-clear the claim", "they separated timing from result", "they considered counterclaims", "their distance from the claim is natural", "they are not overusing the claim as a vote reason", "the claim judgment is concise and testable", "their reaction did not swing wildly"]
    },
    night_result: {
      suspect: ["reaction to the night result needs pressure", "they are using the death too conveniently", "they rushed the no-death explanation", "the benefit from the night result needs checking", "the night result is being tied to a vote too forcefully", "they cut off possible causes too early", "their first reaction to the night looks too safe", "the death result and prior vote need comparison"],
      trust: ["steady reaction to the night result", "they kept multiple night explanations open", "they did not overuse the death result", "they separated the night result from the vote reason", "they did not turn the dead player into a current target", "their night-result read is measured", "the benefit question is stated clearly", "their reaction is easy to revisit tomorrow"]
    },
    participation: {
      suspect: ["participation and stance need pressure", "they are active without a clear read", "questions are replacing conclusions", "they organize the table without a vote direction", "their amount of speech is not matching substance", "they may be avoiding the central issue", "they answer only the easy parts", "their participation needs a firmer stance"],
      trust: ["participation and stance are visible", "they are active and still give a read", "their questions lead to a conclusion", "they organize the table with vote criteria", "their speech has usable substance", "they are not dodging the central issue", "their checks are concise", "their participation supports a vote reason"]
    },
    consistency: {
      suspect: ["statements do not connect", "the current conclusion does not fit the earlier stance", "their suspicion and vote direction split apart", "the standard changes between cases", "the line of reasoning breaks in the middle", "their priorities shift by situation", "the explanation order needs checking", "the case loses its thread"],
      trust: ["statements connect consistently", "the suspicion and vote direction line up", "their standard is stable across cases", "the reasoning line is easy to follow", "the current conclusion follows the earlier stance", "their priorities stay stable", "the explanation order is natural", "the case keeps its thread"]
    },
    first_day_tentative: {
      suspect: ["a light first-day pressure point", "a first answer worth testing", "their opening standard needs to be heard", "a tentative check on how they handle criteria", "a light pressure read before votes settle", "their first-day posture should be clarified", "their role-policy answer needs testing", "a day-one question that can shape the vote"],
      trust: ["a clear first-day opening standard", "a useful opening agenda", "their day-one posture is visible", "they moved the table without inventing evidence", "their opening vote criteria are usable", "their role-policy framing is organized", "they asked a question with their own standard", "their opening gives the table something to answer"]
    },
    other: {
      suspect: englishGenericReadReasons("suspect"),
      trust: englishGenericReadReasons("trust")
    }
  };

  return byKind[evidence.kind][kind];
}

function canonicalReadReason(
  kind: "suspect" | "trust",
  evidence: ReadEvidenceMetadata | undefined,
  language: string,
  targetId = ""
): string {
  const japanese = isJapaneseLanguage(language);
  const seedParts = readReasonSeed(kind, targetId, evidence);
  if (!evidence) {
    return chooseReasonVariant(japanese ? japaneseGenericReadReasons(kind) : englishGenericReadReasons(kind), seedParts);
  }
  return chooseReasonVariant(
    japanese ? japaneseReadReasonVariants(kind, evidence, language) : englishReadReasonVariants(kind, evidence),
    seedParts
  );
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
    reason: canonicalReadReason(kind, evidence, language, targetId),
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

function canonicalClaimAssessment(language: string, seedParts: string[]): string {
  if (isJapaneseLanguage(language)) {
    return chooseReasonVariant(
      [
        "役職主張は結果の順番を見て判断する",
        "名乗りの理由とタイミングを比べて見る",
        "対抗の有無まで見てから結論を置く",
        "結果と今日の発言が合うかを確認する",
        "主張だけでは決めず、投票理由とのつながりを見る",
        "COの出方と夜結果の整合を見たい",
        "今は真偽より確認点を一つ残す",
        "主張の中身を明日の検証材料にする",
        "結果の重さと出た理由を分けて見る",
        "役職主張を急いで決め打たない"
      ],
      seedParts
    );
  }

  return chooseReasonVariant(
    [
      "judge the claim by result order and timing",
      "compare the claim reason with its timing",
      "wait for counterclaim risk before locking it",
      "check whether the result fits today's speech",
      "connect the claim to vote reasons before trusting it",
      "test the claim against the night result",
      "leave one concrete check point before deciding",
      "make the claim testable tomorrow",
      "separate result weight from the reason to reveal",
      "avoid hard-clearing the role claim too quickly"
    ],
    seedParts
  );
}

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
      ? canonicalClaimAssessment(language, ["claim", targetId ?? "", raw.stance && typeof raw.stance === "string" ? raw.stance : ""])
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

function parseDisplayedSpeechMessages(content: string, fallback: string, language: string): string[] {
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

function speechFallbackLine(
  target: string,
  act: string,
  reason: string,
  input: AgentSpeechInput,
  language: string
): string | null {
  if (!target) {
    return null;
  }
  const seedParts = [input.player.id, input.player.persona, input.phase, input.task, target, act, reason];
  if (isJapaneseLanguage(language)) {
    const reasonLead = reason ? `${reason}という点で、` : "";
    if (/trust|信頼|信用/i.test(act)) {
      return chooseReasonVariant(
        [
          `${target}は${reasonLead}信頼寄りで見ます`,
          `${reasonLead}${target}は今日は信用寄りに置きます`,
          `${target}は${reasonLead}今すぐ疑う位置ではありません`,
          `${reasonLead}${target}の立場は一旦信じやすいです`,
          `${target}は${reasonLead}投票先から少し外します`,
          `${reasonLead}${target}は村側寄りに見ます`,
          `${target}は${reasonLead}今のところ信用できます`,
          `${reasonLead}${target}への疑いは優先しません`
        ],
        seedParts
      );
    }
    if (/suspect|vote|疑|投票/i.test(act)) {
      return chooseReasonVariant(
        [
          `${target}は${reasonLead}疑い寄りで見ます`,
          `${reasonLead}${target}を投票候補に入れます`,
          `${target}には${reasonLead}一度圧をかけたいです`,
          `${reasonLead}${target}の返答を今日の判断材料にします`,
          `${target}は${reasonLead}理由を確認する位置です`,
          `${reasonLead}${target}には疑いを置きます`,
          `${target}は${reasonLead}投票前にもう一段聞きたいです`,
          `${reasonLead}${target}を今の比較対象にします`
        ],
        seedParts
      );
    }
    if (/claim|主張|hold|保留/i.test(act)) {
      return chooseReasonVariant(
        [
          `${target}については${reasonLead}判断を保留にします`,
          `${reasonLead}${target}は結論を急がず見ます`,
          `${target}は${reasonLead}信用を保留します`,
          `${reasonLead}${target}は確認点を残して置きます`,
          `${target}は${reasonLead}決め打たずに扱います`,
          `${reasonLead}${target}は次の返答まで保留寄りです`,
          `${target}は${reasonLead}今は材料をそろえたいです`,
          `${reasonLead}${target}の主張は条件を見て判断します`
        ],
        seedParts
      );
    }
    return null;
  }

  if (/trust/i.test(act)) {
    return chooseReasonVariant(
      [
        `${target} is my trust lean${reason ? ` because ${reason}` : ""}.`,
        `${reason ? `${reason}, so ` : ""}I am keeping ${target} out of my vote pool for now.`,
        `${target} is easier to trust right now${reason ? ` because ${reason}` : ""}.`,
        `${reason ? `${reason}; ` : ""}${target} is not my priority suspicion.`,
        `${target} is a village lean for me${reason ? ` because ${reason}` : ""}.`,
        `${reason ? `${reason}, so ` : ""}I can follow ${target}'s side for now.`
      ],
      seedParts
    );
  }
  if (/suspect|vote/i.test(act)) {
    return chooseReasonVariant(
      [
        `${target} is my suspicion lean${reason ? ` because ${reason}` : ""}.`,
        `${reason ? `${reason}, so ` : ""}${target} is in my vote pool.`,
        `${target} needs pressure${reason ? ` because ${reason}` : ""}.`,
        `${reason ? `${reason}; ` : ""}I want ${target}'s answer before the vote.`,
        `${target} is the read I want tested${reason ? ` because ${reason}` : ""}.`,
        `${reason ? `${reason}, so ` : ""}I am putting suspicion on ${target}.`
      ],
      seedParts
    );
  }
  if (/claim|hold/i.test(act)) {
    return chooseReasonVariant(
      [
        `I am holding on ${target}${reason ? ` because ${reason}` : ""}.`,
        `${reason ? `${reason}, so ` : ""}I am not locking ${target} in yet.`,
        `${target} stays unresolved for me${reason ? ` because ${reason}` : ""}.`,
        `${reason ? `${reason}; ` : ""}I want one more check before trusting ${target}.`,
        `${target}'s claim needs to stay testable${reason ? ` because ${reason}` : ""}.`,
        `${reason ? `${reason}, so ` : ""}I will judge ${target} by the next answer.`
      ],
      seedParts
    );
  }
  return null;
}

function speechReasoningFallback(reasoning: SpeechReasoningResult, input: AgentSpeechInput, language: string): string {
  const target = reasoning.intent.targetName ?? (reasoning.intent.targetId ? targetName(reasoning.intent.targetId, input.knownPlayers) : "");
  const reason = reasoning.intent.reason || reasoning.intent.claimAssessment || reasoning.intent.stance || "";
  const act = reasoning.intent.act ?? "";

  const fallbackLine = speechFallbackLine(target, act, reason, input, language);
  if (fallbackLine) {
    return fallbackLine;
  }
  return buildLlmSpeechFallback(input, language);
}

const speechSurfaceAnglesJa = [
  "結論から短く言う",
  "理由から入って最後に判断を置く",
  "相手に呼びかけてから自分の見方を言う",
  "投票への影響を添えて言う",
  "保留幅を少し残してから判断を置く",
  "前の話と比べる形で言う"
];

const speechSurfaceAnglesEn = [
  "lead with the conclusion",
  "start from the reason and end with the read",
  "address the target before giving the read",
  "tie the read to the vote",
  "leave a small amount of uncertainty before the judgment",
  "frame it as a comparison with the previous discussion"
];

function speechSurfaceAngles(language: string, hasPublicHistory: boolean): string[] {
  const angles = isJapaneseLanguage(language) ? speechSurfaceAnglesJa : speechSurfaceAnglesEn;
  if (hasPublicHistory) {
    return angles;
  }
  return angles.filter((angle) => !/前の話|previous discussion/i.test(angle));
}

function stableTextIndex(parts: string[], modulo: number): number {
  const text = parts.join("|");
  let hash = 0;
  for (const char of text) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return modulo > 0 ? hash % modulo : 0;
}

function speechSurfaceAngle(reasoning: SpeechReasoningResult, input: AgentSpeechInput, language: string): string {
  const angles = speechSurfaceAngles(language, input.publicHistory.length > 0);
  const target = reasoning.intent.targetName ?? reasoning.intent.targetId ?? "";
  return angles[stableTextIndex([input.player.id, input.player.persona, input.phase, input.task, target], angles.length)] ?? angles[0];
}

function speechSurfaceTargetName(reasoning: SpeechReasoningResult, input: AgentSpeechInput): string {
  return reasoning.intent.targetName ?? (reasoning.intent.targetId ? targetName(reasoning.intent.targetId, input.knownPlayers) : "");
}

function speechSurfaceJudgment(
  target: string,
  act: string,
  input: AgentSpeechInput,
  language: string
): string {
  const seedParts = [input.player.id, input.player.persona, input.phase, input.task, target, act];
  if (isJapaneseLanguage(language)) {
    if (/trust|信頼|信用/i.test(act)) {
      return chooseReasonVariant(
        [
          `${target}を信頼寄りで見る`,
          `${target}を信用寄りに置く`,
          `${target}を投票先から少し外す`,
          `${target}を村側寄りに扱う`,
          `${target}への疑いは優先しない`,
          `${target}の立場を一旦信じる`
        ],
        seedParts
      );
    }
    if (/suspect|vote|疑|投票/i.test(act)) {
      return chooseReasonVariant(
        [
          `${target}を疑い寄りで見る`,
          `${target}を投票候補に入れる`,
          `${target}に一度圧をかける`,
          `${target}の理由を確認する`,
          `${target}に疑いを置く`,
          `${target}を今日の比較対象にする`
        ],
        seedParts
      );
    }
    if (/private_plan/i.test(act)) {
      return chooseReasonVariant(
        [
          `${target}を今夜の候補として提案する`,
          `${target}を夜の対象候補に入れる`,
          `${target}を今夜の相談軸にする`
        ],
        seedParts
      );
    }
    if (/claim|主張|hold|保留/i.test(act)) {
      return chooseReasonVariant(
        [
          `${target}について判断を保留にする`,
          `${target}は結論を急がず見る`,
          `${target}の信用は条件付きで置く`,
          `${target}は確認点を残して扱う`,
          `${target}は決め打たずに見る`,
          `${target}の主張は次の材料で判断する`
        ],
        seedParts
      );
    }
    return speechReasoningFallback({ intent: { act }, metadata: emptySpeechMetadata() }, input, language);
  }

  if (/trust/i.test(act)) {
    return chooseReasonVariant(
      [
        `trust-lean ${target}`,
        `keep ${target} out of the vote pool`,
        `treat ${target} as a village lean`,
        `lower suspicion on ${target}`,
        `follow ${target}'s stance for now`,
        `make ${target} a lower-priority vote`
      ],
      seedParts
    );
  }
  if (/suspect|vote/i.test(act)) {
    return chooseReasonVariant(
      [
        `suspicion-lean ${target}`,
        `put ${target} in the vote pool`,
        `pressure ${target} for one more answer`,
        `test ${target}'s reason before voting`,
        `place suspicion on ${target}`,
        `compare today's vote around ${target}`
      ],
      seedParts
    );
  }
  if (/private_plan/i.test(act)) {
    return chooseReasonVariant(
      [`propose ${target} as tonight's target`, `put ${target} in the night-target pool`, `center tonight's plan on ${target}`],
      seedParts
    );
  }
  if (/claim|hold/i.test(act)) {
    return chooseReasonVariant(
      [
        `hold judgment on ${target}`,
        `keep ${target} unresolved for now`,
        `judge ${target} by the next check`,
        `avoid locking ${target} in yet`,
        `keep ${target}'s claim testable`,
        `wait for one more answer on ${target}`
      ],
      seedParts
    );
  }
  return speechReasoningFallback({ intent: { act }, metadata: emptySpeechMetadata() }, input, language);
}

function speechSurfaceCore(reasoning: SpeechReasoningResult, input: AgentSpeechInput, language: string): { judgment: string; reason?: string } {
  const japanese = isJapaneseLanguage(language);
  const target = speechSurfaceTargetName(reasoning, input);
  const reason = reasoning.intent.reason || reasoning.intent.claimAssessment || undefined;
  const act = reasoning.intent.act ?? "";

  if (japanese) {
    if (target) {
      return { judgment: speechSurfaceJudgment(target, act, input, language), reason };
    }
    return { judgment: speechReasoningFallback(reasoning, input, language) };
  }

  if (target) {
    return { judgment: speechSurfaceJudgment(target, act, input, language), reason };
  }
  return { judgment: speechReasoningFallback(reasoning, input, language) };
}

function speechSurfaceClaimNotes(reasoning: SpeechReasoningResult, language: string): string[] {
  const japanese = isJapaneseLanguage(language);
  return reasoning.metadata.claims.flatMap((claim) => {
    const result = typeof claim.result === "object" && claim.result !== null ? claim.result : undefined;
    const lines: string[] = [];
    if (claim.role) {
      lines.push(japanese ? `${roleLabel(claim.role, language)}の主張に触れる` : `mention the ${claim.role} claim`);
    }
    if (result) {
      lines.push(
        japanese
          ? `${result.targetName ?? result.targetId}への${campLabel(result.camp, language)}判定に触れる`
          : `mention the ${result.camp} result on ${result.targetName ?? result.targetId}`
      );
    }
    if (claim.note) {
      lines.push(claim.note);
    }
    return lines;
  });
}

function speechSurfaceUserContent(reasoning: SpeechReasoningResult, input: AgentSpeechInput, language: string): string {
  const core = speechSurfaceCore(reasoning, input, language);
  const angle = speechSurfaceAngle(reasoning, input, language);
  const claimNotes = speechSurfaceClaimNotes(reasoning, language).slice(0, 2);
  const recent = input.publicHistory.slice(-2);

  if (isJapaneseLanguage(language)) {
    return [
      "発言メモ:",
      `- 発言者: ${input.player.name}`,
      `- 言い方の変化: ${angle}`,
      `- 伝える判断: ${core.judgment}`,
      ...(core.reason ? [`- 理由: ${core.reason}`] : []),
      ...claimNotes.map((note) => `- 触れてよい材料: ${note}`),
      ...(recent.length > 0
        ? ["- 直前の発言への返答として自然に聞こえる切り出しにする。ただし上の判断・理由にない人物名や事実は足さない"]
        : []),
      "",
      "上のメモから、この人が今言う自然な短い発言を書いてください。"
    ].join("\n");
  }

  return [
    "Speech notes:",
    `- Speaker: ${input.player.name}`,
    `- Wording variation: ${angle}`,
    `- Judgment to express: ${core.judgment}`,
    ...(core.reason ? [`- Reason: ${core.reason}`] : []),
    ...claimNotes.map((note) => `- Public fact you may mention: ${note}`),
    ...(recent.length > 0
      ? [
          "- Make the line sound like a natural response to the immediately previous public statements, without adding names or facts outside the judgment and reason above."
        ]
      : []),
    "",
    "Write the short natural line this player says now."
  ].join("\n");
}

function textMentionsPlayerName(text: string, name: string, language: string): boolean {
  if (!name) {
    return false;
  }
  if (isJapaneseLanguage(language)) {
    return text.includes(name);
  }
  return new RegExp(`\\b${escapeRegExp(name)}\\b`, "i").test(text);
}

function surfaceAllowedNames(notes: string, input: AgentSpeechInput, language: string): Set<string> {
  const allowed = new Set<string>([input.player.name]);
  for (const player of input.knownPlayers) {
    if (textMentionsPlayerName(notes, player.name, language)) {
      allowed.add(player.name);
    }
  }
  return allowed;
}

function surfaceMessagesStayWithinNotes(messages: string[], notes: string, reasoning: SpeechReasoningResult, input: AgentSpeechInput, language: string): boolean {
  if (messages.length === 0) {
    return false;
  }
  const text = messages.join(" ");
  const allowed = surfaceAllowedNames(notes, input, language);
  for (const player of input.knownPlayers) {
    if (!allowed.has(player.name) && textMentionsPlayerName(text, player.name, language)) {
      return false;
    }
  }
  const target = speechSurfaceTargetName(reasoning, input);
  if (target && !textMentionsPlayerName(text, target, language)) {
    return false;
  }
  return true;
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
  const parsed = extractJsonObject(content);
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
  const parsed = extractJsonObject(content);
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
    if (move.kind === "self_introduction") {
      return "まず軽く自己紹介から。私は理由の薄い便乗を投票候補に入れるつもりです";
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

  if (move.kind === "self_introduction") {
    return "Let me introduce myself first. I will treat thin follow-along answers as vote candidates today.";
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

// --- Day-1 warm-up self-introduction -----------------------------------------

function buildIntroSystemPrompt(language: string, persona: Persona): string {
  const persona_ = personaLabel(persona, language);
  if (isJapaneseLanguage(language)) {
    return [
      "あなたは人狼ゲームのプレイヤーです。議論が始まる前の、ごく軽い自己紹介と挨拶をします。",
      `性格・話し方の傾向は「${persona_}」。性格は説明せず、口調や言い回しで自然ににじませてください。`,
      "ルール: 1〜2文の短さ。役職・陣営・占い等には触れない。誰かへの疑い・信頼・投票の話もまだしない。挨拶と人柄だけ。",
      "重要: 毎回同じ書き出しに寄せず、切り出し方は一人ひとり変え、自分の言葉で自然に。",
      "出力は表示するセリフそのものだけ。前置きや説明は不要。"
    ].join("\n");
  }
  return [
    "You are a player in a hidden-role werewolf game, giving a very light self-introduction and greeting before the discussion begins.",
    `Your personality/speaking style leans "${persona_}"; do not state it outright — let it show through your tone and word choice.`,
    "Rules: 1-2 short sentences. Do NOT mention roles, camps, or seer results. Do NOT state suspicion, trust, or votes yet. Greeting and personality only.",
    "Important: vary how you open and use your own natural voice.",
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
      "あなたは人狼ゲームのプレイヤーです。夜明け前、人狼陣営だけが集まる内緒の顔合わせの場で、仲間に向けて短く名乗り、村をだます演技の意気込みを見せます。",
      `性格・話し方の傾向は「${persona_}」。性格は説明せず、口調や言い回しで自然ににじませてください。`,
      `あなたの役職は「${roleName}」。仲間にだけ、自分が${roleName}であることをはっきり名乗ってください（例: 「俺が${roleName}だ」のように自分の言葉で）。`,
      "ルール: 1〜2文の短さ。ここは味方だけの場なので正体は隠さない。『人間側を演じる』『占い師っぽく振る舞う』『村を誘導する』など、どう騙すかを一言だけ添える。ただし襲撃先や具体的な作戦の相談はまだしない。",
      "重要: 毎回同じ書き出しに寄せず、切り出し方は自分の言葉で自然に。",
      "出力は表示するセリフそのものだけ。前置きや説明は不要。"
    ].join("\n");
  }
  return [
    "You are a player in a hidden-role werewolf game. Before dawn, the werewolf team meets privately; introduce yourself and show your appetite for deceiving the village.",
    `Your personality/speaking style leans "${persona_}"; do not state it outright — let it show through your tone and word choice.`,
    `Your role is "${roleName}". To your allies only, clearly own that you are the ${roleName} (e.g. "I'm the ${roleName}", in your own voice).`,
    "Rules: 1-2 short sentences. This is allies-only, so do NOT hide your identity. Add one line about how you will act human-side, fake a useful role, or steer the village. Do NOT discuss attack targets or concrete plans yet.",
    "Important: open in your own natural voice.",
    "Output only the spoken line itself; no preamble or explanation."
  ].join("\n");
}

function defaultWerewolfIntroLine(name: string, role: Role | undefined, language: string): string {
  const roleName = roleLabel(role, language);
  return isJapaneseLanguage(language)
    ? `${name}だ。俺が${roleName}、昼は人間側の顔で村を崩す`
    : `I'm ${name}, the ${roleName}; I will wear a village face and crack them open.`;
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
          `${name}だ。俺が${roleName}、昼は人間側の顔で村を崩す`,
          `どうも、${name}。${roleName}担当だ、${persona_}なりにうまく騙すよ`,
          `${name}です。${roleName}として、今日は人間っぽく信用を取りに行きます`,
          `こんばんは、${name}。こっちが${roleName}、必要なら占い師っぽく場を揺らす`
        ]
      : [
          `I'm ${name}, the ${roleName}; I will wear a village face and crack them open.`,
          `Hey, ${name} here. I'm the ${roleName}; I will sell the act ${persona_}.`,
          `${name}, the ${roleName}. I will build trust first, then turn it on them.`,
          `Evening, ${name}, the ${roleName}; if needed, I can shake the table with a fake claim.`
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
    // the reasoning system prompt suppresses its stance-forcing guidance too.
    const requiresForwardMove = input.speechPlan?.requiresForwardMove ?? true;
    const opensFirstDay = Boolean(input.speechPlan?.opensFirstDay);
    const reasoningSystem = buildSpeechReasoningSystemPrompt({
      player: input.player,
      phase: input.phase,
      language: this.language,
      legalPlayers,
      requiresForwardMove,
      opensFirstDay
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
    const surfaceSystem = buildSpeechSurfaceSystemPrompt({
      player: input.player,
      phase: input.phase,
      language: this.language,
      legalPlayers,
      requiresForwardMove,
      opensFirstDay
    });
    const surfaceNotes = speechSurfaceUserContent(reasoning, input, this.language);
    let surfaceContent: string;
    try {
      surfaceContent = await this.complete(
        surfaceSystem,
        [
          {
            role: "user",
            content: surfaceNotes
          }
        ],
        Math.min(this.maxTokens, defaultLlmMaxTokens),
        input.abortSignal,
        "speech.surface"
      );
    } catch (error) {
      if (input.abortSignal?.aborted) {
        throw error;
      }
      return {
        messages: [normalizeSpeechLine(fallback, fallback, this.language)],
        metadata: reasoning.metadata
      };
    }
    const messages = parseDisplayedSpeechMessages(surfaceContent, fallback, this.language);
    const safeMessages = surfaceMessagesStayWithinNotes(messages, surfaceNotes, reasoning, input, this.language) ? messages : [];

    return {
      messages: safeMessages.length > 0 ? safeMessages : [normalizeSpeechLine(fallback, fallback, this.language)],
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
    const messages = parseDisplayedSpeechMessages(content, fallback, this.language);
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
    const messages = parseDisplayedSpeechMessages(content, fallback, this.language);
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
