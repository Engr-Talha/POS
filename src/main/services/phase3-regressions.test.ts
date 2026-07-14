import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import * as products from './products'
import * as stock from './stock'
import * as catalog from './catalog'
import * as ledger from './ledger'
import * as auth from './auth'
import { ACC } from '../db/chart-of-accounts'
import type { User } from '@shared/types'

/**
 * REGRESSIONS from the Phase 3 adversarial audit. Every one of these was a REAL bug, reproduced
 * before it was fixed. A regression test for every bug fixed — no exceptions (CLAUDE.md §4).
 */

let t: TestDb
let owner: User
let productId: number
let uomId: number

function setup(): void {
  t = makeTestDb({ withSeed: true })
  owner = auth.createFirstOwner(t.db, { username: 'boss', fullName: 'Boss', password: 'password1' })
  uomId = t.db
    .prepare("SELECT id FROM lookups WHERE list_key='uom' AND code='pcs'")
    .pluck()
    .get() as number

  const created = products.create(t.db, owner, {
    sku: 'W1',
    name: 'Widget',
    saleUomId: uomId,
    retailPrice: 15_000,
    wholesalePrice: 13_000,
    taxRateBp: 0,
    priceEntryMode: 'exclusive',
    itemType: 'inventory'
  } as never) as { product: { id: number } }

  productId = created.product.id
}

beforeEach(setup)
afterEach(() => t.cleanup())

/** The stock valuation report and the general ledger must agree. Always. */
function assertStockValueMatchesLedger(): void {
  const level = stock.stockLevel(t.db, productId)
  const gl = ledger.accountBalance(t.db, ACC.INVENTORY)
  expect(level.stockValueMinor).toBe(gl)
}

describe('CRITICAL: the product form could rewrite the weighted-average cost', () => {
  /**
   * cost_price is the weighted average of what the shop actually PAID — derived from stock movements.
   * It was in the updatable field map, and the form sent it on every save (it auto-derives a cost
   * from the supplier-price chain as you type). So editing an item's supplier price silently
   * revalued stock ALREADY ON THE SHELF, with no movement and no journal. The GL said the stock was
   * worth Rs 1,000 while the valuation report started saying Rs 1,500 — and the trial balance still
   * balanced, so nothing caught it.
   */
  it('an item save can NO LONGER change the cost of stock already on the shelf', () => {
    stock.adjust(t.db, owner, {
      productId,
      type: 'opening',
      qtyM: 10_000,
      unitCost: 1_000_000, // Rs 100.0000
      reasonCode: 'stock_take'
    } as never)

    expect(stock.recomputeAverageCost(t.db, productId)).toBe(1_000_000)
    assertStockValueMatchesLedger()

    // The manager edits the item and saves. The form no longer sends costPrice at all — and even if
    // something did, the service will not write it.
    products.update(t.db, owner, {
      id: productId,
      retailPrice: 20_000,
      costPrice: 1_500_000 // Rs 150 — an attempt to revalue the shelf by typing
    } as never)

    const stored = t.db
      .prepare('SELECT cost_price FROM products WHERE id = ?')
      .pluck()
      .get(productId) as number

    expect(stored).toBe(1_000_000) // unchanged: cost is owned by the movements
    expect(stored).toBe(stock.recomputeAverageCost(t.db, productId))
    assertStockValueMatchesLedger() // the books and the shelf still agree

    // ...and the field they ARE allowed to edit went through.
    expect(
      t.db.prepare('SELECT retail_price FROM products WHERE id = ?').pluck().get(productId)
    ).toBe(20_000)
  })
})

describe('HIGH: restocking from negative stock orphaned inventory value', () => {
  /**
   * The average RESET to the incoming cost whenever on-hand was <= 0. When on-hand is NEGATIVE the
   * ledger is already carrying that negative value, so resetting threw it away:
   *   open 10 @ 100 -> damage -15 -> restock 20 @ 200  left the GL Rs 500 above the stock report.
   */
  it('blends through negative stock so the valuation still equals the ledger', () => {
    stock.adjust(t.db, owner, {
      productId, type: 'opening', qtyM: 10_000, unitCost: 1_000_000, reasonCode: 'stock_take'
    } as never)
    assertStockValueMatchesLedger()

    stock.adjust(t.db, owner, { productId, qtyM: -15_000, reasonCode: 'damage' } as never)
    expect(stock.onHand(t.db, productId)).toBe(-5_000) // oversold
    assertStockValueMatchesLedger()

    stock.adjust(t.db, owner, {
      productId, type: 'opening', qtyM: 20_000, unitCost: 2_000_000, reasonCode: 'stock_take'
    } as never)

    // (-5,000 x 1,000,000 + 20,000 x 2,000,000) / 15,000 = 2,333,333  ->  Rs 233.3333
    const avg = t.db.prepare('SELECT cost_price FROM products WHERE id = ?').pluck().get(productId)
    expect(avg).toBe(2_333_333)

    // THE POINT: the stock report and the ledger agree. Before the fix they were Rs 500 apart.
    assertStockValueMatchesLedger()
  })

  it('a sale still never moves the average', () => {
    stock.record(t.db, { productId, type: 'purchase', qtyM: 10_000, unitCost: 1_000_000 })
    stock.record(t.db, { productId, type: 'purchase', qtyM: 10_000, unitCost: 1_200_000 })
    stock.record(t.db, { productId, type: 'sale', qtyM: -5_000 })

    expect(t.db.prepare('SELECT cost_price FROM products WHERE id = ?').pluck().get(productId)).toBe(
      1_100_000 // Rs 110 — selling does not change what the rest of the shelf cost
    )
  })
})

describe('HIGH: a closed month refused money but still accepted stock', () => {
  it('a locked period now refuses a stock movement too', () => {
    ledger.lockPeriod(t.db, 2026, 6, owner.id)

    expectUserMessage(
      () =>
        stock.record(t.db, {
          at: new Date('2026-06-15'),
          productId,
          type: 'purchase',
          qtyM: 1_000,
          unitCost: 1_000_000
        }),
      /June 2026 has been closed/i
    )

    expect(stock.onHand(t.db, productId)).toBe(0) // nothing slipped in
  })
})

describe('MEDIUM: every service in the shop was flagged as needing re-ordering', () => {
  it('a non-inventory item is not "below re-order level"', () => {
    // A service has no stock and a re-order level of 0, so a bare `0 <= 0` flagged it forever.
    const service = products.create(t.db, owner, {
      sku: 'BAG', name: 'Carrier bag charge', saleUomId: uomId,
      retailPrice: 500, wholesalePrice: 500, taxRateBp: 0,
      priceEntryMode: 'exclusive', itemType: 'non_inventory'
    } as never) as { product: { id: number } }

    expect(stock.stockLevel(t.db, service.product.id).isBelowReorder).toBe(false)
  })
})

describe('MEDIUM: saving a pack wiped its prices to zero', () => {
  it('a field the form did not send keeps its old value', () => {
    const pack = catalog.addPack(t.db, {
      productId, uomId, packSize: 24_000,
      cost: 21_850_000, retailPrice: 399_900, wholesalePrice: 230_000,
      barcode: 'CARTON-1'
    } as never)

    // The form saves again, editing only the pack size. It does not resend the prices.
    catalog.updatePack(t.db, { id: pack.id, productId, uomId, packSize: 12_000 } as never)

    const after = catalog.listPacks(t.db, productId).find((p) => p.id === pack.id)!
    expect(after.packSize).toBe(12_000) // the edit landed
    expect(after.retailPrice).toBe(399_900) // and the price was NOT wiped to 0
    expect(after.cost).toBe(21_850_000)
    expect(after.wholesalePrice).toBe(230_000)
  })

  it('ALLOWS a purchase-only carton: a supplier barcode with no selling price', () => {
    // "Buy in cartons, sell in pieces" — the carton carries the supplier's barcode so a delivery can
    // be scanned in, and has NO selling price because a carton is never sold as a carton. Refusing
    // this would break the shop's normal way of working.
    //
    // The risk is at the TILL, not here: Phase 5's sell path MUST refuse to sell a pack whose
    // retail price is 0, or it rings up a free carton. Recorded in CLAUDE.md.
    const purchaseOnly = catalog.addPack(t.db, {
      productId, uomId, packSize: 24_000, cost: 21_850_000, barcode: 'SUPPLIER-CARTON'
    } as never)

    expect(purchaseOnly.retailPrice).toBe(0)
    expect(catalog.findProductByBarcode(t.db, 'SUPPLIER-CARTON')!.pack?.packSize).toBe(24_000)
  })
})

describe('CRITICAL: changing a carton barcode stopped the cartons on the shelf from scanning', () => {
  it('an OLD pack barcode still scans after the pack barcode is changed', () => {
    const pack = catalog.addPack(t.db, {
      productId, uomId, packSize: 24_000,
      cost: 21_850_000, retailPrice: 399_900, wholesalePrice: 230_000,
      barcode: 'CARTON-OLD'
    } as never)

    // The shop re-labels the carton.
    catalog.updatePack(t.db, {
      id: pack.id, productId, uomId, packSize: 24_000, barcode: 'CARTON-NEW'
    } as never)

    // The cartons ALREADY ON THE SHELF still carry the old label. They must still scan — and still
    // resolve to the carton, so one scan moves 24 pieces and not 1.
    const viaOld = catalog.findProductByBarcode(t.db, 'CARTON-OLD')
    expect(viaOld).toBeTruthy()
    expect(viaOld!.product.id).toBe(productId)
    expect(viaOld!.pack?.packSize).toBe(24_000)

    const viaNew = catalog.findProductByBarcode(t.db, 'CARTON-NEW')
    expect(viaNew!.pack?.packSize).toBe(24_000)
  })

  it('retiring a pack does NOT stop its barcode scanning', () => {
    const pack = catalog.addPack(t.db, {
      productId, uomId, packSize: 24_000,
      cost: 21_850_000, retailPrice: 399_900, wholesalePrice: 230_000,
      barcode: 'CARTON-RETIRED'
    } as never)

    catalog.deletePack(t.db, pack.id)

    // Gone from the form...
    expect(catalog.listPacks(t.db, productId).some((p) => p.id === pack.id)).toBe(false)

    // ...but the cartons of it still on the shelf keep working. A DELETE here would have left the
    // cashier facing an unknown item with a customer waiting.
    const scanned = catalog.findProductByBarcode(t.db, 'CARTON-RETIRED')
    expect(scanned).toBeTruthy()
    expect(scanned!.product.id).toBe(productId)
  })
})
