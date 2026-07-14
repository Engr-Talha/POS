import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { join } from 'node:path'
import { makeTestDb, expectUserMessage, type TestDb } from '../db/testkit'
import { signLicense } from '../security/license-key'
import { checkAndRecordClock } from '../security/clock-guard'
import * as license from './license'
import type { LicensePayload, LicensePlan } from '@shared/types'
import * as audit from './audit'

// A throwaway vendor keypair, so the tests never touch the real private key (which is not in the
// repo and must never be — CI would not have it anyway).
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const MACHINE = 'A1B2-C3D4-E5F6-7890'
const OTHER_MACHINE = '9999-8888-7777-6666'

function makeKey(overrides: Partial<LicensePayload> = {}): string {
  const payload: LicensePayload = {
    licensee: 'Insha Store',
    machineId: MACHINE,
    plan: 'annual' as LicensePlan,
    issuedAt: new Date('2026-01-01').toISOString(),
    expiresAt: new Date('2027-01-01').toISOString(),
    features: {},
    ...overrides
  }
  return signLicense(payload, PRIVATE_PEM)
}

const opts = { publicKey: PUBLIC_PEM }

describe('license', () => {
  let t: TestDb
  beforeEach(() => (t = makeTestDb()))
  afterEach(() => t.cleanup())

  it('a valid key activates', () => {
    const payload = license.activate(t.db, makeKey(), MACHINE, {
      ...opts,
      now: new Date('2026-06-01')
    })
    expect(payload.licensee).toBe('Insha Store')

    const state = license.getLicenseState(t.db, MACHINE, { ...opts, now: new Date('2026-06-01') })
    expect(state.status).toBe('active')
    expect(license.canWrite(state)).toBe(true)
  })

  it('REJECTS a tampered key', () => {
    // Take a real key and edit the payload — e.g. push the expiry out by a decade. The signature no
    // longer matches, and that is the entire point of signing it.
    const key = makeKey()
    const [body, signature] = key.split('.')
    const decoded = JSON.parse(
      Buffer.from(body as string, 'base64url').toString('utf8')
    ) as LicensePayload
    decoded.expiresAt = new Date('2099-01-01').toISOString()
    const forged = `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`

    expectUserMessage(() => license.activate(t.db, forged, MACHINE, opts), /not valid/i)
  })

  it('REJECTS a key issued for another machine', () => {
    const key = makeKey({ machineId: OTHER_MACHINE })
    expectUserMessage(() => license.activate(t.db, key, MACHINE, opts), /different computer/i)
  })

  it('REJECTS an already-expired key at activation, with a clear reason', () => {
    const key = makeKey({ expiresAt: new Date('2026-02-01').toISOString() })
    expectUserMessage(
      () => license.activate(t.db, key, MACHINE, { ...opts, now: new Date('2026-06-01') }),
      /already expired/i
    )
  })

  it('an EXPIRED licence goes READ-ONLY — and the data is still readable and exportable', () => {
    // Activate while valid...
    license.activate(t.db, makeKey(), MACHINE, { ...opts, now: new Date('2026-06-01') })

    // ...then time passes and it lapses.
    const state = license.getLicenseState(t.db, MACHINE, { ...opts, now: new Date('2027-06-01') })
    expect(state.status).toBe('expired')

    // WRITES are refused — but with a sentence a shopkeeper can act on, not a stack trace.
    expect(license.canWrite(state)).toBe(false)
    expectUserMessage(() => license.assertCanWrite(state), /licence has expired/i)
    expectUserMessage(() => license.assertCanWrite(state), /still view and export/i)

    // THE POINT: their data is NOT hostage. Reads still work.
    const rows = t.db.prepare('SELECT COUNT(*) FROM license').pluck().get()
    expect(rows).toBe(1)
    expect(() => audit.list(t.db)).not.toThrow()
  })

  it('a LIFETIME licence never expires', () => {
    license.activate(t.db, makeKey({ plan: 'lifetime', expiresAt: null }), MACHINE, opts)
    const state = license.getLicenseState(t.db, MACHINE, { ...opts, now: new Date('2099-01-01') })
    expect(state.status).toBe('active')
    expect(state).toMatchObject({ daysRemaining: null })
  })

  it('a TRIAL licence reports the days remaining, for the banner', () => {
    const key = makeKey({ plan: 'trial', expiresAt: new Date('2026-06-15').toISOString() })
    license.activate(t.db, key, MACHINE, { ...opts, now: new Date('2026-06-01') })

    const state = license.getLicenseState(t.db, MACHINE, { ...opts, now: new Date('2026-06-01') })
    expect(state).toMatchObject({ status: 'active', plan: 'trial', daysRemaining: 14 })
  })

  it('DETECTS a clock rollback and demands re-activation', () => {
    const mirror = join(t.dir, 'clock.txt')

    // The app has seen 1 June 2026.
    expect(checkAndRecordClock(t.db, mirror, new Date('2026-06-01')).ok).toBe(true)

    // Someone winds the clock back a year to dodge the expiry date.
    const rolled = checkAndRecordClock(t.db, mirror, new Date('2025-06-01'))
    expect(rolled.ok).toBe(false)

    const state = license.getLicenseState(t.db, MACHINE, { ...opts, clockTampered: true })
    expect(state.status).toBe('invalid')
    expect(license.canWrite(state)).toBe(false)
  })

  it('does NOT cry tamper over a small, innocent clock correction', () => {
    // NTP nudges, timezones get fixed, CMOS batteries die. Locking a shop's till because their
    // motherboard battery is flat would be far worse than letting one thief have a free month.
    const mirror = join(t.dir, 'clock.txt')
    checkAndRecordClock(t.db, mirror, new Date('2026-06-01T12:00:00Z'))

    const smallJumpBack = checkAndRecordClock(t.db, mirror, new Date('2026-06-01T09:00:00Z'))
    expect(smallJumpBack.ok).toBe(true)
  })

  it('the clock watermark only moves FORWARD, so deleting the DB row does not reset it', () => {
    const mirror = join(t.dir, 'clock.txt')
    checkAndRecordClock(t.db, mirror, new Date('2026-06-01'))

    // Attacker wipes the guard row in the database, hoping the app forgets.
    t.db.prepare('DELETE FROM clock_guard').run()

    // The file mirror still remembers — so the rollback is still caught.
    const rolled = checkAndRecordClock(t.db, mirror, new Date('2025-01-01'))
    expect(rolled.ok).toBe(false)
  })

  it('an unactivated app reports its machine id so the customer can send it to us', () => {
    const state = license.getLicenseState(t.db, MACHINE, opts)
    expect(state).toEqual({ status: 'none', machineId: MACHINE })
    expectUserMessage(() => license.assertCanWrite(state), /not activated/i)
  })
})
