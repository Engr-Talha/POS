import { z } from 'zod'

/**
 * THE OPENING SETUP CONTRACT — the types and input schemas main and renderer agree on.
 * (Migration 0005.)
 *
 * The Opening Setup wizard captures what the shop ALREADY HAS on the day it starts using this app:
 * stock on the shelf, cash in the till, money in the bank, udhaar customers owe it, and dues it owes
 * suppliers. Without it, the books believe the shop began with nothing and every report is wrong from
 * the first day — the first tin sold shows 100% profit, because as far as the books know it cost
 * nothing.
 *
 * THE ACCOUNTING, in one place, because everything in this file exists to serve it:
 *
 *      opening stock    ->  DR Inventory              CR Opening Balance Equity
 *      opening cash     ->  DR Cash in Hand           CR Opening Balance Equity
 *      opening bank     ->  DR Bank                   CR Opening Balance Equity
 *      customer udhaar  ->  DR Accounts Receivable    CR Opening Balance Equity
 *      supplier dues    ->  DR Opening Balance Equity CR Accounts Payable
 *
 * THREE INTEGER SCALES LIVE IN THIS FILE AND THEY ARE NOT INTERCHANGEABLE:
 *
 *   money  — INTEGER minor units (paisa), 2 dp   openingCash, openingBank, amount, creditLimit
 *            helpers: shared/money.ts   (parseMoney / formatMoney)
 *   cost   — INTEGER ten-thousandths,    4 dp    unitCost
 *            helpers: shared/cost.ts    (parseCost / formatCost / costToPriceMinor)
 *   qty_m  — INTEGER thousandths,        3 dp    qtyM
 *            helpers: shared/qty.ts     (parseQty / formatQty)
 *
 * A quantity times a cost is neither of those things until it is divided back down. Nothing here is
 * ever a float.
 */

// ── Enums & constants ────────────────────────────────────────────────────────

export const OPENING_STATUSES = ['draft', 'committed'] as const
export type OpeningStatus = (typeof OPENING_STATUSES)[number]

/**
 * The `ref_type` every opening journal and every opening stock movement carries. One string, shared,
 * so a report that asks "show me the opening entries" and the code that writes them cannot drift
 * apart over a typo.
 */
export const OPENING_REF_TYPE = 'opening'

// ── Row types ────────────────────────────────────────────────────────────────

/**
 * MINIMAL on purpose. The customer ledger, loyalty and per-customer pricing are Phase 7. This exists
 * now because opening udhaar has to be owed BY SOMEBODY.
 *
 * NOTE WHAT IS ABSENT: a balance. What a customer owes is DERIVED from the ledger, exactly as stock
 * is derived from the movements. There is no column to type it into and there never will be.
 */
export type Customer = {
  id: number
  name: string
  phone: string | null
  address: string | null
  /** lookups('customer_type'). */
  typeLookupId: number | null
  /** 2-dp money. How much udhaar they are ALLOWED to run up. A limit, not a balance. */
  creditLimit: number
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/** The single opening_setup row (id = 1, always). A shop opens its books once. */
export type OpeningSetup = {
  status: OpeningStatus
  /** ISO date (YYYY-MM-DD). The date the opening balances are AS AT — every journal is dated to it. */
  goLiveDate: string
  /** 2-dp money in the till. */
  openingCash: number
  /** 2-dp money in the bank. */
  openingBank: number
  committedAt: string | null
  committedByUserId: number | null
}

/**
 * One line of the stock sheet: "I have 40 of these and they cost me 91.0417 each."
 *
 * Batch and expiry are OPTIONAL, and only offered for products flagged `track_batches`. An ordinary
 * tin of beans is one line with no batch — the owner is never made to invent a batch number for it.
 */
export type OpeningStockLine = {
  id: number
  productId: number
  /** 3-dp qty. Always POSITIVE — an opening line states what the shop HAS. */
  qtyM: number
  /** 4-dp COST — what the shop PAID. Not what it sells for. */
  unitCost: number
  /** Only for a track_batches product. Null otherwise. */
  batchNo: string | null
  /** ISO date. Null = does not expire, or not batch-tracked. */
  expiryDate: string | null
  /** Joined for the wizard's table — not stored. */
  productSku?: string
  productName?: string
  /** qty x cost, converted to 2-dp money. What this line will debit Inventory with. Joined, not stored. */
  lineValueMinor?: number
}

/** What a customer already owes the shop (opening udhaar). One row per customer. */
export type OpeningReceivable = {
  id: number
  customerId: number
  /** 2-dp money. Always POSITIVE. */
  amount: number
  note: string | null
  /** Joined for the wizard's table — not stored. */
  customerName?: string
}

/** What the shop already owes a supplier. One row per supplier. */
export type OpeningPayable = {
  id: number
  supplierId: number
  /** 2-dp money. Always POSITIVE. */
  amount: number
  note: string | null
  /** Joined for the wizard's table — not stored. */
  supplierName?: string
}

/**
 * THE REVIEW SCREEN, and the thing the commit posts. Every figure is 2-dp MONEY (minor units) —
 * including the stock, which is converted from 4-dp cost exactly once, on the way in.
 */
export type OpeningSummary = {
  status: OpeningStatus
  goLiveDate: string

  /** SUM(qtyM x unitCost) over the stock lines, in money. -> DR Inventory */
  stockValueMinor: number
  /** -> DR Cash in Hand */
  openingCashMinor: number
  /** -> DR Bank */
  openingBankMinor: number
  /** SUM of what customers owe the shop. -> DR Accounts Receivable */
  receivablesMinor: number
  /** SUM of what the shop owes suppliers. -> CR Accounts Payable */
  payablesMinor: number

  /**
   * The balancing figure: Inventory + Cash + Bank + Receivables − Payables.
   *
   * POSITIVE = a CREDIT to Opening Balance Equity: the shop is worth something on day one.
   * NEGATIVE = a DEBIT to Opening Balance Equity: the shop owes more than it owns.
   *
   * A negative number here is CORRECT, not a bug. It is a negative net worth, honestly stated, and
   * nothing in this app should try to "fix" it.
   */
  openingBalanceEquityMinor: number

  counts: {
    stockLines: number
    receivables: number
    payables: number
  }

  committedAt: string | null
  committedByUserId: number | null
}

// ── The accounting identity, written down once ───────────────────────────────

/**
 * OBE = Inventory + Cash + Bank + Receivables − Payables.
 *
 * The one formula this whole phase turns on. It lives here — shared, pure, integer-only — so that the
 * service that POSTS the journals and the screen that SHOWS the totals compute it from the same line
 * of code. Two implementations of one identity is how a review screen ends up promising a figure the
 * journal does not post.
 *
 * All inputs and the result are 2-dp money minor units. A negative result is legitimate: see
 * `OpeningSummary.openingBalanceEquityMinor`.
 */
export function openingBalanceEquityMinor(parts: {
  stockValueMinor: number
  openingCashMinor: number
  openingBankMinor: number
  receivablesMinor: number
  payablesMinor: number
}): number {
  return (
    parts.stockValueMinor +
    parts.openingCashMinor +
    parts.openingBankMinor +
    parts.receivablesMinor -
    parts.payablesMinor
  )
}

// ── Input schemas ────────────────────────────────────────────────────────────
// Validated in MAIN, before anything reaches a service. The renderer is not trusted to have validated
// anything, and neither is a future LAN client.
//
// UPDATE SCHEMAS CARRY ONLY EDITABLE FIELDS, and every field is optional:
//   undefined -> "the form did not touch this; leave it alone"
//   null      -> "the user cleared it"   (that is what .nullish() is for)
// We NEVER post a whole object back to a save endpoint. (CLAUDE.md §4, trap #18)

/** Integer money, minor units. Unsigned — a shop cannot hold negative cash. */
const MoneyMinor = z.number().int().min(0)
/** Integer money that must actually be an amount. A zero receivable is not a debt. */
const PositiveMoneyMinor = z
  .number()
  .int()
  .positive('Please enter an amount greater than zero.')
/** Integer cost, ten-thousandths. A DIFFERENT scale from money. */
const CostUnits = z.number().int().min(0)
const RowId = z.number().int().positive()
const LookupId = z.number().int().positive()

/** ISO date, YYYY-MM-DD. The wizard's dates are DAYS, not timestamps. */
// A real calendar day, from ONE definition (shared/dates.ts). The bare regex this used to be let
// 2026-02-30 through, and JS silently rolls that to March 2 — a date in the wrong month, with no
// error. Imported, not re-implemented: seven copies of the guard is seven chances to miss the eighth.
import { IsoDate } from './dates'

const Note = z.string().trim().max(500).nullish()

// ── Customers ────────────────────────────────────────────────────────────────

export const CreateCustomerInput = z.object({
  name: z.string().trim().min(1, 'Please enter the customer name.').max(200),
  phone: z.string().trim().max(50).nullish(),
  address: z.string().trim().max(500).nullish(),
  /** lookups('customer_type'). Never a hardcoded <Select>. */
  typeLookupId: LookupId.nullish(),
  /** 2-dp money. How much udhaar they may run up. A LIMIT, not a balance. */
  creditLimit: MoneyMinor.default(0)
})

export const UpdateCustomerInput = z.object({
  id: RowId,
  name: z.string().trim().min(1, 'Please enter the customer name.').max(200).optional(),
  phone: z.string().trim().max(50).nullish(),
  address: z.string().trim().max(500).nullish(),
  typeLookupId: LookupId.nullish(),
  creditLimit: MoneyMinor.optional(),
  isActive: z.boolean().optional()
  // NO BALANCE FIELD. What a customer owes is derived from the ledger. Not an oversight.
})

export const CustomerListInput = z.object({
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(200).optional(),
  /** Matches name or phone. */
  search: z.string().trim().max(100).optional(),
  includeInactive: z.boolean().optional()
})

export const CustomerGetInput = z.object({ id: RowId })

// ── Opening cash, bank, and the go-live date ─────────────────────────────────

/**
 * The till/bank step of the wizard, and the go-live date.
 *
 * Every field is optional because the wizard saves each step as the owner finishes it — and because
 * an absent field means "I did not touch this", not "set it to zero". Sending a whole object back
 * with `openingBank: 0` because the form never loaded it is exactly how the bank balance gets wiped.
 * At least one field must be present, or this is a write that writes nothing.
 */
export const OpeningCashInput = z
  .object({
    /** ISO date. The date the opening balances are AS AT — every opening journal is dated to it. */
    goLiveDate: IsoDate.optional(),
    /** 2-dp money in the till. */
    openingCash: MoneyMinor.optional(),
    /** 2-dp money in the bank. */
    openingBank: MoneyMinor.optional()
  })
  .refine(
    (input) =>
      input.goLiveDate !== undefined ||
      input.openingCash !== undefined ||
      input.openingBank !== undefined,
    'There is nothing to save. Please enter an amount or a date.'
  )

// ── Opening stock ────────────────────────────────────────────────────────────

/**
 * One line of the stock sheet.
 *
 * `batchNo` and `expiryDate` are OPTIONAL and belong ONLY to a product flagged `track_batches` — the
 * service checks that flag, because this schema cannot see the database. Do NOT force a batch number
 * onto ordinary goods (owner's decision): one line per item, batches optional.
 *
 * `unitCost` is the 4-dp COST — what the shop PAID for it. It is what the opening journal debits
 * Inventory with, and what seeds the product's weighted-average cost. Passing a retail price here
 * (2-dp money) would state the cost a hundred times too low and quietly falsify every profit report
 * the shop ever runs.
 */
export const OpeningStockLineInput = z.object({
  productId: RowId,
  /** 3-dp qty. POSITIVE — an opening line states what the shop HAS. A shortfall is an adjustment. */
  qtyM: z.number().int().positive('Please enter how many you have.'),
  /** 4-dp COST. Zero is allowed — a free sample still sits on the shelf. */
  unitCost: CostUnits.default(0),
  /** Only for a track_batches product. */
  batchNo: z.string().trim().min(1).max(100).nullish(),
  /** ISO date. Null = does not expire. */
  expiryDate: IsoDate.nullish()
})

/**
 * EDIT a line already on the sheet. A DIFFERENT SCHEMA FROM THE ADD, and that is the whole point.
 *
 * Every field is optional and NOTHING HAS A DEFAULT:
 *
 *   key absent  ->  the form never loaded this field. LEAVE THE COLUMN ALONE.
 *   key = null  ->  the user cleared it. Write NULL.  (that is what .nullish() is for)
 *
 * `unitCost` carrying `.default(0)` — right for an ADD, where an absent cost means a free sample —
 * is a LOADED GUN on an edit. zod INJECTS the key, so a caller correcting only the quantity silently
 * posts `unitCost: 0`, the cost the owner typed is overwritten with nothing, and at commit the line
 * debits Inventory with ZERO and seeds the product's weighted average at ZERO. Every subsequent sale
 * of that item then reports a 100% profit — the exact disaster the whole Opening Setup exists to
 * prevent, arriving through the screen built to prevent it. (CLAUDE.md trap #18.)
 */
export const UpdateOpeningStockLineInput = z.object({
  id: RowId,
  productId: RowId.optional(),
  qtyM: z.number().int().positive('Please enter how many you have.').optional(),
  /** NO .default() — see above. Absent means "do not touch the cost". */
  unitCost: CostUnits.optional(),
  batchNo: z.string().trim().min(1).max(100).nullish(),
  expiryDate: IsoDate.nullish()
})

export const DeleteOpeningStockLineInput = z.object({ id: RowId })

export const OpeningStockListInput = z.object({
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(200).optional(),
  /** Matches the product's sku or name. */
  search: z.string().trim().max(100).optional()
})

// ── Opening receivables (customer udhaar) ────────────────────────────────────

/**
 * What a customer already owes the shop. One row per customer — the opening figure is a balance
 * ("Rashid owes 12,400"), not a list of the invoices behind it. Those invoices predate the app and
 * inventing them would be inventing data.
 */
export const OpeningReceivableInput = z.object({
  customerId: RowId,
  /** 2-dp money, POSITIVE. A customer who owes nothing is not a receivable. */
  amount: PositiveMoneyMinor,
  note: Note
})

/**
 * EDIT an udhaar row. Optional fields, no defaults — an absent key leaves the column alone.
 * Post the whole object back instead and a dialog that corrects only the amount wipes the note the
 * owner wrote to remind themselves WHICH ledger page the figure came off. (CLAUDE.md trap #18.)
 */
export const UpdateOpeningReceivableInput = z.object({
  id: RowId,
  customerId: RowId.optional(),
  amount: PositiveMoneyMinor.optional(),
  note: Note
})

export const DeleteOpeningReceivableInput = z.object({ id: RowId })

// ── Opening payables (supplier dues) ─────────────────────────────────────────

/** What the shop already owes a supplier. One row per supplier. */
export const OpeningPayableInput = z.object({
  supplierId: RowId,
  /** 2-dp money, POSITIVE. */
  amount: PositiveMoneyMinor,
  note: Note
})

/** EDIT a supplier due. Optional fields, no defaults — same rule, same reason. (Trap #18.) */
export const UpdateOpeningPayableInput = z.object({
  id: RowId,
  supplierId: RowId.optional(),
  amount: PositiveMoneyMinor.optional(),
  note: Note
})

export const DeleteOpeningPayableInput = z.object({ id: RowId })

// ── Commit ───────────────────────────────────────────────────────────────────

/**
 * THE ONE-WAY DOOR. Posts every opening journal and every opening stock movement, in one transaction.
 *
 * `confirm` is not ceremony. Committing twice would not fail — it would succeed, posting the entire
 * opening balance a SECOND time (double the stock, double the cash, double the equity) with the trial
 * balance still balancing perfectly, because two balanced journals balance. Nothing downstream would
 * ever catch it. The service refuses a second commit on `status`; this is the deliberate click in
 * front of the first one.
 */
export const CommitOpeningInput = z.object({
  confirm: z
    .boolean()
    .refine((v) => v === true, 'Please confirm the opening balances before saving them.')
})

// ── Inferred input types ─────────────────────────────────────────────────────

export type CreateCustomerInput = z.infer<typeof CreateCustomerInput>
export type UpdateCustomerInput = z.infer<typeof UpdateCustomerInput>
export type CustomerListInput = z.infer<typeof CustomerListInput>
export type CustomerGetInput = z.infer<typeof CustomerGetInput>
export type OpeningCashInput = z.infer<typeof OpeningCashInput>
export type OpeningStockLineInput = z.infer<typeof OpeningStockLineInput>
export type UpdateOpeningStockLineInput = z.infer<typeof UpdateOpeningStockLineInput>
export type DeleteOpeningStockLineInput = z.infer<typeof DeleteOpeningStockLineInput>
export type OpeningStockListInput = z.infer<typeof OpeningStockListInput>
export type OpeningReceivableInput = z.infer<typeof OpeningReceivableInput>
export type UpdateOpeningReceivableInput = z.infer<typeof UpdateOpeningReceivableInput>
export type DeleteOpeningReceivableInput = z.infer<typeof DeleteOpeningReceivableInput>
export type OpeningPayableInput = z.infer<typeof OpeningPayableInput>
export type UpdateOpeningPayableInput = z.infer<typeof UpdateOpeningPayableInput>
export type DeleteOpeningPayableInput = z.infer<typeof DeleteOpeningPayableInput>
export type CommitOpeningInput = z.infer<typeof CommitOpeningInput>
