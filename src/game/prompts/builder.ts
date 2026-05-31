import type { Persona, Phase, Player, Role, TargetCandidate } from "../types";
import { campLabel, defaultLanguage, isJapaneseLanguage, roleLabel } from "../i18n";
import { characterVoiceSection } from "../characters";
import { daySituationGuidance } from "../daySituations";
import { japaneseDialogueContract, japaneseStyleGuide } from "../japaneseStyle";
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
  speechReasoningJsonSchemaInstruction,
  speechRealizationJsonSchemaInstruction,
  speechJsonSchemaInstruction,
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

function legalReadTargetLine(players: TargetCandidate[] | undefined): string {
  if (!players || players.length === 0) {
    return "Legal living read target ids for suspects/trusts: none. Keep suspects and trusts empty.";
  }
  return `Legal living read target ids for suspects/trusts: ${players.map((candidate) => `${candidate.id}=${candidate.name}`).join(", ")}.`;
}

function legalReadTargetLineForLanguage(players: TargetCandidate[] | undefined, language: string): string {
  if (!isJapaneseLanguage(language)) {
    return legalReadTargetLine(players);
  }
  if (!players || players.length === 0) {
    return "suspects/trusts に使える生存者ID: なし。suspects と trusts は空にしてください。";
  }
  return `suspects/trusts に使える生存者ID: ${players.map((candidate) => `${candidate.id}=${candidate.name}`).join(", ")}。`;
}

export function getRoleStrategy(role: Role): string {
  return bulletList(getRolePromptProfile(role).roleStrategy);
}

export function getPersonaStrategy(persona: Persona): string {
  return bulletList(personaStrategies[persona]);
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
  const firstDayOpeningMove = options.speechPlan?.firstDayOpeningMove;
  const situationGuidance = daySituationGuidance({ phase, round, publicHistory, extra, language });
  const dialogueContract = mode === "public_speech" ? japaneseDialogueContract(language) : [];
  if (japanese && mode === "public_speech") {
    return buildJapanesePublicSpeechContext({
      ...options,
      promptPhase,
      mode
    });
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
    `Prompt mode: ${mode === "public_speech" ? "public speech" : "internal decision"}.`,
    ...(dialogueContract.length > 0 ? ["", ...dialogueContract] : []),
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
    ...(mode === "public_speech"
      ? [
          `Current public read targets: ${formatPlayers(alivePlayers.filter((playerInfo) => playerInfo.id !== player.id))}.`,
          "Dead players are past evidence only, not current suspicion, trust, vote, or elimination targets."
        ]
      : []),
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

  if (mode === "public_speech" && publicHistory.length === 0) {
    lines.push(
      "",
      "Visible public discussion so far:",
      "- No prior public statements are included in your visible context.",
      firstDayOpeningMove
        ? firstDayOpeningMove.kind === "tentative_reaction_read"
          ? "- First-day opening mode is active: use only the assigned tentative posture/reaction spark, and do not cite prior public statements as visible facts."
          : "- First-day opening mode is active: use only the assigned spark, and do not cite prior public statements that are not visible."
        : "- Do not describe any specific player's earlier statement, reaction, contradiction, speaking volume, or vagueness as observed evidence yet."
    );
  } else if (publicHistory.length > 0) {
    lines.push("", "Recent public discussion:", ...recentLines(publicHistory, 18));
  }

  if (extra.length > 0) {
    lines.push("", "Task-specific visible context:", ...extra);
  }

  return lines.join("\n");
}

function buildJapanesePublicSpeechContext(options: BuildPromptContextOptions): string {
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
  const firstDayOpeningMove = options.speechPlan?.firstDayOpeningMove;
  // When the plan does not require a forward move (especially the round-one opening
  // turn) the empty-history prompt must not force a suspicion/vote; it permits a
  // non-conclusory opening instead.
  const requiresForwardMove = options.speechPlan?.requiresForwardMove ?? true;
  const publicSpeech = promptMaterials.languageStyles.japanese.publicSpeech;
  const situationGuidance = daySituationGuidance({ phase, round, publicHistory, extra, language });
  const lines = [
    `あなたは${player.name}です。`,
    `役職: ${roleLabel(player.role, language)}。`,
    `表向きの性格: ${personaHeading(player.persona, language)}。`,
    `現在: ${phaseHeading(phase, language)}、第${round}ラウンド。`,
    "",
    "昼の発言の前提:",
    bulletList(publicSpeech.boundary),
    "",
    "役職ごとの発言方針:",
    bulletList(profile.publicSpeechGuidanceJa),
    "",
    "昼議論で意識すること:",
    bulletList(publicSpeech.phaseGuidance),
    ...(requiresForwardMove ? [bulletList(publicSpeech.phaseGuidanceForwardMove)] : []),
    ...(situationGuidance.length > 0 ? ["", ...situationGuidance] : []),
    ...(options.speechPlan ? ["", ...renderPublicSpeechPlan(options.speechPlan, language)] : []),
    "",
    "人物の話し方:",
    ...personaDetails[player.persona].speechStyle.map((s) => `- ${s}`),
    "",
    "人物として大事にすること:",
    ...personaDetails[player.persona].principles.map((s) => `- ${s}`),
    ...(player.characterProfile
      ? [
          "",
          "キャラクターの声:",
          ...characterVoiceSection(player.characterProfile).split("\n")
        ]
      : []),
    "",
    `生存者: ${formatPlayers(alivePlayers)}。`,
    deadPlayers.length > 0
      ? `死亡者: ${deadPlayers.map((playerInfo) => `${playerInfo.name} (${playerInfo.id})`).join(", ")}。`
      : "死亡者: なし。",
    `今、疑い・信頼・投票前の読みを向けられる相手: ${formatPlayers(alivePlayers.filter((playerInfo) => playerInfo.id !== player.id))}。`,
    "死亡者は過去の材料としてだけ扱い、今の疑い先、信頼先、投票先にはしません。",
    "",
    "自分だけが見える役職情報:",
    ...roleVisiblePrivateInfo(player.role, secret, language)
  ];

  if (privateHistory.length > 0) {
    lines.push("", "自分の記憶:", ...recentLines(privateHistory, 12));
  }

  if (publicHistory.length === 0) {
    lines.push(
      "",
      "見えている昼の発言:",
      "- まだ、この昼の発言はありません。",
      firstDayOpeningMove
        ? firstDayOpeningMove.kind === "tentative_reaction_read"
          ? "- 初日特別モードが有効です。割り当てられた名指し質問だけを火種にし、見えていない発言内容や反応は引用しない。"
          : "- 初日特別モードが有効です。割り当てられた方針だけを火種にし、見えていない発言は引用しない。"
        : "- 見えていない会話内容や反応を、既に見た根拠として扱わない。",
      firstDayOpeningMove?.kind === "tentative_reaction_read"
        ? "- 「誰かの言う通り」「誰かの発言」「誰かの反応」のように、既に発言や反応があった事実として話さない。"
        : "- 「誰かの言う通り」「誰かの発言」「誰かの反応」「誰かの動き」のように、既に起きた事実として話さない。",
      ...(requiresForwardMove
        ? [
            "- 名前を出す場合は、人物傾向や役職印象を根拠に、暫定の疑い・信頼・投票候補のどれかまで言う。保留する時は理由と次に確認したい点も添える。",
            "- 今後の観察だけで終えず、画面に出るセリフ内で自分の stance まで言う。"
          ]
        : [
            "- まだ公開情報がないので、見えていない反応を根拠にしない。代わりに、投票基準、占い師が名乗る条件、役職を明かさせすぎない方針、配役整理、名指し質問、軽い初日仮説のどれかを自分から出す。",
            "- 「様子見」「保留」「みんなの話を聞く」で終えない。名前を出す場合は、人物傾向や役職印象からの軽い質問・投票候補まで言い、根拠がない断定はしない。"
          ])
    );
  } else {
    lines.push("", "直近の昼の発言:", ...recentLines(publicHistory, 18));
  }

  if (extra.length > 0) {
    lines.push("", "今回のタスクで見えている情報:", ...extra);
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
  if (mode === "public_speech" && isJapaneseLanguage(options.language)) {
    return japanesePublicSpeechSystemPrompt(options);
  }

  const promptPhase = promptPhaseFromGamePhase(options.phase);
  const profile = getRolePromptProfile(options.player.role);
  const legal = legalPlayerLine(options.legalPlayers);
  const styleGuide = japaneseStyleGuide(options.language);
  const dialogueContract = mode === "public_speech" ? japaneseDialogueContract(options.language) : [];
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
    ...(dialogueContract.length > 0 ? ["", ...dialogueContract] : []),
    "",
    outputInstruction,
    outputFormatReminder
  ];

  if (mode === "public_speech") {
    lines.push("", "Public speech must not reveal:", bulletList(profile.publicSpeechMustNotReveal));
  }

  if (mode === "public_speech") {
    lines.push("", legalReadTargetLineForLanguage(options.legalPlayers, options.language));
  } else if (legal) {
    lines.push("", legal);
  }

  return lines.join("\n");
}

function japanesePublicSpeechSystemPrompt(options: BuildSystemPromptOptions): string {
  const publicSpeech = promptMaterials.languageStyles.japanese.publicSpeech;
  const profile = getRolePromptProfile(options.player.role);
  const styleGuide = japaneseStyleGuide(options.language);
  const requiresForwardMove = options.requiresForwardMove ?? true;
  const dialogueContract = japaneseDialogueContract(options.language, requiresForwardMove);
  const lines = [
    ...publicSpeech.systemPreamble,
    `名前: ${options.player.name}。役職: ${roleLabel(options.player.role, options.language)}。表向きの性格: ${personaHeading(options.player.persona, options.language)}。`,
    "返答言語: 日本語。",
    "",
    "昼の発言の境界:",
    bulletList(publicSpeech.boundary),
    "",
    "役職ごとの発言方針:",
    bulletList(profile.publicSpeechGuidanceJa),
    "",
    "昼議論の進め方:",
    bulletList(publicSpeech.phaseGuidance),
    ...(requiresForwardMove ? [bulletList(publicSpeech.phaseGuidanceForwardMove)] : []),
    ...(styleGuide.length > 0 ? ["", ...styleGuide] : []),
    ...(dialogueContract.length > 0 ? ["", ...dialogueContract] : []),
    "",
    promptMaterials.outputFormats.speechJson.japaneseInstruction,
    promptMaterials.outputFormats.japaneseReminder,
    "",
    legalReadTargetLineForLanguage(options.legalPlayers, options.language)
  ];

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

export function buildSpeechSystemPrompt(options: BuildSystemPromptOptions): string {
  return baseSystemPrompt(options, promptModeFromGamePhase(options.phase), speechJsonSchemaInstruction);
}

function japaneseSpeechReasoningSystemPrompt(options: BuildSystemPromptOptions): string {
  const publicSpeech = promptMaterials.languageStyles.japanese.publicSpeech;
  const profile = getRolePromptProfile(options.player.role);
  const requiresForwardMove = options.requiresForwardMove ?? true;
  const opensFirstDay = options.opensFirstDay ?? false;
  const lines = [
    "あなたは人狼ゲームの公開発話前に、発話意図と公開推理メタデータだけを決めます。",
    `名前: ${options.player.name}。役職: ${roleLabel(options.player.role, options.language)}。表向きの性格: ${personaHeading(options.player.persona, options.language)}。`,
    "返答言語: 日本語。",
    "",
    "推理に使える境界:",
    bulletList(publicSpeech.boundary),
    "",
    "役職ごとの発言方針:",
    bulletList(profile.publicSpeechGuidanceJa),
    "",
    "昼議論の進め方:",
    bulletList(publicSpeech.phaseGuidance),
    ...(requiresForwardMove ? [bulletList(publicSpeech.phaseGuidanceForwardMove)] : []),
    ...(opensFirstDay
      ? [
          "",
          "初日1巡目の追加ルール:",
          bulletList([
            "まだ強い断定はしないが、intent を hold だけにしない。",
            "投票基準、占い師が名乗る条件、役職露出の方針、名指し質問、軽い投票候補のどれかで議論を動かす。",
            "見えていない発言・反応・矛盾は根拠にしない。軽い読みを置く場合は first_day_tentative として扱う。"
          ])
        ]
      : []),
    "",
    promptMaterials.outputFormats.speechReasoningJson.japaneseInstruction,
    promptMaterials.outputFormats.japaneseReminder,
    "",
    legalReadTargetLineForLanguage(options.legalPlayers, options.language)
  ];

  return lines.join("\n");
}

function japaneseSpeechRealizationSystemPrompt(options: BuildSystemPromptOptions): string {
  const styleGuide = japaneseStyleGuide(options.language);
  const dialogueContract = japaneseDialogueContract(options.language, options.requiresForwardMove ?? true);
  const opensFirstDay = options.opensFirstDay ?? false;
  const lines = [
    "あなたは人狼ゲームの発話意図を、画面に表示する短いセリフへ変換します。",
    `名前: ${options.player.name}。表向きの性格: ${personaHeading(options.player.persona, options.language)}。`,
    "返答言語: 日本語。",
    "",
    "重要:",
    "- この段階では新しい推理を足さない。",
    "- 入力された intent と metadata の内容だけを自然な会話に直す。",
    "- メタデータのラベル、ID、JSON キー、内部用語、進行メモをセリフに写さない。",
    ...(opensFirstDay
      ? [
          "- 初日1巡目でも「様子見」「保留」「話を聞く」だけのセリフにしない。",
          "- 投票基準、役職方針、名指し質問、軽い投票候補のどれかが聞こえる文にする。"
        ]
      : []),
    ...(styleGuide.length > 0 ? ["", ...styleGuide] : []),
    ...(dialogueContract.length > 0 ? ["", ...dialogueContract] : []),
    "",
    promptMaterials.outputFormats.speechRealizationJson.japaneseInstruction,
    promptMaterials.outputFormats.japaneseReminder
  ];

  return lines.join("\n");
}

export function buildSpeechReasoningSystemPrompt(options: BuildSystemPromptOptions): string {
  if (isJapaneseLanguage(options.language)) {
    return japaneseSpeechReasoningSystemPrompt(options);
  }

  const promptPhase = promptPhaseFromGamePhase(options.phase);
  const profile = getRolePromptProfile(options.player.role);
  const styleGuide = japaneseStyleGuide(options.language);
  const lines = [
    "You are preparing the reasoning metadata for a hidden-role werewolf public statement.",
    `You are ${options.player.name}; role=${options.player.role}; persona=${options.player.persona}.`,
    `Respond in ${options.language}.`,
    "",
    "Information boundary:",
    bulletList(commonBoundaryLines("public_speech")),
    "",
    "Role strategy:",
    bulletList(profile.roleStrategy),
    "",
    "Phase guidance:",
    ...phaseInstructions(profile, promptPhase),
    ...(styleGuide.length > 0 ? ["", ...styleGuide] : []),
    "",
    speechReasoningJsonSchemaInstruction,
    outputFormatReminder,
    "",
    legalReadTargetLineForLanguage(options.legalPlayers, options.language)
  ];

  return lines.join("\n");
}

export function buildSpeechRealizationSystemPrompt(options: BuildSystemPromptOptions): string {
  if (isJapaneseLanguage(options.language)) {
    return japaneseSpeechRealizationSystemPrompt(options);
  }

  const dialogueContract = japaneseDialogueContract(options.language);
  const lines = [
    "You convert a hidden-role werewolf speech intent into displayed dialogue.",
    `You are ${options.player.name}; persona=${options.player.persona}.`,
    `Respond in ${options.language}.`,
    "",
    "Important:",
    "- Do not add new reasoning, facts, targets, claims, or results.",
    "- Use only the supplied intent and metadata.",
    "- Do not copy metadata labels, JSON keys, ids, schema text, or planning notes into messages.",
    ...(dialogueContract.length > 0 ? ["", ...dialogueContract] : []),
    "",
    speechRealizationJsonSchemaInstruction,
    outputFormatReminder
  ];

  return lines.join("\n");
}

export function buildTargetSystemPrompt(options: BuildSystemPromptOptions): string {
  if (isJapaneseLanguage(options.language)) {
    const skipLine = options.allowSkip
      ? "対象を選ばない方がよい場合だけ、targetId に null を返せます。"
      : "必ず一覧にある対象 ID を一つ選んでください。";
    return japaneseTargetSystemPrompt(options, [promptMaterials.outputFormats.targetJson.japaneseInstruction, skipLine].join("\n"));
  }

  const skipLine = options.allowSkip
    ? "You may return null if skipping is strategically best and the action allows it."
    : "You must choose one listed target.";
  return baseSystemPrompt(options, "internal_decision", [targetJsonSchemaInstruction, skipLine].join("\n"));
}

export function buildBooleanSystemPrompt(options: BuildSystemPromptOptions): string {
  return baseSystemPrompt(options, "internal_decision", booleanJsonSchemaInstruction);
}

export function buildTargetList(candidates: TargetCandidate[]): string {
  return candidates.map((target) => `- ${target.id}: ${target.name}`).join("\n");
}
