import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { hashSecret } from '../security/password'
import { makeTestDb, type TestDb } from '../db/testkit'
import * as customerLedger from './customer-ledger'
import * as customers from './customers'
import * as sales from './sales'
import * as stock from './stock'
import * as ledger from './ledger'
import * as settings from './settings'
import { ACC } from '../db/chart-of-accounts'
import { ONE_UNIT } from '@shared/qty'
import type { User } from '@shared/types'

const PRICE = 20_000
let t: TestDb
let owner: User
let cashier: User

function makeUser(role: User['role'], username: string, fullName: string): User {
  const now = new Date().toISOString()
  const id = Number(
    t.db
      .prepare(
        `INSERT INTO users (username, full_name, role, password_hash, pin_hash, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 'x', ?, 1, ?, ?)`
      )
      .run(username, fullName, role, hashSecret('123456'), now, now).lastInsertRowid
  )
  return { id, username, fullName, role, hasPin: true, isActive: true }
}
function lookupId(listKey: string, code: string): number {
  return t.db.prepare('SELECT id FROM lookups WHERE list_key = ? AND code = ?').pluck().get(listKey, code) as number
}
const cash = (): number => lookupId('payment_method', 'cash')
const credit = (): number => lookupId('payment_method', 'credit')
function makeProduct(price = PRICE): number {
  const now = new Date().toISOString()
  return Number(
    t.db
      .prepare(
        `INSERT INTO products (sku, name, sale_uom_id, cost_price, retail_price, wholesale_price, tax_rate_bp,
            price_entry_mode, is_tax_exempt, item_type, is_weighted, track_batches, track_serials, is_active, created_at, updated_at)
         VALUES (@sku, 'Item', @uomId, 0, @price, 0, 0, 'exclusive', 1, 'inventory', 0, 0, 0, 1, @now, @now)`
      )
      .run({ sku: `SKU-${Math.random().toString(36).slice(2, 10)}`, uomId: lookupId('uom', 'pcs'), price, now }).lastInsertRowid
  )
}
function stockedProduct(price = PRICE, stockPcs = 1000): number {
  const id = makeProduct(price)
  stock.adjust(t.db, owner, { productId: id, type: 'opening', qtyM: stockPcs * ONE_UNIT, unitCost: 1_000_000, reasonCode: 'data_entry' })
  return id
}
function makeCustomer(name: string, creditLimit = 100_000_000): number {
  return customers.create(t.db, owner, { name, creditLimit }).id
}
function creditSale(customerId: number | null, productId: number, pcs: number, now = new Date()): number {
  const gross = PRICE * pcs
  return sales.complete(t.db, cashier, {
    lines: [{ productId, qtyM: pcs * ONE_UNIT }],
    ...(customerId != null ? { customerId } : {}),
    payments: [{ methodLookupId: credit(), amount: gross }]
  }, now).sale.id
}
function sumAllBalances(): number {
  const ids = t.db.prepare('SELECT id FROM customers').pluck().all() as number[]
  return ids.reduce((tot, id) => tot + customerLedger.balance(t.db, id), 0)
}

beforeEach(() => {
  t = makeTestDb({ withSeed: true })
  owner = makeUser('owner', 'owner', 'Owner')
  cashier = makeUser('cashier', 'cash1', 'Cashier')
})
afterEach(() => t.cleanup())

describe('AUDIT: voided credit sale', () => {
  it('a voided full credit sale stops counting; GL reconciles', () => {
    const p = stockedProduct()
    const c = makeCustomer('Rashid')
    const saleId = creditSale(c, p, 2) // Rs 400 udhaar
    expect(customerLedger.balance(t.db, c)).toBe(40_000)

    sales.voidSale(t.db, owner, { id: saleId, reasonCode: 'wrong_item' }, null)

    console.log('VOID FULL: balance =', customerLedger.balance(t.db, c), 'GL =', ledger.accountBalance(t.db, ACC.RECEIVABLE), 'sumAll =', sumAllBalances())
    expect(customerLedger.balance(t.db, c)).toBe(0)
    expect(ledger.accountBalance(t.db, ACC.RECEIVABLE)).toBe(sumAllBalances())
    expect(ledger.trialBalance(t.db).balanced).toBe(true)
  })

  it('void AFTER a partial payment: balance and GL both reflect it', () => {
    const p = stockedProduct()
    const c = makeCustomer('Rashid')
    const saleId = creditSale(c, p, 2) // owes Rs 400
    customerLedger.recordPayment(t.db, owner, { customerId: c, amount: 15_000, methodLookupId: cash() }) // pays Rs 150
    expect(customerLedger.balance(t.db, c)).toBe(25_000)

    sales.voidSale(t.db, owner, { id: saleId, reasonCode: 'wrong_item' }, null)

    console.log('VOID AFTER PAY: balance =', customerLedger.balance(t.db, c), 'GL =', ledger.accountBalance(t.db, ACC.RECEIVABLE), 'sumAll =', sumAllBalances())
    expect(ledger.accountBalance(t.db, ACC.RECEIVABLE)).toBe(sumAllBalances())
    expect(ledger.trialBalance(t.db).balanced).toBe(true)
  })
})

describe('AUDIT: big mix reconciles', () => {
  it('opening + credit sales + partial payments + overpayment across two customers', () => {
    const p = stockedProduct()
    const a = makeCustomer('Ali')
    const b = makeCustomer('Bilal')
    t.db.prepare('INSERT INTO opening_receivables (customer_id, amount, note, created_at) VALUES (?,?,?,?)').run(a, 30_000, 'old', new Date('2026-01-01T12:00:00').toISOString())
    ledger.post(t.db, { at: new Date('2026-01-01T12:00:00'), refType: 'opening', refId: 1, memo: 'open', lines: [{ account: ACC.RECEIVABLE, debit: 30_000 }, { account: ACC.OPENING_BALANCE_EQUITY, credit: 30_000 }] })
    creditSale(a, p, 2) // Ali +400 => 700
    creditSale(b, p, 1) // Bilal +200
    customerLedger.recordPayment(t.db, owner, { customerId: a, amount: 20_000, methodLookupId: cash() }) // Ali -200 => 500
    customerLedger.recordPayment(t.db, owner, { customerId: b, amount: 50_000, methodLookupId: cash() }) // Bilal overpays => -300

    console.log('MIX: Ali =', customerLedger.balance(t.db, a), 'Bilal =', customerLedger.balance(t.db, b), 'GL =', ledger.accountBalance(t.db, ACC.RECEIVABLE), 'sumAll =', sumAllBalances())
    expect(ledger.accountBalance(t.db, ACC.RECEIVABLE)).toBe(sumAllBalances())
    expect(ledger.trialBalance(t.db).balanced).toBe(true)
  })
})

describe('AUDIT: anonymous udhaar (requireCustomerForCredit = false)', () => {
  it('a credit sale with NO customer: does GL == sum of every customer balance?', () => {
    settings.set(t.db, 'selling.requireCustomerForCredit', false)
    const p = stockedProduct()
    const c = makeCustomer('Rashid')
    creditSale(c, p, 1) // named: Rs 200
    creditSale(null, p, 3) // ANONYMOUS udhaar: Rs 600, no customer

    const gl = ledger.accountBalance(t.db, ACC.RECEIVABLE)
    const summed = sumAllBalances()
    console.log('ANON: GL =', gl, 'sumAllCustomerBalances =', summed, 'drift =', gl - summed)
    // Report the drift; do not assert.
    expect(ledger.trialBalance(t.db).balanced).toBe(true)
  })
})
