import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBooleanSystemPrompt,
  buildPromptContext,
  buildSimpleSpeechSystemPrompt,
  buildTargetSystemPrompt
} from "../src/game/prompts";
import { detectDaySituations } from "../src/game/daySituations";
import { reviewJapaneseOutput } from "../src/game/japaneseStyle";
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
  assert.match(promptMaterials.roundSummary.jsonInstruction, /公開主張を超えて隠し役職を明かしません/);
  for (const profile of Object.values(promptMaterials.roles)) {
    assert.ok(profile.publicSpeechGuidanceJa.length > 0, profile.role);
    assert.doesNotMatch(profile.publicSpeechGuidanceJa.join("\n"), /\b(strategy|pressure|record|history|slot)\b/i);
  }
  assert.match(promptMaterials.roles.Seer.publicSpeechGuidanceJa.join("\n"), /占い師|判定/);
  assert.match(promptMaterials.roles.Guard.publicSpeechGuidanceJa.join("\n"), /通常絶対に名乗らない/);
  assert.match(
    promptMaterials.roles.Werewolf.publicSpeechGuidanceJa.join("\n"),
    /占い師・魔女・ハンター・鴉・愚者・長老[\s\S]*公開情報が投票・対抗・自分への疑いを動かす時だけ/
  );
  assert.match(
    promptMaterials.roles.Jester.publicSpeechGuidanceJa.join("\n"),
    /占い師・魔女・ハンター・鴉・愚者・長老[\s\S]*公開情報が投票・対抗・自分への疑いを動かす時だけ/
  );
});

test("Japanese public speech context lists concrete claim roles and excludes Guard", () => {
  const baseInput = {
    phase: "day_discussion" as const,
    promptPhase: "discussion" as const,
    mode: "public_speech" as const,
    round: 1,
    alivePlayers,
    deadPlayers: [],
    publicHistory: [],
    privateHistory: [],
    language: "Japanese"
  };

  const seerContext = buildPromptContext({
    ...baseInput,
    player: player("Seer")
  });
  assert.match(seerContext, /占い師、魔女、ハンター、鴉、愚者、長老/);
  assert.match(seerContext, /騎士は通常絶対に名乗らない/);
  assert.doesNotMatch(seerContext, /占い師など|役職など/);

  const werewolfContext = buildPromptContext({
    ...baseInput,
    player: player("Werewolf")
  });
  assert.match(werewolfContext, /人狼側の役職騙り方針/);
  assert.match(werewolfContext, /占い師、魔女、ハンター、鴉、愚者、長老/);
  assert.match(werewolfContext, /公開情報が投票・対抗・自分への疑いを動かす時だけ短く騙ってよい/);
  assert.match(werewolfContext, /騎士は通常の騙り対象にしない/);

  const jesterContext = buildPromptContext({
    ...baseInput,
    player: player("Jester")
  });
  assert.match(jesterContext, /道化師の役職騙り方針/);
  assert.match(jesterContext, /占い師、魔女、ハンター、鴉、愚者、長老/);
  assert.match(jesterContext, /公開情報が投票・対抗・自分への疑いを動かす時だけ短く騙ってよい/);
  assert.match(jesterContext, /単独勝利条件は終盤まで隠す/);

  const guardContext = buildPromptContext({
    ...baseInput,
    player: player("Guard")
  });
  assert.match(guardContext, /あなたは騎士です。通常は絶対に名乗らない/);
  assert.match(guardContext, /護衛先.*伏せる/);
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
    publicHistory: ["Byron: 投票前に時系列を見たいです。"],
    privateHistory: ["第1ラウンド: Curieへ投票。"],
    language: "Japanese",
    roleBreakdown: [
      { role: "Werewolf", count: 2 },
      { role: "AlphaWolf", count: 1 },
      { role: "Seer", count: 1 },
      { role: "Witch", count: 1 },
      { role: "Jester", count: 1 },
      { role: "Villager", count: 3 }
    ],
    secret: {
      werewolfAllies: [{ id: "secret-wolf", name: "SecretWolf", role: "AlphaWolf" }],
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

    assert.match(context, /人物設定:/);
    assert.match(context, /役職:/);
    assert.match(context, /配役表:/);
    assert.match(context, /これまでの会話:/);
    assert.match(context, /発言ルール:/);
    assert.doesNotMatch(context, /Role strategy:|Public discussion guidance:|Public speech boundary:|Speech plan:/);
    assert.doesNotMatch(context, /Edison \(Seer\)/);
  }
});

test("prompt builder only exposes secrets visible to each role", () => {
  const werewolf = contextFor("Werewolf");
  assert.match(werewolf, /SecretWolf/);
  assert.match(werewolf, /SecretWolf \(secret-wolf\): α人狼/);
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
  assert.match(witch, /救済薬: 残っています/);
  assert.doesNotMatch(witch, /SecretWolf/);
  assert.doesNotMatch(witch, /SecretCheck/);

  const lover = contextFor("Lover");
  assert.match(lover, /SecretLover/);
  assert.doesNotMatch(lover, /SecretWolf/);
  assert.doesNotMatch(lover, /SecretCheck/);
  assert.doesNotMatch(lover, /SecretVictim/);

  const villager = contextFor("Villager");
  assert.match(villager, /自分だけの役職情報はありません/);
  assert.doesNotMatch(villager, /SecretWolf/);
  assert.doesNotMatch(villager, /SecretCheck/);
  assert.doesNotMatch(villager, /SecretVictim/);
  assert.doesNotMatch(villager, /SecretLover/);
  assert.doesNotMatch(villager, /救済薬/);
});

test("role breakdown is public counts only while werewolf ally roles stay secret", () => {
  const villagerContext = buildPromptContext({
    player: player("Villager"),
    phase: "day_discussion",
    round: 1,
    roleBreakdown: [
      { role: "Werewolf", count: 2 },
      { role: "AlphaWolf", count: 1 },
      { role: "WolfBeauty", count: 1 },
      { role: "Seer", count: 1 },
      { role: "Witch", count: 1 },
      { role: "Jester", count: 1 },
      { role: "Villager", count: 8 }
    ],
    alivePlayers: [
      { id: "p1", name: "Ada" },
      { id: "p13", name: "Sena" }
    ],
    deadPlayers: [],
    publicHistory: [],
    privateHistory: [],
    language: "Japanese",
    secret: {
      werewolfAllies: [{ id: "p13", name: "Sena", role: "AlphaWolf" }]
    }
  });

  assert.match(villagerContext, /この村の役職内訳:/);
  assert.match(villagerContext, /道化師1人/);
  assert.match(villagerContext, /α人狼1人/);
  assert.match(villagerContext, /誰がどの役職かは.*分かりません/);
  assert.doesNotMatch(villagerContext, /Sena \(p13\): α人狼/);

  const wolfContext = buildPromptContext({
    player: player("Werewolf"),
    phase: "day_discussion",
    round: 1,
    roleBreakdown: [{ role: "AlphaWolf", count: 1 }],
    alivePlayers,
    deadPlayers: [],
    publicHistory: [],
    privateHistory: [],
    language: "Japanese",
    secret: {
      werewolfAllies: [{ id: "p13", name: "Sena", role: "AlphaWolf", alive: true }]
    }
  });

  assert.match(wolfContext, /Sena \(p13\): α人狼 生存/);
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
    language: "Japanese",
    secret: {
      werewolfAllies: [
        { id: "p1", name: "Ada", role: "Werewolf", alive: true },
        { id: "p4", name: "Darwin", role: "AlphaWolf", alive: false }
      ]
    }
  });

  assert.match(context, /人狼だけの非公開相談方針/);
  assert.match(context, /Darwin \(p4\): α人狼 死亡/);
  assert.doesNotMatch(context, /昼議論の役職方針/);
  assert.doesNotMatch(context, /公開発言の境界/);
});

test("system prompts keep public speech simple while target and boolean outputs stay structured", () => {
  const base = {
    player: player("Seer"),
    phase: "voting" as const,
    language: "Japanese",
    legalPlayers: alivePlayers
  };

  const speech = buildSimpleSpeechSystemPrompt({ ...base, phase: "day_discussion" });
  const target = buildTargetSystemPrompt({ ...base, allowSkip: false });
  const boolean = buildBooleanSystemPrompt(base);

  assert.match(speech, /これまでの会話と自分の役職/);
  assert.match(speech, /自分の名前/);
  assert.match(speech, /出力は画面に出す発言だけ/);
  assert.doesNotMatch(speech, /Return strict JSON only|reasoning metadata|surface wording|public-safe facts/);
  assert.match(target, /厳密な JSON/);
  assert.match(target, /"targetId"/);
  assert.match(target, /"reasonKind"/);
  assert.match(target, /必ず一覧にある対象 ID と reasonKind/);
  assert.match(boolean, /厳密な JSON/);
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
  assert.match(system, /日本語だけで書く/);
  assert.match(system, /中国語の語彙や簡体字・繁体字/);
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

test("Japanese output review rejects Chinese vocabulary in displayed speech", () => {
  assert.deepEqual(reviewJapaneseOutput("初日は発言を控えすぎず、投票基準を先に出します", "Japanese"), {
    ok: true,
    issues: []
  });

  const review = reviewJapaneseOutput("初日は发言を控えて、様子を見るべきだと思います", "Japanese");
  assert.equal(review.ok, false);
  assert.match(review.issues.join("\n"), /Chinese vocabulary/);
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
  assert.match(wolfContext, /人狼側の役職騙り方針/);
  assert.match(wolfContext, /公開情報が投票・対抗・自分への疑いを動かす時だけ短く騙ってよい/);
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

test("public speech context marks the speaker's own prior lines as self", () => {
  const gaku = {
    ...player("Villager", "p9", "ガク", "aggressive"),
    characterProfile: getCharacterProfile("p9")
  };
  const context = buildPromptContext({
    player: gaku,
    phase: "day_discussion",
    round: 1,
    alivePlayers: [
      { id: "p5", name: "コハル" },
      { id: "p6", name: "シュウヘイ" },
      { id: "p9", name: "ガク" }
    ],
    deadPlayers: [],
    publicHistory: [
      "ガク: コハルのタイミングが気になる。 疑い先: コハル",
      "シュウヘイ: そこ。短く見る"
    ],
    privateHistory: [],
    language: "Japanese"
  });

  assert.match(context, /自分（ガク）: コハルのタイミングが気になる/);
  assert.doesNotMatch(context, /- ガク: コハルのタイミング/);
  assert.match(context, /シュウヘイ: そこ。短く見る/);
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
