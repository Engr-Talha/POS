import { join } from 'node:path'
import { app } from 'electron'
import { openDatabase, closeDatabase, type DB } from './index'
import { runMigrations } from './migrations'
import { seed } from './seed'
import { checkAndRecordClock } from '../security/clock-guard'
import log from '../logger'

/**
 * The one live database handle for the running app.
 *
 * This file — and ONLY this file — knows where the database lives. `db/index.ts` takes a path and
 * stays Electron-free so the services layer and the tests can use it without Electron. This is the
 * seam that keeps a future LAN server from being a rewrite (CLAUDE.md §3).
 *
 * ONE handle, ONE process. Never open the database from a second process, and NEVER put this file on
 * a network drive or a shared folder — SQLite over SMB corrupts (trap #20).
 */

let db: DB | null = null
let clockTampered = false

export function getDbPath(): string {
  return join(app.getPath('userData'), 'pos.db')
}

/** The clock-guard mirror lives OUTSIDE the database, so wiping one does not reset the other. */
function clockMirrorPath(): string {
  return join(app.getPath('userData'), '.clock')
}

export function initDb(): DB {
  if (db) return db

  const path = getDbPath()
  db = openDatabase(path)
  log.info(`[db] opened ${path}`)

  // Migrations run on EVERY launch, including right after an update installed a new version.
  // Forward-only, each in its own transaction.
  const { applied, alreadyAt } = runMigrations(db)
  if (applied.length) log.info(`[db] applied migrations: ${applied.join(', ')}`)
  log.info(`[db] schema version ${alreadyAt}`)

  // Idempotent — only ever inserts what is missing, so it can never undo the owner's edits.
  seed(db)

  const clock = checkAndRecordClock(db, clockMirrorPath())
  if (!clock.ok) {
    clockTampered = true
    log.warn(`[security] clock rolled back: last seen ${clock.lastSeen}, now ${clock.now}`)
  }

  return db
}

export function getDb(): DB {
  if (!db) throw new Error('Database used before initDb() — this is a startup-order bug.')
  return db
}

/** True when the system clock jumped backwards far enough to look like someone dodging expiry. */
export function isClockTampered(): boolean {
  return clockTampered
}

export function shutdownDb(): void {
  if (!db) return
  closeDatabase(db)
  db = null
  log.info('[db] closed cleanly')
}
