import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import * as supplierLedger from './supplier-ledger'
import * as suppliers from './suppliers'
import * as purchases from './purchases'
import * as stock from './stock'
import * as ledger from './ledger'
import { ACC } from '../db/chart-of-accounts'
import { ONE_UNIT } from '@shared/qty'
import type { User } from '@shared/types'

/**
 * THE SUPPLIER LEDGER — what the shop owes a supplier, the statement, and the dues it pays back. The
 * mirror of the customer ledger, reflected: a customer owes the shop, a supplier is owed by it.
 *
 * THREE STANDING ASSERTIONS RUN AFTER EVERY SCENARIO, and they are the whole point:
 *
 *   1. THE TRIAL BALANCE BALANCES.                          (CLAUDE.md §4 — the standing test)
 *   2. GL INVENTORY === SUM(stock_movements.value_minor).   (purchases freeze the value they post)
 *   3. GL ACCOUNTS PAYABLE === the summed supplier balances. The ledger screen and the books can never
 *      disagree — every payable posts CR Payable, every payment posts DR Payable, and `balance()` is
 *      derived from exactly those rows.
 *
 * The third is the guard against THE bug this codebase is strict about (CLAUDE.md trap #17): a payment
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

function assertInventoryReconciles(t: TestDb): void {
  const summed = t.db
    .prepare('SELECT COALESCE(SUM(value_minor), 0) FROM stock_movements')
    .pluck()
    .get() as number
  expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(summed)
}

function assertPayablesReconcile(t: TestDb): void {
  const ids = t.db.prepare('SELECT id FROM suppliers').pluck().all() as number[]
  const summed = ids.reduce((total, id) => total + supplierLedger.balance(t.db, id), 0)
  expect(
    ledger.accountBalance(t.db, ACC.PAYABLE),
    'GL Accounts Payable has drifted from the summed supplier balances'
  ).toBe(summed)
}

function everythingHolds(t: TestDb): void {
  assertBooksBalance(t)
  assertInventoryReconciles(t)
  assertPayablesReconcile(t)
}

// ═════════════════════════════════════════════════════════════════════════════
// Fixtures
// ═════════════════════════════════════════════════════════════════════════════

let t: TestDb
let owner: User
let manager: User

/** 4-dp cost units from rupees. Rs 60 -> 600000. */
const cost = (rupees: number): number => rupees * 10_000

function makeUser(role: User['role'], username: string, fullName: string): User {
  const now = new Date().toISOString()
  const id = Number(
    t.db
      .prepare(
        `INSERT INTO users (username, full_name, role, password_hash, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 'x', 1, ?, ?)`
      )
      .run(username, fullName, role, now, now).lastInsertRowid
  )
  return { id, username, fullName, role, hasPin: false, isActive: true }
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

function makeProduct(): number {
  const now = new Date().toISOString()
  return Number(
    t.db
      .prepare(
        `INSERT INTO products
           (sku, name, sale_uom_id, cost_price, retail_price, wholesale_price, tax_rate_bp,
            price_entry_mode, is_tax_exempt, item_type, is_weighted, track_batches, track_serials,
            is_active, created_at, updated_at)
         VALUES (@sku, 'Item', @uomId, 0, 10000, 0, 0, 'exclusive', 1, 'inventory', 0, 0, 0,
                 1, @now, @now)`
      )
      .run({ sku: `SKU-${Math.random().toString(36).slice(2, 10)}`, uomId: lookupId('uom', 'pcs'), now })
      .lastInsertRowid
  )
}

function makeSupplier(name: string): number {
  return suppliers.create(t.db, manager, { name }).id
}

/** A purchase settled ENTIRELY on account — its whole grand total becomes the payable. `rupees` net. */
function creditPurchase(
  supplierId: number,
  productId: number,
  rupees: number,
  now = new Date(),
  supplierInvoiceNo?: string
): number {
  return purchases.createPurchase(
    t.db,
    manager,
    {
      supplierId,
      ...(supplierInvoiceNo != null ? { supplierInvoiceNo } : {}),
      // 1 unit @ Rs `rupees` — a clean single-line bill of exactly that many rupees.
      lines: [{ productId, qtyM: 1 * ONE_UNIT, unitCost: cost(rupees) }],
      payments: []
    },
    now
  ).id
}

/** DR Opening Balance Equity / CR Payable — exactly what opening.commit posts for a supplier due. */
function giveOpeningPayable(supplierId: number, amount: number, note = 'old paper ledger'): void {
  const at = new Date('2026-01-01T12:00:00')
  t.db
    .prepare(
      'INSERT INTO opening_payables (supplier_id, amount, note, created_at) VALUES (?, ?, ?, ?)'
    )
    .run(supplierId, amount, note, at.toISOString())
  ledger.post(t.db, {
    at,
    refType: 'opening',
    refId: 1,
    memo: 'Opening payable',
    lines: [
      { account: ACC.OPENING_BALANCE_EQUITY, debit: amount },
      { account: ACC.PAYABLE, credit: amount }
    ]
  })
}

beforeEach(() => {
  t = makeTestDb({ withSeed: true })
  owner = makeUser('owner', 'owner', 'Insha Owner')
  manager = makeUser('manager', 'meena', 'Meena Manager')
})

afterEach(() => {
  everythingHolds(t)
  t.cleanup()
})

// ═════════════════════════════════════════════════════════════════════════════
// balance(): a purchase raises it, a payment lowers it, and it is never stored
// ═════════════════════════════════════════════════════════════════════════════

describe('balance', () => {
  it('a credit purchase raises the balance; a payment lowers it; it is recomputed, never stored', () => {
    const productId = makeProduct()
    const supplierId = makeSupplier('Acme')

    expect(supplierLedger.balance(t.db, supplierId)).toBe(0)

    creditPurchase(supplierId, productId, 200) // owe Rs 200
    expect(supplierLedger.balance(t.db, supplierId)).toBe(20_000)

    const payment = supplierLedger.recordPayment(t.db, owner, {
      supplierId,
      amount: 12_000, // Rs 120 paid back
      methodLookupId: cash()
    })
    expect(supplierLedger.balance(t.db, supplierId)).toBe(8_000)

    // The payment carries the balanced journal it posted — DR Payable, CR Cash.
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
      { code: ACC.CASH, debit: 0, credit: 12_000 },
      { code: ACC.PAYABLE, debit: 12_000, credit: 0 }
    ])

    // NOWHERE IS THE BALANCE STORED. Not on the supplier, not on the payment — it is derived every time.
    for (const table of ['suppliers', 'supplier_payments']) {
      const columns = (
        t.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      ).map((column) => column.name)
      expect(columns, `${table} must not carry a balance column`).not.toContain('balance')
    }

    expect(supplierLedger.balance(t.db, supplierId)).toBe(20_000 - 12_000)
    everythingHolds(t)
  })

  it('a payment against a bank method credits Bank, not Cash', () => {
    const productId = makeProduct()
    const supplierId = makeSupplier('Acme')
    creditPurchase(supplierId, productId, 200)

    const payment = supplierLedger.recordPayment(t.db, owner, {
      supplierId,
      amount: 20_000,
      methodLookupId: bank()
    })

    const credited = t.db
      .prepare(
        `SELECT a.code AS code
           FROM journal_lines l JOIN accounts a ON a.id = l.account_id
          WHERE l.journal_id = ? AND l.credit > 0`
      )
      .pluck()
      .get(payment.journalId) as string
    expect(credited).toBe(ACC.BANK)
    expect(supplierLedger.balance(t.db, supplierId)).toBe(0)

    everythingHolds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// A supplier with an opening payable starts owed exactly that
// ═════════════════════════════════════════════════════════════════════════════

describe('opening payable', () => {
  it('a supplier with an opening balance starts owed that, and it reconciles with the GL', () => {
    const supplierId = makeSupplier('Acme')
    giveOpeningPayable(supplierId, 12_400) // the shop already owed Rs 124 from the old paper ledger

    expect(supplierLedger.balance(t.db, supplierId)).toBe(12_400)
    expect(ledger.accountBalance(t.db, ACC.PAYABLE)).toBe(12_400)

    everythingHolds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// TRAP #17 — pay a supplier and the balance MUST drop, and GL Payables with it
// ═════════════════════════════════════════════════════════════════════════════

describe('trap #17: paying a supplier down', () => {
  it('a payment drops the derived balance AND GL Payables by the same paisa', () => {
    const productId = makeProduct()
    const supplierId = makeSupplier('Acme')

    creditPurchase(supplierId, productId, 600) // owe Rs 600
    expect(supplierLedger.balance(t.db, supplierId)).toBe(60_000)
    expect(ledger.accountBalance(t.db, ACC.PAYABLE)).toBe(60_000)

    supplierLedger.recordPayment(t.db, owner, {
      supplierId,
      amount: 45_000, // Rs 450
      methodLookupId: cash()
    })

    // BOTH dropped by exactly Rs 450, and they still agree.
    expect(supplierLedger.balance(t.db, supplierId)).toBe(15_000)
    expect(ledger.accountBalance(t.db, ACC.PAYABLE)).toBe(15_000)

    everythingHolds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// ledger(): a running statement, correct at every row, that ends on balance()
// ═════════════════════════════════════════════════════════════════════════════

describe('ledger statement', () => {
  it('opening payable + a credit purchase + two partial payments: the running balance is right at every row', () => {
    const productId = makeProduct()
    const supplierId = makeSupplier('Acme')

    giveOpeningPayable(supplierId, 50_000) // Rs 500, dated 2026-01-01 — oldest on the account
    creditPurchase(supplierId, productId, 400, new Date('2026-02-01T10:00:00'), 'INV-777') // Rs 400 owed
    supplierLedger.recordPayment(
      t.db,
      owner,
      { supplierId, amount: 30_000, methodLookupId: cash() },
      new Date('2026-03-01T10:00:00')
    )
    supplierLedger.recordPayment(
      t.db,
      owner,
      { supplierId, amount: 25_000, methodLookupId: bank() },
      new Date('2026-04-01T10:00:00')
    )

    const page = supplierLedger.ledger(t.db, { supplierId })

    expect(page.total).toBe(4)
    expect(page.rows.map((row) => row.kind)).toEqual(['opening', 'purchase', 'payment', 'payment'])

    // Oldest-first, like a bank statement, with the running balance down the right-hand column.
    expect(page.rows.map((row) => row.charge)).toEqual([50_000, 40_000, 0, 0])
    expect(page.rows.map((row) => row.payment)).toEqual([0, 0, 30_000, 25_000])
    expect(page.rows.map((row) => row.balanceAfter)).toEqual([50_000, 90_000, 60_000, 35_000])

    // The statement ends EXACTLY on what the shop owes now.
    expect(page.rows.at(-1)!.balanceAfter).toBe(supplierLedger.balance(t.db, supplierId))
    expect(page.balance).toBe(35_000)
    expect(page.balance).toBe(50_000 + 40_000 - 30_000 - 25_000)

    // The opening row reads plainly, and the purchase row carries the supplier's bill number.
    expect(page.rows[0]!.description).toMatch(/Opening balance/)
    expect(page.rows[1]!.description).toBe('Bill INV-777')

    everythingHolds(t)
  })

  it('a part-paid purchase puts ONLY the unpaid portion on the statement, not the whole total', () => {
    const productId = makeProduct()
    const supplierId = makeSupplier('Acme')

    // Rs 250 paid in cash at receipt, Rs 350 left on account — a split purchase.
    purchases.createPurchase(t.db, manager, {
      supplierId,
      lines: [{ productId, qtyM: 1 * ONE_UNIT, unitCost: cost(600) }], // Rs 600 bill
      payments: [{ methodLookupId: cash(), amount: 25_000 }]
    })

    const page = supplierLedger.ledger(t.db, { supplierId })
    expect(page.total).toBe(1)
    expect(page.rows[0]!.kind).toBe('purchase')
    // The cash paid at receipt never touched the account — only the Rs 350 owed did.
    expect(page.rows[0]!.charge).toBe(35_000)
    expect(page.rows[0]!.balanceAfter).toBe(35_000)
    expect(supplierLedger.balance(t.db, supplierId)).toBe(35_000)

    everythingHolds(t)
  })

  it('an unknown supplier is a plain sentence, never a blank statement', () => {
    expectUserMessage(
      () => supplierLedger.ledger(t.db, { supplierId: 9999 }),
      /supplier could not be found/i
    )
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// An overpayment leaves a negative balance — the supplier owes the shop
// ═════════════════════════════════════════════════════════════════════════════

describe('overpayment', () => {
  it('the shop may pay more than it owes; the balance goes negative and still balances', () => {
    const productId = makeProduct()
    const supplierId = makeSupplier('Acme')

    creditPurchase(supplierId, productId, 200) // owe Rs 200
    supplierLedger.recordPayment(t.db, owner, {
      supplierId,
      amount: 30_000, // pay Rs 300 — Rs 100 more than owed (an advance)
      methodLookupId: cash()
    })

    // The supplier now owes the shop Rs 100. That is allowed, and it is honestly negative.
    expect(supplierLedger.balance(t.db, supplierId)).toBe(-10_000)
    // GL Payable is a debit balance of Rs 100 (a credit-natured account gone negative), and the two agree.
    expect(ledger.accountBalance(t.db, ACC.PAYABLE)).toBe(-10_000)

    const page = supplierLedger.ledger(t.db, { supplierId })
    expect(page.rows.map((row) => row.balanceAfter)).toEqual([20_000, -10_000])
    expect(page.balance).toBe(-10_000)

    everythingHolds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// The statement is paginated
// ═════════════════════════════════════════════════════════════════════════════

describe('pagination', () => {
  it('honours page and pageSize, reports the true total, and the running balance is continuous', () => {
    const productId = makeProduct()
    const supplierId = makeSupplier('Acme')

    giveOpeningPayable(supplierId, 100_000) // 1 opening row
    creditPurchase(supplierId, productId, 400, new Date('2026-02-01T10:00:00')) // 1 purchase row
    for (let i = 0; i < 10; i += 1) {
      supplierLedger.recordPayment(
        t.db,
        owner,
        { supplierId, amount: 5_000, methodLookupId: cash() },
        new Date(`2026-03-${String(i + 1).padStart(2, '0')}T10:00:00`)
      )
    }
    // 1 + 1 + 10 = 12 statement lines.

    const p1 = supplierLedger.ledger(t.db, { supplierId, page: 1, pageSize: 5 })
    const p2 = supplierLedger.ledger(t.db, { supplierId, page: 2, pageSize: 5 })
    const p3 = supplierLedger.ledger(t.db, { supplierId, page: 3, pageSize: 5 })

    for (const page of [p1, p2, p3]) expect(page.total).toBe(12)
    expect(p1.rows).toHaveLength(5)
    expect(p2.rows).toHaveLength(5)
    expect(p3.rows).toHaveLength(2)

    // A page past the end is empty — never an unbounded read (CLAUDE.md §4).
    expect(supplierLedger.ledger(t.db, { supplierId, page: 99, pageSize: 5 }).rows).toEqual([])

    // Stitched back together, the paged statement is the whole statement — no row dropped or
    // double-counted at a page seam.
    const whole = supplierLedger.ledger(t.db, { supplierId, pageSize: 200 })
    expect(whole.rows).toHaveLength(12)
    expect([...p1.rows, ...p2.rows, ...p3.rows]).toEqual(whole.rows)

    // The running balance is continuous: page 2 picks up exactly where page 1 left off.
    expect(p2.rows[0]!.balanceAfter).toBe(p1.rows[4]!.balanceAfter - 5_000)
    // 100,000 opening + 40,000 purchase − (10 × 5,000) = 90,000.
    expect(whole.rows.at(-1)!.balanceAfter).toBe(90_000)
    expect(whole.balance).toBe(90_000)

    everythingHolds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// recordPayment guards
// ═════════════════════════════════════════════════════════════════════════════

describe('recordPayment guards', () => {
  it('refuses a zero or negative payment — that would be a fresh bill, not a payment', () => {
    const supplierId = makeSupplier('Acme')

    expectUserMessage(
      () => supplierLedger.recordPayment(t.db, owner, { supplierId, amount: 0, methodLookupId: cash() }),
      /greater than zero/i
    )
    expectUserMessage(
      () =>
        supplierLedger.recordPayment(t.db, owner, { supplierId, amount: -500, methodLookupId: cash() }),
      /greater than zero/i
    )
  })

  it('refuses to pay a supplier "on credit" (method = credit)', () => {
    const supplierId = makeSupplier('Acme')

    expectUserMessage(
      () =>
        supplierLedger.recordPayment(t.db, owner, {
          supplierId,
          amount: 10_000,
          methodLookupId: credit()
        }),
      /not on credit|cash, bank/i
    )
  })

  it('refuses a payment method that is not on the owner’s list', () => {
    const supplierId = makeSupplier('Acme')

    expectUserMessage(
      () =>
        supplierLedger.recordPayment(t.db, owner, {
          supplierId,
          amount: 10_000,
          methodLookupId: 99_999
        }),
      /choose how the supplier is being paid/i
    )
  })

  it('refuses a payment against a supplier who does not exist', () => {
    expectUserMessage(
      () =>
        supplierLedger.recordPayment(t.db, owner, {
          supplierId: 9999,
          amount: 10_000,
          methodLookupId: cash()
        }),
      /supplier could not be found/i
    )
  })

  it('lets a RETIRED supplier be paid off an old debt', () => {
    const productId = makeProduct()
    const supplierId = makeSupplier('Acme')
    creditPurchase(supplierId, productId, 200) // owe Rs 200
    suppliers.deactivate(t.db, manager, supplierId)

    // Deactivating retired them from the pick list — it did not tear up what the shop owes them.
    const payment = supplierLedger.recordPayment(t.db, owner, {
      supplierId,
      amount: 20_000,
      methodLookupId: cash()
    })
    expect(payment.amount).toBe(20_000)
    expect(supplierLedger.balance(t.db, supplierId)).toBe(0)

    everythingHolds(t)
  })

  it('records WHO paid and WHEN — an audit row', () => {
    const supplierId = makeSupplier('Acme')
    supplierLedger.recordPayment(t.db, owner, { supplierId, amount: 10_000, methodLookupId: cash() })

    const row = t.db
      .prepare(
        `SELECT user_id, user_name, user_role, entity, entity_id, action
           FROM audit_log WHERE action = 'supplier.payment'`
      )
      .get() as Record<string, string | number>

    expect(row['user_id']).toBe(owner.id)
    expect(row['user_name']).toBe('Insha Owner')
    expect(row['user_role']).toBe('owner')
    expect(row['entity']).toBe('supplier')
    expect(row['entity_id']).toBe(String(supplierId))

    everythingHolds(t)
  })

  it('a split settlement is two calls, one per method — each its own row and journal', () => {
    const productId = makeProduct()
    const supplierId = makeSupplier('Acme')
    creditPurchase(supplierId, productId, 600) // owe Rs 600

    supplierLedger.recordPayment(t.db, owner, { supplierId, amount: 20_000, methodLookupId: cash() })
    supplierLedger.recordPayment(t.db, owner, { supplierId, amount: 15_000, methodLookupId: bank() })

    expect(supplierLedger.balance(t.db, supplierId)).toBe(25_000)
    const page = supplierLedger.ledger(t.db, { supplierId })
    expect(page.rows.filter((row) => row.kind === 'payment')).toHaveLength(2)

    everythingHolds(t)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// listWithBalances — the Suppliers screen, each row with its balance, paginated
// ═════════════════════════════════════════════════════════════════════════════

describe('listWithBalances', () => {
  it('carries each supplier’s current balance, and is paginated', () => {
    const productId = makeProduct()
    const acme = makeSupplier('Acme')
    const beta = makeSupplier('Beta')
    const gamma = makeSupplier('Gamma') // owed nothing

    creditPurchase(acme, productId, 400) // owe Rs 400
    creditPurchase(beta, productId, 200) // owe Rs 200
    supplierLedger.recordPayment(t.db, owner, { supplierId: beta, amount: 5_000, methodLookupId: cash() })

    const listed = supplierLedger.listWithBalances(t.db)
    const byId = new Map(listed.rows.map((row) => [row.id, row.balance]))

    expect(byId.get(acme)).toBe(40_000)
    expect(byId.get(beta)).toBe(15_000) // Rs 200 − Rs 50
    expect(byId.get(gamma)).toBe(0)

    // Paginated, exactly like suppliers.list — assume 100k rows (CLAUDE.md §4).
    for (let i = 0; i < 20; i += 1) makeSupplier(`Filler ${String(i).padStart(2, '0')}`)
    const firstPage = supplierLedger.listWithBalances(t.db, { pageSize: 10 })
    expect(firstPage.total).toBe(23)
    expect(firstPage.rows).toHaveLength(10)
    expect(firstPage.rows.every((row) => typeof row.balance === 'number')).toBe(true)

    everythingHolds(t)
  })
})
