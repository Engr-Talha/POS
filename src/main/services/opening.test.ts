import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import * as opening from './opening'
import * as customers from './customers'
import * as catalog from './catalog'
import * as ledger from './ledger'
import * as stock from './stock'
import { ACC } from '../db/chart-of-accounts'
import { ONE_UNIT } from '@shared/qty'
import { costToPriceMinor } from '@shared/cost'
import { openingBalanceEquityMinor, OPENING_REF_TYPE } from '@shared/opening'
import type { User } from '@shared/types'

/**
 * THE OPENING SETUP — what the shop already had on the day it started using this app.
 *
 * Everything in this file defends four sentences:
 *
 *   1. THE BOOKS BALANCE FROM DAY ONE. After every scenario, the trial balance balances. (The standing
 *      test, CLAUDE.md §4.)
 *
 *   2. OPENING BALANCE EQUITY IS EXACTLY Inventory + Cash + Bank + Receivables − Payables. If the shop
 *      owes more than it owns, OBE lands on the DEBIT side — and that is correct, not a bug.
 *
 *   3. THE GENERAL LEDGER AND THE STOCK REPORT AGREE. GL Inventory equals the stock valuation, to the
 *      paisa. The moment those two disagree the shop has money it cannot find, and the trial balance
 *      still balances, so nothing catches it.
 *
 *   4. THE DOOR ONLY OPENS ONCE. A second commit would post the entire opening balance again — double
 *      the stock, double the cash, double the equity — with a perfectly balanced trial balance and
 *      nothing downstream to notice. And once the shop has made a real sale, the opening figures
 *      FREEZE, because rewriting them later would retroactively change profit reports the owner has
 *      already read.
 */

// ── The standing assertions, run after every scenario ────────────────────────

/** THE STANDING TEST from CLAUDE.md §4: after every scenario, the trial balance balances. */
function assertBooksBalance(t: TestDb): void {
  const tb = ledger.trialBalance(t.db)
  expect(tb.balanced, 'the trial balance does not balance').toBe(true)
  expect(tb.grossDebit).toBe(tb.grossCredit)
  expect(tb.totalDebit).toBe(tb.totalCredit)
}

/**
 * THE CACHED AVERAGE IS HONEST: products.cost_price === the average rebuilt from the movements alone.
 * The opening commit is the FIRST thing that ever writes a cost, so if it seeds the average wrongly,
 * every profit figure the shop ever reports is wrong from the first sale.
 */
function assertAverageCostIsHonest(t: TestDb): void {
  const ids = t.db.prepare('SELECT id FROM products').pluck().all() as number[]
  for (const id of ids) {
    const stored = t.db.prepare('SELECT cost_price FROM products WHERE id = ?').pluck().get(id)
    expect(stored, `product ${id}: the stored average has drifted from its movements`).toBe(
      stock.recomputeAverageCost(t.db, id)
    )
  }
}

/**
 * THE GL AND THE STOCK REPORT TELL THE SAME STORY.
 *
 * GL Inventory is the sum of what the opening journals debited. The stock valuation is
 * on-hand x weighted-average-cost, product by product. They are computed from completely different
 * tables, and they must come to the same number.
 */
function assertInventoryMatchesStockValuation(t: TestDb): void {
  const valuation = stock
    .stockLevels(t.db, { pageSize: 200 })
    .rows.reduce((total, row) => total + row.stockValueMinor, 0)

  expect(
    ledger.accountBalance(t.db, ACC.INVENTORY),
    'GL Inventory and the stock valuation disagree'
  ).toBe(valuation)
}

function assertEverythingHolds(t: TestDb): void {
  assertBooksBalance(t)
  assertAverageCostIsHonest(t)
  assertInventoryMatchesStockValuation(t)
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const RS = 100 // 2-dp money minor units per rupee
const RS_COST = 10_000 // 4-dp cost units per rupee

/** The legacy carton: 24 pieces bought for Rs 2,185 -> Rs 91.0417 each. NOT Rs 91.04. */
const LEGACY_UNIT_COST = 910_417 // 4-dp cost
const LEGACY_QTY_M = 24 * ONE_UNIT

function makeUser(t: TestDb, role: User['role'] = 'owner', username = 'insha'): User {
  const now = new Date().toISOString()
  const id = Number(
    t.db
      .prepare(
        `INSERT INTO users (username, full_name, role, password_hash, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 'x', 1, ?, ?)`
      )
      .run(username, 'Insha Owner', role, now, now).lastInsertRowid
  )
  return { id, username, fullName: 'Insha Owner', role, hasPin: false, isActive: true }
}

type MakeProduct = {
  sku?: string
  name?: string
  trackBatches?: boolean
  itemType?: 'inventory' | 'non_inventory'
}

function makeProduct(t: TestDb, options: MakeProduct = {}): number {
  const now = new Date().toISOString()
  const uomId = t.db
    .prepare("SELECT id FROM lookups WHERE list_key = 'uom' AND code = 'pcs'")
    .pluck()
    .get() as number

  const sku = options.sku ?? `SKU-${Math.random().toString(36).slice(2, 10)}`

  return Number(
    t.db
      .prepare(
        `INSERT INTO products (sku, name, sale_uom_id, cost_price, retail_price, min_stock_m,
                               item_type, track_batches, is_active, created_at, updated_at)
         VALUES (@sku, @name, @uomId, 0, 0, 0, @itemType, @trackBatches, 1, @now, @now)`
      )
      .run({
        sku,
        name: options.name ?? `Item ${sku}`,
        uomId,
        itemType: options.itemType ?? 'inventory',
        trackBatches: options.trackBatches ? 1 : 0,
        now
      }).lastInsertRowid
  )
}

function makeSupplier(t: TestDb, name: string): number {
  return catalog.createSupplier(t.db, { name }).id
}

function makeCustomer(t: TestDb, actor: User, name: string): number {
  return customers.create(t.db, actor, { name }).id
}

/**
 * A REAL SALE — the thing that freezes the opening balances forever.
 *
 * Phase 5 owns the sell path; this is a faithful miniature of it, and it is faithful on purpose. It
 * takes the stock out at the WEIGHTED AVERAGE and posts the COGS leg, so that GL Inventory keeps
 * agreeing with the stock valuation afterwards. A fake sale that moved stock without relieving
 * Inventory would leave the two disagreeing and quietly break the very assertion this file exists to
 * make.
 *
 *      DR Cash        DR COGS
 *              CR Sales       CR Inventory
 */
function makeSale(t: TestDb, productId: number, priceMinor = 150 * RS): void {
  const unitCost = stock.averageCost(t.db, productId)
  const qtyM = -1 * ONE_UNIT

  stock.record(t.db, { productId, type: 'sale', qtyM, unitCost, refType: 'sale', refId: 1 })

  const cogsMinor = costToPriceMinor(stock.movementValueCost(qtyM, unitCost))

  const lines: ledger.JournalLineInput[] = [
    { account: ACC.CASH, debit: priceMinor },
    { account: ACC.SALES, credit: priceMinor }
  ]

  // A product that cost nothing relieves nothing. A zero-amount journal line is not a record of
  // anything, and ledger.post() rightly refuses one.
  if (cogsMinor > 0) {
    lines.push({ account: ACC.COGS, debit: cogsMinor })
    lines.push({ account: ACC.INVENTORY, credit: cogsMinor })
  }

  ledger.post(t.db, { refType: 'sale', refId: 1, memo: 'Sale', lines })
}

// ─────────────────────────────────────────────────────────────────────────────

describe('opening — the draft', () => {
  let t: TestDb
  let owner: User

  beforeEach(() => {
    t = makeTestDb({ withSeed: true })
    owner = makeUser(t)
  })

  afterEach(() => t.cleanup())

  it('a shop that has never opened the wizard has an empty draft — not an error', () => {
    const summary = opening.getSummary(t.db)

    expect(summary.status).toBe('draft')
    expect(summary.stockValueMinor).toBe(0)
    expect(summary.openingCashMinor).toBe(0)
    expect(summary.openingBankMinor).toBe(0)
    expect(summary.receivablesMinor).toBe(0)
    expect(summary.payablesMinor).toBe(0)
    expect(summary.openingBalanceEquityMinor).toBe(0)
    expect(summary.counts).toEqual({ stockLines: 0, receivables: 0, payables: 0 })

    // And reading it wrote nothing. getSummary() must work under an expired licence, where the app is
    // READ-ONLY and the owner can still look at everything.
    expect(t.db.prepare('SELECT COUNT(*) FROM opening_setup').pluck().get()).toBe(0)
  })

  it('saves only the fields the wizard actually sent — a step it never loaded is not wiped', () => {
    opening.setCashAndBank(t.db, owner, {
      goLiveDate: '2026-07-01',
      openingCash: 5_000 * RS,
      openingBank: 20_000 * RS
    })

    // The next screen edits the till only. It never loaded the bank balance, so it must not post one
    // back — that is trap #18, and it is how a bank balance gets silently zeroed.
    opening.setCashAndBank(t.db, owner, { openingCash: 6_500 * RS })

    const summary = opening.getSummary(t.db)
    expect(summary.openingCashMinor).toBe(6_500 * RS)
    expect(summary.openingBankMinor).toBe(20_000 * RS) // untouched
    expect(summary.goLiveDate).toBe('2026-07-01') // untouched
  })

  it('the same item cannot be entered twice — in words a shopkeeper understands', () => {
    const oilId = makeProduct(t, { sku: 'OIL-5L', name: 'Cooking Oil 5L' })

    opening.addStockLine(t.db, owner, { productId: oilId, qtyM: 40 * ONE_UNIT, unitCost: 910_417 })

    // Keyed on Monday, forgotten, keyed again on Tuesday. Without this the shop opens with 80 litres
    // it does not have, a doubled Inventory debit, and a trial balance that balances perfectly.
    expectUserMessage(
      () =>
        opening.addStockLine(t.db, owner, {
          productId: oilId,
          qtyM: 40 * ONE_UNIT,
          unitCost: 910_417
        }),
      /already on the opening stock list/i
    )

    expect(opening.listStockLines(t.db).total).toBe(1)
  })

  it('editing a line does not collide with itself', () => {
    const oilId = makeProduct(t, { sku: 'OIL-5L' })
    const line = opening.addStockLine(t.db, owner, { productId: oilId, qtyM: 40 * ONE_UNIT })

    const edited = opening.updateStockLine(t.db, owner, {
      id: line.id,
      productId: oilId,
      qtyM: 36 * ONE_UNIT,
      unitCost: 910_417
    })

    expect(edited.qtyM).toBe(36 * ONE_UNIT)
    expect(edited.unitCost).toBe(910_417)
    expect(opening.listStockLines(t.db).total).toBe(1)
  })

  it('a line can be taken off the sheet — nothing has been posted, it is a worksheet', () => {
    const productId = makeProduct(t)
    const line = opening.addStockLine(t.db, owner, { productId, qtyM: 10 * ONE_UNIT })

    opening.removeStockLine(t.db, owner, { id: line.id })

    expect(opening.listStockLines(t.db).total).toBe(0)
    expect(opening.getSummary(t.db).stockValueMinor).toBe(0)
    // Nothing was ever in the books to take back out.
    expect(t.db.prepare('SELECT COUNT(*) FROM stock_movements').pluck().get()).toBe(0)
    assertBooksBalance(t)
  })

  it('a service or a bag charge cannot have an opening quantity — it has no stock to have', () => {
    const bagId = makeProduct(t, { name: 'Carrier Bag', itemType: 'non_inventory' })

    expectUserMessage(
      () => opening.addStockLine(t.db, owner, { productId: bagId, qtyM: 10 * ONE_UNIT }),
      /not a stocked item/i
    )
  })

  it('ordinary goods are never made to carry a batch number', () => {
    const beansId = makeProduct(t, { name: 'Tin of Beans' })

    // Owner's decision: one line per item, batches OPTIONAL. Offering a batch box on a tin of beans is
    // how a stock sheet takes three evenings instead of one.
    const line = opening.addStockLine(t.db, owner, { productId: beansId, qtyM: 48 * ONE_UNIT })
    expect(line.batchNo).toBeNull()
    expect(line.expiryDate).toBeNull()

    expectUserMessage(
      () =>
        opening.addStockLine(t.db, owner, {
          productId: makeProduct(t, { name: 'Tin of Peas' }),
          qtyM: 10 * ONE_UNIT,
          batchNo: 'B-001'
        }),
      /not set up for batch tracking/i
    )
  })

  it('an expiry date has to belong to a batch — it has nowhere else to live', () => {
    const medId = makeProduct(t, { name: 'Panadol', trackBatches: true })

    expectUserMessage(
      () =>
        opening.addStockLine(t.db, owner, {
          productId: medId,
          qtyM: 10 * ONE_UNIT,
          expiryDate: '2027-01-31'
        }),
      /batch number/i
    )
  })

  it('udhaar and supplier dues are one row per party, and say so plainly', () => {
    const rashidId = makeCustomer(t, owner, 'Rashid')
    const tradersId = makeSupplier(t, 'Karachi Traders')

    opening.addReceivable(t.db, owner, { customerId: rashidId, amount: 12_400 * RS })
    opening.addPayable(t.db, owner, { supplierId: tradersId, amount: 8_000 * RS })

    // Two opening balances for Rashid would double what he owes — and he would be chased for it.
    expectUserMessage(
      () => opening.addReceivable(t.db, owner, { customerId: rashidId, amount: 3_000 * RS }),
      /already been entered/i
    )
    expectUserMessage(
      () => opening.addPayable(t.db, owner, { supplierId: tradersId, amount: 1_000 * RS }),
      /already been entered/i
    )

    const summary = opening.getSummary(t.db)
    expect(summary.receivablesMinor).toBe(12_400 * RS)
    expect(summary.payablesMinor).toBe(8_000 * RS)
    expect(summary.counts).toEqual({ stockLines: 0, receivables: 1, payables: 1 })
  })

  it('udhaar has to be owed BY SOMEBODY', () => {
    expectUserMessage(
      () => opening.addReceivable(t.db, owner, { customerId: 9999, amount: 500 * RS }),
      /customer could not be found/i
    )
    expectUserMessage(
      () => opening.addPayable(t.db, owner, { supplierId: 9999, amount: 500 * RS }),
      /supplier could not be found/i
    )
  })

  it('the review screen adds up exactly what the commit will post', () => {
    const oilId = makeProduct(t, { sku: 'OIL-5L' })
    const riceId = makeProduct(t, { sku: 'RICE-25KG' })
    const rashidId = makeCustomer(t, owner, 'Rashid')
    const tradersId = makeSupplier(t, 'Karachi Traders')

    opening.setCashAndBank(t.db, owner, {
      goLiveDate: '2026-07-01',
      openingCash: 5_000 * RS,
      openingBank: 20_000 * RS
    })
    opening.addStockLine(t.db, owner, {
      productId: oilId,
      qtyM: 10 * ONE_UNIT,
      unitCost: 100 * RS_COST
    })
    opening.addStockLine(t.db, owner, {
      productId: riceId,
      qtyM: 4 * ONE_UNIT,
      unitCost: 2_500 * RS_COST
    })
    opening.addReceivable(t.db, owner, { customerId: rashidId, amount: 1_200 * RS })
    opening.addPayable(t.db, owner, { supplierId: tradersId, amount: 800 * RS })

    const summary = opening.getSummary(t.db)

    expect(summary.stockValueMinor).toBe(11_000 * RS) // 10 x 100 + 4 x 2,500
    expect(summary.openingBalanceEquityMinor).toBe(36_400 * RS) // 11,000 + 5,000 + 20,000 + 1,200 − 800
    expect(summary.openingBalanceEquityMinor).toBe(
      openingBalanceEquityMinor({
        stockValueMinor: summary.stockValueMinor,
        openingCashMinor: summary.openingCashMinor,
        openingBankMinor: summary.openingBankMinor,
        receivablesMinor: summary.receivablesMinor,
        payablesMinor: summary.payablesMinor
      })
    )

    // ...and nothing is in the books yet. A draft is a worksheet.
    expect(t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get()).toBe(0)
    expect(t.db.prepare('SELECT COUNT(*) FROM stock_movements').pluck().get()).toBe(0)
  })

  /**
   * REGRESSION — CLAUDE.md trap #18, and the most expensive bug this phase could have shipped.
   *
   * The edit path used to validate with the ADD schema and write EVERY column back. `unitCost` carries
   * `.default(0)` on the add — correct there, because a line added with no cost is a free sample — so
   * zod INJECTED `unitCost: 0` into any edit that did not resend it. A caller correcting only the
   * quantity therefore reset the cost to nothing.
   *
   * What that costs the shop: the line then debits Inventory with ZERO at commit and seeds the
   * product's weighted-average cost at ZERO — so every later sale of that item reports a 100% profit.
   * That is the precise disaster the entire Opening Setup exists to prevent, arriving through the
   * screen built to prevent it, with a perfectly balanced trial balance behind it.
   */
  it('REGRESSION: correcting only the quantity must NOT wipe the cost the owner typed', () => {
    const productId = makeProduct(t, { sku: 'CTN-24', name: 'Biscuits' })

    const line = opening.addStockLine(t.db, owner, {
      productId,
      qtyM: LEGACY_QTY_M,
      unitCost: LEGACY_UNIT_COST
    })

    // The edit never loaded the cost field — it sends only what it changed.
    const after = opening.updateStockLine(t.db, owner, { id: line.id, qtyM: 30 * ONE_UNIT })

    expect(after.qtyM).toBe(30 * ONE_UNIT)
    expect(after.unitCost, 'the cost was silently wiped to zero').toBe(LEGACY_UNIT_COST)

    // And an edit that DOES send a cost still changes it — "leave it alone" must not become
    // "you can never change it".
    const repriced = opening.updateStockLine(t.db, owner, { id: line.id, unitCost: 95 * RS_COST })
    expect(repriced.unitCost).toBe(95 * RS_COST)
    expect(repriced.qtyM, 'the quantity was wiped instead').toBe(30 * ONE_UNIT)
  })

  /** REGRESSION (trap #18): the batch and expiry survive an edit that never loaded them. */
  it('REGRESSION: correcting the quantity must NOT wipe the batch or the expiry', () => {
    const productId = makeProduct(t, { sku: 'MED-1', trackBatches: true })

    const line = opening.addStockLine(t.db, owner, {
      productId,
      qtyM: 10 * ONE_UNIT,
      unitCost: 50 * RS_COST,
      batchNo: 'B-77',
      expiryDate: '2027-01-31'
    })

    const after = opening.updateStockLine(t.db, owner, { id: line.id, qtyM: 12 * ONE_UNIT })

    expect(after.qtyM).toBe(12 * ONE_UNIT)
    expect(after.batchNo, 'the batch number was wiped').toBe('B-77')
    expect(after.expiryDate, 'the expiry date was wiped').toBe('2027-01-31')

    // ...but the owner can still clear a batch DELIBERATELY. Absent means "leave it"; null means "clear it".
    const cleared = opening.updateStockLine(t.db, owner, {
      id: line.id,
      batchNo: null,
      expiryDate: null
    })
    expect(cleared.batchNo).toBeNull()
    expect(cleared.expiryDate).toBeNull()
  })

  /** REGRESSION (trap #18): the note on an udhaar / supplier-due row survives an amount correction. */
  it('REGRESSION: correcting an amount must NOT wipe the note against it', () => {
    const rashidId = makeCustomer(t, owner, 'Rashid')
    const tradersId = makeSupplier(t, 'Karachi Traders')

    const udhaar = opening.addReceivable(t.db, owner, {
      customerId: rashidId,
      amount: 12_400 * RS,
      note: 'Old ledger, page 42'
    })
    const due = opening.addPayable(t.db, owner, {
      supplierId: tradersId,
      amount: 30_000 * RS,
      note: 'Invoice bundle, March'
    })

    const udhaarAfter = opening.updateReceivable(t.db, owner, {
      id: udhaar.id,
      amount: 15_000 * RS
    })
    const dueAfter = opening.updatePayable(t.db, owner, { id: due.id, amount: 28_000 * RS })

    expect(udhaarAfter.amount).toBe(15_000 * RS)
    expect(udhaarAfter.note, 'the udhaar note was wiped').toBe('Old ledger, page 42')

    expect(dueAfter.amount).toBe(28_000 * RS)
    expect(dueAfter.note, 'the supplier-due note was wiped').toBe('Invoice bundle, March')
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('opening — the commit', () => {
  let t: TestDb
  let owner: User

  beforeEach(() => {
    t = makeTestDb({ withSeed: true })
    owner = makeUser(t)
  })

  afterEach(() => t.cleanup())

  /**
   * THE LEGACY NUMBERS. A carton of 24 bought for Rs 2,185 costs Rs 91.0417 a piece — and 4 decimal
   * places is exactly why cost is not money. At 2 dp that piece costs Rs 91.04, and the 0.0017 lost on
   * every one of them quietly falsifies a year of profit.
   */
  it('opening stock: the shelf, the average cost, the GL and the stock report all agree', () => {
    const productId = makeProduct(t, { sku: 'CTN-24', name: 'Biscuits' })

    opening.setCashAndBank(t.db, owner, { goLiveDate: '2026-07-01' })
    opening.addStockLine(t.db, owner, {
      productId,
      qtyM: LEGACY_QTY_M,
      unitCost: LEGACY_UNIT_COST
    })

    const summary = opening.commit(t.db, owner, { confirm: true })

    // 1. The shelf holds what the owner said it holds — DERIVED from the movements, not stored.
    expect(stock.onHand(t.db, productId)).toBe(LEGACY_QTY_M)

    // 2. The weighted average is EXACTLY the cost that was entered. There was nothing on the shelf to
    //    blend it with, so the first delivery IS the average.
    expect(stock.averageCost(t.db, productId)).toBe(LEGACY_UNIT_COST)

    // 3. 24 x Rs 91.0417 = Rs 2,185.0008 -> Rs 2,185.00 in the books.
    expect(summary.stockValueMinor).toBe(2_185 * RS)
    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(2_185 * RS)

    // 4. And the equity leg — this is what makes the first sale of these biscuits show the RIGHT
    //    profit instead of a 100% one.
    expect(ledger.accountBalance(t.db, ACC.OPENING_BALANCE_EQUITY)).toBe(2_185 * RS)

    // 5. The movement is an `opening` one, and it says who and why.
    const movement = t.db
      .prepare('SELECT type, qty_m, unit_cost, user_id, reason_code FROM stock_movements')
      .get() as Record<string, unknown>
    expect(movement['type']).toBe('opening')
    expect(movement['qty_m']).toBe(LEGACY_QTY_M)
    expect(movement['unit_cost']).toBe(LEGACY_UNIT_COST)
    expect(movement['user_id']).toBe(owner.id)

    assertEverythingHolds(t)
  })

  it('cash, bank, udhaar and supplier dues land on the right accounts, and OBE is the identity', () => {
    const oilId = makeProduct(t, { sku: 'OIL-5L' })
    const riceId = makeProduct(t, { sku: 'RICE-25KG' })
    const rashidId = makeCustomer(t, owner, 'Rashid')
    const bilalId = makeCustomer(t, owner, 'Bilal')
    const tradersId = makeSupplier(t, 'Karachi Traders')

    opening.setCashAndBank(t.db, owner, {
      goLiveDate: '2026-07-01',
      openingCash: 5_000 * RS,
      openingBank: 20_000 * RS
    })
    opening.addStockLine(t.db, owner, {
      productId: oilId,
      qtyM: 10 * ONE_UNIT,
      unitCost: 100 * RS_COST
    })
    opening.addStockLine(t.db, owner, {
      productId: riceId,
      qtyM: 4 * ONE_UNIT,
      unitCost: 2_500 * RS_COST
    })
    opening.addReceivable(t.db, owner, { customerId: rashidId, amount: 1_000 * RS })
    opening.addReceivable(t.db, owner, { customerId: bilalId, amount: 200 * RS })
    opening.addPayable(t.db, owner, { supplierId: tradersId, amount: 800 * RS })

    const summary = opening.commit(t.db, owner)

    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(11_000 * RS)
    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(5_000 * RS)
    expect(ledger.accountBalance(t.db, ACC.BANK)).toBe(20_000 * RS)
    expect(ledger.accountBalance(t.db, ACC.RECEIVABLE)).toBe(1_200 * RS)
    expect(ledger.accountBalance(t.db, ACC.PAYABLE)).toBe(800 * RS)

    // THE IDENTITY: Inventory + Cash + Bank + Receivables − Payables.
    // OBE is credit-natured, so a positive balance is a credit — the shop's day-one net worth.
    const expected = 36_400 * RS
    expect(summary.openingBalanceEquityMinor).toBe(expected)
    expect(ledger.accountBalance(t.db, ACC.OPENING_BALANCE_EQUITY)).toBe(expected)

    // Every opening journal is dated to the GO-LIVE DATE, not to the evening it was typed.
    const dates = t.db
      .prepare(`SELECT DISTINCT substr(at, 1, 10) FROM journals WHERE ref_type = ?`)
      .pluck()
      .all(OPENING_REF_TYPE) as string[]
    expect(dates).toEqual(['2026-07-01'])

    assertEverythingHolds(t)
  })

  it('A SHOP THAT OWES MORE THAN IT OWNS commits fine — OBE lands on the DEBIT side', () => {
    const productId = makeProduct(t, { sku: 'P-1' })
    const tradersId = makeSupplier(t, 'Karachi Traders')

    // Rs 1,000 of stock, Rs 500 in the till... and Rs 20,000 owed to suppliers.
    opening.setCashAndBank(t.db, owner, { goLiveDate: '2026-07-01', openingCash: 500 * RS })
    opening.addStockLine(t.db, owner, {
      productId,
      qtyM: 10 * ONE_UNIT,
      unitCost: 100 * RS_COST
    })
    opening.addPayable(t.db, owner, { supplierId: tradersId, amount: 20_000 * RS })

    const summary = opening.commit(t.db, owner)

    // NEGATIVE net worth, honestly stated. Nothing in this app may ever try to "fix" it.
    expect(summary.openingBalanceEquityMinor).toBe(-18_500 * RS)
    expect(ledger.accountBalance(t.db, ACC.OPENING_BALANCE_EQUITY)).toBe(-18_500 * RS)

    // On the trial balance it shows on the DEBIT side, which is what a negative equity means.
    const obe = ledger.trialBalance(t.db).rows.find((row) => row.code === ACC.OPENING_BALANCE_EQUITY)
    expect(obe?.debit).toBe(18_500 * RS)
    expect(obe?.credit).toBe(0)

    // And the books STILL balance. A negative equity is not an unbalanced ledger.
    assertEverythingHolds(t)
  })

  it('a brand-new shop with NOTHING commits harmlessly, and the books still balance', () => {
    const summary = opening.commit(t.db, owner)

    expect(summary.status).toBe('committed')
    expect(summary.openingBalanceEquityMinor).toBe(0)

    // No journal at all. An empty till is not an accounting event, and a journal with no lines is not
    // a record of anything — ledger.post() would rightly refuse it.
    expect(t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get()).toBe(0)
    expect(t.db.prepare('SELECT COUNT(*) FROM stock_movements').pluck().get()).toBe(0)

    assertEverythingHolds(t)
  })

  it('a shop with exactly as much as it owes posts no equity line — and still balances', () => {
    const tradersId = makeSupplier(t, 'Karachi Traders')

    opening.setCashAndBank(t.db, owner, { goLiveDate: '2026-07-01', openingCash: 8_000 * RS })
    opening.addPayable(t.db, owner, { supplierId: tradersId, amount: 8_000 * RS })

    const summary = opening.commit(t.db, owner)

    expect(summary.openingBalanceEquityMinor).toBe(0)
    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(8_000 * RS)
    expect(ledger.accountBalance(t.db, ACC.PAYABLE)).toBe(8_000 * RS)
    expect(ledger.accountBalance(t.db, ACC.OPENING_BALANCE_EQUITY)).toBe(0)

    assertEverythingHolds(t)
  })

  it('a batch-tracked item carries its batch and expiry; an ordinary one needs neither', () => {
    const medId = makeProduct(t, { sku: 'MED-1', name: 'Panadol', trackBatches: true })
    const beansId = makeProduct(t, { sku: 'BEANS-1', name: 'Tin of Beans' })

    opening.setCashAndBank(t.db, owner, { goLiveDate: '2026-07-01' })

    // Two batches of the same medicine — different expiries, so they are genuinely different stock.
    opening.addStockLine(t.db, owner, {
      productId: medId,
      qtyM: 10 * ONE_UNIT,
      unitCost: 20 * RS_COST,
      batchNo: 'B-001',
      expiryDate: '2027-01-31'
    })
    opening.addStockLine(t.db, owner, {
      productId: medId,
      qtyM: 25 * ONE_UNIT,
      unitCost: 20 * RS_COST,
      batchNo: 'B-002',
      expiryDate: '2027-06-30'
    })
    // ...and a tin of beans, which has no batch and never will.
    opening.addStockLine(t.db, owner, {
      productId: beansId,
      qtyM: 48 * ONE_UNIT,
      unitCost: 50 * RS_COST
    })

    opening.commit(t.db, owner)

    // The batches were CREATED by the commit, with the expiry the owner typed — which is what the
    // near-expiry report and FEFO both read.
    const batches = stock.onHandByBatch(t.db, medId)
    expect(batches.map((b) => [b.batchNo, b.onHandM, b.expiryDate])).toEqual([
      ['B-001', 10 * ONE_UNIT, '2027-01-31'],
      ['B-002', 25 * ONE_UNIT, '2027-06-30']
    ])

    // The product's total is the sum of ALL its movements, batched or not.
    expect(stock.onHand(t.db, medId)).toBe(35 * ONE_UNIT)

    // The tin of beans has no batch row at all, and it is on the shelf just the same.
    expect(stock.onHandByBatch(t.db, beansId)).toEqual([])
    expect(stock.onHand(t.db, beansId)).toBe(48 * ONE_UNIT)

    assertEverythingHolds(t)
  })

  it('opening stock that cost NOTHING still counts on the shelf, and posts no journal', () => {
    const productId = makeProduct(t, { sku: 'FREE-1' })

    // A free sample from a supplier. Real stock; it just cost nothing. A zero-value journal is not a
    // record of anything — but the tin is on the shelf and must be sellable.
    opening.addStockLine(t.db, owner, { productId, qtyM: 6 * ONE_UNIT, unitCost: 0 })
    const summary = opening.commit(t.db, owner)

    expect(stock.onHand(t.db, productId)).toBe(6 * ONE_UNIT)
    expect(summary.stockValueMinor).toBe(0)
    expect(t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get()).toBe(0)

    assertEverythingHolds(t)
  })

  it('the commit is ONE transaction — a bad line rolls the whole thing back', () => {
    const goodId = makeProduct(t, { sku: 'GOOD-1' })
    const doomedId = makeProduct(t, { sku: 'DOOMED-1' })

    opening.setCashAndBank(t.db, owner, { goLiveDate: '2026-07-01', openingCash: 5_000 * RS })
    opening.addStockLine(t.db, owner, {
      productId: goodId,
      qtyM: 10 * ONE_UNIT,
      unitCost: 100 * RS_COST
    })
    opening.addStockLine(t.db, owner, {
      productId: doomedId,
      qtyM: 10 * ONE_UNIT,
      unitCost: 100 * RS_COST
    })

    // The owner turns the second item into a service AFTER typing the stock sheet. stock.adjust() will
    // refuse to give it a quantity — a non-stocked item has no stock to have.
    t.db.prepare("UPDATE products SET item_type = 'non_inventory' WHERE id = ?").run(doomedId)

    expect(() => opening.commit(t.db, owner)).toThrow()

    // NOTHING was posted. Not the good line, not the cash, not the status. A half-posted opening
    // balance is an inventory that does not match the ledger, with no way to tell which half is real.
    expect(t.db.prepare('SELECT COUNT(*) FROM stock_movements').pluck().get()).toBe(0)
    expect(t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get()).toBe(0)
    expect(opening.getSummary(t.db).status).toBe('draft')

    assertEverythingHolds(t)
  })

  it('the commit is audited — WHO opened this shop’s books, WHEN, and with what figures', () => {
    const productId = makeProduct(t)
    opening.setCashAndBank(t.db, owner, { goLiveDate: '2026-07-01', openingCash: 5_000 * RS })
    opening.addStockLine(t.db, owner, {
      productId,
      qtyM: 10 * ONE_UNIT,
      unitCost: 100 * RS_COST
    })

    const summary = opening.commit(t.db, owner)

    const row = t.db
      .prepare(
        `SELECT user_id, user_name, user_role, entity, after_json
           FROM audit_log WHERE action = 'opening.commit'`
      )
      .get() as Record<string, string | number>

    expect(row['user_id']).toBe(owner.id)
    expect(row['user_name']).toBe('Insha Owner')
    expect(row['user_role']).toBe('owner') // copied in, so a later promotion cannot rewrite history
    expect(row['entity']).toBe('opening_setup')

    const after = JSON.parse(String(row['after_json'])) as Record<string, number>
    expect(after['openingBalanceEquityMinor']).toBe(summary.openingBalanceEquityMinor)

    // ...and the setup itself remembers who closed the door.
    expect(summary.committedByUserId).toBe(owner.id)
    expect(summary.committedAt).not.toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('opening — the door only opens once', () => {
  let t: TestDb
  let owner: User

  beforeEach(() => {
    t = makeTestDb({ withSeed: true })
    owner = makeUser(t)
  })

  afterEach(() => t.cleanup())

  /**
   * THE ONE THAT WOULD NEVER HAVE BEEN CAUGHT.
   *
   * A second commit does not fail loudly — it SUCCEEDS, posting the entire opening balance again:
   * double the stock, double the cash, double the equity, and a trial balance that still balances
   * perfectly, because two balanced journals balance. Nothing downstream would ever notice.
   */
  it('COMMITTING TWICE IS REFUSED', () => {
    const productId = makeProduct(t, { sku: 'OIL-5L' })

    opening.setCashAndBank(t.db, owner, { goLiveDate: '2026-07-01', openingCash: 5_000 * RS })
    opening.addStockLine(t.db, owner, {
      productId,
      qtyM: 10 * ONE_UNIT,
      unitCost: 100 * RS_COST
    })

    opening.commit(t.db, owner)

    const after = {
      onHand: stock.onHand(t.db, productId),
      inventory: ledger.accountBalance(t.db, ACC.INVENTORY),
      cash: ledger.accountBalance(t.db, ACC.CASH),
      equity: ledger.accountBalance(t.db, ACC.OPENING_BALANCE_EQUITY),
      journals: t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get(),
      movements: t.db.prepare('SELECT COUNT(*) FROM stock_movements').pluck().get()
    }

    expectUserMessage(() => opening.commit(t.db, owner), /already been saved to the books/i)

    // Not one paisa moved.
    expect({
      onHand: stock.onHand(t.db, productId),
      inventory: ledger.accountBalance(t.db, ACC.INVENTORY),
      cash: ledger.accountBalance(t.db, ACC.CASH),
      equity: ledger.accountBalance(t.db, ACC.OPENING_BALANCE_EQUITY),
      journals: t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get(),
      movements: t.db.prepare('SELECT COUNT(*) FROM stock_movements').pluck().get()
    }).toEqual(after)

    assertEverythingHolds(t)
  })

  it('a committed setup cannot be edited — the correction path is an adjustment, and it says so', () => {
    const productId = makeProduct(t, { sku: 'OIL-5L' })
    const rashidId = makeCustomer(t, owner, 'Rashid')
    const tradersId = makeSupplier(t, 'Karachi Traders')

    opening.addStockLine(t.db, owner, {
      productId,
      qtyM: 10 * ONE_UNIT,
      unitCost: 100 * RS_COST
    })
    const line = opening.listStockLines(t.db).rows[0]!

    opening.commit(t.db, owner)

    const frozen = /already been saved to the books/i

    expectUserMessage(() => opening.setCashAndBank(t.db, owner, { openingCash: 99 * RS }), frozen)
    expectUserMessage(
      () => opening.addStockLine(t.db, owner, { productId: makeProduct(t), qtyM: ONE_UNIT }),
      frozen
    )
    expectUserMessage(
      () =>
        opening.updateStockLine(t.db, owner, {
          id: line.id,
          productId,
          qtyM: 999 * ONE_UNIT,
          unitCost: 100 * RS_COST
        }),
      frozen
    )
    expectUserMessage(() => opening.removeStockLine(t.db, owner, { id: line.id }), frozen)
    expectUserMessage(
      () => opening.addReceivable(t.db, owner, { customerId: rashidId, amount: 500 * RS }),
      frozen
    )
    expectUserMessage(
      () => opening.addPayable(t.db, owner, { supplierId: tradersId, amount: 500 * RS }),
      frozen
    )

    // The stock is exactly what was committed — no edit got through by any path.
    expect(stock.onHand(t.db, productId)).toBe(10 * ONE_UNIT)
    assertEverythingHolds(t)
  })

  /**
   * THE FREEZE RULE (owner's decision). Once the shop has made a real sale, the opening figures are
   * history — and history is not editable. Silently rewriting the opening cost of an item a month
   * later would retroactively change every profit report the owner has already looked at, and there
   * would be nothing anywhere to say that it had happened. The correction path is a stock adjustment,
   * which leaves a name, a reason and a journal behind it.
   */
  it('EDITING AFTER THE FIRST SALE IS REFUSED — in language a cashier can act on', () => {
    const productId = makeProduct(t, { sku: 'OIL-5L' })

    opening.setCashAndBank(t.db, owner, { goLiveDate: '2026-07-01', openingCash: 5_000 * RS })
    opening.addStockLine(t.db, owner, {
      productId,
      qtyM: 10 * ONE_UNIT,
      unitCost: 100 * RS_COST
    })
    opening.commit(t.db, owner)

    // The shop opens. It sells a bottle of oil.
    makeSale(t, productId)

    expectUserMessage(
      () => opening.setCashAndBank(t.db, owner, { openingCash: 50_000 * RS }),
      /already made sales or purchases|already been saved to the books/i
    )

    assertEverythingHolds(t)
  })

  it('a shop that started selling BEFORE opening its books cannot back-date an opening balance', () => {
    const productId = makeProduct(t, { sku: 'OIL-5L' })

    // Never opened the wizard. Straight to selling.
    makeSale(t, productId)

    const traded = /already made sales or purchases/i

    expectUserMessage(() => opening.setCashAndBank(t.db, owner, { openingCash: 5_000 * RS }), traded)
    expectUserMessage(
      () => opening.addStockLine(t.db, owner, { productId, qtyM: 10 * ONE_UNIT }),
      traded
    )
    // And the commit is no exception. It is the biggest write of all: posting a backdated opening
    // balance behind a month of real sales would re-seed the average cost those sales were costed
    // against, and the owner's profit reports would change underneath them.
    expectUserMessage(() => opening.commit(t.db, owner), traded)

    expect(opening.getSummary(t.db).status).toBe('draft')
    assertBooksBalance(t)
  })

  it('a sale that moved no stock at all still freezes the books', () => {
    // A haircut, a delivery charge, a service — a real sale that touches not one stock movement.
    // Checking only stock_movements would let a shop that has been trading for a month go back and
    // rewrite the cash it "started" with.
    ledger.post(t.db, {
      refType: 'sale',
      refId: 1,
      memo: 'Sale of a service',
      lines: [
        { account: ACC.CASH, debit: 500 * RS },
        { account: ACC.SALES, credit: 500 * RS }
      ]
    })

    expect(opening.hasTraded(t.db)).toBe(true)
    expectUserMessage(
      () => opening.setCashAndBank(t.db, owner, { openingCash: 5_000 * RS }),
      /already made sales or purchases/i
    )

    assertBooksBalance(t)
  })

  it('an opening balance and a stock adjustment do NOT count as trading', () => {
    const productId = makeProduct(t, { sku: 'OIL-5L' })

    expect(opening.hasTraded(t.db)).toBe(false)

    // A stock-take correction is not a sale. The owner must still be able to finish the wizard.
    stock.adjust(t.db, owner, {
      productId,
      type: 'adjustment',
      qtyM: 5 * ONE_UNIT,
      unitCost: 100 * RS_COST,
      reasonCode: 'stock_take'
    })

    expect(opening.hasTraded(t.db)).toBe(false)
    expect(() =>
      opening.setCashAndBank(t.db, owner, { goLiveDate: '2026-07-01', openingCash: 5_000 * RS })
    ).not.toThrow()

    assertEverythingHolds(t)
  })
})
