import type { DB } from '../db'
import type { User } from '@shared/types'
import { AppError, ErrorCode } from '@shared/result'
import type { ListPeriodsInput, PeriodRefInput, PeriodRow, PeriodStatus } from '@shared/periods'
import * as ledger from './ledger'
import * as audit from './audit'

/**
 * CLOSING THE MONTH — the door to a lock that has been enforced since migration 0002.
 *
 * ── THIS SERVICE ADDS NO ENFORCEMENT. IT ADDS A WAY IN. ─────────────────────────────────────────────
 * `ledger.assertPeriodOpen` is already called by `ledger.post` (every journal) and by `stock.record`
 * (every movement, even one that posts no journal). That is where a locked month actually bites, and
 * none of it changes here. What was missing was a way for an owner to USE it: no IPC, no screen, so the
 * lock existed and could never be turned. This is that door, and nothing more.
 *
 * ── WHAT LOCKING MEANS, IN SHOPKEEPER TERMS ─────────────────────────────────────────────────────────
 * Lock March, and nothing new can be dated in March: no sale, no return, no purchase, no expense, no
 * stock adjustment. April is untouched — the shop trades on exactly as before. This is what stops
 * last year's reported figures from quietly changing after the accountant has signed them off.
 *
 * ── BOTH DIRECTIONS ARE AUDITED, AND THE UNLOCK IS THE ONE THAT MATTERS ─────────────────────────────
 * CLAUDE.md §4 names "period lock/unlock" in its list of audited actions. A LOCK is a decision. An
 * UNLOCK is a decision with a motive: reopening a closed month is how books get quietly rewritten, and
 * the log is the only thing that will ever say who did it. Owner-only, enforced in MAIN.
 */

type PeriodDbRow = {
  year: number
  month: number
  status: PeriodStatus
  locked_at: string | null
  locked_by_name: string | null
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]

/**
 * 'March 2026'. Built HERE, in main, so the list on the screen and the refusal message the till shows
 * name the month the same way. (ledger.ts builds the same string for its refusal; both read this list.)
 */
export function periodLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1] ?? month} ${year}`
}

/**
 * THE MONTHS, NEWEST FIRST — status, when it was locked, who locked it, and how many journals are
 * dated in it (which is WHAT the owner is freezing).
 *
 * A month with no `periods` row has never been locked, and is therefore OPEN. Rows are only created
 * when someone locks one, so the list is BUILT from the calendar rather than read from the table —
 * otherwise a shop that has never locked anything would see an empty screen and no way to start.
 *
 * Bounded to the last N months (default 24). No unbounded read, ever. (CLAUDE.md §4)
 */
export function list(db: DB, input: ListPeriodsInput = {}, now = new Date()): PeriodRow[] {
  const months = Math.min(120, Math.max(1, input?.months ?? 24))

  // The locked ones, by key. One query, not one per month.
  const locked = new Map<string, PeriodDbRow>()
  const rows = db
    .prepare(
      `SELECT p.year, p.month, p.status, p.locked_at, u.full_name AS locked_by_name
       FROM periods p
       LEFT JOIN users u ON u.id = p.locked_by`
    )
    .all() as PeriodDbRow[]
  for (const row of rows) locked.set(`${row.year}-${row.month}`, row)

  // How many journals sit in each month. `journals` carries year/month columns and is indexed on them
  // (migration 0002: idx_journals_period), so this is one grouped scan of an index, not a scan per row.
  const counts = new Map<string, number>()
  const countRows = db
    .prepare('SELECT year, month, COUNT(*) AS n FROM journals GROUP BY year, month')
    .all() as Array<{ year: number; month: number; n: number }>
  for (const row of countRows) counts.set(`${row.year}-${row.month}`, row.n)

  const currentYear = now.getFullYear()
  const currentMonth = now.getMonth() + 1

  const result: PeriodRow[] = []
  for (let back = 0; back < months; back++) {
    // Walk back from the current month. Date handles the year rollover; building it by hand with
    // modulo arithmetic is how December becomes month 0.
    const cursor = new Date(currentYear, currentMonth - 1 - back, 1)
    const year = cursor.getFullYear()
    const month = cursor.getMonth() + 1
    const key = `${year}-${month}`
    const row = locked.get(key)

    result.push({
      year,
      month,
      label: periodLabel(year, month),
      // No row = never locked = open. (Exactly what assertPeriodOpen concludes.)
      status: row?.status ?? 'open',
      lockedAt: row?.locked_at ?? null,
      lockedByName: row?.locked_by_name ?? null,
      journalCount: counts.get(key) ?? 0,
      isCurrent: year === currentYear && month === currentMonth,
      // The list starts at the current month and walks BACKWARDS, so nothing here is ever in the
      // future. The flag is on the row because the UI asks the row, not the loop.
      isFuture: false
    })
  }

  return result
}

/** One month's status. What the UI asks before it offers a button. */
export function statusOf(db: DB, year: number, month: number): PeriodStatus {
  const status = db
    .prepare('SELECT status FROM periods WHERE year = ? AND month = ?')
    .pluck()
    .get(year, month) as PeriodStatus | undefined

  return status ?? 'open'
}

/**
 * CLOSE THE MONTH.
 *
 * Refuses a FUTURE month. There is nothing in it to freeze, and locking one is never what an owner
 * meant to do — it is a mis-click that quietly stops the shop trading when that month arrives, with no
 * error at the till until the day it happens. (Locking the CURRENT month is allowed: it is occasionally
 * exactly right — a shop closing its books on the last day of trading — and the screen warns first.)
 *
 * Locking an already-locked month is not an error. It is a no-op that says "yes, it is closed" — and it
 * is NOT audited a second time, because nothing changed and a log full of non-events is a log nobody
 * reads.
 */
export function lock(db: DB, actor: User, input: PeriodRefInput, now = new Date()): PeriodRow {
  assertNotFuture(input, now)

  const before = statusOf(db, input.year, input.month)
  if (before === 'locked') return rowFor(db, input, now)

  const run = db.transaction(() => {
    ledger.lockPeriod(db, input.year, input.month, actor.id, now)

    // WHO closed WHICH month and WHEN. (CLAUDE.md §4 names period lock/unlock explicitly.)
    audit.record(
      db,
      actor,
      {
        action: 'period.lock',
        entity: 'period',
        entityId: `${input.year}-${String(input.month).padStart(2, '0')}`,
        before: { status: before },
        after: { status: 'locked', label: periodLabel(input.year, input.month) }
      },
      now
    )
  })
  run()

  return rowFor(db, input, now)
}

/**
 * REOPEN A CLOSED MONTH. The owner's, and the one to watch.
 *
 * This is the act that lets a reported figure change after the fact. It is legitimate — a genuine
 * correction found in April to a March invoice has to go somewhere — but it is also exactly what
 * rewriting the books looks like, and the two are indistinguishable from the outside. So the log gets
 * WHO, WHICH MONTH, WHEN, and how many journals were sitting in it at the time.
 *
 * Unlocking an already-open month is a no-op, and is not audited: nothing was reopened.
 */
export function unlock(db: DB, actor: User, input: PeriodRefInput, now = new Date()): PeriodRow {
  const before = statusOf(db, input.year, input.month)
  if (before === 'open') return rowFor(db, input, now)

  const journalCount = db
    .prepare('SELECT COUNT(*) FROM journals WHERE year = ? AND month = ?')
    .pluck()
    .get(input.year, input.month) as number

  const run = db.transaction(() => {
    ledger.unlockPeriod(db, input.year, input.month, now)

    audit.record(
      db,
      actor,
      {
        action: 'period.unlock',
        entity: 'period',
        entityId: `${input.year}-${String(input.month).padStart(2, '0')}`,
        before: { status: 'locked' },
        // The journal count is the SIZE of what was just reopened — the difference between reopening a
        // quiet month and reopening the shop's busiest quarter.
        after: { status: 'open', label: periodLabel(input.year, input.month), journalCount }
      },
      now
    )
  })
  run()

  return rowFor(db, input, now)
}

/**
 * A month that has not happened yet holds nothing to freeze, and locking one is a trap: it does nothing
 * today and silently stops the till the day that month arrives.
 */
function assertNotFuture(input: PeriodRefInput, now: Date): void {
  const nowKey = now.getFullYear() * 12 + now.getMonth()
  const inputKey = input.year * 12 + (input.month - 1)

  if (inputKey > nowKey) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `${periodLabel(input.year, input.month)} has not happened yet, so there is nothing to close.`,
      `refusing to lock future period ${input.year}-${input.month}`
    )
  }
}

/** Read one month back in the shape the screen shows — so a lock/unlock returns the row it changed. */
function rowFor(db: DB, input: PeriodRefInput, now: Date): PeriodRow {
  const row = db
    .prepare(
      `SELECT p.year, p.month, p.status, p.locked_at, u.full_name AS locked_by_name
       FROM periods p
       LEFT JOIN users u ON u.id = p.locked_by
       WHERE p.year = ? AND p.month = ?`
    )
    .get(input.year, input.month) as PeriodDbRow | undefined

  const journalCount = db
    .prepare('SELECT COUNT(*) FROM journals WHERE year = ? AND month = ?')
    .pluck()
    .get(input.year, input.month) as number

  return {
    year: input.year,
    month: input.month,
    label: periodLabel(input.year, input.month),
    status: row?.status ?? 'open',
    lockedAt: row?.locked_at ?? null,
    lockedByName: row?.locked_by_name ?? null,
    journalCount,
    isCurrent: input.year === now.getFullYear() && input.month === now.getMonth() + 1,
    isFuture: input.year * 12 + (input.month - 1) > now.getFullYear() * 12 + now.getMonth()
  }
}
