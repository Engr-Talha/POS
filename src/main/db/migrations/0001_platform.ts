import type { Migration } from './index'

/**
 * 0001 — the platform tables everything else hangs off.
 *
 * Money/quantity columns appear in later migrations, but the rule is set here: money is INTEGER
 * minor units, quantity is INTEGER thousandths. There is not a single REAL column in this app.
 */
export const migration0001: Migration = {
  version: 1,
  name: 'platform: settings, lookups, users, audit, license',
  up: (db) => {
    db.exec(`
      -- ── Settings ────────────────────────────────────────────────────────────
      -- Key/value so a new setting never needs a migration. Namespaced: shop.*, tax.*, receipt.*
      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- ── Lookups ─────────────────────────────────────────────────────────────
      -- EVERY dropdown in the app reads from here. No hardcoded <Select> options, ever.
      -- is_system rows are ones the app's own logic depends on: they can be RENAMED and
      -- DEACTIVATED by the owner, but never deleted, or that logic loses its footing.
      CREATE TABLE lookups (
        id         INTEGER PRIMARY KEY,
        list_key   TEXT NOT NULL,
        code       TEXT NOT NULL,
        label      TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_active  INTEGER NOT NULL DEFAULT 1,
        is_system  INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (list_key, code)
      );
      CREATE INDEX idx_lookups_list ON lookups (list_key, is_active, sort_order);

      -- ── Users ───────────────────────────────────────────────────────────────
      -- password_hash / pin_hash are scrypt. A PIN is for the quick cashier switch on the sell
      -- screen; it is NOT a password and cannot be used to reach Settings.
      CREATE TABLE users (
        id            INTEGER PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE,
        full_name     TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('cashier', 'supervisor', 'manager', 'owner')),
        password_hash TEXT NOT NULL,
        pin_hash      TEXT,
        is_active     INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX idx_users_active ON users (is_active, username);

      -- ── Audit log ───────────────────────────────────────────────────────────
      -- WHO did WHAT and WHEN. The name and ROLE are COPIED IN, not joined:
      -- if a user is later renamed or demoted, the audit trail must still say what was true
      -- AT THE TIME. A join would quietly rewrite history.
      -- This table is APPEND-ONLY. Nothing in the app ever updates or deletes a row here.
      CREATE TABLE audit_log (
        id                  INTEGER PRIMARY KEY,
        at                  TEXT NOT NULL,
        user_id             INTEGER REFERENCES users (id),
        user_name           TEXT NOT NULL,
        user_role           TEXT NOT NULL,
        action              TEXT NOT NULL,
        entity              TEXT,
        entity_id           TEXT,
        reason_code         TEXT,
        reason_text         TEXT,
        before_json         TEXT,
        after_json          TEXT,
        approved_by_user_id INTEGER REFERENCES users (id),
        approved_by_name    TEXT
      );
      CREATE INDEX idx_audit_at ON audit_log (at DESC);
      CREATE INDEX idx_audit_action ON audit_log (action, at DESC);
      CREATE INDEX idx_audit_user ON audit_log (user_id, at DESC);

      -- ── License ─────────────────────────────────────────────────────────────
      -- One row, always id = 1. The signed key is kept verbatim so we can re-verify it on every
      -- launch rather than trusting what we parsed out of it last time.
      CREATE TABLE license (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        key_text      TEXT NOT NULL,
        licensee      TEXT NOT NULL,
        machine_id    TEXT NOT NULL,
        plan          TEXT NOT NULL,
        issued_at     TEXT NOT NULL,
        expires_at    TEXT,             -- NULL = lifetime
        features_json TEXT NOT NULL DEFAULT '{}',
        activated_at  TEXT NOT NULL
      );

      -- ── Clock guard ─────────────────────────────────────────────────────────
      -- Last time we saw the clock. Mirrored to a file outside the DB. If system time jumps
      -- BACKWARDS beyond tolerance, someone is trying to outrun an expiry date.
      CREATE TABLE clock_guard (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        last_seen_at TEXT NOT NULL
      );
    `)
  }
}
