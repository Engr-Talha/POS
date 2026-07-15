import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import * as users from './users'
import * as auth from './auth'
import * as settings from './settings'
import type { User } from '@shared/types'

/**
 * USER ADMINISTRATION — the Owner managing staff.
 *
 * The things being defended, each with a test:
 *   - a created cashier can actually sign in afterwards (this service and auth agree on the hashing);
 *   - the shop can never be left without an owner (last owner cannot be demoted or deactivated);
 *   - a username is unique and a password meets the shop's minimum length;
 *   - a PIN identifies exactly one person (no two active users share one) and clearing it works;
 *   - the list is paginated and shows retired staff too, so they can be reactivated;
 *   - a user is NEVER deleted — only retired.
 */

describe('users — staff administration', () => {
  let t: TestDb
  let owner: User

  beforeEach(() => {
    t = makeTestDb()
    // A real owner row, so the audit log's foreign key to users(id) holds and the actor is genuine.
    owner = auth.createFirstOwner(t.db, {
      username: 'boss',
      fullName: 'Big Boss',
      password: 'owner-pass-1'
    })
  })

  afterEach(() => t.cleanup())

  // ── Create + sign in ─────────────────────────────────────────────────────────

  it('creates a cashier who can then sign in with the new password', () => {
    const created = users.create(t.db, owner, {
      username: 'Sara', // stored lowercased — one identity, not two
      fullName: 'Sara Cashier',
      role: 'cashier',
      password: 'letmein123'
    })

    expect(created.role).toBe('cashier')
    expect(created.username).toBe('sara')
    expect(created.isActive).toBe(true)
    expect(created.hasPin).toBe(false) // brand-new user has no PIN until one is set

    // The real proof this service and auth agree on hashing: the new person can sign in.
    const signedIn = auth.signIn(t.db, 'sara', 'letmein123')
    expect(signedIn.id).toBe(created.id)
  })

  it('records WHO created the staff member', () => {
    const created = users.create(t.db, owner, {
      username: 'sara',
      fullName: 'Sara Cashier',
      role: 'cashier',
      password: 'letmein123'
    })

    const row = t.db
      .prepare(
        `SELECT user_id, user_name, user_role, entity, entity_id
           FROM audit_log WHERE action = 'user.create' AND entity_id = ?`
      )
      .get(String(created.id)) as Record<string, unknown>

    expect(row).toMatchObject({
      user_id: owner.id,
      user_name: 'Big Boss',
      user_role: 'owner', // copied in — a later change to the owner cannot rewrite history
      entity: 'user'
    })
  })

  it('never writes the password into the audit log', () => {
    users.create(t.db, owner, {
      username: 'sara',
      fullName: 'Sara Cashier',
      role: 'cashier',
      password: 'super-secret-pass'
    })

    const hits = t.db
      .prepare("SELECT COUNT(*) FROM audit_log WHERE after_json LIKE '%super-secret-pass%'")
      .pluck()
      .get() as number
    expect(hits).toBe(0)
  })

  // ── Duplicate username + password strength ───────────────────────────────────

  it('refuses a duplicate username — even in a different case', () => {
    users.create(t.db, owner, { username: 'sara', fullName: 'Sara', role: 'cashier', password: 'letmein123' })

    expectUserMessage(
      () => users.create(t.db, owner, { username: 'Sara', fullName: 'Other Sara', role: 'cashier', password: 'letmein123' }),
      /username is already taken/i
    )
  })

  it('refuses a password shorter than the minimum', () => {
    expectUserMessage(
      () => users.create(t.db, owner, { username: 'sara', fullName: 'Sara', role: 'cashier', password: 'short' }),
      /at least 8 characters/i
    )
  })

  it('honours the configured minimum password length, not a hardcoded 8', () => {
    settings.set(t.db, 'security.minPasswordLength', 12)

    expectUserMessage(
      () => users.create(t.db, owner, { username: 'sara', fullName: 'Sara', role: 'cashier', password: 'elevenchar' }), // 10
      /at least 12 characters/i
    )

    // 12 characters is now accepted.
    const ok = users.create(t.db, owner, { username: 'ali', fullName: 'Ali', role: 'cashier', password: 'twelvecharss' })
    expect(ok.username).toBe('ali')
  })

  it('a staff member needs a name and a valid role', () => {
    expectUserMessage(
      () => users.create(t.db, owner, { username: 'sara', fullName: '   ', role: 'cashier', password: 'letmein123' }),
      /enter the full name/i
    )
    expect(() =>
      users.create(t.db, owner, { username: 'sara', fullName: 'Sara', role: 'wizard', password: 'letmein123' })
    ).toThrow()
  })

  // ── The last owner is protected ──────────────────────────────────────────────

  it('the last active owner cannot be demoted, and cannot be deactivated', () => {
    // `owner` is the shop's only owner.
    expectUserMessage(() => users.update(t.db, owner, owner.id, { role: 'manager' }), /only owner/i)
    expectUserMessage(() => users.deactivate(t.db, owner, owner.id), /only owner/i)

    // Neither refusal changed anything: still an active owner.
    const still = users.list(t.db).rows.find((u) => u.id === owner.id)
    expect(still?.role).toBe('owner')
    expect(still?.isActive).toBe(true)
  })

  it('an owner CAN be demoted or deactivated once a second owner exists', () => {
    const second = users.create(t.db, owner, {
      username: 'coowner',
      fullName: 'Co Owner',
      role: 'owner',
      password: 'owner-pass-2'
    })

    // With two active owners, deactivating one is allowed.
    const retired = users.deactivate(t.db, owner, owner.id)
    expect(retired.isActive).toBe(false)

    // Now `second` is the last active owner — and is protected again.
    expectUserMessage(() => users.update(t.db, second, second.id, { role: 'manager' }), /only owner/i)
    expectUserMessage(() => users.deactivate(t.db, second, second.id), /only owner/i)
  })

  // ── Update writes only what was sent (trap #18) ──────────────────────────────

  it('updates only the fields sent — changing the name leaves the role alone', () => {
    const sara = users.create(t.db, owner, { username: 'sara', fullName: 'Sara', role: 'cashier', password: 'letmein123' })

    const updated = users.update(t.db, owner, sara.id, { fullName: 'Sara Khan' })

    expect(updated.fullName).toBe('Sara Khan')
    expect(updated.role).toBe('cashier') // never loaded by a rename dialog, never touched
    expect(updated.username).toBe('sara')
  })

  it('promotes a cashier to manager, and records the change', () => {
    const sara = users.create(t.db, owner, { username: 'sara', fullName: 'Sara', role: 'cashier', password: 'letmein123' })

    const promoted = users.update(t.db, owner, sara.id, { role: 'manager' })
    expect(promoted.role).toBe('manager')

    const row = t.db
      .prepare("SELECT before_json, after_json FROM audit_log WHERE action = 'user.update' AND entity_id = ?")
      .get(String(sara.id)) as { before_json: string; after_json: string }

    expect(JSON.parse(row.before_json)).toEqual({ role: 'cashier' })
    expect(JSON.parse(row.after_json)).toEqual({ role: 'manager' })
  })

  // ── Passwords ────────────────────────────────────────────────────────────────

  it('resets a password — the new one works and the old one no longer does', () => {
    const sara = users.create(t.db, owner, { username: 'sara', fullName: 'Sara', role: 'cashier', password: 'letmein123' })

    users.setPassword(t.db, owner, sara.id, 'brand-new-pass')

    expect(auth.signIn(t.db, 'sara', 'brand-new-pass').id).toBe(sara.id)
    expectUserMessage(() => auth.signIn(t.db, 'sara', 'letmein123'), /username or password/i)
  })

  it('refuses a reset password that is too short', () => {
    const sara = users.create(t.db, owner, { username: 'sara', fullName: 'Sara', role: 'cashier', password: 'letmein123' })
    expectUserMessage(() => users.setPassword(t.db, owner, sara.id, 'short'), /at least 8 characters/i)
  })

  // ── PINs — the counter quick-switch ──────────────────────────────────────────

  it('sets a PIN, then auth.signInWithPin returns that user', () => {
    const sara = users.create(t.db, owner, { username: 'sara', fullName: 'Sara', role: 'cashier', password: 'letmein123' })

    const withPin = users.setPin(t.db, owner, sara.id, '4821')
    expect(withPin.hasPin).toBe(true)

    expect(auth.signInWithPin(t.db, '4821').id).toBe(sara.id)
  })

  it('refuses a PIN already used by another active user — two people, one PIN, is one identity', () => {
    const sara = users.create(t.db, owner, { username: 'sara', fullName: 'Sara', role: 'cashier', password: 'letmein123' })
    const ali = users.create(t.db, owner, { username: 'ali', fullName: 'Ali', role: 'cashier', password: 'letmein456' })

    users.setPin(t.db, owner, sara.id, '4821')
    expectUserMessage(() => users.setPin(t.db, owner, ali.id, '4821'), /already uses that PIN/i)

    // Sara still owns the PIN — the refused attempt changed nothing.
    expect(auth.signInWithPin(t.db, '4821').id).toBe(sara.id)
  })

  it('clearing the PIN stops PIN sign-in', () => {
    const sara = users.create(t.db, owner, { username: 'sara', fullName: 'Sara', role: 'cashier', password: 'letmein123' })
    users.setPin(t.db, owner, sara.id, '4821')

    const cleared = users.setPin(t.db, owner, sara.id, null)
    expect(cleared.hasPin).toBe(false)

    expectUserMessage(() => auth.signInWithPin(t.db, '4821'), /not recognised/i)
  })

  it('a PIN must be digits and exactly the configured length', () => {
    const sara = users.create(t.db, owner, { username: 'sara', fullName: 'Sara', role: 'cashier', password: 'letmein123' })

    expectUserMessage(() => users.setPin(t.db, owner, sara.id, '12'), /exactly 4 digits/i) // too short
    expectUserMessage(() => users.setPin(t.db, owner, sara.id, '12ab'), /exactly 4 digits/i) // not digits
    expectUserMessage(() => users.setPin(t.db, owner, sara.id, '123456'), /exactly 4 digits/i) // too long
  })

  it('honours the configured PIN length', () => {
    settings.set(t.db, 'security.pinLength', 6)
    const sara = users.create(t.db, owner, { username: 'sara', fullName: 'Sara', role: 'cashier', password: 'letmein123' })

    expectUserMessage(() => users.setPin(t.db, owner, sara.id, '4821'), /exactly 6 digits/i)

    const ok = users.setPin(t.db, owner, sara.id, '482100')
    expect(ok.hasPin).toBe(true)
    expect(auth.signInWithPin(t.db, '482100').id).toBe(sara.id)
  })

  it('a leading-zero PIN survives — it is a string, not a number', () => {
    settings.set(t.db, 'security.pinLength', 4)
    const sara = users.create(t.db, owner, { username: 'sara', fullName: 'Sara', role: 'cashier', password: 'letmein123' })

    users.setPin(t.db, owner, sara.id, '0421')
    expect(auth.signInWithPin(t.db, '0421').id).toBe(sara.id)
  })

  // ── Retire / restore — never delete ──────────────────────────────────────────

  it('deactivates and reactivates a user without ever deleting the row', () => {
    const sara = users.create(t.db, owner, { username: 'sara', fullName: 'Sara', role: 'cashier', password: 'letmein123' })
    users.setPin(t.db, owner, sara.id, '4821')

    const off = users.deactivate(t.db, owner, sara.id)
    expect(off.isActive).toBe(false)

    // A retired user cannot sign in — by password or by PIN.
    expectUserMessage(() => auth.signIn(t.db, 'sara', 'letmein123'), /username or password/i)
    expectUserMessage(() => auth.signInWithPin(t.db, '4821'), /not recognised/i)

    // ...but the row is still there, so last year's sale still has a name on it.
    const back = users.reactivate(t.db, owner, sara.id)
    expect(back.isActive).toBe(true)
    expect(auth.signIn(t.db, 'sara', 'letmein123').id).toBe(sara.id)

    // Still exactly one row for Sara — deactivate/reactivate never deletes and never duplicates.
    const count = t.db.prepare("SELECT COUNT(*) FROM users WHERE username = 'sara'").pluck().get() as number
    expect(count).toBe(1)
  })

  it('an unknown user id is refused in plain language, never a crash', () => {
    expectUserMessage(() => users.setPassword(t.db, owner, 9999, 'letmein123'), /could not be found/i)
    expectUserMessage(() => users.deactivate(t.db, owner, 9999), /could not be found/i)
    expectUserMessage(() => users.update(t.db, owner, 9999, { fullName: 'Ghost' }), /could not be found/i)
  })

  // ── List ──────────────────────────────────────────────────────────────────────

  it('lists every user, paginated — active and retired, assume 100k rows not 10', () => {
    for (let i = 1; i <= 24; i += 1) {
      users.create(t.db, owner, {
        username: `staff${String(i).padStart(2, '0')}`,
        fullName: `Staff ${i}`,
        role: 'cashier',
        password: 'letmein123'
      })
    }

    // 24 created + the owner from beforeEach.
    const first = users.list(t.db, 1, 10)
    expect(first.total).toBe(25)
    expect(first.rows).toHaveLength(10)
    expect(first.page).toBe(1)
    expect(first.pageSize).toBe(10)

    const last = users.list(t.db, 3, 10)
    expect(last.rows).toHaveLength(5)

    // No page runs unbounded, however high the number.
    expect(users.list(t.db, 99, 10).rows).toHaveLength(0)

    // A retired user still appears in the list (the owner must be able to reactivate them) and is
    // still counted — deactivation is not deletion.
    const aCashier = first.rows.find((u) => u.role === 'cashier')
    expect(aCashier).toBeDefined()
    users.deactivate(t.db, owner, aCashier!.id)
    expect(users.list(t.db, 1, 100).total).toBe(25)
    expect(users.list(t.db, 1, 100).rows.some((u) => u.id === aCashier!.id && !u.isActive)).toBe(true)
  })
})
