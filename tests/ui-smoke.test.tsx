import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  App,
  clusterReads,
  dedupeReadsBySourceTarget,
  eventPhaseMetaLabel,
  eventMessageForSpectator,
  eventRoundLabel,
  eventSpeakerForSpectator,
  heroCastForStage,
  stageLightMoodForEvent,
  stageLightToneForEvent,
  storyRunControlState,
  streamErrorMessageFromData,
  voteResultHasVisibleData,
  winnerLabelForRoster
} from "../src/client/App";
import { roleLabel as displayRoleLabel } from "../src/game/i18n";
import type { GameEvent, PlayerSnapshot } from "../src/game/types";

test("app shell renders spectator controls and role distribution", () => {
  const html = renderToStaticMarkup(createElement(App));

  assert.match(html, /among ai/);
  assert.match(html, /自分も参加してプレイ/);
  assert.match(html, /全情報/);
  assert.match(html, /人間視点/);
  assert.match(html, /story-run-controls/);
  assert.match(html, /戻る/);
  assert.match(html, /次へ/);
  assert.match(html, /一時停止/);
  assert.match(html, /header-role-distribution/);
  assert.match(html, /header-role-chip/);
  assert.match(html, /役職内訳/);
  assert.doesNotMatch(html, /topbar-actions/);
  assert.doesNotMatch(html, /プレイヤー・インテリジェンス/);
  assert.doesNotMatch(html, /roster-summary/);
  assert.doesNotMatch(html, /対局サマリー/);
  assert.doesNotMatch(html, /一気に読む/);
  assert.doesNotMatch(html, /必ず起こしたいイベント/);
  assert.doesNotMatch(html, /ゲームをリセット/);
  assert.doesNotMatch(html, />停止</);
  assert.doesNotMatch(html, /言語/);
  assert.doesNotMatch(html, /進行方法/);
  assert.doesNotMatch(html, /表示速度/);
  assert.doesNotMatch(html, /自動送り/);
  assert.doesNotMatch(html, /進行方式/);
  assert.doesNotMatch(html, /モデル名/);
  assert.doesNotMatch(html, /要約方法/);
  assert.doesNotMatch(html, /insight-grid/);
  assert.doesNotMatch(html, /10人以上は認知負荷が大きい/);
});

test("winner label appears only when a winner exists", () => {
  assert.equal(winnerLabelForRoster(null, "Japanese"), null);
  assert.equal(winnerLabelForRoster("village", "Japanese"), "勝者: 人間側");
  assert.equal(winnerLabelForRoster("werewolf", "Japanese"), "勝者: 狼陣営");
});

test("story event meta labels are readable and omit visibility chips", () => {
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");

  assert.equal(eventRoundLabel(1, "Japanese"), "ラウンド1");
  assert.equal(eventRoundLabel(2, "English"), "Round 2");
  assert.equal(eventPhaseMetaLabel("werewolf_discussion", "Japanese"), "人狼相談フェーズ");
  assert.equal(eventPhaseMetaLabel("guard_action", "Japanese"), "護衛決定フェーズ");
  assert.equal(eventPhaseMetaLabel("seer_action", "Japanese"), "占い決定フェーズ");
  assert.equal(eventPhaseMetaLabel("day_discussion", "Japanese"), "昼議論");
  assert.doesNotMatch(source, /visibilityLabel/);
  assert.doesNotMatch(source, /eventVisibility\(currentEvent\)/);
  assert.doesNotMatch(source, /shouldShowVisibilityMeta/);
});

test("story event meta chips stay prominent", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  assert.match(css, /\.event-meta\s*\{[^}]*gap:\s*10px/s);
  assert.match(css, /\.event-meta span\s*\{[^}]*min-height:\s*36px/s);
  assert.match(css, /\.event-meta span\s*\{[^}]*padding:\s*7px 16px/s);
  assert.match(css, /\.event-meta span\s*\{[^}]*font-size:\s*16px/s);
});

test("progression messages display without terminal Japanese periods", () => {
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
  const event: GameEvent = {
    id: 1,
    createdAt: "2026-05-27T00:00:00.000Z",
    round: 1,
    phase: "werewolf_discussion",
    type: "phase_changed",
    message: "人狼たちが内通を始めました。",
    data: {},
    snapshot: {
      round: 1,
      phase: "werewolf_discussion",
      winner: null,
      players: [],
      aliveCount: 0,
      werewolfCount: 0,
      villageCount: 0
    }
  };

  assert.equal(eventMessageForSpectator(event, "omniscient"), "人狼たちが内通を始めました");
  assert.equal(
    eventMessageForSpectator({ ...event, message: "第1昼が始まりました。昨夜は誰も死亡しませんでした。" }, "omniscient"),
    "第1昼が始まりました。昨夜は誰も死亡しませんでした"
  );
  assert.match(source, /formatMessage\(eventMessageForSpectator\(event, spectatorMode\)\)/);
});

test("stage lighting follows speech mood and avoids repeated tones", () => {
  const baseEvent: GameEvent = {
    id: 12,
    createdAt: "2026-05-24T00:00:00.000Z",
    round: 1,
    phase: "day_discussion",
    type: "player_speech",
    message: "ガクの発言には矛盾がある。ここは人狼の可能性を疑いたい。",
    playerId: "p1",
    playerName: "シオン",
    data: { suspects: [{ targetId: "p2", targetName: "ガク", reason: "矛盾" }] },
    snapshot: {
      round: 1,
      phase: "day_discussion",
      winner: null,
      players: [],
      aliveCount: 0,
      werewolfCount: 0,
      villageCount: 0
    }
  };

  assert.equal(stageLightMoodForEvent(baseEvent), "suspicion");
  assert.equal(stageLightMoodForEvent({ ...baseEvent, message: "ナギサは白く見えるので信頼したい。", data: { trusts: [{ targetId: "p5" }] } }), "trust");
  assert.equal(stageLightMoodForEvent({ ...baseEvent, type: "vote_cast", phase: "voting", message: "シオンに投票します。" }), "vote");

  let previousTone = stageLightToneForEvent(baseEvent, false, 1);
  for (const [index, event] of [
    { ...baseEvent, id: 13, phase: "night" as const, message: "人狼たちが内通を始めました。" },
    { ...baseEvent, id: 14, phase: "werewolf_discussion" as const, message: "シオンかシュウヘイを噛むのがいいと思う" },
    { ...baseEvent, id: 15, message: "まだ矛盾が残るので疑いを続けます。" }
  ].entries()) {
    const tone = stageLightToneForEvent(event, false, index + 2, previousTone);
    assert.notEqual(tone, previousTone);
    previousTone = tone;
  }
});

test("stage backdrop exposes animated mood lighting layers", () => {
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
  const backdrop = readFileSync(new URL("../src/client/SciFiStageBackdrop.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  assert.match(source, /const currentStageLightTone = useMemo/);
  assert.match(source, /stageLightToneForEvent\(event, isEventRedactedForSpectator\(event, spectatorMode\), index \+ 1, previousTone\)/);
  assert.match(source, /const lightTone = currentStageLightTone \?\? stageLightToneForEvent\(currentEvent, hidden, events\.length\)/);
  assert.match(backdrop, /data-light-tone=\{lightTone\}/);
  assert.match(backdrop, /className="stage-light-wash"/);
  assert.match(backdrop, /className="stage-light-scan"/);
  assert.match(css, /\.scifi-texture-backdrop\[data-light-tone="rose"\]/);
  assert.match(css, /\.scifi-texture-backdrop\[data-light-tone="emerald"\]/);
  assert.match(css, /\.scifi-texture-backdrop\[data-light-tone="violet"\]/);
  assert.match(css, /@keyframes stage-light-arrive/);
});

test("hero cast mirrors selected and active player counts", () => {
  assert.equal(heroCastForStage([], 9).length, 9);
  assert.equal(heroCastForStage([], 15).length, 15);

  const players: PlayerSnapshot[] = Array.from({ length: 15 }, (_, index) => ({
    id: `p${index + 1}`,
    name: `Player ${index + 1}`,
    role: "Villager",
    camp: "village",
    persona: "cautious",
    alive: index !== 8,
    model: "demo",
    memoryCount: 0
  }));
  const cast = heroCastForStage(players, 15);

  assert.equal(cast.length, 15);
  assert.equal(cast.at(-1)?.id, "p15");
  assert.match(cast.at(-1)?.image ?? "", /\/assets\/characters\/thumbs\/p15_akiomi\.webp$/);
  assert.equal(cast.at(-1)?.alive, true);
  assert.equal(cast[8].alive, false);
});

test("setup character thumbnails preload and portrait images warm in the background", () => {
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../index.html", import.meta.url), "utf8");

  assert.match(source, /const CHARACTER_THUMBNAIL_ROOT = `\$\{CHARACTER_ASSET_ROOT\}\/thumbs`;/);
  assert.match(source, /p15:\s*`\$\{CHARACTER_THUMBNAIL_ROOT\}\/p15_akiomi\.webp`/);
  assert.match(source, /const characterThumbnailImages = Object\.values\(characterImageMap\);/);
  assert.match(source, /const characterPortraitImages = Object\.values\(characterPortraitMap\);/);
  assert.match(source, /function getCharacterPortrait\(playerId\?: string\): string \| null/);
  assert.match(source, /const loadedCharacterImages = new Set<string>\(\);/);
  assert.match(source, /const pendingCharacterImageLoads = new Map<string, Promise<boolean>>\(\);/);
  assert.match(source, /preloadCharacterImages\(characterThumbnailImages, "high"\);/);
  assert.match(source, /function scheduleBackgroundCharacterPreload\(srcs: string\[\]\)/);
  assert.match(source, /preloadCharacterImage\(src, "low"\)/);
  assert.match(source, /scheduleBackgroundCharacterPreload\(characterPortraitImages\);/);
  assert.match(source, /function renderCharacterImageWarmup\(\)/);
  assert.match(source, /className="character-image-warmup"/);
  assert.match(source, /decoding="sync" fetchPriority="high" loading="eager"/);
  assert.match(source, /fetchPriority=\{fetchPriority\}/);
  assert.match(source, /loading=\{loading\}/);
  assert.match(source, /fetchPriority="high"/);
  assert.match(source, /decoding=\{decoding\}/);
  assert.match(source, /void preloadCharacterImage\(src\)\.then/);
  assert.match(shell, /rel="preload" as="image" type="image\/webp" href="\/assets\/characters\/thumbs\/p1_shion\.webp"/);
  assert.match(shell, /rel="preload" as="image" type="image\/webp" href="\/assets\/characters\/thumbs\/p7_kirie\.webp"/);
  assert.match(shell, /rel="preload" as="image" type="image\/webp" href="\/assets\/characters\/thumbs\/p15_akiomi\.webp"/);
  assert.equal(
    shell.match(/rel="preload" as="image" type="image\/webp" href="\/assets\/characters\/thumbs\/p\d+_[^"]+\.webp"/g)?.length,
    15
  );
});

test("only the active speaker uses full portrait character images", () => {
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");

  assert.equal(source.match(/getCharacterPortrait\(/g)?.length, 2);
  assert.match(source, /const activeSpeakerImage = currentEvent \? getCharacterPortrait\(currentEvent\.playerId\) : null;/);
  assert.match(source, /className="hero-character" src=\{activeSpeakerImage\}/);
  assert.match(source, /className="setup-cast-grid selectable"[\s\S]*<CharacterImage[\s\S]*src=\{getCharacterImage\(player\.id\)\}[\s\S]*decoding="sync"[\s\S]*fetchPriority="high"/);
  assert.doesNotMatch(source, /setup-cast-grid[\s\S]*getCharacterPortrait/);
  assert.doesNotMatch(source, /player-avatar[\s\S]{0,240}getCharacterPortrait/);
});

test("read clusters count each source-target pair once", () => {
  const reads = [
    { sourceId: "p1", sourceName: "Ada", targetId: "p2", targetName: "Byron", reason: "first pass" },
    { sourceId: "p3", sourceName: "Curie", targetId: "p2", targetName: "Byron", reason: "separate source" },
    { sourceId: "p1", sourceName: "Ada", targetId: "p2", targetName: "Byron", reason: "second pass" }
  ];

  assert.deepEqual(dedupeReadsBySourceTarget(reads), [
    { sourceId: "p3", sourceName: "Curie", targetId: "p2", targetName: "Byron", reason: "separate source" },
    { sourceId: "p1", sourceName: "Ada", targetId: "p2", targetName: "Byron", reason: "second pass" }
  ]);
  assert.deepEqual(clusterReads(reads), [
    {
      targetId: "p2",
      targetName: "Byron",
      count: 2,
      sources: ["Curie", "Ada"],
      latestReason: "second pass"
    }
  ]);
});

test("vote result data is visible from either individual votes or totals", () => {
  const baseEvent: GameEvent = {
    id: 1,
    createdAt: "2026-05-24T00:00:00.000Z",
    round: 1,
    phase: "voting",
    type: "vote_result",
    message: "投票結果が出ました。",
    data: {},
    snapshot: {
      round: 1,
      phase: "voting",
      winner: null,
      players: [],
      aliveCount: 0,
      werewolfCount: 0,
      villageCount: 0
    }
  };

  assert.equal(voteResultHasVisibleData(baseEvent), false);
  assert.equal(voteResultHasVisibleData({ ...baseEvent, data: { totals: [{ targetId: "p1", targetName: "シオン", count: 2 }] } }), true);
  assert.equal(
    voteResultHasVisibleData({
      ...baseEvent,
      data: { votes: [{ voterId: "p2", voterName: "ガク", targetId: "p1", targetName: "シオン" }] }
    }),
    true
  );
});

test("story run controls switch between pause, resume, and reset", () => {
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");

  assert.deepEqual(storyRunControlState(false, false), {
    pauseLabel: "一時停止",
    pauseDisabled: true,
    resetVisible: false
  });
  assert.deepEqual(storyRunControlState(true, false), {
    pauseLabel: "一時停止",
    pauseDisabled: false,
    resetVisible: false
  });
  assert.deepEqual(storyRunControlState(true, true), {
    pauseLabel: "再開",
    pauseDisabled: false,
    resetVisible: true
  });
  assert.match(source, /function resetToInitialSetup\(\)/);
  assert.match(source, /setPlayerCount\(initialPlayerCount\);/);
  assert.match(source, /setHumanEnabled\(initialHumanEnabled\);/);
  assert.match(source, /onClick=\{resetToInitialSetup\}/);
  assert.doesNotMatch(source, /onClick=\{\(\) => startGame\(\{ revealFirstEvent: true \}\)\}/);
});

test("mobile layout CSS keeps spectator panels in a single column", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  assert.match(css, /@media \(max-width: 980px\)/);
  assert.match(css, /\.workspace\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /\.header-role-distribution\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.header-role-list\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /\.story-column\s*\{[^}]*order:\s*1/s);
  assert.match(css, /\.controls-panel\s*\{[^}]*order:\s*3/s);
  assert.match(css, /\.vote-node\s*\{[^}]*min-width:\s*0/s);
});

test("story controls stay stable as history grows", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");

  assert.match(css, /\.workspace\s*\{[^}]*height:\s*clamp\(680px,\s*calc\(100dvh - 128px\),\s*970px\)/s);
  assert.match(css, /\.story-panel\s*\{[^}]*min-height:\s*0/s);
  assert.match(css, /\.novel-stage\s*\{[^}]*height:\s*100%/s);
  assert.match(css, /\.story-copy\s*\{[^}]*max-height:\s*calc\(100% - 170px\)/s);
  assert.match(css, /\.story-copy\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.setup-grid\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.story-controls\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /\.story-controls\s*\{[^}]*bottom:\s*18px/s);
  assert.match(css, /\.story-back,\s*\.story-next\s*\{[^}]*min-width:\s*164px/s);
  assert.match(css, /\.story-button-label\s*\{[^}]*justify-content:\s*center/s);
  assert.match(css, /\.story-run-controls\s*\{[^}]*display:\s*inline-flex/s);
  assert.match(css, /\.header-role-distribution\s*\{[^}]*grid-column:\s*2/s);
  assert.match(css, /\.header-role-distribution\s*\{[^}]*grid-row:\s*1/s);
  assert.match(css, /\.header-role-distribution\s*\{[^}]*min-height:\s*0/s);
  assert.match(css, /\.header-role-list\s*\{[^}]*max-height:\s*none[^}]*overflow:\s*visible/s);
  assert.match(css, /\.header-role-chip\s*\{[^}]*min-height:\s*46px/s);
  assert.match(css, /\.info-bar\s*\{[^}]*grid-column:\s*3[^}]*grid-row:\s*1/s);
  assert.match(css, /@media \(max-width: 1180px\)[\s\S]*\.header-role-distribution\s*\{[^}]*grid-column:\s*1[^}]*grid-row:\s*auto/s);
  assert.match(css, /@media \(max-width: 1180px\)[\s\S]*\.info-bar\s*\{[^}]*grid-column:\s*1[^}]*grid-row:\s*auto/s);
  assert.match(source, /"α人狼"/);
  assert.match(source, /function headerRoleLabel\(role: Role, language: string\): string/);
  assert.match(source, /function renderHeaderCampRatio\(count: number, language: string\): ReactNode/);
  assert.match(source, /<header className="topbar">/);
  assert.match(source, /className="header-role-distribution"/);
  assert.match(source, /className="header-camp-ratio"/);
  assert.match(source, /aria-label=\{`\$\{displayRoleLabel\(role, language\)\} \$\{count\}人のルールを表示`\}/);
  assert.match(source, /\{roleDistributionItems\.map\(\(\[role, count\]\) => \(/);
  assert.doesNotMatch(source, /expandedHeaderRoleList/);
  assert.doesNotMatch(source, /compactHeaderRoleList/);
  assert.doesNotMatch(source, /roleDistributionItems\.length >= 8/);
  assert.doesNotMatch(source, /expanded-roles/);
  assert.doesNotMatch(source, /visibleRoleDistributionItems/);
  assert.doesNotMatch(source, /header-role-more/);
  assert.doesNotMatch(source, /compact-role-topbar/);
  assert.doesNotMatch(source, /compact-roles/);
  assert.doesNotMatch(css, /\.topbar\.expanded-roles/);
  assert.doesNotMatch(css, /\.header-role-distribution\.expanded-roles/);
  assert.doesNotMatch(css, /\.topbar\.compact-role-topbar/);
  assert.doesNotMatch(css, /\.header-role-distribution\.compact-roles/);
  assert.doesNotMatch(css, /\.header-camp-ratio\.split/);
  assert.match(css, /\.role-rule-popover\s*\{[^}]*position:\s*absolute/s);
});

test("header role rule popover follows the selected chip", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");

  assert.match(source, /roleRuleTriggerRef = useRef<HTMLButtonElement \| null>\(null\)/);
  assert.match(source, /roleRuleTriggerRef\.current = event\.currentTarget/);
  assert.match(source, /setRoleRulePopoverPosition\(getRoleRulePopoverPosition\(event\.currentTarget\)\)/);
  assert.match(source, /window\.addEventListener\("pointerdown", closeRoleRuleOnPointerDown, true\)/);
  assert.match(source, /window\.addEventListener\("resize", scheduleRoleRuleReposition\)/);
  assert.match(source, /window\.addEventListener\("orientationchange", scheduleRoleRuleReposition\)/);
  assert.match(source, /function roleRuleText\(text: string\): string \{\s*return text\.replace\(/s);
  assert.match(source, /<dd>\{roleRuleText\(selectedRule\.ability\)\}<\/dd>/);
  assert.match(css, /\.role-rule-popover\s*\{[^}]*top:\s*var\(--role-rule-top/s);
  assert.match(css, /\.role-rule-popover\s*\{[^}]*left:\s*var\(--role-rule-left/s);
  assert.match(css, /\.role-rule-popover\s*\{[^}]*width:\s*min\(620px,\s*calc\(100vw - 40px\)\)/s);
  assert.match(css, /\.role-rule-body dd\s*\{[^}]*font-size:\s*17px/s);
});

test("player roster scrolls inside the fixed gameplay panel", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");

  assert.match(source, /className="player-list-scroll"/);
  assert.match(css, /\.intelligence-panel\s*\{[^}]*display:\s*flex[^}]*min-height:\s*0[^}]*flex-direction:\s*column/s);
  assert.match(css, /\.player-list-scroll\s*\{[^}]*flex:\s*1 1 auto[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s);
});

test("graveyard cards stay compact like the living roster", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");

  assert.match(source, /className="dead-player-main"/);
  assert.match(css, /\.graveyard\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.dead-player\s*\{[^}]*grid-template-columns:\s*58px minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.dead-player-main\s*\{[^}]*display:\s*grid[^}]*gap:\s*6px/s);
  assert.match(css, /\.dead-role-chip\s*\{[^}]*font-size:\s*13px/s);
});

test("story speaker header omits the speaking status label", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /発言中/);
  assert.doesNotMatch(source, /voice-wave/);
  assert.doesNotMatch(css, /\.voice-wave/);
  assert.doesNotMatch(css, /\.speaker-line small/);
});

test("player roster distinguishes persona and hidden role labels", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");

  assert.equal(displayRoleLabel("Hidden", "Japanese"), "不明");
  assert.match(source, /const roleVisible = mode === "omniscient" \|\| \(mode === "player" && player\.id === humanPlayerId && role !== "Hidden"\);/);
  assert.match(source, /const roleLabel = roleDisplay\(player, spectatorMode, language, humanPlayerId\);/);
  assert.match(source, /function personaClassName\(persona: PlayerSnapshot\["persona"\] \| string \| undefined\): string/);
  assert.match(source, /className=\{`persona-pill \$\{personaClassName\(player\.persona\)\}`\}/);
  assert.match(css, /\.player-main\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*0\.7fr\)\s*minmax\(72px,\s*1fr\)[^}]*grid-template-rows:\s*auto auto/s);
  assert.match(css, /\.player-name-row strong\s*\{[^}]*grid-column:\s*1[^}]*grid-row:\s*1 \/ 3/s);
  assert.match(css, /\.persona-pill\s*\{[^}]*grid-column:\s*2[^}]*grid-row:\s*1/s);
  assert.match(css, /\.role-chip\s*\{[^}]*grid-column:\s*2[^}]*grid-row:\s*2/s);
  for (const persona of ["cautious", "aggressive", "logical", "opportunistic", "empathetic", "trickster", "stoic", "passionate"]) {
    assert.match(css, new RegExp(`\\.persona-${persona}\\s*\\{[^}]*border-color:[^}]*background:[^}]*color:`, "s"));
  }
});

test("story can advance from keyboard shortcuts outside form controls", () => {
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");

  assert.match(source, /event\.key !== "Enter"/);
  assert.match(source, /event\.key !== "ArrowRight"/);
  assert.match(source, /event\.key !== "ArrowLeft"/);
  assert.match(source, /retreatStory\(\)/);
  assert.match(source, /isEditableShortcutTarget/);
});

test("story controls expose back and next without read-all", () => {
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  assert.match(source, /function retreatStory/);
  assert.match(source, /className="speaker-unread-count"/);
  assert.match(source, /renderSpeakerUnreadStatus\(\)/);
  assert.doesNotMatch(source, /自分視点/);
  assert.doesNotMatch(source, /player-view-lock/);
  assert.doesNotMatch(css, /player-view-lock/);
  assert.doesNotMatch(source, /function revealAll/);
  assert.doesNotMatch(source, /story-read-all/);
  assert.doesNotMatch(source, /renderQueueStatus/);
});

test("stream connection errors produce a visible Japanese message", () => {
  assert.equal(
    streamErrorMessageFromData(undefined),
    "ゲームストリームに接続できませんでした。APIサーバーが起動しているか確認してください。"
  );
  assert.equal(streamErrorMessageFromData('{"message":"upstream failed"}'), "upstream failed");
  assert.equal(streamErrorMessageFromData("plain failure"), "plain failure");
});

test("setting confirmation starts generation before the game start reveal", () => {
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");

  assert.match(source, /const revealFirstEventRef = useRef\(false\)/);
  assert.match(source, /function confirmSettings\(\)/);
  assert.match(source, /setSettingsConfirmed\(true\);\s*startGame\(\);/);
  assert.match(source, /const primaryActionLabel = primaryActionIsGameStart \? "ゲーム開始"/);
  assert.match(source, /<span>設定を決定<\/span>/);
  assert.match(source, /summary: "deterministic"/);
  assert.match(source, /if \(revealFirstEventRef\.current\)\s*\{[^}]*setEvents\(\[event\]\)[^}]*setSnapshot\(event\.snapshot\)[^}]*return;/s);
});

test("human input waits behind unread story events with a visible notice", () => {
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");

  assert.match(source, /const readyHumanInput = pendingHumanInput && queuedEvents\.length === 0 \? pendingHumanInput : null;/);
  assert.match(source, /const humanInputNoticeLeadCount = 2;/);
  assert.match(source, /queuedEvents\.length > 0 && queuedEvents\.length <= humanInputNoticeLeadCount \? pendingHumanInput : null;/);
  assert.doesNotMatch(source, /const visibleBeforeInput = queuedRef\.current;/);
  assert.match(source, /入力前確認/);
  assert.match(source, /function statusForPendingHumanInput\(remainingCount: number\)/);
  assert.match(source, /setGameStatus\(statusForPendingHumanInput\(queuedRef\.current\.length\)\);/);
  assert.match(source, /setGameStatus\(pendingHumanInput \? statusForPendingHumanInput\(remaining\.length\) : statusForVisibleStory\(next, remaining\.length\)\);/);
  assert.match(source, /function renderPendingHumanInputNotice/);
  assert.match(source, /次へで入力前の会話を確認してください/);
  assert.match(source, /const storyBackDisabled = paused \|\| Boolean\(pendingHumanInput\)/);
  assert.match(source, /const storyNextDisabled =\s*paused \|\|\s*Boolean\(readyHumanInput\)/);
  assert.match(source, /const canRetreat = !paused && !pendingHumanInput/);
  assert.match(source, /const canAdvance = !paused && !readyHumanInput/);
  assert.match(source, /\}, \[events\.length, paused, pendingHumanInput, readyHumanInput, running\]\);/);
  assert.doesNotMatch(source, /入力待ちあり/);
});

test("village spectator history redacts secret event messages and speakers", () => {
  const event: GameEvent = {
    id: 1,
    createdAt: "2026-05-18T00:00:00.000Z",
    round: 1,
    phase: "werewolf_discussion",
    type: "player_speech",
    message: "人狼だけに見える相談内容",
    playerId: "p1",
    playerName: "シオン",
    role: "Werewolf",
    data: { visibility: "werewolf" },
    snapshot: {
      round: 1,
      phase: "werewolf_discussion",
      winner: null,
      players: [],
      aliveCount: 0,
      werewolfCount: 0,
      villageCount: 0
    }
  };

  assert.equal(eventMessageForSpectator(event, "village"), "あなたの視点では非公開情報です\n次へ進んでください");
  assert.equal(eventSpeakerForSpectator(event, "village", "Japanese"), "進行");
  assert.equal(eventMessageForSpectator(event, "omniscient"), "人狼だけに見える相談内容");
  assert.equal(eventSpeakerForSpectator(event, "omniscient", "Japanese"), "シオン");
});
