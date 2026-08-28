import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { ApiError, assert } from './errors.js';

export const COOKIE_NAME = '__Host-flappy_session';
export const MAX_SNAPSHOT_BYTES = 4096;
const SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  throw new ApiError(400, 'invalid_input', 'Недопустимое JSON-значение.');
}

export function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function mac(key, domain, data) {
  return createHmac('sha256', key).update(domain + '\n' + data).digest('base64url');
}

export function signToken(payload, key, domain) {
  const json = canonicalJson(payload);
  assert(Buffer.byteLength(json) <= MAX_SNAPSHOT_BYTES, 503, 'snapshot_too_large', 'Состояние партии превышает допустимый размер.');
  const data = Buffer.from(json).toString('base64url');
  return data + '.' + mac(key, domain, data);
}

export function verifyToken(token, key, domain) {
  assert(typeof token === 'string' && token.length <= Math.ceil(MAX_SNAPSHOT_BYTES * 4 / 3) + 45, 400, 'invalid_token', 'Некорректный токен.');
  const parts = token.split('.');
  assert(parts.length === 2 && /^[A-Za-z0-9_-]+$/.test(parts[0]) && /^[A-Za-z0-9_-]{43}$/.test(parts[1]), 401, 'invalid_signature', 'Подпись не прошла проверку.');
  const expected = Buffer.from(mac(key, domain, parts[0]));
  const actual = Buffer.from(parts[1]);
  assert(actual.length === expected.length && timingSafeEqual(actual, expected), 401, 'invalid_signature', 'Подпись не прошла проверку.');
  const bytes = Buffer.from(parts[0], 'base64url');
  assert(bytes.length <= MAX_SNAPSHOT_BYTES && bytes.toString('base64url') === parts[0], 400, 'invalid_token', 'Некорректный токен.');
  try {
    const payload = JSON.parse(bytes.toString('utf8'));
    assert(payload && typeof payload === 'object' && !Array.isArray(payload), 400, 'invalid_token', 'Некорректный токен.');
    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_token', 'Некорректный токен.');
  }
}

export function cookieValue(req) {
  const values = (req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(COOKIE_NAME + '='));
  return values.length === 1 ? values[0].slice(COOKIE_NAME.length + 1) : null;
}

export function readSession(req, key, now = Date.now()) {
  const token = cookieValue(req);
  assert(token, 401, 'session_required', 'Нужно открыть анонимную сессию.');
  const payload = verifyToken(token, key, 'flappy-fish-session-v1');
  assert(payload.v === 1 && typeof payload.id === 'string' && /^[0-9a-f-]{36}$/.test(payload.id) && Number.isSafeInteger(payload.exp) && payload.exp > now, 401, 'session_expired', 'Анонимная сессия истекла.');
  return payload.id;
}

export function issueSession(req, res, key, now = Date.now()) {
  let id;
  try { id = readSession(req, key, now); } catch { id = randomUUID(); }
  const token = signToken({ v: 1, id, exp: now + SESSION_AGE_MS }, key, 'flappy-fish-session-v1');
  res.cookie(COOKIE_NAME, token, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: SESSION_AGE_MS });
  return id;
}

export function normalizeName(value) {
  assert(typeof value === 'string', 400, 'invalid_name', 'Укажите ник.');
  const name = value.trim().replace(/\s+/g, ' ').slice(0, 24);
  assert(name.length > 0 && !/[\u0000-\u001f\u007f]/.test(name), 400, 'invalid_name', 'Некорректный ник.');
  return { name, rankKey: name.toLowerCase() };
}

export function validateRequestId(value) {
  assert(typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value), 400, 'invalid_request_id', 'Некорректный идентификатор запроса.');
  return value;
}

export function exactBody(body, allowed, required = allowed) {
  assert(body && typeof body === 'object' && !Array.isArray(body), 400, 'invalid_input', 'Ожидался JSON-объект.');
  assert(Object.keys(body).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(body, key)), 400, 'invalid_input', 'Недопустимые поля запроса.');
}

export function decodeInputs(value, pause) {
  assert(typeof value === 'string' && value.length <= 1600 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), 400, 'invalid_input', 'Некорректный блок действий.');
  const input = Buffer.from(value, 'base64');
  assert(input.toString('base64') === value && input.length <= 1200 && (input.length > 0 || pause), 400, 'invalid_input', 'Допустим блок от 1 до 1200 шагов; пустой блок возможен только при паузе.');
  assert(input.every(byte => (byte & ~7) === 0), 400, 'invalid_input', 'Недопустимые действия.');
  return input;
}

export function checkpointClaims(record) {
  return {
    v: 1, gameId: record.gameId, ownerId: record.ownerId, rulesVersion: record.rulesVersion,
    seed: record.seed, seq: record.seq, stateHash: record.stateHash,
    leaseEpoch: record.leaseEpoch, snapshot: record.snapshot,
  };
}

export function makeReceipt(record, key) {
  const claims = checkpointClaims(record);
  return {
    gameId: record.gameId, name: record.name, rulesVersion: record.rulesVersion,
    checkpointToken: signToken(claims, key, 'flappy-fish-checkpoint-v1'),
    checkpoint: { snapshot: record.snapshot, seq: record.seq, stateHash: record.stateHash, leaseEpoch: record.leaseEpoch },
    status: record.status, leaseUntil: record.leaseUntil,
    lastRequestId: record.lastRequestId, lastAction: record.lastAction,
    ...(record.status === 'completed' ? { finalScore: record.snapshot.score, verified: true } : {}),
  };
}

export function readCheckpoint(token, key, ownerId, gameId, rulesVersion) {
  const claims = verifyToken(token, key, 'flappy-fish-checkpoint-v1');
  assert(claims.v === 1 && claims.ownerId === ownerId && claims.gameId === gameId, 403, 'forbidden', 'Эта партия принадлежит другой сессии.');
  assert(claims.rulesVersion === rulesVersion, 409, 'rules_changed', 'Версия правил изменилась. Сохранённая партия не может быть продолжена этим сервером.');
  assert(Number.isSafeInteger(claims.seq) && claims.seq >= 0 && Number.isSafeInteger(claims.leaseEpoch) && claims.leaseEpoch >= 1 && claims.snapshot && claims.seed === claims.snapshot.seed && claims.stateHash === digest(claims.snapshot), 400, 'invalid_token', 'Состояние партии не прошло проверку.');
  return claims;
}
