import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { hashSecret } from '../security/password'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import * as customerLedger from './customer-ledger'
import * as customers from './customers'
import * as sales from './sales'
import * as stock from './stock'
import * as ledger from './ledger'
import { ACC } from '../db/chart-of-accounts'
import { ONE_UNIT } from '@shared/qty'
import type { User } from '@shared/types'

/**
 * THE CUSTOMER LEDGER — what a customer owes, the statement, and the udhaar they pay back. (Phase 7.)
 *
 * TWO STANDING ASSERTIONS RUN AFTER EVERY SCENARIO, and they are the whole point:
 *
 *   1. THE TRIAL BALANCE BALANCES.                          (CLAUDE.md §4 — the standing test)
 *   2. GL ACCOUNTS RECEIVABLE === the summed customer balances. The ledger screen and the books can
 *      never disagree — every udhaar charge posts DR Receivable, every payment posts CR Receivable, and
 *      `balance()` is derived from exactly those rows.
 *
 * The second is the guard against THE bug this codebase is strict about (CLAUDE.md trap #17): a payment
 * taken on "the other screen" that a balance somewhere never learns about. There is no stored balance to
 * fall out of step — there is one function, and it reconciles to the paisa.
 */

// ═════════════════════════════════════════════════════════════════════════════
// The standing assertions
// ═════════════════════════════════════════════════════════════════════════════

function assertBooksBalance(t: TestDb): void {
  const tb = ledger.trialBalance(t.db)
  expect(tb.balanced, 'THE TRIAL BALANCE DOES NOT BALANCE').toBe(true)
  expect(tb.grossDebit).toBe(tb.grossCredit)
}

/**
 * The sum of what every customer owes equals the one Accounts Receivable account in the general ledger.
 * (Every credit sale in these scenarios names a customer, so nothing is owed by "nobody".)
 */
function assertReceivableReconciles(t: TestDb): void {
  const ids = t.db.prepare('SELECT id FROM customers').pluck().all() as number[]
  const summed = ids.reduce((total, id) => total + customerLedger.balance(t.db, id), 0)
  const gl = ledger.accountBalance(t.db, ACC.RECEIVABLE)

  expect(gl, 'GL Accounts Receivable has drifted from the summed customer balances').toBe(summed)
}

function everythingHolds(t: TestDb): void {
  assertBooksBalance(t)
  assertReceivableReconciles(t)
}

// ═════════════════════════════════════════════════════════════════════════════
// Fixtures
// ═════════════════════════════════════════════════════════════════════════════

const PRICE = 20_000 // Rs 200, a tax-exempt item — so gross === price × pcs and the arithmetic is plain

let t: TestDb
let owner: User
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
const bank = (): number => lookupId('payment_method', 'bank')
const credit = (): number => lookupId('payment_method', 'credit')

function makeProduct(price = PRICE): number {
  const now = new Date().toISOString()
  return Number(
    t.db
      .prepare(
        `INSERT INTO products
           (sku, name, sale_uom_id, cost_price, retail_price, wholesale_price, tax_rate_bp,
            price_entry_mode, is_tax_exempt, item_type, is_weighted, track_batches, track_serials,
            is_active, created_at, updated_at)
         VALUES (@sku, 'Item', @uomId, 0, @price, 0, 0, 'exclusive', 1, 'inventory', 0, 0, 0,
                 1, @now, @now)`
      )
      .run({
        sku: `SKU-${Math.random().toString(36).slice(2, 10)}`,
        uomId: lookupId('uom', 'pcs'),
        price,
        now
      }).lastInsertRowid
  )
}

/** Opening stock through the REAL service, so the books balance from the first line of every test. */
function stockedProduct(price = PRICE, stockPcs = 1000): number {
  const id = makeProduct(price)
  stock.adjust(t.db, owner, {
    productId: id,
    type: 'opening',
    qtyM: stockPcs * ONE_UNIT,
    unitCost: 1_000_000, // Rs 100 at 4-dp cost
    reasonCode: 'data_entry'
  })
  return id
}

function makeCustomer(name: string, creditLimit = 100_000_000): number {
  return customers.create(t.db, owner, { name, creditLimit }).id
}

/** A sale settled ENTIRELY on udhaar — the credit portion equals the whole grand total. */
function creditSale(customerId: number, productId: number, pcs: number, now = new Date()): number {
  const gross = PRICE * pcs // tax-exempt, so gross === price × pcs
  return sales.complete(
    t.db,
    cashier,
    {
      lines: [{ productId, qtyM: pcs * ONE_UNIT }],
      customerId,
      payments: [{ methodLookupId: credit(), amount: gross }]
    },
    now
  ).sale.id
}

/** DR RECEIVABLE / CR Opening Balance Equity — exactly what opening.commit posts for opening udhaar. */
function giveOpeningUdhaar(customerId: number, amount: number, note = 'old paper ledger'): void {
  const at = new Date('2026-01-01T12:00:00')
  t.db
    .prepare(
      'INSERT INTO opening_receivables (customer_id, amount, note, created_at) VALUES (?, ?, ?, ?)'
    )
    .run(customerId, amount, note, at.toISOString())
  ledger.post(t.db, {
    at,
    refType: 'opening',
    refId: 1,
    memo: 'Opening udhaar',
    lines: [
      { account: ACC.RECEIVABLE, debit: amount },
      { account: ACC.OPENING_BALANCE_EQUITY, credit: amount }
    ]
  })
}

beforeEach(() => {
  t = makeTestDb({ withSeed: true })
  owner = makeUser('owner', 'owner', 'Insha Owner')
  cashier = makeUser('cashier', 'cash1', 'Bilal Cashier')
})

afterEach(() => {
  everythingHolds(t)
  t.cleanup()
})

// ═════════════════════════════════════════════════════════════════════════════
// balance(): a credit sale raises it, a payment lowers it, and it is never stored
// ═════════════════════════════════════════════════════════════════════════════

describe('balance', () => {
  it('a credit sale raises the balance; a payment lowers it; it is recomputed, never stored', () => {
    const productId = stockedProduct()
    const customerId = makeCustomer('Rashid')

    expect(customerLedger.balance(t.db, customerId)).toBe(0)

    creditSale(customerId, productId, 1) // Rs 200 on udhaar
    expect(customerLedger.balance(t.db, customerId)).toBe(20_000)

    const payment = customerLedger.recordPayment(t.db, owner, {
      customerId,
      amount: 12_000, // Rs 120 paid back
      methodLookupId: cash()
    })
    expect(customerLedger.balance(t.db, customerId)).toBe(8_000)

    // The payment carries the balanced journal it posted — DR Cash, CR Receivable.
    expect(payment.amount).toBe(12_000)
    expect(payment.journalId).not.toBeNull()

    const journal = t.db
      .prepare(
        `SELECT a.code AS code, l.debit AS debit, l.credit AS credit
           FROM journal_lines l JOIN accounts a ON a.id = l.account_id
          WHERE l.journal_id = ? ORDER BY a.code`
      )
      .all(payment.journalId) as Array<{ code: string; debit: number; credit: number }>
    expect(journal).toEqual([
      { code: ACC.CASH, debit: 12_000, credit: 0 },
      { code: ACC.RECEIVABLE, debit: 0, credit: 12_000 }
    ])

    // NOWHERE IS THE BALANCE STORED. Not on the customer, not on the payment — it is derived from the
    // rows every time (CLAUDE.md §4). Prove it by reading it straight off the tables again.
    for (const table of ['customers', 'customer_payments']) {
      const columns = (
        t.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      ).map((column) => column.name)
      expect(columns, `${table} must not carry a balance column`).not.toContain('balance')
    }

    expect(customerLedger.balance(t.db, customerId)).toBe(20_000 - 12_000)
    everythingHolds(t)
  })

  it('a payment against a bank method debits Bank, not Cash', () => {
    const productId = stockedProduct()
    const customerId = makeCustomer('Rashid')
    creditSale(customerId, productId, 1)

    const payment = customerLedger.recordPayment(t.db, owner, {
      customerId,
      amount: 20_000,
      methodLookupId: bank()
    })

    const debit = t.db
      .prepare(
        `SELECT a.code AS code
           FROM journal_lines l JOIN accounts a ON a.id = l.account_id
          WHERE l.journal_id = ? AND l.debit > 0`
      )
      .pluck()
      .get(payment.journalId) as string
    expect(debit).toBe(ACC.BANK)
    expect(customerLedger.balance(t.db, customerId)).toBe(0)

    everythingHolds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// TRAP #17 — pay from "the other screen" and the balance MUST drop, and reconcile
// ═════════════════════════════════════════════════════════════════════════════

describe('trap #17: paid from the ledger screen', () => {
  it('a payment recorded from the customer-ledger screen drops the balance and stays reconciled', () => {
    const productId = stockedProduct()
    const customerId = makeCustomer('Muhammad Rashid')

    // The udhaar was rung up on the SELL screen.
    creditSale(customerId, productId, 3) // Rs 600 on udhaar
    const before = customerLedger.balance(t.db, customerId)
    expect(before).toBe(60_000)

    // ...and paid down from the LEDGER screen — the "other screen" that once never told the first.
    customerLedger.recordPayment(t.db, owner, {
      customerId,
      amount: 45_000, // Rs 450
      methodLookupId: cash()
    })

    // 1. THE BALANCE DROPPED — by exactly what was paid.
    const after = customerLedger.balance(t.db, customerId)
    expect(after).toBe(15_000)
    expect(after).toBeLessThan(before)

    // 2. THE TRIAL BALANCE STILL BALANCES.
    expect(ledger.trialBalance(t.db).balanced).toBe(true)

    // 3. GL ACCOUNTS RECEIVABLE MATCHES the summed customer balances — to the paisa.
    expect(ledger.accountBalance(t.db, ACC.RECEIVABLE)).toBe(15_000)
    expect(ledger.accountBalance(t.db, ACC.RECEIVABLE)).toBe(customerLedger.balance(t.db, customerId))

    // And the SELL screen's own credit-limit check sees the lower figure too — one source of truth.
    expect(sales.outstandingCredit(t.db, customerId)).toBe(15_000)

    everythingHolds(t)
  })

  it('the credit-limit check on the sell screen honours a payment made on the ledger screen', () => {
    const productId = stockedProduct()
    const customerId = makeCustomer('Rashid', 60_000) // Rs 600 limit

    creditSale(customerId, productId, 3) // Rs 600 — right at the limit

    // At the limit, another rupee of udhaar is refused...
    expectUserMessage(
      () => creditSale(customerId, productId, 1),
      /over their (credit )?limit|already owes/i
    )

    // ...but once Rs 400 is paid on the ledger screen, there is room again, and the sale goes through.
    customerLedger.recordPayment(t.db, owner, {
      customerId,
      amount: 40_000,
      methodLookupId: cash()
    })
    const saleId = creditSale(customerId, productId, 1)
    expect(saleId).toBeGreaterThan(0)
    expect(customerLedger.balance(t.db, customerId)).toBe(60_000 - 40_000 + 20_000)

    everythingHolds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// ledger(): a running statement, correct at every row, that ends on balance()
// ═════════════════════════════════════════════════════════════════════════════

describe('ledger statement', () => {
  it('opening udhaar + a credit sale + two partial payments: the running balance is right at every row', () => {
    const productId = stockedProduct()
    const customerId = makeCustomer('Rashid')

    giveOpeningUdhaar(customerId, 50_000) // Rs 500, dated 2026-01-01 — the oldest thing on the account
    creditSale(customerId, productId, 2, new Date('2026-02-01T10:00:00')) // Rs 400 on udhaar
    customerLedger.recordPayment(
      t.db,
      owner,
      { customerId, amount: 30_000, methodLookupId: cash() },
      new Date('2026-03-01T10:00:00')
    )
    customerLedger.recordPayment(
      t.db,
      owner,
      { customerId, amount: 25_000, methodLookupId: bank() },
      new Date('2026-04-01T10:00:00')
    )

    const page = customerLedger.ledger(t.db, { customerId })

    expect(page.total).toBe(4)
    expect(page.rows.map((row) => row.kind)).toEqual(['opening', 'sale', 'payment', 'payment'])

    // Oldest-first, like a bank statement, with the running balance down the right-hand column.
    expect(page.rows.map((row) => row.charge)).toEqual([50_000, 40_000, 0, 0])
    expect(page.rows.map((row) => row.payment)).toEqual([0, 0, 30_000, 25_000])
    expect(page.rows.map((row) => row.balanceAfter)).toEqual([50_000, 90_000, 60_000, 35_000])

    // The statement ends EXACTLY on what the customer owes now.
    expect(page.rows.at(-1)!.balanceAfter).toBe(customerLedger.balance(t.db, customerId))
    expect(page.balance).toBe(35_000)
    expect(page.balance).toBe(50_000 + 40_000 - 30_000 - 25_000)

    // The opening row reads plainly, and the sale row carries its invoice number.
    expect(page.rows[0]!.description).toMatch(/Opening balance/)
    const sale = sales.getById(t.db, page.rows[1]!.refId)
    expect(page.rows[1]!.description).toBe(sale.invoiceNo)

    everythingHolds(t)
  })

  it('a partial-credit sale puts ONLY the udhaar portion on the statement, not the whole total', () => {
    const productId = stockedProduct()
    const customerId = makeCustomer('Rashid')
    const gross = PRICE * 3 // Rs 600

    // Rs 250 in cash at the till, Rs 350 on udhaar — a split payment.
    sales.complete(t.db, cashier, {
      lines: [{ productId, qtyM: 3 * ONE_UNIT }],
      customerId,
      payments: [
        { methodLookupId: cash(), amount: 25_000 },
        { methodLookupId: credit(), amount: gross - 25_000 }
      ]
    })

    const page = customerLedger.ledger(t.db, { customerId })
    expect(page.total).toBe(1)
    expect(page.rows[0]!.kind).toBe('sale')
    // The cash the customer handed over never touched their account — only the Rs 350 udhaar did.
    expect(page.rows[0]!.charge).toBe(35_000)
    expect(page.rows[0]!.balanceAfter).toBe(35_000)
    expect(customerLedger.balance(t.db, customerId)).toBe(35_000)

    everythingHolds(t)
  })

  it('the credit limit rides on the statement, for the over-limit warning', () => {
    const customerId = makeCustomer('Rashid', 75_000)
    const page = customerLedger.ledger(t.db, { customerId })

    expect(page.creditLimit).toBe(75_000)
    expect(page.balance).toBe(0)
    expect(page.rows).toEqual([])

    everythingHolds(t)
  })

  it('an unknown customer is a plain sentence, never a blank statement', () => {
    expectUserMessage(
      () => customerLedger.ledger(t.db, { customerId: 9999 }),
      /customer could not be found/i
    )
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// An overpayment leaves a negative balance — the shop owes the customer
// ═════════════════════════════════════════════════════════════════════════════

describe('overpayment', () => {
  it('a customer may pay more than they owe, going into credit; the balance goes negative and still balances', () => {
    const productId = stockedProduct()
    const customerId = makeCustomer('Rashid')

    creditSale(customerId, productId, 1) // owes Rs 200
    customerLedger.recordPayment(t.db, owner, {
      customerId,
      amount: 30_000, // pays Rs 300 — Rs 100 more than owed
      methodLookupId: cash()
    })

    // The shop now owes the customer Rs 100. That is allowed, and it is honestly negative.
    expect(customerLedger.balance(t.db, customerId)).toBe(-10_000)

    // GL Receivable is a credit balance of Rs 100 (a debit-natured account gone negative), and the two
    // still agree exactly.
    expect(ledger.accountBalance(t.db, ACC.RECEIVABLE)).toBe(-10_000)

    // The statement's running balance dips below zero and says so.
    const page = customerLedger.ledger(t.db, { customerId })
    expect(page.rows.map((row) => row.balanceAfter)).toEqual([20_000, -10_000])
    expect(page.balance).toBe(-10_000)

    everythingHolds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// The statement is paginated
// ═════════════════════════════════════════════════════════════════════════════

describe('pagination', () => {
  it('honours page and pageSize, reports the true total, and the running balance is continuous across pages', () => {
    const productId = stockedProduct()
    const customerId = makeCustomer('Rashid')

    giveOpeningUdhaar(customerId, 100_000) // 1 opening row
    creditSale(customerId, productId, 2, new Date('2026-02-01T10:00:00')) // 1 sale row
    for (let i = 0; i < 10; i += 1) {
      customerLedger.recordPayment(
        t.db,
        owner,
        { customerId, amount: 5_000, methodLookupId: cash() },
        new Date(`2026-03-${String(i + 1).padStart(2, '0')}T10:00:00`)
      )
    }
    // 1 + 1 + 10 = 12 statement lines.

    const p1 = customerLedger.ledger(t.db, { customerId, page: 1, pageSize: 5 })
    const p2 = customerLedger.ledger(t.db, { customerId, page: 2, pageSize: 5 })
    const p3 = customerLedger.ledger(t.db, { customerId, page: 3, pageSize: 5 })

    // The total is the whole statement, on every page. The pages themselves are 5 / 5 / 2.
    for (const page of [p1, p2, p3]) expect(page.total).toBe(12)
    expect(p1.rows).toHaveLength(5)
    expect(p2.rows).toHaveLength(5)
    expect(p3.rows).toHaveLength(2)

    // A page past the end is empty — never an unbounded read (CLAUDE.md §4).
    expect(customerLedger.ledger(t.db, { customerId, page: 99, pageSize: 5 }).rows).toEqual([])

    // Stitched back together, the paged statement is the whole statement — same rows, same running
    // balance, no row dropped or double-counted at a page seam.
    const whole = customerLedger.ledger(t.db, { customerId, pageSize: 200 })
    expect(whole.rows).toHaveLength(12)
    expect([...p1.rows, ...p2.rows, ...p3.rows]).toEqual(whole.rows)

    // The running balance is continuous: page 2 picks up exactly where page 1 left off.
    expect(p2.rows[0]!.balanceAfter).toBe(p1.rows[4]!.balanceAfter - 5_000)
    // 100,000 opening + 40,000 sale − (10 × 5,000) = 90,000.
    expect(whole.rows.at(-1)!.balanceAfter).toBe(90_000)
    expect(whole.balance).toBe(90_000)

    everythingHolds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// recordPayment guards
// ═════════════════════════════════════════════════════════════════════════════

describe('recordPayment guards', () => {
  it('refuses a zero or negative payment — that would be a fresh charge, not a payment', () => {
    const customerId = makeCustomer('Rashid')

    expectUserMessage(
      () => customerLedger.recordPayment(t.db, owner, { customerId, amount: 0, methodLookupId: cash() }),
      /greater than zero/i
    )
    expectUserMessage(
      () =>
        customerLedger.recordPayment(t.db, owner, { customerId, amount: -500, methodLookupId: cash() }),
      /greater than zero/i
    )
  })

  it('refuses to pay udhaar with more udhaar (method = credit)', () => {
    const customerId = makeCustomer('Rashid')

    expectUserMessage(
      () =>
        customerLedger.recordPayment(t.db, owner, {
          customerId,
          amount: 10_000,
          methodLookupId: credit()
        }),
      /cannot pay their udhaar with more udhaar/i
    )
  })

  it('refuses a payment method that is not on the owner’s list', () => {
    const customerId = makeCustomer('Rashid')

    expectUserMessage(
      () =>
        customerLedger.recordPayment(t.db, owner, {
          customerId,
          amount: 10_000,
          methodLookupId: 99_999
        }),
      /choose how the customer is paying/i
    )
  })

  it('refuses a payment against a customer who does not exist', () => {
    expectUserMessage(
      () =>
        customerLedger.recordPayment(t.db, owner, {
          customerId: 9999,
          amount: 10_000,
          methodLookupId: cash()
        }),
      /customer could not be found/i
    )
  })

  it('lets a RETIRED customer settle an old debt', () => {
    const productId = stockedProduct()
    const customerId = makeCustomer('Rashid')
    creditSale(customerId, productId, 1) // owes Rs 200
    customers.deactivate(t.db, owner, customerId)

    // Deactivating retired them from the pick list — it did not tear up what they owe.
    const payment = customerLedger.recordPayment(t.db, owner, {
      customerId,
      amount: 20_000,
      methodLookupId: cash()
    })
    expect(payment.amount).toBe(20_000)
    expect(customerLedger.balance(t.db, customerId)).toBe(0)

    everythingHolds(t)
  })

  it('records WHO took the payment and WHEN — an audit row', () => {
    const customerId = makeCustomer('Rashid')
    customerLedger.recordPayment(t.db, owner, { customerId, amount: 10_000, methodLookupId: cash() })

    const row = t.db
      .prepare(
        `SELECT user_id, user_name, user_role, entity, entity_id, action
           FROM audit_log WHERE action = 'customer.payment'`
      )
      .get() as Record<string, string | number>

    expect(row['user_id']).toBe(owner.id)
    expect(row['user_name']).toBe('Insha Owner')
    expect(row['user_role']).toBe('owner')
    expect(row['entity']).toBe('customer')
    expect(row['entity_id']).toBe(String(customerId))

    everythingHolds(t)
  })

  it('a split settlement is two calls, one per method — each its own row and journal', () => {
    const productId = stockedProduct()
    const customerId = makeCustomer('Rashid')
    creditSale(customerId, productId, 3) // owes Rs 600

    customerLedger.recordPayment(t.db, owner, { customerId, amount: 20_000, methodLookupId: cash() })
    customerLedger.recordPayment(t.db, owner, { customerId, amount: 15_000, methodLookupId: bank() })

    expect(customerLedger.balance(t.db, customerId)).toBe(25_000)
    const page = customerLedger.ledger(t.db, { customerId })
    expect(page.rows.filter((row) => row.kind === 'payment')).toHaveLength(2)

    everythingHolds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// listWithBalances — the Customers screen, each row with its balance, paginated
// ═════════════════════════════════════════════════════════════════════════════

describe('listWithBalances', () => {
  it('carries each customer’s current balance, and is paginated', () => {
    const productId = stockedProduct()
    const rashid = makeCustomer('Rashid')
    const ali = makeCustomer('Ali')
    const zubair = makeCustomer('Zubair') // owes nothing

    creditSale(rashid, productId, 2) // Rs 400
    creditSale(ali, productId, 1) // Rs 200
    customerLedger.recordPayment(t.db, owner, { customerId: ali, amount: 5_000, methodLookupId: cash() })

    const listed = customerLedger.listWithBalances(t.db)
    const byId = new Map(listed.rows.map((row) => [row.id, row.balance]))

    expect(byId.get(rashid)).toBe(40_000)
    expect(byId.get(ali)).toBe(15_000) // Rs 200 − Rs 50
    expect(byId.get(zubair)).toBe(0)

    // Paginated, exactly like customers.list — assume 100k rows (CLAUDE.md §4).
    for (let i = 0; i < 20; i += 1) makeCustomer(`Filler ${String(i).padStart(2, '0')}`)
    const firstPage = customerLedger.listWithBalances(t.db, { pageSize: 10 })
    expect(firstPage.total).toBe(23)
    expect(firstPage.rows).toHaveLength(10)
    expect(firstPage.rows.every((row) => typeof row.balance === 'number')).toBe(true)

    everythingHolds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// The extended customer profile (migration 0009): business/tax/notes/price-tier
// ═════════════════════════════════════════════════════════════════════════════

describe('extended customer profile', () => {
  it('create and read back the business name, tax number, notes and default price tier', () => {
    const customer = customers.create(t.db, owner, {
      name: 'Rashid Traders',
      phone: '0300-1234567',
      businessName: 'Rashid & Sons',
      taxNumber: '1234567-8',
      notes: 'Buys cooking oil by the carton',
      priceTier: 'wholesale'
    })

    const read = customers.getById(t.db, customer.id)
    expect(read.businessName).toBe('Rashid & Sons')
    expect(read.taxNumber).toBe('1234567-8')
    expect(read.notes).toBe('Buys cooking oil by the carton')
    expect(read.priceTier).toBe('wholesale')

    // Still no balance anywhere near this object (CLAUDE.md §4).
    expect(read).not.toHaveProperty('balance')
  })

  it('a walk-in leaves the new fields null — they are optional', () => {
    const customer = customers.create(t.db, owner, { name: 'Walk-in' })
    const read = customers.getById(t.db, customer.id)

    expect(read.businessName).toBeNull()
    expect(read.taxNumber).toBeNull()
    expect(read.notes).toBeNull()
    expect(read.priceTier).toBeNull()
  })

  it('an edit writes ONLY the fields the form sent — the others are not wiped (trap #18)', () => {
    const created = customers.create(t.db, owner, {
      name: 'Rashid',
      businessName: 'Rashid & Sons',
      taxNumber: '1234567-8',
      notes: 'VIP',
      priceTier: 'wholesale'
    })

    // The "fix the tax number" dialog. It never loaded the business name, the notes or the tier.
    const updated = customers.update(t.db, owner, { id: created.id, taxNumber: '9999999-0' })

    expect(updated.taxNumber).toBe('9999999-0')
    expect(updated.businessName).toBe('Rashid & Sons') // NOT wiped
    expect(updated.notes).toBe('VIP') // NOT wiped
    expect(updated.priceTier).toBe('wholesale') // NOT wiped
  })

  it('null clears a field; a bad price tier is refused', () => {
    const created = customers.create(t.db, owner, {
      name: 'Rashid',
      businessName: 'Rashid & Sons',
      priceTier: 'wholesale'
    })

    const cleared = customers.update(t.db, owner, { id: created.id, priceTier: null, notes: null })
    expect(cleared.priceTier).toBeNull()

    // 'customer' is NOT a stored default tier (it means "use their own prices", a choice made at the
    // till), and neither is anything the renderer might invent.
    expectUserMessage(
      () => customers.update(t.db, owner, { id: created.id, priceTier: 'gold' as never }),
      /./
    )
    expectUserMessage(
      () => customers.create(t.db, owner, { name: 'X', priceTier: 'customer' as never }),
      /./
    )
  })
})
