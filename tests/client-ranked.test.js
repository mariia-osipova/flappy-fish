import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { RankedClient, IndexedGameStore, MAX_BUFFER_TICKS } from "../src/web/ranked-client.js";
import { createInitialState, replay, RULES_VERSION, INPUT_FLAP } from "../src/shared/game-core.js";

const copy = (value) => structuredClone(value);
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ok = (value) => ({ ok: true, status: 200, json: async () => copy(value) });
const fail = (code, status = 409, details) => ({ ok: false, status, json: async () => ({ error: { code, message: code, details } }) });

class MemoryStore {
  constructor() { this.value = null; this.writes = []; }
  async load() { return copy(this.value); }
  async save(value) { this.value = copy(value); this.writes.push(copy(value)); }
}

function harness(options = {}) {
  const store = options.store || new MemoryStore();
  const server = options.server || {
    receipt: null, now: 1_000_000, offline: false, commits: 0, begins: 0, resumes: 0,
    loseCheckpoint: false, loseBegin: false, loseResume: false, full: false,
    calls: [], ids: new Map(), tokens: new Map(), inFlight: 0, maxInFlight: 0,
  };
  const issue = (receipt) => {
    receipt.checkpointToken = `token-${server.tokens.size}`;
    server.tokens.set(receipt.checkpointToken, copy(receipt));
    server.receipt = copy(receipt);
    return receipt;
  };
  const currentReceipt = () => ({ ...copy(server.receipt), leaseExpired: server.receipt.status === "active" && server.receipt.leaseUntil <= server.now });
  const fetcher = async (path, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    server.calls.push({ path, body });
    if (server.offline) throw new Error("offline");
    if (path === "/api/session") return ok({ ok: true });
    if (path === "/api/games") {
      if (!server.receipt) {
        if (server.full) return fail("ranked_full", 503);
        server.begins += 1;
        const snapshot = createInitialState(123);
        issue({ gameId: "game-1", name: body.name, rulesVersion: RULES_VERSION,
          checkpoint: { snapshot, seq: 0, stateHash: hash(snapshot), leaseEpoch: 1 },
          status: "active", leaseUntil: server.now + 120_000, lastRequestId: body.requestId, lastAction: "begin" });
      }
      if (server.loseBegin) { server.loseBegin = false; throw new Error("lost begin response"); }
      return ok(currentReceipt());
    }
    if (path === "/api/games/game-1") return ok(currentReceipt());
    if (path === "/api/games/game-1/resume") {
      if (server.ids.has(body.requestId)) return ok(server.ids.get(body.requestId));
      if (server.full) return fail("ranked_full", 503);
      if (server.receipt.status === "active" && server.receipt.leaseUntil > server.now) return fail("conflict");
      const token = server.tokens.get(body.checkpointToken);
      if (!token || token.checkpoint.seq !== server.receipt.checkpoint.seq || token.checkpoint.leaseEpoch !== server.receipt.checkpoint.leaseEpoch) return fail("conflict");
      server.resumes += 1;
      const receipt = copy(server.receipt);
      receipt.status = "active";
      receipt.leaseUntil = server.now + 120_000;
      receipt.checkpoint.leaseEpoch += 1;
      receipt.lastRequestId = body.requestId;
      receipt.lastAction = "resume";
      issue(receipt);
      server.ids.set(body.requestId, copy(receipt));
      if (server.loseResume) { server.loseResume = false; throw new Error("lost resume response"); }
      return ok(currentReceipt());
    }
    if (path === "/api/games/game-1/checkpoints") {
      server.inFlight += 1;
      server.maxInFlight = Math.max(server.maxInFlight, server.inFlight);
      try {
        if (server.gate) await server.gate;
        assert.equal(store.value.queue[0].requestId, body.requestId, "the block must be durable before fetch");
        assert.equal(store.value.uncertain, true);
        if (server.ids.has(body.requestId)) return ok(server.ids.get(body.requestId));
        const previous = server.tokens.get(body.checkpointToken);
        if (server.receipt.leaseUntil <= server.now) return fail("lease_expired");
        if (!previous || previous.checkpoint.leaseEpoch !== server.receipt.checkpoint.leaseEpoch) return fail("conflict");
        if (body.seq !== server.receipt.checkpoint.seq + 1) return fail("conflict");
        const bytes = Uint8Array.from(Buffer.from(body.inputsBase64, "base64"));
        const snapshot = bytes.length ? replay(server.receipt.checkpoint.snapshot, bytes) : copy(server.receipt.checkpoint.snapshot);
        const receipt = copy(server.receipt);
        receipt.checkpoint = { ...receipt.checkpoint, snapshot, seq: body.seq, stateHash: hash(snapshot) };
        receipt.status = snapshot.dead ? "completed" : body.pause ? "paused" : "active";
        receipt.leaseUntil = receipt.status === "active" ? server.now + 120_000 : 0;
        receipt.lastRequestId = body.requestId;
        receipt.lastAction = "checkpoint";
        issue(receipt);
        server.commits += 1;
        server.ids.set(body.requestId, copy(receipt));
        if (server.loseCheckpoint) { server.loseCheckpoint = false; throw new Error("lost checkpoint response"); }
        return ok(currentReceipt());
      } finally { server.inFlight -= 1; }
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  let serial = options.serial || 0;
  const events = [];
  const client = new RankedClient({ store, fetcher, now: () => server.now,
    requestId: () => `request-${++serial}`, automaticRetry: false, onChange: (event) => events.push(event) });
  return { client, server, store, events };
}

async function started(options) {
  const result = harness(options);
  await result.client.start("Fish");
  return result;
}

function advance(client, count, input = 0) {
  for (let index = 0; index < count; index += 1) client.advance(input);
}

test("lost create reply reuses the durable request id", async () => {
  const { client, server, store } = harness();
  server.loseBegin = true;
  await assert.rejects(client.start("Fish"), { code: "network" });
  const id = store.value.beginRequestId;
  await client.start("Fish");
  assert.equal(server.begins, 1);
  assert.deepEqual(server.calls.filter((call) => call.path === "/api/games").map((call) => call.body.requestId), [id, id]);
  await client.close();
});

test("an expired create retry obtains a new lease before ranked play", async () => {
  const { client, server } = harness();
  server.loseBegin = true;
  await assert.rejects(client.start("Fish"), { code: "network" });
  server.now += 121_000;
  await client.start("Fish");
  assert.equal(server.begins, 1);
  assert.equal(server.resumes, 1);
  assert.equal(client.receipt.checkpoint.leaseEpoch, 2);
  assert.equal(client.running, true);
  await client.close();
});

test("lease decisions use the server receipt rather than a fast browser clock", async () => {
  const { client, server } = await started();
  client.now = () => server.now + 86_400_000;
  advance(client, 12);
  await client.pause();
  assert.equal(server.resumes, 0);
  assert.equal(server.commits, 1);
  assert.equal(client.receipt.status, "paused");
  await client.close();
});

test("a lost checkpoint reply is reconciled without sending a second result", async () => {
  const { client, server, store } = await started();
  advance(client, 43);
  server.loseCheckpoint = true;
  await client.pause();
  assert.equal(client.status, "reconnecting");
  assert.equal(client.receipt.checkpoint.seq, 0, "unknown response must not be displayed as saved");
  assert.equal(store.value.queue.length, 1);
  const requestId = store.value.queue[0].requestId;
  await client.pump();
  assert.equal(server.commits, 1);
  assert.equal(client.status, "paused");
  assert.equal(client.receipt.lastRequestId, requestId);
  assert.equal(store.value.queue.length, 0);
  assert.equal(store.value.receipt.checkpoint.seq, 1);
  await client.close();
});

test("reload restores a committed block after a lost acknowledgement", async () => {
  const first = await started();
  advance(first.client, 23);
  first.server.loseCheckpoint = true;
  await first.client.pause();
  await first.client.close();
  const restored = harness({ store: first.store, server: first.server, serial: 100 });
  await restored.client.initialize();
  await restored.client.pump();
  assert.equal(restored.client.snapshot.tick, 23);
  assert.equal(restored.client.running, false);
  assert.equal(restored.client.receipt.status, "paused");
  assert.equal(first.server.commits, 1);
  assert.equal(first.store.value.queue.length, 0);
  await restored.client.close();
});

test("only one checkpoint request is in flight while later blocks accumulate", async () => {
  const { client, server } = await started();
  let release;
  server.gate = new Promise((resolve) => { release = resolve; });
  advance(client, 2400);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.inFlight, 1);
  assert.equal(client.bufferedTicks, 2400);
  release();
  await client.pump();
  assert.equal(server.commits, 2);
  assert.equal(server.maxInFlight, 1);
  assert.equal(client.receipt.checkpoint.seq, 2);
  assert.equal(client.bufferedTicks, 0);
  await client.close();
});

test("the unconfirmed buffer stops at thirty seconds and queues a pause", async () => {
  const { client, server, store } = await started();
  server.offline = true;
  advance(client, MAX_BUFFER_TICKS + 100);
  await client.pump();
  await client.saving;
  assert.equal(client.snapshot.tick, MAX_BUFFER_TICKS);
  assert.equal(client.bufferedTicks, MAX_BUFFER_TICKS);
  assert.equal(client.running, false);
  assert.equal(store.value.queue.at(-1).pause, true);
  assert.ok(store.value.queue.every((block) => block.inputs.length <= 1200));
  server.offline = false;
  await client.pump();
  assert.equal(client.receipt.status, "paused");
  assert.equal(client.receipt.checkpoint.snapshot.tick, MAX_BUFFER_TICKS);
  assert.equal(client.bufferedTicks, 0);
  await client.close();
});

test("expired lease preserves an offline tail and resumes it under a fresh epoch", async () => {
  const { client, server } = await started();
  advance(client, 45);
  server.offline = true;
  await client.pause();
  const originalId = client.record.queue[0].requestId;
  server.now += 121_000;
  server.offline = false;
  await client.pump();
  assert.equal(server.resumes, 1);
  assert.equal(client.receipt.checkpoint.leaseEpoch, 2);
  assert.equal(client.receipt.lastRequestId, originalId);
  assert.equal(client.receipt.checkpoint.snapshot.tick, 45);
  assert.equal(client.receipt.status, "paused");
  await client.close();
});

test("lost resume reply is reconciled before rebinding an uncommitted block", async () => {
  const { client, server } = await started();
  advance(client, 19);
  server.offline = true;
  await client.pause();
  server.offline = false;
  server.now += 121_000;
  server.loseResume = true;
  await client.pump();
  assert.equal(server.resumes, 1);
  assert.equal(client.record.queue.length, 1);
  await client.pump();
  assert.equal(server.resumes, 1, "a reconciled resume must not consume another epoch");
  assert.equal(server.commits, 1);
  assert.equal(client.receipt.checkpoint.snapshot.tick, 19);
  assert.equal(client.receipt.status, "paused");
  await client.close();
});

test("reload after an explicit lease expiry and lost resume reply does not resume an active lease twice", async () => {
  const first = await started();
  advance(first.client, 19);
  first.server.now += 121_000;
  await first.client.pause();
  assert.equal(first.client.record.forceResume, true);
  first.server.loseResume = true;
  await first.client.pump();
  assert.equal(first.server.resumes, 1);
  await first.client.close();
  const restored = harness({ store: first.store, server: first.server, serial: 100 });
  await restored.client.initialize();
  await restored.client.pump();
  assert.equal(first.server.resumes, 1);
  assert.equal(restored.client.receipt.status, "paused");
  assert.equal(restored.client.receipt.checkpoint.snapshot.tick, 19);
  assert.equal(restored.client.record.forceResume, false);
  await restored.client.close();
});

test("full slots keep a paused game and its input tail; retry can later continue", async () => {
  const { client, server } = await started();
  advance(client, 21);
  await client.pause();
  const snapshot = copy(client.snapshot);
  server.full = true;
  await assert.rejects(client.resume(), { code: "ranked_full" });
  assert.equal(client.running, false);
  assert.deepEqual(client.snapshot, snapshot);
  assert.equal(client.receipt.status, "paused");
  server.full = false;
  await client.resume();
  assert.equal(client.running, true);
  assert.deepEqual(client.snapshot, snapshot);
  await client.close();
});

test("a different committed branch is a conflict and never discards the outbox", async () => {
  const { client, server, store } = await started();
  advance(client, 25);
  server.offline = true;
  await client.pause();
  server.offline = false;
  server.receipt.checkpoint.seq = 1;
  server.receipt.checkpoint.stateHash = "another-branch";
  server.receipt.lastRequestId = "someone-else";
  await client.pump();
  assert.equal(client.status, "conflict");
  assert.equal(client.running, false);
  assert.equal(store.value.queue.length, 1);
  await client.close();
});

test("death submits the exact partial block and only a confirmed receipt marks it saved", async () => {
  const { client, server, events } = await started();
  client.advance(INPUT_FLAP);
  while (client.running) client.advance(0);
  assert.equal(client.snapshot.dead, true);
  assert.equal(client.status, "saving");
  const deathTick = client.snapshot.tick;
  assert.ok(deathTick < 1200);
  await client.pump();
  assert.equal(client.status, "completed");
  assert.equal(server.commits, 1);
  assert.equal(client.receipt.checkpoint.snapshot.tick, deathTick);
  assert.equal(client.advance(INPUT_FLAP), null);
  assert.ok(events.findIndex((event) => event.status === "saving") < events.findIndex((event) => event.status === "completed"));
  await client.close();
});

test("browser storage failure prevents ranked creation", async () => {
  const { client, server } = harness({ store: { load: async () => null, save: async () => { throw new Error("quota"); } } });
  await assert.rejects(client.start("Fish"), { code: "local_storage" });
  assert.equal(server.begins, 0);
  await client.close();
});

test("another tab cannot open the ranked outbox without the exclusive Web Lock", async () => {
  let opened = false;
  const store = new IndexedGameStore({ open() { opened = true; } }, {
    async request(name, options, callback) {
      assert.equal(name, "flappy-fish-ranked-owner");
      assert.equal(options.ifAvailable, true);
      return callback(null);
    },
  });
  await assert.rejects(store.open(), { code: "other_tab" });
  assert.equal(opened, false);
});

test("client outbox works through the real Node API and Apps Script gateway across a server restart", async (t) => {
  const { once } = await import("node:events");
  const { createApp } = await import("../src/server/app.js");
  const { AppsScriptGateway } = await import("../src/server/gateway.js");
  const { loadConfig } = await import("../src/server/config.js");
  const { createAppsScriptHarness, TEST_GATEWAY_SECRET } = await import("./helpers/apps-script-harness.js");
  const sheet = createAppsScriptHarness({ now: 1787920000000 });
  const config = loadConfig({
    RANKED_ENABLED: "true", SESSION_HMAC_KEY: "client-test-session-secret-at-least-32-characters",
    STATE_HMAC_KEY: "client-test-state-secret-at-least-32-characters", GATEWAY_HMAC_KEY: TEST_GATEWAY_SECRET,
    APPS_SCRIPT_URL: "https://script.google.com/macros/s/only-a-test/exec",
  });
  const gateway = new AppsScriptGateway({
    url: config.gatewayUrl, key: config.gatewayKey, now: sheet.now,
    fetchImpl: async (_url, request) => new Response(JSON.stringify(sheet.post(JSON.parse(request.body)))),
  });
  let app;
  let server;
  let base;
  async function launch() {
    app = createApp({ config, store: gateway, now: sheet.now, logger: { info() {} } });
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function shutdown() {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.close();
  }
  await launch();
  t.after(shutdown);
  let cookie = "";
  let loseCheckpoint = false;
  const fetcher = async (path, init) => {
    const response = await fetch(base + path, { ...init, headers: { ...init.headers, ...(cookie ? { cookie } : {}) } });
    const newCookie = response.headers.get("set-cookie");
    if (newCookie) cookie = newCookie.split(";")[0];
    if (loseCheckpoint && path.endsWith("/checkpoints") && response.ok) {
      loseCheckpoint = false;
      await response.text();
      throw new Error("The server saved the block but the browser lost its reply.");
    }
    return response;
  };
  const store = new MemoryStore();
  const first = new RankedClient({ store, fetcher, now: sheet.now, automaticRetry: false });
  await first.start("Fish");
  const gameId = first.receipt.gameId;
  sheet.advanceTime(10_100);
  advance(first, 1200);
  await first.pump();
  assert.equal(first.receipt.checkpoint.seq, 1);
  sheet.advanceTime(1000);
  advance(first, 37);
  loseCheckpoint = true;
  await first.pause();
  assert.equal(first.status, "reconnecting");
  assert.equal(sheet.getRecord(gameId).seq, 2);
  assert.equal(first.receipt.checkpoint.seq, 1);
  await first.close();
  await shutdown();
  await launch();
  const second = new RankedClient({ store, fetcher, now: sheet.now, automaticRetry: false });
  await second.initialize();
  await second.pump();
  assert.equal(second.snapshot.tick, 1237);
  assert.equal(second.receipt.status, "paused");
  assert.equal(sheet.getRows("Games").length, 2, "one permanent game row plus its header");

  // Losing the anonymous cookie must not silently create a new identity and
  // pretend that it recovered the old game.
  const detachedStore = new MemoryStore();
  detachedStore.value = copy(store.value);
  const detachedRequests = [];
  const detached = new RankedClient({ store: detachedStore, automaticRetry: false, fetcher: async (path, init) => {
    detachedRequests.push(path);
    return fetch(base + path, init);
  } });
  await assert.rejects(detached.initialize(), { code: "session_required" });
  assert.deepEqual(detachedRequests, [`/api/games/${gameId}`]);
  await detached.close();

  await second.resume();
  assert.equal(second.receipt.checkpoint.leaseEpoch, 2);
  sheet.advanceTime(10_000);
  second.advance(INPUT_FLAP);
  while (second.running) second.advance(0);
  await second.pump();
  assert.equal(second.status, "completed");
  assert.equal(sheet.getRecord(gameId).finalScore, second.snapshot.score);
  assert.equal(sheet.getRows("Games").length, 2);
  const scores = await (await fetch(base + "/api/scores?name=fish")).json();
  assert.equal(scores.player.source, "verified");
  assert.equal(scores.player.bestScore, second.snapshot.score);
  await second.close();
});

test("slow browser storage coalesces frame snapshots while retaining a durability barrier", async () => {
  const { client, store } = await started();
  const save = store.save.bind(store);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let writes = 0;
  store.save = async (value) => { writes += 1; await gate; return save(value); };
  for (let frame = 0; frame < 40; frame += 1) {
    advance(client, 10);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(writes, 1, "one IndexedDB write is in flight");
  assert.equal(client.snapshot.tick, 400);
  const durable = client.persist();
  release();
  await durable;
  assert.equal(writes, 2, "the pending writer retains the latest frame, not every frame");
  assert.equal(store.value.pending.length, 400);
  assert.equal(client.bufferedTicks, 400);
  await client.close();
});

test("completed local outboxes do not block a new anonymous session after cookie expiry", async () => {
  const first = await started();
  first.client.advance(INPUT_FLAP);
  while (first.client.running) first.client.advance(0);
  await first.client.pump();
  await first.client.close();
  const paths = [];
  const restored = new RankedClient({ store: first.store, automaticRetry: false, fetcher: async (path) => {
    paths.push(path);
    if (path === "/api/session") return ok({ ok: true });
    return fail("session_expired", 401);
  } });
  await restored.initialize();
  assert.deepEqual(paths, ["/api/session"]);
  assert.equal(restored.record, null);
  assert.equal(first.store.value, null);
  await restored.close();
});
