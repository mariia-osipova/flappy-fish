'use strict';

exports.shorthands = undefined;

function runtimeRole() {
  const value = process.env.DATABASE_APP_ROLE;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,63}$/.test(value)) {
    throw new Error('DATABASE_APP_ROLE must name the ordinary PostgreSQL runtime role.');
  }
  return `"${value}"`;
}

exports.up = (pgm) => {
  const appRole = runtimeRole();
  // This separate migration repairs databases where 001 was applied before a
  // distinct Northflank runtime role was configured, and removes the broader
  // grants issued by an early development version of 001.
  pgm.sql(`
    REVOKE ALL PRIVILEGES ON TABLE games FROM ${appRole};
    REVOKE ALL PRIVILEGES ON TABLE legacy_scores FROM ${appRole};
    REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${appRole};
    GRANT USAGE ON SCHEMA public TO ${appRole};
    GRANT SELECT, INSERT, UPDATE ON TABLE games TO ${appRole};
    GRANT SELECT ON TABLE legacy_scores TO ${appRole};
  `);
};

exports.down = (pgm) => {
  const appRole = runtimeRole();
  pgm.sql(`
    REVOKE SELECT, INSERT, UPDATE ON TABLE games FROM ${appRole};
    REVOKE SELECT ON TABLE legacy_scores FROM ${appRole};
    REVOKE USAGE ON SCHEMA public FROM ${appRole};
  `);
};
