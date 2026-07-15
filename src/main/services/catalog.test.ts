import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import type { DB } from '../db'
import type { User } from '@shared/types'
import * as catalog from './catalog'
// The supplier RECORD service (create/getById/...) is canonical and lives here. The product↔supplier
// LINK tests below still need real supplier rows to link to, so they create them through it.
import * as suppliers from './suppliers'
import { ONE_UNIT } from '@shared/qty'

/**
 * CATALOG — barcodes, packs, suppliers, batches, serials.
 *
 * The tests that matter most in this file are the ones that protect a cashier standing at a counter
 * with a queue behind them:
 *
 *   • an OLD barcode still scans after it has been replaced   (the tins are already on the shelf)
 *   • a PACK barcode resolves to the product AND its pack size (one carton = 24 pieces of stock)
 *   • the same barcode can never mean two different items      (or the scanner is a coin toss)
 *   • a serial number can never be recorded twice              (or two people own one phone)
 *
 * Products are inserted with raw SQL here on purpose: this service does not own the products table,
 * and these tests must not depend on the product service's shape to prove a barcode still scans.
 */

// ── Fixtures ─────────────────────────────────────────────────────────────────

function uomId(db: DB, code: string): number {
  return db
    .prepare(`SELECT id FROM lookups WHERE list_key = 'uom' AND code = ?`)
    .pluck()
    .get(code) as number
}

type ProductOverrides = {
  sku?: string
  name?: string
  uom?: string
  costPrice?: number
  retailPrice?: number
  trackBatches?: boolean
  trackSerials?: boolean
}

function makeProduct(db: DB, over: ProductOverrides = {}): number {
  const now = new Date().toISOString()
  return Number(
    db
      .prepare(
        `INSERT INTO products
           (sku, name, sale_uom_id, cost_price, retail_price, wholesale_price,
            track_batches, track_serials, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
      )
      .run(
        over.sku ?? `SKU-${Math.random().toString(36).slice(2, 10)}`,
        over.name ?? 'Test Item',
        uomId(db, over.uom ?? 'pcs'),
        over.costPrice ?? 0,
        over.retailPrice ?? 0,
        over.trackBatches ? 1 : 0,
        over.trackSerials ? 1 : 0,
        now,
        now
      ).lastInsertRowid
  )
}

function makeUser(db: DB, fullName = 'Ali the Manager', role = 'manager'): number {
  const now = new Date().toISOString()
  return Number(
    db
      .prepare(
        `INSERT INTO users (username, full_name, role, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, 'x', ?, ?)`
      )
      .run(fullName.toLowerCase().replace(/\s+/g, '.'), fullName, role, now, now).lastInsertRowid
  )
}

/**
 * STOCK IS DERIVED. There is no stock column to read — on-hand is the sum of the movements, and that
 * is exactly how the test reads it, so nothing here can quietly disagree with the history.
 */
function onHandM(db: DB, productId: number): number {
  return db
    .prepare('SELECT COALESCE(SUM(qty_m), 0) FROM stock_movements WHERE product_id = ?')
    .pluck()
    .get(productId) as number
}

/** Stand-in for the sale/purchase services, which don't exist until Phases 5 and 7. */
function postMovement(db: DB, productId: number, qtyM: number, type = 'purchase'): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO stock_movements (at, type, product_id, qty_m, unit_cost, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`
  ).run(now, type, productId, qtyM, now)
}

// ═════════════════════════════════════════════════════════════════════════════

describe('barcodes', () => {
  let t: TestDb
  beforeEach(() => (t = makeTestDb({ withSeed: true })))
  afterEach(() => t.cleanup())

  it('scans: one indexed lookup finds the item', () => {
    const id = makeProduct(t.db, { name: 'Coke 1.5L', sku: 'COKE15' })
    catalog.addBarcode(t.db, { productId: id, barcode: '8964000123456' })

    const match = catalog.findProductByBarcode(t.db, '8964000123456')

    expect(match).not.toBeNull()
    expect(match!.product.id).toBe(id)
    expect(match!.product.name).toBe('Coke 1.5L')
    expect(match!.pack).toBeNull() // a plain barcode sells ONE base unit
  })

  it('an unknown barcode returns null — it is not an error', () => {
    // A customer's loyalty card, a coupon, a smudged label. This happens fifty times a week and it
    // must never throw a red box at a cashier with a queue.
    expect(catalog.findProductByBarcode(t.db, '0000000000000')).toBeNull()
  })

  it('trims what the scanner appends', () => {
    const id = makeProduct(t.db)
    catalog.addBarcode(t.db, { productId: id, barcode: '5000112637922' })

    expect(catalog.findProductByBarcode(t.db, '  5000112637922\n')!.product.id).toBe(id)
  })

  it('ONE PRODUCT, MANY BARCODES — every one of them scans', () => {
    // The same item arrives from two suppliers with two different EANs, plus the shop prints its own.
    const id = makeProduct(t.db, { name: 'Surf Excel 1kg' })

    catalog.addBarcode(t.db, { productId: id, barcode: 'EAN-A' })
    catalog.addBarcode(t.db, { productId: id, barcode: 'EAN-B' })
    catalog.addBarcode(t.db, { productId: id, barcode: 'SHOP-PRINTED-001' })

    for (const code of ['EAN-A', 'EAN-B', 'SHOP-PRINTED-001']) {
      expect(catalog.findProductByBarcode(t.db, code)!.product.id).toBe(id)
    }

    const all = catalog.listBarcodes(t.db, id)
    expect(all).toHaveLength(3)
    // The first one added became primary — that is the one printed on a new label.
    expect(all.filter((b) => b.isPrimary).map((b) => b.barcode)).toEqual(['EAN-A'])
  })

  it('REFUSES the same barcode on a DIFFERENT product — the scanner cannot be ambiguous', () => {
    // This is the whole reason the check exists: one beep must have exactly one answer. If two
    // products share a code the till rings up whichever row SQLite happened to return.
    const coke = makeProduct(t.db, { name: 'Coke 1.5L', sku: 'COKE15' })
    const pepsi = makeProduct(t.db, { name: 'Pepsi 1.5L', sku: 'PEPSI15' })

    catalog.addBarcode(t.db, { productId: coke, barcode: 'DUPLICATE-1' })

    expectUserMessage(
      () => catalog.addBarcode(t.db, { productId: pepsi, barcode: 'DUPLICATE-1' }),
      /already used by Coke 1\.5L/i
    )

    // ...and the original still resolves to the original item, untouched.
    expect(catalog.findProductByBarcode(t.db, 'DUPLICATE-1')!.product.id).toBe(coke)
  })

  it('REFUSES a barcode that is already a PACK barcode on another product (cross-table)', () => {
    // SQLite cannot enforce uniqueness across product_barcodes and product_packs. The service must,
    // or a code could sell one piece of item A and a carton of item B depending on which table won.
    const a = makeProduct(t.db, { name: 'Item A' })
    const b = makeProduct(t.db, { name: 'Item B' })

    catalog.addPack(t.db, {
      productId: a,
      uomId: uomId(t.db, 'carton'),
      packSize: 24 * ONE_UNIT,
      barcode: 'CROSS-TABLE-1'
    })

    expectUserMessage(
      () => catalog.addBarcode(t.db, { productId: b, barcode: 'CROSS-TABLE-1' }),
      /already used by a pack of Item A/i
    )
  })

  it('REFUSES a pack barcode that is already a plain product barcode (cross-table, the other way)', () => {
    const a = makeProduct(t.db, { name: 'Item A' })
    const b = makeProduct(t.db, { name: 'Item B' })

    catalog.addBarcode(t.db, { productId: a, barcode: 'CROSS-TABLE-2' })

    expectUserMessage(
      () =>
        catalog.addPack(t.db, {
          productId: b,
          uomId: uomId(t.db, 'carton'),
          packSize: 24 * ONE_UNIT,
          barcode: 'CROSS-TABLE-2'
        }),
      /already used by Item A/i
    )
  })

  it('refuses the same barcode twice on the SAME product too', () => {
    const id = makeProduct(t.db, { name: 'Item A' })
    catalog.addBarcode(t.db, { productId: id, barcode: 'SAME-1' })

    expectUserMessage(
      () => catalog.addBarcode(t.db, { productId: id, barcode: 'SAME-1' }),
      /already used by Item A/i
    )
  })
})

// ═════════════════════════════════════════════════════════════════════════════

describe('REPLACE BARCODE — the old label must never stop scanning', () => {
  let t: TestDb
  beforeEach(() => (t = makeTestDb({ withSeed: true })))
  afterEach(() => t.cleanup())

  it('THE OLD BARCODE STILL SCANS AFTER IT HAS BEEN REPLACED', () => {
    // THE POINT OF THE WHOLE FEATURE.
    //
    // The supplier reprints the label with a new number. Forty tins carrying the OLD number are
    // already stuck on the shelf. Tomorrow a customer brings one to the counter. It MUST scan — and
    // it must still scan next month, and next year, until the last one is sold.
    const id = makeProduct(t.db, { name: 'Nestle Milk Pak 1L' })
    catalog.addBarcode(t.db, { productId: id, barcode: 'OLD-LABEL-8964' })

    catalog.replaceBarcode(t.db, {
      productId: id,
      oldBarcode: 'OLD-LABEL-8964',
      newBarcode: 'NEW-LABEL-8965'
    })

    // THE OLD ONE. This assertion is the feature.
    const old = catalog.findProductByBarcode(t.db, 'OLD-LABEL-8964')
    expect(old).not.toBeNull()
    expect(old!.product.id).toBe(id)
    expect(old!.product.name).toBe('Nestle Milk Pak 1L')

    // And the new one, obviously.
    expect(catalog.findProductByBarcode(t.db, 'NEW-LABEL-8965')!.product.id).toBe(id)

    // Both rows are still there. Nothing was deleted. Nothing is ever deleted.
    expect(catalog.listBarcodes(t.db, id).map((b) => b.barcode).sort()).toEqual([
      'NEW-LABEL-8965',
      'OLD-LABEL-8964'
    ])
  })

  it('the NEW barcode becomes the one printed on new labels; the old is demoted, not removed', () => {
    const id = makeProduct(t.db)
    catalog.addBarcode(t.db, { productId: id, barcode: 'OLD-1' })

    const result = catalog.replaceBarcode(t.db, {
      productId: id,
      oldBarcode: 'OLD-1',
      newBarcode: 'NEW-1'
    })

    expect(result.new.isPrimary).toBe(true)
    expect(result.old.isPrimary).toBe(false) // demoted — still scans, just isn't printed

    const primaries = catalog.listBarcodes(t.db, id).filter((b) => b.isPrimary)
    expect(primaries).toHaveLength(1)
    expect(primaries[0]!.barcode).toBe('NEW-1')
  })

  it('records WHO swapped WHICH code for WHICH, and WHEN', () => {
    const id = makeProduct(t.db)
    const userId = makeUser(t.db)
    catalog.addBarcode(t.db, { productId: id, barcode: 'OLD-2' })

    catalog.replaceBarcode(t.db, { productId: id, oldBarcode: 'OLD-2', newBarcode: 'NEW-2' }, userId)

    const history = catalog.listBarcodeReplacements(t.db, id)
    expect(history).toHaveLength(1)
    expect(history[0]!.oldBarcode).toBe('OLD-2')
    expect(history[0]!.newBarcode).toBe('NEW-2')
    expect(history[0]!.userId).toBe(userId)
    expect(history[0]!.at).toBeTruthy()
  })

  it('survives being replaced twice — every generation of label still scans', () => {
    // A code can be reprinted more than once over an item's life. Stock from all three printings can
    // be on the shelf at the same time.
    const id = makeProduct(t.db)
    catalog.addBarcode(t.db, { productId: id, barcode: 'GEN-1' })

    catalog.replaceBarcode(t.db, { productId: id, oldBarcode: 'GEN-1', newBarcode: 'GEN-2' })
    catalog.replaceBarcode(t.db, { productId: id, oldBarcode: 'GEN-2', newBarcode: 'GEN-3' })

    for (const code of ['GEN-1', 'GEN-2', 'GEN-3']) {
      expect(catalog.findProductByBarcode(t.db, code)!.product.id).toBe(id)
    }
    expect(catalog.listBarcodes(t.db, id).filter((b) => b.isPrimary)[0]!.barcode).toBe('GEN-3')
  })

  it('refuses to replace a barcode that does not belong to this item', () => {
    const a = makeProduct(t.db)
    const b = makeProduct(t.db)
    catalog.addBarcode(t.db, { productId: a, barcode: 'BELONGS-TO-A' })

    expectUserMessage(
      () =>
        catalog.replaceBarcode(t.db, {
          productId: b,
          oldBarcode: 'BELONGS-TO-A',
          newBarcode: 'WHATEVER'
        }),
      /not one of this item's barcodes/i
    )
  })

  it('refuses a new barcode that already belongs to something else', () => {
    const a = makeProduct(t.db, { name: 'Item A' })
    const b = makeProduct(t.db, { name: 'Item B' })
    catalog.addBarcode(t.db, { productId: a, barcode: 'A-1' })
    catalog.addBarcode(t.db, { productId: b, barcode: 'B-1' })

    expectUserMessage(
      () => catalog.replaceBarcode(t.db, { productId: a, oldBarcode: 'A-1', newBarcode: 'B-1' }),
      /already used by Item B/i
    )

    // Nothing was half-done: A still has exactly its one code, and it still scans.
    expect(catalog.listBarcodes(t.db, a)).toHaveLength(1)
    expect(catalog.findProductByBarcode(t.db, 'A-1')!.product.id).toBe(a)
  })
})

// ═════════════════════════════════════════════════════════════════════════════

describe('packs — buy a carton, sell a piece', () => {
  let t: TestDb
  beforeEach(() => (t = makeTestDb({ withSeed: true })))
  afterEach(() => t.cleanup())

  it('A PACK BARCODE RESOLVES TO THE PRODUCT AND ITS PACK SIZE — one carton moves 24 PIECES', () => {
    // Scanning the carton must not sell one piece at the carton price, and must not take one piece
    // off the shelf. It sells the PACK: 24 base units, at the PACK's own price.
    const id = makeProduct(t.db, { name: 'Coke 1.5L', sku: 'COKE15' })

    catalog.addPack(t.db, {
      productId: id,
      uomId: uomId(t.db, 'pcs'),
      packSize: ONE_UNIT, // the base unit itself: 1 piece
      cost: 910_417, // 4-dp cost: Rs 91.0417 a piece
      retailPrice: 12_000, // 2-dp money: Rs 120.00
      isBase: true
    })

    const carton = catalog.addPack(t.db, {
      productId: id,
      uomId: uomId(t.db, 'carton'),
      packSize: 24 * ONE_UNIT, // 24 pieces = 24000 qty_m, NOT 24
      cost: 21_850_000, // Rs 2185.0000 for the carton
      retailPrice: 275_000, // Rs 2750.00 — a carton is NOT 24 x the piece price
      barcode: 'CARTON-8964'
    })

    // 100 pieces on the shelf.
    postMovement(t.db, id, 100 * ONE_UNIT)
    expect(onHandM(t.db, id)).toBe(100_000)

    // The cashier scans the carton.
    const match = catalog.findProductByBarcode(t.db, 'CARTON-8964')

    expect(match).not.toBeNull()
    expect(match!.product.id).toBe(id) // …the PRODUCT, and…
    expect(match!.pack).not.toBeNull() // …the PACK it was scanned as.
    expect(match!.pack!.id).toBe(carton.id)
    expect(match!.pack!.packSize).toBe(24_000) // 24 pieces, in qty_m
    expect(match!.pack!.retailPrice).toBe(275_000) // the CARTON's price, not the piece's

    // The sale moves the pack size — this is the multiplier the whole feature exists to supply.
    postMovement(t.db, match!.product.id, -match!.pack!.packSize, 'sale')

    expect(onHandM(t.db, id)).toBe(100_000 - 24_000) // 76 pieces left, not 99
  })

  it('each pack carries its OWN cost, retail, wholesale and barcode', () => {
    const id = makeProduct(t.db)

    catalog.addPack(t.db, {
      productId: id,
      uomId: uomId(t.db, 'pcs'),
      packSize: ONE_UNIT,
      cost: 910_417,
      retailPrice: 12_000,
      wholesalePrice: 11_000,
      barcode: 'PIECE-1',
      isBase: true
    })
    catalog.addPack(t.db, {
      productId: id,
      uomId: uomId(t.db, 'box'),
      packSize: 6 * ONE_UNIT,
      cost: 5_462_500,
      retailPrice: 70_000,
      wholesalePrice: 66_000,
      barcode: 'BOX-1'
    })
    catalog.addPack(t.db, {
      productId: id,
      uomId: uomId(t.db, 'carton'),
      packSize: 24 * ONE_UNIT,
      cost: 21_850_000,
      retailPrice: 275_000,
      wholesalePrice: 260_000,
      barcode: 'CARTON-1'
    })

    const packs = catalog.listPacks(t.db, id)
    expect(packs).toHaveLength(3)
    expect(packs[0]!.isBase).toBe(true) // base unit first

    // Every one of the three scans, and each brings its own size and its own price.
    expect(catalog.findProductByBarcode(t.db, 'PIECE-1')!.pack!.packSize).toBe(1_000)
    expect(catalog.findProductByBarcode(t.db, 'BOX-1')!.pack!.retailPrice).toBe(70_000)
    expect(catalog.findProductByBarcode(t.db, 'CARTON-1')!.pack!.cost).toBe(21_850_000)
  })

  it('updates a pack in place without touching its barcode', () => {
    const id = makeProduct(t.db)
    const pack = catalog.addPack(t.db, {
      productId: id,
      uomId: uomId(t.db, 'carton'),
      packSize: 24 * ONE_UNIT,
      retailPrice: 275_000,
      barcode: 'CARTON-2'
    })

    const updated = catalog.updatePack(t.db, {
      id: pack.id,
      productId: id,
      uomId: uomId(t.db, 'carton'),
      packSize: 24 * ONE_UNIT,
      retailPrice: 290_000, // price went up
      barcode: 'CARTON-2' // keeping its own barcode must not trip the uniqueness check
    })

    expect(updated.retailPrice).toBe(290_000)
    expect(catalog.findProductByBarcode(t.db, 'CARTON-2')!.pack!.retailPrice).toBe(290_000)
  })

  it('keeps exactly one base pack per product', () => {
    const id = makeProduct(t.db)

    catalog.addPack(t.db, {
      productId: id,
      uomId: uomId(t.db, 'pcs'),
      packSize: ONE_UNIT,
      isBase: true
    })
    catalog.addPack(t.db, {
      productId: id,
      uomId: uomId(t.db, 'kg'),
      packSize: ONE_UNIT,
      isBase: true // promoting a new base must demote the old one, not blow up on the index
    })

    const bases = catalog.listPacks(t.db, id).filter((p) => p.isBase)
    expect(bases).toHaveLength(1)
    expect(bases[0]!.uomId).toBe(uomId(t.db, 'kg'))
  })

  it('refuses a base pack that holds more than one base unit', () => {
    const id = makeProduct(t.db)

    expectUserMessage(
      () =>
        catalog.addPack(t.db, {
          productId: id,
          uomId: uomId(t.db, 'carton'),
          packSize: 24 * ONE_UNIT,
          isBase: true
        }),
      /must hold exactly 1/i
    )
  })

  it('refuses two packs in the same unit — "sell as Carton" must mean one thing', () => {
    const id = makeProduct(t.db)
    catalog.addPack(t.db, {
      productId: id,
      uomId: uomId(t.db, 'carton'),
      packSize: 24 * ONE_UNIT
    })

    expectUserMessage(
      () =>
        catalog.addPack(t.db, {
          productId: id,
          uomId: uomId(t.db, 'carton'),
          packSize: 12 * ONE_UNIT
        }),
      /already has a pack in that unit/i
    )
  })

  it('refuses a pack that holds nothing', () => {
    const id = makeProduct(t.db)
    expectUserMessage(
      () => catalog.addPack(t.db, { productId: id, uomId: uomId(t.db, 'box'), packSize: 0 }),
      /at least some of the base unit/i
    )
  })
})

// ═════════════════════════════════════════════════════════════════════════════

describe('suppliers — one product, many suppliers, each with their OWN code and price', () => {
  let t: TestDb
  let actor: User

  // The supplier RECORD CRUD (create/update/list/getById) is tested in suppliers.test.ts — the mirror
  // of customers. Here we only prove the product↔supplier LINK, so we create real supplier rows through
  // the canonical service and then link products to them.
  beforeEach(() => {
    t = makeTestDb({ withSeed: true })
    const id = makeUser(t.db)
    actor = {
      id,
      username: 'ali.the.manager',
      fullName: 'Ali the Manager',
      role: 'manager',
      hasPin: false,
      isActive: true
    }
  })
  afterEach(() => t.cleanup())

  it('SEVERAL SUPPLIERS FOR ONE PRODUCT, EACH WITH A DIFFERENT ITEM CODE AND PRICE', () => {
    // The supplier's invoice arrives with THEIR code on it. Without this the shop cannot match the
    // invoice back to the product it bought.
    const id = makeProduct(t.db, { name: 'Coke 1.5L' })

    const metro = suppliers.create(t.db, actor, { name: 'Metro Cash & Carry', phone: '0300-1234567' })
    const imtiaz = suppliers.create(t.db, actor, { name: 'Imtiaz Wholesale' })
    const local = suppliers.create(t.db, actor, { name: 'Local Distributor' })

    catalog.linkSupplierToProduct(t.db, {
      productId: id,
      supplierId: metro.id,
      supplierItemCode: 'MET-COKE-15',
      supplierPrice: 21_850_000, // Rs 2185.0000, 4-dp cost
      discountBp: 500 // 5%
    })
    catalog.linkSupplierToProduct(t.db, {
      productId: id,
      supplierId: imtiaz.id,
      supplierItemCode: 'IMT/778/COKE',
      supplierPrice: 22_100_000
    })
    catalog.linkSupplierToProduct(t.db, {
      productId: id,
      supplierId: local.id,
      supplierItemCode: 'C-15',
      supplierPrice: 21_500_000,
      isPreferred: true // the cheapest one is the default on the purchase form
    })

    const links = catalog.listSuppliersForProduct(t.db, id)
    expect(links).toHaveLength(3)

    const byName = Object.fromEntries(links.map((l) => [l.supplierName, l]))
    expect(byName['Metro Cash & Carry']!.supplierItemCode).toBe('MET-COKE-15')
    expect(byName['Metro Cash & Carry']!.supplierPrice).toBe(21_850_000)
    expect(byName['Metro Cash & Carry']!.discountBp).toBe(500)
    expect(byName['Imtiaz Wholesale']!.supplierItemCode).toBe('IMT/778/COKE')
    expect(byName['Imtiaz Wholesale']!.supplierPrice).toBe(22_100_000)
    expect(byName['Local Distributor']!.supplierItemCode).toBe('C-15')

    // Exactly one preferred, and it is the last one marked — preferred first in the list.
    expect(links.filter((l) => l.isPreferred)).toHaveLength(1)
    expect(links[0]!.supplierName).toBe('Local Distributor')
  })

  it('the first supplier linked becomes the preferred one', () => {
    const id = makeProduct(t.db)
    const s = suppliers.create(t.db, actor, { name: 'Only Supplier' })

    const link = catalog.linkSupplierToProduct(t.db, { productId: id, supplierId: s.id })
    expect(link.isPreferred).toBe(true)
  })

  it('linking the same supplier again EDITS the link instead of failing', () => {
    const id = makeProduct(t.db)
    const s = suppliers.create(t.db, actor, { name: 'Metro' })

    catalog.linkSupplierToProduct(t.db, {
      productId: id,
      supplierId: s.id,
      supplierItemCode: 'OLD-CODE',
      supplierPrice: 1_000_000
    })
    catalog.linkSupplierToProduct(t.db, {
      productId: id,
      supplierId: s.id,
      supplierItemCode: 'NEW-CODE',
      supplierPrice: 1_200_000
    })

    const links = catalog.listSuppliersForProduct(t.db, id)
    expect(links).toHaveLength(1) // not two rows for the same supplier
    expect(links[0]!.supplierItemCode).toBe('NEW-CODE')
    expect(links[0]!.supplierPrice).toBe(1_200_000)
  })

  it('one supplier supplies many products, each under its own code', () => {
    const coke = makeProduct(t.db, { name: 'Coke' })
    const pepsi = makeProduct(t.db, { name: 'Pepsi' })
    const metro = suppliers.create(t.db, actor, { name: 'Metro' })

    catalog.linkSupplierToProduct(t.db, {
      productId: coke,
      supplierId: metro.id,
      supplierItemCode: 'MET-1'
    })
    catalog.linkSupplierToProduct(t.db, {
      productId: pepsi,
      supplierId: metro.id,
      supplierItemCode: 'MET-2'
    })

    expect(catalog.listSuppliersForProduct(t.db, coke)[0]!.supplierItemCode).toBe('MET-1')
    expect(catalog.listSuppliersForProduct(t.db, pepsi)[0]!.supplierItemCode).toBe('MET-2')
  })

  // NOTE: the supplier RECORD tests that used to live here — pagination/search/active-only, and the
  // trap-#18 "an update writes only the fields the form sent" — moved WITH the CRUD itself to the
  // canonical service. They are covered by suppliers.test.ts ('the list is PAGINATED and searchable',
  // 'SAVES ONLY THE FIELDS THE FORM SENT', 'null means the user CLEARED it'). Not re-tested here.

  it('refuses to link a supplier that does not exist, in plain language', () => {
    const id = makeProduct(t.db)
    // linkSupplierToProduct proves the supplier exists via suppliers.getById — its plain-language
    // NOT_FOUND message is "That supplier could not be found. They may have been removed."
    expectUserMessage(
      () => catalog.linkSupplierToProduct(t.db, { productId: id, supplierId: 999 }),
      /supplier could not be found/i
    )
  })
})

// ═════════════════════════════════════════════════════════════════════════════

describe('batches', () => {
  let t: TestDb
  beforeEach(() => (t = makeTestDb({ withSeed: true })))
  afterEach(() => t.cleanup())

  it('records a batch number and an expiry date', () => {
    const id = makeProduct(t.db, { name: 'Panadol', trackBatches: true })

    const batch = catalog.addBatch(t.db, {
      productId: id,
      batchNo: 'B-2026-04',
      expiryDate: '2026-12-31',
      cost: 1_250_000
    })

    expect(batch.batchNo).toBe('B-2026-04')
    expect(batch.expiryDate).toBe('2026-12-31')
    expect(batch.cost).toBe(1_250_000) // 4-dp cost
  })

  it('BATCH NUMBERS ARE UNIQUE PER PRODUCT — but the same number may exist on another product', () => {
    const panadol = makeProduct(t.db, { name: 'Panadol', trackBatches: true })
    const brufen = makeProduct(t.db, { name: 'Brufen', trackBatches: true })

    catalog.addBatch(t.db, { productId: panadol, batchNo: 'B-001' })

    expectUserMessage(
      () => catalog.addBatch(t.db, { productId: panadol, batchNo: 'B-001' }),
      /already exists for this item/i
    )

    // Two manufacturers both calling a batch "B-001" is normal and must be allowed.
    expect(catalog.addBatch(t.db, { productId: brufen, batchNo: 'B-001' }).batchNo).toBe('B-001')
  })

  it('refuses a batch on an item that is not set up for batch tracking', () => {
    const id = makeProduct(t.db, { name: 'Coke 1.5L', trackBatches: false })
    expectUserMessage(
      () => catalog.addBatch(t.db, { productId: id, batchNo: 'B-1' }),
      /not set up for batch tracking/i
    )
  })

  it('NEAR EXPIRY: soonest first, already-expired included, with the qty still on hand', () => {
    const id = makeProduct(t.db, { name: 'Milk', trackBatches: true })
    const asOf = new Date('2026-07-14T00:00:00.000Z')

    const expired = catalog.addBatch(t.db, {
      productId: id,
      batchNo: 'GONE-OFF',
      expiryDate: '2026-07-01'
    })
    const soon = catalog.addBatch(t.db, {
      productId: id,
      batchNo: 'SOON',
      expiryDate: '2026-07-20'
    })
    catalog.addBatch(t.db, { productId: id, batchNo: 'LATER', expiryDate: '2027-01-01' })
    catalog.addBatch(t.db, { productId: id, batchNo: 'NEVER', expiryDate: null })

    // 10 units of the expired batch are still sitting on the shelf; 4 of the soon-to-expire one.
    t.db.prepare(
      `INSERT INTO stock_movements (at, type, product_id, batch_id, qty_m, unit_cost, created_at)
       VALUES (?, 'purchase', ?, ?, ?, 0, ?)`
    ).run(asOf.toISOString(), id, expired.id, 10 * 1000, asOf.toISOString())
    t.db.prepare(
      `INSERT INTO stock_movements (at, type, product_id, batch_id, qty_m, unit_cost, created_at)
       VALUES (?, 'purchase', ?, ?, ?, 0, ?)`
    ).run(asOf.toISOString(), id, soon.id, 4 * 1000, asOf.toISOString())

    const report = catalog.nearExpiry(t.db, { days: 30, asOf })

    expect(report.rows.map((r) => r.batchNo)).toEqual(['GONE-OFF', 'SOON'])
    expect(report.rows[0]!.isExpired).toBe(true)
    expect(report.rows[0]!.onHandM).toBe(10_000) // DERIVED from the movements, never a stored column
    expect(report.rows[1]!.isExpired).toBe(false)
    expect(report.rows[1]!.onHandM).toBe(4_000)
    expect(report.rows[0]!.productName).toBe('Milk')

    // A wider horizon reaches the January batch; nothing reaches the one that never expires.
    const wide = catalog.nearExpiry(t.db, { days: 365, asOf })
    expect(wide.rows.map((r) => r.batchNo)).toEqual(['GONE-OFF', 'SOON', 'LATER'])
  })

  it('lists batches for one product, paginated', () => {
    const id = makeProduct(t.db, { trackBatches: true })
    for (let i = 1; i <= 12; i++) {
      catalog.addBatch(t.db, { productId: id, batchNo: `B-${i}`, expiryDate: `2027-01-${i + 10}` })
    }

    const page = catalog.listBatches(t.db, { productId: id, page: 2, pageSize: 5 })
    expect(page.total).toBe(12)
    expect(page.rows).toHaveLength(5)
    expect(page.page).toBe(2)
  })
})

// ═════════════════════════════════════════════════════════════════════════════

describe('serial / IMEI numbers', () => {
  let t: TestDb
  beforeEach(() => (t = makeTestDb({ withSeed: true })))
  afterEach(() => t.cleanup())

  it('records serials against a serial-tracked product and finds one by scanning it', () => {
    const id = makeProduct(t.db, { name: 'Infinix Hot 40', trackSerials: true })

    catalog.addSerials(t.db, { productId: id, serials: ['IMEI-111', 'IMEI-222', 'IMEI-333'] })

    const match = catalog.findBySerial(t.db, 'IMEI-222')
    expect(match).not.toBeNull()
    expect(match!.product.id).toBe(id)
    expect(match!.product.name).toBe('Infinix Hot 40')
    expect(match!.serial.status).toBe('in_stock')

    expect(catalog.listSerials(t.db, { productId: id, status: 'in_stock' }).total).toBe(3)
    expect(catalog.findBySerial(t.db, 'NOT-A-SERIAL')).toBeNull()
  })

  it('A DUPLICATE SERIAL IS REJECTED — one IMEI is one physical handset', () => {
    const a = makeProduct(t.db, { name: 'Infinix Hot 40', trackSerials: true })
    const b = makeProduct(t.db, { name: 'Samsung A15', trackSerials: true })

    catalog.addSerial(t.db, { productId: a, serial: 'IMEI-DUP' })

    // Same product…
    expectUserMessage(
      () => catalog.addSerial(t.db, { productId: a, serial: 'IMEI-DUP' }),
      /already recorded for this item/i
    )

    // …and a different product. Two products cannot both own one handset.
    expectUserMessage(
      () => catalog.addSerial(t.db, { productId: b, serial: 'IMEI-DUP' }),
      /already recorded for Infinix Hot 40/i
    )

    expect(catalog.listSerials(t.db, {}).total).toBe(1)
  })

  it('a duplicate anywhere in a bulk scan inserts NOTHING — fix the one bad code and rescan', () => {
    const id = makeProduct(t.db, { trackSerials: true })
    catalog.addSerial(t.db, { productId: id, serial: 'IMEI-A' })

    expectUserMessage(
      () => catalog.addSerials(t.db, { productId: id, serials: ['IMEI-B', 'IMEI-A', 'IMEI-C'] }),
      /already recorded/i
    )

    // IMEI-B was scanned before the clash. It must NOT be half-in.
    expect(catalog.listSerials(t.db, {}).total).toBe(1)
    expect(catalog.findBySerial(t.db, 'IMEI-B')).toBeNull()
  })

  it('rejects a serial on an item that does not track serials — a tin of beans is one keystroke', () => {
    const id = makeProduct(t.db, { name: 'Coke 1.5L', trackSerials: false })

    expectUserMessage(
      () => catalog.addSerial(t.db, { productId: id, serial: 'WHY-DOES-A-COKE-HAVE-AN-IMEI' }),
      /not set up for serial number tracking/i
    )
  })

  it('marks a serial SOLD, once and only once', () => {
    const id = makeProduct(t.db, { trackSerials: true })
    catalog.addSerials(t.db, { productId: id, serials: ['IMEI-1', 'IMEI-2'] })

    const sold = catalog.markSold(t.db, { productId: id, serial: 'IMEI-1', saleId: 42 })

    expect(sold.status).toBe('sold')
    expect(sold.saleId).toBe(42)
    expect(catalog.findBySerial(t.db, 'IMEI-1')!.serial.status).toBe('sold')

    // Selling it twice would mean two customers walk out with the same phone.
    expectUserMessage(
      () => catalog.markSold(t.db, { productId: id, serial: 'IMEI-1', saleId: 43 }),
      /already been sold/i
    )

    // The other one is untouched and still sellable.
    expect(catalog.listSerials(t.db, { productId: id, status: 'in_stock' }).total).toBe(1)
  })

  it('refuses to sell a serial the shop has never seen', () => {
    const id = makeProduct(t.db, { trackSerials: true })
    expectUserMessage(
      () => catalog.markSold(t.db, { productId: id, serial: 'GHOST-IMEI' }),
      /is not in stock/i
    )
  })

  /**
   * REGRESSION. markSold took a serial and a sale id and never asked WHICH ITEM was being sold, so an
   * IMEI could be marked sold against a line for a completely different product: the phone on the line
   * left the shop untracked, while another handset still in the cabinet was marked sold and could never
   * be sold again. Both halves silent. The caller must now say what it thinks it is selling.
   */
  it('refuses a serial that belongs to a DIFFERENT product', () => {
    const phone = makeProduct(t.db, { trackSerials: true })
    const tablet = makeProduct(t.db, { trackSerials: true })
    catalog.addSerials(t.db, { productId: phone, serials: ['PHONE-IMEI'] })

    expectUserMessage(
      () => catalog.markSold(t.db, { productId: tablet, serial: 'PHONE-IMEI', saleId: 7 }),
      /does not belong|belongs to/i
    )

    // And it is STILL in stock — the wrong line did not quietly consume it.
    expect(catalog.findBySerial(t.db, 'PHONE-IMEI')!.serial.status).toBe('in_stock')
  })
})
