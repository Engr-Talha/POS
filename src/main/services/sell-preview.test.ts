import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, type TestDb } from '../db/testkit'
import * as sales from './sales'
import * as stock from './stock'
import * as catalog from './catalog'
import * as settings from './settings'
import { ONE_UNIT } from '@shared/qty'
import type { User } from '@shared/types'
import type { SaleLineInput } from '@shared/sales'
import {
  findShortages,
  infoKey,
  lineInfoFromScan,
  priceCart,
  type LineInfo,
  type TaxDefaults
} from '@shared/sell-preview'

/**
 * THE NUMBER ON THE SCREEN IS THE NUMBER ON THE PAPER.
 *
 * The Sell screen shows a running total as the cashier scans. `sales.complete()` decides what that total
 * actually IS — it re-resolves every price from the catalogue and freezes it. Those are two different
 * pieces of code looking at the same cart, and if they ever disagree the shop quotes one price at the
 * counter and charges another, and nobody can explain why.
 *
 * So every test in this file rings up the SAME CART twice:
 *
 *   1. through `shared/sell-preview.ts` — what the till DRAWS, built from real `scanBarcode()` answers
 *      through the very same `lineInfoFromScan` mapping the screen uses;
 *   2. through the REAL `sales.complete()` — what the customer is actually charged.
 *
 * and asserts they are identical TO THE PAISA — grand total, subtotal, tax, and every individual line.
 *
 * This is the test that would have caught a carton priced twenty-four times over, a weighed line rounded
 * the other way, or a cart discount that lost a rupee somewhere between the screen and the receipt.
 */

const RS_100 = 10_000 // 2-dp money
const COST = 600_000 // 4-dp cost
const GST = 1700 // 17%, basis points

let t: TestDb
let cashier: User
/** A discount over the threshold needs a supervisor standing at the till. Main enforces it; so be it. */
let supervisor: User

function makeUser(role: User['role'], username: string): User {
  const now = new Date().toISOString()
  const id = Number(
    t.db
      .prepare(
        `INSERT INTO users (username, full_name, role, password_hash, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 'x', 1, ?, ?)`
      )
      .run(username, username, role, now, now).lastInsertRowid
  )
  return { id, username, fullName: username, role, hasPin: false, isActive: true }
}

function lookupId(listKey: string, code: string): number {
  return t.db
    .prepare('SELECT id FROM lookups WHERE list_key = ? AND code = ?')
    .pluck()
    .get(listKey, code) as number
}

type MakeProduct = {
  name?: string
  retailPrice?: number
  taxRateBp?: number
  priceEntryMode?: 'inclusive' | 'exclusive'
  isTaxExempt?: boolean
  itemType?: 'inventory' | 'non_inventory'
  isWeighted?: boolean
  uom?: string
}

/** A product WITH a barcode — because the Sell screen only ever meets a product by scanning it. */
function makeProduct(barcode: string, options: MakeProduct = {}): number {
  const now = new Date().toISOString()

  const id = Number(
    t.db
      .prepare(
        `INSERT INTO products
           (sku, name, sale_uom_id, cost_price, retail_price, wholesale_price, tax_rate_bp,
            price_entry_mode, is_tax_exempt, item_type, is_weighted, track_batches, track_serials,
            is_active, created_at, updated_at)
         VALUES (@sku, @name, @uomId, 0, @retailPrice, 0, @taxRateBp,
                 @priceEntryMode, @isTaxExempt, @itemType, @isWeighted, 0, 0, 1, @now, @now)`
      )
      .run({
        sku: `SKU-${barcode}`,
        name: options.name ?? `Item ${barcode}`,
        uomId: lookupId('uom', options.uom ?? 'pcs'),
        retailPrice: options.retailPrice ?? RS_100,
        taxRateBp: options.taxRateBp ?? GST,
        priceEntryMode: options.priceEntryMode ?? 'exclusive',
        isTaxExempt: options.isTaxExempt ? 1 : 0,
        itemType: options.itemType ?? 'inventory',
        isWeighted: options.isWeighted ? 1 : 0,
        now
      }).lastInsertRowid
  )

  catalog.addBarcode(t.db, { productId: id, barcode })
  if ((options.itemType ?? 'inventory') === 'inventory') {
    stock.adjust(t.db, cashier, {
      productId: id,
      type: 'opening',
      qtyM: 1000 * ONE_UNIT,
      unitCost: COST,
      reasonCode: 'data_entry'
    })
  }
  return id
}

function taxDefaults(): TaxDefaults {
  return {
    taxEnabled: settings.get<boolean>(t.db, 'tax.enabled', true),
    defaultTaxRateBp: settings.get<number>(t.db, 'tax.defaultRateBp', GST),
    defaultTaxMode: settings.get<'inclusive' | 'exclusive'>(t.db, 'tax.defaultMode', 'exclusive')
  }
}

/**
 * Build the cart the way THE SCREEN builds it: scan each barcode, keep what came back, add the line.
 * Nothing here reaches into the database for a price — exactly like the renderer, which cannot.
 */
function scanInto(
  infos: Map<string, LineInfo>,
  barcode: string,
  extra: Partial<SaleLineInput> = {}
): SaleLineInput {
  const item = sales.scanBarcode(t.db, barcode)
  if (item == null) throw new Error(`fixture error: nothing has the barcode ${barcode}`)

  infos.set(infoKey(item), lineInfoFromScan(item, barcode))

  return {
    productId: item.productId,
    packId: item.packId,
    qtyM: item.qtyM,
    lineDiscount: 0,
    ...extra
  }
}

/**
 * THE ASSERTION. Ring the cart up for real, and prove the preview said the same thing.
 *
 * Checked at every level a customer or an auditor could look at: the grand total they pay, the subtotal
 * and tax the receipt breaks out, and each individual line.
 */
function expectPreviewMatchesTheSale(
  cart: SaleLineInput[],
  infos: Map<string, LineInfo>,
  cartDiscount = 0
): void {
  const preview = priceCart(cart, infos, cartDiscount, taxDefaults())

  const { sale } = sales.complete(t.db, cashier, {
    lines: cart,
    priceTier: 'retail',
    cartDiscount,
    ...(cartDiscount > 0 ? { cartDiscountReasonCode: 'bulk' } : {}),
    payments: [{ methodLookupId: lookupId('payment_method', 'cash'), amount: preview.grandTotal }],
    // A supervisor is standing at the till. Some of these carts discount hard enough to need one, and
    // main is right to insist — the point of this file is the ARITHMETIC, not the approval rules, which
    // sales.test.ts already covers.
    approvedByUserId: supervisor.id,
    acceptNegativeStock: true,
    acceptOverCreditLimit: true
  })

  expect(preview.grandTotal, 'the till showed a different TOTAL from the one it charged').toBe(
    sale.grandTotal
  )
  expect(preview.subtotalNet, 'the till showed a different SUBTOTAL from the receipt').toBe(
    sale.subtotalNet
  )
  expect(preview.taxTotal, 'the till showed a different TAX from the receipt').toBe(sale.taxTotal)

  expect(preview.lines).toHaveLength(sale.lines.length)

  sale.lines.forEach((frozen, index) => {
    const shown = preview.lines[index]!
    const where = `line ${index + 1} ("${frozen.nameSnapshot}")`

    expect(shown.gross, `${where}: the amount on screen is not the amount charged`).toBe(frozen.gross)
    expect(shown.net, `${where}: net`).toBe(frozen.net)
    expect(shown.tax, `${where}: tax`).toBe(frozen.taxAmount)
    expect(shown.unitPrice, `${where}: unit price`).toBe(frozen.unitPrice)
    expect(shown.taxRateBp, `${where}: tax rate`).toBe(frozen.taxRateBp)
  })

  // The invariant the API contract states out loud, and the one the cashier can check in their head:
  // the customer pays EXACTLY the discount less than the cart was worth.
  expect(preview.preDiscountGross - cartDiscount).toBe(sale.grandTotal)
}

beforeEach(() => {
  t = makeTestDb({ withSeed: true })
  cashier = makeUser('cashier', 'ali')
  supervisor = makeUser('supervisor', 'rashid')
})

afterEach(() => t.cleanup())

describe('the till predicts EXACTLY what main will charge', () => {
  beforeEach(() => {
    makeProduct('A1')
  })

  it('a plain line', () => {
    const infos = new Map<string, LineInfo>()
    const cart = [scanInto(infos, 'A1')]
    expectPreviewMatchesTheSale(cart, infos)
  })

  it('several of the same tin — the merge rule and the preview agree', () => {
    const infos = new Map<string, LineInfo>()
    const line = scanInto(infos, 'A1')
    const cart = sales.addLine(sales.addLine([], line), { ...line })

    expect(cart).toHaveLength(1)
    expect(cart[0]!.qtyM).toBe(2 * ONE_UNIT)

    expectPreviewMatchesTheSale(cart, infos)
  })

  it('MIXED tax modes in one cart — inclusive and exclusive side by side', () => {
    makeProduct('INC', { priceEntryMode: 'inclusive', retailPrice: 9_99 })
    makeProduct('EXEMPT', { isTaxExempt: true, retailPrice: 4_50 })

    const infos = new Map<string, LineInfo>()
    const cart = [
      scanInto(infos, 'A1'), // exclusive, 17%
      scanInto(infos, 'INC'), // inclusive, 17% — Rs 9.99 backs out to a half-paisa
      scanInto(infos, 'EXEMPT') // no tax at all
    ]

    expectPreviewMatchesTheSale(cart, infos)
  })

  it('a WEIGHED line — 1.234 kg at Rs 320.00/kg, exact to the paisa', () => {
    makeProduct('SUGAR', { isWeighted: true, retailPrice: 32_000, uom: 'kg' })

    const infos = new Map<string, LineInfo>()
    // The cashier reads the scale and types it. This is the number that a float would ruin.
    const cart = [scanInto(infos, 'SUGAR', { qtyM: 1_234 })]

    const preview = priceCart(cart, infos, 0, taxDefaults())
    expect(preview.lines[0]!.listGross).toBe(
      // 32000 x 1234 / 1000 = 39,488 paisa net, +17% = 46,201
      Math.round(39_488 * 1.17)
    )

    expectPreviewMatchesTheSale(cart, infos)
  })

  it('a CARTON — one scan sells 24 pieces at the carton price, and is not billed 24 times', () => {
    const productId = makeProduct('LOOSE')
    catalog.savePack(t.db, {
      productId,
      uomId: lookupId('uom', 'carton'),
      packSize: 24 * ONE_UNIT,
      cost: COST,
      retailPrice: 200_000, // Rs 2,000 the carton — NOT 24 x the piece price
      wholesalePrice: 0,
      barcode: 'CARTON-24'
    })

    const infos = new Map<string, LineInfo>()
    const cart = [scanInto(infos, 'CARTON-24')]

    // The line moves 24 pieces of stock…
    expect(cart[0]!.qtyM).toBe(24 * ONE_UNIT)
    // …but it is PRICED as one carton. If the preview extended over 24 units it would show Rs 48,000.
    const preview = priceCart(cart, infos, 0, taxDefaults())
    expect(preview.lines[0]!.listGross).toBe(Math.round(200_000 * 1.17))

    expectPreviewMatchesTheSale(cart, infos)
  })

  it('a LINE DISCOUNT', () => {
    const infos = new Map<string, LineInfo>()
    const cart = [
      scanInto(infos, 'A1', {
        qtyM: 3 * ONE_UNIT,
        lineDiscount: 5_00,
        discountReasonCode: 'damaged_packaging'
      })
    ]
    expectPreviewMatchesTheSale(cart, infos)
  })

  it('an OPEN ITEM — no catalogue row, so the cashier types the price', () => {
    const infos = new Map<string, LineInfo>()
    const cart: SaleLineInput[] = [
      scanInto(infos, 'A1'),
      { qtyM: 2 * ONE_UNIT, lineDiscount: 0, openItem: { name: 'Loose sugar', unitPrice: 7_35 } }
    ]
    expectPreviewMatchesTheSale(cart, infos)
  })

  it('a CART DISCOUNT that does not divide evenly across three lines', () => {
    makeProduct('B2', { retailPrice: 3_33 })
    makeProduct('C3', { retailPrice: 7_77, priceEntryMode: 'inclusive' })

    const infos = new Map<string, LineInfo>()
    const cart = [
      scanInto(infos, 'A1'),
      scanInto(infos, 'B2', { qtyM: 3 * ONE_UNIT }),
      scanInto(infos, 'C3', { qtyM: 7 * ONE_UNIT })
    ]

    // Rs 100 off. It cannot divide into three whole paisa shares — this is where a rounding line would
    // otherwise be invented, and where the screen would drift from the receipt.
    expectPreviewMatchesTheSale(cart, infos, 100_00)
  })

  it('a cart discount ON TOP of line discounts, with mixed tax modes', () => {
    makeProduct('D4', { retailPrice: 12_49, priceEntryMode: 'inclusive' })

    const infos = new Map<string, LineInfo>()
    const cart = [
      scanInto(infos, 'A1', {
        qtyM: 2 * ONE_UNIT,
        lineDiscount: 3_33,
        discountReasonCode: 'damaged_packaging'
      }),
      scanInto(infos, 'D4', {
        qtyM: 5 * ONE_UNIT,
        lineDiscount: 1_11,
        discountReasonCode: 'near_expiry'
      })
    ]

    expectPreviewMatchesTheSale(cart, infos, 47_77)
  })

  it('TAX SWITCHED OFF shop-wide — the preview zeroes the rate exactly as main does', () => {
    settings.set(t.db, 'tax.enabled', false)

    const infos = new Map<string, LineInfo>()
    const cart: SaleLineInput[] = [
      scanInto(infos, 'A1', { qtyM: 4 * ONE_UNIT }),
      { qtyM: ONE_UNIT, lineDiscount: 0, openItem: { name: 'Delivery', unitPrice: 50_00 } }
    ]

    const preview = priceCart(cart, infos, 0, taxDefaults())
    expect(preview.taxTotal).toBe(0)

    expectPreviewMatchesTheSale(cart, infos)
  })

  /**
   * THE EXTREME END OF THE APPORTIONMENT. A discount that takes all but one paisa off a three-line cart
   * pushes every line's share right up against its own gross — the case where a naive split rounds a line
   * below zero, or loses the last paisa. The customer must still be asked for exactly 1 paisa.
   *
   * (Main will not take a payment of zero — "a zero payment is not a payment" — so a 100% giveaway cannot
   * be rung up at all today. That is main's rule, and this test stops one paisa short of it.)
   */
  it('a cart discount that takes all but ONE PAISA off a three-line cart', () => {
    makeProduct('B2', { retailPrice: 3_33 })
    makeProduct('C3', { retailPrice: 7_77, priceEntryMode: 'inclusive' })

    const infos = new Map<string, LineInfo>()
    const cart = [
      scanInto(infos, 'A1'),
      scanInto(infos, 'B2', { qtyM: 3 * ONE_UNIT }),
      scanInto(infos, 'C3', { qtyM: 7 * ONE_UNIT })
    ]

    const full = priceCart(cart, infos, 0, taxDefaults())
    expectPreviewMatchesTheSale(cart, infos, full.grandTotal - 1)

    const preview = priceCart(cart, infos, full.grandTotal - 1, taxDefaults())
    expect(preview.grandTotal, 'the customer must still owe exactly one paisa').toBe(1)
  })
})

describe('what the shop does not have', () => {
  beforeEach(() => {
    makeProduct('A1')
  })

  it('spots a shortage across TWO lines of the same item that neither line shows alone', () => {
    const productId = makeProduct('THIN')
    // Put the shelf at 5.
    stock.adjust(t.db, cashier, {
      productId,
      type: 'adjustment',
      qtyM: -995 * ONE_UNIT,
      unitCost: COST,
      reasonCode: 'data_entry'
    })
    expect(stock.onHand(t.db, productId)).toBe(5 * ONE_UNIT)

    const infos = new Map<string, LineInfo>()
    const cart = [
      scanInto(infos, 'THIN', { qtyM: 3 * ONE_UNIT }),
      // A second row for the same product — a discounted one, which main does NOT merge.
      { ...scanInto(infos, 'THIN', { qtyM: 3 * ONE_UNIT }), lineDiscount: 1_00 }
    ]

    const shortages = findShortages(cart, infos)
    expect(shortages).toHaveLength(1)
    expect(shortages[0]!.onHandM).toBe(5 * ONE_UNIT)
    expect(shortages[0]!.wantedM).toBe(6 * ONE_UNIT) // 3 + 3, aggregated per PRODUCT

    // And main agrees: the sale goes through, and it is FLAGGED.
    const { sale } = sales.complete(t.db, cashier, {
      lines: cart,
      priceTier: 'retail',
      cartDiscount: 0,
      payments: [{ methodLookupId: lookupId('payment_method', 'cash'), amount: 100_000 }],
      acceptNegativeStock: true,
      acceptOverCreditLimit: false
    })
    expect(sale.hadNegativeStock).toBe(true)
  })

  it('NEVER cries wolf over a service — a bag charge has no shelf to be short of', () => {
    // This is the whole reason ScannedItem carries `itemType`. A non-inventory line reports onHandM: 0,
    // which is the same 0 a tin that has run out reports. Without the flag, the till would warn "not
    // enough stock" on every delivery fee the shop ever charged — and a cashier who is warned on every
    // sale stops reading the warnings.
    makeProduct('BAG', { itemType: 'non_inventory', retailPrice: 5_00 })

    const infos = new Map<string, LineInfo>()
    const cart = [scanInto(infos, 'A1'), scanInto(infos, 'BAG', { qtyM: 10 * ONE_UNIT })]

    expect(infos.get(infoKey(cart[1]!))!.onHandM).toBe(0)
    expect(findShortages(cart, infos)).toEqual([])

    // …and main does not flag the sale either.
    const { sale } = sales.complete(t.db, cashier, {
      lines: cart,
      priceTier: 'retail',
      cartDiscount: 0,
      payments: [{ methodLookupId: lookupId('payment_method', 'cash'), amount: 100_000 }],
      acceptNegativeStock: false,
      acceptOverCreditLimit: false
    })
    expect(sale.hadNegativeStock).toBe(false)
  })

  it('an open item is never short of anything', () => {
    const infos = new Map<string, LineInfo>()
    const cart: SaleLineInput[] = [
      { qtyM: 99 * ONE_UNIT, lineDiscount: 0, openItem: { name: 'Misc', unitPrice: 50_00 } }
    ]
    expect(findShortages(cart, infos)).toEqual([])
  })
})
