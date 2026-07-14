import { createPublicKey, createPrivateKey, sign, verify } from 'node:crypto'
import type { LicensePayload } from '@shared/types'
import { LICENSE_PLANS } from '@shared/types'

/**
 * LICENCE KEY FORMAT — Ed25519, verified OFFLINE. (CLAUDE.md §6)
 *
 *   key = base64url( JSON payload ) + "." + base64url( Ed25519 signature of that JSON )
 *
 * The app embeds ONLY THE PUBLIC KEY. The private key never enters the app or the repo — it lives
 * with the vendor, outside the repo, in .gitignore. If it leaks, anyone can mint licences forever.
 *
 * Offline DRM is defeatable by a determined attacker; that is a fact, not a bug. The goal is to
 * stop CASUAL COPYING — the shop next door being handed a copy of the .exe. Keep it simple and
 * reliable. Do not over-engineer.
 */

function b64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(text: string): Buffer {
  return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

/** Vendor-side only (tools/keygen.ts). This is NEVER called by the shipped app. */
export function signLicense(payload: LicensePayload, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem)
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const signature = sign(null, body, key) // null algorithm: Ed25519 hashes internally
  return `${b64url(body)}.${b64url(signature)}`
}

export type VerifyResult =
  | { ok: true; payload: LicensePayload }
  | { ok: false; reason: string }

/**
 * Verify a key against the embedded public key. Pure — no clock, no machine, no database.
 * Expiry and machine binding are checked by the licence SERVICE, so that this stays testable
 * and each rejection reason stays distinct.
 */
export function verifyLicenseKey(keyText: string, publicKeyPem: string): VerifyResult {
  const trimmed = keyText.trim().replace(/\s+/g, '')
  const parts = trimmed.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: 'That does not look like a licence key.' }
  }

  let body: Buffer
  let signature: Buffer
  try {
    body = fromB64url(parts[0])
    signature = fromB64url(parts[1])
  } catch {
    return { ok: false, reason: 'That licence key is damaged.' }
  }

  let signatureOk = false
  try {
    signatureOk = verify(null, body, createPublicKey(publicKeyPem), signature)
  } catch {
    return { ok: false, reason: 'That licence key is damaged.' }
  }

  // The signature is the whole point: it proves WE issued this exact payload. Change one character
  // of the licensee name or the expiry date and this fails.
  if (!signatureOk) {
    return { ok: false, reason: 'This licence key is not valid.' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return { ok: false, reason: 'That licence key is damaged.' }
  }

  const payload = parsed as LicensePayload
  if (
    typeof payload?.licensee !== 'string' ||
    typeof payload?.machineId !== 'string' ||
    typeof payload?.issuedAt !== 'string' ||
    !LICENSE_PLANS.includes(payload?.plan) ||
    (payload?.expiresAt !== null && typeof payload?.expiresAt !== 'string')
  ) {
    return { ok: false, reason: 'That licence key is damaged.' }
  }

  return { ok: true, payload: { ...payload, features: payload.features ?? {} } }
}
