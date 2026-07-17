import { z } from 'zod'

/**
 * THE PERIOD CONTRACT — closing the month.
 *
 * ── WHAT LOCKING A MONTH MEANS ──────────────────────────────────────────────────────────────────────
 * A locked month REFUSES new entries dated inside it. Not "warns" — refuses. Every journal goes through
 * `ledger.post`, which calls `assertPeriodOpen`, and every stock movement goes through `stock.record`,
 * which calls it too. So once March is locked, a sale, a return, a purchase, an expense or a stock
 * adjustment dated in March is turned away with ErrorCode.PERIOD_LOCKED and a sentence the shopkeeper
 * can act on. TODAY is untouched — locking March does not stop the shop trading in April.
 *
 * This is what stops last year's reported figures from quietly changing after the accountant has seen
 * them. It is also, deliberately, the only thing in this app that makes a past number un-editable.
 *
 * ── THE ENGINE ALREADY EXISTED. THIS IS THE DOOR TO IT. ─────────────────────────────────────────────
 * `ledger.lockPeriod` / `unlockPeriod` / `assertPeriodOpen` have been enforced since migration 0002.
 * There was simply no way to reach them — no IPC and no screen — so an owner could not actually close a
 * month. Nothing about the enforcement changes here; it just becomes reachable.
 *
 * ── OWNER ONLY, AND BOTH DIRECTIONS ARE AUDITED ─────────────────────────────────────────────────────
 * 'period.manage' is the owner's (CLAUDE.md §4 names period lock/unlock in its list of audited actions).
 * An UNLOCK especially: reopening a closed month is how books get quietly rewritten, so the log records
 * WHO reopened WHAT and WHEN. Listing is a READ — an expired shop still reads its own books (§6).
 */

/** A real month: 1-12, and a year the shop could plausibly be trading in. */
const Year = z
  .number()
  .int()
  .min(2000, 'Please pick a year from 2000 onwards.')
  .max(2100, 'Please pick a year up to 2100.')

const Month = z.number().int().min(1, 'Please pick a month.').max(12, 'Please pick a month.')

export const PeriodRefInput = z.object({
  year: Year,
  month: Month
})
export type PeriodRefInput = z.infer<typeof PeriodRefInput>

/**
 * Locking and unlocking take the SAME input, and neither takes a `userId` or a timestamp: MAIN stamps
 * the actor from the session and reads its own clock. A renderer that could name the user could sign
 * someone else's name to the act that freezes the books. (CLAUDE.md §3)
 */
export const LockPeriodInput = PeriodRefInput
export type LockPeriodInput = z.infer<typeof LockPeriodInput>

export const UnlockPeriodInput = PeriodRefInput
export type UnlockPeriodInput = z.infer<typeof UnlockPeriodInput>

/**
 * WHICH MONTHS TO LIST. Defaults to the last 24 — two years is what an owner actually looks at, and it
 * keeps the list bounded (CLAUDE.md §4: no unbounded reads).
 */
export const ListPeriodsInput = z
  .object({
    months: z.number().int().min(1).max(120).optional()
  })
  .optional()
export type ListPeriodsInput = z.infer<typeof ListPeriodsInput>

export type PeriodStatus = 'open' | 'locked'

export type PeriodRow = {
  year: number
  month: number
  /** 'January 2026' — built in MAIN so the list and the refusal message read the same. */
  label: string
  status: PeriodStatus
  /** Null when the month has never been locked. */
  lockedAt: string | null
  lockedByName: string | null
  /** How many journals are dated in this month — what the owner is freezing. */
  journalCount: number
  /**
   * Is this the month the shop is trading in RIGHT NOW? The UI warns before locking it, because
   * locking the current month stops today's sales — legal, occasionally intended, rarely wanted.
   */
  isCurrent: boolean
  /** A future month has nothing in it to freeze yet. The UI does not offer to lock one. */
  isFuture: boolean
}
