import { setMaxListeners } from "node:events";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import { hedge, mapConcurrentUnordered, mergeAbortSignals, raceCandidates } from "llm-hedge";
import { buildSimpleFallbackSpeech, createAgentFactory, DemoAgent, summarizeRoundWithLlm } from "./agents";
import { characterNames, getCharacterProfile, getPersonaForPlayer } from "./characters";
import {
  textHasCampResultEvidence,
  textHasSeerClaimEvidence,
  textHasSpeakerAnyRoleClaimEvidence,
  textHasSpeakerRoleClaimEvidence
} from "./daySituations";
import { buildHumanInputContext, HumanInputAgent } from "./humanAgent";
import { defaultLoverAlignmentSpeechForPlayer, defaultWerewolfAlignmentSpeechForPlayer } from "./humanInputDefaults";
import { campLabel, defaultLanguage, isJapaneseLanguage, roleLabel } from "./i18n";
import { reviewJapaneseOutput, stripJapaneseSpeechTerminalPeriod } from "./japaneseStyle";
import { loverFaceoffLineOptionsForPlayer } from "./loverFaceoffLines";
import { buildBaseContext, type RoleBreakdownEntry, type RoleSecretContext } from "./prompts";
import {
  buildPublicSpeechPlan,
  firstDayOpeningMove,
  firstDayOpeningMoveKinds,
  publicNightDeathInfos,
  renderPublicSpeechDiversityContext
} from "./speechPlanning";
import {
  canUseDeathTrigger,
  createDeathResolutionEffects,
  createLinkedDeathRecords,
  createNightDeathRecords,
  markPlayerDead,
  mergeDeathCause
} from "./rules/deaths";
import { resolveVoteElimination } from "./rules/elimination";
import type { DeathRecord, RuleState } from "./rules/types";
import { createNightActionPlan } from "./rules/night";
import {
  createRoles,
  createRolesWithFixedHumanRole,
  createScenarioRoles,
  minimumPlayerCountForScenario,
  normalizePlayerCount
} from "./rules/presets";
import { roleCamp } from "./rules/roles";
import { addVictoryClaims, applyStatusEffects, canUseAbilities, createInitialRuleState, expireStatuses, playerStatuses } from "./rules/state";
import { filterEligibleVotes, resolveVote, tallyVotes, topVoted, voteModifiersFromRuleState, type VoteModifier } from "./rules/voting";
import {
  adjudicateStandardVictory,
  checkLoverVictory,
  checkNeutralVictory,
  checkStandardVictory,
  countAliveByCamp,
  standardCampWinnerIds
} from "./rules/victory";
import { sample, shuffle, weightedChance } from "./random";
import { werewolfFaceoffLineOptionsForPlayer } from "./werewolfFaceoffLines";
import type {
  Agent,
  AgentBooleanInput,
  AgentSpeech,
  AgentSpeechInput,
  AgentTargetInput,
  Camp,
  CampId,
  ClaimMetadata,
  DebugScenario,
  EventVisibility,
  FirstDayOpeningMoveKind,
  GameConfig,
  GameEvent,
  GameSnapshot,
  GenerationProgress,
  GenerationProgressTask,
  HumanCampPreference,
  HumanInputHandler,
  HumanInputRequestPayload,
  HumanInputResponse,
  Persona,
  Phase,
  Player,
  PublicSpeechPlan,
  Role,
  SeerClaimResult,
  SpeechGenerationDiagnostic,
  SpeechMetadata,
  SummaryMode,
  TargetCandidate,
  TargetDecision,
  VoteRecord,
  WinnerGroup,
  WinnerRoleSummary
} from "./types";

const fallbackPersonas: Persona[] = [
  "cautious",
  "aggressive",
  "logical",
  "opportunistic",
  "empathetic",
  "trickster",
  "stoic",
  "passionate"
];
const regularDayDiscussionPasses = 2;
const followUpDayDiscussionPass = regularDayDiscussionPasses + 1;
const followUpDayDiscussionSpeakerRatio = 0.3;
const minFollowUpDayDiscussionSpeakers = 2;
const maxFollowUpDayDiscussionSpeakers = 6;
const werewolfFakeRoleOpeningProbability = 0.5;
const defaultAiPrefetchConcurrency = 5;
const maxAiPrefetchConcurrency = 5;
const abortSignalMaxListeners = 64;
const maxHumanDayDiscussionInterruptions = 5;
const dayVoteDecisionTimeoutMs = 20_000;
const defaultHumanOptionalInputTimeoutMs = 120_000;

const roleBreakdownOrder: Role[] = [
  "Werewolf",
  "AlphaWolf",
  "WolfBeauty",
  "Seer",
  "Witch",
  "Guard",
  "Hunter",
  "Trapper",
  "Idiot",
  "Elder",
  "Lover",
  "Jester",
  "Villager"
];

const fallbackAgent = new DemoAgent("fallback", "demo", defaultLanguage);

const targetActionLabels: Record<string, string> = {
  "Guard night protection": "騎士の夜護衛",
  "Werewolf night kill vote": "人狼の夜襲撃投票",
  "Seer identity check": "占い師の判定",
  "Witch poison potion": "魔女の毒薬",
  "Wolf Beauty charm": "美女狼の魅了",
  "Trap set": "罠師の罠",
  "Day elimination vote": "昼の処刑投票",
  "Alpha Wolf death shot": "α人狼の道連れ",
  "Hunter death shot": "ハンターの道連れ"
};

function targetActionLabel(action: string): string {
  return targetActionLabels[action] ?? action;
}

function humanInfluenceFollowUpPersonaScore(persona: Persona): number {
  switch (persona) {
    case "empathetic":
      return 1.6;
    case "passionate":
      return 1.45;
    case "opportunistic":
      return 1.25;
    case "cautious":
      return 1.05;
    case "logical":
      return 0.95;
    case "trickster":
      return 0.8;
    case "aggressive":
      return 0.65;
    case "stoic":
      return 0.5;
  }
}

function normalizeHumanOptionalInputTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return defaultHumanOptionalInputTimeoutMs;
  }
  return Math.max(0, Math.floor(value));
}

type HumanInfluenceMode = "adopt" | "lean" | "ignore" | "challenge";

interface HumanInfluenceThresholds {
  adopt: number;
  lean: number;
  challenge: number;
}

function stableUnitInterval(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x100000000;
}

// Strong player influence: most personas adopt the human's read outright, the rest lean
// toward it, and outright ignoring is rare. Challenge stays small so the player's words
// are seldom dismissed even by skeptical personas.
function humanInfluenceThresholds(persona: Persona): HumanInfluenceThresholds {
  switch (persona) {
    case "empathetic":
      return { adopt: 0.65, lean: 0.25, challenge: 0.03 };
    case "passionate":
      return { adopt: 0.6, lean: 0.27, challenge: 0.05 };
    case "opportunistic":
      return { adopt: 0.55, lean: 0.28, challenge: 0.05 };
    case "cautious":
      return { adopt: 0.52, lean: 0.28, challenge: 0.05 };
    case "logical":
      return { adopt: 0.5, lean: 0.3, challenge: 0.05 };
    case "trickster":
      return { adopt: 0.48, lean: 0.25, challenge: 0.12 };
    case "aggressive":
      return { adopt: 0.5, lean: 0.22, challenge: 0.13 };
    case "stoic":
      return { adopt: 0.45, lean: 0.3, challenge: 0.07 };
  }
}

function humanInfluenceMode(persona: Persona, roll: number): HumanInfluenceMode {
  const thresholds = humanInfluenceThresholds(persona);
  if (roll < thresholds.adopt) {
    return "adopt";
  }
  if (roll < thresholds.adopt + thresholds.lean) {
    return "lean";
  }
  if (roll < thresholds.adopt + thresholds.lean + thresholds.challenge) {
    return "challenge";
  }
  return "ignore";
}

// Evidence- and survival-driven votes still hold against the player's social pressure:
// reacting to a role claim, voting whoever threatens to out you, and witch/poison risk
// control. Only a generic stated vote reason ("vote_reason") is now re-pointable, so the
// player's reads land more often than before.
function voteReasonResistsHumanInfluence(reasonKind: TargetDecision["reasonKind"]): boolean {
  return reasonKind === "claim_reaction" || reasonKind === "role_threat" || reasonKind === "risk_control";
}

interface DiscussionRecord {
  playerId: string;
  playerName: string;
  message: string;
  metadata: SpeechMetadata;
}

interface DiscussionReadDetail {
  sourceId: string;
  sourceName: string;
  targetId: string;
  targetName: string;
  reason?: string;
  weight?: number;
}

interface RoundSummaryDeathDetail {
  playerId: string;
  playerName: string;
}

interface RoundSummaryClaimDetail {
  speakerId: string;
  speakerName: string;
  claim: ClaimMetadata;
}

interface RoundSummaryVoteDetail {
  voterId: string;
  voterName: string;
  targetId: string;
  targetName: string;
}

interface RoundSummaryVoteTotal {
  targetId: string;
  targetName: string;
  count: number;
}

type RoundSummaryData = Record<string, unknown> & {
  nightDeaths: RoundSummaryDeathDetail[];
  claims: RoundSummaryClaimDetail[];
  suspects: DiscussionReadDetail[];
  trusts: DiscussionReadDetail[];
  votes: RoundSummaryVoteDetail[];
  totals: RoundSummaryVoteTotal[];
};

interface SocialReadPressure {
  targetId: string;
  targetName: string;
  reasons: string[];
  weight: number;
}

interface HumanFollowUpInfluence {
  responderScores: Map<string, number>;
  humanReadTargetIds: Set<string>;
}

interface HumanSocialInfluenceProfile {
  human: Player;
  mode: HumanInfluenceMode;
  suspects: SocialReadPressure[];
  trusts: SocialReadPressure[];
}

interface HumanDayDiscussionInterruptState {
  remaining: number;
  available: boolean;
  pending?: PendingHumanDayDiscussionInterrupt | null;
}

interface DayDiscussionSpeechResult {
  player: Player;
  speech: AgentSpeech;
  visibleEventId?: number | null;
}

interface PendingHumanDayDiscussionInterrupt {
  controller: AbortController;
  requestId: string | null;
  promise: Promise<DayDiscussionSpeechResult | null>;
  settled: boolean;
  rollbackSnapshot: HumanDayDiscussionRollbackSnapshot;
  rollbackPoints: Map<number, HumanDayDiscussionRollbackSnapshot>;
}

interface HumanDayDiscussionRollbackSnapshot {
  publicHistoryLength: number;
  lastDiscussionLength: number;
  remainingAi: Player[];
  accepted: number;
  werewolfDeceptions: Map<string, WerewolfDeceptionState>;
  seerDisclosures: Map<string, SeerDisclosureState>;
}

interface PreparedTargetAction {
  actor: Player;
  target: Player;
  reason: string;
}

interface WerewolfAttackResolution {
  target: Player | null;
  votes: VoteRecord[];
  totals: Array<{ targetId: string; count: number }>;
  candidates: string[];
  tied: boolean;
  randomSelectionReason: "tie" | "no_votes" | null;
}

type DayVoteCollectionResult =
  | { kind: "decision"; voter: Player; decision: TargetDecision }
  | { kind: "timeout"; voter: Player; targets: Player[] };

type PreparedWitchAction =
  | { kind: "save"; witch: Player; target: Player }
  | { kind: "poison"; witch: Player; target: Player; reason: string };

type FakeSeerResult = SeerClaimResult & { announced?: boolean };

interface WerewolfDeceptionState {
  claimedRole: Role;
  plannedSinceRound: number;
  publiclyClaimed: boolean;
  claimRound?: number;
  fakeSeerResults: FakeSeerResult[];
}

interface WerewolfDeceptionTask {
  kind: "claim_seer" | "publish_fake_seer_result";
  result?: FakeSeerResult;
}

interface SeerDisclosureState {
  publiclyClaimed: boolean;
  claimRound?: number;
  announcedResultIds: Set<string>;
}

interface SeerDisclosureTask {
  kind: "claim_seer_with_results" | "publish_seer_results";
  results: SeerClaimResult[];
}

interface WerewolfGameOptions {
  humanInput?: HumanInputHandler;
  abortSignal?: AbortSignal;
  onProgress?: (progress: GenerationProgress) => void;
  onSpeechDiagnostics?: (diagnostic: SpeechGenerationDiagnostic) => void;
}

interface SpeculativeRunOptions {
  signal?: AbortSignal;
  speculative?: boolean;
}

interface SafeGenerationOptions {
  abortSignal?: AbortSignal;
  suppressMemorySideEffects?: boolean;
}

interface DayDiscussionSpeechPrefetch {
  round: number;
  openingSpeakerId: string;
  openingMoveByPlayerId: Map<string, FirstDayOpeningMoveKind>;
  promise: Promise<{ player: Player; speech: AgentSpeech }>;
}

interface DayWarmupSpeechPrefetch {
  round: number;
  openingMoveByPlayerId: Map<string, FirstDayOpeningMoveKind>;
  stream: BufferedAsyncIterable<{ player: Player; speech: AgentSpeech }>;
  cancel(): void;
}

interface VictoryResult {
  camp: Camp | null;
  winnerCamp?: CampId | null;
  winnerIds?: string[];
  winnerCamps?: CampId[];
  winnerGroups?: WinnerGroup[];
  winnerRoles?: WinnerRoleSummary[];
  personalLossPlayerId?: string;
  reason: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textMentionsClaimTarget(text: string, claim: ClaimMetadata): boolean {
  const result = typeof claim.result === "object" && claim.result !== null ? claim.result : undefined;
  const names = [claim.targetName, claim.targetId, result?.targetName, result?.targetId].filter(
    (value): value is string => Boolean(value)
  );
  return names.some((name) => text.includes(name));
}

function otherClaimantNames(claim: ClaimMetadata, legalPlayers: TargetCandidate[], speaker?: TargetCandidate): string[] {
  const result = typeof claim.result === "object" && claim.result !== null ? claim.result : undefined;
  const exemptNames = new Set([speaker?.name, claim.targetName, result?.targetName].filter((name): name is string => Boolean(name)));
  return legalPlayers.map((player) => player.name).filter((name) => !exemptNames.has(name));
}

function resultAttributedToOtherClaimant(claim: ClaimMetadata, speechText: string, otherPlayerNames: string[]): boolean {
  if (otherPlayerNames.length === 0) {
    return false;
  }
  const result = typeof claim.result === "object" && claim.result !== null ? claim.result : undefined;
  const targetNames = [claim.targetName, result?.targetName].filter((name): name is string => Boolean(name));
  const targetPattern = targetNames.length > 0 ? `(?:${targetNames.map(escapeRegExp).join("|")})` : "";
  const resultCue = targetPattern
    ? `${targetPattern}[^。！？!?\\n]{0,24}(?:人間側|人間|村側|村人|白|黒|狼|人狼)判定`
    : "(?:人間側|人間|村側|村人|白|黒|狼|人狼)判定";
  return otherPlayerNames.some((name) => {
    const escapedName = escapeRegExp(name);
    return new RegExp(
      `${escapedName}(?:さん|君|ちゃん)?\\s*(?:が|は|も)[^。！？!?\\n]{0,40}(?:${resultCue}|結果|占い|主張|言(?:った|いました|っている|っています))`,
      "u"
    ).test(speechText);
  });
}

function claimMetadataVisibleInSpeech(
  claim: ClaimMetadata,
  speechText: string,
  language: string,
  legalPlayers: TargetCandidate[],
  speaker?: TargetCandidate
): boolean {
  const result = typeof claim.result === "object" && claim.result !== null ? claim.result : undefined;
  const otherNames = otherClaimantNames(claim, legalPlayers, speaker);
  const hasRoleClaim = claim.role
    ? textHasSpeakerRoleClaimEvidence(speechText, claim.role, language, speaker?.name, otherNames)
    : textHasSpeakerAnyRoleClaimEvidence(speechText, language, speaker?.name, otherNames);
  const hasResult =
    Boolean(result ?? claim.camp) &&
    textHasCampResultEvidence(speechText) &&
    textMentionsClaimTarget(speechText, claim) &&
    !resultAttributedToOtherClaimant(claim, speechText, otherNames);
  const hasWitchInfo =
    claim.type === "witch_info" && /(?:魔女|薬|救済|毒|witch|potion|saved|poisoned)/i.test(speechText);

  return hasRoleClaim || hasResult || hasWitchInfo;
}

function speechEventData(
  speech: AgentSpeech,
  message: string,
  index: number,
  visibility?: EventVisibility,
  extra?: Record<string, unknown>
): Record<string, unknown> & { visibility?: EventVisibility } {
  return {
    ...(visibility ? { visibility } : {}),
    ...(extra ?? {}),
    speech: message,
    speechIndex: index,
    speechCount: speech.messages.length,
    ...(index === speech.messages.length - 1 ? speech.metadata : emptySpeechMetadata())
  };
}

function emptySpeechMetadata(): SpeechMetadata {
  return {
    suspects: [],
    trusts: [],
    claims: []
  };
}

const humanSpeechChoiceCount = 2;
const maxHumanSpeechLength = 240;
const maxWerewolfFaceoffSpeechLengthJa = 72;
const maxWerewolfFaceoffSpeechLengthEn = 150;
// Draft one extra so that, after deduping, the player still sees a full set of distinct options.
const humanSpeechDraftCount = humanSpeechChoiceCount + 1;

function defaultHumanHoldSpeech(language: string): AgentSpeech {
  return {
    messages: [isJapaneseLanguage(language) ? "今は発言を控える" : "今は発言を控える"],
    metadata: emptySpeechMetadata()
  };
}

function compactHumanSpeech(value: string | undefined, language: string): string | null {
  const compact = value?.replace(/\s+/g, " ").trim();
  if (!compact) {
    return null;
  }
  const truncated = compact.length > maxHumanSpeechLength ? `${compact.slice(0, maxHumanSpeechLength - 3)}...` : compact;
  return stripJapaneseSpeechTerminalPeriod(truncated, language);
}

function compactWerewolfFaceoffMessage(value: string, language: string): string | null {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return null;
  }

  const maxLength = isJapaneseLanguage(language) ? maxWerewolfFaceoffSpeechLengthJa : maxWerewolfFaceoffSpeechLengthEn;
  if (compact.length <= maxLength) {
    return stripJapaneseSpeechTerminalPeriod(compact, language);
  }

  const head = compact.slice(0, maxLength - 3);
  const minUsefulCut = Math.floor(maxLength * 0.58);
  const cutAt = ["。", "！", "？", ".", "!", "?", "、", ",", "；", ";"].reduce(
    (best, mark) => Math.max(best, head.lastIndexOf(mark)),
    -1
  );
  const trimmed = cutAt >= minUsefulCut ? head.slice(0, cutAt + 1) : head;
  return stripJapaneseSpeechTerminalPeriod(`${trimmed.trimEnd()}...`, language);
}

function compactWerewolfFaceoffSpeech(speech: AgentSpeech, language: string): AgentSpeech {
  const compactMessages = speech.messages
    .map((message) => compactWerewolfFaceoffMessage(message, language))
    .filter((message): message is string => Boolean(message));
  return {
    ...speech,
    messages: compactMessages.length > 0 ? [compactMessages.join(" ")] : speech.messages
  };
}

function dedupeSpeechCandidates(candidates: AgentSpeech[]): AgentSpeech[] {
  const seen = new Set<string>();
  const unique: AgentSpeech[] = [];
  for (const candidate of candidates) {
    const key = candidate.messages.join("\n").trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

function resolveSpeechChoiceIndex(choiceId: string | undefined, count: number): number {
  const parsed = Number(choiceId);
  if (Number.isInteger(parsed) && parsed >= 0 && parsed < count) {
    return parsed;
  }
  return 0;
}

function playerIdIndex(playerId: string | null | undefined, playerCount: number): number | null {
  const match = playerId?.match(/^p([1-9]\d*)$/);
  if (!match) {
    return null;
  }
  const index = Number(match[1]) - 1;
  return Number.isInteger(index) && index >= 0 && index < playerCount ? index : null;
}

function normalizeHumanPlayerId(playerId: string | null | undefined, playerCount: number): string | null {
  const index = playerIdIndex(playerId, playerCount);
  return index === null ? null : `p${index + 1}`;
}

function normalizeHumanCampPreference(preference: HumanCampPreference | undefined): HumanCampPreference {
  return preference === "village" || preference === "werewolf" ? preference : "random";
}

function createMatchRoles(
  playerCount: number,
  humanPlayerId: string | null,
  humanInputAvailable: boolean,
  humanCampPreference: HumanCampPreference = "random",
  humanRolePreference: Role | null = null
): Role[] {
  const roles = humanRolePreference ? createRolesWithFixedHumanRole(playerCount, humanRolePreference) : createRoles(playerCount);
  if (!humanInputAvailable || !humanPlayerId) {
    return shuffle(roles);
  }

  const humanIndex = playerIdIndex(humanPlayerId, roles.length);
  if (humanIndex === null) {
    return shuffle(roles);
  }

  if (humanRolePreference) {
    return assignSpecificHumanRole(roles, humanIndex, humanRolePreference);
  }
  return assignHumanRole(roles, humanIndex, humanCampPreference);
}

function assignSpecificHumanRole(roles: Role[], humanIndex: number, humanRole: Role): Role[] {
  const remainingRoles = removeOneRole(roles, humanRole);
  const shuffledRemaining = shuffle(remainingRoles);
  return [...shuffledRemaining.slice(0, humanIndex), humanRole, ...shuffledRemaining.slice(humanIndex)];
}

function assignHumanRole(roles: Role[], humanIndex: number, campPreference: HumanCampPreference): Role[] {
  const preference = normalizeHumanCampPreference(campPreference);
  const humanRole = preference === "random" ? sampleBalancedHumanRole(roles) : sampleHumanRoleForCamp(roles, preference);
  const remainingRoles = removeOneRole(roles, humanRole);
  const shuffledRemaining = shuffle(remainingRoles);
  return [...shuffledRemaining.slice(0, humanIndex), humanRole, ...shuffledRemaining.slice(humanIndex)];
}

function sampleHumanRoleForCamp(roles: Role[], camp: Camp): Role {
  const candidates = preferredHumanAssignableRoles(roles.filter((role) => roleCamp(role) === camp));
  return candidates.length > 0 ? sample(candidates) : sampleBalancedHumanRole(roles);
}

function sampleBalancedHumanRole(roles: Role[]): Role {
  const candidates = preferredHumanAssignableRoles(roles);
  const werewolfCount = candidates.filter((role) => roleCamp(role) === "werewolf").length;
  const villageCount = candidates.length - werewolfCount;
  const werewolfWeight = werewolfCount > 0 && villageCount > 0 ? villageCount / werewolfCount : 1;
  const weightForRole = (role: Role) => (roleCamp(role) === "werewolf" ? werewolfWeight : 1);
  const totalWeight = candidates.reduce((total, role) => total + weightForRole(role), 0);
  let cursor = Math.random() * totalWeight;

  for (const role of candidates) {
    cursor -= weightForRole(role);
    if (cursor < 0) {
      return role;
    }
  }

  return candidates[candidates.length - 1];
}

function preferredHumanAssignableRoles(roles: Role[]): Role[] {
  const activeRoles = roles.filter((role) => role !== "Villager");
  return activeRoles.length > 0 ? activeRoles : roles;
}

function removeOneRole(roles: Role[], roleToRemove: Role): Role[] {
  const index = roles.indexOf(roleToRemove);
  if (index === -1) {
    return [...roles];
  }
  return [...roles.slice(0, index), ...roles.slice(index + 1)];
}

function humanProtectionRoundByPlayerCount(playerCount: number): number {
  if (playerCount <= 8) {
    return 2;
  }
  if (playerCount <= 13) {
    return 3;
  }
  return 4;
}

function normalizeSummaryMode(mode: SummaryMode | undefined): SummaryMode {
  return mode === "llm" ? "llm" : "deterministic";
}

function normalizeDebugScenario(scenario: DebugScenario | undefined): DebugScenario {
  return scenario === "guard_success" || scenario === "hunter_shot" ? scenario : "none";
}

class ScenarioAgent extends DemoAgent {
  constructor(
    name: string,
    language: string,
    private readonly scenarioName: DebugScenario,
    private readonly scriptedTargets: Array<string | null> = [],
    private readonly scriptedDecisions: boolean[] = []
  ) {
    super(name, "debug-demo", language);
  }

  async chooseTarget(input: AgentTargetInput): Promise<TargetDecision> {
    while (this.scriptedTargets.length > 0) {
      const targetId = this.scriptedTargets.shift() ?? null;
      if (targetId === null) {
        if (input.allowSkip) {
          return {
            targetId: null,
            reason: isJapaneseLanguage(this.language)
              ? `${this.name}は${this.scenarioName}のシナリオに従っています。`
              : `${this.name} follows the ${this.scenarioName} script.`
          };
        }
        continue;
      }
      if (input.candidates.some((candidate) => candidate.id === targetId)) {
        return {
          targetId,
          reason: isJapaneseLanguage(this.language)
            ? `${this.name}は${this.scenarioName}のシナリオに従っています。`
            : `${this.name} follows the ${this.scenarioName} script.`
        };
      }
    }
    return super.chooseTarget(input);
  }

  async decide(input: AgentBooleanInput): Promise<boolean> {
    if (this.scriptedDecisions.length > 0) {
      return this.scriptedDecisions.shift() ?? false;
    }
    return super.decide(input);
  }
}

function shouldRethrowLlmError(agent: Agent): boolean {
  return agent.model !== "demo" && agent.model !== "demo-fallback" && agent.model !== "debug-demo" && agent.model !== "human";
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:429|rate[_ -]?limit|\[1302\])/iu.test(message);
}

function shouldFallbackFromLlmError(agent: Agent, error: unknown): boolean {
  return isRateLimitError(error) || !shouldRethrowLlmError(agent);
}

function llmErrorMemoryNote(kind: "speech" | "target" | "decision", error: unknown): { english: string; japanese: string } {
  if (isRateLimitError(error)) {
    return {
      english: `LLM rate limit during ${kind}; demo fallback was used.`,
      japanese: `${kind === "speech" ? "発言" : kind === "target" ? "対象選択" : "判断"}生成中にLLMのレート制限が発生したため、デモ生成に切り替えました。`
    };
  }
  return {
    english: `LLM error during ${kind}: ${String(error)}`,
    japanese: `${kind === "speech" ? "発言生成" : kind === "target" ? "対象選択" : "判断"}中のLLMエラー: ${String(error)}`
  };
}

function normalizePrefetchConcurrency(value: number | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultAiPrefetchConcurrency;
  }
  return Math.max(1, Math.min(maxAiPrefetchConcurrency, Math.floor(parsed)));
}

function aiPrefetchConcurrency(configured?: number): number {
  if (configured !== undefined) {
    return normalizePrefetchConcurrency(configured);
  }
  return defaultAiPrefetchConcurrency;
}

function speechRaceSlots(players: Player[], concurrency: number): Player[] {
  if (players.length === 0) {
    return [];
  }

  const limit = Math.max(1, concurrency);
  const ordered = limit === 1 ? [players[0]] : shuffle(players);
  const slots = ordered.slice(0, Math.min(limit, ordered.length));
  let index = 0;
  while (slots.length < limit) {
    slots.push(ordered[index % ordered.length]);
    index += 1;
  }
  return slots;
}

function decisionRaceSlotCounts(itemCount: number, concurrency: number): number[] {
  if (itemCount <= 0) {
    return [];
  }

  const limit = Math.max(1, concurrency);
  const activeItems = Math.min(itemCount, limit);
  const counts = Array.from({ length: activeItems }, () => 1);
  let extraSlots = limit - activeItems;
  let index = 0;
  while (extraSlots > 0) {
    counts[index % activeItems] += 1;
    extraSlots -= 1;
    index += 1;
  }
  return counts;
}

interface BufferedAsyncIterable<T> extends AsyncIterable<T> {
  push(value: T): void;
  close(): void;
  fail(error: unknown): void;
}

function createBufferedAsyncIterable<T>(onReturn?: () => void): BufferedAsyncIterable<T> {
  const values: T[] = [];
  const waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  let done = false;
  let failed = false;
  let failure: unknown;

  const flush = () => {
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (!waiter) {
        return;
      }
      if (values.length > 0) {
        waiter.resolve({ value: values.shift()!, done: false });
        continue;
      }
      if (failed) {
        waiter.reject(failure);
        continue;
      }
      if (done) {
        waiter.resolve({ value: undefined, done: true });
        continue;
      }
      waiters.unshift(waiter);
      return;
    }
  };

  return {
    push(value: T): void {
      if (done || failed) {
        return;
      }
      values.push(value);
      flush();
    },
    close(): void {
      if (failed) {
        return;
      }
      done = true;
      flush();
    },
    fail(error: unknown): void {
      failed = true;
      failure = error;
      flush();
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          if (values.length > 0) {
            return Promise.resolve({ value: values.shift()!, done: false });
          }
          if (failed) {
            return Promise.reject(failure);
          }
          if (done) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
        },
        return(): Promise<IteratorResult<T>> {
          onReturn?.();
          values.length = 0;
          done = true;
          flush();
          return Promise.resolve({ value: undefined, done: true });
        }
      };
    }
  };
}

async function* completionOrderConcurrentMap<T, R>(
  items: T[],
  concurrency: number,
  run: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  onProgress?: (progress: Pick<GenerationProgress, "total" | "started" | "completed" | "active" | "queued" | "concurrency">) => void,
  signal?: AbortSignal
): AsyncGenerator<R> {
  if (items.length === 0) {
    return;
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  let started = 0;
  let completed = 0;
  let active = 0;
  const report = () => {
    try {
      onProgress?.({
        total: items.length,
        started,
        completed,
        active,
        queued: Math.max(0, items.length - started),
        concurrency: limit
      });
    } catch {
      // Progress observers are best-effort and must not break game generation.
    }
  };
  report();

  for await (const result of mapConcurrentUnordered(
    items,
    async (item, { index, signal: taskSignal }) => {
      started += 1;
      active += 1;
      report();
      try {
        return await run(item, index, taskSignal);
      } finally {
        completed += 1;
        active -= 1;
        report();
      }
    },
    { concurrency: limit, signal }
  )) {
    yield result.value;
  }
}

async function* completionOrderConcurrentDecisionMap<T, R>(
  items: T[],
  concurrency: number,
  run: (item: T, index: number, raceSlots: number, signal: AbortSignal) => Promise<R>,
  onProgress?: (progress: Pick<GenerationProgress, "total" | "started" | "completed" | "active" | "queued" | "concurrency">) => void
): AsyncGenerator<R> {
  if (items.length === 0) {
    return;
  }

  const limit = Math.max(1, concurrency);
  let started = 0;
  let completed = 0;
  let activeSlots = 0;
  const report = () => {
    try {
      onProgress?.({
        total: items.length,
        started,
        completed,
        active: activeSlots,
        queued: Math.max(0, items.length - started),
        concurrency: limit
      });
    } catch {
      // Progress observers are best-effort and must not break game generation.
    }
  };

  for (let offset = 0; offset < items.length; offset += limit) {
    const chunk = items.slice(offset, offset + limit);
    const slotCounts = decisionRaceSlotCounts(chunk.length, limit);
    started += chunk.length;
    activeSlots += slotCounts.reduce((sum, count) => sum + count, 0);
    report();

    for await (const result of mapConcurrentUnordered(
      chunk,
      async (item, { index: chunkIndex, signal }) => {
        const raceSlots = slotCounts[chunkIndex] ?? 1;
        try {
          return await run(item, offset + chunkIndex, raceSlots, signal);
        } finally {
          completed += 1;
          activeSlots = Math.max(0, activeSlots - raceSlots);
          report();
        }
      },
      { concurrency: chunk.length }
    )) {
      yield result.value;
    }
  }
}

export class WerewolfGame {
  private readonly players: Player[];
  private readonly agents = new Map<string, Agent>();
  private readonly humanInput?: HumanInputHandler;
  private humanChoiceAgent: Agent | null = null;
  private readonly publicHistory: string[] = [];
  // Day-segmented context: one factual recap per round that has already ended, carried forward
  // so prior-day events survive into later days instead of being dropped by the sliding window.
  private readonly roundPublicDigests: Array<{ round: number; message: string }> = [];
  // Index into publicHistory where the current round's public discussion begins.
  private roundPublicStart = 0;
  private readonly wolfHistory: string[] = [];
  private readonly loverHistory: string[] = [];
  private readonly config: GameConfig;
  private readonly abortSignal?: AbortSignal;
  private readonly onProgress?: (progress: GenerationProgress) => void;
  private readonly onSpeechDiagnostics?: (diagnostic: SpeechGenerationDiagnostic) => void;
  private readonly prefetchConcurrency: number;
  private readonly startupWarnings: string[] = [];
  private readonly witchState = {
    savePotion: true,
    poisonPotion: true,
    savedTargetId: null as string | null,
    poisonTargetId: null as string | null
  };
  private readonly guardState = {
    protectedTargetId: null as string | null,
    lastProtectedTargetId: null as string | null
  };
  private readonly trapState = {
    targetId: null as string | null,
    trapperId: null as string | null
  };
  private readonly hunterShotsUsed = new Set<string>();
  private ruleState: RuleState = { players: {} };
  private eventId = 0;
  private round = 0;
  private phase: Phase = "setup";
  private winner: Camp | null = null;
  private winnerCamp: CampId | null = null;
  private winnerIds: string[] = [];
  private winnerCamps: CampId[] = [];
  private winnerGroups: WinnerGroup[] = [];
  private personalLossPlayerId: string | null = null;
  private lastNightDeaths: string[] = [];
  private lastDiscussion: DiscussionRecord[] = [];
  private lastWerewolfDiscussion: DiscussionRecord[] = [];
  private lastVotes: VoteRecord[] = [];
  private lastVoteModifiers: VoteModifier[] = [];
  private lastVoteEliminatedPlayerId: string | null = null;
  private readonly deathRecords: DeathRecord[] = [];
  private lastVoteDeathRecords: DeathRecord[] = [];
  private lastNightDeathRecords: DeathRecord[] = [];
  private readonly werewolfDeceptions = new Map<string, WerewolfDeceptionState>();
  private readonly seerDisclosures = new Map<string, SeerDisclosureState>();
  private firstDayOpeningSpeechPrefetch: DayDiscussionSpeechPrefetch | null = null;
  private firstDayWarmupSpeechPrefetch: DayWarmupSpeechPrefetch | null = null;

  constructor(config: GameConfig, options: WerewolfGameOptions = {}) {
    this.humanInput = options.humanInput
      ? {
          request: (input) =>
            options.humanInput!.request({
              ...input,
              revealAfterEventId: input.revealAfterEventId ?? (this.eventId > 0 ? this.eventId : null)
            }),
          ...(options.humanInput.requestOptional
            ? {
                requestOptional: (input, requestOptions) =>
                  options.humanInput!.requestOptional!(
                    {
                      ...input,
                      revealAfterEventId: input.revealAfterEventId ?? (this.eventId > 0 ? this.eventId : null)
                    },
                    requestOptions
                  )
              }
            : {}),
          ...(options.humanInput.latestInputActivityAt
            ? { latestInputActivityAt: (filter) => options.humanInput!.latestInputActivityAt!(filter) }
            : {})
        }
      : undefined;
    this.abortSignal = options.abortSignal;
    if (this.abortSignal) {
      setMaxListeners(abortSignalMaxListeners, this.abortSignal);
    }
    this.onProgress = options.onProgress;
    this.onSpeechDiagnostics = options.onSpeechDiagnostics;
    const debugScenario = normalizeDebugScenario(config.debugScenario);
    const playerCount = normalizePlayerCount(Math.max(config.playerCount, minimumPlayerCountForScenario(debugScenario)));
    const prefetchConcurrency = aiPrefetchConcurrency(config.prefetchConcurrency);
    this.prefetchConcurrency = prefetchConcurrency;
    this.config = {
      ...config,
      language: config.language || defaultLanguage,
      playerCount,
      maxRounds: Math.max(3, config.maxRounds),
      summaryMode: normalizeSummaryMode(config.summaryMode),
      debugScenario,
      humanPlayerId: normalizeHumanPlayerId(config.humanPlayerId, playerCount),
      humanCampPreference: normalizeHumanCampPreference(config.humanCampPreference),
      humanRolePreference: config.humanRolePreference ?? null,
      prefetchConcurrency,
      humanOptionalInputTimeoutMs: normalizeHumanOptionalInputTimeoutMs(config.humanOptionalInputTimeoutMs)
    };

    if (this.config.provider === "llm" && !(process.env.ZAI_API_KEY || process.env.OPENAI_API_KEY)) {
      this.startupWarnings.push(
        this.text(
          "LLM provider was requested, but ZAI_API_KEY or OPENAI_API_KEY is not set. Demo agents are being used instead.",
          "LLMプロバイダーが選択されましたが、ZAI_API_KEYまたはOPENAI_API_KEYが未設定です。デモエージェントに切り替えます。"
        )
      );
    }

    if (this.config.summaryMode === "llm" && this.config.provider !== "llm") {
      this.startupWarnings.push(
        this.text(
          "LLM summaries require the LLM provider. Deterministic summaries will be used.",
          "LLM要約にはLLMプロバイダーが必要です。決定的要約を使用します。"
        )
      );
    }

    if (this.config.humanPlayerId && !options.humanInput) {
      this.startupWarnings.push(
        this.text(
          "A human player was requested, but no human input channel is available. That slot will use an AI agent.",
          "人間プレイヤーが指定されましたが、入力チャンネルがありません。その枠はAIエージェントで進行します。"
        )
      );
    }

    const activeDebugScenario = this.config.debugScenario ?? "none";
    const roles =
      activeDebugScenario === "none"
        ? createMatchRoles(
            this.config.playerCount,
            this.config.humanPlayerId ?? null,
            Boolean(this.humanInput),
            this.config.humanCampPreference,
            this.config.humanRolePreference ?? null
          )
        : createScenarioRoles(activeDebugScenario, this.config.playerCount);
    const createAgent = createAgentFactory({
      provider: this.config.provider,
      model: this.config.model,
      language: this.config.language
    });

    this.players = roles.map((role, index) => {
      const playerId = `p${index + 1}`;
      const profile = getCharacterProfile(playerId);
      const name = profile?.nameJa ?? characterNames[index] ?? `P${index + 1}`;
      const isHumanSlot = playerId === this.config.humanPlayerId && Boolean(this.humanInput);
      const autonomousAgent =
        activeDebugScenario === "none" ? createAgent(name) : this.createScenarioAgent(name, activeDebugScenario, index);
      const agent =
        isHumanSlot && this.humanInput
          ? new HumanInputAgent(name, this.humanInput, this.config.language)
          : autonomousAgent;
      if (isHumanSlot) {
        // Shadow agent that drafts the human player's candidate speeches for the choice menu.
        this.humanChoiceAgent = autonomousAgent;
      }
      const persona = getPersonaForPlayer(playerId) ?? fallbackPersonas[index % fallbackPersonas.length];
      const player: Player = {
        id: playerId,
        name,
        role,
        camp: roleCamp(role),
        persona,
        alive: true,
        model: agent.model,
        memories: [],
        seerResults: {},
        seerResultRounds: {},
        witch: {
          savePotion: role === "Witch",
          poisonPotion: role === "Witch"
        },
        characterProfile: profile
      };
      this.agents.set(player.id, agent);
      return player;
    });
    this.ruleState = createInitialRuleState(this.players);
  }

  private createScenarioAgent(name: string, scenario: DebugScenario, index: number): Agent {
    if (scenario === "guard_success") {
      const targetsByIndex: Array<Array<string | null>> = [["p3"], ["p3"], [], [], [null], ["p3"], [], [], []];
      const decisionsByIndex: boolean[][] = [[], [], [], [], [false], [], [], [], []];
      return new ScenarioAgent(name, this.config.language, scenario, targetsByIndex[index] ?? [], decisionsByIndex[index] ?? []);
    }
    if (scenario === "hunter_shot") {
      const targetsByIndex: Array<Array<string | null>> = [
        ["p3"],
        ["p3"],
        ["p1", "p1"],
        ["p3", null],
        ["p4"],
        ["p3"],
        ["p3"],
        ["p3"],
        ["p3"]
      ];
      const decisionsByIndex: boolean[][] = [[], [], [], [false], [], [], [], [], []];
      return new ScenarioAgent(name, this.config.language, scenario, targetsByIndex[index] ?? [], decisionsByIndex[index] ?? []);
    }
    return new DemoAgent(name, "demo", this.config.language);
  }

  private isJapanese(): boolean {
    return isJapaneseLanguage(this.config.language);
  }

  private text(english: string, japanese: string): string {
    return this.isJapanese() ? japanese : english;
  }

  private playerNameOrId(playerId: string, preferredName?: string): string {
    return preferredName ?? this.players.find((player) => player.id === playerId)?.name ?? playerId;
  }

  private metadataTargetName(read: { targetId: string; targetName?: string }): string {
    return this.playerNameOrId(read.targetId, read.targetName);
  }

  private japaneseSpeechReviewHint(issues: string[]): string {
    const hints: string[] = [];
    if (issues.some((issue) => issue.includes("Chinese vocabulary"))) {
      hints.push("中国語の語彙や簡体字・繁体字を混ぜず、自然な日本語だけで書く。");
    }
    if (issues.some((issue) => issue.includes("internal player id"))) {
      hints.push("内部プレイヤーIDは使わず、相手の名前だけで言う。");
    }
    return hints.length > 0
      ? hints.join(" ")
      : "同じ意図を保ち、自然な日本語の短い発言だけを出してください。";
  }

  private withPhase<T>(phase: Phase, run: () => T): T {
    const previousPhase = this.phase;
    this.phase = phase;
    try {
      return run();
    } finally {
      this.phase = previousPhase;
    }
  }

  private campText(camp: CampId): string {
    return campLabel(camp, this.config.language);
  }

  private roleText(role: Role | "Hidden"): string {
    return roleLabel(role, this.config.language);
  }

  private throwIfCancelled(): void {
    if (this.abortSignal?.aborted) {
      throw new Error("Game stream cancelled.");
    }
  }

  protected dayVoteDecisionTimeoutMs(): number {
    return dayVoteDecisionTimeoutMs;
  }

  private progressReporter(
    task: GenerationProgressTask,
    label: string,
    extra: Partial<Pick<GenerationProgress, "pass" | "passes">> = {}
  ): (progress: Pick<GenerationProgress, "total" | "started" | "completed" | "active" | "queued" | "concurrency">) => void {
    return this.progressReporterAt(this.phase, this.round, task, label, extra);
  }

  private emitSpeechDiagnosticAt(
    round: number,
    phase: Phase,
    diagnostic: Omit<SpeechGenerationDiagnostic, "createdAt" | "round" | "phase">
  ): void {
    try {
      this.onSpeechDiagnostics?.({
        createdAt: new Date().toISOString(),
        round,
        phase,
        ...diagnostic
      });
    } catch {
      // Diagnostic observers are best-effort and must not affect game generation.
    }
  }

  private emitSpeechDiagnostic(diagnostic: Omit<SpeechGenerationDiagnostic, "createdAt" | "round" | "phase">): void {
    this.emitSpeechDiagnosticAt(this.round, this.phase, diagnostic);
  }

  private progressReporterAt(
    phase: Phase,
    round: number,
    task: GenerationProgressTask,
    label: string,
    extra: Partial<Pick<GenerationProgress, "pass" | "passes">> = {}
  ): (progress: Pick<GenerationProgress, "total" | "started" | "completed" | "active" | "queued" | "concurrency">) => void {
    return (progress) => {
      this.onProgress?.({
        createdAt: new Date().toISOString(),
        round,
        phase,
        task,
        label,
        ...progress,
        ...extra
      });
    };
  }

  private async *completionOrderAiWithHumanBoundary<T, R>(
    items: T[],
    getPlayerId: (item: T) => string,
    run: (item: T, index: number, signal: AbortSignal) => Promise<R>,
    onProgress?: (progress: Pick<GenerationProgress, "total" | "started" | "completed" | "active" | "queued" | "concurrency">) => void
  ): AsyncGenerator<R> {
    const indexedItems = items.map((item, index) => ({ item, index }));
    const humanIndex = this.config.humanPlayerId ? indexedItems.findIndex(({ item }) => getPlayerId(item) === this.config.humanPlayerId) : -1;

    if (humanIndex === -1) {
      for await (const result of completionOrderConcurrentMap(
        indexedItems,
        this.prefetchConcurrency,
        ({ item, index }, _chunkIndex, signal) => run(item, index, signal),
        onProgress
      )) {
        yield result;
      }
      return;
    }

    const runChunk = (chunk: typeof indexedItems) =>
      completionOrderConcurrentMap(
        chunk,
        this.prefetchConcurrency,
        ({ item, index }, _chunkIndex, signal) => run(item, index, signal),
        onProgress
      );

    for await (const result of runChunk(indexedItems.slice(0, humanIndex))) {
      yield result;
    }

    const humanItem = indexedItems[humanIndex];
    yield await run(humanItem.item, humanItem.index, new AbortController().signal);

    for await (const result of runChunk(indexedItems.slice(humanIndex + 1))) {
      yield result;
    }
  }

  private async *completionOrderAiDecisionWithHumanBoundary<T, R>(
    items: T[],
    getPlayerId: (item: T) => string,
    run: (item: T, index: number, raceSlots: number, signal: AbortSignal) => Promise<R>,
    onProgress?: (progress: Pick<GenerationProgress, "total" | "started" | "completed" | "active" | "queued" | "concurrency">) => void
  ): AsyncGenerator<R> {
    const indexedItems = items.map((item, index) => ({ item, index }));
    const humanIndex = this.config.humanPlayerId ? indexedItems.findIndex(({ item }) => getPlayerId(item) === this.config.humanPlayerId) : -1;

    const runChunk = (chunk: typeof indexedItems) =>
      completionOrderConcurrentDecisionMap(
        chunk,
        this.prefetchConcurrency,
        ({ item, index }, _chunkIndex, raceSlots, signal) => run(item, index, raceSlots, signal),
        onProgress
      );

    if (humanIndex === -1) {
      for await (const result of runChunk(indexedItems)) {
        yield result;
      }
      return;
    }

    for await (const result of runChunk(indexedItems.slice(0, humanIndex))) {
      yield result;
    }

    const humanItem = indexedItems[humanIndex];
    yield await run(humanItem.item, humanItem.index, 1, new AbortController().signal);

    for await (const result of runChunk(indexedItems.slice(humanIndex + 1))) {
      yield result;
    }
  }

  private async *raceAiWithHumanLast<R>(
    players: Player[],
    run: (player: Player, options?: SpeculativeRunOptions) => Promise<R>,
    onProgress?: (progress: Pick<GenerationProgress, "total" | "started" | "completed" | "active" | "queued" | "concurrency">) => void
  ): AsyncGenerator<R> {
    const aiPlayers = players.filter((player) => !this.isHumanControlledPlayer(player));
    const humanPlayers = players.filter((player) => this.isHumanControlledPlayer(player));
    const total = players.length;
    const limit = Math.max(1, this.prefetchConcurrency);
    let accepted = 0;
    let active = 0;
    const report = () => {
      try {
        onProgress?.({
          total,
          started: Math.min(total, accepted + active),
          completed: accepted,
          active,
          queued: Math.max(0, total - accepted - active),
          concurrency: limit
        });
      } catch {
        // Progress observers are best-effort and must not break game generation.
      }
    };
    const remainingAi = [...aiPlayers];

    while (remainingAi.length > 0) {
      const racers = speechRaceSlots(remainingAi, limit);
      active = racers.length;
      report();
      const result = await this.firstFinishedSpeechRace(racers, run);
      const acceptedIndex = remainingAi.findIndex((player) => player.id === result.player.id);
      if (acceptedIndex !== -1) {
        remainingAi.splice(acceptedIndex, 1);
      }
      accepted += 1;
      active = 0;
      report();
      yield result.value;
    }

    for (const human of humanPlayers) {
      active = 1;
      report();
      const result = await run(human);
      accepted += 1;
      active = 0;
      report();
      yield result;
    }
  }

  private humanDayDiscussionInterruptsEnabled(): boolean {
    return Boolean(this.humanInput?.requestOptional && this.humanControlledPlayer());
  }

  private async *raceAiWithHumanInterrupts(
    players: Player[],
    discussionPass: number,
    discussionPasses: number,
    openingMoveByPlayerId: Map<string, FirstDayOpeningMoveKind>,
    humanInterruptState: HumanDayDiscussionInterruptState,
    onProgress?: (progress: Pick<GenerationProgress, "total" | "started" | "completed" | "active" | "queued" | "concurrency">) => void
  ): AsyncGenerator<{ player: Player; speech: AgentSpeech }> {
    let remainingAi = players.filter((player) => !this.isHumanControlledPlayer(player));
    const human = this.humanControlledPlayer();
    const total = remainingAi.length;
    const limit = Math.max(1, this.prefetchConcurrency);
    let accepted = 0;
    let active = 0;
    const report = () => {
      try {
        onProgress?.({
          total,
          started: Math.min(total, accepted + active),
          completed: accepted,
          active,
          queued: Math.max(0, total - accepted - active),
          concurrency: limit
        });
      } catch {
        // Progress observers are best-effort and must not break game generation.
      }
    };

    type AiRaceWinner = { player: Player; value: DayDiscussionSpeechResult };

    let pendingHumanInterrupt = humanInterruptState.pending ?? null;
    let completedNormally = false;

    const createRollbackSnapshot = (): HumanDayDiscussionRollbackSnapshot => ({
      publicHistoryLength: this.publicHistory.length,
      lastDiscussionLength: this.lastDiscussion.length,
      remainingAi: [...remainingAi],
      accepted,
      werewolfDeceptions: this.cloneWerewolfDeceptions(),
      seerDisclosures: this.cloneSeerDisclosures()
    });

    const restoreRollbackSnapshot = (snapshot: HumanDayDiscussionRollbackSnapshot) => {
      this.publicHistory.length = snapshot.publicHistoryLength;
      this.lastDiscussion.length = snapshot.lastDiscussionLength;
      remainingAi = [...snapshot.remainingAi];
      accepted = snapshot.accepted;
      this.restoreWerewolfDeceptions(snapshot.werewolfDeceptions);
      this.restoreSeerDisclosures(snapshot.seerDisclosures);
    };

    const recordRollbackPoint = (pending: PendingHumanDayDiscussionInterrupt, speech: AgentSpeech) => {
      const endEventId = this.eventId;
      const messageCount = Math.max(1, speech.messages.length);
      const snapshot = createRollbackSnapshot();
      for (let eventId = Math.max(1, endEventId - messageCount + 1); eventId <= endEventId; eventId += 1) {
        pending.rollbackPoints.set(eventId, snapshot);
      }
    };

    const rollbackForHumanInterrupt = (
      pending: PendingHumanDayDiscussionInterrupt,
      humanInterrupt: DayDiscussionSpeechResult
    ) => {
      const visibleEventId = humanInterrupt.visibleEventId ?? null;
      const snapshot =
        visibleEventId === null ? pending.rollbackSnapshot : (pending.rollbackPoints.get(visibleEventId) ?? pending.rollbackSnapshot);
      restoreRollbackSnapshot(snapshot);
      report();
    };

    const openPendingHumanInterrupt = (player: Player): PendingHumanDayDiscussionInterrupt => {
      const controller = new AbortController();
      const rollbackSnapshot = createRollbackSnapshot();
      const pending: PendingHumanDayDiscussionInterrupt = {
        controller,
        requestId: null,
        promise: Promise.resolve(null),
        settled: false,
        rollbackSnapshot,
        rollbackPoints: new Map([[this.eventId, rollbackSnapshot]])
      };
      pending.promise = this.requestHumanDayDiscussionInterrupt(
        player,
        discussionPass,
        discussionPasses,
        humanInterruptState.remaining,
        controller.signal,
        (requestId) => {
          pending.requestId = requestId;
        }
      ).then(
        (result) => {
          pending.settled = true;
          return result;
        },
        (error) => {
          pending.settled = true;
          throw error;
        }
      );
      humanInterruptState.pending = pending;
      return pending;
    };

    const consumePendingHumanInterrupt = async (
      pending: PendingHumanDayDiscussionInterrupt,
      options: { startTimeout?: boolean } = {}
    ): Promise<DayDiscussionSpeechResult | null> => {
      const result = options.startTimeout
        ? await this.waitForPendingHumanDayDiscussionInterrupt(pending)
        : await pending.promise;
      if (pendingHumanInterrupt === pending) {
        pendingHumanInterrupt = null;
        humanInterruptState.pending = null;
      }
      return result;
    };

    const cancelPendingHumanInterrupt = () => {
      if (!pendingHumanInterrupt) {
        return;
      }
      const pending = pendingHumanInterrupt;
      pendingHumanInterrupt = null;
      humanInterruptState.pending = null;
      pending.promise.catch(() => undefined);
      pending.controller.abort();
    };

    try {
      while (true) {
        if (remainingAi.length === 0) {
          if (!pendingHumanInterrupt) {
            break;
          }
          const activeHumanInterrupt = pendingHumanInterrupt;
          const humanInterrupt = await consumePendingHumanInterrupt(activeHumanInterrupt, { startTimeout: true });
          if (!humanInterrupt) {
            break;
          }
          active = 0;
          rollbackForHumanInterrupt(activeHumanInterrupt, humanInterrupt);
          report();
          humanInterruptState.remaining -= 1;
          humanInterruptState.available = false;
          yield humanInterrupt;
          continue;
        }

        if (human && humanInterruptState.available && humanInterruptState.remaining > 0 && !pendingHumanInterrupt) {
          pendingHumanInterrupt = openPendingHumanInterrupt(human);
        }

        if (pendingHumanInterrupt?.settled) {
          const activeHumanInterrupt = pendingHumanInterrupt;
          const humanInterrupt = await consumePendingHumanInterrupt(pendingHumanInterrupt);
          if (humanInterrupt) {
            active = 0;
            rollbackForHumanInterrupt(activeHumanInterrupt, humanInterrupt);
            report();
            humanInterruptState.remaining -= 1;
            humanInterruptState.available = false;
            yield humanInterrupt;
            continue;
          }
        }

        const racers = speechRaceSlots(remainingAi, limit);
        active = racers.length;
        report();
        const aiRaceController = new AbortController();
        const aiRace: Promise<AiRaceWinner> = this.firstFinishedSpeechRace<DayDiscussionSpeechResult>(
          racers,
          (player, options) => this.generateDayDiscussionSpeech(player, discussionPass, openingMoveByPlayerId, options),
          aiRaceController.signal
        );

        let winner: AiRaceWinner;
        if (pendingHumanInterrupt) {
          const activeHumanInterrupt: PendingHumanDayDiscussionInterrupt = pendingHumanInterrupt;
          const outcome = await Promise.race<
            | { kind: "ai"; result: AiRaceWinner }
            | { kind: "human"; result: DayDiscussionSpeechResult | null }
          >([
            aiRace.then((result): { kind: "ai"; result: AiRaceWinner } => ({ kind: "ai", result })),
            activeHumanInterrupt.promise.then(
              (result): { kind: "human"; result: DayDiscussionSpeechResult | null } => ({ kind: "human", result })
            )
          ]);

          if (outcome.kind === "human") {
            if (pendingHumanInterrupt === activeHumanInterrupt) {
              pendingHumanInterrupt = null;
              humanInterruptState.pending = null;
            }
            if (outcome.result) {
              aiRace.catch(() => undefined);
              aiRaceController.abort();
              active = 0;
              rollbackForHumanInterrupt(activeHumanInterrupt, outcome.result);
              report();
              humanInterruptState.remaining -= 1;
              humanInterruptState.available = false;
              yield outcome.result;
              continue;
            }
            winner = await aiRace;
          } else {
            winner = outcome.result;
          }
        } else {
          winner = await aiRace;
        }

        const acceptedIndex = remainingAi.findIndex((player) => player.id === winner.player.id);
        if (acceptedIndex !== -1) {
          remainingAi.splice(acceptedIndex, 1);
        }
        accepted += 1;
        active = 0;
        report();
        humanInterruptState.available = remainingAi.length > 0;
        yield winner.value;
        if (pendingHumanInterrupt) {
          recordRollbackPoint(pendingHumanInterrupt, winner.value.speech);
        }
      }

      completedNormally = true;
    } finally {
      if (!completedNormally) {
        cancelPendingHumanInterrupt();
      }
    }
  }

  private async requestHumanDayDiscussionInterrupt(
    player: Player,
    discussionPass: number,
    discussionPasses: number,
    remainingInterruptions: number,
    abortSignal: AbortSignal,
    onRequestId: (requestId: string) => void
  ): Promise<DayDiscussionSpeechResult | null> {
    if (!this.humanInput) {
      return null;
    }
    const legalPlayers = this.speechLegalPlayers(player).map(({ id, name }) => ({ id, name }));
    const contextLines = [
      this.nightDeathContextLine(),
      discussionPass <= regularDayDiscussionPasses
        ? this.text(
            `昼議論 ${discussionPass}巡目 / ${discussionPasses}巡。`,
            `昼議論 ${discussionPass}巡目 / ${discussionPasses}巡。`
          )
        : this.text(
            "2巡後に必要な人だけが行う追加発言です。",
            "2巡後に必要な人だけが行う追加発言です。"
          ),
      this.text(
        "直前までの発言に口を挟むなら、疑い・信頼・役職主張への反応・投票前の読みのどれかを短く出してください。",
        "直前までの発言に口を挟むなら、疑い・信頼・役職主張への反応・投票前の読みのどれかを短く出してください。"
      ),
      this.text(
        `この昼に残っている任意発言回数: ${Math.max(0, remainingInterruptions)}回。`,
        `この昼に残っている任意発言回数: ${Math.max(0, remainingInterruptions)}回。`
      ),
      ...renderPublicSpeechDiversityContext(this.lastDiscussion, this.config.language, { excludePlayerId: player.id })
    ];
    const response = await this.requestOptionalHumanInputWithoutTimeout(
      {
        kind: "speech_choice",
        speechMode: "discussion_interrupt",
        nonBlocking: true,
        playerId: player.id,
        playerName: player.name,
        phase: this.phase,
        role: player.role,
        task: this.text("Interrupt the public day discussion.", "昼議論に発言を挟んでください。"),
        context: buildHumanInputContext({
          uiContext: contextLines,
          publicHistory: this.publicHistory,
          privateHistory: this.humanVisiblePrivateHistory(player)
        }),
        allowFreeText: true,
        options: []
      },
      { signal: abortSignal, logLabel: "day discussion interrupt", onRequestId }
    );
    if (!response) {
      return null;
    }
    const customSpeech = await this.humanFreeTextSpeech(response.speech, legalPlayers, abortSignal);
    return customSpeech
      ? { player, speech: this.sanitizeSpeechForPhase(customSpeech, legalPlayers, player), visibleEventId: response.visibleEventId }
      : null;
  }

  private async waitForPendingHumanDayDiscussionInterrupt(
    pending: PendingHumanDayDiscussionInterrupt
  ): Promise<DayDiscussionSpeechResult | null> {
    let timedOut = false;
    let timeout: ReturnType<typeof setNodeTimeout> | null = null;
    const timeoutMs = this.config.humanOptionalInputTimeoutMs ?? defaultHumanOptionalInputTimeoutMs;
    const timeoutWindowStartedAt = Date.now();
    const timeoutPromise = new Promise<null>((resolve) => {
      const schedule = () => {
        const latestActivityAt = pending.requestId
          ? (this.humanInput?.latestInputActivityAt?.({
              requestId: pending.requestId,
              kind: "speech_choice",
              speechMode: "discussion_interrupt"
            }) ?? null)
          : null;
        const deadlineBaseAt =
          latestActivityAt !== null && latestActivityAt > timeoutWindowStartedAt ? latestActivityAt : timeoutWindowStartedAt;
        const delayMs = Math.max(0, timeoutMs - (Date.now() - deadlineBaseAt));
        timeout = setNodeTimeout(() => {
          const currentLatestActivityAt = pending.requestId
            ? (this.humanInput?.latestInputActivityAt?.({
                requestId: pending.requestId,
                kind: "speech_choice",
                speechMode: "discussion_interrupt"
              }) ?? null)
            : null;
          const currentDeadlineBaseAt =
            currentLatestActivityAt !== null && currentLatestActivityAt > timeoutWindowStartedAt
              ? currentLatestActivityAt
              : timeoutWindowStartedAt;
          if (Date.now() - currentDeadlineBaseAt < timeoutMs) {
            schedule();
            return;
          }
          timedOut = true;
          pending.controller.abort();
          resolve(null);
        }, delayMs);
      };
      schedule();
    });

    try {
      const result = await Promise.race([pending.promise, timeoutPromise]);
      if (this.abortSignal?.aborted) {
        throw new Error("Game stream cancelled.");
      }
      if (timedOut) {
        console.warn("[human-input] optional day discussion interrupt timed out; continuing without input.");
      }
      return result;
    } finally {
      if (timeout) {
        clearNodeTimeout(timeout);
      }
      pending.promise.catch(() => undefined);
    }
  }

  // Speculative race over different speakers: the slot/cancel mechanism lives in
  // llm-hedge; the speculative flag and the losers-aborted diagnostic are policy.
  private async firstFinishedSpeechRace<R>(
    players: Player[],
    run: (player: Player, options?: SpeculativeRunOptions) => Promise<R>,
    externalSignal?: AbortSignal
  ): Promise<{ player: Player; value: R }> {
    const { item, value } = await raceCandidates(
      players,
      async (player, ctx) => {
        const mergedAbort = mergeAbortSignals(ctx.signal, externalSignal);
        try {
          return await run(player, { signal: mergedAbort.signal, speculative: true });
        } finally {
          mergedAbort.cleanup();
        }
      },
      {
        onLosersAborted: ({ winner, losers, raceSize }) => {
          this.emitSpeechDiagnostic({
            kind: "speech_race_losers_aborted",
            playerId: winner.id,
            playerName: winner.name,
            speculative: true,
            raceSize,
            abortedPlayerIds: losers.map((player) => player.id)
          });
        }
      }
    );
    return { player: item, value };
  }

  private shouldRaceAiDecision(player: Player): boolean {
    const agent = this.agents.get(player.id) ?? fallbackAgent;
    return (
      this.prefetchConcurrency > 1 &&
      this.config.provider === "llm" &&
      agent.model === this.config.model &&
      agent.model !== "human"
    );
  }

  // Hedged race over redundant copies of the same decision: the slot count is
  // decided here (policy) and the redundancy/cancel mechanism is delegated to
  // llm-hedge.
  private async firstFinishedDecisionRace<R>(
    run: (options?: SpeculativeRunOptions) => Promise<R>,
    raceSlots = this.prefetchConcurrency
  ): Promise<R> {
    const limit = this.normalizedDecisionRaceSlots(raceSlots);
    return hedge((ctx) => run({ signal: ctx.signal, speculative: true }), { slots: limit });
  }

  private normalizedDecisionRaceSlots(raceSlots: number | undefined): number {
    const parsed = Number(raceSlots);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 1;
    }
    return Math.max(1, Math.min(this.prefetchConcurrency, Math.floor(parsed)));
  }

  // Turn a human player's free-text statement into a speech with structured reads.
  // The reads are extracted by the shadow LLM (humanChoiceAgent) interpreting the words
  // in context — no keyword/regex matching — so indirect or name-free phrasing still lands.
  private async humanFreeTextSpeech(
    text: string | undefined,
    legalPlayers: TargetCandidate[] = [],
    abortSignal?: AbortSignal
  ): Promise<AgentSpeech | null> {
    const message = compactHumanSpeech(text, this.config.language);
    if (!message) {
      return null;
    }
    return {
      messages: [message],
      metadata: await this.readHumanSpeechReads(message, legalPlayers, abortSignal)
    };
  }

  private async readHumanSpeechReads(
    message: string,
    legalPlayers: TargetCandidate[],
    abortSignal?: AbortSignal
  ): Promise<SpeechMetadata> {
    const shadow = this.humanChoiceAgent;
    if (!shadow?.readReads || legalPlayers.length === 0) {
      return emptySpeechMetadata();
    }
    try {
      return await shadow.readReads({ message, legalPlayers, abortSignal: abortSignal ?? this.abortSignal });
    } catch (error) {
      if (this.abortSignal?.aborted || abortSignal?.aborted) {
        throw error;
      }
      console.warn(
        `[human-reads] failed to interpret player statement (${
          error instanceof Error ? error.message : String(error)
        }); continuing with no structured reads.`
      );
      return emptySpeechMetadata();
    }
  }

  private applyHumanSpeechInfluence(player: Player, speech: AgentSpeech): AgentSpeech {
    if (!this.isHumanControlledPlayer(player)) {
      return speech;
    }
    const boost = <T extends SpeechMetadata["suspects"][number]>(read: T, minimumWeight: number): T => {
      const baseWeight = typeof read.weight === "number" && Number.isFinite(read.weight) ? read.weight : 0.5;
      return {
        ...read,
        weight: Math.max(minimumWeight, Math.min(1, baseWeight * 1.8))
      };
    };
    return {
      ...speech,
      metadata: {
        ...speech.metadata,
        suspects: speech.metadata.suspects.map((read) => boost(read, 0.95)),
        trusts: speech.metadata.trusts.map((read) => boost(read, 0.9))
      }
    };
  }

  private humanControlledPlayer(): Player | null {
    return this.players.find((player) => player.alive && this.isHumanControlledPlayer(player)) ?? null;
  }

  private humanReadPressures(kind: "suspects" | "trusts"): SocialReadPressure[] {
    const byTarget = new Map<string, SocialReadPressure>();
    for (const record of this.lastDiscussion) {
      const source = this.requirePlayer(record.playerId);
      if (!this.isHumanControlledPlayer(source)) {
        continue;
      }
      for (const read of record.metadata[kind]) {
        const target = this.requirePlayer(read.targetId);
        if (!target.alive) {
          continue;
        }
        const current = byTarget.get(target.id) ?? {
          targetId: target.id,
          targetName: read.targetName ?? target.name,
          reasons: [],
          weight: 0
        };
        current.weight += typeof read.weight === "number" && Number.isFinite(read.weight) ? read.weight : 0.5;
        if (read.reason) {
          current.reasons.push(read.reason);
        }
        byTarget.set(target.id, current);
      }
    }
    return [...byTarget.values()].sort((a, b) => b.weight - a.weight || a.targetName.localeCompare(b.targetName));
  }

  private formatSocialPressures(pressures: SocialReadPressure[]): string {
    return pressures
      .map((pressure) => {
        const reason = pressure.reasons.at(-1);
        return `${pressure.targetName}${reason ? ` (${reason})` : ""}`;
      })
      .join(this.text(", ", "、"));
  }

  private humanInfluenceSignature(suspects: SocialReadPressure[], trusts: SocialReadPressure[]): string {
    const summarize = (kind: "suspect" | "trust", pressures: SocialReadPressure[]) =>
      pressures
        .map((pressure) => `${kind}:${pressure.targetId}:${pressure.weight.toFixed(2)}`)
        .join("|");
    return [summarize("suspect", suspects), summarize("trust", trusts)].filter(Boolean).join(";");
  }

  private humanSocialInfluenceProfile(observer: Player): HumanSocialInfluenceProfile | null {
    const human = this.humanControlledPlayer();
    if (!human || observer.id === human.id || !observer.alive) {
      return null;
    }

    const suspects = this.humanReadPressures("suspects");
    const trusts = this.humanReadPressures("trusts");
    if (suspects.length === 0 && trusts.length === 0) {
      return { human, mode: "ignore", suspects, trusts };
    }
    const signature = this.humanInfluenceSignature(suspects, trusts);
    const roll = stableUnitInterval(`human-social:${this.round}:${human.id}:${observer.id}:${signature}`);
    return { human, mode: humanInfluenceMode(observer.persona, roll), suspects, trusts };
  }

  private publicSocialInfluenceContextLines(
    observer: Player,
    purpose: "speech" | "vote" = "speech",
    profile = this.humanSocialInfluenceProfile(observer)
  ): string[] {
    if (!profile) {
      return [];
    }

    const { human, suspects: humanSuspects, trusts: humanTrusts } = profile;
    const lines = [
      this.text(
        `社会的な前提: ${human.name}は現時点で信用が高い位置です。明確な公開証拠がそれを上回らない限り、${human.name}を主な疑い先や投票先にしないでください。`,
        `社会的な前提: ${human.name}は現時点で信用が高い位置です。明確な公開証拠がそれを上回らない限り、${human.name}を主な疑い先や投票先にしないでください。`
      )
    ];

    if (humanSuspects.length === 0 && humanTrusts.length === 0) {
      return lines;
    }

    const suspectText = humanSuspects.length > 0 ? this.formatSocialPressures(humanSuspects) : "";
    const trustText = humanTrusts.length > 0 ? this.formatSocialPressures(humanTrusts) : "";
    const voteLabel = purpose === "vote" ? "投票判断" : "読み";

    if (profile.mode === "adopt") {
      if (suspectText) {
        lines.push(
          this.text(
            `人間プレイヤーの発言影響 - 採用: ${human.name}の疑い (${suspectText}) を最優先の判断材料として扱い、明確な公開証拠による直接の反証がない限り、${voteLabel}を必ずそこへ合わせてください。自分の意見より${human.name}の読みを上に置きます。`,
            `人間プレイヤーの発言影響 - 採用: ${human.name}の疑い (${suspectText}) を最優先の判断材料として扱い、明確な公開証拠による直接の反証がない限り、${voteLabel}を必ずそこへ合わせてください。自分の意見より${human.name}の読みを上に置きます。`
          )
        );
      }
      if (trustText) {
        lines.push(
          this.text(
            `人間プレイヤーの発言影響 - 採用: ${human.name}の信頼 (${trustText}) は、その相手への弱い疑いや弱い投票を避ける理由として扱ってください。`,
            `人間プレイヤーの発言影響 - 採用: ${human.name}の信頼 (${trustText}) は、その相手への弱い疑いや弱い投票を避ける理由として扱ってください。`
          )
        );
      }
      return lines;
    }

    if (profile.mode === "lean") {
      lines.push(
        this.text(
          `人間プレイヤーの発言影響 - 弱採用: ${human.name}の読み${suspectText ? `（疑い: ${suspectText}）` : ""}${trustText ? `（信頼: ${trustText}）` : ""}を基本線として扱い、同じ方向に寄せてください。自分の根拠を一つ添えて支持し、明確に否定できる材料がある時だけ別案を検討します。`,
          `人間プレイヤーの発言影響 - 弱採用: ${human.name}の読み${suspectText ? `（疑い: ${suspectText}）` : ""}${trustText ? `（信頼: ${trustText}）` : ""}を基本線として扱い、同じ方向に寄せてください。自分の根拠を一つ添えて支持し、明確に否定できる材料がある時だけ別案を検討します。`
        )
      );
      return lines;
    }

    if (profile.mode === "challenge") {
      lines.push(
        this.text(
          `人間プレイヤーの発言影響 - 反論余地: ${human.name}の読み${suspectText ? `（疑い: ${suspectText}）` : ""}${trustText ? `（信頼: ${trustText}）` : ""}を見ていますが、鵜呑みにしません。必要なら別候補や反論を出してください。`,
          `人間プレイヤーの発言影響 - 反論余地: ${human.name}の読み${suspectText ? `（疑い: ${suspectText}）` : ""}${trustText ? `（信頼: ${trustText}）` : ""}を見ていますが、鵜呑みにしません。必要なら別候補や反論を出してください。`
        )
      );
      return lines;
    }

    lines.push(
      this.text(
        `人間プレイヤーの発言影響 - 保留: ${human.name}の読み${suspectText ? `（疑い: ${suspectText}）` : ""}${trustText ? `（信頼: ${trustText}）` : ""}は見えていますが、今は自分の観察と公開証拠を優先してください。無理に同調しないでください。`,
        `人間プレイヤーの発言影響 - 保留: ${human.name}の読み${suspectText ? `（疑い: ${suspectText}）` : ""}${trustText ? `（信頼: ${trustText}）` : ""}は見えていますが、今は自分の観察と公開証拠を優先してください。無理に同調しないでください。`
      )
    );
    return lines;
  }

  private applyHumanVoteInfluence(
    voter: Player,
    decision: TargetDecision,
    candidates: Player[],
    profile: HumanSocialInfluenceProfile | null
  ): TargetDecision {
    if (!profile || this.isHumanControlledPlayer(voter)) {
      return decision;
    }

    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    const humanSuspectTargets = profile.suspects.filter((pressure) => candidateIds.has(pressure.targetId));
    const humanSuspectTarget = humanSuspectTargets[0];
    const humanTrustedIds = new Set(profile.trusts.filter((pressure) => candidateIds.has(pressure.targetId)).map((pressure) => pressure.targetId));
    const humanSuspectIds = new Set(humanSuspectTargets.map((pressure) => pressure.targetId));
    const currentTargetId = decision.targetId;
    const currentTargetsTrustedPlayer = Boolean(currentTargetId && humanTrustedIds.has(currentTargetId));
    const resistsHumanInfluence = voteReasonResistsHumanInfluence(decision.reasonKind);
    const fallbackTarget = () =>
      candidates.find(
        (candidate) =>
          candidate.id !== profile.human.id &&
          !humanTrustedIds.has(candidate.id) &&
          !humanSuspectIds.has(candidate.id) &&
          candidate.id !== currentTargetId
      );

    if (resistsHumanInfluence) {
      return decision;
    }

    if (profile.mode === "adopt" && humanSuspectTarget && currentTargetId !== humanSuspectTarget.targetId) {
      const target = this.requirePlayer(humanSuspectTarget.targetId);
      return {
        ...decision,
        targetId: humanSuspectTarget.targetId,
        reasonKind: "public_suspicion",
        reason: this.text(
          `${profile.human.name}'s public suspicion made ${target.name} the strongest vote candidate.`,
          `${profile.human.name}の公開発言で、${target.name}が最有力の投票候補になりました。`
        )
      };
    }

    if ((profile.mode === "adopt" || profile.mode === "lean") && currentTargetId && currentTargetsTrustedPlayer) {
      const target = humanSuspectTarget ? this.requirePlayer(humanSuspectTarget.targetId) : fallbackTarget();
      if (!target) {
        return decision;
      }
      return {
        ...decision,
        targetId: target.id,
        reasonKind: humanSuspectTarget ? "public_suspicion" : "weak_reason",
        reason: this.text(
          `${profile.human.name}'s trusted player is a poor weak vote, so this vote leans toward ${target.name}.`,
          `${profile.human.name}が信頼した相手への弱い投票は避け、${target.name}へ寄せました。`
        )
      };
    }

    if (profile.mode === "challenge" && currentTargetId && humanSuspectIds.has(currentTargetId)) {
      const alternative = fallbackTarget();
      if (alternative) {
        return {
          ...decision,
          targetId: alternative.id,
          reasonKind: "stance_change",
          reason: this.text(
            `${profile.human.name}'s pressure did not fully convince ${voter.name}, so ${alternative.name} remains the better separate vote.`,
            `${profile.human.name}の圧力にはそのまま乗らず、${alternative.name}を別候補として優先しました。`
          )
        };
      }
    }

    return decision;
  }

  private async generateDayDiscussionSpeech(
    player: Player,
    discussionPass: number,
    openingMoveByPlayerId: Map<string, FirstDayOpeningMoveKind>,
    options: SpeculativeRunOptions = {}
  ): Promise<{ player: Player; speech: AgentSpeech }> {
    const generationRound = this.round;
    const generationPhase = this.phase;
    const openingMoveKind = discussionPass === 1 ? openingMoveByPlayerId.get(player.id) : undefined;
    const openingMove = openingMoveKind ? firstDayOpeningMove(openingMoveKind, this.config.language) : undefined;
    this.ensureWerewolfOpeningDeceptionPlan(player, openingMoveKind);
    const deceptionTask = this.prepareWerewolfDeceptionTask(player);
    const seerDisclosureTask = this.prepareTrueSeerDisclosureTask(player);
    const secretOverride = this.seerDisclosureSecretOverride(seerDisclosureTask, player);
    const contextLines = [
      this.nightDeathContextLine(),
      this.text(
        "疑い、役職主張、情報を全体に向けて話してください。",
        "疑い、役職主張、情報を全体に向けて話してください。"
      ),
      discussionPass <= regularDayDiscussionPasses
        ? this.text(
            `昼議論 ${discussionPass}巡目 / ${regularDayDiscussionPasses}巡。`,
            `昼議論 ${discussionPass}巡目 / ${regularDayDiscussionPasses}巡。`
          )
        : this.text(
            "2巡後に必要な人だけが行う追加発言です。",
            "2巡後に必要な人だけが行う追加発言です。"
          ),
      discussionPass === 1
        ? generationRound === 1
          ? this.text(
              "1巡目: まだ昼の発言はありません。投票理由の残し方、役職主張の扱い、進め方、答えやすい名指し質問など、自分の初期意見を一つ出してください。見えていない反応や矛盾は作らないでください。",
              "1巡目: まだ昼の発言はありません。投票理由の残し方、役職主張の扱い、進め方、答えやすい名指し質問など、自分の初期意見を一つ出してください。見えていない反応や矛盾は作らないでください。"
            )
          : this.text(
              "1巡目: ここまで見えている昼発言に自然につなげたうえで、自分の読み・役職主張の判断・投票寄りの見方のどれかを一つだけ短く出してください。",
              "1巡目: ここまで見えている昼発言に自然につなげたうえで、自分の読み・役職主張の判断・投票寄りの見方のどれかを一つだけ短く出してください。"
            )
        : discussionPass === 2
          ? this.text(
              "2巡目: 必要なら自分への疑いに短く答え、その後に投票前の読みを一つ更新してください。",
              "2巡目: 必要なら自分への疑いに短く答え、その後に投票前の読みを一つ更新してください。"
            )
          : this.text(
              "追加発言: 見えている一番強い疑い・主張・人間プレイヤー発の強い読みのどれかに触れ、投票前の読みを一つだけ出してください。",
              "追加発言: 見えている一番強い疑い・主張・人間プレイヤー発の強い読みのどれかに触れ、投票前の読みを一つだけ出してください。"
            ),
      ...this.seerDisclosureTaskLines(seerDisclosureTask),
      ...this.werewolfDeceptionTaskLines(deceptionTask),
      ...(openingMove
        ? [
            this.isJapanese()
              ? `初日特別モード: ${openingMove.label}。${openingMove.instruction}`
              : `初日特別モード: ${openingMove.label}。${openingMove.instruction}`
          ]
        : []),
      ...this.publicSocialInfluenceContextLines(player, "speech"),
      ...renderPublicSpeechDiversityContext(this.lastDiscussion, this.config.language, { excludePlayerId: player.id })
    ];
    const legalPlayers = this.speechLegalPlayers(player).map(({ id, name }) => ({ id, name }));
    const speechPlan = buildPublicSpeechPlan({
      phase: generationPhase,
      round: generationRound,
      discussionPass,
      players: this.players,
      lastNightDeaths: this.lastNightDeathRecords,
      legalPlayers,
      language: this.config.language,
      speakerId: player.id,
      publicHistory: this.publicHistory,
      previousVotes: this.lastVotes,
      firstDayOpeningMove: openingMove
    });
    const context = this.contextForAt(player, generationPhase, generationRound, contextLines, secretOverride, speechPlan);
    const diagnosticRound = generationRound;
    const diagnosticPhase = generationPhase;
    const speech = await this.safeSpeak(
      player,
      discussionPass <= regularDayDiscussionPasses
        ? this.text("Make a public day discussion statement.", "昼議論で発言してください。")
        : this.text("Make a short public follow-up statement.", "短い追加発言をしてください。"),
      context,
      contextLines,
      options.signal,
      { suppressMemorySideEffects: Boolean(options.speculative), speechPlan, diagnosticRound, diagnosticPhase }
    );
    if (
      seerDisclosureTask &&
      !this.isHumanControlledPlayer(player) &&
      !this.speechSatisfiesTrueSeerDisclosureTask(player, speech, seerDisclosureTask)
    ) {
      const retryContextLines = [...contextLines, this.seerDisclosureRetryLine(seerDisclosureTask)];
      const retryContext = this.contextForAt(player, generationPhase, generationRound, retryContextLines, secretOverride, speechPlan);
      const retrySpeech = await this.safeSpeak(
        player,
        discussionPass <= regularDayDiscussionPasses
          ? this.text("Make a public day discussion statement.", "昼議論で発言してください。")
          : this.text("Make a short public follow-up statement.", "短い追加発言をしてください。"),
        retryContext,
        retryContextLines,
        options.signal,
        { suppressMemorySideEffects: Boolean(options.speculative), speechPlan, diagnosticRound, diagnosticPhase }
      );
      return {
        player,
        speech: this.speechSatisfiesTrueSeerDisclosureTask(player, retrySpeech, seerDisclosureTask)
          ? retrySpeech
          : this.seerDisclosureFallbackSpeech(seerDisclosureTask)
      };
    }
    if (deceptionTask && !this.isHumanControlledPlayer(player) && !this.speechSatisfiesWerewolfDeceptionTask(player, speech, deceptionTask)) {
      const retryContextLines = [...contextLines, this.werewolfDeceptionRetryLine(deceptionTask)];
      const retryContext = this.contextForAt(player, generationPhase, generationRound, retryContextLines, secretOverride, speechPlan);
      const retrySpeech = await this.safeSpeak(
        player,
        discussionPass <= regularDayDiscussionPasses
          ? this.text("Make a public day discussion statement.", "昼議論で発言してください。")
          : this.text("Make a short public follow-up statement.", "短い追加発言をしてください。"),
        retryContext,
        retryContextLines,
        options.signal,
        { suppressMemorySideEffects: Boolean(options.speculative), speechPlan, diagnosticRound, diagnosticPhase }
      );
      return {
        player,
        speech: this.speechSatisfiesWerewolfDeceptionTask(player, retrySpeech, deceptionTask)
          ? retrySpeech
          : this.werewolfDeceptionFallbackSpeech(deceptionTask)
      };
    }
    return { player, speech };
  }

  private getOrStartFirstDayOpeningSpeechPrefetch(
    round: number,
    openingMoveByPlayerId?: Map<string, FirstDayOpeningMoveKind>
  ): DayDiscussionSpeechPrefetch | null {
    if (this.firstDayOpeningSpeechPrefetch?.round === round) {
      return this.firstDayOpeningSpeechPrefetch;
    }
    if (round !== 1 || this.config.provider !== "llm") {
      return null;
    }

    const previousRound = this.round;
    const previousPhase = this.phase;
    this.round = round;
    this.phase = "day_discussion";
    try {
      const speakers = this.daySpeakerOrder();
      const assignedOpeningMoves = openingMoveByPlayerId ?? this.firstDayOpeningMoveAssignments(speakers);
      const openingSpeaker = this.firstAiDayOpeningSpeaker(speakers, assignedOpeningMoves);
      if (!openingSpeaker) {
        return null;
      }

      const promise = this.generateDayDiscussionSpeech(openingSpeaker, 1, assignedOpeningMoves);
      promise.catch(() => undefined);
      this.firstDayOpeningSpeechPrefetch = {
        round,
        openingSpeakerId: openingSpeaker.id,
        openingMoveByPlayerId: assignedOpeningMoves,
        promise
      };
      return this.firstDayOpeningSpeechPrefetch;
    } finally {
      this.round = previousRound;
      this.phase = previousPhase;
    }
  }

  private firstDayWarmupPrefetchConcurrency(): number {
    return Math.max(1, Math.min(this.prefetchConcurrency, Math.max(1, this.prefetchConcurrency - 2)));
  }

  private getOrStartFirstDayWarmupSpeechPrefetch(round: number): DayWarmupSpeechPrefetch | null {
    if (this.firstDayWarmupSpeechPrefetch?.round === round) {
      return this.firstDayWarmupSpeechPrefetch;
    }
    if (this.firstDayWarmupSpeechPrefetch && this.firstDayWarmupSpeechPrefetch.round !== round) {
      this.firstDayWarmupSpeechPrefetch.cancel();
      this.firstDayWarmupSpeechPrefetch = null;
    }
    if (round !== 1 || this.config.provider !== "llm") {
      return null;
    }

    const controller = new AbortController();
    const cancel = () => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    };
    const stream = createBufferedAsyncIterable<{ player: Player; speech: AgentSpeech }>(cancel);
    const speakers = this.daySpeakerOrder();
    const openingMoveByPlayerId = this.firstDayOpeningMoveAssignments(speakers);
    this.firstDayWarmupSpeechPrefetch = { round, openingMoveByPlayerId, stream, cancel };
    void (async () => {
      try {
        for await (const result of this.generateFirstDayWarmupSpeeches(this.firstDayWarmupPrefetchConcurrency(), controller.signal)) {
          stream.push(result);
        }
        stream.close();
        if (!controller.signal.aborted && !this.abortSignal?.aborted) {
          this.getOrStartFirstDayOpeningSpeechPrefetch(round, openingMoveByPlayerId);
        }
      } catch (error) {
        if (controller.signal.aborted || this.abortSignal?.aborted) {
          stream.close();
        } else {
          stream.fail(error);
        }
      }
    })();
    return this.firstDayWarmupSpeechPrefetch;
  }

  private firstAiDayOpeningSpeaker(
    speakers: Player[],
    openingMoveByPlayerId: Map<string, FirstDayOpeningMoveKind>
  ): Player | undefined {
    return speakers.find((speaker) => openingMoveByPlayerId.has(speaker.id) && !this.isHumanControlledPlayer(speaker));
  }

  async *run(): AsyncGenerator<GameEvent> {
    this.throwIfCancelled();
    yield this.emit("game_started", this.text("A new AI werewolf match has started.", "AI人狼の新しい対局を開始しました。"), {
      provider: this.config.provider,
      model: this.config.model || "demo",
      playerCount: this.config.playerCount,
      summaryMode: this.config.summaryMode,
      debugScenario: this.config.debugScenario,
      humanPlayerId: this.config.humanPlayerId,
      prefetchConcurrency: this.prefetchConcurrency
    });

    for (const warning of this.startupWarnings) {
      yield this.emit("warning", warning, {
        provider: this.config.provider,
        fallback: "demo"
      });
    }

    while (!this.winner && this.round < this.config.maxRounds) {
      this.throwIfCancelled();
      this.round += 1;
      // Everything pushed to publicHistory from here on belongs to this round's day discussion.
      this.roundPublicStart = this.publicHistory.length;

      yield* this.runDay();
      this.throwIfCancelled();
      const dayWinner = this.checkVictory();
      if (dayWinner) {
        // The day vote ended the game, so this day-set has no night and no night deaths to recap.
        this.lastNightDeaths = [];
        this.lastNightDeathRecords = [];
        yield await this.emitRoundSummary();
        yield this.finishGame(dayWinner);
        return;
      }
      const dayPersonalLoss = this.checkHumanPersonalLoss();
      if (dayPersonalLoss) {
        this.lastNightDeaths = [];
        this.lastNightDeathRecords = [];
        yield await this.emitRoundSummary();
        yield this.finishGame(dayPersonalLoss);
        return;
      }

      yield* this.runNight();
      this.throwIfCancelled();
      // A day-set is "昼→夜"; recap the whole day (day discussion/vote + that night's deaths) once the night ends.
      yield await this.emitRoundSummary();
      const nightWinner = this.checkVictory();
      if (nightWinner) {
        yield this.finishGame(nightWinner);
        return;
      }
      const nightPersonalLoss = this.checkHumanPersonalLoss();
      if (nightPersonalLoss) {
        yield this.finishGame(nightPersonalLoss);
        return;
      }
    }

    const adjudicated = adjudicateStandardVictory(this.players);
    const adjudicatedWinnerIds = standardCampWinnerIds(this.players, adjudicated);
    const loverResult = checkLoverVictory(this.players, this.ruleState);
    yield this.finishGame(
      loverResult
        ? this.loverVictoryResult(loverResult, adjudicated, adjudicatedWinnerIds)
        : {
            camp: adjudicated,
            winnerCamp: adjudicated,
            winnerIds: adjudicatedWinnerIds,
            winnerCamps: [adjudicated],
            winnerGroups: [{ camp: adjudicated, winnerIds: adjudicatedWinnerIds }],
            reason: this.text(
              `Round limit reached after ${this.config.maxRounds} rounds.`,
              `${this.config.maxRounds}ラウンドの上限に到達しました。`
            )
          }
    );
  }

  private async *runNight(): AsyncGenerator<GameEvent> {
    this.lastNightDeaths = [];
    this.lastNightDeathRecords = [];
    this.lastWerewolfDiscussion = [];
    // lastVotes / lastVoteModifiers are kept until the post-night round summary; runVoting reassigns them each day.
    this.witchState.savedTargetId = null;
    this.witchState.poisonTargetId = null;
    this.guardState.protectedTargetId = null;
    this.trapState.targetId = null;
    this.trapState.trapperId = null;
    this.phase = "night";
    yield this.emit("phase_changed", this.text(`Night ${this.round} begins.`, `第${this.round}夜が始まりました。`));

    const werewolves = this.alivePlayers().filter((player) => player.camp === "werewolf");
    let killTarget: Player | null = null;
    let savedTarget: string | null = null;

    for (const step of createNightActionPlan(this.alivePlayers().map((player) => ({ role: player.role, playerId: player.id })))) {
      if (step.kind === "guard_protect") {
        yield* this.runGuardAction();
      }
      if (step.kind === "werewolf_discussion") {
        yield* this.runWerewolfDiscussion(werewolves);
      }
      if (step.kind === "trap_set") {
        for (const actorId of step.actorIds) {
          yield* this.runTrapperAction(this.requirePlayer(actorId));
        }
      }
      if (step.kind === "werewolf_attack") {
        this.phase = "night";
        const attackResolution = await this.resolveWerewolfAttack(
          werewolves,
          this.progressReporterAt("night", this.round, "werewolf_attack_vote", this.text("Werewolf attack vote", "人狼の襲撃投票"))
        );
        killTarget = attackResolution.target;
        if (killTarget) {
          yield this.emit(
            "system",
            this.werewolfAttackVoteResultMessage(attackResolution),
            this.werewolfAttackVoteResultData(attackResolution),
            undefined,
            killTarget
          );
          yield this.emit(
            "night_action",
            this.text("The werewolves selected a victim.", "人狼は襲撃先を選びました。"),
            { visibility: "private", action: "werewolf_attack" },
            undefined,
            killTarget
          );
        }
      }
      if (step.kind === "seer_check") {
        yield* this.runSeerAction();
      }
      if (step.kind === "witch_action") {
        savedTarget = yield* this.runWitchAction(killTarget);
      }
      if (step.kind === "wolf_beauty_charm") {
        for (const actorId of step.actorIds) {
          yield* this.runWolfBeautyCharmAction(this.requirePlayer(actorId));
        }
      }
    }

    const guardBlockedAttack = Boolean(
      killTarget && savedTarget !== killTarget.id && this.guardState.protectedTargetId === killTarget.id
    );

    if (guardBlockedAttack && killTarget) {
      const guard = this.players.find((player) => player.role === "Guard");
      if (guard) {
        yield this.emit(
          "private_info",
          this.text(
            `${guard.name}'s protection stopped the attack on ${killTarget.name}.`,
            `${guard.name}の護衛が${killTarget.name}への襲撃を防ぎました。`
          ),
          {
            visibility: "private",
            visibleTo: guard.id,
            action: "guard_success",
            protectedTargetId: killTarget.id,
            protectedTargetName: killTarget.name
          },
          guard,
          killTarget
        );
      }
    }

    const trapDeath = this.trapDeathForAttack(killTarget, werewolves);
    if (trapDeath) {
      yield this.trapTriggeredEvent(trapDeath, killTarget);
    }
    const deaths = this.filterProtectedHumanDeathRecords(this.mergeDeathRecords([
      ...createNightDeathRecords({
        werewolfTargetId: killTarget?.id,
        savedTargetId: savedTarget,
        protectedTargetId: this.guardState.protectedTargetId,
        poisonTargetId: this.witchState.poisonTargetId
      }),
      ...(trapDeath ? [trapDeath] : [])
    ]));

    this.phase = "night";
    if (deaths.length === 0) {
      yield this.emit("death", this.text("No one died during the night.", "昨夜は誰も死亡しませんでした。"), { cause: "no_death" });
      return;
    }

    yield* this.resolveDeaths(deaths);
  }

  private async *runWerewolfDiscussion(werewolves: Player[]): AsyncGenerator<GameEvent> {
    const eliminatedAlly = this.lastVoteEliminatedWerewolf();
    if (werewolves.length === 0 || (werewolves.length <= 1 && !eliminatedAlly)) {
      return;
    }

    this.phase = "werewolf_discussion";
    yield this.emit("phase_changed", this.text("The werewolves open a private discussion.", "人狼たちが内通を始めました。"));

    if (eliminatedAlly) {
      yield* this.runWerewolfEliminationReaction(werewolves, eliminatedAlly);
      this.lastVoteEliminatedPlayerId = null;
      if (werewolves.length <= 1) {
        return;
      }
    }

    const speakerOrder = this.werewolfDiscussionSpeakerOrder(werewolves);
    const wolfSpeeches = this.completionOrderAiWithHumanBoundary(
      speakerOrder,
      (wolf) => wolf.id,
      async (wolf, _index, signal) => {
        const targets = this.werewolfAttackTargets();
        const contextLines = [
          this.text(
            `把握している人狼: ${werewolves.map((player) => player.name).join(", ")}。`,
            `把握している人狼: ${werewolves.map((player) => player.name).join(", ")}。`
          ),
          this.text(
            `襲撃候補: ${targets.map((player) => player.name).join(", ")}。`,
            `襲撃候補: ${targets.map((player) => player.name).join(", ")}。`
          ),
          this.text(
            "村人を全排除するため、明日の昼に人間側として演じやすい襲撃先を選んでください。",
            "村人を全排除するため、明日の昼に人間側として演じやすい襲撃先を選んでください。"
          ),
          this.text(
            "人間プレイヤーの人狼仲間が襲撃先を提案した場合は、強いチーム方針として扱い、その提案に直接反応してください。",
            "人間プレイヤーの人狼仲間が襲撃先を提案した場合は、強いチーム方針として扱い、その提案に直接反応してください。"
          ),
          ...this.wolfHistory.slice(-8).map((line) => this.text(`Werewolf chat: ${line}`, `人狼チャット: ${line}`))
        ];
        const context = this.contextFor(wolf, contextLines);
        const speech = await this.safeSpeak(
          wolf,
          this.text(
            "Suggest a night victim and explain how it advances a complete werewolf win.",
            "夜の襲撃先を提案し、人狼陣営の完全勝利にどうつながるか説明してください。"
          ),
          context,
          contextLines,
          signal
        );
        return { wolf, speech };
      },
      this.progressReporter("werewolf_discussion", this.text("Werewolf private discussion", "人狼の内通"))
    );

    for await (const { wolf, speech } of wolfSpeeches) {
      this.lastWerewolfDiscussion.push({
        playerId: wolf.id,
        playerName: wolf.name,
        message: speech.messages.join(" "),
        metadata: speech.metadata
      });
      this.wolfHistory.push(this.formatWerewolfSpeechHistory(wolf, speech));
      for (const [index, message] of speech.messages.entries()) {
        yield this.emit("player_speech", message, speechEventData(speech, message, index, "werewolf"), wolf);
      }
    }
  }

  private async *runWerewolfEliminationReaction(werewolves: Player[], eliminatedAlly: Player): AsyncGenerator<GameEvent> {
    const reactionHistory: string[] = [];
    const speakerOrder = this.werewolfDiscussionSpeakerOrder(werewolves);

    for (const [speakerIndex, wolf] of speakerOrder.entries()) {
      const contextLines = this.werewolfEliminationReactionContextLines(werewolves, eliminatedAlly, reactionHistory);
      const context = this.contextFor(wolf, contextLines);
      const speech = await this.safeSpeak(
        wolf,
        this.text(
          "React briefly to the ally who was eliminated by today's vote before moving on to the attack plan.",
          "今日の投票で処刑された仲間に短く反応してから、次の襲撃相談へつなげてください。"
        ),
        context,
        contextLines,
        undefined,
        { diagnosticPhase: "werewolf_discussion" }
      );
      const historyLine = this.formatWerewolfEliminationReactionHistory(wolf, speech, eliminatedAlly);
      reactionHistory.push(historyLine);
      this.wolfHistory.push(historyLine);
      for (const [index, message] of speech.messages.entries()) {
        yield this.emit(
          "player_speech",
          message,
          speechEventData(speech, message, index, "werewolf", {
            werewolfEliminationReaction: true,
            reactionPass: 1,
            reactionSpeakerIndex: speakerIndex + 1,
            reactionSpeakerCount: speakerOrder.length,
            eliminatedAllyId: eliminatedAlly.id,
            eliminatedAllyName: eliminatedAlly.name,
            eliminatedAllyRole: eliminatedAlly.role
          }),
          wolf
        );
      }
    }
  }

  private werewolfEliminationReactionContextLines(werewolves: Player[], eliminatedAlly: Player, reactionHistory: string[]): string[] {
    const survivors = werewolves.map((player) => `${player.name}（${roleLabel(player.role, this.config.language)}）`).join("、");
    const lines = [
      this.text(
        `${eliminatedAlly.name} (${eliminatedAlly.role}) was eliminated by today's vote.`,
        `${eliminatedAlly.name}（${roleLabel(eliminatedAlly.role, this.config.language)}）が今日の投票で処刑されました。`
      ),
      this.text(
        `Living werewolves now in the night chat: ${werewolves.map((player) => player.name).join(", ")}.`,
        `今夜の人狼相談に残っている仲間: ${survivors}。`
      ),
      this.text(
        "Before choosing the night victim, acknowledge the lost ally once. Keep it short: frustration, resolve, a warning about exposed vote lines, or how the team must adjust. Do not reveal this in public tomorrow.",
        "襲撃先を選ぶ前に、失った仲間へ一度だけ反応してください。悔しさ、立て直し、投票筋への警戒、明日の演技の調整のどれかを短く出します。明日の公開発言ではこの内通を漏らしません。"
      )
    ];
    if (reactionHistory.length > 0) {
      lines.push(
        ...reactionHistory
          .slice(-6)
          .map((line) => this.text(`Earlier ally reaction: ${line}`, `先に出た仲間の反応: ${line}`)),
        this.text(
          "React to the ally lines above without repeating the same wording.",
          "上の仲間の反応に少し触れつつ、同じ言い方を繰り返さないでください。"
        )
      );
    }
    return lines;
  }

  private formatWerewolfEliminationReactionHistory(player: Player, speech: AgentSpeech, eliminatedAlly: Player): string {
    return this.text(
      `${player.name} reacted to ${eliminatedAlly.name}'s vote elimination: ${speech.messages.join(" ")}`,
      `${player.name}が${eliminatedAlly.name}の投票処刑に反応: ${speech.messages.join(" ")}`
    );
  }

  private werewolfDiscussionSpeakerOrder(werewolves: Player[]): Player[] {
    const humanWerewolf = werewolves.find((player) => this.isHumanControlledPlayer(player));
    if (!humanWerewolf) {
      return werewolves;
    }
    return [humanWerewolf, ...werewolves.filter((player) => player.id !== humanWerewolf.id)];
  }

  private formatWerewolfSpeechHistory(player: Player, speech: AgentSpeech): string {
    const parts = [`${player.name}: ${speech.messages.join(" ")}`];
    if (speech.metadata.suspects.length > 0) {
      parts.push(
        this.text(
          `Attack preferences: ${speech.metadata.suspects
            .map((read) => `${this.metadataTargetName(read)}${read.reason ? ` (${read.reason})` : ""}`)
            .join(", ")}`,
          `襲撃希望: ${speech.metadata.suspects
            .map((read) => `${this.metadataTargetName(read)}${read.reason ? `（${read.reason}）` : ""}`)
            .join("、")}`
        )
      );
    }
    if (speech.metadata.trusts.length > 0) {
      parts.push(
        this.text(
          `Keep alive for cover: ${speech.metadata.trusts
            .map((read) => `${this.metadataTargetName(read)}${read.reason ? ` (${read.reason})` : ""}`)
            .join(", ")}`,
          `残して利用したい相手: ${speech.metadata.trusts
            .map((read) => `${this.metadataTargetName(read)}${read.reason ? `（${read.reason}）` : ""}`)
            .join("、")}`
        )
      );
    }
    return parts.join(" ");
  }

  private werewolfAttackDiscussionInfluence(targets: Player[]): VoteModifier[] {
    if (this.config.debugScenario !== "none") {
      return [];
    }
    const legalTargetIds = new Set(targets.map((player) => player.id));
    const influence: VoteModifier[] = [];

    for (const record of this.lastWerewolfDiscussion) {
      const speaker = this.players.find((player) => player.id === record.playerId);
      if (!speaker?.alive || speaker.camp !== "werewolf") {
        continue;
      }

      const scores = new Map<string, number>();
      const addScore = (targetId: string | undefined, amount: number) => {
        if (!targetId || !legalTargetIds.has(targetId) || amount <= 0) {
          return;
        }
        scores.set(targetId, (scores.get(targetId) ?? 0) + amount);
      };

      for (const read of record.metadata.suspects) {
        const weight = typeof read.weight === "number" && Number.isFinite(read.weight) ? Math.max(0, Math.min(1, read.weight)) : 0.5;
        addScore(read.targetId, 1.5 + weight);
      }

      for (const target of targets) {
        addScore(target.id, this.werewolfAttackMentionScore(record.message, target.name));
      }

      const [preferredTargetId, score] =
        [...scores.entries()].sort((a, b) => b[1] - a[1] || this.requirePlayer(a[0]).name.localeCompare(this.requirePlayer(b[0]).name))[0] ??
        [];
      if (!preferredTargetId || !score) {
        continue;
      }

      const humanInfluence = record.playerId === this.config.humanPlayerId;
      influence.push({
        targetId: preferredTargetId,
        count: humanInfluence ? Math.max(5, Math.min(8, Math.ceil(score * 2.5))) : Math.max(1, Math.min(2, Math.ceil(score / 2))),
        sourceId: record.playerId,
        reason: humanInfluence ? "human_werewolf_discussion" : "werewolf_discussion"
      });
    }

    return influence;
  }

  private werewolfAttackMentionScore(message: string, targetName: string): number {
    if (!targetName) {
      return 0;
    }
    const escapedName = escapeRegExp(targetName);
    const windows = message.match(new RegExp(`[^。！？!?\\n]{0,30}${escapedName}[^。！？!?\\n]{0,30}`, "giu")) ?? [];
    if (windows.length === 0) {
      return 0;
    }

    let score = 0;
    for (const window of windows) {
      if (/(?:避け|外し|残し|噛まない|襲撃しない|殺さない|not|avoid|spare|don't|do not|leave)/iu.test(window)) {
        continue;
      }
      score = Math.max(
        score,
        /(?:襲撃|噛|狙|標的|ターゲット|候補|合わせ|殺|消|落と|処理|危険|脅威|kill|attack|victim|target|remove|take out|settle|threat|danger)/iu.test(
          window
        )
          ? 2.5
          : 1
      );
    }
    return score;
  }

  private werewolfAttackInfluenceContextLines(influence: VoteModifier[]): string[] {
    const historyLines = this.wolfHistory.slice(-8).map((line) => this.text(`Werewolf chat: ${line}`, `人狼チャット: ${line}`));
    if (influence.length === 0) {
      return historyLines;
    }

    const byTarget = new Map<string, { count: number; sourceNames: string[] }>();
    for (const modifier of influence) {
      const current = byTarget.get(modifier.targetId) ?? { count: 0, sourceNames: [] };
      current.count += modifier.count;
      if (modifier.sourceId) {
        current.sourceNames.push(this.requirePlayer(modifier.sourceId).name);
      }
      byTarget.set(modifier.targetId, current);
    }
    const pressureText = [...byTarget.entries()]
      .map(([targetId, detail]) => ({
        targetName: this.requirePlayer(targetId).name,
        count: detail.count,
        sourceNames: [...new Set(detail.sourceNames)]
      }))
      .sort((a, b) => b.count - a.count || a.targetName.localeCompare(b.targetName))
      .map((detail) => `${detail.targetName} +${detail.count}${detail.sourceNames.length > 0 ? ` (${detail.sourceNames.join(", ")})` : ""}`)
      .join(this.text(", ", "、"));

    return [
      ...historyLines,
      this.text(
        `Meeting target pressure: ${pressureText}. Treat the strongest target as the team's default, especially when it came from the human player.`,
        `会議での襲撃誘導: ${pressureText}。特に人間プレイヤーから出た提案は、最有力のチーム方針として扱ってください。`
      )
    ];
  }

  private async *runGuardAction(): AsyncGenerator<GameEvent> {
    const guard = this.alivePlayers().find((player) => player.role === "Guard");
    if (!guard || !canUseAbilities(this.ruleState, guard.id)) {
      return;
    }

    this.phase = "guard_action";
    const targets = this.alivePlayers().filter((player) => player.id !== this.guardState.lastProtectedTargetId);
    if (targets.length === 0) {
      return;
    }

    const blocked = this.guardState.lastProtectedTargetId
      ? this.requirePlayer(this.guardState.lastProtectedTargetId).name
      : null;
    const contextLines = [
      this.text(
        "今夜の人狼襲撃から守る生存者を一人選んでください。",
        "今夜の人狼襲撃から守る生存者を一人選んでください。"
      ),
      blocked
        ? this.text(
            `${blocked}は昨夜護衛したため、連続では守れません。`,
            `${blocked}は昨夜護衛したため、連続では守れません。`
          )
        : this.text("連続護衛で除外される対象はいません。", "連続護衛で除外される対象はいません。")
    ];
    const context = this.contextFor(guard, contextLines);
    const decision = await this.raceChooseTarget(guard, this.text("Guard night protection", "騎士の夜護衛"), context, targets, false, contextLines);
    if (!decision.targetId) {
      return;
    }

    const target = this.requirePlayer(decision.targetId);
    this.guardState.protectedTargetId = target.id;
    this.guardState.lastProtectedTargetId = target.id;
    guard.memories.push(
      this.text(
        `Round ${this.round}: protected ${target.name}. Reason: ${decision.reason}`,
        `第${this.round}ラウンド: ${target.name}を護衛。理由: ${decision.reason}`
      )
    );
    yield this.emit(
      "night_action",
      this.text(`${guard.name} protected ${target.name}.`, `${guard.name}が${target.name}を護衛しました。`),
      {
        visibility: "private",
        action: "guard_protect",
        protectedTargetId: target.id,
        protectedTargetName: target.name,
        reason: decision.reason
      },
      guard,
      target
    );
  }

  private async resolveWerewolfAttack(
    werewolves: Player[],
    onProgress = this.progressReporter("werewolf_attack_vote", this.text("Werewolf attack vote", "人狼の襲撃投票"))
  ): Promise<WerewolfAttackResolution> {
    const actionPhase = this.phase;
    const votingWerewolves = werewolves.filter((player) => player.alive && player.camp === "werewolf");
    const targets = this.werewolfAttackTargets();
    if (votingWerewolves.length === 0 || targets.length === 0) {
      return { target: null, votes: [], totals: [], candidates: [], tied: false, randomSelectionReason: null };
    }

    const legalTargetIds = new Set(targets.map((player) => player.id));
    const votesByVoterId = new Map<string, VoteRecord>();
    const discussionInfluence = this.werewolfAttackDiscussionInfluence(targets);
    const influenceContextLines = this.werewolfAttackInfluenceContextLines(discussionInfluence);
    const collectWolfVote = async (wolf: Player, raceSlots = this.prefetchConcurrency, signal?: AbortSignal): Promise<VoteRecord | null> => {
      const contextLines = [
        this.text(
          `Known living werewolves: ${votingWerewolves.map((player) => player.name).join(", ")}.`,
          `把握している生存人狼: ${votingWerewolves.map((player) => player.name).join(", ")}。`
        ),
        ...influenceContextLines,
        this.text("Vote for the player the werewolf team should kill tonight.", "今夜、人狼チームが襲撃する相手に投票してください。")
      ];
      const decision = await this.withPhase(actionPhase, () => {
        const context = this.contextFor(wolf, contextLines);
        return this.raceChooseTarget(wolf, this.text("Werewolf night kill vote", "人狼の夜襲撃投票"), context, targets, false, contextLines, raceSlots, signal);
      });
      return decision.targetId && legalTargetIds.has(decision.targetId)
        ? { voterId: wolf.id, targetId: decision.targetId, reason: decision.reason }
        : null;
    };

    for await (const vote of completionOrderConcurrentDecisionMap(
      votingWerewolves,
      this.prefetchConcurrency,
      (wolf, _index, raceSlots, signal) => collectWolfVote(wolf, raceSlots, signal),
      onProgress
    )) {
      if (vote) {
        votesByVoterId.set(vote.voterId, vote);
      }
    }
    const votes = votingWerewolves.flatMap((wolf) => {
      const vote = votesByVoterId.get(wolf.id);
      return vote ? [vote] : [];
    });

    if (votes.length === 0) {
      return {
        target: sample(targets),
        votes,
        totals: [],
        candidates: [],
        tied: false,
        randomSelectionReason: "no_votes"
      };
    }

    const counts = tallyVotes(votes);
    const candidates = topVoted(counts);
    const tied = candidates.length > 1;
    return {
      target: this.requirePlayer(sample(candidates)),
      votes,
      totals: [...counts.entries()].map(([targetId, count]) => ({ targetId, count })),
      candidates,
      tied,
      randomSelectionReason: tied ? "tie" : null
    };
  }

  private werewolfAttackVoteResultMessage(resolution: WerewolfAttackResolution): string {
    if (!resolution.target) {
      return this.text("No werewolf attack target was selected.", "人狼の襲撃先は選ばれませんでした。");
    }

    const targetName = resolution.target.name;
    if (resolution.randomSelectionReason === "no_votes") {
      return this.text(
        `No valid werewolf attack votes were cast. A random victim was selected, and ${targetName} will be attacked tonight.`,
        `人狼の襲撃投票は有効票がありませんでした。ランダムで襲撃先を決めた結果、${targetName}が襲撃先になりました。`
      );
    }

    const totalsText = this.formatWerewolfAttackVoteTotals(resolution.totals);
    if (resolution.randomSelectionReason === "tie") {
      const candidateNames = resolution.candidates
        .map((candidateId) => this.requirePlayer(candidateId).name)
        .join(this.text(", ", "、"));
      return this.text(
        `Werewolf attack vote totals: ${totalsText}. The top vote was tied between ${candidateNames}, so a random victim was selected and ${targetName} will be attacked tonight.`,
        `人狼の襲撃投票結果は${totalsText}です。最多票が${candidateNames}で並んだため、ランダムで襲撃先を決めた結果、${targetName}が襲撃先になりました。`
      );
    }

    return this.text(
      `人狼の襲撃投票結果は${totalsText}です。最多票の${targetName}を襲撃することが決定しました。`,
      `人狼の襲撃投票結果は${totalsText}です。最多票の${targetName}を襲撃することが決定しました。`
    );
  }

  private werewolfAttackVoteResultData(resolution: WerewolfAttackResolution): Record<string, unknown> {
    return {
      visibility: "werewolf",
      action: "werewolf_attack_vote_result",
      votes: this.voteDetails(resolution.votes),
      totals: resolution.totals.map(({ targetId, count }) => ({
        targetId,
        targetName: this.requirePlayer(targetId).name,
        count
      })),
      candidates: resolution.candidates.map((targetId) => ({
        targetId,
        targetName: this.requirePlayer(targetId).name
      })),
      tied: resolution.tied,
      randomSelectionReason: resolution.randomSelectionReason,
      selectedTargetId: resolution.target?.id ?? null,
      selectedTargetName: resolution.target?.name ?? null
    };
  }

  private formatWerewolfAttackVoteTotals(totals: Array<{ targetId: string; count: number }>): string {
    if (totals.length === 0) {
      return this.text("none", "なし");
    }
    return totals
      .map(({ targetId, count }) =>
        this.text(`${this.requirePlayer(targetId).name} ${count}`, `${this.requirePlayer(targetId).name} ${count}票`)
      )
      .join(this.text(", ", "、"));
  }

  private humanProtectionLastRound(): number {
    return Math.max(0, Math.min(humanProtectionRoundByPlayerCount(this.config.playerCount), this.config.maxRounds - 1));
  }

  private isProtectedHumanPlayer(player: Player): boolean {
    return this.config.humanPlayerId === player.id && this.round <= this.humanProtectionLastRound();
  }

  private isProtectedHumanAttackTarget(player: Player): boolean {
    return this.isProtectedHumanPlayer(player) && player.camp === "village";
  }

  private isProtectedHumanVoteTarget(player: Player): boolean {
    return this.isProtectedHumanPlayer(player);
  }

  private isProtectedHumanNightDeathTarget(player: Player): boolean {
    return this.phase !== "voting" && this.isProtectedHumanAttackTarget(player);
  }

  private filterProtectedHumanDeathRecords(deaths: DeathRecord[]): DeathRecord[] {
    return deaths.filter((death) => !this.isProtectedHumanNightDeathTarget(this.requirePlayer(death.playerId)));
  }

  private werewolfAttackTargets(): Player[] {
    return this.alivePlayers().filter((player) => player.camp !== "werewolf" && !this.isProtectedHumanAttackTarget(player));
  }

  private async prepareSeerAction(): Promise<PreparedTargetAction | null> {
    const seer = this.alivePlayers().find((player) => player.role === "Seer");
    if (!seer || !canUseAbilities(this.ruleState, seer.id)) {
      return null;
    }

    const allTargets = this.alivePlayers().filter((player) => player.id !== seer.id);
    const unchecked = allTargets.filter((player) => !(player.id in seer.seerResults));
    const targets = unchecked.length > 0 ? unchecked : allTargets;
    if (targets.length === 0) {
      return null;
    }

    const contextLines = [
      this.text("今夜占う生存者を一人選んでください。", "今夜占う生存者を一人選んでください。")
    ];
    const decision = await this.withPhase("seer_action", () => {
      const context = this.contextFor(seer, contextLines);
      return this.raceChooseTarget(seer, this.text("Seer identity check", "占い師の判定"), context, targets, false, contextLines);
    });
    if (!decision.targetId) {
      return null;
    }

    const target = this.requirePlayer(decision.targetId);
    return { actor: seer, target, reason: decision.reason };
  }

  private applySeerAction(prepared: PreparedTargetAction | null): GameEvent | null {
    if (!prepared) {
      return null;
    }
    const seer = prepared.actor;
    const target = prepared.target;
    if (!seer.alive || !target.alive || seer.role !== "Seer" || !canUseAbilities(this.ruleState, seer.id)) {
      return null;
    }

    this.phase = "seer_action";
    const resultRound = Math.max(1, this.round);
    const targetCampLabelJa = target.camp === "werewolf" ? "人狼" : "人間側";
    seer.seerResults[target.id] = target.camp;
    seer.seerResultRounds[target.id] = resultRound;
    seer.memories.push(
      this.text(
        `第${resultRound}ラウンド: ${target.name}は${targetCampLabelJa}判定。`,
        `第${resultRound}ラウンド: ${target.name}は${targetCampLabelJa}判定。`
      )
    );
    return this.emit(
      "private_info",
      this.text(
        `${seer.name} learned that ${target.name} is ${target.camp}.`,
        `${seer.name}は${target.name}が${this.campText(target.camp)}だと知りました。`
      ),
      { visibility: "private", visibleTo: seer.id, action: "seer_check", result: target.camp },
      seer,
      target
    );
  }

  private async *runSeerAction(): AsyncGenerator<GameEvent> {
    const event = this.applySeerAction(await this.prepareSeerAction());
    if (event) {
      yield event;
    }
  }

  private async prepareWitchActions(killTarget: Player | null): Promise<PreparedWitchAction[]> {
    const witch = this.alivePlayers().find((player) => player.role === "Witch");
    if (!witch || !canUseAbilities(this.ruleState, witch.id)) {
      return [];
    }

    const actions: PreparedWitchAction[] = [];
    let savedTarget: Player | null = null;

    if (killTarget && this.witchState.savePotion) {
      const contextLines = [
        this.text(
          `${killTarget.name}が今夜人狼に襲撃されます。`,
          `${killTarget.name}が今夜人狼に襲撃されます。`
        ),
        this.text("一度だけ使える救命薬を使うか判断してください。", "一度だけ使える救命薬を使うか判断してください。")
      ];
      const save = await this.withPhase("witch_action", () => {
        const context = this.contextFor(witch, contextLines, {
          witch: {
            savePotion: this.witchState.savePotion,
            poisonPotion: this.witchState.poisonPotion,
            attackedTarget: { id: killTarget.id, name: killTarget.name }
          }
        });
        return this.raceDecide(
          witch,
          this.text(`${killTarget.name}に救命薬を使いますか？`, `${killTarget.name}に救命薬を使いますか？`),
          context,
          contextLines
        );
      });
      if (save) {
        actions.push({ kind: "save", witch, target: killTarget });
        savedTarget = killTarget;
      }
    }

    if (this.witchState.poisonPotion) {
      const poisonTargets = this.alivePlayers().filter(
        (player) => player.id !== witch.id && player.id !== savedTarget?.id && !this.isProtectedHumanNightDeathTarget(player)
      );
      if (poisonTargets.length === 0) {
        return actions;
      }
      const legalPoisonTargetIds = new Set(poisonTargets.map((player) => player.id));
      const contextLines = [
        savedTarget
          ? this.text(
              `${savedTarget.name}に救命薬を使う選択済みです。毒薬も同じ夜に使えます。`,
              `${savedTarget.name}に救命薬を使う選択済みです。毒薬も同じ夜に使えます。`
            )
          : this.text("今夜、一度だけ使える毒薬を使うか、見送るか選べます。", "今夜、一度だけ使える毒薬を使うか、見送るか選べます。"),
        killTarget
          ? this.text(`人狼の襲撃先は${killTarget.name}です。`, `人狼の襲撃先は${killTarget.name}です。`)
          : this.text("人狼の襲撃先は不明です。", "人狼の襲撃先は不明です。")
      ];
      const decision = await this.withPhase("witch_action", () => {
        const context = this.contextFor(witch, contextLines, {
          witch: {
            savePotion: this.witchState.savePotion && !savedTarget,
            poisonPotion: this.witchState.poisonPotion,
            attackedTarget: killTarget ? { id: killTarget.id, name: killTarget.name } : null
          }
        });
        return this.raceChooseTarget(witch, this.text("Witch poison potion", "魔女の毒薬"), context, poisonTargets, true, contextLines);
      });
      if (decision.targetId && legalPoisonTargetIds.has(decision.targetId)) {
        const target = this.requirePlayer(decision.targetId);
        actions.push({ kind: "poison", witch, target, reason: decision.reason });
      }
    }

    return actions;
  }

  private applyWitchActions(prepared: PreparedWitchAction[]): { savedTarget: string | null; events: GameEvent[] } {
    const witch = prepared[0]?.witch;
    if (!witch || !witch.alive || witch.role !== "Witch" || !canUseAbilities(this.ruleState, witch.id)) {
      return { savedTarget: null, events: [] };
    }

    this.phase = "witch_action";
    let savedTarget: string | null = null;
    const events: GameEvent[] = [];

    for (const action of prepared) {
      if (!action.witch.alive || action.witch.role !== "Witch" || !canUseAbilities(this.ruleState, action.witch.id)) {
        continue;
      }

      if (action.kind === "save") {
        if (!action.target.alive || !this.witchState.savePotion) {
          continue;
        }
        this.witchState.savePotion = false;
        this.witchState.savedTargetId = action.target.id;
        savedTarget = action.target.id;
        action.witch.memories.push(
          this.text(`Round ${this.round}: saved ${action.target.name}.`, `第${this.round}ラウンド: ${action.target.name}を救いました。`)
        );
        events.push(
          this.emit(
            "night_action",
            this.text(`${action.witch.name} used the save potion.`, `${action.witch.name}が救命薬を使いました。`),
            { visibility: "private", action: "witch_save", savedTargetId: action.target.id, savedTargetName: action.target.name },
            action.witch,
            action.target
          )
        );
        continue;
      }

      if (!action.target.alive || !this.witchState.poisonPotion) {
        continue;
      }
      this.witchState.poisonPotion = false;
      this.witchState.poisonTargetId = action.target.id;
      action.witch.memories.push(
        this.text(`Round ${this.round}: poisoned ${action.target.name}.`, `第${this.round}ラウンド: ${action.target.name}に毒薬を使いました。`)
      );
      events.push(
        this.emit(
          "night_action",
          this.text(`${action.witch.name} used the poison potion.`, `${action.witch.name}が毒薬を使いました。`),
          {
            visibility: "private",
            action: "witch_poison",
            poisonTargetId: action.target.id,
            poisonTargetName: action.target.name,
            reason: action.reason
          },
          action.witch,
          action.target
        )
      );
    }

    return { savedTarget, events };
  }

  private async *runWitchAction(killTarget: Player | null): AsyncGenerator<GameEvent, string | null> {
    const result = this.applyWitchActions(await this.prepareWitchActions(killTarget));
    for (const event of result.events) {
      yield event;
    }
    return result.savedTarget;
  }

  private async *runWolfBeautyCharmAction(wolfBeauty: Player): AsyncGenerator<GameEvent> {
    if (!wolfBeauty.alive || wolfBeauty.role !== "WolfBeauty" || !canUseAbilities(this.ruleState, wolfBeauty.id)) {
      return;
    }

    const targets = this.alivePlayers().filter(
      (player) => player.id !== wolfBeauty.id && player.camp !== "werewolf" && !this.isProtectedHumanNightDeathTarget(player)
    );
    if (targets.length === 0) {
      return;
    }
    const legalTargetIds = new Set(targets.map((player) => player.id));

    const contextLines = [
      this.text(
        "今夜魅了する生存者を一人選んでください。魅了先は毎晩選び直し、あなたが死亡すると最新の魅了先だけが道連れになります。",
        "今夜魅了する生存者を一人選んでください。魅了先は毎晩選び直し、あなたが死亡すると最新の魅了先だけが道連れになります。"
      )
    ];
    const context = this.contextFor(wolfBeauty, contextLines);
    const decision = await this.raceChooseTarget(
      wolfBeauty,
      this.text("Wolf Beauty charm", "美女狼の魅了"),
      context,
      targets,
      false,
      contextLines
    );
    if (!decision.targetId || !legalTargetIds.has(decision.targetId)) {
      return;
    }

    const target = this.requirePlayer(decision.targetId);
    this.replaceWolfBeautyCharm(wolfBeauty.id, target.id);
    wolfBeauty.memories.push(
      this.text(
        `第${this.round}ラウンド: ${target.name}を魅了。理由: ${decision.reason}`,
        `第${this.round}ラウンド: ${target.name}を魅了。理由: ${decision.reason}`
      )
    );
    yield this.emit(
      "night_action",
      this.text(`${wolfBeauty.name}が${target.name}を魅了しました。`, `${wolfBeauty.name}が${target.name}を魅了しました。`),
      {
        visibility: "private",
        action: "wolf_beauty_charm",
        charmedTargetId: target.id,
        charmedTargetName: target.name,
        reason: decision.reason
      },
      wolfBeauty,
      target
    );
  }

  private replaceWolfBeautyCharm(wolfBeautyId: string, targetId: string): void {
    const players = Object.fromEntries(
      Object.entries(this.ruleState.players).map(([playerId, playerState]) => [
        playerId,
        {
          ...playerState,
          statuses: playerState.statuses.filter((status) => {
            if (playerId === wolfBeautyId && status.kind === "charm_anchor") {
              return false;
            }
            return !(status.kind === "charmed" && status.sourceId === wolfBeautyId);
          })
        }
      ])
    );

    this.ruleState = applyStatusEffects(
      { ...this.ruleState, players },
      [
        {
          playerId: wolfBeautyId,
          addStatuses: [{ kind: "charm_anchor", sourceId: wolfBeautyId, targetId, duration: "game", round: this.round }]
        },
        {
          playerId: targetId,
          addStatuses: [{ kind: "charmed", sourceId: wolfBeautyId, duration: "game", round: this.round }]
        }
      ]
    );
  }

  private async *runTrapperAction(trapper: Player): AsyncGenerator<GameEvent> {
    if (!trapper.alive || trapper.role !== "Trapper" || !canUseAbilities(this.ruleState, trapper.id)) {
      return;
    }

    this.phase = "night";
    const targets = this.alivePlayers().filter((player) => player.id !== trapper.id && !this.isProtectedHumanAttackTarget(player));
    if (targets.length === 0) {
      return;
    }
    const legalTargetIds = new Set(targets.map((player) => player.id));

    const contextLines = [
      this.text(
        "生存者一人に罠を仕掛けるか、見送れます。その相手が今夜人狼に襲撃された場合、襲撃は通常通り処理され、人狼側の一人が罠で死亡します。",
        "生存者一人に罠を仕掛けるか、見送れます。その相手が今夜人狼に襲撃された場合、襲撃は通常通り処理され、人狼側の一人が罠で死亡します。"
      )
    ];
    const context = this.contextFor(trapper, contextLines);
    const decision = await this.raceChooseTarget(trapper, this.text("Trap set", "罠師の罠"), context, targets, true, contextLines);
    if (!decision.targetId || !legalTargetIds.has(decision.targetId)) {
      return;
    }

    const target = this.requirePlayer(decision.targetId);
    this.trapState.targetId = target.id;
    this.trapState.trapperId = trapper.id;
    trapper.memories.push(
      this.text(
        `Round ${this.round}: set a trap on ${target.name}. Reason: ${decision.reason}`,
        `第${this.round}ラウンド: ${target.name}に罠を仕掛けました。理由: ${decision.reason}`
      )
    );
    yield this.emit(
      "night_action",
      this.text(`${trapper.name} set a trap on ${target.name}.`, `${trapper.name}が${target.name}に罠を仕掛けました。`),
      {
        visibility: "private",
        action: "trap_set",
        trappedTargetId: target.id,
        trappedTargetName: target.name,
        reason: decision.reason
      },
      trapper,
      target
    );
  }

  private trapDeathForAttack(killTarget: Player | null, werewolves: Player[]): DeathRecord | null {
    if (!killTarget || this.trapState.targetId !== killTarget.id || !this.trapState.trapperId) {
      return null;
    }
    const trapper = this.players.find((player) => player.id === this.trapState.trapperId);
    if (!trapper?.alive || trapper.role !== "Trapper" || !canUseAbilities(this.ruleState, trapper.id)) {
      return null;
    }
    const trappedWerewolfCandidates = werewolves.filter((player) => player.alive && player.camp === "werewolf");
    if (trappedWerewolfCandidates.length === 0) {
      return null;
    }
    const trappedWerewolf = sample(trappedWerewolfCandidates);
    trapper.memories.push(
      this.text(
        `Round ${this.round}: trap on ${killTarget.name} triggered and caught ${trappedWerewolf.name}.`,
        `第${this.round}ラウンド: ${killTarget.name}への罠が発動し、${trappedWerewolf.name}を巻き込みました。`
      )
    );
    return { playerId: trappedWerewolf.id, cause: "trap", sourceId: trapper.id };
  }

  private trapTriggeredEvent(death: DeathRecord, killTarget: Player | null): GameEvent {
    const trapper = death.sourceId ? this.requirePlayer(death.sourceId) : undefined;
    const trappedWerewolf = this.requirePlayer(death.playerId);
    return this.emit(
      "private_info",
      this.text(
        `${trapper?.name ?? "The trapper"}'s trap triggered on ${killTarget?.name ?? "the attacked player"} and caught ${trappedWerewolf.name}.`,
        `${trapper?.name ?? "罠師"}の罠が${killTarget?.name ?? "襲撃対象"}で発動し、${trappedWerewolf.name}を巻き込みました。`
      ),
      {
        visibility: "private",
        visibleTo: trapper?.id,
        action: "trap_triggered",
        trappedTargetId: killTarget?.id,
        trappedTargetName: killTarget?.name,
        trapDeathId: trappedWerewolf.id,
        trapDeathName: trappedWerewolf.name
      },
      trapper,
      trappedWerewolf
    );
  }

  private mergeDeathRecords(records: DeathRecord[]): DeathRecord[] {
    const byPlayerId = new Map<string, DeathRecord>();
    for (const record of records) {
      const existing = byPlayerId.get(record.playerId);
      if (!existing) {
        byPlayerId.set(record.playerId, record);
        continue;
      }
      byPlayerId.set(record.playerId, {
        ...existing,
        cause: mergeDeathCause(existing.cause, record.cause),
        sourceId: existing.sourceId ?? record.sourceId
      });
    }
    return [...byPlayerId.values()];
  }

  private async *runDay(): AsyncGenerator<GameEvent> {
    const isOpeningLlmRound = this.round === 1 && this.config.provider === "llm";
    const humanInterruptsEnabled = this.humanDayDiscussionInterruptsEnabled();
    const runOpeningWarmup = isOpeningLlmRound;
    const warmupPrefetch = runOpeningWarmup ? this.getOrStartFirstDayWarmupSpeechPrefetch(this.round) : null;
    const cancelWarmupPrefetch = () => {
      if (!warmupPrefetch) {
        return;
      }
      if (this.firstDayWarmupSpeechPrefetch === warmupPrefetch) {
        this.firstDayWarmupSpeechPrefetch = null;
      }
      warmupPrefetch.cancel();
    };
    const speakers = this.daySpeakerOrder();
    const firstDayOpeningMoveByPlayerId = warmupPrefetch?.openingMoveByPlayerId ?? this.firstDayOpeningMoveAssignments(speakers);

    // Before the public day breaks, secret teams meet privately so human special-role players
    // learn their allies. The werewolf face-off runs first, followed by the lover face-off.
    // While these face-offs are displayed, the day-zero warm-up lines are generated first;
    // only after those finish does the first real public day line begin prefetching.
    let faceoffCompleted = !isOpeningLlmRound;
    if (isOpeningLlmRound) {
      try {
        yield* this.runWerewolfFaceoffPass();
        yield* this.runLoverFaceoffPass();
        faceoffCompleted = true;
      } finally {
        if (!faceoffCompleted) {
          cancelWarmupPrefetch();
        }
      }
    }

    this.phase = "day_discussion";
    this.lastDiscussion = [];
    let dayStartConsumed = false;
    try {
      yield this.emit(
        "phase_changed",
        this.text(`Day ${this.round} begins.`, `${this.round}日目の昼が始まりました`)
      );
      dayStartConsumed = true;
    } finally {
      if (!dayStartConsumed) {
        cancelWarmupPrefetch();
      }
    }

    const publishSpeech = (player: Player, speech: AgentSpeech, discussionPass: number, discussionPasses: number): GameEvent[] => {
      const publicSpeech = this.applyWerewolfDeceptionToPublicSpeech(
        player,
        this.applyTrueSeerDisclosureToPublicSpeech(player, this.applyHumanSpeechInfluence(player, speech))
      );
      this.publicHistory.push(this.formatSpeechHistory(player, publicSpeech));
      this.lastDiscussion.push({
        playerId: player.id,
        playerName: player.name,
        message: publicSpeech.messages.join(" "),
        metadata: publicSpeech.metadata
      });
      return publicSpeech.messages.map((message, index) =>
        this.emit(
          "player_speech",
          message,
          speechEventData(publicSpeech, message, index, undefined, {
            discussionPass,
            discussionPasses,
            ...(discussionPass > regularDayDiscussionPasses ? { discussionFollowUp: true } : {})
          }),
          player
        )
      );
    };
    const openingSpeaker = this.firstAiDayOpeningSpeaker(speakers, firstDayOpeningMoveByPlayerId);
    let prefetchedOpeningSpeech: Promise<{ player: Player; speech: AgentSpeech }> | null = null;

    // Keep the "day zero" opening resolves even without the old director layer. They are
    // generated first, then the first real public line begins prefetching; they are not
    // fed back into publicHistory/lastDiscussion and therefore cannot become fake evidence.
    if (runOpeningWarmup) {
      yield* this.runFirstDayWarmupPass(warmupPrefetch);
    }
    this.throwIfCancelled();

    const openingPrefetch = isOpeningLlmRound
      ? (this.firstDayOpeningSpeechPrefetch ??
        this.getOrStartFirstDayOpeningSpeechPrefetch(this.round, firstDayOpeningMoveByPlayerId))
      : null;
    prefetchedOpeningSpeech =
      openingPrefetch && openingSpeaker?.id === openingPrefetch.openingSpeakerId ? openingPrefetch.promise : null;
    if (prefetchedOpeningSpeech) {
      this.firstDayOpeningSpeechPrefetch = null;
    }

    const humanInterruptState: HumanDayDiscussionInterruptState = {
      remaining: maxHumanDayDiscussionInterruptions,
      available: false
    };
    const cancelHumanInterruptState = () => {
      const pending = humanInterruptState.pending;
      if (!pending) {
        return;
      }
      humanInterruptState.pending = null;
      pending.promise.catch(() => undefined);
      pending.controller.abort();
    };
    const consumeHumanInterruptState = async (): Promise<DayDiscussionSpeechResult | null> => {
      const pending = humanInterruptState.pending;
      if (!pending) {
        return null;
      }
      const result = await this.waitForPendingHumanDayDiscussionInterrupt(pending);
      if (humanInterruptState.pending === pending) {
        humanInterruptState.pending = null;
      }
      return result;
    };
    let discussionCompletedNormally = false;

    try {
      for (let discussionPass = 1; discussionPass <= regularDayDiscussionPasses; discussionPass += 1) {
        let passSpeakers = speakers;
        if (discussionPass === 1 && firstDayOpeningMoveByPlayerId.size > 0) {
          if (openingSpeaker) {
            const { player, speech } = await (prefetchedOpeningSpeech ??
              this.generateDayDiscussionSpeech(openingSpeaker, discussionPass, firstDayOpeningMoveByPlayerId));
            for (const event of publishSpeech(player, speech, discussionPass, regularDayDiscussionPasses)) {
              yield event;
            }
            if (humanInterruptsEnabled) {
              humanInterruptState.available = true;
            }
            passSpeakers = speakers.filter((player) => player.id !== openingSpeaker.id);
          }
        }

        const progressReporter = this.progressReporter("day_speech", this.text("昼議論", "昼議論"), {
          pass: discussionPass,
          passes: regularDayDiscussionPasses
        });
        if (humanInterruptsEnabled) {
          for await (const { player, speech } of this.raceAiWithHumanInterrupts(
            passSpeakers,
            discussionPass,
            regularDayDiscussionPasses,
            firstDayOpeningMoveByPlayerId,
            humanInterruptState,
            progressReporter
          )) {
            for (const event of publishSpeech(player, speech, discussionPass, regularDayDiscussionPasses)) {
              yield event;
            }
          }
        } else {
          for await (const { player, speech } of this.raceAiWithHumanLast(
            passSpeakers,
            (player, options) => this.generateDayDiscussionSpeech(player, discussionPass, firstDayOpeningMoveByPlayerId, options),
            progressReporter
          )) {
            for (const event of publishSpeech(player, speech, discussionPass, regularDayDiscussionPasses)) {
              yield event;
            }
          }
        }
      }

      const followUpSpeakers = this.dayDiscussionFollowUpSpeakers(speakers);
      if (followUpSpeakers.length > 0) {
        const progressReporter = this.progressReporter("day_speech", this.text("昼議論の追加発言", "昼議論の追加発言"), {
          pass: followUpDayDiscussionPass,
          passes: followUpDayDiscussionPass
        });
        if (humanInterruptsEnabled) {
          for await (const { player, speech } of this.raceAiWithHumanInterrupts(
            followUpSpeakers,
            followUpDayDiscussionPass,
            followUpDayDiscussionPass,
            firstDayOpeningMoveByPlayerId,
            humanInterruptState,
            progressReporter
          )) {
            for (const event of publishSpeech(player, speech, followUpDayDiscussionPass, followUpDayDiscussionPass)) {
              yield event;
            }
          }
        } else {
          for await (const { player, speech } of this.raceAiWithHumanLast(
            followUpSpeakers,
            (player, options) => this.generateDayDiscussionSpeech(player, followUpDayDiscussionPass, firstDayOpeningMoveByPlayerId, options),
            progressReporter
          )) {
            for (const event of publishSpeech(player, speech, followUpDayDiscussionPass, followUpDayDiscussionPass)) {
              yield event;
            }
          }
        }
      }
      const lateHumanInterrupt = await consumeHumanInterruptState();
      if (lateHumanInterrupt) {
        humanInterruptState.remaining -= 1;
        humanInterruptState.available = false;
        for (const event of publishSpeech(
          lateHumanInterrupt.player,
          lateHumanInterrupt.speech,
          followUpDayDiscussionPass,
          followUpDayDiscussionPass
        )) {
          yield event;
        }
      }
      discussionCompletedNormally = true;
    } finally {
      if (!discussionCompletedNormally) {
        cancelHumanInterruptState();
      }
    }

    yield* this.runVoting();
  }

  // Day runs before night each round, so round 1's day has no preceding night to report.
  private nightDeathContextLine(): string {
    if (this.round <= 1) {
      return this.text("ゲームが始まりました。まだ犠牲者はいません。", "ゲームが始まりました。まだ犠牲者はいません。");
    }
    const deathNames = this.lastNightDeaths.map((id) => this.requirePlayer(id).name);
    return deathNames.length > 0
      ? this.text(`Last night, ${deathNames.join(", ")} died.`, `昨夜、${deathNames.join(", ")}が死亡しました。`)
      : this.text("No one died last night.", "昨夜は誰も死亡しませんでした。");
  }

  private cloneWerewolfDeceptionState(state: WerewolfDeceptionState): WerewolfDeceptionState {
    return {
      claimedRole: state.claimedRole,
      plannedSinceRound: state.plannedSinceRound,
      publiclyClaimed: state.publiclyClaimed,
      claimRound: state.claimRound,
      fakeSeerResults: state.fakeSeerResults.map((result) => ({ ...result }))
    };
  }

  private cloneWerewolfDeceptions(): Map<string, WerewolfDeceptionState> {
    return new Map([...this.werewolfDeceptions.entries()].map(([playerId, state]) => [playerId, this.cloneWerewolfDeceptionState(state)]));
  }

  private restoreWerewolfDeceptions(snapshot: Map<string, WerewolfDeceptionState>): void {
    this.werewolfDeceptions.clear();
    for (const [playerId, state] of snapshot) {
      this.werewolfDeceptions.set(playerId, this.cloneWerewolfDeceptionState(state));
    }
  }

  private cloneSeerDisclosureState(state: SeerDisclosureState): SeerDisclosureState {
    return {
      publiclyClaimed: state.publiclyClaimed,
      claimRound: state.claimRound,
      announcedResultIds: new Set(state.announcedResultIds)
    };
  }

  private cloneSeerDisclosures(): Map<string, SeerDisclosureState> {
    return new Map([...this.seerDisclosures.entries()].map(([playerId, state]) => [playerId, this.cloneSeerDisclosureState(state)]));
  }

  private restoreSeerDisclosures(snapshot: Map<string, SeerDisclosureState>): void {
    this.seerDisclosures.clear();
    for (const [playerId, state] of snapshot) {
      this.seerDisclosures.set(playerId, this.cloneSeerDisclosureState(state));
    }
  }

  private ensureWerewolfOpeningDeceptionPlan(player: Player, openingMoveKind: FirstDayOpeningMoveKind | undefined): void {
    if (player.camp !== "werewolf" || openingMoveKind !== "wolf_fake_role_claim") {
      return;
    }
    this.ensureWerewolfSeerDeceptionState(player, false);
  }

  private ensureWerewolfSeerDeceptionState(player: Player, publiclyClaimed: boolean): WerewolfDeceptionState {
    const existing = this.werewolfDeceptions.get(player.id);
    if (existing) {
      if (publiclyClaimed && !existing.publiclyClaimed) {
        existing.publiclyClaimed = true;
        existing.claimRound = this.round;
      }
      return existing;
    }
    const state: WerewolfDeceptionState = {
      claimedRole: "Seer",
      plannedSinceRound: this.round,
      publiclyClaimed,
      ...(publiclyClaimed ? { claimRound: this.round } : {}),
      fakeSeerResults: []
    };
    this.werewolfDeceptions.set(player.id, state);
    return state;
  }

  private fakeSeerResultTarget(player: Player, state: WerewolfDeceptionState): Player | null {
    const usedTargetIds = new Set(state.fakeSeerResults.map((result) => result.targetId));
    const livingVillageCandidates = this.alivePlayers().filter(
      (candidate) => candidate.id !== player.id && candidate.camp !== "werewolf" && !usedTargetIds.has(candidate.id)
    );
    if (livingVillageCandidates.length > 0) {
      return sample(livingVillageCandidates);
    }
    const anyVillageCandidate = this.players.filter(
      (candidate) => candidate.id !== player.id && candidate.camp !== "werewolf" && !usedTargetIds.has(candidate.id)
    );
    if (anyVillageCandidate.length > 0) {
      return sample(anyVillageCandidate);
    }
    const fallback = this.alivePlayers().filter((candidate) => candidate.id !== player.id && !usedTargetIds.has(candidate.id));
    return fallback.length > 0 ? sample(fallback) : null;
  }

  private ensureFakeSeerResultForRound(player: Player, state: WerewolfDeceptionState, force: boolean): FakeSeerResult | undefined {
    const existing = state.fakeSeerResults.find((result) => result.round === this.round);
    if (existing) {
      return existing;
    }
    const claimRound = state.claimRound ?? state.plannedSinceRound;
    if (!force && this.round <= claimRound) {
      return undefined;
    }
    const target = this.fakeSeerResultTarget(player, state);
    if (!target) {
      return undefined;
    }
    const camp: Camp = target.camp === "werewolf" ? "village" : weightedChance(0.72) ? "werewolf" : "village";
    const result: FakeSeerResult = {
      targetId: target.id,
      targetName: target.name,
      camp,
      round: this.round,
      announced: false
    };
    state.fakeSeerResults.push(result);
    return result;
  }

  private prepareWerewolfDeceptionTask(player: Player): WerewolfDeceptionTask | null {
    if (this.phase !== "day_discussion" || player.camp !== "werewolf") {
      return null;
    }
    const state = this.werewolfDeceptions.get(player.id);
    if (!state || state.claimedRole !== "Seer") {
      return null;
    }
    if (!state.publiclyClaimed) {
      const result = this.round > state.plannedSinceRound ? this.ensureFakeSeerResultForRound(player, state, true) : undefined;
      return { kind: "claim_seer", result };
    }
    const result = this.ensureFakeSeerResultForRound(player, state, false);
    return result && !result.announced ? { kind: "publish_fake_seer_result", result } : null;
  }

  private werewolfDeceptionTaskLines(task: WerewolfDeceptionTask | null): string[] {
    if (!task) {
      return [];
    }
    if (!task.result) {
      return [
        this.text(
          "Secret werewolf deception task: claim Seer in today's public speech. Do not reveal that this is a lie, your allies, or wolf chat.",
          "秘密の人狼偽装タスク: 今日の公開発言で占い師として名乗る。これが嘘であること、人狼仲間、夜相談は絶対に出さない。"
        )
      ];
    }
    const resultLine = `${task.result.targetName}は${this.campText(task.result.camp)}判定`;
    const action =
      task.kind === "claim_seer"
        ? "占い師として名乗り、そのまま偽結果を出す"
        : "占い師主張を継続し、今日の偽結果を出す";
    return [
      this.text(
        `Secret werewolf deception task: ${action}. Fake result to publish as real: ${resultLine}. Do not reveal this is fake.`,
        `秘密の人狼偽装タスク: ${action}。本物の結果として公開する偽結果: ${resultLine}。嘘だとは絶対に言わない。`
      )
    ];
  }

  private seerClaimOtherPlayerNames(player: Player, target?: TargetCandidate): string[] {
    const exempt = new Set([player.name, target?.name].filter((name): name is string => Boolean(name)));
    return this.players.map((candidate) => candidate.name).filter((name) => !exempt.has(name));
  }

  private speechHasOwnSeerClaim(player: Player, text: string): boolean {
    return textHasSpeakerRoleClaimEvidence(text, "Seer", this.config.language, player.name, this.seerClaimOtherPlayerNames(player));
  }

  private speechMentionsCampResult(text: string, result: SeerClaimResult): boolean {
    const targetTokens = [result.targetName, result.targetId].filter((value): value is string => Boolean(value));
    if (targetTokens.length === 0) {
      return false;
    }
    const targetPattern = `(?:${targetTokens
      .map((token) => (/^p\d+$/i.test(token) ? `${escapeRegExp(token)}(?!\\d)` : escapeRegExp(token)))
      .join("|")})`;
    const campPattern =
      result.camp === "werewolf"
        ? "(?:黒|人狼|狼陣営|狼側|狼)(?:判定|結果)|(?:黒|狼陣営|狼側)です|黒"
        : "(?:白|人間側|人間|村側|村人)(?:判定|結果)|(?:白|人間側|村側)です|白";
    return new RegExp(
      `(?:${targetPattern}[^。！？!?\\n]{0,36}(?:${campPattern})|(?:${campPattern})[^。！？!?\\n]{0,36}${targetPattern})`,
      "u"
    ).test(text);
  }

  private inferVisibleSeerResult(player: Player, text: string): SeerClaimResult | null {
    for (const target of this.players.filter((candidate) => candidate.id !== player.id)) {
      const werewolfResult: SeerClaimResult = {
        targetId: target.id,
        targetName: target.name,
        camp: "werewolf",
        round: this.round
      };
      if (this.speechMentionsCampResult(text, werewolfResult)) {
        return werewolfResult;
      }
      const villageResult: SeerClaimResult = {
        targetId: target.id,
        targetName: target.name,
        camp: "village",
        round: this.round
      };
      if (this.speechMentionsCampResult(text, villageResult)) {
        return villageResult;
      }
    }
    return null;
  }

  private upsertSeerClaimMetadata(metadata: SpeechMetadata, result?: SeerClaimResult): SpeechMetadata {
    const claims = [...metadata.claims];
    const existingIndex = claims.findIndex((claim) => claim.type === "role_claim" && claim.role === "Seer");
    const note = result ? `${this.playerNameOrId(result.targetId, result.targetName)}は${this.campText(result.camp)}判定` : "占い師主張";
    if (existingIndex >= 0) {
      const existing = claims[existingIndex];
      claims[existingIndex] = {
        ...existing,
        result: existing.result ?? result,
        note: existing.note ?? note
      };
    } else {
      claims.push({
        type: "role_claim",
        role: "Seer",
        ...(result ? { result } : {}),
        note
      });
    }
    return { ...metadata, claims };
  }

  private addFakeResultToState(state: WerewolfDeceptionState, result: SeerClaimResult, announced: boolean): void {
    const existing = state.fakeSeerResults.find((candidate) => candidate.targetId === result.targetId && candidate.round === result.round);
    if (existing) {
      existing.camp = result.camp;
      existing.announced = existing.announced || announced;
      return;
    }
    state.fakeSeerResults.push({ ...result, announced });
  }

  private speechSatisfiesWerewolfDeceptionTask(player: Player, speech: AgentSpeech, task: WerewolfDeceptionTask | null): boolean {
    if (!task) {
      return true;
    }
    const text = speech.messages.join(" ");
    if (task.result) {
      const resultVisible = this.speechMentionsCampResult(text, task.result);
      return task.kind === "claim_seer" ? this.speechHasOwnSeerClaim(player, text) && resultVisible : resultVisible;
    }
    return this.speechHasOwnSeerClaim(player, text);
  }

  private werewolfDeceptionRetryLine(task: WerewolfDeceptionTask): string {
    if (!task.result) {
      return this.text(
        "The previous draft did not complete the werewolf deception task. Rewrite as a public line where you claim Seer. Do not explain the plan.",
        "前の発言案では人狼の偽装タスクが未達成です。公開発言として占い師を名乗る短い発言に直してください。作戦説明はしません。"
      );
    }
    return this.text(
      `The previous draft did not publish the required fake Seer result. Rewrite as a public Seer line with this result: ${task.result.targetName} is ${task.result.camp}.`,
      `前の発言案では必要な偽占い結果が出ていません。公開の占い師発言として、${task.result.targetName}は${this.campText(task.result.camp)}判定だと短く出してください。`
    );
  }

  private werewolfDeceptionFallbackSpeech(task: WerewolfDeceptionTask): AgentSpeech {
    if (!task.result) {
      const message = this.text(
        "私は占い師です。初日は結果がないので、今日は投票理由の薄い人を見ます",
        "私は占い師です。初日は結果がないので、今日は投票理由の薄い人を見ます"
      );
      return {
        messages: [message],
        metadata: this.upsertSeerClaimMetadata(emptySpeechMetadata())
      };
    }
    const message = this.text(
      `占い師として結果を出します。${task.result.targetName}は${this.campText(task.result.camp)}判定です`,
      `占い師として結果を出します。${task.result.targetName}は${this.campText(task.result.camp)}判定です`
    );
    return {
      messages: [stripJapaneseSpeechTerminalPeriod(message, this.config.language)],
      metadata: this.upsertSeerClaimMetadata(emptySpeechMetadata(), task.result)
    };
  }

  private applyWerewolfDeceptionToPublicSpeech(player: Player, speech: AgentSpeech): AgentSpeech {
    if (player.camp !== "werewolf") {
      return speech;
    }
    const text = speech.messages.join(" ");
    const hasSeerClaim =
      speech.metadata.claims.some((claim) => claim.type === "role_claim" && claim.role === "Seer") ||
      this.speechHasOwnSeerClaim(player, text);
    let state = this.werewolfDeceptions.get(player.id);
    let metadata = speech.metadata;
    if (hasSeerClaim) {
      state = this.ensureWerewolfSeerDeceptionState(player, true);
      metadata = this.upsertSeerClaimMetadata(metadata);
    }
    if (this.round <= 1) {
      return metadata === speech.metadata ? speech : { ...speech, metadata };
    }
    if (!state || state.claimedRole !== "Seer") {
      return metadata === speech.metadata ? speech : { ...speech, metadata };
    }

    const inferredResult = this.inferVisibleSeerResult(player, text);
    if (inferredResult && (hasSeerClaim || /占い|判定/u.test(text))) {
      this.addFakeResultToState(state, inferredResult, true);
      metadata = this.upsertSeerClaimMetadata(metadata, inferredResult);
    }
    for (const result of state.fakeSeerResults) {
      if (this.speechMentionsCampResult(text, result)) {
        result.announced = true;
        metadata = this.upsertSeerClaimMetadata(metadata, result);
      }
    }
    return metadata === speech.metadata ? speech : { ...speech, metadata };
  }

  private trueSeerResults(player: Player): SeerClaimResult[] {
    return Object.entries(player.seerResults)
      .map(([targetId, camp]) => {
        const target = this.requirePlayer(targetId);
        return {
          targetId,
          targetName: target.name,
          camp,
          round: player.seerResultRounds[targetId]
        };
      })
      .sort((left, right) => (left.round ?? 0) - (right.round ?? 0) || left.targetId.localeCompare(right.targetId));
  }

  private ensureSeerDisclosureState(player: Player, publiclyClaimed: boolean): SeerDisclosureState {
    const existing = this.seerDisclosures.get(player.id);
    if (existing) {
      if (publiclyClaimed && !existing.publiclyClaimed) {
        existing.publiclyClaimed = true;
        existing.claimRound = this.round;
      }
      return existing;
    }
    const state: SeerDisclosureState = {
      publiclyClaimed,
      ...(publiclyClaimed ? { claimRound: this.round } : {}),
      announcedResultIds: new Set()
    };
    this.seerDisclosures.set(player.id, state);
    return state;
  }

  private visibleOtherSeerClaimExists(player: Player): boolean {
    const speakerPrefix = new RegExp(`^\\s*${escapeRegExp(player.name)}\\s*:`, "u");
    return (
      this.lastDiscussion.some(
        (record) =>
          record.playerId !== player.id && record.metadata.claims.some((claim) => claim.type === "role_claim" && claim.role === "Seer")
      ) ||
      this.publicHistory.some((line) => !speakerPrefix.test(line) && textHasSeerClaimEvidence(line))
    );
  }

  private trueSeerDisclosureThreshold(player: Player): number {
    switch (player.persona) {
      case "aggressive":
      case "passionate":
        return 0.95;
      case "logical":
        return 0.92;
      case "opportunistic":
      case "empathetic":
        return 0.9;
      case "trickster":
        return 0.88;
      case "cautious":
        return 0.82;
      case "stoic":
        return 0.86;
    }
  }

  private shouldTrueSeerDisclose(player: Player, results: SeerClaimResult[]): boolean {
    if (results.length === 0) {
      return false;
    }
    if (results.some((result) => result.camp === "werewolf")) {
      return true;
    }
    if (this.visibleOtherSeerClaimExists(player)) {
      return true;
    }
    if (results.length >= 2 || this.round >= 3) {
      return true;
    }
    const seed = `${player.id}:${this.round}:true-seer-disclosure:${results.map((result) => `${result.targetId}:${result.camp}`).join(",")}`;
    return stableUnitInterval(seed) < this.trueSeerDisclosureThreshold(player);
  }

  private prepareTrueSeerDisclosureTask(player: Player): SeerDisclosureTask | null {
    if (this.phase !== "day_discussion" || this.round <= 1 || player.role !== "Seer" || !player.alive || this.isHumanControlledPlayer(player)) {
      return null;
    }
    const results = this.trueSeerResults(player);
    if (results.length === 0) {
      return null;
    }
    const state = this.seerDisclosures.get(player.id);
    if (state?.publiclyClaimed) {
      const unannounced = results.filter((result) => !state.announcedResultIds.has(result.targetId));
      return unannounced.length > 0 ? { kind: "publish_seer_results", results: unannounced } : null;
    }
    return this.shouldTrueSeerDisclose(player, results) ? { kind: "claim_seer_with_results", results } : null;
  }

  private seerDisclosureTaskLines(task: SeerDisclosureTask | null): string[] {
    if (!task) {
      return [];
    }
    const resultLine = task.results.map((result) => `${result.targetName}は${this.campText(result.camp)}判定`).join("、");
    if (task.kind === "claim_seer_with_results") {
      return [
        this.text(
          `True Seer disclosure task: claim Seer in today's public speech and publish these real results: ${resultLine}.`,
          `真占い師公開タスク: 今日の公開発言で占い師として名乗り、本物の占い結果を出す。公開する結果: ${resultLine}。`
        )
      ];
    }
    return [
      this.text(
        `True Seer disclosure task: continue your Seer claim and publish these not-yet-public real results: ${resultLine}.`,
        `真占い師公開タスク: 占い師主張を継続し、まだ公開していない本物の占い結果を出す。公開する結果: ${resultLine}。`
      )
    ];
  }

  private seerDisclosureSecretOverride(task: SeerDisclosureTask | null, player: Player): RoleSecretContext {
    if (!task) {
      return {};
    }
    const state = this.seerDisclosures.get(player.id);
    return {
      seerDisclosure: {
        publiclyClaimed: state?.publiclyClaimed ?? false,
        claimRound: state?.claimRound,
        currentResultsToPublish: task.results.map((result) => ({
          targetId: result.targetId,
          targetName: result.targetName ?? result.targetId,
          camp: result.camp,
          round: result.round
        }))
      }
    };
  }

  private speechSatisfiesTrueSeerDisclosureTask(player: Player, speech: AgentSpeech, task: SeerDisclosureTask | null): boolean {
    if (!task) {
      return true;
    }
    const text = speech.messages.join(" ");
    const resultsVisible = task.results.every((result) => this.speechMentionsCampResult(text, result));
    return task.kind === "claim_seer_with_results" ? this.speechHasOwnSeerClaim(player, text) && resultsVisible : resultsVisible;
  }

  private seerDisclosureRetryLine(task: SeerDisclosureTask): string {
    const resultLine = task.results.map((result) => `${result.targetName}は${this.campText(result.camp)}判定`).join("、");
    if (task.kind === "claim_seer_with_results") {
      return this.text(
        `The previous draft did not complete the real Seer disclosure task. Rewrite as a public line where you claim Seer and state: ${resultLine}.`,
        `前の発言案では真占い師の公開タスクが未達成です。公開発言として占い師を名乗り、${resultLine}だと短く出してください。`
      );
    }
    return this.text(
      `The previous draft did not publish the required real Seer result. Rewrite as a public Seer update with: ${resultLine}.`,
      `前の発言案では必要な真占い結果が出ていません。公開の占い師発言として、${resultLine}だと短く出してください。`
    );
  }

  private seerResultSpeechList(results: SeerClaimResult[]): string {
    return results.map((result) => `${this.playerNameOrId(result.targetId, result.targetName)}は${this.campText(result.camp)}判定`).join("、");
  }

  private seerDisclosureFallbackSpeech(task: SeerDisclosureTask): AgentSpeech {
    const resultText = this.seerResultSpeechList(task.results);
    const message =
      task.kind === "claim_seer_with_results"
        ? this.text(
            `ここで占い師を名乗ります。${resultText}です`,
            `ここで占い師を名乗ります。${resultText}です`
          )
        : this.text(
            `占い師として結果を更新します。${resultText}です`,
            `占い師として結果を更新します。${resultText}です`
          );
    return {
      messages: [stripJapaneseSpeechTerminalPeriod(message, this.config.language)],
      metadata: task.results.reduce((metadata, result) => this.upsertSeerClaimMetadata(metadata, result), this.upsertSeerClaimMetadata(emptySpeechMetadata()))
    };
  }

  private applyTrueSeerDisclosureToPublicSpeech(player: Player, speech: AgentSpeech): AgentSpeech {
    if (player.role !== "Seer") {
      return speech;
    }
    const text = speech.messages.join(" ");
    const hasSeerClaim =
      speech.metadata.claims.some((claim) => claim.type === "role_claim" && claim.role === "Seer") ||
      this.speechHasOwnSeerClaim(player, text);
    let state = this.seerDisclosures.get(player.id);
    let metadata = speech.metadata;
    if (hasSeerClaim) {
      state = this.ensureSeerDisclosureState(player, true);
      metadata = this.upsertSeerClaimMetadata(metadata);
    }

    if (this.round > 1) {
      for (const result of this.trueSeerResults(player)) {
        if (this.speechMentionsCampResult(text, result) && (hasSeerClaim || /占い|判定|結果/u.test(text))) {
          state = state ?? this.ensureSeerDisclosureState(player, hasSeerClaim);
          state.announcedResultIds.add(result.targetId);
          metadata = this.upsertSeerClaimMetadata(metadata, result);
        }
      }
    }

    return metadata === speech.metadata ? speech : { ...speech, metadata };
  }

  private firstDayOpeningMoveAssignments(speakers: Player[]): Map<string, FirstDayOpeningMoveKind> {
    if (this.round !== 1 || speakers.length === 0) {
      return new Map();
    }
    // Give every round-one first-pass speaker a distinct opening move so the table
    // covers varied natural topics instead of degenerating into "様子見"/"保留" filler.
    // The werewolf team rolls once for a fake-role opening. When it hits, only one
    // wolf takes the Seer deception slot; 3+ wolf teams always assign exactly one
    // fake-role opener so large games do not randomly have several fake claims or none.
    const assignments = new Map<string, FirstDayOpeningMoveKind>();
    const kinds = [...firstDayOpeningMoveKinds];
    const offset = Math.floor(Math.random() * kinds.length);
    const werewolfSpeakers = speakers.filter((speaker) => speaker.camp === "werewolf");
    const shouldAssignFakeRoleOpener =
      werewolfSpeakers.length >= 3 || (werewolfSpeakers.length > 0 && weightedChance(werewolfFakeRoleOpeningProbability));
    const fakeRoleOpeningSpeakerId =
      shouldAssignFakeRoleOpener ? sample(werewolfSpeakers).id : null;
    let cursor = 0;
    for (const speaker of speakers) {
      if (speaker.id === fakeRoleOpeningSpeakerId) {
        assignments.set(speaker.id, "wolf_fake_role_claim");
        continue;
      }
      assignments.set(speaker.id, kinds[(offset + cursor) % kinds.length]);
      cursor += 1;
    }
    return assignments;
  }

  // Day-1 warm-up: a quick round of AI-only opening resolves. It is a day-zero buffer
  // for perceived LLM latency, not public discussion evidence. Humans are excluded —
  // they join from the first real pass. Every living AI player speaks once.
  // Distinct opening angles so independent intro generations don't all start the same way.
  private firstDayIntroAngles(): string[] {
    return this.isJapanese()
      ? [
          "最初の姿勢をひとことだけ。",
          "短い意気込みから入る。",
          "軽いぼやきや冗談を交えて。",
          "全体への呼びかけから入る。",
          "とにかく端的に、短く。",
          "今日の意気込みをひとこと。",
          "気さくに、ゆるい雰囲気で。",
          "自分の関心事をひとこと添えて。"
        ]
      : [
          "最初の姿勢を一言で出す。",
          "短い意気込みから入る。",
          "軽い冗談かぼやきを混ぜる。",
          "全体への呼びかけから入る。",
          "とにかく端的に、短く。",
          "今日の意気込みをひとこと。",
          "気さくに、ゆるい雰囲気で。",
          "自分の関心事をひとこと添えて。"
        ];
  }

  private async *generateFirstDayWarmupSpeeches(
    concurrency = this.prefetchConcurrency,
    abortSignal?: AbortSignal
  ): AsyncGenerator<{ player: Player; speech: AgentSpeech }> {
    const aiSpeakers = this.daySpeakerOrder().filter((player) => !this.isHumanControlledPlayer(player));
    if (aiSpeakers.length === 0) {
      return;
    }
    const angles = this.firstDayIntroAngles();
    const angleOffset = Math.floor(Math.random() * angles.length);
    const angleByPlayerId = new Map(aiSpeakers.map((player, index) => [player.id, angles[(angleOffset + index) % angles.length]]));
    const reportProgress = this.progressReporterAt(
      "day_discussion",
      this.round,
      "day_speech",
      this.text("Opening resolve before the discussion", "議論前の意気込み")
    );

    for await (const result of completionOrderConcurrentMap(
      aiSpeakers,
      concurrency,
      async (player, _index, taskSignal) => {
        const speech = await this.withPhase("day_discussion", () =>
          this.safeImproviseIntro(player, taskSignal, false, angleByPlayerId.get(player.id))
        );
        return { player, speech };
      },
      reportProgress,
      abortSignal
    )) {
      yield result;
    }
  }

  // First-day opening: before the public day breaks, the werewolf team holds a brief private
  // face-to-face so a human werewolf learns who their allies are (and which special wolf each
  // one is). Secret to the werewolf camp (visibility "werewolf") — villagers never see it.
  // AI wolves use fixed character/role alignment lines, with both speaker order and line variant
  // randomized each time. A human werewolf speaks last through the lightweight
  // werewolf-alignment input, so the player can answer in their own words after seeing the team.
  private async *runWerewolfFaceoffPass(): AsyncGenerator<GameEvent> {
    const werewolves = this.alivePlayers().filter((player) => player.camp === "werewolf");
    // A lone wolf has no allies to meet, and the player already knows their own role.
    if (werewolves.length <= 1) {
      return;
    }
    const aiWerewolves = shuffle(werewolves.filter((player) => !this.isHumanControlledPlayer(player)));
    const humanWerewolf = werewolves.find((player) => this.isHumanControlledPlayer(player));
    if (aiWerewolves.length === 0 && !humanWerewolf) {
      return;
    }

    this.phase = "werewolf_discussion";
    yield this.emit(
      "phase_changed",
      this.text("Before dawn, the werewolves align in private.", "夜明け前、人狼たちが意思を合わせます。"),
      { visibility: "werewolf" }
    );

    const faceoffHistory: string[] = [];
    for (const wolf of aiWerewolves) {
      const speech = this.fixedWerewolfFaceoffSpeech(wolf);
      const historyLine = this.formatWerewolfFaceoffHistory(wolf, speech);
      faceoffHistory.push(historyLine);
      this.wolfHistory.push(historyLine);
      for (const [index, message] of speech.messages.entries()) {
        yield this.emit("player_speech", message, speechEventData(speech, message, index, "werewolf"), wolf);
      }
    }

    if (humanWerewolf) {
      const speech = await this.humanWerewolfFaceoffSpeech(humanWerewolf, werewolves, faceoffHistory);
      const historyLine = this.formatWerewolfFaceoffHistory(humanWerewolf, speech);
      faceoffHistory.push(historyLine);
      this.wolfHistory.push(historyLine);
      for (const [index, message] of speech.messages.entries()) {
        yield this.emit("player_speech", message, speechEventData(speech, message, index, "werewolf"), humanWerewolf);
      }
    }
  }

  private aliveLoverPairs(): Array<[Player, Player]> {
    const pairs: Array<[Player, Player]> = [];
    const seen = new Set<string>();
    for (const lover of this.alivePlayers()) {
      if (seen.has(lover.id)) {
        continue;
      }
      const partnerStatus = playerStatuses(this.ruleState, lover.id, "lover").find((status) => status.targetId);
      if (!partnerStatus?.targetId || seen.has(partnerStatus.targetId)) {
        continue;
      }
      const partner = this.players.find((candidate) => candidate.id === partnerStatus.targetId && candidate.alive);
      if (!partner) {
        continue;
      }
      pairs.push([lover, partner]);
      seen.add(lover.id);
      seen.add(partner.id);
    }
    return pairs;
  }

  // First-day opening: after the werewolf team face-off, each lover pair gets the same
  // private fixed-line reveal so a human Lover sees exactly who their partner is.
  private async *runLoverFaceoffPass(): AsyncGenerator<GameEvent> {
    for (const lovers of this.aliveLoverPairs()) {
      const loverIds = lovers.map((lover) => lover.id);
      const aiLovers = shuffle(lovers.filter((player) => !this.isHumanControlledPlayer(player)));
      const humanLover = lovers.find((player) => this.isHumanControlledPlayer(player));
      if (aiLovers.length === 0 && !humanLover) {
        continue;
      }

      this.phase = "lover_discussion";
      yield this.emit(
        "phase_changed",
        this.text("Before dawn, the lovers recognize each other in private.", "夜明け前、恋人たちが互いを確認します。"),
        { visibility: "lover", loverIds }
      );

      const faceoffHistory: string[] = [];
      for (const lover of aiLovers) {
        const partner = lovers.find((candidate) => candidate.id !== lover.id);
        if (!partner) {
          continue;
        }
        const speech = this.fixedLoverFaceoffSpeech(lover, partner);
        const historyLine = this.formatLoverFaceoffHistory(lover, speech);
        faceoffHistory.push(historyLine);
        this.loverHistory.push(historyLine);
        for (const [index, message] of speech.messages.entries()) {
          yield this.emit("player_speech", message, speechEventData(speech, message, index, "lover", { loverIds }), lover);
        }
      }

      if (humanLover) {
        const partner = lovers.find((candidate) => candidate.id !== humanLover.id);
        if (!partner) {
          continue;
        }
        const speech = await this.humanLoverFaceoffSpeech(humanLover, partner, lovers, faceoffHistory);
        const historyLine = this.formatLoverFaceoffHistory(humanLover, speech);
        faceoffHistory.push(historyLine);
        this.loverHistory.push(historyLine);
        for (const [index, message] of speech.messages.entries()) {
          yield this.emit("player_speech", message, speechEventData(speech, message, index, "lover", { loverIds }), humanLover);
        }
      }
    }
  }

  private async *runFirstDayWarmupPass(prefetch: DayWarmupSpeechPrefetch | null = null): AsyncGenerator<GameEvent> {
    const activePrefetch = prefetch?.round === this.round ? prefetch : null;
    if (activePrefetch === this.firstDayWarmupSpeechPrefetch) {
      this.firstDayWarmupSpeechPrefetch = null;
    }
    const speeches = activePrefetch?.stream ?? this.generateFirstDayWarmupSpeeches();
    for await (const { player, speech } of speeches) {
      for (const [index, message] of speech.messages.entries()) {
        yield this.withPhase("day_discussion", () =>
          this.emit("player_speech", message, speechEventData(speech, message, index, undefined, { warmup: true }), player)
        );
      }
    }
  }

  private dayVoteTimeoutFallbackDecision(voter: Player, targets: Player[], knownVotes: VoteRecord[]): TargetDecision | null {
    const fallbackTarget = targets[0] ?? null;
    if (!fallbackTarget) {
      return null;
    }

    const counts = tallyVotes(knownVotes);
    let selected = fallbackTarget;
    let selectedCount = counts.get(selected.id) ?? 0;
    for (const target of targets.slice(1)) {
      const count = counts.get(target.id) ?? 0;
      if (count > selectedCount) {
        selected = target;
        selectedCount = count;
      }
    }

    const timeoutSeconds = Math.max(0, Math.round(this.dayVoteDecisionTimeoutMs() / 1000));
    return {
      targetId: selected.id,
      reason:
        selectedCount > 0
          ? this.text(
              `${voter.name}'s vote exceeded ${timeoutSeconds} seconds, so it followed the current leading vote for ${selected.name}.`,
              `${voter.name}の投票判断が${timeoutSeconds}秒を超えたため、現在の最多票である${selected.name}に合わせました。`
            )
          : this.text(
              `${voter.name}'s vote exceeded ${timeoutSeconds} seconds, so ${selected.name} was selected as a legal fallback target.`,
              `${voter.name}の投票判断が${timeoutSeconds}秒を超えたため、合法な投票先として${selected.name}を選びました。`
            ),
      reasonKind: "legal_fallback"
    };
  }

  private async *runVoting(): AsyncGenerator<GameEvent> {
    this.phase = "voting";
    this.lastVoteEliminatedPlayerId = null;
    yield this.emit("phase_changed", this.text("Voting begins.", "投票が始まりました。"));

    const votes: VoteRecord[] = [];
    const livingPlayers = this.alivePlayers();
    const voters = livingPlayers.filter((player) => !this.ruleState.players[player.id]?.statuses.some((status) => status.kind === "no_vote"));
    const aiVoteDeadlineAt = Date.now() + Math.max(0, this.dayVoteDecisionTimeoutMs());
    const collectVote = async (
      voter: Player,
      raceSlots = this.prefetchConcurrency,
      signal?: AbortSignal
    ): Promise<DayVoteCollectionResult | null> => {
      const targets = livingPlayers.filter((player) => player.id !== voter.id && !this.isProtectedHumanVoteTarget(player));
      if (targets.length === 0) {
        return null;
      }
      const legalTargetIds = new Set(targets.map((player) => player.id));
      const humanInfluenceProfile = this.humanSocialInfluenceProfile(voter);
      const contextLines = [
        this.nightDeathContextLine(),
        this.text(
          "This is the final decision right before voting after today's public discussion.",
          "これは今日の公開議論後、投票直前の最終判断です。"
        ),
        ...this.publicSocialInfluenceContextLines(voter, "vote", humanInfluenceProfile),
        this.text("Vote for one living player to eliminate.", "処刑する生存者を一人選んで投票してください。")
      ];
      const speechPlan = buildPublicSpeechPlan({
        phase: this.phase,
        round: this.round,
        players: this.players,
        lastNightDeaths: this.lastNightDeathRecords,
        legalPlayers: targets.map(({ id, name }) => ({ id, name })),
        language: this.config.language,
        speakerId: voter.id,
        publicHistory: this.publicHistory,
        previousVotes: this.lastVotes
      });
      const context = this.contextFor(voter, contextLines, {}, speechPlan);
      const timeoutApplies = !this.isHumanControlledPlayer(voter);
      const remainingVoteMs = aiVoteDeadlineAt - Date.now();
      if (timeoutApplies && remainingVoteMs <= 0) {
        return { kind: "timeout", voter, targets };
      }

      const timeoutController = timeoutApplies ? new AbortController() : null;
      const timeoutAbort = timeoutController ? mergeAbortSignals(signal, timeoutController.signal) : null;
      let voteTimedOut = false;
      const timeout =
        timeoutController && remainingVoteMs > 0
          ? setNodeTimeout(() => {
              voteTimedOut = true;
              timeoutController.abort();
            }, remainingVoteMs)
          : null;

      try {
        const decision = await this.raceChooseTarget(
          voter,
          this.text("Day elimination vote", "昼の処刑投票"),
          context,
          targets,
          false,
          contextLines,
          raceSlots,
          timeoutAbort?.signal ?? signal
        );
        const influencedDecision = this.applyHumanVoteInfluence(voter, decision, targets, humanInfluenceProfile);
        return influencedDecision.targetId && legalTargetIds.has(influencedDecision.targetId)
          ? { kind: "decision", voter, decision: influencedDecision }
          : null;
      } catch (error) {
        if (voteTimedOut && !this.abortSignal?.aborted) {
          return { kind: "timeout", voter, targets };
        }
        throw error;
      } finally {
        if (timeout) {
          clearNodeTimeout(timeout);
        }
        timeoutAbort?.cleanup();
      }
    };
    const voteResults = this.completionOrderAiDecisionWithHumanBoundary(
      voters,
      (voter) => voter.id,
      (voter, _index, raceSlots, signal) => collectVote(voter, raceSlots, signal),
      this.progressReporter("day_vote", this.text("Day elimination vote", "昼の処刑投票"))
    );

    const voteResultsByVoterId = new Map<string, { voter: Player; decision: TargetDecision }>();
    const timedOutVoteResultsByVoterId = new Map<string, { voter: Player; targets: Player[] }>();
    for await (const result of voteResults) {
      if (!result) {
        continue;
      }
      if (result.kind === "timeout") {
        timedOutVoteResultsByVoterId.set(result.voter.id, { voter: result.voter, targets: result.targets });
        continue;
      }
      const targetId = result.decision.targetId;
      if (!targetId) {
        continue;
      }
      voteResultsByVoterId.set(result.voter.id, { voter: result.voter, decision: result.decision });
    }

    const actualVoteRecords = [...voteResultsByVoterId.values()].flatMap(({ voter, decision }) =>
      decision.targetId ? [{ voterId: voter.id, targetId: decision.targetId, reason: decision.reason }] : []
    );
    const timeoutFallbackVoteRecords: VoteRecord[] = [];

    for (const voter of voters) {
      const result = voteResultsByVoterId.get(voter.id);
      const timedOutResult = timedOutVoteResultsByVoterId.get(voter.id);
      const timeoutFallbackDecision = timedOutResult
        ? this.dayVoteTimeoutFallbackDecision(
            timedOutResult.voter,
            timedOutResult.targets,
            [...actualVoteRecords, ...timeoutFallbackVoteRecords]
          )
        : null;
      const decision = result?.decision ?? timeoutFallbackDecision;
      const targetId = decision?.targetId;
      if (!decision || !targetId) {
        continue;
      }
      const resultVoter = result?.voter ?? timedOutResult?.voter ?? voter;
      votes.push({ voterId: resultVoter.id, targetId, reason: decision.reason });
      if (timeoutFallbackDecision) {
        timeoutFallbackVoteRecords.push({ voterId: resultVoter.id, targetId, reason: decision.reason });
      }
      const target = this.requirePlayer(targetId);
      resultVoter.memories.push(
        this.text(
          `Round ${this.round}: voted for ${target.name}. Reason: ${decision.reason}`,
          `第${this.round}ラウンド: ${target.name}へ投票。理由: ${decision.reason}`
        )
      );
      yield this.emit(
        "vote_cast",
        this.text(`${resultVoter.name} votes for ${target.name}.`, `${resultVoter.name}が${target.name}に投票しました。`),
        timeoutFallbackDecision
          ? {
              timeoutFallback: true,
              timeoutMs: this.dayVoteDecisionTimeoutMs()
            }
          : {},
        resultVoter,
        target
      );
    }

    const eligibleVotes = filterEligibleVotes(votes, this.ruleState);
    const voteModifiers = voteModifiersFromRuleState(this.ruleState).filter(
      (modifier) => !this.isProtectedHumanVoteTarget(this.requirePlayer(modifier.targetId))
    );
    this.lastVotes = eligibleVotes;
    this.lastVoteModifiers = voteModifiers;
    if (eligibleVotes.length === 0 && voteModifiers.length === 0) {
      yield this.emit("vote_result", this.text("No votes were cast.", "投票はありませんでした。"), { votes: [] });
      this.lastVoteDeathRecords = [];
      this.ruleState = expireStatuses(this.ruleState, "round");
      return;
    }

    const voteResolution = resolveVote(eligibleVotes, voteModifiers);
    this.publicHistory.push(this.formatVoteHistoryLine(eligibleVotes, voteResolution.totals));
    yield this.emit("vote_result", this.text("Vote totals are in.", "投票結果が出ました。"), {
      votes: this.voteDetails(eligibleVotes),
      totals: voteResolution.totals.map(({ targetId, count }) => ({
        targetId,
        targetName: this.requirePlayer(targetId).name,
        count
      }))
    });

    if (!voteResolution.eliminatedId) {
      yield this.emit("vote_result", this.text("The vote is tied, so no one is eliminated.", "投票が同数のため、処刑は行われません。"));
      this.lastVoteDeathRecords = [];
      this.ruleState = expireStatuses(this.ruleState, "round");
      return;
    }

    const eliminated = this.requirePlayer(voteResolution.eliminatedId);
    const elimination = resolveVoteElimination(eliminated.id, this.ruleState);
    this.ruleState = applyStatusEffects(this.ruleState, elimination.effects);
    if (!elimination.eliminated) {
      yield this.emit(
        "vote_result",
        this.text(
          `${eliminated.name} revealed as the Idiot and survived the vote.`,
          `${eliminated.name}は愚者として正体を明かし、処刑を免れました。`
        ),
        { action: "idiot_revealed", targetRole: eliminated.role, cancelledBy: elimination.cancelledBy },
        undefined,
        eliminated
      );
      this.lastVoteDeathRecords = [];
      this.ruleState = expireStatuses(this.ruleState, "round");
      return;
    }

    this.lastVoteEliminatedPlayerId = eliminated.camp === "werewolf" ? eliminated.id : null;
    this.lastVoteDeathRecords = [];
    yield* this.resolveDeaths([{ playerId: eliminated.id, cause: "vote" }]);
    this.ruleState = expireStatuses(this.ruleState, "round");
  }

  private async *resolveDeaths(
    initialDeaths: DeathRecord[],
    blockedTargetIds = new Set<string>(),
    chainDepth = 0
  ): AsyncGenerator<GameEvent> {
    const eligibleInitialDeaths = this.filterProtectedHumanDeathRecords(initialDeaths);
    const deaths = createLinkedDeathRecords(eligibleInitialDeaths, this.ruleState, {
      isAlive: (playerId) => {
        const player = this.requirePlayer(playerId);
        return player.alive && !blockedTargetIds.has(playerId);
      }
    });
    const blocked = new Set([...blockedTargetIds, ...deaths.map((death) => death.playerId)]);

    for (const death of deaths) {
      const player = this.requirePlayer(death.playerId);
      blocked.delete(death.playerId);
      if (!markPlayerDead(player)) {
        continue;
      }
      this.deathRecords.push(death);
      if (this.phase !== "voting") {
        this.lastNightDeaths.push(death.playerId);
        this.lastNightDeathRecords.push(death);
      } else if (death.cause === "vote") {
        this.lastVoteDeathRecords.push(death);
      }
      yield this.emit("death", this.deathMessage(player, death), this.deathEventData(player, death, chainDepth), undefined, player);
      const deathEffects = createDeathResolutionEffects(death, player, this.players);
      for (const effect of deathEffects) {
        this.ruleState = applyStatusEffects(this.ruleState, effect.statusEffects);
        this.ruleState = addVictoryClaims(this.ruleState, effect.victoryClaims);
        if (effect.kind === "elder_penalty") {
          yield this.emit(
            "system",
            this.text(
              `${player.name}'s execution disabled the remaining village special abilities.`,
              `${player.name}の処刑により、残った人間側の特殊能力が無効化されました。`
            ),
            { action: "elder_penalty", elderId: player.id, elderName: player.name }
          );
        }
        if (effect.kind === "neutral_victory_claim") {
          const winnerIds = effect.victoryClaims.flatMap((claim) => claim.winnerIds);
          const winnerRoles = this.victoryRoleSummaries(winnerIds);
          const sourceRole = effect.victoryClaims.find((claim) => claim.sourceId === player.id)?.sourceRole ?? player.role;
          const sourceRoleLabel = this.roleText(sourceRole);
          yield this.emit(
            "system",
            this.text(
              `${player.name}は${sourceRoleLabel}であることが明らかになり、投票処刑で中立勝利条件を満たしました。`,
              `${player.name}は${sourceRoleLabel}であることが明らかになり、投票処刑で中立勝利条件を満たしました。`
            ),
            {
              action: "neutral_victory_claim",
              winnerCamp: "neutral",
              winnerIds,
              winnerRoles,
              sourceId: player.id,
              sourceName: player.name,
              sourceRole,
              sourceRoleLabel,
              revealedRole: sourceRole,
              revealedRoleLabel: sourceRoleLabel
            }
          );
        }
      }
      yield* this.runHunterShot(player, blocked, chainDepth);
    }
  }

  private deathMessage(player: Player, death: DeathRecord): string {
    if (death.cause === "vote") {
      return this.text(`${player.name} was eliminated by vote.`, `${player.name}が投票で処刑されました。`);
    }
    return this.text(`${player.name} died.`, `${player.name}が死亡しました。`);
  }

  private deathEventData(player: Player, death: DeathRecord, chainDepth: number): Record<string, unknown> {
    const source = death.sourceId ? this.requirePlayer(death.sourceId) : null;
    return {
      cause: death.cause,
      targetRole: player.role,
      sourceId: source?.id,
      sourceName: source?.name,
      hunterId: death.cause === "hunter" ? source?.id : undefined,
      hunterName: death.cause === "hunter" ? source?.name : undefined,
      alphaWolfId: death.cause === "alpha_wolf" ? source?.id : undefined,
      alphaWolfName: death.cause === "alpha_wolf" ? source?.name : undefined,
      chainDepth
    };
  }

  private async *runHunterShot(hunter: Player, blockedTargetIds = new Set<string>(), chainDepth = 0): AsyncGenerator<GameEvent> {
    const triggerKind = hunter.role === "AlphaWolf" ? "alpha_wolf_shot" : "hunter_shot";
    if (!canUseAbilities(this.ruleState, hunter.id) || !canUseDeathTrigger(hunter, this.hunterShotsUsed, triggerKind)) {
      return;
    }

    const targets = this.alivePlayers().filter(
      (player) => !blockedTargetIds.has(player.id) && !this.isProtectedHumanNightDeathTarget(player)
    );
    if (targets.length === 0) {
      return;
    }

    this.hunterShotsUsed.add(hunter.id);
    const legalTargetIds = new Set(targets.map((player) => player.id));
    const deathShotRole = hunter.role === "AlphaWolf" ? this.text("α人狼", "α人狼") : this.text("ハンター", "ハンター");
    const contextLines = [
      this.text(
        `あなたは${deathShotRole}として死亡しました。退場前に生存者を一人撃てます。`,
        `あなたは${deathShotRole}として死亡しました。退場前に生存者を一人撃てます。`
      ),
      this.text(
        `撃てる対象: ${targets.map((player) => player.name).join(", ")}。`,
        `撃てる対象: ${targets.map((player) => player.name).join(", ")}。`
      )
    ];
    const context = this.contextFor(hunter, contextLines);
    const action = hunter.role === "AlphaWolf" ? this.text("Alpha Wolf death shot", "α人狼の道連れ") : this.text("Hunter death shot", "ハンターの道連れ");
    const decision = await this.raceChooseTarget(hunter, action, context, targets, false, contextLines);
    if (!decision.targetId || !legalTargetIds.has(decision.targetId)) {
      return;
    }

    const target = this.requirePlayer(decision.targetId);
    if (!target.alive) {
      return;
    }

    const cause = hunter.role === "AlphaWolf" ? "alpha_wolf" : "hunter";
    hunter.memories.push(
      this.text(
        `Round ${this.round}: shot ${target.name}. Reason: ${decision.reason}`,
        `第${this.round}ラウンド: ${target.name}を撃ちました。理由: ${decision.reason}`
      )
    );
    yield* this.resolveDeaths([{ playerId: target.id, cause, sourceId: hunter.id }], blockedTargetIds, chainDepth + 1);
  }

  private victoryRoleSummaries(playerIds: string[]): WinnerRoleSummary[] {
    return [...new Set(playerIds)].map((playerId) => {
      const player = this.requirePlayer(playerId);
      return {
        playerId: player.id,
        playerName: player.name,
        role: player.role
      };
    });
  }

  private formatVictoryRoleSummary(winnerRoles: WinnerRoleSummary[]): string {
    return winnerRoles.map((winner) => `${winner.playerName} (${this.roleText(winner.role)})`).join(", ");
  }

  private formatWinnerGroupLabel(group: WinnerGroup): string {
    if (group.camp === "neutral" && group.winnerRoles?.length) {
      const roleLabels = [...new Set(group.winnerRoles.map((winner) => this.roleText(winner.role)))];
      const labels = isJapaneseLanguage(this.config.language) ? roleLabels.map((label) => `${label}陣営`) : roleLabels;
      return labels.join(isJapaneseLanguage(this.config.language) ? "・" : " + ");
    }
    return this.campText(group.camp);
  }

  private orderedWinnerGroups(groups: WinnerGroup[], primaryCamp: CampId | null = null): WinnerGroup[] {
    if (!primaryCamp) {
      return groups;
    }
    const primary = groups.find((group) => group.camp === primaryCamp);
    return primary ? [primary, ...groups.filter((group) => group !== primary)] : groups;
  }

  private formatWinnerGroups(groups: WinnerGroup[], primaryCamp: CampId | null = null): string {
    const separator = isJapaneseLanguage(this.config.language) ? "・" : " + ";
    return this.orderedWinnerGroups(groups, primaryCamp).map((group) => this.formatWinnerGroupLabel(group)).join(separator);
  }

  private resultWinnerGroups(result: VictoryResult): WinnerGroup[] {
    if (result.winnerGroups?.length) {
      return result.winnerGroups;
    }
    const camp = result.winnerCamp ?? result.camp;
    if (!camp) {
      return [];
    }
    const winnerIds =
      result.winnerIds ?? this.alivePlayers().filter((player) => player.camp === camp).map((player) => player.id);
    return [
      {
        camp,
        winnerIds,
        ...(result.winnerRoles ? { winnerRoles: result.winnerRoles } : {})
      }
    ];
  }

  private loverVictoryResult(
    loverResult: NonNullable<ReturnType<typeof checkLoverVictory>>,
    standardCamp = loverResult.fallbackCamp,
    standardWinnerIds = standardCampWinnerIds(this.players, standardCamp)
  ): VictoryResult {
    const winnerGroups: WinnerGroup[] = [
      { camp: loverResult.camp, winnerIds: loverResult.winnerIds },
      { camp: standardCamp, winnerIds: standardWinnerIds }
    ];
    return {
      camp: standardCamp,
      winnerCamp: loverResult.camp,
      winnerIds: [...new Set(winnerGroups.flatMap((group) => group.winnerIds))],
      winnerCamps: winnerGroups.map((group) => group.camp),
      winnerGroups,
      reason: this.text("Both lovers are alive at game end.", "ゲーム終了時点で恋人2人とも生存しています。")
    };
  }

  private checkHumanPersonalLoss(): VictoryResult | null {
    const human = this.players.find((player) => this.isHumanControlledPlayer(player));
    if (!human || human.alive || human.role !== "Lover") {
      return null;
    }

    return {
      camp: null,
      winnerCamp: null,
      winnerIds: [],
      winnerCamps: [],
      winnerGroups: [],
      personalLossPlayerId: human.id,
      reason: this.text(
        "The human Lover died, so the lover win condition can no longer be met.",
        "人間プレイヤーの恋人が死亡したため、恋人陣営の勝利条件は満たせなくなりました。"
      )
    };
  }

  private checkVictory(): VictoryResult | null {
    const neutralResult = checkNeutralVictory(this.players, this.ruleState);
    const result = checkStandardVictory(this.players);
    if (!neutralResult && !result) {
      return null;
    }

    const loverResult = checkLoverVictory(this.players, this.ruleState);
    if (neutralResult) {
      const winnerRoles = this.victoryRoleSummaries(neutralResult.winnerIds);
      const winnerRoleText = this.formatVictoryRoleSummary(winnerRoles);
      if (loverResult) {
        const winnerGroups: WinnerGroup[] = [
          { camp: neutralResult.camp, winnerIds: neutralResult.winnerIds, winnerRoles },
          { camp: loverResult.camp, winnerIds: loverResult.winnerIds }
        ];
        return {
          camp: loverResult.fallbackCamp,
          winnerCamp: loverResult.camp,
          winnerIds: [...new Set([...neutralResult.winnerIds, ...loverResult.winnerIds])],
          winnerCamps: winnerGroups.map((group) => group.camp),
          winnerGroups,
          winnerRoles,
          reason: this.text(
            `${winnerRoleText} fulfilled a neutral victory condition, and both lovers are alive at game end.`,
            `${winnerRoleText}が中立勝利条件を満たし、ゲーム終了時点で恋人2人とも生存しています。`
          )
        };
      }
      return {
        camp: neutralResult.fallbackCamp,
        winnerCamp: neutralResult.camp,
        winnerIds: neutralResult.winnerIds,
        winnerCamps: [neutralResult.camp],
        winnerGroups: [{ camp: neutralResult.camp, winnerIds: neutralResult.winnerIds, winnerRoles }],
        winnerRoles,
        reason: this.text(
          `${winnerRoleText} fulfilled a neutral victory condition.`,
          `${winnerRoleText}が中立勝利条件を満たしました。`
        )
      };
    }

    if (loverResult) {
      return result ? this.loverVictoryResult(loverResult, result.fallbackCamp, result.winnerIds) : null;
    }

    if (!result) {
      return null;
    }

    if (result.reason === "all_werewolves_eliminated") {
      return {
        camp: "village",
        winnerCamp: "village",
        winnerIds: result.winnerIds,
        winnerCamps: ["village"],
        winnerGroups: [{ camp: "village", winnerIds: result.winnerIds }],
        reason: this.text("All werewolves have been eliminated.", "すべての人狼が排除されました。")
      };
    }
    return {
      camp: "werewolf",
      winnerCamp: "werewolf",
      winnerIds: result.winnerIds,
      winnerCamps: ["werewolf"],
      winnerGroups: [{ camp: "werewolf", winnerIds: result.winnerIds }],
      reason: this.text(
        `Werewolves (${result.counts.werewolf}) equal or outnumber villagers (${result.counts.village}).`,
        `狼陣営の人数(${result.counts.werewolf})が人間側の人数(${result.counts.village})以上になりました。`
      )
    };
  }

  private finishGame(result: VictoryResult): GameEvent {
    this.winner = result.camp;
    this.winnerCamp = result.winnerCamp ?? result.camp ?? null;
    this.winnerGroups = this.resultWinnerGroups(result);
    this.winnerCamps = result.winnerCamps ?? [...new Set(this.winnerGroups.map((group) => group.camp))];
    this.winnerIds = result.winnerIds ?? this.winnerGroups.flatMap((group) => group.winnerIds);
    this.personalLossPlayerId = result.personalLossPlayerId ?? null;
    this.phase = "ended";
    const winnerText = this.formatWinnerGroups(this.winnerGroups, this.winnerCamp);
    const message = winnerText
      ? this.text(`${winnerText} wins. ${result.reason}`, `${winnerText}の勝利です。${result.reason}`)
      : result.reason;
    return this.emit("game_ended", message, {
      winner: result.camp,
      winnerCamp: this.winnerCamp,
      winnerIds: this.winnerIds,
      winnerCamps: this.winnerCamps,
      winnerGroups: this.winnerGroups,
      ...(result.winnerRoles ? { winnerRoles: result.winnerRoles } : {}),
      ...(result.personalLossPlayerId
        ? { outcome: "personal_loss", personalLossPlayerId: result.personalLossPlayerId }
        : {}),
      reason: result.reason
    });
  }

  private humanVisiblePrivateHistory(player: Player): string[] {
    const roleNotes: string[] = [];

    if (player.role === "Lover") {
      const partnerStatus = playerStatuses(this.ruleState, player.id, "lover").find((status) => status.targetId);
      if (partnerStatus?.targetId) {
        const partner = this.requirePlayer(partnerStatus.targetId);
        roleNotes.push(
          this.text(
            `自分だけの役職情報: 恋人の相方は${partner.name}です（${partner.alive ? "生存" : "死亡"}）。`,
            `自分だけの役職情報: 恋人の相方は${partner.name}です（${partner.alive ? "生存" : "死亡"}）。`
          )
        );
      }
    }

    if (player.role === "Jester") {
      roleNotes.push(
        this.text(
          "自分だけの役職情報: あなたは道化師です。昼の投票で処刑されると単独勝利です。",
          "自分だけの役職情報: あなたは道化師です。昼の投票で処刑されると単独勝利です。"
        )
      );
    }

    return roleNotes.length > 0 ? [...player.memories, ...roleNotes] : player.memories;
  }

  private roleBreakdownUiLine(): string {
    const breakdown = this.roleBreakdown();
    const summary = breakdown
      .map((entry) => {
        const label = roleLabel(entry.role, this.config.language);
        return this.isJapanese() ? `${label}${entry.count}人` : entry.count === 1 ? label : `${label} x${entry.count}`;
      })
      .join(this.isJapanese() ? "、" : ", ");
    return this.text(`配役表: ${summary}。`, `配役表: ${summary}。`);
  }

  private uiContextWithRoleBreakdown(uiContext: string[] = []): string[] {
    return [...uiContext, this.roleBreakdownUiLine()];
  }

  private async safeSpeak(
    player: Player,
    task: string,
    context: string,
    uiContext: string[] = [],
    abortSignal?: AbortSignal,
    options: {
      suppressMemorySideEffects?: boolean;
      speechPlan?: PublicSpeechPlan;
      agentOverride?: Agent;
      diagnosticRound?: number;
      diagnosticPhase?: Phase;
    } = {}
  ): Promise<AgentSpeech> {
    this.throwIfCancelled();
    const agent = options.agentOverride ?? this.agents.get(player.id) ?? fallbackAgent;
    const legalPlayers = this.speechLegalPlayers(player).map(({ id, name }) => ({ id, name }));
    const privateHistory = agent.model === "human" ? this.humanVisiblePrivateHistory(player) : player.memories;
    const visibleUiContext = agent.model === "human" ? this.uiContextWithRoleBreakdown(uiContext) : uiContext;
    const requestAbort = mergeAbortSignals(this.abortSignal, abortSignal);
    const requestAbortSignal = requestAbort.signal;
    const input = {
      player,
      phase: this.phase,
      task,
      context,
      uiContext: visibleUiContext,
      knownPlayers: this.players.map(({ id, name }) => ({ id, name })),
      legalPlayers,
      speechPlan: options.speechPlan,
      publicHistory: this.publicHistory,
      privateHistory,
      abortSignal: requestAbortSignal
    };
    if (agent.model === "human") {
      try {
        return await this.humanChoiceSpeak(player, input, legalPlayers);
      } finally {
        requestAbort.cleanup();
      }
    }
    const diagnosticBase = {
      playerId: player.id,
      playerName: player.name,
      provider: this.config.provider,
      model: agent.model,
      speculative: Boolean(options.suppressMemorySideEffects),
      speechPlanReviewEnabled: false,
      speechPlanRequiresForwardMove: Boolean(options.speechPlan?.requiresForwardMove)
    };
    const diagnosticRound = options.diagnosticRound ?? this.round;
    const diagnosticPhase = options.diagnosticPhase ?? this.phase;
    const startedAt = Date.now();
    let attempts = 0;
    const emitSpeechAttemptDiagnostic = (diagnostic: Omit<SpeechGenerationDiagnostic, "createdAt" | "round" | "phase">) => {
      this.emitSpeechDiagnosticAt(diagnosticRound, diagnosticPhase, {
        ...diagnosticBase,
        durationMs: Date.now() - startedAt,
        ...diagnostic
      });
    };
    const publishesInvalidFirstDaySeerResult = (candidate: AgentSpeech) =>
      diagnosticPhase === "day_discussion" &&
      diagnosticRound <= 1 &&
      textHasCampResultEvidence(candidate.messages.join(" ")) &&
      /占い|判定|結果/u.test(candidate.messages.join(" "));
    emitSpeechAttemptDiagnostic({ kind: "speech_started" });
    try {
      attempts += 1;
      const speech = this.sanitizeSpeechForPhase(await agent.speak(input), legalPlayers, player);
      if (requestAbortSignal?.aborted) {
        throw new Error("Speech request cancelled.");
      }

      const outputReview = reviewJapaneseOutput(speech.messages.join(" "), this.config.language);
      if (!outputReview.ok) {
        const revisionHint = this.japaneseSpeechReviewHint(outputReview.issues);
        emitSpeechAttemptDiagnostic({
          kind: "speech_review_rejected",
          attempts,
          issues: outputReview.issues,
          styleIssues: outputReview.issues,
          revisionHint
        });
        if (!options.suppressMemorySideEffects) {
          console.warn(
            `[speech-review] ${player.name}: ${outputReview.issues.join(", ")} — retrying once. Original: "${speech.messages
              .join(" ")
              .substring(0, 120)}…"`
          );
        }
        this.throwIfCancelled();
        if (requestAbortSignal?.aborted) {
          throw new Error("Speech request cancelled.");
        }

        attempts += 1;
        const retryInput: AgentSpeechInput = {
          ...input,
          context: [input.context, "", `直前の生成発言に修正が必要です。${revisionHint}`].join("\n")
        };
        const retrySpeech = this.sanitizeSpeechForPhase(await agent.speak(retryInput), legalPlayers, player);
        if (requestAbortSignal?.aborted) {
          throw new Error("Speech request cancelled.");
        }
        const retryReview = reviewJapaneseOutput(retrySpeech.messages.join(" "), this.config.language);
        if (retryReview.ok) {
          emitSpeechAttemptDiagnostic({ kind: "speech_retry_accepted", attempts, issues: [], styleIssues: [] });
          emitSpeechAttemptDiagnostic({ kind: "speech_completed", attempts, retried: true, reviewOk: true });
          return retrySpeech;
        }

        emitSpeechAttemptDiagnostic({
          kind: "speech_retry_rejected",
          attempts,
          issues: retryReview.issues,
          styleIssues: retryReview.issues
        });
        if (!options.suppressMemorySideEffects) {
          console.warn(
            `[speech-review] ${player.name}: retry still has issues (${retryReview.issues.join(
              ", "
            )}). Using simple Japanese fallback.`
          );
        }
        const fallback = this.sanitizeSpeechForPhase(buildSimpleFallbackSpeech(input, this.config.language), legalPlayers, player);
        const fallbackReview = reviewJapaneseOutput(fallback.messages.join(" "), this.config.language);
        emitSpeechAttemptDiagnostic({ kind: "speech_completed", attempts, retried: true, reviewOk: fallbackReview.ok });
        return fallback;
      }

      if (publishesInvalidFirstDaySeerResult(speech)) {
        const issues = ["first-day Seer result is not allowed"];
        emitSpeechAttemptDiagnostic({
          kind: "speech_review_rejected",
          attempts,
          issues,
          revisionHint: this.text(
            "First day has no Seer results. Rewrite without any target name plus alignment result.",
            "初日昼には占い結果はありません。対象名と判定を出さない短い発言に直してください。"
          )
        });
        attempts += 1;
        const retryInput: AgentSpeechInput = {
          ...input,
          context: [
            input.context,
            "",
            this.text(
              "First day has no Seer results. Do not state any target name with a village/werewolf result.",
              "初日昼には占い結果はありません。本物の占い師も占い師騙りも、対象名と判定を出しません。結果なしの短い発言だけにしてください。"
            )
          ].join("\n")
        };
        const retrySpeech = this.sanitizeSpeechForPhase(await agent.speak(retryInput), legalPlayers, player);
        if (requestAbortSignal?.aborted) {
          throw new Error("Speech request cancelled.");
        }
        const retryOutputReview = reviewJapaneseOutput(retrySpeech.messages.join(" "), this.config.language);
        if (retryOutputReview.ok && !publishesInvalidFirstDaySeerResult(retrySpeech)) {
          emitSpeechAttemptDiagnostic({ kind: "speech_retry_accepted", attempts, issues: [] });
          emitSpeechAttemptDiagnostic({ kind: "speech_completed", attempts, retried: true, reviewOk: true });
          return retrySpeech;
        }

        emitSpeechAttemptDiagnostic({
          kind: "speech_retry_rejected",
          attempts,
          issues: retryOutputReview.ok ? issues : [...issues, ...retryOutputReview.issues],
          styleIssues: retryOutputReview.issues
        });
        const fallback = this.sanitizeSpeechForPhase(buildSimpleFallbackSpeech(input, this.config.language), legalPlayers, player);
        emitSpeechAttemptDiagnostic({ kind: "speech_completed", attempts, retried: true, reviewOk: true });
        return fallback;
      }

      emitSpeechAttemptDiagnostic({ kind: "speech_completed", attempts, retried: false });
      return speech;
    } catch (error) {
      if (this.abortSignal?.aborted || requestAbortSignal?.aborted) {
        emitSpeechAttemptDiagnostic({
          kind: "speech_aborted",
          attempts,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
      emitSpeechAttemptDiagnostic({
        kind: "speech_failed",
        attempts,
        error: error instanceof Error ? error.message : String(error)
      });
      if (!options.suppressMemorySideEffects) {
        const note = llmErrorMemoryNote("speech", error);
        console.warn(`[llm-error] speech ${player.id} ${this.phase}: ${note.english}`);
        player.memories.push(this.text(note.english, note.japanese));
      }
      if (!shouldFallbackFromLlmError(agent, error)) {
        throw error;
      }
      return this.sanitizeSpeechForPhase(buildSimpleFallbackSpeech(input, this.config.language), legalPlayers, player);
    } finally {
      requestAbort.cleanup();
    }
  }

  private simpleSpeechFallback(
    input: AgentSpeechInput,
    _legalPlayers: TargetCandidate[],
    _speechPlan?: PublicSpeechPlan
  ): AgentSpeech {
    void _legalPlayers;
    void _speechPlan;
    return buildSimpleFallbackSpeech(input, this.config.language);
  }

  // Generates a single short day-1 warm-up resolve for one player. It is just an
  // opening line, so it stays separate from normal public discussion generation.
  // Agents without improviseIntro fall back to a plain speak().
  private async safeImproviseIntro(
    player: Player,
    abortSignal?: AbortSignal,
    speculative = false,
    angle?: string
  ): Promise<AgentSpeech> {
    this.throwIfCancelled();
    const agent = this.agents.get(player.id) ?? fallbackAgent;
    const legalPlayers = this.speechLegalPlayers(player).map(({ id, name }) => ({ id, name }));
    const requestAbort = mergeAbortSignals(this.abortSignal, abortSignal);
    const contextLines = [
      this.nightDeathContextLine(),
      this.text(
        "It's your turn for a quick, one-line opening resolve before the discussion. The crew already knows each other; do not make it a first-meeting introduction. Keep it short, varied, and in your own voice. Leave roles, suspicions, and votes for the discussion.",
        "あなたの番です。議論の前に、短い意気込みを一言だけ。クルー同士はすでに知り合いなので、初対面の自己紹介にはしない。切り出し方に変化を出し、自分らしい言い回しで短く。役職・疑い・投票の話はまだしない。"
      ),
      // Each warm-up speaker gets a different opening angle so independent generations
      // don't all converge on the same first line.
      ...(angle ? [this.text(`Opening angle (vary from others): ${angle}`, `今回の切り出し方（他の人と変える）: ${angle}`)] : [])
    ];
    const input: AgentSpeechInput = {
      player,
      phase: this.phase,
      task: this.text("Give a short opening line of resolve.", "開幕の短い意気込みを話してください。"),
      context: this.contextFor(player, contextLines),
      uiContext: contextLines,
      knownPlayers: this.players.map(({ id, name }) => ({ id, name })),
      legalPlayers,
      publicHistory: this.publicHistory,
      privateHistory: player.memories,
      abortSignal: requestAbort.signal
    };
    try {
      const generate = agent.improviseIntro ? agent.improviseIntro.bind(agent) : agent.speak.bind(agent);
      const speech = this.sanitizeSpeechForPhase(await generate(input), legalPlayers, player);
      if (requestAbort.signal?.aborted) {
        throw new Error("Intro request cancelled.");
      }
      return speech;
    } catch (error) {
      if (this.abortSignal?.aborted || requestAbort.signal?.aborted) {
        throw error;
      }
      if (!speculative) {
        console.warn(`[intro] ${player.name}: ${error instanceof Error ? error.message : String(error)} — using fallback intro.`);
      }
      return this.sanitizeSpeechForPhase(await fallbackAgent.improviseIntro!(input), legalPlayers, player);
    } finally {
      requestAbort.cleanup();
    }
  }

  private fixedWerewolfFaceoffSpeech(player: Player): AgentSpeech {
    return compactWerewolfFaceoffSpeech(
      {
        messages: [sample([...werewolfFaceoffLineOptionsForPlayer(player, this.config.language)])],
        metadata: emptySpeechMetadata()
      },
      this.config.language
    );
  }

  private fixedLoverFaceoffSpeech(player: Player, partner: Player): AgentSpeech {
    return compactWerewolfFaceoffSpeech(
      {
        messages: [sample([...loverFaceoffLineOptionsForPlayer(player, partner, this.config.language)])],
        metadata: emptySpeechMetadata()
      },
      this.config.language
    );
  }

  private formatWerewolfFaceoffHistory(player: Player, speech: AgentSpeech): string {
    return `${player.name}: ${speech.messages.join(" ")}`;
  }

  private formatLoverFaceoffHistory(player: Player, speech: AgentSpeech): string {
    return `${player.name}: ${speech.messages.join(" ")}`;
  }

  private werewolfFaceoffHumanPromptLine(): string {
    return this.text(
      "Answer briefly after the fixed ally face-off lines. You may name your role and say how you will blend in, without attack targets or detailed plans.",
      "固定の仲間発言に続いて短く発言してください。自分の役職や昼の潜り方は言ってよいですが、襲撃先や細かい作戦はまだ話しません。"
    );
  }

  private loverFaceoffHumanPromptLine(): string {
    return this.text(
      "Answer briefly after the fixed partner face-off line. You may name your partner and say how you will both survive, without detailed vote plans.",
      "固定の相方発言に続いて短く発言してください。相方の名前や二人生存の方針は言ってよいですが、細かい投票計画はまだ話しません。"
    );
  }

  private werewolfFaceoffContextLines(
    werewolves: Player[],
    previousFaceoffHistory: string[] = []
  ): string[] {
    const teamRoster = werewolves
      .map((wolf) => `${wolf.name}（${roleLabel(wolf.role, this.config.language)}）`)
      .join("、");
    const lines = [
      this.text(
        "This is a private, allies-only werewolf alignment meeting before the first day opens. The crew already knows each other; this is not a first-meeting introduction.",
        "ここは初日が始まる前、人狼陣営だけの内緒の意思合わせです。クルー同士はすでに知り合いであり、初対面の自己紹介ではありません。"
      ),
      this.text(
        `Your werewolf allies: ${werewolves.map((wolf) => `${wolf.name} (${wolf.role})`).join(", ")}.`,
        `あなたの人狼陣営の仲間: ${teamRoster}。`
      ),
      this.text(
        "The ally lines in this opening are fixed character lines chosen at random. Use them only as the current team's private check-in; do not assume any other conversation.",
        "この顔合わせの仲間発言は、キャラクター別の固定候補からランダムに選ばれたものです。ここに出た発言だけを今回の内緒の意思合わせとして扱い、それ以外の会話は想定しません。"
      )
    ];
    if (previousFaceoffHistory.length > 0) {
      lines.push(
        ...previousFaceoffHistory
          .slice(-6)
          .map((line) =>
            this.text(
              `この顔合わせで先に出た仲間の発言: ${line}`,
              `この顔合わせで先に出た仲間の発言: ${line}`
            )
        ),
        this.text(
          "The lines above are only the ally lines already spoken in this private face-off.",
          "上の行は、この顔合わせ内で先に出た仲間の発言だけです。"
        )
      );
    }
    return lines;
  }

  private defaultHumanWerewolfFaceoffSpeech(player: Player): AgentSpeech {
    return compactWerewolfFaceoffSpeech(
      {
        messages: [defaultWerewolfAlignmentSpeechForPlayer(player, this.config.language)],
        metadata: emptySpeechMetadata()
      },
      this.config.language
    );
  }

  private loverFaceoffContextLines(
    lovers: Player[],
    previousFaceoffHistory: string[] = []
  ): string[] {
    const pairRoster = lovers.map((lover) => lover.name).join("、");
    const lines = [
      this.text(
        "This is a private, lovers-only face-off before the first day opens. The crew already knows each other; this is not a first-meeting introduction.",
        "ここは初日が始まる前、恋人同士だけの内緒の顔合わせです。クルー同士はすでに知り合いであり、初対面の自己紹介ではありません。"
      ),
      this.text(`Your lover pair: ${lovers.map((lover) => lover.name).join(", ")}.`, `あなたの恋人ペア: ${pairRoster}。`),
      this.text(
        "The partner lines in this opening are fixed character lines chosen at random. Use them only as the current lovers' private check-in; do not assume any other conversation.",
        "この顔合わせの相方発言は、キャラクター別の固定候補からランダムに選ばれたものです。ここに出た発言だけを今回の内緒の確認として扱い、それ以外の会話は想定しません。"
      )
    ];
    if (previousFaceoffHistory.length > 0) {
      lines.push(
        ...previousFaceoffHistory
          .slice(-4)
          .map((line) =>
            this.text(
              `Earlier partner face-off line from this same opening meeting: ${line}`,
              `この恋人顔合わせで先に出た相方の発言: ${line}`
            )
          ),
        this.text(
          "The lines above are only the partner lines already spoken in this private face-off.",
          "上の行は、この恋人顔合わせ内で先に出た相方の発言だけです。"
        )
      );
    }
    return lines;
  }

  private defaultHumanLoverFaceoffSpeech(player: Player, partner: Player): AgentSpeech {
    return compactWerewolfFaceoffSpeech(
      {
        messages: [defaultLoverAlignmentSpeechForPlayer(player, partner, this.config.language)],
        metadata: emptySpeechMetadata()
      },
      this.config.language
    );
  }

  private async requestOptionalHumanInput(
    input: HumanInputRequestPayload,
    options: { signal?: AbortSignal; logLabel?: string; onRequestId?: (requestId: string) => void } = {}
  ): Promise<HumanInputResponse | null> {
    const handler = this.humanInput;
    if (!handler) {
      return null;
    }

    const baseAbort = mergeAbortSignals(this.abortSignal, options.signal);
    const timeoutController = new AbortController();
    const requestAbort = mergeAbortSignals(baseAbort.signal, timeoutController.signal);
    let timedOut = false;
    let requestId: string | null = null;
    let timeout: ReturnType<typeof setNodeTimeout> | null = null;
    const rememberRequestId = (id: string) => {
      requestId = id;
      options.onRequestId?.(id);
    };
    const inputActivityFilter = () => {
      if (!requestId) {
        return null;
      }
      return input.kind === "speech_choice"
        ? { requestId, kind: input.kind, speechMode: input.speechMode }
        : { requestId, kind: input.kind };
    };
    const requestPromise: Promise<HumanInputResponse | null> = Promise.resolve().then(() =>
      handler.requestOptional
        ? handler.requestOptional(input, { signal: requestAbort.signal, onRequestId: rememberRequestId })
        : handler.request(input)
    );
    const timeoutMs = this.config.humanOptionalInputTimeoutMs ?? defaultHumanOptionalInputTimeoutMs;
    const timeoutWindowStartedAt = Date.now();
    const timeoutPromise = new Promise<null>((resolve) => {
      const schedule = () => {
        const filter = inputActivityFilter();
        const latestActivityAt = filter ? (this.humanInput?.latestInputActivityAt?.(filter) ?? null) : null;
        const deadlineBaseAt =
          latestActivityAt !== null && latestActivityAt > timeoutWindowStartedAt ? latestActivityAt : timeoutWindowStartedAt;
        const delayMs = Math.max(0, timeoutMs - (Date.now() - deadlineBaseAt));
        timeout = setNodeTimeout(() => {
          const currentFilter = inputActivityFilter();
          const currentLatestActivityAt = currentFilter
            ? (this.humanInput?.latestInputActivityAt?.(currentFilter) ?? null)
            : null;
          const currentDeadlineBaseAt =
            currentLatestActivityAt !== null && currentLatestActivityAt > timeoutWindowStartedAt
              ? currentLatestActivityAt
              : timeoutWindowStartedAt;
          if (Date.now() - currentDeadlineBaseAt < timeoutMs) {
            schedule();
            return;
          }
          timedOut = true;
          timeoutController.abort();
          resolve(null);
        }, delayMs);
      };
      schedule();
    });

    try {
      const response = await Promise.race([requestPromise, timeoutPromise]);
      if (this.abortSignal?.aborted) {
        throw new Error("Game stream cancelled.");
      }
      if (timedOut) {
        console.warn(`[human-input] optional ${options.logLabel ?? "input"} timed out; continuing without input.`);
      }
      return response;
    } catch (error) {
      if (this.abortSignal?.aborted) {
        throw error;
      }
      console.warn(
        `[human-input] optional ${options.logLabel ?? "input"} failed; continuing without input: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    } finally {
      if (timeout) {
        clearNodeTimeout(timeout);
      }
      requestPromise.catch(() => undefined);
      requestAbort.cleanup();
      baseAbort.cleanup();
      timeoutController.abort();
    }
  }

  private async requestOptionalHumanInputWithoutTimeout(
    input: HumanInputRequestPayload,
    options: { signal?: AbortSignal; logLabel?: string; onRequestId?: (requestId: string) => void } = {}
  ): Promise<HumanInputResponse | null> {
    const handler = this.humanInput;
    if (!handler) {
      return null;
    }

    const requestAbort = mergeAbortSignals(this.abortSignal, options.signal);
    try {
      const response = await (handler.requestOptional
        ? handler.requestOptional(input, { signal: requestAbort.signal, onRequestId: options.onRequestId })
        : handler.request(input));
      if (this.abortSignal?.aborted) {
        throw new Error("Game stream cancelled.");
      }
      return response;
    } catch (error) {
      if (this.abortSignal?.aborted) {
        throw error;
      }
      console.warn(
        `[human-input] optional ${options.logLabel ?? "input"} failed; continuing without input: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    } finally {
      requestAbort.cleanup();
    }
  }

  private async humanWerewolfFaceoffSpeech(
    player: Player,
    werewolves: Player[],
    previousFaceoffHistory: string[]
  ): Promise<AgentSpeech> {
    const handler = this.humanInput;
    if (!handler) {
      return this.defaultHumanWerewolfFaceoffSpeech(player);
    }

    const legalPlayers = this.speechLegalPlayers(player).map(({ id, name }) => ({ id, name }));
    const humanPromptLine = this.werewolfFaceoffHumanPromptLine();
    const contextLines = this.werewolfFaceoffContextLines(werewolves, previousFaceoffHistory);
    const visibleUiContext = [
      this.roleBreakdownUiLine(),
      contextLines[1],
      ...previousFaceoffHistory
        .slice(-2)
        .map((line) =>
          this.text(
            `Earlier ally face-off line from this same opening meeting: ${line}`,
            `この顔合わせで先に出た仲間の発言: ${line}`
          )
        ),
      humanPromptLine
    ].filter((line) => line.length > 0);
    const response = await this.requestOptionalHumanInput(
      {
        kind: "speech_choice",
        speechMode: "werewolf_alignment",
        nonBlocking: true,
        playerId: player.id,
        playerName: player.name,
        phase: this.phase,
        role: player.role,
        task: this.text(
          "Speak at the end of the private werewolf face-off.",
          "人狼陣営の顔合わせの最後に発言してください。"
        ),
        context: buildHumanInputContext({
          uiContext: visibleUiContext,
          publicHistory: this.publicHistory,
          privateHistory: this.humanVisiblePrivateHistory(player)
        }),
        allowFreeText: true,
        options: []
      },
      { logLabel: "werewolf alignment" }
    );
    if (!response) {
      return this.defaultHumanWerewolfFaceoffSpeech(player);
    }

    const customSpeech = await this.humanFreeTextSpeech(response.speech, legalPlayers);
    return customSpeech ? compactWerewolfFaceoffSpeech(customSpeech, this.config.language) : this.defaultHumanWerewolfFaceoffSpeech(player);
  }

  private async humanLoverFaceoffSpeech(
    player: Player,
    partner: Player,
    lovers: Player[],
    previousFaceoffHistory: string[]
  ): Promise<AgentSpeech> {
    const handler = this.humanInput;
    if (!handler) {
      return this.defaultHumanLoverFaceoffSpeech(player, partner);
    }

    const legalPlayers = [{ id: partner.id, name: partner.name }];
    const humanPromptLine = this.loverFaceoffHumanPromptLine();
    const contextLines = this.loverFaceoffContextLines(lovers, previousFaceoffHistory);
    const visibleUiContext = [
      this.roleBreakdownUiLine(),
      contextLines[1],
      ...previousFaceoffHistory
        .slice(-2)
        .map((line) =>
          this.text(
            `Earlier partner face-off line from this same opening meeting: ${line}`,
            `この恋人顔合わせで先に出た相方の発言: ${line}`
          )
        ),
      humanPromptLine
    ].filter((line) => line.length > 0);
    const response = await this.requestOptionalHumanInput(
      {
        kind: "speech_choice",
        speechMode: "lover_alignment",
        nonBlocking: true,
        playerId: player.id,
        playerName: player.name,
        phase: this.phase,
        role: player.role,
        task: this.text(
          "Speak at the end of the private lover face-off.",
          "恋人同士の顔合わせの最後に発言してください。"
        ),
        context: buildHumanInputContext({
          uiContext: visibleUiContext,
          publicHistory: this.publicHistory,
          privateHistory: this.humanVisiblePrivateHistory(player)
        }),
        allowFreeText: true,
        options: []
      },
      { logLabel: "lover alignment" }
    );
    if (!response) {
      return this.defaultHumanLoverFaceoffSpeech(player, partner);
    }

    const customSpeech = await this.humanFreeTextSpeech(response.speech, legalPlayers);
    return customSpeech ? compactWerewolfFaceoffSpeech(customSpeech, this.config.language) : this.defaultHumanLoverFaceoffSpeech(player, partner);
  }

  // Public discussion keeps tempo by drafting in-character candidate lines before the player acts.
  // The player may still override with free text; public speech is
  // published into the normal discussion history.
  private async humanChoiceSpeak(
    player: Player,
    input: AgentSpeechInput,
    legalPlayers: TargetCandidate[]
  ): Promise<AgentSpeech> {
    const shadow = this.humanChoiceAgent;
    const handler = this.humanInput;
    if (!shadow || !handler) {
      return this.sanitizeSpeechForPhase(defaultHumanHoldSpeech(this.config.language), legalPlayers, player);
    }

    let candidates: AgentSpeech[];
    try {
      // One racer drafts the whole speech option set. We run several racers in parallel and
      // keep the first complete set to finish, aborting the slower racers — the same
      // decision-race pattern the AI night/vote choices use.
      const raceSlots = this.shouldRaceHumanChoice(shadow) ? this.prefetchConcurrency : 1;
      candidates = await this.firstFinishedDecisionRace(
        (options) => this.draftHumanSpeechChoiceSet(shadow, input, options?.signal),
        raceSlots
      );
    } catch (error) {
      if (this.abortSignal?.aborted || input.abortSignal?.aborted) {
        throw error;
      }
      // Generation failed: still let the player confirm a simple fallback rather than silently auto-publishing one.
      console.warn(
        `[human-choice] ${player.name}: candidate generation failed (${
          error instanceof Error ? error.message : String(error)
        }); offering a single fallback option.`
      );
      candidates = [
        this.sanitizeSpeechForPhase(this.simpleSpeechFallback(input, legalPlayers, input.speechPlan), legalPlayers, player)
      ];
    }

    const response = await handler.request({
      kind: "speech_choice",
      playerId: player.id,
      playerName: player.name,
      phase: this.phase,
      role: player.role,
      task: input.task,
      context: buildHumanInputContext({
        uiContext: input.uiContext,
        publicHistory: input.publicHistory,
        privateHistory: input.privateHistory
      }),
      allowFreeText: true,
      options: candidates.map((candidate, index) => ({
        id: String(index),
        text: candidate.messages.join("\n")
      }))
    });

    const chosenIndex = resolveSpeechChoiceIndex(response.choiceId, candidates.length);
    const customSpeech = await this.humanFreeTextSpeech(response.speech, legalPlayers, input.abortSignal);
    if (customSpeech) {
      return this.sanitizeSpeechForPhase(customSpeech, legalPlayers, player);
    }

    return candidates[chosenIndex] ?? candidates[0];
  }

  private shouldRaceHumanChoice(shadow: Agent): boolean {
    return (
      this.prefetchConcurrency > 1 &&
      this.config.provider === "llm" &&
      shadow.model === this.config.model &&
      shadow.model !== "human"
    );
  }

  // A single racer: draft the full set of candidate speeches concurrently. Each draft runs
  // through the same review/retry/sanitize pipeline as an AI speech (via safeSpeak with the
  // shadow agent), so the player's options meet the same quality bar. The whole set is one
  // unit in the race, so racers that lose are aborted via the race signal.
  private async draftHumanSpeechChoiceSet(
    shadow: Agent,
    input: AgentSpeechInput,
    raceSignal?: AbortSignal
  ): Promise<AgentSpeech[]> {
    const settled = await Promise.all(
      Array.from({ length: humanSpeechDraftCount }, async () => {
        try {
          return await this.safeSpeak(input.player, input.task, input.context, input.uiContext ?? [], raceSignal, {
            agentOverride: shadow,
            suppressMemorySideEffects: true,
            speechPlan: input.speechPlan
          });
        } catch (error) {
          if (this.abortSignal?.aborted || raceSignal?.aborted) {
            throw error;
          }
          return null;
        }
      })
    );
    const candidates = dedupeSpeechCandidates(settled.filter((candidate): candidate is AgentSpeech => candidate !== null)).slice(
      0,
      humanSpeechChoiceCount
    );
    if (candidates.length === 0) {
      throw new Error("No human speech candidates were drafted.");
    }
    return candidates;
  }

  private speechLegalPlayers(player: Player): Player[] {
    if (this.phase === "werewolf_discussion" && player.camp === "werewolf") {
      return this.alivePlayers().filter((candidate) => candidate.camp !== "werewolf");
    }
    return this.alivePlayers().filter((candidate) => candidate.id !== player.id);
  }

  private sanitizeClaimForPhase(claim: ClaimMetadata): ClaimMetadata | null {
    const firstDayPublicDecision = (this.phase === "day_discussion" || this.phase === "voting") && this.round <= 1;
    if (!firstDayPublicDecision || (claim.role !== "Seer" && claim.type !== "seer_result")) {
      return claim;
    }

    const hasResultPayload = Boolean(claim.result || claim.camp || claim.targetId || claim.targetName || claim.type === "seer_result");
    if (!hasResultPayload) {
      return claim;
    }
    if (!claim.role) {
      return null;
    }

    const rest: ClaimMetadata = { ...claim };
    delete rest.result;
    delete rest.targetId;
    delete rest.targetName;
    delete rest.camp;
    const note =
      claim.note && !textHasCampResultEvidence(claim.note)
        ? claim.note
        : this.text("Seer claim without a first-day result", "初日は結果なしの占い師主張");
    return {
      ...rest,
      type: "role_claim",
      role: "Seer",
      note
    };
  }

  private sanitizeSpeechForPhase(speech: AgentSpeech, legalPlayers: TargetCandidate[], speaker?: TargetCandidate): AgentSpeech {
    const legalIds = new Set(legalPlayers.map((candidate) => candidate.id));
    const speechText = speech.messages.join(" ");
    const claims = speech.metadata.claims
      .map((claim) => this.sanitizeClaimForPhase(claim))
      .filter((claim): claim is ClaimMetadata => Boolean(claim));
    return {
      ...speech,
      metadata: {
        ...speech.metadata,
        suspects: speech.metadata.suspects.filter((read) => legalIds.has(read.targetId)),
        trusts: speech.metadata.trusts.filter((read) => legalIds.has(read.targetId)),
        claims: claims.filter((claim) => claimMetadataVisibleInSpeech(claim, speechText, this.config.language, legalPlayers, speaker))
      }
    };
  }

  private async raceChooseTarget(
    player: Player,
    action: string,
    context: string,
    candidates: Player[],
    allowSkip: boolean,
    uiContext: string[] = [],
    raceSlots = this.prefetchConcurrency,
    abortSignal?: AbortSignal
  ): Promise<TargetDecision> {
    const decisionRaceSlots = this.normalizedDecisionRaceSlots(raceSlots);
    if (!this.shouldRaceAiDecision(player) || decisionRaceSlots <= 1) {
      return this.safeChooseTarget(player, action, context, candidates, allowSkip, uiContext, { abortSignal });
    }

    return this.firstFinishedDecisionRace(
      async (options) => {
        const requestAbort = mergeAbortSignals(abortSignal, options?.signal);
        try {
          return await this.safeChooseTarget(player, action, context, candidates, allowSkip, uiContext, {
            abortSignal: requestAbort.signal,
            suppressMemorySideEffects: options?.speculative
          });
        } finally {
          requestAbort.cleanup();
        }
      },
      decisionRaceSlots
    );
  }

  private async safeChooseTarget(
    player: Player,
    action: string,
    context: string,
    candidates: Player[],
    allowSkip: boolean,
    uiContext: string[] = [],
    options: SafeGenerationOptions = {}
  ): Promise<TargetDecision> {
    this.throwIfCancelled();
    const agent = this.agents.get(player.id) ?? fallbackAgent;
    const targetCandidates: TargetCandidate[] = candidates.map(({ id, name }) => ({ id, name }));
    const privateHistory = agent.model === "human" ? this.humanVisiblePrivateHistory(player) : player.memories;
    const visibleUiContext = agent.model === "human" ? this.uiContextWithRoleBreakdown(uiContext) : uiContext;
    const requestAbort = mergeAbortSignals(this.abortSignal, options.abortSignal);
    const requestAbortSignal = requestAbort.signal;
    const input = {
      player,
      phase: this.phase,
      action,
      actionLabel: targetActionLabel(action),
      context,
      uiContext: visibleUiContext,
      candidates: targetCandidates,
      allowSkip,
      publicHistory: this.publicHistory,
      privateHistory,
      abortSignal: requestAbortSignal
    };
    try {
      const decision = await agent.chooseTarget(input);
      if (requestAbortSignal?.aborted) {
        throw new Error("Target choice request cancelled.");
      }
      return decision;
    } catch (error) {
      if (this.abortSignal?.aborted || requestAbortSignal?.aborted) {
        throw error;
      }
      if (!options.suppressMemorySideEffects) {
        const note = llmErrorMemoryNote("target", error);
        console.warn(`[llm-error] target ${player.id} ${this.phase}: ${note.english}`);
        player.memories.push(this.text(note.english, note.japanese));
      }
      if (!shouldFallbackFromLlmError(agent, error)) {
        throw error;
      }
      return fallbackAgent.chooseTarget(input);
    } finally {
      requestAbort.cleanup();
    }
  }

  private async raceDecide(
    player: Player,
    question: string,
    context: string,
    uiContext: string[] = [],
    raceSlots = this.prefetchConcurrency
  ): Promise<boolean> {
    const decisionRaceSlots = this.normalizedDecisionRaceSlots(raceSlots);
    if (!this.shouldRaceAiDecision(player) || decisionRaceSlots <= 1) {
      return this.safeDecide(player, question, context, uiContext);
    }

    return this.firstFinishedDecisionRace(
      (options) =>
        this.safeDecide(player, question, context, uiContext, {
          abortSignal: options?.signal,
          suppressMemorySideEffects: options?.speculative
        }),
      decisionRaceSlots
    );
  }

  private async safeDecide(
    player: Player,
    question: string,
    context: string,
    uiContext: string[] = [],
    options: SafeGenerationOptions = {}
  ): Promise<boolean> {
    this.throwIfCancelled();
    const agent = this.agents.get(player.id) ?? fallbackAgent;
    const privateHistory = agent.model === "human" ? this.humanVisiblePrivateHistory(player) : player.memories;
    const visibleUiContext = agent.model === "human" ? this.uiContextWithRoleBreakdown(uiContext) : uiContext;
    const requestAbort = mergeAbortSignals(this.abortSignal, options.abortSignal);
    const requestAbortSignal = requestAbort.signal;
    const input = {
      player,
      phase: this.phase,
      question,
      context,
      uiContext: visibleUiContext,
      publicHistory: this.publicHistory,
      privateHistory,
      abortSignal: requestAbortSignal
    };
    try {
      const decision = await agent.decide(input);
      if (requestAbortSignal?.aborted) {
        throw new Error("Boolean decision request cancelled.");
      }
      return decision;
    } catch (error) {
      if (this.abortSignal?.aborted || requestAbortSignal?.aborted) {
        throw error;
      }
      if (!options.suppressMemorySideEffects) {
        const note = llmErrorMemoryNote("decision", error);
        console.warn(`[llm-error] decision ${player.id} ${this.phase}: ${note.english}`);
        player.memories.push(this.text(note.english, note.japanese));
      }
      if (!shouldFallbackFromLlmError(agent, error)) {
        throw error;
      }
      return fallbackAgent.decide(input);
    } finally {
      requestAbort.cleanup();
    }
  }

  private formatSpeechHistory(player: Player, speech: AgentSpeech): string {
    const parts = [`${player.name}: ${speech.messages.join(" ")}`];
    if (speech.metadata.claims.length > 0) {
      parts.push(
        this.text(
          `Public claim note (not spoken): ${speech.metadata.claims.map((claim) => this.formatClaimSummary(player.name, claim)).join("; ")}`,
          `公開主張メモ（発話ではない）: ${speech.metadata.claims.map((claim) => this.formatClaimSummary(player.name, claim)).join("; ")}`
        )
      );
    }
    if (speech.metadata.suspects.length > 0) {
      parts.push(
        this.text(
          `Public read note (not spoken): ${player.name} suspects ${speech.metadata.suspects
            .map((read) => `${this.metadataTargetName(read)}${read.reason ? ` (${read.reason})` : ""}`)
            .join(", ")}`,
          `公開読みメモ（発話ではない）: ${player.name}が${speech.metadata.suspects
            .map((read) => `${this.metadataTargetName(read)}${read.reason ? `（${read.reason}）` : ""}`)
            .join("、")}を疑い`
        )
      );
    }
    if (speech.metadata.trusts.length > 0) {
      parts.push(
        this.text(
          `Public trust note (not spoken): ${player.name} trusts ${speech.metadata.trusts
            .map((read) => `${this.metadataTargetName(read)}${read.reason ? ` (${read.reason})` : ""}`)
            .join(", ")}`,
          `公開信頼メモ（発話ではない）: ${player.name}が${speech.metadata.trusts
            .map((read) => `${this.metadataTargetName(read)}${read.reason ? `（${read.reason}）` : ""}`)
            .join("、")}を信頼`
        )
      );
    }
    return parts.join("\n");
  }

  private async emitRoundSummary(): Promise<GameEvent> {
    const summary = this.buildRoundSummary();
    // Carry only factual recap forward as its day-bucket. Reads stay in the latest live state
    // instead of becoming stale suspicion/trust layers in later-day prompts.
    if (!this.roundPublicDigests.some((entry) => entry.round === this.round)) {
      this.roundPublicDigests.push({ round: this.round, message: this.buildRoundPublicDigest(summary.data) });
    }
    const data: Record<string, unknown> = {
      ...summary.data,
      deterministicMessage: summary.message,
      summaryMode: this.config.summaryMode,
      summarySource: "deterministic"
    };
    let message = summary.message;

    const fallbackReason = this.llmSummaryFallbackReason();
    if (fallbackReason) {
      data.summaryFallbackReason = fallbackReason;
    } else if (this.config.summaryMode === "llm") {
      try {
        const llmSummary = await summarizeRoundWithLlm({
          deterministicMessage: summary.message,
          round: this.round,
          model: this.config.model,
          language: this.config.language,
          data: summary.data,
          abortSignal: this.abortSignal
        });
        if (llmSummary) {
          message = llmSummary;
          data.summarySource = "llm";
        } else {
          data.summaryFallbackReason = "empty_llm_summary";
        }
      } catch (error) {
        data.summaryFallbackReason = "llm_error";
        data.summaryError = error instanceof Error ? error.message : String(error);
      }
    }

    return this.emit("round_summary", message, data);
  }

  private llmSummaryFallbackReason(): string | null {
    if (this.config.summaryMode !== "llm") {
      return null;
    }
    if (this.config.provider !== "llm") {
      return "llm_provider_not_selected";
    }
    if (!(process.env.ZAI_API_KEY || process.env.OPENAI_API_KEY)) {
      return "missing_api_key";
    }
    return null;
  }

  private buildRoundSummary(): { message: string; data: RoundSummaryData } {
    const nightDeaths = this.lastNightDeaths.map((id) => {
      const player = this.requirePlayer(id);
      return { playerId: player.id, playerName: player.name };
    });
    const claims = this.claimDetails();
    const suspects = this.readDetails("suspects");
    const trusts = this.readDetails("trusts");
    const votes = this.voteDetails(this.lastVotes);
    const totals =
      this.lastVotes.length > 0 || this.lastVoteModifiers.length > 0
        ? [...tallyVotes(this.lastVotes, this.lastVoteModifiers).entries()].map(([targetId, count]) => ({
            targetId,
            targetName: this.requirePlayer(targetId).name,
            count
          }))
        : [];

    const nightLine =
      nightDeaths.length > 0
        ? this.text(
            `Night: ${nightDeaths.map((death) => death.playerName).join(", ")} died.`,
            `夜: ${nightDeaths.map((death) => death.playerName).join(", ")}が死亡。`
          )
        : this.text("Night: no deaths.", "夜: 死亡者なし。");
    const shownClaims = claims.slice(0, 2);
    const claimLine =
      claims.length > 0
        ? this.text(
            `Claims: ${shownClaims.map((item) => this.formatClaimSummary(item.speakerName, item.claim)).join("; ")}${claims.length > shownClaims.length ? ` +${claims.length - shownClaims.length} more` : ""}.`,
            `主張: ${shownClaims.map((item) => this.formatClaimSummary(item.speakerName, item.claim)).join("; ")}${claims.length > shownClaims.length ? ` 他${claims.length - shownClaims.length}件` : ""}。`
          )
        : this.text("Claims: none.", "主張: なし。");
    const readLine = this.text(
      `Reads: suspects ${this.formatReadLeaders(suspects)}; trusts ${this.formatReadLeaders(trusts)}.`,
      `読み: 疑い先 ${this.formatReadLeaders(suspects)}、信頼先 ${this.formatReadLeaders(trusts)}。`
    );
    const sortedTotals = [...totals].sort((a, b) => b.count - a.count || a.targetName.localeCompare(b.targetName));
    const shownTotals = sortedTotals.slice(0, 3);
    const voteLine =
      shownTotals.length > 0
        ? this.text(
            `Votes: ${shownTotals.map((total) => `${total.targetName} ${total.count}`).join(", ")}${sortedTotals.length > shownTotals.length ? ` +${sortedTotals.length - shownTotals.length} more` : ""}.`,
            `投票: ${shownTotals.map((total) => `${total.targetName} ${total.count}票`).join(", ")}${sortedTotals.length > shownTotals.length ? ` 他${sortedTotals.length - shownTotals.length}件` : ""}。`
          )
        : this.text("Votes: none.", "投票: なし。");

    return {
      message: [nightLine, claimLine, readLine, voteLine].join(" "),
      data: {
        nightDeaths,
        claims,
        suspects,
        trusts,
        votes,
        totals
      }
    };
  }

  private buildRoundPublicDigest(data: RoundSummaryData): string {
    const nightLine =
      data.nightDeaths.length > 0
        ? this.text(
            `Night: ${data.nightDeaths.map((death) => death.playerName).join(", ")} died.`,
            `夜: ${data.nightDeaths.map((death) => death.playerName).join(", ")}が死亡。`
          )
        : this.text("Night: no deaths.", "夜: 死亡者なし。");
    const claimLine =
      data.claims.length > 0
        ? this.text(
            `Claims: ${data.claims.map((item) => this.formatClaimSummary(item.speakerName, item.claim)).join("; ")}.`,
            `主張: ${data.claims.map((item) => this.formatClaimSummary(item.speakerName, item.claim)).join("; ")}。`
          )
        : this.text("Claims: none.", "主張: なし。");
    const sortedTotals = [...data.totals].sort((a, b) => b.count - a.count || a.targetName.localeCompare(b.targetName));
    const voteLine =
      sortedTotals.length > 0
        ? this.text(
            `Votes: ${sortedTotals.map((total) => `${total.targetName} ${total.count}`).join(", ")}.`,
            `投票: ${sortedTotals.map((total) => `${total.targetName} ${total.count}票`).join(", ")}。`
          )
        : this.text("Votes: none.", "投票: なし。");
    return [nightLine, claimLine, voteLine].join(" ");
  }

  private formatReadLeaders(reads: Array<{ targetId: string; targetName: string }>): string {
    if (reads.length === 0) {
      return this.text("none", "なし");
    }

    const counts = new Map<string, { targetName: string; count: number }>();
    for (const read of reads) {
      const current = counts.get(read.targetId);
      counts.set(read.targetId, {
        targetName: read.targetName,
        count: (current?.count ?? 0) + 1
      });
    }

    const ranked = [...counts.values()].sort((a, b) => b.count - a.count || a.targetName.localeCompare(b.targetName));
    const shown = ranked.slice(0, 3);
    const text = shown.map((item) => `${item.targetName}${item.count > 1 ? ` x${item.count}` : ""}`).join(", ");
    return ranked.length > shown.length
      ? this.text(`${text} +${ranked.length - shown.length} more`, `${text} 他${ranked.length - shown.length}件`)
      : text;
  }

  private claimDetails(): Array<{ speakerId: string; speakerName: string; claim: ClaimMetadata }> {
    return this.lastDiscussion.flatMap((record) =>
      record.metadata.claims.map((claim) => ({
        speakerId: record.playerId,
        speakerName: record.playerName,
        claim
      }))
    );
  }

  private readDetails(kind: "suspects" | "trusts"): DiscussionReadDetail[] {
    const latestBySourceAndTarget = new Map<string, DiscussionReadDetail>();
    for (const record of this.lastDiscussion) {
      for (const read of record.metadata[kind]) {
        const key = `${record.playerId}:${read.targetId}`;
        latestBySourceAndTarget.delete(key);
        latestBySourceAndTarget.set(key, {
          sourceId: record.playerId,
          sourceName: record.playerName,
          targetId: read.targetId,
          targetName: read.targetName ?? this.requirePlayer(read.targetId).name,
          reason: read.reason,
          weight: read.weight
        });
      }
    }
    return [...latestBySourceAndTarget.values()];
  }

  private voteDetails(votes: VoteRecord[]): Array<{
    voterId: string;
    voterName: string;
    targetId: string;
    targetName: string;
  }> {
    return votes.map((vote) => {
      const voter = this.requirePlayer(vote.voterId);
      const target = this.requirePlayer(vote.targetId);
      return {
        voterId: voter.id,
        voterName: voter.name,
        targetId: target.id,
        targetName: target.name
      };
    });
  }

  private voteModifierDetails(modifiers: VoteModifier[]): Array<{
    targetId: string;
    targetName: string;
    count: number;
    sourceId?: string;
    sourceName?: string;
    reason?: string;
  }> {
    return modifiers.map((modifier) => {
      const target = this.requirePlayer(modifier.targetId);
      const source = modifier.sourceId ? this.requirePlayer(modifier.sourceId) : null;
      return {
        targetId: target.id,
        targetName: target.name,
        count: modifier.count,
        sourceId: source?.id,
        sourceName: source?.name,
        reason: modifier.reason
      };
    });
  }

  private formatVoteHistoryLine(votes: VoteRecord[], totals: Array<{ targetId: string; count: number }>): string {
    const voteText =
      votes.length > 0
        ? votes
            .map((vote) => `${this.requirePlayer(vote.voterId).name} -> ${this.requirePlayer(vote.targetId).name}`)
            .join(", ")
        : this.text("none", "なし");
    const totalText =
      totals.length > 0
        ? totals
            .map(({ targetId, count }) =>
              this.text(`${this.requirePlayer(targetId).name} ${count}`, `${this.requirePlayer(targetId).name} ${count}票`)
            )
            .join(", ")
        : this.text("none", "なし");
    return this.text(
      `Round ${this.round} votes: ${voteText}. Totals: ${totalText}.`,
      `第${this.round}ラウンド投票: ${voteText}。得票: ${totalText}。`
    );
  }

  private formatClaimSummary(speakerName: string, claim: ClaimMetadata): string {
    const roleText = claim.role
      ? this.text(`${speakerName} claims ${claim.role}`, `${speakerName}が${this.roleText(claim.role)}を主張`)
      : this.text(`${speakerName} makes a claim`, `${speakerName}が主張`);
    const resultText = this.formatClaimResult(claim.result);
    const targetText = claim.targetName ? this.text(` on ${claim.targetName}`, ` 対象:${claim.targetName}`) : "";
    const campText = claim.camp ? this.text(` as ${claim.camp}`, ` ${this.campText(claim.camp)}`) : "";
    const noteText = claim.note && !resultText ? ` (${claim.note})` : "";
    return `${roleText}${targetText}${campText}${resultText ? `: ${resultText}` : ""}${noteText}`;
  }

  private formatClaimResult(result: ClaimMetadata["result"]): string {
    if (!result) {
      return "";
    }
    if (typeof result === "string") {
      return result;
    }
    const roundText = result.round ? ` R${result.round}` : "";
    const targetName = this.playerNameOrId(result.targetId, result.targetName);
    return this.text(
      `${targetName} checked ${result.camp}${roundText}`,
      `${targetName}は${this.campText(result.camp)}判定${roundText}`
    );
  }

  private contextFor(
    player: Player,
    extra: string[] = [],
    secretOverride: RoleSecretContext = {},
    speechPlan?: PublicSpeechPlan
  ): string {
    return this.contextForAt(player, this.phase, this.round, extra, secretOverride, speechPlan);
  }

  private contextForAt(
    player: Player,
    phase: Phase,
    round: number,
    extra: string[] = [],
    secretOverride: RoleSecretContext = {},
    speechPlan?: PublicSpeechPlan
  ): string {
    return buildBaseContext({
      player,
      phase,
      round,
      roleBreakdown: this.roleBreakdown(),
      alivePlayers: this.alivePlayers().map(({ id, name }) => ({ id, name })),
      deadPlayers: this.players
        .filter((candidate) => !candidate.alive)
        .map(({ id, name, role }) => ({ id, name, role, publicDeathLabel: this.publicDeathLabelFor(id) })),
      publicHistory: this.publicHistory,
      privateHistory: player.memories,
      pastDayPublicDigests: this.roundPublicDigests.filter((entry) => entry.round < round),
      currentRoundPublicStart: this.roundPublicStart,
      language: this.config.language,
      secret: this.secretContextFor(player, secretOverride, round),
      lastNightDeaths: publicNightDeathInfos(this.lastNightDeathRecords, this.players, this.config.language),
      lastVoteDeaths: publicNightDeathInfos(this.lastVoteDeathRecords, this.players, this.config.language),
      speechPlan,
      extra
    });
  }

  private publicDeathLabelFor(playerId: string): string | undefined {
    const death = [...this.deathRecords].reverse().find((record) => record.playerId === playerId);
    if (!death) {
      return undefined;
    }
    if (death.cause === "vote") {
      return this.text("vote execution", "投票処刑");
    }
    return this.text("public cause unknown", "公開上原因不明");
  }

  private secretContextFor(player: Player, override: RoleSecretContext = {}, round = this.round): RoleSecretContext {
    const base: RoleSecretContext = {};

    if (player.camp === "werewolf") {
      base.werewolfAllies = this.players
        .filter((candidate) => candidate.camp === "werewolf")
        .map(({ id, name, role, alive }) => ({ id, name, role, alive }));
      const deception = this.werewolfDeceptions.get(player.id);
      if (deception) {
        const currentFakeSeerResult = deception.fakeSeerResults.find((result) => result.round === round && !result.announced);
        base.werewolfDeception = {
          claimedRole: deception.claimedRole,
          plannedSinceRound: deception.plannedSinceRound,
          publiclyClaimed: deception.publiclyClaimed,
          claimRound: deception.claimRound,
          fakeSeerResults: deception.fakeSeerResults.map(({ targetId, targetName, camp, round }) => ({
            targetId,
            targetName: targetName ?? targetId,
            camp,
            round
          })),
          ...(currentFakeSeerResult
            ? {
                currentFakeSeerResult: {
                  targetId: currentFakeSeerResult.targetId,
                  targetName: currentFakeSeerResult.targetName ?? currentFakeSeerResult.targetId,
                  camp: currentFakeSeerResult.camp,
                  round: currentFakeSeerResult.round
                }
              }
            : {})
        };
      }
    }

    if (player.role === "Seer") {
      const seerResults = this.trueSeerResults(player).map((result) => ({
        targetId: result.targetId,
        targetName: result.targetName ?? result.targetId,
        camp: result.camp,
        round: result.round
      }));
      base.seerResults = seerResults;
      const disclosure = this.seerDisclosures.get(player.id);
      if (disclosure) {
        base.seerDisclosure = {
          publiclyClaimed: disclosure.publiclyClaimed,
          claimRound: disclosure.claimRound,
          announcedResults: seerResults.filter((result) => disclosure.announcedResultIds.has(result.targetId))
        };
      }
    }

    if (player.role === "Witch") {
      base.witch = {
        savePotion: this.witchState.savePotion,
        poisonPotion: this.witchState.poisonPotion
      };
    }

    if (player.role === "Lover") {
      const partnerStatus = playerStatuses(this.ruleState, player.id, "lover").find((status) => status.targetId);
      if (partnerStatus?.targetId) {
        const partner = this.requirePlayer(partnerStatus.targetId);
        base.loverPartner = {
          id: partner.id,
          name: partner.name,
          alive: partner.alive
        };
      }
    }

    const witch = base.witch && override.witch ? { ...base.witch, ...override.witch } : (override.witch ?? base.witch);
    const seerDisclosure =
      base.seerDisclosure && override.seerDisclosure
        ? { ...base.seerDisclosure, ...override.seerDisclosure }
        : (override.seerDisclosure ?? base.seerDisclosure);

    return {
      ...base,
      ...override,
      witch,
      seerDisclosure
    };
  }

  private lastVoteEliminatedWerewolf(): Player | null {
    if (!this.lastVoteEliminatedPlayerId) {
      return null;
    }
    const player = this.players.find((candidate) => candidate.id === this.lastVoteEliminatedPlayerId);
    if (!player || player.camp !== "werewolf" || player.alive) {
      return null;
    }
    return player;
  }

  private roleBreakdown(): RoleBreakdownEntry[] {
    const counts = new Map<Role, number>();
    for (const player of this.players) {
      counts.set(player.role, (counts.get(player.role) ?? 0) + 1);
    }
    return roleBreakdownOrder
      .map((role) => ({ role, count: counts.get(role) ?? 0 }))
      .filter((entry) => entry.count > 0);
  }

  private daySpeakerOrder(): Player[] {
    const speakers = this.alivePlayers();
    if (speakers.length <= 1) {
      return speakers;
    }
    const offset = this.round > 1 ? (this.round - 1) % speakers.length : 0;
    return [...speakers.slice(offset), ...speakers.slice(0, offset)];
  }

  private isHumanControlledPlayer(player: Player): boolean {
    return player.model === "human";
  }

  private dayDiscussionFollowUpLimit(speakerCount: number): number {
    return Math.min(
      maxFollowUpDayDiscussionSpeakers,
      Math.max(minFollowUpDayDiscussionSpeakers, Math.ceil(speakerCount * followUpDayDiscussionSpeakerRatio))
    );
  }

  private humanFollowUpInfluence(speakers: Player[], speakerOrder: Map<string, number>): HumanFollowUpInfluence {
    const responderScores = new Map<string, number>();
    const humanReadTargetIds = new Set<string>();
    const human = this.humanControlledPlayer();
    if (!human || !speakerOrder.has(human.id)) {
      return { responderScores, humanReadTargetIds };
    }

    const readWeight = (read: { weight?: number }, fallback = 0.5) =>
      typeof read.weight === "number" && Number.isFinite(read.weight) ? Math.max(0, Math.min(1, read.weight)) : fallback;
    const humanSuspects = new Map<string, number>();
    const humanTrusts = new Map<string, number>();
    const addReadWeight = (reads: Map<string, number>, targetId: string, weight: number) => {
      if (!speakerOrder.has(targetId)) {
        return;
      }
      humanReadTargetIds.add(targetId);
      reads.set(targetId, (reads.get(targetId) ?? 0) + weight);
    };

    for (const record of this.lastDiscussion) {
      if (record.playerId !== human.id) {
        continue;
      }
      for (const read of record.metadata.suspects) {
        addReadWeight(humanSuspects, read.targetId, readWeight(read));
      }
      for (const read of record.metadata.trusts) {
        addReadWeight(humanTrusts, read.targetId, readWeight(read));
      }
    }

    if (humanSuspects.size === 0 && humanTrusts.size === 0) {
      return { responderScores, humanReadTargetIds };
    }

    const addResponderScore = (playerId: string, amount: number) => {
      if (!speakerOrder.has(playerId) || playerId === human.id || amount <= 0) {
        return;
      }
      responderScores.set(playerId, (responderScores.get(playerId) ?? 0) + amount);
    };

    for (const record of this.lastDiscussion) {
      if (record.playerId === human.id || !speakerOrder.has(record.playerId)) {
        continue;
      }
      const source = this.requirePlayer(record.playerId);
      if (!source.alive || this.isHumanControlledPlayer(source)) {
        continue;
      }

      for (const read of record.metadata.trusts) {
        const weight = readWeight(read);
        if (read.targetId === human.id) {
          addResponderScore(record.playerId, 4 + weight);
        }
        const sharedTrustWeight = humanTrusts.get(read.targetId);
        if (sharedTrustWeight !== undefined) {
          addResponderScore(record.playerId, 1.5 + Math.min(weight, sharedTrustWeight));
        }
      }

      for (const read of record.metadata.suspects) {
        const sharedSuspectWeight = humanSuspects.get(read.targetId);
        if (sharedSuspectWeight !== undefined) {
          addResponderScore(record.playerId, 2 + Math.min(readWeight(read), sharedSuspectWeight));
        }
      }
    }

    for (const speaker of speakers) {
      if (!this.isHumanControlledPlayer(speaker)) {
        addResponderScore(speaker.id, humanInfluenceFollowUpPersonaScore(speaker.persona));
      }
    }

    return { responderScores, humanReadTargetIds };
  }

  private dayDiscussionFollowUpSpeakers(speakers: Player[]): Player[] {
    const speakerOrder = new Map(speakers.map((player, index) => [player.id, index]));
    const scores = new Map<string, number>();
    const addScore = (playerId: string | undefined, amount: number) => {
      if (!playerId || !speakerOrder.has(playerId)) {
        return;
      }
      scores.set(playerId, (scores.get(playerId) ?? 0) + amount);
    };

    for (const record of this.lastDiscussion) {
      const source = this.requirePlayer(record.playerId);
      const sourceInfluence = this.isHumanControlledPlayer(source) ? 2.6 : 1;
      for (const read of record.metadata.suspects) {
        const weight = typeof read.weight === "number" && Number.isFinite(read.weight) ? Math.max(0, read.weight) : 0;
        addScore(read.targetId, (2 + weight) * sourceInfluence);
      }
      for (const claim of record.metadata.claims) {
        if (claim.type !== "generic") {
          addScore(record.playerId, 1);
        }
        addScore(claim.targetId, 1);
        const result = typeof claim.result === "object" && claim.result !== null ? claim.result : undefined;
        addScore(result?.targetId, 1);
      }
    }

    const ranked = speakers
      .map((player) => ({
        player,
        score: scores.get(player.id) ?? 0,
        order: speakerOrder.get(player.id) ?? Number.MAX_SAFE_INTEGER
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .map(({ player }) => player);
    const limit = this.dayDiscussionFollowUpLimit(speakers.length);
    const selected = ranked.slice(0, limit);
    const humanInfluence = this.humanFollowUpInfluence(speakers, speakerOrder);
    const humanResponder = speakers
      .map((player) => ({
        player,
        score: humanInfluence.responderScores.get(player.id) ?? 0,
        order: speakerOrder.get(player.id) ?? Number.MAX_SAFE_INTEGER
      }))
      .filter(
        ({ player, score }) =>
          score > 0 && !this.isHumanControlledPlayer(player) && !selected.some((selectedPlayer) => selectedPlayer.id === player.id)
      )
      .sort((a, b) => {
        const aDirectTarget = humanInfluence.humanReadTargetIds.has(a.player.id);
        const bDirectTarget = humanInfluence.humanReadTargetIds.has(b.player.id);
        if (aDirectTarget !== bDirectTarget) {
          return aDirectTarget ? 1 : -1;
        }
        return b.score - a.score || a.order - b.order;
      })[0]?.player;
    if (humanResponder) {
      if (selected.length < limit) {
        selected.push(humanResponder);
      } else {
        for (let index = selected.length - 1; index >= 0; index -= 1) {
          const replacement = selected[index];
          if (!this.isHumanControlledPlayer(replacement) && !humanInfluence.humanReadTargetIds.has(replacement.id)) {
            selected[index] = humanResponder;
            break;
          }
        }
      }
    }
    const pressuredHuman = ranked.find((player) => this.isHumanControlledPlayer(player) && (scores.get(player.id) ?? 0) > 0);
    if (pressuredHuman && !selected.some((player) => player.id === pressuredHuman.id)) {
      if (selected.length >= limit) {
        selected[selected.length - 1] = pressuredHuman;
      } else {
        selected.push(pressuredHuman);
      }
    }
    return selected;
  }

  private alivePlayers(): Player[] {
    return this.players.filter((player) => player.alive);
  }

  private countAlive(camp: Camp): number {
    return countAliveByCamp(this.players, camp);
  }

  private requirePlayer(id: string): Player {
    const player = this.players.find((candidate) => candidate.id === id);
    if (!player) {
      throw new Error(`Unknown player id: ${id}`);
    }
    return player;
  }

  private emit(
    type: GameEvent["type"],
    message: string,
    data: Record<string, unknown> = {},
    player?: Player,
    target?: Player
  ): GameEvent {
    this.eventId += 1;
    return {
      id: this.eventId,
      createdAt: new Date().toISOString(),
      round: this.round,
      phase: this.phase,
      type,
      message,
      playerId: player?.id,
      playerName: player?.name,
      role: player?.role,
      targetId: target?.id,
      targetName: target?.name,
      data,
      snapshot: this.snapshot()
    };
  }

  private snapshot(): GameSnapshot {
    return {
      round: this.round,
      phase: this.phase,
      winner: this.winner,
      winnerCamp: this.winnerCamp,
      winnerIds: this.winnerIds,
      winnerCamps: this.winnerCamps,
      winnerGroups: this.winnerGroups,
      personalLossPlayerId: this.personalLossPlayerId,
      aliveCount: this.alivePlayers().length,
      werewolfCount: this.countAlive("werewolf"),
      villageCount: this.countAlive("village"),
      players: this.players.map((player) => ({
        id: player.id,
        name: player.name,
        role: player.role,
        camp: player.camp,
        persona: player.persona,
        alive: player.alive,
        model: player.model,
        memoryCount: player.memories.length,
        witch:
          player.role === "Witch"
            ? {
                savePotion: this.witchState.savePotion,
                poisonPotion: this.witchState.poisonPotion
              }
            : undefined
      }))
    };
  }
}
