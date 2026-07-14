import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, closeDatabase, type DB } from '../db'
import { databaseSelfCheck } from './system'

describe('database', () => {
  let dir: string
  let db: DB

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pos-test-'))
    db = openDatabase(join(dir, 'test.db'))
  })

  afterEach(() => {
    closeDatabase(db)
    rmSync(dir, { recursive: true, force: true })
  })

  it('opens in WAL mode with foreign keys ON', () => {
    // Both are load-bearing. WAL lets a report run while a sale is being rung up; foreign keys are
    // OFF by default in SQLite and are not optional in a system that holds a shop's books.
    const check = databaseSelfCheck(db)
    expect(check.journalMode).toBe('wal')
    expect(check.foreignKeys).toBe(true)
  })

  it('does a real write-and-read round trip through the native module', () => {
    // This is the check that catches trap #8 in the PACKAGED build: a better-sqlite3 left inside
    // app.asar loads fine in dev and dies at runtime. The app runs this on launch and shows it.
    const check = databaseSelfCheck(db)
    expect(check.roundTripOk).toBe(true)
    expect(check.sqliteVersion).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('enforces foreign keys for real, not just in the pragma', () => {
    db.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id));
    `)
    expect(() => db.prepare('INSERT INTO child (parent_id) VALUES (999)').run()).toThrow(
      /FOREIGN KEY/i
    )
  })
})
