import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, type TestDb } from '../testkit'
import { MIGRATIONS, runMigrations } from './index'
import { seed } from '../seed'
import { ACC } from '../chart-of-accounts'
import * as ledger from '../../services/ledger'
import * as stock from '../../services/stock'
import { ONE_UNIT } from '@shared/qty'
import { costToPriceMinor } from '@shared/cost'
import { openingBalanceEquityMinor, OPENING_REF_TYPE } from '@shared/opening'
import type { User } from '@shared/types'

/**
 * MIGRATION 0005 — the opening setup.
 *
 * Two things are proven here, and the second one is the point of the whole phase:
 *
 *   1. THE SCHEMA REFUSES NONSENSE. Not "the service checks it" — the DATABASE refuses it, so that a
 *      bug in a service, a future screen, or a LAN client tomorrow cannot write an opening balance
 *      that means nothing. Every CHECK and every UNIQUE below is a specific way a shop's day-one
 *      figures could have been silently doubled or zeroed.
 *
 *   2. THE BOOKS BALANCE FROM DAY ONE. The scenario at the bottom posts a real opening balance the
 *      way the service must — stock.adjust() for the stock, ledger.post() for the cash, bank, udhaar
 *      and dues — and asserts the trial balance balances and that Opening Balance Equity comes to
 *      exactly Inventory + Cash + Bank + Receivables − Payables.
 */

const RS = 100 // 2-dp money minor units per rupee
const RS_COST = 10_000 // 4-dp cost units per rupee

function makeUser(t: TestDb): User {
  const now = new Date().toISOString()
  const id = Number(
    t.db
      .prepare(
        `INSERT INTO users (username, full_name, role, password_hash, is_active, created_at, updated_at)
         VALUES ('owner', 'Insha Owner', 'owner', 'x', 1, ?, ?)`
      )
      .run(now, now).lastInsertRowid
  )
  return {
    id,
    username: 'owner',
    fullName: 'Insha Owner',
    role: 'owner',
    hasPin: false,
    isActive: true
  }
}

function makeProduct(t: TestDb, sku: string, trackBatches = false): number {
  const now = new Date().toISOString()
  const uomId = t.db
    .prepare("SELECT id FROM lookups WHERE list_key = 'uom' AND code = 'pcs'")
    .pluck()
    .get() as number

  return Number(
    t.db
      .prepare(
        `INSERT INTO products (sku, name, sale_uom_id, cost_price, retail_price, min_stock_m,
                               item_type, track_batches, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 0, 0, 0, 'inventory', ?, 1, ?, ?)`
      )
      .run(sku, `Item ${sku}`, uomId, trackBatches ? 1 : 0, now, now).lastInsertRowid
  )
}

function makeCustomer(t: TestDb, name: string): number {
  const now = new Date().toISOString()
  return Number(
    t.db
      .prepare('INSERT INTO customers (name, created_at, updated_at) VALUES (?, ?, ?)')
      .run(name, now, now).lastInsertRowid
  )
}

function makeSupplier(t: TestDb, name: string): number {
  const now = new Date().toISOString()
  return Number(
    t.db
      .prepare('INSERT INTO suppliers (name, created_at, updated_at) VALUES (?, ?, ?)')
      .run(name, now, now).lastInsertRowid
  )
}

function addStockLine(
  t: TestDb,
  line: { productId: number; qtyM: number; unitCost?: number; batchNo?: string | null }
): void {
  const now = new Date().toISOString()
  t.db
    .prepare(
      `INSERT INTO opening_stock_lines (product_id, qty_m, unit_cost, batch_no, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(line.productId, line.qtyM, line.unitCost ?? 0, line.batchNo ?? null, now, now)
}

// ─────────────────────────────────────────────────────────────────────────────

describe('0005 — the upgrade path: a shop already running v0.4 gets the opening setup', () => {
  let t: TestDb

  beforeEach(() => {
    // Built up one version at a time, like a real shop's database — NOT created fresh at 5.
    t = makeTestDb({ migrate: false })
    t.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
      )
    `)
    for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
      if (migration.version > 4) continue
      t.db.transaction(() => {
        migration.up(t.db)
        t.db
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, new Date().toISOString())
      })()
    }
    seed(t.db)
  })

  afterEach(() => t.cleanup())

  it('applies ONLY 0005, and loses nothing that was already in the books', () => {
    const actor = makeUser(t)

    // A year of trading, in miniature: a product with stock, and a balanced journal behind it.
    const productId = makeProduct(t, 'OLD-1')
    stock.adjust(t.db, actor, {
      productId,
      type: 'adjustment',
      qtyM: 5 * ONE_UNIT,
      unitCost: 50 * RS_COST,
      reasonCode: 'stock_take'
    })

    const before = {
      products: t.db.prepare('SELECT COUNT(*) FROM products').pluck().get(),
      movements: t.db.prepare('SELECT COUNT(*) FROM stock_movements').pluck().get(),
      journals: t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get(),
      lines: t.db.prepare('SELECT COUNT(*) FROM journal_lines').pluck().get(),
      onHand: stock.onHand(t.db, productId),
      avgCost: stock.averageCost(t.db, productId),
      trialBalance: ledger.trialBalance(t.db)
    }

    const result = runMigrations(t.db)
    expect(result.applied).toEqual([5])

    const after = {
      products: t.db.prepare('SELECT COUNT(*) FROM products').pluck().get(),
      movements: t.db.prepare('SELECT COUNT(*) FROM stock_movements').pluck().get(),
      journals: t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get(),
      lines: t.db.prepare('SELECT COUNT(*) FROM journal_lines').pluck().get(),
      onHand: stock.onHand(t.db, productId),
      avgCost: stock.averageCost(t.db, productId),
      trialBalance: ledger.trialBalance(t.db)
    }

    expect(after).toEqual(before)
    expect(after.trialBalance.balanced).toBe(true)
  })

  it('creates every opening table, and no others', () => {
    runMigrations(t.db)

    const tables = t.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .pluck()
      .all() as string[]

    expect(tables).toContain('customers')
    expect(tables).toContain('opening_setup')
    expect(tables).toContain('opening_stock_lines')
    expect(tables).toContain('opening_receivables')
    expect(tables).toContain('opening_payables')
  })
})

describe('0005 — the schema refuses nonsense', () => {
  let t: TestDb

  beforeEach(() => {
    t = makeTestDb({ withSeed: true })
  })

  afterEach(() => t.cleanup())

  // ── opening_setup: one row, ever ───────────────────────────────────────────

  it('opening_setup holds ONE row — a shop opens its books once', () => {
    const now = new Date().toISOString()
    t.db
      .prepare(
        `INSERT INTO opening_setup (id, go_live_date, created_at, updated_at)
         VALUES (1, '2026-07-01', ?, ?)`
      )
      .run(now, now)

    // A second setup row would mean a second opening balance — and posting it would double the shop's
    // day-one stock, cash and equity with a perfectly balanced journal that nothing would ever catch.
    expect(() =>
      t.db
        .prepare(
          `INSERT INTO opening_setup (id, go_live_date, created_at, updated_at)
           VALUES (2, '2026-07-01', ?, ?)`
        )
        .run(now, now)
    ).toThrow(/CHECK constraint failed/i)
  })

  it('a draft has no committer, and a committed setup has one', () => {
    const now = new Date().toISOString()

    // A "draft" that already claims to have been committed is a half-state: the wizard would let the
    // owner keep editing figures that are already in the books.
    expect(() =>
      t.db
        .prepare(
          `INSERT INTO opening_setup (id, status, go_live_date, committed_at, created_at, updated_at)
           VALUES (1, 'draft', '2026-07-01', ?, ?, ?)`
        )
        .run(now, now, now)
    ).toThrow(/CHECK constraint failed/i)

    // A "committed" setup that cannot say WHEN it was committed is an audit trail with a hole in it.
    expect(() =>
      t.db
        .prepare(
          `INSERT INTO opening_setup (id, status, go_live_date, created_at, updated_at)
           VALUES (1, 'committed', '2026-07-01', ?, ?)`
        )
        .run(now, now)
    ).toThrow(/CHECK constraint failed/i)
  })

  it('cash and bank cannot be negative — a till does not hold minus five hundred rupees', () => {
    const now = new Date().toISOString()
    expect(() =>
      t.db
        .prepare(
          `INSERT INTO opening_setup (id, go_live_date, opening_cash, created_at, updated_at)
           VALUES (1, '2026-07-01', -1, ?, ?)`
        )
        .run(now, now)
    ).toThrow(/CHECK constraint failed/i)
  })

  // ── opening_stock_lines ────────────────────────────────────────────────────

  it('an opening stock line states what the shop HAS — never zero, never negative', () => {
    const productId = makeProduct(t, 'P-1')

    expect(() => addStockLine(t, { productId, qtyM: 0 })).toThrow(/CHECK constraint failed/i)
    expect(() => addStockLine(t, { productId, qtyM: -5 * ONE_UNIT })).toThrow(
      /CHECK constraint failed/i
    )

    addStockLine(t, { productId, qtyM: 40 * ONE_UNIT, unitCost: 91_0417 })
    expect(t.db.prepare('SELECT COUNT(*) FROM opening_stock_lines').pluck().get()).toBe(1)
  })

  /**
   * THE ONE THAT WOULD HAVE COST THE SHOP REAL MONEY.
   *
   * `UNIQUE (product_id, batch_no)` does NOT stop two un-batched lines for the same product, because
   * in SQL two NULLs are not equal. Un-batched is the common case — nearly every line the shop types.
   * So the owner keys "Cooking Oil, 40" on Monday, forgets, keys it again on Tuesday, and commits: 80
   * litres of opening stock, a doubled Inventory debit, and a trial balance that balances perfectly.
   * The partial unique index in 0005 is what makes that impossible.
   */
  it('ONE line per un-batched item — the NULL hole in UNIQUE(product_id, batch_no) is closed', () => {
    const productId = makeProduct(t, 'OIL-5L')

    addStockLine(t, { productId, qtyM: 40 * ONE_UNIT, unitCost: 91_0417 })

    expect(() => addStockLine(t, { productId, qtyM: 40 * ONE_UNIT, unitCost: 91_0417 })).toThrow(
      /UNIQUE constraint failed/i
    )

    expect(t.db.prepare('SELECT SUM(qty_m) FROM opening_stock_lines').pluck().get()).toBe(
      40 * ONE_UNIT
    )
  })

  it('...but a batch-tracked item may have MANY lines — one per batch', () => {
    const productId = makeProduct(t, 'MED-1', true)

    addStockLine(t, { productId, qtyM: 10 * ONE_UNIT, batchNo: 'B-001' })
    addStockLine(t, { productId, qtyM: 25 * ONE_UNIT, batchNo: 'B-002' })

    // Same batch twice is still refused — that is the same double-entry mistake, one level down.
    expect(() => addStockLine(t, { productId, qtyM: 5 * ONE_UNIT, batchNo: 'B-001' })).toThrow(
      /UNIQUE constraint failed/i
    )

    expect(t.db.prepare('SELECT COUNT(*) FROM opening_stock_lines').pluck().get()).toBe(2)
  })

  it('a blank batch number is NULL, not a batch — it cannot sneak past the un-batched rule', () => {
    const productId = makeProduct(t, 'P-2')

    // '' and ' ' would each be a DISTINCT batch_no as far as UNIQUE is concerned, which would reopen
    // the exact hole the partial index closes.
    expect(() => addStockLine(t, { productId, qtyM: ONE_UNIT, batchNo: '' })).toThrow(
      /CHECK constraint failed/i
    )
    expect(() => addStockLine(t, { productId, qtyM: ONE_UNIT, batchNo: '   ' })).toThrow(
      /CHECK constraint failed/i
    )
  })

  it('an opening stock line must point at a REAL product', () => {
    expect(() => addStockLine(t, { productId: 9999, qtyM: ONE_UNIT })).toThrow(
      /FOREIGN KEY constraint failed/i
    )
  })

  // ── receivables & payables ─────────────────────────────────────────────────

  it('udhaar is one row per customer, and always a real amount', () => {
    const now = new Date().toISOString()
    const customerId = makeCustomer(t, 'Rashid')

    const add = (amount: number): void => {
      t.db
        .prepare(
          'INSERT INTO opening_receivables (customer_id, amount, created_at) VALUES (?, ?, ?)'
        )
        .run(customerId, amount, now)
    }

    // A customer who owes nothing is not a receivable — they are just a customer.
    expect(() => add(0)).toThrow(/CHECK constraint failed/i)
    expect(() => add(-500 * RS)).toThrow(/CHECK constraint failed/i)

    add(12_400 * RS)
    // Two opening balances for one customer would double what he owes, and he would be chased for it.
    expect(() => add(3_000 * RS)).toThrow(/UNIQUE constraint failed/i)
  })

  it('supplier dues are one row per supplier, and always a real amount', () => {
    const now = new Date().toISOString()
    const supplierId = makeSupplier(t, 'Karachi Traders')

    const add = (amount: number): void => {
      t.db
        .prepare('INSERT INTO opening_payables (supplier_id, amount, created_at) VALUES (?, ?, ?)')
        .run(supplierId, amount, now)
    }

    expect(() => add(0)).toThrow(/CHECK constraint failed/i)
    add(8_000 * RS)
    expect(() => add(1_000 * RS)).toThrow(/UNIQUE constraint failed/i)
  })

  it('udhaar has to be owed BY SOMEBODY — a receivable needs a real customer', () => {
    const now = new Date().toISOString()
    expect(() =>
      t.db
        .prepare(
          'INSERT INTO opening_receivables (customer_id, amount, created_at) VALUES (?, ?, ?)'
        )
        .run(9999, 500 * RS, now)
    ).toThrow(/FOREIGN KEY constraint failed/i)
  })

  it('a credit limit is a limit, not a debt — it cannot be negative', () => {
    const now = new Date().toISOString()
    expect(() =>
      t.db
        .prepare(
          'INSERT INTO customers (name, credit_limit, created_at, updated_at) VALUES (?, ?, ?, ?)'
        )
        .run('Bad Limit', -1, now, now)
    ).toThrow(/CHECK constraint failed/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('0005 — the books balance from day one', () => {
  let t: TestDb
  let actor: User

  beforeEach(() => {
    t = makeTestDb({ withSeed: true })
    actor = makeUser(t)
  })

  afterEach(() => t.cleanup())

  /**
   * The commit, exactly as the service must perform it. This is the accounting specification:
   *
   *      opening stock    ->  DR Inventory              CR Opening Balance Equity   (via stock.adjust)
   *      opening cash     ->  DR Cash in Hand           CR Opening Balance Equity
   *      opening bank     ->  DR Bank                   CR Opening Balance Equity
   *      customer udhaar  ->  DR Accounts Receivable    CR Opening Balance Equity
   *      supplier dues    ->  DR Opening Balance Equity CR Accounts Payable
   */
  function commitOpening(input: {
    stock: Array<{ productId: number; qtyM: number; unitCost: number }>
    cashMinor: number
    bankMinor: number
    receivablesMinor: number
    payablesMinor: number
    at: Date
  }): void {
    t.db.transaction(() => {
      for (const line of input.stock) {
        // stock.adjust() already posts DR Inventory / CR Opening Balance Equity for type 'opening',
        // and already sets the weighted-average cost. Reuse it — do not reinvent it.
        stock.adjust(
          t.db,
          actor,
          {
            productId: line.productId,
            type: 'opening',
            qtyM: line.qtyM,
            unitCost: line.unitCost,
            reasonCode: 'data_entry'
          },
          input.at
        )
      }

      const post = (memo: string, lines: ledger.JournalLineInput[]): void => {
        ledger.post(t.db, {
          at: input.at,
          refType: OPENING_REF_TYPE,
          memo,
          userId: actor.id,
          lines
        })
      }

      if (input.cashMinor > 0) {
        post('Opening cash in hand', [
          { account: ACC.CASH, debit: input.cashMinor },
          { account: ACC.OPENING_BALANCE_EQUITY, credit: input.cashMinor }
        ])
      }
      if (input.bankMinor > 0) {
        post('Opening bank balance', [
          { account: ACC.BANK, debit: input.bankMinor },
          { account: ACC.OPENING_BALANCE_EQUITY, credit: input.bankMinor }
        ])
      }
      if (input.receivablesMinor > 0) {
        post('Opening customer udhaar', [
          { account: ACC.RECEIVABLE, debit: input.receivablesMinor },
          { account: ACC.OPENING_BALANCE_EQUITY, credit: input.receivablesMinor }
        ])
      }
      if (input.payablesMinor > 0) {
        // The one leg that runs the other way — the only opening figure that is not something the
        // shop OWNS.
        post('Opening supplier dues', [
          { account: ACC.OPENING_BALANCE_EQUITY, debit: input.payablesMinor },
          { account: ACC.PAYABLE, credit: input.payablesMinor }
        ])
      }
    })()
  }

  it('posts a balanced opening balance, and OBE = Inventory + Cash + Bank + AR − AP', () => {
    const at = new Date('2026-07-01T09:00:00.000Z')
    const oilId = makeProduct(t, 'OIL-5L')
    const riceId = makeProduct(t, 'RICE-25KG')

    // 10 units at Rs 100 cost, and 4 units at Rs 2,500 cost.
    const stockValueMinor =
      costToPriceMinor(stock.movementValueCost(10 * ONE_UNIT, 100 * RS_COST)) +
      costToPriceMinor(stock.movementValueCost(4 * ONE_UNIT, 2_500 * RS_COST))

    expect(stockValueMinor).toBe(1_000 * RS + 10_000 * RS) // Rs 11,000

    const cashMinor = 5_000 * RS
    const bankMinor = 20_000 * RS
    const receivablesMinor = 1_200 * RS
    const payablesMinor = 800 * RS

    commitOpening({
      stock: [
        { productId: oilId, qtyM: 10 * ONE_UNIT, unitCost: 100 * RS_COST },
        { productId: riceId, qtyM: 4 * ONE_UNIT, unitCost: 2_500 * RS_COST }
      ],
      cashMinor,
      bankMinor,
      receivablesMinor,
      payablesMinor,
      at
    })

    // 1. THE STANDING INVARIANT. After every scenario, the trial balance balances.
    const tb = ledger.trialBalance(t.db)
    expect(tb.balanced).toBe(true)
    expect(tb.grossDebit).toBe(tb.grossCredit)

    // 2. Every account landed where the accounting says it should.
    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(stockValueMinor)
    expect(ledger.accountBalance(t.db, ACC.CASH)).toBe(cashMinor)
    expect(ledger.accountBalance(t.db, ACC.BANK)).toBe(bankMinor)
    expect(ledger.accountBalance(t.db, ACC.RECEIVABLE)).toBe(receivablesMinor)
    expect(ledger.accountBalance(t.db, ACC.PAYABLE)).toBe(payablesMinor)

    // 3. THE IDENTITY. Opening Balance Equity is credit-natured, so a positive balance is a credit.
    const expected = openingBalanceEquityMinor({
      stockValueMinor,
      openingCashMinor: cashMinor,
      openingBankMinor: bankMinor,
      receivablesMinor,
      payablesMinor
    })

    expect(expected).toBe(36_400 * RS) // 11,000 + 5,000 + 20,000 + 1,200 − 800
    expect(ledger.accountBalance(t.db, ACC.OPENING_BALANCE_EQUITY)).toBe(expected)

    // 4. Stock is DERIVED, and the opening cost seeded the weighted average.
    expect(stock.onHand(t.db, oilId)).toBe(10 * ONE_UNIT)
    expect(stock.averageCost(t.db, oilId)).toBe(100 * RS_COST)
  })

  it('a shop that owes more than it owns lands OBE on the DEBIT side — and that is CORRECT', () => {
    const at = new Date('2026-07-01T09:00:00.000Z')
    const productId = makeProduct(t, 'P-1')

    // Rs 1,000 of stock, Rs 500 in the till... and Rs 20,000 owed to suppliers.
    const stockValueMinor = costToPriceMinor(
      stock.movementValueCost(10 * ONE_UNIT, 100 * RS_COST)
    )
    const cashMinor = 500 * RS
    const payablesMinor = 20_000 * RS

    commitOpening({
      stock: [{ productId, qtyM: 10 * ONE_UNIT, unitCost: 100 * RS_COST }],
      cashMinor,
      bankMinor: 0,
      receivablesMinor: 0,
      payablesMinor,
      at
    })

    const expected = openingBalanceEquityMinor({
      stockValueMinor,
      openingCashMinor: cashMinor,
      openingBankMinor: 0,
      receivablesMinor: 0,
      payablesMinor
    })

    // NEGATIVE net worth, honestly stated. Nothing must ever "fix" this.
    expect(expected).toBe(-18_500 * RS)
    expect(ledger.accountBalance(t.db, ACC.OPENING_BALANCE_EQUITY)).toBe(expected)

    // And the books STILL balance. A negative equity is not an unbalanced ledger.
    const tb = ledger.trialBalance(t.db)
    expect(tb.balanced).toBe(true)
    expect(tb.totalDebit).toBe(tb.totalCredit)

    // On the report it shows on the DEBIT side, which is what a negative equity means.
    const obe = tb.rows.find((row) => row.code === ACC.OPENING_BALANCE_EQUITY)
    expect(obe?.debit).toBe(18_500 * RS)
    expect(obe?.credit).toBe(0)
  })

  it('opening stock at zero cost still counts on the shelf, and posts no journal', () => {
    const at = new Date('2026-07-01T09:00:00.000Z')
    const productId = makeProduct(t, 'FREE-1')

    // A free sample from a supplier. It is real stock; it just cost nothing. A zero-value journal is
    // not a record of anything, so none is posted — but the tin is on the shelf and must be sellable.
    const result = stock.adjust(
      t.db,
      actor,
      { productId, type: 'opening', qtyM: 6 * ONE_UNIT, unitCost: 0, reasonCode: 'data_entry' },
      at
    )

    expect(result.onHandM).toBe(6 * ONE_UNIT)
    expect(result.journalId).toBeNull()
    expect(ledger.trialBalance(t.db).balanced).toBe(true)
  })
})
