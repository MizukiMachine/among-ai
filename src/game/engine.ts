import { setMaxListeners } from "node:events";
import { buildSimpleFallbackSpeech, createAgentFactory, DemoAgent, summarizeRoundWithLlm } from "./agents";
import { characterNames, getCharacterProfile, getPersonaForPlayer } from "./characters";
import { textHasCampResultEvidence, textHasRoleClaimEvidence, textHasSeerClaimEvidence } from "./daySituations";
import { buildHumanInputContext, HumanInputAgent } from "./humanAgent";
import { campLabel, defaultLanguage, isJapaneseLanguage, roleLabel } from "./i18n";
import { stripJapaneseSpeechTerminalPeriod } from "./japaneseStyle";
import { buildBaseContext, type RoleSecretContext } from "./prompts";
import {
  buildPublicSpeechPlan,
  firstDayOpeningMove,
  firstDayOpeningMoveKinds,
  firstDayWerewolfOpeningMoveKinds,
  renderPublicSpeechDiversityContext
} from "./speechPlanning";
import {
  canUseDeathTrigger,
  createDeathResolutionEffects,
  createLinkedDeathRecords,
  createNightDeathRecords,
  markPlayerDead
} from "./rules/deaths";
import { resolveVoteElimination } from "./rules/elimination";
import type { DeathRecord, RuleState } from "./rules/types";
import { createNightActionPlan } from "./rules/night";
import {
  createRoles,
  createScenarioRoles,
  minimumPlayerCountForScenario,
  normalizePlayerCount
} from "./rules/presets";
import { roleCamp } from "./rules/roles";
import { addVictoryClaims, applyStatusEffects, canUseAbilities, createInitialRuleState, expireStatuses, playerStatuses } from "./rules/state";
import { filterEligibleVotes, resolveVote, tallyVotes, topVoted, voteModifiersFromRuleState, type VoteModifier } from "./rules/voting";
import { adjudicateStandardVictory, checkLoverVictory, checkNeutralVictory, checkStandardVictory, countAliveByCamp } from "./rules/victory";
import { sample, shuffle } from "./random";
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
  Persona,
  Phase,
  Player,
  PublicSpeechPlan,
  Role,
  SpeechGenerationDiagnostic,
  SpeechMetadata,
  SummaryMode,
  TargetCandidate,
  TargetDecision,
  VoteRecord
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
const defaultAiPrefetchConcurrency = 5;
const maxAiPrefetchConcurrency = 5;
const abortSignalMaxListeners = 64;

const fallbackAgent = new DemoAgent("fallback", "demo", defaultLanguage);

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

interface PreparedTargetAction {
  actor: Player;
  target: Player;
  reason: string;
}

type PreparedWitchAction =
  | { kind: "save"; witch: Player; target: Player }
  | { kind: "poison"; witch: Player; target: Player; reason: string };

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

function textHasSpecificRoleClaim(text: string, role: Role, language: string): boolean {
  if (role === "Seer") {
    return textHasSeerClaimEvidence(text);
  }
  const roleText = roleLabel(role, language);
  if (isJapaneseLanguage(language)) {
    const escapedRole = escapeRegExp(roleText);
    return new RegExp(
      [
        `(?:私|僕|俺|自分|こちら)(?:は|が)?[^。！？!?]{0,16}${escapedRole}(?:です|だ|として|を名乗|CO)`,
        `${escapedRole}(?:CO|を主張|として出(?:ます|る|た|ました|ている|ています)|を名乗(?:ります|りました|った|っている|っています))`
      ].join("|"),
      "u"
    ).test(text);
  }
  const escapedRole = escapeRegExp(role);
  return new RegExp(`\\b(?:I(?: am|'m) (?:the )?${escapedRole}|claim(?:ed|s)? (?:to be )?(?:the )?${escapedRole})\\b`, "i").test(
    text
  );
}

function claimMetadataVisibleInSpeech(claim: ClaimMetadata, speechText: string, language: string): boolean {
  const result = typeof claim.result === "object" && claim.result !== null ? claim.result : undefined;
  const hasRoleClaim = claim.role ? textHasSpecificRoleClaim(speechText, claim.role, language) : textHasRoleClaimEvidence(speechText);
  const hasResult = Boolean(result ?? claim.camp) && textHasCampResultEvidence(speechText) && textMentionsClaimTarget(speechText, claim);
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

const humanSpeechChoiceCount = 3;
const maxHumanSpeechLength = 240;
// Draft one extra so that, after deduping, the player still sees a full set of distinct options.
const humanSpeechDraftCount = humanSpeechChoiceCount + 1;

function defaultHumanHoldSpeech(language: string): AgentSpeech {
  return {
    messages: [isJapaneseLanguage(language) ? "今は発言を控える" : "I will hold my statement for now"],
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

function humanFreeTextSpeech(text: string | undefined, language: string): AgentSpeech | null {
  const message = compactHumanSpeech(text, language);
  if (!message) {
    return null;
  }
  return {
    messages: [message],
    metadata: emptySpeechMetadata()
  };
}

function shouldLockHumanWerewolfOpeningToChoices(input: AgentSpeechInput): boolean {
  const moveKind = input.speechPlan?.firstDayOpeningMove?.kind;
  return (
    input.phase === "day_discussion" &&
    input.player.camp === "werewolf" &&
    input.speechPlan?.opensFirstDay === true &&
    (moveKind === "wolf_human_side_claim" || moveKind === "wolf_fake_role_claim")
  );
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
  humanCampPreference: HumanCampPreference = "random"
): Role[] {
  const roles = createRoles(playerCount);
  if (!humanInputAvailable || !humanPlayerId) {
    return shuffle(roles);
  }

  const humanIndex = playerIdIndex(humanPlayerId, roles.length);
  if (humanIndex === null) {
    return shuffle(roles);
  }

  return assignHumanRole(roles, humanIndex, humanCampPreference);
}

function assignHumanRole(roles: Role[], humanIndex: number, campPreference: HumanCampPreference): Role[] {
  const preference = normalizeHumanCampPreference(campPreference);
  const humanRole = preference === "random" ? sampleBalancedHumanRole(roles) : sampleHumanRoleForCamp(roles, preference);
  const remainingRoles = removeOneRole(roles, humanRole);
  const shuffledRemaining = shuffle(remainingRoles);
  return [...shuffledRemaining.slice(0, humanIndex), humanRole, ...shuffledRemaining.slice(humanIndex)];
}

function sampleHumanRoleForCamp(roles: Role[], camp: Camp): Role {
  const candidates = roles.filter((role) => roleCamp(role) === camp);
  return candidates.length > 0 ? sample(candidates) : sampleBalancedHumanRole(roles);
}

function sampleBalancedHumanRole(roles: Role[]): Role {
  const werewolfCount = roles.filter((role) => roleCamp(role) === "werewolf").length;
  const villageCount = roles.length - werewolfCount;
  const werewolfWeight = werewolfCount > 0 && villageCount > 0 ? villageCount / werewolfCount : 1;
  const weightForRole = (role: Role) => (roleCamp(role) === "werewolf" ? werewolfWeight : 1);
  const totalWeight = roles.reduce((total, role) => total + weightForRole(role), 0);
  let cursor = Math.random() * totalWeight;

  for (const role of roles) {
    cursor -= weightForRole(role);
    if (cursor < 0) {
      return role;
    }
  }

  return roles[roles.length - 1];
}

function removeOneRole(roles: Role[], roleToRemove: Role): Role[] {
  const index = roles.indexOf(roleToRemove);
  if (index === -1) {
    return [...roles];
  }
  return [...roles.slice(0, index), ...roles.slice(index + 1)];
}

function humanAttackProtectionRoundByPlayerCount(playerCount: number): number {
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

async function* orderedConcurrentMap<T, R>(
  items: T[],
  concurrency: number,
  run: (item: T, index: number) => Promise<R>,
  onProgress?: (progress: Pick<GenerationProgress, "total" | "started" | "completed" | "active" | "queued" | "concurrency">) => void
): AsyncGenerator<R> {
  if (items.length === 0) {
    return;
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  type Settled = { ok: true; value: R } | { ok: false; error: unknown };
  const pending = new Map<number, Promise<Settled>>();
  let nextIndex = 0;
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
  const startNext = () => {
    if (nextIndex >= items.length) {
      return;
    }
    const currentIndex = nextIndex;
    nextIndex += 1;
    started += 1;
    active += 1;
    pending.set(
      currentIndex,
      run(items[currentIndex], currentIndex).then(
        (value) => {
          completed += 1;
          active -= 1;
          report();
          return { ok: true, value };
        },
        (error: unknown) => {
          completed += 1;
          active -= 1;
          report();
          return { ok: false, error };
        }
      )
    );
  };

  for (let index = 0; index < limit; index += 1) {
    startNext();
  }
  report();

  for (let index = 0; index < items.length; index += 1) {
    const promise = pending.get(index);
    if (!promise) {
      throw new Error(`Missing queued task at index ${index}`);
    }
    const result = await promise;
    pending.delete(index);
    startNext();
    if (!result.ok) {
      throw result.error;
    }
    report();
    yield result.value;
  }
}

async function* orderedConcurrentDecisionMap<T, R>(
  items: T[],
  concurrency: number,
  run: (item: T, index: number, raceSlots: number) => Promise<R>,
  onProgress?: (progress: Pick<GenerationProgress, "total" | "started" | "completed" | "active" | "queued" | "concurrency">) => void
): AsyncGenerator<R> {
  if (items.length === 0) {
    return;
  }

  const limit = Math.max(1, concurrency);
  type Settled = { ok: true; value: R } | { ok: false; error: unknown };
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

    const pending = chunk.map((item, chunkIndex) => {
      const raceSlots = slotCounts[chunkIndex] ?? 1;
      return run(item, offset + chunkIndex, raceSlots).then(
        (value) => {
          completed += 1;
          activeSlots = Math.max(0, activeSlots - raceSlots);
          report();
          return { ok: true, value } as Settled;
        },
        (error: unknown) => {
          completed += 1;
          activeSlots = Math.max(0, activeSlots - raceSlots);
          report();
          return { ok: false, error } as Settled;
        }
      );
    });

    for (const promise of pending) {
      const result = await promise;
      if (!result.ok) {
        throw result.error;
      }
      yield result.value;
    }
  }
}

function mergeAbortSignals(a?: AbortSignal, b?: AbortSignal): { signal?: AbortSignal; cleanup: () => void } {
  if (!a) {
    return { signal: b, cleanup: () => undefined };
  }
  if (!b || a === b) {
    return { signal: a, cleanup: () => undefined };
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (a.aborted || b.aborted) {
    abort();
    return { signal: controller.signal, cleanup: () => undefined };
  }

  a.addEventListener("abort", abort, { once: true });
  b.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      a.removeEventListener("abort", abort);
      b.removeEventListener("abort", abort);
    }
  };
}

export class WerewolfGame {
  private readonly players: Player[];
  private readonly agents = new Map<string, Agent>();
  private readonly humanInput?: HumanInputHandler;
  private humanChoiceAgent: Agent | null = null;
  private readonly publicHistory: string[] = [];
  private readonly wolfHistory: string[] = [];
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
  private readonly hunterShotsUsed = new Set<string>();
  private ruleState: RuleState = { players: {} };
  private eventId = 0;
  private round = 0;
  private phase: Phase = "setup";
  private winner: Camp | null = null;
  private winnerCamp: CampId | null = null;
  private winnerIds: string[] = [];
  private lastNightDeaths: string[] = [];
  private lastDiscussion: DiscussionRecord[] = [];
  private lastVotes: VoteRecord[] = [];
  private lastVoteModifiers: VoteModifier[] = [];
  private lastNightDeathRecords: DeathRecord[] = [];
  private firstDayOpeningSpeechPrefetch: DayDiscussionSpeechPrefetch | null = null;

  constructor(config: GameConfig, options: WerewolfGameOptions = {}) {
    this.humanInput = options.humanInput;
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
      prefetchConcurrency
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
            Boolean(options.humanInput),
            this.config.humanCampPreference
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
      const isHumanSlot = playerId === this.config.humanPlayerId && Boolean(options.humanInput);
      const autonomousAgent =
        activeDebugScenario === "none" ? createAgent(name) : this.createScenarioAgent(name, activeDebugScenario, index);
      const agent =
        isHumanSlot && options.humanInput
          ? new HumanInputAgent(name, options.humanInput, this.config.language)
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

  private async *orderedAiWithHumanBoundary<T, R>(
    items: T[],
    getPlayerId: (item: T) => string,
    run: (item: T, index: number) => Promise<R>,
    onProgress?: (progress: Pick<GenerationProgress, "total" | "started" | "completed" | "active" | "queued" | "concurrency">) => void
  ): AsyncGenerator<R> {
    const indexedItems = items.map((item, index) => ({ item, index }));
    const humanIndex = this.config.humanPlayerId ? indexedItems.findIndex(({ item }) => getPlayerId(item) === this.config.humanPlayerId) : -1;

    if (humanIndex === -1) {
      for await (const result of orderedConcurrentMap(
        indexedItems,
        this.prefetchConcurrency,
        ({ item, index }) => run(item, index),
        onProgress
      )) {
        yield result;
      }
      return;
    }

    const runChunk = (chunk: typeof indexedItems) =>
      orderedConcurrentMap(
        chunk,
        this.prefetchConcurrency,
        ({ item, index }) => run(item, index),
        onProgress
      );

    for await (const result of runChunk(indexedItems.slice(0, humanIndex))) {
      yield result;
    }

    const humanItem = indexedItems[humanIndex];
    yield await run(humanItem.item, humanItem.index);

    for await (const result of runChunk(indexedItems.slice(humanIndex + 1))) {
      yield result;
    }
  }

  private async *orderedAiDecisionWithHumanBoundary<T, R>(
    items: T[],
    getPlayerId: (item: T) => string,
    run: (item: T, index: number, raceSlots: number) => Promise<R>,
    onProgress?: (progress: Pick<GenerationProgress, "total" | "started" | "completed" | "active" | "queued" | "concurrency">) => void
  ): AsyncGenerator<R> {
    const indexedItems = items.map((item, index) => ({ item, index }));
    const humanIndex = this.config.humanPlayerId ? indexedItems.findIndex(({ item }) => getPlayerId(item) === this.config.humanPlayerId) : -1;

    const runChunk = (chunk: typeof indexedItems) =>
      orderedConcurrentDecisionMap(
        chunk,
        this.prefetchConcurrency,
        ({ item, index }, _chunkIndex, raceSlots) => run(item, index, raceSlots),
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
    yield await run(humanItem.item, humanItem.index, 1);

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

  private async firstFinishedSpeechRace<R>(
    players: Player[],
    run: (player: Player, options?: SpeculativeRunOptions) => Promise<R>
  ): Promise<{ player: Player; value: R }> {
    type RaceResult =
      | { ok: true; slotId: string; player: Player; value: R; controller: AbortController }
      | { ok: false; slotId: string; player: Player; error: unknown; controller: AbortController };
    type RaceController = { controller: AbortController; player: Player };
    const active = new Map<string, Promise<RaceResult>>();
    const controllers = new Map<string, RaceController>();
    let lastError: unknown;

    for (const [index, player] of players.entries()) {
      const slotId = `${player.id}:${index}`;
      const controller = new AbortController();
      controllers.set(slotId, { controller, player });
      const promise = run(player, { signal: controller.signal, speculative: true }).then(
        (value) => ({ ok: true, slotId, player, value, controller }) as RaceResult,
        (error: unknown) => ({ ok: false, slotId, player, error, controller }) as RaceResult
      );
      active.set(slotId, promise);
    }

    while (active.size > 0) {
      const result = await Promise.race(active.values());
      active.delete(result.slotId);
      controllers.delete(result.slotId);
      if (result.ok) {
        const abortedPlayerIds = [...controllers.values()].map(({ player }) => player.id);
        for (const { controller } of controllers.values()) {
          controller.abort();
        }
        if (abortedPlayerIds.length > 0) {
          this.emitSpeechDiagnostic({
            kind: "speech_race_losers_aborted",
            playerId: result.player.id,
            playerName: result.player.name,
            speculative: true,
            raceSize: players.length,
            abortedPlayerIds
          });
        }
        return { player: result.player, value: result.value };
      }
      result.controller.abort();
      lastError = result.error;
    }

    throw lastError;
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

  private async firstFinishedDecisionRace<R>(
    player: Player,
    run: (options?: SpeculativeRunOptions) => Promise<R>,
    raceSlots = this.prefetchConcurrency
  ): Promise<R> {
    const limit = this.normalizedDecisionRaceSlots(raceSlots);
    type RaceResult =
      | { ok: true; slotId: string; value: R; controller: AbortController }
      | { ok: false; slotId: string; error: unknown; controller: AbortController };
    const active = new Map<string, Promise<RaceResult>>();
    const controllers = new Map<string, AbortController>();
    let lastError: unknown;

    for (let index = 0; index < limit; index += 1) {
      const slotId = `${player.id}:decision:${index}`;
      const controller = new AbortController();
      controllers.set(slotId, controller);
      const promise = run({ signal: controller.signal, speculative: true }).then(
        (value) => ({ ok: true, slotId, value, controller }) as RaceResult,
        (error: unknown) => ({ ok: false, slotId, error, controller }) as RaceResult
      );
      active.set(slotId, promise);
    }

    while (active.size > 0) {
      const result = await Promise.race(active.values());
      active.delete(result.slotId);
      controllers.delete(result.slotId);
      if (result.ok) {
        for (const controller of controllers.values()) {
          controller.abort();
        }
        return result.value;
      }
      result.controller.abort();
      lastError = result.error;
    }

    throw lastError;
  }

  private normalizedDecisionRaceSlots(raceSlots: number | undefined): number {
    const parsed = Number(raceSlots);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 1;
    }
    return Math.max(1, Math.min(this.prefetchConcurrency, Math.floor(parsed)));
  }

  private async generateDayDiscussionSpeech(
    player: Player,
    discussionPass: number,
    openingMoveByPlayerId: Map<string, FirstDayOpeningMoveKind>,
    options: SpeculativeRunOptions = {}
  ): Promise<{ player: Player; speech: AgentSpeech }> {
    const openingMoveKind = discussionPass === 1 ? openingMoveByPlayerId.get(player.id) : undefined;
    const openingMove = openingMoveKind ? firstDayOpeningMove(openingMoveKind, this.config.language) : undefined;
    const contextLines = [
      this.nightDeathContextLine(),
      this.text(
        "Discuss suspicions, claims, or information with the whole table.",
        "疑い、役職主張、情報を全体に向けて話してください。"
      ),
      discussionPass <= regularDayDiscussionPasses
        ? this.text(
            `Discussion pass ${discussionPass} of ${regularDayDiscussionPasses}.`,
            `昼議論 ${discussionPass}巡目 / ${regularDayDiscussionPasses}巡。`
          )
        : this.text(
            "Follow-up pass for selected speakers after the two table passes.",
            "2巡後に必要な人だけが行う追加発言です。"
          ),
      discussionPass === 1
        ? this.round === 1
          ? this.text(
              "First pass: there is no prior day discussion yet. State one opening opinion such as vote-reason standards, claim-handling conditions, setup flow, or a direct question. Do not invent prior reactions.",
              "1巡目: まだ昼の発言はありません。投票理由の残し方、役職主張の扱い、進め方、答えやすい名指し質問など、自分の初期意見を一つ出してください。見えていない反応や矛盾は作らないでください。"
            )
          : this.text(
              "First pass: connect to the visible public history so far, then state one clear read, claim decision, or vote-leaning view from your own position.",
              "1巡目: ここまで見えている昼発言に自然につなげたうえで、自分の読み・役職主張の判断・投票寄りの見方のどれかを一つだけ短く出してください。"
            )
        : discussionPass === 2
          ? this.text(
              "Second pass: if needed, answer direct pressure briefly, then update one vote-ready read.",
              "2巡目: 必要なら自分への疑いに短く答え、その後に投票前の読みを一つ更新してください。"
            )
          : this.text(
              "Final follow-up: give one voting-ready read tied to the strongest suspicion or claim involving you.",
              "追加発言: 自分に関わる一番強い疑いや主張に触れ、投票前の読みを一つだけ出してください。"
            ),
      ...(openingMove
        ? [
            this.isJapanese()
              ? `初日特別モード: ${openingMove.label}。${openingMove.instruction}`
              : `First-day opening mode: ${openingMove.label}. ${openingMove.instruction}`
          ]
        : []),
      ...renderPublicSpeechDiversityContext(this.lastDiscussion, this.config.language, { excludePlayerId: player.id })
    ];
    const legalPlayers = this.speechLegalPlayers(player).map(({ id, name }) => ({ id, name }));
    const speechPlan = buildPublicSpeechPlan({
      phase: this.phase,
      round: this.round,
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
    const context = this.contextFor(player, contextLines, {}, speechPlan);
    const diagnosticRound = this.round;
    const diagnosticPhase = this.phase;
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
    return { player, speech };
  }

  private getOrStartFirstDayOpeningSpeechPrefetch(round: number): DayDiscussionSpeechPrefetch | null {
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
      const openingMoveByPlayerId = this.firstDayOpeningMoveAssignments(speakers);
      const openingSpeaker = this.firstAiDayOpeningSpeaker(speakers, openingMoveByPlayerId);
      if (!openingSpeaker) {
        return null;
      }

      const promise = this.generateDayDiscussionSpeech(openingSpeaker, 1, openingMoveByPlayerId);
      promise.catch(() => undefined);
      this.firstDayOpeningSpeechPrefetch = {
        round,
        openingSpeakerId: openingSpeaker.id,
        openingMoveByPlayerId,
        promise
      };
      return this.firstDayOpeningSpeechPrefetch;
    } finally {
      this.round = previousRound;
      this.phase = previousPhase;
    }
  }

  private firstAiDayOpeningSpeaker(
    speakers: Player[],
    openingMoveByPlayerId: Map<string, FirstDayOpeningMoveKind>
  ): Player | undefined {
    return speakers.find((speaker) => openingMoveByPlayerId.has(speaker.id) && !this.isHumanControlledPlayer(speaker));
  }

  async *run(): AsyncGenerator<GameEvent> {
    this.throwIfCancelled();
    this.getOrStartFirstDayOpeningSpeechPrefetch(1);
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

      yield* this.runNight();
      this.throwIfCancelled();
      // A day-set is "昼→夜"; recap the whole day (day discussion/vote + that night's deaths) once the night ends.
      yield await this.emitRoundSummary();
      const nightWinner = this.checkVictory();
      if (nightWinner) {
        yield this.finishGame(nightWinner);
        return;
      }
    }

    const adjudicated = adjudicateStandardVictory(this.players);
    yield this.finishGame({
      camp: adjudicated,
      reason: this.text(
        `Round limit reached after ${this.config.maxRounds} rounds.`,
        `${this.config.maxRounds}ラウンドの上限に到達しました。`
      )
    });
  }

  private async *runNight(): AsyncGenerator<GameEvent> {
    this.lastNightDeaths = [];
    this.lastNightDeathRecords = [];
    // lastVotes / lastVoteModifiers are kept until the post-night round summary; runVoting reassigns them each day.
    this.witchState.savedTargetId = null;
    this.witchState.poisonTargetId = null;
    this.guardState.protectedTargetId = null;
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
      if (step.kind === "werewolf_attack") {
        this.phase = "night";
        killTarget = await this.resolveWerewolfAttack(
          werewolves,
          this.progressReporterAt("night", this.round, "werewolf_attack_vote", this.text("Werewolf attack vote", "人狼の襲撃投票"))
        );
        if (killTarget) {
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
      if (step.kind === "raven_mark") {
        for (const actorId of step.actorIds) {
          yield* this.runRavenAction(this.requirePlayer(actorId));
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

    const deaths = this.filterProtectedHumanDeathRecords(
      createNightDeathRecords({
        werewolfTargetId: killTarget?.id,
        savedTargetId: savedTarget,
        protectedTargetId: this.guardState.protectedTargetId,
        poisonTargetId: this.witchState.poisonTargetId
      })
    );

    this.phase = "night";
    if (deaths.length === 0) {
      yield this.emit("death", this.text("No one died during the night.", "昨夜は誰も死亡しませんでした。"), { cause: "no_death" });
      return;
    }

    yield* this.resolveDeaths(deaths);
  }

  private async *runWerewolfDiscussion(werewolves: Player[]): AsyncGenerator<GameEvent> {
    if (werewolves.length <= 1) {
      return;
    }

    this.phase = "werewolf_discussion";
    yield this.emit("phase_changed", this.text("The werewolves open a private discussion.", "人狼たちが内通を始めました。"));

    const wolfSpeeches = orderedConcurrentMap(
      werewolves,
      this.prefetchConcurrency,
      async (wolf) => {
        const targets = this.werewolfAttackTargets();
        const contextLines = [
          this.text(
            `Known werewolves: ${werewolves.map((player) => player.name).join(", ")}.`,
            `把握している人狼: ${werewolves.map((player) => player.name).join(", ")}。`
          ),
          this.text(
            `Possible victims: ${targets.map((player) => player.name).join(", ")}.`,
            `襲撃候補: ${targets.map((player) => player.name).join(", ")}。`
          ),
          this.text(
            "Choose the kill that helps the wolf team erase the village and gives tomorrow's public acting the cleanest cover.",
            "村人を全排除するため、明日の昼に人間側として演じやすい襲撃先を選んでください。"
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
          contextLines
        );
        return { wolf, speech };
      },
      this.progressReporter("werewolf_discussion", this.text("Werewolf private discussion", "人狼の内通"))
    );

    for await (const { wolf, speech } of wolfSpeeches) {
      this.wolfHistory.push(`${wolf.name}: ${speech.messages.join(" ")}`);
      for (const [index, message] of speech.messages.entries()) {
        yield this.emit("player_speech", message, speechEventData(speech, message, index, "werewolf"), wolf);
      }
    }
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
        "Choose one living player to protect from the werewolf attack tonight.",
        "今夜の人狼襲撃から守る生存者を一人選んでください。"
      ),
      blocked
        ? this.text(
            `You cannot protect ${blocked} again because you protected them last night.`,
            `${blocked}は昨夜護衛したため、連続では守れません。`
          )
        : this.text("No one is blocked by consecutive protection.", "連続護衛で除外される対象はいません。")
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
  ): Promise<Player | null> {
    const actionPhase = this.phase;
    const targets = this.werewolfAttackTargets();
    if (werewolves.length === 0 || targets.length === 0) {
      return null;
    }

    const legalTargetIds = new Set(targets.map((player) => player.id));
    const votes: VoteRecord[] = [];
    const collectWolfVote = async (wolf: Player, raceSlots = this.prefetchConcurrency): Promise<VoteRecord | null> => {
      const contextLines = [
        this.text(
          `Known werewolves: ${werewolves.map((player) => player.name).join(", ")}.`,
          `把握している人狼: ${werewolves.map((player) => player.name).join(", ")}。`
        ),
        this.text("Vote for the player the werewolf team should kill tonight.", "今夜、人狼チームが襲撃する相手に投票してください。")
      ];
      const decision = await this.withPhase(actionPhase, () => {
        const context = this.contextFor(wolf, contextLines);
        return this.raceChooseTarget(wolf, this.text("Werewolf night kill vote", "人狼の夜襲撃投票"), context, targets, false, contextLines, raceSlots);
      });
      return decision.targetId && legalTargetIds.has(decision.targetId)
        ? { voterId: wolf.id, targetId: decision.targetId, reason: decision.reason }
        : null;
    };

    for await (const vote of orderedConcurrentDecisionMap(
      werewolves,
      this.prefetchConcurrency,
      (wolf, _index, raceSlots) => collectWolfVote(wolf, raceSlots),
      onProgress
    )) {
      if (vote) {
        votes.push(vote);
      }
    }

    if (votes.length === 0) {
      return sample(targets);
    }

    const candidates = topVoted(tallyVotes(votes));
    return this.requirePlayer(sample(candidates));
  }

  private humanAttackProtectionLastRound(): number {
    return Math.max(0, Math.min(humanAttackProtectionRoundByPlayerCount(this.config.playerCount), this.config.maxRounds - 1));
  }

  private isProtectedHumanAttackTarget(player: Player): boolean {
    return this.config.humanPlayerId === player.id && player.camp === "village" && this.round <= this.humanAttackProtectionLastRound();
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
      this.text("Choose one living player to check tonight.", "今夜占う生存者を一人選んでください。")
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
    seer.seerResults[target.id] = target.camp;
    seer.seerResultRounds[target.id] = resultRound;
    seer.memories.push(
      this.text(
        `Round ${resultRound}: ${target.name} checked as ${target.camp}.`,
        `第${resultRound}ラウンド: ${target.name}は${this.campText(target.camp)}判定。`
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

  private async prepareWitchAction(killTarget: Player | null): Promise<PreparedWitchAction | null> {
    const witch = this.alivePlayers().find((player) => player.role === "Witch");
    if (!witch || !canUseAbilities(this.ruleState, witch.id)) {
      return null;
    }

    if (killTarget && this.witchState.savePotion) {
      const contextLines = [
        this.text(
          `${killTarget.name} will be killed by werewolves tonight.`,
          `${killTarget.name}が今夜人狼に襲撃されます。`
        ),
        this.text("Decide whether to spend your only save potion.", "一度だけ使える蘇生薬を使うか判断してください。")
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
          this.text(`Use the save potion on ${killTarget.name}?`, `${killTarget.name}に蘇生薬を使いますか？`),
          context,
          contextLines
        );
      });
      if (save) {
        return { kind: "save", witch, target: killTarget };
      }
    }

    if (this.witchState.poisonPotion) {
      const poisonTargets = this.alivePlayers().filter(
        (player) => player.id !== witch.id && !this.isProtectedHumanNightDeathTarget(player)
      );
      if (poisonTargets.length === 0) {
        return null;
      }
      const legalPoisonTargetIds = new Set(poisonTargets.map((player) => player.id));
      const contextLines = [
        this.text("You may spend your only poison potion tonight, or skip.", "今夜、一度だけ使える毒薬を使うか、見送るか選べます。"),
        killTarget
          ? this.text(`The werewolf victim is ${killTarget.name}.`, `人狼の襲撃先は${killTarget.name}です。`)
          : this.text("No werewolf victim is known.", "人狼の襲撃先は不明です。")
      ];
      const decision = await this.withPhase("witch_action", () => {
        const context = this.contextFor(witch, contextLines, {
          witch: {
            savePotion: this.witchState.savePotion,
            poisonPotion: this.witchState.poisonPotion,
            attackedTarget: killTarget ? { id: killTarget.id, name: killTarget.name } : null
          }
        });
        return this.raceChooseTarget(witch, this.text("Witch poison potion", "魔女の毒薬"), context, poisonTargets, true, contextLines);
      });
      if (decision.targetId && legalPoisonTargetIds.has(decision.targetId)) {
        const target = this.requirePlayer(decision.targetId);
        return { kind: "poison", witch, target, reason: decision.reason };
      }
    }

    return null;
  }

  private applyWitchAction(prepared: PreparedWitchAction | null): { savedTarget: string | null; events: GameEvent[] } {
    if (!prepared || !prepared.witch.alive || prepared.witch.role !== "Witch" || !canUseAbilities(this.ruleState, prepared.witch.id)) {
      return { savedTarget: null, events: [] };
    }

    this.phase = "witch_action";
    if (prepared.kind === "save") {
      if (!prepared.target.alive || !this.witchState.savePotion) {
        return { savedTarget: null, events: [] };
      }
      this.witchState.savePotion = false;
      this.witchState.savedTargetId = prepared.target.id;
      prepared.witch.memories.push(
        this.text(`Round ${this.round}: saved ${prepared.target.name}.`, `第${this.round}ラウンド: ${prepared.target.name}を救いました。`)
      );
      return {
        savedTarget: prepared.target.id,
        events: [
          this.emit(
            "night_action",
            this.text(`${prepared.witch.name} used the save potion.`, `${prepared.witch.name}が蘇生薬を使いました。`),
            { visibility: "private", action: "witch_save", savedTargetId: prepared.target.id, savedTargetName: prepared.target.name },
            prepared.witch,
            prepared.target
          )
        ]
      };
    }

    if (!prepared.target.alive || !this.witchState.poisonPotion) {
      return { savedTarget: null, events: [] };
    }
    this.witchState.poisonPotion = false;
    this.witchState.poisonTargetId = prepared.target.id;
    prepared.witch.memories.push(
      this.text(`Round ${this.round}: poisoned ${prepared.target.name}.`, `第${this.round}ラウンド: ${prepared.target.name}に毒薬を使いました。`)
    );
    return {
      savedTarget: null,
      events: [
        this.emit(
          "night_action",
          this.text(`${prepared.witch.name} used the poison potion.`, `${prepared.witch.name}が毒薬を使いました。`),
          {
            visibility: "private",
            action: "witch_poison",
            poisonTargetId: prepared.target.id,
            poisonTargetName: prepared.target.name,
            reason: prepared.reason
          },
          prepared.witch,
          prepared.target
        )
      ]
    };
  }

  private async *runWitchAction(killTarget: Player | null): AsyncGenerator<GameEvent, string | null> {
    const result = this.applyWitchAction(await this.prepareWitchAction(killTarget));
    for (const event of result.events) {
      yield event;
    }
    return result.savedTarget;
  }

  private async *runWolfBeautyCharmAction(wolfBeauty: Player): AsyncGenerator<GameEvent> {
    if (!wolfBeauty.alive || wolfBeauty.role !== "WolfBeauty" || !canUseAbilities(this.ruleState, wolfBeauty.id)) {
      return;
    }
    if ((this.ruleState.players[wolfBeauty.id]?.statuses ?? []).some((status) => status.kind === "charm_anchor")) {
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
        "Choose one living player to charm. If you die, that player dies with you.",
        "魅了する生存者を一人選んでください。あなたが死亡すると、その相手も道連れになります。"
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
    this.ruleState = applyStatusEffects(this.ruleState, [
      {
        playerId: wolfBeauty.id,
        addStatuses: [{ kind: "charm_anchor", sourceId: wolfBeauty.id, targetId: target.id, duration: "game" }]
      },
      {
        playerId: target.id,
        addStatuses: [{ kind: "charmed", sourceId: wolfBeauty.id, duration: "game" }]
      }
    ]);
    wolfBeauty.memories.push(
      this.text(
        `Round ${this.round}: charmed ${target.name}. Reason: ${decision.reason}`,
        `第${this.round}ラウンド: ${target.name}を魅了。理由: ${decision.reason}`
      )
    );
    yield this.emit(
      "night_action",
      this.text(`${wolfBeauty.name} charmed ${target.name}.`, `${wolfBeauty.name}が${target.name}を魅了しました。`),
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

  private async *runRavenAction(raven: Player): AsyncGenerator<GameEvent> {
    if (!raven.alive || raven.role !== "Raven" || !canUseAbilities(this.ruleState, raven.id)) {
      return;
    }

    const targets = this.alivePlayers().filter((player) => player.id !== raven.id);
    if (targets.length === 0) {
      return;
    }

    const contextLines = [
      this.text(
        "You may mark one living player, or skip. The mark adds one vote against them in the next vote.",
        "生存者一人に印を付けるか、見送れます。印を付けると、次の投票でその相手に1票が加算されます。"
      )
    ];
    const context = this.contextFor(raven, contextLines);
    const decision = await this.raceChooseTarget(raven, this.text("Raven mark", "鴉の印"), context, targets, true, contextLines);
    if (!decision.targetId) {
      return;
    }

    const target = this.requirePlayer(decision.targetId);
    this.ruleState = applyStatusEffects(this.ruleState, [
      {
        playerId: target.id,
        addStatuses: [{ kind: "raven_marked", sourceId: raven.id, duration: "round", count: 1 }]
      }
    ]);
    raven.memories.push(
      this.text(
        `Round ${this.round}: marked ${target.name}. Reason: ${decision.reason}`,
        `第${this.round}ラウンド: ${target.name}に印。理由: ${decision.reason}`
      )
    );
    yield this.emit(
      "night_action",
      this.text(`${raven.name} marked ${target.name}.`, `${raven.name}が${target.name}に印を付けました。`),
      {
        visibility: "private",
        action: "raven_mark",
        markedTargetId: target.id,
        markedTargetName: target.name,
        reason: decision.reason
      },
      raven,
      target
    );
  }

  private async *runDay(): AsyncGenerator<GameEvent> {
    const isOpeningLlmRound = this.round === 1 && this.config.provider === "llm";
    const openingPrefetch = isOpeningLlmRound ? this.getOrStartFirstDayOpeningSpeechPrefetch(this.round) : null;
    const speakers = this.daySpeakerOrder();
    const firstDayOpeningMoveByPlayerId = openingPrefetch?.openingMoveByPlayerId ?? this.firstDayOpeningMoveAssignments(speakers);

    // Before the public day breaks, the werewolf team meets privately so a human werewolf
    // learns who their allies are. Always runs on the first day's opening, independent of
    // agenda scheduling; a lone wolf (or an all-human wolf team) is a no-op. The first
    // public day line has already been requested above, so this face-off now overlaps
    // real day-discussion generation instead of delaying it.
    if (isOpeningLlmRound) {
      yield* this.runWerewolfFaceoffPass();
    }

    this.phase = "day_discussion";
    this.lastDiscussion = [];
    yield this.emit(
      "phase_changed",
      this.text(`Day ${this.round} begins.`, `${this.round}日目の昼が始まりました`)
    );

    const publishSpeech = (player: Player, speech: AgentSpeech, discussionPass: number, discussionPasses: number): GameEvent[] => {
      this.publicHistory.push(this.formatSpeechHistory(player, speech));
      this.lastDiscussion.push({
        playerId: player.id,
        playerName: player.name,
        message: speech.messages.join(" "),
        metadata: speech.metadata
      });
      return speech.messages.map((message, index) =>
        this.emit(
          "player_speech",
          message,
          speechEventData(speech, message, index, undefined, {
            discussionPass,
            discussionPasses,
            ...(discussionPass > regularDayDiscussionPasses ? { discussionFollowUp: true } : {})
          }),
          player
        )
      );
    };
    const openingSpeaker = this.firstAiDayOpeningSpeaker(speakers, firstDayOpeningMoveByPlayerId);
    let prefetchedOpeningSpeech =
      openingPrefetch && openingSpeaker?.id === openingPrefetch.openingSpeakerId ? openingPrefetch.promise : null;
    if (prefetchedOpeningSpeech) {
      this.firstDayOpeningSpeechPrefetch = null;
    }

    // Keep the "day zero" greetings even without the old director layer. They give the
    // player something to read while the first real public line is already being generated,
    // but they are not fed back into publicHistory/lastDiscussion and therefore cannot
    // become fake evidence.
    if (isOpeningLlmRound) {
      if (!prefetchedOpeningSpeech && openingSpeaker) {
        prefetchedOpeningSpeech = this.generateDayDiscussionSpeech(openingSpeaker, 1, firstDayOpeningMoveByPlayerId);
        prefetchedOpeningSpeech.catch(() => undefined);
      }
      yield* this.runFirstDayWarmupPass();
    }

    for (let discussionPass = 1; discussionPass <= regularDayDiscussionPasses; discussionPass += 1) {
      let passSpeakers = speakers;
      if (discussionPass === 1 && firstDayOpeningMoveByPlayerId.size > 0) {
        if (openingSpeaker) {
          const { player, speech } = await (prefetchedOpeningSpeech ??
            this.generateDayDiscussionSpeech(openingSpeaker, discussionPass, firstDayOpeningMoveByPlayerId));
          for (const event of publishSpeech(player, speech, discussionPass, regularDayDiscussionPasses)) {
            yield event;
          }
          passSpeakers = speakers.filter((player) => player.id !== openingSpeaker.id);
        }
      }

      for await (const { player, speech } of this.raceAiWithHumanLast(
        passSpeakers,
        (player, options) => this.generateDayDiscussionSpeech(player, discussionPass, firstDayOpeningMoveByPlayerId, options),
        this.progressReporter("day_speech", this.text("Day discussion", "昼議論"), {
          pass: discussionPass,
          passes: regularDayDiscussionPasses
        })
      )) {
        for (const event of publishSpeech(player, speech, discussionPass, regularDayDiscussionPasses)) {
          yield event;
        }
      }
    }

    const followUpSpeakers = this.dayDiscussionFollowUpSpeakers(speakers);
    if (followUpSpeakers.length > 0) {
      for await (const { player, speech } of this.raceAiWithHumanLast(
        followUpSpeakers,
        (player, options) => this.generateDayDiscussionSpeech(player, followUpDayDiscussionPass, firstDayOpeningMoveByPlayerId, options),
        this.progressReporter("day_speech", this.text("Day discussion follow-up", "昼議論の追加発言"), {
          pass: followUpDayDiscussionPass,
          passes: followUpDayDiscussionPass
        })
      )) {
        for (const event of publishSpeech(player, speech, followUpDayDiscussionPass, followUpDayDiscussionPass)) {
          yield event;
        }
      }
    }

    yield* this.runVoting();
  }

  // Day runs before night each round, so round 1's day has no preceding night to report.
  private nightDeathContextLine(): string {
    if (this.round <= 1) {
      return this.text("The game has just begun; no one has died yet.", "ゲームが始まりました。まだ犠牲者はいません。");
    }
    const deathNames = this.lastNightDeaths.map((id) => this.requirePlayer(id).name);
    return deathNames.length > 0
      ? this.text(`Last night, ${deathNames.join(", ")} died.`, `昨夜、${deathNames.join(", ")}が死亡しました。`)
      : this.text("No one died last night.", "昨夜は誰も死亡しませんでした。");
  }

  private firstDayOpeningMoveAssignments(speakers: Player[]): Map<string, FirstDayOpeningMoveKind> {
    if (this.round !== 1 || speakers.length === 0) {
      return new Map();
    }
    // Give every round-one first-pass speaker a distinct opening move so the table
    // covers varied natural topics instead of degenerating into "様子見"/"保留" filler.
    // Werewolves are special in the player-facing game: at least two thirds of the
    // living wolf team open by acting explicitly human-side or by floating a fake
    // village-role claim, so the user can enjoy the allies' public performance.
    const assignments = new Map<string, FirstDayOpeningMoveKind>();
    const wolfSpeakers = speakers.filter((speaker) => speaker.camp === "werewolf");
    const wolfClaimCount = Math.ceil((wolfSpeakers.length * 2) / 3);
    const wolfClaimSpeakers = shuffle(wolfSpeakers).slice(0, wolfClaimCount);
    for (const [index, speaker] of wolfClaimSpeakers.entries()) {
      assignments.set(speaker.id, firstDayWerewolfOpeningMoveKinds[index % firstDayWerewolfOpeningMoveKinds.length]);
    }

    const kinds = [...firstDayOpeningMoveKinds];
    const offset = Math.floor(Math.random() * kinds.length);
    let cursor = 0;
    for (const speaker of speakers) {
      if (assignments.has(speaker.id)) {
        continue;
      }
      assignments.set(speaker.id, kinds[(offset + cursor) % kinds.length]);
      cursor += 1;
    }
    return assignments;
  }

  // Day-1 warm-up: a quick round of AI-only self-introductions/greetings, streamed as
  // they finish (same speculative race as the real discussion). It is a day-zero buffer
  // for perceived LLM latency, not public discussion evidence. Humans are excluded —
  // they join from the first real pass. Every living AI player speaks once.
  // Distinct opening angles so independent intro generations don't all start the same way.
  private firstDayIntroAngles(): string[] {
    return this.isJapanese()
      ? [
          "名前を名乗ってから、ひとことだけ。",
          "短い意気込みから入る。",
          "軽いぼやきや冗談を交えて。",
          "全体への呼びかけから入る。",
          "とにかく端的に、短く。",
          "今日の抱負をひとこと。",
          "気さくに、ゆるい雰囲気で。",
          "自分の関心事をひとこと添えて。"
        ]
      : [
          "Lead with your name, then one line.",
          "Open with a short bit of resolve.",
          "Slip in a light quip or grumble.",
          "Open by addressing the whole table.",
          "Keep it blunt and very short.",
          "State one hope for today.",
          "Be breezy and easygoing.",
          "Add one thing you care about."
        ];
  }

  // First-day opening: before the public day breaks, the werewolf team holds a brief private
  // face-to-face so a human werewolf learns who their allies are (and which special wolf each
  // one is). Secret to the werewolf camp (visibility "werewolf") — villagers never see it.
  // AI wolves use fast single-call intros. A human werewolf may enter an optional greeting, but
  // it is display-only input and intentionally does not gate or feed later generation.
  private async *runWerewolfFaceoffPass(): AsyncGenerator<GameEvent> {
    const werewolves = this.alivePlayers().filter((player) => player.camp === "werewolf");
    // A lone wolf has no allies to meet, and the player already knows their own role.
    if (werewolves.length <= 1) {
      return;
    }
    const aiWerewolves = werewolves.filter((player) => !this.isHumanControlledPlayer(player));
    const humanWerewolf = werewolves.find((player) => this.isHumanControlledPlayer(player));
    if (aiWerewolves.length === 0 && !humanWerewolf) {
      return;
    }

    this.phase = "werewolf_discussion";
    yield this.emit(
      "phase_changed",
      this.text("Before dawn, the werewolves meet face to face.", "夜明け前、人狼たちが顔を合わせます。"),
      { visibility: "werewolf" }
    );

    for await (const { wolf, speech } of orderedConcurrentMap(
      aiWerewolves,
      this.prefetchConcurrency,
      async (wolf) => ({ wolf, speech: await this.safeWerewolfFaceoff(wolf, werewolves) }),
      this.progressReporter("werewolf_discussion", this.text("Werewolf introductions", "人狼の顔合わせ"))
    )) {
      this.wolfHistory.push(`${wolf.name}: ${speech.messages.join(" ")}`);
      for (const [index, message] of speech.messages.entries()) {
        yield this.emit("player_speech", message, speechEventData(speech, message, index, "werewolf"), wolf);
      }
    }

    if (humanWerewolf) {
      this.requestHumanWerewolfGreeting(humanWerewolf, werewolves);
    }
  }

  private async *runFirstDayWarmupPass(): AsyncGenerator<GameEvent> {
    const aiSpeakers = this.daySpeakerOrder().filter((player) => !this.isHumanControlledPlayer(player));
    if (aiSpeakers.length === 0) {
      return;
    }
    const angles = this.firstDayIntroAngles();
    const angleOffset = Math.floor(Math.random() * angles.length);
    const angleByPlayerId = new Map(aiSpeakers.map((player, index) => [player.id, angles[(angleOffset + index) % angles.length]]));
    for await (const { player, speech } of this.raceAiWithHumanLast(
      aiSpeakers,
      (player, options) =>
        this.safeImproviseIntro(player, options?.signal, options?.speculative, angleByPlayerId.get(player.id)).then((speech) => ({
          player,
          speech
        })),
      this.progressReporter("day_speech", this.text("Greetings before the discussion", "議論前の挨拶"))
    )) {
      for (const [index, message] of speech.messages.entries()) {
        yield this.emit("player_speech", message, speechEventData(speech, message, index, undefined, { warmup: true }), player);
      }
    }
  }

  private async *runVoting(): AsyncGenerator<GameEvent> {
    this.phase = "voting";
    yield this.emit("phase_changed", this.text("Voting begins.", "投票が始まりました。"));

    const votes: VoteRecord[] = [];
    const livingPlayers = this.alivePlayers();
    const voters = livingPlayers.filter((player) => !this.ruleState.players[player.id]?.statuses.some((status) => status.kind === "no_vote"));
    const collectVote = async (voter: Player, raceSlots = this.prefetchConcurrency): Promise<{ voter: Player; decision: TargetDecision } | null> => {
      const targets = livingPlayers.filter((player) => player.id !== voter.id);
      if (targets.length === 0) {
        return null;
      }
      const contextLines = [
        this.nightDeathContextLine(),
        this.text(
          "This is the final decision right before voting after today's public discussion.",
          "これは今日の公開議論後、投票直前の最終判断です。"
        ),
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
      const decision = await this.raceChooseTarget(voter, this.text("Day elimination vote", "昼の処刑投票"), context, targets, false, contextLines, raceSlots);
      return { voter, decision };
    };
    const voteResults = this.orderedAiDecisionWithHumanBoundary(
      voters,
      (voter) => voter.id,
      (voter, _index, raceSlots) => collectVote(voter, raceSlots),
      this.progressReporter("day_vote", this.text("Day elimination vote", "昼の処刑投票"))
    );

    for await (const result of voteResults) {
      const targetId = result?.decision.targetId;
      if (!result || !targetId) {
        continue;
      }
      const { voter, decision } = result;
      votes.push({ voterId: voter.id, targetId, reason: decision.reason });
      const target = this.requirePlayer(targetId);
      voter.memories.push(
        this.text(
          `Round ${this.round}: voted for ${target.name}. Reason: ${decision.reason}`,
          `第${this.round}ラウンド: ${target.name}へ投票。理由: ${decision.reason}`
        )
      );
      yield this.emit(
        "vote_cast",
        this.text(`${voter.name} votes for ${target.name}.`, `${voter.name}が${target.name}に投票しました。`),
        {},
        voter,
        target
      );
    }

    const eligibleVotes = filterEligibleVotes(votes, this.ruleState);
    const voteModifiers = voteModifiersFromRuleState(this.ruleState);
    this.lastVotes = eligibleVotes;
    this.lastVoteModifiers = voteModifiers;
    if (eligibleVotes.length === 0 && voteModifiers.length === 0) {
      yield this.emit("vote_result", this.text("No votes were cast.", "投票はありませんでした。"), { votes: [] });
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
      this.ruleState = expireStatuses(this.ruleState, "round");
      return;
    }

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
        return player.alive && !blockedTargetIds.has(playerId) && !this.isProtectedHumanNightDeathTarget(player);
      }
    });
    const blocked = new Set([...blockedTargetIds, ...deaths.map((death) => death.playerId)]);

    for (const death of deaths) {
      const player = this.requirePlayer(death.playerId);
      blocked.delete(death.playerId);
      if (!markPlayerDead(player)) {
        continue;
      }
      if (this.phase !== "voting") {
        this.lastNightDeaths.push(death.playerId);
        this.lastNightDeathRecords.push(death);
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
          yield this.emit(
            "system",
            this.text(
              `${player.name}'s vote elimination fulfilled their neutral win condition.`,
              `${player.name}は投票処刑で中立勝利条件を満たしました。`
            ),
            {
              action: "neutral_victory_claim",
              winnerCamp: "neutral",
              winnerIds: effect.victoryClaims.flatMap((claim) => claim.winnerIds),
              sourceId: player.id,
              sourceName: player.name
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
    const deathShotRole = hunter.role === "AlphaWolf" ? this.text("Alpha Wolf", "アルファ人狼") : this.text("Hunter", "ハンター");
    const contextLines = [
      this.text(
        `You died as the ${deathShotRole} and may shoot one living player before leaving the game.`,
        `あなたは${deathShotRole}として死亡しました。退場前に生存者を一人撃てます。`
      ),
      this.text(
        `Legal shot targets: ${targets.map((player) => player.name).join(", ")}.`,
        `撃てる対象: ${targets.map((player) => player.name).join(", ")}。`
      )
    ];
    const context = this.contextFor(hunter, contextLines);
    const action = hunter.role === "AlphaWolf" ? this.text("Alpha Wolf death shot", "アルファ人狼の道連れ") : this.text("Hunter death shot", "ハンターの道連れ");
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

  private checkVictory(): { camp: Camp; winnerCamp: CampId; winnerIds: string[]; reason: string } | null {
    const loverResult = checkLoverVictory(this.players, this.ruleState);
    if (loverResult) {
      return {
        camp: loverResult.fallbackCamp,
        winnerCamp: loverResult.camp,
        winnerIds: loverResult.winnerIds,
        reason: this.text("Only the lovers remain alive.", "恋人だけが生存しています。")
      };
    }

    const neutralResult = checkNeutralVictory(this.players, this.ruleState);
    if (neutralResult) {
      return {
        camp: neutralResult.fallbackCamp,
        winnerCamp: neutralResult.camp,
        winnerIds: neutralResult.winnerIds,
        reason: this.text("A neutral role fulfilled its victory condition.", "中立役職が勝利条件を満たしました。")
      };
    }

    const result = checkStandardVictory(this.players);
    if (!result) {
      return null;
    }
    if (result.reason === "all_werewolves_eliminated") {
      return {
        camp: "village",
        winnerCamp: "village",
        winnerIds: result.winnerIds,
        reason: this.text("All werewolves have been eliminated.", "すべての人狼が排除されました。")
      };
    }
    return {
      camp: "werewolf",
      winnerCamp: "werewolf",
      winnerIds: result.winnerIds,
      reason: this.text(
        `Werewolves (${result.counts.werewolf}) equal or outnumber villagers (${result.counts.village}).`,
        `狼陣営の人数(${result.counts.werewolf})が人間側の人数(${result.counts.village})以上になりました。`
      )
    };
  }

  private finishGame(result: { camp: Camp; winnerCamp?: CampId; winnerIds?: string[]; reason: string }): GameEvent {
    this.winner = result.camp;
    this.winnerCamp = result.winnerCamp ?? result.camp;
    this.winnerIds = result.winnerIds ?? this.alivePlayers().filter((player) => player.camp === result.camp).map((player) => player.id);
    this.phase = "ended";
    return this.emit("game_ended", this.text(`${this.winnerCamp} wins. ${result.reason}`, `${this.campText(this.winnerCamp)}の勝利です。${result.reason}`), {
      winner: result.camp,
      winnerCamp: this.winnerCamp,
      winnerIds: this.winnerIds,
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
            `Private role info: Lover partner is ${partner.name} (${partner.alive ? "alive" : "dead"}).`,
            `自分だけの役職情報: 恋人の相方は${partner.name}です（${partner.alive ? "生存" : "死亡"}）。`
          )
        );
      }
    }

    if (player.role === "Jester") {
      roleNotes.push(
        this.text(
          "Private role info: You are the Jester. You win alone if the day vote executes you.",
          "自分だけの役職情報: あなたは道化師です。昼の投票で処刑されると単独勝利です。"
        )
      );
    }

    return roleNotes.length > 0 ? [...player.memories, ...roleNotes] : player.memories;
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
    const requestAbort = mergeAbortSignals(this.abortSignal, abortSignal);
    const requestAbortSignal = requestAbort.signal;
    const input = {
      player,
      phase: this.phase,
      task,
      context,
      uiContext,
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
    emitSpeechAttemptDiagnostic({ kind: "speech_started" });
    try {
      attempts += 1;
      const speech = this.sanitizeSpeechForPhase(await agent.speak(input), legalPlayers);
      if (requestAbortSignal?.aborted) {
        throw new Error("Speech request cancelled.");
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
      return this.sanitizeSpeechForPhase(buildSimpleFallbackSpeech(input, this.config.language), legalPlayers);
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

  // Generates a single short day-1 warm-up self-intro for one player. It is just a
  // greeting, so it stays separate from normal public discussion generation.
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
        "It's your turn for a quick, one-line self-introduction before the discussion. Keep it short, varied, and in your own voice. Leave roles, suspicions, and votes for the discussion.",
        "あなたの番です。議論の前に、短い自己紹介を一言だけ。切り出し方に変化を出し、自分らしい言い回しで短く。役職・疑い・投票の話はまだしない。"
      ),
      // Each warm-up speaker gets a different opening angle so independent generations
      // don't all converge on the same first line.
      ...(angle ? [this.text(`Opening angle (vary from others): ${angle}`, `今回の切り出し方（他の人と変える）: ${angle}`)] : [])
    ];
    const input: AgentSpeechInput = {
      player,
      phase: this.phase,
      task: this.text("Give a short self-introduction and greeting.", "短い自己紹介と挨拶をしてください。"),
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
      const speech = this.sanitizeSpeechForPhase(await generate(input), legalPlayers);
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
      return this.sanitizeSpeechForPhase(await fallbackAgent.improviseIntro!(input), legalPlayers);
    } finally {
      requestAbort.cleanup();
    }
  }

  // Generates one wolf's first-day face-off intro: allies-only, so the wolf greets the team,
  // owns their role, and previews their public act (no attack targets/plans yet). Like safeImproviseIntro
  // this is a fast single call (no reasoning stage). Agents without improviseWerewolfIntro
  // fall back to a plain role-owning line via the fallback agent.
  private async safeWerewolfFaceoff(
    player: Player,
    werewolves: Player[],
    abortSignal?: AbortSignal,
    speculative = false
  ): Promise<AgentSpeech> {
    this.throwIfCancelled();
    const agent = this.agents.get(player.id) ?? fallbackAgent;
    const legalPlayers = this.speechLegalPlayers(player).map(({ id, name }) => ({ id, name }));
    const requestAbort = mergeAbortSignals(this.abortSignal, abortSignal);
    const contextLines = this.werewolfFaceoffContextLines(werewolves);
    const input: AgentSpeechInput = {
      player,
      phase: this.phase,
      task: this.text(
        "Introduce yourself to your werewolf allies and preview your public deception.",
        "人狼陣営の仲間に自己紹介し、昼にどう騙すかを短く宣言してください。"
      ),
      context: this.contextFor(player, contextLines),
      uiContext: contextLines,
      knownPlayers: this.players.map(({ id, name }) => ({ id, name })),
      legalPlayers,
      publicHistory: this.publicHistory,
      privateHistory: player.memories,
      abortSignal: requestAbort.signal
    };
    try {
      const generate = agent.improviseWerewolfIntro
        ? agent.improviseWerewolfIntro.bind(agent)
        : agent.improviseIntro
          ? agent.improviseIntro.bind(agent)
          : agent.speak.bind(agent);
      const speech = this.sanitizeSpeechForPhase(await generate(input), legalPlayers);
      if (requestAbort.signal?.aborted) {
        throw new Error("Werewolf face-off request cancelled.");
      }
      return speech;
    } catch (error) {
      if (this.abortSignal?.aborted || requestAbort.signal?.aborted) {
        throw error;
      }
      if (!speculative) {
        console.warn(`[faceoff] ${player.name}: ${error instanceof Error ? error.message : String(error)} — using fallback intro.`);
      }
      return this.sanitizeSpeechForPhase(await fallbackAgent.improviseWerewolfIntro!(input), legalPlayers);
    } finally {
      requestAbort.cleanup();
    }
  }

  private werewolfFaceoffContextLines(werewolves: Player[]): string[] {
    const teamRoster = werewolves
      .map((wolf) => `${wolf.name}（${roleLabel(wolf.role, this.config.language)}）`)
      .join("、");
    return [
      this.text(
        "This is a private, allies-only werewolf meeting before the first day opens.",
        "ここは初日が始まる前、人狼陣営だけの内緒の顔合わせです。"
      ),
      this.text(
        `Your werewolf allies: ${werewolves.map((wolf) => `${wolf.name} (${wolf.role})`).join(", ")}.`,
        `あなたの人狼陣営の仲間: ${teamRoster}。`
      ),
      this.text(
        "Greet your allies, clearly own your own role, and add one short line about the public act you will perform. Do not discuss attack targets or detailed plans yet.",
        "仲間に挨拶し、自分の役職をはっきり名乗り、昼にどんな人間側の演技をするか一言だけ添えてください。襲撃先や細かい作戦の相談はまだしません。"
      )
    ];
  }

  private requestHumanWerewolfGreeting(player: Player, werewolves: Player[]): void {
    const handler = this.humanInput;
    if (!handler) {
      return;
    }

    const contextLines = this.werewolfFaceoffContextLines(werewolves);
    void handler
      .request({
        kind: "speech_choice",
        speechMode: "werewolf_greeting",
        nonBlocking: true,
        playerId: player.id,
        playerName: player.name,
        phase: this.phase,
        role: player.role,
        task: this.text(
          "Enter a greeting and deception line for your werewolf allies.",
          "人狼陣営の仲間へ、挨拶と昼にどう騙すかを入力してください。"
        ),
        context: buildHumanInputContext({
          uiContext: contextLines,
          publicHistory: [],
          privateHistory: this.humanVisiblePrivateHistory(player)
        }),
        options: []
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (this.abortSignal?.aborted || message === "Human input session was closed.") {
          return;
        }
        console.warn(`[human-greeting] ${player.name}: ${message}; continuing without greeting.`);
      });
  }

  // Public discussion keeps tempo by drafting in-character candidate lines before the player acts.
  // The player may still override with free text; unlike the face-off greeting, public speech is
  // published into the normal discussion history.
  private async humanChoiceSpeak(
    player: Player,
    input: AgentSpeechInput,
    legalPlayers: TargetCandidate[]
  ): Promise<AgentSpeech> {
    const shadow = this.humanChoiceAgent;
    const handler = this.humanInput;
    const lockFreeText = shouldLockHumanWerewolfOpeningToChoices(input);
    if (!shadow || !handler) {
      return this.sanitizeSpeechForPhase(defaultHumanHoldSpeech(this.config.language), legalPlayers);
    }

    let candidates: AgentSpeech[];
    try {
      // One racer drafts the whole 3-option set. We run several racers in parallel and
      // keep the first complete set to finish, aborting the slower racers — the same
      // decision-race pattern the AI night/vote choices use.
      const raceSlots = this.shouldRaceHumanChoice(shadow) ? this.prefetchConcurrency : 1;
      candidates = await this.firstFinishedDecisionRace(
        player,
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
        this.sanitizeSpeechForPhase(this.simpleSpeechFallback(input, legalPlayers, input.speechPlan), legalPlayers)
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
      allowFreeText: !lockFreeText,
      options: candidates.map((candidate, index) => ({
        id: String(index),
        text: candidate.messages.join("\n")
      }))
    });

    const chosenIndex = resolveSpeechChoiceIndex(response.choiceId, candidates.length);
    const customSpeech = lockFreeText ? null : humanFreeTextSpeech(response.speech, this.config.language);
    if (customSpeech) {
      return this.sanitizeSpeechForPhase(customSpeech, legalPlayers);
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

  private sanitizeSpeechForPhase(speech: AgentSpeech, legalPlayers: TargetCandidate[]): AgentSpeech {
    const legalIds = new Set(legalPlayers.map((candidate) => candidate.id));
    const speechText = speech.messages.join(" ");
    return {
      ...speech,
      metadata: {
        ...speech.metadata,
        suspects: speech.metadata.suspects.filter((read) => legalIds.has(read.targetId)),
        trusts: speech.metadata.trusts.filter((read) => legalIds.has(read.targetId)),
        claims: speech.metadata.claims.filter((claim) => claimMetadataVisibleInSpeech(claim, speechText, this.config.language))
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
    raceSlots = this.prefetchConcurrency
  ): Promise<TargetDecision> {
    const decisionRaceSlots = this.normalizedDecisionRaceSlots(raceSlots);
    if (!this.shouldRaceAiDecision(player) || decisionRaceSlots <= 1) {
      return this.safeChooseTarget(player, action, context, candidates, allowSkip, uiContext);
    }

    return this.firstFinishedDecisionRace(
      player,
      (options) =>
        this.safeChooseTarget(player, action, context, candidates, allowSkip, uiContext, {
          abortSignal: options?.signal,
          suppressMemorySideEffects: options?.speculative
        }),
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
    const requestAbort = mergeAbortSignals(this.abortSignal, options.abortSignal);
    const requestAbortSignal = requestAbort.signal;
    const input = {
      player,
      phase: this.phase,
      action,
      context,
      uiContext,
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
      player,
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
    const requestAbort = mergeAbortSignals(this.abortSignal, options.abortSignal);
    const requestAbortSignal = requestAbort.signal;
    const input = {
      player,
      phase: this.phase,
      question,
      context,
      uiContext,
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
          `Claims: ${speech.metadata.claims.map((claim) => this.formatClaimSummary(player.name, claim)).join("; ")}`,
          `主張: ${speech.metadata.claims.map((claim) => this.formatClaimSummary(player.name, claim)).join("; ")}`
        )
      );
    }
    if (speech.metadata.suspects.length > 0) {
      parts.push(
        this.text(
          `Suspects: ${speech.metadata.suspects.map((read) => `${read.targetName ?? read.targetId}${read.reason ? ` (${read.reason})` : ""}`).join(", ")}`,
          `疑い先: ${speech.metadata.suspects.map((read) => `${read.targetName ?? read.targetId}${read.reason ? ` (${read.reason})` : ""}`).join(", ")}`
        )
      );
    }
    if (speech.metadata.trusts.length > 0) {
      parts.push(
        this.text(
          `Trusts: ${speech.metadata.trusts.map((read) => `${read.targetName ?? read.targetId}${read.reason ? ` (${read.reason})` : ""}`).join(", ")}`,
          `信頼先: ${speech.metadata.trusts.map((read) => `${read.targetName ?? read.targetId}${read.reason ? ` (${read.reason})` : ""}`).join(", ")}`
        )
      );
    }
    return parts.join(" ");
  }

  private async emitRoundSummary(): Promise<GameEvent> {
    const summary = this.buildRoundSummary();
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

  private buildRoundSummary(): { message: string; data: Record<string, unknown> } {
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
    return this.text(
      `${result.targetName ?? result.targetId} checked ${result.camp}${roundText}`,
      `${result.targetName ?? result.targetId}は${this.campText(result.camp)}判定${roundText}`
    );
  }

  private contextFor(
    player: Player,
    extra: string[] = [],
    secretOverride: RoleSecretContext = {},
    speechPlan?: PublicSpeechPlan
  ): string {
    return buildBaseContext({
      player,
      phase: this.phase,
      round: this.round,
      alivePlayers: this.alivePlayers().map(({ id, name }) => ({ id, name })),
      deadPlayers: this.players
        .filter((candidate) => !candidate.alive)
        .map(({ id, name, role }) => ({ id, name, role })),
      publicHistory: this.publicHistory,
      privateHistory: player.memories,
      language: this.config.language,
      secret: this.secretContextFor(player, secretOverride),
      speechPlan,
      extra
    });
  }

  private secretContextFor(player: Player, override: RoleSecretContext = {}): RoleSecretContext {
    const base: RoleSecretContext = {};

    if (player.camp === "werewolf") {
      base.werewolfAllies = this.players
        .filter((candidate) => candidate.camp === "werewolf")
        .map(({ id, name, alive }) => ({ id, name, alive }));
    }

    if (player.role === "Seer") {
      base.seerResults = Object.entries(player.seerResults).map(([targetId, camp]) => {
        const target = this.requirePlayer(targetId);
        return {
          targetId,
          targetName: target.name,
          camp,
          round: player.seerResultRounds[targetId]
        };
      });
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

    return {
      ...base,
      ...override,
      witch
    };
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
      for (const read of record.metadata.suspects) {
        const weight = typeof read.weight === "number" && Number.isFinite(read.weight) ? Math.max(0, read.weight) : 0;
        addScore(read.targetId, 2 + weight);
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

    return speakers
      .map((player) => ({
        player,
        score: scores.get(player.id) ?? 0,
        order: speakerOrder.get(player.id) ?? Number.MAX_SAFE_INTEGER
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, this.dayDiscussionFollowUpLimit(speakers.length))
      .map(({ player }) => player);
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
