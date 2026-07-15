import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { hashSecret } from '../security/password'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import * as expenses from './expenses'
import * as ledger from './ledger'
import * as reports from './reports'
import { ACC } from '../db/chart-of-accounts'
import type { User } from '@shared/types'

/**
 * THE EXPENSES SERVICE — the shop's money going OUT on non-stock running costs (rent, wages, bills).
 * Each one posts ONE balanced journal: DR <the expense account for its category> CR the tender.
 *
 * THE STANDING ASSERTION RUNS AFTER EVERY SCENARIO (see `holds`), the one this whole codebase rests on:
 *
 *   THE TRIAL BALANCE BALANCES.   (CLAUDE.md §4 — the double-entry engine's standing test)
 *
 * It holds after a booked expense (two equal legs), and it holds after a refusal (nothing posted).
 */

// ═════════════════════════════════════════════════════════════════════════════
// The standing assertion
// ═════════════════════════════════════════════════════════════════════════════

function assertBooksBalance(t: TestDb): void {
  const tb = ledger.trialBalance(t.db)
  expect(tb.balanced, 'THE TRIAL BALANCE DOES NOT BALANCE').toBe(true)
  expect(tb.grossDebit).toBe(tb.grossCredit)
}

function holds(t: TestDb): void {
  assertBooksBalance(t)
}

// ═════════════════════════════════════════════════════════════════════════════
// Fixtures — mirrors the sibling service tests so the files read the same way
// ═════════════════════════════════════════════════════════════════════════════

/** A fixed instant so the P&L and date-range assertions are timezone-independent. */
const NOW = new Date('2026-07-15T10:00:00.000Z')

/** A stored expense dated to `iso` at a fixed UTC instant — deterministic across machines. */
const at = (iso: string): Date => new Date(`${iso}T10:00:00.000Z`)

let t: TestDb
let owner: User

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
const category = (code: string): number => lookupId('expense_category', code)

function addLookup(listKey: string, code: string, label: string): number {
  const now = new Date().toISOString()
  return Number(
    t.db
      .prepare(
        `INSERT INTO lookups (list_key, code, label, sort_order, is_active, is_system, created_at, updated_at)
         VALUES (?, ?, ?, 0, 1, 0, ?, ?)`
      )
      .run(listKey, code, label, now, now).lastInsertRowid
  )
}

const journalCount = (): number => t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get() as number
const expenseCount = (): number => t.db.prepare('SELECT COUNT(*) FROM expenses').pluck().get() as number

beforeEach(() => {
  t = makeTestDb({ withSeed: true })
  owner = makeUser('owner', 'owner', 'Insha Owner')
})

afterEach(() => {
  holds(t)
  t.cleanup()
})

// ═════════════════════════════════════════════════════════════════════════════
// RECORDING — the journal, and where the money goes
// ═════════════════════════════════════════════════════════════════════════════

describe('recording an expense', () => {
  it('posts DR the mapped expense account and CR Cash, and the books balance', () => {
    const detail = expenses.createExpense(
      t.db,
      owner,
      { categoryLookupId: category('rent'), amount: 500_00, methodLookupId: cash() },
      NOW
    )

    // The row came back hydrated with the labels and the user name.
    expect(detail.amount).toBe(500_00)
    expect(detail.categoryLabel).toBe('Rent')
    expect(detail.methodLabel).toBe('Cash')
    expect(detail.userName).toBe('Insha Owner')
    expect(detail.journalId).not.toBeNull()

    // DR Rent (5200), CR Cash — the cost hits the P&L, the money left the drawer.
    expect(ledger.accountBalance(t.db, '5200')).toBe(500_00)
    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(-500_00)

    // Exactly one journal, tagged 'expense' and pointing back at the row.
    const journal = t.db
      .prepare('SELECT ref_type, ref_id FROM journals WHERE id = ?')
      .get(detail.journalId) as { ref_type: string; ref_id: string }
    expect(journal.ref_type).toBe('expense')
    expect(journal.ref_id).toBe(String(detail.id))

    // WHO paid WHAT — the audit log carries it.
    const auditRow = t.db
      .prepare("SELECT action, entity_id FROM audit_log WHERE action = 'expense.create'")
      .get() as { action: string; entity_id: string } | undefined
    expect(auditRow?.entity_id).toBe(String(detail.id))
  })

  it('a bank expense credits Bank, and never touches Cash', () => {
    expenses.createExpense(
      t.db,
      owner,
      { categoryLookupId: category('utilities'), amount: 300_00, methodLookupId: bank() },
      NOW
    )

    expect(ledger.accountBalance(t.db, '5220')).toBe(300_00)
    expect(ledger.accountBalance(t.db, ACC.BANK)).toBe(-300_00)
    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(0)
  })

  it('records the payee and note when given, and leaves them null when not', () => {
    const withDetail = expenses.createExpense(
      t.db,
      owner,
      {
        categoryLookupId: category('salaries'),
        amount: 900_00,
        methodLookupId: bank(),
        payee: 'Staff wages',
        note: 'July'
      },
      NOW
    )
    expect(withDetail.payee).toBe('Staff wages')
    expect(withDetail.note).toBe('July')

    const bare = expenses.createExpense(
      t.db,
      owner,
      { categoryLookupId: category('rent'), amount: 100_00, methodLookupId: cash() },
      NOW
    )
    expect(bare.payee).toBeNull()
    expect(bare.note).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// CATEGORY → EXPENSE ACCOUNT
// ═════════════════════════════════════════════════════════════════════════════

describe('category → expense account mapping', () => {
  it('maps each dedicated category to its own chart account', () => {
    const cases: Array<[string, string]> = [
      ['rent', '5200'],
      ['salaries', '5210'],
      ['utilities', '5220'],
      ['transport', '5230'],
      ['repairs', '5240']
    ]

    for (const [code, account] of cases) {
      const before = ledger.accountBalance(t.db, account)
      expenses.createExpense(
        t.db,
        owner,
        { categoryLookupId: category(code), amount: 10_00, methodLookupId: cash() },
        NOW
      )
      expect(ledger.accountBalance(t.db, account), `${code} should book to ${account}`).toBe(before + 10_00)
    }
  })

  it("a 'misc' expense falls back to General Expenses (5900)", () => {
    expenses.createExpense(
      t.db,
      owner,
      { categoryLookupId: category('misc'), amount: 200_00, methodLookupId: cash() },
      NOW
    )
    expect(ACC.EXPENSE_GENERAL).toBe('5900')
    expect(ledger.accountBalance(t.db, ACC.EXPENSE_GENERAL)).toBe(200_00)
  })

  it('a custom category the owner adds also falls back to General Expenses (5900)', () => {
    const marketing = addLookup('expense_category', 'marketing', 'Marketing')
    expenses.createExpense(
      t.db,
      owner,
      { categoryLookupId: marketing, amount: 150_00, methodLookupId: cash() },
      NOW
    )
    expect(ledger.accountBalance(t.db, ACC.EXPENSE_GENERAL)).toBe(150_00)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// PAID NOW, NOT OWED — the tender must be real money
// ═════════════════════════════════════════════════════════════════════════════

describe('refusing a tender that is not real money', () => {
  it("refuses a 'credit' (receivable) tender — an unpaid bill is not an expense", () => {
    expectUserMessage(
      () =>
        expenses.createExpense(
          t.db,
          owner,
          { categoryLookupId: category('rent'), amount: 100_00, methodLookupId: credit() },
          NOW
        ),
      /real money|cash or bank/i
    )

    // Refused BEFORE anything was written — no half-booked expense, no dangling journal.
    expect(journalCount()).toBe(0)
    expect(expenseCount()).toBe(0)
  })

  it('refuses any custom tender the owner adds that does not resolve to Cash or Bank', () => {
    // A payment method whose CODE the sale mapping does not know maps to Bank (real money) — allowed.
    // The refusal is specifically for a tender that resolves to Receivable/Payable; the only seeded one
    // is 'credit', proven above. Here we prove a wallet method (→ Bank) is accepted, i.e. the whitelist
    // is "Cash or Bank", not "cash only".
    const jazzcash = lookupId('payment_method', 'jazzcash')
    const detail = expenses.createExpense(
      t.db,
      owner,
      { categoryLookupId: category('transport'), amount: 40_00, methodLookupId: jazzcash },
      NOW
    )
    expect(ledger.accountBalance(t.db, ACC.BANK)).toBe(-40_00)
    expect(detail.methodLabel).toBe('JazzCash')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE PROFIT & LOSS REFLECTS THE EXPENSE
// ═════════════════════════════════════════════════════════════════════════════

describe('the profit & loss reflects the expense', () => {
  it('shows the expense on its account line and adds it to total expenses', () => {
    const before = reports.profitAndLoss(t.db, { from: '2026-07-15', to: '2026-07-15' })
    expect(before.totalExpenses).toBe(0)

    expenses.createExpense(
      t.db,
      owner,
      { categoryLookupId: category('rent'), amount: 800_00, methodLookupId: cash() },
      NOW
    )

    const pnl = reports.profitAndLoss(t.db, { from: '2026-07-15', to: '2026-07-15' })
    const rentRow = pnl.expenses.find((row) => row.code === '5200')
    expect(rentRow?.amount).toBe(800_00)
    expect(pnl.totalExpenses).toBe(800_00)
    // No revenue, so net profit is exactly minus the expense — and the identity still ties.
    expect(pnl.netProfit).toBe(pnl.netRevenue - pnl.totalExpenses)

    // ...and it is OUT of a period that does not contain it.
    const otherDay = reports.profitAndLoss(t.db, { from: '2026-07-16', to: '2026-07-16' })
    expect(otherDay.totalExpenses).toBe(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// VALIDATION — amount, and the lookups
// ═════════════════════════════════════════════════════════════════════════════

describe('the amount must be greater than zero', () => {
  it('refuses a zero amount', () => {
    expectUserMessage(
      () =>
        expenses.createExpense(
          t.db,
          owner,
          { categoryLookupId: category('rent'), amount: 0, methodLookupId: cash() },
          NOW
        ),
      /greater than zero/i
    )
    expect(expenseCount()).toBe(0)
  })

  it('refuses a negative amount', () => {
    expectUserMessage(
      () =>
        expenses.createExpense(
          t.db,
          owner,
          { categoryLookupId: category('rent'), amount: -500_00, methodLookupId: cash() },
          NOW
        ),
      /greater than zero/i
    )
    expect(expenseCount()).toBe(0)
  })
})

describe('inactive or wrong-list lookups are refused', () => {
  it('refuses a category id that belongs to a different list', () => {
    expectUserMessage(
      () =>
        expenses.createExpense(
          t.db,
          owner,
          { categoryLookupId: cash(), amount: 100_00, methodLookupId: cash() },
          NOW
        ),
      /what this expense was for/i
    )
    expect(expenseCount()).toBe(0)
  })

  it('refuses a method id that belongs to a different list', () => {
    expectUserMessage(
      () =>
        expenses.createExpense(
          t.db,
          owner,
          { categoryLookupId: category('rent'), amount: 100_00, methodLookupId: category('rent') },
          NOW
        ),
      /how this expense was paid/i
    )
    expect(expenseCount()).toBe(0)
  })

  it('refuses a category the owner has retired', () => {
    t.db
      .prepare("UPDATE lookups SET is_active = 0 WHERE list_key = 'expense_category' AND code = 'rent'")
      .run()

    expectUserMessage(
      () =>
        expenses.createExpense(
          t.db,
          owner,
          { categoryLookupId: category('rent'), amount: 100_00, methodLookupId: cash() },
          NOW
        ),
      /what this expense was for/i
    )
    expect(expenseCount()).toBe(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE LIST — totals over the range, filters, date bounds, pagination
// ═════════════════════════════════════════════════════════════════════════════

describe('listing expenses', () => {
  it('totals the WHOLE filtered range (not just the page) and respects the date bounds', () => {
    expenses.createExpense(
      t.db,
      owner,
      { categoryLookupId: category('rent'), amount: 100_00, methodLookupId: cash() },
      at('2026-07-01')
    )
    expenses.createExpense(
      t.db,
      owner,
      { categoryLookupId: category('utilities'), amount: 200_00, methodLookupId: cash() },
      at('2026-07-15')
    )
    expenses.createExpense(
      t.db,
      owner,
      { categoryLookupId: category('transport'), amount: 300_00, methodLookupId: cash() },
      at('2026-08-01')
    )

    // July only — the August one is out of range.
    const july = expenses.listExpenses(t.db, { from: '2026-07-01', to: '2026-07-31' })
    expect(july.total).toBe(2)
    expect(july.totalMinor).toBe(300_00) // 100 + 200, NOT the August 300
    // Newest first.
    expect(july.rows[0]?.categoryLabel).toBe('Utilities (bills)')
    expect(july.rows[1]?.categoryLabel).toBe('Rent')

    // One page of the same filter: fewer rows, but the range totals are unchanged.
    const paged = expenses.listExpenses(t.db, { from: '2026-07-01', to: '2026-07-31', pageSize: 1 })
    expect(paged.rows.length).toBe(1)
    expect(paged.total).toBe(2)
    expect(paged.totalMinor).toBe(300_00)
  })

  it('includes the whole of the "to" day — an expense paid late in the day is not dropped', () => {
    expenses.createExpense(
      t.db,
      owner,
      { categoryLookupId: category('rent'), amount: 50_00, methodLookupId: cash() },
      new Date('2026-07-31T18:40:00.000Z')
    )

    const sameDay = expenses.listExpenses(t.db, { from: '2026-07-31', to: '2026-07-31' })
    expect(sameDay.total).toBe(1)
    expect(sameDay.totalMinor).toBe(50_00)
  })

  it('filters by category', () => {
    expenses.createExpense(
      t.db,
      owner,
      { categoryLookupId: category('rent'), amount: 100_00, methodLookupId: cash() },
      NOW
    )
    expenses.createExpense(
      t.db,
      owner,
      { categoryLookupId: category('utilities'), amount: 200_00, methodLookupId: cash() },
      NOW
    )

    const onlyRent = expenses.listExpenses(t.db, { categoryLookupId: category('rent') })
    expect(onlyRent.total).toBe(1)
    expect(onlyRent.totalMinor).toBe(100_00)
    expect(onlyRent.rows[0]?.categoryLabel).toBe('Rent')
  })

  it('accepts an at-date STRING on the input and files the expense under that day', () => {
    const detail = expenses.createExpense(
      t.db,
      owner,
      { categoryLookupId: category('rent'), amount: 40_00, methodLookupId: cash(), at: '2026-07-10' },
      NOW
    )

    // Dated to the given day (local noon → same UTC day), so it lands inside the July range.
    const july = expenses.listExpenses(t.db, { from: '2026-07-01', to: '2026-07-31' })
    expect(july.rows.some((row) => row.id === detail.id)).toBe(true)
    expect(july.totalMinor).toBe(40_00)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// GET ONE
// ═════════════════════════════════════════════════════════════════════════════

describe('getting one expense', () => {
  it('returns the row hydrated with its category, method and user labels', () => {
    const created = expenses.createExpense(
      t.db,
      owner,
      {
        categoryLookupId: category('salaries'),
        amount: 900_00,
        methodLookupId: bank(),
        payee: 'Staff',
        note: 'July wages'
      },
      NOW
    )

    const got = expenses.getExpense(t.db, created.id)
    expect(got.id).toBe(created.id)
    expect(got.amount).toBe(900_00)
    expect(got.categoryLabel).toBe('Salaries')
    expect(got.methodLabel).toBe('Bank Transfer')
    expect(got.userName).toBe('Insha Owner')
    expect(got.payee).toBe('Staff')
    expect(got.note).toBe('July wages')
    expect(got.journalId).not.toBeNull()
  })

  it('gives a friendly not-found for an id that does not exist', () => {
    expectUserMessage(() => expenses.getExpense(t.db, 999_999), /could not be found/i)
  })

  // Expenses audit: the date shape alone let 2026-02-30 through, and JS rolled it to March 2 — so an
  // expense typed at the service/LAN boundary would silently land in the wrong P&L month. Now refused.
  it('refuses a calendar-invalid date instead of silently rolling it into the next month', () => {
    expectUserMessage(
      () =>
        expenses.createExpense(
          t.db,
          owner,
          { categoryLookupId: category('rent'), amount: 100_00, methodLookupId: cash(), at: '2026-02-30' },
          NOW
        ),
      /real calendar date/i
    )
    // The list bounds are validated the same way.
    expectUserMessage(() => expenses.listExpenses(t.db, { to: '2026-02-30' }), /real calendar date/i)
  })
})
