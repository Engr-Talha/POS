import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import * as lookups from './lookups'
import { runMigrations, MIGRATIONS } from '../db/migrations'
import { seed } from '../db/seed'

describe('lookups — every dropdown in the app', () => {
  let t: TestDb
  beforeEach(() => (t = makeTestDb({ withSeed: true })))
  afterEach(() => t.cleanup())

  it('ships the lists a shop needs on day one', () => {
    const methods = lookups.list(t.db, 'payment_method').map((l) => l.code)
    expect(methods).toContain('cash')
    expect(methods).toContain('credit') // udhaar
    expect(methods).toContain('jazzcash')

    expect(lookups.list(t.db, 'void_reason').length).toBeGreaterThan(0)
    expect(lookups.list(t.db, 'expense_category').length).toBeGreaterThan(0)
  })

  it('lets the shop add its own options — the inline "+ add new"', () => {
    const added = lookups.add(t.db, { listKey: 'payment_method', label: 'SadaPay' })
    expect(added.code).toBe('sadapay')

    expect(lookups.list(t.db, 'payment_method').map((l) => l.label)).toContain('SadaPay')
  })

  it('refuses a duplicate, in plain language', () => {
    expectUserMessage(
      () => lookups.add(t.db, { listKey: 'payment_method', label: 'Cash' }),
      /already on this list/i
    )
  })

  it('lets the owner RENAME a built-in option', () => {
    // A Pakistani shopkeeper may want "Naqad" rather than "Cash". The label is theirs; the CODE is
    // ours, because the ledger posts on the code.
    const cash = lookups.list(t.db, 'payment_method').find((l) => l.code === 'cash')!
    const renamed = lookups.update(t.db, cash.id, { label: 'Naqad' })

    expect(renamed.label).toBe('Naqad')
    expect(renamed.code).toBe('cash') // unchanged — the ledger still knows what this is
  })

  it('REFUSES to delete a built-in option the ledger depends on', () => {
    const cash = lookups.list(t.db, 'payment_method').find((l) => l.code === 'cash')!
    expectUserMessage(() => lookups.deactivate(t.db, cash.id), /built in|cannot be removed/i)
  })

  it('deactivates rather than deletes, so last year’s sale can still name it', () => {
    const custom = lookups.add(t.db, { listKey: 'payment_method', label: 'SadaPay' })
    lookups.deactivate(t.db, custom.id)

    // Gone from the dropdown...
    expect(lookups.list(t.db, 'payment_method').map((l) => l.code)).not.toContain('sadapay')
    // ...but the row survives, so an old receipt that points at it can still be printed.
    expect(lookups.list(t.db, 'payment_method', true).map((l) => l.code)).toContain('sadapay')
  })

  it('seeding twice never duplicates or resets an owner’s edits', () => {
    const cash = lookups.list(t.db, 'payment_method').find((l) => l.code === 'cash')!
    lookups.update(t.db, cash.id, { label: 'Naqad' })

    seed(t.db) // e.g. the app restarts

    const after = lookups.list(t.db, 'payment_method').filter((l) => l.code === 'cash')
    expect(after).toHaveLength(1) // not duplicated
    expect(after[0]!.label).toBe('Naqad') // not reset
  })
})

describe('migrations', () => {
  it('are forward-only, recorded, and safe to run again', () => {
    const t = makeTestDb({ migrate: false })

    // Derived from MIGRATIONS, not a hardcoded [1, 2]: adding a migration must not break this test,
    // or the next person to add one "fixes" it by editing the number and stops reading what it says.
    // What it asserts is the RULE — every migration runs exactly once, in ascending order — and that
    // stays true at 3 migrations and at 30.
    const versions = MIGRATIONS.map((m) => m.version).sort((a, b) => a - b)
    const latest = versions[versions.length - 1]!

    const first = runMigrations(t.db)
    expect(first.applied).toEqual(versions)

    // Running again applies nothing — the app runs this on EVERY launch.
    const second = runMigrations(t.db)
    expect(second.applied).toEqual([])
    expect(second.alreadyAt).toBe(latest)

    t.cleanup()
  })
})
