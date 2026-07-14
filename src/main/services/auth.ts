import type { DB } from '../db'
import type { User } from '@shared/types'
import type { Role, Permission } from '@shared/rbac'
import { roleCan } from '@shared/rbac'
import { AppError, ErrorCode } from '@shared/result'
import { hashSecret, verifySecret } from '../security/password'
import * as audit from './audit'

/**
 * AUTH + RBAC.
 *
 * RBAC IS ENFORCED HERE, IN THE MAIN PROCESS. Hiding a button in the renderer is a courtesy to the
 * user; it is not a control. Anyone who can open DevTools can call any exposed IPC channel, so the
 * check that counts is the one `requirePermission` does, on this side of the bridge.
 */

type UserRow = {
  id: number
  username: string
  full_name: string
  role: Role
  password_hash: string
  pin_hash: string | null
  is_active: number
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    role: row.role,
    hasPin: Boolean(row.pin_hash),
    isActive: Boolean(row.is_active)
  }
}

/** True on a brand-new install: the app must ask the shop to create its Owner account. */
export function needsFirstUser(db: DB): boolean {
  const count = db.prepare('SELECT COUNT(*) FROM users').pluck().get() as number
  return count === 0
}

/**
 * First run only. Creates the Owner. Deliberately NOT seeded with a default password — a shipped
 * default password is a shipped back door, and this one would open a shop's books.
 */
export function createFirstOwner(
  db: DB,
  input: { username: string; fullName: string; password: string },
  now = new Date()
): User {
  if (!needsFirstUser(db)) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      'This shop already has an owner account.',
      'createFirstOwner called when users exist'
    )
  }

  assertPasswordStrong(input.password)

  const info = db
    .prepare(
      `INSERT INTO users (username, full_name, role, password_hash, created_at, updated_at)
       VALUES (?, ?, 'owner', ?, ?, ?)`
    )
    .run(
      input.username.trim().toLowerCase(),
      input.fullName.trim(),
      hashSecret(input.password),
      now.toISOString(),
      now.toISOString()
    )

  const user = getById(db, Number(info.lastInsertRowid))
  audit.record(db, user, { action: 'user.create', entity: 'user', entityId: user.id }, now)
  return user
}

export function getById(db: DB, id: number): User {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'That user could not be found.', `id=${id}`)
  return toUser(row)
}

/** Sign in with username + password. */
export function signIn(db: DB, username: string, password: string, now = new Date()): User {
  const row = db
    .prepare('SELECT * FROM users WHERE username = ? AND is_active = 1')
    .get(username.trim().toLowerCase()) as UserRow | undefined

  // Same message whether the username is wrong or the password is: telling an attacker WHICH half
  // they got right hands them a list of valid usernames.
  const rejection = new AppError(
    ErrorCode.FORBIDDEN,
    'That username or password is not correct.',
    `failed sign-in for "${username}"`
  )

  if (!row) throw rejection
  if (!verifySecret(password, row.password_hash)) throw rejection

  const user = toUser(row)
  audit.record(db, user, { action: 'user.sign_in' }, now)
  return user
}

/**
 * The quick cashier switch on the Sell screen — a PIN, not a password.
 *
 * A PIN is 4-6 digits and is shoulder-surfable by design (it has to be fast at a busy counter). So
 * it buys you SPEED, not authority: it identifies who is ringing up the sale. It is still subject
 * to the same RBAC checks, so a Cashier's PIN cannot void a sale any more than their password could.
 */
export function signInWithPin(db: DB, pin: string, now = new Date()): User {
  const rows = db
    .prepare('SELECT * FROM users WHERE is_active = 1 AND pin_hash IS NOT NULL')
    .all() as UserRow[]

  for (const row of rows) {
    if (row.pin_hash && verifySecret(pin, row.pin_hash)) {
      const user = toUser(row)
      audit.record(db, user, { action: 'user.pin_switch' }, now)
      return user
    }
  }

  throw new AppError(ErrorCode.FORBIDDEN, 'That PIN is not recognised.', 'failed PIN sign-in')
}

// ── The check that actually matters ──────────────────────────────────────────

export function can(user: User, permission: Permission): boolean {
  return roleCan(user.role, permission)
}

/**
 * Call this at the top of EVERY service action that is role-gated. It throws an AppError, which the
 * IPC layer turns into a friendly refusal — never a stack trace.
 */
export function requirePermission(user: User, permission: Permission): void {
  if (can(user, permission)) return

  throw new AppError(
    ErrorCode.FORBIDDEN,
    'You do not have permission to do that. Please ask a supervisor.',
    `role=${user.role} lacks permission=${permission}`
  )
}

function assertPasswordStrong(password: string): void {
  if (password.length < 8) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Please choose a password of at least 8 characters.',
      'password too short'
    )
  }
}
