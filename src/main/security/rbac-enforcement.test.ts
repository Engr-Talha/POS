import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb, type TestDb } from '../db/testkit'
import * as session from './session'
import { requirePermission } from '../services/auth'
import { PERMISSIONS, ROLE_RANK, roleCan, type Permission, type Role } from '@shared/rbac'
import { AppError, ErrorCode } from '@shared/result'
import type { User } from '@shared/types'

/**
 * THE UI IS NOT THE SECURITY BOUNDARY. This file is the proof. (CLAUDE.md §4; PLAN Phase 10's stated
 * acceptance test: "RBAC enforced in main and proven by a test that calls the service directly.")
 *
 * Hiding a button is a courtesy. The control is in the MAIN process, and these tests call it DIRECTLY —
 * no renderer, no window, no button to hide. That is the whole point: a tampered renderer, a rebuilt
 * asar, a curious cashier with devtools open, or a future LAN client all arrive at exactly this code.
 *
 * ── WHY IT IS DRIVEN OFF THE PERMISSIONS MAP ITSELF ─────────────────────────────────────────────────
 * A hand-written list of permissions to check would rot the moment someone adds the 36th. Every test
 * below walks `PERMISSIONS`, so a permission added tomorrow WITHOUT a guard fails HERE rather than
 * shipping unguarded and being found by a shop. The map is the spec; this file holds it to it.
 */

let t: TestDb

/** A user of each role, built once per test. No DB row needed: the guard reads the ROLE, not a record. */
function userOf(role: Role): User {
  return { id: ROLE_RANK[role], username: role, fullName: `${role} user`, role, hasPin: true, isActive: true }
}

const ROLES: Role[] = ['cashier', 'supervisor', 'manager', 'owner']
const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[]

/** Every role that must be REFUSED this permission — i.e. everyone ranked below what it demands. */
function rolesBelow(permission: Permission): Role[] {
  return ROLES.filter((role) => !roleCan(role, permission))
}

beforeEach(() => {
  t = makeTestDb({ withSeed: true })
  session.signOut()
})

afterEach(() => {
  session.signOut()
  t.cleanup()
})

// ═════════════════════════════════════════════════════════════════════════════
// 1. EVERY permission, EVERY role below it, refused in MAIN
// ═════════════════════════════════════════════════════════════════════════════

describe('the main process refuses every permission to every role below it', () => {
  it('covers the WHOLE permission map — not a hand-picked sample', () => {
    // If this number changes, a permission was added or removed. That is fine — but the sweep below
    // must have run over it, and this assertion is what proves the sweep is not quietly empty.
    expect(ALL_PERMISSIONS.length).toBeGreaterThanOrEqual(35)
    expect(ALL_PERMISSIONS.every((p) => ROLES.includes(PERMISSIONS[p]))).toBe(true)
  })

  for (const permission of ALL_PERMISSIONS) {
    const required = PERMISSIONS[permission]
    const denied = rolesBelow(permission)

    it(`'${permission}' needs ${required}${denied.length ? ` — refuses ${denied.join(', ')}` : ' — the lowest role, so nobody is below it'}`, () => {
      for (const role of denied) {
        session.signIn(userOf(role))

        let thrown: unknown = null
        try {
          session.requirePermissionOf(permission)
        } catch (error) {
          thrown = error
        }

        expect(thrown, `${role} was ALLOWED '${permission}' — it needs ${required}`).toBeInstanceOf(AppError)
        expect((thrown as AppError).code, `${role}/${permission}: wrong error code`).toBe(ErrorCode.FORBIDDEN)
        // A cashier who cannot do a thing must be TOLD, in words they can act on — never a stack trace.
        expect((thrown as AppError).userMessage, `${role}/${permission}: unfriendly message`).toMatch(
          /permission|supervisor|sign in/i
        )
      }

      // ...and every role AT or ABOVE the bar is let through. A guard that refuses everyone is not a
      // guard, it is an outage — and it would pass the half of this test above.
      for (const role of ROLES.filter((r) => roleCan(r, permission))) {
        session.signIn(userOf(role))
        expect(() => session.requirePermissionOf(permission), `${role} was REFUSED '${permission}'`).not.toThrow()
      }
    })
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. The ones a dishonest cashier would actually try
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The sweep above is exhaustive, so these are redundant by construction — and they are here anyway,
 * BY NAME, because they are the specific attacks this whole layer exists to stop. If one of them ever
 * changes role, this file should be the thing that argues about it.
 */
describe('the money-shaped permissions, by name', () => {
  const MUST_REFUSE_CASHIER: Array<[Permission, Role]> = [
    ['sale.void', 'supervisor'],
    ['sale.refund', 'supervisor'],
    ['sale.discount.over_threshold', 'supervisor'],
    ['sale.price_override', 'supervisor'],
    ['stock.adjust', 'manager'],
    ['product.manage', 'manager'],
    ['user.manage', 'owner'],
    ['settings.manage', 'owner'],
    ['period.manage', 'owner']
  ]

  for (const [permission, required] of MUST_REFUSE_CASHIER) {
    it(`a CASHIER cannot '${permission}' (needs ${required})`, () => {
      session.signIn(userOf('cashier'))
      expect(() => session.requirePermissionOf(permission)).toThrow(AppError)
      expect(PERMISSIONS[permission]).toBe(required)
    })
  }

  it('an OWNER can do everything — there is no permission the owner lacks', () => {
    session.signIn(userOf('owner'))
    for (const permission of ALL_PERMISSIONS) {
      expect(() => session.requirePermissionOf(permission), `the owner was refused '${permission}'`).not.toThrow()
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. NOBODY signed in — the case a tampered renderer reaches for
// ═════════════════════════════════════════════════════════════════════════════

describe('with no session in main', () => {
  it('refuses EVERY permission — the renderer cannot simply not sign in', () => {
    session.signOut()
    for (const permission of ALL_PERMISSIONS) {
      expect(() => session.requirePermissionOf(permission), `'${permission}' passed with NO SESSION`).toThrow(
        AppError
      )
    }
  })

  it('says "please sign in", not "forbidden" — they are different problems with different fixes', () => {
    session.signOut()
    try {
      session.requirePermissionOf('sale.create')
      throw new Error('unreachable')
    } catch (error) {
      expect((error as AppError).userMessage).toMatch(/sign in/i)
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. THE RENDERER CANNOT SAY WHO IT IS
// ═════════════════════════════════════════════════════════════════════════════

describe('identity comes from MAIN, never from the caller', () => {
  /**
   * The attack this stops: an IPC call carrying `{ userId: 1, role: 'owner' }` and main believing it.
   * `requirePermissionOf` takes ONE argument — the permission. There is no parameter through which a
   * caller could name itself, which is why a tampered renderer cannot claim to be the owner. Anything
   * that ever adds one has broken the boundary, and this test is the argument against it.
   */
  it('requirePermissionOf takes the permission and nothing else — there is no seat for a claimed role', () => {
    expect(session.requirePermissionOf.length).toBe(1)
  })

  it('a claimed role in the ARGUMENT changes nothing — the signed-in user decides', () => {
    session.signIn(userOf('cashier'))

    // The cashier "claims" to be the owner the only way a caller could: by handing main a user object.
    // `requirePermission` takes the user explicitly, so it is the one place a claim COULD be believed —
    // and the IPC layer never calls it that way (it calls requirePermissionOf, which reads the session).
    const claimed = userOf('owner')
    expect(() => requirePermission(claimed, 'user.manage')).not.toThrow() // the claim, believed

    // But the session — the ONLY thing the IPC layer asks — still says cashier, and still refuses.
    expect(() => session.requirePermissionOf('user.manage')).toThrow(AppError)
    expect(session.getCurrent()?.user.role).toBe('cashier')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. THE PERMISSION MAP'S OWN SHAPE
// ═════════════════════════════════════════════════════════════════════════════

describe('the map itself', () => {
  it('grants every permission monotonically by rank — no role has a power its senior lacks', () => {
    // The whole model rests on rank: owner > manager > supervisor > cashier. If a permission were ever
    // granted to a JUNIOR role but not a senior one, the app would have a hole no reviewer would see —
    // a supervisor unable to do what their own cashier can.
    for (const permission of ALL_PERMISSIONS) {
      const allowed = ROLES.filter((r) => roleCan(r, permission)).map((r) => ROLE_RANK[r])
      const lowest = Math.min(...allowed)
      for (const role of ROLES) {
        if (ROLE_RANK[role] >= lowest) {
          expect(roleCan(role, permission), `${role} should have '${permission}' by rank`).toBe(true)
        }
      }
    }
  })

  it('names a real role for every permission — a typo would silently grant it to nobody', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(ROLES, `'${permission}' requires an unknown role`).toContain(PERMISSIONS[permission])
    }
  })
})
