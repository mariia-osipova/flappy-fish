import { assertValidSnapshot } from '../../shared/game-core.js';
import { ApiError, unavailable } from '../errors.js';
import { createPostgresPool } from '../db/pool.js';
import { digest, MAX_SNAPSHOT_BYTES, normalizeName, validateRequestId } from '../security.js';
import {
  ADMISSION_LOCK_KEY, CLOCK_TOLERANCE_MS, CREATION_WINDOW_MS, LEASE_MS,
  MAX_CHECKPOINT_TICKS, MAX_CREATIONS_PER_OWNER, MAX_LEADERBOARD_ENTRIES, TICK_RATE,
} from './constants.js';
import { bigintToSafeInteger, rowToGameRecord } from './record-mapper.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;

function invalid(message = 'Некорректные данные хранилища.') {
  return new ApiError(400, 'invalid_input', message);
}

function requireUuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid();
  return value;
}

function requireHash(value) {
  if (typeof value !== 'string' || !HASH.test(value)) throw invalid();
  return value;
}

function requireText(value, maximum) {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\r\n]/.test(value)) throw invalid();
  return value;
}

function validateSnapshot(snapshot, stateHash) {
  try {
    assertValidSnapshot(snapshot);
    if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES || digest(snapshot) !== stateHash) throw invalid();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalid('Некорректное состояние партии.');
  }
}

function activeCredit(game, nowMs) {
  return game.status === 'active' && Number.isSafeInteger(game.activeSince)
    ? Math.max(0, Math.min(nowMs, game.leaseUntil) - game.activeSince) : 0;
}

function duplicateResult(game, action, requestId, requestHash) {
  if (game.lastRequestId !== requestId) return false;
  if (game.lastRequestHash !== requestHash || game.lastAction !== action) {
    throw new ApiError(409, 'conflict', 'Идентификатор запроса уже использован с другим содержимым.');
  }
  return true;
}

function requirePrevious(game, payload) {
  if (!Number.isSafeInteger(payload.prevSeq) || !Number.isSafeInteger(payload.leaseEpoch) ||
      payload.prevSeq !== game.seq || payload.prevStateHash !== game.stateHash ||
      payload.leaseEpoch !== game.leaseEpoch) {
    throw new ApiError(409, 'conflict', 'Сохранённая партия изменилась; загрузите её заново.');
  }
}

export class PostgresStore {
  constructor({ config = {}, pool, clock, maxRankedGames = config.maxRankedGames ?? 5 } = {}) {
    this.pool = pool || createPostgresPool(config);
    this.clock = clock;
    this.maxRankedGames = maxRankedGames;
    this.closed = false;
    if (!Number.isSafeInteger(this.maxRankedGames) || this.maxRankedGames < 1 || this.maxRankedGames > 30) {
      throw new Error('Invalid PostgreSQL ranked capacity.');
    }
  }

  async call(action, payload, requestId) {
    try {
      switch (action) {
        case 'begin': return await this.begin(payload, requestId);
        case 'read': return await this.read(payload);
        case 'checkpoint': return await this.checkpoint(payload, requestId);
        case 'resume': return await this.resume(payload, requestId);
        case 'scores': return await this.scores(payload);
        default: throw invalid('Неизвестная операция хранилища.');
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw unavailable();
    }
  }

  async transaction(operation) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async nowMs(client) {
    if (this.clock) {
      const value = await this.clock();
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid injected PostgreSQL clock.');
      return value;
    }
    const result = await client.query("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms");
    return bigintToSafeInteger(result.rows[0]?.now_ms, 'nowMs');
  }

  async lockAdmission(client) {
    const result = await client.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS locked', [ADMISSION_LOCK_KEY]);
    if (result.rows[0]?.locked !== true) throw unavailable();
  }

  async capacity(client, ownerId, exceptGameId, nowMs) {
    const result = await client.query(`
      SELECT game_id, owner_id
      FROM games
      WHERE status = 'active' AND lease_until_ms > $1
        AND ($2::uuid IS NULL OR game_id <> $2::uuid)
    `, [nowMs, exceptGameId]);
    const owned = result.rows.find(row => row.owner_id === ownerId);
    if (owned) {
      throw new ApiError(409, 'active_game_exists', 'У этой сессии уже есть активная рейтинговая партия.', { gameId: owned.game_id });
    }
    if (result.rows.length >= this.maxRankedGames) {
      throw new ApiError(503, 'ranked_full', 'Все рейтинговые места заняты; тренировка остаётся доступной.');
    }
  }

  async begin(payload, requestId) {
    requireUuid(payload?.ownerId);
    validateRequestId(requestId);
    requireHash(payload.requestHash);
    return this.transaction(async client => {
      await this.lockAdmission(client);
      const duplicate = await client.query(`
        SELECT * FROM games
        WHERE owner_id = $1 AND begin_request_id = $2
      `, [payload.ownerId, requestId]);
      if (duplicate.rowCount) {
        const game = rowToGameRecord(duplicate.rows[0]);
        if (game.beginRequestHash !== payload.requestHash) {
          throw new ApiError(409, 'conflict', 'Идентификатор начала уже использован с другим содержимым.');
        }
        return game;
      }

      requireUuid(payload.gameId);
      requireText(payload.rulesVersion, 120);
      requireHash(payload.stateHash);
      const normalized = normalizeName(payload.name);
      if (normalized.name !== payload.name || normalized.rankKey !== payload.rankKey) throw invalid('Некорректная нормализация ника.');
      if (!Number.isSafeInteger(payload.seed) || payload.seed < 0 || payload.seed > 0xffffffff) throw invalid('Некорректный seed партии.');
      validateSnapshot(payload.snapshot, payload.stateHash);
      if (payload.snapshot.seed !== payload.seed || payload.snapshot.tick !== 0 ||
          payload.snapshot.score !== 0 || payload.snapshot.dead) throw invalid('Некорректное начальное состояние партии.');

      const nowMs = await this.nowMs(client);
      await this.capacity(client, payload.ownerId, null, nowMs);
      const recent = await client.query(`
        SELECT count(*)::bigint AS count
        FROM games
        WHERE owner_id = $1 AND created_at_ms > $2
      `, [payload.ownerId, nowMs - CREATION_WINDOW_MS]);
      if (bigintToSafeInteger(recent.rows[0]?.count, 'creationCount') >= MAX_CREATIONS_PER_OWNER) {
        throw new ApiError(429, 'rate_limited', 'Слишком много рейтинговых партий; повторите позже.');
      }
      const collision = await client.query('SELECT 1 FROM games WHERE game_id = $1', [payload.gameId]);
      if (collision.rowCount) throw new ApiError(409, 'conflict', 'Идентификатор партии уже существует.');

      try {
        const inserted = await client.query(`
          INSERT INTO games (
            game_id, owner_id, name, rank_key, begin_request_id, begin_request_hash,
            rules_version, seed, snapshot, seq, state_hash, status, lease_epoch,
            lease_until_ms, created_at_ms, updated_at_ms, last_request_id,
            last_request_hash, last_action, elapsed_active_ms, active_since_ms, final_score
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 0, $10, 'active', 1,
            $11, $12, $12, $5, $6, 'begin', 0, $12, NULL
          ) RETURNING *
        `, [
          payload.gameId, payload.ownerId, payload.name, payload.rankKey, requestId,
          payload.requestHash, payload.rulesVersion, payload.seed, JSON.stringify(payload.snapshot),
          payload.stateHash, nowMs + LEASE_MS, nowMs,
        ]);
        return rowToGameRecord(inserted.rows[0]);
      } catch (error) {
        if (error?.code === '23505') throw new ApiError(409, 'conflict', 'Рейтинговая партия уже существует.');
        throw error;
      }
    });
  }

  async read(payload) {
    requireUuid(payload?.ownerId);
    requireUuid(payload?.gameId);
    const result = await this.pool.query('SELECT * FROM games WHERE game_id = $1', [payload.gameId]);
    if (!result.rowCount) throw new ApiError(404, 'not_found', 'Рейтинговая партия не найдена.');
    const game = rowToGameRecord(result.rows[0]);
    if (game.ownerId !== payload.ownerId) throw new ApiError(403, 'forbidden', 'Эта партия принадлежит другой сессии.');
    return game;
  }

  async checkpoint(payload, requestId) {
    requireUuid(payload?.ownerId);
    requireUuid(payload?.gameId);
    validateRequestId(requestId);
    requireHash(payload.requestHash);
    return this.transaction(async client => {
      const selected = await client.query('SELECT * FROM games WHERE game_id = $1 FOR UPDATE', [payload.gameId]);
      if (!selected.rowCount) throw new ApiError(404, 'not_found', 'Рейтинговая партия не найдена.');
      const game = rowToGameRecord(selected.rows[0]);
      if (game.ownerId !== payload.ownerId) throw new ApiError(403, 'forbidden', 'Эта партия принадлежит другой сессии.');
      if (duplicateResult(game, 'checkpoint', requestId, payload.requestHash)) return game;
      requirePrevious(game, payload);
      if (game.status === 'completed') throw new ApiError(409, 'conflict', 'Партия уже завершена.');
      const nowMs = await this.nowMs(client);
      if (game.status !== 'active' || nowMs >= game.leaseUntil) {
        throw new ApiError(409, 'lease_expired', 'Возобновите рейтинговую партию перед checkpoint.');
      }

      requireHash(payload.stateHash);
      validateSnapshot(payload.snapshot, payload.stateHash);
      if (!Number.isSafeInteger(payload.inputTicks) || payload.inputTicks < 0 ||
          payload.inputTicks > MAX_CHECKPOINT_TICKS || typeof payload.pause !== 'boolean' ||
          payload.snapshot.tick !== game.snapshot.tick + payload.inputTicks ||
          payload.snapshot.score < game.snapshot.score) throw invalid('Некорректное продвижение checkpoint.');
      if (payload.inputTicks === 0 && payload.stateHash !== game.stateHash) {
        throw invalid('Checkpoint без тиков не может изменить симуляцию.');
      }
      const credit = activeCredit(game, nowMs);
      if (payload.snapshot.tick * 1000 / TICK_RATE > game.elapsedActiveMs + credit + CLOCK_TOLERANCE_MS) {
        throw new ApiError(409, 'too_fast', 'Replay опережает серверное время.');
      }

      const terminal = payload.snapshot.dead || payload.pause;
      const status = payload.snapshot.dead ? 'completed' : payload.pause ? 'paused' : 'active';
      const elapsedActiveMs = terminal ? game.elapsedActiveMs + credit : game.elapsedActiveMs;
      const activeSince = terminal ? null : game.activeSince;
      const leaseUntil = terminal ? nowMs : payload.inputTicks > 0 ? nowMs + LEASE_MS : game.leaseUntil;
      const finalScore = payload.snapshot.dead ? payload.snapshot.score : null;
      const updated = await client.query(`
        UPDATE games SET
          snapshot = $2::jsonb, seq = $3, state_hash = $4, status = $5,
          lease_until_ms = $6, updated_at_ms = $7, last_request_id = $8,
          last_request_hash = $9, last_action = 'checkpoint', elapsed_active_ms = $10,
          active_since_ms = $11, final_score = $12
        WHERE game_id = $1
        RETURNING *
      `, [
        game.gameId, JSON.stringify(payload.snapshot), game.seq + 1, payload.stateHash,
        status, leaseUntil, nowMs, requestId, payload.requestHash, elapsedActiveMs,
        activeSince, finalScore,
      ]);
      return rowToGameRecord(updated.rows[0]);
    });
  }

  async resume(payload, requestId) {
    requireUuid(payload?.ownerId);
    requireUuid(payload?.gameId);
    validateRequestId(requestId);
    requireHash(payload.requestHash);
    return this.transaction(async client => {
      await this.lockAdmission(client);
      const selected = await client.query('SELECT * FROM games WHERE game_id = $1 FOR UPDATE', [payload.gameId]);
      if (!selected.rowCount) throw new ApiError(404, 'not_found', 'Рейтинговая партия не найдена.');
      const game = rowToGameRecord(selected.rows[0]);
      if (game.ownerId !== payload.ownerId) throw new ApiError(403, 'forbidden', 'Эта партия принадлежит другой сессии.');
      if (duplicateResult(game, 'resume', requestId, payload.requestHash)) return game;
      requirePrevious(game, payload);
      const nowMs = await this.nowMs(client);
      if (game.status === 'completed') throw new ApiError(409, 'conflict', 'Партия уже завершена.');
      if (game.status === 'active' && game.leaseUntil > nowMs) {
        throw new ApiError(409, 'conflict', 'Рейтинговая партия уже активна.');
      }
      await this.capacity(client, game.ownerId, game.gameId, nowMs);
      const updated = await client.query(`
        UPDATE games SET
          status = 'active', lease_epoch = $2, lease_until_ms = $3,
          updated_at_ms = $4, last_request_id = $5, last_request_hash = $6,
          last_action = 'resume', elapsed_active_ms = $7, active_since_ms = $4
        WHERE game_id = $1
        RETURNING *
      `, [
        game.gameId, game.leaseEpoch + 1, nowMs + LEASE_MS, nowMs, requestId,
        payload.requestHash, game.elapsedActiveMs + activeCredit(game, nowMs),
      ]);
      return rowToGameRecord(updated.rows[0]);
    });
  }

  async scores(payload = {}) {
    if (payload.includeIndex !== undefined && typeof payload.includeIndex !== 'boolean') throw invalid();
    const requestedRankKey = payload.name === undefined ? null : normalizeName(payload.name).rankKey;
    return this.transaction(async client => {
      const nowMs = await this.nowMs(client);
      const result = await client.query(`
        WITH candidates AS (
          SELECT name, rank_key, best_score, false AS verified,
                 updated_at_ms, 'legacy'::text AS source
          FROM legacy_scores
          UNION ALL
          SELECT name, rank_key, final_score AS best_score, true AS verified,
                 updated_at_ms, 'verified'::text AS source
          FROM games
          WHERE status = 'completed'
        ), winners AS (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY rank_key
            ORDER BY best_score DESC, verified DESC, updated_at_ms DESC NULLS LAST, name COLLATE "C" ASC
          ) AS candidate_rank
          FROM candidates
        )
        SELECT name, rank_key, best_score, verified, updated_at_ms, source
        FROM winners
        WHERE candidate_rank = 1
        LIMIT $1
      `, [MAX_LEADERBOARD_ENTRIES + 1]);
      if (result.rows.length > MAX_LEADERBOARD_ENTRIES) throw unavailable();

      let player = null;
      const ranked = result.rows.map(row => {
        const bestScore = bigintToSafeInteger(row.best_score, 'bestScore');
        const updatedMs = row.updated_at_ms === null ? null : bigintToSafeInteger(row.updated_at_ms, 'scoreUpdatedAt');
        let updatedAt = null;
        if (updatedMs !== null) {
          updatedAt = new Date(updatedMs).toISOString();
        }
        return {
          rankKey: row.rank_key,
          name: row.name,
          bestScore,
          source: row.source,
          verified: row.verified,
          updatedAt,
        };
      }).sort((left, right) => right.bestScore - left.bestScore ||
        (left.rankKey < right.rankKey ? -1 : left.rankKey > right.rankKey ? 1 : 0));
      const index = ranked.map((candidate, position) => {
        const { rankKey, ...entry } = candidate;
        entry.rank = position + 1;
        if (requestedRankKey !== null && rankKey === requestedRankKey) player = entry;
        return entry;
      });
      return {
        scores: index.slice(0, 100),
        player,
        ...(payload.includeIndex === true ? { index } : {}),
        updatedAt: new Date(nowMs).toISOString(),
      };
    });
  }

  async ping() {
    try {
      const result = await this.pool.query(`
        SELECT 1 AS ok,
               to_regclass('public.games')::text AS games,
               to_regclass('public.legacy_scores')::text AS legacy_scores
      `);
      if (result.rows[0]?.ok !== 1 || result.rows[0]?.games !== 'games' || result.rows[0]?.legacy_scores !== 'legacy_scores') {
        throw unavailable();
      }
      return true;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw unavailable();
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}
