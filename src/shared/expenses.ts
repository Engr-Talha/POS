import { z } from 'zod'
import type { PagedResult } from './sales'

/**
 * THE EXPENSES CONTRACT — the types and input schemas main and renderer agree on. (Migration 0014.)
 *
 * An EXPENSE is the shop's money going OUT on the NON-STOCK cost of running the place — rent, wages,
 * bills, transport, repairs. A purchase brings stock in (shared/purchases.ts); an expense buys none, so
 * it lands straight in the Profit & Loss. It is paid NOW from cash or the bank and posts ONE balanced
 * journal:
 *
 *       DR  <the expense account for its category>   amount
 *       CR  Cash / Bank / wallet (the tender it was paid with)   amount
 *
 * ── THE RENDERER SENDS INTENT. MAIN DECIDES THE ACCOUNTS. ──────────────────────────────────────────
 * The input says WHAT it was for (`categoryLookupId`), HOW MUCH, and HOW it was paid
 * (`methodLookupId`). It does NOT name a ledger account — the service maps the category CODE to an
 * expense account and the method CODE to Cash/Bank, so the renderer cannot post money to the wrong
 * place. `userId` is never sent (it is the authenticated session in MAIN).
 *
 * ── MONEY IS INTEGER 2-dp MINOR UNITS. NEVER A FLOAT. (CLAUDE.md §4) ────────────────────────────────
 *   `amount` and every money field on the way back are integer paisa/cents.
 *
 * ── PAID NOW, NOT OWED ──────────────────────────────────────────────────────────────────────────────
 * v1 records expenses that are PAID (cash / bank / wallet). The service refuses a tender whose account
 * is Receivable or Payable — an unpaid bill is a liability, a later feature, not an expense row that
 * pretends the money already left.
 */

// ── Schema primitives ──────────────────────────────────────────────────────────
// Validated in MAIN, before anything reaches the service (and by the service itself — the services
// layer is the real boundary, CLAUDE.md §3). We send ONLY the editable fields and use `.nullish()` for
// the nullable columns. (CLAUDE.md §4, trap #18 — never POST a whole object back.)

/** Integer money that must actually be an amount. A zero expense is not an expense. */
const PositiveMoneyMinor = z.number().int().positive('Please enter an amount greater than zero.')
const LookupId = z.number().int().positive()
const RowId = z.number().int().positive()

/** ISO date, YYYY-MM-DD. The paid date and the list bounds are DAYS, not timestamps. */
const IsoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Please pick a date.')
  // ...and a REAL calendar date. The shape alone lets 2026-02-30 through, and JS silently rolls it to
  // March 2 — so an expense typed at the service/LAN boundary would land in the wrong P&L month with no
  // error. Reject anything whose parts do not round-trip. (Expenses audit.)
  .refine((value) => {
    const parts = value.split('-')
    const year = Number(parts[0])
    const month = Number(parts[1])
    const day = Number(parts[2])
    const date = new Date(Date.UTC(year, month - 1, day))
    return (
      date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    )
  }, 'That is not a real calendar date.')

// ── Read types (row side) ──────────────────────────────────────────────────────

/**
 * One expense, as stored (migration 0014). Every money field is 2-dp INTEGER minor units.
 *
 * `categoryLookupId` is a live entry on the owner's own lookups('expense_category') list — WHAT it was
 * for. `methodLookupId` is a lookups('payment_method') — HOW it was paid (cash / bank / wallet).
 * `journalId` is the balanced journal it posted; NULL only for the instant between the row landing and
 * the journal being attached inside one transaction — a committed expense always carries one.
 */
export type Expense = {
  id: number
  /** ISO8601 — WHEN it was paid. The list is ordered by it. */
  at: string
  /** lookups('expense_category') — WHAT it was for. The service maps it to an expense account. */
  categoryLookupId: number
  /** 2-dp money, always POSITIVE — money paid OUT. */
  amount: number
  /** lookups('payment_method') — HOW it was paid. Cash / bank / wallet only, never 'credit'. */
  methodLookupId: number
  /** Who it was paid to (the landlord, the electricity company). Free text. Not a stock supplier. */
  payee: string | null
  note: string | null
  /** WHO recorded it. Never null on a committed row. */
  userId: number
  /** The balanced journal this expense posted (DR expense account, CR the tender). */
  journalId: number | null
  createdAt: string
}

/**
 * A row hydrated with the human labels the screen shows — used by BOTH the list and the single-expense
 * view, which have the same shape. The three labels are JOINED for display, never stored on the row; a
 * label is null only if the owner has since removed the lookup or the user was deleted.
 */
export type ExpenseListItem = Expense & {
  /** lookups('expense_category').label — display this, not the id. */
  categoryLabel: string | null
  /** lookups('payment_method').label. */
  methodLabel: string | null
  /** users.full_name of whoever recorded it. */
  userName: string | null
}

/** One expense in full — the same hydrated shape the list returns. Named for the get() call site. */
export type ExpenseDetail = ExpenseListItem

/**
 * ONE PAGE of the expenses list, PLUS the totals for the WHOLE filtered range (not just this page), so
 * the screen can show "Rs X across N expenses" for the current filter. `total` is the row COUNT (from
 * PagedResult); `totalMinor` is the summed amount — both over the filter, both derived on read.
 */
export type ExpenseList = PagedResult<ExpenseListItem> & {
  /** 2-dp money. Σ amount over the whole filtered range — NOT just the rows on this page. */
  totalMinor: number
}

export type { PagedResult }

// ── Input schemas ──────────────────────────────────────────────────────────────

/**
 * RECORD AN EXPENSE. `categoryLookupId` and `methodLookupId` are LOOKUP ids the service re-validates
 * against the live lists (CLAUDE.md §4 — no hardcoded dropdowns). `at` is the OPTIONAL paid date (a
 * day) — omit it and MAIN dates the expense to now. `payee`/`note` are optional free text.
 *
 * ABSENT, ON PURPOSE:
 *   userId — who recorded it comes from the authenticated session in MAIN, NEVER from the renderer.
 */
export const CreateExpenseInput = z.object({
  categoryLookupId: LookupId,
  /** 2-dp money, > 0 — the amount paid out. */
  amount: PositiveMoneyMinor,
  methodLookupId: LookupId,
  /** Who it was paid to. Free text. */
  payee: z.string().trim().max(200).nullish(),
  note: z.string().trim().max(1000).nullish(),
  /** ISO date it was paid. Omit for "now". */
  at: IsoDate.optional()
})

/** List expenses — paginated, filterable by date range and category; newest first. (CLAUDE.md §4) */
export const ListExpensesInput = z.object({
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(200).optional(),
  /** ISO date (YYYY-MM-DD) — inclusive lower bound. Validated, so a bad value is a friendly message. */
  from: IsoDate.optional(),
  /** ISO date — inclusive upper bound (the whole of that day is inside it). */
  to: IsoDate.optional(),
  /** lookups('expense_category').id — narrow the list to one category. */
  categoryLookupId: LookupId.optional()
})

export const GetExpenseInput = z.object({ id: RowId })

// ── Inferred input types ─────────────────────────────────────────────────────────

export type CreateExpenseInput = z.infer<typeof CreateExpenseInput>
export type ListExpensesInput = z.infer<typeof ListExpensesInput>
export type GetExpenseInput = z.infer<typeof GetExpenseInput>
