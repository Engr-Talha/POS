import { z } from 'zod'
import type { PagedResult } from './sales'

/**
 * THE SHIFT / CASH-DRAWER CONTRACT — the types and input schemas main and renderer agree on.
 * (Migration 0012.)
 *
 * A SHIFT is a drawer session: a cashier opens it with a starting float, rings sales and refunds
 * through it all day, records the drawer events that are NOT sales (a no-sale pop, petty cash in or
 * out, a drop to the safe), and at close COUNTS the drawer against what the books say should be there.
 * The difference — over or short — is the single most watched number in a shop.
 *
 * ── THE RENDERER SENDS INTENT. MAIN DECIDES THE MONEY. ─────────────────────────────────────────────
 *
 * Exactly as with a sale (shared/sales.ts), the input says WHAT happened and HOW MUCH cash moved. It
 * does NOT compute `expected_cash` or `variance` — those are DERIVED in main from the shift's own
 * documents and FROZEN at close. `at` is absent from every input: a shift, a close and a drawer
 * movement are timestamped by main, never by a caller whose clock might be wrong. (CLAUDE.md §4.)
 *
 * ── MONEY IS INTEGER 2-dp MINOR UNITS. NEVER A FLOAT. ──────────────────────────────────────────────
 *
 *   openingFloat, countedCash, amount, and every figure on the Z-report are integer paisa/cents.
 */

// ── Enums & constants ────────────────────────────────────────────────────────

/**
 * A drawer event that is NOT a sale.
 *   'no_sale' — the drawer was popped with no sale (to give change, check the float…). Money does NOT
 *               move: amount is 0, there is NO journal, but WHO/WHEN/WHY is logged — an unexplained
 *               no-sale is how cash is lifted, so a reason code is required.
 *   'pay_in'  — cash put INTO the drawer. Posts DR Cash CR Owner Equity (an owner top-up).
 *   'pay_out' — cash taken OUT for a bill or errand. Posts DR General Expenses CR Cash. Reason required.
 *   'drop'    — cash moved to the safe / bank. Posts DR Bank CR Cash — it only relocates the money.
 */
export const CASH_MOVEMENT_TYPES = ['no_sale', 'pay_in', 'pay_out', 'drop'] as const
export type CashMovementType = (typeof CASH_MOVEMENT_TYPES)[number]

/** The `ref_type` a cash movement's journal carries. One string, shared, so writer and reader agree. */
export const CASH_MOVEMENT_REF_TYPE = 'cash_movement'

/** Open while `closed_at` is NULL; closed once it is set. DERIVED on read, never a stored column. */
export type ShiftStatus = 'open' | 'closed'

// ── Row types (read side) ──────────────────────────────────────────────────────

/**
 * One shift. Every money field is 2-dp INTEGER minor units. The four close columns are all NULL while
 * the shift is open and all set, together, the moment it closes (migration 0012's CHECK).
 */
export type Shift = {
  id: number
  openedAt: string
  openedByUserId: number
  /** The cash the drawer STARTS with — the float of small notes for change. >= 0. */
  openingFloat: number

  /** All NULL while open. */
  closedAt: string | null
  closedByUserId: number | null
  /** What the cashier physically counted. */
  countedCash: number | null
  /** What the books say should be there — DERIVED and FROZEN at close. */
  expectedCash: number | null
  /** counted − expected. Positive = OVER, negative = SHORT. */
  variance: number | null

  note: string | null
  createdAt: string

  /** DERIVED from `closedAt` — recompute on read (CLAUDE.md §4). */
  status: ShiftStatus
}

/** One drawer event that was not a sale. `journalId` is NULL only for a no-sale (it moves no money). */
export type CashMovement = {
  id: number
  shiftId: number
  at: string
  type: CashMovementType
  /** 2-dp money. Zero ONLY for a no-sale; positive for the others. */
  amount: number
  /** lookups(...).code — the WHY. Required for no_sale and pay_out; optional for pay_in / drop. */
  reasonCode: string | null
  /**
   * The human label for reasonCode, resolved against the right list for the movement type
   * (no_sale_reason / pay_out_reason). Falls back to the code itself for a free-text pay_in/drop reason,
   * or if the owner has since renamed the lookup. Null when there is no reason. Display this, not the code.
   */
  reasonLabel: string | null
  note: string | null
  userId: number
  journalId: number | null
  createdAt: string
}

/** One tender's slice of a total: which payment method, its label, and the money settled through it. */
export type TenderBreakdown = {
  methodLookupId: number
  label: string
  amount: number
}

/**
 * THE Z-REPORT — the end-of-shift summary, computed from the shift's OWN rows. For an open shift it is
 * a live "so far"; for a closed shift it recomputes the same figures, which equal the frozen
 * `expected_cash` by construction.
 */
export type ZReport = {
  shift: {
    id: number
    openedByName: string | null
    openedAt: string
    closedByName: string | null
    closedAt: string | null
    note: string | null
    status: ShiftStatus
  }
  sales: {
    count: number
    /** SUM(grand_total) of completed sales on the shift. */
    grossTotal: number
    /** Cart discounts + line discounts given on those sales. */
    totalDiscount: number
    totalTax: number
    /** How the grand total was settled, per method. Cash is NET OF CHANGE, so it sums to grossTotal. */
    byTender: TenderBreakdown[]
  }
  refunds: {
    count: number
    /** SUM(grand_total) of returns settled as a tender 'refund' on the shift. */
    total: number
    byTender: TenderBreakdown[]
  }
  voids: {
    /** Sales rung up on this shift that were later voided. */
    count: number
  }
  cashMovements: {
    noSaleCount: number
    payInTotal: number
    payOutTotal: number
    dropTotal: number
  }
  /** Every term integer 2-dp; a term is 0 if none. expectedCash is the reconciliation identity. */
  reconciliation: {
    openingFloat: number
    /** Cash kept from sales: tendered − change handed back. */
    cashSales: number
    /** Udhaar repaid in cash on this shift. */
    cashUdhaar: number
    payIns: number
    /** Cash refunds paid out on this shift. */
    cashRefunds: number
    payOuts: number
    drops: number
    /** opening + cashSales + cashUdhaar + payIns − cashRefunds − payOuts − drops. */
    expectedCash: number
    /** Set only once the shift is closed. */
    countedCash: number | null
    variance: number | null
  }
}

/** One row of the shifts list. Deliberately narrow — a busy shop opens one every day for years. */
export type ShiftListItem = {
  id: number
  openedAt: string
  openedByName: string | null
  closedAt: string | null
  closedByName: string | null
  openingFloat: number
  expectedCash: number | null
  countedCash: number | null
  variance: number | null
  status: ShiftStatus
}

/** A shift with its cash movements and its Z-report — the shift detail screen. */
export type ShiftDetail = Shift & {
  openedByName: string | null
  closedByName: string | null
  cashMovements: CashMovement[]
  zReport: ZReport
}

export type { PagedResult }

// ── Input schemas ────────────────────────────────────────────────────────────
// Validated in MAIN, before anything reaches the service. The renderer is not trusted to have
// validated anything, and neither is a future LAN client. We send ONLY the editable fields, and use
// `.nullish()` for the nullable ones. (CLAUDE.md §4, trap #18.)

/** Integer money, minor units. Unsigned — a float here is how a day's till drifts a rupee. */
const MoneyMinor = z.number().int().min(0)
const RowId = z.number().int().positive()
/** A lookups(...).code — reason codes are stored and passed as CODES, not ids (survive a re-seed). */
const ReasonCode = z.string().trim().min(1).max(50)
const Note = z.string().trim().max(1000).nullish()

/** OPEN a shift with a starting float. The float may be zero (a shop that keeps no change on hand). */
export const OpenShiftInput = z.object({
  openingFloat: MoneyMinor,
  note: Note
})

/** CLOSE the open shift by handing main the physically counted cash. Main computes expected + variance. */
export const CloseShiftInput = z.object({
  countedCash: MoneyMinor,
  note: Note
})

/**
 * RECORD A DRAWER MOVEMENT that is not a sale. The refinements encode the rules the DB CHECK also holds:
 *   • a no-sale moves nothing            → amount MUST be 0, and a reason is REQUIRED (theft vector);
 *   • a pay-out is money leaving the till → amount > 0, and a reason is REQUIRED (theft vector);
 *   • a pay-in / drop                    → amount > 0, reason optional (self-explanatory).
 */
export const CashMovementInput = z
  .object({
    type: z.enum(CASH_MOVEMENT_TYPES),
    amount: MoneyMinor,
    reasonCode: ReasonCode.nullish(),
    note: Note
  })
  .refine((m) => m.type !== 'no_sale' || m.amount === 0, {
    message: 'A no-sale opens the drawer without moving money, so its amount must be zero.',
    path: ['amount']
  })
  .refine((m) => m.type === 'no_sale' || m.amount > 0, {
    message: 'Please enter an amount greater than zero.',
    path: ['amount']
  })
  .refine((m) => (m.type !== 'no_sale' && m.type !== 'pay_out') || m.reasonCode != null, {
    message: 'Please choose a reason from the list.',
    path: ['reasonCode']
  })

export const ListShiftsInput = z.object({
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(200).optional()
})

export const GetShiftInput = z.object({ id: RowId })

// ── Inferred input types ─────────────────────────────────────────────────────────

export type OpenShiftInput = z.infer<typeof OpenShiftInput>
export type CloseShiftInput = z.infer<typeof CloseShiftInput>
export type CashMovementInput = z.infer<typeof CashMovementInput>
export type ListShiftsInput = z.infer<typeof ListShiftsInput>
export type GetShiftInput = z.infer<typeof GetShiftInput>
