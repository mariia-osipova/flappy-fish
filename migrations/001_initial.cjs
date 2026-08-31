'use strict';

exports.shorthands = undefined;

function runtimeRole() {
  const value = process.env.DATABASE_APP_ROLE;
  if (value === undefined || value === '') return null;
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(value)) {
    throw new Error('DATABASE_APP_ROLE must be a PostgreSQL role identifier.');
  }
  return `"${value}"`;
}

exports.up = (pgm) => {
  const appRole = runtimeRole();
  pgm.sql(`
    CREATE TABLE games (
      game_id              uuid PRIMARY KEY,
      owner_id             uuid NOT NULL,

      name                 text NOT NULL,
      rank_key             text NOT NULL,

      begin_request_id     varchar(80) NOT NULL,
      begin_request_hash   char(64) NOT NULL,

      rules_version        varchar(120) NOT NULL,
      seed                 bigint NOT NULL,

      snapshot             jsonb NOT NULL,
      seq                  bigint NOT NULL,
      state_hash           char(64) NOT NULL,

      status               text NOT NULL,
      lease_epoch          bigint NOT NULL,
      lease_until_ms       bigint NOT NULL,

      created_at_ms        bigint NOT NULL,
      updated_at_ms        bigint NOT NULL,

      last_request_id      varchar(80) NOT NULL,
      last_request_hash    char(64) NOT NULL,
      last_action          text NOT NULL,

      elapsed_active_ms    bigint NOT NULL,
      active_since_ms      bigint NULL,
      final_score          bigint NULL,

      CONSTRAINT games_owner_begin_request_unique
        UNIQUE (owner_id, begin_request_id),

      CONSTRAINT games_status_check
        CHECK (status IN ('active', 'paused', 'completed')),

      CONSTRAINT games_last_action_check
        CHECK (last_action IN ('begin', 'checkpoint', 'resume')),

      CONSTRAINT games_seq_check
        CHECK (seq >= 0),

      CONSTRAINT games_lease_epoch_check
        CHECK (lease_epoch >= 1),

      CONSTRAINT games_elapsed_check
        CHECK (elapsed_active_ms >= 0),

      CONSTRAINT games_seed_check
        CHECK (seed BETWEEN 0 AND 4294967295),

      CONSTRAINT games_snapshot_object_check
        CHECK (jsonb_typeof(snapshot) = 'object'),

      CONSTRAINT games_final_score_check
        CHECK (
          (status = 'completed' AND final_score IS NOT NULL)
          OR
          (status <> 'completed' AND final_score IS NULL)
        )
    );

    CREATE INDEX games_owner_created_idx
      ON games (owner_id, created_at_ms DESC);

    CREATE INDEX games_active_lease_idx
      ON games (lease_until_ms)
      WHERE status = 'active';

    CREATE INDEX games_completed_rank_idx
      ON games (rank_key, final_score DESC, updated_at_ms DESC)
      WHERE status = 'completed';

    CREATE TABLE legacy_scores (
      rank_key       text PRIMARY KEY,
      name           text NOT NULL,
      best_score     bigint NOT NULL CHECK (best_score >= 0),
      updated_at_ms  bigint NULL,
      source_row     integer NULL
    );
  `);
  if (appRole) {
    // Northflank exposes distinct administrator and runtime users. Objects
    // created by the admin migration job are not automatically writable by
    // the least-privileged application role.
    pgm.sql(`
      GRANT USAGE ON SCHEMA public TO ${appRole};
      GRANT SELECT, INSERT, UPDATE, DELETE
        ON TABLE games, legacy_scores TO ${appRole};
    `);
  }
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE legacy_scores;
    DROP TABLE games;
  `);
};
