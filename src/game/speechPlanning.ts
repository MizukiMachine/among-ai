import { isJapaneseLanguage } from "./i18n";
import type { DeathRecord } from "./rules/types";
import type {
  AgentSpeech,
  Phase,
  Player,
  PublicNightDeathCause,
  PublicNightDeathInfo,
  PublicSpeechPlan,
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
}

interface SpeechPlanReview {
  ok: boolean;
  issues: string[];
  revisionHint?: string;
}

function labels(language: string) {
  const japanese = isJapaneseLanguage(language);
  return {
    unknownCause: japanese ? "不明" : "unknown",
    possibleCausesTitle: japanese ? "公開ルール上あり得る夜死亡" : "Public-rule night death causes in this setup",
    speechPlanTitle: japanese ? "この発言の設計" : "Speech plan",
    publicKnowledgeTitle: japanese ? "公開知識" : "Public knowledge",
    deathLine: japanese ? "昨夜の死亡" : "Last night's deaths",
    publicCause: japanese ? "公開上の死因" : "public cause",
    mustAdvance: japanese
      ? "死因候補を並べるだけで終わらず、生存者への読み、投票理由、役職主張の評価のどれかに進める。"
      : "Do not stop at listing death causes; advance to a read, vote reason, or claim evaluation about a living player.",
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
        ? "公開情報が少ない時も、生存者への暫定読みを一つ出して議論を始める。"
        : "When public information is thin, open with one tentative read on a living player."
    },
    revisionHint: japanese
      ? "前の返答は死亡理由の整理で止まっています。生存者への読み、投票理由、役職主張の評価のどれかを含むセリフに直してください。"
      : "The previous response stopped at recapping death causes. Revise it to include a read, vote reason, or claim evaluation about a living player.",
    emptyHistoryRevisionHint: japanese
      ? "前の返答は、まだ公開発言がない状況で他人の発言や動きを既にあった事実のように引用しています。人物傾向として注目する、または発言が出たら見たい、という言い方に直してください。"
      : "The previous response cited another player's speech or action as if it had already happened, but no public statements are visible yet. Revise it as a tentative character-based watch, not observed evidence."
  };
}

function cause(kind: PublicNightDeathCause["kind"], language: string): PublicNightDeathCause {
  return { kind, label: labels(language).causeLabels[kind] };
}

function publicCauseLabel(death: DeathRecord, language: string): string | null {
  const text = labels(language).causeLabels;
  if (death.cause === "hunter") {
    return text.hunter_death_shot;
  }
  if (death.cause === "alpha_wolf") {
    return text.alpha_wolf_death_shot;
  }
  if (death.cause === "lover") {
    return text.lover_linked_death;
  }
  if (death.cause === "wolf_beauty_charm") {
    return text.wolf_beauty_charm_linked_death;
  }
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

function publicNightDeathInfo(death: DeathRecord, players: Player[], language: string): PublicNightDeathInfo {
  const player = players.find((candidate) => candidate.id === death.playerId);
  return {
    playerId: death.playerId,
    playerName: player?.name ?? death.playerId,
    publicCauseLabel: publicCauseLabel(death, language)
  };
}

export function buildPublicSpeechPlan(input: BuildPublicSpeechPlanInput): PublicSpeechPlan {
  const deaths = input.lastNightDeaths.map((death) => publicNightDeathInfo(death, input.players, input.language));
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
    requiresForwardMove: deaths.length > 0 && (input.phase === "day_discussion" || input.phase === "voting")
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
    ...plan.intents.map((item) => `- ${item.instruction}`),
    ...(plan.requiresForwardMove ? [`- ${text.mustAdvance}`] : [])
  ];
}

function includesAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => needle.length > 0 && text.includes(needle));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function reviewSpeechTimeline(
  speech: AgentSpeech,
  publicHistory: string[],
  legalPlayers: TargetCandidate[],
  phase: Phase,
  language: string
): SpeechPlanReview {
  if (!isJapaneseLanguage(language) || phase !== "day_discussion") {
    return { ok: true, issues: [] };
  }

  const text = speech.messages.join(" ");
  const genericUnseenReference =
    publicHistory.length === 0 &&
    /(?:の言う通り|が言う通り|言った通り|指摘に同意|整理に同意|さっき|先ほど|今の反応|今の発言|乗っただけ|便乗|煙幕|煙に巻)/u.test(text);

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
        `${name}の(?:反応|返答)(?:が|は|も|だけ|から|で)[^。！？!?]{0,20}(?:早|遅|弱|強|防御|曖昧|気になる|不自然|怪し|見え|変わ|ずれ|ごまか|そら)`,
        `${name}の(?:今の|さっきの|先ほどの)?動き(?:が|は|も|だけ|から|で)?[^。！？!?]{0,20}(?:気になる|不自然|怪し|見え|変わ|ずれ|便乗|ごまか|そら)`,
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
  const targetIds = new Set(legalPlayers.map((player) => player.id));
  const textHasLivingTarget = legalPlayers.some((player) => includesAny(text, [player.name, player.id]));
  const hasStructuredForwardMove =
    speech.metadata.suspects.some((read) => targetIds.has(read.targetId)) ||
    speech.metadata.trusts.some((read) => targetIds.has(read.targetId)) ||
    speech.metadata.claims.some((claim) => !claim.targetId || targetIds.has(claim.targetId));
  const hasForwardRead = isJapaneseLanguage(language)
    ? /理由|時系列|発言|投票|主張|反応|疑|信頼|怪しい|気になる|保留|絞|読み|見える|評価|候補|黒|白/.test(text)
    : /reason|timeline|statement|vote|claim|reaction|suspect|trust|read|hold|candidate|black|white|evaluate/i.test(text);

  if (hasStructuredForwardMove || (textHasLivingTarget && hasForwardRead)) {
    return { ok: true, issues: [] };
  }

  const deathNames = plan.lastNightDeaths.map((death) => death.playerName);
  const mentionsNightDeath = includesAny(text, deathNames) || /死亡|死|噛|襲撃|毒|died|death|dead|killed|attack|poison/i.test(text);
  if (!mentionsNightDeath) {
    return { ok: true, issues: [] };
  }

  return {
    ok: false,
    issues: ["speech stops at night-death recap without a living-player move"],
    revisionHint: labels(language).revisionHint
  };
}
