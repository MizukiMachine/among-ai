import { createAgentFactory, DemoAgent, summarizeRoundWithLlm } from "./agents";
import { getCharacterProfile } from "./characters";
import { HumanInputAgent } from "./humanAgent";
import { campLabel, defaultLanguage, isJapaneseLanguage, roleLabel } from "./i18n";
import { reviewJapaneseOutput } from "./japaneseStyle";
import { buildBaseContext, type RoleSecretContext } from "./prompts";
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
import { addVictoryClaims, applyStatusEffects, canUseAbilities, createInitialRuleState, expireStatuses } from "./rules/state";
import { filterEligibleVotes, resolveVote, tallyVotes, topVoted, voteModifiersFromRuleState, type VoteModifier } from "./rules/voting";
import { adjudicateStandardVictory, checkLoverVictory, checkNeutralVictory, checkStandardVictory, countAliveByCamp } from "./rules/victory";
import { sample, shuffle } from "./random";
import type {
  Agent,
  AgentBooleanInput,
  AgentSpeech,
  AgentTargetInput,
  Camp,
  CampId,
  ClaimMetadata,
  DebugScenario,
  EventVisibility,
  GameConfig,
  GameEvent,
  GameSnapshot,
  GenerationProgress,
  GenerationProgressTask,
  HumanInputHandler,
  Persona,
  Phase,
  Player,
  Role,
  SpeechMetadata,
  SummaryMode,
  TargetCandidate,
  TargetDecision,
  VoteRecord
} from "./types";

const names = [
  "カズ",
  "カイ",
  "ミオ",
  "レン",
  "サキ",
  "タカ",
  "ユキ",
  "ケン",
  "リン",
  "アオ",
  "ナオ",
  "ハル",
  "リク",
  "メイ",
  "ソラ",
  "エマ",
  "シュン",
  "ノア",
  "ルイ",
  "マナ"
];
const personas: Persona[] = [
  "cautious", "aggressive", "logical", "opportunistic", "empathetic",
  "cautious", "logical", "aggressive", "empathetic"
];
const dayDiscussionPasses = 2;
const defaultAiPrefetchConcurrency = 3;
const maxAiPrefetchConcurrency = 20;

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

interface WerewolfGameOptions {
  humanInput?: HumanInputHandler;
  abortSignal?: AbortSignal;
  onProgress?: (progress: GenerationProgress) => void;
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

function forceVillageRoleForHuman(roles: Role[], humanPlayerId: string | null): Role[] {
  const humanIndex = playerIdIndex(humanPlayerId, roles.length);
  if (humanIndex === null || roleCamp(roles[humanIndex]) === "village") {
    return roles;
  }

  const swapIndex = roles.findIndex((role, index) => index !== humanIndex && roleCamp(role) === "village");
  if (swapIndex === -1) {
    return roles;
  }

  const forced = [...roles];
  [forced[humanIndex], forced[swapIndex]] = [forced[swapIndex], forced[humanIndex]];
  return forced;
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

function positiveIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
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
  return normalizePrefetchConcurrency(
    positiveIntEnv(process.env.ZAI_PREFETCH_CONCURRENCY ?? process.env.LLM_PREFETCH_CONCURRENCY, defaultAiPrefetchConcurrency)
  );
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

export class WerewolfGame {
  private readonly players: Player[];
  private readonly agents = new Map<string, Agent>();
  private readonly publicHistory: string[] = [];
  private readonly wolfHistory: string[] = [];
  private readonly config: GameConfig;
  private readonly abortSignal?: AbortSignal;
  private readonly onProgress?: (progress: GenerationProgress) => void;
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

  constructor(config: GameConfig, options: WerewolfGameOptions = {}) {
    this.abortSignal = options.abortSignal;
    this.onProgress = options.onProgress;
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
    const roles = forceVillageRoleForHuman(
      activeDebugScenario === "none"
        ? shuffle(createRoles(this.config.playerCount))
        : createScenarioRoles(activeDebugScenario, this.config.playerCount),
      this.config.humanPlayerId ?? null
    );
    const personaPool = Array.from({ length: this.config.playerCount }, (_, index) => personas[index % personas.length]);
    const assignedPersonas = activeDebugScenario === "none" ? shuffle(personaPool) : personaPool;
    const createAgent = createAgentFactory({
      provider: this.config.provider,
      model: this.config.model,
      language: this.config.language
    });

    this.players = roles.map((role, index) => {
      const name = names[index];
      const playerId = `p${index + 1}`;
      const agent =
        playerId === this.config.humanPlayerId && options.humanInput
          ? new HumanInputAgent(name, options.humanInput, this.config.language)
          : activeDebugScenario === "none"
          ? createAgent(name)
          : this.createScenarioAgent(name, activeDebugScenario, index);
      const profile = getCharacterProfile(playerId);
      const player: Player = {
        id: playerId,
        name,
        role,
        camp: roleCamp(role),
        persona: assignedPersonas[index],
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
      const targetsByIndex: Array<Array<string | null>> = [["p3"], ["p3"], ["p1"], [null], ["p4"], [], [], [], []];
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
    return (progress) => {
      this.onProgress?.({
        createdAt: new Date().toISOString(),
        round: this.round,
        phase: this.phase,
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

      yield* this.runNight();
      this.throwIfCancelled();
      const nightWinner = this.checkVictory();
      if (nightWinner) {
        yield this.finishGame(nightWinner);
        return;
      }

      yield* this.runDay();
      this.throwIfCancelled();
      const dayWinner = this.checkVictory();
      if (dayWinner) {
        yield this.finishGame(dayWinner);
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
    this.lastVotes = [];
    this.lastVoteModifiers = [];
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
        killTarget = await this.resolveWerewolfAttack(werewolves);
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

    const deaths = createNightDeathRecords({
      werewolfTargetId: killTarget?.id,
      savedTargetId: savedTarget,
      protectedTargetId: this.guardState.protectedTargetId,
      poisonTargetId: this.witchState.poisonTargetId
    });

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
        const targets = this.alivePlayers().filter((player) => player.camp !== "werewolf");
        const contextLines = [
          this.text(
            `Known werewolves: ${werewolves.map((player) => player.name).join(", ")}.`,
            `把握している人狼: ${werewolves.map((player) => player.name).join(", ")}。`
          ),
          this.text(
            `Possible victims: ${targets.map((player) => player.name).join(", ")}.`,
            `襲撃候補: ${targets.map((player) => player.name).join(", ")}。`
          ),
          ...this.wolfHistory.slice(-8).map((line) => this.text(`Werewolf chat: ${line}`, `人狼チャット: ${line}`))
        ];
        const context = this.contextFor(wolf, contextLines);
        const speech = await this.safeSpeak(
          wolf,
          this.text("Suggest a night victim and explain the strategic reason.", "夜の襲撃先を提案し、戦略的な理由を説明してください。"),
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
    const decision = await this.safeChooseTarget(guard, this.text("Guard night protection", "騎士の夜護衛"), context, targets, false, contextLines);
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

  private async resolveWerewolfAttack(werewolves: Player[]): Promise<Player | null> {
    const targets = this.alivePlayers().filter((player) => player.camp !== "werewolf");
    if (werewolves.length === 0 || targets.length === 0) {
      return null;
    }

    const votes: VoteRecord[] = [];
    const collectWolfVote = async (wolf: Player): Promise<VoteRecord | null> => {
      const contextLines = [
        this.text(
          `Known werewolves: ${werewolves.map((player) => player.name).join(", ")}.`,
          `把握している人狼: ${werewolves.map((player) => player.name).join(", ")}。`
        ),
        this.text("Vote for the player the werewolf team should kill tonight.", "今夜、人狼チームが襲撃する相手に投票してください。")
      ];
      const context = this.contextFor(wolf, contextLines);
      const decision = await this.safeChooseTarget(wolf, this.text("Werewolf night kill vote", "人狼の夜襲撃投票"), context, targets, false, contextLines);
      return decision.targetId ? { voterId: wolf.id, targetId: decision.targetId, reason: decision.reason } : null;
    };

    for await (const vote of orderedConcurrentMap(
      werewolves,
      this.prefetchConcurrency,
      collectWolfVote,
      this.progressReporter("werewolf_attack_vote", this.text("Werewolf attack vote", "人狼の襲撃投票"))
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

  private async *runSeerAction(): AsyncGenerator<GameEvent> {
    const seer = this.alivePlayers().find((player) => player.role === "Seer");
    if (!seer || !canUseAbilities(this.ruleState, seer.id)) {
      return;
    }

    this.phase = "seer_action";
    const allTargets = this.alivePlayers().filter((player) => player.id !== seer.id);
    const unchecked = allTargets.filter((player) => !(player.id in seer.seerResults));
    const targets = unchecked.length > 0 ? unchecked : allTargets;
    if (targets.length === 0) {
      return;
    }

    const contextLines = [
      this.text("Choose one living player to check tonight.", "今夜占う生存者を一人選んでください。")
    ];
    const context = this.contextFor(seer, contextLines);
    const decision = await this.safeChooseTarget(seer, this.text("Seer identity check", "占い師の判定"), context, targets, false, contextLines);
    if (!decision.targetId) {
      return;
    }

    const target = this.requirePlayer(decision.targetId);
    const resultRound = Math.max(1, this.round);
    seer.seerResults[target.id] = target.camp;
    seer.seerResultRounds[target.id] = resultRound;
    seer.memories.push(
      this.text(
        `Round ${resultRound}: ${target.name} checked as ${target.camp}.`,
        `第${resultRound}ラウンド: ${target.name}は${this.campText(target.camp)}判定。`
      )
    );
    yield this.emit(
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

  private async *runWitchAction(killTarget: Player | null): AsyncGenerator<GameEvent, string | null> {
    const witch = this.alivePlayers().find((player) => player.role === "Witch");
    if (!witch || !canUseAbilities(this.ruleState, witch.id)) {
      return null;
    }

    this.phase = "witch_action";
    let savedTarget: string | null = null;

    if (killTarget && this.witchState.savePotion) {
      const contextLines = [
        this.text(
          `${killTarget.name} will be killed by werewolves tonight.`,
          `${killTarget.name}が今夜人狼に襲撃されます。`
        ),
        this.text("Decide whether to spend your only save potion.", "一度だけ使える蘇生薬を使うか判断してください。")
      ];
      const context = this.contextFor(witch, contextLines, {
        witch: {
          savePotion: this.witchState.savePotion,
          poisonPotion: this.witchState.poisonPotion,
          attackedTarget: { id: killTarget.id, name: killTarget.name }
        }
      });
      const save = await this.safeDecide(
        witch,
        this.text(`Use the save potion on ${killTarget.name}?`, `${killTarget.name}に蘇生薬を使いますか？`),
        context,
        contextLines
      );
      if (save) {
        this.witchState.savePotion = false;
        this.witchState.savedTargetId = killTarget.id;
        savedTarget = killTarget.id;
        witch.memories.push(this.text(`Round ${this.round}: saved ${killTarget.name}.`, `第${this.round}ラウンド: ${killTarget.name}を救いました。`));
        yield this.emit(
          "night_action",
          this.text(`${witch.name} used the save potion.`, `${witch.name}が蘇生薬を使いました。`),
          { visibility: "private", action: "witch_save", savedTargetId: killTarget.id, savedTargetName: killTarget.name },
          witch,
          killTarget
        );
        return savedTarget;
      }
    }

    if (this.witchState.poisonPotion) {
      const poisonTargets = this.alivePlayers().filter((player) => player.id !== witch.id);
      const contextLines = [
        this.text("You may spend your only poison potion tonight, or skip.", "今夜、一度だけ使える毒薬を使うか、見送るか選べます。"),
        killTarget
          ? this.text(`The werewolf victim is ${killTarget.name}.`, `人狼の襲撃先は${killTarget.name}です。`)
          : this.text("No werewolf victim is known.", "人狼の襲撃先は不明です。")
      ];
      const context = this.contextFor(witch, contextLines, {
        witch: {
          savePotion: this.witchState.savePotion,
          poisonPotion: this.witchState.poisonPotion,
          attackedTarget: killTarget ? { id: killTarget.id, name: killTarget.name } : null
        }
      });
      const decision = await this.safeChooseTarget(witch, this.text("Witch poison potion", "魔女の毒薬"), context, poisonTargets, true, contextLines);
      if (decision.targetId) {
        const target = this.requirePlayer(decision.targetId);
        this.witchState.poisonPotion = false;
        this.witchState.poisonTargetId = target.id;
        witch.memories.push(this.text(`Round ${this.round}: poisoned ${target.name}.`, `第${this.round}ラウンド: ${target.name}に毒薬を使いました。`));
        yield this.emit(
          "night_action",
          this.text(`${witch.name} used the poison potion.`, `${witch.name}が毒薬を使いました。`),
          { visibility: "private", action: "witch_poison", poisonTargetId: target.id, poisonTargetName: target.name },
          witch,
          target
        );
      }
    }

    return savedTarget;
  }

  private async *runWolfBeautyCharmAction(wolfBeauty: Player): AsyncGenerator<GameEvent> {
    if (!wolfBeauty.alive || wolfBeauty.role !== "WolfBeauty" || !canUseAbilities(this.ruleState, wolfBeauty.id)) {
      return;
    }
    if ((this.ruleState.players[wolfBeauty.id]?.statuses ?? []).some((status) => status.kind === "charm_anchor")) {
      return;
    }

    const targets = this.alivePlayers().filter((player) => player.id !== wolfBeauty.id);
    if (targets.length === 0) {
      return;
    }

    const contextLines = [
      this.text(
        "Choose one living player to charm. If you die, that player dies with you.",
        "魅了する生存者を一人選んでください。あなたが死亡すると、その相手も道連れになります。"
      )
    ];
    const context = this.contextFor(wolfBeauty, contextLines);
    const decision = await this.safeChooseTarget(
      wolfBeauty,
      this.text("Wolf Beauty charm", "美女狼の魅了"),
      context,
      targets,
      false,
      contextLines
    );
    if (!decision.targetId) {
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

    const targets = this.alivePlayers();
    if (targets.length === 0) {
      return;
    }

    const contextLines = [
      this.text(
        "Choose one living player to mark. The mark adds one vote against them in today's vote.",
        "印を付ける生存者を一人選んでください。今日の投票で、その相手に1票が加算されます。"
      )
    ];
    const context = this.contextFor(raven, contextLines);
    const decision = await this.safeChooseTarget(raven, this.text("Raven mark", "鴉の印"), context, targets, false, contextLines);
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
    this.phase = "day_discussion";
    this.lastDiscussion = [];
    const deathNames = this.lastNightDeaths.map((id) => this.requirePlayer(id).name);
    yield this.emit(
      "phase_changed",
      deathNames.length > 0
        ? this.text(
            `Day ${this.round} begins. Last night's deaths: ${deathNames.join(", ")}.`,
            `第${this.round}昼が始まりました。昨夜の死亡者: ${deathNames.join(", ")}。`
          )
        : this.text(`Day ${this.round} begins. No one died last night.`, `第${this.round}昼が始まりました。昨夜は誰も死亡しませんでした。`)
    );

    for (let discussionPass = 1; discussionPass <= dayDiscussionPasses; discussionPass += 1) {
      const speakers = this.alivePlayers();
      const generateSpeech = async (player: Player): Promise<{ player: Player; speech: AgentSpeech }> => {
        const contextLines = [
          deathNames.length > 0
            ? this.text(`Last night, ${deathNames.join(", ")} died.`, `昨夜、${deathNames.join(", ")}が死亡しました。`)
            : this.text("No one died last night.", "昨夜は誰も死亡しませんでした。"),
          this.text(
            "Discuss suspicions, claims, or information with the whole table.",
            "疑い、役職主張、情報を全体に向けて話してください。"
          ),
          this.text(
            `Discussion pass ${discussionPass} of ${dayDiscussionPasses}.`,
            `昼議論 ${discussionPass}巡目 / ${dayDiscussionPasses}巡。`
          ),
          discussionPass === 1
            ? this.text(
                "First pass: put one readable read, claim decision, or question on record so others can respond.",
                "1巡目: 他の人が返答できるように、読み・役職主張の判断・質問のどれかを一つはっきり残してください。"
              )
            : this.text(
                "Second pass: answer direct questions or suspicion aimed at you first, then update one read before voting.",
                "2巡目: 自分への質問や疑いがあれば先に短く答え、その後に投票前の読みを一つ更新してください。"
              )
        ];
        const context = this.contextFor(player, contextLines);
        const speech = await this.safeSpeak(
          player,
          this.text("Make a public day discussion statement.", "昼議論の公開発言をしてください。"),
          context,
          contextLines
        );
        return { player, speech };
      };
      const publishSpeech = (player: Player, speech: AgentSpeech): GameEvent[] => {
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
              discussionPasses: dayDiscussionPasses
            }),
            player
          )
        );
      };

      for await (const { player, speech } of this.orderedAiWithHumanBoundary(
        speakers,
        (player) => player.id,
        generateSpeech,
        this.progressReporter("day_speech", this.text("Day discussion", "昼議論"), {
          pass: discussionPass,
          passes: dayDiscussionPasses
        })
      )) {
        for (const event of publishSpeech(player, speech)) {
          yield event;
        }
      }
    }

    yield* this.runVoting();
  }

  private async *runVoting(): AsyncGenerator<GameEvent> {
    this.phase = "voting";
    yield this.emit("phase_changed", this.text("Voting begins.", "投票が始まりました。"));

    const votes: VoteRecord[] = [];
    const deathNames = this.lastNightDeaths.map((id) => this.requirePlayer(id).name);
    const livingPlayers = this.alivePlayers();
    const voters = livingPlayers.filter((player) => !this.ruleState.players[player.id]?.statuses.some((status) => status.kind === "no_vote"));
    const collectVote = async (voter: Player): Promise<{ voter: Player; decision: TargetDecision } | null> => {
      const targets = livingPlayers.filter((player) => player.id !== voter.id);
      if (targets.length === 0) {
        return null;
      }
      const contextLines = [
        deathNames.length > 0
          ? this.text(`Last night, ${deathNames.join(", ")} died.`, `昨夜、${deathNames.join(", ")}が死亡しました。`)
          : this.text("No one died last night.", "昨夜は誰も死亡しませんでした。"),
        this.text(
          "This is the final decision right before voting after today's public discussion.",
          "これは今日の公開議論後、投票直前の最終判断です。"
        ),
        this.text("Vote for one living player to eliminate.", "処刑する生存者を一人選んで投票してください。")
      ];
      const context = this.contextFor(voter, contextLines);
      const decision = await this.safeChooseTarget(voter, this.text("Day elimination vote", "昼の処刑投票"), context, targets, false, contextLines);
      return { voter, decision };
    };
    const voteResults = this.orderedAiWithHumanBoundary(
      voters,
      (voter) => voter.id,
      collectVote,
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
        { reason: decision.reason },
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
      yield await this.emitRoundSummary();
      this.ruleState = expireStatuses(this.ruleState, "round");
      return;
    }

    const voteResolution = resolveVote(eligibleVotes, voteModifiers);
    yield this.emit("vote_result", this.text("Vote totals are in.", "投票結果が出ました。"), {
      votes: this.voteDetails(eligibleVotes),
      modifiers: voteModifiers.map((modifier) => ({
        targetId: modifier.targetId,
        targetName: this.requirePlayer(modifier.targetId).name,
        count: modifier.count,
        sourceId: modifier.sourceId,
        sourceName: modifier.sourceId ? this.requirePlayer(modifier.sourceId).name : undefined,
        reason: modifier.reason
      })),
      totals: voteResolution.totals.map(({ targetId, count }) => ({
        targetId,
        targetName: this.requirePlayer(targetId).name,
        count
      }))
    });

    if (!voteResolution.eliminatedId) {
      yield this.emit("vote_result", this.text("The vote is tied, so no one is eliminated.", "投票が同数のため、処刑は行われません。"));
      yield await this.emitRoundSummary();
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
      yield await this.emitRoundSummary();
      this.ruleState = expireStatuses(this.ruleState, "round");
      return;
    }

    yield* this.resolveDeaths([{ playerId: eliminated.id, cause: "vote" }]);
    yield await this.emitRoundSummary();
    this.ruleState = expireStatuses(this.ruleState, "round");
  }

  private async *resolveDeaths(
    initialDeaths: DeathRecord[],
    blockedTargetIds = new Set<string>(),
    chainDepth = 0
  ): AsyncGenerator<GameEvent> {
    const deaths = createLinkedDeathRecords(initialDeaths, this.ruleState, {
      isAlive: (playerId) => this.requirePlayer(playerId).alive && !blockedTargetIds.has(playerId)
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
    if (death.cause === "hunter") {
      const hunter = death.sourceId ? this.requirePlayer(death.sourceId) : null;
      return hunter
        ? this.text(`${player.name} was shot by Hunter ${hunter.name}.`, `${player.name}はハンターの${hunter.name}に撃たれました。`)
        : this.text(`${player.name} was shot by the Hunter.`, `${player.name}はハンターに撃たれました。`);
    }
    if (death.cause === "alpha_wolf") {
      const alpha = death.sourceId ? this.requirePlayer(death.sourceId) : null;
      return alpha
        ? this.text(`${player.name} was shot by Alpha Wolf ${alpha.name}.`, `${player.name}はアルファ人狼の${alpha.name}に撃たれました。`)
        : this.text(`${player.name} was shot by the Alpha Wolf.`, `${player.name}はアルファ人狼に撃たれました。`);
    }
    if (death.cause === "lover") {
      return this.text(`${player.name} died of heartbreak.`, `${player.name}は恋人の後を追って死亡しました。`);
    }
    if (death.cause === "wolf_beauty_charm") {
      return this.text(`${player.name} died from Wolf Beauty's charm.`, `${player.name}は美女狼の魅了により死亡しました。`);
    }
    return this.text(`${player.name} died during the night.`, `${player.name}が夜の間に死亡しました。`);
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

    const targets = this.alivePlayers().filter((player) => !blockedTargetIds.has(player.id));
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
    const decision = await this.safeChooseTarget(hunter, action, context, targets, false, contextLines);
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

  private async safeSpeak(player: Player, task: string, context: string, uiContext: string[] = []): Promise<AgentSpeech> {
    this.throwIfCancelled();
    const agent = this.agents.get(player.id) ?? fallbackAgent;
    const legalPlayers = this.speechLegalPlayers(player).map(({ id, name }) => ({ id, name }));
    const input = {
      player,
      phase: this.phase,
      task,
      context,
      uiContext,
      knownPlayers: this.players.map(({ id, name }) => ({ id, name })),
      legalPlayers,
      publicHistory: this.publicHistory,
      privateHistory: player.memories,
      abortSignal: this.abortSignal
    };
    try {
      const speech = this.sanitizeSpeechForPhase(await agent.speak(input), legalPlayers);

      if (agent.model === "human") {
        return speech;
      }

      const review = reviewJapaneseOutput(speech.messages.join(" "), this.config.language);
      if (!review.ok) {
        console.warn(
          `[speech-review] ${player.name}: ${review.issues.join(", ")} — retrying once. Original: "${speech.messages.join(" ").substring(0, 120)}…"`
        );
        this.throwIfCancelled();
        const retry = this.sanitizeSpeechForPhase(await agent.speak(input), legalPlayers);
        const retryReview = reviewJapaneseOutput(retry.messages.join(" "), this.config.language);
        if (retryReview.ok) {
          return retry;
        }
        console.warn(
          `[speech-review] ${player.name}: retry still has issues (${retryReview.issues.join(", ")}). Using retry output anyway.`
        );
        return retry;
      }

      return speech;
    } catch (error) {
      if (this.abortSignal?.aborted) {
        throw error;
      }
      console.warn(`[llm-error] speech ${player.id} ${this.phase}: ${error instanceof Error ? error.message : String(error)}`);
      player.memories.push(this.text(`LLM error during speech: ${String(error)}`, `発言生成中のLLMエラー: ${String(error)}`));
      if (shouldRethrowLlmError(agent)) {
        throw error;
      }
      return this.sanitizeSpeechForPhase(await fallbackAgent.speak(input), legalPlayers);
    }
  }

  private speechLegalPlayers(player: Player): Player[] {
    if (this.phase === "werewolf_discussion" && player.camp === "werewolf") {
      return this.alivePlayers().filter((candidate) => candidate.camp !== "werewolf");
    }
    return this.alivePlayers().filter((candidate) => candidate.id !== player.id);
  }

  private sanitizeSpeechForPhase(speech: AgentSpeech, legalPlayers: TargetCandidate[]): AgentSpeech {
    const legalIds = new Set(legalPlayers.map((candidate) => candidate.id));
    return {
      ...speech,
      metadata: {
        ...speech.metadata,
        suspects: speech.metadata.suspects.filter((read) => legalIds.has(read.targetId)),
        trusts: speech.metadata.trusts.filter((read) => legalIds.has(read.targetId))
      }
    };
  }

  private async safeChooseTarget(
    player: Player,
    action: string,
    context: string,
    candidates: Player[],
    allowSkip: boolean,
    uiContext: string[] = []
  ): Promise<TargetDecision> {
    this.throwIfCancelled();
    const agent = this.agents.get(player.id) ?? fallbackAgent;
    const targetCandidates: TargetCandidate[] = candidates.map(({ id, name }) => ({ id, name }));
    const input = {
      player,
      phase: this.phase,
      action,
      context,
      uiContext,
      candidates: targetCandidates,
      allowSkip,
      publicHistory: this.publicHistory,
      privateHistory: player.memories,
      abortSignal: this.abortSignal
    };
    try {
      return await agent.chooseTarget(input);
    } catch (error) {
      if (this.abortSignal?.aborted) {
        throw error;
      }
      console.warn(`[llm-error] target ${player.id} ${this.phase}: ${error instanceof Error ? error.message : String(error)}`);
      player.memories.push(this.text(`LLM error during target choice: ${String(error)}`, `対象選択中のLLMエラー: ${String(error)}`));
      if (shouldRethrowLlmError(agent)) {
        throw error;
      }
      return fallbackAgent.chooseTarget(input);
    }
  }

  private async safeDecide(player: Player, question: string, context: string, uiContext: string[] = []): Promise<boolean> {
    this.throwIfCancelled();
    const agent = this.agents.get(player.id) ?? fallbackAgent;
    const input = {
      player,
      phase: this.phase,
      question,
      context,
      uiContext,
      publicHistory: this.publicHistory,
      privateHistory: player.memories,
      abortSignal: this.abortSignal
    };
    try {
      return await agent.decide(input);
    } catch (error) {
      if (this.abortSignal?.aborted) {
        throw error;
      }
      console.warn(`[llm-error] decision ${player.id} ${this.phase}: ${error instanceof Error ? error.message : String(error)}`);
      player.memories.push(this.text(`LLM error during decision: ${String(error)}`, `判断中のLLMエラー: ${String(error)}`));
      if (shouldRethrowLlmError(agent)) {
        throw error;
      }
      return fallbackAgent.decide(input);
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
    reason?: string;
  }> {
    return votes.map((vote) => {
      const voter = this.requirePlayer(vote.voterId);
      const target = this.requirePlayer(vote.targetId);
      return {
        voterId: voter.id,
        voterName: voter.name,
        targetId: target.id,
        targetName: target.name,
        reason: vote.reason
      };
    });
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

  private contextFor(player: Player, extra: string[] = [], secretOverride: RoleSecretContext = {}): string {
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

    const witch = base.witch && override.witch ? { ...base.witch, ...override.witch } : (override.witch ?? base.witch);

    return {
      ...base,
      ...override,
      witch
    };
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
