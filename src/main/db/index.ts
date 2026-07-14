import Database from 'better-sqlite3'

export type DB = Database.Database

/**
 * Open the shop's database.
 *
 * Takes a PATH, not an Electron app object, so the services layer and the tests can open a database
 * without Electron anywhere in sight. (Same reason it will be able to run inside a LAN server later
 * without a rewrite — CLAUDE.md §3.)
 */
export function openDatabase(filePath: string): DB {
  const db = new Database(filePath)

  // WAL: readers never block the writer. A report can run while the cashier is ringing up a sale.
  db.pragma('journal_mode = WAL')

  // Referential integrity is OFF by default in SQLite. It is not optional here.
  db.pragma('foreign_keys = ON')

  // FULL, not NORMAL. With NORMAL, a power cut can lose the last committed transaction — and the
  // last committed transaction is a sale the customer already paid for and walked out with.
  // The fsync costs a millisecond. A thousand sales a day cannot notice it; the shop would notice
  // a missing sale. Data safety is sacred (CLAUDE.md §2).
  db.pragma('synchronous = FULL')

  // Don't fail instantly if another connection holds the write lock; wait for it.
  db.pragma('busy_timeout = 5000')

  return db
}

/**
 * Close cleanly. Call before backup/restore and on quit — an unclosed handle is how the WAL ends up
 * out of step with the .db file.
 */
export function closeDatabase(db: DB): void {
  if (db.open) db.close()
}
