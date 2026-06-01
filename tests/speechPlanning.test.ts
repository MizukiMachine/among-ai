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

test("later-day agenda scheduler spreads concrete evidence focus across first-pass speakers", () => {
  const players = [
    player("Villager", "p1", "セナ"),
    player("Seer", "p2", "ノゾミ"),
    player("Villager", "p3", "アキオミ"),
    player("Witch", "p4", "イオリ"),
    player("Villager", "p5", "コハル")
  ];
  const legalPlayers: TargetCandidate[] = players.slice(1).map(({ id, name }) => ({ id, name }));
  const previousVotes = [
    { voterId: "p1", targetId: "p3" },
    { voterId: "p2", targetId: "p3" },
    { voterId: "p3", targetId: "p5" },
    { voterId: "p4", targetId: "p5" },
    { voterId: "p5", targetId: "p3" }
  ];
  const publicHistory = [
    "ノゾミ: 占い師として出ます。アキオミは人狼判定です。",
    "主張: ノゾミが占い師を主張 対象:アキオミ 人狼判定",
    "第1ラウンド投票: セナ -> アキオミ、ノゾミ -> アキオミ、アキオミ -> コハル、イオリ -> コハル、コハル -> アキオミ。"
  ];

  const speakerOrder = [players[1], players[2], players[3], players[4], players[0]];
  const plans = speakerOrder.map((speaker) =>
    buildPublicSpeechPlan({
      phase: "day_discussion",
      round: 2,
      discussionPass: 1,
      players,
      lastNightDeaths: [{ playerId: "p1", cause: "werewolf" }],
      legalPlayers,
      language: "Japanese",
      speakerId: speaker.id,
      publicHistory,
      previousVotes
    })
  );

  assert.deepEqual(
    plans.map((plan) => plan.discussionAgenda?.kind),
    [
      "later_day_black_result",
      "later_day_claim_review",
      "later_day_vote_review",
      "later_day_night_result",
      "later_day_read_update"
    ]
  );
  assert.match(renderPublicSpeechPlan(plans[0], "Japanese").join("\n"), /黒判定をどう扱うか/);
  assert.match(renderPublicSpeechPlan(plans[2], "Japanese").join("\n"), /前日の投票を材料/);
  assert.match(renderPublicSpeechPlan(plans[2], "Japanese").join("\n"), /得票上位: アキオミ3票、コハル2票/);
  assert.doesNotMatch(renderPublicSpeechPlan(plans[2], "Japanese").join("\n"), /身内票|理由の薄い票/);
  assert.match(renderPublicSpeechPlan(plans[3], "Japanese").join("\n"), /昨夜の死亡: セナ/);
  assert.match(renderPublicSpeechPlan(plans[4], "Japanese").join("\n"), /前日から見方が変わった相手/);
});

test("later-day agenda scheduler does not treat claim-policy talk as a Seer claim", () => {
  const players = [
    player("Villager", "p1", "セナ"),
    player("Seer", "p2", "ノゾミ"),
    player("Villager", "p3", "アキオミ")
  ];
  const plan = buildPublicSpeechPlan({
    phase: "day_discussion",
    round: 2,
    discussionPass: 1,
    players,
    lastNightDeaths: [],
    legalPlayers: players.slice(1).map(({ id, name }) => ({ id, name })),
    language: "Japanese",
    speakerId: "p1",
    publicHistory: ["ノゾミ: 占い師が今日名乗る条件だけ先に決めたいです。"]
  });

  assert.notEqual(plan.discussionAgenda?.kind, "later_day_claim_review");
  assert.doesNotMatch(renderPublicSpeechPlan(plan, "Japanese").join("\n"), /役職主張を検証する/);
});

test("later-day black-result agenda ignores dead black targets", () => {
  const players = [
    player("Villager", "p1", "セナ"),
    player("Seer", "p2", "ノゾミ"),
    { ...player("Villager", "p3", "アキオミ"), alive: false },
    player("Witch", "p4", "イオリ")
  ];
  const plan = buildPublicSpeechPlan({
    phase: "day_discussion",
    round: 4,
    discussionPass: 1,
    players,
    lastNightDeaths: [{ playerId: "p3", cause: "vote" }],
    legalPlayers: players.filter((candidate) => candidate.alive && candidate.id !== "p1").map(({ id, name }) => ({ id, name })),
    language: "Japanese",
    speakerId: "p1",
    publicHistory: [
      "ノゾミ: 占い師として出ます。アキオミは人狼判定です。",
      "主張: ノゾミが占い師を主張 対象:アキオミ 人狼判定"
    ],
    previousVotes: []
  });
  const rendered = renderPublicSpeechPlan(plan, "Japanese").join("\n");

  assert.notEqual(plan.discussionAgenda?.kind, "later_day_black_result");
  assert.doesNotMatch(rendered, /黒判定をどう扱うか/);
});

test("later-day no-death agenda avoids certainty and points back to visible reactions", () => {
  const players = [
    player("Villager", "p1", "セナ"),
    player("Werewolf", "p2", "ノゾミ"),
    player("Guard", "p3", "アキオミ")
  ];
  const plan = buildPublicSpeechPlan({
    phase: "day_discussion",
    round: 3,
    discussionPass: 1,
    players,
    lastNightDeaths: [],
    legalPlayers: players.slice(1).map(({ id, name }) => ({ id, name })),
    language: "Japanese",
    speakerId: "p3",
    publicHistory: ["第2ラウンド投票: セナ -> ノゾミ、ノゾミ -> アキオミ。"],
    previousVotes: []
  });
  const rendered = renderPublicSpeechPlan(plan, "Japanese").join("\n");

  assert.equal(plan.discussionAgenda?.kind, "later_day_night_result");
  assert.match(rendered, /昨夜は死亡なし/);
  assert.match(rendered, /護衛成功、魔女の救済、襲撃先選びを断定せず/);
  assert.match(rendered, /誰の反応・役職主張・投票理由を見直すか/);
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
      messages: ["ミナトさんに先に理由を聞きます。初日は理由を出せない人を疑い寄りで見ます。"],
      metadata
    },
    [],
    legalPlayers,
    "day_discussion",
    "Japanese",
    reactionPlan
  );
  assert.equal(reaction.ok, true);

  const wolfHumanClaimPlan = buildPublicSpeechPlan({
    phase: "day_discussion",
    round: 1,
    discussionPass: 1,
    players: [player("Werewolf", "p1", "アカネ"), player("Villager", "p2", "ミナト"), player("Witch", "p3", "ユイ")],
    lastNightDeaths: [],
    legalPlayers,
    language: "Japanese",
    firstDayOpeningMove: firstDayOpeningMove("wolf_human_side_claim", "Japanese")
  });
  const wolfHumanClaim = reviewSpeechAgainstPlan(
    {
      messages: ["俺は人間側として村を守る。理由を出さずに様子見する人は投票候補に入れる"],
      metadata
    },
    wolfHumanClaimPlan,
    legalPlayers,
    "Japanese"
  );
  assert.equal(wolfHumanClaim.ok, true);

  const wolfFakeRolePlan = buildPublicSpeechPlan({
    phase: "day_discussion",
    round: 1,
    discussionPass: 1,
    players: [player("Werewolf", "p1", "アカネ"), player("Villager", "p2", "ミナト"), player("Witch", "p3", "ユイ")],
    lastNightDeaths: [],
    legalPlayers,
    language: "Japanese",
    firstDayOpeningMove: firstDayOpeningMove("wolf_fake_role_claim", "Japanese")
  });
  const wolfFakeRole = reviewSpeechAgainstPlan(
    {
      messages: ["私は占い師です。黒結果が出るまでは結果を伏せます。今日は誰がその条件を嫌がるか見たい"],
      metadata
    },
    wolfFakeRolePlan,
    legalPlayers,
    "Japanese"
  );
  assert.equal(wolfFakeRole.ok, true);

  for (const message of [
    "ミナトさんの反応が少し硬く見えるので、初日は暫定材料として返答を見たいです。",
    "ミナトさんの先ほどの動きが怪しく見えます。",
    "ミナトさんの今の反応が不自然です。"
  ]) {
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

test("speech timeline rejects saying a visible speaker has not spoken", () => {
  const legalPlayers: TargetCandidate[] = [
    { id: "p2", name: "ノゾミ" },
    { id: "p3", name: "ユイ" }
  ];
  const review = reviewSpeechTimeline(
    {
      messages: ["ノゾミさんはまだ発言していないので、投票候補に入れます"],
      metadata
    },
    ["ノゾミ: 今は役職方針を伏せて、投票理由を見ます"],
    legalPlayers,
    "day_discussion",
    "Japanese"
  );

  assert.equal(review.ok, false);
  assert.match(review.issues.join(","), /visibly speaking player/);
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

test("round-one opening turn does not force hard evidence but must actively move the table", () => {
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

  // The opening turn has no public material yet, so hard evidence is not forced,
  // but the intent should still push an agenda instead of waiting for others.
  assert.equal(plan.requiresForwardMove, false);
  assert.ok(plan.intents.some((item) => item.kind === "open_first_day"));

  // A self-introduction is accepted only when it adds an action for the table.
  const selfIntro = reviewSpeechAgainstPlan(
    {
      messages: ["はじめまして、今日は全員の投票基準を先に出したいです"],
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
    "まだ何とも言えないですね",
    "とりあえず状況を整理したいから、もう少し話を聞く",
    "まだ状況が見えないから、今は保留させて",
    "今の状況から動く理由がない、もう少し様子を見る",
    "様子見はしない",
    "今日はキリエの出方に注目したいです",
    "キリエさん、初日なので理由だけ聞かせてください"
  ]) {
    const review = reviewSpeechAgainstPlan({ messages: [filler], metadata }, plan, legalPlayers, "Japanese");
    assert.equal(review.ok, false, `expected vacuous opening to be rejected: ${filler}`);
    assert.match(review.revisionHint ?? "", /受け身|投票基準|名指し質問/);
  }

  // Each intended opening topic counts as substance: active self-intro, role
  // policy, vote criteria, named pressure, setup organizing, and engagement.
  for (const substantive of [
    "はじめまして、今日は全員の投票基準を先に出したいです",
    "占い師が今日名乗る条件を先に決めませんか",
    "今日は発言の具体性を投票基準にしたいです",
    "キリエさん、最初の投票基準を聞かせてください",
    "まずは配役の構成と進め方を整理しませんか",
    "シオンさん、占い師が名乗る条件をどう見ますか"
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
  assert.match(unseenReference.revisionHint ?? "", /材料なしでも自分から動かせる議題/);

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

test("timeline review rejects invented Seer claims when no claim is visible", () => {
  const legalPlayers: TargetCandidate[] = [
    { id: "p2", name: "アカネ" },
    { id: "p3", name: "イオリ" }
  ];

  const inventedOpeningClaim = reviewSpeechTimeline(
    {
      messages: ["占い師を名乗った人がいるけど、役職主張は一旦そのまま置いておく"],
      metadata
    },
    [],
    legalPlayers,
    "day_discussion",
    "Japanese"
  );
  assert.equal(inventedOpeningClaim.ok, false);
  assert.match(inventedOpeningClaim.issues.join("\n"), /visible Seer claim/);
  assert.match(inventedOpeningClaim.revisionHint ?? "", /占い師COや役職主張が出た前提/);

  const inventedAfterPolicyTalk = reviewSpeechTimeline(
    {
      messages: ["占い師を名乗った人がいるので、今は信用を保留します"],
      metadata
    },
    ["アカネ: 占い師が今日名乗る条件だけ先に決めたいです。"],
    legalPlayers,
    "day_discussion",
    "Japanese"
  );
  assert.equal(inventedAfterPolicyTalk.ok, false);

  const actualVisibleClaim = reviewSpeechTimeline(
    {
      messages: ["占い師を名乗った人がいるので、結果の出し方を見てから保留します"],
      metadata
    },
    ["アカネ: 私は占い師です。イオリは人間判定です。"],
    legalPlayers,
    "day_discussion",
    "Japanese"
  );
  assert.equal(actualVisibleClaim.ok, true);
});

test("timeline review rejects invented first-day role results and unseen entry reads", () => {
  const legalPlayers: TargetCandidate[] = [
    { id: "p1", name: "ノゾミ" },
    { id: "p2", name: "セナ" },
    { id: "p3", name: "アキオミ" },
    { id: "p4", name: "サクラコ" }
  ];
  const publicHistory = ["ノゾミ: 皆さん、まず占い師を名乗る条件を決めましょう"];

  const inventedRoleTiming = reviewSpeechTimeline(
    {
      messages: ["ノゾミは保留だ、名乗ったタイミングが気になる"],
      metadata
    },
    publicHistory,
    legalPlayers,
    "day_discussion",
    "Japanese"
  );
  assert.equal(inventedRoleTiming.ok, false);
  assert.match(inventedRoleTiming.issues.join("\n"), /visible role claim/);

  const inventedPublicClaim = reviewSpeechTimeline(
    {
      messages: ["ノゾミは今は保留だ、役職主張は公開情報として一旦見極めよう"],
      metadata
    },
    publicHistory,
    legalPlayers,
    "day_discussion",
    "Japanese"
  );
  assert.equal(inventedPublicClaim.ok, false);
  assert.match(inventedPublicClaim.issues.join("\n"), /visible role claim/);

  const inventedHumanResult = reviewSpeechTimeline(
    {
      messages: ["俺が人間側判定されてるのは嬉しいが、今はまだセナを疑い寄りで見ておく"],
      metadata
    },
    publicHistory,
    legalPlayers,
    "day_discussion",
    "Japanese"
  );
  assert.equal(inventedHumanResult.ok, false);
  assert.match(inventedHumanResult.issues.join("\n"), /visible role result/);

  const unseenEntryRead = reviewSpeechTimeline(
    {
      messages: ["セナの議論への入り方が不自然です。理由を確認したいので、今の段階でセナを疑い寄りで見ています"],
      metadata
    },
    publicHistory,
    legalPlayers,
    "day_discussion",
    "Japanese"
  );
  assert.equal(unseenEntryRead.ok, false);
  assert.match(unseenEntryRead.issues.join("\n"), /unseen prior public speech/);

  const actualVisibleResult = reviewSpeechTimeline(
    {
      messages: ["アキオミが人間側判定されているなら、今日は投票先から外します"],
      metadata
    },
    ["ノゾミ: 私は占い師です。アキオミは人間側判定です。"],
    legalPlayers,
    "day_discussion",
    "Japanese"
  );
  assert.equal(actualVisibleResult.ok, true);
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
