import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../src/client/App";
import {
  getAdoptedBgmAssets,
  getDefaultBgmId,
  normalizeAudioManifest,
  resolveAssetUrl,
  sfxIdForGameEvent,
  type AudioAssetManifest,
  type AudioSfxId
} from "../src/client/audioAssets";
import type { GameEvent, GameEventType } from "../src/game/types";

const rootDir = path.resolve(new URL("..", import.meta.url).pathname);
const manifestPath = path.join(rootDir, "public", "assets", "assets.json");

function readManifest(): AudioAssetManifest {
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  const manifest = normalizeAudioManifest(raw);
  assert.ok(manifest);
  return manifest;
}

function event(type: GameEventType, data: Record<string, unknown> = {}): GameEvent {
  return {
    id: 1,
    createdAt: "2026-05-28T00:00:00.000Z",
    round: 1,
    phase: type === "vote_cast" || type === "vote_result" ? "voting" : "day_discussion",
    type,
    message: "test",
    data,
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
}

test("audio manifest exposes four 90 second bgm candidates and existing sfx files", () => {
  const manifest = readManifest();
  const sfxIds = new Set<AudioSfxId>(manifest.sfx.map((asset) => asset.id));

  assert.equal(manifest.bgm.length, 4);
  assert.deepEqual(manifest.bgmRotation?.ids, ["orbital_mindgame", "synthetic_night_watch"]);
  assert.equal(manifest.bgmRotation?.startId, "orbital_mindgame");
  assert.equal(getDefaultBgmId(manifest), "orbital_mindgame");
  assert.deepEqual(getAdoptedBgmAssets(manifest).map((asset) => asset.id), ["orbital_mindgame", "synthetic_night_watch"]);
  for (const bgm of manifest.bgm) {
    assert.equal(bgm.durationMs, 90000);
    assert.equal(bgm.loop, true);
    assert.ok(existsSync(path.join(rootDir, "public", bgm.src)));
  }

  for (const expected of [
    "ui_confirm",
    "setup_confirm",
    "ui_back",
    "game_start",
    "phase_shift",
    "speech",
    "private_info",
    "night_action",
    "guard_success",
    "hunter_shot",
    "death_reveal",
    "vote_cast",
    "vote_result",
    "round_summary",
    "game_end",
    "warning"
  ] as AudioSfxId[]) {
    assert.ok(sfxIds.has(expected), `${expected} should exist`);
  }

  for (const sfx of manifest.sfx) {
    assert.ok(existsSync(path.join(rootDir, "public", sfx.src)));
  }

  const gameStartSfx = manifest.sfx.find((asset) => asset.id === "game_start");
  assert.ok(gameStartSfx);
  assert.ok((gameStartSfx.volume ?? 0.5) <= 0.2, "game_start should stay quiet for the Game Start button");
  const setupConfirmSfx = manifest.sfx.find((asset) => asset.id === "setup_confirm");
  assert.ok(setupConfirmSfx);
  assert.equal(setupConfirmSfx.src, "assets/sfx/ui-confirm.mp3");
  assert.ok((setupConfirmSfx.volume ?? 0.5) <= 0.2, "setup_confirm should stay quiet for setup buttons");

  for (const sfxId of Object.values(manifest.eventSfx)) {
    assert.ok(sfxIds.has(sfxId));
  }
});

test("game events map to the intended sound effect ids", () => {
  assert.equal(sfxIdForGameEvent(event("game_started")), "game_start");
  assert.equal(sfxIdForGameEvent(event("phase_changed")), "speech");
  assert.equal(sfxIdForGameEvent(event("warning")), "speech");
  assert.equal(sfxIdForGameEvent(event("night_action")), "speech");
  assert.equal(sfxIdForGameEvent(event("vote_cast")), "vote_cast");
  assert.equal(sfxIdForGameEvent(event("vote_result")), "vote_result");
  assert.equal(sfxIdForGameEvent(event("round_summary")), "speech");
  assert.equal(sfxIdForGameEvent(event("system")), "speech");
  assert.equal(sfxIdForGameEvent(event("system", { action: "neutral_victory_claim" })), "death_reveal");
  assert.equal(sfxIdForGameEvent(event("private_info", { action: "guard_success" })), "guard_success");
  assert.equal(sfxIdForGameEvent(event("death", { cause: "no_death" })), "guard_success");
  assert.equal(sfxIdForGameEvent(event("death", { cause: "hunter" })), "speech");
  assert.equal(sfxIdForGameEvent(event("death", { cause: "vote" })), "death_reveal");
});

test("asset url resolution respects the vite base path", () => {
  assert.equal(resolveAssetUrl("/", "assets/bgm/test.mp3"), "/assets/bgm/test.mp3");
  assert.equal(resolveAssetUrl("/among-ai/", "/assets/sfx/test.mp3"), "/among-ai/assets/sfx/test.mp3");
  assert.equal(resolveAssetUrl("/", "https://example.com/sound.mp3"), "https://example.com/sound.mp3");
});

test("audio debug panel is removed and only mute control remains visible", () => {
  const html = renderToStaticMarkup(createElement(App));
  const source = readFileSync(path.join(rootDir, "src", "client", "App.tsx"), "utf8");
  const css = readFileSync(path.join(rootDir, "src", "client", "styles.css"), "utf8");

  assert.doesNotMatch(html, /音声デバッグ/);
  assert.match(html, /BGMオン/);
  assert.doesNotMatch(html, /Orbital Mindgame/);
  assert.doesNotMatch(html, /Synthetic Night Watch/);
  assert.doesNotMatch(html, /Neon Suspicion/);
  assert.doesNotMatch(html, /Silent Vote Protocol/);
  assert.doesNotMatch(source, /renderAudioDebugPanel/);
  assert.doesNotMatch(source, /function selectBgm/);
  assert.match(source, /className="audio-mute-button prominent"/);
  assert.match(css, /\.setup-card-footer\s*\{[^}]*justify-content:\s*flex-end/s);
  assert.match(css, /\.audio-mute-button\.prominent\s*\{[^}]*min-width:\s*136px/s);

  const footerStart = html.indexOf('class="setup-card-footer"');
  const footerEnd = html.indexOf('</div>', footerStart);
  const setupFooterHtml = html.slice(footerStart, footerEnd);
  assert.ok(footerStart >= 0);
  assert.doesNotMatch(setupFooterHtml, /audio-mute-button/);
  assert.doesNotMatch(setupFooterHtml, /BGMオン/);
});

test("setup controls share the ui confirmation sound and bgm starts from Orbital Mindgame", () => {
  const source = readFileSync(path.join(rootDir, "src", "client", "App.tsx"), "utf8");

  assert.match(source, /function playSetupConfirmSfx\(\) \{\s*playSfx\("setup_confirm"\);/s);
  assert.match(source, /function updatePlayerCount\(nextCount: number\) \{\s*playSetupConfirmSfx\(\);/s);
  assert.match(source, /function updateHumanEnabled\([^)]*\) \{\s*if \(options\.playSound !== false\) \{\s*playSetupConfirmSfx\(\);/s);
  assert.match(source, /function selectHumanPlayer\(playerId: string\) \{\s*playSetupConfirmSfx\(\);/s);
  assert.match(source, /function confirmSettings\(\) \{[\s\S]*playSetupConfirmSfx\(\);/);
  assert.match(source, /function playBgmRotationFromStart\(\)/);
  assert.match(source, /const startId = getDefaultBgmId\(audioManifest\);/);
  assert.match(source, /controller\.playBgmPlaylist\(bgmRotationIds, selectedBgmId\)/);
  assert.doesNotMatch(source, /nextBgmStartIndexRef/);
  // BGM rotation must not persist across reloads (the only localStorage use is the
  // one-time UI-tour flag, which is unrelated to audio).
  assert.doesNotMatch(source, /localStorage\.[gs]etItem\([^)]*bgm/i);
});
