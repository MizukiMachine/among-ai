import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleAgent, summarizeRoundWithLlm } from "../src/game/agents";
import { WerewolfGame } from "../src/game/engine";
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
      message: `${this.name} speaks.`,
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
  assert.ok(events.some((event) => event.type === "vote_cast" && event.data?.reason === "Ada scripted reason"));
  assert.ok(events.some((event) => event.type === "round_summary" && event.message.includes("Votes:")));
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
          message: "I claim Seer with a wolf result.",
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
  const originalApiKey = process.env.OPENAI_API_KEY;
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
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
  }
});

test("LLM summary request failure keeps deterministic summary data intact", async () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-key";

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
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
  }
});

test("LLM summary mode uses a short provider summary when available", async () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  process.env.OPENAI_API_KEY = "test-key";

  globalThis.fetch = (async (_url, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.temperature, 0.35);
    assert.equal(body.model, "test-model");
    assert.match(body.messages[0].content, /plain English for spectators/);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ summary: "Votes tightened around Darwin after public reads." }) } }]
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
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
  }
});

test("LLM summary prompt switches to Japanese spectator style", async () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-key";

  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.match(body.messages[0].content, /natural Japanese for spectators/);
    assert.match(body.messages[0].content, /Respond in Japanese/);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ summary: "投票はDarwinに集まり、公開推理が焦点になっています。" }) } }]
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
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
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

  assert.equal(redacted.message, "Hidden information is concealed in village view.");
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
        choices: [{ message: { content: "not-json" } }]
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
    const agent = new OpenAICompatibleAgent("llm", {
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      model: "test-model",
      language: "English",
      timeoutMs: 1_000
    });

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

test("LLM malformed speech falls back to empty metadata", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "plain speech without json" } }]
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
    const agent = new OpenAICompatibleAgent("llm", {
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      model: "test-model",
      language: "English",
      timeoutMs: 1_000
    });

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

    assert.equal(speech.message, "plain speech without json");
    assert.deepEqual(speech.metadata, { suspects: [], trusts: [], claims: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM provider without API key emits a warning event before falling back to demo agents", async () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    const game = new WerewolfGame({ ...baseConfig, provider: "llm", model: "test-model" });
    const run = game.run();
    const started = await run.next();
    const warning = await run.next();
    await run.return(undefined);

    assert.equal(started.value?.type, "game_started");
    assert.equal(warning.value?.type, "warning");
    assert.match(warning.value?.message ?? "", /OPENAI_API_KEY/);
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
  }
});
