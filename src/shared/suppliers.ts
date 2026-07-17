import { z } from 'zod'

/**
 * THE SUPPLIER CONTRACT — the types and input schemas main and renderer agree on for the BUYING side.
 * (Migration 0013.) The mirror of `shared/customers.ts`, pointing the other way.
 *
 * A SUPPLIER is a party the shop keeps a running account WITH — the counterpart of a customer. Where a
 * customer owes the shop (a receivable), a supplier is owed BY the shop (a payable). This file carries
 * the supplier record, the payments that bring what the shop owes back DOWN, and the running statement
 * that shows it — exactly as `shared/customers.ts` does for udhaar, reflected.
 *
 * ── WHAT IS ABSENT, DELIBERATELY: A BALANCE. ────────────────────────────────────────────────────────
 * What the shop owes a supplier is DERIVED, never stored, exactly as stock is derived from movements
 * (CLAUDE.md §4):
 *
 *       opening payable  +  Σ (purchase.grand_total − purchase.paid_total)  −  Σ supplier_payments
 *
 * There is no `balance` column on `suppliers`, no field on the form to type one into, and there never
 * will be. A typed balance is one that can silently disagree with the bills behind it — and then the
 * shop pays a supplier money the ledger says it does not owe. `SupplierLedgerRow.balanceAfter` and
 * `SupplierLedgerPage.balance` are computed, returned, and never persisted. Positive = the shop owes
 * the supplier; it reconciles, to the paisa, with the GL Payables account.
 *
 * ── MONEY IS INTEGER MINOR UNITS (2 dp). NEVER A FLOAT. NEVER A `REAL`. ──────────────────────────────
 * `amount`, `charge`, `payment`, `balance` are all 2-dp money in minor units (paisa). Format only at
 * display time, with `shared/money.ts` (`formatMoney`). The shop's payment methods are lookups-driven
 * (`methodLookupId` -> lookups('payment_method')); the supplier TYPE is a lookup too
 * (`typeLookupId` -> lookups('supplier_type')) — never a hardcoded <Select>.
 */

// ── Enums & constants ────────────────────────────────────────────────────────

/**
 * The kinds of line a supplier's statement is built from. An `opening` payable and a `purchase` on
 * account RAISE what the shop owes (a charge); a `payment` and a `return` LOWER it. The ledger service
 * tags every row so the screen can render and total them without re-deriving the kind. (The exact
 * mirror of the customer statement's kinds.)
 *
 * `return` is a purchase return settled as 'supplier_credit' (migration 0016) — goods sent back and
 * taken off the bill, which posts DR Payable. A return settled as a 'refund' came back as real money and
 * never touched the supplier's account, so it never appears on the statement.
 */
export const SUPPLIER_LEDGER_KINDS = ['opening', 'purchase', 'payment', 'return'] as const
export type SupplierLedgerKind = (typeof SUPPLIER_LEDGER_KINDS)[number]

// ── Row types ────────────────────────────────────────────────────────────────

/**
 * A supplier. The counterpart of a `Customer` — who the shop buys from, and keeps a running account
 * with. `typeLookupId` is lookups('supplier_type'). NOTE WHAT IS ABSENT: a balance. What the shop
 * owes is derived from the ledger (see the file header).
 */
export type Supplier = {
  id: number
  name: string
  phone: string | null
  address: string | null
  /** lookups('supplier_type'). Never a hardcoded <Select>. */
  typeLookupId: number | null
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/** A supplier row plus what the shop owes them right now — what the Suppliers screen shows. */
export type SupplierWithBalance = Supplier & {
  /** 2-dp money. Derived on read: opening payable + purchase payables − payments. Positive = we owe. */
  balance: number
}

/**
 * One payment to a supplier. Money going OUT, paying what the shop owes DOWN — the mirror of a
 * customer's udhaar repayment. Posts DR Accounts Payable, CR Cash/Bank/wallet; `journalId` links that
 * balanced journal. A split settlement (part cash, part cheque) is MANY of these rows, each with its
 * own method — there is no "methods array".
 */
export type SupplierPayment = {
  id: number
  supplierId: number
  /** ISO8601. WHEN the money changed hands (MAIN's clock). */
  at: string
  /** 2-dp money, always POSITIVE — a payable paid down. */
  amount: number
  /** lookups('payment_method') — cash / bank / jazzcash / cheque... Never a hardcoded list. */
  methodLookupId: number
  /** For a cheque payment. Null otherwise. */
  chequeNo: string | null
  /** ISO date on the cheque. Null otherwise. */
  chequeDate: string | null
  /** A mobile-wallet transaction id (JazzCash/Easypaisa). Null otherwise. */
  walletRef: string | null
  note: string | null
  /** Who paid the supplier. Null only for a row written before users were recorded. */
  userId: number | null
  /** The balanced journal this payment posted. Null only mid-transaction, before it is attached. */
  journalId: number | null
  createdAt: string
}

/**
 * ONE LINE of a supplier's statement — a charge or a payment, with the running balance after it.
 *
 * `charge` and `payment` are mutually exclusive: a charge row (opening payable, purchase on account)
 * carries a positive `charge` and a zero `payment`; a payment row is the reverse. `balanceAfter` is the
 * running total AFTER this row, at this point in the supplier's history — DERIVED on read, never
 * stored. All three are 2-dp money.
 */
export type SupplierLedgerRow = {
  kind: SupplierLedgerKind
  /**
   * The id of the underlying row: opening_payables.id, purchases.id, supplier_payments.id, or
   * purchase_returns.id — whichever table this row's `kind` names.
   */
  refId: number
  /** ISO8601 — when this entry is dated. The statement is ordered by it. */
  at: string
  /** Readable: the supplier's invoice number, "Opening balance", a returned-goods note, or the method. */
  description: string
  /** 2-dp money. What this row ADDED to what the shop owes. 0 on a payment row. */
  charge: number
  /** 2-dp money. What this row TOOK OFF what the shop owes. 0 on a charge row. */
  payment: number
  /** 2-dp money. Running balance after this row, in the supplier's history. Derived, never stored. */
  balanceAfter: number
}

/**
 * A page of a supplier's ledger, PLUS the current balance the statement header needs.
 *
 * Paginated like every list in the app — assume 100k+ rows (CLAUDE.md §4). `balance` is what the shop
 * owes this supplier RIGHT NOW across their whole history (not just this page). Derived on read; not a
 * stored running total. (Unlike a customer, a supplier has no credit limit — the shop's own budget is
 * not the supplier's concern — so there is no `creditLimit` field here.)
 */
export type SupplierLedgerPage = {
  supplierId: number
  rows: SupplierLedgerRow[]
  /** Total statement lines for this supplier (for the pager). */
  total: number
  page: number
  pageSize: number
  /** 2-dp money. What the shop owes now: opening + purchase payables − payments. Derived on read. */
  balance: number
}

// ── Input schemas ────────────────────────────────────────────────────────────
// Validated in MAIN, before anything reaches a service (and by the service itself — the services layer
// is the real boundary, CLAUDE.md §3). The renderer is not trusted to have validated anything, and
// neither is a future LAN client.
//
// UPDATE / PAYMENT SCHEMAS CARRY ONLY WHAT THE FORM EDITS. On an update every field is optional:
//   undefined -> "the form did not touch this; leave the column alone"
//   null      -> "the user cleared it"   (that is what .nullish() is for)
// We NEVER post a whole object back to a save endpoint — it wipes fields the form never loaded.
// (CLAUDE.md §4, trap #18.)

/** Integer money that must actually be an amount. A zero payment is not a payment. */
const PositiveMoneyMinor = z.number().int().positive('Please enter an amount greater than zero.')
const RowId = z.number().int().positive()
const LookupId = z.number().int().positive()

/** ISO date, YYYY-MM-DD. A cheque's date is a DAY, not a timestamp. */
// A real calendar day, from ONE definition (shared/dates.ts). The bare regex this used to be let
// 2026-02-30 through, and JS silently rolls that to March 2 — a date in the wrong month, with no
// error. Imported, not re-implemented: seven copies of the guard is seven chances to miss the eighth.
import { IsoDate } from './dates'

// ── Suppliers ────────────────────────────────────────────────────────────────

/**
 * Add a supplier. Names are NOT unique — two distributors can share a name, and the phone number tells
 * them apart, exactly as with customers. `typeLookupId` is optional (a one-off supplier needs none).
 */
export const SupplierInput = z.object({
  name: z.string().trim().min(1, 'Please enter the supplier name.').max(200),
  phone: z.string().trim().max(50).nullish(),
  address: z.string().trim().max(500).nullish(),
  /** lookups('supplier_type'). Never a hardcoded <Select>. */
  typeLookupId: LookupId.nullish()
})

/**
 * Save an edit — ONLY the fields the form actually sent. Every field is optional; `.nullish()` on a
 * nullable column lets the user clear it. (See the file header, and CLAUDE.md trap #18.)
 */
export const UpdateSupplierInput = z.object({
  id: RowId,
  name: z.string().trim().min(1, 'Please enter the supplier name.').max(200).optional(),
  phone: z.string().trim().max(50).nullish(),
  address: z.string().trim().max(500).nullish(),
  typeLookupId: LookupId.nullish(),
  isActive: z.boolean().optional()
})

export const SupplierListInput = z.object({
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(200).optional(),
  /** Matches name or phone. */
  search: z.string().trim().max(100).optional(),
  includeInactive: z.boolean().optional()
})

export const SupplierGetInput = z.object({ id: RowId })

// ── Supplier payments (a payable paid down) ──────────────────────────────────

/**
 * Record a payment to a supplier. It posts DR Accounts Payable, CR Cash/Bank/wallet in the same
 * transaction — the mirror of a customer paying down udhaar (migration 0009 / 0013).
 *
 * `amount` is POSITIVE: a payment is money the shop PAID OUT. A negative "payment" would be a fresh
 * bill, and a bill is a purchase — it goes through the purchase screen, not here.
 *
 * `methodLookupId` -> lookups('payment_method'); the cheque/wallet fields are optional and belong to
 * their method (a cash payment fills none of them). 'credit' (udhaar) is refused: the shop does not pay
 * a supplier with a promise. A split settlement is TWO calls, one per method.
 *
 * ABSENT, ON PURPOSE:
 *   userId — who paid comes from the authenticated session in MAIN, NEVER from the renderer.
 *   at     — MAIN stamps the payment with its own clock, like every other money movement in the app.
 */
export const RecordSupplierPaymentInput = z.object({
  supplierId: RowId,
  /** 2-dp money, > 0 — a payable being paid down. */
  amount: PositiveMoneyMinor,
  /** lookups('payment_method') — cash / bank / jazzcash / cheque... Never a hardcoded list. */
  methodLookupId: LookupId,
  chequeNo: z.string().trim().max(50).nullish(),
  chequeDate: IsoDate.nullish(),
  walletRef: z.string().trim().max(100).nullish(),
  note: z.string().trim().max(500).nullish()
})

// ── Supplier ledger (the running statement) ──────────────────────────────────

/**
 * Ask for one page of a supplier's ledger. Paginated because a long-standing distributor has years of
 * bills and payments — assume 100k+ rows (CLAUDE.md §4). The current balance comes back on the page
 * itself (`SupplierLedgerPage`), derived on read.
 */
export const SupplierLedgerInput = z.object({
  supplierId: RowId,
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(200).optional()
})

// ── Inferred input types ─────────────────────────────────────────────────────

export type SupplierInput = z.infer<typeof SupplierInput>
export type UpdateSupplierInput = z.infer<typeof UpdateSupplierInput>
export type SupplierListInput = z.infer<typeof SupplierListInput>
export type SupplierGetInput = z.infer<typeof SupplierGetInput>
export type RecordSupplierPaymentInput = z.infer<typeof RecordSupplierPaymentInput>
export type SupplierLedgerInput = z.infer<typeof SupplierLedgerInput>
