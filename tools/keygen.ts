/**
 * VENDOR KEY GENERATOR. Mints a licence key for one customer, on one machine.
 *
 *   npx tsx tools/keygen.ts --licensee "Insha Store" --machine-id A1B2-C3D4-E5F6-7890 --plan annual
 *   npx tsx tools/keygen.ts --licensee "Test Shop"   --machine-id ... --plan trial --days 14
 *   npx tsx tools/keygen.ts --licensee "Big Shop"    --machine-id ... --plan lifetime
 *
 * The customer reads the Machine ID off their Activation screen and sends it to you. Paste the key
 * this prints back to them; they enter it and they are running. No internet, either side.
 *
 * `tools/` is maintainer-only and is NOT shipped in the installer.
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { signLicense } from '../src/main/security/license-key'
import type { LicensePayload, LicensePlan } from '../src/shared/types'

const PRIVATE_PATH =
  process.env['INSHA_LICENSE_KEY_PATH'] ?? join(homedir(), '.insha-pos-keys', 'license-private.pem')

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const licensee = arg('licensee')
const machineId = arg('machine-id')
const plan = (arg('plan') ?? 'annual') as LicensePlan
const days = arg('days') ? Number(arg('days')) : undefined

if (!licensee || !machineId) {
  console.error(`
  Usage:
    npx tsx tools/keygen.ts --licensee "<shop name>" --machine-id <ID> [--plan annual|trial|lifetime] [--days N]

    --plan annual    (default)  expires 1 year from today
    --plan trial     --days 14  expires in N days, full features, shows a TRIAL banner
    --plan lifetime             never expires
`)
  process.exit(1)
}

if (!existsSync(PRIVATE_PATH)) {
  console.error(`\n  No private key at ${PRIVATE_PATH}\n  Run: npx tsx tools/make-keypair.ts\n`)
  process.exit(1)
}

const now = new Date()

function addDays(from: Date, count: number): Date {
  const result = new Date(from)
  result.setDate(result.getDate() + count)
  return result
}

let expiresAt: string | null
switch (plan) {
  case 'lifetime':
    expiresAt = null
    break
  case 'trial':
    expiresAt = addDays(now, days ?? 14).toISOString()
    break
  case 'annual':
    expiresAt = addDays(now, days ?? 365).toISOString()
    break
  default:
    console.error(`  Unknown plan "${plan}". Use annual, trial, or lifetime.`)
    process.exit(1)
}

const payload: LicensePayload = {
  licensee,
  machineId: machineId.trim().toUpperCase(),
  plan,
  issuedAt: now.toISOString(),
  expiresAt,
  features: {}
}

const key = signLicense(payload, readFileSync(PRIVATE_PATH, 'utf8'))

console.log(`
  Licensee   : ${payload.licensee}
  Machine ID : ${payload.machineId}
  Plan       : ${payload.plan}
  Expires    : ${payload.expiresAt ? new Date(payload.expiresAt).toDateString() : 'never (lifetime)'}

  ── Send the customer this key ──────────────────────────────────────────────

${key}

  ────────────────────────────────────────────────────────────────────────────
`)
