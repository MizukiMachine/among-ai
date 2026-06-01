import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBooleanSystemPrompt,
  buildPromptContext,
  buildSpeechReasoningSystemPrompt,
  buildSpeechSurfaceSystemPrompt,
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
  assert.match(promptMaterials.outputFormats.speechReasoningJson.instruction, /Return strict JSON only/);
  assert.match(promptMaterials.outputFormats.speechReasoningJson.instruction, /reasoning step, not\s+the displayed dialogue/);
  assert.match(promptMaterials.outputFormats.speechReasoningJson.instruction, /evidence is the source of truth/);
  assert.match(promptMaterials.outputFormats.speechReasoningJson.japaneseInstruction, /これは推理段階/);
  assert.match(promptMaterials.outputFormats.speechReasoningJson.japaneseInstruction, /セリフではありません/);
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

test("role prompts include phase strategy and public speech boundary", () => {
  for (const role of ["Werewolf", "Seer", "Witch", "Villager"] as const) {
    const context = contextFor(role);

    assert.match(context, /Role strategy:/);
    assert.match(context, /Public discussion guidance:/);
    assert.match(context, /Public speech boundary:/);
    assert.match(context, /Role-visible private information:/);
    assert.match(context, /Dead players are past evidence only/);
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

test("system prompts split speech reasoning, surface wording, target, and boolean outputs", () => {
  const base = {
    player: player("Seer"),
    phase: "voting" as const,
    language: "English",
    legalPlayers: alivePlayers
  };

  const reasoning = buildSpeechReasoningSystemPrompt({ ...base, phase: "day_discussion" });
  const surface = buildSpeechSurfaceSystemPrompt({ ...base, phase: "day_discussion" });
  const target = buildTargetSystemPrompt({ ...base, allowSkip: false });
  const boolean = buildBooleanSystemPrompt(base);

  assert.match(reasoning, /Return strict JSON only/);
  assert.match(reasoning, /reasoning metadata/);
  assert.match(reasoning, /not\s+the displayed dialogue/);
  assert.match(reasoning, /Legal living read target ids for suspects\/trusts/);
  assert.match(reasoning, /two short table passes/);
  assert.match(reasoning, /follow-up statements/);
  assert.match(reasoning, /answer that before starting a new topic/);
  assert.match(reasoning, /same target and rationale/);
  assert.match(reasoning, /Evaluate another player's statements/);
  assert.match(surface, /public-safe facts/);
  assert.match(surface, /Keep the target, reason, and judgment/);
  assert.match(surface, /Do not add names/);
  assert.match(surface, /Output only the displayed spoken line/);
  assert.match(target, /Return strict JSON only/);
  assert.match(target, /"targetId"/);
  assert.match(target, /"reasonKind"/);
  assert.match(target, /You must choose one listed target and one reasonKind/);
  assert.match(boolean, /Return strict JSON only/);
  assert.match(boolean, /"decision"/);
});

test("Japanese prompts include a natural conversation style layer", () => {
  const reasoning = buildSpeechReasoningSystemPrompt({
    player: player("Werewolf"),
    phase: "day_discussion",
    language: "Japanese",
    legalPlayers: alivePlayers
  });
  const surface = buildSpeechSurfaceSystemPrompt({
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
    language: "Japanese"
  });
  const generatedPrompt = `${reasoning}\n${surface}\n${context}`;

  assert.match(reasoning, /これは推理段階/);
  assert.match(reasoning, /messages、セリフ、口調、演出、説明文は入れません/);
  assert.match(reasoning, /公開メタデータと見えている事実/);
  assert.match(surface, /公開してよい内容だけ/);
  assert.match(surface, /言い出し方を変えて/);
  assert.match(surface, /出力は画面に出す発言文だけ/);
  assert.match(surface, /日本語の話し方/);
  assert.match(surface, /プレイヤーは「人」「相手」「発言している人」/);
  assert.match(context, /役職ごとの発言方針/);
  assert.match(context, /人物の話し方/);
  assert.match(context, /見えている昼の発言/);
  assert.doesNotMatch(generatedPrompt, /Role strategy|Phase guidance|Prompt mode|Information boundary|Public speech|public speech|internal decision/i);
  assert.doesNotMatch(generatedPrompt, /\b(strategy|pressure|record|history|slot)\b/i);
  assert.doesNotMatch(generatedPrompt, /on record|answers pressure|claim pressure|current suspicion, trust, pressure/i);
  assert.doesNotMatch(generatedPrompt, /观望|觉得|应该|确实|因为|所以/);
  assert.doesNotMatch(context, /No prior public statements|vagueness as observed evidence|Task-specific visible context/);
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

test("first-day opening prompts avoid hard evidence but require active openings", () => {
  // The engine always supplies a speech plan for day speech; on the round-one
  // opening turn it does not require a forward move, which is what keeps the
  // opening natural instead of an unfounded "初日の暫定材料" suspicion.
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

  assert.match(context, /昼の状況別話法/);
  assert.match(context, /初日昼/);
  assert.match(context, /強い断定は避ける/);
  // Opening guidance invites concrete pressure and agenda movement, not a passive wait.
  assert.match(context, /様子見で止まらず/);
  assert.match(context, /投票基準/);
  assert.match(context, /名指し質問/);
  assert.match(context, /まだ公開情報がないので/);
  assert.match(context, /見えていない反応を根拠にしない/);
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
  assert.match(wolfContext, /三分の二以上/);

  // Unseen-citation guards stay in place.
  assert.match(context, /まだ、この昼の発言はありません/);
  assert.match(context, /見えていない会話内容や反応/);
  assert.match(context, /誰かの言う通り/);
  assert.match(context, /既に起きた事実として話さない/);
  // The circular forcing is gone: no "暫定読み" instruction, no hard "stance まで言う".
  assert.doesNotMatch(context, /暫定読み/);
  assert.doesNotMatch(context, /初日の暫定材料/);
  assert.doesNotMatch(context, /自分の stance まで言う/);
  // The phaseGuidance stance-forcing bullets are gated out on the opening turn too.
  assert.doesNotMatch(context, /公開情報が少なくても/);
  assert.doesNotMatch(context, /名乗るかどうかの判断を出す/);
  assert.doesNotMatch(context, /Recent public discussion/);
  assert.doesNotMatch(context, /2日目以降の昼/);
});

test("first-day claim-policy agenda is not treated as a visible Seer claim", () => {
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

  assert.match(context, /占い師が名乗る条件/);
  assert.doesNotMatch(context, /占い師を名乗った人が出た後/);
  assert.doesNotMatch(context, /真偽を即断/);
});

test("first-day opening mode allows assigned conversation sparks", () => {
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

  assert.match(context, /初日特別モード/);
  assert.match(context, /名指しで投票基準を聞く/);
  assert.match(context, /割り当てられた名指し質問だけを火種にし/);
  assert.match(context, /既に発言や反応があった事実として話さない/);
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

  assert.match(context, /直近の昼の発言/);
  assert.match(context, /ノゾミ: 今は役職方針を伏せて/);
  assert.doesNotMatch(context, /まだ、この昼の発言はありません/);
  assert.doesNotMatch(context, /まだ公開発言|まだ、この昼の発言はありません/);
});

test("speech reasoning prompt suppresses stance forcing on the opening turn (requiresForwardMove=false)", () => {
  const base = {
    player: player("Villager"),
    phase: "day_discussion" as const,
    language: "Japanese",
    legalPlayers: alivePlayers
  };

  // Opening turn: the reasoning prompt must not carry the clauses that
  // otherwise tell the model to surface a read.
  const reasoningOpening = buildSpeechReasoningSystemPrompt({ ...base, requiresForwardMove: false });
  assert.doesNotMatch(reasoningOpening, /公開情報が少なくても/);
  assert.doesNotMatch(reasoningOpening, /名乗るかどうかの判断を出す/);
  assert.doesNotMatch(reasoningOpening, /初日1巡目の追加ルール/);

  // Non-opening turns (and the default when no flag is passed) keep the forcing.
  const reasoningForward = buildSpeechReasoningSystemPrompt({ ...base, requiresForwardMove: true });
  assert.match(reasoningForward, /公開情報が少ない時は/);

  const reasoningFirstDay = buildSpeechReasoningSystemPrompt({ ...base, requiresForwardMove: false, opensFirstDay: true });
  assert.match(reasoningFirstDay, /初日1巡目の追加ルール/);
  assert.match(reasoningFirstDay, /intent を hold だけにしない/);
});

test("character voice context marks examples as non-factual and avoids unnatural smoke-screen wording", () => {
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

  assert.match(context, /現在の試合で起きた事実ではありません/);
  assert.match(context, /口調の例（現在の試合事実ではない）/);
  assert.match(context, /人物関係の傾向（現在の試合事実ではない）/);
  assert.match(context, /話をそらすための軽口/);
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

test("public speech prompting uses structured reasoning and public-safe surface wording", () => {
  assert.ok("speechReasoningJson" in promptMaterials.outputFormats);
  assert.equal("speechRealizationJson" in promptMaterials.outputFormats, false);
  assert.match(promptMaterials.outputFormats.speechReasoningJson.japaneseInstruction, /evidence を優先/);
  assert.match(promptMaterials.outputFormats.speechReasoningJson.japaneseInstruction, /コード側の発言生成/);

  const surface = buildSpeechSurfaceSystemPrompt({
    player: player("Villager"),
    phase: "day_discussion",
    language: "Japanese",
    legalPlayers: alivePlayers
  });
  assert.match(surface, /公開してよい内容だけ/);
  assert.match(surface, /言い出し方を変えて/);
  assert.match(surface, /メモにない人物名/);
});

test("surface prompt receives character voice without sample-line facts", () => {
  const profiledPlayer = {
    ...player("Villager", "p1", "シオン", "cautious"),
    characterProfile: getCharacterProfile("p1")
  };
  const surface = buildSpeechSurfaceSystemPrompt({
    player: profiledPlayer,
    phase: "day_discussion",
    language: "Japanese",
    legalPlayers: alivePlayers
  });

  assert.match(surface, /人物の口調/);
  assert.match(surface, /話し方:/);
  assert.match(surface, /大事にすること:/);
  assert.doesNotMatch(surface, /口調の例|人物関係の傾向/);
});
