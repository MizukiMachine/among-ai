import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  App,
  characterReadHistoryForEvents,
  clusterReads,
  dedupeReadsBySourceTarget,
  eventPhaseMetaLabel,
  eventMessageForSpectator,
  eventRoundLabel,
  eventSpeakerForSpectator,
  formatMessage,
  hasSeenHumanInputRevealAnchor,
  isCurrentHumanInputRevealAnchor,
  mentionedCharactersForEvent,
  mentionedCharactersForText,
  personalVictoryOutcomeForSnapshot,
  shouldRevealBlockingHumanInputAfterAdvance,
  shouldRevealNonBlockingHumanInputAfterAdvance,
  stageLightMoodForEvent,
  stageLightToneForEvent,
  storyRunControlState,
  streamErrorMessageFromData,
  voteResultHasVisibleData,
  winnerLabelForRoster
} from "../src/client/App";
import { roleLabel as displayRoleLabel } from "../src/game/i18n";
import type { GameEvent, GameSnapshot } from "../src/game/types";

test("app shell renders spectator controls and role distribution", () => {
  const html = renderToStaticMarkup(createElement(App));

  assert.match(html, /among ai/);
  assert.match(html, /人狼として参加/);
  assert.match(html, /プレイ目標/);
  assert.match(html, /このゲームは人狼陣営をシュミレーション出来るゲームです/);
  assert.match(html, /仲間の演技を見ながら村人の全排除を狙います/);
  assert.doesNotMatch(html, /狼陣営でプレイ/);
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
  assert.match(html, /人数（多いほど難易度が高くなります）/);
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

test("conversation log keeps the full visible history scrollable", () => {
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  assert.match(source, /const conversationHistory = useMemo\(\(\) => \[\.\.\.events\]\.reverse\(\), \[events\]\);/);
  assert.match(source, /conversationHistory\.map\(\(event\) =>/);
  assert.match(source, /const speaker = eventSpeakerForSpectator\(event, spectatorMode, language\);/);
  assert.match(source, /history-speaker-\$\{event\.id\}/);
  assert.match(source, /aria-label="会話ログ一覧"/);
  assert.doesNotMatch(source, /events\.slice\(-6\)/);
  assert.doesNotMatch(source, /shortText\(message,\s*76\)/);
  assert.match(css, /\.overlay-body\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;/s);
  assert.match(css, /\.player-history-popover \.overlay-body\s*\{[^}]*scrollbar-gutter:\s*stable both-edges;/s);
  assert.match(css, /\.conversation-log-list p\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
  assert.match(css, /\.conversation-log-meta strong\s*\{[^}]*font-weight:\s*880;/s);
});

test("winner label appears only when a winner exists", () => {
  assert.equal(winnerLabelForRoster(null, "Japanese"), null);
  assert.equal(winnerLabelForRoster("village", "Japanese"), "勝者: 人間側");
  assert.equal(winnerLabelForRoster("werewolf", "Japanese"), "勝者: 狼陣営");
});

test("personal game-end outcome calls out unmet win conditions", () => {
  const snapshot: GameSnapshot = {
    round: 3,
    phase: "ended",
    winner: "village",
    winnerCamp: "village",
    winnerIds: ["p2"],
    players: [
      {
        id: "p1",
        name: "シオン",
        role: "Werewolf",
        camp: "werewolf",
        persona: "cautious",
        alive: false,
        model: "human",
        memoryCount: 0
      },
      {
        id: "p2",
        name: "ガク",
        role: "Villager",
        camp: "village",
        persona: "logical",
        alive: true,
        model: "scripted",
        memoryCount: 0
      }
    ],
    aliveCount: 1,
    werewolfCount: 0,
    villageCount: 1
  };

  const outcome = personalVictoryOutcomeForSnapshot(snapshot, "p1", "Japanese");

  assert.equal(outcome?.status, "lost");
  assert.equal(outcome?.title, "勝利条件未達成");
  assert.equal(outcome?.message, "あなたは勝利条件を満たせませんでした。");
  assert.match(outcome?.detail ?? "", /勝利陣営は人間側、あなたの陣営は狼陣営です。/);

  const winOutcome = personalVictoryOutcomeForSnapshot(
    {
      ...snapshot,
      winner: "werewolf",
      winnerCamp: "werewolf",
      winnerIds: ["p1"],
      werewolfCount: 1,
      villageCount: 0,
      players: snapshot.players.map((player) =>
        player.id === "p1" ? { ...player, alive: true } : { ...player, alive: false }
      )
    },
    "p1",
    "Japanese"
  );

  assert.equal(winOutcome?.status, "won");
  assert.equal(winOutcome?.title, "勝利条件達成");
  assert.equal(winOutcome?.message, "あなたは勝利条件を満たしました。");
});

test("game-end screen has a personal loss presentation", () => {
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  assert.match(source, /event\.type === "game_ended"/);
  assert.match(source, /renderGameEndOutcome\(event, hidden\)/);
  assert.match(source, /あなたは勝利条件を満たせませんでした。/);
  assert.match(source, /className=\{`game-end-result \$\{resultClass\}`\}/);
  assert.match(source, /personal-\$\{gameEndOutcome\.status\}/);
  assert.match(css, /\.story-hero\.game_ended\.personal-lost \.chapel-backdrop::after\s*\{/);
  assert.match(css, /\.story-hero\.game_ended\.personal-won \.chapel-backdrop::after\s*\{/);
  assert.match(css, /\.game-end-result\.lost\s*\{/);
  assert.match(css, /\.game-end-result\.won\s*\{/);
  assert.match(css, /@keyframes game-end-alert-pulse/);
  assert.match(css, /@keyframes game-end-victory-mark/);
  assert.match(css, /@keyframes game-end-victory-glow/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.game-end-result/s);
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
  assert.match(
    source,
    /gameEndOutcome\?\.status === "lost"[\s\S]*\? "crimson"[\s\S]*gameEndOutcome\?\.status === "won"[\s\S]*\? "emerald"[\s\S]*currentStageLightTone \?\? stageLightToneForEvent\(currentEvent, hidden, events\.length\)[\s\S]*currentStageLightTone \?\? "cyan";/
  );
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
  assert.match(source, /!speechInputPrompt && currentEvent && currentEvent\.type !== "game_ended" \? renderEventDetails\(currentEvent, hidden\) : null/);
  assert.match(source, /!speechInputPrompt && currentEvent \? renderMentionedCharacterStrip\(mentionedCharacters, currentEvent\.id\) : null/);
  assert.doesNotMatch(source, /function renderHeroCast/);
  assert.doesNotMatch(source, /className=\{`hero-cast/);
  assert.match(css, /\.mentioned-character-strip\s*\{[^}]*position:\s*relative[^}]*width:\s*min\(100%,\s*860px\)[^}]*transform:\s*none/s);
  assert.match(css, /\.mentioned-character-strip\s*\{[^}]*padding-bottom:\s*18px;/s);
  assert.doesNotMatch(css, /\.mentioned-character-strip\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /@media \(max-width: 980px\)[\s\S]*\.story-copy\s*\{[^}]*padding:\s*54px 24px 28px 56px[^}]*\}[\s\S]*\.mentioned-character-strip\s*\{[^}]*width:\s*min\(100%,\s*640px\)/s);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*\.story-copy\s*\{[^}]*padding:\s*42px 16px 28px 32px[^}]*\}[\s\S]*\.mentioned-character-strip\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /\.mentioned-character-thumb\s*\{[^}]*width:\s*112px[^}]*height:\s*128px[^}]*background:\s*transparent/s);
  assert.match(css, /\.mentioned-character-thumb\s*\{[^}]*object-fit:\s*contain/s);
  assert.doesNotMatch(css, /\.mentioned-character-strip\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.mentioned-character-more-token/);
  assert.match(css, /@keyframes mentioned-character-arrive/);
  assert.doesNotMatch(css, /\.hero-cast\s*\{/);
});

test("speech event details hide suspicion and trust chips in the story panel", () => {
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");

  assert.match(source, /const showReadChips = event\.type !== "player_speech";/);
  assert.match(
    source,
    /const suspects = hidden \|\| !showReadChips \? \[\] : dataArray<PlayerReadMetadata>\(event, "suspects"\);/
  );
  assert.match(
    source,
    /const trusts = hidden \|\| !showReadChips \? \[\] : dataArray<PlayerReadMetadata>\(event, "trusts"\);/
  );
  assert.match(source, /suspects\.map\(\(read, index\) =>/);
  assert.match(source, /trusts\.map\(\(read, index\) =>/);
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

  assert.equal(source.match(/getCharacterPortrait\(/g)?.length, 5);
  assert.match(source, /const activeSpeakerImage = currentEvent \? getCharacterPortrait\(currentEvent\.playerId\) : null;/);
  assert.match(source, /image:\s*getCharacterPortrait\(id\)/);
  assert.match(source, /getCharacterPortrait\(speechInputPrompt\.playerId\)/);
  assert.match(source, /className=\{`hero-character \$\{speechInputPrompt \? "human-input-character" : ""\}`\}/);
  assert.match(source, /src=\{heroCharacterImage\}/);
  assert.match(source, /className="setup-cast-grid selectable"[\s\S]*<CharacterImage[\s\S]*src=\{getCharacterImage\(player\.id\)\}[\s\S]*decoding="sync"[\s\S]*fetchPriority="high"/);
  assert.doesNotMatch(source, /setup-cast-grid[\s\S]{0,800}getCharacterPortrait/);
  assert.doesNotMatch(source, /className="player-avatar(?: small)?"[\s\S]{0,120}src=\{getCharacterPortrait/);
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

test("character read history shows visible occurred reads for the selected player", () => {
  const snapshot: GameSnapshot = {
    round: 2,
    phase: "day_discussion",
    winner: null,
    players: [],
    aliveCount: 0,
    werewolfCount: 0,
    villageCount: 0
  };
  const events: GameEvent[] = [
    {
      id: 1,
      createdAt: "2026-05-24T00:00:00.000Z",
      round: 1,
      phase: "day_discussion",
      type: "player_speech",
      message: "シオンの読み",
      playerId: "p1",
      playerName: "シオン",
      data: {
        suspects: [{ targetId: "p2", targetName: "ガク", reason: "最初の疑い" }],
        trusts: [{ targetId: "p3", targetName: "アカネ", reason: "返答が自然" }]
      },
      snapshot
    },
    {
      id: 2,
      createdAt: "2026-05-24T00:01:00.000Z",
      round: 2,
      phase: "day_discussion",
      type: "player_speech",
      message: "シオンの更新",
      playerId: "p1",
      playerName: "シオン",
      data: {
        suspects: [{ targetId: "p2", targetName: "ガク", reason: "疑いを更新" }]
      },
      snapshot
    },
    {
      id: 3,
      createdAt: "2026-05-24T00:02:00.000Z",
      round: 2,
      phase: "werewolf_discussion",
      type: "player_speech",
      message: "狼だけの読み",
      playerId: "p1",
      playerName: "シオン",
      data: {
        visibility: "werewolf",
        trusts: [{ targetId: "p4", targetName: "マヒロ", reason: "仲間の相談" }]
      },
      snapshot
    },
    {
      id: 4,
      createdAt: "2026-05-24T00:03:00.000Z",
      round: 2,
      phase: "day_discussion",
      type: "round_summary",
      message: "集計",
      data: {
        suspects: [{ sourceId: "p1", sourceName: "シオン", targetId: "p5", targetName: "ナギサ", reason: "集計済み" }]
      },
      snapshot
    }
  ];

  assert.deepEqual(characterReadHistoryForEvents(events, "p1", "village"), {
    suspects: [
      {
        sourceId: "p1",
        sourceName: "シオン",
        targetId: "p2",
        targetName: "ガク",
        reason: "疑いを更新",
        weight: undefined,
        eventId: 2,
        round: 2
      }
    ],
    trusts: [
      {
        sourceId: "p1",
        sourceName: "シオン",
        targetId: "p3",
        targetName: "アカネ",
        reason: "返答が自然",
        weight: undefined,
        eventId: 1,
        round: 1
      }
    ]
  });
  assert.deepEqual(characterReadHistoryForEvents(events, "p1", "omniscient").trusts.map((read) => read.targetId), ["p4", "p3"]);
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
  assert.match(css, /\.story-copy\s*\{[^}]*overflow:\s*visible/s);
  assert.match(css, /\.story-copy > p\s*\{[^}]*-webkit-line-clamp:\s*5/s);
  assert.doesNotMatch(css, /\.story-copy\s*\{[^}]*overflow-y:\s*auto/s);
  assert.doesNotMatch(css, /\.story-copy::-webkit-scrollbar/);
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
  assert.equal(displayRoleLabel("AlphaWolf", "Japanese"), "α人狼");
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
  assert.match(source, /aria-label=\{`\$\{player\.name\}の公開プロフィールを表示\$\{showKnownWerewolfBadge \? "、判明した人狼陣営" : ""\}`\}/);
  assert.match(source, /function renderCharacterProfilePopover\(\)/);
  assert.match(source, /className="player-history-popover character-profile-popover"/);
  assert.doesNotMatch(source, /aria-modal="true"/);
  assert.match(source, /公開人物メモ/);
  assert.match(source, /roleDisplay\(player, spectatorMode, language, profileRevealed\)/);
  assert.match(source, /profile\.values/);
  assert.match(source, /characterReadHistoryForEvents\(events, selectedCharacterId, spectatorMode\)/);
  assert.match(source, /<h3>この人物の読み<\/h3>/);
  assert.match(source, /renderCharacterReadColumn\("疑い", readHistory\.suspects, "suspect"\)/);
  assert.match(source, /renderCharacterReadColumn\("信頼", readHistory\.trusts, "trust"\)/);
  assert.doesNotMatch(source, /関係の傾向/);
  assert.doesNotMatch(source, /characterRelationEntries/);
  assert.doesNotMatch(source, /profile\.speechStyle/);
  assert.doesNotMatch(source, /profile\.sampleLines\.slice\(0, 2\)/);
  assert.doesNotMatch(source, /character-profile-tagline/);
  assert.doesNotMatch(source, /character-profile-lines/);
  assert.doesNotMatch(source, /event\.key !== "Tab"/);
  assert.doesNotMatch(css, /\.character-profile-backdrop/);
  assert.doesNotMatch(css, /\.character-profile-dialog/);
  assert.doesNotMatch(css, /\.character-profile-relations/);
  assert.match(css, /\.character-read-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
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

test("player roster hides persona and emphasizes role labels", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");

  assert.equal(displayRoleLabel("Hidden", "Japanese"), "不明");
  assert.equal(displayRoleLabel("AlphaWolf", "Japanese"), "α人狼");
  // Player mode trusts the server-redacted snapshot, but a non-Hidden role is only shown once it
  // has been "revealed" in the story: the viewer's own role plus, for a werewolf, each ally after
  // they name themselves at the face-off (see revealedRoleIds). Public victory-condition role
  // reveals override the redacted snapshot because the role has become story-visible information.
  assert.match(source, /const roleVisible = mode === "omniscient" \|\| \(mode === "player" && role !== "Hidden" && revealed\);/);
  assert.match(source, /const revealed = revealedRoleIds\.has\(player\.id\);/);
  assert.match(source, /const publicRole = publicRoleReveals\.get\(player\.id\);/);
  assert.match(source, /const roleLabel = publicRole \? displayRoleLabel\(publicRole, language\) : roleDisplay\(player, spectatorMode, language, revealed\);/);
  assert.match(source, /const visibleRoleLabel = player[\s\S]*publicRole[\s\S]*displayRoleLabel\(publicRole, language\)[\s\S]*roleDisplay\(player, spectatorMode, language, profileRevealed\)/);
  // The face-off self-naming speech is what flips an ally from 不明 to their role.
  assert.match(source, /function faceoffSpeakerId\(event: GameEvent\): string \| undefined/);
  assert.match(source, /event\.type === "player_speech" && event\.phase === "werewolf_discussion"/);
  assert.match(source, /function personaClassName\(persona: PlayerSnapshot\["persona"\] \| string \| undefined\): string/);
  assert.doesNotMatch(source, /className=\{`persona-pill \$\{personaClassName\(player\.persona\)\}`\}/);
  assert.match(css, /\.player-avatar\s*\{[^}]*width:\s*92px[^}]*height:\s*92px/s);
  assert.match(css, /\.player-card-badges\s*\{[^}]*top:\s*6px[^}]*right:\s*7px[^}]*display:\s*inline-flex/s);
  assert.match(source, /function renderHumanPlayerBadge\(\)/);
  assert.match(source, /<span>自分<\/span>/);
  assert.doesNotMatch(source, /<Gamepad2 size=\{12\} \/>/);
  assert.match(css, /\.player-main\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*grid-template-rows:\s*auto auto/s);
  assert.match(css, /\.player-name-row strong\s*\{[^}]*grid-column:\s*1[^}]*grid-row:\s*1/s);
  assert.match(css, /\.role-chip\s*\{[^}]*grid-column:\s*1[^}]*grid-row:\s*2[^}]*font-size:\s*15px/s);
  for (const persona of ["cautious", "aggressive", "logical", "opportunistic", "empathetic", "trickster", "stoic", "passionate"]) {
    assert.match(css, new RegExp(`\\.persona-${persona}\\s*\\{[^}]*border-color:[^}]*background:[^}]*color:`, "s"));
  }
});

test("known werewolf identities tint roster cards and show a moon badge", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");

  assert.match(source, /Moon,/);
  assert.match(source, /function isWerewolfRole\(role: Role \| string \| undefined\): boolean/);
  assert.match(source, /const knownWerewolfIds = useMemo/);
  assert.match(source, /const ids = new Set<string>\(\);/);
  assert.match(source, /const roleKnown = publicRole !== undefined \|\| spectatorMode === "omniscient" \|\| revealedRoleIds\.has\(player\.id\);/);
  assert.match(source, /ids\.add\(player\.id\);/);
  assert.match(source, /const knownWerewolf = knownWerewolfIds\.has\(player\.id\);/);
  assert.match(source, /const showKnownWerewolfBadge = knownWerewolf && !humanPlayer;/);
  assert.match(source, /\$\{knownWerewolf \? "known-werewolf" : ""\}/);
  assert.match(source, /function renderKnownWerewolfBadge\(\)/);
  assert.match(source, /className="known-werewolf-badge"/);
  assert.match(source, /<Moon size=\{13\} \/>/);
  assert.match(source, /className="player-card-badges"/);
  assert.match(source, /\{showKnownWerewolfBadge \? renderKnownWerewolfBadge\(\) : null\}/);
  assert.doesNotMatch(source, /renderKnownWerewolfPanel/);
  assert.doesNotMatch(source, /known-wolves-panel/);
  assert.match(css, /\.player-card\.known-werewolf\s*\{[^}]*rgba\(60,\s*16,\s*24,\s*0\.7\)[^}]*var\(--ship-decal-texture\)/s);
  assert.match(css, /\.player-card\.known-werewolf\.human-player\s*\{[^}]*rgba\(111,\s*72,\s*14,\s*0\.46\)[^}]*rgba\(60,\s*16,\s*24,\s*0\.72\)/s);
  assert.match(css, /\.known-werewolf-badge\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;[^}]*color:\s*#ffd782;/s);
  assert.doesNotMatch(css, /\.known-wolves-panel/);
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
  assert.match(source, /className="scene-placeholder setup-confirmed-summary"[\s\S]*renderSetupConfirmedActions\(\)/);
  assert.match(source, /summary: "deterministic"/);
  assert.match(source, /if \(revealFirstEventRef\.current\)\s*\{[^}]*const nextEvents = \[event\];[^}]*eventsRef\.current = nextEvents;[^}]*setEvents\(nextEvents\)[^}]*setSnapshot\(event\.snapshot\)[^}]*return;/s);
});

test("setup locks human play to the werewolf camp", () => {
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  assert.match(source, /const initialHumanEnabled = true;/);
  assert.match(source, /const initialHumanCampPreference: HumanCampPreference = "werewolf";/);
  assert.match(source, /className="field setup-field play-goal-field"/);
  assert.match(source, /className="setup-note play-goal-note"/);
  assert.match(source, /このゲームは人狼陣営をシュミレーション出来るゲームです/);
  assert.match(source, /仲間の演技を見ながら村人の全排除を狙います/);
  assert.match(source, /className="field setup-field play-goal-field"[\s\S]*<span>プレイ目標<\/span>[\s\S]*className="field setup-field participant-field"[\s\S]*<span>参加方式<\/span>/);
  assert.doesNotMatch(source, /label: "狼陣営でプレイ"/);
  assert.doesNotMatch(source, /label: "人間陣営"/);
  assert.doesNotMatch(source, /label: "ランダム"/);
  assert.match(source, /params\.set\("humanCamp", humanCampPreference\)/);
  assert.doesNotMatch(source, /className="segments human-camp-options"/);
  assert.match(css, /\.play-goal-field\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;/s);
  assert.doesNotMatch(css, /\.human-camp-options/);
});

test("human input waits behind unread story events with a visible notice", () => {
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  assert.match(source, /function isBlockingHumanInput\(request: HumanInputRequest \| null\): request is HumanInputRequest/);
  assert.match(source, /interface PendingHumanInputEntry/);
  assert.match(source, /const \[pendingHumanInputs, setPendingHumanInputsState\] = useState<PendingHumanInputEntry\[\]>\(\[\]\);/);
  assert.match(source, /const pendingHumanInputsRef = useRef<PendingHumanInputEntry\[\]>\(\[\]\);/);
  assert.match(source, /function enqueueHumanInput\(request: HumanInputRequest, revealAfterEventId: number \| null\)/);
  assert.match(source, /function acknowledgeActiveHumanInput\(\)/);
  assert.match(source, /function completeHumanInputRequest\(request: HumanInputRequest\)/);
  assert.match(source, /const pendingHumanInputEntry = pendingHumanInputs\[0\] \?\? null;/);
  assert.match(source, /const pendingHumanInput = pendingHumanInputEntry\?\.request \?\? null;/);
  assert.match(source, /const pendingHumanInputRevealAfterEventId = pendingHumanInputEntry\?\.revealAfterEventId \?\? null;/);
  assert.match(source, /const humanInputAnchorAcknowledged = pendingHumanInputEntry\?\.anchorAcknowledged \?\? false;/);
  assert.match(source, /const blockingHumanInput = isBlockingHumanInput\(pendingHumanInput\) \? pendingHumanInput : null;/);
  assert.match(source, /const nonBlockingHumanInput = pendingHumanInput && !isBlockingHumanInput\(pendingHumanInput\) \? pendingHumanInput : null;/);
  assert.match(source, /const blockingHumanInputAdvanceReady = Boolean\(/);
  assert.match(source, /shouldRevealBlockingHumanInputAfterAdvance\(/);
  assert.match(source, /const nonBlockingHumanInputAdvanceReady = Boolean\(/);
  assert.match(source, /shouldRevealNonBlockingHumanInputAfterAdvance\(pendingHumanInputRevealAfterEventId, currentEvent, humanInputAnchorAcknowledged\)/);
  assert.match(source, /const humanInputAdvanceReady = blockingHumanInputAdvanceReady \|\| nonBlockingHumanInputAdvanceReady;/);
  assert.match(source, /const readyHumanInput = blockingHumanInput && humanInputAnchorAcknowledged && queuedEvents\.length === 0 \? blockingHumanInput : null;/);
  assert.match(
    source,
    /const deferredNonBlockingHumanInput =\s*nonBlockingHumanInput &&\s*hasSeenHumanInputRevealAnchor\(pendingHumanInputRevealAfterEventId, events\) &&\s*humanInputAnchorAcknowledged\s*\?\s*nonBlockingHumanInput\s*:\s*null;/s
  );
  assert.match(source, /const visibleHumanInput = readyHumanInput \?\? deferredNonBlockingHumanInput;/);
  assert.match(source, /typeof request\.revealAfterEventId === "number"/);
  assert.match(source, /request\.revealAfterEventId/);
  assert.match(source, /queuedRef\.current\.at\(-1\)\?\.id \?\? eventsRef\.current\.at\(-1\)\?\.id \?\? null/);
  assert.match(source, /enqueueHumanInput\(request, revealAfterEventId\);/);
  assert.match(source, /const humanInputNoticeLeadCount = 2;/);
  assert.match(source, /queuedEvents\.length > 0 && queuedEvents\.length <= humanInputNoticeLeadCount \? blockingHumanInput : null;/);
  assert.doesNotMatch(source, /const visibleBeforeInput = queuedRef\.current;/);
  assert.match(source, /入力前確認/);
  assert.match(source, /function statusForPendingHumanInput\(remainingCount: number\)/);
  assert.match(source, /if \(isBlockingHumanInput\(request\)\) \{/);
  assert.match(source, /setGameStatus\(statusForPendingHumanInputLeadIn\(queuedRef\.current\.length\)\);/);
  assert.match(source, /isBlockingHumanInput\(pendingHumanInput\) \? statusForPendingHumanInputLeadIn\(remaining\.length\) : statusForVisibleStory\(next, remaining\.length\)/);
  assert.match(source, /function renderPendingHumanInputNotice/);
  assert.match(source, /あなたの意思決定が近づいています/);
  assert.match(source, /次へで入力前の会話を確認してください/);
  assert.match(source, /submitHumanInput\(\{ targetId: humanTargetId \}\)/);
  assert.match(source, /submitHumanInput\(\{ targetId: null \}\)/);
  assert.match(source, /const \[humanSpeech, setHumanSpeech\] = useState\(""\);/);
  assert.match(source, /speechMode === "werewolf_alignment"/);
  assert.match(source, /function renderHumanSpeechInputScene\(prompt: HumanSpeechInputRequest \| null\)/);
  assert.doesNotMatch(source, /function renderHumanContext/);
  assert.doesNotMatch(source, /renderHumanContextLines/);
  assert.doesNotMatch(source, /<details className="human-context">/);
  assert.doesNotMatch(source, /<summary>状況<\/summary>/);
  assert.doesNotMatch(
    source,
    /function renderHumanSpeechInputScene\(prompt: HumanSpeechInputRequest \| null\)[\s\S]*?renderHumanContext\(prompt\)[\s\S]*?function renderHumanInputPanel/
  );
  assert.match(source, /const speechInputPrompt = visibleHumanInput\?\.kind === "speech_choice" \? visibleHumanInput : null;/);
  assert.match(source, /const actionHumanInput = visibleHumanInput && visibleHumanInput\.kind !== "speech_choice" \? visibleHumanInput : null;/);
  assert.match(source, /speechInputPrompt \? "human-input-hero" : ""/);
  assert.match(source, /speechInputPrompt \? "human-input-character" : ""/);
  assert.match(source, /<CharacterName playerId=\{speechInputPrompt\.playerId\}>\{speakerName\}<\/CharacterName>/);
  assert.match(source, /renderHumanSpeechInputScene\(speechInputPrompt\)/);
  assert.match(source, /renderHumanInputPanel\(actionHumanInput\)/);
  assert.match(source, /function isOptionalWerewolfAlignmentInput/);
  assert.match(source, /function skipOptionalHumanInputOnStoryAdvance/);
  assert.match(source, /function skipOptionalHumanInputOnStoryAdvance\(\): boolean/);
  assert.match(source, /void submitHumanInput\(\{ speech: "" \}\);/);
  assert.match(source, /humanInputAdvanceReady,/);
  assert.doesNotMatch(source, /resetImmediately/);
  assert.match(source, /if \(skipOptionalHumanInputOnStoryAdvance\(\)\) \{/);
  assert.match(source, /function createLocalHumanSpeechEvent\(request: HumanInputRequest, payload: HumanInputSubmitPayload\): GameEvent \| null/);
  assert.match(source, /request\.kind !== "speech_choice" \|\| !request\.nonBlocking \|\| request\.speechMode !== "werewolf_alignment"/);
  assert.match(source, /type:\s*"player_speech"/);
  assert.match(source, /localHumanEcho:\s*true/);
  assert.match(source, /function showLocalHumanSpeechEvent\(event: GameEvent\)/);
  assert.match(source, /const nextEvents = \[\.\.\.eventsRef\.current, event\];/);
  assert.match(source, /eventsRef\.current = nextEvents;/);
  assert.match(source, /setEvents\(nextEvents\);/);
  assert.match(source, /setGameStatus\(statusForVisibleStory\(event, queuedRef\.current\.length\)\);/);
  assert.match(source, /const localHumanSpeechEvent = createLocalHumanSpeechEvent\(request, payload\);/);
  assert.match(source, /const holdSubmittedScene = shouldHoldSubmittedHumanInputScene\(request\);/);
  assert.match(source, /submittedHumanInputRef\.current = holdSubmittedScene \? request : null;/);
  assert.match(source, /function shouldHoldSubmittedHumanInputScene\(request: HumanInputRequest\): boolean/);
  assert.match(source, /return request\.kind === "speech_choice" && !request\.nonBlocking;/);
  assert.match(source, /function isSubmittedHumanSpeechEvent\(request: HumanInputRequest, event: GameEvent\): boolean/);
  assert.match(source, /event\.type === "player_speech" && event\.playerId === request\.playerId/);
  assert.match(source, /const submittedHumanInputRef = useRef<HumanInputRequest \| null>\(null\);/);
  assert.match(source, /const submittedHumanInput = submittedHumanInputRef\.current;/);
  assert.match(source, /submittedHumanInput && isSubmittedHumanSpeechEvent\(submittedHumanInput, event\)/);
  assert.match(source, /completeHumanInputRequest\(submittedHumanInput\);[\s\S]*eventsRef\.current = nextEvents;[\s\S]*setEvents\(nextEvents\);[\s\S]*setGameStatus\(statusForVisibleStory\(event, queuedRef\.current\.length\)\);[\s\S]*return;/);
  assert.match(source, /function resetHumanInputState\(\) \{\s*submittedHumanInputRef\.current = null;/);
  assert.match(source, /if \(localHumanSpeechEvent\) \{\s*completeHumanInputRequest\(request\);[\s\S]*showLocalHumanSpeechEvent\(localHumanSpeechEvent\);/s);
  assert.match(source, /else if \(holdSubmittedScene\) \{\s*if \(submittedHumanInputRef\.current === request\) \{[\s\S]*showProcessingHudNow\(\);[\s\S]*setGameStatus\("生成中"\);/s);
  assert.match(source, /function renderHumanInputQuickControls\(\)/);
  assert.match(source, /className="human-input-quick-controls"/);
  assert.match(source, /speechInputPrompt \? renderHumanInputQuickControls\(\) : null/);
  assert.match(source, /挨拶を入力しましょう/);
  assert.match(source, /未入力なら既定の意思合わせ発言で進みます/);
  assert.doesNotMatch(source, /const allowFreeText = prompt\.allowFreeText !== false;/);
  assert.doesNotMatch(source, /"この場面では候補から選んでください"/);
  assert.doesNotMatch(source, /"候補から選択"/);
  assert.match(source, /const canSubmitHumanSpeech = isWerewolfAlignment \|\| humanSpeech\.trim\(\)\.length > 0;/);
  assert.match(source, /humanSpeech\.trim\(\)\.length > 0 \? "意思合わせで話す" : "既定文で進む"/);
  assert.match(source, /rows=\{7\}/);
  assert.match(source, /disabled=\{humanSubmitting\}/);
  assert.match(source, /<span>\{speechSubmitLabel\}<\/span>/);
  assert.match(source, /submitHumanInput\(\{ speech: humanSpeech \}\)/);
  assert.match(source, /!\s*speechInputPrompt\s*\?\s*\(\s*<div className="story-controls" ref=\{storyControlsRef\}>/s);
  assert.match(css, /\.conversation-log-list p\s*\{[^}]*font-size:\s*18px;/s);
  assert.match(css, /\.human-choice-text\s*\{[^}]*font-size:\s*18px;/s);
  assert.match(css, /\.human-speech-prompt-title\s*\{[^}]*font-size:\s*24px;/s);
  assert.match(css, /\.story-hero\.human-input-hero \.story-copy\s*\{[^}]*width:\s*min\(70%,\s*860px\)/s);
  assert.match(css, /\.human-input-copy\s*\{[^}]*overflow-y:\s*auto;/s);
  assert.match(css, /\.human-speech-composer textarea\s*\{[^}]*height:\s*clamp\(210px,\s*34vh,\s*260px\);[^}]*font-size:\s*25px;/s);
  assert.match(css, /\.human-speech-composer textarea\s*\{[^}]*background:\s*#2d3338;/s);
  assert.doesNotMatch(css, /\.human-speech-composer textarea\s*\{[^}]*var\(--ship-trim-texture\)/s);
  assert.match(css, /\.human-speech-choice-list\s*\{[^}]*max-height:\s*none;[^}]*overflow:\s*visible;/s);
  assert.doesNotMatch(css, /\.human-context/);
  assert.match(css, /\.human-input-quick-controls\s*\{[^}]*position:\s*absolute;/s);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*\.human-speech-composer textarea\s*\{[^}]*height:\s*clamp\(184px,\s*30vh,\s*220px\);/s);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*\.human-speech-choice-list\s*\{[^}]*max-height:\s*none;/s);
  assert.match(css, /\.human-speech-composer\.werewolf-alignment \.human-choice-hint\s*\{[^}]*font-weight:\s*850;/s);
  assert.doesNotMatch(source, /あなたの判断が近づいています/);
  assert.doesNotMatch(source, /humanReason/);
  assert.doesNotMatch(source, /setHumanReason/);
  assert.doesNotMatch(source, /placeholder="理由"/);
  assert.match(source, /const storyBackDisabled = paused \|\| Boolean\(visibleHumanInput\)/);
  assert.match(source, /const storyNextDisabled =\s*paused \|\|\s*Boolean\(readyHumanInput\)/);
  assert.match(source, /const canRetreat = !paused && !visibleHumanInput/);
  assert.match(source, /const canAdvance =\s*!paused && !readyHumanInput && !isBackKey && \(queuedRef\.current\.length > 0 \|\| canStartOpening \|\| humanInputAdvanceReady\);/s);
  assert.match(source, /acknowledgeActiveHumanInput\(\);/);
  assert.doesNotMatch(source, /入力待ちあり/);
});

test("non-blocking human input waits until its unread story anchor has been seen", () => {
  assert.equal(hasSeenHumanInputRevealAnchor(null, []), true);
  assert.equal(hasSeenHumanInputRevealAnchor(2, [{ id: 1 }]), false);
  assert.equal(hasSeenHumanInputRevealAnchor(2, [{ id: 1 }, { id: 2 }]), true);
  assert.equal(isCurrentHumanInputRevealAnchor(null, undefined), true);
  assert.equal(isCurrentHumanInputRevealAnchor(2, undefined), false);
  assert.equal(isCurrentHumanInputRevealAnchor(2, { id: 2 }), true);
  assert.equal(isCurrentHumanInputRevealAnchor(2, { id: 3 }), false);
  assert.equal(shouldRevealNonBlockingHumanInputAfterAdvance(2, { id: 1 }, false), false);
  assert.equal(shouldRevealNonBlockingHumanInputAfterAdvance(2, { id: 2 }, false), true);
  assert.equal(shouldRevealNonBlockingHumanInputAfterAdvance(2, { id: 2 }, true), false);
});

test("blocking human input requires an extra advance after the story anchor is visible", () => {
  assert.equal(shouldRevealBlockingHumanInputAfterAdvance(2, [{ id: 1 }], false, false), false);
  assert.equal(shouldRevealBlockingHumanInputAfterAdvance(2, [{ id: 1 }, { id: 2 }], true, false), false);
  assert.equal(shouldRevealBlockingHumanInputAfterAdvance(2, [{ id: 1 }, { id: 2 }], false, false), true);
  assert.equal(shouldRevealBlockingHumanInputAfterAdvance(2, [{ id: 1 }, { id: 2 }], false, true), false);
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

test("neutral victory role reveal is public and animated", () => {
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  const event: GameEvent = {
    id: 2,
    createdAt: "2026-05-18T00:00:00.000Z",
    round: 1,
    phase: "voting",
    type: "system",
    message: "シオンは道化師であることが明らかになり、投票処刑で中立勝利条件を満たしました",
    data: {
      action: "neutral_victory_claim",
      sourceId: "p8",
      sourceName: "シオン",
      revealedRole: "Jester",
      revealedRoleLabel: "道化師"
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

  assert.equal(stageLightMoodForEvent(event), "claim");
  assert.deepEqual(mentionedCharactersForEvent(event, false, "village").map((mention) => mention.id), ["p8"]);
  assert.match(source, /function neutralVictoryRoleReveal\(event: GameEvent\): \{ playerId: string; role: Role \} \| undefined/);
  assert.match(source, /const publicRoleReveals = useMemo\(\(\) => \{/);
  assert.match(source, /const publicRole = publicRoleReveals\.get\(player\.id\);/);
  assert.match(source, /\.dead-player\[data-player-id="\$\{id\}"\]/);
  assert.match(source, /className=\{`dead-role-chip \$\{roleClassName\(deadRole\)\} \$\{revealing \? "role-reveal" : ""\}`\}/);
  assert.match(source, /detail-chip role-reveal-info/);
  assert.match(source, /eventAction\(event\) === "neutral_victory_claim"/);
  assert.match(css, /\.story-hero\.neutral-victory \.hero-character\s*\{/);
  assert.match(css, /\.dead-player\.revealing-role\s*\{/);
  assert.match(css, /\.dead-role-chip\.role-reveal\s*\{/);
  assert.match(css, /\.detail-chip\.role-reveal-info\s*\{/);
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
  assert.match(source, /getEl: \(\) => roleDistributionRef\.current,\s*\n\s*title: "人狼陣営の目的"/);
  assert.match(source, /人狼陣営として村人の全排除を目指すゲーム/);
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
  assert.match(css, /\.ui-tour-callout p\s*\{[^}]*font-size:\s*18px;/s);
  assert.match(source, /const calloutWidth = Math\.min\(420, viewportWidth - calloutMargin \* 2\);/);
});

test("returning players skip the tour without a startup generation gate", () => {
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  // "Seen the tour" is persisted across sessions and read with a safe fallback.
  assert.match(source, /const UI_TOUR_SEEN_KEY = "among-ai:ui-tour-seen";/);
  assert.match(source, /function hasSeenUiTour\(\): boolean/);
  assert.match(source, /window\.localStorage\.getItem\(UI_TOUR_SEEN_KEY\) === "1"/);
  assert.match(source, /function markUiTourSeen\(\): void/);
  assert.match(source, /window\.localStorage\.setItem\(UI_TOUR_SEEN_KEY, "1"\)/);

  // First match runs the tour; later matches skip it without adding a wait gate.
  assert.match(source, /if \(hasSeenUiTour\(\)\) \{\s*\n\s*return;\s*\n\s*\}/);
  // "Seen" is persisted only after the tour is shown and then closed (skip or finish),
  // so a mid-tour refresh keeps onboarding instead of permanently skipping it.
  assert.match(source, /tourWasActiveRef\.current = false;\s*\n\s*markUiTourSeen\(\);/);
  assert.doesNotMatch(source, /return;\s*\n\s*\}\s*\n\s*markUiTourSeen\(\);/);

  // The old artificial startup wait is gone.
  assert.doesNotMatch(source, /GENERATION_PAUSE_MS/);
  assert.doesNotMatch(source, /STARTUP_WAIT_MS/);
  assert.doesNotMatch(source, /startupWaitActive/);
  assert.doesNotMatch(source, /startStartupWait/);
  assert.doesNotMatch(source, /function renderStartupWait\(/);
  assert.doesNotMatch(source, /className="startup-wait"/);
  assert.doesNotMatch(source, /生成中です/);
  assert.doesNotMatch(css, /\.startup-wait/);

  // Starting a match no longer immediately opens the thinking HUD. The HUD still exists
  // for real generation waits after the opening scene is on screen or after submitted input.
  const startGameStart = source.indexOf("function startGame");
  const startGameEnd = source.indexOf("const streamView", startGameStart);
  assert.ok(startGameStart >= 0);
  assert.ok(startGameEnd > startGameStart);
  assert.doesNotMatch(source.slice(startGameStart, startGameEnd), /showProcessingHudNow\(\);/);
  assert.match(source, /eventsRef\.current\.length > 0 && queuedRef\.current\.length === 0/);
  assert.match(source, /const storyWaitingForStream =\s*!setupMode && !paused && running/s);
  assert.match(source, /const storyProcessingActive = storyWaitingForStream \|\| waitingForSubmittedHumanInput \|\| processingHudVisible;/);
  assert.match(source, /if \(!processingHudVisible\) \{\s*\n\s*return null;/);
  assert.match(source, /const title = "AIプレイヤーが考えています";/);

  // Real generation waits still keep the HUD visible briefly, but the minimum is 2s.
  assert.match(source, /const PROCESSING_HUD_MIN_VISIBLE_MS = 2000;/);
  assert.match(source, /const processingHudShownAtRef = useRef<number \| null>\(null\);/);
  assert.match(source, /const processingHudHideTimerRef = useRef<number \| null>\(null\);/);
  assert.match(source, /const remaining = PROCESSING_HUD_MIN_VISIBLE_MS - \(Date\.now\(\) - shownAt\);/);
});
