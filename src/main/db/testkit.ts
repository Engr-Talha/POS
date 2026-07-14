import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { openDatabase, closeDatabase, type DB } from './index'
import { runMigrations } from './migrations'
import { seed } from './seed'
import { AppError } from '@shared/result'

/**
 * Assert on the message THE CASHIER ACTUALLY SEES.
 *
 * An AppError carries two strings: `message` is the technical one (it goes to the log file), and
 * `userMessage` is the plain-language one shown on screen. A plain `.toThrow(/…/)` checks the
 * technical one — so it would happily pass while the shopkeeper is shown a stack trace. This checks
 * the one that matters, which makes "errors are friendly" a tested requirement rather than a hope.
 */
export function expectUserMessage(fn: () => unknown, pattern: RegExp): void {
  try {
    fn()
  } catch (error) {
    const shown = error instanceof AppError ? error.userMessage : (error as Error).message
    expect(shown).toMatch(pattern)
    return
  }
  throw new Error('Expected that call to fail, but it succeeded.')
}

/** Test-only. A real on-disk database (not :memory:) so WAL and the backup API behave for real. */
export type TestDb = {
  db: DB
  dir: string
  path: string
  cleanup: () => void
}

export function makeTestDb(options: { migrate?: boolean; withSeed?: boolean } = {}): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'pos-test-'))
  const path = join(dir, 'pos.db')
  const db = openDatabase(path)

  if (options.migrate !== false) runMigrations(db)
  if (options.withSeed) seed(db)

  return {
    db,
    dir,
    path,
    cleanup: () => {
      closeDatabase(db)
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
