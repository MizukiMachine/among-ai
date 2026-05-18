import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  App,
  eventMessageForSpectator,
  eventSpeakerForSpectator,
  heroCastForStage,
  storyRevealAllStatus,
  storyRunControlState
} from "../src/client/App";
import type { GameEvent, PlayerSnapshot } from "../src/game/types";

test("app shell renders spectator controls and insight panels", () => {
  const html = renderToStaticMarkup(createElement(App));

  assert.match(html, /Among AI/);
  assert.match(html, /必ず起こしたいイベント/);
  assert.match(html, /全情報/);
  assert.match(html, /人間視点/);
  assert.match(html, /主張と読み/);
  assert.match(html, /投票マップ/);
  assert.match(html, /ラウンド要約/);
  assert.match(html, /story-run-controls/);
  assert.match(html, /一時停止/);
  assert.doesNotMatch(html, /topbar-actions/);
  assert.doesNotMatch(html, /ゲームをリセット/);
  assert.doesNotMatch(html, />停止</);
  assert.doesNotMatch(html, /言語/);
  assert.doesNotMatch(html, /進行方法/);
  assert.doesNotMatch(html, /表示速度/);
  assert.doesNotMatch(html, /自動送り/);
  assert.doesNotMatch(html, /進行方式/);
  assert.doesNotMatch(html, /モデル名/);
  assert.doesNotMatch(html, /要約方法/);
});

test("hero cast mirrors selected and active player counts", () => {
  assert.equal(heroCastForStage([], 9).length, 9);

  const players: PlayerSnapshot[] = Array.from({ length: 9 }, (_, index) => ({
    id: `p${index + 1}`,
    name: `Player ${index + 1}`,
    role: "Villager",
    camp: "village",
    persona: "cautious",
    alive: index !== 8,
    model: "demo",
    memoryCount: 0
  }));
  const cast = heroCastForStage(players, 9);

  assert.equal(cast.length, 9);
  assert.equal(cast.at(-1)?.id, "p9");
  assert.equal(cast.at(-1)?.alive, false);
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
  assert.match(css, /\.workspace,\s*\.insight-grid\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /\.status-strip\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.story-column\s*\{[^}]*order:\s*1/s);
  assert.match(css, /\.controls-panel\s*\{[^}]*order:\s*3/s);
  assert.match(css, /\.vote-node\s*\{[^}]*min-width:\s*0/s);
});

test("story controls stay stable as history grows", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  assert.match(css, /\.story-panel\s*\{[^}]*height:\s*clamp\(620px,\s*calc\(100vh - 104px\),\s*760px\)/s);
  assert.match(css, /\.novel-stage\s*\{[^}]*height:\s*100%/s);
  assert.match(css, /\.story-copy\s*\{[^}]*max-height:\s*calc\(100% - 98px\)/s);
  assert.match(css, /\.story-copy\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.story-controls\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /\.story-controls\s*\{[^}]*bottom:\s*14px/s);
  assert.match(css, /\.story-run-controls\s*\{[^}]*display:\s*inline-flex/s);
  assert.match(css, /\.status-strip\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
});

test("story can advance from keyboard shortcuts outside form controls", () => {
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");

  assert.match(source, /event\.key !== "Enter"/);
  assert.match(source, /event\.key !== "ArrowRight"/);
  assert.match(source, /isEditableShortcutTarget/);
});

test("reveal all keeps generating status while stream is still open", () => {
  assert.equal(storyRevealAllStatus("player_speech", true, false), "生成中");
  assert.equal(storyRevealAllStatus("player_speech", false, true), "表示完了");
  assert.equal(storyRevealAllStatus("game_ended", true, false), "完了");
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
    playerName: "カズ",
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

  assert.equal(eventMessageForSpectator(event, "village"), "人間視点では非公開情報です。");
  assert.equal(eventSpeakerForSpectator(event, "village", "Japanese"), "進行");
  assert.equal(eventMessageForSpectator(event, "omniscient"), "人狼だけに見える相談内容");
  assert.equal(eventSpeakerForSpectator(event, "omniscient", "Japanese"), "カズ");
});
