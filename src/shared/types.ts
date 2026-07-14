import type { Role } from './rbac'

// ── Users ────────────────────────────────────────────────────────────────────

export type User = {
  id: number
  username: string
  fullName: string
  role: Role
  hasPin: boolean
  isActive: boolean
}

/** Who is signed in right now. Held in the MAIN process — the renderer only gets a copy to draw. */
export type Session = {
  user: User
  signedInAt: string
}

// ── License ──────────────────────────────────────────────────────────────────

export const LICENSE_PLANS = ['trial', 'annual', 'lifetime'] as const
export type LicensePlan = (typeof LICENSE_PLANS)[number]

/**
 * The payload inside a signed key. This is what the vendor signs with the Ed25519 private key,
 * and what the app verifies with the embedded public key — offline, always.
 */
export type LicensePayload = {
  licensee: string
  machineId: string
  plan: LicensePlan
  issuedAt: string
  /** ISO date, or null for a lifetime licence. */
  expiresAt: string | null
  features: Record<string, boolean>
}

export type LicenseState =
  /** No key entered yet — the app shows the Activation screen. */
  | { status: 'none'; machineId: string }
  /** Signed, in date, for this machine. Everything works. */
  | {
      status: 'active'
      machineId: string
      licensee: string
      plan: LicensePlan
      issuedAt: string
      expiresAt: string | null
      daysRemaining: number | null
    }
  /**
   * Past its expiry date. The app is READ-ONLY: they can still open it, look at everything, run
   * every report, EXPORT, and BACK UP. They just cannot make new sales or purchases.
   * We NEVER delete, hide, or encrypt their data. It is their shop's books, and they paid for it.
   */
  | {
      status: 'expired'
      machineId: string
      licensee: string
      plan: LicensePlan
      issuedAt: string
      expiresAt: string
      daysRemaining: 0
    }
  /** Signature failed, or the key is for another machine, or the clock was wound back. */
  | { status: 'invalid'; machineId: string; reason: string }

// ── Audit ────────────────────────────────────────────────────────────────────

export type AuditEntry = {
  id: number
  at: string
  userId: number | null
  userName: string
  userRole: string
  action: string
  entity: string | null
  entityId: string | null
  reasonCode: string | null
  reasonText: string | null
  approvedByName: string | null
  approvedByRole: string | null
}

// ── Lookups ──────────────────────────────────────────────────────────────────

export type Lookup = {
  id: number
  listKey: string
  code: string
  label: string
  sortOrder: number
  isActive: boolean
  isSystem: boolean
}

// ── Backup ───────────────────────────────────────────────────────────────────

export type BackupResult = {
  path: string
  sizeBytes: number
  at: string
  /** We open the finished file and run PRAGMA integrity_check. An unverified backup is a rumour. */
  verified: boolean
}
