import { unavailable } from '../errors.js';

// Replaced by the transactional implementation in the PostgreSQL feature
// commit. Keeping this fail-closed adapter makes backend selection explicit
// without silently falling back to Apps Script.
export class PostgresStore {
  async call() { throw unavailable(); }
  async ping() { throw unavailable(); }
  async close() {}
}
