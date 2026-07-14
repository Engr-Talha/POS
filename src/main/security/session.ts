import type { User } from '@shared/types'
import type { Permission } from '@shared/rbac'
import { AppError, ErrorCode } from '@shared/result'
import { requirePermission } from '../services/auth'

/**
 * WHO IS SIGNED IN — held in the MAIN process, and only here.
 *
 * The renderer is given a COPY of the user to draw a name in the corner. It is not the source of
 * truth, and it never gets to say who it is: an IPC call cannot pass "I am the owner" as an
 * argument, because a tampered renderer would simply say that. Every guarded handler asks THIS
 * module who is signed in.
 */

let current: { user: User; signedInAt: string } | null = null

export function signIn(user: User, now = new Date()): void {
  current = { user, signedInAt: now.toISOString() }
}

export function signOut(): void {
  current = null
}

export function getCurrent(): { user: User; signedInAt: string } | null {
  return current
}

/** For handlers that need a user but no particular power. */
export function requireUser(): User {
  if (!current) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      'Please sign in to continue.',
      'no session in main process'
    )
  }
  return current.user
}

/**
 * The guard for every role-gated IPC handler: who are you, and are you allowed?
 * Both questions answered in main. The UI hiding the button is a courtesy, not a control.
 */
export function requirePermissionOf(permission: Permission): User {
  const user = requireUser()
  requirePermission(user, permission)
  return user
}
