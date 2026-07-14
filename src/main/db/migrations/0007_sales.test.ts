import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, type TestDb } from '../testkit'
import { formatInvoiceNo } from '@shared/sales'

/**
 * 0007 — the selling schema, proved.
 *
 * The CHECK constraints in this migration are LOAD-BEARING, and every one of them guards something a
 * service could otherwise get wrong quietly:
 *
 *   a held cart holding an invoice number      ->  a GAP in the book (what an inspector looks for)
 *   a void releasing its number                ->  a book that renumbers around a cancellation
 *   a void with no reason                      ->  an audit log not worth reading
 *   gross != net + tax                         ->  a receipt that does not add up
 *   an "open item" that also has a product     ->  a report that silently drops the row
 *
 * These are asserted against the DATABASE, not against a service, because that is the level they are
 * enforced at — a rule that lives only in a service is a rule the next service forgets.
 */

const NOW = '2026-01-01T10:00:00.000Z'

function mkUser(t: TestDb): number {
  return Number(
    t.db
      .prepare(
        `INSERT INTO users (username, full_name, role, password_hash, is_active, created_at, updated_at)
         VALUES ('cash', 'Cashier', 'cashier', 'x', 1, ?, ?)`
      )
      .run(NOW, NOW).lastInsertRowid
  )
}

function mkProduct(t: TestDb): number {
  const uomId = t.db
    .prepare("SELECT id FROM lookups WHERE list_key = 'uom' AND code = 'pcs'")
    .pluck()
    .get() as number
  return Number(
    t.db
      .prepare(
        `INSERT INTO products (sku, name, sale_uom_id, item_type, is_active, created_at, updated_at)
         VALUES ('P1', 'Tin of Beans', ?, 'inventory', 1, ?, ?)`
      )
      .run(uomId, NOW, NOW).lastInsertRowid
  )
}

/** A completed sale with a number. Returns its id. */
function completedSale(t: TestDb, userId: number, seq: number): number {
  return Number(
    t.db
      .prepare(
        `INSERT INTO sales (invoice_no, invoice_seq, invoice_year, at, user_id, status,
                            subtotal_net, tax_total, grand_total, paid_total, created_at)
         VALUES (?, ?, 2026, ?, ?, 'completed', 10000, 1700, 11700, 11700, ?)`
      )
      .run(`INV-2026-${String(seq).padStart(6, '0')}`, seq, NOW, userId, NOW).lastInsertRowid
  )
}

describe('0007 — the schema enforces the selling invariants', () => {
  let t: TestDb
  let userId: number

  beforeEach(() => {
    t = makeTestDb({ withSeed: true })
    userId = mkUser(t)
  })
  afterEach(() => t.cleanup())

  it('every table and index exists', () => {
    const tables = t.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .pluck()
      .all() as string[]
    expect(tables).toEqual(
      expect.arrayContaining(['sales', 'sale_lines', 'sale_payments', 'invoice_counters', 'sync_queue'])
    )
    const indexes = t.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_sale%'")
      .pluck()
      .all() as string[]
    expect(indexes.length).toBeGreaterThanOrEqual(9)
  })

  // ── GAPLESS NUMBERING ──────────────────────────────────────────────────────
  it('a HELD cart cannot hold an invoice number — that is what keeps numbering gapless', () => {
    expect(() =>
      t.db
        .prepare(
          `INSERT INTO sales (invoice_no, invoice_seq, invoice_year, at, user_id, status, created_at)
           VALUES ('INV-2026-000001', 1, 2026, ?, ?, 'held', ?)`
        )
        .run(NOW, userId, NOW)
    ).toThrow(/CHECK constraint failed/i)
  })

  it('a QUOTE cannot hold an invoice number either', () => {
    expect(() =>
      t.db
        .prepare(
          `INSERT INTO sales (invoice_no, invoice_seq, invoice_year, at, user_id, status, created_at)
           VALUES ('INV-2026-000002', 2, 2026, ?, ?, 'quote', ?)`
        )
        .run(NOW, userId, NOW)
    ).toThrow(/CHECK constraint failed/i)
  })

  it('a COMPLETED sale MUST have a number', () => {
    expect(() =>
      t.db
        .prepare(
          `INSERT INTO sales (at, user_id, status, created_at) VALUES (?, ?, 'completed', ?)`
        )
        .run(NOW, userId, NOW)
    ).toThrow(/CHECK constraint failed/i)
  })

  it('an invoice number is issued ONCE — it can never be reused', () => {
    completedSale(t, userId, 1)
    expect(() => completedSale(t, userId, 1)).toThrow(/UNIQUE constraint failed/i)
  })

  it('a VOIDED sale KEEPS its number, and carries who/when/why', () => {
    const id = completedSale(t, userId, 7)
    t.db
      .prepare(
        `UPDATE sales SET status = 'voided', voided_at = ?, voided_by = ?, void_reason_code = 'wrong_item'
         WHERE id = ?`
      )
      .run(NOW, userId, id)

    const row = t.db.prepare('SELECT invoice_no, status FROM sales WHERE id = ?').get(id) as {
      invoice_no: string
      status: string
    }
    expect(row.status).toBe('voided')
    expect(row.invoice_no).toBe('INV-2026-000007') // NOT released, NOT renumbered
  })

  it('a void WITHOUT a reason code is refused by the database', () => {
    const id = completedSale(t, userId, 8)
    expect(() =>
      t.db
        .prepare(`UPDATE sales SET status = 'voided', voided_at = ?, voided_by = ? WHERE id = ?`)
        .run(NOW, userId, id)
    ).toThrow(/CHECK constraint failed/i)
  })

  // ── FROZEN LINE MONEY ──────────────────────────────────────────────────────
  it('a line whose gross does not equal net + tax is refused — the receipt must add up', () => {
    const saleId = completedSale(t, userId, 10)
    const productId = mkProduct(t)

    const insert = (net: number, tax: number, gross: number) =>
      t.db
        .prepare(
          `INSERT INTO sale_lines (sale_id, product_id, name_snapshot, qty_m, unit_price,
                                   net, tax_rate_bp, tax_amount, gross, tax_mode, created_at)
           VALUES (?, ?, 'Tin of Beans', 1000, 10000, ?, 1700, ?, ?, 'exclusive', ?)`
        )
        .run(saleId, productId, net, tax, gross, NOW)

    insert(10000, 1700, 11700) // adds up
    expect(() => insert(10000, 1700, 99999)).toThrow(/CHECK constraint failed/i) // does not
  })

  it('an OPEN ITEM has no product, and a catalogued line must have one', () => {
    const saleId = completedSale(t, userId, 11)
    const productId = mkProduct(t)

    const insert = (pid: number | null, isOpen: number) =>
      t.db
        .prepare(
          `INSERT INTO sale_lines (sale_id, product_id, name_snapshot, qty_m, unit_price,
                                   net, tax_rate_bp, tax_amount, gross, tax_mode, is_open_item, created_at)
           VALUES (?, ?, 'Misc', 1000, 5000, 5000, 0, 0, 5000, 'inclusive', ?, ?)`
        )
        .run(saleId, pid, isOpen, NOW)

    insert(null, 1) // open item, no product      -> fine
    insert(productId, 0) // catalogued, has product -> fine
    expect(() => insert(productId, 1)).toThrow(/CHECK constraint failed/i) // open AND a product
    expect(() => insert(null, 0)).toThrow(/CHECK constraint failed/i) // catalogued but nothing behind it
  })

  it('a sale line cannot sell zero or a negative quantity', () => {
    const saleId = completedSale(t, userId, 12)
    const productId = mkProduct(t)
    const insert = (qtyM: number) =>
      t.db
        .prepare(
          `INSERT INTO sale_lines (sale_id, product_id, name_snapshot, qty_m, unit_price,
                                   net, tax_rate_bp, tax_amount, gross, tax_mode, created_at)
           VALUES (?, ?, 'Tin', ?, 10000, 10000, 0, 0, 10000, 'exclusive', ?)`
        )
        .run(saleId, productId, qtyM, NOW)

    expect(() => insert(0)).toThrow(/CHECK constraint failed/i)
    expect(() => insert(-1000)).toThrow(/CHECK constraint failed/i)
  })

  // ── PAYMENTS ───────────────────────────────────────────────────────────────
  it('a split payment is several rows, and a zero payment is refused', () => {
    const saleId = completedSale(t, userId, 13)
    const cash = t.db
      .prepare("SELECT id FROM lookups WHERE list_key = 'payment_method' AND code = 'cash'")
      .pluck()
      .get() as number
    const card = t.db
      .prepare("SELECT id FROM lookups WHERE list_key = 'payment_method' AND code = 'card'")
      .pluck()
      .get() as number

    const pay = (methodId: number, amount: number) =>
      t.db
        .prepare(
          `INSERT INTO sale_payments (sale_id, method_lookup_id, amount, created_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(saleId, methodId, amount, NOW)

    pay(cash, 20000)
    pay(card, 26000)
    expect(
      t.db.prepare('SELECT SUM(amount) FROM sale_payments WHERE sale_id = ?').pluck().get(saleId)
    ).toBe(46000)

    expect(() => pay(cash, 0)).toThrow(/CHECK constraint failed/i)
  })

  // ── CASCADE ────────────────────────────────────────────────────────────────
  it('discarding a HELD cart takes its lines and payments with it — no orphans', () => {
    const saleId = Number(
      t.db
        .prepare(
          `INSERT INTO sales (at, user_id, status, created_at) VALUES (?, ?, 'held', ?)`
        )
        .run(NOW, userId, NOW).lastInsertRowid
    )
    const productId = mkProduct(t)
    const cash = t.db
      .prepare("SELECT id FROM lookups WHERE list_key = 'payment_method' AND code = 'cash'")
      .pluck()
      .get() as number

    t.db
      .prepare(
        `INSERT INTO sale_lines (sale_id, product_id, name_snapshot, qty_m, unit_price,
                                 net, tax_rate_bp, tax_amount, gross, tax_mode, created_at)
         VALUES (?, ?, 'Tin', 1000, 10000, 10000, 0, 0, 10000, 'exclusive', ?)`
      )
      .run(saleId, productId, NOW)
    t.db
      .prepare(
        `INSERT INTO sale_payments (sale_id, method_lookup_id, amount, created_at) VALUES (?, ?, 100, ?)`
      )
      .run(saleId, cash, NOW)

    t.db.prepare('DELETE FROM sales WHERE id = ?').run(saleId)

    expect(t.db.prepare('SELECT COUNT(*) FROM sale_lines').pluck().get()).toBe(0)
    expect(t.db.prepare('SELECT COUNT(*) FROM sale_payments').pluck().get()).toBe(0)
  })

  // ── COUNTERS ───────────────────────────────────────────────────────────────
  it('invoice_counters is keyed (series, year)', () => {
    const ins = t.db.prepare(
      `INSERT INTO invoice_counters (series, year, next_seq, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    ins.run('sale', 2026, 1, NOW, NOW)
    ins.run('sale', 2027, 1, NOW, NOW) // a different YEAR is a different counter
    expect(() => ins.run('sale', 2026, 1, NOW, NOW)).toThrow(/UNIQUE constraint failed/i)
  })

  // ── THE FORMATTER ──────────────────────────────────────────────────────────
  it('formatInvoiceNo builds the number from the settings that define it', () => {
    expect(
      formatInvoiceNo({ prefix: 'INV-', padding: 6, includeYear: true, year: 2026, seq: 1 })
    ).toBe('INV-2026-000001')
    expect(
      formatInvoiceNo({ prefix: 'INV-', padding: 6, includeYear: false, year: 2026, seq: 123 })
    ).toBe('INV-000123')
    expect(formatInvoiceNo({ prefix: '', padding: 1, includeYear: false, year: 2026, seq: 42 })).toBe(
      '42'
    )
  })
})
