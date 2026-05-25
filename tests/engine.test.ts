import assert from "node:assert/strict";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicAgent, DemoAgent, listJapaneseDemoCopySamples, summarizeRoundWithLlm } from "../src/game/agents";
import { characterNames, characterProfiles } from "../src/game/characters";
import { WerewolfGame } from "../src/game/engine";
import { HumanInputAgent } from "../src/game/humanAgent";
import { containsAwkwardJapaneseOutputTerm } from "../src/game/japaneseStyle";
import { redactEventForPlayer, redactEventForVillage } from "../src/game/redaction";
import { maxSupportedPlayers } from "../src/game/rules/presets";
import { roleCamp } from "../src/game/rules/roles";
import { applyStatusEffects, createInitialRuleState } from "../src/game/rules/state";
import type { RuleState } from "../src/game/rules/types";
import type {
  Agent,
  AgentSpeech,
  AgentSpeechInput,
  AgentTargetInput,
  Camp,
  CampId,
  GameConfig,
  GameEvent,
  GenerationProgress,
  Player,
  Role,
  SpeechGenerationDiagnostic,
  HumanInputHandler,
  HumanInputRequestPayload,
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
  finishGame(result: { camp: Camp; winnerCamp?: CampId; winnerIds?: string[]; reason: string }): GameEvent;
  players: Player[];
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

test("configured human player is forced onto the village camp", async () => {
  const game = new WerewolfGame({
    ...baseConfig,
    playerCount: 9,
    debugScenario: "hunter_shot",
    humanPlayerId: "p1"
  });
  const run = game.run();
  const first = await run.next();
  await run.return(undefined);

  const human = first.value?.snapshot.players.find((player) => player.id === "p1");
  assert.equal(human?.camp, "village");
  assert.notEqual(human?.role, "Werewolf");
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
  assert.ok(speech.metadata.suspects.every((read) => /[ぁ-んァ-ヶ一-龠]/.test(read.reason ?? "")));
});

test("Japanese demo werewolf private chat uses night-kill context instead of day accusations", async () => {
  const game = createGame();
  const [player] = setTable(game, [{ role: "Werewolf" }]);
  const agent = new DemoAgent("demo", "demo", "Japanese");

  const speech = await agent.speak({
    player,
    phase: "werewolf_discussion",
    task: "夜の襲撃先を提案してください。",
    context: [
      "あなたはAdaです。",
      "把握している人狼: Ada, Byron。",
      "襲撃候補: Curie, Darwin。",
      "夜の襲撃先を提案し、戦略的な理由を説明してください。"
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
  assert.equal(containsAwkwardJapaneseOutputTerm(messageText), false);
  assert.doesNotMatch(messageText, /証拠が薄い|疑いが急に動いた|その主張/);
  assert.ok(speech.metadata.suspects.every((read) => read.targetId === "p3" || read.targetId === "p4"));
  assert.ok(speech.metadata.suspects.every((read) => !containsAwkwardJapaneseOutputTerm(read.reason ?? "")));
});

test("Japanese demo copy samples avoid translationese game terms", () => {
  for (const sample of listJapaneseDemoCopySamples()) {
    assert.equal(containsAwkwardJapaneseOutputTerm(sample), false, sample);
  }
});

test("Japanese demo day speech and target reasons avoid translationese game terms", async () => {
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
  assert.equal(containsAwkwardJapaneseOutputTerm(messageText), false);
  assert.ok(speech.metadata.suspects.every((read) => !containsAwkwardJapaneseOutputTerm(read.reason ?? "")));
  assert.ok(speech.metadata.trusts.every((read) => !containsAwkwardJapaneseOutputTerm(read.reason ?? "")));
  assert.equal(containsAwkwardJapaneseOutputTerm(decision.reason), false);
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

test("Japanese demo first-day speech stays tentative and question-led", async () => {
  const game = createGame();
  const [player] = setTable(game, [{ role: "Villager" }]);
  const agent = new DemoAgent("demo", "demo", "Japanese");

  const speech = await agent.speak({
    player,
    phase: "day_discussion",
    task: "昼議論の公開発言をしてください。",
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
  assert.match(messageText, /初日|情報が少ない|誰の発言も材料|軽い質問|理由を出す流れ|最初の考え/);
  assert.doesNotMatch(messageText, /人狼判定|確定|決めつけ/);
  assert.doesNotMatch(messageText, /発言が少ない|返答に理由が少ない|乗っただけ|どの発言|発言がふわ|発言が曖昧/);
  assert.equal(containsAwkwardJapaneseOutputTerm(messageText), false);
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
    task: "昼議論の公開発言をしてください。",
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
    task: "昼議論の公開発言をしてください。",
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

  assert.match(decision.reason, /公開発言|検証しやすい|投票理由|今日の発言/);
  assert.equal(containsAwkwardJapaneseOutputTerm(decision.reason), false);
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
  assert.ok(events.some((event) => event.type === "vote_cast" && event.data?.reason === "シオン scripted reason"));
  assert.ok(events.some((event) => event.type === "round_summary" && event.message.includes("Votes:")));
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
  assert.ok(ravenAgent.targetInputs[0].candidates.every((candidate) => candidate.id !== players[0].id));

  const events = await collect(game.runVoting());
  const totals = events.find((event) => event.type === "vote_result" && Array.isArray(event.data?.totals));

  assert.equal(players[4].alive, false);
  assert.ok(events.some((event) => event.type === "death" && event.targetId === "p5" && event.data?.cause === "vote"));
  assert.ok((totals?.data?.modifiers as unknown[]).some((modifier) => (modifier as { reason?: string }).reason === "raven_marked"));
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
  assert.match(firstAgent.speechInputs[1].context, /Second pass: answer direct questions/);
  assert.match(firstAgent.speechInputs[1].context, /ガク speaks/);
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
        messages: [`${players[2].name}さん、昨日の発言と${players[1].name}さんの死亡をどう見ていますか。`],
        metadata: emptyMetadata
      }
    ])
  );

  await collect(game.runDay());

  const rejected = diagnostics.find((diagnostic) => diagnostic.kind === "speech_review_rejected" && diagnostic.playerId === players[0].id);
  assert.ok(rejected);
  assert.deepEqual(rejected.speechPlanIssues, ["speech stops at night-death recap without a living-player move"]);
  assert.equal(rejected.attempts, 1);
  assert.equal(diagnostics.filter((diagnostic) => diagnostic.kind === "speech_retry_accepted" && diagnostic.playerId === players[0].id).length, 1);
  assert.ok(diagnostics.some((diagnostic) => diagnostic.kind === "speech_completed" && diagnostic.playerId === players[0].id && diagnostic.retried));
});

test("day discussion race publishes the fastest AI and rebuilds the next race from that speech", async () => {
  const game = new WerewolfGame({ ...baseConfig, prefetchConcurrency: 6 }) as TestableGame;
  const players = setTable(game, [
    { role: "Villager" },
    { role: "Werewolf" },
    { role: "Seer" },
    { role: "Witch" },
    { role: "Villager" },
    { role: "Villager" }
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
      if (input.kind === "speech") {
        return { speech: "Human follow-up answer." };
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

  assert.deepEqual(
    followUpEvents.map((event) => event.playerId),
    [players[4].id, players[2].id]
  );
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
      if (input.kind === "speech") {
        return { speech: "I will give my read after hearing everyone." };
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

test("human Lover receives partner info in private input context", async () => {
  const requests: HumanInputRequestPayload[] = [];
  const humanInput: HumanInputHandler = {
    async request(input) {
      requests.push(input);
      if (input.kind === "speech") {
        return { speech: "相方の生存も見ながら話します。" };
      }
      if (input.kind === "target") {
        return { targetId: input.candidates[0]?.id ?? null, reason: "人間プレイヤーの投票です。" };
      }
      return { decision: false };
    }
  };
  const game = new WerewolfGame({ ...baseConfig, language: "Japanese" }) as TestableGame;
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

  await collect(game.runDay());

  const speechRequest = requests.find((request) => request.kind === "speech");
  assert.ok(speechRequest);
  assert.ok(speechRequest.context.privateHistory.some((line) => line.includes(`恋人の相方は${players[4].name}`)));
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
  assert.ok(events.some((event) => event.type === "round_summary"));
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

  const events = await collect(game.runDay());
  const summary = events.find((event) => event.type === "round_summary");
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

  const events = await collect(game.runDay());
  const summary = events.find((event) => event.type === "round_summary");

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

    const events = await collect(game.runVoting());
    const summary = events.find((event) => event.type === "round_summary");

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

    const events = await collect(game.runVoting());
    const summary = events.find((event) => event.type === "round_summary");

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

    const events = await collect(game.runVoting());
    const summary = events.find((event) => event.type === "round_summary");

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

test("werewolf attack target generation is prefetched while private discussion waits in the queue", async () => {
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

  await sleepWithAbort(60);
  const targetInputs = [...firstWolf.targetInputs, ...secondWolf.targetInputs];
  assert.ok(targetInputs.length >= 2);
  assert.ok(targetInputs.every((input) => input.phase === "night"));

  await run.return(undefined);
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
  assert.ok(events.some((event) => event.type === "death" && event.targetId === "p3" && event.data?.cause === "werewolf"));
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

test("player view hides other players' individual vote details while keeping vote totals", () => {
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

  assert.equal(otherPlayerView.message, "投票が行われました。");
  assert.equal(otherPlayerView.playerId, undefined);
  assert.equal(otherPlayerView.targetId, undefined);
  assert.equal(otherPlayerView.data.reason, undefined);

  const ownPlayerView = redactEventForPlayer(voteCast, "p2");
  assert.equal(ownPlayerView.message, voteCast.message);
  assert.equal(ownPlayerView.playerId, "p2");
  assert.equal(ownPlayerView.targetId, "p1");
  assert.equal(ownPlayerView.data.reason, "発言が薄い");

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
  assert.equal(resultPlayerView.data.votes, undefined);
  assert.equal(resultPlayerView.data.modifiers, undefined);
  assert.deepEqual(resultPlayerView.data.totals, [{ targetId: "p1", targetName: "シオン", count: 1 }]);

  const resultSpectatorView = redactEventForVillage(voteResult);
  assert.deepEqual(resultSpectatorView.data.votes, voteResult.data?.votes);
  assert.deepEqual(resultSpectatorView.data.modifiers, voteResult.data?.modifiers);

  const summaryPlayerView = redactEventForPlayer({ ...voteResult, type: "round_summary" }, "p3");
  assert.equal(summaryPlayerView.data.votes, undefined);
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

test("AlphaWolf gets the same death-shot path with its own public cause", async () => {
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
  assert.ok(events.some((event) => event.type === "death" && event.targetId === "p1" && event.data?.cause === "alpha_wolf"));
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
  assert.ok(events.some((event) => event.type === "death" && event.targetId === "p5" && event.data?.cause === "lover"));
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
  assert.ok(events.some((event) => event.type === "death" && event.targetId === "p4" && event.data?.cause === "wolf_beauty_charm"));
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
  assert.ok(events.some((event) => event.type === "death" && event.data?.cause === "hunter" && event.targetId === "p1"));
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
  assert.equal(redacted.role, undefined);
  assert.equal(redacted.snapshot.players.every((player) => player.role === "Hidden"), true);
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
    if (calls <= 6) {
      return new Promise<Response>(() => undefined);
    }
    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              messages: ["slot released"],
              suspects: [],
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
    const controllers = Array.from({ length: 6 }, () => new AbortController());
    const blocked = controllers.map((controller) => agent.speak(input(controller.signal)).catch((error: unknown) => error));

    await waitUntil(() => calls === 6);
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

    assert.deepEqual(speech.messages, ["slot released"]);
    assert.equal(calls, 7);
    assert.equal(
      abortedResults.every((result) => result instanceof Error && result.message.includes("cancelled")),
      true
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Japanese LLM target decision keeps displayed vote reason free of planning notes", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.match(body.system, /対象選択/);
    assert.match(body.system, /reason は画面や履歴に表示/);
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
              reason: "方針: サクラコへの疑いを強める。"
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
      context: "投票理由の前提:\n公開発言から投票先を選んでください。",
      candidates: [
        { id: "p2", name: "サクラコ" },
        { id: "p3", name: "アカネ" }
      ],
      allowSkip: false
    });

    assert.equal(decision.targetId, "p2");
    assert.equal(decision.reason, "サクラコは今日の公開発言から一番疑わしいためです。");
    assert.doesNotMatch(decision.reason, /方針|疑いを強める|strategy|pressure|record|history|slot/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM speech messages are filtered, clamped, and capped", async () => {
  const originalFetch = globalThis.fetch;
  const longMessage = "x".repeat(180);

  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              messages: [longMessage, "   ", "Second short line.", "Third short line.", "Fourth short line."],
              suspects: [{ targetId: "p2", reason: "late stance", weight: 0.6 }]
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

    assert.equal(speech.messages.length, 3);
    assert.equal(speech.messages[0].length, 150);
    assert.ok(speech.messages[0].endsWith("..."));
    assert.deepEqual(speech.messages.slice(1), ["Second short line.", "Third short line."]);
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

test("LLM speech messages are auto-split into short sentence events", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              messages: ["First short line. Second short line.", "Third short line. Fourth short line."],
              trusts: [{ targetId: "p2", reason: "clear stance", weight: 0.5 }]
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

    assert.deepEqual(speech.messages, ["First short line.", "Second short line.", "Third short line."]);
    assert.equal(speech.metadata.trusts[0].targetName, "Byron");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM speech JSON without messages uses fallback speech", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              suspects: [{ targetId: "p2", reason: "late stance", weight: 0.6 }]
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
    assert.match(speech.messages[0], /day one|not using anyone's statement|little information/i);
    assert.doesNotMatch(speech.messages[0], /quiet|vague|which statement changed/i);
    assert.equal(speech.metadata.suspects[0].targetName, "Byron");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM speech messages discard planning notes and keep displayed dialogue", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              messages: ["方針: サクラコへの質問を増やす。", "実際の発話: サクラコ、投票理由をもう一度聞かせてください。"],
              suspects: [{ targetId: "p2", reason: "投票理由がまだ弱い", weight: 0.6 }]
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

    assert.deepEqual(speech.messages, ["サクラコ、投票理由をもう一度聞かせてください。"]);
    assert.doesNotMatch(speech.messages.join(" "), /方針|実際の発話|質問を増やす/);
    assert.equal(speech.metadata.suspects[0].targetName, "サクラコ");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM malformed speech falls back to empty metadata", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
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

    assert.deepEqual(speech.messages, ["plain speech without json"]);
    assert.deepEqual(speech.metadata, { suspects: [], trusts: [], claims: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM truncated speech JSON recovers dialogue without leaking JSON syntax", async () => {
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

    assert.deepEqual(speech.messages, ["シオンの言う通り、初日は情報が少ないから無理に決めない方がいいだろ"]);
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
    assert.match(speech.messages[0], /初日|誰の発言も材料|軽い質問|理由を出す流れ/);
    assert.doesNotMatch(speech.messages[0], /発言が少ない|返答に理由が少ない|乗っただけ|どの発言|発言がふわ|発言が曖昧/);
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
