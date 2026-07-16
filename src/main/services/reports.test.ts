import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { hashSecret } from '../security/password'
import { makeTestDb, type TestDb } from '../db/testkit'
import * as reports from './reports'
import * as sales from './sales'
import * as returns from './returns'
import * as purchases from './purchases'
import * as purchaseReturns from './purchase-returns'
import * as loyalty from './loyalty'
import * as stock from './stock'
import * as ledger from './ledger'
import * as shifts from './shifts'
import * as customerLedger from './customer-ledger'
import * as supplierLedger from './supplier-ledger'
import * as settings from './settings'
import { ACC } from '../db/chart-of-accounts'
import { ONE_UNIT } from '@shared/qty'
import type { User } from '@shared/types'
import type { SaleDetail } from '@shared/sales'

/**
 * THE REPORTS SERVICE — the payoff, and every figure in it has to RECONCILE with the books.
 *
 * FIVE STANDING RECONCILIATIONS run after EVERY scenario (see `holds`). Any one failing means a report
 * is telling the shopkeeper something the ledger does not agree with — the one thing a report must
 * never do:
 *
 *   1. THE TRIAL BALANCE BALANCES.                                     (CLAUDE.md §4 — the standing test)
 *   2. STOCK VALUATION TOTAL          === GL Inventory                (books and shelf agree)
 *   3. CUSTOMER AGING TOTAL           === GL Receivable               (and each row's buckets sum to it)
 *   4. SUPPLIER AGING TOTAL           === GL Payable                  (and each row's buckets sum to it)
 *   5. THE BALANCE SHEET BALANCES.    assets === liabilities + equity
 *
 * On top of those, each report has tests that assert its actual numbers against a realistic scenario.
 */

// ═════════════════════════════════════════════════════════════════════════════
// Standing reconciliations
// ═════════════════════════════════════════════════════════════════════════════

/** A date safely after every transaction, so an "as of" total captures the whole book. */
const FAR = '2027-01-01'

function bucketSum(row: {
  current: number
  d1_30: number
  d31_60: number
  d61_90: number
  d90plus: number
}): number {
  return row.current + row.d1_30 + row.d31_60 + row.d61_90 + row.d90plus
}

function holds(t: TestDb): void {
  // 1. The trial balance balances.
  const tb = ledger.trialBalance(t.db)
  expect(tb.balanced, 'THE TRIAL BALANCE DOES NOT BALANCE').toBe(true)

  // 2. Stock valuation total === GL Inventory.
  const valuation = reports.stockValuation(t.db)
  expect(valuation.totalValue, 'stock valuation total has drifted from GL Inventory').toBe(
    ledger.accountBalance(t.db, ACC.INVENTORY)
  )

  // 3. Customer aging total === GL Receivable, and each row reconciles to its buckets.
  const customerAging = reports.customerAging(t.db, { asOf: FAR })
  expect(customerAging.totals.total, 'customer aging total !== GL Receivable').toBe(
    ledger.accountBalance(t.db, ACC.RECEIVABLE)
  )
  for (const row of customerAging.rows) {
    expect(bucketSum(row), `customer ${row.customerId}: buckets !== total`).toBe(row.total)
  }
  expect(bucketSum(customerAging.totals)).toBe(customerAging.totals.total)

  // 4. Supplier aging total === GL Payable, and each row reconciles to its buckets.
  const supplierAging = reports.supplierAging(t.db, { asOf: FAR })
  expect(supplierAging.totals.total, 'supplier aging total !== GL Payable').toBe(
    ledger.accountBalance(t.db, ACC.PAYABLE)
  )
  for (const row of supplierAging.rows) {
    expect(bucketSum(row), `supplier ${row.supplierId}: buckets !== total`).toBe(row.total)
  }

  // 5. The balance sheet balances.
  const bs = reports.balanceSheet(t.db, { asOf: FAR })
  expect(bs.balanced, 'THE BALANCE SHEET DOES NOT BALANCE').toBe(true)
  expect(bs.totalAssets).toBe(bs.totalLiabilities + bs.totalEquity)
}

// ═════════════════════════════════════════════════════════════════════════════
// Fixtures
// ═════════════════════════════════════════════════════════════════════════════

const NOW = new Date('2026-07-15T10:00:00.000Z')
const OPENING_AT = new Date('2026-01-01T10:00:00.000Z')

let t: TestDb
let owner: User
let supervisor: User
let cashier: User

function at(isoDate: string): Date {
  return new Date(`${isoDate}T10:00:00.000Z`)
}

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

/** A product. Tax-free by default so arithmetic reads in whole rupees. */
function makeProduct(
  opts: { retailPrice?: number; taxRateBp?: number; priceEntryMode?: string; minStockM?: number } = {}
): number {
  const now = new Date().toISOString()
  return Number(
    t.db
      .prepare(
        `INSERT INTO products
           (sku, name, sale_uom_id, cost_price, retail_price, wholesale_price, tax_rate_bp,
            price_entry_mode, is_tax_exempt, item_type, is_weighted, track_batches, track_serials,
            is_active, min_stock_m, created_at, updated_at)
         VALUES (@sku, 'Test Item', @uom, 0, @retail, 0, @tax,
                 @mode, 0, 'inventory', 0, 0, 0, 1, @min, @now, @now)`
      )
      .run({
        sku: `SKU-${Math.random().toString(36).slice(2, 10)}`,
        uom: lookupId('uom', 'pcs'),
        retail: opts.retailPrice ?? 10_000,
        tax: opts.taxRateBp ?? 0,
        mode: opts.priceEntryMode ?? 'exclusive',
        min: opts.minStockM ?? 0,
        now
      }).lastInsertRowid
  )
}

/** Opening stock through the real service, dated BEFORE any sale — so the books balance from line one. */
function openingStock(productId: number, qty: number, unitCost: number, when = OPENING_AT): void {
  stock.adjust(
    t.db,
    owner,
    { productId, type: 'opening', qtyM: qty * ONE_UNIT, unitCost, reasonCode: 'data_entry' },
    when
  )
}

function makeCustomer(name: string, creditLimit = 1_000_000_000): number {
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

function makeSupplier(name: string): number {
  const now = new Date().toISOString()
  return Number(
    t.db
      .prepare(`INSERT INTO suppliers (name, is_active, created_at, updated_at) VALUES (?, 1, ?, ?)`)
      .run(name, now, now).lastInsertRowid
  )
}

/**
 * Complete a sale with an EXACT payment (no change), so byTender reads cleanly. For tax-free products
 * `grand = price*qty − cartDiscount`; a taxed sale passes its grand explicitly.
 */
function sellExact(
  productId: number,
  qty: number,
  method: number,
  price: number,
  opts: {
    customerId?: number
    cartDiscount?: number
    cartDiscountReasonCode?: string
    approverPin?: string
    when?: Date
    grand?: number
  } = {}
): SaleDetail {
  const grand = opts.grand ?? price * qty - (opts.cartDiscount ?? 0)
  return sales.complete(
    t.db,
    cashier,
    {
      lines: [{ productId, qtyM: qty * ONE_UNIT }],
      ...(opts.customerId != null ? { customerId: opts.customerId } : {}),
      ...(opts.cartDiscount != null ? { cartDiscount: opts.cartDiscount } : {}),
      ...(opts.cartDiscountReasonCode != null
        ? { cartDiscountReasonCode: opts.cartDiscountReasonCode }
        : {}),
      ...(opts.approverPin != null ? { approverPin: opts.approverPin } : {}),
      payments: [{ methodLookupId: method, amount: grand }]
    },
    opts.when ?? NOW
  ).sale
}

function purchaseOnAccount(
  supplierId: number,
  productId: number,
  qty: number,
  unitCost: number,
  when: Date
): void {
  purchases.createPurchase(
    t.db,
    owner,
    {
      supplierId,
      lines: [{ productId, qtyM: qty * ONE_UNIT, unitCost }],
      payments: []
    },
    when
  )
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
// Empty book
// ═════════════════════════════════════════════════════════════════════════════

describe('an empty book', () => {
  it('every report returns zeros and empty rows, and still reconciles', () => {
    expect(reports.salesSummary(t.db, { from: '2026-07-01', to: '2026-07-31' })).toMatchObject({
      count: 0,
      grossTotal: 0,
      netSales: 0,
      totalTax: 0,
      totalDiscount: 0,
      byTender: [],
      byDay: []
    })
    expect(reports.profit(t.db, { from: '2026-07-01', to: '2026-07-31' })).toMatchObject({
      revenue: 0,
      cogs: 0,
      grossProfit: 0,
      marginBp: 0
    })
    expect(reports.stockValuation(t.db).totalValue).toBe(0)
    expect(reports.leakage(t.db, { from: '2026-07-01', to: '2026-07-31' }).rows).toEqual([])
    expect(reports.trialBalance(t.db, { asOf: FAR }).balanced).toBe(true)
    expect(reports.balanceSheet(t.db, { asOf: FAR }).balanced).toBe(true)
    expect(reports.profitAndLoss(t.db, { from: '2026-07-01', to: '2026-07-31' }).netProfit).toBe(0)
  })

  it('rejects a malformed date', () => {
    expect(() => reports.salesSummary(t.db, { from: '15-07-2026', to: '2026-07-31' })).toThrow()
    expect(() => reports.customerAging(t.db, { asOf: 'yesterday' })).toThrow()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 1 & 2. SALES SUMMARY and PROFIT
// ═════════════════════════════════════════════════════════════════════════════

describe('sales summary and profit', () => {
  let a: number
  let b: number
  let c: number
  let s1: SaleDetail
  let s2: SaleDetail
  let s3: SaleDetail
  let s4: SaleDetail

  beforeEach(() => {
    a = makeProduct({ retailPrice: 10_000, taxRateBp: 0 }) // Rs 100, cost Rs 60
    b = makeProduct({ retailPrice: 20_000, taxRateBp: 0 }) // Rs 200, cost Rs 150
    c = makeProduct({ retailPrice: 10_000, taxRateBp: 1700 }) // Rs 100 + 17% tax, cost Rs 50
    openingStock(a, 100, 600_000)
    openingStock(b, 100, 1_500_000)
    openingStock(c, 100, 500_000)
    const cust = makeCustomer('Ali')

    s1 = sellExact(a, 2, cash(), 10_000) // Rs 200 cash,  cogs Rs 120
    s2 = sellExact(b, 1, card(), 20_000) // Rs 200 card,  cogs Rs 150
    s3 = sellExact(a, 1, credit(), 10_000, { customerId: cust }) // Rs 100 udhaar, cogs Rs 60
    s4 = sellExact(c, 1, cash(), 10_000, { grand: 11_700 }) // Rs 100 + Rs 17 tax, cogs Rs 50
  })

  it('totals the completed sales, nets the revenue and groups by tender and by day', () => {
    const report = reports.salesSummary(t.db, { from: '2026-07-15', to: '2026-07-15' })

    expect(report.count).toBe(4)
    expect(report.grossTotal).toBe(61_700) // 20000 + 20000 + 10000 + 11700
    expect(report.netSales).toBe(60_000) // Σ subtotal_net — cart discount already apportioned in
    expect(report.totalTax).toBe(1_700)
    expect(report.totalDiscount).toBe(0)

    // byTender sums to WHAT WAS TENDERED — i.e. Σ paid_total across the sales.
    const tendered = [s1, s2, s3, s4].reduce((sum, s) => sum + s.paidTotal, 0)
    expect(report.byTender.reduce((sum, row) => sum + row.amount, 0)).toBe(tendered)
    const byLabel = Object.fromEntries(report.byTender.map((row) => [row.label, row.amount]))
    expect(byLabel['Cash']).toBe(31_700) // s1 20000 + s4 11700
    expect(byLabel['Card']).toBe(20_000)
    expect(byLabel['Credit (Udhaar)']).toBe(10_000)

    expect(report.byDay).toEqual([{ date: '2026-07-15', count: 4, gross: 61_700 }])
  })

  it('excludes a voided sale and a different day', () => {
    // A sale on another day, then void it — neither its day nor its money must reach 15 July.
    const other = sellExact(a, 1, cash(), 10_000, { when: at('2026-07-14') })
    sales.voidSale(t.db, supervisor, { id: other.id, reasonCode: 'test_sale' }, null, at('2026-07-14'))

    const report = reports.salesSummary(t.db, { from: '2026-07-15', to: '2026-07-15' })
    expect(report.count).toBe(4)
    expect(report.grossTotal).toBe(61_700)
    expect(report.byDay).toEqual([{ date: '2026-07-15', count: 4, gross: 61_700 }])
  })

  it('computes gross profit from FROZEN cost, and ties COGS to the ledger', () => {
    const report = reports.profit(t.db, { from: '2026-07-15', to: '2026-07-15' })

    expect(report.revenue).toBe(60_000) // same basis as salesSummary.netSales
    expect(report.cogs).toBe(38_000) // 12000 + 15000 + 6000 + 5000
    expect(report.grossProfit).toBe(22_000)
    expect(report.marginBp).toBe(3667) // 22000 / 60000 = 36.67%

    // The report's COGS is exactly what the sale journals debited to Cost of Goods Sold.
    expect(report.cogs).toBe(ledger.accountBalance(t.db, ACC.COGS))

    expect(report.byDay).toEqual([
      { date: '2026-07-15', revenue: 60_000, cogs: 38_000, grossProfit: 22_000 }
    ])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. STOCK VALUATION
// ═════════════════════════════════════════════════════════════════════════════

describe('stock valuation', () => {
  it('values on-hand from frozen movement values, and ties the total to GL Inventory', () => {
    const a = makeProduct({ retailPrice: 10_000 })
    openingStock(a, 100, 600_000) // Rs 6000 in, GL Inventory Rs 6000
    sellExact(a, 40, cash(), 10_000) // 40 out at Rs 60 = Rs 2400 → on hand 60, value Rs 3600

    const report = reports.stockValuation(t.db)

    expect(report.totalValue).toBe(360_000) // Rs 3600.00
    expect(report.totalValue).toBe(ledger.accountBalance(t.db, ACC.INVENTORY))

    const row = report.rows.find((r) => r.productId === a)!
    expect(row.onHandM).toBe(60 * ONE_UNIT)
    expect(row.avgCost).toBe(600_000)
    expect(row.valueMinor).toBe(360_000)

    // The rows sum to the total (every product holding value is listed).
    expect(report.rows.reduce((sum, r) => sum + r.valueMinor, 0)).toBe(report.totalValue)
  })

  it('flags items at or below their re-order level', () => {
    const low = makeProduct({ retailPrice: 10_000, minStockM: 50 * ONE_UNIT })
    const fine = makeProduct({ retailPrice: 10_000, minStockM: 5 * ONE_UNIT })
    openingStock(low, 10, 100_000) // 10 <= 50 → below re-order
    openingStock(fine, 100, 100_000) // 100 > 5 → fine

    const report = reports.stockValuation(t.db)
    expect(report.rows.find((r) => r.productId === low)!.isBelowReorder).toBe(true)
    expect(report.rows.find((r) => r.productId === fine)!.isBelowReorder).toBe(false)
    expect(report.lowStockCount).toBe(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. CUSTOMER AGING
// ═════════════════════════════════════════════════════════════════════════════

describe('customer aging', () => {
  it('buckets unpaid udhaar by age, applies payments oldest-first, and ties to GL Receivable', () => {
    const a = makeProduct({ retailPrice: 10_000 })
    openingStock(a, 100, 600_000)
    const ali = makeCustomer('Ali')
    const zara = makeCustomer('Zara')

    // Ali: an older credit sale (20 days) and a newer one (today); then pays Rs 50 (clears the oldest first).
    sellExact(a, 2, credit(), 10_000, { customerId: ali, when: at('2026-06-25') }) // Rs 200
    sellExact(a, 1, credit(), 10_000, { customerId: ali, when: at('2026-07-15') }) // Rs 100
    customerLedger.recordPayment(t.db, owner, { customerId: ali, amount: 5_000, methodLookupId: cash() }, NOW)

    // Zara: one very old credit sale (100 days).
    sellExact(a, 5, credit(), 10_000, { customerId: zara, when: at('2026-04-06') }) // Rs 500

    const report = reports.customerAging(t.db, { asOf: '2026-07-15' })

    const aliRow = report.rows.find((r) => r.customerId === ali)!
    expect(aliRow.total).toBe(25_000) // 30000 charged − 5000 paid
    expect(aliRow.total).toBe(customerLedger.balance(t.db, ali)) // the ledger-screen figure
    expect(aliRow.current).toBe(10_000) // today's Rs 100
    expect(aliRow.d1_30).toBe(15_000) // the 20-day sale, Rs 200 less the Rs 50 payment
    expect(aliRow.d31_60).toBe(0)

    const zaraRow = report.rows.find((r) => r.customerId === zara)!
    expect(zaraRow.total).toBe(50_000)
    expect(zaraRow.d90plus).toBe(50_000)

    expect(report.totals.total).toBe(75_000)
    expect(report.totals.total).toBe(ledger.accountBalance(t.db, ACC.RECEIVABLE))
    expect(report.totals.current).toBe(10_000)
    expect(report.totals.d1_30).toBe(15_000)
    expect(report.totals.d90plus).toBe(50_000)
  })

  it('omits a customer who owes nothing', () => {
    const a = makeProduct({ retailPrice: 10_000 })
    openingStock(a, 100, 600_000)
    const paid = makeCustomer('Settled')
    sellExact(a, 1, credit(), 10_000, { customerId: paid })
    customerLedger.recordPayment(t.db, owner, { customerId: paid, amount: 10_000, methodLookupId: cash() }, NOW)

    const report = reports.customerAging(t.db, { asOf: '2026-07-15' })
    expect(report.rows.find((r) => r.customerId === paid)).toBeUndefined()
    expect(report.totals.total).toBe(0)
  })

  // Reports audit (HIGH): aging used the ALL-TIME balance and unbounded charges, so a BACKDATED aging
  // showed today's balance aged against an old date — disagreeing with the balance sheet / GL for that
  // same date, and bucketing a not-yet-existing charge as "current". Now it is bounded to asOf.
  it('ages AS OF the report date — a future-dated sale is invisible to an earlier aging', () => {
    const a = makeProduct()
    openingStock(a, 100, 600_000)
    const ali = makeCustomer('Ali')
    sellExact(a, 1, credit(), 10_000, { customerId: ali, when: at('2026-07-15') }) // Rs 100 udhaar on Jul 15

    // As of Jun 30 the sale had not happened — the aging must be empty, exactly as the balance sheet is.
    const jun = reports.customerAging(t.db, { asOf: '2026-06-30' })
    expect(jun.totals.total).toBe(0)
    expect(jun.rows).toHaveLength(0)

    // As of Jul 15 it is a current Rs 100.
    const jul = reports.customerAging(t.db, { asOf: '2026-07-15' })
    expect(jul.totals.total).toBe(10_000)
    expect(jul.totals.current).toBe(10_000)
  })

  it('a payment made AFTER the as-of date does not reduce the aged balance', () => {
    const a = makeProduct()
    openingStock(a, 100, 600_000)
    const ali = makeCustomer('Ali')
    sellExact(a, 1, credit(), 10_000, { customerId: ali, when: at('2026-06-10') }) // Rs 100 udhaar Jun 10
    customerLedger.recordPayment(
      t.db,
      owner,
      { customerId: ali, amount: 10_000, methodLookupId: cash() },
      at('2026-07-10') // ...paid off in JULY
    )

    // As of Jun 30 the debt was still fully outstanding — the July payment is in the future.
    expect(reports.customerAging(t.db, { asOf: '2026-06-30' }).totals.total).toBe(10_000)
    // By FAR it is settled (and holds() confirms it still ties to GL Receivable = 0).
    expect(reports.customerAging(t.db, { asOf: FAR }).totals.total).toBe(0)
  })

  // Reports audit: with selling.requireCustomerForCredit OFF, a credit sale can be rung with no customer.
  // It still DR Receivable, so it must appear in aging or Σ aging stops tying to GL Receivable (the
  // afterEach holds() would fail). It shows as one 'Unassigned (walk-in credit)' line.
  it('surfaces anonymous udhaar so aging still ties to GL Receivable', () => {
    settings.set(t.db, 'selling.requireCustomerForCredit', false)
    const a = makeProduct()
    openingStock(a, 100, 600_000)
    sellExact(a, 1, credit(), 10_000, { when: at('2026-07-15') }) // a credit sale with NO customer

    const report = reports.customerAging(t.db, { asOf: FAR })
    const unassigned = report.rows.find((r) => r.customerId === 0)
    expect(unassigned, 'anonymous udhaar must appear as an Unassigned row').toBeTruthy()
    expect(unassigned!.total).toBe(10_000)
    expect(report.totals.total).toBe(10_000) // holds() also asserts this === GL Receivable
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. SUPPLIER AGING
// ═════════════════════════════════════════════════════════════════════════════

describe('supplier aging', () => {
  it('buckets what the shop owes by age, applies payments oldest-first, and ties to GL Payable', () => {
    const p = makeProduct({ retailPrice: 10_000 })
    const acme = makeSupplier('Acme')
    const oldco = makeSupplier('OldCo')

    purchaseOnAccount(acme, p, 3, 1_000_000, at('2026-05-31')) // Rs 300 owed, 45 days
    purchaseOnAccount(acme, p, 1, 1_000_000, at('2026-07-15')) // Rs 100 owed, today
    supplierLedger.recordPayment(t.db, owner, { supplierId: acme, amount: 5_000, methodLookupId: cash() }, NOW)
    purchaseOnAccount(oldco, p, 5, 1_000_000, at('2026-04-06')) // Rs 500 owed, 100 days

    const report = reports.supplierAging(t.db, { asOf: '2026-07-15' })

    const acmeRow = report.rows.find((r) => r.supplierId === acme)!
    expect(acmeRow.total).toBe(35_000) // 40000 owed − 5000 paid
    expect(acmeRow.total).toBe(supplierLedger.balance(t.db, acme))
    expect(acmeRow.current).toBe(10_000) // today's bill
    expect(acmeRow.d31_60).toBe(25_000) // the 45-day bill, Rs 300 less the Rs 50 payment

    const oldRow = report.rows.find((r) => r.supplierId === oldco)!
    expect(oldRow.d90plus).toBe(50_000)

    expect(report.totals.total).toBe(85_000)
    expect(report.totals.total).toBe(ledger.accountBalance(t.db, ACC.PAYABLE))
  })

  /**
   * REGRESSION — goods sent back on credit must come OFF the aging report.
   *
   * A 'supplier_credit' return DEBITS Payable, exactly as a payment does. This report was summing only
   * `supplier_payments` as credits, so it kept chasing the distributor for stock they had already taken
   * back: GL Payable and the supplier ledger said Rs 360, the aging report said Rs 600. The trial
   * balance stayed green throughout — nothing but this reconciliation catches it. (CLAUDE.md trap #17.)
   */
  it('takes a supplier_credit return off the bill, and still ties to GL Payable', () => {
    const p = makeProduct({ retailPrice: 10_000 })
    const acme = makeSupplier('Acme')

    purchaseOnAccount(acme, p, 10, 600_000, at('2026-07-15')) // 10 tins @ Rs 60 = Rs 600 owed
    const purchaseId = t.db.prepare('SELECT id FROM purchases ORDER BY id DESC').pluck().get() as number
    const lineId = t.db
      .prepare('SELECT id FROM purchase_lines WHERE purchase_id = ?')
      .pluck()
      .get(purchaseId) as number

    // 4 tins damaged, sent back and taken off the bill: Rs 240 of the Rs 600.
    purchaseReturns.createPurchaseReturn(
      t.db,
      owner,
      {
        purchaseId,
        lines: [{ purchaseLineId: lineId, qtyM: 4 * ONE_UNIT }],
        settlement: 'supplier_credit',
        reasonCode: 'damaged'
      },
      NOW
    )

    const report = reports.supplierAging(t.db, { asOf: '2026-07-15' })
    const row = report.rows.find((r) => r.supplierId === acme)!

    expect(row.total, 'the return did not come off the aging report').toBe(36_000) // 600 − 240
    expect(row.total).toBe(supplierLedger.balance(t.db, acme))
    expect(report.totals.total).toBe(ledger.accountBalance(t.db, ACC.PAYABLE))
  })

  /** A 'refund' return came back as real money and never touched Payable — it must NOT credit the bill. */
  it('leaves the bill alone when the supplier refunded cash instead', () => {
    const p = makeProduct({ retailPrice: 10_000 })
    const acme = makeSupplier('Acme')

    purchaseOnAccount(acme, p, 10, 600_000, at('2026-07-15'))
    const purchaseId = t.db.prepare('SELECT id FROM purchases ORDER BY id DESC').pluck().get() as number
    const lineId = t.db
      .prepare('SELECT id FROM purchase_lines WHERE purchase_id = ?')
      .pluck()
      .get(purchaseId) as number

    purchaseReturns.createPurchaseReturn(
      t.db,
      owner,
      {
        purchaseId,
        lines: [{ purchaseLineId: lineId, qtyM: 4 * ONE_UNIT }],
        settlement: 'refund',
        refundMethodLookupId: cash(),
        reasonCode: 'damaged'
      },
      NOW
    )

    const report = reports.supplierAging(t.db, { asOf: '2026-07-15' })
    const row = report.rows.find((r) => r.supplierId === acme)!

    expect(row.total, 'a cash refund must not reduce what the shop owes on the bill').toBe(60_000)
    expect(report.totals.total).toBe(ledger.accountBalance(t.db, ACC.PAYABLE))
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 6. LEAKAGE
// ═════════════════════════════════════════════════════════════════════════════

describe('leakage', () => {
  it('groups discounts, voids, returns and no-sales by the user who did them', () => {
    const a = makeProduct({ retailPrice: 10_000 })
    const b = makeProduct({ retailPrice: 20_000 })
    openingStock(a, 100, 600_000)
    openingStock(b, 100, 1_500_000)

    shifts.openShift(t.db, cashier, { openingFloat: 0 }, NOW)

    // Cashier rings an over-threshold discount (30% > 10%), approved by the supervisor's PIN.
    sellExact(a, 1, cash(), 10_000, {
      cartDiscount: 3_000,
      cartDiscountReasonCode: 'bulk',
      approverPin: pinOf(supervisor.username)
    })

    // A cash sale the supervisor then voids.
    const toVoid = sellExact(a, 2, cash(), 10_000)
    sales.voidSale(t.db, supervisor, { id: toVoid.id, reasonCode: 'test_sale' }, null, NOW)

    // A cash sale the supervisor then refunds.
    const toReturn = sellExact(b, 1, cash(), 20_000)
    returns.createReturn(
      t.db,
      supervisor,
      {
        saleId: toReturn.id,
        lines: [{ saleLineId: toReturn.lines[0]!.id, qtyM: ONE_UNIT }],
        settlement: 'refund',
        refundMethodLookupId: cash(),
        reasonCode: 'damaged'
      },
      NOW
    )

    // Cashier pops the drawer with no sale.
    shifts.recordCashMovement(t.db, cashier, { type: 'no_sale', amount: 0, reasonCode: 'make_change' }, NOW)

    const report = reports.leakage(t.db, { from: '2026-07-15', to: '2026-07-15' })

    const cashierRow = report.rows.find((r) => r.userId === cashier.id)!
    expect(cashierRow.name).toBe('Bilal Cashier')
    expect(cashierRow.role).toBe('cashier')
    expect(cashierRow.overThresholdDiscountCount).toBe(1)
    expect(cashierRow.overThresholdDiscountValue).toBe(3_000) // list Rs 100 − paid Rs 70
    expect(cashierRow.noSaleCount).toBe(1)
    expect(cashierRow.voidCount).toBe(0)
    expect(cashierRow.returnCount).toBe(0)

    const supervisorRow = report.rows.find((r) => r.userId === supervisor.id)!
    expect(supervisorRow.role).toBe('supervisor')
    expect(supervisorRow.voidCount).toBe(1)
    expect(supervisorRow.voidValue).toBe(20_000)
    expect(supervisorRow.returnCount).toBe(1)
    expect(supervisorRow.returnValue).toBe(20_000)

    expect(report.totals).toMatchObject({
      overThresholdDiscountCount: 1,
      overThresholdDiscountValue: 3_000,
      voidCount: 1,
      voidValue: 20_000,
      returnCount: 1,
      returnValue: 20_000,
      noSaleCount: 1
    })
  })

  it('respects the date window', () => {
    const a = makeProduct({ retailPrice: 10_000 })
    openingStock(a, 100, 600_000)
    const toVoid = sellExact(a, 1, cash(), 10_000, { when: at('2026-06-01') })
    sales.voidSale(t.db, supervisor, { id: toVoid.id, reasonCode: 'test_sale' }, null, at('2026-06-01'))

    // The void is in June — a July window must not see it.
    expect(reports.leakage(t.db, { from: '2026-07-01', to: '2026-07-31' }).rows).toEqual([])
    expect(reports.leakage(t.db, { from: '2026-06-01', to: '2026-06-30' }).totals.voidCount).toBe(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 7. TRIAL BALANCE
// ═════════════════════════════════════════════════════════════════════════════

describe('trial balance', () => {
  it('balances and stamps the date it was taken as of', () => {
    const a = makeProduct({ retailPrice: 10_000 })
    openingStock(a, 100, 600_000)
    sellExact(a, 2, cash(), 10_000)

    const report = reports.trialBalance(t.db, { asOf: '2026-07-15' })
    expect(report.asOf).toBe('2026-07-15')
    expect(report.balanced).toBe(true)
    expect(report.totalDebit).toBe(report.totalCredit)

    // Cash was debited Rs 200 by the sale; the row on its natural (debit) side shows it.
    const cashRow = report.rows.find((r) => r.code === ACC.CASH)!
    expect(cashRow.debit).toBe(20_000)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 8. PROFIT & LOSS
// ═════════════════════════════════════════════════════════════════════════════

describe('profit and loss', () => {
  it('nets revenue against its contra accounts and ties net profit to the documents', () => {
    const a = makeProduct({ retailPrice: 10_000 }) // cost Rs 60
    const b = makeProduct({ retailPrice: 20_000 }) // cost Rs 150
    openingStock(a, 100, 600_000)
    openingStock(b, 100, 1_500_000)

    sellExact(a, 2, cash(), 10_000) // Sales Rs 200, COGS Rs 120
    const bSale = sellExact(b, 1, cash(), 20_000) // Sales Rs 200, COGS Rs 150
    // Return the whole B sale (restocked): Sales Returns Rs 200, COGS credited Rs 150.
    returns.createReturn(
      t.db,
      supervisor,
      {
        saleId: bSale.id,
        lines: [{ saleLineId: bSale.lines[0]!.id, qtyM: ONE_UNIT }],
        settlement: 'refund',
        refundMethodLookupId: cash(),
        reasonCode: 'damaged'
      },
      NOW
    )

    const report = reports.profitAndLoss(t.db, { from: '2026-07-15', to: '2026-07-15' })

    // net revenue = Sales 400 − Sales Returns 200 = 200
    expect(report.netRevenue).toBe(20_000)
    // expenses = COGS: 120 + 150 sold, 150 credited back on the restock = 120
    expect(report.totalExpenses).toBe(12_000)
    expect(report.netProfit).toBe(8_000)
    expect(report.netProfit).toBe(report.netRevenue - report.totalExpenses)

    // The income section shows the contra accounts as negatives that sum to net revenue.
    expect(report.income.reduce((sum, row) => sum + row.amount, 0)).toBe(report.netRevenue)
    const salesRow = report.income.find((row) => row.code === ACC.SALES)!
    const returnsRow = report.income.find((row) => row.code === ACC.SALES_RETURNS)!
    expect(salesRow.amount).toBe(40_000)
    expect(returnsRow.amount).toBe(-20_000)

    // THE TIE TO THE DOCUMENTS: net revenue === Σ sale.subtotal_net − Σ return.subtotal_net.
    const saleNet = t.db
      .prepare(
        `SELECT COALESCE(SUM(subtotal_net), 0) FROM sales
         WHERE status = 'completed' AND at >= '2026-07-15' AND at < '2026-07-16'`
      )
      .pluck()
      .get() as number
    const returnNet = t.db
      .prepare(
        `SELECT COALESCE(SUM(subtotal_net), 0) FROM returns
         WHERE at >= '2026-07-15' AND at < '2026-07-16'`
      )
      .pluck()
      .get() as number
    expect(report.netRevenue).toBe(saleNet - returnNet)
  })

  it('counts only the journals inside the period', () => {
    const a = makeProduct({ retailPrice: 10_000 })
    openingStock(a, 100, 600_000)
    sellExact(a, 1, cash(), 10_000, { when: at('2026-06-10') }) // June
    sellExact(a, 1, cash(), 10_000, { when: at('2026-07-15') }) // July

    const june = reports.profitAndLoss(t.db, { from: '2026-06-01', to: '2026-06-30' })
    const july = reports.profitAndLoss(t.db, { from: '2026-07-01', to: '2026-07-31' })
    expect(june.netRevenue).toBe(10_000)
    expect(july.netRevenue).toBe(10_000)
  })

  /**
   * A NEW JOURNAL LEG MUST REACH THE REPORTS WITHOUT ANYONE EDITING THEM.
   *
   * Loyalty (migration 0017) added ACC.LOYALTY (2200, liability) and ACC.LOYALTY_EXPENSE (5300). Neither
   * is named anywhere in reports.ts — the P&L and the balance sheet walk `accountActivity` by account
   * TYPE, so a new account lands in them by construction. That is the whole reason the buying side's
   * `supplierAging` could drift and these cannot: aging RECOMPUTES a balance from source tables, while
   * these READ the journals. This pins that property, so a future "optimisation" into a hardcoded
   * account list fails loudly here instead of silently dropping a real cost off the shop's P&L.
   */
  it('a new account (loyalty) reaches the P&L and the balance sheet with no report change', () => {
    settings.set(t.db, 'loyalty.enabled', true, NOW)
    const customerId = makeCustomer('Regular Rashid')

    // 500 points granted by hand = a Rs 500 promise, expensed the moment it is made.
    loyalty.adjustPoints(
      t.db,
      owner,
      { customerId, points: 500, reasonCode: 'data_entry', reasonText: 'goodwill' },
      NOW
    )

    const liability = ledger.accountBalance(t.db, ACC.LOYALTY)
    expect(liability).toBe(50_000)
    // The standing loyalty invariant: what the customer holds === what the GL says the shop owes.
    expect(loyalty.pointsValue(t.db, customerId), 'points value !== GL Loyalty').toBe(liability)

    const pnl = reports.profitAndLoss(t.db, { from: '2026-01-01', to: FAR })
    expect(
      pnl.expenses.find((r) => r.code === ACC.LOYALTY_EXPENSE)?.amount,
      'loyalty expense missing from the P&L'
    ).toBe(liability)

    const bs = reports.balanceSheet(t.db, { asOf: FAR })
    expect(
      bs.liabilities.find((r) => r.code === ACC.LOYALTY)?.amount,
      'the loyalty liability is missing from the balance sheet'
    ).toBe(liability)

    holds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 9. BALANCE SHEET
// ═════════════════════════════════════════════════════════════════════════════

describe('balance sheet', () => {
  it('balances, and its lines equal the general-ledger account balances', () => {
    const a = makeProduct({ retailPrice: 10_000 })
    openingStock(a, 100, 600_000)
    const cust = makeCustomer('Ali')
    sellExact(a, 2, cash(), 10_000) // cash in, stock out, margin earned
    sellExact(a, 1, credit(), 10_000, { customerId: cust }) // a receivable

    const report = reports.balanceSheet(t.db, { asOf: '2026-07-15' })

    expect(report.balanced).toBe(true)
    expect(report.totalAssets).toBe(report.totalLiabilities + report.totalEquity)

    const line = (lines: typeof report.assets, code: string): number =>
      lines.find((l) => l.code === code)?.amount ?? 0

    expect(line(report.assets, ACC.CASH)).toBe(ledger.accountBalance(t.db, ACC.CASH))
    expect(line(report.assets, ACC.INVENTORY)).toBe(ledger.accountBalance(t.db, ACC.INVENTORY))
    expect(line(report.assets, ACC.RECEIVABLE)).toBe(ledger.accountBalance(t.db, ACC.RECEIVABLE))

    // The net profit folded into equity matches the P&L over the whole book to date.
    const pnl = reports.profitAndLoss(t.db, { from: '2026-01-01', to: '2026-07-15' })
    expect(report.netProfit).toBe(pnl.netProfit)
  })
})
