import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialState } from '../src/shared/game-core.js';
import { digest } from '../src/server/security.js';
import {
  GAMES_HEADER,
  LEGACY_HEADER,
  SafeMigrationError,
  buildImportReport,
  formatImportReport,
  gameToDatabaseShape,
  importInTransaction,
  parseArguments,
  parseSheetExport,
  validateGameRecord,
  validateLegacyRecord,
} from '../scripts/import-sheets-export.js';
import { verifyDatabase } from '../scripts/verify-postgres-import.js';

const createdAt = Date.UTC(2026, 7, 31, 12);

function gameRecord(overrides = {}) {
  const snapshot = overrides.snapshot || createInitialState(overrides.seed ?? 42);
  return {
    gameId: '10000000-0000-4000-8000-000000000001',
    ownerId: '20000000-0000-4000-8000-000000000002',
    name: 'Test Fish',
    rankKey: 'test fish',
    beginRequestId: 'begin_request_1',
    beginRequestHash: '1'.repeat(64),
    rulesVersion: 'manual-v1-test',
    seed: 42,
    snapshot,
    seq: 0,
    stateHash: digest(snapshot),
    status: 'active',
    leaseEpoch: 1,
    leaseUntil: createdAt + 120_000,
    createdAt,
    updatedAt: createdAt,
    lastRequestId: 'begin_request_1',
    lastRequestHash: '1'.repeat(64),
    lastAction: 'begin',
    elapsedActiveMs: 0,
    activeSince: createdAt,
    ...overrides,
  };
}

function legacyRecord(overrides = {}) {
  return {
    name: 'Old Fish',
    rankKey: 'old fish',
    bestScore: 7,
    source: 'legacy',
    verified: false,
    updatedAt: '2026-08-30T12:00:00.000Z',
    sourceRow: 2,
    ...overrides,
  };
}

function gameDatabaseRow(game) {
  const shape = gameToDatabaseShape(game);
  return {
    game_id: shape.gameId,
    owner_id: shape.ownerId,
    name: shape.name,
    rank_key: shape.rankKey,
    begin_request_id: shape.beginRequestId,
    begin_request_hash: shape.beginRequestHash,
    rules_version: shape.rulesVersion,
    seed: String(shape.seed),
    snapshot: structuredClone(shape.snapshot),
    seq: String(shape.seq),
    state_hash: shape.stateHash,
    status: shape.status,
    lease_epoch: String(shape.leaseEpoch),
    lease_until_ms: String(shape.leaseUntil),
    created_at_ms: String(shape.createdAt),
    updated_at_ms: String(shape.updatedAt),
    last_request_id: shape.lastRequestId,
    last_request_hash: shape.lastRequestHash,
    last_action: shape.lastAction,
    elapsed_active_ms: String(shape.elapsedActiveMs),
    active_since_ms: shape.activeSince === null ? null : String(shape.activeSince),
    final_score: shape.finalScore === null ? null : String(shape.finalScore),
  };
}

test('validates the complete Games and Legacy JSON record formats', () => {
  assert.equal(validateGameRecord(gameRecord()).status, 'active');
  assert.equal(validateLegacyRecord(legacyRecord()).source, 'legacy');

  const snapshot = createInitialState(42);
  snapshot.started = true;
  snapshot.dead = true;
  snapshot.deathCause = 'bounds';
  snapshot.fish.alive = false;
  const completed = gameRecord({
    snapshot,
    stateHash: digest(snapshot),
    seq: 1,
    status: 'completed',
    leaseUntil: createdAt + 1_000,
    updatedAt: createdAt + 1_000,
    lastRequestId: 'checkpoint_request_1',
    lastRequestHash: '2'.repeat(64),
    lastAction: 'checkpoint',
    elapsedActiveMs: 1_000,
    activeSince: null,
    finalScore: 0,
  });
  assert.equal(validateGameRecord(completed).finalScore, 0);
});

test('rejects changed hashes, non-normalized names, seed mismatch, and terminal inconsistencies', () => {
  assert.throws(() => validateGameRecord(gameRecord({ stateHash: '0'.repeat(64) })), SafeMigrationError);
  assert.throws(() => validateGameRecord(gameRecord({ name: '  Test Fish  ' })), SafeMigrationError);
  assert.throws(() => validateGameRecord(gameRecord({ seed: 43, snapshot: createInitialState(42) })), SafeMigrationError);
  assert.throws(() => validateGameRecord(gameRecord({ status: 'completed', finalScore: 0 })), SafeMigrationError);
  assert.throws(() => validateLegacyRecord(legacyRecord({ verified: true })), SafeMigrationError);
});

test('accepts only the exact protected one-column export headers and reports source rows', async () => {
  const game = gameRecord();
  const parsed = await parseSheetExport('ignored', {
    kind: 'Games',
    header: GAMES_HEADER,
    validate: validateGameRecord,
    parse: () => [[GAMES_HEADER], [JSON.stringify(game)], ['not-json'], ['']],
  });
  assert.equal(parsed.total, 2);
  assert.deepEqual(parsed.records.map((entry) => entry.sourceRow), [2]);
  assert.deepEqual(parsed.invalidRows, [{ kind: 'Games', row: 3 }]);

  await assert.rejects(parseSheetExport('ignored', {
    kind: 'Legacy',
    header: LEGACY_HEADER,
    validate: validateLegacyRecord,
    parse: () => [['unexpected header']],
  }), /header is invalid/);

  const malformed = await parseSheetExport('ignored', {
    kind: 'Games',
    header: GAMES_HEADER,
    validate: validateGameRecord,
    parse: () => { throw new Error('raw parser detail must stay private'); },
  });
  assert.deepEqual(malformed.invalidRows, [{ kind: 'Games', row: 1 }]);
});

test('defaults to dry-run and exposes no force-overwrite option', () => {
  const parsed = parseArguments(['--games', 'Games.csv', '--legacy=Legacy.csv']);
  assert.equal(parsed.apply, false);
  assert.throws(() => parseArguments([
    '--games', 'Games.csv', '--legacy', 'Legacy.csv', '--force',
  ]), /Unknown command-line option/);
  assert.throws(() => parseArguments([
    '--games', 'Games.csv', '--legacy', 'Legacy.csv', '--dry-run', '--apply',
  ]), /either/);
});

test('a differing existing row aborts and rolls back the whole transaction', async () => {
  const game = gameRecord();
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
      if (sql === 'BEGIN' || sql.startsWith('LOCK TABLE') || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql.startsWith('SELECT game_id FROM games')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO games')) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM games WHERE game_id')) {
        return { rowCount: 1, rows: [{ ...gameDatabaseRow(game), state_hash: 'f'.repeat(64) }] };
      }
      throw new Error('unexpected query');
    },
  };
  await assert.rejects(importInTransaction(client, {
    games: [game], legacy: [], totals: { games: 1, legacy: 0 }, invalidRows: [],
  }, { apply: true }), (error) => error instanceof SafeMigrationError && error.code === 'database_conflict');
  assert.equal(calls.includes('COMMIT'), false);
  assert.equal(calls.at(-1), 'ROLLBACK');
});

test('identical existing rows are duplicates and a dry run still rolls back', async () => {
  const game = gameRecord();
  const legacy = legacyRecord();
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql.trim());
      if (sql === 'BEGIN' || sql.startsWith('LOCK TABLE') || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql.startsWith('SELECT game_id FROM games')) {
        return { rowCount: 1, rows: [{ game_id: game.gameId }] };
      }
      if (sql.includes('INSERT INTO games') || sql.includes('INSERT INTO legacy_scores')) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('FROM games WHERE game_id')) {
        return { rowCount: 1, rows: [gameDatabaseRow(game)] };
      }
      if (sql.includes('FROM legacy_scores WHERE rank_key')) {
        return {
          rowCount: 1,
          rows: [{
            rank_key: legacy.rankKey,
            name: legacy.name,
            best_score: String(legacy.bestScore),
            updated_at_ms: String(Date.parse(legacy.updatedAt)),
            source_row: legacy.sourceRow,
          }],
        };
      }
      throw new Error('unexpected query');
    },
  };
  const counts = await importInTransaction(client, {
    games: [game], legacy: [legacy], totals: { games: 1, legacy: 1 }, invalidRows: [],
  });
  assert.deepEqual(counts, { gamesInserted: 0, gamesDuplicates: 1, legacyInserted: 0 });
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.equal(calls.includes('COMMIT'), false);
});

test('reports only aggregate values and a checksum, never record contents', () => {
  const game = gameRecord();
  const legacy = legacyRecord();
  const text = formatImportReport(buildImportReport({
    games: [game], legacy: [legacy], totals: { games: 1, legacy: 1 }, invalidRows: [],
  }, { gamesInserted: 1, gamesDuplicates: 0, legacyInserted: 1 }));
  assert.doesNotMatch(text, new RegExp(game.gameId));
  assert.doesNotMatch(text, new RegExp(game.ownerId));
  assert.doesNotMatch(text, /Test Fish|Old Fish/);
  assert.match(text, /checksum sorted game IDs: [0-9a-f]{64}/);
});

test('database verification independently reconciles the expected top 100', async () => {
  const game = gameRecord();
  const legacy = legacyRecord();
  const legacyTime = Date.parse(legacy.updatedAt);
  const client = {
    async query(sql) {
      if (sql.startsWith('BEGIN TRANSACTION') || sql === 'COMMIT') return { rowCount: 0, rows: [] };
      if (sql.includes('FROM (') && sql.includes('HAVING count(*) > 1')) {
        return { rowCount: 1, rows: [{ count: '0' }] };
      }
      if (sql.includes('WITH candidates AS')) {
        return {
          rowCount: 1,
          rows: [{
            rank_key: legacy.rankKey,
            best_score: String(legacy.bestScore),
            verified: false,
            updated_at_ms: String(legacyTime),
          }],
        };
      }
      if (sql.includes('FROM legacy_scores')) {
        return {
          rowCount: 1,
          rows: [{
            rank_key: legacy.rankKey,
            name: legacy.name,
            best_score: String(legacy.bestScore),
            updated_at_ms: String(legacyTime),
            source_row: legacy.sourceRow,
          }],
        };
      }
      if (sql.includes('FROM games')) return { rowCount: 1, rows: [gameDatabaseRow(game)] };
      throw new Error('unexpected query');
    },
  };
  const result = await verifyDatabase(client);
  assert.equal(result.ok, true);
  assert.equal(result.report.top100Matches, true);
  assert.equal(result.report.corruptedSnapshots, 0);
});
