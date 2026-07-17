import { z } from 'zod'
import type { PagedResult } from './sales'

/**
 * THE STOCK TAKE CONTRACT — the counting sheet. (Migration 0019, whose header is the spec; read it first.)
 *
 * ── THE DOCUMENT WRAPS THE ENGINE ───────────────────────────────────────────────────────────────────
 * `apply` calls `stock.adjust()` once per varying line — the same engine the Stock screen's hand
 * adjustment uses, which appends the movement, keeps the weighted average honest and posts the balanced
 * journal. This service posts no journal of its own and writes no movement directly. A stock take is a
 * BATCH of adjustments with a sheet of paper around it, and nothing more.
 *
 * ── THE RENDERER SENDS INTENT. MAIN DECIDES THE NUMBERS. ────────────────────────────────────────────
 * Look at what `SetCountInput` CANNOT carry: expected, variance, unit cost, a timestamp, or a user. The
 * renderer says WHICH product and HOW MANY were counted. MAIN reads what the books expected AT THAT
 * INSTANT, reads the carried cost, computes the variance, stamps the clock and derives the counter from
 * the session. A renderer that could name the expected figure could name its own variance — which is to
 * say, it could hide a theft.
 *
 * ── QUANTITY IS INTEGER THOUSANDTHS. NEVER A FLOAT. (CLAUDE.md §4) ──────────────────────────────────
 * `countedQtyM`: 1 piece = 1000, 1.234 kg = 1234. This is what makes counting weighed goods exact.
 */

const RowId = z.number().int().positive()

/**
 * A COUNTED quantity: 3-dp thousandths, never negative. Zero is meaningful and must be allowed — "the
 * shelf was empty" is a finding, and often the most important one on the sheet. You cannot, however,
 * count minus three tins.
 */
const CountedQtyM = z
  .number()
  .int('Please enter a whole quantity.')
  .min(0, 'A counted quantity cannot be negative — enter 0 if the shelf is empty.')
  .max(1_000_000_000, 'That quantity is too large. Please check it.')

export const CreateStockTakeInput = z
  .object({
    /**
     * NO `at` AND NO `userId`. The sheet is stamped with MAIN's clock and the session's user. A caller
     * who could name the date could date a sheet into a month it never counted — including a locked one.
     */
    note: z.string().trim().max(500, 'That note is too long.').nullish()
  })
  .optional()
export type CreateStockTakeInput = z.infer<typeof CreateStockTakeInput>

export const StockTakeIdInput = z.object({ stockTakeId: RowId })
export type StockTakeIdInput = z.infer<typeof StockTakeIdInput>

/**
 * RECORD A COUNT. One product, one quantity. Counting the same product twice on one sheet UPDATES the
 * line — it is a correction, not a second opinion (migration 0019 enforces this with a UNIQUE index).
 *
 * Re-counting RE-FREEZES what the books expect, at the new instant. That is right: the counter is
 * standing at the shelf again, now, and it is now's books their finding is against.
 */
export const SetCountInput = z.object({
  stockTakeId: RowId,
  productId: RowId,
  countedQtyM: CountedQtyM
})
export type SetCountInput = z.infer<typeof SetCountInput>

/** Key a whole shelf in one go. Same rules as SetCountInput, per line. */
export const AddStockTakeLinesInput = z.object({
  stockTakeId: RowId,
  lines: z
    .array(z.object({ productId: RowId, countedQtyM: CountedQtyM }))
    .min(1, 'Please count at least one item.')
    .max(500, 'That is too many items at once. Please save in smaller batches.')
})
export type AddStockTakeLinesInput = z.infer<typeof AddStockTakeLinesInput>

export const RemoveStockTakeLineInput = z.object({
  stockTakeId: RowId,
  productId: RowId
})
export type RemoveStockTakeLineInput = z.infer<typeof RemoveStockTakeLineInput>

/**
 * APPLY THE SHEET — post one stock.adjust per VARYING line, in ONE transaction.
 *
 * A reason code is NOT taken from the renderer: every line posts the shop's own 'stock_take' adjustment
 * reason, because that is what this document IS. (stock.adjust re-validates it against the live
 * lookups list, so a shop that retired the reason gets a sentence, not a crash.)
 */
export const ApplyStockTakeInput = z.object({ stockTakeId: RowId })
export type ApplyStockTakeInput = z.infer<typeof ApplyStockTakeInput>

export const CancelStockTakeInput = z.object({
  stockTakeId: RowId,
  reason: z.string().trim().max(500, 'That note is too long.').nullish()
})
export type CancelStockTakeInput = z.infer<typeof CancelStockTakeInput>

export const ListStockTakesInput = z
  .object({
    page: z.number().int().positive().optional(),
    pageSize: z.number().int().positive().max(200).optional(),
    status: z.enum(['open', 'counted', 'applied', 'cancelled']).optional()
  })
  .optional()
export type ListStockTakesInput = z.infer<typeof ListStockTakesInput>

export type StockTakeStatus = 'open' | 'counted' | 'applied' | 'cancelled'

export type StockTakeRow = {
  id: number
  at: string
  status: StockTakeStatus
  note: string | null
  userId: number | null
  userName: string | null
  appliedAt: string | null
  appliedByName: string | null
  /** How many lines have been counted so far. */
  lineCount: number
  /** How many of those disagree with the books — the ones that will post a correction. */
  varianceLineCount: number
  /**
   * What the variances are WORTH, 2-dp money, signed. Negative = the shop is missing stock. This is
   * the theft signal, and it is what the audit log records against the apply.
   */
  varianceValueMinor: number
}

export type StockTakeLineRow = {
  id: number
  productId: number
  /** FROZEN at counting time — a rename must not rewrite the sheet. */
  nameSnapshot: string
  sku: string
  countedQtyM: number
  /** FROZEN at counting time. See migration 0019: this is evidence, not a live figure. */
  expectedQtyM: number
  /** counted − expected. Negative = stock missing. */
  varianceQtyM: number
  /** 4-dp carried cost, frozen at counting time. */
  unitCost: number
  /** What this line's variance is worth, 2-dp money, signed. */
  varianceValueMinor: number
  /** The movement this line posted. Null until applied — and null forever for a zero-variance line. */
  movementId: number | null
  countedAt: string
  countedByName: string | null
}

export type StockTakeDetail = StockTakeRow & { lines: StockTakeLineRow[] }

export type ApplyStockTakeResult = {
  stockTakeId: number
  /** How many lines actually posted a movement. A zero-variance line posts NOTHING. */
  movementsPosted: number
  /** The signed money the corrections moved, 2-dp. Negative = written off. */
  varianceValueMinor: number
}

export type { PagedResult }
