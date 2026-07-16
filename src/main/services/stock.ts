import type { DB } from '../db'
import type { User } from '@shared/types'
import { AppError, ErrorCode } from '@shared/result'
import { ACC } from '../db/chart-of-accounts'
import { costToPriceMinor } from '@shared/cost'
import { QTY_SCALE } from '@shared/qty'
import { REGISTRY_DEFAULTS } from '@shared/settings-registry'
import * as ledger from './ledger'
import * as audit from './audit'
import * as settings from './settings'
import type { z } from 'zod'
import {
  AdjustStockInput,
  type PagedResult,
  type StockLevel,
  type StockMovement,
  type StockMovementListInput,
  type StockMovementType
} from '@shared/catalog'

/**
 * Validate at the SERVICE boundary, not only at the IPC one.
 *
 * The services layer is the real boundary (CLAUDE.md §3) — vitest calls it directly today and a LAN
 * server will call it tomorrow. The zod messages are already written in language a cashier reads.
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

  return parsed.data
}

/**
 * STOCK — the single source of truth for what the shop has, and what it cost.
 *
 * TWO RULES HOLD UP THIS ENTIRE FILE. Everything else is detail.
 *
 * 1. STOCK IS DERIVED. On-hand is SUM(stock_movements.qty_m). There is no stock column, there is no
 *    "recalculate stock" button, and there is no code path anywhere in this app that writes a stock
 *    figure. To change stock you APPEND a movement — signed, with a cost, a reason and a name against
 *    it — and the balance re-sums itself. Movements are never updated and never deleted: the ledger of
 *    stock is append-only, exactly like the ledger of money. (CLAUDE.md §4)
 *
 * 2. COST IS A WEIGHTED AVERAGE, and it moves ONLY when stock comes IN.
 *
 *        newAvg = (existingQty x existingAvg + incomingQty x incomingCost) / (existingQty + incomingQty)
 *
 *    Buy 10 @ Rs 100, then 10 @ Rs 120 -> the average is Rs 110. Sell 5 -> the average is STILL Rs 110.
 *    A sale takes stock out at the average; it does not change what the rest of the shelf cost. Get
 *    this backwards and every profit report the shop ever runs is wrong.
 *
 * THREE INTEGER SCALES MEET IN THIS FILE AND THEY ARE NOT INTERCHANGEABLE:
 *
 *      qty_m   thousandths     1 piece = 1000, 1.234 kg = 1234        shared/qty.ts
 *      cost    ten-thousandths Rs 91.0417     =    910_417            shared/cost.ts   (4 dp)
 *      money   minor units     Rs 91.04       =      9_104            shared/money.ts  (2 dp)
 *
 * A quantity times a cost is neither of those things until it is divided back down. That conversion
 * lives in exactly one place here — `movementValueCost()` — and the journal is the only thing that
 * ever crosses from cost scale into money scale, through `costToPriceMinor()`.
 *
 * WHAT THIS SERVICE DOES NOT DO: it does not post the journal for a sale or a purchase. Those
 * documents own their own accounting (COGS, payables, tax) and call `record()` for the stock leg only.
 * The one journal posted from here is the STOCK ADJUSTMENT — because an adjustment is not a document,
 * it IS the whole business event.
 */

// ── Row shapes ───────────────────────────────────────────────────────────────

type MovementRow = {
  id: number
  at: string
  type: StockMovementType
  product_id: number
  batch_id: number | null
  qty_m: number
  unit_cost: number
  ref_type: string | null
  ref_id: string | null
  reason_code: string | null
  note: string | null
  user_id: number | null
  user_name?: string | null
}

type ProductRow = {
  id: number
  name: string
  item_type: string
  cost_price: number
  min_stock_m: number
}

function toMovement(row: MovementRow): StockMovement {
  const movement: StockMovement = {
    id: row.id,
    at: row.at,
    type: row.type,
    productId: row.product_id,
    batchId: row.batch_id,
    qtyM: row.qty_m,
    unitCost: row.unit_cost,
    refType: row.ref_type,
    refId: row.ref_id,
    reasonCode: row.reason_code,
    note: row.note,
    userId: row.user_id
  }
  if (row.user_name != null) movement.userName = row.user_name
  return movement
}

function loadProduct(db: DB, productId: number): ProductRow {
  const row = db
    .prepare('SELECT id, name, item_type, cost_price, min_stock_m FROM products WHERE id = ?')
    .get(productId) as ProductRow | undefined

  if (!row) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That item could not be found. It may have been removed.',
      `product id=${productId} does not exist`
    )
  }
  return row
}

/**
 * A non-inventory item (a service, a bag charge) sells and earns, but it has no stock and never
 * appears on a stock report. A stock movement against one is a bug in the caller, not a decision the
 * user made — so it fails loudly here rather than quietly accumulating a balance nobody will ever see.
 */
function assertStocked(product: ProductRow): void {
  if (product.item_type !== 'inventory') {
    throw new AppError(
      ErrorCode.VALIDATION,
      `"${product.name}" is not a stocked item, so its quantity cannot be changed.`,
      `stock movement attempted on item_type=${product.item_type} product ${product.id}`
    )
  }
}

// ── Integer arithmetic (the part that must never drift) ──────────────────────

/**
 * The value of a movement, in COST units (4 dp).
 *
 *      qty_m (thousandths) x cost (ten-thousandths) / 1000  =  cost units
 *
 * BigInt for the multiply. 10,000 units of a Rs 100,000 item overflows a JS float's exact-integer
 * range, and past that point two different totals silently compare equal — the one failure mode
 * integer money exists to prevent. The result is asserted back into safe-integer range.
 *
 * Rounds half-up to the nearest 1/10000. `qtyM` may be signed; the value returned is the MAGNITUDE,
 * because a journal never carries a negative amount — you credit the other side instead.
 */
export function movementValueCost(qtyM: number, unitCost: number): number {
  if (!Number.isSafeInteger(qtyM) || !Number.isSafeInteger(unitCost)) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Something went wrong with that quantity. Please try again.',
      `movementValueCost got non-integer input: qtyM=${qtyM} unitCost=${unitCost}`
    )
  }

  const scale = BigInt(QTY_SCALE)
  const raw = BigInt(Math.abs(qtyM)) * BigInt(Math.abs(unitCost))
  const value = (raw * 2n + scale) / (scale * 2n) // floor(raw/scale + 1/2) — round half up

  const result = Number(value)
  if (!Number.isSafeInteger(result)) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'That quantity is too large to record. Please split it into smaller entries.',
      `movement value ${value} exceeds safe integer range (qtyM=${qtyM} unitCost=${unitCost})`
    )
  }
  return result
}

/**
 * THE MONEY A MOVEMENT MOVED — SIGNED, in minor units (2 dp). Rounded ONCE, here, and nowhere else.
 *
 * This is THE number. The journal posts it. The stock report sums it. They are therefore equal by
 * construction, and no future phase can reintroduce the drift by rounding differently.
 *
 * WHY IT EXISTS: the ledger used to round once PER MOVEMENT while the stock report rounded once on
 * the TOTAL (on_hand x average). Sum-of-rounded != round-of-sum, so two batches of 3 pcs at
 * Rs 91.0417 gave a GL of Rs 546.26 against a stock report of Rs 546.25 — a paisa of inventory that
 * existed in the books and nowhere on the shelf, with every journal internally balanced and the
 * trial balance still green. Exactly the failure CLAUDE.md warns about by name.
 */
export function movementValueMinor(qtyM: number, unitCost: number): number {
  const magnitude = costToPriceMinor(movementValueCost(qtyM, unitCost))
  return qtyM < 0 ? -magnitude : magnitude
}

/**
 * THE WEIGHTED AVERAGE. All integer, all at 4-dp cost scale.
 *
 *      newAvg = (existingQty x existingAvg + incomingQty x incomingCost) / (existingQty + incomingQty)
 *
 * The qty_m scale cancels out of the top and bottom, so quantities go in as qty_m and the answer
 * comes out as a cost. Nothing is ever a float.
 *
 * THE EDGE CASES, and they are decisions rather than accidents:
 *
 *   incomingQty <= 0  — a DECREASE. The average does not move. Selling something does not change
 *                       what the rest of the shelf cost.
 *
 *   existingQty < 0   — the shop is OVERSOLD (it sold stock it did not have on the books yet).
 *                       We BLEND THROUGH THE NEGATIVE. This used to reset the average to the
 *                       incoming cost, and that quietly destroyed money:
 *
 *                         open 10 @ Rs 100  -> GL Inventory Rs 1,000, stock value Rs 1,000  ✓
 *                         damage -15        -> on hand -5, GL -Rs 500,  stock value -Rs 500  ✓
 *                         restock 20 @ Rs 200 -> average RESET to Rs 200
 *                                              -> stock value 15 x 200 = Rs 3,000
 *                                              -> but GL Inventory says Rs 3,500
 *
 *                       Rs 500 of inventory value orphaned, with no journal to explain it — and the
 *                       trial balance still balanced, so nothing caught it. Blending through gives
 *                       (-5,000 x 1,000,000 + 20,000 x 2,000,000) / 15,000 = Rs 233.3333, and
 *                       15 x Rs 233.3333 = Rs 3,500.00, which is exactly what the ledger says.
 *                       The negative stock was RELIEVED at the cost the books were carrying it at.
 *
 *   existingQty === 0 — nothing on the shelf, nothing to blend. Falls out of the maths on its own:
 *                       (0 + incomingQty x incomingCost) / incomingQty === incomingCost.
 */
export function weightedAverage(
  existingQtyM: number,
  existingAvgCost: number,
  incomingQtyM: number,
  incomingCost: number
): number {
  // A decrease never moves the average. Selling does not change what the rest of the shelf cost.
  if (incomingQtyM <= 0) return existingAvgCost

  const totalQtyM = existingQtyM + incomingQtyM

  // Still oversold even after the delivery (or exactly cancelled): there is no positive stock to
  // carry an average, and dividing by <= 0 is meaningless. The new stock costs what it cost.
  if (totalQtyM <= 0) return incomingCost

  const numerator =
    BigInt(existingQtyM) * BigInt(existingAvgCost) + BigInt(incomingQtyM) * BigInt(incomingCost)
  const denominator = BigInt(totalQtyM)

  const average = (numerator * 2n + denominator) / (denominator * 2n) // round half up

  // A negative average cost is not a thing. It can only arise from a deeply negative carried value
  // being swamped by a tiny delivery — nonsense in, nonsense out. Refuse to store the nonsense.
  if (average < 0n) return incomingCost

  const result = Number(average)
  if (!Number.isSafeInteger(result)) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'That cost is too large to record. Please check the figures.',
      `weighted average ${average} exceeds safe integer range`
    )
  }
  return result
}

/**
 * REBUILD every movement's stored money value from its own quantity and cost.
 *
 * `value_minor` is a CACHE — the movement's value, frozen when it happened, so that the ledger and
 * the stock report read the same number instead of each rounding their own way (migration 0006).
 * CLAUDE.md permits a cache on exactly one condition: it must be REBUILDABLE from the source of
 * truth, and a test must assert the two agree. This is the rebuild. `assertMovementValuesAreHonest`
 * in the tests is the assertion.
 *
 * Available to a maintenance screen, and used by the migration. If a movement ever appears with a
 * value of 0 that should not be 0 — a bad restore, a hand-edited database — this repairs it.
 */
export function recomputeMovementValues(db: DB): number {
  const rows = db
    .prepare('SELECT id, qty_m, unit_cost, value_minor FROM stock_movements')
    .all() as Array<{ id: number; qty_m: number; unit_cost: number; value_minor: number }>

  const update = db.prepare('UPDATE stock_movements SET value_minor = ? WHERE id = ?')
  let repaired = 0

  const run = db.transaction(() => {
    for (const row of rows) {
      const correct = movementValueMinor(row.qty_m, row.unit_cost)
      if (correct !== row.value_minor) {
        update.run(correct, row.id)
        repaired++
      }
    }
  })

  run()
  return repaired
}

// ── On hand — DERIVED, always ────────────────────────────────────────────────

/**
 * Stock on hand, in qty_m. SUM(stock_movements.qty_m). That is the whole definition.
 *
 * CAN BE NEGATIVE. A shop that sells the last tin before the delivery is entered is oversold, not
 * broken — we warn, allow and flag it (PLAN.md §1). Clamping it to zero here would hide the very
 * thing the owner needs to see.
 *
 * An unknown product is an ERROR, not "zero". A product with no movements and a product that does not
 * exist both have no rows to sum, and quietly answering "0 in stock" for the second one would make
 * `wouldGoNegative()` reply "no problem" about an item that isn't there — a wrong answer to a safety
 * question. The id costs one primary-key lookup to check; a silent lie costs more than that.
 */
export function onHand(db: DB, productId: number): number {
  const exists = db.prepare('SELECT 1 FROM products WHERE id = ?').pluck().get(productId)
  if (exists == null) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That item could not be found. It may have been removed.',
      `product id=${productId} does not exist`
    )
  }

  return db
    .prepare('SELECT COALESCE(SUM(qty_m), 0) FROM stock_movements WHERE product_id = ?')
    .pluck()
    .get(productId) as number
}

export type BatchStockLevel = {
  batchId: number
  batchNo: string
  /** ISO date. Null = does not expire. */
  expiryDate: string | null
  /** 4-dp cost — what THIS batch cost. */
  cost: number
  /** SUM of this batch's movements, in qty_m. */
  onHandM: number
}

/**
 * On-hand per batch, oldest expiry first — which is the order FEFO will pick in (Phase 5) and the
 * order a near-expiry report reads in.
 *
 * NOTE: these will not always add up to `onHand(productId)`. A movement may carry no batch at all
 * (stock that predates batch tracking, or an adjustment against the product as a whole), and that
 * remainder belongs to the product, not to any batch. The product total is always the SUM of ALL its
 * movements — batched or not.
 */
export function onHandByBatch(db: DB, productId: number): BatchStockLevel[] {
  const rows = db
    .prepare(
      `SELECT b.id           AS batch_id,
              b.batch_no     AS batch_no,
              b.expiry_date  AS expiry_date,
              b.cost         AS cost,
              COALESCE((SELECT SUM(m.qty_m) FROM stock_movements m WHERE m.batch_id = b.id), 0) AS on_hand
       FROM batches b
       WHERE b.product_id = ?
       ORDER BY b.expiry_date IS NULL, b.expiry_date, b.id`
    )
    .all(productId) as Array<{
    batch_id: number
    batch_no: string
    expiry_date: string | null
    cost: number
    on_hand: number
  }>

  return rows.map((row) => ({
    batchId: row.batch_id,
    batchNo: row.batch_no,
    expiryDate: row.expiry_date,
    cost: row.cost,
    onHandM: row.on_hand
  }))
}

/**
 * Would this movement leave the shop with less than nothing?
 *
 * `qtyM` is the SIGNED movement, exactly as it will be written to stock_movements — a sale of 6
 * pieces is −6000, NOT 6000. Pass the wrong sign and this cheerfully says "no problem" about a sale
 * that oversells the shelf.
 *
 * This does NOT block anything. Negative stock is ALLOWED (PLAN.md §1) — the delivery that has not
 * been keyed in yet is real, and a POS that refuses to sell what is physically in the customer's hand
 * is a POS the shop works around. Phase 5 warns, allows, flags the sale and audit-logs it. This is
 * how it knows to.
 */
export function wouldGoNegative(db: DB, productId: number, qtyM: number): boolean {
  // A service or a bag charge has no stock, so it cannot be oversold. The sell path asks this about
  // EVERY line without first checking what kind of item it is, and answering "yes" here would put a
  // negative-stock warning — and an audit flag — on every carrier bag the shop ever sells.
  if (loadProduct(db, productId).item_type !== 'inventory') return false

  return projectedOnHand(db, productId, qtyM) < 0
}

/** What on-hand WOULD be after a signed movement of `qtyM`. */
export function projectedOnHand(db: DB, productId: number, qtyM: number): number {
  return onHand(db, productId) + qtyM
}

// ── Recording a movement ─────────────────────────────────────────────────────

export type RecordMovementInput = {
  productId: number
  type: StockMovementType
  /** SIGNED qty_m. Positive = into the shop (purchase, opening, return in). Negative = out. Never 0. */
  qtyM: number
  /**
   * 4-dp cost, FROZEN onto the movement. Defaults to the product's current weighted average — which
   * is exactly right for a sale (that is the COGS) and for a write-off (that is what was lost).
   * A purchase passes its own landed cost, and that is what re-averages the product.
   */
  unitCost?: number
  batchId?: number | null
  /** 'sale' | 'purchase' | 'adjustment' … and the id of that document. */
  refType?: string | null
  refId?: string | number | null
  /** lookups('adjustment_reason'). Mandatory for an adjustment — see `adjust()`. */
  reasonCode?: string | null
  note?: string | null
  userId?: number | null
  at?: Date
}

/**
 * APPEND a stock movement. The only way stock ever changes, from any screen, in any phase.
 *
 * Does NOT post a journal — the sale, purchase or adjustment that caused the movement owns its own
 * accounting. (`adjust()` below is the one that posts, because there an adjustment IS the event.)
 *
 * Keeps `products.cost_price` — the running weighted average — in step with the movements. See
 * `refreshAverageCost()` for why it is safe to skip that work on the sell path.
 */
export function record(db: DB, input: RecordMovementInput): StockMovement {
  const at = input.at ?? new Date()

  if (!Number.isSafeInteger(input.qtyM) || input.qtyM === 0) {
    // A zero movement is a row that claims something happened while recording that nothing did.
    throw new AppError(
      ErrorCode.VALIDATION,
      'Please enter a quantity — it cannot be zero.',
      `stock movement qty_m must be a non-zero integer, got ${input.qtyM}`
    )
  }

  const product = loadProduct(db, input.productId)
  assertStocked(product)

  const unitCost = input.unitCost ?? product.cost_price
  if (!Number.isSafeInteger(unitCost) || unitCost < 0) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'That cost does not look right. Please check it and try again.',
      `unit_cost must be a non-negative integer at 4-dp cost scale, got ${unitCost}`
    )
  }

  // A CLOSED MONTH REFUSES STOCK, not just money.
  //
  // The period lock lived only in ledger.post(), so any movement that posted no journal — a plain
  // sale/purchase stock leg, or a zero-value movement — could still be slotted into a month the
  // owner had already closed and reported. Stock would change under a locked period while the books
  // sat frozen, and the two would disagree forever. The stock ledger is a ledger; it locks too.
  ledger.assertPeriodOpen(db, at.getFullYear(), at.getMonth() + 1)

  const write = db.transaction((): StockMovement => {
    // Read BEFORE the insert: the average blends the incoming stock with what was already there.
    const existingQtyM = onHand(db, input.productId)

    // Is this movement being slotted in BEHIND ones already recorded? Then the running average has
    // to be rebuilt from scratch, because history changed underneath it. (See refreshAverageCost.)
    const latestAt = db
      .prepare('SELECT MAX(at) FROM stock_movements WHERE product_id = ?')
      .pluck()
      .get(input.productId) as string | null
    const backdated = latestAt != null && at.toISOString() < latestAt

    const id = Number(
      db
        .prepare(
          // value_minor is frozen onto the movement, exactly like a sale line freezes its own tax:
          // valued once, at the moment it happened, and never recomputed from today's numbers.
          `INSERT INTO stock_movements
             (at, type, product_id, batch_id, qty_m, unit_cost, value_minor,
              ref_type, ref_id, reason_code, note, user_id, created_at)
           VALUES
             (@at, @type, @productId, @batchId, @qtyM, @unitCost, @valueMinor,
              @refType, @refId, @reasonCode, @note, @userId, @createdAt)`
        )
        .run({
          valueMinor: movementValueMinor(input.qtyM, unitCost),
          at: at.toISOString(),
          type: input.type,
          productId: input.productId,
          batchId: input.batchId ?? null,
          qtyM: input.qtyM,
          unitCost,
          refType: input.refType ?? null,
          refId: input.refId != null ? String(input.refId) : null,
          reasonCode: input.reasonCode ?? null,
          note: input.note ?? null,
          userId: input.userId ?? null,
          createdAt: new Date().toISOString()
        }).lastInsertRowid
    )

    // KEEPING THE CACHED AVERAGE HONEST. Three cases, and the reasoning matters more than the code:
    //
    //  backdated       History changed UNDERNEATH the running average — an earlier movement can
    //                  change the balance a later purchase was blended against. The incremental
    //                  arithmetic no longer applies to any of it. Rebuild from the movements. Rare,
    //                  and worth the scan.
    //
    //  increase (in order)  Blend the arrival into what was already on the shelf. This is EXACTLY
    //                  what a rebuild would compute at this point in the history — the rebuild's
    //                  state right before this movement is (on-hand-before, stored-average), which is
    //                  what we just fed it. O(1).
    //
    //  decrease (in order)  The average CANNOT have changed. A decrease never moves it, and there is
    //                  no later increase whose blend could have shifted. Nothing to do — which is what
    //                  keeps the sell path O(1) no matter how many years of movements a product has.
    if (backdated) {
      refreshAverageCost(db, input.productId)
    } else if (input.qtyM > 0) {
      const newAverage = weightedAverage(existingQtyM, product.cost_price, input.qtyM, unitCost)
      db.prepare('UPDATE products SET cost_price = ?, updated_at = ? WHERE id = ?').run(
        newAverage,
        new Date().toISOString(),
        input.productId
      )
    }

    const row = db.prepare('SELECT * FROM stock_movements WHERE id = ?').get(id) as MovementRow
    return toMovement(row)
  })

  return write()
}

// ── The average cost, and keeping it honest ──────────────────────────────────

/**
 * Rebuild the weighted average from the movements, in chronological order. WRITES NOTHING.
 *
 * `products.cost_price` is a CACHE — the one derived value in this app that cannot simply be re-summed
 * on read, because an average depends on the running balance at the moment of every purchase and so
 * has to be walked. Anything cached can rot. This is the auditor: it recomputes the answer from the
 * movements, and a standing test asserts that what is STORED equals what this returns, for every
 * product, after every scenario. If those two ever disagree, some write path skipped the average —
 * and we want to hear about it here, not in a profit report next March.
 *
 * THE SEED, and why it does not make the audit toothless. The walk starts from the cost typed on the
 * product form, because until the first delivery arrives that figure is the ONLY cost the item has:
 * nothing has been bought, so there is no history to average. The FIRST stock increase discards it —
 * `weightedAverage` resets to the incoming cost when there is nothing on the shelf to blend with. So
 * for every product that has ever received stock (which is every product that has ever HAD stock),
 * what this returns depends on the movements ALONE, and the cached figure gets no say in its own
 * audit. There is a test that proves exactly that by corrupting the cache and rebuilding anyway.
 */
export function recomputeAverageCost(db: DB, productId: number): number {
  const rows = db
    .prepare(
      `SELECT qty_m, unit_cost FROM stock_movements
       WHERE product_id = ?
       ORDER BY at, id`
    )
    .all(productId) as Array<{ qty_m: number; unit_cost: number }>

  // No history at all: there is nothing to derive. The figure the owner typed on the form stands —
  // zeroing it would be vandalism dressed up as correctness.
  if (rows.length === 0) return averageCost(db, productId)

  // A TRUE REBUILD — from the movements ALONE, starting from nothing.
  //
  // This used to seed itself with `averageCost(db, productId)`: the current CACHED value. It began
  // from the very number it exists to check, so a drifted cache would rebuild to its own drifted
  // self and the "the cache never lies" assertion could not see it. A rebuild that trusts the cache
  // is not a rebuild.
  let average = 0
  let qtyM = 0

  for (const row of rows) {
    // A sale made BEFORE any stock ever arrived (the shop oversold from nothing). There is no history
    // to have averaged, but the movement FROZE the cost it went out at — so the history does carry
    // the answer, and we adopt it. This is exactly what the live path did at the time.
    if (qtyM === 0 && average === 0 && row.qty_m < 0) {
      average = row.unit_cost
    }

    // Exactly the rule record() applies: only an increase moves the average.
    average = weightedAverage(qtyM, average, row.qty_m, row.unit_cost)
    qtyM += row.qty_m
  }

  return average
}

/**
 * Rebuild the average AND store it. The repair path — used when history has been changed behind the
 * running average's back (a backdated movement), and available to a maintenance screen.
 */
export function refreshAverageCost(db: DB, productId: number, now = new Date()): number {
  const average = recomputeAverageCost(db, productId)
  db.prepare('UPDATE products SET cost_price = ?, updated_at = ? WHERE id = ?').run(
    average,
    now.toISOString(),
    productId
  )
  return average
}

/** The stored running average (4-dp cost). What a sale will take stock out at. */
export function averageCost(db: DB, productId: number): number {
  const cost = db.prepare('SELECT cost_price FROM products WHERE id = ?').pluck().get(productId) as
    | number
    | undefined

  if (cost == null) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That item could not be found. It may have been removed.',
      `product id=${productId} does not exist`
    )
  }
  return cost
}

// ── Adjustments — the only way a HUMAN changes stock ─────────────────────────

export type AdjustResult = {
  movement: StockMovement
  /** Derived, after the movement. */
  onHandM: number
  /** The weighted average after the movement (4-dp cost). */
  avgCost: number
  /** Null when the movement had no value to post — see below. */
  journalId: number | null
}

/**
 * A STOCK ADJUSTMENT: damage, shrinkage, a stock-take correction, an opening balance.
 *
 * Three things happen together, in one transaction, or none of them happen:
 *
 *   1. a movement is appended (signed, with the reason and the user frozen onto it);
 *   2. the weighted average is kept in step;
 *   3. a BALANCED journal is posted — because stock that vanishes is money that vanishes.
 *
 *        write-DOWN (damage)   DEBIT  Stock Adjustment    CREDIT Inventory
 *        write-UP   (found)    DEBIT  Inventory           CREDIT Stock Adjustment
 *
 *   ...except for an OPENING balance, whose other side is OPENING BALANCE EQUITY, not an expense.
 *   The stock a shop already owned on day one is not shrinkage and must never show up in the P&L as
 *   a day-one loss (PLAN.md §4, Opening balances).
 *
 * THE REASON CODE IS MANDATORY, and it is checked against lookups('adjustment_reason') — not against
 * a hardcoded list, and not merely trusted from the renderer. An unexplained stock change is exactly
 * what a shop being stolen from looks like, and this row is the only thing that will ever say so.
 *
 * The movement is valued at the product's AVERAGE COST (an `opening` may state its own cost, because
 * on day one there is no history to average). If that value comes to zero — a free sample, a product
 * that has never been bought — no journal is posted: there is no money to move, and a zero-value
 * journal is not a record of anything.
 */
export function adjust(
  db: DB,
  actor: User,
  raw: unknown,
  now = new Date()
): AdjustResult {
  // Validate HERE, not only in the IPC handler.
  //
  // The service layer is the real boundary (CLAUDE.md §3): vitest calls it directly today, and a LAN
  // server will call it tomorrow. Trusting the caller to have zod-parsed first means a caller who
  // forgets gets a raw `NOT NULL constraint failed: stock_movements.type` instead of a sentence a
  // shopkeeper can act on — and loses the schema's defaults (type = 'adjustment') into the bargain.
  // products.create() already does this; stock.adjust() did not. Now it matches.
  const input = parseOrThrow(AdjustStockInput, raw, 'stock.adjust')

  const product = loadProduct(db, input.productId)
  assertStocked(product)

  const reason = assertAdjustmentReason(db, input.reasonCode)

  // Value at the average cost the stock is CARRIED at — read BEFORE the movement moves it.
  // An `opening` may state its own cost: on day one there is no history to have averaged.
  const unitCost =
    input.type === 'opening' && input.unitCost != null ? input.unitCost : product.cost_price

  if (input.batchId != null) assertBatchBelongsToProduct(db, input.batchId, input.productId)

  const run = db.transaction((): AdjustResult => {
    const before = { onHandM: onHand(db, input.productId), avgCost: product.cost_price }

    // No ref_type/ref_id: an adjustment is not raised BY a document, it IS the event. Its `type`,
    // its reason code and its user say everything there is to say, and the journal posted below
    // points back at this movement. (A sale's movement, by contrast, points at the sale.)
    //
    // Note what does NOT happen here: nothing goes back and updates this row afterwards. A movement
    // is written once and never touched again — the ledger of stock is append-only, exactly like the
    // ledger of money.
    const movement = record(db, {
      productId: input.productId,
      type: input.type,
      qtyM: input.qtyM,
      unitCost,
      batchId: input.batchId ?? null,
      reasonCode: reason.code,
      note: input.note ?? null,
      userId: actor.id,
      at: now
    })

    // Cost scale (4 dp) -> money scale (2 dp). The ledger is money, and only money.
    // The journal posts the movement's OWN frozen value. Recomputing it here would be a second
    // implementation of the same sum — and a second chance to round it differently.
    const valueMinor = Math.abs(movementValueMinor(input.qtyM, unitCost))

    let journalId: number | null = null
    if (valueMinor > 0) {
      const wentIn = input.qtyM > 0
      const counterAccount =
        input.type === 'opening' ? ACC.OPENING_BALANCE_EQUITY : ACC.STOCK_ADJUSTMENT

      journalId = ledger.post(db, {
        at: now,
        refType: input.type === 'opening' ? 'opening' : 'stock_adjustment',
        refId: movement.id,
        memo: `${labelFor(input.type)}: ${product.name} (${reason.label})`,
        userId: actor.id,
        lines: wentIn
          ? [
              { account: ACC.INVENTORY, debit: valueMinor },
              { account: counterAccount, credit: valueMinor }
            ]
          : [
              { account: counterAccount, debit: valueMinor },
              { account: ACC.INVENTORY, credit: valueMinor }
            ]
      })
    }

    const after = { onHandM: onHand(db, input.productId), avgCost: averageCost(db, input.productId) }

    // WHO changed the shop's stock, WHY, and by how much. (CLAUDE.md §4)
    audit.record(
      db,
      actor,
      {
        action: `stock.${input.type}`,
        entity: 'product',
        entityId: input.productId,
        reasonCode: reason.code,
        ...(input.note != null ? { reasonText: input.note } : {}),
        before,
        after: { ...after, qtyM: input.qtyM, unitCost, valueMinor }
      },
      now
    )

    return { movement, onHandM: after.onHandM, avgCost: after.avgCost, journalId }
  })

  return run()
}

/**
 * The reason must be a real, CURRENT entry on the owner's own adjustment_reason list — not a string
 * the renderer made up, and not one the owner has since retired. (CLAUDE.md §4: no hardcoded options,
 * ever; and the renderer is not a security boundary.)
 */
function assertAdjustmentReason(db: DB, code: string): { code: string; label: string } {
  const row = db
    .prepare(
      `SELECT code, label FROM lookups
       WHERE list_key = 'adjustment_reason' AND code = ? AND is_active = 1`
    )
    .get(code) as { code: string; label: string } | undefined

  if (!row) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Please choose a reason for this stock change from the list.',
      `unknown or inactive adjustment_reason code "${code}"`
    )
  }
  return row
}

function assertBatchBelongsToProduct(db: DB, batchId: number, productId: number): void {
  const owner = db.prepare('SELECT product_id FROM batches WHERE id = ?').pluck().get(batchId) as
    | number
    | undefined

  if (owner == null) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That batch could not be found.',
      `batch id=${batchId} does not exist`
    )
  }
  if (owner !== productId) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'That batch belongs to a different item. Please pick the right batch.',
      `batch ${batchId} belongs to product ${owner}, not ${productId}`
    )
  }
}

function labelFor(type: StockMovementType): string {
  const labels: Record<string, string> = {
    opening: 'Opening stock',
    adjustment: 'Stock adjustment',
    damage: 'Damaged stock',
    stock_take: 'Stock take correction'
  }
  return labels[type] ?? 'Stock movement'
}

// ── Lists (paginated, always — assume 100k+ rows) ────────────────────────────

export type StockLevelsInput = {
  page?: number
  pageSize?: number
  /** Matches sku or name. */
  search?: string
  categoryId?: number
  /** onHandM <= minStockM — the re-order report. */
  belowReorderOnly?: boolean
  includeInactive?: boolean
  sortBy?: 'name' | 'sku' | 'on_hand'
  sortDir?: 'asc' | 'desc'
}

const SORT_COLUMNS: Record<string, string> = {
  name: 'p.name',
  sku: 'p.sku',
  on_hand: 'on_hand'
}

/**
 * Stock levels: name, on-hand, re-order level, average cost and stock value — paginated.
 *
 * On-hand is a correlated SUM over the movements. It is NOT a stored column and it never will be, so
 * this list cannot ever show a figure that the item's own history disagrees with. Non-inventory items
 * are excluded: they have no stock, by definition.
 *
 * The subquery is evaluated per row of the page (an index seek on idx_stock_movements_product), so
 * an ordinary page is cheap. Filtering on `belowReorderOnly` or sorting by on_hand does have to
 * evaluate it for every candidate product — that is the price of a derived figure, it is a report
 * rather than the sell path, and it is the right price to pay.
 */
export function stockLevels(db: DB, input: StockLevelsInput = {}): PagedResult<StockLevel> {
  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 50))

  const onHandSql = '(SELECT COALESCE(SUM(m.qty_m), 0) FROM stock_movements m WHERE m.product_id = p.id)'

  // Stock value is the SUM of what each movement actually moved — the very numbers the ledger posted.
  // It is NOT on_hand x average: sum-of-rounded != round-of-sum, and that difference is how the GL
  // and the stock report used to drift a paisa apart while the trial balance stayed green.
  const stockValueSql =
    '(SELECT COALESCE(SUM(m.value_minor), 0) FROM stock_movements m WHERE m.product_id = p.id)'

  const where: string[] = ["p.item_type = 'inventory'"]
  const params: Record<string, unknown> = {}

  if (!input.includeInactive) where.push('p.is_active = 1')

  if (input.search) {
    where.push('(p.sku LIKE @search OR p.name LIKE @search OR p.name_other_lang LIKE @search)')
    params['search'] = `%${input.search}%`
  }
  if (input.categoryId != null) {
    where.push('p.category_id = @categoryId')
    params['categoryId'] = input.categoryId
  }
  if (input.belowReorderOnly) {
    where.push(`${onHandSql} <= p.min_stock_m`)
  }

  const whereSql = `WHERE ${where.join(' AND ')}`

  const total = db
    .prepare(`SELECT COUNT(*) FROM products p ${whereSql}`)
    .pluck()
    .get(params) as number

  const sortColumn = SORT_COLUMNS[input.sortBy ?? 'name'] ?? 'p.name'
  const sortDir = input.sortDir === 'desc' ? 'DESC' : 'ASC'

  const rows = db
    .prepare(
      `SELECT p.id          AS id,
              p.sku         AS sku,
              p.name        AS name,
              p.item_type   AS item_type,
              p.min_stock_m AS min_stock_m,
              p.cost_price  AS cost_price,
              ${onHandSql}     AS on_hand,
              ${stockValueSql} AS stock_value
       FROM products p
       ${whereSql}
       ORDER BY ${sortColumn} ${sortDir}, p.id
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as Array<{
    id: number
    sku: string
    name: string
    min_stock_m: number
    cost_price: number
    item_type: string
    on_hand: number
    stock_value: number
  }>

  return {
    total,
    page,
    pageSize,
    rows: rows.map((row) => toStockLevel(row))
  }
}

function toStockLevel(row: {
  id: number
  sku: string
  name: string
  item_type?: string
  min_stock_m: number
  cost_price: number
  on_hand: number
  stock_value: number
}): StockLevel {
  return {
    productId: row.id,
    sku: row.sku,
    name: row.name,
    onHandM: row.on_hand,
    minStockM: row.min_stock_m,
    // A NON-INVENTORY item (a service, a bag charge) has no stock and a re-order level of 0, so a
    // bare `0 <= 0` flags every service in the shop as needing re-ordering, forever. The re-order
    // flag only means anything for something you can actually run out of.
    isBelowReorder:
      (row.item_type ?? 'inventory') === 'inventory' && row.on_hand <= row.min_stock_m,
    avgCost: row.cost_price,
    // THE SAME NUMBER THE LEDGER POSTED. Summed from the movements, not recomputed from
    // on_hand x average — see migration 0006. This is what makes GL Inventory and the stock
    // valuation report equal by construction rather than by luck.
    stockValueMinor: row.stock_value
  }
}

/** ONE product's stock level. What the product form shows in its READ-ONLY "balance quantity" field. */
export function stockLevel(db: DB, productId: number): StockLevel {
  const product = db
    .prepare('SELECT id, sku, name, item_type, min_stock_m, cost_price FROM products WHERE id = ?')
    .get(productId) as
    | { id: number; sku: string; name: string; min_stock_m: number; cost_price: number }
    | undefined

  if (!product) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That item could not be found. It may have been removed.',
      `product id=${productId} does not exist`
    )
  }

  // Value from the movements' own frozen values — the same numbers the ledger posted.
  const stockValue = db
    .prepare(
      'SELECT COALESCE(SUM(value_minor), 0) FROM stock_movements WHERE product_id = ?'
    )
    .pluck()
    .get(productId) as number

  return toStockLevel({ ...product, on_hand: onHand(db, productId), stock_value: stockValue })
}

/**
 * THE RE-ORDER REPORT: everything at or below its re-order level (on-hand <= min_stock_m).
 * One predicate, one SQL path, shared with stockLevels() — so the flag on a row in one list can never
 * disagree with membership of the other.
 */
export function lowStock(
  db: DB,
  input: Omit<StockLevelsInput, 'belowReorderOnly'> = {}
): PagedResult<StockLevel> {
  return stockLevels(db, { ...input, belowReorderOnly: true })
}

export type NearExpiryRow = {
  productId: number
  sku: string
  name: string
  batchId: number
  batchNo: string
  /** ISO date. Never null here — a batch with no expiry cannot be near one. */
  expiryDate: string
  /** Negative once the batch is already past its expiry date. */
  daysToExpiry: number
  expired: boolean
  /** Still on the shelf, in qty_m. Batches with nothing left are not listed. */
  onHandM: number
  /** What that remaining stock cost, in money minor units (2 dp) — what the shop stands to lose. */
  valueMinor: number
}

export type NearExpiryInput = {
  /** Batches expiring within this many days. Already-expired batches are ALWAYS included. */
  days?: number
  page?: number
  pageSize?: number
  productId?: number
  asOf?: Date
}

/**
 * NEAR EXPIRY — stock the shop is about to have to throw away, soonest first.
 *
 * Only batches with something LEFT on the shelf appear: a batch that sold out cannot expire. Batches
 * that are already past their date are always included, however far past — they are the urgent ones,
 * and dropping them out of the report the day they expire is how expired stock stays on a shelf.
 */
export function nearExpiry(db: DB, input: NearExpiryInput = {}): PagedResult<NearExpiryRow> {
  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 50))
  // How far ahead to look is the SHOP's call, not this file's (CLAUDE.md §4: if a number could
  // reasonably differ between two shops, it is a setting). A bakery worries weeks ahead; a hardware shop
  // never. `input.days` is the caller's explicit override; otherwise the owner's setting decides, whose
  // registry default is 30 — so a shop that never touched it sees exactly what it always saw.
  const days = Math.max(
    0,
    input.days ?? settings.get<number>(db, 'stock.nearExpiryDays', REGISTRY_DEFAULTS['stock.nearExpiryDays'] as number)
  )
  const asOf = input.asOf ?? new Date()

  const cutoff = new Date(asOf.getTime() + days * 24 * 60 * 60 * 1000)
  const cutoffDate = isoDate(cutoff)
  const today = isoDate(asOf)

  const onHandSql = '(SELECT COALESCE(SUM(m.qty_m), 0) FROM stock_movements m WHERE m.batch_id = b.id)'

  // What the batch is WORTH: the sum of the values its movements FROZE — the very numbers the ledger
  // posted. NOT round(on_hand x cost): sum-of-rounded != round-of-sum, and two receipts of 3 pcs at
  // Rs 91.0417 made this report disagree with the books by a paisa, silently, with the trial balance
  // still green. Same construction as stockLevels(). See migration 0006.
  const valueSql =
    '(SELECT COALESCE(SUM(m.value_minor), 0) FROM stock_movements m WHERE m.batch_id = b.id)'

  const where: string[] = ['b.expiry_date IS NOT NULL', 'b.expiry_date <= @cutoff', `${onHandSql} > 0`]
  const params: Record<string, unknown> = { cutoff: cutoffDate }

  if (input.productId != null) {
    where.push('b.product_id = @productId')
    params['productId'] = input.productId
  }

  const whereSql = `WHERE ${where.join(' AND ')}`

  const total = db
    .prepare(`SELECT COUNT(*) FROM batches b ${whereSql}`)
    .pluck()
    .get(params) as number

  const rows = db
    .prepare(
      `SELECT b.id          AS batch_id,
              b.batch_no    AS batch_no,
              b.expiry_date AS expiry_date,
              p.id          AS product_id,
              p.sku         AS sku,
              p.name        AS name,
              ${onHandSql}  AS on_hand,
              ${valueSql}   AS value_minor
       FROM batches b
       JOIN products p ON p.id = b.product_id
       ${whereSql}
       ORDER BY b.expiry_date, b.id
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as Array<{
    batch_id: number
    batch_no: string
    expiry_date: string
    product_id: number
    sku: string
    name: string
    on_hand: number
    value_minor: number
  }>

  return {
    total,
    page,
    pageSize,
    rows: rows.map((row) => ({
      productId: row.product_id,
      sku: row.sku,
      name: row.name,
      batchId: row.batch_id,
      batchNo: row.batch_no,
      expiryDate: row.expiry_date,
      daysToExpiry: daysBetween(today, row.expiry_date),
      expired: row.expiry_date < today,
      onHandM: row.on_hand,
      // The frozen value the ledger posted — not a fresh multiply. See valueSql above.
      valueMinor: row.value_minor
    }))
  }
}

/** The item's own history — the legacy "SHOW HISTORY" panel, and the Stock Movements screen. */
export function listMovements(
  db: DB,
  input: StockMovementListInput = {}
): PagedResult<StockMovement> {
  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 50))

  const where: string[] = []
  const params: Record<string, unknown> = {}

  if (input.productId != null) {
    where.push('m.product_id = @productId')
    params['productId'] = input.productId
  }
  if (input.type) {
    where.push('m.type = @type')
    params['type'] = input.type
  }
  if (input.from) {
    where.push('m.at >= @from')
    params['from'] = input.from
  }
  if (input.to) {
    where.push('m.at <= @to')
    params['to'] = input.to
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const total = db
    .prepare(`SELECT COUNT(*) FROM stock_movements m ${whereSql}`)
    .pluck()
    .get(params) as number

  const rows = db
    .prepare(
      `SELECT m.*, u.full_name AS user_name
       FROM stock_movements m
       LEFT JOIN users u ON u.id = m.user_id
       ${whereSql}
       ORDER BY m.at DESC, m.id DESC
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as MovementRow[]

  return { total, page, pageSize, rows: rows.map(toMovement) }
}

// ── Dates ────────────────────────────────────────────────────────────────────

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Whole days from `from` to `to`, both ISO dates (YYYY-MM-DD). Negative once `to` is in the past. */
function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)
  return Math.round(ms / (24 * 60 * 60 * 1000))
}
