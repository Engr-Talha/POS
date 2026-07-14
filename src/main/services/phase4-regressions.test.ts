import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, type TestDb } from '../db/testkit'
import * as opening from './opening'
import * as products from './products'
import * as catalog from './catalog'
import * as stock from './stock'
import * as ledger from './ledger'
import * as auth from './auth'
import { ACC } from '../db/chart-of-accounts'
import type { User } from '@shared/types'

/**
 * REGRESSIONS from the Phase 4 adversarial audit. Every one was a REAL bug, reproduced before it was
 * fixed. A regression test for every bug fixed — no exceptions (CLAUDE.md §4).
 */

let t: TestDb
let owner: User
let uomId: number

beforeEach(() => {
  t = makeTestDb({ withSeed: true })
  owner = auth.createFirstOwner(t.db, { username: 'boss', fullName: 'Boss', password: 'password1' })
  uomId = t.db
    .prepare("SELECT id FROM lookups WHERE list_key='uom' AND code='pcs'")
    .pluck()
    .get() as number
})

afterEach(() => t.cleanup())

function makeProduct(sku: string, trackBatches = false): number {
  const created = products.create(t.db, owner, {
    sku,
    name: sku,
    saleUomId: uomId,
    retailPrice: 10_000,
    wholesalePrice: 9_000,
    taxRateBp: 0,
    priceEntryMode: 'exclusive',
    itemType: 'inventory',
    trackBatches
  } as never) as { product: { id: number } }
  return created.product.id
}

/** GL Inventory and the stock valuation report must agree. To the paisa. Always. */
function assertLedgerMatchesStockReport(productId: number): void {
  const gl = ledger.accountBalance(t.db, ACC.INVENTORY)
  const report = stock.stockLevel(t.db, productId).stockValueMinor
  expect(report, 'the stock report has drifted from the general ledger').toBe(gl)
}

describe('HIGH: the ledger and the stock report drifted a paisa apart, silently', () => {
  /**
   * The GL rounded ONCE PER MOVEMENT; the stock report rounded once on the TOTAL (on_hand x average).
   * Sum-of-rounded !== round-of-sum, so a pharmacy opening with two batches of 3 pcs at Rs 91.0417
   * got GL Rs 546.26 against a stock report of Rs 546.25 — a paisa of inventory that existed in the
   * books and nowhere on the shelf. Every journal balanced individually, so the trial balance stayed
   * green and NOTHING caught it. Exactly the failure CLAUDE.md warns about by name.
   *
   * Fixed by valuing each movement ONCE, storing it (migration 0006), and having the ledger post that
   * number and the report SUM that number. Equal by construction now, not by luck.
   */
  it('two batches at an awkward 4-dp cost: GL == stock report, to the paisa', () => {
    const id = makeProduct('PANADOL', true)

    // Rs 91.0417 — the carton-of-24 cost the entire 4-dp cost scale exists to represent.
    opening.addStockLine(t.db, owner, {
      productId: id, qtyM: 3_000, unitCost: 910_417, batchNo: 'B1', expiryDate: '2027-01-01'
    })
    opening.addStockLine(t.db, owner, {
      productId: id, qtyM: 3_000, unitCost: 910_417, batchNo: 'B2', expiryDate: '2027-06-01'
    })
    opening.commit(t.db, owner)

    // Rs 273.13 + Rs 273.13. NOT round(6 x 91.0417) = Rs 546.25.
    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(54_626)
    assertLedgerMatchesStockReport(id)
    expect(ledger.trialBalance(t.db).balanced).toBe(true)
  })

  it('stays tied after a purchase and a sale at different awkward costs', () => {
    // The general case — the opening wizard was only where it was NOTICED. A purchase at one
    // awkward cost followed by another at a different one would have drifted the same way.
    const id = makeProduct('GENERAL')

    stock.record(t.db, { productId: id, type: 'purchase', qtyM: 7_000, unitCost: 910_417 })
    stock.record(t.db, { productId: id, type: 'purchase', qtyM: 3_000, unitCost: 333_333 })
    stock.record(t.db, { productId: id, type: 'sale', qtyM: -4_000 })

    // The stock report is the SUM of what each movement actually moved.
    const movements = t.db
      .prepare('SELECT COALESCE(SUM(value_minor), 0) FROM stock_movements WHERE product_id = ?')
      .pluck()
      .get(id) as number

    expect(stock.stockLevel(t.db, id).stockValueMinor).toBe(movements)
  })
})

describe('the movement value is a CACHE — so it must be rebuildable, and it must never lie', () => {
  /**
   * CLAUDE.md permits a cached figure on exactly one condition: it is rebuildable from the source of
   * truth, and a test asserts the two agree. `value_minor` is the money a movement moved, frozen when
   * it happened. This is that test.
   */
  it('every movement’s stored value equals a rebuild from its own quantity and cost', () => {
    const id = makeProduct('CACHE')

    stock.record(t.db, { productId: id, type: 'purchase', qtyM: 7_000, unitCost: 910_417 })
    stock.record(t.db, { productId: id, type: 'sale', qtyM: -2_000 })
    stock.adjust(t.db, owner, { productId: id, qtyM: -1_000, reasonCode: 'damage' })

    const rows = t.db
      .prepare('SELECT id, qty_m, unit_cost, value_minor FROM stock_movements')
      .all() as Array<{ id: number; qty_m: number; unit_cost: number; value_minor: number }>

    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.value_minor, `movement ${row.id} has drifted from its own history`).toBe(
        stock.movementValueMinor(row.qty_m, row.unit_cost)
      )
    }

    // ...and if one ever DID drift, the rebuild puts it right.
    t.db.prepare('UPDATE stock_movements SET value_minor = 999999 WHERE id = ?').run(rows[0]!.id)
    expect(stock.recomputeMovementValues(t.db)).toBe(1) // exactly one repaired

    const repaired = t.db
      .prepare('SELECT value_minor FROM stock_movements WHERE id = ?')
      .pluck()
      .get(rows[0]!.id)
    expect(repaired).toBe(rows[0]!.value_minor)
  })
})

describe('HIGH: a premature sale stranded the shop’s opening balances forever', () => {
  /**
   * commit() shared the edit guard, which freezes once the shop has traded. So a cashier ringing up
   * ONE sale before the owner finished pressing Commit locked the opening balances out permanently:
   * the cash, the bank, the udhaar and the supplier dues could then never reach the books AT ALL,
   * and no screen in the app would let them in.
   *
   * Being unable to EDIT after trading is the safety. Being unable to COMMIT is just a locked door.
   */
  it('the owner can still commit a draft after a sale has slipped through', () => {
    const id = makeProduct('EARLY')
    opening.addStockLine(t.db, owner, { productId: id, qtyM: 10_000, unitCost: 1_000_000 })
    opening.setCashAndBank(t.db, owner, { openingCash: 2_500_000, openingBank: 11_000_000 })

    // A cashier rings something up before the owner has finished.
    stock.record(t.db, { productId: id, type: 'sale', qtyM: -1_000 })
    expect(opening.hasTraded(t.db)).toBe(true)

    // The worksheet is now frozen — that part is correct and stays.
    expect(() =>
      opening.setCashAndBank(t.db, owner, { openingCash: 999, openingBank: 0 })
    ).toThrow()

    // ...but the balances the owner already typed MUST still be able to reach the books.
    expect(() => opening.commit(t.db, owner)).not.toThrow()

    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(2_500_000)
    expect(ledger.accountBalance(t.db, ACC.BANK)).toBe(11_000_000)
    expect(ledger.trialBalance(t.db).balanced).toBe(true)
  })
})

describe('HIGH: an existing batch kept a cost of zero forever', () => {
  it('backfills the cost of a batch the owner had already created', () => {
    const id = makeProduct('MEDICINE', true)

    // The owner creates the batch on the product screen FIRST — there is nothing to cost it at yet.
    const batch = catalog.addBatch(t.db, { productId: id, batchNo: 'LOT-9', expiryDate: '2028-01-01' })
    expect(batch.cost).toBe(0)

    // The opening line is the first and only thing that ever knows what that batch was worth.
    opening.addStockLine(t.db, owner, {
      productId: id, qtyM: 5_000, unitCost: 910_417, batchNo: 'LOT-9', expiryDate: '2028-01-01'
    })
    opening.commit(t.db, owner)

    const cost = t.db.prepare('SELECT cost FROM batches WHERE id = ?').pluck().get(batch.id)
    expect(cost).toBe(910_417) // not 0 — the batch report would have priced it at nothing forever
    assertLedgerMatchesStockReport(id)
  })
})

describe('LOW: a shop with no stock could not open its books at all', () => {
  it('commits cash and debts even when the adjustment-reason list is empty', () => {
    // A service business, or a shop with an empty shelf on day one. Demanding a STOCK-ADJUSTMENT
    // reason from a shop with no stock locked it out of its own books over a list it never needed.
    t.db.prepare("DELETE FROM lookups WHERE list_key = 'adjustment_reason'").run()

    opening.setCashAndBank(t.db, owner, { openingCash: 5_000_000, openingBank: 0 })
    expect(() => opening.commit(t.db, owner)).not.toThrow()

    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(5_000_000)
    expect(ledger.trialBalance(t.db).balanced).toBe(true)
  })
})
