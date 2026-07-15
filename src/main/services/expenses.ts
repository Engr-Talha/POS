import type { z } from 'zod'
import type { DB } from '../db'
import type { User } from '@shared/types'
import { AppError, ErrorCode } from '@shared/result'
import {
  CreateExpenseInput,
  ListExpensesInput,
  GetExpenseInput,
  type ExpenseDetail,
  type ExpenseList,
  type ExpenseListItem
} from '@shared/expenses'
import { ACC } from '../db/chart-of-accounts'
import * as audit from './audit'
import * as ledger from './ledger'
import { accountForPaymentMethod } from './sales'

/**
 * THE EXPENSES SERVICE — the shop's money going OUT on the NON-STOCK cost of running the place: rent,
 * wages, bills, transport, repairs. (Migration 0014.)
 *
 * A purchase brings stock in and re-averages its cost; an EXPENSE buys none — it is a running cost, so
 * it lands straight in the Profit & Loss. It is paid NOW from cash or the bank and posts ONE balanced
 * journal, exactly like a customer payment or a shift pay-out:
 *
 *       DR  <the expense account for its category>   amount
 *       CR  Cash / Bank / wallet (the tender)         amount
 *
 * ── CATEGORY → EXPENSE ACCOUNT ──────────────────────────────────────────────────────────────────────
 * The category is a live entry on the owner's OWN lookups('expense_category') list (CLAUDE.md §4 — no
 * hardcoded dropdowns). Its CODE is mapped to a chart expense account so the P&L breaks the spend down
 * by line; a category with no dedicated account — 'misc', or a custom one the owner invents — falls back
 * to General Expenses, so a new category always books somewhere sensible without a schema change.
 *
 * ── PAID NOW, NOT OWED ──────────────────────────────────────────────────────────────────────────────
 * The tender must resolve to REAL money — Cash or Bank. A tender whose account is Receivable ('credit')
 * or Payable is REFUSED in plain language: an unpaid bill is a liability, a later feature, not an
 * expense row that pretends the money already left.
 *
 * ── TRANSPORT-AGNOSTIC (CLAUDE.md §3) ───────────────────────────────────────────────────────────────
 * Plain args in, plain data out. No Result envelope, no `electron` import. The IPC layer zod-validates
 * again at its boundary, enforces the `expense.manage` / `expense.view` permissions, checks the
 * read-only/expired-licence block with assertWritable, and wraps the answer — exactly as the sale and
 * purchase handlers do. The period lock is reached through ledger.post, which refuses a locked month.
 */

// ═════════════════════════════════════════════════════════════════════════════
// Category → expense account
// ═════════════════════════════════════════════════════════════════════════════

/** What caused this journal, stored on it so the general ledger can point back at the expense. */
const EXPENSE_REF_TYPE = 'expense'

/**
 * The category CODE → chart expense-account map. A category the owner adds that is NOT in here — 'misc',
 * or any custom one — falls back to General Expenses, so a new list entry always books somewhere
 * sensible. These account codes are seeded by the chart of accounts (chart-of-accounts.ts).
 */
const CATEGORY_ACCOUNT: Record<string, string> = {
  rent: '5200',
  salaries: '5210',
  utilities: '5220',
  transport: '5230',
  repairs: '5240'
}

/** The expense account a category books to — its dedicated line, or General Expenses as the fallback. */
function expenseAccountForCategory(code: string): string {
  return CATEGORY_ACCOUNT[code] ?? ACC.EXPENSE_GENERAL
}

// ═════════════════════════════════════════════════════════════════════════════
// RECORD AN EXPENSE — one balanced journal
// ═════════════════════════════════════════════════════════════════════════════

/**
 * RECORD AN EXPENSE. In ONE transaction, or none of it:
 *
 *   1. validate the category is a LIVE lookups('expense_category') row → its code → its expense account;
 *   2. validate the tender is a LIVE lookups('payment_method') row whose account is Cash or Bank
 *      (refuse a Receivable/Payable tender — an expense is paid with real money);
 *   3. write the expenses row;
 *   4. post the balanced journal  DR expense account  CR tender;
 *   5. link the journal back onto the row (`journal_id`);
 *   6. audit 'expense.create' — WHO paid WHAT, for what, to whom.
 *
 * `at` (a day) dates the expense to WHEN IT WAS PAID; omit it and MAIN dates it to `now` (its own
 * clock). `userId` is the actor from MAIN, never trusted from the renderer (CLAUDE.md §4). The period
 * lock and the balance check are enforced inside ledger.post; if either fails, the whole thing rolls
 * back.
 */
export function createExpense(db: DB, actor: User, raw: unknown, now = new Date()): ExpenseDetail {
  const input = parseOrThrow(CreateExpenseInput, raw, 'expense.create')

  // WHAT it was for — a real, CURRENT entry on the owner's own list. This also rejects a wrong-list or
  // retired id (the "inactive/wrong-list lookup is refused" invariant).
  const category = requireLookup(
    db,
    'expense_category',
    input.categoryLookupId,
    'Please choose what this expense was for from the list.'
  )

  // HOW it was paid — a live payment_method whose account is real money.
  const method = requireLookup(
    db,
    'payment_method',
    input.methodLookupId,
    'Please choose how this expense was paid from the list.'
  )
  const tenderAccount = tenderAccountForMethod(method)
  const expenseAccount = expenseAccountForCategory(category.code)

  const at = resolveExpenseDate(input.at, now)

  const run = db.transaction((): number => {
    // journal_id is NULL for the instant between the row landing and the journal being attached — both
    // happen inside this one transaction, so a committed expense always carries its journal.
    const expenseId = Number(
      db
        .prepare(
          `INSERT INTO expenses
             (at, category_lookup_id, amount, method_lookup_id, payee, note, user_id, journal_id, created_at)
           VALUES
             (@at, @categoryLookupId, @amount, @methodLookupId, @payee, @note, @userId, NULL, @createdAt)`
        )
        .run({
          at: at.toISOString(),
          categoryLookupId: category.id,
          amount: input.amount,
          methodLookupId: method.id,
          payee: input.payee ?? null,
          note: input.note ?? null,
          userId: actor.id,
          createdAt: new Date().toISOString()
        }).lastInsertRowid
    )

    // DR the expense account (the cost hits the P&L), CR where the money actually left. Two equal legs,
    // so it balances by construction — the posting engine still re-checks, and refuses a locked month.
    const journalId = ledger.post(db, {
      at,
      refType: EXPENSE_REF_TYPE,
      refId: expenseId,
      memo: expenseMemo(category.label, input.payee ?? null),
      userId: actor.id,
      lines: [
        { account: expenseAccount, debit: input.amount },
        { account: tenderAccount, credit: input.amount }
      ]
    })

    db.prepare('UPDATE expenses SET journal_id = ? WHERE id = ?').run(journalId, expenseId)

    // WHO paid WHAT, for what, to whom (CLAUDE.md §4). The codes, so the audit reads without a join.
    audit.record(
      db,
      actor,
      {
        action: 'expense.create',
        entity: 'expense',
        entityId: expenseId,
        after: {
          category: category.code,
          amount: input.amount,
          method: method.code,
          payee: input.payee ?? null
        }
      },
      now
    )

    return expenseId
  })

  return getExpense(db, run())
}

// ═════════════════════════════════════════════════════════════════════════════
// READING — the list (with range totals) and one expense in full
// ═════════════════════════════════════════════════════════════════════════════

/**
 * THE EXPENSES LIST — paginated and indexed, newest first (assume years of rows, CLAUDE.md §4).
 * Filterable by date range and category. ALSO returns `totalMinor` and `total` for the WHOLE filtered
 * range — not just the page — so the screen can show "Rs X across N expenses" for the current filter.
 */
export function listExpenses(db: DB, raw: unknown = {}): ExpenseList {
  const input = parseOrThrow(ListExpensesInput, raw, 'expense.list')

  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 50))

  const where: string[] = []
  const params: Record<string, unknown> = {}

  if (input.categoryLookupId != null) {
    where.push('e.category_lookup_id = @categoryLookupId')
    params['categoryLookupId'] = input.categoryLookupId
  }
  if (input.from) {
    where.push('e.at >= @from')
    params['from'] = input.from
  }
  if (input.to) {
    // `to` is a DATE, and the WHOLE of that day is inside it — an expense paid at 18:40 must not fall
    // out of a report that says it covers that day. (The sales/reports date convention, CLAUDE.md §4.)
    where.push('e.at < @toExclusive')
    params['toExclusive'] = dayAfter(input.to)
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  // COUNT and SUM over the whole filtered range in one pass — the "Rs X across N expenses" figures.
  const totals = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(e.amount), 0) AS totalMinor FROM expenses e ${whereSql}`)
    .get(params) as { n: number; totalMinor: number }

  const rows = db
    .prepare(
      `SELECT e.id, e.at, e.category_lookup_id, e.amount, e.method_lookup_id, e.payee, e.note,
              e.user_id, e.journal_id, e.created_at,
              c.label     AS category_label,
              m.label     AS method_label,
              u.full_name AS user_name
         FROM expenses e
         LEFT JOIN lookups c ON c.id = e.category_lookup_id
         LEFT JOIN lookups m ON m.id = e.method_lookup_id
         LEFT JOIN users   u ON u.id = e.user_id
         ${whereSql}
        ORDER BY e.at DESC, e.id DESC
        LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as ExpenseJoinRow[]

  return {
    total: totals.n,
    page,
    pageSize,
    totalMinor: totals.totalMinor,
    rows: rows.map(hydrate)
  }
}

/** ONE EXPENSE in full — the row plus its category / method labels and the user's name. */
export function getExpense(db: DB, rawId: unknown): ExpenseDetail {
  const { id } = parseOrThrow(
    GetExpenseInput,
    typeof rawId === 'number' ? { id: rawId } : rawId,
    'expense.get'
  )

  const row = db
    .prepare(
      `SELECT e.id, e.at, e.category_lookup_id, e.amount, e.method_lookup_id, e.payee, e.note,
              e.user_id, e.journal_id, e.created_at,
              c.label     AS category_label,
              m.label     AS method_label,
              u.full_name AS user_name
         FROM expenses e
         LEFT JOIN lookups c ON c.id = e.category_lookup_id
         LEFT JOIN lookups m ON m.id = e.method_lookup_id
         LEFT JOIN users   u ON u.id = e.user_id
        WHERE e.id = ?`
    )
    .get(id) as ExpenseJoinRow | undefined

  if (!row) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That expense could not be found.',
      `expense id=${id} does not exist`
    )
  }
  return hydrate(row)
}

// ═════════════════════════════════════════════════════════════════════════════
// Row → domain
// ═════════════════════════════════════════════════════════════════════════════

type ExpenseJoinRow = {
  id: number
  at: string
  category_lookup_id: number
  amount: number
  method_lookup_id: number
  payee: string | null
  note: string | null
  user_id: number
  journal_id: number | null
  created_at: string
  category_label: string | null
  method_label: string | null
  user_name: string | null
}

/** A joined row → the hydrated shape the list and the single-expense view both return. */
function hydrate(row: ExpenseJoinRow): ExpenseListItem {
  return {
    id: row.id,
    at: row.at,
    categoryLookupId: row.category_lookup_id,
    amount: row.amount,
    methodLookupId: row.method_lookup_id,
    payee: row.payee,
    note: row.note,
    userId: row.user_id,
    journalId: row.journal_id,
    createdAt: row.created_at,
    categoryLabel: row.category_label,
    methodLabel: row.method_label,
    userName: row.user_name
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A real, CURRENT entry on one of the owner's own lists — never a hardcoded option (CLAUDE.md §4). The
 * `list_key` filter is what refuses a wrong-list id (a payment_method passed where a category is wanted),
 * and `is_active = 1` refuses a retired one. Both are the "inactive/wrong-list lookup is refused" rule.
 */
function requireLookup(
  db: DB,
  listKey: string,
  id: number,
  userMessage: string
): { id: number; code: string; label: string } {
  const row = db
    .prepare('SELECT id, code, label FROM lookups WHERE list_key = ? AND id = ? AND is_active = 1')
    .get(listKey, id) as { id: number; code: string; label: string } | undefined

  if (!row) {
    throw new AppError(ErrorCode.VALIDATION, userMessage, `unknown or inactive ${listKey} lookup id=${id}`)
  }
  return row
}

/**
 * WHERE THE MONEY LEFT. Reuses the SAME method → account mapping a sale uses
 * (`sales.accountForPaymentMethod`), so this cannot disagree with the ledger about what "cash" is.
 *
 * An expense is paid with REAL money, so only Cash and Bank are allowed. Anything that resolves
 * elsewhere is REFUSED: 'credit' maps to Receivable (an unpaid bill, not an expense), and any tender
 * mapping to Payable would be the same — a promise, not money that has left. A plain sentence, not a
 * silently mis-booked journal.
 */
function tenderAccountForMethod(method: { code: string }): string {
  const account = accountForPaymentMethod(method.code)
  if (account !== ACC.CASH && account !== ACC.BANK) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'An expense must be paid with real money — cash or bank. An unpaid bill is not an expense; record it when you actually pay it.',
      `expense tender "${method.code}" resolves to ${account}, not Cash or Bank`
    )
  }
  return account
}

/** A short journal memo — the category, and the payee if there is one. */
function expenseMemo(categoryLabel: string, payee: string | null): string {
  return payee ? `${categoryLabel} — ${payee}` : categoryLabel
}

/**
 * The paid date. `at` (a day) dates the expense to LOCAL NOON, so a shop east of Greenwich cannot have
 * it filed under the previous UTC day (the same trap purchases.ts and opening.commit guard). Omit it and
 * the expense is dated to `now` (MAIN's clock). The zod schema has already checked the shape; the NaN
 * guard is defence in depth.
 */
function resolveExpenseDate(atDate: string | undefined, now: Date): Date {
  if (atDate == null) return now
  const at = new Date(`${atDate}T12:00:00`)
  if (Number.isNaN(at.getTime())) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Please pick the date this expense was paid.',
      `unparseable expense date "${atDate}"`
    )
  }
  return at
}

/** The day AFTER an ISO date — an exclusive upper bound so a whole day is included in a range. */
function dayAfter(isoDate: string): string {
  const date = new Date(`${isoDate.slice(0, 10)}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

/**
 * Validate at the SERVICE boundary, not only at the IPC one. The services layer is the real boundary
 * (CLAUDE.md §3) — vitest calls it directly today and a LAN server will call it tomorrow. The zod
 * messages are already written in language a cashier reads.
 */
function parseOrThrow<S extends z.ZodType>(schema: S, raw: unknown, context: string): z.output<S> {
  const parsed = schema.safeParse(raw)

  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new AppError(
      ErrorCode.VALIDATION,
      issue?.message ?? 'Please check the details and try again.',
      `${context}: ${JSON.stringify(parsed.error.issues)}`
    )
  }

  return parsed.data as z.output<S>
}
