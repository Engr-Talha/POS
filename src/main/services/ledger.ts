import type { DB } from '../db'
import { AppError, ErrorCode } from '@shared/result'
import type { AccountType, TrialBalance, TrialBalanceRow } from '@shared/accounting'

/**
 * THE POSTING ENGINE.
 *
 * ONE INVARIANT, above everything else:
 *
 *      FOR EVERY JOURNAL, SUM(debit) === SUM(credit).
 *
 * If that ever fails, the shop's books are wrong and every report built on them is a lie. So an
 * unbalanced journal is not "logged and skipped" — it THROWS, inside the transaction, and the whole
 * business event (the sale, the purchase) is rolled back with it. A sale that cannot be booked
 * correctly is a sale that must not happen. That is the deal.
 *
 * The cashier never sees a debit or a credit. This runs underneath.
 */

export type JournalLineInput = {
  /** Account CODE, not id — the owner can rename accounts, so names and ids are not the contract. */
  account: string
  debit?: number
  credit?: number
}

export type PostInput = {
  at?: Date
  /** What caused this: 'sale' | 'purchase' | 'expense' | 'opening' | 'adjustment' … */
  refType: string
  refId?: string | number
  memo: string
  lines: JournalLineInput[]
  userId?: number
}

/**
 * Post a balanced journal. Call this INSIDE the caller's transaction so that the business event and
 * its accounting land together or not at all.
 *
 * @returns the new journal id
 */
export function post(db: DB, input: PostInput): number {
  const at = input.at ?? new Date()

  if (input.lines.length < 2) {
    // Double-entry means at least two sides. One line cannot balance against anything.
    throw new AppError(
      ErrorCode.DB,
      'Something went wrong recording that in the accounts. Please try again.',
      `journal "${input.memo}" had ${input.lines.length} line(s); at least 2 are required`
    )
  }

  let totalDebit = 0
  let totalCredit = 0

  for (const line of input.lines) {
    const debit = line.debit ?? 0
    const credit = line.credit ?? 0

    // Integers only. A float here is how a ledger drifts a paisa at a time until nothing reconciles.
    if (!Number.isInteger(debit) || !Number.isInteger(credit)) {
      throw new AppError(
        ErrorCode.DB,
        'Something went wrong recording that in the accounts. Please try again.',
        `non-integer amount on ${line.account}: debit=${debit} credit=${credit}. Money must be integer minor units.`
      )
    }

    if (debit < 0 || credit < 0) {
      throw new AppError(
        ErrorCode.DB,
        'Something went wrong recording that in the accounts. Please try again.',
        `negative amount on ${line.account}. Credit the other account instead of debiting a negative.`
      )
    }

    if (debit > 0 && credit > 0) {
      throw new AppError(
        ErrorCode.DB,
        'Something went wrong recording that in the accounts. Please try again.',
        `line on ${line.account} is both a debit and a credit`
      )
    }

    if (debit === 0 && credit === 0) {
      throw new AppError(
        ErrorCode.DB,
        'Something went wrong recording that in the accounts. Please try again.',
        `line on ${line.account} has no amount`
      )
    }

    totalDebit += debit
    totalCredit += credit
  }

  // THE INVARIANT.
  if (totalDebit !== totalCredit) {
    throw new AppError(
      ErrorCode.DB,
      'Something went wrong recording that in the accounts. Nothing was saved. Please try again.',
      `UNBALANCED journal "${input.memo}": debits=${totalDebit} credits=${totalCredit} (out by ${totalDebit - totalCredit})`
    )
  }

  const year = at.getFullYear()
  const month = at.getMonth() + 1

  assertPeriodOpen(db, year, month)

  // ── Resolve EVERY account BEFORE writing anything ────────────────────────
  //
  // This used to happen inside the insert loop, and that was a real hole: a bad account code on the
  // SECOND line threw *after* the journal row and the first line had already been written, leaving a
  // partial, permanently unbalanced journal in the books. It only looked safe because most callers
  // happen to wrap post() in a transaction — an invariant this important must not depend on every
  // future caller remembering to do that.
  //
  // So: resolve first, write second.
  const findAccount = db.prepare('SELECT id FROM accounts WHERE code = ?')
  const resolved = input.lines.map((line) => {
    const account = findAccount.get(line.account) as { id: number } | undefined
    if (!account) {
      throw new AppError(
        ErrorCode.DB,
        'Something went wrong recording that in the accounts. Please try again.',
        `no such account: ${line.account}`
      )
    }
    return { accountId: account.id, debit: line.debit ?? 0, credit: line.credit ?? 0 }
  })

  // ── ...and write the whole thing atomically ──────────────────────────────
  //
  // better-sqlite3 nests transactions as SAVEPOINTs, so this is safe whether or not the caller has
  // already opened one. The journal and its lines land together, or not at all. There is no state of
  // the database in which half a journal exists.
  const write = db.transaction((): number => {
    const journalId = Number(
      db
        .prepare(
          `INSERT INTO journals (at, ref_type, ref_id, memo, created_by_user_id, year, month, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          at.toISOString(),
          input.refType,
          input.refId != null ? String(input.refId) : null,
          input.memo,
          input.userId ?? null,
          year,
          month,
          new Date().toISOString()
        ).lastInsertRowid
    )

    const insertLine = db.prepare(
      'INSERT INTO journal_lines (journal_id, account_id, debit, credit) VALUES (?, ?, ?, ?)'
    )

    for (const line of resolved) {
      insertLine.run(journalId, line.accountId, line.debit, line.credit)
    }

    return journalId
  })

  return write()
}

// ── Period lock ──────────────────────────────────────────────────────────────

/**
 * A locked month refuses new entries. This is what stops last year's reported figures from quietly
 * changing after the fact — including by accident.
 */
export function assertPeriodOpen(db: DB, year: number, month: number): void {
  const status = db
    .prepare('SELECT status FROM periods WHERE year = ? AND month = ?')
    .pluck()
    .get(year, month) as string | undefined

  // No row = never locked = open. Periods are only created when someone locks one.
  if (status === 'locked') {
    throw new AppError(
      ErrorCode.PERIOD_LOCKED,
      `${monthName(month)} ${year} has been closed, so it cannot be changed. Ask the owner to unlock it first.`,
      `period ${year}-${month} is locked`
    )
  }
}

export function lockPeriod(db: DB, year: number, month: number, userId: number, now = new Date()): void {
  db.prepare(
    `INSERT INTO periods (year, month, status, locked_by, locked_at, created_at)
     VALUES (?, ?, 'locked', ?, ?, ?)
     ON CONFLICT (year, month) DO UPDATE SET
       status = 'locked', locked_by = excluded.locked_by, locked_at = excluded.locked_at`
  ).run(year, month, userId, now.toISOString(), now.toISOString())
}

/** Owner only — enforced by the IPC layer. Always audited. */
export function unlockPeriod(db: DB, year: number, month: number, now = new Date()): void {
  db.prepare(
    `INSERT INTO periods (year, month, status, locked_by, locked_at, created_at)
     VALUES (?, ?, 'open', NULL, NULL, ?)
     ON CONFLICT (year, month) DO UPDATE SET status = 'open', locked_by = NULL, locked_at = NULL`
  ).run(year, month, now.toISOString())
}

// ── Reading the books ────────────────────────────────────────────────────────

/**
 * A running balance for one account, in its NATURAL direction:
 *   assets & expenses grow with debits; liabilities, equity & income grow with credits.
 * So a positive number always means "more of what this account is for".
 */
export function accountBalance(db: DB, code: string): number {
  const row = db
    .prepare(
      `SELECT a.type AS type, a.is_contra AS isContra,
              COALESCE(SUM(l.debit), 0)  AS debit,
              COALESCE(SUM(l.credit), 0) AS credit
       FROM accounts a
       LEFT JOIN journal_lines l ON l.account_id = a.id
       WHERE a.code = ?
       GROUP BY a.id`
    )
    .get(code) as
    | { type: AccountType; isContra: number; debit: number; credit: number }
    | undefined

  if (!row) {
    throw new AppError(ErrorCode.NOT_FOUND, 'That account could not be found.', `code=${code}`)
  }

  return isDebitNatured(row.type, Boolean(row.isContra))
    ? row.debit - row.credit
    : row.credit - row.debit
}

/**
 * Which side does this account naturally grow on?
 *
 *   assets & expenses      -> debit
 *   liabilities, equity & income -> credit
 *
 * A CONTRA account works backwards from its type: "Discounts Given" is an income account that
 * REDUCES income, so it grows on the debit side. Get this wrong and every discount and return shows
 * up with its sign flipped.
 */
export function isDebitNatured(type: AccountType, isContra = false): boolean {
  const naturallyDebit = type === 'asset' || type === 'expense'
  return isContra ? !naturallyDebit : naturallyDebit
}

/**
 * THE TRIAL BALANCE. Total debits must equal total credits across the WHOLE ledger.
 *
 * This is the standing test after every scenario in the test suite. If it ever fails, something has
 * written to the books without going through `post()`, and we want to know immediately — not in
 * March, when the shop's accountant asks why the numbers don't add up.
 */
export function trialBalance(db: DB, options: { upTo?: Date } = {}): TrialBalance {
  const upTo = options.upTo?.toISOString() ?? null

  const rows = db
    .prepare(
      `SELECT a.code, a.name, a.type, a.is_contra AS isContra,
              COALESCE(SUM(l.debit), 0)  AS debit,
              COALESCE(SUM(l.credit), 0) AS credit
       FROM accounts a
       LEFT JOIN journal_lines l ON l.account_id = a.id
       LEFT JOIN journals j ON j.id = l.journal_id
       WHERE (@upTo IS NULL OR j.at <= @upTo OR j.at IS NULL)
       GROUP BY a.id
       HAVING debit > 0 OR credit > 0
       ORDER BY a.code`
    )
    .all({ upTo }) as Array<{
    code: string
    name: string
    type: AccountType
    isContra: number
    debit: number
    credit: number
  }>

  let totalDebit = 0
  let totalCredit = 0

  const result: TrialBalanceRow[] = rows.map((row) => {
    // The TOTALS use the RAW debits and credits, not each account's net position. That is what makes
    // this a real check: it proves every journal balanced when it was written. Summing net positions
    // instead would balance by construction and prove nothing.
    totalDebit += row.debit
    totalCredit += row.credit

    // Each account is shown on ONE side — its net position, on its natural side.
    const debitNatured = isDebitNatured(row.type, Boolean(row.isContra))
    const net = debitNatured ? row.debit - row.credit : row.credit - row.debit

    return {
      code: row.code,
      name: row.name,
      type: row.type,
      debit: debitNatured ? Math.max(net, 0) : Math.max(-net, 0),
      credit: debitNatured ? Math.max(-net, 0) : Math.max(net, 0)
    }
  })

  return {
    rows: result,
    totalDebit,
    totalCredit,
    balanced: totalDebit === totalCredit
  }
}

function monthName(month: number): string {
  return [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ][month - 1] ?? String(month)
}
