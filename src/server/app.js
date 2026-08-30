import express from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { assertValidSnapshot, createInitialState, RULES_VERSION } from '../shared/game-core.js';
import { ApiError, assert, unavailable } from './errors.js';
import { loadConfig } from './config.js';
import { AppsScriptGateway } from './gateway.js';
import { ReplayVerifier } from './verifier.js';
import { RateLimiter } from './rate-limit.js';
import {
  canonicalJson, decodeInputs, digest, exactBody, issueSession, makeReceipt,
  MAX_SNAPSHOT_BYTES, normalizeName, readCheckpoint, readSession, validateRequestId,
} from './security.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const indexPath = path.join(root, 'src/web/index.html');
const indexHtml = readFileSync(indexPath, 'utf8');
const disabledIndexHtml = indexHtml.replace('<head>', '<head>\n    <meta name="flappy-fish-ranked" content="disabled">');
const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

// Server-Timing is intentionally limited to fixed metric names and numeric
// durations. This makes production latency visible in same-origin DevTools
// without reflecting game ids, nicknames, tokens, URLs, or upstream errors.
const SERVER_TIMING_METRICS = new Set(['gateway', 'verify']);
function appendServerTiming(res, metric, durationMs) {
  if (res.headersSent || !SERVER_TIMING_METRICS.has(metric) || !Number.isFinite(durationMs)) return;
  res.append('Server-Timing', `${metric};dur=${Math.max(0, durationMs).toFixed(1)}`);
}
async function timedStage(res, metric, operation) {
  const started = performance.now();
  try { return await operation(); }
  finally { appendServerTiming(res, metric, performance.now() - started); }
}

export function createApp({ config = loadConfig(), store, verifier, now = Date.now, logger = console } = {}) {
  const app = express();
  app.disable('x-powered-by');
  const ready = config.configured && Boolean(config.sessionKey && config.stateKey);
  const rankedAvailable = ready && config.rankedEnabled;
  const gateway = store || (ready ? new AppsScriptGateway({ url: config.gatewayUrl, key: config.gatewayKey, now, timeoutMs: config.gatewayTimeoutMs }) : null);
  let replayVerifier = verifier;
  const limiter = new RateLimiter({ now });
  let leaderboard = null;
  let pendingScores = null;

  const needsStorage = () => { if (!ready || !gateway) throw new ApiError(503, 'ranked_disabled', 'Рейтинг ещё не настроен. Доступна тренировка без рейтинга.'); };
  const needsRanked = () => {
    needsStorage();
    if (!config.rankedEnabled) throw new ApiError(503, 'ranked_disabled', 'Рейтинг временно выключен. Доступна тренировка без рейтинга.');
  };
  const owner = req => { needsStorage(); return readSession(req, config.sessionKey, now()); };
  const gameId = req => {
    assert(/^[0-9a-f-]{36}$/.test(req.params.id), 400, 'invalid_game_id', 'Некорректный идентификатор партии.');
    return req.params.id;
  };

  function durableReceipt(record, ownerId, id) {
    // A malformed upstream response must never become a freshly signed checkpoint.
    try {
      if (!record || record.ownerId !== ownerId || (id && record.gameId !== id) || !/^[0-9a-f-]{36}$/.test(record.gameId)) throw unavailable();
      assertValidSnapshot(record.snapshot);
      const normalized = normalizeName(record.name);
      if (record.name !== normalized.name || record.rankKey !== normalized.rankKey || record.seed !== record.snapshot.seed || record.stateHash !== digest(record.snapshot)) throw unavailable();
      if (!Number.isSafeInteger(record.seq) || record.seq < 0 || !Number.isSafeInteger(record.leaseEpoch) || record.leaseEpoch < 1 || !['active', 'paused', 'completed'].includes(record.status)) throw unavailable();
      for (const field of ['createdAt', 'updatedAt', 'leaseUntil']) if (!Number.isSafeInteger(record[field]) || record[field] < 0) throw unavailable();
      if (record.updatedAt < record.createdAt || !Number.isFinite(record.elapsedActiveMs) || record.elapsedActiveMs < 0) throw unavailable();
      if (record.status === 'active' && (!Number.isSafeInteger(record.activeSince) || record.activeSince < record.createdAt || record.activeSince > record.updatedAt || record.leaseUntil < record.updatedAt)) throw unavailable();
      if ((record.status === 'completed') !== record.snapshot.dead || (record.status === 'completed' && record.finalScore !== record.snapshot.score)) throw unavailable();
      if (!['begin', 'checkpoint', 'resume'].includes(record.lastAction)) throw unavailable();
      validateRequestId(record.lastRequestId);
    } catch { throw unavailable(); }
    if (record.rulesVersion !== RULES_VERSION) throw new ApiError(409, 'rules_changed', 'Версия сохранённой партии не поддерживается этим сервером.');
    return { ...makeReceipt(record, config.stateKey), leaseExpired: record.status === 'active' && record.leaseUntil <= now() };
  }

  function scoreIndex(data) {
    const validDate = value => typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value));
    try {
      if (!data || !Array.isArray(data.index) || data.index.length > 100000 || !validDate(data.updatedAt)) throw unavailable();
      const index = new Map();
      let previous = null;
      for (const [position, entry] of data.index.entries()) {
        const { name, rankKey } = normalizeName(entry?.name);
        if (name !== entry.name || index.has(rankKey) || !Number.isSafeInteger(entry.bestScore) || entry.bestScore < 0 || entry.rank !== position + 1) throw unavailable();
        if (!['verified', 'legacy'].includes(entry.source) || entry.verified !== (entry.source === 'verified') || !(validDate(entry.updatedAt) || (entry.source === 'legacy' && entry.updatedAt === null))) throw unavailable();
        if (previous && (previous.bestScore < entry.bestScore || (previous.bestScore === entry.bestScore && previous.rankKey >= rankKey))) throw unavailable();
        // Explicit projection prevents storage-only fields escaping through either
        // the top100 or the searched player, even after upstream schema changes.
        index.set(rankKey, { name, bestScore: entry.bestScore, source: entry.source, verified: entry.verified, updatedAt: entry.updatedAt, rank: entry.rank });
        previous = { bestScore: entry.bestScore, rankKey };
      }
      return index;
    } catch { throw unavailable(); }
  }

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', (req, res, next) => {
    if (req.method === 'POST') {
      if (req.get('sec-fetch-site') === 'cross-site') return next(new ApiError(403, 'cross_site_request', 'Запрос с другого сайта отклонён.'));
      if (!req.is('application/json')) return next(new ApiError(415, 'json_required', 'Нужен Content-Type: application/json.'));
    }
    next();
  });
  app.use('/api', express.json({ limit: '8kb', strict: true, inflate: false }));
  app.use('/api', (req, res, next) => {
    const started = performance.now();
    res.on('finish', () => {
      // Low-cardinality fields only: never log names, ids, bodies, URLs, or tokens.
      if (req.method === 'POST' || res.statusCode >= 400) logger.info?.(JSON.stringify({ event: 'api_request', operation: req.route?.path || 'unmatched', status: res.statusCode, durationMs: Math.round(performance.now() - started), error: res.locals.errorCode || null }));
    });
    next();
  });

  app.get('/api/health', (req, res) => res.json({ status: 'ok', environment: config.environment, rankedEnabled: Boolean(ready && config.rankedEnabled), rulesVersion: RULES_VERSION }));

  app.post('/api/session', asyncRoute(async (req, res) => {
    needsStorage();
    exactBody(req.body || {}, [], []);
    limiter.take('session:global', 600, 60000);
    issueSession(req, res, config.sessionKey, now());
    res.json({ ok: true });
  }));

  app.post('/api/games', asyncRoute(async (req, res) => {
    needsRanked();
    const ownerId = owner(req);
    exactBody(req.body, ['name', 'requestId']);
    const requestId = validateRequestId(req.body.requestId);
    const { name, rankKey } = normalizeName(req.body.name);
    limiter.take('begin:' + ownerId, 6, 60000);
    limiter.take('begin:global', 60, 60000);
    const seed = randomBytes(4).readUInt32LE();
    const snapshot = createInitialState(seed);
    const payload = {
      ownerId, name, rankKey, gameId: randomUUID(), seed, rulesVersion: RULES_VERSION,
      snapshot, stateHash: digest(snapshot), requestHash: digest({ action: 'begin', ownerId, name, rankKey }),
    };
    const record = await timedStage(res, 'gateway', () => gateway.call('begin', payload, requestId));
    res.json(durableReceipt(record, ownerId));
  }));

  app.get('/api/games/:id', asyncRoute(async (req, res) => {
    const ownerId = owner(req);
    limiter.take('read:' + ownerId, 30, 60000);
    const id = gameId(req);
    const record = await timedStage(res, 'gateway', () => gateway.call('read', { ownerId, gameId: id }));
    res.json(durableReceipt(record, ownerId, id));
  }));

  app.post('/api/games/:id/checkpoints', asyncRoute(async (req, res) => {
    needsRanked();
    const ownerId = owner(req);
    const id = gameId(req);
    exactBody(req.body, ['requestId', 'checkpointToken', 'seq', 'inputsBase64', 'pause'], ['requestId', 'checkpointToken', 'seq', 'inputsBase64']);
    const requestId = validateRequestId(req.body.requestId);
    assert(req.body.pause === undefined || typeof req.body.pause === 'boolean', 400, 'invalid_input', 'Некорректный признак паузы.');
    const pause = req.body.pause === true;
    const input = decodeInputs(req.body.inputsBase64, pause);
    const claims = readCheckpoint(req.body.checkpointToken, config.stateKey, ownerId, id, RULES_VERSION);
    assert(Number.isSafeInteger(req.body.seq) && req.body.seq === claims.seq + 1, 409, 'conflict', 'Неверный номер блока. Восстановите подтверждённое состояние.');
    assert(!claims.snapshot.dead, 409, 'game_completed', 'Партия уже завершена.');
    limiter.take('checkpoint:' + ownerId, 60, 60000);
    limiter.take('checkpoint:global', 600, 60000);
    replayVerifier ||= new ReplayVerifier({ workers: config.verifierWorkers, queueLimit: config.verifierQueue, budgetMs: config.verifierBudgetMs });
    const snapshot = await timedStage(res, 'verify', () => input.length ? replayVerifier.verify(claims.snapshot, input) : structuredClone(claims.snapshot));
    assert(Buffer.byteLength(canonicalJson(snapshot)) <= MAX_SNAPSHOT_BYTES, 503, 'snapshot_too_large', 'Состояние партии превышает допустимый размер.');
    const payload = {
      ownerId, gameId: id, prevSeq: claims.seq, prevStateHash: claims.stateHash, leaseEpoch: claims.leaseEpoch,
      snapshot, stateHash: digest(snapshot), inputTicks: input.length, pause,
      requestHash: digest({ action: 'checkpoint', gameId: id, ownerId, seq: req.body.seq, prevStateHash: claims.stateHash, leaseEpoch: claims.leaseEpoch, inputsBase64: req.body.inputsBase64, pause }),
    };
    const record = await timedStage(res, 'gateway', () => gateway.call('checkpoint', payload, requestId));
    res.json(durableReceipt(record, ownerId, id));
  }));

  app.post('/api/games/:id/resume', asyncRoute(async (req, res) => {
    needsRanked();
    const ownerId = owner(req);
    const id = gameId(req);
    exactBody(req.body, ['requestId', 'checkpointToken']);
    const requestId = validateRequestId(req.body.requestId);
    const claims = readCheckpoint(req.body.checkpointToken, config.stateKey, ownerId, id, RULES_VERSION);
    limiter.take('resume:' + ownerId, 20, 60000);
    const payload = { ownerId, gameId: id, prevSeq: claims.seq, prevStateHash: claims.stateHash, leaseEpoch: claims.leaseEpoch };
    payload.requestHash = digest({ action: 'resume', ...payload });
    const record = await timedStage(res, 'gateway', () => gateway.call('resume', payload, requestId));
    res.json(durableReceipt(record, ownerId, id));
  }));

  app.get('/api/scores', asyncRoute(async (req, res) => {
    needsStorage();
    assert(Object.keys(req.query).every(key => key === 'name'), 400, 'invalid_query', 'Поддерживается только поиск по нику.');
    const name = req.query.name === undefined ? '' : normalizeName(req.query.name).rankKey;
    limiter.take('scores:global', 2400, 60000);
    if (!leaderboard || leaderboard.until <= now()) {
      if (!pendingScores) {
        limiter.take('scores:misses', 30, 60000);
        pendingScores = gateway.call('scores', { includeIndex: true }).then(data => {
          const index = scoreIndex(data);
          leaderboard = { until: now() + 30000, scores: Array.from(index.values()).slice(0, 100), updatedAt: data.updatedAt, index };
        }).finally(() => { pendingScores = null; });
      }
      await timedStage(res, 'gateway', () => pendingScores);
    }
    // The full nickname index stays server-side; public responses contain top100
    // plus at most one searched player, independent of visitor count.
    res.json({ scores: leaderboard.scores, player: name ? leaderboard.index.get(name) || null : null, updatedAt: leaderboard.updatedAt });
  }));

  app.post('/api/scores', (req, res) => res.status(410).json({ error: { code: 'raw_scores_disabled', message: 'Прямая запись очков отключена. Используйте проверяемую партию.' } }));
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'API не найден.' } }));

  // Establish the anonymous identity on the document response. The ranked
  // client can then create a game with one request instead of waiting for a
  // separate session round-trip after the player presses Start. Unconfigured
  // servers mark the same shell as practice-only without making the browser
  // discover that state through another hosted request.
  const sendAppShell = (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (rankedAvailable) issueSession(req, res, config.sessionKey, now());
    res.type('html').send(rankedAvailable ? indexHtml : disabledIndexHtml);
  };
  app.get(['/', '/index.html'], sendAppShell);

  app.get('/favicon.ico', (req, res) => res.type('png').sendFile(path.join(root, 'src/web/favicon.png')));
  app.use('/assets', express.static(path.join(root, 'data'), { dotfiles: 'deny' }));
  app.use('/shared', express.static(path.join(root, 'src/shared'), { dotfiles: 'deny', fallthrough: false }));
  app.use(express.static(path.join(root, 'src/web'), { dotfiles: 'deny' }));
  app.get('*', (req, res) => {
    if (path.extname(req.path) || req.path.split('/').some(segment => segment.startsWith('.'))) return res.sendStatus(404);
    sendAppShell(req, res);
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error instanceof ApiError ? error.status : error.status === 404 ? 404 : error.status === 413 ? 413 : error.type === 'entity.parse.failed' ? 400 : error.status === 415 ? 415 : 500;
    const code = error instanceof ApiError ? error.code : status === 413 ? 'body_too_large' : status === 400 ? 'invalid_json' : status === 404 ? 'not_found' : status === 415 ? 'unsupported_encoding' : 'internal_error';
    const message = error instanceof ApiError ? error.message : status === 413 ? 'Максимальный размер запроса — 8 KiB.' : status < 500 ? 'Некорректный запрос.' : 'Сервер временно недоступен.';
    res.locals.errorCode = code;
    if (status === 429 || status === 503) res.set('Retry-After', '5');
    res.status(status).json({ error: { code, message, ...(error instanceof ApiError && error.details ? { details: error.details } : {}) } });
  });
  app.locals.close = async () => { if (replayVerifier?.close) await replayVerifier.close(); };
  return app;
}
