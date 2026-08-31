#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { assertValidSnapshot } from '../src/shared/game-core.js';
import { canonicalJson, digest, MAX_SNAPSHOT_BYTES } from '../src/server/security.js';

export const GAMES_HEADER = 'Flappy Fish game JSON v1';
export const LEGACY_HEADER = 'Flappy Fish legacy JSON v1';

const MAX_RECORD_CHARS = 45_000;
const MAX_CSV_RECORD_CHARS = MAX_RECORD_CHARS * 2 + 1_024;
const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_RANK_KEYS = 100_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const GAME_COLUMNS = `
  game_id, owner_id, name, rank_key, begin_request_id, begin_request_hash,
  rules_version, seed, snapshot, seq, state_hash, status, lease_epoch,
  lease_until_ms, created_at_ms, updated_at_ms, last_request_id,
  last_request_hash, last_action, elapsed_active_ms, active_since_ms, final_score
`;
const GAME_SELECT = `SELECT ${GAME_COLUMNS} FROM games WHERE game_id = $1 FOR UPDATE`;
const LEGACY_SELECT = `
  SELECT rank_key, name, best_score, updated_at_ms, source_row
  FROM legacy_scores WHERE rank_key = $1 FOR UPDATE
`;

const REQUIRED_GAME_FIELDS = Object.freeze([
  'gameId', 'ownerId', 'name', 'rankKey', 'beginRequestId', 'beginRequestHash',
  'rulesVersion', 'seed', 'snapshot', 'seq', 'stateHash', 'status', 'leaseEpoch',
  'leaseUntil', 'createdAt', 'updatedAt', 'lastRequestId', 'lastRequestHash',
  'lastAction', 'elapsedActiveMs', 'activeSince',
]);
const REQUIRED_LEGACY_FIELDS = Object.freeze([
  'name', 'rankKey', 'bestScore', 'source', 'verified', 'updatedAt', 'sourceRow',
]);

export class SafeMigrationError extends Error {
  constructor(message, code = 'migration_failed') {
    super(message);
    this.name = 'SafeMigrationError';
    this.code = code;
  }
}

function fail(message = 'An exported record is invalid.', code = 'invalid_export') {
  throw new SafeMigrationError(message, code);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactFields(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((field, index) => field === wanted[index]);
}

function requireText(value, maximum) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || /[\r\n]/.test(value)) fail();
}

function requireSafeInteger(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail();
}

function requireTimestamp(value) {
  requireSafeInteger(value, 0, MAX_DATE_MS);
  if (new Date(value).getTime() !== value) fail();
}

function normalizeExportedName(name, rankKey) {
  // This intentionally mirrors Code.gs, including JavaScript's UTF-16 slice.
  // Do not broaden or tighten the cutover normalization independently.
  if (typeof name !== 'string') fail();
  const normalized = name.trim().replace(/\s+/g, ' ').slice(0, 24);
  if (!normalized || normalized !== name || normalized.toLowerCase() !== rankKey) fail();
}

/** Validate and return a canonical Apps Script game record without mutating it. */
export function validateGameRecord(game) {
  if (!isPlainObject(game)) fail();
  const expectedFields = game.status === 'completed'
    ? [...REQUIRED_GAME_FIELDS, 'finalScore'] : REQUIRED_GAME_FIELDS;
  if (!hasExactFields(game, expectedFields)) fail();

  if (!UUID_PATTERN.test(game.gameId) || !UUID_PATTERN.test(game.ownerId)) fail();
  normalizeExportedName(game.name, game.rankKey);
  if (!REQUEST_ID_PATTERN.test(game.beginRequestId) || !REQUEST_ID_PATTERN.test(game.lastRequestId)) fail();
  if (!HASH_PATTERN.test(game.beginRequestHash) || !HASH_PATTERN.test(game.lastRequestHash)
      || !HASH_PATTERN.test(game.stateHash)) fail();
  requireText(game.rulesVersion, 120);
  requireSafeInteger(game.seed, 0, 0xffff_ffff);
  requireSafeInteger(game.seq);
  requireSafeInteger(game.leaseEpoch, 1);
  requireSafeInteger(game.elapsedActiveMs);
  requireTimestamp(game.createdAt);
  requireTimestamp(game.updatedAt);
  requireTimestamp(game.leaseUntil);
  if (game.updatedAt < game.createdAt) fail();

  if (!['active', 'paused', 'completed'].includes(game.status)
      || !['begin', 'checkpoint', 'resume'].includes(game.lastAction)) fail();
  if (!isPlainObject(game.snapshot)) fail();
  try {
    assertValidSnapshot(game.snapshot);
    if (Buffer.byteLength(canonicalJson(game.snapshot)) > MAX_SNAPSHOT_BYTES) fail();
  } catch {
    fail();
  }
  if (game.seed !== game.snapshot.seed || game.stateHash !== digest(game.snapshot)) fail();

  if (game.status === 'active') {
    requireTimestamp(game.activeSince);
    if (game.activeSince < game.createdAt || game.activeSince > game.updatedAt
        || game.leaseUntil < game.updatedAt || game.snapshot.dead) fail();
  } else if (game.activeSince !== null || game.leaseUntil !== game.updatedAt) {
    fail();
  }

  if (game.status === 'completed') {
    requireSafeInteger(game.finalScore);
    if (game.lastAction !== 'checkpoint' || game.snapshot.dead !== true
        || game.finalScore !== game.snapshot.score) fail();
  } else if (Object.hasOwn(game, 'finalScore') || game.snapshot.dead) {
    fail();
  }
  if (game.status === 'paused' && game.lastAction !== 'checkpoint') fail();
  if (game.lastAction === 'resume' && (game.status !== 'active' || game.leaseEpoch < 2)) fail();
  if (game.lastAction === 'checkpoint' && game.seq < 1) fail();
  if (game.lastAction === 'begin' && (game.status !== 'active' || game.seq !== 0
      || game.leaseEpoch !== 1 || game.snapshot.tick !== 0 || game.snapshot.score !== 0
      || game.elapsedActiveMs !== 0 || game.activeSince !== game.createdAt
      || game.createdAt !== game.updatedAt || game.lastRequestId !== game.beginRequestId
      || game.lastRequestHash !== game.beginRequestHash)) fail();
  if (JSON.stringify(game).length > MAX_RECORD_CHARS) fail();
  return game;
}

/** Validate and return a canonical Apps Script legacy record without mutating it. */
export function validateLegacyRecord(record) {
  if (!isPlainObject(record) || !hasExactFields(record, REQUIRED_LEGACY_FIELDS)) fail();
  normalizeExportedName(record.name, record.rankKey);
  requireSafeInteger(record.bestScore);
  if (record.source !== 'legacy' || record.verified !== false) fail();
  requireSafeInteger(record.sourceRow, 2, 2_147_483_647);
  if (record.updatedAt !== null) {
    if (typeof record.updatedAt !== 'string') fail();
    const timestamp = Date.parse(record.updatedAt);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0
        || new Date(timestamp).toISOString() !== record.updatedAt) fail();
  }
  if (JSON.stringify(record).length > MAX_RECORD_CHARS) fail();
  return record;
}

function safeCsvRow(error) {
  const recordRow = Number(error?.records) + 1;
  if (Number.isSafeInteger(recordRow) && recordRow >= 1) return recordRow;
  const line = Number(error?.lines);
  return Number.isSafeInteger(line) && line >= 1 ? line : 1;
}

async function csvParser() {
  try {
    return (await import('csv-parse/sync')).parse;
  } catch {
    throw new SafeMigrationError('The csv-parse dependency is unavailable.', 'dependency_unavailable');
  }
}

/** Parse an exact one-column Google Sheets CSV export. */
export async function parseSheetExport(source, { kind, header, validate, parse } = {}) {
  const invalidRows = [];
  let rows;
  try {
    const parseCsv = parse || await csvParser();
    rows = parseCsv(source, {
      bom: true,
      columns: false,
      relax_column_count: false,
      skip_empty_lines: false,
      // CSV escapes every JSON quote a second time, so its physical record can
      // be almost twice the protected cell's character limit.
      max_record_size: MAX_CSV_RECORD_CHARS,
    });
  } catch (error) {
    if (error instanceof SafeMigrationError) throw error;
    invalidRows.push({ kind, row: safeCsvRow(error) });
    return { records: [], total: 0, invalidRows, parseFailed: true };
  }
  if (!Array.isArray(rows) || rows.length === 0 || rows[0].length !== 1 || rows[0][0] !== header) {
    throw new SafeMigrationError(`The ${kind} export header is invalid.`, 'invalid_header');
  }

  const records = [];
  let total = 0;
  rows.slice(1).forEach((row, index) => {
    const sourceRow = index + 2;
    if (row.length === 1 && row[0] === '') return;
    total += 1;
    if (row.length !== 1 || typeof row[0] !== 'string') {
      invalidRows.push({ kind, row: sourceRow });
      return;
    }
    try {
      const record = JSON.parse(row[0]);
      validate(record);
      records.push({ sourceRow, record });
    } catch {
      invalidRows.push({ kind, row: sourceRow });
    }
  });
  return { records, total, invalidRows, parseFailed: false };
}

function markDuplicateRows(entries, keyOf, kind, invalidRows) {
  const firstRows = new Map();
  for (const entry of entries) {
    const key = keyOf(entry.record);
    const previous = firstRows.get(key);
    if (previous === undefined) {
      firstRows.set(key, entry.sourceRow);
      continue;
    }
    invalidRows.push({ kind, row: previous }, { kind, row: entry.sourceRow });
  }
}

function uniqueInvalidRows(rows) {
  return [...new Map(rows.map((entry) => [`${entry.kind}:${entry.row}`, entry])).values()]
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.row - right.row);
}

export async function loadSheetsExports({ gamesPath, legacyPath, parse } = {}) {
  let sources;
  try {
    sources = await Promise.all([readFile(gamesPath, 'utf8'), readFile(legacyPath, 'utf8')]);
  } catch {
    throw new SafeMigrationError('An export file could not be read.', 'file_unavailable');
  }
  const [gamesExport, legacyExport] = await Promise.all([
    parseSheetExport(sources[0], {
      kind: 'Games', header: GAMES_HEADER, validate: validateGameRecord, parse,
    }),
    parseSheetExport(sources[1], {
      kind: 'Legacy', header: LEGACY_HEADER, validate: validateLegacyRecord, parse,
    }),
  ]);
  const invalidRows = [...gamesExport.invalidRows, ...legacyExport.invalidRows];
  markDuplicateRows(gamesExport.records, (record) => record.gameId, 'Games', invalidRows);
  markDuplicateRows(gamesExport.records,
    (record) => `${record.ownerId}\u0000${record.beginRequestId}`, 'Games', invalidRows);
  markDuplicateRows(legacyExport.records, (record) => record.rankKey, 'Legacy', invalidRows);
  return {
    games: gamesExport.records.map((entry) => entry.record),
    legacy: legacyExport.records.map((entry) => entry.record),
    totals: { games: gamesExport.total, legacy: legacyExport.total },
    invalidRows: uniqueInvalidRows(invalidRows),
  };
}

function parseDatabaseInteger(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) fail('A database row conflicts with the export.', 'database_conflict');
  const number = Number(value);
  if (!Number.isSafeInteger(number)) fail('A database row conflicts with the export.', 'database_conflict');
  return number;
}

function parseDatabaseSnapshot(value) {
  if (isPlainObject(value)) return value;
  if (typeof value !== 'string') fail('A database row conflicts with the export.', 'database_conflict');
  try {
    const parsed = JSON.parse(value);
    if (!isPlainObject(parsed)) fail('A database row conflicts with the export.', 'database_conflict');
    return parsed;
  } catch (error) {
    if (error instanceof SafeMigrationError) throw error;
    fail('A database row conflicts with the export.', 'database_conflict');
  }
}

export function gameToDatabaseShape(game) {
  return {
    gameId: game.gameId,
    ownerId: game.ownerId,
    name: game.name,
    rankKey: game.rankKey,
    beginRequestId: game.beginRequestId,
    beginRequestHash: game.beginRequestHash,
    rulesVersion: game.rulesVersion,
    seed: game.seed,
    snapshot: game.snapshot,
    seq: game.seq,
    stateHash: game.stateHash,
    status: game.status,
    leaseEpoch: game.leaseEpoch,
    leaseUntil: game.leaseUntil,
    createdAt: game.createdAt,
    updatedAt: game.updatedAt,
    lastRequestId: game.lastRequestId,
    lastRequestHash: game.lastRequestHash,
    lastAction: game.lastAction,
    elapsedActiveMs: game.elapsedActiveMs,
    activeSince: game.activeSince,
    finalScore: game.status === 'completed' ? game.finalScore : null,
  };
}

export function databaseRowToGameShape(row) {
  return {
    gameId: row.game_id,
    ownerId: row.owner_id,
    name: row.name,
    rankKey: row.rank_key,
    beginRequestId: row.begin_request_id,
    beginRequestHash: row.begin_request_hash,
    rulesVersion: row.rules_version,
    seed: parseDatabaseInteger(row.seed),
    snapshot: parseDatabaseSnapshot(row.snapshot),
    seq: parseDatabaseInteger(row.seq),
    stateHash: row.state_hash,
    status: row.status,
    leaseEpoch: parseDatabaseInteger(row.lease_epoch),
    leaseUntil: parseDatabaseInteger(row.lease_until_ms),
    createdAt: parseDatabaseInteger(row.created_at_ms),
    updatedAt: parseDatabaseInteger(row.updated_at_ms),
    lastRequestId: row.last_request_id,
    lastRequestHash: row.last_request_hash,
    lastAction: row.last_action,
    elapsedActiveMs: parseDatabaseInteger(row.elapsed_active_ms),
    activeSince: row.active_since_ms === null ? null : parseDatabaseInteger(row.active_since_ms),
    finalScore: row.final_score === null ? null : parseDatabaseInteger(row.final_score),
  };
}

export function legacyToDatabaseShape(record) {
  return {
    rankKey: record.rankKey,
    name: record.name,
    bestScore: record.bestScore,
    updatedAt: record.updatedAt === null ? null : Date.parse(record.updatedAt),
    sourceRow: record.sourceRow,
  };
}

export function databaseRowToLegacyShape(row) {
  return {
    rankKey: row.rank_key,
    name: row.name,
    bestScore: parseDatabaseInteger(row.best_score),
    updatedAt: row.updated_at_ms === null ? null : parseDatabaseInteger(row.updated_at_ms),
    sourceRow: row.source_row === null ? null : parseDatabaseInteger(row.source_row),
  };
}

function identical(left, right) {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function gameParameters(game) {
  const shape = gameToDatabaseShape(game);
  return [
    shape.gameId, shape.ownerId, shape.name, shape.rankKey, shape.beginRequestId,
    shape.beginRequestHash, shape.rulesVersion, shape.seed, JSON.stringify(shape.snapshot),
    shape.seq, shape.stateHash, shape.status, shape.leaseEpoch, shape.leaseUntil,
    shape.createdAt, shape.updatedAt, shape.lastRequestId, shape.lastRequestHash,
    shape.lastAction, shape.elapsedActiveMs, shape.activeSince, shape.finalScore,
  ];
}

function legacyParameters(record) {
  const shape = legacyToDatabaseShape(record);
  return [shape.rankKey, shape.name, shape.bestScore, shape.updatedAt, shape.sourceRow];
}

async function importGame(client, game) {
  const receipt = await client.query(
    'SELECT game_id FROM games WHERE owner_id = $1 AND begin_request_id = $2 FOR UPDATE',
    [game.ownerId, game.beginRequestId],
  );
  if (receipt.rowCount > 0 && receipt.rows[0].game_id !== game.gameId) {
    fail('A database row conflicts with the export.', 'database_conflict');
  }
  const inserted = await client.query(`
    INSERT INTO games (${GAME_COLUMNS})
    VALUES (${Array.from({ length: 22 }, (_, index) => `$${index + 1}`).join(', ')})
    ON CONFLICT (game_id) DO NOTHING
    RETURNING game_id
  `, gameParameters(game));
  if (inserted.rowCount === 1) return 'inserted';
  const existing = await client.query(GAME_SELECT, [game.gameId]);
  if (existing.rowCount !== 1
      || !identical(databaseRowToGameShape(existing.rows[0]), gameToDatabaseShape(game))) {
    fail('A database row conflicts with the export.', 'database_conflict');
  }
  return 'duplicate';
}

async function importLegacy(client, record) {
  const inserted = await client.query(`
    INSERT INTO legacy_scores (rank_key, name, best_score, updated_at_ms, source_row)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (rank_key) DO NOTHING
    RETURNING rank_key
  `, legacyParameters(record));
  if (inserted.rowCount === 1) return 'inserted';
  const existing = await client.query(LEGACY_SELECT, [record.rankKey]);
  if (existing.rowCount !== 1
      || !identical(databaseRowToLegacyShape(existing.rows[0]), legacyToDatabaseShape(record))) {
    fail('A database row conflicts with the export.', 'database_conflict');
  }
  return 'duplicate';
}

/** Run the exact import inside one transaction; a dry run always rolls it back. */
export async function importInTransaction(client, data, { apply = false } = {}) {
  if (!data || !Array.isArray(data.games) || !Array.isArray(data.legacy)
      || (data.invalidRows?.length ?? 0) > 0) {
    throw new SafeMigrationError('Export validation failed.', 'invalid_export');
  }
  for (const game of data.games) validateGameRecord(game);
  for (const record of data.legacy) validateLegacyRecord(record);
  if (countUniqueRankKeys(data.games, data.legacy) > MAX_RANK_KEYS) {
    throw new SafeMigrationError('The leaderboard index would exceed its limit.', 'invalid_export');
  }
  const counts = { gamesInserted: 0, gamesDuplicates: 0, legacyInserted: 0 };
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query('LOCK TABLE games, legacy_scores IN SHARE ROW EXCLUSIVE MODE');
    for (const game of data.games) {
      const result = await importGame(client, game);
      if (result === 'inserted') counts.gamesInserted += 1;
      else counts.gamesDuplicates += 1;
    }
    for (const record of data.legacy) {
      const result = await importLegacy(client, record);
      if (result === 'inserted') counts.legacyInserted += 1;
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    transactionOpen = false;
    return counts;
  } catch (error) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch { /* The original safe failure wins. */ }
    }
    if (error instanceof SafeMigrationError) throw error;
    throw new SafeMigrationError('The database import failed.', 'database_failed');
  }
}

export function checksumSortedGameIds(games) {
  const sorted = games.map((game) => game.gameId).sort();
  return createHash('sha256').update(sorted.join('\n'), 'utf8').digest('hex');
}

function timestampRange(games, legacy) {
  let minimum = null;
  let maximum = null;
  const consider = (value) => {
    minimum = minimum === null ? value : Math.min(minimum, value);
    maximum = maximum === null ? value : Math.max(maximum, value);
  };
  for (const game of games) {
    consider(game.createdAt);
    consider(game.updatedAt);
  }
  for (const record of legacy) {
    if (record.updatedAt !== null) consider(Date.parse(record.updatedAt));
  }
  return { minimum, maximum };
}

function countUniqueRankKeys(games, legacy) {
  const keys = new Set();
  for (const game of games) keys.add(game.rankKey);
  for (const record of legacy) keys.add(record.rankKey);
  return keys.size;
}

export function buildImportReport(data, counts = {}) {
  const status = { active: 0, paused: 0, completed: 0 };
  for (const game of data.games) status[game.status] += 1;
  let maximumScore = null;
  for (const game of data.games) {
    if (game.status === 'completed') {
      maximumScore = maximumScore === null ? game.finalScore : Math.max(maximumScore, game.finalScore);
    }
  }
  for (const record of data.legacy) {
    maximumScore = maximumScore === null ? record.bestScore : Math.max(maximumScore, record.bestScore);
  }
  return {
    gamesTotal: data.totals?.games ?? data.games.length,
    gamesInserted: counts.gamesInserted ?? 0,
    gamesDuplicates: counts.gamesDuplicates ?? 0,
    gamesActive: status.active,
    gamesPaused: status.paused,
    gamesCompleted: status.completed,
    legacyTotal: data.totals?.legacy ?? data.legacy.length,
    legacyInserted: counts.legacyInserted ?? 0,
    uniqueRankKeys: countUniqueRankKeys(data.games, data.legacy),
    invalidRows: data.invalidRows || [],
    timestamps: timestampRange(data.games, data.legacy),
    maximumScore,
    gameIdsChecksum: checksumSortedGameIds(data.games),
  };
}

function printable(value) {
  return value === null ? 'none' : String(value);
}

export function formatImportReport(report) {
  const invalid = report.invalidRows.length === 0 ? 'none'
    : report.invalidRows.map((entry) => `${entry.kind}!${entry.row}`).join(',');
  return [
    `games total: ${report.gamesTotal}`,
    `games inserted: ${report.gamesInserted}`,
    `games duplicates: ${report.gamesDuplicates}`,
    `games active: ${report.gamesActive}`,
    `games paused: ${report.gamesPaused}`,
    `games completed: ${report.gamesCompleted}`,
    `legacy total: ${report.legacyTotal}`,
    `legacy inserted: ${report.legacyInserted}`,
    `unique rank keys: ${report.uniqueRankKeys}`,
    `invalid source row numbers: ${invalid}`,
    `minimum/maximum timestamps: ${printable(report.timestamps.minimum)}/${printable(report.timestamps.maximum)}`,
    `maximum score: ${printable(report.maximumScore)}`,
    `checksum sorted game IDs: ${report.gameIdsChecksum}`,
  ].join('\n');
}

export function parseArguments(argv) {
  const options = { gamesPath: null, legacyPath: null, apply: false, help: false };
  let selectedMode = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--dry-run' || argument === '--apply') {
      if (selectedMode !== null && selectedMode !== argument) {
        throw new SafeMigrationError('Choose either --dry-run or --apply.', 'invalid_arguments');
      }
      selectedMode = argument;
      options.apply = argument === '--apply';
      continue;
    }
    const matched = /^(--games|--legacy)(?:=(.*))?$/.exec(argument);
    if (matched) {
      const value = matched[2] === undefined ? argv[++index] : matched[2];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
        throw new SafeMigrationError('Both export file paths are required.', 'invalid_arguments');
      }
      const field = matched[1] === '--games' ? 'gamesPath' : 'legacyPath';
      if (options[field] !== null) throw new SafeMigrationError('An export path was provided twice.', 'invalid_arguments');
      options[field] = value;
      continue;
    }
    throw new SafeMigrationError('Unknown command-line option.', 'invalid_arguments');
  }
  if (!options.help && (!options.gamesPath || !options.legacyPath)) {
    throw new SafeMigrationError('Both --games and --legacy are required.', 'invalid_arguments');
  }
  return options;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/import-sheets-export.js --games <Games.csv> --legacy <Legacy.csv> [--dry-run]',
    '  IMPORT_CONFIRM=POSTGRES_CUTOVER node scripts/import-sheets-export.js --games <Games.csv> --legacy <Legacy.csv> --apply',
    '',
    'DATABASE_URL is required. The default mode is --dry-run.',
  ].join('\n');
}

async function databasePool(connectionString) {
  try {
    const { Pool } = await import('pg');
    return new Pool({ connectionString, max: 1 });
  } catch {
    throw new SafeMigrationError('The pg dependency is unavailable.', 'dependency_unavailable');
  }
}

export async function runImportCli(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.apply && environment.IMPORT_CONFIRM !== 'POSTGRES_CUTOVER') {
    throw new SafeMigrationError('--apply requires IMPORT_CONFIRM=POSTGRES_CUTOVER.', 'confirmation_required');
  }
  if (typeof environment.DATABASE_URL !== 'string' || environment.DATABASE_URL.length === 0) {
    throw new SafeMigrationError('DATABASE_URL is required.', 'configuration_missing');
  }

  const data = await loadSheetsExports(options);
  const validationReport = buildImportReport(data);
  if (data.invalidRows.length > 0 || validationReport.uniqueRankKeys > MAX_RANK_KEYS) {
    console.log(formatImportReport(validationReport));
    throw new SafeMigrationError('Export validation failed.', 'invalid_export');
  }

  const pool = await databasePool(environment.DATABASE_URL);
  let client;
  try {
    client = await pool.connect();
    const counts = await importInTransaction(client, data, { apply: options.apply });
    console.log(formatImportReport(buildImportReport(data, counts)));
  } catch (error) {
    if (error instanceof SafeMigrationError) throw error;
    throw new SafeMigrationError('The database import failed.', 'database_failed');
  } finally {
    client?.release();
    await pool.end().catch(() => {});
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  runImportCli().catch((error) => {
    console.error(error instanceof SafeMigrationError ? error.message : 'The import failed.');
    process.exitCode = 1;
  });
}
