import assert from "node:assert/strict";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicAgent, DemoAgent, summarizeRoundWithLlm } from "../src/game/agents";
import { characterNames, characterProfiles } from "../src/game/characters";
import { WerewolfGame } from "../src/game/engine";
import { HumanInputAgent } from "../src/game/humanAgent";
import { redactEventForPlayer, redactEventForVillage, redactSnapshotForPlayer } from "../src/game/redaction";
import { createRoles, maxSupportedPlayers } from "../src/game/rules/presets";
import { roleCamp } from "../src/game/rules/roles";
import { applyStatusEffects, createInitialRuleState } from "../src/game/rules/state";
import type { RuleState } from "../src/game/rules/types";
import { firstDayOpeningMoveKinds, firstDayWerewolfOpeningMoveKinds } from "../src/game/speechPlanning";
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
  SpeechGenerationDiagnostic,
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
  checkVictory(): { camp: Camp; winnerCamp: CampId; winnerIds: string[]; reason: string } | null;
  emitRoundSummary(): Promise<GameEvent>;
  finishGame(result: { camp: Camp; winnerCamp?: CampId; winnerIds?: string[]; reason: string }): GameEvent;
  players: Player[];
  publicHistory: string[];
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

test("Japanese demo Seer keeps a first-day white result hidden", async () => {
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

  assert.equal(speech.metadata.claims.some((claim) => claim.role === "Seer"), false);
  const messageText = speech.messages.join(" ");
  assert.doesNotMatch(messageText, /占い師を名乗ります|判定/);
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
  assert.match(firstAgent.speechInputs[0].context, /Discussion pass 1 of 2/);
  assert.match(firstAgent.speechInputs[1].context, /Second pass: if needed, answer direct pressure/);
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
    assert.match(agent.speechInputs[0].context, /初日特別モード/);
    // The second pass no longer carries an opening move.
    assert.equal(agent.speechInputs[1].speechPlan?.firstDayOpeningMove, undefined);
    assignedKinds.push(kind as string);
  }

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

test("day discussion context includes structured public knowledge after night deaths", async () => {
  const game = new WerewolfGame({ ...baseConfig, language: "Japanese" }) as TestableGame;
  const players = setTable(game, [
    { role: "Werewolf", targets: ["p2"] },
    { role: "Villager" },
    { role: "Seer", targets: ["p1"] },
    { role: "Witch", targets: [null], decisions: [false] },
    { role: "Villager" },
    { role: "Villager" }
  ]);

  await collect(game.runNight());
  await collect(game.runDay());

  const firstWolf = game.agents.get(players[0].id) as ScriptedAgent;
  const dayInput = firstWolf.speechInputs.find((input) => input.phase === "day_discussion");
  assert.ok(dayInput);
  assert.equal(dayInput.speechPlan?.requiresForwardMove, true);
  assert.match(dayInput.context, /公開知識/);
  assert.match(dayInput.context, new RegExp(`昨夜の死亡: ${players[1].name}`));
  assert.match(dayInput.context, /公開上の死因: 不明/);
  assert.match(dayInput.context, /魔女の毒薬/);
  assert.match(dayInput.context, /死因候補を並べるだけで終わらず/);
});

test("speech diagnostics record review retries and reasons", async () => {
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

  await collect(game.runDay());

  const rejected = diagnostics.find((diagnostic) => diagnostic.kind === "speech_review_rejected" && diagnostic.playerId === players[0].id);
  assert.ok(rejected);
  assert.deepEqual(rejected.speechPlanIssues, ["speech stops at night-death recap without a visible stance"]);
  assert.equal(rejected.attempts, 1);
  assert.equal(diagnostics.filter((diagnostic) => diagnostic.kind === "speech_retry_accepted" && diagnostic.playerId === players[0].id).length, 1);
  assert.ok(diagnostics.some((diagnostic) => diagnostic.kind === "speech_completed" && diagnostic.playerId === players[0].id && diagnostic.retried));
});

test("speech diagnostics reject unseen prior statements on quiet first day", async () => {
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

  await collect(game.runDay());

  const rejected = diagnostics.find((diagnostic) => diagnostic.kind === "speech_review_rejected" && diagnostic.playerId === players[0].id);
  assert.ok(rejected);
  assert.deepEqual(rejected.timelineIssues, ["speech cites unseen prior public speech or action"]);
  assert.equal(rejected.attempts, 1);
  assert.ok(diagnostics.some((diagnostic) => diagnostic.kind === "speech_retry_accepted" && diagnostic.playerId === players[0].id));
});

test("speech retry rejection uses guarded first-day fallback instead of passive output", async () => {
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
  assert.doesNotMatch(firstPassSpeech.message, /様子見|保留|状況が見えない/);
  assert.match(firstPassSpeech.message, /投票基準|名乗る条件|投票候補|理由/);
  assert.ok(diagnostics.some((diagnostic) => diagnostic.kind === "speech_retry_rejected" && diagnostic.playerId === players[0].id));
  assert.ok(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.kind === "speech_completed" && diagnostic.playerId === players[0].id && diagnostic.retried && diagnostic.reviewOk
    )
  );
});

test("guarded speech fallback does not accuse the first legal target without visible context", () => {
  const game = new WerewolfGame({ ...baseConfig, language: "Japanese" }) as TestableGame;
  const players = setTable(game, [{ role: "Villager" }, { role: "Werewolf" }, { role: "Seer" }]);
  const fallbackGame = game as unknown as {
    reviewedSpeechFallback(input: AgentSpeechInput, legalPlayers: TargetCandidate[], speechPlan?: PublicSpeechPlan): AgentSpeech;
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

  const visibleTargetSpeech = fallbackGame.reviewedSpeechFallback(
    {
      ...baseInput,
      publicHistory: [`${players[2].name}: 占い師の名乗りは結果を見てから信じたいです。`]
    },
    legalPlayers,
    plan
  );
  assert.match(visibleTargetSpeech.messages[0], new RegExp(players[2].name));
  assert.doesNotMatch(visibleTargetSpeech.messages[0], new RegExp(players[1].name));
  assert.equal(visibleTargetSpeech.metadata.suspects[0]?.targetId, players[2].id);

  const noTargetSpeech = fallbackGame.reviewedSpeechFallback(baseInput, legalPlayers, plan);
  assert.doesNotMatch(noTargetSpeech.messages[0], new RegExp(players[1].name));
  assert.match(noTargetSpeech.messages[0], /役職主張|信用寄り/);
  assert.deepEqual(noTargetSpeech.metadata.suspects, []);
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

test("lightweight agenda scheduler drives day one without omniscient directives", async () => {
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
  assert.ok(
    allContexts.some((context) => context.includes("Discussion agenda")),
    "day speech should receive the deterministic agenda scheduler context"
  );
  assert.ok(
    allContexts.some((context) => context.includes("First-day opening mode")),
    "round one should still assign first-day opening sparks"
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
  runWerewolfFaceoffPass(): AsyncGenerator<GameEvent>;
};

test("first-day werewolf face-off: every AI wolf greets the team and owns their role, secret to the camp", async () => {
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

  // Only the werewolf-camp members speak, each via the dedicated werewolf-intro path.
  assert.deepEqual(
    new Set(speeches.map((event) => event.playerId)),
    new Set(wolves.map((player) => player.id)),
    "every werewolf-camp member introduces themselves, and no villager does"
  );
  assert.ok(
    speeches.every((event) => typeof event.message === "string" && event.message.startsWith("WOLF-INTRO ")),
    "the dedicated werewolf-intro path is used (not the public warm-up or speak())"
  );
  // The role is owned in the line — AlphaWolf/WolfBeauty/Werewolf each name themselves.
  assert.ok(speeches.some((event) => event.message.includes("AlphaWolf")));
  assert.ok(speeches.some((event) => event.message.includes("WolfBeauty")));
  assert.ok(speeches.some((event) => event.message.includes("Werewolf")));

  // The whole meeting is werewolf-visibility and announced with a secret phase change.
  assert.ok(speeches.every((event) => event.data?.visibility === "werewolf"), "intros are werewolf-visibility");
  const phaseChange = events.find((event) => event.type === "phase_changed");
  assert.ok(phaseChange && phaseChange.data?.visibility === "werewolf", "the opening banner is secret to the camp");

  // Redaction: a villager sees nothing; a werewolf-camp viewer sees the real lines.
  const villager = players.find((player) => player.camp === "village")!;
  for (const event of speeches) {
    const villagerView = redactEventForPlayer(event, villager.id);
    assert.equal(villagerView.message, redactEventForVillage(event).message);
    assert.doesNotMatch(villagerView.message, /WOLF-INTRO/, "villagers must not see the werewolf face-off");
    const wolfView = redactEventForPlayer(event, wolves[0].id);
    assert.match(wolfView.message, /WOLF-INTRO/, "any werewolf-camp viewer sees the face-off");
  }
});

test("first-day werewolf face-off offers a human werewolf greeting without blocking later generation", async () => {
  const requests: HumanInputRequestPayload[] = [];
  const greetingGate = createDeferred<{ speech: string }>();
  const humanInput: HumanInputHandler = {
    async request(input) {
      requests.push(input);
      if (input.kind === "speech_choice") {
        return greetingGate.promise;
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

  const events = await Promise.race([
    collect(game.runWerewolfFaceoffPass()),
    sleepWithAbort(250).then(() => {
      throw new Error("The werewolf face-off waited for the optional human greeting.");
    })
  ]);
  const speeches = events.filter((event) => event.type === "player_speech");
  const speakerIds = new Set(speeches.map((event) => event.playerId));
  const greetingRequest = requests.find((request) => request.kind === "speech_choice" && request.speechMode === "werewolf_greeting");

  assert.equal(speakerIds.has(players[0].id), false, "the human greeting prompt must not hold the face-off event stream open");
  assert.ok(speakerIds.has(players[1].id), "the AI ally still introduces itself so the human learns the team");
  assert.equal(speakerIds.size, 1, "only generated AI face-off lines are emitted synchronously");
  assert.ok(greetingRequest);
  assert.equal(greetingRequest.nonBlocking, true);
  assert.equal(greetingRequest.options.length, 0, "the face-off prompt is free-input only");
  assert.match(greetingRequest.task, /挨拶/);
  assert.ok(greetingRequest.context.notes.every((line) => !line.includes("以降の推理・作戦・展開には使われません")));
  assert.equal(game.wolfHistory.length, 1, "only the AI ally's generated intro is retained for later wolf context");
  assert.ok(game.wolfHistory.every((line) => !line.includes("よろしく、仲間として合わせます")));
  greetingGate.resolve({ speech: "  よろしく、仲間として合わせます。  " });
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
  const faceoffIndex = events.findIndex((event) => event.type === "player_speech" && String(event.message).startsWith("WOLF-INTRO"));
  const dayBeginsIndex = events.findIndex((event) => event.type === "phase_changed" && /begins|始まりました/.test(String(event.message)));

  assert.ok(faceoffIndex >= 0, "the werewolf face-off runs on the first day's opening");
  assert.ok(dayBeginsIndex >= 0, "the public day still opens");
  assert.ok(faceoffIndex < dayBeginsIndex, "the secret werewolf meeting precedes the public day");
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

  assert.ok(warmups.length > 0, "LLM day one still emits day-zero warm-up greetings");
  assert.ok(firstRegular, "regular day discussion still follows warm-up");
  assert.ok(firstSpeechInput, "the first regular speech is generated");
  assert.match(firstSpeechInput.context, /No prior public statements are included/);
  assert.doesNotMatch(firstSpeechInput.context, /INTRO /, "warm-up lines must not be visible discussion evidence");
});

test("first real day speech generation starts before the first streamed game event", async () => {
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
  for (const player of players) {
    game.agents.set(
      player.id,
      new BlockingIntroAgent(player.name, introGate.promise, (playerId) => speakStarted.resolve(playerId))
    );
  }

  const iterator = game.run();
  const firstEvent = await iterator.next();
  const startedPlayerId = await Promise.race([
    speakStarted.promise,
    sleepWithAbort(100).then(() => "timeout")
  ]);

  assert.equal(firstEvent.value?.type, "game_started");
  assert.equal(startedPlayerId, players[0].id, "the first real day speech starts as soon as the game stream opens");
  introGate.resolve();
  await iterator.return?.(undefined);
});

test("first real day speech prefetch skips a p1 human and starts with an AI speaker", async () => {
  const introGate = createDeferred<void>();
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
      new BlockingIntroAgent(player.name, introGate.promise, (playerId) => speakStarted.resolve(playerId))
    );
  }

  const iterator = game.run();
  const firstEvent = await iterator.next();
  const startedPlayerId = await Promise.race([
    speakStarted.promise,
    sleepWithAbort(100).then(() => "timeout")
  ]);

  assert.equal(firstEvent.value?.type, "game_started");
  assert.equal(startedPlayerId, players[1].id, "the opening day prefetch must use the first AI speaker, not the p1 human");
  introGate.resolve();
  await iterator.return?.(undefined);
});

test("day-1 warm-up overlaps the first real discussion speech generation", async () => {
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
  const startedPlayerId = await Promise.race([
    speakStarted.promise,
    sleepWithAbort(100).then(() => "timeout")
  ]);
  assert.equal(startedPlayerId, players[0].id, "the first real day speech starts before warm-up intros finish");

  introGate.resolve();
  const warmup = await pendingWarmup;
  assert.equal(warmup.value?.data?.warmup, true);
  await iterator.return?.(undefined);
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
  assert.match(pressuredAgent.speechInputs[2].context, /Follow-up pass for selected speakers/);
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

  assert.ok(requests.some((request) => request.kind === "speech_choice" && request.options.length > 0));
  assert.ok(humanSpeechEvents.some((event) => event.message === "自分の言葉で話します"));
});

test("human werewolf first-day forced opening must use a drafted deception choice", async () => {
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
  assert.equal(firstSpeechRequest.allowFreeText, false);
  assert.ok(firstHumanSpeech);
  assert.notEqual(firstHumanSpeech.message, "今日は普通に様子見します");
  assert.match(firstHumanSpeech.message, /人間側|占い師/);
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
    assert.match(body.system, /plain English for spectators/);
    assert.equal(body.messages[0].role, "user");
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: JSON.stringify({ summary: "Votes tightened around Darwin after public reads." }) }]
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
      language: "English",
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
    assert.equal(summary.message, "Votes tightened around Darwin after public reads.");
    assert.equal(summary.data?.summarySource, "llm");
    assert.match(String(summary.data?.deterministicMessage), /Votes:/);
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
    assert.match(body.system, /natural Japanese for spectators/);
    assert.match(body.system, /Respond in Japanese/);
    assert.equal(body.messages[0].role, "user");
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
  assert.ok(players[0].memories.some((memory) => memory.includes("checked as werewolf")));
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
  assert.ok(witchInputs.every((input) => input.candidates.every((candidate) => candidate.id !== "p3")));
  assert.ok(hunterInputs.length > 0);
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

test("human player is protected from early linked night deaths", async () => {
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

  assert.equal(players[2].alive, true);
  assert.equal(players[3].alive, false);
  assert.ok(!events.some((event) => event.type === "death" && event.targetId === "p3"));
  assert.ok(!events.some((event) => event.type === "death" && event.targetId === "p3" && event.data?.cause === "lover"));
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

test("witch save potion prevents the werewolf kill and consumes explicit engine state", async () => {
  const game = createGame();
  const players = setTable(game, [
    { role: "Witch", decisions: [true] },
    { role: "Werewolf" },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Villager" },
    { role: "Villager" }
  ]);

  const events = await collect(game.runWitchAction(players[2]));

  assert.equal(events[0]?.type, "night_action");
  assert.equal(game.witchState.savePotion, false);
  assert.equal(game.witchState.savedTargetId, "p3");
  assert.equal(game.witchState.poisonPotion, true);
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
  assert.doesNotMatch(alphaWolfDeath.message, /Alpha Wolf|shot|アルファ人狼|撃/);
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

  assert.match(context, new RegExp(`Lover partner: ${players[4].name}`));
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
    { role: "Villager", alive: false },
    { role: "Seer", alive: false },
    { role: "Witch", alive: false }
  ]);

  const result = game.checkVictory();

  assert.equal(result?.winnerCamp, "lover");
  assert.equal(result?.camp, "village");
  assert.deepEqual(result?.winnerIds, ["p1", "p2"]);
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

  assert.equal(players[3].alive, false);
  assert.ok(events.some((event) => event.type === "system" && event.data?.action === "neutral_victory_claim"));
  assert.equal(result?.winnerCamp, "neutral");
  assert.equal(result?.camp, "village");
  assert.deepEqual(result?.winnerIds, ["p4"]);

  const ended = game.finishGame(result!);
  assert.equal(ended.data?.winner, "village");
  assert.equal(ended.data?.winnerCamp, "neutral");
  assert.deepEqual(ended.data?.winnerIds, ["p4"]);
  assert.equal(ended.snapshot.winner, "village");
  assert.equal(ended.snapshot.winnerCamp, "neutral");
  assert.deepEqual(ended.snapshot.winnerIds, ["p4"]);
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
    assert.doesNotMatch(event.message, /Hunter|Alpha Wolf|Wolf Beauty|heartbreak|shot|charm|ハンター|アルファ人狼|美女狼|恋人|撃|魅了/);
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
    assert.match(decision.reason, /Fallback legal choice/);
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
            text: JSON.stringify({
              suspects: [{ targetId: "p2", weight: 0.6, evidence: { kind: "stance_change" } }],
              trusts: [],
              claims: []
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

    assert.deepEqual(speech.messages, ["Byron is my suspicion lean because changed public stance."]);
    assert.equal(calls, 7);
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

test("LLM public speech realizes varied dialogue from public-safe notes", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  let surfaceUserContent = "";

  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const userContent = String((body.messages as Array<{ content: string }>)[0]?.content ?? "");
    assert.equal(body.model, "test-model");
    assert.equal((body.messages as Array<{ role: string }>)[0]?.role, "user");
    if (bodies.length === 1) {
      assert.match(String(body.system), /reasoning metadata/);
      assert.match(userContent, /Public context with claims and reads/);
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                intent: { act: "suspect", targetId: "p2", stance: "suspicion", reason: "claim reason changed" },
                suspects: [{ targetId: "p2", reason: "claim reason changed", weight: 0.7, evidence: { kind: "stance_change" } }]
              })
            }
          ]
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    surfaceUserContent = userContent;
    assert.match(String(body.system), /public-safe facts/);
    assert.match(userContent, /Speech notes/);
    assert.match(userContent, /Byron/);
    assert.match(userContent, /changed public stance/);
    assert.doesNotMatch(userContent, /previous discussion/);
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "Byron's changed line is the part I want pressure on." }]
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
      context: "Public context with claims and reads.",
      knownPlayers: [
        { id: "p1", name: "Ada" },
        { id: "p2", name: "Byron" }
      ],
      publicHistory: [],
      privateHistory: []
    });

    assert.equal(bodies.length, 2);
    assert.deepEqual(speech.messages, ["Byron's changed line is the part I want pressure on."]);
    assert.equal(speech.metadata.suspects[0].targetName, "Byron");
    assert.doesNotMatch(surfaceUserContent, /targetId|evidence|stance_change|intent|suspects|metadata/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM public speech rejects surface wording that adds an unmentioned player", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                intent: { act: "suspect", targetId: "p2" },
                suspects: [{ targetId: "p2", weight: 0.7, evidence: { kind: "stance_change" } }]
              })
            }
          ]
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

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

    assert.equal(calls, 2);
    assert.deepEqual(speech.messages, ["Byron is my suspicion lean because changed public stance."]);
    assert.equal(speech.metadata.suspects[0].targetName, "Byron");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM public speech passes canonical evidence instead of raw reasoning jargon", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let surfaceUserContent = "";

  globalThis.fetch = (async (_url, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const userContent = String((body.messages as Array<{ content: string }>)[0]?.content ?? "");
    if (calls === 2) {
      surfaceUserContent = userContent;
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "リンタロウは占い結果への反応が少し引っかかります" }]
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              intent: {
                act: "suspect",
                targetId: "p3",
                reason: "アキオミの占い師主張は保留だが、キリエ白出しでリンタロウを疑う根拠が薄い"
              },
              suspects: [
                {
                  targetId: "p3",
                  reason: "キリエ白出しでリンタロウを疑う根拠が薄い",
                  weight: 0.7,
                  evidence: {
                    kind: "seer_result",
                    claimantId: "p1",
                    resultTargetId: "p2",
                    resultCamp: "village",
                    round: 1
                  }
                }
              ],
              claims: [{ type: "role_claim", role: "Seer", result: { targetId: "p2", camp: "village", round: 1 } }]
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
      context: "アキオミが占い師を主張し、キリエを人間側だと言った。リンタロウがキリエを疑っている。",
      knownPlayers: [
        { id: "p1", name: "アキオミ" },
        { id: "p2", name: "キリエ" },
        { id: "p3", name: "リンタロウ" }
      ],
      legalPlayers: [
        { id: "p2", name: "キリエ" },
        { id: "p3", name: "リンタロウ" }
      ],
      publicHistory: [],
      privateHistory: []
    });

    assert.equal(calls, 2);
    assert.deepEqual(speech.messages, ["リンタロウは占い結果への反応が少し引っかかります"]);
    assert.match(surfaceUserContent, /アキオミ.*キリエ.*人間側/);
    assert.doesNotMatch(surfaceUserContent, /白出し|targetId|metadata|evidence|seer_result|suspects|claims|intent/);
    assert.doesNotMatch(speech.messages.join(" "), /白出し|targetId|metadata|evidence|seer_result|suspects|claims|intent/);
    assert.doesNotMatch(speech.metadata.suspects[0].reason ?? "", /白出し/);
    assert.match(speech.metadata.suspects[0].reason ?? "", /アキオミ.*キリエ.*人間側/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM speech ignores reasoning-stage message strings and renders normalized reads", async () => {
  const originalFetch = globalThis.fetch;
  const longMessage = "x".repeat(180);
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 2) {
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "Byron's timing is late enough that I want pressure there." }]
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              messages: [longMessage, "   ", "Second short line.", "Third short line.", "Fourth short line."],
              suspects: [{ targetId: "p2", reason: "late stance", weight: 0.6, evidence: { kind: "speech_timing" } }]
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

    assert.equal(calls, 2);
    assert.deepEqual(speech.messages, ["Byron's timing is late enough that I want pressure there."]);
    assert.doesNotMatch(speech.messages.join(" "), /Second short line|Third short line|xxxx/);
    assert.equal(speech.metadata.suspects[0].targetName, "Byron");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM speech metadata keeps reads on legal living targets only", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              messages: ["Curie is dead, so I will use that as history and press Byron today."],
              suspects: [
                { targetId: "p3", reason: "dead player should not be current pressure", weight: 0.8 },
                { targetId: "p2", reason: "current answer is evasive", weight: 0.6 }
              ],
              claims: [
                {
                  type: "seer_result",
                  result: { targetId: "p3", camp: "village", round: 1 },
                  note: "historical check"
                }
              ]
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
    const [player] = setTable(game, [{ role: "Seer" }]);
    const agent = new AnthropicAgent("llm", createTestAnthropicClient(), "test-model", "English", 1024);

    const speech = await agent.speak({
      player,
      phase: "day_discussion",
      task: "Speak.",
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

    assert.deepEqual(
      speech.metadata.suspects.map((read) => read.targetId),
      ["p2"]
    );
    assert.equal(typeof speech.metadata.claims[0]?.result, "object");
    assert.equal(typeof speech.metadata.claims[0]?.result === "object" ? speech.metadata.claims[0].result.targetName : "", "Curie");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM speech renders trust metadata without using returned message text", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 2) {
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "Byron's line connects cleanly, so I trust that side for now." }]
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              messages: ["First short line. Second short line.", "Third short line. Fourth short line."],
              trusts: [{ targetId: "p2", reason: "clear stance", weight: 0.5, evidence: { kind: "consistency" } }]
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

    assert.equal(calls, 2);
    assert.deepEqual(speech.messages, ["Byron's line connects cleanly, so I trust that side for now."]);
    assert.equal(speech.metadata.trusts[0].targetName, "Byron");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM speech metadata-only reasoning is rendered into fallback dialogue", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              suspects: [{ targetId: "p2", reason: "late stance", weight: 0.6, evidence: { kind: "stance_change" } }]
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

    assert.equal(speech.messages.length, 1);
    assert.doesNotMatch(speech.messages[0], /suspects|targetId/i);
    assert.match(speech.messages[0], /Byron.*suspicion lean.*changed public stance/i);
    assert.equal(speech.metadata.suspects[0].targetName, "Byron");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM speech falls back to code-rendered dialogue when surface wording fails", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 2) {
      throw new Error("surface wording network failure");
    }
    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              intent: { act: "suspect", targetId: "p3" },
              suspects: [{ targetId: "p2", weight: 0.6, evidence: { kind: "stance_change" } }]
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
    const agent = new AnthropicAgent("llm", createTestAnthropicClient(), "test-model", "English", 1024);

    const speech = await agent.speak({
      player,
      phase: "day_discussion",
      task: "Speak.",
      context: "Discuss.",
      knownPlayers: [
        { id: "p1", name: "Ada" },
        { id: "p2", name: "Byron" },
        { id: "p3", name: "Curie" }
      ],
      legalPlayers: [{ id: "p2", name: "Byron" }],
      publicHistory: [],
      privateHistory: []
    });

    assert.equal(calls, 2);
    assert.deepEqual(speech.messages, ["Byron is my suspicion lean because changed public stance."]);
    assert.equal(speech.metadata.suspects[0].targetName, "Byron");
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
            text: JSON.stringify({
              suspects: [{ targetId: "p2", weight: 0.6, evidence: { kind: "stance_change" } }],
              trusts: [],
              claims: []
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

    assert.deepEqual(speech.messages, ["Byron is my suspicion lean because changed public stance."]);
    assert.equal(calls, 3);
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

test("LLM speech does not use message strings from reasoning JSON", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 2) {
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "サクラコは投票理由の薄さが気になるので、疑い寄りで見ます" }]
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

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

    assert.equal(calls, 2);
    assert.deepEqual(speech.messages, ["サクラコは投票理由の薄さが気になるので、疑い寄りで見ます"]);
    assert.doesNotMatch(speech.messages.join(" "), /方針|実際の発話|質問を増やす/);
    assert.equal(speech.metadata.suspects[0].targetName, "サクラコ");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM malformed speech reasoning falls back to empty metadata", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: calls === 1 ? "plain speech without json" : "With little to go on, I want vote reasons on the table." }]
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

    assert.equal(calls, 2);
    assert.notDeepEqual(speech.messages, ["plain speech without json"]);
    assert.equal(speech.messages.length, 1);
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

test("LLM unrecoverable speech JSON uses fallback instead of raw schema text", async () => {
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
    assert.match(speech.messages[0], /初日|誰の発言も材料|情報が少ない|暫定|投票前/);
    assert.doesNotMatch(speech.messages[0], /返答に理由が少ない|乗っただけ|どの発言|発言がふわ|発言が曖昧|聞きたい|質問/);
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
