import assert from "node:assert/strict";
import test from "node:test";
import { buildPublicSpeechPlan, renderPublicSpeechPlan, reviewSpeechAgainstPlan } from "../src/game/speechPlanning";
import type { AgentSpeech, Camp, Persona, Player, Role, TargetCandidate } from "../src/game/types";

function player(role: Role, id: string, name: string, persona: Persona = "logical"): Player {
  const camp: Camp = role === "Werewolf" || role === "AlphaWolf" || role === "WolfBeauty" ? "werewolf" : "village";
  return {
    id,
    name,
    role,
    camp,
    persona,
    alive: true,
    model: "test",
    memories: [],
    seerResults: {},
    seerResultRounds: {},
    witch: {
      savePotion: role === "Witch",
      poisonPotion: role === "Witch"
    }
  };
}

const metadata: AgentSpeech["metadata"] = {
  claims: [],
  suspects: [],
  trusts: []
};

test("public speech plan renders public death knowledge separately from speech intent", () => {
  const players = [
    player("Werewolf", "p1", "アカネ"),
    player("Villager", "p2", "ミナト"),
    player("Witch", "p3", "ユイ"),
    player("Hunter", "p4", "ガク")
  ];
  const legalPlayers: TargetCandidate[] = [
    { id: "p2", name: "ミナト" },
    { id: "p3", name: "ユイ" },
    { id: "p4", name: "ガク" }
  ];

  const plan = buildPublicSpeechPlan({
    phase: "day_discussion",
    round: 2,
    discussionPass: 1,
    players,
    lastNightDeaths: [{ playerId: "p1", cause: "werewolf" }],
    legalPlayers,
    language: "Japanese"
  });

  assert.equal(plan.lastNightDeaths[0].publicCauseLabel, null);
  assert.equal(plan.requiresForwardMove, true);
  assert.ok(plan.possibleNightDeathCauses.some((cause) => cause.kind === "witch_poison"));
  assert.ok(plan.possibleNightDeathCauses.some((cause) => cause.kind === "hunter_death_shot"));

  const rendered = renderPublicSpeechPlan(plan, "Japanese").join("\n");
  assert.match(rendered, /公開知識/);
  assert.match(rendered, /公開上の死因: 不明/);
  assert.match(rendered, /魔女の毒薬/);
  assert.match(rendered, /自分の疑い・信頼・保留/);
  assert.match(rendered, /死因候補を並べるだけで終わらず/);
});

test("speech plan review rejects death-cause recap that does not advance discussion", () => {
  const legalPlayers: TargetCandidate[] = [
    { id: "p2", name: "ミナト" },
    { id: "p3", name: "ユイ" }
  ];
  const plan = buildPublicSpeechPlan({
    phase: "day_discussion",
    round: 2,
    discussionPass: 1,
    players: [player("Werewolf", "p1", "アカネ"), player("Villager", "p2", "ミナト"), player("Witch", "p3", "ユイ")],
    lastNightDeaths: [{ playerId: "p1", cause: "werewolf" }],
    legalPlayers,
    language: "Japanese"
  });

  const recapOnly = reviewSpeechAgainstPlan(
    {
      messages: ["アカネの死から推測できるのは、噛まれたか、あるいは特殊な死因があったかの二択です。"],
      metadata
    },
    plan,
    legalPlayers,
    "Japanese"
  );
  assert.equal(recapOnly.ok, false);
  assert.match(recapOnly.issues.join("\n"), /night-death recap/);

  const livingNameOnly = reviewSpeechAgainstPlan(
    {
      messages: ["アカネの死亡を踏まえて、ミナトさんについて話します。"],
      metadata
    },
    plan,
    legalPlayers,
    "Japanese"
  );
  assert.equal(livingNameOnly.ok, false);

  const forwardWordsOnly = reviewSpeechAgainstPlan(
    {
      messages: ["アカネの死亡から、今日は投票理由を考えます。"],
      metadata
    },
    plan,
    legalPlayers,
    "Japanese"
  );
  assert.equal(forwardWordsOnly.ok, false);

  const forwardMove = reviewSpeechAgainstPlan(
    {
      messages: ["ミナトさんは昨日の投票理由とアカネさんの死亡がつながりすぎていて、今日は疑い寄りで見ます。"],
      metadata
    },
    plan,
    legalPlayers,
    "Japanese"
  );
  assert.equal(forwardMove.ok, true);
});
