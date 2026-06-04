import assert from "node:assert/strict";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicAgent, DemoAgent, summarizeRoundWithLlm } from "../src/game/agents";
import { characterNames, characterProfiles } from "../src/game/characters";
import { WerewolfGame } from "../src/game/engine";
import { HumanInputAgent } from "../src/game/humanAgent";
import {
  DEFAULT_LOVER_ALIGNMENT_SPEECH,
  DEFAULT_WEREWOLF_ALIGNMENT_SPEECH,
  defaultLoverAlignmentSpeechForPlayer,
  defaultWerewolfAlignmentSpeechForPlayer
} from "../src/game/humanInputDefaults";
import { roleLabel } from "../src/game/i18n";
import { loverFaceoffLineOptionsForPlayer } from "../src/game/loverFaceoffLines";
import { redactEventForPlayer, redactEventForVillage, redactSnapshotForPlayer, redactSnapshotForVillage } from "../src/game/redaction";
import { createRoles, createRolesWithFixedHumanRole, maxSupportedPlayers } from "../src/game/rules/presets";
import { roleCamp } from "../src/game/rules/roles";
import { applyStatusEffects, createInitialRuleState } from "../src/game/rules/state";
import type { RuleState } from "../src/game/rules/types";
import { firstDayOpeningMoveKinds, firstDayWerewolfOpeningMoveKinds } from "../src/game/speechPlanning";
import { werewolfFaceoffLineOptionsForPlayer, werewolfFaceoffRoles } from "../src/game/werewolfFaceoffLines";
import type {
  Agent,
  AgentBooleanInput,
  AgentSpeech,
  AgentSpeechInput,
  AgentTargetInput,
  Camp,
  CampId,
  GameConfig,
  GameEvent,
  GenerationProgress,
  Player,
  PublicSpeechPlan,
  Role,
  SeerClaimResult,
  SpeechGenerationDiagnostic,
  SpeechMetadata,
  HumanInputHandler,
  HumanInputRequestPayload,
  TargetCandidate,
  TargetDecision
} from "../src/game/types";

const baseConfig: GameConfig = {
  playerCount: 6,
  provider: "demo",
  model: "demo",
  language: "English",
  maxRounds: 3,
  prefetchConcurrency: 1
};

class ScriptedAgent implements Agent {
  readonly model = "scripted";
  readonly speechInputs: AgentSpeechInput[] = [];
  readonly targetInputs: AgentTargetInput[] = [];

  constructor(
    readonly name: string,
    private readonly targets: Array<string | null> = [],
    private readonly decisions: boolean[] = [],
    private readonly speeches: AgentSpeech[] = []
  ) {}

  async speak(input: AgentSpeechInput): Promise<AgentSpeech> {
    this.speechInputs.push(input);
    const scripted = this.speeches.shift();
    if (scripted) {
      return scripted;
    }
    return {
      messages: [`${this.name} speaks.`],
      metadata: {
        suspects: [],
        trusts: [],
        claims: []
      }
    };
  }

  async chooseTarget(input: AgentTargetInput): Promise<TargetDecision> {
    this.targetInputs.push(input);
    if (this.targets.length > 0) {
      return {
        targetId: this.targets.shift() ?? null,
        reason: `${this.name} scripted reason`
      };
    }
    return {
      targetId: input.candidates[0]?.id ?? null,
      reason: `${this.name} default reason`
    };
  }

  async decide(): Promise<boolean> {
    return this.decisions.shift() ?? false;
  }
}

class PreferTargetAgent extends ScriptedAgent {
  constructor(name: string, private readonly preferredTargetId: string) {
    super(name);
  }

  override async chooseTarget(input: AgentTargetInput): Promise<TargetDecision> {
    this.targetInputs.push(input);
    const preferred = input.candidates.find((candidate) => candidate.id === this.preferredTargetId);
    const target = preferred ?? input.candidates[0] ?? null;
    return {
      targetId: target?.id ?? null,
      reason: `${this.name} preferred ${this.preferredTargetId}`
    };
  }
}

class ReasonKindTargetAgent extends ScriptedAgent {
  constructor(
    name: string,
    private readonly preferredTargetId: string,
    private readonly reasonKind: TargetDecision["reasonKind"]
  ) {
    super(name);
  }

  override async chooseTarget(input: AgentTargetInput): Promise<TargetDecision> {
    this.targetInputs.push(input);
    const preferred = input.candidates.find((candidate) => candidate.id === this.preferredTargetId);
    const target = preferred ?? input.candidates[0] ?? null;
    return {
      targetId: target?.id ?? null,
      reason: `${this.name} ${this.reasonKind} ${this.preferredTargetId}`,
      reasonKind: this.reasonKind
    };
  }
}

class ContextMentionTargetAgent extends ScriptedAgent {
  constructor(
    name: string,
    private readonly mentionedTargetId: string,
    private readonly mentionedTargetName: string,
    fallbackTargets: Array<string | null> = []
  ) {
    super(name, fallbackTargets);
  }

  override async chooseTarget(input: AgentTargetInput): Promise<TargetDecision> {
    this.targetInputs.push(input);
    const mentioned = input.candidates.find((candidate) => candidate.id === this.mentionedTargetId);
    if (mentioned && input.context.includes(this.mentionedTargetName)) {
      return {
        targetId: mentioned.id,
        reason: `${this.name} followed context mention ${this.mentionedTargetName}`
      };
    }
    const fallback = input.candidates.find((candidate) => candidate.id === this.mentionedTargetId) ?? input.candidates[0] ?? null;
    return {
      targetId: fallback?.id ?? null,
      reason: `${this.name} fallback target`
    };
  }
}

// Records improviseIntro calls so tests can assert the warm-up uses the fast intro
// path (not speak()) and covers the right speakers.
class IntroAgent implements Agent {
  readonly model = "scripted";
  readonly introCalls: string[] = [];
  readonly werewolfIntroCalls: string[] = [];
  readonly speakCalls: string[] = [];
  readonly speechInputs: AgentSpeechInput[] = [];
  constructor(readonly name: string) {}

  async improviseIntro(input: AgentSpeechInput): Promise<AgentSpeech> {
    this.introCalls.push(input.player.id);
    return { messages: [`INTRO ${input.player.name}`], metadata: { suspects: [], trusts: [], claims: [] } };
  }

  async improviseWerewolfIntro(input: AgentSpeechInput): Promise<AgentSpeech> {
    this.werewolfIntroCalls.push(input.player.id);
    this.speechInputs.push(input);
    return {
      messages: [`WOLF-INTRO ${input.player.name} ${input.player.role}`],
      metadata: { suspects: [], trusts: [], claims: [] }
    };
  }

  async speak(input: AgentSpeechInput): Promise<AgentSpeech> {
    this.speakCalls.push(input.player.id);
    this.speechInputs.push(input);
    return { messages: [`SPEAK ${input.player.name}`], metadata: { suspects: [], trusts: [], claims: [] } };
  }

  async chooseTarget(input: AgentTargetInput): Promise<TargetDecision> {
    return { targetId: input.candidates[0]?.id ?? null, reason: `${this.name} target` };
  }

  async decide(): Promise<boolean> {
    return false;
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

class BlockingIntroAgent extends IntroAgent {
  constructor(
    name: string,
    private readonly introGate: Promise<void>,
    private readonly onSpeakStarted: (playerId: string) => void
  ) {
    super(name);
  }

  override async improviseIntro(input: AgentSpeechInput): Promise<AgentSpeech> {
    this.introCalls.push(input.player.id);
    await this.introGate;
    return { messages: [`INTRO ${input.player.name}`], metadata: { suspects: [], trusts: [], claims: [] } };
  }

  override async speak(input: AgentSpeechInput): Promise<AgentSpeech> {
    this.speakCalls.push(input.player.id);
    this.speechInputs.push(input);
    this.onSpeakStarted(input.player.id);
    return { messages: [`SPEAK ${input.player.name}`], metadata: { suspects: [], trusts: [], claims: [] } };
  }
}

class DelayedIntroAgent extends IntroAgent {
  constructor(
    name: string,
    private readonly delayMs: number
  ) {
    super(name);
  }

  override async improviseIntro(input: AgentSpeechInput): Promise<AgentSpeech> {
    this.introCalls.push(input.player.id);
    await sleepWithAbort(this.delayMs, input.abortSignal);
    return { messages: [`INTRO ${input.player.name}`], metadata: { suspects: [], trusts: [], claims: [] } };
  }
}

class AbortAwareBlockingIntroAgent extends IntroAgent {
  constructor(
    name: string,
    private readonly onIntroStarted: (playerId: string) => void,
    private readonly onIntroAborted: (playerId: string) => void,
    private readonly onSpeakStarted: (playerId: string) => void
  ) {
    super(name);
  }

  override async improviseIntro(input: AgentSpeechInput): Promise<AgentSpeech> {
    this.introCalls.push(input.player.id);
    this.onIntroStarted(input.player.id);
    try {
      await sleepWithAbort(10_000, input.abortSignal);
    } catch (error) {
      this.onIntroAborted(input.player.id);
      throw error;
    }
    return { messages: [`INTRO ${input.player.name}`], metadata: { suspects: [], trusts: [], claims: [] } };
  }

  override async speak(input: AgentSpeechInput): Promise<AgentSpeech> {
    this.speakCalls.push(input.player.id);
    this.speechInputs.push(input);
    this.onSpeakStarted(input.player.id);
    return { messages: [`SPEAK ${input.player.name}`], metadata: { suspects: [], trusts: [], claims: [] } };
  }
}

class BlockingFaceoffAgent extends IntroAgent {
  constructor(
    name: string,
    private readonly faceoffGate: Promise<void>,
    private readonly introGate: Promise<void>,
    private readonly onFaceoffStarted: (playerId: string) => void,
    private readonly onIntroStarted: (playerId: string) => void,
    private readonly onSpeakStarted: (playerId: string) => void
  ) {
    super(name);
  }

  override async improviseWerewolfIntro(input: AgentSpeechInput): Promise<AgentSpeech> {
    this.werewolfIntroCalls.push(input.player.id);
    this.speechInputs.push(input);
    this.onFaceoffStarted(input.player.id);
    await this.faceoffGate;
    return {
      messages: [`WOLF-INTRO ${input.player.name} ${input.player.role}`],
      metadata: { suspects: [], trusts: [], claims: [] }
    };
  }

  override async improviseIntro(input: AgentSpeechInput): Promise<AgentSpeech> {
    this.introCalls.push(input.player.id);
    this.onIntroStarted(input.player.id);
    await this.introGate;
    return { messages: [`INTRO ${input.player.name}`], metadata: { suspects: [], trusts: [], claims: [] } };
  }

  override async speak(input: AgentSpeechInput): Promise<AgentSpeech> {
    this.speakCalls.push(input.player.id);
    this.speechInputs.push(input);
    this.onSpeakStarted(input.player.id);
    return { messages: [`SPEAK ${input.player.name}`], metadata: { suspects: [], trusts: [], claims: [] } };
  }
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timeout);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await sleepWithAbort(5);
  }
}

class DelayedSpeechAgent implements Agent {
  readonly model = "delayed";
  readonly speechInputs: AgentSpeechInput[] = [];
  readonly targetInputs: AgentTargetInput[] = [];
  private calls = 0;

  constructor(
    readonly name: string,
    private readonly delays: number[],
    private readonly message: (input: AgentSpeechInput, call: number) => string
  ) {}

  async speak(input: AgentSpeechInput): Promise<AgentSpeech> {
    const call = this.calls;
    this.calls += 1;
    this.speechInputs.push(input);
    await sleepWithAbort(this.delays[call] ?? this.delays.at(-1) ?? 0, input.abortSignal);
    return {
      messages: [this.message(input, call)],
      metadata: {
        suspects: [],
        trusts: [],
        claims: []
      }
    };
  }

  async chooseTarget(input: AgentTargetInput): Promise<TargetDecision> {
    this.targetInputs.push(input);
    return {
      targetId: input.candidates[0]?.id ?? null,
      reason: `${this.name} delayed target`
    };
  }

  async decide(): Promise<boolean> {
    return false;
  }
}

class DelayedNightActionAgent implements Agent {
  readonly model = "delayed-night-action";
  readonly speechInputs: AgentSpeechInput[] = [];
  readonly targetInputs: AgentTargetInput[] = [];

  constructor(
    readonly name: string,
    private readonly speechDelayMs: number,
    private readonly targetDelayMs: number
  ) {}

  async speak(input: AgentSpeechInput): Promise<AgentSpeech> {
    this.speechInputs.push(input);
    await sleepWithAbort(this.speechDelayMs, input.abortSignal);
    return {
      messages: [`${this.name} slow night discussion.`],
      metadata: {
        suspects: [],
        trusts: [],
        claims: []
      }
    };
  }

  async chooseTarget(input: AgentTargetInput): Promise<TargetDecision> {
    this.targetInputs.push(input);
    await sleepWithAbort(this.targetDelayMs, input.abortSignal);
    return {
      targetId: input.candidates[0]?.id ?? null,
      reason: `${this.name} delayed night target`
    };
  }

  async decide(): Promise<boolean> {
    return false;
  }
}

class DelayedTargetRaceAgent implements Agent {
  readonly speechInputs: AgentSpeechInput[] = [];
  readonly targetInputs: AgentTargetInput[] = [];
  abortedTargets = 0;
  private calls = 0;

  constructor(
    readonly name: string,
    readonly model: string,
    private readonly delays: number[],
    private readonly targets: Array<string | null>
  ) {}

  async speak(): Promise<AgentSpeech> {
    return {
      messages: [`${this.name} speaks.`],
      metadata: { suspects: [], trusts: [], claims: [] }
    };
  }

  async chooseTarget(input: AgentTargetInput): Promise<TargetDecision> {
    const call = this.calls;
    this.calls += 1;
    this.targetInputs.push(input);
    try {
      await sleepWithAbort(this.delays[call] ?? this.delays.at(-1) ?? 0, input.abortSignal);
    } catch (error) {
      this.abortedTargets += 1;
      throw error;
    }
    return {
      targetId: this.targets[call] ?? input.candidates[0]?.id ?? null,
      reason: `${this.name} target race ${call}`
    };
  }

  async decide(): Promise<boolean> {
    return false;
  }
}

class DelayedBooleanRaceAgent implements Agent {
  readonly speechInputs: AgentSpeechInput[] = [];
  readonly targetInputs: AgentTargetInput[] = [];
  readonly booleanInputs: AgentBooleanInput[] = [];
  abortedDecisions = 0;
  private calls = 0;

  constructor(
    readonly name: string,
    readonly model: string,
    private readonly delays: number[],
    private readonly decisions: boolean[]
  ) {}

  async speak(): Promise<AgentSpeech> {
    return {
      messages: [`${this.name} speaks.`],
      metadata: { suspects: [], trusts: [], claims: [] }
    };
  }

  async chooseTarget(input: AgentTargetInput): Promise<TargetDecision> {
    this.targetInputs.push(input);
    return {
      targetId: input.candidates[0]?.id ?? null,
      reason: `${this.name} target`
    };
  }

  async decide(input: AgentBooleanInput): Promise<boolean> {
    const call = this.calls;
    this.calls += 1;
    this.booleanInputs.push(input);
    try {
      await sleepWithAbort(this.delays[call] ?? this.delays.at(-1) ?? 0, input.abortSignal);
    } catch (error) {
      this.abortedDecisions += 1;
      throw error;
    }
    return this.decisions[call] ?? false;
  }
}

type ActiveTargetCounter = {
  active: number;
  calls: number;
  maxActive: number;
};

class CountingTargetRaceAgent implements Agent {
  readonly speechInputs: AgentSpeechInput[] = [];
  readonly targetInputs: AgentTargetInput[] = [];

  constructor(
    readonly name: string,
    readonly model: string,
    private readonly counter: ActiveTargetCounter,
    private readonly delayMs = 30
  ) {}

  async speak(input: AgentSpeechInput): Promise<AgentSpeech> {
    this.speechInputs.push(input);
    return {
      messages: [`${this.name} speaks.`],
      metadata: { suspects: [], trusts: [], claims: [] }
    };
  }

  async chooseTarget(input: AgentTargetInput): Promise<TargetDecision> {
    this.targetInputs.push(input);
    this.counter.active += 1;
    this.counter.calls += 1;
    this.counter.maxActive = Math.max(this.counter.maxActive, this.counter.active);
    try {
      await sleepWithAbort(this.delayMs, input.abortSignal);
      return {
        targetId: input.candidates[0]?.id ?? null,
        reason: `${this.name} counted target`
      };
    } finally {
      this.counter.active -= 1;
    }
  }

  async decide(): Promise<boolean> {
    return false;
  }
}

class FailOnceSpeechAgent implements Agent {
  readonly model = "fail-once";
  readonly speechInputs: AgentSpeechInput[] = [];
  readonly targetInputs: AgentTargetInput[] = [];
  private failed = false;

  constructor(readonly name: string) {}

  async speak(input: AgentSpeechInput): Promise<AgentSpeech> {
    this.speechInputs.push(input);
    if (!this.failed) {
      this.failed = true;
      throw new Error(`${this.name} failed speculative speech`);
    }
    return {
      messages: [`${this.name} recovered after speculative failure.`],
      metadata: {
        suspects: [],
        trusts: [],
        claims: []
      }
    };
  }

  async chooseTarget(input: AgentTargetInput): Promise<TargetDecision> {
    this.targetInputs.push(input);
    return {
      targetId: input.candidates[0]?.id ?? null,
      reason: `${this.name} fail-once target`
    };
  }

  async decide(): Promise<boolean> {
    return false;
  }
}

type TestableGame = WerewolfGame & {
  agents: Map<string, Agent>;
  checkVictory(): {
    camp: Camp;
    winnerCamp: CampId;
    winnerIds: string[];
    winnerCamps?: CampId[];
    winnerGroups?: Array<{ camp: CampId; winnerIds: string[]; winnerRoles?: Array<{ playerId: string; playerName: string; role: Role }> }>;
    winnerRoles?: Array<{ playerId: string; playerName: string; role: Role }>;
    reason: string;
  } | null;
  emitRoundSummary(): Promise<GameEvent>;
  finishGame(result: {
    camp: Camp;
    winnerCamp?: CampId;
    winnerIds?: string[];
    winnerCamps?: CampId[];
    winnerGroups?: Array<{ camp: CampId; winnerIds: string[]; winnerRoles?: Array<{ playerId: string; playerName: string; role: Role }> }>;
    winnerRoles?: Array<{ playerId: string; playerName: string; role: Role }>;
    reason: string;
  }): GameEvent;
  players: Player[];
  publicHistory: string[];
  lastDiscussion: Array<{ playerId: string; playerName: string; message: string; metadata: SpeechMetadata }>;
  wolfHistory: string[];
  ruleState: RuleState;
  runDay(): AsyncGenerator<GameEvent>;
  runGuardAction(): AsyncGenerator<GameEvent>;
  runHunterShot(hunter: Player, blockedTargetIds?: Set<string>, chainDepth?: number): AsyncGenerator<GameEvent>;
  runNight(): AsyncGenerator<GameEvent>;
  runRavenAction(raven: Player): AsyncGenerator<GameEvent>;
  runSeerAction(): AsyncGenerator<GameEvent>;
  runVoting(): AsyncGenerator<GameEvent>;
  runWolfBeautyCharmAction(wolfBeauty: Player): AsyncGenerator<GameEvent>;
  runWitchAction(killTarget: Player | null): AsyncGenerator<GameEvent, string | null>;
  witchState: {
    savePotion: boolean;
    poisonPotion: boolean;
    savedTargetId: string | null;
    poisonTargetId: string | null;
  };
  guardState: {
    protectedTargetId: string | null;
    lastProtectedTargetId: string | null;
  };
  hunterShotsUsed: Set<string>;
};

class FastDayVoteTimeoutGame extends WerewolfGame {
  protected override dayVoteDecisionTimeoutMs(): number {
    return 15;
  }
}

function createGame(): TestableGame {
  return new WerewolfGame(baseConfig) as TestableGame;
}

function setTable(
  game: TestableGame,
  specs: Array<{ role: Role; alive?: boolean; targets?: Array<string | null>; decisions?: boolean[]; speeches?: AgentSpeech[] }>
): Player[] {
  game.witchState.savePotion = true;
  game.witchState.poisonPotion = true;
  game.witchState.savedTargetId = null;
  game.witchState.poisonTargetId = null;
  game.guardState.protectedTargetId = null;
  game.guardState.lastProtectedTargetId = null;
  game.hunterShotsUsed.clear();

  const players = game.players.map((player, index) => {
    const spec = specs[index] ?? { role: "Villager" as const };
    player.role = spec.role;
    player.camp = roleCamp(spec.role);
    player.alive = spec.alive ?? true;
    player.memories = [];
    player.seerResults = {};
    player.seerResultRounds = {};
    player.witch = {
      savePotion: spec.role === "Witch",
      poisonPotion: spec.role === "Witch"
    };
    game.agents.set(player.id, new ScriptedAgent(player.name, spec.targets, spec.decisions, spec.speeches));
    return player;
  });
  game.ruleState = createInitialRuleState(game.players);
  return players;
}

async function collect(generator: AsyncGenerator<GameEvent>): Promise<GameEvent[]> {
  const events: GameEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function createTestAnthropicClient(): Anthropic {
  return new Anthropic({
    apiKey: "test-key",
    baseURL: "https://example.test",
    timeout: 1_000,
    maxRetries: 0
  });
}

test("victory follows werewolf parity and all-wolves-dead rules", () => {
  const game = createGame();
  const players = setTable(game, [
    { role: "Werewolf" },
    { role: "Werewolf" },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Seer", alive: false },
    { role: "Witch", alive: false }
  ]);

  assert.equal(game.checkVictory()?.camp, "werewolf");

  players[0].alive = false;
  players[1].alive = false;
  players[2].alive = true;
  players[3].alive = true;

  const villageWin = game.checkVictory();
  assert.equal(villageWin?.camp, "village");
  assert.match(villageWin?.reason ?? "", /All werewolves/);
});

test("role distribution includes required special roles and scales werewolves", async () => {
  for (const playerCount of [6, 7, 8, 9]) {
    const game = new WerewolfGame({ ...baseConfig, playerCount });
    const run = game.run();
    const first = await run.next();
    await run.return(undefined);

    assert.equal(first.done, false);
    const roles = first.value.snapshot.players.map((player) => player.role);
    assert.equal(roles.filter((role) => role === "Seer").length, 1);
    assert.equal(roles.filter((role) => role === "Witch").length, 1);
    assert.equal(roles.filter((role) => role === "Guard").length, playerCount >= 8 ? 1 : 0);
    assert.equal(roles.filter((role) => role === "Hunter").length, playerCount >= 9 ? 1 : 0);
    assert.equal(roles.filter((role) => role === "Raven").length, playerCount >= 9 ? 1 : 0);
    assert.equal(roles.filter((role) => role === "Werewolf").length, playerCount >= 7 ? 2 : 1);
    assert.equal(roles.length, playerCount);
    assert.ok(first.value.snapshot.players.every((player) => player.persona));
  }
});

test("compressed role distribution supports advanced roles before the 15 player cap", async () => {
  for (const playerCount of [10, 11, 12, 13, 14, 15]) {
    const game = new WerewolfGame({ ...baseConfig, playerCount });
    const run = game.run();
    const first = await run.next();
    await run.return(undefined);

    assert.equal(first.done, false);
    const roles = first.value.snapshot.players.map((player) => player.role);
    assert.equal(roles.length, playerCount);
    assert.ok(roles.includes("AlphaWolf"));
    assert.ok(roles.includes("Raven"));
    assert.equal(roles.filter((role) => role === "Idiot").length, playerCount >= 11 ? 1 : 0);
    assert.equal(roles.filter((role) => role === "Elder").length, playerCount >= 12 ? 1 : 0);
    assert.equal(roles.filter((role) => role === "Lover").length, playerCount >= 13 ? 2 : 0);
    assert.equal(roles.filter((role) => role === "WolfBeauty").length, playerCount >= 14 ? 1 : 0);
    assert.equal(roles.filter((role) => role === "Jester").length, playerCount >= 15 ? 1 : 0);
  }
});

test("generated player context includes role setup counts and werewolf ally roles only for wolves", () => {
  const game = new WerewolfGame({ ...baseConfig, playerCount: maxSupportedPlayers }) as TestableGame;
  const alphaWolf = game.players.find((player) => player.role === "AlphaWolf");
  const wolf = game.players.find((player) => player.camp === "werewolf");
  const villager = game.players.find((player) => player.camp !== "werewolf");
  const contextFor = (game as unknown as { contextFor(player: Player, extra?: string[]): string }).contextFor.bind(game);

  assert.ok(alphaWolf);
  assert.ok(wolf);
  assert.ok(villager);

  const wolfContext = contextFor(wolf);
  assert.match(wolfContext, /配役表:/);
  assert.match(wolfContext, /Jester/);
  assert.match(wolfContext, /WolfBeauty/);
  assert.match(wolfContext, new RegExp(`${alphaWolf.name} \\(${alphaWolf.id}\\): AlphaWolf`));

  const villageContext = contextFor(villager);
  assert.match(villageContext, /配役表:/);
  assert.match(villageContext, /Jester/);
  assert.doesNotMatch(villageContext, new RegExp(`${alphaWolf.name} \\(${alphaWolf.id}\\): AlphaWolf`));
});

test("character roster covers all supported player slots with fixed names and personas", () => {
  assert.equal(characterProfiles.length, maxSupportedPlayers);
  assert.deepEqual(characterNames, characterProfiles.map((profile) => profile.nameJa));
  const nameLengths = characterNames.reduce<Record<number, number>>((counts, name) => {
    const length = Array.from(name).length;
    counts[length] = (counts[length] ?? 0) + 1;
    return counts;
  }, {});

  assert.deepEqual(nameLengths, { 2: 2, 3: 9, 4: 2, 5: 2 });
  const incomingRelations = Object.fromEntries(characterProfiles.map((profile) => [profile.playerId, 0]));
  for (const profile of characterProfiles) {
    for (const relatedPlayerId of Object.keys(profile.relations)) {
      if (relatedPlayerId in incomingRelations) {
        incomingRelations[relatedPlayerId] += 1;
      }
    }
  }
  assert.ok(characterProfiles.every((profile) => incomingRelations[profile.playerId] > 0));

  const game = new WerewolfGame({ ...baseConfig, playerCount: maxSupportedPlayers }) as TestableGame;

  for (const [index, player] of game.players.entries()) {
    const profile = characterProfiles[index];
    assert.equal(player.id, profile.playerId);
    assert.equal(player.name, profile.nameJa);
    assert.equal(player.persona, profile.persona);
    assert.equal(player.characterProfile, profile);
  }
});

test("default werewolf alignment lines match each character voice", () => {
  const lines = characterProfiles.map((profile) =>
    defaultWerewolfAlignmentSpeechForPlayer(
      {
        name: profile.nameJa,
        role: "Werewolf",
        persona: profile.persona,
        characterProfile: profile
      },
      "Japanese"
    )
  );

  assert.equal(lines.length, characterProfiles.length);
  assert.equal(new Set(lines).size, characterProfiles.length);
  assert.ok(lines.every((line) => line.includes("人狼")));
  assert.ok(lines.every((line) => /(騙|フリ|ふり|潜|油断)/u.test(line)));
  assert.ok(lines.every((line) => line !== DEFAULT_WEREWOLF_ALIGNMENT_SPEECH));
  assert.ok(lines.some((line) => /票が集まりやすい位置/.test(line)), "セナ should keep the vote-tactician voice");
  assert.ok(lines.some((line) => /余計なことは言わない/.test(line)), "シュウヘイ should keep the stoic voice");
  assert.ok(lines.some((line) => /冗談だけど本気/.test(line)), "イオリ should keep the trickster voice");
});

test("default lover alignment lines match each character voice", () => {
  const partner = { name: "相方" };
  const lines = characterProfiles.map((profile) =>
    defaultLoverAlignmentSpeechForPlayer(
      {
        name: profile.nameJa,
        role: "Lover",
        persona: profile.persona,
        characterProfile: profile
      },
      partner,
      "Japanese"
    )
  );

  assert.equal(lines.length, characterProfiles.length);
  assert.equal(new Set(lines).size, characterProfiles.length);
  assert.ok(lines.every((line) => line.includes(partner.name)));
  assert.ok(lines.every((line) => /(相方|二人|生存|距離|残)/u.test(line)));
  assert.ok(lines.every((line) => line !== DEFAULT_LOVER_ALIGNMENT_SPEECH));
});

test("fixed werewolf face-off lines cover every character and wolf role", () => {
  const allLines: string[] = [];

  for (const profile of characterProfiles) {
    for (const role of werewolfFaceoffRoles) {
      const lines = werewolfFaceoffLineOptionsForPlayer(
        {
          name: profile.nameJa,
          role,
          characterProfile: profile
        },
        "Japanese"
      );

      assert.equal(lines.length, 3, `${profile.nameJa} ${role} should have three variants`);
      assert.equal(new Set(lines).size, 3, `${profile.nameJa} ${role} variants should be distinct`);
      assert.ok(lines.every((line) => line.includes(roleLabel(role, "Japanese"))));
      assert.ok(lines.every((line) => line.length <= 72), `${profile.nameJa} ${role} variants fit the face-off display`);
      allLines.push(...lines);
    }
  }

  assert.equal(new Set(allLines).size, characterProfiles.length * werewolfFaceoffRoles.length * 3);
});

test("fixed lover face-off lines cover every character with two partner variants", () => {
  const partner = { name: "相方" };
  const allLines: string[] = [];

  for (const profile of characterProfiles) {
    const lines = loverFaceoffLineOptionsForPlayer(
      {
        name: profile.nameJa,
        characterProfile: profile
      },
      partner,
      "Japanese"
    );

    assert.equal(lines.length, 2, `${profile.nameJa} should have two lover face-off variants`);
    assert.equal(new Set(lines).size, 2, `${profile.nameJa} lover variants should be distinct`);
    assert.ok(lines.every((line) => line.includes("恋人") || line.includes("相方")));
    assert.ok(lines.every((line) => line.includes(partner.name)));
    assert.ok(lines.every((line) => line.length <= 72), `${profile.nameJa} lover variants fit the face-off display`);
    allLines.push(...lines);
  }

  assert.equal(new Set(allLines).size, characterProfiles.length * 2);
});

test("configured human player keeps the normal shuffled role distribution", () => {
  for (const playerCount of [6, 9, maxSupportedPlayers]) {
    for (let index = 1; index <= playerCount; index += 1) {
      const game = new WerewolfGame({
        ...baseConfig,
        playerCount,
        humanPlayerId: `p${index}`
      }) as TestableGame;

      const human = game.players.find((player) => player.id === `p${index}`);
      assert.ok(human, `Expected p${index} to exist at ${playerCount} players`);
      assert.deepEqual(
        game.players.map((player) => player.role).sort(),
        createRoles(playerCount).sort()
      );
    }
  }
});

test("human player role assignment balances werewolf and village camp odds by player count", () => {
  const humanInput: HumanInputHandler = {
    async request(input) {
      if (input.kind === "speech_choice") {
        return { choiceId: input.options[0]?.id ?? "0" };
      }
      if (input.kind === "target") {
        return { targetId: input.candidates[0]?.id ?? null };
      }
      return { decision: false };
    }
  };
  const originalRandom = Math.random;

  try {
    for (const [roll, expectedCamp] of [
      [0.49, "werewolf"],
      [0.51, "village"]
    ] as const) {
      Math.random = () => roll;
      for (const playerCount of [6, 7, 8, 9, 10, 13, 14, maxSupportedPlayers]) {
        const game = new WerewolfGame(
          {
            ...baseConfig,
            playerCount,
            humanPlayerId: "p3"
          },
          { humanInput }
        ) as TestableGame;
        const human = game.players.find((player) => player.id === "p3");

        assert.ok(human);
        assert.equal(human.camp, expectedCamp, `${playerCount} players at roll ${roll} should assign ${expectedCamp}`);
        assert.deepEqual(
          game.players.map((player) => player.role).sort(),
          createRoles(playerCount).sort(),
          "balanced human assignment must not change the table's role distribution"
        );
      }
    }
  } finally {
    Math.random = originalRandom;
  }
});

test("human camp preference pins the human player to the requested camp", () => {
  const humanInput: HumanInputHandler = {
    async request(input) {
      if (input.kind === "speech_choice") {
        return { choiceId: input.options[0]?.id ?? "0" };
      }
      if (input.kind === "target") {
        return { targetId: input.candidates[0]?.id ?? null };
      }
      return { decision: false };
    }
  };

  for (const humanCampPreference of ["village", "werewolf"] as const) {
    for (const playerCount of [6, 7, 9, 14, maxSupportedPlayers]) {
      const game = new WerewolfGame(
        {
          ...baseConfig,
          playerCount,
          humanPlayerId: "p3",
          humanCampPreference
        },
        { humanInput }
      ) as TestableGame;
      const human = game.players.find((player) => player.id === "p3");

      assert.ok(human);
      assert.equal(human.camp, humanCampPreference);
      assert.deepEqual(
        game.players.map((player) => player.role).sort(),
        createRoles(playerCount).sort(),
        "camp preference must not change the table's role distribution"
      );
    }
  }
});

test("human role preference pins the human player to the requested role", () => {
  const humanInput: HumanInputHandler = {
    async request(input) {
      if (input.kind === "speech_choice") {
        return { choiceId: input.options[0]?.id ?? "0" };
      }
      if (input.kind === "target") {
        return { targetId: input.candidates[0]?.id ?? null };
      }
      return { decision: false };
    }
  };

  for (const humanRolePreference of ["Guard", "AlphaWolf", "Lover"] as const) {
    const game = new WerewolfGame(
      {
        ...baseConfig,
        playerCount: 6,
        humanPlayerId: "p3",
        humanCampPreference: humanRolePreference === "AlphaWolf" ? "village" : "werewolf",
        humanRolePreference
      },
      { humanInput }
    ) as TestableGame;
    const human = game.players.find((player) => player.id === "p3");

    assert.ok(human);
    assert.equal(human.role, humanRolePreference);
    assert.equal(human.camp, roleCamp(humanRolePreference));
    assert.deepEqual(
      game.players.map((player) => player.role).sort(),
      createRolesWithFixedHumanRole(6, humanRolePreference).sort(),
      "role preference adjusts the table only enough to include the fixed human role"
    );
  }
});

test("Japanese demo agents produce Japanese speech", async () => {
  const game = createGame();
  const [player] = setTable(game, [{ role: "Villager" }]);
  const agent = new DemoAgent("demo", "demo", "Japanese");

  const speech = await agent.speak({
    player,
    phase: "day_discussion",
    task: "昼議論で発言してください。",
    context: "公開議論です。",
    knownPlayers: [
      { id: "p1", name: "Ada" },
      { id: "p2", name: "Byron" }
    ],
    publicHistory: [],
    privateHistory: []
  });

  const messageText = speech.messages.join(" ");
  assert.match(messageText, /[ぁ-んァ-ヶ一-龠]/);
  assert.ok(speech.messages.every((message) => !message.endsWith("。")));
  assert.ok(speech.metadata.suspects.every((read) => /[ぁ-んァ-ヶ一-龠]/.test(read.reason ?? "")));
});

test("Japanese demo werewolf private chat uses night-kill context instead of day accusations", async () => {
  const game = createGame();
  const [player] = setTable(game, [{ role: "Werewolf" }]);
  const agent = new DemoAgent("demo", "demo", "Japanese");

  const speech = await agent.speak({
    player,
    phase: "werewolf_discussion",
    task: "夜の襲撃先を提案し、人狼陣営の完全勝利にどうつながるか説明してください。",
    context: [
      "あなたはAdaです。",
      "把握している人狼: Ada, Byron。",
      "襲撃候補: Curie, Darwin。",
      "村人を全排除するため、明日の昼に人間側として演じやすい襲撃先を選んでください。"
    ].join("\n"),
    knownPlayers: [
      { id: "p1", name: "Ada" },
      { id: "p2", name: "Byron" },
      { id: "p3", name: "Curie" },
      { id: "p4", name: "Darwin" }
    ],
    publicHistory: [],
    privateHistory: []
  });

  const messageText = speech.messages.join(" ");
  assert.match(messageText, /今夜|襲撃候補/);
  assert.match(messageText, /Curie|Darwin/);
  assert.ok(speech.messages.every((message) => !message.endsWith("。")));
  assert.doesNotMatch(messageText, /証拠が薄い|疑いが急に動いた|その主張/);
  assert.ok(speech.metadata.suspects.every((read) => read.targetId === "p3" || read.targetId === "p4"));
});

test("Japanese demo day speech and target reasons are rendered as visible Japanese sentences", async () => {
  const game = createGame();
  const [player] = setTable(game, [{ role: "Villager" }]);
  const agent = new DemoAgent("demo", "demo", "Japanese");
  const knownPlayers = [
    { id: "p1", name: "Ada" },
    { id: "p2", name: "Byron" },
    { id: "p3", name: "Curie" }
  ];

  const speech = await agent.speak({
    player,
    phase: "day_discussion",
    task: "昼議論で発言してください。",
    context: "公開議論です。",
    knownPlayers,
    publicHistory: [],
    privateHistory: []
  });
  const decision = await agent.chooseTarget({
    player,
    phase: "voting",
    action: "昼の処刑投票",
    context: "投票してください。",
    candidates: knownPlayers.filter((candidate) => candidate.id !== player.id),
    allowSkip: false
  });

  const messageText = speech.messages.join(" ");
  assert.match(messageText, /[\u3040-\u30ff\u4e00-\u9fff]/u);
  assert.ok(speech.messages.every((message) => !message.endsWith("。")));
  assert.match(decision.reason, /Ada|Byron|Curie|今日の発言|今の状況/);
});

test("Japanese demo day speech uses legal living read targets instead of dead known players", async () => {
  const game = createGame();
  const [player] = setTable(game, [{ role: "Villager" }]);
  const agent = new DemoAgent("demo", "demo", "Japanese");

  const speech = await agent.speak({
    player,
    phase: "day_discussion",
    task: "昼議論で発言してください。",
    context: "Alive players: Ada (p1), Byron (p2). Dead players: Curie (p3).",
    knownPlayers: [
      { id: "p1", name: "Ada" },
      { id: "p2", name: "Byron" },
      { id: "p3", name: "Curie" }
    ],
    legalPlayers: [{ id: "p2", name: "Byron" }],
    publicHistory: [],
    privateHistory: []
  });

  const messageText = speech.messages.join(" ");
  assert.doesNotMatch(messageText, /Curie/);
  assert.ok(speech.metadata.suspects.every((read) => read.targetId === "p2"));
  assert.ok(speech.metadata.trusts.every((read) => read.targetId === "p2"));
});

test("Japanese demo first-day speech opens with agenda instead of forced suspicion", async () => {
  const game = createGame();
  const [player] = setTable(game, [{ role: "Villager" }]);
  const agent = new DemoAgent("demo", "demo", "Japanese");

  const speech = await agent.speak({
    player,
    phase: "day_discussion",
    task: "昼議論で発言してください。",
    context: "現在のフェーズ: 昼議論。ラウンド: 1。",
    knownPlayers: [
      { id: "p1", name: "Ada" },
      { id: "p2", name: "Byron" },
      { id: "p3", name: "Curie" }
    ],
    publicHistory: [],
    privateHistory: []
  });

  const messageText = speech.messages.join(" ");
  assert.match(messageText, /初日|情報が少ない|誰の発言も材料|進め方|投票理由|占い師が名乗る条件|投票前/);
  assert.doesNotMatch(messageText, /人狼判定|確定|決めつけ/);
  assert.doesNotMatch(messageText, /返答に理由が少ない|乗っただけ|どの発言|発言がふわ|発言が曖昧|聞きたい|質問/);
  assert.equal(speech.metadata.suspects.length, 0);
});

test("Japanese demo speech is split into short sentence messages", async () => {
  const originalRandom = Math.random;
  Math.random = () => 0.4;

  try {
    const game = createGame();
    const [player] = setTable(game, [{ role: "Villager" }]);
    const agent = new DemoAgent("demo", "demo", "Japanese");

    const speech = await agent.speak({
      player,
      phase: "day_discussion",
      task: "昼議論で発言してください。",
      context: "Round: 1\n公開議論です。",
      knownPlayers: [
        { id: "p1", name: "Ada" },
        { id: "p2", name: "Byron" }
      ],
      publicHistory: [],
      privateHistory: []
    });

    assert.ok(speech.messages.length > 1);
    assert.ok(speech.messages.length <= 3);
    for (const message of speech.messages) {
      assert.ok(message.length <= 150);
      assert.doesNotMatch(message, /。$/);
      assert.ok((message.match(/[。！？!?]/g)?.length ?? 0) <= 1);
    }
  } finally {
    Math.random = originalRandom;
  }
});

test("Japanese demo werewolf does not fake a black Seer result on quiet first day", async () => {
  const game = createGame();
  const [player] = setTable(game, [{ role: "Werewolf" }]);
  const agent = new DemoAgent("demo", "demo", "Japanese");
  const input = {
    player,
    phase: "day_discussion" as const,
    task: "昼議論で発言してください。",
    context: "現在のフェーズ: 昼議論。ラウンド: 1。",
    knownPlayers: [
      { id: "p1", name: "Ada" },
      { id: "p2", name: "Byron" },
      { id: "p3", name: "Curie" }
    ],
    publicHistory: [],
    privateHistory: []
  };

  for (let i = 0; i < 20; i += 1) {
    const speech = await agent.speak(input);
    const messageText = speech.messages.join(" ");
    assert.doesNotMatch(messageText, /人狼判定|占い師として出ます/);
    assert.equal(speech.metadata.claims.some((claim) => claim.role === "Seer"), false);
  }
});

test("Japanese demo Seer claims a first-day white result", async () => {
  const game = createGame();
  const [player] = setTable(game, [{ role: "Seer" }, { role: "Villager" }, { role: "Villager" }]);
  player.seerResults = { p2: "village" };
  player.seerResultRounds = { p2: 1 };
  const agent = new DemoAgent("demo", "demo", "Japanese");

  const speech = await agent.speak({
    player,
    phase: "day_discussion",
    task: "昼議論で発言してください。",
    context: "現在のフェーズ: 昼議論。ラウンド: 1。",
    knownPlayers: [
      { id: "p1", name: "Ada" },
      { id: "p2", name: "Byron" },
      { id: "p3", name: "Curie" }
    ],
    publicHistory: [],
    privateHistory: []
  });

  assert.equal(speech.metadata.claims.some((claim) => claim.role === "Seer"), true);
  const messageText = speech.messages.join(" ");
  assert.match(messageText, /占い師を名乗ります|人間側判定|判定/);
});

test("Japanese demo voting reason uses pre-vote framing", async () => {
  const game = createGame();
  const [player] = setTable(game, [{ role: "Villager" }]);
  const agent = new DemoAgent("demo", "demo", "Japanese");
  const knownPlayers = [
    { id: "p1", name: "Ada" },
    { id: "p2", name: "Byron" },
    { id: "p3", name: "Curie" }
  ];

  const decision = await agent.chooseTarget({
    player,
    phase: "voting",
    action: "昼の処刑投票",
    context: "現在のフェーズ: 投票。ラウンド: 1。\nこれは今日の公開議論後、投票直前の最終判断です。",
    candidates: knownPlayers.filter((candidate) => candidate.id !== player.id),
    allowSkip: false
  });

  assert.match(decision.reason, /検証しやすい|投票理由|今日の発言/);
});

test("demo simulations for 6-9 players complete with consistent alive counts", async () => {
  for (const playerCount of [6, 7, 8, 9]) {
    for (let runIndex = 0; runIndex < 3; runIndex += 1) {
      const game = new WerewolfGame({ ...baseConfig, playerCount, maxRounds: 5 });
      const events = await collect(game.run());
      const ended = events.find((event) => event.type === "game_ended");

      assert.ok(ended, `expected ${playerCount}p run ${runIndex} to finish`);
      for (const event of events) {
        assert.equal(
          event.snapshot.aliveCount,
          event.snapshot.players.filter((player) => player.alive).length
        );
        assert.equal(event.snapshot.players.length, playerCount);
      }
    }
  }
});

test("the match opens on day one before any night actions", async () => {
  const game = new WerewolfGame({ ...baseConfig, playerCount: 7, maxRounds: 5 });
  const events = await collect(game.run());

  const firstDay = events.findIndex((event) => event.phase === "day_discussion");
  const firstNight = events.findIndex(
    (event) =>
      event.phase === "night" ||
      event.phase === "werewolf_discussion" ||
      event.phase === "guard_action" ||
      event.phase === "seer_action" ||
      event.phase === "witch_action"
  );

  assert.ok(firstDay >= 0, "expected a day_discussion phase");
  assert.ok(firstNight >= 0, "expected a night phase");
  assert.ok(firstDay < firstNight, "day one must come before the first night");

  // Round 1's day precedes any night, so no werewolf attack can happen before it.
  const firstDayEvent = events[firstDay];
  assert.equal(firstDayEvent.round, 1);
  assert.equal(
    events.slice(0, firstNight).some((event) => event.type === "death" && event.data?.cause === "werewolf"),
    false,
    "no werewolf attack should resolve before the first night"
  );
});

test("voting eliminates a single top-voted player and records totals", async () => {
  const game = createGame();
  const players = setTable(game, [
    { role: "Werewolf", targets: ["p4"] },
    { role: "Seer", targets: ["p4"] },
    { role: "Witch", targets: ["p4"] },
    { role: "Villager", targets: ["p1"] },
    { role: "Villager", targets: ["p1"] },
    { role: "Villager", targets: ["p2"] }
  ]);

  const events = await collect(game.runVoting());

  assert.equal(players[3].alive, false);
  assert.ok(events.some((event) => event.type === "vote_result"));
  assert.ok(events.some((event) => event.type === "death" && event.targetId === "p4"));
  const voteCast = events.find((event) => event.type === "vote_cast" && event.playerId === "p1");
  assert.equal(voteCast?.targetId, "p4");
  assert.equal(voteCast?.data?.reason, undefined);
  const totals = events.find((event) => event.type === "vote_result" && Array.isArray(event.data?.totals));
  const voteDetails = totals?.data?.votes as Array<{ voterId: string; targetId: string; reason?: string }> | undefined;
  assert.ok(voteDetails?.some((vote) => vote.voterId === "p1" && vote.targetId === "p4"));
  assert.ok(voteDetails?.every((vote) => vote.reason === undefined));
  const expectedPublicVote = `${players[0].name} -> ${players[3].name}`;
  assert.ok(game.publicHistory.some((line) => line.includes(expectedPublicVote) && !line.includes("scripted reason")));
  const summary = await game.emitRoundSummary();
  assert.ok(summary.message.includes("Votes:"));
});

test("human speech influence affects only a probabilistic subset of AI votes", async () => {
  const game = new WerewolfGame({
    ...baseConfig,
    playerCount: 15,
    humanPlayerId: "p1",
    language: "Japanese"
  }) as TestableGame;
  const players = setTable(
    game,
    Array.from({ length: 15 }, (_, index) => ({
      role: (index === 1 ? "Werewolf" : "Villager") as Role,
      targets: [index === 4 ? "p6" : "p5"]
    }))
  );
  const human = players[0];
  const suspect = players[3];
  const trusted = players[4];
  human.model = "human";
  game.lastDiscussion = [
    {
      playerId: human.id,
      playerName: human.name,
      message: `${suspect.name}が怪しい。${trusted.name}は信頼できる`,
      metadata: {
        suspects: [{ targetId: suspect.id, targetName: suspect.name, reason: "怪しい", weight: 1 }],
        trusts: [{ targetId: trusted.id, targetName: trusted.name, reason: "信頼できる", weight: 0.9 }],
        claims: []
      }
    }
  ];
  game.publicHistory.push(`${human.name}: ${suspect.name}が怪しい。${trusted.name}は信頼できる`);

  const events = await collect(game.runVoting());
  const aiPlayers = players.slice(1);
  const influenceModes = aiPlayers.map((player) => {
    const agent = game.agents.get(player.id) as ScriptedAgent;
    return agent.targetInputs[0]?.context.match(/人間プレイヤーの発言影響 - ([^:]+):/)?.[1] ?? "";
  });
  const aiVotes = events.filter((event) => event.type === "vote_cast" && event.playerId !== human.id);
  const suspectVotes = aiVotes.filter((event) => event.targetId === suspect.id).length;
  const trustedVotes = aiVotes.filter((event) => event.targetId === trusted.id).length;

  assert.ok(influenceModes.includes("採用"), "at least one AI should fully adopt the human read");
  assert.ok(influenceModes.includes("弱採用"), "at least one AI should only lean toward the human read");
  assert.ok(influenceModes.includes("保留"), "at least one AI should avoid automatic agreement");
  assert.ok(suspectVotes > 0, "some AI votes should move toward the human's suspect");
  assert.ok(trustedVotes > 0, "some AI votes should remain independent instead of all following the human");
  assert.ok(suspectVotes < aiVotes.length, "human influence should not make every AI vote the same way");
});

test("human speech influence does not override strong vote evidence", async () => {
  const game = new WerewolfGame({
    ...baseConfig,
    playerCount: 15,
    humanPlayerId: "p1",
    language: "Japanese"
  }) as TestableGame;
  const players = setTable(
    game,
    Array.from({ length: 15 }, (_, index) => ({
      role: (index === 1 ? "Werewolf" : "Villager") as Role,
      targets: ["p5"]
    }))
  );
  const human = players[0];
  const suspect = players[3];
  const trusted = players[4];
  const strongEvidenceVoter = players[10];
  human.model = "human";
  game.agents.set(strongEvidenceVoter.id, new ReasonKindTargetAgent(strongEvidenceVoter.name, trusted.id, "claim_reaction"));
  game.lastDiscussion = [
    {
      playerId: human.id,
      playerName: human.name,
      message: `${suspect.name}が怪しい。${trusted.name}は信頼できる`,
      metadata: {
        suspects: [{ targetId: suspect.id, targetName: suspect.name, reason: "怪しい", weight: 1 }],
        trusts: [{ targetId: trusted.id, targetName: trusted.name, reason: "信頼できる", weight: 0.9 }],
        claims: []
      }
    }
  ];

  const events = await collect(game.runVoting());
  const agent = game.agents.get(strongEvidenceVoter.id) as ReasonKindTargetAgent;
  const influenceMode = agent.targetInputs[0]?.context.match(/人間プレイヤーの発言影響 - ([^:]+):/)?.[1] ?? "";
  const vote = events.find((event) => event.type === "vote_cast" && event.playerId === strongEvidenceVoter.id);

  assert.equal(influenceMode, "採用");
  assert.equal(vote?.targetId, trusted.id);
});

test("human speech challenge mode avoids redirecting pressure onto the human player", async () => {
  const game = new WerewolfGame({
    ...baseConfig,
    playerCount: 6,
    humanPlayerId: "p1",
    language: "Japanese",
    maxRounds: 8
  }) as TestableGame;
  const players = setTable(game, [
    { role: "Villager", targets: ["p4"] },
    { role: "Werewolf", targets: ["p4"] },
    { role: "Seer", targets: ["p4"] },
    { role: "Witch", targets: ["p4"] },
    { role: "Villager", targets: ["p4"] },
    { role: "Villager", targets: ["p4"] }
  ]);
  const human = players[0];
  const suspect = players[3];
  const trusted = players[5];
  const challengeVoter = players[5];
  human.model = "human";
  (game as unknown as { round: number }).round = 3;
  game.lastDiscussion = [
    {
      playerId: human.id,
      playerName: human.name,
      message: `${suspect.name}が怪しい。${trusted.name}は信頼できる`,
      metadata: {
        suspects: [{ targetId: suspect.id, targetName: suspect.name, reason: "怪しい", weight: 1 }],
        trusts: [{ targetId: trusted.id, targetName: trusted.name, reason: "信頼できる", weight: 0.9 }],
        claims: []
      }
    }
  ];

  const events = await collect(game.runVoting());
  const agent = game.agents.get(challengeVoter.id) as ScriptedAgent;
  const influenceMode = agent.targetInputs[0]?.context.match(/人間プレイヤーの発言影響 - ([^:]+):/)?.[1] ?? "";
  const vote = events.find((event) => event.type === "vote_cast" && event.playerId === challengeVoter.id);

  assert.equal(influenceMode, "反論余地");
  assert.notEqual(vote?.targetId, human.id);
  assert.notEqual(vote?.targetId, suspect.id);
});

test("human trust without suspicion can still protect weakly trusted vote targets", async () => {
  const game = new WerewolfGame({
    ...baseConfig,
    playerCount: 15,
    humanPlayerId: "p1",
    language: "Japanese"
  }) as TestableGame;
  const players = setTable(
    game,
    Array.from({ length: 15 }, (_, index) => ({
      role: (index === 1 ? "Werewolf" : "Villager") as Role,
      targets: ["p5"]
    }))
  );
  const human = players[0];
  const trusted = players[4];
  const adoptingVoter = players[1];
  human.model = "human";
  game.lastDiscussion = [
    {
      playerId: human.id,
      playerName: human.name,
      message: `${trusted.name}は信頼できる`,
      metadata: {
        suspects: [],
        trusts: [{ targetId: trusted.id, targetName: trusted.name, reason: "信頼できる", weight: 0.9 }],
        claims: []
      }
    }
  ];

  const events = await collect(game.runVoting());
  const agent = game.agents.get(adoptingVoter.id) as ScriptedAgent;
  const influenceMode = agent.targetInputs[0]?.context.match(/人間プレイヤーの発言影響 - ([^:]+):/)?.[1] ?? "";
  const vote = events.find((event) => event.type === "vote_cast" && event.playerId === adoptingVoter.id);

  assert.equal(influenceMode, "採用");
  assert.notEqual(vote?.targetId, trusted.id);
  assert.notEqual(vote?.targetId, human.id);
});

test("Raven mark adds a vote modifier to the next execution vote", async () => {
  const game = createGame();
  const players = setTable(game, [
    { role: "Raven", targets: ["p5", "p6"] },
    { role: "Villager", targets: ["p6"] },
    { role: "Villager", targets: ["p5"] },
    { role: "Villager", targets: ["p5"] },
    { role: "Villager", targets: ["p6"] },
    { role: "Werewolf", targets: ["p5"] }
  ]);

  await collect(game.runRavenAction(players[0]));
  const ravenAgent = game.agents.get(players[0].id) as ScriptedAgent;
  assert.equal(ravenAgent.targetInputs[0].allowSkip, true);
  assert.ok(ravenAgent.targetInputs[0].candidates.every((candidate) => candidate.id !== players[0].id));

  const events = await collect(game.runVoting());
  const totals = events.find((event) => event.type === "vote_result" && Array.isArray(event.data?.totals));

  assert.equal(players[4].alive, false);
  assert.ok(events.some((event) => event.type === "death" && event.targetId === "p5" && event.data?.cause === "vote"));
  assert.equal(totals?.data?.modifiers, undefined);
});

test("Raven mark can be skipped without adding a vote modifier", async () => {
  const game = createGame();
  const players = setTable(game, [
    { role: "Raven", targets: [null] },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Werewolf" }
  ]);

  const events = await collect(game.runRavenAction(players[0]));
  const ravenAgent = game.agents.get(players[0].id) as ScriptedAgent;

  assert.equal(ravenAgent.targetInputs[0].allowSkip, true);
  assert.deepEqual(events, []);
  assert.ok(
    Object.values(game.ruleState.players).every((playerState) =>
      playerState.statuses.every((status) => status.kind !== "raven_marked")
    )
  );
});

test("Idiot survives first vote execution and loses future voting rights", async () => {
  const game = createGame();
  const players = setTable(game, [
    { role: "Werewolf", targets: ["p4"] },
    { role: "Seer", targets: ["p4"] },
    { role: "Witch", targets: ["p4"] },
    { role: "Idiot", targets: ["p1"] },
    { role: "Villager", targets: ["p4"] },
    { role: "Villager", targets: ["p4"] }
  ]);

  const events = await collect(game.runVoting());

  assert.equal(players[3].alive, true);
  assert.ok(!events.some((event) => event.type === "death" && event.targetId === "p4"));
  assert.ok(events.some((event) => event.type === "vote_result" && event.data?.action === "idiot_revealed"));
});

test("revealed Idiot cannot vote but can still be targeted by later votes", async () => {
  const game = createGame();
  const players = setTable(game, [
    { role: "Werewolf", targets: ["p4"] },
    { role: "Seer", targets: ["p4"] },
    { role: "Witch", targets: ["p4"] },
    { role: "Idiot", targets: ["p1"] },
    { role: "Villager", targets: ["p4"] },
    { role: "Villager", targets: ["p4"] }
  ]);

  await collect(game.runVoting());
  assert.equal(players[3].alive, true);

  for (const player of players) {
    game.agents.set(player.id, new PreferTargetAgent(player.name, "p4"));
  }

  const events = await collect(game.runVoting());

  assert.equal(players[3].alive, false);
  assert.ok(!events.some((event) => event.type === "vote_cast" && event.playerId === "p4"));
  assert.ok(events.some((event) => event.type === "death" && event.targetId === "p4" && event.data?.cause === "vote"));
});

test("Elder vote death disables remaining village special abilities", async () => {
  const game = createGame();
  const players = setTable(game, [
    { role: "Werewolf", targets: ["p4"] },
    { role: "Seer", targets: ["p4", "p1"] },
    { role: "Witch", targets: ["p4"] },
    { role: "Elder", targets: ["p1"] },
    { role: "Villager", targets: ["p4"] },
    { role: "Villager", targets: ["p4"] }
  ]);

  const voteEvents = await collect(game.runVoting());
  const seerEvents = await collect(game.runSeerAction());

  assert.equal(players[3].alive, false);
  assert.ok(voteEvents.some((event) => event.type === "system" && event.data?.action === "elder_penalty"));
  assert.equal(players[1].seerResults.p1, undefined);
  assert.equal(seerEvents.length, 0);
});

test("split speech emits one event per message and records metadata once", async () => {
  const game = createGame();
  const players = setTable(game, [
    {
      role: "Villager",
      targets: ["p2"],
      speeches: [
        {
          messages: ["First short line.", "Second short line."],
          metadata: {
            claims: [],
            suspects: [{ targetId: "p2", targetName: "Byron", reason: "late stance", weight: 0.6 }],
            trusts: []
          }
        },
        {
          messages: ["Reply line."],
          metadata: {
            claims: [],
            suspects: [],
            trusts: [{ targetId: "p3", targetName: "Curie", reason: "answered clearly", weight: 0.5 }]
          }
        }
      ]
    },
    { role: "Werewolf", targets: ["p1"] },
    { role: "Seer", targets: ["p1"] },
    { role: "Witch", targets: ["p1"] },
    { role: "Villager", targets: ["p1"] },
    { role: "Villager", targets: ["p1"] }
  ]);

  const events = await collect(game.runDay());
  const speechEvents = events.filter((event) => event.type === "player_speech" && event.playerId === players[0].id);
  const firstPassEvents = speechEvents.filter((event) => event.data?.discussionPass === 1);
  const secondPassEvents = speechEvents.filter((event) => event.data?.discussionPass === 2);

  assert.deepEqual(
    firstPassEvents.map((event) => event.message),
    ["First short line.", "Second short line."]
  );
  assert.deepEqual(
    firstPassEvents.map((event) => event.data?.speechIndex),
    [0, 1]
  );
  assert.deepEqual(
    firstPassEvents.map((event) => event.data?.speechCount),
    [2, 2]
  );
  assert.equal((firstPassEvents[0].data?.suspects as unknown[]).length, 0);
  assert.equal((firstPassEvents[1].data?.suspects as unknown[]).length, 1);
  assert.deepEqual(secondPassEvents.map((event) => event.message), ["Reply line."]);
  assert.equal((secondPassEvents[0].data?.trusts as unknown[]).length, 1);
  assert.deepEqual(
    speechEvents.map((event) => event.data?.discussionPass),
    [1, 1, 2]
  );
  assert.deepEqual(
    speechEvents.map((event) => event.data?.discussionPasses),
    [2, 2, 2]
  );
  assert.match(game.publicHistory.join("\n"), /Public read note \(not spoken\): .* suspects Byron/);
  assert.doesNotMatch(game.publicHistory.join("\n"), /Suspects:/);
  assert.doesNotMatch(game.publicHistory.join("\n"), /Trusts:/);
});

test("day discussion gives each living player a second response pass", async () => {
  const game = createGame();
  const players = setTable(game, [
    { role: "Villager", targets: ["p2"] },
    { role: "Werewolf", targets: ["p1"] },
    { role: "Seer", targets: ["p1"] },
    { role: "Witch", targets: ["p1"] },
    { role: "Villager", targets: ["p1"] },
    { role: "Villager", targets: ["p1"] }
  ]);

  const aliveIds = players.filter((player) => player.alive).map((player) => player.id);
  const events = await collect(game.runDay());
  const speechEvents = events.filter((event) => event.type === "player_speech" && event.phase === "day_discussion");

  assert.deepEqual(
    speechEvents.filter((event) => event.data?.discussionPass === 1).map((event) => event.playerId),
    aliveIds
  );
  assert.deepEqual(
    speechEvents.filter((event) => event.data?.discussionPass === 2).map((event) => event.playerId),
    aliveIds
  );

  const firstAgent = game.agents.get(players[0].id) as ScriptedAgent;
  assert.equal(firstAgent.speechInputs.length, 2);
  assert.match(firstAgent.speechInputs[0].context, /これまでの会話/);
  assert.doesNotMatch(firstAgent.speechInputs[0].context, /Discussion pass 1 of 2/);
  assert.doesNotMatch(firstAgent.speechInputs[1].context, /Second pass: if needed, answer direct pressure/);
  assert.match(firstAgent.speechInputs[1].context, /ノゾミ speaks/);
});

test("every first-day first-pass speaker receives a distinct opening move prompt", async () => {
  const game = new WerewolfGame({ ...baseConfig, language: "Japanese" }) as TestableGame;
  const players = setTable(game, [
    { role: "Villager", targets: ["p2"] },
    { role: "Werewolf", targets: ["p1"] },
    { role: "Seer", targets: ["p1"] },
    { role: "Witch", targets: ["p1"] },
    { role: "Guard", targets: ["p1"] },
    { role: "Villager", targets: ["p1"] }
  ]);
  (game as unknown as { round: number }).round = 1;

  await collect(game.runDay());

  const allowedKinds = new Set<string>([...firstDayOpeningMoveKinds, ...firstDayWerewolfOpeningMoveKinds]);
  const assignedKinds: string[] = [];
  for (const player of players) {
    const agent = game.agents.get(player.id) as ScriptedAgent;
    const kind = agent.speechInputs[0].speechPlan?.firstDayOpeningMove?.kind;
    // Every first-pass speaker gets a concrete, non-conclusory opening move so the
    // round-one table never degenerates into content-free filler.
    assert.ok(kind && allowedKinds.has(kind), `expected an opening move for ${player.id}`);
    assert.doesNotMatch(agent.speechInputs[0].context, /初日特別モード/);
    // The second pass no longer carries an opening move.
    assert.equal(agent.speechInputs.at(-1)?.speechPlan?.firstDayOpeningMove, undefined);
    assignedKinds.push(kind as string);
  }
  assert.equal((game.agents.get(players[1].id) as ScriptedAgent).speechInputs[0].speechPlan?.firstDayOpeningMove?.kind, "wolf_fake_role_claim");

  // With as many distinct moves as speakers, the table covers varied topics.
  assert.equal(new Set(assignedKinds).size, players.length);
});

test("later day first-pass speakers do not receive opening move prompts", async () => {
  const game = new WerewolfGame({ ...baseConfig, language: "Japanese" }) as TestableGame;
  const players = setTable(game, [
    { role: "Villager", targets: ["p2"] },
    { role: "Werewolf", targets: ["p1"] },
    { role: "Seer", targets: ["p1"] },
    { role: "Witch", targets: ["p1"] },
    { role: "Guard", targets: ["p1"] },
    { role: "Villager", targets: ["p1"] }
  ]);
  (game as unknown as { round: number }).round = 2;

  await collect(game.runDay());

  for (const player of players) {
    const agent = game.agents.get(player.id) as ScriptedAgent;
    assert.equal(agent.speechInputs[0].speechPlan?.firstDayOpeningMove, undefined);
    assert.doesNotMatch(agent.speechInputs[0].context, /初日特別モード/);
  }
});

test("werewolf Seer fake claim persists and forces later fake results", async () => {
  const emptyMetadata: AgentSpeech["metadata"] = { claims: [], suspects: [], trusts: [] };
  const game = new WerewolfGame({ ...baseConfig, language: "Japanese", prefetchConcurrency: 1 }) as TestableGame;
  const players = setTable(game, [
    {
      role: "Werewolf",
      targets: ["p2"],
      speeches: [
        { messages: ["私は占い師です。黒結果が出るまでは伏せます"], metadata: emptyMetadata },
        { messages: ["今日は投票前に理由を見ます"], metadata: emptyMetadata },
        { messages: ["投票理由の薄い人を候補に入れます"], metadata: emptyMetadata }
      ]
    },
    { role: "Villager", targets: ["p3"], speeches: [{ messages: ["投票理由を確認します"], metadata: emptyMetadata }] },
    { role: "Villager", targets: ["p2"], speeches: [{ messages: ["占い主張は一旦見ます"], metadata: emptyMetadata }] },
    { role: "Villager", targets: ["p2"], speeches: [{ messages: ["今日は理由の薄さで見ます"], metadata: emptyMetadata }] },
    { role: "Villager", targets: ["p2"], speeches: [{ messages: ["投票前に発言を比べます"], metadata: emptyMetadata }] },
    { role: "Villager", targets: ["p2"], speeches: [{ messages: ["便乗だけは避けたいです"], metadata: emptyMetadata }] }
  ]);
  const wolf = players[0];
  (game as unknown as { round: number }).round = 1;

  await collect(game.runDay());

  for (const player of players) {
    player.alive = true;
  }
  game.ruleState = createInitialRuleState(game.players);
  game.lastDiscussion = [];
  (game as unknown as { round: number }).round = 2;
  const secondDayWolfAgent = new ScriptedAgent(wolf.name, ["p2"], [], [
    { messages: ["今日はまだ様子を見ます"], metadata: emptyMetadata },
    { messages: ["今日はまだ様子を見ます"], metadata: emptyMetadata }
  ]);
  game.agents.set(wolf.id, secondDayWolfAgent);

  const secondDayEvents = await collect(game.runDay());
  const fakeResultEvents = secondDayEvents.filter(
    (event) => event.type === "player_speech" && event.playerId === wolf.id && /占い師として結果を出します。.+判定です/.test(event.message)
  );
  const fakeResultEvent = fakeResultEvents[0];

  assert.equal(fakeResultEvents.length, 1);
  assert.ok(fakeResultEvent);
  assert.match(secondDayWolfAgent.speechInputs[0].context, /公開上の偽装方針/);
  assert.match(secondDayWolfAgent.speechInputs[0].context, /秘密の人狼偽装タスク/);
  assert.match(secondDayWolfAgent.speechInputs[0].context, /今日必ず出す偽結果/);
  assert.match(secondDayWolfAgent.speechInputs[1].context, /前の発言案では必要な偽占い結果が出ていません/);
  const claims = fakeResultEvent.data?.claims as Array<{ role?: Role; result?: { targetId?: string; camp?: Camp } }> | undefined;
  assert.ok(claims?.some((claim) => claim.role === "Seer" && claim.result?.targetId && claim.result?.camp));
});

test("werewolf fake Seer result detection requires result wording and exact player ids", () => {
  const game = new WerewolfGame({ ...baseConfig, language: "Japanese" }) as TestableGame;
  const detector = game as unknown as {
    speechMentionsCampResult(text: string, result: SeerClaimResult): boolean;
  };
  const result: SeerClaimResult = {
    targetId: "p1",
    targetName: "Ada",
    camp: "werewolf",
    round: 2
  };

  assert.equal(detector.speechMentionsCampResult("占い師として結果を出します。Adaは狼陣営判定です", result), true);
  assert.equal(detector.speechMentionsCampResult("占い師として結果を出します。p1は黒です", result), true);
  assert.equal(detector.speechMentionsCampResult("占い師として結果を出します。p10は狼陣営判定です", result), false);
  assert.equal(detector.speechMentionsCampResult("Adaは狼を探す姿勢があるので今日は残します", result), false);
});

test("true Seer result task retries and falls back to public CO when ignored", async () => {
  const emptyMetadata: AgentSpeech["metadata"] = { claims: [], suspects: [], trusts: [] };
  const game = new WerewolfGame({ ...baseConfig, language: "Japanese", prefetchConcurrency: 1 }) as TestableGame;
  const players = setTable(game, [
    {
      role: "Seer",
      speeches: [
        { messages: ["今日は投票理由を見ます"], metadata: emptyMetadata },
        { messages: ["まだ焦らずに発言を比べます"], metadata: emptyMetadata }
      ]
    },
    { role: "Werewolf", targets: ["p1"], speeches: [{ messages: ["投票理由を確認します"], metadata: emptyMetadata }] },
    { role: "Villager", targets: ["p2"], speeches: [{ messages: ["占い師の条件を見ます"], metadata: emptyMetadata }] },
    { role: "Villager", targets: ["p2"], speeches: [{ messages: ["今日は発言の薄さを見ます"], metadata: emptyMetadata }] },
    { role: "Villager", targets: ["p2"], speeches: [{ messages: ["投票前に整理します"], metadata: emptyMetadata }] },
    { role: "Villager", targets: ["p2"], speeches: [{ messages: ["便乗には注意します"], metadata: emptyMetadata }] }
  ]);
  const seer = players[0];
  seer.seerResults = { p2: "werewolf" };
  seer.seerResultRounds = { p2: 1 };
  (game as unknown as { round: number }).round = 2;

  const events = await collect(game.runDay());
  const seerAgent = game.agents.get(seer.id) as ScriptedAgent;
  const seerSpeech = events.find(
    (event) =>
      event.type === "player_speech" &&
      event.playerId === seer.id &&
      /ここで占い師を名乗ります。.+(?:人狼|狼陣営)判定です/.test(event.message)
  );

  assert.ok(seerSpeech);
  assert.match(seerAgent.speechInputs[0].context, /真占い師公開タスク/);
  assert.match(seerAgent.speechInputs[0].context, /今日公開する占い結果/);
  assert.match(seerAgent.speechInputs[1].context, /前の発言案では真占い師の公開タスクが未達成/);
  const claims = seerSpeech.data?.claims as Array<{ role?: Role; result?: { targetId?: string; camp?: Camp } }> | undefined;
  assert.ok(claims?.some((claim) => claim.role === "Seer" && claim.result?.targetId === "p2" && claim.result.camp === "werewolf"));
  const disclosure = (game as unknown as { seerDisclosures: Map<string, { publiclyClaimed: boolean; announcedResultIds: Set<string> }> })
    .seerDisclosures.get(seer.id);
  assert.equal(disclosure?.publiclyClaimed, true);
  assert.equal(disclosure?.announcedResultIds.has("p2"), true);
});

test("true Seer public claim persists and forces later unannounced real results", async () => {
  const emptyMetadata: AgentSpeech["metadata"] = { claims: [], suspects: [], trusts: [] };
  const game = new WerewolfGame({ ...baseConfig, language: "Japanese", prefetchConcurrency: 1 }) as TestableGame;
  const players = setTable(game, [
    {
      role: "Seer",
      speeches: [
        { messages: ["今日は投票理由を見ます"], metadata: emptyMetadata },
        { messages: ["まだ結果更新は置きます"], metadata: emptyMetadata }
      ]
    },
    { role: "Werewolf", targets: ["p1"], speeches: [{ messages: ["投票理由を確認します"], metadata: emptyMetadata }] },
    { role: "Villager", targets: ["p2"], speeches: [{ messages: ["占い主張は見ます"], metadata: emptyMetadata }] },
    { role: "Villager", targets: ["p2"], speeches: [{ messages: ["今日は発言を比べます"], metadata: emptyMetadata }] },
    { role: "Villager", targets: ["p2"], speeches: [{ messages: ["投票前に整理します"], metadata: emptyMetadata }] },
    { role: "Villager", targets: ["p2"], speeches: [{ messages: ["便乗には注意します"], metadata: emptyMetadata }] }
  ]);
  const seer = players[0];
  seer.seerResults = { p2: "werewolf", p3: "village" };
  seer.seerResultRounds = { p2: 1, p3: 2 };
  game.publicHistory.push("Ada: ここで占い師を名乗ります。Byronは人狼判定です");
  (game as unknown as { seerDisclosures: Map<string, { publiclyClaimed: boolean; claimRound: number; announcedResultIds: Set<string> }> })
    .seerDisclosures.set(seer.id, {
      publiclyClaimed: true,
      claimRound: 2,
      announcedResultIds: new Set(["p2"])
    });
  (game as unknown as { round: number }).round = 3;

  const secondEvents = await collect(game.runDay());
  const seerAgent = game.agents.get(seer.id) as ScriptedAgent;
  const updateSpeech = secondEvents.find(
    (event) => event.type === "player_speech" && event.playerId === seer.id && /占い師として結果を更新します。.+人間側判定です/.test(event.message)
  );

  assert.ok(updateSpeech);
  assert.match(seerAgent.speechInputs[0].context, /公開CO状態/);
  assert.match(seerAgent.speechInputs[0].context, /あなたは占い師として名乗っています/);
  assert.match(seerAgent.speechInputs[0].context, /今日公開する占い結果/);
  assert.match(seerAgent.speechInputs[1].context, /前の発言案では必要な真占い結果が出ていません/);
  const disclosure = (game as unknown as { seerDisclosures: Map<string, { announcedResultIds: Set<string> }> }).seerDisclosures.get(seer.id);
  assert.equal(disclosure?.announcedResultIds.has("p2"), true);
  assert.equal(disclosure?.announcedResultIds.has("p3"), true);
});

test("day discussion context includes authoritative current roster status after night deaths", async () => {
  const game = new WerewolfGame({ ...baseConfig, language: "Japanese" }) as TestableGame;
  const players = setTable(game, [
    { role: "Werewolf", targets: ["p2"] },
    { role: "Villager" },
    { role: "Seer", targets: ["p1"] },
    { role: "Witch", targets: [null], decisions: [false] },
    { role: "Villager" },
    { role: "Villager" }
  ]);

  (game as unknown as { round: number }).round = 2;
  await collect(game.runNight());
  await collect(game.runDay());

  const firstWolf = game.agents.get(players[0].id) as ScriptedAgent;
  const dayInput = firstWolf.speechInputs.find((input) => input.phase === "day_discussion");
  assert.ok(dayInput);
  assert.equal(dayInput.speechPlan?.requiresForwardMove, true);
  assert.match(dayInput.context, /現在の状況/);
  assert.match(dayInput.context, /現在の参加者ステータス/);
  assert.match(dayInput.context, new RegExp(`生存中: .*${players[0].name}`));
  assert.match(dayInput.context, new RegExp(`死亡済み: ${players[1].name}`));
  assert.match(dayInput.context, new RegExp(`昨夜死亡: ${players[1].name}`));
  assert.match(dayInput.context, /疑い・信頼・投票候補として扱えるのは生存中の人物だけ/);
  assert.match(dayInput.context, new RegExp(`死亡者: ${players[1].name}`));
  assert.doesNotMatch(dayInput.context, /公開知識|公開上の死因|魔女の毒薬|死因候補を並べるだけで終わらず/);
});

test("speech diagnostics record single simple public speech completion", async () => {
  const diagnostics: SpeechGenerationDiagnostic[] = [];
  const game = new WerewolfGame(
    { ...baseConfig, provider: "llm", model: "scripted", language: "Japanese", prefetchConcurrency: 1 },
    { onSpeechDiagnostics: (diagnostic) => diagnostics.push(diagnostic) }
  ) as TestableGame;
  const players = setTable(game, [
    { role: "Werewolf", targets: ["p2"] },
    { role: "Villager" },
    { role: "Seer" },
    { role: "Witch", targets: [null], decisions: [false] },
    { role: "Villager" },
    { role: "Villager" }
  ]);

  (game as unknown as { round: number }).round = 2;
  await collect(game.runNight());

  const emptyMetadata: AgentSpeech["metadata"] = { claims: [], suspects: [], trusts: [] };
  game.agents.set(
    players[0].id,
    new ScriptedAgent(players[0].name, [], [], [
      {
        messages: [`${players[1].name}の死から考えると、噛まれたか毒かの二択です。`],
        metadata: emptyMetadata
      },
      {
        messages: [`${players[2].name}さんは昨日の発言と${players[1].name}さんの死亡のつながりが薄いので、疑い寄りで見ます。`],
        metadata: emptyMetadata
      }
    ])
  );

  const events = await collect(game.runDay());

  const speechEvent = events.find((event) => event.type === "player_speech" && event.playerId === players[0].id);
  assert.equal(speechEvent?.message, `${players[1].name}の死から考えると、噛まれたか毒かの二択です。`);
  const completed = diagnostics.find((diagnostic) => diagnostic.kind === "speech_completed" && diagnostic.playerId === players[0].id);
  assert.ok(completed);
  assert.equal(completed.attempts, 1);
  assert.equal(completed.retried, false);
  assert.equal(completed.speechPlanReviewEnabled, false);
  assert.equal(diagnostics.some((diagnostic) => diagnostic.kind === "speech_review_rejected" && diagnostic.playerId === players[0].id), false);
  assert.equal(diagnostics.some((diagnostic) => diagnostic.kind === "speech_retry_accepted" && diagnostic.playerId === players[0].id), false);
});

test("Japanese public speech retries when Chinese vocabulary appears", async () => {
  const diagnostics: SpeechGenerationDiagnostic[] = [];
  const game = new WerewolfGame(
    { ...baseConfig, provider: "llm", model: "scripted", language: "Japanese", prefetchConcurrency: 1 },
    { onSpeechDiagnostics: (diagnostic) => diagnostics.push(diagnostic) }
  ) as TestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" },
    { role: "Villager" }
  ]);

  const emptyMetadata: AgentSpeech["metadata"] = { claims: [], suspects: [], trusts: [] };
  game.agents.set(
    players[0].id,
    new ScriptedAgent(players[0].name, [], [], [
      {
        messages: ["初日は发言を控えて、様子を見るべきだと思います"],
        metadata: emptyMetadata
      },
      {
        messages: ["初日は発言を控えすぎず、投票基準を先に出します"],
        metadata: emptyMetadata
      }
    ])
  );

  const events = await collect(game.runDay());
  const speechEvent = events.find((event) => event.type === "player_speech" && event.playerId === players[0].id);

  assert.equal(speechEvent?.message, "初日は発言を控えすぎず、投票基準を先に出します");
  assert.doesNotMatch(speechEvent?.message ?? "", /发言/);
  assert.ok(diagnostics.some((diagnostic) => diagnostic.kind === "speech_review_rejected" && diagnostic.playerId === players[0].id));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.kind === "speech_retry_accepted" && diagnostic.playerId === players[0].id));
  const completed = diagnostics.find((diagnostic) => diagnostic.kind === "speech_completed" && diagnostic.playerId === players[0].id);
  assert.ok(completed);
  assert.equal(completed.attempts, 2);
  assert.equal(completed.retried, true);
});

test("simple public speech does not run old timeline rejection", async () => {
  const diagnostics: SpeechGenerationDiagnostic[] = [];
  const game = new WerewolfGame(
    { ...baseConfig, provider: "llm", model: "scripted", language: "Japanese", prefetchConcurrency: 1 },
    { onSpeechDiagnostics: (diagnostic) => diagnostics.push(diagnostic) }
  ) as TestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" },
    { role: "Villager" }
  ]);

  const emptyMetadata: AgentSpeech["metadata"] = { claims: [], suspects: [], trusts: [] };
  game.agents.set(
    players[0].id,
    new ScriptedAgent(players[0].name, [], [], [
      {
        messages: [`${players[1].name}の言う通り、${players[2].name}の煙幕っぽい動きは気になります。`],
        metadata: emptyMetadata
      },
      {
        messages: [`${players[2].name}は人物傾向として、初日は保留より疑い寄りで見ます。`],
        metadata: emptyMetadata
      }
    ])
  );

  const events = await collect(game.runDay());

  const speechEvent = events.find((event) => event.type === "player_speech" && event.playerId === players[0].id);
  assert.equal(speechEvent?.message, `${players[1].name}の言う通り、${players[2].name}の煙幕っぽい動きは気になります。`);
  assert.equal(diagnostics.some((diagnostic) => diagnostic.kind === "speech_review_rejected" && diagnostic.playerId === players[0].id), false);
  assert.equal(diagnostics.some((diagnostic) => diagnostic.kind === "speech_retry_accepted" && diagnostic.playerId === players[0].id), false);
});

test("simple public speech does not retry into guarded first-day fallback", async () => {
  const diagnostics: SpeechGenerationDiagnostic[] = [];
  const game = new WerewolfGame(
    { ...baseConfig, provider: "llm", model: "scripted", language: "Japanese", prefetchConcurrency: 1 },
    { onSpeechDiagnostics: (diagnostic) => diagnostics.push(diagnostic) }
  ) as TestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" },
    { role: "Villager" }
  ]);

  const emptyMetadata: AgentSpeech["metadata"] = { claims: [], suspects: [], trusts: [] };
  game.agents.set(
    players[0].id,
    new ScriptedAgent(players[0].name, [], [], [
      {
        messages: ["とりあえず様子を見る"],
        metadata: emptyMetadata
      },
      {
        messages: ["まだ状況が見えないから、今は保留させて"],
        metadata: emptyMetadata
      },
      {
        messages: [`${players[1].name}は投票基準がはっきりしたので信頼寄りで見ます`],
        metadata: {
          claims: [],
          suspects: [],
          trusts: [{ targetId: players[1].id, targetName: players[1].name, reason: "投票基準がはっきりしている", weight: 0.5 }]
        }
      }
    ])
  );

  const events = await collect(game.runDay());
  const firstPassSpeech = events.find(
    (event) => event.type === "player_speech" && event.playerId === players[0].id && event.data?.discussionPass === 1
  );

  assert.ok(firstPassSpeech);
  assert.equal(firstPassSpeech.message, "とりあえず様子を見る");
  assert.equal(diagnostics.some((diagnostic) => diagnostic.kind === "speech_retry_rejected" && diagnostic.playerId === players[0].id), false);
  const completed = diagnostics.find((diagnostic) => diagnostic.kind === "speech_completed" && diagnostic.playerId === players[0].id);
  assert.ok(completed);
  assert.equal(completed.attempts, 1);
  assert.equal(completed.retried, false);
});

test("speech fallback stays simple and ignores old public speech plan", () => {
  const game = new WerewolfGame({ ...baseConfig, language: "Japanese" }) as TestableGame;
  const players = setTable(game, [{ role: "Villager" }, { role: "Werewolf" }, { role: "Seer" }]);
  const fallbackGame = game as unknown as {
    simpleSpeechFallback(input: AgentSpeechInput, legalPlayers: TargetCandidate[], speechPlan?: PublicSpeechPlan): AgentSpeech;
  };
  const legalPlayers: TargetCandidate[] = [
    { id: players[1].id, name: players[1].name },
    { id: players[2].id, name: players[2].name }
  ];
  const plan: PublicSpeechPlan = {
    phase: "day_discussion",
    round: 2,
    lastNightDeaths: [],
    possibleNightDeathCauses: [],
    intents: ["state_living_read"],
    requiresForwardMove: true
  };
  const baseInput: AgentSpeechInput = {
    player: players[0],
    phase: "day_discussion",
    task: "昼議論で発言してください。",
    context: "公開情報をもとに発言してください。",
    knownPlayers: players.map((playerInfo) => ({ id: playerInfo.id, name: playerInfo.name })),
    legalPlayers,
    publicHistory: [],
    privateHistory: []
  };

  const visibleTargetSpeech = fallbackGame.simpleSpeechFallback(
    {
      ...baseInput,
      publicHistory: [`${players[2].name}: 占い師の名乗りは結果を見てから信じたいです。`]
    },
    legalPlayers,
    plan
  );
  assert.doesNotMatch(visibleTargetSpeech.messages[0], new RegExp(players[2].name));
  assert.doesNotMatch(visibleTargetSpeech.messages[0], new RegExp(players[1].name));
  assert.deepEqual(visibleTargetSpeech.metadata, { suspects: [], trusts: [], claims: [] });

  const noTargetSpeech = fallbackGame.simpleSpeechFallback(baseInput, legalPlayers, plan);
  assert.doesNotMatch(noTargetSpeech.messages[0], new RegExp(players[1].name));
  assert.match(noTargetSpeech.messages[0], /見えている発言/);
  assert.deepEqual(noTargetSpeech.metadata, { suspects: [], trusts: [], claims: [] });
});

test("speech sanitization drops claim metadata not supported by displayed text", () => {
  const game = new WerewolfGame({ ...baseConfig, language: "Japanese" }) as TestableGame;
  const players = setTable(game, [{ role: "Seer" }, { role: "Villager" }, { role: "Werewolf" }]);
  const sanitizer = game as unknown as {
    sanitizeSpeechForPhase(speech: AgentSpeech, legalPlayers: TargetCandidate[], speaker?: TargetCandidate): AgentSpeech;
  };
  const legalPlayers: TargetCandidate[] = players.slice(1).map(({ id, name }) => ({ id, name }));

  const policyTalk = sanitizer.sanitizeSpeechForPhase(
    {
      messages: ["皆さん、まず占い師を名乗る条件を決めましょう"],
      metadata: {
        suspects: [],
        trusts: [],
        claims: [{ type: "role_claim", role: "Seer" }]
      }
    },
    legalPlayers,
    players[0]
  );
  assert.deepEqual(policyTalk.metadata.claims, []);

  const reportedOtherPlayerClaim = sanitizer.sanitizeSpeechForPhase(
    {
      messages: [`${players[1].name}さんが占い師を主張しましたが、初日で結果が出ていない以上、今はまだ保留ですね`],
      metadata: {
        suspects: [],
        trusts: [],
        claims: [{ type: "role_claim", role: "Seer" }]
      }
    },
    legalPlayers,
    players[0]
  );
  assert.deepEqual(reportedOtherPlayerClaim.metadata.claims, []);

  const visibleClaim = sanitizer.sanitizeSpeechForPhase(
    {
      messages: [`私は占い師です。${players[1].name}は人間側判定です`],
      metadata: {
        suspects: [],
        trusts: [],
        claims: [
          {
            type: "role_claim",
            role: "Seer",
            result: { targetId: players[1].id, targetName: players[1].name, camp: "village", round: 1 }
          }
        ]
      }
    },
    legalPlayers,
    players[0]
  );
  assert.equal(visibleClaim.metadata.claims.length, 1);

  const implicitOwnClaim = sanitizer.sanitizeSpeechForPhase(
    {
      messages: [`ここで占い師を名乗ります。${players[1].name}は人間側判定です`],
      metadata: {
        suspects: [],
        trusts: [],
        claims: [
          {
            type: "role_claim",
            role: "Seer",
            result: { targetId: players[1].id, targetName: players[1].name, camp: "village", round: 1 }
          }
        ]
      }
    },
    legalPlayers,
    players[0]
  );
  assert.equal(implicitOwnClaim.metadata.claims.length, 1);
});

test("day discussion race publishes the fastest AI and rebuilds the next race from that speech", async () => {
  const game = new WerewolfGame({ ...baseConfig, prefetchConcurrency: 5 }) as TestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" },
    { role: "Villager", alive: false }
  ]);
  game.agents.set(players[0].id, new DelayedSpeechAgent(players[0].name, [50], () => "slow first candidate"));
  game.agents.set(players[1].id, new DelayedSpeechAgent(players[1].name, [1], () => "FAST marker"));
  game.agents.set(
    players[2].id,
    new DelayedSpeechAgent(players[2].name, [30, 1], (input) =>
      input.context.includes("FAST marker") ? "saw FAST marker" : "missed FAST marker"
    )
  );
  for (const player of players.slice(3)) {
    game.agents.set(player.id, new DelayedSpeechAgent(player.name, [50], () => `${player.name} slow`));
  }

  const events = await collect(game.runDay());
  const firstPassEvents = events.filter((event) => event.type === "player_speech" && event.data?.discussionPass === 1);

  assert.equal(firstPassEvents[0].playerId, players[1].id);
  assert.equal(firstPassEvents[0].message, "FAST marker");
  assert.equal(firstPassEvents[1].playerId, players[2].id);
  assert.equal(firstPassEvents[1].message, "saw FAST marker");
});

test("day discussion race uses spare slots for duplicate generation near the end", async () => {
  const game = new WerewolfGame({ ...baseConfig, prefetchConcurrency: 5 }) as TestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf", alive: false },
    { role: "Seer", alive: false },
    { role: "Witch", alive: false },
    { role: "Villager", alive: false },
    { role: "Villager", alive: false }
  ]);
  const agent = new DelayedSpeechAgent(players[0].name, [50, 1, 50, 50, 50, 1], (_input, call) => `attempt ${call}`);
  game.agents.set(players[0].id, agent);

  const events = await collect(game.runDay());
  const firstPassEvents = events.filter((event) => event.type === "player_speech" && event.data?.discussionPass === 1);

  assert.equal(firstPassEvents[0].message, "attempt 1");
  assert.equal(agent.speechInputs.slice(0, 5).length, 5);
});

test("simple conversation plan drives day one without agenda scheduler directives", async () => {
  const game = new WerewolfGame({ ...baseConfig, prefetchConcurrency: 5 }) as TestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  (game as unknown as { round: number }).round = 1;
  for (const player of players) {
    game.agents.set(player.id, new DelayedSpeechAgent(player.name, [1], () => `${player.name} spoke`));
  }

  await collect(game.runDay());

  const allContexts = players
    .map((player) => game.agents.get(player.id) as DelayedSpeechAgent)
    .flatMap((agent) => agent.speechInputs.map((input) => input.context));

  assert.ok(allContexts.length > 0);
  assert.ok(allContexts.some((context) => context.includes("人物設定")), "day speech should include character context");
  assert.ok(allContexts.some((context) => context.includes("役職")), "day speech should include role context");
  assert.ok(allContexts.some((context) => context.includes("これまでの会話")), "day speech should include conversation history");
  assert.ok(allContexts.every((context) => !context.includes("First-day opening mode")), "opening sparks should not be injected into prompts");
  assert.ok(allContexts.every((context) => !context.includes("Speech plan")), "speech-plan scaffolding should not be injected");
  assert.ok(
    allContexts.every((context) => !context.includes("Discussion agenda")),
    "agenda scheduler context should not be injected"
  );
  assert.ok(
    allContexts.every((context) => !context.includes("Your secret plan for this round")),
    "no omniscient director directive should be injected"
  );
});

type OpeningTestableGame = TestableGame & {
  round: number;
  lastNightDeaths: string[];
  runFirstDayWarmupPass(): AsyncGenerator<GameEvent>;
  runLoverFaceoffPass(): AsyncGenerator<GameEvent>;
  runWerewolfFaceoffPass(): AsyncGenerator<GameEvent>;
};

test("first-day werewolf face-off: every AI wolf uses a fixed role line, secret to the camp", async () => {
  const game = new WerewolfGame({ ...baseConfig, prefetchConcurrency: 5 }) as OpeningTestableGame;
  const players = setTable(game, [
    { role: "AlphaWolf" },
    { role: "Villager" },
    { role: "WolfBeauty" },
    { role: "Seer" },
    { role: "Werewolf" },
    { role: "Villager" }
  ]);
  game.round = 1;
  for (const player of players) {
    game.agents.set(player.id, new IntroAgent(player.name));
  }

  const events = await collect(game.runWerewolfFaceoffPass());
  const speeches = events.filter((event) => event.type === "player_speech");
  const wolves = players.filter((player) => player.camp === "werewolf");

  // Only the werewolf-camp members speak, each with one of the fixed character/role lines.
  assert.deepEqual(
    new Set(speeches.map((event) => event.playerId)),
    new Set(wolves.map((player) => player.id)),
    "every werewolf-camp member introduces themselves, and no villager does"
  );
  for (const event of speeches) {
    const speaker = wolves.find((wolf) => wolf.id === event.playerId);
    assert.ok(speaker);
    assert.ok(
      werewolfFaceoffLineOptionsForPlayer(speaker, baseConfig.language).includes(event.message),
      `${speaker.name} should speak one fixed ${speaker.role} face-off line`
    );
  }
  assert.ok(speeches.some((event) => event.message.includes("α人狼")));
  assert.ok(speeches.some((event) => event.message.includes("美女狼")));
  assert.ok(speeches.some((event) => event.message.includes("人狼")));

  for (const player of players) {
    const agent = game.agents.get(player.id) as IntroAgent;
    assert.equal(agent.werewolfIntroCalls.length, 0, "face-off fixed lines should not call improviseWerewolfIntro");
    assert.equal(agent.speakCalls.length, 0, "face-off fixed lines should not call speak()");
  }

  // The whole meeting is werewolf-visibility and announced with a secret phase change.
  assert.ok(speeches.every((event) => event.data?.visibility === "werewolf"), "intros are werewolf-visibility");
  const phaseChange = events.find((event) => event.type === "phase_changed");
  assert.ok(phaseChange && phaseChange.data?.visibility === "werewolf", "the opening banner is secret to the camp");

  // Redaction: a villager sees nothing; a werewolf-camp viewer sees the real lines.
  const villager = players.find((player) => player.camp === "village")!;
  for (const event of speeches) {
    const villagerView = redactEventForPlayer(event, villager.id);
    assert.equal(villagerView.message, redactEventForVillage(event).message);
    assert.notEqual(villagerView.message, event.message, "villagers must not see the werewolf face-off");
    const wolfView = redactEventForPlayer(event, wolves[0].id);
    assert.equal(wolfView.message, event.message, "any werewolf-camp viewer sees the face-off");
  }
});

test("first-day werewolf face-off randomizes AI speaker order and records fixed lines", async () => {
  const game = new WerewolfGame({ ...baseConfig, prefetchConcurrency: 5 }) as OpeningTestableGame;
  const players = setTable(game, [
    { role: "AlphaWolf" },
    { role: "WolfBeauty" },
    { role: "Werewolf" },
    { role: "Villager" },
    { role: "Seer" },
    { role: "Villager" }
  ]);
  game.round = 1;
  for (const player of players) {
    game.agents.set(player.id, new IntroAgent(player.name));
  }

  const originalRandom = Math.random;
  const rolls = [0, 0, 0, 0, 0];
  Math.random = () => rolls.shift() ?? 0;
  try {
    const events = await collect(game.runWerewolfFaceoffPass());
    const speeches = events.filter((event) => event.type === "player_speech");
    const wolves = players.filter((player) => player.camp === "werewolf");

    assert.deepEqual(
      speeches.map((event) => event.playerId),
      [wolves[1].id, wolves[2].id, wolves[0].id],
      "AI werewolf face-off order is shuffled instead of table order"
    );
    assert.deepEqual(
      game.wolfHistory,
      speeches.map((event) => `${event.playerName}: ${event.message}`)
    );
    assert.ok(
      speeches.every((event) => {
        const speaker = wolves.find((wolf) => wolf.id === event.playerId);
        return Boolean(speaker && werewolfFaceoffLineOptionsForPlayer(speaker, baseConfig.language).includes(event.message));
      })
    );
    for (const wolf of wolves) {
      const agent = game.agents.get(wolf.id) as IntroAgent;
      assert.equal(agent.speechInputs.length, 0, "fixed face-off lines do not build LLM prompts");
    }
  } finally {
    Math.random = originalRandom;
  }
});

test("fixed werewolf face-off lines avoid hard special-role fake-claim plans", () => {
  const lines = characterProfiles.flatMap((profile) =>
    werewolfFaceoffRoles.flatMap((role) =>
      werewolfFaceoffLineOptionsForPlayer(
        {
          name: profile.nameJa,
          role,
          characterProfile: profile
        },
        "Japanese"
      )
    )
  );

  assert.ok(lines.every((line) => !/(占い師|占い|霊能|霊媒|騎士|狩人|魔女|ハンター|鴉|愚者|長老|共有)/u.test(line)));
  assert.ok(lines.every((line) => !/(襲撃先|噛み先|明日は.*騙|CO|カミングアウト)/iu.test(line)));
});

test("first-day werewolf face-off lets the human werewolf speak with free text at the end", async () => {
  const requests: HumanInputRequestPayload[] = [];
  const humanInput: HumanInputHandler = {
    async request(input) {
      requests.push(input);
      if (input.kind === "speech_choice") {
        return { speech: "  俺は自由入力で合わせます。昼は人間側の顔で潜る。  " };
      }
      if (input.kind === "target") {
        return { targetId: input.candidates[0]?.id ?? null, reason: "人間プレイヤーの判断です。" };
      }
      return { decision: false };
    }
  };
  const game = new WerewolfGame(
    { ...baseConfig, humanPlayerId: "p1", language: "Japanese", prefetchConcurrency: 5 },
    { humanInput }
  ) as OpeningTestableGame;
  const players = setTable(game, [
    { role: "Werewolf" },
    { role: "AlphaWolf" },
    { role: "Villager" },
    { role: "Seer" },
    { role: "Villager" }
  ]);
  game.round = 1;
  for (const player of players) {
    game.agents.set(player.id, new IntroAgent(player.name));
  }
  // Mark p1 (the human werewolf) as human-controlled.
  players[0].model = "human";

  const events = await collect(game.runWerewolfFaceoffPass());
  const speeches = events.filter((event) => event.type === "player_speech");
  const speakerIds = new Set(speeches.map((event) => event.playerId));
  const humanSpeech = speeches.find((event) => event.playerId === players[0].id);
  const request = requests.find((entry) => entry.kind === "speech_choice");

  assert.ok(request && request.kind === "speech_choice");
  assert.equal(request.phase, "werewolf_discussion");
  assert.equal(request.speechMode, "werewolf_alignment");
  assert.equal(request.nonBlocking, true);
  assert.equal(request.allowFreeText, true);
  assert.equal(request.options.length, 0);
  assert.ok(request.context.notes.some((line) => line.includes("あなたの人狼陣営の仲間")));
  assert.ok(request.context.notes.some((line) => line.includes(`この顔合わせで先に出た仲間の発言`)));
  assert.equal(speakerIds.has(players[0].id), true, "the human werewolf speaks from their submitted face-off input");
  assert.ok(speakerIds.has(players[1].id), "the AI ally still introduces itself so the human learns the team");
  assert.equal(speakerIds.size, 2, "the AI ally and human input line are both emitted");
  assert.ok(humanSpeech);
  assert.equal(humanSpeech.message, "俺は自由入力で合わせます。昼は人間側の顔で潜る");
  assert.equal(humanSpeech.data?.automaticHumanAlignment, undefined);
  assert.equal(game.wolfHistory.length, 2, "the human input line is retained for later wolf context");
  assert.ok(game.wolfHistory.some((line) => line.includes(humanSpeech.message)));
});

test("first-day lover face-off: paired lovers use fixed partner lines, secret to the pair", async () => {
  const game = new WerewolfGame({ ...baseConfig, prefetchConcurrency: 5 }) as OpeningTestableGame;
  const players = setTable(game, [
    { role: "Lover" },
    { role: "Villager" },
    { role: "Lover" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Villager" }
  ]);
  game.round = 1;
  for (const player of players) {
    game.agents.set(player.id, new IntroAgent(player.name));
  }

  const events = await collect(game.runLoverFaceoffPass());
  const speeches = events.filter((event) => event.type === "player_speech");
  const lovers = [players[0], players[2]];

  assert.deepEqual(
    new Set(speeches.map((event) => event.playerId)),
    new Set(lovers.map((player) => player.id)),
    "both lovers introduce themselves, and unrelated players do not"
  );
  for (const event of speeches) {
    const speaker = lovers.find((lover) => lover.id === event.playerId);
    const partner = lovers.find((lover) => lover.id !== event.playerId);
    assert.ok(speaker && partner);
    assert.ok(
      loverFaceoffLineOptionsForPlayer(speaker, partner, baseConfig.language).includes(event.message),
      `${speaker.name} should speak one fixed lover face-off line naming ${partner.name}`
    );
  }

  assert.ok(speeches.every((event) => event.data?.visibility === "lover"), "lover lines are lover-visibility");
  assert.ok(
    speeches.every((event) => Array.isArray(event.data?.loverIds) && lovers.every((lover) => (event.data?.loverIds as string[]).includes(lover.id))),
    "lover lines carry the pair ids"
  );
  const phaseChange = events.find((event) => event.type === "phase_changed");
  assert.ok(phaseChange && phaseChange.data?.visibility === "lover", "the opening banner is secret to the pair");

  const outsider = players[1];
  for (const event of speeches) {
    const outsiderView = redactEventForPlayer(event, outsider.id);
    assert.equal(outsiderView.message, redactEventForVillage(event).message);
    assert.notEqual(outsiderView.message, event.message, "non-partners must not see the lover face-off");
    for (const lover of lovers) {
      const loverView = redactEventForPlayer(event, lover.id);
      assert.equal(loverView.message, event.message, "either lover sees the private pair face-off");
      assert.equal(loverView.snapshot.players.find((player) => player.id === lovers.find((candidate) => candidate.id !== lover.id)?.id)?.role, "Lover");
    }
  }

  for (const player of players) {
    const agent = game.agents.get(player.id) as IntroAgent;
    assert.equal(agent.speakCalls.length, 0, "fixed lover face-off lines should not call speak()");
  }
});

test("first-day lover face-off lets the human lover speak with free text at the end", async () => {
  const requests: HumanInputRequestPayload[] = [];
  const humanInput: HumanInputHandler = {
    async request(input) {
      requests.push(input);
      if (input.kind === "speech_choice") {
        return { speech: "  相方確認。昼は距離を取る  " };
      }
      if (input.kind === "target") {
        return { targetId: input.candidates[0]?.id ?? null, reason: "人間プレイヤーの判断です。" };
      }
      return { decision: false };
    }
  };
  const game = new WerewolfGame(
    { ...baseConfig, humanPlayerId: "p1", language: "Japanese", prefetchConcurrency: 5 },
    { humanInput }
  ) as OpeningTestableGame;
  const players = setTable(game, [
    { role: "Lover" },
    { role: "Lover" },
    { role: "Werewolf" },
    { role: "Villager" },
    { role: "Seer" },
    { role: "Villager" }
  ]);
  game.round = 1;
  for (const player of players) {
    game.agents.set(player.id, new IntroAgent(player.name));
  }
  players[0].model = "human";

  const events = await collect(game.runLoverFaceoffPass());
  const speeches = events.filter((event) => event.type === "player_speech");
  const speakerIds = new Set(speeches.map((event) => event.playerId));
  const humanSpeech = speeches.find((event) => event.playerId === players[0].id);
  const request = requests.find((entry) => entry.kind === "speech_choice");

  assert.ok(request && request.kind === "speech_choice");
  assert.equal(request.phase, "lover_discussion");
  assert.equal(request.speechMode, "lover_alignment");
  assert.equal(request.nonBlocking, true);
  assert.equal(request.allowFreeText, true);
  assert.equal(request.options.length, 0);
  assert.ok(request.context.notes.some((line) => line.includes("あなたの恋人ペア")));
  assert.ok(request.context.notes.some((line) => line.includes("この恋人顔合わせで先に出た相方の発言")));
  assert.equal(speakerIds.has(players[0].id), true, "the human lover speaks from their submitted face-off input");
  assert.ok(speakerIds.has(players[1].id), "the AI partner still introduces itself so the human learns the pair");
  assert.equal(speakerIds.size, 2, "the AI partner and human input line are both emitted");
  assert.ok(humanSpeech);
  assert.equal(humanSpeech.message, "相方確認。昼は距離を取る");
  assert.equal(humanSpeech.data?.visibility, "lover");
});

test("first-day werewolf face-off is a no-op for a lone wolf", async () => {
  const game = new WerewolfGame({ ...baseConfig, prefetchConcurrency: 5 }) as OpeningTestableGame;
  const players = setTable(game, [
    { role: "Werewolf" },
    { role: "Villager" },
    { role: "Seer" },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  game.round = 1;
  for (const player of players) {
    game.agents.set(player.id, new IntroAgent(player.name));
  }

  const events = await collect(game.runWerewolfFaceoffPass());
  assert.equal(events.length, 0, "a single werewolf has no allies to meet");
});

test("first-day opening runs the werewolf face-off before dawn breaks", async () => {
  const game = new WerewolfGame({ ...baseConfig, provider: "llm", model: "scripted", prefetchConcurrency: 5 }) as OpeningTestableGame;
  const players = setTable(game, [
    { role: "Werewolf" },
    { role: "AlphaWolf" },
    { role: "Villager" },
    { role: "Seer" },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  game.round = 1;
  for (const player of players) {
    game.agents.set(player.id, new IntroAgent(player.name));
  }

  const events = await collect(game.runDay());
  const faceoffIndex = events.findIndex(
    (event) => event.type === "player_speech" && event.phase === "werewolf_discussion" && event.data?.visibility === "werewolf"
  );
  const dayBeginsIndex = events.findIndex((event) => event.type === "phase_changed" && /begins|始まりました/.test(String(event.message)));

  assert.ok(faceoffIndex >= 0, "the werewolf face-off runs on the first day's opening");
  assert.ok(dayBeginsIndex >= 0, "the public day still opens");
  assert.ok(faceoffIndex < dayBeginsIndex, "the secret werewolf meeting precedes the public day");
});

test("first-day opening runs the lover face-off after the werewolf face-off and before dawn breaks", async () => {
  const game = new WerewolfGame({ ...baseConfig, provider: "llm", model: "scripted", prefetchConcurrency: 5 }) as OpeningTestableGame;
  const players = setTable(game, [
    { role: "Werewolf" },
    { role: "AlphaWolf" },
    { role: "Lover" },
    { role: "Lover" },
    { role: "Seer" },
    { role: "Villager" }
  ]);
  game.round = 1;
  for (const player of players) {
    game.agents.set(player.id, new IntroAgent(player.name));
  }

  const events = await collect(game.runDay());
  const werewolfFaceoffIndex = events.findIndex(
    (event) => event.type === "player_speech" && event.phase === "werewolf_discussion" && event.data?.visibility === "werewolf"
  );
  const loverFaceoffIndex = events.findIndex(
    (event) => event.type === "player_speech" && event.phase === "lover_discussion" && event.data?.visibility === "lover"
  );
  const dayBeginsIndex = events.findIndex((event) => event.type === "phase_changed" && event.phase === "day_discussion");

  assert.ok(werewolfFaceoffIndex >= 0, "the werewolf face-off runs on the first day's opening");
  assert.ok(loverFaceoffIndex >= 0, "the lover face-off runs on the first day's opening");
  assert.ok(dayBeginsIndex >= 0, "the public day still opens");
  assert.ok(werewolfFaceoffIndex < loverFaceoffIndex, "the lover face-off follows the werewolf face-off");
  assert.ok(loverFaceoffIndex < dayBeginsIndex, "the lover face-off precedes the public day");
});

test("day-1 fixed werewolf face-off does not call face-off generation while warm-up runs", async () => {
  const faceoffGate = createDeferred<void>();
  const introGate = createDeferred<void>();
  const faceoffStarted = createDeferred<string>();
  const introStarted = createDeferred<string>();
  const speakStarted = createDeferred<string>();
  const game = new WerewolfGame({ ...baseConfig, provider: "llm", model: "scripted", prefetchConcurrency: 5 }) as OpeningTestableGame;
  const players = setTable(game, [
    { role: "Werewolf" },
    { role: "AlphaWolf" },
    { role: "Villager" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" }
  ]);
  game.round = 1;
  for (const player of players) {
    game.agents.set(
      player.id,
      new BlockingFaceoffAgent(
        player.name,
        faceoffGate.promise,
        introGate.promise,
        (playerId) => faceoffStarted.resolve(playerId),
        (playerId) => introStarted.resolve(playerId),
        (playerId) => speakStarted.resolve(playerId)
      )
    );
  }

  const iterator = game.runDay();
  const faceoffBanner = await iterator.next();
  assert.equal(faceoffBanner.value?.phase, "werewolf_discussion");
  assert.equal(faceoffBanner.value?.type, "phase_changed");

  const firstFaceoffSpeech = await iterator.next();
  assert.equal(firstFaceoffSpeech.value?.type, "player_speech");
  assert.equal(firstFaceoffSpeech.value?.phase, "werewolf_discussion");
  assert.ok(firstFaceoffSpeech.value?.playerId);

  const faceoffPlayerId = await Promise.race([faceoffStarted.promise, sleepWithAbort(100).then(() => "timeout")]);
  assert.equal(faceoffPlayerId, "timeout", "fixed face-off lines must not call improviseWerewolfIntro");
  const firstFaceoffSpeaker = players.find((player) => player.id === firstFaceoffSpeech.value?.playerId);
  assert.ok(firstFaceoffSpeaker);
  assert.ok(werewolfFaceoffLineOptionsForPlayer(firstFaceoffSpeaker, baseConfig.language).includes(firstFaceoffSpeech.value.message));

  const introPlayerId = await Promise.race([introStarted.promise, sleepWithAbort(100).then(() => "timeout")]);
  assert.notEqual(introPlayerId, "timeout", "day warm-up generation still starts during the fixed face-off display");
  const earlySpeechPlayerId = await Promise.race([speakStarted.promise, sleepWithAbort(100).then(() => "timeout")]);
  assert.equal(earlySpeechPlayerId, "timeout", "the first real day speech must wait until all warm-up lines are generated");

  const secondFaceoffSpeech = await iterator.next();
  assert.equal(secondFaceoffSpeech.value?.type, "player_speech");
  assert.equal(secondFaceoffSpeech.value?.phase, "werewolf_discussion");
  const dayBegins = await iterator.next();
  assert.equal(dayBegins.value?.type, "phase_changed");
  assert.equal(dayBegins.value?.phase, "day_discussion");

  const pendingWarmupSpeech = iterator.next();
  introGate.resolve();
  const warmupSpeech = await pendingWarmupSpeech;
  assert.equal(warmupSpeech.value?.type, "player_speech");
  assert.equal(warmupSpeech.value?.phase, "day_discussion");
  assert.equal(warmupSpeech.value?.data?.warmup, true);
  await iterator.return?.(undefined);
});

test("day-1 warm-up emits a fast self-intro for every living AI player with the warmup flag", async () => {
  const game = new WerewolfGame({ ...baseConfig, prefetchConcurrency: 5 }) as OpeningTestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" }
  ]);
  game.round = 1;
  const agents = players.map((player) => {
    const agent = new IntroAgent(player.name);
    game.agents.set(player.id, agent);
    return agent;
  });

  const events = await collect(game.runFirstDayWarmupPass());
  const speeches = events.filter((event) => event.type === "player_speech");

  assert.equal(speeches.length, players.length, "every living AI player gives one intro");
  assert.ok(speeches.every((event) => event.data?.warmup === true), "intros are flagged as warm-up");
  assert.ok(
    speeches.every((event) => typeof event.message === "string" && event.message.startsWith("INTRO ")),
    "the fast improviseIntro path is used, not speak()"
  );
  assert.ok(agents.every((agent) => agent.speakCalls.length === 0), "the warm-up never falls back to the heavy speak() path here");
  assert.deepEqual(
    new Set(speeches.map((event) => event.playerId)),
    new Set(players.map((player) => player.id)),
    "all living players are represented"
  );
});

test("day-1 warm-up publishes completed intros without waiting for an earlier slow speaker", async () => {
  const game = new WerewolfGame({ ...baseConfig, provider: "llm", model: "scripted", prefetchConcurrency: 2 }) as OpeningTestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" }
  ]);
  game.round = 1;
  game.agents.set(players[0].id, new DelayedIntroAgent(players[0].name, 10_000));
  game.agents.set(players[1].id, new DelayedIntroAgent(players[1].name, 1));
  game.agents.set(players[2].id, new DelayedIntroAgent(players[2].name, 1));
  game.agents.set(players[3].id, new DelayedIntroAgent(players[3].name, 1));

  const iterator = game.runFirstDayWarmupPass();
  const firstWarmup = await Promise.race([iterator.next(), sleepWithAbort(100).then(() => "timeout" as const)]);

  assert.notEqual(firstWarmup, "timeout", "a later completed warm-up should be yielded while the first speaker is still blocked");
  assert.equal(firstWarmup.value?.type, "player_speech");
  assert.equal(firstWarmup.value?.playerId, players[1].id);
  await iterator.return?.(undefined);
});

test("day-1 warm-up excludes the human player", async () => {
  const game = new WerewolfGame({ ...baseConfig, humanPlayerId: "p3", prefetchConcurrency: 5 }) as OpeningTestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Villager" },
    { role: "Seer" },
    { role: "Villager" }
  ]);
  game.round = 1;
  for (const player of players) {
    game.agents.set(player.id, new IntroAgent(player.name));
  }
  // Mark p3 (index 2) as the human-controlled player.
  const human = players[2];
  human.model = "human";

  const events = await collect(game.runFirstDayWarmupPass());
  const speakerIds = new Set(events.filter((event) => event.type === "player_speech").map((event) => event.playerId));

  assert.ok(!speakerIds.has(human.id), "the human player does not give a warm-up intro");
  assert.equal(speakerIds.size, players.length - 1, "every AI player intros, the human is skipped");
});

test("human day interrupt mode keeps day-1 warm-up before opening optional interrupts", async () => {
  const optionalRequests: HumanInputRequestPayload[] = [];
  const humanInput: HumanInputHandler = {
    async request(input) {
      if (input.kind === "speech_choice") {
        return { speech: "" };
      }
      if (input.kind === "target") {
        return { targetId: input.candidates[0]?.id ?? null, reason: "Human player vote." };
      }
      return { decision: false };
    },
    async requestOptional(input) {
      optionalRequests.push(input);
      return null;
    }
  };
  const game = new WerewolfGame(
    { ...baseConfig, provider: "llm", model: "scripted", humanPlayerId: "p1", prefetchConcurrency: 5 },
    { humanInput }
  ) as OpeningTestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  game.round = 1;
  players[0].model = "human";
  for (const player of players.slice(1)) {
    game.agents.set(player.id, new IntroAgent(player.name));
  }

  const events = await collect(game.runDay());
  const speeches = events.filter((event) => event.type === "player_speech" && event.phase === "day_discussion");
  const warmups = speeches.filter((event) => event.data?.warmup === true);
  const firstRegular = speeches.find((event) => event.data?.discussionPass === 1);

  assert.ok(speeches.length > 0, "regular day discussion should still run");
  assert.equal(warmups.length, players.length - 1, "human interrupt mode still shows one warm-up speech for every AI player");
  assert.ok(speeches.slice(0, warmups.length).every((event) => event.data?.warmup === true), "warm-up speeches come first");
  assert.ok(firstRegular, "regular discussion starts after warm-up");
  assert.ok(
    warmups.every((event) => event.id < firstRegular.id),
    "the first regular speech is published after every warm-up speech"
  );
  assert.ok(optionalRequests.length > 0, "the optional interrupt opens after the first regular AI speech");
  assert.equal(optionalRequests[0]?.revealAfterEventId, firstRegular.id);
  assert.ok(
    optionalRequests[0]?.context.publicHistory.every((line) => !line.includes("INTRO ")),
    "warm-up lines stay out of the optional interrupt context"
  );
});

test("first-day opening keeps the human player last even when the human is p1", async () => {
  const humanInput: HumanInputHandler = {
    async request(input) {
      if (input.kind === "speech_choice") {
        return { choiceId: input.options[0]?.id ?? "0" };
      }
      if (input.kind === "target") {
        return { targetId: input.candidates[0]?.id ?? null, reason: "Human vote." };
      }
      return { decision: false };
    }
  };
  const game = new WerewolfGame(
    { ...baseConfig, provider: "llm", model: "scripted", humanPlayerId: "p1", prefetchConcurrency: 5 },
    { humanInput }
  ) as OpeningTestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  game.agents.set(players[0].id, new HumanInputAgent(players[0].name, humanInput, "English"));
  players[0].model = "human";
  for (const player of players.slice(1)) {
    game.agents.set(player.id, new IntroAgent(player.name));
  }

  const events = await collect(game.runDay());
  const firstPassSpeakers = events
    .filter((event) => event.type === "player_speech" && event.data?.discussionPass === 1)
    .map((event) => event.playerId)
    .filter((playerId, index, all) => index === 0 || all[index - 1] !== playerId);

  assert.ok(firstPassSpeakers.length >= 2);
  assert.equal(firstPassSpeakers[firstPassSpeakers.length - 1], players[0].id);
  assert.ok(firstPassSpeakers.slice(0, -1).every((playerId) => playerId !== players[0].id));
});

test("day-1 warm-up stays out of real discussion history", async () => {
  const game = new WerewolfGame({ ...baseConfig, provider: "llm", model: "scripted", prefetchConcurrency: 5 }) as OpeningTestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" }
  ]);
  game.round = 1;
  for (const player of players) {
    game.agents.set(player.id, new IntroAgent(player.name));
  }

  const events = await collect(game.runDay());
  const warmups = events.filter((event) => event.type === "player_speech" && event.data?.warmup === true);
  const firstRegular = events.find((event) => event.type === "player_speech" && event.data?.discussionPass === 1);
  const firstAgent = game.agents.get(players[0].id) as IntroAgent;
  const firstSpeechInput = firstAgent.speechInputs[0];

  assert.ok(warmups.length > 0, "LLM day one still emits day-zero warm-up resolves");
  assert.ok(firstRegular, "regular day discussion still follows warm-up");
  assert.ok(firstSpeechInput, "the first regular speech is generated");
  assert.match(firstSpeechInput.context, /これまでの会話:\n- まだありません。/);
  assert.doesNotMatch(firstSpeechInput.context, /INTRO /, "warm-up lines must not be visible discussion evidence");
});

test("day-1 warm-up generation starts before the public day event and real speech waits", async () => {
  const introGate = createDeferred<void>();
  const introStarted = createDeferred<string>();
  const speakStarted = createDeferred<string>();
  const game = new WerewolfGame({ ...baseConfig, provider: "llm", model: "scripted", prefetchConcurrency: 5 }) as OpeningTestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" }
  ]);
  for (const player of players) {
    game.agents.set(
      player.id,
      new BlockingFaceoffAgent(
        player.name,
        Promise.resolve(),
        introGate.promise,
        () => undefined,
        (playerId) => introStarted.resolve(playerId),
        (playerId) => speakStarted.resolve(playerId)
      )
    );
  }

  const iterator = game.run();
  const firstEvent = await iterator.next();
  assert.equal(firstEvent.value?.type, "game_started");

  const dayStart = await iterator.next();
  assert.equal(dayStart.value?.type, "phase_changed");
  assert.equal(dayStart.value?.phase, "day_discussion");
  const introPlayerId = await Promise.race([introStarted.promise, sleepWithAbort(100).then(() => "timeout")]);
  assert.notEqual(introPlayerId, "timeout", "day warm-up generation starts before the public day event is consumed");
  const earlySpeechPlayerId = await Promise.race([speakStarted.promise, sleepWithAbort(100).then(() => "timeout")]);
  assert.equal(earlySpeechPlayerId, "timeout", "the first real day speech waits for all warm-up generation");

  introGate.resolve();
  const startedPlayerId = await Promise.race([speakStarted.promise, sleepWithAbort(100).then(() => "timeout")]);
  assert.equal(startedPlayerId, players[0].id, "the first real day speech starts after warm-up generation finishes");
  await iterator.return?.(undefined);
});

test("first real day speech prefetch skips a p1 human and starts with an AI speaker", async () => {
  const introGate = createDeferred<void>();
  const introStarted = createDeferred<string>();
  const speakStarted = createDeferred<string>();
  const humanInput: HumanInputHandler = {
    async request(input) {
      if (input.kind === "speech_choice") {
        return { choiceId: input.options[0]?.id ?? "0" };
      }
      if (input.kind === "target") {
        return { targetId: input.candidates[0]?.id ?? null, reason: "Human vote." };
      }
      return { decision: false };
    }
  };
  const game = new WerewolfGame(
    { ...baseConfig, provider: "llm", model: "scripted", humanPlayerId: "p1", prefetchConcurrency: 5 },
    { humanInput }
  ) as OpeningTestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" }
  ]);
  game.agents.set(players[0].id, new HumanInputAgent(players[0].name, humanInput, "English"));
  players[0].model = "human";
  for (const player of players.slice(1)) {
    game.agents.set(
      player.id,
      new BlockingFaceoffAgent(
        player.name,
        Promise.resolve(),
        introGate.promise,
        () => undefined,
        (playerId) => introStarted.resolve(playerId),
        (playerId) => speakStarted.resolve(playerId)
      )
    );
  }

  const iterator = game.run();
  const firstEvent = await iterator.next();
  assert.equal(firstEvent.value?.type, "game_started");

  const dayStart = await iterator.next();
  assert.equal(dayStart.value?.type, "phase_changed");
  assert.equal(dayStart.value?.phase, "day_discussion");
  const introPlayerId = await Promise.race([introStarted.promise, sleepWithAbort(100).then(() => "timeout")]);
  assert.equal(introPlayerId, players[1].id, "the opening warm-up starts with the first AI speaker, not the p1 human");
  const earlySpeechPlayerId = await Promise.race([speakStarted.promise, sleepWithAbort(100).then(() => "timeout")]);
  assert.equal(earlySpeechPlayerId, "timeout", "the opening day prefetch must wait for warm-up generation");

  introGate.resolve();
  const startedPlayerId = await Promise.race([speakStarted.promise, sleepWithAbort(100).then(() => "timeout")]);
  assert.equal(startedPlayerId, players[1].id, "the opening day prefetch must use the first AI speaker, not the p1 human");
  await iterator.return?.(undefined);
});

test("day-1 warm-up finishes before the first real discussion speech generation", async () => {
  const introGate = createDeferred<void>();
  const speakStarted = createDeferred<string>();
  const game = new WerewolfGame({ ...baseConfig, provider: "llm", model: "scripted", prefetchConcurrency: 5 }) as OpeningTestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" }
  ]);
  game.round = 1;
  for (const player of players) {
    game.agents.set(
      player.id,
      new BlockingIntroAgent(player.name, introGate.promise, (playerId) => speakStarted.resolve(playerId))
    );
  }

  const iterator = game.runDay();
  const dayStart = await iterator.next();
  assert.equal(dayStart.value?.type, "phase_changed");

  const pendingWarmup = iterator.next();
  const earlySpeechPlayerId = await Promise.race([
    speakStarted.promise,
    sleepWithAbort(100).then(() => "timeout")
  ]);
  assert.equal(earlySpeechPlayerId, "timeout", "the first real day speech does not start before warm-up intros finish");

  introGate.resolve();
  const startedPlayerId = await Promise.race([
    speakStarted.promise,
    sleepWithAbort(100).then(() => "timeout")
  ]);
  assert.equal(startedPlayerId, players[0].id, "the first real day speech starts after warm-up intros finish");
  const warmup = await pendingWarmup;
  assert.equal(warmup.value?.data?.warmup, true);
  await iterator.return?.(undefined);
});

test("aborting during day-1 warm-up cancels intro prefetch and does not start first real day speech", async () => {
  const abortController = new AbortController();
  const introStarted = createDeferred<string>();
  const introAborted = createDeferred<string>();
  const speakStarted = createDeferred<string>();
  const game = new WerewolfGame(
    { ...baseConfig, provider: "llm", model: "scripted", prefetchConcurrency: 5 },
    { abortSignal: abortController.signal }
  ) as OpeningTestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" }
  ]);
  game.round = 1;
  for (const player of players) {
    game.agents.set(
      player.id,
      new AbortAwareBlockingIntroAgent(
        player.name,
        (playerId) => introStarted.resolve(playerId),
        (playerId) => introAborted.resolve(playerId),
        (playerId) => speakStarted.resolve(playerId)
      )
    );
  }

  const iterator = game.runDay();
  const dayStart = await iterator.next();
  assert.equal(dayStart.value?.type, "phase_changed");
  assert.equal(dayStart.value?.phase, "day_discussion");

  const pendingWarmup = iterator.next();
  const pendingWarmupError = pendingWarmup.catch((error: unknown) => error);
  const introPlayerId = await Promise.race([introStarted.promise, sleepWithAbort(100).then(() => "timeout")]);
  assert.notEqual(introPlayerId, "timeout", "warm-up prefetch starts an intro request");

  abortController.abort();
  const abortedPlayerId = await Promise.race([introAborted.promise, sleepWithAbort(100).then(() => "timeout")]);
  assert.notEqual(abortedPlayerId, "timeout", "the in-flight warm-up intro receives the abort signal");
  const speechPlayerId = await Promise.race([speakStarted.promise, sleepWithAbort(100).then(() => "timeout")]);
  assert.equal(speechPlayerId, "timeout", "the first real day speech prefetch is not started after aborting warm-up");

  const error = await pendingWarmupError;
  assert.ok(error instanceof Error);
  assert.match(error.message, /cancelled|aborted/i);
  await iterator.return?.(undefined);
});

test("returning after day start cancels the background warm-up prefetch", async () => {
  const introStarted = createDeferred<string>();
  const introAborted = createDeferred<string>();
  const speakStarted = createDeferred<string>();
  const game = new WerewolfGame({ ...baseConfig, provider: "llm", model: "scripted", prefetchConcurrency: 5 }) as OpeningTestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" }
  ]);
  game.round = 1;
  for (const player of players) {
    game.agents.set(
      player.id,
      new AbortAwareBlockingIntroAgent(
        player.name,
        (playerId) => introStarted.resolve(playerId),
        (playerId) => introAborted.resolve(playerId),
        (playerId) => speakStarted.resolve(playerId)
      )
    );
  }

  const iterator = game.runDay();
  const dayStart = await iterator.next();
  assert.equal(dayStart.value?.type, "phase_changed");
  assert.equal(dayStart.value?.phase, "day_discussion");
  const introPlayerId = await Promise.race([introStarted.promise, sleepWithAbort(100).then(() => "timeout")]);
  assert.notEqual(introPlayerId, "timeout", "warm-up prefetch starts before the day-start event is consumed");

  await iterator.return?.(undefined);
  const abortedPlayerId = await Promise.race([introAborted.promise, sleepWithAbort(100).then(() => "timeout")]);
  assert.notEqual(abortedPlayerId, "timeout", "returning the game stream aborts the detached warm-up prefetch");
  const speechPlayerId = await Promise.race([speakStarted.promise, sleepWithAbort(100).then(() => "timeout")]);
  assert.equal(speechPlayerId, "timeout", "the first real day speech prefetch is not started after returning the stream");
});

test("speech diagnostics record race loser aborts without changing race publishing", async () => {
  const diagnostics: SpeechGenerationDiagnostic[] = [];
  const game = new WerewolfGame(
    { ...baseConfig, prefetchConcurrency: 2 },
    { onSpeechDiagnostics: (diagnostic) => diagnostics.push(diagnostic) }
  ) as TestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  game.agents.set(players[0].id, new DelayedSpeechAgent(players[0].name, [1], () => "fast visible speech"));
  game.agents.set(players[1].id, new DelayedSpeechAgent(players[1].name, [60], () => "slow aborted speech"));

  const originalRandom = Math.random;
  Math.random = () => 0.999;
  const events = await collect(game.runDay()).finally(() => {
    Math.random = originalRandom;
  });
  const firstSpeech = events.find((event) => event.type === "player_speech" && event.data?.discussionPass === 1);
  const abortDiagnostic = diagnostics.find((diagnostic) => diagnostic.kind === "speech_race_losers_aborted");

  assert.equal(firstSpeech?.message, "fast visible speech");
  assert.ok(abortDiagnostic);
  assert.equal(abortDiagnostic.playerId, players[0].id);
  assert.ok(abortDiagnostic.abortedPlayerIds?.includes(players[1].id));
});

test("discarded speculative speech failures do not write player memories", async () => {
  const game = new WerewolfGame({ ...baseConfig, prefetchConcurrency: 2 }) as TestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  game.agents.set(players[0].id, new FailOnceSpeechAgent(players[0].name));
  for (const player of players.slice(1)) {
    game.agents.set(player.id, new DelayedSpeechAgent(player.name, [20], () => `${player.name} speaks after failure`));
  }

  await collect(game.runDay());

  assert.equal(players[0].memories.some((memory) => memory.includes("LLM error") || memory.includes("発言生成中")), false);
});

test("day discussion adds focused follow-up speakers after regular passes", async () => {
  const game = createGame();
  const players = setTable(game, [
    {
      role: "Villager",
      speeches: [
        {
          messages: ["Byron needs to answer this first."],
          metadata: {
            claims: [],
            suspects: [{ targetId: "p2", targetName: "Byron", reason: "unclear stance", weight: 0.8 }],
            trusts: []
          }
        }
      ]
    },
    { role: "Werewolf" },
    {
      role: "Seer",
      speeches: [
        {
          messages: ["Byron is still my main concern."],
          metadata: {
            claims: [],
            suspects: [{ targetId: "p2", targetName: "Byron", reason: "dodged pressure", weight: 0.7 }],
            trusts: []
          }
        }
      ]
    },
    {
      role: "Witch",
      speeches: [
        {
          messages: ["Edison also needs a final answer."],
          metadata: {
            claims: [],
            suspects: [{ targetId: "p5", targetName: "Edison", reason: "late shift", weight: 0.4 }],
            trusts: []
          }
        }
      ]
    },
    { role: "Villager" },
    { role: "Villager" }
  ]);

  const events = await collect(game.runDay());
  const followUpEvents = events.filter((event) => event.type === "player_speech" && event.data?.discussionPass === 3);

  assert.deepEqual(
    followUpEvents.map((event) => event.playerId),
    [players[1].id, players[4].id]
  );
  assert.ok(followUpEvents.every((event) => event.data?.discussionFollowUp === true));

  const pressuredAgent = game.agents.get(players[1].id) as ScriptedAgent;
  assert.equal(pressuredAgent.speechInputs.length, 3);
  assert.match(pressuredAgent.speechInputs[2].context, /これまでの会話/);
  assert.doesNotMatch(pressuredAgent.speechInputs[2].context, /Follow-up pass for selected speakers/);
});

test("human follow-up speaker is placed after AI follow-up speakers", async () => {
  const humanInput: HumanInputHandler = {
    async request(input) {
      if (input.kind === "speech_choice") {
        return { choiceId: input.options[0]?.id ?? "0" };
      }
      if (input.kind === "target") {
        return { targetId: input.candidates[0]?.id ?? null, reason: "Human vote." };
      }
      return { decision: false };
    }
  };
  const game = new WerewolfGame(
    {
      ...baseConfig,
      humanPlayerId: "p3",
      prefetchConcurrency: 1
    },
    { humanInput }
  ) as TestableGame;
  const players = setTable(game, [
    {
      role: "Villager",
      speeches: [
        {
          messages: ["Curie and Edison both need final answers."],
          metadata: {
            claims: [],
            suspects: [
              { targetId: "p3", targetName: "Curie", reason: "human pressure", weight: 0.9 },
              { targetId: "p5", targetName: "Edison", reason: "AI pressure", weight: 0.8 }
            ],
            trusts: []
          }
        }
      ]
    },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  game.agents.set(players[2].id, new HumanInputAgent(players[2].name, humanInput, "English"));
  players[2].model = "human";

  const events = await collect(game.runDay());
  const followUpEvents = events.filter((event) => event.type === "player_speech" && event.data?.discussionPass === 3);

  // The human's chosen speech may span multiple lines, so collapse consecutive
  // events from the same speaker before checking ordering (AI follow-up, then human).
  const followUpSpeakers = followUpEvents
    .map((event) => event.playerId)
    .filter((playerId, index, all) => index === 0 || all[index - 1] !== playerId);

  // The exact AI follow-up speaker depends on the demo agents' randomized reads, so assert the
  // ordering contract rather than a specific id: the human speaks last, after at least one AI.
  assert.ok(followUpSpeakers.length >= 2);
  assert.equal(followUpSpeakers[followUpSpeakers.length - 1], players[2].id);
  assert.ok(followUpSpeakers.slice(0, -1).every((playerId) => playerId !== players[2].id));
});

test("day discussion scales follow-up speaker count on large tables", async () => {
  const game = new WerewolfGame({ ...baseConfig, playerCount: maxSupportedPlayers }) as TestableGame;
  const players = setTable(game, [
    {
      role: "Villager",
      speeches: [
        {
          messages: ["Several players need final answers."],
          metadata: {
            claims: [],
            suspects: ["p2", "p3", "p4", "p5", "p6", "p7", "p8"].map((targetId) => ({
              targetId,
              targetName: targetId,
              reason: "needs follow-up",
              weight: 0.5
            })),
            trusts: []
          }
        }
      ]
    },
    ...Array.from({ length: maxSupportedPlayers - 1 }, () => ({ role: "Villager" as const }))
  ]);

  const events = await collect(game.runDay());
  const followUpEvents = events.filter((event) => event.type === "player_speech" && event.data?.discussionPass === 3);

  assert.deepEqual(
    followUpEvents.map((event) => event.playerId),
    players.slice(1, 6).map((player) => player.id)
  );
});

test("human participation still reports batched progress for AI day work", async () => {
  const progressEvents: GenerationProgress[] = [];
  const humanInput: HumanInputHandler = {
    async request(input) {
      if (input.kind === "speech_choice") {
        return { choiceId: input.options[0]?.id ?? "0" };
      }
      if (input.kind === "target") {
        return { targetId: input.candidates[0]?.id ?? null, reason: "Human player vote." };
      }
      return { decision: false };
    }
  };
  const game = new WerewolfGame(
    {
      ...baseConfig,
      playerCount: 6,
      humanPlayerId: "p3",
      prefetchConcurrency: 2
    },
    {
      humanInput,
      onProgress: (progress) => progressEvents.push(progress)
    }
  ) as TestableGame;

  const events = await collect(game.runDay());
  const speechEvents = events.filter((event) => event.type === "player_speech" && event.phase === "day_discussion");

  assert.ok(events.some((event) => event.type === "player_speech" && event.playerId === "p3"));
  assert.equal(speechEvents.filter((event) => event.data?.discussionPass === 1).at(-1)?.playerId, "p3");
  assert.equal(speechEvents.filter((event) => event.data?.discussionPass === 2).at(-1)?.playerId, "p3");
  assert.ok(progressEvents.some((progress) => progress.task === "day_speech"));
  assert.ok(progressEvents.some((progress) => progress.task === "day_vote"));
  assert.ok(progressEvents.every((progress) => progress.concurrency <= 2));
});

test("human day interrupt restarts the remaining AI race with the latest human speech", async () => {
  const requests: HumanInputRequestPayload[] = [];
  let optionalRequestCount = 0;
  const humanInput: HumanInputHandler = {
    async request(input) {
      if (input.kind === "target") {
        return { targetId: input.candidates[0]?.id ?? null, reason: "Human vote." };
      }
      if (input.kind === "speech_choice") {
        return { speech: "Fallback blocking speech." };
      }
      return { decision: false };
    },
    requestOptional(input, options) {
      requests.push(input);
      optionalRequestCount += 1;
      if (optionalRequestCount === 1) {
        return Promise.resolve({ speech: "ガクを疑っています。" });
      }
      options?.signal?.addEventListener("abort", () => undefined, { once: true });
      return Promise.resolve(null);
    }
  };
  const game = new WerewolfGame(
    {
      ...baseConfig,
      humanPlayerId: "p3",
      language: "Japanese",
      prefetchConcurrency: 1
    },
    { humanInput }
  ) as TestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" }
  ]);
  players[2].model = "human";
  game.agents.set(players[0].id, new ScriptedAgent(players[0].name));
  game.agents.set(
    players[1].id,
    new DelayedSpeechAgent(players[1].name, [30, 1], (input) =>
      input.context.includes("ガクを疑っています") ? "ガクの疑いに反応します。" : "人間発言を見ていません。"
    )
  );
  game.agents.set(players[3].id, new DelayedSpeechAgent(players[3].name, [1], () => "次のAI発言です。"));

  const events = await collect(game.runDay());
  const daySpeeches = events.filter((event) => event.type === "player_speech" && event.phase === "day_discussion");
  const humanSpeechIndex = daySpeeches.findIndex((event) => event.playerId === players[2].id);

  assert.ok(requests.length > 0);
  assert.ok(requests.every((request) => request.kind === "speech_choice" && request.speechMode === "discussion_interrupt"));
  assert.ok(requests.every((request) => request.kind !== "speech_choice" || (request.nonBlocking === true && request.options.length === 0)));
  assert.ok(humanSpeechIndex > 0, "the interrupt becomes available only after an AI speech");
  assert.equal(daySpeeches[humanSpeechIndex]?.message, "ガクを疑っています");
  assert.ok(daySpeeches.some((event) => event.message === "ガクの疑いに反応します。"));
});

test("optional human day interrupt stays open while the next AI speech race continues", async () => {
  let optionalRequestCount = 0;
  let cancelledOptionalRequestCount = 0;
  let cancelledBeforeIteratorReturn = 0;
  const humanInput: HumanInputHandler = {
    async request(input) {
      if (input.kind === "target") {
        return { targetId: input.candidates[0]?.id ?? null, reason: "Human vote." };
      }
      if (input.kind === "speech_choice") {
        return { speech: "Fallback blocking speech." };
      }
      return { decision: false };
    },
    requestOptional(_input, options) {
      optionalRequestCount += 1;
      return new Promise<null>((resolve) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            cancelledOptionalRequestCount += 1;
            resolve(null);
          },
          { once: true }
        );
      });
    }
  };
  const game = new WerewolfGame(
    {
      ...baseConfig,
      humanPlayerId: "p3",
      prefetchConcurrency: 1
    },
    { humanInput }
  ) as TestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" }
  ]);
  players[2].model = "human";
  game.agents.set(players[0].id, new DelayedSpeechAgent(players[0].name, [1], () => "最初のAI発言です。"));
  game.agents.set(players[1].id, new DelayedSpeechAgent(players[1].name, [1], () => "次のAI発言です。"));
  game.agents.set(players[3].id, new DelayedSpeechAgent(players[3].name, [1], () => "三人目のAI発言です。"));

  const iterator = game.runDay();
  const daySpeeches: GameEvent[] = [];
  try {
    while (daySpeeches.length < 2) {
      const next = await Promise.race([
        iterator.next(),
        sleepWithAbort(500).then<IteratorResult<GameEvent>>(() => {
          throw new Error("Timed out waiting for AI speech while optional human interrupt was pending.");
        })
      ]);
      if (next.done) {
        break;
      }
      if (next.value.type === "player_speech" && next.value.phase === "day_discussion" && next.value.playerId !== players[2].id) {
        daySpeeches.push(next.value);
      }
    }
    cancelledBeforeIteratorReturn = cancelledOptionalRequestCount;
  } finally {
    await iterator.return?.(undefined);
  }

  assert.equal(daySpeeches.length, 2);
  assert.ok(optionalRequestCount > 0, "the optional interrupt request should open after the first AI speech");
  assert.equal(cancelledBeforeIteratorReturn, 0, "the optional interrupt must stay open when the next AI speech wins");
  assert.ok(cancelledOptionalRequestCount > 0, "closing the iterator should still clean up the open optional request");
  assert.equal(daySpeeches[1]?.message, "次のAI発言です。");
});

test("delayed human day interrupt keeps read AI context and regenerates unread remaining AI", async () => {
  const optionalRequest = createDeferred<HumanInputRequestPayload>();
  const optionalResponse = createDeferred<{ speech: string; visibleEventId: number | null }>();
  let optionalRequestCount = 0;
  const humanInput: HumanInputHandler = {
    async request(input) {
      if (input.kind === "target") {
        return { targetId: input.candidates[0]?.id ?? null, reason: "Human vote." };
      }
      if (input.kind === "speech_choice") {
        return { speech: "Fallback blocking speech." };
      }
      return { decision: false };
    },
    requestOptional(input) {
      optionalRequestCount += 1;
      if (optionalRequestCount === 1) {
        optionalRequest.resolve(input);
        return optionalResponse.promise;
      }
      return Promise.resolve(null);
    }
  };
  const game = new WerewolfGame(
    {
      ...baseConfig,
      humanPlayerId: "p3",
      language: "Japanese",
      prefetchConcurrency: 1
    },
    { humanInput }
  ) as TestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" }
  ]);
  players[2].model = "human";
  game.agents.set(players[0].id, new DelayedSpeechAgent(players[0].name, [1], () => "最初のAI発言です。"));
  game.agents.set(players[1].id, new DelayedSpeechAgent(players[1].name, [1], () => "読んだAI発言です。"));
  const regeneratedAgent = new DelayedSpeechAgent(players[3].name, [60, 1], (input) =>
    input.context.includes("人間の割り込みです") && input.context.includes("読んだAI発言です")
      ? "人間発言と既読AI発言を踏まえます。"
      : "古い未読生成です。"
  );
  game.agents.set(players[3].id, regeneratedAgent);

  const iterator = game.runDay();
  const events: GameEvent[] = [];
  const aiSpeeches: GameEvent[] = [];
  while (aiSpeeches.length < 2) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    events.push(next.value);
    if (next.value.type === "player_speech" && next.value.phase === "day_discussion" && next.value.playerId !== players[2].id) {
      aiSpeeches.push(next.value);
    }
  }

  await optionalRequest.promise;
  const pendingHuman = iterator.next();
  optionalResponse.resolve({ speech: "人間の割り込みです。", visibleEventId: aiSpeeches[1].id });
  const humanSpeech = await pendingHuman;
  assert.equal(humanSpeech.value?.type, "player_speech");
  assert.equal(humanSpeech.value?.playerId, players[2].id);

  const rest = await collect(iterator);
  const allEvents = [...events, humanSpeech.value, ...rest].filter((event): event is GameEvent => Boolean(event));
  const daySpeeches = allEvents.filter((event) => event.type === "player_speech" && event.phase === "day_discussion");
  const humanIndex = daySpeeches.findIndex((event) => event.playerId === players[2].id);
  const postHumanSpeech = daySpeeches.find(
    (event, index) => index > humanIndex && event.playerId === players[3].id
  );

  assert.ok(humanIndex > 0, "the human interrupt is emitted after visible AI context");
  assert.equal(daySpeeches[humanIndex - 1]?.message, "読んだAI発言です。", "the AI speech the player already saw remains before the human");
  assert.equal(postHumanSpeech?.message, "人間発言と既読AI発言を踏まえます。");
  assert.doesNotMatch(regeneratedAgent.speechInputs[0]?.context ?? "", /人間の割り込みです/);
  assert.match(regeneratedAgent.speechInputs[1]?.context ?? "", /人間の割り込みです/);
  assert.match(regeneratedAgent.speechInputs[1]?.context ?? "", /読んだAI発言です/);
});

test("human day interrupt rollback restores werewolf deception state", async () => {
  const optionalRequest = createDeferred<HumanInputRequestPayload>();
  const optionalResponse = createDeferred<{ speech: string; visibleEventId: number | null }>();
  let optionalRequestCount = 0;
  const humanInput: HumanInputHandler = {
    async request(input) {
      if (input.kind === "target") {
        return { targetId: input.candidates[0]?.id ?? null, reason: "Human vote." };
      }
      if (input.kind === "speech_choice") {
        return { speech: "Fallback blocking speech." };
      }
      return { decision: false };
    },
    requestOptional(input) {
      optionalRequestCount += 1;
      if (optionalRequestCount === 1) {
        optionalRequest.resolve(input);
        return optionalResponse.promise;
      }
      return Promise.resolve(null);
    }
  };
  const game = new WerewolfGame(
    {
      ...baseConfig,
      humanPlayerId: "p3",
      language: "Japanese",
      prefetchConcurrency: 1
    },
    { humanInput }
  ) as TestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  players[2].model = "human";
  game.agents.set(players[0].id, new DelayedSpeechAgent(players[0].name, [1], () => "最初のAI発言です。"));
  game.agents.set(
    players[1].id,
    new DelayedSpeechAgent(players[1].name, [1], () => `私は占い師です。${players[3].name}は狼陣営判定です`)
  );
  game.agents.set(players[3].id, new DelayedSpeechAgent(players[3].name, [60, 1], () => "残りのAI発言です。"));

  const iterator = game.runDay();
  const events: GameEvent[] = [];
  const aiSpeeches: GameEvent[] = [];
  while (aiSpeeches.length < 2) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    events.push(next.value);
    if (next.value.type === "player_speech" && next.value.phase === "day_discussion" && next.value.playerId !== players[2].id) {
      aiSpeeches.push(next.value);
    }
  }

  assert.equal(aiSpeeches[1]?.playerId, players[1].id);
  const deceptionsBeforeRollback = (game as unknown as { werewolfDeceptions: Map<string, { publiclyClaimed?: boolean }> }).werewolfDeceptions;
  assert.equal(deceptionsBeforeRollback.get(players[1].id)?.publiclyClaimed, true);

  await optionalRequest.promise;
  const pendingHuman = iterator.next();
  optionalResponse.resolve({ speech: "人間の割り込みです。", visibleEventId: aiSpeeches[0].id });
  const humanSpeech = await pendingHuman;

  assert.equal(humanSpeech.value?.type, "player_speech");
  assert.equal(humanSpeech.value?.playerId, players[2].id);
  const deceptionsAfterRollback = (game as unknown as { werewolfDeceptions: Map<string, { publiclyClaimed?: boolean }> }).werewolfDeceptions;
  assert.equal(deceptionsAfterRollback.has(players[1].id), false);

  await collect(iterator);
});

test("human day interrupt rollback restores true Seer disclosure state", async () => {
  const optionalRequest = createDeferred<HumanInputRequestPayload>();
  const optionalResponse = createDeferred<{ speech: string; visibleEventId: number | null }>();
  let optionalRequestCount = 0;
  const humanInput: HumanInputHandler = {
    async request(input) {
      if (input.kind === "target") {
        return { targetId: input.candidates[0]?.id ?? null, reason: "Human vote." };
      }
      if (input.kind === "speech_choice") {
        return { speech: "Fallback blocking speech." };
      }
      return { decision: false };
    },
    requestOptional(input) {
      optionalRequestCount += 1;
      if (optionalRequestCount === 1) {
        optionalRequest.resolve(input);
        return optionalResponse.promise;
      }
      return Promise.resolve(null);
    }
  };
  const game = new WerewolfGame(
    {
      ...baseConfig,
      humanPlayerId: "p3",
      language: "Japanese",
      prefetchConcurrency: 1
    },
    { humanInput }
  ) as TestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Seer" },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  players[2].model = "human";
  players[1].seerResults = { p4: "village" };
  players[1].seerResultRounds = { p4: 1 };
  game.agents.set(players[0].id, new DelayedSpeechAgent(players[0].name, [1], () => "最初のAI発言です。"));
  game.agents.set(
    players[1].id,
    new DelayedSpeechAgent(players[1].name, [1], () => `ここで占い師を名乗ります。${players[3].name}は人間側判定です`)
  );
  game.agents.set(players[3].id, new DelayedSpeechAgent(players[3].name, [60, 1], () => "残りのAI発言です。"));

  const iterator = game.runDay();
  const events: GameEvent[] = [];
  const aiSpeeches: GameEvent[] = [];
  while (aiSpeeches.length < 2) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    events.push(next.value);
    if (next.value.type === "player_speech" && next.value.phase === "day_discussion" && next.value.playerId !== players[2].id) {
      aiSpeeches.push(next.value);
    }
  }

  assert.equal(aiSpeeches[1]?.playerId, players[1].id);
  const disclosuresBeforeRollback = (game as unknown as { seerDisclosures: Map<string, { publiclyClaimed?: boolean }> }).seerDisclosures;
  assert.equal(disclosuresBeforeRollback.get(players[1].id)?.publiclyClaimed, true);

  await optionalRequest.promise;
  const pendingHuman = iterator.next();
  optionalResponse.resolve({ speech: "人間の割り込みです。", visibleEventId: aiSpeeches[0].id });
  const humanSpeech = await pendingHuman;

  assert.equal(humanSpeech.value?.type, "player_speech");
  assert.equal(humanSpeech.value?.playerId, players[2].id);
  const disclosuresAfterRollback = (game as unknown as { seerDisclosures: Map<string, { publiclyClaimed?: boolean }> }).seerDisclosures;
  assert.equal(disclosuresAfterRollback.has(players[1].id), false);

  await collect(iterator);
});

test("human speech choice can publish free text instead of a drafted option", async () => {
  const requests: HumanInputRequestPayload[] = [];
  const humanInput: HumanInputHandler = {
    async request(input) {
      requests.push(input);
      if (input.kind === "speech_choice") {
        return { speech: "  自分の言葉で話します。  " };
      }
      if (input.kind === "target") {
        return { targetId: input.candidates[0]?.id ?? null, reason: "人間プレイヤーの投票です。" };
      }
      return { decision: false };
    }
  };
  const game = new WerewolfGame({ ...baseConfig, humanPlayerId: "p3", language: "Japanese" }, { humanInput }) as TestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  game.agents.set(players[2].id, new HumanInputAgent(players[2].name, humanInput, "Japanese"));
  players[2].model = "human";

  const events = await collect(game.runDay());
  const humanSpeechEvents = events.filter((event) => event.type === "player_speech" && event.playerId === players[2].id);
  const roleSetupPattern = /配役表: .*人狼1人.*占い師1人.*魔女1人.*人間3人/;

  assert.ok(requests.some((request) => request.kind === "speech_choice" && request.options.length > 0));
  assert.ok(
    requests
      .filter((request) => request.kind === "speech_choice" && request.phase === "day_discussion")
      .every((request) => request.options.length <= 2),
    "human speech candidate lists are capped at two options"
  );
  assert.ok(
    requests.some(
      (request) => request.kind === "speech_choice" && request.context.notes.some((line) => roleSetupPattern.test(line))
    )
  );
  assert.ok(
    requests.some((request) => request.kind === "target" && request.context.notes.some((line) => roleSetupPattern.test(line)))
  );
  assert.ok(humanSpeechEvents.some((event) => event.message === "自分の言葉で話します"));
});

test("human free text reads influence later discussion and voting context", async () => {
  let players: Player[] = [];
  const humanInput: HumanInputHandler = {
    async request(input) {
      if (input.kind === "speech_choice") {
        return { speech: `${players[1].name} is suspicious. ${players[3].name} seems trustworthy.` };
      }
      if (input.kind === "target") {
        return { targetId: input.candidates[0]?.id ?? null, reason: "Human player vote." };
      }
      return { decision: false };
    }
  };
  const game = new WerewolfGame({ ...baseConfig, humanPlayerId: "p3", prefetchConcurrency: 1 }, { humanInput }) as TestableGame;
  players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  game.agents.set(players[2].id, new HumanInputAgent(players[2].name, humanInput, "English"));
  players[2].model = "human";
  (game as unknown as { round: number }).round = 1;

  const events = await collect(game.runDay());
  const humanSpeech = events.find((event) => event.type === "player_speech" && event.playerId === players[2].id);
  const laterSpeaker = game.agents.get(players[3].id) as ScriptedAgent;
  const laterSpeechContext = laterSpeaker.speechInputs.find(
    (input) => input.phase === "day_discussion" && input.context.includes("人間プレイヤーの発言影響 - ")
  )?.context;
  const laterVoteContext = laterSpeaker.targetInputs.find(
    (input) => input.phase === "voting" && input.context.includes("人間プレイヤーの発言影響 - ")
  )?.context;

  assert.deepEqual((humanSpeech?.data?.suspects as Array<{ targetId: string; weight: number }> | undefined)?.map((read) => read.targetId), [
    players[1].id
  ]);
  assert.deepEqual((humanSpeech?.data?.trusts as Array<{ targetId: string; weight: number }> | undefined)?.map((read) => read.targetId), [
    players[3].id
  ]);
  assert.ok((humanSpeech?.data?.suspects as Array<{ weight: number }> | undefined)?.every((read) => read.weight >= 0.9));
  assert.ok(laterSpeechContext?.includes(players[1].name));
  assert.ok(laterSpeechContext?.includes(players[3].name));
  assert.ok(laterVoteContext?.includes(players[1].name));
  assert.ok(laterVoteContext?.includes("信用が高い位置"));
});

test("human free text reads reserve an agreeing AI follow-up speaker", async () => {
  let players: Player[] = [];
  const humanInput: HumanInputHandler = {
    async request(input) {
      if (input.kind === "speech_choice") {
        return { speech: `${players[1].name} is suspicious.` };
      }
      if (input.kind === "target") {
        return { targetId: input.candidates[0]?.id ?? null, reason: "Human player vote." };
      }
      return { decision: false };
    }
  };
  const game = new WerewolfGame({ ...baseConfig, humanPlayerId: "p3", prefetchConcurrency: 1 }, { humanInput }) as TestableGame;
  players = setTable(game, [
    {
      role: "Villager",
      speeches: [
        {
          messages: ["I trust Curie and Byron is already my concern."],
          metadata: {
            claims: [],
            suspects: [{ targetId: "p2", targetName: "Byron", reason: "unclear stance", weight: 0.6 }],
            trusts: [{ targetId: "p3", targetName: "Curie", reason: "credible pressure", weight: 0.7 }]
          }
        }
      ]
    },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  game.agents.set(players[2].id, new HumanInputAgent(players[2].name, humanInput, "English"));
  players[2].model = "human";

  const events = await collect(game.runDay());
  const followUpSpeakers = events
    .filter((event) => event.type === "player_speech" && event.data?.discussionPass === 3)
    .map((event) => event.playerId)
    .filter((playerId, index, all) => index === 0 || all[index - 1] !== playerId);
  const agreeingAgent = game.agents.get(players[0].id) as ScriptedAgent;

  assert.deepEqual(followUpSpeakers.slice(0, 2), [players[1].id, players[0].id]);
  assert.equal(agreeingAgent.speechInputs.length, 3);
  assert.match(agreeingAgent.speechInputs[2].context, /人間プレイヤーの発言影響 - (採用|弱採用|保留|反論余地)/);
});

test("human Japanese free text keeps negated trust and vote mentions in the right direction", async () => {
  let players: Player[] = [];
  const humanInput: HumanInputHandler = {
    async request(input) {
      if (input.kind === "speech_choice") {
        return {
          speech: `${players[1].name}は信じない。${players[3].name}には投票しない。${players[4].name}の投票理由は良い。`
        };
      }
      if (input.kind === "target") {
        return { targetId: input.candidates[0]?.id ?? null, reason: "人間プレイヤーの投票です。" };
      }
      return { decision: false };
    }
  };
  const game = new WerewolfGame({ ...baseConfig, humanPlayerId: "p3", language: "Japanese" }, { humanInput }) as TestableGame;
  players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  game.agents.set(players[2].id, new HumanInputAgent(players[2].name, humanInput, "Japanese"));
  players[2].model = "human";

  const events = await collect(game.runDay());
  const humanSpeech = events.find((event) => event.type === "player_speech" && event.playerId === players[2].id);
  const suspects = (humanSpeech?.data?.suspects as Array<{ targetId: string }> | undefined) ?? [];
  const trusts = (humanSpeech?.data?.trusts as Array<{ targetId: string }> | undefined) ?? [];

  assert.deepEqual(
    suspects.map((read) => read.targetId),
    [players[1].id]
  );
  assert.ok(!suspects.some((read) => read.targetId === players[3].id || read.targetId === players[4].id));
  assert.ok(!trusts.some((read) => read.targetId === players[3].id));
});

test("human English free text keeps negated trust and vote mentions in the right direction", async () => {
  let players: Player[] = [];
  const humanInput: HumanInputHandler = {
    async request(input) {
      if (input.kind === "speech_choice") {
        return { speech: `I do not trust ${players[1].name}. I will not vote for ${players[3].name}. ${players[4].name} is not suspicious.` };
      }
      if (input.kind === "target") {
        return { targetId: input.candidates[0]?.id ?? null, reason: "Human player vote." };
      }
      return { decision: false };
    }
  };
  const game = new WerewolfGame({ ...baseConfig, humanPlayerId: "p3" }, { humanInput }) as TestableGame;
  players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  game.agents.set(players[2].id, new HumanInputAgent(players[2].name, humanInput, "English"));
  players[2].model = "human";

  const events = await collect(game.runDay());
  const humanSpeech = events.find((event) => event.type === "player_speech" && event.playerId === players[2].id);
  const suspects = (humanSpeech?.data?.suspects as Array<{ targetId: string }> | undefined) ?? [];
  const trusts = (humanSpeech?.data?.trusts as Array<{ targetId: string }> | undefined) ?? [];

  assert.deepEqual(
    suspects.map((read) => read.targetId),
    [players[1].id]
  );
  assert.ok(!suspects.some((read) => read.targetId === players[3].id));
  assert.ok(trusts.some((read) => read.targetId === players[4].id));
  assert.ok(!trusts.some((read) => read.targetId === players[3].id));
});

test("human speech input requests carry the prior emitted event as their reveal anchor", async () => {
  const requests: HumanInputRequestPayload[] = [];
  const humanInput: HumanInputHandler = {
    async request(input) {
      requests.push(input);
      if (input.kind === "speech_choice") {
        return { choiceId: input.options[0]?.id ?? "0" };
      }
      if (input.kind === "target") {
        return { targetId: input.candidates[0]?.id ?? null, reason: "Human player vote." };
      }
      return { decision: false };
    }
  };
  const game = new WerewolfGame({ ...baseConfig, humanPlayerId: "p3" }, { humanInput }) as TestableGame;

  const events = await collect(game.runDay());
  const speechRequests = requests.filter((request) => request.kind === "speech_choice" && request.phase === "day_discussion");
  let searchStart = 0;

  assert.ok(speechRequests.length > 0);
  for (const request of speechRequests) {
    const speechIndex = events.findIndex(
      (event, index) =>
        index >= searchStart && event.type === "player_speech" && event.phase === "day_discussion" && event.playerId === "p3"
    );
    assert.ok(speechIndex > 0, "human speech should be emitted after a prior visible event");
    assert.equal(request.revealAfterEventId, events[speechIndex - 1].id);
    searchStart = speechIndex + 1;
    while (
      events[searchStart]?.type === "player_speech" &&
      events[searchStart]?.phase === "day_discussion" &&
      events[searchStart]?.playerId === "p3"
    ) {
      searchStart += 1;
    }
  }
});

test("human werewolf first-day opening can use free text", async () => {
  const requests: HumanInputRequestPayload[] = [];
  const humanInput: HumanInputHandler = {
    async request(input) {
      requests.push(input);
      if (input.kind === "speech_choice") {
        return { speech: "  今日は普通に様子見します。  " };
      }
      if (input.kind === "target") {
        return { targetId: input.candidates[0]?.id ?? null, reason: "人間プレイヤーの投票です。" };
      }
      return { decision: false };
    }
  };
  const game = new WerewolfGame({ ...baseConfig, humanPlayerId: "p1", language: "Japanese" }, { humanInput }) as TestableGame;
  (game as OpeningTestableGame).round = 1;
  const players = setTable(game, [
    { role: "Werewolf" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  game.agents.set(players[0].id, new HumanInputAgent(players[0].name, humanInput, "Japanese"));
  players[0].model = "human";

  const events = await collect(game.runDay());
  const firstHumanSpeech = events.find(
    (event) =>
      event.type === "player_speech" &&
      event.playerId === players[0].id &&
      event.phase === "day_discussion" &&
      event.data?.discussionPass === 1
  );
  const firstSpeechRequest = requests.find((request) => request.kind === "speech_choice" && request.phase === "day_discussion");

  assert.ok(firstSpeechRequest && firstSpeechRequest.kind === "speech_choice");
  assert.equal(firstSpeechRequest.allowFreeText, true);
  assert.ok(firstSpeechRequest.options.length <= 2);
  assert.ok(firstHumanSpeech);
  assert.equal(firstHumanSpeech.message, "今日は普通に様子見します");
});

test("human Lover receives partner info in private input context", async () => {
  const requests: HumanInputRequestPayload[] = [];
  const humanInput: HumanInputHandler = {
    async request(input) {
      requests.push(input);
      if (input.kind === "speech_choice") {
        return { choiceId: input.options[0]?.id ?? "0" };
      }
      if (input.kind === "target") {
        return { targetId: input.candidates[0]?.id ?? null, reason: "人間プレイヤーの投票です。" };
      }
      return { decision: false };
    }
  };
  const game = new WerewolfGame({ ...baseConfig, humanPlayerId: "p4", language: "Japanese" }, { humanInput }) as TestableGame;
  const players = setTable(game, [
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Lover" },
    { role: "Lover" },
    { role: "Villager" }
  ]);
  game.agents.set(players[3].id, new HumanInputAgent(players[3].name, humanInput, "Japanese"));
  players[3].model = "human";

  const events = await collect(game.runDay());

  const speechRequest = requests.find((request) => request.kind === "speech_choice");
  assert.ok(speechRequest);
  assert.ok(speechRequest.context.privateHistory.some((line) => line.includes(`恋人の相方は${players[4].name}`)));
  // The human picks an LLM-drafted candidate, so just confirm their chosen line is published.
  assert.ok(events.some((event) => event.type === "player_speech" && event.playerId === players[3].id));
});

test("progress observer failures do not abort game generation", async () => {
  const game = new WerewolfGame(
    {
      ...baseConfig,
      playerCount: 6,
      prefetchConcurrency: 2
    },
    {
      onProgress: () => {
        throw new Error("progress observer failed");
      }
    }
  ) as TestableGame;

  const events = await collect(game.runDay());

  assert.ok(events.some((event) => event.type === "player_speech"));
  const summary = await game.emitRoundSummary();
  assert.ok(summary);
});

test("round summary counts repeated reads from the same speaker once", async () => {
  const game = createGame();
  const players = setTable(game, [
    {
      role: "Villager",
      targets: ["p2"],
      speeches: [
        {
          messages: ["Byron needs pressure."],
          metadata: {
            claims: [],
            suspects: [{ targetId: "p2", targetName: "Byron", reason: "first pass reason", weight: 0.5 }],
            trusts: []
          }
        },
        {
          messages: ["Byron still needs pressure."],
          metadata: {
            claims: [],
            suspects: [{ targetId: "p2", targetName: "Byron", reason: "second pass reason", weight: 0.7 }],
            trusts: []
          }
        }
      ]
    },
    { role: "Werewolf", targets: ["p1"] },
    { role: "Seer", targets: ["p1"] },
    { role: "Witch", targets: ["p1"] },
    { role: "Villager", targets: ["p1"] },
    { role: "Villager", targets: ["p1"] }
  ]);

  await collect(game.runDay());
  const summary = await game.emitRoundSummary();
  const suspects = summary?.data?.suspects as Array<{ sourceId: string; targetId: string; reason?: string }> | undefined;

  assert.deepEqual(suspects, [{ sourceId: players[0].id, sourceName: players[0].name, targetId: "p2", targetName: "Byron", reason: "second pass reason", weight: 0.7 }]);
  assert.match(summary?.message ?? "", /Reads: suspects Byron; trusts none/);
  assert.doesNotMatch(summary?.message ?? "", /Byron x2/);
});

test("day speech metadata ignores dead read targets", async () => {
  const game = createGame();
  const players = setTable(game, [
    {
      role: "Villager",
      speeches: [
        {
          messages: ["I am comparing yesterday's death with today's answers."],
          metadata: {
            claims: [],
            suspects: [
              { targetId: "p2", targetName: "Byron", reason: "already dead", weight: 0.9 },
              { targetId: "p3", targetName: "Curie", reason: "answer is evasive", weight: 0.6 }
            ],
            trusts: [
              { targetId: "p2", targetName: "Byron", reason: "already dead", weight: 0.4 },
              { targetId: "p4", targetName: "Darwin", reason: "clear timeline", weight: 0.5 }
            ]
          }
        }
      ]
    },
    { role: "Villager", alive: false },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Witch" }
  ]);

  const events = await collect(game.runDay());
  const speechEvent = events.find((event) => event.type === "player_speech" && event.playerId === players[0].id);
  const suspects = speechEvent?.data?.suspects as Array<{ targetId: string }> | undefined;
  const trusts = speechEvent?.data?.trusts as Array<{ targetId: string }> | undefined;

  assert.deepEqual(suspects?.map((read) => read.targetId), ["p3"]);
  assert.deepEqual(trusts?.map((read) => read.targetId), ["p4"]);
});

test("round summary carries claims, reads, and votes in deterministic data", async () => {
  const game = createGame();
  setTable(game, [
    { role: "Werewolf", targets: ["p4"] },
    {
      role: "Seer",
      targets: ["p4"],
      speeches: [
        {
          messages: ["I claim Seer with a wolf result."],
          metadata: {
            claims: [
              {
                type: "role_claim",
                role: "Seer",
                result: { targetId: "p1", targetName: "Ada", camp: "werewolf", round: 1 }
              }
            ],
            suspects: [{ targetId: "p1", targetName: "Ada", reason: "wolf result", weight: 0.9 }],
            trusts: [{ targetId: "p3", targetName: "Curie", reason: "consistent pressure", weight: 0.6 }]
          }
        }
      ]
    },
    { role: "Witch", targets: ["p4"] },
    { role: "Villager", targets: ["p1"] },
    { role: "Villager", targets: ["p1"] },
    { role: "Villager", targets: ["p2"] }
  ]);

  await collect(game.runDay());
  const summary = await game.emitRoundSummary();

  assert.ok(summary);
  assert.match(summary.message, /Claims:/);
  assert.match(summary.message, /Reads:/);
  assert.match(summary.message, /Votes:/);
  const data = summary.data ?? {};
  assert.ok(Array.isArray(data.claims));
  assert.ok(Array.isArray(data.suspects));
  assert.ok(Array.isArray(data.trusts));
  assert.ok(Array.isArray(data.votes));
  assert.ok((data.claims as unknown[]).length > 0);
  assert.ok((data.suspects as unknown[]).length > 0);
  assert.ok((data.trusts as unknown[]).length > 0);
  assert.ok((data.votes as unknown[]).length > 0);
  assert.ok((data.votes as Array<Record<string, unknown>>).every((vote) => vote.reason === undefined));
});

test("LLM summary mode falls back to deterministic summary without an API key", async () => {
  const originalZaiApiKey = process.env.ZAI_API_KEY;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  delete process.env.ZAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    const game = new WerewolfGame({
      ...baseConfig,
      provider: "llm",
      model: "test-model",
      summaryMode: "llm"
    }) as TestableGame;
    setTable(game, [
      { role: "Werewolf", targets: ["p4"] },
      { role: "Seer", targets: ["p4"] },
      { role: "Witch", targets: ["p4"] },
      { role: "Villager", targets: ["p1"] },
      { role: "Villager", targets: ["p1"] },
      { role: "Villager", targets: ["p2"] }
    ]);

    await collect(game.runVoting());
    const summary = await game.emitRoundSummary();

    assert.ok(summary);
    assert.match(summary.message, /Votes:/);
    assert.equal(summary.data?.summaryMode, "llm");
    assert.equal(summary.data?.summarySource, "deterministic");
    assert.equal(summary.data?.summaryFallbackReason, "missing_api_key");
    assert.equal(summary.data?.deterministicMessage, summary.message);
  } finally {
    restoreEnvVar("ZAI_API_KEY", originalZaiApiKey);
    restoreEnvVar("OPENAI_API_KEY", originalOpenAiApiKey);
  }
});

test("LLM summary request failure keeps deterministic summary data intact", async () => {
  const originalZaiApiKey = process.env.ZAI_API_KEY;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.ZAI_API_KEY = "test-key";
  delete process.env.OPENAI_API_KEY;

  globalThis.fetch = (async () => {
    return new Response("bad gateway", { status: 502 });
  }) as typeof fetch;

  try {
    const game = new WerewolfGame({
      ...baseConfig,
      provider: "llm",
      model: "test-model",
      summaryMode: "llm"
    }) as TestableGame;
    setTable(game, [
      { role: "Werewolf", targets: ["p4"] },
      { role: "Seer", targets: ["p4"] },
      { role: "Witch", targets: ["p4"] },
      { role: "Villager", targets: ["p1"] },
      { role: "Villager", targets: ["p1"] },
      { role: "Villager", targets: ["p2"] }
    ]);

    await collect(game.runVoting());
    const summary = await game.emitRoundSummary();

    assert.ok(summary);
    assert.match(summary.message, /Votes:/);
    assert.equal(summary.data?.summarySource, "deterministic");
    assert.equal(summary.data?.summaryFallbackReason, "llm_error");
    assert.match(String(summary.data?.summaryError), /502/);
    assert.equal(summary.data?.deterministicMessage, summary.message);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvVar("ZAI_API_KEY", originalZaiApiKey);
    restoreEnvVar("OPENAI_API_KEY", originalOpenAiApiKey);
  }
});

test("LLM summary mode uses a short provider summary when available", async () => {
  const originalZaiApiKey = process.env.ZAI_API_KEY;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  process.env.ZAI_API_KEY = "test-key";
  delete process.env.OPENAI_API_KEY;

  globalThis.fetch = (async (_url, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.temperature, 0.35);
    assert.equal(body.model, "test-model");
    assert.equal(body.max_tokens, 512);
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.match(body.system, /観戦者向けの自然な日本語/);
    assert.match(body.system, /返答言語: 日本語/);
    assert.equal(body.messages[0].role, "user");
    assert.match(String(body.messages[0].content), /構造化された公開ラウンドデータ/);
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: JSON.stringify({ summary: "公開推理を受けて、投票はDarwinに集まりました。" }) }]
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  }) as typeof fetch;

  try {
    const game = new WerewolfGame({
      ...baseConfig,
      provider: "llm",
      model: "test-model",
      language: "Japanese",
      summaryMode: "llm"
    }) as TestableGame;
    setTable(game, [
      { role: "Werewolf", targets: ["p4"] },
      { role: "Seer", targets: ["p4"] },
      { role: "Witch", targets: ["p4"] },
      { role: "Villager", targets: ["p1"] },
      { role: "Villager", targets: ["p1"] },
      { role: "Villager", targets: ["p2"] }
    ]);

    await collect(game.runVoting());
    const summary = await game.emitRoundSummary();

    assert.ok(summary);
    assert.equal(summary.message, "公開推理を受けて、投票はDarwinに集まりました。");
    assert.equal(summary.data?.summarySource, "llm");
    assert.match(String(summary.data?.deterministicMessage), /投票:/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvVar("ZAI_API_KEY", originalZaiApiKey);
    restoreEnvVar("OPENAI_API_KEY", originalOpenAiApiKey);
  }
});

test("LLM summary prompt switches to Japanese spectator style", async () => {
  const originalZaiApiKey = process.env.ZAI_API_KEY;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.ZAI_API_KEY = "test-key";
  delete process.env.OPENAI_API_KEY;

  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.match(body.system, /観戦者向けの自然な日本語/);
    assert.match(body.system, /返答言語: 日本語/);
    assert.equal(body.messages[0].role, "user");
    assert.match(String(body.messages[0].content), /ラウンド: 1/);
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: JSON.stringify({ summary: "投票はDarwinに集まり、公開推理が焦点になっています。" }) }]
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  }) as typeof fetch;

  try {
    const summary = await summarizeRoundWithLlm({
      deterministicMessage: "Votes: Darwin 3.",
      round: 1,
      model: "test-model",
      language: "Japanese",
      data: {
        votes: [],
        totals: [{ targetName: "Darwin", count: 3 }]
      }
    });

    assert.equal(summary, "投票はDarwinに集まり、公開推理が焦点になっています。");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvVar("ZAI_API_KEY", originalZaiApiKey);
    restoreEnvVar("OPENAI_API_KEY", originalOpenAiApiKey);
  }
});

test("seer records a private camp result for the chosen living target", async () => {
  const game = createGame();
  const players = setTable(game, [
    { role: "Seer", targets: ["p2"] },
    { role: "Werewolf" },
    { role: "Witch" },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Villager" }
  ]);

  const events = await collect(game.runSeerAction());

  assert.equal(players[0].seerResults.p2, "werewolf");
  assert.equal(players[0].seerResultRounds.p2, 1);
  assert.ok(players[0].memories.some((memory) => memory.includes("人狼判定")));
  assert.ok(events.some((event) => event.type === "private_info" && event.targetId === "p2"));
});

test("werewolf attack target generation waits until private discussion finishes", async () => {
  const game = new WerewolfGame({ ...baseConfig, prefetchConcurrency: 1 }) as TestableGame;
  const players = setTable(game, [
    { role: "Werewolf" },
    { role: "Werewolf" },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  const firstWolf = new DelayedNightActionAgent(players[0].name, 120, 20);
  const secondWolf = new DelayedNightActionAgent(players[1].name, 120, 20);
  game.agents.set(players[0].id, firstWolf);
  game.agents.set(players[1].id, secondWolf);

  const run = game.runNight();
  const nightStart = await run.next();
  const discussionStart = await run.next();

  assert.equal(nightStart.value?.type, "phase_changed");
  assert.equal(discussionStart.value?.type, "phase_changed");
  assert.equal(discussionStart.value?.phase, "werewolf_discussion");

  const firstSpeech = run.next();
  await sleepWithAbort(60);
  const targetInputs = [...firstWolf.targetInputs, ...secondWolf.targetInputs];
  assert.equal(targetInputs.length, 0);
  assert.equal(firstWolf.speechInputs.length, 1);
  await firstSpeech;

  await collect(run);
  const completedTargetInputs = [...firstWolf.targetInputs, ...secondWolf.targetInputs];
  assert.ok(completedTargetInputs.length >= 2);
  assert.ok(completedTargetInputs.every((input) => input.phase === "night"));
  await run.return(undefined);
});

test("werewolf night discussion opens with one reaction round when an ally was voted out", async () => {
  const game = new WerewolfGame({ ...baseConfig, language: "Japanese", prefetchConcurrency: 1 }) as TestableGame;
  const reactionSpeech = (message: string): AgentSpeech => ({
    messages: [message],
    metadata: { suspects: [], trusts: [], claims: [] }
  });
  const players = setTable(game, [
    { role: "Werewolf", targets: ["p4"] },
    {
      role: "Werewolf",
      targets: ["p1", "p4"],
      speeches: [reactionSpeech("P2_REACTION 票筋が見えた、立て直す"), reactionSpeech("P2_ATTACK 襲撃先を絞る")]
    },
    {
      role: "AlphaWolf",
      targets: ["p1", "p4"],
      speeches: [reactionSpeech("P3_REACTION その票は明日ごまかす"), reactionSpeech("P3_ATTACK 村を削る")]
    },
    { role: "Villager", targets: ["p1"] },
    { role: "Villager", targets: ["p1"] },
    { role: "Villager", targets: ["p1"] }
  ]);
  (game as unknown as { round: number }).round = 1;

  await collect(game.runVoting());
  assert.equal(players[0].alive, false);

  const events = await collect(game.runNight());
  const werewolfSpeeches = events.filter((event) => event.type === "player_speech" && event.phase === "werewolf_discussion");
  const reactionEvents = werewolfSpeeches.filter((event) => event.data?.werewolfEliminationReaction === true);
  const secondWolfAgent = game.agents.get(players[1].id) as ScriptedAgent;
  const alphaWolfAgent = game.agents.get(players[2].id) as ScriptedAgent;

  assert.deepEqual(
    reactionEvents.map((event) => event.playerId),
    [players[1].id, players[2].id],
    "each surviving wolf gets one reaction line before normal attack discussion"
  );
  assert.ok(werewolfSpeeches.slice(0, 2).every((event) => event.data?.werewolfEliminationReaction === true));
  assert.equal(werewolfSpeeches[2]?.data?.werewolfEliminationReaction, undefined);
  assert.equal(reactionEvents[0].data?.eliminatedAllyId, players[0].id);
  assert.equal(reactionEvents[0].data?.eliminatedAllyRole, "Werewolf");
  assert.match(alphaWolfAgent.speechInputs[0].context, new RegExp(`${players[0].name}.*投票で処刑`));
  assert.match(alphaWolfAgent.speechInputs[0].context, /P2_REACTION/);
  assert.match(secondWolfAgent.speechInputs[1].context, /人狼チャット: .*P2_REACTION/);
  assert.match(secondWolfAgent.speechInputs[1].context, /人狼チャット: .*P3_REACTION/);
});

test("werewolf night discussion does not add the reaction round when a villager was voted out", async () => {
  const game = new WerewolfGame({ ...baseConfig, language: "Japanese", prefetchConcurrency: 1 }) as TestableGame;
  const speech = (message: string): AgentSpeech => ({
    messages: [message],
    metadata: { suspects: [], trusts: [], claims: [] }
  });
  const players = setTable(game, [
    { role: "Werewolf", targets: ["p4", "p5"], speeches: [speech("P1_NORMAL 襲撃相談")] },
    { role: "Werewolf", targets: ["p4", "p5"], speeches: [speech("P2_NORMAL 襲撃相談")] },
    { role: "Villager", targets: ["p4"] },
    { role: "Villager", targets: ["p1"] },
    { role: "Villager", targets: ["p4"] },
    { role: "Villager", targets: ["p4"] }
  ]);
  (game as unknown as { round: number }).round = 1;

  await collect(game.runVoting());
  assert.equal(players[3].alive, false);

  const events = await collect(game.runNight());
  const werewolfSpeeches = events.filter((event) => event.type === "player_speech" && event.phase === "werewolf_discussion");

  assert.equal(werewolfSpeeches.some((event) => event.data?.werewolfEliminationReaction === true), false);
  assert.ok(werewolfSpeeches.some((event) => event.message.includes("P1_NORMAL")));
  assert.ok(werewolfSpeeches.some((event) => event.message.includes("P2_NORMAL")));
});

test("human werewolf private discussion biases later wolf votes without adding virtual votes", async () => {
  const requests: HumanInputRequestPayload[] = [];
  let preferredTargetId = "";
  let preferredTargetName = "";
  const humanInput: HumanInputHandler = {
    async request(input) {
      requests.push(input);
      if (input.kind === "speech_choice") {
        return { speech: `${preferredTargetName}を襲撃したい。占い師っぽくて危険です。` };
      }
      if (input.kind === "target") {
        return { targetId: preferredTargetId, reason: "人間プレイヤーの襲撃投票です。" };
      }
      return { decision: false };
    }
  };
  const game = new WerewolfGame(
    { ...baseConfig, humanPlayerId: "p1", language: "Japanese", prefetchConcurrency: 1 },
    { humanInput }
  ) as TestableGame;
  const players = setTable(game, [
    { role: "Werewolf" },
    { role: "Werewolf", targets: ["p5"] },
    { role: "AlphaWolf", targets: ["p5"] },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  preferredTargetId = players[3].id;
  preferredTargetName = players[3].name;
  game.agents.set(players[0].id, new HumanInputAgent(players[0].name, humanInput, "Japanese"));
  game.agents.set(players[1].id, new ContextMentionTargetAgent(players[1].name, preferredTargetId, preferredTargetName, ["p5"]));
  game.agents.set(players[2].id, new ContextMentionTargetAgent(players[2].name, preferredTargetId, preferredTargetName, ["p5"]));
  players[0].model = "human";

  const events = await collect(game.runNight());
  const attackResult = events.find((event) => event.data?.action === "werewolf_attack_vote_result");
  const totals = attackResult?.data?.totals as Array<{ targetId: string; count: number }> | undefined;
  const votes = attackResult?.data?.votes as Array<{ voterId: string; targetId: string }> | undefined;
  const secondWolf = game.agents.get(players[1].id) as ContextMentionTargetAgent;

  assert.ok(requests.some((request) => request.kind === "speech_choice" && request.phase === "werewolf_discussion"));
  assert.ok(secondWolf.speechInputs[0].context.includes(preferredTargetName), "later wolf speech should see the human's target push");
  assert.equal(attackResult?.data?.selectedTargetId, preferredTargetId);
  assert.equal(attackResult?.data?.modifiers, undefined);
  assert.equal(votes?.length, 3);
  assert.ok(votes?.every((vote) => vote.targetId === preferredTargetId));
  assert.deepEqual(totals, [{ targetId: preferredTargetId, targetName: preferredTargetName, count: 3 }]);
});

test("werewolf attack vote totals count only living wolf ballots, not discussion pressure", async () => {
  const game = new WerewolfGame({ ...baseConfig, language: "Japanese", prefetchConcurrency: 1 }) as TestableGame;
  const players = setTable(game, [
    { role: "Werewolf", targets: ["p4"] },
    { role: "Werewolf", targets: ["p5"] },
    { role: "AlphaWolf", targets: ["p5"] },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  const pressureSpeech = (wolfName: string): AgentSpeech => ({
    messages: [`${wolfName}は${players[3].name}を襲撃したい`],
    metadata: {
      suspects: [{ targetId: players[3].id, targetName: players[3].name, weight: 1 }],
      trusts: [],
      claims: []
    }
  });
  game.agents.set(players[0].id, new ScriptedAgent(players[0].name, ["p4"], [], [pressureSpeech(players[0].name)]));
  game.agents.set(players[1].id, new ScriptedAgent(players[1].name, ["p5"], [], [pressureSpeech(players[1].name)]));
  game.agents.set(players[2].id, new ScriptedAgent(players[2].name, ["p5"], [], [pressureSpeech(players[2].name)]));

  const events = await collect(game.runNight());
  const result = events.find((event) => event.type === "system" && event.data?.action === "werewolf_attack_vote_result");
  const totals = result?.data?.totals as Array<{ targetId: string; targetName: string; count: number }> | undefined;
  const votes = result?.data?.votes as Array<{ voterId: string; targetId: string }> | undefined;

  assert.ok(result);
  assert.equal(result.data?.selectedTargetId, players[4].id);
  assert.equal(votes?.length, 3);
  assert.equal(totals?.reduce((sum, total) => sum + total.count, 0), 3);
  assert.deepEqual(totals, [
    { targetId: players[3].id, targetName: players[3].name, count: 1 },
    { targetId: players[4].id, targetName: players[4].name, count: 2 }
  ]);
  assert.equal(result.data?.modifiers, undefined);
  assert.doesNotMatch(result.message, /誘導も加算/);
});

test("dead human werewolf is excluded from night discussion and attack voting", async () => {
  const requests: HumanInputRequestPayload[] = [];
  const humanInput: HumanInputHandler = {
    async request(input) {
      requests.push(input);
      if (input.kind === "target") {
        return { targetId: input.candidates[0]?.id ?? null, reason: "dead player should not act" };
      }
      if (input.kind === "speech_choice") {
        return { speech: "dead player should not speak" };
      }
      return { decision: false };
    }
  };
  const game = new WerewolfGame(
    { ...baseConfig, humanPlayerId: "p1", language: "Japanese", prefetchConcurrency: 1 },
    { humanInput }
  ) as TestableGame;
  const players = setTable(game, [
    { role: "AlphaWolf", alive: false, targets: ["p4"] },
    { role: "Werewolf", targets: ["p5"] },
    { role: "Werewolf", targets: ["p5"] },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Villager" }
  ]);

  const events = await collect(game.runNight());
  const result = events.find((event) => event.type === "system" && event.data?.action === "werewolf_attack_vote_result");
  const votes = result?.data?.votes as Array<{ voterId: string; targetId: string }> | undefined;
  const totals = result?.data?.totals as Array<{ targetId: string; targetName: string; count: number }> | undefined;

  assert.deepEqual(requests, []);
  assert.ok(result);
  assert.equal(result.data?.selectedTargetId, players[4].id);
  assert.equal(votes?.length, 2);
  assert.ok(votes?.every((vote) => vote.voterId !== players[0].id));
  assert.deepEqual(totals, [{ targetId: players[4].id, targetName: players[4].name, count: 2 }]);
});

test("human player is protected from early werewolf attack targets by table size", async () => {
  const cases = [
    { playerCount: 8, protectedRound: 2, expiredRound: 3 },
    { playerCount: 9, protectedRound: 3, expiredRound: 4 },
    { playerCount: 14, protectedRound: 4, expiredRound: 5 }
  ];

  const table = (playerCount: number): Array<{ role: Role; targets?: Array<string | null> }> =>
    Array.from({ length: playerCount }, (_, index) => ({
      role: index < 2 ? "Werewolf" : "Villager",
      targets: index < 2 ? ["p3"] : undefined
    }));

  for (const { playerCount, protectedRound, expiredRound } of cases) {
    const protectedGame = new WerewolfGame({
      ...baseConfig,
      playerCount,
      maxRounds: 8,
      humanPlayerId: "p3",
      prefetchConcurrency: 1
    }) as TestableGame;
    const protectedPlayers = setTable(protectedGame, table(playerCount));
    (protectedGame as unknown as { round: number }).round = protectedRound;

    const protectedEvents = await collect(protectedGame.runNight());
    const protectedWolfInputs = protectedPlayers
      .slice(0, 2)
      .flatMap((player) => (protectedGame.agents.get(player.id) as ScriptedAgent).targetInputs);

    assert.ok(protectedWolfInputs.length > 0);
    assert.ok(protectedWolfInputs.every((input) => input.candidates.every((candidate) => candidate.id !== "p3")));
    assert.ok(protectedEvents.every((event) => event.type !== "death" || event.targetId !== "p3"));

    const expiredGame = new WerewolfGame({
      ...baseConfig,
      playerCount,
      maxRounds: 8,
      humanPlayerId: "p3",
      prefetchConcurrency: 1
    }) as TestableGame;
    const expiredPlayers = setTable(expiredGame, table(playerCount));
    (expiredGame as unknown as { round: number }).round = expiredRound;

    const expiredEvents = await collect(expiredGame.runNight());
    const expiredWolfInputs = expiredPlayers
      .slice(0, 2)
      .flatMap((player) => (expiredGame.agents.get(player.id) as ScriptedAgent).targetInputs);

    assert.ok(expiredWolfInputs.length > 0);
    assert.ok(expiredWolfInputs.every((input) => input.candidates.some((candidate) => candidate.id === "p3")));
    assert.ok(expiredEvents.some((event) => event.type === "death" && event.targetId === "p3"));
  }
});

test("human player is protected from early vote targets by table size", async () => {
  const cases = [
    { playerCount: 8, protectedRound: 2, expiredRound: 3 },
    { playerCount: 9, protectedRound: 3, expiredRound: 4 },
    { playerCount: 14, protectedRound: 4, expiredRound: 5 }
  ];

  const table = (playerCount: number): Array<{ role: Role; targets?: Array<string | null> }> =>
    Array.from({ length: playerCount }, (_, index) => ({
      role: index === 2 ? "Werewolf" : "Villager",
      targets: [index === 2 ? "p1" : "p3"]
    }));

  for (const { playerCount, protectedRound, expiredRound } of cases) {
    const protectedGame = new WerewolfGame({
      ...baseConfig,
      playerCount,
      maxRounds: 8,
      humanPlayerId: "p3",
      prefetchConcurrency: 1
    }) as TestableGame;
    const protectedPlayers = setTable(protectedGame, table(playerCount));
    (protectedGame as unknown as { round: number }).round = protectedRound;

    const protectedEvents = await collect(protectedGame.runVoting());
    const protectedVoteInputs = protectedPlayers.flatMap((player) => (protectedGame.agents.get(player.id) as ScriptedAgent).targetInputs);

    assert.ok(protectedVoteInputs.length > 0);
    assert.ok(protectedVoteInputs.every((input) => input.candidates.every((candidate) => candidate.id !== "p3")));
    assert.ok(protectedEvents.every((event) => event.type !== "vote_cast" || event.targetId !== "p3"));
    assert.ok(protectedEvents.every((event) => event.type !== "death" || event.targetId !== "p3"));

    const expiredGame = new WerewolfGame({
      ...baseConfig,
      playerCount,
      maxRounds: 8,
      humanPlayerId: "p3",
      prefetchConcurrency: 1
    }) as TestableGame;
    const expiredPlayers = setTable(expiredGame, table(playerCount));
    (expiredGame as unknown as { round: number }).round = expiredRound;

    const expiredEvents = await collect(expiredGame.runVoting());
    const expiredNonHumanInputs = expiredPlayers
      .filter((player) => player.id !== "p3")
      .flatMap((player) => (expiredGame.agents.get(player.id) as ScriptedAgent).targetInputs);

    assert.ok(expiredNonHumanInputs.length > 0);
    assert.ok(expiredNonHumanInputs.every((input) => input.candidates.some((candidate) => candidate.id === "p3")));
    assert.ok(expiredEvents.some((event) => event.type === "death" && event.targetId === "p3" && event.data?.cause === "vote"));
  }
});

test("early human vote protection excludes Raven marks and vote modifiers", async () => {
  const game = new WerewolfGame({
    ...baseConfig,
    humanPlayerId: "p3",
    prefetchConcurrency: 1
  }) as TestableGame;
  const players = setTable(game, [
    { role: "Raven", targets: ["p3"] },
    { role: "Villager", targets: ["p3"] },
    { role: "Werewolf", targets: ["p1"] },
    { role: "Villager", targets: ["p3"] },
    { role: "Villager", targets: ["p3"] },
    { role: "Villager", targets: ["p3"] }
  ]);
  (game as unknown as { round: number }).round = 1;

  const ravenEvents = await collect(game.runRavenAction(players[0]));
  const ravenAgent = game.agents.get(players[0].id) as ScriptedAgent;

  assert.equal(ravenEvents.length, 0);
  assert.ok(ravenAgent.targetInputs[0].candidates.every((candidate) => candidate.id !== "p3"));

  game.ruleState = applyStatusEffects(game.ruleState, [
    { playerId: "p3", addStatuses: [{ kind: "raven_marked", sourceId: players[0].id, duration: "round", count: 5 }] }
  ]);

  const voteEvents = await collect(game.runVoting());
  const totals = voteEvents.find((event) => event.type === "vote_result" && Array.isArray(event.data?.totals));

  assert.equal(players[2].alive, true);
  assert.ok(!voteEvents.some((event) => event.type === "vote_cast" && event.targetId === "p3"));
  assert.ok(!voteEvents.some((event) => event.type === "death" && event.targetId === "p3"));
  assert.ok((totals?.data?.totals as Array<{ targetId: string }> | undefined)?.every((total) => total.targetId !== "p3"));
});

test("human player is protected from early witch poison and death-shot targets", async () => {
  const game = new WerewolfGame({
    ...baseConfig,
    humanPlayerId: "p3",
    prefetchConcurrency: 1
  }) as TestableGame;
  const players = setTable(game, [
    { role: "Werewolf", targets: ["p4"] },
    { role: "Witch", decisions: [false], targets: ["p3"] },
    { role: "Villager" },
    { role: "Hunter", targets: ["p3"] },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  (game as unknown as { round: number }).round = 1;

  const events = await collect(game.runNight());
  const witchInputs = (game.agents.get("p2") as ScriptedAgent).targetInputs.filter((input) => input.action === "Witch poison potion");
  const hunterInputs = (game.agents.get("p4") as ScriptedAgent).targetInputs.filter((input) => input.action === "Hunter death shot");

  assert.equal(players[2].alive, true);
  assert.ok(events.some((event) => event.type === "death" && event.targetId === "p4" && event.data?.cause === "werewolf"));
  assert.ok(!events.some((event) => event.type === "death" && event.targetId === "p3"));
  assert.ok(witchInputs.length > 0);
  assert.ok(witchInputs.every((input) => input.actionLabel === "魔女の毒薬"));
  assert.ok(witchInputs.every((input) => input.candidates.every((candidate) => candidate.id !== "p3")));
  assert.ok(hunterInputs.length > 0);
  assert.ok(hunterInputs.every((input) => input.actionLabel === "ハンターの道連れ"));
  assert.ok(hunterInputs.every((input) => input.candidates.every((candidate) => candidate.id !== "p3")));
});

test("human werewolf is not protected from early witch poison", async () => {
  const game = new WerewolfGame({
    ...baseConfig,
    humanPlayerId: "p3",
    prefetchConcurrency: 1
  }) as TestableGame;
  const players = setTable(game, [
    { role: "Werewolf", targets: ["p5"] },
    { role: "Witch", decisions: [false], targets: ["p3"] },
    { role: "Werewolf", targets: ["p5"] },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  (game as unknown as { round: number }).round = 1;

  const events = await collect(game.runNight());
  const witchInputs = (game.agents.get("p2") as ScriptedAgent).targetInputs.filter((input) => input.action === "Witch poison potion");

  assert.ok(witchInputs.length > 0);
  assert.ok(witchInputs.every((input) => input.candidates.some((candidate) => candidate.id === "p3")));
  assert.equal(players[2].alive, false);
  assert.ok(events.some((event) => event.type === "death" && event.targetId === "p3" && event.data?.cause === "poison"));
});

test("human werewolf is not protected from early death-shot targets", async () => {
  const game = new WerewolfGame({
    ...baseConfig,
    humanPlayerId: "p3",
    prefetchConcurrency: 1
  }) as TestableGame;
  const players = setTable(game, [
    { role: "Werewolf", targets: ["p4"] },
    { role: "Villager" },
    { role: "Werewolf", targets: ["p4"] },
    { role: "Hunter", targets: ["p3"] },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  (game as unknown as { round: number }).round = 1;

  const events = await collect(game.runNight());
  const hunterInputs = (game.agents.get("p4") as ScriptedAgent).targetInputs.filter((input) => input.action === "Hunter death shot");

  assert.ok(hunterInputs.length > 0);
  assert.ok(hunterInputs.every((input) => input.candidates.some((candidate) => candidate.id === "p3")));
  assert.equal(players[2].alive, false);
  assert.ok(events.some((event) => event.type === "death" && event.targetId === "p3" && event.data?.cause === "hunter"));
});

test("early human night protection does not block lover linked deaths", async () => {
  const game = new WerewolfGame({
    ...baseConfig,
    humanPlayerId: "p3",
    prefetchConcurrency: 1
  }) as TestableGame;
  const players = setTable(game, [
    { role: "Werewolf", targets: ["p4"] },
    { role: "Witch", decisions: [false], targets: [null] },
    { role: "Lover" },
    { role: "Lover" },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  (game as unknown as { round: number }).round = 1;

  const events = await collect(game.runNight());

  assert.equal(players[2].alive, false);
  assert.equal(players[3].alive, false);
  assert.ok(events.some((event) => event.type === "death" && event.targetId === "p4" && event.data?.cause === "werewolf"));
  assert.ok(
    events.some(
      (event) =>
        event.type === "death" && event.targetId === "p3" && event.data?.cause === "lover" && event.data?.sourceId === "p4"
    )
  );
});

test("early human night protection does not block WolfBeauty linked deaths", async () => {
  const game = new WerewolfGame({
    ...baseConfig,
    humanPlayerId: "p3",
    prefetchConcurrency: 1
  }) as TestableGame;
  const players = setTable(game, [
    { role: "WolfBeauty" },
    { role: "Witch", decisions: [false], targets: ["p1"] },
    { role: "Villager" },
    { role: "Werewolf", targets: ["p5"] },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  game.ruleState = applyStatusEffects(game.ruleState, [
    {
      playerId: players[0].id,
      addStatuses: [{ kind: "charm_anchor", sourceId: players[0].id, targetId: players[2].id, duration: "game" }]
    },
    {
      playerId: players[2].id,
      addStatuses: [{ kind: "charmed", sourceId: players[0].id, duration: "game" }]
    }
  ]);
  (game as unknown as { round: number }).round = 1;

  const events = await collect(game.runNight());

  assert.equal(players[0].alive, false);
  assert.equal(players[2].alive, false);
  assert.ok(events.some((event) => event.type === "death" && event.targetId === "p1" && event.data?.cause === "poison"));
  assert.ok(
    events.some(
      (event) =>
        event.type === "death" &&
        event.targetId === "p3" &&
        event.data?.cause === "wolf_beauty_charm" &&
        event.data?.sourceId === "p1"
    )
  );
});

test("LLM target decisions race duplicate requests and accept the fastest result", async () => {
  const game = new WerewolfGame({
    ...baseConfig,
    provider: "llm",
    model: "target-racer",
    prefetchConcurrency: 5
  }) as TestableGame;
  const players = setTable(game, [
    { role: "Guard" },
    { role: "Werewolf" },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  const agent = new DelayedTargetRaceAgent(
    players[0].name,
    "target-racer",
    [80, 5, 80, 80, 80],
    ["p2", "p3", "p4", "p5", "p6"]
  );
  game.agents.set(players[0].id, agent);

  const events = await collect(game.runGuardAction());

  assert.equal(events[0]?.type, "night_action");
  assert.equal(events[0]?.targetId, "p3");
  assert.equal(agent.targetInputs.length, 5);
  assert.ok(agent.targetInputs.every((input) => input.phase === "guard_action"));
  assert.ok(agent.targetInputs.every((input) => input.actionLabel === "騎士の夜護衛"));
  await waitUntil(() => agent.abortedTargets >= 4);
  assert.equal(players[0].memories.some((memory) => memory.includes("LLM error") || memory.includes("対象選択中")), false);
});

test("LLM boolean decisions race duplicate requests and accept the fastest result", async () => {
  const game = new WerewolfGame({
    ...baseConfig,
    provider: "llm",
    model: "boolean-racer",
    prefetchConcurrency: 5
  }) as TestableGame;
  const players = setTable(game, [
    { role: "Witch" },
    { role: "Werewolf" },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  const agent = new DelayedBooleanRaceAgent(players[0].name, "boolean-racer", [80, 5, 80, 80, 80], [false, true, false, false, false]);
  game.agents.set(players[0].id, agent);
  game.witchState.poisonPotion = false;

  const events = await collect(game.runWitchAction(players[2]));

  assert.equal(events[0]?.type, "night_action");
  assert.equal(events[0]?.targetId, players[2].id);
  assert.equal(events[0]?.data?.action, "witch_save");
  assert.equal(game.witchState.savePotion, false);
  assert.equal(agent.booleanInputs.length, 5);
  assert.ok(agent.booleanInputs.every((input) => input.phase === "witch_action"));
  await waitUntil(() => agent.abortedDecisions >= 4);
  assert.equal(players[0].memories.some((memory) => memory.includes("LLM error") || memory.includes("判断中")), false);
});

test("LLM voting decisions share the five-request budget across voters", async () => {
  const game = new WerewolfGame({
    ...baseConfig,
    provider: "llm",
    model: "budgeted-vote",
    prefetchConcurrency: 5
  }) as TestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" },
    { role: "Villager", alive: false }
  ]);
  const counter: ActiveTargetCounter = { active: 0, calls: 0, maxActive: 0 };
  for (const player of players.slice(0, 5)) {
    game.agents.set(player.id, new CountingTargetRaceAgent(player.name, "budgeted-vote", counter));
  }

  await collect(game.runVoting());

  assert.equal(counter.calls, 5);
  assert.equal(counter.maxActive, 5);
  assert.deepEqual(
    players.slice(0, 5).map((player) => (game.agents.get(player.id) as CountingTargetRaceAgent).targetInputs.length),
    [1, 1, 1, 1, 1]
  );
});

test("day vote casts keep voter order even when decisions finish out of order", async () => {
  const game = new WerewolfGame({ ...baseConfig, prefetchConcurrency: 5 }) as TestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" },
    { role: "Villager", alive: false }
  ]);
  const delays = [50, 1, 1, 1, 1];
  for (const [index, player] of players.slice(0, 5).entries()) {
    game.agents.set(player.id, new DelayedNightActionAgent(player.name, 0, delays[index] ?? 1));
  }

  const events = await collect(game.runVoting());
  const voteCastPlayerIds = events.filter((event) => event.type === "vote_cast").map((event) => event.playerId);

  assert.deepEqual(
    voteCastPlayerIds,
    players.slice(0, 5).map((player) => player.id)
  );
});

test("day vote timeouts follow the current leading target", async () => {
  const game = new FastDayVoteTimeoutGame({ ...baseConfig, language: "Japanese", prefetchConcurrency: 5 }) as TestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" },
    { role: "Villager", alive: false }
  ]);
  const slowAgent = new DelayedTargetRaceAgent(players[0].name, "delayed", [50], [players[1].id]);
  game.agents.set(players[0].id, slowAgent);
  game.agents.set(players[1].id, new DelayedTargetRaceAgent(players[1].name, "delayed", [1], [players[3].id]));
  game.agents.set(players[2].id, new DelayedTargetRaceAgent(players[2].name, "delayed", [1], [players[3].id]));
  game.agents.set(players[3].id, new DelayedTargetRaceAgent(players[3].name, "delayed", [1], [players[4].id]));
  game.agents.set(players[4].id, new DelayedTargetRaceAgent(players[4].name, "delayed", [1], [players[3].id]));

  const events = await collect(game.runVoting());
  const voteEvents = events.filter((event) => event.type === "vote_cast");

  assert.equal(slowAgent.abortedTargets, 1);
  assert.deepEqual(
    voteEvents.map((event) => event.playerId),
    players.slice(0, 5).map((player) => player.id)
  );
  assert.equal(voteEvents[0]?.targetId, players[3].id);
  assert.equal(voteEvents[0]?.data?.timeoutFallback, true);
  assert.equal(voteEvents[0]?.data?.timeoutMs, 15);
});

test("LLM voting decisions use spare request budget as duplicate races", async () => {
  const game = new WerewolfGame({
    ...baseConfig,
    provider: "llm",
    model: "budgeted-short-vote",
    prefetchConcurrency: 5
  }) as TestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager", alive: false },
    { role: "Villager", alive: false }
  ]);
  const counter: ActiveTargetCounter = { active: 0, calls: 0, maxActive: 0 };
  for (const player of players.slice(0, 4)) {
    game.agents.set(player.id, new CountingTargetRaceAgent(player.name, "budgeted-short-vote", counter));
  }

  await collect(game.runVoting());

  assert.equal(counter.calls, 5);
  assert.equal(counter.maxActive, 5);
  assert.deepEqual(
    players
      .slice(0, 4)
      .map((player) => (game.agents.get(player.id) as CountingTargetRaceAgent).targetInputs.length)
      .sort((a, b) => b - a),
    [2, 1, 1, 1]
  );
});

test("LLM werewolf attack decisions distribute the five-request budget across wolves", async () => {
  const game = new WerewolfGame({
    ...baseConfig,
    provider: "llm",
    model: "budgeted-wolf",
    prefetchConcurrency: 5
  }) as TestableGame;
  const players = setTable(game, [
    { role: "Werewolf" },
    { role: "Werewolf" },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Villager" }
  ]);
  const counter: ActiveTargetCounter = { active: 0, calls: 0, maxActive: 0 };
  for (const player of players.slice(0, 2)) {
    game.agents.set(player.id, new CountingTargetRaceAgent(player.name, "budgeted-wolf", counter));
  }

  await collect(game.runNight());

  assert.equal(counter.calls, 5);
  assert.equal(counter.maxActive, 5);
  assert.deepEqual(
    players
      .slice(0, 2)
      .map((player) => (game.agents.get(player.id) as CountingTargetRaceAgent).targetInputs.length)
      .sort((a, b) => b - a),
    [3, 2]
  );
});

test("werewolf attack vote emits a werewolf-visible system result for a clear top vote", async () => {
  const game = new WerewolfGame({ ...baseConfig, language: "Japanese" }) as TestableGame;
  const players = setTable(game, [
    { role: "Werewolf", targets: ["p3"] },
    { role: "AlphaWolf", targets: ["p3"] },
    { role: "Villager" },
    { role: "Seer" },
    { role: "Villager" },
    { role: "Villager" }
  ]);

  const events = await collect(game.runNight());
  const result = events.find((event) => event.type === "system" && event.data?.action === "werewolf_attack_vote_result");

  assert.ok(result);
  assert.equal(result.data?.visibility, "werewolf");
  assert.equal(result.data?.selectedTargetId, "p3");
  assert.equal(result.data?.tied, false);
  assert.equal(result.data?.randomSelectionReason, null);
  assert.match(result.message, new RegExp(`${players[2].name} 2票`));
  assert.match(result.message, new RegExp(`最多票の${players[2].name}を襲撃することが決定しました`));
  assert.deepEqual(result.data?.totals, [{ targetId: "p3", targetName: players[2].name, count: 2 }]);
  assert.equal(redactEventForPlayer(result, players[0].id).message, result.message);
  assert.equal(redactEventForPlayer(result, players[2].id).data.redacted, true);
  assert.equal(redactEventForVillage(result).data.redacted, true);
});

test("werewolf attack vote explains tied top votes and the random victim", async () => {
  const game = new WerewolfGame({ ...baseConfig, language: "Japanese" }) as TestableGame;
  const players = setTable(game, [
    { role: "Werewolf", targets: ["p3"] },
    { role: "AlphaWolf", targets: ["p4"] },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Seer" },
    { role: "Villager" }
  ]);
  const originalRandom = Math.random;
  Math.random = () => 0.99;

  try {
    const events = await collect(game.runNight());
    const result = events.find((event) => event.type === "system" && event.data?.action === "werewolf_attack_vote_result");

    assert.ok(result);
    assert.equal(result.data?.selectedTargetId, "p4");
    assert.equal(result.data?.tied, true);
    assert.equal(result.data?.randomSelectionReason, "tie");
    assert.match(result.message, new RegExp(`${players[2].name} 1票`));
    assert.match(result.message, new RegExp(`${players[3].name} 1票`));
    assert.match(result.message, /最多票が.+で並んだため、ランダムで襲撃先を決めた結果/);
    assert.match(result.message, new RegExp(`${players[3].name}が襲撃先になりました`));
    assert.deepEqual(result.data?.candidates, [
      { targetId: "p3", targetName: players[2].name },
      { targetId: "p4", targetName: players[3].name }
    ]);
  } finally {
    Math.random = originalRandom;
  }
});

test("witch save potion prevents the werewolf kill and consumes explicit engine state", async () => {
  const game = createGame();
  const players = setTable(game, [
    { role: "Witch", decisions: [true], targets: [null] },
    { role: "Werewolf" },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Villager" }
  ]);

  const events = await collect(game.runWitchAction(players[2]));

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "night_action");
  assert.equal(events[0]?.data?.action, "witch_save");
  assert.equal(game.witchState.savePotion, false);
  assert.equal(game.witchState.savedTargetId, "p3");
  assert.equal(game.witchState.poisonPotion, true);
  assert.equal(game.witchState.poisonTargetId, null);
});

test("witch can use save and poison potions on the same night", async () => {
  const game = createGame();
  const players = setTable(game, [
    { role: "Witch", decisions: [true], targets: ["p4"] },
    { role: "Werewolf", targets: ["p3"] },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Villager" }
  ]);

  const events = await collect(game.runNight());
  const witchActions = events.filter((event) => event.type === "night_action" && event.playerId === "p1");
  const witchAgent = game.agents.get(players[0].id) as ScriptedAgent;

  assert.deepEqual(
    witchActions.map((event) => event.data?.action),
    ["witch_save", "witch_poison"]
  );
  assert.equal(players[2].alive, true);
  assert.equal(players[3].alive, false);
  assert.equal(game.witchState.savePotion, false);
  assert.equal(game.witchState.poisonPotion, false);
  assert.equal(game.witchState.savedTargetId, "p3");
  assert.equal(game.witchState.poisonTargetId, "p4");
  assert.ok(witchAgent.targetInputs[0]?.candidates.every((candidate) => candidate.id !== "p3"));
});

test("witch poison uses engine state and does not mark target memories", async () => {
  const game = createGame();
  const players = setTable(game, [
    { role: "Witch", decisions: [false], targets: ["p4"] },
    { role: "Werewolf", targets: ["p3"] },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Villager" }
  ]);

  await collect(game.runNight());

  assert.equal(players[2].alive, false);
  assert.equal(players[3].alive, false);
  assert.equal(game.witchState.poisonPotion, false);
  assert.equal(game.witchState.poisonTargetId, "p4");
  assert.deepEqual(
    players[3].memories.filter((memory) => memory.startsWith("poisoned:")),
    []
  );
});

test("guard protection blocks the werewolf kill and remembers the protected target", async () => {
  const game = createGame();
  const players = setTable(game, [
    { role: "Guard", targets: ["p3"] },
    { role: "Werewolf", targets: ["p3"] },
    { role: "Villager" },
    { role: "Seer" },
    { role: "Witch", decisions: [false], targets: [null] },
    { role: "Villager" }
  ]);

  const events = await collect(game.runNight());

  assert.equal(players[2].alive, true);
  assert.equal(game.guardState.lastProtectedTargetId, "p3");
  assert.ok(events.some((event) => event.type === "night_action" && event.data?.action === "guard_protect" && event.data?.visibility === "private"));
  assert.ok(events.some((event) => event.type === "private_info" && event.data?.action === "guard_success" && event.data?.visibility === "private"));
  assert.ok(events.some((event) => event.type === "death" && event.data?.cause === "no_death"));
});

test("guard protection miss does not block the werewolf kill or emit success info", async () => {
  const game = createGame();
  const players = setTable(game, [
    { role: "Guard", targets: ["p4"] },
    { role: "Werewolf", targets: ["p3"] },
    { role: "Villager" },
    { role: "Seer" },
    { role: "Witch", decisions: [false], targets: [null] },
    { role: "Villager" }
  ]);

  const events = await collect(game.runNight());

  assert.equal(players[2].alive, false);
  const death = events.find((event) => event.type === "death" && event.targetId === "p3" && event.data?.cause === "werewolf");
  assert.ok(death);
  assert.equal(death.phase, "night");
  assert.doesNotMatch(death.message, /werewolf|attack|人狼|襲撃/);
  assert.ok(!events.some((event) => event.type === "private_info" && event.data?.action === "guard_success"));
});

test("private night events are marked for client-side village redaction", async () => {
  const game = createGame();
  setTable(game, [
    { role: "Guard", targets: ["p3"] },
    { role: "Werewolf", targets: ["p3"] },
    { role: "Villager" },
    { role: "Seer" },
    { role: "Witch", decisions: [false], targets: [null] },
    { role: "Villager" }
  ]);

  const events = await collect(game.runNight());
  const secretEvents = events.filter((event) => event.type === "night_action" || event.type === "private_info");

  assert.ok(secretEvents.length > 0);
  assert.ok(secretEvents.every((event) => event.data?.visibility === "private"));
});

test("village redaction helper strips private event and snapshot role data", async () => {
  const game = createGame();
  setTable(game, [
    { role: "Guard", targets: ["p3"] },
    { role: "Werewolf", targets: ["p3"] },
    { role: "Villager" },
    { role: "Seer" },
    { role: "Witch", decisions: [false], targets: [null] },
    { role: "Villager" }
  ]);

  const events = await collect(game.runNight());
  const privateEvent = events.find((event) => event.type === "night_action" && event.data?.action === "guard_protect");

  assert.ok(privateEvent);
  const redacted = redactEventForVillage(privateEvent);

  assert.equal(redacted.message, "あなたの視点では非公開情報です\n次へ進んでください");
  assert.equal(redacted.playerName, undefined);
  assert.equal(redacted.targetName, undefined);
  assert.equal(redacted.role, undefined);
  assert.equal(redacted.data.redacted, true);
  assert.equal(redacted.snapshot.werewolfCount, null);
  assert.equal(redacted.snapshot.villageCount, null);
  assert.ok(redacted.snapshot.players.every((player) => player.role === "Hidden" && player.camp === "hidden"));
});

test("player redaction reveals only the human player's role and private info", () => {
  const snapshot = {
    round: 1,
    phase: "seer_action" as const,
    winner: null,
    players: [
      {
        id: "p1",
        name: "シオン",
        role: "Werewolf" as const,
        camp: "werewolf" as const,
        persona: "cautious" as const,
        alive: true,
        model: "demo",
        memoryCount: 0
      },
      {
        id: "p3",
        name: "アカネ",
        role: "Seer" as const,
        camp: "village" as const,
        persona: "logical" as const,
        alive: true,
        model: "human",
        memoryCount: 0
      }
    ],
    aliveCount: 2,
    werewolfCount: 1,
    villageCount: 1
  };
  const event: GameEvent = {
    id: 1,
    createdAt: "2026-05-21T00:00:00.000Z",
    round: 1,
    phase: "seer_action",
    type: "private_info",
    message: "アカネはシオンが狼陣営だと知りました。",
    playerId: "p3",
    playerName: "アカネ",
    role: "Seer",
    targetId: "p1",
    targetName: "シオン",
    data: { visibility: "private", visibleTo: "p3", action: "seer_check", result: "werewolf" },
    snapshot
  };

  const humanView = redactEventForPlayer(event, "p3");
  assert.equal(humanView.message, event.message);
  assert.equal(humanView.data.result, "werewolf");
  assert.equal(humanView.snapshot.players.find((player) => player.id === "p3")?.role, "Seer");
  assert.equal(humanView.snapshot.players.find((player) => player.id === "p1")?.role, "Hidden");
  assert.equal(humanView.snapshot.werewolfCount, null);

  const otherView = redactEventForPlayer(event, "p2");
  assert.equal(otherView.data.redacted, true);
  assert.equal(otherView.playerId, undefined);
});

test("werewolf discussion speech is shared with every werewolf-camp viewer", () => {
  const snapshot = {
    round: 1,
    phase: "werewolf_discussion" as const,
    winner: null,
    players: [
      {
        id: "p1",
        name: "シオン",
        role: "Werewolf" as const,
        camp: "werewolf" as const,
        persona: "cautious" as const,
        alive: true,
        model: "demo",
        memoryCount: 0
      },
      {
        id: "p2",
        name: "ガク",
        role: "Werewolf" as const,
        camp: "werewolf" as const,
        persona: "logical" as const,
        alive: true,
        model: "human",
        memoryCount: 0
      },
      {
        id: "p3",
        name: "アカネ",
        role: "Villager" as const,
        camp: "village" as const,
        persona: "logical" as const,
        alive: true,
        model: "demo",
        memoryCount: 0
      }
    ],
    aliveCount: 3,
    werewolfCount: 2,
    villageCount: 1
  };
  const event: GameEvent = {
    id: 1,
    createdAt: "2026-05-21T00:00:00.000Z",
    round: 1,
    phase: "werewolf_discussion",
    type: "player_speech",
    message: "シオンはアカネを襲撃しようと提案した。",
    playerId: "p1",
    playerName: "シオン",
    role: "Werewolf",
    data: { visibility: "werewolf", speech: "アカネを襲撃しよう。" },
    snapshot
  };

  // The speaker sees their own speech.
  const speakerView = redactEventForPlayer(event, "p1");
  assert.equal(speakerView.message, event.message);

  // A fellow werewolf (here the human player) must also see it.
  const teammateView = redactEventForPlayer(event, "p2");
  assert.equal(teammateView.message, event.message);
  assert.equal(teammateView.playerName, "シオン");
  assert.equal(teammateView.data.speech, "アカネを襲撃しよう。");
  assert.notEqual(teammateView.data.redacted, true);

  // A village-camp player still has it redacted.
  const villagerView = redactEventForPlayer(event, "p3");
  assert.equal(villagerView.data.redacted, true);
  assert.equal(villagerView.playerName, undefined);

  // A werewolf viewer's roster reveals their allies' real roles (the face-off named them),
  // while a villager still sees everyone else hidden.
  const wolfSnapshot = redactSnapshotForPlayer(snapshot, "p2");
  assert.equal(wolfSnapshot.players.find((player) => player.id === "p1")?.role, "Werewolf");
  assert.equal(wolfSnapshot.players.find((player) => player.id === "p1")?.camp, "werewolf");
  assert.equal(wolfSnapshot.players.find((player) => player.id === "p2")?.role, "Werewolf");
  assert.equal(wolfSnapshot.players.find((player) => player.id === "p3")?.role, "Hidden");
  assert.equal(wolfSnapshot.players.find((player) => player.id === "p3")?.camp, "hidden");

  const villagerSnapshot = redactSnapshotForPlayer(snapshot, "p3");
  assert.equal(villagerSnapshot.players.find((player) => player.id === "p3")?.role, "Villager");
  assert.equal(villagerSnapshot.players.find((player) => player.id === "p1")?.role, "Hidden");
  assert.equal(villagerSnapshot.players.find((player) => player.id === "p2")?.role, "Hidden");
});

test("lover discussion speech is shared only with the paired lovers", () => {
  const snapshot = {
    round: 1,
    phase: "lover_discussion" as const,
    winner: null,
    players: [
      {
        id: "p1",
        name: "シオン",
        role: "Lover" as const,
        camp: "village" as const,
        persona: "cautious" as const,
        alive: true,
        model: "human",
        memoryCount: 0
      },
      {
        id: "p2",
        name: "ガク",
        role: "Lover" as const,
        camp: "village" as const,
        persona: "logical" as const,
        alive: true,
        model: "demo",
        memoryCount: 0
      },
      {
        id: "p3",
        name: "アカネ",
        role: "Villager" as const,
        camp: "village" as const,
        persona: "logical" as const,
        alive: true,
        model: "demo",
        memoryCount: 0
      }
    ],
    aliveCount: 3,
    werewolfCount: 0,
    villageCount: 3
  };
  const event: GameEvent = {
    id: 1,
    createdAt: "2026-05-21T00:00:00.000Z",
    round: 1,
    phase: "lover_discussion",
    type: "player_speech",
    message: "シオンとガクだけに見える恋人確認。",
    playerId: "p2",
    playerName: "ガク",
    role: "Lover",
    data: { visibility: "lover", loverIds: ["p1", "p2"], speech: "相方確認。" },
    snapshot
  };

  const firstLoverView = redactEventForPlayer(event, "p1");
  assert.equal(firstLoverView.message, event.message);
  assert.equal(firstLoverView.playerName, "ガク");
  assert.equal(firstLoverView.data.speech, "相方確認。");

  const secondLoverView = redactEventForPlayer(event, "p2");
  assert.equal(secondLoverView.message, event.message);

  const outsiderView = redactEventForPlayer(event, "p3");
  assert.equal(outsiderView.data.redacted, true);
  assert.equal(outsiderView.playerName, undefined);

  const loverSnapshot = redactSnapshotForPlayer(snapshot, "p1");
  assert.equal(loverSnapshot.players.find((player) => player.id === "p2")?.role, "Lover");
  assert.equal(loverSnapshot.players.find((player) => player.id === "p3")?.role, "Hidden");
});

test("ended snapshots reveal every role in village and player views", () => {
  const snapshot: GameSnapshot = {
    round: 2,
    phase: "ended",
    winner: "village",
    winnerCamp: "lover",
    winnerIds: ["p1", "p2", "p4"],
    winnerCamps: ["neutral", "lover"],
    winnerGroups: [
      { camp: "neutral", winnerIds: ["p4"], winnerRoles: [{ playerId: "p4", playerName: "マヒロ", role: "Jester" }] },
      { camp: "lover", winnerIds: ["p1", "p2"] }
    ],
    players: [
      {
        id: "p1",
        name: "シオン",
        role: "Lover",
        camp: "village",
        persona: "cautious",
        alive: true,
        model: "demo",
        memoryCount: 0
      },
      {
        id: "p2",
        name: "ガク",
        role: "Lover",
        camp: "village",
        persona: "logical",
        alive: true,
        model: "demo",
        memoryCount: 0
      },
      {
        id: "p4",
        name: "マヒロ",
        role: "Jester",
        camp: "village",
        persona: "trickster",
        alive: false,
        model: "demo",
        memoryCount: 0
      }
    ],
    aliveCount: 2,
    werewolfCount: 0,
    villageCount: 2
  };

  assert.deepEqual(redactSnapshotForVillage(snapshot).players.map((player) => player.role), ["Lover", "Lover", "Jester"]);
  assert.deepEqual(redactSnapshotForPlayer(snapshot, "p1").players.map((player) => player.role), ["Lover", "Lover", "Jester"]);
});

test("player and village views expose vote targets without vote reasons", () => {
  const snapshot = {
    round: 1,
    phase: "voting" as const,
    winner: null,
    players: [
      {
        id: "p1",
        name: "シオン",
        role: "Villager" as const,
        camp: "village" as const,
        persona: "cautious" as const,
        alive: true,
        model: "demo",
        memoryCount: 0
      },
      {
        id: "p2",
        name: "ガク",
        role: "Werewolf" as const,
        camp: "werewolf" as const,
        persona: "logical" as const,
        alive: true,
        model: "demo",
        memoryCount: 0
      },
      {
        id: "p3",
        name: "アカネ",
        role: "Seer" as const,
        camp: "village" as const,
        persona: "logical" as const,
        alive: true,
        model: "human",
        memoryCount: 0
      }
    ],
    aliveCount: 3,
    werewolfCount: 1,
    villageCount: 2
  };
  const voteCast: GameEvent = {
    id: 1,
    createdAt: "2026-05-24T00:00:00.000Z",
    round: 1,
    phase: "voting",
    type: "vote_cast",
    message: "ガクがシオンに投票しました。",
    playerId: "p2",
    playerName: "ガク",
    role: "Werewolf",
    targetId: "p1",
    targetName: "シオン",
    data: { reason: "発言が薄い" },
    snapshot
  };
  const otherPlayerView = redactEventForPlayer(voteCast, "p3");

  assert.equal(otherPlayerView.message, voteCast.message);
  assert.equal(otherPlayerView.playerId, "p2");
  assert.equal(otherPlayerView.targetId, "p1");
  assert.equal(otherPlayerView.data.reason, undefined);

  const ownPlayerView = redactEventForPlayer(voteCast, "p2");
  assert.equal(ownPlayerView.message, voteCast.message);
  assert.equal(ownPlayerView.playerId, "p2");
  assert.equal(ownPlayerView.targetId, "p1");
  assert.equal(ownPlayerView.data.reason, undefined);

  const voteResult: GameEvent = {
    ...voteCast,
    id: 2,
    type: "vote_result",
    message: "投票結果が出ました。",
    playerId: undefined,
    playerName: undefined,
    role: undefined,
    targetId: undefined,
    targetName: undefined,
    data: {
      votes: [{ voterId: "p2", voterName: "ガク", targetId: "p1", targetName: "シオン", reason: "発言が薄い" }],
      modifiers: [{ targetId: "p1", targetName: "シオン", count: 1, sourceId: "p3", sourceName: "アカネ", reason: "raven_marked" }],
      totals: [{ targetId: "p1", targetName: "シオン", count: 1 }]
    }
  };
  const resultPlayerView = redactEventForPlayer(voteResult, "p3");
  assert.deepEqual(resultPlayerView.data.votes, [{ voterId: "p2", voterName: "ガク", targetId: "p1", targetName: "シオン" }]);
  assert.equal(resultPlayerView.data.modifiers, undefined);
  assert.deepEqual(resultPlayerView.data.totals, [{ targetId: "p1", targetName: "シオン", count: 1 }]);

  const resultSpectatorView = redactEventForVillage(voteResult);
  assert.deepEqual(resultSpectatorView.data.votes, [{ voterId: "p2", voterName: "ガク", targetId: "p1", targetName: "シオン" }]);
  assert.equal(resultSpectatorView.data.modifiers, undefined);

  const summaryPlayerView = redactEventForPlayer({ ...voteResult, type: "round_summary" }, "p3");
  assert.deepEqual(summaryPlayerView.data.votes, [{ voterId: "p2", voterName: "ガク", targetId: "p1", targetName: "シオン" }]);
  assert.equal(summaryPlayerView.data.modifiers, undefined);
  assert.deepEqual(summaryPlayerView.data.totals, [{ targetId: "p1", targetName: "シオン", count: 1 }]);
});

test("hunter gets one death shot after vote elimination", async () => {
  const game = createGame();
  const players = setTable(game, [
    { role: "Werewolf", targets: ["p4"] },
    { role: "Seer", targets: ["p4"] },
    { role: "Witch", targets: ["p4"] },
    { role: "Hunter", targets: ["p1", "p1"] },
    { role: "Villager", targets: ["p4"] },
    { role: "Villager", targets: ["p4"] }
  ]);

  const events = await collect(game.runVoting());

  assert.equal(players[3].alive, false);
  assert.equal(players[0].alive, false);
  assert.ok(events.some((event) => event.type === "death" && event.targetId === "p1" && event.data?.cause === "hunter"));
});

test("hunter death shot is consumed only once", async () => {
  const game = createGame();
  const players = setTable(game, [
    { role: "Hunter", alive: false, targets: ["p2", "p3"] },
    { role: "Werewolf" },
    { role: "Villager" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" }
  ]);

  const first = await collect(game.runHunterShot(players[0]));
  const second = await collect(game.runHunterShot(players[0]));

  assert.equal(players[1].alive, false);
  assert.equal(players[2].alive, true);
  assert.equal(first.filter((event) => event.data?.cause === "hunter").length, 1);
  assert.equal(second.filter((event) => event.data?.cause === "hunter").length, 0);
});

test("hunter shot cannot overwrite a simultaneous night death target", async () => {
  const game = createGame();
  const players = setTable(game, [
    { role: "Werewolf", targets: ["p3"] },
    { role: "Witch", decisions: [false], targets: ["p4"] },
    { role: "Hunter", targets: ["p4"] },
    { role: "Villager" },
    { role: "Seer" },
    { role: "Villager" }
  ]);

  const events = await collect(game.runNight());

  assert.equal(players[2].alive, false);
  assert.equal(players[3].alive, false);
  assert.ok(!events.some((event) => event.data?.cause === "hunter" && event.targetId === "p4"));
  assert.ok(events.some((event) => event.type === "death" && event.targetId === "p4" && event.data?.cause === "poison"));
});

test("linked deaths from a death shot cannot overwrite a simultaneous pending death target", async () => {
  const game = createGame();
  const players = setTable(game, [
    { role: "Werewolf", targets: ["p3"] },
    { role: "Witch", decisions: [false], targets: ["p4"] },
    { role: "Hunter", targets: ["p5"] },
    { role: "Villager" },
    { role: "WolfBeauty", targets: ["p3"] },
    { role: "Villager" }
  ]);
  game.ruleState = applyStatusEffects(game.ruleState, [
    { playerId: "p5", addStatuses: [{ kind: "charm_anchor", sourceId: "p5", targetId: "p4", duration: "game" }] }
  ]);

  const events = await collect(game.runNight());

  assert.equal(players[2].alive, false);
  assert.equal(players[3].alive, false);
  assert.equal(players[4].alive, false);
  assert.ok(events.some((event) => event.type === "death" && event.targetId === "p5" && event.data?.cause === "hunter"));
  assert.ok(events.some((event) => event.type === "death" && event.targetId === "p4" && event.data?.cause === "poison"));
  assert.ok(!events.some((event) => event.type === "death" && event.targetId === "p4" && event.data?.cause === "wolf_beauty_charm"));
});

test("AlphaWolf gets the same death-shot path with internal cause data", async () => {
  const game = createGame();
  const players = setTable(game, [
    { role: "Villager", targets: ["p4"] },
    { role: "Seer", targets: ["p4"] },
    { role: "Witch", targets: ["p4"] },
    { role: "AlphaWolf", targets: ["p1", "p1"] },
    { role: "Villager", targets: ["p4"] },
    { role: "Villager", targets: ["p4"] }
  ]);

  const events = await collect(game.runVoting());

  assert.equal(players[3].alive, false);
  assert.equal(players[0].alive, false);
  const alphaWolfDeath = events.find((event) => event.type === "death" && event.targetId === "p1" && event.data?.cause === "alpha_wolf");
  assert.ok(alphaWolfDeath);
  assert.doesNotMatch(alphaWolfDeath.message, /Alpha Wolf|shot|α人狼|アルファ人狼|撃/);
  assert.ok((game.agents.get("p4") as ScriptedAgent).targetInputs.some((input) => input.action === "Alpha Wolf death shot"));
});

test("Lover role links paired lovers and resolves heartbreak deaths", async () => {
  const game = createGame();
  const players = setTable(game, [
    { role: "Werewolf", targets: ["p4"] },
    { role: "Seer", targets: ["p4"] },
    { role: "Witch", targets: ["p4"] },
    { role: "Lover", targets: ["p1"] },
    { role: "Lover", targets: ["p4"] },
    { role: "Villager", targets: ["p4"] }
  ]);
  const context = (game as unknown as { contextFor(player: Player, extra?: string[]): string }).contextFor(players[3]);

  const events = await collect(game.runVoting());

  assert.match(context, new RegExp(`恋人の相方: ${players[4].name}`));
  assert.equal(players[3].alive, false);
  assert.equal(players[4].alive, false);
  const loverDeath = events.find((event) => event.type === "death" && event.targetId === "p5" && event.data?.cause === "lover");
  assert.ok(loverDeath);
  assert.doesNotMatch(loverDeath.message, /Lover|heartbreak|恋人|後を追/);
});

test("WolfBeauty charm creates a linked death when WolfBeauty dies", async () => {
  const game = createGame();
  const players = setTable(game, [
    { role: "WolfBeauty", targets: ["p4", "p2"] },
    { role: "Werewolf", targets: ["p1"] },
    { role: "Witch", targets: ["p1"] },
    { role: "Villager", targets: ["p1"] },
    { role: "Villager", targets: ["p1"] },
    { role: "Villager", targets: ["p1"] }
  ]);

  await collect(game.runWolfBeautyCharmAction(players[0]));
  const wolfBeautyAgent = game.agents.get(players[0].id) as ScriptedAgent;
  assert.ok(wolfBeautyAgent.targetInputs[0].candidates.every((candidate) => candidate.id !== players[0].id));
  assert.ok(wolfBeautyAgent.targetInputs[0].candidates.every((candidate) => candidate.id !== players[1].id));

  const events = await collect(game.runVoting());

  assert.equal(players[0].alive, false);
  assert.equal(players[3].alive, false);
  const charmedDeath = events.find((event) => event.type === "death" && event.targetId === "p4" && event.data?.cause === "wolf_beauty_charm");
  assert.ok(charmedDeath);
  assert.doesNotMatch(charmedDeath.message, /Wolf Beauty|charm|美女狼|魅了/);
});

test("lover victory is exposed as winnerCamp while keeping winner fallback compatible", () => {
  const game = createGame();
  setTable(game, [
    { role: "Lover" },
    { role: "Lover" },
    { role: "Werewolf", alive: false },
    { role: "Villager" },
    { role: "Seer", alive: false },
    { role: "Witch", alive: false }
  ]);

  const result = game.checkVictory();

  assert.equal(result?.winnerCamp, "lover");
  assert.equal(result?.camp, "village");
  assert.deepEqual(result?.winnerIds, ["p1", "p2"]);
});

test("lover victory waits for a real game-end condition", () => {
  const game = createGame();
  setTable(game, [
    { role: "Lover" },
    { role: "Lover" },
    { role: "Werewolf" },
    { role: "Villager" },
    { role: "Seer" },
    { role: "Witch" }
  ]);

  assert.equal(game.checkVictory(), null);
});

test("round-limit adjudication awards lovers when both are alive", async () => {
  const game = createGame();
  setTable(game, [
    { role: "Lover" },
    { role: "Lover" },
    { role: "Werewolf" },
    { role: "Villager" },
    { role: "Seer" },
    { role: "Witch" }
  ]);
  (game as unknown as { round: number }).round = baseConfig.maxRounds;

  const events = await collect(game.run());
  const ended = events.find((event) => event.type === "game_ended");

  assert.equal(ended?.data?.winnerCamp, "lover");
  assert.deepEqual(ended?.data?.winnerIds, ["p1", "p2"]);
});

test("Jester vote death ends as neutral winner while keeping winner fallback compatible", async () => {
  const game = createGame();
  const players = setTable(game, [
    { role: "Werewolf", targets: ["p4"] },
    { role: "Seer", targets: ["p4"] },
    { role: "Witch", targets: ["p4"] },
    { role: "Jester", targets: ["p1"] },
    { role: "Villager", targets: ["p1"] },
    { role: "Villager", targets: ["p2"] }
  ]);

  const events = await collect(game.runVoting());
  const result = game.checkVictory();
  const victoryClaim = events.find((event) => event.type === "system" && event.data?.action === "neutral_victory_claim");

  assert.equal(players[3].alive, false);
  assert.ok(victoryClaim);
  assert.match(victoryClaim.message, /Jester/);
  assert.equal(victoryClaim.data?.sourceRole, "Jester");
  assert.equal(victoryClaim.data?.revealedRole, "Jester");
  assert.equal(victoryClaim.data?.revealedRoleLabel, "Jester");
  assert.deepEqual(victoryClaim.data?.winnerRoles, [{ playerId: "p4", playerName: players[3].name, role: "Jester" }]);
  const villageClaim = redactEventForVillage(victoryClaim);
  assert.equal(villageClaim.data.revealedRole, "Jester");
  assert.equal(villageClaim.data.sourceRole, "Jester");
  assert.equal(result?.winnerCamp, "neutral");
  assert.equal(result?.camp, "village");
  assert.deepEqual(result?.winnerIds, ["p4"]);
  assert.deepEqual(result?.winnerRoles, [{ playerId: "p4", playerName: players[3].name, role: "Jester" }]);
  assert.match(result?.reason ?? "", /Jester/);

  const ended = game.finishGame(result!);
  assert.match(ended.message, /Jester/);
  assert.equal(ended.data?.winner, "village");
  assert.equal(ended.data?.winnerCamp, "neutral");
  assert.deepEqual(ended.data?.winnerIds, ["p4"]);
  assert.deepEqual(ended.data?.winnerRoles, [{ playerId: "p4", playerName: players[3].name, role: "Jester" }]);
  assert.equal(ended.snapshot.winner, "village");
  assert.equal(ended.snapshot.winnerCamp, "neutral");
  assert.deepEqual(ended.snapshot.winnerIds, ["p4"]);
});

test("Jester vote death and living lovers are both exposed as winners", async () => {
  const game = createGame();
  const players = setTable(game, [
    { role: "Lover", targets: ["p4"] },
    { role: "Lover", targets: ["p4"] },
    { role: "Werewolf", targets: ["p4"] },
    { role: "Jester", targets: ["p1"] },
    { role: "Villager", targets: ["p4"] },
    { role: "Villager", targets: ["p4"] }
  ]);

  await collect(game.runVoting());
  const result = game.checkVictory();

  assert.equal(players[3].alive, false);
  assert.equal(result?.winnerCamp, "lover");
  assert.deepEqual(result?.winnerCamps, ["neutral", "lover"]);
  assert.deepEqual(result?.winnerIds, ["p4", "p1", "p2"]);
  assert.deepEqual(result?.winnerGroups, [
    {
      camp: "neutral",
      winnerIds: ["p4"],
      winnerRoles: [{ playerId: "p4", playerName: players[3].name, role: "Jester" }]
    },
    { camp: "lover", winnerIds: ["p1", "p2"] }
  ]);

  const ended = game.finishGame(result!);
  assert.match(ended.message, /Jester/);
  assert.match(ended.message, /lover/);
  assert.deepEqual(ended.data?.winnerCamps, ["neutral", "lover"]);
  assert.deepEqual(ended.snapshot.winnerGroups, result?.winnerGroups);
});

test("guard success debug scenario forces an observable protected night", async () => {
  const game = new WerewolfGame({
    ...baseConfig,
    playerCount: 6,
    debugScenario: "guard_success"
  }) as TestableGame;

  const events = await collect(game.runNight());

  assert.equal(game.players.length, 8);
  assert.ok(events.some((event) => event.type === "private_info" && event.data?.action === "guard_success"));
  assert.ok(events.some((event) => event.type === "death" && event.data?.cause === "no_death"));
});

test("hunter shot debug scenario forces an observable night shot", async () => {
  const game = new WerewolfGame({
    ...baseConfig,
    playerCount: 6,
    debugScenario: "hunter_shot"
  }) as TestableGame;

  const events = await collect(game.runNight());

  assert.equal(game.players.length, 9);
  assert.equal(game.players[2].alive, false);
  assert.equal(game.players[0].alive, false);
  const hunterDeath = events.find((event) => event.type === "death" && event.data?.cause === "hunter" && event.targetId === "p1");
  assert.ok(hunterDeath);
  assert.doesNotMatch(hunterDeath.message, /Hunter|shot|ハンター|撃/);
});

test("public death events keep target roles in data for village-view redaction", async () => {
  const game = createGame();
  setTable(game, [
    { role: "Werewolf", targets: ["p4"] },
    { role: "Seer", targets: ["p4"] },
    { role: "Witch", targets: ["p4"] },
    { role: "Hunter", targets: ["p1"] },
    { role: "Villager", targets: ["p4"] },
    { role: "Villager", targets: ["p4"] }
  ]);

  const events = await collect(game.runVoting());
  const deathEvents = events.filter((event) => event.type === "death" && typeof event.data?.targetRole === "string");

  assert.ok(deathEvents.length >= 2);
  for (const event of deathEvents) {
    const role = String(event.data?.targetRole);
    assert.ok(!event.message.includes(role));
    assert.doesNotMatch(event.message, /Hunter|Alpha Wolf|Wolf Beauty|heartbreak|shot|charm|ハンター|α人狼|アルファ人狼|美女狼|恋人|撃|魅了/);
  }
});

test("village redaction helper removes public target role payloads", async () => {
  const game = createGame();
  setTable(game, [
    { role: "Werewolf", targets: ["p4"] },
    { role: "Seer", targets: ["p4"] },
    { role: "Witch", targets: ["p4"] },
    { role: "Hunter", targets: ["p1"] },
    { role: "Villager", targets: ["p4"] },
    { role: "Villager", targets: ["p4"] }
  ]);

  const events = await collect(game.runVoting());
  const publicDeath = events.find((event) => event.type === "death" && typeof event.data?.targetRole === "string");

  assert.ok(publicDeath);
  const redacted = redactEventForVillage(publicDeath);

  assert.equal(redacted.message, publicDeath.message);
  assert.equal(redacted.data.targetRole, undefined);
  assert.equal(redacted.data.cause, undefined);
  assert.equal(redacted.data.sourceId, undefined);
  assert.equal(redacted.data.sourceName, undefined);
  assert.equal(redacted.role, undefined);
  assert.equal(redacted.snapshot.players.every((player) => player.role === "Hidden"), true);

  const playerView = redactEventForPlayer(publicDeath, "p1");
  assert.equal(playerView.data.targetRole, undefined);
  assert.equal(playerView.data.cause, undefined);
  assert.equal(playerView.data.sourceId, undefined);
});

test("LLM target selection retries malformed JSON and falls back to a random legal target", async () => {
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "not-json" }]
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  }) as typeof fetch;
  Math.random = () => 0.99;

  try {
    const game = createGame();
    const [player] = setTable(game, [{ role: "Villager" }]);
    const agent = new AnthropicAgent("llm", createTestAnthropicClient(), "test-model", "English", 1024);

    const decision = await agent.chooseTarget({
      player,
      phase: "voting",
      action: "Vote",
      context: "Pick a target.",
      candidates: [
        { id: "p1", name: "Ada" },
        { id: "p2", name: "Byron" }
      ],
      allowSkip: false
    });

    assert.equal(decision.targetId, "p2");
    assert.match(decision.reason, /対象選択JSONが不正/);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
  }
});

test("aborted LLM requests release queue slots even when fetch does not settle", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    if (calls <= 5) {
      return new Promise<Response>(() => undefined);
    }
    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: "Byron needs pressure before I move my vote."
          }
        ]
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  }) as typeof fetch;

  try {
    const game = createGame();
    const [player] = setTable(game, [{ role: "Villager" }]);
    const agent = new AnthropicAgent("llm", createTestAnthropicClient(), "test-model", "English", 1024);
    const knownPlayers = [
      { id: "p1", name: "Ada" },
      { id: "p2", name: "Byron" }
    ];
    const input = (abortSignal?: AbortSignal): AgentSpeechInput => ({
      player,
      phase: "day_discussion",
      task: "Make a public statement.",
      context: "Public context.",
      knownPlayers,
      legalPlayers: knownPlayers,
      publicHistory: [],
      privateHistory: [],
      abortSignal
    });
    const controllers = Array.from({ length: 5 }, () => new AbortController());
    const blocked = controllers.map((controller) => agent.speak(input(controller.signal)).catch((error: unknown) => error));

    await waitUntil(() => calls === 5);
    const releasedSlotSpeech = agent.speak(input());
    controllers.forEach((controller) => {
      controller.abort();
    });

    const speech = await Promise.race([
      releasedSlotSpeech,
      sleepWithAbort(250).then(() => {
        throw new Error("Queued LLM request did not start after aborts.");
      })
    ]);
    const abortedResults = await Promise.all(blocked);

    assert.equal(speech.messages.length, 1);
    assert.match(speech.messages[0], /Byron/i);
    assert.match(speech.messages[0], /suspicion|pressure|vote|answer|tested/i);
    assert.equal(calls, 6);
    assert.equal(
      abortedResults.every((result) => result instanceof Error && result.message.includes("cancelled")),
      true
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Japanese LLM target decision renders the vote reason in code", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.match(body.system, /対象選択/);
    assert.match(body.system, /返すのは対象 ID だけ/);
    assert.doesNotMatch(body.system, /Role strategy|Phase guidance|Prompt mode|pressure|record|history|slot/i);
    assert.match(String(body.messages[0].content), /行動:/);
    assert.match(String(body.messages[0].content), /選べる対象:/);
    assert.doesNotMatch(String(body.messages[0].content), /Action:|Legal targets:/);
    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              targetId: "p2",
              reasonKind: "claim_reaction"
            })
          }
        ]
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  }) as typeof fetch;

  try {
    const game = createGame();
    const [player] = setTable(game, [{ role: "Villager" }]);
    const agent = new AnthropicAgent("llm", createTestAnthropicClient(), "test-model", "Japanese", 1024);

    const decision = await agent.chooseTarget({
      player,
      phase: "voting",
      action: "昼の処刑投票",
      context: "投票理由の前提:\n今日の発言から投票先を選んでください。",
      candidates: [
        { id: "p2", name: "サクラコ" },
        { id: "p3", name: "アカネ" }
      ],
      allowSkip: false
    });

    assert.equal(decision.targetId, "p2");
    assert.equal(decision.reasonKind, "claim_reaction");
    assert.equal(decision.reason, "サクラコは役職主張への反応がはっきりしないためです。");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM public speech uses a single simple speech request", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];

  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const userContent = String((body.messages as Array<{ content: string }>)[0]?.content ?? "");
    assert.equal(body.model, "test-model");
    assert.equal((body.messages as Array<{ role: string }>)[0]?.role, "user");
    assert.match(String(body.system), /これまでの会話と自分の役職/);
    assert.doesNotMatch(String(body.system), /reasoning metadata|public-safe facts|Return strict JSON only/);
    assert.match(userContent, /公開文脈/);
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "ノゾミの発言が変わったので、ここは怪しいです。" }]
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  }) as typeof fetch;

  try {
    const game = createGame();
    const [player] = setTable(game, [{ role: "Villager" }]);
    const agent = new AnthropicAgent("llm", createTestAnthropicClient(), "test-model", "Japanese", 1024);

    const speech = await agent.speak({
      player,
      phase: "day_discussion",
      task: "発言してください。",
      context: "公開文脈: 主張と読みがあります。",
      knownPlayers: [
        { id: "p1", name: "セナ" },
        { id: "p2", name: "ノゾミ" }
      ],
      publicHistory: [],
      privateHistory: []
    });

    assert.equal(bodies.length, 1);
    assert.deepEqual(speech.messages, ["ノゾミの発言が変わったので、ここは怪しいです"]);
    assert.equal(speech.metadata.suspects[0]?.targetId, "p2");
    assert.deepEqual(speech.metadata.trusts, []);
    assert.deepEqual(speech.metadata.claims, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM public speech normalizes self-name wording and strips trailing read labels", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: "お前ら対抗出た瞬間にガク吊る話止まって、どっち吊るかで揉めてるだろ。コハルのタイミング疑ってたのどこ行ったんだよ 疑い先: コハル"
          }
        ]
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  }) as typeof fetch;

  try {
    const gakuProfile = characterProfiles.find((profile) => profile.nameJa === "ガク");
    assert.ok(gakuProfile);
    const gaku: Player = {
      id: gakuProfile.playerId,
      name: gakuProfile.nameJa,
      role: "Villager",
      camp: "village",
      persona: gakuProfile.persona,
      alive: true,
      model: "llm",
      memories: [],
      seerResults: {},
      seerResultRounds: {},
      witch: { savePotion: false, poisonPotion: false },
      characterProfile: gakuProfile
    };
    const koharu = characterProfiles.find((profile) => profile.nameJa === "コハル");
    assert.ok(koharu);
    const agent = new AnthropicAgent("llm", createTestAnthropicClient(), "test-model", "Japanese", 1024);

    const speech = await agent.speak({
      player: gaku,
      phase: "day_discussion",
      task: "昼議論で発言してください。",
      context: "公開文脈: コハルのCOタイミングが議論されています。",
      knownPlayers: [
        { id: gaku.id, name: gaku.name },
        { id: koharu.playerId, name: koharu.nameJa }
      ],
      legalPlayers: [{ id: koharu.playerId, name: koharu.nameJa }],
      publicHistory: [],
      privateHistory: []
    });

    assert.equal(calls, 1);
    assert.deepEqual(speech.messages, [
      "お前ら対抗出た瞬間に俺を吊る話止まって、どっち吊るかで揉めてるだろ",
      "コハルのタイミング疑ってたのどこ行ったんだよ"
    ]);
    assert.doesNotMatch(speech.messages.join(" "), /疑い先:/);
    assert.equal(speech.metadata.suspects[0]?.targetId, koharu.playerId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM public speech keeps model wording directly without surface-stage filtering", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "Curie also looks suspicious from that exchange." }]
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  }) as typeof fetch;

  try {
    const game = createGame();
    const [player] = setTable(game, [{ role: "Villager" }]);
    const agent = new AnthropicAgent("llm", createTestAnthropicClient(), "test-model", "English", 1024);

    const speech = await agent.speak({
      player,
      phase: "day_discussion",
      task: "Speak.",
      context: "Public context.",
      knownPlayers: [
        { id: "p1", name: "Ada" },
        { id: "p2", name: "Byron" },
        { id: "p3", name: "Curie" }
      ],
      publicHistory: [],
      privateHistory: []
    });

    assert.equal(calls, 1);
    assert.deepEqual(speech.messages, ["Curie also looks suspicious from that exchange."]);
    assert.equal(speech.metadata.suspects[0]?.targetId, "p3");
    assert.deepEqual(speech.metadata.trusts, []);
    assert.deepEqual(speech.metadata.claims, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM public speech recovers a message field from accidental JSON output", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify({ message: "リンタロウは占い結果への反応が少し引っかかります" })
          }
        ]
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  }) as typeof fetch;

  try {
    const game = createGame();
    const [player] = setTable(game, [{ role: "Villager" }]);
    const agent = new AnthropicAgent("llm", createTestAnthropicClient(), "test-model", "Japanese", 1024);

    const speech = await agent.speak({
      player,
      phase: "day_discussion",
      task: "昼議論で発言してください。",
      context: "アキオミが占い師を主張し、キリエを人間側だと言った。リンタロウがキリエを疑っている。",
      knownPlayers: [
        { id: "p1", name: "アキオミ" },
        { id: "p2", name: "キリエ" },
        { id: "p3", name: "リンタロウ" }
      ],
      publicHistory: [],
      privateHistory: []
    });

    assert.equal(calls, 1);
    assert.deepEqual(speech.messages, ["リンタロウは占い結果への反応が少し引っかかります"]);
    assert.equal(speech.metadata.suspects[0]?.targetId, "p3");
    assert.deepEqual(speech.metadata.trusts, []);
    assert.deepEqual(speech.metadata.claims, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM speech rate limits wait before retrying", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalZaiTimeout = process.env.ZAI_TIMEOUT_MS;
  const originalLlmTimeout = process.env.LLM_TIMEOUT_MS;
  let calls = 0;
  const backoffDelays: number[] = [];

  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "rate_limit_error",
            message: "rate limit reached"
          }
        }),
        {
          status: 429,
          headers: { "Content-Type": "application/json" }
        }
      );
    }
    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: "Byron needs pressure before I move my vote."
          }
        ]
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  }) as typeof fetch;
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number) => {
    if (timeout === 1_000 || timeout === 2_000 || timeout === 4_000) {
      backoffDelays.push(timeout);
    }
    return originalSetTimeout(handler, 0);
  }) as typeof setTimeout;
  process.env.ZAI_TIMEOUT_MS = "60000";
  process.env.LLM_TIMEOUT_MS = "60000";

  try {
    const game = createGame();
    const [player] = setTable(game, [{ role: "Villager" }]);
    const client = new Anthropic({
      apiKey: "test-key",
      baseURL: "https://example.test",
      timeout: 60_000,
      maxRetries: 0
    });
    const agent = new AnthropicAgent("llm", client, "test-model", "English", 1024);
    const knownPlayers = [
      { id: "p1", name: "Ada" },
      { id: "p2", name: "Byron" }
    ];

    const speech = await agent.speak({
      player,
      phase: "day_discussion",
      task: "Make a public statement.",
      context: "Public context.",
      knownPlayers,
      legalPlayers: knownPlayers,
      publicHistory: [],
      privateHistory: []
    });

    assert.equal(speech.messages.length, 1);
    assert.match(speech.messages[0], /Byron/i);
    assert.match(speech.messages[0], /suspicion|pressure|vote|answer|tested/i);
    assert.equal(calls, 2);
    assert.deepEqual(backoffDelays, [1_000]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    restoreEnvVar("ZAI_TIMEOUT_MS", originalZaiTimeout);
    restoreEnvVar("LLM_TIMEOUT_MS", originalLlmTimeout);
  }
});

test("LLM speech rate limit falls back without surfacing raw API errors", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalZaiTimeout = process.env.ZAI_TIMEOUT_MS;
  const originalLlmTimeout = process.env.LLM_TIMEOUT_MS;
  let calls = 0;
  const backoffDelays: number[] = [];

  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "rate_limit_error",
          code: "1302",
          message: "[1302][Rate limit reached for requests][test-request]"
        },
        request_id: "test-request"
      }),
      {
        status: 429,
        headers: { "Content-Type": "application/json" }
      }
    );
  }) as typeof fetch;
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number) => {
    if (timeout === 1_000 || timeout === 2_000 || timeout === 4_000) {
      backoffDelays.push(timeout);
    }
    return originalSetTimeout(handler, 0);
  }) as typeof setTimeout;
  process.env.ZAI_TIMEOUT_MS = "60000";
  process.env.LLM_TIMEOUT_MS = "60000";

  try {
    const game = createGame();
    const [player] = setTable(game, [{ role: "Villager" }]);
    game.agents.set(player.id, new AnthropicAgent("llm", createTestAnthropicClient(), "test-model", "English", 1024));

    const events = await collect(game.runDay());
    const visibleText = events.map((event) => event.message).join("\n");
    const memoryText = player.memories.join("\n");

    assert.equal(calls % 4, 0);
    assert.ok(calls >= 4);
    assert.ok(backoffDelays.includes(1_000));
    assert.ok(backoffDelays.includes(2_000));
    assert.ok(backoffDelays.includes(4_000));
    assert.ok(events.some((event) => event.type === "player_speech" && event.playerId === player.id));
    assert.doesNotMatch(visibleText, /429|rate_limit_error|request_id|1302|test-request/i);
    assert.doesNotMatch(memoryText, /rate_limit_error|request_id|test-request/i);
    assert.match(memoryText, /rate limit/i);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    restoreEnvVar("ZAI_TIMEOUT_MS", originalZaiTimeout);
    restoreEnvVar("LLM_TIMEOUT_MS", originalLlmTimeout);
  }
});

test("LLM speech recovers message strings from accidental JSON output", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              messages: ["方針: サクラコへの疑いを強める。", "実際の発話: サクラコは投票理由が薄いので疑い寄りで見ます。"],
              suspects: [{ targetId: "p2", reason: "投票理由がまだ弱い", weight: 0.6, evidence: { kind: "weak_reason" } }]
            })
          }
        ]
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  }) as typeof fetch;

  try {
    const game = createGame();
    const [player] = setTable(game, [{ role: "Villager" }]);
    const agent = new AnthropicAgent("llm", createTestAnthropicClient(), "test-model", "Japanese", 1024);

    const speech = await agent.speak({
      player,
      phase: "day_discussion",
      task: "昼議論で発言してください。",
      context: "議論してください。",
      knownPlayers: [
        { id: "p1", name: "シオン" },
        { id: "p2", name: "サクラコ" }
      ],
      publicHistory: [],
      privateHistory: []
    });

    assert.equal(calls, 1);
    assert.deepEqual(speech.messages, ["サクラコは投票理由が薄いので疑い寄りで見ます"]);
    assert.equal(speech.metadata.suspects[0]?.targetId, "p2");
    assert.deepEqual(speech.metadata.trusts, []);
    assert.deepEqual(speech.metadata.claims, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM plain speech is accepted directly with empty metadata", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "plain speech without json" }]
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  }) as typeof fetch;

  try {
    const game = createGame();
    const [player] = setTable(game, [{ role: "Villager" }]);
    const agent = new AnthropicAgent("llm", createTestAnthropicClient(), "test-model", "English", 1024);

    const speech = await agent.speak({
      player,
      phase: "day_discussion",
      task: "Speak.",
      context: "Discuss.",
      knownPlayers: [
        { id: "p1", name: "Ada" },
        { id: "p2", name: "Byron" }
      ],
      publicHistory: [],
      privateHistory: []
    });

    assert.equal(calls, 1);
    assert.deepEqual(speech.messages, ["plain speech without json"]);
    assert.deepEqual(speech.metadata, { suspects: [], trusts: [], claims: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM truncated speech reasoning JSON uses fallback without leaking JSON syntax", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: "{\"messages\":[\"シオンの言う通り、初日は情報が少ないから無理に決めない方がいいだろ\",\"でも、誰か占"
          }
        ]
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  }) as typeof fetch;

  try {
    const game = createGame();
    const [player] = setTable(game, [{ role: "Villager" }]);
    const agent = new AnthropicAgent("llm", createTestAnthropicClient(), "test-model", "Japanese", 1024);

    const speech = await agent.speak({
      player,
      phase: "day_discussion",
      task: "昼議論で発言してください。",
      context: "議論してください。",
      knownPlayers: [
        { id: "p1", name: "シオン" },
        { id: "p2", name: "ガク" }
      ],
      publicHistory: [],
      privateHistory: []
    });

    assert.equal(speech.messages.length, 1);
    assert.doesNotMatch(speech.messages.join(" "), /messages|^\{|```/);
    assert.deepEqual(speech.metadata, { suspects: [], trusts: [], claims: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM unrecoverable speech JSON uses simple fallback instead of raw schema text", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "{\"messages\":[" }]
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  }) as typeof fetch;

  try {
    const game = createGame();
    const [player] = setTable(game, [{ role: "Villager" }]);
    const agent = new AnthropicAgent("llm", createTestAnthropicClient(), "test-model", "Japanese", 1024);

    const speech = await agent.speak({
      player,
      phase: "day_discussion",
      task: "昼議論で発言してください。",
      context: "現在のフェーズ: 昼議論。ラウンド: 1。",
      knownPlayers: [
        { id: "p1", name: "シオン" },
        { id: "p2", name: "レン" }
      ],
      publicHistory: [],
      privateHistory: []
    });

    assert.equal(speech.messages.length, 1);
    assert.doesNotMatch(speech.messages[0], /messages|^\{|```/);
    assert.doesNotMatch(speech.messages[0], /。$/);
    assert.ok(speech.messages[0].length > 0);
    assert.deepEqual(speech.metadata, { suspects: [], trusts: [], claims: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM provider without API key emits a warning event before falling back to demo agents", async () => {
  const originalZaiApiKey = process.env.ZAI_API_KEY;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  delete process.env.ZAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    const game = new WerewolfGame({ ...baseConfig, provider: "llm", model: "test-model" });
    const run = game.run();
    const started = await run.next();
    const warning = await run.next();
    await run.return(undefined);

    assert.equal(started.value?.type, "game_started");
    assert.equal(warning.value?.type, "warning");
    assert.match(warning.value?.message ?? "", /ZAI_API_KEY|OPENAI_API_KEY/);
  } finally {
    restoreEnvVar("ZAI_API_KEY", originalZaiApiKey);
    restoreEnvVar("OPENAI_API_KEY", originalOpenAiApiKey);
  }
});
