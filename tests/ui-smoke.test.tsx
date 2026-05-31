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
  formatMessage,
  mentionedCharactersForEvent,
  mentionedCharactersForText,
  stageLightMoodForEvent,
  stageLightToneForEvent,
  storyRunControlState,
  streamErrorMessageFromData,
  voteResultHasVisibleData,
  winnerLabelForRoster
} from "../src/client/App";
import { roleLabel as displayRoleLabel } from "../src/game/i18n";
import type { GameEvent } from "../src/game/types";

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
  assert.match(html, /会話ログ/);
  assert.match(html, /投票結果/);
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

test("roster vote result overlay is wired next to the conversation log", () => {
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  assert.match(source, /useState<"history" \| "votes" \| null>/);
  assert.match(source, /const latestVoteResult = useMemo\(\(\) => events\.filter\(voteResultHasVisibleData\)\.at\(-1\)/);
  assert.match(source, /function renderVoteResultsPopover/);
  assert.match(source, /aria-label="投票結果"/);
  assert.match(source, /dataArray<VoteDetail>\(latestVoteResult, "votes"\)/);
  assert.match(source, /理由は非公開/);
  assert.match(css, /\.player-section-actions\s*\{/);
  assert.match(css, /\.vote-result-popover/);
  assert.match(css, /\.vote-cast-list\s*\{/);
});

test("winner label appears only when a winner exists", () => {
  assert.equal(winnerLabelForRoster(null, "Japanese"), null);
  assert.equal(winnerLabelForRoster("village", "Japanese"), "勝者: 人間側");
  assert.equal(winnerLabelForRoster("werewolf", "Japanese"), "勝者: 狼陣営");
});

test("dialogue keeps character names as ordinary text", () => {
  const html = renderToStaticMarkup(createElement("p", null, formatMessage("シオンがガクを疑う。キリエは保留です。")));

  assert.match(html, /シオンがガクを疑う/);
  assert.match(html, /キリエは保留です/);
  assert.doesNotMatch(html, /character-name-mention/);
  assert.doesNotMatch(html, /--character-name-color/);
});

test("dialogue mentions resolve to transparent character portraits", () => {
  const mentions = mentionedCharactersForText("シオンがガクを疑う。キリエは保留です。シオンは継続。");

  assert.deepEqual(mentions.map((mention) => mention.id), ["p8", "p9", "p13"]);
  assert.deepEqual(mentions.map((mention) => mention.name), ["シオン", "ガク", "キリエ"]);
  assert.match(mentions[0].image ?? "", /\/assets\/characters\/p1_shion\.png$/);
  assert.match(mentions[1].image ?? "", /\/assets\/characters\/p2_gaku\.png$/);
});

test("event mention thumbnails include visible detail data", () => {
  const event: GameEvent = {
    id: 99,
    createdAt: "2026-05-27T00:00:00.000Z",
    round: 1,
    phase: "voting",
    type: "vote_result",
    message: "投票結果が出ました。",
    data: {
      reason: "キリエの指摘が決め手",
      totals: [
        { targetId: "p8", targetName: "シオン", count: 3 },
        { targetId: "p9", targetName: "ガク", count: 2 }
      ]
    },
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

  assert.deepEqual(mentionedCharactersForEvent(event).map((mention) => mention.id), ["p8", "p9"]);
});

test("round summary mention thumbnails include summary board names", () => {
  const event: GameEvent = {
    id: 100,
    createdAt: "2026-05-27T00:00:00.000Z",
    round: 2,
    phase: "day_discussion",
    type: "round_summary",
    message: "ラウンド2の集計です。",
    data: {
      nightDeaths: [{ playerId: "p12", playerName: "ナギサ" }],
      claims: [
        {
          speakerId: "p4",
          speakerName: "イオリ",
          claim: { type: "seer_result", role: "Seer", targetId: "p5", targetName: "コハル", camp: "village" }
        }
      ],
      suspects: [{ sourceId: "p8", sourceName: "シオン", targetId: "p13", targetName: "キリエ", reason: "発言が揺れた" }],
      trusts: [{ sourceId: "p9", sourceName: "ガク", targetId: "p10", targetName: "アカネ", reason: "投票筋が自然" }],
      totals: [{ targetId: "p11", targetName: "マヒロ", count: 4 }]
    },
    snapshot: {
      round: 2,
      phase: "day_discussion",
      winner: null,
      players: [],
      aliveCount: 0,
      werewolfCount: 0,
      villageCount: 0
    }
  };

  assert.deepEqual(mentionedCharactersForEvent(event).map((mention) => mention.id), ["p12", "p4", "p5", "p13", "p8", "p10", "p9", "p11"]);
});

test("setup cast character names stay neutral before game start", () => {
  const html = renderToStaticMarkup(createElement(App));
  const start = html.indexOf('class="setup-cast-grid selectable"');
  const end = html.indexOf('class="field setup-field player-count-field"', start);
  const castHtml = html.slice(start, end);

  assert.ok(start >= 0);
  assert.ok(end > start);
  const castNames = [...castHtml.matchAll(/<button[^>]*>.*?<span>([^<]+)<\/span><\/button>/g)].map(([, name]) => name);
  const castImages = [...castHtml.matchAll(/<img src="([^"]+)"/g)].map(([, src]) => src);
  assert.deepEqual(castNames, ["セナ", "ノゾミ", "アキオミ", "イオリ", "コハル", "シュウヘイ", "サクラコ"]);
  assert.deepEqual(castImages, [
    "/assets/characters/thumbs/p13_sena.webp",
    "/assets/characters/thumbs/p14_nozomi.webp",
    "/assets/characters/thumbs/p15_akiomi.webp",
    "/assets/characters/thumbs/p9_iori.webp",
    "/assets/characters/thumbs/p12_koharu.webp",
    "/assets/characters/thumbs/p6_shuhei.webp",
    "/assets/characters/thumbs/p10_sakurako.webp"
  ]);
  assert.doesNotMatch(castHtml, /character-name/);
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
    eventMessageForSpectator({ ...event, message: "1日目の昼が始まりました" }, "omniscient"),
    "1日目の昼が始まりました"
  );
  assert.match(source, /text=\{eventMessageForSpectator\(event, spectatorMode\)\}/);
});

test("stage lighting follows speech mood and avoids repeated tones", () => {
  const baseEvent: GameEvent = {
    id: 12,
    createdAt: "2026-05-24T00:00:00.000Z",
    round: 1,
    phase: "day_discussion",
    type: "player_speech",
    message: "ガクの発言には矛盾がある。ここは人狼の可能性を疑いたい。",
    playerId: "p8",
    playerName: "シオン",
    data: { suspects: [{ targetId: "p9", targetName: "ガク", reason: "矛盾" }] },
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
  assert.equal(stageLightMoodForEvent({ ...baseEvent, message: "ナギサは白く見えるので信頼したい。", data: { trusts: [{ targetId: "p12" }] } }), "trust");
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

test("story uses mention thumbnails instead of the ambient hero cast row", () => {
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  assert.match(source, /const maxMentionedCharacterCards = 5;/);
  assert.match(source, /function renderMentionedCharacterStrip/);
  assert.match(source, /mentionedCharactersForEvent\(currentEvent, hidden, spectatorMode, language\)/);
  assert.match(source, /className="mentioned-character-strip"/);
  assert.match(source, /mentioned-character-more/);
  assert.match(source, /image:\s*getCharacterPortrait\(id\)/);
  assert.doesNotMatch(source, /function renderHeroCast/);
  assert.doesNotMatch(source, /className=\{`hero-cast/);
  assert.match(css, /\.mentioned-character-strip\s*\{[^}]*left:\s*84px[^}]*top:\s*50%[^}]*transform:\s*translateY\(-50%\)/s);
  assert.match(css, /@media \(max-width: 980px\)[\s\S]*\.story-copy\s*\{[^}]*padding:\s*54px 24px 154px 56px[^}]*\}[\s\S]*\.mentioned-character-strip\s*\{[^}]*left:\s*56px/s);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*\.story-copy\s*\{[^}]*padding:\s*42px 16px 320px 32px[^}]*\}[\s\S]*\.mentioned-character-strip\s*\{[^}]*left:\s*32px/s);
  assert.match(css, /\.mentioned-character-thumb\s*\{[^}]*width:\s*112px[^}]*height:\s*128px[^}]*background:\s*transparent/s);
  assert.match(css, /\.mentioned-character-thumb\s*\{[^}]*object-fit:\s*contain/s);
  assert.doesNotMatch(css, /\.mentioned-character-strip\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.mentioned-character-more-token/);
  assert.match(css, /@keyframes mentioned-character-arrive/);
  assert.doesNotMatch(css, /\.hero-cast\s*\{/);
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

test("full portrait images stay limited to active speaker and mention cues", () => {
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");

  assert.equal(source.match(/getCharacterPortrait\(/g)?.length, 3);
  assert.match(source, /const activeSpeakerImage = currentEvent \? getCharacterPortrait\(currentEvent\.playerId\) : null;/);
  assert.match(source, /image:\s*getCharacterPortrait\(id\)/);
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
  assert.equal(voteResultHasVisibleData({ ...baseEvent, data: { totals: [{ targetId: "p8", targetName: "シオン", count: 2 }] } }), true);
  assert.equal(
    voteResultHasVisibleData({
      ...baseEvent,
      data: { votes: [{ voterId: "p9", voterName: "ガク", targetId: "p8", targetName: "シオン" }] }
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

test("view toggle hover follows next button treatment", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  const hoverRule = css.match(
    /\.icon-button\.primary\.setup-confirm-button:not\(:disabled\):hover,\s*\.icon-button\.primary\.story-next:not\(:disabled\):hover,\s*\.view-toggle button:not\(:disabled\):hover\s*\{[^}]*\}/s
  );

  assert.ok(hoverRule);
  assert.match(hoverRule[0], /border-color:\s*rgba\(164,\s*246,\s*232,\s*0\.72\)/);
  assert.match(hoverRule[0], /#171f21/);
  assert.match(hoverRule[0], /transform:\s*translateY\(-1px\)/);
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

test("living roster cards open public character profile popover", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");

  assert.match(source, /const characterProfileByIdMap = new Map\(characterProfiles\.map/);
  assert.match(source, /function openCharacterProfile\(playerId: string, trigger\?: HTMLButtonElement\)/);
  assert.match(source, /onClick=\{\(event\) => openCharacterProfile\(player\.id, event\.currentTarget\)\}/);
  assert.match(source, /aria-label=\{`\$\{player\.name\}の公開プロフィールを表示`\}/);
  assert.match(source, /function renderCharacterProfilePopover\(\)/);
  assert.match(source, /className="player-history-popover character-profile-popover"/);
  assert.doesNotMatch(source, /aria-modal="true"/);
  assert.match(source, /公開人物メモ/);
  assert.match(source, /roleDisplay\(player, spectatorMode, language, profileRevealed\)/);
  assert.match(source, /profile\.values/);
  assert.match(source, /characterRelationEntries\(selectedCharacterId, new Set/);
  assert.match(source, /availablePlayerIds\.has\(id\)/);
  assert.doesNotMatch(source, /profile\.speechStyle/);
  assert.doesNotMatch(source, /profile\.sampleLines\.slice\(0, 2\)/);
  assert.doesNotMatch(source, /character-profile-tagline/);
  assert.doesNotMatch(source, /character-profile-lines/);
  assert.doesNotMatch(source, /event\.key !== "Tab"/);
  assert.doesNotMatch(css, /\.character-profile-backdrop/);
  assert.doesNotMatch(css, /\.character-profile-dialog/);
  assert.match(css, /\.character-profile-popover \.overlay-body\s*\{/);
  assert.match(css, /\.character-profile-body\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.character-profile-thumb\s*\{[^}]*width:\s*68px[^}]*height:\s*68px/s);
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

test("roster and setup character surfaces use the requested texture treatment", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  assert.match(css, /\.dead-player\s*\{[^}]*background:\s*linear-gradient\([^}]*#070b10/s);
  assert.doesNotMatch(css, /\.dead-player\s*\{[^}]*var\(--ship-[^)]+-texture\)/s);
  assert.doesNotMatch(css, /\.dead-player\.human-player\s*\{[^}]*var\(--ship-[^)]+-texture\)/s);
  assert.match(css, /\.player-card\s*\{[^}]*background-size:\s*auto,\s*auto,\s*140px 140px,\s*auto/s);
  assert.match(css, /\.setup-cast-grid button\s*\{[^}]*background-size:\s*auto,\s*auto,\s*var\(--ship-trim-size\),\s*auto/s);
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
  // Player mode trusts the server-redacted snapshot, but a non-Hidden role is only shown once it
  // has been "revealed" in the story: the viewer's own role plus, for a werewolf, each ally after
  // they name themselves at the face-off (see revealedRoleIds). The gate is the `revealed` arg.
  assert.match(source, /const roleVisible = mode === "omniscient" \|\| \(mode === "player" && role !== "Hidden" && revealed\);/);
  assert.match(source, /const revealed = revealedRoleIds\.has\(player\.id\);/);
  assert.match(source, /const roleLabel = roleDisplay\(player, spectatorMode, language, revealed\);/);
  // The face-off self-naming speech is what flips an ally from 不明 to their role.
  assert.match(source, /function faceoffSpeakerId\(event: GameEvent\): string \| undefined/);
  assert.match(source, /event\.type === "player_speech" && event\.phase === "werewolf_discussion"/);
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
  assert.match(source, /target\.closest\("input, select, textarea, \[contenteditable='true'\]"\)/);
  assert.match(source, /function isButtonShortcutTarget/);
  assert.match(source, /\(event\.key === "Enter" && isButtonShortcutTarget\(event\.target\)\)/);
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
  assert.equal(
    streamErrorMessageFromData('{"message":"429 {\\"error\\":{\\"type\\":\\"rate_limit_error\\"}}"}'),
    "生成リクエストが混み合っています。少し待ってから再開してください。"
  );
  assert.equal(streamErrorMessageFromData('{"message":"upstream failed"}'), "upstream failed");
  assert.equal(streamErrorMessageFromData("plain failure"), "plain failure");
});

test("game start begins generation after settings are confirmed", () => {
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");

  assert.match(source, /const revealFirstEventRef = useRef\(false\)/);
  assert.match(source, /function confirmSettings\(\)/);
  assert.match(source, /setSettingsConfirmed\(true\);/);
  assert.doesNotMatch(source, /setSettingsConfirmed\(true\);\s*startGame\(\);/);
  assert.match(source, /function startOpeningScene\(\)/);
  assert.match(source, /startGame\(\{ revealFirstEvent: true \}\);/);
  assert.match(source, /const primaryActionLabel = primaryActionIsGameStart \? "ゲーム開始"/);
  assert.match(source, /<span>設定を決定<\/span>/);
  assert.match(source, /ゲーム開始を押すと対局を開始します。/);
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
  assert.match(source, /あなたの意思決定が近づいています/);
  assert.match(source, /次へで入力前の会話を確認してください/);
  assert.match(source, /submitHumanInput\(\{ targetId: humanTargetId \}\)/);
  assert.match(source, /submitHumanInput\(\{ targetId: null \}\)/);
  assert.doesNotMatch(source, /あなたの判断が近づいています/);
  assert.doesNotMatch(source, /humanReason/);
  assert.doesNotMatch(source, /setHumanReason/);
  assert.doesNotMatch(source, /placeholder="理由"/);
  assert.match(source, /const storyBackDisabled = paused \|\| Boolean\(readyHumanInput\)/);
  assert.match(source, /const storyNextDisabled =\s*paused \|\|\s*Boolean\(readyHumanInput\)/);
  assert.match(source, /const canRetreat = !paused && !readyHumanInput/);
  assert.match(source, /const canAdvance = !paused && !readyHumanInput/);
  assert.match(source, /\}, \[events\.length, paused, pendingHumanInput, readyHumanInput, running, selectedCharacterId, settingsConfirmed, startupWaitActive\]\);/);
  assert.doesNotMatch(source, /入力待ちあり/);
});

test("village spectator history redacts secret event messages and speakers", () => {
  const event: GameEvent = {
    id: 1,
    createdAt: "2026-05-18T00:00:00.000Z",
    round: 1,
    phase: "werewolf_discussion",
    type: "player_speech",
    message: "シオンとガクだけに見える相談内容",
    playerId: "p8",
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
  assert.deepEqual(mentionedCharactersForEvent(event, false, "village").map((mention) => mention.id), []);
  assert.equal(eventMessageForSpectator(event, "omniscient"), "シオンとガクだけに見える相談内容");
  assert.equal(eventSpeakerForSpectator(event, "omniscient", "Japanese"), "シオン");
  assert.deepEqual(mentionedCharactersForEvent(event, false, "omniscient").map((mention) => mention.id), ["p8", "p9"]);
});

test("guided UI tour spotlights the main controls at match start", () => {
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  // Spotlight anchors are wired onto the existing controls (role breakdown ref
  // already existed; roster list / log+vote actions / story controls are added).
  assert.match(source, /const rosterListRef = useRef<HTMLDivElement \| null>\(null\)/);
  assert.match(source, /const playerActionsRef = useRef<HTMLDivElement \| null>\(null\)/);
  assert.match(source, /const storyControlsRef = useRef<HTMLDivElement \| null>\(null\)/);
  assert.match(source, /className="player-list-scroll" ref=\{rosterListRef\}/);
  assert.match(source, /className="player-section-actions" ref=\{playerActionsRef\}/);
  assert.match(source, /className="story-controls" ref=\{storyControlsRef\}/);

  // The four ordered steps the player asked for.
  assert.match(source, /getEl: \(\) => roleDistributionRef\.current,\s*\n\s*title: "役職内訳"/);
  assert.match(source, /getEl: \(\) => rosterListRef\.current,\s*\n\s*title: "プレイヤー一覧"/);
  assert.match(source, /getEl: \(\) => playerActionsRef\.current,\s*\n\s*title: "会話ログ・投票結果"/);
  assert.match(source, /getEl: \(\) => storyControlsRef\.current,\s*\n\s*title: "視点・BGM・進行"/);

  // Launches once per match after the opening board is revealed; reset on new game.
  assert.match(source, /tourLaunchedRef\.current = false;\s*\n\s*setTourStepIndex\(null\);/);
  assert.match(source, /if \(events\.length === 0\) \{\s*\n\s*return;\s*\n\s*\}\s*\n\s*tourLaunchedRef\.current = true;/);

  // Overlay is rendered, skippable, and keyboard-driven; not a blanket modal.
  assert.match(source, /function renderUiTour\(\)/);
  assert.match(source, /\{renderUiTour\(\)\}/);
  assert.match(source, /className="ui-tour-skip" onClick=\{finishTour\}/);
  assert.doesNotMatch(source, /aria-modal="true"/);

  // Focus moves into the callout (no scroll) and Tab is trapped within it.
  assert.match(source, /tourCalloutRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /event\.key === "Tab"/);

  // Spotlight + callout styling exists.
  assert.match(css, /\.ui-tour-spotlight\s*\{[^}]*box-shadow:[^}]*100vmax/s);
  assert.match(css, /\.ui-tour-callout\s*\{/);
});

test("returning players skip the tour for a one-time startup generation gate", () => {
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  // "Seen the tour" is persisted across sessions and read with a safe fallback.
  assert.match(source, /const UI_TOUR_SEEN_KEY = "among-ai:ui-tour-seen";/);
  assert.match(source, /function hasSeenUiTour\(\): boolean/);
  assert.match(source, /window\.localStorage\.getItem\(UI_TOUR_SEEN_KEY\) === "1"/);
  assert.match(source, /function markUiTourSeen\(\): void/);
  assert.match(source, /window\.localStorage\.setItem\(UI_TOUR_SEEN_KEY, "1"\)/);

  // First match runs the tour; later matches show the wait gate.
  assert.match(source, /if \(hasSeenUiTour\(\)\) \{\s*\n\s*startStartupWait\(\);\s*\n\s*return;\s*\n\s*\}/);
  // "Seen" is persisted only after the tour is shown and then closed (skip or finish),
  // so a mid-tour refresh keeps onboarding instead of permanently skipping it.
  assert.match(source, /tourWasActiveRef\.current = false;\s*\n\s*markUiTourSeen\(\);/);
  assert.doesNotMatch(source, /return;\s*\n\s*\}\s*\n\s*markUiTourSeen\(\);/);
  // A single tunable knob drives every generation pause (startup gate + thinking HUD),
  // so the 5s/6s value can be changed in one place.
  assert.match(source, /const GENERATION_PAUSE_MS = 6000;/);
  assert.match(source, /const PROCESSING_HUD_MIN_VISIBLE_MS = GENERATION_PAUSE_MS;/);
  assert.match(source, /const STARTUP_WAIT_MS = GENERATION_PAUSE_MS;/);
  // The thinking HUD stays up for that minimum once a wait begins, batching the pause
  // instead of advancing after a single freshly-streamed event and stalling again.
  assert.match(source, /const remaining = PROCESSING_HUD_MIN_VISIBLE_MS - \(Date\.now\(\) - shownAt\);/);
  assert.match(source, /function startStartupWait\(\)/);
  assert.match(source, /startupWaitTimerRef\.current = window\.setTimeout\(\(\) => \{[^}]*setStartupWaitActive\(false\);[^}]*\}, STARTUP_WAIT_MS\);/s);

  // The gate reuses the ordinary "thinking" HUD instead of a dedicated modal: no
  // bespoke startup-wait panel/backdrop is rendered or styled anymore.
  assert.doesNotMatch(source, /function renderStartupWait\(/);
  assert.doesNotMatch(source, /className="startup-wait"/);
  assert.doesNotMatch(source, /生成中です/);
  assert.doesNotMatch(css, /\.startup-wait/);

  // startupWaitActive folds into the shared processing state, so the same
  // "AIプレイヤーが考えています" HUD is shown while the gate is active.
  assert.match(source, /const storyProcessingActive = storyWaitingForStream \|\| processingHudVisible \|\| startupWaitActive;/);
  assert.match(source, /if \(!processingHudVisible && !startupWaitActive\) \{\s*\n\s*return null;/);
  assert.match(source, /const title = "AIプレイヤーが考えています";/);

  // The gate still blocks story progress (keyboard + buttons) so the story
  // cannot advance while generation is being buffered.
  assert.match(source, /selectedCharacterId \|\|\s*\n\s*startupWaitActive \|\|/);
  assert.match(source, /const storyBackDisabled = paused \|\| Boolean\(readyHumanInput\) \|\| events\.length === 0 \|\| startupWaitActive;/);
});
