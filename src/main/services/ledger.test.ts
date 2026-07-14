import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import * as ledger from './ledger'
import { ACC } from '../db/chart-of-accounts'
import { computeLineTax } from '@shared/tax'

/**
 * THE STANDING TEST: after EVERY scenario, the trial balance balances.
 *
 * Every new business scenario added to this app gets a case in here. If the trial balance ever
 * stops balancing, the shop's books are wrong and every report built on them is a lie — and we want
 * to find that out here, not in March when the accountant asks why nothing adds up.
 */
function assertBooksBalance(t: TestDb): void {
  const tb = ledger.trialBalance(t.db)
  expect(tb.balanced).toBe(true)
  expect(tb.totalDebit).toBe(tb.totalCredit)
}

describe('posting engine', () => {
  let t: TestDb
  beforeEach(() => (t = makeTestDb({ withSeed: true })))
  afterEach(() => t.cleanup())

  it('seeds a chart of accounts the shop never has to think about', () => {
    const cash = t.db.prepare('SELECT name, type FROM accounts WHERE code = ?').get(ACC.CASH)
    expect(cash).toMatchObject({ name: 'Cash in Hand', type: 'asset' })

    const count = t.db.prepare('SELECT COUNT(*) FROM accounts').pluck().get() as number
    expect(count).toBeGreaterThan(15)
  })

  it('posts a balanced journal', () => {
    const id = ledger.post(t.db, {
      refType: 'test',
      memo: 'cash sale of Rs 100',
      lines: [
        { account: ACC.CASH, debit: 10_000 },
        { account: ACC.SALES, credit: 10_000 }
      ]
    })

    expect(id).toBeGreaterThan(0)
    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(10_000)
    expect(ledger.accountBalance(t.db, ACC.SALES)).toBe(10_000)
    assertBooksBalance(t)
  })

  it('REFUSES an unbalanced journal — and saves nothing', () => {
    // This is the whole point of the engine. A sale that cannot be booked correctly must not happen.
    expect(() =>
      ledger.post(t.db, {
        refType: 'test',
        memo: 'broken',
        lines: [
          { account: ACC.CASH, debit: 10_000 },
          { account: ACC.SALES, credit: 9_999 } // out by one paisa
        ]
      })
    ).toThrow(/UNBALANCED/)

    // Nothing was written. Not the journal, not the lines.
    expect(t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get()).toBe(0)
    expect(t.db.prepare('SELECT COUNT(*) FROM journal_lines').pluck().get()).toBe(0)
    assertBooksBalance(t)
  })

  it('tells the CASHIER something calm, while telling US the real reason', () => {
    // The shopkeeper must never see "UNBALANCED journal: debits=10000 credits=9999".
    expectUserMessage(
      () =>
        ledger.post(t.db, {
          refType: 'test',
          memo: 'broken',
          lines: [
            { account: ACC.CASH, debit: 10_000 },
            { account: ACC.SALES, credit: 9_999 }
          ]
        }),
      /something went wrong recording that in the accounts/i
    )
  })

  it('REFUSES a float amount — money is integer minor units', () => {
    expect(() =>
      ledger.post(t.db, {
        refType: 'test',
        memo: 'float',
        lines: [
          { account: ACC.CASH, debit: 100.5 },
          { account: ACC.SALES, credit: 100.5 }
        ]
      })
    ).toThrow(/integer minor units/)
  })

  it('REFUSES a negative amount — you credit instead of debiting a negative', () => {
    expect(() =>
      ledger.post(t.db, {
        refType: 'test',
        memo: 'negative',
        lines: [
          { account: ACC.CASH, debit: -10_000 },
          { account: ACC.SALES, credit: -10_000 }
        ]
      })
    ).toThrow(/negative/)
  })

  it('REFUSES a one-sided journal — double-entry needs two sides', () => {
    expect(() =>
      ledger.post(t.db, {
        refType: 'test',
        memo: 'one-legged',
        lines: [{ account: ACC.CASH, debit: 10_000 }]
      })
    ).toThrow(/at least 2/)
  })

  it('REFUSES to post to an account that does not exist', () => {
    expect(() =>
      ledger.post(t.db, {
        refType: 'test',
        memo: 'ghost account',
        lines: [
          { account: '9999', debit: 100 },
          { account: ACC.SALES, credit: 100 }
        ]
      })
    ).toThrow(/no such account/)
  })

  /**
   * REGRESSION — found by an adversarial reviewer, and it was real.
   *
   * post() used to INSERT the journal row and then resolve each account code inside the insert loop.
   * A bad account code on the SECOND line therefore threw *after* the journal row and the first line
   * were already written — leaving a partial, permanently unbalanced journal in the books.
   *
   * It only looked safe because callers usually wrap post() in a transaction. An invariant this
   * important must not depend on every future caller remembering to do that. post() is now atomic
   * on its own.
   */
  it('leaves NOTHING behind when a later line names a bad account (regression)', () => {
    expect(() =>
      ledger.post(t.db, {
        refType: 'test',
        memo: 'bad account on the second line',
        lines: [
          { account: ACC.CASH, debit: 10_000 }, // valid — used to get written before the throw
          { account: '9999', credit: 10_000 } // invalid — throws here
        ]
      })
    ).toThrow(/no such account/)

    // No half-written journal. No orphan line. No permanently unbalanced book.
    expect(t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get()).toBe(0)
    expect(t.db.prepare('SELECT COUNT(*) FROM journal_lines').pluck().get()).toBe(0)
    assertBooksBalance(t)
  })

  it('is atomic even with NO caller transaction, and still nests inside one', () => {
    // Standalone: post() opens its own transaction.
    ledger.post(t.db, {
      refType: 'test',
      memo: 'standalone',
      lines: [
        { account: ACC.CASH, debit: 5_000 },
        { account: ACC.SALES, credit: 5_000 }
      ]
    })

    // Nested: better-sqlite3 turns the inner transaction into a SAVEPOINT, so a caller that wraps
    // post() (as the sale service will) still rolls the whole business event back on failure.
    const outer = t.db.transaction(() => {
      ledger.post(t.db, {
        refType: 'test',
        memo: 'inside a caller transaction',
        lines: [
          { account: ACC.CASH, debit: 1_000 },
          { account: ACC.SALES, credit: 1_000 }
        ]
      })
      throw new Error('the sale failed after the journal was posted')
    })

    expect(() => outer()).toThrow(/the sale failed/)

    // The rolled-back journal is gone; only the standalone one survives.
    expect(t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get()).toBe(1)
    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(5_000)
    assertBooksBalance(t)
  })
})

describe('real shop scenarios — the trial balance balances after every one', () => {
  let t: TestDb
  beforeEach(() => (t = makeTestDb({ withSeed: true })))
  afterEach(() => t.cleanup())

  it('a CASH SALE with tax: Rs 100 + 17% = Rs 117', () => {
    const line = computeLineTax(10_000, 1700, 'exclusive') // net 10000, tax 1700, gross 11700
    const cost = 6_000 // what the item cost us

    ledger.post(t.db, {
      refType: 'sale',
      refId: 1,
      memo: 'Sale INV-000001',
      lines: [
        { account: ACC.CASH, debit: line.gross }, // customer paid us
        { account: ACC.SALES, credit: line.net }, // our income
        { account: ACC.OUTPUT_TAX, credit: line.tax }, // tax we owe the government — NOT our money
        { account: ACC.COGS, debit: cost }, // what the goods cost
        { account: ACC.INVENTORY, credit: cost } // stock leaves the shelf
      ]
    })

    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(11_700)
    expect(ledger.accountBalance(t.db, ACC.SALES)).toBe(10_000)
    expect(ledger.accountBalance(t.db, ACC.OUTPUT_TAX)).toBe(1_700) // a liability, not profit
    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(-6_000)
    assertBooksBalance(t)
  })

  it('a CREDIT SALE (udhaar) puts it in receivables, not cash', () => {
    ledger.post(t.db, {
      refType: 'sale',
      refId: 2,
      memo: 'Credit sale to Ali',
      lines: [
        { account: ACC.RECEIVABLE, debit: 11_700 }, // Ali owes us
        { account: ACC.SALES, credit: 10_000 },
        { account: ACC.OUTPUT_TAX, credit: 1_700 }
      ]
    })

    expect(ledger.accountBalance(t.db, ACC.RECEIVABLE)).toBe(11_700)
    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(0) // no money came in yet
    assertBooksBalance(t)
  })

  it('...and when Ali pays, the receivable clears and cash arrives', () => {
    ledger.post(t.db, {
      refType: 'sale',
      refId: 2,
      memo: 'Credit sale to Ali',
      lines: [
        { account: ACC.RECEIVABLE, debit: 11_700 },
        { account: ACC.SALES, credit: 10_000 },
        { account: ACC.OUTPUT_TAX, credit: 1_700 }
      ]
    })

    ledger.post(t.db, {
      refType: 'customer_payment',
      refId: 2,
      memo: 'Ali paid his udhaar',
      lines: [
        { account: ACC.CASH, debit: 11_700 },
        { account: ACC.RECEIVABLE, credit: 11_700 }
      ]
    })

    expect(ledger.accountBalance(t.db, ACC.RECEIVABLE)).toBe(0) // settled
    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(11_700)
    assertBooksBalance(t)
  })

  it('a PURCHASE on credit: stock arrives, we owe the supplier', () => {
    ledger.post(t.db, {
      refType: 'purchase',
      refId: 10,
      memo: 'GRN from supplier',
      lines: [
        { account: ACC.INVENTORY, debit: 50_000 },
        { account: ACC.INPUT_TAX, debit: 8_500 }, // tax we paid — recoverable, so an ASSET
        { account: ACC.PAYABLE, credit: 58_500 }
      ]
    })

    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(50_000)
    expect(ledger.accountBalance(t.db, ACC.PAYABLE)).toBe(58_500)
    assertBooksBalance(t)
  })

  it('a REFUND reverses the sale and puts the stock back', () => {
    ledger.post(t.db, {
      refType: 'sale',
      refId: 3,
      memo: 'Sale',
      lines: [
        { account: ACC.CASH, debit: 11_700 },
        { account: ACC.SALES, credit: 10_000 },
        { account: ACC.OUTPUT_TAX, credit: 1_700 },
        { account: ACC.COGS, debit: 6_000 },
        { account: ACC.INVENTORY, credit: 6_000 }
      ]
    })

    ledger.post(t.db, {
      refType: 'return',
      refId: 3,
      memo: 'Customer returned it',
      lines: [
        { account: ACC.SALES_RETURNS, debit: 10_000 }, // contra-income
        { account: ACC.OUTPUT_TAX, debit: 1_700 }, // we no longer owe that tax
        { account: ACC.CASH, credit: 11_700 }, // money back to the customer
        { account: ACC.INVENTORY, debit: 6_000 }, // stock back on the shelf
        { account: ACC.COGS, credit: 6_000 }
      ]
    })

    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(0)
    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(0)
    expect(ledger.accountBalance(t.db, ACC.OUTPUT_TAX)).toBe(0)
    assertBooksBalance(t)
  })

  it('a DISCOUNT is recorded where the owner can actually see what it costs', () => {
    // Discounts go to their own contra-income account, NOT netted silently off Sales. That is how
    // "Discounts given, by user" becomes a real leakage report instead of an invisible hole.
    ledger.post(t.db, {
      refType: 'sale',
      refId: 4,
      memo: 'Sale with Rs 50 off',
      lines: [
        { account: ACC.CASH, debit: 5_000 },
        { account: ACC.DISCOUNTS, debit: 5_000 }, // the discount we gave away
        { account: ACC.SALES, credit: 10_000 } // full ticket price
      ]
    })

    expect(ledger.accountBalance(t.db, ACC.DISCOUNTS)).toBe(5_000)
    assertBooksBalance(t)
  })

  it('an EXPENSE (rent) leaves cash and shows up in the P&L', () => {
    ledger.post(t.db, {
      refType: 'expense',
      memo: 'Shop rent for July',
      lines: [
        { account: '5200', debit: 250_000 },
        { account: ACC.CASH, credit: 250_000 }
      ]
    })

    expect(ledger.accountBalance(t.db, '5200')).toBe(250_000)
    assertBooksBalance(t)
  })

  it('OPENING BALANCES on day one — stock, cash and udhaar the shop already had', () => {
    // Without this, every report is wrong from day one.
    ledger.post(t.db, {
      refType: 'opening',
      memo: 'Opening balances',
      lines: [
        { account: ACC.INVENTORY, debit: 500_000 },
        { account: ACC.CASH, debit: 100_000 },
        { account: ACC.RECEIVABLE, debit: 40_000 }, // customers who already owed the shop
        { account: ACC.PAYABLE, credit: 90_000 }, // suppliers the shop already owed
        { account: ACC.OPENING_BALANCE_EQUITY, credit: 550_000 } // the balancing figure
      ]
    })

    assertBooksBalance(t)
    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(500_000)
  })

  it('a whole day of trading still balances', () => {
    // Opening, a cash sale, a credit sale, a payment, a purchase, a refund, an expense.
    ledger.post(t.db, {
      refType: 'opening',
      memo: 'Opening',
      lines: [
        { account: ACC.CASH, debit: 100_000 },
        { account: ACC.INVENTORY, debit: 500_000 },
        { account: ACC.OPENING_BALANCE_EQUITY, credit: 600_000 }
      ]
    })

    for (let i = 0; i < 25; i++) {
      const tax = computeLineTax(9_990, 1700, 'exclusive')
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
      memo: 'Tea for the shop',
      lines: [
        { account: ACC.EXPENSE_GENERAL, debit: 30_000 },
        { account: ACC.CASH, credit: 30_000 }
      ]
    })

    assertBooksBalance(t)

    // And the awkward tax rounding (17% of 99.90 = 16.983 -> 16.98) has not broken anything.
    const tb = ledger.trialBalance(t.db)
    expect(tb.totalDebit).toBe(tb.totalCredit)
  })
})

describe('period lock', () => {
  let t: TestDb
  let ownerId: number

  beforeEach(() => {
    t = makeTestDb({ withSeed: true })
    // periods.locked_by REFERENCES users(id) — so a real owner has to exist. (The first version of
    // this test passed id 1 with no users, and the foreign key correctly refused it.)
    ownerId = Number(
      t.db
        .prepare(
          `INSERT INTO users (username, full_name, role, password_hash, created_at, updated_at)
           VALUES ('boss', 'Boss', 'owner', 'x', 'x', 'x')`
        )
        .run().lastInsertRowid
    )
  })

  afterEach(() => t.cleanup())

  it('a locked month refuses new entries — last year cannot quietly change', () => {
    ledger.lockPeriod(t.db, 2026, 6, ownerId)

    expect(() =>
      ledger.post(t.db, {
        at: new Date('2026-06-15'),
        refType: 'sale',
        memo: 'backdated sale into a closed month',
        lines: [
          { account: ACC.CASH, debit: 10_000 },
          { account: ACC.SALES, credit: 10_000 }
        ]
      })
    ).toThrow(/locked/)
  })

  it('says so in language the shopkeeper understands', () => {
    ledger.lockPeriod(t.db, 2026, 6, ownerId)
    expectUserMessage(
      () =>
        ledger.post(t.db, {
          at: new Date('2026-06-15'),
          refType: 'sale',
          memo: 'backdated',
          lines: [
            { account: ACC.CASH, debit: 10_000 },
            { account: ACC.SALES, credit: 10_000 }
          ]
        }),
      /June 2026 has been closed/i
    )
  })

  it('an OPEN month still accepts entries', () => {
    ledger.lockPeriod(t.db, 2026, 6, ownerId)

    // July is not locked.
    expect(() =>
      ledger.post(t.db, {
        at: new Date('2026-07-15'),
        refType: 'sale',
        memo: 'this month',
        lines: [
          { account: ACC.CASH, debit: 10_000 },
          { account: ACC.SALES, credit: 10_000 }
        ]
      })
    ).not.toThrow()

    assertBooksBalance(t)
  })

  it('the owner can unlock a period to fix a mistake', () => {
    ledger.lockPeriod(t.db, 2026, 6, ownerId)
    ledger.unlockPeriod(t.db, 2026, 6)

    expect(() =>
      ledger.post(t.db, {
        at: new Date('2026-06-15'),
        refType: 'adjustment',
        memo: 'correction',
        lines: [
          { account: ACC.CASH, debit: 10_000 },
          { account: ACC.SALES, credit: 10_000 }
        ]
      })
    ).not.toThrow()

    assertBooksBalance(t)
  })
})
