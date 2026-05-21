import Anthropic, { APIConnectionTimeoutError, APIError } from "@anthropic-ai/sdk";
import type { MessageParam, TextBlock } from "@anthropic-ai/sdk/resources/messages";
import { detectDaySituations, type DaySituation } from "./daySituations";
import { sanitizeDemoJapaneseGameText } from "./japaneseStyle";
import {
  buildTargetList,
  buildBooleanSystemPrompt,
  buildSpeechSystemPrompt,
  buildTargetSystemPrompt
} from "./prompts";
import { promptMaterials } from "./prompts/materials";
import { campLabel, defaultLanguage, isJapaneseLanguage, roleLabel } from "./i18n";
import { sample, weightedChance } from "./random";
import type {
  Agent,
  AgentBooleanInput,
  AgentSpeech,
  AgentSpeechInput,
  AgentTargetInput,
  Camp,
  ClaimMetadata,
  PlayerReadMetadata,
  Role,
  SpeechMetadata,
  TargetCandidate,
  TargetDecision
} from "./types";

const defaultLlmTimeoutMs = 30_000;
const defaultLlmMaxTokens = 1024;
const defaultZaiBaseUrl = "https://api.z.ai/api/anthropic";
const defaultZaiModel = "glm-5-turbo";
const llmRequestAttempts = 3;
const initialLlmBackoffMs = 1_000;
const targetSelectionAttempts = 2;
const booleanDecisionAttempts = 2;
const maxSpeechMessages = 3;

const demoSpeechEn: Record<Role, string[]> = {
  Werewolf: [
    "I do not like how quickly the suspicion moved without evidence. We should pressure the quiet players before committing.",
    "That claim feels convenient, especially after the night result. I want to hear a timeline before we trust it.",
    "The safest vote is the player avoiding a clear stance. Wolves benefit when the village argues in circles."
  ],
  Seer: [
    "I have a result that changes how I read the table, but I want one more answer before I reveal everything.",
    "The voting pattern matters here. Someone is trying to make a weak case look inevitable.",
    "I am watching the players who immediately accepted the easiest explanation after nightfall."
  ],
  Witch: [
    "The lack of a clean night result matters. We should not assume the obvious story is true.",
    "I am more concerned by people pushing certainty than by people asking careful questions.",
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
    "I want specific reasons, not just vibes. Who benefits most from last night's outcome?",
    "The contradiction is in the timing: the suspicion appeared only after a safer target was available.",
    "I am not convinced by a broad accusation. Please name one statement that changed your read."
  ]
};

const demoSpeechJa: Record<Role, string[]> = {
  Werewolf: [
    "まだ根拠が薄いので、発言の少ない人に理由を聞いてみたいです。",
    "その主張は夜の結果を見てから出したように見えます。信用する前に、時系列を確認したいです。",
    "明確な意見を避けている人に投票したいです。人間側が迷うほど人狼は動きやすくなります。"
  ],
  Seer: [
    "私には状況の見え方が変わる結果があります。ただ、全部話す前にもう一人の反応を見たいです。",
    "投票の流れが重要です。弱い根拠を既定路線に見せようとしている人がいます。",
    "夜明け後に一番簡単な説明へすぐ乗った人を見ています。"
  ],
  Witch: [
    "夜の結果が単純ではない点は大事です。見た目どおりの話だと決めつけない方がいいです。",
    "慎重に質問している人より、妙に断定して押している人の方が気になります。",
    "今は疑いが十分に出ています。急いだ投票は人狼を助けます。"
  ],
  Guard: [
    "夜の結果から情報は出ていますが、主張が揃うまでは強く言い切りたくありません。",
    "本物の役職主張がいるなら、人狼は今日の議論をそこから逸らす理由があります。",
    "夜の結果で守られたように見える人と、本当に信用できる人は分けて考えるべきです。"
  ],
  Hunter: [
    "私を安易な投票先にする前に、次に誰を疑うのかまで理由を残してください。",
    "誰を疑っているのか、順番をはっきりさせたいです。雑な便乗は危険です。",
    "私を雑に吊ろうとしている人が、次にどう進めるつもりなのか見ています。"
  ],
  Villager: [
    "雰囲気ではなく具体的な理由が欲しいです。昨夜の結果で一番得をしたのは誰ですか。",
    "矛盾しているのはタイミングです。投票しやすい相手が見えてから疑いが出ています。",
    "広い疑いだけでは納得できません。どの発言で考えが変わったのか一つ挙げてください。"
  ]
};

const demoDaySituationSpeechEn: Record<DaySituation, string[]> = {
  first_day: [
    "It is too early to lock anyone in. I want to ask who is staying quiet and who is following another person's suspicion.",
    "With so little public information, I would rather compare speaking volume and ask one concrete question before committing.",
    "My read is only a hypothesis for now. The useful thing today is to see who gives reasons and who only follows along."
  ],
  later_day: [
    "Yesterday's vote matters more now. I want to compare who changed their read after the night result.",
    "We have enough history to connect votes, claims, and reactions instead of starting from scratch.",
    "My read changed because the night result and yesterday's vote do not point in the same direction."
  ],
  no_death: [
    "No one died last night, but I do not want to decide why too quickly. The reactions to that result matter.",
    "A missing death can come from several causes. I want to hear who is treating one explanation as certain.",
    "The no-death result is useful, but only if we separate possibilities before voting."
  ],
  seer_claim: [
    "Before trusting the Seer claim, I want the result order, timing, and reason for coming out now.",
    "The claim gives us something testable. Please compare the result history with yesterday's votes.",
    "I am not deciding true or fake yet. I want concrete answers about timing and counterclaims."
  ],
  black_result: [
    "A black result is important, but I want to hear the accused player's answer before treating it as settled.",
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
    "初日なので決め打ちはしません。発言が少ない人と、誰かの疑いに乗った人へ理由を聞きたいです。",
    "まだ情報が少ないので、発言量を見ながら一つずつ質問したいです。今は軽い仮説で止めます。",
    "今日は強く決めるより、誰が理由を出していて誰が便乗しているのかを見たいです。"
  ],
  later_day: [
    "昨日の投票と夜の結果をつなげて見たいです。考えを変えた人は、その理由を出してください。",
    "ここからは昨日の発言も材料になります。誰の疑い先が変わったのかを確認したいです。",
    "前日の投票理由と今日の反応が合っているかを見ます。そこがずれている人が気になります。"
  ],
  no_death: [
    "死体なしの理由はまだ決めつけません。まず、この結果を見た後の反応を見たいです。",
    "昨夜の死亡者がいないなら、説明はいくつかあります。一つに決めず、発言の変化を見ましょう。",
    "死体なしは大事ですが、誰が守られたかを断定するより、急に話を固めた人を見たいです。"
  ],
  seer_claim: [
    "占い主張が出たなら、結果の順番と出た理由を確認したいです。すぐ真偽は決めません。",
    "占い師を名乗る人には、いつ誰を占ったのかをはっきり出してほしいです。",
    "対抗がいるか、昨日の投票と結果が合うかを見てから判断したいです。"
  ],
  black_result: [
    "人狼判定は重いですが、出された人の返答を聞いてから投票を考えたいです。",
    "黒を出した人の履歴と、出された人の反応を並べて見たいです。",
    "今日その人を吊るなら、明日確認できる理由まで残したいです。"
  ],
  pre_vote: [
    "投票直前なので、新しい話を広げず、今日一番理由が残っている人に絞ります。",
    "投票理由は短く出します。明日見返せるように、今日の発言から選びます。",
    "ここからは迷いを増やすより、公開された主張と反応で一人に決めたいです。"
  ]
};

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
    "their reaction became defensive when asked for details",
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
    "弱い弁明の後なので理由を深く聞きたい",
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
    "終盤の動きが質問する材料になる"
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
    "their early stance is careful, so I want one concrete answer",
    "they have spoken less than others and should leave a clearer read",
    "I want to know whose suspicion they are actually following"
  ],
  aggressive: [
    "their first answer did not give enough reasoning",
    "they followed the easiest question without adding their own view",
    "they should name one person they want to hear from next"
  ],
  logical: [
    "their first-day reasoning is still hard to compare",
    "their question does not yet connect to a clear read",
    "their reaction is useful to test before the vote"
  ],
  opportunistic: [
    "they are taking a flexible early stance that needs a reason",
    "their timing makes them a useful person to question first",
    "they are following the discussion without shaping it"
  ],
  empathetic: [
    "their tone changed when asked for details",
    "they have not answered the concern aimed at them yet",
    "I want to hear their reasoning before reading them too strongly"
  ],
  trickster: [
    "their seriousness feels like a mask",
    "I want to see how they handle a weird question",
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
    "発言が少ないので、一つ具体的な考えを聞きたい",
    "慎重な立場なので、誰を見ているのか確認したい",
    "誰の疑いに乗っているのかをはっきりさせたい"
  ],
  aggressive: [
    "最初の返答に理由が少ないので、もう少し聞きたい",
    "楽な質問に乗っただけに見えるので、自分の考えを聞きたい",
    "次に誰の話を聞きたいのか出してほしい"
  ],
  logical: [
    "初日の理由としてまだ比べにくい",
    "質問と疑い先がまだつながっていない",
    "投票前に反応を見ておきたい"
  ],
  opportunistic: [
    "初日の立場が広すぎるので理由を聞きたい",
    "話に乗るタイミングを確認したい",
    "議論についてきているが、自分の見方がまだ薄い"
  ],
  empathetic: [
    "詳細を聞かれた時の反応をもう少し見たい",
    "向けられた質問にまだ答えきっていない",
    "強く読む前に本人の理由を聞きたい"
  ],
  trickster: [
    "真面目すぎるのが逆に怪しい",
    "変な質問にどう答えるか見たい",
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
    "心は信じてるけど確認したい"
  ]
};

export function listJapaneseDemoCopySamples(): string[] {
  const name = "カズ";
  return [
    ...Object.values(demoSpeechJa).flat(),
    ...Object.values(demoDaySituationSpeechJa).flat(),
    ...Object.values(personaReasonsJa).flat(),
    ...Object.values(firstDayReasonsJa).flat(),
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
    `${name}は人狼判定への返答がまだ弱く、今日の投票理由として残せます。`,
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

function normalizeSpeechMessages(messagesSource: string[], fallback: string): string[] {
  return messagesSource
    .flatMap(splitSpeechText)
    .map((message) => message.replace(/\s+/g, " ").trim())
    .filter((message) => message.length > 0 && !isSpeechJsonLeak(message))
    .slice(0, maxSpeechMessages)
    .map((message) => clampText(message, fallback));
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
    value === "Seer" ||
    value === "Witch" ||
    value === "Guard" ||
    value === "Hunter" ||
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

function normalizeRead(value: unknown, candidates: TargetCandidate[]): PlayerReadMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const byId = candidateById(candidates);
  const raw = value as Record<string, unknown>;
  const targetId = typeof raw.targetId === "string" ? raw.targetId : "";
  const target = byId.get(targetId);
  if (!target) {
    return null;
  }

  return {
    targetId,
    targetName: target.name,
    reason: clampReason(raw.reason, ""),
    weight: normalizeWeight(raw.weight)
  };
}

function normalizeClaimResult(
  value: unknown,
  candidates: TargetCandidate[]
): ClaimMetadata["result"] | undefined {
  if (typeof value === "string") {
    return clampReason(value, "");
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

function normalizeClaim(value: unknown, candidates: TargetCandidate[]): ClaimMetadata | null {
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
  const note = typeof raw.note === "string" ? clampReason(raw.note, "") : undefined;

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
  claimCandidates = readCandidates
): SpeechMetadata {
  const suspects = Array.isArray(parsed.suspects)
    ? parsed.suspects
        .map((item) => normalizeRead(item, readCandidates))
        .filter((item): item is PlayerReadMetadata => Boolean(item))
    : [];
  const trusts = Array.isArray(parsed.trusts)
    ? parsed.trusts
        .map((item) => normalizeRead(item, readCandidates))
        .filter((item): item is PlayerReadMetadata => Boolean(item))
    : [];
  const claims = Array.isArray(parsed.claims)
    ? parsed.claims.map((item) => normalizeClaim(item, claimCandidates)).filter((item): item is ClaimMetadata => Boolean(item))
    : [];

  return {
    suspects: suspects.slice(0, 3),
    trusts: trusts.slice(0, 3),
    claims: claims.slice(0, 3)
  };
}

function parseSpeech(
  content: string,
  readCandidates: TargetCandidate[],
  fallback: string,
  claimCandidates = readCandidates
): AgentSpeech {
  const parsed = extractJsonObject(content);
  if (!parsed) {
    const recoveredMessages = isSpeechJsonLeak(content) ? normalizeSpeechMessages(extractMalformedSpeechMessages(content), fallback) : [];
    return {
      messages: recoveredMessages.length > 0 ? recoveredMessages : [clampText(isSpeechJsonLeak(content) ? fallback : content, fallback)],
      metadata: emptySpeechMetadata()
    };
  }

  const messagesSource = Array.isArray(parsed.messages)
    ? parsed.messages.filter((msg): msg is string => typeof msg === "string")
    : typeof parsed.message === "string"
      ? [parsed.message]
      : typeof parsed.speech === "string"
        ? [parsed.speech]
        : [];

  const messages = normalizeSpeechMessages(messagesSource, fallback);

  return {
    messages: messages.length > 0 ? messages : [clampText(fallback, fallback)],
    metadata: normalizeSpeechMetadata(parsed, readCandidates, claimCandidates)
  };
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

function createAnthropicClient(apiKey: string, baseUrl: string, timeoutMs: number): Anthropic {
  return new Anthropic({
    apiKey,
    baseURL: baseUrl,
    timeout: timeoutMs,
    maxRetries: 0
  });
}

function isRetryableAnthropicError(error: unknown): boolean {
  if (error instanceof APIConnectionTimeoutError) {
    return true;
  }
  if (error instanceof APIError) {
    const status = error.status ?? 0;
    return status === 429 || status >= 500;
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      error.name === "AbortError" ||
      message.includes("timeout") ||
      message.includes("aborted") ||
      message.includes("econnreset") ||
      message.includes("rate limit")
    );
  }
  return false;
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
  return sanitizeDemoJapaneseGameText(clampText(text, text), language);
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

  return sample((isJapaneseLanguage(language) ? demoDaySituationSpeechJa : demoDaySituationSpeechEn)[situation]);
}

function demoSpeechReasonPool(input: AgentSpeechInput, situations: DaySituation[], language: string): string[] {
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
      return `${target.name}は人狼判定への返答がまだ弱く、今日の投票理由として残せます。`;
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
    return `${target.name}'s answer to the black result is still the weakest vote reason.`;
  }
  if (situation === "seer_claim") {
    return `${target.name}'s reaction to the Seer claim stayed unclear.`;
  }
  if (situation === "no_death") {
    return `${target.name} rushed an explanation after the no-death night.`;
  }
  if (situation === "first_day") {
    return `${target.name} has the least developed first-day reasoning, so this vote asks for a clearer stance.`;
  }
  if (situation === "later_day") {
    return `${target.name}'s vote reason yesterday does not connect with today's statement.`;
  }
  return `${target.name} is the most testable vote from today's public discussion.`;
}

function buildDemoSpeech(input: AgentSpeechInput, language: string): AgentSpeech {
  const japanese = isJapaneseLanguage(language);
  const speechPool = japanese ? demoSpeechJa : demoSpeechEn;
  const candidates = (input.legalPlayers ?? input.knownPlayers).filter((candidate) => candidate.id !== input.player.id);

  if (input.phase === "werewolf_discussion" && input.player.role === "Werewolf") {
    return buildDemoWerewolfDiscussion(input, language);
  }

  const situations = detectSpeechDaySituations(input, language);
  const reasonPool = demoSpeechReasonPool(input, situations, language);
  const firstDaySoft =
    input.phase === "day_discussion" &&
    situations.includes("first_day") &&
    !situations.includes("seer_claim") &&
    !situations.includes("black_result");
  const fallback = buildDemoDaySituationSpeech(input, language) ?? sample(speechPool[input.player.role]);
  const metadata = emptySpeechMetadata();
  const suspect = candidates.length > 0 ? sample(candidates) : null;
  const trustPool = suspect ? candidates.filter((candidate) => candidate.id !== suspect.id) : candidates;
  const trusted = trustPool.length > 0 ? sample(trustPool) : null;
  const personaReason = sample(reasonPool);

  if (suspect) {
    metadata.suspects.push({
      targetId: suspect.id,
      targetName: suspect.name,
      reason: personaReason,
      weight: input.player.persona === "aggressive" ? 0.78 : 0.58
    });
  }

  if (trusted && input.player.persona !== "aggressive") {
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
                ? `${suspect.name}は${personaReason}ので、まだ理由を聞きたいです。`
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

  const fakeClaimChance = situations.includes("seer_claim") || situations.includes("black_result") ? 0.3 : 0.18;
  if (input.player.role === "Werewolf" && suspect && !firstDaySoft && weightedChance(fakeClaimChance)) {
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

  return {
    messages: buildDemoSpeechMessages(
      [
        fallback,
        suspect ? (japanese ? `${suspect.name}が気になります。理由は${personaReason}からです。` : `${suspect.name} stands out because ${personaReason}.`) : ""
      ],
      language
    ),
    metadata
  };
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
  temperature: number
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= llmRequestAttempts; attempt += 1) {
    try {
      const abortTimeoutMs = positiveInt(process.env.ZAI_TIMEOUT_MS ?? process.env.LLM_TIMEOUT_MS, defaultLlmTimeoutMs);
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, abortTimeoutMs);
      try {
        const response = await client.messages.create(
          {
            model,
            system,
            messages,
            max_tokens: maxTokens,
            temperature
          },
          { signal: controller.signal }
        );
        const textBlock = response.content.find((block): block is TextBlock => block.type === "text");
        return textBlock?.text ?? "";
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      lastError = error;
      if (!isRetryableAnthropicError(error) || attempt === llmRequestAttempts) {
        throw error;
      }
      await sleep(initialLlmBackoffMs * 2 ** (attempt - 1));
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
}): Promise<string | null> {
  const apiKey = process.env.ZAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const client = createAnthropicClient(
    apiKey,
    process.env.ZAI_BASE_URL ?? defaultZaiBaseUrl,
    positiveInt(process.env.ZAI_TIMEOUT_MS ?? process.env.LLM_TIMEOUT_MS, defaultLlmTimeoutMs)
  );
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
  const content = await completeAnthropic(
    client,
    input.model || process.env.ZAI_MODEL || process.env.OPENAI_MODEL || defaultZaiModel,
    system,
    messages,
    512,
    0.35
  );

  return normalizeLlmSummary(content);
}

export class AnthropicAgent implements Agent {
  constructor(
    public readonly name: string,
    private readonly client: Anthropic,
    public readonly model: string,
    private readonly language: string,
    private readonly maxTokens = defaultLlmMaxTokens
  ) {}

  async speak(input: AgentSpeechInput): Promise<AgentSpeech> {
    const legalPlayers = input.legalPlayers ?? input.knownPlayers;
    const system = buildSpeechSystemPrompt({
      player: input.player,
      phase: input.phase,
      language: this.language,
      legalPlayers
    });
    const content = await this.complete(system, [
      {
        role: "user",
        content: [input.context, "", `Task: ${input.task}`].join("\n")
      }
    ]);

    return parseSpeech(
      content,
      legalPlayers,
      sample((isJapaneseLanguage(this.language) ? demoSpeechJa : demoSpeechEn)[input.player.role]),
      input.knownPlayers
    );
  }

  async chooseTarget(input: AgentTargetInput): Promise<TargetDecision> {
    if (input.candidates.length === 0) {
      return {
        targetId: null,
        reason: isJapaneseLanguage(this.language) ? "選べる対象がいません。" : "No legal targets are available."
      };
    }

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
        content: [
          input.context,
          "",
          `Action: ${input.action}`,
          "Legal targets:",
          buildTargetList(input.candidates)
        ].join("\n")
      }
    ];

    for (let attempt = 0; attempt < targetSelectionAttempts; attempt += 1) {
      const content = await this.complete(system, messages);
      const selection = parseTargetSelection(content, input.candidates, input.allowSkip);
      if (selection.valid) {
        return selection.decision;
      }

      messages.push({
        role: "assistant",
        content: content || "(empty response)"
      });
      messages.push({
        role: "user",
        content: [
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
      const content = await this.complete(system, messages);
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

  private async complete(system: string, messages: MessageParam[]): Promise<string> {
    return completeAnthropic(this.client, this.model, system, messages, this.maxTokens, 0.8);
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
  const client = apiKey
    ? createAnthropicClient(
        apiKey,
        process.env.ZAI_BASE_URL ?? defaultZaiBaseUrl,
        positiveInt(process.env.ZAI_TIMEOUT_MS ?? process.env.LLM_TIMEOUT_MS, defaultLlmTimeoutMs)
      )
    : null;

  return (name: string) => {
    if (options.provider === "llm" && client) {
      return new AnthropicAgent(name, client, configuredModel, options.language, maxTokens);
    }
    return new DemoAgent(name, options.provider === "llm" ? "demo-fallback" : "demo", options.language);
  };
}
