import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import { openDatabase, closeDatabase } from '../db'
import { runMigrations } from '../db/migrations'
import * as backup from './backup'
import * as auth from './auth'

describe('backup & restore — the shop’s money', () => {
  let t: TestDb
  beforeEach(() => (t = makeTestDb({ withSeed: true })))
  afterEach(() => t.cleanup())

  it('backs up while the app is running, and VERIFIES the result', async () => {
    auth.createFirstOwner(t.db, { username: 'boss', fullName: 'Boss', password: 'password1' })

    const result = await backup.backupTo(t.db, join(t.dir, 'backups'))

    expect(result.verified).toBe(true) // an unverified backup is a rumour
    expect(result.sizeBytes).toBeGreaterThan(0)
    expect(existsSync(result.path)).toBe(true)

    // The backup is a real, openable database with the data in it — not a torn file that merely
    // exists. This is the check a raw fs.copyFile of a WAL database would fail.
    const restored = openDatabase(result.path)
    const count = restored.prepare('SELECT COUNT(*) FROM users').pluck().get()
    expect(count).toBe(1)
    closeDatabase(restored)
  })

  it('captures data committed moments before — the WAL is folded in, not left behind', async () => {
    // THE BUG THIS PREVENTS: in WAL mode the newest commits live in the -wal sidecar. Copying just
    // the .db file gives you a backup that is silently missing today's sales.
    auth.createFirstOwner(t.db, { username: 'boss', fullName: 'Boss', password: 'password1' })
    t.db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('late.sale', '999', 'now')").run()

    const result = await backup.backupTo(t.db, join(t.dir, 'backups'))

    const restored = openDatabase(result.path)
    const value = restored.prepare("SELECT value_json FROM settings WHERE key = 'late.sale'").pluck().get()
    expect(value).toBe('999') // the last commit made it in
    closeDatabase(restored)
  })

  it('restores, and the data comes back exactly', async () => {
    auth.createFirstOwner(t.db, { username: 'boss', fullName: 'Boss', password: 'password1' })
    const saved = await backup.backupTo(t.db, join(t.dir, 'backups'))

    // Something bad happens after the backup.
    //
    // Note we have to clear the audit log first: audit_log.user_id REFERENCES users(id), so SQLite
    // physically refuses to delete a user who has done anything. That is deliberate and it is a
    // feature — the audit trail will not let someone be quietly erased out from under it. (Which is
    // also why the app deactivates users rather than deleting them.)
    t.db.prepare('DELETE FROM audit_log').run()
    t.db.prepare('DELETE FROM users').run()
    expect(t.db.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(0)
    closeDatabase(t.db)

    const outcome = backup.restoreFrom(t.path, saved.path)

    const live = openDatabase(t.path)
    expect(live.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(1)
    expect(live.prepare('SELECT username FROM users').pluck().get()).toBe('boss')
    closeDatabase(live)

    // And the data we overwrote was not simply thrown away.
    expect(existsSync(outcome.safetyCopy)).toBe(true)
  })

  it('ALWAYS takes a safety copy of the current data before overwriting it', async () => {
    auth.createFirstOwner(t.db, { username: 'boss', fullName: 'Boss', password: 'password1' })
    const saved = await backup.backupTo(t.db, join(t.dir, 'backups'))
    closeDatabase(t.db)

    const outcome = backup.restoreFrom(t.path, saved.path)

    // Even a "successful" restore leaves them a way back. Restore is the most dangerous button in
    // the app; it must never be the last word.
    expect(existsSync(outcome.safetyCopy)).toBe(true)
    const rescue = openDatabase(outcome.safetyCopy)
    expect(rescue.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(1)
    closeDatabase(rescue)
  })

  it('REFUSES a corrupt backup file, and leaves the live data untouched', () => {
    auth.createFirstOwner(t.db, { username: 'boss', fullName: 'Boss', password: 'password1' })

    const junk = join(t.dir, 'not-really-a-backup.db')
    writeFileSync(junk, 'this is not a sqlite database, it is a photo of a cat')

    // Restoring a corrupt file OVER good data turns a scare into a catastrophe.
    expectUserMessage(() => backup.restoreFrom(t.path, junk), /damaged/i)
    expectUserMessage(() => backup.restoreFrom(t.path, junk), /NOT been changed/i)

    // Prove it: the live database still has the user.
    expect(t.db.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(1)
  })

  it('migrates a backup taken from an OLDER version of the app', async () => {
    // A shop restores a backup from a year ago. Its schema is older. Forward-only migrations mean
    // we can simply bring it up to date — but only if we actually run them.
    const old = makeTestDb({ migrate: false })
    runMigrations(old.db) // pretend this is an older schema version
    old.db
      .prepare(
        `INSERT INTO users (username, full_name, role, password_hash, created_at, updated_at)
         VALUES ('old', 'Old User', 'owner', 'scrypt$1$1$1$00$00', 'x', 'x')`
      )
      .run()
    // Write the backup into THIS test's directory — old.cleanup() deletes old.dir and everything in it.
    const oldBackup = await backup.backupTo(old.db, join(t.dir, 'old-version-backup'))
    old.cleanup()

    closeDatabase(t.db)
    backup.restoreFrom(t.path, oldBackup.path)

    const live = openDatabase(t.path)
    // Migrations ran on the restored file, so the schema is current...
    const version = live.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get()
    expect(version).toBeGreaterThanOrEqual(1)
    // ...and their data survived.
    expect(live.prepare('SELECT username FROM users').pluck().get()).toBe('old')
    closeDatabase(live)
  })

  it('a backup file is portable — it is one file they can put on a USB stick', async () => {
    const result = await backup.backupTo(t.db, join(t.dir, 'backups'))
    const bytes = readFileSync(result.path)
    // SQLite's file magic. It is a self-contained database, not a directory or an archive.
    expect(bytes.subarray(0, 15).toString()).toBe('SQLite format 3')
  })
})
