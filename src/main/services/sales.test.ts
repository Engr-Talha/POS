import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { hashSecret } from '../security/password'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import { openDatabase, closeDatabase } from '../db'
import * as sales from './sales'
import * as stock from './stock'
import * as ledger from './ledger'
import * as catalog from './catalog'
import * as settings from './settings'
import { ACC } from '../db/chart-of-accounts'
import { computeLineTax } from '@shared/tax'
import { ONE_UNIT } from '@shared/qty'
import type { User } from '@shared/types'
import type { SaleLineInput } from '@shared/sales'

/**
 * THE SALE ENGINE — the code the whole business runs through.
 *
 * FIVE STANDING ASSERTIONS RUN AFTER EVERY SINGLE SCENARIO IN THIS FILE. They are the point of it. Any
 * one of them failing means the shop's books, its shelves or its receipts are lying:
 *
 *   1. THE TRIAL BALANCE BALANCES.                            (CLAUDE.md §4 — the standing test)
 *   2. GL INVENTORY === THE STOCK VALUATION.                  the books and the shelf agree
 *   3. THE CACHED AVERAGE COST === the one rebuilt from the movements alone
 *   4. EVERY SALE ADDS UP: grand === SUM(gross) === subtotal + tax, and gross === net + tax per line
 *   5. EVERY RECEIPT ADDS UP: subtotal − discount + tax === total, on the paper the customer holds
 *
 * They are asserted for EVERY sale in the database, not just the one the test was thinking about — a
 * write path that corrupts a different sale's totals is exactly the kind of bug that hides for a year.
 */

// ═════════════════════════════════════════════════════════════════════════════
// The standing assertions
// ═════════════════════════════════════════════════════════════════════════════

/** CLAUDE.md §4: after every scenario, the trial balance balances. */
function assertBooksBalance(t: TestDb): void {
  const tb = ledger.trialBalance(t.db)
  expect(tb.balanced, 'THE TRIAL BALANCE DOES NOT BALANCE').toBe(true)
  expect(tb.grossDebit).toBe(tb.grossCredit)
}

/**
 * THE BOOKS AND THE SHELF AGREE.
 *
 * GL Inventory is what the journal says the stock is worth. The stock valuation is the sum of what each
 * movement actually moved (its frozen value_minor). They are equal BY CONSTRUCTION — the sale posts the
 * very number the movement froze — and this is the assertion that keeps it that way.
 */
function assertInventoryMatchesStockValue(t: TestDb): void {
  const gl = ledger.accountBalance(t.db, ACC.INVENTORY)
  const valuation = t.db
    .prepare('SELECT COALESCE(SUM(value_minor), 0) FROM stock_movements')
    .pluck()
    .get() as number

  expect(gl, 'GL Inventory has drifted away from the stock valuation').toBe(valuation)
}

/** The cached weighted average still equals the one rebuilt from the movements alone. */
function assertAverageCostIsHonest(t: TestDb): void {
  const ids = t.db.prepare('SELECT id FROM products').pluck().all() as number[]

  for (const id of ids) {
    const stored = t.db.prepare('SELECT cost_price FROM products WHERE id = ?').pluck().get(id)
    expect(stored, `product ${id}: the stored average has drifted from its movements`).toBe(
      stock.recomputeAverageCost(t.db, id)
    )
  }
}

/** Every sale in the book adds up, and every line inside it adds up. */
function assertEverySaleAddsUp(t: TestDb): void {
  const ids = t.db.prepare('SELECT id FROM sales').pluck().all() as number[]

  for (const id of ids) {
    const sale = sales.getById(t.db, id)

    let net = 0
    let tax = 0
    let gross = 0

    for (const line of sale.lines) {
      expect(line.gross, `sale ${id} line ${line.id}: gross !== net + tax`).toBe(
        line.net + line.taxAmount
      )
      net += line.net
      tax += line.taxAmount
      gross += line.gross
    }

    expect(sale.subtotalNet, `sale ${id}: subtotal_net !== SUM(line.net)`).toBe(net)
    expect(sale.taxTotal, `sale ${id}: tax_total !== SUM(line.tax_amount)`).toBe(tax)
    expect(sale.grandTotal, `sale ${id}: grand_total !== SUM(line.gross)`).toBe(gross)
    expect(sale.grandTotal, `sale ${id}: grand_total !== subtotal + tax`).toBe(
      sale.subtotalNet + sale.taxTotal
    )

    if (sale.status === 'completed' || sale.status === 'voided') {
      const paid = sale.payments.reduce((total, payment) => total + payment.amount, 0)
      expect(sale.paidTotal, `sale ${id}: paid_total !== SUM(payments)`).toBe(paid)
      expect(sale.changeDue, `sale ${id}: change_due !== paid − grand`).toBe(
        Math.max(0, paid - sale.grandTotal)
      )
    }
  }
}

/**
 * THE PAPER ADDS UP. The shipped receipt prints Subtotal / Discount / Tax / TOTAL as a column that a
 * customer can add up in their head — so it had better come to the total they are being asked to pay.
 */
function assertEveryReceiptAddsUp(t: TestDb, actor: User): void {
  const ids = t.db.prepare("SELECT id FROM sales WHERE status = 'completed'").pluck().all() as number[]

  for (const id of ids) {
    const receipt = sales.receiptFor(t.db, actor, { id, isDuplicate: false })

    expect(
      receipt.subtotalNet - receipt.cartDiscount + receipt.taxTotal,
      `sale ${id}: the receipt does not add up`
    ).toBe(receipt.grandTotal)
  }
}

function everythingHolds(t: TestDb, actor: User): void {
  assertBooksBalance(t)
  assertInventoryMatchesStockValue(t)
  assertAverageCostIsHonest(t)
  assertEverySaleAddsUp(t)
  assertEveryReceiptAddsUp(t, actor)
}


// ═════════════════════════════════════════════════════════════════════════════
// Fixtures
// ═════════════════════════════════════════════════════════════════════════════

const RS_100 = 10_000 // 2-dp money
const RS_60_COST = 600_000 // 4-dp cost
const GST = 1700 // 17%, in basis points

let t: TestDb
let cashier: User
let supervisor: User
let owner: User

/**
 * A supervisor approves an over-threshold action by PIN — main derives WHO from the PIN, never from
 * a claimed id. So every fixture user gets a real PIN, and the tests approve by passing it, exactly
 * as the till does. pinOf() is the deterministic PIN for a username.
 */
function pinOf(username: string): string {
  let hash = 0
  for (const ch of username) hash = (hash * 31 + ch.charCodeAt(0)) % 900000
  return String(100000 + hash) // a stable 6-digit PIN
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

type MakeProduct = {
  name?: string
  retailPrice?: number
  wholesalePrice?: number
  taxRateBp?: number
  priceEntryMode?: 'inclusive' | 'exclusive'
  isTaxExempt?: boolean
  itemType?: 'inventory' | 'non_inventory'
  isWeighted?: boolean
  trackBatches?: boolean
  trackSerials?: boolean
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
         VALUES (@sku, @name, @uomId, 0, @retailPrice, @wholesalePrice, @taxRateBp,
                 @priceEntryMode, @isTaxExempt, @itemType, @isWeighted, @trackBatches, @trackSerials,
                 1, @now, @now)`
      )
      .run({
        sku: `SKU-${Math.random().toString(36).slice(2, 10)}`,
        name: options.name ?? 'Test Item',
        uomId: lookupId('uom', options.uom ?? 'pcs'),
        retailPrice: options.retailPrice ?? RS_100,
        wholesalePrice: options.wholesalePrice ?? 0,
        taxRateBp: options.taxRateBp ?? GST,
        priceEntryMode: options.priceEntryMode ?? 'exclusive',
        isTaxExempt: options.isTaxExempt ? 1 : 0,
        itemType: options.itemType ?? 'inventory',
        isWeighted: options.isWeighted ? 1 : 0,
        trackBatches: options.trackBatches ? 1 : 0,
        trackSerials: options.trackSerials ? 1 : 0,
        now
      }).lastInsertRowid
  )
}

/** Opening stock, through the REAL service — so the books balance from the first line of every test. */
function openingStock(productId: number, qtyM: number, unitCost = RS_60_COST): void {
  stock.adjust(t.db, owner, {
    productId,
    type: 'opening',
    qtyM,
    unitCost,
    reasonCode: 'data_entry'
  })
}

function makeCustomer(name: string, creditLimit = 0): number {
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
  return t.db
    .prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id')
    .all(action) as Array<Record<string, unknown>>
}

beforeEach(() => {
  t = makeTestDb({ withSeed: true })
  owner = makeUser('owner', 'owner', 'Insha Owner')
  supervisor = makeUser('supervisor', 'super', 'Rashid Supervisor')
  cashier = makeUser('cashier', 'cash1', 'Bilal Cashier')
})

/**
 * THE STANDING ASSERTIONS RUN AFTER EVERY SCENARIO — WHETHER OR NOT ITS AUTHOR REMEMBERED TO ASK.
 *
 * They used to be called by hand at the end of each test, which made "the trial balance balances after
 * EVERY scenario" (CLAUDE.md §4) a HABIT rather than a guarantee: nine scenarios in this file did not
 * call `everythingHolds`, and nothing anywhere said so. The next person to add a sale would have had to
 * know to. Running them here means a scenario cannot opt out of the invariants by omission.
 *
 * They run BEFORE `t.cleanup()`, in this one hook, on purpose — a second `afterEach` would be ordered
 * against this one by vitest's hook stack, and could find the database already closed.
 *
 * The explicit `everythingHolds(...)` calls inside the tests stay: they cost nothing, and they fail at
 * the assertion itself rather than at teardown, which is where you want to be standing when one breaks.
 */
afterEach(() => {
  everythingHolds(t, owner)
  t.cleanup()
})

// ═════════════════════════════════════════════════════════════════════════════
// A PLAIN CASH SALE — everything else is a variation on this
// ═════════════════════════════════════════════════════════════════════════════

describe('a plain cash sale', () => {
  it('freezes net/tax/gross, drops the stock, posts a balanced journal, and prints a receipt that adds up', () => {
    const productId = makeProduct({ name: 'Rice 1kg', retailPrice: RS_100, taxRateBp: GST })
    openingStock(productId, 10 * ONE_UNIT) // 10 pcs @ Rs 60 cost

    const { sale, receipt, journalId } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: 2 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 23_400 }]
    })

    // ── The line is FROZEN: Rs 100 x 2 = Rs 200 net, + 17% = Rs 34 tax, = Rs 234 gross ──
    const line = sale.lines[0]!
    expect(line.unitPrice).toBe(RS_100)
    expect(line.qtyM).toBe(2 * ONE_UNIT)
    expect(line.net).toBe(20_000)
    expect(line.taxRateBp).toBe(GST)
    expect(line.taxAmount).toBe(3_400)
    expect(line.gross).toBe(23_400)
    expect(line.taxMode).toBe('exclusive')
    expect(line.nameSnapshot).toBe('Rice 1kg')
    // The COGS, frozen at the weighted average — 4-dp cost scale, NOT money.
    expect(line.unitCost).toBe(RS_60_COST)

    expect(sale.subtotalNet).toBe(20_000)
    expect(sale.taxTotal).toBe(3_400)
    expect(sale.grandTotal).toBe(23_400)
    expect(sale.paidTotal).toBe(23_400)
    expect(sale.changeDue).toBe(0)
    expect(sale.status).toBe('completed')
    expect(sale.hadNegativeStock).toBe(false)

    // ── The stock dropped, and it dropped by being SUMMED, not by being set ──
    expect(onHand(productId)).toBe(8 * ONE_UNIT)

    const movements = t.db
      .prepare("SELECT * FROM stock_movements WHERE ref_type = 'sale' AND ref_id = ?")
      .all(String(sale.id)) as Array<{ qty_m: number; unit_cost: number; value_minor: number }>

    expect(movements).toHaveLength(1)
    expect(movements[0]!.qty_m).toBe(-2 * ONE_UNIT) // NEGATIVE — it left the shop
    expect(movements[0]!.unit_cost).toBe(RS_60_COST)
    expect(movements[0]!.value_minor).toBe(-12_000) // Rs 120 of stock, frozen at the moment it moved

    // ── The journal ──
    const journal = t.db
      .prepare(
        `SELECT a.code AS code, l.debit AS debit, l.credit AS credit
         FROM journal_lines l JOIN accounts a ON a.id = l.account_id
         WHERE l.journal_id = ? ORDER BY a.code`
      )
      .all(journalId) as Array<{ code: string; debit: number; credit: number }>

    expect(journal).toEqual([
      { code: ACC.CASH, debit: 23_400, credit: 0 }, // what the drawer took
      { code: ACC.INVENTORY, debit: 0, credit: 12_000 }, // stock off the shelf
      { code: ACC.OUTPUT_TAX, debit: 0, credit: 3_400 }, // the government's money
      { code: ACC.SALES, debit: 0, credit: 20_000 }, // the revenue
      { code: ACC.COGS, debit: 12_000, credit: 0 } // what it cost us
    ])

    // ── The receipt ──
    expect(receipt.invoiceNo).toBe(sale.invoiceNo)
    expect(receipt.isDuplicate).toBe(false)
    expect(receipt.cashierName).toBe('Bilal Cashier')
    expect(receipt.subtotalNet - receipt.cartDiscount + receipt.taxTotal).toBe(receipt.grandTotal)
    expect(receipt.grandTotal).toBe(23_400)
    expect(receipt.taxSummary).toEqual([{ taxRateBp: GST, net: 20_000, tax: 3_400 }])
    expect(receipt.payments).toEqual([{ method: 'Cash', amount: 23_400, reference: null }])

    everythingHolds(t, owner)
  })

  it('refuses a payment that is short, and says so in plain language', () => {
    const productId = makeProduct()
    openingStock(productId, 10 * ONE_UNIT)

    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          lines: [{ productId, qtyM: ONE_UNIT }],
          payments: [{ methodLookupId: cash(), amount: 10_000 }] // Rs 100 against Rs 117
        }),
      /short by Rs 17\.00.*Credit \(Udhaar\)/s
    )

    // Nothing happened: no sale, no stock movement, no number drawn.
    expect(t.db.prepare('SELECT COUNT(*) FROM sales').pluck().get()).toBe(0)
    expect(onHand(productId)).toBe(10 * ONE_UNIT)
    expect(t.db.prepare('SELECT COUNT(*) FROM invoice_counters').pluck().get()).toBe(0)

    everythingHolds(t, owner)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// TAX — a cart may MIX inclusive and exclusive pricing
// ═════════════════════════════════════════════════════════════════════════════

describe('a cart mixing inclusive and exclusive prices', () => {
  it('taxes each line in ITS OWN mode, and the totals still reconcile', () => {
    // The bakery item's shelf price INCLUDES the tax. The phone's price has it added at the till.
    const inclusive = makeProduct({
      name: 'Bun (shelf price)',
      retailPrice: 11_700, // Rs 117 — tax is already inside it
      taxRateBp: GST,
      priceEntryMode: 'inclusive'
    })
    const exclusive = makeProduct({
      name: 'Charger',
      retailPrice: 10_000, // Rs 100 + tax at the till
      taxRateBp: GST,
      priceEntryMode: 'exclusive'
    })

    openingStock(inclusive, 10 * ONE_UNIT)
    openingStock(exclusive, 10 * ONE_UNIT)

    const { sale } = sales.complete(t.db, cashier, {
      lines: [
        { productId: inclusive, qtyM: ONE_UNIT },
        { productId: exclusive, qtyM: ONE_UNIT }
      ],
      payments: [{ methodLookupId: cash(), amount: 23_400 }]
    })

    const [bun, charger] = sale.lines as [(typeof sale.lines)[0], (typeof sale.lines)[0]]

    // The inclusive line: the tax is taken BACK OUT of the shelf price.
    expect(bun.taxMode).toBe('inclusive')
    expect(bun.unitPrice).toBe(11_700)
    expect(bun.net).toBe(10_000)
    expect(bun.taxAmount).toBe(1_700)
    expect(bun.gross).toBe(11_700) // the customer pays the shelf price, exactly

    // The exclusive line: the tax goes ON TOP.
    expect(charger.taxMode).toBe('exclusive')
    expect(charger.unitPrice).toBe(10_000)
    expect(charger.net).toBe(10_000)
    expect(charger.taxAmount).toBe(1_700)
    expect(charger.gross).toBe(11_700)

    expect(sale.subtotalNet).toBe(20_000)
    expect(sale.taxTotal).toBe(3_400)
    expect(sale.grandTotal).toBe(23_400)

    everythingHolds(t, owner)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// PAYMENTS
// ═════════════════════════════════════════════════════════════════════════════

describe('payments', () => {
  it('takes a SPLIT payment (cash + card) and gives change out of the cash', () => {
    const productId = makeProduct()
    openingStock(productId, 10 * ONE_UNIT)

    const { sale, journalId } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: 2 * ONE_UNIT }], // Rs 234.00
      payments: [
        { methodLookupId: card(), amount: 5_000 }, // Rs 50 on the card
        { methodLookupId: cash(), amount: 20_000 } // and a Rs 200 note
      ]
    })

    expect(sale.grandTotal).toBe(23_400)
    expect(sale.paidTotal).toBe(25_000) // what they HANDED OVER
    expect(sale.changeDue).toBe(1_600) // Rs 16 back
    expect(sale.payments).toHaveLength(2) // a split payment is SEVERAL ROWS

    // THE DRAWER KEEPS Rs 184, not the Rs 200 note. The change is not the shop's money.
    const debits = t.db
      .prepare(
        `SELECT a.code AS code, l.debit AS debit
         FROM journal_lines l JOIN accounts a ON a.id = l.account_id
         WHERE l.journal_id = ? AND l.debit > 0 ORDER BY a.code`
      )
      .all(journalId) as Array<{ code: string; debit: number }>

    expect(debits).toEqual([
      { code: ACC.CASH, debit: 18_400 }, // 20,000 tendered − 1,600 change
      { code: ACC.BANK, debit: 5_000 }, // the card
      { code: ACC.COGS, debit: 12_000 }
    ])

    everythingHolds(t, owner)
  })

  it('refuses to give change when no cash was taken', () => {
    const productId = makeProduct()
    openingStock(productId, 10 * ONE_UNIT)

    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          lines: [{ productId, qtyM: ONE_UNIT }], // Rs 117
          payments: [{ methodLookupId: card(), amount: 20_000 }] // overpaid BY CARD
        }),
      /Change can only be given out of a cash payment/
    )

    everythingHolds(t, owner)
  })

  it('a CREDIT (udhaar) sale debits Accounts Receivable, not Cash', () => {
    const productId = makeProduct()
    openingStock(productId, 10 * ONE_UNIT)
    const customerId = makeCustomer('Muhammad Rashid', 100_000) // Rs 1,000 limit

    const { sale, journalId } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: 2 * ONE_UNIT }],
      customerId,
      payments: [{ methodLookupId: credit(), amount: 23_400 }]
    })

    expect(sale.paidTotal).toBe(23_400) // they "paid" — with a promise
    expect(sale.changeDue).toBe(0)

    const debits = t.db
      .prepare(
        `SELECT a.code AS code, l.debit AS debit
         FROM journal_lines l JOIN accounts a ON a.id = l.account_id
         WHERE l.journal_id = ? AND l.debit > 0 ORDER BY a.code`
      )
      .all(journalId) as Array<{ code: string; debit: number }>

    expect(debits).toEqual([
      { code: ACC.RECEIVABLE, debit: 23_400 }, // THE CUSTOMER OWES IT
      { code: ACC.COGS, debit: 12_000 }
    ])

    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(0) // not a rupee in the drawer
    expect(sales.outstandingCredit(t.db, customerId)).toBe(23_400)

    everythingHolds(t, owner)
  })

  it('refuses a credit sale with nobody to collect from', () => {
    const productId = makeProduct()
    openingStock(productId, 10 * ONE_UNIT)

    // selling.requireCustomerForCredit is on by default: "money owed with nobody attached to it is
    // money you will not collect."
    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          lines: [{ productId, qtyM: ONE_UNIT }],
          payments: [{ methodLookupId: credit(), amount: 11_700 }]
        }),
      /must be against a customer/
    )

    everythingHolds(t, owner)
  })

  it('blocks a credit sale that would take the customer over their limit when the setting says block', () => {
    settings.set(t.db, 'selling.creditLimit', 'block')

    const productId = makeProduct()
    openingStock(productId, 10 * ONE_UNIT)
    const customerId = makeCustomer('Over Limit', 10_000) // Rs 100 limit

    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          lines: [{ productId, qtyM: 2 * ONE_UNIT }], // Rs 234 of udhaar
          customerId,
          payments: [{ methodLookupId: credit(), amount: 23_400 }]
        }),
      /over their credit limit of Rs 100\.00/
    )

    everythingHolds(t, owner)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE CART DISCOUNT — apportioned, so the tax follows the money
// ═════════════════════════════════════════════════════════════════════════════

describe('the cart discount', () => {
  it('takes EXACTLY the discount off what the customer pays — and the tax comes down with it', () => {
    const a = makeProduct({ name: 'A', retailPrice: 10_000, taxRateBp: GST })
    const b = makeProduct({ name: 'B', retailPrice: 30_000, taxRateBp: GST })
    openingStock(a, 100 * ONE_UNIT)
    openingStock(b, 100 * ONE_UNIT)

    const lines: SaleLineInput[] = [
      { productId: a, qtyM: 3 * ONE_UNIT, lineDiscount: 0 }, // Rs 300 net -> Rs 351 gross
      { productId: b, qtyM: ONE_UNIT, lineDiscount: 0 } // Rs 300 net -> Rs 351 gross
    ]

    // Ring the SAME cart up twice: once plain, once with Rs 100 off.
    const plain = sales.complete(t.db, cashier, {
      lines,
      payments: [{ methodLookupId: cash(), amount: 70_200 }]
    })

    const discounted = sales.complete(t.db, cashier, {
      lines,
      cartDiscount: 10_000, // Rs 100 off the whole cart
      cartDiscountReasonCode: 'regular_customer',
      approverPin: pinOf(supervisor.username),
      payments: [{ methodLookupId: cash(), amount: 60_200 }]
    })

    // THE CUSTOMER PAYS EXACTLY Rs 100 LESS. To the paisa. No rounding line, ever.
    expect(plain.sale.grandTotal - discounted.sale.grandTotal).toBe(10_000)
    expect(discounted.sale.grandTotal).toBe(60_200)
    expect(discounted.sale.cartDiscount).toBe(10_000)

    // AND THE TAX CAME DOWN WITH IT — the shop does not remit output tax on money it never received.
    //
    // Rs 1,452, not the Rs 1,453 you get from taking 17/117 of the Rs 100 in one go. That difference is
    // the whole discipline in one number: tax is resolved ONCE PER LINE and FROZEN, so the tax that came
    // off is the sum of what came off each line (726 + 726) — not a figure computed on the total and
    // then forced to agree with lines that were rounded separately. Round on the total and the receipt
    // stops adding up by a paisa.
    expect(discounted.sale.taxTotal).toBeLessThan(plain.sale.taxTotal)
    expect(plain.sale.taxTotal - discounted.sale.taxTotal).toBe(1_452)

    // The lines still add up individually, and to the document.
    expect(discounted.sale.grandTotal).toBe(
      discounted.sale.lines.reduce((total, line) => total + line.gross, 0)
    )
    expect(discounted.sale.grandTotal).toBe(
      discounted.sale.subtotalNet + discounted.sale.taxTotal
    )

    // The discount was split in proportion to what each line is worth — here, straight down the middle.
    const [lineA, lineB] = discounted.sale.lines as [
      (typeof discounted.sale.lines)[0],
      (typeof discounted.sale.lines)[0]
    ]
    expect(lineA.gross).toBe(35_100 - 5_000)
    expect(lineB.gross).toBe(35_100 - 5_000)

    everythingHolds(t, owner)
  })

  it('posts the discount to Discounts Given at its EX-TAX value, and the journal still balances', () => {
    const productId = makeProduct({ retailPrice: 10_000, taxRateBp: GST })
    openingStock(productId, 100 * ONE_UNIT)

    const { sale, journalId } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: 10 * ONE_UNIT }], // Rs 1000 net, Rs 1170 gross
      cartDiscount: 11_700, // Rs 117 off — exactly one unit's worth
      cartDiscountReasonCode: 'bulk',
      approverPin: pinOf(supervisor.username),
      payments: [{ methodLookupId: cash(), amount: 105_300 }]
    })

    expect(sale.grandTotal).toBe(105_300) // 117000 − 11700

    const journal = t.db
      .prepare(
        `SELECT a.code AS code, l.debit AS debit, l.credit AS credit
         FROM journal_lines l JOIN accounts a ON a.id = l.account_id
         WHERE l.journal_id = ? ORDER BY a.code`
      )
      .all(journalId) as Array<{ code: string; debit: number; credit: number }>

    // Sales is credited with the UNDISCOUNTED net, and the discount stands beside it as contra-income,
    // so the owner can SEE what discounting cost — Rs 100 of revenue, not Rs 117.
    expect(journal).toEqual([
      { code: ACC.CASH, debit: 105_300, credit: 0 },
      { code: ACC.INVENTORY, debit: 0, credit: 60_000 },
      { code: ACC.OUTPUT_TAX, debit: 0, credit: 15_300 }, // 17% of the Rs 900 actually charged
      { code: ACC.SALES, debit: 0, credit: 100_000 }, // the full Rs 1,000
      { code: ACC.DISCOUNTS, debit: 10_000, credit: 0 }, // Rs 100 of revenue given away
      { code: ACC.COGS, debit: 60_000, credit: 0 }
    ])

    // 105300 + 10000 === 100000 + 15300. It balances as algebra, not by luck.
    expect(105_300 + 10_000).toBe(100_000 + 15_300)

    everythingHolds(t, owner)
  })

  it('splits the discount EXACTLY — never a paisa lost or invented, on a thousand random carts', () => {
    // The one place a rupee could quietly go missing on every discounted sale in the shop's history.
    let seed = 20260715

    const random = (max: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % max
    }

    for (let run = 0; run < 1000; run++) {
      const weights = Array.from({ length: 1 + random(6) }, () => 1 + random(500_000))
      const total = weights.reduce((sum, weight) => sum + weight, 0)
      const discount = random(total + 1)

      const shares = sales.apportionCartDiscount(discount, weights)

      expect(shares.reduce((sum, share) => sum + share, 0)).toBe(discount)
      shares.forEach((share, index) => {
        expect(share).toBeGreaterThanOrEqual(0)
        expect(share).toBeLessThanOrEqual(weights[index]!) // never more off a line than the line is worth
      })
    }
  })

  it('refuses a discount bigger than the sale', () => {
    const productId = makeProduct()
    openingStock(productId, 10 * ONE_UNIT)

    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          lines: [{ productId, qtyM: ONE_UNIT }],
          cartDiscount: 999_999,
          approverPin: pinOf(supervisor.username),
          cartDiscountReasonCode: 'bulk',
          payments: [{ methodLookupId: cash(), amount: 100 }]
        }),
      /more than the sale itself/
    )

    everythingHolds(t, owner)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// DISCOUNT APPROVAL
// ═════════════════════════════════════════════════════════════════════════════

describe('a discount above the threshold', () => {
  it('is REFUSED without a supervisor — in plain language', () => {
    const productId = makeProduct({ retailPrice: 10_000, taxRateBp: GST })
    openingStock(productId, 10 * ONE_UNIT)

    // Default threshold: 10% or Rs 500, whichever comes first. Rs 50 off Rs 117 is 42%.
    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          lines: [{ productId, qtyM: ONE_UNIT }],
          cartDiscount: 5_000,
          payments: [{ methodLookupId: cash(), amount: 6_700 }]
        }),
      /more than a cashier may give on their own.*ask a supervisor/s
    )

    expect(t.db.prepare('SELECT COUNT(*) FROM sales').pluck().get()).toBe(0)
    everythingHolds(t, owner)
  })

  it('is ALLOWED with a supervisor and a reason — and the approver’s NAME is in the audit log', () => {
    const productId = makeProduct({ retailPrice: 10_000, taxRateBp: GST })
    openingStock(productId, 10 * ONE_UNIT)

    const { sale } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: ONE_UNIT }],
      cartDiscount: 5_000,
      cartDiscountReasonCode: 'regular_customer',
      approverPin: pinOf(supervisor.username),
      payments: [{ methodLookupId: cash(), amount: 6_700 }]
    })

    expect(sale.grandTotal).toBe(6_700)

    const rows = auditRows('sale.discount.over_threshold')
    expect(rows).toHaveLength(1)

    const row = rows[0]!
    expect(row['user_name']).toBe('Bilal Cashier') // WHO rang it up
    expect(row['user_role']).toBe('cashier')
    expect(row['approved_by_name']).toBe('Rashid Supervisor') // WHO let them
    expect(row['reason_code']).toBe('regular_customer') // WHY
    expect(row['entity_id']).toBe(String(sale.id))

    everythingHolds(t, owner)
  })

  it('lets a supervisor-or-above authorise their OWN over-threshold discount — no PIN, no trap', () => {
    const productId = makeProduct({ retailPrice: 10_000, taxRateBp: GST })
    openingStock(productId, 10 * ONE_UNIT)

    // The owner OUTRANKS a supervisor, so they authorise the big discount themselves — there is no one
    // to ask, and in a one-user shop there is no supervisor PIN in existence to type. It must go
    // straight through, exactly as an owner voids or returns on their own authority. REGRESSION: the
    // approval check looked ONLY at the PIN approver and ignored the actor's own role, so the owner was
    // trapped behind a "Supervisor PIN" prompt they could never satisfy, and the sale could not complete.
    const { sale } = sales.complete(t.db, owner, {
      lines: [{ productId, qtyM: ONE_UNIT }],
      cartDiscount: 5_000,
      cartDiscountReasonCode: 'regular_customer',
      payments: [{ methodLookupId: cash(), amount: 6_700 }]
      // NOTE: no approverPin — the person at the till already holds the authority.
    })
    expect(sale.grandTotal).toBe(6_700)

    // The big discount is STILL audited — WHO authorised it (the owner, on their own authority) is
    // exactly what the leakage report is for, so a self-approved discount must never go unrecorded.
    const rows = auditRows('sale.discount.over_threshold')
    expect(rows).toHaveLength(1)
    expect(rows[0]!['user_name']).toBe('Insha Owner')
    expect(rows[0]!['approved_by_name']).toBe('Insha Owner') // authorised themselves
    expect(rows[0]!['reason_code']).toBe('regular_customer')
    everythingHolds(t, owner)
  })

  it('still refuses when the "supervisor" is only a cashier', () => {
    const productId = makeProduct({ retailPrice: 10_000 })
    openingStock(productId, 10 * ONE_UNIT)
    const other = makeUser('cashier', 'cash2', 'Another Cashier')

    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          lines: [{ productId, qtyM: ONE_UNIT }],
          cartDiscount: 5_000,
          cartDiscountReasonCode: 'bulk',
          approverPin: pinOf(other.username), // a cashier cannot approve a cashier
          payments: [{ methodLookupId: cash(), amount: 6_700 }]
        }),
      /ask a supervisor/
    )

    everythingHolds(t, owner)
  })

  it('demands a reason code from the owner’s own list, not one the renderer made up', () => {
    const productId = makeProduct({ retailPrice: 10_000 })
    openingStock(productId, 10 * ONE_UNIT)

    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          lines: [{ productId, qtyM: ONE_UNIT }],
          cartDiscount: 5_000,
          cartDiscountReasonCode: 'because_i_felt_like_it',
          approverPin: pinOf(supervisor.username),
          payments: [{ methodLookupId: cash(), amount: 6_700 }]
        }),
      /choose a reason for this discount from the list/
    )

    everythingHolds(t, owner)
  })

  it('lets a small discount through without troubling anybody', () => {
    const productId = makeProduct({ retailPrice: 100_000, taxRateBp: 0 }) // Rs 1,000
    openingStock(productId, 10 * ONE_UNIT)

    // Rs 50 off Rs 1,000 is 5% — under the 10% limit and under the Rs 500 one.
    const { sale } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: ONE_UNIT }],
      cartDiscount: 5_000,
      payments: [{ methodLookupId: cash(), amount: 95_000 }]
    })

    expect(sale.grandTotal).toBe(95_000)
    expect(auditRows('sale.discount.over_threshold')).toHaveLength(0)

    everythingHolds(t, owner)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// NEGATIVE STOCK
// ═════════════════════════════════════════════════════════════════════════════

describe('selling stock the shop does not have', () => {
  it('on WARN: completes, sets had_negative_stock, and writes an audit row with the name and role', () => {
    const productId = makeProduct({ name: 'Cooking Oil' })
    openingStock(productId, 2 * ONE_UNIT) // only 2 on the books

    const { sale } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: 5 * ONE_UNIT }], // sell 5
      acceptNegativeStock: true, // the cashier saw the warning and went ahead
      payments: [{ methodLookupId: cash(), amount: 58_500 }]
    })

    expect(sale.status).toBe('completed')
    expect(sale.hadNegativeStock).toBe(true) // THE FLAG
    expect(onHand(productId)).toBe(-3 * ONE_UNIT) // oversold, and the books say so

    const rows = auditRows('sale.negative_stock')
    expect(rows).toHaveLength(1)
    expect(rows[0]!['user_name']).toBe('Bilal Cashier')
    expect(rows[0]!['user_role']).toBe('cashier')

    const after = JSON.parse(rows[0]!['after_json'] as string) as {
      shortages: Array<{ name: string; onHandM: number; soldM: number }>
    }
    expect(after.shortages[0]!.name).toBe('Cooking Oil')
    expect(after.shortages[0]!.onHandM).toBe(2 * ONE_UNIT)
    expect(after.shortages[0]!.soldM).toBe(5 * ONE_UNIT)

    // The leakage filter finds it — that is what the flag is FOR.
    expect(sales.list(t.db, { hadNegativeStock: true }).rows.map((r) => r.id)).toEqual([sale.id])

    everythingHolds(t, owner)
  })

  it('on WARN: warns first, and the warning is enforced in MAIN', () => {
    const productId = makeProduct({ name: 'Cooking Oil' })
    openingStock(productId, 2 * ONE_UNIT)

    // A renderer that simply does not show the warning must not be able to skip it.
    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          lines: [{ productId, qtyM: 5 * ONE_UNIT }],
          payments: [{ methodLookupId: cash(), amount: 58_500 }]
        }),
      /not enough stock: Cooking Oil \(2 in stock, selling 5\).*Confirm to continue/s
    )

    expect(t.db.prepare('SELECT COUNT(*) FROM sales').pluck().get()).toBe(0)
    everythingHolds(t, owner)
  })

  it('on BLOCK: refuses', () => {
    settings.set(t.db, 'selling.negativeStock', 'block')

    const productId = makeProduct({ name: 'Cooking Oil' })
    openingStock(productId, 2 * ONE_UNIT)

    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          lines: [{ productId, qtyM: 5 * ONE_UNIT }],
          acceptNegativeStock: true, // even so
          payments: [{ methodLookupId: cash(), amount: 58_500 }]
        }),
      /not enough stock.*take the delivery in first/s
    )

    expect(t.db.prepare('SELECT COUNT(*) FROM sales').pluck().get()).toBe(0)
    expect(onHand(productId)).toBe(2 * ONE_UNIT)

    everythingHolds(t, owner)
  })

  it('adds the WHOLE CART up per product — two lines of 3 against 5 on the shelf is a shortage', () => {
    const productId = makeProduct({ name: 'Soap' })
    openingStock(productId, 5 * ONE_UNIT)

    // Neither line is short on its own. Together they are. Asking per line would wave this through.
    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          lines: [
            { productId, qtyM: 3 * ONE_UNIT, lineDiscount: 1 },
            { productId, qtyM: 3 * ONE_UNIT, lineDiscount: 2 }
          ],
          payments: [{ methodLookupId: cash(), amount: 999_999 }]
        }),
      /not enough stock: Soap \(5 in stock, selling 6\)/
    )

    everythingHolds(t, owner)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// PACKS — buy in cartons, sell in pieces
// ═════════════════════════════════════════════════════════════════════════════

describe('a pack (carton) barcode', () => {
  it('sells ONE carton at the carton price, and moves 24 PIECES of stock', () => {
    const productId = makeProduct({ name: 'Biscuits', retailPrice: 10_000, taxRateBp: 0 })
    openingStock(productId, 48 * ONE_UNIT) // 48 pieces = two cartons

    catalog.savePack(t.db, {
      productId,
      uomId: lookupId('uom', 'carton'),
      packSize: 24 * ONE_UNIT, // a carton holds 24 PIECES
      retailPrice: 230_000, // Rs 2,300 — priced in its own right, NOT 24 x the piece price
      barcode: 'CARTON-24'
    })

    // ── The scan ──
    const scanned = sales.scanBarcode(t.db, 'CARTON-24')!
    expect(scanned.productId).toBe(productId)
    expect(scanned.packId).not.toBeNull()
    expect(scanned.qtyM).toBe(24 * ONE_UNIT) // ONE scan sells 24 pieces' worth of stock
    expect(scanned.unitPrice).toBe(230_000) // at the CARTON's price
    expect(scanned.packLabel).toBe('Carton')

    // ── The sale ──
    const { sale, receipt } = sales.complete(t.db, cashier, {
      lines: [{ productId, packId: scanned.packId, qtyM: scanned.qtyM }],
      payments: [{ methodLookupId: cash(), amount: 230_000 }]
    })

    // ONE carton, Rs 2,300 — NOT 24 x Rs 2,300.
    expect(sale.grandTotal).toBe(230_000)

    const line = sale.lines[0]!
    expect(line.unitPrice).toBe(230_000)
    expect(line.qtyM).toBe(24 * ONE_UNIT) // stored in BASE units — that is what left the shelf
    expect(line.packId).toBe(scanned.packId)

    // 24 PIECES came off the shelf.
    expect(onHand(productId)).toBe(24 * ONE_UNIT)

    const movement = t.db
      .prepare("SELECT qty_m FROM stock_movements WHERE ref_type = 'sale' AND ref_id = ?")
      .pluck()
      .get(String(sale.id)) as number
    expect(movement).toBe(-24 * ONE_UNIT)

    // But the RECEIPT says what the customer bought: one carton.
    expect(receipt.lines[0]!.qtyM).toBe(ONE_UNIT)
    expect(receipt.lines[0]!.uom).toBe('Carton')
    expect(receipt.lines[0]!.gross).toBe(230_000)

    everythingHolds(t, owner)
  })

  it('REFUSES a purchase-only carton — the one with no selling price', () => {
    const productId = makeProduct({ name: 'Rice', retailPrice: 10_000 })
    openingStock(productId, 100 * ONE_UNIT)

    // "Buy in cartons, sell in pieces": the carton carries the supplier's barcode so a delivery can be
    // scanned IN, and has no retail price because a carton is never sold as one.
    catalog.savePack(t.db, {
      productId,
      uomId: lookupId('uom', 'carton'),
      packSize: 24 * ONE_UNIT,
      retailPrice: 0, // PURCHASE ONLY
      barcode: 'SUPPLIER-OUTER'
    })

    // Ringing it up would hand the customer a free carton of rice.
    expectUserMessage(
      () => sales.scanBarcode(t.db, 'SUPPLIER-OUTER'),
      /carton \(outer\) for "Rice".*no selling price.*scan the item itself/s
    )

    everythingHolds(t, owner)
  })

  it('refuses half a carton at the carton price', () => {
    const productId = makeProduct({ retailPrice: 10_000, taxRateBp: 0 })
    openingStock(productId, 100 * ONE_UNIT)

    const pack = catalog.savePack(t.db, {
      productId,
      uomId: lookupId('uom', 'carton'),
      packSize: 24 * ONE_UNIT,
      retailPrice: 230_000,
      barcode: 'CARTON-X'
    })

    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          lines: [{ productId, packId: pack.id, qtyM: 12 * ONE_UNIT }], // half a carton
          payments: [{ methodLookupId: cash(), amount: 115_000 }]
        }),
      /only be sold in whole ones/
    )

    everythingHolds(t, owner)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// WEIGHED GOODS
// ═════════════════════════════════════════════════════════════════════════════

describe('a weighed item', () => {
  it('sells 1.234 kg at Rs 320/kg EXACTLY — Rs 394.88, with no float anywhere', () => {
    const productId = makeProduct({
      name: 'Tomatoes',
      retailPrice: 32_000, // Rs 320.00 per kg
      taxRateBp: 0,
      isWeighted: true,
      uom: 'kg'
    })
    openingStock(productId, 10 * ONE_UNIT, 200_000) // 10 kg @ Rs 20.0000/kg

    const { sale } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: 1_234 }], // 1.234 kg — INTEGER thousandths
      payments: [{ methodLookupId: cash(), amount: 39_488 }]
    })

    // 32000 x 1234 / 1000 = 39,488 paisa. Rs 394.88. Exact.
    const line = sale.lines[0]!
    expect(line.qtyM).toBe(1_234)
    expect(line.net).toBe(39_488)
    expect(line.gross).toBe(39_488)
    expect(sale.grandTotal).toBe(39_488)

    // Every stored figure is an INTEGER. Not "close to" an integer — an integer.
    for (const value of [line.net, line.taxAmount, line.gross, line.unitPrice, line.qtyM, line.unitCost]) {
      expect(Number.isInteger(value)).toBe(true)
    }

    // The stock came off in grams, and the COGS is exact too: 1.234 kg x Rs 20 = Rs 24.68.
    expect(onHand(productId)).toBe(10 * ONE_UNIT - 1_234)
    const value = t.db
      .prepare("SELECT value_minor FROM stock_movements WHERE ref_type = 'sale' AND ref_id = ?")
      .pluck()
      .get(String(sale.id)) as number
    expect(value).toBe(-2_468)

    everythingHolds(t, owner)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// GAPLESS NUMBERING
// ═════════════════════════════════════════════════════════════════════════════

describe('invoice numbering', () => {
  it('is GAPLESS: a voided invoice KEEPS its number, and the next sale takes the next one', () => {
    settings.set(t.db, 'invoice.includeYear', false) // INV-000001, not INV-2026-000001

    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 100 * ONE_UNIT)

    const sell = () =>
      sales.complete(t.db, cashier, {
        lines: [{ productId, qtyM: ONE_UNIT }],
        payments: [{ methodLookupId: cash(), amount: 10_000 }]
      }).sale

    const first = sell()
    const second = sell()
    const third = sell()

    expect(first.invoiceNo).toBe('INV-000001')
    expect(second.invoiceNo).toBe('INV-000002')
    expect(third.invoiceNo).toBe('INV-000003')

    // CANCEL THE MIDDLE ONE.
    const voided = sales.voidSale(t.db, supervisor, {
      id: second.id,
      reasonCode: 'wrong_item'
    })

    // IT KEEPS ITS NUMBER. Forever. A book that renumbers itself cannot be audited.
    expect(voided.status).toBe('voided')
    expect(voided.invoiceNo).toBe('INV-000002')
    expect(voided.invoiceSeq).toBe(2)

    // And the next sale is 4 — the number is never reused, and never renumbered.
    expect(sell().invoiceNo).toBe('INV-000004')

    const numbers = t.db
      .prepare('SELECT invoice_no FROM sales ORDER BY invoice_seq')
      .pluck()
      .all() as string[]
    expect(numbers).toEqual(['INV-000001', 'INV-000002', 'INV-000003', 'INV-000004'])

    everythingHolds(t, owner)
  })

  it('draws the number INSIDE the sale’s transaction — a failed sale leaves no hole', () => {
    settings.set(t.db, 'invoice.includeYear', false)

    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 10_000 }]
    })

    // This one dies inside the transaction — after a number would have been drawn.
    expect(() =>
      sales.complete(t.db, cashier, {
        lines: [{ productId, qtyM: ONE_UNIT }, { productId: 999_999, qtyM: ONE_UNIT }],
        payments: [{ methodLookupId: cash(), amount: 20_000 }]
      })
    ).toThrow()

    // The next real sale takes 2, not 3. No gap.
    const next = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 10_000 }]
    }).sale

    expect(next.invoiceNo).toBe('INV-000002')
    everythingHolds(t, owner)
  })

  it('formats the number from SETTINGS, including the year', () => {
    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    settings.set(t.db, 'invoice.prefix', 'BILL/')
    settings.set(t.db, 'invoice.padding', 4)
    settings.set(t.db, 'invoice.includeYear', true)

    const { sale } = sales.complete(
      t.db,
      cashier,
      {
        lines: [{ productId, qtyM: ONE_UNIT }],
        payments: [{ methodLookupId: cash(), amount: 10_000 }]
      },
      new Date('2026-03-04T10:00:00Z')
    )

    expect(sale.invoiceNo).toBe('BILL/2026-0001')
    everythingHolds(t, owner)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// HOLD AND RESUME — a parked cart survives the app being closed
// ═════════════════════════════════════════════════════════════════════════════

describe('holding a cart', () => {
  it('takes NO invoice number, moves no stock, posts no journal — and survives a restart', () => {
    const productId = makeProduct({ name: 'Milk', taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    const journalsBefore = t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get() as number

    const held = sales.hold(t.db, cashier, {
      lines: [{ productId, qtyM: 2 * ONE_UNIT }]
    })

    // NOTHING HAS HAPPENED YET. That is what keeps numbering gapless.
    expect(held.status).toBe('held')
    expect(held.invoiceNo).toBeNull()
    expect(held.invoiceSeq).toBeNull()
    expect(onHand(productId)).toBe(10 * ONE_UNIT) // stock has not moved
    expect(t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get()).toBe(journalsBefore)
    expect(t.db.prepare('SELECT COUNT(*) FROM invoice_counters').pluck().get()).toBe(0)

    expect(sales.listHeld(t.db).map((row) => row.id)).toEqual([held.id])

    // ── RESTART. A brand new connection to the same file on disk. ──
    const reopened = openDatabase(t.path)
    try {
      const resumed = sales.resume(reopened, { id: held.id })

      expect(resumed.status).toBe('held')
      expect(resumed.invoiceNo).toBeNull()
      expect(resumed.lines).toHaveLength(1)
      expect(resumed.lines[0]!.nameSnapshot).toBe('Milk')
      expect(resumed.lines[0]!.qtyM).toBe(2 * ONE_UNIT)

      // Put it back on the screen and ring it up.
      const { sale } = sales.complete(reopened, cashier, {
        saleId: held.id,
        lines: sales.toCartLines(resumed),
        payments: [{ methodLookupId: cash(), amount: 20_000 }]
      })

      expect(sale.status).toBe('completed')
      expect(sale.invoiceNo).not.toBeNull() // NOW it has a number
      expect(sale.grandTotal).toBe(20_000)
      expect(sale.id).toBe(held.id) // the parked cart BECAME the sale
    } finally {
      closeDatabase(reopened)
    }

    // THE PARKED CART IS GONE FROM THE TRAY.
    //
    // Regression: complete() used to INSERT a second row and leave the held one sitting there — so the
    // next cashier would find the cart still parked and ring the whole thing up again. The customer
    // pays twice, the stock goes out twice, and both sales look perfectly correct.
    expect(sales.listHeld(t.db)).toHaveLength(0)
    expect(t.db.prepare('SELECT COUNT(*) FROM sales').pluck().get()).toBe(1)
    expect(t.db.prepare('SELECT COUNT(*) FROM sale_lines').pluck().get()).toBe(1)

    // The stock moved ONCE, when it was actually sold.
    expect(onHand(productId)).toBe(8 * ONE_UNIT)
    everythingHolds(t, owner)
  })

  it('re-parking a cart updates it in place — one customer, one parked cart', () => {
    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    const held = sales.hold(t.db, cashier, { lines: [{ productId, qtyM: ONE_UNIT }] })

    // They came back with the milk after all.
    const again = sales.hold(t.db, cashier, {
      saleId: held.id,
      lines: [{ productId, qtyM: 3 * ONE_UNIT }]
    })

    expect(again.id).toBe(held.id)
    expect(again.grandTotal).toBe(30_000)
    expect(sales.listHeld(t.db)).toHaveLength(1) // not two
    expect(t.db.prepare('SELECT COUNT(*) FROM sale_lines').pluck().get()).toBe(1)

    everythingHolds(t, owner)
  })

  it('a QUOTE converts into the sale — the same document the customer was quoted', () => {
    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    const quote = sales.saveQuote(t.db, cashier, { lines: [{ productId, qtyM: 2 * ONE_UNIT }] })
    expect(quote.invoiceNo).toBeNull()

    const { sale } = sales.complete(t.db, cashier, {
      saleId: quote.id,
      lines: sales.toCartLines(quote),
      payments: [{ methodLookupId: cash(), amount: 20_000 }]
    })

    // PLAN.md §2: "a quote converts to a sale and only then takes an invoice number".
    expect(sale.id).toBe(quote.id)
    expect(sale.status).toBe('completed')
    expect(sale.invoiceNo).not.toBeNull()
    expect(t.db.prepare('SELECT COUNT(*) FROM sales').pluck().get()).toBe(1)

    everythingHolds(t, owner)
  })

  it('discards a parked cart without a trace on the books', () => {
    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    const held = sales.hold(t.db, cashier, { lines: [{ productId, qtyM: ONE_UNIT }] })
    sales.discard(t.db, cashier, { id: held.id })

    expect(t.db.prepare('SELECT COUNT(*) FROM sales').pluck().get()).toBe(0)
    expect(t.db.prepare('SELECT COUNT(*) FROM sale_lines').pluck().get()).toBe(0) // CASCADE
    expect(auditRows('sale.discard')).toHaveLength(1)
    expect(onHand(productId)).toBe(10 * ONE_UNIT)

    everythingHolds(t, owner)
  })

  it('refuses to reopen a completed sale', () => {
    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    const { sale } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 10_000 }]
    })

    expectUserMessage(() => sales.resume(t.db, { id: sale.id }), /already been completed/)
    everythingHolds(t, owner)
  })

  it('a QUOTE takes no number either', () => {
    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    const quote = sales.saveQuote(t.db, cashier, { lines: [{ productId, qtyM: 3 * ONE_UNIT }] })

    expect(quote.status).toBe('quote')
    expect(quote.invoiceNo).toBeNull()
    expect(quote.grandTotal).toBe(30_000) // it still quotes a price
    expect(onHand(productId)).toBe(10 * ONE_UNIT)

    everythingHolds(t, owner)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// HOW LONG A QUOTATION HOLDS — valid_until (migration 0015)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * THE INVARIANT THE DATABASE CANNOT ENFORCE:
 *
 *     valid_until IS NOT NULL   ⟺   status = 'quote'
 *
 * SQLite cannot ALTER-TABLE a table CHECK on, so the SERVICE owns it (saveQuote sets it, hold and
 * complete clear it) — which means a test has to be the thing that proves it. This one runs over EVERY
 * sale in the database, not just the row the test was thinking about.
 */
function assertOnlyQuotesExpire(t: TestDb): void {
  const rows = t.db.prepare('SELECT id, status, valid_until FROM sales').all() as Array<{
    id: number
    status: string
    valid_until: string | null
  }>

  for (const row of rows) {
    if (row.status === 'quote') {
      expect(row.valid_until, `sale ${row.id}: a QUOTE with no expiry — the offer never lapses`).not.toBeNull()
    } else {
      expect(
        row.valid_until,
        `sale ${row.id}: a ${row.status} sale carrying an offer's expiry date`
      ).toBeNull()
    }
  }
}

describe('how long a quotation holds', () => {
  /** The quote tray and the printed document read this straight off the row. */
  const validUntilOf = (id: number): string | null =>
    t.db.prepare('SELECT valid_until FROM sales WHERE id = ?').pluck().get(id) as string | null

  it("dates the offer from the shop's own setting, not a constant in the code", () => {
    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    // The registry default is 7 days. Saved on the 4th of March -> good until the 11th.
    const quote = sales.saveQuote(
      t.db,
      cashier,
      { lines: [{ productId, qtyM: ONE_UNIT }] },
      new Date(2026, 2, 4, 10, 30)
    )

    expect(quote.validUntil).toBe('2026-03-11')
    expect(validUntilOf(quote.id)).toBe('2026-03-11') // it is on the ROW, not just the return value

    assertOnlyQuotesExpire(t)
    everythingHolds(t, owner)
  })

  it('honours a CHANGED setting — one shop honours a price for a week, the next for a month', () => {
    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    settings.set(t.db, 'selling.quoteValidDays', 30)

    const quote = sales.saveQuote(
      t.db,
      cashier,
      { lines: [{ productId, qtyM: ONE_UNIT }] },
      new Date(2026, 2, 4, 10, 30)
    )

    // 30 days from 4 March 2026 — across a month boundary, which is exactly where naive date maths
    // ("month + 1") goes wrong.
    expect(quote.validUntil).toBe('2026-04-03')

    assertOnlyQuotesExpire(t)
    everythingHolds(t, owner)
  })

  it('RE-SAVING a quote re-dates it — the offer is being made again, today', () => {
    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    const first = sales.saveQuote(
      t.db,
      cashier,
      { lines: [{ productId, qtyM: ONE_UNIT }] },
      new Date(2026, 2, 4, 10, 30)
    )
    expect(first.validUntil).toBe('2026-03-11')

    // The customer came back a week later and asked for the same price on more of it. The cart is
    // RE-PRICED on the way through, so carrying the old deadline forward would staple today's price to
    // last week's expiry.
    const again = sales.saveQuote(
      t.db,
      cashier,
      { saleId: first.id, lines: [{ productId, qtyM: 3 * ONE_UNIT }] },
      new Date(2026, 2, 11, 9, 0)
    )

    expect(again.id).toBe(first.id) // the same document, updated in place
    expect(again.validUntil).toBe('2026-03-18') // RE-DATED from the new day
    expect(sales.listHeld(t.db, 'quote')).toHaveLength(1) // not two

    assertOnlyQuotesExpire(t)
    everythingHolds(t, owner)
  })

  it('a HELD cart has NO expiry — a parked cart is not an offer', () => {
    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    const held = sales.hold(t.db, cashier, { lines: [{ productId, qtyM: ONE_UNIT }] })

    // Nobody was promised anything: the customer is still in the shop, and complete() re-prices it.
    expect(held.validUntil).toBeNull()
    expect(validUntilOf(held.id)).toBeNull()

    assertOnlyQuotesExpire(t)
    everythingHolds(t, owner)
  })

  it('CONVERTING the quote to a sale CLEARS the expiry — money changed hands', () => {
    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    const quote = sales.saveQuote(
      t.db,
      cashier,
      { lines: [{ productId, qtyM: 2 * ONE_UNIT }] },
      new Date(2026, 2, 4, 10, 30)
    )
    expect(quote.validUntil).toBe('2026-03-11')

    const { sale } = sales.complete(t.db, cashier, {
      saleId: quote.id,
      lines: sales.toCartLines(quote),
      payments: [{ methodLookupId: cash(), amount: 20_000 }]
    })

    // The SAME row (PLAN.md §2) — so the expiry has to be cleared rather than left behind. An invoice
    // with a use-by date on it is nonsense, and the quote tray's partial index (migration 0015) would
    // otherwise go on treating this completed sale as a live quote: invoiced once, still waiting to be
    // rung up again.
    expect(sale.id).toBe(quote.id)
    expect(sale.status).toBe('completed')
    expect(sale.validUntil).toBeNull()
    expect(validUntilOf(sale.id)).toBeNull()

    // The tray is empty, and the index agrees there is nothing live.
    expect(sales.listHeld(t.db, 'quote')).toHaveLength(0)
    expect(
      t.db
        .prepare("SELECT COUNT(*) FROM sales WHERE status = 'quote' AND valid_until IS NOT NULL")
        .pluck()
        .get()
    ).toBe(0)

    assertOnlyQuotesExpire(t)
    everythingHolds(t, owner)
  })

  it('the invariant holds across hold -> quote -> complete on one document', () => {
    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    // Parked: no offer, no expiry.
    const held = sales.hold(t.db, cashier, { lines: [{ productId, qtyM: ONE_UNIT }] })
    expect(held.validUntil).toBeNull()
    assertOnlyQuotesExpire(t)

    // The customer asked for it in writing — the same cart becomes an OFFER, and gains a deadline.
    const quote = sales.saveQuote(
      t.db,
      cashier,
      { saleId: held.id, lines: [{ productId, qtyM: ONE_UNIT }] },
      new Date(2026, 2, 4, 10, 30)
    )
    expect(quote.id).toBe(held.id)
    expect(quote.status).toBe('quote')
    expect(quote.validUntil).toBe('2026-03-11')
    assertOnlyQuotesExpire(t)

    // They accepted. The offer becomes the sale, and the deadline goes.
    const { sale } = sales.complete(t.db, cashier, {
      saleId: quote.id,
      lines: sales.toCartLines(quote),
      payments: [{ methodLookupId: cash(), amount: 10_000 }]
    })
    expect(sale.id).toBe(held.id)
    expect(sale.validUntil).toBeNull()
    assertOnlyQuotesExpire(t)

    everythingHolds(t, owner)
  })

  it('a quote going back to a HELD cart drops the expiry with the offer', () => {
    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    const quote = sales.saveQuote(
      t.db,
      cashier,
      { lines: [{ productId, qtyM: ONE_UNIT }] },
      new Date(2026, 2, 4, 10, 30)
    )
    expect(quote.validUntil).toBe('2026-03-11')

    // Re-parking the same document as a plain held cart withdraws the offer — so the date must go with
    // it, or a held cart sits there carrying an expiry for a promise that no longer exists.
    const held = sales.hold(t.db, cashier, {
      saleId: quote.id,
      lines: [{ productId, qtyM: ONE_UNIT }]
    })

    expect(held.id).toBe(quote.id)
    expect(held.status).toBe('held')
    expect(held.validUntil).toBeNull()

    assertOnlyQuotesExpire(t)
    everythingHolds(t, owner)
  })

  it('the sales LIST carries the date — the quote tray reads it without loading every line', () => {
    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    const quote = sales.saveQuote(
      t.db,
      cashier,
      { lines: [{ productId, qtyM: ONE_UNIT }] },
      new Date(2026, 2, 4, 10, 30)
    )

    const [row] = sales.listHeld(t.db, 'quote')
    expect(row!.id).toBe(quote.id)
    expect(row!.validUntil).toBe('2026-03-11')

    everythingHolds(t, owner)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE QUOTATION DOCUMENT — and the receipt path that must refuse a quote
// ═════════════════════════════════════════════════════════════════════════════

describe('printing a quotation', () => {
  it('prints the lines, the totals and the date the price stops holding', () => {
    const productId = makeProduct({ name: 'Rice', retailPrice: RS_100, taxRateBp: GST })
    openingStock(productId, 10 * ONE_UNIT)

    const quote = sales.saveQuote(
      t.db,
      cashier,
      { customerId: makeCustomer('Imran'), lines: [{ productId, qtyM: 2 * ONE_UNIT }] },
      new Date(2026, 2, 4, 10, 30)
    )

    const doc = sales.quotationFor(t.db, cashier, quote.id, new Date(2026, 2, 6, 9, 0))

    expect(doc.quoteId).toBe(quote.id)
    expect(doc.customerName).toBe('Imran')
    expect(doc.cashierName).toBe(cashier.fullName)
    expect(doc.shop.name).toBe(settings.get(t.db, 'shop.name', ''))

    expect(doc.lines).toHaveLength(1)
    expect(doc.lines[0]!.name).toBe('Rice')
    expect(doc.lines[0]!.qtyM).toBe(2 * ONE_UNIT)
    expect(doc.lines[0]!.unitPrice).toBe(RS_100)

    // THE PAPER ADDS UP, exactly as the receipt's does.
    expect(doc.subtotalNet - doc.cartDiscount + doc.taxTotal).toBe(doc.grandTotal)
    expect(doc.grandTotal).toBe(quote.grandTotal)
    expect(doc.taxSummary[0]!.taxRateBp).toBe(GST)

    // The offer, and how long it holds.
    expect(doc.validUntil).toBe('2026-03-11')
    expect(doc.isExpired).toBe(false)

    everythingHolds(t, owner)
  })

  it('says so plainly when the offer has lapsed — and still prints it', () => {
    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    const quote = sales.saveQuote(
      t.db,
      cashier,
      { lines: [{ productId, qtyM: ONE_UNIT }] },
      new Date(2026, 2, 4, 10, 30)
    )

    // The last day it holds — an offer good "until the 11th" is good for ALL of the 11th.
    expect(sales.quotationFor(t.db, cashier, quote.id, new Date(2026, 2, 11, 23, 0)).isExpired).toBe(
      false
    )

    // The day after. Nothing is BLOCKED: an expired quote is a conversation with the customer, not a
    // lock the till should enforce. The paper simply says so.
    const lapsed = sales.quotationFor(t.db, cashier, quote.id, new Date(2026, 2, 12, 9, 0))
    expect(lapsed.isExpired).toBe(true)
    expect(lapsed.grandTotal).toBe(quote.grandTotal) // it still prints the price that was promised

    everythingHolds(t, owner)
  })

  it('a quotation is NOT a receipt — it carries no number, no payments, no change', () => {
    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    const quote = sales.saveQuote(t.db, cashier, { lines: [{ productId, qtyM: ONE_UNIT }] })
    const doc = sales.quotationFor(t.db, cashier, quote.id)

    // The fields that would let an offer masquerade as proof of payment are not on the type, and must
    // not appear at runtime either.
    const asRecord = doc as unknown as Record<string, unknown>
    expect(asRecord['invoiceNo']).toBeUndefined()
    expect(asRecord['payments']).toBeUndefined()
    expect(asRecord['changeDue']).toBeUndefined()
    expect(asRecord['isDuplicate']).toBeUndefined()

    everythingHolds(t, owner)
  })

  it('REFUSES a completed sale — history gets a receipt, not an offer', () => {
    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    const { sale } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 10_000 }]
    })

    expectUserMessage(() => sales.quotationFor(t.db, cashier, sale.id), /not a quotation/)
    everythingHolds(t, owner)
  })

  it('REFUSES a held cart — nobody has been offered anything', () => {
    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    const held = sales.hold(t.db, cashier, { lines: [{ productId, qtyM: ONE_UNIT }] })

    expectUserMessage(() => sales.quotationFor(t.db, cashier, held.id), /not a quotation/)
    everythingHolds(t, owner)
  })

  /**
   * THE BUG THIS WHOLE GUARD EXISTS FOR.
   *
   * ReceiptData.invoiceNo is a plain string, and a quote has no number — so buildReceipt substituted
   * "(not issued yet)" and printed a document whose every other word (the totals, the tax table, the
   * shop's NTN) says SALE. The customer walks out holding what reads as a tax invoice for a sale that
   * has not happened, against stock that has not moved and a journal that has not posted.
   */
  it('the RECEIPT path refuses a quote — it would print as a sale that never happened', () => {
    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    const quote = sales.saveQuote(t.db, cashier, { lines: [{ productId, qtyM: ONE_UNIT }] })

    expectUserMessage(
      () => sales.receiptFor(t.db, cashier, { id: quote.id }),
      /No money has changed hands yet — print a quotation instead\./
    )

    // And it did not quietly log a reprint of a sale that never happened.
    expect(auditRows('sale.reprint')).toHaveLength(0)

    everythingHolds(t, owner)
  })

  it('the RECEIPT path refuses a held cart too', () => {
    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    const held = sales.hold(t.db, cashier, { lines: [{ productId, qtyM: ONE_UNIT }] })

    expectUserMessage(
      () => sales.receiptFor(t.db, cashier, { id: held.id }),
      /no money has changed hands yet/i
    )
    expect(auditRows('sale.reprint')).toHaveLength(0)

    everythingHolds(t, owner)
  })

  /** A void is HISTORY — money DID change hands, and it keeps its number forever. It still reprints. */
  it('a VOIDED sale still reprints as a receipt', () => {
    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    const { sale } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 10_000 }]
    })
    sales.voidSale(t.db, supervisor, { id: sale.id, reasonCode: 'wrong_item' })

    const receipt = sales.receiptFor(t.db, supervisor, { id: sale.id })
    expect(receipt.invoiceNo).toBe(sale.invoiceNo)

    everythingHolds(t, owner)
  })

  /**
   * A quote and the sale it becomes are the SAME cart, and the customer holds both pieces of paper. A
   * pack line is where they would drift: the line stores 24000 base units and PRICED as one carton.
   */
  it('the quotation and the receipt agree — same lines, same money, one implementation', () => {
    const productId = makeProduct({ name: 'Cola', retailPrice: RS_100, taxRateBp: GST })
    openingStock(productId, 100 * ONE_UNIT)

    catalog.savePack(t.db, {
      productId,
      uomId: lookupId('uom', 'carton'),
      packSize: 24 * ONE_UNIT, // a carton holds 24 pieces
      retailPrice: 200_000, // priced in its own right
      barcode: 'QUOTE-CARTON-24'
    })
    const scanned = sales.scanBarcode(t.db, 'QUOTE-CARTON-24')!

    const quote = sales.saveQuote(t.db, cashier, {
      lines: [{ productId, packId: scanned.packId, qtyM: scanned.qtyM }],
      cartDiscount: 5_000
    })

    const doc = sales.quotationFor(t.db, cashier, quote.id)

    const { sale, receipt } = sales.complete(t.db, cashier, {
      saleId: quote.id,
      lines: sales.toCartLines(quote),
      cartDiscount: 5_000,
      payments: [{ methodLookupId: cash(), amount: quote.grandTotal }]
    })

    expect(sale.id).toBe(quote.id) // the same document throughout

    // A CARTON on the offer is a CARTON on the receipt — not 24 pieces at 1/24th the price.
    expect(doc.lines[0]!.qtyM).toBe(receipt.lines[0]!.qtyM)
    expect(doc.lines[0]!.qtyM).toBe(ONE_UNIT)
    expect(doc.lines[0]!.unitPrice).toBe(receipt.lines[0]!.unitPrice)

    // And the cart discount is apportioned identically — the figure the customer was promised is the
    // figure they are charged, to the paisa.
    expect(doc.subtotalNet).toBe(receipt.subtotalNet)
    expect(doc.cartDiscount).toBe(receipt.cartDiscount)
    expect(doc.taxTotal).toBe(receipt.taxTotal)
    expect(doc.grandTotal).toBe(receipt.grandTotal)

    everythingHolds(t, owner)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// VOID
// ═════════════════════════════════════════════════════════════════════════════

describe('voiding a sale', () => {
  it('puts the stock back, posts a CONTRA journal, and never touches the original', () => {
    const productId = makeProduct({ name: 'Rice', retailPrice: 10_000, taxRateBp: GST })
    openingStock(productId, 10 * ONE_UNIT)

    const inventoryBefore = ledger.accountBalance(t.db, ACC.INVENTORY)

    const { sale, journalId } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: 2 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 23_400 }]
    })

    expect(onHand(productId)).toBe(8 * ONE_UNIT)

    // ── CANCEL IT ──
    const voided = sales.voidSale(
      t.db,
      supervisor,
      { id: sale.id, reasonCode: 'customer_changed_mind', reasonText: 'Changed their mind at the door' }
    )

    expect(voided.status).toBe('voided')
    expect(voided.invoiceNo).toBe(sale.invoiceNo) // IT KEEPS ITS NUMBER
    expect(voided.voidReasonCode).toBe('customer_changed_mind')
    expect(voided.voidedByUserId).toBe(supervisor.id)
    expect(voided.voidedAt).not.toBeNull()

    // The stock is back on the shelf, at the cost it left at.
    expect(onHand(productId)).toBe(10 * ONE_UNIT)
    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(inventoryBefore)

    // THE ORIGINAL JOURNAL IS STILL THERE. The ledger is append-only.
    const originalStillThere = t.db
      .prepare('SELECT COUNT(*) FROM journal_lines WHERE journal_id = ?')
      .pluck()
      .get(journalId) as number
    expect(originalStillThere).toBe(5)

    // And a CONTRA entry sits beside it.
    const contra = t.db
      .prepare(`SELECT id, memo FROM journals WHERE ref_type = 'sale_void' AND ref_id = ?`)
      .get(String(sale.id)) as { id: number; memo: string }
    expect(contra).toBeTruthy()
    expect(contra.memo).toContain(sale.invoiceNo!)

    // Every account the sale touched is back where it started.
    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(0)
    expect(ledger.accountBalance(t.db, ACC.SALES)).toBe(0)
    expect(ledger.accountBalance(t.db, ACC.OUTPUT_TAX)).toBe(0)
    expect(ledger.accountBalance(t.db, ACC.COGS)).toBe(0)

    // WHO cancelled it, WHY, and when.
    const rows = auditRows('sale.void')
    expect(rows).toHaveLength(1)
    expect(rows[0]!['user_name']).toBe('Rashid Supervisor')
    expect(rows[0]!['user_role']).toBe('supervisor')
    expect(rows[0]!['reason_code']).toBe('customer_changed_mind')
    expect(rows[0]!['reason_text']).toBe('Changed their mind at the door')

    everythingHolds(t, owner)
  })

  it('needs a supervisor — a cashier cannot cancel a sale on their own', () => {
    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    const { sale } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 10_000 }]
    })

    expectUserMessage(
      () => sales.voidSale(t.db, cashier, { id: sale.id, reasonCode: 'wrong_item' }),
      /needs a supervisor/
    )

    // ...but a supervisor standing at the till can approve it.
    const voided = sales.voidSale(
      t.db,
      cashier,
      { id: sale.id, reasonCode: 'wrong_item' },
      supervisor
    )
    expect(voided.status).toBe('voided')
    expect(auditRows('sale.void')[0]!['approved_by_name']).toBe('Rashid Supervisor')

    everythingHolds(t, owner)
  })

  it('demands a reason from the owner’s own list', () => {
    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    const { sale } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 10_000 }]
    })

    expectUserMessage(
      () => sales.voidSale(t.db, supervisor, { id: sale.id, reasonCode: 'made_up' }),
      /choose a reason for cancelling/
    )

    everythingHolds(t, owner)
  })

  it('cannot be done twice', () => {
    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    const { sale } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 10_000 }]
    })

    sales.voidSale(t.db, supervisor, { id: sale.id, reasonCode: 'test_sale' })

    expectUserMessage(
      () => sales.voidSale(t.db, supervisor, { id: sale.id, reasonCode: 'test_sale' }),
      /already been cancelled/
    )

    everythingHolds(t, owner)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// OPEN ITEMS
// ═════════════════════════════════════════════════════════════════════════════

describe('an open item', () => {
  it('sells something that is not in the catalogue at all — and moves no stock', () => {
    const { sale, journalId } = sales.complete(t.db, cashier, {
      lines: [
        {
          qtyM: ONE_UNIT,
          openItem: { name: 'Photocopy', unitPrice: 2_000, taxRateBp: 0 }
        }
      ],
      payments: [{ methodLookupId: cash(), amount: 2_000 }]
    })

    const line = sale.lines[0]!
    expect(line.productId).toBeNull() // there is no product behind it
    expect(line.isOpenItem).toBe(true)
    expect(line.nameSnapshot).toBe('Photocopy')
    expect(line.unitPrice).toBe(2_000)
    expect(line.gross).toBe(2_000)
    expect(line.unitCost).toBe(0) // nothing on a shelf, so nothing it cost

    // NO STOCK MOVEMENT, and no COGS/Inventory pair in the journal.
    expect(
      t.db
        .prepare("SELECT COUNT(*) FROM stock_movements WHERE ref_type = 'sale' AND ref_id = ?")
        .pluck()
        .get(String(sale.id))
    ).toBe(0)

    const codes = t.db
      .prepare(
        `SELECT a.code FROM journal_lines l JOIN accounts a ON a.id = l.account_id
         WHERE l.journal_id = ? ORDER BY a.code`
      )
      .pluck()
      .all(journalId) as string[]

    expect(codes).toEqual([ACC.CASH, ACC.SALES])

    everythingHolds(t, owner)
  })

  it('falls back to the shop’s default tax when the cashier does not state one', () => {
    const { sale } = sales.complete(t.db, cashier, {
      lines: [{ qtyM: ONE_UNIT, openItem: { name: 'Service charge', unitPrice: 10_000 } }],
      payments: [{ methodLookupId: cash(), amount: 11_700 }]
    })

    // tax.defaultRateBp = 1700, tax.defaultMode = exclusive.
    expect(sale.lines[0]!.taxRateBp).toBe(GST)
    expect(sale.grandTotal).toBe(11_700)

    everythingHolds(t, owner)
  })

  it('can sit in the same cart as a real product', () => {
    const productId = makeProduct({ retailPrice: 10_000, taxRateBp: GST })
    openingStock(productId, 10 * ONE_UNIT)

    const { sale } = sales.complete(t.db, cashier, {
      lines: [
        { productId, qtyM: ONE_UNIT },
        { qtyM: ONE_UNIT, openItem: { name: 'Carrier bag', unitPrice: 500, taxRateBp: 0 } }
      ],
      payments: [{ methodLookupId: cash(), amount: 12_200 }]
    })

    expect(sale.grandTotal).toBe(11_700 + 500)
    expect(onHand(productId)).toBe(9 * ONE_UNIT) // only the real one moved

    everythingHolds(t, owner)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// REPRINT
// ═════════════════════════════════════════════════════════════════════════════

describe('reprinting a receipt', () => {
  it('stamps it DUPLICATE, logs it, and prints exactly what it printed the first time', () => {
    const productId = makeProduct({ retailPrice: 10_000, taxRateBp: GST })
    openingStock(productId, 100 * ONE_UNIT)

    const { sale, receipt: original } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: 7 * ONE_UNIT }],
      cartDiscount: 3_333, // an awkward number, so any drift shows up
      cartDiscountReasonCode: 'damaged_packaging',
      approverPin: pinOf(supervisor.username),
      payments: [{ methodLookupId: cash(), amount: 78_567 }]
    })

    const duplicate = sales.receiptFor(t.db, supervisor, { id: sale.id })

    expect(duplicate.isDuplicate).toBe(true) // it must never pass for the original
    expect(original.isDuplicate).toBe(false)

    // A reprint that disagreed with the original by a paisa would be evidence of something that never
    // happened. Every figure is rebuilt from the FROZEN lines, and comes out the same.
    expect(duplicate.grandTotal).toBe(original.grandTotal)
    expect(duplicate.subtotalNet).toBe(original.subtotalNet)
    expect(duplicate.cartDiscount).toBe(original.cartDiscount)
    expect(duplicate.taxTotal).toBe(original.taxTotal)
    expect(duplicate.lines).toEqual(original.lines)
    expect(duplicate.taxSummary).toEqual(original.taxSummary)
    expect(duplicate.subtotalNet - duplicate.cartDiscount + duplicate.taxTotal).toBe(
      duplicate.grandTotal
    )

    const rows = auditRows('sale.reprint')
    expect(rows).toHaveLength(1)
    expect(rows[0]!['user_name']).toBe('Rashid Supervisor')

    everythingHolds(t, owner)
  })

  it('a reprint agrees with the original TO THE PAISA on a discount that splits awkwardly', () => {
    // Regression. The receipt's Discount line used to be worked out one way when printing at the till
    // (the sum of what each line's net actually dropped by) and another way on a reprint (the discount
    // scaled by the sale's overall net-to-gross ratio). On THIS cart those two roads land a paisa apart
    // — 85.48 against 85.47 — so the shop would hand a customer a duplicate that disagreed with the
    // receipt already in their hand. Both figures are now rebuilt by one function from the frozen lines.
    const a = makeProduct({ name: 'A', retailPrice: 10_000, taxRateBp: GST })
    const b = makeProduct({ name: 'B', retailPrice: 30_000, taxRateBp: GST })
    openingStock(a, 100 * ONE_UNIT)
    openingStock(b, 100 * ONE_UNIT)

    const { sale, receipt: original } = sales.complete(t.db, cashier, {
      lines: [
        { productId: a, qtyM: 3 * ONE_UNIT },
        { productId: b, qtyM: ONE_UNIT }
      ],
      cartDiscount: 10_000,
      cartDiscountReasonCode: 'bulk',
      approverPin: pinOf(supervisor.username),
      payments: [{ methodLookupId: cash(), amount: 60_200 }]
    })

    const duplicate = sales.receiptFor(t.db, cashier, { id: sale.id })

    expect(original.cartDiscount).toBe(8_548) // the ex-tax revenue actually given away
    expect(duplicate.cartDiscount).toBe(original.cartDiscount)
    expect(duplicate.subtotalNet).toBe(original.subtotalNet)
    expect(duplicate.grandTotal).toBe(original.grandTotal)

    // And both add up to the same total the customer paid.
    for (const receipt of [original, duplicate]) {
      expect(receipt.subtotalNet - receipt.cartDiscount + receipt.taxTotal).toBe(60_200)
    }

    everythingHolds(t, owner)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// PRICE TIERS AND OVERRIDES
// ═════════════════════════════════════════════════════════════════════════════

describe('price tiers and overrides', () => {
  it('charges the wholesale price — but only for someone allowed to switch to it', () => {
    const productId = makeProduct({ retailPrice: 10_000, wholesalePrice: 8_000, taxRateBp: 0 })
    openingStock(productId, 100 * ONE_UNIT)

    // selling.wholesaleTierRole defaults to 'supervisor'.
    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          lines: [{ productId, qtyM: ONE_UNIT }],
          priceTier: 'wholesale',
          payments: [{ methodLookupId: cash(), amount: 8_000 }]
        }),
      /Selling at wholesale prices needs approval/
    )

    const { sale } = sales.complete(t.db, supervisor, {
      lines: [{ productId, qtyM: ONE_UNIT }],
      priceTier: 'wholesale',
      payments: [{ methodLookupId: cash(), amount: 8_000 }]
    })

    expect(sale.priceTier).toBe('wholesale')
    expect(sale.lines[0]!.unitPrice).toBe(8_000)

    everythingHolds(t, owner)
  })

  it('falls back to retail when no wholesale price was ever set — never to zero', () => {
    // A wholesale_price of 0 means "the shop never set one". Charging 0 would give the stock away.
    const productId = makeProduct({ retailPrice: 10_000, wholesalePrice: 0, taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    const { sale } = sales.complete(t.db, supervisor, {
      lines: [{ productId, qtyM: ONE_UNIT }],
      priceTier: 'wholesale',
      payments: [{ methodLookupId: cash(), amount: 10_000 }]
    })

    expect(sale.lines[0]!.unitPrice).toBe(10_000) // retail, not free
    everythingHolds(t, owner)
  })

  it('records a price override with a name against it', () => {
    const productId = makeProduct({ name: 'Dented tin', retailPrice: 10_000, taxRateBp: 0 })
    openingStock(productId, 10 * ONE_UNIT)

    // A cashier may not do it on their own (selling.priceOverrideRole = supervisor).
    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          lines: [{ productId, qtyM: ONE_UNIT, priceOverride: 5_000 }],
          payments: [{ methodLookupId: cash(), amount: 5_000 }]
        }),
      /Changing the price of "Dented tin" needs approval/
    )

    // With a supervisor at the till, it goes through — and it is stamped and logged.
    const { sale } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: ONE_UNIT, priceOverride: 5_000 }],
      approverPin: pinOf(supervisor.username),
      payments: [{ methodLookupId: cash(), amount: 5_000 }]
    })

    expect(sale.lines[0]!.unitPrice).toBe(5_000)
    expect(sale.lines[0]!.priceOverrideByUserId).toBe(supervisor.id)

    const rows = auditRows('sale.price_override')
    expect(rows).toHaveLength(1)
    expect(rows[0]!['user_name']).toBe('Bilal Cashier')
    expect(rows[0]!['approved_by_name']).toBe('Rashid Supervisor')

    everythingHolds(t, owner)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE SCANNER, AND THE LISTS
// ═════════════════════════════════════════════════════════════════════════════

describe('the scanner', () => {
  it('returns null for an unknown barcode — a coupon at the till is not an error', () => {
    expect(sales.scanBarcode(t.db, 'NOT-A-BARCODE')).toBeNull()
    expect(sales.scanBarcode(t.db, '')).toBeNull()
  })

  it('resolves a plain barcode to one base unit, with its price, tax and stock', () => {
    const productId = makeProduct({ name: 'Soap', retailPrice: 4_500, taxRateBp: GST })
    catalog.addBarcode(t.db, { productId, barcode: '8964000112233' })
    openingStock(productId, 6 * ONE_UNIT)

    const scanned = sales.scanBarcode(t.db, '  8964000112233  ')! // scanners add whitespace

    expect(scanned.productId).toBe(productId)
    expect(scanned.name).toBe('Soap')
    expect(scanned.packId).toBeNull()
    expect(scanned.qtyM).toBe(ONE_UNIT)
    expect(scanned.unitPrice).toBe(4_500)
    expect(scanned.taxRateBp).toBe(GST)
    expect(scanned.taxMode).toBe('exclusive')
    expect(scanned.onHandM).toBe(6 * ONE_UNIT)
  })
})

describe('the sales list', () => {
  it('is paginated and searchable by invoice number', () => {
    settings.set(t.db, 'invoice.includeYear', false)

    const productId = makeProduct({ taxRateBp: 0 })
    openingStock(productId, 100 * ONE_UNIT)

    for (let i = 0; i < 5; i++) {
      sales.complete(t.db, cashier, {
        lines: [{ productId, qtyM: ONE_UNIT }],
        payments: [{ methodLookupId: cash(), amount: 10_000 }]
      })
    }

    const page = sales.list(t.db, { page: 1, pageSize: 2 })
    expect(page.total).toBe(5)
    expect(page.rows).toHaveLength(2)
    expect(page.rows[0]!.cashierName).toBe('Bilal Cashier')
    expect(page.rows[0]!.lineCount).toBe(1)

    const found = sales.list(t.db, { search: 'INV-000003' })
    expect(found.total).toBe(1)
    expect(found.rows[0]!.invoiceNo).toBe('INV-000003')

    // And by the number on the customer's receipt — the returns desk's first move.
    expect(sales.getByInvoiceNo(t.db, { invoiceNo: 'INV-000003' }).invoiceNo).toBe('INV-000003')

    everythingHolds(t, owner)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE CART (pure, in-memory)
// ═════════════════════════════════════════════════════════════════════════════

describe('building the cart', () => {
  it('bumps the quantity when the same thing is scanned twice', () => {
    let cart: SaleLineInput[] = []

    cart = sales.addLine(cart, { productId: 1, qtyM: ONE_UNIT, lineDiscount: 0 })
    cart = sales.addLine(cart, { productId: 1, qtyM: ONE_UNIT, lineDiscount: 0 })
    cart = sales.addLine(cart, { productId: 2, qtyM: ONE_UNIT, lineDiscount: 0 })

    expect(cart).toHaveLength(2)
    expect(cart[0]!.qtyM).toBe(2 * ONE_UNIT)
  })

  it('never merges a line that carries its own paperwork', () => {
    let cart: SaleLineInput[] = []

    cart = sales.addLine(cart, { productId: 1, qtyM: ONE_UNIT, lineDiscount: 0 })
    // A discounted line has a reason and an approver behind it — folding it into another would erase them.
    cart = sales.addLine(cart, { productId: 1, qtyM: ONE_UNIT, lineDiscount: 500 })

    expect(cart).toHaveLength(2)
  })

  it('updates and removes lines', () => {
    let cart: SaleLineInput[] = [{ productId: 1, qtyM: ONE_UNIT, lineDiscount: 0 }]

    cart = sales.updateLine(cart, 0, { qtyM: 5 * ONE_UNIT })
    expect(cart[0]!.qtyM).toBe(5 * ONE_UNIT)

    cart = sales.removeLine(cart, 0)
    expect(cart).toHaveLength(0)

    expectUserMessage(() => sales.removeLine(cart, 0), /no longer in the cart/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE ARITHMETIC ITSELF
// ═════════════════════════════════════════════════════════════════════════════

describe('the money arithmetic', () => {
  it('extends a price over a quantity with ONE rounding, half up', () => {
    expect(sales.extendPrice(10_000, ONE_UNIT)).toBe(10_000) // Rs 100 x 1
    expect(sales.extendPrice(32_000, 1_234)).toBe(39_488) // Rs 320.00/kg x 1.234 kg
    expect(sales.extendPrice(333, 1_500)).toBe(500) // 499.5 -> 500, half UP
    expect(sales.extendPrice(0, 5_000)).toBe(0) // a giveaway is still a line
  })

  it('does not lose precision on a quantity a float could not hold', () => {
    // 90,071,992,547 x 1000/1000 is past 2^53 as a product — BigInt keeps it exact, a float would not.
    expect(() => sales.extendPrice(90_071_992_547_409, 1_000_000)).toThrow()
  })

  it('freezes tax the way computeLineTax says, and gross === net + tax always', () => {
    for (const amount of [1, 7, 99, 999, 12_345, 99_999]) {
      for (const rate of [0, 500, 1700, 2_500]) {
        for (const mode of ['inclusive', 'exclusive'] as const) {
          const line = computeLineTax(amount, rate, mode)
          expect(line.gross).toBe(line.net + line.tax)
        }
      }
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// A NON-INVENTORY ITEM
// ═════════════════════════════════════════════════════════════════════════════

describe('a non-inventory item', () => {
  it('sells and earns, but has no stock to run out of', () => {
    const productId = makeProduct({
      name: 'Delivery charge',
      retailPrice: 15_000,
      taxRateBp: 0,
      itemType: 'non_inventory'
    })

    const { sale, journalId } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 15_000 }]
    })

    expect(sale.grandTotal).toBe(15_000)
    expect(sale.hadNegativeStock).toBe(false) // a service cannot be oversold

    expect(
      t.db
        .prepare("SELECT COUNT(*) FROM stock_movements WHERE ref_type = 'sale' AND ref_id = ?")
        .pluck()
        .get(String(sale.id))
    ).toBe(0)

    const codes = t.db
      .prepare(
        `SELECT a.code FROM journal_lines l JOIN accounts a ON a.id = l.account_id
         WHERE l.journal_id = ? ORDER BY a.code`
      )
      .pluck()
      .all(journalId) as string[]
    expect(codes).toEqual([ACC.CASH, ACC.SALES]) // no COGS — there was no stock

    everythingHolds(t, owner)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// BATCHES — FEFO
// ═════════════════════════════════════════════════════════════════════════════

describe('a batch-tracked item', () => {
  it('auto-picks the batch that expires SOONEST — the cashier never chooses', () => {
    const productId = makeProduct({ name: 'Yoghurt', retailPrice: 5_000, taxRateBp: 0, trackBatches: true })

    const later = catalog.addBatch(t.db, { productId, batchNo: 'B-LATER', expiryDate: '2027-01-01' })
    const sooner = catalog.addBatch(t.db, { productId, batchNo: 'B-SOONER', expiryDate: '2026-08-01' })

    stock.adjust(t.db, owner, {
      productId,
      type: 'opening',
      qtyM: 5 * ONE_UNIT,
      unitCost: RS_60_COST,
      batchId: later.id,
      reasonCode: 'data_entry'
    })
    stock.adjust(t.db, owner, {
      productId,
      type: 'opening',
      qtyM: 5 * ONE_UNIT,
      unitCost: RS_60_COST,
      batchId: sooner.id,
      reasonCode: 'data_entry'
    })

    const { sale } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 5_000 }]
    })

    // FIRST EXPIRY, FIRST OUT — or it gets thrown away.
    expect(sale.lines[0]!.batchId).toBe(sooner.id)

    everythingHolds(t, owner)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// SERIAL NUMBERS (IMEIs) — ONE PHYSICAL UNIT, ONE SERIAL
//
// REGRESSION, all of it. The sale service read `track_serials`, sent it to the screen, and then never
// checked it: `complete()` looped over whatever serials the renderer happened to send. So a phone could
// be sold with NO IMEI recorded (leaving it "in stock" forever, sellable a second time), with too few
// IMEIs, or against an IMEI belonging to a completely different product. The renderer is not a security
// boundary (CLAUDE.md §4) — main counts them.
// ═════════════════════════════════════════════════════════════════════════════

describe('a serial-tracked item', () => {
  /** A phone, with `count` IMEIs in stock and the stock movements to match. */
  function makePhone(count: number): { productId: number; serials: string[] } {
    const productId = makeProduct({
      name: 'Smartphone',
      retailPrice: 50_000,
      taxRateBp: 0,
      trackSerials: true
    })
    openingStock(productId, count * ONE_UNIT)

    const serials = Array.from({ length: count }, (_, i) => `IMEI-${i + 1}`)
    catalog.addSerials(t.db, { productId, serials })

    return { productId, serials }
  }

  function serialStatus(serial: string): string {
    return t.db
      .prepare('SELECT status FROM serial_numbers WHERE serial = ?')
      .pluck()
      .get(serial) as string
  }

  it('sells one phone against one IMEI, and marks THAT handset sold', () => {
    const { productId, serials } = makePhone(2)

    sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: ONE_UNIT, serials: [serials[0]!] }],
      payments: [{ methodLookupId: cash(), amount: 50_000 }]
    })

    expect(serialStatus('IMEI-1')).toBe('sold')
    expect(serialStatus('IMEI-2')).toBe('in_stock') // the one still in the cabinet
    expect(onHand(productId)).toBe(1 * ONE_UNIT)

    everythingHolds(t, owner)
  })

  /**
   * THE ONE THAT LET A PHONE WALK OUT UNTRACKED. Selling a flagged item with no serial used to succeed
   * silently — and because nothing was marked sold, the IMEI stayed "in stock" and could be sold again.
   */
  it('REFUSES to sell a flagged item with no serial at all', () => {
    const { productId } = makePhone(2)

    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          lines: [{ productId, qtyM: ONE_UNIT }], // no serials — the old hole
          payments: [{ methodLookupId: cash(), amount: 50_000 }]
        }),
      /scan the serial number/i
    )

    // NOTHING happened: no stock moved, no IMEI was consumed, no journal.
    expect(onHand(productId)).toBe(2 * ONE_UNIT)
    expect(serialStatus('IMEI-1')).toBe('in_stock')
    everythingHolds(t, owner)
  })

  it('REFUSES two phones against one IMEI — one per unit, counted in main', () => {
    const { productId, serials } = makePhone(3)

    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          lines: [{ productId, qtyM: 2 * ONE_UNIT, serials: [serials[0]!] }],
          payments: [{ methodLookupId: cash(), amount: 100_000 }]
        }),
      /needs 2 serial numbers/i
    )

    expect(onHand(productId)).toBe(3 * ONE_UNIT)
    expect(serialStatus('IMEI-1')).toBe('in_stock')
    everythingHolds(t, owner)
  })

  /**
   * The nastiest of the three: the phone on the line leaves untracked, while a handset that is still in
   * the cabinet is marked sold and can never be sold again. Both halves silent.
   */
  it("REFUSES an IMEI that belongs to a DIFFERENT product", () => {
    const phone = makePhone(1)
    const tabletId = makeProduct({ name: 'Tablet', retailPrice: 80_000, taxRateBp: 0, trackSerials: true })
    openingStock(tabletId, 1 * ONE_UNIT)
    catalog.addSerials(t.db, { productId: tabletId, serials: ['TABLET-SERIAL'] })

    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          lines: [{ productId: phone.productId, qtyM: ONE_UNIT, serials: ['TABLET-SERIAL'] }],
          payments: [{ methodLookupId: cash(), amount: 50_000 }]
        }),
      /does not belong to "Smartphone"/i
    )

    // The tablet was NOT quietly consumed by the phone's line.
    expect(serialStatus('TABLET-SERIAL')).toBe('in_stock')
    expect(onHand(phone.productId)).toBe(1 * ONE_UNIT)
    everythingHolds(t, owner)
  })

  it('REFUSES the same IMEI twice on one sale', () => {
    const { productId, serials } = makePhone(2)

    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          lines: [{ productId, qtyM: 2 * ONE_UNIT, serials: [serials[0]!, serials[0]!] }],
          payments: [{ methodLookupId: cash(), amount: 100_000 }]
        }),
      /entered twice/i
    )

    expect(serialStatus('IMEI-1')).toBe('in_stock')
    everythingHolds(t, owner)
  })

  it('REFUSES an IMEI that has already been sold — no handset is sold twice', () => {
    const { productId, serials } = makePhone(2)

    sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: ONE_UNIT, serials: [serials[0]!] }],
      payments: [{ methodLookupId: cash(), amount: 50_000 }]
    })

    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          lines: [{ productId, qtyM: ONE_UNIT, serials: [serials[0]!] }],
          payments: [{ methodLookupId: cash(), amount: 50_000 }]
        }),
      /already been sold/i
    )

    everythingHolds(t, owner)
  })

  /** A tin of beans has no IMEI, and the only thing main could do with one is consume someone else's. */
  it('REFUSES a serial on an item that does not track them', () => {
    const beans = makeProduct({ name: 'Beans', retailPrice: 5_000, taxRateBp: 0 })
    openingStock(beans, 10 * ONE_UNIT)

    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          lines: [{ productId: beans, qtyM: ONE_UNIT, serials: ['IMEI-1'] }],
          payments: [{ methodLookupId: cash(), amount: 5_000 }]
        }),
      /not a serial-tracked item/i
    )

    everythingHolds(t, owner)
  })

  /** A tin of beans still scans in ONE keystroke — the flag is what costs a serial, nothing else. */
  it('leaves an unflagged item alone — one keystroke, no serial prompt', () => {
    const beans = makeProduct({ name: 'Beans', retailPrice: 5_000, taxRateBp: 0 })
    openingStock(beans, 10 * ONE_UNIT)

    const { sale } = sales.complete(t.db, cashier, {
      lines: [{ productId: beans, qtyM: ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 5_000 }]
    })

    expect(sale.grandTotal).toBe(5_000)
    everythingHolds(t, owner)
  })

  /**
   * TWO PHASE-5 FEATURES, BUILT SEPARATELY, THAT DID NOT MEET.
   *
   * `toCartLines` carried back the product, the pack, the quantity and the discount — and dropped the
   * serials, because nothing stored them. So: scan a phone (the till prompts for the IMEI), hold the
   * cart while the customer fetches a charger, pick it back up, press Pay — and the sale is refused,
   * forever, because main requires one serial per unit and the Sell screen only prompts for one when
   * the item is FIRST scanned. A till that cannot finish a sale it started is a till the shop stops
   * using. The parked cart now remembers the IMEI, exactly as it remembers the quantity.
   */
  it('a HELD cart remembers its IMEIs — hold, resume, and it still sells', () => {
    const { productId, serials } = makePhone(2)

    const held = sales.hold(t.db, cashier, {
      lines: [{ productId, qtyM: ONE_UNIT, serials: [serials[0]!] }]
    })

    // Parked: nothing sold, nothing moved. The handset is still in the cabinet.
    expect(serialStatus('IMEI-1')).toBe('in_stock')
    expect(onHand(productId)).toBe(2 * ONE_UNIT)

    // Pick it back up — the IMEI comes back with it.
    const resumed = sales.toCartLines(sales.resume(t.db, { id: held.id }))
    expect(resumed[0]!.serials).toEqual(['IMEI-1'])

    // And it rings up, on the very cart the screen would hand back.
    const { sale } = sales.complete(t.db, cashier, {
      saleId: held.id,
      lines: resumed,
      payments: [{ methodLookupId: cash(), amount: 50_000 }]
    })

    expect(sale.status).toBe('completed')
    expect(serialStatus('IMEI-1')).toBe('sold')
    expect(serialStatus('IMEI-2')).toBe('in_stock')
    expect(onHand(productId)).toBe(1 * ONE_UNIT)

    everythingHolds(t, owner)
  })

  /** Voiding puts the handset back in the cabinet — or it could never be sold to anybody, ever again. */
  it('puts the IMEI back in stock when the sale is voided', () => {
    const { productId, serials } = makePhone(1)

    const { sale } = sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: ONE_UNIT, serials: [serials[0]!] }],
      payments: [{ methodLookupId: cash(), amount: 50_000 }]
    })
    expect(serialStatus('IMEI-1')).toBe('sold')

    sales.voidSale(t.db, supervisor, { id: sale.id, reasonCode: 'wrong_item' })

    expect(serialStatus('IMEI-1')).toBe('in_stock')
    expect(onHand(productId)).toBe(1 * ONE_UNIT)
    everythingHolds(t, owner)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// LOYALTY POINTS ON A SALE — earned as a promise, spent as a TENDER (migration 0017)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Every scenario here also runs the five standing assertions in `afterEach` — including the trial
 * balance. That is the point: loyalty adds legs to the sale's journal and a whole liability of its own,
 * and none of it is allowed to knock the books out of balance.
 */
describe('loyalty points on a sale', () => {
  /** Turn the scheme on. OFF is the default, so a test that wants points must say so. */
  function enableLoyalty(options: { perRupee?: number; redeemValue?: number; minToRedeem?: number } = {}): void {
    settings.set(t.db, 'loyalty.enabled', true)
    settings.set(t.db, 'loyalty.pointsPerCurrencyUnit', options.perRupee ?? 1)
    settings.set(t.db, 'loyalty.redeemValueMinor', options.redeemValue ?? 100)
    settings.set(t.db, 'loyalty.minPointsToRedeem', options.minToRedeem ?? 100)
  }

  function pointsOf(customerId: number): number {
    return t.db
      .prepare('SELECT COALESCE(SUM(points), 0) FROM loyalty_movements WHERE customer_id = ?')
      .pluck()
      .get(customerId) as number
  }

  // ── EARNING ────────────────────────────────────────────────────────────────

  it('earns points on the NET, ex-tax value — and books the promise as a liability', () => {
    enableLoyalty()
    const customerId = makeCustomer('Rashid')
    const productId = makeProduct({ retailPrice: RS_100, taxRateBp: GST })
    openingStock(productId, 10 * ONE_UNIT)

    // 2 @ Rs 100 = Rs 200 net, Rs 34 tax, Rs 234 gross.
    sales.complete(t.db, cashier, {
      customerId,
      lines: [{ productId, qtyM: 2 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 23_400 }]
    })

    // ON THE NET, NOT THE GROSS: 200 points, not 234. The shop never owned the output tax, so it does
    // not reward out of it — and the rate of reward cannot depend on the tax rate.
    expect(pointsOf(customerId)).toBe(200)

    // The promise is money owed NOW: DR Loyalty Expense · CR Loyalty Liability, at Rs 1.00 a point.
    expect(ledger.accountBalance(t.db, ACC.LOYALTY)).toBe(20_000)
    expect(ledger.accountBalance(t.db, ACC.LOYALTY_EXPENSE)).toBe(20_000)
    everythingHolds(t, owner)
  })

  it('earns NOTHING when loyalty is switched off — the default', () => {
    const customerId = makeCustomer('Rashid')
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)

    sales.complete(t.db, cashier, {
      customerId,
      lines: [{ productId, qtyM: 2 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 23_400 }]
    })

    expect(pointsOf(customerId)).toBe(0)
    expect(ledger.accountBalance(t.db, ACC.LOYALTY)).toBe(0)
    everythingHolds(t, owner)
  })

  it('earns NOTHING for a walk-in — nobody could ever claim it', () => {
    enableLoyalty()
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)

    sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: 2 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 23_400 }]
    })

    expect(t.db.prepare('SELECT COUNT(*) FROM loyalty_movements').pluck().get()).toBe(0)
    everythingHolds(t, owner)
  })

  // ── REDEEMING: A TENDER, NOT A DISCOUNT ────────────────────────────────────

  /**
   * THE CENTRAL ASSERTION OF THE WHOLE FEATURE. Points pay for the goods; they do not discount them.
   * Revenue and OUTPUT TAX must come out identical to the same sale paid entirely in cash — if they do
   * not, the shop is under-declaring tax on every redemption.
   */
  it('redeems as a TENDER: revenue and output tax are UNCHANGED, and the liability is settled', () => {
    enableLoyalty()
    const customerId = makeCustomer('Rashid')
    const productId = makeProduct({ retailPrice: RS_100, taxRateBp: GST })
    openingStock(productId, 20 * ONE_UNIT)

    // Bank 200 points on a first sale (Rs 200 net → 200 pts, booked at Rs 1.00 = Rs 200 liability).
    sales.complete(t.db, cashier, {
      customerId,
      lines: [{ productId, qtyM: 2 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 23_400 }]
    })
    expect(pointsOf(customerId)).toBe(200)

    const salesBefore = ledger.accountBalance(t.db, ACC.SALES)
    const taxBefore = ledger.accountBalance(t.db, ACC.OUTPUT_TAX)

    // A second Rs 234 sale, Rs 100 of it paid with 100 points, Rs 134 in cash.
    const { sale } = sales.complete(t.db, cashier, {
      customerId,
      lines: [{ productId, qtyM: 2 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 13_400 }],
      redeemPoints: 100
    })

    // THE FROZEN LINES ARE UNTOUCHED — the customer bought Rs 234 of goods and the paper says so.
    expect(sale.grandTotal).toBe(23_400)
    expect(sale.subtotalNet).toBe(20_000)
    expect(sale.taxTotal).toBe(3_400)

    // REVENUE AND TAX ARE FULL — exactly as if it had all been cash. This is the whole design.
    expect(ledger.accountBalance(t.db, ACC.SALES) - salesBefore).toBe(20_000)
    expect(ledger.accountBalance(t.db, ACC.OUTPUT_TAX) - taxBefore).toBe(3_400)

    // ── THE LIABILITY, POINT BY POINT ──
    //
    //   200 pt   banked by the first sale
    //   −100 pt  spent here: the liability is SETTLED by the tender, at the rate it was booked at
    //   +114 pt  earned on the part the customer funded THEMSELVES:
    //              the Rs 100 of points is tax-INCLUSIVE (it is money off the Rs 234 total), so it is
    //              scaled into net terms by the sale's own net:gross —  100 × 200/234 = Rs 85.47 —
    //              leaving Rs 114.53 of net that the cash paid for, which floors to 114 whole points.
    //   = 214 pt at Rs 1.00 = Rs 214.00
    expect(pointsOf(customerId)).toBe(214)
    expect(ledger.accountBalance(t.db, ACC.LOYALTY)).toBe(21_400)
    everythingHolds(t, owner)
  })

  /**
   * Points must not breed points. The part of the sale the customer paid FOR with points earns nothing,
   * or spending points would earn points that could be spent to earn points.
   */
  it('does not earn points on the part paid for WITH points', () => {
    enableLoyalty()
    const customerId = makeCustomer('Rashid')
    const productId = makeProduct({ retailPrice: RS_100, taxRateBp: 0, isTaxExempt: true })
    openingStock(productId, 20 * ONE_UNIT)

    // Bank 200 points (Rs 200 net, no tax → 200 pts).
    sales.complete(t.db, cashier, {
      customerId,
      lines: [{ productId, qtyM: 2 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 20_000 }]
    })

    // A Rs 200 sale: Rs 100 in points, Rs 100 in cash. Only the CASH half earns.
    sales.complete(t.db, cashier, {
      customerId,
      lines: [{ productId, qtyM: 2 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 10_000 }],
      redeemPoints: 100
    })

    // 200 earned − 100 spent + 100 earned on the cash-funded half = 200.
    expect(pointsOf(customerId)).toBe(200)
    everythingHolds(t, owner)
  })

  it('refuses to pay points out as change', () => {
    enableLoyalty()
    const customerId = makeCustomer('Rashid')
    const productId = makeProduct({ retailPrice: RS_100, taxRateBp: 0, isTaxExempt: true })
    openingStock(productId, 20 * ONE_UNIT)

    sales.complete(t.db, cashier, {
      customerId,
      lines: [{ productId, qtyM: 10 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 100_000 }]
    })
    expect(pointsOf(customerId)).toBe(1000) // Rs 1000 of points

    // A Rs 100 sale, trying to spend Rs 500 of points on it: the difference must not come back as cash.
    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          customerId,
          lines: [{ productId, qtyM: 1 * ONE_UNIT }],
          payments: [],
          redeemPoints: 500
        }),
      /worth .* which is more than this sale|cannot be paid out as change/i
    )

    expect(pointsOf(customerId)).toBe(1000) // nothing moved
    everythingHolds(t, owner)
  })

  it('lets points pay for the WHOLE sale, with no money at all', () => {
    enableLoyalty()
    const customerId = makeCustomer('Rashid')
    const productId = makeProduct({ retailPrice: RS_100, taxRateBp: 0, isTaxExempt: true })
    openingStock(productId, 20 * ONE_UNIT)

    sales.complete(t.db, cashier, {
      customerId,
      lines: [{ productId, qtyM: 10 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 100_000 }]
    })

    // A Rs 100 sale paid entirely with 100 points, and NO payment rows at all.
    const { sale } = sales.complete(t.db, cashier, {
      customerId,
      lines: [{ productId, qtyM: 1 * ONE_UNIT }],
      payments: [],
      redeemPoints: 100
    })

    expect(sale.grandTotal).toBe(10_000)
    expect(sale.payments).toHaveLength(0)
    expect(sale.changeDue).toBe(0)
    everythingHolds(t, owner)
  })

  it('refuses a sale with no payment and no points', () => {
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)

    expectUserMessage(
      () => sales.complete(t.db, cashier, { lines: [{ productId, qtyM: ONE_UNIT }], payments: [] }),
      /take a payment/i
    )
  })

  it('refuses points on a sale with no customer named', () => {
    enableLoyalty()
    const productId = makeProduct({ retailPrice: RS_100 })
    openingStock(productId, 10 * ONE_UNIT)

    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          lines: [{ productId, qtyM: ONE_UNIT }],
          payments: [{ methodLookupId: cash(), amount: 11_700 }],
          redeemPoints: 100
        }),
      /names the customer|choose who/i
    )
  })

  it('refuses fewer points than the shop minimum, and rolls the whole sale back', () => {
    enableLoyalty({ minToRedeem: 100 })
    const customerId = makeCustomer('Rashid')
    const productId = makeProduct({ retailPrice: RS_100, taxRateBp: 0, isTaxExempt: true })
    openingStock(productId, 20 * ONE_UNIT)

    sales.complete(t.db, cashier, {
      customerId,
      lines: [{ productId, qtyM: 10 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 100_000 }]
    })

    const stockBefore = onHand(productId)
    const salesCountBefore = t.db.prepare('SELECT COUNT(*) FROM sales').pluck().get()

    expectUserMessage(
      () =>
        sales.complete(t.db, cashier, {
          customerId,
          lines: [{ productId, qtyM: 1 * ONE_UNIT }],
          payments: [{ methodLookupId: cash(), amount: 5_000 }],
          redeemPoints: 50 // below the minimum of 100
        }),
      /100 at a time or more/i
    )

    // NOTHING happened: no sale, no stock movement, no invoice number burned.
    expect(onHand(productId)).toBe(stockBefore)
    expect(t.db.prepare('SELECT COUNT(*) FROM sales').pluck().get()).toBe(salesCountBefore)
    everythingHolds(t, owner)
  })

  // ── THE VOID CLAWBACK (CLAUDE.md trap #17) ─────────────────────────────────

  /**
   * A cancelled sale must not leave points behind it. Otherwise a cashier mints points by ringing a
   * sale up and voiding it — and the liability the shop carries is for promises it never made.
   */
  it('CLAWS BACK the points a voided sale earned', () => {
    enableLoyalty()
    const customerId = makeCustomer('Rashid')
    const productId = makeProduct({ retailPrice: RS_100, taxRateBp: GST })
    openingStock(productId, 10 * ONE_UNIT)

    const { sale } = sales.complete(t.db, cashier, {
      customerId,
      lines: [{ productId, qtyM: 2 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 23_400 }]
    })
    expect(pointsOf(customerId)).toBe(200)
    expect(ledger.accountBalance(t.db, ACC.LOYALTY)).toBe(20_000)

    sales.voidSale(t.db, supervisor, { id: sale.id, reasonCode: 'customer_changed_mind' })

    // THE POINTS ARE GONE, and so is the liability — the promise was never made.
    expect(pointsOf(customerId)).toBe(0)
    expect(ledger.accountBalance(t.db, ACC.LOYALTY)).toBe(0)
    everythingHolds(t, owner)
  })

  /** The mirror image: a void must GIVE BACK what the cancelled sale spent, or the customer is robbed. */
  it('GIVES BACK the points a voided sale spent', () => {
    enableLoyalty()
    const customerId = makeCustomer('Rashid')
    const productId = makeProduct({ retailPrice: RS_100, taxRateBp: 0, isTaxExempt: true })
    openingStock(productId, 20 * ONE_UNIT)

    sales.complete(t.db, cashier, {
      customerId,
      lines: [{ productId, qtyM: 10 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 100_000 }]
    })
    expect(pointsOf(customerId)).toBe(1000)

    // Spend 500 of them on a Rs 500 sale.
    const { sale } = sales.complete(t.db, cashier, {
      customerId,
      lines: [{ productId, qtyM: 5 * ONE_UNIT }],
      payments: [],
      redeemPoints: 500
    })
    expect(pointsOf(customerId)).toBe(500) // 1000 − 500 spent, and it earned nothing (all points-funded)

    sales.voidSale(t.db, supervisor, { id: sale.id, reasonCode: 'customer_changed_mind' })

    // THE SPENT POINTS COME BACK. The sale never happened.
    expect(pointsOf(customerId)).toBe(1000)
    expect(ledger.accountBalance(t.db, ACC.LOYALTY)).toBe(100_000)
    everythingHolds(t, owner)
  })

  /**
   * REGRESSION. The two halves of a sale's points DO NOT live in the same journal, and the first cut of
   * this code assumed they did: a redemption's DR is a leg of the SALE's journal (so voidSale's contra
   * already reverses it), but an EARN posts a journal of its OWN, with ref_type 'loyalty' — which the
   * contra never sees, because it only mirrors the sale's. The points went to zero and the LIABILITY
   * STAYED ON THE BOOKS at full value, with the trial balance still balancing perfectly.
   *
   * So: void a sale that BOTH earned and spent points, and assert the liability lands exactly where it
   * started. Reverse the earn twice and it goes negative; reverse it not at all and it stays high.
   */
  it('lands the liability back on EXACTLY where it started when a sale that earned AND spent is voided', () => {
    enableLoyalty()
    const customerId = makeCustomer('Rashid')
    const productId = makeProduct({ retailPrice: RS_100, taxRateBp: GST })
    openingStock(productId, 20 * ONE_UNIT)

    sales.complete(t.db, cashier, {
      customerId,
      lines: [{ productId, qtyM: 2 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 23_400 }]
    })

    const pointsBefore = pointsOf(customerId)
    const liabilityBefore = ledger.accountBalance(t.db, ACC.LOYALTY)
    const expenseBefore = ledger.accountBalance(t.db, ACC.LOYALTY_EXPENSE)

    // This one both SPENDS 100 points and EARNS on the cash-funded remainder.
    const { sale } = sales.complete(t.db, cashier, {
      customerId,
      lines: [{ productId, qtyM: 2 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 13_400 }],
      redeemPoints: 100
    })
    expect(pointsOf(customerId)).not.toBe(pointsBefore) // it really did move

    sales.voidSale(t.db, supervisor, { id: sale.id, reasonCode: 'customer_changed_mind' })

    // EVERYTHING back exactly where it was — the points, the liability AND the expense.
    expect(pointsOf(customerId)).toBe(pointsBefore)
    expect(ledger.accountBalance(t.db, ACC.LOYALTY)).toBe(liabilityBefore)
    expect(ledger.accountBalance(t.db, ACC.LOYALTY_EXPENSE)).toBe(expenseBefore)
    everythingHolds(t, owner)
  })

  it('leaves the ORIGINAL movements untouched — the points ledger is append-only', () => {
    enableLoyalty()
    const customerId = makeCustomer('Rashid')
    const productId = makeProduct({ retailPrice: RS_100, taxRateBp: 0, isTaxExempt: true })
    openingStock(productId, 10 * ONE_UNIT)

    const { sale } = sales.complete(t.db, cashier, {
      customerId,
      lines: [{ productId, qtyM: 2 * ONE_UNIT }],
      payments: [{ methodLookupId: cash(), amount: 20_000 }]
    })

    const earn = t.db
      .prepare("SELECT id, points FROM loyalty_movements WHERE type = 'earn'")
      .get() as { id: number; points: number }

    sales.voidSale(t.db, supervisor, { id: sale.id, reasonCode: 'customer_changed_mind' })

    // The earn row is still there, still positive — the reversal is a NEW row, not an edit.
    const after = t.db
      .prepare('SELECT points FROM loyalty_movements WHERE id = ?')
      .get(earn.id) as { points: number }
    expect(after.points).toBe(earn.points)
    expect(t.db.prepare('SELECT COUNT(*) FROM loyalty_movements').pluck().get()).toBe(2)
    everythingHolds(t, owner)
  })
})
