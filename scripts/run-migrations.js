#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

const root = fileURLToPath(new URL('../', import.meta.url));

export function validateMigrationEnvironment(environment = process.env) {
  if (typeof environment.DATABASE_URL !== 'string' || environment.DATABASE_URL.length === 0) {
    throw new Error('DATABASE_URL is required.');
  }
  if (typeof environment.DATABASE_APP_ROLE !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,63}$/.test(environment.DATABASE_APP_ROLE)) {
    throw new Error('DATABASE_APP_ROLE is required.');
  }
  return {
    databaseUrl: environment.DATABASE_URL,
    appRole: environment.DATABASE_APP_ROLE,
  };
}

export async function runMigrations(direction = 'up', environment = process.env) {
  if (!['up', 'down'].includes(direction)) throw new Error('Invalid migration direction.');
  const configuration = validateMigrationEnvironment(environment);
  const previousRole = process.env.DATABASE_APP_ROLE;
  process.env.DATABASE_APP_ROLE = configuration.appRole;
  try {
    return await runner({
      databaseUrl: configuration.databaseUrl,
      dir: path.join(root, 'migrations'),
      direction,
      count: direction === 'down' ? 1 : undefined,
      migrationsTable: 'pgmigrations',
      log: () => {},
    });
  } finally {
    if (previousRole === undefined) delete process.env.DATABASE_APP_ROLE;
    else process.env.DATABASE_APP_ROLE = previousRole;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations(process.argv[2] || 'up').then(() => {
    console.info('Database migrations completed.');
  }).catch(() => {
    console.error('Database migration failed. Check the migration job configuration.');
    process.exitCode = 1;
  });
}
