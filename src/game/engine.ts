import { createAgentFactory, DemoAgent } from "./agents";
import { buildBaseContext } from "./prompts";
import { sample, shuffle } from "./random";
import type {
  Agent,
  Camp,
  GameConfig,
  GameEvent,
  GameSnapshot,
  Phase,
  Player,
  Role,
  TargetCandidate,
  VoteRecord
} from "./types";

const names = ["Ada", "Byron", "Curie", "Darwin", "Edison", "Faraday", "Galileo", "Hopper", "Iris"];

const fallbackAgent = new DemoAgent("fallback");

function roleCamp(role: Role): Camp {
  return role === "Werewolf" ? "werewolf" : "village";
}

function normalizePlayerCount(count: number): number {
  if (!Number.isFinite(count)) {
    return 7;
  }
  return Math.min(9, Math.max(6, Math.floor(count)));
}

function createRoles(playerCount: number): Role[] {
  const werewolves = playerCount >= 8 ? 2 : 1;
  const fixed: Role[] = [
    ...Array.from<Role>({ length: werewolves }).fill("Werewolf"),
    "Seer",
    "Witch"
  ];
  return [...fixed, ...Array.from<Role>({ length: playerCount - fixed.length }).fill("Villager")];
}

function tallyVotes(votes: VoteRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const vote of votes) {
    counts.set(vote.targetId, (counts.get(vote.targetId) ?? 0) + 1);
  }
  return counts;
}

function topVoted(counts: Map<string, number>): string[] {
  const max = Math.max(...counts.values());
  return [...counts.entries()].filter(([, count]) => count === max).map(([id]) => id);
}

export class WerewolfGame {
  private readonly players: Player[];
  private readonly agents = new Map<string, Agent>();
  private readonly publicHistory: string[] = [];
  private readonly wolfHistory: string[] = [];
  private readonly config: GameConfig;
  private readonly startupWarnings: string[] = [];
  private readonly witchState = {
    savePotion: true,
    poisonPotion: true,
    savedTargetId: null as string | null,
    poisonTargetId: null as string | null
  };
  private eventId = 0;
  private round = 0;
  private phase: Phase = "setup";
  private winner: Camp | null = null;
  private lastNightDeaths: string[] = [];
  private lastVotes: VoteRecord[] = [];

  constructor(config: GameConfig) {
    this.config = {
      ...config,
      playerCount: normalizePlayerCount(config.playerCount),
      maxRounds: Math.max(3, config.maxRounds)
    };

    if (this.config.provider === "llm" && !process.env.OPENAI_API_KEY) {
      this.startupWarnings.push(
        "LLM provider was requested, but OPENAI_API_KEY is not set. Demo agents are being used instead."
      );
    }

    const roles = shuffle(createRoles(this.config.playerCount));
    const createAgent = createAgentFactory({
      provider: this.config.provider,
      model: this.config.model,
      language: this.config.language
    });

    this.players = roles.map((role, index) => {
      const name = names[index];
      const agent = createAgent(name);
      const player: Player = {
        id: `p${index + 1}`,
        name,
        role,
        camp: roleCamp(role),
        alive: true,
        model: agent.model,
        memories: [],
        seerResults: {},
        witch: {
          savePotion: role === "Witch",
          poisonPotion: role === "Witch"
        }
      };
      this.agents.set(player.id, agent);
      return player;
    });
  }

  async *run(): AsyncGenerator<GameEvent> {
    yield this.emit("game_started", "A new AI werewolf match has started.", {
      provider: this.config.provider,
      model: this.config.model || "demo",
      playerCount: this.config.playerCount
    });

    for (const warning of this.startupWarnings) {
      yield this.emit("warning", warning, {
        provider: this.config.provider,
        fallback: "demo"
      });
    }

    while (!this.winner && this.round < this.config.maxRounds) {
      this.round += 1;

      yield* this.runNight();
      const nightWinner = this.checkVictory();
      if (nightWinner) {
        yield this.finishGame(nightWinner);
        return;
      }

      yield* this.runDay();
      const dayWinner = this.checkVictory();
      if (dayWinner) {
        yield this.finishGame(dayWinner);
        return;
      }
    }

    const adjudicated = this.countAlive("werewolf") >= this.countAlive("village") ? "werewolf" : "village";
    yield this.finishGame({
      camp: adjudicated,
      reason: `Round limit reached after ${this.config.maxRounds} rounds.`
    });
  }

  private async *runNight(): AsyncGenerator<GameEvent> {
    this.lastNightDeaths = [];
    this.lastVotes = [];
    this.witchState.savedTargetId = null;
    this.witchState.poisonTargetId = null;
    this.phase = "night";
    yield this.emit("phase_changed", `Night ${this.round} begins.`);

    const werewolves = this.alivePlayers().filter((player) => player.role === "Werewolf");
    if (werewolves.length > 1) {
      this.phase = "werewolf_discussion";
      yield this.emit("phase_changed", "The werewolves open a private discussion.");

      for (const wolf of werewolves) {
        const targets = this.alivePlayers().filter((player) => player.camp !== "werewolf");
        const context = this.contextFor(wolf, [
          `Known werewolves: ${werewolves.map((player) => player.name).join(", ")}.`,
          `Possible victims: ${targets.map((player) => player.name).join(", ")}.`,
          ...this.wolfHistory.slice(-8).map((line) => `Werewolf chat: ${line}`)
        ]);
        const speech = await this.safeSpeak(wolf, "Suggest a night victim and explain the strategic reason.", context);
        this.wolfHistory.push(`${wolf.name}: ${speech}`);
        yield this.emit("player_speech", speech, {}, wolf);
      }
    }

    this.phase = "night";
    const killTarget = await this.resolveWerewolfAttack(werewolves);
    if (killTarget) {
      yield this.emit("night_action", "The werewolves selected a victim.", {}, undefined, killTarget);
    }

    yield* this.runSeerAction();
    const savedTarget = yield* this.runWitchAction(killTarget);
    const deaths = new Set<string>();

    if (killTarget && savedTarget !== killTarget.id) {
      deaths.add(killTarget.id);
    }

    const poisonTarget = this.witchState.poisonTargetId
      ? this.requirePlayer(this.witchState.poisonTargetId)
      : null;
    if (poisonTarget) {
      deaths.add(poisonTarget.id);
    }

    if (deaths.size === 0) {
      yield this.emit("death", "No one died during the night.");
      return;
    }

    for (const id of deaths) {
      const player = this.requirePlayer(id);
      player.alive = false;
      this.lastNightDeaths.push(id);
      yield this.emit("death", `${player.name} died during the night.`, {}, undefined, player);
    }
  }

  private async resolveWerewolfAttack(werewolves: Player[]): Promise<Player | null> {
    const targets = this.alivePlayers().filter((player) => player.camp !== "werewolf");
    if (werewolves.length === 0 || targets.length === 0) {
      return null;
    }

    const votes: VoteRecord[] = [];
    for (const wolf of werewolves) {
      const context = this.contextFor(wolf, [
        `Known werewolves: ${werewolves.map((player) => player.name).join(", ")}.`,
        "Vote for the player the werewolf team should kill tonight."
      ]);
      const targetId = await this.safeChooseTarget(wolf, "Werewolf night kill vote", context, targets, false);
      if (targetId) {
        votes.push({ voterId: wolf.id, targetId });
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
    if (!seer) {
      return;
    }

    this.phase = "seer_action";
    const allTargets = this.alivePlayers().filter((player) => player.id !== seer.id);
    const unchecked = allTargets.filter((player) => !(player.id in seer.seerResults));
    const targets = unchecked.length > 0 ? unchecked : allTargets;
    if (targets.length === 0) {
      return;
    }

    const context = this.contextFor(seer, ["Choose one living player to check tonight."]);
    const targetId = await this.safeChooseTarget(seer, "Seer identity check", context, targets, false);
    if (!targetId) {
      return;
    }

    const target = this.requirePlayer(targetId);
    seer.seerResults[target.id] = target.camp;
    seer.memories.push(`Round ${this.round}: ${target.name} checked as ${target.camp}.`);
    yield this.emit(
      "private_info",
      `${seer.name} learned that ${target.name} is ${target.camp}.`,
      { visibleTo: seer.id, result: target.camp },
      seer,
      target
    );
  }

  private async *runWitchAction(killTarget: Player | null): AsyncGenerator<GameEvent, string | null> {
    const witch = this.alivePlayers().find((player) => player.role === "Witch");
    if (!witch) {
      return null;
    }

    this.phase = "witch_action";
    let savedTarget: string | null = null;

    if (killTarget && this.witchState.savePotion) {
      const context = this.contextFor(witch, [
        `${killTarget.name} will be killed by werewolves tonight.`,
        "Decide whether to spend your only save potion."
      ]);
      const save = await this.safeDecide(witch, `Use the save potion on ${killTarget.name}?`, context);
      if (save) {
        this.witchState.savePotion = false;
        this.witchState.savedTargetId = killTarget.id;
        savedTarget = killTarget.id;
        witch.memories.push(`Round ${this.round}: saved ${killTarget.name}.`);
        yield this.emit("night_action", `${witch.name} used the save potion.`, {}, witch, killTarget);
        return savedTarget;
      }
    }

    if (this.witchState.poisonPotion) {
      const poisonTargets = this.alivePlayers().filter((player) => player.id !== witch.id);
      const context = this.contextFor(witch, [
        "You may spend your only poison potion tonight, or skip.",
        killTarget ? `The werewolf victim is ${killTarget.name}.` : "No werewolf victim is known."
      ]);
      const targetId = await this.safeChooseTarget(witch, "Witch poison potion", context, poisonTargets, true);
      if (targetId) {
        const target = this.requirePlayer(targetId);
        this.witchState.poisonPotion = false;
        this.witchState.poisonTargetId = target.id;
        witch.memories.push(`Round ${this.round}: poisoned ${target.name}.`);
        yield this.emit("night_action", `${witch.name} used the poison potion.`, {}, witch, target);
      }
    }

    return savedTarget;
  }

  private async *runDay(): AsyncGenerator<GameEvent> {
    this.phase = "day_discussion";
    const deathNames = this.lastNightDeaths.map((id) => this.requirePlayer(id).name);
    yield this.emit(
      "phase_changed",
      deathNames.length > 0
        ? `Day ${this.round} begins. Last night's deaths: ${deathNames.join(", ")}.`
        : `Day ${this.round} begins. No one died last night.`
    );

    for (const player of this.alivePlayers()) {
      const context = this.contextFor(player, [
        deathNames.length > 0
          ? `Last night, ${deathNames.join(", ")} died.`
          : "No one died last night.",
        "Discuss suspicions, claims, or information with the whole table."
      ]);
      const speech = await this.safeSpeak(player, "Make a public day discussion statement.", context);
      this.publicHistory.push(`${player.name}: ${speech}`);
      yield this.emit("player_speech", speech, {}, player);
    }

    yield* this.runVoting();
  }

  private async *runVoting(): AsyncGenerator<GameEvent> {
    this.phase = "voting";
    yield this.emit("phase_changed", "Voting begins.");

    const votes: VoteRecord[] = [];
    for (const voter of this.alivePlayers()) {
      const targets = this.alivePlayers().filter((player) => player.id !== voter.id);
      if (targets.length === 0) {
        continue;
      }
      const context = this.contextFor(voter, ["Vote for one living player to eliminate."]);
      const targetId = await this.safeChooseTarget(voter, "Day elimination vote", context, targets, false);
      if (!targetId) {
        continue;
      }
      votes.push({ voterId: voter.id, targetId });
      const target = this.requirePlayer(targetId);
      voter.memories.push(`Round ${this.round}: voted for ${target.name}.`);
      yield this.emit("vote_cast", `${voter.name} votes for ${target.name}.`, {}, voter, target);
    }

    this.lastVotes = votes;
    if (votes.length === 0) {
      yield this.emit("vote_result", "No votes were cast.");
      return;
    }

    const counts = tallyVotes(votes);
    const candidates = topVoted(counts);
    yield this.emit("vote_result", "Vote totals are in.", {
      totals: [...counts.entries()].map(([targetId, count]) => ({
        targetId,
        targetName: this.requirePlayer(targetId).name,
        count
      }))
    });

    if (candidates.length !== 1) {
      yield this.emit("vote_result", "The vote is tied, so no one is eliminated.");
      return;
    }

    const eliminated = this.requirePlayer(candidates[0]);
    eliminated.alive = false;
    yield this.emit(
      "death",
      `${eliminated.name} was eliminated by vote. Their role was ${eliminated.role}.`,
      { cause: "vote" },
      undefined,
      eliminated
    );
  }

  private checkVictory(): { camp: Camp; reason: string } | null {
    const werewolves = this.countAlive("werewolf");
    const village = this.countAlive("village");

    if (werewolves === 0) {
      return { camp: "village", reason: "All werewolves have been eliminated." };
    }
    if (werewolves >= village) {
      return {
        camp: "werewolf",
        reason: `Werewolves (${werewolves}) equal or outnumber villagers (${village}).`
      };
    }
    return null;
  }

  private finishGame(result: { camp: Camp; reason: string }): GameEvent {
    this.winner = result.camp;
    this.phase = "ended";
    return this.emit("game_ended", `${result.camp} wins. ${result.reason}`, {
      winner: result.camp,
      reason: result.reason
    });
  }

  private async safeSpeak(player: Player, task: string, context: string): Promise<string> {
    const agent = this.agents.get(player.id) ?? fallbackAgent;
    try {
      return await agent.speak({
        player,
        phase: this.phase,
        task,
        context,
        publicHistory: this.publicHistory,
        privateHistory: player.memories
      });
    } catch (error) {
      player.memories.push(`LLM error during speech: ${String(error)}`);
      return fallbackAgent.speak({
        player,
        phase: this.phase,
        task,
        context,
        publicHistory: this.publicHistory,
        privateHistory: player.memories
      });
    }
  }

  private async safeChooseTarget(
    player: Player,
    action: string,
    context: string,
    candidates: Player[],
    allowSkip: boolean
  ): Promise<string | null> {
    const agent = this.agents.get(player.id) ?? fallbackAgent;
    const targetCandidates: TargetCandidate[] = candidates.map(({ id, name }) => ({ id, name }));
    try {
      return await agent.chooseTarget({
        player,
        phase: this.phase,
        action,
        context,
        candidates: targetCandidates,
        allowSkip
      });
    } catch (error) {
      player.memories.push(`LLM error during target choice: ${String(error)}`);
      return fallbackAgent.chooseTarget({
        player,
        phase: this.phase,
        action,
        context,
        candidates: targetCandidates,
        allowSkip
      });
    }
  }

  private async safeDecide(player: Player, question: string, context: string): Promise<boolean> {
    const agent = this.agents.get(player.id) ?? fallbackAgent;
    try {
      return await agent.decide({ player, phase: this.phase, question, context });
    } catch (error) {
      player.memories.push(`LLM error during decision: ${String(error)}`);
      return fallbackAgent.decide({ player, phase: this.phase, question, context });
    }
  }

  private contextFor(player: Player, extra: string[] = []): string {
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
      extra
    });
  }

  private alivePlayers(): Player[] {
    return this.players.filter((player) => player.alive);
  }

  private countAlive(camp: Camp): number {
    return this.players.filter((player) => player.alive && player.camp === camp).length;
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
      aliveCount: this.alivePlayers().length,
      werewolfCount: this.countAlive("werewolf"),
      villageCount: this.countAlive("village"),
      players: this.players.map((player) => ({
        id: player.id,
        name: player.name,
        role: player.role,
        camp: player.camp,
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
