import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  App,
  clusterReads,
  dedupeReadsBySourceTarget,
  eventMessageForSpectator,
  eventSpeakerForSpectator,
  heroCastForStage,
  storyRunControlState,
  streamErrorMessageFromData,
  winnerLabelForRoster
} from "../src/client/App";
import type { GameEvent, PlayerSnapshot } from "../src/game/types";

test("app shell renders spectator controls and info overlay buttons", () => {
  const html = renderToStaticMarkup(createElement(App));

  assert.match(html, /among ai/);
  assert.match(html, /自分も参加してプレイ/);
  assert.match(html, /全情報/);
  assert.match(html, /人間視点/);
  assert.match(html, /info-bar-btn/);
  assert.match(html, /story-run-controls/);
  assert.match(html, /戻る/);
  assert.match(html, /次へ/);
  assert.match(html, /一時停止/);
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
});

test("winner label appears only when a winner exists", () => {
  assert.equal(winnerLabelForRoster(null, "Japanese"), null);
  assert.equal(winnerLabelForRoster("village", "Japanese"), "勝者: 人間側");
  assert.equal(winnerLabelForRoster("werewolf", "Japanese"), "勝者: 狼陣営");
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
  assert.equal(cast.at(-1)?.image, null);
  assert.equal(cast.at(-1)?.alive, true);
  assert.equal(cast[8].alive, false);
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

test("story run controls switch between pause, resume, and reset", () => {
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
});

test("mobile layout CSS keeps spectator panels in a single column", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  assert.match(css, /@media \(max-width: 980px\)/);
  assert.match(css, /\.workspace\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /\.status-strip\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.story-column\s*\{[^}]*order:\s*1/s);
  assert.match(css, /\.controls-panel\s*\{[^}]*order:\s*3/s);
  assert.match(css, /\.vote-node\s*\{[^}]*min-width:\s*0/s);
});

test("story controls stay stable as history grows", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  assert.match(css, /\.workspace\s*\{[^}]*height:\s*clamp\(560px,\s*calc\(100vh - 122px\),\s*760px\)/s);
  assert.match(css, /\.story-panel\s*\{[^}]*min-height:\s*0/s);
  assert.match(css, /\.novel-stage\s*\{[^}]*height:\s*100%/s);
  assert.match(css, /\.story-copy\s*\{[^}]*max-height:\s*calc\(100% - 98px\)/s);
  assert.match(css, /\.story-copy\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.setup-grid\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.story-controls\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /\.story-controls\s*\{[^}]*bottom:\s*14px/s);
  assert.match(css, /\.story-back,\s*\.story-next\s*\{[^}]*min-width:\s*128px/s);
  assert.match(css, /\.story-button-label\s*\{[^}]*justify-content:\s*center/s);
  assert.match(css, /\.story-run-controls\s*\{[^}]*display:\s*inline-flex/s);
  assert.match(css, /\.status-strip\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
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

  assert.match(source, /function retreatStory/);
  assert.doesNotMatch(source, /function revealAll/);
  assert.doesNotMatch(source, /story-read-all/);
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
