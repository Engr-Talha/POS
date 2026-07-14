import type { DB } from '../db'
import type { DbSelfCheck } from '@shared/ipc'

/**
 * Services are TRANSPORT-AGNOSTIC (CLAUDE.md §3): plain arguments in, plain data out, no `electron`
 * import anywhere. That is what lets vitest call them directly, and what will let a LAN server call
 * them later without a rewrite.
 */

/**
 * Prove the database is genuinely working — not just that the app started.
 *
 * This exists because of trap #8: better-sqlite3 is a native .node binary, and if it is left inside
 * app.asar it cannot be loaded at runtime. The failure is invisible in dev (where nothing is packed)
 * and fatal in the packaged build. So the app performs a REAL write-and-read round trip on launch
 * and shows the result on screen. If asarUnpack ever regresses, we find out on the first click of
 * the packaged build — not from a shopkeeper whose till stopped working.
 */
export function databaseSelfCheck(db: DB): DbSelfCheck {
  const sqliteVersion = db.prepare('SELECT sqlite_version() AS v').pluck().get() as string
  const journalMode = db.pragma('journal_mode', { simple: true }) as string
  const foreignKeys = db.pragma('foreign_keys', { simple: true }) === 1

  // A real round trip through the native module — create, write, read back, clean up.
  db.exec('CREATE TABLE IF NOT EXISTS _selfcheck (id INTEGER PRIMARY KEY, note TEXT NOT NULL)')
  const marker = `selfcheck-${Date.now()}`
  db.prepare('DELETE FROM _selfcheck').run()
  db.prepare('INSERT INTO _selfcheck (note) VALUES (?)').run(marker)
  const readBack = db.prepare('SELECT note FROM _selfcheck').pluck().get() as string | undefined
  db.prepare('DELETE FROM _selfcheck').run()

  return {
    sqliteVersion,
    journalMode,
    foreignKeys,
    roundTripOk: readBack === marker
  }
}
