import assert from "node:assert/strict";
import test from "node:test";
import { createApp, parseStreamOptions } from "../src/server/app";
import { HumanInputSession } from "../src/server/humanSessions";
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
  assert.equal(options.provider, "llm");
  assert.equal(options.speed, 0);
  assert.equal(options.view, "village");
  assert.equal(options.summaryMode, "llm");
  assert.equal(options.debugScenario, "hunter_shot");
  assert.equal(options.language, "Japanese");
});

test("stream options default to LLM provider and LLM summaries", () => {
  const options = parseStreamOptions(new URL("http://localhost/api/games/stream?players=7"));

  assert.equal(options.provider, "llm");
  assert.equal(options.summaryMode, "llm");
  assert.notEqual(options.model, "demo");
});

test("stream options accept expanded player counts up to 20", () => {
  assert.equal(parseStreamOptions(new URL("http://localhost/api/games/stream?players=20")).playerCount, 20);
  assert.equal(parseStreamOptions(new URL("http://localhost/api/games/stream?players=21")).playerCount, 20);
});

test("stream options accept bounded generation concurrency", () => {
  assert.equal(parseStreamOptions(new URL("http://localhost/api/games/stream?players=20&concurrency=8")).prefetchConcurrency, 8);
  assert.equal(parseStreamOptions(new URL("http://localhost/api/games/stream?players=20&prefetchConcurrency=50")).prefetchConcurrency, 20);
  assert.equal(parseStreamOptions(new URL("http://localhost/api/games/stream?players=20&concurrency=bad")).prefetchConcurrency, undefined);
});

test("stream options accept a human player and player view", () => {
  const options = parseStreamOptions(
    new URL("http://localhost/api/games/stream?players=7&human=p3&view=player&scenario=hunter_shot")
  );

  assert.equal(options.humanPlayerId, "p3");
  assert.equal(options.view, "player");
  assert.equal(options.debugScenario, "none");
});

test("stream emits progress frames for batched AI generation", async () => {
  const app = createApp();
  const response = await app.request(
    "/api/games/stream?players=8&provider=demo&summary=deterministic&speed=0&concurrency=2&scenario=guard_success&maxRounds=3"
  );
  const frames = parseSse(await response.text());
  const progressFrames = frames.filter((frame) => frame.event === "progress");

  assert.ok(progressFrames.some((frame) => (frame.data as { task?: string }).task === "day_speech"));
  assert.ok(progressFrames.every((frame) => ((frame.data as { concurrency?: number }).concurrency ?? 0) <= 2));
});

test("village stream redacts secret werewolf progress frames", async () => {
  const app = createApp();
  const response = await app.request(
    "/api/games/stream?players=8&provider=demo&summary=deterministic&speed=0&view=village&scenario=guard_success&maxRounds=3"
  );
  const frames = parseSse(await response.text());
  const progressFrames = frames.filter((frame) => frame.event === "progress");
  const progressPayloads = progressFrames.map((frame) => frame.data as { task?: string; label?: string; phase?: string; redacted?: boolean });

  assert.ok(progressPayloads.some((progress) => progress.redacted === true && progress.task === "hidden"));
  assert.ok(progressPayloads.every((progress) => !String(progress.task).startsWith("werewolf")));
  assert.ok(progressPayloads.every((progress) => !String(progress.label).includes("人狼")));
  assert.ok(progressPayloads.every((progress) => progress.phase !== "werewolf_discussion"));
});

test("human input session rejects responses that do not match the pending request", async () => {
  let requestId = "";
  const session = new HumanInputSession((request) => {
    requestId = request.id;
  });
  const requestPromise = session.request({
    kind: "target",
    playerId: "p1",
    playerName: "シオン",
    phase: "voting",
    role: "Villager",
    action: "投票",
    context: { notes: [], publicHistory: [], privateHistory: [] },
    candidates: [{ id: "p2", name: "ガク" }],
    allowSkip: false
  });

  assert.ok(requestId);
  assert.deepEqual(session.submit(requestId, { speech: "wrong shape" }), { ok: false, error: "invalid_input" });
  assert.deepEqual(session.submit(requestId, { targetId: "p3" }), { ok: false, error: "invalid_input" });
  assert.deepEqual(session.submit(requestId, { targetId: "p2", reason: "  盤面から判断  " }), { ok: true });
  assert.deepEqual(await requestPromise, { targetId: "p2", reason: "盤面から判断" });
  session.close();
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
