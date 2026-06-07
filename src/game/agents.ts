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
  AgentReadInput,
  AgentSpeech,
  AgentSpeechInput,
  AgentTargetInput,
  FirstDayOpeningMove,
  Persona,
  PlayerReadMetadata,
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
const speechReadMaxTokens = 320;
const speechReadAttempts = 2;
// Day-1 warm-up opening resolves are short and single-call (no reasoning stage).
const introMaxTokens = 140;
const defaultZaiBaseUrl = "https://api.z.ai/api/anthropic";
const defaultZaiModel = "glm-5-turbo";
const fixedLlmRequestConcurrency = 5;
const fixedLlmRequestMinIntervalMs = 0;
const targetSelectionAttempts = 2;
const booleanDecisionAttempts = 2;
const maxSpeechMessages = 3;

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

const demoOpeningDaySituationSpeechJa = [
  "初日なので決め打ちはしません。まず全員が投票理由を一つ残す形にしたいです。",
  "まだ誰の発言も材料にしません。占い師が名乗る条件だけ先に決めましょう。",
  "初日は情報が少ないので、理由を出さずに乗る人は投票候補に入れます。"
];

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

function stripDisplayedSpeechMetadata(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const speechOnly = trimmed
    .replace(
      /(?:^|[\s。！？.!?])(?:疑い先|信頼先|主張|メタデータ|metadata|suspects?|trusts?|claims?)\s*[:：].*$/iu,
      ""
    )
    .trim();
  return speechOnly.length > 0 ? speechOnly : null;
}

function stripSpeechMessageLabel(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const speechLabel = trimmed.match(/^(?:実際の発話|発話|発言|セリフ|台詞|speech|spoken line|message|line)\s*[:：]\s*(.+)$/iu);
  if (speechLabel?.[1]) {
    return stripDisplayedSpeechMetadata(speechLabel[1]);
  }
  if (/^(?:方針|思考|理由|分析|狙い|作戦|計画|plan|strategy|reasoning|analysis|rationale)\s*[:：]/iu.test(trimmed)) {
    return null;
  }
  return stripDisplayedSpeechMetadata(trimmed);
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
    return japanese ? "昼は自然に人間側らしく話します" : "昼は自然に人間側らしく話します";
  }
  if (input.phase === "voting") {
    return japanese ? "今日の発言を見て投票先を決めます" : "今日の発言を見て投票先を決めます";
  }
  return japanese ? "今は見えている発言から考えます" : "今は見えている発言から考えます";
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
    return normalizeSpeechMessages([content], fallback, language);
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

function firstPersonForPlayer(input: AgentSpeechInput, language: string): string {
  if (!isJapaneseLanguage(language)) {
    return "I";
  }
  const style = input.player.characterProfile?.speechStyle ?? "";
  const firstPerson = style.match(/一人称は「([^」]+)」/u)?.[1]?.trim();
  if (firstPerson) {
    return firstPerson;
  }
  if (input.player.persona === "aggressive" || input.player.persona === "stoic" || input.player.persona === "passionate") {
    return "俺";
  }
  if (input.player.persona === "cautious" || input.player.persona === "trickster") {
    return "僕";
  }
  return "私";
}

function normalizeSpeakerSelfReferences(text: string, input: AgentSpeechInput, language: string): string {
  if (!isJapaneseLanguage(language)) {
    return text;
  }
  const speakerName = input.player.name.trim();
  if (!speakerName) {
    return text;
  }
  const escapedName = escapeRegExp(speakerName);
  const self = firstPersonForPlayer(input, language);
  return text
    .replace(new RegExp(`${escapedName}(?:さん|君|ちゃん)?\\s*を\\s*(吊る|処刑する|疑う)`, "gu"), `${self}を$1`)
    .replace(new RegExp(`${escapedName}\\s*吊る`, "gu"), `${self}を吊る`)
    .replace(new RegExp(`${escapedName}\\s*吊り`, "gu"), `${self}吊り`)
    .replace(new RegExp(`${escapedName}\\s*処刑`, "gu"), `${self}処刑`)
    .replace(new RegExp(`${escapedName}(?:さん|君|ちゃん)?(?=\\s*(?:を|が|は|も|の|に|から))`, "gu"), self)
    .replace(new RegExp(`${escapedName}(?=\\s*(?:怪し|疑い|黒|人狼|狼))`, "gu"), self);
}

function normalizeSpeakerPerspectiveMessages(messages: string[], input: AgentSpeechInput, fallback: string, language: string): string[] {
  return messages
    .map((message) => normalizeSpeechLine(normalizeSpeakerSelfReferences(message, input, language), fallback, language))
    .filter(Boolean);
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

  const reason = typeof parsed.reason === "string" ? clampReason(parsed.reason, "対象IDから選択しました。") : "対象IDから選択しました。";
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

function buildSpeechReadSystemPrompt(language: string, legalPlayers: TargetCandidate[]): string {
  const roster = legalPlayers.map((candidate) => `${candidate.id}: ${candidate.name}`).join("\n");
  if (isJapaneseLanguage(language)) {
    return [
      "あなたは人狼ゲームの観戦アナリストです。ある参加者の発言を読み、その発言が『誰を疑っているか(suspects)』『誰を信頼・擁護しているか(trusts)』だけを構造化して取り出します。",
      "重要な方針:",
      "- キーワードや名前の一致に頼らず、文脈・言い回し・遠回しな表現・代名詞・状況描写から意図を推し量ってください。名前が明示されていなくても、文脈から対象が特定できるなら拾ってください。",
      "- 1人につき suspects か trusts のどちらか強い方に分類します。両方には入れません。",
      "- 発言に読みが含まれないなら、空配列を返します。推測で対象を増やさないでください。",
      "- reason は、その判断の根拠となった発言内容を、発言と同じ言語で短く(40字以内)言い換えてください。",
      "- targetId は必ず下のロスターに存在する id だけを使います。発言者自身や、ロスターにない人物は対象にしないでください。",
      "対象にできる参加者 (id: 名前):",
      roster,
      '出力は次の形の厳密な JSON だけ。前後に文章やコードフェンスを付けないでください: {"suspects":[{"targetId":"id","reason":"短い根拠"}],"trusts":[{"targetId":"id","reason":"短い根拠"}]}'
    ].join("\n");
  }
  return [
    "You are a spectator analyst for a social-deduction (werewolf) game. Read one participant's statement and extract only structured reads: who it suspects, and who it trusts or defends.",
    "Key policy:",
    "- Do not rely on keyword or exact-name matching. Infer intent from context, phrasing, indirect wording, pronouns, and situational description. Capture a target even when the name is not stated, as long as context identifies them.",
    "- Put each person in either suspects or trusts (the stronger reading), never both.",
    "- If the statement contains no read, return empty arrays. Do not invent targets.",
    "- reason: a short (<= 80 chars) paraphrase, in the statement's language, of what grounds the read.",
    "- targetId must be an id present in the roster below. Never target the speaker or anyone not in the roster.",
    "Targetable participants (id: name):",
    roster,
    'Output only strict JSON in this shape, with no surrounding prose or code fences: {"suspects":[{"targetId":"id","reason":"short reason"}],"trusts":[{"targetId":"id","reason":"short reason"}]}'
  ].join("\n");
}

function parseSpeechReads(
  content: string,
  legalPlayers: TargetCandidate[],
  language: string
): SpeechMetadata | null {
  const parsed = parseJsonObject(content);
  if (!parsed) {
    return null;
  }
  if (!Object.hasOwn(parsed, "suspects") && !Object.hasOwn(parsed, "trusts")) {
    return null;
  }
  const byId = new Map(legalPlayers.map((candidate) => [candidate.id, candidate.name] as const));
  const fallbackReason = isJapaneseLanguage(language) ? "発言からの読み。" : "Read inferred from the statement.";
  const collect = (raw: unknown, weight: number): PlayerReadMetadata[] => {
    if (!Array.isArray(raw)) {
      return [];
    }
    const reads: PlayerReadMetadata[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const targetId = (entry as { targetId?: unknown }).targetId;
      if (typeof targetId !== "string" || !byId.has(targetId) || seen.has(targetId)) {
        continue;
      }
      seen.add(targetId);
      reads.push({
        targetId,
        targetName: byId.get(targetId),
        reason: clampReason((entry as { reason?: unknown }).reason, fallbackReason),
        weight
      });
    }
    return reads;
  };
  const suspects = collect(parsed.suspects, 0.95);
  const trustedIds = new Set<string>();
  const trusts = collect(parsed.trusts, 0.9).filter((read) => {
    // A person classified as suspect cannot also be a trust; keep the suspect reading.
    if (suspects.some((suspect) => suspect.targetId === read.targetId) || trustedIds.has(read.targetId)) {
      return false;
    }
    trustedIds.add(read.targetId);
    return true;
  });
  return { suspects, trusts, claims: [] };
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
    return kind === "skip_preserve" ? "今回は見送る方が後半の手を残せます。" : "見送るのが今の最善です。";
  }
  if (kind === "claim_reaction") {
    return `${target.name}は役職主張への反応がまだ曖昧です。`;
  }
  if (kind === "vote_reason") {
    return `${target.name}の投票理由はもう一度確認が必要です。`;
  }
  if (kind === "stance_change") {
    return `${target.name}は公開発言で立場が変わり、圧力をかける価値があります。`;
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
      const suspectMentions = context.match(new RegExp(`(?:suspects:?|suspects\\s+)[^\\n.]*${escapedName}`, "g"))?.length ?? 0;
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
    : "今夜は議論をまとめそうな人を優先したいです。明日は全員で人間側の顔をして、残った村を疑わせましょう。";

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
      ? `今夜は${target.name}で合わせたいです。議論をまとめそうな人を噛めば、明日は人間側のふりで疑い先を作りやすいです。`
      : `今夜は${target.name}を襲撃候補にしたいです。発言力を持ちそうな人を先に噛んで、明日の村を崩しやすくしましょう。`;

  return {
    messages: buildDemoSpeechMessages([messageText], language),
    metadata: {
      suspects: [
        {
          targetId: target.id,
          targetName: target.name,
          reason: japanese ? "襲撃相談で優先したい人" : "襲撃相談で優先したい人",
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
    return sample(demoOpeningDaySituationSpeechJa);
  }

  return sample(demoDaySituationSpeechJa[situation]);
}

function demoSpeechReasonPool(input: AgentSpeechInput, situations: DaySituation[], language: string, openingFirstDay = false): string[] {
  if (openingFirstDay) {
    return openingFirstDayReasonsJa[input.player.persona];
  }

  const firstDayOnly =
    input.phase === "day_discussion" &&
    situations.includes("first_day") &&
    !situations.includes("seer_claim") &&
    !situations.includes("black_result");
  if (firstDayOnly) {
    return firstDayReasonsJa[input.player.persona];
  }
  return personaReasonsJa[input.player.persona];
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
  const targetName = target?.name ?? (japanese ? "誰か一人" : "誰か一人");
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
      return "私は占い師です。初日は結果がないので、今日は投票理由を薄くする人を見ます";
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
    return "占い師、魔女、ハンター、罠師、愚者、長老のCO方針を先に合わせたいです。騎士は出さない前提で進めましょう";
  }

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
    return "私は占い師です。初日は結果がないので、今日は投票理由を薄くする人を見ます";
  }
  if (move.kind === "state_vote_criteria") {
    return "今日は理由の具体性と、質問にちゃんと答えたかを投票基準にします";
  }
  if (move.kind === "ask_role_claim_policy") {
    return "占い師は黒結果か吊られそうな時だけ名乗る形にしたいです。反対意見はありますか";
  }
  if (move.kind === "ask_table_question") {
    return `${targetName}さん、最初の投票基準を一つ聞かせてください。私は理由が薄い人を候補に入れます`;
  }
  if (move.kind === "tentative_reaction_read") {
    return `${targetName}さんに先に理由を聞きます。初日は理由を出せない人を疑い寄りで見ます`;
  }
  return "占い師、魔女、ハンター、罠師、愚者、長老のCO方針を先に合わせたいです。騎士は出さない前提で進めましょう";
}

function buildDemoSpeech(input: AgentSpeechInput, language: string): AgentSpeech {
  const japanese = isJapaneseLanguage(language);
  const speechPool = demoSpeechJa;
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
  const firstDayNoSeerResults = input.phase === "day_discussion" && situations.includes("first_day");
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
      note: japanese ? "初日の反応を見るための占い師主張" : "初日の反応を見るための占い師主張"
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
      reason: japanese ? "最初の返答で考えを確認したい" : "最初の返答で考えを確認したい",
      weight: input.player.persona === "aggressive" ? 0.48 : 0.36
    });
  }

  if (trusted && !openingFirstDay && input.player.persona !== "aggressive") {
    metadata.trusts.push({
      targetId: trusted.id,
      targetName: trusted.name,
      reason: japanese ? "発言と投票の理由が一貫している" : "発言と投票の理由が一貫している",
      weight: input.player.persona === "empathetic" ? 0.66 : 0.52
    });
  }

  const seerResult = Object.entries(input.player.seerResults).at(-1);
  if (input.player.role === "Seer" && seerResult) {
    const [targetId, camp] = seerResult;
    const name = targetName(targetId, input.knownPlayers);
    const shouldClaim = input.phase === "day_discussion" && !firstDayNoSeerResults;
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
        note: japanese ? `${name}は${campLabel(camp, language)}判定` : `${name}は${campLabel(camp, language)}判定`
      });
      return {
        messages: buildDemoSpeechMessages(
          [
            japanese
              ? `ここで${roleLabel("Seer", language)}を名乗ります。${name}は${campLabel(camp, language)}判定です。`
              : `ここで${roleLabel("Seer", language)}を名乗ります。${name}は${campLabel(camp, language)}判定です。`,
            suspect
              ? japanese
                ? `${suspect.name}も投票候補に入れます。${japaneseReasonSentence(personaReason)}`
                : `${suspect.name}も投票候補に入れます。${japaneseReasonSentence(personaReason)}`
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
      note: japanese ? "夜の状況に関わる薬の情報があります。" : "夜の状況に関わる薬の情報があります。"
    });
  }

  if (input.player.role === "Guard" && input.player.memories.some((memory) => memory.includes("protected"))) {
    metadata.claims.push({
      type: "role_claim",
      role: "Guard",
      note: japanese ? "私の護衛先が夜の結果を説明できるかもしれません。" : "私の護衛先が夜の結果を説明できるかもしれません。"
    });
  }

  if (input.player.role === "Hunter" && weightedChance(0.2)) {
    metadata.claims.push({
      type: "role_claim",
      role: "Hunter",
      note: suspect
        ? japanese
          ? `私が死ぬなら、撃つ候補は${suspect.name}です。`
          : `私が死ぬなら、撃つ候補は${suspect.name}です。`
        : japanese
          ? "私は安易に吊っていい人ではありません。"
          : "私は安易に吊っていい人ではありません。"
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
      note: japanese ? "疑いを向けるための偽主張" : "疑いを向けるための偽主張"
    });
    return {
      messages: buildDemoSpeechMessages(
        [
          japanese
            ? `強い主張が必要なら、私は${roleLabel("Seer", language)}として出ます。${suspect.name}は${campLabel("werewolf", language)}判定です。`
            : `強い主張が必要なら、私は${roleLabel("Seer", language)}として出ます。${suspect.name}は${campLabel("werewolf", language)}判定です。`,
          japanese ? "動きが不自然です。" : "動きが不自然です。"
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
            : `${suspect.name}が気になります。${japaneseReasonSentence(personaReason)}`
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
    "あなたは人狼ゲームのプレイヤーです。議論が始まる前に、開幕の短い意気込みを一言だけ話します。",
    "舞台設定: プレイヤー同士は初対面ではありません。同じ宇宙船内のクルーとして互いの名前や普段の雰囲気は知っています。ただし、この対局で誰がどの役職かは知りません。",
    `性格・話し方の傾向は「${persona_}」。性格は説明せず、口調や言い回しで自然ににじませてください。`,
    "ルール: 1〜2文の短さ。役職・陣営・占い等には触れない。誰かへの疑い・信頼・投票の話もまだしない。名前だけの自己紹介や初対面の挨拶にしない。",
    "「はじめまして」「初めまして」は使わない。すでに知っているクルー同士として、これからの議論に向けた姿勢だけを出す。",
    "重要: 毎回同じ書き出しに寄せず、切り出し方は一人ひとり変え、自分の言葉で自然に。",
    "出力は表示するセリフそのものだけ。前置きや説明は不要。"
  ].join("\n");
}

function defaultIntroLine(name: string, language: string): string {
  void name;
  return isJapaneseLanguage(language)
    ? "まずは落ち着いて、理由の残る議論にします。"
    : "まずは落ち着いて、理由の残る議論にします。";
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
      "あなたは人狼ゲームのプレイヤーです。夜明け前、人狼陣営だけが集まる内緒の意思合わせの場で、仲間に自分の役職が伝わる短い確認と、村を欺くための一言を話します。",
      "舞台設定: プレイヤー同士は初対面ではありません。同じ宇宙船内のクルーとして互いの名前や普段の雰囲気は知っています。ただし、ここで初めて人狼陣営の仲間と役職内訳を確認します。",
      `性格・話し方の傾向は「${persona_}」。性格は説明せず、口調や言い回しで自然ににじませてください。`,
      `あなたの役職は「${roleName}」。仲間にだけ、自分が${roleName}であることを伝えてください。ただし後続発言では「俺も人狼だ」「人間のフリで潜伏する」のような名乗り直し型を繰り返さず、短く織り込んでください。`,
      "入力にある「あなたの枠」を最優先してください。最初の発言者は顔合わせの火付け役、2番手は支援または対比、3番手以降は疑い作りや票の調整など、同じ宣言を重ねず別の役割を足します。",
      "ルール: 1〜2文、日本語では70字以内。ここは味方だけの場なので正体は隠さない。初対面の自己紹介や世間話にしない。主軸は細かい作戦説明ではなく、狼同士の悪巧みの意気込み。先に出た仲間と同じ『騙す』『人間のフリ』『潜伏』『油断させる』だけを言い直さず、信用を作る、距離を取る、反応を見る、疑いを散らす、票を寄せるなどから別角度を選んでください。",
      "占い師・魔女・ハンター・罠師・愚者・長老の騙りは確定宣言しない。触れる場合は村側と同じ条件の状況次第の選択肢として残し、信用を取る、距離を取る、疑いを作る、票を寄せるなど、人間側の顔で騙す方向にしてください。騎士は通常の騙り対象にしません。襲撃先や具体的な夜の作戦はまだ話しません。",
      "入力に『この顔合わせで先に出た仲間の発言』がある場合、それは同じ顔合わせ内で自分より前に話した仲間のセリフです。内容に短く触れつつ、同じ構文や同じ計画を言い直さないでください。自分も特殊役職を騙る確定宣言で上書きしないでください。",
      "重要: 毎回同じ書き出しに寄せず、切り出し方は自分の言葉で自然に。",
      "出力は表示するセリフそのものだけ。前置きや説明は不要。"
    ].join("\n");
  }
  return [
    "あなたは人狼ゲームのプレイヤーです。夜明け前、人狼陣営だけが集まる内緒の意思合わせの場で、仲間に自分の役職が伝わる短い確認と、村を欺くための一言を話します。",
    "舞台設定: プレイヤー同士は初対面ではありません。同じ宇宙船内のクルーとして互いの名前や普段の雰囲気は知っています。ただし、ここで初めて人狼陣営の仲間と役職内訳を確認します。",
    `性格・話し方の傾向は「${persona_}」。性格は説明せず、口調や言い回しで自然ににじませてください。`,
    `あなたの役職は「${roleName}」。仲間にだけ、自分が${roleName}であることを伝えてください。ただし後続発言では「俺も人狼だ」「人間のフリで潜伏する」のような名乗り直し型を繰り返さず、短く織り込んでください。`,
    "入力にある「あなたの枠」を最優先してください。最初の発言者は顔合わせの火付け役、2番手は支援または対比、3番手以降は疑い作りや票の調整など、同じ宣言を重ねず別の役割を足します。",
    "ルール: 1〜2文、日本語では70字以内。ここは味方だけの場なので正体は隠さない。初対面の自己紹介や世間話にしない。主軸は細かい作戦説明ではなく、狼同士の悪巧みの意気込み。先に出た仲間と同じ『騙す』『人間のフリ』『潜伏』『油断させる』だけを言い直さず、信用を作る、距離を取る、反応を見る、疑いを散らす、票を寄せるなどから別角度を選んでください。",
    "占い師・魔女・ハンター・罠師・愚者・長老の騙りは確定宣言しない。触れる場合は村側と同じ条件の状況次第の選択肢として残し、信用を取る、距離を取る、疑いを作る、票を寄せるなど、人間側の顔で騙す方向にしてください。騎士は通常の騙り対象にしません。襲撃先や具体的な夜の作戦はまだ話しません。",
    "入力に「この顔合わせで先に出た仲間の発言」がある場合、それは同じ顔合わせ内で自分より前に話した仲間のセリフです。内容に短く触れつつ、同じ構文や同じ計画を言い直さないでください。自分も特殊役職を騙る確定宣言で上書きしないでください。",
    "重要: 毎回同じ書き出しに寄せず、切り出し方は自分の言葉で自然に。",
    "出力は表示するセリフそのものだけ。前置きや説明は不要。"
  ].join("\n");
}

function defaultWerewolfIntroLine(name: string, role: Role | undefined, language: string): string {
  const roleName = roleLabel(role, language);
  return isJapaneseLanguage(language)
    ? `俺は${name}、${roleName}だ。人間のフリで潜って、あいつら絶対騙してやる`
    : `俺は${name}、${roleName}だ。人間のフリで潜って、あいつら絶対騙してやる`;
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
          `${name}です。今日は焦らず、理由が残る発言で進めます。`,
          `${name}、いつも通り${persona_}寄りで見ます。まずは薄い便乗を流さない。`,
          `${name}だよ。今日は様子見だけで終わらせず、基準を先に置くね。`,
          `${name}。議論が散らないよう、最初から投票理由を残していきます。`
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
          `俺は${name}、${roleName}だ。人間のフリで潜って、あいつら絶対騙してやる`,
          `${name}は${roleName}担当だ。${persona_}なりに、疑われない位置から騙すよ`,
          `${name}です。${roleName}として人間っぽく信用を取り、村を騙します`,
          `${name}、${roleName}です。あいつらを油断させて、最後まで人間側で通します`
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
            ? "今は選択肢を残す方が低リスクです。"
            : "ここで見送る方が後半の手を残せます。"
      };
    }
    if (input.candidates.length === 0) {
      return {
        targetId: null,
        reason: isJapaneseLanguage(this.language) ? "選べる対象がいません。" : "選べる対象がいません。"
      };
    }
    const publicEvidenceTarget = evidenceTarget(input);
    if (publicEvidenceTarget && weightedChance(0.72)) {
      return {
        targetId: publicEvidenceTarget.id,
        reason: isJapaneseLanguage(this.language)
          ? `${publicEvidenceTarget.name}は公開された主張と発言から最も疑いが集まっています。`
          : `${publicEvidenceTarget.name}は公開された主張と発言から最も疑いが集まっています。`
      };
    }
    const target = sample(input.candidates);
    return {
      targetId: target.id,
      reason: naturalizeDemoReason(
        buildDemoVotingReason(input, target, this.language) ??
          sample(personaReasonsJa[input.player.persona])
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
    "返答言語: 日本語。"
  ].join("\n");
  const messages: MessageParam[] = [
    {
      role: "user",
      content: [
        `ラウンド: ${input.round}`,
        `決定的要約: ${input.deterministicMessage}`,
        "構造化された公開ラウンドデータ:",
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
          content: [input.context, "", `今回の発言タスク: ${input.task}`].join("\n")
        }
      ],
      this.maxTokens,
      input.abortSignal,
      "speech"
    );
    const parsedMessages = parseDisplayedSpeechMessages(content, fallback, this.language);
    const messages = normalizeSpeakerPerspectiveMessages(parsedMessages, input, fallback, this.language);

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
        reason: isJapaneseLanguage(this.language) ? "選べる対象がいません。" : "選べる対象がいません。"
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
    const actionLabel = input.actionLabel ?? input.action;
    const messages: MessageParam[] = [
      {
        role: "user",
        content: japanese
          ? [input.context, "", `行動: ${actionLabel}`, "選べる対象:", buildTargetList(input.candidates)].join("\n")
          : [input.context, "", `行動: ${actionLabel}`, "選べる対象:", buildTargetList(input.candidates)].join("\n")
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
              "直前の返答は、対象選択の JSON として不正か、一覧にない対象 ID を選んでいました。",
              "厳密な JSON だけでやり直してください。",
              `選べる対象 ID: ${input.candidates.map((candidate) => candidate.id).join(", ")}。`,
              input.allowSkip
                ? '選ばない場合だけ {"targetId":null,"reasonKind":"skip_preserve"} を使えます。'
                : "必ず一覧にある対象 ID と reasonKind を返してください。"
            ].join("\n")
      });
    }

    const fallbackTarget = sample(input.candidates);
    return {
      targetId: fallbackTarget.id,
      reason: "対象選択JSONが不正だったため、合法な対象を代替選択しました。"
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
        content: [input.context, "", `判断する質問: ${input.question}`].join("\n")
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
          "直前の返答は boolean 判断 JSON として不正でした。",
          "厳密な JSON だけでやり直してください。",
          '形は {"decision":true,"reason":"短い理由"} または {"decision":false,"reason":"短い理由"} だけです。'
        ].join("\n")
      });
    }

    return false;
  }

  async readReads(input: AgentReadInput): Promise<SpeechMetadata> {
    const empty: SpeechMetadata = { suspects: [], trusts: [], claims: [] };
    const message = input.message.trim();
    if (!message || input.legalPlayers.length === 0) {
      return empty;
    }

    const system = buildSpeechReadSystemPrompt(this.language, input.legalPlayers);
    const japanese = isJapaneseLanguage(this.language);
    const messages: MessageParam[] = [
      {
        role: "user",
        content: japanese ? `読み取る発言:\n${message}` : `Statement to interpret:\n${message}`
      }
    ];

    for (let attempt = 0; attempt < speechReadAttempts; attempt += 1) {
      // Read extraction is a classification task: use a low temperature for stable JSON
      // and consistent reads rather than the default creative-speech temperature.
      const content = await this.complete(system, messages, speechReadMaxTokens, input.abortSignal, "speech.reads", 0.1);
      const reads = parseSpeechReads(content, input.legalPlayers, this.language);
      if (reads) {
        return reads;
      }
      messages.push({ role: "assistant", content: content || "(empty response)" });
      messages.push({
        role: "user",
        content: japanese
          ? '直前の返答は不正でした。厳密な JSON だけでやり直してください。形は {"suspects":[{"targetId":"id","reason":"..."}],"trusts":[{"targetId":"id","reason":"..."}]} です。読みが無ければ {"suspects":[],"trusts":[]} を返してください。'
          : 'The previous reply was invalid. Reply with strict JSON only, shaped {"suspects":[{"targetId":"id","reason":"..."}],"trusts":[{"targetId":"id","reason":"..."}]}. If there is no read, return {"suspects":[],"trusts":[]}.'
      });
    }

    return empty;
  }

  private async complete(
    system: string,
    messages: MessageParam[],
    maxTokens = this.maxTokens,
    signal?: AbortSignal,
    label?: string,
    temperature = 0.8
  ): Promise<string> {
    return this.completeRequest(system, messages, maxTokens, temperature, undefined, signal, label);
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
