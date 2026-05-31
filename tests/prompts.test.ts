import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBooleanSystemPrompt,
  buildPromptContext,
  buildSpeechReasoningSystemPrompt,
  buildSpeechRealizationSystemPrompt,
  buildSpeechSystemPrompt,
  buildTargetSystemPrompt
} from "../src/game/prompts";
import { detectDaySituations } from "../src/game/daySituations";
import { buildPublicSpeechPlan, firstDayOpeningMove } from "../src/game/speechPlanning";
import { containsAwkwardJapaneseOutputTerm, sanitizeDemoJapaneseGameText } from "../src/game/japaneseStyle";
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
  assert.match(promptMaterials.outputFormats.speechJson.instruction, /Return strict JSON only/);
  assert.match(promptMaterials.outputFormats.speechJson.instruction, /listed living read target ids/);
  assert.match(promptMaterials.outputFormats.speechJson.instruction, /Dead players may be mentioned/);
  assert.match(promptMaterials.outputFormats.speechJson.instruction, /visible messages themselves must state that stance/);
  assert.match(promptMaterials.outputFormats.speechJson.instruction, /same target and reason/);
  assert.match(promptMaterials.outputFormats.speechJson.japaneseInstruction, /画面に出る messages の中で自分の stance/);
  assert.match(promptMaterials.outputFormats.speechJson.japaneseInstruction, /同じ対象と同じ理由/);
  assert.match(promptMaterials.outputFormats.targetJson.japaneseInstruction, /公開画面や公開履歴には表示されません/);
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

test("system prompts require strict JSON for speech, target, and boolean outputs", () => {
  const base = {
    player: player("Seer"),
    phase: "voting" as const,
    language: "English",
    legalPlayers: alivePlayers
  };

  const speech = buildSpeechSystemPrompt({ ...base, phase: "day_discussion" });
  const target = buildTargetSystemPrompt({ ...base, allowSkip: false });
  const boolean = buildBooleanSystemPrompt(base);

  assert.match(speech, /Return strict JSON only/);
  assert.match(speech, /"messages"/);
  assert.match(speech, /transport envelope only/);
  assert.match(speech, /Never put JSON syntax/);
  assert.match(speech, /visible messages themselves must state that stance/);
  assert.match(speech, /Public speech must not reveal/);
  assert.match(speech, /Legal living read target ids for suspects\/trusts/);
  assert.match(speech, /two short table passes/);
  assert.match(speech, /follow-up statements/);
  assert.match(speech, /answer that before starting a new topic/);
  assert.match(speech, /same target and rationale/);
  assert.match(speech, /Evaluate another player's statements/);
  assert.match(target, /Return strict JSON only/);
  assert.match(target, /"targetId"/);
  assert.match(target, /You must choose one listed target/);
  assert.match(boolean, /Return strict JSON only/);
  assert.match(boolean, /"decision"/);
});

test("Japanese prompts include a natural conversation style layer", () => {
  const speech = buildSpeechSystemPrompt({
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
  const generatedPrompt = `${speech}\n${context}`;

  assert.match(speech, /日本語の話し方/);
  assert.match(speech, /日本語セリフの契約/);
  assert.match(speech, /messages の各文字列は、画面にそのまま表示される実際のセリフだけ/);
  assert.match(speech, /文末の「。」を付けず/);
  assert.match(speech, /プレイヤーは「人」「相手」「発言している人」/);
  assert.match(speech, /同じ対象・同じ理由を繰り返さない/);
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

  assert.match(target, /reason は公開表示されません/);
  assert.match(target, /短い日本語の理由だけ/);
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
  assert.match(context, /議題スケジューラ/);
  assert.match(context, /0日目の挨拶は本議論の材料にしない/);
  assert.match(context, /全員が様子見にならないよう/);
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
  assert.match(context, /名指しで軽く理由を聞く/);
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
  assert.doesNotMatch(context, /まだ公開発言|公開発言/);
});

test("speech system prompts suppress stance forcing on the opening turn (requiresForwardMove=false)", () => {
  const base = {
    player: player("Villager"),
    phase: "day_discussion" as const,
    language: "Japanese",
    legalPlayers: alivePlayers
  };

  // Opening turn: the reasoning/realization system prompts must NOT carry the
  // stance-forcing clauses that otherwise tell the model to surface a read.
  const reasoningOpening = buildSpeechReasoningSystemPrompt({ ...base, requiresForwardMove: false });
  const realizationOpening = buildSpeechRealizationSystemPrompt({ ...base, requiresForwardMove: false });
  assert.doesNotMatch(reasoningOpening, /公開情報が少なくても/);
  assert.doesNotMatch(reasoningOpening, /名乗るかどうかの判断を出す/);
  assert.doesNotMatch(realizationOpening, /まだ材料が薄い時も/);
  assert.doesNotMatch(realizationOpening, /暫定読み/);
  assert.doesNotMatch(realizationOpening, /必ず自分の stance を入れる/);
  assert.doesNotMatch(reasoningOpening, /初日1巡目の追加ルール/);

  // Non-opening turns (and the default when no flag is passed) keep the forcing.
  const reasoningForward = buildSpeechReasoningSystemPrompt({ ...base, requiresForwardMove: true });
  const realizationForward = buildSpeechRealizationSystemPrompt(base);
  assert.match(reasoningForward, /公開情報が少ない時は/);
  assert.match(realizationForward, /材料がある時は/);
  assert.match(realizationForward, /必ず自分の判断を入れる/);

  const reasoningFirstDay = buildSpeechReasoningSystemPrompt({ ...base, requiresForwardMove: false, opensFirstDay: true });
  const realizationFirstDay = buildSpeechRealizationSystemPrompt({ ...base, requiresForwardMove: false, opensFirstDay: true });
  assert.match(reasoningFirstDay, /初日1巡目の追加ルール/);
  assert.match(reasoningFirstDay, /intent を hold だけにしない/);
  assert.match(realizationFirstDay, /話を聞く/);
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

test("Japanese demo text sanitizer rewrites only contextual translationese terms", () => {
  const text = sanitizeDemoJapaneseGameText(
    "陣営の軸になりそうな位置を落として、処理枠へ圧をかける盤面です。",
    "Japanese"
  );
  const unrelated = sanitizeDemoJapaneseGameText("信用を落としてはいけません。", "Japanese");

  assert.equal(containsAwkwardJapaneseOutputTerm(text), false);
  assert.match(text, /議論をまとめそうな人/);
  assert.match(text, /襲撃して/);
  assert.match(text, /投票先/);
  assert.match(text, /疑いを向ける/);
  assert.match(text, /状況/);
  assert.equal(unrelated, "信用を落としてはいけません。");
  assert.equal(containsAwkwardJapaneseOutputTerm("煙幕に見える発言です。"), true);
});
