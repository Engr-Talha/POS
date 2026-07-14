import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, type TestDb } from '../testkit'
import { MIGRATIONS, runMigrations } from './index'
import { seed } from '../seed'
import { ACC } from '../chart-of-accounts'
import * as ledger from '../../services/ledger'
import * as sales from '../../services/sales'
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

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * 0006 → 0007 — THE UPGRADE EVERY SHOP RUNNING THIS APP TAKES *NEXT*.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The suite above starts at v2 and runs 3, 4, 5, 6 and 7 in one batch. That is an ANCIENT install
 * catching up, and it is worth testing — but it is not the path anybody is actually about to take.
 *
 * Every shop with this app on its counter today is sitting at 0006: Phase 4 shipped. It has a real
 * catalogue, real stock movements carrying the `value_minor` that 0006 froze onto them, a committed
 * opening balance, and a ledger that balances. On upgrade day it runs 0007 — AND ONLY 0007 — against
 * that live book, and then the first thing it does is ring up a sale.
 *
 * So this proves the whole seam, in the order a shop meets it:
 *
 *   1. only [7] runs; 1-6 are SHIPPED and are not touched again;
 *   2. not one row of what was already there moves, and the books still balance;
 *   3. the shop can SELL immediately — and on the upgraded database the trial balance still balances,
 *      GL Inventory still equals the stock valuation, and the invoice numbers are gapless;
 *   4. a VOIDED invoice keeps its number, and the next sale does NOT reuse it.
 */
describe('the upgrade path — a shop at 0006 (Phase 4) installs SELLING', () => {
  let t: TestDb

  const COST_RS_60 = 600_000 // 4-dp cost
  const PRICE_RS_100 = 10_000 // 2-dp money

  beforeEach(() => {
    t = makeTestDb({ migrate: false })
    migrateTo(t, 6)
    seed(t.db)
  })

  afterEach(() => t.cleanup())

  /** A product with stock on the shelf, exactly as a Phase-4 shop already has. */
  function shopWithStock(actor: User): number {
    const now = new Date().toISOString()
    const uomId = t.db
      .prepare("SELECT id FROM lookups WHERE list_key = 'uom' AND code = 'pcs'")
      .pluck()
      .get() as number

    const productId = Number(
      t.db
        .prepare(
          `INSERT INTO products (sku, name, sale_uom_id, cost_price, retail_price, wholesale_price,
                                 tax_rate_bp, price_entry_mode, min_stock_m, item_type, is_active,
                                 created_at, updated_at)
           VALUES ('UPG-6', 'Cooking Oil 5L', ?, 0, ?, 0, 0, 'exclusive', 0, 'inventory', 1, ?, ?)`
        )
        .run(uomId, PRICE_RS_100, now, now).lastInsertRowid
    )

    // Seeded with RAW SQL, not stock.adjust — deliberately. A real 0006 shop wrote its audit rows
    // with the v0.5 code, which had never heard of audit_log.approved_by_role (that column arrives in
    // 0008). Calling today's stock.adjust here would try to write that column into a schema that does
    // not have it yet — a state no real shop was ever in. So we lay down the exact ROWS a 0006 shop
    // has (a valued movement, the averaged cost, a balanced opening journal) and touch no audit.
    const valueMinor = stock.movementValueMinor(10 * ONE_UNIT, COST_RS_60)

    t.db
      .prepare(
        `INSERT INTO stock_movements
           (at, type, product_id, qty_m, unit_cost, value_minor, reason_code, user_id, created_at)
         VALUES (?, 'opening', ?, ?, ?, ?, 'stock_take', ?, ?)`
      )
      .run(now, productId, 10 * ONE_UNIT, COST_RS_60, valueMinor, actor.id, now)

    t.db.prepare('UPDATE products SET cost_price = ? WHERE id = ?').run(COST_RS_60, productId)

    ledger.post(t.db, {
      refType: 'opening',
      refId: productId,
      memo: 'Opening stock',
      userId: actor.id,
      lines: [
        { account: ACC.INVENTORY, debit: valueMinor },
        { account: ACC.OPENING_BALANCE_EQUITY, credit: valueMinor }
      ]
    })

    return productId
  }

  function cashMethodId(): number {
    return t.db
      .prepare("SELECT id FROM lookups WHERE list_key = 'payment_method' AND code = 'cash'")
      .pluck()
      .get() as number
  }

  it('a database at version 6 has NO sales tables yet — the premise of this file', () => {
    const tables = t.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .pluck()
      .all() as string[]

    expect(tables).toContain('stock_movements') // 0006 IS there...
    expect(tables).not.toContain('sales') // ...and 0007 is not.
    expect(tables).not.toContain('sale_lines')
    expect(tables).not.toContain('invoice_counters')
    expect(t.db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get()).toBe(6)
  })

  it('applies ONLY the migrations after 0006 — the six shipped ones are not re-run against live data', () => {
    // Derived from the migration list, not hardcoded, so adding a future migration cannot silently
    // make this assertion wrong: a shop at 0006 runs exactly the ones numbered above 6.
    const expected = MIGRATIONS.map((m) => m.version).filter((v) => v > 6)

    const result = runMigrations(t.db)

    expect(result.applied).toEqual(expected)
    expect(result.alreadyAt).toBe(LATEST_VERSION)
  })

  it('does not move ONE ROW of the shop it upgraded — stock, cost and books all unchanged', () => {
    const actor = makeUser(t)
    const productId = shopWithStock(actor)

    const before = {
      onHand: stock.onHand(t.db, productId),
      avgCost: stock.averageCost(t.db, productId),
      stockValue: t.db
        .prepare('SELECT COALESCE(SUM(value_minor), 0) FROM stock_movements')
        .pluck()
        .get(),
      movements: t.db.prepare('SELECT COUNT(*) FROM stock_movements').pluck().get(),
      journals: t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get(),
      inventoryGl: ledger.accountBalance(t.db, ACC.INVENTORY),
      trialBalance: ledger.trialBalance(t.db)
    }

    runMigrations(t.db)

    const after = {
      onHand: stock.onHand(t.db, productId),
      avgCost: stock.averageCost(t.db, productId),
      stockValue: t.db
        .prepare('SELECT COALESCE(SUM(value_minor), 0) FROM stock_movements')
        .pluck()
        .get(),
      movements: t.db.prepare('SELECT COUNT(*) FROM stock_movements').pluck().get(),
      journals: t.db.prepare('SELECT COUNT(*) FROM journals').pluck().get(),
      inventoryGl: ledger.accountBalance(t.db, ACC.INVENTORY),
      trialBalance: ledger.trialBalance(t.db)
    }

    expect(after).toEqual(before)
    expect(after.trialBalance.balanced).toBe(true)
  })

  /**
   * THE ONE THAT MATTERS. The upgrade finishes and the shop opens. Everything CLAUDE.md calls an
   * invariant has to hold on a database that was NOT created by today's migrations in one go.
   */
  it('sells the moment the upgrade finishes — books balance, GL Inventory === the stock valuation', () => {
    const actor = makeUser(t)
    const productId = shopWithStock(actor)

    runMigrations(t.db)

    const { sale } = sales.complete(t.db, actor, {
      lines: [{ productId, qtyM: 2 * ONE_UNIT }],
      payments: [{ methodLookupId: cashMethodId(), amount: 2 * PRICE_RS_100 }]
    })

    expect(sale.grandTotal).toBe(2 * PRICE_RS_100)
    expect(stock.onHand(t.db, productId)).toBe(8 * ONE_UNIT) // 10 − 2, derived from the movements

    // THE STANDING TEST (CLAUDE.md §4).
    const tb = ledger.trialBalance(t.db)
    expect(tb.balanced, 'THE TRIAL BALANCE DOES NOT BALANCE AFTER AN UPGRADE').toBe(true)

    // The books and the shelf agree — on an upgraded database, exactly as on a fresh one.
    const valuation = t.db
      .prepare('SELECT COALESCE(SUM(value_minor), 0) FROM stock_movements')
      .pluck()
      .get() as number
    expect(ledger.accountBalance(t.db, ACC.INVENTORY)).toBe(valuation)
    expect(stock.stockLevel(t.db, productId).stockValueMinor).toBe(valuation)
  })

  it('numbers the first invoices after the upgrade 1, 2, 3 — gapless, and a VOID keeps its number', () => {
    const actor = makeUser(t)
    const productId = shopWithStock(actor)

    runMigrations(t.db)

    const ring = (): string => {
      const { sale } = sales.complete(t.db, actor, {
        lines: [{ productId, qtyM: ONE_UNIT }],
        payments: [{ methodLookupId: cashMethodId(), amount: PRICE_RS_100 }]
      })
      return sale.invoiceNo!
    }

    const first = ring()
    const second = ring()

    // The counter starts at 1 on a shop that has never sold anything, and it does not skip.
    const seqs = t.db
      .prepare('SELECT invoice_seq FROM sales ORDER BY invoice_seq')
      .pluck()
      .all() as number[]
    expect(seqs).toEqual([1, 2])

    // Cancel the SECOND one. It keeps its number — 2 is not released and is never reused.
    const saleTwo = sales.getByInvoiceNo(t.db, { invoiceNo: second })
    const voided = sales.voidSale(t.db, actor, { id: saleTwo.id, reasonCode: 'wrong_item' })

    expect(voided.status).toBe('voided')
    expect(voided.invoiceNo).toBe(second) // IT KEEPS ITS NUMBER

    // ...and the next sale takes 3. A book that renumbers around a cancellation cannot be audited.
    const third = ring()
    expect(third).not.toBe(second)

    const after = t.db
      .prepare('SELECT invoice_seq FROM sales ORDER BY invoice_seq')
      .pluck()
      .all() as number[]
    expect(after).toEqual([1, 2, 3])
    expect(first).not.toBe(second)

    // A void reverses; it does not erase. The books still balance, and the stock came back.
    expect(ledger.trialBalance(t.db).balanced).toBe(true)
    expect(stock.onHand(t.db, productId)).toBe(8 * ONE_UNIT) // 10 − 1 − 1 + 1 (void) − 1
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
    //
    // `had_negative_stock` (migration 0007) is NOT a quantity and is not stock. It is the 0/1 FLAG
    // PLAN.md §1 requires — "warn, allow, FLAG" — recording THAT a sale went out against stock the
    // shop did not have, never HOW MUCH. It is caught here only because the rule above matches on the
    // NAME, and the name ends in "_stock". The exemption is EARNED, not asserted: the assertion below
    // proves the column cannot hold a quantity even if someone later tried to make it.
    const ALLOWED = new Set(['min_stock_m', 'qty_m', 'pack_size', 'had_negative_stock'])

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

    // THE FLAG IS A BOOLEAN, AND THE DATABASE SAYS SO. This is what pays for its place in ALLOWED
    // above: a CHECK constrains it to 0 or 1, so no future write path can quietly start storing "how
    // many units short we were" in a column the stock rule has been told to ignore.
    const actor = makeUser(t)
    const now = '2026-01-01T00:00:00.000Z'
    const insertSale = t.db.prepare(
      `INSERT INTO sales (at, user_id, status, had_negative_stock, created_at)
       VALUES (?, ?, 'held', ?, ?)`
    )

    insertSale.run(now, actor.id, 1, now) // a FLAG is fine
    expect(() => insertSale.run(now, actor.id, 5, now)) // a QUANTITY is not
      .toThrow(/CHECK constraint failed/i)

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
