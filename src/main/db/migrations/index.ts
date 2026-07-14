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

/** Applied in ascending version order. Never renumber, never reorder, never edit a shipped one. */
export const MIGRATIONS: Migration[] = [migration0001]

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
