import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../src/server/app.js';
import { AppsScriptGateway } from '../src/server/gateway.js';
import { loadConfig } from '../src/server/config.js';
import { digest, signToken, verifyToken } from '../src/server/security.js';
import { ReplayVerifier } from '../src/server/verifier.js';
import { createInitialState, RULES_VERSION } from '../src/shared/game-core.js';
import { createAppsScriptHarness, TEST_GATEWAY_SECRET } from './helpers/apps-script-harness.js';

const config = loadConfig({
  RANKED_ENABLED: 'true', SESSION_HMAC_KEY: 'test-session-key-32-bytes-or-more-never-production',
  STATE_HMAC_KEY: 'test-state-key-32-bytes-or-more-never-production', GATEWAY_HMAC_KEY: TEST_GATEWAY_SECRET,
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/test-deployment/exec',
});
const quiet = { info() {} };

async function fixture(t, options = {}) {
  const harness = options.harness || createAppsScriptHarness({ now: 1787920000000 });
  let loseNext = null;
  let gatewayCalls = 0;
  const gateway = new AppsScriptGateway({
    url: config.gatewayUrl, key: config.gatewayKey, now: harness.now,
    fetchImpl: async (url, request) => {
      gatewayCalls += 1;
      const envelope = JSON.parse(request.body);
      let result = harness.post(envelope);
      if (options.transformResponse) result = options.transformResponse(envelope.action, result);
      if (loseNext === envelope.action && result.ok) { loseNext = null; throw new Error('Response lost after commit'); }
      return new Response(JSON.stringify(result), { status: 200 });
    },
  });
  const servers = [];
  let base;
  async function launch() {
    const app = createApp({ config: options.config || config, store: gateway, now: harness.now, logger: quiet });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
    servers.push({ server, app });
  }
  await launch();
  t.after(async () => {
    for (const { server, app } of servers) {
      if (server.listening) await new Promise(resolve => server.close(resolve));
      await app.locals.close();
    }
  });
  async function request(path, { body, cookie, method, headers = {}, raw } = {}) {
    const response = await fetch(base + path, {
      method: method || (body === undefined && raw === undefined ? 'GET' : 'POST'),
      headers: { ...(body === undefined && raw === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...headers },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { response, status: response.status, data, text };
  }
  async function session() {
    const result = await request('/api/session', { body: {} });
    assert.equal(result.status, 200, result.text);
    return result.response.headers.get('set-cookie').split(';')[0];
  }
  async function begin(cookie, name = 'Fish', requestId = randomUUID()) {
    return request('/api/games', { cookie, body: { name, requestId } });
  }
  const block = (receipt, inputs, changes = {}) => ({
    requestId: randomUUID(), checkpointToken: receipt.checkpointToken,
    seq: receipt.checkpoint.seq + 1, inputsBase64: Buffer.from(inputs).toString('base64'), pause: false,
    ...changes,
  });
  const checkpoint = (cookie, receipt, body) => request(`/api/games/${receipt.gameId}/checkpoints`, { cookie, body });
  return {
    harness, request, session, begin, block, checkpoint,
    loseResponse: action => { loseNext = action; },
    calls: () => gatewayCalls,
    restart: async () => {
      const { server, app } = servers.at(-1);
      await new Promise(resolve => server.close(resolve));
      await app.locals.close();
      await launch();
    },
  };
}

test('unconfigured deployment stays in practice and old score writes are gone', async t => {
  const f = await fixture(t, { config: loadConfig({}) });
  assert.equal((await f.request('/api/health')).data.rankedEnabled, false);
  assert.equal((await f.request('/')).status, 200);
  assert.equal((await f.request('/shared/game-core.js')).status, 200);
  assert.equal((await f.request('/server.js')).status, 404);
  assert.equal((await f.request('/.env')).status, 404);
  assert.equal((await f.request('/api/session', { body: {} })).status, 503);
  assert.equal((await f.request('/api/scores', { body: { name: 'Injected', score: 999999 } })).status, 410);
  assert.equal(f.calls(), 0);
});

test('keys must be long, separated, and server-only', () => {
  assert.equal(config.configured, true);
  assert.equal(loadConfig({ ...process.env, RANKED_ENABLED: 'true', SESSION_HMAC_KEY: 'same'.repeat(10), STATE_HMAC_KEY: 'same'.repeat(10), GATEWAY_HMAC_KEY: 'same'.repeat(10), APPS_SCRIPT_URL: config.gatewayUrl }).configured, false);
  const token = signToken({ v: 1, id: 'test' }, config.stateKey, 'checkpoint');
  assert.throws(() => verifyToken(token, config.sessionKey, 'checkpoint'), /Подпись/);
  assert.throws(() => verifyToken(token, config.stateKey, 'session'), /Подпись/);
});

test('anonymous secure cookies authorize only their own game; no CORS authority', async t => {
  const f = await fixture(t);
  const issued = await f.request('/api/session', { body: {} });
  const cookieHeader = issued.response.headers.get('set-cookie');
  for (const attribute of ['__Host-flappy_session=', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(cookieHeader.includes(attribute));
  assert.equal(issued.response.headers.get('access-control-allow-origin'), null);
  const cookie = cookieHeader.split(';')[0];
  const other = await f.session();
  const game = await f.begin(cookie);
  assert.equal(game.status, 200, game.text);
  assert.equal((await f.request(`/api/games/${game.data.gameId}`, { cookie: other })).status, 403);
  assert.equal((await f.request(`/api/games/${game.data.gameId}`)).status, 401);
  assert.equal((await f.request(`/api/games/${game.data.gameId}`, { cookie: cookie.slice(0, -1) + (cookie.at(-1) === 'A' ? 'B' : 'A') })).status, 401);
  const crossSite = await f.request('/api/games', { cookie, body: { name: 'Fish', requestId: randomUUID() }, headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  assert.equal((await f.request('/api/games', { cookie, body: { name: 'Fish', requestId: randomUUID() }, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await f.request('/api/scores?callback=evil')).status, 400);
});

test('begin is idempotent and one owner cannot reserve a second active slot', async t => {
  const f = await fixture(t);
  const cookie = await f.session();
  const id = randomUUID();
  const first = await f.begin(cookie, '  FiSH   One ', id);
  const duplicate = await f.begin(cookie, 'FiSH One', id);
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.data, duplicate.data);
  assert.equal(f.harness.getRows('Games').length, 2);
  const changed = await f.begin(cookie, 'Other', id);
  assert.equal(changed.status, 409);
  const next = await f.begin(cookie);
  assert.equal(next.data.error.code, 'active_game_exists');
  assert.equal(next.data.error.details.gameId, first.data.gameId);
});

test('client score, modified seed/signature, bad inputs, and oversized requests cannot reach storage', async t => {
  const f = await fixture(t);
  const cookie = await f.session();
  const { data: game } = await f.begin(cookie);
  const before = f.calls();
  const normal = f.block(game, [0]);
  const signedParts = normal.checkpointToken.split('.');
  const payload = JSON.parse(Buffer.from(signedParts[0], 'base64url'));
  payload.seed = (payload.seed + 1) >>> 0;
  const changedSeed = Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + signedParts[1];
  for (const mutation of [
    { score: 9999 }, { bestScore: 9999 }, { snapshot: createInitialState(1) },
    { inputsBase64: 'CA==' }, { inputsBase64: 'AAAA?' }, { inputsBase64: '' },
    { inputsBase64: Buffer.alloc(1201).toString('base64') }, { checkpointToken: changedSeed },
    { checkpointToken: 'x'.repeat(6000) }, { pause: 'true' },
  ]) {
    const result = await f.checkpoint(cookie, game, { ...normal, ...mutation });
    assert.ok(result.status >= 400 && result.status < 500, result.text);
  }
  assert.equal((await f.checkpoint(cookie, game, { ...normal, seq: 2 })).status, 409);
  const oversized = await f.request(`/api/games/${game.gameId}/checkpoints`, { cookie, raw: JSON.stringify({ padding: 'x'.repeat(8192) }) });
  assert.equal(oversized.status, 413);
  assert.equal(f.calls(), before);
  assert.equal(f.harness.getRecord(game.gameId).seq, 0);
});

test('server replays death exactly; trailing input is rejected and final retry adds no row', async t => {
  const f = await fixture(t);
  const cookie = await f.session();
  const { data: game } = await f.begin(cookie);
  const inputs = [4, ...Array(85).fill(0)];
  f.harness.advanceTime(1000);
  const trailing = await f.checkpoint(cookie, game, f.block(game, [...inputs, 0]));
  assert.equal(trailing.status, 400, trailing.text);
  const body = f.block(game, inputs);
  const final = await f.checkpoint(cookie, game, body);
  assert.equal(final.status, 200, final.text);
  assert.equal(final.data.status, 'completed');
  assert.equal(final.data.checkpoint.snapshot.tick, 86);
  assert.equal(final.data.finalScore, 0);
  assert.equal(final.data.verified, true);
  assert.deepEqual((await f.checkpoint(cookie, game, body)).data, final.data);
  assert.equal(f.harness.getRows('Games').length, 2);
  assert.equal((await f.checkpoint(cookie, final.data, f.block(final.data, [0]))).status, 409);
  const score = await f.request('/api/scores?name=FISH');
  assert.equal(score.data.player.source, 'verified');
  assert.equal(score.data.player.bestScore, 0);
});

test('a 10-second block cannot advance ahead of server time and can be retried later', async t => {
  const f = await fixture(t);
  const cookie = await f.session();
  const { data: game } = await f.begin(cookie);
  const body = f.block(game, Array(1200).fill(0));
  const early = await f.checkpoint(cookie, game, body);
  assert.equal(early.data.error.code, 'too_fast');
  assert.equal(f.harness.getRecord(game.gameId).seq, 0);
  f.harness.advanceTime(10000);
  const accepted = await f.checkpoint(cookie, game, body);
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.data.checkpoint.snapshot.tick, 1200);
});

test('a lost response gives no token; retry and Node restart recover the durable acknowledgement', async t => {
  const f = await fixture(t);
  const cookie = await f.session();
  const { data: game } = await f.begin(cookie);
  f.harness.advanceTime(10000);
  const body = f.block(game, Array(1200).fill(0));
  f.loseResponse('checkpoint');
  const lost = await f.checkpoint(cookie, game, body);
  assert.equal(lost.status, 503);
  assert.equal(lost.data.checkpointToken, undefined);
  assert.equal(f.harness.getRecord(game.gameId).seq, 1);
  await f.restart();
  const recovered = await f.request(`/api/games/${game.gameId}`, { cookie });
  assert.equal(recovered.data.lastRequestId, body.requestId);
  const retry = await f.checkpoint(cookie, game, body);
  assert.equal(retry.status, 200, retry.text);
  assert.deepEqual(retry.data, recovered.data);
  assert.equal(f.harness.getRows('Games').length, 2);
});

test('concurrent identical checkpoints commit once, competing branches conflict', async t => {
  const f = await fixture(t);
  const cookie = await f.session();
  const { data: game } = await f.begin(cookie);
  const body = f.block(game, [1, 1]);
  const duplicates = await Promise.all([f.checkpoint(cookie, game, body), f.checkpoint(cookie, game, body)]);
  assert.deepEqual(duplicates.map(value => value.status), [200, 200]);
  assert.deepEqual(duplicates[0].data, duplicates[1].data);
  const current = duplicates[0].data;
  const branches = await Promise.all([
    f.checkpoint(cookie, current, f.block(current, [1, 1])),
    f.checkpoint(cookie, current, f.block(current, [2, 2])),
  ]);
  assert.deepEqual(branches.map(value => value.status).sort(), [200, 409]);
  assert.equal(f.harness.getRecord(game.gameId).seq, 2);
});

test('five slots, partial pause, resume CAS, and expired leases preserve games', async t => {
  const f = await fixture(t);
  const owners = await Promise.all(Array.from({ length: 6 }, () => f.session()));
  const games = [];
  for (let i = 0; i < 5; i++) games.push((await f.begin(owners[i], `Fish${i}`)).data);
  assert.equal((await f.begin(owners[5])).data.error.code, 'ranked_full');
  const paused = await f.checkpoint(owners[0], games[0], f.block(games[0], [], { pause: true }));
  assert.equal(paused.status, 200, paused.text);
  assert.equal(paused.data.status, 'paused');
  assert.equal((await f.begin(owners[5])).status, 200);
  const resumeBody = { requestId: randomUUID(), checkpointToken: paused.data.checkpointToken };
  const resumePath = `/api/games/${games[0].gameId}/resume`;
  assert.equal((await f.request(resumePath, { cookie: owners[0], body: resumeBody })).data.error.code, 'ranked_full');
  f.harness.advanceTime(121000);
  const resumed = await f.request(resumePath, { cookie: owners[0], body: resumeBody });
  assert.equal(resumed.status, 200, resumed.text);
  assert.equal(resumed.data.checkpoint.leaseEpoch, 2);
  assert.equal(resumed.data.checkpoint.seq, paused.data.checkpoint.seq);
  assert.deepEqual((await f.request(resumePath, { cookie: owners[0], body: resumeBody })).data, resumed.data);
  assert.equal((await f.checkpoint(owners[0], paused.data, f.block(paused.data, [0]))).status, 409);
  const pausedAgain = await f.checkpoint(owners[0], resumed.data, f.block(resumed.data, [], { pause: true }));
  assert.equal(pausedAgain.status, 200, pausedAgain.text);
  assert.equal((await f.request(resumePath, { cookie: owners[0], body: resumeBody })).status, 409);
  assert.equal(f.harness.getRows('Games').length, 7);
});

test('offline tail keeps active-time credit after lease expiration and reacquisition', async t => {
  const f = await fixture(t);
  const cookie = await f.session();
  const { data: game } = await f.begin(cookie);
  f.harness.advanceTime(130000);
  const old = await f.checkpoint(cookie, game, f.block(game, Array(1200).fill(0)));
  assert.equal(old.data.error.code, 'lease_expired');
  const resumed = await f.request(`/api/games/${game.gameId}/resume`, { cookie, body: { requestId: randomUUID(), checkpointToken: game.checkpointToken } });
  assert.equal(resumed.status, 200, resumed.text);
  const tail = await f.checkpoint(cookie, resumed.data, f.block(resumed.data, Array(1200).fill(0)));
  assert.equal(tail.status, 200, tail.text);
  assert.equal(tail.data.checkpoint.snapshot.tick, 1200);
});

test('legacy maxima merge by normalized name, verified ties win, cache is 30 seconds', async t => {
  const f = await fixture(t);
  f.harness.setRows('Scores', [['Name', 'Score', 'Best Score', 'Updated At'], ['  FiSh ', 0, 0, '2020-01-01'], ['Other', 9, 99, '2020-01-02']]);
  f.harness.runAdmin('migrateLegacyScores');
  const first = await f.request('/api/scores?name=fish');
  assert.equal(first.data.player.source, 'legacy');
  const before = f.calls();
  await f.request('/api/scores?name=FISH');
  assert.equal(f.calls(), before);
  const cookie = await f.session();
  const { data: game } = await f.begin(cookie, 'fish');
  f.harness.advanceTime(1000);
  await f.checkpoint(cookie, game, f.block(game, [4, ...Array(85).fill(0)]));
  assert.equal((await f.request('/api/scores?name=fish')).data.player.source, 'legacy');
  f.harness.advanceTime(30000);
  const refreshed = await f.request('/api/scores?name=fish');
  assert.equal(refreshed.data.player.source, 'verified');
  assert.equal(refreshed.data.player.rank, 2);
  assert.equal(refreshed.data.scores[0].bestScore, 99);
  assert.equal(refreshed.data.index, undefined);
});

test('rate limits return 429; disabling ranked leaves stored scores and practice readable', async t => {
  const f = await fixture(t);
  const cookie = await f.session();
  await f.begin(cookie);
  let last;
  for (let i = 0; i < 6; i++) last = await f.begin(cookie);
  assert.equal(last.status, 429);
  assert.equal(last.response.headers.get('retry-after'), '5');
  const disabled = await fixture(t, { harness: f.harness, config: { ...config, rankedEnabled: false } });
  assert.equal((await disabled.request('/')).status, 200);
  assert.equal((await disabled.request('/api/scores')).status, 200);
  assert.equal((await disabled.begin(cookie)).data.error.code, 'ranked_disabled');
});

test('bounded worker queue rejects excess replay work without touching a store', async t => {
  const verifier = new ReplayVerifier({ workers: 1, queueLimit: 1, budgetMs: 250 });
  t.after(() => verifier.close());
  const pending = Array.from({ length: 4 }, () => verifier.verify(createInitialState(1), new Uint8Array(1200)));
  const results = await Promise.allSettled(pending);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 2);
  const errors = results.filter(value => value.status === 'rejected');
  assert.ok(errors.every(value => value.reason.code === 'verification_busy'));
});

test('malformed durable states are never signed as verified results', async t => {
  const f = await fixture(t, { transformResponse(action, result) {
    if (action === 'begin' && result.ok) {
      result.data.status = 'completed';
      result.data.snapshot.score = 10000;
      result.data.finalScore = 10000;
      result.data.stateHash = digest(result.data.snapshot);
    }
    return result;
  } });
  const result = await f.begin(await f.session());
  assert.equal(result.status, 503);
  assert.equal(result.data.checkpointToken, undefined);
  assert.equal(result.data.verified, undefined);
});

test('leaderboard projects only public fields and shares one cache across 500 nickname queries', async t => {
  const f = await fixture(t, { transformResponse(action, result) {
    if (action === 'scores' && result.ok) {
      for (const entry of [...result.data.index, ...result.data.scores]) Object.assign(entry, { ownerId: 'private-owner', snapshot: { private: true }, checkpointToken: 'private-token' });
    }
    return result;
  } });
  f.harness.setRows('Scores', [['Name', 'Best Score'], ['FiSh', 5]]);
  f.harness.runAdmin('migrateLegacyScores');
  const results = [];
  // Bound the generator's sockets:500 visitors need not establish500 new TCP
  // connections in the same millisecond on a developer laptop.
  for (let offset = 0; offset < 500; offset += 50) {
    results.push(...await Promise.all(Array.from({ length: 50 }, (_, position) => {
      const index = offset + position;
      return f.request('/api/scores?name=' + (index ? `Visitor${index}` : 'fish'));
    })));
  }
  assert.ok(results.every(result => result.status === 200));
  assert.equal(f.calls(), 1);
  const result = results[0].data;
  assert.deepEqual(Object.keys(result.scores[0]).sort(), ['bestScore', 'name', 'rank', 'source', 'updatedAt', 'verified']);
  assert.deepEqual(result.scores[0], result.player);
  assert.equal(JSON.stringify(result).includes('private-'), false);
  assert.equal(result.index, undefined);
});

test('oversized upstream responses are cancelled before being fully buffered', async () => {
  let produced = 0;
  let cancelled = false;
  const gateway = new AppsScriptGateway({ url: config.gatewayUrl, key: config.gatewayKey, fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { produced++; controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { cancelled = true; },
  })) });
  await assert.rejects(() => gateway.call('scores', {}), error => error.code === 'storage_unavailable');
  assert.equal(cancelled, true);
  assert.ok(produced <= 18);
});

test('worker computation deadline terminates stuck work with a retryable error', async t => {
  const source = `import { parentPort } from 'node:worker_threads'; parentPort.on('message', () => { for (;;) {} }); parentPort.postMessage({ ready: true });`;
  const verifier = new ReplayVerifier({ workers: 1, queueLimit: 1, budgetMs: 250, workerUrl: new URL('data:text/javascript,' + encodeURIComponent(source)) });
  t.after(() => verifier.close());
  await assert.rejects(() => verifier.verify(createInitialState(1), [0]), error => error.status === 503 && error.code === 'verification_timeout');
});
