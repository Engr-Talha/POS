import { z } from 'zod'
import type { PagedResult, SaleStatus } from './sales'

/**
 * THE RETURNS CONTRACT — the types and input schema main and renderer agree on. (Migration 0011.)
 *
 * A RETURN reverses a REAL, COMPLETED sale: the customer kept most of it and brought SOME of it back.
 * It is its own document (never touches the sale), it can be partial, and one sale can have many.
 *
 * ── THE RENDERER SENDS INTENT. MAIN DECIDES THE MONEY. ──────────────────────────────────────────────
 *
 * Exactly as with a sale (shared/sales.ts), a return line says WHICH sale line came back and HOW MANY.
 * It does NOT say what to refund. `net`, `taxAmount`, `gross` and `unitCost` appear NOWHERE in the input.
 * Main reads the FROZEN figures off the original sale line, scales them to the returned quantity, and
 * freezes the result onto the return line. A tampered renderer cannot refund a Rs 200,000 television for
 * Rs 199,999 behind a balanced journal. (CLAUDE.md §4 — the renderer is not a security boundary.)
 *
 * ── THE CLOCK IS MAIN'S, AND SO IS THE APPROVER. ───────────────────────────────────────────────────
 *
 * `at` is absent from the input: a return is timestamped by main, never by the caller (a wrong client
 * clock must not backdate a refund into a locked, already-reported month). And a refund is a Supervisor
 * action (rbac `sale.refund`): when a cashier processes it, they enter a supervisor's PIN, and main
 * derives WHO approved it FROM that PIN (`approverPin`) — never from a claimed id.
 *
 * ── THREE INTEGER SCALES, NEVER MIXED. ─────────────────────────────────────────────────────────────
 *
 *   money  — INTEGER minor units (paisa), 2 dp   net, taxAmount, gross, subtotalNet, grandTotal
 *   cost   — INTEGER ten-thousandths,     4 dp   unitCost — the FROZEN COGS the stock comes back at
 *   qty_m  — INTEGER thousandths,         3 dp   qtyM (1 piece = 1000, 1.234 kg = 1234)
 */

// ── Enums ──────────────────────────────────────────────────────────────────────

/**
 * HOW THE MONEY IS SETTLED.
 *   'refund'          — money OUT through one tender (lookups('payment_method')). `refundMethodLookupId`
 *                       is required; the journal credits Cash / Bank / … for the whole grand total.
 *   'customer_credit' — the sale was on udhaar and is REDUCED instead of paid out. Credits Accounts
 *                       Receivable. Valid only when the original sale had a customer.
 *   'exchange'        — the return's value is consumed by a replacement sale carrying `exchangeGroupId`.
 *                       Minimal in this phase: it posts a store-credit placeholder (CR Receivable) and
 *                       requires a customer; the guided replacement-sale flow is deferred.
 */
export const SETTLEMENTS = ['refund', 'customer_credit', 'exchange'] as const
export type Settlement = (typeof SETTLEMENTS)[number]

/** The `ref_type` a return's journal and stock movements carry. One string, shared, so writers agree. */
export const RETURN_REF_TYPE = 'return'

// ── Row types (read side) ──────────────────────────────────────────────────────

/**
 * One line of a return, FROZEN. Mirrors the sale line it reverses — scaled to the quantity coming back,
 * with the cart-level discount already inside the figures the sale froze (so `net` is what the customer
 * actually PAID for these units, not the sticker price). gross === net + taxAmount, always.
 */
export type ReturnLine = {
  id: number
  returnId: number
  /** The exact sale line these units came off — what "already returned" is summed over. */
  saleLineId: number
  /** NULL for an OPEN ITEM, which has no catalogue row behind it. */
  productId: number | null
  /** FROZEN name, so an old return still reads true after a rename. */
  nameSnapshot: string
  /** 3-dp qty in the BASE unit, positive. Never more than remained un-returned on the sale line. */
  qtyM: number
  uom: string | null

  /** 2-dp money, FROZEN. */
  net: number
  taxRateBp: number
  taxAmount: number
  gross: number

  /** 4-dp COST — a DIFFERENT SCALE. The weighted-average cost frozen on the sale line. */
  unitCost: number

  /** 1 = went back on the sellable shelf (a 'sale_return' movement exists at unitCost); 0 = did not. */
  restocked: boolean
  /**
   * Whether this line COULD go back on a shelf at all — a catalogue INVENTORY item. False for an open
   * item (no catalogue row) and for a non-inventory service. It disambiguates the two reasons a line is
   * not restocked: `restocked = false && stockable = true` is a DAMAGED write-off; `stockable = false`
   * simply has no shelf, and must not be labelled "damaged".
   */
  stockable: boolean
  /** The batch it was restocked to — the same batch it was sold from. NULL if none / not restocked. */
  batchId: number | null

  createdAt: string
}

/** One return document. Every money field is 2-dp INTEGER minor units. */
export type Return = {
  id: number
  /** The completed sale the goods came from. */
  saleId: number
  at: string
  /** WHO processed it. */
  userId: number

  /** WHO authorised it (a Supervisor+), and their role SNAPSHOTTED at the time. Never a join. */
  approvedByUserId: number
  approvedByRole: string

  /** WHY — a live code on lookups('refund_reason'). Free text is optional colour on top. */
  reasonCode: string
  reasonText: string | null

  settlement: Settlement
  /** lookups('payment_method').id — set only for a 'refund'. */
  refundMethodLookupId: number | null
  /** The replacement sale's correlation id — set only for an 'exchange'. */
  exchangeGroupId: number | null

  /** FROZEN totals. grandTotal is the amount settled, and equals subtotalNet + taxTotal. */
  subtotalNet: number
  taxTotal: number
  grandTotal: number

  /** The balanced journal this return posted. NULL only for a zero-value return that moved no money. */
  journalId: number | null

  notes: string | null
  createdAt: string
}

/** A return with its lines and a few joined labels — the return detail screen, and the credit note. */
export type ReturnDetail = Return & {
  lines: ReturnLine[]
  /** Joined for display, not stored on the return. */
  saleInvoiceNo?: string | null
  customerId?: number | null
  cashierName?: string | null
  /** lookups('payment_method').label for the refund tender. */
  refundMethodLabel?: string | null
}

/** One row of the returns list. Deliberately narrow — a busy shop has years of them. */
export type ReturnListItem = Pick<
  Return,
  'id' | 'saleId' | 'at' | 'settlement' | 'grandTotal' | 'reasonCode' | 'userId'
> & {
  saleInvoiceNo?: string | null
  lineCount?: number
}

/**
 * One returnable line — everything the picker needs to let a cashier choose what comes back.
 * `returnableQtyM` = sold − already returned; the service refuses any request above it.
 */
export type ReturnableLine = {
  saleLineId: number
  productId: number | null
  isOpenItem: boolean
  nameSnapshot: string
  uom: string | null

  /** The whole quantity this sale line sold, in BASE units. */
  soldQtyM: number
  /** SUM of what prior returns already took off this line, in BASE units. */
  alreadyReturnedQtyM: number
  /** soldQtyM − alreadyReturnedQtyM. Zero once the line is fully returned. */
  returnableQtyM: number

  /** The sale line's FROZEN figures, so the UI can show what a full-line refund would be worth. */
  unitPrice: number
  net: number
  taxRateBp: number
  taxAmount: number
  gross: number
  unitCost: number
  batchId: number | null
}

/** What the returns desk sees after looking a sale up by number or id: the sale, and its lines. */
export type ReturnableSale = {
  saleId: number
  invoiceNo: string | null
  status: SaleStatus
  at: string
  customerId: number | null
  customerName: string | null
  lines: ReturnableLine[]
}

export type { PagedResult }

// ── Input schema ────────────────────────────────────────────────────────────────
// Validated in MAIN, before anything reaches the service. The renderer is not trusted to have
// validated anything, and neither is a future LAN client. We send ONLY the editable fields, and use
// `.nullish()` for the nullable ones. (CLAUDE.md §4, trap #18.)

const RowId = z.number().int().positive()
const LookupId = z.number().int().positive()
/** A lookups(...).code — reason codes are stored and passed as CODES, not ids (survive a re-seed). */
const ReasonCode = z.string().trim().min(1).max(50)
/** ISO date, YYYY-MM-DD. */
// A real calendar day, from ONE definition (shared/dates.ts). The bare regex this used to be let
// 2026-02-30 through, and JS silently rolls that to March 2 — a date in the wrong month, with no
// error. Imported, not re-implemented: seven copies of the guard is seven chances to miss the eighth.
import { IsoDate } from './dates'

/**
 * ONE LINE COMING BACK — WHICH sale line, and HOW MANY of it. Not what to refund.
 *
 * `restocked` defaults to TRUE: most returns go back on the sellable shelf. A damaged / faulty item is
 * marked `restocked: false` and the shop eats the cost — no stock movement, no inventory/COGS leg.
 */
export const ReturnLineInput = z.object({
  saleLineId: RowId,
  /** 3-dp qty in the BASE unit. 1 piece = 1000. Positive, and never more than remains un-returned. */
  qtyM: z.number().int().positive('Please enter a quantity to return.'),
  restocked: z.boolean().default(true)
})

/**
 * CREATE A RETURN. The one that moves money back.
 *
 * Exactly one companion column travels with each settlement, mirrored here for a friendly early error;
 * the service also fixes them by settlement so a stray field can never reach the DB CHECK.
 */
export const CreateReturnInput = z
  .object({
    saleId: RowId,
    lines: z.array(ReturnLineInput).min(1, 'Please choose at least one item to return.'),

    settlement: z.enum(SETTLEMENTS),
    /** Required for 'refund' — lookups('payment_method').id. The tender the money goes out through. */
    refundMethodLookupId: LookupId.nullish(),
    /** Required for 'exchange' — the replacement sale's correlation id (sales.exchange_group_id). */
    exchangeGroupId: RowId.nullish(),

    /** lookups('refund_reason').code. Validated live in main, like a void's reason. */
    reasonCode: ReasonCode,
    reasonText: z.string().trim().max(500).nullish(),

    /**
     * The SUPERVISOR'S PIN, when a cashier processes the return. Main verifies it and derives the
     * approver FROM it — the renderer never says who approved. An unverified id would let a cashier
     * self-approve a refund and frame a supervisor. Absent when the actor is already a Supervisor+.
     */
    approverPin: z.string().trim().min(4).max(12).nullish(),

    notes: z.string().trim().max(1000).nullish()
  })
  .refine((r) => r.settlement !== 'refund' || r.refundMethodLookupId != null, {
    message: 'Please choose how the refund is being paid.',
    path: ['refundMethodLookupId']
  })
  .refine((r) => r.settlement !== 'exchange' || r.exchangeGroupId != null, {
    message: 'An exchange must be linked to its replacement sale.',
    path: ['exchangeGroupId']
  })

export const ListReturnsInput = z.object({
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(200).optional(),
  saleId: RowId.optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional()
})

export const GetReturnInput = z.object({ id: RowId })

// ── Inferred input types ─────────────────────────────────────────────────────────

export type ReturnLineInput = z.infer<typeof ReturnLineInput>
export type CreateReturnInput = z.infer<typeof CreateReturnInput>
export type ListReturnsInput = z.infer<typeof ListReturnsInput>
export type GetReturnInput = z.infer<typeof GetReturnInput>
