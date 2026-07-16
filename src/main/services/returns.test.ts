import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { hashSecret } from '../security/password'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import * as returns from './returns'
import * as sales from './sales'
import * as stock from './stock'
import * as ledger from './ledger'
import * as settings from './settings'
import * as catalog from './catalog'
import * as customerLedger from './customer-ledger'
import * as loyalty from './loyalty'
import { ACC } from '../db/chart-of-accounts'
import { ONE_UNIT } from '@shared/qty'
import type { User } from '@shared/types'

/**
 * THE RETURNS ENGINE — the shop's money going the other way.
 *
 * FOUR STANDING ASSERTIONS RUN AFTER EVERY SCENARIO IN THIS FILE (see `holds`). They are the point of
 * it. Any one failing means the books, the shelf, or a refund is lying:
 *
 *   1. THE TRIAL BALANCE BALANCES.                        (CLAUDE.md §4 — the standing test)
 *   2. GL INVENTORY === THE STOCK VALUATION.              the books and the shelf agree
 *   3. THE CACHED AVERAGE COST === the one rebuilt from the movements alone
 *   4. EVERY RETURN ADDS UP, AND NEVER EXCEEDS WHAT WAS SOLD
 *
 * They are asserted for EVERY return and sale line in the database, not just the one a test was
 * thinking about — a write path that corrupts another document is exactly the bug that hides for a year.
 */

// ═════════════════════════════════════════════════════════════════════════════
// Standing assertions
// ═════════════════════════════════════════════════════════════════════════════

function assertBooksBalance(t: TestDb): void {
  const tb = ledger.trialBalance(t.db)
  expect(tb.balanced, 'THE TRIAL BALANCE DOES NOT BALANCE').toBe(true)
  expect(tb.grossDebit).toBe(tb.grossCredit)
}

/** GL Inventory is what the journal says the stock is worth; the valuation is the sum of frozen values. */
function assertInventoryMatchesStockValue(t: TestDb): void {
  const gl = ledger.accountBalance(t.db, ACC.INVENTORY)
  const valuation = t.db
    .prepare('SELECT COALESCE(SUM(value_minor), 0) FROM stock_movements')
    .pluck()
    .get() as number
  expect(gl, 'GL Inventory has drifted away from the stock valuation').toBe(valuation)
}

function assertAverageCostIsHonest(t: TestDb): void {
  const ids = t.db.prepare('SELECT id FROM products').pluck().all() as number[]
  for (const id of ids) {
    const stored = t.db.prepare('SELECT cost_price FROM products WHERE id = ?').pluck().get(id)
    expect(stored, `product ${id}: the stored average has drifted from its movements`).toBe(
      stock.recomputeAverageCost(t.db, id)
    )
  }
}

/** Every return adds up, and no sale line has ever had more returned against it than it sold. */
function assertReturnsAreHonest(t: TestDb): void {
  const ids = t.db.prepare('SELECT id FROM returns').pluck().all() as number[]
  for (const id of ids) {
    const ret = returns.getReturn(t.db, id)
    let net = 0
    let tax = 0
    let gross = 0
    for (const line of ret.lines) {
      expect(line.gross, `return ${id} line ${line.id}: gross !== net + tax`).toBe(line.net + line.taxAmount)
      net += line.net
      tax += line.taxAmount
      gross += line.gross
    }
    expect(ret.subtotalNet, `return ${id}: subtotal_net !== SUM(line.net)`).toBe(net)
    expect(ret.taxTotal, `return ${id}: tax_total !== SUM(line.tax_amount)`).toBe(tax)
    expect(ret.grandTotal, `return ${id}: grand_total !== SUM(line.gross)`).toBe(gross)
    expect(ret.grandTotal, `return ${id}: grand_total !== subtotal + tax`).toBe(ret.subtotalNet + ret.taxTotal)
  }

  const overReturned = t.db
    .prepare(
      `SELECT sl.id AS sale_line_id, sl.qty_m AS sold,
              COALESCE((SELECT SUM(rl.qty_m) FROM return_lines rl WHERE rl.sale_line_id = sl.id), 0) AS returned
         FROM sale_lines sl`
    )
    .all() as Array<{ sale_line_id: number; sold: number; returned: number }>
  for (const row of overReturned) {
    expect(row.returned, `sale_line ${row.sale_line_id}: more returned than sold`).toBeLessThanOrEqual(row.sold)
  }
}

function holds(t: TestDb): void {
  assertBooksBalance(t)
  assertInventoryMatchesStockValue(t)
  assertAverageCostIsHonest(t)
  assertReturnsAreHonest(t)
}

// ═════════════════════════════════════════════════════════════════════════════
// Fixtures — mirrors sales.test.ts so the two files read the same way
// ═════════════════════════════════════════════════════════════════════════════

const RS_100 = 10_000 // 2-dp money
const RS_60_COST = 600_000 // 4-dp cost
const GST = 1700 // 17%, basis points

let t: TestDb
let cashier: User
let supervisor: User
let owner: User

/** A supervisor approves by PIN — main derives WHO from the PIN, never a claimed id. */
function pinOf(username: string): string {
  let hash = 0
  for (const ch of username) hash = (hash * 31 + ch.charCodeAt(0)) % 900000
  return String(100000 + hash)
}

function makeUser(role: User['role'], username: string, fullName: string): User {
  const now = new Date().toISOString()
  const id = Number(
    t.db
      .prepare(
        `INSERT INTO users (username, full_name, role, password_hash, pin_hash, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 'x', ?, 1, ?, ?)`
      )
      .run(username, fullName, role, hashSecret(pinOf(username)), now, now).lastInsertRowid
  )
  return { id, username, fullName, role, hasPin: true, isActive: true }
}

function lookupId(listKey: string, code: string): number {
  return t.db.prepare('SELECT id FROM lookups WHERE list_key = ? AND code = ?').pluck().get(listKey, code) as number
}

const cash = (): number => lookupId('payment_method', 'cash')
const credit = (): number => lookupId('payment_method', 'credit')

type MakeProduct = {
  name?: string
  retailPrice?: number
  taxRateBp?: number
  priceEntryMode?: 'inclusive' | 'exclusive'
  isTaxExempt?: boolean
  itemType?: 'inventory' | 'non_inventory'
  trackBatches?: boolean
  uom?: string
}

function makeProduct(options: MakeProduct = {}): number {
  const now = new Date().toISOString()
  return Number(
    t.db
      .prepare(
        `INSERT INTO products
           (sku, name, sale_uom_id, cost_price, retail_price, wholesale_price, tax_rate_bp,
            price_entry_mode, is_tax_exempt, item_type, is_weighted, track_batches, track_serials,
            is_active, created_at, updated_at)
         VALUES (@sku, @name, @uomId, 0, @retailPrice, 0, @taxRateBp,
                 @priceEntryMode, @isTaxExempt, @itemType, 0, @trackBatches, 0, 1, @now, @now)`
      )
      .run({
        sku: `SKU-${Math.random().toString(36).slice(2, 10)}`,
        name: options.name ?? 'Test Item',
        uomId: lookupId('uom', options.uom ?? 'pcs'),
        retailPrice: options.retailPrice ?? RS_100,
        taxRateBp: options.taxRateBp ?? GST,
        priceEntryMode: options.priceEntryMode ?? 'exclusive',
        isTaxExempt: options.isTaxExempt ? 1 : 0,
        itemType: options.itemType ?? 'inventory',
        trackBatches: options.trackBatches ? 1 : 0,
        now
      }).lastInsertRowid
  )
}

/** Opening stock through the REAL service — so the books balance from the first line of every test. */
function openingStock(productId: number, qtyM: number, unitCost = RS_60_COST): void {
  stock.adjust(t.db, owner, { productId, type: 'opening', qtyM, unitCost, reasonCode: 'data_entry' })
}

function makeCustomer(name: string, creditLimit = 1_000_000): number {
  const now = new Date().toISOString()
  return Number(
    t.db
      .prepare(
        `INSERT INTO customers (name, credit_limit, is_active, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)`
      )
      .run(name, creditLimit, now, now).lastInsertRowid
  )
}

function onHand(productId: number): number {
  return stock.onHand(t.db, productId)
}

function auditRows(action: string): Array<Record<string, unknown>> {
  return t.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action) as Array<
    Record<string, unknown>
  >
}

/** Ring up a plain cash sale and hand back the completed SaleDetail. */
function sell(
  productId: number,
  qtyUnits: number,
  amount: number,
  extra: { customerId?: number; method?: number } = {}
) {
  return sales.complete(t.db, cashier, {
    lines: [{ productId, qtyM: qtyUnits * ONE_UNIT }],
    ...(extra.customerId != null ? { customerId: extra.customerId } : {}),
    payments: [{ methodLookupId: extra.method ?? cash(), amount }]
  }).sale
}

beforeEach(() => {
  t = makeTestDb({ withSeed: true })
  owner = makeUser('owner', 'owner', 'Insha Owner')
  supervisor = makeUser('supervisor', 'super', 'Rashid Supervisor')
  cashier = makeUser('cashier', 'cash1', 'Bilal Cashier')
})

afterEach(() => {
  holds(t)
  t.cleanup()
})

// ═════════════════════════════════════════════════════════════════════════════
// A FULL RETURN — the exact reversal
// ═════════════════════════════════════════════════════════════════════════════

describe('a full return of a line', () => {
  it('reverses its exact net/tax/gross/cost, puts the stock back, and balances', () => {
    const productId = makeProduct({ name: 'Rice 1kg', retailPrice: RS_100, taxRateBp: GST })
    openingStock(productId, 10 * ONE_UNIT) // 10 pcs @ Rs 60 cost
    const sale = sell(productId, 2, 23_400) // Rs 200 net + Rs 34 tax = Rs 234
    const saleLine = sale.lines[0]!

    expect(onHand(productId)).toBe(8 * ONE_UNIT)
    const inventoryAfterSale = ledger.accountBalance(t.db, ACC.INVENTORY)

    const ret = returns.createReturn(t.db, supervisor, {
      saleId: sale.id,
      lines: [{ saleLineId: saleLine.id, qtyM: 2 * ONE_UNIT }],
      settlement: 'refund',
      refundMethodLookupId: cash(),
      reasonCode: 'wrong_item'
    })

    // ── The return line is the sale line, reversed, to the paisa ──
    const line = ret.lines[0]!
    expect(line.net).toBe(saleLine.net) // 20_000
    expect(line.taxAmount).toBe(saleLine.taxAmount) // 3_400
    expect(line.gross).toBe(saleLine.gross) // 23_400
    expect(line.taxRateBp).toBe(saleLine.taxRateBp)
    expect(line.unitCost).toBe(saleLine.unitCost) // 600_000 — 4-dp cost, frozen
    expect(line.qtyM).toBe(2 * ONE_UNIT)
    expect(line.restocked).toBe(true)
    expect(line.nameSnapshot).toBe('Rice 1kg')

    expect(ret.subtotalNet).toBe(20_000)
    expect(ret.taxTotal).toBe(3_400)
    expect(ret.grandTotal).toBe(23_400)
    expect(ret.settlement).toBe('refund')
    expect(ret.journalId).not.toBeNull()

    // ── The stock came back, by being SUMMED, not set ──
    expect(onHand(productId)).toBe(10 * ONE_UNIT)
    const movement = t.db
      .prepare("SELECT * FROM stock_movements WHERE ref_type = 'return' AND ref_id = ?")
      .get(String(ret.id)) as { type: string; qty_m: number; unit_cost: number; value_minor: number }
    expect(movement.type).toBe('sale_return')
    expect(movement.qty_m).toBe(2 * ONE_UNIT) // POSITIVE — goods come back
    expect(movement.unit_cost).toBe(RS_60_COST)

    // ── Inventory rose by exactly what it fell by on the sale (Rs 120) ──
    expect(ledger.accountBalance(t.db, ACC.INVENTORY) - inventoryAfterSale).toBe(12_000)
    // ── Sales Returns (contra-income) carries the net that was reversed ──
    expect(ledger.accountBalance(t.db, ACC.SALES_RETURNS)).toBe(20_000)
    // ── The cash went back out, netting the drawer to zero for this sale ──
    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(0)
    // ── Output tax reversed in full ──
    expect(ledger.accountBalance(t.db, ACC.OUTPUT_TAX)).toBe(0)

    holds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// PARTIAL RETURNS — remainder on the last, sums back exactly
// ═════════════════════════════════════════════════════════════════════════════

describe('partial returns of one line', () => {
  it('sum back to the sale line EXACTLY, with the remainder on the last return', () => {
    // Rs 9.99, 17%, 3 units — an awkward price so any sum-of-rounded drift would show.
    const productId = makeProduct({ retailPrice: 999, taxRateBp: GST })
    openingStock(productId, 10 * ONE_UNIT)
    const sale = sell(productId, 3, 3_506) // net 2997, tax 509, gross 3506
    const saleLine = sale.lines[0]!
    expect(saleLine.net).toBe(2_997)
    expect(saleLine.taxAmount).toBe(509)

    const first = returns.createReturn(t.db, supervisor, {
      saleId: sale.id,
      lines: [{ saleLineId: saleLine.id, qtyM: ONE_UNIT }],
      settlement: 'refund',
      refundMethodLookupId: cash(),
      reasonCode: 'not_needed'
    })

    const second = returns.createReturn(t.db, supervisor, {
      saleId: sale.id,
      lines: [{ saleLineId: saleLine.id, qtyM: 2 * ONE_UNIT }], // takes it to fully returned
      settlement: 'refund',
      refundMethodLookupId: cash(),
      reasonCode: 'not_needed'
    })

    // The two returns reproduce the sale line to the paisa — no drift, remainder on the last.
    expect(first.subtotalNet + second.subtotalNet).toBe(saleLine.net)
    expect(first.taxTotal + second.taxTotal).toBe(saleLine.taxAmount)
    expect(first.grandTotal + second.grandTotal).toBe(saleLine.gross)

    // Fully returned: the whole line is back on the shelf.
    expect(onHand(productId)).toBe(10 * ONE_UNIT)
    holds(t)
  })

  it('lets a line come back one unit at a time, lumpy tax and all, and refunds EXACTLY what was paid', () => {
    // Rs 1.00 tax-INCLUSIVE at 17% over 40 units: the per-unit net (85.47…p) and tax (14.53…p) do not
    // divide evenly, so the frozen figures come back lumpy (85p/86p net). The cumulative-difference
    // freeze keeps every partial non-negative and makes the 40 pieces sum back to the whole line to the
    // paisa — a naïve per-return round would drift.
    const productId = makeProduct({ retailPrice: 100, taxRateBp: GST, priceEntryMode: 'inclusive' })
    openingStock(productId, 50 * ONE_UNIT)
    const sale = sell(productId, 40, 4_000) // Rs 40.00 gross (tax included)
    const saleLine = sale.lines[0]!

    let refunded = 0
    for (let i = 0; i < 40; i++) {
      const ret = returns.createReturn(t.db, supervisor, {
        saleId: sale.id,
        lines: [{ saleLineId: saleLine.id, qtyM: ONE_UNIT }],
        settlement: 'refund',
        refundMethodLookupId: cash(),
        reasonCode: 'not_needed'
      })
      expect(ret.subtotalNet).toBeGreaterThanOrEqual(0)
      expect(ret.taxTotal).toBeGreaterThanOrEqual(0)
      refunded += ret.grandTotal
    }
    // Every unit came back, and the total refunded is EXACTLY what was paid — not a paisa more or less.
    expect(refunded).toBe(saleLine.gross)
    expect(onHand(productId)).toBe(50 * ONE_UNIT)
    holds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// CANNOT RETURN MORE THAN WAS SOLD
// ═════════════════════════════════════════════════════════════════════════════

describe('the returnable quantity', () => {
  it('refuses more than remains, across several returns', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    const sale = sell(productId, 3, 35_100)
    const saleLine = sale.lines[0]!

    returns.createReturn(t.db, supervisor, {
      saleId: sale.id,
      lines: [{ saleLineId: saleLine.id, qtyM: 2 * ONE_UNIT }],
      settlement: 'refund',
      refundMethodLookupId: cash(),
      reasonCode: 'wrong_item'
    })

    // Only 1 remains — asking for 2 more is refused, in plain language.
    expectUserMessage(
      () =>
        returns.createReturn(t.db, supervisor, {
          saleId: sale.id,
          lines: [{ saleLineId: saleLine.id, qtyM: 2 * ONE_UNIT }],
          settlement: 'refund',
          refundMethodLookupId: cash(),
          reasonCode: 'wrong_item'
        }),
      /at most 1/
    )

    // The picker now shows exactly one unit left.
    const summary = returns.returnableLines(t.db, sale.id)
    expect(summary.lines[0]!.returnableQtyM).toBe(1 * ONE_UNIT)
    expect(summary.lines[0]!.alreadyReturnedQtyM).toBe(2 * ONE_UNIT)

    holds(t)
  })

  it('refuses a single return larger than the whole line', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    const sale = sell(productId, 2, 23_400)
    const saleLine = sale.lines[0]!

    expectUserMessage(
      () =>
        returns.createReturn(t.db, supervisor, {
          saleId: sale.id,
          lines: [{ saleLineId: saleLine.id, qtyM: 5 * ONE_UNIT }],
          settlement: 'refund',
          refundMethodLookupId: cash(),
          reasonCode: 'wrong_item'
        }),
      /at most 2/
    )
    // Nothing was written — the refused return rolled back whole.
    expect(returns.listReturns(t.db).total).toBe(0)
    holds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// RESTOCK vs DAMAGE
// ═════════════════════════════════════════════════════════════════════════════

describe('restock versus damage', () => {
  it('restocks the shelf and reverses the cost when restocked = 1', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    const sale = sell(productId, 2, 23_400)

    const cogsAfterSale = ledger.accountBalance(t.db, ACC.COGS)
    const invAfterSale = ledger.accountBalance(t.db, ACC.INVENTORY)

    returns.createReturn(t.db, supervisor, {
      saleId: sale.id,
      lines: [{ saleLineId: sale.lines[0]!.id, qtyM: 2 * ONE_UNIT, restocked: true }],
      settlement: 'refund',
      refundMethodLookupId: cash(),
      reasonCode: 'wrong_item'
    })

    // Inventory rose by the SAME amount COGS fell — Rs 120 either way.
    expect(ledger.accountBalance(t.db, ACC.INVENTORY) - invAfterSale).toBe(12_000)
    expect(cogsAfterSale - ledger.accountBalance(t.db, ACC.COGS)).toBe(12_000)
    expect(onHand(productId)).toBe(10 * ONE_UNIT)
    holds(t)
  })

  it('refunds a damaged item but does NOT restock it or touch inventory/COGS', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    const sale = sell(productId, 2, 23_400)

    const cogsAfterSale = ledger.accountBalance(t.db, ACC.COGS)
    const invAfterSale = ledger.accountBalance(t.db, ACC.INVENTORY)

    const ret = returns.createReturn(t.db, supervisor, {
      saleId: sale.id,
      lines: [{ saleLineId: sale.lines[0]!.id, qtyM: 2 * ONE_UNIT, restocked: false }],
      settlement: 'refund',
      refundMethodLookupId: cash(),
      reasonCode: 'damaged'
    })

    // Full refund still went out…
    expect(ret.grandTotal).toBe(23_400)
    expect(ledger.accountBalance(t.db, ACC.SALES_RETURNS)).toBe(20_000)
    // …but the goods did NOT come back, and the shop ate the cost.
    expect(ret.lines[0]!.restocked).toBe(false)
    expect(onHand(productId)).toBe(8 * ONE_UNIT) // still down from the sale
    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(invAfterSale) // unchanged
    expect(ledger.accountBalance(t.db, ACC.COGS)).toBe(cogsAfterSale) // unchanged
    const movements = t.db
      .prepare("SELECT COUNT(*) FROM stock_movements WHERE ref_type = 'return' AND ref_id = ?")
      .pluck()
      .get(String(ret.id)) as number
    expect(movements).toBe(0) // no movement at all
    holds(t)
  })

  it('never restocks an open (misc) item — there is no shelf for it', () => {
    const productId = makeProduct({ retailPrice: RS_100, taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    // Rs 100 (no tax) + a Rs 50 open item (no tax) = Rs 150.
    const sale = sales.complete(t.db, cashier, {
      lines: [
        { productId, qtyM: ONE_UNIT },
        { openItem: { name: 'Gift wrap', unitPrice: 5_000, taxRateBp: 0 }, qtyM: ONE_UNIT }
      ],
      payments: [{ methodLookupId: cash(), amount: 15_000 }]
    }).sale

    const openLine = sale.lines.find((line) => line.isOpenItem)!

    const ret = returns.createReturn(t.db, supervisor, {
      saleId: sale.id,
      lines: [{ saleLineId: openLine.id, qtyM: ONE_UNIT, restocked: true }], // asked to restock…
      settlement: 'refund',
      refundMethodLookupId: cash(),
      reasonCode: 'not_needed'
    })

    // …but an open item has no product, so it is never restocked and moves no stock.
    expect(ret.lines[0]!.restocked).toBe(false)
    expect(ret.lines[0]!.productId).toBeNull()
    const movements = t.db
      .prepare("SELECT COUNT(*) FROM stock_movements WHERE ref_type = 'return' AND ref_id = ?")
      .pluck()
      .get(String(ret.id)) as number
    expect(movements).toBe(0)
    holds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// A CART DISCOUNT — refund what was actually PAID
// ═════════════════════════════════════════════════════════════════════════════

describe('a return against a cart-discounted sale', () => {
  it('refunds what the customer actually PAID (the cart discount is already inside the frozen line)', () => {
    const a = makeProduct({ name: 'A', retailPrice: 10_000, taxRateBp: GST })
    const b = makeProduct({ name: 'B', retailPrice: 30_000, taxRateBp: GST })
    openingStock(a, 100 * ONE_UNIT, RS_60_COST)
    openingStock(b, 100 * ONE_UNIT, 2_000_000) // Rs 200 cost

    // Rs 300 net + Rs 300 net = Rs 702 gross before discount; Rs 100 off; the customer pays Rs 602.
    const sale = sales.complete(t.db, cashier, {
      lines: [
        { productId: a, qtyM: 3 * ONE_UNIT },
        { productId: b, qtyM: ONE_UNIT }
      ],
      cartDiscount: 10_000,
      cartDiscountReasonCode: 'regular_customer',
      approverPin: pinOf(supervisor.username),
      payments: [{ methodLookupId: cash(), amount: 60_200 }]
    }).sale

    expect(sale.grandTotal).toBe(60_200)
    // Each line was frozen AFTER the cart discount: net 25_726, tax 4_374, gross 30_100.
    const [lineA, lineB] = sale.lines
    expect(lineA!.net).toBe(25_726)
    expect(lineB!.net).toBe(25_726)

    // Return BOTH lines in full.
    const ret = returns.createReturn(t.db, supervisor, {
      saleId: sale.id,
      lines: [
        { saleLineId: lineA!.id, qtyM: 3 * ONE_UNIT },
        { saleLineId: lineB!.id, qtyM: ONE_UNIT }
      ],
      settlement: 'refund',
      refundMethodLookupId: cash(),
      reasonCode: 'not_needed'
    })

    // THE REFUND IS WHAT WAS PAID — Rs 602, to the paisa. NOT the Rs 702 sticker (that would refund the
    // discount the shop kept), and NOT the double-discounted Rs 502 a naïve unwind of an already-net
    // line would give.
    expect(ret.grandTotal).toBe(60_200)
    expect(ret.grandTotal).toBe(sale.grandTotal)
    expect(ret.subtotalNet).toBe(51_452)
    expect(ret.taxTotal).toBe(8_748)

    // The drawer nets to zero: Rs 602 taken, Rs 602 refunded.
    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(0)
    holds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// SETTLEMENT — refund a tender, or reduce the customer's udhaar
// ═════════════════════════════════════════════════════════════════════════════

describe('settlement', () => {
  it('customer_credit reduces the customer receivable; the journal balances', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    const customerId = makeCustomer('Rashid')

    // A credit (udhaar) sale: DR Receivable Rs 234.
    const sale = sell(productId, 2, 23_400, { customerId, method: credit() })
    expect(ledger.accountBalance(t.db, ACC.RECEIVABLE)).toBe(23_400)
    expect(sales.outstandingCredit(t.db, customerId)).toBe(23_400)

    const receivableBefore = ledger.accountBalance(t.db, ACC.RECEIVABLE)

    const ret = returns.createReturn(t.db, supervisor, {
      saleId: sale.id,
      lines: [{ saleLineId: sale.lines[0]!.id, qtyM: 2 * ONE_UNIT }],
      settlement: 'customer_credit',
      reasonCode: 'wrong_item'
    })

    // The customer's receivable — a DERIVED ledger balance — falls by exactly the returned amount, and
    // no tender moves.
    expect(ret.settlement).toBe('customer_credit')
    expect(ret.refundMethodLookupId).toBeNull()
    expect(receivableBefore - ledger.accountBalance(t.db, ACC.RECEIVABLE)).toBe(23_400)
    expect(ledger.accountBalance(t.db, ACC.RECEIVABLE)).toBe(0)

    // ...and the PER-CUSTOMER derived balance the ledger screen shows falls with it. outstandingCredit
    // is what customer-ledger.balance() delegates to, so a credit note taken at the returns desk lowers
    // the very number the till checks the customer's limit against — it can never chase them for money
    // the GL says they no longer owe (CLAUDE.md trap #17). Before the returns-aware term this read 23_400.
    expect(sales.outstandingCredit(t.db, customerId)).toBe(0)
    holds(t)
  })

  it('a refund pays back through a tender (cash out of the drawer)', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    const sale = sell(productId, 2, 23_400)

    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(23_400)

    returns.createReturn(t.db, supervisor, {
      saleId: sale.id,
      lines: [{ saleLineId: sale.lines[0]!.id, qtyM: 2 * ONE_UNIT }],
      settlement: 'refund',
      refundMethodLookupId: cash(),
      reasonCode: 'wrong_item'
    })

    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(0) // paid back out of the drawer
    holds(t)
  })

  it('accepts a minimal exchange as store credit when the sale had a customer', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    const customerId = makeCustomer('Ayesha')
    const sale = sell(productId, 2, 23_400, { customerId }) // paid cash, but named to a customer

    const ret = returns.createReturn(t.db, supervisor, {
      saleId: sale.id,
      lines: [{ saleLineId: sale.lines[0]!.id, qtyM: 2 * ONE_UNIT }],
      settlement: 'exchange',
      exchangeGroupId: 4242, // the replacement sale's correlation id
      reasonCode: 'wrong_item'
    })

    expect(ret.settlement).toBe('exchange')
    expect(ret.exchangeGroupId).toBe(4242)
    expect(ret.refundMethodLookupId).toBeNull()
    // The value parks on the customer's account as a store-credit placeholder (CR Receivable)...
    expect(ledger.accountBalance(t.db, ACC.RECEIVABLE)).toBe(-23_400)
    // ...and the DERIVED per-customer balance moves WITH it: an exchange credits Receivable exactly as a
    // credit note does, so outstandingCredit must count it, or balance() diverges from the GL (trap #17,
    // returns audit). Ayesha had no udhaar, so her balance is now -23,400 = Rs 234 of store credit.
    expect(sales.outstandingCredit(t.db, customerId)).toBe(-23_400)
    holds(t)
  })

  it('refuses an exchange on a walk-in sale — guided exchange is not available yet', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    const sale = sell(productId, 2, 23_400) // no customer

    expectUserMessage(
      () =>
        returns.createReturn(t.db, supervisor, {
          saleId: sale.id,
          lines: [{ saleLineId: sale.lines[0]!.id, qtyM: 2 * ONE_UNIT }],
          settlement: 'exchange',
          exchangeGroupId: 4242,
          reasonCode: 'wrong_item'
        }),
      /not available yet|refund it/
    )
    holds(t)
  })

  it('refuses customer_credit on a walk-in sale that had no customer', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    const sale = sell(productId, 2, 23_400) // no customer

    expectUserMessage(
      () =>
        returns.createReturn(t.db, supervisor, {
          saleId: sale.id,
          lines: [{ saleLineId: sale.lines[0]!.id, qtyM: 2 * ONE_UNIT }],
          settlement: 'customer_credit',
          reasonCode: 'wrong_item'
        }),
      /store credit|refund it instead/
    )
    holds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// AUTHORISATION — mirror voidSale
// ═════════════════════════════════════════════════════════════════════════════

describe('authorisation', () => {
  it('refuses a cashier with no supervisor PIN', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    const sale = sell(productId, 2, 23_400)

    expectUserMessage(
      () =>
        returns.createReturn(t.db, cashier, {
          saleId: sale.id,
          lines: [{ saleLineId: sale.lines[0]!.id, qtyM: 2 * ONE_UNIT }],
          settlement: 'refund',
          refundMethodLookupId: cash(),
          reasonCode: 'wrong_item'
        }),
      /supervisor/
    )
    expect(returns.listReturns(t.db).total).toBe(0)
    holds(t)
  })

  it('lets a cashier proceed with a valid supervisor PIN, and records who approved', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    const sale = sell(productId, 2, 23_400)

    const ret = returns.createReturn(t.db, cashier, {
      saleId: sale.id,
      lines: [{ saleLineId: sale.lines[0]!.id, qtyM: 2 * ONE_UNIT }],
      settlement: 'refund',
      refundMethodLookupId: cash(),
      reasonCode: 'wrong_item',
      approverPin: pinOf(supervisor.username)
    })

    // The approver is whoever the PIN resolves to — proven in main, snapshotted with their role.
    expect(ret.approvedByUserId).toBe(supervisor.id)
    expect(ret.approvedByRole).toBe('supervisor')

    const [audited] = auditRows('sale.return')
    expect(audited!['user_name']).toBe('Bilal Cashier') // the cashier processed it
    expect(audited!['approved_by_name']).toBe('Rashid Supervisor') // the supervisor approved it
    expect(audited!['approved_by_role']).toBe('supervisor')
    expect(audited!['reason_code']).toBe('wrong_item')
    holds(t)
  })

  it('lets a supervisor authorise their own return', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    const sale = sell(productId, 2, 23_400)

    const ret = returns.createReturn(t.db, supervisor, {
      saleId: sale.id,
      lines: [{ saleLineId: sale.lines[0]!.id, qtyM: 2 * ONE_UNIT }],
      settlement: 'refund',
      refundMethodLookupId: cash(),
      reasonCode: 'wrong_item'
    })
    expect(ret.approvedByUserId).toBe(supervisor.id)
    holds(t)
  })

  it('rejects a made-up reason code that is not on the refund_reason list', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    const sale = sell(productId, 2, 23_400)

    expectUserMessage(
      () =>
        returns.createReturn(t.db, supervisor, {
          saleId: sale.id,
          lines: [{ saleLineId: sale.lines[0]!.id, qtyM: 2 * ONE_UNIT }],
          settlement: 'refund',
          refundMethodLookupId: cash(),
          reasonCode: 'because_i_felt_like_it'
        }),
      /reason for this return/
    )
    holds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// GUARDS — only a completed sale, and only into an open period
// ═════════════════════════════════════════════════════════════════════════════

describe('guards', () => {
  it('refuses to return a voided sale', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    const sale = sell(productId, 2, 23_400)
    sales.voidSale(t.db, supervisor, { id: sale.id, reasonCode: 'wrong_item' })

    expectUserMessage(
      () =>
        returns.createReturn(t.db, supervisor, {
          saleId: sale.id,
          lines: [{ saleLineId: sale.lines[0]!.id, qtyM: 2 * ONE_UNIT }],
          settlement: 'refund',
          refundMethodLookupId: cash(),
          reasonCode: 'wrong_item'
        }),
      /cancelled/
    )
    holds(t)
  })

  it('refuses a return into a locked month', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    const sale = sell(productId, 2, 23_400)

    const now = new Date()
    ledger.lockPeriod(t.db, now.getFullYear(), now.getMonth() + 1, owner.id)

    expectUserMessage(
      () =>
        returns.createReturn(t.db, supervisor, {
          saleId: sale.id,
          lines: [{ saleLineId: sale.lines[0]!.id, qtyM: 2 * ONE_UNIT }],
          settlement: 'refund',
          refundMethodLookupId: cash(),
          reasonCode: 'wrong_item'
        }),
      /closed|unlock/
    )
    expect(returns.listReturns(t.db).total).toBe(0)
    holds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// READING — the list and the detail
// ═════════════════════════════════════════════════════════════════════════════

describe('reading', () => {
  it('lists a sale’s returns and fetches one in full', () => {
    const productId = makeProduct({ name: 'Rice', retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    const sale = sell(productId, 3, 35_100)

    const first = returns.createReturn(t.db, supervisor, {
      saleId: sale.id,
      lines: [{ saleLineId: sale.lines[0]!.id, qtyM: ONE_UNIT }],
      settlement: 'refund',
      refundMethodLookupId: cash(),
      reasonCode: 'wrong_item',
      reasonText: 'customer brought one back'
    })

    const listed = returns.listReturns(t.db, { saleId: sale.id })
    expect(listed.total).toBe(1)
    expect(listed.rows[0]!.saleInvoiceNo).toBe(sale.invoiceNo)
    expect(listed.rows[0]!.lineCount).toBe(1)
    expect(listed.rows[0]!.grandTotal).toBe(first.grandTotal)

    const detail = returns.getReturn(t.db, first.id)
    expect(detail.reasonText).toBe('customer brought one back')
    expect(detail.saleInvoiceNo).toBe(sale.invoiceNo)
    expect(detail.refundMethodLabel).toBe('Cash')
    expect(detail.cashierName).toBe('Rashid Supervisor')
    holds(t)
  })

  it('returnableLines drives the picker, and empties as a line is fully returned', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    const sale = sell(productId, 2, 23_400)

    const before = returns.returnableLines(t.db, sale.invoiceNo!) // look up by the printed number
    expect(before.lines[0]!.soldQtyM).toBe(2 * ONE_UNIT)
    expect(before.lines[0]!.returnableQtyM).toBe(2 * ONE_UNIT)
    expect(before.status).toBe('completed')

    returns.createReturn(t.db, supervisor, {
      saleId: sale.id,
      lines: [{ saleLineId: sale.lines[0]!.id, qtyM: 2 * ONE_UNIT }],
      settlement: 'refund',
      refundMethodLookupId: cash(),
      reasonCode: 'wrong_item'
    })

    const after = returns.returnableLines(t.db, sale.id)
    expect(after.lines[0]!.returnableQtyM).toBe(0)
    holds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// ADVERSARIAL-AUDIT REGRESSIONS — every one is a bug the returns audit confirmed
// ═════════════════════════════════════════════════════════════════════════════

describe('returns audit regressions', () => {
  // Findings 1 & 5 (HIGH): a refund must pay OUT through a real tender. Settling a 'refund' through the
  // 'credit' (udhaar) method posts CR Receivable — raising what the customer owes while looking like a
  // refund, and on a walk-in parking an unattributable balance no per-customer sum can reconcile.
  it('refuses a refund settled through the credit (udhaar) tender — that is not money going out', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    const customerId = makeCustomer('Rashid')
    const sale = sell(productId, 2, 23_400, { customerId }) // paid cash
    const receivableBefore = ledger.accountBalance(t.db, ACC.RECEIVABLE)

    expectUserMessage(
      () =>
        returns.createReturn(t.db, supervisor, {
          saleId: sale.id,
          lines: [{ saleLineId: sale.lines[0]!.id, qtyM: 2 * ONE_UNIT }],
          settlement: 'refund',
          refundMethodLookupId: credit(), // the udhaar "tender" — resolves to Receivable
          reasonCode: 'wrong_item'
        }),
      /apply to customer account|not onto/i
    )

    // Nothing moved: the return was refused before it posted, so Receivable is untouched.
    expect(ledger.accountBalance(t.db, ACC.RECEIVABLE)).toBe(receivableBefore)
    expect(t.db.prepare('SELECT COUNT(*) FROM returns').pluck().get()).toBe(0)
    holds(t)
  })

  it('also refuses a credit-tender refund on a walk-in — no unattributable receivable is ever created', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    const sale = sell(productId, 2, 23_400) // walk-in, no customer

    expectUserMessage(
      () =>
        returns.createReturn(t.db, supervisor, {
          saleId: sale.id,
          lines: [{ saleLineId: sale.lines[0]!.id, qtyM: 2 * ONE_UNIT }],
          settlement: 'refund',
          refundMethodLookupId: credit(),
          reasonCode: 'wrong_item'
        }),
      /apply to customer account|not onto/i
    )
    expect(ledger.accountBalance(t.db, ACC.RECEIVABLE)).toBe(0)
    holds(t)
  })

  // Findings 2 & 4 (HIGH): a void reverses the WHOLE sale; if part was already returned, voiding on top
  // double-reverses it (double refund, negative drawer, phantom restock). The two are exclusive.
  it('refuses to void a sale that already has a return against it', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    const sale = sell(productId, 2, 23_400)

    returns.createReturn(t.db, supervisor, {
      saleId: sale.id,
      lines: [{ saleLineId: sale.lines[0]!.id, qtyM: 1 * ONE_UNIT }], // a PARTIAL return
      settlement: 'refund',
      refundMethodLookupId: cash(),
      reasonCode: 'wrong_item'
    })

    const cashAfterReturn = ledger.accountBalance(t.db, ACC.CASH)
    const onHandAfterReturn = onHand(productId)

    expectUserMessage(
      () => sales.voidSale(t.db, supervisor, { id: sale.id, reasonCode: 'customer_changed_mind' }),
      /has returns|reverse or settle/i
    )

    // The refused void changed nothing — no second refund, no phantom restock.
    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(cashAfterReturn)
    expect(onHand(productId)).toBe(onHandAfterReturn)
    expect(sales.getById(t.db, sale.id).status).toBe('completed')
    holds(t)
  })

  // Finding 3 (HIGH): the credit note must appear on the customer's STATEMENT, and the running balance
  // must end on the header balance — otherwise the two contradict each other on screen.
  it('shows a credit-note return on the customer statement, ending on the header balance', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)
    const customerId = makeCustomer('Nadia')
    const sale = sell(productId, 2, 23_400, { customerId, method: credit() }) // Rs 234 udhaar

    returns.createReturn(t.db, supervisor, {
      saleId: sale.id,
      lines: [{ saleLineId: sale.lines[0]!.id, qtyM: 1 * ONE_UNIT }], // return one — Rs 117 credit
      settlement: 'customer_credit',
      reasonCode: 'wrong_item'
    })

    const page = customerLedger.ledger(t.db, { customerId, page: 1, pageSize: 50 })
    const creditNote = page.rows.find((row) => row.kind === 'return')
    expect(creditNote, 'the credit note must be a line on the statement').toBeTruthy()
    expect(creditNote!.payment).toBe(11_700) // half of Rs 234

    // The statement is honest end to end: the last running balance IS the header balance IS what the
    // sale screen's credit check reads — one number, three places (trap #17).
    expect(page.rows.at(-1)!.balanceAfter).toBe(page.balance)
    expect(page.balance).toBe(sales.outstandingCredit(t.db, customerId))
    expect(page.balance).toBe(23_400 - 11_700)
    holds(t)
  })

  // Finding 10 (LOW): a line filled from several FEFO batches must be RESTOCKED across those same
  // batches, not dumped onto the sale line's single frozen batch — or per-batch on-hand and expiry drift.
  it('restocks a multi-batch line back onto the batches it was sold from', () => {
    const productId = makeProduct({ name: 'Yoghurt', retailPrice: RS_100, taxRateBp: 0, trackBatches: true })
    const sooner = catalog.addBatch(t.db, { productId, batchNo: 'B-SOON', expiryDate: '2026-08-01' })
    const later = catalog.addBatch(t.db, { productId, batchNo: 'B-LATE', expiryDate: '2027-01-01' })
    stock.adjust(t.db, owner, { productId, type: 'opening', qtyM: 3 * ONE_UNIT, unitCost: RS_60_COST, batchId: sooner.id, reasonCode: 'data_entry' })
    stock.adjust(t.db, owner, { productId, type: 'opening', qtyM: 3 * ONE_UNIT, unitCost: RS_60_COST, batchId: later.id, reasonCode: 'data_entry' })

    // Sell 4: FEFO takes all 3 from the sooner batch, then 1 from the later one.
    const sale = sell(productId, 4, 40_000)
    const byBatchAfterSale = new Map(stock.onHandByBatch(t.db, productId).map((b) => [b.batchId, b.onHandM]))
    expect(byBatchAfterSale.get(sooner.id)).toBe(0)
    expect(byBatchAfterSale.get(later.id)).toBe(2 * ONE_UNIT)

    // Return all 4. They must go back 3 -> sooner, 1 -> later, restoring each batch exactly.
    returns.createReturn(t.db, supervisor, {
      saleId: sale.id,
      lines: [{ saleLineId: sale.lines[0]!.id, qtyM: 4 * ONE_UNIT }],
      settlement: 'refund',
      refundMethodLookupId: cash(),
      reasonCode: 'wrong_item'
    })

    const byBatchAfterReturn = new Map(stock.onHandByBatch(t.db, productId).map((b) => [b.batchId, b.onHandM]))
    expect(byBatchAfterReturn.get(sooner.id)).toBe(3 * ONE_UNIT)
    expect(byBatchAfterReturn.get(later.id)).toBe(3 * ONE_UNIT)
    holds(t)
  })

  // Finding 11 (LOW): an open item (or a non-inventory service) has no shelf. When it is not restocked it
  // is "not stocked", never "damaged" — so the read model exposes `stockable` for the badge to tell them apart.
  it('marks an open-item return as not-stockable rather than damaged', () => {
    const sale = sales.complete(t.db, cashier, {
      lines: [{ qtyM: ONE_UNIT, openItem: { name: 'Photocopy', unitPrice: 2_000, taxRateBp: 0 } }],
      payments: [{ methodLookupId: cash(), amount: 2_000 }]
    }).sale

    const ret = returns.createReturn(t.db, supervisor, {
      saleId: sale.id,
      lines: [{ saleLineId: sale.lines[0]!.id, qtyM: ONE_UNIT }], // restocked defaults true — but it CAN'T be
      settlement: 'refund',
      refundMethodLookupId: cash(),
      reasonCode: 'wrong_item'
    })

    const line = ret.lines[0]!
    expect(line.productId).toBeNull() // an open item
    expect(line.stockable).toBe(false) // no shelf -> the UI shows "not stocked", not "damaged"
    expect(line.restocked).toBe(false) // and nothing was put back
    holds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// LOYALTY POINTS FOR GOODS THAT CAME BACK — the clawback (regression)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * REGRESSION — A CUSTOMER MUST NOT KEEP POINTS FOR GOODS THEY GAVE BACK.
 *
 * Found by auditing loyalty (v0.15.0): `returns.ts` never touched the points, so a customer could buy
 * Rs 1000 of goods, earn 1000 points, return the lot for a full refund and KEEP the points — free money,
 * repeatable for as long as they liked. The trial balance stayed green the whole time, because the
 * liability really was owed; it just should never have been booked. That is CLAUDE.md trap #17: the earn
 * was right when the sale happened, and this is the path that keeps it right afterwards.
 */
describe('loyalty points and a return', () => {
  const pointsOf = (customerId: number): number => loyalty.pointsBalance(t.db, customerId)
  const glLoyalty = (): number => ledger.accountBalance(t.db, ACC.LOYALTY)

  beforeEach(() => {
    settings.set(t.db, 'loyalty.enabled', true, new Date('2026-01-01T00:00:00.000Z'))
  })

  it('claws the points back when the goods come back, and lands the liability on zero', () => {
    const productId = makeProduct({ name: 'Rice 1kg', retailPrice: RS_100, taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)
    const customerId = makeCustomer('Regular Rashid')

    // Rs 1000 net, to a named customer -> 1000 points, Rs 1000 of liability.
    const sale = sell(productId, 10, 100_000, { customerId })
    expect(pointsOf(customerId)).toBe(1000)
    expect(glLoyalty()).toBe(100_000)

    // Everything comes back.
    returns.createReturn(t.db, supervisor, {
      saleId: sale.id,
      lines: [{ saleLineId: sale.lines[0]!.id, qtyM: 10 * ONE_UNIT }],
      settlement: 'refund',
      refundMethodLookupId: cash(),
      reasonCode: 'not_needed'
    })

    expect(pointsOf(customerId), 'the customer KEPT points for goods they returned').toBe(0)
    expect(glLoyalty(), 'the liability is still standing with no points behind it').toBe(0)
    holds(t)
  })

  /** Proportional, and the LAST return takes the exact remainder — no point left alive, none over-taken. */
  it('claws back proportionally across several returns, summing back exactly', () => {
    const productId = makeProduct({ name: 'Rice 1kg', retailPrice: RS_100, taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)
    const customerId = makeCustomer('Regular Rashid')

    const sale = sell(productId, 3, 30_000, { customerId }) // Rs 300 -> 300 points
    expect(pointsOf(customerId)).toBe(300)

    const back = (qty: number): void => {
      returns.createReturn(t.db, supervisor, {
        saleId: sale.id,
        lines: [{ saleLineId: sale.lines[0]!.id, qtyM: qty * ONE_UNIT }],
        settlement: 'refund',
        refundMethodLookupId: cash(),
        reasonCode: 'not_needed'
      })
    }

    back(1)
    expect(pointsOf(customerId), 'a third back -> a third of the points gone').toBe(200)
    holds(t)

    back(1)
    expect(pointsOf(customerId)).toBe(100)
    holds(t)

    back(1) // the last one: fully returned, so the remainder — whatever the rounding did on the way
    expect(pointsOf(customerId), 'a fully returned sale must leave no points behind').toBe(0)
    expect(glLoyalty()).toBe(0)
    holds(t)
  })

  /** A walk-in earned nothing, so there is nothing to claw back — and the return must not break. */
  it('does nothing when the sale earned nothing (a walk-in)', () => {
    const productId = makeProduct({ name: 'Rice 1kg', retailPrice: RS_100, taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)
    const sale = sell(productId, 2, 20_000) // no customer

    returns.createReturn(t.db, supervisor, {
      saleId: sale.id,
      lines: [{ saleLineId: sale.lines[0]!.id, qtyM: 2 * ONE_UNIT }],
      settlement: 'refund',
      refundMethodLookupId: cash(),
      reasonCode: 'not_needed'
    })

    expect(glLoyalty()).toBe(0)
    holds(t)
  })

  /**
   * The points were already SPENT. The clawback must not drive the balance negative: what they spent is
   * real money the shop handed over, and taking it back by force is the owner's decision to make by hand
   * (with a reason, through adjustPoints), not this path's.
   */
  it('never drives the balance negative when the points are already spent', () => {
    const productId = makeProduct({ name: 'Rice 1kg', retailPrice: RS_100, taxRateBp: 0 })
    openingStock(productId, 20 * ONE_UNIT)
    const customerId = makeCustomer('Regular Rashid')

    const sale = sell(productId, 10, 100_000, { customerId }) // 1000 points
    expect(pointsOf(customerId)).toBe(1000)

    // They spend the lot on a second sale (1000 points = Rs 1000 at the default rate).
    sales.complete(t.db, cashier, {
      customerId,
      lines: [{ productId, qtyM: 10 * ONE_UNIT }],
      redeemPoints: 1000,
      payments: []
    })
    expect(pointsOf(customerId)).toBe(0)

    // Now they return the FIRST sale. There are no points left to take.
    returns.createReturn(t.db, supervisor, {
      saleId: sale.id,
      lines: [{ saleLineId: sale.lines[0]!.id, qtyM: 10 * ONE_UNIT }],
      settlement: 'refund',
      refundMethodLookupId: cash(),
      reasonCode: 'not_needed'
    })

    expect(pointsOf(customerId), 'the balance must never go negative').toBe(0)
    expect(glLoyalty()).toBeGreaterThanOrEqual(0)
    holds(t)
  })
})
