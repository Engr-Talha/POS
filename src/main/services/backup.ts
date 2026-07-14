import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DB } from '../db'
import { openDatabase, closeDatabase } from '../db'
import type { BackupResult } from '@shared/types'
import { AppError, ErrorCode } from '@shared/result'
import { runMigrations } from '../db/migrations'

/**
 * BACKUP & RESTORE. Data safety is sacred (CLAUDE.md §2). This is the shop's money.
 *
 * WHY NOT JUST COPY THE FILE:
 * The brief said "backup = copy the file", and in WAL mode that is a TRAP. Recent commits live in
 * the -wal sidecar, not in the .db. A raw fs.copyFile of just the .db grabs a file that is missing
 * the last transactions, or worse, is torn mid-write. It LOOKS fine. It restores fine. You find out
 * it was corrupt on the day you actually need it — which is the day the disk died.
 *
 * So we use SQLite's ONLINE BACKUP API (`db.backup()`). It takes a consistent snapshot while the
 * app keeps running, and it folds the WAL in. Then we OPEN the result and run integrity_check on
 * it, because an unverified backup is a rumour, not a backup.
 */

function timestampName(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes())
  ].join('')
}

/** Verify a finished backup by opening it and asking SQLite whether it is intact. */
function verifyBackupFile(path: string): boolean {
  let check: DB | null = null
  try {
    check = openDatabase(path)
    const result = check.pragma('integrity_check', { simple: true })
    // A healthy database answers the literal string "ok".
    return result === 'ok'
  } catch {
    return false
  } finally {
    if (check) closeDatabase(check)
  }
}

/**
 * One-click backup. ALWAYS available — including when the licence has EXPIRED. A shop must always
 * be able to get its own data out; we never hold it hostage (CLAUDE.md §6).
 */
export async function backupTo(db: DB, directory: string, now = new Date()): Promise<BackupResult> {
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true })

  const path = join(directory, `pos-backup-${timestampName(now)}.db`)

  // The online backup API — consistent, WAL-aware, and safe to run while the cashier is selling.
  await db.backup(path)

  const verified = verifyBackupFile(path)
  if (!verified) {
    throw new AppError(
      ErrorCode.DB,
      'The backup could not be verified, so it was not trusted. Please try again, or choose a different folder (for example a USB drive).',
      `integrity_check failed for ${path}`
    )
  }

  return { path, sizeBytes: statSync(path).size, at: now.toISOString(), verified }
}

export type RestoreOutcome = {
  restoredFrom: string
  /** The safety copy we took of the CURRENT data before overwriting it. */
  safetyCopy: string
}

/**
 * RESTORE — overwrites the shop's live data. Treat it accordingly.
 *
 * The caller (IPC) is responsible for confirming with the user in plain language, and for being
 * Owner-only. This function is responsible for making the operation SURVIVABLE:
 *
 *   1. Refuse a backup file that does not pass integrity_check. Restoring a corrupt file OVER good
 *      data turns a scare into a catastrophe.
 *   2. Take a safety copy of the current database first — ALWAYS, even if they said not to.
 *   3. Swap the file in, then run migrations (the backup may be from an older version; migrations
 *      are forward-only, so this is safe).
 *   4. Verify the result. If anything is wrong, put the safety copy back and tell them nothing
 *      was lost.
 *
 * Returns the safety-copy path so the app can tell the user where their old data went.
 */
export function restoreFrom(
  livePath: string,
  backupPath: string,
  now = new Date()
): RestoreOutcome {
  if (!existsSync(backupPath)) {
    throw new AppError(ErrorCode.NOT_FOUND, 'That backup file could not be found.', backupPath)
  }

  // 1. Never restore something broken over something working.
  if (!verifyBackupFile(backupPath)) {
    throw new AppError(
      ErrorCode.DB,
      'That backup file is damaged and cannot be restored. Your current data has NOT been changed.',
      `integrity_check failed for ${backupPath}`
    )
  }

  // 2. Safety copy of what is there now. Non-negotiable.
  const safetyCopy = `${livePath}.before-restore-${timestampName(now)}`
  if (existsSync(livePath)) copyFileSync(livePath, safetyCopy)

  try {
    copyFileSync(backupPath, livePath)

    // 3. The backup may predate the current schema. Forward-only migrations make this safe.
    const restored = openDatabase(livePath)
    try {
      runMigrations(restored)
      const integrity = restored.pragma('integrity_check', { simple: true })
      if (integrity !== 'ok') throw new Error(`integrity_check = ${String(integrity)}`)
    } finally {
      closeDatabase(restored)
    }

    return { restoredFrom: backupPath, safetyCopy }
  } catch (error) {
    // 4. It went wrong. Put their data back exactly as it was.
    if (existsSync(safetyCopy)) copyFileSync(safetyCopy, livePath)

    throw new AppError(
      ErrorCode.DB,
      'The restore did not work, so your original data has been put back. Nothing was lost.',
      `restore failed: ${(error as Error).message}`
    )
  }
}
