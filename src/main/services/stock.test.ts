import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import * as stock from './stock'
import * as ledger from './ledger'
import { ACC } from '../db/chart-of-accounts'
import { formatCost, costPerUnit, parseCost } from '@shared/cost'
import { formatQty, ONE_UNIT } from '@shared/qty'
import { formatMoney } from '@shared/money'
import type { User } from '@shared/types'

/**
 * STOCK — the most important service in the catalog phase.
 *
 * Two things are being defended in this file, and everything else is scaffolding around them:
 *
 *   1. ON-HAND IS THE SUM OF THE MOVEMENTS. There is no stock column. The tests below prove it by
 *      writing movements with raw SQL, behind the service's back, and watching the answer change.
 *
 *   2. THE WEIGHTED AVERAGE IS RIGHT, AND THE CACHED COPY OF IT IS HONEST. Buy 10 @ 100, buy 10 @ 120
 *      -> 110. Sell 5 -> still 110. And after EVERY scenario in this file, the stored average equals
 *      the average rebuilt from the movements alone. That standing assertion is what stops a cached
 *      number from quietly drifting away from the history that is supposed to produce it.
 *
 * Get either wrong and the shop's inventory and its profit are both wrong — and nobody finds out for
 * a year.
 */

// ── The standing assertions, run after every scenario ────────────────────────

/**
 * THE CACHE IS HONEST: products.cost_price === the average rebuilt from the movements.
 *
 * Checked for EVERY product, not just the one the test was thinking about — a write path that
 * updates the wrong product's average is exactly the sort of bug that hides for a year.
 */
function assertAverageCostIsHonest(t: TestDb): void {
  const ids = t.db.prepare('SELECT id FROM products').pluck().all() as number[]

  for (const id of ids) {
    const stored = t.db.prepare('SELECT cost_price FROM products WHERE id = ?').pluck().get(id)
    const rebuilt = stock.recomputeAverageCost(t.db, id)
    expect(stored, `product ${id}: stored average has drifted from the movements`).toBe(rebuilt)
  }
}

/** THE STANDING TEST from CLAUDE.md §4: after every scenario, the trial balance balances. */
function assertBooksBalance(t: TestDb): void {
  const tb = ledger.trialBalance(t.db)
  expect(tb.balanced).toBe(true)
  expect(tb.totalDebit).toBe(tb.totalCredit)
}

function assertEverythingHolds(t: TestDb): void {
  assertAverageCostIsHonest(t)
  assertBooksBalance(t)
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const RS_100 = 1_000_000 // 4-dp cost
const RS_120 = 1_200_000
const RS_110 = 1_100_000
const TEN_PIECES = 10 * ONE_UNIT
const FIVE_PIECES = 5 * ONE_UNIT

function uomId(t: TestDb, code = 'pcs'): number {
  return t.db
    .prepare("SELECT id FROM lookups WHERE list_key = 'uom' AND code = ?")
    .pluck()
    .get(code) as number
}

type MakeProduct = {
  sku?: string
  name?: string
  costPrice?: number
  minStockM?: number
  itemType?: 'inventory' | 'non_inventory'
  trackBatches?: boolean
  isWeighted?: boolean
  uom?: string
  isActive?: boolean
}

function makeProduct(t: TestDb, options: MakeProduct = {}): number {
  const now = new Date().toISOString()
  return Number(
    t.db
      .prepare(
        `INSERT INTO products
           (sku, name, sale_uom_id, cost_price, retail_price, min_stock_m,
            item_type, track_batches, is_weighted, is_active, created_at, updated_at)
         VALUES (@sku, @name, @uomId, @costPrice, 0, @minStockM,
                 @itemType, @trackBatches, @isWeighted, @isActive, @now, @now)`
      )
      .run({
        sku: options.sku ?? `SKU-${Math.random().toString(36).slice(2, 10)}`,
        name: options.name ?? 'Test Item',
        uomId: uomId(t, options.uom ?? 'pcs'),
        costPrice: options.costPrice ?? 0,
        minStockM: options.minStockM ?? 0,
        itemType: options.itemType ?? 'inventory',
        trackBatches: options.trackBatches ? 1 : 0,
        isWeighted: options.isWeighted ? 1 : 0,
        isActive: options.isActive === false ? 0 : 1,
        now
      }).lastInsertRowid
  )
}

function makeBatch(
  t: TestDb,
  productId: number,
  batchNo: string,
  expiryDate: string | null,
  cost = 0
): number {
  return Number(
    t.db
      .prepare(
        `INSERT INTO batches (product_id, batch_no, expiry_date, cost, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(productId, batchNo, expiryDate, cost, new Date().toISOString()).lastInsertRowid
  )
}

function makeUser(t: TestDb, role = 'manager', username = 'meena'): User {
  const id = Number(
    t.db
      .prepare(
        `INSERT INTO users (username, full_name, role, password_hash, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 'x', 1, ?, ?)`
      )
      .run(username, 'Meena Manager', role, new Date().toISOString(), new Date().toISOString())
      .lastInsertRowid
  )
  return { id, username, fullName: 'Meena Manager', role: role as User['role'], hasPin: false, isActive: true }
}

/** Buy stock in. In real life this comes from a purchase (Phase 7); here it is the same movement. */
function buy(t: TestDb, productId: number, qtyM: number, unitCost: number, at?: Date): void {
  stock.record(t.db, { productId, type: 'purchase', qtyM, unitCost, refType: 'purchase', ...(at ? { at } : {}) })
}

/** Sell stock out. The unit cost is FROZEN at the average — that is the COGS for this sale. */
function sell(t: TestDb, productId: number, qtyM: number, at?: Date): void {
  stock.record(t.db, { productId, type: 'sale', qtyM: -qtyM, refType: 'sale', ...(at ? { at } : {}) })
}

// ── On hand is DERIVED. There is no stock column. ────────────────────────────

describe('on hand — derived from the movements, never read from a column', () => {
  let t: TestDb
  beforeEach(() => (t = makeTestDb({ withSeed: true })))
  afterEach(() => t.cleanup())

  it('the products table HAS NO STOCK COLUMN — and never will', () => {
    const columns = (
      t.db.prepare('PRAGMA table_info(products)').all() as Array<{ name: string }>
    ).map((c) => c.name)

    // min_stock_m is the RE-ORDER LEVEL — a target, not a balance. Everything else is forbidden.
    for (const forbidden of ['stock', 'stock_m', 'qty', 'qty_m', 'quantity', 'on_hand', 'balance']) {
      expect(columns).not.toContain(forbidden)
    }
    expect(columns).toContain('min_stock_m')
  })

  it('on hand is SUM(qty_m) — nothing else', () => {
    const id = makeProduct(t)
    expect(stock.onHand(t.db, id)).toBe(0)

    buy(t, id, 24 * ONE_UNIT, RS_100)
    sell(t, id, 3 * ONE_UNIT)

    expect(stock.onHand(t.db, id)).toBe(21 * ONE_UNIT)
    assertEverythingHolds(t)
  })

  it('reflects a movement written BEHIND the service’s back — because it is not cached anywhere', () => {
    // The proof that on-hand is derived: write a movement with raw SQL, touching no service, no cache
    // and no "recalculate" button. The answer changes anyway, because the answer IS the sum.
    const id = makeProduct(t)
    buy(t, id, TEN_PIECES, RS_100)

    t.db
      .prepare(
        `INSERT INTO stock_movements (at, type, product_id, qty_m, unit_cost, created_at)
         VALUES (?, 'sale', ?, ?, ?, ?)`
      )
      .run(new Date().toISOString(), id, -2 * ONE_UNIT, RS_100, new Date().toISOString())

    expect(stock.onHand(t.db, id)).toBe(8 * ONE_UNIT)
    expect(stock.stockLevel(t.db, id).onHandM).toBe(8 * ONE_UNIT)
  })

  it('refuses a zero movement — a row claiming something happened while recording that nothing did', () => {
    const id = makeProduct(t)
    expectUserMessage(
      () => stock.record(t.db, { productId: id, type: 'adjustment', qtyM: 0 }),
      /cannot be zero/i
    )
  })

  it('refuses a movement against a NON-INVENTORY item — a service has no stock', () => {
    const id = makeProduct(t, { name: 'Carrier Bag Charge', itemType: 'non_inventory' })
    expectUserMessage(
      () => stock.record(t.db, { productId: id, type: 'purchase', qtyM: ONE_UNIT, unitCost: RS_100 }),
      /not a stocked item/i
    )
  })

  /**
   * An item that does not exist is an ERROR, not "0 in stock".
   *
   * A product with no movements and a product that was never there both have no rows to sum. If the
   * second one quietly answered "zero", then wouldGoNegative() would cheerfully reply "no problem"
   * about an item that isn't there — a wrong answer to a safety question, given to the one caller
   * whose whole job is to catch that. So every entry point refuses an unknown id, in the same words.
   */
  it('an unknown item is an ERROR everywhere — never a silent zero', () => {
    for (const call of [
      () => stock.onHand(t.db, 999),
      () => stock.stockLevel(t.db, 999),
      () => stock.averageCost(t.db, 999),
      () => stock.wouldGoNegative(t.db, 999, -ONE_UNIT),
      () => stock.record(t.db, { productId: 999, type: 'purchase', qtyM: ONE_UNIT })
    ]) {
      expectUserMessage(call, /could not be found/i)
    }
  })
})

// ── THE WEIGHTED AVERAGE ─────────────────────────────────────────────────────

describe('weighted average cost — the heart of it', () => {
  let t: TestDb
  beforeEach(() => (t = makeTestDb({ withSeed: true })))
  afterEach(() => t.cleanup())

  it('THE CLASSIC CASE: buy 10 @ 100, buy 10 @ 120 -> avg 110. Sell 5 -> avg STAYS 110.', () => {
    const id = makeProduct(t, { name: 'Cooking Oil 1L' })

    buy(t, id, TEN_PIECES, RS_100)
    expect(stock.averageCost(t.db, id)).toBe(RS_100)
    expect(stock.onHand(t.db, id)).toBe(TEN_PIECES)

    buy(t, id, TEN_PIECES, RS_120)
    expect(stock.averageCost(t.db, id)).toBe(RS_110) // (10x100 + 10x120) / 20
    expect(stock.onHand(t.db, id)).toBe(20 * ONE_UNIT)
    expect(formatCost(stock.averageCost(t.db, id))).toBe('110.0000')

    // THE ONE THAT MATTERS. A sale takes stock out AT the average; it does not change what the rest
    // of the shelf cost. If this ever reads 100 or 120, every profit report in the app is a lie.
    sell(t, id, FIVE_PIECES)
    expect(stock.averageCost(t.db, id)).toBe(RS_110)
    expect(stock.onHand(t.db, id)).toBe(15 * ONE_UNIT)

    // ...and the sale froze the COGS at the average, on the movement itself.
    const saleMovement = stock.listMovements(t.db, { productId: id, type: 'sale' }).rows[0]!
    expect(saleMovement.unitCost).toBe(RS_110)
    expect(saleMovement.qtyM).toBe(-FIVE_PIECES)

    assertEverythingHolds(t)
  })

  it('4-dp precision SURVIVES: a carton of 24 for Rs 2185 is Rs 91.0417 a piece', () => {
    // This is the whole reason cost is 4 dp and not 2. At 2 dp this is 91.04, and 0.0017 lost on
    // every piece, over a year of sales, quietly falsifies the profit report.
    const id = makeProduct(t, { name: 'Biscuits' })

    const cartonCost = parseCost('2185')!
    expect(cartonCost).toBe(21_850_000)

    const perPiece = costPerUnit(cartonCost, 24)
    expect(perPiece).toBe(910_417)
    expect(formatCost(perPiece)).toBe('91.0417')

    buy(t, id, 24 * ONE_UNIT, perPiece) // one carton, booked as 24 pieces
    expect(stock.averageCost(t.db, id)).toBe(910_417)
    expect(stock.onHand(t.db, id)).toBe(24 * ONE_UNIT)

    // The stock is worth what the carton cost, to the paisa.
    const level = stock.stockLevel(t.db, id)
    expect(formatMoney(level.stockValueMinor)).toBe('2,185.00')

    assertEverythingHolds(t)
  })

  it('averages three deliveries at awkward costs without drifting', () => {
    const id = makeProduct(t)

    buy(t, id, 7 * ONE_UNIT, 333_333) // Rs 33.3333
    buy(t, id, 3 * ONE_UNIT, 500_000) // Rs 50.0000
    // (7 x 333333 + 3 x 500000) / 10 = (2333331 + 1500000) / 10 = 383333.1 -> 383333
    expect(stock.averageCost(t.db, id)).toBe(383_333)

    buy(t, id, 10 * ONE_UNIT, 100_000)
    // (10 x 383333 + 10 x 100000) / 20 = 241666.5 -> 241667 (half up)
    expect(stock.averageCost(t.db, id)).toBe(241_667)

    assertEverythingHolds(t)
  })

  it('a DECREASE never moves the average, however many there are', () => {
    const id = makeProduct(t)
    buy(t, id, 100 * ONE_UNIT, RS_110)

    for (let i = 0; i < 20; i++) sell(t, id, 2 * ONE_UNIT)

    expect(stock.averageCost(t.db, id)).toBe(RS_110)
    expect(stock.onHand(t.db, id)).toBe(60 * ONE_UNIT)
    assertEverythingHolds(t)
  })

  it('an empty shelf RESETS the average — there is nothing left to blend against', () => {
    const id = makeProduct(t)

    buy(t, id, TEN_PIECES, RS_100)
    sell(t, id, TEN_PIECES) // shelf is empty; the average is a memory of nothing
    expect(stock.onHand(t.db, id)).toBe(0)

    buy(t, id, TEN_PIECES, RS_120)
    // NOT (0x100 + 10x120)/10 by accident, and definitely not 110 — the new stock cost 120, full stop.
    expect(stock.averageCost(t.db, id)).toBe(RS_120)

    assertEverythingHolds(t)
  })

  it('the pure function is the same arithmetic, with no database in the way', () => {
    expect(stock.weightedAverage(TEN_PIECES, RS_100, TEN_PIECES, RS_120)).toBe(RS_110)
    expect(stock.weightedAverage(TEN_PIECES, RS_110, -FIVE_PIECES, RS_100)).toBe(RS_110) // a sale
    expect(stock.weightedAverage(0, RS_100, TEN_PIECES, RS_120)).toBe(RS_120) // empty shelf
    // OVERSOLD. This used to expect RS_120 — a reset. That threw away the value the ledger was
    // already carrying for the negative stock. Blending relieves the −5 at the Rs 100 they were
    // booked at: (−5,000 x 1,000,000 + 10,000 x 1,200,000) / 5,000 = 1,400,000 = Rs 140.
    expect(stock.weightedAverage(-FIVE_PIECES, RS_100, TEN_PIECES, RS_120)).toBe(1_400_000)
    // Still oversold AFTER the delivery: nothing positive to carry an average, so it is the new cost.
    expect(stock.weightedAverage(-TEN_PIECES, RS_100, FIVE_PIECES, RS_120)).toBe(RS_120)
  })

  it('refuses arithmetic too large for a float to hold exactly', () => {
    // Number.isInteger is TRUE above 2^53, where floats stop holding consecutive integers — the exact
    // hole ledger.post() closes for money. It is closed here for cost too.
    expectUserMessage(
      () => stock.movementValueCost(9_007_199_254_740_991, 9_007_199_254_740_991),
      /too large/i
    )
  })
})

// ── The cached average must equal the rebuilt one — forever ──────────────────

describe('the stored average vs the movements — the cache must never lie', () => {
  let t: TestDb
  beforeEach(() => (t = makeTestDb({ withSeed: true })))
  afterEach(() => t.cleanup())

  it('stored average === recomputeAverageCost(), through a long messy life', () => {
    const id = makeProduct(t, { costPrice: 500_000 }) // a cost typed on the form, never bought yet

    buy(t, id, TEN_PIECES, RS_100)
    sell(t, id, 3 * ONE_UNIT)
    buy(t, id, TEN_PIECES, RS_120)
    sell(t, id, 12 * ONE_UNIT)
    buy(t, id, 5 * ONE_UNIT, 950_000)
    sell(t, id, ONE_UNIT)
    buy(t, id, 40 * ONE_UNIT, 1_050_000)

    const stored = t.db.prepare('SELECT cost_price FROM products WHERE id = ?').pluck().get(id)
    expect(stored).toBe(stock.recomputeAverageCost(t.db, id))
    assertEverythingHolds(t)
  })

  it('the rebuild does NOT simply parrot the cache back — it is a real audit', () => {
    // If recomputeAverageCost() trusted the stored figure, this whole safety net would be theatre.
    // Corrupt the cache and prove the rebuild ignores it and re-derives the truth from the movements.
    const id = makeProduct(t)
    buy(t, id, TEN_PIECES, RS_100)
    buy(t, id, TEN_PIECES, RS_120)

    t.db.prepare('UPDATE products SET cost_price = ? WHERE id = ?').run(999_999_999, id)

    expect(stock.recomputeAverageCost(t.db, id)).toBe(RS_110) // the truth, from the movements alone

    // ...and the repair path puts the cache back where it belongs.
    expect(stock.refreshAverageCost(t.db, id)).toBe(RS_110)
    assertEverythingHolds(t)
  })

  it('a product that has never received stock keeps the cost typed on its form', () => {
    // There is no history to average, so there is no average to derive. Zeroing the owner's own
    // figure would be vandalism dressed up as correctness — and the rebuild agrees with the cache.
    const id = makeProduct(t, { costPrice: 750_000 })

    expect(stock.averageCost(t.db, id)).toBe(750_000)
    expect(stock.recomputeAverageCost(t.db, id)).toBe(750_000)

    // Even after being oversold into negative stock (Phase 5 allows it), the typed cost stands...
    sell(t, id, 2 * ONE_UNIT)
    expect(stock.averageCost(t.db, id)).toBe(750_000)
    assertEverythingHolds(t)

    // ...until the first real delivery.
    //
    // This used to expect the average to become exactly Rs 100 — the delivery's own cost. But the
    // shop had ALREADY sold 2 units it did not have, and the books recorded that at the typed
    // Rs 75.00: GL Inventory = −Rs 150.00. The Rs 1,000 delivery takes the GL to Rs 850.00.
    //
    //   average Rs 100    -> 8 x Rs 100    = Rs 800.00   ... Rs 50 short of the ledger
    //   average Rs 106.25 -> 8 x Rs 106.25 = Rs 850.00   ... exactly the ledger
    //
    // The delivery relieves the 2 oversold units at the cost they were carried at, and only the
    // remaining 8 sit at the blended cost. (−2,000 x 750,000 + 10,000 x 1,000,000) / 8,000.
    buy(t, id, TEN_PIECES, RS_100)
    expect(stock.averageCost(t.db, id)).toBe(1_062_500)
    assertEverythingHolds(t)
  })

  /**
   * REGRESSION. The running average is computed incrementally on the sell path (it has to be — a
   * rebuild on every sale would scan years of movements). That shortcut is only valid while movements
   * arrive in chronological order.
   *
   * A BACKDATED movement — the Opening Setup wizard entering last year's opening stock after a month
   * of trading, or a purchase keyed in late — changes history UNDERNEATH the incremental arithmetic.
   * record() detects it and rebuilds. Without that, the cache and the movements would disagree, and
   * only this assertion would ever have told us.
   */
  it('a BACKDATED movement rebuilds the average instead of quietly corrupting it', () => {
    const id = makeProduct(t)

    buy(t, id, TEN_PIECES, RS_120, new Date('2026-07-10T10:00:00Z'))
    expect(stock.averageCost(t.db, id)).toBe(RS_120)

    // Now a delivery from BEFORE that one is keyed in late.
    buy(t, id, TEN_PIECES, RS_100, new Date('2026-07-01T10:00:00Z'))

    // Chronologically: 10 @ 100, then 10 @ 120 -> 110. The order they were TYPED IN must not matter.
    expect(stock.averageCost(t.db, id)).toBe(RS_110)
    assertEverythingHolds(t)
  })

  it('a backdated SALE is rebuilt too — it changes the balance a later purchase blended against', () => {
    const id = makeProduct(t)

    buy(t, id, TEN_PIECES, RS_100, new Date('2026-07-01T10:00:00Z'))
    buy(t, id, TEN_PIECES, RS_120, new Date('2026-07-20T10:00:00Z')) // blended against 10 on the shelf

    // A sale from BETWEEN the two deliveries turns up late: it empties the shelf before the second
    // delivery, so that delivery had nothing to blend against and the average is simply 120.
    sell(t, id, TEN_PIECES, new Date('2026-07-10T10:00:00Z'))

    expect(stock.averageCost(t.db, id)).toBe(RS_120)
    assertEverythingHolds(t)
  })
})

// ── Adjustments: reason, journal, audit ──────────────────────────────────────

describe('stock adjustments — money moves when stock moves', () => {
  let t: TestDb
  let user: User
  beforeEach(() => {
    t = makeTestDb({ withSeed: true })
    user = makeUser(t)
  })
  afterEach(() => t.cleanup())

  it('a WRITE-DOWN (damage) debits Stock Adjustment, credits Inventory — and the books balance', () => {
    const id = makeProduct(t, { name: 'Eggs' })
    buy(t, id, TEN_PIECES, RS_110)

    const result = stock.adjust(t.db, user, {
      productId: id,
      type: 'damage',
      qtyM: -FIVE_PIECES,
      reasonCode: 'damage',
      note: 'Dropped a tray'
    })

    expect(result.onHandM).toBe(FIVE_PIECES)
    expect(result.movement.qtyM).toBe(-FIVE_PIECES)
    expect(result.movement.unitCost).toBe(RS_110) // valued at the average cost
    expect(result.journalId).not.toBeNull()

    // 5 pieces x Rs 110 = Rs 550.00
    expect(ledger.accountBalance(t.db, ACC.STOCK_ADJUSTMENT)).toBe(55_000)
    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(-55_000)

    // A write-off does NOT change what the survivors cost.
    expect(result.avgCost).toBe(RS_110)

    assertEverythingHolds(t)
  })

  it('a WRITE-UP (found stock) is the exact reverse', () => {
    const id = makeProduct(t)
    buy(t, id, TEN_PIECES, RS_100)

    const result = stock.adjust(t.db, user, {
      productId: id,
      type: 'stock_take',
      qtyM: 2 * ONE_UNIT,
      reasonCode: 'stock_take',
      note: 'Counted two more on the top shelf'
    })

    expect(result.onHandM).toBe(12 * ONE_UNIT)
    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(20_000) // Rs 200 of stock appeared
    expect(ledger.accountBalance(t.db, ACC.STOCK_ADJUSTMENT)).toBe(-20_000)

    // Found stock is valued at the average, so blending it back in leaves the average exactly where
    // it was. That is not a coincidence — it is what "valued at the average" means.
    expect(result.avgCost).toBe(RS_100)

    assertEverythingHolds(t)
  })

  it('an OPENING balance posts against Opening Balance Equity — NOT the P&L', () => {
    // Day-one stock is not shrinkage. Posting it to Stock Adjustment would open the shop's first
    // ever P&L with a huge fake loss. (PLAN.md §4 — Opening balances.)
    const id = makeProduct(t)

    const result = stock.adjust(t.db, user, {
      productId: id,
      type: 'opening',
      qtyM: TEN_PIECES,
      unitCost: RS_100, // on day one there is no history to average — the owner states the cost
      reasonCode: 'data_entry'
    })

    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(100_000) // Rs 1,000 of stock
    expect(ledger.accountBalance(t.db, ACC.OPENING_BALANCE_EQUITY)).toBe(100_000)
    expect(ledger.accountBalance(t.db, ACC.STOCK_ADJUSTMENT)).toBe(0) // no fake expense
    expect(result.avgCost).toBe(RS_100)

    assertEverythingHolds(t)
  })

  it('REQUIRES a reason code that is really on the owner’s list', () => {
    const id = makeProduct(t)
    buy(t, id, TEN_PIECES, RS_100)

    expectUserMessage(
      () =>
        stock.adjust(t.db, user, {
          productId: id,
          type: 'adjustment',
          qtyM: -ONE_UNIT,
          reasonCode: 'because_i_said_so' // not on lookups('adjustment_reason')
        }),
      /choose a reason/i
    )

    // Nothing happened. No movement, no journal — an unexplained stock change is not recorded at all.
    expect(stock.onHand(t.db, id)).toBe(TEN_PIECES)
    expect(t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get()).toBe(0)
    assertEverythingHolds(t)
  })

  it('refuses a reason the owner has RETIRED from the list', () => {
    const id = makeProduct(t)
    t.db
      .prepare("UPDATE lookups SET is_active = 0 WHERE list_key = 'adjustment_reason' AND code = 'theft'")
      .run()

    expectUserMessage(
      () =>
        stock.adjust(t.db, user, {
          productId: id,
          type: 'adjustment',
          qtyM: -ONE_UNIT,
          reasonCode: 'theft'
        }),
      /choose a reason/i
    )
  })

  it('writes an AUDIT row: who, what, why, and how much', () => {
    const id = makeProduct(t, { name: 'Whisky-free Shop Item' })
    buy(t, id, TEN_PIECES, RS_100)

    stock.adjust(t.db, user, {
      productId: id,
      type: 'adjustment',
      qtyM: -3 * ONE_UNIT,
      reasonCode: 'theft',
      note: 'Missing from the shelf'
    })

    const row = t.db
      .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 1')
      .get() as Record<string, unknown>

    expect(row['action']).toBe('stock.adjustment')
    expect(row['user_name']).toBe('Meena Manager')
    expect(row['user_role']).toBe('manager') // the role AT THE TIME — copied in, never joined
    expect(row['reason_code']).toBe('theft')
    expect(row['entity_id']).toBe(String(id))

    const before = JSON.parse(row['before_json'] as string)
    const after = JSON.parse(row['after_json'] as string)
    expect(before.onHandM).toBe(TEN_PIECES)
    expect(after.onHandM).toBe(7 * ONE_UNIT)
    expect(after.valueMinor).toBe(30_000) // Rs 300 walked out of the shop

    assertEverythingHolds(t)
  })

  it('a ZERO-VALUE movement posts no journal — there is no money to move', () => {
    // A product that has never been bought has no cost. Its stock adjustment is real, but its
    // accounting entry would be a journal for nothing, and post() would rightly refuse it.
    const id = makeProduct(t, { costPrice: 0 })

    const result = stock.adjust(t.db, user, {
      productId: id,
      type: 'adjustment',
      qtyM: ONE_UNIT,
      reasonCode: 'data_entry'
    })

    expect(result.journalId).toBeNull()
    expect(result.onHandM).toBe(ONE_UNIT) // the STOCK still moved
    expect(t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get()).toBe(0)
    assertEverythingHolds(t)
  })

  it('rolls back EVERYTHING if the period is locked — no movement, no journal, no audit row', () => {
    const owner = makeUser(t, 'owner', 'boss')
    const id = makeProduct(t)
    buy(t, id, TEN_PIECES, RS_100, new Date('2026-06-10T10:00:00Z'))
    ledger.lockPeriod(t.db, 2026, 6, owner.id)

    expect(() =>
      stock.adjust(
        t.db,
        user,
        { productId: id, type: 'damage', qtyM: -ONE_UNIT, reasonCode: 'damage' },
        new Date('2026-06-15T10:00:00Z')
      )
    ).toThrow(/locked/)

    // The movement, the journal and the audit row all land together or not at all.
    expect(stock.onHand(t.db, id)).toBe(TEN_PIECES)
    expect(t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get()).toBe(0)
    expect(t.db.prepare('SELECT COUNT(*) FROM audit_log').pluck().get()).toBe(0)
    assertEverythingHolds(t)
  })

  it('refuses a batch that belongs to a different item', () => {
    const oil = makeProduct(t, { name: 'Oil', trackBatches: true })
    const milk = makeProduct(t, { name: 'Milk', trackBatches: true })
    const milkBatch = makeBatch(t, milk, 'M-1', '2026-08-01')

    expectUserMessage(
      () =>
        stock.adjust(t.db, user, {
          productId: oil,
          type: 'damage',
          qtyM: -ONE_UNIT,
          reasonCode: 'damage',
          batchId: milkBatch
        }),
      /belongs to a different item/i
    )
  })
})

// ── Negative stock: allowed, and visible ─────────────────────────────────────

describe('negative stock — warn, allow, flag (never block)', () => {
  let t: TestDb
  beforeEach(() => (t = makeTestDb({ withSeed: true })))
  afterEach(() => t.cleanup())

  it('wouldGoNegative() sees it coming — BEFORE the sale is committed', () => {
    const id = makeProduct(t)
    buy(t, id, 3 * ONE_UNIT, RS_100)

    // qtyM is the SIGNED movement: selling 6 pieces is −6000.
    expect(stock.wouldGoNegative(t.db, id, -6 * ONE_UNIT)).toBe(true)
    expect(stock.projectedOnHand(t.db, id, -6 * ONE_UNIT)).toBe(-3 * ONE_UNIT)

    expect(stock.wouldGoNegative(t.db, id, -3 * ONE_UNIT)).toBe(false) // exactly empties the shelf
    expect(stock.wouldGoNegative(t.db, id, -ONE_UNIT)).toBe(false)
    expect(stock.wouldGoNegative(t.db, id, ONE_UNIT)).toBe(false) // a delivery cannot go negative
  })

  it('a NON-INVENTORY item can never be oversold — no warning, no flag, no audit noise', () => {
    // The sell path asks this about every line without first checking the item type. If a carrier bag
    // answered "yes, that goes negative", every bag sold would raise a negative-stock warning and an
    // audit row — and the flag that is supposed to mean something would come to mean nothing.
    const bag = makeProduct(t, { name: 'Carrier Bag', itemType: 'non_inventory' })
    expect(stock.wouldGoNegative(t.db, bag, -100 * ONE_UNIT)).toBe(false)
  })

  it('the sale goes through anyway — the customer is holding the goods', () => {
    // A POS that refuses to sell what is physically in the customer's hand is a POS the shop works
    // around. The delivery that has not been keyed in yet is real. So: allow, and show the truth.
    const id = makeProduct(t)
    buy(t, id, 3 * ONE_UNIT, RS_100)

    sell(t, id, 6 * ONE_UNIT)

    expect(stock.onHand(t.db, id)).toBe(-3 * ONE_UNIT)
    expect(stock.stockLevel(t.db, id).onHandM).toBe(-3 * ONE_UNIT)
    expect(formatQty(stock.onHand(t.db, id))).toBe('-3') // the list shows it as negative, not as 0

    // Negative stock is worth negative money — that is the whole point of showing it.
    expect(stock.stockLevel(t.db, id).stockValueMinor).toBe(-30_000)

    assertEverythingHolds(t)
  })

  it('the delivery that turns up next RELIEVES the negative at the cost the books carried it at', () => {
    const id = makeProduct(t)
    buy(t, id, 3 * ONE_UNIT, RS_100)
    sell(t, id, 6 * ONE_UNIT) // oversold to −3

    buy(t, id, TEN_PIECES, RS_120)

    expect(stock.onHand(t.db, id)).toBe(7 * ONE_UNIT)

    // This test used to expect the average to RESET to Rs 120 ("the new stock costs what it cost").
    // That was wrong, and it quietly destroyed money. Check it against the ledger:
    //
    //   buy 3 @ Rs 100   -> Inventory  +Rs 300
    //   sell 6 @ Rs 100  -> Inventory  −Rs 600   (GL now −Rs 300, and it KNOWS the stock is −3)
    //   buy 10 @ Rs 120  -> Inventory +Rs 1,200  (GL now  Rs 900)
    //
    //   reset to Rs 120  -> 7 x Rs 120      = Rs 840   ... Rs 60 SHORT of the ledger
    //   blend through    -> 7 x Rs 128.5714 = Rs 900   ... exactly the ledger
    //
    // The negative stock was already carried on the books at Rs 100; the delivery relieves it at
    // that cost, and only the surplus arrives at Rs 120. (−3,000 x 1,000,000 + 10,000 x 1,200,000)
    // / 7,000 = 1,285,714.
    expect(stock.averageCost(t.db, id)).toBe(1_285_714)
    assertEverythingHolds(t)
  })
})

// ── Weighed goods ────────────────────────────────────────────────────────────

describe('weighed goods — kg to the gram, with no floats anywhere', () => {
  let t: TestDb
  beforeEach(() => (t = makeTestDb({ withSeed: true })))
  afterEach(() => t.cleanup())

  it('1.234 kg is exact, and stays exact after a hundred sales', () => {
    const id = makeProduct(t, { name: 'Basmati Rice', uom: 'kg', isWeighted: true })

    // 10.5 kg delivered at Rs 200.00 / kg
    buy(t, id, 10_500, 2_000_000)
    expect(formatQty(stock.onHand(t.db, id))).toBe('10.5')

    sell(t, id, 1_234) // 1.234 kg
    expect(stock.onHand(t.db, id)).toBe(9_266)
    expect(formatQty(stock.onHand(t.db, id))).toBe('9.266')

    // A hundred 12-gram sales. In floats this is exactly where the drift would show up.
    for (let i = 0; i < 100; i++) sell(t, id, 12)
    expect(stock.onHand(t.db, id)).toBe(9_266 - 1_200)
    expect(formatQty(stock.onHand(t.db, id))).toBe('8.066')

    expect(stock.averageCost(t.db, id)).toBe(2_000_000) // sales never move the average
    assertEverythingHolds(t)
  })

  it('averages two deliveries of rice at different prices per kg', () => {
    const id = makeProduct(t, { name: 'Rice', uom: 'kg', isWeighted: true })

    buy(t, id, 10_000, 2_000_000) // 10 kg @ Rs 200
    buy(t, id, 5_000, 2_300_000) //  5 kg @ Rs 230
    // (10 x 200 + 5 x 230) / 15 = 3150/15 = Rs 210.0000
    expect(stock.averageCost(t.db, id)).toBe(2_100_000)
    expect(formatCost(stock.averageCost(t.db, id))).toBe('210.0000')

    // 15 kg @ Rs 210 = Rs 3,150.00
    expect(formatMoney(stock.stockLevel(t.db, id).stockValueMinor)).toBe('3,150.00')
    assertEverythingHolds(t)
  })
})

// ── Lists ────────────────────────────────────────────────────────────────────

describe('stock levels, low stock and near expiry', () => {
  let t: TestDb
  beforeEach(() => (t = makeTestDb({ withSeed: true })))
  afterEach(() => t.cleanup())

  it('lists levels with on-hand, re-order level and value — paginated', () => {
    for (let i = 0; i < 25; i++) {
      const id = makeProduct(t, { sku: `P-${String(i).padStart(3, '0')}`, name: `Item ${i}` })
      buy(t, id, (i + 1) * ONE_UNIT, RS_100)
    }

    const page1 = stock.stockLevels(t.db, { page: 1, pageSize: 10 })
    expect(page1.total).toBe(25)
    expect(page1.rows).toHaveLength(10)
    expect(page1.rows[0]!.name).toBe('Item 0')
    expect(page1.rows[0]!.onHandM).toBe(ONE_UNIT)
    expect(page1.rows[0]!.stockValueMinor).toBe(10_000) // 1 x Rs 100

    const page3 = stock.stockLevels(t.db, { page: 3, pageSize: 10 })
    expect(page3.rows).toHaveLength(5)

    assertEverythingHolds(t)
  })

  it('LOW STOCK is on-hand <= re-order level, and the flag agrees with the list', () => {
    const low = makeProduct(t, { name: 'Sugar', minStockM: 10 * ONE_UNIT })
    const plenty = makeProduct(t, { name: 'Salt', minStockM: 5 * ONE_UNIT })
    const exactly = makeProduct(t, { name: 'Tea', minStockM: 4 * ONE_UNIT })

    buy(t, low, 4 * ONE_UNIT, RS_100) // 4 <= 10  -> reorder
    buy(t, plenty, 50 * ONE_UNIT, RS_100) // 50 > 5 -> fine
    buy(t, exactly, 4 * ONE_UNIT, RS_100) // 4 <= 4  -> reorder (at the level counts as at it)

    const rows = stock.lowStock(t.db).rows
    expect(rows.map((r) => r.name).sort()).toEqual(['Sugar', 'Tea'])
    expect(rows.every((r) => r.isBelowReorder)).toBe(true)

    // The flag on the full list can never disagree with membership of the low-stock list — one
    // predicate, one SQL path.
    const all = stock.stockLevels(t.db).rows
    expect(all.filter((r) => r.isBelowReorder).map((r) => r.name).sort()).toEqual(['Sugar', 'Tea'])

    assertEverythingHolds(t)
  })

  it('an oversold item is ALWAYS below its re-order level', () => {
    const id = makeProduct(t, { name: 'Oversold', minStockM: 0 })
    buy(t, id, ONE_UNIT, RS_100)
    sell(t, id, 3 * ONE_UNIT)

    expect(stock.lowStock(t.db).rows.map((r) => r.name)).toContain('Oversold')
  })

  it('NON-INVENTORY items never appear on a stock report', () => {
    makeProduct(t, { name: 'Delivery Charge', itemType: 'non_inventory' })
    const real = makeProduct(t, { name: 'Real Item' })
    buy(t, real, ONE_UNIT, RS_100)

    const rows = stock.stockLevels(t.db).rows
    expect(rows.map((r) => r.name)).toEqual(['Real Item'])
  })

  it('on-hand BY BATCH, oldest expiry first — the order FEFO will pick in', () => {
    const id = makeProduct(t, { name: 'Yoghurt', trackBatches: true })
    const older = makeBatch(t, id, 'B-OLD', '2026-08-01', RS_100)
    const newer = makeBatch(t, id, 'B-NEW', '2026-12-01', RS_120)

    stock.record(t.db, { productId: id, type: 'purchase', qtyM: TEN_PIECES, unitCost: RS_100, batchId: older })
    stock.record(t.db, { productId: id, type: 'purchase', qtyM: 20 * ONE_UNIT, unitCost: RS_120, batchId: newer })
    stock.record(t.db, { productId: id, type: 'sale', qtyM: -4 * ONE_UNIT, batchId: older })

    const batches = stock.onHandByBatch(t.db, id)
    expect(batches.map((b) => b.batchNo)).toEqual(['B-OLD', 'B-NEW']) // soonest to expire, first
    expect(batches[0]!.onHandM).toBe(6 * ONE_UNIT)
    expect(batches[1]!.onHandM).toBe(20 * ONE_UNIT)

    // The batches add up to the product's own derived total.
    expect(batches.reduce((sum, b) => sum + b.onHandM, 0)).toBe(stock.onHand(t.db, id))
    assertEverythingHolds(t)
  })

  it('NEAR EXPIRY lists what is about to be thrown away — expired first, sold-out batches never', () => {
    const asOf = new Date('2026-07-14T00:00:00Z')
    const id = makeProduct(t, { name: 'Milk', trackBatches: true })

    const soon = makeBatch(t, id, 'B-SOON', '2026-07-20', RS_100) // 6 days away
    const gone = makeBatch(t, id, 'B-GONE', '2026-06-01', RS_100) // already expired
    const later = makeBatch(t, id, 'B-LATER', '2027-01-01', RS_100) // not our problem yet
    const soldOut = makeBatch(t, id, 'B-SOLD', '2026-07-15', RS_100) // expires tomorrow, none left

    for (const batchId of [soon, gone, later, soldOut]) {
      stock.record(t.db, { productId: id, type: 'purchase', qtyM: TEN_PIECES, unitCost: RS_100, batchId })
    }
    stock.record(t.db, { productId: id, type: 'sale', qtyM: -TEN_PIECES, batchId: soldOut }) // all sold

    const result = stock.nearExpiry(t.db, { days: 30, asOf })

    expect(result.rows.map((r) => r.batchNo)).toEqual(['B-GONE', 'B-SOON'])

    const expired = result.rows[0]!
    expect(expired.expired).toBe(true)
    expect(expired.daysToExpiry).toBe(-43)
    expect(expired.onHandM).toBe(TEN_PIECES)
    expect(expired.valueMinor).toBe(100_000) // Rs 1,000 about to be binned

    const soonRow = result.rows[1]!
    expect(soonRow.expired).toBe(false)
    expect(soonRow.daysToExpiry).toBe(6)

    assertEverythingHolds(t)
  })

  /**
   * REGRESSION (Phase 4b). The near-expiry report valued a batch as round(on_hand x cost) — the
   * round-of-sum that migration 0006 exists to abolish — while the ledger posts, and the stock report
   * now sums, the value each movement FROZE when it happened.
   *
   * Two receipts of 3 pcs at Rs 91.0417 into one batch:
   *
   *     GL Inventory / stock report = round(3 x 91.0417) x 2 = 273.13 + 273.13 = Rs 546.26
   *     near-expiry (before)        = round(6 x 91.0417)                       = Rs 546.25
   *
   * A paisa of stock that the books carry and the report denies. It compounds with every receipt, and
   * every journal stays internally balanced — so the trial balance never notices. The report must read
   * the same frozen numbers as everything else.
   */
  it('NEAR EXPIRY values a batch from the movements, not round(on_hand x cost) — GL and report agree', () => {
    const asOf = new Date('2026-07-14T00:00:00Z')
    const RS_91_0417 = parseCost('91.0417') as number // 910_417 — the 4-dp cost, exactly
    const THREE_PIECES = 3 * ONE_UNIT

    const id = makeProduct(t, { name: 'Panadol', trackBatches: true })
    const batch = makeBatch(t, id, 'B-1', '2026-07-20', RS_91_0417)

    // TWO receipts into the SAME batch. One would round identically; two is where the drift appears.
    stock.record(t.db, { productId: id, type: 'opening', qtyM: THREE_PIECES, unitCost: RS_91_0417, batchId: batch })
    stock.record(t.db, { productId: id, type: 'opening', qtyM: THREE_PIECES, unitCost: RS_91_0417, batchId: batch })

    const frozen = t.db
      .prepare('SELECT COALESCE(SUM(value_minor), 0) FROM stock_movements WHERE batch_id = ?')
      .pluck()
      .get(batch) as number

    expect(frozen).toBe(54_626) // Rs 546.26 — 273.13 twice, as each movement froze it

    const row = stock.nearExpiry(t.db, { days: 30, asOf }).rows[0]!
    expect(row.onHandM).toBe(6 * ONE_UNIT)

    // The report reads the frozen value, NOT round(6 x 91.0417) = 54_625.
    expect(row.valueMinor).toBe(frozen)

    // And it is the same number the whole-product stock report shows, for the same stock.
    expect(stock.stockLevel(t.db, id).stockValueMinor).toBe(frozen)

    assertEverythingHolds(t)
  })

  it('the item’s history reads back in full', () => {
    const id = makeProduct(t)
    const user = makeUser(t)

    buy(t, id, TEN_PIECES, RS_100)
    sell(t, id, 2 * ONE_UNIT)
    stock.adjust(t.db, user, {
      productId: id,
      type: 'damage',
      qtyM: -ONE_UNIT,
      reasonCode: 'damage'
    })

    const history = stock.listMovements(t.db, { productId: id })
    expect(history.total).toBe(3)
    expect(history.rows.map((m) => m.type)).toEqual(['damage', 'sale', 'purchase']) // newest first

    const damage = history.rows[0]!
    expect(damage.reasonCode).toBe('damage')
    expect(damage.userName).toBe('Meena Manager') // who did it
    expect(damage.qtyM).toBe(-ONE_UNIT)

    // Filtering by type is how the leakage reports are built.
    expect(stock.listMovements(t.db, { productId: id, type: 'sale' }).total).toBe(1)
    assertEverythingHolds(t)
  })
})

// ── A day in the shop ────────────────────────────────────────────────────────

describe('a whole day of stock, end to end', () => {
  let t: TestDb
  beforeEach(() => (t = makeTestDb({ withSeed: true })))
  afterEach(() => t.cleanup())

  it('opening stock, deliveries, sales, damage and a stock take — and everything still adds up', () => {
    const user = makeUser(t)
    const oil = makeProduct(t, { name: 'Cooking Oil', minStockM: 5 * ONE_UNIT })
    const rice = makeProduct(t, { name: 'Rice', uom: 'kg', isWeighted: true })

    // Day one: the stock the shop already had.
    stock.adjust(t.db, user, {
      productId: oil,
      type: 'opening',
      qtyM: 20 * ONE_UNIT,
      unitCost: RS_100,
      reasonCode: 'data_entry'
    })
    stock.adjust(t.db, user, {
      productId: rice,
      type: 'opening',
      qtyM: 50_000, // 50 kg
      unitCost: 2_000_000, // Rs 200 / kg
      reasonCode: 'data_entry'
    })

    // A delivery at a higher price re-averages the oil: (20x100 + 10x120)/30 = Rs 106.6667
    buy(t, oil, TEN_PIECES, RS_120)
    expect(stock.averageCost(t.db, oil)).toBe(1_066_667)

    // A day of selling.
    for (let i = 0; i < 12; i++) sell(t, oil, ONE_UNIT)
    for (let i = 0; i < 30; i++) sell(t, rice, 1_500) // 1.5 kg at a time

    // A bottle smashed.
    stock.adjust(t.db, user, {
      productId: oil,
      type: 'damage',
      qtyM: -ONE_UNIT,
      reasonCode: 'damage',
      note: 'Smashed on the floor'
    })

    // And the stock take at close of play found one bottle fewer than the system thought.
    stock.adjust(t.db, user, {
      productId: oil,
      type: 'stock_take',
      qtyM: -ONE_UNIT,
      reasonCode: 'stock_take'
    })

    expect(stock.onHand(t.db, oil)).toBe(16 * ONE_UNIT) // 20 + 10 − 12 − 1 − 1
    expect(stock.onHand(t.db, rice)).toBe(5_000) // 50 kg − 45 kg
    expect(stock.averageCost(t.db, oil)).toBe(1_066_667) // sales and write-offs never move it

    // Rice is down to 5 kg with no re-order level set, so it shows on the reorder report (0 >= ... no:
    // 5000 > 0), while the oil is comfortably above its level of 5.
    expect(stock.lowStock(t.db).rows).toHaveLength(0)

    // THE TWO THINGS THAT MATTER, one last time: the cache tells the truth, and the books balance.
    assertEverythingHolds(t)
  })
})
