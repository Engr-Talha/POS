import { z } from 'zod'

/**
 * THE PURCHASE CONTRACT — the types and input schemas main and renderer agree on for a goods-received
 * note. (Migration 0013.) The mirror of `shared/sales.ts`, pointing the other way: a sale takes stock
 * OUT and brings money IN; a purchase brings stock IN at a real landed cost and either pays for it now
 * or owes the supplier the rest.
 *
 * ── THREE INTEGER SCALES LIVE HERE AND THEY ARE NOT INTERCHANGEABLE (CLAUDE.md §4) ──────────────────
 *
 *   money  — INTEGER minor units (paisa), 2 dp   taxTotal, subtotalNet, grandTotal, paidTotal,
 *            payment.amount, line.lineTotal      helpers: shared/money.ts
 *   cost   — INTEGER ten-thousandths,    4 dp    line.unitCost — a DIFFERENT scale, 100× money
 *            helpers: shared/cost.ts
 *   qty_m  — INTEGER thousandths,        3 dp    line.qtyM (1 pc = 1000, 1.234 kg = 1234)
 *            helpers: shared/qty.ts
 *
 * `unitCost` (4 dp) sits one field away from `lineTotal` (2 dp) and they are A HUNDRED TIMES APART.
 * Nothing here is ever a float.
 *
 * ── THE MONEY IDENTITIES (the service freezes them) ─────────────────────────────────────────────────
 *
 *   line.lineTotal        = the frozen value of the stock movement the line created (never a fresh
 *                           qty × cost multiply — sum-of-rounded ≠ round-of-sum)
 *   subtotalNet           = Σ line.lineTotal
 *   grandTotal            = subtotalNet + taxTotal        (also a DB CHECK)
 *   paidTotal             = Σ payment.amount              (tenders paid NOW; the rest is the payable)
 *   payable               = grandTotal − paidTotal        (what is owed the supplier; DERIVED)
 *
 * paidTotal may not exceed grandTotal — there is no "change" when buying (a DB CHECK, and the service
 * refuses it in plain language).
 */

// ── Row types ────────────────────────────────────────────────────────────────

/**
 * A purchase header — a goods-received note. The counterpart of a `Sale`.
 *
 * NOTE WHAT IS ABSENT: an amount owed. The payable is DERIVED (`grandTotal − paidTotal`), not stored as
 * its own column — the same discipline as a customer's balance.
 */
export type Purchase = {
  id: number
  supplierId: number
  /** The SUPPLIER's own bill number, as written on their invoice. Free text — we only record it. */
  supplierInvoiceNo: string | null
  /** ISO8601 — when the goods were received. */
  at: string

  /** 2-dp money. Σ line.lineTotal — the net landed cost of the goods. */
  subtotalNet: number
  /** 2-dp money. Recoverable input tax on the bill (0 unless the shop reclaims it). */
  taxTotal: number
  /** 2-dp money. subtotalNet + taxTotal — the whole bill. */
  grandTotal: number
  /** 2-dp money. Σ payment.amount — tenders paid NOW; the rest is the payable. */
  paidTotal: number

  notes: string | null
  /** WHO received it. Never null. */
  userId: number
  /** The balanced journal this purchase posted. Null only for a zero-value receipt (a free sample). */
  journalId: number | null
  createdAt: string
}

/**
 * One purchase line — WHAT was received, and at what landed cost.
 *
 * `unitCost` is 4-dp COST (what re-averages the product's weighted cost). `lineTotal` is the 2-dp money
 * value of the line, and it EQUALS the frozen value of the 'purchase' stock movement it created.
 */
export type PurchaseLine = {
  id: number
  purchaseId: number
  productId: number
  /** FROZEN: the product's name AT RECEIPT time. A later rename does not rewrite an old GRN. */
  nameSnapshot: string
  /** 3-dp qty in the product's BASE unit. Always positive — goods coming IN. */
  qtyM: number
  /** FROZEN unit name ("pcs", "kg"). */
  uom: string | null
  /** 4-dp COST — the landed net cost per base unit. A DIFFERENT SCALE from every money field. */
  unitCost: number
  /** 2-dp money = the frozen value of the stock movement this line created. */
  lineTotal: number
  /** The batch this stock went into. A batch-tracked product's purchase creates one. Null otherwise. */
  batchId: number | null
  createdAt: string
}

/**
 * One tender paid AT PURCHASE TIME — cash / bank / wallet. The mirror of a `SalePayment`. There is NO
 * 'credit' tender: the amount NOT paid now IS the payable (`grandTotal − paidTotal`), settled later by
 * a supplier payment.
 */
export type PurchasePayment = {
  id: number
  purchaseId: number
  /** lookups('payment_method').id. NEVER a hardcoded dropdown. NEVER 'credit'. */
  methodLookupId: number
  /** 2-dp money, positive. */
  amount: number
  /** A post-dated cheque: the money is not out of the bank yet. */
  chequeNo: string | null
  chequeDate: string | null
  /** JazzCash / Easypaisa transaction reference. */
  walletRef: string | null
  createdAt: string
}

/** Everything a purchase view needs, in one call — the mirror of `SaleDetail`. */
export type PurchaseDetail = Purchase & {
  lines: PurchaseLine[]
  payments: PurchasePayment[]
  /** Joined for display — not stored on the purchase. */
  supplierName?: string | null
  userName?: string | null
  /** lookups('payment_method').label, joined per payment row. */
  paymentMethodLabels?: Record<number, string>
}

/** A row in the purchases list — the mirror of `SaleListItem`. */
export type PurchaseListItem = Pick<
  Purchase,
  'id' | 'supplierInvoiceNo' | 'at' | 'supplierId' | 'grandTotal' | 'paidTotal' | 'userId'
> & {
  supplierName?: string | null
  userName?: string | null
  lineCount?: number
  /** 2-dp money. grandTotal − paidTotal — what is still owed on this bill. Derived, not stored. */
  payableRemaining?: number
}

/** Every list in this app is paginated — assume 100k+ rows. (CLAUDE.md §4) */
export type PagedResult<T> = {
  rows: T[]
  total: number
  page: number
  pageSize: number
}

// ── Input schemas ────────────────────────────────────────────────────────────
// Validated in MAIN, before anything reaches a service (and by the service itself — the services layer
// is the real boundary, CLAUDE.md §3). The renderer sends INTENT; MAIN decides the money — every
// lineTotal, the payable and the journal are resolved in the service, never trusted from the renderer.

/** Integer money, minor units. Unsigned. */
const MoneyMinor = z.number().int().min(0)
/** Integer money that must actually be an amount. A zero tender is not a tender. */
const PositiveMoneyMinor = z.number().int().positive('Please enter an amount greater than zero.')
/** Integer cost, ten-thousandths (4 dp). A DIFFERENT scale from money. Zero = a free sample. */
const CostUnits = z.number().int().min(0)
const RowId = z.number().int().positive()
const LookupId = z.number().int().positive()

/** ISO date, YYYY-MM-DD. The received date and a cheque's date are DAYS, not timestamps. */
// A real calendar day, from ONE definition (shared/dates.ts). The bare regex this used to be let
// 2026-02-30 through, and JS silently rolls that to March 2 — a date in the wrong month, with no
// error. Imported, not re-implemented: seven copies of the guard is seven chances to miss the eighth.
import { IsoDate } from './dates'

/**
 * One line of a goods-received note.
 *
 * `unitCost` is the 4-dp COST — what the shop PAID per base unit. It is what re-averages the product's
 * weighted-average cost and what the line's value is frozen from. Passing a retail price here (2-dp
 * money) would state the cost a hundred times too low and quietly falsify every profit report.
 *
 * `batchNo`/`expiryDate` are OPTIONAL and belong ONLY to a product flagged `track_batches` — the
 * service checks that flag (this schema cannot see the database). An expiry date has to travel with a
 * batch number, because the batch row is what carries it.
 */
export const PurchaseLineInput = z
  .object({
    productId: RowId,
    /** 3-dp qty. POSITIVE — a purchase brings goods IN. */
    qtyM: z.number().int().positive('Please enter how many were received.'),
    /** 4-dp COST. Zero is allowed — a free sample still lands on the shelf. */
    unitCost: CostUnits,
    /** Only for a track_batches product. */
    batchNo: z.string().trim().min(1).max(100).nullish(),
    /** ISO date. Null = does not expire. */
    expiryDate: IsoDate.nullish()
  })
  .refine((line) => !(line.expiryDate != null && line.batchNo == null), {
    message: 'Please enter a batch number as well as the expiry date.',
    path: ['batchNo']
  })

/**
 * One tender paid at purchase time — cash / bank / wallet. NO 'credit' tender: the unpaid remainder IS
 * the payable, computed by the service. The service refuses a method whose account is Payable or
 * Receivable, in plain language.
 */
export const PurchasePaymentInput = z.object({
  /** lookups('payment_method'). */
  methodLookupId: LookupId,
  /** 2-dp money, > 0. */
  amount: PositiveMoneyMinor,
  chequeNo: z.string().trim().max(50).nullish(),
  chequeDate: IsoDate.nullish(),
  walletRef: z.string().trim().max(100).nullish()
})

/**
 * CREATE A PURCHASE (goods-received note). The renderer sends WHAT was received and HOW MUCH was paid;
 * MAIN freezes every line's value, computes the payable, and posts one balanced journal.
 *
 * `at` is the OPTIONAL received date (a day) — omit it and MAIN dates the purchase to now. `taxTotal`
 * defaults to 0 (a shop that cannot reclaim input tax folds it into unitCost and leaves this at 0).
 * `payments` may be empty — a purchase wholly on account.
 */
export const CreatePurchaseInput = z.object({
  supplierId: RowId,
  /** The supplier's own bill number. Free text. */
  supplierInvoiceNo: z.string().trim().max(100).nullish(),
  /** ISO date the goods were received. Omit for "now". */
  at: IsoDate.optional(),
  /** 2-dp money. Recoverable input tax on the bill. 0 unless the shop reclaims it. */
  taxTotal: MoneyMinor.default(0),
  notes: z.string().trim().max(1000).nullish(),
  lines: z.array(PurchaseLineInput).min(1, 'A purchase needs at least one item.'),
  payments: z.array(PurchasePaymentInput).default([])
})
// NOTE: `paid ≤ grand` is NOT a schema refinement — it needs the frozen line totals, which only the
// service has (the renderer sends intent; MAIN decides the money). The meaningful line-level refinement
// — an expiry date must travel with a batch number — lives on PurchaseLineInput above.

/** List purchases — paginated, filterable by supplier and date range. (CLAUDE.md §4) */
export const ListPurchasesInput = z.object({
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(200).optional(),
  supplierId: RowId.optional(),
  /** ISO date (YYYY-MM-DD) — inclusive lower bound. Validated, so a malformed value is a friendly
   * message, not an empty page or a thrown RangeError deeper in the query. Matches SaleListInput. */
  from: IsoDate.optional(),
  /** ISO date — inclusive upper bound (the whole of that day is inside it). */
  to: IsoDate.optional()
})

export const GetPurchaseInput = z.object({ id: RowId })

// ── Inferred input types ─────────────────────────────────────────────────────

export type PurchaseLineInput = z.infer<typeof PurchaseLineInput>
export type PurchasePaymentInput = z.infer<typeof PurchasePaymentInput>
export type CreatePurchaseInput = z.infer<typeof CreatePurchaseInput>
export type ListPurchasesInput = z.infer<typeof ListPurchasesInput>
export type GetPurchaseInput = z.infer<typeof GetPurchaseInput>
