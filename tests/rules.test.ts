import assert from "node:assert/strict";
import test from "node:test";
import { createDeathResolutionEffects, createLinkedDeathRecords, createNightDeathRecords } from "../src/game/rules/deaths";
import { resolveVoteElimination } from "../src/game/rules/elimination";
import { createNightActionPlan } from "../src/game/rules/night";
import { createRoles, normalizePlayerCount } from "../src/game/rules/presets";
import { getRoleDefinition, roleCamp, roleDeathTriggers } from "../src/game/rules/roles";
import {
  addVictoryClaims,
  applyStatusEffects,
  canUseAbilities,
  createCampAbilityDisableEffects,
  createInitialRuleState,
  createRuleState,
  expireStatuses
} from "../src/game/rules/state";
import { filterEligibleVotes, resolveVote, voteModifiersFromRuleState } from "../src/game/rules/voting";
import { checkLoverVictory, checkNeutralVictory, checkStandardVictory } from "../src/game/rules/victory";
import type { Player, Role, VoteRecord } from "../src/game/types";

function rulePlayer(id: string, role: Role, alive = true): Pick<Player, "id" | "role" | "camp" | "alive"> {
  return {
    id,
    role,
    camp: roleCamp(role),
    alive
  };
}

test("role presets preserve the compact low-player distribution", () => {
  assert.equal(normalizePlayerCount(5), 6);
  assert.equal(normalizePlayerCount(15), 15);
  assert.equal(normalizePlayerCount(16), 15);
  assert.equal(normalizePlayerCount(Number.NaN), 7);

  const expected = new Map<number, Partial<Record<Role, number>>>([
    [6, { Werewolf: 1, Seer: 1, Witch: 1, Villager: 3 }],
    [7, { Werewolf: 2, Seer: 1, Witch: 1, Villager: 3 }],
    [8, { Werewolf: 2, Seer: 1, Witch: 1, Guard: 1, Villager: 3 }],
    [9, { Werewolf: 2, Seer: 1, Witch: 1, Guard: 1, Hunter: 1, Raven: 1, Villager: 2 }]
  ]);

  for (const [count, roleCounts] of expected) {
    const roles = createRoles(count);
    assert.equal(roles.length, count);
    for (const [role, roleCount] of Object.entries(roleCounts)) {
      assert.equal(roles.filter((item) => item === role).length, roleCount);
    }
  }
});

test("compressed role presets unlock advanced roles across 10-14 players", () => {
  const expected = new Map<number, Partial<Record<Role, number>>>([
    [10, { Werewolf: 2, AlphaWolf: 1, Raven: 1, Villager: 2 }],
    [11, { Werewolf: 2, AlphaWolf: 1, Raven: 1, Idiot: 1, Villager: 2 }],
    [12, { Werewolf: 2, AlphaWolf: 1, Raven: 1, Idiot: 1, Elder: 1, Villager: 2 }],
    [13, { Werewolf: 2, AlphaWolf: 1, Raven: 1, Idiot: 1, Elder: 1, Lover: 2, Villager: 1 }],
    [14, { Werewolf: 2, AlphaWolf: 1, WolfBeauty: 1, Raven: 1, Idiot: 1, Elder: 1, Lover: 2, Villager: 1 }]
  ]);

  for (const [count, roleCounts] of expected) {
    const roles = createRoles(count);
    assert.equal(roles.length, count);
    for (const [role, roleCount] of Object.entries(roleCounts)) {
      assert.equal(roles.filter((item) => item === role).length, roleCount);
    }
  }
});

test("15 player role preset compresses every advanced role into the supported max table", () => {
  const roles = createRoles(15);

  assert.equal(roles.length, 15);
  assert.equal(roles.filter((role) => role === "Werewolf").length, 2);
  assert.equal(roles.filter((role) => role === "AlphaWolf").length, 1);
  assert.equal(roles.filter((role) => role === "WolfBeauty").length, 1);
  assert.equal(roles.filter((role) => role === "Seer").length, 1);
  assert.equal(roles.filter((role) => role === "Witch").length, 1);
  assert.equal(roles.filter((role) => role === "Guard").length, 1);
  assert.equal(roles.filter((role) => role === "Hunter").length, 1);
  assert.equal(roles.filter((role) => role === "Raven").length, 1);
  assert.equal(roles.filter((role) => role === "Idiot").length, 1);
  assert.equal(roles.filter((role) => role === "Elder").length, 1);
  assert.equal(roles.filter((role) => role === "Lover").length, 2);
  assert.equal(roles.filter((role) => role === "Jester").length, 1);
  assert.equal(roles.filter((role) => role === "Villager").length, 1);
});

test("night action plan is priority ordered and deduplicates team actions", () => {
  const plan = createNightActionPlan(["Witch", "Werewolf", "Guard", "Seer", "Seer", "Werewolf"]);

  assert.deepEqual(
    plan.map((step) => step.kind),
    ["guard_protect", "werewolf_discussion", "werewolf_attack", "seer_check", "seer_check", "witch_action"]
  );
  assert.equal(plan.filter((step) => step.kind === "werewolf_attack").length, 1);
  assert.equal(plan.find((step) => step.kind === "werewolf_attack")?.roles.length, 2);
  assert.equal(plan.filter((step) => step.kind === "seer_check").length, 2);
});

test("night action plan keeps actor ids for grouped and individual actions", () => {
  const plan = createNightActionPlan([
    { role: "Werewolf", playerId: "p1" },
    { role: "Werewolf", playerId: "p2" },
    { role: "Seer", playerId: "p3" }
  ]);

  assert.deepEqual(plan.find((step) => step.kind === "werewolf_attack")?.actorIds, ["p1", "p2"]);
  assert.deepEqual(plan.find((step) => step.kind === "seer_check")?.actorIds, ["p3"]);
});

test("night death records merge simultaneous causes and honor protection", () => {
  assert.deepEqual(
    createNightDeathRecords({
      werewolfTargetId: "p3",
      protectedTargetId: "p3",
      poisonTargetId: "p4"
    }),
    [{ playerId: "p4", cause: "poison" }]
  );

  assert.deepEqual(
    createNightDeathRecords({
      werewolfTargetId: "p3",
      poisonTargetId: "p3"
    }),
    [{ playerId: "p3", cause: "multiple" }]
  );
});

test("vote resolver reports ties, modifiers, and single eliminations", () => {
  const votes: VoteRecord[] = [
    { voterId: "p1", targetId: "p3" },
    { voterId: "p2", targetId: "p4" }
  ];

  assert.equal(resolveVote(votes).eliminatedId, null);
  assert.equal(resolveVote(votes).tied, true);

  const resolved = resolveVote(votes, [{ targetId: "p3", count: 1, sourceId: "raven" }]);
  assert.equal(resolved.eliminatedId, "p3");
  assert.equal(resolved.counts.get("p3"), 2);
});

test("standard victory checker keeps current village and werewolf win rules", () => {
  assert.equal(
    checkStandardVictory([
      rulePlayer("p1", "Werewolf", false),
      rulePlayer("p2", "Seer"),
      rulePlayer("p3", "Villager")
    ])?.camp,
    "village"
  );

  assert.equal(
    checkStandardVictory([
      rulePlayer("p1", "Werewolf"),
      rulePlayer("p2", "Villager")
    ])?.reason,
    "werewolf_parity"
  );

  assert.deepEqual(
    checkStandardVictory([
      rulePlayer("p1", "Werewolf", false),
      rulePlayer("p2", "Jester"),
      rulePlayer("p3", "Villager")
    ])?.winnerIds,
    ["p3"]
  );
});

test("lover victory checker reports lover camp without changing standard camp fallback", () => {
  const players = [rulePlayer("p1", "Lover"), rulePlayer("p2", "Lover"), rulePlayer("p3", "Werewolf", false)];
  const state = createInitialRuleState(players);
  const result = checkLoverVictory(players, state);

  assert.equal(result?.camp, "lover");
  assert.equal(result?.fallbackCamp, "village");
  assert.deepEqual(result?.winnerIds, ["p1", "p2"]);
});

test("role registry exposes death triggers without engine conditionals", () => {
  assert.deepEqual(roleDeathTriggers("Hunter"), [{ kind: "hunter_shot", once: true }]);
  assert.deepEqual(roleDeathTriggers("AlphaWolf"), [{ kind: "alpha_wolf_shot", once: true }]);
  assert.deepEqual(roleDeathTriggers("Villager"), []);
});

test("role registry models Jester as a neutral victory role without changing standard counts", () => {
  const definition = getRoleDefinition("Jester");

  assert.equal(definition.camp, "village");
  assert.equal(definition.victoryCamp, "neutral");
  assert.equal(definition.standardCampVictory, false);
  assert.deepEqual(definition.deathVictoryConditions, [{ cause: "vote", camp: "neutral", reason: "neutral_role_condition" }]);
  assert.ok(definition.tags.includes("neutral"));
  assert.equal(roleCamp("Jester"), "village");
});

test("rule state models Raven marks and no-vote status as vote modifiers", () => {
  const state = applyStatusEffects(createRuleState([{ id: "p1" }, { id: "p2" }, { id: "p3" }]), [
    { playerId: "p3", addStatuses: [{ kind: "raven_marked", sourceId: "p1", duration: "round" }] },
    { playerId: "p2", addStatuses: [{ kind: "no_vote", sourceId: "p3", duration: "game" }] }
  ]);
  const votes: VoteRecord[] = [
    { voterId: "p1", targetId: "p2" },
    { voterId: "p2", targetId: "p3" }
  ];

  assert.deepEqual(filterEligibleVotes(votes, state), [{ voterId: "p1", targetId: "p2" }]);

  const modifiers = voteModifiersFromRuleState(state);
  assert.deepEqual(modifiers, [{ targetId: "p3", count: 1, sourceId: "p1", reason: "raven_marked" }]);
  assert.equal(resolveVote(filterEligibleVotes(votes, state), modifiers).eliminatedId, null);

  const nextRoundState = expireStatuses(state, "round");
  assert.deepEqual(voteModifiersFromRuleState(nextRoundState), []);
  assert.deepEqual(filterEligibleVotes(votes, nextRoundState), [{ voterId: "p1", targetId: "p2" }]);
});

test("vote elimination hook supports Idiot-style reveal instead of death", () => {
  const state = applyStatusEffects(createRuleState([{ id: "p1" }]), [
    { playerId: "p1", addStatuses: [{ kind: "execution_escape", sourceId: "role", duration: "game" }] }
  ]);

  const first = resolveVoteElimination("p1", state);
  assert.equal(first.eliminated, false);
  assert.equal(first.cancelledBy, "execution_escape");

  const updated = applyStatusEffects(state, first.effects);
  assert.equal(resolveVoteElimination("p1", updated).eliminated, true);
});

test("death resolver hook supports lover and WolfBeauty-style chains", () => {
  const state = applyStatusEffects(createRuleState([{ id: "p1" }, { id: "p2" }, { id: "p3" }]), [
    { playerId: "p1", addStatuses: [{ kind: "lover", targetId: "p2", duration: "game" }] },
    { playerId: "p2", addStatuses: [{ kind: "charm_anchor", targetId: "p3", duration: "game" }] }
  ]);

  assert.deepEqual(createLinkedDeathRecords([{ playerId: "p1", cause: "vote" }], state), [
    { playerId: "p1", cause: "vote" },
    { playerId: "p2", cause: "lover", sourceId: "p1" },
    { playerId: "p3", cause: "wolf_beauty_charm", sourceId: "p2" }
  ]);

  assert.deepEqual(createLinkedDeathRecords([{ playerId: "p1", cause: "vote" }], state, { isAlive: (id) => id !== "p3" }), [
    { playerId: "p1", cause: "vote" },
    { playerId: "p2", cause: "lover", sourceId: "p1" }
  ]);
});

test("ability disable effects can model Elder-style village penalty", () => {
  const players = [
    rulePlayer("p1", "Seer"),
    rulePlayer("p2", "Villager"),
    rulePlayer("p3", "Werewolf"),
    rulePlayer("p4", "Witch", false),
    rulePlayer("p5", "Jester")
  ];
  const state = applyStatusEffects(createRuleState(players), createCampAbilityDisableEffects(players, "village", "elder"));

  assert.equal(canUseAbilities(state, "p1"), false);
  assert.equal(canUseAbilities(state, "p2"), true);
  assert.equal(canUseAbilities(state, "p3"), true);
  assert.equal(canUseAbilities(state, "p4"), true);
  assert.equal(canUseAbilities(state, "p5"), true);
});

test("death resolution effects can create neutral victory claims from vote death", () => {
  const players = [
    rulePlayer("p1", "Jester", false),
    rulePlayer("p2", "Werewolf"),
    rulePlayer("p3", "Villager")
  ];
  const effects = createDeathResolutionEffects({ playerId: "p1", cause: "vote" }, players[0], players);

  assert.deepEqual(effects, [
    {
      kind: "neutral_victory_claim",
      statusEffects: [],
      victoryClaims: [
        {
          camp: "neutral",
          reason: "neutral_role_condition",
          winnerIds: ["p1"],
          sourceId: "p1",
          sourceRole: "Jester"
        }
      ]
    }
  ]);

  const state = addVictoryClaims(createRuleState(players), effects.flatMap((effect) => effect.victoryClaims));
  const result = checkNeutralVictory(players, state);

  assert.equal(result?.camp, "neutral");
  assert.equal(result?.fallbackCamp, "werewolf");
  assert.deepEqual(result?.winnerIds, ["p1"]);
});
