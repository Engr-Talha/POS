import type { z } from 'zod'
import type { DB } from '../db'
import type { User } from '@shared/types'
import { AppError, ErrorCode } from '@shared/result'
import type { PagedResult } from '@shared/catalog'
import {
  CustomerLedgerInput,
  RecordCustomerPaymentInput,
  type Customer,
  type CustomerLedgerKind,
  type CustomerLedgerPage,
  type CustomerLedgerRow,
  type CustomerPayment
} from '@shared/customers'
import { ACC } from '../db/chart-of-accounts'
import * as audit from './audit'
import * as customers from './customers'
// The posting engine, aliased: the public `ledger()` statement function below owns the plain name.
import * as postingEngine from './ledger'
import { outstandingCredit } from './sales'
import { openShiftId } from './shift-id'

/**
 * THE CUSTOMER LEDGER — the running account the shop keeps with each customer, and the udhaar they pay
 * back. (Migration 0009, Phase 7.)
 *
 * ── WHAT A CUSTOMER OWES IS DERIVED, NEVER STORED ──────────────────────────────────────────────────
 * Exactly as stock is the sum of its movements (CLAUDE.md §4), a customer's balance is:
 *
 *       opening udhaar  +  credit-sale receivables  −  customer payments  −  returns credited to account
 *
 * There is no balance column, and there never will be. A typed balance is one that can silently
 * disagree with the rows behind it — and then the shop chases a customer for money the ledger says they
 * do not owe. `balance()` recomputes on read (it delegates to sales.outstandingCredit).
 *
 * ── ONE SOURCE OF TRUTH, SO EVERY SCREEN AGREES (CLAUDE.md trap #17) ────────────────────────────────
 * `sales.outstandingCredit()` is the single function that says what a customer owes. The sale screen's
 * credit-limit check calls it, and `balance()` here delegates straight to it. So a payment taken on THIS
 * screen lowers the very number the till checks the limit against — the exact bug this codebase is
 * strict about (a payment recorded on "the other screen" that the first screen never learns about)
 * cannot happen, because there is only one screen's worth of arithmetic.
 *
 * ── IT RECONCILES WITH THE GENERAL LEDGER, TO THE PAISA ─────────────────────────────────────────────
 * Every term maps to a posting against Accounts Receivable (ACC.RECEIVABLE):
 *
 *       opening udhaar        DR Receivable   (opening journal)
 *       credit sale           DR Receivable   (the sale's journal, its credit-method payment)
 *       customer payment      CR Receivable   (recordPayment, below)
 *
 * So the sum of every customer's balance equals the GL Receivable account balance. A standing test
 * asserts it after every scenario.
 *
 * Transport-agnostic (CLAUDE.md §3): plain args in, plain data out, no `electron` import. The IPC layer
 * zod-validates, checks the permission in MAIN, calls assertWritable on the writes, and wraps the
 * answer in a Result.
 */

// ═════════════════════════════════════════════════════════════════════════════
// THE BALANCE — derived on read, one source of truth
// ═════════════════════════════════════════════════════════════════════════════

/**
 * WHAT THE CUSTOMER OWES RIGHT NOW. Positive = they owe the shop; negative = the shop owes them (they
 * paid in advance, which is allowed — see recordPayment).
 *
 * Delegates to `sales.outstandingCredit`, which IS the figure the credit-limit check uses, so the two
 * can never drift:
 *
 *       opening receivable  +  credit-sale receivables  −  customer payments
 *
 * Recomputed on read, never stored (CLAUDE.md §4, trap #17). Correct no matter which screen recorded
 * the payment, because every screen writes to the same three tables this reads.
 */
export function balance(db: DB, customerId: number): number {
  return outstandingCredit(db, customerId)
}

// ═════════════════════════════════════════════════════════════════════════════
// THE STATEMENT — a paginated, chronological ledger with a running balance
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The sources a customer's udhaar statement is built from, merged into one chronological list. Each row
 * is either a CHARGE (opening balance, credit sale — raises what they owe) or a PAYMENT (lowers it).
 * `kind_rank` breaks a same-instant tie deterministically: opening before sale before payment before
 * return, so the running balance is stable and repeatable across pages.
 *
 *   opening   dated to the go-live date (the accounting date of the opening journal) so it always sorts
 *             first — it is the oldest thing on the account.
 *   sale      one row per COMPLETED credit sale, carrying the CREDIT PORTION only (`net`/`cash` parts of
 *             a split payment never touched the customer's account, so they are not on the statement).
 *             This is exactly what the sale's journal debited to Receivable, which is what keeps the
 *             statement reconciled with the GL.
 *   payment   one row per customer_payment.
 *   return    one row per return SETTLED ONTO THE ACCOUNT ('customer_credit' or the minimal 'exchange'),
 *             carrying its grand_total as a payment — exactly what the return's journal credited to
 *             Receivable, and exactly the set outstandingCredit() subtracts, so the two stay reconciled.
 */
const LEDGER_UNION = `
  SELECT 'opening' AS kind, 0 AS kind_rank, r.id AS ref_id,
         COALESCE((SELECT go_live_date FROM opening_setup WHERE id = 1), r.created_at) AS at,
         r.amount AS charge, 0 AS payment,
         NULL AS invoice_no, NULL AS method_label, NULL AS cheque_no, NULL AS wallet_ref, r.note AS note
    FROM opening_receivables r
   WHERE r.customer_id = @customerId

  UNION ALL

  SELECT 'sale' AS kind, 1 AS kind_rank, s.id AS ref_id, s.at AS at,
         (SELECT COALESCE(SUM(sp.amount), 0)
            FROM sale_payments sp JOIN lookups l ON l.id = sp.method_lookup_id
           WHERE sp.sale_id = s.id AND l.code = 'credit') AS charge,
         0 AS payment,
         s.invoice_no AS invoice_no, NULL AS method_label, NULL AS cheque_no, NULL AS wallet_ref,
         NULL AS note
    FROM sales s
   WHERE s.customer_id = @customerId
     AND s.status = 'completed'
     AND EXISTS (SELECT 1 FROM sale_payments sp JOIN lookups l ON l.id = sp.method_lookup_id
                  WHERE sp.sale_id = s.id AND l.code = 'credit' AND sp.amount > 0)

  UNION ALL

  SELECT 'payment' AS kind, 2 AS kind_rank, cp.id AS ref_id, cp.at AS at,
         0 AS charge, cp.amount AS payment,
         NULL AS invoice_no, ml.label AS method_label, cp.cheque_no AS cheque_no,
         cp.wallet_ref AS wallet_ref, cp.note AS note
    FROM customer_payments cp
    LEFT JOIN lookups ml ON ml.id = cp.method_lookup_id
   WHERE cp.customer_id = @customerId

  UNION ALL

  -- A return SETTLED ONTO THE ACCOUNT (a credit note, or the minimal exchange's store credit) posts CR
  -- Receivable for its grand_total (returns.ts) — the same effect a payment has — so it is a PAYMENT
  -- line here, LOWERING what the customer owes. A 'refund' return paid out through a tender never
  -- touched Receivable and is not on this statement. This is exactly the set outstandingCredit()
  -- subtracts, so the running balance still ends on balance(). (Returns audit, HIGH — trap #17.)
  SELECT 'return' AS kind, 3 AS kind_rank, r.id AS ref_id, r.at AS at,
         0 AS charge, r.grand_total AS payment,
         s.invoice_no AS invoice_no, NULL AS method_label, NULL AS cheque_no, NULL AS wallet_ref,
         r.reason_text AS note
    FROM returns r
    JOIN sales s ON s.id = r.sale_id
   WHERE s.customer_id = @customerId
     AND r.settlement IN ('customer_credit', 'exchange')
`

type LedgerUnionRow = {
  kind: CustomerLedgerKind
  kind_rank: number
  ref_id: number
  at: string
  charge: number
  payment: number
  invoice_no: string | null
  method_label: string | null
  cheque_no: string | null
  wallet_ref: string | null
  note: string | null
}

/** Cashier-readable: the invoice number, "Opening balance", a credit note, or the payment method. */
function describeRow(row: LedgerUnionRow): string {
  if (row.kind === 'opening') return row.note ? `Opening balance — ${row.note}` : 'Opening balance'
  if (row.kind === 'sale') return row.invoice_no ?? `Sale #${row.ref_id}`
  if (row.kind === 'return') {
    const against = row.invoice_no ? ` — ${row.invoice_no}` : ''
    return row.note ? `Credit note${against} (${row.note})` : `Credit note${against}`
  }

  const label = row.method_label ?? 'Payment'
  const reference = row.cheque_no
    ? ` — cheque ${row.cheque_no}`
    : row.wallet_ref
      ? ` — ${row.wallet_ref}`
      : ''
  return `${label}${reference}`
}

/**
 * ONE PAGE of a customer's statement, OLDEST FIRST — it reads like a bank statement, and the running
 * balance in the right-hand column is one a customer can follow down the page.
 *
 * Paginated because a long-standing wholesaler has years of charges and payments (CLAUDE.md §4). The
 * running balance is still correct on page 5: `balance before this page` is the signed sum of every row
 * that sorts before the page's first row, computed straight from the ledger — never carried in a cookie
 * or recomputed from a stored total. Accumulating from there gives each row its `balanceAfter`, and the
 * last row of the last page necessarily lands on `balance()` (the whole point).
 *
 * A READ — it writes nothing, so it works under an expired licence, where the app is READ-ONLY and the
 * owner can still see and export everything (CLAUDE.md §6).
 */
export function ledger(db: DB, raw: unknown): CustomerLedgerPage {
  const input = parseOrThrow(CustomerLedgerInput, raw, 'customer.ledger')

  // getById throws NOT_FOUND for a missing customer (a friendly sentence, never a blank statement) and
  // hands us the credit limit the statement header shows next to the balance.
  const customer = customers.getById(db, input.customerId)

  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 50))
  const offset = (page - 1) * pageSize

  const total = db
    .prepare(`SELECT COUNT(*) FROM (${LEDGER_UNION})`)
    .pluck()
    .get({ customerId: input.customerId }) as number

  // The signed running balance of everything BEFORE this page — the first `offset` rows in the exact
  // same order the page uses. LIMIT 0 on page 1 sums nothing, and the balance starts at zero.
  const balanceBefore = db
    .prepare(
      `SELECT COALESCE(SUM(charge - payment), 0)
         FROM (SELECT charge, payment FROM (${LEDGER_UNION})
                ORDER BY at, kind_rank, ref_id
                LIMIT @offset)`
    )
    .pluck()
    .get({ customerId: input.customerId, offset }) as number

  const pageRows = db
    .prepare(
      `SELECT * FROM (${LEDGER_UNION})
        ORDER BY at, kind_rank, ref_id
        LIMIT @pageSize OFFSET @offset`
    )
    .all({ customerId: input.customerId, pageSize, offset }) as LedgerUnionRow[]

  let running = balanceBefore
  const rows: CustomerLedgerRow[] = pageRows.map((row) => {
    running += row.charge - row.payment
    return {
      kind: row.kind,
      refId: row.ref_id,
      at: row.at,
      description: describeRow(row),
      charge: row.charge,
      payment: row.payment,
      balanceAfter: running
    }
  })

  return {
    customerId: input.customerId,
    rows,
    total,
    page,
    pageSize,
    // The whole-account figures the header compares for the "over their limit" warning. Both derived.
    balance: balance(db, input.customerId),
    creditLimit: customer.creditLimit
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// THE CUSTOMERS LIST, EACH WITH ITS BALANCE
// ═════════════════════════════════════════════════════════════════════════════

/** A customer row plus what they owe right now — what the Customers screen shows. */
export type CustomerWithBalance = Customer & {
  /** 2-dp money. Derived on read: opening + credit sales − payments. Positive = they owe the shop. */
  balance: number
}

/**
 * THE CUSTOMERS LIST with a balance against each row. Paginated, indexed and searchable — it does NOT
 * reinvent any of that, it reuses `customers.list` (assume 100k+ rows, CLAUDE.md §4) and attaches the
 * derived balance to the page it returns.
 *
 * The balance is computed only for the ≤ pageSize rows actually shown, never for the whole table — a
 * shop with 100,000 customers still costs one page of work to list.
 */
export function listWithBalances(db: DB, raw: unknown = {}): PagedResult<CustomerWithBalance> {
  const listed = customers.list(db, raw)

  return {
    ...listed,
    rows: listed.rows.map((customer) => ({ ...customer, balance: balance(db, customer.id) }))
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// RECORD A PAYMENT — udhaar paid back
// ═════════════════════════════════════════════════════════════════════════════

/** What caused this journal, stored on it so the general ledger can point back at the payment. */
const CUSTOMER_PAYMENT_REF_TYPE = 'customer_payment'

/**
 * THE CUSTOMER PAYS DOWN THEIR UDHAAR. In ONE transaction, or none of it:
 *
 *   1. write the customer_payments row
 *   2. post a BALANCED journal:  DR Cash / Bank (by method)   CR Accounts Receivable
 *   3. link the journal back onto the row (`journal_id`)
 *   4. audit 'customer.payment' — WHO took the money, and WHEN
 *
 * AN OVERPAYMENT IS ALLOWED. A customer may settle more than they owe and go into credit — the balance
 * then goes NEGATIVE (the shop owes them), and that is fine and stays fully reconciled with the GL. The
 * only floor is that the amount must be a real, positive amount (the zod schema enforces `> 0`): a
 * "negative payment" would be a fresh charge, and a charge is a credit sale, which goes through the sell
 * screen, not here.
 *
 * `userId` and `at` are supplied by MAIN — never trusted from the renderer (CLAUDE.md §4). RBAC and
 * assertWritable are enforced by the IPC layer; this service is the transport-agnostic core.
 */
export function recordPayment(
  db: DB,
  actor: User,
  raw: unknown,
  now = new Date()
): CustomerPayment {
  const input = parseOrThrow(RecordCustomerPaymentInput, raw, 'customer.payment')

  // The method is a real, CURRENT entry on the owner's own payment_method list — not a number the
  // renderer made up, nor one the owner has since retired (CLAUDE.md §4).
  const method = requirePaymentMethod(db, input.methodLookupId)
  const drAccount = drAccountForMethod(method)

  const run = db.transaction((): number => {
    // Not gated on is_active: a RETIRED customer can still pay off an old debt, and refusing that would
    // strand money the shop is owed. Existence is all that is required.
    const customer = db
      .prepare('SELECT id, name FROM customers WHERE id = ?')
      .get(input.customerId) as { id: number; name: string } | undefined

    if (!customer) {
      throw new AppError(
        ErrorCode.NOT_FOUND,
        'That customer could not be found. They may have been removed.',
        `customer id=${input.customerId} does not exist`
      )
    }

    const at = now.toISOString()

    // journal_id is NULL for the instant between the row landing and the journal being attached — both
    // happen inside this one transaction, so a committed payment always carries its journal (0009).
    const paymentId = Number(
      db
        .prepare(
          `INSERT INTO customer_payments
             (customer_id, at, amount, method_lookup_id, cheque_no, cheque_date, wallet_ref, note,
              user_id, journal_id, shift_id, created_at)
           VALUES
             (@customerId, @at, @amount, @methodLookupId, @chequeNo, @chequeDate, @walletRef, @note,
              @userId, NULL, @shiftId, @at)`
        )
        .run({
          customerId: input.customerId,
          at,
          amount: input.amount,
          methodLookupId: method.id,
          chequeNo: input.chequeNo ?? null,
          chequeDate: input.chequeDate ?? null,
          walletRef: input.walletRef ?? null,
          note: input.note ?? null,
          userId: actor.id,
          // The OPEN shift this repayment belongs to, or NULL if the till is not on a shift (0012).
          shiftId: openShiftId(db)
        }).lastInsertRowid
    )

    // DR where the money landed, CR what the customer owed. The posting engine throws if it does not
    // balance — it cannot fail to, the two legs are the same amount by construction.
    const journalId = postingEngine.post(db, {
      at: now,
      refType: CUSTOMER_PAYMENT_REF_TYPE,
      refId: paymentId,
      memo: `Payment from ${customer.name}`,
      userId: actor.id,
      lines: [
        { account: drAccount, debit: input.amount },
        { account: ACC.RECEIVABLE, credit: input.amount }
      ]
    })

    db.prepare('UPDATE customer_payments SET journal_id = ? WHERE id = ?').run(journalId, paymentId)

    // WHO took the money, and WHEN (CLAUDE.md §4). The method's code, so the audit reads without a join.
    audit.record(
      db,
      actor,
      {
        action: 'customer.payment',
        entity: 'customer',
        entityId: input.customerId,
        after: { paymentId, amount: input.amount, method: method.code }
      },
      now
    )

    return paymentId
  })

  return getPayment(db, run())
}

// ═════════════════════════════════════════════════════════════════════════════
// Reading a single payment
// ═════════════════════════════════════════════════════════════════════════════

type CustomerPaymentRow = {
  id: number
  customer_id: number
  at: string
  amount: number
  method_lookup_id: number
  cheque_no: string | null
  cheque_date: string | null
  wallet_ref: string | null
  note: string | null
  user_id: number | null
  journal_id: number | null
  created_at: string
}

function toCustomerPayment(row: CustomerPaymentRow): CustomerPayment {
  return {
    id: row.id,
    customerId: row.customer_id,
    at: row.at,
    amount: row.amount,
    methodLookupId: row.method_lookup_id,
    chequeNo: row.cheque_no,
    chequeDate: row.cheque_date,
    walletRef: row.wallet_ref,
    note: row.note,
    userId: row.user_id,
    journalId: row.journal_id,
    createdAt: row.created_at
  }
}

export function getPayment(db: DB, id: number): CustomerPayment {
  const row = db.prepare('SELECT * FROM customer_payments WHERE id = ?').get(id) as
    | CustomerPaymentRow
    | undefined

  if (!row) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That payment could not be found.',
      `customer_payments id=${id} does not exist`
    )
  }
  return toCustomerPayment(row)
}

// ═════════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════════

/** A real, CURRENT entry on the owner's own payment_method list. Never a hardcoded option. */
function requirePaymentMethod(
  db: DB,
  id: number
): { id: number; code: string; label: string } {
  const row = db
    .prepare(
      `SELECT id, code, label FROM lookups
        WHERE list_key = 'payment_method' AND id = ? AND is_active = 1`
    )
    .get(id) as { id: number; code: string; label: string } | undefined

  if (!row) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Please choose how the customer is paying from the list.',
      `unknown or inactive payment_method lookup id=${id}`
    )
  }
  return row
}

/**
 * WHERE THE MONEY LANDS. Cash stays in the drawer; anything else the shop actually receives (bank
 * transfer, cheque, JazzCash, Easypaisa, or a method the owner adds later) is money in the bank.
 *
 * 'credit' (udhaar) is REFUSED: a customer cannot pay off udhaar with more udhaar. Its account is
 * Receivable, so it would post DR Receivable / CR Receivable — a journal that nets to nothing yet still
 * subtracts from the derived balance, which would part the ledger screen from the GL. Better a plain
 * sentence than a silently wrong balance.
 */
function drAccountForMethod(method: { code: string }): string {
  if (method.code === 'credit') {
    throw new AppError(
      ErrorCode.VALIDATION,
      'A customer cannot pay their udhaar with more udhaar. Please choose cash, bank, cheque or a wallet.',
      `customer payment attempted with method code 'credit'`
    )
  }
  return method.code === 'cash' ? ACC.CASH : ACC.BANK
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
