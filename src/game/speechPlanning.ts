import { isJapaneseLanguage } from "./i18n";
import { textHasSeerClaimEvidence } from "./daySituations";
import type { DeathRecord } from "./rules/types";
import type {
  AgentSpeech,
  DiscussionAgenda,
  FirstDayOpeningMove,
  FirstDayOpeningMoveKind,
  Phase,
  Player,
  PublicNightDeathCause,
  PublicNightDeathInfo,
  PublicSpeechPlan,
  SpeechMetadata,
  SpeechIntent,
  TargetCandidate,
  VoteRecord
} from "./types";

interface BuildPublicSpeechPlanInput {
  phase: Phase;
  round: number;
  discussionPass?: number;
  players: Player[];
  lastNightDeaths: DeathRecord[];
  legalPlayers: TargetCandidate[];
  language: string;
  speakerId?: string;
  publicHistory?: string[];
  previousVotes?: VoteRecord[];
  firstDayOpeningMove?: FirstDayOpeningMove;
  /**
   * Optional escape hatch for tests or future scheduled turns that should not force
   * a stance even after the opening turn.
   */
  suppressForwardMove?: boolean;
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
    discussionAgendaTitle: japanese ? "議題スケジューラ" : "Discussion agenda",
    speechPlanTitle: japanese ? "この発言の設計" : "Speech plan",
    firstDaySpecialTitle: japanese ? "初日特別モード" : "First-day opening mode",
    publicKnowledgeTitle: japanese ? "公開知識" : "Public knowledge",
    deathLine: japanese ? "昨夜の死亡" : "Last night's deaths",
    publicCause: japanese ? "公開上の死因" : "public cause",
    mustAdvance: japanese
      ? "死因候補を並べるだけで終わらず、生存者への読み、投票理由、役職主張の評価のどれかに進める。"
      : "Do not stop at listing death causes; advance to a read, vote reason, or claim evaluation about a living player.",
    mustStateStance: japanese
      ? "発言ターンを使うので、質問、様子見、今後見る点だけで終えず、自分の疑い・信頼・投票候補・役職主張への判断を必ず言う。保留する時も、理由と次に確認したい点を一緒に言う。"
      : "Because speech turns are limited, do not end with only a question, wait-and-see note, or future watch point; state your suspicion, trust, vote candidate, or claim-trust stance. If you hold, pair it with a reason and what you want checked next.",
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
        ? "生存者を一人以上挙げて、自分の疑い・信頼・投票候補の理由を言う。保留する時も、理由と次に確認したい点を添える。"
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
        ? "公開情報が少ない時も、自分の意見として生存者への暫定の疑い・信頼・投票候補を一つ出して議論を始める。保留する時は理由と次に確認したい点を添える。"
        : "When public information is thin, open with one tentative suspicion, trust, hold, or vote-candidate read on a living player.",
      open_first_day: japanese
        ? "まだ占い結果も投票履歴もなく、会話の材料は薄い。見えていない反応は根拠にせず、投票基準、占い師が名乗る条件、役職を明かさせすぎない方針、名指し質問、軽い初日仮説のどれかを自分から出して議論を動かす。『様子見』『保留』『話を聞く』で終えない。"
        : "There are no public statements, Seer results, or vote history yet. Do not invent unseen reactions; move the table by offering vote criteria, claim-handling policy, a direct question, or a light day-one hypothesis. Do not end with only 'wait and see,' 'hold,' or 'hear people out.'"
    },
    revisionHint: japanese
      ? "前の返答は自分の判断が足りません。生存者への疑い・信頼・投票候補、または役職主張への判断を、画面に出るセリフ内ではっきり言ってください。保留する時も理由を添えてください。"
      : "The previous response did not state your stance. Revise the displayed dialogue to include suspicion, trust, hold, a vote candidate, or a claim-trust judgment.",
    emptyHistoryRevisionHint: japanese
      ? "前の返答は、まだこの昼の発言が見えていない状況で他人の発言や動きを既にあった事実のように引用しています。初日は、見えていない反応を根拠にせず、投票基準、占い師が名乗る条件、名指し質問、軽い初日仮説など、材料なしでも自分から動かせる議題に直してください。"
      : "The previous response cited another player's speech or action as if it had already happened, but no public statements are visible yet. Revise it as a tentative character- or role-based suspicion, trust, hold, or vote-candidate stance.",
    unseenClaimRevisionHint: japanese
      ? "前の返答は、見えている昼の発言にない占い師COや役職主張が出た前提で話しています。初日は、まだ出ていない主張を既成事実にせず、投票基準、占い師が名乗る条件、名指し質問、軽い初日仮説などに直してください。"
      : "The previous response treated a Seer or role claim as visible even though no such public claim is in the visible discussion. Revise without assuming that claim exists.",
    openingFillerRevisionHint: japanese
      ? "前の返答は受け身で、議論を動かしていません。初日でも、投票基準、占い師が名乗る条件、役職を明かさせすぎない方針、名指し質問、軽い投票候補のどれかを自分から出してください。"
      : "The previous response was passive and did not move the discussion. Even on day one, add vote criteria, claim policy, a direct question, or a light vote candidate."
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
      "- 既に複数人が同じ読みを出しているなら、さらに重ねるより、別候補、役職主張への判断、投票方針へ話を進める。"
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

// Round-one opening sparks. Each first-pass speaker is assigned one so the table
// starts with concrete, varied pressure (vote criteria, claim policy, direct
// questions, light day-one pressure, setup organizing) instead of degenerating
// into content-free "様子見"/"保留" filler.
export const firstDayOpeningMoveKinds = [
  "state_vote_criteria",
  "ask_role_claim_policy",
  "ask_table_question",
  "tentative_reaction_read",
  "early_power_role_attention",
  "organize_setup",
  "overstate_village_side",
  "self_introduction"
] as const satisfies readonly FirstDayOpeningMoveKind[];

export const firstDayWerewolfOpeningMoveKinds = [
  "wolf_human_side_claim",
  "wolf_fake_role_claim"
] as const satisfies readonly FirstDayOpeningMoveKind[];

export function firstDayOpeningMove(kind: FirstDayOpeningMoveKind, language: string): FirstDayOpeningMove {
  const japanese = isJapaneseLanguage(language);
  const definitions: Record<FirstDayOpeningMoveKind, FirstDayOpeningMove> = {
    self_introduction: {
      kind,
      label: japanese ? "自己紹介から入る" : "Open with a self-introduction",
      instruction: japanese
        ? "短い自己紹介から入ったうえで、今日の投票基準か最初に聞きたい質問を一つ出す。『みんなの話を聞いてから』だけで止めない。"
        : "Open with a short self-introduction, then state one vote criterion or one question you want answered today. Do not stop at hearing people out."
    },
    organize_setup: {
      kind,
      label: japanese ? "配役構成や流れを整理する" : "Organize the setup or flow",
      instruction: japanese
        ? "配役構成や人数、初日にやるべきことを整理し、投票基準か役職の名乗り条件のどちらを先に決めるか具体的に提案する。"
        : "Organize the setup and day-one tasks, then make a concrete proposal about vote criteria or role-claim conditions."
    },
    overstate_village_side: {
      kind,
      label: japanese ? "村側アピールが強すぎる" : "Overstate village-side self-defense",
      instruction: japanese
        ? "初日限定の火種として、自分は人間側だと少し強めに言い、様子見だけの相手は投票候補に入れる余地を残す。"
        : "As a first-day spark, slightly overstate that you are on the village side, leaving room for others to read it as defensive."
    },
    wolf_human_side_claim: {
      kind,
      label: japanese ? "人狼の人間側アピール" : "Werewolf claims village-side alignment",
      instruction: japanese
        ? "あなたは人狼陣営です。公開の初日発言では正体を隠し、自分は人間側だとはっきり主張したうえで、理由の薄い相手や様子見の相手を投票候補に入れる流れを作る。仲間や夜の相談は絶対に漏らさない。"
        : "You are on the werewolf team. In this public opening, hide that identity, explicitly claim you are village-side, and create pressure against thin or passive players. Never expose allies or wolf-only chat."
    },
    wolf_fake_role_claim: {
      kind,
      label: japanese ? "人狼の偽役職アピール" : "Werewolf seeds a fake role claim",
      instruction: japanese
        ? "あなたは人狼陣営です。公開の初日発言では正体を隠し、占い師など人間側役職をはっきり名乗って場を揺らす。結果を作り込みすぎず、反応を見る一言と投票基準につなげる。"
        : "You are on the werewolf team. In this public opening, hide that identity and clearly claim a village-side role such as Seer. Keep it light and tie it to reactions or vote criteria."
    },
    state_vote_criteria: {
      kind,
      label: japanese ? "投票基準を出す" : "State vote criteria",
      instruction: japanese
        ? "初日の投票基準を先に出す。理由の具体性、質問への答え方、便乗していないかなど、投票候補に入れる条件を短く示す。"
        : "Open by stating first-day vote criteria such as speaking volume, concrete answers, or stiffness."
    },
    ask_role_claim_policy: {
      kind,
      label: japanese ? "占い師が名乗る条件を聞く" : "Ask claim-policy preferences",
      instruction: japanese
        ? "占い師が今日名乗るべき条件について、自分の仮案を先に言ってから全体に聞く。すぐ名乗るのか、結果が重い時だけ名乗るのか、伏せるならどう守るのかを話題にする。"
        : "Ask the table how role claims, especially Seer claims, should be handled today."
    },
    ask_table_question: {
      kind,
      label: japanese ? "序盤の質問を投げる" : "Ask an opening table question",
      instruction: japanese
        ? "誰か一人か全体に短い質問を投げる。今日の投票理由、占い師が名乗る条件、役職を明かさせすぎない進め方のどれかを聞き、自分の基準も一言添える。"
        : "Ask one player or the table a short question about vote reasons, Seer reveal conditions, or avoiding forced role exposure, and include your own criterion."
    },
    tentative_reaction_read: {
      kind,
      label: japanese ? "名指しで軽く理由を聞く" : "Apply light named pressure",
      instruction: japanese
        ? "初日限定で、一人を名指しして軽く理由を聞く。見えていない過去発言は引用せず、人物傾向・役職方針・初日姿勢からの軽い質問や投票候補に留める。"
        : "For day one only, name one player and apply light pressure from personality, role-policy posture, or first-day stance without citing unseen prior speech."
    },
    early_power_role_attention: {
      kind,
      label: japanese ? "能力者への触れ方が早い" : "Touch power roles early",
      instruction: japanese
        ? "占い師・魔女・騎士に早めに触れる。役職を明かすよう強く迫らず、名乗る条件、守り方、話題に出す範囲の方針を一つ提案する。"
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

function recentPublicHistory(input: BuildPublicSpeechPlanInput): string[] {
  const history = input.publicHistory ?? [];
  return input.round <= 2 ? history : history.slice(-36);
}

function livingPlayerNames(input: BuildPublicSpeechPlanInput): string[] {
  return input.players.filter((player) => player.alive).map((player) => player.name);
}

function lineMentionsLivingPlayer(line: string, input: BuildPublicSpeechPlanInput): boolean {
  return livingPlayerNames(input).some((name) => line.includes(name));
}

function lineMentionsLivingBlackTarget(line: string, input: BuildPublicSpeechPlanInput): boolean {
  const blackResultPattern = /checked as werewolf|checked werewolf|reads as werewolf|人狼判定/i;
  if (!blackResultPattern.test(line)) {
    return false;
  }
  const names = livingPlayerNames(input);
  const labeledTarget = line.match(/(?:対象|target|on)[:：]?\s*([^\s、。,.]+)/i)?.[1];
  if (labeledTarget) {
    return names.some((name) => labeledTarget.includes(name));
  }
  return names.some((name) => {
    const escapedName = escapeRegExp(name);
    return [
      new RegExp(`${escapedName}(?:は|が|を|\\s+)[^\\n。.!?]{0,24}(?:checked as werewolf|checked werewolf|reads as werewolf|人狼判定)`, "i"),
      new RegExp(`(?:checked as werewolf|checked werewolf|reads as werewolf|人狼判定)[^\\n。.!?]{0,24}${escapedName}`, "i")
    ].some((pattern) => pattern.test(line));
  });
}

function hasVisibleSeerClaim(input: BuildPublicSpeechPlanInput): boolean {
  return recentPublicHistory(input).some((line) => textHasSeerClaimEvidence(line) && lineMentionsLivingPlayer(line, input));
}

function hasVisibleBlackResult(input: BuildPublicSpeechPlanInput): boolean {
  return recentPublicHistory(input).some((line) => lineMentionsLivingBlackTarget(line, input));
}

function playerNameById(players: Player[], playerId: string): string {
  return players.find((player) => player.id === playerId)?.name ?? playerId;
}

function previousVoteSummary(input: BuildPublicSpeechPlanInput): string | null {
  const votes = input.previousVotes ?? [];
  if (votes.length === 0) {
    return null;
  }
  const japanese = isJapaneseLanguage(input.language);
  const counts = new Map<string, number>();
  for (const vote of votes) {
    counts.set(vote.targetId, (counts.get(vote.targetId) ?? 0) + 1);
  }
  const totals = [...counts.entries()].sort((a, b) => b[1] - a[1] || playerNameById(input.players, a[0]).localeCompare(playerNameById(input.players, b[0])));
  const top = totals.slice(0, 3).map(([targetId, count]) => {
    const name = playerNameById(input.players, targetId);
    return japanese ? `${name}${count}票` : `${name} ${count}`;
  });
  const sampleVotes = votes.slice(0, 5).map((vote) => `${playerNameById(input.players, vote.voterId)} -> ${playerNameById(input.players, vote.targetId)}`);
  const overflow = votes.length > sampleVotes.length ? (japanese ? ` 他${votes.length - sampleVotes.length}票` : ` +${votes.length - sampleVotes.length} more`) : "";
  return japanese
    ? `得票上位: ${top.join("、")}。投票例: ${sampleVotes.join("、")}${overflow}。`
    : `Top vote totals: ${top.join(", ")}. Vote examples: ${sampleVotes.join(", ")}${overflow}.`;
}

function laterDayOpeningAgendaKind(input: BuildPublicSpeechPlanInput): DiscussionAgenda["kind"] {
  const kinds: DiscussionAgenda["kind"][] = [];
  if (hasVisibleBlackResult(input)) {
    kinds.push("later_day_black_result");
  }
  if (hasVisibleSeerClaim(input)) {
    kinds.push("later_day_claim_review");
  }
  if ((input.previousVotes ?? []).length > 0) {
    kinds.push("later_day_vote_review");
  }
  kinds.push("later_day_night_result", "later_day_read_update");

  const alivePlayers = input.players.filter((player) => player.alive);
  const offset = input.round > 1 && alivePlayers.length > 0 ? (input.round - 1) % alivePlayers.length : 0;
  const speakerOrder = [...alivePlayers.slice(offset), ...alivePlayers.slice(0, offset)];
  const speakerIndex = input.speakerId ? speakerOrder.findIndex((player) => player.id === input.speakerId) : 0;
  return kinds[Math.max(0, speakerIndex) % kinds.length];
}

function discussionAgendaFor(input: BuildPublicSpeechPlanInput, deaths: PublicNightDeathInfo[]): DiscussionAgenda | undefined {
  if (input.phase !== "day_discussion") {
    return undefined;
  }
  const japanese = isJapaneseLanguage(input.language);
  const pass = input.discussionPass ?? 1;
  const voteSummary = previousVoteSummary(input);
  const kind =
    pass > 2
      ? "pre_vote_follow_up"
      : input.round === 1 && pass <= 1
        ? "day_one_opening"
        : input.round === 1
          ? "day_one_response"
          : pass <= 1
            ? laterDayOpeningAgendaKind(input)
            : "later_day_response";

  const definitions: Record<DiscussionAgenda["kind"], DiscussionAgenda> = {
    day_one_opening: {
      kind: "day_one_opening",
      label: japanese ? "初日1巡目: 序盤議題で動かす" : "Day one, pass one: move the opening table",
      instruction: japanese
        ? "0日目の挨拶は本議論の材料にしない。まだ発言変化・矛盾・投票履歴はないが、全員が様子見にならないよう、投票基準、占い師が名乗る条件、役職を明かさせすぎない方針、名指し質問、軽い初日仮説のどれかを一つ出す。"
        : "Do not treat warm-up greetings as discussion evidence. There are no statement changes, contradictions, or votes yet, but prevent a passive table by offering vote criteria, claim conditions, role-exposure policy, a direct question, or a light day-one hypothesis."
    },
    day_one_response: {
      kind: "day_one_response",
      label: japanese ? "初日2巡目: 見えた議題に答える" : "Day one, pass two: answer visible agenda",
      instruction: japanese
        ? "1巡目で実際に見えた話だけに反応する。議題への賛否、投票基準の比較、占い師が名乗る条件への意見を短く出し、必要なら軽い投票候補まで進める。"
        : "React only to visible first-pass statements. Give agreement/disagreement on the agenda, compare vote standards, address Seer reveal conditions, and move to a light vote candidate if needed."
    },
    later_day_night_result: {
      kind: "later_day_night_result",
      label: japanese ? "2日目以降: 夜結果を生存者評価につなげる" : "Later day: connect the night result to living reads",
      instruction: japanese
        ? deaths.length > 0
          ? `昨夜の死亡: ${deaths.map((death) => death.playerName).join("、")}。死亡者を今の疑い先にせず、誰が得をしたか、誰の前日発言・投票とつながるかを生存者一人の評価に結びつける。`
          : "昨夜は死亡なし。護衛成功、魔女の救済、襲撃先選びを断定せず、誰の反応・役職主張・投票理由を見直すかまで話す。"
        : deaths.length > 0
          ? `Last night's deaths: ${deaths.map((death) => death.playerName).join(", ")}. Do not make the dead player a current target; connect who benefits or whose prior speech/vote fits to one living-player read.`
          : "No one died last night. Do not assert protection, a save, or target choice as certain; say whose reaction, claim, or vote reason should be rechecked."
    },
    later_day_vote_review: {
      kind: "later_day_vote_review",
      label: japanese ? "2日目以降: 前日の投票を検証する" : "Later day: review the prior vote",
      instruction: japanese
        ? `前日の投票を材料にする。${voteSummary ?? ""}得票が多い人、1票だけ離れた投票、前日の疑い先と投票先のズレ、今日あらためて理由を聞きたい投票のどれか一つを選び、生存者評価か投票候補に結びつける。`
        : `Use the prior vote as evidence. ${voteSummary ?? ""}Choose one of: high vote-getters, isolated votes, a mismatch between prior suspicion and vote target, or a vote whose reason should be asked again today, then connect it to a living read or vote candidate.`
    },
    later_day_claim_review: {
      kind: "later_day_claim_review",
      label: japanese ? "2日目以降: 役職主張を検証する" : "Later day: review visible role claims",
      instruction: japanese
        ? "見えている役職主張を材料にする。名乗ったタイミング、結果、対抗の有無、夜結果との整合、前日投票とのつながりのうち一つを見て、信用寄り・保留・疑い寄りのどこかを言う。"
        : "Use visible role claims as evidence. Pick one of timing, results, counterclaims, fit with the night result, or prior vote links, then state trust-leaning, hold, or suspicion."
    },
    later_day_black_result: {
      kind: "later_day_black_result",
      label: japanese ? "2日目以降: 黒判定をどう扱うか決める" : "Later day: decide how to handle a black result",
      instruction: japanese
        ? "黒判定が見えている。黒を出した人の信用、出された人の反応、前日投票とのつながり、今日処刑するか保留するかのどれか一つに絞って話す。自分だけの情報ではなく公開根拠で説明する。"
        : "A black result is visible. Focus on one of: the claimant's credibility, the accused player's reaction, prior vote links, or whether to eliminate or hold today. Explain with public evidence."
    },
    later_day_read_update: {
      kind: "later_day_read_update",
      label: japanese ? "2日目以降: 前日から読みを更新する" : "Later day: update a prior read",
      instruction: japanese
        ? "前日から見方が変わった相手を一人選ぶ。変わった理由を、夜結果、前日の投票、今日見えた発言、役職主張のどれか一つに結びつけて短く言う。"
        : "Pick one player whose read changed since yesterday. Tie the reason to one of: the night result, prior votes, today's visible speech, or a claim."
    },
    later_day_response: {
      kind: "later_day_response",
      label: japanese ? "2日目以降2巡目: 返答して投票候補を更新する" : "Later day, pass two: answer and update vote direction",
      instruction: japanese
        ? "直近で自分に向いた疑いがあれば短く答える。そのうえで、1巡目に実際に見えた夜結果・前日投票・役職主張・黒判定の話から、生存者への疑い・信頼・投票候補を一つ更新する。"
        : "Briefly answer pressure aimed at you, then update one suspicion, trust, or vote candidate from visible first-pass discussion about the night result, prior vote, claims, or black result."
    },
    pre_vote_follow_up: {
      kind: "pre_vote_follow_up",
      label: japanese ? "追加発言: 投票前に一つ絞る" : "Follow-up: narrow before voting",
      instruction: japanese
        ? "追加発言では論点を広げない。自分に関わる一番強い疑い・信頼・役職主張に触れ、投票前に誰をどう見るかを一つだけ言う。"
        : "Do not widen the table in follow-up. Address the strongest suspicion, trust, or claim involving you and narrow to one voting-ready view."
    }
  };
  return definitions[kind];
}

export function buildPublicSpeechPlan(input: BuildPublicSpeechPlanInput): PublicSpeechPlan {
  const deaths = input.lastNightDeaths.map((death) => publicNightDeathInfo(death, input.players));
  const discussionAgenda = discussionAgendaFor(input, deaths);
  const intents: SpeechIntent[] = [];

  // The opening turn of the game (round 1, first pass) has no public statements,
  // Seer results, or vote history yet. Forcing a suspicion / vote candidate there
  // is what produced the unnatural "初日の暫定材料" filler, so it opens with an
  // observation/organization intent and the after-the-fact stance forcing is off.
  const isOpeningTurn =
    input.phase === "day_discussion" && input.round === 1 && (!input.discussionPass || input.discussionPass <= 1);

  if (deaths.length > 0 && input.phase === "day_discussion") {
    intents.push(intent("connect_night_death_to_living_players", input.language));
    intents.push(input.discussionPass && input.discussionPass > 1 ? intent("answer_or_update", input.language) : intent("state_living_read", input.language));
  } else if (input.phase === "day_discussion") {
    intents.push(
      isOpeningTurn
        ? intent("open_first_day", input.language)
        : input.discussionPass && input.discussionPass > 1
          ? intent("answer_or_update", input.language)
          : intent("open_discussion", input.language)
    );
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
    discussionAgenda,
    intents,
    firstDayOpeningMove: input.firstDayOpeningMove,
    requiresForwardMove:
      !input.suppressForwardMove &&
      !isOpeningTurn &&
      input.legalPlayers.length > 0 &&
      (input.phase === "day_discussion" || input.phase === "voting"),
    opensFirstDay: isOpeningTurn
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
    ...(plan.discussionAgenda
      ? [
          `- ${text.discussionAgendaTitle}: ${plan.discussionAgenda.label}`,
          `- ${plan.discussionAgenda.instruction}`
        ]
      : []),
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
    if (move.kind === "overstate_village_side" || move.kind === "wolf_human_side_claim") {
      return /(?:私|僕|自分|こちら)(?:は|が)?[^。！？!?]{0,16}(?:村側|人間側|村人|白|吊られたくない)/u.test(text);
    }
    if (move.kind === "wolf_fake_role_claim") {
      return /(?:私|僕|自分|こちら)(?:は|が)?[^。！？!?]{0,30}(?:占い師|魔女|騎士|狩人|役職|能力者|CO|名乗)/u.test(text);
    }
    if (move.kind === "state_vote_criteria") {
      return /(?:投票基準|基準|返答|具体的|理由|便乗|態度)/u.test(text);
    }
    if (move.kind === "ask_role_claim_policy") {
      return /(?:占い師|名乗|伏せ|潜る|方針|条件|結果が重い)/u.test(text);
    }
    if (move.kind === "ask_table_question") {
      return /(?:どうする|どう扱|聞きたい|質問|投票理由|占い師|名乗|明かさせ|進め方)/u.test(text);
    }
    if (move.kind === "tentative_reaction_read") {
      return /(?:人物傾向|初日姿勢|役職方針|暫定|揺さぶ|圧|投票候補|疑い寄り|理由を確認)/u.test(text);
    }
    return /(?:占い師|魔女|騎士|護衛|守り方|能力者)/u.test(text);
  }

  if (move.kind === "overstate_village_side" || move.kind === "wolf_human_side_claim") {
    return /\b(I|I'm|I am|my)\b.{0,40}\b(village|villager|town|not a wolf|should not be eliminated)\b/i.test(text);
  }
  if (move.kind === "wolf_fake_role_claim") {
    return /\b(I|I'm|I am|my)\b.{0,50}\b(Seer|Witch|Guard|Hunter|role|claim)\b/i.test(text);
  }
  if (move.kind === "state_vote_criteria") {
    return /\b(vote criteria|criteria|concrete answers|speaking volume|take a position|stiffness)\b/i.test(text);
  }
  if (move.kind === "ask_role_claim_policy") {
    return /\b(role claim|claim policy|Seer claim|come out|stay hidden)\b/i.test(text);
  }
  if (move.kind === "ask_table_question") {
    return /\b(question|vote reason|Seer|reveal|role exposure|approach)\b/i.test(text);
  }
  if (move.kind === "tentative_reaction_read") {
    return /\b(tentative|light pressure|first-day stance|role-policy posture|vote candidate|suspicion lean)\b/i.test(text);
  }
  return /\b(Seer|Witch|Guard|power role|protection)\b/i.test(text);
}

function referencesExistingSeerClaimJapanese(text: string): boolean {
  return /(?:占い(?:師)?(?:を)?(?:名乗った|名乗っている|名乗っています|COが出|COは出|COがあ|COはあ|主張が出|主張は出|主張があ|主張はあ|として出た|として出ている)|占い(?:師)?主張(?:が|は)?(?:出|あ)|占い師を名乗る人)/u.test(
    text
  );
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
        `${name}の反応(?:が|は|も|だけ|から|で)[^。！？!?]{0,20}(?:早|遅|弱|強|防御|曖昧|気になる|不自然|怪し|見え|変わ|ずれ|ごまか|そら)`,
        `${name}(?:が|は)?(?:便乗|ごまか|話をそら|煙に巻)`
      ].join("|"),
      "u"
    );
    return observedReference.test(text);
  });

  const misstatesVisibleSilence = legalPlayers.some((player) => {
    const name = `${escapeRegExp(player.name)}(?:さん)?`;
    const speakerHistory = new RegExp(`^\\s*${escapeRegExp(player.name)}\\s*:`, "u");
    const hasVisibleSpeech = publicHistory.some((line) => speakerHistory.test(line));
    if (!hasVisibleSpeech) {
      return false;
    }
    return new RegExp(
      [
        `${name}[^。！？!?]{0,30}(?:まだ)?(?:発言していない|話していない|発言がない|話がない|黙っている|黙ってる|無言)`,
        `(?:まだ)?(?:発言していない|話していない|発言がない|話がない|黙っている|黙ってる|無言)[^。！？!?]{0,30}${name}`
      ].join("|"),
      "u"
    ).test(text);
  });

  const inventsSeerClaim = !publicHistory.some((line) => textHasSeerClaimEvidence(line)) && referencesExistingSeerClaimJapanese(text);
  if (inventsSeerClaim) {
    return {
      ok: false,
      issues: ["speech invents a visible Seer claim"],
      revisionHint: labels(language).unseenClaimRevisionHint
    };
  }

  if (genericUnseenReference || citesUnseenPlayer || misstatesVisibleSilence) {
    return {
      ok: false,
      issues: [
        misstatesVisibleSilence
          ? "speech says a visibly speaking player has not spoken"
          : "speech cites unseen prior public speech or action"
      ],
      revisionHint: labels(language).emptyHistoryRevisionHint
    };
  }

  return { ok: true, issues: [] };
}

// Positive substance check for a Japanese opening-turn line. The first day has no
// public evidence yet, but the line still needs to push the table: vote criteria,
// role policy, a named question, light pressure, or a concrete setup proposal.
// Generic "整理したい", "話を聞く", "様子見", and "保留" are rejected even when they use
// agenda-ish words, because those were the reported passive openings.
function hasOpeningSubstanceJapanese(text: string, legalPlayers: TargetCandidate[]): boolean {
  const passiveFiller =
    /(?:様子見|保留|もう少し(?:話|様子)|話を聞|話聞|一通り聞|状況(?:が|は)?(?:見え|分から|わから)|動く理由がない|何とも言えない|なんとも言えない|出方を(?:見|待)|出方(?:が|は)?見たい|今は動かない)/u.test(
      text
    );
  const voteOrReasonPolicy =
    /(?:投票基準|投票理由|理由を残|理由の具体|投票候補|投票先|候補に入|理由が薄|便乗|質問への答え|返答)/u.test(text) &&
    /(?:出す|残す|決め|合わせ|基準|候補|疑|聞かせ|答え|見ます|置きます|入れます|入れる)/u.test(text);
  const rolePolicy =
    /(?:占い|霊媒|狩人|ハンター|騎士|護衛|魔女|役職|能力者|名乗|潜伏|潜る|伏せ|対抗)/u.test(text) &&
    /(?:条件|方針|決め|合わせ|守|明かさせ|出る|出す|名乗る|聞かせ|どう扱|どうする|伏せる|潜る)/u.test(text);
  const setupProposal =
    /(?:配役|構成|人数|進め方|段取り|方針)/u.test(text) &&
    /(?:提案|決め|合わせ|整理し(?:ます|ましょう|ませんか)|先に|今日やる|進め(?:ます|ましょう|たい))/u.test(text);
  const namedEngagement = legalPlayers.some((player) => {
    const name = `${escapeRegExp(player.name)}(?:さん)?|${escapeRegExp(player.id)}`;
    return new RegExp(
      `(?:${name})[^。！？!?]{0,48}(?:どう|聞かせ|答え|基準|候補|疑|信頼|投票|揺さぶ|圧|置きます|置く|入れます|入れる|質問)`,
      "u"
    ).test(text);
  });
  const selfIntroWithAction =
    /(?:よろしく|はじめまして|初めまして|自己紹介|紹介|私は|僕は|自分は|と申し|呼んで|名前)/u.test(text) &&
    (voteOrReasonPolicy || rolePolicy || setupProposal || namedEngagement || /(?:質問|投票|占い|役職|基準|候補)/u.test(text));
  const villagePressure =
    /(?:村側|人間側|村人|吊られ)/u.test(text) && /(?:投票|候補|疑|理由|様子見|保留|圧)/u.test(text);
  const active =
    voteOrReasonPolicy ||
    rolePolicy ||
    setupProposal ||
    namedEngagement ||
    selfIntroWithAction ||
    villagePressure;

  if (!active) {
    return false;
  }
  if (!passiveFiller || voteOrReasonPolicy || rolePolicy || namedEngagement || villagePressure) {
    return true;
  }
  return false;
}

export function reviewSpeechAgainstPlan(
  speech: AgentSpeech,
  plan: PublicSpeechPlan | undefined,
  legalPlayers: TargetCandidate[],
  language: string
): SpeechPlanReview {
  // Opening turn: do not force a stance, but reject content-free "様子見"/"保留"
  // filler so the opening carries real content (self-intro, observation focus,
  // reveal policy, setup organizing).
  if (plan?.opensFirstDay) {
    if (isJapaneseLanguage(language) && !hasOpeningSubstanceJapanese(speech.messages.join(" "), legalPlayers)) {
      return {
        ok: false,
        issues: ["opening-turn speech lacks substantive opening content"],
        revisionHint: labels(language).openingFillerRevisionHint
      };
    }
    return { ok: true, issues: [] };
  }

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
