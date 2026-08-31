import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bigintToSafeInteger,
  rowToGameRecord,
  rowToLegacyScoreRecord,
} from '../src/server/storage/record-mapper.js';

function databaseGameRow(overrides = {}) {
  return {
    game_id: '00000000-0000-4000-8000-000000000001',
    owner_id: '00000000-0000-4000-8000-000000000002',
    name: 'Alice',
    rank_key: 'alice',
    begin_request_id: 'begin-one',
    begin_request_hash: 'a'.repeat(64),
    rules_version: 'test-v1',
    seed: '4294967295',
    snapshot: { tick: 0, score: 0, dead: false, seed: 4294967295 },
    seq: '0',
    state_hash: 'b'.repeat(64),
    status: 'active',
    lease_epoch: '1',
    lease_until_ms: '1788000120000',
    created_at_ms: '1788000000000',
    updated_at_ms: '1788000000000',
    last_request_id: 'begin-one',
    last_request_hash: 'a'.repeat(64),
    last_action: 'begin',
    elapsed_active_ms: '0',
    active_since_ms: '1788000000000',
    final_score: null,
    ...overrides,
  };
}

test('rowToGameRecord restores the exact Apps Script record shape', () => {
  assert.deepEqual(rowToGameRecord(databaseGameRow()), {
    gameId: '00000000-0000-4000-8000-000000000001',
    ownerId: '00000000-0000-4000-8000-000000000002',
    name: 'Alice',
    rankKey: 'alice',
    beginRequestId: 'begin-one',
    beginRequestHash: 'a'.repeat(64),
    rulesVersion: 'test-v1',
    seed: 4294967295,
    snapshot: { tick: 0, score: 0, dead: false, seed: 4294967295 },
    seq: 0,
    stateHash: 'b'.repeat(64),
    status: 'active',
    leaseEpoch: 1,
    leaseUntil: 1788000120000,
    createdAt: 1788000000000,
    updatedAt: 1788000000000,
    lastRequestId: 'begin-one',
    lastRequestHash: 'a'.repeat(64),
    lastAction: 'begin',
    elapsedActiveMs: 0,
    activeSince: 1788000000000,
  });
});

test('rowToGameRecord includes finalScore only for completed games', () => {
  const completed = rowToGameRecord(databaseGameRow({
    status: 'completed',
    active_since_ms: null,
    final_score: '17',
  }));
  assert.equal(completed.activeSince, null);
  assert.equal(completed.finalScore, 17);

  const paused = rowToGameRecord(databaseGameRow({ status: 'paused', active_since_ms: null }));
  assert.equal(Object.hasOwn(paused, 'finalScore'), false);
});

test('bigint mapping rejects unsafe, fractional, and non-decimal values', () => {
  assert.equal(bigintToSafeInteger('9007199254740991', 'test'), Number.MAX_SAFE_INTEGER);
  for (const value of ['9007199254740992', '-9007199254740992', '1.5', '1e3', '', null, undefined]) {
    assert.throws(() => bigintToSafeInteger(value, 'test'), {
      name: 'RangeError',
      message: 'PostgreSQL bigint field test is not a safe integer.',
    });
  }
});

test('legacy bigint fields are explicitly mapped without a global pg parser', () => {
  assert.deepEqual(rowToLegacyScoreRecord({
    rank_key: 'alice',
    name: 'Alice',
    best_score: '42',
    updated_at_ms: null,
    source_row: 7,
  }), {
    name: 'Alice',
    rankKey: 'alice',
    bestScore: 42,
    updatedAt: null,
    sourceRow: 7,
  });
});
