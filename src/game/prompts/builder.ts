import type { Persona, Phase, Player, Role, TargetCandidate } from "../types";
import { campLabel, defaultLanguage, isJapaneseLanguage, roleLabel } from "../i18n";
import { characterVoiceSection } from "../characters";
import { daySituationGuidance } from "../daySituations";
import { japaneseStyleGuide } from "../japaneseStyle";
import { renderPublicSpeechPlan } from "../speechPlanning";
import {
  bulletList,
  commonBoundaryLines,
  formatPlayers,
  personaHeading,
  personaStrategies,
  phaseHeading,
  promptModeFromGamePhase,
  promptPhaseFromGamePhase,
  recentLines
} from "./common";
import { promptMaterials } from "./materials";
import { personaDetails } from "./personaDetails";
import { getRolePromptProfile } from "./roles";
import {
  booleanJsonSchemaInstruction,
  outputFormatReminder,
  targetJsonSchemaInstruction,
  type BuildPromptContextOptions,
  type BuildSystemPromptOptions,
  type PromptMode,
  type PromptPhase,
  type RolePromptProfile,
  type RoleSecretContext,
  type SeerPrivateResult,
  type WitchPrivateState
} from "./schemas";

function phaseInstructions(profile: RolePromptProfile, promptPhase: PromptPhase): string[] {
  if (promptPhase === "werewolf_discussion") {
    const phase = promptMaterials.phases.werewolf_discussion;
    return [
      phase.privateDiscussionTitle,
      bulletList(phase.privateDiscussionGuidance),
      "",
      phase.nightKillStrategyTitle,
      bulletList(profile.nightAction),
      "",
      phase.privateSpeechGoalsTitle,
      bulletList(phase.privateSpeechGoals)
    ];
  }
  if (promptPhase === "discussion") {
    const phase = promptMaterials.phases.discussion;
    return [
      phase.roleSectionTitle,
      bulletList(profile.discussion),
      "",
      phase.publicSpeechBoundaryTitle,
      bulletList(profile.publicSpeechMustNotReveal),
      "",
      phase.publicStatementGoalsTitle,
      bulletList(phase.publicStatementGoals)
    ];
  }
  if (promptPhase === "voting") {
    const phase = promptMaterials.phases.voting;
    return [
      phase.roleSectionTitle,
      bulletList(profile.voting),
      "",
      phase.voteDecisionRulesTitle,
      bulletList(phase.voteDecisionRules)
    ];
  }
  const phase = promptMaterials.phases.night;
  return [
    phase.roleSectionTitle,
    bulletList(profile.nightAction),
    "",
    phase.internalTargetEvaluationTitle,
    bulletList(phase.internalTargetEvaluation)
  ];
}

function formatSeerResults(results: SeerPrivateResult[], language: string): string[] {
  if (results.length === 0) {
    return ["- Seer results: none yet."];
  }

  return [
    "- Your Seer results:",
    ...results.map((result) => {
      const round = result.round ? `Round ${result.round}: ` : "";
      return `  - ${round}${result.targetName} (${result.targetId}) => ${campLabel(result.camp, language)}`;
    })
  ];
}

function formatSeerResultsJa(results: SeerPrivateResult[], language: string): string[] {
  if (results.length === 0) {
    return ["- 占い結果: まだありません。"];
  }

  return [
    "- 自分だけが知っている占い結果:",
    ...results.map((result) => {
      const round = result.round ? `第${result.round}ラウンド: ` : "";
      return `  - ${round}${result.targetName} (${result.targetId}) => ${campLabel(result.camp, language)}`;
    })
  ];
}

function formatWitchState(witch: WitchPrivateState | undefined): string[] {
  if (!witch) {
    return ["- Potion state: unavailable."];
  }

  const attacked = witch.attackedTarget
    ? `${witch.attackedTarget.name} (${witch.attackedTarget.id})`
    : "not revealed for this decision";
  return [
    `- Save potion remaining: ${witch.savePotion ? "yes" : "no"}.`,
    `- Poison potion remaining: ${witch.poisonPotion ? "yes" : "no"}.`,
    `- Werewolf attack target visible to Witch: ${attacked}.`
  ];
}

function formatWitchStateJa(witch: WitchPrivateState | undefined): string[] {
  if (!witch) {
    return ["- 薬の情報: 利用できません。"];
  }

  const attacked = witch.attackedTarget
    ? `${witch.attackedTarget.name} (${witch.attackedTarget.id})`
    : "この判断では見えていません";
  return [
    `- 救済薬: ${witch.savePotion ? "残っています" : "ありません"}。`,
    `- 毒薬: ${witch.poisonPotion ? "残っています" : "ありません"}。`,
    `- 魔女に見えている襲撃先: ${attacked}。`
  ];
}

function isWerewolfRole(role: Role): boolean {
  return role === "Werewolf" || role === "AlphaWolf" || role === "WolfBeauty";
}

function formatLoverPartner(partner: (TargetCandidate & { alive?: boolean }) | undefined): string[] {
  if (!partner) {
    return ["- Lover partner: none known."];
  }
  const status = partner.alive === undefined ? "" : partner.alive ? " alive" : " dead";
  return [`- Lover partner: ${partner.name} (${partner.id})${status}.`];
}

function formatLoverPartnerJa(partner: (TargetCandidate & { alive?: boolean }) | undefined): string[] {
  if (!partner) {
    return ["- 恋人の相方: まだ見えていません。"];
  }
  const status = partner.alive === undefined ? "" : partner.alive ? " 生存" : " 死亡";
  return [`- 恋人の相方: ${partner.name} (${partner.id})${status}。`];
}

function roleVisiblePrivateInfoJa(role: Role, secret: RoleSecretContext | undefined, language: string): string[] {
  if (isWerewolfRole(role)) {
    const allies = secret?.werewolfAllies ?? [];
    return [
      "- 把握している人狼:",
      ...(allies.length > 0
        ? allies.map((ally) => `  - ${ally.name} (${ally.id})${ally.alive === undefined ? "" : ally.alive ? " 生存" : " 死亡"}`)
        : ["  - なし"])
    ];
  }

  if (role === "Seer") {
    return formatSeerResultsJa(secret?.seerResults ?? [], language);
  }

  if (role === "Witch") {
    return formatWitchStateJa(secret?.witch);
  }

  if (role === "Lover") {
    return formatLoverPartnerJa(secret?.loverPartner);
  }

  if (role === "Villager") {
    return ["- 自分だけの役職情報はありません。公開情報だけで考えます。"];
  }

  return ["- 自分の役職と、見えている公開情報だけを使います。"];
}

function roleVisiblePrivateInfo(role: Role, secret: RoleSecretContext | undefined, language: string): string[] {
  if (isJapaneseLanguage(language)) {
    return roleVisiblePrivateInfoJa(role, secret, language);
  }

  if (isWerewolfRole(role)) {
    const allies = secret?.werewolfAllies ?? [];
    return [
      "- Known werewolf allies:",
      ...(allies.length > 0
        ? allies.map((ally) => `  - ${ally.name} (${ally.id})${ally.alive === undefined ? "" : ally.alive ? " alive" : " dead"}`)
        : ["  - none"])
    ];
  }

  if (role === "Seer") {
    return formatSeerResults(secret?.seerResults ?? [], language);
  }

  if (role === "Witch") {
    return formatWitchState(secret?.witch);
  }

  if (role === "Lover") {
    return formatLoverPartner(secret?.loverPartner);
  }

  if (role === "Villager") {
    return ["- No private role information. Use public information only."];
  }

  return ["- Use only your own role memory and the public table state."];
}

function legalPlayerLine(players: TargetCandidate[] | undefined): string | null {
  if (!players || players.length === 0) {
    return null;
  }
  return `Legal player ids: ${players.map((candidate) => `${candidate.id}=${candidate.name}`).join(", ")}.`;
}

function legalTargetLineForLanguage(players: TargetCandidate[] | undefined, language: string): string | null {
  if (!isJapaneseLanguage(language)) {
    return legalPlayerLine(players);
  }
  if (!players || players.length === 0) {
    return null;
  }
  return `選べる対象ID: ${players.map((candidate) => `${candidate.id}=${candidate.name}`).join(", ")}。`;
}

export function getRoleStrategy(role: Role): string {
  return bulletList(getRolePromptProfile(role).roleStrategy);
}

export function getPersonaStrategy(persona: Persona): string {
  return bulletList(personaStrategies[persona]);
}

function simplePersonaLines(player: Player, language: string): string[] {
  if (player.characterProfile) {
    const profile = player.characterProfile;
    if (isJapaneseLanguage(language)) {
      return [
        `- 性別: ${profile.gender === "male" ? "男" : "女"}`,
        `- 話し方: ${profile.speechStyle}`,
        `- 大事にすること: ${profile.values}`,
        `- 切り出しの雰囲気: ${profile.tagline}`
      ];
    }
    return [
      `- Gender: ${profile.gender}`,
      `- Speaking style: ${profile.speechStyle}`,
      `- Values: ${profile.values}`,
      `- Opening feel: ${profile.tagline}`
    ];
  }

  if (isJapaneseLanguage(language)) {
    return [
      `- 表向きの性格: ${personaHeading(player.persona, language)}`,
      ...personaDetails[player.persona].speechStyle.map((line) => `- ${line}`),
      ...personaDetails[player.persona].principles.map((line) => `- ${line}`)
    ];
  }

  return [
    `- Public persona: ${player.persona}`,
    ...personaDetails[player.persona].speechStyle.map((line) => `- ${line}`),
    ...personaDetails[player.persona].principles.map((line) => `- ${line}`)
  ];
}

function simplePublicSpeechRules(phase: Phase, role: Role, language: string): string[] {
  const werewolfRole = isWerewolfRole(role);
  if (isJapaneseLanguage(language)) {
    const visibilityRule =
      phase === "werewolf_discussion"
        ? "ここは人狼陣営だけの会話です。仲間には正体を隠さなくてよい。"
        : werewolfRole
          ? "公開の場では、人狼であること、仲間、夜の相談は漏らさない。人間側として自然に話す。"
          : "公開の場では、役職を明かすか伏せるかを状況で判断する。";
    return [
      "これまでの会話を踏まえて、自然に次の発言をする。",
      visibilityRule,
      "見えていない発言、反応、矛盾、役職主張を事実として作らない。",
      "出力は画面に出すあなたの発言だけ。説明やJSONは不要。",
      "短い1文、必要な時だけ2文にする。"
    ];
  }

  const visibilityRule =
    phase === "werewolf_discussion"
      ? "This is werewolf-team private talk; you do not need to hide your identity from allies."
      : werewolfRole
        ? "In public, do not reveal that you are a werewolf, your allies, or wolf-only discussion. Sound like a natural villager."
        : "In public, decide from the situation whether to claim, hide, or withhold your role information.";
  return [
    "Use the conversation so far and say the next natural line.",
    visibilityRule,
    "Do not invent unseen statements, reactions, contradictions, or role claims.",
    "Output only your spoken line. No explanation or JSON.",
    "Use one short sentence, or two only when useful."
  ];
}

function isPublicSpeechControlLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    /^Discussion pass \d+ of \d+\./i.test(trimmed) ||
    /^Follow-up pass for selected speakers/i.test(trimmed) ||
    /^(?:First|Second) pass:/i.test(trimmed) ||
    /^Final follow-up:/i.test(trimmed) ||
    /^First-day opening mode:/i.test(trimmed) ||
    /^Recent public reads already used by other players:/i.test(trimmed) ||
    /^Avoid repeated table angles:/i.test(trimmed) ||
    /^- (?:Do not merely repeat|If you agree|If several players)/i.test(trimmed) ||
    /^昼議論 \d+巡目 \/ \d+巡。/u.test(trimmed) ||
    /^2巡後に必要な人だけが行う追加発言です。/u.test(trimmed) ||
    /^(?:1|2)巡目:/u.test(trimmed) ||
    /^追加発言:/u.test(trimmed) ||
    /^初日特別モード:/u.test(trimmed) ||
    /^他プレイヤーが直近で既に出した読み:/u.test(trimmed) ||
    /^発言の重複を避ける:/u.test(trimmed) ||
    /^- (?:同じ対象|同意する時|既に複数人)/u.test(trimmed)
  );
}

function publicSpeechSituationLines(extra: string[]): string[] {
  return recentLines(
    extra.filter((line) => line.trim().length > 0 && !isPublicSpeechControlLine(line)),
    8
  );
}

function buildSimplePublicSpeechContext(options: BuildPromptContextOptions): string {
  const {
    player,
    phase,
    round,
    alivePlayers,
    deadPlayers,
    publicHistory,
    privateHistory,
    language = defaultLanguage,
    secret,
    extra = []
  } = options;
  const japanese = isJapaneseLanguage(language);
  const recentPublicHistory = publicHistory.length > 0 ? recentLines(publicHistory, 24) : [japanese ? "- まだありません。" : "- None yet."];
  const visibleSituation = publicSpeechSituationLines(extra);
  const privateMemory = privateHistory.length > 0 ? recentLines(privateHistory, 10) : [japanese ? "- なし。" : "- None."];

  if (japanese) {
    return [
      `あなたは${player.name}です。`,
      "",
      "人物設定:",
      ...simplePersonaLines(player, language),
      "",
      "役職:",
      `- ${roleLabel(player.role, language)}`,
      ...roleVisiblePrivateInfo(player.role, secret, language),
      "",
      "現在の状況:",
      `- ${phaseHeading(phase, language)}、第${round}ラウンド。`,
      `- 生存者: ${formatPlayers(alivePlayers)}。`,
      deadPlayers.length > 0
        ? `- 死亡者: ${deadPlayers.map((playerInfo) => `${playerInfo.name} (${playerInfo.id})`).join(", ")}。`
        : "- 死亡者: なし。",
      ...visibleSituation,
      "",
      "これまでの会話:",
      ...recentPublicHistory,
      "",
      "自分の記憶:",
      ...privateMemory,
      "",
      "発言ルール:",
      ...simplePublicSpeechRules(phase, player.role, language).map((line) => `- ${line}`)
    ].join("\n");
  }

  return [
    `You are ${player.name}.`,
    "",
    "Character:",
    ...simplePersonaLines(player, language),
    "",
    "Role:",
    `- ${roleLabel(player.role, language)}`,
    ...roleVisiblePrivateInfo(player.role, secret, language),
    "",
    "Current situation:",
    `- ${phaseHeading(phase, language)}, round ${round}.`,
    `- Alive players: ${formatPlayers(alivePlayers)}.`,
    deadPlayers.length > 0
      ? `- Dead players: ${deadPlayers.map((playerInfo) => `${playerInfo.name} (${playerInfo.id})`).join(", ")}.`
      : "- Dead players: none.",
    ...visibleSituation,
    "",
    "Conversation so far:",
    ...recentPublicHistory,
    "",
    "Your memory:",
    ...privateMemory,
    "",
    "Speech rules:",
    ...simplePublicSpeechRules(phase, player.role, language).map((line) => `- ${line}`)
  ].join("\n");
}

export function buildPromptContext(options: BuildPromptContextOptions): string {
  const {
    player,
    phase,
    round,
    alivePlayers,
    deadPlayers,
    publicHistory,
    privateHistory,
    language = defaultLanguage,
    secret,
    extra = []
  } = options;
  const promptPhase = options.promptPhase ?? promptPhaseFromGamePhase(phase);
  const mode = options.mode ?? promptModeFromGamePhase(phase);
  const profile = getRolePromptProfile(player.role);
  const japanese = isJapaneseLanguage(language);
  const situationGuidance = daySituationGuidance({ phase, round, publicHistory, extra, language });
  if (mode === "public_speech") {
    return buildSimplePublicSpeechContext(options);
  }
  if (japanese && mode === "internal_decision" && promptPhase === "voting") {
    return buildJapaneseVotingDecisionContext({
      ...options,
      promptPhase,
      mode
    });
  }
  const lines = [
    japanese ? `あなたは${player.name}です。` : `You are ${player.name}.`,
    japanese ? `あなたの役職: ${roleLabel(player.role, language)}。` : `Your role: ${player.role}.`,
    japanese ? `公開上の性格: ${personaHeading(player.persona, language)}。` : `Your public persona: ${player.persona}.`,
    japanese
      ? `現在のフェーズ: ${phaseHeading(phase, language)}。ラウンド: ${round}。`
      : `Current phase: ${phase}. Round: ${round}.`,
    "Prompt mode: internal decision.",
    "",
    "Information boundary:",
    bulletList(commonBoundaryLines(mode)),
    "",
    "Role strategy:",
    getRoleStrategy(player.role),
    "",
    "Phase-specific guidance:",
    ...phaseInstructions(profile, promptPhase),
    ...(situationGuidance.length > 0 ? ["", ...situationGuidance] : []),
    ...(options.speechPlan ? ["", ...renderPublicSpeechPlan(options.speechPlan, language)] : []),
    "",
    "Persona style:",
    getPersonaStrategy(player.persona),
    "",
    "Persona character:",
    ...personaDetails[player.persona].speechStyle.map((s) => `- ${s}`),
    "",
    "Persona values:",
    ...personaDetails[player.persona].principles.map((s) => `- ${s}`),
    ...(player.characterProfile
      ? [
          "",
          "Character voice:",
          ...characterVoiceSection(player.characterProfile).split("\n")
        ]
      : []),
    "",
    `Alive players: ${formatPlayers(alivePlayers)}.`,
    deadPlayers.length > 0
      ? `Dead players: ${deadPlayers.map((playerInfo) => `${playerInfo.name} (${playerInfo.id})`).join(", ")}.`
      : "Dead players: none.",
    "",
    "Role-visible private information:",
    ...roleVisiblePrivateInfo(player.role, secret, language),
    "",
    "Information you should use internally:",
    bulletList(profile.internalInformation)
  ];

  if (privateHistory.length > 0) {
    lines.push("", "Your private memory:", ...recentLines(privateHistory, 12));
  }

  if (publicHistory.length > 0) {
    lines.push(
      "",
      "Recent public discussion:",
      "- Connect to the last one or two visible public statements with agreement, disagreement, a supplement, or an answer to pressure before stating your own read.",
      "- Use only visible statements as evidence; do not invent reactions, contradictions, claims, or speaking volume.",
      ...recentLines(publicHistory, 18)
    );
  }

  if (extra.length > 0) {
    lines.push("", "Task-specific visible context:", ...extra);
  }

  return lines.join("\n");
}

function buildJapaneseVotingDecisionContext(options: BuildPromptContextOptions): string {
  const {
    player,
    phase,
    round,
    alivePlayers,
    deadPlayers,
    publicHistory,
    privateHistory,
    language = defaultLanguage,
    secret,
    extra = []
  } = options;
  const profile = getRolePromptProfile(player.role);
  const targetDecision = promptMaterials.languageStyles.japanese.targetDecision;
  const situationGuidance = daySituationGuidance({ phase, round, publicHistory, extra, language });
  const lines = [
    `あなたは${player.name}です。`,
    `役職: ${roleLabel(player.role, language)}。`,
    `表向きの性格: ${personaHeading(player.persona, language)}。`,
    `現在: ${phaseHeading(phase, language)}、第${round}ラウンド。`,
    "",
    "投票理由の前提:",
    bulletList(targetDecision.boundary),
    "",
    "投票判断の方針:",
    bulletList(targetDecision.votingGuidance),
    "",
    "役職ごとの注意:",
    bulletList(profile.publicSpeechGuidanceJa),
    ...(situationGuidance.length > 0 ? ["", ...situationGuidance] : []),
    ...(options.speechPlan ? ["", ...renderPublicSpeechPlan(options.speechPlan, language)] : []),
    "",
    "人物の話し方:",
    ...personaDetails[player.persona].speechStyle.map((s) => `- ${s}`),
    "",
    `生存者: ${formatPlayers(alivePlayers)}。`,
    deadPlayers.length > 0
      ? `死亡者: ${deadPlayers.map((playerInfo) => `${playerInfo.name} (${playerInfo.id})`).join(", ")}。`
      : "死亡者: なし。",
    `投票できる相手: ${formatPlayers(alivePlayers.filter((playerInfo) => playerInfo.id !== player.id))}。`,
    "",
    "自分だけが見える役職情報:",
    ...roleVisiblePrivateInfo(player.role, secret, language)
  ];

  if (privateHistory.length > 0) {
    lines.push("", "自分の記憶:", ...recentLines(privateHistory, 12));
  }

  if (publicHistory.length > 0) {
    lines.push("", "直近の昼の発言:", ...recentLines(publicHistory, 18));
  } else {
    lines.push("", "直近の昼の発言:", "- まだ、この昼の発言はありません。");
  }

  if (extra.length > 0) {
    lines.push("", "今回の判断で見えている情報:", ...extra);
  }

  return lines.join("\n");
}

export function buildPublicSpeechPrompt(options: Omit<BuildPromptContextOptions, "mode">): string {
  return buildPromptContext({ ...options, mode: "public_speech", promptPhase: "discussion" });
}

export function buildInternalDecisionPrompt(options: Omit<BuildPromptContextOptions, "mode">): string {
  return buildPromptContext({ ...options, mode: "internal_decision" });
}

export function buildBaseContext(options: {
  player: Player;
  phase: Phase;
  round: number;
  alivePlayers: TargetCandidate[];
  deadPlayers: Array<TargetCandidate & { role?: Role }>;
  publicHistory: string[];
  privateHistory: string[];
  language?: string;
  secret?: RoleSecretContext;
  speechPlan?: BuildPromptContextOptions["speechPlan"];
  extra?: string[];
}): string {
  return buildPromptContext(options);
}

function baseSystemPrompt(options: BuildSystemPromptOptions, mode: PromptMode, outputInstruction: string): string {
  const promptPhase = promptPhaseFromGamePhase(options.phase);
  const profile = getRolePromptProfile(options.player.role);
  const legal = legalPlayerLine(options.legalPlayers);
  const styleGuide = japaneseStyleGuide(options.language);
  const lines = [
    "You are playing a hidden-role werewolf game.",
    `You are ${options.player.name}; role=${options.player.role}; persona=${options.player.persona}.`,
    `Respond in ${options.language}.`,
    "",
    "Information boundary:",
    bulletList(commonBoundaryLines(mode)),
    "",
    "Role strategy:",
    bulletList(profile.roleStrategy),
    "",
    "Phase guidance:",
    ...phaseInstructions(profile, promptPhase),
    ...(styleGuide.length > 0 ? ["", ...styleGuide] : []),
    "",
    outputInstruction,
    outputFormatReminder
  ];

  if (legal) {
    lines.push("", legal);
  }

  return lines.join("\n");
}

function japaneseTargetSystemPrompt(options: BuildSystemPromptOptions, outputInstruction: string): string {
  const promptPhase = promptPhaseFromGamePhase(options.phase);
  const profile = getRolePromptProfile(options.player.role);
  const targetDecision = promptMaterials.languageStyles.japanese.targetDecision;
  const styleGuide = japaneseStyleGuide(options.language);
  const legal = legalTargetLineForLanguage(options.legalPlayers, options.language);
  const guidance = promptPhase === "voting" ? targetDecision.votingGuidance : targetDecision.internalGuidance;
  const lines = [
    ...targetDecision.systemPreamble,
    `名前: ${options.player.name}。役職: ${roleLabel(options.player.role, options.language)}。表向きの性格: ${personaHeading(options.player.persona, options.language)}。`,
    "返答言語: 日本語。",
    "",
    "対象選択の境界:",
    bulletList(targetDecision.boundary),
    "",
    promptPhase === "voting" ? "投票判断の方針:" : "対象選択の方針:",
    bulletList(guidance),
    "",
    "役職ごとの注意:",
    bulletList(profile.publicSpeechGuidanceJa),
    ...(styleGuide.length > 0 ? ["", ...styleGuide] : []),
    "",
    outputInstruction,
    ...(legal ? ["", legal] : [])
  ];

  return lines.join("\n");
}

export function buildSimpleSpeechSystemPrompt(options: BuildSystemPromptOptions): string {
  const japanese = isJapaneseLanguage(options.language);
  const roleName = roleLabel(options.player.role, options.language);
  const personaName = personaHeading(options.player.persona, options.language);
  const profile = options.player.characterProfile;
  if (japanese) {
    return [
      "あなたは人狼ゲームの参加者です。",
      `あなたは${options.player.name}です。`,
      `人物設定: ${profile ? `${profile.speechStyle}。${profile.values}` : personaName}。`,
      `役職: ${roleName}。`,
      "",
      "これまでの会話と自分の役職を踏まえて、自然な次の発言をしてください。",
      "役職を明かす、隠す、嘘をつく、曖昧にする判断は状況に合わせます。",
      "出力は画面に出す発言だけ。説明、箇条書き、JSONは不要です。",
      "短い1文、必要な時だけ2文にしてください。"
    ].join("\n");
  }

  return [
    "You are a player in a hidden-role werewolf game.",
    `You are ${options.player.name}.`,
    `Character: ${profile ? `${profile.speechStyle}. ${profile.values}` : personaName}.`,
    `Role: ${roleName}.`,
    "",
    "Use the conversation so far and your role to say the next natural line.",
    "Decide from the situation whether to claim, hide, lie, or stay ambiguous about role information.",
    "Output only the spoken line. No explanation, bullets, or JSON.",
    "Use one short sentence, or two only when useful."
  ].join("\n");
}

export function buildTargetSystemPrompt(options: BuildSystemPromptOptions): string {
  if (isJapaneseLanguage(options.language)) {
    const skipLine = options.allowSkip
      ? "対象を選ばない方がよい場合だけ、targetId に null、reasonKind に skip_preserve を返せます。"
      : "必ず一覧にある対象 ID と reasonKind を一つ選んでください。";
    return japaneseTargetSystemPrompt(options, [promptMaterials.outputFormats.targetJson.japaneseInstruction, skipLine].join("\n"));
  }

  const skipLine = options.allowSkip
    ? "You may return targetId null with reasonKind skip_preserve if skipping is strategically best and the action allows it."
    : "You must choose one listed target and one reasonKind.";
  return baseSystemPrompt(options, "internal_decision", [targetJsonSchemaInstruction, skipLine].join("\n"));
}

export function buildBooleanSystemPrompt(options: BuildSystemPromptOptions): string {
  return baseSystemPrompt(options, "internal_decision", booleanJsonSchemaInstruction);
}

export function buildTargetList(candidates: TargetCandidate[]): string {
  return candidates.map((target) => `- ${target.id}: ${target.name}`).join("\n");
}
