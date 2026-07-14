import type { DB } from '../db'
import type { LicenseState, LicensePayload } from '@shared/types'
import { AppError, ErrorCode } from '@shared/result'
import { verifyLicenseKey } from '../security/license-key'
import { LICENSE_PUBLIC_KEY } from '../security/public-key'

/**
 * THE LICENCE SERVICE. Verified in the MAIN process, offline, on every launch.
 *
 * THE CENTRAL RULE: EXPIRY NEVER HOLDS THE CUSTOMER'S DATA HOSTAGE.
 *
 * An expired licence puts the app in READ-ONLY mode. They can open it, look at everything, run
 * every report, EXPORT, and BACK UP. They simply cannot make new sales or purchases until they
 * renew. We NEVER delete, hide, or encrypt their data. It is their shop's books — they own it, and
 * a business that cannot get its own numbers out is a business we have taken hostage.
 */

/** Days at which the app starts warning, loudest last. */
export const EXPIRY_WARNING_DAYS = [30, 15, 7, 1]

function daysBetween(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000))
}

type StoredLicense = {
  key_text: string
  licensee: string
  machine_id: string
  plan: string
  issued_at: string
  expires_at: string | null
}

/**
 * Work out where we stand. Re-verifies the stored key's SIGNATURE every time rather than trusting
 * the parsed columns — otherwise anyone who can open the DB file could simply edit `expires_at`.
 *
 * @param clockTampered from the clock guard: a big backwards jump means someone is dodging expiry.
 */
export function getLicenseState(
  db: DB,
  machineId: string,
  options: { now?: Date; clockTampered?: boolean; publicKey?: string } = {}
): LicenseState {
  const now = options.now ?? new Date()
  const publicKey = options.publicKey ?? LICENSE_PUBLIC_KEY

  if (options.clockTampered) {
    return {
      status: 'invalid',
      machineId,
      reason: 'The system clock has been changed. Please re-enter your licence key.'
    }
  }

  const row = db.prepare('SELECT * FROM license WHERE id = 1').get() as StoredLicense | undefined
  if (!row) return { status: 'none', machineId }

  // Re-verify the signature, every launch. The columns are a convenience; the KEY is the truth.
  const verified = verifyLicenseKey(row.key_text, publicKey)
  if (!verified.ok) {
    return { status: 'invalid', machineId, reason: verified.reason }
  }

  const payload = verified.payload

  if (payload.machineId !== machineId) {
    return {
      status: 'invalid',
      machineId,
      reason: 'This licence key belongs to a different computer.'
    }
  }

  const base = {
    machineId,
    licensee: payload.licensee,
    plan: payload.plan,
    issuedAt: payload.issuedAt
  }

  if (payload.expiresAt === null) {
    return { ...base, status: 'active', expiresAt: null, daysRemaining: null } // lifetime
  }

  const expiry = new Date(payload.expiresAt)
  if (now.getTime() > expiry.getTime()) {
    return { ...base, status: 'expired', expiresAt: payload.expiresAt, daysRemaining: 0 }
  }

  return {
    ...base,
    status: 'active',
    expiresAt: payload.expiresAt,
    daysRemaining: daysBetween(now, expiry)
  }
}

/** The customer pastes a key. Verify it hard, then store it. */
export function activate(
  db: DB,
  keyText: string,
  machineId: string,
  options: { now?: Date; publicKey?: string } = {}
): LicensePayload {
  const now = options.now ?? new Date()
  const verified = verifyLicenseKey(keyText, options.publicKey ?? LICENSE_PUBLIC_KEY)
  if (!verified.ok) {
    throw new AppError(ErrorCode.LICENSE_INVALID, verified.reason, `signature check failed`)
  }

  const payload = verified.payload

  if (payload.machineId !== machineId) {
    throw new AppError(
      ErrorCode.LICENSE_INVALID,
      'This licence key was issued for a different computer. Please send us the Machine ID shown on this screen.',
      `key machineId=${payload.machineId} this machine=${machineId}`
    )
  }

  // An already-expired key is refused AT ACTIVATION — accepting it would drop them straight into
  // read-only mode with no explanation, which looks like the app is broken.
  if (payload.expiresAt && now.getTime() > new Date(payload.expiresAt).getTime()) {
    throw new AppError(
      ErrorCode.LICENSE_EXPIRED,
      'This licence key has already expired. Please contact us for a new one.',
      `expired ${payload.expiresAt}`
    )
  }

  db.prepare(
    `INSERT INTO license (id, key_text, licensee, machine_id, plan, issued_at, expires_at, features_json, activated_at)
     VALUES (1, @keyText, @licensee, @machineId, @plan, @issuedAt, @expiresAt, @features, @activatedAt)
     ON CONFLICT (id) DO UPDATE SET
       key_text = excluded.key_text, licensee = excluded.licensee, machine_id = excluded.machine_id,
       plan = excluded.plan, issued_at = excluded.issued_at, expires_at = excluded.expires_at,
       features_json = excluded.features_json, activated_at = excluded.activated_at`
  ).run({
    keyText: keyText.trim(),
    licensee: payload.licensee,
    machineId: payload.machineId,
    plan: payload.plan,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    features: JSON.stringify(payload.features ?? {}),
    activatedAt: now.toISOString()
  })

  return payload
}

/** True when the app may WRITE. Reads, reports, exports and backups are ALWAYS allowed. */
export function canWrite(state: LicenseState): boolean {
  return state.status === 'active'
}

/**
 * Call at the top of every service that CHANGES data. Reads must never call this — an expired shop
 * must still be able to get its own numbers out.
 */
export function assertCanWrite(state: LicenseState): void {
  if (canWrite(state)) return

  if (state.status === 'expired') {
    throw new AppError(
      ErrorCode.READ_ONLY,
      'Your licence has expired, so new sales are paused. You can still view and export everything, and take a backup. Enter a new key in Settings to start selling again.',
      'license expired — read-only mode'
    )
  }

  throw new AppError(
    ErrorCode.LICENSE_INVALID,
    'This copy is not activated. Please enter your licence key to continue.',
    `license status=${state.status}`
  )
}
