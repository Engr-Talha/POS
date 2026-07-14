import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import * as auth from './auth'
import * as audit from './audit'
import { hashSecret } from '../security/password'
import type { Role } from '@shared/rbac'
import { roleCan } from '@shared/rbac'

function addUser(t: TestDb, username: string, role: Role, password: string, pin?: string): number {
  const info = t.db
    .prepare(
      `INSERT INTO users (username, full_name, role, password_hash, pin_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
    .run(username, username.toUpperCase(), role, hashSecret(password), pin ? hashSecret(pin) : null)
  return Number(info.lastInsertRowid)
}

describe('auth', () => {
  let t: TestDb
  beforeEach(() => (t = makeTestDb()))
  afterEach(() => t.cleanup())

  it('a fresh install has no users and asks for an Owner — no default password is ever shipped', () => {
    // A shipped default password is a shipped back door, and this one opens a shop's books.
    expect(auth.needsFirstUser(t.db)).toBe(true)

    const owner = auth.createFirstOwner(t.db, {
      username: 'talha',
      fullName: 'Talha',
      password: 'correct-horse'
    })

    expect(owner.role).toBe('owner')
    expect(auth.needsFirstUser(t.db)).toBe(false)
  })

  it('refuses a second "first owner"', () => {
    auth.createFirstOwner(t.db, { username: 'a', fullName: 'A', password: 'password1' })
    expectUserMessage(
      () => auth.createFirstOwner(t.db, { username: 'b', fullName: 'B', password: 'password2' }),
      /already has an owner/i
    )
  })

  it('signs in with the right password and rejects the wrong one', () => {
    addUser(t, 'sara', 'cashier', 'letmein123')

    expect(auth.signIn(t.db, 'sara', 'letmein123').username).toBe('sara')
    expectUserMessage(() => auth.signIn(t.db, 'sara', 'wrong'), /username or password/i)
  })

  it('gives the SAME message for a bad username as for a bad password', () => {
    // Telling an attacker which half they got right hands them a list of valid usernames.
    addUser(t, 'sara', 'cashier', 'letmein123')

    const badUser = (): unknown => auth.signIn(t.db, 'nobody', 'letmein123')
    const badPass = (): unknown => auth.signIn(t.db, 'sara', 'nope')

    expectUserMessage(badUser, /username or password is not correct/i)
    expectUserMessage(badPass, /username or password is not correct/i)
  })

  it('never stores the password itself', () => {
    addUser(t, 'sara', 'cashier', 'letmein123')
    const stored = t.db.prepare('SELECT password_hash FROM users WHERE username = ?').pluck().get('sara') as string

    expect(stored).not.toContain('letmein123')
    expect(stored.startsWith('scrypt$')).toBe(true)
  })

  it('a deactivated user cannot sign in', () => {
    addUser(t, 'sacked', 'cashier', 'letmein123')
    t.db.prepare('UPDATE users SET is_active = 0 WHERE username = ?').run('sacked')
    expect(() => auth.signIn(t.db, 'sacked', 'letmein123')).toThrow()
  })

  it('the PIN quick-switch identifies the cashier at the counter', () => {
    addUser(t, 'sara', 'cashier', 'letmein123', '4821')
    expect(auth.signInWithPin(t.db, '4821').username).toBe('sara')
    expectUserMessage(() => auth.signInWithPin(t.db, '0000'), /PIN is not recognised/i)
  })

  it('records every sign-in in the audit log', () => {
    addUser(t, 'sara', 'cashier', 'letmein123')
    auth.signIn(t.db, 'sara', 'letmein123')

    const { rows } = audit.list(t.db)
    expect(rows[0]).toMatchObject({ action: 'user.sign_in', userName: 'SARA', userRole: 'cashier' })
  })
})

describe('RBAC — enforced in MAIN, not by hiding buttons', () => {
  let t: TestDb
  beforeEach(() => (t = makeTestDb()))
  afterEach(() => t.cleanup())

  it('a Cashier cannot void, refund, or reach settings — even calling the service directly', () => {
    // This is the real test: it bypasses the UI entirely, exactly as a tampered renderer would.
    const cashier = auth.getById(t.db, addUser(t, 'sara', 'cashier', 'letmein123'))

    expectUserMessage(() => auth.requirePermission(cashier, 'sale.void'), /permission/i)
    expect(() => auth.requirePermission(cashier, 'sale.refund')).toThrow(/permission/i)
    expect(() => auth.requirePermission(cashier, 'settings.manage')).toThrow(/permission/i)
    expect(() => auth.requirePermission(cashier, 'product.manage')).toThrow(/permission/i)

    // ...but they CAN do the job they are there to do.
    expect(() => auth.requirePermission(cashier, 'sale.create')).not.toThrow()
  })

  it('a Supervisor can void and refund but cannot manage users or restore a backup', () => {
    const supervisor = auth.getById(t.db, addUser(t, 'sup', 'supervisor', 'letmein123'))

    expect(() => auth.requirePermission(supervisor, 'sale.void')).not.toThrow()
    expect(() => auth.requirePermission(supervisor, 'sale.refund')).not.toThrow()
    expect(() => auth.requirePermission(supervisor, 'user.manage')).toThrow()
    expect(() => auth.requirePermission(supervisor, 'backup.restore')).toThrow()
  })

  it('an Owner can do everything', () => {
    const owner = auth.getById(t.db, addUser(t, 'boss', 'owner', 'letmein123'))
    for (const permission of [
      'sale.create',
      'sale.void',
      'product.manage',
      'user.manage',
      'settings.manage',
      'period.unlock',
      'backup.restore'
    ] as const) {
      expect(() => auth.requirePermission(owner, permission)).not.toThrow()
    }
  })

  it('roles are a ladder — a higher role has every power of a lower one', () => {
    expect(roleCan('owner', 'sale.create')).toBe(true)
    expect(roleCan('manager', 'sale.void')).toBe(true) // manager outranks supervisor
    expect(roleCan('cashier', 'sale.void')).toBe(false)
  })

  it('ONLY the Owner may restore a backup — it overwrites the shop’s live data', () => {
    const manager = auth.getById(t.db, addUser(t, 'mgr', 'manager', 'letmein123'))
    expect(() => auth.requirePermission(manager, 'backup.run')).not.toThrow() // may back UP
    expect(() => auth.requirePermission(manager, 'backup.restore')).toThrow() // may not overwrite
  })
})
