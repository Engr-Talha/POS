import { z } from 'zod'
import type { PagedResult } from './purchases'

/**
 * THE RETURNS-TO-SUPPLIER CONTRACT — the types and input schemas main and renderer agree on for goods
 * going BACK to the distributor. (Migration 0016.) The mirror of `shared/returns.ts`, pointing the other
 * way: a customer return takes stock IN and pays money OUT; a SUPPLIER return sends stock BACK OUT and
 * either lowers what the shop OWES ('supplier_credit') or brings a refund IN ('refund').
 *
 * ── THE RENDERER SENDS INTENT. MAIN DECIDES THE MONEY. ──────────────────────────────────────────────
 *
 * A return line says WHICH purchase line the goods came in on, and HOW MANY are going back. It does NOT
 * say what they are worth. `unitCost`, `lineTotal`, `subtotalNet`, `taxTotal` and `grandTotal` appear
 * NOWHERE in the input. Main reads the FROZEN 4-dp unit_cost off the original purchase line, records the
 * stock movement at THAT cost, and reads the movement's own frozen value back as the line total. A
 * tampered renderer cannot send Rs 60 of tins back for a Rs 5,000 credit behind a balanced journal.
 * (CLAUDE.md §4 — the renderer is not a security boundary.)
 *
 * ── GOODS LEAVE AT THE COST THEY CAME IN AT ─────────────────────────────────────────────────────────
 *
 * Buy 10 tins @ Rs 60, then 10 @ Rs 80 (the weighted average is now Rs 70) and send one of the FIRST
 * tins back: Inventory must fall by Rs 60, NOT Rs 70. The purchase line's frozen unit_cost is what the
 * return line copies and what the movement is recorded at — never today's re-averaged figure. Same
 * discipline as `sale_lines.unit_cost` and migration 0006.
 *
 * ── THREE INTEGER SCALES, NEVER MIXED (CLAUDE.md §4) ────────────────────────────────────────────────
 *
 *   money  — INTEGER minor units (paisa),  2 dp   lineTotal, subtotalNet, taxTotal, grandTotal
 *   cost   — INTEGER ten-thousandths,      4 dp   unitCost — a DIFFERENT scale, 100× money
 *   qty_m  — INTEGER thousandths,          3 dp   qtyM (1 piece = 1000, 1.234 kg = 1234)
 */

// ── Enums & constants ────────────────────────────────────────────────────────────

/**
 * HOW THE RETURN IS SETTLED.
 *   'supplier_credit' — the common case. The credit comes off what the shop owes the supplier:
 *                       DR Accounts Payable. It shows on the supplier's statement as a credit line and
 *                       LOWERS the derived supplier balance by exactly the same paisa the GL moved.
 *   'refund'          — the supplier paid it back through a real tender: DR Cash / Bank. It never
 *                       touches Payables, and never appears on the supplier statement.
 */
export const PURCHASE_RETURN_SETTLEMENTS = ['supplier_credit', 'refund'] as const
export type PurchaseReturnSettlement = (typeof PURCHASE_RETURN_SETTLEMENTS)[number]

/** The `ref_type` a purchase return's journal and stock movements carry. Shared, so writers agree. */
export const PURCHASE_RETURN_REF_TYPE = 'purchase_return'

// ── Row types (read side) ────────────────────────────────────────────────────────

/**
 * One line of a return to supplier, FROZEN.
 *
 * `unitCost` is the 4-dp COST copied verbatim from the purchase line — what these units cost when they
 * arrived. `lineTotal` is the 2-dp money value of the 'purchase_return' stock movement this line created,
 * READ BACK from the movement, never a fresh qty × cost multiply.
 */
export type PurchaseReturnLine = {
  id: number
  purchaseReturnId: number
  /** The exact purchase line these units arrived on — what "already returned" is summed over. */
  purchaseLineId: number
  productId: number
  /** FROZEN name, so an old return still reads true after a rename. */
  nameSnapshot: string
  /** 3-dp qty in the BASE unit, POSITIVE. The stock movement it wrote is the negative of this. */
  qtyM: number
  uom: string | null
  /** 4-dp COST — a DIFFERENT SCALE. The purchase line's frozen landed cost. */
  unitCost: number
  /** 2-dp money = the frozen value of the stock movement this line created. */
  lineTotal: number
  /** The batch the goods went back OUT of — the same one they were received into. NULL if untracked. */
  batchId: number | null
  createdAt: string
}

/** One return-to-supplier document. Every money field is 2-dp INTEGER minor units. */
export type PurchaseReturn = {
  id: number
  /** The purchase the goods arrived on. Its supplier is the supplier — never re-pointed. */
  purchaseId: number
  at: string
  /** WHO sent the goods back. */
  userId: number

  /** WHY — a live code on lookups('purchase_return_reason'). Free text is optional colour on top. */
  reasonCode: string
  reasonText: string | null

  settlement: PurchaseReturnSettlement
  /** lookups('payment_method').id — set only for a 'refund'. NULL for 'supplier_credit'. */
  refundMethodLookupId: number | null

  /** FROZEN totals. grandTotal = subtotalNet + taxTotal (also a DB CHECK). */
  subtotalNet: number
  taxTotal: number
  grandTotal: number

  notes: string | null
  /** The balanced journal this return posted. NULL only for a zero-value return that moved no money. */
  journalId: number | null
  createdAt: string
}

/** A return with its lines and the joined labels the detail screen and the debit note show. */
export type PurchaseReturnDetail = PurchaseReturn & {
  lines: PurchaseReturnLine[]
  /** Joined for display, not stored on the return. */
  supplierId?: number | null
  supplierName?: string | null
  purchaseInvoiceNo?: string | null
  userName?: string | null
  /** lookups('payment_method').label for the refund tender. */
  refundMethodLabel?: string | null
}

/** One row of the returns-to-supplier list. Deliberately narrow — a busy shop has years of them. */
export type PurchaseReturnListItem = Pick<
  PurchaseReturn,
  'id' | 'purchaseId' | 'at' | 'settlement' | 'grandTotal' | 'reasonCode' | 'userId'
> & {
  supplierId?: number | null
  supplierName?: string | null
  purchaseInvoiceNo?: string | null
  userName?: string | null
  lineCount?: number
}

/**
 * One returnable purchase line — everything the picker needs to let a manager choose what goes back.
 * `returnableQtyM` = received − already returned; the service refuses any request above it.
 */
export type ReturnablePurchaseLine = {
  purchaseLineId: number
  productId: number
  nameSnapshot: string
  uom: string | null

  /** The whole quantity this purchase line received, in BASE units. */
  receivedQtyM: number
  /** SUM of what prior returns already sent back off this line, in BASE units. */
  alreadyReturnedQtyM: number
  /** receivedQtyM − alreadyReturnedQtyM. Zero once the line has been fully returned. */
  returnableQtyM: number

  /** The purchase line's FROZEN 4-dp cost — what these units will leave at. Drives the UI's value. */
  unitCost: number
  /** The purchase line's FROZEN 2-dp value, so the UI can show what a full-line return is worth. */
  lineTotal: number
  /** The batch the goods came in on — the batch they go back out of. */
  batchId: number | null
}

/** What the returns-to-supplier screen sees after looking a purchase up: the bill, and its lines. */
export type ReturnablePurchase = {
  purchaseId: number
  supplierId: number
  supplierName: string | null
  supplierInvoiceNo: string | null
  at: string
  /** The purchase's FROZEN tax total — the pool this return's input tax is apportioned out of. */
  taxTotal: number
  lines: ReturnablePurchaseLine[]
}

export type { PagedResult }

// ── Input schemas ────────────────────────────────────────────────────────────────
// Validated in MAIN, before anything reaches the service (and by the service itself — the services layer
// is the real boundary, CLAUDE.md §3). We send ONLY the editable fields, and `.nullish()` for the
// nullable columns (CLAUDE.md §4, trap #18).

const RowId = z.number().int().positive()
const LookupId = z.number().int().positive()
/** A lookups(...).code — reason codes are stored and passed as CODES, not ids (survive a re-seed). */
const ReasonCode = z.string().trim().min(1).max(50)

/** ISO date, YYYY-MM-DD. The list bounds are DAYS, not timestamps. */
const IsoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Please pick a date.')
  // ...and a REAL calendar date. The shape alone lets 2026-02-30 through, and JS silently rolls it to
  // March 2 — so a filter typed at the service/LAN boundary would quietly report the wrong window with
  // no error. Reject anything whose parts do not round-trip. (The same fix expenses took.)
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

/**
 * ONE LINE GOING BACK — WHICH purchase line, and HOW MANY of it. Not what it is worth.
 *
 * The cost is NOT here by design: main copies the purchase line's frozen unit_cost. Letting the caller
 * state a cost would let a Rs 60 tin be credited at Rs 600 behind a perfectly balanced journal.
 */
export const PurchaseReturnLineInput = z.object({
  purchaseLineId: RowId,
  /** 3-dp qty in the BASE unit. 1 piece = 1000. Positive, never more than remains un-returned. */
  qtyM: z.number().int().positive('Please enter a quantity to send back.')
})

/**
 * CREATE A RETURN TO SUPPLIER. The one that moves stock and money back.
 *
 * `at` is absent by design: a return is timestamped by MAIN, never by the caller — a wrong client clock
 * must not backdate a credit into a locked, already-reported month.
 *
 * Exactly one companion column travels with each settlement, mirrored here for a friendly early error;
 * the service also fixes them by settlement so a stray field can never reach the DB's CHECK.
 */
export const CreatePurchaseReturnInput = z
  .object({
    purchaseId: RowId,
    lines: z
      .array(PurchaseReturnLineInput)
      .min(1, 'Please choose at least one item to send back.'),

    settlement: z.enum(PURCHASE_RETURN_SETTLEMENTS),
    /**
     * Required for 'refund' — lookups('payment_method').id, the tender the money came back through.
     * The service refuses a method resolving to Payable/Receivable: a refund is real money, and taking
     * it off the bill is its own settlement ('supplier_credit').
     */
    refundMethodLookupId: LookupId.nullish(),

    /** lookups('purchase_return_reason').code. Validated LIVE in main. */
    reasonCode: ReasonCode,
    reasonText: z.string().trim().max(500).nullish(),

    notes: z.string().trim().max(1000).nullish()
  })
  .refine((r) => r.settlement !== 'refund' || r.refundMethodLookupId != null, {
    message: 'Please choose how the supplier paid the refund.',
    path: ['refundMethodLookupId']
  })

/** List returns to supplier — paginated, filterable by purchase, supplier and date range. */
export const ListPurchaseReturnsInput = z.object({
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(200).optional(),
  purchaseId: RowId.optional(),
  supplierId: RowId.optional(),
  /** ISO date (YYYY-MM-DD) — inclusive lower bound. */
  from: IsoDate.optional(),
  /** ISO date — inclusive upper bound (the whole of that day is inside it). */
  to: IsoDate.optional()
})

export const GetPurchaseReturnInput = z.object({ id: RowId })

// ── Inferred input types ─────────────────────────────────────────────────────────

export type PurchaseReturnLineInput = z.infer<typeof PurchaseReturnLineInput>
export type CreatePurchaseReturnInput = z.infer<typeof CreatePurchaseReturnInput>
export type ListPurchaseReturnsInput = z.infer<typeof ListPurchaseReturnsInput>
export type GetPurchaseReturnInput = z.infer<typeof GetPurchaseReturnInput>
