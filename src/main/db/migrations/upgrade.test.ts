import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, type TestDb } from '../testkit'
import { MIGRATIONS, runMigrations } from './index'
import { seed } from '../seed'
import { ACC } from '../chart-of-accounts'
import * as ledger from '../../services/ledger'
import * as stock from '../../services/stock'
import { ONE_UNIT } from '@shared/qty'
import type { User } from '@shared/types'

/**
 * THE UPGRADE PATH — the one every existing shop actually takes.
 *
 * Every other migration test in this repo builds a database by running ALL the migrations at once,
 * which is what a FRESH INSTALL does. No shop that already uses this app will ever do that again.
 * A shop that installed v0.2 has a database sitting at version 2 WITH A YEAR OF BOOKS IN IT, and
 * what it does on upgrade day is run 0003 — and only 0003 — against that live data.
 *
 * That is a completely different code path from the one the other tests cover, and it is the only one
 * that can destroy a business. So it gets its own file:
 *
 *   1. build a database at version 2 exactly as a shipped v0.2 install has it,
 *   2. put REAL data in it — users, lookups, a balanced journal,
 *   3. apply 0003 the way the app does on launch,
 *   4. prove that ONLY 0003 ran, that NOTHING that was already there moved, and that the shop can
 *      immediately use the new catalog — with its books still balancing.
 *
 * Forward-only means the data that was there before an upgrade is still there, unchanged, after it.
 * This file is what makes that a tested promise rather than an intention.
 */

const RS_100 = 1_000_000 // 4-dp cost

/**
 * The versions that a database sitting at v2 still has to catch up on, and the version it lands on.
 *
 * DERIVED FROM `MIGRATIONS`, never hardcoded — the same reasoning as in lookups.test.ts. A hardcoded
 * [3, 4] means the next person to add a migration "fixes" this test by editing a number, and stops
 * reading what it actually says. What it says is the RULE: a v2 database runs EVERYTHING above 2 and
 * NOTHING at or below it. That must stay true at 5 migrations and at 30.
 */
const PENDING_FROM_V2 = MIGRATIONS.map((m) => m.version)
  .filter((version) => version > 2)
  .sort((a, b) => a - b)

const LATEST_VERSION = Math.max(...MIGRATIONS.map((m) => m.version))

/** A database at EXACTLY the schema a shipped v0.2 install has: migrations 1 and 2, and no more. */
function migrateTo(t: TestDb, upTo: number): void {
  t.db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `)

  for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (migration.version > upTo) continue

    t.db.transaction(() => {
      migration.up(t.db)
      t.db
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString())
    })()
  }
}

function makeUser(t: TestDb): User {
  const now = new Date().toISOString()
  const id = Number(
    t.db
      .prepare(
        `INSERT INTO users (username, full_name, role, password_hash, is_active, created_at, updated_at)
         VALUES ('meena', 'Meena Manager', 'manager', 'x', 1, ?, ?)`
      )
      .run(now, now).lastInsertRowid
  )
  return {
    id,
    username: 'meena',
    fullName: 'Meena Manager',
    role: 'manager',
    hasPin: false,
    isActive: true
  }
}

describe('the upgrade path — a shop already running v0.2 installs the catalog', () => {
  let t: TestDb

  beforeEach(() => {
    // migrate: false — this database is built up by hand, one version at a time, like a real one.
    t = makeTestDb({ migrate: false })
    migrateTo(t, 2)
    seed(t.db)
  })

  afterEach(() => t.cleanup())

  it('a database at version 2 has NO catalog tables yet — the premise of this whole file', () => {
    const tables = t.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .pluck()
      .all() as string[]

    expect(tables).not.toContain('products')
    expect(tables).not.toContain('stock_movements')
    expect(
      t.db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get()
    ).toBe(2)
  })

  it('applies ONLY the migrations above 2 — it does not re-run the two that already ran', () => {
    const result = runMigrations(t.db)

    // The whole promise of forward-only, in one assertion: 1 and 2 are SHIPPED and are never touched
    // again. Re-running 0001 against a live database would try to recreate tables that hold the
    // shop's users and its books.
    expect(result.applied).toEqual(PENDING_FROM_V2)
    expect(result.alreadyAt).toBe(LATEST_VERSION)
  })

  it('does not lose ONE ROW of what was already there — users, lookups, settings, journals', () => {
    const actor = makeUser(t)

    // A real journal, posted before the upgrade, exactly as a year of trading would have left behind.
    ledger.post(t.db, {
      refType: 'opening',
      refId: 1,
      memo: 'Owner puts cash in the till',
      userId: actor.id,
      lines: [
        { account: ACC.CASH, debit: 50_000_00 },
        { account: ACC.OPENING_BALANCE_EQUITY, credit: 50_000_00 }
      ]
    })

    const before = {
      users: t.db.prepare('SELECT COUNT(*) FROM users').pluck().get(),
      lookups: t.db.prepare('SELECT COUNT(*) FROM lookups').pluck().get(),
      settings: t.db.prepare('SELECT COUNT(*) FROM settings').pluck().get(),
      accounts: t.db.prepare('SELECT COUNT(*) FROM accounts').pluck().get(),
      journals: t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get(),
      lines: t.db.prepare('SELECT COUNT(*) FROM journal_lines').pluck().get(),
      trialBalance: ledger.trialBalance(t.db)
    }

    runMigrations(t.db)

    const after = {
      users: t.db.prepare('SELECT COUNT(*) FROM users').pluck().get(),
      lookups: t.db.prepare('SELECT COUNT(*) FROM lookups').pluck().get(),
      settings: t.db.prepare('SELECT COUNT(*) FROM settings').pluck().get(),
      accounts: t.db.prepare('SELECT COUNT(*) FROM accounts').pluck().get(),
      journals: t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get(),
      lines: t.db.prepare('SELECT COUNT(*) FROM journal_lines').pluck().get(),
      trialBalance: ledger.trialBalance(t.db)
    }

    expect(after).toEqual(before)

    // And the books that balanced before the upgrade still balance after it.
    expect(after.trialBalance.balanced).toBe(true)
    expect(after.trialBalance.totalDebit).toBe(after.trialBalance.totalCredit)
  })

  it('the shop can sell from the new catalog the moment the upgrade finishes — and the books balance', () => {
    runMigrations(t.db)

    const actor = makeUser(t)
    const now = new Date().toISOString()
    const uomId = t.db
      .prepare("SELECT id FROM lookups WHERE list_key = 'uom' AND code = 'pcs'")
      .pluck()
      .get() as number

    const productId = Number(
      t.db
        .prepare(
          `INSERT INTO products (sku, name, sale_uom_id, cost_price, retail_price, min_stock_m,
                                 item_type, is_active, created_at, updated_at)
           VALUES ('UPG-1', 'Cooking Oil 5L', ?, 0, 0, 0, 'inventory', 1, ?, ?)`
        )
        .run(uomId, now, now).lastInsertRowid
    )

    // The catalog tables work against the migrated database, not just against a freshly created one:
    // stock moves, the average cost lands, and the adjustment posts a BALANCED journal.
    const result = stock.adjust(t.db, actor, {
      productId,
      type: 'opening',
      qtyM: 10 * ONE_UNIT,
      unitCost: RS_100,
      reasonCode: 'stock_take'
    })

    expect(result.onHandM).toBe(10 * ONE_UNIT)
    expect(result.avgCost).toBe(RS_100)
    expect(result.journalId).not.toBeNull()

    // On-hand is the SUM of the movements — on an upgraded database exactly as on a new one.
    expect(stock.onHand(t.db, productId)).toBe(
      t.db
        .prepare('SELECT COALESCE(SUM(qty_m), 0) FROM stock_movements WHERE product_id = ?')
        .pluck()
        .get(productId)
    )

    const tb = ledger.trialBalance(t.db)
    expect(tb.balanced).toBe(true)
    expect(tb.totalDebit).toBe(tb.totalCredit)
  })

  it('is idempotent — the app runs migrations on EVERY launch, not just on upgrade day', () => {
    expect(runMigrations(t.db).applied).toEqual(PENDING_FROM_V2)
    expect(runMigrations(t.db).applied).toEqual([])
    expect(runMigrations(t.db).applied).toEqual([])
    expect(runMigrations(t.db).alreadyAt).toBe(LATEST_VERSION)
  })
})

describe('schema invariants — asserted against the WHOLE database, not one table at a time', () => {
  let t: TestDb

  beforeEach(() => {
    t = makeTestDb({ withSeed: true })
  })

  afterEach(() => t.cleanup())

  /** Every column of every table the app has ever created. */
  function allColumns(): Array<{ table: string; name: string; type: string }> {
    const tables = t.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .pluck()
      .all() as string[]

    return tables.flatMap((table) =>
      (
        t.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>
      ).map((column) => ({ table, name: column.name, type: column.type.toUpperCase() }))
    )
  }

  it('NOT ONE FLOATING-POINT COLUMN EXISTS, in any table', () => {
    // Money, cost and quantity are all integers at fixed scales. A REAL column anywhere is a door for
    // a float to walk through, and a float in a shop's money is a rounding error that compounds for
    // years before anyone notices. This asserts it across the entire schema — including any table a
    // future migration adds, which is the point of checking it this way rather than by reading 0003.
    const floats = allColumns().filter((column) =>
      ['REAL', 'FLOAT', 'DOUBLE', 'NUMERIC', 'DECIMAL'].some((type) => column.type.includes(type))
    )

    expect(floats, `floating-point columns found: ${JSON.stringify(floats)}`).toEqual([])
  })

  it('THERE IS NO MUTABLE STOCK COLUMN — on products or anywhere else', () => {
    // Stock is SUM(stock_movements.qty_m). If a column ever appears that a write path could set to a
    // stock figure, the figure on the screen and the history that produced it can disagree — and then
    // nobody can tell which one lied. The only quantity columns allowed are the re-order LEVEL, the
    // signed movement itself, and pack sizes.
    const ALLOWED = new Set(['min_stock_m', 'qty_m', 'pack_size'])

    const stockish = allColumns().filter(
      (column) =>
        !ALLOWED.has(column.name) &&
        (/^stock$/.test(column.name) ||
          /^(stock|qty|quantity|balance|on_hand|onhand)(_|$)/.test(column.name) ||
          /(_stock|_qty|_quantity|_on_hand)$/.test(column.name))
    )

    expect(
      stockish,
      `a column that looks like stored stock appeared: ${JSON.stringify(stockish)}`
    ).toEqual([])

    // And specifically, on the table the legacy form let people type a balance into.
    const productColumns = (
      t.db.prepare('PRAGMA table_info(products)').all() as Array<{ name: string }>
    ).map((column) => column.name)

    expect(productColumns).not.toContain('stock')
    expect(productColumns).not.toContain('quantity')
    expect(productColumns).not.toContain('balance_qty')
    expect(productColumns).toContain('min_stock_m') // the re-order LEVEL is not a stock figure
  })
})
