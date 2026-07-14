import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, type TestDb } from '../db/testkit'
import * as ledger from './ledger'
import { ACC } from '../db/chart-of-accounts'

describe('SKEPTIC: does the footer equal the column above it?', () => {
  let t: TestDb
  beforeEach(() => (t = makeTestDb({ withSeed: true })))
  afterEach(() => t.cleanup())

  it('opening + rent', () => {
    ledger.post(t.db, {
      refType: 'opening', memo: 'Opening',
      lines: [
        { account: ACC.CASH, debit: 100_000 },
        { account: ACC.OPENING_BALANCE_EQUITY, credit: 100_000 }
      ]
    })
    ledger.post(t.db, {
      refType: 'expense', memo: 'Rent',
      lines: [
        { account: '5200', debit: 30_000 },
        { account: ACC.CASH, credit: 30_000 }
      ]
    })

    const tb = ledger.trialBalance(t.db)
    const colDebit = tb.rows.reduce((s, r) => s + r.debit, 0)
    const colCredit = tb.rows.reduce((s, r) => s + r.credit, 0)

    console.log('ROWS:', JSON.stringify(tb.rows, null, 1))
    console.log('COLUMN SUM debit =', colDebit, ' credit =', colCredit)
    console.log('FOOTER          =', tb.totalDebit, '        ', tb.totalCredit)
    console.log('GAP             =', tb.totalDebit - colDebit)
    expect(colDebit).toBe(tb.totalDebit) // does the printed footer match the printed column?
  })

  it('a fully-settled receivable: a blank row that still inflates the total', () => {
    ledger.post(t.db, {
      refType: 'sale', memo: 'udhaar',
      lines: [
        { account: ACC.RECEIVABLE, debit: 11_700 },
        { account: ACC.SALES, credit: 11_700 }
      ]
    })
    ledger.post(t.db, {
      refType: 'customer_payment', memo: 'Ali paid',
      lines: [
        { account: ACC.CASH, debit: 11_700 },
        { account: ACC.RECEIVABLE, credit: 11_700 }
      ]
    })
    const tb = ledger.trialBalance(t.db)
    console.log('ROWS:', JSON.stringify(tb.rows))
    console.log('COLUMN SUM debit =', tb.rows.reduce((s, r) => s + r.debit, 0))
    console.log('FOOTER totalDebit =', tb.totalDebit)
  })
})
