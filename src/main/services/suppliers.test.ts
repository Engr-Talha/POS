import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import * as suppliers from './suppliers'
import type { User } from '@shared/types'

/**
 * SUPPLIERS — the buying-side mirror of customers. Who the shop buys from, and who it owes money to.
 *
 * Two things are being defended here, exactly as on the customer side:
 *
 *   1. THERE IS NO BALANCE FIELD, and there never will be. What the shop owes a supplier is DERIVED
 *      from the ledger (opening payable + purchase payables − payments), exactly as stock is derived
 *      from movements. A typed balance is a balance that can disagree with the bills behind it — and
 *      then the shop pays a supplier money the ledger says it does not owe.
 *
 *   2. A SAVE WRITES ONLY WHAT THE FORM SENT. (CLAUDE.md trap #18.) The "quick edit the phone number"
 *      dialog never loaded the address or the type. If it posted the whole object back, it would wipe
 *      both.
 */

function makeUser(t: TestDb, role: User['role'] = 'manager'): User {
  const now = new Date().toISOString()
  const id = Number(
    t.db
      .prepare(
        `INSERT INTO users (username, full_name, role, password_hash, is_active, created_at, updated_at)
         VALUES ('meena', 'Meena Manager', ?, 'x', 1, ?, ?)`
      )
      .run(role, now, now).lastInsertRowid
  )
  return { id, username: 'meena', fullName: 'Meena Manager', role, hasPin: false, isActive: true }
}

function supplierTypeId(t: TestDb, code: string): number {
  return t.db
    .prepare("SELECT id FROM lookups WHERE list_key = 'supplier_type' AND code = ?")
    .pluck()
    .get(code) as number
}

describe('suppliers', () => {
  let t: TestDb
  let actor: User

  beforeEach(() => {
    t = makeTestDb({ withSeed: true })
    actor = makeUser(t)
  })

  afterEach(() => t.cleanup())

  // ── Create ─────────────────────────────────────────────────────────────────

  it('adds a supplier, and there is no balance on it — that is derived from the ledger', () => {
    const supplier = suppliers.create(t.db, actor, {
      name: 'Unilever Distributor',
      phone: '0300-1234567',
      address: 'Plot 12, SITE Area',
      typeLookupId: supplierTypeId(t, 'distributor')
    })

    expect(supplier.id).toBeGreaterThan(0)
    expect(supplier.name).toBe('Unilever Distributor')
    expect(supplier.phone).toBe('0300-1234567')
    expect(supplier.typeLookupId).toBe(supplierTypeId(t, 'distributor'))
    expect(supplier.isActive).toBe(true)

    // What the shop OWES them is nowhere on this object, and there is no column for it either.
    expect(supplier).not.toHaveProperty('balance')
    const columns = t.db.prepare('PRAGMA table_info(suppliers)').all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).not.toContain('balance')
  })

  it('a supplier needs a name, in words a person understands', () => {
    expectUserMessage(() => suppliers.create(t.db, actor, { name: '   ' }), /enter the supplier name/i)
  })

  it('the supplier type comes from the LOOKUPS list — never a hardcoded dropdown', () => {
    expectUserMessage(
      () => suppliers.create(t.db, actor, { name: 'Acme', typeLookupId: 9999 }),
      /choose a supplier type from the list/i
    )

    const local = supplierTypeId(t, 'local')
    t.db.prepare('UPDATE lookups SET is_active = 0 WHERE id = ?').run(local)

    expectUserMessage(
      () => suppliers.create(t.db, actor, { name: 'Acme', typeLookupId: local }),
      /choose a supplier type from the list/i
    )
  })

  it('two suppliers really can share a name — the phone number tells them apart', () => {
    const first = suppliers.create(t.db, actor, { name: 'Al-Rahman Traders', phone: '0300-1111111' })
    const second = suppliers.create(t.db, actor, { name: 'Al-Rahman Traders', phone: '0300-2222222' })

    expect(second.id).not.toBe(first.id)
    expect(suppliers.list(t.db, { search: '0300-2222222' }).rows.map((row) => row.id)).toEqual([
      second.id
    ])
  })

  it('a new supplier is audited — WHO added them and WHEN', () => {
    const supplier = suppliers.create(t.db, actor, { name: 'Acme' })

    const row = t.db
      .prepare(
        `SELECT user_id, user_name, user_role, entity, entity_id
           FROM audit_log WHERE action = 'supplier.create'`
      )
      .get() as Record<string, string | number>

    expect(row['user_id']).toBe(actor.id)
    expect(row['user_name']).toBe('Meena Manager')
    expect(row['user_role']).toBe('manager') // copied in — a later promotion cannot rewrite history
    expect(row['entity']).toBe('supplier')
    expect(row['entity_id']).toBe(String(supplier.id))
  })

  // ── Update — trap #18 ──────────────────────────────────────────────────────

  it('SAVES ONLY THE FIELDS THE FORM SENT — a field it never loaded is not wiped', () => {
    const created = suppliers.create(t.db, actor, {
      name: 'Acme',
      phone: '0300-1234567',
      address: 'Plot 12, SITE Area',
      typeLookupId: supplierTypeId(t, 'distributor')
    })

    // The "change the phone number" dialog. It never loaded the address or the type.
    const updated = suppliers.update(t.db, actor, { id: created.id, phone: '0321-9999999' })

    expect(updated.phone).toBe('0321-9999999')
    expect(updated.address).toBe('Plot 12, SITE Area') // NOT wiped
    expect(updated.typeLookupId).toBe(supplierTypeId(t, 'distributor')) // NOT wiped
    expect(updated.name).toBe('Acme') // NOT wiped
  })

  it('null means the user CLEARED it; absent means the form never touched it', () => {
    const created = suppliers.create(t.db, actor, {
      name: 'Acme',
      phone: '0300-1234567',
      address: 'Plot 12, SITE Area'
    })

    const cleared = suppliers.update(t.db, actor, { id: created.id, address: null })

    expect(cleared.address).toBeNull() // cleared on purpose
    expect(cleared.phone).toBe('0300-1234567') // never touched
  })

  it('a supplier is retired, never deleted — last year’s purchase must still have a name on it', () => {
    const created = suppliers.create(t.db, actor, { name: 'Acme' })

    const retired = suppliers.deactivate(t.db, actor, created.id)
    expect(retired.isActive).toBe(false)

    // Gone from the pick list...
    expect(suppliers.list(t.db).rows.map((row) => row.id)).not.toContain(created.id)
    // ...but the row is still there, and still readable, forever.
    expect(suppliers.getById(t.db, created.id).name).toBe('Acme')
    expect(suppliers.list(t.db, { includeInactive: true }).rows.map((row) => row.id)).toContain(
      created.id
    )
  })

  it('an edit is audited, and records only what actually changed', () => {
    const created = suppliers.create(t.db, actor, { name: 'Acme', phone: '0300-1111111' })
    suppliers.update(t.db, actor, { id: created.id, phone: '0300-2222222' })

    const row = t.db
      .prepare(`SELECT before_json, after_json FROM audit_log WHERE action = 'supplier.update'`)
      .get() as { before_json: string; after_json: string }

    expect(JSON.parse(row.before_json)).toEqual({ phone: '0300-1111111' })
    expect(JSON.parse(row.after_json)).toEqual({ phone: '0300-2222222' })
  })

  // ── Read ───────────────────────────────────────────────────────────────────

  it('an unknown supplier says so plainly — never a stack trace', () => {
    expectUserMessage(() => suppliers.getById(t.db, 9999), /supplier could not be found/i)
  })

  it('the list is PAGINATED and searchable — assume 100k rows, not 10', () => {
    for (let i = 1; i <= 55; i += 1) {
      suppliers.create(t.db, actor, {
        name: `Supplier ${String(i).padStart(3, '0')}`,
        phone: `0300-${String(1_000_000 + i)}`
      })
    }

    const first = suppliers.list(t.db, { pageSize: 20 })
    expect(first.total).toBe(55)
    expect(first.rows).toHaveLength(20)
    expect(first.page).toBe(1)

    const last = suppliers.list(t.db, { page: 3, pageSize: 20 })
    expect(last.rows).toHaveLength(15)

    // No page ever runs unbounded, however high the page number.
    expect(suppliers.list(t.db, { page: 99, pageSize: 20 }).rows).toHaveLength(0)

    // Search matches the NAME...
    expect(suppliers.list(t.db, { search: 'Supplier 007' }).total).toBe(1)
    // ...and the PHONE, which is what tells two of them apart.
    expect(suppliers.list(t.db, { search: '1000042' }).total).toBe(1)
  })

  it('a search for "50%" means the characters, not a wildcard', () => {
    suppliers.create(t.db, actor, { name: 'Discount 50% Wholesale' })
    suppliers.create(t.db, actor, { name: 'Acme' })

    // Unescaped, `%` in LIKE matches everything — and the search would return every supplier.
    expect(suppliers.list(t.db, { search: '50%' }).total).toBe(1)
  })
})
