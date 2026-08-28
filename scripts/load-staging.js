import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { step, fishRect, RULES_VERSION, MAX_BLOCK_TICKS, TICK_RATE } from '../src/shared/game-core.js';

if (process.argv.includes('--help')) {
  console.info(`Staging-only HTTP load model: 500 visitors, 5 ranked replays, 5 minutes.
Requires a separate Node staging deployment and private TEST spreadsheet.
Never point it at the production table or an old public writer.

LOAD_TARGET_URL=https://your-staging-host.example
LOAD_CONFIRM=STAGING_ONLY
npm run test:load

Optional: LOAD_DURATION_SECONDS=300 (at least30), LOAD_VISITORS=500 (1..1000),
LOAD_RANKED=5 (1..5), LOAD_ALLOW_LOCAL=true (local smoke tests only).
Target /api/health must report environment=staging and rankedEnabled=true.
APP_ENV is an operator assertion, not proof that a spreadsheet is isolated.
The owner must verify APPS_SCRIPT_URL/SPREADSHEET_ID before running this test.

Visitors load the same-origin static game assets and poll scores every30s.
This models HTTP traffic, not500 simultaneous rendering browsers.
Ranked players send legal input every10s with a single request in flight.
Output includes checkpoint p95, failures and retries. Pass: p95<=5000ms,
no HTTP/protocol failures. Inspect Apps Script logs/quotas separately.`);
  process.exit(0);
}

function integer(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}.`);
  return value;
}
if (process.env.LOAD_CONFIRM !== 'STAGING_ONLY') throw new Error('Refusing writes: set LOAD_CONFIRM=STAGING_ONLY after checking the separate test spreadsheet.');
const target = new URL(process.env.LOAD_TARGET_URL || '');
const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
if ((target.protocol !== 'https:' && !(local && process.env.LOAD_ALLOW_LOCAL === 'true')) || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('Use an HTTPS staging origin, without credentials, path, query, or fragment.');
if (target.hostname === 'flappy-fish.ai.studio' || target.hostname === 'mariia-osipova.github.io') throw new Error('The known production origins are not load-test targets.');
const visitors = integer('LOAD_VISITORS', 500, 1, 1000);
const ranked = integer('LOAD_RANKED', 5, 1, 5);
const duration = integer('LOAD_DURATION_SECONDS', 300, 30, 3600) * 1000;
const stats = { httpRequests: 0, httpFailures: 0, checkpointLatencies: [], checkpoints: 0, completed: 0, retries: 0, failuresByCode: {}, visitorFailures: 0, rankedFailures: 0 };
let activeRequests = 0;
const waitingRequests = [];
async function acquireRequest() {
  if (activeRequests < 100) { activeRequests++; return; }
  await new Promise(resolve => waitingRequests.push(resolve));
}
function releaseRequest() {
  if (waitingRequests.length) waitingRequests.shift()();
  else activeRequests--;
}
let stopping = false;
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });

function failure(code) { stats.failuresByCode[code] = (stats.failuresByCode[code] || 0) + 1; }
async function request(path, { body, cookie, binary = false, headers = {} } = {}) {
  await acquireRequest();
  stats.httpRequests++;
  let response;
  try {
    response = await fetch(new URL(path, target), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    const data = binary ? await response.arrayBuffer() : await response.json();
    if (!response.ok) {
      const error = new Error('Request rejected');
      error.code = data?.error?.code || `http_${response.status}`;
      error.status = response.status;
      throw error;
    }
    return { data, response };
  } catch (error) {
    stats.httpFailures++;
    failure(error.code || 'network');
    throw error;
  } finally { releaseRequest(); }
}

const health = (await request('/api/health')).data;
if (health.environment !== 'staging' || !health.rankedEnabled || health.rulesVersion !== RULES_VERSION) throw new Error('Refusing writes: target must be a configured staging server running the same rules.');
console.info(JSON.stringify({ event: 'staging_load_started', visitors, ranked, durationSeconds: duration / 1000 }));

const assets = ['/', '/styles.css', '/app.js', '/name-filter.js', '/ranked-client.js', '/shared/game-core.js', '/shared/collision-data.js', '/assets/font/StrangeFont-Regular.otf',
  ...['fish1.png', 'alga2.png', 'pixil-frame-0.png', 'dead-fish.png', 'death2.png', 'death.png', 'img_1.png'].map(name => '/assets/img/' + name),
  ...Array.from({ length: 40 }, (_, index) => `/assets/img/fondo_animado/frame_${String(index).padStart(3, '0')}.png`)];
const finishAt = performance.now() + duration;
async function visitor(index) {
  // A ten-second ramp prevents the generator from opening25,000 sockets at once.
  await delay(index / Math.max(1, visitors) * 10000);
  try {
    for (const asset of assets) {
      if (stopping) return;
      await request(asset, { binary: true });
    }
    while (!stopping && performance.now() < finishAt) {
      await request(`/api/scores?name=load-visitor-${index}`);
      const remaining = finishAt - performance.now();
      if (remaining > 0) await delay(Math.min(30000, remaining));
    }
  } catch { stats.visitorFailures++; }
}

function nextInputs(snapshot) {
  const inputs = [];
  while (inputs.length < MAX_BLOCK_TICKS && !snapshot.dead) {
    const next = snapshot.pipes.find(pipe => pipe.x + 35 >= fishRect(snapshot.fish).left);
    const input = !snapshot.started || (snapshot.fish.y >= (next?.centerY ?? 300) + 70 && snapshot.fish.velocity > 0) ? 4 : 0;
    inputs.push(input);
    step(snapshot, input);
  }
  return inputs;
}

async function checkpoint(path, cookie, body) {
  const started = performance.now();
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data } = await request(path, { cookie, body });
      if (data.lastRequestId !== body.requestId || data.checkpoint.seq !== body.seq) throw new Error('Checkpoint receipt mismatch');
      stats.checkpointLatencies.push(performance.now() - started);
      stats.checkpoints++;
      return data;
    } catch (error) {
      lastError = error;
      if (error.status && error.status !== 429 && error.status !== 503) break;
      if (attempt < 2) { stats.retries++; await delay(5000); }
    }
  }
  throw lastError;
}

async function player(index) {
  let cookie;
  let receipt;
  try {
    cookie = (await request('/api/session', { body: {} })).response.headers.get('set-cookie').split(';')[0];
    while (!stopping && performance.now() < finishAt) {
      receipt = (await request('/api/games', { cookie, body: { name: `load-${index}-${randomUUID().slice(0, 8)}`, requestId: randomUUID() } })).data;
      let due = performance.now();
      while (!stopping && performance.now() < finishAt && receipt.status === 'active') {
        const inputs = nextInputs(structuredClone(receipt.checkpoint.snapshot));
        due += inputs.length / TICK_RATE * 1000;
        await delay(Math.max(0, due - performance.now()));
        receipt = await checkpoint(`/api/games/${receipt.gameId}/checkpoints`, cookie, {
          requestId: randomUUID(), checkpointToken: receipt.checkpointToken, seq: receipt.checkpoint.seq + 1,
          inputsBase64: Buffer.from(inputs).toString('base64'), pause: false,
        });
      }
      if (receipt.status === 'completed') stats.completed++;
      else break;
    }
  } catch { stats.rankedFailures++; }
  finally {
    // Leave a saved paused game; never delete test rows or manufacture a score.
    if (cookie && receipt && receipt.status !== 'completed') {
      try {
        const current = (await request(`/api/games/${receipt.gameId}`, { cookie })).data;
        if (current.status === 'active' && !current.leaseExpired) {
          await request(`/api/games/${receipt.gameId}/checkpoints`, { cookie, body: {
            requestId: randomUUID(), checkpointToken: current.checkpointToken, seq: current.checkpoint.seq + 1,
            inputsBase64: '', pause: true,
          } });
        }
      } catch { failure('cleanup_unconfirmed'); }
    }
  }
}

await Promise.allSettled([
  ...Array.from({ length: visitors }, (_, index) => visitor(index)),
  ...Array.from({ length: ranked }, (_, index) => player(index)),
]);
const sorted = stats.checkpointLatencies.slice().sort((left, right) => left - right);
const p95 = sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null;
const passed = !stopping && p95 !== null && p95 <= 5000 && stats.httpFailures === 0 && stats.visitorFailures === 0 && stats.rankedFailures === 0;
const { checkpointLatencies, ...summary } = stats;
console.info(JSON.stringify({ event: 'staging_load_result', ...summary, checkpointP95Ms: p95 === null ? null : Math.round(p95), passed, quotaInspectionRequired: true }));
if (!passed) process.exitCode = 1;
