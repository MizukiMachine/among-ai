import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleAgent } from "../src/game/agents";
import { WerewolfGame } from "../src/game/engine";
import type {
  Agent,
  AgentTargetInput,
  Camp,
  GameConfig,
  GameEvent,
  Player,
  Role
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
    private readonly decisions: boolean[] = []
  ) {}

  async speak(): Promise<string> {
    return `${this.name} speaks.`;
  }

  async chooseTarget(input: AgentTargetInput): Promise<string | null> {
    if (this.targets.length > 0) {
      return this.targets.shift() ?? null;
    }
    return input.candidates[0]?.id ?? null;
  }

  async decide(): Promise<boolean> {
    return this.decisions.shift() ?? false;
  }
}

type TestableGame = WerewolfGame & {
  agents: Map<string, Agent>;
  checkVictory(): { camp: Camp; reason: string } | null;
  players: Player[];
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
};

function createGame(): TestableGame {
  return new WerewolfGame(baseConfig) as TestableGame;
}

function setTable(
  game: TestableGame,
  specs: Array<{ role: Role; alive?: boolean; targets?: Array<string | null>; decisions?: boolean[] }>
): Player[] {
  game.witchState.savePotion = true;
  game.witchState.poisonPotion = true;
  game.witchState.savedTargetId = null;
  game.witchState.poisonTargetId = null;

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
    game.agents.set(player.id, new ScriptedAgent(player.name, spec.targets, spec.decisions));
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
    assert.equal(roles.filter((role) => role === "Werewolf").length, playerCount >= 8 ? 2 : 1);
    assert.equal(roles.length, playerCount);
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

    const targetId = await agent.chooseTarget({
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

    assert.equal(targetId, "p2");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
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
