import { validGatewayUrl } from './gateway.js';

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function validDatabaseUrl(value) {
  try {
    const url = new URL(value);
    return ['postgres:', 'postgresql:'].includes(url.protocol) && Boolean(url.hostname) && url.pathname.length > 1;
  } catch { return false; }
}

function selectStorageBackend(env) {
  const explicit = typeof env.STORAGE_BACKEND === 'string' ? env.STORAGE_BACKEND.trim() : '';
  if (explicit) return ['apps-script', 'postgres'].includes(explicit) ? explicit : null;

  const hasAppsScriptConfig = Boolean(env.APPS_SCRIPT_URL || env.GATEWAY_HMAC_KEY);
  const hasPostgresConfig = Boolean(env.DATABASE_URL);
  if (hasAppsScriptConfig === hasPostgresConfig) return null;
  return hasPostgresConfig ? 'postgres' : 'apps-script';
}

export function loadConfig(env = process.env) {
  const sessionKey = env.SESSION_HMAC_KEY || '';
  const stateKey = env.STATE_HMAC_KEY || '';
  const gatewayKey = env.GATEWAY_HMAC_KEY || '';
  const storageBackend = selectStorageBackend(env);
  const coreKeys = [sessionKey, stateKey];
  const coreSecretError = coreKeys.some(key => Buffer.byteLength(key) < 32) || sessionKey === stateKey;
  const appsScriptConfigured = !coreSecretError && Buffer.byteLength(gatewayKey) >= 32 &&
    !coreKeys.includes(gatewayKey) && validGatewayUrl(env.APPS_SCRIPT_URL);
  const postgresConfigured = !coreSecretError && validDatabaseUrl(env.DATABASE_URL);
  const configured = storageBackend === 'apps-script' ? appsScriptConfigured
    : storageBackend === 'postgres' ? postgresConfigured : false;
  return {
    rankedEnabled: env.RANKED_ENABLED === 'true', configured,
    environment: env.APP_ENV === 'staging' ? 'staging' : 'production',
    storageBackend,
    sessionKey, stateKey, gatewayKey, gatewayUrl: env.APPS_SCRIPT_URL,
    gatewayTimeoutMs: boundedNumber(env.GATEWAY_TIMEOUT_MS, 10000, 1000, 30000),
    databaseUrl: env.DATABASE_URL || '',
    dbPoolMax: boundedNumber(env.DB_POOL_MAX, 4, 1, 30),
    dbConnectionTimeoutMs: boundedNumber(env.DB_CONNECTION_TIMEOUT_MS, 5000, 100, 30000),
    dbStatementTimeoutMs: boundedNumber(env.DB_STATEMENT_TIMEOUT_MS, 5000, 100, 30000),
    maxRankedGames: boundedNumber(env.MAX_RANKED_GAMES, 5, 1, 30),
    verifierWorkers: boundedNumber(env.VERIFIER_WORKERS, 2, 1, 4),
    verifierQueue: boundedNumber(env.VERIFIER_QUEUE, 10, 1, 40),
    verifierBudgetMs: 250,
    port: boundedNumber(env.PORT, 3000, 1, 65535),
    host: env.HOST || '0.0.0.0',
  };
}
