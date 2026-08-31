import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, test } from 'node:test';
import pg from 'pg';
import { runner as migrate } from 'node-pg-migrate';
import { replay } from '../src/shared/game-core.js';
import { ApiError } from '../src/server/errors.js';
import { PostgresStore } from '../src/server/storage/postgres-store.js';
import { beginCall, checkpointCall, resumeCall, truncatePostgres } from './helpers/postgres-fixture.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const root = fileURLToPath(new URL('../', import.meta.url));

if (!databaseUrl) {
  test('PostgreSQL contract tests require TEST_DATABASE_URL', { skip: 'set TEST_DATABASE_URL to a disposable PostgreSQL database' }, () => {});
} else {
  const { Pool } = pg;
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  let now = 1_787_920_000_000;
  let store;

  const call = ({ requestId, payload }, action) => store.call(action, payload, requestId);
  const expectError = async (promise, status, code) => {
    await assert.rejects(promise, error => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      return true;
    });
  };

  before(async () => {
    await migrate({
      databaseUrl,
      dir: path.join(root, 'migrations'),
      direction: 'up',
      migrationsTable: 'pgmigrations',
      log: () => {},
    });
  });

  beforeEach(async () => {
    await truncatePostgres(pool);
    now = 1_787_920_000_000;
    store = new PostgresStore({ pool, clock: () => now, maxRankedGames: 5 });
  });

  after(async () => { await pool.end(); });

  test('migration runs on an empty schema and a repeat is idempotent', async () => {
    const schema = `migration_${randomUUID().replaceAll('-', '')}`;
    await migrate({
      databaseUrl,
      dir: path.join(root, 'migrations'),
      direction: 'up',
      migrationsTable: 'pgmigrations',
      migrationsSchema: schema,
      schema,
      createSchema: true,
      createMigrationsSchema: true,
      log: () => {},
    });
    const first = await pool.query(`
      SELECT to_regclass('${schema}.games')::text AS games,
             to_regclass('${schema}.legacy_scores')::text AS legacy
    `);
    assert.equal(first.rows[0].games, `${schema}.games`);
    assert.equal(first.rows[0].legacy, `${schema}.legacy_scores`);
    const repeated = await migrate({
      databaseUrl,
      dir: path.join(root, 'migrations'),
      direction: 'up',
      migrationsTable: 'pgmigrations',
      migrationsSchema: schema,
      schema,
      log: () => {},
    });
    assert.deepEqual(repeated, []);
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  });

  test('begin is durable and idempotent before validating a new random proposal', async () => {
    const begin = beginCall({ name: '  FiSH   One ' });
    const created = await call(begin, 'begin');
    const retry = structuredClone(begin);
    retry.payload.gameId = randomUUID();
    retry.payload.seed = 17;
    const duplicate = await call(retry, 'begin');
    assert.deepEqual(duplicate, created);
    const count = await pool.query('SELECT count(*)::int AS count FROM games');
    assert.equal(count.rows[0].count, 1);

    const changed = structuredClone(retry);
    changed.payload.requestHash = 'a'.repeat(64);
    await expectError(call(changed, 'begin'), 409, 'conflict');
  });

  test('begin enforces one owner, five global slots, and durable creation rate', async () => {
    const first = beginCall();
    const game = await call(first, 'begin');
    const sameOwner = beginCall({ ownerId: game.ownerId });
    const ownerError = store.call('begin', sameOwner.payload, sameOwner.requestId).catch(error => error);
    const owned = await ownerError;
    assert.equal(owned.code, 'active_game_exists');
    assert.equal(owned.details.gameId, game.gameId);

    for (let index = 1; index < 5; index += 1) await call(beginCall({ name: `Fish ${index}` }), 'begin');
    await expectError(call(beginCall({ name: 'Sixth' }), 'begin'), 503, 'ranked_full');

    await truncatePostgres(pool);
    const ownerId = randomUUID();
    for (let index = 0; index < 6; index += 1) {
      const current = await call(beginCall({ ownerId, name: `Attempt ${index}` }), 'begin');
      await call(checkpointCall(current, { inputs: [], pause: true }), 'checkpoint');
    }
    await expectError(call(beginCall({ ownerId, name: 'Attempt 7' }), 'begin'), 429, 'rate_limited');
  });

  test('read returns an owned record without mutating it and hides other owners', async () => {
    const game = await call(beginCall(), 'begin');
    const read = await store.call('read', { ownerId: game.ownerId, gameId: game.gameId });
    assert.deepEqual(read, game);
    await expectError(store.call('read', { ownerId: randomUUID(), gameId: game.gameId }), 403, 'forbidden');
    await expectError(store.call('read', { ownerId: game.ownerId, gameId: randomUUID() }), 404, 'not_found');
    const persisted = await pool.query('SELECT updated_at_ms, lease_until_ms FROM games WHERE game_id = $1', [game.gameId]);
    assert.equal(Number(persisted.rows[0].updated_at_ms), game.updatedAt);
    assert.equal(Number(persisted.rows[0].lease_until_ms), game.leaseUntil);
  });

  test('checkpoint is idempotent and rejects every stale CAS dimension', async () => {
    const game = await call(beginCall(), 'begin');
    now += 100;
    const checkpoint = checkpointCall(game, { inputs: [0, 0] });
    const saved = await call(checkpoint, 'checkpoint');
    assert.equal(saved.seq, 1);
    assert.equal(saved.snapshot.tick, 2);
    assert.deepEqual(await call(checkpoint, 'checkpoint'), saved);

    const changedDuplicate = structuredClone(checkpoint);
    changedDuplicate.payload.requestHash = 'b'.repeat(64);
    await expectError(call(changedDuplicate, 'checkpoint'), 409, 'conflict');
    for (const mutation of [
      payload => { payload.prevSeq -= 1; },
      payload => { payload.prevStateHash = 'c'.repeat(64); },
      payload => { payload.leaseEpoch += 1; },
    ]) {
      const stale = checkpointCall(saved, { inputs: [0] });
      mutation(stale.payload);
      await expectError(call(stale, 'checkpoint'), 409, 'conflict');
    }
  });

  test('concurrent duplicate checkpoints coalesce and competing branches fence one writer', async () => {
    const game = await call(beginCall(), 'begin');
    now += 100;
    const duplicate = checkpointCall(game, { inputs: [0, 0] });
    const identical = await Promise.all([call(duplicate, 'checkpoint'), call(duplicate, 'checkpoint')]);
    assert.deepEqual(identical[0], identical[1]);

    const current = identical[0];
    const branches = await Promise.allSettled([
      call(checkpointCall(current, { inputs: [1, 1] }), 'checkpoint'),
      call(checkpointCall(current, { inputs: [2, 2] }), 'checkpoint'),
    ]);
    assert.equal(branches.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = branches.find(result => result.status === 'rejected');
    assert.equal(rejected.reason.code, 'conflict');
    const row = await pool.query('SELECT seq FROM games WHERE game_id = $1', [game.gameId]);
    assert.equal(Number(row.rows[0].seq), 2);
  });

  test('pause/resume preserves active credit, is idempotent, and fences the old epoch', async () => {
    const game = await call(beginCall(), 'begin');
    now += 2_000;
    const paused = await call(checkpointCall(game, { inputs: [], pause: true }), 'checkpoint');
    assert.equal(paused.status, 'paused');
    assert.equal(paused.elapsedActiveMs, 2_000);
    now += 60_000;
    const resume = resumeCall(paused);
    const resumed = await call(resume, 'resume');
    assert.equal(resumed.status, 'active');
    assert.equal(resumed.leaseEpoch, 2);
    assert.equal(resumed.elapsedActiveMs, 2_000);
    assert.deepEqual(await call(resume, 'resume'), resumed);
    await expectError(call(checkpointCall(paused, { inputs: [0] }), 'checkpoint'), 409, 'conflict');

    const pausedAgain = await call(checkpointCall(resumed, { inputs: [], pause: true }), 'checkpoint');
    await expectError(call(resume, 'resume'), 409, 'conflict');
    assert.equal(pausedAgain.status, 'paused');
  });

  test('resume enforces capacity and an expired lease retains only capped active time', async () => {
    const owners = [];
    for (let index = 0; index < 5; index += 1) owners.push(await call(beginCall({ name: `Slot ${index}` }), 'begin'));
    const paused = await call(checkpointCall(owners[0], { inputs: [], pause: true }), 'checkpoint');
    const replacement = await call(beginCall({ name: 'Replacement' }), 'begin');
    await expectError(call(resumeCall(paused), 'resume'), 503, 'ranked_full');
    now = replacement.leaseUntil + 1;
    const resumed = await call(resumeCall(paused), 'resume');
    assert.equal(resumed.status, 'active');

    await truncatePostgres(pool);
    now = 1_787_920_000_000;
    const target = await call(beginCall(), 'begin');
    const targetPaused = await call(checkpointCall(target, { inputs: [], pause: true }), 'checkpoint');
    const otherOwned = await call(beginCall({ ownerId: target.ownerId, name: 'Other owned game' }), 'begin');
    const ownedResume = resumeCall(targetPaused);
    const ownedError = await call(ownedResume, 'resume').catch(error => error);
    assert.equal(ownedError.code, 'active_game_exists');
    assert.equal(ownedError.details.gameId, otherOwned.gameId);

    await truncatePostgres(pool);
    now = 1_787_920_000_000;
    const expiring = await call(beginCall(), 'begin');
    now += 130_000;
    await expectError(call(checkpointCall(expiring, { inputs: [0] }), 'checkpoint'), 409, 'lease_expired');
    const afterExpiry = await call(resumeCall(expiring), 'resume');
    assert.equal(afterExpiry.elapsedActiveMs, 120_000);
    assert.equal(afterExpiry.leaseEpoch, 2);
  });

  test('server-time speed validation rolls back and the same request later succeeds', async () => {
    const game = await call(beginCall(), 'begin');
    const checkpoint = checkpointCall(game, { inputs: Array(1_200).fill(0) });
    await expectError(call(checkpoint, 'checkpoint'), 409, 'too_fast');
    const unchanged = await store.call('read', { ownerId: game.ownerId, gameId: game.gameId });
    assert.equal(unchanged.seq, 0);
    now += 10_000;
    const saved = await call(checkpoint, 'checkpoint');
    assert.equal(saved.snapshot.tick, 1_200);
  });

  test('completion is durable, idempotent after response loss, and immutable', async () => {
    const game = await call(beginCall(), 'begin');
    now += 1_000;
    const death = checkpointCall(game, { inputs: [4, ...Array(85).fill(0)] });
    const committed = await call(death, 'checkpoint');
    assert.equal(committed.status, 'completed');
    assert.equal(committed.finalScore, committed.snapshot.score);

    // Simulate the caller losing the committed return value, then retry exactly.
    assert.deepEqual(await call(death, 'checkpoint'), committed);
    await expectError(call(checkpointCall(committed, { inputs: [], pause: true }), 'checkpoint'), 409, 'conflict');
    await expectError(call(resumeCall(committed), 'resume'), 409, 'conflict');
  });

  test('a failed transaction rolls back every write', async () => {
    await assert.rejects(store.transaction(async client => {
      await client.query(`
        INSERT INTO legacy_scores (rank_key, name, best_score, updated_at_ms, source_row)
        VALUES ('rollback', 'Rollback', 1, NULL, NULL)
      `);
      throw new Error('simulated failure');
    }), /simulated failure/);
    const row = await pool.query("SELECT 1 FROM legacy_scores WHERE rank_key = 'rollback'");
    assert.equal(row.rowCount, 0);
  });

  test('leaderboard merges legacy and verified results with stable tie semantics', async () => {
    await pool.query(`
      INSERT INTO legacy_scores (rank_key, name, best_score, updated_at_ms, source_row)
      VALUES ('fish', 'Fish', 0, $1, 2), ('other', 'Other', 99, $1, 3)
    `, [now + 100_000]);
    const first = await call(beginCall({ name: 'fish' }), 'begin');
    now += 1_000;
    await call(checkpointCall(first, { inputs: [4, ...Array(85).fill(0)] }), 'checkpoint');
    const scores = await store.call('scores', { includeIndex: true, name: 'FISH' });
    assert.equal(scores.scores[0].name, 'Other');
    assert.equal(scores.player.source, 'verified');
    assert.equal(scores.player.verified, true);

    now += 1_000;
    const later = await call(beginCall({ name: 'FiSh' }), 'begin');
    now += 1_000;
    await call(checkpointCall(later, { inputs: [4, ...Array(85).fill(0)] }), 'checkpoint');
    const refreshed = await store.call('scores', { includeIndex: true, name: 'fish' });
    assert.equal(refreshed.player.name, 'FiSh');
  });

  test('leaderboard returns top 100 plus an exact player outside the window', async () => {
    await pool.query(`
      INSERT INTO legacy_scores (rank_key, name, best_score, updated_at_ms, source_row)
      SELECT 'player ' || value, 'Player ' || value, 1000 - value, $1, value
      FROM generate_series(1, 101) AS value
    `, [now]);
    const scores = await store.call('scores', { includeIndex: true, name: 'Player 101' });
    assert.equal(scores.scores.length, 100);
    assert.equal(scores.index.length, 101);
    assert.equal(scores.player.rank, 101);
    assert.equal(Object.hasOwn(scores.player, 'rankKey'), false);
    assert.equal(Object.hasOwn(scores.player, 'gameId'), false);
  });

  test('leaderboard rejects an internal index above 100000 entries', async () => {
    await pool.query(`
      INSERT INTO legacy_scores (rank_key, name, best_score, updated_at_ms, source_row)
      SELECT 'bulk-' || value, 'Bulk-' || value, value, NULL, NULL
      FROM generate_series(1, 100001) AS value
    `);
    await expectError(store.call('scores', { includeIndex: true }), 503, 'storage_unavailable');
  });

  test('ping checks both required tables and close drains its pool', async () => {
    assert.equal(await store.ping(), true);
    const dedicatedPool = new Pool({ connectionString: databaseUrl, max: 1 });
    const dedicated = new PostgresStore({ pool: dedicatedPool, clock: () => now });
    await dedicated.ping();
    await dedicated.close();
    await dedicated.close();
    await assert.rejects(dedicatedPool.query('SELECT 1'), /ended|end/i);
  });
}
