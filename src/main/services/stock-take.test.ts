import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import * as stockTake from './stock-take'
import * as stock from './stock'
import * as ledger from './ledger'
import { ACC } from '../db/chart-of-accounts'
import { ONE_UNIT } from '@shared/qty'
import type { User } from '@shared/types'

/**
 * THE STOCK TAKE — the counting sheet.
 *
 * WHAT IS BEING DEFENDED HERE, and everything else is scaffolding:
 *
 *   1. AFTER APPLY, ON-HAND IS WHAT WAS COUNTED. That is the entire point of the document. If this
 *      fails, the shop counted its shelves for nothing.
 *   2. THE BOOKS STILL BALANCE, and GL Inventory still equals SUM(stock_movements.value_minor). The
 *      sheet posts through `stock.adjust` precisely so this cannot break — these tests prove it did
 *      not quietly grow a second path.
 *   3. THE VARIANCE IS FROZEN AT COUNTING TIME. A sale between the count and the apply does NOT erase
 *      the finding. This is the subtle one, and it is asserted by name below.
 */

// ── The standing assertions, run after every scenario ────────────────────────

/** THE STANDING TEST from CLAUDE.md §4: after every scenario, the trial balance balances. */
function assertBooksBalance(t: TestDb): void {
  const tb = ledger.trialBalance(t.db)
  expect(tb.balanced, 'the trial balance no longer balances').toBe(true)
}

/**
 * THE LEDGER AND THE SHELF AGREE: GL Inventory === SUM of every movement's own frozen value.
 *
 * This is the assertion that would catch a stock take that posted its own journal, or valued a
 * movement differently from the way it booked it. They are equal BY CONSTRUCTION — both come from
 * `stock.movementValueMinor` — and this proves the construction was not bypassed.
 */
function assertInventoryMatchesMovements(t: TestDb): void {
  const gl = ledger.accountBalance(t.db, ACC.INVENTORY)
  const movements = t.db
    .prepare('SELECT COALESCE(SUM(value_minor), 0) FROM stock_movements')
    .pluck()
    .get() as number

  expect(gl, 'GL Inventory has drifted from the stock movements').toBe(movements)
}

/** The cached average never lies — the same standing assertion stock.test.ts runs. */
function assertAverageCostIsHonest(t: TestDb): void {
  const ids = t.db.prepare('SELECT id FROM products').pluck().all() as number[]
  for (const id of ids) {
    const stored = t.db.prepare('SELECT cost_price FROM products WHERE id = ?').pluck().get(id)
    expect(stored, `product ${id}: stored average has drifted from the movements`).toBe(
      stock.recomputeAverageCost(t.db, id)
    )
  }
}

function assertEverythingHolds(t: TestDb): void {
  assertBooksBalance(t)
  assertInventoryMatchesMovements(t)
  assertAverageCostIsHonest(t)
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const RS_100 = 1_000_000 // 4-dp cost
const TEN_PIECES = 10 * ONE_UNIT

function uomId(t: TestDb, code = 'pcs'): number {
  return t.db
    .prepare("SELECT id FROM lookups WHERE list_key = 'uom' AND code = ?")
    .pluck()
    .get(code) as number
}

function makeProduct(
  t: TestDb,
  options: { name?: string; sku?: string; itemType?: 'inventory' | 'non_inventory' } = {}
): number {
  const now = new Date().toISOString()
  return Number(
    t.db
      .prepare(
        `INSERT INTO products
           (sku, name, sale_uom_id, cost_price, retail_price, min_stock_m,
            item_type, track_batches, is_weighted, is_active, created_at, updated_at)
         VALUES (@sku, @name, @uomId, 0, 15000, 0, @itemType, 0, 0, 1, @now, @now)`
      )
      .run({
        sku: options.sku ?? `SKU-${Math.random().toString(36).slice(2, 10)}`,
        name: options.name ?? 'Tea 250g',
        uomId: uomId(t),
        itemType: options.itemType ?? 'inventory',
        now
      }).lastInsertRowid
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
  // The DOMAIN object, not the raw row: the audit log reads `fullName`, and a snake_case row would
  // hand it undefined. (Same shape stock.test.ts builds.)
  return {
    id,
    username,
    fullName: 'Meena Manager',
    role: role as User['role'],
    hasPin: false,
    isActive: true
  }
}

/**
 * PUT STOCK ON THE SHELF, WITH ITS ACCOUNTING.
 *
 * Via `stock.adjust('opening')`, NOT a bare `stock.record`. `record()` deliberately posts no journal —
 * a real purchase owns its own accounting and posts DR Inventory itself (services/purchases.ts). A
 * fixture that used `record()` would put stock on the shelf that the ledger never paid for, and then
 * `assertInventoryMatchesMovements` would fail on the fixture rather than on anything the stock take
 * did. An opening balance posts DR Inventory / CR Opening Balance Equity, which is exactly the honest
 * way stock gets onto a shelf with the books agreeing.
 */
function receive(t: TestDb, productId: number, qtyM: number, unitCost = RS_100): void {
  stock.adjust(t.db, manager, {
    productId,
    type: 'opening',
    qtyM,
    unitCost,
    reasonCode: 'data_entry'
  })
}

/**
 * SELL STOCK OUT — the movement only, exactly as `sales.complete` does it for the stock leg.
 *
 * NO journal here on purpose: a real sale posts its own (revenue, tax, COGS) and calls `record()` for
 * the stock leg alone. That means the GL-vs-movements assertion cannot be run after one of these — a
 * sale's COGS leg is the sale document's job, not this file's. Every test that sells is asserting what
 * the STOCK TAKE did to on-hand and to the sheet, and says so.
 */
function sell(t: TestDb, productId: number, qtyM: number): void {
  stock.record(t.db, { productId, type: 'sale', qtyM: -qtyM, refType: 'sale', refId: 9 })
}

let t: TestDb
let manager: User

beforeEach(() => {
  t = makeTestDb({ withSeed: true })
  manager = makeUser(t)
})

afterEach(() => {
  t.cleanup()
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE WHOLE POINT: count the shelf, apply, and the books say what the counter saw
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('applying a stock take', () => {
  it('THE WHOLE POINT: after apply, on-hand is exactly what was counted', () => {
    const tea = makeProduct(t, { name: 'Tea 250g' })
    receive(t, tea, TEN_PIECES) // the books say 10

    const sheet = stockTake.create(t.db, manager, { note: 'Monthly count' })
    // The counter walks the shelf and finds 8. Two tins have walked out of the shop.
    stockTake.setCount(t.db, manager, {
      stockTakeId: sheet.id,
      productId: tea,
      countedQtyM: 8 * ONE_UNIT
    })

    stockTake.apply(t.db, manager, { stockTakeId: sheet.id })

    expect(stock.onHand(t.db, tea)).toBe(8 * ONE_UNIT)
    assertEverythingHolds(t)
  })

  it('posts ONE stock.adjust per varying line — and the movement is a stock_take with a reason', () => {
    const tea = makeProduct(t)
    receive(t, tea, TEN_PIECES)

    const sheet = stockTake.create(t.db, manager)
    stockTake.setCount(t.db, manager, {
      stockTakeId: sheet.id,
      productId: tea,
      countedQtyM: 8 * ONE_UNIT
    })
    const result = stockTake.apply(t.db, manager, { stockTakeId: sheet.id })

    expect(result.movementsPosted).toBe(1)

    const movement = t.db
      .prepare("SELECT * FROM stock_movements WHERE type = 'stock_take'")
      .get() as { qty_m: number; reason_code: string; user_id: number; value_minor: number }

    // The movement is the VARIANCE — counted (8) minus expected (10) — not the counted figure.
    expect(movement.qty_m).toBe(-2 * ONE_UNIT)
    expect(movement.reason_code).toBe('stock_take')
    expect(movement.user_id).toBe(manager.id) // WHO counted it is frozen onto the movement
    assertEverythingHolds(t)
  })

  it('the write-off lands in Stock Adjustment, and the trial balance still balances', () => {
    const tea = makeProduct(t)
    receive(t, tea, TEN_PIECES) // 10 @ Rs 100 = Rs 1,000 of inventory

    const sheet = stockTake.create(t.db, manager)
    stockTake.setCount(t.db, manager, {
      stockTakeId: sheet.id,
      productId: tea,
      countedQtyM: 8 * ONE_UNIT
    })
    const result = stockTake.apply(t.db, manager, { stockTakeId: sheet.id })

    // Two tins at Rs 100 = Rs 200 written off. Negative: the shop is missing stock.
    expect(result.varianceValueMinor).toBe(-20_000)
    // DR Stock Adjustment Rs 200 / CR Inventory Rs 200 — the expense of the loss.
    expect(ledger.accountBalance(t.db, ACC.STOCK_ADJUSTMENT)).toBe(20_000)
    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(80_000) // Rs 800 left
    assertEverythingHolds(t)
  })

  it('a count HIGHER than the books writes stock UP', () => {
    const tea = makeProduct(t)
    receive(t, tea, TEN_PIECES)

    const sheet = stockTake.create(t.db, manager)
    // 12 on the shelf against 10 on the books — a delivery that was never keyed in.
    stockTake.setCount(t.db, manager, {
      stockTakeId: sheet.id,
      productId: tea,
      countedQtyM: 12 * ONE_UNIT
    })
    const result = stockTake.apply(t.db, manager, { stockTakeId: sheet.id })

    expect(stock.onHand(t.db, tea)).toBe(12 * ONE_UNIT)
    expect(result.varianceValueMinor).toBe(20_000) // POSITIVE — the shop found stock
    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(120_000)
    assertEverythingHolds(t)
  })

  it('an empty shelf counted as 0 is a finding, not a no-op', () => {
    const tea = makeProduct(t)
    receive(t, tea, TEN_PIECES)

    const sheet = stockTake.create(t.db, manager)
    stockTake.setCount(t.db, manager, { stockTakeId: sheet.id, productId: tea, countedQtyM: 0 })
    stockTake.apply(t.db, manager, { stockTakeId: sheet.id })

    expect(stock.onHand(t.db, tea)).toBe(0)
    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(0)
    assertEverythingHolds(t)
  })

  it('counts a WEIGHED item exactly — 1.234 kg is 1234, never a float', () => {
    const rice = makeProduct(t, { name: 'Rice (loose)' })
    receive(t, rice, 5_000) // 5.000 kg on the books

    const sheet = stockTake.create(t.db, manager)
    // The scale says 4.750 kg. A quarter kilo has gone.
    stockTake.setCount(t.db, manager, { stockTakeId: sheet.id, productId: rice, countedQtyM: 4_750 })
    stockTake.apply(t.db, manager, { stockTakeId: sheet.id })

    expect(stock.onHand(t.db, rice)).toBe(4_750)
    assertEverythingHolds(t)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// A ZERO-VARIANCE LINE POSTS NOTHING
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('a line that found the books already correct', () => {
  it('posts NOTHING — no movement, no journal', () => {
    const tea = makeProduct(t)
    receive(t, tea, TEN_PIECES)

    const journalsBefore = t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get() as number
    const movementsBefore = t.db
      .prepare('SELECT COUNT(*) FROM stock_movements')
      .pluck()
      .get() as number

    const sheet = stockTake.create(t.db, manager)
    // Counted 10. The books said 10. Nothing happened, so nothing is recorded.
    stockTake.setCount(t.db, manager, {
      stockTakeId: sheet.id,
      productId: tea,
      countedQtyM: TEN_PIECES
    })
    const result = stockTake.apply(t.db, manager, { stockTakeId: sheet.id })

    expect(result.movementsPosted).toBe(0)
    expect(result.varianceValueMinor).toBe(0)
    expect(t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get()).toBe(journalsBefore)
    expect(t.db.prepare('SELECT COUNT(*) FROM stock_movements').pluck().get()).toBe(movementsBefore)
    assertEverythingHolds(t)
  })

  it('but the line STAYS on the sheet — "we counted it and it was right" is a finding', () => {
    const tea = makeProduct(t)
    receive(t, tea, TEN_PIECES)

    const sheet = stockTake.create(t.db, manager)
    stockTake.setCount(t.db, manager, {
      stockTakeId: sheet.id,
      productId: tea,
      countedQtyM: TEN_PIECES
    })
    stockTake.apply(t.db, manager, { stockTakeId: sheet.id })

    const applied = stockTake.get(t.db, { stockTakeId: sheet.id })
    expect(applied.lines).toHaveLength(1)
    expect(applied.lines[0]?.varianceQtyM).toBe(0)
    // No movement, and the NULL says so honestly.
    expect(applied.lines[0]?.movementId).toBeNull()
  })

  it('a sheet where everything was correct still applies — it just moves nothing', () => {
    const tea = makeProduct(t)
    const rice = makeProduct(t, { name: 'Rice' })
    receive(t, tea, TEN_PIECES)
    receive(t, rice, 5_000)

    const sheet = stockTake.create(t.db, manager)
    stockTake.addLines(t.db, manager, {
      stockTakeId: sheet.id,
      lines: [
        { productId: tea, countedQtyM: TEN_PIECES },
        { productId: rice, countedQtyM: 5_000 }
      ]
    })
    const result = stockTake.apply(t.db, manager, { stockTakeId: sheet.id })

    expect(result.movementsPosted).toBe(0)
    expect(stockTake.get(t.db, { stockTakeId: sheet.id }).status).toBe('applied')
    assertEverythingHolds(t)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// APPLYING TWICE IS REFUSED
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('applying twice', () => {
  it('IS REFUSED — with a sentence a shopkeeper can act on, not a stack trace', () => {
    const tea = makeProduct(t)
    receive(t, tea, TEN_PIECES)

    const sheet = stockTake.create(t.db, manager)
    stockTake.setCount(t.db, manager, {
      stockTakeId: sheet.id,
      productId: tea,
      countedQtyM: 8 * ONE_UNIT
    })
    stockTake.apply(t.db, manager, { stockTakeId: sheet.id })

    expectUserMessage(
      () => stockTake.apply(t.db, manager, { stockTakeId: sheet.id }),
      /already been applied/i
    )
  })

  it('and the second attempt moves NOTHING — the shelf is not corrected twice', () => {
    const tea = makeProduct(t)
    receive(t, tea, TEN_PIECES)

    const sheet = stockTake.create(t.db, manager)
    stockTake.setCount(t.db, manager, {
      stockTakeId: sheet.id,
      productId: tea,
      countedQtyM: 8 * ONE_UNIT
    })
    stockTake.apply(t.db, manager, { stockTakeId: sheet.id })

    expect(() => stockTake.apply(t.db, manager, { stockTakeId: sheet.id })).toThrow()

    // Still 8 — not 6, which is what a second −2 correction would have left.
    expect(stock.onHand(t.db, tea)).toBe(8 * ONE_UNIT)
    expect(
      t.db.prepare("SELECT COUNT(*) FROM stock_movements WHERE type = 'stock_take'").pluck().get()
    ).toBe(1)
    assertEverythingHolds(t)
  })

  it('an applied sheet cannot be counted into — it is history', () => {
    const tea = makeProduct(t)
    receive(t, tea, TEN_PIECES)

    const sheet = stockTake.create(t.db, manager)
    stockTake.setCount(t.db, manager, {
      stockTakeId: sheet.id,
      productId: tea,
      countedQtyM: 8 * ONE_UNIT
    })
    stockTake.apply(t.db, manager, { stockTakeId: sheet.id })

    expectUserMessage(
      () =>
        stockTake.setCount(t.db, manager, {
          stockTakeId: sheet.id,
          productId: tea,
          countedQtyM: 9 * ONE_UNIT
        }),
      /already been applied/i
    )
  })
})

/**
 * After a fixture `sell()`, GL Inventory CANNOT equal SUM(movements): the fixture posts the sale's
 * stock leg without the COGS journal a real sale would post alongside it (see `sell`). So these
 * scenarios assert the two things the STOCK TAKE is actually responsible for — the books still
 * balance, and the cached average still matches the movements.
 */
function assertHoldsAfterSale(t: TestDb): void {
  assertBooksBalance(t)
  assertAverageCostIsHonest(t)
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE SUBTLE ONE: stock that moves BETWEEN counting and applying
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('when stock changes between counting and applying', () => {
  /**
   * THE DECISION, DOCUMENTED AND TESTED (migration 0019 + the service header):
   *
   *   THE COUNT WINS AT THE MOMENT OF COUNTING. THE VARIANCE IS HISTORY, AND IS APPLIED AS HISTORY.
   *
   * The sheet corrects THE DRIFT THE BOOKS COULD NOT SEE — the tins that walked. It is not a command
   * to force the shelf back to a number that was true two hours ago. A sale made after the count is
   * real and stays sold.
   */
  it('the sheet posts the variance FROZEN AT COUNT TIME — a later sale is not undone', () => {
    const tea = makeProduct(t)
    receive(t, tea, TEN_PIECES) // books: 10

    const sheet = stockTake.create(t.db, manager)
    // 9am: the counter finds 8. Two tins are missing — a real finding.
    stockTake.setCount(t.db, manager, {
      stockTakeId: sheet.id,
      productId: tea,
      countedQtyM: 8 * ONE_UNIT
    })

    // 10am: the shop legitimately sells 3 more. Books: 7.
    sell(t, tea, 3 * ONE_UNIT)
    expect(stock.onHand(t.db, tea)).toBe(7 * ONE_UNIT)

    // 11am: apply. The correction is −2 (the finding), applied ON TOP of the sale.
    const result = stockTake.apply(t.db, manager, { stockTakeId: sheet.id })

    expect(result.movementsPosted).toBe(1)
    // 7 − 2 = 5. NOT 8: forcing it to 8 would silently un-sell three real tins.
    expect(stock.onHand(t.db, tea)).toBe(5 * ONE_UNIT)
    assertHoldsAfterSale(t)
  })

  it('THE FINDING SURVIVES: the variance is NOT recomputed at apply time, so a theft cannot erase itself', () => {
    const tea = makeProduct(t)
    receive(t, tea, TEN_PIECES)

    const sheet = stockTake.create(t.db, manager)
    stockTake.setCount(t.db, manager, {
      stockTakeId: sheet.id,
      productId: tea,
      countedQtyM: 8 * ONE_UNIT
    })

    // The books "catch up" to the count by other means before anyone presses Apply. If expected were
    // recomputed now, it would read 8, the variance would come out 0, and the two missing tins would
    // VANISH FROM THE REPORT — the theft erasing its own evidence just by someone taking their time.
    sell(t, tea, 2 * ONE_UNIT)

    stockTake.apply(t.db, manager, { stockTakeId: sheet.id })

    const applied = stockTake.get(t.db, { stockTakeId: sheet.id })
    // The sheet STILL reports what was found: expected 10, counted 8, variance −2, worth −Rs 200.
    expect(applied.lines[0]?.expectedQtyM).toBe(TEN_PIECES)
    expect(applied.lines[0]?.countedQtyM).toBe(8 * ONE_UNIT)
    expect(applied.lines[0]?.varianceQtyM).toBe(-2 * ONE_UNIT)
    expect(applied.varianceValueMinor).toBe(-20_000)
    assertHoldsAfterSale(t)
  })

  it('re-counting RE-freezes what the books expect at the new instant', () => {
    const tea = makeProduct(t)
    receive(t, tea, TEN_PIECES)

    const sheet = stockTake.create(t.db, manager)
    stockTake.setCount(t.db, manager, {
      stockTakeId: sheet.id,
      productId: tea,
      countedQtyM: 8 * ONE_UNIT
    })

    sell(t, tea, 3 * ONE_UNIT)

    // The counter goes back to the shelf and counts again: 7 against books that now say 7.
    const line = stockTake.setCount(t.db, manager, {
      stockTakeId: sheet.id,
      productId: tea,
      countedQtyM: 7 * ONE_UNIT
    })

    // The finding is against NOW's books — the counter is standing at the shelf now.
    expect(line.expectedQtyM).toBe(7 * ONE_UNIT)
    expect(line.varianceQtyM).toBe(0)
    // And there is still only ONE line: a re-count is a correction, not a second opinion.
    expect(stockTake.get(t.db, { stockTakeId: sheet.id }).lines).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE SHEET ITSELF
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('the sheet', () => {
  it('freezes the product name — a rename does not rewrite what was counted', () => {
    const tea = makeProduct(t, { name: 'Tea 250g' })
    receive(t, tea, TEN_PIECES)

    const sheet = stockTake.create(t.db, manager)
    stockTake.setCount(t.db, manager, {
      stockTakeId: sheet.id,
      productId: tea,
      countedQtyM: 8 * ONE_UNIT
    })

    t.db.prepare('UPDATE products SET name = ? WHERE id = ?').run('Tea 250g (OLD PACK)', tea)

    expect(stockTake.get(t.db, { stockTakeId: sheet.id }).lines[0]?.nameSnapshot).toBe('Tea 250g')
  })

  it('refuses a non-stocked item AT COUNTING TIME, not at apply time', () => {
    // Finding out at apply that one line of fifty cannot post would strand the counter with a sheet
    // that will not go through and no idea which line is to blame.
    const bag = makeProduct(t, { name: 'Carrier bag', itemType: 'non_inventory' })
    const sheet = stockTake.create(t.db, manager)

    expectUserMessage(
      () =>
        stockTake.setCount(t.db, manager, {
          stockTakeId: sheet.id,
          productId: bag,
          countedQtyM: ONE_UNIT
        }),
      /not a stocked item/i
    )
  })

  it('refuses a negative count — you cannot count minus three tins', () => {
    const tea = makeProduct(t)
    const sheet = stockTake.create(t.db, manager)

    expectUserMessage(
      () =>
        stockTake.setCount(t.db, manager, {
          stockTakeId: sheet.id,
          productId: tea,
          countedQtyM: -3 * ONE_UNIT
        }),
      /cannot be negative/i
    )
  })

  it('refuses to apply a sheet with nothing counted on it', () => {
    const sheet = stockTake.create(t.db, manager)
    expectUserMessage(
      () => stockTake.apply(t.db, manager, { stockTakeId: sheet.id }),
      /nothing has been counted/i
    )
  })

  it('finds an OVERSOLD item — the books at minus three is exactly what a count exists to catch', () => {
    const tea = makeProduct(t)
    receive(t, tea, TEN_PIECES)
    // The shop sold 13 of the 10 it had: someone rang up a delivery that was never keyed in.
    sell(t, tea, 13 * ONE_UNIT)
    expect(stock.onHand(t.db, tea)).toBe(-3 * ONE_UNIT)

    const sheet = stockTake.create(t.db, manager)
    // There are actually 2 on the shelf.
    stockTake.setCount(t.db, manager, {
      stockTakeId: sheet.id,
      productId: tea,
      countedQtyM: 2 * ONE_UNIT
    })
    const line = stockTake.get(t.db, { stockTakeId: sheet.id }).lines[0]
    expect(line?.expectedQtyM).toBe(-3 * ONE_UNIT) // negative expected is a REAL state of the books
    expect(line?.varianceQtyM).toBe(5 * ONE_UNIT)

    stockTake.apply(t.db, manager, { stockTakeId: sheet.id })

    expect(stock.onHand(t.db, tea)).toBe(2 * ONE_UNIT)
    assertHoldsAfterSale(t)
  })

  it('is CANCELLED, never deleted — an abandoned sheet is evidence too', () => {
    const tea = makeProduct(t)
    receive(t, tea, TEN_PIECES)

    const sheet = stockTake.create(t.db, manager)
    stockTake.setCount(t.db, manager, {
      stockTakeId: sheet.id,
      productId: tea,
      countedQtyM: 8 * ONE_UNIT
    })
    stockTake.cancel(t.db, manager, { stockTakeId: sheet.id, reason: 'Counted the wrong aisle' })

    const cancelled = stockTake.get(t.db, { stockTakeId: sheet.id })
    expect(cancelled.status).toBe('cancelled')
    // Everything that was counted is STILL THERE.
    expect(cancelled.lines).toHaveLength(1)
    expect(cancelled.lines[0]?.varianceQtyM).toBe(-2 * ONE_UNIT)

    // And it moved nothing.
    expect(stock.onHand(t.db, tea)).toBe(TEN_PIECES)
    expectUserMessage(
      () => stockTake.apply(t.db, manager, { stockTakeId: sheet.id }),
      /was cancelled/i
    )
  })

  it('reports the variance total on the list, so a big loss is visible without opening it', () => {
    const tea = makeProduct(t, { name: 'Tea' })
    const rice = makeProduct(t, { name: 'Rice' })
    receive(t, tea, TEN_PIECES)
    receive(t, rice, TEN_PIECES)

    const sheet = stockTake.create(t.db, manager)
    stockTake.addLines(t.db, manager, {
      stockTakeId: sheet.id,
      lines: [
        { productId: tea, countedQtyM: 8 * ONE_UNIT }, // −2 => −Rs 200
        { productId: rice, countedQtyM: TEN_PIECES } // correct => nothing
      ]
    })

    const listed = stockTake.list(t.db, {}).rows[0]
    expect(listed?.lineCount).toBe(2)
    expect(listed?.varianceLineCount).toBe(1) // only ONE line disagrees
    expect(listed?.varianceValueMinor).toBe(-20_000)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE AUDIT LOG — WHO signed off WHAT, and what it cost
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('the audit log', () => {
  it('records the apply with WHO and the VARIANCE TOTAL — a big variance is a theft signal', () => {
    const tea = makeProduct(t)
    receive(t, tea, TEN_PIECES)

    const sheet = stockTake.create(t.db, manager)
    stockTake.setCount(t.db, manager, {
      stockTakeId: sheet.id,
      productId: tea,
      countedQtyM: 8 * ONE_UNIT
    })
    stockTake.apply(t.db, manager, { stockTakeId: sheet.id })

    const entry = t.db
      .prepare("SELECT * FROM audit_log WHERE action = 'stockTake.apply'")
      .get() as {
      user_name: string
      user_role: string
      entity_id: string
      after_json: string
    }

    expect(entry).toBeTruthy()
    expect(entry.user_name).toBe('Meena Manager') // WHO — copied in, not joined
    expect(entry.user_role).toBe('manager') // and the ROLE AT THE TIME
    expect(entry.entity_id).toBe(String(sheet.id))

    const after = JSON.parse(entry.after_json) as {
      movementsPosted: number
      varianceValueMinor: number
    }
    expect(after.movementsPosted).toBe(1)
    expect(after.varianceValueMinor).toBe(-20_000) // THE NUMBER THE OWNER READS
  })

  it('every individual correction is audited too, by stock.adjust itself', () => {
    const tea = makeProduct(t)
    receive(t, tea, TEN_PIECES)

    const sheet = stockTake.create(t.db, manager)
    stockTake.setCount(t.db, manager, {
      stockTakeId: sheet.id,
      productId: tea,
      countedQtyM: 8 * ONE_UNIT
    })
    stockTake.apply(t.db, manager, { stockTakeId: sheet.id })

    // The sheet does not re-implement this — it comes free from calling the engine.
    const perLine = t.db
      .prepare("SELECT COUNT(*) FROM audit_log WHERE action = 'stock.stock_take'")
      .pluck()
      .get() as number
    expect(perLine).toBe(1)
  })
})
