import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBooleanSystemPrompt,
  buildPromptContext,
  buildSpeechSystemPrompt,
  buildTargetSystemPrompt
} from "../src/game/prompts";
import { detectDaySituations } from "../src/game/daySituations";
import { containsAwkwardJapaneseOutputTerm, sanitizeDemoJapaneseGameText } from "../src/game/japaneseStyle";
import { getPromptMaterialPath, promptMaterialPlaceholders, promptMaterials, validatePromptMaterials } from "../src/game/prompts/materials";
import type { Camp, Persona, Player, Role } from "../src/game/types";

function player(role: Role, id = "p1", name = "Ada", persona: Persona = "logical"): Player {
  const camp: Camp = role === "Werewolf" ? "werewolf" : "village";
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
  assert.deepEqual(Object.keys(promptMaterials.roles).sort(), ["Guard", "Hunter", "Seer", "Villager", "Werewolf", "Witch"]);
  assert.match(promptMaterials.outputFormats.speechJson.instruction, /Return strict JSON only/);
  assert.match(promptMaterials.roundSummary.jsonInstruction, /Do not reveal hidden roles beyond public claims/);
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
    assert.doesNotMatch(context, /Edison \(Seer\)/);
  }
});

test("prompt builder only exposes secrets visible to each role", () => {
  const werewolf = contextFor("Werewolf");
  assert.match(werewolf, /SecretWolf/);
  assert.doesNotMatch(werewolf, /SecretCheck/);
  assert.doesNotMatch(werewolf, /SecretVictim/);

  const seer = contextFor("Seer");
  assert.match(seer, /SecretCheck/);
  assert.doesNotMatch(seer, /SecretWolf/);
  assert.doesNotMatch(seer, /SecretVictim/);

  const witch = contextFor("Witch");
  assert.match(witch, /SecretVictim/);
  assert.match(witch, /Save potion remaining: yes/);
  assert.doesNotMatch(witch, /SecretWolf/);
  assert.doesNotMatch(witch, /SecretCheck/);

  const villager = contextFor("Villager");
  assert.match(villager, /No private role information/);
  assert.doesNotMatch(villager, /SecretWolf/);
  assert.doesNotMatch(villager, /SecretCheck/);
  assert.doesNotMatch(villager, /SecretVictim/);
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
  assert.match(speech, /Public speech must not reveal/);
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

  assert.match(speech, /日本語の話し方/);
  assert.match(speech, /「位置」ではなく「人」/);
  assert.doesNotMatch(context, /日本語の話し方/);
});

test("first-day discussion prompts keep reads tentative and question-led", () => {
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

  assert.match(context, /昼の状況別話法/);
  assert.match(context, /初日昼/);
  assert.match(context, /強い断定を避ける/);
  assert.match(context, /質問する/);
  assert.match(context, /発言量/);
  assert.match(context, /誰が誰の疑いに乗ったか/);
  assert.match(context, /仮説として軽く疑う/);
  assert.doesNotMatch(context, /2日目以降の昼/);
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
  assert.match(context, /占いCO後/);
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
    publicHistory: ["第1昼が始まりました。昨夜は誰も死亡しませんでした。", "Ada: 死体なしの理由はまだ決めつけません。"],
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
  assert.match(text, /理由を聞く/);
  assert.match(text, /状況/);
  assert.equal(unrelated, "信用を落としてはいけません。");
});
