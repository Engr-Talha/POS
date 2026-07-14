import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import * as customers from './customers'
import type { User } from '@shared/types'

/**
 * CUSTOMERS — minimal, and minimal on purpose. The ledger, loyalty and per-customer pricing are all
 * Phase 7. This exists now because opening udhaar has to be owed BY SOMEBODY.
 *
 * Two things are being defended here:
 *
 *   1. THERE IS NO BALANCE FIELD, and there never will be. What a customer owes is DERIVED from the
 *      ledger, exactly as stock is derived from the movements. A typed balance is a balance that can
 *      disagree with the invoices behind it — and then the shop chases a man for money he does not owe.
 *
 *   2. A SAVE WRITES ONLY WHAT THE FORM SENT. (CLAUDE.md trap #18.) The "quick edit the phone number"
 *      dialog never loaded the address or the credit limit. If it posted the whole object back, it
 *      would wipe both.
 */

const RS = 100 // 2-dp money minor units per rupee

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

function customerTypeId(t: TestDb, code: string): number {
  return t.db
    .prepare("SELECT id FROM lookups WHERE list_key = 'customer_type' AND code = ?")
    .pluck()
    .get(code) as number
}

describe('customers', () => {
  let t: TestDb
  let actor: User

  beforeEach(() => {
    t = makeTestDb({ withSeed: true })
    actor = makeUser(t)
  })

  afterEach(() => t.cleanup())

  // ── Create ─────────────────────────────────────────────────────────────────

  it('adds a customer, and the credit limit is a LIMIT — not a debt', () => {
    const customer = customers.create(t.db, actor, {
      name: 'Rashid',
      phone: '0300-1234567',
      address: 'Shop 4, Tariq Road',
      typeLookupId: customerTypeId(t, 'regular'),
      creditLimit: 20_000 * RS
    })

    expect(customer.id).toBeGreaterThan(0)
    expect(customer.name).toBe('Rashid')
    expect(customer.phone).toBe('0300-1234567')
    expect(customer.creditLimit).toBe(20_000 * RS)
    expect(customer.isActive).toBe(true)

    // What he OWES is nowhere on this object, and there is no column for it either. It is derived from
    // the ledger — that is the whole point.
    expect(customer).not.toHaveProperty('balance')

    const columns = t.db.prepare('PRAGMA table_info(customers)').all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).not.toContain('balance')
  })

  it('a customer needs a name, in words a cashier understands', () => {
    expectUserMessage(() => customers.create(t.db, actor, { name: '   ' }), /enter the customer name/i)
  })

  it('the customer type comes from the LOOKUPS list — never a hardcoded dropdown', () => {
    // A type the renderer invented, or one the owner has since retired, is not a type.
    expectUserMessage(
      () => customers.create(t.db, actor, { name: 'Rashid', typeLookupId: 9999 }),
      /choose a customer type from the list/i
    )

    const walkIn = customerTypeId(t, 'walk_in')
    t.db.prepare('UPDATE lookups SET is_active = 0 WHERE id = ?').run(walkIn)

    expectUserMessage(
      () => customers.create(t.db, actor, { name: 'Rashid', typeLookupId: walkIn }),
      /choose a customer type from the list/i
    )
  })

  it('two customers really can share a name — the phone number tells them apart', () => {
    // In a Pakistani neighbourhood shop this is not an edge case, it is Tuesday. Refusing the second
    // one would force the owner to invent a fake name for a real person.
    const first = customers.create(t.db, actor, { name: 'Muhammad Rashid', phone: '0300-1111111' })
    const second = customers.create(t.db, actor, { name: 'Muhammad Rashid', phone: '0300-2222222' })

    expect(second.id).not.toBe(first.id)
    expect(customers.list(t.db, { search: '0300-2222222' }).rows.map((row) => row.id)).toEqual([
      second.id
    ])
  })

  it('a new customer is audited — WHO added them and WHEN', () => {
    const customer = customers.create(t.db, actor, { name: 'Rashid' })

    const row = t.db
      .prepare(
        `SELECT user_id, user_name, user_role, entity, entity_id
           FROM audit_log WHERE action = 'customer.create'`
      )
      .get() as Record<string, string | number>

    expect(row['user_id']).toBe(actor.id)
    expect(row['user_name']).toBe('Meena Manager')
    expect(row['user_role']).toBe('manager') // copied in — a later promotion cannot rewrite history
    expect(row['entity']).toBe('customer')
    expect(row['entity_id']).toBe(String(customer.id))
  })

  // ── Update — trap #18 ──────────────────────────────────────────────────────

  it('SAVES ONLY THE FIELDS THE FORM SENT — a field it never loaded is not wiped', () => {
    const created = customers.create(t.db, actor, {
      name: 'Rashid',
      phone: '0300-1234567',
      address: 'Shop 4, Tariq Road',
      typeLookupId: customerTypeId(t, 'regular'),
      creditLimit: 20_000 * RS
    })

    // The "change the phone number" dialog. It never loaded the address, the type or the limit.
    const updated = customers.update(t.db, actor, { id: created.id, phone: '0321-9999999' })

    expect(updated.phone).toBe('0321-9999999')
    expect(updated.address).toBe('Shop 4, Tariq Road') // NOT wiped
    expect(updated.creditLimit).toBe(20_000 * RS) // NOT wiped
    expect(updated.typeLookupId).toBe(customerTypeId(t, 'regular')) // NOT wiped
    expect(updated.name).toBe('Rashid') // NOT wiped
  })

  it('null means the user CLEARED it; absent means the form never touched it', () => {
    const created = customers.create(t.db, actor, {
      name: 'Rashid',
      phone: '0300-1234567',
      address: 'Shop 4, Tariq Road'
    })

    const cleared = customers.update(t.db, actor, { id: created.id, address: null })

    expect(cleared.address).toBeNull() // cleared on purpose
    expect(cleared.phone).toBe('0300-1234567') // never touched
  })

  it('a credit limit of ZERO is a real answer — it is how an owner cuts a customer off', () => {
    const created = customers.create(t.db, actor, { name: 'Rashid', creditLimit: 20_000 * RS })

    // A truthiness test on the incoming fields would throw this away and leave the limit at 20,000 —
    // and the shop would keep lending to someone the owner had just stopped lending to.
    const updated = customers.update(t.db, actor, { id: created.id, creditLimit: 0 })

    expect(updated.creditLimit).toBe(0)
  })

  it('a customer is retired, never deleted — last year’s udhaar must still have a name on it', () => {
    const created = customers.create(t.db, actor, { name: 'Rashid' })

    const retired = customers.deactivate(t.db, actor, created.id)
    expect(retired.isActive).toBe(false)

    // Gone from the list a cashier picks from...
    expect(customers.list(t.db).rows.map((row) => row.id)).not.toContain(created.id)
    // ...but the row is still there, and still readable, forever.
    expect(customers.getById(t.db, created.id).name).toBe('Rashid')
    expect(customers.list(t.db, { includeInactive: true }).rows.map((row) => row.id)).toContain(
      created.id
    )
  })

  it('an edit is audited, and records only what actually changed', () => {
    const created = customers.create(t.db, actor, { name: 'Rashid', creditLimit: 20_000 * RS })
    customers.update(t.db, actor, { id: created.id, creditLimit: 5_000 * RS })

    const row = t.db
      .prepare(
        `SELECT before_json, after_json FROM audit_log WHERE action = 'customer.update'`
      )
      .get() as { before_json: string; after_json: string }

    expect(JSON.parse(row.before_json)).toEqual({ creditLimit: 20_000 * RS })
    expect(JSON.parse(row.after_json)).toEqual({ creditLimit: 5_000 * RS })
  })

  // ── Read ───────────────────────────────────────────────────────────────────

  it('an unknown customer says so plainly — never a stack trace', () => {
    expectUserMessage(() => customers.getById(t.db, 9999), /customer could not be found/i)
  })

  it('the list is PAGINATED and searchable — assume 100k rows, not 10', () => {
    for (let i = 1; i <= 55; i += 1) {
      customers.create(t.db, actor, {
        name: `Customer ${String(i).padStart(3, '0')}`,
        phone: `0300-${String(1_000_000 + i)}`
      })
    }

    const first = customers.list(t.db, { pageSize: 20 })
    expect(first.total).toBe(55)
    expect(first.rows).toHaveLength(20)
    expect(first.page).toBe(1)

    const last = customers.list(t.db, { page: 3, pageSize: 20 })
    expect(last.rows).toHaveLength(15)

    // No page ever runs unbounded, however high the page number.
    expect(customers.list(t.db, { page: 99, pageSize: 20 }).rows).toHaveLength(0)

    // Search matches the NAME...
    expect(customers.list(t.db, { search: 'Customer 007' }).total).toBe(1)
    // ...and the PHONE, which is what tells two Rashids apart.
    expect(customers.list(t.db, { search: '1000042' }).total).toBe(1)
  })

  it('a search for "50%" means the characters, not a wildcard', () => {
    customers.create(t.db, actor, { name: 'Discount 50% Wholesale' })
    customers.create(t.db, actor, { name: 'Rashid' })

    // Unescaped, `%` in LIKE matches everything — and the search would return the whole shop.
    expect(customers.list(t.db, { search: '50%' }).total).toBe(1)
  })
})
