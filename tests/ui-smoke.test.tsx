import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../src/client/App";

test("app shell renders spectator controls and insight panels", () => {
  const html = renderToStaticMarkup(createElement(App));

  assert.match(html, /Among AI/);
  assert.match(html, /必ず起こしたいイベント/);
  assert.match(html, /言語/);
  assert.match(html, /全情報/);
  assert.match(html, /村視点/);
  assert.match(html, /主張と読み/);
  assert.match(html, /投票マップ/);
  assert.match(html, /ラウンド要約/);
  assert.doesNotMatch(html, /進行方式/);
  assert.doesNotMatch(html, /モデル名/);
  assert.doesNotMatch(html, /要約方法/);
});

test("mobile layout CSS keeps spectator panels in a single column", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  assert.match(css, /@media \(max-width: 1020px\)/);
  assert.match(css, /\.workspace\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /\.status-strip\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.event-body\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.vote-target\s*\{[^}]*min-width:\s*0/s);
});

test("story controls stay stable as history grows", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

  assert.match(css, /\.story-panel\s*\{[^}]*height:\s*clamp\(720px,\s*calc\(100vh - 120px\),\s*920px\)/s);
  assert.match(css, /\.novel-stage\s*\{[^}]*flex:\s*1 1 0/s);
  assert.match(css, /\.scene-card\s*\{[^}]*max-height:\s*50%/s);
  assert.match(css, /\.scene-card\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.history-strip\s*\{[^}]*height:\s*150px/s);
  assert.match(css, /\.history-strip\s*\{[^}]*flex:\s*0 0 150px/s);
});

test("story can advance from keyboard shortcuts outside form controls", () => {
  const source = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");

  assert.match(source, /event\.key !== "Enter"/);
  assert.match(source, /event\.key !== "ArrowRight"/);
  assert.match(source, /isEditableShortcutTarget/);
});
