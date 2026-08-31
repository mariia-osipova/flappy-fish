import pg from 'pg';

const { Pool } = pg;

export function createPostgresPool(config, { PoolClass = Pool } = {}) {
  const poolConfig = {
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    connectionTimeoutMillis: config.dbConnectionTimeoutMs,
    idleTimeoutMillis: 30_000,
    application_name: 'flappy-fish',
  };

  if (config.dbStatementTimeoutMs !== undefined) {
    poolConfig.statement_timeout = config.dbStatementTimeoutMs;
  }

  return new PoolClass(poolConfig);
}

export const createPool = createPostgresPool;
