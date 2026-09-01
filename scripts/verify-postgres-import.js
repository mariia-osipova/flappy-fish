#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { canonicalJson, digest } from '../src/server/security.js';
import {
  SafeMigrationError,
  buildImportReport,
  checksumSortedGameIds,
  databaseRowToGameShape,
  databaseRowToLegacyShape,
  validateGameRecord,
  validateLegacyRecord,
} from './import-sheets-export.js';

const GAME_QUERY = `
  SELECT game_id, owner_id, name, rank_key, begin_request_id, begin_request_hash,
         rules_version, seed, snapshot, seq, state_hash, status, lease_epoch,
         lease_until_ms, created_at_ms, updated_at_ms, last_request_id,
         last_request_hash, last_action, elapsed_active_ms, active_since_ms, final_score
  FROM games
`;
const LEGACY_QUERY = `
  SELECT rank_key, name, best_score, updated_at_ms, source_row
  FROM legacy_scores
`;
const SQL_TOP_100_QUERY = `
  WITH candidates AS (
    SELECT rank_key, name, best_score, false AS verified, updated_at_ms
    FROM legacy_scores
    UNION ALL
    SELECT rank_key, name, final_score AS best_score, true AS verified, updated_at_ms
    FROM games
    WHERE status = 'completed'
  ), selected AS (
    SELECT rank_key, name, best_score, verified, updated_at_ms,
           row_number() OVER (
             PARTITION BY rank_key
             ORDER BY best_score DESC, verified DESC, updated_at_ms DESC NULLS LAST,
                      name COLLATE "C" ASC
           ) AS choice
    FROM candidates
  )
  SELECT rank_key, best_score, verified, updated_at_ms
  FROM selected
  WHERE choice = 1
`;

function shapeToGameRecord(shape) {
  const record = {
    gameId: shape.gameId,
    ownerId: shape.ownerId,
    name: shape.name,
    rankKey: shape.rankKey,
    beginRequestId: shape.beginRequestId,
    beginRequestHash: shape.beginRequestHash,
    rulesVersion: shape.rulesVersion,
    seed: shape.seed,
    snapshot: shape.snapshot,
    seq: shape.seq,
    stateHash: shape.stateHash,
    status: shape.status,
    leaseEpoch: shape.leaseEpoch,
    leaseUntil: shape.leaseUntil,
    createdAt: shape.createdAt,
    updatedAt: shape.updatedAt,
    lastRequestId: shape.lastRequestId,
    lastRequestHash: shape.lastRequestHash,
    lastAction: shape.lastAction,
    elapsedActiveMs: shape.elapsedActiveMs,
    activeSince: shape.activeSince,
  };
  if (shape.status === 'completed' || shape.finalScore !== null) record.finalScore = shape.finalScore;
  return record;
}

function shapeToLegacyRecord(shape) {
  return {
    name: shape.name,
    rankKey: shape.rankKey,
    bestScore: shape.bestScore,
    source: 'legacy',
    verified: false,
    updatedAt: shape.updatedAt === null ? null : new Date(shape.updatedAt).toISOString(),
    sourceRow: shape.sourceRow,
  };
}

function databaseInteger(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) throw new Error('invalid integer');
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('unsafe integer');
  return number;
}

function compareC(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function compareRankKeys(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isBetterCandidate(candidate, current) {
  if (candidate.bestScore !== current.bestScore) return candidate.bestScore > current.bestScore;
  if (candidate.verified !== current.verified) return candidate.verified;
  const candidateTime = candidate.updatedAt ?? -1;
  const currentTime = current.updatedAt ?? -1;
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  return compareC(candidate.name, current.name) < 0;
}

function expectedTop100(games, legacy) {
  const best = new Map();
  const candidates = [
    ...legacy.map((record) => ({
      rankKey: record.rankKey,
      name: record.name,
      bestScore: record.bestScore,
      verified: false,
      updatedAt: record.updatedAt === null ? null : Date.parse(record.updatedAt),
    })),
    ...games.filter((game) => game.status === 'completed').map((game) => ({
      rankKey: game.rankKey,
      name: game.name,
      bestScore: game.finalScore,
      verified: true,
      updatedAt: game.updatedAt,
    })),
  ];
  for (const candidate of candidates) {
    const current = best.get(candidate.rankKey);
    if (!current || isBetterCandidate(candidate, current)) best.set(candidate.rankKey, candidate);
  }
  return [...best.values()]
    .sort((left, right) => right.bestScore - left.bestScore || compareRankKeys(left.rankKey, right.rankKey))
    .slice(0, 100)
    .map(({ rankKey, bestScore, verified, updatedAt }) => ({
      rankKey, bestScore, verified, updatedAt,
    }));
}

function databaseTop100(rows) {
  return rows.map((row) => ({
    rankKey: row.rank_key,
    bestScore: databaseInteger(row.best_score),
    verified: row.verified,
    updatedAt: row.updated_at_ms === null ? null : databaseInteger(row.updated_at_ms),
  })).sort((left, right) => right.bestScore - left.bestScore ||
    compareRankKeys(left.rankKey, right.rankKey)).slice(0, 100);
}

function sameLeaderboard(left, right) {
  return digest(canonicalJson(left)) === digest(canonicalJson(right));
}

function parseVerificationArguments(argv) {
  if (argv.length === 0) return { help: false };
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { help: true };
  throw new SafeMigrationError('Unknown command-line option.', 'invalid_arguments');
}

async function createPool(connectionString) {
  try {
    const { Pool } = await import('pg');
    return new Pool({ connectionString, max: 1 });
  } catch {
    throw new SafeMigrationError('The pg dependency is unavailable.', 'dependency_unavailable');
  }
}

function formatVerificationReport(report) {
  return [
    `games total: ${report.gamesTotal}`,
    `games active: ${report.gamesActive}`,
    `games paused: ${report.gamesPaused}`,
    `games completed: ${report.gamesCompleted}`,
    `legacy total: ${report.legacyTotal}`,
    `corrupted snapshots: ${report.corruptedSnapshots}`,
    `duplicate begin requests: ${report.duplicateBeginRequests}`,
    `unique rank keys: ${report.uniqueRankKeys}`,
    `leaderboard built: ${report.leaderboardBuilt ? 'yes' : 'no'}`,
    `top 100 matches expected: ${report.top100Matches ? 'yes' : 'no'}`,
    `minimum/maximum timestamps: ${report.minimumTimestamp ?? 'none'}/${report.maximumTimestamp ?? 'none'}`,
    `maximum score: ${report.maximumScore ?? 'none'}`,
    `checksum sorted game IDs: ${report.gameIdsChecksum}`,
  ].join('\n');
}

export async function verifyDatabase(client) {
  let gameRows;
  let legacyRows;
  let duplicateRows;
  let sqlTop100;
  let transactionOpen = false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transactionOpen = true;
    gameRows = await client.query(GAME_QUERY);
    legacyRows = await client.query(LEGACY_QUERY);
    duplicateRows = await client.query(`
      SELECT count(*)::text AS count
      FROM (
        SELECT owner_id, begin_request_id
        FROM games
        GROUP BY owner_id, begin_request_id
        HAVING count(*) > 1
      ) duplicates
    `);
    sqlTop100 = await client.query(SQL_TOP_100_QUERY);
    await client.query('COMMIT');
    transactionOpen = false;
  } catch {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve the safe verification failure. */ }
    }
    throw new SafeMigrationError('Database verification failed.', 'database_failed');
  }

  const games = [];
  const legacy = [];
  let corruptedSnapshots = 0;
  let invalidLegacy = 0;
  for (const row of gameRows.rows) {
    try {
      const game = shapeToGameRecord(databaseRowToGameShape(row));
      validateGameRecord(game);
      games.push(game);
    } catch {
      corruptedSnapshots += 1;
    }
  }
  for (const row of legacyRows.rows) {
    try {
      const record = shapeToLegacyRecord(databaseRowToLegacyShape(row));
      validateLegacyRecord(record);
      legacy.push(record);
    } catch {
      invalidLegacy += 1;
    }
  }

  let duplicateBeginRequests;
  try {
    duplicateBeginRequests = databaseInteger(duplicateRows.rows[0]?.count);
  } catch {
    throw new SafeMigrationError('Database verification failed.', 'database_failed');
  }
  const uniqueRankKeys = new Set([
    ...games.map((game) => game.rankKey),
    ...legacy.map((record) => record.rankKey),
  ]).size;
  const leaderboardBuilt = corruptedSnapshots === 0 && invalidLegacy === 0
    && uniqueRankKeys <= 100_000;
  let top100Matches = false;
  if (leaderboardBuilt) {
    try {
      top100Matches = sameLeaderboard(expectedTop100(games, legacy), databaseTop100(sqlTop100.rows));
    } catch {
      top100Matches = false;
    }
  }
  const aggregate = buildImportReport({
    games,
    legacy,
    totals: { games: gameRows.rowCount, legacy: legacyRows.rowCount },
    invalidRows: [],
  });
  const report = {
    gamesTotal: gameRows.rowCount,
    gamesActive: gameRows.rows.filter((row) => row.status === 'active').length,
    gamesPaused: gameRows.rows.filter((row) => row.status === 'paused').length,
    gamesCompleted: gameRows.rows.filter((row) => row.status === 'completed').length,
    legacyTotal: legacyRows.rowCount,
    corruptedSnapshots,
    duplicateBeginRequests,
    uniqueRankKeys,
    leaderboardBuilt,
    top100Matches,
    minimumTimestamp: aggregate.timestamps.minimum,
    maximumTimestamp: aggregate.timestamps.maximum,
    maximumScore: aggregate.maximumScore,
    gameIdsChecksum: checksumSortedGameIds(gameRows.rows.map((row) => ({ gameId: row.game_id }))),
  };
  return {
    ok: corruptedSnapshots === 0 && invalidLegacy === 0 && duplicateBeginRequests === 0
      && leaderboardBuilt && top100Matches,
    report,
  };
}

export async function runVerifyCli(argv = process.argv.slice(2), environment = process.env) {
  const options = parseVerificationArguments(argv);
  if (options.help) {
    console.log('Usage: node scripts/verify-postgres-import.js\n\nDATABASE_URL is required.');
    return true;
  }
  if (typeof environment.DATABASE_URL !== 'string' || environment.DATABASE_URL.length === 0) {
    throw new SafeMigrationError('DATABASE_URL is required.', 'configuration_missing');
  }
  const pool = await createPool(environment.DATABASE_URL);
  let client;
  try {
    client = await pool.connect();
    const verification = await verifyDatabase(client);
    console.log(formatVerificationReport(verification.report));
    return verification.ok;
  } catch (error) {
    if (error instanceof SafeMigrationError) throw error;
    throw new SafeMigrationError('Database verification failed.', 'database_failed');
  } finally {
    client?.release();
    await pool.end().catch(() => {});
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  runVerifyCli().then((ok) => {
    if (!ok) process.exitCode = 1;
  }).catch((error) => {
    console.error(error instanceof SafeMigrationError ? error.message : 'Database verification failed.');
    process.exitCode = 1;
  });
}
