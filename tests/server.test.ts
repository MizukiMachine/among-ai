import assert from "node:assert/strict";
import test from "node:test";
import { createApp, parseStreamOptions } from "../src/server/app";
import type { GameEvent } from "../src/game/types";

interface SseFrame {
  event: string;
  data: unknown;
}

function parseSse(text: string): SseFrame[] {
  return text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const lines = chunk.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "message";
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "{}";
      return { event, data: JSON.parse(data) as unknown };
    });
}

test("stream options parse server-side spectator view and zero-speed smoke runs", () => {
  const options = parseStreamOptions(
    new URL("http://localhost/api/games/stream?players=9&speed=0&view=village&summary=llm&scenario=hunter_shot")
  );

  assert.equal(options.playerCount, 9);
  assert.equal(options.speed, 0);
  assert.equal(options.view, "village");
  assert.equal(options.summaryMode, "llm");
  assert.equal(options.debugScenario, "hunter_shot");
});

test("village stream payload is redacted on the server before SSE delivery", async () => {
  const app = createApp();
  const response = await app.request(
    "/api/games/stream?players=8&speed=0&view=village&scenario=guard_success&maxRounds=3"
  );
  const frames = parseSse(await response.text());
  const gameEvents = frames.filter((frame) => frame.event === "game").map((frame) => frame.data as GameEvent);

  assert.ok(gameEvents.length > 0);
  assert.ok(gameEvents.some((event) => event.data?.redacted === true));
  for (const event of gameEvents) {
    assert.equal(event.role, undefined);
    assert.equal(event.data?.targetRole, undefined);
    assert.equal(event.data?.visibleTo, undefined);
    assert.equal(event.data?.result, undefined);
    assert.ok(event.snapshot.players.every((player) => String(player.role) === "Hidden"));
    assert.ok(event.snapshot.players.every((player) => String(player.camp) === "hidden"));
  }
});

test("omniscient stream still exposes debug scenario role events", async () => {
  const app = createApp();
  const response = await app.request(
    "/api/games/stream?players=9&speed=0&view=omniscient&scenario=hunter_shot&maxRounds=3"
  );
  const frames = parseSse(await response.text());
  const gameEvents = frames.filter((frame) => frame.event === "game").map((frame) => frame.data as GameEvent);

  assert.ok(gameEvents.some((event) => event.type === "death" && event.data?.cause === "hunter"));
  assert.ok(gameEvents.some((event) => event.role === "Hunter" || event.data?.targetRole === "Hunter"));
});
