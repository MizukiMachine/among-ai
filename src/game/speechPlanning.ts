import { isJapaneseLanguage } from "./i18n";
import type { DeathRecord } from "./rules/types";
import type {
  AgentSpeech,
  FirstDayOpeningMove,
  FirstDayOpeningMoveKind,
  Phase,
  Player,
  PublicNightDeathCause,
  PublicNightDeathInfo,
  PublicSpeechPlan,
  SpeechMetadata,
  SpeechIntent,
  TargetCandidate
} from "./types";

interface BuildPublicSpeechPlanInput {
  phase: Phase;
  round: number;
  discussionPass?: number;
  players: Player[];
  lastNightDeaths: DeathRecord[];
  legalPlayers: TargetCandidate[];
  language: string;
  firstDayOpeningMove?: FirstDayOpeningMove;
}

interface SpeechPlanReview {
  ok: boolean;
  issues: string[];
  revisionHint?: string;
}

interface PublicSpeechDiversityRecord {
  playerId: string;
  playerName: string;
  metadata: Pick<SpeechMetadata, "suspects" | "trusts">;
}

interface PublicReadSummary {
  sourceName: string;
  targetName: string;
  kind: "suspect" | "trust";
  reason?: string;
}

function labels(language: string) {
  const japanese = isJapaneseLanguage(language);
  return {
    unknownCause: japanese ? "不明" : "unknown",
    possibleCausesTitle: japanese ? "公開ルール上あり得る夜死亡" : "Public-rule night death causes in this setup",
    speechPlanTitle: japanese ? "この発言の設計" : "Speech plan",
    firstDaySpecialTitle: japanese ? "初日特別モード" : "First-day opening mode",
    publicKnowledgeTitle: japanese ? "公開知識" : "Public knowledge",
    deathLine: japanese ? "昨夜の死亡" : "Last night's deaths",
    publicCause: japanese ? "公開上の死因" : "public cause",
    mustAdvance: japanese
      ? "死因候補を並べるだけで終わらず、生存者への読み、投票理由、役職主張の評価のどれかに進める。"
      : "Do not stop at listing death causes; advance to a read, vote reason, or claim evaluation about a living player.",
    mustStateStance: japanese
      ? "発言ターンを使うので、質問、様子見、今後見る点だけで終えず、自分の疑い・信頼・保留・投票候補・役職主張の信用判断のどれかを必ず言う。"
      : "Because speech turns are limited, do not end with only a question, wait-and-see note, or future watch point; state your suspicion, trust, hold, vote candidate, or claim-trust stance.",
    causeLabels: {
      werewolf_attack: japanese ? "人狼の襲撃" : "werewolf attack",
      witch_poison: japanese ? "魔女の毒薬" : "Witch poison potion",
      werewolf_and_witch_overlap: japanese ? "人狼の襲撃と魔女の毒薬の重なり" : "overlap of werewolf attack and Witch poison",
      hunter_death_shot: japanese ? "ハンター死亡時の反撃" : "Hunter death shot",
      alpha_wolf_death_shot: japanese ? "アルファ人狼死亡時の反撃" : "Alpha Wolf death shot",
      lover_linked_death: japanese ? "恋人の後追い" : "lover linked death",
      wolf_beauty_charm_linked_death: japanese ? "美女狼の魅了による道連れ" : "Wolf Beauty charm linked death"
    },
    intents: {
      connect_night_death_to_living_players: japanese
        ? "昨夜の死亡を、生存者の発言・投票・役職主張への自分の読みにつなげる。"
        : "Connect the night death to your own read on a living player's speech, vote, or claim.",
      state_living_read: japanese
        ? "生存者を一人以上挙げて、自分の疑い・信頼・保留の理由を言う。"
        : "Name at least one living player and state your suspicion, trust, or hold reason.",
      update_living_read: japanese
        ? "死亡者ではなく、生存者への疑いか信頼を一つ更新する。"
        : "Update one suspicion or trust read about a living player, not a dead player.",
      answer_or_update: japanese
        ? "自分への疑いに答えたうえで、生存者への読みを一つ更新する。"
        : "Answer suspicion aimed at you, then update one read on a living player.",
      vote_ready_read: japanese
        ? "投票先を考えられる形で、生存者への読みを一つに絞る。"
        : "Narrow to one living-player read that can support a vote.",
      open_discussion: japanese
        ? "公開情報が少ない時も、自分の意見として生存者への暫定の疑い・信頼・保留・投票候補を一つ出して議論を始める。"
        : "When public information is thin, open with one tentative suspicion, trust, hold, or vote-candidate read on a living player."
    },
    revisionHint: japanese
      ? "前の返答は自分の stance が足りません。生存者への疑い・信頼・保留・投票候補、または役職主張の信用判断を、画面に出るセリフ内ではっきり言ってください。"
      : "The previous response did not state your stance. Revise the displayed dialogue to include suspicion, trust, hold, a vote candidate, or a claim-trust judgment.",
    emptyHistoryRevisionHint: japanese
      ? "前の返答は、まだ公開発言がない状況で他人の発言や動きを既にあった事実のように引用しています。人物傾向や役職印象を根拠に、暫定の疑い・信頼・保留・投票候補のどれかを自分の意見として言ってください。"
      : "The previous response cited another player's speech or action as if it had already happened, but no public statements are visible yet. Revise it as a tentative character- or role-based suspicion, trust, hold, or vote-candidate stance."
  };
}

function compactReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > 36 ? `${trimmed.slice(0, 36)}...` : trimmed;
}

function readSummaryLine(read: PublicReadSummary, language: string): string {
  const japanese = isJapaneseLanguage(language);
  const kind = japanese ? (read.kind === "suspect" ? "疑い" : "信頼") : read.kind === "suspect" ? "suspicion" : "trust";
  const reason = compactReason(read.reason);
  if (japanese) {
    return `- ${read.sourceName} -> ${read.targetName}: ${kind}${reason ? `（${reason}）` : ""}`;
  }
  return `- ${read.sourceName} -> ${read.targetName}: ${kind}${reason ? ` (${reason})` : ""}`;
}

export function renderPublicSpeechDiversityContext(
  records: PublicSpeechDiversityRecord[],
  language: string,
  options: { excludePlayerId?: string; maxReads?: number } = {}
): string[] {
  const japanese = isJapaneseLanguage(language);
  const reads: PublicReadSummary[] = records
    .filter((record) => record.playerId !== options.excludePlayerId)
    .flatMap((record) => [
      ...record.metadata.suspects.map((read) => ({
        sourceName: record.playerName,
        targetName: read.targetName ?? read.targetId,
        kind: "suspect" as const,
        reason: read.reason
      })),
      ...record.metadata.trusts.map((read) => ({
        sourceName: record.playerName,
        targetName: read.targetName ?? read.targetId,
        kind: "trust" as const,
        reason: read.reason
      }))
    ]);
  const maxReads = options.maxReads ?? 8;
  const recentReads = reads.slice(-maxReads);
  if (recentReads.length === 0) {
    return [];
  }

  if (japanese) {
    return [
      "他プレイヤーが直近で既に出した読み:",
      ...recentReads.map((read) => readSummaryLine(read, language)),
      "",
      "発言の重複を避ける:",
      "- 同じ対象と同じ理由を繰り返すだけにしない。",
      "- 同意する時も、自分の投票への影響、別の根拠、反論、比較対象のどれかを一つ足す。",
      "- 既に複数人が同じ読みを出しているなら、さらに重ねるより、保留、別候補、信用判断、投票方針へ話を進める。"
    ];
  }

  return [
    "Recent public reads already used by other players:",
    ...recentReads.map((read) => readSummaryLine(read, language)),
    "",
    "Avoid repeated table angles:",
    "- Do not merely repeat the same target and the same reason.",
    "- If you agree, add one distinct vote consequence, evidence point, challenge, or comparison.",
    "- If several players already share that read, move the discussion forward with a hold, alternate candidate, claim judgment, or vote plan."
  ];
}

export const firstDayOpeningMoveKinds = [
  "overstate_village_side",
  "state_vote_criteria",
  "ask_role_claim_policy",
  "tentative_reaction_read",
  "early_power_role_attention"
] as const satisfies readonly FirstDayOpeningMoveKind[];

export function firstDayOpeningMove(kind: FirstDayOpeningMoveKind, language: string): FirstDayOpeningMove {
  const japanese = isJapaneseLanguage(language);
  const definitions: Record<FirstDayOpeningMoveKind, FirstDayOpeningMove> = {
    overstate_village_side: {
      kind,
      label: japanese ? "村側アピールが強すぎる" : "Overstate village-side self-defense",
      instruction: japanese
        ? "初日限定の火種として、自分は人間側だと少し強めに言いすぎる。周囲が防御感を拾える余地を残す。"
        : "As a first-day spark, slightly overstate that you are on the village side, leaving room for others to read it as defensive."
    },
    state_vote_criteria: {
      kind,
      label: japanese ? "投票基準を出す" : "State vote criteria",
      instruction: japanese
        ? "初日の投票基準を先に出す。発言量、返答の具体性、態度の硬さなど、今後見たい基準を短く示す。"
        : "Open by stating first-day vote criteria such as speaking volume, concrete answers, or stiffness."
    },
    ask_role_claim_policy: {
      kind,
      label: japanese ? "役職CO方針を聞く" : "Ask claim-policy preferences",
      instruction: japanese
        ? "占い師などの役職COを今日どう扱うか、出るべきか潜るべきかの方針を全体に聞く。"
        : "Ask the table how role claims, especially Seer claims, should be handled today."
    },
    tentative_reaction_read: {
      kind,
      label: japanese ? "発言順・態度・反応を暫定材料にする" : "Use order, posture, or reaction as tentative material",
      instruction: japanese
        ? "初日限定で、発言順、態度、反応の薄さを暫定材料として扱う。ただし強い断定ではなく、反応を見るための軽い注目に留める。"
        : "For day one only, treat speaking order, posture, or thin reactions as tentative material without hard certainty."
    },
    early_power_role_attention: {
      kind,
      label: japanese ? "能力者への触れ方が早い" : "Touch power roles early",
      instruction: japanese
        ? "占い師・魔女・騎士に早めに触れる。露出を強く迫りすぎず、守り方や触れ方の方針を話題にする。"
        : "Bring up Seer, Witch, or Guard early without forcing exposure, using protection or handling policy as the topic."
    }
  };
  return definitions[kind];
}

function cause(kind: PublicNightDeathCause["kind"], language: string): PublicNightDeathCause {
  return { kind, label: labels(language).causeLabels[kind] };
}

function publicCauseLabel(): string | null {
  return null;
}

function possibleNightDeathCauses(players: Player[], language: string): PublicNightDeathCause[] {
  const roles = new Set(players.map((player) => player.role));
  const causes: PublicNightDeathCause[] = [];
  const add = (kind: PublicNightDeathCause["kind"]) => {
    if (!causes.some((existing) => existing.kind === kind)) {
      causes.push(cause(kind, language));
    }
  };

  if (players.some((player) => player.camp === "werewolf")) {
    add("werewolf_attack");
  }
  if (roles.has("Witch")) {
    add("witch_poison");
  }
  if (players.some((player) => player.camp === "werewolf") && roles.has("Witch")) {
    add("werewolf_and_witch_overlap");
  }
  if (roles.has("Hunter")) {
    add("hunter_death_shot");
  }
  if (roles.has("AlphaWolf")) {
    add("alpha_wolf_death_shot");
  }
  if (roles.has("Lover")) {
    add("lover_linked_death");
  }
  if (roles.has("WolfBeauty")) {
    add("wolf_beauty_charm_linked_death");
  }

  return causes;
}

function intent(kind: SpeechIntent["kind"], language: string): SpeechIntent {
  return {
    kind,
    label: kind,
    instruction: labels(language).intents[kind]
  };
}

function publicNightDeathInfo(death: DeathRecord, players: Player[]): PublicNightDeathInfo {
  const player = players.find((candidate) => candidate.id === death.playerId);
  return {
    playerId: death.playerId,
    playerName: player?.name ?? death.playerId,
    publicCauseLabel: publicCauseLabel()
  };
}

export function buildPublicSpeechPlan(input: BuildPublicSpeechPlanInput): PublicSpeechPlan {
  const deaths = input.lastNightDeaths.map((death) => publicNightDeathInfo(death, input.players));
  const intents: SpeechIntent[] = [];

  if (deaths.length > 0 && input.phase === "day_discussion") {
    intents.push(intent("connect_night_death_to_living_players", input.language));
    intents.push(input.discussionPass && input.discussionPass > 1 ? intent("answer_or_update", input.language) : intent("state_living_read", input.language));
  } else if (input.phase === "day_discussion") {
    intents.push(input.discussionPass && input.discussionPass > 1 ? intent("answer_or_update", input.language) : intent("open_discussion", input.language));
  } else if (input.phase === "voting") {
    intents.push(intent("vote_ready_read", input.language));
  }

  if (intents.length === 0 && input.legalPlayers.length > 0) {
    intents.push(intent("update_living_read", input.language));
  }

  return {
    phase: input.phase,
    round: input.round,
    lastNightDeaths: deaths,
    possibleNightDeathCauses: possibleNightDeathCauses(input.players, input.language),
    intents,
    firstDayOpeningMove: input.firstDayOpeningMove,
    requiresForwardMove: input.legalPlayers.length > 0 && (input.phase === "day_discussion" || input.phase === "voting")
  };
}

export function renderPublicSpeechPlan(plan: PublicSpeechPlan, language: string): string[] {
  const text = labels(language);
  const deaths =
    plan.lastNightDeaths.length > 0
      ? plan.lastNightDeaths
          .map((death) => `${death.playerName} (${death.playerId}) / ${text.publicCause}: ${death.publicCauseLabel ?? text.unknownCause}`)
          .join(", ")
      : isJapaneseLanguage(language)
        ? "なし"
        : "none";
  const possibleCauses = plan.possibleNightDeathCauses.map((possible) => possible.label).join(isJapaneseLanguage(language) ? "、" : ", ");
  return [
    text.publicKnowledgeTitle + ":",
    `- ${text.deathLine}: ${deaths}.`,
    `- ${text.possibleCausesTitle}: ${possibleCauses}.`,
    "",
    text.speechPlanTitle + ":",
    ...(plan.firstDayOpeningMove
      ? [
          `- ${text.firstDaySpecialTitle}: ${plan.firstDayOpeningMove.label}`,
          `- ${plan.firstDayOpeningMove.instruction}`
        ]
      : []),
    ...plan.intents.map((item) => `- ${item.instruction}`),
    ...(plan.requiresForwardMove ? [`- ${text.mustStateStance}`] : []),
    ...(plan.requiresForwardMove && plan.lastNightDeaths.length > 0 ? [`- ${text.mustAdvance}`] : [])
  ];
}

function includesAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => needle.length > 0 && text.includes(needle));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasVisibleStance(text: string, legalPlayers: TargetCandidate[], language: string): boolean {
  if (isJapaneseLanguage(language)) {
    const stanceTail = "(?:$|\\s|[。！？!、]|ので|から|けど|が)";
    const assertiveStance =
      [
        `疑い寄り(?:です|で見(?:ます|る)?|に置(?:きます|く)?)?${stanceTail}`,
        `疑って(?:います|いる|ます)${stanceTail}`,
        `疑う理由(?:があります|です)${stanceTail}`,
        `疑い(?:を向け(?:ます|る)|を置(?:きます|く)|があります|です)${stanceTail}`,
        `怪しい(?:です|と思(?:います|う)|と見(?:ます|る)|ので|から)${stanceTail}`,
        `気にな(?:ります|る(?:ので|から))${stanceTail}`,
        `不自然(?:です|だと思(?:います|う)|と見(?:ます|る)|なので|だから)${stanceTail}`,
        `信頼寄り(?:です|で見(?:ます|る)?|に置(?:きます|く)?)?${stanceTail}`,
        `信頼して(?:います|いる|ます)${stanceTail}`,
        `信頼でき(?:ます|ると思(?:います|う)|ると見(?:ます|る))${stanceTail}`,
        `信じ(?:たい|ます|ています|ている)(?:です)?${stanceTail}`,
        `信用寄り(?:です|で見(?:ます|る)?|に置(?:きます|く)?)?${stanceTail}`,
        `信用して(?:います|いる|ます)${stanceTail}`,
        `信用でき(?:ます|ると思(?:います|う)|ると見(?:ます|る))${stanceTail}`,
        `信用を保留(?:します|する|です)${stanceTail}`,
        `(?:白|村|黒|狼|真|偽)寄り(?:です|で見(?:ます|る)?|に置(?:きます|く)?)?${stanceTail}`,
        `保留(?:です|します|する|にします|に置(?:きます|く)?|で見(?:ます|る)?|寄り(?:です|で見(?:ます|る)?|に置(?:きます|く)?)?)${stanceTail}`,
        `投票候補(?:です|に入れ(?:ます|る)|に置(?:きます|く)|として)${stanceTail}`,
        `投票先(?:です|にします|にする|として)${stanceTail}`,
        `投票(?:します|する)${stanceTail}`,
        `吊(?:る|りたい|り候補|り先)${stanceTail}`,
        `候補に入れ(?:ます|る)${stanceTail}`,
        `重く見(?:ます|る)${stanceTail}`
      ].join("|");
    const targetStance = legalPlayers.some((player) => {
      const name = `${escapeRegExp(player.name)}(?:さん)?|${escapeRegExp(player.id)}`;
      return new RegExp(`(?:${name})[^。！？!?]{0,36}(?:${assertiveStance})`, "u").test(text);
    });
    const claimStance = new RegExp(
      [
        "(?:占い|霊媒|狩人|ハンター|魔女|役職|主張|CO|名乗)[^。！？!?]{0,36}(?:",
        assertiveStance,
        ")",
        "|(?:",
        assertiveStance,
        ")[^。！？!?]{0,36}(?:占い|霊媒|狩人|ハンター|魔女|役職|主張|CO|名乗)"
      ].join(""),
      "u"
    ).test(text);
    return targetStance || claimStance;
  }

  const assertiveStance =
    /(?:suspect|am suspicious of|trust|hold|lean (?:trust|suspicion|village|wolf)|vote candidate|vote target|vote for|would eliminate|black lean|white lean|wolf lean|village lean|true claim|fake claim|claim trust|claim suspicion)/i;
  const textHasLivingTarget = legalPlayers.some((player) => includesAny(text, [player.name, player.id]));
  const claimStance = /claim|seer|medium|guard|hunter|witch|role/i.test(text) && assertiveStance.test(text);
  return (textHasLivingTarget && assertiveStance.test(text)) || claimStance;
}

function hasFirstDayOpeningMoveStance(text: string, plan: PublicSpeechPlan | undefined, language: string): boolean {
  const move = plan?.firstDayOpeningMove;
  if (!move) {
    return false;
  }

  if (isJapaneseLanguage(language)) {
    if (move.kind === "overstate_village_side") {
      return /(?:私|僕|自分|こちら)(?:は|が)?[^。！？!?]{0,16}(?:村側|人間側|村人|白|吊られたくない)/u.test(text);
    }
    if (move.kind === "state_vote_criteria") {
      return /(?:投票基準|基準|発言量|返答|具体的|態度)/u.test(text);
    }
    if (move.kind === "ask_role_claim_policy") {
      return /(?:役職CO|CO|占い師|出る|潜る|方針)/u.test(text);
    }
    if (move.kind === "tentative_reaction_read") {
      return /(?:発言順|態度|反応|様子|硬く|薄さ|暫定材料|暫定)/u.test(text);
    }
    return /(?:占い師|魔女|騎士|護衛|守り方|能力者)/u.test(text);
  }

  if (move.kind === "overstate_village_side") {
    return /\b(I|I'm|I am|my)\b.{0,40}\b(village|villager|town|not a wolf|should not be eliminated)\b/i.test(text);
  }
  if (move.kind === "state_vote_criteria") {
    return /\b(vote criteria|criteria|concrete answers|speaking volume|take a position|stiffness)\b/i.test(text);
  }
  if (move.kind === "ask_role_claim_policy") {
    return /\b(role claim|claim policy|Seer claim|come out|stay hidden)\b/i.test(text);
  }
  if (move.kind === "tentative_reaction_read") {
    return /\b(tentative|reaction|posture|stiff|speaking order)\b/i.test(text);
  }
  return /\b(Seer|Witch|Guard|power role|protection)\b/i.test(text);
}

export function reviewSpeechTimeline(
  speech: AgentSpeech,
  publicHistory: string[],
  legalPlayers: TargetCandidate[],
  phase: Phase,
  language: string,
  plan?: PublicSpeechPlan
): SpeechPlanReview {
  if (!isJapaneseLanguage(language) || phase !== "day_discussion") {
    return { ok: true, issues: [] };
  }

  const text = speech.messages.join(" ");
  const allowOpeningAttitudeReference =
    publicHistory.length === 0 && plan?.firstDayOpeningMove?.kind === "tentative_reaction_read";
  const genericUnseenReference =
    publicHistory.length === 0 &&
    /(?:の言う通り|が言う通り|言った通り|指摘に同意|整理に同意|さっき|先ほど|今の反応|今の発言|乗っただけ|便乗|煙幕|煙に巻)/u.test(
      text
    );

  const citesUnseenPlayer = legalPlayers.some((player) => {
    const name = `${escapeRegExp(player.name)}(?:さん)?`;
    const speakerHistory = new RegExp(`^\\s*${escapeRegExp(player.name)}\\s*:`, "u");
    const hasVisibleSpeech = publicHistory.some((line) => speakerHistory.test(line));
    if (hasVisibleSpeech) {
      return false;
    }

    const observedReference = new RegExp(
      [
        `${name}(?:の|が|は)?(?:言う通り|言った通り)`,
        `${name}の(?:指摘|整理)(?:に同意|の通り|通り|を受けて|から|に一つ|に乗)`,
        `${name}(?:に同意|に乗った|に乗る)`,
        `${name}の発言(?!が出たら)(?:が|は|も|だけ|から|で|を)[^。！？!?]{0,20}(?:少な|薄|曖昧|弱|強|気になる|不自然|怪し|見え|変わ|ずれ|乗|便乗|ごまか|そら)`,
        `${name}の返答(?:が|は|も|だけ|から|で)[^。！？!?]{0,20}(?:早|遅|弱|強|防御|曖昧|気になる|不自然|怪し|見え|変わ|ずれ|ごまか|そら)`,
        `${name}の(?:今の|さっきの|先ほどの)反応(?:が|は|も|だけ|から|で)[^。！？!?]{0,20}(?:早|遅|弱|強|防御|曖昧|気になる|不自然|怪し|見え|変わ|ずれ|ごまか|そら)`,
        `${name}の(?:今の|さっきの|先ほどの)?動き(?:が|は|も|だけ|から|で)?[^。！？!?]{0,20}(?:気になる|不自然|怪し|見え|変わ|ずれ|便乗|ごまか|そら)`,
        ...(allowOpeningAttitudeReference
          ? []
          : [
              `${name}の反応(?:が|は|も|だけ|から|で)[^。！？!?]{0,20}(?:早|遅|弱|強|防御|曖昧|気になる|不自然|怪し|見え|変わ|ずれ|ごまか|そら)`
            ]),
        `${name}(?:が|は)?(?:便乗|ごまか|話をそら|煙に巻)`
      ].join("|"),
      "u"
    );
    return observedReference.test(text);
  });

  if (genericUnseenReference || citesUnseenPlayer) {
    return {
      ok: false,
      issues: ["speech cites unseen prior public speech or action"],
      revisionHint: labels(language).emptyHistoryRevisionHint
    };
  }

  return { ok: true, issues: [] };
}

export function reviewSpeechAgainstPlan(
  speech: AgentSpeech,
  plan: PublicSpeechPlan | undefined,
  legalPlayers: TargetCandidate[],
  language: string
): SpeechPlanReview {
  if (!plan?.requiresForwardMove) {
    return { ok: true, issues: [] };
  }

  const text = speech.messages.join(" ");
  const hasStance = hasVisibleStance(text, legalPlayers, language) || hasFirstDayOpeningMoveStance(text, plan, language);

  const deathNames = plan.lastNightDeaths.map((death) => death.playerName);
  const mentionsNightDeath = includesAny(text, deathNames) || /死亡|死|噛|襲撃|毒|died|death|dead|killed|attack|poison/i.test(text);
  if (hasStance) {
    return { ok: true, issues: [] };
  }

  return {
    ok: false,
    issues: [mentionsNightDeath ? "speech stops at night-death recap without a visible stance" : "speech does not state a visible stance"],
    revisionHint: labels(language).revisionHint
  };
}
