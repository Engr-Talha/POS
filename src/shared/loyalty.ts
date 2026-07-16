import { z } from 'zod'
import type { PagedResult } from './sales'

/**
 * THE LOYALTY CONTRACT — the types and input schemas main and renderer agree on. (Migration 0017.)
 *
 * A point is a PROMISE: come back, and this is worth something at the till. That promise is real money
 * the shop will hand over later, so it is a LIABILITY (ACC.LOYALTY 2200) booked the moment it is EARNED
 * — never when it is redeemed. Read migration 0017's header; it is the spec this file serves.
 *
 * ── REDEMPTION IS A TENDER, NOT A DISCOUNT ──────────────────────────────────────────────────────────
 * Points PAY for goods; they do not reduce their price. A redemption is a PAYMENT LINE on the sale,
 * exactly like cash — revenue and output tax are unchanged, and the frozen sale lines are untouched.
 * A discount would understate revenue AND under-collect output tax on every redemption.
 *
 * ── THE RENDERER SENDS INTENT. MAIN DECIDES THE MONEY. ──────────────────────────────────────────────
 * The input says WHO, WHICH SALE and HOW MANY POINTS. It never sends a rupee value and never names a
 * ledger account: the service reads `loyalty.redeemValueMinor` from settings, computes the value, and
 * FREEZES it onto the movement. A renderer that could send `valueMinor` could tell the shop what it
 * owes. `userId` is never sent either — it is the authenticated session in MAIN (CLAUDE.md §4).
 *
 * ── POINTS ARE NOT MONEY AND NOT A QUANTITY ─────────────────────────────────────────────────────────
 * `points` is a plain whole INTEGER — a count of promises. It is NOT scaled: not minor units, not
 * thousandths. Its rupee value is `points × loyalty.redeemValueMinor`, and THAT is integer 2-dp money.
 */

// ── Schema primitives ──────────────────────────────────────────────────────────
// Validated in MAIN, before anything reaches the service (and by the service itself — the services
// layer is the real boundary, CLAUDE.md §3). We send ONLY the editable fields and use `.nullish()` for
// the nullable columns. (CLAUDE.md §4, trap #18 — never POST a whole object back.)

const RowId = z.number().int().positive()

/** Whole points, > 0. Not money, not scaled. A movement of zero points is not an event (0017's CHECK). */
const PositivePoints = z
  .number()
  .int('Points must be a whole number.')
  .positive('Please enter a number of points greater than zero.')

/**
 * A SIGNED whole point count for an adjust, which is the one movement that can run either way: positive
 * to give points (goodwill), negative to take them back (fixing a mistake). Zero is refused — a movement
 * that moves nothing is not an event, and the table's CHECK (points <> 0) would refuse it anyway.
 */
const NonZeroPoints = z
  .number()
  .int('Points must be a whole number.')
  .refine((value) => value !== 0, 'Please enter a number of points other than zero.')

/** ISO date, YYYY-MM-DD. The history bounds are DAYS, not timestamps. */
const IsoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Please pick a date.')
  // ...and a REAL calendar date. The shape alone lets 2026-02-30 through, and JS silently rolls it to
  // March 2 — so a history filtered at the service/LAN boundary would quietly cover the wrong days with
  // no error. Reject anything whose parts do not round-trip. (Copied from shared/expenses.ts, where the
  // audit that found this is written up.)
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

/** WHY the points moved. Mirrors the CHECK constraint on loyalty_movements.type (migration 0017). */
export const LOYALTY_MOVEMENT_TYPES = ['earn', 'redeem', 'expire', 'adjust'] as const
export type LoyaltyMovementType = (typeof LOYALTY_MOVEMENT_TYPES)[number]

/**
 * One loyalty movement, as stored (migration 0017). The ONLY source of a customer's balance — there is
 * no `customers.points` column and there never will be (CLAUDE.md §4, same law as stock).
 */
export type LoyaltyMovement = {
  id: number
  /** Points belong to a NAMED customer. A walk-in cannot earn them — nobody could ever claim them. */
  customerId: number
  /** ISO8601 — WHEN the points moved. The history is ordered by it. */
  at: string
  type: LoyaltyMovementType
  /**
   * WHOLE points. POSITIVE = the customer gained them (earn, a positive adjust); NEGATIVE = they left
   * (redeem, expire, a negative adjust). SUM over a customer IS their balance. Never 0.
   */
  points: number
  /**
   * The FROZEN 2-dp rupee value of these points when they moved: |points| × the redeem rate in force at
   * THAT instant. This is what the journal posted, so a later change to the rate can never rewrite
   * history. MAGNITUDE only — the sign lives on `points`.
   */
  valueMinor: number
  /** What caused it: 'sale' for an earn/redeem; null for an expire/adjust, which are events in themselves. */
  refType: string | null
  refId: number | null
  /** lookups('adjustment_reason').code — REQUIRED for an adjust, which the service enforces. */
  reasonCode: string | null
  reasonText: string | null
  /** WHO did it. Never null on a committed row. */
  userId: number
  /** The balanced journal this movement posted. Never null on a committed row (both land in one txn). */
  journalId: number | null
  createdAt: string
}

/**
 * A movement hydrated with the human labels the screen shows. The labels are JOINED for display, never
 * stored on the row; a label is null only if the owner has since removed the lookup or the user was
 * deleted. (The reason LABEL is joined on the live list; the reason CODE on the row is the frozen fact.)
 */
export type LoyaltyMovementRow = LoyaltyMovement & {
  /** users.full_name of whoever caused it. */
  userName: string | null
  /** lookups('adjustment_reason').label for an adjust — display this, not the code. */
  reasonLabel: string | null
}

/** A customer's points, derived on read: the balance and what it is worth at TODAY's rate. */
export type LoyaltyBalance = {
  customerId: number
  /** SUM(loyalty_movements.points). Derived, never stored. */
  points: number
  /**
   * 2-dp money — `points × loyalty.redeemValueMinor` at the CURRENT rate. What the customer would get
   * if they spent the lot today. This is deliberately NOT the sum of the frozen `valueMinor`s: that is
   * what the books owe, this is what the customer is offered. They differ after a rate change, and the
   * service's header explains who absorbs the difference.
   */
  valueMinor: number
}

export type { PagedResult }

// ── Input schemas ──────────────────────────────────────────────────────────────

/**
 * EARN points on a completed sale. `netAmount` is the sale's NET (ex-tax) value MINUS anything paid with
 * points — see the service header for why both subtractions are deliberate. The caller (sales.complete)
 * computes it from the frozen sale lines; MAIN turns it into points using `loyalty.pointsPerCurrencyUnit`.
 *
 * ABSENT, ON PURPOSE:
 *   points    — MAIN derives them from the settings. A caller that could send them could mint liability.
 *   userId    — the authenticated session in MAIN, never the renderer.
 */
export const EarnForSaleInput = z.object({
  customerId: RowId,
  saleId: RowId,
  /** 2-dp money, >= 0 — the NET, ex-tax, non-points-funded value the points are earned on. */
  netAmount: z.number().int('That amount is not valid.').nonnegative('That amount is not valid.')
})

/**
 * REDEEM points as a TENDER on a sale. The caller sends the POINTS the customer wants to spend; MAIN
 * values them at the CURRENT rate and returns the frozen `valueMinor`, which is the figure the sale must
 * tender — never a rupee amount the renderer worked out for itself.
 */
export const RedeemForSaleInput = z.object({
  customerId: RowId,
  saleId: RowId,
  points: PositivePoints
})

/**
 * EXPIRE points — a promise released, because they aged out. Takes points AWAY, so the input is a
 * POSITIVE count of what to remove and the service writes the negative movement. A reason is optional
 * here (unlike an adjust): "they expired" is the reason, and the rule that decided it is the shop's.
 */
export const ExpirePointsInput = z.object({
  customerId: RowId,
  /** How many points to remove. Positive — the service makes the movement negative. */
  points: PositivePoints,
  reasonCode: z.string().trim().min(1).max(50).nullish()
})

/**
 * ADJUST points BY HAND — the owner's correction (goodwill given, or a mistake fixed). SIGNED: positive
 * gives points, negative takes them back. This is the one loyalty movement with no sale behind it, so it
 * REQUIRES a reason from the live lookups('adjustment_reason') list (CLAUDE.md §4 — no hardcoded
 * options) and it is audited. Owner only (`loyalty.adjust`).
 */
export const AdjustPointsInput = z.object({
  customerId: RowId,
  /** Signed whole points. Positive = give, negative = take back. Never zero. */
  points: NonZeroPoints,
  /** lookups('adjustment_reason').code — REQUIRED. An owner moving a liability by hand explains why. */
  reasonCode: z.string().trim().min(1, 'Please choose a reason.').max(50),
  reasonText: z.string().trim().max(1000).nullish()
})

/** ONE customer's points balance — derived on read: SUM(movements), and what it is worth today. */
export const LoyaltyBalanceInput = z.object({ customerId: RowId })

/** A customer's points history — paginated, filterable by date range; newest first. (CLAUDE.md §4) */
export const LoyaltyHistoryInput = z.object({
  customerId: RowId,
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(200).optional(),
  /** ISO date (YYYY-MM-DD) — inclusive lower bound. */
  from: IsoDate.optional(),
  /** ISO date — inclusive upper bound (the whole of that day is inside it). */
  to: IsoDate.optional()
})

// ── Inferred input types ─────────────────────────────────────────────────────────

export type EarnForSaleInput = z.infer<typeof EarnForSaleInput>
export type RedeemForSaleInput = z.infer<typeof RedeemForSaleInput>
export type ExpirePointsInput = z.infer<typeof ExpirePointsInput>
export type AdjustPointsInput = z.infer<typeof AdjustPointsInput>
export type LoyaltyBalanceInput = z.infer<typeof LoyaltyBalanceInput>
export type LoyaltyHistoryInput = z.infer<typeof LoyaltyHistoryInput>
