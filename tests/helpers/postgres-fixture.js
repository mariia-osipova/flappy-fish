import { randomUUID } from 'node:crypto';
import { createInitialState, replay, RULES_VERSION } from '../../src/shared/game-core.js';
import { digest, normalizeName } from '../../src/server/security.js';

export function beginCall({ ownerId = randomUUID(), name = 'Fish', seed = 123456789, requestId = randomUUID() } = {}) {
  const normalized = normalizeName(name);
  const snapshot = createInitialState(seed);
  return {
    requestId,
    payload: {
      ownerId,
      name: normalized.name,
      rankKey: normalized.rankKey,
      gameId: randomUUID(),
      seed,
      rulesVersion: RULES_VERSION,
      snapshot,
      stateHash: digest(snapshot),
      requestHash: digest({ action: 'begin', ownerId, name: normalized.name, rankKey: normalized.rankKey }),
    },
  };
}

export function checkpointCall(game, {
  inputs = [0], pause = false, requestId = randomUUID(), snapshot,
} = {}) {
  const nextSnapshot = snapshot || (inputs.length ? replay(game.snapshot, inputs) : structuredClone(game.snapshot));
  const payload = {
    ownerId: game.ownerId,
    gameId: game.gameId,
    prevSeq: game.seq,
    prevStateHash: game.stateHash,
    leaseEpoch: game.leaseEpoch,
    snapshot: nextSnapshot,
    stateHash: digest(nextSnapshot),
    inputTicks: inputs.length,
    pause,
  };
  payload.requestHash = digest({ action: 'checkpoint', requestId, ...payload });
  return { requestId, payload };
}

export function resumeCall(game, { requestId = randomUUID() } = {}) {
  const payload = {
    ownerId: game.ownerId,
    gameId: game.gameId,
    prevSeq: game.seq,
    prevStateHash: game.stateHash,
    leaseEpoch: game.leaseEpoch,
  };
  payload.requestHash = digest({ action: 'resume', requestId, ...payload });
  return { requestId, payload };
}

export async function truncatePostgres(pool) {
  await pool.query('TRUNCATE games, legacy_scores');
}
