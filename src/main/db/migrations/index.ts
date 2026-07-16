import type { DB } from '../index'

/**
 * FORWARD-ONLY MIGRATIONS. (CLAUDE.md §4)
 *
 * A shop will have years of sales in this file. There is no "down" migration, no rollback, no
 * "let's clean up the schema" — those are how you destroy a business's books. To change something:
 * ADD a column and backfill it. NEVER drop or rename a column that holds user data.
 *
 * Each migration runs INSIDE A TRANSACTION and is recorded in `schema_migrations`. If it throws,
 * SQLite rolls the whole thing back and the database is untouched — a half-applied migration is
 * the one failure mode we cannot recover from.
 */

export type Migration = {
  version: number
  name: string
  up: (db: DB) => void
}

import { migration0001 } from './0001_platform'
import { migration0002 } from './0002_ledger'
import { migration0003 } from './0003_catalog'
import { migration0004 } from './0004_pack_barcodes'
import { migration0005 } from './0005_opening'
import { migration0006 } from './0006_movement_value'
import { migration0007 } from './0007_sales'
import { migration0008 } from './0008_freeze_and_approver_role'
import { migration0009 } from './0009_customer_ledger'
import { migration0010 } from './0010_retire_clears_pin'
import { migration0011 } from './0011_returns'
import { migration0012 } from './0012_shifts'
import { migration0013 } from './0013_purchases'
import { migration0014 } from './0014_expenses'
import { migration0015 } from './0015_quote_validity'
import { migration0016 } from './0016_purchase_returns'
import { migration0017 } from './0017_loyalty'
import { migration0018 } from './0018_promotions'

/** Applied in ascending version order. Never renumber, never reorder, never edit a shipped one. */
export const MIGRATIONS: Migration[] = [
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
  migration0006,
  migration0007,
  migration0008,
  migration0009,
  migration0010,
  migration0011,
  migration0012,
  migration0013,
  migration0014,
  migration0015,
  migration0016,
  migration0017,
  migration0018
]

export function runMigrations(db: DB): { applied: number[]; alreadyAt: number } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `)

  const done = new Set(
    db.prepare('SELECT version FROM schema_migrations').pluck().all() as number[]
  )

  const applied: number[] = []
  const pending = [...MIGRATIONS].sort((a, b) => a.version - b.version)

  for (const migration of pending) {
    if (done.has(migration.version)) continue

    // Each migration is its own transaction. One bad migration cannot leave the DB half-changed.
    const run = db.transaction(() => {
      migration.up(db)
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString()
      )
    })

    run()
    applied.push(migration.version)
  }

  const alreadyAt =
    (db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get() as number | null) ?? 0

  return { applied, alreadyAt }
}
