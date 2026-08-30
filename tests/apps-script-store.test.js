import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createAppsScriptHarness } from "./helpers/apps-script-harness.js";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const startTime = Date.UTC(2026, 7, 28, 12);
const harness = (options = {}) => createAppsScriptHarness({ now: startTime, ...options });
const snapshot = (values = {}) => ({ tick: 0, score: 0, dead: false, fish: { y: 300, vy: 0 }, pipes: [], ...values });

function beginPayload({ ownerId = "owner-a", name = "Alice", gameId = "game-a", ...rest } = {}) {
  const state = snapshot();
  return {
    ownerId, name, rankKey: name.trim().replace(/\s+/g, " ").slice(0, 24).toLowerCase(),
    gameId, seed: 42, rulesVersion: "test-physics-v1", snapshot: state, stateHash: hash(state),
    requestHash: hash({ ownerId, name }), ...rest,
  };
}
function started(h, options = {}) {
  const payload = beginPayload(options);
  const result = h.invoke("begin", payload, { requestId: "begin-" + payload.gameId });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}
function checkpointPayload(game, { ticks = 1200, score = game.snapshot.score, dead = false, pause = false, ...rest } = {}) {
  const next = { ...game.snapshot, tick: game.snapshot.tick + ticks, score, dead };
  const payload = {
    ownerId: game.ownerId, gameId: game.gameId, prevSeq: game.seq,
    prevStateHash: game.stateHash, leaseEpoch: game.leaseEpoch,
    snapshot: next, stateHash: hash(next), inputTicks: ticks, pause, ...rest,
  };
  payload.requestHash = hash(payload);
  return payload;
}
function resumedPayload(game) {
  const payload = {
    ownerId: game.ownerId, gameId: game.gameId, prevSeq: game.seq,
    prevStateHash: game.stateHash, leaseEpoch: game.leaseEpoch,
  };
  return { ...payload, requestHash: hash(payload) };
}
function changed(h, action, payload, requestId) {
  const result = h.invoke(action, payload, { requestId });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}
function expectError(result, code, status) {
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
  if (status !== undefined) assert.equal(result.error.status, status);
}

test("GET and unauthenticated POST never access the spreadsheet", () => {
  const h = harness({ initialized: false });
  expectError(h.get({ action: "save", name: "Mallory", score: "999999", callback: "attack" }), "forbidden", 405);
  expectError(h.post({ name: "Mallory", score: 999999 }), "forbidden", 403);
  expectError(h.post("not JSON"), "invalid_input", 400);
  expectError(h.invoke("begin", beginPayload(), { signature: "0".repeat(64) }), "forbidden", 403);
  assert.equal(h.calls.opens, 0);
  assert.equal(h.calls.reads, 0);
  assert.equal(h.calls.writes, 0);
  assert.equal(h.calls.flushes, 0);
});

test("signature binds action, request id, timestamp and exact content", () => {
  const h = harness();
  for (const changedField of ["action", "requestId", "timestamp", "content"]) {
    const envelope = h.envelope("begin", beginPayload(), { requestId: "signed-id" });
    envelope[changedField] = changedField === "timestamp" ? envelope.timestamp + 1 : envelope[changedField] + " ";
    expectError(h.post(envelope), "forbidden", 403);
  }
  assert.equal(h.calls.opens, 0);
  const valid = h.envelope("begin", beginPayload(), { content: JSON.stringify(beginPayload(), null, 2) });
  assert.equal(h.post(valid).ok, true, "whitespace is allowed when it was part of the signed content");
});

test("expired/future signatures, missing secrets and unknown actions fail closed", () => {
  const h = harness();
  expectError(h.invoke("scores", {}, { timestamp: h.now() - 60001 }), "forbidden");
  expectError(h.invoke("scores", {}, { timestamp: h.now() + 60001 }), "forbidden");
  expectError(h.invoke("constructor", {}), "invalid_input");
  expectError(h.invoke("migrateLegacyScores", {}), "forbidden");
  assert.equal(h.calls.opens, 0);
  const unconfigured = harness({ initialized: false, properties: { GATEWAY_HMAC_KEY: "" } });
  expectError(unconfigured.invoke("scores", {}), "storage_unavailable");
  assert.equal(unconfigured.calls.opens, 0);
});

test("read operations do not create missing sheets or mutate initialized sheets", () => {
  const empty = harness({ initialized: false });
  expectError(empty.invoke("scores", {}), "storage_unavailable");
  assert.equal(empty.calls.writes, 0);
  const h = harness();
  const game = started(h);
  h.resetCalls();
  assert.equal(h.invoke("read", { ownerId: game.ownerId, gameId: game.gameId }).data.gameId, game.gameId);
  assert.deepEqual(h.invoke("scores", {}).data.scores, []);
  assert.equal(h.calls.writes, 0);
  assert.equal(h.calls.flushes, 0);
  assert.equal(h.calls.locks, 0);
});

test("verified row hints reduce read/checkpoint cells and a miss falls back to full validation", () => {
  const h = harness();
  const games = [];
  for (let index = 0; index < 8; index += 1) {
    const game = started(h, { ownerId: "owner-" + index, gameId: "game-" + index });
    games.push(index === 7 ? game :
      changed(h, "checkpoint", checkpointPayload(game, { ticks: 0, pause: true }), "pause-" + index));
  }
  const target = games[3];
  const active = games[7];

  h.resetCalls();
  assert.equal(h.invoke("read", { ownerId: target.ownerId, gameId: target.gameId }).data.gameId, target.gameId);
  const hintedCells = h.calls.readCells;
  assert.equal(hintedCells, 2, "the fast path reads only the header and the target JSON cell");

  h.advanceTime(10000);
  h.resetCalls();
  assert.equal(changed(h, "checkpoint", checkpointPayload(active), "fast-checkpoint").seq, 1);
  assert.equal(h.calls.readCells, 2, "checkpoint also reads only its verified target row");
  assert.equal(h.calls.flushes, 1);

  h.clearCache();
  h.resetCalls();
  assert.equal(h.invoke("read", { ownerId: target.ownerId, gameId: target.gameId }).data.gameId, target.gameId);
  assert.equal(h.calls.readCells, games.length + 1, "a cache miss validates every authoritative game row");
  assert.ok(h.calls.readCells > hintedCells);
  assert.equal(h.calls.writes, 0);
  assert.equal(h.calls.flushes, 0);
});

test("a stale or forged row hint is verified and repaired by the authoritative scan", () => {
  const h = harness();
  const first = started(h, { ownerId: "owner-first", gameId: "game-first" });
  const second = started(h, { ownerId: "owner-second", gameId: "game-second" });
  h.setCache(h.gameRowCacheKey(first.gameId), "3");
  h.resetCalls();

  const read = h.invoke("read", { ownerId: first.ownerId, gameId: first.gameId });
  assert.equal(read.data.gameId, first.gameId);
  assert.equal(h.calls.readCells, 4, "header, stale hinted cell, then both authoritative rows are read");

  h.resetCalls();
  assert.equal(h.invoke("read", { ownerId: first.ownerId, gameId: first.gameId }).data.gameId, first.gameId);
  assert.equal(h.calls.readCells, 2, "the repaired hint points to the verified row");
  assert.equal(second.gameId, "game-second");
});

test("begin retry after committed write returns the original game, not a new random proposal", () => {
  const h = harness();
  const payload = beginPayload();
  h.failNextWrite({ afterCommit: true });
  expectError(h.invoke("begin", payload, { requestId: "begin-lost" }), "storage_unavailable");
  const first = h.getRecord(payload.gameId);
  assert.ok(first);
  h.advanceTime(1000);
  const retried = changed(h, "begin", { ...payload, gameId: "different-proposal", seed: 987 }, "begin-lost");
  assert.deepEqual(retried, first);
  assert.equal(h.getRows("Games").length, 2);
  expectError(h.invoke("begin", { ...payload, requestHash: hash("other-name") }, { requestId: "begin-lost" }), "conflict");
});

test("five unexpired global places and one active game per owner are enforced", () => {
  const h = harness();
  const games = Array.from({ length: 5 }, (_, index) => started(h, {
    ownerId: "owner-" + index, gameId: "game-" + index,
  }));
  const own = h.invoke("begin", beginPayload({ ownerId: "owner-0", gameId: "own-again" }));
  expectError(own, "active_game_exists", 409);
  assert.deepEqual(own.error.details, { gameId: games[0].gameId });
  const full = h.invoke("begin", beginPayload({ ownerId: "sixth-owner", gameId: "sixth" }));
  expectError(full, "ranked_full", 503);
  assert.equal(full.error.details, undefined, "other owners' game ids must not leak");
  h.advanceTime(120000);
  assert.equal(started(h, { ownerId: "sixth-owner", gameId: "sixth" }).leaseEpoch, 1);
});

test("capacity property is bounded, validated and shared by all callers", () => {
  const h = harness({ properties: { MAX_RANKED_GAMES: "2" } });
  started(h);
  started(h, { ownerId: "owner-b", gameId: "game-b" });
  expectError(h.invoke("begin", beginPayload({ ownerId: "owner-c", gameId: "game-c" })), "ranked_full", 503);
  for (const setting of ["", "0", "31", "1.5", "garbage"]) {
    const invalid = harness({ properties: { MAX_RANKED_GAMES: setting } });
    expectError(invalid.invoke("begin", beginPayload()), "storage_unavailable", 503);
    assert.equal(invalid.calls.writes, 0);
  }
});

test("creation rate is derived from durable games, including completed attempts", () => {
  const h = harness();
  for (let index = 0; index < 6; index += 1) {
    const game = started(h, { gameId: "attempt-" + index });
    changed(h, "checkpoint", checkpointPayload(game, { ticks: 1, dead: true }), "finish-" + index);
  }
  expectError(h.invoke("begin", beginPayload({ gameId: "too-many" })), "rate_limited", 429);
  h.advanceTime(60000);
  assert.equal(started(h, { gameId: "after-window" }).status, "active");
});

test("checkpoint CAS updates one authoritative cell and rejects stale/forked writes", () => {
  const h = harness();
  const game = started(h);
  h.advanceTime(10000);
  const payload = checkpointPayload(game, { score: 4 });
  const next = changed(h, "checkpoint", payload, "checkpoint-1");
  assert.equal(next.seq, 1);
  assert.equal(next.snapshot.tick, 1200);
  assert.equal(next.leaseUntil, h.now() + 120000);
  assert.equal(h.getRows("Games").length, 2);
  expectError(h.invoke("checkpoint", checkpointPayload(game, { score: 3 }), { requestId: "fork" }), "conflict");
  expectError(h.invoke("checkpoint", { ...payload, requestHash: hash("changed") }, { requestId: "checkpoint-1" }), "conflict");
  assert.deepEqual(h.getRecord(game.gameId), next);
});

test("lost completion response is idempotent before terminal, lease and CAS checks", () => {
  const h = harness();
  const game = started(h);
  h.advanceTime(10000);
  const payload = checkpointPayload(game, { score: 7, dead: true });
  h.failNextFlush();
  expectError(h.invoke("checkpoint", payload, { requestId: "finish-lost" }), "storage_unavailable");
  const committed = h.getRecord(game.gameId);
  assert.equal(committed.status, "completed");
  assert.equal(committed.finalScore, 7);
  h.advanceTime(240000);
  const writes = h.calls.writes;
  assert.deepEqual(changed(h, "checkpoint", payload, "finish-lost"), committed);
  assert.equal(h.calls.writes, writes);
  assert.equal(h.invoke("scores", {}).data.scores.length, 1);
});

test("failure before write can be retried, and every mutation flushes before unlocking", () => {
  const h = harness();
  const game = started(h);
  h.advanceTime(10000);
  const payload = checkpointPayload(game);
  h.failNextWrite();
  expectError(h.invoke("checkpoint", payload, { requestId: "retry" }), "storage_unavailable");
  assert.equal(h.getRecord(game.gameId).seq, 0);
  assert.equal(changed(h, "checkpoint", payload, "retry").seq, 1);
  assert.deepEqual(h.calls.events.slice(-2).map((event) => event.type), ["flush", "release"]);
  h.setBusy(true);
  expectError(h.invoke("resume", resumedPayload(game)), "storage_unavailable", 503);
  h.setBusy(false);
});

test("only mutation attempts flush; duplicate and rejected checkpoints just release the lock", () => {
  const h = harness();
  const game = started(h);
  h.advanceTime(10000);
  const payload = checkpointPayload(game);
  const next = changed(h, "checkpoint", payload, "checkpoint-once");
  assert.deepEqual(h.calls.events.slice(-2).map((event) => event.type), ["flush", "release"]);

  h.resetCalls();
  assert.deepEqual(changed(h, "checkpoint", payload, "checkpoint-once"), next);
  assert.equal(h.calls.writes, 0);
  assert.equal(h.calls.flushes, 0);
  assert.deepEqual(h.calls.events.map((event) => event.type), ["lock", "release"]);

  h.resetCalls();
  expectError(h.invoke("checkpoint", checkpointPayload(next, { ticks: 1201 })), "invalid_input");
  assert.equal(h.calls.writes, 0);
  assert.equal(h.calls.flushes, 0);
  assert.deepEqual(h.calls.events.map((event) => event.type), ["lock", "release"]);
});

test("zero-tick pause accepts reordered snapshot keys and releases the place", () => {
  const h = harness();
  const game = started(h);
  h.advanceTime(10000);
  const payload = checkpointPayload(game, { ticks: 0, pause: true });
  payload.snapshot = Object.fromEntries(Object.entries(payload.snapshot).reverse());
  payload.stateHash = game.stateHash;
  const paused = changed(h, "checkpoint", payload, "pause");
  assert.equal(paused.status, "paused");
  assert.equal(paused.elapsedActiveMs, 10000);
  assert.equal(paused.activeSince, null);
  assert.equal(started(h, { gameId: "another-game" }).status, "active");
});

test("zero-tick checkpoints do not renew the lease or change physics", () => {
  const h = harness();
  const game = started(h);
  h.advanceTime(10000);
  const next = changed(h, "checkpoint", checkpointPayload(game, { ticks: 0 }), "empty");
  assert.equal(next.leaseUntil, game.leaseUntil);
  const changedState = checkpointPayload(next, { ticks: 0, score: 10 });
  expectError(h.invoke("checkpoint", changedState), "invalid_input");
});

test("speed checks use server active time and reject oversized/invalid progression", () => {
  const h = harness();
  const game = started(h);
  expectError(h.invoke("checkpoint", checkpointPayload(game)), "too_fast", 409);
  h.advanceTime(10000);
  for (const payload of [
    checkpointPayload(game, { ticks: 1201 }),
    checkpointPayload(game, { ticks: -1 }),
    checkpointPayload(game, { score: 1.25 }),
    checkpointPayload(game, { snapshot: snapshot({ tick: 1199 }) }),
  ]) expectError(h.invoke("checkpoint", payload), "invalid_input");
  const large = checkpointPayload(game);
  large.snapshot.padding = "я".repeat(2100);
  expectError(h.invoke("checkpoint", large), "invalid_input");
  assert.equal(h.getRecord(game.gameId).seq, 0);
});

test("pause/resume preserves prior active credit but never adds paused wall time", () => {
  const h = harness();
  const game = started(h);
  h.advanceTime(10000);
  const paused = changed(h, "checkpoint", checkpointPayload(game, { ticks: 0, pause: true }), "pause");
  h.advanceTime(3600000);
  const resumePayload = resumedPayload(paused);
  const resumed = changed(h, "resume", resumePayload, "resume");
  assert.equal(resumed.elapsedActiveMs, 10000);
  assert.equal(resumed.activeSince, h.now());
  assert.equal(resumed.seq, paused.seq);
  assert.equal(resumed.stateHash, paused.stateHash);
  assert.equal(resumed.leaseEpoch, 2);
  assert.deepEqual(changed(h, "resume", resumePayload, "resume"), resumed);
  const first = changed(h, "checkpoint", checkpointPayload(resumed), "old-credit");
  expectError(h.invoke("checkpoint", checkpointPayload(first), { requestId: "paused-is-not-credit" }), "too_fast");
});

test("expiry requires resume, caps old active credit and fences the prior epoch", () => {
  const h = harness();
  const game = started(h);
  const oldPayload = checkpointPayload(game);
  h.advanceTime(600000);
  expectError(h.invoke("checkpoint", oldPayload), "lease_expired", 409);
  const resumed = changed(h, "resume", resumedPayload(game), "resume-expired");
  assert.equal(resumed.elapsedActiveMs, 120000);
  assert.equal(resumed.leaseEpoch, 2);
  expectError(h.invoke("checkpoint", oldPayload, { requestId: "old-epoch" }), "conflict");
  assert.equal(changed(h, "checkpoint", checkpointPayload(resumed), "offline-tail").snapshot.tick, 1200);
});

test("stale resume after a subsequent pause cannot reacquire a place", () => {
  const h = harness();
  const game = started(h);
  const paused = changed(h, "checkpoint", checkpointPayload(game, { ticks: 0, pause: true }), "pause-1");
  const payload = resumedPayload(paused);
  const resumed = changed(h, "resume", payload, "resume-1");
  const pausedAgain = changed(h, "checkpoint", checkpointPayload(resumed, { ticks: 0, pause: true }), "pause-2");
  expectError(h.invoke("resume", payload, { requestId: "resume-1" }), "conflict");
  assert.deepEqual(h.getRecord(game.gameId), pausedAgain);
});

test("resume checks both owner exclusivity and global capacity", () => {
  const h = harness();
  const game = started(h);
  const paused = changed(h, "checkpoint", checkpointPayload(game, { ticks: 0, pause: true }), "pause");
  const second = started(h, { gameId: "other-owned" });
  const blocked = h.invoke("resume", resumedPayload(paused));
  expectError(blocked, "active_game_exists");
  assert.equal(blocked.error.details.gameId, second.gameId);
  const released = changed(h, "checkpoint", checkpointPayload(second, { ticks: 0, pause: true }), "pause-second");
  for (let index = 0; index < 5; index += 1) started(h, { ownerId: "other-" + index, gameId: "other-" + index });
  expectError(h.invoke("resume", resumedPayload(released)), "ranked_full");
});

test("ownership, completed-only ranking and immutable terminal game are enforced", () => {
  const h = harness();
  const game = started(h);
  expectError(h.invoke("read", { ownerId: "someone-else", gameId: game.gameId }), "forbidden", 403);
  h.advanceTime(10000);
  const active = changed(h, "checkpoint", checkpointPayload(game, { score: 6 }), "active-progress");
  assert.deepEqual(h.invoke("scores", {}).data.scores, []);
  const paused = changed(h, "checkpoint", checkpointPayload(active, { ticks: 0, score: 6, pause: true }), "pause");
  assert.deepEqual(h.invoke("scores", {}).data.scores, []);
  const resumed = changed(h, "resume", resumedPayload(paused), "resume");
  const final = changed(h, "checkpoint", checkpointPayload(resumed, { ticks: 1, score: 6, dead: true }), "finish");
  const scores = h.invoke("scores", { name: " ALICE " }).data;
  assert.equal(scores.player.bestScore, 6);
  assert.equal(scores.player.verified, true);
  assert.equal(scores.player.source, "verified");
  expectError(h.invoke("resume", resumedPayload(final)), "conflict");
  expectError(h.invoke("checkpoint", checkpointPayload(final, { ticks: 0 })), "conflict");
});

test("legacy migration preserves source, collapses normalized names and is idempotent", () => {
  const source = [
    ["Name", "Score", "Best Score", "Updated At"],
    [" Alice ", 4, 9, "2026-08-20T00:00:00Z"],
    ["ALICE", 8, 12, "2026-08-21T00:00:00Z"],
    ["=SUM(1,2)", 5, 5, "2026-08-22T00:00:00Z"],
    ["  Bob   Fish  ", "6", "", ""],
    ["bad-score", -5, 1, ""],
    ["bad-number", "NaN", "", ""],
    ["fraction", 1.5, "", ""],
    ["", 4, 4, ""],
    ["bad-time", 2, 2, "not-a-date"],
  ];
  const h = harness({ sheets: { Scores: source } });
  const report = h.runAdmin("migrateLegacyScores");
  assert.equal(report.importedNames, 4);
  assert.equal(report.invalidRows.length, 4);
  assert.equal(report.warnings.length, 1);
  assert.deepEqual(h.getRows("Scores"), source);
  const first = h.getRows("Legacy");
  h.advanceTime(60000);
  assert.deepEqual(h.runAdmin("migrateLegacyScores"), report);
  assert.deepEqual(h.getRows("Legacy"), first);
  assert.ok(first.slice(1).every((row) => row[0].startsWith("{")), "untrusted text is stored inside JSON, never as a formula");
  const scores = h.invoke("scores", { name: " alice " }).data;
  assert.equal(scores.player.bestScore, 12);
  assert.equal(scores.player.source, "legacy");
  assert.equal(scores.player.verified, false);
  assert.ok(scores.scores.some((entry) => entry.name === "=SUM(1,2)"));
});

test("legacy three-column schema works and rebuilding clears stale target rows only", () => {
  const h = harness({ sheets: { Scores: [
    ["Name", "Best Score", "Updated At"], ["A", 4, ""], ["B", 7, ""],
  ] } });
  h.runAdmin("migrateLegacyScores");
  const reduced = [["Name", "Best Score", "Updated At"], ["A", 3, ""]];
  h.setRows("Scores", reduced);
  h.runAdmin("migrateLegacyScores");
  const scores = h.invoke("scores", {}).data.scores;
  assert.deepEqual(scores.map((entry) => [entry.name, entry.bestScore]), [["A", 3]]);
  assert.deepEqual(h.getRows("Scores"), reduced);
  h.setRows("Scores", [["Unexpected", "Header"], ["A", 999]]);
  const before = h.getRows("Legacy");
  assert.throws(() => h.runAdmin("migrateLegacyScores"), /headers/);
  assert.deepEqual(h.getRows("Legacy"), before);
});

test("verified score wins a tie with legacy; higher legacy remains marked", () => {
  const h = harness({ sheets: { Scores: [["Name", "Best Score"], ["alice", 8], ["Bob", 20]] } });
  h.runAdmin("migrateLegacyScores");
  let game = started(h);
  h.advanceTime(10000);
  changed(h, "checkpoint", checkpointPayload(game, { dead: true, score: 8 }), "finish-a");
  game = started(h, { ownerId: "owner-b", name: "BOB", gameId: "game-b" });
  h.advanceTime(10000);
  changed(h, "checkpoint", checkpointPayload(game, { dead: true, score: 9 }), "finish-b");
  const scores = h.invoke("scores", {}).data.scores;
  assert.equal(scores[0].name, "Bob");
  assert.equal(scores[0].source, "legacy");
  assert.equal(scores[1].name, "Alice");
  assert.equal(scores[1].source, "verified");
});

test("top 100 limit still returns an exact player's rank outside that window", () => {
  const rows = [["Name", "Best Score"]];
  for (let index = 0; index < 105; index += 1) rows.push(["Player " + index, 200 - index]);
  const h = harness({ sheets: { Scores: rows } });
  h.runAdmin("migrateLegacyScores");
  const data = h.invoke("scores", { name: "PLAYER 104" }).data;
  assert.equal(data.scores.length, 100);
  assert.equal(data.player.rank, 105);
  assert.equal(data.player.bestScore, 96);
  assert.equal(h.invoke("scores", { name: "unknown" }).data.player, null);
  h.resetCalls();
  const indexed = h.invoke("scores", { includeIndex: true }).data;
  assert.equal(indexed.scores.length, 100);
  assert.equal(indexed.index.length, 105);
  assert.equal(indexed.index[104].rank, 105);
  assert.equal(indexed.index[0].snapshot, undefined, "the internal index contains only best-per-name summaries");
  assert.equal(h.calls.writes, 0);
  assert.equal(h.invoke("scores", {}).data.index, undefined);
});

test("damaged authoritative rows fail closed instead of freeing occupied places", () => {
  const h = harness();
  const game = started(h);
  const rows = h.getRows("Games");
  rows.push(["{damaged"]);
  h.setRows("Games", rows);
  h.resetCalls();
  expectError(h.invoke("begin", beginPayload({ ownerId: "another", gameId: "new-game" })), "storage_unavailable");
  expectError(h.invoke("read", { ownerId: game.ownerId, gameId: game.gameId }), "storage_unavailable");
  assert.equal(h.calls.writes, 0);
});

test("runtime diagnostics are emitted after commit without identity or replay data", () => {
  const h = harness();
  started(h);
  const admission = JSON.parse(h.logs.at(-1));
  assert.deepEqual(admission, {
    component: "flappy-fish-store", event: "ranked_admission", action: "begin", activeSlots: 1, limit: 5,
  });
  h.setBusy(true);
  expectError(h.invoke("begin", beginPayload({ ownerId: "other", gameId: "other" })), "storage_unavailable");
  assert.equal(JSON.parse(h.logs.at(-1)).reason, "busy");
  assert.ok(h.logs.every((entry) => !entry.includes("Alice") && !entry.includes("owner-a") && !entry.includes("game-a")));
});
