import type { z } from 'zod'
import type { DB } from '../db'
import type { User } from '@shared/types'
import { AppError, ErrorCode } from '@shared/result'
import {
  EarnForSaleInput,
  RedeemForSaleInput,
  ExpirePointsInput,
  AdjustPointsInput,
  LoyaltyBalanceInput,
  LoyaltyHistoryInput,
  type LoyaltyBalance,
  type LoyaltyMovementRow,
  type LoyaltyMovementType,
  type PagedResult
} from '@shared/loyalty'
import { SALE_REF_TYPE } from '@shared/sales'
import { RETURN_REF_TYPE } from '@shared/returns'
import { ACC } from '../db/chart-of-accounts'
import * as audit from './audit'
import * as ledger from './ledger'
import * as settings from './settings'

/**
 * THE LOYALTY SERVICE — what the shop owes its regulars, in points rather than rupees. (Migration 0017,
 * whose header is the spec; read it first.)
 *
 * ── POINTS ARE A LIABILITY, BOOKED WHEN EARNED ──────────────────────────────────────────────────────
 * A point is a promise the shop will pay later, so it hits the books the moment it is made:
 *
 *     earn     DR Loyalty Expense (5300)      CR Loyalty Liability (2200)
 *     redeem   DR Loyalty Liability (2200)    — as the sale's TENDER leg for that amount
 *     expire   DR Loyalty Liability (2200)    CR Loyalty Expense (5300)     (a promise released)
 *     adjust   whichever direction the correction runs
 *
 * Book only at redemption and every P&L until then overstates profit by the points quietly piling up.
 *
 * ── REDEMPTION IS A TENDER, NOT A DISCOUNT ──────────────────────────────────────────────────────────
 * Points PAY for goods; they do not reduce their price. Revenue and output tax are untouched, and the
 * frozen sale lines are never recomputed — a discount would understate revenue AND under-collect output
 * tax on every redemption.
 *
 * A redemption is therefore HALF an event, and `redeemForSale` POSTS NO JOURNAL: the DR to the liability
 * is the SALE's tender leg and belongs in the sale's own balanced journal, exactly as the DR to Cash
 * does. It writes the movement, freezes the value, and hands the caller the legs (`journalLines()`) to
 * merge in — see the note on redeemForSale for why a second journal here would be wrong.
 *
 * ── THE BALANCE IS DERIVED ──────────────────────────────────────────────────────────────────────────
 * SUM(loyalty_movements.points). No `customers.points` column, ever (CLAUDE.md §4, same law as stock).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * BUSINESS DECISIONS TAKEN HERE, AND WHY. Each is a rule the owner should be told about.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * 1. "SPENT" MEANS THE NET, EX-TAX VALUE THE CUSTOMER FUNDED THEMSELVES.
 *    Points are earned on `netAmount` — the sale's NET value, MINUS anything paid with points. Two
 *    deliberate subtractions:
 *      · NOT on tax. The shop never owned the output tax; it collects it for the government. Paying a
 *        reward out of it would mean buying loyalty with someone else's money — and it would make the
 *        reward rate depend on the tax rate, so a zero-rated item would earn less for the same spend.
 *      · NOT on the points-funded portion. Otherwise points breed points: spend 100 points, earn some
 *        back, spend those... a liability that compounds because of the way it is spent.
 *    The caller (sales.complete) computes this from the FROZEN sale lines and passes it in; this service
 *    never recomputes a historical line from today's tax settings.
 *
 * 2. POINTS FLOOR. 149.9 points is 149. The customer is never handed a fraction of a promise, and the
 *    shop never books a fraction of a liability. Floor, not round: rounding up would invent liability
 *    the sale did not earn.
 *
 * 3. A CHANGED REDEEM RATE NEVER REWRITES THE BOOKS — AND THE DIFFERENCE IS A NEW EXPENSE.
 *    This is the subtle one. Earn 100 points at Rs 1.00/pt and the books say the shop owes Rs 100. If
 *    the owner then sets the rate to Rs 2.00, redeeming those 100 points must hand the customer Rs 200
 *    of goods — that is the promise the shop is making TODAY, and the till must honour it.
 *
 *    But the liability only ever carried Rs 100. Settling it for Rs 200 would debit Rs 200 against a
 *    Rs 100 balance, drive ACC.LOYALTY NEGATIVE, and break the standing invariant that
 *    Σ(points × rate) === the GL liability. So a redemption's tender is settled in TWO parts:
 *
 *      · the liability is released at the rate it was BOOKED at — FIFO over the customer's own earn
 *        movements, oldest first, using each one's FROZEN value_minor. That is exactly what the shop
 *        recorded owing, to the paisa, so the liability lands on zero when the points do.
 *      · any SHORTFALL (Rs 100 here) is what the owner's rate rise costs, incurred NOW, not when the
 *        points were earned — so it is a fresh DR to Loyalty Expense in the same journal. If the rate
 *        FALLS, the surplus is a CR to Loyalty Expense: a promise the shop no longer has to keep.
 *
 *    Net effect: the customer gets today's rate, the books never go negative, the invariant holds, and
 *    the cost of changing the rate lands in the P&L of the month the owner changed it. The frozen
 *    history is untouched — no movement is ever rewritten.
 *
 * 4. AN EXPIRE HAS NO MINIMUM AND NEEDS NO REASON CODE. `minPointsToRedeem` guards SPENDING; points age
 *    out below it too, or a customer with 99 points is owed them forever. A reason is optional: "they
 *    expired" is the reason. It is still audited, because it takes money off a customer.
 *
 * 5. THIS SERVICE DOES NOT DECIDE WHEN POINTS EXPIRE. There is no expiry-period setting in the registry,
 *    so inventing one here would be inventing a business rule (CLAUDE.md §7). `expirePoints` executes an
 *    expiry someone else decided on; the rule that triggers it is a later increment, and it will be a
 *    setting when it exists.
 *
 * ── TRANSPORT-AGNOSTIC (CLAUDE.md §3) ───────────────────────────────────────────────────────────────
 * Plain args in, plain data out. No Result envelope, no `electron` import. The IPC layer zod-validates
 * again at its boundary, enforces `loyalty.adjust` (owner) / `loyalty.view` (cashier), checks the
 * read-only/expired-licence block with assertWritable, and wraps the answer. The period lock is reached
 * through ledger.post, which refuses a locked month.
 */

/** What caused these journals, stored on them so the general ledger can point back at the movement. */
const LOYALTY_REF_TYPE = 'loyalty'

// A redemption/earn points back at the SALE that caused it; a clawback at the RETURN that caused it. Both
// come from @shared — one definition, so a ref type cannot drift between the service that writes it and
// the one that reads it back.

// ═════════════════════════════════════════════════════════════════════════════
// The settings ARE the business rules — never a literal (CLAUDE.md §4)
// ═════════════════════════════════════════════════════════════════════════════

/** Is the shop giving points at all? Default FALSE — off unless the owner turns it on. */
function isEnabled(db: DB): boolean {
  return settings.get<boolean>(db, 'loyalty.enabled', false)
}

/**
 * Points earned per RUPEE (major unit) of net spend. A WHOLE number: the settings registry enforces
 * integers on every `number` setting, so a shop gives 1 or 2 points a rupee, never 0.5. Zero is legal
 * and means the scheme is on but currently gives nothing.
 */
function pointsPerCurrencyUnit(db: DB): number {
  return settings.get<number>(db, 'loyalty.pointsPerCurrencyUnit', 1)
}

/** What ONE point is worth in 2-dp minor units, RIGHT NOW. Frozen onto a movement as it is written. */
function redeemValueMinor(db: DB): number {
  return settings.get<number>(db, 'loyalty.redeemValueMinor', 100)
}

/** The floor before points can be SPENT. Guards redemption only — never expiry (decision 4). */
function minPointsToRedeem(db: DB): number {
  return settings.get<number>(db, 'loyalty.minPointsToRedeem', 100)
}

// ═════════════════════════════════════════════════════════════════════════════
// READING — the balance, derived. Never stored.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A customer's points balance: SUM(loyalty_movements.points). THE derived read, on the index built for
 * it (idx_loyalty_movements_customer). There is no `customers.points` column and there never will be —
 * a stored balance is a balance free to drift from the ledger (CLAUDE.md §4, same law as stock).
 */
export function pointsBalance(db: DB, customerId: number): number {
  assertCustomerExists(db, customerId)

  return db
    .prepare('SELECT COALESCE(SUM(points), 0) FROM loyalty_movements WHERE customer_id = ?')
    .pluck()
    .get(customerId) as number
}

/**
 * What a customer's points are worth if they spend them TODAY: balance × the CURRENT redeem rate, as
 * 2-dp integer money. This is what the till offers the customer.
 *
 * It is deliberately NOT the sum of the frozen `value_minor`s — that is what the BOOKS say the shop owes.
 * The two agree until the owner changes the rate, and decision 3 in the header explains who absorbs the
 * difference when they do.
 */
export function pointsValue(db: DB, customerId: number): number {
  return pointsBalance(db, customerId) * redeemValueMinor(db)
}

/**
 * A CUSTOMER'S POINTS, as a screen shows them: the derived balance and what it is worth TODAY. The two
 * reads above in one answer, so the till makes one call and cannot draw a balance from one instant and a
 * value from another.
 */
export function balance(db: DB, raw: unknown): LoyaltyBalance {
  const input = parseOrThrow(LoyaltyBalanceInput, raw, 'loyalty.balance')

  return {
    customerId: input.customerId,
    points: pointsBalance(db, input.customerId),
    valueMinor: pointsValue(db, input.customerId)
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// EARNING — the liability is booked HERE, at the moment of the promise
// ═════════════════════════════════════════════════════════════════════════════

/**
 * EARN points on a completed sale, in ONE transaction.
 *
 * Returns NULL, posting NOTHING anywhere, when there is nothing to book:
 *   · loyalty is switched off (`loyalty.enabled` = false — the default);
 *   · there is no NAMED customer (a walk-in cannot earn: nobody could ever claim it, and an
 *     unattributable liability is one nobody can ever settle — migration 0017);
 *   · the sale earns 0 whole points after flooring (decision 2).
 * A null is not a failure — it is the honest answer that this sale made no promise. The caller carries
 * on with the sale.
 *
 * `netAmount` is the NET, ex-tax, non-points-funded value (decision 1). The caller computes it from the
 * frozen sale lines.
 */
export function earnForSale(
  db: DB,
  actor: User,
  raw: unknown,
  now = new Date()
): LoyaltyMovementRow | null {
  const input = parseOrThrow(EarnForSaleInput, raw, 'loyalty.earn')

  // Switched off = no promise was made. Post nothing, say so.
  if (!isEnabled(db)) return null

  // A named customer only. `customerId` is required by the schema, so a walk-in reaches this service as
  // no call at all — but a customer id that does not exist is a caller bug, and a liability owed to a
  // customer who is not there is worse than an error.
  assertCustomerExists(db, input.customerId)

  const points = pointsEarnedOn(db, input.netAmount)
  if (points <= 0) return null // rounds down to nothing — not an event (0017: CHECK points <> 0)

  // The rate in force RIGHT NOW, frozen onto the movement and posted to the books. A later change to the
  // setting cannot reach back and rewrite either.
  const rate = redeemValueMinor(db)
  const valueMinor = points * rate

  const run = db.transaction((): number => {
    const movementId = insertMovement(db, {
      customerId: input.customerId,
      at: now,
      type: 'earn',
      points, // POSITIVE — the customer gained them
      valueMinor,
      refType: SALE_REF_TYPE,
      refId: input.saleId,
      reasonCode: null,
      reasonText: null,
      userId: actor.id
    })

    // A promise made is a cost incurred NOW, and money owed NOW. If the points are worth nothing (the
    // owner set the rate to zero), there is no money to move: the movement stands as the record of the
    // points, and there is no journal to post — a zero-for-zero journal is not an event, and ledger.post
    // refuses a line with no amount anyway.
    const journalId =
      valueMinor > 0
        ? ledger.post(db, {
            at: now,
            refType: LOYALTY_REF_TYPE,
            refId: movementId,
            memo: `Loyalty points earned — ${points} pt`,
            userId: actor.id,
            lines: [
              { account: ACC.LOYALTY_EXPENSE, debit: valueMinor },
              { account: ACC.LOYALTY, credit: valueMinor }
            ]
          })
        : null

    if (journalId != null) {
      db.prepare('UPDATE loyalty_movements SET journal_id = ? WHERE id = ?').run(journalId, movementId)
    }

    return movementId
  })

  return getMovement(db, run())
}

/**
 * How many WHOLE points a net spend earns. `netAmount` is 2-dp minor units; the rate is points per
 * RUPEE, so the minor units come back to majors first — in a division that is done ONCE, here.
 *
 * FLOORED (decision 2): the customer is never handed a fraction of a promise. Math.floor, not trunc:
 * `netAmount` cannot be negative (the schema refuses it), so they agree — floor is used because it says
 * what is meant. The result is clamped at 0 so a rate of 0 (or a 0 spend) is simply "no points".
 */
function pointsEarnedOn(db: DB, netAmount: number): number {
  const rate = pointsPerCurrencyUnit(db)
  if (!(rate > 0)) return 0

  // The one division in this service. Points are a COUNT, not money, so this float is safe where a
  // money one would not be: it is floored to an integer immediately and never touches a money column.
  //
  // The floor lands on the RESULT, not on the rupees. Rs 10.50 at 3 pt/rupee is 31 points, not 30 —
  // flooring the rupees first would quietly short the customer on every sale with paisa in it.
  return Math.max(0, Math.floor((netAmount / 100) * rate))
}

// ═════════════════════════════════════════════════════════════════════════════
// REDEEMING — a TENDER. The liability is settled at the rate it was BOOKED at.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A committed redemption: the movement, plus the two figures the SALE needs to post its tender leg.
 * `valueMinor` (on the movement) is what the sale tenders; the other two say how to book it.
 */
export type Redemption = LoyaltyMovementRow & {
  /**
   * 2-dp money — what the BOOKS carry for these points, at the rate they were EARNED at. The amount to
   * DR ACC.LOYALTY by: release exactly what was booked and the liability lands on zero when the points
   * do. Equals `valueMinor` unless the redeem rate has changed since (decision 3).
   */
  bookedMinor: number
  /**
   * 2-dp money, SIGNED — `valueMinor - bookedMinor`. What the owner's rate change costs (positive: the
   * rate rose, DR Loyalty Expense) or saves (negative: it fell, CR Loyalty Expense). Zero in the
   * ordinary case. Use `journalLines()` rather than reading this by hand.
   */
  rateDelta: number
}

/**
 * THE TENDER LEGS a redemption contributes to the SALE's journal — for sales.complete to merge into the
 * one balanced journal it already builds. Handing back the lines, rather than the caller re-deriving
 * them from `bookedMinor` and `rateDelta`, keeps the decision about HOW a redemption books in this
 * service, where its reasoning lives.
 *
 * They sum to `valueMinor` on the debit side — exactly the tender the sale is being paid — so a sale
 * that swaps these in for a cash leg of the same amount still balances.
 */
export function journalLines(redemption: Redemption): ledger.JournalLineInput[] {
  const lines: ledger.JournalLineInput[] = []

  // The shop settles what it owed, at the rate it owed it at.
  if (redemption.bookedMinor > 0) lines.push({ account: ACC.LOYALTY, debit: redemption.bookedMinor })

  if (redemption.rateDelta > 0) {
    // The rate ROSE: the shop hands over more than it ever booked. The extra is a cost incurred today,
    // by the decision to raise the rate — not by the sale that earned the points.
    lines.push({ account: ACC.LOYALTY_EXPENSE, debit: redemption.rateDelta })
  } else if (redemption.rateDelta < 0) {
    // The rate FELL: the shop hands over less than it booked. The surplus is a promise it no longer has
    // to keep — released back to the P&L, exactly as an expiry is.
    lines.push({ account: ACC.LOYALTY_EXPENSE, credit: -redemption.rateDelta })
  }

  return lines
}

/**
 * Link the sale's journal back onto the redemption movement. Call it inside the SALE's transaction,
 * right after posting the journal: a committed movement always carries its journal (migration 0017).
 */
export function attachJournal(db: DB, movementId: number, journalId: number): void {
  db.prepare('UPDATE loyalty_movements SET journal_id = ? WHERE id = ?').run(journalId, movementId)
}

/**
 * WHAT A REDEMPTION IS WORTH TODAY, AND EVERY REASON IT MIGHT BE REFUSED — WITHOUT WRITING ANYTHING.
 *
 * THE GATE, in one place. `redeemForSale` calls it on its way to writing the movement, and the SALE
 * calls it BEFORE it opens its transaction: a cashier who asks for more points than the customer has,
 * or fewer than the shop's minimum, must get a sentence they can act on rather than a sale that rolls
 * back after the stock has moved. Two copies of these rules would be two chances to disagree about
 * whether a redemption is allowed, so there is one.
 *
 * `points × loyalty.redeemValueMinor` — TODAY's promise, at TODAY's rate. This is what the sale tenders;
 * what the BOOKS carry for those points is a different figure after a rate change (decision 3), and it
 * is `redeemForSale` that reconciles the two.
 *
 * REFUSES, in plain language: loyalty switched off · a customer who is not there · more points than they
 * have · fewer than `loyalty.minPointsToRedeem` · points worth nothing (the rate is zero).
 */
export function valueOfRedemption(db: DB, customerId: number, points: number): number {
  if (!isEnabled(db)) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Loyalty points are switched off, so they cannot be used to pay. The owner can turn them on in Settings.',
      'loyalty.enabled is false; redemption refused'
    )
  }

  assertCustomerExists(db, customerId)

  const balance = pointsBalance(db, customerId)
  if (points > balance) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `This customer only has ${balance} point${balance === 1 ? '' : 's'}, so ${points} cannot be used.`,
      `redeem ${points} exceeds balance ${balance} for customer ${customerId}`
    )
  }

  const minimum = minPointsToRedeem(db)
  if (points < minimum) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `Points can only be used ${minimum} at a time or more. This customer has ${balance}.`,
      `redeem ${points} is below loyalty.minPointsToRedeem=${minimum}`
    )
  }

  const valueMinor = points * redeemValueMinor(db)
  if (valueMinor <= 0) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Points are currently worth nothing, so they cannot be used to pay. The owner can set what a point is worth in Settings.',
      `loyalty.redeemValueMinor is 0; redemption of ${points} pt has no value to tender`
    )
  }

  return valueMinor
}

/**
 * REDEEM points as a TENDER on a sale, in ONE transaction. Returns the movement whose `valueMinor` is
 * the frozen figure the SALE must tender — the caller uses MAIN's number, never one the renderer worked
 * out for itself.
 *
 * REFUSES, in plain language:
 *   · loyalty is switched off;
 *   · more points than the customer has;
 *   · fewer points than `loyalty.minPointsToRedeem`;
 *   · a non-positive number of points (the schema);
 *   · points worth nothing (the rate is zero) — there is no tender to post.
 *
 * Posts ONLY the DR to the liability. The sale posts the matching CR as its tender leg, exactly as it
 * does for cash — which is what keeps revenue and output tax untouched. See decision 3 for what happens
 * when the rate has moved since the points were earned: the liability is released at the FROZEN rate,
 * FIFO, and the difference is booked as expense in the same journal, so the books balance on their own.
 */
export function redeemForSale(db: DB, actor: User, raw: unknown, now = new Date()): Redemption {
  const input = parseOrThrow(RedeemForSaleInput, raw, 'loyalty.redeem')

  // Every refusal, and the value the customer is given TODAY at today's rate.
  const valueMinor = valueOfRedemption(db, input.customerId, input.points)

  // What the BOOKS say those points cost when they were promised — the frozen rate, oldest first.
  const bookedMinor = bookedValueOfOldestPoints(db, input.customerId, input.points)

  // What the owner's rate change costs (or saves), incurred NOW — see decision 3. Zero in the ordinary
  // case, where the rate has not moved since these points were earned.
  const rateDelta = valueMinor - bookedMinor

  const run = db.transaction((): number =>
    insertMovement(db, {
      customerId: input.customerId,
      at: now,
      type: 'redeem',
      points: -input.points, // NEGATIVE — the points left
      valueMinor, // magnitude, at TODAY's rate: what the sale tenders
      refType: SALE_REF_TYPE,
      refId: input.saleId,
      reasonCode: null,
      reasonText: null,
      userId: actor.id
    })
  )

  // NO JOURNAL IS POSTED HERE, and that is the design — not an omission.
  //
  // A redemption is HALF an event. The DR to the liability is the SALE's tender leg, and the CR that
  // balances it is the revenue the sale already books; ledger.post demands a balanced journal, so the
  // two must be posted TOGETHER, in the sale's own journal. That is exactly how cash works today: the
  // sale DRs Cash itself (sales.complete builds one journal from all its tenders). Posting a second
  // journal from here would need a clearing account invented to balance against — a business rule
  // nobody asked for (CLAUDE.md §7), and a second journal free to survive a rolled-back sale.
  //
  // So this returns the FROZEN figures and the caller posts them. `journalLines()` below hands
  // sales.complete the exact legs to merge into the sale's journal, and `attachJournal()` links the
  // journal back onto the movement — both inside the sale's ONE transaction, so the movement and its
  // accounting land together or not at all (0017: a committed movement always carries its journal).
  return { ...getMovement(db, run()), bookedMinor, rateDelta }
}

/**
 * What the BOOKS carry for the OLDEST `points` of a customer's points — FIFO over their own earn-side
 * movements, using each one's FROZEN value_minor (decision 3).
 *
 * Why FIFO: points are fungible, so some order must be chosen, and oldest-first is the one a customer
 * would expect and the one that empties the liability in the order it was built. The alternative — an
 * average — would give the same total once the balance reached zero but a different figure on every
 * partial redemption, and it would drift a paisa at a time through the division.
 *
 * Points already redeemed or expired are consumed off the FRONT of that queue first, so a second
 * redemption never releases the same booked paisa twice. The result is exact to the paisa: when the last
 * point goes, the liability lands on exactly zero.
 */
function bookedValueOfOldestPoints(db: DB, customerId: number, points: number): number {
  // Every movement, oldest first. Positive = points added to the queue; negative = points already taken
  // off it. `id` breaks a tie on `at` so the order is total and stable (two movements can share an
  // instant — an earn and a redeem on the same sale).
  const rows = db
    .prepare(
      `SELECT points, value_minor AS valueMinor
         FROM loyalty_movements
        WHERE customer_id = ?
        ORDER BY at ASC, id ASC`
    )
    .all(customerId) as Array<{ points: number; valueMinor: number }>

  // The queue of points still unspent, each with the per-point paisa it was BOOKED at. A layer's rate is
  // its frozen value over its own points — never today's setting.
  const layers: Array<{ points: number; valueMinor: number }> = []
  let consumed = 0 // points taken off the front by past redeems/expires, not yet applied

  for (const row of rows) {
    if (row.points > 0) {
      layers.push({ points: row.points, valueMinor: row.valueMinor })
    } else {
      consumed += -row.points
    }
  }

  // Retire what has already gone, off the FRONT (oldest first) — the same order this redemption will
  // take from. A layer is consumed proportionally by paisa so that a partially-spent layer keeps the
  // exact remainder of its own frozen value.
  let index = 0
  while (consumed > 0 && index < layers.length) {
    const layer = layers[index]!
    const take = Math.min(consumed, layer.points)
    const takeValue = valueOfPart(layer, take)

    layer.points -= take
    layer.valueMinor -= takeValue
    consumed -= take
    if (layer.points === 0) index += 1
  }

  // ...and now take THIS redemption's points off the same front.
  let remaining = points
  let booked = 0

  for (; index < layers.length && remaining > 0; index += 1) {
    const layer = layers[index]!
    if (layer.points === 0) continue

    const take = Math.min(remaining, layer.points)
    booked += valueOfPart(layer, take)
    remaining -= take
  }

  // The balance was checked before this ran, so the queue cannot run dry — unless a past earn was posted
  // with no journal because the rate was zero, in which case those points genuinely carry no booked
  // value and `booked` is correctly short. Either way, never release more than the books hold.
  return booked
}

/**
 * The frozen paisa attached to `take` points of a layer. Integer arithmetic, and the LAST point of a
 * layer takes the whole remainder — so a layer's value is split exactly, with no paisa lost or invented
 * to rounding. (Multiply before divide: the layer's value is exact, and this keeps it that way.)
 */
function valueOfPart(layer: { points: number; valueMinor: number }, take: number): number {
  if (take >= layer.points) return layer.valueMinor
  return Math.floor((layer.valueMinor * take) / layer.points)
}

// ═════════════════════════════════════════════════════════════════════════════
// REVERSING A SALE — the points go back exactly as the stock does
// ═════════════════════════════════════════════════════════════════════════════

/**
 * UNDO EVERY POINT THIS SALE MOVED — for `sales.voidSale`, from INSIDE its transaction.
 *
 * A voided sale never happened, so its points must not survive it. Miss this and the two halves both
 * bite: the customer KEEPS the points a cancelled sale earned (mint points by ringing up a sale and
 * voiding it), and the points a cancelled sale SPENT are gone forever (the customer is simply robbed).
 * The balance is SUM(points), so the only way to move it back is another movement — this is the
 * derived-state-from-every-path rule (CLAUDE.md §4 / trap #17).
 *
 * IT MIRRORS THE MOVEMENTS, exactly as the stock clawback mirrors the stock movements: every movement
 * this sale wrote comes back with its sign flipped and ITS OWN FROZEN value_minor reused — never
 * today's rate. Reversing an earn at a rate the owner has since raised would credit back more than was
 * ever booked and drive the liability off zero; reusing the frozen figure lands it exactly where it
 * started. The originals are NEVER touched: the points ledger is append-only, like the stock ledger and
 * the audit log — a mistake is corrected by RECORDING the correction, not by erasing the evidence.
 *
 * ── WHICH HALF POSTS A JOURNAL, AND WHY ONLY ONE OF THEM DOES ───────────────────────────────────────
 * This is the subtle part, and getting it wrong reverses the accounting either twice or not at all. The
 * two movements a sale can write DO NOT LIVE IN THE SAME JOURNAL:
 *
 *   REDEEM  its DR to the liability is a leg of the SALE's OWN journal (that is what "a tender, not a
 *           discount" means). `voidSale` contra-posts the sale's entire journal by mirroring its lines,
 *           so that leg is ALREADY reversed by the time this runs. Posting it again here would credit
 *           the liability twice — and the trial balance would still balance while the shop's books said
 *           it owed points it had handed back.
 *
 *   EARN    posts a journal OF ITS OWN (ref_type 'loyalty'), because a promise made is a separate event
 *           from the sale that triggered it. The sale's contra NEVER SEES IT — it only mirrors journals
 *           with ref_type 'sale'. So this function must reverse it, or a voided sale leaves its
 *           liability standing on the books forever with no points behind it.
 *
 * So: the earn's journal is reversed HERE, by mirroring the journal that movement actually posted (the
 * same technique voidSale uses — reverse what was POSTED, not what today's code would post). The
 * redemption's is left alone. A test asserts both halves land the liability back on exactly zero.
 *
 * The reversal is typed 'adjust' — the one type the schema has for "a correction" (0017's CHECK), and
 * an honest description: this IS the shop correcting a customer's balance. Returns how many movements
 * were written, so the caller can say nothing happened when nothing did.
 */
export function reverseForSale(db: DB, actor: User, saleId: number, now = new Date()): number {
  // Only the movements the sale ITSELF wrote — an earn and/or a redeem. A reversal written by a
  // previous void carries the same ref, but voidSale refuses an already-voided sale, so it can never
  // be reached twice.
  const movements = db
    .prepare(
      `SELECT customer_id, type, points, value_minor, journal_id
         FROM loyalty_movements
        WHERE ref_type = ? AND ref_id = ? AND type IN ('earn', 'redeem')
        ORDER BY id`
    )
    .all(SALE_REF_TYPE, saleId) as Array<{
    customer_id: number
    type: LoyaltyMovementType
    points: number
    value_minor: number
    journal_id: number | null
  }>

  for (const movement of movements) {
    const movementId = insertMovement(db, {
      customerId: movement.customer_id,
      at: now,
      type: 'adjust',
      points: -movement.points, // the mirror image: what was earned goes back, what was spent returns
      valueMinor: movement.value_minor, // AT THE VALUE IT MOVED AT — magnitude; the sign is on points
      refType: SALE_REF_TYPE,
      refId: saleId,
      // No reason CODE: the owner's `adjustment_reason` list is theirs, and this is not their
      // correction to explain — the sale was cancelled, and that is the whole reason. `adjustPoints`
      // demands a code precisely because a HAND adjustment has no document behind it; this one does.
      reasonCode: null,
      reasonText: 'Sale cancelled',
      userId: actor.id
    })

    // ONLY the earn's own journal is reversed here — see the note above. A redeem's legs belong to the
    // sale's journal, which voidSale has already contra-posted.
    if (movement.type !== 'earn' || movement.journal_id == null) continue

    const journalId = reverseJournal(
      db,
      movement.journal_id,
      {
        at: now,
        refType: LOYALTY_REF_TYPE,
        refId: movementId,
        memo: `Loyalty points reversed — sale cancelled`,
        userId: actor.id
      }
    )

    db.prepare('UPDATE loyalty_movements SET journal_id = ? WHERE id = ?').run(journalId, movementId)
  }

  return movements.length
}

/**
 * CLAW BACK THE POINTS FOR GOODS THE CUSTOMER GAVE BACK — the PARTIAL cousin of `reverseForSale`.
 *
 * A void cancels a whole sale; a RETURN unwinds part of one (or all of it, one line at a time). Without
 * this, a customer buys Rs 1000 of goods, earns 1000 points, returns the lot for a full refund and KEEPS
 * the points: free money, repeatable for as long as they like. The trial balance stays green throughout,
 * because the liability really is owed — it just should never have been booked. That is the
 * derived-state-from-every-path rule (CLAUDE.md trap #17): the earn was correct when the sale happened,
 * and it is this path's job to keep it correct afterwards.
 *
 * PROPORTIONAL, AND MEASURED IN POINTS, NOT RUPEES. `returnedNet` is the ex-tax value going back, the same
 * basis the points were earned on (tax is the government's, never the customer's reward — see
 * `earnForSale`). The share is taken of the POINTS the sale actually earned, so it cannot be knocked out
 * of step by a rate change between the sale and the return, and returning every line claws back exactly
 * what was earned — no more, and no paisa stranded.
 *
 * REMAINDER-ON-LAST, by cumulative differencing over what has ALREADY been clawed back (the shape
 * `returns.ts` and `purchase-returns.ts` both use): rounding each return on its own lets the parts drift
 * from the whole, and a sale returned in three goes would leave a point or two alive forever. The final
 * return — the one that takes the sale to fully returned — takes the exact remainder.
 *
 * The clawback is capped at what remains: a customer who has already SPENT the points is not driven
 * negative here (their balance is real money they were given; taking it back by force is a business
 * decision the owner makes by hand, with a reason, through `adjustPoints`). Returns how many points went
 * back, so the caller can say nothing happened when nothing did.
 *
 * MUST be called INSIDE the return's own transaction, so a sale, its return and its points are one act.
 */
export function clawbackForReturn(
  db: DB,
  actor: User,
  input: { saleId: number; returnId: number; returnedNet: number; saleNet: number },
  now = new Date()
): number {
  // What this sale earned, and what has already been taken back by earlier returns of it. Read from the
  // table, never recomputed: if loyalty was off at the time, or the buyer was a walk-in, there is no earn
  // and there is nothing to claw back.
  const earned = db
    .prepare(
      `SELECT COALESCE(SUM(points), 0) FROM loyalty_movements
        WHERE ref_type = ? AND ref_id = ? AND type = 'earn'`
    )
    .pluck()
    .get(SALE_REF_TYPE, input.saleId) as number
  if (earned <= 0 || input.saleNet <= 0) return 0

  const alreadyClawed = db
    .prepare(
      `SELECT COALESCE(SUM(-points), 0) FROM loyalty_movements
        WHERE ref_type = ? AND ref_id = ? AND type = 'adjust' AND points < 0`
    )
    .pluck()
    .get(RETURN_REF_TYPE, input.returnId) as number

  const returnedSoFar = returnedNetSoFar(db, input.saleId) // includes THIS return — its lines are written
  const cumulative =
    returnedSoFar >= input.saleNet
      ? earned // fully returned: take back exactly what was earned, whatever the rounding did on the way
      : Math.floor((earned * returnedSoFar) / input.saleNet)

  const priorClawed = db
    .prepare(
      `SELECT COALESCE(SUM(-lm.points), 0)
         FROM loyalty_movements lm
         JOIN returns r ON r.id = lm.ref_id
        WHERE lm.ref_type = ? AND r.sale_id = ? AND lm.type = 'adjust' AND lm.points < 0`
    )
    .pluck()
    .get(RETURN_REF_TYPE, input.saleId) as number

  const due = cumulative - (priorClawed - alreadyClawed)
  if (due <= 0) return 0

  const customerId = db
    .prepare('SELECT customer_id FROM loyalty_movements WHERE ref_type = ? AND ref_id = ? AND type = ?')
    .pluck()
    .get(SALE_REF_TYPE, input.saleId, 'earn') as number

  // Never drive the balance negative: points already spent are gone, and taking them back by force is the
  // owner's call to make by hand, not this path's.
  const points = Math.min(due, pointsBalance(db, customerId))
  if (points <= 0) return 0

  // Released at the rate they were BOOKED at, FIFO — the same discipline every other release uses, so the
  // liability lands back exactly where the earn put it rather than at a rate the owner has since changed.
  const bookedMinor = bookedValueOfOldestPoints(db, customerId, points)

  const movementId = insertMovement(db, {
    customerId,
    at: now,
    type: 'adjust',
    points: -points,
    valueMinor: bookedMinor,
    refType: RETURN_REF_TYPE,
    refId: input.returnId,
    // No reason CODE, for the same reason the void clawback carries none: the owner's `adjustment_reason`
    // list is for THEIR corrections. This one has a document behind it — the return.
    reasonCode: null,
    reasonText: 'Goods returned',
    userId: actor.id
  })

  if (bookedMinor > 0) {
    const journalId = ledger.post(db, {
      at: now,
      refType: LOYALTY_REF_TYPE,
      refId: movementId,
      memo: 'Loyalty points clawed back — goods returned',
      userId: actor.id,
      lines: [
        // The promise is released: the liability falls, and the expense it was booked as comes back.
        { account: ACC.LOYALTY, debit: bookedMinor },
        { account: ACC.LOYALTY_EXPENSE, credit: bookedMinor }
      ]
    })
    db.prepare('UPDATE loyalty_movements SET journal_id = ? WHERE id = ?').run(journalId, movementId)
  }

  return points
}

/** Σ net returned against a sale, INCLUDING the return being written — its lines are already in. */
function returnedNetSoFar(db: DB, saleId: number): number {
  return db
    .prepare('SELECT COALESCE(SUM(subtotal_net), 0) FROM returns WHERE sale_id = ?')
    .pluck()
    .get(saleId) as number
}

/**
 * CONTRA A JOURNAL BY MIRRORING WHAT IT ACTUALLY POSTED — every debit a credit, every credit a debit.
 * It balances because the original did, and it reverses what the books REALLY say rather than what
 * today's code would say they should. The original is never touched: this ledger is append-only, and a
 * mistake is corrected by RECORDING the correction. (The same technique, and the same reasoning, as
 * sales.voidSale's contra.)
 */
function reverseJournal(
  db: DB,
  journalId: number,
  entry: { at: Date; refType: string; refId: number; memo: string; userId: number }
): number {
  const lines = db
    .prepare(
      `SELECT l.debit AS debit, l.credit AS credit, a.code AS code
         FROM journal_lines l
         JOIN accounts a ON a.id = l.account_id
        WHERE l.journal_id = ?
        ORDER BY l.id`
    )
    .all(journalId) as Array<{ debit: number; credit: number; code: string }>

  return ledger.post(db, {
    ...entry,
    lines: lines.map((line) =>
      line.debit > 0
        ? { account: line.code, credit: line.debit }
        : { account: line.code, debit: line.credit }
    )
  })
}

// ═════════════════════════════════════════════════════════════════════════════
// EXPIRING and ADJUSTING — the two paths with no sale behind them. Both audited.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * EXPIRE points — a promise released because they aged out. In ONE transaction, and AUDITED: this takes
 * money off a customer, so who did it and when is evidence (CLAUDE.md §4).
 *
 *     DR Loyalty Liability     CR Loyalty Expense
 *
 * The liability is released at the rate it was BOOKED at (decision 3), so it lands on zero exactly when
 * the points do, and the credit back to the P&L is precisely what was charged to it.
 *
 * No minimum applies (decision 4). This service does not decide WHEN points expire (decision 5) — it
 * executes an expiry someone else decided on.
 */
export function expirePoints(db: DB, actor: User, raw: unknown, now = new Date()): LoyaltyMovementRow {
  const input = parseOrThrow(ExpirePointsInput, raw, 'loyalty.expire')

  assertCustomerExists(db, input.customerId)

  const balance = pointsBalance(db, input.customerId)
  if (input.points > balance) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `This customer only has ${balance} point${balance === 1 ? '' : 's'}, so ${input.points} cannot be expired.`,
      `expire ${input.points} exceeds balance ${balance} for customer ${input.customerId}`
    )
  }

  // Release exactly what the books hold for these points — not today's rate. Expiring at today's rate
  // after a rate change would take the liability negative, or leave it stranded above zero.
  const bookedMinor = bookedValueOfOldestPoints(db, input.customerId, input.points)

  const run = db.transaction((): number => {
    const movementId = insertMovement(db, {
      customerId: input.customerId,
      at: now,
      type: 'expire',
      points: -input.points, // NEGATIVE — the points left
      valueMinor: bookedMinor, // frozen: what the shop is no longer on the hook for
      refType: null, // an expiry is not raised BY a document; it IS the event
      refId: null,
      reasonCode: input.reasonCode ?? null,
      reasonText: null,
      userId: actor.id
    })

    // Nothing to release if those points were booked at a zero rate — the movement still records that
    // the points went.
    const journalId =
      bookedMinor > 0
        ? ledger.post(db, {
            at: now,
            refType: LOYALTY_REF_TYPE,
            refId: movementId,
            memo: `Loyalty points expired — ${input.points} pt`,
            userId: actor.id,
            lines: [
              { account: ACC.LOYALTY, debit: bookedMinor },
              { account: ACC.LOYALTY_EXPENSE, credit: bookedMinor }
            ]
          })
        : null

    if (journalId != null) {
      db.prepare('UPDATE loyalty_movements SET journal_id = ? WHERE id = ?').run(journalId, movementId)
    }

    // Points taken off a customer, by whom, and when (CLAUDE.md §4).
    audit.record(
      db,
      actor,
      {
        action: 'loyalty.expire',
        entity: 'customer',
        entityId: input.customerId,
        reasonCode: input.reasonCode ?? undefined,
        after: { points: -input.points, valueMinor: bookedMinor, balanceAfter: balance - input.points }
      },
      now
    )

    return movementId
  })

  return getMovement(db, run())
}

/**
 * ADJUST points BY HAND — the owner's correction. SIGNED: positive gives points (goodwill), negative
 * takes them back (fixing a mistake). ONE transaction, always AUDITED, and it REQUIRES a reason from the
 * LIVE lookups('adjustment_reason') list (CLAUDE.md §4 — no hardcoded options).
 *
 *     giving  DR Loyalty Expense    CR Loyalty Liability      (a new promise, valued at TODAY's rate)
 *     taking  DR Loyalty Liability  CR Loyalty Expense        (released at the rate it was BOOKED at)
 *
 * The asymmetry is deliberate and it is decision 3 again: points GIVEN never existed before, so today's
 * rate is the only rate they can have. Points TAKEN BACK were booked at some past rate, and the books
 * must release exactly what they hold — anything else drives the liability off zero.
 *
 * Owner only (`loyalty.adjust`) — enforced in MAIN by the IPC layer, because moving a liability by hand
 * is the owner's call and the UI is not a security boundary.
 */
export function adjustPoints(db: DB, actor: User, raw: unknown, now = new Date()): LoyaltyMovementRow {
  const input = parseOrThrow(AdjustPointsInput, raw, 'loyalty.adjust')

  assertCustomerExists(db, input.customerId)

  // A REAL, CURRENT entry on the owner's own list. This also refuses a retired reason and a wrong-list
  // one — an owner moving a liability by hand without a reason is exactly what the audit log prevents.
  const reason = requireLookup(
    db,
    'adjustment_reason',
    input.reasonCode,
    'Please choose a reason for changing these points.'
  )

  const balance = pointsBalance(db, input.customerId)
  const taking = input.points < 0

  if (taking && -input.points > balance) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `This customer only has ${balance} point${balance === 1 ? '' : 's'}, so ${-input.points} cannot be taken away.`,
      `adjust ${input.points} would take balance ${balance} negative for customer ${input.customerId}`
    )
  }

  // Giving: a new promise, at TODAY's rate. Taking: release exactly what the books hold (decision 3).
  const valueMinor = taking
    ? bookedValueOfOldestPoints(db, input.customerId, -input.points)
    : input.points * redeemValueMinor(db)

  const run = db.transaction((): number => {
    const movementId = insertMovement(db, {
      customerId: input.customerId,
      at: now,
      type: 'adjust',
      points: input.points, // SIGNED — as the owner meant it
      valueMinor, // magnitude; the sign lives on the points
      refType: null, // an adjustment is not raised BY a document; it IS the event
      refId: null,
      reasonCode: reason.code,
      reasonText: input.reasonText ?? null,
      userId: actor.id
    })

    const journalId =
      valueMinor > 0
        ? ledger.post(db, {
            at: now,
            refType: LOYALTY_REF_TYPE,
            refId: movementId,
            memo: `Loyalty points adjusted — ${input.points > 0 ? '+' : ''}${input.points} pt (${reason.label})`,
            userId: actor.id,
            lines: taking
              ? [
                  { account: ACC.LOYALTY, debit: valueMinor },
                  { account: ACC.LOYALTY_EXPENSE, credit: valueMinor }
                ]
              : [
                  { account: ACC.LOYALTY_EXPENSE, debit: valueMinor },
                  { account: ACC.LOYALTY, credit: valueMinor }
                ]
          })
        : null

    if (journalId != null) {
      db.prepare('UPDATE loyalty_movements SET journal_id = ? WHERE id = ?').run(journalId, movementId)
    }

    // WHO moved WHAT, and why (CLAUDE.md §4). The code, so the audit reads without a join.
    audit.record(
      db,
      actor,
      {
        action: 'loyalty.adjust',
        entity: 'customer',
        entityId: input.customerId,
        reasonCode: reason.code,
        reasonText: input.reasonText ?? undefined,
        before: { points: balance },
        after: { points: input.points, valueMinor, balanceAfter: balance + input.points }
      },
      now
    )

    return movementId
  })

  return getMovement(db, run())
}

// ═════════════════════════════════════════════════════════════════════════════
// READING — the history
// ═════════════════════════════════════════════════════════════════════════════

/**
 * ONE CUSTOMER'S POINTS HISTORY — paginated and indexed, newest first (assume years of rows,
 * CLAUDE.md §4). Filterable by date range. This is the statement that explains a balance: every promise
 * made, spent, expired or corrected, with who did it and why.
 */
export function history(db: DB, raw: unknown): PagedResult<LoyaltyMovementRow> {
  const input = parseOrThrow(LoyaltyHistoryInput, raw, 'loyalty.history')

  assertCustomerExists(db, input.customerId)

  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 50))

  const where: string[] = ['m.customer_id = @customerId']
  const params: Record<string, unknown> = { customerId: input.customerId }

  if (input.from) {
    where.push('m.at >= @from')
    params['from'] = input.from
  }
  if (input.to) {
    // `to` is a DATE, and the WHOLE of that day is inside it — points earned at 18:40 must not fall out
    // of a statement that says it covers that day. (The sales/reports date convention, CLAUDE.md §4.)
    where.push('m.at < @toExclusive')
    params['toExclusive'] = dayAfter(input.to)
  }

  const whereSql = `WHERE ${where.join(' AND ')}`

  const total = db
    .prepare(`SELECT COUNT(*) FROM loyalty_movements m ${whereSql}`)
    .pluck()
    .get(params) as number

  const rows = db
    .prepare(
      `SELECT m.id, m.customer_id, m.at, m.type, m.points, m.value_minor, m.ref_type, m.ref_id,
              m.reason_code, m.reason_text, m.user_id, m.journal_id, m.created_at,
              u.full_name AS user_name,
              r.label     AS reason_label
         FROM loyalty_movements m
         LEFT JOIN users   u ON u.id = m.user_id
         LEFT JOIN lookups r ON r.list_key = 'adjustment_reason' AND r.code = m.reason_code
         ${whereSql}
        ORDER BY m.at DESC, m.id DESC
        LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as LoyaltyJoinRow[]

  return { total, page, pageSize, rows: rows.map(hydrate) }
}

// ═════════════════════════════════════════════════════════════════════════════
// Row → domain
// ═════════════════════════════════════════════════════════════════════════════

type LoyaltyJoinRow = {
  id: number
  customer_id: number
  at: string
  type: LoyaltyMovementType
  points: number
  value_minor: number
  ref_type: string | null
  ref_id: number | null
  reason_code: string | null
  reason_text: string | null
  user_id: number
  journal_id: number | null
  created_at: string
  user_name?: string | null
  reason_label?: string | null
}

function hydrate(row: LoyaltyJoinRow): LoyaltyMovementRow {
  return {
    id: row.id,
    customerId: row.customer_id,
    at: row.at,
    type: row.type,
    points: row.points,
    valueMinor: row.value_minor,
    refType: row.ref_type,
    refId: row.ref_id,
    reasonCode: row.reason_code,
    reasonText: row.reason_text,
    userId: row.user_id,
    journalId: row.journal_id,
    createdAt: row.created_at,
    userName: row.user_name ?? null,
    reasonLabel: row.reason_label ?? null
  }
}

/** One movement, read back after it is written — so a caller always gets what the DB actually holds. */
function getMovement(db: DB, id: number): LoyaltyMovementRow {
  const row = db
    .prepare(
      `SELECT m.id, m.customer_id, m.at, m.type, m.points, m.value_minor, m.ref_type, m.ref_id,
              m.reason_code, m.reason_text, m.user_id, m.journal_id, m.created_at,
              u.full_name AS user_name,
              r.label     AS reason_label
         FROM loyalty_movements m
         LEFT JOIN users   u ON u.id = m.user_id
         LEFT JOIN lookups r ON r.list_key = 'adjustment_reason' AND r.code = m.reason_code
        WHERE m.id = ?`
    )
    .get(id) as LoyaltyJoinRow | undefined

  if (!row) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'Those points could not be found.',
      `loyalty movement id=${id} does not exist`
    )
  }
  return hydrate(row)
}

// ═════════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════════

type InsertMovement = {
  customerId: number
  at: Date
  type: LoyaltyMovementType
  points: number
  valueMinor: number
  refType: string | null
  refId: number | null
  reasonCode: string | null
  reasonText: string | null
  userId: number
}

/**
 * Write the movement. `journal_id` is NULL for the instant between the row landing and the journal being
 * attached — both happen inside ONE transaction, so a committed movement always carries its journal
 * (migration 0017).
 */
function insertMovement(db: DB, input: InsertMovement): number {
  return Number(
    db
      .prepare(
        `INSERT INTO loyalty_movements
           (customer_id, at, type, points, value_minor, ref_type, ref_id,
            reason_code, reason_text, user_id, journal_id, created_at)
         VALUES
           (@customerId, @at, @type, @points, @valueMinor, @refType, @refId,
            @reasonCode, @reasonText, @userId, NULL, @createdAt)`
      )
      .run({
        customerId: input.customerId,
        at: input.at.toISOString(),
        type: input.type,
        points: input.points,
        valueMinor: input.valueMinor,
        refType: input.refType,
        refId: input.refId,
        reasonCode: input.reasonCode,
        reasonText: input.reasonText,
        userId: input.userId,
        createdAt: new Date().toISOString()
      }).lastInsertRowid
  )
}

/**
 * Points belong to a NAMED customer (migration 0017). A balance owed to a customer who does not exist is
 * a liability nobody can ever settle.
 */
function assertCustomerExists(db: DB, id: number): void {
  const exists = db.prepare('SELECT 1 FROM customers WHERE id = ?').pluck().get(id)
  if (exists == null) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That customer could not be found. They may have been removed.',
      `customer id=${id} does not exist`
    )
  }
}

/**
 * A real, CURRENT entry on one of the owner's own lists — never a hardcoded option (CLAUDE.md §4). The
 * `list_key` filter refuses a wrong-list code, and `is_active = 1` refuses a retired one.
 */
function requireLookup(
  db: DB,
  listKey: string,
  code: string,
  userMessage: string
): { id: number; code: string; label: string } {
  const row = db
    .prepare('SELECT id, code, label FROM lookups WHERE list_key = ? AND code = ? AND is_active = 1')
    .get(listKey, code) as { id: number; code: string; label: string } | undefined

  if (!row) {
    throw new AppError(
      ErrorCode.VALIDATION,
      userMessage,
      `unknown or inactive ${listKey} lookup code="${code}"`
    )
  }
  return row
}

/** The day AFTER an ISO date — an exclusive upper bound so a whole day is included in a range. */
function dayAfter(isoDate: string): string {
  const date = new Date(`${isoDate.slice(0, 10)}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
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
