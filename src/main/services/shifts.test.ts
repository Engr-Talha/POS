import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { hashSecret } from '../security/password'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import * as shifts from './shifts'
import * as sales from './sales'
import * as returns from './returns'
import * as customerLedger from './customer-ledger'
import * as stock from './stock'
import * as ledger from './ledger'
import { ACC } from '../db/chart-of-accounts'
import { ONE_UNIT } from '@shared/qty'
import type { User } from '@shared/types'
import type { SaleDetail } from '@shared/sales'

/**
 * THE SHIFT / CASH-DRAWER SERVICE — who opened the till, what passed through it, and what it should
 * hold at close.
 *
 * FOUR STANDING ASSERTIONS RUN AFTER EVERY SCENARIO (see `holds`). Any one failing means the books, the
 * shelf, or a Z-report is lying:
 *
 *   1. THE TRIAL BALANCE BALANCES.                          (CLAUDE.md §4 — the standing test)
 *   2. GL INVENTORY === THE STOCK VALUATION.                the books and the shelf agree
 *   3. A CASH MOVEMENT'S JOURNAL EXISTS  ⟺  it moved money  (a no-sale posts none; the rest post one)
 *   4. EVERY CLOSED SHIFT RECOMPUTES to its FROZEN expected cash, and variance = counted − expected
 */

// ═════════════════════════════════════════════════════════════════════════════
// Standing assertions
// ═════════════════════════════════════════════════════════════════════════════

function assertBooksBalance(t: TestDb): void {
  const tb = ledger.trialBalance(t.db)
  expect(tb.balanced, 'THE TRIAL BALANCE DOES NOT BALANCE').toBe(true)
  expect(tb.grossDebit).toBe(tb.grossCredit)
}

function assertInventoryMatchesStockValue(t: TestDb): void {
  const gl = ledger.accountBalance(t.db, ACC.INVENTORY)
  const valuation = t.db
    .prepare('SELECT COALESCE(SUM(value_minor), 0) FROM stock_movements')
    .pluck()
    .get() as number
  expect(gl, 'GL Inventory has drifted away from the stock valuation').toBe(valuation)
}

/** A movement that moved money carries a journal; a no-sale (which moved none) carries none. */
function assertCashMovementJournals(t: TestDb): void {
  const rows = t.db
    .prepare('SELECT id, type, journal_id FROM cash_movements')
    .all() as Array<{ id: number; type: string; journal_id: number | null }>
  for (const row of rows) {
    if (row.type === 'no_sale') {
      expect(row.journal_id, `no-sale ${row.id} must post NO journal`).toBeNull()
    } else {
      expect(row.journal_id, `${row.type} ${row.id} must post a journal`).not.toBeNull()
    }
  }
}

/** A closed shift is frozen: its Z-report must recompute to the expected cash it froze at close. */
function assertClosedShiftsRecompute(t: TestDb): void {
  const closed = t.db
    .prepare('SELECT id, expected_cash, counted_cash, variance FROM shifts WHERE closed_at IS NOT NULL')
    .all() as Array<{ id: number; expected_cash: number; counted_cash: number; variance: number }>
  for (const row of closed) {
    const z = shifts.zReport(t.db, row.id)
    expect(z.reconciliation.expectedCash, `shift ${row.id}: recompute != frozen expected`).toBe(
      row.expected_cash
    )
    expect(row.variance, `shift ${row.id}: variance != counted − expected`).toBe(
      row.counted_cash - row.expected_cash
    )
  }
}

function holds(t: TestDb): void {
  assertBooksBalance(t)
  assertInventoryMatchesStockValue(t)
  assertCashMovementJournals(t)
  assertClosedShiftsRecompute(t)
}

// ═════════════════════════════════════════════════════════════════════════════
// Fixtures — mirrors sales.test.ts / returns.test.ts so the files read the same way
// ═════════════════════════════════════════════════════════════════════════════

const RS_100 = 10_000 // 2-dp money
const RS_60_COST = 600_000 // 4-dp cost

let t: TestDb
let owner: User
let supervisor: User
let cashier: User

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
  return t.db
    .prepare('SELECT id FROM lookups WHERE list_key = ? AND code = ?')
    .pluck()
    .get(listKey, code) as number
}

const cash = (): number => lookupId('payment_method', 'cash')
const card = (): number => lookupId('payment_method', 'card')
const credit = (): number => lookupId('payment_method', 'credit')

/** A tax-free product, so the drawer arithmetic reads in whole rupees (tax has its own tests). */
function makeProduct(retailPrice = RS_100, taxRateBp = 0): number {
  const now = new Date().toISOString()
  return Number(
    t.db
      .prepare(
        `INSERT INTO products
           (sku, name, sale_uom_id, cost_price, retail_price, wholesale_price, tax_rate_bp,
            price_entry_mode, is_tax_exempt, item_type, is_weighted, track_batches, track_serials,
            is_active, created_at, updated_at)
         VALUES (@sku, 'Test Item', @uomId, 0, @retailPrice, 0, @taxRateBp,
                 'exclusive', 0, 'inventory', 0, 0, 0, 1, @now, @now)`
      )
      .run({
        sku: `SKU-${Math.random().toString(36).slice(2, 10)}`,
        uomId: lookupId('uom', 'pcs'),
        retailPrice,
        taxRateBp,
        now
      }).lastInsertRowid
  )
}

/** Opening stock through the REAL service — so the books balance from the first line of every test. */
function openingStock(productId: number, qtyM = 100 * ONE_UNIT, unitCost = RS_60_COST): void {
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

/** A stocked, tax-free item ready to sell for `price`. */
function stockedItem(price = RS_100): number {
  const id = makeProduct(price)
  openingStock(id)
  return id
}

/** Ring up one unit of `productId`. `tender` defaults to the price (no change). */
function sell(
  productId: number,
  price: number,
  opts: { method?: number; tender?: number; customerId?: number } = {}
): SaleDetail {
  return sales.complete(t.db, cashier, {
    lines: [{ productId, qtyM: ONE_UNIT }],
    ...(opts.customerId != null ? { customerId: opts.customerId } : {}),
    payments: [{ methodLookupId: opts.method ?? cash(), amount: opts.tender ?? price }]
  }).sale
}

function refundCash(sale: SaleDetail, method = cash()): void {
  returns.createReturn(t.db, supervisor, {
    saleId: sale.id,
    lines: [{ saleLineId: sale.lines[0]!.id, qtyM: ONE_UNIT }],
    settlement: 'refund',
    refundMethodLookupId: method,
    reasonCode: 'wrong_item'
  })
}

const shiftIdOf = (table: string, id: number): number | null =>
  t.db.prepare(`SELECT shift_id FROM ${table} WHERE id = ?`).pluck().get(id) as number | null

function auditRows(action: string): Array<Record<string, unknown>> {
  return t.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action) as Array<
    Record<string, unknown>
  >
}

const journalCount = (): number =>
  t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get() as number

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
// OPENING & CLOSING
// ═════════════════════════════════════════════════════════════════════════════

describe('opening a shift', () => {
  it('records who opened it, the float, and audits shift.open', () => {
    const shift = shifts.openShift(t.db, cashier, { openingFloat: 5_000, note: 'from the safe' })

    expect(shift.status).toBe('open')
    expect(shift.openingFloat).toBe(5_000)
    expect(shift.openedByUserId).toBe(cashier.id)
    expect(shift.closedAt).toBeNull()
    expect(shifts.currentOpenShift(t.db)?.id).toBe(shift.id)

    const [audited] = auditRows('shift.open')
    expect(audited!['user_name']).toBe('Bilal Cashier')
    expect(audited!['entity_id']).toBe(String(shift.id))
    holds(t)
  })

  it('refuses to open a second shift while one is open', () => {
    shifts.openShift(t.db, cashier, { openingFloat: 0 })
    expectUserMessage(
      () => shifts.openShift(t.db, cashier, { openingFloat: 0 }),
      /already open/
    )
    expect(shifts.listShifts(t.db).total).toBe(1)
    holds(t)
  })
})

describe('closing a shift', () => {
  it('refuses to close when none is open', () => {
    expectUserMessage(() => shifts.closeShift(t.db, cashier, { countedCash: 0 }), /no open shift/)
    holds(t)
  })

  it('freezes expected/counted/variance — an OVER counts more than the books say', () => {
    const shift = shifts.openShift(t.db, cashier, { openingFloat: 5_000 })
    const item = stockedItem(RS_100)
    sell(item, RS_100) // Rs 100 cash, no change → drawer keeps Rs 100

    const journalsBefore = journalCount()
    const { shift: closed, zReport } = shifts.closeShift(t.db, cashier, { countedCash: 15_500 })

    // expected = float 5_000 + cash sale 10_000 = 15_000; counted 15_500 → OVER by 500.
    expect(closed.status).toBe('closed')
    expect(closed.expectedCash).toBe(15_000)
    expect(closed.countedCash).toBe(15_500)
    expect(closed.variance).toBe(500)
    expect(closed.closedByUserId).toBe(cashier.id)
    expect(zReport.reconciliation.expectedCash).toBe(15_000)
    expect(zReport.reconciliation.variance).toBe(500)

    // The over/short is RECORDED, never POSTED — closing moves no money in the ledger.
    expect(journalCount()).toBe(journalsBefore)
    const [audited] = auditRows('shift.close')
    expect(JSON.parse(audited!['after_json'] as string)).toMatchObject({
      expectedCash: 15_000,
      countedCash: 15_500,
      variance: 500
    })
    holds(t)
  })

  it('freezes a SHORT as a negative variance', () => {
    shifts.openShift(t.db, cashier, { openingFloat: 5_000 })
    const item = stockedItem(RS_100)
    sell(item, RS_100)

    const { shift: closed } = shifts.closeShift(t.db, cashier, { countedCash: 13_500 })
    // expected 15_000, counted 13_500 → SHORT by 1_500.
    expect(closed.variance).toBe(-1_500)
    expect(shifts.currentOpenShift(t.db)).toBeNull()
    holds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// RECONCILIATION — what lands in the drawer, and what does not
// ═════════════════════════════════════════════════════════════════════════════

describe('reconciliation', () => {
  it('a cash sale raises expected cash by the NET (tender − change)', () => {
    const shift = shifts.openShift(t.db, cashier, { openingFloat: 0 })
    const item = stockedItem(RS_100)
    sell(item, RS_100, { tender: 15_000 }) // Rs 100 sale, Rs 150 tendered, Rs 50 change

    const z = shifts.zReport(t.db, shift.id)
    expect(z.sales.grossTotal).toBe(10_000)
    expect(z.reconciliation.cashSales).toBe(10_000) // 15_000 tendered − 5_000 change
    expect(z.reconciliation.expectedCash).toBe(10_000)
    holds(t)
  })

  it('a CARD sale does NOT raise expected cash', () => {
    const shift = shifts.openShift(t.db, cashier, { openingFloat: 2_000 })
    const item = stockedItem(RS_100)
    sell(item, RS_100, { method: card() })

    const z = shifts.zReport(t.db, shift.id)
    expect(z.sales.grossTotal).toBe(10_000)
    expect(z.reconciliation.cashSales).toBe(0)
    expect(z.reconciliation.expectedCash).toBe(2_000) // just the float
    holds(t)
  })

  it('a cash UDHAAR repayment raises expected cash', () => {
    const shift = shifts.openShift(t.db, cashier, { openingFloat: 0 })
    const item = stockedItem(RS_100)
    const customerId = makeCustomer('Rashid')
    sell(item, RS_100, { method: credit(), customerId }) // Rs 100 on the account, no cash

    customerLedger.recordPayment(t.db, cashier, {
      customerId,
      amount: 6_000,
      methodLookupId: cash()
    })

    const z = shifts.zReport(t.db, shift.id)
    expect(z.reconciliation.cashSales).toBe(0) // the credit sale put no cash in
    expect(z.reconciliation.cashUdhaar).toBe(6_000)
    expect(z.reconciliation.expectedCash).toBe(6_000)
    holds(t)
  })

  it('a cash REFUND lowers expected cash', () => {
    const shift = shifts.openShift(t.db, cashier, { openingFloat: 0 })
    const item = stockedItem(RS_100)
    const sale = sell(item, RS_100)
    refundCash(sale) // full cash refund of Rs 100

    const z = shifts.zReport(t.db, shift.id)
    expect(z.reconciliation.cashSales).toBe(10_000)
    expect(z.reconciliation.cashRefunds).toBe(10_000)
    expect(z.reconciliation.expectedCash).toBe(0) // took Rs 100, gave Rs 100 back
    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(0)
    holds(t)
  })

  it('a CARD refund does not lower cash expected', () => {
    const shift = shifts.openShift(t.db, cashier, { openingFloat: 0 })
    const item = stockedItem(RS_100)
    const sale = sell(item, RS_100, { method: card() })
    refundCash(sale, card()) // refunded back to the card

    const z = shifts.zReport(t.db, shift.id)
    expect(z.refunds.count).toBe(1)
    expect(z.refunds.total).toBe(10_000)
    expect(z.reconciliation.cashRefunds).toBe(0) // not a cash refund
    expect(z.reconciliation.expectedCash).toBe(0) // no cash ever involved
    holds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// CASH MOVEMENTS — the drawer events that are not sales
// ═════════════════════════════════════════════════════════════════════════════

describe('cash movements', () => {
  it('refuses any movement with no open shift', () => {
    expectUserMessage(
      () => shifts.recordCashMovement(t.db, cashier, { type: 'pay_in', amount: 1_000 }),
      /Open a shift/
    )
    holds(t)
  })

  it('pay_in posts DR Cash CR Owner Equity and raises expected cash', () => {
    const shift = shifts.openShift(t.db, cashier, { openingFloat: 0 })

    const move = shifts.recordCashMovement(t.db, cashier, { type: 'pay_in', amount: 20_000 })
    expect(move.type).toBe('pay_in')
    expect(move.journalId).not.toBeNull()

    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(20_000)
    expect(ledger.accountBalance(t.db, ACC.OWNER_EQUITY)).toBe(20_000)

    const z = shifts.zReport(t.db, shift.id)
    expect(z.reconciliation.payIns).toBe(20_000)
    expect(z.reconciliation.expectedCash).toBe(20_000)
    holds(t)
  })

  it('pay_out posts DR General Expenses CR Cash, lowers expected cash, and needs a reason', () => {
    const shift = shifts.openShift(t.db, cashier, { openingFloat: 0 })
    const item = stockedItem(RS_100)
    sell(item, RS_100) // put Rs 100 in the drawer first

    // No reason → refused (a pay-out is a theft vector).
    expectUserMessage(
      () => shifts.recordCashMovement(t.db, cashier, { type: 'pay_out', amount: 3_000 }),
      /reason/
    )
    // A made-up code is not on the owner's list.
    expectUserMessage(
      () =>
        shifts.recordCashMovement(t.db, cashier, {
          type: 'pay_out',
          amount: 3_000,
          reasonCode: 'not_a_real_code'
        }),
      /reason/
    )

    const cashBefore = ledger.accountBalance(t.db, ACC.CASH)
    const expenseBefore = ledger.accountBalance(t.db, ACC.EXPENSE_GENERAL)

    const move = shifts.recordCashMovement(t.db, cashier, {
      type: 'pay_out',
      amount: 3_000,
      reasonCode: 'supplier'
    })
    expect(move.reasonCode).toBe('supplier')
    expect(move.journalId).not.toBeNull()

    expect(cashBefore - ledger.accountBalance(t.db, ACC.CASH)).toBe(3_000)
    expect(ledger.accountBalance(t.db, ACC.EXPENSE_GENERAL) - expenseBefore).toBe(3_000)

    const z = shifts.zReport(t.db, shift.id)
    expect(z.reconciliation.payOuts).toBe(3_000)
    expect(z.reconciliation.expectedCash).toBe(7_000) // Rs 100 in, Rs 30 out
    holds(t)
  })

  it('drop posts DR Bank CR Cash and lowers expected cash', () => {
    const shift = shifts.openShift(t.db, cashier, { openingFloat: 0 })
    const item = stockedItem(RS_100)
    sell(item, RS_100)

    shifts.recordCashMovement(t.db, cashier, { type: 'drop', amount: 4_000 })

    expect(ledger.accountBalance(t.db, ACC.BANK)).toBe(4_000)
    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(6_000) // 10_000 − 4_000

    const z = shifts.zReport(t.db, shift.id)
    expect(z.reconciliation.drops).toBe(4_000)
    expect(z.reconciliation.expectedCash).toBe(6_000)
    holds(t)
  })

  it('no_sale posts NO journal, requires a reason, and is audited', () => {
    const shift = shifts.openShift(t.db, cashier, { openingFloat: 0 })
    const journalsBefore = journalCount()

    // amount must be 0…
    expectUserMessage(
      () =>
        shifts.recordCashMovement(t.db, cashier, {
          type: 'no_sale',
          amount: 500,
          reasonCode: 'make_change'
        }),
      /zero/
    )
    // …and a reason is required.
    expectUserMessage(
      () => shifts.recordCashMovement(t.db, cashier, { type: 'no_sale', amount: 0 }),
      /reason/
    )

    const move = shifts.recordCashMovement(t.db, cashier, {
      type: 'no_sale',
      amount: 0,
      reasonCode: 'make_change'
    })
    expect(move.amount).toBe(0)
    expect(move.journalId).toBeNull() // no money moved → no journal
    expect(journalCount()).toBe(journalsBefore)

    const [audited] = auditRows('cash.movement')
    expect(audited!['reason_code']).toBe('make_change')
    expect(JSON.parse(audited!['after_json'] as string)).toMatchObject({ type: 'no_sale' })

    const z = shifts.zReport(t.db, shift.id)
    expect(z.cashMovements.noSaleCount).toBe(1)
    holds(t)
  })

  it('lets a cashier record a pay-in and a no-sale — the audit is the control, not a block', () => {
    shifts.openShift(t.db, cashier, { openingFloat: 0 })
    // The actor is a plain cashier throughout — running the till is a cashier's job.
    expect(shifts.recordCashMovement(t.db, cashier, { type: 'pay_in', amount: 500 }).userId).toBe(
      cashier.id
    )
    expect(
      shifts.recordCashMovement(t.db, cashier, { type: 'no_sale', amount: 0, reasonCode: 'other' })
        .userId
    ).toBe(cashier.id)
    holds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// SHIFT_ID STAMPING — documents carry their shift, or NULL when the till is off-shift
// ═════════════════════════════════════════════════════════════════════════════

describe('stamping the shift onto documents', () => {
  it('stamps the open shift onto a sale, a return and a customer payment', () => {
    const shift = shifts.openShift(t.db, cashier, { openingFloat: 0 })
    const item = stockedItem(RS_100)
    const customerId = makeCustomer('Nadia')

    const sale = sell(item, RS_100, { method: credit(), customerId })
    const cashSale = sell(stockedItem(RS_100), RS_100)
    refundCash(cashSale)
    const payment = customerLedger.recordPayment(t.db, cashier, {
      customerId,
      amount: 5_000,
      methodLookupId: cash()
    })
    const returnId = returns.listReturns(t.db).rows[0]!.id

    expect(shiftIdOf('sales', sale.id)).toBe(shift.id)
    expect(shiftIdOf('sales', cashSale.id)).toBe(shift.id)
    expect(shiftIdOf('returns', returnId)).toBe(shift.id)
    expect(shiftIdOf('customer_payments', payment.id)).toBe(shift.id)
    holds(t)
  })

  it('leaves shift_id NULL — and still succeeds — when no shift is open', () => {
    expect(shifts.currentOpenShift(t.db)).toBeNull()
    const item = stockedItem(RS_100)
    const customerId = makeCustomer('Ali')

    const sale = sell(item, RS_100, { method: credit(), customerId })
    const cashSale = sell(stockedItem(RS_100), RS_100)
    refundCash(cashSale)
    const payment = customerLedger.recordPayment(t.db, cashier, {
      customerId,
      amount: 5_000,
      methodLookupId: cash()
    })
    const returnId = returns.listReturns(t.db).rows[0]!.id

    // Every document was written, and every shift_id is NULL — the till was simply not on a shift.
    expect(shiftIdOf('sales', sale.id)).toBeNull()
    expect(shiftIdOf('sales', cashSale.id)).toBeNull()
    expect(shiftIdOf('returns', returnId)).toBeNull()
    expect(shiftIdOf('customer_payments', payment.id)).toBeNull()
    holds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE Z-REPORT
// ═════════════════════════════════════════════════════════════════════════════

describe('the Z-report', () => {
  it('tender breakdown adds up to the sales total, netting change out of cash', () => {
    const shift = shifts.openShift(t.db, cashier, { openingFloat: 0 })
    sell(stockedItem(RS_100), RS_100, { tender: 15_000 }) // Rs 100 cash, Rs 50 change
    sell(stockedItem(5_000), 5_000, { method: card() }) // Rs 50 card

    const z = shifts.zReport(t.db, shift.id)

    const tenderSum = z.sales.byTender.reduce((total, row) => total + row.amount, 0)
    expect(tenderSum).toBe(z.sales.grossTotal) // Rs 150 gross
    expect(z.sales.grossTotal).toBe(15_000)

    const cashLine = z.sales.byTender.find((row) => row.label === 'Cash')
    const cardLine = z.sales.byTender.find((row) => row.label === 'Card')
    expect(cashLine!.amount).toBe(10_000) // Rs 150 tendered − Rs 50 change
    expect(cardLine!.amount).toBe(5_000)
    holds(t)
  })

  it('counts sales, refunds, voids and drawer movements for the shift', () => {
    const shift = shifts.openShift(t.db, cashier, { openingFloat: 1_000 })
    sell(stockedItem(RS_100), RS_100) // a — stays 'completed'
    const b = sell(stockedItem(RS_100), RS_100)
    const c = sell(stockedItem(RS_100), RS_100)

    refundCash(b) // one refund
    sales.voidSale(t.db, supervisor, { id: c.id, reasonCode: 'test_sale' }) // one void

    shifts.recordCashMovement(t.db, cashier, { type: 'pay_in', amount: 2_000 })
    shifts.recordCashMovement(t.db, cashier, { type: 'pay_out', amount: 500, reasonCode: 'petty' })
    shifts.recordCashMovement(t.db, cashier, { type: 'drop', amount: 3_000 })
    shifts.recordCashMovement(t.db, cashier, { type: 'no_sale', amount: 0, reasonCode: 'check_float' })

    const z = shifts.zReport(t.db, shift.id)
    expect(z.sales.count).toBe(2) // a and b are still 'completed'; c was voided
    expect(z.voids.count).toBe(1)
    expect(z.refunds.count).toBe(1)
    expect(z.refunds.total).toBe(10_000)
    expect(z.cashMovements).toEqual({
      noSaleCount: 1,
      payInTotal: 2_000,
      payOutTotal: 500,
      dropTotal: 3_000
    })

    // expected = float 1_000 + cashSales (a only, since b was refunded) …
    //          = 1_000 + (10_000 + 10_000)     cash from a and b
    //            − 10_000                        b's cash refund
    //            + 2_000 − 500 − 3_000           pay-in, pay-out, drop
    expect(z.reconciliation.cashSales).toBe(20_000)
    expect(z.reconciliation.cashRefunds).toBe(10_000)
    expect(z.reconciliation.expectedCash).toBe(9_500)
    holds(t)
  })

  it('getShift returns the detail with movements and its Z-report; listShifts paginates', () => {
    const shift = shifts.openShift(t.db, cashier, { openingFloat: 0 })
    shifts.recordCashMovement(t.db, cashier, { type: 'pay_in', amount: 1_000 })
    shifts.closeShift(t.db, cashier, { countedCash: 1_000 })

    // A second shift, so the list has two rows to page through.
    const second = shifts.openShift(t.db, cashier, { openingFloat: 0 })

    const detail = shifts.getShift(t.db, shift.id)
    expect(detail.cashMovements).toHaveLength(1)
    expect(detail.cashMovements[0]!.type).toBe('pay_in')
    expect(detail.zReport.reconciliation.expectedCash).toBe(1_000)
    expect(detail.zReport.reconciliation.variance).toBe(0)
    expect(detail.openedByName).toBe('Bilal Cashier')

    const listed = shifts.listShifts(t.db, { page: 1, pageSize: 1 })
    expect(listed.total).toBe(2)
    expect(listed.rows).toHaveLength(1)
    expect(listed.rows[0]!.id).toBe(second.id) // newest first, still open
    expect(listed.rows[0]!.status).toBe('open')
    holds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// ADVERSARIAL-AUDIT REGRESSIONS — every one is a bug the shift audit confirmed
// ═════════════════════════════════════════════════════════════════════════════

describe('shift audit regressions', () => {
  // Findings 1–5 (HIGH/MEDIUM): a void must NOT touch a shift that is already CLOSED. A closed shift's
  // drawer was counted, reconciled and signed off; its Z-report is frozen. Voiding one of its cash sales
  // would (a) silently rewrite that frozen drawer (the reconciliation recomputes from live sale status)
  // and (b) hand the cash back out of TODAY's drawer with no line to explain it, so today's cashier shows
  // short for money a supervisor voided. After the drawer closes, the instrument is a return.
  it('refuses to void a sale rung on a shift that has already closed — the closed Z-report stays frozen', () => {
    const item = stockedItem(RS_100)

    shifts.openShift(t.db, cashier, { openingFloat: 0 })
    const sale = sell(item, RS_100) // Rs 100 cash into shift A's drawer
    const { shift: shiftA } = shifts.closeShift(t.db, cashier, { countedCash: RS_100 })
    expect(shiftA.expectedCash).toBe(RS_100)
    expect(shiftA.variance).toBe(0)

    // A new shift opens; a supervisor tries to void the earlier, now-closed-shift sale.
    shifts.openShift(t.db, cashier, { openingFloat: 0 })
    expectUserMessage(
      () => sales.voidSale(t.db, supervisor, { id: sale.id, reasonCode: 'customer_changed_mind' }),
      /already been closed|process a return/i
    )

    // The sale is untouched, so shift A's frozen Z-report still recomputes to what it froze. (holds()
    // asserts this over EVERY closed shift — it is exactly the invariant the bug broke.)
    expect(sales.getById(t.db, sale.id).status).toBe('completed')
    expect(shifts.zReport(t.db, shiftA.id).reconciliation.expectedCash).toBe(RS_100)
    holds(t)
  })

  it('still allows voiding a sale WITHIN its own still-open shift', () => {
    const item = stockedItem(RS_100)
    shifts.openShift(t.db, cashier, { openingFloat: 0 })
    const sale = sell(item, RS_100)

    // Same session, drawer still open: a void is the right instrument and is allowed.
    sales.voidSale(t.db, supervisor, { id: sale.id, reasonCode: 'customer_changed_mind' })
    expect(sales.getById(t.db, sale.id).status).toBe('voided')

    // The voided sale drops out of the OPEN shift's cash — the drawer handed the money back — so expected
    // cash falls back to the float. Consistent, because both the status change and the cash-out happened
    // in this one open shift.
    const open = shifts.currentOpenShift(t.db)!
    expect(shifts.zReport(t.db, open.id).reconciliation.cashSales).toBe(0)
    holds(t)
  })

  // Finding 6 (LOW): a movement's reason shows its human LABEL, resolved against the list that matches
  // the movement type — never the raw code.
  it('exposes a human reasonLabel on a cash movement, from the list that matches its type', () => {
    shifts.openShift(t.db, cashier, { openingFloat: 0 })
    const noSale = shifts.recordCashMovement(t.db, cashier, {
      type: 'no_sale',
      amount: 0,
      reasonCode: 'make_change'
    })
    expect(noSale.reasonCode).toBe('make_change')
    expect(noSale.reasonLabel).toBe('Make change') // the no_sale_reason label, not the code
    holds(t)
  })
})
