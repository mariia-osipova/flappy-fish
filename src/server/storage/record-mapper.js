function invalidBigint(field) {
  return new RangeError(`PostgreSQL bigint field ${field} is not a safe integer.`);
}

export function bigintToSafeInteger(value, field = 'value') {
  if (typeof value === 'string' && !/^-?\d+$/.test(value)) {
    throw invalidBigint(field);
  }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    throw invalidBigint(field);
  }

  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) throw invalidBigint(field);
  return converted;
}

export function nullableBigintToSafeInteger(value, field = 'value') {
  return value === null ? null : bigintToSafeInteger(value, field);
}

export function rowToGameRecord(row) {
  const record = {
    gameId: row.game_id,
    ownerId: row.owner_id,
    name: row.name,
    rankKey: row.rank_key,
    beginRequestId: row.begin_request_id,
    beginRequestHash: row.begin_request_hash,
    rulesVersion: row.rules_version,
    seed: bigintToSafeInteger(row.seed, 'seed'),
    snapshot: row.snapshot,
    seq: bigintToSafeInteger(row.seq, 'seq'),
    stateHash: row.state_hash,
    status: row.status,
    leaseEpoch: bigintToSafeInteger(row.lease_epoch, 'leaseEpoch'),
    leaseUntil: bigintToSafeInteger(row.lease_until_ms, 'leaseUntil'),
    createdAt: bigintToSafeInteger(row.created_at_ms, 'createdAt'),
    updatedAt: bigintToSafeInteger(row.updated_at_ms, 'updatedAt'),
    lastRequestId: row.last_request_id,
    lastRequestHash: row.last_request_hash,
    lastAction: row.last_action,
    elapsedActiveMs: bigintToSafeInteger(row.elapsed_active_ms, 'elapsedActiveMs'),
    activeSince: nullableBigintToSafeInteger(row.active_since_ms, 'activeSince'),
  };

  if (row.status === 'completed') {
    record.finalScore = bigintToSafeInteger(row.final_score, 'finalScore');
  }

  return record;
}

export function rowToLegacyScoreRecord(row) {
  return {
    name: row.name,
    rankKey: row.rank_key,
    bestScore: bigintToSafeInteger(row.best_score, 'bestScore'),
    updatedAt: nullableBigintToSafeInteger(row.updated_at_ms, 'updatedAt'),
    sourceRow: row.source_row,
  };
}
