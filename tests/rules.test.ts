import assert from "node:assert/strict";
import test from "node:test";
import { createNightDeathRecords } from "../src/game/rules/deaths";
import { createNightActionPlan } from "../src/game/rules/night";
import { createRoles, normalizePlayerCount } from "../src/game/rules/presets";
import { roleCamp, roleDeathTriggers } from "../src/game/rules/roles";
import { resolveVote } from "../src/game/rules/voting";
import { checkStandardVictory } from "../src/game/rules/victory";
import type { Player, Role, VoteRecord } from "../src/game/types";

function rulePlayer(id: string, role: Role, alive = true): Pick<Player, "id" | "role" | "camp" | "alive"> {
  return {
    id,
    role,
    camp: roleCamp(role),
    alive
  };
}

test("role presets preserve the current 6-9 player distribution", () => {
  assert.equal(normalizePlayerCount(5), 6);
  assert.equal(normalizePlayerCount(20), 9);
  assert.equal(normalizePlayerCount(Number.NaN), 7);

  const expected = new Map<number, Partial<Record<Role, number>>>([
    [6, { Werewolf: 1, Seer: 1, Witch: 1, Villager: 3 }],
    [7, { Werewolf: 2, Seer: 1, Witch: 1, Villager: 3 }],
    [8, { Werewolf: 2, Seer: 1, Witch: 1, Guard: 1, Villager: 3 }],
    [9, { Werewolf: 2, Seer: 1, Witch: 1, Guard: 1, Hunter: 1, Villager: 3 }]
  ]);

  for (const [count, roleCounts] of expected) {
    const roles = createRoles(count);
    assert.equal(roles.length, count);
    for (const [role, roleCount] of Object.entries(roleCounts)) {
      assert.equal(roles.filter((item) => item === role).length, roleCount);
    }
  }
});

test("night action plan is priority ordered and deduplicates team actions", () => {
  const plan = createNightActionPlan(["Witch", "Werewolf", "Guard", "Seer", "Werewolf"]);

  assert.deepEqual(
    plan.map((step) => step.kind),
    ["guard_protect", "werewolf_discussion", "werewolf_attack", "seer_check", "witch_action"]
  );
  assert.equal(plan.filter((step) => step.kind === "werewolf_attack").length, 1);
  assert.equal(plan.find((step) => step.kind === "werewolf_attack")?.roles.length, 2);
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
});

test("role registry exposes death triggers without engine conditionals", () => {
  assert.deepEqual(roleDeathTriggers("Hunter"), [{ kind: "hunter_shot", once: true }]);
  assert.deepEqual(roleDeathTriggers("Villager"), []);
});
