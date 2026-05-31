import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRoundScript,
  parseRoundScript,
  raceFirstValid,
  renderDirectiveContextLines,
  type DirectorPlayerInfo
} from "../src/game/director";
import { buildPublicSpeechPlan } from "../src/game/speechPlanning";
import { roleCamp } from "../src/game/rules/roles";
import type { Persona } from "../src/game/types";

function player(id: string, role: Parameters<typeof roleCamp>[0], persona: Persona = "cautious", alive = true): DirectorPlayerInfo {
  return { id, name: id.toUpperCase(), role, camp: roleCamp(role), persona, alive };
}

const roster: DirectorPlayerInfo[] = [
  player("p1", "Villager"),
  player("p2", "Werewolf"),
  player("p3", "Seer"),
  player("p4", "Villager", "logical", false)
];

test("describe mode builds a deterministic script with no arc and a directive per living player", async () => {
  const script = await buildRoundScript({
    round: 1,
    language: "Japanese",
    model: "demo",
    provider: "demo",
    mode: "describe",
    players: roster,
    lastNightDeathNames: [],
    publicHistory: []
  });

  assert.equal(script.source, "deterministic");
  assert.equal(script.arc, "");
  assert.ok(script.beats.length > 0);
  // Only living players get a directive (p4 is dead).
  assert.deepEqual(Object.keys(script.directives).sort(), ["p1", "p2", "p3"]);
  assert.ok(script.directives.p2.intent.length > 0);
});

test("intermediate mode adds a tension arc", async () => {
  const script = await buildRoundScript({
    round: 1,
    language: "Japanese",
    model: "demo",
    provider: "demo",
    mode: "intermediate",
    players: roster,
    lastNightDeathNames: [],
    publicHistory: []
  });

  assert.equal(script.source, "deterministic");
  assert.ok(script.arc.length > 0, "intermediate mode should produce an arc");
});

test("renderDirectiveContextLines injects beats + secret plan, and the arc only for intermediate", async () => {
  const script = await buildRoundScript({
    round: 1,
    language: "English",
    model: "demo",
    provider: "demo",
    mode: "intermediate",
    players: roster,
    lastNightDeathNames: [],
    publicHistory: []
  });

  const intermediate = renderDirectiveContextLines(script, "p2", "intermediate", "English").join("\n");
  assert.match(intermediate, /Round threads:/);
  assert.match(intermediate, /Your secret plan for this round/);
  assert.match(intermediate, /Today's arc:/);

  // The same script rendered in describe mode hides the arc line.
  const describe = renderDirectiveContextLines(script, "p2", "describe", "English").join("\n");
  assert.match(describe, /Your secret plan for this round/);
  assert.doesNotMatch(describe, /Today's arc:/);
});

test("parsed scripts drop shared-frame beats/arc that leak a living player's hidden role", () => {
  const named: DirectorPlayerInfo[] = [
    { id: "p1", name: "サクラコ", role: "Villager", camp: roleCamp("Villager"), persona: "cautious", alive: true },
    { id: "p2", name: "ナギサ", role: "Werewolf", camp: roleCamp("Werewolf"), persona: "aggressive", alive: true },
    { id: "p3", name: "イオリ", role: "Seer", camp: roleCamp("Seer"), persona: "logical", alive: true }
  ];
  const raw = JSON.stringify({
    beats: [
      { id: "b1", summary: "サクラコは人狼なので吊る筋を作る" },
      { id: "b2", summary: "占い師が名乗る条件を全体で決める" }
    ],
    arc: "ナギサが人狼だと露呈する終盤に向けて緊張を高める",
    directives: [
      { playerId: "p1", intent: "様子を見る" },
      { playerId: "p2", intent: "疑いをそらす" },
      { playerId: "p3", intent: "整理役に回る" }
    ]
  });

  const script = parseRoundScript(raw, {
    round: 1,
    language: "Japanese",
    model: "demo",
    provider: "llm",
    mode: "intermediate",
    players: named,
    lastNightDeathNames: [],
    publicHistory: []
  });

  const summaries = script!.beats.map((beat) => beat.summary);
  assert.ok(!summaries.some((summary) => summary.includes("サクラコは人狼")), "role-revealing beat must be dropped");
  assert.ok(
    summaries.some((summary) => summary.includes("占い師が名乗る条件")),
    "a generic role-policy beat (no player attribution) should survive"
  );
  // The leaking arc is replaced with the safe deterministic arc (no player + role attribution).
  assert.ok(script!.arc.length > 0);
  assert.ok(!script!.arc.includes("ナギサが人狼"));
});

test("raceFirstValid returns the first non-null result and aborts the slower racers", async () => {
  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  const order: string[] = [];
  const result = await raceFirstValid(
    [
      // slow + valid
      () => new Promise((resolve) => setTimeout(() => { order.push("slow"); resolve("slow"); }, 40)),
      // fast + valid → should win
      () => new Promise((resolve) => setTimeout(() => { order.push("fast"); resolve("fast"); }, 5)),
      // fast but null → must not win
      () => new Promise((resolve) => setTimeout(() => { order.push("null"); resolve(null); }, 1))
    ],
    controllers
  );

  assert.equal(result, "fast", "the first racer to yield a non-null value wins");
  assert.equal(controllers[0].signal.aborted, true, "other racers are aborted");
  assert.equal(controllers[2].signal.aborted, true, "other racers are aborted");
  assert.equal(controllers[1].signal.aborted, false, "the winner is not aborted");
});

test("first-day plan propagates cancellation instead of silently using a deterministic plan", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    buildRoundScript({
      round: 1,
      language: "Japanese",
      model: "demo",
      provider: "llm",
      mode: "describe",
      players: roster,
      lastNightDeathNames: [],
      publicHistory: [],
      abortSignal: controller.signal
    }),
    "an aborted round-1 build must reject, not resolve to a deterministic script"
  );
});

test("raceFirstValid resolves null when every racer fails or returns null", async () => {
  const controllers = [new AbortController(), new AbortController()];
  const result = await raceFirstValid(
    [
      () => Promise.resolve(null),
      () => Promise.reject(new Error("boom"))
    ],
    controllers
  );
  assert.equal(result, null, "no usable result → null (caller falls back to deterministic)");
});

test("suppressForwardMove disables the stance-forcing lever", () => {
  const base = {
    phase: "day_discussion" as const,
    // Round 2 so this isolates the suppressForwardMove lever from the separate
    // round-one opening-turn relaxation (which also drops requiresForwardMove).
    round: 2,
    discussionPass: 1,
    players: [],
    lastNightDeaths: [],
    legalPlayers: [{ id: "p1", name: "P1" }],
    language: "Japanese"
  };

  assert.equal(buildPublicSpeechPlan(base).requiresForwardMove, true);
  assert.equal(buildPublicSpeechPlan({ ...base, suppressForwardMove: true }).requiresForwardMove, false);
});
