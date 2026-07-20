import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import * as products from './products'
import * as audit from './audit'
import * as auth from './auth'
import * as lookups from './lookups'
import * as stock from './stock'
import type { User } from '@shared/types'
import { formatCost, parseCost } from '@shared/cost'
import { formatMoney, parseMoney } from '@shared/money'
import { ONE_UNIT } from '@shared/qty'
import { priceExclusiveFromInclusive, priceInclusiveFromExclusive } from '@shared/tax'

/**
 * THE NUMBERS OFF THE OWNER'S LEGACY SCREEN. Every price test below uses these, not made-up ones,
 * because the point is not that the arithmetic runs — it is that it produces the figures the shop
 * already knows are right.
 *
 *   SUPPLIER PRICE   Rs 2185.0000   (4-dp cost)
 *   COST PRICE       Rs 2185.00
 *   RETAIL PRICE     Rs 3999.00
 *   WHOLESALE PRICE  Rs 2300.00
 */
const SUPPLIER_PRICE = parseCost('2185.0000')! //  21_850_000  — 4-dp COST
const COST_PRICE = parseCost('2185.0000')! //      21_850_000  — 4-dp COST
const RETAIL = parseMoney('3999.00')! //              399_900  — 2-dp MONEY
const WHOLESALE = parseMoney('2300.00')! //           230_000  — 2-dp MONEY

let t: TestDb
let actor: User

function uom(code = 'pcs'): number {
  return lookups.list(t.db, 'uom').find((l) => l.code === code)!.id
}

function lookupId(list: Parameters<typeof lookups.list>[1], code: string): number {
  return lookups.list(t.db, list).find((l) => l.code === code)!.id
}

/** The legacy Item Detail form, filled in and saved. */
function legacyItem(overrides: Record<string, unknown> = {}) {
  return {
    sku: 'STK-001',
    name: 'Cooking Oil 5L',
    nameOtherLang: 'کھانا پکانے کا تیل',
    saleUomId: uom(),
    categoryId: lookupId('category', 'general'),
    costPrice: COST_PRICE,
    retailPrice: RETAIL,
    wholesalePrice: WHOLESALE,
    minStockM: 5 * ONE_UNIT,
    ...overrides
  }
}

/**
 * Stock only ever moves by a MOVEMENT. There is no "set stock to N" anywhere in the app, so the tests
 * do not have one either — they post movements exactly like the stock service will.
 */
function move(productId: number, qtyM: number, type = 'adjustment', unitCost = 0): void {
  // Mirror what stock.record() actually does, so the fixture is a state the app can really produce:
  //
  //  - a movement OUT (a sale, damage) goes out at the product's AVERAGE cost — that is its COGS.
  //    Left at 0 it would relieve NO inventory value, and the shelf would still be carrying the money
  //    for stock that has already left the shop.
  //  - value_minor is the money the movement moved, frozen when it happens (migration 0006). A real
  //    movement always carries it: the ledger posts that number and the stock report sums it.
  const cost =
    unitCost ||
    (t.db.prepare('SELECT cost_price FROM products WHERE id = ?').pluck().get(productId) as number)

  t.db
    .prepare(
      `INSERT INTO stock_movements (at, type, product_id, qty_m, unit_cost, value_minor, reason_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'data_entry', ?)`
    )
    .run(
      new Date().toISOString(),
      type,
      productId,
      qtyM,
      cost,
      stock.movementValueMinor(qtyM, cost),
      new Date().toISOString()
    )
}

beforeEach(() => {
  t = makeTestDb({ withSeed: true })
  actor = auth.createFirstOwner(t.db, {
    username: 'talha',
    fullName: 'Talha',
    password: 'shop-owner-1'
  })
})
afterEach(() => t.cleanup())

// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('the price chain — the legacy screen’s real numbers, in integers', () => {
  it('runs supplier price -> discount -> cost price -> unit cost, end to end', () => {
    // SUPPLIER PRICE Rs 2185.0000, no discount -> COST PRICE Rs 2185.0000
    const cost = products.costFromSupplier(SUPPLIER_PRICE, 0)
    expect(cost).toBe(21_850_000)
    expect(formatCost(cost)).toBe('2,185.0000')

    const p = products.pricing({
      costPrice: cost,
      retailPrice: RETAIL,
      wholesalePrice: WHOLESALE,
      taxRateBp: 0,
      isTaxExempt: false,
      priceEntryMode: 'exclusive'
    })

    // THE SCALE CROSSING. Cost is 4 dp (21,850,000) and money is 2 dp (218,500) — the SAME rupees.
    // Subtracting one from the other without this conversion is a hundredfold error, and it is the
    // single easiest way to misprice an entire shop.
    expect(p.costMinor).toBe(218_500)
    expect(formatMoney(p.costMinor)).toBe('2,185.00')

    // RETAIL Rs 3999.00 on a cost of Rs 2185.00
    expect(formatMoney(p.retail.exclusive)).toBe('3,999.00')
    expect(p.retailProfitBp).toBe(8302) //   83.02% markup on cost
    expect(p.retailMarginBp).toBe(4536) //   45.36% of the selling price is profit

    // WHOLESALE Rs 2300.00 on the same cost
    expect(formatMoney(p.wholesale.exclusive)).toBe('2,300.00')
    expect(p.wholesaleProfitBp).toBe(526) //  5.26% markup on cost
    expect(p.wholesaleMarginBp).toBe(500) //  5.00% margin on the selling price — exactly

    // NET PROFIT: Rs 3999.00 − Rs 2185.00
    expect(p.netProfitMinor).toBe(181_400)
    expect(formatMoney(p.netProfitMinor)).toBe('1,814.00')
    expect(formatMoney(p.wholesaleNetProfitMinor)).toBe('115.00')
  })

  it('a CARTON OF 24 costing Rs 2185 gives a unit cost of Rs 91.0417 — NOT Rs 91.04', () => {
    // This is the whole reason cost carries four decimal places. 2185 / 24 = 91.041666…
    // Rounded to the paisa that is 91.04, and the 0.0017 lost on every single piece, across a year
    // of sales, quietly falsifies the profit and COGS reports.
    const cartonOf24 = 24 * ONE_UNIT // packSize is qty_m of the BASE unit: 24 pieces = 24000
    const unitCost = products.unitCostFromPack(COST_PRICE, cartonOf24)

    expect(unitCost).toBe(910_417)
    expect(formatCost(unitCost)).toBe('91.0417')

    // The number a 2-dp cost column would have stored instead. It is NOT this.
    expect(unitCost).not.toBe(910_400)
  })

  it('takes the supplier’s discount off the supplier price, in basis points', () => {
    // Rs 2185.0000 less 5% = Rs 2075.7500
    expect(formatCost(products.costFromSupplier(SUPPLIER_PRICE, 500))).toBe('2,075.7500')
    // less 12.5%
    expect(formatCost(products.costFromSupplier(SUPPLIER_PRICE, 1250))).toBe('1,911.8750')
    // A 100% discount is free stock, not an error.
    expect(products.costFromSupplier(SUPPLIER_PRICE, 10_000)).toBe(0)
  })

  it('refuses a discount above 100% in plain language', () => {
    expectUserMessage(() => products.costFromSupplier(SUPPLIER_PRICE, 10_001), /between 0% and 100%/i)
  })

  it('will not express a profit as a percentage of a zero cost', () => {
    // Returning 0 here would read as "we make nothing on this", which is the opposite of the truth.
    expect(products.markupBp(0, RETAIL)).toBeNull()
    expect(products.marginBp(COST_PRICE, 0)).toBeNull()
  })

  it('a loss shows as a negative profit, not as zero', () => {
    // Selling Rs 2185 stock at Rs 2000 loses Rs 185 a piece, and the form must say so.
    const p = products.pricing({
      costPrice: COST_PRICE,
      retailPrice: parseMoney('2000.00')!,
      wholesalePrice: WHOLESALE,
      taxRateBp: 0,
      isTaxExempt: false,
      priceEntryMode: 'exclusive'
    })

    expect(p.netProfitMinor).toBe(-18_500)
    expect(formatMoney(p.netProfitMinor)).toBe('-185.00')
    expect(p.retailProfitBp).toBeLessThan(0)
  })
})

describe('tax — the form shows the price both ways, and each computes the other', () => {
  it('excl -> incl -> excl round-trips exactly at 17%', () => {
    const inclusive = priceInclusiveFromExclusive(RETAIL, 1700)
    expect(formatMoney(inclusive)).toBe('4,678.83') // 3999.00 + 679.83

    expect(priceExclusiveFromInclusive(inclusive, 1700)).toBe(RETAIL)
  })

  it('round-trips an awkward price where the tax does not land on a whole paisa', () => {
    const excl = parseMoney('9.99')! // 17% of 9.99 is 1.6983 — there is no such coin
    const incl = priceInclusiveFromExclusive(excl, 1700)

    expect(formatMoney(incl)).toBe('11.69')
    expect(priceExclusiveFromInclusive(incl, 1700)).toBe(excl)
  })

  it('shows both prices for an item priced INCLUSIVE of tax — the shelf-label case', () => {
    const p = products.pricing({
      costPrice: COST_PRICE,
      retailPrice: parseMoney('4678.83')!, // typed WITH the tax in it
      wholesalePrice: WHOLESALE,
      taxRateBp: 1700,
      isTaxExempt: false,
      priceEntryMode: 'inclusive'
    })

    expect(formatMoney(p.retail.inclusive)).toBe('4,678.83')
    expect(formatMoney(p.retail.exclusive)).toBe('3,999.00')

    // AND THE PROFIT IS MEASURED ON THE EXCLUSIVE PRICE. The Rs 679.83 of sales tax inside that
    // shelf price is not the shop's money — it is collected for the government and handed over.
    // Counting it as profit would overstate the margin on every tax-inclusive item in the shop.
    expect(p.netProfitMinor).toBe(181_400) // 3999.00 − 2185.00, exactly as the exclusive item
    expect(p.retailProfitBp).toBe(8302)
  })

  it('a tax-exempt item ignores its own tax rate', () => {
    const p = products.pricing({
      costPrice: COST_PRICE,
      retailPrice: RETAIL,
      wholesalePrice: WHOLESALE,
      taxRateBp: 1700,
      isTaxExempt: true,
      priceEntryMode: 'exclusive'
    })

    expect(p.taxRateBp).toBe(0)
    expect(p.retail.inclusive).toBe(p.retail.exclusive)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('create — the whole legacy Item Detail form, in one transaction', () => {
  it('saves the item with its barcodes, alternate packings and suppliers', () => {
    const supplierId = Number(
      t.db
        .prepare(
          "INSERT INTO suppliers (name, is_active, created_at, updated_at) VALUES ('Metro', 1, datetime('now'), datetime('now'))"
        )
        .run().lastInsertRowid
    )

    const detail = products.create(
      t.db,
      actor,
      legacyItem({
        barcodes: ['8964000111222'],
        packs: [
          { uomId: uom('pcs'), packSize: ONE_UNIT, cost: COST_PRICE, retailPrice: RETAIL, isBase: true },
          {
            uomId: uom('carton'),
            packSize: 24 * ONE_UNIT,
            cost: parseCost('52440.0000')!, // 24 x 2185
            retailPrice: parseMoney('89000.00')!,
            barcode: '8964000111239'
          }
        ],
        suppliers: [
          {
            supplierId,
            supplierItemCode: 'MET-OIL-5L',
            supplierPrice: SUPPLIER_PRICE,
            discountBp: 500,
            isPreferred: true
          }
        ]
      })
    )

    expect(detail.product.sku).toBe('STK-001')
    expect(detail.product.nameOtherLang).toBe('کھانا پکانے کا تیل') // prints on the receipt
    expect(detail.barcodes).toHaveLength(1)
    expect(detail.barcodes[0]!.isPrimary).toBe(true) // the first one prints on new labels
    expect(detail.packs).toHaveLength(2)
    expect(detail.suppliers[0]!.supplierItemCode).toBe('MET-OIL-5L')
    expect(detail.suppliers[0]!.supplierName).toBe('Metro')

    // BALANCE QUANTITY is derived, and a brand-new item has never had a movement. It is 0, and it
    // could not have been typed in even if someone wanted to.
    expect(detail.stock.onHandM).toBe(0)

    // Each alternate packing carries its OWN cost — a carton is not simply 24 x the piece price.
    const carton = detail.packs.find((p) => p.packSize === 24 * ONE_UNIT)!
    expect(formatCost(products.unitCostFromPack(carton.cost, carton.packSize))).toBe('2,185.0000')
  })

  it('refuses a duplicate stock code, in language a cashier understands', () => {
    products.create(t.db, actor, legacyItem())
    expectUserMessage(
      () => products.create(t.db, actor, legacyItem({ name: 'Something else' })),
      /stock code "STK-001" is already used/i
    )
  })

  it('REFUSES a barcode already used by another item’s PACKING — the check SQLite cannot make', () => {
    // product_barcodes.barcode and product_packs.barcode are each unique in their own table, but
    // SQLite cannot make them unique ACROSS the two. If it could ever happen, one scan at the counter
    // would have two answers — one piece, or a whole carton — and the shop would charge whichever it
    // found first.
    products.create(
      t.db,
      actor,
      legacyItem({
        packs: [{ uomId: uom('carton'), packSize: 24 * ONE_UNIT, barcode: '8964000111239' }]
      })
    )

    expectUserMessage(
      () =>
        products.create(
          t.db,
          actor,
          legacyItem({ sku: 'STK-002', barcodes: ['8964000111239'] })
        ),
      /already used by a pack of/i
    )
  })

  it('REFUSES a packing barcode already used as another item’s product barcode', () => {
    products.create(t.db, actor, legacyItem({ barcodes: ['8964000111222'] }))

    expectUserMessage(
      () =>
        products.create(
          t.db,
          actor,
          legacyItem({
            sku: 'STK-002',
            packs: [{ uomId: uom('carton'), packSize: 24 * ONE_UNIT, barcode: '8964000111222' }]
          })
        ),
      // And it NAMES the item that already has it — "that barcode is taken" sends a shopkeeper
      // hunting through 400 SKUs; "taken by Cooking Oil 5L (STK-001)" ends the search.
      /already used by Cooking Oil 5L \(STK-001\)/i
    )
  })

  it('saves NOTHING when any part of the form fails — no half-saved item', () => {
    products.create(t.db, actor, legacyItem({ barcodes: ['8964000111222'] }))

    expect(() =>
      products.create(
        t.db,
        actor,
        legacyItem({ sku: 'STK-002', barcodes: ['8964000111333', '8964000111222'] })
      )
    ).toThrow()

    // The second product must not exist, and neither must its first barcode — an item that
    // half-saved, with a barcode that scans to nothing, is worse than one that did not save at all.
    expect(products.findBySku(t.db, 'STK-002')).toBeNull()
    const orphan = t.db
      .prepare('SELECT COUNT(*) FROM product_barcodes WHERE barcode = ?')
      .pluck()
      .get('8964000111333') as number
    expect(orphan).toBe(0)
  })

  it('insists the base packing is exactly one selling unit', () => {
    expectUserMessage(
      () =>
        products.create(
          t.db,
          actor,
          legacyItem({
            packs: [{ uomId: uom('carton'), packSize: 24 * ONE_UNIT, isBase: true }]
          })
        ),
      /base packing must be exactly one selling unit/i
    )
  })

  it('has no way to type a stock figure in — there is no stock column to type it into', () => {
    const columns = (t.db.prepare('PRAGMA table_info(products)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )

    expect(columns).not.toContain('stock')
    expect(columns).not.toContain('quantity')
    expect(columns).not.toContain('balance_quantity')
  })
})

describe('stock — derived from movements, always', () => {
  it('recomputes the balance quantity from the movements, every time', () => {
    const { product } = products.create(t.db, actor, legacyItem())

    move(product.id, 24 * ONE_UNIT, 'opening', COST_PRICE) //  bought a carton
    move(product.id, -3 * ONE_UNIT, 'sale') //                 sold three
    move(product.id, -1 * ONE_UNIT, 'damage') //               one broke

    expect(stock.onHand(t.db, product.id)).toBe(20 * ONE_UNIT)

    // ...and the product form's READ-ONLY balance quantity shows the very same figure, because it
    // asks the stock service for it rather than working it out a second way.
    const level = products.getById(t.db, product.id).stock
    expect(level.onHandM).toBe(20 * ONE_UNIT)

    // 20 pieces at Rs 2185.00 = Rs 43,700.00
    expect(formatMoney(level.stockValueMinor)).toBe('43,700.00')
  })

  it('shows a negative balance rather than hiding it', () => {
    // A negative-stock sale is allowed, warned and flagged (PLAN §1). A stock figure that quietly
    // clamped at zero would hide the very mistake we want somebody to look at.
    const { product } = products.create(t.db, actor, legacyItem())
    move(product.id, -2 * ONE_UNIT, 'sale')

    expect(stock.onHand(t.db, product.id)).toBe(-2 * ONE_UNIT)
  })

  it('flags an item at or below its re-order level', () => {
    const { product } = products.create(t.db, actor, legacyItem()) // re-order level 5
    move(product.id, 5 * ONE_UNIT, 'opening')

    expect(products.getById(t.db, product.id).stock.isBelowReorder).toBe(true)

    move(product.id, 1 * ONE_UNIT, 'purchase')
    expect(products.getById(t.db, product.id).stock.isBelowReorder).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('update — writes ONLY the fields the form edited (trap #18)', () => {
  it('leaves every field the form never sent completely alone', () => {
    const { product } = products.create(
      t.db,
      actor,
      legacyItem({ brandId: lookupId('category', 'general'), sizeVolume: '5 L', taxRateBp: 1700 })
    )

    // The price-only edit screen sends the price. It never loaded the Urdu name, the size, the
    // re-order level or the tax rate — and it must not be able to wipe them by not mentioning them.
    const updated = products.update(t.db, actor, { id: product.id, retailPrice: parseMoney('4250.00')! })

    expect(updated.product.retailPrice).toBe(425_000)
    expect(updated.product.nameOtherLang).toBe('کھانا پکانے کا تیل')
    expect(updated.product.sizeVolume).toBe('5 L')
    expect(updated.product.minStockM).toBe(5 * ONE_UNIT)
    expect(updated.product.taxRateBp).toBe(1700)
    expect(updated.product.categoryId).toBe(product.categoryId)
    expect(updated.product.wholesalePrice).toBe(WHOLESALE)
    expect(updated.product.costPrice).toBe(COST_PRICE)
    expect(updated.product.sku).toBe('STK-001')
  })

  it('tells "the user cleared this field" apart from "the form never loaded it"', () => {
    const { product } = products.create(t.db, actor, legacyItem({ sizeVolume: '5 L' }))

    // null = the user emptied the box. undefined/absent = the form never had it.
    const cleared = products.update(t.db, actor, { id: product.id, sizeVolume: null })
    expect(cleared.product.sizeVolume).toBeNull()
    expect(cleared.product.nameOtherLang).toBe('کھانا پکانے کا تیل') // untouched
  })

  it('records WHO changed a price, and from what to what', () => {
    const { product } = products.create(t.db, actor, legacyItem())

    products.update(t.db, actor, { id: product.id, retailPrice: parseMoney('4250.00')! })

    const { rows } = audit.list(t.db, { action: 'product.price_change' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.userName).toBe('Talha')
    expect(rows[0]!.userRole).toBe('owner')
    expect(rows[0]!.entityId).toBe(String(product.id))

    const logged = t.db
      .prepare("SELECT before_json, after_json FROM audit_log WHERE action = 'product.price_change'")
      .get() as { before_json: string; after_json: string }

    expect(JSON.parse(logged.before_json)).toEqual({ retailPrice: RETAIL })
    expect(JSON.parse(logged.after_json)).toEqual({ retailPrice: 425_000 })
  })

  it('does not log a price change when the price did not change', () => {
    const { product } = products.create(t.db, actor, legacyItem())

    products.update(t.db, actor, { id: product.id, retailPrice: RETAIL, name: 'Cooking Oil 5 Litre' })

    expect(audit.list(t.db, { action: 'product.price_change' }).rows).toHaveLength(0)
    expect(products.getById(t.db, product.id).product.name).toBe('Cooking Oil 5 Litre')
  })

  it('refuses to move a stock code onto an item that already has it', () => {
    products.create(t.db, actor, legacyItem())
    const { product } = products.create(t.db, actor, legacyItem({ sku: 'STK-002' }))

    expectUserMessage(
      () => products.update(t.db, actor, { id: product.id, sku: 'STK-001' }),
      /already used/i
    )
    expect(products.getById(t.db, product.id).product.sku).toBe('STK-002')
  })
})

describe('deactivate — never delete: last year’s sale still has to print', () => {
  it('hides the item from the list but keeps the row readable forever', () => {
    const { product } = products.create(t.db, actor, legacyItem())

    products.deactivate(t.db, actor, product.id)

    // Gone from the list the cashier picks from...
    expect(products.list(t.db).rows.map((r) => r.sku)).not.toContain('STK-001')

    // ...but the row is still there, still readable, still named. A sale from last year points at
    // this row, and its receipt must still print with the right name on it.
    const detail = products.getById(t.db, product.id)
    expect(detail.product.isActive).toBe(false)
    expect(detail.product.name).toBe('Cooking Oil 5L')
    expect(detail.product.retailPrice).toBe(RETAIL)

    expect(products.list(t.db, { includeInactive: true }).rows.map((r) => r.sku)).toContain('STK-001')
  })

  it('can be brought back', () => {
    const { product } = products.create(t.db, actor, legacyItem())
    products.deactivate(t.db, actor, product.id)

    products.update(t.db, actor, { id: product.id, isActive: true })
    expect(products.list(t.db).rows.map((r) => r.sku)).toContain('STK-001')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('list — paginated, searchable, and never an unbounded SELECT *', () => {
  beforeEach(() => {
    products.create(
      t.db,
      actor,
      legacyItem({
        barcodes: ['8964000111222'],
        packs: [{ uomId: uom('carton'), packSize: 24 * ONE_UNIT, barcode: '8964000111239' }]
      })
    )
    products.create(t.db, actor, legacyItem({ sku: 'STK-002', name: 'Basmati Rice 5kg' }))
    products.create(t.db, actor, legacyItem({ sku: 'STK-003', name: 'Sugar 1kg' }))
  })

  it('finds an item by NAME', () => {
    const found = products.list(t.db, { search: 'rice' })
    expect(found.total).toBe(1)
    expect(found.rows[0]!.name).toBe('Basmati Rice 5kg')
  })

  it('finds an item by STOCK CODE', () => {
    const found = products.list(t.db, { search: 'STK-003' })
    expect(found.total).toBe(1)
    expect(found.rows[0]!.name).toBe('Sugar 1kg')
  })

  it('finds an item by BARCODE — the scan, and the partial type-in', () => {
    expect(products.list(t.db, { search: '8964000111222' }).rows[0]!.sku).toBe('STK-001')
    expect(products.list(t.db, { search: '896400011' }).total).toBe(1) // prefix, rides the index
  })

  it('finds an item by its PACKING’s barcode — a carton scans too', () => {
    const found = products.list(t.db, { search: '8964000111239' })
    expect(found.total).toBe(1)
    expect(found.rows[0]!.sku).toBe('STK-001')
  })

  it('carries the derived stock and the primary barcode, so the list needs no second call', () => {
    const stk1 = products.findBySku(t.db, 'STK-001')!
    move(stk1.id, 7 * ONE_UNIT, 'opening')

    const row = products.list(t.db, { search: 'STK-001' }).rows[0]!
    expect(row.onHandM).toBe(7 * ONE_UNIT)
    expect(row.primaryBarcode).toBe('8964000111222')
    expect(row.categoryLabel).toBe('General')
  })

  it('pages — assume 100k rows, never load them all', () => {
    const first = products.list(t.db, { page: 1, pageSize: 2, sortBy: 'sku' })
    expect(first.total).toBe(3) // the true total, not the page size
    expect(first.rows).toHaveLength(2)
    expect(first.rows.map((r) => r.sku)).toEqual(['STK-001', 'STK-002'])

    const second = products.list(t.db, { page: 2, pageSize: 2, sortBy: 'sku' })
    expect(second.rows.map((r) => r.sku)).toEqual(['STK-003'])
  })

  it('sorts by the DERIVED stock figure', () => {
    const rice = products.findBySku(t.db, 'STK-002')!
    const sugar = products.findBySku(t.db, 'STK-003')!
    move(rice.id, 9 * ONE_UNIT, 'opening')
    move(sugar.id, 2 * ONE_UNIT, 'opening')

    const rows = products.list(t.db, { sortBy: 'on_hand', sortDir: 'desc' }).rows
    expect(rows.map((r) => r.sku)).toEqual(['STK-002', 'STK-003', 'STK-001'])
  })

  it('lists only what is at or below its re-order level', () => {
    const oil = products.findBySku(t.db, 'STK-001')! // re-order level 5
    move(oil.id, 40 * ONE_UNIT, 'opening')

    const low = products.list(t.db, { belowReorderOnly: true })
    expect(low.rows.map((r) => r.sku).sort()).toEqual(['STK-002', 'STK-003'])
  })

  /**
   * REGRESSION. A NON-INVENTORY item is never "below its re-order level".
   *
   * A bag charge has no stock and a re-order level of 0, so the naive predicate `on_hand <= min_stock`
   * read `0 <= 0` and flagged EVERY service and every charge in the shop as needing to be re-ordered —
   * forever, and in a list the owner uses to decide what to go and buy. The genuinely empty shelves
   * were buried among things that can never be bought.
   *
   * The stock service already excluded non-inventory items from its reports. This list did not, so the
   * two screens disagreed about the same item. The flag and the filter are now the SAME predicate, and
   * that predicate includes item_type.
   */
  it('a NON-INVENTORY item is never below its re-order level — it has no stock to run out of', () => {
    products.create(
      t.db,
      actor,
      legacyItem({
        sku: 'BAG-001',
        name: 'Carrier Bag',
        itemType: 'non_inventory',
        minStockM: 0
      })
    )

    // The row's own flag.
    const bag = products.list(t.db, { search: 'BAG-001' }).rows[0]!
    expect(bag.itemType).toBe('non_inventory')
    expect(bag.isBelowReorder).toBe(false)

    // And the filter, which must agree with the flag.
    const low = products.list(t.db, { belowReorderOnly: true })
    expect(low.rows.map((r) => r.sku)).not.toContain('BAG-001')

    // The same item is absent from the stock service's report — the two now tell the same story.
    expect(stock.lowStock(t.db, {}).rows.map((r) => r.sku)).not.toContain('BAG-001')
  })

  /**
   * A REAL SHOP ASKED FOR THIS. They search by name, by barcode — and by the SHELF, because the
   * question at the shelf is "what is meant to be here?". Name, SKU, the Urdu name and barcodes were
   * all searchable; the shelf was the one term they had that found nothing.
   */
  it('finds an item by the SHELF it sits on', () => {
    const now = new Date().toISOString()
    const shelf = Number(
      t.db
        .prepare(
          `INSERT INTO lookups (list_key, code, label, sort_order, is_active, is_system, created_at, updated_at)
           VALUES ('location', 'a3', 'Aisle 3 — Top Shelf', 0, 1, 0, ?, ?)`
        )
        .run(now, now).lastInsertRowid
    )

    products.create(t.db, actor, legacyItem({ sku: 'SHELF-1', name: 'Rice 5kg', locationId: shelf }))
    products.create(t.db, actor, legacyItem({ sku: 'SHELF-2', name: 'Soap' })) // no shelf

    const found = products.list(t.db, { search: 'Aisle 3' })
    expect(found.rows.map((r) => r.sku), 'searching the shelf name finds what is on it').toEqual([
      'SHELF-1'
    ])

    // And it did not break the searches that already worked.
    expect(products.list(t.db, { search: 'Soap' }).rows.map((r) => r.sku)).toEqual(['SHELF-2'])
    expect(products.list(t.db, { search: 'SHELF-1' }).rows.map((r) => r.sku)).toEqual(['SHELF-1'])
  })

  it('does not treat a search term’s % as a wildcard', () => {
    products.create(t.db, actor, legacyItem({ sku: 'STK-004', name: '50% Off Bundle' }))

    // Without ESCAPE, "%" in the term would match every product in the shop.
    const found = products.list(t.db, { search: '50%' })
    expect(found.total).toBe(1)
    expect(found.rows[0]!.sku).toBe('STK-004')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('variants — one group, many children, each a real product', () => {
  it('gives every child its own stock code, barcode, price and STOCK', () => {
    const group = products.createVariantGroup(t.db, actor, {
      name: 'T-Shirt',
      attributeKeys: ['size', 'colour']
    })

    const medium = products.create(
      t.db,
      actor,
      legacyItem({
        sku: 'TSH-M-RED',
        name: 'T-Shirt / M / Red',
        variantGroupId: group.id,
        attributes: { size: 'M', colour: 'red' },
        retailPrice: parseMoney('1200.00')!,
        barcodes: ['2000000000017']
      })
    )

    const large = products.create(
      t.db,
      actor,
      legacyItem({
        sku: 'TSH-L-RED',
        name: 'T-Shirt / L / Red',
        variantGroupId: group.id,
        attributes: { size: 'L', colour: 'red' },
        retailPrice: parseMoney('1350.00')!, // a larger shirt costs more — its OWN price
        barcodes: ['2000000000024']
      })
    )

    move(medium.product.id, 4 * ONE_UNIT, 'opening')
    move(large.product.id, 1 * ONE_UNIT, 'opening')

    const children = products.listVariants(t.db, group.id)
    expect(children.map((c) => c.sku)).toEqual(['TSH-L-RED', 'TSH-M-RED'])

    // Each child is a real product: its own stock code, its own barcode, its own price, its own stock.
    expect(stock.onHand(t.db, medium.product.id)).toBe(4 * ONE_UNIT)
    expect(stock.onHand(t.db, large.product.id)).toBe(1 * ONE_UNIT)
    expect(large.product.retailPrice).toBe(135_000)
    expect(products.getById(t.db, large.product.id).barcodes[0]!.barcode).toBe('2000000000024')
    expect(medium.product.attributes).toEqual({ size: 'M', colour: 'red' })
  })

  it('refuses a child that varies on an axis its group does not have', () => {
    const group = products.createVariantGroup(t.db, actor, {
      name: 'T-Shirt',
      attributeKeys: ['size', 'colour']
    })

    expectUserMessage(
      () =>
        products.create(
          t.db,
          actor,
          legacyItem({
            sku: 'TSH-MANGO',
            variantGroupId: group.id,
            attributes: { flavour: 'mango' }
          })
        ),
      /do not have a "flavour"/i
    )
  })
})
