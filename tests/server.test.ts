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

test("stream options ignore legacy director query params", () => {
  for (const mode of ["describe", "intermediate", "bogus"]) {
    const options = parseStreamOptions(new URL(`http://localhost/api/games/stream?players=7&director=${mode}`));
    assert.equal(options.playerCount, 7);
    assert.equal(Object.hasOwn(options, "directorMode"), false);
  }
});

test("stream options default to LLM provider and LLM summaries", () => {
  const options = parseStreamOptions(new URL("http://localhost/api/games/stream?players=7"));

  assert.equal(options.provider, "llm");
  assert.equal(options.summaryMode, "llm");
  assert.notEqual(options.model, "demo");
});

test("stream options accept player counts up to 15", () => {
  assert.equal(parseStreamOptions(new URL("http://localhost/api/games/stream?players=15")).playerCount, 15);
  assert.equal(parseStreamOptions(new URL("http://localhost/api/games/stream?players=16")).playerCount, 15);
});

test("stream options lock generation concurrency to five", () => {
  assert.equal(parseStreamOptions(new URL("http://localhost/api/games/stream?players=15")).prefetchConcurrency, 5);
  assert.equal(parseStreamOptions(new URL("http://localhost/api/games/stream?players=15&concurrency=8")).prefetchConcurrency, 5);
  assert.equal(parseStreamOptions(new URL("http://localhost/api/games/stream?players=15&prefetchConcurrency=50")).prefetchConcurrency, 5);
});

test("stream options accept a human player and player view", () => {
  const options = parseStreamOptions(
    new URL("http://localhost/api/games/stream?players=7&human=p3&view=player&humanCamp=werewolf&scenario=hunter_shot")
  );

  assert.equal(options.humanPlayerId, "p3");
  assert.equal(options.humanCampPreference, "werewolf");
  assert.equal(options.view, "player");
  assert.equal(options.debugScenario, "none");
});

test("stream options default human camp preference to random", () => {
  assert.equal(
    parseStreamOptions(new URL("http://localhost/api/games/stream?players=7&human=p3&humanCamp=bogus")).humanCampPreference,
    "random"
  );
  assert.equal(parseStreamOptions(new URL("http://localhost/api/games/stream?players=7&humanCamp=werewolf")).humanCampPreference, "random");
});

test("stream emits progress frames for batched AI generation", async () => {
  const app = createApp();
  const response = await app.request(
    "/api/games/stream?players=8&provider=demo&summary=deterministic&speed=0&concurrency=2&scenario=guard_success&maxRounds=3"
  );
  const frames = parseSse(await response.text());
  const progressFrames = frames.filter((frame) => frame.event === "progress");

  assert.ok(progressFrames.some((frame) => (frame.data as { task?: string }).task === "day_speech"));
  assert.ok(progressFrames.every((frame) => ((frame.data as { concurrency?: number }).concurrency ?? 0) <= 5));
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
  assert.deepEqual(session.submit(requestId, { targetId: "p2" }), { ok: true });
  assert.deepEqual(await requestPromise, { targetId: "p2", reason: undefined });
  session.close();
});

test("human speech choice input accepts either a drafted choice or free text", async () => {
  let requestId = "";
  const session = new HumanInputSession((request) => {
    requestId = request.id;
  });
  const request = {
    kind: "speech_choice" as const,
    playerId: "p1",
    playerName: "シオン",
    phase: "day_discussion" as const,
    role: "Villager" as const,
    task: "発言してください",
    context: { notes: [], publicHistory: [], privateHistory: [] },
    options: [{ id: "0", text: "候補発言" }]
  };

  const freeTextPromise = session.request(request);
  assert.ok(requestId);
  assert.deepEqual(session.submit(requestId, { speech: "  自分の言葉で話します  " }), { ok: true });
  assert.deepEqual(await freeTextPromise, { speech: "自分の言葉で話します" });

  const choicePromise = session.request(request);
  assert.ok(requestId);
  assert.deepEqual(session.submit(requestId, { choiceId: "0" }), { ok: true });
  assert.deepEqual(await choicePromise, { choiceId: "0" });
  session.close();
});

test("optional werewolf greeting input accepts an empty skip", async () => {
  let requestId = "";
  const session = new HumanInputSession((request) => {
    requestId = request.id;
  });
  const greetingPromise = session.request({
    kind: "speech_choice",
    speechMode: "werewolf_greeting",
    nonBlocking: true,
    playerId: "p1",
    playerName: "シオン",
    phase: "werewolf_discussion",
    role: "Werewolf",
    task: "挨拶してください",
    context: { notes: [], publicHistory: [], privateHistory: [] },
    options: []
  });

  assert.ok(requestId);
  assert.deepEqual(session.submit(requestId, { speech: "" }), { ok: true });
  assert.deepEqual(await greetingPromise, {});
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
  const voteCasts = gameEvents.filter((event) => event.type === "vote_cast");
  assert.ok(voteCasts.length > 0);
  assert.ok(voteCasts.every((event) => event.playerId && event.targetId && event.data?.reason === undefined));
  for (const voteResult of gameEvents.filter((event) => event.type === "vote_result" || event.type === "round_summary")) {
    const votes = voteResult.data?.votes;
    if (Array.isArray(votes)) {
      assert.ok(votes.every((vote) => typeof vote === "object" && vote !== null && !("reason" in vote)));
    }
    assert.equal(voteResult.data?.modifiers, undefined);
  }
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

test("village stream hides public death causes", async () => {
  const app = createApp();
  const response = await app.request(
    "/api/games/stream?players=9&speed=0&view=village&scenario=hunter_shot&maxRounds=3"
  );
  const frames = parseSse(await response.text());
  const gameEvents = frames.filter((frame) => frame.event === "game").map((frame) => frame.data as GameEvent);
  const deathEvents = gameEvents.filter((event) => event.type === "death" && event.data?.cause !== "no_death");

  assert.ok(deathEvents.length > 0);
  assert.ok(deathEvents.every((event) => event.data?.cause === undefined));
  assert.ok(deathEvents.every((event) => event.data?.sourceId === undefined));
  assert.ok(deathEvents.every((event) => !/Hunter|shot|ハンター|撃/.test(event.message)));
});
