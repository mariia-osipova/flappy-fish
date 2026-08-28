import { validGatewayUrl } from './gateway.js';

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function loadConfig(env = process.env) {
  const sessionKey = env.SESSION_HMAC_KEY || '';
  const stateKey = env.STATE_HMAC_KEY || '';
  const gatewayKey = env.GATEWAY_HMAC_KEY || '';
  const keys = [sessionKey, stateKey, gatewayKey];
  const secretError = keys.some(key => Buffer.byteLength(key) < 32) || new Set(keys).size !== 3;
  const configured = !secretError && validGatewayUrl(env.APPS_SCRIPT_URL);
  return {
    rankedEnabled: env.RANKED_ENABLED === 'true', configured,
    environment: env.APP_ENV === 'staging' ? 'staging' : 'production',
    sessionKey, stateKey, gatewayKey, gatewayUrl: env.APPS_SCRIPT_URL,
    gatewayTimeoutMs: boundedNumber(env.GATEWAY_TIMEOUT_MS, 10000, 1000, 30000),
    verifierWorkers: boundedNumber(env.VERIFIER_WORKERS, 2, 1, 4),
    verifierQueue: boundedNumber(env.VERIFIER_QUEUE, 10, 1, 40),
    verifierBudgetMs: 250,
    port: boundedNumber(env.PORT, 3000, 1, 65535),
    host: env.HOST || '0.0.0.0',
  };
}
