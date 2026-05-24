import type { Persona, Phase, Player, Role, TargetCandidate } from "../types";
import { campLabel, defaultLanguage, isJapaneseLanguage, roleLabel } from "../i18n";
import { characterVoiceSection } from "../characters";
import { daySituationGuidance } from "../daySituations";
import { japaneseStyleGuide } from "../japaneseStyle";
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

function roleVisiblePrivateInfo(role: Role, secret: RoleSecretContext | undefined, language: string): string[] {
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

function legalReadTargetLine(players: TargetCandidate[] | undefined): string {
  if (!players || players.length === 0) {
    return "Legal living read target ids for suspects/trusts: none. Keep suspects and trusts empty.";
  }
  return `Legal living read target ids for suspects/trusts: ${players.map((candidate) => `${candidate.id}=${candidate.name}`).join(", ")}.`;
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
  const situationGuidance = daySituationGuidance({ phase, round, publicHistory, extra, language });
  const lines = [
    japanese ? `あなたは${player.name}です。` : `You are ${player.name}.`,
    japanese ? `あなたの役職: ${roleLabel(player.role, language)}。` : `Your role: ${player.role}.`,
    japanese ? `公開上の性格: ${personaHeading(player.persona, language)}。` : `Your public persona: ${player.persona}.`,
    japanese
      ? `現在のフェーズ: ${phaseHeading(phase, language)}。ラウンド: ${round}。`
      : `Current phase: ${phase}. Round: ${round}.`,
    `Prompt mode: ${mode === "public_speech" ? "public speech" : "internal decision"}.`,
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
          "Dead players are historical evidence only, not current suspicion, trust, pressure, vote, or elimination targets."
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
      "- Do not describe any specific player's earlier statement, reaction, contradiction, speaking volume, or vagueness as observed evidence yet."
    );
  } else if (publicHistory.length > 0) {
    lines.push("", "Recent public discussion:", ...recentLines(publicHistory, 18));
  }

  if (extra.length > 0) {
    lines.push("", "Task-specific visible context:", ...extra);
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

  if (mode === "public_speech") {
    lines.push("", "Public speech must not reveal:", bulletList(profile.publicSpeechMustNotReveal));
  }

  if (mode === "public_speech") {
    lines.push("", legalReadTargetLine(options.legalPlayers));
  } else if (legal) {
    lines.push("", legal);
  }

  return lines.join("\n");
}

export function buildSpeechSystemPrompt(options: BuildSystemPromptOptions): string {
  return baseSystemPrompt(options, promptModeFromGamePhase(options.phase), speechJsonSchemaInstruction);
}

export function buildTargetSystemPrompt(options: BuildSystemPromptOptions): string {
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
