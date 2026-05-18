import assert from "node:assert/strict";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicAgent, DemoAgent, listJapaneseDemoCopySamples, summarizeRoundWithLlm } from "../src/game/agents";
import { WerewolfGame } from "../src/game/engine";
import { containsAwkwardJapaneseOutputTerm } from "../src/game/japaneseStyle";
import { redactEventForVillage } from "../src/game/redaction";
import type {
  Agent,
  AgentSpeech,
  AgentTargetInput,
  Camp,
  GameConfig,
  GameEvent,
  Player,
  Role,
  TargetDecision
} from "../src/game/types";

const baseConfig: GameConfig = {
  playerCount: 6,
  provider: "demo",
  model: "demo",
  language: "English",
  maxRounds: 3
};

class ScriptedAgent implements Agent {
  readonly model = "scripted";

  constructor(
    readonly name: string,
    private readonly targets: Array<string | null> = [],
    private readonly decisions: boolean[] = [],
    private readonly speeches: AgentSpeech[] = []
  ) {}

  async speak(): Promise<AgentSpeech> {
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

type TestableGame = WerewolfGame & {
  agents: Map<string, Agent>;
  checkVictory(): { camp: Camp; reason: string } | null;
  players: Player[];
  runDay(): AsyncGenerator<GameEvent>;
  runGuardAction(): AsyncGenerator<GameEvent>;
  runHunterShot(hunter: Player, blockedTargetIds?: Set<string>, chainDepth?: number): AsyncGenerator<GameEvent>;
  runNight(): AsyncGenerator<GameEvent>;
  runSeerAction(): AsyncGenerator<GameEvent>;
  runVoting(): AsyncGenerator<GameEvent>;
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

  return game.players.map((player, index) => {
    const spec = specs[index] ?? { role: "Villager" as const };
    player.role = spec.role;
    player.camp = spec.role === "Werewolf" ? "werewolf" : "village";
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
    assert.equal(roles.filter((role) => role === "Werewolf").length, playerCount >= 7 ? 2 : 1);
    assert.equal(roles.length, playerCount);
    assert.ok(first.value.snapshot.players.every((player) => player.persona));
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
  assert.match(messageText, /初日|情報が少ない|決め打ち|仮説|発言量|便乗/);
  assert.doesNotMatch(messageText, /人狼判定|確定|決めつけ/);
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
  assert.ok(events.some((event) => event.type === "vote_cast" && event.data?.reason === "カズ scripted reason"));
  assert.ok(events.some((event) => event.type === "round_summary" && event.message.includes("Votes:")));
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

  assert.deepEqual(
    speechEvents.map((event) => event.message),
    ["First short line.", "Second short line."]
  );
  assert.deepEqual(
    speechEvents.map((event) => event.data?.speechIndex),
    [0, 1]
  );
  assert.deepEqual(
    speechEvents.map((event) => event.data?.speechCount),
    [2, 2]
  );
  assert.equal((speechEvents[0].data?.suspects as unknown[]).length, 0);
  assert.equal((speechEvents[1].data?.suspects as unknown[]).length, 1);
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
    assert.match(body.system, /natural Japanese for spectators/);
    assert.match(body.system, /Respond in Japanese/);
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

  assert.equal(redacted.message, "村視点では非公開情報です。");
  assert.equal(redacted.playerName, undefined);
  assert.equal(redacted.targetName, undefined);
  assert.equal(redacted.role, undefined);
  assert.equal(redacted.data.redacted, true);
  assert.equal(redacted.snapshot.werewolfCount, null);
  assert.equal(redacted.snapshot.villageCount, null);
  assert.ok(redacted.snapshot.players.every((player) => player.role === "Hidden" && player.camp === "hidden"));
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
    assert.equal(speech.metadata.suspects[0].targetName, "Byron");
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
            text: "{\"messages\":[\"カズの言う通り、初日は情報が少ないから無理に決めない方がいいだろ\",\"でも、誰か占"
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
        { id: "p1", name: "カズ" },
        { id: "p2", name: "ミオ" }
      ],
      publicHistory: [],
      privateHistory: []
    });

    assert.deepEqual(speech.messages, ["カズの言う通り、初日は情報が少ないから無理に決めない方がいいだろ"]);
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
    assert.doesNotMatch(speech.messages[0], /messages|^\{|```/);
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
