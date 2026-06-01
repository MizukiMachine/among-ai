import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBooleanSystemPrompt,
  buildPromptContext,
  buildSimpleSpeechSystemPrompt,
  buildTargetSystemPrompt
} from "../src/game/prompts";
import { detectDaySituations } from "../src/game/daySituations";
import { buildPublicSpeechPlan, firstDayOpeningMove } from "../src/game/speechPlanning";
import { getCharacterProfile } from "../src/game/characters";
import { getPromptMaterialPath, promptMaterialPlaceholders, promptMaterials, validatePromptMaterials } from "../src/game/prompts/materials";
import type { Camp, Persona, Player, Role } from "../src/game/types";

function player(role: Role, id = "p1", name = "Ada", persona: Persona = "logical"): Player {
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

const alivePlayers = [
  { id: "p1", name: "Ada" },
  { id: "p2", name: "Byron" },
  { id: "p3", name: "Curie" }
];

test("prompt materials YAML is schema-valid and placeholder-safe", () => {
  assert.equal(promptMaterials.id, "among_ai.game_prompt_materials");
  assert.equal(promptMaterials.type, "material_bundle");
  assert.ok(getPromptMaterialPath().endsWith("materials.yaml"));
  assert.doesNotThrow(() => validatePromptMaterials());
  assert.deepEqual(promptMaterialPlaceholders(), []);
  assert.deepEqual(Object.keys(promptMaterials.roles).sort(), [
    "AlphaWolf",
    "Elder",
    "Guard",
    "Hunter",
    "Idiot",
    "Jester",
    "Lover",
    "Raven",
    "Seer",
    "Villager",
    "Werewolf",
    "Witch",
    "WolfBeauty"
  ]);
  assert.equal("speechReasoningJson" in promptMaterials.outputFormats, false);
  assert.equal("speechJson" in promptMaterials.outputFormats, false);
  assert.match(promptMaterials.outputFormats.targetJson.instruction, /reasonKind/);
  assert.match(promptMaterials.outputFormats.targetJson.japaneseInstruction, /選択理由は.*コード側/);
  assert.match(promptMaterials.roundSummary.jsonInstruction, /Do not reveal hidden roles beyond public claims/);
  for (const profile of Object.values(promptMaterials.roles)) {
    assert.ok(profile.publicSpeechGuidanceJa.length > 0, profile.role);
    assert.doesNotMatch(profile.publicSpeechGuidanceJa.join("\n"), /\b(strategy|pressure|record|history|slot)\b/i);
  }
  assert.match(promptMaterials.roles.Seer.publicSpeechGuidanceJa.join("\n"), /占い結果/);
});

function contextFor(role: Role) {
  return buildPromptContext({
    player: player(role),
    phase: "day_discussion",
    promptPhase: "discussion",
    mode: "public_speech",
    round: 2,
    alivePlayers,
    deadPlayers: [{ id: "p8", name: "Edison", role: "Seer" }],
    publicHistory: ["Byron: I want a timeline before voting."],
    privateHistory: ["Round 1: voted for Curie."],
    language: "English",
    secret: {
      werewolfAllies: [{ id: "secret-wolf", name: "SecretWolf" }],
      loverPartner: { id: "secret-lover", name: "SecretLover", alive: true },
      seerResults: [{ targetId: "secret-check", targetName: "SecretCheck", camp: "werewolf", round: 1 }],
      witch: {
        savePotion: true,
        poisonPotion: false,
        attackedTarget: { id: "secret-victim", name: "SecretVictim" }
      }
    }
  });
}

test("public speech context is a simple character-role-conversation prompt", () => {
  for (const role of ["Werewolf", "Seer", "Witch", "Villager"] as const) {
    const context = contextFor(role);

    assert.match(context, /Character:/);
    assert.match(context, /Role:/);
    assert.match(context, /Conversation so far:/);
    assert.match(context, /Speech rules:/);
    assert.doesNotMatch(context, /Role strategy:|Public discussion guidance:|Public speech boundary:|Speech plan:/);
    assert.doesNotMatch(context, /Edison \(Seer\)/);
  }
});

test("prompt builder only exposes secrets visible to each role", () => {
  const werewolf = contextFor("Werewolf");
  assert.match(werewolf, /SecretWolf/);
  assert.doesNotMatch(werewolf, /SecretCheck/);
  assert.doesNotMatch(werewolf, /SecretVictim/);

  const alphaWolf = contextFor("AlphaWolf");
  assert.match(alphaWolf, /SecretWolf/);
  assert.doesNotMatch(alphaWolf, /SecretCheck/);
  assert.doesNotMatch(alphaWolf, /SecretVictim/);

  const wolfBeauty = contextFor("WolfBeauty");
  assert.match(wolfBeauty, /SecretWolf/);
  assert.doesNotMatch(wolfBeauty, /SecretCheck/);
  assert.doesNotMatch(wolfBeauty, /SecretVictim/);

  const seer = contextFor("Seer");
  assert.match(seer, /SecretCheck/);
  assert.doesNotMatch(seer, /SecretWolf/);
  assert.doesNotMatch(seer, /SecretVictim/);

  const witch = contextFor("Witch");
  assert.match(witch, /SecretVictim/);
  assert.match(witch, /Save potion remaining: yes/);
  assert.doesNotMatch(witch, /SecretWolf/);
  assert.doesNotMatch(witch, /SecretCheck/);

  const lover = contextFor("Lover");
  assert.match(lover, /SecretLover/);
  assert.doesNotMatch(lover, /SecretWolf/);
  assert.doesNotMatch(lover, /SecretCheck/);
  assert.doesNotMatch(lover, /SecretVictim/);

  const villager = contextFor("Villager");
  assert.match(villager, /No private role information/);
  assert.doesNotMatch(villager, /SecretWolf/);
  assert.doesNotMatch(villager, /SecretCheck/);
  assert.doesNotMatch(villager, /SecretVictim/);
  assert.doesNotMatch(villager, /SecretLover/);
  assert.doesNotMatch(villager, /Save potion remaining/);
});

test("werewolf private discussion uses private wolf guidance without public speech instructions", () => {
  const context = buildPromptContext({
    player: player("Werewolf"),
    phase: "werewolf_discussion",
    round: 1,
    alivePlayers,
    deadPlayers: [],
    publicHistory: [],
    privateHistory: [],
    language: "English",
    secret: {
      werewolfAllies: [
        { id: "p1", name: "Ada", alive: true },
        { id: "p4", name: "Darwin", alive: false }
      ]
    }
  });

  assert.match(context, /Werewolf-only private discussion guidance/);
  assert.match(context, /Darwin \(p4\) dead/);
  assert.doesNotMatch(context, /Public discussion guidance/);
  assert.doesNotMatch(context, /Public speech boundary/);
});

test("system prompts keep public speech simple while target and boolean outputs stay structured", () => {
  const base = {
    player: player("Seer"),
    phase: "voting" as const,
    language: "English",
    legalPlayers: alivePlayers
  };

  const speech = buildSimpleSpeechSystemPrompt({ ...base, phase: "day_discussion" });
  const target = buildTargetSystemPrompt({ ...base, allowSkip: false });
  const boolean = buildBooleanSystemPrompt(base);

  assert.match(speech, /Use the conversation so far and your role/);
  assert.match(speech, /Output only the spoken line/);
  assert.doesNotMatch(speech, /Return strict JSON only|reasoning metadata|surface wording|public-safe facts/);
  assert.match(target, /Return strict JSON only/);
  assert.match(target, /"targetId"/);
  assert.match(target, /"reasonKind"/);
  assert.match(target, /You must choose one listed target and one reasonKind/);
  assert.match(boolean, /Return strict JSON only/);
  assert.match(boolean, /"decision"/);
});

test("Japanese public speech prompts keep only persona, role, and conversation context", () => {
  const system = buildSimpleSpeechSystemPrompt({
    player: player("Werewolf"),
    phase: "day_discussion",
    language: "Japanese",
    legalPlayers: alivePlayers
  });
  const context = buildPromptContext({
    player: player("Villager"),
    phase: "day_discussion",
    round: 1,
    alivePlayers,
    deadPlayers: [],
    publicHistory: [],
    privateHistory: [],
    language: "Japanese",
    extra: [
      "昨夜は誰も死亡しませんでした。",
      "公開上の事実: 昨日の投票は同数でした。",
      "1巡目: まだ昼の発言はありません。初期意見を一つ出してください。",
      "初日特別モード: 投票基準を出す。"
    ]
  });
  const generatedPrompt = `${system}\n${context}`;

  assert.match(system, /これまでの会話と自分の役職/);
  assert.match(system, /出力は画面に出す発言だけ/);
  assert.match(context, /人物設定/);
  assert.match(context, /役職/);
  assert.match(context, /これまでの会話/);
  assert.match(context, /発言ルール/);
  assert.match(context, /昨夜は誰も死亡しませんでした/);
  assert.match(context, /公開上の事実: 昨日の投票は同数でした/);
  assert.doesNotMatch(context, /1巡目:/);
  assert.doesNotMatch(context, /初日特別モード/);
  assert.doesNotMatch(generatedPrompt, /Role strategy|Phase guidance|Prompt mode|Information boundary|Public speech|public speech|internal decision/i);
  assert.doesNotMatch(generatedPrompt, /\b(strategy|pressure|record|history|slot)\b/i);
  assert.doesNotMatch(generatedPrompt, /on record|answers pressure|claim pressure|current suspicion, trust, pressure/i);
  assert.doesNotMatch(generatedPrompt, /观望|觉得|应该|确实|因为|所以/);
  assert.doesNotMatch(context, /役職ごとの発言方針|昼の状況別話法|初日特別モード|Speech plan|No prior public statements|vagueness as observed evidence|Task-specific visible context/);
});

test("Japanese voting target prompts keep private reasons separate from English strategy labels", () => {
  const target = buildTargetSystemPrompt({
    player: player("Werewolf"),
    phase: "voting",
    language: "Japanese",
    legalPlayers: alivePlayers,
    allowSkip: false
  });
  const context = buildPromptContext({
    player: player("Werewolf"),
    phase: "voting",
    round: 2,
    alivePlayers,
    deadPlayers: [],
    publicHistory: ["Byron: 投票理由がまだ弱いので、もう一度聞きたいです。"],
    privateHistory: ["第1ラウンド: Curieへ投票。理由: 発言が変わったため。"],
    language: "Japanese"
  });
  const generatedPrompt = `${target}\n${context}`;

  assert.match(target, /返すのは対象 ID だけ/);
  assert.match(target, /選択理由はコード側/);
  assert.match(context, /投票理由の前提/);
  assert.match(context, /投票判断の方針/);
  assert.doesNotMatch(generatedPrompt, /Role strategy|Phase guidance|Prompt mode|Information boundary|internal decision|Action:|Legal targets:/i);
  assert.doesNotMatch(generatedPrompt, /\b(strategy|pressure|record|history|slot)\b/i);
  assert.doesNotMatch(generatedPrompt, /on record|answers pressure|claim pressure|current suspicion, trust, pressure/i);
});

test("first-day public speech context stays simple even when a speech plan exists", () => {
  const speechPlan = buildPublicSpeechPlan({
    phase: "day_discussion",
    round: 1,
    discussionPass: 1,
    players: [player("Villager", "p1", "Ada"), player("Werewolf", "p2", "Byron"), player("Seer", "p3", "Curie")],
    lastNightDeaths: [],
    legalPlayers: alivePlayers.slice(1),
    language: "Japanese"
  });
  assert.equal(speechPlan.requiresForwardMove, false);

  const context = buildPromptContext({
    player: player("Villager"),
    phase: "day_discussion",
    round: 1,
    alivePlayers,
    deadPlayers: [],
    publicHistory: [],
    privateHistory: [],
    language: "Japanese",
    speechPlan
  });

  assert.match(context, /人物設定/);
  assert.match(context, /役職/);
  assert.match(context, /これまでの会話/);
  assert.match(context, /まだありません/);
  assert.match(context, /見えていない発言、反応、矛盾、役職主張を事実として作らない/);
  assert.doesNotMatch(context, /議題スケジューラ/);
  assert.doesNotMatch(context, /人狼陣営は初日昼の演技が見せ場/);
  assert.doesNotMatch(context, /三分の二以上/);

  const wolfContext = buildPromptContext({
    player: player("Werewolf"),
    phase: "day_discussion",
    round: 1,
    alivePlayers,
    deadPlayers: [],
    publicHistory: [],
    privateHistory: [],
    language: "Japanese",
    speechPlan: buildPublicSpeechPlan({
      phase: "day_discussion",
      round: 1,
      discussionPass: 1,
      players: [player("Werewolf", "p1", "Ada"), player("Werewolf", "p2", "Byron"), player("Seer", "p3", "Curie")],
      lastNightDeaths: [],
      legalPlayers: alivePlayers.slice(1),
      language: "Japanese",
      firstDayOpeningMove: firstDayOpeningMove("wolf_fake_role_claim", "Japanese")
    })
  });
  assert.match(wolfContext, /公開の場では、人狼であること、仲間、夜の相談は漏らさない/);
  assert.doesNotMatch(wolfContext, /三分の二以上|初日特別モード|偽役職アピール/);

  assert.doesNotMatch(context, /暫定読み/);
  assert.doesNotMatch(context, /初日の暫定材料/);
  assert.doesNotMatch(context, /自分の stance まで言う/);
  assert.doesNotMatch(context, /公開情報が少なくても/);
  assert.doesNotMatch(context, /名乗るかどうかの判断を出す/);
  assert.doesNotMatch(context, /Recent public discussion/);
  assert.doesNotMatch(context, /2日目以降の昼/);
});

test("first-day claim-policy agenda is filtered from simple public speech context", () => {
  const agendaLine =
    "1巡目: 進め方、投票理由の残し方、占い師が名乗る条件など、初日の議題を一つだけ出してください。まだ見えていない反応や矛盾は作らないでください。";
  const speechPlan = buildPublicSpeechPlan({
    phase: "day_discussion",
    round: 1,
    discussionPass: 1,
    players: [player("Villager", "p1", "Ada"), player("Werewolf", "p2", "Byron"), player("Seer", "p3", "Curie")],
    lastNightDeaths: [],
    legalPlayers: alivePlayers.slice(1),
    language: "Japanese",
    firstDayOpeningMove: firstDayOpeningMove("ask_role_claim_policy", "Japanese")
  });

  assert.deepEqual(
    detectDaySituations({
      phase: "day_discussion",
      round: 1,
      publicHistory: [],
      extra: [agendaLine]
    }),
    ["first_day"]
  );
  assert.deepEqual(
    detectDaySituations({
      phase: "day_discussion",
      round: 1,
      publicHistory: ["Ada: 占い師が今日名乗る条件だけ先に決めたいです。"]
    }),
    ["first_day"]
  );

  const context = buildPromptContext({
    player: player("Villager"),
    phase: "day_discussion",
    round: 1,
    alivePlayers,
    deadPlayers: [],
    publicHistory: [],
    privateHistory: [],
    language: "Japanese",
    extra: [agendaLine],
    speechPlan
  });

  assert.doesNotMatch(context, /占い師が名乗る条件/);
  assert.doesNotMatch(context, /占い師を名乗った人が出た後/);
  assert.doesNotMatch(context, /真偽を即断/);
});

test("first-day opening mode is not injected into the public speech prompt", () => {
  const speechPlan = buildPublicSpeechPlan({
    phase: "day_discussion",
    round: 1,
    discussionPass: 1,
    players: [
      player("Villager", "p1", "Ada"),
      player("Werewolf", "p2", "Byron"),
      player("Witch", "p3", "Curie")
    ],
    lastNightDeaths: [],
    legalPlayers: alivePlayers.slice(1),
    language: "Japanese",
    firstDayOpeningMove: firstDayOpeningMove("tentative_reaction_read", "Japanese")
  });
  const context = buildPromptContext({
    player: player("Villager"),
    phase: "day_discussion",
    round: 1,
    alivePlayers,
    deadPlayers: [],
    publicHistory: [],
    privateHistory: [],
    language: "Japanese",
    speechPlan
  });

  assert.match(context, /これまでの会話/);
  assert.match(context, /まだありません/);
  assert.match(context, /見えていない発言、反応、矛盾、役職主張を事実として作らない/);
  assert.doesNotMatch(context, /初日特別モード/);
  assert.doesNotMatch(context, /名指しで投票基準を聞く/);
  assert.doesNotMatch(context, /割り当てられた名指し質問だけを火種にし/);
  assert.doesNotMatch(context, /投票基準・役職名乗り方針・自己申告/);
  assert.doesNotMatch(context, /見えていない会話内容や反応/);
});

test("first-day follow-up context does not reset visible speech to empty", () => {
  const speechPlan = buildPublicSpeechPlan({
    phase: "day_discussion",
    round: 1,
    discussionPass: 1,
    players: [player("Villager", "p1", "Ada"), player("Werewolf", "p2", "ノゾミ"), player("Witch", "p3", "Curie")],
    lastNightDeaths: [],
    legalPlayers: alivePlayers.slice(1),
    language: "Japanese"
  });
  const context = buildPromptContext({
    player: player("Villager"),
    phase: "day_discussion",
    round: 1,
    alivePlayers,
    deadPlayers: [],
    publicHistory: ["ノゾミ: 今は役職方針を伏せて、投票理由を見ます"],
    privateHistory: [],
    language: "Japanese",
    speechPlan
  });

  assert.match(context, /これまでの会話/);
  assert.match(context, /ノゾミ: 今は役職方針を伏せて/);
  assert.doesNotMatch(context, /まだ、この昼の発言はありません/);
  assert.doesNotMatch(context, /まだ公開発言|まだ、この昼の発言はありません/);
});

test("character voice context uses compact profile fields without sample-line facts", () => {
  const akane = {
    ...player("Villager", "p10", "アカネ", "logical"),
    characterProfile: getCharacterProfile("p10")
  };
  const context = buildPromptContext({
    player: akane,
    phase: "day_discussion",
    round: 1,
    alivePlayers: [
      { id: "p10", name: "アカネ" },
      { id: "p4", name: "イオリ" }
    ],
    deadPlayers: [],
    publicHistory: [],
    privateHistory: [],
    language: "Japanese"
  });

  assert.match(context, /性別: 女/);
  assert.match(context, /話し方: 冷静な分析官の丁寧語/);
  assert.match(context, /大事にすること: 「矛盾は意図から生まれる」/);
  assert.match(context, /切り出しの雰囲気:/);
  assert.doesNotMatch(context, /現在の試合で起きた事実ではありません|口調の例|人物関係の傾向/);
  assert.doesNotMatch(context, /意図的な煙幕|煙幕っぽい動き/);
});

test("day situation prompts cover no-death, Seer claim, black result, and pre-vote", () => {
  const context = buildPromptContext({
    player: player("Villager"),
    phase: "voting",
    round: 2,
    alivePlayers,
    deadPlayers: [],
    publicHistory: ["Ada: 占い師として出ます。Byronは人狼判定です。 主張: Adaが占い師を主張: Byronは人狼判定 R1"],
    privateHistory: [],
    language: "Japanese",
    extra: ["昨夜は誰も死亡しませんでした。", "これは投票直前の最終判断です。"]
  });

  assert.deepEqual(
    detectDaySituations({
      phase: "voting",
      round: 2,
      publicHistory: ["主張: Adaが占い師を主張: Byronは人狼判定 R1"],
      extra: ["昨夜は誰も死亡しませんでした。"]
    }),
    ["later_day", "no_death", "seer_claim", "black_result", "pre_vote"]
  );
  assert.match(context, /2日目以降の昼/);
  assert.match(context, /死体なし後/);
  assert.match(context, /占い師を名乗った人が出た後/);
  assert.match(context, /黒結果後/);
  assert.match(context, /投票直前/);
  assert.match(context, /投票理由は短く/);
});

test("no-death situation uses current round context, not stale public history", () => {
  const context = buildPromptContext({
    player: player("Villager"),
    phase: "day_discussion",
    round: 2,
    alivePlayers,
    deadPlayers: [{ id: "p4", name: "Darwin" }],
    publicHistory: ["1日目の昼が始まりました", "昨夜は誰も死亡しませんでした", "Ada: 死体なしの理由はまだ決めつけません。"],
    privateHistory: [],
    language: "Japanese",
    extra: ["昨夜、Darwinが死亡しました。"]
  });

  assert.deepEqual(
    detectDaySituations({
      phase: "day_discussion",
      round: 2,
      publicHistory: ["昨夜は誰も死亡しませんでした。"],
      extra: ["昨夜、Darwinが死亡しました。"]
    }),
    ["later_day"]
  );
  assert.doesNotMatch(context, /死体なし後/);
});

test("day situation detection recognizes common Japanese Seer CO wording", () => {
  assert.deepEqual(
    detectDaySituations({
      phase: "day_discussion",
      round: 2,
      publicHistory: ["Ada: 占いCOします。Byronは人間判定です。"]
    }),
    ["later_day", "seer_claim"]
  );
});
