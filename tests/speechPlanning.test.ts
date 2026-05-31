import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPublicSpeechPlan,
  firstDayOpeningMove,
  renderPublicSpeechDiversityContext,
  renderPublicSpeechPlan,
  reviewSpeechAgainstPlan,
  reviewSpeechTimeline
} from "../src/game/speechPlanning";
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
    language: "Japanese",
    firstDayOpeningMove: firstDayOpeningMove("state_vote_criteria", "Japanese")
  });

  assert.equal(plan.lastNightDeaths[0].publicCauseLabel, null);
  assert.equal(plan.requiresForwardMove, true);
  assert.ok(plan.possibleNightDeathCauses.some((cause) => cause.kind === "witch_poison"));
  assert.ok(plan.possibleNightDeathCauses.some((cause) => cause.kind === "hunter_death_shot"));

  const hiddenCausePlan = buildPublicSpeechPlan({
    phase: "day_discussion",
    round: 2,
    discussionPass: 1,
    players,
    lastNightDeaths: [
      { playerId: "p2", cause: "hunter", sourceId: "p4" },
      { playerId: "p3", cause: "lover", sourceId: "p2" }
    ],
    legalPlayers,
    language: "Japanese"
  });

  assert.deepEqual(hiddenCausePlan.lastNightDeaths.map((death) => death.publicCauseLabel), [null, null]);

  const rendered = renderPublicSpeechPlan(plan, "Japanese").join("\n");
  assert.match(rendered, /公開知識/);
  assert.match(rendered, /初日特別モード/);
  assert.match(rendered, /投票基準を出す/);
  assert.match(rendered, /公開上の死因: 不明/);
  assert.match(rendered, /魔女の毒薬/);
  assert.match(rendered, /自分の疑い・信頼・投票候補/);
  assert.match(rendered, /質問、様子見、今後見る点だけで終えず/);
  assert.match(rendered, /死因候補を並べるだけで終わらず/);
});

test("public speech diversity context summarizes used reads and asks for a new angle", () => {
  const rendered = renderPublicSpeechDiversityContext(
    [
      {
        playerId: "p1",
        playerName: "ソウタ",
        metadata: {
          claims: [],
          suspects: [{ targetId: "p5", targetName: "レン", reason: "自分の前巡の読み", weight: 0.5 }],
          trusts: []
        }
      },
      {
        playerId: "p2",
        playerName: "アカネ",
        metadata: {
          claims: [],
          suspects: [{ targetId: "p2", targetName: "ミナト", reason: "返答が硬い", weight: 0.6 }],
          trusts: []
        }
      },
      {
        playerId: "p3",
        playerName: "ユイ",
        metadata: {
          claims: [],
          suspects: [{ targetId: "p2", targetName: "ミナト", reason: "返答が硬い", weight: 0.4 }],
          trusts: [{ targetId: "p4", targetName: "ガク", reason: "投票理由が自然", weight: 0.3 }]
        }
      }
    ],
    "Japanese",
    { excludePlayerId: "p1" }
  ).join("\n");

  assert.match(rendered, /他プレイヤーが直近で既に出した読み/);
  assert.doesNotMatch(rendered, /ソウタ/);
  assert.match(rendered, /アカネ -> ミナト: 疑い（返答が硬い）/);
  assert.match(rendered, /ユイ -> ガク: 信頼（投票理由が自然）/);
  assert.match(rendered, /同じ対象と同じ理由を繰り返すだけにしない/);
  assert.match(rendered, /別の根拠/);
});

test("first-day opening moves can satisfy special opening review rules", () => {
  const legalPlayers: TargetCandidate[] = [
    { id: "p2", name: "ミナト" },
    { id: "p3", name: "ユイ" }
  ];
  const selfDefensePlan = buildPublicSpeechPlan({
    phase: "day_discussion",
    round: 1,
    discussionPass: 1,
    players: [player("Villager", "p1", "アカネ"), player("Villager", "p2", "ミナト"), player("Witch", "p3", "ユイ")],
    lastNightDeaths: [],
    legalPlayers,
    language: "Japanese",
    firstDayOpeningMove: firstDayOpeningMove("overstate_village_side", "Japanese")
  });
  const selfDefense = reviewSpeechAgainstPlan(
    {
      messages: ["私は人間側なので、初日に変な疑いで吊られるのは避けたいです。"],
      metadata
    },
    selfDefensePlan,
    legalPlayers,
    "Japanese"
  );
  assert.equal(selfDefense.ok, true);

  const reactionPlan = buildPublicSpeechPlan({
    phase: "day_discussion",
    round: 1,
    discussionPass: 1,
    players: [player("Villager", "p1", "アカネ"), player("Villager", "p2", "ミナト"), player("Witch", "p3", "ユイ")],
    lastNightDeaths: [],
    legalPlayers,
    language: "Japanese",
    firstDayOpeningMove: firstDayOpeningMove("tentative_reaction_read", "Japanese")
  });
  const reaction = reviewSpeechTimeline(
    {
      messages: ["ミナトさんの反応が少し硬く見えるので、初日は暫定材料として返答を見たいです。"],
      metadata
    },
    [],
    legalPlayers,
    "day_discussion",
    "Japanese",
    reactionPlan
  );
  assert.equal(reaction.ok, true);

  for (const message of ["ミナトさんの先ほどの動きが怪しく見えます。", "ミナトさんの今の反応が不自然です。"]) {
    const observedPastAction = reviewSpeechTimeline(
      {
        messages: [message],
        metadata
      },
      [],
      legalPlayers,
      "day_discussion",
      "Japanese",
      reactionPlan
    );
    assert.equal(observedPastAction.ok, false);
  }
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

test("round-one opening turn does not force a stance and opens with observation", () => {
  const legalPlayers: TargetCandidate[] = [
    { id: "p2", name: "シオン" },
    { id: "p3", name: "キリエ" }
  ];
  const plan = buildPublicSpeechPlan({
    phase: "day_discussion",
    round: 1,
    discussionPass: 1,
    players: [player("Villager", "p1", "アカネ"), player("Villager", "p2", "シオン"), player("Seer", "p3", "キリエ")],
    lastNightDeaths: [],
    legalPlayers,
    language: "Japanese"
  });

  // The opening turn has no public material yet, so the after-the-fact stance
  // forcing is off and the intent invites a substantive non-conclusory opening
  // (self-intro, role reveal policy, organizing) instead of an unfounded suspicion.
  assert.equal(plan.requiresForwardMove, false);
  assert.ok(plan.intents.some((item) => item.kind === "open_first_day"));

  // A substantive non-stance opening (self-introduction) is accepted without
  // being forced into a suspicion or vote.
  const selfIntro = reviewSpeechAgainstPlan(
    {
      messages: ["はじめまして、今日はみんなの話を聞きながら落ち着いて進めたいです"],
      metadata
    },
    plan,
    legalPlayers,
    "Japanese"
  );
  assert.equal(selfIntro.ok, true);

  const coPolicy = reviewSpeechAgainstPlan(
    {
      messages: ["占い師が今日名乗る条件だけ先に決めたいです"],
      metadata
    },
    plan,
    legalPlayers,
    "Japanese"
  );
  assert.equal(coPolicy.ok, true);
});

test("opening turn requires substantive content and rejects vacuous openings", () => {
  const legalPlayers: TargetCandidate[] = [
    { id: "p2", name: "シオン" },
    { id: "p3", name: "キリエ" }
  ];
  const plan = buildPublicSpeechPlan({
    phase: "day_discussion",
    round: 1,
    discussionPass: 1,
    players: [player("Villager", "p1", "アカネ"), player("Villager", "p2", "シオン"), player("Seer", "p3", "キリエ")],
    lastNightDeaths: [],
    legalPlayers,
    language: "Japanese"
  });
  assert.equal(plan.opensFirstDay, true);

  // The reported 様子見/保留 family AND other content-free patterns (not just the
  // blocklisted words) are rejected by the positive-substance check.
  for (const filler of [
    "今の流れは様子見する",
    "今の状況はちょっと保留だ",
    "今の状況は様子見",
    "とりあえず様子を見る",
    "今の状況はまだ保留",
    "今日はみんなの出方をまず見たいです",
    "特に今は何もないです",
    "まだ何とも言えないですね"
  ]) {
    const review = reviewSpeechAgainstPlan({ messages: [filler], metadata }, plan, legalPlayers, "Japanese");
    assert.equal(review.ok, false, `expected vacuous opening to be rejected: ${filler}`);
    assert.match(review.revisionHint ?? "", /自己紹介|中身/);
  }

  // Each intended opening topic counts as substance: self-intro, role policy,
  // vote criteria, concrete observation, setup organizing, and engaging a player.
  for (const substantive of [
    "はじめまして、今日は落ち着いて進めたいです",
    "占い師が今日名乗る条件を先に決めませんか",
    "今日は発言の具体性を投票基準にしたいです",
    "今日はキリエの出方に注目したいです",
    "まずは配役の構成と進め方を整理しませんか",
    "シオンさん、最初の意気込みを聞かせてください"
  ]) {
    const review = reviewSpeechAgainstPlan({ messages: [substantive], metadata }, plan, legalPlayers, "Japanese");
    assert.equal(review.ok, true, `expected substantive opening to pass: ${substantive}`);
  }
});

test("stance forcing returns once real material exists (round one second pass)", () => {
  const legalPlayers: TargetCandidate[] = [
    { id: "p2", name: "シオン" },
    { id: "p3", name: "キリエ" }
  ];
  const plan = buildPublicSpeechPlan({
    phase: "day_discussion",
    round: 1,
    discussionPass: 2,
    players: [player("Villager", "p1", "アカネ"), player("Villager", "p2", "シオン"), player("Seer", "p3", "キリエ")],
    lastNightDeaths: [],
    legalPlayers,
    language: "Japanese"
  });

  // Once a pass of public statements exists, a forward move is required again so
  // the relaxation stays scoped to the opening turn.
  assert.equal(plan.requiresForwardMove, true);

  const watchOnly = reviewSpeechAgainstPlan(
    {
      messages: ["シオンとキリエから動きが出たら見たい"],
      metadata
    },
    plan,
    legalPlayers,
    "Japanese"
  );
  assert.equal(watchOnly.ok, false);
  assert.match(watchOnly.issues.join("\n"), /visible stance/);

  const visibleTrust = reviewSpeechAgainstPlan(
    {
      messages: ["シオンは信頼できると思います", "キリエは保留寄りです"],
      metadata
    },
    plan,
    legalPlayers,
    "Japanese"
  );
  assert.equal(visibleTrust.ok, true);
});

test("timeline review rejects unseen prior statements on empty first-day history", () => {
  const legalPlayers: TargetCandidate[] = [
    { id: "p2", name: "アカネ" },
    { id: "p3", name: "イオリ" }
  ];

  const unseenReference = reviewSpeechTimeline(
    {
      messages: ["アカネの言う通り、イオリの煙幕っぽい動きは気になります。"],
      metadata
    },
    [],
    legalPlayers,
    "day_discussion",
    "Japanese"
  );
  assert.equal(unseenReference.ok, false);
  assert.match(unseenReference.issues.join("\n"), /unseen prior public speech/);
  assert.match(unseenReference.revisionHint ?? "", /見えている材料なしでも話せる議題/);

  const characterTendency = reviewSpeechTimeline(
    {
      messages: ["イオリは場を揺らす話し方をしがちなので、初日は保留より疑い寄りで見ます。"],
      metadata
    },
    [],
    legalPlayers,
    "day_discussion",
    "Japanese"
  );
  assert.equal(characterTendency.ok, true);
});

test("timeline review checks referenced speakers against visible history", () => {
  const legalPlayers: TargetCandidate[] = [
    { id: "p2", name: "アカネ" },
    { id: "p3", name: "イオリ" }
  ];

  const existingSpeakerReference = reviewSpeechTimeline(
    {
      messages: ["アカネの言う通り、今日は強い断定を避けます。"],
      metadata
    },
    ["アカネ: 初日は強い断定を避けたいです。"],
    legalPlayers,
    "day_discussion",
    "Japanese"
  );
  assert.equal(existingSpeakerReference.ok, true);

  const unseenOtherPlayerReference = reviewSpeechTimeline(
    {
      messages: ["アカネの言う通り、イオリの発言が曖昧なのは気になります。"],
      metadata
    },
    ["アカネ: 初日は強い断定を避けたいです。"],
    legalPlayers,
    "day_discussion",
    "Japanese"
  );
  assert.equal(unseenOtherPlayerReference.ok, false);
  assert.match(unseenOtherPlayerReference.issues.join("\n"), /unseen prior public speech/);

  const naturalCharacterRole = reviewSpeechTimeline(
    {
      messages: ["アカネは整理役として信頼寄りです。イオリは初日は保留より疑い寄りで見ます。"],
      metadata
    },
    [],
    legalPlayers,
    "day_discussion",
    "Japanese"
  );
  assert.equal(naturalCharacterRole.ok, true);
});
