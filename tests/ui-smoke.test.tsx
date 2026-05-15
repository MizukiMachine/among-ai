import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../src/client/App";

test("app shell renders spectator controls and insight panels", () => {
  const html = renderToStaticMarkup(createElement(App));

  assert.match(html, /Among AI/);
  assert.match(html, /Summary/);
  assert.match(html, /Demo scenario/);
  assert.match(html, /Language/);
  assert.match(html, /All info/);
  assert.match(html, /Village/);
  assert.match(html, /Claims &amp; Reads/);
  assert.match(html, /Vote Map/);
  assert.match(html, /Round Summaries/);
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
