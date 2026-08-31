import { AppsScriptGateway } from '../gateway.js';
import { PostgresStore } from './postgres-store.js';

export function createStore(config, options = {}) {
  switch (config.storageBackend) {
    case 'apps-script':
      return new AppsScriptGateway({
        url: config.gatewayUrl,
        key: config.gatewayKey,
        timeoutMs: config.gatewayTimeoutMs,
        now: options.now,
        fetchImpl: options.fetchImpl,
      });
    case 'postgres':
      return new PostgresStore({ config, pool: options.pool, clock: options.clock });
    default:
      return null;
  }
}
