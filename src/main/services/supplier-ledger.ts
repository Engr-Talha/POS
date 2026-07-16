import type { z } from 'zod'
import type { DB } from '../db'
import type { User } from '@shared/types'
import { AppError, ErrorCode } from '@shared/result'
import type { PagedResult } from '@shared/catalog'
import {
  RecordSupplierPaymentInput,
  SupplierLedgerInput,
  type Supplier,
  type SupplierLedgerKind,
  type SupplierLedgerPage,
  type SupplierLedgerRow,
  type SupplierPayment,
  type SupplierWithBalance
} from '@shared/suppliers'
import { ACC } from '../db/chart-of-accounts'
import * as audit from './audit'
import * as suppliers from './suppliers'
// The posting engine, aliased: the public `ledger()` statement function below owns the plain name.
import * as postingEngine from './ledger'
import { accountForPaymentMethod } from './sales'

/**
 * THE SUPPLIER LEDGER — the running account the shop keeps WITH each supplier, and the dues it pays
 * back. The mirror of `customer-ledger.ts`, reflected: a customer OWES the shop, a supplier is OWED BY
 * it.
 *
 * ── WHAT THE SHOP OWES IS DERIVED, NEVER STORED ────────────────────────────────────────────────────
 * Exactly as stock is the sum of its movements (CLAUDE.md §4), what the shop owes a supplier is:
 *
 *       opening payable
 *     + Σ (purchase.grand_total − purchase.paid_total)
 *     − Σ supplier_payments
 *     − Σ purchase_returns settled as 'supplier_credit'
 *
 * There is no balance column, and there never will be. `balance()` recomputes on read. Positive = the
 * shop owes the supplier; negative = the supplier owes the shop (an overpayment, which is allowed).
 *
 * ── IT RECONCILES WITH THE GENERAL LEDGER, TO THE PAISA ─────────────────────────────────────────────
 * Every term maps to a posting against Accounts Payable (ACC.PAYABLE):
 *
 *       opening payable       CR Payable   (opening journal)
 *       purchase on account   CR Payable   (the purchase's journal, its unpaid remainder)
 *       supplier payment      DR Payable   (recordPayment, below)
 *       return on credit      DR Payable   (purchase-returns.ts, settlement 'supplier_credit')
 *
 * So the sum of every supplier's balance equals the GL Payable account balance. A standing test asserts
 * it after every scenario. Payable is a LIABILITY (credit-natured), so `accountBalance` returns
 * credits − debits — which is exactly opening + purchase payables − payments.
 *
 * Transport-agnostic (CLAUDE.md §3): plain args in, plain data out, no `electron` import. The IPC layer
 * zod-validates, checks the permission in MAIN, calls assertWritable on the writes, and wraps the
 * answer in a Result.
 */

// ═════════════════════════════════════════════════════════════════════════════
// THE BALANCE — derived on read, one source of truth
// ═════════════════════════════════════════════════════════════════════════════

/**
 * WHAT THE SHOP OWES THIS SUPPLIER RIGHT NOW. Positive = the shop owes them; negative = they owe the
 * shop (the shop overpaid, which is allowed — see recordPayment).
 *
 *       opening payable
 *     + Σ (purchase.grand_total − purchase.paid_total)
 *     − Σ supplier_payments
 *     − Σ purchase_returns settled as 'supplier_credit'
 *
 * Recomputed on read, never stored (CLAUDE.md §4, trap #17). Correct no matter which screen recorded
 * the payment or the return, because every screen writes to the same four tables this reads — and it
 * reconciles, to the paisa, with GL Accounts Payable.
 */
export function balance(db: DB, supplierId: number): number {
  const opening = db
    .prepare('SELECT COALESCE(SUM(amount), 0) FROM opening_payables WHERE supplier_id = ?')
    .pluck()
    .get(supplierId) as number

  // Each purchase's UNPAID PORTION — what it left owing after the tenders paid at receipt time. This is
  // exactly what the purchase journal credited to Payable (purchases.ts), so the two stay reconciled.
  const onAccount = db
    .prepare(
      'SELECT COALESCE(SUM(grand_total - paid_total), 0) FROM purchases WHERE supplier_id = ?'
    )
    .pluck()
    .get(supplierId) as number

  // Dues PAID BACK. Every row here posted DR Payable CR Cash/Bank (recordPayment, below), so it lowers
  // what the shop owes by exactly its amount — whichever screen recorded it.
  const paidBack = db
    .prepare('SELECT COALESCE(SUM(amount), 0) FROM supplier_payments WHERE supplier_id = ?')
    .pluck()
    .get(supplierId) as number

  // GOODS SENT BACK, TAKEN OFF THE BILL. A 'supplier_credit' return posts DR Payable for its grand total
  // (purchase-returns.ts) — the shop owes that much less. Leave it out and this screen chases a
  // distributor for money the GL says is no longer owed, and Σ balances stops equalling GL Payable while
  // the trial balance stays green. That is CLAUDE.md trap #17, and it is exactly the bug the
  // customer-returns audit found; it is not repeated here.
  //
  // A 'refund' return took real money back through a tender (DR Cash/Bank) and never touched Payables,
  // so it is deliberately NOT in this sum. The supplier is joined through the return's PURCHASE, which is
  // the only thing that says whose goods these were (migration 0016 — a return is never re-pointed).
  const returnedOnCredit = db
    .prepare(
      `SELECT COALESCE(SUM(pr.grand_total), 0)
         FROM purchase_returns pr
         JOIN purchases p ON p.id = pr.purchase_id
        WHERE p.supplier_id = ? AND pr.settlement = 'supplier_credit'`
    )
    .pluck()
    .get(supplierId) as number

  return opening + onAccount - paidBack - returnedOnCredit
}

// ═════════════════════════════════════════════════════════════════════════════
// THE STATEMENT — a paginated, chronological ledger with a running balance
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The sources a supplier's statement is built from, merged into one chronological list. Each row is
 * either a CHARGE (opening balance, purchase on account — raises what the shop owes) or a PAYMENT
 * (lowers it). `kind_rank` breaks a same-instant tie deterministically: opening before purchase before
 * payment before return, so the running balance is stable and repeatable across pages.
 *
 *   opening   dated to the go-live date (the accounting date of the opening journal) so it always sorts
 *             first — it is the oldest thing on the account.
 *   purchase  one row per purchase that left something owing, carrying its UNPAID PORTION only
 *             (grand_total − paid_total). The cash paid at receipt time never touched the supplier's
 *             account, so it is not on the statement. This is exactly what the purchase's journal
 *             credited to Payable, which keeps the statement reconciled with the GL.
 *   payment   one row per supplier_payment.
 *   return    one row per purchase return settled as 'supplier_credit', carrying its grand_total as a
 *             PAYMENT — exactly what the return's journal debited to Payable, and exactly the set
 *             balance() subtracts, so the running balance still ends on balance().
 */
const LEDGER_UNION = `
  SELECT 'opening' AS kind, 0 AS kind_rank, op.id AS ref_id,
         COALESCE((SELECT go_live_date FROM opening_setup WHERE id = 1), op.created_at) AS at,
         op.amount AS charge, 0 AS payment,
         NULL AS invoice_no, NULL AS method_label, NULL AS cheque_no, NULL AS wallet_ref, op.note AS note
    FROM opening_payables op
   WHERE op.supplier_id = @supplierId

  UNION ALL

  SELECT 'purchase' AS kind, 1 AS kind_rank, pu.id AS ref_id, pu.at AS at,
         (pu.grand_total - pu.paid_total) AS charge, 0 AS payment,
         pu.supplier_invoice_no AS invoice_no, NULL AS method_label, NULL AS cheque_no,
         NULL AS wallet_ref, NULL AS note
    FROM purchases pu
   WHERE pu.supplier_id = @supplierId
     AND (pu.grand_total - pu.paid_total) > 0

  UNION ALL

  SELECT 'payment' AS kind, 2 AS kind_rank, sp.id AS ref_id, sp.at AS at,
         0 AS charge, sp.amount AS payment,
         NULL AS invoice_no, ml.label AS method_label, sp.cheque_no AS cheque_no,
         sp.wallet_ref AS wallet_ref, sp.note AS note
    FROM supplier_payments sp
    LEFT JOIN lookups ml ON ml.id = sp.method_lookup_id
   WHERE sp.supplier_id = @supplierId

  UNION ALL

  -- GOODS SENT BACK, TAKEN OFF THE BILL. A 'supplier_credit' return posts DR Payable for its grand_total
  -- (purchase-returns.ts) — the same effect a payment has — so it is a PAYMENT line here, LOWERING what
  -- the shop owes. A 'refund' return took real money back through a tender and never touched Payables,
  -- so it is not on this statement. This is exactly the set balance() subtracts, so the running balance
  -- still ends on balance(). The supplier comes from the return's PURCHASE — the only thing that says
  -- whose goods these were. (Mirrors customer-ledger's credit-note line; CLAUDE.md trap #17.)
  SELECT 'return' AS kind, 3 AS kind_rank, pr.id AS ref_id, pr.at AS at,
         0 AS charge, pr.grand_total AS payment,
         p.supplier_invoice_no AS invoice_no, NULL AS method_label, NULL AS cheque_no,
         NULL AS wallet_ref, pr.reason_text AS note
    FROM purchase_returns pr
    JOIN purchases p ON p.id = pr.purchase_id
   WHERE p.supplier_id = @supplierId
     AND pr.settlement = 'supplier_credit'
`

type LedgerUnionRow = {
  kind: SupplierLedgerKind
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

/** Readable: the supplier's bill number, "Opening balance", a debit note, or the payment method. */
function describeRow(row: LedgerUnionRow): string {
  if (row.kind === 'opening') return row.note ? `Opening balance — ${row.note}` : 'Opening balance'
  if (row.kind === 'purchase') return row.invoice_no ? `Bill ${row.invoice_no}` : `Purchase #${row.ref_id}`
  if (row.kind === 'return') {
    const against = row.invoice_no ? ` — bill ${row.invoice_no}` : ''
    return row.note ? `Goods returned${against} (${row.note})` : `Goods returned${against}`
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
 * ONE PAGE of a supplier's statement, OLDEST FIRST — it reads like a bank statement, and the running
 * balance in the right-hand column is one the owner can follow down the page.
 *
 * Paginated because a long-standing distributor has years of bills and payments (CLAUDE.md §4). The
 * running balance is still correct on page 5: `balance before this page` is the signed sum of every row
 * that sorts before the page's first row, computed straight from the ledger — never carried in a cookie.
 * Accumulating from there gives each row its `balanceAfter`, and the last row of the last page
 * necessarily lands on `balance()`.
 *
 * A READ — it writes nothing, so it works under an expired licence, where the app is READ-ONLY and the
 * owner can still see and export everything (CLAUDE.md §6).
 */
export function ledger(db: DB, raw: unknown): SupplierLedgerPage {
  const input = parseOrThrow(SupplierLedgerInput, raw, 'supplier.ledger')

  // getById throws NOT_FOUND for a missing supplier — a friendly sentence, never a blank statement.
  suppliers.getById(db, input.supplierId)

  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 50))
  const offset = (page - 1) * pageSize

  const total = db
    .prepare(`SELECT COUNT(*) FROM (${LEDGER_UNION})`)
    .pluck()
    .get({ supplierId: input.supplierId }) as number

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
    .get({ supplierId: input.supplierId, offset }) as number

  const pageRows = db
    .prepare(
      `SELECT * FROM (${LEDGER_UNION})
        ORDER BY at, kind_rank, ref_id
        LIMIT @pageSize OFFSET @offset`
    )
    .all({ supplierId: input.supplierId, pageSize, offset }) as LedgerUnionRow[]

  let running = balanceBefore
  const rows: SupplierLedgerRow[] = pageRows.map((row) => {
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
    supplierId: input.supplierId,
    rows,
    total,
    page,
    pageSize,
    // What the shop owes this supplier across their whole account. Derived on read.
    balance: balance(db, input.supplierId)
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// THE SUPPLIERS LIST, EACH WITH ITS BALANCE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * THE SUPPLIERS LIST with a balance against each row. Paginated, indexed and searchable — it does NOT
 * reinvent any of that, it reuses `suppliers.list` (assume 100k+ rows, CLAUDE.md §4) and attaches the
 * derived balance to the page it returns.
 *
 * The balance is computed only for the ≤ pageSize rows actually shown, never for the whole table.
 */
export function listWithBalances(db: DB, raw: unknown = {}): PagedResult<SupplierWithBalance> {
  const listed = suppliers.list(db, raw)

  return {
    ...listed,
    rows: listed.rows.map((supplier: Supplier) => ({ ...supplier, balance: balance(db, supplier.id) }))
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// RECORD A PAYMENT — a payable paid back
// ═════════════════════════════════════════════════════════════════════════════

/** What caused this journal, stored on it so the general ledger can point back at the payment. */
const SUPPLIER_PAYMENT_REF_TYPE = 'supplier_payment'

/**
 * THE SHOP PAYS DOWN WHAT IT OWES A SUPPLIER. In ONE transaction, or none of it:
 *
 *   1. write the supplier_payments row
 *   2. post a BALANCED journal:  DR Accounts Payable   CR Cash / Bank (by method)
 *   3. link the journal back onto the row (`journal_id`)
 *   4. audit 'supplier.payment' — WHO paid, and WHEN
 *
 * AN OVERPAYMENT IS ALLOWED. The shop may pay more than it owes (an advance to a supplier) — the
 * balance then goes NEGATIVE (the supplier owes the shop), and that is fine and stays fully reconciled
 * with the GL. The only floor is that the amount must be a real, positive amount (the zod schema
 * enforces `> 0`): a "negative payment" would be a fresh bill, and a bill is a purchase.
 *
 * `userId` and `at` are supplied by MAIN — never trusted from the renderer (CLAUDE.md §4). RBAC and
 * assertWritable are enforced by the IPC layer; this service is the transport-agnostic core.
 */
export function recordPayment(db: DB, actor: User, raw: unknown, now = new Date()): SupplierPayment {
  const input = parseOrThrow(RecordSupplierPaymentInput, raw, 'supplier.payment')

  // The method is a real, CURRENT entry on the owner's own payment_method list — not a number the
  // renderer made up, nor one the owner has since retired (CLAUDE.md §4).
  const method = requirePaymentMethod(db, input.methodLookupId)
  const crAccount = tenderAccountForMethod(method)

  const run = db.transaction((): number => {
    // Not gated on is_active: a RETIRED supplier can still be paid off an old debt, and refusing that
    // would strand money the shop owes. Existence is all that is required.
    const supplier = db
      .prepare('SELECT id, name FROM suppliers WHERE id = ?')
      .get(input.supplierId) as { id: number; name: string } | undefined

    if (!supplier) {
      throw new AppError(
        ErrorCode.NOT_FOUND,
        'That supplier could not be found. They may have been removed.',
        `supplier id=${input.supplierId} does not exist`
      )
    }

    const at = now.toISOString()

    // journal_id is NULL for the instant between the row landing and the journal being attached — both
    // happen inside this one transaction, so a committed payment always carries its journal.
    const paymentId = Number(
      db
        .prepare(
          `INSERT INTO supplier_payments
             (supplier_id, at, amount, method_lookup_id, cheque_no, cheque_date, wallet_ref, note,
              user_id, journal_id, created_at)
           VALUES
             (@supplierId, @at, @amount, @methodLookupId, @chequeNo, @chequeDate, @walletRef, @note,
              @userId, NULL, @at)`
        )
        .run({
          supplierId: input.supplierId,
          at,
          amount: input.amount,
          methodLookupId: method.id,
          chequeNo: input.chequeNo ?? null,
          chequeDate: input.chequeDate ?? null,
          walletRef: input.walletRef ?? null,
          note: input.note ?? null,
          userId: actor.id
        }).lastInsertRowid
    )

    // DR what the shop owed (Payable), CR where the money went out (Cash/Bank). The posting engine
    // throws if it does not balance — it cannot fail to, the two legs are the same amount.
    const journalId = postingEngine.post(db, {
      at: now,
      refType: SUPPLIER_PAYMENT_REF_TYPE,
      refId: paymentId,
      memo: `Payment to ${supplier.name}`,
      userId: actor.id,
      lines: [
        { account: ACC.PAYABLE, debit: input.amount },
        { account: crAccount, credit: input.amount }
      ]
    })

    db.prepare('UPDATE supplier_payments SET journal_id = ? WHERE id = ?').run(journalId, paymentId)

    // WHO paid, and WHEN (CLAUDE.md §4). The method's code, so the audit reads without a join.
    audit.record(
      db,
      actor,
      {
        action: 'supplier.payment',
        entity: 'supplier',
        entityId: input.supplierId,
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

type SupplierPaymentRow = {
  id: number
  supplier_id: number
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

function toSupplierPayment(row: SupplierPaymentRow): SupplierPayment {
  return {
    id: row.id,
    supplierId: row.supplier_id,
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

export function getPayment(db: DB, id: number): SupplierPayment {
  const row = db.prepare('SELECT * FROM supplier_payments WHERE id = ?').get(id) as
    | SupplierPaymentRow
    | undefined

  if (!row) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That payment could not be found.',
      `supplier_payments id=${id} does not exist`
    )
  }
  return toSupplierPayment(row)
}

// ═════════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════════

/** A real, CURRENT entry on the owner's own payment_method list. Never a hardcoded option. */
function requirePaymentMethod(db: DB, id: number): { id: number; code: string; label: string } {
  const row = db
    .prepare(
      `SELECT id, code, label FROM lookups
        WHERE list_key = 'payment_method' AND id = ? AND is_active = 1`
    )
    .get(id) as { id: number; code: string; label: string } | undefined

  if (!row) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Please choose how the supplier is being paid from the list.',
      `unknown or inactive payment_method lookup id=${id}`
    )
  }
  return row
}

/**
 * WHERE THE MONEY GOES OUT FROM. Cash leaves the drawer; anything else the shop actually pays with
 * (bank transfer, cheque, JazzCash, Easypaisa, or a method the owner adds later) leaves the bank.
 *
 * A method whose account resolves to Payable or Receivable is REFUSED — the shop cannot pay a supplier
 * with a promise. The 'credit' method maps to Receivable, so it would post DR Payable / CR Receivable:
 * a journal that shuffles two liabilities-of-others around and settles nothing. Reuses the SAME
 * payment-method → account mapping a sale and a purchase use, so a JazzCash payment lands where a
 * JazzCash anything lands.
 */
function tenderAccountForMethod(method: { code: string }): string {
  const account = accountForPaymentMethod(method.code)
  if (account === ACC.PAYABLE || account === ACC.RECEIVABLE) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'A supplier is paid with cash, bank, cheque or a wallet — not on credit. Please choose a real payment method.',
      `supplier payment method "${method.code}" resolves to ${account} (Payable/Receivable) — refused`
    )
  }
  return account
}

/**
 * Validate at the SERVICE boundary, not only at the IPC one. The services layer is the real boundary
 * (CLAUDE.md §3) — vitest calls it directly today and a LAN server will call it tomorrow.
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
