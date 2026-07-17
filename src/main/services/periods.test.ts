import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import * as periods from './periods'
import * as expenses from './expenses'
import * as stock from './stock'
import * as stockTake from './stock-take'
import * as sales from './sales'
import * as returns from './returns'
import * as purchases from './purchases'
import * as ledger from './ledger'
import { ErrorCode, AppError } from '@shared/result'
import { ONE_UNIT } from '@shared/qty'
import type { User } from '@shared/types'

/**
 * CLOSING THE MONTH.
 *
 * The lock ENGINE has been enforced since migration 0002 — `ledger.post` and `stock.record` both call
 * `assertPeriodOpen`. What this file tests is what a SHOPKEEPER actually hits once the door exists:
 *
 *   · lock March, and a backdated sale / return / purchase / expense / stock correction into March is
 *     REFUSED — with a sentence, not a stack trace;
 *   · TODAY still works. Locking March does not stop the shop trading in April;
 *   · unlocking re-opens it, and the thing that was refused now goes through;
 *   · BOTH directions are audited with WHO.
 */

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** "Now" for every test in this file: July 2026. March 2026 is the month we close. */
const NOW = new Date('2026-07-15T10:00:00.000Z')
/** A day inside the month these tests close. */
const IN_MARCH = new Date('2026-03-10T10:00:00.000Z')

function makeUser(t: TestDb, role: User['role'], username: string, fullName: string): User {
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

function lookupId(t: TestDb, listKey: string, code: string): number {
  return t.db
    .prepare('SELECT id FROM lookups WHERE list_key = ? AND code = ?')
    .pluck()
    .get(listKey, code) as number
}

function makeProduct(t: TestDb, name = 'Tea 250g'): number {
  const now = new Date().toISOString()
  const uom = lookupId(t, 'uom', 'pcs')
  return Number(
    t.db
      .prepare(
        `INSERT INTO products
           (sku, name, sale_uom_id, cost_price, retail_price, min_stock_m,
            item_type, track_batches, is_weighted, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 0, 15000, 0, 'inventory', 0, 0, 1, ?, ?)`
      )
      .run(`SKU-${Math.random().toString(36).slice(2, 8)}`, name, uom, now, now).lastInsertRowid
  )
}

let t: TestDb
let owner: User

beforeEach(() => {
  t = makeTestDb({ withSeed: true })
  owner = makeUser(t, 'owner', 'insha', 'Insha Owner')
})

afterEach(() => {
  t.cleanup()
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// WHAT A SHOPKEEPER ACTUALLY HITS: a closed month refuses backdated entries
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('once a month is closed', () => {
  it('REFUSES a backdated EXPENSE into it — with a sentence a shopkeeper can act on', () => {
    periods.lock(t.db, owner, { year: 2026, month: 3 }, NOW)

    expectUserMessage(
      () =>
        expenses.createExpense(
          t.db,
          owner,
          {
            categoryLookupId: lookupId(t, 'expense_category', 'rent'),
            amount: 500_00,
            methodLookupId: lookupId(t, 'payment_method', 'cash')
          },
          IN_MARCH // dated inside the closed month
        ),
      /March 2026 has been closed.*cannot be changed.*unlock/i
    )
  })

  it('carries the PERIOD_LOCKED code, so the UI can react to it rather than parse a string', () => {
    periods.lock(t.db, owner, { year: 2026, month: 3 }, NOW)

    try {
      expenses.createExpense(
        t.db,
        owner,
        {
          categoryLookupId: lookupId(t, 'expense_category', 'rent'),
          amount: 500_00,
          methodLookupId: lookupId(t, 'payment_method', 'cash')
        },
        IN_MARCH
      )
      throw new Error('that expense should have been refused')
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe(ErrorCode.PERIOD_LOCKED)
    }
  })

  it('REFUSES a backdated STOCK CORRECTION into it', () => {
    const tea = makeProduct(t)
    periods.lock(t.db, owner, { year: 2026, month: 3 }, NOW)

    expectUserMessage(
      () =>
        stock.adjust(
          t.db,
          owner,
          { productId: tea, type: 'opening', qtyM: ONE_UNIT, unitCost: 1_000_000, reasonCode: 'data_entry' },
          IN_MARCH
        ),
      /March 2026 has been closed/i
    )
  })

  it('REFUSES a backdated stock MOVEMENT even when it posts no journal — the stock ledger locks too', () => {
    // The subtle one: a sale's stock leg posts NO journal, so a lock that lived only in ledger.post
    // would let stock change under a closed month while the books sat frozen. stock.record checks too.
    const tea = makeProduct(t)
    periods.lock(t.db, owner, { year: 2026, month: 3 }, NOW)

    expectUserMessage(
      () =>
        stock.record(t.db, {
          productId: tea,
          type: 'sale',
          qtyM: -ONE_UNIT,
          refType: 'sale',
          refId: 1,
          at: IN_MARCH
        }),
      /March 2026 has been closed/i
    )
  })

  it('TODAY STILL WORKS — closing March does not stop the shop trading in July', () => {
    periods.lock(t.db, owner, { year: 2026, month: 3 }, NOW)

    const detail = expenses.createExpense(
      t.db,
      owner,
      {
        categoryLookupId: lookupId(t, 'expense_category', 'rent'),
        amount: 500_00,
        methodLookupId: lookupId(t, 'payment_method', 'cash')
      },
      NOW // July — an open month
    )

    expect(detail.journalId).not.toBeNull()
    expect(ledger.trialBalance(t.db).balanced).toBe(true)
  })

  /**
   * THE THREE PATHS THE SHOP ACTUALLY USES, and the ones this file's own header PROMISES are refused.
   *
   * The tests above prove the lock on expenses and stock corrections. Selling, buying and refunding are
   * the paths a shop touches a thousand times a day — and a single one of them slipping through makes the
   * lock a lie: the owner closes March, reports on it, and March quietly keeps moving. They hold for one
   * reason worth stating: EVERY journal goes through `ledger.post`, which asks `assertPeriodOpen` first.
   * There is one door, so there is one lock. If someone ever posts a journal around it, these fail.
   */
  it('REFUSES a backdated SALE — the path the shop uses a thousand times a day', () => {
    const productId = makeProduct(t)
    stock.adjust(
      t.db,
      owner,
      { productId, type: 'opening', qtyM: 100 * ONE_UNIT, unitCost: 500_000, reasonCode: 'data_entry' },
      new Date('2026-01-01T10:00:00.000Z')
    )
    periods.lock(t.db, owner, { year: 2026, month: 3 }, NOW)

    expectUserMessage(
      () =>
        sales.complete(
          t.db,
          owner,
          {
            lines: [{ productId, qtyM: ONE_UNIT }],
            payments: [{ methodLookupId: lookupId(t, 'payment_method', 'cash'), amount: 15_000 }]
          },
          IN_MARCH
        ),
      /March 2026 has been closed/i
    )
  })

  it('REFUSES a backdated PURCHASE', () => {
    const productId = makeProduct(t)
    const now = new Date().toISOString()
    const supplierId = Number(
      t.db
        .prepare(`INSERT INTO suppliers (name, is_active, created_at, updated_at) VALUES (?, 1, ?, ?)`)
        .run('Distributor', now, now).lastInsertRowid
    )
    periods.lock(t.db, owner, { year: 2026, month: 3 }, NOW)

    expectUserMessage(
      () =>
        purchases.createPurchase(
          t.db,
          owner,
          { supplierId, lines: [{ productId, qtyM: 5 * ONE_UNIT, unitCost: 500_000 }], payments: [] },
          IN_MARCH
        ),
      /March 2026 has been closed/i
    )
  })

  /** A February sale refunded in a closed March: the REFUND is March's money, so March's lock applies. */
  it('REFUSES a backdated RETURN of a sale rung up before the lock', () => {
    const productId = makeProduct(t)
    stock.adjust(
      t.db,
      owner,
      { productId, type: 'opening', qtyM: 100 * ONE_UNIT, unitCost: 500_000, reasonCode: 'data_entry' },
      new Date('2026-01-01T10:00:00.000Z')
    )
    const supervisor = makeUser(t, 'supervisor', 'rashid', 'Rashid Supervisor')
    const sale = sales.complete(
      t.db,
      owner,
      {
        lines: [{ productId, qtyM: 2 * ONE_UNIT }],
        payments: [{ methodLookupId: lookupId(t, 'payment_method', 'cash'), amount: 30_000 }]
      },
      new Date('2026-02-10T10:00:00.000Z')
    ).sale

    periods.lock(t.db, owner, { year: 2026, month: 3 }, NOW)

    expectUserMessage(
      () =>
        returns.createReturn(
          t.db,
          supervisor,
          {
            saleId: sale.id,
            lines: [{ saleLineId: sale.lines[0]!.id, qtyM: ONE_UNIT }],
            settlement: 'refund',
            refundMethodLookupId: lookupId(t, 'payment_method', 'cash'),
            reasonCode: 'not_needed'
          },
          IN_MARCH
        ),
      /March 2026 has been closed/i
    )
  })

  it('only the LOCKED month is refused — February and April are untouched', () => {
    periods.lock(t.db, owner, { year: 2026, month: 3 }, NOW)

    for (const at of [new Date('2026-02-10T10:00:00.000Z'), new Date('2026-04-10T10:00:00.000Z')]) {
      expect(() =>
        expenses.createExpense(
          t.db,
          owner,
          {
            categoryLookupId: lookupId(t, 'expense_category', 'rent'),
            amount: 100_00,
            methodLookupId: lookupId(t, 'payment_method', 'cash')
          },
          at
        )
      ).not.toThrow()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// UNLOCKING RE-OPENS IT
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('unlocking', () => {
  it('RE-OPENS the month — the entry that was refused now goes through', () => {
    periods.lock(t.db, owner, { year: 2026, month: 3 }, NOW)

    const book = (): unknown =>
      expenses.createExpense(
        t.db,
        owner,
        {
          categoryLookupId: lookupId(t, 'expense_category', 'rent'),
          amount: 500_00,
          methodLookupId: lookupId(t, 'payment_method', 'cash')
        },
        IN_MARCH
      )

    expect(book).toThrow()

    periods.unlock(t.db, owner, { year: 2026, month: 3 }, NOW)

    expect(book).not.toThrow()
    expect(ledger.trialBalance(t.db).balanced).toBe(true)
  })

  it('and the month reads as open again', () => {
    periods.lock(t.db, owner, { year: 2026, month: 3 }, NOW)
    expect(periods.statusOf(t.db, 2026, 3)).toBe('locked')

    const row = periods.unlock(t.db, owner, { year: 2026, month: 3 }, NOW)

    expect(row.status).toBe('open')
    expect(row.lockedAt).toBeNull()
    expect(row.lockedByName).toBeNull()
    expect(periods.statusOf(t.db, 2026, 3)).toBe('open')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE AUDIT LOG — WHO closed the books, and WHO reopened them
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('the audit log', () => {
  it('records the LOCK with WHO and WHICH month', () => {
    periods.lock(t.db, owner, { year: 2026, month: 3 }, NOW)

    const entry = t.db.prepare("SELECT * FROM audit_log WHERE action = 'period.lock'").get() as {
      user_name: string
      user_role: string
      entity: string
      entity_id: string
    }

    expect(entry).toBeTruthy()
    expect(entry.user_name).toBe('Insha Owner') // WHO — copied in, never joined
    expect(entry.user_role).toBe('owner') // and the ROLE AT THE TIME
    expect(entry.entity).toBe('period')
    expect(entry.entity_id).toBe('2026-03')
  })

  it('records the UNLOCK — reopening a closed month is how books get quietly rewritten', () => {
    periods.lock(t.db, owner, { year: 2026, month: 3 }, NOW)
    periods.unlock(t.db, owner, { year: 2026, month: 3 }, NOW)

    const entry = t.db.prepare("SELECT * FROM audit_log WHERE action = 'period.unlock'").get() as {
      user_name: string
      entity_id: string
      after_json: string
    }

    expect(entry).toBeTruthy()
    expect(entry.user_name).toBe('Insha Owner')
    expect(entry.entity_id).toBe('2026-03')
  })

  it('the unlock records HOW MANY journals were sitting in the month it reopened', () => {
    // The difference between reopening a quiet month and reopening the shop's busiest quarter.
    for (const amount of [100_00, 200_00]) {
      expenses.createExpense(
        t.db,
        owner,
        {
          categoryLookupId: lookupId(t, 'expense_category', 'rent'),
          amount,
          methodLookupId: lookupId(t, 'payment_method', 'cash')
        },
        IN_MARCH
      )
    }

    periods.lock(t.db, owner, { year: 2026, month: 3 }, NOW)
    periods.unlock(t.db, owner, { year: 2026, month: 3 }, NOW)

    const entry = t.db.prepare("SELECT after_json FROM audit_log WHERE action = 'period.unlock'").get() as {
      after_json: string
    }
    expect((JSON.parse(entry.after_json) as { journalCount: number }).journalCount).toBe(2)
  })

  it('a no-op is NOT audited — a log full of non-events is a log nobody reads', () => {
    periods.lock(t.db, owner, { year: 2026, month: 3 }, NOW)
    periods.lock(t.db, owner, { year: 2026, month: 3 }, NOW) // already locked
    periods.unlock(t.db, owner, { year: 2026, month: 3 }, NOW)
    periods.unlock(t.db, owner, { year: 2026, month: 3 }, NOW) // already open

    expect(
      t.db.prepare("SELECT COUNT(*) FROM audit_log WHERE action = 'period.lock'").pluck().get()
    ).toBe(1)
    expect(
      t.db.prepare("SELECT COUNT(*) FROM audit_log WHERE action = 'period.unlock'").pluck().get()
    ).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE LIST — what the owner sees on the screen
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('the months list', () => {
  it('is built from the CALENDAR, not the table — a shop that never locked anything still sees months', () => {
    // Periods rows only exist once someone locks one. Reading the table would show an empty screen
    // and no way to start.
    const rows = periods.list(t.db, {}, NOW)

    expect(rows).toHaveLength(24)
    expect(rows.every((row) => row.status === 'open')).toBe(true)
    expect(rows[0]?.label).toBe('July 2026')
    expect(rows[0]?.isCurrent).toBe(true)
  })

  it('walks back across the year boundary correctly — December is not month 0', () => {
    const rows = periods.list(t.db, { months: 8 }, new Date('2026-02-15T10:00:00.000Z'))

    expect(rows.map((row) => row.label)).toEqual([
      'February 2026',
      'January 2026',
      'December 2025',
      'November 2025',
      'October 2025',
      'September 2025',
      'August 2025',
      'July 2025'
    ])
  })

  it('shows WHO locked a month and WHEN, and how many journals it holds', () => {
    expenses.createExpense(
      t.db,
      owner,
      {
        categoryLookupId: lookupId(t, 'expense_category', 'rent'),
        amount: 100_00,
        methodLookupId: lookupId(t, 'payment_method', 'cash')
      },
      IN_MARCH
    )
    periods.lock(t.db, owner, { year: 2026, month: 3 }, NOW)

    const march = periods.list(t.db, {}, NOW).find((row) => row.label === 'March 2026')

    expect(march?.status).toBe('locked')
    expect(march?.lockedByName).toBe('Insha Owner')
    expect(march?.lockedAt).toBe(NOW.toISOString())
    expect(march?.journalCount).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE GUARDS
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('the guards', () => {
  it('REFUSES to lock a month that has not happened yet', () => {
    // It would do nothing today and silently stop the till the day that month arrived.
    expectUserMessage(
      () => periods.lock(t.db, owner, { year: 2026, month: 9 }, NOW),
      /has not happened yet/i
    )
    expect(periods.statusOf(t.db, 2026, 9)).toBe('open')
  })

  it('ALLOWS locking the CURRENT month — a shop closing its books on the last day of trading', () => {
    expect(() => periods.lock(t.db, owner, { year: 2026, month: 7 }, NOW)).not.toThrow()
    expect(periods.statusOf(t.db, 2026, 7)).toBe('locked')
  })

  it('locking an already-locked month is a no-op, not an error', () => {
    periods.lock(t.db, owner, { year: 2026, month: 3 }, NOW)
    const again = periods.lock(t.db, owner, { year: 2026, month: 3 }, NOW)
    expect(again.status).toBe('locked')
  })

  it('a month with no periods row reads as OPEN — never locked means open', () => {
    expect(periods.statusOf(t.db, 2019, 1)).toBe('open')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE STOCK TAKE MEETS THE PERIOD LOCK
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('a stock take applied into a closed month', () => {
  it('is REFUSED ATOMICALLY — no half-applied sheet', () => {
    const tea = makeProduct(t, 'Tea')
    const rice = makeProduct(t, 'Rice')

    // Stock on the shelf, booked honestly, back in an open March.
    for (const id of [tea, rice]) {
      stock.adjust(
        t.db,
        owner,
        { productId: id, type: 'opening', qtyM: 10 * ONE_UNIT, unitCost: 1_000_000, reasonCode: 'data_entry' },
        IN_MARCH
      )
    }

    const sheet = stockTake.create(t.db, owner, {}, IN_MARCH)
    stockTake.addLines(
      t.db,
      owner,
      {
        stockTakeId: sheet.id,
        lines: [
          { productId: tea, countedQtyM: 8 * ONE_UNIT },
          { productId: rice, countedQtyM: 7 * ONE_UNIT }
        ]
      },
      IN_MARCH
    )

    // The owner closes March, then tries to apply the sheet INTO March.
    periods.lock(t.db, owner, { year: 2026, month: 3 }, NOW)

    expectUserMessage(
      () => stockTake.apply(t.db, owner, { stockTakeId: sheet.id }, IN_MARCH),
      /March 2026 has been closed/i
    )

    // NOTHING landed. Not the first line, not the second, and the sheet is not marked applied — a
    // sheet that posted 1 of its 2 corrections would be neither applied nor not applied.
    expect(stock.onHand(t.db, tea)).toBe(10 * ONE_UNIT)
    expect(stock.onHand(t.db, rice)).toBe(10 * ONE_UNIT)
    expect(stockTake.get(t.db, { stockTakeId: sheet.id }).status).toBe('open')
    expect(
      t.db.prepare("SELECT COUNT(*) FROM stock_movements WHERE type = 'stock_take'").pluck().get()
    ).toBe(0)
    expect(ledger.trialBalance(t.db).balanced).toBe(true)
  })

  it('but applying it TODAY works — the correction is a business event that happens when it is made', () => {
    const tea = makeProduct(t, 'Tea')
    stock.adjust(
      t.db,
      owner,
      { productId: tea, type: 'opening', qtyM: 10 * ONE_UNIT, unitCost: 1_000_000, reasonCode: 'data_entry' },
      IN_MARCH
    )

    const sheet = stockTake.create(t.db, owner, {}, NOW)
    stockTake.setCount(t.db, owner, { stockTakeId: sheet.id, productId: tea, countedQtyM: 8 * ONE_UNIT }, NOW)

    periods.lock(t.db, owner, { year: 2026, month: 3 }, NOW)

    // July is open, so the correction posts into July even though the stock arrived in March.
    expect(() => stockTake.apply(t.db, owner, { stockTakeId: sheet.id }, NOW)).not.toThrow()
    expect(stock.onHand(t.db, tea)).toBe(8 * ONE_UNIT)
    expect(ledger.trialBalance(t.db).balanced).toBe(true)
  })
})
