import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, type TestDb } from '../db/testkit'
import * as ledger from './ledger'
import { ACC } from '../db/chart-of-accounts'
import { computeLineTax } from '@shared/tax'

/**
 * SKEPTIC #2. Reproduce EXACTLY what Books.tsx puts on the screen:
 *   body rows  -> row.debit / row.credit      (per-account NET)
 *   footer     -> tb.totalDebit / totalCredit (claimed to be per-account GROSS)
 * If the footer is not the sum of the column above it, the claim is confirmed.
 */
describe('SKEPTIC 2: does the Books.tsx footer equal the column it sits under?', () => {
  let t: TestDb
  beforeEach(() => (t = makeTestDb({ withSeed: true })))
  afterEach(() => t.cleanup())

  it('a real trading day, exactly as the Books screen renders it', () => {
    ledger.post(t.db, {
      refType: 'opening',
      memo: 'Opening',
      lines: [
        { account: ACC.CASH, debit: 100_000 },
        { account: ACC.INVENTORY, debit: 500_000 },
        { account: ACC.OPENING_BALANCE_EQUITY, credit: 600_000 }
      ]
    })

    for (let i = 0; i < 5; i++) {
      const tax = computeLineTax(10_000, 1700, 'exclusive')
      ledger.post(t.db, {
        refType: 'sale',
        refId: i,
        memo: `Sale ${i}`,
        lines: [
          { account: ACC.CASH, debit: tax.gross },
          { account: ACC.SALES, credit: tax.net },
          { account: ACC.OUTPUT_TAX, credit: tax.tax },
          { account: ACC.COGS, debit: 6_000 },
          { account: ACC.INVENTORY, credit: 6_000 }
        ]
      })
    }

    ledger.post(t.db, {
      refType: 'expense',
      memo: 'Shop rent',
      lines: [
        { account: ACC.EXPENSE_GENERAL, debit: 30_000 },
        { account: ACC.CASH, credit: 30_000 }
      ]
    })

    const tb = ledger.trialBalance(t.db)

    // What the <Table.Tbody> actually prints, column by column:
    const columnDebit = tb.rows.reduce((s, r) => s + r.debit, 0)
    const columnCredit = tb.rows.reduce((s, r) => s + r.credit, 0)

    console.log('\n=== what the shopkeeper SEES on the Books screen ===')
    for (const r of tb.rows) {
      console.log(
        `${r.code.padEnd(6)} ${r.name.padEnd(26)} ${String(r.debit || '').padStart(9)} ${String(r.credit || '').padStart(9)}`
      )
    }
    console.log(''.padEnd(60, '-'))
    console.log(
      `${'SUM OF THE COLUMN'.padEnd(33)} ${String(columnDebit).padStart(9)} ${String(columnCredit).padStart(9)}`
    )
    console.log(
      `${'"Total" FOOTER Books.tsx PRINTS'.padEnd(33)} ${String(tb.totalDebit).padStart(9)} ${String(tb.totalCredit).padStart(9)}`
    )
    console.log(`GAP = ${tb.totalDebit - columnDebit} paisa\n`)

    // The badge still says "Balanced" — the footer is self-consistent, just not the column's total.
    expect(tb.balanced).toBe(true)
    expect(columnDebit).toBe(columnCredit)

    // THE CLAIM: the footer does not equal the column above it.
    expect(tb.totalDebit).toBe(columnDebit)
  })
})
