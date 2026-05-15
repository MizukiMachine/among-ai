import { createAgentFactory, DemoAgent } from "./agents";
import { buildBaseContext } from "./prompts";
import { sample, shuffle } from "./random";
import type {
  Agent,
  AgentSpeech,
  Camp,
  ClaimMetadata,
  GameConfig,
  GameEvent,
  GameSnapshot,
  Persona,
  Phase,
  Player,
  Role,
  SpeechMetadata,
  TargetCandidate,
  TargetDecision,
  VoteRecord
} from "./types";

const names = ["Ada", "Byron", "Curie", "Darwin", "Edison", "Faraday", "Galileo", "Hopper", "Iris"];
const personas: Persona[] = ["cautious", "aggressive", "logical", "opportunistic", "empathetic"];

const fallbackAgent = new DemoAgent("fallback");

interface DiscussionRecord {
  playerId: string;
  playerName: string;
  message: string;
  metadata: SpeechMetadata;
}

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
  const werewolves = playerCount >= 7 ? 2 : 1;
  const fixed: Role[] = [
    ...Array.from<Role>({ length: werewolves }).fill("Werewolf"),
    "Seer",
    "Witch"
  ];
  if (playerCount >= 8) {
    fixed.push("Guard");
  }
  if (playerCount >= 9) {
    fixed.push("Hunter");
  }
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
  private readonly guardState = {
    protectedTargetId: null as string | null,
    lastProtectedTargetId: null as string | null
  };
  private readonly hunterShotsUsed = new Set<string>();
  private eventId = 0;
  private round = 0;
  private phase: Phase = "setup";
  private winner: Camp | null = null;
  private lastNightDeaths: string[] = [];
  private lastDiscussion: DiscussionRecord[] = [];
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
    const assignedPersonas = shuffle(
      Array.from({ length: this.config.playerCount }, (_, index) => personas[index % personas.length])
    );
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
        persona: assignedPersonas[index],
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
    this.guardState.protectedTargetId = null;
    this.phase = "night";
    yield this.emit("phase_changed", `Night ${this.round} begins.`);

    yield* this.runGuardAction();

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
        this.wolfHistory.push(`${wolf.name}: ${speech.message}`);
        yield this.emit("player_speech", speech.message, { visibility: "werewolf", speech: speech.message, ...speech.metadata }, wolf);
      }
    }

    this.phase = "night";
    const killTarget = await this.resolveWerewolfAttack(werewolves);
    if (killTarget) {
      yield this.emit("night_action", "The werewolves selected a victim.", { visibility: "private", action: "werewolf_attack" }, undefined, killTarget);
    }

    yield* this.runSeerAction();
    const savedTarget = yield* this.runWitchAction(killTarget);
    const guardBlockedAttack = Boolean(
      killTarget && savedTarget !== killTarget.id && this.guardState.protectedTargetId === killTarget.id
    );

    if (guardBlockedAttack && killTarget) {
      const guard = this.players.find((player) => player.role === "Guard");
      if (guard) {
        yield this.emit(
          "private_info",
          `${guard.name}'s protection stopped the attack on ${killTarget.name}.`,
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

    const deaths = new Map<string, string>();
    const addNightDeath = (playerId: string, cause: string) => {
      const existing = deaths.get(playerId);
      deaths.set(playerId, existing && existing !== cause ? "multiple" : cause);
    };

    if (killTarget && savedTarget !== killTarget.id && this.guardState.protectedTargetId !== killTarget.id) {
      addNightDeath(killTarget.id, "werewolf");
    }

    const poisonTarget = this.witchState.poisonTargetId
      ? this.requirePlayer(this.witchState.poisonTargetId)
      : null;
    if (poisonTarget) {
      addNightDeath(poisonTarget.id, "poison");
    }

    if (deaths.size === 0) {
      yield this.emit("death", "No one died during the night.", { cause: "no_death" });
      return;
    }

    const pendingDeaths = new Set(deaths.keys());
    for (const [id, cause] of deaths) {
      const player = this.requirePlayer(id);
      if (!player.alive) {
        continue;
      }
      player.alive = false;
      this.lastNightDeaths.push(id);
      pendingDeaths.delete(id);
      yield this.emit("death", `${player.name} died during the night.`, { cause, targetRole: player.role }, undefined, player);
      yield* this.runHunterShot(player, pendingDeaths);
    }
  }

  private async *runGuardAction(): AsyncGenerator<GameEvent> {
    const guard = this.alivePlayers().find((player) => player.role === "Guard");
    if (!guard) {
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
    const context = this.contextFor(guard, [
      "Choose one living player to protect from the werewolf attack tonight.",
      blocked ? `You cannot protect ${blocked} again because you protected them last night.` : "No one is blocked by consecutive protection."
    ]);
    const decision = await this.safeChooseTarget(guard, "Guard night protection", context, targets, false);
    if (!decision.targetId) {
      return;
    }

    const target = this.requirePlayer(decision.targetId);
    this.guardState.protectedTargetId = target.id;
    this.guardState.lastProtectedTargetId = target.id;
    guard.memories.push(`Round ${this.round}: protected ${target.name}. Reason: ${decision.reason}`);
    yield this.emit(
      "night_action",
      `${guard.name} protected ${target.name}.`,
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
    for (const wolf of werewolves) {
      const context = this.contextFor(wolf, [
        `Known werewolves: ${werewolves.map((player) => player.name).join(", ")}.`,
        "Vote for the player the werewolf team should kill tonight."
      ]);
      const decision = await this.safeChooseTarget(wolf, "Werewolf night kill vote", context, targets, false);
      if (decision.targetId) {
        votes.push({ voterId: wolf.id, targetId: decision.targetId, reason: decision.reason });
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
    const decision = await this.safeChooseTarget(seer, "Seer identity check", context, targets, false);
    if (!decision.targetId) {
      return;
    }

    const target = this.requirePlayer(decision.targetId);
    seer.seerResults[target.id] = target.camp;
    seer.memories.push(`Round ${this.round}: ${target.name} checked as ${target.camp}.`);
    yield this.emit(
      "private_info",
      `${seer.name} learned that ${target.name} is ${target.camp}.`,
      { visibility: "private", visibleTo: seer.id, action: "seer_check", result: target.camp },
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
        yield this.emit(
          "night_action",
          `${witch.name} used the save potion.`,
          { visibility: "private", action: "witch_save", savedTargetId: killTarget.id, savedTargetName: killTarget.name },
          witch,
          killTarget
        );
        return savedTarget;
      }
    }

    if (this.witchState.poisonPotion) {
      const poisonTargets = this.alivePlayers().filter((player) => player.id !== witch.id);
      const context = this.contextFor(witch, [
        "You may spend your only poison potion tonight, or skip.",
        killTarget ? `The werewolf victim is ${killTarget.name}.` : "No werewolf victim is known."
      ]);
      const decision = await this.safeChooseTarget(witch, "Witch poison potion", context, poisonTargets, true);
      if (decision.targetId) {
        const target = this.requirePlayer(decision.targetId);
        this.witchState.poisonPotion = false;
        this.witchState.poisonTargetId = target.id;
        witch.memories.push(`Round ${this.round}: poisoned ${target.name}.`);
        yield this.emit(
          "night_action",
          `${witch.name} used the poison potion.`,
          { visibility: "private", action: "witch_poison", poisonTargetId: target.id, poisonTargetName: target.name },
          witch,
          target
        );
      }
    }

    return savedTarget;
  }

  private async *runDay(): AsyncGenerator<GameEvent> {
    this.phase = "day_discussion";
    this.lastDiscussion = [];
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
      this.publicHistory.push(this.formatSpeechHistory(player, speech));
      this.lastDiscussion.push({
        playerId: player.id,
        playerName: player.name,
        message: speech.message,
        metadata: speech.metadata
      });
      yield this.emit("player_speech", speech.message, { speech: speech.message, ...speech.metadata }, player);
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
      const decision = await this.safeChooseTarget(voter, "Day elimination vote", context, targets, false);
      if (!decision.targetId) {
        continue;
      }
      votes.push({ voterId: voter.id, targetId: decision.targetId, reason: decision.reason });
      const target = this.requirePlayer(decision.targetId);
      voter.memories.push(`Round ${this.round}: voted for ${target.name}. Reason: ${decision.reason}`);
      yield this.emit(
        "vote_cast",
        `${voter.name} votes for ${target.name}. ${decision.reason}`,
        { reason: decision.reason },
        voter,
        target
      );
    }

    this.lastVotes = votes;
    if (votes.length === 0) {
      yield this.emit("vote_result", "No votes were cast.", { votes: [] });
      yield this.emitRoundSummary();
      return;
    }

    const counts = tallyVotes(votes);
    const candidates = topVoted(counts);
    yield this.emit("vote_result", "Vote totals are in.", {
      votes: this.voteDetails(votes),
      totals: [...counts.entries()].map(([targetId, count]) => ({
        targetId,
        targetName: this.requirePlayer(targetId).name,
        count
      }))
    });

    if (candidates.length !== 1) {
      yield this.emit("vote_result", "The vote is tied, so no one is eliminated.");
      yield this.emitRoundSummary();
      return;
    }

    const eliminated = this.requirePlayer(candidates[0]);
    eliminated.alive = false;
    yield this.emit(
      "death",
      `${eliminated.name} was eliminated by vote.`,
      { cause: "vote", targetRole: eliminated.role },
      undefined,
      eliminated
    );
    yield* this.runHunterShot(eliminated);
    yield this.emitRoundSummary();
  }

  private async *runHunterShot(hunter: Player, blockedTargetIds = new Set<string>(), chainDepth = 0): AsyncGenerator<GameEvent> {
    if (hunter.role !== "Hunter" || this.hunterShotsUsed.has(hunter.id)) {
      return;
    }

    const targets = this.alivePlayers().filter((player) => !blockedTargetIds.has(player.id));
    if (targets.length === 0) {
      return;
    }

    this.hunterShotsUsed.add(hunter.id);
    const legalTargetIds = new Set(targets.map((player) => player.id));
    const context = this.contextFor(hunter, [
      "You died as the Hunter and may shoot one living player before leaving the game.",
      `Legal shot targets: ${targets.map((player) => player.name).join(", ")}.`
    ]);
    const decision = await this.safeChooseTarget(hunter, "Hunter death shot", context, targets, false);
    if (!decision.targetId || !legalTargetIds.has(decision.targetId)) {
      return;
    }

    const target = this.requirePlayer(decision.targetId);
    if (!target.alive) {
      return;
    }

    target.alive = false;
    if (this.phase !== "voting") {
      this.lastNightDeaths.push(target.id);
    }
    hunter.memories.push(`Round ${this.round}: shot ${target.name}. Reason: ${decision.reason}`);
    yield this.emit(
      "death",
      `${target.name} was shot by Hunter ${hunter.name}.`,
      {
        cause: "hunter",
        hunterId: hunter.id,
        hunterName: hunter.name,
        targetRole: target.role,
        reason: decision.reason,
        chainDepth
      },
      hunter,
      target
    );
    yield* this.runHunterShot(target, blockedTargetIds, chainDepth + 1);
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

  private async safeSpeak(player: Player, task: string, context: string): Promise<AgentSpeech> {
    const agent = this.agents.get(player.id) ?? fallbackAgent;
    const input = {
      player,
      phase: this.phase,
      task,
      context,
      knownPlayers: this.players.map(({ id, name }) => ({ id, name })),
      publicHistory: this.publicHistory,
      privateHistory: player.memories
    };
    try {
      return await agent.speak(input);
    } catch (error) {
      player.memories.push(`LLM error during speech: ${String(error)}`);
      return fallbackAgent.speak(input);
    }
  }

  private async safeChooseTarget(
    player: Player,
    action: string,
    context: string,
    candidates: Player[],
    allowSkip: boolean
  ): Promise<TargetDecision> {
    const agent = this.agents.get(player.id) ?? fallbackAgent;
    const targetCandidates: TargetCandidate[] = candidates.map(({ id, name }) => ({ id, name }));
    const input = {
      player,
      phase: this.phase,
      action,
      context,
      candidates: targetCandidates,
      allowSkip
    };
    try {
      return await agent.chooseTarget(input);
    } catch (error) {
      player.memories.push(`LLM error during target choice: ${String(error)}`);
      return fallbackAgent.chooseTarget(input);
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

  private formatSpeechHistory(player: Player, speech: AgentSpeech): string {
    const parts = [`${player.name}: ${speech.message}`];
    if (speech.metadata.claims.length > 0) {
      parts.push(`Claims: ${speech.metadata.claims.map((claim) => this.formatClaimSummary(player.name, claim)).join("; ")}`);
    }
    if (speech.metadata.suspects.length > 0) {
      parts.push(
        `Suspects: ${speech.metadata.suspects.map((read) => `${read.targetName ?? read.targetId}${read.reason ? ` (${read.reason})` : ""}`).join(", ")}`
      );
    }
    if (speech.metadata.trusts.length > 0) {
      parts.push(
        `Trusts: ${speech.metadata.trusts.map((read) => `${read.targetName ?? read.targetId}${read.reason ? ` (${read.reason})` : ""}`).join(", ")}`
      );
    }
    return parts.join(" ");
  }

  private emitRoundSummary(): GameEvent {
    const summary = this.buildRoundSummary();
    return this.emit("round_summary", summary.message, summary.data);
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
      this.lastVotes.length > 0
        ? [...tallyVotes(this.lastVotes).entries()].map(([targetId, count]) => ({
            targetId,
            targetName: this.requirePlayer(targetId).name,
            count
          }))
        : [];

    const nightLine =
      nightDeaths.length > 0
        ? `Night: ${nightDeaths.map((death) => death.playerName).join(", ")} died.`
        : "Night: no deaths.";
    const shownClaims = claims.slice(0, 2);
    const claimLine =
      claims.length > 0
        ? `Claims: ${shownClaims.map((item) => this.formatClaimSummary(item.speakerName, item.claim)).join("; ")}${claims.length > shownClaims.length ? ` +${claims.length - shownClaims.length} more` : ""}.`
        : "Claims: none.";
    const readLine = `Reads: suspects ${this.formatReadLeaders(suspects)}; trusts ${this.formatReadLeaders(trusts)}.`;
    const sortedTotals = [...totals].sort((a, b) => b.count - a.count || a.targetName.localeCompare(b.targetName));
    const shownTotals = sortedTotals.slice(0, 3);
    const voteLine =
      shownTotals.length > 0
        ? `Votes: ${shownTotals.map((total) => `${total.targetName} ${total.count}`).join(", ")}${sortedTotals.length > shownTotals.length ? ` +${sortedTotals.length - shownTotals.length} more` : ""}.`
        : "Votes: none.";

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
      return "none";
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
    return ranked.length > shown.length ? `${text} +${ranked.length - shown.length} more` : text;
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

  private readDetails(kind: "suspects" | "trusts"): Array<{
    sourceId: string;
    sourceName: string;
    targetId: string;
    targetName: string;
    reason?: string;
    weight?: number;
  }> {
    return this.lastDiscussion.flatMap((record) =>
      record.metadata[kind].map((read) => ({
        sourceId: record.playerId,
        sourceName: record.playerName,
        targetId: read.targetId,
        targetName: read.targetName ?? this.requirePlayer(read.targetId).name,
        reason: read.reason,
        weight: read.weight
      }))
    );
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
    const roleText = claim.role ? `${speakerName} claims ${claim.role}` : `${speakerName} makes a claim`;
    const resultText = this.formatClaimResult(claim.result);
    const targetText = claim.targetName ? ` on ${claim.targetName}` : "";
    const campText = claim.camp ? ` as ${claim.camp}` : "";
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
    return `${result.targetName ?? result.targetId} checked ${result.camp}${roundText}`;
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
