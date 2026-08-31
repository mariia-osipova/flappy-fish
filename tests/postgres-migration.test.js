import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { validateMigrationEnvironment } from '../scripts/run-migrations.js';

const require = createRequire(import.meta.url);
const migration = require('../migrations/002_runtime_grants.cjs');

test('admin migration validates and grants only the runtime role privileges', () => {
  const previous = process.env.DATABASE_APP_ROLE;
  try {
    process.env.DATABASE_APP_ROLE = 'runtime-role_1';
    const statements = [];
    migration.up({ sql(statement) { statements.push(statement); } });
    const grants = statements.at(-1);
    assert.match(grants, /REVOKE ALL PRIVILEGES ON TABLE games/);
    assert.match(grants, /REVOKE ALL PRIVILEGES ON TABLE legacy_scores/);
    assert.match(grants, /REVOKE ALL PRIVILEGES ON SCHEMA public/);
    assert.match(grants, /GRANT USAGE ON SCHEMA public TO "runtime-role_1"/);
    assert.match(grants, /GRANT SELECT, INSERT, UPDATE ON TABLE games/);
    assert.match(grants, /GRANT SELECT ON TABLE legacy_scores/);
    assert.doesNotMatch(grants, /GRANT[^;]*DELETE|ALTER DEFAULT PRIVILEGES/);

    process.env.DATABASE_APP_ROLE = 'runtime"; DROP TABLE games; --';
    assert.throws(() => migration.up({ sql() {} }), /ordinary PostgreSQL runtime role/);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_APP_ROLE;
    else process.env.DATABASE_APP_ROLE = previous;
  }
});

test('migration command fails closed before connecting without both aliases', () => {
  assert.throws(
    () => validateMigrationEnvironment({ DATABASE_URL: 'postgres://admin/db' }),
    /DATABASE_APP_ROLE is required/,
  );
  assert.throws(
    () => validateMigrationEnvironment({
      DATABASE_URL: 'postgres://admin/db',
      DATABASE_APP_ROLE: 'runtime"; DROP TABLE games; --',
    }),
    /DATABASE_APP_ROLE is required/,
  );
  assert.deepEqual(
    validateMigrationEnvironment({
      DATABASE_URL: 'postgres://admin/db',
      DATABASE_APP_ROLE: 'runtime-role_1',
    }),
    { databaseUrl: 'postgres://admin/db', appRole: 'runtime-role_1' },
  );
});
