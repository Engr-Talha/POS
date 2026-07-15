import { z } from 'zod'
import type { DB } from '../db'
import type { User } from '@shared/types'
import type { PagedResult } from '@shared/catalog'
import { ROLES, type Role } from '@shared/rbac'
import { AppError, ErrorCode } from '@shared/result'
import { hashSecret, verifySecret } from '../security/password'
import * as settings from './settings'
import * as audit from './audit'

/**
 * USER ADMINISTRATION — what the Owner uses to manage staff.
 *
 * This is the ADMIN side of accounts. `auth.ts` owns SIGNING IN (password, PIN quick-switch, RBAC
 * checks); this owns CREATING and MAINTAINING the people who sign in. The two never overlap: there is
 * no sign-in here, and there is no user-creation there beyond the very first owner.
 *
 * Everything here is OWNER-ONLY. That gate ('user.manage') is enforced in the IPC layer, in MAIN —
 * the renderer is not a security boundary (CLAUDE.md §4). The service still takes the `actor` so every
 * change lands in the audit log with a real name and role against it: who hired, who reset a password,
 * who handed out a till PIN. Staff records are a theft surface, so every write is recorded.
 *
 * TWO RULES THAT ARE NOT NEGOTIABLE, and both have a test:
 *
 *   1. A USER IS NEVER DELETED. Last year's sale carries the cashier's name, the audit log points at
 *      their row, and a deleted user turns all of that into a hole. Retire them (`deactivate`) instead.
 *
 *   2. THE SHOP MUST ALWAYS HAVE AN OWNER. The last active owner cannot be demoted or deactivated —
 *      do it and nobody is left who can add staff, change settings, or unlock a period. The shop would
 *      lock itself out of its own books. We refuse, in plain language.
 *
 * Transport-agnostic (CLAUDE.md §3): plain args in, plain data out, no `electron` import. It validates
 * its own input, so a future LAN server calling it directly is as safe as the IPC layer is today.
 */

// ── Row ──────────────────────────────────────────────────────────────────────

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
    // The PIN itself never leaves main. All the renderer needs to know is WHETHER one is set, so it
    // can show "PIN set" and a "Clear PIN" button.
    hasPin: Boolean(row.pin_hash),
    isActive: Boolean(row.is_active)
  }
}

// ── Input schemas ────────────────────────────────────────────────────────────
// The password length is checked SEPARATELY, against the `security.minPasswordLength` setting — not a
// hardcoded number here — so an owner who demands 12-character passwords gets 12-character passwords.

const CreateUserInput = z.object({
  username: z
    .string()
    .trim()
    .min(1, 'Please enter a username.')
    .max(40, 'That username is too long.')
    // Usernames are matched case-insensitively at sign-in (auth lowercases the input), so we store
    // them lowercased. Otherwise "Sara" and "sara" would be two different logins for one person.
    .transform((s) => s.toLowerCase()),
  fullName: z.string().trim().min(1, 'Please enter the full name of the staff member.').max(120),
  role: z.enum(ROLES),
  password: z.string().max(200, 'That password is too long.')
})

const UpdateUserInput = z.object({
  fullName: z.string().trim().min(1, 'Please enter the full name of the staff member.').max(120).optional(),
  role: z.enum(ROLES).optional()
})

// ── List ─────────────────────────────────────────────────────────────────────

/**
 * Every user — active AND retired. The management screen must show deactivated staff, or the owner
 * could never reactivate someone they let go and later re-hired.
 *
 * Paginated and ordered, because even a list of staff gets read a page at a time (CLAUDE.md §4) — and
 * a stable order means page 2 never repeats a row from page 1. Active first, then by username.
 */
export function list(db: DB, page: number = 1, pageSize: number = 50): PagedResult<User> {
  const p = clampPage(page)
  const size = clampPageSize(pageSize)

  const total = db.prepare('SELECT COUNT(*) FROM users').pluck().get() as number

  const rows = db
    .prepare(
      `SELECT * FROM users
       ORDER BY is_active DESC, username, id
       LIMIT @limit OFFSET @offset`
    )
    .all({ limit: size, offset: (p - 1) * size }) as UserRow[]

  return { total, page: p, pageSize: size, rows: rows.map(toUser) }
}

// ── Create ───────────────────────────────────────────────────────────────────

/**
 * Add a staff member. A brand-new user has NO PIN — the counter quick-switch is opt-in, set later with
 * `setPin`. They can sign in with the username and password straight away.
 */
export function create(db: DB, actor: User, raw: unknown, now = new Date()): User {
  const input = parseOrThrow(CreateUserInput, raw, 'user.create')
  assertPasswordStrong(db, input.password)

  // Usernames are globally UNIQUE — including retired staff, whose row (and audit trail) still owns the
  // name. A clear "already taken" beats a raw UNIQUE-constraint error the cashier can't read. The
  // INSERT is still guarded below, so a race that slips past this check also gets a friendly message.
  const taken = db.prepare('SELECT 1 FROM users WHERE username = ?').pluck().get(input.username)
  if (taken != null) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'That username is already taken. Please choose another one.',
      `duplicate username "${input.username}"`
    )
  }

  const at = now.toISOString()
  const id = guard(
    () =>
      Number(
        db
          .prepare(
            `INSERT INTO users (username, full_name, role, password_hash, pin_hash,
                                is_active, created_at, updated_at)
             VALUES (@username, @fullName, @role, @passwordHash, NULL, 1, @at, @at)`
          )
          .run({
            username: input.username,
            fullName: input.fullName,
            role: input.role,
            passwordHash: hashSecret(input.password),
            at
          }).lastInsertRowid
      ),
    'user.create'
  )

  // The password is NEVER in the audit row — only the fact that an account was made, and for whom.
  audit.record(
    db,
    actor,
    {
      action: 'user.create',
      entity: 'user',
      entityId: id,
      after: { username: input.username, fullName: input.fullName, role: input.role }
    },
    now
  )

  return toUser(loadRow(db, id))
}

// ── Update — ONLY the fields the form actually sent (CLAUDE.md trap #18) ───────

const UPDATABLE: Record<'fullName' | 'role', string> = {
  fullName: 'full_name',
  role: 'role'
  // Deliberately NOT here: username (a stable identity), password and pin (their own guarded paths),
  // and is_active (deactivate/reactivate, which carry the last-owner guard).
}

/**
 * Edit a staff member's name or role. Writes ONLY the keys present on `raw` — post the whole object
 * back and a "just fix the spelling of the name" save would also rewrite the role from a stale value.
 *
 * THE LAST-OWNER GUARD lives here: demoting the shop's only owner is refused, because it would leave
 * nobody able to manage the shop.
 */
export function update(db: DB, actor: User, id: number, raw: unknown, now = new Date()): User {
  const userId = parseId(id, 'user.update')
  const input = parseOrThrow(UpdateUserInput, raw, 'user.update')
  const before = loadRow(db, userId)

  const touched = (Object.keys(UPDATABLE) as Array<'fullName' | 'role'>).filter((key) => key in input)
  if (touched.length === 0) return toUser(before)

  // Only a change AWAY from owner can strand the shop. Promoting to owner, or renaming, never can.
  if ('role' in input && input.role !== 'owner') {
    assertNotLastOwner(db, before, `user.update tried to demote the shop's only owner id=${userId}`)
  }

  const sets = touched.map((key) => `${UPDATABLE[key]} = @${key}`)
  const params: Record<string, unknown> = { id: userId, at: now.toISOString() }
  for (const key of touched) params[key] = input[key]

  guard(
    () => db.prepare(`UPDATE users SET ${sets.join(', ')}, updated_at = @at WHERE id = @id`).run(params),
    'user.update'
  )

  const after = loadRow(db, userId)

  audit.record(
    db,
    actor,
    {
      action: 'user.update',
      entity: 'user',
      entityId: userId,
      before: pick(toUser(before), touched),
      after: pick(toUser(after), touched)
    },
    now
  )

  return toUser(after)
}

// ── Passwords & PINs ─────────────────────────────────────────────────────────

/**
 * Reset a staff member's password. The owner does this when someone forgets theirs — we can't recover
 * the old one (it was never stored), only replace it. Length is the `security.minPasswordLength`
 * setting, same as at creation.
 */
export function setPassword(db: DB, actor: User, id: number, newPassword: string, now = new Date()): User {
  const userId = parseId(id, 'user.set_password')
  loadRow(db, userId) // 404s in plain language if the user is gone
  const password = parseOrThrow(z.string().max(200, 'That password is too long.'), newPassword, 'user.set_password')
  assertPasswordStrong(db, password)

  db.prepare('UPDATE users SET password_hash = @hash, updated_at = @at WHERE id = @id').run({
    hash: hashSecret(password),
    at: now.toISOString(),
    id: userId
  })

  // The new password is NEVER in the audit row — only that a reset happened, and who did it.
  audit.record(db, actor, { action: 'user.set_password', entity: 'user', entityId: userId }, now)

  return toUser(loadRow(db, userId))
}

/**
 * Set or CLEAR the quick-switch PIN.
 *
 *   pin = a string of digits  ->  set it (exactly `security.pinLength` digits)
 *   pin = null                ->  clear it, which removes their counter quick-switch entirely
 *
 * TWO PEOPLE CANNOT SHARE A PIN. A PIN identifies who rang up a sale; if two cashiers had the same one,
 * every sale, void and drawer-open one of them made would be logged under whoever the PIN matched
 * first — one PIN, two identities, and a useless audit trail. So a PIN already used by another active
 * user is refused. (auth.signInWithPin only ever looks at active users, so that is who we check.)
 */
export function setPin(db: DB, actor: User, id: number, pin: string | null, now = new Date()): User {
  const userId = parseId(id, 'user.set_pin')
  loadRow(db, userId)

  if (pin == null) {
    db.prepare('UPDATE users SET pin_hash = NULL, updated_at = @at WHERE id = @id').run({
      at: now.toISOString(),
      id: userId
    })
    audit.record(
      db,
      actor,
      { action: 'user.clear_pin', entity: 'user', entityId: userId, after: { hasPin: false } },
      now
    )
    return toUser(loadRow(db, userId))
  }

  const length = pinLength(db)
  // Digits only, and EXACTLY the configured length. A PIN is a string, never a number, so a leading
  // zero survives — "0421" must stay four characters, not become 421.
  if (typeof pin !== 'string' || !/^\d+$/.test(pin) || pin.length !== length) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `A PIN must be exactly ${length} digits.`,
      `invalid PIN for user id=${userId}`
    )
  }

  const rivals = db
    .prepare('SELECT id, pin_hash FROM users WHERE is_active = 1 AND pin_hash IS NOT NULL AND id != ?')
    .all(userId) as Array<{ id: number; pin_hash: string }>

  for (const rival of rivals) {
    if (verifySecret(pin, rival.pin_hash)) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'Another staff member already uses that PIN. Please choose a different one.',
        `PIN collides with active user id=${rival.id}`
      )
    }
  }

  db.prepare('UPDATE users SET pin_hash = @hash, updated_at = @at WHERE id = @id').run({
    hash: hashSecret(pin),
    at: now.toISOString(),
    id: userId
  })

  // The PIN itself never touches the audit row — only that one is now set.
  audit.record(
    db,
    actor,
    { action: 'user.set_pin', entity: 'user', entityId: userId, after: { hasPin: true } },
    now
  )

  return toUser(loadRow(db, userId))
}

// ── Retire / restore — NEVER delete ──────────────────────────────────────────

/**
 * Retire a staff member. They can no longer sign in (by password or PIN), but the row stays forever so
 * last year's sale still has a name on it. The last active owner cannot be retired — see the guard.
 */
export function deactivate(db: DB, actor: User, id: number, now = new Date()): User {
  const userId = parseId(id, 'user.deactivate')
  const before = loadRow(db, userId)
  assertNotLastOwner(db, before, `user.deactivate would remove the shop's only owner id=${userId}`)

  const hadPin = before.pin_hash != null

  // Retiring clears the quick-switch PIN, not just the ability to sign in. A PIN is a re-settable
  // credential, never a business record, and a dormant one on a retired row is a landmine: the
  // collision check and PIN sign-in both look at ACTIVE users only, so a later hire could be handed
  // the same PIN with no clash, and reactivating this person would then put two active users behind
  // one PIN — one identity, a false audit trail for every sale and approval. The invariant is simply
  // `inactive ⟹ no PIN`; migration 0010 backfills it for rows retired before this fix.
  db.prepare('UPDATE users SET is_active = 0, pin_hash = NULL, updated_at = @at WHERE id = @id').run({
    at: now.toISOString(),
    id: userId
  })

  audit.record(
    db,
    actor,
    {
      action: 'user.deactivate',
      entity: 'user',
      entityId: userId,
      before: { isActive: Boolean(before.is_active), hasPin: hadPin },
      after: { isActive: false, hasPin: false }
    },
    now
  )

  return toUser(loadRow(db, userId))
}

/**
 * Bring a retired staff member back. They return WITHOUT a quick-switch PIN — retiring cleared it
 * (see `deactivate` and migration 0010), so there is never a dormant PIN here to collide with one a
 * new hire was given while this person was gone. The owner sets them a fresh PIN if they want one,
 * which collision-checks against every active user the normal way. Reactivating can only ever help a
 * shop that is short-staffed, so — unlike deactivate — there is no last-owner guard.
 */
export function reactivate(db: DB, actor: User, id: number, now = new Date()): User {
  const userId = parseId(id, 'user.reactivate')
  const before = loadRow(db, userId)

  db.prepare('UPDATE users SET is_active = 1, updated_at = @at WHERE id = @id').run({
    at: now.toISOString(),
    id: userId
  })

  audit.record(
    db,
    actor,
    {
      action: 'user.reactivate',
      entity: 'user',
      entityId: userId,
      before: { isActive: Boolean(before.is_active) },
      after: { isActive: true }
    },
    now
  )

  return toUser(loadRow(db, userId))
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadRow(db: DB, id: number): UserRow {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
  if (!row) {
    throw new AppError(ErrorCode.NOT_FOUND, 'That staff member could not be found.', `user id=${id} does not exist`)
  }
  return row
}

/**
 * Refuse to strand the shop. If `target` is the ONE remaining active owner, throws — otherwise does
 * nothing. Called before a demotion and before a deactivation; safe to call on anyone, because a
 * non-owner (or an inactive owner) is never the thing holding the shop up.
 */
function assertNotLastOwner(db: DB, target: UserRow, technical: string): void {
  if (target.role !== 'owner' || target.is_active !== 1) return

  const activeOwners = db
    .prepare("SELECT COUNT(*) FROM users WHERE role = 'owner' AND is_active = 1")
    .pluck()
    .get() as number

  if (activeOwners <= 1) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'This is the shop’s only owner. Make someone else an owner first, or no one would be left to manage staff, change settings, or unlock a period.',
      technical
    )
  }
}

function assertPasswordStrong(db: DB, password: string): void {
  const min = pinOrPasswordSetting(db, 'security.minPasswordLength', 8)
  if (password.length < min) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `Please choose a password of at least ${min} characters.`,
      `password shorter than ${min}`
    )
  }
}

function pinLength(db: DB): number {
  return pinOrPasswordSetting(db, 'security.pinLength', 4)
}

/** Read a security length setting, falling back to its registry default and guarding against a bad value. */
function pinOrPasswordSetting(db: DB, key: string, fallback: number): number {
  const value = settings.get<number>(db, key, fallback)
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function clampPage(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : 1
  return v < 1 ? 1 : v
}

function clampPageSize(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : 50
  return Math.min(200, Math.max(1, v))
}

function parseId(raw: unknown, context: string): number {
  const parsed = z.number().int().positive().safeParse(raw)
  if (!parsed.success) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That staff member could not be found.',
      `${context}: invalid id ${JSON.stringify(raw)}`
    )
  }
  return parsed.data
}

function pick<T extends object>(source: T, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) out[key] = (source as Record<string, unknown>)[key]
  return out
}

/**
 * Validate at the SERVICE boundary, not only the IPC one — vitest calls this layer directly today, and
 * a LAN server will tomorrow (CLAUDE.md §3). The zod messages are already cashier-readable.
 */
function parseOrThrow<S extends z.ZodType>(schema: S, raw: unknown, context: string): z.output<S> {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new AppError(
      ErrorCode.VALIDATION,
      issue?.message ?? 'Please check the details and try again.',
      `${context}: ${JSON.stringify(parsed.error.issues)}`
    )
  }
  return parsed.data as z.output<S>
}

/** Turn a raw SQLite constraint error into something a cashier can read; keep the real text for the log. */
function guard<T>(run: () => T, context: string): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof AppError) throw error

    const code = (error as { code?: string }).code ?? ''
    const technical = `${context}: ${error instanceof Error ? error.message : String(error)}`

    if (code.startsWith('SQLITE_CONSTRAINT_UNIQUE')) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'That username is already taken. Please choose another one.',
        technical
      )
    }
    if (code.startsWith('SQLITE_CONSTRAINT')) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'That staff member could not be saved. Please check the details and try again.',
        technical
      )
    }

    throw new AppError(ErrorCode.DB, 'Something went wrong saving that staff member. Please try again.', technical)
  }
}
