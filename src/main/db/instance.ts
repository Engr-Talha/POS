import { join } from 'node:path'
import { app } from 'electron'
import { openDatabase, closeDatabase, type DB } from './index'
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

export function getDbPath(): string {
  return join(app.getPath('userData'), 'pos.db')
}

export function initDb(): DB {
  if (db) return db

  const path = getDbPath()
  db = openDatabase(path)
  log.info(`[db] opened ${path}`)
  return db
}

export function getDb(): DB {
  if (!db) throw new Error('Database used before initDb() — this is a startup-order bug.')
  return db
}

export function shutdownDb(): void {
  if (!db) return
  closeDatabase(db)
  db = null
  log.info('[db] closed cleanly')
}
